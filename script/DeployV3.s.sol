// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {FillmarkFeeds} from "../src/FillmarkFeeds.sol";
import {FillmarkRouterV3} from "../src/FillmarkRouterV3.sol";
import {FillmarkBurner} from "../src/FillmarkBurner.sol";
import {IIdentityRegistry, IReputationRegistry, IUniswapV3Factory} from "../src/interfaces/External.sol";

/// Deploys FillmarkRouterV3 next to the live contracts on Robinhood Chain (4663): the live
/// FillmarkFeeds, the live burner, the live timelock (owned by the Safe 2-of-3) as admin,
/// and the live feeds guardian, who may only switch a pool off. The official pools and
/// their bounds come from v3-pools.json, written from the price sampler's measurements.
/// Nothing of v1 or v2 changes. The deployer gets no role.
///
/// FILLMARK_RPC=<url> FILLMARK_DEPLOYER=0x.. FOUNDRY_PROFILE=chain forge script \
///     script/DeployV3.s.sol --rpc-url robinhood --account <keystore> \
///     --sender $FILLMARK_DEPLOYER --broadcast
/// Profile "chain" sets Robinhood Chain's 98,304-byte contract size limit.
contract DeployV3 is Script {
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // Live deployments (deployments/4663.json and 4663-v2.json).
    address constant SAFE = 0x6C3a19517e5c1cff510BC163DCA4a46C7a969261;
    address public constant TIMELOCK = 0x54b6b215e216938Cb673b5d256593c0a1dDacAC3;
    address constant FEEDS = 0xa54584AA004DD9E60522437A96F700d6d283EAA0;
    address constant BURNER = 0x418106F0356E638C3823221FDBd2fBb3e8D7B024;
    address public constant GUARDIAN = 0x534eeE806911FF49529e49A6cb94A5B3A6e9cBc3; // the feeds' guardian

    uint16 public constant FILL_FEE_BPS = 3;
    uint64 public constant HOLD = 7 days;
    uint256 public constant TIMELOCK_DELAY = 2 days;
    string public constant POOLS_FILE = "v3-pools.json";

    struct Plan {
        uint32 twapWindow;
        FillmarkRouterV3.InitialPool[] pools;
        string[] tickers;
    }

    function run() external returns (FillmarkRouterV3) {
        return deploy(vm.envAddress("FILLMARK_DEPLOYER"));
    }

    function deploy(address deployer) public returns (FillmarkRouterV3 r) {
        require(block.chainid == 4663, "not Robinhood Chain");
        _checkLive(deployer);
        Plan memory p = plan();
        vm.startBroadcast(deployer);
        r = new FillmarkRouterV3(
            FillmarkRouterV3.Setup({
                identity: IIdentityRegistry(IDENTITY),
                reputation: IReputationRegistry(REPUTATION),
                factory: IUniswapV3Factory(FACTORY),
                usdg: USDG,
                feeds: FillmarkFeeds(FEEDS),
                burner: BURNER,
                admin: TIMELOCK,
                guardian: GUARDIAN,
                fillFeeBps: FILL_FEE_BPS,
                hold: HOLD,
                twapWindow: p.twapWindow
            }),
            p.pools
        );
        vm.stopBroadcast();
        check(r);
    }

    /// The pools file: each official pool with its ticker, and the TWAP window.
    function plan() public view returns (Plan memory p) {
        string memory j = vm.readFile(POOLS_FILE);
        p.twapWindow = uint32(vm.parseJsonUint(j, ".twapWindow"));
        p.tickers = vm.parseJsonStringArray(j, ".tickers");
        address[] memory tokens = vm.parseJsonAddressArray(j, ".tokens");
        address[] memory pools = vm.parseJsonAddressArray(j, ".pools");
        uint256[] memory caps = vm.parseJsonUintArray(j, ".capBps");
        uint256[] memory twapCaps = vm.parseJsonUintArray(j, ".twapCapBps");
        uint256 n = tokens.length;
        require(
            p.tickers.length == n && pools.length == n && caps.length == n && twapCaps.length == n && n != 0,
            "pools file lengths"
        );
        p.pools = new FillmarkRouterV3.InitialPool[](n);
        for (uint256 i; i < n; i++) {
            require(caps[i] <= type(uint16).max && twapCaps[i] <= type(uint16).max, "cap size");
            for (uint256 k; k < i; k++) {
                require(tokens[k] != tokens[i], "token twice");
            }
            p.pools[i] = FillmarkRouterV3.InitialPool(tokens[i], pools[i], uint16(caps[i]), uint16(twapCaps[i]));
        }
    }

    /// The live pieces v3 relies on are what the deployment records say.
    function _checkLive(address deployer) private view {
        TimelockController t = TimelockController(payable(TIMELOCK));
        require(FillmarkFeeds(FEEDS).admin() == TIMELOCK, "feeds admin");
        require(FillmarkFeeds(FEEDS).guardian() == GUARDIAN, "feeds guardian");
        require(FillmarkBurner(BURNER).admin() == TIMELOCK && FillmarkBurner(BURNER).usdg() == USDG, "burner");
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
        require(deployer != GUARDIAN, "deployer is the guardian");
    }

    function check(FillmarkRouterV3 r) public view {
        require(address(r.identity()) == IDENTITY && address(r.reputation()) == REPUTATION, "registries");
        require(address(r.factory()) == FACTORY && r.usdg() == USDG && address(r.feeds()) == FEEDS, "wiring");
        require(r.burner() == BURNER && r.admin() == TIMELOCK && r.guardian() == GUARDIAN, "roles");
        require(r.fillFeeBps() == FILL_FEE_BPS && r.hold() == HOLD, "fees");
        Plan memory p = plan();
        require(r.twapWindow() == p.twapWindow, "twap window");
        for (uint256 i; i < p.pools.length; i++) {
            FillmarkRouterV3.PoolCfg memory c = r.poolOf(p.pools[i].token);
            require(
                c.active && c.pool == p.pools[i].pool && c.capBps == p.pools[i].capBps
                    && c.twapCapBps == p.pools[i].twapCapBps,
                "pool config"
            );
            require(
                keccak256(bytes(FillmarkFeeds(FEEDS).tickerOf(p.pools[i].token))) == keccak256(bytes(p.tickers[i])),
                "ticker"
            );
        }
    }
}
