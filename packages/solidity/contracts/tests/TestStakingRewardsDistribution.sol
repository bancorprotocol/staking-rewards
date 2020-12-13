// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "../StakingRewardsDistribution.sol";

import "./TestTime.sol";

contract TestStakingRewardsDistribution is StakingRewardsDistribution, TestTime {
    constructor(
        IStakingRewardsDistributionStore store,
        ITokenGovernance networkTokenGovernance,
        ICheckpointStore lastRemoveTimes,
        uint256 maxRewards,
        IContractRegistry registry
    ) public StakingRewardsDistribution(store, networkTokenGovernance, lastRemoveTimes, maxRewards, registry) {}

    function time() internal view override(Time, TestTime) returns (uint256) {
        return TestTime.time();
    }
}
