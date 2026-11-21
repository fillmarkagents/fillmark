// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {FillmarkFeeds} from "../src/FillmarkFeeds.sol";
import {FillmarkRouterV2} from "../src/FillmarkRouterV2.sol";
import {FillmarkBurner} from "../src/FillmarkBurner.sol";
import {IIdentityRegistry, IReputationRegistry, IUniswapV3Factory} from "../src/interfaces/External.sol";
import {IPonsV2Factory} from "../src/interfaces/ExternalV2.sol";

/// Deploys Fillmark v2 next to the live v1 contracts on Robinhood Chain (4663): the
/// burner, then FillmarkRouterV2 using the live FillmarkFeeds and the live timelock
/// (owned by the Safe 2-of-3) as admin of both. Nothing of v1 changes; v1 keeps running
/// until its clients move. The deployer gets no role in either contract.
///
/// FILLMARK_RPC=<url> FILLMARK_DEPLOYER=0x.. forge script script/DeployV2.s.sol \
///     --rpc-url robinhood --account <keystore> --sender $FILLMARK_DEPLOYER --broadcast \
///     --code-size-limit 98304
/// The router is larger than Ethereum's 24 KiB; Robinhood Chain allows 98304 bytes.
contract DeployV2 is Script {
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // Live v1 deployment (deployments/4663.json).
    address constant SAFE = 0x6C3a19517e5c1cff510BC163DCA4a46C7a969261;
    address public constant TIMELOCK = 0x54b6b215e216938Cb673b5d256593c0a1dDacAC3;
    address constant FEEDS = 0xa54584AA004DD9E60522437A96F700d6d283EAA0;
    // Pons V2 launch factory, where $FILLMARK launches paired with USDG.
    address constant PONS = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant PONS_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant PONS_LOCKER = 0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952;
    address constant V4_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant V4_POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;

    uint16 public constant FILL_FEE_BPS = 3;
    uint64 public constant HOLD = 7 days;
    uint256 public constant TIMELOCK_DELAY = 2 days;

    struct Deployment {
        FillmarkBurner burner;
        FillmarkRouterV2 router;
    }

    function run() external returns (Deployment memory) {
        return deploy(vm.envAddress("FILLMARK_DEPLOYER"));
    }

    function deploy(address deployer) public returns (Deployment memory d) {
        require(block.chainid == 4663, "not Robinhood Chain");
        _checkLive(deployer);
        vm.startBroadcast(deployer);
        d.burner = new FillmarkBurner(USDG, TIMELOCK, IPonsV2Factory(PONS));
        d.router = new FillmarkRouterV2(
            IIdentityRegistry(IDENTITY),
            IReputationRegistry(REPUTATION),
            IUniswapV3Factory(FACTORY),
            USDG,
            FillmarkFeeds(FEEDS),
            address(d.burner),
            TIMELOCK,
            FILL_FEE_BPS,
            HOLD
        );
        vm.stopBroadcast();
        check(d);
    }

    /// The live v1 pieces v2 relies on are what deployments/4663.json says.
    function _checkLive(address deployer) private view {
        TimelockController t = TimelockController(payable(TIMELOCK));
        require(FillmarkFeeds(FEEDS).admin() == TIMELOCK, "feeds admin");
        require(t.getMinDelay() == TIMELOCK_DELAY, "timelock delay");
        require(
            t.hasRole(t.PROPOSER_ROLE(), SAFE) && t.hasRole(t.EXECUTOR_ROLE(), SAFE)
                && t.hasRole(t.CANCELLER_ROLE(), SAFE),
            "timelock roles"
        );
        require(
            !t.hasRole(t.DEFAULT_ADMIN_ROLE(), deployer) && !t.hasRole(t.PROPOSER_ROLE(), deployer)
                && !t.hasRole(t.EXECUTOR_ROLE(), deployer) && !t.hasRole(t.CANCELLER_ROLE(), deployer),
            "deployer has a timelock role"
        );
        IPonsV2Factory p = IPonsV2Factory(PONS);
        require(
            p.memeHook() == PONS_HOOK && p.locker() == PONS_LOCKER && p.poolManager() == V4_POOL_MANAGER
                && p.positionManager() == V4_POSITION_MANAGER,
            "pons wiring"
        );
    }

    function check(Deployment memory d) public view {
        FillmarkRouterV2 r = d.router;
        FillmarkBurner b = d.burner;
        require(address(r.identity()) == IDENTITY && address(r.reputation()) == REPUTATION, "registries");
        require(address(r.factory()) == FACTORY && r.usdg() == USDG && address(r.feeds()) == FEEDS, "router wiring");
        require(r.burner() == address(b) && r.admin() == TIMELOCK, "router admin");
        require(r.fillFeeBps() == FILL_FEE_BPS && r.hold() == HOLD, "router fees");
        require(b.usdg() == USDG && b.admin() == TIMELOCK && address(b.pons()) == PONS, "burner wiring");
        require(b.token() == address(0) && b.lastBurn() == 0, "burner fresh");
        require(
            address(b.poolManager()) == IPonsV2Factory(PONS).poolManager()
                && address(b.positionManager()) == IPonsV2Factory(PONS).positionManager(),
            "burner pons"
        );
    }
}
