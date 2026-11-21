// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ForkBase} from "./ForkBase.sol";
import {FillmarkBurner} from "../src/FillmarkBurner.sol";
import {IPonsV2Factory, IV4PoolManager, IV4PositionManager} from "../src/interfaces/ExternalV2.sol";

interface IV4Liquidity {
    struct ModifyLiquidityParams {
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
    }

    function modifyLiquidity(IV4PoolManager.PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata)
        external
        returns (int256 callerDelta, int256 feesAccrued);
}

/// Fork tests of the burner against real Pons V2 launches paired with USDG, the real
/// Pons hook, locker and Uniswap v4 PoolManager on Robinhood Chain. No mocks.
contract BurnerForkTest is ForkBase {
    address constant PONS = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    // Graduated Pons V2 launch paired with USDG, creator tax 0 and Pons buyback off,
    // the settings Fillmark plans for $FILLMARK.
    address constant TOKEN = 0x2f91580ea6824212B26637014c756284cB7594dF;
    address constant ETH_PAIRED = 0xBD1d57140EB22c2A34bC1ee055f7b6119cbf6C17; // graduated, paired with ETH
    address constant NOT_GRADUATED = 0x5E060113a5188fF0435989668ecfed5Bd496547E; // USDG pair, still on its curve
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    FillmarkBurner burner;
    address timelock = makeAddr("timelock");
    IV4PoolManager.PoolKey key;

    function setUp() public {
        _fork();
        burner = new FillmarkBurner(USDG, timelock, IPonsV2Factory(PONS));
        vm.prank(timelock);
        burner.setToken(TOKEN);
        key = burner.poolKey();
    }

    // ---- token checks ----

    function test_SetTokenOnlyOnceAndOnlyByAdmin() public {
        assertEq(burner.token(), TOKEN);
        assertEq(burner.positionId(), 4335046); // the position the Pons locker holds for TOKEN
        assertEq(key.hooks, 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044);
        assertEq(key.tickSpacing, 200);
        assertEq(key.fee, 0);
        vm.prank(timelock);
        vm.expectRevert(FillmarkBurner.AlreadySet.selector);
        burner.setToken(TOKEN);

        FillmarkBurner fresh = new FillmarkBurner(USDG, timelock, IPonsV2Factory(PONS));
        vm.expectRevert(FillmarkBurner.NotAdmin.selector);
        fresh.setToken(TOKEN);
    }

    function test_RevertWhen_TokenIsNotAGraduatedUsdgPonsLaunch() public {
        FillmarkBurner fresh = new FillmarkBurner(USDG, timelock, IPonsV2Factory(PONS));
        address[4] memory bad = [USDG, TSLA, ETH_PAIRED, NOT_GRADUATED];
        for (uint256 i; i < bad.length; i++) {
            vm.prank(timelock);
            vm.expectRevert(FillmarkBurner.BadToken.selector);
            fresh.setToken(bad[i]);
        }
        vm.expectRevert(FillmarkBurner.NoToken.selector);
        fresh.burn();
        assertEq(fresh.maxBurn(), 0);
    }

    // ---- burning ----

    function test_BurnBuysTokenToDeadAtMostCapPerHour() public {
        deal(USDG, address(burner), 1_000_000e6);
        uint256 cap = burner.maxBurn();
        assertGt(cap, 0);
        uint256 deadBefore = IERC20(TOKEN).balanceOf(DEAD);
        uint256 supplyBefore = IERC20(TOKEN).totalSupply();

        (uint256 usdgIn, uint256 tokenOut) = burner.burn();
        assertEq(usdgIn, cap);
        assertGt(tokenOut, 0);
        assertEq(IERC20(USDG).balanceOf(address(burner)), 1_000_000e6 - cap);
        assertEq(IERC20(TOKEN).balanceOf(DEAD), deadBefore + tokenOut);
        assertEq(IERC20(TOKEN).balanceOf(address(burner)), 0);
        assertEq(IERC20(TOKEN).totalSupply(), supplyBefore); // sent to 0xdEaD, not burned
        // The USDG side is the locked position's at the current price; 0.5% of it.
        assertApproxEqRel(cap * 200, _usdgSide(), 0.01e18);

        vm.expectRevert(FillmarkBurner.TooSoon.selector);
        burner.burn();
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        (uint256 again,) = burner.burn();
        assertGt(again, 0);
    }

    function test_BurnSpendsOnlyWhatItHolds() public {
        deal(USDG, address(burner), 3e6);
        (uint256 usdgIn,) = burner.burn();
        assertEq(usdgIn, 3e6);
        assertEq(IERC20(USDG).balanceOf(address(burner)), 0);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.expectRevert(FillmarkBurner.NothingToBurn.selector);
        burner.burn();
    }

    function test_RevertWhen_CallbackNotFromPoolManager() public {
        vm.expectRevert(FillmarkBurner.NotPoolManager.selector);
        burner.unlockCallback(abi.encode(uint256(1e6)));
    }

    /// Second design review, H1: a sandwich around burn() must lose money. The attacker
    /// buys first (which also raises the USDG side the cap is read from), lets the burner
    /// buy, then sells everything back. Tried across front-run sizes up to 3x the pool.
    function test_SandwichAroundBurnLosesMoney() public {
        deal(USDG, address(burner), 1_000_000e6);
        uint256 side = _usdgSide();
        uint256[6] memory sizes = [side / 100, side / 20, side / 5, side / 2, side, side * 3];
        for (uint256 i; i < sizes.length; i++) {
            uint256 snap = vm.snapshotState();
            uint256 x = sizes[i];
            deal(USDG, address(this), x);
            _swap(true, x); // front-run: USDG -> token
            burner.burn();
            _swap(false, IERC20(TOKEN).balanceOf(address(this))); // back-run: everything back
            assertLt(IERC20(USDG).balanceOf(address(this)), x, "sandwich made money");
            vm.revertToState(snap);
        }
    }

    /// The same sandwich with the attacker also providing liquidity right where the
    /// burner buys (so the burner's USDG lands in the attacker's own position), then
    /// removing it and selling everything back. Still a loss.
    function test_SandwichWithJitLiquidityLosesMoney() public {
        deal(USDG, address(this), 0);
        deal(USDG, address(burner), 1_000_000e6);
        uint256 side = _usdgSide();
        uint256[3] memory sizes = [side / 20, side / 2, side * 2];
        for (uint256 i; i < sizes.length; i++) {
            uint256 snap = vm.snapshotState();
            uint256 x = sizes[i];
            uint160 fair = burner.sqrtPriceX96(); // the price before the attack
            deal(USDG, address(this), x);
            _swap(true, x); // push the price up
            int24 tick = _tick();
            int24 lo = (tick / 200) * 200;
            _addLiquidity(lo - 200, lo + 400, 1e22); // what it pays is dealt and counted
            uint256 spentUsdg = _paidUsdg;
            uint256 spentToken = _paidToken;
            burner.burn();
            _removeLiquidity(lo - 200, lo + 400, 1e22);
            uint256 tokens = IERC20(TOKEN).balanceOf(address(this));
            if (tokens != 0) _swap(false, tokens); // sell everything back
            // Tokens the attacker had to bring are valued at the price before the attack.
            uint256 brought = x + spentUsdg + _toUsdg(spentToken, fair);
            assertLt(IERC20(USDG).balanceOf(address(this)), brought, "JIT sandwich made money");
            vm.revertToState(snap);
        }
    }

    /// Liquidity anyone adds to the pool does not raise the cap: it reads only the
    /// position Pons locked at graduation.
    function test_AddedLiquidityDoesNotRaiseCap() public {
        uint256 cap = burner.maxBurn();
        int24 tick = _tick();
        int24 lo = (tick / 200) * 200 - 200;
        _addLiquidity(lo, lo + 400, 1e24);
        assertEq(burner.maxBurn(), cap);
    }

    // ---- helpers ----

    function _usdgSide() internal view returns (uint256) {
        uint256 l =
            IV4PositionManager(0x58daec3116aae6D93017bAAea7749052E8a04fA7).getPositionLiquidity(burner.positionId());
        uint256 p = burner.sqrtPriceX96();
        return key.currency1 == USDG ? l * p / (1 << 96) : l * (1 << 96) / p;
    }

    /// USDG value of `amount` token units at sqrtPriceX96 `p`.
    function _toUsdg(uint256 amount, uint160 p) internal view returns (uint256) {
        uint256 q = Math.mulDiv(p, p, 1 << 96); // currency1 per currency0, scaled by 2^96
        return key.currency1 == USDG ? Math.mulDiv(amount, q, 1 << 96) : Math.mulDiv(amount, 1 << 96, q);
    }

    function _tick() internal view returns (int24 t) {
        bytes32 data =
            IV4PoolManager(POOL_MANAGER).extsload(keccak256(abi.encodePacked(burner.poolId(), bytes32(uint256(6)))));
        t = int24(int256(uint256(data) >> 160));
    }

    uint8 private _mode;
    uint256 private _paidUsdg; // dealt to pay the pool in the last call
    uint256 private _paidToken;
    uint256 private _amount;
    int24 private _lo;
    int24 private _hi;

    function _swap(bool usdgIn, uint256 amount) internal {
        _mode = usdgIn ? 1 : 2;
        _amount = amount;
        IV4PoolManager(POOL_MANAGER).unlock("");
    }

    function _removeLiquidity(int24 lo, int24 hi, uint256 liquidity) internal {
        _mode = 4;
        _amount = liquidity;
        _lo = lo;
        _hi = hi;
        IV4PoolManager(POOL_MANAGER).unlock("");
    }

    function _addLiquidity(int24 lo, int24 hi, uint256 liquidity) internal {
        _paidUsdg = 0;
        _paidToken = 0;
        _mode = 3;
        _amount = liquidity;
        _lo = lo;
        _hi = hi;
        IV4PoolManager(POOL_MANAGER).unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == POOL_MANAGER);
        IV4PoolManager pm = IV4PoolManager(POOL_MANAGER);
        int256 delta;
        if (_mode == 3) {
            (delta,) = IV4Liquidity(POOL_MANAGER)
                .modifyLiquidity(key, IV4Liquidity.ModifyLiquidityParams(_lo, _hi, int256(_amount), bytes32(0)), "");
        } else {
            address input = _mode == 1 ? USDG : TOKEN;
            bool zeroForOne = key.currency0 == input;
            delta = pm.swap(
                key,
                IV4PoolManager.SwapParams(
                    zeroForOne,
                    -int256(_amount),
                    zeroForOne ? 4295128739 + 1 : 1461446703485210103287273052203988822378723970342 - 1
                ),
                ""
            );
        }
        _settle(key.currency0, int128(delta >> 128));
        _settle(key.currency1, int128(delta));
        return "";
    }

    function _settle(address currency, int128 d) internal {
        IV4PoolManager pm = IV4PoolManager(POOL_MANAGER);
        if (d < 0) {
            uint256 owe = uint256(int256(-d));
            uint256 have = IERC20(currency).balanceOf(address(this));
            if (have < owe) {
                deal(currency, address(this), owe);
                if (currency == USDG) _paidUsdg += owe - have;
                else _paidToken += owe - have;
            }
            pm.sync(currency);
            IERC20(currency).transfer(POOL_MANAGER, owe);
            pm.settle();
        } else if (d > 0) {
            pm.take(currency, address(this), uint256(int256(d)));
        }
    }
}
