// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ForkBase, IIdentity, IReputation, IStockAdmin} from "./ForkBase.sol";
import {IKernelV2, IKernelFactoryV2, PackedOp, IEntryPointV2, IPoolMint} from "./RouterV2.t.sol";
import {FillmarkFeeds} from "../src/FillmarkFeeds.sol";
import {FillmarkRouterV2} from "../src/FillmarkRouterV2.sol";
import {FillmarkRouterV3} from "../src/FillmarkRouterV3.sol";
import {
    IAggregatorV3,
    IIdentityRegistry,
    IReputationRegistry,
    IUniswapV3Factory,
    IUniswapV3Pool
} from "../src/interfaces/External.sol";

interface IPoolAdmin {
    function tickSpacing() external view returns (int24);
    function increaseObservationCardinalityNext(uint16 next) external;
}

interface IUsdgAdmin {
    function grantRole(bytes32 role, address account) external;
    function freeze(address account) external;
    function unfreeze(address account) external;
    function isFrozen(address account) external view returns (bool);
}

/// Fork tests of router v3 on Robinhood Chain mainnet: real ERC-8004 registries,
/// Uniswap v3 pools, Chainlink feeds, Robinhood stock tokens, USDG, Kernel v3.1 accounts
/// and EntryPoint v0.7. No mocks.
///
/// Run like the v2 tests: at the block before a real Chainlink round that raised the
/// price (FILLMARK_ROUND_*), with FILLMARK_TEST_ANYTIME=1 so the test's own calendar is
/// open all week.
contract RouterV3ForkTest is ForkBase {
    bytes32 constant USER_OP_EVENT =
        keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
    bytes32 constant USER_OP_REVERT = keccak256("UserOperationRevertReason(bytes32,address,uint256,bytes)");
    // The role USDG asks of a caller of freeze(address), read from its revert on chain.
    bytes32 constant USDG_FREEZE_ROLE = 0xe3e4f9d7569515307c0cdec302af069a93c9e33f325269bac70e6e22465a9796;
    address constant USDG_ADMIN = 0xcFA0388f5ddf905FdC08c45c716C15Dc10A14C6F;

    uint16 constant SLIP_BPS = 200;
    uint16 constant PERF_BPS = 2_000; // 20%
    uint16 constant CAP_BPS = 100;
    uint64 constant HOLD = 1 hours; // the release deploys 7 days
    uint32 constant TWAP = 60;

    FillmarkFeeds feeds;
    FillmarkRouterV3 router;
    address guardian = makeAddr("guardian");
    address burner = makeAddr("burner");
    address timelock = makeAddr("timelock");
    uint32 stockMaxAge = 6 hours;

    address agent;
    address owner;
    uint256 ownerKey;
    uint256 agentId;
    address account;
    uint256 nonce;
    uint16 slip = SLIP_BPS;
    uint16 perf = PERF_BPS;
    uint64 expiryIn = 30 days;
    bool regularOnly;
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
        if (anytime) feeds.addPeriod(FillmarkFeeds.Period(uint64(vm.getBlockTimestamp()), 52200, 75600, 0, 7 days));
        else feeds.addPeriod(FillmarkFeeds.Period(uint64(vm.getBlockTimestamp()), 52200, 75600, 90000, 522000));

        router = new FillmarkRouterV3(_setup(), _initialPools());

        (agent,) = _key("agent");
        (owner, ownerKey) = _key("owner");
        vm.prank(agent);
        agentId = IIdentity(IDENTITY).register("");

        account = _createAccount(2_000e6, 20_000e6, _stocks(), 1);
        deal(USDG, account, 50_000e6);
        // Right before a Chainlink round the pool often leads the feed by about 1%, where
        // the router rightly refuses to buy (test_RevertWhen_PoolLeadsAStaleNav). Most tests
        // start from a pool at NAV, as arbitrage keeps it between rounds, with only the
        // pool's real liquidity.
        _poolTo(WETH, _nav(ETH_FEED), 0);
        vm.warp(vm.getBlockTimestamp() + TWAP);
    }

    function _setup() internal view returns (FillmarkRouterV3.Setup memory) {
        return FillmarkRouterV3.Setup({
            identity: IIdentityRegistry(IDENTITY),
            reputation: IReputationRegistry(REPUTATION),
            factory: IUniswapV3Factory(FACTORY),
            usdg: USDG,
            feeds: feeds,
            burner: burner,
            admin: timelock,
            guardian: guardian,
            fillFeeBps: 3,
            hold: HOLD,
            twapWindow: TWAP
        });
    }

    /// One USDG pool per token, as the release picks them: the deep ones.
    function _initialPools() internal view returns (FillmarkRouterV3.InitialPool[] memory p) {
        p = new FillmarkRouterV3.InitialPool[](4);
        p[0] = FillmarkRouterV3.InitialPool(WETH, _pool(WETH, 500), CAP_BPS, CAP_BPS);
        p[1] = FillmarkRouterV3.InitialPool(CBBTC, _pool(CBBTC, 500), CAP_BPS, CAP_BPS);
        p[2] = FillmarkRouterV3.InitialPool(TSLA, _pool(TSLA, 3000), CAP_BPS, CAP_BPS);
        p[3] = FillmarkRouterV3.InitialPool(NVDA, _pool(NVDA, 500), CAP_BPS, CAP_BPS);
    }

    function _pool(address token, uint24 fee) internal view returns (address) {
        return IUniswapV3Factory(FACTORY).getPool(token, USDG, fee);
    }

    // ---- helpers ----

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
        return abi.encode(
            id, maxPerTrade, dailyLimit, uint64(vm.getBlockTimestamp() + expiryIn), slip, perf, regularOnly, stocks
        );
    }

    function _kernelInit(bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(address(0), abi.encode(data, bytes("")));
    }

    function _createAccount(uint128 maxPerTrade, uint128 dailyLimit, address[] memory stocks, uint256 salt)
        internal
        returns (address)
    {
        return _createAccountWith(address(router), _installData(agentId, maxPerTrade, dailyLimit, stocks), salt);
    }

    function _createAccountWith(address module, bytes memory data, uint256 salt) internal returns (address) {
        bytes[] memory initConfig = new bytes[](1);
        initConfig[0] = abi.encodeCall(IKernelV2.installModule, (2, module, _kernelInit(data)));
        bytes21 root = bytes21(abi.encodePacked(bytes1(0x01), ECDSA_VALIDATOR));
        bytes memory init =
            abi.encodeCall(IKernelV2.initialize, (root, address(1), abi.encodePacked(owner), bytes(""), initConfig));
        return IKernelFactoryV2(KERNEL_FACTORY).createAccount(init, bytes32(salt));
    }

    function _installId(address acct) internal view returns (uint64 id) {
        (,,,,, id,,,,) = router.configs(acct);
    }

    function _intent(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        returns (FillmarkRouterV3.FillIntent memory)
    {
        return FillmarkRouterV3.FillIntent({
            agentId: agentId,
            account: account,
            installId: _installId(account),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minOut: 0,
            sqrtPriceLimitX96: 0,
            nonce: ++nonce,
            deadline: uint64(vm.getBlockTimestamp() + 10 minutes)
        });
    }

    function _exec(FillmarkRouterV3.FillIntent memory it) internal returns (uint256) {
        vm.prank(agent);
        return router.execute(it);
    }

    function _expectRevert(FillmarkRouterV3.FillIntent memory it, bytes4 err) internal {
        vm.prank(agent);
        vm.expectRevert(err);
        router.execute(it);
    }

    /// handleOps does not revert when the operation's call fails: it emits the result.
    function _tryUserOp(bytes memory callData) internal returns (bool success, bytes memory reason) {
        PackedOp memory op = PackedOp({
            sender: account,
            nonce: IEntryPointV2(ENTRYPOINT).getNonce(account, 0),
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32((uint256(1_500_000) << 128) | 1_500_000),
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

    function _userOpReverts(bytes memory callData, bytes4 selector) internal {
        (bool ok, bytes memory reason) = _tryUserOp(callData);
        assertFalse(ok, "user operation should fail");
        assertEq(reason, abi.encodePacked(selector));
    }

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
        bytes memory data = _installData(id, 2_000e6, 20_000e6, _stocks());
        return abi.encodeCall(IKernelV2.installModule, (2, address(router), _kernelInit(data)));
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    function _batch(Call[] memory c) internal pure returns (bytes memory) {
        return abi.encodeCall(IKernelV2.execute, (bytes32(uint256(1) << 248), abi.encode(c)));
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

    function _feedOf(address token) internal view returns (address) {
        return feeds.feedOf(token);
    }

    function _book() internal view returns (FillmarkRouterV3.Book memory) {
        return router.bookOf(account, agentId);
    }

    function _lot(address stock) internal view returns (FillmarkRouterV3.Lot memory l) {
        (l,,,) = router.positionOf(account, agentId, stock);
    }

    function _hold(address stock) internal view returns (FillmarkRouterV3.Hold memory h) {
        (, h,,) = router.positionOf(account, agentId, stock);
    }

    function _later(address stock) internal view returns (FillmarkRouterV3.Hold memory h) {
        (,, h,) = router.positionOf(account, agentId, stock);
    }

    function _out(address stock) internal view returns (FillmarkRouterV3.Out memory o) {
        (,,, o) = router.positionOf(account, agentId, stock);
    }

    function _esc(int256 gain) internal pure returns (uint256) {
        return Math.mulDiv(uint256(gain), PERF_BPS, 1e4, Math.Rounding.Ceil);
    }

    function _usdg(address who) internal view returns (uint256) {
        return IERC20(USDG).balanceOf(who);
    }

    /// Decodes every Filled event recorded since vm.recordLogs().
    function _fills() internal view returns (FillmarkRouterV3.Fill[] memory fs, address[] memory pools) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == FillmarkRouterV3.Filled.selector) n++;
        }
        fs = new FillmarkRouterV3.Fill[](n);
        pools = new address[](n);
        uint256 j;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(router) || logs[i].topics[0] != FillmarkRouterV3.Filled.selector) continue;
            (pools[j],, fs[j],) =
                abi.decode(logs[i].data, (address, bytes32, FillmarkRouterV3.Fill, FillmarkRouterV3.Prices));
            j++;
        }
    }

    function _countLogs(bytes32 topic) internal view returns (uint256 n) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == topic) n++;
        }
    }

    // ---- fills and the fill fee ----

    /// A buy and a sell of WETH through its official pool: the account pays 3 bps of each
    /// fill's USDG to the burner; with no gain the router holds nothing.
    function test_FillFeeGoesToBurner() public {
        uint256 usdgBefore = _usdg(account);
        vm.recordLogs();
        uint256 w = _exec(_intent(USDG, WETH, 1_000e6));
        assertEq(_usdg(burner), 300_000);
        assertEq(_usdg(account), usdgBefore - 1_000e6 - 300_000);
        uint256 got = _exec(_intent(WETH, USDG, w));
        uint256 sellFee = got * 3 / 1e4;
        assertEq(_usdg(burner), 300_000 + sellFee);
        assertEq(_usdg(account), usdgBefore - 1_000e6 - 300_000 + got - sellFee);
        assertEq(_usdg(address(router)), 0);
        assertEq(IERC20(WETH).balanceOf(address(router)), 0);
        (FillmarkRouterV3.Fill[] memory fs, address[] memory pools) = _fills();
        assertEq(fs[0].fillFee, 300_000);
        assertEq(fs[1].fillFee, sellFee);
        assertEq(pools[0], _pool(WETH, 500));
        assertEq(pools[1], _pool(WETH, 500));
        assertGt(fs[0].sqrtPriceAfter, 0);
        assertEq(IReputation(REPUTATION).getLastIndex(agentId, account), 4);
    }

    /// The fill fee comes out of the client's limit: with a 10 bps limit the pool price
    /// after a buy, its 0.05% fee included, may sit 10 bps over NAV without a fill fee and
    /// only 7 bps over with the 3 bps fill fee. The pool is moved to about 4 bps over NAV
    /// with deep liquidity, so a buy ends about 9 bps over.
    function test_FillFeeCountsAgainstThePriceBound() public {
        slip = 10;
        account = _createAccount(2_000e6, 20_000e6, _stocks(), 40);
        deal(USDG, account, 1_000e6);
        _poolTo(WETH, _nav(ETH_FEED) * 10_004 / 10_000, 1e22);
        vm.warp(vm.getBlockTimestamp() + TWAP);
        uint256 snap = vm.snapshotState();
        vm.prank(timelock);
        router.setFillFeeBps(0);
        _exec(_intent(USDG, WETH, 20e6));
        vm.revertToState(snap);
        _expectRevert(_intent(USDG, WETH, 20e6), FillmarkRouterV3.PriceOutOfRange.selector);
    }

    function test_FillFeeOnlyTimelockAndCapped() public {
        vm.expectRevert(FillmarkRouterV3.NotAdmin.selector);
        router.setFillFeeBps(5);
        vm.prank(timelock);
        vm.expectRevert(FillmarkRouterV3.BadConfig.selector);
        router.setFillFeeBps(11);
        vm.prank(timelock);
        router.setFillFeeBps(10);
        uint256 before = _usdg(burner);
        _exec(_intent(USDG, WETH, 1_000e6));
        assertEq(_usdg(burner) - before, 1_000_000);
    }

    // ---- who may fill ----

    /// Only the agent wallet pinned at install sends fills; there are no signatures.
    function test_RevertWhen_NotTheAgentWallet() public {
        FillmarkRouterV3.FillIntent memory it = _intent(USDG, WETH, 100e6);
        vm.expectRevert(FillmarkRouterV3.NotAgentWallet.selector);
        router.execute(it);
        vm.prank(owner);
        vm.expectRevert(FillmarkRouterV3.NotAgentWallet.selector);
        router.execute(it);
        _exec(it);
        // The same nonce never fills twice.
        _expectRevert(it, FillmarkRouterV3.NonceUsed.selector);
    }

    /// A transfer of the agent NFT clears its wallet in the registry; the install stops.
    function test_RevertWhen_AgentNftChangedHands() public {
        vm.prank(agent);
        IIdentity(IDENTITY).transferFrom(agent, makeAddr("new-owner"), agentId);
        _expectRevert(_intent(USDG, WETH, 100e6), FillmarkRouterV3.WalletChanged.selector);
    }

    function test_RevertWhen_IntentExpired() public {
        FillmarkRouterV3.FillIntent memory it = _intent(USDG, WETH, 100e6);
        vm.warp(it.deadline + 1);
        _expectRevert(it, FillmarkRouterV3.Expired.selector);
    }

    // ---- pools ----

    /// setPool takes only the factory's USDG pool of that token with enough history, from
    /// the timelock, within the cap limit.
    function test_SetPoolChecksThePool() public {
        address tslaPool500 = _pool(TSLA, 500);
        address wethPool = _pool(WETH, 500);
        address gldPool = _pool(GLD, 3000);
        vm.expectRevert(FillmarkRouterV3.NotAdmin.selector);
        router.setPool(TSLA, tslaPool500, 50, 50);
        vm.startPrank(timelock);
        vm.expectRevert(FillmarkRouterV3.NoPool.selector);
        router.setPool(TSLA, wethPool, 50, 50); // another token's pool
        vm.expectRevert(FillmarkRouterV3.BadConfig.selector);
        router.setPool(TSLA, tslaPool500, 101, 50);
        vm.expectRevert(FillmarkRouterV3.BadConfig.selector);
        router.setPool(TSLA, tslaPool500, 50, 0);
        vm.expectRevert(FillmarkRouterV3.UnknownStock.selector);
        router.setPool(GLD, gldPool, 50, 50); // no feed for it
        router.setPool(TSLA, tslaPool500, 50, 40);
        vm.stopPrank();
        FillmarkRouterV3.PoolCfg memory pc = router.poolOf(TSLA);
        assertEq(pc.pool, tslaPool500);
        assertEq(pc.fee, 500);
        assertEq(pc.capBps, 50);
        assertEq(pc.twapCapBps, 40);
        assertTrue(pc.active);
    }

    /// A pool that keeps too few observations for the window is refused (NVDA's 1% pool
    /// keeps 10 on chain).
    function test_RevertWhen_PoolKeepsTooFewObservations() public {
        assertEq(router.minCardinality(), 100);
        address pool = _pool(NVDA, 10000);
        (,,, uint16 cardinality,,,) = IUniswapV3Pool(pool).slot0();
        assertLt(cardinality, 100);
        vm.prank(timelock);
        vm.expectRevert(FillmarkRouterV3.NoTwap.selector);
        router.setPool(NVDA, pool, 50, 50);
    }

    /// A pool whose observations do not yet reach twapWindow back cannot fill: the TWAP
    /// read fails and the fill reverts.
    function test_RevertWhen_PoolHistoryShorterThanWindow() public {
        address pool = _pool(CBBTC, 10000); // empty on chain, one observation slot
        int24 s = IPoolAdmin(pool).tickSpacing();
        (, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        int24 lo = (tick / s) * s;
        IPoolMint(pool).mint(address(this), lo - s, lo + 2 * s, 1e9, ""); // observation now
        IPoolAdmin(pool).increaseObservationCardinalityNext(200);
        vm.warp(vm.getBlockTimestamp() + 1);
        IPoolMint(pool).mint(address(this), lo - s, lo + 2 * s, 1e9, ""); // grows to 200
        vm.prank(timelock);
        router.setPool(CBBTC, pool, 100, 100);
        vm.warp(vm.getBlockTimestamp() + TWAP / 2);
        _expectRevert(_intent(USDG, CBBTC, 100e6), FillmarkRouterV3.NoTwap.selector);
    }

    /// The guardian switches a pool off at once; only the timelock switches it on again.
    function test_GuardianSwitchesPoolOff() public {
        vm.expectRevert(FillmarkRouterV3.NotAdmin.selector);
        router.poolOff(WETH);
        vm.prank(guardian);
        router.poolOff(WETH);
        _expectRevert(_intent(USDG, WETH, 100e6), FillmarkRouterV3.NoPool.selector);
        address pool = _pool(WETH, 500);
        vm.prank(guardian);
        vm.expectRevert(FillmarkRouterV3.NotAdmin.selector);
        router.setPool(WETH, pool, CAP_BPS, CAP_BPS);
        vm.prank(timelock);
        router.setPool(WETH, pool, CAP_BPS, CAP_BPS);
        _exec(_intent(USDG, WETH, 100e6));
    }

    /// A token without a pool does not trade; the TWAP window must be 30 to 600 seconds.
    function test_ConstructorChecks() public {
        FillmarkRouterV3.InitialPool[] memory none = new FillmarkRouterV3.InitialPool[](0);
        FillmarkRouterV3 bare = this.deployRouter(_setup(), none);
        assertFalse(bare.poolOf(WETH).active);
        FillmarkRouterV3.Setup memory s = _setup();
        s.twapWindow = 29;
        vm.expectRevert(FillmarkRouterV3.BadConfig.selector);
        this.deployRouter(s, none);
        s.twapWindow = 601;
        vm.expectRevert(FillmarkRouterV3.BadConfig.selector);
        this.deployRouter(s, none);
        s.twapWindow = 600;
        assertEq(this.deployRouter(s, none).minCardinality(), 601);
        // One initial pool that fails its checks stops the deploy.
        FillmarkRouterV3.InitialPool[] memory bad = new FillmarkRouterV3.InitialPool[](1);
        bad[0] = FillmarkRouterV3.InitialPool(TSLA, _pool(WETH, 500), CAP_BPS, CAP_BPS);
        vm.expectRevert(FillmarkRouterV3.NoPool.selector);
        this.deployRouter(_setup(), bad);
    }

    function deployRouter(FillmarkRouterV3.Setup memory s, FillmarkRouterV3.InitialPool[] memory p)
        external
        returns (FillmarkRouterV3)
    {
        return new FillmarkRouterV3(s, p);
    }

    // ---- price bounds ----

    /// A buy may not push the pool past NAV plus C. The thin path above the pool price
    /// (the agent's own narrow range, say) is cut off where the bound ends, so a large buy
    /// reverts and the same buy, smaller, fills.
    function test_RevertWhen_BuyPushesPoolPastNavBound() public {
        account = _createAccount(1_000_000e6, 1_000_000e6, _stocks(), 41);
        deal(USDG, account, 1_000_000e6);
        uint256 nav = _nav(ETH_FEED);
        _poolTo(WETH, nav, 0);
        vm.warp(vm.getBlockTimestamp() + TWAP);
        // An agent's narrow range just above, so the path is thin there.
        (, int24 tick,,,,,) = IUniswapV3Pool(_pool(WETH, 500)).slot0();
        int24 lo = (tick / 10) * 10;
        IPoolMint(_pool(WETH, 500)).mint(address(this), lo + 200, lo + 210, 1e15, "");
        _expectRevert(_intent(USDG, WETH, 900_000e6), FillmarkRouterV3.PriceOutOfRange.selector);
        vm.recordLogs();
        _exec(_intent(USDG, WETH, 1_000e6));
        (FillmarkRouterV3.Fill[] memory fs,) = _fills();
        uint256 after_ = router.spotPrice(fs[0].sqrtPriceAfter, WETH < USDG, 18);
        assertLe(after_ * 10_005 / 10_000, nav * (10_000 + CAP_BPS) / 10_000);
    }

    /// A sale may not push the pool below NAV less C: the agent buys in steps the pool
    /// absorbs, then a sale of all of it at once would take the pool more than 1% down.
    function test_RevertWhen_SellPushesPoolPastNavBound() public {
        account = _createAccount(1_000_000e6, 1_000_000e6, _stocks(), 42);
        deal(USDG, account, 1_000_000e6);
        uint256 nav = _nav(ETH_FEED);
        uint256 w;
        for (uint256 i; i < 6; i++) {
            _poolTo(WETH, nav, 0);
            vm.warp(vm.getBlockTimestamp() + TWAP);
            w += _exec(_intent(USDG, WETH, 5_000e6));
        }
        _poolTo(WETH, nav, 0);
        vm.warp(vm.getBlockTimestamp() + TWAP);
        _expectRevert(_intent(WETH, USDG, w), FillmarkRouterV3.PriceOutOfRange.selector);
        _exec(_intent(WETH, USDG, w / 20));
    }

    /// The pool fee counts in the NAV bound: with C = 100 bps and the 0.05% pool, a buy
    /// may end with the pool 95 bps over NAV but not 97 bps.
    function test_NavBoundIncludesPoolFee() public {
        uint256 nav = _nav(ETH_FEED);
        uint256 snap = vm.snapshotState();
        _poolTo(WETH, nav * 10_094 / 10_000, 1e22);
        vm.warp(vm.getBlockTimestamp() + TWAP);
        _exec(_intent(USDG, WETH, 20e6));
        vm.revertToState(snap);
        _poolTo(WETH, nav * 10_097 / 10_000, 1e22);
        vm.warp(vm.getBlockTimestamp() + TWAP);
        _expectRevert(_intent(USDG, WETH, 20e6), FillmarkRouterV3.PriceOutOfRange.selector);
    }

    /// The pool above NAV by more than C (as it often is just before a Chainlink round
    /// catches up): buys are refused; once the round lands, the same buy fills.
    function test_RevertWhen_PoolLeadsAStaleNav() public {
        uint256 nav = _nav(ETH_FEED);
        _poolTo(WETH, nav * 10_120 / 10_000, 1e22);
        vm.warp(vm.getBlockTimestamp() + TWAP);
        _expectRevert(_intent(USDG, WETH, 100e6), FillmarkRouterV3.PriceOutOfRange.selector);
        _priceUp();
        _exec(_intent(USDG, WETH, 100e6));
    }

    /// A sandwich: someone pushes the pool up just before the agent's buy. Within the same
    /// second the TWAP does not move, so the push counts in full against the TWAP bound;
    /// a push held some seconds counts in part; held the whole window, the pool's TWAP is
    /// that price and the NAV bound is what remains. The pool sits 50 bps under NAV, the
    /// push brings it to NAV, and the TWAP bound is 30 bps.
    function test_RevertWhen_PushJustBeforeTheBuy() public {
        address pool = _pool(WETH, 500);
        vm.prank(timelock);
        router.setPool(WETH, pool, CAP_BPS, 30);
        uint256 nav = _nav(ETH_FEED);
        _poolTo(WETH, nav * 9_950 / 10_000, 1e22);
        vm.warp(vm.getBlockTimestamp() + TWAP);
        uint256 snap = vm.snapshotState();
        _exec(_intent(USDG, WETH, 20e6)); // no push: fills
        vm.revertToState(snap);
        _poolTo(WETH, nav, 1e22);
        _expectRevert(_intent(USDG, WETH, 20e6), FillmarkRouterV3.PriceOutOfRange.selector);
        vm.warp(vm.getBlockTimestamp() + 10);
        _expectRevert(_intent(USDG, WETH, 20e6), FillmarkRouterV3.PriceOutOfRange.selector);
        vm.warp(vm.getBlockTimestamp() + TWAP);
        _exec(_intent(USDG, WETH, 20e6));
    }

    /// The same for a sale: the pool pushed down just before it.
    function test_RevertWhen_PushJustBeforeTheSale() public {
        address pool = _pool(WETH, 500);
        vm.prank(timelock);
        router.setPool(WETH, pool, CAP_BPS, 30);
        uint256 nav = _nav(ETH_FEED);
        _poolTo(WETH, nav * 10_050 / 10_000, 1e22);
        vm.warp(vm.getBlockTimestamp() + TWAP);
        uint256 w = _exec(_intent(USDG, WETH, 1_000e6));
        _poolTo(WETH, nav, 1e22);
        _expectRevert(_intent(WETH, USDG, w), FillmarkRouterV3.PriceOutOfRange.selector);
        vm.warp(vm.getBlockTimestamp() + TWAP);
        _exec(_intent(WETH, USDG, w));
    }

    // ---- regular hours and limits ----

    /// An install for regular hours only: stocks do not fill in the extended session;
    /// crypto, which has no session, still does. In the test calendar 14:30 to 21:00 UTC
    /// is regular and the rest of the week extended.
    function test_RegularOnlyBlocksExtendedHours() public {
        regularOnly = true;
        account = _createAccount(2_000e6, 20_000e6, _stocks(), 43);
        deal(USDG, account, 10_000e6);
        _exec(_intent(USDG, WETH, 100e6));
        uint256 t = vm.getBlockTimestamp();
        uint256 day = (t / 1 days) * 1 days;
        bool regularNow = feeds.sessionAt(t) == FillmarkFeeds.Session.Regular;
        uint256 extended = regularNow ? day + 75600 + 60 : t;
        uint256 regular = regularNow ? t : (t < day + 52200 ? day + 52200 + 60 : day + 1 days + 52200 + 60);
        vm.warp(extended);
        assertTrue(feeds.sessionAt(extended) == FillmarkFeeds.Session.Extended);
        _fair(TSLA);
        _expectRevert(_intent(USDG, TSLA, 100e6), FillmarkRouterV3.RegularHoursOnly.selector);
        if (regular < vm.getBlockTimestamp()) regular += 1 days; // the next regular session
        vm.warp(regular);
        assertTrue(feeds.sessionAt(regular) == FillmarkFeeds.Session.Regular);
        _fair(TSLA);
        _exec(_intent(USDG, TSLA, 100e6));
    }

    /// Buys count in a rolling window of the current hour and the 24 before it, fill fee
    /// included; sales do not count. A buy stays counted 24 hours later and drops out when
    /// its hour is 25 hours back.
    function test_BuysCountInARollingWindow() public {
        account = _createAccount(2_000e6, 1_000e6, _stocks(), 44);
        deal(USDG, account, 10_000e6);
        uint256 w = _exec(_intent(USDG, WETH, 600e6));
        assertEq(router.windowSpent(account), 600e6 + 180_000);
        _expectRevert(_intent(USDG, WETH, 400e6), FillmarkRouterV3.OverDailyLimit.selector);
        _exec(_intent(USDG, WETH, 399e6));
        uint256 spent = 600e6 + 180_000 + 399e6 + 119_700;
        assertEq(router.windowSpent(account), spent);
        _exec(_intent(WETH, USDG, w)); // a sale does not count
        assertEq(router.windowSpent(account), spent);
        uint256 h = vm.getBlockTimestamp() / 1 hours;
        vm.warp((h + 24) * 1 hours + 3599);
        assertEq(router.windowSpent(account), spent);
        vm.warp((h + 25) * 1 hours);
        assertEq(router.windowSpent(account), 0);
    }

    /// The per-trade limit counts a buy's USDG; a sale counts the larger of its USDG and
    /// its NAV value, so a pushed-down sale cannot pass a limit its value would not.
    function test_RevertWhen_OverLimitsOrTooSmall() public {
        _expectRevert(_intent(USDG, WETH, 2_001e6), FillmarkRouterV3.OverTradeLimit.selector);
        _expectRevert(_intent(USDG, WETH, 9_999_999), FillmarkRouterV3.TooSmall.selector);
        uint256 w = _exec(_intent(USDG, WETH, 1_990e6));
        uint256 w2 = _exec(_intent(USDG, WETH, 100e6));
        _expectRevert(_intent(WETH, USDG, w + w2), FillmarkRouterV3.OverTradeLimit.selector);
    }

    function test_RevertWhen_PerfFeeOverCap() public {
        perf = 3_001;
        vm.prank(makeAddr("acct-x"));
        vm.expectRevert(FillmarkRouterV3.BadConfig.selector);
        router.onInstall(_installData(agentId, 1e9, 1e9, _stocks()));
    }

    /// Buys stop at expiry; the agent may sell its units for SELL_GRACE after it.
    function test_SalesOpenForAWeekAfterExpiry() public {
        _priceUp(); // a fresh round, so the feed is still fresh after the expiry
        expiryIn = 2 hours;
        account = _createAccount(2_000e6, 20_000e6, _stocks(), 45);
        deal(USDG, account, 10_000e6);
        uint256 w = _exec(_intent(USDG, WETH, 500e6));
        (,,,, uint64 expiry,,,,,) = router.configs(account);
        vm.warp(expiry + 1);
        _expectRevert(_intent(USDG, WETH, 100e6), FillmarkRouterV3.Expired.selector);
        uint256 snap = vm.snapshotState();
        _exec(_intent(WETH, USDG, w / 2));
        vm.revertToState(snap);
        vm.warp(expiry + router.SELL_GRACE() + 1);
        _expectRevert(_intent(WETH, USDG, w / 2), FillmarkRouterV3.Expired.selector);
    }

    /// The agent sells only units it bought.
    function test_RevertWhen_SellingTheClientsOwnUnits() public {
        uint256 w = _exec(_intent(USDG, WETH, 500e6));
        deal(WETH, account, IERC20(WETH).balanceOf(account) + w);
        _expectRevert(_intent(WETH, USDG, w + 1), FillmarkRouterV3.NotAgentUnits.selector);
        _exec(_intent(WETH, USDG, w));
        assertEq(_lot(WETH).qty, 0);
        _expectRevert(_intent(WETH, USDG, w), FillmarkRouterV3.NotAgentUnits.selector);
    }

    // ---- the ledger and the fee escrow ----

    /// A buy is booked at the worse of what the client paid (fee included) and NAV.
    function test_BuyBookedAtWorseOfPaidAndNav() public {
        vm.recordLogs();
        uint256 w = _exec(_intent(USDG, WETH, 1_000e6));
        (FillmarkRouterV3.Fill[] memory fs,) = _fills();
        FillmarkRouterV3.Lot memory l = _lot(WETH);
        assertEq(l.qty, w);
        assertEq(l.cost, Math.max(1_000e6 + fs[0].fillFee, router.navValueCeil(w, uint256(fs[0].answer), 18)));
    }

    /// A sale's gain waits the hold with the fee on it held here; then settle pays the
    /// agent from that escrow, once, and returns the rounding left over. The gain comes
    /// from a real Chainlink round.
    function test_GainEscrowedThenPaidOnce() public {
        _fair(A);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        _priceUp();
        uint256 acctBefore = _usdg(account);
        int256 pnl = _sell(A, w);
        assertGt(pnl, 0);
        uint256 esc = _esc(pnl);
        FillmarkRouterV3.Hold memory h = _hold(A);
        assertEq(int256(uint256(h.gain)), pnl);
        assertEq(h.esc, esc);
        assertEq(h.until, vm.getBlockTimestamp() + HOLD);
        assertEq(_usdg(address(router)), esc);
        assertGt(_usdg(account), acctBefore); // the rest of the proceeds stayed

        uint64 idx = IReputation(REPUTATION).getLastIndex(agentId, account);
        assertEq(router.settle(account), 0);
        assertEq(_usdg(address(router)), esc);
        assertEq(IReputation(REPUTATION).getLastIndex(agentId, account), idx);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        uint256 walletBefore = _usdg(agent);
        acctBefore = _usdg(account);
        uint256 fee = router.settle(account);
        assertEq(fee, uint256(pnl) * PERF_BPS / 1e4);
        assertEq(_usdg(agent) - walletBefore, fee);
        assertEq(_usdg(account) - acctBefore, esc - fee); // rounding goes back
        assertEq(_usdg(address(router)), 0);
        FillmarkRouterV3.Book memory b = _book();
        assertEq(b.realized, pnl);
        assertEq(b.peak, pnl);
        assertEq(b.paid, fee);
        assertEq(b.debt, 0);
        assertEq(b.escMatured, 0);
        idx = IReputation(REPUTATION).getLastIndex(agentId, account);
        (int128 v,, string memory t1,,) = IReputation(REPUTATION).readFeedback(agentId, account, idx);
        assertEq(int256(v), int256(fee));
        assertEq(t1, "fillmark-agentfee");
        assertEq(router.settle(account), 0);
        assertEq(router.tokensOf(account, agentId).length, 0);
    }

    /// A loss counts at once and must be won back before the agent earns again; a later
    /// gain's escrow goes back while the book is under its peak.
    function test_LossCountsAtOnceAndEscrowGoesBack() public {
        _fair(A);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        _exec(_intent(A, USDG, w)); // fees both ways: a small loss
        int256 realized = _book().realized;
        assertLt(realized, 0);
        uint256 w2 = _exec(_intent(USDG, A, 20e6));
        _priceUp();
        int256 pnl = _sell(A, w2);
        assertGt(pnl, 0);
        assertLt(pnl, -realized);
        assertEq(_usdg(address(router)), _esc(pnl));
        vm.warp(vm.getBlockTimestamp() + HOLD);
        uint256 acctBefore = _usdg(account);
        assertEq(router.settle(account), 0);
        assertEq(_book().realized, realized + pnl);
        assertEq(_usdg(account) - acctBefore, _esc(pnl));
        assertEq(_usdg(address(router)), 0);
    }

    /// Selling and buying back within the hold cancels the gain in proportion, lowers the
    /// rebuy's cost by as much, and returns the same share of the escrow to the account.
    function test_RebuyWithinHoldCancelsGainAndReturnsEscrow() public {
        _fair(A);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        _priceUp();
        int256 pnl = _sell(A, w);
        FillmarkRouterV3.Hold memory h = _hold(A);
        uint256 acctBefore = _usdg(account);
        vm.recordLogs();
        uint256 back = _exec(_intent(USDG, A, 500e6));
        (FillmarkRouterV3.Fill[] memory fs,) = _fills();
        assertLt(back, h.qty);
        uint256 cancel = Math.mulDiv(uint256(pnl), back, h.qty);
        uint256 escBack = Math.mulDiv(h.esc, cancel, h.gain);
        FillmarkRouterV3.Hold memory h2 = _hold(A);
        assertEq(uint256(h2.gain), uint256(pnl) - cancel);
        assertEq(h2.esc, h.esc - escBack);
        assertEq(acctBefore - _usdg(account), 500e6 + fs[0].fillFee - escBack);
        uint256 cost = Math.max(500e6 + fs[0].fillFee, router.navValueCeil(back, uint256(fs[0].answer), AD));
        assertEq(_lot(A).cost, cost - cancel);
        _exec(_intent(USDG, A, 600e6));
        assertEq(_hold(A).gain, 0);
        assertEq(_hold(A).esc, 0);
        assertEq(_hold(A).until, 0);
        assertEq(_usdg(address(router)), 0);
    }

    /// A token that cannot be priced stops settle, but not the escrow: release pays no
    /// fee, keeps what the fee could still be and returns the rest. Here the book is under
    /// its peak, so all of the matured escrow goes back.
    function test_ReleaseReturnsEscrowWithoutPrices() public {
        _fair(A);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        _exec(_intent(A, USDG, w)); // a small loss: the book is under its peak
        _fair(TSLA);
        _exec(_intent(USDG, TSLA, 100e6));
        _fair(A);
        uint256 w2 = _exec(_intent(USDG, A, 20e6));
        _priceUp();
        int256 pnl = _sell(A, w2);
        assertGt(pnl, 0);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        feeds.addClosure(uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1 days));
        vm.expectRevert(FillmarkRouterV3.MarketClosed.selector);
        router.settle(account);
        uint256 acctBefore = _usdg(account);
        router.release(account);
        assertEq(_usdg(account) - acctBefore, _esc(pnl));
        assertEq(_book().escMatured, 0);
        assertEq(_usdg(address(router)), 0);
    }

    /// Each sale's gain waits its own hold with its own escrow; the older one keeps its end.
    function test_EachSaleGainWaitsAtLeastTheHoldAndMatures() public {
        _fair(A);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        _priceUp();
        uint256 t0 = vm.getBlockTimestamp();
        int256 g1 = _sell(A, w / 3);
        assertGt(g1, 0);
        vm.warp(t0 + HOLD - 60);
        int256 g2 = _sell(A, w / 3);
        assertGt(g2, 0);
        assertEq(_hold(A).until, t0 + HOLD);
        assertEq(_later(A).until, t0 + 2 * HOLD - 60);
        assertEq(_later(A).esc, _esc(g2));
        vm.warp(t0 + HOLD);
        assertEq(router.settle(account), uint256(g1) * PERF_BPS / 1e4);
        assertEq(_hold(A).until, t0 + 2 * HOLD - 60);
        assertEq(_hold(A).esc, _esc(g2));
        assertEq(_later(A).gain, 0);
        assertEq(_usdg(address(router)), _esc(g2));
    }

    /// With an open loss beyond dust, settle charges nothing and keeps the matured escrow
    /// (at most the fee on realized PnL above the peak); once the loss is booked, the fee
    /// comes from that escrow and the rest goes back.
    function test_OpenLossKeepsEscrowUntilItClears() public {
        _fair(A);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        _priceUp();
        int256 pnl = _sell(A, w);
        uint256 esc = _esc(pnl);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        uint256 w2 = _exec(_intent(USDG, A, 50e6)); // after the hold: no cancel, an open loss
        assertEq(_book().escMatured, esc);
        uint256 acctBefore = _usdg(account);
        assertEq(router.settle(account), 0);
        assertEq(_book().escMatured, esc);
        assertEq(_usdg(account), acctBefore);
        assertEq(_usdg(address(router)), esc);
        _exec(_intent(A, USDG, w2)); // the loss is booked
        int256 realized = _book().realized;
        assertLt(realized, pnl);
        assertGt(realized, 0);
        uint256 walletBefore = _usdg(agent);
        acctBefore = _usdg(account);
        uint256 fee = router.settle(account);
        assertEq(fee, uint256(realized) * PERF_BPS / 1e4);
        assertEq(_usdg(agent) - walletBefore, fee);
        assertEq(_usdg(account) - acctBefore, esc - fee);
        assertEq(_usdg(address(router)), 0);
    }

    /// A winner moved out is booked as sold at NAV; its gain has no escrow, so its fee is
    /// pulled from the account's USDG.
    function test_MovingAWinnerOutIsBookedAsSale() public {
        _fair(A);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        FillmarkRouterV3.Lot memory l = _lot(A);
        uint256 nav = _priceUp();
        uint256 value = router.navValueOf(w, nav, AD);
        _ownerTransfer(A, owner, w);
        assertEq(router.settle(account), 0);
        assertEq(_out(A).qty, w);
        assertEq(uint256(_out(A).gain), value - l.cost);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        uint256 walletBefore = _usdg(agent);
        uint256 fee = router.settle(account);
        assertEq(fee, (value - l.cost) * PERF_BPS / 1e4);
        assertEq(_usdg(agent) - walletBefore, fee);
    }

    function test_MovingOutAndBackDoesNotLockInALoss() public {
        uint256 w = _exec(_intent(USDG, WETH, 1_000e6));
        FillmarkRouterV3.Lot memory l = _lot(WETH);
        _ownerTransfer(WETH, owner, w);
        router.settle(account);
        assertLt(_book().realized, 0);
        vm.prank(owner);
        IERC20(WETH).transfer(account, w);
        router.settle(account);
        assertEq(_book().realized, 0);
        assertEq(_lot(WETH).qty, w);
        assertApproxEqAbs(_lot(WETH).cost, l.cost, 1);
    }

    function test_RevertWhen_SettleWithStaleFeed() public {
        uint256 w = _exec(_intent(USDG, WETH, 1_000e6));
        _ownerTransfer(WETH, owner, w);
        (,,, uint256 updatedAt,) = IAggregatorV3(ETH_FEED).latestRoundData();
        vm.warp(updatedAt + ETH_MAX_AGE + 1);
        vm.expectRevert(FillmarkRouterV3.StaleFeed.selector);
        router.settle(account);
    }

    function test_DustMoveOutsCannotPostponeAGain() public {
        _fair(A);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        _priceUp();
        _ownerTransfer(A, owner, w - 1000);
        router.settle(account);
        FillmarkRouterV3.Out memory o = _out(A);
        for (uint256 i; i < 3; i++) {
            vm.warp(vm.getBlockTimestamp() + HOLD / 4);
            _ownerTransfer(A, owner, 1);
            router.settle(account);
            assertEq(_out(A).until, o.until);
        }
        vm.warp(o.until);
        router.settle(account);
        assertEq(_out(A).gain, 0);
    }

    function test_ReturnedUnitsAreBoughtAgainAtNav() public {
        _fair(A);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        _ownerTransfer(A, owner, w);
        router.settle(account);
        int256 lossBooked = _book().realized;
        assertLt(lossBooked, 0);
        uint256 nav = _priceUp();
        vm.prank(owner);
        IERC20(A).transfer(account, w);
        router.settle(account);
        assertEq(_book().realized, 0);
        assertEq(_lot(A).cost, router.navValueCeil(w, nav, AD) + uint256(-lossBooked));
    }

    /// First design review, H3, kept: the agent pushes the pool above NAV (within the
    /// bound) and sells there; the sale is booked at NAV, so the push earns no gain.
    function test_PushedPriceSaleBookedAtNav() public {
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        FillmarkRouterV3.Lot memory l = _lot(A);
        uint256 nav = _nav(AF);
        _poolTo(A, nav * 10_090 / 10_000, A == WETH ? 1e22 : 1e17);
        vm.warp(vm.getBlockTimestamp() + TWAP);
        vm.recordLogs();
        _exec(_intent(A, USDG, w));
        (FillmarkRouterV3.Fill[] memory fs,) = _fills();
        uint256 navValue = router.navValueOf(w, nav, AD);
        assertGt(fs[0].usdgAmount - fs[0].fillFee, navValue);
        assertEq(_hold(A).gain, 0);
        assertEq(_book().realized, -int256(l.cost - navValue));
    }

    // ---- debt, payouts and records ----

    /// The fee on a moved-out gain is owed when the account holds no USDG: buys stop, a
    /// settle collects it once USDG is back.
    function test_DebtStopsBuysAndSettleCollectsIt() public {
        _fair(A);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        _priceUp();
        _ownerTransfer(A, owner, w);
        router.settle(account);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        _ownerTransfer(USDG, owner, _usdg(account));
        uint256 fee = router.settle(account);
        assertGt(fee, 0);
        assertEq(_book().debt, fee);
        deal(USDG, account, 1_000e6);
        _expectRevert(_intent(USDG, A, 100e6), FillmarkRouterV3.InDebt.selector);
        uint256 walletBefore = _usdg(agent);
        assertEq(router.settle(account), 0);
        assertEq(_book().debt, 0);
        assertEq(_usdg(agent) - walletBefore, fee);
    }

    /// A sale pays, from its proceeds, the fill fee, then its own escrow, then the debt.
    function test_SalePaysEscrowThenDebt() public {
        _fair(A);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        _priceUp();
        _ownerTransfer(A, owner, w / 2);
        router.settle(account);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        _ownerTransfer(USDG, owner, _usdg(account));
        uint256 debt = router.settle(account);
        assertEq(_book().debt, debt);
        _fair(A);
        uint256 walletBefore = _usdg(agent);
        vm.recordLogs();
        _exec(_intent(A, USDG, w - w / 2));
        (FillmarkRouterV3.Fill[] memory fs,) = _fills();
        FillmarkRouterV3.Hold memory h = _hold(A);
        assertEq(_book().debt, 0);
        assertEq(_usdg(agent) - walletBefore, debt);
        assertEq(_usdg(address(router)), h.esc);
        assertEq(_usdg(account), fs[0].usdgAmount - fs[0].fillFee - h.esc - debt);
    }

    /// An account that will not pay owes the fee; a sale cannot skip its escrow; paying
    /// debt from inside the sale's own debt payment is refused.
    function test_AnAccountThatDoesNotPayOwesTheFee() public {
        _fair(A);
        FakeAccountV3 fake = new FakeAccountV3(USDG);
        fake.install(address(router), _installData(agentId, 2_000e6, 20_000e6, _stocks()));
        deal(USDG, address(fake), 10_000e6);
        account = address(fake);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        _priceUp();
        fake.move(A, owner, w / 2);
        router.settle(account);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        fake.setRefuse(address(router));
        uint256 fee = router.settle(account);
        assertGt(fee, 0);
        assertEq(_book().debt, fee);
        _expectRevert(_intent(USDG, A, 100e6), FillmarkRouterV3.InDebt.selector);
        _fair(A);
        _expectRevert(_intent(A, USDG, w - w / 2), FillmarkRouterV3.PaymentFailed.selector);
        fake.setRefuse(address(0));
        fake.setReenter(address(router), agentId);
        uint256 walletBefore = _usdg(agent);
        _exec(_intent(A, USDG, w - w / 2));
        assertEq(fake.reentry(), abi.encodePacked(FillmarkRouterV3.Reentered.selector));
        assertEq(_book().debt, 0);
        assertEq(_usdg(agent) - walletBefore, fee);
    }

    function test_RevertWhen_AccountFakesTheFillFee() public {
        FakeAccountV3 fake = new FakeAccountV3(USDG);
        fake.install(address(router), _installData(agentId, 2_000e6, 20_000e6, _stocks()));
        deal(USDG, address(fake), 10_000e6);
        account = address(fake);
        fake.setRefuse(address(router)); // the fill fee goes through the router to the burner
        _expectRevert(_intent(USDG, WETH, 1_000e6), FillmarkRouterV3.PaymentFailed.selector);
        fake.setRefuse(address(0));
        _exec(_intent(USDG, WETH, 1_000e6));
        assertEq(_usdg(burner), 300_000);
    }

    /// USDG freezes the agent wallet: settle and closeOut still go through; what cannot be
    /// sent waits as a claim, which pays out once the wallet is unfrozen.
    function test_FrozenWalletPayoutWaitsAsAClaim() public {
        _fair(A);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        _priceUp();
        int256 pnl = _sell(A, w);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        address freezer = makeAddr("usdg-freezer");
        vm.prank(USDG_ADMIN);
        IUsdgAdmin(USDG).grantRole(USDG_FREEZE_ROLE, freezer);
        vm.prank(freezer);
        IUsdgAdmin(USDG).freeze(agent);
        assertTrue(IUsdgAdmin(USDG).isFrozen(agent));
        uint256 fee = router.settle(account);
        assertEq(fee, uint256(pnl) * PERF_BPS / 1e4);
        assertEq(router.claimable(agent), fee);
        assertEq(_book().debt, 0);
        assertEq(_book().paid, fee);
        vm.expectRevert();
        router.claim(agent);
        vm.prank(freezer);
        IUsdgAdmin(USDG).unfreeze(agent);
        uint256 before = _usdg(agent);
        router.claim(agent);
        assertEq(_usdg(agent) - before, fee);
        assertEq(router.claimable(agent), 0);
        vm.expectRevert(FillmarkRouterV3.BadAmount.selector);
        router.claim(agent);
    }

    /// The registry refuses the fill's record when the agent's owner approved the client
    /// account on the agent NFT. The fill stands; the refusal is counted and logged.
    function test_RefusedFeedbackIsCountedNotBlocking() public {
        vm.prank(agent);
        IIdentity(IDENTITY).approve(account, agentId);
        uint64 idx = IReputation(REPUTATION).getLastIndex(agentId, account);
        vm.recordLogs();
        _exec(_intent(USDG, WETH, 100e6));
        assertEq(_countLogs(FillmarkRouterV3.FeedbackFailed.selector), 2);
        assertEq(IReputation(REPUTATION).getLastIndex(agentId, account), idx);
        FillmarkRouterV3.Stats memory s = router.statsOf(agentId, account, WETH);
        assertEq(s.fills, 1);
        assertEq(s.feedbackFails, 2);
    }

    /// Second review, H1: a loser moved out books its loss at once, but the loss is undone if
    /// the units come back, so it must not free the escrow: settle keeps the fee on it.
    function test_MovedOutLossDoesNotFreeEscrow() public {
        _fair(A);
        uint256 w = _exec(_intent(USDG, A, 1_000e6));
        _priceUp();
        int256 pnl = _sell(A, w);
        uint256 esc = _esc(pnl);
        vm.warp(vm.getBlockTimestamp() + HOLD);
        _fair(TSLA);
        uint256 t = _exec(_intent(USDG, TSLA, 100e6)); // bought over NAV: a loss if moved out now
        _ownerTransfer(TSLA, owner, t);
        uint256 acctBefore = _usdg(account);
        uint256 fee = router.settle(account);
        FillmarkRouterV3.Book memory b = _book();
        assertGt(b.outLoss, 0);
        assertEq(fee, uint256(int256(b.realized)) * PERF_BPS / 1e4);
        assertGe(b.escMatured, uint256(b.outLoss) * PERF_BPS / 1e4); // still covers the loss coming back
        assertEq(_usdg(account) - acctBefore + fee + b.escMatured, esc);
        vm.prank(owner);
        IERC20(TSLA).transfer(account, t);
        router.settle(account); // the loss is undone: realized back up, still escrowed
        assertEq(_book().outLoss, 0);
        assertEq(_book().realized, pnl);
    }

    /// A sale of the agent's whole lot may be under the 10 USDG minimum, so a small lot can
    /// still be closed; part of it may not.
    function test_WholeLotSaleMayBeSmall() public {
        uint256 w = _exec(_intent(USDG, WETH, 10e6)); // worth under 10 USDG after the pool fee
        _expectRevert(_intent(WETH, USDG, w / 2), FillmarkRouterV3.TooSmall.selector);
        vm.recordLogs();
        _exec(_intent(WETH, USDG, w));
        (FillmarkRouterV3.Fill[] memory fs,) = _fills();
        assertLt(fs[0].usdgAmount, 10e6);
        assertEq(_lot(WETH).qty, 0);
        assertEq(router.statsOf(agentId, account, WETH).fills, 2); // the small sale is counted too
    }

    /// USDG freezes the burner: fills go on, the fill fee waits as the burner's claim.
    function test_FrozenBurnerDoesNotStopFills() public {
        address freezer = makeAddr("usdg-freezer");
        vm.prank(USDG_ADMIN);
        IUsdgAdmin(USDG).grantRole(USDG_FREEZE_ROLE, freezer);
        vm.prank(freezer);
        IUsdgAdmin(USDG).freeze(burner);
        _exec(_intent(USDG, WETH, 100e6));
        assertEq(router.claimable(burner), 30_000);
        assertEq(_usdg(address(router)), 30_000);
        vm.prank(freezer);
        IUsdgAdmin(USDG).unfreeze(burner);
        router.claim(burner);
        assertEq(_usdg(burner), 30_000);
    }

    // ---- removal ----

    /// An account that drops the router without its onUninstall running (another account
    /// implementation, or one that skips a failing call): anyone marks the book closing,
    /// which starts close-out's clock even while a token cannot be priced.
    function test_MarkClosingAfterARemovalWithoutOnUninstall() public {
        FakeAccountV3 fake = new FakeAccountV3(USDG);
        fake.install(address(router), _installData(agentId, 2_000e6, 20_000e6, _stocks()));
        deal(USDG, address(fake), 10_000e6);
        account = address(fake);
        _exec(_intent(USDG, WETH, 1_000e6));
        vm.expectRevert(FillmarkRouterV3.NotClosing.selector);
        router.markClosing(account); // the account still has the module
        fake.setModule(false);
        assertTrue(router.isInitialized(account));
        (,,, uint256 updatedAt,) = IAggregatorV3(ETH_FEED).latestRoundData();
        vm.warp(updatedAt + ETH_MAX_AGE + 1); // no price now
        vm.expectRevert(FillmarkRouterV3.StaleFeed.selector);
        router.closeOut(account, agentId); // would mark and value in one call, and reverts
        router.markClosing(account);
        assertFalse(router.isInitialized(account));
        uint64 closingAt = _book().closingAt;
        assertEq(closingAt, vm.getBlockTimestamp());
        vm.warp(closingAt + router.STUCK_AFTER());
        router.closeOut(account, agentId); // the feed has been silent since: valued at cost
        assertFalse(_book().closing);
        assertEq(router.openBook(account), 0);
    }

    function test_CloseOutWaitsForPriceThenValuesAStuckTokenAtCost() public {
        uint256 w = _exec(_intent(USDG, WETH, 1_000e6));
        int256 realized = _book().realized;
        (,,, uint256 updatedAt,) = IAggregatorV3(ETH_FEED).latestRoundData();
        vm.warp(updatedAt + ETH_MAX_AGE + 1);
        _uninstall();
        FillmarkRouterV3.Book memory b = _book();
        assertTrue(b.closing);
        _userOpReverts(_installCall(agentId), FillmarkRouterV3.CloseOutPending.selector);
        vm.expectRevert(FillmarkRouterV3.StaleFeed.selector);
        router.closeOut(account, agentId);
        vm.warp(b.closingAt + router.STUCK_AFTER());
        assertEq(router.closeOut(account, agentId), 0);
        assertEq(_book().realized, realized);
        assertEq(IERC20(WETH).balanceOf(account), w);
    }

    /// A removal given too little gas for its close-out leaves the book closing; the next
    /// install closes it out first.
    function test_InstallClosesOutABookLeftClosing() public {
        uint256 w = _exec(_intent(USDG, WETH, 1_000e6));
        int256 realized = _book().realized;
        uint256 value = router.navValueOf(w, _nav(ETH_FEED), 18);
        uint256 cost = _lot(WETH).cost;
        bool found;
        for (uint256 g = 60_000; g < 300_000; g += 2_000) {
            uint256 snap = vm.snapshotState();
            vm.prank(account);
            (bool ok,) =
                account.call{gas: g}(abi.encodeCall(IKernelV2.uninstallModule, (2, address(router), bytes(""))));
            if (ok && !router.isInitialized(account) && _book().closing) {
                found = true;
                break;
            }
            vm.revertToState(snap);
        }
        assertTrue(found, "no gas amount leaves the book closing");
        perf = 0;
        _install(agentId);
        FillmarkRouterV3.Book memory b = _book();
        assertFalse(b.closing);
        assertEq(b.perfFeeBps, 0);
        assertEq(b.realized, realized + int256(value) - int256(cost));
        assertEq(_lot(WETH).qty, 0);
    }

    function test_RevertWhen_CloseOutWhileInstalled() public {
        vm.expectRevert(FillmarkRouterV3.NotClosing.selector);
        router.closeOut(account, agentId);
    }

    function test_RevertWhen_OldIntentAfterReinstall() public {
        FillmarkRouterV3.FillIntent memory it = _intent(USDG, WETH, 100e6);
        _uninstall();
        _install(agentId);
        _expectRevert(it, FillmarkRouterV3.WrongInstall.selector);
    }

    /// A client on router v2 moves to v3 in one Kernel batch: remove v2, install v3.
    function test_MoveFromV2ToV3InOneBatch() public {
        FillmarkRouterV2 v2 = new FillmarkRouterV2(
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
        bytes memory v2Data = abi.encode(
            agentId,
            uint128(2_000e6),
            uint128(20_000e6),
            uint64(vm.getBlockTimestamp() + 30 days),
            slip,
            perf,
            _stocks()
        );
        account = _createAccountWith(address(v2), v2Data, 46);
        assertTrue(v2.isInitialized(account));
        assertFalse(router.isInitialized(account));
        deal(USDG, account, 1_000e6);
        Call[] memory c = new Call[](2);
        c[0] = Call(account, 0, abi.encodeCall(IKernelV2.uninstallModule, (2, address(v2), bytes(""))));
        c[1] = Call(
            account,
            0,
            abi.encodeCall(
                IKernelV2.installModule,
                (2, address(router), _kernelInit(_installData(agentId, 2_000e6, 20_000e6, _stocks())))
            )
        );
        _userOp(_batch(c));
        assertFalse(v2.isInitialized(account));
        assertTrue(router.isInitialized(account));
        _exec(_intent(USDG, WETH, 100e6));
    }

    // ---- stocks ----

    function test_BuyAndSellTsla() public {
        _fair(TSLA);
        uint256 bought = _exec(_intent(USDG, TSLA, 500e6));
        assertEq(IERC20(TSLA).balanceOf(account), bought);
        _exec(_intent(TSLA, USDG, bought));
        assertEq(IERC20(TSLA).balanceOf(account), 0);
    }

    function test_RevertWhen_MarketClosedOrOraclePaused() public {
        _fair(TSLA);
        feeds.addClosure(uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1 hours));
        _expectRevert(_intent(USDG, TSLA, 500e6), FillmarkRouterV3.MarketClosed.selector);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(ORACLE_PAUSER);
        IStockAdmin(TSLA).pauseOracle();
        _expectRevert(_intent(USDG, TSLA, 500e6), FillmarkRouterV3.OraclePaused.selector);
    }

    function test_RevertWhen_SettleWhileStockMarketClosed() public {
        _fair(TSLA);
        _exec(_intent(USDG, TSLA, 500e6));
        feeds.addClosure(uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1 hours));
        vm.expectRevert(FillmarkRouterV3.MarketClosed.selector);
        router.settle(account);
    }

    function test_RevertWhen_MultiplierNotPricedAtSettle() public {
        _fair(TSLA);
        _exec(_intent(USDG, TSLA, 500e6));
        uint256 m = IStockAdmin(TSLA).uiMultiplier();
        vm.prank(MULTIPLIER_UPDATER);
        IStockAdmin(TSLA).updateMultiplier(m + m / 1000);
        vm.expectRevert(FillmarkRouterV3.MultiplierNotPriced.selector);
        router.settle(account);
    }

    function test_EightDecimalTokenLedger() public {
        _fair(CBBTC);
        uint256 b = _exec(_intent(USDG, CBBTC, 500e6));
        assertEq(_lot(CBBTC).qty, b);
        assertApproxEqRel(router.navValueOf(b, _nav(CBBTC_FEED), 8), 500e6, 0.02e18);
        _exec(_intent(CBBTC, USDG, b));
        assertEq(_lot(CBBTC).qty, 0);
    }

    function test_GasOfFillsAndSettle() public {
        uint256 g = gasleft();
        uint256 w = _exec(_intent(USDG, WETH, 500e6));
        emit log_named_uint("gas buy", g - gasleft());
        g = gasleft();
        _exec(_intent(WETH, USDG, w / 2));
        emit log_named_uint("gas sell", g - gasleft());
        g = gasleft();
        router.settle(account);
        emit log_named_uint("gas settle, one token", g - gasleft());
    }

    // ---- scenario helpers ----

    /// A real Chainlink round of the asset's feed, replayed on the fork (see the v2
    /// tests), then the asset's pool moved to the new price and held there for the TWAP
    /// window, as arbitrage would.
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
        _fair(A);
    }

    /// The token's pool at its NAV with deep liquidity there, held for the TWAP window.
    function _fair(address token) internal {
        uint8 d = IERC20Metadata(token).decimals();
        _poolTo(token, _nav(_feedOf(token)), d == 8 ? 1e17 : 1e22);
        vm.warp(vm.getBlockTimestamp() + TWAP);
    }

    /// Moves the token's official pool to `price` (8 decimals) and adds `liq` around it.
    function _poolTo(address token, uint256 price, uint128 liq) internal {
        address pool = router.poolOf(token).pool;
        uint256 scale = 10 ** (uint256(IERC20Metadata(token).decimals()) + 2);
        uint160 target = token < USDG
            ? uint160(Math.sqrt(Math.mulDiv(price, 1 << 192, scale)))
            : uint160(Math.sqrt(Math.mulDiv(scale, 1 << 192, price)));
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (sqrtP != target) IUniswapV3Pool(pool).swap(address(this), target < sqrtP, type(int128).max, target, "");
        if (liq == 0) return;
        (, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        int24 s = IPoolAdmin(pool).tickSpacing();
        int24 lo = (tick / s) * s;
        IPoolMint(pool).mint(address(this), lo - s, lo + 2 * s, liq, "");
    }

    /// Sells and returns the PnL the router booked for the sale.
    function _sell(address stock, uint256 qty) internal returns (int256 pnl) {
        vm.recordLogs();
        _exec(_intent(stock, USDG, qty));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == FillmarkRouterV3.Booked.selector) {
                pnl = abi.decode(logs[i].data, (int256));
            }
        }
    }
}

/// A contract account that installs the router itself, can move its own tokens, and
/// answers a USDG transfer to `refuse` as done without making it.
contract FakeAccountV3 {
    address public immutable usdg;
    address public refuse;
    address public reenter; // calls payDebt on it before each USDG transfer
    uint256 public reenterAgent;
    bytes public reentry;

    constructor(address usdg_) {
        usdg = usdg_;
    }

    function setRefuse(address to) external {
        refuse = to;
    }

    function setReenter(address router, uint256 agentId) external {
        reenter = router;
        reenterAgent = agentId;
    }

    function install(address router, bytes calldata data) external {
        FillmarkRouterV3(router).onInstall(data);
        module = true;
    }

    bool public module;

    function setModule(bool on) external {
        module = on;
    }

    function isModuleInstalled(uint256, address, bytes calldata) external view returns (bool) {
        return module;
    }

    function move(address token, address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }

    function executeFromExecutor(bytes32, bytes calldata exec) external returns (bytes[] memory ret) {
        address target = address(bytes20(exec[0:20]));
        bytes calldata data = exec[52:];
        ret = new bytes[](1);
        if (target == usdg && bytes4(data[0:4]) == IERC20.transfer.selector) {
            if (reenter != address(0)) {
                (, reentry) = reenter.call(abi.encodeCall(FillmarkRouterV3.payDebt, (reenterAgent, 1)));
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
