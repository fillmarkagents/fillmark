// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {FillmarkFeeds} from "./FillmarkFeeds.sol";
import {
    IAggregatorV3,
    IERC7579Account,
    IIdentityRegistry,
    IReputationRegistry,
    IStockToken,
    IUniswapV3Factory,
    IUniswapV3Pool
} from "./interfaces/External.sol";
import {IERC7579Modules} from "./interfaces/ExternalV2.sol";
import {IUniswapV3PoolState} from "./interfaces/ExternalV3.sol";

/// Fillmark router v3. Changes from v2:
/// - one official USDG pool per token, and the router bounds every swap's price itself:
///   after the swap the pool price (pool fee included) is within C of Chainlink NAV and
///   the pool tick within min(C, twapCap) of the pool's TWAP, so an agent cannot push a thin
///   pool for its own gain; C = min(client limit - fill fee, pool cap);
/// - only the agent wallet pinned at install may send a fill (no signatures);
/// - an optional "regular hours only" install flag;
/// - buys count in a rolling 24-hour window, fill fee included; sales do not, and an agent
///   sells only units it bought;
/// - the performance fee on a sale's gain is held in escrow here while the gain waits, so it
///   is always paid; a rebuy returns its share, settle and closeOut release it by rule;
/// - feedback the registry refuses is counted and logged instead of blocking the fill;
/// - sales stay open SELL_GRACE after the permission expires.
/// The router holds no client tokens; it holds only escrowed fees and unclaimed payouts.
contract FillmarkRouterV3 {
    using SafeERC20 for IERC20;

    uint256 private constant MODULE_TYPE_EXECUTOR = 2;
    uint16 public constant MAX_SLIP_LIMIT_BPS = 1_000;
    uint16 public constant MAX_FILL_FEE_BPS = 10;
    uint16 public constant MAX_PERF_FEE_BPS = 3_000;
    uint16 public constant MAX_POOL_CAP_BPS = 100;
    uint64 public constant MIN_HOLD = 1 hours;
    uint64 public constant MAX_HOLD = 30 days;
    uint32 public constant MIN_TWAP_WINDOW = 30;
    uint32 public constant MAX_TWAP_WINDOW = 600;
    uint16 public constant MIN_CARDINALITY = 100;
    uint64 public constant SELL_GRACE = 7 days;
    uint256 public constant WINDOW_HOURS = 25; // hour buckets; the window covers 24 full hours and the current one
    uint256 public constant DUST_LOSS = 1e4; // 0.01 USDG of open loss is ignored by settle
    uint256 public constant PAY_GAS = 150_000;
    uint256 public constant FEEDBACK_GAS = 400_000;
    uint256 public constant STUCK_AFTER = 30 days;
    uint256 public constant MIN_NOTIONAL = 10e6;
    uint8 public constant VALUE_DECIMALS = 6;
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    struct FillIntent {
        uint256 agentId;
        address account;
        uint64 installId;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        uint160 sqrtPriceLimitX96; // 0 = none; the router's own bounds always apply
        uint256 nonce;
        uint64 deadline;
    }

    struct Config {
        uint256 agentId;
        address wallet;
        uint16 maxSlipBps;
        uint16 perfFeeBps;
        uint64 expiry;
        uint64 installId;
        bool installed;
        bool regularOnly;
        uint128 maxPerTrade;
        uint128 dailyLimit;
    }

    struct PoolCfg {
        address pool;
        uint24 fee;
        uint16 capBps; // NAV bound of the pool, at most MAX_POOL_CAP_BPS
        uint16 twapCapBps; // TWAP bound of the pool, at most MAX_POOL_CAP_BPS
        bool active;
    }

    struct InitialPool {
        address token;
        address pool;
        uint16 capBps;
        uint16 twapCapBps;
    }

    struct Fill {
        uint256 agentId;
        address account;
        address stock;
        bool buy;
        uint256 usdgAmount;
        uint256 stockAmount;
        uint256 fillFee;
        uint8 stockDecimals;
        uint160 sqrtPriceX96; // pool price before the swap
        uint160 sqrtPriceAfter; // pool price after the swap
        int24 twapTick;
        uint80 roundId;
        int256 answer;
        uint256 updatedAt;
        FillmarkFeeds.Session session;
    }

    struct Prices {
        uint256 nav;
        uint256 spot;
        uint256 fill;
        int256 shortfall;
        int256 premium;
        int256 impact;
        int256 cost;
    }

    struct Stats {
        uint32 fills;
        uint32 feedbackFails;
        uint128 notional;
        int64 worst;
        int128 sumCost;
    }

    struct Book {
        int128 realized;
        int128 peak;
        uint128 debt;
        uint128 paid;
        uint128 escMatured; // escrow of gains that matured and are not charged yet
        uint128 outLoss; // losses booked on units moved out that may still come back
        address wallet;
        uint16 perfFeeBps;
        bool closing;
        uint64 closingAt;
    }

    struct Lot {
        uint128 qty;
        uint128 cost;
    }

    /// A sale's gain waiting `hold`, with the performance fee on it held in escrow.
    struct Hold {
        uint128 gain;
        uint128 qty;
        uint64 until;
        uint128 esc;
    }

    struct Out {
        uint128 qty;
        uint128 gain;
        uint128 loss;
        uint64 until;
    }

    struct Bucket {
        uint64 hour;
        uint128 amount;
    }

    IIdentityRegistry public immutable identity;
    IReputationRegistry public immutable reputation;
    IUniswapV3Factory public immutable factory;
    address public immutable usdg;
    FillmarkFeeds public immutable feeds;
    address public immutable burner;
    address public immutable admin; // the timelock
    address public immutable guardian; // may only switch a pool off
    uint64 public immutable hold;
    uint32 public immutable twapWindow;
    uint16 public fillFeeBps;

    mapping(address => Config) public configs;
    mapping(address => mapping(uint64 => mapping(address => bool))) private _allowed;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    mapping(bytes32 => Stats) public stats;
    mapping(address => PoolCfg) private _pools;
    mapping(address => Bucket[WINDOW_HOURS]) private _buckets;
    mapping(address => uint256) public claimable;

    mapping(bytes32 => Book) private _books;
    mapping(bytes32 => mapping(address => Lot)) private _lots;
    mapping(bytes32 => mapping(address => Hold)) private _holds;
    mapping(bytes32 => mapping(address => Hold)) private _laterHolds;
    mapping(bytes32 => mapping(address => Out)) private _outs;
    mapping(bytes32 => address[]) private _tokens;
    mapping(bytes32 => mapping(address => bool)) private _listed;
    mapping(address => uint256) public openBook;

    address private transient _pool;
    address private transient _account;
    address private transient _tokenIn;
    uint256 private transient _amountIn;
    bool private transient _locked;

    event Installed(
        address indexed account,
        uint256 indexed agentId,
        address wallet,
        uint64 installId,
        uint16 maxSlipBps,
        uint16 perfFeeBps,
        uint128 maxPerTrade,
        uint128 dailyLimit,
        uint64 expiry,
        bool regularOnly
    );
    event Uninstalled(address indexed account);
    event Filled(
        address indexed account,
        uint256 indexed agentId,
        address indexed stock,
        address pool,
        bytes32 fillId,
        Fill fill,
        Prices prices
    );
    event Booked(address indexed account, uint256 indexed agentId, address indexed stock, int256 pnl);
    event MovedOut(address indexed account, uint256 indexed agentId, address indexed stock, uint256 qty, int256 pnl);
    event MovedBack(address indexed account, uint256 indexed agentId, address indexed stock, uint256 qty);
    event Escrowed(address indexed account, uint256 indexed agentId, address indexed stock, uint256 amount);
    event EscrowReturned(address indexed account, uint256 indexed agentId, uint256 amount);
    event Settled(
        address indexed account,
        uint256 indexed agentId,
        int256 realized,
        uint256 openLoss,
        int256 peak,
        uint256 fee,
        uint256 paid,
        uint256 debt
    );
    event ClosedOut(address indexed account, uint256 indexed agentId, int256 base, uint256 fee, uint256 debt);
    event DebtPaid(address indexed account, uint256 indexed agentId, uint256 amount, uint256 debt);
    event Credited(address indexed to, uint256 amount);
    event Claimed(address indexed to, uint256 amount);
    event FeedbackFailed(address indexed account, uint256 indexed agentId, bytes32 indexed fillId, string tag);
    event FillFeeSet(uint16 bps);
    event PoolSet(address indexed token, address pool, uint24 fee, uint16 capBps, uint16 twapCapBps);
    event PoolOff(address indexed token);

    error AlreadyInstalled();
    error NotInstalled();
    error BadConfig();
    error UnknownStock();
    error WrongAgent();
    error WrongInstall();
    error Expired();
    error NonceUsed();
    error WalletChanged();
    error NotAgentWallet();
    error BadPair();
    error StockNotAllowed();
    error NoPool();
    error NoTwap();
    error PriceOutOfRange();
    error MarketClosed();
    error RegularHoursOnly();
    error BadFeed();
    error DecimalsChanged();
    error StaleFeed();
    error MultiplierNotPriced();
    error OraclePaused();
    error TooSmall();
    error Reentered();
    error BadCallback();
    error PartialFill();
    error TooLittleOut();
    error WorseThanNav();
    error OverTradeLimit();
    error OverDailyLimit();
    error NotAgentUnits();
    error PaymentFailed();
    error InDebt();
    error CloseOutPending();
    error NotClosing();
    error NotAdmin();
    error BadAmount();
    error LowGas();

    struct Setup {
        IIdentityRegistry identity;
        IReputationRegistry reputation;
        IUniswapV3Factory factory;
        address usdg;
        FillmarkFeeds feeds;
        address burner;
        address admin;
        address guardian;
        uint16 fillFeeBps;
        uint64 hold;
        uint32 twapWindow;
    }

    constructor(Setup memory s, InitialPool[] memory pools_) {
        if (
            address(s.identity) == address(0) || address(s.reputation) == address(0) || address(s.factory) == address(0)
                || s.usdg == address(0) || address(s.feeds) == address(0) || s.burner == address(0)
                || s.admin == address(0) || s.guardian == address(0) || s.fillFeeBps > MAX_FILL_FEE_BPS
                || s.hold < MIN_HOLD || s.hold > MAX_HOLD || s.twapWindow < MIN_TWAP_WINDOW
                || s.twapWindow > MAX_TWAP_WINDOW
        ) revert BadConfig();
        if (IERC20Metadata(s.usdg).decimals() != 6) revert BadConfig();
        identity = s.identity;
        reputation = s.reputation;
        factory = s.factory;
        usdg = s.usdg;
        feeds = s.feeds;
        burner = s.burner;
        admin = s.admin;
        guardian = s.guardian;
        fillFeeBps = s.fillFeeBps;
        hold = s.hold;
        twapWindow = s.twapWindow;
        // The initial pools are set here, so the router trades from its first block without
        // waiting for the timelock.
        for (uint256 i; i < pools_.length; i++) {
            _setPool(pools_[i].token, pools_[i].pool, pools_[i].capBps, pools_[i].twapCapBps);
        }
    }

    // ---- admin ----

    function setFillFeeBps(uint16 bps) external {
        if (msg.sender != admin) revert NotAdmin();
        if (bps > MAX_FILL_FEE_BPS) revert BadConfig();
        fillFeeBps = bps;
        emit FillFeeSet(bps);
    }

    /// Sets or replaces a token's official pool and its bounds (timelock only).
    function setPool(address token, address pool, uint16 capBps, uint16 twapCapBps) external {
        if (msg.sender != admin) revert NotAdmin();
        _setPool(token, pool, capBps, twapCapBps);
    }

    /// Switches a token's pool off at once (guardian or timelock); only setPool switches it on.
    function poolOff(address token) external {
        if (msg.sender != guardian && msg.sender != admin) revert NotAdmin();
        _pools[token].active = false;
        emit PoolOff(token);
    }

    // Also called per initial pool by the constructor; one bad pool stops the deploy.
    // forge-lint: disable-start(calls-loop, require-revert-in-loop)
    function _setPool(address token, address pool, uint16 capBps, uint16 twapCapBps) private {
        if (feeds.feedOf(token) == address(0)) revert UnknownStock();
        if (capBps == 0 || capBps > MAX_POOL_CAP_BPS || twapCapBps == 0 || twapCapBps > MAX_POOL_CAP_BPS) {
            revert BadConfig();
        }
        uint24 fee = IUniswapV3PoolState(pool).fee();
        if (factory.getPool(token, usdg, fee) != pool) revert NoPool();
        // forge-lint: disable-next-line(unused-return)
        (,,, uint16 cardinality,,,) = IUniswapV3Pool(pool).slot0();
        if (cardinality < minCardinality()) revert NoTwap();
        _pools[token] = PoolCfg(pool, fee, capBps, twapCapBps, true);
        emit PoolSet(token, pool, fee, capBps, twapCapBps);
    }
    // forge-lint: disable-end(calls-loop, require-revert-in-loop)

    // ---- ERC-7579 module ----

    struct Install {
        uint256 agentId;
        uint128 maxPerTrade;
        uint128 dailyLimit;
        uint64 expiry;
        uint16 maxSlipBps;
        uint16 perfFeeBps;
        bool regularOnly;
        address[] stocks;
    }

    /// data = abi.encode(agentId, maxPerTrade, dailyLimit, expiry, maxSlipBps, perfFeeBps, regularOnly, stocks)
    function onInstall(bytes calldata data) external payable {
        Config storage c = configs[msg.sender];
        if (c.installed) revert AlreadyInstalled();
        Install memory n = _decodeInstall(data);
        if (n.maxSlipBps == 0 || n.maxSlipBps > MAX_SLIP_LIMIT_BPS || n.expiry <= block.timestamp) revert BadConfig();
        if (n.perfFeeBps > MAX_PERF_FEE_BPS) revert BadConfig();
        address wallet = identity.getAgentWallet(n.agentId);
        if (wallet == address(0)) revert BadConfig();

        uint256 open = openBook[msg.sender];
        if (open != 0) {
            // A call to this router, lock-guarded, whose payments never revert.
            // forge-lint: disable-next-line(reentrancy-no-eth)
            try this.closeOut(msg.sender, open - 1) {}
            catch {
                revert CloseOutPending();
            }
        }
        Book storage b = _books[keyOf(msg.sender, n.agentId)];
        if (b.debt != 0) revert InDebt();
        b.wallet = wallet;
        b.perfFeeBps = n.perfFeeBps;
        b.closing = false;
        b.closingAt = 0;
        openBook[msg.sender] = n.agentId + 1;

        uint64 id = c.installId + 1;
        configs[msg.sender] = Config({
            agentId: n.agentId,
            wallet: wallet,
            maxSlipBps: n.maxSlipBps,
            perfFeeBps: n.perfFeeBps,
            expiry: n.expiry,
            installId: id,
            installed: true,
            regularOnly: n.regularOnly,
            maxPerTrade: n.maxPerTrade,
            dailyLimit: n.dailyLimit
        });
        for (uint256 i; i < n.stocks.length; i++) {
            // forge-lint: disable-next-line(calls-loop, require-revert-in-loop)
            if (feeds.feedOf(n.stocks[i]) == address(0)) revert UnknownStock();
            _allowed[msg.sender][id][n.stocks[i]] = true;
        }
        _emitInstalled(n, wallet, id);
    }

    /// The same fields as router v2's Installed event, plus regularOnly, for indexers.
    function _emitInstalled(Install memory n, address wallet, uint64 id) private {
        // After onInstall's own calls (the registry read, a close-out of this router).
        // forge-lint: disable-start(reentrancy-events)
        emit Installed(
            msg.sender,
            n.agentId,
            wallet,
            id,
            n.maxSlipBps,
            n.perfFeeBps,
            n.maxPerTrade,
            n.dailyLimit,
            n.expiry,
            n.regularOnly
        );
        // forge-lint: disable-end(reentrancy-events)
    }

    function _decodeInstall(bytes calldata data) private pure returns (Install memory n) {
        (n.agentId, n.maxPerTrade, n.dailyLimit, n.expiry, n.maxSlipBps, n.perfFeeBps, n.regularOnly, n.stocks) =
            abi.decode(data, (uint256, uint128, uint128, uint64, uint16, uint16, bool, address[]));
    }

    function onUninstall(bytes calldata) external payable {
        Config storage c = configs[msg.sender];
        if (!c.installed) revert NotInstalled();
        uint256 agentId = c.agentId;
        _markClosing(msg.sender, c);
        try this.closeOut(msg.sender, agentId) {} catch {}
    }

    function _markClosing(address account, Config storage c) private {
        uint64 id = c.installId;
        Book storage b = _books[keyOf(account, c.agentId)];
        b.closing = true;
        b.closingAt = SafeCast.toUint64(block.timestamp);
        delete configs[account];
        configs[account].installId = id;
        emit Uninstalled(account);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    function isInitialized(address account) external view returns (bool) {
        return configs[account].installed;
    }

    function isAllowed(address account, address stock) external view returns (bool) {
        Config storage c = configs[account];
        return c.installed && _allowed[account][c.installId][stock];
    }

    // ---- execution ----

    /// Sent by the agent wallet pinned at install.
    function execute(FillIntent calldata it) external returns (uint256 amountOut) {
        if (_locked) revert Reentered();
        _locked = true;

        Config storage c = configs[it.account];
        _checkIntent(c, it);
        (Fill memory d, PoolCfg memory pc) = _prepare(c, it);
        bytes32 key = keyOf(it.account, it.agentId);
        if (d.buy && _books[key].debt != 0) revert InDebt();

        uint256 balBefore =
            _syncToken(key, it.account, it.agentId, d.stock, SafeCast.toUint256(d.answer), d.stockDecimals);
        if (!d.buy && it.amountIn > _lots[key][d.stock].qty) revert NotAgentUnits();

        amountOut = _swap(pc.pool, it);
        if (amountOut < it.minOut) revert TooLittleOut();
        d.usdgAmount = d.buy ? it.amountIn : amountOut;
        d.stockAmount = d.buy ? amountOut : it.amountIn;
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (d.buy && IERC20(d.stock).balanceOf(it.account) != balBefore + amountOut) revert PartialFill();
        _checkPath(c, pc, d);
        d.fillFee = d.usdgAmount * fillFeeBps / 1e4;
        _settleFill(c, key, d);

        Prices memory p = pricesOf(d);
        bytes32 fillId = keccak256(abi.encode(block.chainid, address(this), it.account, it.nonce));
        // forge-lint: disable-next-line(reentrancy-events)
        emit Filled(it.account, it.agentId, d.stock, pc.pool, fillId, d, p);
        bytes32 sk = _tally(d, p);
        _publish(d, p, fillId, sk);
        _locked = false;
    }

    function _checkIntent(Config storage c, FillIntent calldata it) private {
        if (!c.installed) revert NotInstalled();
        if (it.installId != c.installId) revert WrongInstall();
        if (it.agentId != c.agentId) revert WrongAgent();
        if (block.timestamp > it.deadline) revert Expired();
        if (msg.sender != c.wallet) revert NotAgentWallet();
        if (nonceUsed[it.account][it.nonce]) revert NonceUsed();
        nonceUsed[it.account][it.nonce] = true;
        // A transfer of the agent NFT clears the wallet; the install no longer trades.
        if (identity.getAgentWallet(it.agentId) != c.wallet) revert WalletChanged();
    }

    function _prepare(Config storage c, FillIntent calldata it)
        private
        view
        returns (Fill memory d, PoolCfg memory pc)
    {
        d.agentId = it.agentId;
        d.account = it.account;
        d.buy = it.tokenIn == usdg;
        if (d.buy == (it.tokenOut == usdg)) revert BadPair();
        d.stock = d.buy ? it.tokenOut : it.tokenIn;
        if (!_allowed[it.account][c.installId][d.stock]) revert StockNotAllowed();
        // Buys stop at expiry; the agent may still sell its units for SELL_GRACE after it.
        if (block.timestamp > uint256(c.expiry) + (d.buy ? 0 : SELL_GRACE)) revert Expired();

        pc = _pools[d.stock];
        if (!pc.active) revert NoPool();
        uint16 cardinality;
        // forge-lint: disable-next-line(unused-return)
        (d.sqrtPriceX96,,, cardinality,,,) = IUniswapV3Pool(pc.pool).slot0();
        if (cardinality < minCardinality()) revert NoTwap();
        d.twapTick = _twapTick(pc.pool);

        (d.roundId, d.answer, d.updatedAt, d.stockDecimals, d.session) = _priced(d.stock);
        if (c.regularOnly && d.session != FillmarkFeeds.Session.Regular) revert RegularHoursOnly();
    }

    /// Observations the pool must keep. Timestamps are whole seconds and a pool writes at
    /// most one per second, so twapWindow + 1 of them always reach twapWindow back.
    function minCardinality() public view returns (uint256) {
        return twapWindow < MIN_CARDINALITY ? MIN_CARDINALITY : uint256(twapWindow) + 1;
    }

    /// The pool's mean tick over the last twapWindow seconds, rounded down.
    function _twapTick(address pool) private view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = twapWindow;
        try IUniswapV3PoolState(pool).observe(ago) returns (int56[] memory cum, uint160[] memory) {
            int56 delta = cum[1] - cum[0];
            int56 w = int56(uint56(twapWindow));
            int56 t = delta / w;
            if (delta < 0 && delta % w != 0) t--;
            // A mean of pool ticks lies within the pool's tick range, which fits int24.
            // forge-lint: disable-next-line(unsafe-typecast)
            return int24(t);
        } catch {
            revert NoTwap();
        }
    }

    /// After the swap: the pool price, pool fee included, within C of NAV and the pool tick
    /// within min(C, twapCap) of the TWAP, C = min(client limit - fill fee, pool cap). A swap
    /// moves the price one way only, so this bounds the whole swap.
    function _checkPath(Config storage c, PoolCfg memory pc, Fill memory d) private view {
        uint256 cap = c.maxSlipBps > fillFeeBps ? c.maxSlipBps - fillFeeBps : 0;
        if (pc.capBps < cap) cap = pc.capBps;
        uint256 twapCap = pc.twapCapBps < cap ? pc.twapCapBps : cap;
        int24 tick;
        // forge-lint: disable-next-line(unused-return)
        (d.sqrtPriceAfter, tick,,,,,) = IUniswapV3Pool(pc.pool).slot0();
        bool stock0 = d.stock < usdg;
        uint256 spot = spotPrice(d.sqrtPriceAfter, stock0, d.stockDecimals);
        uint256 nav = SafeCast.toUint256(d.answer);
        if (d.buy) {
            // A buy pays spot / (1 - fee) at the margin.
            if (spot * 1e6 * 1e4 > nav * (1e4 + cap) * (1e6 - uint256(pc.fee))) revert PriceOutOfRange();
        } else {
            if (spot * (1e6 - uint256(pc.fee)) * 1e4 < nav * (1e4 - cap) * 1e6) revert PriceOutOfRange();
        }
        // Ticks are 1.0001 apart, so N ticks are about N bps (100 ticks: 100.5 bps).
        int256 up = stock0 ? int256(tick) - int256(d.twapTick) : int256(d.twapTick) - int256(tick);
        // twapCap <= MAX_POOL_CAP_BPS, so the cast keeps its value.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 lim = int256(twapCap);
        if (d.buy ? up > lim : -up > lim) revert PriceOutOfRange();
    }

    function _settleFill(Config storage c, bytes32 key, Fill memory d) private {
        uint256 answer = SafeCast.toUint256(d.answer);
        uint256 navValue = navValueOf(d.stockAmount, answer, d.stockDecimals);
        if (d.buy
                ? (d.usdgAmount + d.fillFee) * 1e4 > navValue * (1e4 + c.maxSlipBps)
                : (d.usdgAmount - d.fillFee) * 1e4 < navValue * (1e4 - c.maxSlipBps)) revert WorseThanNav();
        // A sale of the agent's whole lot may be smaller, so a lot worth under the minimum
        // can still be closed.
        if (d.usdgAmount < MIN_NOTIONAL && (d.buy || d.stockAmount != _lots[key][d.stock].qty)) revert TooSmall();
        if ((d.buy ? d.usdgAmount : Math.max(d.usdgAmount, navValue)) > c.maxPerTrade) revert OverTradeLimit();
        if (d.buy) _spend(d.account, c.dailyLimit, d.usdgAmount + d.fillFee);

        if (d.fillFee != 0) {
            // Through the router, so a burner USDG refuses (frozen) does not stop fills.
            _pull(d.account, address(this), d.fillFee);
            _payOut(burner, d.fillFee);
        }
        if (d.buy) {
            uint256 cost = Math.max(d.usdgAmount + d.fillFee, navValueCeil(d.stockAmount, answer, d.stockDecimals));
            uint256 back = _bookBuy(key, d.stock, d.stockAmount, cost);
            if (back != 0) {
                _payOut(d.account, back);
                // forge-lint: disable-next-line(reentrancy-events)
                emit EscrowReturned(d.account, d.agentId, back);
            }
            return;
        }
        uint256 net = d.usdgAmount - d.fillFee;
        uint256 esc = _bookSell(key, d.account, d.agentId, d.stock, d.stockAmount, Math.min(net, navValue));
        // Order of payment from the proceeds: fill fee, escrow, then debt; esc <= gain <= net.
        if (esc != 0) {
            _pull(d.account, address(this), esc);
            // forge-lint: disable-next-line(reentrancy-events)
            emit Escrowed(d.account, d.agentId, d.stock, esc);
        }
        Book storage b = _books[key];
        uint256 debtPaid = Math.min(b.debt, net - esc);
        if (debtPaid != 0) {
            b.debt -= SafeCast.toUint128(debtPaid);
            b.paid += SafeCast.toUint128(debtPaid);
            _pull(d.account, address(this), debtPaid);
            _payOut(b.wallet, debtPaid);
            // forge-lint: disable-next-line(reentrancy-events)
            emit DebtPaid(d.account, d.agentId, debtPaid, b.debt);
        }
    }

    // forge-lint: disable-start(calls-loop, require-revert-in-loop)
    function _priced(address stock)
        private
        view
        returns (uint80 roundId, int256 answer, uint256 updatedAt, uint8 decimals, FillmarkFeeds.Session session)
    {
        FillmarkFeeds.Source memory src = feeds.sourceOf(stock, block.timestamp);
        if (src.feed == address(0)) revert UnknownStock();
        session = src.session;
        decimals = src.decimals;
        if (IERC20Metadata(stock).decimals() != src.decimals || IERC20Metadata(usdg).decimals() != 6) {
            revert DecimalsChanged();
        }
        if (session == FillmarkFeeds.Session.Closed) revert MarketClosed();

        IAggregatorV3 feed = IAggregatorV3(src.feed);
        uint256 startedAt;
        // forge-lint: disable-next-line(unused-return)
        (roundId, answer, startedAt, updatedAt,) = feed.latestRoundData();
        if (answer <= 0 || feed.decimals() != 8) revert BadFeed();
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > src.maxAge) revert StaleFeed();
        if (src.crypto) return (roundId, answer, updatedAt, decimals, session);
        if (IStockToken(stock).oraclePaused()) revert OraclePaused();
        if (src.multiplierInFeed) {
            uint256 effectiveAt = IStockToken(stock).effectiveAt();
            if (effectiveAt >= startedAt && effectiveAt <= block.timestamp) revert MultiplierNotPriced();
        } else if (IStockToken(stock).uiMultiplier() != 1e18) {
            revert MultiplierNotPriced();
        }
    }
    // forge-lint: disable-end(calls-loop, require-revert-in-loop)

    function _nav(address stock) private view returns (uint256 answer, uint8 decimals) {
        int256 a;
        (, a,, decimals,) = _priced(stock);
        answer = SafeCast.toUint256(a);
    }

    // ---- rolling buy limit ----

    /// USDG the account's buys used in the window: the current hour and the 24 before it.
    function windowSpent(address account) public view returns (uint256 spent) {
        uint256 h = block.timestamp / 1 hours;
        Bucket[WINDOW_HOURS] storage list = _buckets[account];
        for (uint256 i; i < WINDOW_HOURS; i++) {
            if (list[i].amount != 0 && uint256(list[i].hour) + 24 >= h) spent += list[i].amount;
        }
    }

    function _spend(address account, uint128 dailyLimit, uint256 amount) private {
        if (windowSpent(account) + amount > dailyLimit) revert OverDailyLimit();
        uint256 h = block.timestamp / 1 hours;
        Bucket storage b = _buckets[account][h % WINDOW_HOURS];
        if (b.hour != h) {
            b.hour = SafeCast.toUint64(h);
            b.amount = 0;
        }
        b.amount += SafeCast.toUint128(amount);
    }

    // ---- ledger ----

    function keyOf(address account, uint256 agentId) public pure returns (bytes32) {
        return keccak256(abi.encode(account, agentId));
    }

    function _list(bytes32 key, address stock) private {
        if (_listed[key][stock]) return;
        _listed[key][stock] = true;
        _tokens[key].push(stock);
    }

    /// Moves matured holds (and their escrow) and a matured outflow gain into realized.
    function _mature(bytes32 key, address stock) private {
        Book storage b = _books[key];
        Hold storage h = _holds[key][stock];
        if (h.until != 0 && h.until <= block.timestamp) {
            b.realized += SafeCast.toInt128(SafeCast.toInt256(uint256(h.gain)));
            b.escMatured += h.esc;
            delete _holds[key][stock];
        }
        Hold storage n = _laterHolds[key][stock];
        if (n.until != 0 && n.until <= block.timestamp) {
            b.realized += SafeCast.toInt128(SafeCast.toInt256(uint256(n.gain)));
            b.escMatured += n.esc;
            delete _laterHolds[key][stock];
        }
        _promote(key, stock);
        Out storage o = _outs[key][stock];
        if (o.until != 0 && o.until <= block.timestamp) {
            b.realized += SafeCast.toInt128(SafeCast.toInt256(uint256(o.gain)));
            b.outLoss -= o.loss; // final once its hold ends
            delete _outs[key][stock];
        }
    }

    function _waitUntil(uint64 until, uint256 gain, uint256 added) private view returns (uint64) {
        uint256 end = block.timestamp + hold;
        if (until == 0) return SafeCast.toUint64(end);
        if (added == 0) return until;
        return SafeCast.toUint64(
            Math.mulDiv(uint256(until), gain, gain + added) + Math.mulDiv(end, added, gain + added, Math.Rounding.Ceil)
        );
    }

    function _syncToken(bytes32 key, address account, uint256 agentId, address stock, uint256 answer, uint8 decimals)
        private
        returns (uint256 bal)
    {
        _mature(key, stock);
        // forge-lint: disable-next-line(calls-loop)
        bal = IERC20(stock).balanceOf(account);
        Lot storage l = _lots[key][stock];
        if (bal < l.qty) {
            uint256 s = l.qty - bal;
            int256 pnl = _moveOut(key, stock, s, answer, decimals);
            // forge-lint: disable-next-line(reentrancy-events)
            emit MovedOut(account, agentId, stock, s, pnl);
        } else if (bal > l.qty && _outs[key][stock].qty != 0) {
            uint256 r = _moveBack(key, stock, bal - l.qty, answer, decimals);
            // forge-lint: disable-next-line(reentrancy-events)
            emit MovedBack(account, agentId, stock, r);
        }
    }

    function _moveOut(bytes32 key, address stock, uint256 s, uint256 answer, uint8 decimals)
        private
        returns (int256 pnl)
    {
        Lot storage l = _lots[key][stock];
        Out storage o = _outs[key][stock];
        uint256 costOut = Math.mulDiv(l.cost, s, l.qty, Math.Rounding.Ceil);
        uint256 proceeds = navValueOf(s, answer, decimals);
        l.qty -= SafeCast.toUint128(s);
        l.cost -= SafeCast.toUint128(costOut);
        o.qty += SafeCast.toUint128(s);
        uint256 gain = proceeds > costOut ? proceeds - costOut : 0;
        o.until = _waitUntil(o.until, o.gain, gain);
        if (proceeds >= costOut) {
            o.gain += SafeCast.toUint128(gain);
        } else {
            o.loss += SafeCast.toUint128(costOut - proceeds);
            _books[key].realized -= SafeCast.toInt128(SafeCast.toInt256(costOut - proceeds));
            _books[key].outLoss += SafeCast.toUint128(costOut - proceeds);
        }
        pnl = SafeCast.toInt256(proceeds) - SafeCast.toInt256(costOut);
    }

    function _moveBack(bytes32 key, address stock, uint256 extra, uint256 answer, uint8 decimals)
        private
        returns (uint256 r)
    {
        Lot storage l = _lots[key][stock];
        Out storage o = _outs[key][stock];
        r = Math.min(extra, o.qty);
        uint256 gainBack = Math.mulDiv(o.gain, r, o.qty);
        uint256 lossBack = Math.mulDiv(o.loss, r, o.qty);
        uint256 value = navValueCeil(r, answer, decimals);
        uint256 cancel = Math.min(gainBack, value);
        l.qty += SafeCast.toUint128(r);
        l.cost += SafeCast.toUint128(value + lossBack - cancel);
        _books[key].realized += SafeCast.toInt128(SafeCast.toInt256(lossBack));
        _books[key].outLoss -= SafeCast.toUint128(lossBack);
        o.qty -= SafeCast.toUint128(r);
        o.gain -= SafeCast.toUint128(cancel);
        o.loss -= SafeCast.toUint128(lossBack);
        if (o.qty == 0 && o.gain == 0) delete _outs[key][stock];
    }

    function _promote(bytes32 key, address stock) private {
        if (_holds[key][stock].gain == 0 && _laterHolds[key][stock].gain != 0) {
            _holds[key][stock] = _laterHolds[key][stock];
            delete _laterHolds[key][stock];
        }
    }

    /// Returns the escrow freed by gains the rebuy cancelled.
    function _bookBuy(bytes32 key, address stock, uint256 qty, uint256 cost) private returns (uint256 back) {
        _list(key, stock);
        uint256 left;
        uint256 b1;
        uint256 b2;
        (left, cost, b1) = _cancel(_laterHolds[key][stock], qty, cost);
        (, cost, b2) = _cancel(_holds[key][stock], left, cost);
        _promote(key, stock);
        Lot storage l = _lots[key][stock];
        l.qty += SafeCast.toUint128(qty);
        l.cost += SafeCast.toUint128(cost);
        back = b1 + b2;
    }

    /// Cancels a hold's gain in proportion to `qty` of its units, up to `cost`, lowers the
    /// cost by as much and frees the same share of its escrow (all of it once the gain is gone).
    function _cancel(Hold storage h, uint256 qty, uint256 cost) private returns (uint256, uint256, uint256 back) {
        if (h.gain == 0 || qty == 0) return (qty, cost, 0);
        uint256 matched = Math.min(qty, h.qty);
        uint256 share = qty >= h.qty ? h.gain : Math.mulDiv(h.gain, qty, h.qty);
        uint256 cancel = Math.min(share, cost);
        back = Math.mulDiv(h.esc, cancel, h.gain);
        h.gain -= SafeCast.toUint128(cancel);
        h.qty -= SafeCast.toUint128(matched);
        if (h.gain == 0) {
            back = h.esc;
            h.qty = 0;
            h.until = 0;
        }
        h.esc -= SafeCast.toUint128(back);
        return (qty - matched, cost - cancel, back);
    }

    /// Books an agent's sale of units it bought; returns the escrow its gain needs.
    function _bookSell(bytes32 key, address account, uint256 agentId, address stock, uint256 qty, uint256 proceeds)
        private
        returns (uint256 esc)
    {
        Lot storage l = _lots[key][stock];
        uint256 costOut = Math.mulDiv(l.cost, qty, l.qty, Math.Rounding.Ceil);
        l.qty -= SafeCast.toUint128(qty);
        l.cost -= SafeCast.toUint128(costOut);
        int256 pnl = SafeCast.toInt256(proceeds) - SafeCast.toInt256(costOut);
        if (pnl < 0) {
            _books[key].realized += SafeCast.toInt128(pnl);
        } else if (pnl > 0) {
            Hold storage h = _holds[key][stock].gain == 0 ? _holds[key][stock] : _laterHolds[key][stock];
            // pnl > 0 here, so the cast keeps its value.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 gain = uint256(pnl);
            esc = Math.mulDiv(gain, _books[key].perfFeeBps, 1e4, Math.Rounding.Ceil);
            h.until = SafeCast.toUint64(block.timestamp + hold);
            h.gain += SafeCast.toUint128(gain);
            h.qty += SafeCast.toUint128(qty);
            h.esc += SafeCast.toUint128(esc);
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit Booked(account, agentId, stock, pnl);
    }

    /// Realized PnL and open loss at NAV, after syncing every token. Reverts if a token
    /// with tracked units cannot be priced.
    function _base(bytes32 key, address account, uint256 agentId) private returns (int256, uint256 openLoss) {
        address[] storage list = _tokens[key];
        uint256 i = 0;
        while (i < list.length) {
            address stock = list[i];
            Lot storage l = _lots[key][stock];
            _mature(key, stock);
            Out storage o = _outs[key][stock];
            // forge-lint: disable-next-line(calls-loop)
            bool priced = l.qty != 0 || (o.qty != 0 && IERC20(stock).balanceOf(account) > l.qty);
            uint256 answer = 0;
            uint8 decimals = 0;
            if (priced) (answer, decimals) = _nav(stock);
            _syncToken(key, account, agentId, stock, answer, decimals);
            if (l.qty != 0) {
                if (!priced) (answer, decimals) = _nav(stock);
                uint256 value = navValueOf(l.qty, answer, decimals);
                if (l.cost > value) openLoss += l.cost - value;
            }
            if (
                l.qty == 0 && _holds[key][stock].until == 0 && _laterHolds[key][stock].until == 0
                    && _outs[key][stock].until == 0
            ) {
                delete _lots[key][stock];
                _listed[key][stock] = false;
                list[i] = list[list.length - 1];
                list.pop();
            } else {
                i++;
            }
        }
        return (_books[key].realized, openLoss);
    }

    /// Charges the performance fee, collects debt and releases matured escrow. Anyone may
    /// call it. The fee is charged only with no open loss beyond dust; matured escrow is
    /// paid to the agent first, and what stays held is at most the fee on realized PnL above
    /// the peak (a figure that needs no price); the rest goes back to the account.
    function settle(address account) external returns (uint256 fee) {
        if (_locked) revert Reentered();
        _locked = true;
        Config storage c = configs[account];
        if (!c.installed) revert NotInstalled();
        uint256 agentId = c.agentId;
        bytes32 key = keyOf(account, agentId);
        Book storage b = _books[key];
        (int256 realized, uint256 openLoss) = _base(key, account, agentId);
        if (openLoss <= DUST_LOSS) fee = _charge(b, realized);
        uint256 paid = _collect(b, account, fee);
        _release(b, account, agentId, realized);
        // forge-lint: disable-next-line(reentrancy-events)
        emit Settled(account, agentId, realized, openLoss, b.peak, fee, paid, b.debt);
        if (fee != 0) _tryGive(agentId, account, "fillmark-agentfee", SafeCast.toInt256(fee));
        _locked = false;
    }

    /// Releases matured escrow without pricing anything, for when settle cannot price a
    /// token: debt is paid from it first, the fee on realized PnL above the peak stays
    /// held for the next settle, and the rest goes back to the account. Charges no fee.
    function release(address account) external {
        if (_locked) revert Reentered();
        _locked = true;
        Config storage c = configs[account];
        if (!c.installed) revert NotInstalled();
        uint256 agentId = c.agentId;
        bytes32 key = keyOf(account, agentId);
        address[] storage list = _tokens[key];
        for (uint256 i; i < list.length; i++) {
            _mature(key, list[i]);
        }
        Book storage b = _books[key];
        _collect(b, account, 0);
        _release(b, account, agentId, b.realized);
        _locked = false;
    }

    /// Pays fee and debt from matured escrow, then from the account's USDG; the rest stays debt.
    function _collect(Book storage b, address account, uint256 fee) private returns (uint256 paid) {
        uint256 owed = fee + b.debt;
        uint256 fromEsc = Math.min(owed, b.escMatured);
        b.escMatured -= SafeCast.toUint128(fromEsc);
        owed -= fromEsc;
        uint256 fromAccount = Math.min(owed, IERC20(usdg).balanceOf(account));
        if (fromAccount != 0 && !_tryPull(account, address(this), fromAccount)) fromAccount = 0;
        b.debt = SafeCast.toUint128(owed - fromAccount);
        paid = fromEsc + fromAccount;
        if (paid != 0) {
            b.paid += SafeCast.toUint128(paid);
            _payOut(b.wallet, paid);
        }
    }

    /// Matured escrow beyond the fee on realized PnL above the peak goes back to the account.
    /// A loss on units moved out is undone if they come back, so it does not lower what is kept.
    function _release(Book storage b, address account, uint256 agentId, int256 realized) private {
        uint256 keep = 0;
        int256 base = realized + SafeCast.toInt256(uint256(b.outLoss));
        if (base > b.peak) {
            keep = Math.mulDiv(SafeCast.toUint256(base - b.peak), b.perfFeeBps, 1e4, Math.Rounding.Ceil);
        }
        uint256 avail = b.escMatured;
        if (avail <= keep) return;
        b.escMatured = SafeCast.toUint128(keep);
        _payOut(account, avail - keep);
        // forge-lint: disable-next-line(reentrancy-events)
        emit EscrowReturned(account, agentId, avail - keep);
    }

    function _charge(Book storage b, int256 base) private returns (uint256 fee) {
        if (base <= b.peak) return 0;
        fee = Math.mulDiv(SafeCast.toUint256(base - b.peak), b.perfFeeBps, 1e4);
        b.peak = SafeCast.toInt128(base);
    }

    /// Marks the book of an account that removed the router without its onUninstall running
    /// (Kernel ignores a failed one), so close-out's clock starts even while a token cannot
    /// be priced. Anyone may call it.
    function markClosing(address account) external {
        if (_locked) revert Reentered();
        _locked = true;
        Config storage c = configs[account];
        if (!c.installed || IERC7579Modules(account).isModuleInstalled(MODULE_TYPE_EXECUTOR, address(this), "")) {
            revert NotClosing();
        }
        _markClosing(account, c);
        _locked = false;
    }

    /// After the client removed the router: units moved out or back are booked at NAV, every
    /// tracked unit is valued at NAV, every pending gain counts, the fee and any debt are paid
    /// from the escrow first, the rest of the escrow goes back to the account and what is
    /// still owed becomes debt. Its payments never revert, so a frozen address cannot block it.
    function closeOut(address account, uint256 agentId) external returns (uint256 fee) {
        if (_locked) revert Reentered();
        _locked = true;
        Config storage c = configs[account];
        if (c.installed) {
            if (
                c.agentId != agentId
                    || IERC7579Modules(account).isModuleInstalled(MODULE_TYPE_EXECUTOR, address(this), "")
            ) {
                revert NotClosing();
            }
            _markClosing(account, c);
        }
        bytes32 key = keyOf(account, agentId);
        Book storage b = _books[key];
        if (!b.closing || openBook[account] != agentId + 1) revert NotClosing();

        uint256 esc = 0;
        address[] storage list = _tokens[key];
        for (uint256 i; i < list.length; i++) {
            address stock = list[i];
            int256 value = _closeToken(key, account, agentId, stock, b.closingAt);
            b.realized += SafeCast.toInt128(
                value + SafeCast.toInt256(uint256(_holds[key][stock].gain))
                    + SafeCast.toInt256(uint256(_laterHolds[key][stock].gain))
                    + SafeCast.toInt256(uint256(_outs[key][stock].gain))
            );
            esc += uint256(_holds[key][stock].esc) + uint256(_laterHolds[key][stock].esc);
            b.outLoss -= _outs[key][stock].loss; // units still out stay sold
            delete _lots[key][stock];
            delete _holds[key][stock];
            delete _laterHolds[key][stock];
            delete _outs[key][stock];
            delete _listed[key][stock];
        }
        delete _tokens[key];
        esc += b.escMatured;
        int256 base = b.realized;
        fee = _charge(b, base);
        uint256 owed = fee + b.debt;
        uint256 fromEsc = Math.min(owed, esc);
        b.debt = SafeCast.toUint128(owed - fromEsc);
        b.escMatured = 0;
        b.closing = false;
        b.closingAt = 0;
        openBook[account] = 0;
        if (fromEsc != 0) {
            b.paid += SafeCast.toUint128(fromEsc);
            _payOut(b.wallet, fromEsc);
        }
        if (esc > fromEsc) {
            _payOut(account, esc - fromEsc);
            // forge-lint: disable-next-line(reentrancy-events)
            emit EscrowReturned(account, agentId, esc - fromEsc);
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit ClosedOut(account, agentId, base, fee, b.debt);
        _locked = false;
    }

    /// A token's lot at close-out, as value less cost. With a price, units moved out or back
    /// are synced first and the lot is valued at NAV. Without one the close-out waits, except
    /// for a token that is stuck: STUCK_AFTER the removal, and its feed silent that long (or
    /// the token unpriceable for another reason than a closed market or a stale feed), the
    /// lot is valued at its cost.
    // forge-lint: disable-start(calls-loop, require-revert-in-loop)
    function _closeToken(bytes32 key, address account, uint256 agentId, address stock, uint64 closingAt)
        private
        returns (int256)
    {
        Lot storage l = _lots[key][stock];
        if (l.qty == 0 && _outs[key][stock].qty == 0) {
            _mature(key, stock);
            return 0;
        }
        try this.priceOf(stock) returns (uint256 answer, uint8 decimals) {
            _syncToken(key, account, agentId, stock, answer, decimals);
            return SafeCast.toInt256(navValueOf(l.qty, answer, decimals)) - SafeCast.toInt256(uint256(l.cost));
        } catch (bytes memory reason) {
            if (!_stuck(stock, reason, closingAt)) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
            _mature(key, stock);
            return 0; // at cost
        }
    }

    function _stuck(address stock, bytes memory reason, uint64 closingAt) private view returns (bool) {
        if (block.timestamp < uint256(closingAt) + STUCK_AFTER || reason.length < 4) return false;
        // The selector: the first 4 bytes of the revert data, whose length was checked.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 sel = bytes4(reason);
        if (sel != MarketClosed.selector && sel != StaleFeed.selector) return true;
        try IAggregatorV3(feeds.feedOf(stock)).latestRoundData() returns (
            uint80, int256, uint256, uint256 updatedAt, uint80
        ) {
            return updatedAt + STUCK_AFTER <= block.timestamp;
        } catch {
            return true;
        }
    }
    // forge-lint: disable-end(calls-loop, require-revert-in-loop)

    function priceOf(address stock) external view returns (uint256 answer, uint8 decimals) {
        return _nav(stock);
    }

    /// The client pays debt to an agent it removed: approve the router for USDG, then call.
    function payDebt(uint256 agentId, uint256 amount) external {
        if (_locked) revert Reentered();
        _locked = true;
        Book storage b = _books[keyOf(msg.sender, agentId)];
        if (amount == 0 || amount > b.debt) revert BadAmount();
        b.debt -= SafeCast.toUint128(amount);
        b.paid += SafeCast.toUint128(amount);
        IERC20(usdg).safeTransferFrom(msg.sender, address(this), amount);
        _payOut(b.wallet, amount);
        // forge-lint: disable-next-line(reentrancy-events)
        emit DebtPaid(msg.sender, agentId, amount, b.debt);
        _locked = false;
    }

    /// Sends `who` the USDG a payment could not deliver (for example while USDG froze it).
    function claim(address who) external {
        if (_locked) revert Reentered();
        _locked = true;
        uint256 amount = claimable[who];
        if (amount == 0) revert BadAmount();
        claimable[who] = 0;
        IERC20(usdg).safeTransfer(who, amount);
        emit Claimed(who, amount);
        _locked = false;
    }

    // ---- views ----

    function poolOf(address token) external view returns (PoolCfg memory) {
        return _pools[token];
    }

    function bookOf(address account, uint256 agentId) external view returns (Book memory) {
        return _books[keyOf(account, agentId)];
    }

    function tokensOf(address account, uint256 agentId) external view returns (address[] memory) {
        return _tokens[keyOf(account, agentId)];
    }

    function positionOf(address account, uint256 agentId, address stock)
        external
        view
        returns (Lot memory lot, Hold memory pending, Hold memory later, Out memory movedOut)
    {
        bytes32 key = keyOf(account, agentId);
        return (_lots[key][stock], _holds[key][stock], _laterHolds[key][stock], _outs[key][stock]);
    }

    // ---- records ----

    function _publish(Fill memory d, Prices memory p, bytes32 fillId, bytes32 sk) private {
        string memory ext = d.session == FillmarkFeeds.Session.Extended ? "-ext" : "";
        string memory tag2 = string.concat(feeds.tickerOf(d.stock), ":B", Strings.toString(bucketOf(d.usdgAmount)));
        _give(d.agentId, d.account, string.concat("fillmark-cost", ext), tag2, p.cost, fillId, sk);
        _give(
            d.agentId,
            d.account,
            string.concat("fillmark-notional", ext),
            tag2,
            SafeCast.toInt256(d.usdgAmount),
            fillId,
            sk
        );
    }

    /// The fill's record from the client's account. One the registry refuses (for example
    /// when the agent's owner approved the account as an operator) does not undo the fill:
    /// it is counted in the stats and logged, so a reader sees it.
    function _give(
        uint256 agentId,
        address account,
        string memory tag1,
        string memory tag2,
        int256 value,
        bytes32 hash,
        bytes32 sk
    ) private {
        bytes memory call = abi.encodeCall(
            IReputationRegistry.giveFeedback,
            (agentId, SafeCast.toInt128(value), VALUE_DECIMALS, tag1, tag2, "", "", hash)
        );
        bool ok = _tryCall(
            account,
            abi.encodeCall(
                IERC7579Account.executeFromExecutor,
                (bytes32(0), abi.encodePacked(address(reputation), uint256(0), call))
            ),
            FEEDBACK_GAS
        );
        if (!ok) {
            stats[sk].feedbackFails += 1;
            // forge-lint: disable-next-line(reentrancy-events)
            emit FeedbackFailed(account, agentId, hash, tag1);
        }
    }

    function _pull(address account, address to, uint256 amount) private {
        if (!_tryPull(account, to, amount)) revert PaymentFailed();
    }

    /// Whether the account sent exactly `amount` USDG to `to` (checked on `to`'s balance).
    function _tryPull(address account, address to, uint256 amount) private returns (bool) {
        uint256 before = IERC20(usdg).balanceOf(to);
        bytes memory data = abi.encodeCall(
            IERC7579Account.executeFromExecutor,
            (bytes32(0), abi.encodePacked(usdg, uint256(0), abi.encodeCall(IERC20.transfer, (to, amount))))
        );
        bool ok = _tryCall(account, data, PAY_GAS);
        // forge-lint: disable-next-line(incorrect-strict-equality)
        return ok && IERC20(usdg).balanceOf(to) == before + amount;
    }

    /// Sends USDG the router holds; a transfer USDG refuses (a frozen address) becomes a
    /// balance `to` can claim later. Never reverts.
    // Every entry point that reaches here holds _locked.
    // forge-lint: disable-start(reentrancy-no-eth, reentrancy-events)
    function _payOut(address to, uint256 amount) private {
        if (amount == 0) return;
        uint256 before = IERC20(usdg).balanceOf(to);
        bool ok = _tryCall(usdg, abi.encodeCall(IERC20.transfer, (to, amount)), PAY_GAS);
        // Exactly the amount, as USDG moves it: anything else was not this payment.
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (ok && IERC20(usdg).balanceOf(to) == before + amount) return;
        claimable[to] += amount;
        emit Credited(to, amount);
    }
    // forge-lint: disable-end(reentrancy-no-eth, reentrancy-events)

    function _tryGive(uint256 agentId, address account, string memory tag1, int256 value) private {
        bytes memory call = abi.encodeCall(
            IReputationRegistry.giveFeedback,
            (agentId, SafeCast.toInt128(value), VALUE_DECIMALS, tag1, "", "", "", bytes32(0))
        );
        _tryCall(
            account,
            abi.encodeCall(
                IERC7579Account.executeFromExecutor,
                (bytes32(0), abi.encodePacked(address(reputation), uint256(0), call))
            ),
            FEEDBACK_GAS
        );
    }

    function _tryCall(address account, bytes memory data, uint256 gasLimit) private returns (bool ok) {
        if (gasleft() < gasLimit + gasLimit / 63 + 10_000) revert LowGas();
        assembly ("memory-safe") {
            ok := call(gasLimit, account, 0, add(data, 32), mload(data), 0, 0)
        }
    }

    function _tally(Fill memory d, Prices memory p) private returns (bytes32 sk) {
        sk = statsKey(
            d.agentId, d.account, d.stock, bucketOf(d.usdgAmount), d.session == FillmarkFeeds.Session.Extended
        );
        Stats storage t = stats[sk];
        int256 ratio = p.cost * 1e6 / SafeCast.toInt256(d.usdgAmount);
        if (ratio < type(int64).min) ratio = type(int64).min;
        if (t.fills == 0 || ratio > t.worst) t.worst = SafeCast.toInt64(ratio);
        t.fills += 1;
        t.notional += SafeCast.toUint128(d.usdgAmount);
        t.sumCost += SafeCast.toInt128(p.cost);
    }

    function statsOf(uint256 agentId, address account, address stock) external view returns (Stats memory s) {
        for (uint8 b = 0; b <= 7; b++) {
            for (uint256 e; e < 2; e++) {
                Stats storage t = stats[statsKey(agentId, account, stock, b, e == 1)];
                if (t.fills == 0) continue;
                if (s.fills == 0 || t.worst > s.worst) s.worst = t.worst;
                s.fills += t.fills;
                s.feedbackFails += t.feedbackFails;
                s.notional += t.notional;
                s.sumCost += t.sumCost;
            }
        }
    }

    function statsKey(uint256 agentId, address account, address stock, uint8 bucket, bool extended)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(agentId, account, stock, bucket, extended));
    }

    function pricesOf(Fill memory f) public view returns (Prices memory p) {
        p.nav = SafeCast.toUint256(f.answer);
        p.spot = spotPrice(f.sqrtPriceX96, f.stock < usdg, f.stockDecimals);
        p.fill = Math.mulDiv(f.usdgAmount, _scale(f.stockDecimals), f.stockAmount);
        int256 sign = f.buy ? int256(1) : int256(-1);
        p.shortfall = sign * _diff(p.fill, p.nav);
        p.premium = sign * _diff(p.spot, p.nav);
        p.impact = sign * _diff(p.fill, p.spot);
        int256 navValue = SafeCast.toInt256(navValueOf(f.stockAmount, p.nav, f.stockDecimals));
        p.cost = sign * (SafeCast.toInt256(f.usdgAmount) - navValue);
    }

    function navValueOf(uint256 amount, uint256 price, uint8 stockDecimals) public pure returns (uint256) {
        return Math.mulDiv(amount, price, _scale(stockDecimals));
    }

    function navValueCeil(uint256 amount, uint256 price, uint8 stockDecimals) public pure returns (uint256) {
        return Math.mulDiv(amount, price, _scale(stockDecimals), Math.Rounding.Ceil);
    }

    function spotPrice(uint160 sqrtPriceX96, bool stockIsToken0, uint8 stockDecimals) public pure returns (uint256) {
        uint256 e = uint256(stockDecimals) + 2;
        if (stockIsToken0) {
            return Math.mulDiv(Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 96), 10 ** e, 1 << 96);
        }
        return Math.mulDiv(Math.mulDiv(1 << 192, 10 ** (e / 2), sqrtPriceX96), 10 ** (e - e / 2), sqrtPriceX96);
    }

    function _scale(uint8 stockDecimals) private pure returns (uint256) {
        return 10 ** (uint256(stockDecimals) + 2);
    }

    function bucketOf(uint256 usdgAmount) public pure returns (uint8) {
        if (usdgAmount < MIN_NOTIONAL) return 0;
        if (usdgAmount < 30e6) return 1;
        if (usdgAmount < 100e6) return 2;
        if (usdgAmount < 300e6) return 3;
        if (usdgAmount < 1_000e6) return 4;
        if (usdgAmount < 3_000e6) return 5;
        if (usdgAmount < 10_000e6) return 6;
        return 7;
    }

    function _diff(uint256 a, uint256 b) private pure returns (int256) {
        int256 bi = SafeCast.toInt256(b);
        return (SafeCast.toInt256(a) - bi) * 1e6 / bi;
    }

    function _swap(address pool, FillIntent calldata it) private returns (uint256 amountOut) {
        bool zeroForOne = it.tokenIn < it.tokenOut;
        uint160 limit = it.sqrtPriceLimitX96;
        if (limit == 0) limit = zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;
        _pool = pool;
        _account = it.account;
        _tokenIn = it.tokenIn;
        _amountIn = it.amountIn;
        // forge-lint: disable-start(reentrancy-no-eth)
        (int256 amount0, int256 amount1) =
            IUniswapV3Pool(pool).swap(it.account, zeroForOne, SafeCast.toInt256(it.amountIn), limit, "");
        // forge-lint: disable-end(reentrancy-no-eth)
        _pool = address(0);
        (int256 paid, int256 received) = zeroForOne ? (amount0, amount1) : (amount1, amount0);
        if (paid != SafeCast.toInt256(it.amountIn) || received > 0) revert PartialFill();
        amountOut = SafeCast.toUint256(-received);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != _pool || msg.sender == address(0)) revert BadCallback();
        int256 delta = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (delta <= 0 || SafeCast.toUint256(delta) != _amountIn) revert PartialFill();
        bytes[] memory ret = IERC7579Account(_account)
            .executeFromExecutor(
                bytes32(0),
                abi.encodePacked(_tokenIn, uint256(0), abi.encodeCall(IERC20.transfer, (msg.sender, _amountIn)))
            );
        if (ret.length != 1 || (ret[0].length != 0 && !abi.decode(ret[0], (bool)))) revert PaymentFailed();
    }
}
