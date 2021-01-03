// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "../StakingRewardsStore.sol";

import "./TestTime.sol";

contract TestStakingRewardsStore is StakingRewardsStore, TestTime {
    function time() internal view override(Time, TestTime) returns (uint256) {
        return TestTime.time();
    }
}
