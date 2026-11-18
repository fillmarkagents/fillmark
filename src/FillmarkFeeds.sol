// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAggregatorV3, IStockToken} from "./interfaces/External.sol";

/// Token -> Chainlink USD feed, the US equity session calendar for stock tokens, and
/// halts for crypto tokens, which otherwise trade at any hour.
/// Add-only: nothing can be changed or removed once added. The admin is meant
/// to be a timelock. The guardian can only add closures and crypto halts that start
/// within the hour, at most 3 days of them together per fixed 30-day window (up to
/// 6 days in a row across two windows), so an unscheduled stop takes effect at once
/// instead of after the timelock delay.
contract FillmarkFeeds {
    enum Session {
        Closed,
        Extended,
        Regular
    }

    /// Times are seconds in UTC. regOpen/regClose are seconds of the day for the
    /// regular session (Mon-Fri). weekOpen/weekClose are seconds since Sunday
    /// 00:00 UTC for the 24/5 week; outside it the market is closed.
    struct Period {
        uint64 start;
        uint32 regOpen;
        uint32 regClose;
        uint32 weekOpen;
        uint32 weekClose;
    }

    struct Asset {
        address feed;
        uint32 maxAge; // oldest feed answer a fill may use, seconds
        bool crypto;
        bool multiplierInFeed; // stock feed answers price x uiMultiplier (Robinhood feeds)
        uint8 decimals; // token decimals, read once when the token is added
        string ticker;
    }

    /// Everything the router needs to price a fill.
    struct Source {
        address feed;
        uint32 maxAge;
        bool crypto;
        bool multiplierInFeed;
        uint8 decimals;
        Session session;
    }

    /// A stop [start, end): a market closure for stocks (a holiday or the hours after
    /// an early close) or a halt for crypto.
    struct Closure {
        uint64 start;
        uint64 end;
    }

    uint64 public constant GUARDIAN_LEAD = 1 hours;
    uint64 public constant GUARDIAN_WINDOW = 30 days;
    uint64 public constant GUARDIAN_BUDGET = 3 days;
    /// Max age is set per token: a few hours for a feed that updates through the day,
    /// the heartbeat plus a margin for one that only updates on its heartbeat.
    uint32 public constant MIN_MAX_AGE = 1 hours;
    uint32 public constant MAX_AGE_LIMIT = 25 hours;
    /// Feeds are USD with 8 decimals; tokens may have 0 to 18 decimals.
    uint8 public constant FEED_DECIMALS = 8;
    uint8 public constant MAX_TOKEN_DECIMALS = 18;

    address public immutable admin;
    address public immutable guardian;
    mapping(address => Asset) private _assets;
    Period[] private _periods;
    Closure[] private _closures; // stocks; sorted, not overlapping
    Closure[] private _halts; // crypto; sorted, not overlapping
    uint64 public guardianWindowStart;
    uint64 public guardianUsed; // stopped time added by the guardian in the current window

    event StockAdded(
        address indexed token, address indexed feed, string ticker, uint8 decimals, uint32 maxAge, bool multiplierInFeed
    );
    event CryptoAdded(address indexed token, address indexed feed, string ticker, uint8 decimals, uint32 maxAge);
    event PeriodAdded(uint64 start, uint32 regOpen, uint32 regClose, uint32 weekOpen, uint32 weekClose);
    event ClosureAdded(uint64 start, uint64 end);
    event CryptoHaltAdded(uint64 start, uint64 end);

    error NotAdmin();
    error AlreadySet();
    error BadInput();
    error GuardianLimit();

    constructor(address admin_, address guardian_) {
        if (admin_ == address(0) || guardian_ == address(0)) revert BadInput();
        admin = admin_;
        guardian = guardian_;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// A stock token must answer oraclePaused(), effectiveAt() and uiMultiplier(); the
    /// router checks them on every fill. multiplierInFeed is false for a feed that
    /// prices the underlying alone: that token then only trades at a multiplier of 1.
    function addStock(address token, address feed, uint32 maxAge, bool multiplierInFeed) external onlyAdmin {
        if (
            !_answers(token, IStockToken.oraclePaused.selector) || !_answers(token, IStockToken.effectiveAt.selector)
                || !_answers(token, IStockToken.uiMultiplier.selector)
        ) revert BadInput();
        (string memory ticker, uint8 decimals) = _add(token, feed, maxAge, false, multiplierInFeed);
        emit StockAdded(token, feed, ticker, decimals, maxAge, multiplierInFeed);
    }

    /// A crypto token must not look like a stock token, so it can never skip the
    /// stock checks by being added as crypto.
    function addCrypto(address token, address feed, uint32 maxAge) external onlyAdmin {
        if (_answers(token, IStockToken.oraclePaused.selector)) revert BadInput();
        (string memory ticker, uint8 decimals) = _add(token, feed, maxAge, true, false);
        emit CryptoAdded(token, feed, ticker, decimals, maxAge);
    }

    function _add(address token, address feed, uint32 maxAge, bool crypto, bool multiplierInFeed)
        private
        returns (string memory ticker, uint8 decimals)
    {
        if (token == address(0) || feed == address(0)) revert BadInput();
        if (maxAge < MIN_MAX_AGE || maxAge > MAX_AGE_LIMIT) revert BadInput();
        if (_assets[token].feed != address(0)) revert AlreadySet();
        if (IAggregatorV3(feed).decimals() != FEED_DECIMALS) revert BadInput();
        decimals = IERC20Metadata(token).decimals();
        if (decimals > MAX_TOKEN_DECIMALS) revert BadInput();
        ticker = IERC20Metadata(token).symbol();
        _assets[token] = Asset(feed, maxAge, crypto, multiplierInFeed, decimals, ticker);
    }

    function _answers(address token, bytes4 selector) private view returns (bool) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(selector));
        return ok && ret.length == 32;
    }

    /// Periods must start in the future and in order, so past fills never change class.
    function addPeriod(Period calldata p) external onlyAdmin {
        uint256 n = _periods.length;
        if (p.start < block.timestamp || (n > 0 && p.start <= _periods[n - 1].start)) revert BadInput();
        if (p.regOpen >= p.regClose || p.regClose > 1 days) revert BadInput();
        if (p.weekOpen >= p.weekClose || p.weekClose > 7 days) revert BadInput();
        _periods.push(p);
        emit PeriodAdded(p.start, p.regOpen, p.regClose, p.weekOpen, p.weekClose);
    }

    /// Stock market closures. They must start now or later and must not overlap
    /// another one. They are kept sorted, so an unscheduled closure can still go in
    /// before later ones.
    function addClosure(uint64 start, uint64 end) external {
        _addStop(_closures, start, end);
        emit ClosureAdded(start, end);
    }

    /// Crypto halts, for an oracle or market failure; same rules as closures.
    function addCryptoHalt(uint64 start, uint64 end) external {
        _addStop(_halts, start, end);
        emit CryptoHaltAdded(start, end);
    }

    function _addStop(Closure[] storage list, uint64 start, uint64 end) private {
        if (start < block.timestamp || end <= start) revert BadInput();
        if (msg.sender != admin) {
            if (msg.sender != guardian) revert NotAdmin();
            if (start > block.timestamp + GUARDIAN_LEAD) revert GuardianLimit();
            if (block.timestamp >= guardianWindowStart + GUARDIAN_WINDOW) {
                // forge-lint: disable-next-line(unsafe-typecast)
                guardianWindowStart = uint64(block.timestamp); // fits until year 5e11
                guardianUsed = 0;
            }
            guardianUsed += end - start;
            if (guardianUsed > GUARDIAN_BUDGET) revert GuardianLimit();
        }
        uint256 i = list.length;
        list.push(Closure(start, end));
        while (i > 0 && list[i - 1].start > start) {
            list[i] = list[i - 1];
            i--;
        }
        list[i] = Closure(start, end);
        if ((i > 0 && list[i - 1].end > start) || (i + 1 < list.length && end > list[i + 1].start)) {
            revert BadInput();
        }
    }

    function feedOf(address token) external view returns (address) {
        return _assets[token].feed;
    }

    function tickerOf(address token) external view returns (string memory) {
        return _assets[token].ticker;
    }

    function isCrypto(address token) external view returns (bool) {
        return _assets[token].crypto;
    }

    function decimalsOf(address token) external view returns (uint8) {
        return _assets[token].decimals;
    }

    /// Everything the router needs to price a fill of `token` at time t.
    function sourceOf(address token, uint256 t) external view returns (Source memory) {
        Asset storage a = _assets[token];
        return Source(a.feed, a.maxAge, a.crypto, a.multiplierInFeed, a.decimals, sessionOf(token, t));
    }

    /// The session a fill of `token` at time t belongs to: crypto is Regular unless
    /// halted; stocks follow the calendar.
    function sessionOf(address token, uint256 t) public view returns (Session) {
        if (!_assets[token].crypto) return sessionAt(t);
        return _stopped(_halts, t) ? Session.Closed : Session.Regular;
    }

    function periodCount() external view returns (uint256) {
        return _periods.length;
    }

    function period(uint256 i) external view returns (Period memory) {
        return _periods[i];
    }

    function closureCount() external view returns (uint256) {
        return _closures.length;
    }

    function closure(uint256 i) external view returns (Closure memory) {
        return _closures[i];
    }

    function haltCount() external view returns (uint256) {
        return _halts.length;
    }

    function halt(uint256 i) external view returns (Closure memory) {
        return _halts[i];
    }

    /// The US equity session at time t.
    function sessionAt(uint256 t) public view returns (Session) {
        uint256 i = _periods.length;
        while (i > 0 && _periods[i - 1].start > t) i--;
        if (i == 0) return Session.Closed;
        Period memory p = _periods[i - 1];
        if (_stopped(_closures, t)) return Session.Closed;

        uint256 day = t / 1 days;
        uint256 sod = t % 1 days;
        uint256 dow = (day + 4) % 7; // 0 = Sunday; 1 Jan 1970 was a Thursday
        uint256 sow = dow * 1 days + sod;
        if (sow < p.weekOpen || sow >= p.weekClose) return Session.Closed;
        if (dow >= 1 && dow <= 5 && sod >= p.regOpen && sod < p.regClose) return Session.Regular;
        return Session.Extended;
    }

    /// Whether t falls in a stop of a sorted, non-overlapping list (binary search for
    /// the first stop starting after t).
    function _stopped(Closure[] storage list, uint256 t) private view returns (bool) {
        uint256 lo = 0;
        uint256 hi = list.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (list[mid].start > t) hi = mid;
            else lo = mid + 1;
        }
        return lo > 0 && t < list[lo - 1].end;
    }
}
