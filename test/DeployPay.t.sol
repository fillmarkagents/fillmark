// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ForkBase} from "./ForkBase.sol";
import {DeployPay} from "../script/DeployPay.s.sol";
import {FillmarkBurner} from "../src/FillmarkBurner.sol";
import {FillmarkPay} from "../src/FillmarkPay.sol";

/// The Pay deploy against the live router v3 and burner on a mainnet fork, as it runs
/// before $FILLMARK exists: the burner has no token yet.
contract DeployPayForkTest is ForkBase {
    address constant TEAM_ACCOUNT = 0xB5667f1c68bADFc54CE5eaCc60EACb89473Ec37C;
    uint256 constant TEAM_AGENT_ID = 26144;
    address constant TEAM_AGENT = 0xDCe0AAc0A8E6629A0ae3c739ced29B8B31c960B8;
    address constant SAFE = 0x6C3a19517e5c1cff510BC163DCA4a46C7a969261;

    DeployPay script;
    FillmarkPay pay;
    address deployer;

    function setUp() public {
        _fork();
        script = new DeployPay();
        (deployer,) = _key("deployer");
        vm.deal(deployer, 1 ether);
        pay = script.deploy(deployer);
    }

    function test_DeployWiresPayToLiveContracts() public view {
        script.check(pay);
        assertEq(FillmarkBurner(script.BURNER()).token(), address(0));
        assertEq(pay.blockBudgetLeft(), 0);
    }

    /// Before the token: the reference agent sets its terms (wallet or the Safe that owns
    /// its identity), the team account opens an agreement, and settle pays nothing.
    function test_UsableBeforeTheToken() public {
        vm.prank(TEAM_AGENT);
        pay.setRate(TEAM_AGENT_ID, 2, 100);
        vm.prank(SAFE);
        pay.setRate(TEAM_AGENT_ID, 2, 100);
        address[] memory t = new address[](2);
        (t[0], t[1]) = (CBBTC, TSLA);
        vm.prank(TEAM_ACCOUNT);
        pay.open(TEAM_AGENT_ID, 2, 100, t);
        assertTrue(pay.agreementOf(TEAM_ACCOUNT, TEAM_AGENT_ID).open);
        vm.prank(TEAM_AGENT);
        assertEq(pay.settle(TEAM_ACCOUNT, TEAM_AGENT_ID, 0), 0);
        vm.prank(deployer);
        vm.expectRevert(FillmarkPay.NotAgentWallet.selector);
        pay.settle(TEAM_ACCOUNT, TEAM_AGENT_ID, 0);
    }
}
