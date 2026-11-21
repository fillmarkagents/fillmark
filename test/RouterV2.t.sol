// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ForkBase, IIdentity, IReputation, IStockAdmin} from "./ForkBase.sol";
import {FillmarkFeeds} from "../src/FillmarkFeeds.sol";
import {FillmarkRouterV2} from "../src/FillmarkRouterV2.sol";
import {
    IAggregatorV3,
    IIdentityRegistry,
    IReputationRegistry,
    IUniswapV3Factory,
    IUniswapV3Pool
} from "../src/interfaces/External.sol";

interface IKernelV2 {
    function initialize(
        bytes21 rootValidator,
        address hook,
        bytes calldata validatorData,
        bytes calldata hookData,
        bytes[] calldata initConfig
    ) external;
    function installModule(uint256 moduleType, address module, bytes calldata initData) external payable;
    function uninstallModule(uint256 moduleType, address module, bytes calldata deInitData) external payable;
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
}

interface IKernelFactoryV2 {
    function createAccount(bytes calldata data, bytes32 salt) external payable returns (address);
}

struct PackedOp {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPointV2 {
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function getUserOpHash(PackedOp calldata op) external view returns (bytes32);
    function handleOps(PackedOp[] calldata ops, address payable beneficiary) external;
}

interface IPoolMint {
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256, uint256);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 limit, bytes calldata data)
        external
        returns (int256, int256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// Fork tests of router v2 on Robinhood Chain mainnet: real ERC-8004 registries,
/// Uniswap v3 pools, Chainlink feeds, Robinhood stock tokens, USDG, Kernel v3.1 accounts
/// and EntryPoint v0.7. No mocks.
///
/// Stock tests need an open market and fresh stock feeds. FILLMARK_TEST_ANYTIME=1 runs
/// them outside market hours for development: the test's own calendar is open all week
/// and stock feeds may be up to 25 hours old. The release run never sets it.
contract RouterV2ForkTest is ForkBase {
    bytes32 constant USER_OP_EVENT =
        keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
    bytes32 constant USER_OP_REVERT = keccak256("UserOperationRevertReason(bytes32,address,uint256,bytes)");

    uint16 constant SLIP_BPS = 200;
    uint16 constant PERF_BPS = 2_000; // 20%
    // The release deploys 7 days; tests use the minimum so the fork's feeds stay fresh.
    uint64 constant HOLD = 1 hours;
    address constant TSLA_POOL_100 = 0x7868622Ff2C3b1B6C8acb15fE0bDAEBF043DDa48; // TSLA/USDG 0.01%, nearly empty

    FillmarkFeeds feeds;
    FillmarkRouterV2 router;
    address guardian = makeAddr("guardian");
    address burner = makeAddr("burner");
    address timelock = makeAddr("timelock");
    uint32 stockMaxAge = 6 hours;

    address agent;
    uint256 agentKey;
    address owner;
    uint256 ownerKey;
    uint256 agentId;
    address account;
    uint256 nonce;
    uint16 slip = SLIP_BPS;
    uint16 perf = PERF_BPS;
    // The crypto asset whose real Chainlink round the gain tests replay (FILLMARK_ROUND_ASSET).
    address A = WETH;
    address AF = ETH_FEED;
    uint8 AD = 18;

    function setUp() public {
        _fork();
        bool anytime = vm.envOr("FILLMARK_TEST_ANYTIME", false);
        if (keccak256(bytes(vm.envOr("FILLMARK_ROUND_ASSET", string("WETH")))) == keccak256("CBBTC")) {
            (A, AF, AD) = (CBBTC, CBBTC_FEED, 8);
        }
        if (anytime) stockMaxAge = 25 hours;
        feeds = new FillmarkFeeds(address(this), guardian);
        feeds.addStock(TSLA, TSLA_FEED, stockMaxAge, true);
        feeds.addStock(NVDA, NVDA_FEED, stockMaxAge, true);
        feeds.addCrypto(WETH, ETH_FEED, ETH_MAX_AGE);
        feeds.addCrypto(CBBTC, CBBTC_FEED, CBBTC_MAX_AGE);
        // Regular 14:30-21:00 UTC; the 24/5 week from Mon 01:00 to Sat 01:00 UTC (EST),
        // or the whole week in anytime mode.
        if (anytime) feeds.addPeriod(FillmarkFeeds.Period(uint64(vm.getBlockTimestamp()), 52200, 75600, 0, 7 days));
        else feeds.addPeriod(FillmarkFeeds.Period(uint64(vm.getBlockTimestamp()), 52200, 75600, 90000, 522000));
        assertTrue(
            feeds.sessionAt(vm.getBlockTimestamp()) != FillmarkFeeds.Session.Closed,
            "fork block is outside market hours: set FILLMARK_FORK_BLOCK"
        );
        _assertFresh(TSLA_FEED, stockMaxAge);
        _assertFresh(NVDA_FEED, stockMaxAge);
        _assertFresh(ETH_FEED, ETH_MAX_AGE);
        _assertFresh(CBBTC_FEED, CBBTC_MAX_AGE);

        router = new FillmarkRouterV2(
            IIdentityRegistry(IDENTITY),
            IReputationRegistry(REPUTATION),
            IUniswapV3Factory(FACTORY),
            USDG,
            feeds,
            burner,
            timelock,
            3,
            HOLD
        );

        (agent, agentKey) = _key("agent");
        (owner, ownerKey) = _key("owner");
        vm.prank(agent);
        agentId = IIdentity(IDENTITY).register("");

        account = _createAccount(2_000e6, 20_000e6, _stocks(), 1);
        deal(USDG, account, 50_000e6);
    }

    // ---- helpers ----

    function _assertFresh(address feed, uint256 maxAge) internal view {
        (,,, uint256 updatedAt,) = IAggregatorV3(feed).latestRoundData();
        assertLe(vm.getBlockTimestamp() - updatedAt, maxAge, "feed too old at the fork block: set FILLMARK_FORK_BLOCK");
    }

    function _stocks() internal pure returns (address[] memory s) {
        s = new address[](4);
        s[0] = TSLA;
        s[1] = NVDA;
        s[2] = WETH;
        s[3] = CBBTC;
    }

    function _installData(uint256 id, uint128 maxPerTrade, uint128 dailyLimit, address[] memory stocks)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(id, maxPerTrade, dailyLimit, uint64(vm.getBlockTimestamp() + 30 days), slip, perf, stocks);
    }

    function _createAccount(uint128 maxPerTrade, uint128 dailyLimit, address[] memory stocks, uint256 salt)
        internal
        returns (address)
    {
        bytes[] memory initConfig = new bytes[](1);
        initConfig[0] = abi.encodeCall(
            IKernelV2.installModule,
            (
                2,
                address(router),
                abi.encodePacked(
                    address(0), abi.encode(_installData(agentId, maxPerTrade, dailyLimit, stocks), bytes(""))
                )
            )
        );
        bytes21 root = bytes21(abi.encodePacked(bytes1(0x01), ECDSA_VALIDATOR));
        bytes memory data =
            abi.encodeCall(IKernelV2.initialize, (root, address(1), abi.encodePacked(owner), bytes(""), initConfig));
        return IKernelFactoryV2(KERNEL_FACTORY).createAccount(data, bytes32(salt));
    }

    function _installId(address acct) internal view returns (uint64 id) {
        (,,,,, id,,,,,) = router.configs(acct);
    }

    function _intent(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        internal
        returns (FillmarkRouterV2.FillIntent memory it)
    {
        address pool = IUniswapV3Factory(FACTORY).getPool(tokenIn, tokenOut, fee);
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(pool).slot0();
        it = FillmarkRouterV2.FillIntent({
            agentId: agentId,
            account: account,
            installId: _installId(account),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            amountIn: amountIn,
            minOut: 0,
            refSqrtPriceX96: sqrtP,
            maxDevBps: 50,
            sqrtPriceLimitX96: 0,
            nonce: ++nonce,
            deadline: uint64(vm.getBlockTimestamp() + 10 minutes)
        });
    }

    function _sign(uint256 key, FillmarkRouterV2.FillIntent memory it) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, router.hashIntent(it));
        return abi.encodePacked(r, s, v);
    }

    function _exec(FillmarkRouterV2.FillIntent memory it) internal returns (uint256) {
        return router.execute(it, _sign(agentKey, it));
    }

    function _expectRevert(FillmarkRouterV2.FillIntent memory it, bytes4 err) internal {
        bytes memory sig = _sign(agentKey, it);
        vm.expectRevert(err);
        router.execute(it, sig);
    }

    /// handleOps does not revert when the operation's call fails: it emits the result.
    /// Returns whether the call succeeded and, if not, its revert data.
    function _tryUserOp(bytes memory callData) internal returns (bool success, bytes memory reason) {
        PackedOp memory op = PackedOp({
            sender: account,
            nonce: IEntryPointV2(ENTRYPOINT).getNonce(account, 0),
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32((uint256(800_000) << 128) | 800_000),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | (block.basefee + 1 gwei)),
            paymasterAndData: "",
            signature: ""
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, IEntryPointV2(ENTRYPOINT).getUserOpHash(op));
        op.signature = abi.encodePacked(r, s, v);
        PackedOp[] memory ops = new PackedOp[](1);
        ops[0] = op;
        vm.deal(account, 1 ether);
        address bundler = makeAddr("bundler");
        vm.recordLogs();
        vm.prank(bundler, bundler);
        IEntryPointV2(ENTRYPOINT).handleOps(ops, payable(bundler));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != ENTRYPOINT) continue;
            if (logs[i].topics[0] == USER_OP_EVENT) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                found = true;
            } else if (logs[i].topics[0] == USER_OP_REVERT) {
                (, reason) = abi.decode(logs[i].data, (uint256, bytes));
            }
        }
        assertTrue(found, "no UserOperationEvent");
    }

    function _userOp(bytes memory callData) internal {
        (bool ok, bytes memory reason) = _tryUserOp(callData);
        if (!ok) emit log_named_bytes("user operation reverted", reason);
        assertTrue(ok, "user operation failed");
    }

    /// The operation's call must fail with exactly this custom error.
    function _userOpReverts(bytes memory callData, bytes4 selector) internal {
        (bool ok, bytes memory reason) = _tryUserOp(callData);
        assertFalse(ok, "user operation should fail");
        assertEq(reason, abi.encodePacked(selector));
    }

    /// The owner moves a token out of the account with a normal Kernel call.
    function _ownerTransfer(address token, address to, uint256 amount) internal {
        bytes memory exec = abi.encodePacked(token, uint256(0), abi.encodeCall(IERC20.transfer, (to, amount)));
        _userOp(abi.encodeCall(IKernelV2.execute, (bytes32(0), exec)));
    }

    function _uninstall() internal {
        _userOp(abi.encodeCall(IKernelV2.uninstallModule, (2, address(router), bytes(""))));
    }

    function _install(uint256 id) internal {
        _userOp(_installCall(id));
    }

    function _installCall(uint256 id) internal view returns (bytes memory) {
        bytes memory initData =
            abi.encodePacked(address(0), abi.encode(_installData(id, 2_000e6, 20_000e6, _stocks()), bytes("")));
        return abi.encodeCall(IKernelV2.installModule, (2, address(router), initData));
    }

    function uniswapV3MintCallback(uint256 a0, uint256 a1, bytes calldata) external {
        _pay(IPoolMint(msg.sender).token0(), a0);
        _pay(IPoolMint(msg.sender).token1(), a1);
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        if (d0 > 0) _pay(IPoolMint(msg.sender).token0(), uint256(d0));
        if (d1 > 0) _pay(IPoolMint(msg.sender).token1(), uint256(d1));
    }

    function _pay(address token, uint256 amount) internal {
        if (amount == 0) return;
        deal(token, address(this), IERC20(token).balanceOf(address(this)) + amount);
        IERC20(token).transfer(msg.sender, amount);
    }

    function _nav(address feed) internal view returns (uint256) {
        (, int256 a,,,) = IAggregatorV3(feed).latestRoundData();
        return uint256(a);
    }

    function _book() internal view returns (FillmarkRouterV2.Book memory) {
        return router.bookOf(account, agentId);
    }

    function _lot(address stock) internal view returns (FillmarkRouterV2.Lot memory l) {
        (l,,,) = router.positionOf(account, agentId, stock);
    }

    function _hold(address stock) internal view returns (FillmarkRouterV2.Hold memory h) {
        (, h,,) = router.positionOf(account, agentId, stock);
    }

    function _later(address stock) internal view returns (FillmarkRouterV2.Hold memory h) {
        (,, h,) = router.positionOf(account, agentId, stock);
    }

    function _out(address stock) internal view returns (FillmarkRouterV2.Out memory o) {
        (,,, o) = router.positionOf(account, agentId, stock);
    }

    /// Decodes every Filled event recorded since vm.recordLogs().
    function _fills() internal view returns (FillmarkRouterV2.Fill[] memory fs) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == FillmarkRouterV2.Filled.selector) n++;
        }
        fs = new FillmarkRouterV2.Fill[](n);
        uint256 j;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(router) || logs[i].topics[0] != FillmarkRouterV2.Filled.selector) continue;
            (,, fs[j],) = abi.decode(logs[i].data, (address, bytes32, FillmarkRouterV2.Fill, FillmarkRouterV2.Prices));
            j++;
        }
    }

    // ---- fills and the fill fee ----

    /// A buy and a sell of WETH: the account pays 3 bps of each fill's USDG to the
    /// burner, the router holds nothing.
    function test_FillFeeGoesToBurner() public {
        uint256 usdgBefore = IERC20(USDG).balanceOf(account);
        vm.recordLogs();
        uint256 w = _exec(_intent(USDG, WETH, 500, 1_000e6));
        assertEq(IERC20(USDG).balanceOf(burner), 300_000); // 3 bps of 1,000 USDG
        assertEq(IERC20(USDG).balanceOf(account), usdgBefore - 1_000e6 - 300_000);
        uint256 got = _exec(_intent(WETH, USDG, 500, w));
        uint256 sellFee = got * 3 / 1e4;
        assertEq(IERC20(USDG).balanceOf(burner), 300_000 + sellFee);
        assertEq(IERC20(USDG).balanceOf(account), usdgBefore - 1_000e6 - 300_000 + got - sellFee);
        assertEq(IERC20(USDG).balanceOf(address(router)), 0);
        assertEq(IERC20(WETH).balanceOf(address(router)), 0);
        FillmarkRouterV2.Fill[] memory fs = _fills();
        assertEq(fs[0].fillFee, 300_000);
        assertEq(fs[1].fillFee, sellFee);
        // Each fill still writes its two feedback entries from the client's account.
        assertEq(IReputation(REPUTATION).getLastIndex(agentId, account), 4);
    }

    /// The fee is inside the slippage check. With a 10 bps limit and the 0.05% pool's
    /// spot moved to about 4 bps over NAV (deep liquidity there, so the buy barely moves
    /// it), a buy fills about 9 bps over NAV: allowed without the fill fee, rejected with
    /// the 3 bps fee on top.
    function test_FillFeeCountsAgainstSlippageLimit() public {
        slip = 10;
        account = _createAccount(2_000e6, 20_000e6, _stocks(), 40);
        deal(USDG, account, 1_000e6);
        address pool = IUniswapV3Factory(FACTORY).getPool(USDG, WETH, 500);
        uint256 nav = _nav(ETH_FEED);
        uint160 target = uint160(Math.sqrt(Math.mulDiv(nav * 10_004 / 10_000, 1 << 192, 1e20)));
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (sqrtP != target) IUniswapV3Pool(pool).swap(address(this), target < sqrtP, type(int128).max, target, "");
        (, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        int24 lo = (tick / 10) * 10;
        IPoolMint(pool).mint(address(this), lo - 10, lo + 20, 1e22, "");

        uint256 snap = vm.snapshotState();
        vm.prank(timelock);
        router.setFillFeeBps(0);
        vm.recordLogs();
        _exec(_intent(USDG, WETH, 500, 20e6));
        FillmarkRouterV2.Fill memory f = _fills()[0];
        uint256 over = (f.usdgAmount * 1e8) / router.navValueOf(f.stockAmount, uint256(f.answer), 18);
        assertGt(over, 1e8 + 7e4); // more than 7 bps over NAV
        assertLe(over, 1e8 + 1e5); // within the 10 bps limit
        vm.revertToState(snap);
        _expectRevert(_intent(USDG, WETH, 500, 20e6), FillmarkRouterV2.WorseThanNav.selector);
    }

    function test_FillFeeOnlyTimelockAndCapped() public {
        vm.expectRevert(FillmarkRouterV2.NotAdmin.selector);
        router.setFillFeeBps(5);
        vm.prank(timelock);
        vm.expectRevert(FillmarkRouterV2.BadConfig.selector);
        router.setFillFeeBps(11);
        vm.prank(timelock);
        router.setFillFeeBps(10);
        assertEq(router.fillFeeBps(), 10);
        uint256 before = IERC20(USDG).balanceOf(burner);
        _exec(_intent(USDG, WETH, 500, 1_000e6));
        assertEq(IERC20(USDG).balanceOf(burner) - before, 1_000_000); // 10 bps
    }

    // ---- the ledger ----

    /// A buy is booked at the worse of what the client paid (fee included) and NAV.
    function test_BuyBookedAtWorseOfPaidAndNav() public {
        vm.recordLogs();
        uint256 w = _exec(_intent(USDG, WETH, 500, 1_000e6));
        FillmarkRouterV2.Fill memory f = _fills()[0];
        FillmarkRouterV2.Lot memory l = _lot(WETH);
        assertEq(l.qty, w);
        uint256 navValue = router.navValueCeil(w, uint256(f.answer), 18);
        assertEq(l.cost, Math.max(1_000e6 + f.fillFee, navValue));
        assertEq(router.tokensOf(account, agentId).length, 1);
    }

    /// A gain from the agent's own sale waits the hold, then the agent is paid its share
    /// of the base above the peak, once. The gain comes from a real Chainlink ETH round.
    function test_GainPaidAfterHoldOnce() public {
        _fairPool();
        uint256 w = _exec(_intent(USDG, A, 500, 1_000e6));
        _priceUp();
        int256 pnl = _sell(A, 500, w);
        assertGt(pnl, 0);
        FillmarkRouterV2.Hold memory h = _hold(A);
        assertEq(int256(uint256(h.gain)), pnl);
        assertEq(h.until, vm.getBlockTimestamp() + HOLD);
        assertEq(_book().realized, 0);

        // Before the hold ends nothing is due, and nothing is written.
        uint64 idx = IReputation(REPUTATION).getLastIndex(agentId, account);
        assertEq(router.settle(account), 0);
        assertEq(IReputation(REPUTATION).getLastIndex(agentId, account), idx);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        uint256 walletBefore = IERC20(USDG).balanceOf(agent);
        uint256 fee = router.settle(account);
        assertEq(fee, uint256(pnl) * PERF_BPS / 1e4);
        assertEq(IERC20(USDG).balanceOf(agent) - walletBefore, fee);
        FillmarkRouterV2.Book memory b = _book();
        assertEq(b.realized, pnl);
        assertEq(b.peak, pnl);
        assertEq(b.paid, fee);
        assertEq(b.debt, 0);
        // Recorded by the client's own account.
        idx = IReputation(REPUTATION).getLastIndex(agentId, account);
        (int128 v,, string memory t1,,) = IReputation(REPUTATION).readFeedback(agentId, account, idx);
        assertEq(int256(v), int256(fee));
        assertEq(t1, "fillmark-agentfee");
        // The same gain is never paid twice.
        assertEq(router.settle(account), 0);
        assertEq(IReputation(REPUTATION).getLastIndex(agentId, account), idx);
        assertEq(router.tokensOf(account, agentId).length, 0); // the empty token left the book
    }

    /// A loss counts at once and must be won back before the agent earns again.
    function test_LossCountsAtOnceAndMustBeRecovered() public {
        _fairPool();
        uint256 w = _exec(_intent(USDG, A, 500, 1_000e6));
        _exec(_intent(A, USDG, 500, w)); // two pool fees and two fill fees: a small loss
        int256 realized = _book().realized;
        assertLt(realized, 0);
        assertEq(router.settle(account), 0);
        assertEq(_book().peak, 0);
        // A later gain smaller than the loss earns nothing.
        uint256 w2 = _exec(_intent(USDG, A, 500, 20e6));
        _priceUp();
        int256 pnl = _sell(A, 500, w2);
        assertGt(pnl, 0);
        assertLt(pnl, -realized);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        assertEq(router.settle(account), 0);
        assertEq(_book().realized, realized + pnl);
    }

    /// First design review, M1: selling and buying back within the hold cancels the
    /// gain in proportion, and the rebuy's cost drops by the cancelled amount.
    function test_RebuyWithinHoldCancelsGain() public {
        _fairPool();
        uint256 w = _exec(_intent(USDG, A, 500, 1_000e6));
        _priceUp();
        int256 pnl = _sell(A, 500, w);
        assertGt(pnl, 0);
        FillmarkRouterV2.Hold memory h = _hold(A);
        vm.recordLogs();
        uint256 back = _exec(_intent(USDG, A, 500, 500e6)); // about half
        FillmarkRouterV2.Fill memory f = _fills()[0];
        assertLt(back, h.qty);
        uint256 cancel = Math.mulDiv(uint256(pnl), back, h.qty);
        FillmarkRouterV2.Hold memory h2 = _hold(A);
        assertEq(uint256(h2.gain), uint256(pnl) - cancel);
        assertEq(h2.qty, h.qty - back);
        uint256 cost = Math.max(500e6 + f.fillFee, router.navValueCeil(back, uint256(f.answer), AD));
        assertEq(_lot(A).cost, cost - cancel);
        // Buying back the rest cancels all of it.
        _exec(_intent(USDG, A, 500, 600e6));
        assertEq(_hold(A).gain, 0);
        assertEq(_hold(A).until, 0);
    }

    /// Second review, M-D, and third review, M-1: a new gain never matures early by
    /// joining an older one, and frequent sales never keep an older gain from maturing.
    /// The older gain keeps its end; later ones restart theirs and take its place.
    function test_EachSaleGainWaitsAtLeastTheHoldAndMatures() public {
        _fairPool();
        uint256 w = _exec(_intent(USDG, A, 500, 1_000e6));
        _priceUp();
        uint256 t0 = vm.getBlockTimestamp();
        int256 g1 = _sell(A, 500, w / 3);
        assertGt(g1, 0);
        vm.warp(t0 + HOLD - 60);
        assertGt(_sell(A, 500, w / 3), 0);
        assertEq(_hold(A).until, t0 + HOLD); // the first keeps its end
        assertEq(_later(A).until, t0 + 2 * HOLD - 60); // the second waits its own hold
        vm.warp(t0 + HOLD);
        assertEq(router.settle(account), uint256(g1) * PERF_BPS / 1e4); // the first matured
        assertEq(_hold(A).until, t0 + 2 * HOLD - 60); // the second took its place
        assertEq(_later(A).gain, 0);
        vm.warp(t0 + HOLD + HOLD / 2);
        assertGt(_sell(A, 500, w - 2 * (w / 3)), 0);
        assertEq(_hold(A).until, t0 + 2 * HOLD - 60);
        assertEq(_later(A).until, vm.getBlockTimestamp() + HOLD);
    }

    /// First design review, H2: the client moves a winner out to dodge the fee. The units
    /// are booked as sold at NAV, so the gain still counts after the hold.
    function test_MovingAWinnerOutIsBookedAsSale() public {
        _fairPool();
        uint256 w = _exec(_intent(USDG, A, 500, 1_000e6));
        FillmarkRouterV2.Lot memory l = _lot(A);
        uint256 nav = _priceUp();
        uint256 value = router.navValueOf(w, nav, AD);
        assertGt(value, l.cost);
        _ownerTransfer(A, owner, w);
        assertEq(router.settle(account), 0); // syncs: booked as moved out, gain waits
        FillmarkRouterV2.Out memory o = _out(A);
        assertEq(o.qty, w);
        assertEq(uint256(o.gain), value - l.cost);
        assertEq(_lot(A).qty, 0);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        uint256 fee = router.settle(account);
        assertEq(fee, (value - l.cost) * PERF_BPS / 1e4);
    }

    /// Second design review, H3: moving a loser out books the loss, but bringing the
    /// units back within the hold restores them at their cost and undoes the loss.
    function test_MovingOutAndBackDoesNotLockInALoss() public {
        uint256 w = _exec(_intent(USDG, WETH, 500, 1_000e6));
        FillmarkRouterV2.Lot memory l = _lot(WETH);
        assertGe(l.cost, router.navValueOf(w, _nav(ETH_FEED), 18)); // bought above NAV: an open loss
        _ownerTransfer(WETH, owner, w);
        router.settle(account);
        int256 lossBooked = _book().realized;
        assertLt(lossBooked, 0);
        vm.prank(owner);
        IERC20(WETH).transfer(account, w);
        router.settle(account);
        assertEq(_book().realized, 0);
        assertEq(_lot(WETH).qty, w);
        assertApproxEqAbs(_lot(WETH).cost, l.cost, 1); // NAV rounded up, as for a buy
        assertEq(_out(WETH).qty, 0);
    }

    /// Second design review, H4: a move-out is booked only at a fresh NAV. With a stale
    /// feed, settling reverts and nothing is booked at zero.
    function test_RevertWhen_SettleWithStaleFeed() public {
        uint256 w = _exec(_intent(USDG, WETH, 500, 1_000e6));
        _ownerTransfer(WETH, owner, w);
        (,,, uint256 updatedAt,) = IAggregatorV3(ETH_FEED).latestRoundData();
        vm.warp(updatedAt + ETH_MAX_AGE + 1);
        vm.expectRevert(FillmarkRouterV2.StaleFeed.selector);
        router.settle(account);
    }

    /// Review 3, H3: moving dust out again and again cannot push back the wait of a gain
    /// that is already waiting: a move-out adds its own gain to the wait, weighted by size.
    function test_DustMoveOutsCannotPostponeAGain() public {
        _fairPool();
        uint256 w = _exec(_intent(USDG, A, 500, 1_000e6));
        _priceUp();
        _ownerTransfer(A, owner, w - 1000);
        router.settle(account);
        FillmarkRouterV2.Out memory o = _out(A);
        assertEq(o.until, vm.getBlockTimestamp() + HOLD);
        assertGt(o.gain, 0);
        for (uint256 i; i < 3; i++) {
            vm.warp(vm.getBlockTimestamp() + HOLD / 4);
            _ownerTransfer(A, owner, 1);
            router.settle(account);
            assertEq(_out(A).until, o.until);
        }
        vm.warp(o.until);
        uint256 fee = router.settle(account);
        assertEq(_out(A).gain, 0);
        assertApproxEqAbs(fee, uint256(o.gain) * PERF_BPS / 1e4, 10); // less the dust's own losses
    }

    /// Review 3, M1: units that come back are bought again at the NAV of that moment. A
    /// loss booked when they left is undone, and a rise while they were outside is not
    /// the agent's.
    function test_ReturnedUnitsAreBoughtAgainAtNav() public {
        _fairPool();
        uint256 w = _exec(_intent(USDG, A, 500, 1_000e6));
        _ownerTransfer(A, owner, w);
        router.settle(account);
        int256 lossBooked = _book().realized;
        assertLt(lossBooked, 0); // pool fee and fill fee
        uint256 nav = _priceUp();
        vm.prank(owner);
        IERC20(A).transfer(account, w);
        router.settle(account);
        assertEq(_book().realized, 0);
        assertEq(_lot(A).qty, w);
        assertEq(_lot(A).cost, router.navValueCeil(w, nav, AD) + uint256(-lossBooked));
        assertEq(_out(A).qty, 0);
    }

    /// A winner moved out and back at the same NAV: the waiting gain lowers the new cost,
    /// so the lot is where it was and nothing is owed.
    function test_ReturnedWinnerKeepsItsCost() public {
        _fairPool();
        uint256 w = _exec(_intent(USDG, A, 500, 1_000e6));
        FillmarkRouterV2.Lot memory l = _lot(A);
        _priceUp();
        _ownerTransfer(A, owner, w);
        router.settle(account);
        assertGt(_out(A).gain, 0);
        vm.prank(owner);
        IERC20(A).transfer(account, w);
        router.settle(account);
        assertApproxEqAbs(_lot(A).cost, l.cost, 1);
        assertEq(_out(A).qty, 0);
        assertEq(_out(A).gain, 0);
        assertEq(_book().realized, 0);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        assertEq(router.settle(account), 0);
    }

    /// Review 3, M2: an account that answers "sent" without sending cannot skip the fill fee.
    function test_RevertWhen_AccountFakesTheFillFee() public {
        FakeAccount fake = new FakeAccount(USDG);
        fake.install(address(router), _installData(agentId, 2_000e6, 20_000e6, _stocks()));
        deal(USDG, address(fake), 10_000e6);
        account = address(fake);
        fake.setRefuse(burner);
        _expectRevert(_intent(USDG, WETH, 500, 1_000e6), FillmarkRouterV2.PaymentFailed.selector);
        fake.setRefuse(address(0));
        _exec(_intent(USDG, WETH, 500, 1_000e6));
        assertEq(IERC20(USDG).balanceOf(burner), 300_000);
    }

    /// Review 3, H1: an account that will not pay the agent (a Kernel hook, another
    /// implementation) owes the fee: settle books it as debt, buys stop, and a sale must
    /// pay it first or it does not go through.
    function test_AnAccountThatDoesNotPayOwesTheFee() public {
        _fairPool();
        FakeAccount fake = new FakeAccount(USDG);
        fake.install(address(router), _installData(agentId, 2_000e6, 20_000e6, _stocks()));
        deal(USDG, address(fake), 10_000e6);
        account = address(fake);
        uint256 w = _exec(_intent(USDG, A, 500, 1_000e6));
        _priceUp();
        int256 pnl = _sell(A, 500, w / 2);
        assertGt(pnl, 0);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        fake.setRefuse(agent);
        fake.setRefuseFeedback(true); // second review, H1: a hook that blocks the fee's record
        uint256 walletBefore = IERC20(USDG).balanceOf(agent);
        uint256 fee = router.settle(account);
        assertEq(fee, uint256(pnl) * PERF_BPS / 1e4);
        assertEq(_book().debt, fee);
        assertEq(_book().paid, 0);
        assertEq(IERC20(USDG).balanceOf(agent), walletBefore);
        _expectRevert(_intent(USDG, A, 500, 100e6), FillmarkRouterV2.InDebt.selector);
        _expectRevert(_intent(A, USDG, 500, w - w / 2), FillmarkRouterV2.PaymentFailed.selector);
        fake.setRefuse(address(0));
        fake.setRefuseFeedback(false);
        // Second review, M-C: paying debt from inside the sale's own debt payment is refused.
        fake.setReenter(address(router), agentId);
        _exec(_intent(A, USDG, 500, w - w / 2));
        assertEq(fake.reentry(), abi.encodePacked(FillmarkRouterV2.Reentered.selector));
        assertEq(_book().debt, 0);
        assertEq(_book().paid, fee);
        assertEq(IERC20(USDG).balanceOf(agent) - walletBefore, fee);
    }

    /// Units the router never bought carry no PnL; tracked units are sold first.
    function test_UntrackedUnitsCarryNoPnl() public {
        uint256 w = _exec(_intent(USDG, WETH, 500, 500e6));
        deal(WETH, account, IERC20(WETH).balanceOf(account) + w); // the client's own WETH
        vm.recordLogs();
        _exec(_intent(WETH, USDG, 500, 2 * w));
        assertEq(_lot(WETH).qty, 0);
        // Only half the proceeds were set against the tracked cost.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        int256 pnl;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == FillmarkRouterV2.Booked.selector) {
                pnl = abi.decode(logs[i].data, (int256));
            }
        }
        assertLt(pnl, 0); // round trip on the tracked half only: fees, not a gain from the client's units
        assertGt(pnl, -10e6);
    }

    /// First design review, H3: the agent pushes the pool above NAV and sells there.
    /// The sale is booked at NAV, so the push earns no gain.
    function test_PushedPriceSaleBookedAtNav() public {
        uint256 w = _exec(_intent(USDG, A, 500, 1_000e6));
        FillmarkRouterV2.Lot memory l = _lot(A);
        uint256 nav = _nav(AF);
        _movePool(nav * 10_100 / 10_000); // 1% over NAV, deep liquidity there
        vm.recordLogs();
        _exec(_intent(A, USDG, 500, w));
        FillmarkRouterV2.Fill memory f = _fills()[0];
        uint256 navValue = router.navValueOf(w, nav, AD);
        assertGt(f.usdgAmount - f.fillFee, navValue); // the fill really was above NAV
        assertEq(_hold(A).gain, 0);
        assertEq(_book().realized, -int256(l.cost - navValue)); // only the buy's own cost
    }

    // ---- debt ----

    /// The client empties its USDG before a fee is due: the fee becomes debt, buys stop,
    /// sells still run and pay the debt first.
    function test_DebtStopsBuysAndSellsRepayIt() public {
        _fairPool();
        uint256 w = _exec(_intent(USDG, A, 500, 1_000e6));
        _priceUp();
        int256 pnl = _sell(A, 500, w);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        _ownerTransfer(USDG, owner, IERC20(USDG).balanceOf(account));
        uint256 fee = router.settle(account);
        assertEq(fee, uint256(pnl) * PERF_BPS / 1e4);
        assertEq(_book().debt, fee);
        deal(USDG, account, 1_000e6);
        _expectRevert(_intent(USDG, A, 500, 100e6), FillmarkRouterV2.InDebt.selector);
        // A settle with no new fee collects the debt from USDG now in the account.
        uint256 walletBefore = IERC20(USDG).balanceOf(agent);
        assertEq(router.settle(account), 0);
        assertEq(_book().debt, 0);
        assertEq(IERC20(USDG).balanceOf(agent) - walletBefore, fee);
    }

    /// Sells pay the debt first when the account has no USDG left.
    function test_SellPaysDebtFirst() public {
        _fairPool();
        uint256 w = _exec(_intent(USDG, A, 500, 1_000e6));
        _priceUp();
        _sell(A, 500, w);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        _ownerTransfer(USDG, owner, IERC20(USDG).balanceOf(account));
        uint256 fee = router.settle(account);
        assertGt(fee, 0);
        deal(A, account, w); // the client's own A, not tracked
        uint256 walletBefore = IERC20(USDG).balanceOf(agent);
        _exec(_intent(A, USDG, 500, w));
        assertEq(_book().debt, 0);
        assertEq(IERC20(USDG).balanceOf(agent) - walletBefore, fee);
    }

    // ---- removal ----

    /// Second design review, H2: removing the router does not dodge the fee. closeOut
    /// books every unit at NAV and counts held gains; the fee becomes debt, the same agent
    /// cannot be installed again until it is paid, and another agent waits for closeOut.
    function test_UninstallThenCloseOutTurnsFeeIntoDebt() public {
        _fairPool();
        uint256 w = _exec(_intent(USDG, A, 500, 1_000e6));
        _priceUp();
        int256 pnl = _sell(A, 500, w); // gain still in its hold
        assertGt(pnl, 0);
        // Prices are fresh, so removal closes the book at once, at this NAV.
        _uninstall();
        assertFalse(router.isInitialized(account));
        uint256 fee = uint256(pnl) * PERF_BPS / 1e4;
        FillmarkRouterV2.Book memory b = _book();
        assertFalse(b.closing);
        assertEq(b.debt, fee);
        assertEq(b.realized, pnl);
        assertEq(router.openBook(account), 0);
        vm.expectRevert(FillmarkRouterV2.NotClosing.selector);
        router.closeOut(account, agentId);
        _userOpReverts(_installCall(agentId), FillmarkRouterV2.InDebt.selector);

        // Pay: approve the router, then payDebt, in one batch from the account.
        _userOp(
            abi.encodeCall(
                IKernelV2.execute,
                (
                    bytes32(uint256(1) << 248), // batch
                    abi.encode(_payDebtCalls(fee))
                )
            )
        );
        assertEq(_book().debt, 0);
        assertEq(_book().paid, fee);
        _install(agentId);
        assertTrue(router.isInitialized(account));
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    function _payDebtCalls(uint256 fee) internal view returns (Call[] memory c) {
        c = new Call[](2);
        c[0] = Call(USDG, 0, abi.encodeCall(IERC20.approve, (address(router), fee)));
        c[1] = Call(address(router), 0, abi.encodeCall(FillmarkRouterV2.payDebt, (agentId, fee)));
    }

    /// closeOut waits for a price like a fill does, but a feed dead for 30 days values the
    /// token at zero, so a dead token cannot keep the book open and block another agent.
    /// Removed while a token cannot be priced: the book stays closing, and any install, of
    /// another agent or the same one, waits for its close-out. closeOut waits for a price,
    /// but STUCK_AFTER the removal it values the token at its cost.
    function test_CloseOutWaitsForPriceThenValuesAStuckTokenAtCost() public {
        uint256 w = _exec(_intent(USDG, WETH, 500, 1_000e6));
        int256 realized = _book().realized;
        (,,, uint256 updatedAt,) = IAggregatorV3(ETH_FEED).latestRoundData();
        vm.warp(updatedAt + ETH_MAX_AGE + 1);
        _uninstall();
        FillmarkRouterV2.Book memory b = _book();
        assertTrue(b.closing);
        assertEq(b.closingAt, vm.getBlockTimestamp());

        (address other,) = _key("other-agent");
        vm.prank(other);
        uint256 otherId = IIdentity(IDENTITY).register("");
        _userOpReverts(_installCall(otherId), FillmarkRouterV2.CloseOutPending.selector);
        _userOpReverts(_installCall(agentId), FillmarkRouterV2.CloseOutPending.selector);

        vm.expectRevert(FillmarkRouterV2.StaleFeed.selector);
        router.closeOut(account, agentId);
        vm.warp(b.closingAt + router.STUCK_AFTER() - 1);
        vm.expectRevert(FillmarkRouterV2.StaleFeed.selector);
        router.closeOut(account, agentId);
        vm.warp(b.closingAt + router.STUCK_AFTER());
        assertEq(router.closeOut(account, agentId), 0);
        assertEq(_book().realized, realized); // at cost: no gain, no loss
        assertEq(router.openBook(account), 0);
        assertEq(IERC20(WETH).balanceOf(account), w); // the client keeps its tokens
        _install(otherId);
    }

    /// Second review, M-A: a removal given too little gas for its close-out leaves the
    /// book closing although prices are fresh. The next install closes it out first, so
    /// the client cannot carry the old book into a new install (at a lower fee, or with a
    /// hook) and the old units are no longer tracked.
    function test_InstallClosesOutABookLeftClosing() public {
        uint256 w = _exec(_intent(USDG, WETH, 500, 1_000e6));
        int256 realized = _book().realized;
        uint256 value = router.navValueOf(w, _nav(ETH_FEED), 18);
        uint256 cost = _lot(WETH).cost;
        vm.prank(account);
        IKernelV2(account).uninstallModule{gas: 108_000}(2, address(router), "");
        assertFalse(router.isInitialized(account));
        assertTrue(_book().closing, "close-out should have run out of gas");
        perf = 0;
        _install(agentId);
        FillmarkRouterV2.Book memory b = _book();
        assertFalse(b.closing);
        assertEq(b.perfFeeBps, 0);
        assertEq(b.realized, realized + int256(value) - int256(cost)); // closed at this NAV
        assertEq(_lot(WETH).qty, 0);
        assertEq(router.tokensOf(account, agentId).length, 0);
    }

    function test_RevertWhen_CloseOutWhileInstalled() public {
        vm.expectRevert(FillmarkRouterV2.NotClosing.selector);
        router.closeOut(account, agentId);
    }

    function test_RevertWhen_PerfFeeOverCap() public {
        perf = 3_001;
        vm.prank(makeAddr("acct-x"));
        vm.expectRevert(FillmarkRouterV2.BadConfig.selector);
        router.onInstall(_installData(agentId, 1e9, 1e9, _stocks()));
    }

    // ---- v1 behaviour kept ----

    function test_BuyAndSellTsla() public {
        uint256 bought = _exec(_intent(USDG, TSLA, 3000, 500e6));
        assertEq(IERC20(TSLA).balanceOf(account), bought);
        _exec(_intent(TSLA, USDG, 3000, bought));
        assertEq(IERC20(TSLA).balanceOf(account), 0);
        assertEq(IERC20(TSLA).balanceOf(address(router)), 0);
    }

    function test_RevertWhen_AgentSellsClientStockIntoOwnRange() public {
        uint256 held = _exec(_intent(USDG, TSLA, 3000, 1_900e6));
        address pool = IUniswapV3Factory(FACTORY).getPool(TSLA, USDG, 100);
        IPoolMint(pool).mint(address(this), -345600, -345400, 1e14, "");
        _expectRevert(_intent(TSLA, USDG, 100, held), FillmarkRouterV2.WorseThanNav.selector);
    }

    function test_RevertWhen_MarketClosedOrOraclePaused() public {
        feeds.addClosure(uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1 hours));
        _expectRevert(_intent(USDG, TSLA, 3000, 500e6), FillmarkRouterV2.MarketClosed.selector);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(ORACLE_PAUSER);
        IStockAdmin(TSLA).pauseOracle();
        _expectRevert(_intent(USDG, TSLA, 3000, 500e6), FillmarkRouterV2.OraclePaused.selector);
    }

    /// A stock in the book blocks settling while its market is closed.
    function test_RevertWhen_SettleWhileStockMarketClosed() public {
        _exec(_intent(USDG, TSLA, 3000, 500e6));
        feeds.addClosure(uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1 hours));
        vm.expectRevert(FillmarkRouterV2.MarketClosed.selector);
        router.settle(account);
    }

    function test_RevertWhen_MultiplierNotPricedAtSettle() public {
        _exec(_intent(USDG, TSLA, 3000, 500e6));
        uint256 m = IStockAdmin(TSLA).uiMultiplier();
        vm.prank(MULTIPLIER_UPDATER);
        IStockAdmin(TSLA).updateMultiplier(m + m / 1000);
        vm.expectRevert(FillmarkRouterV2.MultiplierNotPriced.selector);
        router.settle(account);
    }

    function test_RevertWhen_OldIntentAfterReinstall() public {
        FillmarkRouterV2.FillIntent memory it = _intent(USDG, WETH, 500, 100e6);
        bytes memory sig = _sign(agentKey, it);
        _uninstall();
        _install(agentId);
        vm.expectRevert(FillmarkRouterV2.WrongInstall.selector);
        router.execute(it, sig);
    }

    function test_RevertWhen_OverLimitsOrTooSmall() public {
        _expectRevert(_intent(USDG, WETH, 500, 2_001e6), FillmarkRouterV2.OverTradeLimit.selector);
        _expectRevert(_intent(USDG, WETH, 500, 9_999_999), FillmarkRouterV2.TooSmall.selector);
    }

    function test_EightDecimalTokenLedger() public {
        uint256 b = _exec(_intent(USDG, CBBTC, 500, 500e6));
        FillmarkRouterV2.Lot memory l = _lot(CBBTC);
        assertEq(l.qty, b);
        assertApproxEqRel(router.navValueOf(b, _nav(CBBTC_FEED), 8), 500e6, 0.02e18);
        _exec(_intent(CBBTC, USDG, 500, b));
        assertEq(_lot(CBBTC).qty, 0);
    }

    function test_GasOfFillsAndSettle() public {
        uint256 g = gasleft();
        uint256 w = _exec(_intent(USDG, WETH, 500, 500e6));
        emit log_named_uint("gas buy", g - gasleft());
        g = gasleft();
        _exec(_intent(WETH, USDG, 500, w / 2));
        emit log_named_uint("gas sell", g - gasleft());
        g = gasleft();
        router.settle(account);
        emit log_named_uint("gas settle, one token", g - gasleft());
    }

    // ---- scenario helpers ----

    /// A real Chainlink round of the asset's feed (ETH / USD or CBBTC / USD), replayed on
    /// the fork: FILLMARK_ROUND_TX is a transmit that raised the answer, FILLMARK_FORK_BLOCK
    /// the block just before it, and FILLMARK_ROUND_FROM, _TO and _INPUT that transaction's
    /// sender, target and calldata as read from chain. It is sent again as the same call
    /// from the same sender: vm.transact runs on the fork's own state and drops what the
    /// test changed before it. An arbitrageur then moves the asset's 0.05% USDG pool to the
    /// new price.
    function _priceUp() internal returns (uint256 nav) {
        address from = vm.envAddress("FILLMARK_ROUND_FROM");
        address to = vm.envAddress("FILLMARK_ROUND_TO");
        bytes memory input = vm.envBytes("FILLMARK_ROUND_INPUT");
        uint256 before = _nav(AF);
        vm.prank(from, from);
        (bool ok,) = to.call(input);
        assertTrue(ok, "the replayed round must succeed");
        nav = _nav(AF);
        assertGt(nav, before * 10_020 / 10_000, "the round must raise the price by at least 0.2%");
        (,,, uint256 updatedAt,) = IAggregatorV3(AF).latestRoundData();
        if (updatedAt > vm.getBlockTimestamp()) vm.warp(updatedAt);
        _movePool(nav);
    }

    /// The arbitrageur's first move: the asset's pool at the current NAV, as in a market
    /// where arbitrage keeps the pool near the oracle, so a gain test buys near NAV.
    function _fairPool() internal {
        _movePool(_nav(AF));
    }

    /// Moves the asset's USDG 0.05% pool spot to `price` (8 decimals) and adds deep
    /// liquidity there, so the next fills land near it.
    function _movePool(uint256 price) internal {
        address pool = IUniswapV3Factory(FACTORY).getPool(USDG, A, 500);
        uint256 scale = 10 ** (uint256(AD) + 2); // raw USDG per raw token = price / scale
        uint160 target = A < USDG
            ? uint160(Math.sqrt(Math.mulDiv(price, 1 << 192, scale)))
            : uint160(Math.sqrt(Math.mulDiv(scale, 1 << 192, price)));
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (sqrtP != target) IUniswapV3Pool(pool).swap(address(this), target < sqrtP, type(int128).max, target, "");
        (, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        int24 lo = (tick / 10) * 10;
        IPoolMint(pool).mint(address(this), lo - 10, lo + 20, A == WETH ? 1e22 : 1e17, "");
    }

    /// Sells and returns the PnL the router booked for the sale.
    function _sell(address stock, uint24 fee, uint256 qty) internal returns (int256 pnl) {
        vm.recordLogs();
        _exec(_intent(stock, USDG, fee, qty));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == FillmarkRouterV2.Booked.selector) {
                pnl = abi.decode(logs[i].data, (int256));
            }
        }
    }
}

/// A contract account that installs the router itself and answers a USDG transfer to
/// `refuse` as done without making it. Everything else it really does.
contract FakeAccount {
    address public immutable usdg;
    address public refuse;
    bool public refuseFeedback; // reverts any call to the reputation registry
    address public reenter; // calls payDebt on it before each USDG transfer
    uint256 public reenterAgent;
    bytes public reentry; // what that call returned

    constructor(address usdg_) {
        usdg = usdg_;
    }

    function setRefuse(address to) external {
        refuse = to;
    }

    function setRefuseFeedback(bool on) external {
        refuseFeedback = on;
    }

    function setReenter(address router, uint256 agentId) external {
        reenter = router;
        reenterAgent = agentId;
    }

    function install(address router, bytes calldata data) external {
        FillmarkRouterV2(router).onInstall(data);
    }

    function executeFromExecutor(bytes32, bytes calldata exec) external returns (bytes[] memory ret) {
        address target = address(bytes20(exec[0:20]));
        bytes calldata data = exec[52:];
        ret = new bytes[](1);
        if (refuseFeedback && target != usdg && bytes4(data[0:4]) != IERC20.transfer.selector) {
            revert("feedback refused");
        }
        if (target == usdg && bytes4(data[0:4]) == IERC20.transfer.selector) {
            if (reenter != address(0)) {
                (, reentry) = reenter.call(abi.encodeCall(FillmarkRouterV2.payDebt, (reenterAgent, 1)));
            }
            (address to,) = abi.decode(data[4:], (address, uint256));
            if (to == refuse) {
                ret[0] = abi.encode(true);
                return ret;
            }
        }
        (bool ok, bytes memory r) = target.call(data);
        require(ok, "call failed");
        ret[0] = r;
    }
}
