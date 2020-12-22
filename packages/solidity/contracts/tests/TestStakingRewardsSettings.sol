// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.6.12;

import "../StakingRewardsSettings.sol";
import "./TestTime.sol";

contract TestStakingRewardsSettings is StakingRewardsSettings, TestTime {
    constructor(IERC20 _networkToken) public StakingRewardsSettings(_networkToken) {}

    function time() internal view override(Time, TestTime) returns (uint256) {
        return TestTime.time();
    }
}
