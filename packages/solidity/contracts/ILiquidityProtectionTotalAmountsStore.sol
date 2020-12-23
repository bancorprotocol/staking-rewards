// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Liquidity protection store minimal interface
 */
interface ILiquidityProtectionTotalAmountsStore {
    function totalProtectedReserveAmountByProvider(
        address provider,
        IERC20 _poolToken,
        IERC20 _reserveToken
    ) external view returns (uint256);

    function totalProtectedReserveAmount(IERC20 _poolToken, IERC20 _reserveToken) external view returns (uint256);
}
