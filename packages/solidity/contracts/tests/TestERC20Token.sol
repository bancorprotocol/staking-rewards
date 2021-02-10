// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@bancor/token-governance/contracts/tests/MintableToken.sol";

contract TestERC20Token is MintableToken {
    constructor(string memory name, string memory symbol) public MintableToken(name, symbol) {}
}
