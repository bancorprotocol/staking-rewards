// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.6.12;

import "@bancor/contracts-solidity/solidity/contracts/utility/CheckpointStore.sol";
import "./TestTime.sol";

contract TestCheckpointStore is CheckpointStore, TestTime {
    function time() internal view virtual override(Time, TestTime) returns (uint256) {
        return TestTime.time();
    }
}
