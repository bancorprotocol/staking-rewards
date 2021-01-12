// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@bancor/contracts/solidity/contracts/liquidity-protection/LiquidityProtection.sol";
import "@bancor/contracts/solidity/contracts/liquidity-protection/LiquidityProtectionSettings.sol";
import "@bancor/contracts/solidity/contracts/liquidity-protection/LiquidityProtectionStore.sol";
import "@bancor/contracts/solidity/contracts/liquidity-protection/LiquidityProtectionStats.sol";
import "@bancor/contracts/solidity/contracts/utility/ContractRegistry.sol";
import "@bancor/contracts/solidity/contracts/converter/ConverterBase.sol";
import "@bancor/contracts/solidity/contracts/converter/ConverterRegistryData.sol";
import "@bancor/contracts/solidity/contracts/converter/ConverterFactory.sol";
import "@bancor/contracts/solidity/contracts/converter/types/standard-pool/StandardPoolConverterFactory.sol";
import "@bancor/contracts/solidity/contracts/helpers/TestCheckpointStore.sol";
import "@bancor/contracts/solidity/contracts/helpers/TestConverterRegistry.sol";

import "./TestStakingRewards.sol";

contract TestLiquidityProtection is LiquidityProtection, TestTime {
    using SafeERC20 for IERC20;

    uint256 private _lastId;
    TestStakingRewards private immutable _stakingRewards;
    TestCheckpointStore private immutable _lastRemoveCheckpointStore;

    constructor(
        TestStakingRewards stakingRewards,
        LiquidityProtectionSettings settings,
        LiquidityProtectionStore store,
        LiquidityProtectionStats stats,
        ITokenGovernance networkTokenGovernance,
        ITokenGovernance govTokenGovernance,
        TestCheckpointStore lastRemoveCheckpointStore
    )
        public
        LiquidityProtection(
            settings,
            store,
            stats,
            networkTokenGovernance,
            govTokenGovernance,
            lastRemoveCheckpointStore
        )
    {
        _stakingRewards = stakingRewards;
        _lastRemoveCheckpointStore = lastRemoveCheckpointStore;
    }

    function time() internal view override(Time, TestTime) returns (uint256) {
        return TestTime.time();
    }

    function addProviderLiquidity(
        address provider,
        IConverterAnchor poolAnchor,
        IERC20Token reserveToken,
        uint256 reserveAmount
    ) public returns (uint256) {
        _stakingRewards.setTime(time());

        reserveToken.transferFrom(provider, address(this), reserveAmount);
        IERC20(address(reserveToken)).safeApprove(address(this), reserveAmount);

        _lastId = this.addLiquidityFor(provider, poolAnchor, reserveToken, reserveAmount);
        return _lastId;
    }

    function addLiquidityAt(
        address provider,
        IConverterAnchor poolAnchor,
        IERC20Token reserveToken,
        uint256 reserveAmount,
        uint256 timestamp
    ) public payable returns (uint256) {
        setTime(timestamp);

        return addProviderLiquidity(provider, poolAnchor, reserveToken, reserveAmount);
    }

    function removeProviderLiquidity(
        address payable provider,
        uint256 id,
        uint32 portion
    ) public payable {
        _stakingRewards.setTime(time());
        _lastRemoveCheckpointStore.setTime(time());

        ProtectedLiquidity memory liquidity = protectedLiquidity(id, provider);

        uint256 reserveAmount;
        if (portion == PPM_RESOLUTION) {
            reserveAmount = liquidity.reserveAmount;
        } else {
            reserveAmount = liquidity.reserveAmount.mul(portion) / PPM_RESOLUTION;
        }

        removeLiquidity(provider, id, portion);
    }

    function removeLiquidityAt(
        address payable provider,
        uint256 id,
        uint32 portion,
        uint256 timestamp
    ) public payable {
        setTime(timestamp);

        removeProviderLiquidity(provider, id, portion);
    }

    function lastId() public view returns (uint256) {
        return _lastId;
    }
}
