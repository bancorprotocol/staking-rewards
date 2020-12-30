// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Liquidity protection events subscriber interface
 */
interface ILiquidityProtectionEventsSubscriber {
    function onLiquidityAdded(
        uint256 id,
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 poolAmount,
        uint256 reserveAmount
    ) external;

    function onLiquidityRemoved(
        uint256 id,
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 removedPoolAmount,
        uint256 removedReserveAmount
    ) external;
}
