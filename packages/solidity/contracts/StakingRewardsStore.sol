// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

import "./IStakingRewardsStore.sol";
import "./IOwned.sol";
import "./IConverter.sol";
import "./Utils.sol";
import "./Time.sol";

/**
 * @dev This contract stores staking rewards liquidity and pool specific data.
 */
contract StakingRewardsStore is IStakingRewardsStore, AccessControl, Utils, Time {
    using SafeMath for uint32;
    using SafeMath for uint256;

    // the owner role is used to set the values in the store
    bytes32 public constant ROLE_OWNER = keccak256("ROLE_OWNER");

    uint32 private constant PPM_RESOLUTION = 1000000;

    // the mapping between pool tokens and their respective LM program information
    mapping(IERC20 => PoolProgram) private _programs;

    // the mapping between pools, reserve tokens, and their rewards
    mapping(IERC20 => mapping(IERC20 => Rewards)) internal _rewards;

    // the mapping between pools, reserve tokens, and provider specific rewards
    mapping(address => mapping(IERC20 => mapping(IERC20 => ProviderRewards))) internal _providerRewards;

    // the mapping between providers and their respective last claim times
    mapping(address => uint256) private _lastProviderClaimTimes;

    /**
     * @dev triggered when a pool program is being added
     *
     * @param poolToken the pool token representing the LM pool
     * @param startTime the starting time of the program
     * @param endTime the ending time of the program
     * @param rewardRate the program's weekly rewards
     */
    event PoolProgramAdded(IERC20 indexed poolToken, uint256 startTime, uint256 endTime, uint256 rewardRate);

    /**
     * @dev triggered when a pool program is being removed
     *
     * @param poolToken the pool token representing the LM pool
     */
    event PoolProgramRemoved(IERC20 indexed poolToken);

    /**
     * @dev triggered when provider's last claim time is being updated
     *
     * @param provider the owner of the liquidity
     * @param claimTime the time of the last claim
     */
    event LastProviderClaimTimeUpdated(address indexed provider, uint256 claimTime);

    /**
     * @dev initializes a new StakingRewardsDistributionStore contract
     */
    constructor() public {
        // Set up administrative roles.
        _setRoleAdmin(ROLE_OWNER, ROLE_OWNER);

        // Allow the deployer to initially govern the contract.
        _setupRole(ROLE_OWNER, _msgSender());
    }

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    function _onlyOwner() internal view {
        require(hasRole(ROLE_OWNER, msg.sender), "ERR_ACCESS_DENIED");
    }

    /**
     * @dev returns whether the specified pool participates in the LM program
     *
     * @param poolToken the pool token representing the LM pool
     * @param reserveToken the reserve token of the added liquidity
     *
     * @return whether the specified pool participates in the LM program
     */
    function isReserveParticipating(IERC20 poolToken, IERC20 reserveToken) public view override returns (bool) {
        PoolProgram memory program = _programs[poolToken];
        if (!isPoolParticipating(program)) {
            return false;
        }

        return program.reserveTokens[0] == reserveToken || program.reserveTokens[1] == reserveToken;
    }

    /**
     * @dev returns whether the specified pool participates in the LM program
     *
     * @param program the program data
     * @return whether the specified pool participates in the LM program
     */
    function isPoolParticipating(PoolProgram memory program) private pure returns (bool) {
        return program.endTime > 0;
    }

    /**
     * @dev adds or updates a pool program
     *
     * @param poolToken the pool token representing the LM pool
     * @param reserveTokens the reserve tokens representing the liqudiity in the pool
     * @param rewardShares reserve reward shares
     * @param endTime the ending time of the program
     * @param rewardRate the program's weekly rewards
     */
    function addPoolProgram(
        IERC20 poolToken,
        IERC20[2] calldata reserveTokens,
        uint32[2] calldata rewardShares,
        uint256 endTime,
        uint256 rewardRate
    ) external override onlyOwner validAddress(address(poolToken)) {
        uint256 currentTime = time();
        require(endTime > currentTime, "ERR_INVALID_DURATION");
        require(rewardRate > 0, "ERR_ZERO_VALUE");
        require(rewardShares[0].add(rewardShares[1]) == PPM_RESOLUTION, "ERR_INVALID_REWARD_SHARES");

        PoolProgram storage program = _programs[poolToken];
        require(!isPoolParticipating(program), "ERR_ALREADY_SUPPORTED");

        program.startTime = currentTime;
        program.endTime = endTime;
        program.rewardRate = rewardRate;
        program.rewardShares = rewardShares;

        // verify that reserve tokens correspond to the pool
        IConverter converter = IConverter(IOwned(address(poolToken)).owner());
        uint256 length = converter.connectorTokenCount();
        require(length == 2, "ERR_POOL_NOT_SUPPORTED");

        require(
            (converter.connectorTokens(0) == reserveTokens[0] && converter.connectorTokens(1) == reserveTokens[1]) ||
                (converter.connectorTokens(0) == reserveTokens[1] && converter.connectorTokens(1) == reserveTokens[0]),
            "ERR_INVALID_RESERVE_TOKENS"
        );
        program.reserveTokens = reserveTokens;

        emit PoolProgramAdded(poolToken, currentTime, endTime, rewardRate);
    }

    /**
     * @dev removes a pool program
     *
     * @param poolToken the pool token representing the LM pool
     */
    function removePoolProgram(IERC20 poolToken) external override onlyOwner {
        require(isPoolParticipating(_programs[poolToken]), "ERR_POOL_NOT_PARTICIPATING");

        delete _programs[poolToken];

        emit PoolProgramRemoved(poolToken);
    }

    /**
     * @dev returns a pool program
     *
     * @return the pool program's starting and ending times
     */
    function poolProgram(IERC20 poolToken)
        external
        view
        override
        returns (
            uint256,
            uint256,
            uint256,
            IERC20[2] memory,
            uint32[2] memory
        )
    {
        PoolProgram memory program = _programs[poolToken];
        require(isPoolParticipating(program), "ERR_POOL_NOT_PARTICIPATING");

        return (program.startTime, program.endTime, program.rewardRate, program.reserveTokens, program.rewardShares);
    }

    /**
     * @dev returns the rewards data of a specific reserve in a specific pool
     *
     * @param poolToken the pool token representing the LM pool
     * @param reserveToken the reserve token in the LM pool
     *
     * @return rewards data
     */
    function rewards(IERC20 poolToken, IERC20 reserveToken)
        external
        view
        override
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        Rewards memory data = _rewards[poolToken][reserveToken];

        return (data.lastUpdateTime, data.rewardPerToken, data.totalClaimedRewards);
    }

    /**
     * @dev updates the reward data of a specific reserve in a specific pool
     *
     * @param poolToken the pool token representing the LM pool
     * @param reserveToken the reserve token in the LM pool
     * @param lastUpdateTime the last upate time
     * @param rewardPerToken the new reward rate per-token

     * @param totalClaimedRewards the total claimed rewards up until now
     */
    function updateRewardData(
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 lastUpdateTime,
        uint256 rewardPerToken,
        uint256 totalClaimedRewards
    ) external override onlyOwner {
        Rewards storage data = _rewards[poolToken][reserveToken];
        data.lastUpdateTime = lastUpdateTime;
        data.rewardPerToken = rewardPerToken;
        data.totalClaimedRewards = totalClaimedRewards;
    }

    /**
     * @dev returns rewards data of a specific provider
     *
     * @param provider the owner of the liquidity
     * @param poolToken the pool token representing the LM pool
     * @param reserveToken the reserve token in the LM pool
     *
     * @return rewards data
     */
    function providerRewards(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    )
        external
        view
        override
        returns (
            uint256,
            uint256,
            uint256,
            uint256,
            uint32
        )
    {
        ProviderRewards memory data = _providerRewards[provider][poolToken][reserveToken];

        return (
            data.rewardPerToken,
            data.pendingBaseRewards,
            data.effectiveStakingTime,
            data.baseRewardsDebt,
            data.baseRewardsDebtMultiplier
        );
    }

    /**
     * @dev updates specific provider's reward data
     *
     * @param provider the owner of the liquidity
     * @param poolToken the pool token representing the LM pool
     * @param reserveToken the reserve token in the LM pool
     * @param rewardPerToken the new reward rate per-token
     * @param pendingBaseRewards the updated pending base rewards
     * @param effectiveStakingTime the new effective staking time
     * @param baseRewardsDebt the updated base rewards debt
     * @param baseRewardsDebtMultiplier the updated base rewards debt multiplier
     */
    function updateProviderRewardData(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 rewardPerToken,
        uint256 pendingBaseRewards,
        uint256 effectiveStakingTime,
        uint256 baseRewardsDebt,
        uint32 baseRewardsDebtMultiplier
    ) external override onlyOwner {
        ProviderRewards storage data = _providerRewards[provider][poolToken][reserveToken];

        data.rewardPerToken = rewardPerToken;
        data.pendingBaseRewards = pendingBaseRewards;
        data.effectiveStakingTime = effectiveStakingTime;
        data.baseRewardsDebt = baseRewardsDebt;
        data.baseRewardsDebtMultiplier = baseRewardsDebtMultiplier;
    }

    /**
     * @dev updates provider's last claim time
     *
     * @param provider the owner of the liquidity
     */
    function updateProviderLastClaimTime(address provider) external override onlyOwner {
        uint256 time = time();
        _lastProviderClaimTimes[provider] = time;

        emit LastProviderClaimTimeUpdated(provider, time);
    }

    /**
     * @dev returns provider's last claim time
     *
     * @param provider the owner of the liquidity
     *
     * @return provider's last claim time
     */
    function lastProviderClaimTime(address provider) external view override returns (uint256) {
        return _lastProviderClaimTimes[provider];
    }
}
