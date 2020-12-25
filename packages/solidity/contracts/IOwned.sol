// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

/*
    Owned contract interface
*/
interface IOwned {
    function owner() external view returns (address);
}
