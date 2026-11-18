// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ForkBase} from "./ForkBase.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {FillmarkFeeds} from "../src/FillmarkFeeds.sol";
import {IAggregatorV3, IUniswapV3Factory} from "../src/interfaces/External.sol";

/// The Safe v1.4.1 calls the tests use (the real Safe on Robinhood Chain).
interface ISafeExec {
    function nonce() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
}

/// Runs the real deploy script on a mainnet fork and checks the result. The deploy time
/// is pinned, so the calendar checks hold whenever the fork is taken.
contract DeployForkTest is ForkBase {
    uint256 constant DEPLOY_AT = 1794850000; // Mon 2026-11-16 17:26:40 UTC
    bytes32 constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50; // ERC-1967
    address deployer;
    address guardian;
    address[3] signers;
    uint256[3] signerKeys;
    address owner; // the Safe
    Deploy.Deployment d;

    function setUp() public {
        _fork();
        (deployer,) = _key("deploy-deployer");
        (guardian,) = _key("deploy-guardian");
        for (uint256 i; i < 3; i++) {
            (signers[i], signerKeys[i]) = _key(string.concat("deploy-safe-", vm.toString(i)));
        }
        d = _deployAt(DEPLOY_AT);
        owner = d.owner;
    }

    function _deployAt(uint256 t) internal returns (Deploy.Deployment memory) {
        vm.warp(t);
        vm.setEnv("FILLMARK_DEPLOYER", vm.toString(deployer));
        vm.setEnv("FILLMARK_GUARDIAN", vm.toString(guardian));
        vm.setEnv(
            "FILLMARK_SAFE_OWNERS",
            string.concat(vm.toString(signers[0]), ",", vm.toString(signers[1]), ",", vm.toString(signers[2]))
        );
        return new Deploy().run();
    }

    function test_Roles() public view {
        TimelockController t = d.timelock;
        assertEq(t.getMinDelay(), 2 days);
        bytes32[4] memory roles = [t.PROPOSER_ROLE(), t.CANCELLER_ROLE(), t.EXECUTOR_ROLE(), t.DEFAULT_ADMIN_ROLE()];
        for (uint256 i; i < 3; i++) {
            assertTrue(t.hasRole(roles[i], owner));
        }
        for (uint256 i; i < 4; i++) {
            assertFalse(t.hasRole(roles[i], deployer)); // the deployer keeps nothing
            assertFalse(t.hasRole(roles[i], guardian));
        }
        assertTrue(t.hasRole(t.DEFAULT_ADMIN_ROLE(), address(t)));
        assertFalse(t.hasRole(t.DEFAULT_ADMIN_ROLE(), owner));
        // The owner is a real Safe 2-of-3 of the three signers.
        address[] memory o = ISafeExec(owner).getOwners();
        assertEq(o.length, 3);
        for (uint256 i; i < 3; i++) {
            assertEq(o[i], signers[i]);
        }
        assertEq(ISafeExec(owner).getThreshold(), 2);
        assertEq(d.feeds.admin(), address(t));
        assertEq(d.feeds.guardian(), guardian);
        assertEq(address(d.router.feeds()), address(d.feeds));
        assertEq(address(d.router.identity()), IDENTITY);
        assertEq(address(d.router.reputation()), REPUTATION);
        assertEq(address(d.router.factory()), FACTORY);
        assertEq(d.router.usdg(), USDG);
    }

    /// Every asset in assets.json is registered as listed. Stock tokens are Robinhood's
    /// (behind its beacon), crypto tokens are not stock tokens, and each has a USDG pool.
    function test_Assets() public {
        (Deploy.Stock[] memory s, Deploy.Crypto[] memory x) = new Deploy().assets();
        assertEq(s.length, 28);
        assertEq(x.length, 2);
        for (uint256 i; i < s.length; i++) {
            _checkAsset(s[i].token, s[i].feed, s[i].ticker, s[i].decimals);
            assertFalse(d.feeds.isCrypto(s[i].token), s[i].ticker);
            FillmarkFeeds.Source memory src = d.feeds.sourceOf(s[i].token, block.timestamp);
            assertEq(src.maxAge, s[i].maxAge, s[i].ticker);
            assertEq(src.multiplierInFeed, s[i].multiplierInFeed, s[i].ticker);
            // Only GLD's feed prices the underlying alone; only SGOV's feed updates just on its heartbeat.
            assertEq(src.multiplierInFeed, keccak256(bytes(s[i].ticker)) != keccak256("GLD"), s[i].ticker);
            assertEq(src.maxAge, keccak256(bytes(s[i].ticker)) == keccak256("SGOV") ? 25 hours : 6 hours, s[i].ticker);
            assertEq(address(uint160(uint256(vm.load(s[i].token, BEACON_SLOT)))), STOCK_BEACON, s[i].ticker);
        }
        for (uint256 i; i < x.length; i++) {
            _checkAsset(x[i].token, x[i].feed, x[i].ticker, x[i].decimals);
            FillmarkFeeds.Source memory src = d.feeds.sourceOf(x[i].token, block.timestamp);
            assertTrue(src.crypto, x[i].ticker);
            assertEq(src.maxAge, x[i].maxAge);
            assertEq(src.maxAge, 25 hours); // both feeds have a 24h heartbeat
        }
        assertEq(d.feeds.feedOf(TSLA), TSLA_FEED);
        assertEq(d.feeds.feedOf(NVDA), NVDA_FEED);
        assertEq(d.feeds.feedOf(WETH), ETH_FEED);
        assertEq(d.feeds.feedOf(CBBTC), CBBTC_FEED);
        assertEq(d.feeds.decimalsOf(CBBTC), 8);
    }

    function _checkAsset(address token, address feed, string memory ticker, uint256 decimals) internal view {
        assertEq(d.feeds.feedOf(token), feed, ticker);
        assertEq(d.feeds.tickerOf(token), ticker);
        assertEq(d.feeds.decimalsOf(token), decimals, ticker);
        assertEq(IAggregatorV3(feed).decimals(), 8, ticker);
        bool pool;
        uint24[4] memory fees = [uint24(100), 500, 3000, 10000];
        for (uint256 j; j < 4; j++) {
            if (IUniswapV3Factory(FACTORY).getPool(token, USDG, fees[j]) != address(0)) pool = true;
        }
        assertTrue(pool, ticker);
    }

    /// Run in Nov 2026: the EST period starts LEAD after deploy, four DST changes follow,
    /// and all 26 closures are still ahead.
    function test_CalendarLoaded() public view {
        assertEq(d.feeds.periodCount(), 5);
        assertEq(d.feeds.period(0).start, block.timestamp + 30 minutes);
        assertEq(d.feeds.period(1).start, 1805007600);
        assertEq(d.feeds.period(4).start, 1857016800);
        assertEq(d.feeds.closureCount(), 26);
        assertEq(uint8(d.feeds.sessionAt(block.timestamp)), uint8(FillmarkFeeds.Session.Closed));
    }

    function test_Sessions() public view {
        _at(1795654799, FillmarkFeeds.Session.Extended); // Wed 2026-11-25 19:59:59 ET
        _at(1795654800, FillmarkFeeds.Session.Closed); // Thanksgiving starts 20:00 ET the evening before
        _at(1795705200, FillmarkFeeds.Session.Closed); // Thu 2026-11-26 15:00 UTC
        _at(1795791600, FillmarkFeeds.Session.Regular); // Fri 2026-11-27 15:00 UTC, half day
        _at(1795802399, FillmarkFeeds.Session.Regular); // 12:59:59 ET
        _at(1795802400, FillmarkFeeds.Session.Closed); // 13:00 ET early close
        _at(1796048999, FillmarkFeeds.Session.Extended); // Mon 2026-11-30 09:29:59 ET
        _at(1796049000, FillmarkFeeds.Session.Regular); // 09:30 ET
        _at(1804858200, FillmarkFeeds.Session.Extended); // Fri 2027-03-12 13:30 UTC = 08:30 EST
        _at(1805068799, FillmarkFeeds.Session.Closed); // Sun 2027-03-14 19:59:59 EDT
        _at(1805068800, FillmarkFeeds.Session.Extended); // Sun 20:00 EDT, week opens
        _at(1805117400, FillmarkFeeds.Session.Regular); // Mon 2027-03-15 13:30 UTC = 09:30 EDT
        _at(1806069600, FillmarkFeeds.Session.Closed); // Good Friday 2027
        _at(1825680600, FillmarkFeeds.Session.Extended); // Mon 2027-11-08 13:30 UTC = 08:30 EST
        _at(1825684200, FillmarkFeeds.Session.Regular); // 09:30 EST
        _at(1829660400, FillmarkFeeds.Session.Closed); // Christmas observed, Fri 2027-12-24
        _at(1846256399, FillmarkFeeds.Session.Regular); // Mon 2028-07-03 12:59:59 EDT
        _at(1846256400, FillmarkFeeds.Session.Closed); // early close, then July 4
        _at(1846416600, FillmarkFeeds.Session.Regular); // Wed 2028-07-05 09:30 EDT
    }

    /// After setup every change takes two Safe signatures and waits 2 days in the timelock.
    function test_SafeChangesThroughTimelock() public {
        uint64 start = uint64(vm.getBlockTimestamp() + 3 days);
        bytes memory call = abi.encodeCall(FillmarkFeeds.addClosure, (start, start + 1 hours));
        bytes memory schedule =
            abi.encodeCall(TimelockController.schedule, (address(d.feeds), 0, call, bytes32(0), bytes32(0), 2 days));
        bytes memory execute =
            abi.encodeCall(TimelockController.execute, (address(d.feeds), 0, call, bytes32(0), bytes32(0)));

        // Nobody else can act: not the deployer, not one signer alone, not the Safe without delay.
        bytes32 proposer = d.timelock.PROPOSER_ROLE();
        vm.prank(deployer);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, deployer, proposer)
        );
        d.timelock.schedule(address(d.feeds), 0, call, bytes32(0), bytes32(0), 2 days);
        vm.prank(owner);
        vm.expectRevert(FillmarkFeeds.NotAdmin.selector);
        d.feeds.addClosure(start, start + 1 hours);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockInsufficientDelay.selector, 0, 2 days));
        d.timelock.schedule(address(d.feeds), 0, call, bytes32(0), bytes32(0), 0);
        bytes memory one = _sigs(schedule, 1);
        vm.expectRevert(bytes("GS020")); // fewer signatures than the threshold
        ISafeExec(owner)
            .execTransaction(address(d.timelock), 0, schedule, 0, 0, 0, 0, address(0), payable(address(0)), one);

        _safeExec(schedule, 2);
        // Not ready before the delay, neither for a direct call nor signed through the Safe.
        bytes32 id = d.timelock.hashOperation(address(d.feeds), 0, call, bytes32(0), bytes32(0));
        bytes32 ready = bytes32(1 << uint8(TimelockController.OperationState.Ready));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnexpectedOperationState.selector, id, ready));
        d.timelock.execute(address(d.feeds), 0, call, bytes32(0), bytes32(0));
        bytes memory two = _sigs(execute, 2);
        vm.expectRevert(bytes("GS013")); // the Safe call fails, so the Safe reverts
        ISafeExec(owner)
            .execTransaction(address(d.timelock), 0, execute, 0, 0, 0, 0, address(0), payable(address(0)), two);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        _safeExec(execute, 2);
        assertEq(d.feeds.closureCount(), 27);
    }

    /// The deploy refuses keys that would put the owner's power on the VPS.
    function test_RevertWhen_BadKeys() public {
        Deploy dep = new Deploy();
        address[] memory two = new address[](2);
        (two[0], two[1]) = (signers[0], signers[1]);
        vm.expectRevert(bytes("need 3 Safe owners"));
        dep.deploy(deployer, guardian, two);
        address[] memory three = new address[](3);
        (three[0], three[1], three[2]) = (signers[0], signers[1], signers[0]);
        vm.expectRevert(bytes("duplicate Safe owner"));
        dep.deploy(deployer, guardian, three);
        three[2] = deployer;
        vm.expectRevert(bytes("Safe owner"));
        dep.deploy(deployer, guardian, three);
        three[2] = guardian;
        vm.expectRevert(bytes("Safe owner"));
        dep.deploy(deployer, guardian, three);
        three[2] = signers[2];
        vm.expectRevert(bytes("deployer/guardian"));
        dep.deploy(deployer, deployer, three);
    }

    /// The Safe calls the timelock with `count` signatures from the first signers.
    function _safeExec(bytes memory data, uint256 count) internal {
        bytes memory sigs = _sigs(data, count);
        ISafeExec(owner)
            .execTransaction(address(d.timelock), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    /// Signatures of the first `count` signers over the Safe transaction, sorted by address.
    function _sigs(bytes memory data, uint256 count) internal view returns (bytes memory sigs) {
        ISafeExec safe = ISafeExec(owner);
        bytes32 h =
            safe.getTransactionHash(address(d.timelock), 0, data, 0, 0, 0, 0, address(0), address(0), safe.nonce());
        uint256[] memory idx = new uint256[](count);
        for (uint256 i; i < count; i++) {
            idx[i] = i;
        }
        for (uint256 i; i < count; i++) {
            for (uint256 j = i + 1; j < count; j++) {
                if (signers[idx[j]] < signers[idx[i]]) (idx[i], idx[j]) = (idx[j], idx[i]);
            }
        }
        for (uint256 i; i < count; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKeys[idx[i]], h);
            sigs = abi.encodePacked(sigs, r, s, v);
        }
    }

    /// Deployed during Thanksgiving 2026: the closure in progress starts at deploy + 30 min.
    function test_DeployInsideClosure() public {
        uint256 t = 1795705200; // Thu 2026-11-26 15:00 UTC
        Deploy.Deployment memory e = _deployAt(t);
        assertEq(e.feeds.closureCount(), 26);
        FillmarkFeeds.Closure memory c = e.feeds.closure(0);
        assertEq(c.start, t + 30 minutes);
        assertEq(c.end, 1795741200);
        assertEq(uint8(e.feeds.sessionAt(t + 30 minutes)), uint8(FillmarkFeeds.Session.Closed));
        assertEq(uint8(e.feeds.sessionAt(1795741200)), uint8(FillmarkFeeds.Session.Extended)); // Thu 20:00 ET
    }

    /// Deployed 20 min before the March 2027 DST change: the EDT period starts at deploy + 30 min.
    function test_DeployAcrossDst() public {
        uint256 t = 1805007600 - 20 minutes;
        Deploy.Deployment memory e = _deployAt(t);
        assertEq(e.feeds.periodCount(), 4);
        assertEq(e.feeds.period(0).start, t + 30 minutes);
        assertEq(e.feeds.period(0).weekOpen, 86400); // EDT values
        assertEq(e.feeds.closureCount(), 19);
        assertEq(uint8(e.feeds.sessionAt(1805068800)), uint8(FillmarkFeeds.Session.Extended)); // Sun 20:00 EDT
    }

    function _at(uint256 t, FillmarkFeeds.Session s) internal view {
        assertEq(uint8(d.feeds.sessionAt(t)), uint8(s), vm.toString(t));
    }
}
