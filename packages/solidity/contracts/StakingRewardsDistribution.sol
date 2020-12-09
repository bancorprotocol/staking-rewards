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

/**
 * @dev This contract manages the distribution of the staking rewards.
 */
contract StakingRewardsDistribution is AccessControl, Time, Utils {
    using SafeMath for uint256;
    using EnumerableSet for EnumerableSet.UintSet;
    using SafeERC20 for IERC20;

    struct RewardData {
        EnumerableSet.UintSet pendingEpochs;
        mapping(uint256 => uint256) rewards;
    }

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

    // the instance of the LiquidityProtection contract for staking of the rewards
    ILiquidityProtection private _liquidityProtection;

    // the maximum pending rewards that the contract can distribute
    uint256 private _maxRewards;

    // the maximum pending rewards that the contract can distribute per epoch
    uint256 private _maxRewardsPerEpoch;

    // the current total amount of pending rewards
    uint256 private _totalRewards;

    // the current total amount of pending rewards per epoch
    mapping(uint256 => uint256) private _totalEpochRewards;

    // the mapping between position IDs and rewards data
    mapping(uint256 => RewardData) private _rewards;

    // the mapping between positions and their total claimed rewards
    mapping(uint256 => uint256) _claimedPositionRewards;

    // the mapping between providers and their total claimed rewards
    mapping(address => uint256) _claimedProviderRewards;

    // the list of committed epochs
    EnumerableSet.UintSet private _committedEpochs;

    /**
     * @dev triggered when pending rewards are being added or updated
     *
     * @param epoch the rewards distribution epoch
     * @param id the ID of the position
     * @param amount the reward amount
     */
    event RewardsUpdated(uint256 indexed epoch, uint256 indexed id, uint256 amount);

    /**
     * @dev triggered when pending rewards are being claimed
     *
     * @param ids the IDs of the positions
     * @param amount the total rewards amount
     */
    event RewardsClaimed(uint256[] ids, uint256 amount);

    /**
     * @dev triggered when pending rewards are being added or updated
     *
     * @param ids the IDs of the positions
     * @param poolToken the pool token representing the new LM pool
     * @param amount the reward amount
     * @param newId the ID of the new position
     */
    event RewardsStaked(uint256[] ids, IERC20 indexed poolToken, uint256 amount, uint256 indexed newId);

    /**
     * @dev initializes a new StakingRewardsDistribution contract
     *
     * @param store the staking rewards positions and pool specific data
     * @param networkTokenGovernance the permissioned wrapper around the network token
     * @param lastRemoveTimes the checkpoint store recording last protected position removal times
     * @param liquidityProtection the instance of the LiquidityProtection contract for staking of the rewards
     * @param maxRewards the maximum pending rewards that the contract can distribute
     * @param maxRewardsPerEpoch the maximum pending rewards that the contract can distribute per epoch
     */
    constructor(
        IStakingRewardsDistributionStore store,
        ITokenGovernance networkTokenGovernance,
        ICheckpointStore lastRemoveTimes,
        ILiquidityProtection liquidityProtection,
        uint256 maxRewards,
        uint256 maxRewardsPerEpoch
    )
        public
        validAddress(address(store))
        validAddress(address(networkTokenGovernance))
        validAddress(address(lastRemoveTimes))
        validAddress(address(liquidityProtection))
    {
        require(maxRewardsPerEpoch <= maxRewards, "ERR_INVALID_VALUE");

        _store = store;
        _networkTokenGovernance = networkTokenGovernance;
        _lastRemoveTimes = lastRemoveTimes;
        _liquidityProtection = liquidityProtection;
        _maxRewards = maxRewards;
        _maxRewardsPerEpoch = maxRewardsPerEpoch;

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

    modifier notCommitted(uint256 epoch) {
        _notCommitted(epoch);
        _;
    }

    function _notCommitted(uint256 epoch) internal view {
        require(!isEpochCommitted(epoch), "ERR_ALREADY_COMMITTED");
    }

    /**
     * @dev adds or updates rewards
     *
     * @param epoch the rewards distribution epoch
     * @param ids IDs of the positions
     * @param amounts reward amounts
     */
    function setRewards(
        uint256 epoch,
        uint256[] calldata ids,
        uint256[] calldata amounts
    ) external notCommitted(epoch) onlyRewardsDistributor {
        uint256 length = ids.length;
        require(length == amounts.length, "ERR_INVALID_LENGTH");

        uint256 totalRewards = _totalRewards;
        uint256 totalEpochRewards = _totalEpochRewards[epoch];

        for (uint256 i = 0; i < length; ++i) {
            uint256 id = ids[i];
            uint256 amount = amounts[i];
            require(_store.positionExists(id), "ERR_INVALID_ID");

            RewardData storage rewards = _rewards[id];

            {
                uint256 prevRewards = rewards.rewards[epoch];
                totalEpochRewards = totalEpochRewards.sub(prevRewards).add(amount);
                totalRewards = totalRewards.sub(prevRewards).add(amount);
            }

            rewards.rewards[epoch] = amount;
            rewards.pendingEpochs.add(epoch);

            emit RewardsUpdated(epoch, id, amount);
        }

        require(totalEpochRewards <= _maxRewardsPerEpoch, "ERR_MAX_REWARDS_PER_EPOCH");
        require(totalRewards <= _maxRewards, "ERR_MAX_REWARDS");

        _totalEpochRewards[epoch] = totalEpochRewards;
        _totalRewards = totalRewards;
    }

    /**
     * @dev sets the instance of the LiquidityProtection contract
     *
     * @param liquidityProtection the instance of the LiquidityProtection contract for staking of the rewards
     */
    function setLiquidityProtection(ILiquidityProtection liquidityProtection)
        external
        onlySupervisor
        validAddress(address(liquidityProtection))
    {
        _liquidityProtection = liquidityProtection;
    }

    /**
     * @dev returns the instance of the LiquidityProtection contract
     *
     * @return the instance of the LiquidityProtection contract for staking of the rewards
     */
    function liquidityProtection() external view returns (ILiquidityProtection) {
        return _liquidityProtection;
    }

    /**
     * @dev sets the maximum pending rewards that the contract can distribute
     *
     * @param maxRewards the maximum pending rewards that the contract can distributes
     */
    function setMaxRewards(uint256 maxRewards) external onlySupervisor {
        require(maxRewards >= _maxRewardsPerEpoch, "ERR_INVALID_VALUE");

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
     * @dev sets the maximum pending rewards that the contract can distribute per epoch
     *
     * @param maxRewardsPerEpoch the maximum pending rewards that the contract can distribute per epoch
     */
    function setMaxRewardsPerEpoch(uint256 maxRewardsPerEpoch) external onlySupervisor {
        require(maxRewardsPerEpoch <= _maxRewards, "ERR_INVALID_VALUE");

        _maxRewardsPerEpoch = maxRewardsPerEpoch;
    }

    /**
     * @dev returns the maximum pending rewards that the contract can distribute per epoch
     *
     * @return the maximum pending rewards that the contract can distribute per epoch
     */
    function maxRewardsPerEpoch() external view returns (uint256) {
        return _maxRewardsPerEpoch;
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
     * @dev returns the current total amount of pending rewards per epoch
     *
     * @param epoch the rewards distribution epoch
     *
     * @return the current total amount of pending rewards per epoch
     */
    function totalEpochRewards(uint256 epoch) external view returns (uint256) {
        return _totalEpochRewards[epoch];
    }

    /**
     * @dev commits all epoch's rewards and enables their distribution
     *
     * @param epoch the rewards distribution epoch
     */
    function commitEpoch(uint256 epoch) external onlyRewardsDistributor {
        require(_committedEpochs.add(epoch), "ERR_ALREADY_COMMITTED");
    }

    /**
     * @dev returns all committed epochs
     *
     * @return all committed epochs
     */
    function committedEpochs() external view returns (uint256[] memory) {
        uint256 length = _committedEpochs.length();
        uint256[] memory list = new uint256[](length);
        for (uint256 i = 0; i < length; ++i) {
            list[i] = _committedEpochs.at(i);
        }
        return list;
    }

    /**
     * @dev returns whether an epoch is committed
     *
     * @param epoch the rewards distribution epoch
     *
     * @return whether an epoch is committed
     */
    function isEpochCommitted(uint256 epoch) public view returns (bool) {
        return _committedEpochs.contains(epoch);
    }

    /**
     * @dev returns all pending epochs for the specified ID with an option to filter non-committed positions out
     *
     * @param id the ID of the position
     * @param committedOnly whether to include positions committed only
     *
     * @return all pending epochs
     */
    function pendingPositionEpochs(uint256 id, bool committedOnly) external view returns (uint256[] memory) {
        EnumerableSet.UintSet storage pendingEpochs = _rewards[id].pendingEpochs;
        uint256 length = pendingEpochs.length();
        uint256[] memory list = new uint256[](length);
        uint256 filteredLength = 0;
        for (uint256 i = 0; i < length; ++i) {
            uint256 epoch = pendingEpochs.at(i);
            if (!committedOnly || isEpochCommitted(epoch)) {
                list[i] = pendingEpochs.at(i);
                filteredLength++;
            }
        }

        if (filteredLength == length) {
            return list;
        }

        uint256[] memory filteredList = new uint256[](filteredLength);
        for (uint256 i = 0; i < filteredLength; ++i) {
            filteredList[i] = list[i];
        }

        return filteredList;
    }

    /**
     * @dev returns the rewards of a specific pending epoch
     *
     * @param id the ID of the position
     * @param epoch the rewards distribution epoch
     *
     * @return the rewards
     */
    function pendingPositionEpochRewards(uint256 id, uint256 epoch) external view returns (uint256) {
        return _rewards[id].rewards[epoch];
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

            // it should be possible to query other provider's rewards, but obviously not to claim them
            require(!claim || position(id).provider == msg.sender, "ERR_ACCESS_DENIED");

            RewardData storage rewardsData = _rewards[id];
            EnumerableSet.UintSet storage pendingEpochs = rewardsData.pendingEpochs;

            uint256 pendingAmount = 0;
            uint256 pendingEpochsLength = pendingEpochs.length();
            for (uint256 j = 0; j < pendingEpochsLength; ++j) {
                uint256 epoch = pendingEpochs.at(j);
                if (!isEpochCommitted(epoch)) {
                    continue;
                }

                pendingAmount = pendingAmount.add(rewardsData.rewards[epoch]);
            }

            if (claim) {
                _claimedPositionRewards[id] = _claimedPositionRewards[id].add(pendingAmount);

                delete rewardsData.pendingEpochs;
            }

            amount = amount.add(pendingAmount);
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

        emit RewardsClaimed(ids, amount);

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

        ILiquidityProtection lp = _liquidityProtection;
        ITokenGovernance tokenGov = _networkTokenGovernance;
        IERC20 networkToken = tokenGov.token();

        networkToken.safeApprove(address(lp), amount);
        tokenGov.mint(address(this), amount);

        uint256 newId = lp.addLiquidityFor(msg.sender, poolToken, networkToken, amount);

        // please note, that in order to incentivize restaking, we won't be updating the time of the last claim, thus
        // preserving the rewards bonus multiplier

        emit RewardsStaked(ids, poolToken, amount, newId);

        return (amount, newId);
    }

    /**
     * @dev returns the rewards multiplier based on the time that the position was held an no other position was claimed
     * or removed
     *
     * @param ids the position ids to retrieve the rewards multiplier for
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
}
