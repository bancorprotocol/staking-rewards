// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "../StakingRewardsDistribution.sol";

import "./TestTime.sol";

contract TestStakingRewardsDistribution is StakingRewardsDistribution, TestTime {
    constructor(
        IStakingRewardsDistributionStore store,
        ITokenGovernance networkTokenGovernance,
        ICheckpointStore lastRemoveTimes,
        ILiquidityProtection liquidityProtection,
        uint256 maxRewards,
        uint256 maxRewardsPerEpoch
    )
        public
        StakingRewardsDistribution(
            store,
            networkTokenGovernance,
            lastRemoveTimes,
            liquidityProtection,
            maxRewards,
            maxRewardsPerEpoch
        )
    {}

    function time() internal view override(Time, TestTime) returns (uint256) {
        return TestTime.time();
    }
}
