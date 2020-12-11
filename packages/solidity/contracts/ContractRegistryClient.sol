// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./Utils.sol";
import "./IContractRegistry.sol";

/**
 * @dev This is the base contract for ContractRegistry clients.
 */
contract ContractRegistryClient is Ownable, Utils {
    bytes32 internal constant CONTRACT_REGISTRY = "ContractRegistry";
    bytes32 internal constant LIQUIDITY_PROTECTION = "LiquidityProtection";

    // address of the current contract-registry
    IContractRegistry public _registry;

    // address of the previous contract-registry
    IContractRegistry public _prevRegistry;

    // only an owner can update the contract-registry
    bool public _onlyOwnerCanUpdateRegistry;

    /**
     * @dev verifies that the caller is mapped to the given contract name
     *
     * @param contractName contract name
     */
    modifier only(bytes32 contractName) {
        _only(contractName);
        _;
    }

    function _only(bytes32 contractName) internal view {
        require(msg.sender == addressOf(contractName), "ERR_ACCESS_DENIED");
    }

    /**
     * @dev initializes a new ContractRegistryClient instance
     *
     * @param registry address of a contract-registry contract
     */
    constructor(IContractRegistry registry) internal validAddress(address(registry)) {
        _registry = registry;
        _prevRegistry = registry;
    }

    /**
     * @dev updates to the new contract-registry
     */
    function updateRegistry() public {
        // verify that this function is permitted
        require(msg.sender == owner() || !_onlyOwnerCanUpdateRegistry, "ERR_ACCESS_DENIED");

        // get the new contract-registry
        IContractRegistry newRegistry = IContractRegistry(addressOf(CONTRACT_REGISTRY));

        // verify that the new contract-registry is different and not zero
        require(newRegistry != _registry && address(newRegistry) != address(0), "ERR_INVALID_REGISTRY");

        // verify that the new contract-registry is pointing to a non-zero contract-registry
        require(newRegistry.addressOf(CONTRACT_REGISTRY) != address(0), "ERR_INVALID_REGISTRY");

        // save a backup of the current contract-registry before replacing it
        _prevRegistry = _registry;

        // replace the current contract-registry with the new contract-registry
        _registry = newRegistry;
    }

    /**
     * @dev restores the previous contract-registry
     */
    function restoreRegistry() public onlyOwner {
        // restore the previous contract-registry
        _registry = _prevRegistry;
    }

    /**
     * @dev restricts the permission to update the contract-registry
     *
     * @param onlyOwnerCanUpdateRegistry indicates whether or not permission is restricted to owner only
     */
    function restrictRegistryUpdate(bool onlyOwnerCanUpdateRegistry) public onlyOwner {
        // change the permission to update the contract-registry
        _onlyOwnerCanUpdateRegistry = onlyOwnerCanUpdateRegistry;
    }

    /**
     * @dev returns the address associated with the given contract name
     *
     * @param contractName contract name
     *
     * @return contract address
     */
    function addressOf(bytes32 contractName) internal view returns (address) {
        return _registry.addressOf(contractName);
    }

    /** @dev returns the registry
     *
     * @return the address of the registry
     */
    function registry() external view returns (IContractRegistry) {
        return _registry;
    }

    /** @dev returns the previous registry
     *
     * @return the address of the previous registry
     */
    function prevRegistry() external view returns (IContractRegistry) {
        return _prevRegistry;
    }
}
