// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/access/AccessControl.sol";

import "./IStakingRewardsStore.sol";
import "./IOwned.sol";
import "./IConverter.sol";
import "./Utils.sol";
import "./Time.sol";

/**
 * @dev This contract stores staking rewards position and pool specific data.
 */
contract StakingRewardsStore is IStakingRewardsStore, AccessControl, Utils, Time {
    // the owner role is used to set the values in the store
    bytes32 public constant ROLE_OWNER = keccak256("ROLE_OWNER");

    // the mapping between pool tokens and their respective LM program information
    mapping(IERC20 => PoolProgram) private _programs;

    // the mapping between providers and their respective last claim times
    mapping(address => uint256) private _lastClaimTimes;

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
     * @dev triggered when provider's last claim time is being updated
     *
     * @param provider the owner of the position
     * @param claimTime the time of the last claim
     */
    event LastClaimTimeUpdated(address indexed provider, uint256 claimTime);

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

    modifier onlyParticipating(IERC20 poolToken) {
        _onlyParticipating(poolToken);
        _;
    }

    function _onlyParticipating(IERC20 poolToken) internal view {
        require(isPoolParticipating(poolToken), "ERR_POOL_NOT_PARTICIPATING");
    }

    /**
     * @dev returns whether the specified pool participates in the LM program
     *
     * @param poolToken the pool token representing the LM pool
     * @return whether the specified pool participates in the LM program
     */
    function isPoolParticipating(IERC20 poolToken) public view override returns (bool) {
        return isPoolParticipating(_programs[poolToken]);
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
    function removePoolProgram(IERC20 poolToken) external override onlyParticipating(poolToken) onlyOwner {
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
        onlyParticipating(poolToken)
        returns (
            IERC20[2] memory,
            uint256,
            uint256,
            uint256
        )
    {
        PoolProgram memory program = _programs[poolToken];
        require(isPoolParticipating(program), "ERR_POOL_NOT_PARTICIPATING");

        return (program.reserveTokens, program.startTime, program.endTime, program.rewardRate);
    }

    /**
     * @dev updates provider's last claim time
     *
     * @param provider the owner of the position
     */
    function updateLastClaimTime(address provider) external override onlyOwner {
        uint256 time = time();
        _lastClaimTimes[provider] = time;

        emit LastClaimTimeUpdated(provider, time);
    }

    /**
     * @dev returns provider's last claim time
     *
     * @param provider the owner of the position
     *
     * @return provider's last claim time
     */
    function lastClaimTime(address provider) external view override returns (uint256) {
        return _lastClaimTimes[provider];
    }
}
