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
    using SafeMath for uint256;

    // the owner role is used to set the values in the store
    bytes32 public constant ROLE_OWNER = keccak256("ROLE_OWNER");

    // the mapping between pool tokens and their respective LM program information
    mapping(IERC20 => PoolProgram) private _programs;

    // the mapping between pools, reserve tokens, and their rewards
    mapping(IERC20 => mapping(IERC20 => Rewards)) internal _rewards;

    // the mapping between pools, reserve tokens, and provider specific rewards
    mapping(address => mapping(IERC20 => mapping(IERC20 => ProviderRewards))) internal _providerRewards;

    // the mapping between providers and the pools they are participating in
    mapping(address => EnumerableSet.AddressSet) internal _poolsByProvider;

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
     * @dev triggered when a pool program is being updated
     *
     * @param poolToken the pool token representing the LM pool
     * @param startTime the starting time of the program
     * @param endTime the ending time of the program
     * @param rewardRate the program's weekly rewards
     */
    event PoolProgramUpdated(IERC20 indexed poolToken, uint256 startTime, uint256 endTime, uint256 rewardRate);

    /**
     * @dev triggered when a pool program is being removed
     *
     * @param poolToken the pool token representing the LM pool
     */
    event PoolProgramRemoved(IERC20 indexed poolToken);

    /**
     * @dev triggered when a provider provisions liquidity
     *
     * @param provider the owner of the liquidity
     * @param poolToken the pool token representing the LM pool
     * @param reserveToken the reserve token of the added liquidity
     * @param reserveAmount the added reserve amount
     */
    event ProviderLiquidityAdded(
        address indexed provider,
        IERC20 indexed poolToken,
        IERC20 indexed reserveToken,
        uint256 reserveAmount
    );

    /**
     * @dev triggered when a provider removes liquidity
     *
     * @param provider the owner of the liquidity
     * @param poolToken the pool token representing the LM pool
     * @param reserveToken the reserve token of the removed liquidity
     * @param removedReserveAmount the removed reserve amount
     */
    event ProviderLiquidityRemoved(
        address indexed provider,
        IERC20 indexed poolToken,
        IERC20 indexed reserveToken,
        uint256 removedReserveAmount
    );

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
    function isParticipatingReserve(IERC20 poolToken, IERC20 reserveToken) public view override returns (bool) {
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
     * @param startTime the starting time of the program
     * @param endTime the ending time of the program
     * @param rewardRate the program's weekly rewards
     */
    function addPoolProgram(
        IERC20 poolToken,
        uint256 startTime,
        uint256 endTime,
        uint256 rewardRate
    ) external override onlyOwner validAddress(address(poolToken)) {
        require(startTime > 0 && startTime < endTime && endTime > time(), "ERR_INVALID_DURATION");
        require(rewardRate > 0, "ERR_ZERO_VALUE");

        PoolProgram storage program = _programs[poolToken];
        bool newProgram = !isPoolParticipating(program);

        program.startTime = startTime;
        program.endTime = endTime;
        program.rewardRate = rewardRate;

        IConverter converter = IConverter(IOwned(address(poolToken)).owner());
        uint256 length = converter.connectorTokenCount();
        require(length == 2, "ERR_POOL_NOT_SUPPORTED");

        program.reserveTokens[0] = converter.connectorTokens(0);
        program.reserveTokens[1] = converter.connectorTokens(1);

        if (newProgram) {
            emit PoolProgramAdded(poolToken, startTime, endTime, rewardRate);
        } else {
            emit PoolProgramUpdated(poolToken, startTime, endTime, rewardRate);
        }
    }

    /**
     * @dev removes a pool program
     *
     * @param poolToken the pool token representing the LM pool
     */
    function removePoolProgram(IERC20 poolToken) external override onlyOwner {
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
            IERC20[2] memory
        )
    {
        PoolProgram memory program = _programs[poolToken];
        require(isPoolParticipating(program), "ERR_POOL_NOT_PARTICIPATING");

        return (program.startTime, program.endTime, program.rewardRate, program.reserveTokens);
    }

    /**
     * @dev adds provider's liquidity
     *
     * @param provider the owner of the liquidity
     * @param poolToken the pool token representing the LM pool
     * @param reserveToken the reserve token of the added liquidity
     * @param reserveAmount the added reserve amount
     */
    function addProviderLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount
    ) external override onlyOwner {
        // update pool's total reserve amount
        Rewards storage rewardsData = _rewards[poolToken][reserveToken];
        rewardsData.totalReserveAmount = rewardsData.totalReserveAmount.add(reserveAmount);

        // if this is the first liquidity provision, record its time as the effective staking time for future reward
        // multiplier calculations.
        ProviderRewards storage providerRewards = _providerRewards[provider][poolToken][reserveToken];
        uint256 prevProviderAmount = providerRewards.reserveAmount;
        if (prevProviderAmount == 0) {
            // please note, that EnumerableSet.AddressSet won't add the pool token more than once (for example, in
            // the case when a provider has removed and add liquidity again).
            _poolsByProvider[provider].add(address(poolToken));

            providerRewards.effectiveStakingTime = time();
        }

        // update provider's reserve amount
        providerRewards.reserveAmount = prevProviderAmount.add(reserveAmount);

        emit ProviderLiquidityAdded(provider, poolToken, reserveToken, reserveAmount);
    }

    /**
     * @dev removes provider's liquidity
     *
     * @param provider the owner of the liquidity
     * @param poolToken the pool token representing the LM pool
     * @param reserveToken the reserve token of the removed liquidity
     * @param removedReserveAmount the removed reserve amount
     */
    function removeProviderLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 removedReserveAmount
    ) external override onlyOwner {
        // update pool's total reserve amount.
        Rewards storage rewardsData = _rewards[poolToken][reserveToken];
        rewardsData.totalReserveAmount = rewardsData.totalReserveAmount.sub(removedReserveAmount);

        // update provider's reserve amount.
        ProviderRewards storage providerRewards = _providerRewards[provider][poolToken][reserveToken];
        providerRewards.reserveAmount = providerRewards.reserveAmount.sub(removedReserveAmount);

        // if the provider doesn't provide any more liqudiity - remove the pools from its list.
        if (providerRewards.reserveAmount == 0) {
            PoolProgram memory program = _programs[poolToken];
            IERC20 reserveToken2 =
                program.reserveTokens[0] == reserveToken ? program.reserveTokens[1] : program.reserveTokens[0];
            if (_providerRewards[provider][poolToken][reserveToken2].reserveAmount == 0) {
                _poolsByProvider[provider].remove(address(poolToken));
            }
        }

        emit ProviderLiquidityRemoved(provider, poolToken, reserveToken, removedReserveAmount);
    }

    /**
     * @dev returns all the LM pools that the provider participates in
     *
     * @param provider the owner of the liquidity
     *
     * @return an array of pools tokens
     */
    function poolsByProvider(address provider) external view override returns (IERC20[] memory) {
        EnumerableSet.AddressSet storage providerPools = _poolsByProvider[provider];

        uint256 length = providerPools.length();
        IERC20[] memory poolTokens = new IERC20[](length);
        for (uint256 i = 0; i < length; ++i) {
            poolTokens[i] = IERC20(providerPools.at(i));
        }

        return poolTokens;
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

        return (data.lastUpdateTime, data.rewardPerToken, data.totalReserveAmount);
    }

    /**
     * @dev updates the reward data of a specific reserve in a specific pool
     *
     * @param poolToken the pool token representing the LM pool
     * @param reserveToken the reserve token in the LM pool
     * @param rewardPerToken the new reward rate per-token
     * @param lastUpdateTime the last upate time
     */
    function updateRewardData(
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 rewardPerToken,
        uint256 lastUpdateTime
    ) external override onlyOwner {
        Rewards storage data = _rewards[poolToken][reserveToken];
        data.rewardPerToken = rewardPerToken;
        data.lastUpdateTime = lastUpdateTime;
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
            uint32,
            uint256
        )
    {
        ProviderRewards memory data = _providerRewards[provider][poolToken][reserveToken];

        return (
            data.rewardPerToken,
            data.pendingBaseRewards,
            data.effectiveStakingTime,
            data.baseRewardsDebt,
            data.baseRewardsDebtMultiplier,
            data.reserveAmount
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
