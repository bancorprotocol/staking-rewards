// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../ILiquidityProtection.sol";
import "./TestStakingRewards.sol";
import "./TestLiquidityProtectionTotalAmountsStore.sol";

contract TestLiquidityProtection is ILiquidityProtection {
    using SafeERC20 for IERC20;

    TestStakingRewards private _stakingRewards;
    TestLiquidityProtectionTotalAmountsStore private _store;

    address private _provider;
    IERC20 private _poolToken;
    IERC20 private _reserveToken;
    uint256 private _reserveAmount;

    constructor(TestStakingRewards stakingRewards) public {
        _stakingRewards = stakingRewards;
    }

    function store() external view override returns (ILiquidityProtectionTotalAmountsStore) {
        _store;
    }

    function addLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount
    ) external payable returns (uint256) {
        _store.addProviderLiquidity(provider, poolToken, reserveToken, reserveAmount);

        _stakingRewards.addLiquidity(provider, poolToken, reserveToken, 0, reserveAmount, 0);

        return 0;
    }

    function updateLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 newReserveAmount
    ) external payable returns (uint256) {
        _store.updateProviderLiquidity(provider, poolToken, reserveToken, newReserveAmount);
        _stakingRewards.updateLiquidity(provider, poolToken, reserveToken, 0, newReserveAmount, 0);

        return 0;
    }

    function removeLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    ) external payable returns (uint256) {
        _store.removeProviderLiquidity(provider, poolToken, reserveToken);
        _stakingRewards.removeLiquidity(provider, poolToken, reserveToken, 0, 0, 0);

        return 0;
    }

    function addLiquidityFor(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount
    ) external payable override returns (uint256) {
        _provider = provider;
        _poolToken = poolToken;
        _reserveToken = reserveToken;
        _reserveAmount = reserveAmount;

        _store.addProviderLiquidity(provider, poolToken, reserveToken, reserveAmount);

        reserveToken.safeTransferFrom(msg.sender, address(this), reserveAmount);

        return 0;
    }

    function provider() external view returns (address) {
        return _provider;
    }

    function poolToken() external view returns (IERC20) {
        return _poolToken;
    }

    function reserveToken() external view returns (IERC20) {
        return _reserveToken;
    }

    function reserveAmount() external view returns (uint256) {
        return _reserveAmount;
    }
}
