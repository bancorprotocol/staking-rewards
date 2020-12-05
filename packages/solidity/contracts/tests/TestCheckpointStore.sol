// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "../ICheckpointStore.sol";
import "../Utils.sol";

import "./TestTime.sol";

contract TestCheckpointStore is ICheckpointStore, TestTime, Utils {
    mapping(address => uint256) private data;

    function addCheckpoint(address _address) external override {
        addCheckpoint(_address, time());
    }

    function addPastCheckpoint(address _address, uint256 _time) external override {
        addCheckpoint(_address, _time);
    }

    function addPastCheckpoints(address[] calldata _addresses, uint256[] calldata _times) external override {
        uint256 length = _addresses.length;
        for (uint256 i = 0; i < length; ++i) {
            addCheckpoint(_addresses[i], _times[i]);
        }
    }

    function checkpoint(address _address) external view override returns (uint256) {
        return data[_address];
    }

    function addCheckpoint(address _address, uint256 _time) private {
        data[_address] = _time;
    }
}
