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

contract StakingRewardsDistribution is AccessControl, Time, Utils {
    using SafeMath for uint256;
    using EnumerableSet for EnumerableSet.UintSet;
    using SafeERC20 for IERC20;

    struct RewardData {
        EnumerableSet.UintSet pendingEpochs;
        mapping(uint256 => uint256) rewards;
    }

    // The supervisor role is used to globally govern the contract and its governing roles.
    bytes32 public constant ROLE_SUPERVISOR = keccak256("ROLE_SUPERVISOR");

    // The governor role is used to govern the minter role.
    bytes32 public constant ROLE_REWARDS_DISTRIBUTOR = keccak256("ROLE_REWARDS_DISTRIBUTOR");

    uint32 public constant PPM_RESOLUTION = 1000000;
    uint32 public constant MULTIPLIER_INCREMENT = PPM_RESOLUTION / 4; // 25%

    IStakingRewardsDistributionStore private immutable _store;
    ITokenGovernance private immutable _networkTokenGovernance;
    ICheckpointStore private immutable _lastRemoveTimes;
    ILiquidityProtection private _liquidityProtection;
    uint256 private _maxRewards;
    uint256 private _maxRewardsPerEpoch;

    uint256 private _totalRewards;
    mapping(uint256 => uint256) private _totalEpochRewards;

    mapping(uint256 => RewardData) private _rewards;
    EnumerableSet.UintSet private _committedEpochs;

    event MaxRewardsUpdated(uint256 prevMaxRewards, uint256 newMaxRewards);
    event MaxRewardsPerEpochUpdated(uint256 prevMaxRewardsPerEpoch, uint256 newMaxRewardsPerEpoch);

    event RewardsUpdated(uint256 indexed id, uint256 amount);
    event RewardsClaimed(uint256 indexed id, uint256 amount);
    event RewardsStaked(uint256 indexed id, IERC20 indexed poolToken, uint256 amount, uint256 indexed newId);

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

            emit RewardsUpdated(id, amount);
        }

        require(totalEpochRewards <= _maxRewardsPerEpoch, "ERR_MAX_REWARDS_PER_EPOCH");
        _totalEpochRewards[epoch] = totalEpochRewards;

        require(totalRewards <= _maxRewards, "ERR_MAX_REWARDS");
        _totalRewards = totalRewards;
    }

    function setLiquidityProtection(ILiquidityProtection liquidityProtection)
        external
        onlySupervisor
        validAddress(address(liquidityProtection))
    {
        _liquidityProtection = liquidityProtection;
    }

    function setMaxRewards(uint256 maxRewards) external onlySupervisor {
        require(maxRewards >= _maxRewardsPerEpoch, "ERR_INVALID_VALUE");

        emit MaxRewardsUpdated(_maxRewards, maxRewards);

        _maxRewards = maxRewards;
    }

    function setMaxRewardsPerEpoch(uint256 maxRewardsPerEpoch) external onlySupervisor {
        require(maxRewardsPerEpoch <= _maxRewards, "ERR_INVALID_VALUE");

        emit MaxRewardsPerEpochUpdated(_maxRewardsPerEpoch, maxRewardsPerEpoch);

        _maxRewardsPerEpoch = maxRewardsPerEpoch;
    }

    function liquidityProtection() external view returns (ILiquidityProtection) {
        return _liquidityProtection;
    }

    function maxRewards() external view returns (uint256) {
        return _maxRewards;
    }

    function maxRewardsPerEpoch() external view returns (uint256) {
        return _maxRewardsPerEpoch;
    }

    function totalRewards() external view returns (uint256) {
        return _totalRewards;
    }

    function totalEpochRewards(uint256 epoch) external view returns (uint256) {
        return _totalEpochRewards[epoch];
    }

    function commitEpoch(uint256 epoch) external onlyRewardsDistributor {
        require(_committedEpochs.add(epoch), "ERR_ALREADY_COMMITTED");
    }

    function committedEpochs() external view returns (uint256[] memory) {
        uint256 length = _committedEpochs.length();
        uint256[] memory list = new uint256[](length);
        for (uint256 i = 0; i < length; ++i) {
            list[i] = _committedEpochs.at(i);
        }
        return list;
    }

    function isEpochCommitted(uint256 epoch) public view returns (bool) {
        return _committedEpochs.contains(epoch);
    }

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

    function pendingPositionEpochRewards(uint256 id, uint256 epoch) external view returns (uint256) {
        return _rewards[id].rewards[epoch];
    }

    function position(uint256 id) private view returns (Position memory) {
        Position memory pos;
        (pos.provider, pos.poolToken, pos.startTime) = _store.position(id);

        return pos;
    }

    function poolProgram(IERC20 poolToken) private view returns (PoolProgram memory) {
        PoolProgram memory pos;
        (pos.startTime, pos.endTime) = _store.poolProgram(poolToken);

        return pos;
    }

    function rewards(uint256 id) public returns (uint256) {
        return rewards(id, false);
    }

    function rewards(uint256 id, bool claim) private returns (uint256) {
        Position memory pos = position(id);
        require(pos.provider == msg.sender, "ERR_ACCESS_DENIED");

        RewardData storage rewardsData = _rewards[id];
        EnumerableSet.UintSet storage pendingEpochs = rewardsData.pendingEpochs;

        uint256 amount = 0;
        uint256 length = pendingEpochs.length();
        for (uint256 i = 0; i < length; ++i) {
            uint256 epoch = pendingEpochs.at(i);
            if (!isEpochCommitted(epoch)) {
                continue;
            }

            amount = amount.add(rewardsData.rewards[epoch]);
        }

        if (claim) {
            delete rewardsData.pendingEpochs;
        }

        return amount.mul(rewardsMultiplier(pos)).div(PPM_RESOLUTION);
    }

    function claimRewards(uint256 id) external returns (uint256) {
        uint256 amount = rewards(id, true);
        require(amount > 0, "ERR_NO_REWARDS");

        _store.updateLastClaimTime(msg.sender);

        _networkTokenGovernance.mint(msg.sender, amount);

        emit RewardsClaimed(id, amount);

        return amount;
    }

    function stakeRewards(uint256 id, IERC20 poolToken) external returns (uint256, uint256) {
        uint256 amount = rewards(id, true);
        require(amount > 0, "ERR_NO_REWARDS");

        ILiquidityProtection lp = _liquidityProtection;
        ITokenGovernance tokenGov = _networkTokenGovernance;
        IERC20 networkToken = tokenGov.token();

        networkToken.safeApprove(address(lp), amount);
        tokenGov.mint(address(this), amount);

        uint256 newId = lp.addLiquidityFor(msg.sender, poolToken, networkToken, amount);

        // please note, that in order to incentivize restaking, we won't be updating the time of the last claim, thus
        // preserving the rewards bonus multiplier

        emit RewardsStaked(id, poolToken, amount, newId);

        return (amount, newId);
    }

    /**
     * @dev returns the rewards multiplier based on the time that the position was held an no other position was claimed
     * or removed
     *
     * @param id the position id to retrieve the rewards multiplier for
     * @return the rewards multiplier
     */
    function rewardsMultiplier(uint256 id) external view returns (uint32) {
        Position memory pos = position(id);
        require(pos.provider == msg.sender, "ERR_ACCESS_DENIED");

        return rewardsMultiplier(pos);
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
                    Math.max(_lastRemoveTimes.checkpoint(msg.sender), _store.lastClaimTime(msg.sender))
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
     * @dev returns the rewards multiplier based on the time that the position was held an no other position was claimed
     * or removed
     *
     * @param _startTime the staking starting time
     * @param _endTime the staking ending time
     * @param _lastClaimTime the time of the last claim/remove/transfer
     * @return the rewards multiplier
     */
    function rewardsMultiplier(
        uint256 _startTime,
        uint256 _endTime,
        uint256 _lastClaimTime
    ) private pure returns (uint32) {}
}
