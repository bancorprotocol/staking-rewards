// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct PoolProgram {
    uint256 startTime;
    uint256 endTime;
}

struct Position {
    address provider;
    IERC20 poolToken;
    uint256 startTime;
}

interface IStakingRewardsDistributionStore {
    function isPoolParticipating(IERC20 poolToken) external view returns (bool);

    function addPoolProgram(
        IERC20 poolToken,
        uint256 startTime,
        uint256 endTime
    ) external;

    function removePoolProgram(IERC20 poolToken) external;

    function poolProgram(IERC20 poolToken) external view returns (uint256, uint256);

    function addPositions(
        IERC20 poolToken,
        address[] calldata providers,
        uint256[] calldata ids,
        uint256[] calldata startTimes
    ) external;

    function removePositions(uint256[] calldata ids) external;

    function position(uint256 id)
        external
        view
        returns (
            address,
            IERC20,
            uint256
        );

    function positionExists(uint256 id) external view returns (bool);

    function providerPositionsCount(address provider) external view returns (uint256);

    function providerPositions(address provider) external view returns (uint256[] memory);

    function providerPosition(address provider, uint256 index) external view returns (uint256);

    function updateLastClaimTime(address provider) external;

    function lastClaimTime(address provider) external view returns (uint256);
}
