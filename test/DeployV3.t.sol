// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ForkBase} from "./ForkBase.sol";
import {DeployV3} from "../script/DeployV3.s.sol";
import {FillmarkRouterV3} from "../src/FillmarkRouterV3.sol";
import {IUniswapV3Pool} from "../src/interfaces/External.sol";

/// The v3 deploy against the live contracts on a mainnet fork, with the pools file. Run with
/// FOUNDRY_PROFILE=chain: the deploy broadcasts a router over Ethereum's 24 KiB limit.
contract DeployV3ForkTest is ForkBase {
    DeployV3 script;
    FillmarkRouterV3 router;
    address deployer;

    function setUp() public {
        _fork();
        script = new DeployV3();
        (deployer,) = _key("deployer");
        vm.deal(deployer, 1 ether);
        router = script.deploy(deployer);
    }

    function test_DeployWiresV3ToLiveContracts() public view {
        script.check(router);
        assertEq(router.fillFeeBps(), 3);
        assertEq(router.hold(), 7 days);
        assertEq(router.MAX_POOL_CAP_BPS(), 100);
        DeployV3.Plan memory p = script.plan();
        assertGt(p.pools.length, 0);
        for (uint256 i; i < p.pools.length; i++) {
            (,,, uint16 cardinality,,,) = IUniswapV3Pool(p.pools[i].pool).slot0();
            assertGe(cardinality, router.minCardinality(), p.tickers[i]);
            assertLe(p.pools[i].twapCapBps, p.pools[i].capBps, p.tickers[i]);
        }
    }

    /// Only the timelock changes pools and the fill fee; the guardian only switches a pool
    /// off; the deployer has no power.
    function test_OnlyTimelockAndGuardian() public {
        DeployV3.Plan memory p = script.plan();
        address token = p.pools[0].token;
        address pool = p.pools[0].pool;
        vm.startPrank(deployer);
        vm.expectRevert(FillmarkRouterV3.NotAdmin.selector);
        router.setFillFeeBps(1);
        vm.expectRevert(FillmarkRouterV3.NotAdmin.selector);
        router.setPool(token, pool, 10, 10);
        vm.expectRevert(FillmarkRouterV3.NotAdmin.selector);
        router.poolOff(token);
        vm.stopPrank();
        vm.prank(script.GUARDIAN());
        router.poolOff(token);
        assertFalse(router.poolOf(token).active);
        vm.prank(script.GUARDIAN());
        vm.expectRevert(FillmarkRouterV3.NotAdmin.selector);
        router.setPool(token, pool, 10, 10);
        vm.prank(script.TIMELOCK());
        router.setPool(token, pool, 10, 10);
        assertTrue(router.poolOf(token).active);
    }
}
