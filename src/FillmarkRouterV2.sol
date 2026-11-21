// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
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

/// Fillmark router v2: every check of v1, plus a per-fill fee and a fill ledger that
/// lets an agent charge a performance fee on a client account it never controls.
///
/// The ledger is kept per (client account, agent). It tracks only tokens the agent
/// bought through the router, at the worse of fill price and Chainlink NAV for the
/// agent. Realized gains wait `hold` (7 days) and are cancelled by a rebuy of the same token;
/// losses count at once. Tokens the client moves out are booked as sold at NAV (and
/// restored if they come back within 7 days). The fee base is realized PnL plus open
/// losses; the agent is paid perfFeeBps of the base above its previous peak, from the
/// account's USDG. What cannot be paid becomes open debt: buys stop until it is paid.
/// The router never holds tokens and the agent never holds any key on the account.
contract FillmarkRouterV2 is EIP712 {
    using SafeERC20 for IERC20;

    uint256 private constant MODULE_TYPE_EXECUTOR = 2;
    uint16 public constant MAX_SLIP_LIMIT_BPS = 1_000;
    uint16 public constant MAX_FILL_FEE_BPS = 10;
    uint16 public constant MAX_PERF_FEE_BPS = 3_000;
    uint64 public constant MIN_HOLD = 1 hours;
    uint64 public constant MAX_HOLD = 30 days;
    // Gas given to a call into the account whose failure the router books instead of
    // reverting: a USDG payment, and the fee's feedback. Plain Kernel uses far less.
    uint256 public constant PAY_GAS = 150_000;
    uint256 public constant FEEDBACK_GAS = 400_000;
    uint256 public constant STUCK_AFTER = 30 days; // a closing book's unpriceable token is then valued at cost
    uint256 public constant MIN_NOTIONAL = 10e6; // USDG, 6 decimals
    uint8 public constant VALUE_DECIMALS = 6; // feedback values are USDG amounts
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "FillIntent(uint256 agentId,address account,uint64 installId,address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint256 minOut,uint160 refSqrtPriceX96,uint16 maxDevBps,uint160 sqrtPriceLimitX96,uint256 nonce,uint64 deadline)"
    );

    struct FillIntent {
        uint256 agentId;
        address account;
        uint64 installId; // binds the intent to one install of the module
        address tokenIn;
        address tokenOut;
        uint24 fee;
        uint256 amountIn;
        uint256 minOut;
        uint160 refSqrtPriceX96;
        uint16 maxDevBps;
        uint160 sqrtPriceLimitX96; // 0 = no limit; a hit limit means a partial fill and reverts
        uint256 nonce;
        uint64 deadline;
    }

    struct Config {
        uint256 agentId;
        address wallet; // agent wallet at install time; trading stops if it changes
        uint16 maxSlipBps; // worst allowed fill vs NAV, fill fee included
        uint16 perfFeeBps; // agent's share of the fee base above its peak
        uint64 expiry;
        uint64 installId;
        bool installed;
        uint128 maxPerTrade; // USDG, 6 decimals
        uint128 dailyLimit; // USDG, 6 decimals
        uint128 spentToday;
        uint64 day;
    }

    struct Fill {
        uint256 agentId;
        address account;
        address stock;
        bool buy;
        uint256 usdgAmount; // USDG paid to or received from the pool
        uint256 stockAmount;
        uint256 fillFee; // USDG sent to the burner, outside usdgAmount
        uint8 stockDecimals;
        uint160 sqrtPriceX96; // pool price before the swap
        uint80 roundId;
        int256 answer;
        uint256 updatedAt;
        FillmarkFeeds.Session session;
    }

    /// Same meaning as in v1: prices are 8 decimals, deltas bps * 100, cost is the
    /// pool execution cost in USDG against NAV (the fill fee is reported apart).
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
        uint128 notional;
        int64 worst;
        int128 sumCost;
    }

    /// Ledger of one (account, agent). USDG amounts have 6 decimals.
    struct Book {
        int128 realized; // realized PnL that counts: all losses, gains past their hold
        int128 peak; // highest fee base already charged
        uint128 debt; // fees owed and not yet paid
        uint128 paid; // fees paid to the agent so far
        address wallet; // where fees go: the agent wallet pinned at install
        uint16 perfFeeBps;
        bool closing; // set when the client removes the router; closeOut settles it
        uint64 closingAt; // when it was set
    }

    /// Units bought through the router and their cost.
    struct Lot {
        uint128 qty;
        uint128 cost;
    }

    /// Gains from the agent's own sales, waiting `hold`; a rebuy cancels them pro rata.
    /// Two per token: the older keeps its end, the later restarts with each sale and
    /// takes the older's place when that matures, so every gain waits at least `hold`
    /// and at most twice that.
    struct Hold {
        uint128 gain;
        uint128 qty;
        uint64 until;
    }

    /// Tracked units the client moved out, booked as sold at NAV. Their gain waits
    /// `hold`, their loss counts at once; units that come back are bought again at NAV.
    struct Out {
        uint128 qty;
        uint128 gain;
        uint128 loss;
        uint64 until;
    }

    IIdentityRegistry public immutable identity;
    IReputationRegistry public immutable reputation;
    IUniswapV3Factory public immutable factory;
    address public immutable usdg;
    FillmarkFeeds public immutable feeds;
    address public immutable burner;
    address public immutable admin; // the timelock; it can only change fillFeeBps
    uint64 public immutable hold; // how long a realized gain waits before it counts (7 days at deploy)
    uint16 public fillFeeBps;

    mapping(address => Config) public configs;
    mapping(address => mapping(uint64 => mapping(address => bool))) private _allowed;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    mapping(bytes32 => Stats) public stats;

    mapping(bytes32 => Book) private _books;
    mapping(bytes32 => mapping(address => Lot)) private _lots;
    mapping(bytes32 => mapping(address => Hold)) private _holds; // older
    mapping(bytes32 => mapping(address => Hold)) private _laterHolds;
    mapping(bytes32 => mapping(address => Out)) private _outs;
    mapping(bytes32 => address[]) private _tokens;
    mapping(bytes32 => mapping(address => bool)) private _listed;
    /// agentId + 1 of the account's book that is not closed out yet, 0 if none.
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
        uint64 expiry
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
    /// pnl of the agent's sale; gains wait `hold` before they count.
    event Booked(address indexed account, uint256 indexed agentId, address indexed stock, int256 pnl);
    event MovedOut(address indexed account, uint256 indexed agentId, address indexed stock, uint256 qty, int256 pnl);
    event MovedBack(address indexed account, uint256 indexed agentId, address indexed stock, uint256 qty);
    event Settled(
        address indexed account,
        uint256 indexed agentId,
        int256 base,
        int256 peak,
        uint256 fee,
        uint256 paid,
        uint256 debt
    );
    event ClosedOut(address indexed account, uint256 indexed agentId, int256 base, uint256 fee, uint256 debt);
    event DebtPaid(address indexed account, uint256 indexed agentId, uint256 amount, uint256 debt);
    event FillFeeSet(uint16 bps);

    error AlreadyInstalled();
    error NotInstalled();
    error BadConfig();
    error UnknownStock();
    error WrongAgent();
    error WrongInstall();
    error Expired();
    error NonceUsed();
    error WalletChanged();
    error BadSignature();
    error BadPair();
    error StockNotAllowed();
    error NoPool();
    error PriceMoved();
    error MarketClosed();
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
    error PaymentFailed();
    error InDebt();
    error CloseOutPending();
    error NotClosing();
    error NotAdmin();
    error BadAmount();
    error LowGas();

    constructor(
        IIdentityRegistry identity_,
        IReputationRegistry reputation_,
        IUniswapV3Factory factory_,
        address usdg_,
        FillmarkFeeds feeds_,
        address burner_,
        address admin_,
        uint16 fillFeeBps_,
        uint64 hold_
    ) EIP712("Fillmark", "2") {
        if (
            address(identity_) == address(0) || address(reputation_) == address(0) || address(factory_) == address(0)
                || usdg_ == address(0) || address(feeds_) == address(0) || burner_ == address(0) || admin_ == address(0)
                || fillFeeBps_ > MAX_FILL_FEE_BPS || hold_ < MIN_HOLD || hold_ > MAX_HOLD
        ) revert BadConfig();
        if (IERC20Metadata(usdg_).decimals() != 6) revert BadConfig();
        identity = identity_;
        reputation = reputation_;
        factory = factory_;
        usdg = usdg_;
        feeds = feeds_;
        burner = burner_;
        admin = admin_;
        fillFeeBps = fillFeeBps_;
        hold = hold_;
    }

    function setFillFeeBps(uint16 bps) external {
        if (msg.sender != admin) revert NotAdmin();
        if (bps > MAX_FILL_FEE_BPS) revert BadConfig();
        fillFeeBps = bps;
        emit FillFeeSet(bps);
    }

    // ---- ERC-7579 module ----

    struct Install {
        uint256 agentId;
        uint128 maxPerTrade;
        uint128 dailyLimit;
        uint64 expiry;
        uint16 maxSlipBps;
        uint16 perfFeeBps;
        address[] stocks;
    }

    /// data = abi.encode(agentId, maxPerTrade, dailyLimit, expiry, maxSlipBps, perfFeeBps, stocks)
    function onInstall(bytes calldata data) external payable {
        Config storage c = configs[msg.sender];
        if (c.installed) revert AlreadyInstalled();
        Install memory n = _decodeInstall(data);
        if (n.maxSlipBps == 0 || n.maxSlipBps > MAX_SLIP_LIMIT_BPS || n.expiry <= block.timestamp) revert BadConfig();
        if (n.perfFeeBps > MAX_PERF_FEE_BPS) revert BadConfig();
        address wallet = identity.getAgentWallet(n.agentId);
        if (wallet == address(0)) revert BadConfig();

        // One open book per account. A book left closing (no prices at removal, or the
        // removal ran out of gas) is closed out now, whichever agent comes next; without
        // prices the install waits. An agent the client owes cannot come back until paid.
        uint256 open = openBook[msg.sender];
        if (open != 0) {
            // A call to this router, lock-guarded, that calls only feeds and tokens.
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
            maxPerTrade: n.maxPerTrade,
            dailyLimit: n.dailyLimit,
            spentToday: 0,
            day: 0
        });
        for (uint256 i; i < n.stocks.length; i++) {
            // The client's own list: one unknown token rejects the whole install.
            // forge-lint: disable-next-line(calls-loop, require-revert-in-loop)
            if (feeds.feedOf(n.stocks[i]) == address(0)) revert UnknownStock();
            _allowed[msg.sender][id][n.stocks[i]] = true;
        }
        // forge-lint: disable-start(reentrancy-events)
        emit Installed(
            msg.sender, n.agentId, wallet, id, n.maxSlipBps, n.perfFeeBps, n.maxPerTrade, n.dailyLimit, n.expiry
        );
        // forge-lint: disable-end(reentrancy-events)
    }

    function _decodeInstall(bytes calldata data) private pure returns (Install memory n) {
        (n.agentId, n.maxPerTrade, n.dailyLimit, n.expiry, n.maxSlipBps, n.perfFeeBps, n.stocks) =
            abi.decode(data, (uint256, uint128, uint128, uint64, uint16, uint16, address[]));
    }

    /// Closes the book at the NAV of this moment when every token can be priced; otherwise
    /// it stays closing until someone calls closeOut. A failed closeOut never blocks the
    /// removal, and it makes no call into the account.
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
        configs[account].installId = id; // old allowlists and intents stay unusable
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

    function hashIntent(FillIntent calldata it) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(INTENT_TYPEHASH, it)));
    }

    function execute(FillIntent calldata it, bytes calldata signature) external returns (uint256 amountOut) {
        if (_locked) revert Reentered();
        _locked = true;

        Config storage c = configs[it.account];
        _checkIntent(c, it, signature);
        (Fill memory d, address pool) = _prepare(c, it);
        bytes32 key = keyOf(it.account, it.agentId);
        if (d.buy && _books[key].debt != 0) revert InDebt();

        // Book anything the client moved since the last call, at this fill's NAV.
        uint256 balBefore =
            _syncToken(key, it.account, it.agentId, d.stock, SafeCast.toUint256(d.answer), d.stockDecimals);

        amountOut = _swap(pool, it);
        if (amountOut < it.minOut) revert TooLittleOut();
        d.usdgAmount = d.buy ? it.amountIn : amountOut;
        d.stockAmount = d.buy ? amountOut : it.amountIn;
        // Exactly what the pool sent must have arrived: the ledger counts units, not promises.
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (d.buy && IERC20(d.stock).balanceOf(it.account) != balBefore + amountOut) revert PartialFill();
        d.fillFee = d.usdgAmount * fillFeeBps / 1e4;
        _settleFill(c, key, d);

        Prices memory p = pricesOf(d);
        bytes32 fillId = keccak256(abi.encode(block.chainid, address(this), it.account, it.nonce));
        // _locked blocks any reentry, so no other fill's event can come in between.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Filled(it.account, it.agentId, d.stock, pool, fillId, d, p);
        _tally(d, p);
        _publish(d, p, fillId);
        _locked = false;
    }

    /// Limits, the fill fee, the ledger entry and, on a sale, debt repayment.
    function _settleFill(Config storage c, bytes32 key, Fill memory d) private {
        uint256 answer = SafeCast.toUint256(d.answer);
        // Client protection: the fill price, fee included, is worse than NAV by at most maxSlipBps.
        uint256 navValue = navValueOf(d.stockAmount, answer, d.stockDecimals);
        if (d.buy
                ? (d.usdgAmount + d.fillFee) * 1e4 > navValue * (1e4 + c.maxSlipBps)
                : (d.usdgAmount - d.fillFee) * 1e4 < navValue * (1e4 - c.maxSlipBps)) revert WorseThanNav();
        if (d.usdgAmount < MIN_NOTIONAL) revert TooSmall();
        _spend(c, d.buy ? d.usdgAmount : Math.max(d.usdgAmount, navValue));

        if (d.fillFee != 0) _pull(d.account, burner, d.fillFee);
        if (d.buy) {
            // Cost: the worse of what the client paid (fee included) and the NAV value.
            uint256 cost = Math.max(d.usdgAmount + d.fillFee, navValueCeil(d.stockAmount, answer, d.stockDecimals));
            _bookBuy(key, d.stock, d.stockAmount, cost);
            return;
        }
        // Proceeds: the worse of what the client received (net of the fee) and the NAV value.
        uint256 net = d.usdgAmount - d.fillFee;
        _bookSell(key, d.account, d.agentId, d.stock, d.stockAmount, Math.min(net, navValue));
        Book storage b = _books[key];
        uint256 debtPaid = Math.min(b.debt, net);
        if (debtPaid != 0) {
            b.debt -= SafeCast.toUint128(debtPaid);
            b.paid += SafeCast.toUint128(debtPaid);
            _pull(d.account, b.wallet, debtPaid);
            // forge-lint: disable-next-line(reentrancy-events)
            emit DebtPaid(d.account, d.agentId, debtPaid, b.debt);
        }
    }

    function _checkIntent(Config storage c, FillIntent calldata it, bytes calldata signature) private {
        if (!c.installed) revert NotInstalled();
        if (it.installId != c.installId) revert WrongInstall();
        if (it.agentId != c.agentId) revert WrongAgent();
        if (block.timestamp > it.deadline || block.timestamp > c.expiry) revert Expired();
        if (nonceUsed[it.account][it.nonce]) revert NonceUsed();
        nonceUsed[it.account][it.nonce] = true;

        // A transfer of the agent NFT clears the wallet, and a new owner can set another.
        // Either way the client's install no longer trades.
        if (identity.getAgentWallet(it.agentId) != c.wallet) revert WalletChanged();
        if (!SignatureChecker.isValidSignatureNowCalldata(c.wallet, hashIntent(it), signature)) revert BadSignature();
    }

    function _prepare(Config storage c, FillIntent calldata it) private view returns (Fill memory d, address pool) {
        d.agentId = it.agentId;
        d.account = it.account;
        d.buy = it.tokenIn == usdg;
        if (d.buy == (it.tokenOut == usdg)) revert BadPair();
        d.stock = d.buy ? it.tokenOut : it.tokenIn;
        if (!_allowed[it.account][c.installId][d.stock]) revert StockNotAllowed();

        pool = factory.getPool(it.tokenIn, it.tokenOut, it.fee);
        if (pool == address(0)) revert NoPool();
        // forge-lint: disable-next-line(unused-return)
        (d.sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0(); // only the price is needed
        if (_devBps(d.sqrtPriceX96, it.refSqrtPriceX96) > it.maxDevBps) revert PriceMoved();

        (d.roundId, d.answer, d.updatedAt, d.stockDecimals, d.session) = _priced(d.stock);
    }

    /// The NAV of a token now, with every check a fill needs: known token, unchanged
    /// decimals, market open, fresh feed, oracle not paused, multiplier priced in.
    // Also called per token of a book; a book holds at most the client's allowed tokens.
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
        // Amounts are priced with the decimals read when the token was added (USDG: 6).
        if (IERC20Metadata(stock).decimals() != src.decimals || IERC20Metadata(usdg).decimals() != 6) {
            revert DecimalsChanged();
        }
        if (session == FillmarkFeeds.Session.Closed) revert MarketClosed();

        IAggregatorV3 feed = IAggregatorV3(src.feed);
        uint256 startedAt;
        // forge-lint: disable-next-line(unused-return)
        (roundId, answer, startedAt, updatedAt,) = feed.latestRoundData(); // answeredInRound is deprecated
        if (answer <= 0 || feed.decimals() != 8) revert BadFeed();
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > src.maxAge) revert StaleFeed();
        if (src.crypto) return (roundId, answer, updatedAt, decimals, session);
        if (IStockToken(stock).oraclePaused()) revert OraclePaused();
        if (src.multiplierInFeed) {
            // The feed answer is price x uiMultiplier. A multiplier that took effect at or
            // after the last round was observed is not in the NAV yet, so wait for the next round.
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

    // ---- ledger ----

    function keyOf(address account, uint256 agentId) public pure returns (bytes32) {
        return keccak256(abi.encode(account, agentId));
    }

    function _list(bytes32 key, address stock) private {
        if (_listed[key][stock]) return;
        _listed[key][stock] = true;
        _tokens[key].push(stock);
    }

    /// Moves matured holds and a matured outflow gain into realized.
    function _mature(bytes32 key, address stock) private {
        Book storage b = _books[key];
        Hold storage h = _holds[key][stock];
        if (h.until != 0 && h.until <= block.timestamp) {
            b.realized += SafeCast.toInt128(SafeCast.toInt256(uint256(h.gain)));
            delete _holds[key][stock];
        }
        Hold storage n = _laterHolds[key][stock];
        if (n.until != 0 && n.until <= block.timestamp) {
            b.realized += SafeCast.toInt128(SafeCast.toInt256(uint256(n.gain)));
            delete _laterHolds[key][stock];
        }
        _promote(key, stock);
        Out storage o = _outs[key][stock];
        if (o.until != 0 && o.until <= block.timestamp) {
            b.realized += SafeCast.toInt128(SafeCast.toInt256(uint256(o.gain)));
            delete _outs[key][stock];
        }
    }

    /// The end of the wait for the client's moved-out bucket that already waits `gain`
    /// until `until` and now adds `added`: the gain-weighted mean of both ends, so moving
    /// a little out again cannot push back a large gain that waits. A new gain can mature
    /// sooner by joining an older one; only the client moves units out, and that only
    /// brings its own fee forward.
    function _waitUntil(uint64 until, uint256 gain, uint256 added) private view returns (uint64) {
        uint256 end = block.timestamp + hold;
        if (until == 0) return SafeCast.toUint64(end);
        if (added == 0) return until;
        return SafeCast.toUint64(
            Math.mulDiv(uint256(until), gain, gain + added) + Math.mulDiv(end, added, gain + added, Math.Rounding.Ceil)
        );
    }

    /// Compares the tracked units with the account's balance. Missing units were moved
    /// out by the client and are booked as sold at NAV. Units coming back within `hold`
    /// are booked as bought again at NAV: a loss booked when they left is undone, and the
    /// gain waiting on them lowers their cost, as a rebuy after a sale does. Returns the
    /// balance.
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
        o.qty -= SafeCast.toUint128(r);
        o.gain -= SafeCast.toUint128(cancel); // any rest still waits
        o.loss -= SafeCast.toUint128(lossBack);
        if (o.qty == 0 && o.gain == 0) delete _outs[key][stock];
    }

    /// The later hold moves into an empty older place.
    function _promote(bytes32 key, address stock) private {
        if (_holds[key][stock].gain == 0 && _laterHolds[key][stock].gain != 0) {
            _holds[key][stock] = _laterHolds[key][stock];
            delete _laterHolds[key][stock];
        }
    }

    function _bookBuy(bytes32 key, address stock, uint256 qty, uint256 cost) private {
        _list(key, stock);
        // A rebuy within `hold` cancels the latest sales' gains first.
        uint256 left;
        (left, cost) = _cancel(_laterHolds[key][stock], qty, cost);
        (, cost) = _cancel(_holds[key][stock], left, cost);
        _promote(key, stock);
        Lot storage l = _lots[key][stock];
        l.qty += SafeCast.toUint128(qty);
        l.cost += SafeCast.toUint128(cost);
    }

    /// Cancels a hold's gain in proportion to `qty` of its units, up to `cost`, and lowers
    /// the cost by as much; any rest still waits. Returns the units and cost left.
    function _cancel(Hold storage h, uint256 qty, uint256 cost) private returns (uint256, uint256) {
        if (h.gain == 0 || qty == 0) return (qty, cost);
        uint256 matched = Math.min(qty, h.qty);
        uint256 share = qty >= h.qty ? h.gain : Math.mulDiv(h.gain, qty, h.qty);
        uint256 cancel = Math.min(share, cost);
        h.gain -= SafeCast.toUint128(cancel);
        h.qty -= SafeCast.toUint128(matched);
        if (h.gain == 0) {
            h.qty = 0;
            h.until = 0;
        }
        return (qty - matched, cost - cancel);
    }

    /// Tracked units are sold first; units the router never bought carry no PnL.
    function _bookSell(bytes32 key, address account, uint256 agentId, address stock, uint256 qty, uint256 proceeds)
        private
    {
        Lot storage l = _lots[key][stock];
        uint256 tracked = Math.min(qty, l.qty);
        if (tracked == 0) return;
        uint256 got = Math.mulDiv(proceeds, tracked, qty);
        uint256 costOut = Math.mulDiv(l.cost, tracked, l.qty, Math.Rounding.Ceil);
        l.qty -= SafeCast.toUint128(tracked);
        l.cost -= SafeCast.toUint128(costOut);
        int256 pnl = SafeCast.toInt256(got) - SafeCast.toInt256(costOut);
        if (pnl < 0) {
            _books[key].realized += SafeCast.toInt128(pnl);
        } else if (pnl > 0) {
            // The first gain waits in the older place. Later ones share the later place,
            // and each sale restarts its wait: the agent picks when it sells, so a new
            // gain never matures early by joining an older one.
            Hold storage h = _holds[key][stock].gain == 0 ? _holds[key][stock] : _laterHolds[key][stock];
            // pnl > 0 here, so the cast keeps its value.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 gain = uint256(pnl);
            h.until = SafeCast.toUint64(block.timestamp + hold);
            h.gain += SafeCast.toUint128(gain);
            h.qty += SafeCast.toUint128(tracked);
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit Booked(account, agentId, stock, pnl);
    }

    /// Fee base now: realized PnL plus open losses at NAV, after syncing every token.
    /// Reverts if a token with tracked units cannot be priced (market closed, stale feed...).
    function _base(bytes32 key, address account, uint256 agentId) private returns (int256 base) {
        address[] storage list = _tokens[key];
        uint256 openLoss = 0;
        uint256 i = 0;
        while (i < list.length) {
            address stock = list[i];
            Lot storage l = _lots[key][stock];
            _mature(key, stock);
            Out storage o = _outs[key][stock];
            // A price is needed only while units are tracked (to book a move-out and value
            // the position) or come back. A token with only a pending gain needs none.
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
                delete _lots[key][stock]; // dust cost left by rounding
                _listed[key][stock] = false;
                list[i] = list[list.length - 1];
                list.pop();
            } else {
                i++;
            }
        }
        base = int256(_books[key].realized) - SafeCast.toInt256(openLoss);
    }

    /// Charges the agent's performance fee on an installed account and collects open debt
    /// from the account's USDG. Anyone may call it; a call with no new fee writes no record.
    function settle(address account) external returns (uint256 fee) {
        if (_locked) revert Reentered();
        _locked = true;
        Config storage c = configs[account];
        if (!c.installed) revert NotInstalled();
        uint256 agentId = c.agentId;
        bytes32 key = keyOf(account, agentId);
        Book storage b = _books[key];
        int256 base = _base(key, account, agentId);
        fee = _charge(b, base);
        uint256 owed = fee + b.debt;
        uint256 pay = Math.min(owed, IERC20(usdg).balanceOf(account));
        // An account that does not pay (a hook, another implementation) owes it all: the
        // debt stops its buys, and the next sale pays it first or does not go through.
        b.debt = SafeCast.toUint128(owed);
        if (pay != 0 && _tryPull(account, b.wallet, pay)) {
            b.debt = SafeCast.toUint128(owed - pay);
            b.paid += SafeCast.toUint128(pay);
        } else {
            pay = 0;
        }
        if (fee != 0) {
            // forge-lint: disable-next-line(reentrancy-events)
            emit Settled(account, agentId, base, b.peak, fee, pay, b.debt);
            // The record is written by the client's account; one it refuses changes nothing above.
            _tryGive(agentId, account, "fillmark-agentfee", SafeCast.toInt256(fee));
        } else if (pay != 0) {
            // forge-lint: disable-next-line(reentrancy-events)
            emit DebtPaid(account, agentId, pay, b.debt);
        }
        _locked = false;
    }

    function _charge(Book storage b, int256 base) private returns (uint256 fee) {
        if (base <= b.peak) return 0;
        fee = Math.mulDiv(SafeCast.toUint256(base - b.peak), b.perfFeeBps, 1e4);
        b.peak = SafeCast.toInt128(base);
    }

    /// After the client removed the router: books every tracked unit as sold at NAV,
    /// counts every pending gain, and turns the fee into open debt (the router can no
    /// longer move the account's funds). Runs at removal when prices allow; otherwise
    /// anyone may call it once they do.
    function closeOut(address account, uint256 agentId) external returns (uint256 fee) {
        if (_locked) revert Reentered();
        _locked = true;
        Config storage c = configs[account];
        if (c.installed) {
            // onUninstall did not run (Kernel ignores its failure): the account no longer
            // has the router, so do its bookkeeping here.
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

        address[] storage list = _tokens[key];
        for (uint256 i; i < list.length; i++) {
            address stock = list[i];
            Lot storage l = _lots[key][stock];
            int256 value = 0;
            if (l.qty != 0) value = SafeCast.toInt256(_closingValue(stock, l, b.closingAt));
            b.realized += SafeCast.toInt128(
                value - SafeCast.toInt256(uint256(l.cost)) + SafeCast.toInt256(uint256(_holds[key][stock].gain))
                    + SafeCast.toInt256(uint256(_laterHolds[key][stock].gain))
                    + SafeCast.toInt256(uint256(_outs[key][stock].gain))
            );
            delete _lots[key][stock];
            delete _holds[key][stock];
            delete _laterHolds[key][stock];
            delete _outs[key][stock];
            delete _listed[key][stock];
        }
        delete _tokens[key];
        int256 base = b.realized;
        fee = _charge(b, base);
        b.debt += SafeCast.toUint128(fee);
        b.closing = false;
        b.closingAt = 0;
        openBook[account] = 0;
        // forge-lint: disable-next-line(reentrancy-events)
        emit ClosedOut(account, agentId, base, fee, b.debt);
        _locked = false;
    }

    /// NAV value of a lot for closeOut. A token that still cannot be priced STUCK_AFTER
    /// the removal (dead feed, unpriced multiplier, changed decimals, paused oracle) is
    /// valued at its cost, no gain and no loss, so it cannot keep the book open forever
    /// and block the client from installing another agent. Otherwise every fill check applies.
    // Called per token of a closing book; a book holds at most the client's allowed tokens.
    // forge-lint: disable-start(calls-loop, require-revert-in-loop)
    function _closingValue(address stock, Lot storage l, uint64 closingAt) private view returns (uint256) {
        try this.priceOf(stock) returns (uint256 answer, uint8 decimals) {
            return navValueOf(l.qty, answer, decimals);
        } catch (bytes memory reason) {
            if (block.timestamp >= closingAt + STUCK_AFTER) return l.cost;
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    // forge-lint: disable-end(calls-loop, require-revert-in-loop)

    /// The NAV a fill of `stock` would use now (8 decimals) and the token's decimals;
    /// reverts when a fill would.
    function priceOf(address stock) external view returns (uint256 answer, uint8 decimals) {
        return _nav(stock);
    }

    /// The client pays debt to an agent it removed. The account approves the router for
    /// USDG first (one batch: approve, then this call).
    function payDebt(uint256 agentId, uint256 amount) external {
        if (_locked) revert Reentered();
        Book storage b = _books[keyOf(msg.sender, agentId)];
        if (amount == 0 || amount > b.debt) revert BadAmount();
        b.debt -= SafeCast.toUint128(amount);
        b.paid += SafeCast.toUint128(amount);
        IERC20(usdg).safeTransferFrom(msg.sender, b.wallet, amount);
        emit DebtPaid(msg.sender, agentId, amount, b.debt);
    }

    // ---- views ----

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

    // ---- records (as v1) ----

    function _publish(Fill memory d, Prices memory p, bytes32 fillId) private {
        string memory ext = d.session == FillmarkFeeds.Session.Extended ? "-ext" : "";
        string memory tag2 = string.concat(feeds.tickerOf(d.stock), ":B", Strings.toString(bucketOf(d.usdgAmount)));
        _give(d.agentId, d.account, string.concat("fillmark-cost", ext), tag2, p.cost, fillId);
        _give(
            d.agentId, d.account, string.concat("fillmark-notional", ext), tag2, SafeCast.toInt256(d.usdgAmount), fillId
        );
    }

    function _give(uint256 agentId, address account, string memory tag1, string memory tag2, int256 value, bytes32 hash)
        private
    {
        bytes memory call = abi.encodeCall(
            IReputationRegistry.giveFeedback,
            (agentId, SafeCast.toInt128(value), VALUE_DECIMALS, tag1, tag2, "", "", hash)
        );
        // Single call in revert mode: the account reverts if giveFeedback fails.
        // Every entry point that reaches here holds _locked.
        // forge-lint: disable-start(unused-return)
        IERC7579Account(account)
            .executeFromExecutor(bytes32(0), abi.encodePacked(address(reputation), uint256(0), call));
        // forge-lint: disable-end(unused-return)
    }

    /// The account sends `amount` USDG to `to`.
    function _pull(address account, address to, uint256 amount) private {
        if (!_tryPull(account, to, amount)) revert PaymentFailed();
    }

    /// Whether the account sent exactly `amount` USDG to `to`. The recipient's balance is
    /// checked, not the account's answer, which any contract can fake. No return data is
    /// copied, so the account cannot spend the caller's gas on it.
    function _tryPull(address account, address to, uint256 amount) private returns (bool) {
        uint256 before = IERC20(usdg).balanceOf(to);
        bytes memory data = abi.encodeCall(
            IERC7579Account.executeFromExecutor,
            (bytes32(0), abi.encodePacked(usdg, uint256(0), abi.encodeCall(IERC20.transfer, (to, amount))))
        );
        bool ok = _tryCall(account, data, PAY_GAS);
        // Exactly the amount, as USDG moves it: anything else was not this payment.
        // forge-lint: disable-next-line(incorrect-strict-equality)
        return ok && IERC20(usdg).balanceOf(to) == before + amount;
    }

    /// The fee's feedback from the client's account, where its failure is ignored.
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

    /// Calls the account with at most `gasLimit`, copying no return data, so it can neither
    /// spend the gas the caller needs to finish nor return a large answer. The caller must
    /// leave enough gas for the whole limit, or a starved call would count as a refusal.
    function _tryCall(address account, bytes memory data, uint256 gasLimit) private returns (bool ok) {
        if (gasleft() < gasLimit + gasLimit / 63 + 10_000) revert LowGas();
        // Every entry point that reaches here holds _locked.
        assembly ("memory-safe") {
            ok := call(gasLimit, account, 0, add(data, 32), mload(data), 0, 0)
        }
    }

    function _tally(Fill memory d, Prices memory p) private {
        Stats storage t = stats[
            statsKey(d.agentId, d.account, d.stock, bucketOf(d.usdgAmount), d.session == FillmarkFeeds.Session.Extended)
        ];
        int256 ratio = p.cost * 1e6 / SafeCast.toInt256(d.usdgAmount);
        if (ratio < type(int64).min) ratio = type(int64).min; // only a fill far better than NAV
        if (t.fills == 0 || ratio > t.worst) t.worst = SafeCast.toInt64(ratio);
        t.fills += 1;
        t.notional += SafeCast.toUint128(d.usdgAmount);
        t.sumCost += SafeCast.toInt128(p.cost);
    }

    function statsOf(uint256 agentId, address account, address stock) external view returns (Stats memory s) {
        for (uint8 b = 1; b <= 7; b++) {
            for (uint256 e; e < 2; e++) {
                Stats storage t = stats[statsKey(agentId, account, stock, b, e == 1)];
                if (t.fills == 0) continue;
                if (s.fills == 0 || t.worst > s.worst) s.worst = t.worst;
                s.fills += t.fills;
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

    /// USDG value (6 decimals) of `amount` token units at an 8-decimal USD price.
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

    function _spend(Config storage c, uint256 usdgValue) private {
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 today = uint64(block.timestamp / 1 days); // fits until year 5e16
        if (c.day != today) {
            c.day = today;
            c.spentToday = 0;
        }
        if (usdgValue > c.maxPerTrade) revert OverTradeLimit();
        c.spentToday += SafeCast.toUint128(usdgValue);
        if (c.spentToday > c.dailyLimit) revert OverDailyLimit();
    }

    function _swap(address pool, FillIntent calldata it) private returns (uint256 amountOut) {
        bool zeroForOne = it.tokenIn < it.tokenOut;
        uint160 limit = it.sqrtPriceLimitX96;
        if (limit == 0) limit = zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;
        _pool = pool;
        _account = it.account;
        _tokenIn = it.tokenIn;
        _amountIn = it.amountIn;
        // execute() holds _locked; the pool calls back only uniswapV3SwapCallback.
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

    function _devBps(uint160 sqrtA, uint160 sqrtRef) private pure returns (uint256) {
        if (sqrtRef == 0) return type(uint256).max;
        uint256 r = Math.mulDiv(sqrtA, 1e9, sqrtRef);
        uint256 ratio = r * r / 1e14;
        return ratio > 1e4 ? ratio - 1e4 : 1e4 - ratio;
    }
}
