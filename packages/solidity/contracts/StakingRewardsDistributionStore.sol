// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";

import "./IStakingRewardsDistributionStore.sol";
import "./Utils.sol";
import "./Time.sol";

/**
 * @dev This contract stores staking rewards position and pool specific data.
 */
contract StakingRewardsDistributionStore is IStakingRewardsDistributionStore, AccessControl, Utils, Time {
    using EnumerableSet for EnumerableSet.UintSet;

    // the owner role is used to set the values in the store
    bytes32 public constant ROLE_OWNER = keccak256("ROLE_OWNER");

    // the mapping between pool tokens and their respective LM program information
    mapping(IERC20 => PoolProgram) private _programs;

    // the mapping between position IDs and data
    mapping(uint256 => Position) private _positions;

    // the mapping between providers and their respective position IDs
    mapping(address => EnumerableSet.UintSet) private _providerPositions;

    // the mapping between providers and their respective last claim times
    mapping(address => uint256) private _lastClaimTimes;

    /**
     * @dev triggered when a pool program is being added
     *
     * @param poolToken the pool token representing the LM pool
     * @param startTime the starting time of the program
     * @param endTime the ending time of the program
     * @param weeklyRewards the program's weekly rewards
     */
    event PoolProgramAdded(IERC20 indexed poolToken, uint256 startTime, uint256 endTime, uint256 weeklyRewards);

    /**
     * @dev triggered when a pool program is being updated
     *
     * @param poolToken the pool token representing the LM pool
     * @param startTime the starting time of the program
     * @param endTime the ending time of the program
     * @param weeklyRewards the program's weekly rewards
     */
    event PoolProgramUpdated(IERC20 indexed poolToken, uint256 startTime, uint256 endTime, uint256 weeklyRewards);

    /**
     * @dev triggered when a pool program is being removed
     *
     * @param poolToken the pool token representing the LM pool
     */
    event PoolProgramRemoved(IERC20 indexed poolToken);

    /**
     * @dev triggered when a position is being opened
     *
     * @param poolToken the pool token representing the LM pool
     * @param provider the owner of the position
     * @param id the ID of the position
     * @param startTime the creation time of the position
     */
    event PositionOpened(IERC20 indexed poolToken, address indexed provider, uint256 indexed id, uint256 startTime);

    /**
     * @dev triggered when a position is being updated
     *
     * @param poolToken the pool token representing the LM pool
     * @param provider the owner of the position
     * @param id the ID of the position
     * @param startTime the creation time of the position
     */
    event PositionUpdated(IERC20 indexed poolToken, address indexed provider, uint256 indexed id, uint256 startTime);

    /**
     * @dev triggered when a position is being closed
     *
     * @param poolToken the pool token representing the LM pool
     * @param provider the owner of the position
     * @param id the ID of the position
     */
    event PositionClosed(IERC20 indexed poolToken, address indexed provider, uint256 indexed id);

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
     * @param weeklyRewards the program's weekly rewards
     */
    function addPoolProgram(
        IERC20 poolToken,
        uint256 startTime,
        uint256 endTime,
        uint256 weeklyRewards
    ) external override onlyOwner validAddress(address(poolToken)) {
        require(startTime > 0 && startTime < endTime && endTime > time(), "ERR_INVALID_DURATION");
        require(weeklyRewards > 0, "ERR_ZERO_VALUE");

        PoolProgram storage program = _programs[poolToken];
        bool newProgram = !isPoolParticipating(program);

        program.startTime = startTime;
        program.endTime = endTime;
        program.weeklyRewards = weeklyRewards;

        if (newProgram) {
            emit PoolProgramAdded(poolToken, startTime, endTime, weeklyRewards);
        } else {
            emit PoolProgramUpdated(poolToken, startTime, endTime, weeklyRewards);
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
            uint256,
            uint256,
            uint256
        )
    {
        PoolProgram memory program = _programs[poolToken];
        require(isPoolParticipating(program), "ERR_POOL_NOT_PARTICIPATING");

        return (program.startTime, program.endTime, program.weeklyRewards);
    }

    /**
     * @dev adds or updates a list of positions
     *
     * @param poolToken the pool token representing the LM pool
     * @param providers owners of the positions
     * @param ids IDs of the positions
     * @param startTimes creation times of the positions
     */
    function addPositions(
        IERC20 poolToken,
        address[] calldata providers,
        uint256[] calldata ids,
        uint256[] calldata startTimes
    ) external override onlyOwner onlyParticipating(poolToken) {
        uint256 length = providers.length;
        require(length == ids.length && length == startTimes.length, "ERR_INVALID_LENGTH");

        for (uint256 i = 0; i < length; ++i) {
            addPosition(poolToken, providers[i], ids[i], startTimes[i]);
        }
    }

    /**
     * @dev adds or updates a position
     *
     * @param poolToken the pool token representing the LM pool
     * @param provider the owner of the position
     * @param id the ID of the position
     * @param startTime the creation time of the position
     */
    function addPosition(
        IERC20 poolToken,
        address provider,
        uint256 id,
        uint256 startTime
    ) private {
        _validAddress(provider);
        require(startTime <= time(), "ERR_INVALID_DURATION");

        Position storage pos = _positions[id];
        address positionProvider = pos.provider;
        bool newPosition = positionProvider == address(0);
        require(newPosition || positionProvider == provider, "ERR_ID_ALREADY_EXISTS");

        pos.provider = provider;
        pos.poolToken = poolToken;
        pos.startTime = startTime;

        _providerPositions[provider].add(id);

        if (newPosition) {
            emit PositionOpened(poolToken, provider, id, startTime);
        } else {
            emit PositionUpdated(poolToken, provider, id, startTime);
        }
    }

    /**
     * @dev removes positions
     *
     * @param ids IDs of the positions
     */
    function removePositions(uint256[] calldata ids) external override onlyOwner {
        uint256 length = ids.length;
        for (uint256 i = 0; i < length; ++i) {
            uint256 id = ids[i];

            Position memory p = _positions[id];
            require(p.provider != address(0), "ERR_INVALID_ID");

            _providerPositions[p.provider].remove(id);

            emit PositionClosed(p.poolToken, p.provider, id);

            delete _positions[id];
        }
    }

    /**
     * @dev returns a position
     *
     * @param id the ID of the position
     *
     * @return the position data
     */
    function position(uint256 id)
        external
        view
        override
        returns (
            address,
            IERC20,
            uint256
        )
    {
        Position memory pos = _positions[id];
        require(positionExists(pos), "ERR_INVALID_ID");

        return (pos.provider, pos.poolToken, pos.startTime);
    }

    /**
     * @dev returns whether a position exists
     *
     * @param id the ID of the position
     *
     * @return whether a position exists
     */
    function positionExists(uint256 id) external view override returns (bool) {
        return positionExists(_positions[id]);
    }

    /**
     * @dev returns whether a position exists
     *
     * @param pos the position data
     *
     * @return whether a position exists
     */
    function positionExists(Position memory pos) private pure returns (bool) {
        return pos.provider != address(0);
    }

    /**
     * @dev returns the total number of provider's positions
     *
     * @param provider the owner of the position
     *
     * @return the total number of provider's positions
     */
    function providerPositionsCount(address provider) external view override returns (uint256) {
        return _providerPositions[provider].length();
    }

    /**
     * @dev returns the all provider's positions
     *
     * @param provider the owner of the position
     *
     * @return the all provider's positions
     */
    function providerPositions(address provider) external view override returns (uint256[] memory) {
        EnumerableSet.UintSet storage positions = _providerPositions[provider];
        uint256 length = positions.length();
        uint256[] memory list = new uint256[](length);
        for (uint256 i = 0; i < length; ++i) {
            list[i] = positions.at(i);
        }
        return list;
    }

    /**
     * @dev returns the a specific provider's position
     *
     * @param provider the owner of the position
     * @param index the index of the position to return
     *
     * @return the position at the specified index
     */
    function providerPosition(address provider, uint256 index) external view override returns (uint256) {
        return _providerPositions[provider].at(index);
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
