// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "@bancor/token-governance/contracts/ITokenGovernance.sol";

import "./IStakingRewardsDistributionStore.sol";
import "./ICheckpointStore.sol";
import "./ILiquidityProtection.sol";
import "./Time.sol";
import "./Utils.sol";
import "./ContractRegistryClient.sol";

/**
 * @dev This contract manages the distribution of the staking rewards.
 */
contract StakingRewardsDistribution is AccessControl, Time, Utils, ContractRegistryClient {
    using SafeMath for uint256;
    using EnumerableSet for EnumerableSet.UintSet;
    using SafeERC20 for IERC20;

    // the supervisor role is used to globally govern the contract and its governing roles.
    bytes32 public constant ROLE_SUPERVISOR = keccak256("ROLE_SUPERVISOR");

    // the governor role is used to govern the minter role.
    bytes32 public constant ROLE_REWARDS_DISTRIBUTOR = keccak256("ROLE_REWARDS_DISTRIBUTOR");

    uint32 public constant PPM_RESOLUTION = 1000000;

    // the weekly 25% increase of the rewards multiplier (in units of PPM)
    uint32 public constant MULTIPLIER_INCREMENT = PPM_RESOLUTION / 4;

    // the staking rewards positions and pool specific data
    IStakingRewardsDistributionStore private immutable _store;

    // the permissioned wrapper around the network token which should allow this contract to mint staking rewards
    ITokenGovernance private immutable _networkTokenGovernance;

    // the checkpoint store recording last protected position removal times
    ICheckpointStore private immutable _lastRemoveTimes;

    // the maximum pending rewards that the contract can distribute
    uint256 private _maxRewards;

    // the current total amount of pending and distributed rewards
    uint256 private _totalRewards;

    // the mapping between position IDs and remaining claimable rewards
    mapping(uint256 => uint256) private _rewards;

    // the mapping between positions and their total claimed rewards
    mapping(uint256 => uint256) _claimedPositionRewards;

    // the mapping between providers and their total claimed rewards
    mapping(address => uint256) _claimedProviderRewards;

    /**
     * @dev triggered when pending rewards are being added or updated
     *
     * @param id the ID of the position
     * @param amount the reward amount
     */
    event RewardsUpdated(uint256 indexed id, uint256 amount);

    /**
     * @dev triggered when pending rewards are being claimed
     *
     * @param ids the IDs of the positions
     * @param amount the total rewards amount
     */
    event RewardsClaimed(address indexed provider, uint256[] ids, uint256 amount);

    /**
     * @dev triggered when pending rewards are being added or updated
     *
     * @param ids the IDs of the positions
     * @param poolToken the pool token representing the new LM pool
     * @param amount the reward amount
     * @param newId the ID of the new position
     */
    event RewardsStaked(
        address indexed provider,
        uint256[] ids,
        IERC20 indexed poolToken,
        uint256 amount,
        uint256 indexed newId
    );

    /**
     * @dev initializes a new StakingRewardsDistribution contract
     *
     * @param store the staking rewards positions and pool specific data
     * @param networkTokenGovernance the permissioned wrapper around the network token
     * @param lastRemoveTimes the checkpoint store recording last protected position removal times
     * @param maxRewards the maximum pending rewards that the contract can distribute
     * @param registry address of a contract registry contract
     */
    constructor(
        IStakingRewardsDistributionStore store,
        ITokenGovernance networkTokenGovernance,
        ICheckpointStore lastRemoveTimes,
        uint256 maxRewards,
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
        _maxRewards = maxRewards;

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

    /**
     * @dev adds or updates rewards
     *
     * @param ids IDs of the positions
     * @param amounts new total reward amounts
     */
    function setRewards(uint256[] calldata ids, uint256[] calldata amounts) external onlyRewardsDistributor {
        uint256 length = ids.length;
        require(length == amounts.length, "ERR_INVALID_LENGTH");

        uint256 totalRewards = _totalRewards;

        for (uint256 i = 0; i < length; ++i) {
            uint256 id = ids[i];
            uint256 amount = amounts[i];
            require(_store.positionExists(id), "ERR_INVALID_ID");

            uint256 prevAmount = _rewards[id];
            totalRewards = totalRewards.add(amount).sub(prevAmount);

            _rewards[id] = amount;

            emit RewardsUpdated(id, amount);
        }

        require(totalRewards <= _maxRewards, "ERR_MAX_REWARDS");

        _totalRewards = totalRewards;
    }

    /**
     * @dev sets the maximum pending rewards that the contract can distribute
     *
     * @param maxRewards the maximum pending rewards that the contract can distributes
     */
    function setMaxRewards(uint256 maxRewards) external onlySupervisor {
        _maxRewards = maxRewards;
    }

    /**
     * @dev returns the maximum pending rewards that the contract can distribute
     *
     * @return the maximum pending rewards that the contract can distributes
     */
    function maxRewards() external view returns (uint256) {
        return _maxRewards;
    }

    /**
     * @dev returns the current total amount of pending rewards
     *
     * @return the current total amount of pending rewards
     */
    function totalRewards() external view returns (uint256) {
        return _totalRewards;
    }

    /**
     * @dev returns the total claimed rewards for a specific position
     *
     * @param id the ID of the position
     *
     * @return the total claimed rewards
     */
    function claimedPositionRewards(uint256 id) external view returns (uint256) {
        return _claimedPositionRewards[id];
    }

    /**
     * @dev returns the total claimed rewards for a specific provider
     *
     * @param provider the provider
     *
     * @return the total claimed rewards
     */
    function claimedProviderRewards(address provider) external view returns (uint256) {
        return _claimedProviderRewards[provider];
    }

    /**
     * @dev returns position data
     *
     * @param id the ID of the position
     *
     * @return position data
     */
    function position(uint256 id) private view returns (Position memory) {
        Position memory pos;
        (pos.provider, pos.poolToken, pos.startTime) = _store.position(id);

        return pos;
    }

    /**
     * @dev returns pool data
     *
     * @param poolToken the pool token representing the new LM pool
     *
     * @return pool data
     */
    function poolProgram(IERC20 poolToken) private view returns (PoolProgram memory) {
        PoolProgram memory pos;
        (pos.startTime, pos.endTime, pos.weeklyRewards) = _store.poolProgram(poolToken);

        return pos;
    }

    /**
     * @dev returns position's rewards
     *
     * @param ids the IDs of the position
     *
     * @return position's rewards
     */
    function rewards(uint256[] calldata ids) public returns (uint256) {
        return rewards(ids, false);
    }

    /**
     * @dev returns position's rewards and optionally marks them as claimed
     *
     * @param ids the IDs of the positions to claim
     * @param claim whether to mark the rewards as claimed
     *
     * @return amount position's rewards
     */
    function rewards(uint256[] calldata ids, bool claim) private returns (uint256) {
        uint256 amount = 0;

        uint256 length = ids.length;
        for (uint256 i = 0; i < length; ++i) {
            uint256 id = ids[i];

            // check for duplicate ids
            for (uint256 j = i + 1; j < length; ++j) {
                require(id != ids[j], "ERR_DUPLICATE_ID");
            }

            uint256 reward = _rewards[id];
            uint256 claimed = _claimedPositionRewards[id];

            // make sure to exclude already claimed rewards
            amount = amount.add(reward.sub(claimed));

            if (claim) {
                // it should be possible to query other provider's rewards, but obviously not to claim them
                require(position(id).provider == msg.sender, "ERR_ACCESS_DENIED");

                _claimedPositionRewards[id] = reward;
            }
        }

        if (claim) {
            _claimedProviderRewards[msg.sender] = _claimedProviderRewards[msg.sender].add(amount);
        }

        return amount;
    }

    /**
     * @dev claims position's rewards
     *
     * @param ids the IDs of the positions to claim
     *
     * @return position's rewards
     */
    function claimRewards(uint256[] calldata ids) external returns (uint256) {
        uint256 amount = rewards(ids, true);
        require(amount > 0, "ERR_NO_REWARDS");

        // make sure to update the last claim time so that it'll be taken into effect when calculating the next rewards
        // multiplier
        _store.updateLastClaimTime(msg.sender);

        _networkTokenGovernance.mint(msg.sender, amount);

        emit RewardsClaimed(msg.sender, ids, amount);

        return amount;
    }

    /**
     * @dev claims and stakes position's rewards
     *
     * @param ids the IDs of the position rewards to stake
     * @param poolToken the pool token representing the new LM pool
     *
     * @return position's rewards and the ID of the new position
     */
    function stakeRewards(uint256[] calldata ids, IERC20 poolToken) external returns (uint256, uint256) {
        uint256 amount = rewards(ids, true);
        require(amount > 0, "ERR_NO_REWARDS");

        ILiquidityProtection lp = ILiquidityProtection(addressOf(LIQUIDITY_PROTECTION));
        ITokenGovernance tokenGov = _networkTokenGovernance;
        IERC20 networkToken = tokenGov.token();

        networkToken.safeApprove(address(lp), amount);
        tokenGov.mint(address(this), amount);

        uint256 newId = lp.addLiquidityFor(msg.sender, poolToken, networkToken, amount);

        // please note, that in order to incentivize restaking, we won't be updating the time of the last claim, thus
        // preserving the rewards bonus multiplier

        emit RewardsStaked(msg.sender, ids, poolToken, amount, newId);

        return (amount, newId);
    }

    /**
     * @dev returns the rewards multiplier based on the time that the position was held an no other position was claimed
     * or removed
     *
     * @param ids the position ids to retrieve the rewards multiplier for
     *
     * @return the rewards multiplier
     */
    function rewardsMultipliers(uint256[] calldata ids) external view returns (uint32[] memory) {
        uint256 length = ids.length;
        uint32[] memory multipliers = new uint32[](length);
        for (uint256 i = 0; i < length; ++i) {
            multipliers[i] = rewardsMultiplier(position(ids[i]));
        }

        return multipliers;
    }

    /**
     * @dev returns the rewards multiplier based on the time that the position was held an no other position was claimed
     * or removed
     *
     * @param pos the position to retrieve the rewards multiplier for
     * @return the rewards multiplier
     */
    function rewardsMultiplier(Position memory pos) private view returns (uint32) {
        PoolProgram memory program = poolProgram(pos.poolToken);

        uint256 endTime = Math.min(program.endTime, time());

        // please note that if this position was already closed, the LP's removal time checkpoint will affect
        // the resulting multiplier.

        uint256 effectiveStakingDuration =
            endTime.sub(
                Math.max(
                    pos.startTime,
                    Math.max(_lastRemoveTimes.checkpoint(pos.provider), _store.lastClaimTime(pos.provider))
                )
            );

        // given x representing the staking duration (in seconds), the resulting multiplier (in PPM) is:
        // * for 0 <= x <= 1 weeks: 100% PPM
        // * for 1 <= x <= 2 weeks: 125% PPM
        // * for 2 <= x <= 3 weeks: 150% PPM
        // * for 3 <= x <= 4 weeks: 175% PPM
        // * for x > 4 weeks: 200% PPM
        return PPM_RESOLUTION + MULTIPLIER_INCREMENT * uint32(Math.min(effectiveStakingDuration.div(1 weeks), 4));
    }

    /**
     * @dev checks whether a list of IDs contains duplicates
     *
     * @param ids the position ids to check
     * @return whether a list of IDs contains duplicates
     */
    function duplicatesExist(uint256[] calldata ids) private pure returns (bool) {
        uint256 length = ids.length;
        for (uint256 i = 0; i < length; ++i) {
            for (uint256 j = i + 1; j < ids.length; ++j) {
                if (ids[i] == ids[j]) {
                    return false;
                }
            }
        }

        return true;
    }
}
