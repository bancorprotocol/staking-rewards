// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Liquidity protection events subscriber interface
 */
interface ILiquidityProtectionDataStore {
    function totalProtectedReserveAmount(IERC20 poolToken, IERC20 reserveToken) external view returns (uint256);

    function providerReserveAmount(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    ) external view returns (uint256);

    function providerPools(address provider) external view returns (IERC20[] memory);
}
