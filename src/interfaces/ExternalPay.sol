// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// The ERC-8004 identity registry calls Fillmark Pay makes (it is an ERC-721).
interface IIdentityPay {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
}
