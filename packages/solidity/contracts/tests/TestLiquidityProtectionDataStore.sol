// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";

import "../ILiquidityProtectionDataStore.sol";

contract TestLiquidityProtectionDataStore is ILiquidityProtectionDataStore {
    using SafeMath for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;

    mapping(IERC20 => mapping(IERC20 => uint256)) private _totalAmounrs;
    mapping(address => mapping(IERC20 => mapping(IERC20 => uint256))) private _providerAmounts;
    mapping(address => EnumerableSet.AddressSet) internal _providerPools;

    function totalProtectedReserveAmount(IERC20 poolToken, IERC20 reserveToken)
        external
        view
        override
        returns (uint256)
    {
        return _totalAmounrs[poolToken][reserveToken];
    }

    function providerReserveAmount(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    ) external view override returns (uint256) {
        return _providerAmounts[provider][poolToken][reserveToken];
    }

    function providerPools(address provider) external view override returns (IERC20[] memory) {
        EnumerableSet.AddressSet storage pools = _providerPools[provider];

        uint256 length = pools.length();
        IERC20[] memory poolTokens = new IERC20[](length);
        for (uint256 i = 0; i < length; ++i) {
            poolTokens[i] = IERC20(pools.at(i));
        }

        return poolTokens;
    }

    function addLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount
    ) external {
        _totalAmounrs[poolToken][reserveToken] = _totalAmounrs[poolToken][reserveToken].add(reserveAmount);

        uint256 prevProviderAmount = _providerAmounts[provider][poolToken][reserveToken];
        if (prevProviderAmount == 0) {
            _providerPools[provider].add(address(poolToken));
        }

        // update provider's reserve amount
        _providerAmounts[provider][poolToken][reserveToken] = prevProviderAmount.add(reserveAmount);
    }

    function removeLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount
    ) external {
        _totalAmounrs[poolToken][reserveToken] = _totalAmounrs[poolToken][reserveToken].sub(reserveAmount);

        _providerAmounts[provider][poolToken][reserveToken] = _providerAmounts[provider][poolToken][reserveToken].sub(
            reserveAmount
        );
    }
}
