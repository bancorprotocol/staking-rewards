// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IStakingRewardsSettings {
    function addPoolToRewardsWhitelist(
        IERC20 _poolToken,
        uint256 _startTime,
        uint256 _endTime,
        uint256 _weeklyRewards
    ) external;

    function removePoolFromRewardsWhitelist(IERC20 _poolToken) external;

    function isPoolWhitelisted(IERC20 _poolToken) external view returns (bool);

    function poolRewards(IERC20 _poolToken)
        external
        view
        returns (
            uint256,
            uint256,
            uint256
        );
}
