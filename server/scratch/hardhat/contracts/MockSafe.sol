// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract MockSafe {
    address[] public owners;
    uint256 public threshold;

    constructor(address _owner, uint256 _threshold) {
        owners.push(_owner);
        threshold = _threshold;
    }

    function getOwners() public view returns (address[] memory) {
        return owners;
    }

    function getThreshold() public view returns (uint256) {
        return threshold;
    }
}
