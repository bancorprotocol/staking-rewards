// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/math/SafeMath.sol";

import "../ILiquidityProtectionTotalAmountsStore.sol";

contract TestLiquidityProtectionTotalAmountsStore is ILiquidityProtectionTotalAmountsStore {
    using SafeMath for uint256;

    mapping(IERC20 => mapping(IERC20 => uint256)) private totalProtectedReserveAmounts;
    mapping(address => mapping(IERC20 => mapping(IERC20 => uint256))) private totalProtectedReserveAmountsByProvider;

    function totalProtectedReserveAmountByProvider(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    ) external view override returns (uint256) {
        return totalProtectedReserveAmountsByProvider[provider][poolToken][reserveToken];
    }

    function totalProtectedReserveAmount(IERC20 poolToken, IERC20 reserveToken)
        external
        view
        override
        returns (uint256)
    {
        return totalProtectedReserveAmounts[poolToken][reserveToken];
    }

    function addProviderLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount
    ) external {
        updateProviderLiquidity(
            provider,
            poolToken,
            reserveToken,
            totalProtectedReserveAmountsByProvider[provider][poolToken][reserveToken].add(reserveAmount)
        );
    }

    function removeProviderLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    ) external {
        updateProviderLiquidity(provider, poolToken, reserveToken, 0);
    }

    function updateProviderLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 newReserveAmount
    ) public {
        uint256 prevProviderAmount = totalProtectedReserveAmountsByProvider[provider][poolToken][reserveToken];
        uint256 prevPoolAmount = totalProtectedReserveAmounts[poolToken][reserveToken];

        totalProtectedReserveAmountsByProvider[provider][poolToken][reserveToken] = prevProviderAmount
            .add(newReserveAmount)
            .sub(prevProviderAmount);
        totalProtectedReserveAmounts[poolToken][reserveToken] = prevPoolAmount.add(newReserveAmount).sub(
            prevPoolAmount
        );
    }
}
