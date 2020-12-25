// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../IOwned.sol";
import "./TestConverter.sol";
import "./TestERC20Token.sol";

contract TestPoolToken is ERC20, IOwned {
    address private _owner;

    constructor(string memory name, string memory symbol) public ERC20(name, symbol) {}

    function owner() external view override returns (address) {
        return _owner;
    }

    function setOwner(address newOwner) external {
        _owner = newOwner;
    }
}
