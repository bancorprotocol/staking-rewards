// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "@bancor/token-governance/contracts/tests/MintableToken.sol";

contract TestERC20Token is MintableToken {
    constructor(string memory name, string memory symbol) public MintableToken(name, symbol) {}
}
