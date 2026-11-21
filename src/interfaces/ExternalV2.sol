// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// ERC-7579 view used to tell whether the client removed the router.
interface IERC7579Modules {
    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata additionalContext)
        external
        view
        returns (bool);
}

/// Pons V2 launch factory (Robinhood Chain), the parts the burner checks.
interface IPonsV2Factory {
    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase; // 0 NotGraduated, 1 Swept, 2 PoolCreated, 3 Rescued
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    function memeHook() external view returns (address);
    function locker() external view returns (address);
    function poolManager() external view returns (address);
    function positionManager() external view returns (address);
}

interface IPonsV2MemeHook {
    /// Only static fields, so it encodes exactly like the public mapping getter's tuple.
    struct LaunchInfo {
        bool registered;
        bool memecoinIsCurrency0;
        address memecoin;
        address quoteToken;
        address creator;
        address buybackCreatorRecipient;
        address protocolFeeRecipient;
        uint16 creatorTaxBps;
        uint16 protocolFeeShareBps;
        uint16 buybackBurnBps;
        uint16 hookFeeBps;
        uint16 maxInternalPriceImpactBps;
        bool buybackEnabled;
    }

    function launches(bytes32 poolId) external view returns (LaunchInfo memory);
}

interface IPonsV2Locker {
    function isLocked(address token) external view returns (bool);
    function lockedPositions(address token) external view returns (uint256);
}

/// Uniswap v4 PositionManager, the reads the burner needs.
interface IV4PositionManager {
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// Uniswap v4 PoolManager (v4-core v4.0.0), the calls the burner makes. PoolKey and
/// SwapParams match v4-core's layout; Currency is an address (address(0) = native).
interface IV4PoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified; // negative = exact input
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    /// Returns a BalanceDelta: amount0 in the upper 128 bits, amount1 in the lower 128.
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IV4UnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}
