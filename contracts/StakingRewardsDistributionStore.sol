// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";

import "./IStakingRewardsDistributionStore.sol";
import "./Utils.sol";
import "./Time.sol";

contract StakingRewardsDistributionStore is IStakingRewardsDistributionStore, AccessControl, Utils, Time {
    using EnumerableSet for EnumerableSet.UintSet;

    bytes32 public constant ROLE_OWNER = keccak256("ROLE_OWNER");

    mapping(uint256 => Position) private _positions;
    mapping(address => EnumerableSet.UintSet) private _providerPositions;
    mapping(IERC20 => PoolProgram) private _programs;
    mapping(address => uint256) private _lastClaimTimes;

    event PoolProgramAdded(IERC20 indexed poolToken, uint256 startTime, uint256 endTime);
    event PoolProgramUpdated(IERC20 indexed poolToken, uint256 startTime, uint256 endTime);
    event PoolProgramRemoved(IERC20 indexed poolToken);

    event PositionOpened(address indexed provider, IERC20 indexed poolToken, uint256 indexed id, uint256 startTime);
    event PositionUpdated(address indexed provider, IERC20 indexed poolToken, uint256 indexed id, uint256 startTime);
    event PositionClosed(address indexed provider, IERC20 indexed poolToken, uint256 indexed id);

    event LastClaimTimeUpdated(address indexed provider, uint256 claimTime);

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

    function isPoolParticipating(IERC20 poolToken) public view override returns (bool) {
        return isPoolParticipating(_programs[poolToken]);
    }

    function addPoolProgram(
        IERC20 poolToken,
        uint256 startTime,
        uint256 endTime
    ) external override onlyOwner validAddress(address(poolToken)) {
        require(startTime > 0 && startTime < endTime && endTime > time(), "ERR_INVALID_DURATION");

        PoolProgram storage program = _programs[poolToken];
        bool newProgram = isPoolParticipating(program);

        program.startTime = startTime;
        program.endTime = endTime;

        if (newProgram) {
            emit PoolProgramAdded(poolToken, startTime, endTime);
        } else {
            emit PoolProgramUpdated(poolToken, startTime, endTime);
        }
    }

    function removePoolProgram(IERC20 poolToken) external override onlyParticipating(poolToken) onlyOwner {
        require(isPoolParticipating(poolToken), "ERR_POOL_NOT_PARTICIPATING");

        delete _programs[poolToken];
    }

    function poolProgram(IERC20 poolToken)
        external
        view
        override
        onlyParticipating(poolToken)
        returns (uint256, uint256)
    {
        PoolProgram memory program = _programs[poolToken];
        require(isPoolParticipating(program), "ERR_POOL_NOT_PARTICIPATING");

        return (program.startTime, program.endTime);
    }

    function addPositions(
        IERC20 poolToken,
        address[] calldata providers,
        uint256[] calldata ids,
        uint256[] calldata startTimes
    ) external override onlyOwner onlyParticipating(poolToken) {
        uint256 length = providers.length;
        require(length == ids.length && length == startTimes.length, "ERR_INVALID_LENGTH");

        for (uint256 i = 0; i < length; ++i) {
            address provider = providers[i];
            uint256 id = ids[i];
            uint256 startTime = startTimes[i];

            _validAddress(provider);

            Position storage p = _positions[id];
            bool newPosition = p.provider == address(0);

            p.provider = provider;
            p.poolToken = poolToken;
            p.startTime = startTime;

            _providerPositions[provider].add(id);

            if (newPosition) {
                emit PositionOpened(provider, poolToken, id, startTime);
            } else {
                emit PositionUpdated(provider, poolToken, id, startTime);
            }
        }
    }

    function removePositions(uint256[] calldata ids) external override onlyOwner {
        uint256 length = ids.length;
        for (uint256 i = 0; i < length; ++i) {
            uint256 id = ids[i];

            Position memory p = _positions[id];
            require(p.provider != address(0), "ERR_INVALID_ID");

            emit PositionClosed(p.provider, p.poolToken, id);

            delete _positions[id];
        }
    }

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
        Position memory p = _positions[id];
        require(p.provider != address(0), "ERR_INVALID_ID");

        return (p.provider, p.poolToken, p.startTime);
    }

    function providerPositionsCount(address provider) external view override returns (uint256) {
        return _providerPositions[provider].length();
    }

    function providerPositions(address provider) external view override returns (uint256[] memory) {
        EnumerableSet.UintSet storage positions = _providerPositions[provider];
        uint256 length = positions.length();
        uint256[] memory list = new uint256[](length);
        for (uint256 i = 0; i < length; ++i) {
            list[i] = positions.at(i);
        }
        return list;
    }

    function providerPosition(address provider, uint256 index) external view override returns (uint256) {
        return _providerPositions[provider].at(index);
    }

    function updateLastClaimTime(address provider) external override onlyOwner {
        _lastClaimTimes[provider] = time();
    }

    function lastClaimTime(address provider) external view override returns (uint256) {
        return _lastClaimTimes[provider];
    }

    function isPoolParticipating(PoolProgram memory program) private pure returns (bool) {
        return program.endTime > 0;
    }
}
