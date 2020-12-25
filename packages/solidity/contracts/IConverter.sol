// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Conveter contract interface
 */
interface IConverter {
    function connectorTokenCount() external view returns (uint16);

    function connectorTokens(uint256 _index) external view returns (IERC20);
}
