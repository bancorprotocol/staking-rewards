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

    struct ProviderRewards {
        uint256 rewardPerToken;
        uint256 pendingBaseRewards;
        uint256 effectiveStakingTime;
    }

    struct Rewards {
        uint256 lastUpdateTime;
        uint256 rewardPerToken;
        mapping(address => ProviderRewards) providerRewards;
    }

    // the role is used to globally govern the contract and its governing roles.
    bytes32 public constant ROLE_SUPERVISOR = keccak256("ROLE_SUPERVISOR");

    // the role is used to govern retroactive rewards distribution.
    bytes32 public constant ROLE_REWARDS_DISTRIBUTOR = keccak256("ROLE_REWARDS_DISTRIBUTOR");

    // the roles is used to restrict who is allowed to publish liquidity protection event
    bytes32 public constant ROLE_PUBLISHER = keccak256("ROLE_PUBLISHER");

    uint32 public constant PPM_RESOLUTION = 1000000;

    // the weekly 25% increase of the rewards multiplier (in units of PPM)
    uint32 public constant MULTIPLIER_INCREMENT = PPM_RESOLUTION / 4;

    // the staking rewards settings
    IStakingRewardsStore private immutable _store;

    // the permissioned wrapper around the network token which should allow this contract to mint staking rewards
    ITokenGovernance private immutable _networkTokenGovernance;

    // the checkpoint store recording last protected position removal times
    ICheckpointStore private immutable _lastRemoveTimes;

    // the mapping between pools, reserve tokens, and their rewards
    mapping(IERC20 => mapping(IERC20 => Rewards)) private _rewards;

    // the mapping between pools and their (non-network) base reserve tokens
    mapping(IERC20 => IERC20[2]) private _reserveTokensByPools;

    // the mapping between providers and the pools they are participating in
    mapping(address => EnumerableSet.AddressSet) private _poolsByProvider;

    mapping(IERC20 => mapping(IERC20 => uint256)) private _totalProtectedReserveAmounts;
    mapping(address => mapping(IERC20 => mapping(IERC20 => uint256))) private _totalProtectedReserveAmountsByProvider;

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
        _lastRemoveTimes = lastRemoveTimes;

        // Set up administrative roles.
        _setRoleAdmin(ROLE_SUPERVISOR, ROLE_SUPERVISOR);
        _setRoleAdmin(ROLE_REWARDS_DISTRIBUTOR, ROLE_SUPERVISOR);

        // Allow the deployer to initially govern the contract.
        _setupRole(ROLE_SUPERVISOR, _msgSender());
    }

    modifier onlySupervisor() {
        _onlySupervisor();
        _;
    }

    function _onlySupervisor() internal view {
        require(hasRole(ROLE_SUPERVISOR, msg.sender), "ERR_ACCESS_DENIED");
    }

    modifier onlyRewardsDistributor() {
        _onlyRewardsDistributor();
        _;
    }

    function _onlyRewardsDistributor() internal view {
        require(hasRole(ROLE_REWARDS_DISTRIBUTOR, msg.sender), "ERR_ACCESS_DENIED");
    }

    modifier onlyPublisher() {
        _onlyPublisher();
        _;
    }

    function _onlyPublisher() internal view {
        require(hasRole(ROLE_PUBLISHER, msg.sender), "ERR_ACCESS_DENIED");
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
        onlyPublisher
        poolWhitelisted(poolToken)
        validExternalAddress(provider)
        validExternalAddress(address(reserveToken))
    {
        updateProviderReward(provider, poolToken, reserveToken);

        // if this is the first liquidity provision, record its time as the effective staking time for future reward
        // multiplier calculations.
        uint256 currentReserveAmount = providerReserveAmount(provider, poolToken, reserveToken);
        if (currentReserveAmount == 0) {
            ProviderRewards storage providerRewards = _rewards[poolToken][reserveToken].providerRewards[provider];
            providerRewards.effectiveStakingTime = time();
        }

        updateProviderLiquidity(provider, poolToken, reserveToken, currentReserveAmount.add(reserveAmount));
    }

    function updateLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256, /*newPoolAmount*/
        uint256 newReserveAmount,
        uint256 /*id*/
    )
        external
        override
        onlyPublisher
        poolWhitelisted(poolToken)
        validExternalAddress(provider)
        validExternalAddress(address(reserveToken))
    {
        updateProviderReward(provider, poolToken, reserveToken);

        updateProviderLiquidity(provider, poolToken, reserveToken, newReserveAmount);
    }

    function removeLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 /* id */
    )
        external
        override
        onlyPublisher
        poolWhitelisted(poolToken)
        validExternalAddress(provider)
        validExternalAddress(address(reserveToken))
    {
        updateProviderReward(provider, poolToken, reserveToken);

        updateProviderLiquidity(provider, poolToken, reserveToken, 0);
    }

    function rewards() external returns (uint256) {
        return rewards(msg.sender, false);
    }

    function rewards(address provider) external returns (uint256) {
        return rewards(provider, false);
    }

    function rewards(address provider, bool claim) private returns (uint256) {
        if (claim) {
            require(provider == msg.sender, "ERR_ACCESS_DENIED");
        }

        EnumerableSet.AddressSet storage providerPools = _poolsByProvider[provider];

        uint256 length = providerPools.length();
        IERC20[] memory poolTokens = new IERC20[](length);
        for (uint256 i = 0; i < length; ++i) {
            poolTokens[i] = IERC20(providerPools.at(i));
        }

        return rewards(provider, poolTokens, claim);
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

        IERC20[2] memory reserveTokens = _reserveTokensByPools[poolToken];
        for (uint8 j = 0; j < 2; ++j) {
            IERC20 reserveToken = reserveTokens[j];

            // update all provider's pending rewards, in order to take into account reward multipliers
            if (claim) {
                updateProviderReward(provider, poolToken, reserveToken);
            }

            reward = reward.add(fullRewards(provider, poolToken, reserveToken));

            if (claim) {
                Rewards storage rewardsData = _rewards[poolToken][reserveToken];
                ProviderRewards storage providerRewards = rewardsData.providerRewards[provider];

                providerRewards.pendingBaseRewards = 0;
                providerRewards.effectiveStakingTime = time();
            }
        }

        return reward;
    }

    function claimRewards() external returns (uint256) {
        EnumerableSet.AddressSet storage providerPools = _poolsByProvider[msg.sender];

        uint256 length = providerPools.length();
        IERC20[] memory poolTokens = new IERC20[](length);
        for (uint256 i = 0; i < length; ++i) {
            poolTokens[i] = IERC20(providerPools.at(i));
        }

        return claimRewards(msg.sender, poolTokens);
    }

    function claimRewards(address provider, IERC20[] memory poolTokens) private returns (uint256) {
        uint256 amount = rewards(provider, poolTokens, true);
        require(amount > 0, "ERR_NO_REWARDS");

        // make sure to update the last claim time so that it'll be taken into effect when calculating the next rewards
        // multiplier
        _store.updateLastClaimTime(provider);

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
        PoolProgram memory program,
        Rewards memory rewardsData,
        uint256 totalReserveAmount
    ) private view returns (uint256) {
        if (totalReserveAmount == 0) {
            return rewardsData.rewardPerToken;
        }

        uint256 stakingEndTime = Math.min(time(), program.endTime);
        uint256 stakingStartTime = Math.max(program.startTime, rewardsData.lastUpdateTime);

        return
            rewardsData.rewardPerToken.add(
                stakingEndTime.sub(stakingStartTime).mul(program.rewardRate).div(totalReserveAmount)
            );
    }

    function fullRewards(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    ) private view returns (uint256) {
        Rewards storage rewardsData = _rewards[poolToken][reserveToken];
        ProviderRewards storage providerRewards = rewardsData.providerRewards[provider];
        PoolProgram memory program = poolProgram(poolToken);

        uint256 providerAmount = providerReserveAmount(provider, poolToken, reserveToken);
        uint256 totalAmount = totalReserveAmount(poolToken, reserveToken);
        uint256 baseReward =
            providerAmount.mul(rewardPerToken(program, rewardsData, totalAmount).sub(providerRewards.rewardPerToken));

        uint256 multiplier = rewardsMultiplier(provider, providerRewards.effectiveStakingTime, program);
        return providerRewards.pendingBaseRewards.add(baseReward.mul(multiplier).div(PPM_RESOLUTION));
    }

    function updateProviderReward(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    ) private {
        PoolProgram memory program = poolProgram(poolToken);
        Rewards storage rewardsData = _rewards[poolToken][reserveToken];

        uint256 totalAmount = totalReserveAmount(poolToken, reserveToken);
        uint256 newRewardPerToken = rewardPerToken(program, rewardsData, totalAmount);
        rewardsData.rewardPerToken = newRewardPerToken;
        rewardsData.lastUpdateTime = Math.min(time(), program.endTime);

        ProviderRewards storage providerRewards = rewardsData.providerRewards[provider];
        providerRewards.pendingBaseRewards = fullRewards(provider, poolToken, reserveToken);
        providerRewards.rewardPerToken = newRewardPerToken;
    }

    function rewardsMultiplier(
        address provider,
        uint256 stakingStartTime,
        PoolProgram memory program
    ) private view returns (uint32) {
        uint256 effectiveStakingEndTime = Math.min(time(), program.endTime);
        uint256 effectiveStakingStartTime =
            Math.max(stakingStartTime, Math.max(_lastRemoveTimes.checkpoint(provider), _store.lastClaimTime(provider)));
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
        (program.startTime, program.endTime, program.rewardRate) = _store.poolProgram(poolToken);

        return program;
    }

    function providerReserveAmount(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    ) public view returns (uint256) {
        return _totalProtectedReserveAmountsByProvider[provider][poolToken][reserveToken];
    }

    function totalReserveAmount(IERC20 poolToken, IERC20 reserveToken) public view returns (uint256) {
        return _totalProtectedReserveAmounts[poolToken][reserveToken];
    }

    function updateProviderLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 newReserveAmount
    ) private {
        uint256 prevProviderAmount = providerReserveAmount(provider, poolToken, reserveToken);
        _totalProtectedReserveAmountsByProvider[provider][poolToken][reserveToken] = prevProviderAmount
            .add(newReserveAmount)
            .sub(prevProviderAmount);

        uint256 prevPoolAmount = totalReserveAmount(poolToken, reserveToken);
        _totalProtectedReserveAmounts[poolToken][reserveToken] = prevPoolAmount.add(newReserveAmount).sub(
            prevPoolAmount
        );
    }

    function liquidityProtection() private view returns (ILiquidityProtection) {
        return ILiquidityProtection(addressOf(LIQUIDITY_PROTECTION));
    }
}
