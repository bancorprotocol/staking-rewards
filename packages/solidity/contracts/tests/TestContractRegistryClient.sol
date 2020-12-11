// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "../ContractRegistryClient.sol";

contract TestContractRegistryClient is ContractRegistryClient {
    constructor(IContractRegistry _registry) public ContractRegistryClient(_registry) {}
}
