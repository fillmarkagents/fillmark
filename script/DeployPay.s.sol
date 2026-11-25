// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {FillmarkBurner} from "../src/FillmarkBurner.sol";
import {FillmarkPay} from "../src/FillmarkPay.sol";
import {FillmarkRouterV3} from "../src/FillmarkRouterV3.sol";

/// Deploys FillmarkPay on Robinhood Chain (4663) next to the live router v3. Pay has no
/// owner and takes the router as its only argument; it reads the burner, USDG, the
/// ERC-8004 identity registry and the Pons pool managers from it. It can be deployed
/// before the burner has its token: until then settle pays nothing.
///
/// FILLMARK_RPC=<url> FILLMARK_DEPLOYER=0x.. forge script script/DeployPay.s.sol \
///     --rpc-url robinhood --account <keystore> --sender $FILLMARK_DEPLOYER --broadcast
contract DeployPay is Script {
    // Live deployments (deployments/4663-v2.json and 4663-v3.json).
    address public constant ROUTER = 0x6F01e2bE7d1D31E88dF177bEC23392D1905FC8Aa;
    address public constant BURNER = 0x418106F0356E638C3823221FDBd2fBb3e8D7B024;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;

    function run() external returns (FillmarkPay) {
        return deploy(vm.envAddress("FILLMARK_DEPLOYER"));
    }

    function deploy(address deployer) public returns (FillmarkPay p) {
        require(block.chainid == 4663, "not Robinhood Chain");
        FillmarkRouterV3 r = FillmarkRouterV3(ROUTER);
        require(r.burner() == BURNER && r.usdg() == USDG && address(r.identity()) == IDENTITY, "router wiring");
        FillmarkBurner b = FillmarkBurner(BURNER);
        require(
            address(b.poolManager()) == POOL_MANAGER && address(b.positionManager()) == POSITION_MANAGER,
            "burner wiring"
        );
        vm.startBroadcast(deployer);
        p = new FillmarkPay(r);
        vm.stopBroadcast();
        check(p);
    }

    function check(FillmarkPay p) public view {
        require(address(p.router()) == ROUTER && address(p.burner()) == BURNER && p.usdg() == USDG, "wiring");
        require(address(p.identity()) == IDENTITY, "identity");
        require(address(p.poolManager()) == POOL_MANAGER && address(p.positionManager()) == POSITION_MANAGER, "pools");
        require(
            p.MAX_RATE_BPS() == 5 && p.MAX_ZERO_AT_BPS() == 1_000 && p.BURN_SHARE_BPS() == 1_000
                && p.BLOCK_BUY_BPS() == 10 && p.MAX_TOKENS() == 32,
            "constants"
        );
    }
}
