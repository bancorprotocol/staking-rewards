// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@bancor/contracts/solidity/contracts/converter/interfaces/IConverterAnchor.sol";
import "@bancor/contracts/solidity/contracts/token/interfaces/IERC20Token.sol";

/**
 * @dev Liquidity protection events subscriber interface
 */
interface ILiquidityProtectionEventsSubscriber {
    function onLiquidityAdded(
        uint256 id,
        address provider,
        IConverterAnchor poolAnchor,
        IERC20Token reserveToken,
        uint256 poolAmount,
        uint256 reserveAmount
    ) external;

    function onLiquidityRemoved(
        uint256 id,
        address provider,
        IConverterAnchor poolAnchor,
        IERC20Token reserveToken,
        uint256 poolAmount,
        uint256 reserveAmount
    ) external;
}
