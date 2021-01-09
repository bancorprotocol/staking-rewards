// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../ILiquidityProtection.sol";
import "./TestStakingRewards.sol";
import "./TestLiquidityProtectionDataStore.sol";
import "./TestCheckpointStore.sol";

contract TestLiquidityProtection is ILiquidityProtection {
    using SafeERC20 for IERC20;

    TestLiquidityProtectionDataStore private immutable _store;
    TestStakingRewards private immutable _stakingRewards;
    TestCheckpointStore private immutable _checkpointStore;

    address private _provider;
    IERC20 private _poolToken;
    IERC20 private _reserveToken;
    uint256 private _reserveAmount;

    constructor(
        TestLiquidityProtectionDataStore store,
        TestStakingRewards stakingRewards,
        TestCheckpointStore checkpointStore
    ) public {
        _store = store;
        _stakingRewards = stakingRewards;
        _checkpointStore = checkpointStore;
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
    ) public payable returns (uint256) {
        _stakingRewards.onLiquidityAdded(0, provider, poolToken, reserveToken, 0, reserveAmount);

        _store.addLiquidity(provider, poolToken, reserveToken, reserveAmount);

        return 0;
    }

    function addLiquidityAt(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount,
        uint256 time
    ) public payable returns (uint256) {
        _stakingRewards.setTime(time);

        return addLiquidity(provider, poolToken, reserveToken, reserveAmount);
    }

    function removeLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount
    ) public payable returns (uint256) {
        _stakingRewards.onLiquidityRemoved(0, provider, poolToken, reserveToken, 0, reserveAmount);

        _store.removeLiquidity(provider, poolToken, reserveToken, reserveAmount);
        _checkpointStore.addCheckpoint(provider);

        return 0;
    }

    function removeLiquidityAt(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount,
        uint256 time
    ) public payable returns (uint256) {
        _stakingRewards.setTime(time);
        _checkpointStore.setTime(time);

        return removeLiquidity(provider, poolToken, reserveToken, reserveAmount);
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
