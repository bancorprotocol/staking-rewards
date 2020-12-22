// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct PoolProgram {
    uint256 startTime;
    uint256 endTime;
    uint256 rewardRate;
}

struct Position {
    address provider;
    IERC20 poolToken;
    uint256 startTime;
}

interface IStakingRewardsStore {
    function isPoolParticipating(IERC20 poolToken) external view returns (bool);

    function addPoolProgram(
        IERC20 poolToken,
        uint256 startTime,
        uint256 endTime,
        uint256 rewardRate
    ) external;

    function removePoolProgram(IERC20 poolToken) external;

    function poolProgram(IERC20 poolToken)
        external
        view
        returns (
            uint256,
            uint256,
            uint256
        );

    function updateLastClaimTime(address provider) external;

    function lastClaimTime(address provider) external view returns (uint256);
}
