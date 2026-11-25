// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ForkBase, IIdentity} from "./ForkBase.sol";
import {IKernelV2, IKernelFactoryV2, PackedOp, IEntryPointV2, IPoolMint} from "./RouterV2.t.sol";
import {FillmarkBurner} from "../src/FillmarkBurner.sol";
import {FillmarkPay} from "../src/FillmarkPay.sol";
import {FillmarkRouterV3} from "../src/FillmarkRouterV3.sol";
import {IAggregatorV3, IUniswapV3Pool} from "../src/interfaces/External.sol";
import {IV4PoolManager, IV4PositionManager} from "../src/interfaces/ExternalV2.sol";

interface IPoolSpacing {
    function tickSpacing() external view returns (int24);
}

interface IUsdgFreeze {
    function grantRole(bytes32 role, address account) external;
    function freeze(address account) external;
    function isFrozen(address account) external view returns (bool);
}

interface IUsdgPause {
    function pause() external;
    function paused() external view returns (bool);
}

/// Fork tests of Fillmark Pay on Robinhood Chain mainnet against the deployed router v3,
/// its stats and Kernel accounts, the deployed burner given a real graduated Pons V2 USDG
/// launch by its timelock (as the 2-day timelock will do for $FILLMARK), the real Pons
/// hook and Uniswap v4 PoolManager, USDG, ERC-8004 and Chainlink. No mocks.
///
/// On chain block.number is Ethereum's block number (about 12 seconds, many L2 blocks);
/// a fork sees L2 numbers, so vm.roll here stands for the next Ethereum block.
contract PayForkTest is ForkBase {
    FillmarkRouterV3 constant ROUTER = FillmarkRouterV3(0x6F01e2bE7d1D31E88dF177bEC23392D1905FC8Aa);
    FillmarkBurner constant BURNER = FillmarkBurner(0x418106F0356E638C3823221FDBd2fBb3e8D7B024);
    address constant TIMELOCK = 0x54b6b215e216938Cb673b5d256593c0a1dDacAC3;
    address constant SAFE = 0x6C3a19517e5c1cff510BC163DCA4a46C7a969261;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    // A graduated Pons V2 launch paired with USDG, creator tax 0 and Pons buyback off
    // (the burner tests use it too); it stands in for $FILLMARK.
    address constant TOKEN = 0x2f91580ea6824212B26637014c756284cB7594dF;
    // Another graduated USDG launch (creator tax 0, buyback off) whose address sorts above
    // USDG, so USDG is currency0 of its pool: the other branch of the swap and the side.
    address constant TOKEN_ABOVE_USDG = 0x7CEC28c6B502a335DC1f18De2D7cA99F12c6012a;
    // The team's live client account and the reference agent.
    address constant TEAM_ACCOUNT = 0xB5667f1c68bADFc54CE5eaCc60EACb89473Ec37C;
    uint256 constant TEAM_AGENT_ID = 26144;
    address constant TEAM_AGENT = 0xDCe0AAc0A8E6629A0ae3c739ced29B8B31c960B8;
    bytes32 constant USDG_FREEZE_ROLE = 0xe3e4f9d7569515307c0cdec302af069a93c9e33f325269bac70e6e22465a9796;
    // keccak256("PAUSE_ROLE"), the role USDG's pause() asks for, read from its revert on chain.
    bytes32 constant USDG_PAUSE_ROLE = 0x139c2898040ef16910dc9f44dc697df79363da767d8bc92f2e310312b816e46d;
    address constant USDG_ADMIN = 0xcFA0388f5ddf905FdC08c45c716C15Dc10A14C6F;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 constant USER_OP_EVENT =
        keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
    uint32 constant TWAP = 120; // router v3's window

    FillmarkPay pay;
    address agent;
    uint256 agentId;
    address owner;
    uint256 ownerKey;
    address account;
    uint256 nonce = 1e30; // far from the live agent's nonces
    uint256 tokenSnap; // state before the burner gets its token
    uint16 constant RATE = 5;
    uint16 constant ZERO_AT = 100;

    function setUp() public {
        _fork();
        pay = new FillmarkPay(ROUTER);
        (agent,) = _key("pay-agent");
        (owner, ownerKey) = _key("pay-owner");
        vm.prank(agent);
        agentId = IIdentity(IDENTITY).register("");
        vm.prank(agent);
        pay.setRate(agentId, RATE, ZERO_AT);
        account = _createAccount(agentId, _stocks(), 1);
        deal(USDG, account, 1_000_000e6);
        vm.prank(account);
        IERC20(USDG).approve(address(pay), type(uint256).max);
        tokenSnap = vm.snapshotState();
        vm.prank(TIMELOCK);
        BURNER.setToken(TOKEN);
        _fair(WETH, 0);
    }

    // ---- deployment ----

    function test_ReadsEverythingFromTheRouter() public view {
        assertEq(address(pay.router()), address(ROUTER));
        assertEq(address(pay.burner()), address(BURNER));
        assertEq(address(pay.identity()), IDENTITY);
        assertEq(pay.usdg(), USDG);
        assertEq(address(pay.poolManager()), POOL_MANAGER);
        assertEq(address(pay.positionManager()), POSITION_MANAGER);
        assertEq(BURNER.token(), TOKEN);
    }

    // ---- terms ----

    function test_SetRateByAgentWalletOrOwnerOnly() public {
        // The reference agent: the Safe owns the identity, the agent key is its wallet.
        vm.prank(TEAM_AGENT);
        pay.setRate(TEAM_AGENT_ID, 2, 100);
        vm.prank(SAFE);
        pay.setRate(TEAM_AGENT_ID, 3, 150);
        FillmarkPay.Terms memory t = pay.termsOf(TEAM_AGENT_ID);
        assertEq(t.rateBps, 3);
        assertEq(t.minZeroAtBps, 150);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(FillmarkPay.NotAgent.selector);
        pay.setRate(TEAM_AGENT_ID, 5, 100);
    }

    function test_RevertWhen_TermsOutOfBounds() public {
        uint16[2][4] memory bad = [
            [uint16(6), uint16(100)], [uint16(5), uint16(0)], [uint16(5), uint16(1001)], [type(uint16).max, uint16(1)]
        ];
        for (uint256 i; i < bad.length; i++) {
            vm.prank(agent);
            vm.expectRevert(FillmarkPay.BadTerms.selector);
            pay.setRate(agentId, bad[i][0], bad[i][1]);
        }
        vm.prank(agent);
        pay.setRate(agentId, 0, 1000); // the bounds themselves are fine
    }

    // ---- opening ----

    /// The client's own owner signs one batch: a limited USDG approval and open.
    function test_OpenInOneOwnerBatchWithApproval() public {
        address acct = _createAccount(agentId, _stocks(), 2);
        deal(USDG, acct, 100e6);
        Call[] memory c = new Call[](2);
        c[0] = Call(USDG, 0, abi.encodeCall(IERC20.approve, (address(pay), 1e6)));
        c[1] = Call(address(pay), 0, abi.encodeCall(FillmarkPay.open, (agentId, RATE, ZERO_AT, _two())));
        _userOp(acct, abi.encodeCall(IKernelV2.execute, (bytes32(uint256(1) << 248), abi.encode(c))));
        FillmarkPay.Agreement memory a = pay.agreementOf(acct, agentId);
        assertTrue(a.open);
        assertEq(a.rateBps, RATE);
        assertEq(a.zeroAtBps, ZERO_AT);
        assertEq(IERC20(USDG).allowance(acct, address(pay)), 1e6);
        assertEq(pay.tokensOf(acct, agentId).length, 2);
    }

    function test_RevertWhen_OpenChecksFail() public {
        vm.startPrank(account);
        vm.expectRevert(FillmarkPay.RateChanged.selector);
        pay.open(agentId, RATE - 1, ZERO_AT, _two());
        vm.expectRevert(FillmarkPay.BadZeroAt.selector);
        pay.open(agentId, RATE, ZERO_AT - 1, _two());
        vm.expectRevert(FillmarkPay.BadZeroAt.selector);
        pay.open(agentId, RATE, 1001, _two());
        address[] memory notAllowed = new address[](1);
        notAllowed[0] = GLD; // a router asset this account did not allow
        vm.expectRevert(abi.encodeWithSelector(FillmarkPay.NotAllowed.selector, GLD));
        pay.open(agentId, RATE, ZERO_AT, notAllowed);
        address[] memory dup = new address[](2);
        (dup[0], dup[1]) = (WETH, WETH);
        vm.expectRevert(abi.encodeWithSelector(FillmarkPay.AlreadyTracked.selector, WETH));
        pay.open(agentId, RATE, ZERO_AT, dup);
        vm.expectRevert(FillmarkPay.TooManyTokens.selector);
        pay.open(agentId, RATE, ZERO_AT, new address[](33));
        pay.open(agentId, RATE, ZERO_AT, _two());
        vm.expectRevert(FillmarkPay.AlreadyOpen.selector);
        pay.open(agentId, RATE, ZERO_AT, _two());
        vm.stopPrank();

        // An agent without terms, and an agent never installed on the account.
        (address other,) = _key("pay-other-agent");
        vm.prank(other);
        uint256 otherId = IIdentity(IDENTITY).register("");
        vm.prank(account);
        vm.expectRevert(FillmarkPay.NoTerms.selector);
        pay.open(otherId, 0, 100, _two());
        vm.prank(other);
        pay.setRate(otherId, 1, 100);
        vm.prank(account);
        vm.expectRevert(FillmarkPay.NeverInstalled.selector);
        pay.open(otherId, 1, 100, _two());
    }

    /// New terms apply to new agreements only.
    function test_OpenAgreementKeepsItsTerms() public {
        _open(account, ZERO_AT);
        vm.prank(agent);
        pay.setRate(agentId, 1, 500);
        assertEq(pay.agreementOf(account, agentId).rateBps, RATE);
        assertEq(pay.agreementOf(account, agentId).zeroAtBps, ZERO_AT);
        _buy(account, WETH, 2_000e6);
        (uint256 n, int256 c) = _sinceOpen(account);
        assertEq(pay.dueOf(account, agentId).accrued, _expected(RATE, ZERO_AT, n, c));
    }

    function test_FillsBeforeOpenAreNotBilled() public {
        _buy(account, WETH, 2_000e6);
        _open(account, ZERO_AT);
        FillmarkPay.Due memory d = pay.dueOf(account, agentId);
        assertEq(d.accrued, 0);
        assertEq(uint8(d.wait), uint8(FillmarkPay.Wait.NothingDue));
        FillmarkPay.Base[] memory b = pay.tokensOf(account, agentId);
        FillmarkRouterV3.Stats memory s = ROUTER.statsOf(agentId, account, WETH);
        assertEq(b[0].token, WETH);
        assertEq(b[0].notional, s.notional);
        assertEq(b[0].sumCost, s.sumCost);
        assertGt(s.notional, 0);
    }

    // ---- the formula ----

    /// The design's table: r = 5, Z = 100, an 11 USDG fill.
    function test_FormulaMatchesTheDesignTable() public pure {
        assertEq(_expected(5, 100, 11e6, 1274), 5436); // the real 25 Nov fill, +1.16 bps
        assertEq(_expected(5, 100, 11e6, 66_000), 2200); // +60 bps
        assertEq(_expected(5, 100, 11e6, 105_600), 220); // +96 bps
        assertEq(_expected(5, 100, 11e6, -2200), 5500); // -2 bps: capped at the rate
        assertEq(_expected(5, 100, 11e6, 110_000), 0); // exactly Z
        assertEq(_expected(5, 100, 11e6, 200_000), 0); // worse than Z
        // The split of what is bought: 10% to 0xdEaD rounded down, the rest to the agent.
        assertEq(uint256(5_436_000) * 1000 / 1e4, 543_600);
    }

    /// Real fills at the pool's own price, above NAV and below NAV: what the contract
    /// accrues equals the formula over the router's stats since open.
    function test_AccruesTheFormulaOverRealFills() public {
        _open(account, ZERO_AT);
        _buy(account, WETH, 3_000e6); // at NAV: about the pool fee
        _check();
        _fair(WETH, 40); // pool 40 bps over NAV: a worse buy
        _buy(account, WETH, 2_000e6);
        _check();
        _fair(WETH, -30); // pool under NAV: a better buy
        _buy(account, WETH, 5_000e6);
        _check();
        (uint256 n, int256 c) = _sinceOpen(account);
        assertEq(n, 10_000e6);
        assertTrue(c != 0);
    }

    /// The account pays exactly what is due in USDG; 10% of what that buys goes to 0xdEaD,
    /// the rest to the agent wallet pinned in the router; nothing stays here.
    function test_SettlePaysExactUsdgAndSplitsTheBuy() public {
        _open(account, ZERO_AT);
        _buy(account, WETH, 4_000e6);
        FillmarkPay.Due memory d = pay.dueOf(account, agentId);
        assertGt(d.due, 0);
        assertEq(d.payNow, d.due);
        uint256 usdgBefore = _usdg(account);
        uint256 agentBefore = IERC20(TOKEN).balanceOf(agent);
        uint256 deadBefore = IERC20(TOKEN).balanceOf(DEAD);
        vm.recordLogs();
        uint256 paid = _settle(account);
        (uint256 usdgPaid, uint256 toAgent, uint256 burned, uint256 unpaid) = _settled();
        assertEq(paid, d.due);
        assertEq(usdgPaid, paid);
        assertEq(unpaid, 0);
        assertEq(usdgBefore - _usdg(account), paid);
        assertEq(IERC20(TOKEN).balanceOf(agent) - agentBefore, toAgent);
        assertEq(IERC20(TOKEN).balanceOf(DEAD) - deadBefore, burned);
        assertEq(burned, (toAgent + burned) * 1000 / 1e4);
        assertEq(ROUTER.bookOf(account, agentId).wallet, agent);
        assertEq(_usdg(address(pay)), 0);
        assertEq(IERC20(TOKEN).balanceOf(address(pay)), 0);
        assertEq(pay.agreementOf(account, agentId).paid, paid);
        assertEq(uint8(pay.dueOf(account, agentId).wait), uint8(FillmarkPay.Wait.NothingDue));
        assertEq(_settle(account), 0); // nothing more
    }

    /// When the agent settles does not change what the account pays in total.
    function test_SameTotalWheneverTheAgentSettles() public {
        _open(account, ZERO_AT);
        uint256 snap = vm.snapshotState();
        uint256 often;
        for (uint256 i; i < 3; i++) {
            _buy(account, WETH, 2_500e6);
            vm.roll(vm.getBlockNumber() + 1);
            often += _settle(account);
        }
        uint256 accruedOften = pay.dueOf(account, agentId).accrued;
        vm.revertToState(snap);
        for (uint256 i; i < 3; i++) {
            _buy(account, WETH, 2_500e6);
            vm.roll(vm.getBlockNumber() + 1);
        }
        uint256 once = _settle(account);
        assertEq(once, often);
        assertEq(pay.dueOf(account, agentId).accrued, accruedOften);
    }

    /// The pool price at settle changes what the agent receives, never what the account pays.
    function test_PoolPriceDoesNotChangeWhatTheAccountPays() public {
        _open(account, ZERO_AT);
        _buy(account, WETH, 5_000e6);
        uint256 snap = vm.snapshotState();
        uint256 plain = _settle(account);
        uint256 plainTokens = IERC20(TOKEN).balanceOf(agent);
        vm.revertToState(snap);
        _ponsSwap(true, _usdgSide()); // someone pushes $FILLMARK up first
        uint256 pushed = _settle(account);
        assertEq(pushed, plain);
        assertLt(IERC20(TOKEN).balanceOf(agent), plainTokens);
    }

    // ---- limits ----

    /// One budget per block for all of Fillmark Pay, however many settles a transaction makes.
    function test_BlockBudgetAcrossSettlesInOneTransaction() public {
        uint256 budget = pay.blockBudgetLeft();
        assertApproxEqAbs(budget * 5, BURNER.maxBurn(), 5); // 0.1% vs the burner's 0.5% of the same side
        emit log_named_uint("USDG side of the locked position", _usdgSide());
        emit log_named_uint("block budget", budget);
        // Each account owes more than half the budget.
        uint256 volume = (budget * 1e4 / RATE) * 6 / 10;
        address[] memory accts = new address[](3);
        for (uint256 i; i < 3; i++) {
            accts[i] = i == 0 ? account : _createAccount(agentId, _stocks(), 10 + i);
            if (i != 0) {
                deal(USDG, accts[i], 1_000_000e6);
                vm.prank(accts[i]);
                IERC20(USDG).approve(address(pay), type(uint256).max);
            }
            _open(accts[i], ZERO_AT);
            _buyBig(accts[i], WETH, volume);
        }
        vm.roll(vm.getBlockNumber() + 1);
        budget = pay.blockBudgetLeft();
        uint256[] memory paid = new uint256[](3);
        for (uint256 i; i < 3; i++) {
            paid[i] = _settle(accts[i]); // the same block
        }
        assertEq(paid[0] + paid[1] + paid[2], budget);
        assertEq(paid[2], 0);
        assertEq(pay.blockBudgetLeft(), 0);
        assertEq(uint8(pay.dueOf(accts[2], agentId).wait), uint8(FillmarkPay.Wait.BlockBudget));
        vm.roll(vm.getBlockNumber() + 1);
        assertGt(_settle(accts[2]), 0);
    }

    function test_NoBuyInTheBurnersBlock() public {
        _open(account, ZERO_AT);
        _buy(account, WETH, 4_000e6);
        deal(USDG, address(BURNER), 100e6);
        BURNER.burn();
        FillmarkPay.Due memory d = pay.dueOf(account, agentId);
        assertEq(uint8(d.wait), uint8(FillmarkPay.Wait.BurnThisBlock));
        assertEq(d.payNow, 0);
        assertEq(_settle(account), 0);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(_settle(account), d.due);
    }

    function test_BalanceAndAllowanceLimitThePayment() public {
        _open(account, ZERO_AT);
        _buy(account, WETH, 8_000e6);
        uint256 due = pay.dueOf(account, agentId).due;
        vm.prank(account);
        IERC20(USDG).approve(address(pay), due / 3);
        FillmarkPay.Due memory d = pay.dueOf(account, agentId);
        assertEq(uint8(d.wait), uint8(FillmarkPay.Wait.Allowance));
        assertEq(d.payNow, due / 3);
        assertEq(_settle(account), due / 3);
        assertEq(pay.dueOf(account, agentId).due, due - due / 3);

        vm.prank(account);
        IERC20(USDG).approve(address(pay), type(uint256).max);
        uint256 keep = 1000;
        deal(USDG, account, keep);
        d = pay.dueOf(account, agentId);
        assertEq(uint8(d.wait), uint8(FillmarkPay.Wait.Balance));
        assertEq(d.payNow, keep);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(_settle(account), keep);
        assertEq(_usdg(account), 0);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(_settle(account), 0); // no swap with nothing to pay
    }

    function test_NothingToPayMakesNoSwap() public {
        address acct = _createAccount(agentId, _stocks(), 3); // installed, no agreement
        _open(account, ZERO_AT);
        uint160 before = BURNER.sqrtPriceX96();
        vm.recordLogs();
        assertEq(_settle(account), 0);
        assertEq(BURNER.sqrtPriceX96(), before);
        assertEq(vm.getRecordedLogs().length, 0);
        vm.prank(agent);
        vm.expectRevert(FillmarkPay.NotOpen.selector);
        pay.settle(acct, agentId, 0);
    }

    /// Before the burner has its token there is no pool to buy in: settle pays nothing.
    function test_NothingIsBoughtBeforeTheTokenIsSet() public {
        vm.revertToState(tokenSnap);
        assertEq(BURNER.token(), address(0));
        _fair(WETH, 0);
        _open(account, ZERO_AT);
        _buy(account, WETH, 4_000e6);
        FillmarkPay.Due memory d = pay.dueOf(account, agentId);
        assertGt(d.due, 0);
        assertEq(uint8(d.wait), uint8(FillmarkPay.Wait.NoToken));
        assertEq(pay.blockBudgetLeft(), 0);
        assertEq(_settle(account), 0);
    }

    function test_TokenSortingAboveUsdg() public {
        vm.revertToState(tokenSnap);
        vm.prank(TIMELOCK);
        BURNER.setToken(TOKEN_ABOVE_USDG);
        assertEq(BURNER.poolKey().currency0, USDG);
        _fair(WETH, 0);
        _open(account, ZERO_AT);
        _buy(account, WETH, 4_000e6);
        assertApproxEqAbs(pay.blockBudgetLeft() * 5, BURNER.maxBurn(), 5);
        // This pool is shallower: the block budget may bind.
        FillmarkPay.Due memory d = pay.dueOf(account, agentId);
        assertEq(d.payNow, Math.min(d.due, pay.blockBudgetLeft()));
        uint256 usdgBefore = _usdg(account);
        vm.recordLogs();
        assertEq(_settle(account), d.payNow);
        (, uint256 toAgent, uint256 burned,) = _settled();
        assertEq(usdgBefore - _usdg(account), d.payNow);
        assertEq(IERC20(TOKEN_ABOVE_USDG).balanceOf(agent), toAgent);
        assertEq(burned, (toAgent + burned) * 1000 / 1e4);
        assertGt(burned, 0);
        assertEq(IERC20(TOKEN_ABOVE_USDG).balanceOf(address(pay)), 0);
    }

    // ---- closing ----

    function test_CloseKeepsWhatIsOwedAsCarryAndReopenBillsIt() public {
        _open(account, ZERO_AT);
        _buy(account, WETH, 6_000e6);
        vm.prank(account);
        IERC20(USDG).approve(address(pay), 1000);
        _settle(account);
        uint256 owed = pay.dueOf(account, agentId).due;
        assertGt(owed, 0);
        vm.prank(account);
        pay.close(agentId);
        FillmarkPay.Agreement memory a = pay.agreementOf(account, agentId);
        assertFalse(a.open);
        assertEq(a.carry, owed);
        assertEq(a.paid, 0);
        assertEq(pay.tokensOf(account, agentId).length, 0);
        vm.expectRevert(FillmarkPay.NotOpen.selector);
        _settle(account);
        vm.prank(account);
        vm.expectRevert(FillmarkPay.NotOpen.selector);
        pay.close(agentId);

        // Fills while closed are not billed; reopening bills the carry first.
        _buy(account, WETH, 3_000e6);
        vm.prank(account);
        IERC20(USDG).approve(address(pay), type(uint256).max);
        _open(account, ZERO_AT);
        FillmarkPay.Due memory d = pay.dueOf(account, agentId);
        assertEq(d.accrued, 0);
        assertEq(d.due, owed);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(_settle(account), owed);
        _buy(account, WETH, 2_000e6);
        (uint256 n, int256 c) = _sinceOpen(account);
        // Paid so far equals the carry, so what is due now is what the new fill earned.
        assertEq(pay.dueOf(account, agentId).due, _expected(RATE, ZERO_AT, n, c));
    }

    /// A fill worse than Z can bring what was earned under what was paid; nothing is taken
    /// back and nothing more is owed until earnings pass it again.
    function test_FillWorseThanZeroAtAfterPaying() public {
        vm.prank(agent);
        pay.setRate(agentId, RATE, 10);
        _open(account, 10);
        _fair(WETH, -30);
        _buy(account, WETH, 5_000e6); // better than NAV: full rate
        uint256 paid = _settle(account);
        assertEq(paid, 5_000e6 * RATE / 1e4);
        _fair(WETH, 50);
        _buy(account, WETH, 5_000e6); // ~50 bps worse, Z = 10
        FillmarkPay.Due memory d = pay.dueOf(account, agentId);
        assertLt(d.accrued, paid);
        assertEq(d.due, 0);
        vm.prank(account);
        pay.close(agentId);
        assertEq(pay.agreementOf(account, agentId).carry, 0);
    }

    // ---- tracking ----

    function test_TrackOnlyByAccountOrAgentAndOnlyAllowedTokens() public {
        address[] memory one = new address[](1);
        one[0] = WETH;
        vm.prank(account);
        pay.open(agentId, RATE, ZERO_AT, one);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(FillmarkPay.NotAccountOrAgent.selector);
        pay.track(account, agentId, CBBTC);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(FillmarkPay.NotAllowed.selector, GLD));
        pay.track(account, agentId, GLD);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(FillmarkPay.AlreadyTracked.selector, WETH));
        pay.track(account, agentId, WETH);
        vm.prank(agent);
        pay.track(account, agentId, CBBTC);
        vm.prank(account);
        pay.track(account, agentId, TSLA);
        assertEq(pay.tokensOf(account, agentId).length, 3);
        vm.prank(account);
        vm.expectRevert(FillmarkPay.NotOpen.selector);
        pay.track(account, agentId + 1, TSLA);
    }

    /// An untracked token is not billed until it is tracked, and only from then on.
    function test_UntrackedTokenNotBilled() public {
        address[] memory one = new address[](1);
        one[0] = CBBTC;
        vm.prank(account);
        pay.open(agentId, RATE, ZERO_AT, one);
        _buy(account, WETH, 4_000e6);
        assertEq(pay.dueOf(account, agentId).accrued, 0);
        vm.prank(agent);
        pay.track(account, agentId, WETH);
        assertEq(pay.dueOf(account, agentId).accrued, 0);
        _buy(account, WETH, 2_000e6);
        assertGt(pay.dueOf(account, agentId).accrued, 0);
        _check();
    }

    // ---- known limits ----

    /// Buy then sell: both are billed, at most about twice the rate for the round trip.
    function test_ChurnIsBilledBothWaysAndBounded() public {
        _open(account, ZERO_AT);
        uint256 units = _buy(account, WETH, 5_000e6);
        vm.warp(vm.getBlockTimestamp() + 1);
        _sell(account, WETH, units);
        (uint256 n, int256 c) = _sinceOpen(account);
        uint256 accrued = pay.dueOf(account, agentId).accrued;
        assertEq(accrued, _expected(RATE, ZERO_AT, n, c));
        assertLe(accrued, 2 * 5_000e6 * RATE / 1e4);
        assertEq(ROUTER.statsOf(agentId, account, WETH).fills, 2);
    }

    /// A frozen account cannot pay, but it can always close; what it owes becomes carry.
    function test_FrozenUsdgStopsSettleNotClose() public {
        _open(account, ZERO_AT);
        _buy(account, WETH, 4_000e6);
        uint256 due = pay.dueOf(account, agentId).due;
        address freezer = makeAddr("usdg-freezer");
        vm.prank(USDG_ADMIN);
        IUsdgFreeze(USDG).grantRole(USDG_FREEZE_ROLE, freezer);
        vm.prank(freezer);
        IUsdgFreeze(USDG).freeze(account);
        assertTrue(IUsdgFreeze(USDG).isFrozen(account));
        vm.expectRevert();
        _settle(account);
        vm.prank(account);
        pay.close(agentId);
        assertEq(pay.agreementOf(account, agentId).carry, due);
    }

    function test_PausedUsdgStopsSettleNotClose() public {
        _open(account, ZERO_AT);
        _buy(account, WETH, 4_000e6);
        uint256 due = pay.dueOf(account, agentId).due;
        address pauser = makeAddr("usdg-pauser");
        vm.prank(USDG_ADMIN);
        IUsdgFreeze(USDG).grantRole(USDG_PAUSE_ROLE, pauser);
        vm.prank(pauser);
        IUsdgPause(USDG).pause();
        assertTrue(IUsdgPause(USDG).paused());
        vm.expectRevert();
        _settle(account);
        vm.prank(account);
        pay.close(agentId);
        assertEq(pay.agreementOf(account, agentId).carry, due);
    }

    // ---- the pool ----

    /// Even when the agent accepts any price, a sandwich of its settle within one block
    /// loses money at every front-run size, though the front-run also raises the USDG side
    /// the budget is read from. The account owes more than any budget, so each settle buys
    /// the whole budget.
    function test_SandwichAroundSettleLosesMoney() public {
        _open(account, ZERO_AT);
        _buyBig(account, WETH, 400_000e6);
        uint256 side = _usdgSide();
        uint256[6] memory sizes = [side / 100, side / 20, side / 5, side / 2, side, side * 3];
        for (uint256 i; i < sizes.length; i++) {
            uint256 snap = vm.snapshotState();
            uint256 x = sizes[i];
            deal(USDG, address(this), x);
            _ponsSwap(true, x);
            uint256 paid = _settle(account);
            assertEq(paid, pay.dueOf(account, agentId).paid);
            assertGt(paid, 0);
            _ponsSwap(false, IERC20(TOKEN).balanceOf(address(this)));
            assertLt(_usdg(address(this)), x, "sandwich made money");
            vm.revertToState(snap);
        }
    }

    /// The same with a burn right after the agent's settle (Pay refuses only a burn earlier
    /// in the same second): both together buy at most 0.6% of the side, under the 1% fee
    /// an outside attacker pays per swap.
    function test_SandwichAroundSettleAndBurnLosesMoney() public {
        _open(account, ZERO_AT);
        _buyBig(account, WETH, 400_000e6);
        deal(USDG, address(BURNER), 1_000_000e6);
        uint256 side = _usdgSide();
        uint256[5] memory sizes = [side / 20, side / 5, side / 2, side, side * 3];
        for (uint256 i; i < sizes.length; i++) {
            uint256 snap = vm.snapshotState();
            uint256 x = sizes[i];
            deal(USDG, address(this), x);
            _ponsSwap(true, x);
            assertGt(_settle(account), 0);
            BURNER.burn();
            _ponsSwap(false, IERC20(TOKEN).balanceOf(address(this)));
            assertLt(_usdg(address(this)), x, "sandwich made money");
            vm.revertToState(snap);
        }
    }

    /// Only the agent wallet pinned in the router settles: not the account, not the identity
    /// owner, not anyone else, so no one else decides when the agent buys.
    function test_RevertWhen_NotTheAgentWallet() public {
        _open(account, ZERO_AT);
        _buy(account, WETH, 4_000e6);
        address[3] memory callers = [makeAddr("stranger"), account, owner];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(FillmarkPay.NotAgentWallet.selector);
            pay.settle(account, agentId, 0);
        }
        vm.prank(TEAM_AGENT);
        pay.setRate(TEAM_AGENT_ID, 2, 100);
        address[] memory t = new address[](1);
        t[0] = CBBTC;
        vm.prank(TEAM_ACCOUNT);
        pay.open(TEAM_AGENT_ID, 2, 100, t);
        vm.prank(SAFE); // owns the reference agent's identity, but is not its wallet
        vm.expectRevert(FillmarkPay.NotAgentWallet.selector);
        pay.settle(TEAM_ACCOUNT, TEAM_AGENT_ID, 0);
    }

    /// The wallet pinned in the router is the one that settles and is paid, even after the
    /// agent NFT changes hands (the registry then clears its wallet): not the new owner.
    function test_PinnedWalletSettlesAfterIdentityTransfer() public {
        _open(account, ZERO_AT);
        _buy(account, WETH, 4_000e6);
        address buyer = makeAddr("nft-buyer");
        vm.prank(agent);
        IIdentity(IDENTITY).transferFrom(agent, buyer, agentId);
        assertEq(IIdentity(IDENTITY).getAgentWallet(agentId), address(0));
        vm.prank(buyer);
        vm.expectRevert(FillmarkPay.NotAgentWallet.selector);
        pay.settle(account, agentId, 0);
        uint256 before = IERC20(TOKEN).balanceOf(agent);
        assertGt(_settle(account), 0);
        assertGt(IERC20(TOKEN).balanceOf(agent), before);
    }

    /// Review 1, M-1: someone pushes $FILLMARK up and holds it there for many blocks. With a
    /// minimum price from before the push, the agent's settles fail and buy nothing; the
    /// pusher only pays the pool fees. At the normal price the same minimum passes.
    function test_MinimumPriceStopsBuysAtAPushedPrice() public {
        _open(account, ZERO_AT);
        _buyBig(account, WETH, 100_000e6);
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        _settle(account);
        (uint256 usdgPaid, uint256 toAgent,,) = _settled();
        uint256 received = toAgent * 1e6 / usdgPaid; // what the agent receives per USDG
        uint256 minOut = received * 98 / 100; // 2% under the normal price
        vm.revertToState(snap);
        // The minimum is on what the agent receives, after the burn: the exact rate passes,
        // one part in 1,000 more does not.
        vm.prank(agent);
        assertEq(pay.settle(account, agentId, received), usdgPaid);
        vm.revertToState(snap);
        vm.prank(agent);
        vm.expectRevert(FillmarkPay.PriceMoved.selector);
        pay.settle(account, agentId, received + received / 1000 + 1);
        vm.revertToState(snap);

        uint256 x = _usdgSide() / 5;
        deal(USDG, address(this), x);
        _ponsSwap(true, x);
        for (uint256 i; i < 20; i++) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.prank(agent);
            vm.expectRevert(FillmarkPay.PriceMoved.selector);
            pay.settle(account, agentId, minOut);
        }
        assertEq(pay.agreementOf(account, agentId).paid, 0);
        _ponsSwap(false, IERC20(TOKEN).balanceOf(address(this)));
        assertLt(_usdg(address(this)), x, "the push made money");

        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(agent);
        assertGt(pay.settle(account, agentId, minOut), 0);
    }

    function test_RevertWhen_CallbackNotFromItsOwnSettle() public {
        vm.expectRevert(FillmarkPay.NotPoolManager.selector);
        pay.unlockCallback(abi.encode(account, agent, uint256(1e6), uint256(0)));
        vm.prank(POOL_MANAGER);
        vm.expectRevert(FillmarkPay.NotPoolManager.selector);
        pay.unlockCallback(abi.encode(account, address(this), uint256(1e6), uint256(0)));
    }

    // ---- the team's live account ----

    /// The team account and the reference agent as they are on chain: open from the
    /// account, the agent sells its real cbBTC lot, Pay bills it and pays the agent wallet.
    function test_TeamAccountWithTheReferenceAgent() public {
        vm.prank(TEAM_AGENT);
        pay.setRate(TEAM_AGENT_ID, 2, 100);
        address[] memory t = new address[](2);
        (t[0], t[1]) = (CBBTC, TSLA);
        vm.startPrank(TEAM_ACCOUNT);
        IERC20(USDG).approve(address(pay), 1e6);
        pay.open(TEAM_AGENT_ID, 2, 100, t);
        vm.stopPrank();
        FillmarkPay.Base[] memory b = pay.tokensOf(TEAM_ACCOUNT, TEAM_AGENT_ID);
        for (uint256 i; i < 2; i++) {
            FillmarkRouterV3.Stats memory s = ROUTER.statsOf(TEAM_AGENT_ID, TEAM_ACCOUNT, t[i]);
            assertEq(b[i].notional, s.notional);
            assertEq(b[i].sumCost, s.sumCost);
        }
        assertGe(ROUTER.statsOf(TEAM_AGENT_ID, TEAM_ACCOUNT, CBBTC).fills, 2); // its real fills

        (FillmarkRouterV3.Lot memory lot,,,) = ROUTER.positionOf(TEAM_ACCOUNT, TEAM_AGENT_ID, CBBTC);
        // About 10.5 USDG of it: at least the router's 10 USDG minimum, within the account's 11 per trade.
        (, int256 nav,,,) = IAggregatorV3(CBBTC_FEED).latestRoundData();
        uint256 qty = 10.5e6 * 1e10 / uint256(nav);
        assertLt(qty, lot.qty);
        _fair(CBBTC, 0);
        (,,,,, uint64 installId,,,,) = ROUTER.configs(TEAM_ACCOUNT);
        vm.prank(TEAM_AGENT);
        ROUTER.execute(
            FillmarkRouterV3.FillIntent(
                TEAM_AGENT_ID,
                TEAM_ACCOUNT,
                installId,
                CBBTC,
                USDG,
                qty,
                0,
                0,
                ++nonce,
                uint64(vm.getBlockTimestamp() + 10 minutes)
            )
        );
        FillmarkRouterV3.Stats memory after_ = ROUTER.statsOf(TEAM_AGENT_ID, TEAM_ACCOUNT, CBBTC);
        uint256 n = after_.notional - b[0].notional;
        int256 c = int256(after_.sumCost) - b[0].sumCost;
        FillmarkPay.Due memory d = pay.dueOf(TEAM_ACCOUNT, TEAM_AGENT_ID);
        assertEq(d.accrued, _expected(2, 100, n, c));
        assertGt(d.due, 0);
        uint256 before = _usdg(TEAM_ACCOUNT);
        uint256 got = IERC20(TOKEN).balanceOf(TEAM_AGENT);
        vm.prank(TEAM_AGENT);
        assertEq(pay.settle(TEAM_ACCOUNT, TEAM_AGENT_ID, 0), d.due);
        assertEq(before - _usdg(TEAM_ACCOUNT), d.due);
        assertGt(IERC20(TOKEN).balanceOf(TEAM_AGENT), got);
    }

    // ---- gas ----

    function test_GasOfSettle() public {
        address[] memory all = _allAssets();
        address acct = _createAccount(agentId, all, 50);
        deal(USDG, acct, 100_000e6);
        vm.startPrank(acct);
        IERC20(USDG).approve(address(pay), type(uint256).max);
        pay.open(agentId, RATE, ZERO_AT, all);
        vm.stopPrank();
        _buy(acct, WETH, 2_000e6);
        uint256 g = gasleft();
        pay.dueOf(acct, agentId);
        emit log_named_uint("gas dueOf, 28 tokens", g - gasleft());
        g = gasleft();
        _settle(acct);
        emit log_named_uint("gas settle, 28 tokens", g - gasleft());

        _open(account, ZERO_AT);
        _buy(account, WETH, 2_000e6);
        vm.roll(vm.getBlockNumber() + 1);
        g = gasleft();
        _settle(account);
        emit log_named_uint("gas settle, 2 tokens", g - gasleft());
    }

    // ---- helpers ----

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    function _expected(uint16 r, uint16 z, uint256 n, int256 c) internal pure returns (uint256) {
        uint256 full = n * r / 1e4;
        if (c <= 0) return full;
        uint256 cut = Math.ceilDiv(uint256(c) * r, z);
        return full > cut ? full - cut : 0;
    }

    function _check() internal view {
        (uint256 n, int256 c) = _sinceOpen(account);
        FillmarkPay.Agreement memory a = pay.agreementOf(account, agentId);
        assertEq(pay.dueOf(account, agentId).accrued, _expected(a.rateBps, a.zeroAtBps, n, c));
    }

    function _sinceOpen(address acct) internal view returns (uint256 n, int256 c) {
        FillmarkPay.Base[] memory b = pay.tokensOf(acct, agentId);
        for (uint256 i; i < b.length; i++) {
            FillmarkRouterV3.Stats memory s = ROUTER.statsOf(agentId, acct, b[i].token);
            n += s.notional - b[i].notional;
            c += int256(s.sumCost) - b[i].sumCost;
        }
    }

    /// Settles as the agent wallet, accepting any price.
    function _settle(address acct) internal returns (uint256) {
        vm.prank(agent);
        return pay.settle(acct, agentId, 0);
    }

    function _two() internal pure returns (address[] memory t) {
        t = new address[](2);
        (t[0], t[1]) = (WETH, CBBTC);
    }

    function _open(address acct, uint16 z) internal {
        uint16 rate = pay.termsOf(agentId).rateBps;
        vm.prank(acct);
        pay.open(agentId, rate, z, _two());
    }

    function _stocks() internal pure returns (address[] memory s) {
        s = new address[](4);
        (s[0], s[1], s[2], s[3]) = (WETH, CBBTC, TSLA, NVDA);
    }

    function _allAssets() internal view returns (address[] memory all) {
        // Every token router v3 has an official pool for.
        all = vm.parseJsonAddressArray(vm.readFile("v3-pools.json"), ".tokens");
    }

    /// A Kernel v3.1 account owned by `owner` with router v3 installed for `id`: high
    /// limits, 1% slippage, no performance fee, 30 days.
    function _createAccount(uint256 id, address[] memory stocks, uint256 salt) internal returns (address) {
        bytes memory data = abi.encode(
            id,
            uint128(500_000e6),
            uint128(5_000_000e6),
            uint64(vm.getBlockTimestamp() + 30 days),
            uint16(100),
            uint16(0),
            false,
            stocks
        );
        bytes[] memory initConfig = new bytes[](1);
        initConfig[0] = abi.encodeCall(
            IKernelV2.installModule, (2, address(ROUTER), abi.encodePacked(address(0), abi.encode(data, bytes(""))))
        );
        bytes21 root = bytes21(abi.encodePacked(bytes1(0x01), ECDSA_VALIDATOR));
        bytes memory init =
            abi.encodeCall(IKernelV2.initialize, (root, address(1), abi.encodePacked(owner), bytes(""), initConfig));
        return IKernelFactoryV2(KERNEL_FACTORY).createAccount(init, bytes32(salt));
    }

    function _userOp(address acct, bytes memory callData) internal {
        PackedOp memory op = PackedOp({
            sender: acct,
            nonce: IEntryPointV2(ENTRYPOINT).getNonce(acct, 0),
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
        vm.deal(acct, 1 ether);
        address bundler = makeAddr("bundler");
        vm.recordLogs();
        vm.prank(bundler, bundler);
        IEntryPointV2(ENTRYPOINT).handleOps(ops, payable(bundler));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool ok;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == ENTRYPOINT && logs[i].topics[0] == USER_OP_EVENT) {
                (, ok,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
        }
        assertTrue(ok, "user operation failed");
    }

    function _settled() internal view returns (uint256 usdgPaid, uint256 toAgent, uint256 burned, uint256 unpaid) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(pay) && logs[i].topics[0] == FillmarkPay.Settled.selector) {
                (usdgPaid, toAgent, burned, unpaid) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                found = true;
            }
        }
        assertTrue(found, "no Settled event");
    }

    function _usdg(address who) internal view returns (uint256) {
        return IERC20(USDG).balanceOf(who);
    }

    // Router fills, sent by the agent wallet like the live agent does.

    function _buy(address acct, address token, uint256 usdgAmount) internal returns (uint256) {
        return _exec(acct, USDG, token, usdgAmount);
    }

    function _sell(address acct, address token, uint256 qty) internal returns (uint256) {
        return _exec(acct, token, USDG, qty);
    }

    /// A buy larger than the pool can take near NAV: the pool gets liquidity first.
    function _buyBig(address acct, address token, uint256 usdgAmount) internal {
        _fair(token, 0);
        _buy(acct, token, usdgAmount);
    }

    function _exec(address acct, address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256) {
        (,,,,, uint64 installId,,,,) = ROUTER.configs(acct);
        vm.prank(agent);
        return ROUTER.execute(
            FillmarkRouterV3.FillIntent(
                agentId,
                acct,
                installId,
                tokenIn,
                tokenOut,
                amountIn,
                0,
                0,
                ++nonce,
                uint64(vm.getBlockTimestamp() + 10 minutes)
            )
        );
    }

    /// Moves the token's official pool to NAV x (1 + bps / 10,000), adds deep liquidity
    /// within 1% around it and holds it there for the router's TWAP window.
    function _fair(address token, int256 bps) internal {
        (, int256 answer,,,) = IAggregatorV3(_feedOf(token)).latestRoundData();
        uint256 price = uint256(answer * (1e4 + bps) / 1e4);
        address pool = ROUTER.poolOf(token).pool;
        uint256 scale = 10 ** (uint256(IERC20Metadata(token).decimals()) + 2);
        uint160 target = token < USDG
            ? uint160(Math.sqrt(Math.mulDiv(price, 1 << 192, scale)))
            : uint160(Math.sqrt(Math.mulDiv(scale, 1 << 192, price)));
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (sqrtP != target) IUniswapV3Pool(pool).swap(address(this), target < sqrtP, type(int128).max, target, "");
        _deepen(pool, IERC20Metadata(token).decimals() == 8 ? 1e15 : 1e20);
        vm.warp(vm.getBlockTimestamp() + TWAP);
    }

    /// Liquidity within about 1% on each side of the pool's price.
    function _deepen(address pool, uint128 liquidity) internal {
        (, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        int24 s = IPoolSpacing(pool).tickSpacing();
        int24 lo = (tick / s) * s;
        int24 w = (100 / s + 1) * s;
        IPoolMint(pool).mint(address(this), lo - w, lo + w, liquidity, "");
    }

    function _feedOf(address token) internal view returns (address) {
        return ROUTER.feeds().feedOf(token);
    }

    function uniswapV3MintCallback(uint256 a0, uint256 a1, bytes calldata) external {
        _payPool(IPoolMint(msg.sender).token0(), a0);
        _payPool(IPoolMint(msg.sender).token1(), a1);
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        if (d0 > 0) _payPool(IPoolMint(msg.sender).token0(), uint256(d0));
        if (d1 > 0) _payPool(IPoolMint(msg.sender).token1(), uint256(d1));
    }

    function _payPool(address token, uint256 amount) internal {
        if (amount == 0) return;
        deal(token, address(this), IERC20(token).balanceOf(address(this)) + amount);
        IERC20(token).transfer(msg.sender, amount);
    }

    // The Pons pool, traded directly through the PoolManager (as in the burner tests).

    bool private _usdgIn;
    uint256 private _amount;

    function _usdgSide() internal view returns (uint256) {
        uint256 l = IV4PositionManager(POSITION_MANAGER).getPositionLiquidity(BURNER.positionId());
        uint256 p = BURNER.sqrtPriceX96();
        return BURNER.poolKey().currency1 == USDG ? l * p / (1 << 96) : l * (1 << 96) / p;
    }

    function _ponsTick() internal view returns (int24) {
        bytes32 data =
            IV4PoolManager(POOL_MANAGER).extsload(keccak256(abi.encodePacked(BURNER.poolId(), bytes32(uint256(6)))));
        return int24(int256(uint256(data) >> 160));
    }

    function _ponsSwap(bool usdgIn, uint256 amount) internal {
        _usdgIn = usdgIn;
        _amount = amount;
        IV4PoolManager(POOL_MANAGER).unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == POOL_MANAGER);
        IV4PoolManager.PoolKey memory key = BURNER.poolKey();
        bool zeroForOne = key.currency0 == (_usdgIn ? USDG : TOKEN);
        int256 delta = IV4PoolManager(POOL_MANAGER)
            .swap(
                key,
                IV4PoolManager.SwapParams(
                    zeroForOne,
                    -int256(_amount),
                    zeroForOne ? 4295128739 + 1 : 1461446703485210103287273052203988822378723970342 - 1
                ),
                ""
            );
        _ponsSettle(key.currency0, int128(delta >> 128));
        _ponsSettle(key.currency1, int128(delta));
        return "";
    }

    function _ponsSettle(address currency, int128 d) internal {
        IV4PoolManager pm = IV4PoolManager(POOL_MANAGER);
        if (d < 0) {
            uint256 owe = uint256(int256(-d));
            uint256 have = IERC20(currency).balanceOf(address(this));
            if (have < owe) deal(currency, address(this), owe);
            pm.sync(currency);
            IERC20(currency).transfer(POOL_MANAGER, owe);
            pm.settle();
        } else if (d > 0) {
            pm.take(currency, address(this), uint256(int256(d)));
        }
    }
}
