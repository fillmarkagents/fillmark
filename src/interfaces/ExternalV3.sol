// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// The Uniswap v3 pool calls router v3 makes besides slot0 and swap.
interface IUniswapV3PoolState {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}
