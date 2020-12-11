// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

/*
    Contract Registry interface
*/
interface IContractRegistry {
    function addressOf(bytes32 contractName) external view returns (address);
}
