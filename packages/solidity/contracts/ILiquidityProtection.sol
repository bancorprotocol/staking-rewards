// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./ILiquidityProtectionTotalAmountsStore.sol";

/**
 * @dev Liquidity protection minimal interface
 */
interface ILiquidityProtection {
    function store() external view returns (ILiquidityProtectionTotalAmountsStore);

    function addLiquidityFor(
        address owner,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 amount
    ) external payable returns (uint256);
}
