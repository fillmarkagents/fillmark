// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ForkBase, IIdentity, IReputation, IStockAdmin} from "./ForkBase.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {FillmarkFeeds} from "../src/FillmarkFeeds.sol";
import {FillmarkRouter} from "../src/FillmarkRouter.sol";
import {
    IAggregatorV3,
    IIdentityRegistry,
    IReputationRegistry,
    IStockToken,
    IUniswapV3Factory,
    IUniswapV3Pool
} from "../src/interfaces/External.sol";

interface IKernel {
    function initialize(
        bytes21 rootValidator,
        address hook,
        bytes calldata validatorData,
        bytes calldata hookData,
        bytes[] calldata initConfig
    ) external;
    function installModule(uint256 moduleType, address module, bytes calldata initData) external payable;
    function uninstallModule(uint256 moduleType, address module, bytes calldata deInitData) external payable;
}

interface IKernelFactory {
    function createAccount(bytes calldata data, bytes32 salt) external payable returns (address);
}

struct PackedUserOperation {
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

interface IEntryPoint {
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function getUserOpHash(PackedUserOperation calldata op) external view returns (bytes32);
    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
}

interface IPoolLp {
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256, uint256);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 limit, bytes calldata data)
        external
        returns (int256, int256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// A contract anyone can deploy that "installs" the router, like a throwaway account.
contract SelfDealAccount {
    function install(address router, bytes calldata data) external {
        FillmarkRouter(router).onInstall(data);
    }

    function executeFromExecutor(bytes32, bytes calldata ec) external payable returns (bytes[] memory r) {
        (bool ok, bytes memory ret) = address(bytes20(ec[:20])).call(ec[52:]);
        require(ok);
        r = new bytes[](1);
        r[0] = ret;
    }
}

/// End-to-end fork tests on Robinhood Chain mainnet: real ERC-8004 registries,
/// Uniswap v3 factory and pools, Chainlink feeds, stock tokens, USDG, Kernel v3.1
/// accounts and EntryPoint v0.7. No mocks.
contract RouterForkTest is ForkBase {
    uint16 constant SLIP_BPS = 200;
    address constant TSLA_POOL_100 = 0x7868622Ff2C3b1B6C8acb15fE0bDAEBF043DDa48; // TSLA/USDG 0.01%, nearly empty

    FillmarkFeeds feeds;
    FillmarkRouter router;
    address guardian = makeAddr("guardian");

    address agent;
    uint256 agentKey;
    address owner;
    uint256 ownerKey;
    uint256 agentId;
    address account;
    uint256 nonce;
    uint16 slip = SLIP_BPS;

    function setUp() public {
        _fork();
        feeds = new FillmarkFeeds(address(this), guardian);
        feeds.addStock(TSLA, TSLA_FEED, 6 hours, true);
        feeds.addStock(NVDA, NVDA_FEED, 6 hours, true);
        feeds.addCrypto(WETH, ETH_FEED, ETH_MAX_AGE);
        feeds.addCrypto(CBBTC, CBBTC_FEED, CBBTC_MAX_AGE);
        // US equities after 1 Nov 2026 (EST): regular 14:30-21:00 UTC,
        // 24/5 week from Sunday 20:00 ET (Mon 01:00 UTC) to Friday 20:00 ET (Sat 01:00 UTC).
        feeds.addPeriod(FillmarkFeeds.Period(uint64(vm.getBlockTimestamp()), 52200, 75600, 90000, 522000));
        // The router only trades while the market is open, so the fork must be too.
        assertTrue(
            feeds.sessionAt(vm.getBlockTimestamp()) != FillmarkFeeds.Session.Closed,
            "fork block is outside market hours: set FILLMARK_FORK_BLOCK"
        );
        _assertFresh(TSLA_FEED, 6 hours);
        _assertFresh(NVDA_FEED, 6 hours);
        _assertFresh(ETH_FEED, ETH_MAX_AGE);
        _assertFresh(CBBTC_FEED, CBBTC_MAX_AGE);

        router = new FillmarkRouter(
            IIdentityRegistry(IDENTITY), IReputationRegistry(REPUTATION), IUniswapV3Factory(FACTORY), USDG, feeds
        );

        (agent, agentKey) = _key("agent");
        (owner, ownerKey) = _key("owner");
        vm.prank(agent);
        agentId = IIdentity(IDENTITY).register("");

        account = _createAccount(2_000e6, 5_000e6, _stocks(), 1);
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

    function _installData(uint128 maxPerTrade, uint128 dailyLimit, address[] memory stocks)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(agentId, maxPerTrade, dailyLimit, uint64(vm.getBlockTimestamp() + 30 days), slip, stocks);
    }

    /// A real Kernel v3.1 account with an ECDSA root validator and the router
    /// installed as executor during initialization.
    function _createAccount(uint128 maxPerTrade, uint128 dailyLimit, address[] memory stocks, uint256 salt)
        internal
        returns (address)
    {
        bytes[] memory initConfig = new bytes[](1);
        initConfig[0] = abi.encodeCall(
            IKernel.installModule,
            (
                2,
                address(router),
                abi.encodePacked(address(0), abi.encode(_installData(maxPerTrade, dailyLimit, stocks), bytes("")))
            )
        );
        bytes21 root = bytes21(abi.encodePacked(bytes1(0x01), ECDSA_VALIDATOR));
        bytes memory data =
            abi.encodeCall(IKernel.initialize, (root, address(1), abi.encodePacked(owner), bytes(""), initConfig));
        return IKernelFactory(KERNEL_FACTORY).createAccount(data, bytes32(salt));
    }

    function _installId(address acct) internal view returns (uint64 id) {
        (,,,, id,,,,,) = router.configs(acct);
    }

    function _intent(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        internal
        returns (FillmarkRouter.FillIntent memory it)
    {
        address pool = IUniswapV3Factory(FACTORY).getPool(tokenIn, tokenOut, fee);
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(pool).slot0();
        it = FillmarkRouter.FillIntent({
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

    function _sign(uint256 key, FillmarkRouter.FillIntent memory it) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, router.hashIntent(it));
        return abi.encodePacked(r, s, v);
    }

    function _exec(FillmarkRouter.FillIntent memory it) internal returns (uint256) {
        return router.execute(it, _sign(agentKey, it));
    }

    function _expectRevert(FillmarkRouter.FillIntent memory it, bytes4 err) internal {
        bytes memory sig = _sign(agentKey, it);
        vm.expectRevert(err);
        router.execute(it, sig);
    }

    function _ext() internal view returns (bool) {
        return feeds.sessionAt(vm.getBlockTimestamp()) == FillmarkFeeds.Session.Extended;
    }

    function _tag1(string memory kind) internal view returns (string memory) {
        return string.concat("fillmark-", kind, _ext() ? "-ext" : "");
    }

    function _tag2(address stock, uint256 usdgAmount) internal view returns (string memory) {
        return string.concat(feeds.tickerOf(stock), ":B", Strings.toString(router.bucketOf(usdgAmount)));
    }

    /// The registry's own summary of one client's feedback about the agent.
    function _summary(address client, string memory kind, string memory tag2)
        internal
        view
        returns (uint64 count, int128 value)
    {
        address[] memory clients = new address[](1);
        clients[0] = client;
        (count, value,) = IReputation(REPUTATION).getSummary(agentId, clients, _tag1(kind), tag2);
    }

    /// Decodes every Filled event recorded since vm.recordLogs().
    function _fillEvents() internal view returns (FillmarkRouter.Fill[] memory fs, FillmarkRouter.Prices[] memory ps) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == FillmarkRouter.Filled.selector) n++;
        }
        fs = new FillmarkRouter.Fill[](n);
        ps = new FillmarkRouter.Prices[](n);
        uint256 j;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(router) || logs[i].topics[0] != FillmarkRouter.Filled.selector) continue;
            (,, fs[j], ps[j]) = abi.decode(logs[i].data, (address, bytes32, FillmarkRouter.Fill, FillmarkRouter.Prices));
            j++;
        }
    }

    function _userOp(bytes memory callData) internal {
        PackedUserOperation memory op = PackedUserOperation({
            sender: account,
            nonce: IEntryPoint(ENTRYPOINT).getNonce(account, 0),
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32((uint256(500_000) << 128) | 500_000),
            preVerificationGas: 100_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | (block.basefee + 1 gwei)),
            paymasterAndData: "",
            signature: ""
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, IEntryPoint(ENTRYPOINT).getUserOpHash(op));
        op.signature = abi.encodePacked(r, s, v);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.deal(account, 1 ether);
        address bundler = makeAddr("bundler");
        vm.prank(bundler, bundler);
        IEntryPoint(ENTRYPOINT).handleOps(ops, payable(bundler));
    }

    // Liquidity the attacker adds in the attack tests is paid from dealt balances.
    function uniswapV3MintCallback(uint256 a0, uint256 a1, bytes calldata) external {
        _pay(IPoolLp(msg.sender).token0(), a0);
        _pay(IPoolLp(msg.sender).token1(), a1);
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        if (d0 > 0) _pay(IPoolLp(msg.sender).token0(), uint256(d0));
        if (d1 > 0) _pay(IPoolLp(msg.sender).token1(), uint256(d1));
    }

    function _pay(address token, uint256 amount) internal {
        if (amount == 0) return;
        deal(token, address(this), IERC20(token).balanceOf(address(this)) + amount);
        IERC20(token).transfer(msg.sender, amount);
    }

    // ---- execution ----

    function test_BuyAndSellTsla_TokenNeverTouchesRouter() public {
        uint256 usdgBefore = IERC20(USDG).balanceOf(account);
        uint256 bought = _exec(_intent(USDG, TSLA, 3000, 500e6));
        assertGt(bought, 0);
        assertEq(IERC20(TSLA).balanceOf(account), bought);
        assertEq(IERC20(USDG).balanceOf(account), usdgBefore - 500e6);

        uint256 got = _exec(_intent(TSLA, USDG, 3000, bought));
        assertEq(IERC20(TSLA).balanceOf(account), 0);
        assertEq(IERC20(USDG).balanceOf(account), usdgBefore - 500e6 + got);
        assertLt(got, 500e6); // two pool fees

        assertEq(IERC20(USDG).balanceOf(address(router)), 0);
        assertEq(IERC20(TSLA).balanceOf(address(router)), 0);
        // Each fill wrote two feedback entries from the client's own account.
        assertEq(IReputation(REPUTATION).getLastIndex(agentId, account), 4);
    }

    /// The fill's scores are written by the client's account, with the event's values.
    function test_FeedbackFromClientAccountMatchesFill() public {
        vm.recordLogs();
        uint256 n = _exec(_intent(USDG, NVDA, 500, 500e6));
        _exec(_intent(NVDA, USDG, 500, n));
        (FillmarkRouter.Fill[] memory fs, FillmarkRouter.Prices[] memory ps) = _fillEvents();
        string memory tag2 = _tag2(NVDA, fs[0].usdgAmount);
        assertEq(router.bucketOf(fs[0].usdgAmount), 4);
        for (uint256 i; i < 2; i++) {
            assertEq(fs[i].account, account);
            _checkFeedback(uint64(2 * i + 1), ps[i].cost, _tag1("cost"), tag2);
            _checkFeedback(uint64(2 * i + 2), int256(fs[i].usdgAmount), _tag1("notional"), tag2);
            // Cost = USDG paid over the NAV value bought, or NAV value sold over USDG received.
            int256 navValue = int256(Math.mulDiv(fs[i].stockAmount, ps[i].nav, 1e20));
            int256 usdgAmt = int256(fs[i].usdgAmount);
            assertEq(ps[i].cost, fs[i].buy ? usdgAmt - navValue : navValue - usdgAmt);
        }
        (uint64 count, int128 meanCost) = _summary(account, "cost", tag2);
        assertEq(count, 2);
        assertApproxEqAbs(meanCost, (ps[0].cost + ps[1].cost) / 2, 1);
        (, int128 meanNotional) = _summary(account, "notional", tag2);
        assertApproxEqAbs(meanNotional, int256(fs[0].usdgAmount + fs[1].usdgAmount) / 2, 1);
        // The router's own totals match, and a hand-written entry with the same tags
        // shows up in the registry but not in them.
        bytes32 key = router.statsKey(agentId, account, NVDA, 4, _ext());
        _checkStats(key, fs, ps);
        string memory tag1 = _tag1("cost");
        vm.prank(account);
        IReputationRegistry(REPUTATION).giveFeedback(agentId, -50e6, 6, tag1, tag2, "", "", 0);
        (count,) = _summary(account, "cost", tag2);
        assertEq(count, 3);
        (uint32 fills,,,) = router.stats(key);
        assertEq(fills, 2);
        // Nothing is written under the router's address.
        assertEq(IReputation(REPUTATION).getLastIndex(agentId, address(router)), 0);
    }

    function _checkStats(bytes32 key, FillmarkRouter.Fill[] memory fs, FillmarkRouter.Prices[] memory ps)
        internal
        view
    {
        (uint32 fills, uint128 notional, int64 worst, int128 sumCost) = router.stats(key);
        assertEq(fills, 2);
        assertEq(notional, fs[0].usdgAmount + fs[1].usdgAmount);
        assertEq(sumCost, ps[0].cost + ps[1].cost);
        int256 r0 = ps[0].cost * 1e6 / int256(fs[0].usdgAmount);
        int256 r1 = ps[1].cost * 1e6 / int256(fs[1].usdgAmount);
        assertEq(worst, r0 > r1 ? r0 : r1);
        FillmarkRouter.Stats memory all = router.statsOf(agentId, account, NVDA);
        assertEq(all.fills, fills);
        assertEq(all.notional, notional);
        assertEq(all.worst, worst);
        assertEq(all.sumCost, sumCost);
    }

    function _checkFeedback(uint64 index, int256 value, string memory tag1, string memory tag2) internal view {
        (int128 v, uint8 dec, string memory t1, string memory t2, bool revoked) =
            IReputation(REPUTATION).readFeedback(agentId, account, index);
        assertEq(v, value);
        assertEq(dec, 6);
        assertEq(t1, tag1);
        assertEq(t2, tag2);
        assertFalse(revoked);
    }

    /// A pool sitting at the NAV reads back as the NAV for any token decimals, with the
    /// token on either side of the pool.
    function test_SpotPriceMatchesNavInBothOrientations() public view {
        uint256 nav = _nav();
        uint8[6] memory decs = [0, 6, 7, 8, 9, 18];
        for (uint256 i; i < decs.length; i++) {
            uint256 scale = 10 ** (uint256(decs[i]) + 2); // raw USDG per raw token = nav / scale
            uint160 s0 = uint160(Math.sqrt(Math.mulDiv(nav, 1 << 192, scale)));
            assertApproxEqRel(router.spotPrice(s0, true, decs[i]), nav, 1e12);
            uint160 s1 = uint160(Math.sqrt(Math.mulDiv(scale, 1 << 192, nav)));
            assertApproxEqRel(router.spotPrice(s1, false, decs[i]), nav, 1e12);
        }
    }

    function test_PricesMatchFeed_BothOrientationsAndSides() public {
        // TSLA is token0 in its pool, NVDA is token1 in its pool.
        vm.recordLogs();
        uint256 t = _exec(_intent(USDG, TSLA, 3000, 200e6));
        _exec(_intent(TSLA, USDG, 3000, t));
        uint256 n = _exec(_intent(USDG, NVDA, 500, 200e6));
        _exec(_intent(NVDA, USDG, 500, n));
        (FillmarkRouter.Fill[] memory fs, FillmarkRouter.Prices[] memory ps) = _fillEvents();
        assertEq(fs.length, 4);
        for (uint256 i; i < 4; i++) {
            // A wrong orientation or decimal is off by orders of magnitude.
            assertApproxEqRel(ps[i].spot, ps[i].nav, 0.05e18);
            assertApproxEqRel(ps[i].fill, ps[i].nav, 0.05e18);
            // Impact is at least the pool fee on both sides, in bps * 100.
            assertGe(ps[i].impact, fs[i].stock == TSLA ? int256(2_900) : int256(400));
            // shortfall ~= premium + impact
            assertApproxEqAbs(ps[i].shortfall, ps[i].premium + ps[i].impact, 50);
            assertEq(uint8(fs[i].session), uint8(feeds.sessionAt(vm.getBlockTimestamp())));
        }
        assertFalse(fs[0].buy == fs[1].buy);
    }

    function test_RevertWhen_SignedByOtherKey() public {
        (, uint256 otherKey) = _key("other");
        FillmarkRouter.FillIntent memory it = _intent(USDG, TSLA, 3000, 100e6);
        bytes memory sig = _sign(otherKey, it);
        vm.expectRevert(FillmarkRouter.BadSignature.selector);
        router.execute(it, sig);
    }

    function test_RevertWhen_AgentNftTransferred() public {
        vm.prank(agent);
        IIdentity(IDENTITY).transferFrom(agent, makeAddr("buyer"), agentId);
        assertEq(IIdentity(IDENTITY).getAgentWallet(agentId), address(0));
        _expectRevert(_intent(USDG, TSLA, 3000, 100e6), FillmarkRouter.WalletChanged.selector);
    }

    /// Review finding 3: a buyer of the agent NFT sets its own wallet. It must not
    /// inherit the client accounts that installed this agent.
    function test_RevertWhen_NewNftOwnerSetsOwnWallet() public {
        (address buyer, uint256 buyerKey) = _key("buyer");
        vm.prank(agent);
        IIdentity(IDENTITY).transferFrom(agent, buyer, agentId);
        uint256 deadline = vm.getBlockTimestamp() + 4 minutes;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"),
                agentId,
                buyer,
                buyer,
                deadline
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                IDENTITY
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        vm.prank(buyer);
        IIdentity(IDENTITY).setAgentWallet(agentId, buyer, deadline, abi.encodePacked(r, s, v));
        assertEq(IIdentity(IDENTITY).getAgentWallet(agentId), buyer);

        FillmarkRouter.FillIntent memory it = _intent(USDG, TSLA, 3000, 100e6);
        bytes memory sig = _sign(buyerKey, it);
        vm.expectRevert(FillmarkRouter.WalletChanged.selector);
        router.execute(it, sig);
    }

    function test_RevertWhen_CallbackNotFromActivePool() public {
        vm.expectRevert(FillmarkRouter.BadCallback.selector);
        router.uniswapV3SwapCallback(1e6, 0, "");
        address pool = IUniswapV3Factory(FACTORY).getPool(USDG, TSLA, 3000);
        vm.prank(pool);
        vm.expectRevert(FillmarkRouter.BadCallback.selector);
        router.uniswapV3SwapCallback(1e6, 0, "");
    }

    function test_RevertWhen_PoolPriceMovedPastMaxDev() public {
        FillmarkRouter.FillIntent memory it = _intent(USDG, TSLA, 3000, 100e6);
        it.refSqrtPriceX96 = uint160(uint256(it.refSqrtPriceX96) * 1005 / 1000); // about 1% in price
        _expectRevert(it, FillmarkRouter.PriceMoved.selector);
    }

    function test_RevertWhen_NonceReplayed() public {
        FillmarkRouter.FillIntent memory it = _intent(USDG, TSLA, 3000, 100e6);
        bytes memory sig = _sign(agentKey, it);
        router.execute(it, sig);
        vm.expectRevert(FillmarkRouter.NonceUsed.selector);
        router.execute(it, sig);
    }

    function test_RevertWhen_ExpiredOrNoPoolOrWrongAgent() public {
        FillmarkRouter.FillIntent memory it = _intent(USDG, TSLA, 3000, 100e6);
        it.deadline = uint64(vm.getBlockTimestamp() - 1);
        _expectRevert(it, FillmarkRouter.Expired.selector);

        it = _intent(USDG, TSLA, 3000, 100e6);
        it.fee = 2500;
        _expectRevert(it, FillmarkRouter.NoPool.selector);

        it = _intent(USDG, TSLA, 3000, 100e6);
        it.agentId = agentId + 1;
        _expectRevert(it, FillmarkRouter.WrongAgent.selector);
    }

    function test_RevertWhen_OverLimits() public {
        _expectRevert(_intent(USDG, TSLA, 3000, 2_001e6), FillmarkRouter.OverTradeLimit.selector);
        _exec(_intent(USDG, NVDA, 500, 2_000e6));
        _exec(_intent(USDG, NVDA, 500, 2_000e6));
        _expectRevert(_intent(USDG, NVDA, 500, 1_001e6), FillmarkRouter.OverDailyLimit.selector);
    }

    function test_RevertWhen_StockNotAllowedOrPairWithoutUsdg() public {
        address[] memory onlyNvda = new address[](1);
        onlyNvda[0] = NVDA;
        account = _createAccount(2_000e6, 5_000e6, onlyNvda, 2);
        deal(USDG, account, 1_000e6);
        _expectRevert(_intent(USDG, TSLA, 3000, 100e6), FillmarkRouter.StockNotAllowed.selector);
        _expectRevert(_intent(NVDA, TSLA, 3000, 1e18), FillmarkRouter.BadPair.selector);
    }

    function test_RevertWhen_BadInstallConfig() public {
        vm.prank(makeAddr("acct-a"));
        vm.expectRevert(FillmarkRouter.BadConfig.selector);
        router.onInstall(
            abi.encode(
                agentId, uint128(1e9), uint128(1e9), uint64(vm.getBlockTimestamp() + 1 days), uint16(0), _stocks()
            )
        );
        vm.prank(makeAddr("acct-b"));
        vm.expectRevert(FillmarkRouter.BadConfig.selector);
        router.onInstall(
            abi.encode(
                agentId, uint128(1e9), uint128(1e9), uint64(vm.getBlockTimestamp() + 1 days), uint16(1_001), _stocks()
            )
        );
    }

    function test_RevertWhen_TooLittleOut() public {
        FillmarkRouter.FillIntent memory it = _intent(USDG, TSLA, 3000, 100e6);
        it.minOut = type(uint256).max;
        _expectRevert(it, FillmarkRouter.TooLittleOut.selector);
    }

    function test_RevertWhen_PoolCannotFillAllInput() public {
        // The NVDA/USDG 0.01% pool holds well under $10 of liquidity.
        FillmarkRouter.FillIntent memory it = _intent(USDG, NVDA, 100, 1_000e6);
        // Cap the price walk so the pool stops early instead of sweeping every tick.
        it.sqrtPriceLimitX96 = USDG < NVDA
            ? uint160(uint256(it.refSqrtPriceX96) * 99 / 100)
            : uint160(uint256(it.refSqrtPriceX96) * 101 / 100);
        _expectRevert(it, FillmarkRouter.PartialFill.selector);
    }

    function test_RevertWhen_FeedStale() public {
        (,,, uint256 updatedAt,) = IAggregatorV3(TSLA_FEED).latestRoundData();
        vm.warp(updatedAt + 6 hours + 1);
        _expectRevert(_intent(USDG, TSLA, 3000, 500e6), FillmarkRouter.StaleFeed.selector);
    }

    function test_RevertWhen_OraclePaused() public {
        vm.prank(ORACLE_PAUSER);
        IStockAdmin(TSLA).pauseOracle();
        _expectRevert(_intent(USDG, TSLA, 3000, 500e6), FillmarkRouter.OraclePaused.selector);
    }

    function test_RevertWhen_MarketClosed() public {
        feeds.addClosure(uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1 hours));
        _expectRevert(_intent(USDG, TSLA, 3000, 500e6), FillmarkRouter.MarketClosed.selector);
    }

    /// Fills under $10 would fall outside every size bucket, so they are not executed.
    function test_RevertWhen_UnderTenDollars() public {
        _expectRevert(_intent(USDG, TSLA, 3000, 9_999_999), FillmarkRouter.TooSmall.selector);
        uint256 held = _exec(_intent(USDG, TSLA, 3000, 20e6));
        _expectRevert(_intent(TSLA, USDG, 3000, held / 3), FillmarkRouter.TooSmall.selector);
    }

    function test_UninstallStopsAgentImmediately() public {
        _exec(_intent(USDG, TSLA, 3000, 100e6));
        _userOp(abi.encodeCall(IKernel.uninstallModule, (2, address(router), bytes(""))));
        assertFalse(router.isInitialized(account));
        _expectRevert(_intent(USDG, TSLA, 3000, 100e6), FillmarkRouter.NotInstalled.selector);
    }

    /// Review finding 6: an intent signed before an uninstall must not run after a reinstall.
    function test_RevertWhen_OldIntentAfterReinstall() public {
        FillmarkRouter.FillIntent memory it = _intent(USDG, TSLA, 3000, 100e6);
        bytes memory sig = _sign(agentKey, it);
        _userOp(abi.encodeCall(IKernel.uninstallModule, (2, address(router), bytes(""))));
        bytes memory initData =
            abi.encodePacked(address(0), abi.encode(_installData(2_000e6, 5_000e6, _stocks()), bytes("")));
        _userOp(abi.encodeCall(IKernel.installModule, (2, address(router), initData)));
        assertTrue(router.isInitialized(account));
        assertEq(_installId(account), it.installId + 1);
        vm.expectRevert(FillmarkRouter.WrongInstall.selector);
        router.execute(it, sig);
    }

    // ---- attacks from the independent review ----

    /// Review finding 1: the agent funds a range at about $0.001 per share in the
    /// empty official 0.01% pool and sells the client's whole position into it.
    function test_RevertWhen_AgentSellsClientStockIntoOwnRange() public {
        uint256 held = _exec(_intent(USDG, TSLA, 3000, 1_900e6));
        address pool = IUniswapV3Factory(FACTORY).getPool(TSLA, USDG, 100);
        IPoolLp(pool).mint(address(this), -345600, -345400, 1e14, "");
        _expectRevert(_intent(TSLA, USDG, 100, held), FillmarkRouter.WorseThanNav.selector);
        assertEq(IERC20(TSLA).balanceOf(account), held);
    }

    /// The same attack on the buy side: the agent sells its own TSLA to the client
    /// far above NAV from a range just above the empty pool's price.
    function test_RevertWhen_AgentSellsOwnStockToClientAboveNav() public {
        address pool = IUniswapV3Factory(FACTORY).getPool(TSLA, USDG, 100);
        (, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        IPoolLp(pool).mint(address(this), tick + 1, tick + 200, 1e15, "");
        _expectRevert(_intent(USDG, TSLA, 100, 1_000e6), FillmarkRouter.WorseThanNav.selector);
    }

    function _nav() internal view returns (uint256) {
        (, int256 a,,,) = IAggregatorV3(TSLA_FEED).latestRoundData();
        return uint256(a);
    }

    /// sqrtPriceX96 of TSLA (token0) at nav * num / den.
    function _sqrtAt(uint256 num, uint256 den) internal view returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(_nav() * num / den, 1 << 192, 1e20)));
    }

    /// Moves the nearly empty 0.01% pool's spot to `target` and returns its tick there.
    function _moveSpot(uint160 target) internal returns (int24 tick) {
        (uint160 cur,,,,,,) = IUniswapV3Pool(TSLA_POOL_100).slot0();
        if (target != cur) IPoolLp(TSLA_POOL_100).swap(address(this), target < cur, type(int128).max, target, "");
        (cur, tick,,,,,) = IUniswapV3Pool(TSLA_POOL_100).slot0();
        assertEq(cur, target, "spot not moved");
    }

    /// The cost entry of the client's latest fill (written just before its notional).
    function _lastCost(address client) internal view returns (int128 v) {
        (v,,,,) = IReputation(REPUTATION)
            .readFeedback(agentId, client, IReputation(REPUTATION).getLastIndex(agentId, client) - 1);
    }

    /// With maxSlipBps 500 the agent sells the client's TSLA about 3.6% under NAV
    /// into its own range. The router allows it (the client accepted 5%), and the
    /// client's own account records the full shortfall.
    function test_BadFillIsRecordedInFull_Sell() public {
        slip = 500;
        account = _createAccount(2_000e6, 5_000e6, _stocks(), 77);
        deal(USDG, account, 10_000e6);
        uint256 held = _exec(_intent(USDG, TSLA, 3000, 1_000e6));
        _sellIntoOwnRange(held);
    }

    function _sellIntoOwnRange(uint256 held) internal returns (int256 cost) {
        int24 lo = _moveSpot(_sqrtAt(960, 1000));
        int24 hi = _moveSpot(_sqrtAt(965, 1000));
        _moveSpot(_sqrtAt(1, 1));
        IPoolLp(TSLA_POOL_100).mint(address(this), lo, hi, 1e17, "");

        vm.recordLogs();
        _exec(_intent(TSLA, USDG, 100, held));
        (, FillmarkRouter.Prices[] memory ps) = _fillEvents();
        assertGt(ps[0].shortfall, 30_000);
        assertLt(ps[0].shortfall, 50_000);
        cost = ps[0].cost;
        assertGt(cost, 30e6); // over $30 lost on about $985 of NAV value
        assertEq(_lastCost(account), cost);
    }

    /// maxSlipBps 200. The agent pushes the empty pool 4% under NAV, then the
    /// client's buy crosses the gap into the agent's range 1.5% over NAV.
    function test_BadFillIsRecordedInFull_Buy() public {
        int24 lo = _moveSpot(_sqrtAt(1015, 1000));
        int24 hi = _moveSpot(_sqrtAt(1020, 1000));
        _moveSpot(_sqrtAt(96, 100));
        IPoolLp(TSLA_POOL_100).mint(address(this), lo, hi, 1e17, "");

        vm.recordLogs();
        _exec(_intent(USDG, TSLA, 100, 500e6));
        (, FillmarkRouter.Prices[] memory ps) = _fillEvents();
        assertGt(ps[0].shortfall, 14_000);
        assertLt(ps[0].premium, -30_000);
        assertGt(ps[0].cost, 0);
        assertEq(_lastCost(account), ps[0].cost);
    }

    /// maxSlipBps bounds the buy price at NAV * (1 + slip), the same distance as on
    /// the sell side (it was NAV / (1 - slip), 2.04% at 200).
    function test_BuyBoundIsPriceDeviation() public {
        int24 t = _moveSpot(_sqrtAt(10_201, 10_000));
        IPoolLp(TSLA_POOL_100).mint(address(this), t, t + 3, 1e18, "");
        _expectRevert(_intent(USDG, TSLA, 100, 100e6), FillmarkRouter.WorseThanNav.selector);

        slip = 300;
        account = _createAccount(2_000e6, 5_000e6, _stocks(), 78);
        deal(USDG, account, 1_000e6);
        vm.recordLogs();
        _exec(_intent(USDG, TSLA, 100, 100e6));
        (, FillmarkRouter.Prices[] memory ps) = _fillEvents();
        // Between NAV * 1.02 and NAV / 0.98: rejected at 200 now, accepted before the fix.
        assertGt(ps[0].shortfall, 20_000);
        assertLt(ps[0].shortfall, 20_408);
    }

    /// Third review, H-2: the agent takes 3.6% from a real client, then makes
    /// self-dealt fills from throwaway accounts far better than NAV. Each fake fill
    /// lands under its own throwaway address; the real client's record still shows
    /// exactly its own loss, so a reader that trusts that client sees it whole.
    function test_SybilFillsCannotDiluteClientRecord() public {
        slip = 500;
        account = _createAccount(2_000e6, 5_000e6, _stocks(), 77);
        deal(USDG, account, 10_000e6);
        uint256 held = _exec(_intent(USDG, TSLA, 3000, 1_000e6));
        address client = account;
        int256 loss = _sellIntoOwnRange(held);
        string memory tag2 = _tag2(TSLA, 950e6);

        int24 lo = _moveSpot(_sqrtAt(970, 1000));
        int24 hi = _moveSpot(_sqrtAt(980, 1000));
        _moveSpot(_sqrtAt(9655, 10000));
        IPoolLp(TSLA_POOL_100).mint(address(this), lo, hi, 1e18, "");
        address[] memory fakes = new address[](4);
        for (uint256 i; i < 4; i++) {
            SelfDealAccount fake = new SelfDealAccount();
            address[] memory s = new address[](1);
            s[0] = TSLA;
            fake.install(address(router), _installData(1e12, 1e12, s));
            deal(USDG, address(fake), 500e6);
            account = address(fake);
            _exec(_intent(USDG, TSLA, 100, 500e6));
            fakes[i] = address(fake);
            assertLt(_lastCost(address(fake)), 0);
        }

        (uint64 count, int128 value) = _summary(client, "cost", tag2);
        assertEq(count, 1);
        assertEq(value, loss);
        (count, value) = _summary(fakes[0], "cost", _tag2(TSLA, 500e6));
        assertEq(count, 1);
        assertLt(value, 0);
    }

    /// Third review, H-1: the agent owner cannot skip feedback. If the owner makes
    /// the client account an approved operator, giveFeedback reverts and so does the
    /// fill: blocking the record blocks trading.
    function test_RevertWhen_OwnerBlocksFeedback() public {
        FillmarkRouter.FillIntent memory it = _intent(USDG, NVDA, 500, 500e6);
        bytes memory sig = _sign(agentKey, it);
        vm.prank(agent);
        IIdentity(IDENTITY).approve(account, agentId);
        vm.expectRevert();
        router.execute(it, sig);

        vm.prank(agent);
        IIdentity(IDENTITY).approve(address(0), agentId);
        router.execute(it, sig);
        assertEq(IReputation(REPUTATION).getLastIndex(agentId, account), 2);
    }

    /// Third review, L-1: a multiplier that took effect after the last feed round
    /// is not priced into the NAV yet, so the router waits for the next round.
    function test_RevertWhen_MultiplierNotPriced() public {
        uint256 m = IStockAdmin(TSLA).uiMultiplier();
        vm.prank(MULTIPLIER_UPDATER);
        IStockAdmin(TSLA).updateMultiplier(m + m / 1000);
        _expectRevert(_intent(USDG, TSLA, 3000, 500e6), FillmarkRouter.MultiplierNotPriced.selector);
        // NVDA's last multiplier change is older than its last round.
        _exec(_intent(USDG, NVDA, 500, 500e6));
    }

    /// GLD's feed prices the underlying alone, so GLD trades only while its multiplier
    /// is 1: after a change, every fill stops, whatever the feed does next.
    function test_PlainFeedTokenTradesOnlyAtMultiplierOne() public {
        // The max age is the limit, so this test does not depend on GLD's feed cadence.
        feeds.addStock(GLD, GLD_FEED, 25 hours, false);
        assertFalse(feeds.sourceOf(GLD, vm.getBlockTimestamp()).multiplierInFeed);
        assertEq(IStockAdmin(GLD).uiMultiplier(), 1e18);
        // A plain feed is never used at a multiplier other than 1, even with no pending
        // change: this stock's multiplier changed before its feed's last round, so the
        // effectiveAt check alone would let the buy through at a NAV off by that multiplier.
        (address other, address otherFeed, uint24 fee) = _settledMultiplierStock();
        feeds.addStock(other, otherFeed, 25 hours, false); // wrong on purpose: its feed includes it
        address[] memory s = new address[](2);
        s[0] = GLD;
        s[1] = other;
        account = _createAccount(2_000e6, 5_000e6, s, 90);
        deal(USDG, account, 1_000e6);
        _expectRevert(_intent(USDG, other, fee, 200e6), FillmarkRouter.MultiplierNotPriced.selector);

        vm.recordLogs();
        uint256 g = _exec(_intent(USDG, GLD, 500, 200e6));
        (FillmarkRouter.Fill[] memory fs, FillmarkRouter.Prices[] memory ps) = _fillEvents();
        assertApproxEqRel(ps[0].fill, ps[0].nav, 0.02e18);
        assertEq(fs[0].stockAmount, g);

        vm.prank(MULTIPLIER_UPDATER);
        IStockAdmin(GLD).updateMultiplier(1e18 + 1e15);
        assertEq(IStockAdmin(GLD).uiMultiplier(), 1e18 + 1e15);
        _expectRevert(_intent(GLD, USDG, 500, g), FillmarkRouter.MultiplierNotPriced.selector);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        _expectRevert(_intent(GLD, USDG, 500, g), FillmarkRouter.MultiplierNotPriced.selector);
    }

    /// A stock from assets.json, not yet in `feeds`, whose multiplier is above 1 and took
    /// effect before its feed's current round (so only the plain-feed check can stop it),
    /// with a fresh enough feed and a USDG pool. Real data; most dividend payers qualify.
    function _settledMultiplierStock() internal returns (address token, address feed, uint24 fee) {
        (Deploy.Stock[] memory list,) = new Deploy().assets();
        uint24[2] memory fees = [uint24(500), 3000];
        for (uint256 i; i < list.length; i++) {
            token = list[i].token;
            feed = list[i].feed;
            if (feeds.feedOf(token) != address(0) || IStockAdmin(token).uiMultiplier() <= 1e18) continue;
            (,, uint256 startedAt, uint256 updatedAt,) = IAggregatorV3(feed).latestRoundData();
            if (IStockToken(token).effectiveAt() >= startedAt || vm.getBlockTimestamp() - updatedAt > 25 hours) {
                continue;
            }
            if (IStockToken(token).oraclePaused()) continue;
            for (uint256 j; j < 2; j++) {
                if (IUniswapV3Factory(FACTORY).getPool(USDG, token, fees[j]) != address(0)) {
                    return (token, feed, fees[j]);
                }
            }
        }
        revert("no stock with a settled multiplier above 1 at this fork block");
    }

    // ---- calendar ----

    function test_SessionCalendar() public {
        uint256 day = vm.getBlockTimestamp() / 1 days + 1;
        while ((day + 4) % 7 != 1) day++; // next Monday
        uint256 mon = day * 1 days;
        assertEq(uint8(feeds.sessionAt(mon + 30 minutes)), uint8(FillmarkFeeds.Session.Closed)); // Sun 19:30 ET
        assertEq(uint8(feeds.sessionAt(mon + 2 hours)), uint8(FillmarkFeeds.Session.Extended));
        assertEq(uint8(feeds.sessionAt(mon + 15 hours)), uint8(FillmarkFeeds.Session.Regular)); // 10:00 ET
        assertEq(uint8(feeds.sessionAt(mon + 21 hours)), uint8(FillmarkFeeds.Session.Extended)); // 16:00 ET
        assertEq(uint8(feeds.sessionAt(mon + 4 days + 23 hours)), uint8(FillmarkFeeds.Session.Extended)); // Fri 18:00 ET
        assertEq(uint8(feeds.sessionAt(mon + 5 days + 2 hours)), uint8(FillmarkFeeds.Session.Closed)); // Fri 21:00 ET
        assertEq(uint8(feeds.sessionAt(mon + 5 days + 15 hours)), uint8(FillmarkFeeds.Session.Closed)); // Saturday

        // A holiday closes the market from 20:00 ET the evening before to 20:00 ET on the day.
        uint64 wed = uint64(mon + 2 days + 1 hours); // Tue 20:00 ET
        feeds.addClosure(wed, wed + 1 days);
        assertEq(uint8(feeds.sessionAt(wed + 14 hours)), uint8(FillmarkFeeds.Session.Closed)); // Wed 10:00 ET
        assertEq(uint8(feeds.sessionAt(wed + 1 days)), uint8(FillmarkFeeds.Session.Extended)); // Wed 20:00 ET
        assertEq(uint8(feeds.sessionAt(wed - 1)), uint8(FillmarkFeeds.Session.Extended));

        // An unscheduled closure can still go in before a later one, and lookups stay sorted.
        uint64 mon10 = uint64(mon + 15 hours);
        feeds.addClosure(mon10, mon10 + 2 hours);
        assertEq(feeds.closure(0).start, mon10);
        assertEq(feeds.closure(1).start, wed);
        assertEq(uint8(feeds.sessionAt(mon10 + 1 hours)), uint8(FillmarkFeeds.Session.Closed));
        assertEq(uint8(feeds.sessionAt(mon10 + 2 hours)), uint8(FillmarkFeeds.Session.Regular));
        assertEq(uint8(feeds.sessionAt(wed + 14 hours)), uint8(FillmarkFeeds.Session.Closed));
        vm.expectRevert(FillmarkFeeds.BadInput.selector);
        feeds.addClosure(mon10 + 1 hours, mon10 + 3 hours); // overlaps the one before
        vm.expectRevert(FillmarkFeeds.BadInput.selector);
        feeds.addClosure(wed - 1 hours, wed + 1); // overlaps the one after

        // DST: a new period takes over from its start.
        feeds.addPeriod(FillmarkFeeds.Period(uint64(mon + 7 days), 48600, 72000, 86400, 518400));
        assertEq(uint8(feeds.sessionAt(mon + 7 days + 14 hours)), uint8(FillmarkFeeds.Session.Regular)); // 10:00 EDT
        assertEq(uint8(feeds.sessionAt(mon + 14 hours)), uint8(FillmarkFeeds.Session.Extended)); // 09:00 EST
    }

    function test_FeedsAreAddOnly() public {
        vm.expectRevert(FillmarkFeeds.AlreadySet.selector);
        feeds.addStock(TSLA, NVDA_FEED, 6 hours, true);
        vm.expectRevert(FillmarkFeeds.BadInput.selector);
        feeds.addStock(USDG, TSLA_FEED, 6 hours, true); // not a stock token: no oraclePaused()
        FillmarkFeeds f = new FillmarkFeeds(address(this), guardian);
        vm.expectRevert(FillmarkFeeds.BadInput.selector);
        f.addStock(TSLA, TSLA_FEED, 1 hours - 1, true);
        vm.expectRevert(FillmarkFeeds.BadInput.selector);
        f.addStock(TSLA, TSLA_FEED, 25 hours + 1, true);
        f.addStock(TSLA, TSLA_FEED, 25 hours, true);
        assertEq(f.sourceOf(TSLA, vm.getBlockTimestamp()).maxAge, 25 hours);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(FillmarkFeeds.NotAdmin.selector);
        feeds.addClosure(uint64(vm.getBlockTimestamp() + 1 days), uint64(vm.getBlockTimestamp() + 2 days));
        FillmarkFeeds.Period memory p = feeds.period(0);
        vm.expectRevert(FillmarkFeeds.BadInput.selector);
        feeds.addPeriod(p); // same start is rejected
        feeds.addClosure(uint64(vm.getBlockTimestamp() + 1 days), uint64(vm.getBlockTimestamp() + 2 days));
        vm.expectRevert(FillmarkFeeds.BadInput.selector);
        feeds.addClosure(uint64(vm.getBlockTimestamp() + 1 days + 1 hours), uint64(vm.getBlockTimestamp() + 3 days)); // overlap
    }

    // ---- crypto ----

    /// WETH trades around the clock: a market closure stops TSLA but not WETH, and
    /// WETH fills are scored as regular-session fills against the ETH / USD feed.
    function test_CryptoTradesThroughClosureAndIsScored() public {
        feeds.addClosure(uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 1 hours));
        _expectRevert(_intent(USDG, TSLA, 3000, 500e6), FillmarkRouter.MarketClosed.selector);
        assertEq(uint8(feeds.sessionOf(WETH, vm.getBlockTimestamp())), uint8(FillmarkFeeds.Session.Regular));

        vm.recordLogs();
        uint256 w = _exec(_intent(USDG, WETH, 100, 500e6));
        assertEq(IERC20(WETH).balanceOf(account), w);
        _exec(_intent(WETH, USDG, 100, w));
        (FillmarkRouter.Fill[] memory fs, FillmarkRouter.Prices[] memory ps) = _fillEvents();
        (, int256 nav,,,) = IAggregatorV3(ETH_FEED).latestRoundData();
        string memory tag2 = _tag2(WETH, fs[0].usdgAmount);
        assertEq(tag2, string.concat("WETH:B", Strings.toString(router.bucketOf(fs[0].usdgAmount))));
        for (uint256 i; i < 2; i++) {
            assertEq(uint8(fs[i].session), uint8(FillmarkFeeds.Session.Regular));
            assertEq(ps[i].nav, uint256(nav));
            assertApproxEqRel(ps[i].fill, ps[i].nav, 0.02e18);
            _checkFeedback(uint64(2 * i + 1), ps[i].cost, "fillmark-cost", tag2);
            _checkFeedback(uint64(2 * i + 2), int256(fs[i].usdgAmount), "fillmark-notional", tag2);
            int256 navValue = int256(Math.mulDiv(fs[i].stockAmount, ps[i].nav, 1e20));
            int256 usdgAmt = int256(fs[i].usdgAmount);
            assertEq(ps[i].cost, fs[i].buy ? usdgAmt - navValue : navValue - usdgAmt);
        }
        FillmarkRouter.Stats memory s = router.statsOf(agentId, account, WETH);
        assertEq(s.fills, 2);
        assertEq(s.sumCost, ps[0].cost + ps[1].cost);
    }

    /// The NAV bound holds for crypto: after the thin 1% pool is pushed 5% above the
    /// feed, a buy with a 2% slip limit reverts even though the agent quotes the new price.
    function test_RevertWhen_CryptoBuyWorseThanNav() public {
        address pool = IUniswapV3Factory(FACTORY).getPool(USDG, WETH, 10000);
        (, int256 nav,,,) = IAggregatorV3(ETH_FEED).latestRoundData();
        // WETH is token0: sqrtPriceX96 = sqrt(nav * 2^192 / 1e20) at the NAV.
        uint160 target = uint160(Math.sqrt(Math.mulDiv(uint256(nav) * 105 / 100, 1 << 192, 1e20)));
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertLt(sqrtP, target);
        IUniswapV3Pool(pool).swap(address(this), false, int256(1_000_000e6), target, "");
        _expectRevert(_intent(USDG, WETH, 10000, 20e6), FillmarkRouter.WorseThanNav.selector);
    }

    function test_RevertWhen_CryptoFeedStale() public {
        (,,, uint256 updatedAt,) = IAggregatorV3(ETH_FEED).latestRoundData();
        // The ETH / USD feed has a 24h heartbeat, so an answer up to 25h old is used.
        vm.warp(updatedAt + ETH_MAX_AGE);
        _exec(_intent(USDG, WETH, 100, 500e6));
        vm.warp(updatedAt + ETH_MAX_AGE + 1);
        _expectRevert(_intent(USDG, WETH, 100, 500e6), FillmarkRouter.StaleFeed.selector);
    }

    /// Calendar closures never stop crypto, so crypto has its own halt, bounded by the
    /// same guardian budget.
    function test_GuardianHaltsCrypto() public {
        uint64 t0 = uint64(vm.getBlockTimestamp());
        vm.prank(guardian);
        feeds.addCryptoHalt(t0, t0 + 1 hours);
        _expectRevert(_intent(USDG, WETH, 100, 500e6), FillmarkRouter.MarketClosed.selector);
        assertEq(uint8(feeds.sessionOf(TSLA, t0)), uint8(feeds.sessionAt(t0))); // stocks unaffected
        vm.prank(guardian);
        vm.expectRevert(FillmarkFeeds.GuardianLimit.selector);
        feeds.addCryptoHalt(t0 + 1 hours, t0 + 3 days + 1 hours); // 1h + 3d is over the budget
        vm.warp(t0 + 1 hours);
        _exec(_intent(USDG, WETH, 100, 500e6));
    }

    /// cbBTC has 8 decimals and is token1 against USDG. A fill is priced per whole
    /// coin: a decimals mistake would be off by a factor of 1e10.
    function test_EightDecimalTokenIsPricedAndScored() public {
        vm.recordLogs();
        uint256 b = _exec(_intent(USDG, CBBTC, 500, 500e6));
        assertEq(IERC20(CBBTC).balanceOf(account), b);
        _exec(_intent(CBBTC, USDG, 500, b));
        assertEq(IERC20(CBBTC).balanceOf(account), 0);
        assertEq(IERC20(CBBTC).balanceOf(address(router)), 0);
        (FillmarkRouter.Fill[] memory fs, FillmarkRouter.Prices[] memory ps) = _fillEvents();
        (, int256 nav,,,) = IAggregatorV3(CBBTC_FEED).latestRoundData();
        string memory tag2 = _tag2(CBBTC, fs[0].usdgAmount);
        assertEq(tag2, string.concat("cbBTC:B", Strings.toString(router.bucketOf(fs[0].usdgAmount))));
        for (uint256 i; i < 2; i++) {
            assertEq(fs[i].stockDecimals, 8);
            assertEq(ps[i].nav, uint256(nav));
            assertApproxEqRel(ps[i].spot, ps[i].nav, 0.02e18);
            assertApproxEqRel(ps[i].fill, ps[i].nav, 0.02e18);
            // NAV value of the coins = coins * price / 1e10 (8 + 8 - 6 decimals).
            int256 navValue = int256(Math.mulDiv(fs[i].stockAmount, ps[i].nav, 1e10));
            assertEq(navValue, int256(router.navValueOf(fs[i].stockAmount, ps[i].nav, 8)));
            int256 usdgAmt = int256(fs[i].usdgAmount);
            assertApproxEqRel(navValue, usdgAmt, 0.02e18);
            assertEq(ps[i].cost, fs[i].buy ? usdgAmt - navValue : navValue - usdgAmt);
            _checkFeedback(uint64(2 * i + 1), ps[i].cost, "fillmark-cost", tag2);
            _checkFeedback(uint64(2 * i + 2), int256(fs[i].usdgAmount), "fillmark-notional", tag2);
        }
        assertEq(router.statsOf(agentId, account, CBBTC).fills, 2);
    }

    /// Amounts are priced with the decimals read when the token was added. If a token's
    /// decimals ever change (an upgrade), its fills stop instead of being mispriced.
    function test_RevertWhen_TokenDecimalsChanged() public {
        _exec(_intent(USDG, WETH, 100, 50e6));
        vm.store(WETH, WETH_DECIMALS_SLOT, bytes32(uint256(6)));
        assertEq(IERC20Metadata(WETH).decimals(), 6);
        _expectRevert(_intent(USDG, WETH, 100, 50e6), FillmarkRouter.DecimalsChanged.selector);
        vm.store(WETH, WETH_DECIMALS_SLOT, bytes32(uint256(18)));
        _exec(_intent(USDG, WETH, 100, 50e6));
    }

    function test_CryptoRegistry() public {
        assertTrue(feeds.isCrypto(WETH));
        assertFalse(feeds.isCrypto(TSLA));
        assertEq(feeds.tickerOf(WETH), "WETH");
        assertEq(feeds.feedOf(WETH), ETH_FEED);
        assertEq(feeds.decimalsOf(WETH), 18);
        assertEq(feeds.decimalsOf(CBBTC), 8);
        assertEq(feeds.decimalsOf(TSLA), 18);
        assertEq(feeds.sourceOf(CBBTC, vm.getBlockTimestamp()).decimals, 8);
        uint256 saturday = (vm.getBlockTimestamp() / 1 weeks + 1) * 1 weeks + 2 days + 12 hours; // weeks start on Thursday
        assertEq(uint8(feeds.sessionOf(TSLA, saturday)), uint8(FillmarkFeeds.Session.Closed));
        assertEq(uint8(feeds.sessionOf(WETH, saturday)), uint8(FillmarkFeeds.Session.Regular));
        vm.prank(guardian);
        vm.expectRevert(FillmarkFeeds.NotAdmin.selector);
        feeds.addCrypto(address(1), ETH_FEED, ETH_MAX_AGE);

        // A token is added once, and only as its own kind: a stock token answers
        // oraclePaused() and WETH does not.
        FillmarkFeeds f = new FillmarkFeeds(address(this), guardian);
        vm.expectRevert(FillmarkFeeds.BadInput.selector);
        f.addCrypto(TSLA, TSLA_FEED, ETH_MAX_AGE);
        vm.expectRevert(FillmarkFeeds.BadInput.selector);
        f.addStock(WETH, ETH_FEED, 6 hours, true);
        vm.expectRevert(FillmarkFeeds.BadInput.selector);
        f.addCrypto(WETH, ETH_FEED, 1 hours - 1);
        vm.expectRevert(FillmarkFeeds.BadInput.selector);
        f.addCrypto(WETH, ETH_FEED, 25 hours + 1);
        // More than 18 decimals is refused (WETH's stored decimals raised for the check).
        vm.store(WETH, WETH_DECIMALS_SLOT, bytes32(uint256(19)));
        vm.expectRevert(FillmarkFeeds.BadInput.selector);
        f.addCrypto(WETH, ETH_FEED, ETH_MAX_AGE);
        vm.store(WETH, WETH_DECIMALS_SLOT, bytes32(uint256(18)));
        f.addCrypto(WETH, ETH_FEED, ETH_MAX_AGE);
        vm.expectRevert(FillmarkFeeds.AlreadySet.selector);
        f.addCrypto(WETH, ETH_FEED, ETH_MAX_AGE);
    }

    /// The fill id ties each registry entry to its Filled event.
    function test_FillIdMatchesAccountAndNonce() public {
        vm.recordLogs();
        FillmarkRouter.FillIntent memory it = _intent(USDG, NVDA, 500, 500e6);
        _exec(it);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 expected = keccak256(abi.encode(block.chainid, address(router), account, it.nonce));
        bool seenEvent;
        uint256 hashes;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == FillmarkRouter.Filled.selector) {
                (, bytes32 fillId,,) =
                    abi.decode(logs[i].data, (address, bytes32, FillmarkRouter.Fill, FillmarkRouter.Prices));
                assertEq(fillId, expected);
                seenEvent = true;
            }
            // The registry's feedback event carries feedbackHash as its 8th head word
            // (index, value, decimals, then four string offsets), read from the live log.
            if (logs[i].emitter == REPUTATION && logs[i].data.length >= 256) {
                bytes memory data = logs[i].data;
                bytes32 word;
                assembly {
                    word := mload(add(data, 256))
                }
                if (word == expected) hashes++;
            }
        }
        assertTrue(seenEvent);
        assertEq(hashes, 2);
    }

    /// Fifth review, M-A: wash round trips the agent chooses can dilute sumCost /
    /// notional, but not the worst fill and not the absolute sumCost, which still holds
    /// every USDG the client lost.
    function test_WashCannotHideWorstFillOrTotalCost() public {
        slip = 500;
        account = _createAccount(2_000e6, 1e12, _stocks(), 95);
        deal(USDG, account, 10_000e6);
        uint256 held = _exec(_intent(USDG, TSLA, 3000, 1_000e6));
        int256 loss = _sellIntoOwnRange(held);
        bytes32 key = router.statsKey(agentId, account, TSLA, 4, _ext());
        (,, int64 worstBefore,) = router.stats(key);
        assertGt(worstBefore, 30_000);

        int24 t = _moveSpot(_sqrtAt(1, 1));
        IPoolLp(TSLA_POOL_100).mint(address(this), t - 1, t + 2, 1e20, "");
        uint256 usdgBefore = IERC20(USDG).balanceOf(account);
        for (uint256 i; i < 10; i++) {
            uint256 got = _exec(_intent(USDG, TSLA, 100, 999e6));
            _exec(_intent(TSLA, USDG, 100, got));
        }
        uint256 washLoss = usdgBefore - IERC20(USDG).balanceOf(account);
        (uint32 fills, uint128 notional, int64 worst, int128 sumCost) = router.stats(key);
        assertEq(fills, 21);
        assertEq(worst, worstBefore);
        assertEq(int256(sumCost), loss + int256(washLoss));
        assertLt(int256(sumCost) * 1e6 / int256(uint256(notional)), worstBefore / 4); // the ratio is diluted
    }

    /// The guardian can close the market at once, but only for closures starting within
    /// the hour and at most 3 days of them per 30-day window (fourth review, M-2).
    function test_GuardianClosuresAreBounded() public {
        uint64 t0 = uint64(vm.getBlockTimestamp());
        vm.prank(guardian);
        vm.expectRevert(FillmarkFeeds.NotAdmin.selector);
        feeds.addStock(address(1), TSLA_FEED, 6 hours, true);
        vm.prank(guardian);
        vm.expectRevert(FillmarkFeeds.GuardianLimit.selector);
        feeds.addClosure(t0 + 1 hours + 1, t0 + 2 hours); // starts too far ahead
        vm.prank(guardian);
        vm.expectRevert(FillmarkFeeds.GuardianLimit.selector);
        feeds.addClosure(t0, t0 + 3 days + 1); // over the budget at once

        vm.prank(guardian);
        feeds.addClosure(t0, t0 + 1 hours);
        _expectRevert(_intent(USDG, TSLA, 3000, 500e6), FillmarkRouter.MarketClosed.selector);

        // Chaining closures stops once the window's 3 days are used.
        vm.warp(t0 + 1 hours);
        assertTrue(feeds.sessionAt(vm.getBlockTimestamp()) != FillmarkFeeds.Session.Closed);
        vm.prank(guardian);
        feeds.addClosure(t0 + 1 hours, t0 + 3 days);
        vm.warp(t0 + 3 days);
        vm.prank(guardian);
        vm.expectRevert(FillmarkFeeds.GuardianLimit.selector);
        feeds.addClosure(t0 + 3 days, t0 + 3 days + 1);
        // A new window brings a new budget; the admin is never limited.
        feeds.addClosure(t0 + 3 days, t0 + 10 days);
        vm.warp(t0 + 30 days);
        vm.prank(guardian);
        feeds.addClosure(t0 + 30 days, t0 + 31 days);
    }

    /// Fourth review, H-1: one "gift" fill far better than NAV (14 bad buys, then one
    /// tiny sell at about 800x NAV) dominated an unweighted mean of per-fill bps. The
    /// score is now cost in USDG weighted by notional, so the gift counts only for the
    /// money it really moved and the client's net loss still shows.
    function test_GiftFillCannotHideNetLoss() public {
        slip = 500;
        account = _createAccount(2_000e6, 30_000e6, _stocks(), 91);
        deal(USDG, account, 30_000e6);
        int24 lo = _moveSpot(_sqrtAt(1035, 1000));
        int24 hi = _moveSpot(_sqrtAt(1040, 1000));
        _moveSpot(_sqrtAt(96, 100));
        IPoolLp(TSLA_POOL_100).mint(address(this), lo, hi, 2e18, "");

        vm.recordLogs();
        for (uint256 i; i < 14; i++) {
            _exec(_intent(USDG, TSLA, 100, 999e6));
        }
        int24 glo = _moveSpot(_sqrtAt(790, 1));
        int24 ghi = _moveSpot(_sqrtAt(800, 1));
        _moveSpot(_sqrtAt(810, 1));
        IPoolLp(TSLA_POOL_100).mint(address(this), glo, ghi, 1e15, "");
        _exec(_intent(TSLA, USDG, 100, 1.2e15));

        (FillmarkRouter.Fill[] memory fs, FillmarkRouter.Prices[] memory ps) = _fillEvents();
        assertEq(fs.length, 15);
        assertEq(router.bucketOf(fs[14].usdgAmount), 4);
        assertLt(ps[14].shortfall, -1_000_000); // the gift fill alone looks far better than NAV
        int256 net;
        for (uint256 i; i < 15; i++) {
            net += ps[i].cost;
        }
        assertGt(net, 0); // the client still lost money against NAV

        string memory tag2 = _tag2(TSLA, 999e6);
        (uint64 count, int128 meanCost) = _summary(account, "cost", tag2);
        (, int128 meanNotional) = _summary(account, "notional", tag2);
        assertEq(count, 15);
        assertGt(meanCost, 0);
        assertGt(meanNotional, 0);
        (uint32 fills, uint128 notional,, int128 sumCost) =
            router.stats(router.statsKey(agentId, account, TSLA, 4, _ext()));
        assertEq(fills, 15);
        assertEq(sumCost, net);
        assertApproxEqAbs(meanCost * int256(uint256(count)), net, 15);
        assertApproxEqAbs(uint256(int256(meanNotional)) * count, notional, 15);
    }
}
