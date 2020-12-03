// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Checkpoint store contract interface
 */
interface ILiquidityProtection {
    function addLiquidityFor(
        address recipient,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 amount
    ) external payable returns (uint256);
}
