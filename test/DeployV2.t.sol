// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ForkBase} from "./ForkBase.sol";
import {DeployV2} from "../script/DeployV2.s.sol";
import {FillmarkRouterV2} from "../src/FillmarkRouterV2.sol";
import {FillmarkBurner} from "../src/FillmarkBurner.sol";

/// The v2 deploy against the live v1 contracts on a mainnet fork.
contract DeployV2ForkTest is ForkBase {
    DeployV2 script;
    DeployV2.Deployment d;
    address deployer;

    function setUp() public {
        _fork();
        script = new DeployV2();
        (deployer,) = _key("deployer");
        vm.deal(deployer, 1 ether);
        d = script.deploy(deployer);
    }

    function test_DeployWiresV2ToLiveV1() public view {
        script.check(d);
        assertEq(d.router.fillFeeBps(), 3);
        assertEq(d.router.hold(), 7 days);
        assertEq(d.router.MAX_FILL_FEE_BPS(), 10);
        assertEq(d.router.MAX_PERF_FEE_BPS(), 3_000);
    }

    /// Only the timelock can change the fill fee or set the burner's token, and the
    /// deployer has no power over either contract.
    function test_OnlyTimelockAdministers() public {
        address timelock = script.TIMELOCK();
        vm.prank(deployer);
        vm.expectRevert(FillmarkRouterV2.NotAdmin.selector);
        d.router.setFillFeeBps(1);
        vm.prank(deployer);
        vm.expectRevert(FillmarkBurner.NotAdmin.selector);
        d.burner.setToken(USDG);
        vm.prank(timelock);
        d.router.setFillFeeBps(10);
        assertEq(d.router.fillFeeBps(), 10);
        vm.prank(timelock);
        vm.expectRevert(FillmarkRouterV2.BadConfig.selector);
        d.router.setFillFeeBps(11);
    }

    /// Nothing can take USDG out of the burner before a token is set.
    function test_BurnerKeepsFeesUntilTokenSet() public {
        deal(USDG, address(d.burner), 100e6);
        vm.expectRevert(FillmarkBurner.NoToken.selector);
        d.burner.burn();
        assertEq(IERC20(USDG).balanceOf(address(d.burner)), 100e6);
    }
}
