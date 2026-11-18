// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
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

/// ERC-7579 executor module. An ERC-8004 agent signs a FillIntent; anyone can
/// submit it. The router swaps on an official Uniswap v3 pool with the client
/// account as recipient and makes the account pay the pool in the callback.
/// Every fill must land within the client's maxSlipBps of the Chainlink NAV, so a
/// fill can only happen while the feed is fresh and, for stock tokens, while the
/// market is open and the oracle is not paused. Crypto tokens trade at any hour.
/// In the same transaction the client's own account writes
/// the fill's scores to the ERC-8004 Reputation Registry, so each client's record
/// sits under its own address and readers choose which clients they trust. If the
/// feedback cannot be written, the fill reverts. The router never holds tokens and
/// the agent never holds any key or permission on the account.
contract FillmarkRouter is EIP712 {
    uint256 private constant MODULE_TYPE_EXECUTOR = 2;
    uint16 public constant MAX_SLIP_LIMIT_BPS = 1_000;
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
        uint16 maxSlipBps; // worst allowed fill vs NAV
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
        uint256 usdgAmount;
        uint256 stockAmount;
        uint8 stockDecimals;
        uint160 sqrtPriceX96; // pool price before the swap
        uint80 roundId;
        int256 answer;
        uint256 updatedAt;
        FillmarkFeeds.Session session;
    }

    /// Prices are 8 decimals, USDG per whole token ("stock" below means any priced
    /// token: a stock token or a crypto token, with 0 to 18 decimals). Deltas are
    /// bps * 100. Cost is USDG (6
    /// decimals) paid over the NAV value of the token bought, or the NAV value of the
    /// token sold over the USDG received. Positive means worse for the client.
    struct Prices {
        uint256 nav;
        uint256 spot;
        uint256 fill;
        int256 shortfall; // fill vs NAV
        int256 premium; // spot vs NAV
        int256 impact; // fill vs spot
        int256 cost; // USDG vs NAV value
    }

    /// The score is sumCost / notional: cost weighted by size, so a fill can only
    /// move it by money that really changed hands. The agent controls volume, so
    /// cheap round trips can dilute the ratio; worst and sumCost cannot be diluted.
    struct Stats {
        uint32 fills;
        uint128 notional; // USDG, 6 decimals
        int64 worst; // highest cost / notional of a single fill, bps * 100
        int128 sumCost; // USDG, 6 decimals
    }

    IIdentityRegistry public immutable identity;
    IReputationRegistry public immutable reputation;
    IUniswapV3Factory public immutable factory;
    address public immutable usdg;
    FillmarkFeeds public immutable feeds;

    mapping(address => Config) public configs;
    mapping(address => mapping(uint64 => mapping(address => bool))) private _allowed;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    /// Totals per (agent, client account, stock, bucket, session), written only here.
    /// A client can also write feedback with Fillmark's tags by hand, or revoke
    /// entries; these totals are what the router itself recorded.
    mapping(bytes32 => Stats) public stats;

    // Set only while a swap is running.
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
        uint128 maxPerTrade,
        uint128 dailyLimit,
        uint64 expiry
    );
    event Uninstalled(address indexed account);
    /// fillId = keccak256(abi.encode(chainid, router, account, nonce)), also the feedbackHash
    /// of the fill's two registry entries.
    event Filled(
        address indexed account,
        uint256 indexed agentId,
        address indexed stock,
        address pool,
        bytes32 fillId,
        Fill fill,
        Prices prices
    );

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

    constructor(
        IIdentityRegistry identity_,
        IReputationRegistry reputation_,
        IUniswapV3Factory factory_,
        address usdg_,
        FillmarkFeeds feeds_
    ) EIP712("Fillmark", "1") {
        if (
            address(identity_) == address(0) || address(reputation_) == address(0) || address(factory_) == address(0)
                || usdg_ == address(0) || address(feeds_) == address(0)
        ) revert BadConfig();
        if (IERC20Metadata(usdg_).decimals() != 6) revert BadConfig();
        identity = identity_;
        reputation = reputation_;
        factory = factory_;
        usdg = usdg_;
        feeds = feeds_;
    }

    // ---- ERC-7579 module ----

    /// data = abi.encode(agentId, maxPerTrade, dailyLimit, expiry, maxSlipBps, stocks)
    function onInstall(bytes calldata data) external payable {
        Config storage c = configs[msg.sender];
        if (c.installed) revert AlreadyInstalled();
        (
            uint256 agentId,
            uint128 maxPerTrade,
            uint128 dailyLimit,
            uint64 expiry,
            uint16 maxSlipBps,
            address[] memory stocks
        ) = abi.decode(data, (uint256, uint128, uint128, uint64, uint16, address[]));
        if (maxSlipBps == 0 || maxSlipBps > MAX_SLIP_LIMIT_BPS || expiry <= block.timestamp) revert BadConfig();
        address wallet = identity.getAgentWallet(agentId);
        if (wallet == address(0)) revert BadConfig();

        uint64 id = c.installId + 1;
        configs[msg.sender] = Config({
            agentId: agentId,
            wallet: wallet,
            maxSlipBps: maxSlipBps,
            expiry: expiry,
            installId: id,
            installed: true,
            maxPerTrade: maxPerTrade,
            dailyLimit: dailyLimit,
            spentToday: 0,
            day: 0
        });
        for (uint256 i; i < stocks.length; i++) {
            // The client's own list: one unknown token rejects the whole install.
            // forge-lint: disable-next-line(calls-loop, require-revert-in-loop)
            if (feeds.feedOf(stocks[i]) == address(0)) revert UnknownStock();
            _allowed[msg.sender][id][stocks[i]] = true;
        }
        emit Installed(msg.sender, agentId, wallet, id, maxSlipBps, maxPerTrade, dailyLimit, expiry);
    }

    function onUninstall(bytes calldata) external payable {
        Config storage c = configs[msg.sender];
        if (!c.installed) revert NotInstalled();
        uint64 id = c.installId;
        delete configs[msg.sender];
        configs[msg.sender].installId = id; // old allowlists and intents stay unusable
        emit Uninstalled(msg.sender);
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

        amountOut = _swap(pool, it);
        if (amountOut < it.minOut) revert TooLittleOut();
        d.usdgAmount = d.buy ? it.amountIn : amountOut;
        d.stockAmount = d.buy ? amountOut : it.amountIn;

        // Client protection: the fill price can be worse than NAV by at most maxSlipBps.
        uint256 navValue = navValueOf(d.stockAmount, SafeCast.toUint256(d.answer), d.stockDecimals);
        if (d.buy
                ? d.usdgAmount * 1e4 > navValue * (1e4 + c.maxSlipBps)
                : d.usdgAmount * 1e4 < navValue * (1e4 - c.maxSlipBps)) revert WorseThanNav();
        if (d.usdgAmount < MIN_NOTIONAL) revert TooSmall();
        _spend(c, d.buy ? d.usdgAmount : Math.max(d.usdgAmount, navValue));

        Prices memory p = pricesOf(d);
        bytes32 fillId = keccak256(abi.encode(block.chainid, address(this), it.account, it.nonce));
        // _locked blocks any reentry, so no other fill's event can come in between.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Filled(it.account, it.agentId, d.stock, pool, fillId, d, p);
        _tally(d, p);
        _publish(d, p, fillId);
        _locked = false;
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
        FillmarkFeeds.Source memory src = feeds.sourceOf(d.stock, block.timestamp);
        d.session = src.session;
        d.stockDecimals = src.decimals;
        // Amounts are priced with the decimals read when the token was added (USDG: 6).
        // A token whose decimals change stops trading for good: feeds are add-only.
        if (IERC20Metadata(d.stock).decimals() != src.decimals || IERC20Metadata(usdg).decimals() != 6) {
            revert DecimalsChanged();
        }
        if (d.session == FillmarkFeeds.Session.Closed) revert MarketClosed();

        pool = factory.getPool(it.tokenIn, it.tokenOut, it.fee);
        if (pool == address(0)) revert NoPool();
        // forge-lint: disable-next-line(unused-return)
        (d.sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0(); // only the price is needed
        if (_devBps(d.sqrtPriceX96, it.refSqrtPriceX96) > it.maxDevBps) revert PriceMoved();

        IAggregatorV3 feed = IAggregatorV3(src.feed);
        uint256 startedAt;
        // forge-lint: disable-next-line(unused-return)
        (d.roundId, d.answer, startedAt, d.updatedAt,) = feed.latestRoundData(); // answeredInRound is deprecated
        if (d.answer <= 0 || feed.decimals() != 8) revert BadFeed();
        if (d.updatedAt > block.timestamp || block.timestamp - d.updatedAt > src.maxAge) revert StaleFeed();
        if (src.crypto) return (d, pool);
        if (IStockToken(d.stock).oraclePaused()) revert OraclePaused();
        if (src.multiplierInFeed) {
            // The feed answer is price x uiMultiplier. A multiplier that took effect at or
            // after the last round was observed is not in the NAV yet, so wait for the next round.
            uint256 effectiveAt = IStockToken(d.stock).effectiveAt();
            if (effectiveAt >= startedAt && effectiveAt <= block.timestamp) revert MultiplierNotPriced();
        } else if (IStockToken(d.stock).uiMultiplier() != 1e18) {
            // The feed prices the underlying alone, which is the token's NAV only at 1.
            revert MultiplierNotPriced();
        }
    }

    /// The client's account writes two feedback entries about the agent: the fill's
    /// cost and its notional, both in USDG. Over any set of fills, mean cost / mean
    /// notional from getSummary is the size-weighted cost. Tag2 is "<ticker>:B<bucket>";
    /// extended-session fills get a "-ext" tag1. Kernel reverts the whole fill if a
    /// call fails.
    function _publish(Fill memory d, Prices memory p, bytes32 fillId) private {
        string memory ext = d.session == FillmarkFeeds.Session.Extended ? "-ext" : "";
        string memory tag2 = string.concat(feeds.tickerOf(d.stock), ":B", Strings.toString(bucketOf(d.usdgAmount)));
        _give(d, string.concat("fillmark-cost", ext), tag2, p.cost, fillId);
        _give(d, string.concat("fillmark-notional", ext), tag2, SafeCast.toInt256(d.usdgAmount), fillId);
    }

    function _give(Fill memory d, string memory tag1, string memory tag2, int256 value, bytes32 fillId) private {
        bytes memory call = abi.encodeCall(
            IReputationRegistry.giveFeedback,
            (d.agentId, SafeCast.toInt128(value), VALUE_DECIMALS, tag1, tag2, "", "", fillId)
        );
        // Single call in revert mode: the account reverts if giveFeedback fails.
        // forge-lint: disable-start(unused-return)
        IERC7579Account(d.account)
            .executeFromExecutor(bytes32(0), abi.encodePacked(address(reputation), uint256(0), call));
        // forge-lint: disable-end(unused-return)
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

    /// Totals for one agent, client account and stock over every bucket and session:
    /// the read path for scores (registry getSummary walks every entry and stops
    /// fitting in one call for busy clients).
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

    /// Pool spot price as USDG per whole token, 8 decimals (same scale as the feed).
    /// USDG has 6 decimals, the token `stockDecimals` (at most 18).
    function spotPrice(uint160 sqrtPriceX96, bool stockIsToken0, uint8 stockDecimals) public pure returns (uint256) {
        uint256 e = uint256(stockDecimals) + 2;
        if (stockIsToken0) {
            return Math.mulDiv(Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 96), 10 ** e, 1 << 96);
        }
        // Split the scale so the first product stays far below 2**256.
        return Math.mulDiv(Math.mulDiv(1 << 192, 10 ** (e / 2), sqrtPriceX96), 10 ** (e - e / 2), sqrtPriceX96);
    }

    /// 10 ** (token decimals - USDG decimals + price decimals) = 10 ** (decimals + 2).
    function _scale(uint8 stockDecimals) private pure returns (uint256) {
        return 10 ** (uint256(stockDecimals) + 2);
    }

    /// Size buckets by USDG amount: B1 from $10, then $30, $100, $300, $1,000,
    /// $3,000, and B7 from $10,000. 0 below $10 (never executed).
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

    /// (a - b) / b in bps * 100.
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
        (int256 amount0, int256 amount1) =
            IUniswapV3Pool(pool).swap(it.account, zeroForOne, SafeCast.toInt256(it.amountIn), limit, "");
        _pool = address(0);
        (int256 paid, int256 received) = zeroForOne ? (amount0, amount1) : (amount1, amount0);
        if (paid != SafeCast.toInt256(it.amountIn) || received > 0) revert PartialFill();
        amountOut = SafeCast.toUint256(-received);
    }

    /// Called by the pool during the swap: the account pays exactly what the pool asks.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != _pool || msg.sender == address(0)) revert BadCallback();
        int256 delta = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (delta <= 0 || SafeCast.toUint256(delta) != _amountIn) revert PartialFill();
        bytes[] memory ret = IERC7579Account(_account)
            .executeFromExecutor(
                bytes32(0), // single call, revert on failure
                abi.encodePacked(_tokenIn, uint256(0), abi.encodeCall(IERC20.transfer, (msg.sender, _amountIn)))
            );
        if (ret.length != 1 || (ret[0].length != 0 && !abi.decode(ret[0], (bool)))) revert PaymentFailed();
    }

    /// Distance between two sqrt prices, as price deviation in bps.
    function _devBps(uint160 sqrtA, uint160 sqrtRef) private pure returns (uint256) {
        if (sqrtRef == 0) return type(uint256).max;
        uint256 r = Math.mulDiv(sqrtA, 1e9, sqrtRef);
        uint256 ratio = r * r / 1e14; // price ratio, 1e4 = equal
        return ratio > 1e4 ? ratio - 1e4 : 1e4 - ratio;
    }
}
