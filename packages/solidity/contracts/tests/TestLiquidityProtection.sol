// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@bancor/contracts-solidity/solidity/contracts/liquidity-protection/LiquidityProtection.sol";
import "@bancor/contracts-solidity/solidity/contracts/liquidity-protection/LiquidityProtectionSettings.sol";
import "@bancor/contracts-solidity/solidity/contracts/liquidity-protection/LiquidityProtectionStore.sol";
import "@bancor/contracts-solidity/solidity/contracts/liquidity-protection/LiquidityProtectionStats.sol";
import "@bancor/contracts-solidity/solidity/contracts/liquidity-protection/LiquidityProtectionSystemStore.sol";
import "@bancor/contracts-solidity/solidity/contracts/utility/ContractRegistry.sol";
import "@bancor/contracts-solidity/solidity/contracts/converter/ConverterBase.sol";
import "@bancor/contracts-solidity/solidity/contracts/converter/ConverterRegistryData.sol";
import "@bancor/contracts-solidity/solidity/contracts/converter/ConverterFactory.sol";
import "@bancor/contracts-solidity/solidity/contracts/converter/types/standard-pool/StandardPoolConverterFactory.sol";

import "./TestCheckpointStore.sol";
import "./TestStakingRewards.sol";

contract TestLiquidityProtection is LiquidityProtection, TestTime {
    using SafeERC20 for IERC20;

    uint256 private _lastId;
    TestStakingRewards private immutable _stakingRewards;
    TestCheckpointStore private immutable _lastRemoveCheckpointStore;

    constructor(TestStakingRewards stakingRewards, address[8] memory contractAddresses)
        public
        LiquidityProtection(contractAddresses)
    {
        _stakingRewards = stakingRewards;
        _lastRemoveCheckpointStore = TestCheckpointStore(contractAddresses[7]);
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

    function lastId() public view returns (uint256) {
        return _lastId;
    }
}
