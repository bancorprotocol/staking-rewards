// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../ILiquidityProtection.sol";

contract TestLiquidityProtection is ILiquidityProtection {
    using SafeERC20 for IERC20;

    address private _owner;
    IERC20 private _poolToken;
    IERC20 private _reserveToken;
    uint256 private _amount;

    function store() external view override returns (ILiquidityProtectionTotalAmountsStore) {
        return ILiquidityProtectionTotalAmountsStore(0x0);
    }

    function addLiquidityFor(
        address owner,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 amount
    ) external payable override returns (uint256) {
        _owner = owner;
        _poolToken = poolToken;
        _reserveToken = reserveToken;
        _amount = amount;

        reserveToken.safeTransferFrom(msg.sender, address(this), amount);

        return 12345678;
    }

    function owner() external view returns (address) {
        return _owner;
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
