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

    function baseRewards(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    ) external view returns (uint256) {
        Rewards memory rewardsData = rewards(poolToken, reserveToken);
        ProviderRewards memory providerRewards = providerRewards(provider, poolToken, reserveToken);
        PoolProgram memory program = poolProgram(poolToken);
        return baseRewards(rewardsData, reserveToken, providerRewards, program);
    }
}
