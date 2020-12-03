// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "../ILiquidityProtection.sol";

contract TestLiquidityProtection is ILiquidityProtection {
    address private _recipient;
    IERC20 private _poolToken;
    IERC20 private _reserveToken;
    uint256 private _amount;

    function addLiquidityFor(
        address recipient,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 amount
    ) external payable override returns (uint256) {
        _recipient = recipient;
        _poolToken = poolToken;
        _reserveToken = reserveToken;
        _amount = amount;
    }

    function recipient() external view returns (address) {
        return _recipient;
    }

    function poolToken() external view returns (IERC20) {
        return _poolToken;
    }

    function reserveToken() external view returns (IERC20) {
        return _reserveToken;
    }

    function amount() external view returns (uint256) {
        return _amount;
    }
}
