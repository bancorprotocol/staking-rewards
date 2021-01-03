// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.6.12;

import "@bancor/contracts/solidity/contracts/utility/ContractRegistry.sol";
import "@bancor/contracts/solidity/contracts/converter/ConverterBase.sol";
import "@bancor/contracts/solidity/contracts/converter/ConverterRegistry.sol";
import "@bancor/contracts/solidity/contracts/converter/ConverterRegistryData.sol";
import "@bancor/contracts/solidity/contracts/converter/ConverterFactory.sol";
import "@bancor/contracts/solidity/contracts/converter/types/standard-pool/StandardPoolConverterFactory.sol";

contract TestConverterRegistry is ConverterRegistry {
    IConverter private _createdConverter;
    bool private _typeChangingEnabled = true;

    constructor(IContractRegistry registry) public ConverterRegistry(registry) {}

    function newConverter(
        uint16 converterType,
        string memory name,
        string memory symbol,
        uint8 decimals,
        uint32 maxConversionFee,
        IERC20Token[] memory reserveTokens,
        uint32[] memory reserveWeights
    ) public override returns (IConverter) {
        _createdConverter = super.newConverter(
            converterType,
            name,
            symbol,
            decimals,
            maxConversionFee,
            reserveTokens,
            reserveWeights
        );

        return _createdConverter;
    }

    function isStandardPool(uint32[] memory reserveWeights) internal view override returns (bool) {
        return _typeChangingEnabled && super.isStandardPool(reserveWeights);
    }

    function enableTypeChanging(bool state) external {
        _typeChangingEnabled = state;
    }

    function createdConverter() external view returns (IConverter) {
        return _createdConverter;
    }
}
