// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/access/Ownable.sol";

import "../Utils.sol";
import "../IContractRegistry.sol";

contract TestContractRegistry is IContractRegistry, Ownable, Utils {
    struct RegistryItem {
        address contractAddress;
        uint256 nameIndex;
    }

    mapping(bytes32 => RegistryItem) private _items;
    string[] public _contractNames;

    event AddressUpdate(bytes32 indexed contractName, address contractAddress);

    function addressOf(bytes32 contractName) public view override returns (address) {
        return _items[contractName].contractAddress;
    }

    function registerAddress(bytes32 contractName, address contractAddress)
        public
        onlyOwner
        validAddress(contractAddress)
    {
        // validate input
        require(contractName.length > 0, "ERR_INVALID_NAME");

        // check if any change is needed
        address currentAddress = _items[contractName].contractAddress;
        if (contractAddress == currentAddress) return;

        if (currentAddress == address(0)) {
            // update the item's index in the list
            _items[contractName].nameIndex = _contractNames.length;

            // add the contract name to the name list
            _contractNames.push(bytes32ToString(contractName));
        }

        // update the address in the registry
        _items[contractName].contractAddress = contractAddress;

        // dispatch the address update event
        emit AddressUpdate(contractName, contractAddress);
    }

    function unregisterAddress(bytes32 contractName) public onlyOwner {
        // validate input
        require(contractName.length > 0, "ERR_INVALID_NAME");
        require(_items[contractName].contractAddress != address(0), "ERR_INVALID_NAME");

        // remove the address from the registry
        _items[contractName].contractAddress = address(0);

        // if there are multiple items in the registry, move the last element to the deleted element's position
        // and modify last element's registryItem.nameIndex in the items collection to point to the right position in contractNames
        if (_contractNames.length > 1) {
            string memory lastContractNameString = _contractNames[_contractNames.length - 1];
            uint256 unregisterIndex = _items[contractName].nameIndex;

            _contractNames[unregisterIndex] = lastContractNameString;
            bytes32 lastContractName = stringToBytes32(lastContractNameString);
            RegistryItem storage registryItem = _items[lastContractName];
            registryItem.nameIndex = unregisterIndex;
        }

        // remove the last element from the name list
        _contractNames.pop();

        // zero the deleted element's index
        _items[contractName].nameIndex = 0;

        // dispatch the address update event
        emit AddressUpdate(contractName, address(0));
    }

    function bytes32ToString(bytes32 data) private pure returns (string memory) {
        bytes memory byteArray = new bytes(32);
        for (uint256 i = 0; i < 32; i++) {
            byteArray[i] = data[i];
        }

        return string(byteArray);
    }

    function stringToBytes32(string memory str) private pure returns (bytes32) {
        bytes32 result;
        assembly {
            result := mload(add(str, 32))
        }
        return result;
    }
}
