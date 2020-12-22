// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.6.12;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "./IStakingRewardsSettings.sol";

import "./Time.sol";
import "./Utils.sol";

/**
 * @dev Staking Rewaeds Settings contract
 */
contract StakingRewardsSettings is IStakingRewardsSettings, AccessControl, Time, Utils {
    struct PoolRewards {
        uint256 startTime;
        uint256 endTime;
        uint256 weeklyRewards;
    }

    // the owner role is used to set the values in the store
    bytes32 public constant ROLE_OWNER = keccak256("ROLE_OWNER");

    // the whitelist admin role is responsible for managing pools whitelist
    bytes32 public constant ROLE_WHITELIST_ADMIN = keccak256("ROLE_WHITELIST_ADMIN");

    uint32 private constant PPM_RESOLUTION = 1000000;

    IERC20 public immutable networkToken;

    // list of whitelisted pools and their rewards data
    mapping(IERC20 => PoolRewards) private participatingPoolsRewards;
    EnumerableSet.AddressSet private _participatingPools;

    /**
     * @dev triggered when a pool is added to the whitelist
     *
     * @param _poolToken pool token
     * @param _startTime the start of the rewards program
     * @param _endTime the end of the rewards program
     * @param _weeklyRewards program's weekly rewards
     */
    event PoolRewardsWhitelistAdded(
        IERC20 indexed _poolToken,
        uint256 _startTime,
        uint256 _endTime,
        uint256 _weeklyRewards
    );

    /**
     * @dev triggered when a pool is removed from the whitelist
     *
     * @param _poolToken pool token
     */
    event PoolRewardsWhitelistRemoved(IERC20 indexed _poolToken);

    /**
     * @dev initializes a new StakingRewardsSettings contract
     *
     * @param _networkToken the network token
     */
    constructor(IERC20 _networkToken) public validExternalAddress(address(_networkToken)) {
        // Set up administrative roles.
        _setRoleAdmin(ROLE_OWNER, ROLE_OWNER);
        _setRoleAdmin(ROLE_WHITELIST_ADMIN, ROLE_OWNER);

        // Allow the deployer to initially control the contract.
        _setupRole(ROLE_OWNER, _msgSender());

        networkToken = _networkToken;
    }

    modifier onlyOwner() {
        _onlyOwner();

        _;
    }

    // error message binary size optimization
    function _onlyOwner() internal view {
        require(hasRole(ROLE_OWNER, msg.sender), "ERR_ACCESS_DENIED");
    }

    modifier onlyWhitelistAdmin() {
        _onlyWhitelistAdmin();
        _;
    }

    // error message binary size optimization
    function _onlyWhitelistAdmin() internal view {
        require(hasRole(ROLE_WHITELIST_ADMIN, msg.sender), "ERR_ACCESS_DENIED");
    }

    /**
     * @dev adds a pool to the whitelist
     *
     * @param _poolToken pool token
     * @param _startTime the start of the rewards program
     * @param _endTime the end of the rewards program
     * @param _weeklyRewards program's weekly rewards
     */
    function addPoolToRewardsWhitelist(
        IERC20 _poolToken,
        uint256 _startTime,
        uint256 _endTime,
        uint256 _weeklyRewards
    ) external override onlyWhitelistAdmin validExternalAddress(address(_poolToken)) {
        require(_participatingPools.add(address(_poolToken)), "ERR_POOL_ALREADY_WHITELISTED");

        updatePoolRewards(_poolToken, _startTime, _endTime, _weeklyRewards);

        emit PoolRewardsWhitelistAdded(_poolToken, _startTime, _endTime, _weeklyRewards);
    }

    /**
     * @dev removes a pool from the whitelist
     *
     * @param _poolToken pool token
     */
    function removePoolFromRewardsWhitelist(IERC20 _poolToken)
        external
        override
        onlyWhitelistAdmin
        validExternalAddress(address(_poolToken))
    {
        require(_participatingPools.remove(address(_poolToken)), "ERR_POOL_NOT_WHITELISTED");
        delete participatingPoolsRewards[_poolToken];

        emit PoolRewardsWhitelistRemoved(_poolToken);
    }

    /**
     * @dev returns whitelisted pool's rewards data
     *
     * @param _poolToken pool token
     * @return rewards data
     */
    function poolRewards(IERC20 _poolToken)
        external
        view
        override
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        PoolRewards memory pool = participatingPoolsRewards[_poolToken];

        return (pool.startTime, pool.endTime, pool.weeklyRewards);
    }

    /**
     * @dev returns pools whitelist
     *
     * @return pools whitelist
     */
    function participatingPools() external view returns (address[] memory) {
        uint256 length = _participatingPools.length();
        address[] memory list = new address[](length);
        for (uint256 i = 0; i < length; ++i) {
            list[i] = _participatingPools.at(i);
        }
        return list;
    }

    /**
     * @dev adds/updates a pool in the whitelist
     *
     * @param _poolToken pool token
     * @param _startTime the start of the rewards program
     * @param _endTime the end of the rewards program
     * @param _weeklyRewards program's weekly rewards
     */
    function updatePoolRewards(
        IERC20 _poolToken,
        uint256 _startTime,
        uint256 _endTime,
        uint256 _weeklyRewards
    ) private {
        require(_startTime > 0 && _startTime < _endTime && _endTime > time(), "ERR_INVALID_DURATION");
        require(_weeklyRewards > 0, "ERR_INVALID_WEEKLY_REWARDS");

        PoolRewards storage pool = participatingPoolsRewards[_poolToken];
        pool.startTime = _startTime;
        pool.endTime = _endTime;
        pool.weeklyRewards = _weeklyRewards;
    }

    /**
     * @dev returns whether a pool is whitelisted
     *
     * @param _poolToken pool token
     * @return whether a pool is whitelisted
     */
    function isPoolWhitelisted(IERC20 _poolToken) external view override returns (bool) {
        return _participatingPools.contains(address(_poolToken));
    }
}
