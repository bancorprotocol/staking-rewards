// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct PoolProgram {
    uint256 startTime;
    uint256 endTime;
    uint256 rewardRate;
    IERC20[2] reserveTokens;
}

struct Rewards {
    uint256 lastUpdateTime;
    uint256 rewardPerToken;
    uint256 totalReserveAmount;
}

struct ProviderRewards {
    uint256 rewardPerToken;
    uint256 pendingBaseRewards;
    uint256 reserveAmount;
    uint256 effectiveStakingTime;
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
            IERC20[2] memory,
            uint256,
            uint256,
            uint256
        );

    function addProviderLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount
    ) external;

    function removeProviderLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 removedReserveAmount
    ) external;

    function poolsByProvider(address provider) external view returns (IERC20[] memory);

    function rewards(IERC20 poolToken, IERC20 reserveToken)
        external
        view
        returns (
            uint256,
            uint256,
            uint256
        );

    function updateReward(
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 rewardPerToken,
        uint256 lastUpdateTime
    ) external;

    function providerRewards(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    )
        external
        view
        returns (
            uint256,
            uint256,
            uint256,
            uint256
        );

    function updateProviderRewardPerToken(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 rewardPerToken,
        uint256 pendingBaseRewards
    ) external;

    function updateProviderEffectiveStakingTime(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 effectiveStakingTime,
        uint256 pendingBaseRewards
    ) external;

    function updateProviderLastClaimTime(address provider) external;

    function lastProviderClaimTime(address provider) external view returns (uint256);
}
