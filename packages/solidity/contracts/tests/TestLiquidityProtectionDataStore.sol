// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";

import "../ILiquidityProtectionDataStore.sol";
import "../IStakingRewardsStore.sol";

contract TestLiquidityProtectionDataStore is ILiquidityProtectionDataStore {
    using SafeMath for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;

    IStakingRewardsStore private immutable _store;

    mapping(IERC20 => mapping(IERC20 => uint256)) private _totalAmounrs;
    mapping(address => mapping(IERC20 => mapping(IERC20 => uint256))) private _providerAmounts;
    mapping(address => EnumerableSet.AddressSet) internal _providerPools;

    constructor(IStakingRewardsStore store) public {
        _store = store;
    }

    function totalProtectedReserveAmount(IERC20 poolToken, IERC20 reserveToken)
        external
        view
        override
        returns (uint256)
    {
        return _totalAmounrs[poolToken][reserveToken];
    }

    function providerReserveAmount(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken
    ) external view override returns (uint256) {
        return _providerAmounts[provider][poolToken][reserveToken];
    }

    function providerPools(address provider) external view override returns (IERC20[] memory) {
        EnumerableSet.AddressSet storage pools = _providerPools[provider];

        uint256 length = pools.length();
        IERC20[] memory poolTokens = new IERC20[](length);
        for (uint256 i = 0; i < length; ++i) {
            poolTokens[i] = IERC20(pools.at(i));
        }

        return poolTokens;
    }

    function addLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount
    ) external {
        _totalAmounrs[poolToken][reserveToken] = _totalAmounrs[poolToken][reserveToken].add(reserveAmount);

        uint256 prevProviderAmount = _providerAmounts[provider][poolToken][reserveToken];
        if (prevProviderAmount == 0) {
            _providerPools[provider].add(address(poolToken));
        }

        // update provider's reserve amount
        _providerAmounts[provider][poolToken][reserveToken] = prevProviderAmount.add(reserveAmount);
    }

    function removeLiquidity(
        address provider,
        IERC20 poolToken,
        IERC20 reserveToken,
        uint256 removedReserveAmount,
        bool removePool
    ) external {
        _totalAmounrs[poolToken][reserveToken] = _totalAmounrs[poolToken][reserveToken].sub(removedReserveAmount);

        _providerAmounts[provider][poolToken][reserveToken] = _providerAmounts[provider][poolToken][reserveToken].sub(
            removedReserveAmount
        );

        // if the provider doesn't provide any more liqudiity - remove the pools from its list.
        if (removePool && _providerAmounts[provider][poolToken][reserveToken] == 0) {
            PoolProgram memory program = poolProgram(poolToken);
            IERC20 reserveToken2 =
                program.reserveTokens[0] == reserveToken ? program.reserveTokens[1] : program.reserveTokens[0];
            if (_providerAmounts[provider][poolToken][reserveToken2] == 0) {
                _providerPools[provider].remove(address(poolToken));
            }
        }
    }

    function poolProgram(IERC20 poolToken) internal view returns (PoolProgram memory) {
        PoolProgram memory program;
        (program.startTime, program.endTime, program.rewardRate, program.reserveTokens, program.rewardShares) = _store
            .poolProgram(poolToken);

        return program;
    }
}
