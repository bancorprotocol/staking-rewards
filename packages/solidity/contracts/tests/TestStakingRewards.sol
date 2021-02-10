// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "../StakingRewards.sol";

import "./TestStakingRewardsStore.sol";

import "./TestTime.sol";

contract TestStakingRewards is StakingRewards, TestTime {
    constructor(
        TestStakingRewardsStore store,
        ITokenGovernance networkTokenGovernance,
        ICheckpointStore lastRemoveTimes,
        IContractRegistry registry
    ) public StakingRewards(store, networkTokenGovernance, lastRemoveTimes, registry) {}

    function time() internal view override(Time, TestTime) returns (uint256) {
        return TestTime.time();
    }

    function setStoreTime(uint256 currentTime) public {
        TestStakingRewardsStore(address(this.store())).setTime(currentTime);
    }

    function baseRewards(
        address provider,
        IDSToken poolToken,
        IERC20Token reserveToken
    ) external view returns (uint256) {
        PoolRewards memory poolRewardsData = poolRewards(poolToken, reserveToken);
        ProviderRewards memory providerRewards = providerRewards(provider, poolToken, reserveToken);
        PoolProgram memory program = poolProgram(poolToken);

        return
            baseRewards(
                provider,
                poolToken,
                reserveToken,
                poolRewardsData,
                providerRewards,
                program,
                liquidityProtectionStats()
            );
    }
}
