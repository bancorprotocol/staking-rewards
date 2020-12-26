// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "../StakingRewards.sol";

import "./TestTime.sol";

contract TestStakingRewards is StakingRewards, TestTime {
    constructor(
        IStakingRewardsStore store,
        ITokenGovernance networkTokenGovernance,
        ICheckpointStore lastRemoveTimes,
        IContractRegistry registry
    ) public StakingRewards(store, networkTokenGovernance, lastRemoveTimes, registry) {}

    function time() internal view override(Time, TestTime) returns (uint256) {
        return TestTime.time();
    }

    function poolRewards(IERC20 poolToken, IERC20 reserveToken)
        external
        view
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        Rewards memory data = _rewards[poolToken][reserveToken];

        return (data.lastUpdateTime, data.rewardPerToken, data.totalReserveAmount);
    }

    function providerRewards(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    )
        external
        view
        returns (
            uint256,
            uint256,
            uint256,
            uint256
        )
    {
        ProviderRewards memory data = _providerRewards[provider][poolToken][reserveToken];

        return (data.rewardPerToken, data.pendingBaseRewards, data.reserveAmount, data.effectiveStakingTime);
    }

    function rewardPerToken(IERC20 poolToken, IERC20 reserveToken) external view returns (uint256) {
        Rewards memory rewardsData = _rewards[poolToken][reserveToken];
        PoolProgram memory program = poolProgram(poolToken);

        return rewardPerToken(program, reserveToken, rewardsData);
    }

    function providerPools(address provider) external view returns (IERC20[] memory) {
        EnumerableSet.AddressSet storage pools = _poolsByProvider[provider];

        uint256 length = pools.length();
        IERC20[] memory poolTokens = new IERC20[](length);
        for (uint256 i = 0; i < length; ++i) {
            poolTokens[i] = IERC20(pools.at(i));
        }

        return poolTokens;
    }
}
