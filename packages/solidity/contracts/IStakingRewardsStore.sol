// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct PoolProgram {
    uint256 startTime;
    uint256 endTime;
    uint256 rewardRate;
    IERC20[2] reserveTokens;
    uint32[2] rewardShares;
}

struct PoolRewards {
    uint256 lastUpdateTime;
    uint256 rewardPerToken;
    uint256 totalClaimedRewards;
}

struct ProviderRewards {
    uint256 rewardPerToken;
    uint256 pendingBaseRewards;
    uint256 totalClaimedRewards;
    uint256 effectiveStakingTime;
    uint256 baseRewardsDebt;
    uint32 baseRewardsDebtMultiplier;
}

interface IStakingRewardsStore {
    function isPoolParticipating(IERC20 poolToken) external view returns (bool);

    function isReserveParticipating(IERC20 poolToken, IERC20 reserveToken) external view returns (bool);

    function addPoolProgram(
        IERC20 poolToken,
        IERC20[2] calldata reserveTokens,
        uint32[2] calldata rewardShares,
        uint256 endTime,
        uint256 rewardRate
    ) external;

    function removePoolProgram(IERC20 poolToken) external;

    function extendPoolProgram(IERC20 poolToken, uint256 newEndTime) external;

    function poolProgram(IERC20 poolToken)
        external
        view
        returns (
            uint256,
            uint256,
            uint256,
            IERC20[2] memory,
            uint32[2] memory
        );

    function poolPrograms()
        external
        view
        returns (
            IERC20[] memory,
            uint256[] memory,
            uint256[] memory,
            uint256[] memory,
            IERC20[2][] memory,
            uint32[2][] memory
        );

    function poolRewards(IERC20 poolToken, IERC20 reserveToken)
        external
        view
        returns (
            uint256,
            uint256,
            uint256
        );

    function updatePoolRewardsData(
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 lastUpdateTime,
        uint256 rewardPerToken,
        uint256 totalClaimedRewards
    ) external;

    function providerRewards(
        IERC20 poolToken,
        IERC20 reserveToken,
        address provider
    )
        external
        view
        returns (
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint32
        );

    function updateProviderRewardsData(
        IERC20 poolToken,
        IERC20 reserveToken,
        address provider,
        uint256 rewardPerToken,
        uint256 pendingBaseRewards,
        uint256 totalClaimedRewards,
        uint256 effectiveStakingTime,
        uint256 baseRewardsDebt,
        uint32 baseRewardsDebtMultiplier
    ) external;

    function updateProviderLastClaimTime(address provider) external;

    function providerLastClaimTime(address provider) external view returns (uint256);
}
