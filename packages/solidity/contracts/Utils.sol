// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

/**
 * @dev Utilities & Common Modifiers
 */
contract Utils {
    // validates an address - currently only checks that it isn't null
    modifier validAddress(address _address) {
        _validAddress(_address);
        _;
    }

    // error message binary size optimization
    function _validAddress(address _address) internal pure {
        require(_address != address(0), "ERR_INVALID_ADDRESS");
    }
}
