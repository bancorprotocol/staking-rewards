// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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

contract TestLiquidityProtectionSimulator is LiquidityProtection, TestTime {
    using SafeERC20 for IERC20;

    TestStakingRewards private immutable _stakingRewards;

    constructor(TestStakingRewards stakingRewards, address[8] memory contractAddresses)
        public
        LiquidityProtection(contractAddresses)
    {
        _stakingRewards = stakingRewards;
    }

    function time() internal view override(Time, TestTime) returns (uint256) {
        return TestTime.time();
    }

    function simulateAddLiquidity(
        address provider,
        IConverterAnchor poolAnchor,
        IERC20 reserveToken,
        uint256 reserveAmount,
        uint256 timestamp
    ) public returns (uint256) {
        setTime(timestamp);

        _stakingRewards.setTime(time());
        _stakingRewards.setStoreTime(time());

        _stakingRewards.onAddingLiquidity(provider, poolAnchor, reserveToken, 0, reserveAmount);

        stats.increaseTotalAmounts(provider, IDSToken(address(poolAnchor)), reserveToken, 0, reserveAmount);
        stats.addProviderPool(provider, IDSToken(address(poolAnchor)));
    }

    function simulateRemoveLiquidity(
        address provider,
        IConverterAnchor poolAnchor,
        IERC20 reserveToken,
        uint256 reserveAmount,
        uint256 timestamp
    ) public payable {
        setTime(timestamp);

        _stakingRewards.setTime(time());
        _stakingRewards.setStoreTime(time());

        _stakingRewards.onRemovingLiquidity(0, provider, poolAnchor, reserveToken, 0, reserveAmount);

        TestCheckpointStore(address(lastRemoveCheckpointStore)).setTime(time());
        TestCheckpointStore(address(lastRemoveCheckpointStore)).addCheckpoint(provider);

        stats.decreaseTotalAmounts(provider, IDSToken(address(poolAnchor)), reserveToken, 0, reserveAmount);
    }
}
