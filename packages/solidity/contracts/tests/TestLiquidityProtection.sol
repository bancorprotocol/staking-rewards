// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../ILiquidityProtection.sol";
import "../StakingRewards.sol";
import "./TestLiquidityProtectionDataStore.sol";

contract TestLiquidityProtection is ILiquidityProtection {
    using SafeERC20 for IERC20;

    TestLiquidityProtectionDataStore private immutable _store;
    StakingRewards private immutable _stakingRewards;

    address private _provider;
    IERC20 private _poolToken;
    IERC20 private _reserveToken;
    uint256 private _reserveAmount;

    constructor(TestLiquidityProtectionDataStore store, StakingRewards stakingRewards) public {
        _store = store;
        _stakingRewards = stakingRewards;
    }

    function store() external view override returns (ILiquidityProtectionDataStore) {
        return _store;
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

        reserveToken.safeTransferFrom(msg.sender, address(this), reserveAmount);

        _stakingRewards.onLiquidityAdded(0, provider, poolToken, reserveToken, 0, reserveAmount);

        return 0;
    }

    function addLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount
    ) external payable returns (uint256) {
        _stakingRewards.onLiquidityAdded(0, provider, poolToken, reserveToken, 0, reserveAmount);

        _store.addLiquidity(provider, poolToken, reserveToken, reserveAmount);

        return 0;
    }

    function removeLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount
    ) external payable returns (uint256) {
        _stakingRewards.onLiquidityRemoved(0, provider, poolToken, reserveToken, 0, reserveAmount);

        _store.removeLiquidity(provider, poolToken, reserveToken, reserveAmount);

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
