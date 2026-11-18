// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

// Minimal views of real mainnet contracts used by the tests.
interface IIdentity {
    function register(string memory agentURI) external returns (uint256);
    function approve(address to, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function getAgentWallet(uint256 agentId) external view returns (address);
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
}

interface IReputation {
    function getLastIndex(uint256 agentId, address client) external view returns (uint64);
    function readFeedback(uint256 agentId, address client, uint64 index)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);
    function getSummary(uint256 agentId, address[] calldata clients, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}

interface IStockAdmin {
    function pauseOracle() external;
    function updateMultiplier(uint256 newMultiplier) external;
    function uiMultiplier() external view returns (uint256);
}

/// Robinhood Chain mainnet (4663) addresses, all checked on chain or in official docs.
abstract contract ForkBase is Test {
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant ETH_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9; // Chainlink ETH / USD standard proxy
    uint32 constant ETH_MAX_AGE = 25 hours; // the feed's 24h heartbeat plus 1h
    /// WETH keeps its decimals in storage slot 56 (OpenZeppelin ERC20Upgradeable layout).
    bytes32 constant WETH_DECIMALS_SLOT = bytes32(uint256(56));
    // Coinbase cbBTC, 8 decimals, bridged by Chainlink CCIP (CCIP token directory).
    address constant CBBTC = 0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4;
    address constant CBBTC_FEED = 0x0009cD492adf8167f9eEBf1293556A673530a21a; // Chainlink CBBTC / USD
    uint32 constant CBBTC_MAX_AGE = 25 hours; // 24h heartbeat plus 1h
    // Robinhood GLD token. Its Chainlink feed ("GLD / USD") prices the underlying alone,
    // unlike the "Robinhood X / USD" feeds, which answer price x uiMultiplier.
    address constant GLD = 0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e;
    address constant GLD_FEED = 0x470A51258068043bd43dC0a56245625C9fE86eB0;
    /// Robinhood's beacon behind every Robinhood stock token; look-alike tokens do not use it.
    address constant STOCK_BEACON = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    address constant KERNEL_FACTORY = 0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419;
    address constant ECDSA_VALIDATOR = 0x845ADb2C711129d4f3966735eD98a9F09fC4cE57;
    address constant ENTRYPOINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant ORACLE_PAUSER = 0x7369d100c00F28E45D779ac9d4b1c7afa61e4aBC;
    address constant MULTIPLIER_UPDATER = 0x92905e8d0e2301BA143215B8D86D63fFD4188143;

    function _fork() internal {
        uint256 forkBlock = vm.envOr("FILLMARK_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(vm.envString("FILLMARK_RPC"));
        else vm.createSelectFork(vm.envString("FILLMARK_RPC"), forkBlock);
    }

    /// Labelled keys, not well-known ones: on mainnet, addresses of keys like 0xA11CE
    /// carry EIP-7702 sweeper code that steals anything sent to them.
    function _key(string memory label) internal returns (address a, uint256 k) {
        (a, k) = makeAddrAndKey(string.concat("fillmark-test-", label));
        assertEq(a.code.length, 0, "test key address has code on mainnet");
    }
}
