// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FillmarkFeeds} from "../src/FillmarkFeeds.sol";
import {FillmarkRouter} from "../src/FillmarkRouter.sol";
import {IIdentityRegistry, IReputationRegistry, IUniswapV3Factory} from "../src/interfaces/External.sol";

/// Safe v1.4.1 (canonical deployments, code hashes checked on Robinhood Chain).
interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

/// Deploys Fillmark on Robinhood Chain mainnet (4663):
/// 1. the owner: a Safe 2-of-3 of FILLMARK_SAFE_OWNERS;
/// 2. a self-administered TimelockController, with the deployer as its only proposer,
///    canceller and executor for setup;
/// 3. FillmarkFeeds with the timelock as admin;
/// 4. one timelock batch (delay 0) that adds every token in assets.json, the session periods
///    through 2028 and the NYSE closures through 2028, gives every timelock role to the Safe,
///    takes them from the deployer, and last raises the timelock delay to 2 days;
/// 5. FillmarkRouter.
///
/// FILLMARK_RPC=<url> FILLMARK_DEPLOYER=0x.. FILLMARK_GUARDIAN=0x.. FILLMARK_SAFE_OWNERS=0x..,0x..,0x.. \
///     forge script script/Deploy.s.sol --rpc-url robinhood --account <keystore> --sender $FILLMARK_DEPLOYER --broadcast
/// `robinhood` is the foundry.toml alias for $FILLMARK_RPC, so the URL stays out of the
/// process list. forge also writes it to cache/Deploy.s.sol/4663/: delete that afterwards.
contract Deploy is Script {
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant SAFE_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_FALLBACK = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    uint256 public constant SAFE_THRESHOLD = 2;

    /// assets.json keys are sorted, as abi.decode of parseJson needs struct fields in that order.
    /// The decimals and tickers are checked against the token when it is added.
    struct Stock {
        uint256 decimals;
        address feed;
        uint256 maxAge; // 6h, or the heartbeat plus 1h for a feed that only updates on it
        bool multiplierInFeed; // false: the feed prices the underlying alone
        string ticker;
        address token;
    }

    struct Crypto {
        uint256 decimals;
        address feed;
        uint256 maxAge; // the feed's heartbeat plus a margin
        string ticker;
        address token;
    }

    uint256 public constant TIMELOCK_DELAY = 2 days;
    /// The calendar starts this long after the simulated deploy time, so the batch
    /// still holds when the transactions land a little later.
    uint64 public constant LEAD = 30 minutes;
    bytes32 constant SALT = keccak256("fillmark-setup-v1");

    struct Deployment {
        address owner; // the Safe
        TimelockController timelock;
        FillmarkFeeds feeds;
        FillmarkRouter router;
    }

    function run() external returns (Deployment memory) {
        return deploy(
            vm.envAddress("FILLMARK_DEPLOYER"),
            vm.envAddress("FILLMARK_GUARDIAN"),
            vm.envAddress("FILLMARK_SAFE_OWNERS", ",")
        );
    }

    function deploy(address deployer, address guardian, address[] memory signers) public returns (Deployment memory d) {
        require(block.chainid == 4663, "not Robinhood Chain");
        _checkKeys(deployer, guardian, signers);

        vm.startBroadcast(deployer);
        d.owner = _createSafe(signers);
        address[] memory roles = new address[](1);
        roles[0] = deployer;
        d.timelock = new TimelockController(0, roles, roles, address(0));
        d.feeds = new FillmarkFeeds(address(d.timelock), guardian);
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            setupCalls(d.timelock, d.feeds, deployer, d.owner);
        d.timelock.scheduleBatch(targets, values, payloads, bytes32(0), SALT, 0);
        d.timelock.executeBatch(targets, values, payloads, bytes32(0), SALT);
        _checkHandover(d.timelock, deployer, d.owner);
        d.router = new FillmarkRouter(
            IIdentityRegistry(IDENTITY), IReputationRegistry(REPUTATION), IUniswapV3Factory(FACTORY), USDG, d.feeds
        );
        vm.stopBroadcast();
    }

    /// Three distinct signers, none of them the deployer or the guardian (keys on the VPS).
    function _checkKeys(address deployer, address guardian, address[] memory signers) private pure {
        require(deployer != address(0) && guardian != address(0) && deployer != guardian, "deployer/guardian");
        require(signers.length == 3, "need 3 Safe owners");
        for (uint256 i; i < 3; i++) {
            require(signers[i] != address(0) && signers[i] != deployer && signers[i] != guardian, "Safe owner");
            for (uint256 j = i + 1; j < 3; j++) {
                require(signers[i] != signers[j], "duplicate Safe owner");
            }
        }
    }

    /// After setup the Safe holds every role, the deployer none, and changes wait 2 days.
    function _checkHandover(TimelockController t, address deployer, address owner) private view {
        bytes32[3] memory r = [t.PROPOSER_ROLE(), t.CANCELLER_ROLE(), t.EXECUTOR_ROLE()];
        for (uint256 i; i < 3; i++) {
            require(t.hasRole(r[i], owner) && !t.hasRole(r[i], deployer), "role handover");
        }
        require(!t.hasRole(t.DEFAULT_ADMIN_ROLE(), deployer) && t.getMinDelay() == TIMELOCK_DELAY, "timelock");
    }

    function _createSafe(address[] memory signers) private returns (address safe) {
        bytes memory init = abi.encodeCall(
            ISafe.setup, (signers, SAFE_THRESHOLD, address(0), "", SAFE_FALLBACK, address(0), 0, payable(address(0)))
        );
        safe = ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_L2, init, block.timestamp);
        require(ISafe(safe).getThreshold() == SAFE_THRESHOLD && ISafe(safe).getOwners().length == 3, "Safe setup");
    }

    function setupCalls(TimelockController timelock, FillmarkFeeds feeds, address deployer, address owner)
        public
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        bytes[] memory f = feedCalls();
        bytes[] memory t = timelockCalls(timelock, deployer, owner);
        uint256 n = f.length + t.length;
        targets = new address[](n);
        values = new uint256[](n);
        payloads = new bytes[](n);
        for (uint256 i; i < n; i++) {
            (targets[i], payloads[i]) = i < f.length ? (address(feeds), f[i]) : (address(timelock), t[i - f.length]);
        }
    }

    /// Hand every timelock role to the owner and take them from the deployer, then set
    /// the delay. The timelock administers itself, so these run inside the setup batch.
    function timelockCalls(TimelockController timelock, address deployer, address owner)
        public
        view
        returns (bytes[] memory t)
    {
        bytes32[3] memory r = [timelock.PROPOSER_ROLE(), timelock.CANCELLER_ROLE(), timelock.EXECUTOR_ROLE()];
        t = new bytes[](7);
        for (uint256 i; i < 3; i++) {
            t[2 * i] = abi.encodeCall(timelock.grantRole, (r[i], owner));
            t[2 * i + 1] = abi.encodeCall(timelock.revokeRole, (r[i], deployer));
        }
        t[6] = abi.encodeCall(TimelockController.updateDelay, (TIMELOCK_DELAY));
    }

    /// Feeds setup: every asset, then the calendar from LEAD after now.
    function feedCalls() public view returns (bytes[] memory payloads) {
        uint64 first = uint64(block.timestamp) + LEAD;
        FillmarkFeeds.Period[] memory p = periods();
        FillmarkFeeds.Closure[] memory c = closures();

        // The period in force at `first` starts at `first`; later ones keep their start.
        uint256 cur = type(uint256).max;
        for (uint256 i; i < p.length; i++) {
            if (p[i].start <= first) cur = i;
        }
        require(cur != type(uint256).max, "calendar starts after deploy");
        p[cur].start = first;
        uint256 np = p.length - cur;

        // Closures that already ended are skipped; one in progress is cut to start at `first`.
        uint256 c0 = c.length;
        for (uint256 i; i < c.length; i++) {
            if (c[i].end > first) {
                c0 = i;
                break;
            }
        }
        if (c0 < c.length && c[c0].start < first) c[c0].start = first;
        uint256 nc = c.length - c0;

        (Stock[] memory s, Crypto[] memory x) = assets();
        payloads = new bytes[](s.length + x.length + np + nc);
        uint256 k;
        for (uint256 i; i < s.length; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint32 maxAge = uint32(s[i].maxAge); // checked in assets()
            payloads[k++] =
                abi.encodeCall(FillmarkFeeds.addStock, (s[i].token, s[i].feed, maxAge, s[i].multiplierInFeed));
        }
        for (uint256 i; i < x.length; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            payloads[k++] = abi.encodeCall(FillmarkFeeds.addCrypto, (x[i].token, x[i].feed, uint32(x[i].maxAge))); // checked in assets()
        }
        for (uint256 i = cur; i < p.length; i++) {
            payloads[k++] = abi.encodeCall(FillmarkFeeds.addPeriod, (p[i]));
        }
        for (uint256 i = c0; i < c.length; i++) {
            payloads[k++] = abi.encodeCall(FillmarkFeeds.addClosure, (c[i].start, c[i].end));
        }
    }

    /// Every token with a Chainlink USD feed on Robinhood Chain, a genuine contract and a
    /// Uniswap v3 USDG pool that can fill $100 both ways within 10% of NAV (see assets.json),
    /// checked against the token itself.
    function assets() public view returns (Stock[] memory s, Crypto[] memory x) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/assets.json"));
        s = abi.decode(vm.parseJson(json, ".stocks"), (Stock[]));
        x = abi.decode(vm.parseJson(json, ".crypto"), (Crypto[]));
        for (uint256 i; i < s.length; i++) {
            _check(s[i].token, s[i].decimals, s[i].ticker, s[i].maxAge);
        }
        for (uint256 i; i < x.length; i++) {
            _check(x[i].token, x[i].decimals, x[i].ticker, x[i].maxAge);
        }
    }

    /// The CLI and agent take decimals and tickers from assets.json, so they must match the token.
    function _check(address token, uint256 decimals, string memory ticker, uint256 maxAge) private view {
        require(IERC20Metadata(token).decimals() == decimals, string.concat("decimals: ", ticker));
        require(
            keccak256(bytes(IERC20Metadata(token).symbol())) == keccak256(bytes(ticker)),
            string.concat("ticker: ", ticker)
        );
        require(maxAge <= type(uint32).max, string.concat("maxAge: ", ticker));
    }

    /// US daylight saving changes (America/New_York tzdata). Regular session and the
    /// Robinhood 24/5 week (Sunday 20:00 ET to Friday 20:00 ET) in UTC seconds.
    function periods() public pure returns (FillmarkFeeds.Period[] memory p) {
        p = new FillmarkFeeds.Period[](5);
        p[0] = _est(1793512800); // 2026-11-01 06:00 UTC
        p[1] = _edt(1805007600); // 2027-03-14 07:00 UTC
        p[2] = _est(1825567200); // 2027-11-07 06:00 UTC
        p[3] = _edt(1836457200); // 2028-03-12 07:00 UTC
        p[4] = _est(1857016800); // 2028-11-05 06:00 UTC
    }

    /// NYSE holidays and early closings 2026-2028 (NYSE Group calendar). A holiday closes
    /// the whole 24/5 trading day, from 20:00 ET the evening before to 20:00 ET; an early
    /// close (13:00 ET) closes the rest of that trading day.
    function closures() public pure returns (FillmarkFeeds.Closure[] memory c) {
        c = new FillmarkFeeds.Closure[](26);
        c[0] = FillmarkFeeds.Closure(1795654800, 1795741200); // 2026-11-26 holiday: Thu 2026-11-26 01:00 to Fri 2026-11-27 01:00 UTC
        c[1] = FillmarkFeeds.Closure(1795802400, 1795827600); // 2026-11-27 early close: Fri 2026-11-27 18:00 to Sat 2026-11-28 01:00 UTC
        c[2] = FillmarkFeeds.Closure(1798135200, 1798160400); // 2026-12-24 early close: Thu 2026-12-24 18:00 to Fri 2026-12-25 01:00 UTC
        c[3] = FillmarkFeeds.Closure(1798160400, 1798246800); // 2026-12-25 holiday: Fri 2026-12-25 01:00 to Sat 2026-12-26 01:00 UTC
        c[4] = FillmarkFeeds.Closure(1798765200, 1798851600); // 2027-01-01 holiday: Fri 2027-01-01 01:00 to Sat 2027-01-02 01:00 UTC
        c[5] = FillmarkFeeds.Closure(1800234000, 1800320400); // 2027-01-18 holiday: Mon 2027-01-18 01:00 to Tue 2027-01-19 01:00 UTC
        c[6] = FillmarkFeeds.Closure(1802653200, 1802739600); // 2027-02-15 holiday: Mon 2027-02-15 01:00 to Tue 2027-02-16 01:00 UTC
        c[7] = FillmarkFeeds.Closure(1806019200, 1806105600); // 2027-03-26 holiday: Fri 2027-03-26 00:00 to Sat 2027-03-27 00:00 UTC
        c[8] = FillmarkFeeds.Closure(1811721600, 1811808000); // 2027-05-31 holiday: Mon 2027-05-31 00:00 to Tue 2027-06-01 00:00 UTC
        c[9] = FillmarkFeeds.Closure(1813276800, 1813363200); // 2027-06-18 holiday: Fri 2027-06-18 00:00 to Sat 2027-06-19 00:00 UTC
        c[10] = FillmarkFeeds.Closure(1814745600, 1814832000); // 2027-07-05 holiday: Mon 2027-07-05 00:00 to Tue 2027-07-06 00:00 UTC
        c[11] = FillmarkFeeds.Closure(1820188800, 1820275200); // 2027-09-06 holiday: Mon 2027-09-06 00:00 to Tue 2027-09-07 00:00 UTC
        c[12] = FillmarkFeeds.Closure(1827104400, 1827190800); // 2027-11-25 holiday: Thu 2027-11-25 01:00 to Fri 2027-11-26 01:00 UTC
        c[13] = FillmarkFeeds.Closure(1827252000, 1827277200); // 2027-11-26 early close: Fri 2027-11-26 18:00 to Sat 2027-11-27 01:00 UTC
        c[14] = FillmarkFeeds.Closure(1829610000, 1829696400); // 2027-12-24 holiday: Fri 2027-12-24 01:00 to Sat 2027-12-25 01:00 UTC
        c[15] = FillmarkFeeds.Closure(1831683600, 1831770000); // 2028-01-17 holiday: Mon 2028-01-17 01:00 to Tue 2028-01-18 01:00 UTC
        c[16] = FillmarkFeeds.Closure(1834707600, 1834794000); // 2028-02-21 holiday: Mon 2028-02-21 01:00 to Tue 2028-02-22 01:00 UTC
        c[17] = FillmarkFeeds.Closure(1839283200, 1839369600); // 2028-04-14 holiday: Fri 2028-04-14 00:00 to Sat 2028-04-15 00:00 UTC
        c[18] = FillmarkFeeds.Closure(1843171200, 1843257600); // 2028-05-29 holiday: Mon 2028-05-29 00:00 to Tue 2028-05-30 00:00 UTC
        c[19] = FillmarkFeeds.Closure(1844985600, 1845072000); // 2028-06-19 holiday: Mon 2028-06-19 00:00 to Tue 2028-06-20 00:00 UTC
        c[20] = FillmarkFeeds.Closure(1846256400, 1846281600); // 2028-07-03 early close: Mon 2028-07-03 17:00 to Tue 2028-07-04 00:00 UTC
        c[21] = FillmarkFeeds.Closure(1846281600, 1846368000); // 2028-07-04 holiday: Tue 2028-07-04 00:00 to Wed 2028-07-05 00:00 UTC
        c[22] = FillmarkFeeds.Closure(1851638400, 1851724800); // 2028-09-04 holiday: Mon 2028-09-04 00:00 to Tue 2028-09-05 00:00 UTC
        c[23] = FillmarkFeeds.Closure(1858554000, 1858640400); // 2028-11-23 holiday: Thu 2028-11-23 01:00 to Fri 2028-11-24 01:00 UTC
        c[24] = FillmarkFeeds.Closure(1858701600, 1858726800); // 2028-11-24 early close: Fri 2028-11-24 18:00 to Sat 2028-11-25 01:00 UTC
        c[25] = FillmarkFeeds.Closure(1861318800, 1861405200); // 2028-12-25 holiday: Mon 2028-12-25 01:00 to Tue 2028-12-26 01:00 UTC
    }

    function _est(uint64 start) private pure returns (FillmarkFeeds.Period memory) {
        return FillmarkFeeds.Period(start, 52200, 75600, 90000, 522000); // 14:30-21:00, Mon 01:00-Sat 01:00
    }

    function _edt(uint64 start) private pure returns (FillmarkFeeds.Period memory) {
        return FillmarkFeeds.Period(start, 48600, 72000, 86400, 518400); // 13:30-20:00, Mon 00:00-Sat 00:00
    }
}
