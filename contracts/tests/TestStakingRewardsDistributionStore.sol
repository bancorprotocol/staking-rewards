// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "../StakingRewardsDistributionStore.sol";

import "./TestTime.sol";

contract TestStakingRewardsDistributionStore is StakingRewardsDistributionStore, TestTime {
    function time() internal view override(Time, TestTime) returns (uint256) {
        return TestTime.time();
    }
}
