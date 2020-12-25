// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "../IConverter.sol";
import "./TestPoolToken.sol";

contract TestConverter is IConverter {
    TestPoolToken private _poolToken;
    IERC20[] private _reserveTokens;

    constructor(
        TestPoolToken poolToken,
        IERC20 reserveToken1,
        IERC20 reserveToken2
    ) public {
        _poolToken = poolToken;
        _reserveTokens.push(reserveToken1);
        _reserveTokens.push(reserveToken2);
    }

    function connectorTokenCount() external view override returns (uint16) {
        return uint16(_reserveTokens.length);
    }

    function connectorTokens(uint256 _index) external view override returns (IERC20) {
        return _reserveTokens[_index];
    }
}
