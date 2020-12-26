// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "@bancor/token-governance/contracts/ITokenGovernance.sol";

import "./IStakingRewardsStore.sol";
import "./ICheckpointStore.sol";
import "./ILiquidityProtection.sol";
import "./ILiquidityProtectionEventsSubscriber.sol";
import "./Time.sol";
import "./Utils.sol";
import "./ContractRegistryClient.sol";

/**
 * @dev This contract manages the distribution of the staking rewards.
 */
contract StakingRewards is ILiquidityProtectionEventsSubscriber, AccessControl, Time, Utils, ContractRegistryClient {
    using SafeMath for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeERC20 for IERC20;

    // the role is used to globally govern the contract and its governing roles.
    bytes32 public constant ROLE_SUPERVISOR = keccak256("ROLE_SUPERVISOR");

    // the role is used to govern retroactive rewards distribution.
    bytes32 public constant ROLE_REWARDS_DISTRIBUTOR = keccak256("ROLE_REWARDS_DISTRIBUTOR");

    uint32 private constant PPM_RESOLUTION = 1000000;

    // the weekly 25% increase of the rewards multiplier (in units of PPM)
    uint32 private constant MULTIPLIER_INCREMENT = PPM_RESOLUTION / 4;

    // the share of the total rewards for staking the network token
    uint32 public constant NETWORK_TOKEN_REWARDS_SHARE = 700000; // 70%

    // the share of the total rewards for staking the base token
    uint32 public constant BASE_TOKEN_REWARDS_SHARE = 300000; // 30%

    // since we will be dividing by the total amount of protected tokens in units of wei, we can encounter cases
    // where the total amount in the denominator is higher than the product of the rewards rate and staking duration. In
    // order to avoid this imprecision, we will amplify the reward rate by the units amount.
    uint256 private constant REWARD_RATE_FACTOR = 1e18;

    // the staking rewards settings
    IStakingRewardsStore private immutable _store;

    // the permissioned wrapper around the network token which should allow this contract to mint staking rewards
    ITokenGovernance private immutable _networkTokenGovernance;

    // the address of the network token
    IERC20 private immutable _networkToken;

    // the checkpoint store recording last protected position removal times
    ICheckpointStore private immutable _lastRemoveTimes;

    /**
     * @dev triggered when pending rewards are being claimed
     *
     * @param provider the owner of the position
     * @param amount the total rewards amount
     */
    event RewardsClaimed(address indexed provider, uint256 amount);

    /**
     * @dev triggered when pending rewards are being added or updated
     *
     * @param provider the owner of the position
     * @param poolToken the pool token representing the new LM pool
     * @param amount the reward amount
     * @param newId the ID of the new position
     */
    event RewardsStaked(address indexed provider, IERC20 indexed poolToken, uint256 amount, uint256 indexed newId);

    /**
     * @dev initializes a new StakingRewardsDistribution contract
     *
     * @param store the staking rewards store
     * @param networkTokenGovernance the permissioned wrapper around the network token
     * @param lastRemoveTimes the checkpoint store recording last protected position removal times
     * @param registry address of a contract registry contract
     */
    constructor(
        IStakingRewardsStore store,
        ITokenGovernance networkTokenGovernance,
        ICheckpointStore lastRemoveTimes,
        IContractRegistry registry
    )
        public
        validAddress(address(store))
        validAddress(address(networkTokenGovernance))
        validAddress(address(lastRemoveTimes))
        ContractRegistryClient(registry)
    {
        _store = store;
        _networkTokenGovernance = networkTokenGovernance;
        _networkToken = networkTokenGovernance.token();
        _lastRemoveTimes = lastRemoveTimes;

        // Set up administrative roles.
        _setRoleAdmin(ROLE_SUPERVISOR, ROLE_SUPERVISOR);
        _setRoleAdmin(ROLE_REWARDS_DISTRIBUTOR, ROLE_SUPERVISOR);

        // Allow the deployer to initially govern the contract.
        _setupRole(ROLE_SUPERVISOR, _msgSender());
    }

    modifier onlyRewardsDistributor() {
        _onlyRewardsDistributor();
        _;
    }

    function _onlyRewardsDistributor() internal view {
        require(hasRole(ROLE_REWARDS_DISTRIBUTOR, msg.sender), "ERR_ACCESS_DENIED");
    }

    modifier poolWhitelisted(IERC20 poolToken) {
        _poolWhitelisted(poolToken);
        _;
    }

    function _poolWhitelisted(IERC20 poolToken) internal view {
        require(_store.isPoolParticipating(poolToken), "ERR_POOL_NOT_WHITELISTED");
    }

    function addLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256, /* poolAmount */
        uint256 reserveAmount,
        uint256 /* id */
    )
        external
        override
        only(LIQUIDITY_PROTECTION)
        poolWhitelisted(poolToken)
        validExternalAddress(provider)
        validExternalAddress(address(reserveToken))
    {
        _store.addProviderLiquidity(provider, poolToken, reserveToken, reserveAmount);

        updateRewards(provider, poolToken, reserveToken);
    }

    function removeLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256, /* removedPoolAmount */
        uint256 removedReserveAmount,
        uint256 /* id */
    )
        external
        override
        only(LIQUIDITY_PROTECTION)
        poolWhitelisted(poolToken)
        validExternalAddress(provider)
        validExternalAddress(address(reserveToken))
    {
        _store.removeProviderLiquidity(provider, poolToken, reserveToken, removedReserveAmount);

        updateRewards(provider, poolToken, reserveToken);
    }

    function rewards() external returns (uint256) {
        return rewards(msg.sender, false);
    }

    function rewardsOf(address provider) external returns (uint256) {
        return rewards(provider, false);
    }

    function rewards(address provider, bool claim) private returns (uint256) {
        if (claim) {
            require(provider == msg.sender, "ERR_ACCESS_DENIED");
        }

        return rewards(provider, _store.poolsByProvider(provider), claim);
    }

    function rewards(
        address provider,
        IERC20[] memory poolTokens,
        bool claim
    ) private returns (uint256 reward) {
        uint256 length = poolTokens.length;
        for (uint256 i = 0; i < length; ++i) {
            reward = reward.add(rewards(provider, poolTokens[i], claim));
        }
    }

    function rewards(
        address provider,
        IERC20 poolToken,
        bool claim
    ) private returns (uint256) {
        uint256 reward = 0;

        PoolProgram memory program = poolProgram(poolToken);

        uint256 length = program.reserveTokens.length;
        for (uint256 i = 0; i < length; ++i) {
            IERC20 reserveToken = program.reserveTokens[i];

            // update all provider's pending rewards, in order to take into account reward multipliers
            if (claim) {
                updateRewards(provider, poolToken, reserveToken);
            }

            // get the newly claimable base rewards
            ProviderRewards memory providerRewards = providerRewards(provider, poolToken, reserveToken);
            uint256 baseRewards = baseRewards(reserveToken, rewards(poolToken, reserveToken), providerRewards, program);

            // apply the rewards multiplier on all rewards
            reward = reward.add(
                providerRewards
                    .pendingBaseRewards
                    .add(baseRewards)
                    .mul(rewardsMultiplier(provider, providerRewards.effectiveStakingTime, program))
                    .div(PPM_RESOLUTION)
            );

            if (claim) {
                _store.updateProviderEffectiveStakingTime(provider, poolToken, reserveToken, time(), 0);
            }
        }

        return reward;
    }

    function claimRewards() external returns (uint256) {
        return claimRewards(msg.sender, _store.poolsByProvider(msg.sender));
    }

    function claimRewards(address provider, IERC20[] memory poolTokens) private returns (uint256) {
        uint256 amount = rewards(provider, poolTokens, true);
        require(amount > 0, "ERR_NO_REWARDS");

        // make sure to update the last claim time so that it'll be taken into effect when calculating the next rewards
        // multiplier
        _store.updateProviderLastClaimTime(provider);

        _networkTokenGovernance.mint(provider, amount);

        emit RewardsClaimed(provider, amount);

        return amount;
    }

    // function stakeRewards(IERC20 poolToken) external returns (uint256) {
    //     EnumerableSet.AddressSet storage providerPools = _poolsByProvider[msg.sender];

    //     uint256 length = providerPools.length();
    //     IERC20[] memory poolTokens = new IERC20[](length);
    //     for (uint256 i = 0; i < length; ++i) {
    //         poolTokens[i] = IERC20(providerPools.at(i));
    //     }

    //     return stakeRewards(msg.sender, poolTokens);
    // }

    // function stakeRewards(IERC20[] calldata poolTokens) external returns (uint256) {
    //     return stakeRewards(msg.sender, poolTokens);
    // }

    function rewardPerToken(
        IERC20 reserveToken,
        Rewards memory rewardsData,
        PoolProgram memory program
    ) internal view returns (uint256) {
        if (rewardsData.totalReserveAmount == 0) {
            return rewardsData.rewardPerToken;
        }

        uint256 currentTime = time();
        if (currentTime < program.startTime) {
            return 0;
        }

        uint256 stakingEndTime = Math.min(currentTime, program.endTime);
        uint256 stakingStartTime = Math.max(program.startTime, rewardsData.lastUpdateTime);

        return
            rewardsData.rewardPerToken.add(
                stakingEndTime
                    .sub(stakingStartTime)
                    .mul(program.rewardRate)
                    .mul(REWARD_RATE_FACTOR)
                    .mul(rewardShare(reserveToken))
                    .div(rewardsData.totalReserveAmount.mul(PPM_RESOLUTION))
            );
    }

    function baseRewards(
        IERC20 reserveToken,
        Rewards memory rewardsData,
        ProviderRewards memory providerRewards,
        PoolProgram memory program
    ) private view returns (uint256) {
        return
            providerRewards
                .reserveAmount
                .mul(rewardPerToken(reserveToken, rewardsData, program).sub(providerRewards.rewardPerToken))
                .div(REWARD_RATE_FACTOR);
    }

    function updateRewards(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    ) private {
        PoolProgram memory program = poolProgram(poolToken);
        Rewards memory rewardsData = rewards(poolToken, reserveToken);

        uint256 newRewardPerToken = rewardPerToken(reserveToken, rewardsData, program);
        _store.updateReward(poolToken, reserveToken, newRewardPerToken, Math.min(time(), program.endTime));

        ProviderRewards memory providerRewards = providerRewards(provider, poolToken, reserveToken);
        _store.updateProviderRewardPerToken(
            provider,
            poolToken,
            reserveToken,
            newRewardPerToken,
            baseRewards(reserveToken, rewardsData, providerRewards, program)
        );
    }

    function rewardShare(IERC20 reserveToken) private view returns (uint32) {
        if (reserveToken == _networkToken) {
            return NETWORK_TOKEN_REWARDS_SHARE;
        }

        return BASE_TOKEN_REWARDS_SHARE;
    }

    function rewardsMultiplier(
        address provider,
        uint256 stakingStartTime,
        PoolProgram memory program
    ) private view returns (uint32) {
        uint256 effectiveStakingEndTime = Math.min(time(), program.endTime);
        uint256 effectiveStakingStartTime =
            Math.max( // take the latest of actual staking start time and the latest multiplier reset
                Math.max(stakingStartTime, program.startTime), // don't count staking before the start of the program
                Math.max(_lastRemoveTimes.checkpoint(provider), _store.lastProviderClaimTime(provider)) // get the latest multiplier reset timestamp
            );

        // check that the staking range is valid. for example, it can be invalid when calculating the multiplier when
        // the staking has started berore the start of the program, in which case the effective staking start time will
        // be in the future, compared to the effective staking end time (which will be the time of the current block).
        if (effectiveStakingStartTime >= effectiveStakingEndTime) {
            return PPM_RESOLUTION;
        }

        uint256 effectiveStakingDuration = effectiveStakingEndTime.sub(effectiveStakingStartTime);

        // given x representing the staking duration (in seconds), the resulting multiplier (in PPM) is:
        // * for 0 <= x <= 1 weeks: 100% PPM
        // * for 1 <= x <= 2 weeks: 125% PPM
        // * for 2 <= x <= 3 weeks: 150% PPM
        // * for 3 <= x <= 4 weeks: 175% PPM
        // * for x > 4 weeks: 200% PPM
        return PPM_RESOLUTION + MULTIPLIER_INCREMENT * uint32(Math.min(effectiveStakingDuration.div(1 weeks), 4));
    }

    function poolProgram(IERC20 poolToken) internal view returns (PoolProgram memory) {
        PoolProgram memory program;
        (program.reserveTokens, program.startTime, program.endTime, program.rewardRate) = _store.poolProgram(poolToken);

        return program;
    }

    function rewards(IERC20 poolToken, IERC20 reserveToken) private view returns (Rewards memory) {
        Rewards memory data;
        (data.lastUpdateTime, data.rewardPerToken, data.totalReserveAmount) = _store.rewards(poolToken, reserveToken);

        return data;
    }

    function providerRewards(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    ) private view returns (ProviderRewards memory) {
        ProviderRewards memory data;
        (data.rewardPerToken, data.pendingBaseRewards, data.reserveAmount, data.effectiveStakingTime) = _store
            .providerRewards(provider, poolToken, reserveToken);

        return data;
    }

    function liquidityProtection() private view returns (ILiquidityProtection) {
        return ILiquidityProtection(addressOf(LIQUIDITY_PROTECTION));
    }
}
