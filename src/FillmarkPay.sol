// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FillmarkBurner} from "./FillmarkBurner.sol";
import {FillmarkRouterV3} from "./FillmarkRouterV3.sol";
import {IV4PoolManager, IV4PositionManager, IV4UnlockCallback} from "./interfaces/ExternalV2.sol";
import {IIdentityPay} from "./interfaces/ExternalPay.sol";

/// Pays an ERC-8004 agent from the client account it trades for. The agent earns its
/// rate on the volume router v3 recorded since the agreement opened, cut in a straight
/// line by the recorded execution cost: all of it at an average cost of zero or better,
/// none at zeroAtBps. The client pays in USDG; this contract buys $FILLMARK with it in
/// the burner's Pons pool and sends 90% to the agent wallet pinned in the router, 10% to
/// 0xdEaD. No owner, no upgrade, and it holds nothing between transactions.
contract FillmarkPay is IV4UnlockCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint16 public constant MAX_RATE_BPS = 5;
    uint16 public constant MAX_ZERO_AT_BPS = 1_000;
    uint256 public constant BURN_SHARE_BPS = 1_000; // of the $FILLMARK bought
    // All buys in one block together: at most 0.1% of the locked position's USDG side. On
    // Robinhood Chain block.number is Ethereum's block number, so this is about 12 seconds.
    uint256 public constant BLOCK_BUY_BPS = 10;
    uint256 public constant MAX_TOKENS = 32;
    uint160 private constant MIN_SQRT_PRICE = 4295128739;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    FillmarkRouterV3 public immutable router;
    FillmarkBurner public immutable burner;
    IIdentityPay public immutable identity;
    address public immutable usdg;
    IV4PoolManager public immutable poolManager;
    IV4PositionManager public immutable positionManager;

    struct Terms {
        uint16 rateBps;
        uint16 minZeroAtBps; // 0 = never set
    }

    struct Agreement {
        uint16 rateBps;
        uint16 zeroAtBps;
        bool open;
        uint128 paid; // USDG paid since open
        uint128 carry; // USDG owed from an earlier agreement with the same agent
    }

    /// A tracked token and its router stats when tracking began.
    struct Base {
        address token;
        uint128 notional;
        int128 sumCost;
    }

    enum Wait {
        None,
        NotOpen,
        NothingDue,
        NoToken, // the burner has no $FILLMARK pool yet
        BurnThisBlock, // the burner bought in this block
        BlockBudget,
        Balance,
        Allowance
    }

    struct Due {
        uint256 accrued; // what the agent has earned since open
        uint256 paid;
        uint256 carry;
        uint256 due; // accrued + carry - paid, at least 0
        uint256 payNow; // what settle would pay in this block
        Wait wait; // why payNow is below due
    }

    mapping(uint256 => Terms) private _terms;
    mapping(bytes32 => Agreement) private _agreements;
    mapping(bytes32 => Base[]) private _bases;
    // The block of the last buy, the budget fixed at its first buy, and what was bought in it.
    uint64 private _buyBlock;
    uint96 private _blockCap;
    uint96 private _boughtInBlock;

    event RateSet(uint256 indexed agentId, uint16 rateBps, uint16 minZeroAtBps);
    event Opened(address indexed account, uint256 indexed agentId, uint16 rateBps, uint16 zeroAtBps, address[] tokens);
    event Tracked(address indexed account, uint256 indexed agentId, address indexed token);
    event Settled(
        address indexed account,
        uint256 indexed agentId,
        uint256 usdgPaid,
        uint256 fillmarkToAgent,
        uint256 fillmarkBurned,
        uint256 unpaid
    );
    event Closed(address indexed account, uint256 indexed agentId, uint256 carry);

    error BadConfig();
    error NotAgent();
    error BadTerms();
    error NoTerms();
    error RateChanged();
    error BadZeroAt();
    error NeverInstalled();
    error AlreadyOpen();
    error NotOpen();
    error NotAllowed(address token);
    error AlreadyTracked(address token);
    error TooManyTokens();
    error NotAccountOrAgent();
    error NotAgentWallet();
    error PriceMoved();
    error NotPoolManager();
    error BadSwap();
    error BadSettle();

    constructor(FillmarkRouterV3 router_) {
        router = router_;
        burner = FillmarkBurner(router_.burner());
        identity = IIdentityPay(address(router_.identity()));
        usdg = router_.usdg();
        poolManager = burner.poolManager();
        positionManager = burner.positionManager();
        if (
            address(identity) == address(0) || usdg == address(0) || burner.usdg() != usdg
                || address(poolManager) == address(0) || address(positionManager) == address(0)
        ) revert BadConfig();
    }

    // ---- agents ----

    /// New terms apply to agreements opened after this call only.
    function setRate(uint256 agentId, uint16 rateBps, uint16 minZeroAtBps) external {
        if (msg.sender != identity.getAgentWallet(agentId) && msg.sender != identity.ownerOf(agentId)) {
            revert NotAgent();
        }
        if (rateBps > MAX_RATE_BPS || minZeroAtBps == 0 || minZeroAtBps > MAX_ZERO_AT_BPS) revert BadTerms();
        _terms[agentId] = Terms(rateBps, minZeroAtBps);
        emit RateSet(agentId, rateBps, minZeroAtBps);
    }

    // ---- client accounts ----

    /// Called by the client account. rateSeen is the rate the client was shown.
    function open(uint256 agentId, uint16 rateSeen, uint16 zeroAtBps, address[] calldata tokens) external nonReentrant {
        Terms memory t = _terms[agentId];
        if (t.minZeroAtBps == 0) revert NoTerms();
        if (t.rateBps != rateSeen) revert RateChanged();
        if (zeroAtBps < t.minZeroAtBps || zeroAtBps > MAX_ZERO_AT_BPS) revert BadZeroAt();
        if (router.bookOf(msg.sender, agentId).wallet == address(0)) revert NeverInstalled();
        bytes32 key = keyOf(msg.sender, agentId);
        Agreement storage a = _agreements[key];
        if (a.open) revert AlreadyOpen();
        if (tokens.length > MAX_TOKENS) revert TooManyTokens();

        a.rateBps = t.rateBps;
        a.zeroAtBps = zeroAtBps;
        a.open = true;
        // At most 32 tokens; one bad token stops the whole open.
        // forge-lint: disable-start(calls-loop, require-revert-in-loop)
        for (uint256 i; i < tokens.length; i++) {
            for (uint256 j; j < i; j++) {
                if (tokens[j] == tokens[i]) revert AlreadyTracked(tokens[i]);
            }
            _addBase(key, msg.sender, agentId, tokens[i]);
        }
        // forge-lint: disable-end(calls-loop, require-revert-in-loop)
        emit Opened(msg.sender, agentId, t.rateBps, zeroAtBps, tokens);
    }

    /// Adds a token the client allows in the router; fills before this call are never billed.
    function track(address account, uint256 agentId, address token) external nonReentrant {
        bytes32 key = keyOf(account, agentId);
        if (!_agreements[key].open) revert NotOpen();
        if (msg.sender != account && msg.sender != router.bookOf(account, agentId).wallet) {
            revert NotAccountOrAgent();
        }
        Base[] storage list = _bases[key];
        if (list.length >= MAX_TOKENS) revert TooManyTokens();
        for (uint256 i; i < list.length; i++) {
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (list[i].token == token) revert AlreadyTracked(token);
        }
        _addBase(key, account, agentId, token);
        emit Tracked(account, agentId, token);
    }

    /// Ends the agreement without a swap. What is still owed is kept as carry and billed
    /// if the account opens an agreement with the same agent again.
    function close(uint256 agentId) external nonReentrant {
        bytes32 key = keyOf(msg.sender, agentId);
        Agreement storage a = _agreements[key];
        if (!a.open) revert NotOpen();
        uint256 owed = _accrued(msg.sender, agentId, a, key) + a.carry;
        uint256 carry = owed > a.paid ? owed - a.paid : 0;
        _agreements[key] = Agreement(0, 0, false, 0, SafeCast.toUint128(carry));
        delete _bases[key];
        // After view calls to the router only.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Closed(msg.sender, agentId, carry);
    }

    // ---- payment ----

    /// Called by the agent wallet pinned in the router, the one paid: it bears the pool price,
    /// so it decides when to buy and sets the least $FILLMARK it must receive per USDG paid
    /// (wei per 1e6 units, after the 10% burn).
    /// Pays what is due now, within the block budget and the account's USDG balance and
    /// allowance; the rest waits. Returns 0 without a swap when nothing can be paid.
    function settle(address account, uint256 agentId, uint256 minReceivedPerUsdg)
        external
        nonReentrant
        returns (uint256 usdgPaid)
    {
        address wallet = router.bookOf(account, agentId).wallet;
        if (msg.sender != wallet) revert NotAgentWallet();
        Due memory d = _due(account, agentId);
        if (d.wait == Wait.NotOpen) revert NotOpen();
        usdgPaid = d.payNow;
        if (usdgPaid == 0) return 0;

        Agreement storage a = _agreements[keyOf(account, agentId)];
        a.paid = SafeCast.toUint128(a.paid + usdgPaid);
        if (_buyBlock != block.number) {
            _buyBlock = SafeCast.toUint64(block.number);
            _blockCap = SafeCast.toUint96(_capNow());
            _boughtInBlock = 0;
        }
        _boughtInBlock += SafeCast.toUint96(usdgPaid);

        (uint256 out, uint256 burned) = abi.decode(
            poolManager.unlock(abi.encode(account, wallet, usdgPaid, minReceivedPerUsdg)), (uint256, uint256)
        );
        // Effects are done; the pool manager calls back only unlockCallback.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Settled(account, agentId, usdgPaid, out - burned, burned, d.due - usdgPaid);
    }

    /// Buys $FILLMARK with exactly `amount` USDG taken from the account.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_reentrancyGuardEntered()) revert NotPoolManager();
        (address account, address wallet, uint256 amount, uint256 minReceivedPerUsdg) =
            abi.decode(data, (address, address, uint256, uint256));
        IV4PoolManager.PoolKey memory key = burner.poolKey();
        address token = burner.token();
        bool usdgIs0 = key.currency0 == usdg;
        int256 delta = poolManager.swap(
            key,
            IV4PoolManager.SwapParams({
                zeroForOne: usdgIs0,
                amountSpecified: -SafeCast.toInt256(amount),
                sqrtPriceLimitX96: usdgIs0 ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );
        // forge-lint: disable-next-line(unsafe-typecast)
        int128 amount0 = int128(delta >> 128);
        // forge-lint: disable-next-line(unsafe-typecast)
        int128 amount1 = int128(delta);
        (int128 paid, int128 got) = usdgIs0 ? (amount0, amount1) : (amount1, amount0);
        if (-int256(paid) != SafeCast.toInt256(amount) || got <= 0) revert BadSwap();
        uint256 out = SafeCast.toUint256(int256(got));
        uint256 burned = out * BURN_SHARE_BPS / 1e4;
        if (out - burned < Math.mulDiv(amount, minReceivedPerUsdg, 1e6)) revert PriceMoved();

        poolManager.sync(usdg);
        // Only from settle, for the amount due; the account approved this contract for it.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        IERC20(usdg).safeTransferFrom(account, address(poolManager), amount);
        if (poolManager.settle() != amount) revert BadSettle();
        if (burned != 0) poolManager.take(token, DEAD, burned);
        poolManager.take(token, wallet, out - burned);
        return abi.encode(out, burned);
    }

    // ---- views ----

    function dueOf(address account, uint256 agentId) external view returns (Due memory) {
        return _due(account, agentId);
    }

    function termsOf(uint256 agentId) external view returns (Terms memory) {
        return _terms[agentId];
    }

    function agreementOf(address account, uint256 agentId) external view returns (Agreement memory) {
        return _agreements[keyOf(account, agentId)];
    }

    function tokensOf(address account, uint256 agentId) external view returns (Base[] memory) {
        return _bases[keyOf(account, agentId)];
    }

    /// USDG Fillmark Pay may still spend in this block, across all agreements. The budget
    /// is fixed at the block's first buy, so buys in the block do not raise it.
    function blockBudgetLeft() public view returns (uint256) {
        if (burner.token() == address(0)) return 0;
        if (_buyBlock != block.number) return _capNow();
        return _blockCap > _boughtInBlock ? _blockCap - _boughtInBlock : 0;
    }

    function keyOf(address account, uint256 agentId) public pure returns (bytes32) {
        return keccak256(abi.encode(account, agentId));
    }

    // ---- internal ----

    /// BLOCK_BUY_BPS of the locked full-range position's USDG amount at the current price,
    /// read as the burner reads it.
    function _capNow() private view returns (uint256) {
        uint256 liquidity = positionManager.getPositionLiquidity(burner.positionId());
        uint160 sqrtPrice = burner.sqrtPriceX96();
        uint256 side = burner.poolKey().currency1 == usdg
            ? Math.mulDiv(liquidity, sqrtPrice, 1 << 96)
            : Math.mulDiv(liquidity, 1 << 96, sqrtPrice);
        return side * BLOCK_BUY_BPS / 1e4;
    }

    // Called in open's loop.
    // forge-lint: disable-start(calls-loop, require-revert-in-loop)
    function _addBase(bytes32 key, address account, uint256 agentId, address token) private {
        if (!router.isAllowed(account, token)) revert NotAllowed(token);
        FillmarkRouterV3.Stats memory s = router.statsOf(agentId, account, token);
        _bases[key].push(Base(token, s.notional, s.sumCost));
    }

    // forge-lint: disable-end(calls-loop, require-revert-in-loop)

    /// rate x volume, less rate x cost / zeroAtBps, over every tracked token since tracking
    /// began; the rate part rounds down and the cut rounds up.
    function _accrued(address account, uint256 agentId, Agreement storage a, bytes32 key)
        private
        view
        returns (uint256)
    {
        Base[] storage list = _bases[key];
        uint256 notional = 0;
        int256 cost = 0;
        for (uint256 i; i < list.length; i++) {
            Base storage b = list[i];
            // forge-lint: disable-next-line(calls-loop)
            FillmarkRouterV3.Stats memory s = router.statsOf(agentId, account, b.token);
            notional += s.notional - b.notional;
            cost += int256(s.sumCost) - b.sumCost;
        }
        uint256 full = notional * a.rateBps / 1e4;
        if (cost <= 0) return full;
        uint256 cut = Math.ceilDiv(SafeCast.toUint256(cost) * a.rateBps, a.zeroAtBps);
        return full > cut ? full - cut : 0;
    }

    function _due(address account, uint256 agentId) private view returns (Due memory d) {
        bytes32 key = keyOf(account, agentId);
        Agreement storage a = _agreements[key];
        d.carry = a.carry;
        if (!a.open) {
            d.wait = Wait.NotOpen;
            return d;
        }
        d.accrued = _accrued(account, agentId, a, key);
        d.paid = a.paid;
        uint256 owed = d.accrued + d.carry;
        d.due = owed > d.paid ? owed - d.paid : 0;
        if (d.due == 0) {
            d.wait = Wait.NothingDue;
            return d;
        }
        if (burner.token() == address(0)) {
            d.wait = Wait.NoToken;
            return d;
        }
        if (burner.lastBurn() == block.timestamp) {
            d.wait = Wait.BurnThisBlock;
            return d;
        }
        d.payNow = d.due;
        uint256 left = blockBudgetLeft();
        if (left < d.payNow) (d.payNow, d.wait) = (left, Wait.BlockBudget);
        uint256 balance = IERC20(usdg).balanceOf(account);
        if (balance < d.payNow) (d.payNow, d.wait) = (balance, Wait.Balance);
        uint256 allowance = IERC20(usdg).allowance(account, address(this));
        if (allowance < d.payNow) (d.payNow, d.wait) = (allowance, Wait.Allowance);
    }
}
