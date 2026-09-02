// SPDX-License-Identifier: MIT
// TEST-ONLY minimal Safe stand-in (Phase 10.4 unfreeze audit).
// Exposes exactly the Gnosis Safe view surface that SafeVerificationService
// verifies: getOwners() and getThreshold(). Holds ETH/ERC20 like the real
// Safe would, so treasury monitor tests can exercise on-chain verification
// and reorg paths against a local disposable EVM. NEVER deploy outside tests.
pragma solidity ^0.8.19;

contract MockSafe {
    address[] private owners;
    uint256 private threshold;

    constructor(address _owner) {
        owners.push(_owner);
        threshold = 1;
    }

    function getOwners() public view returns (address[] memory) {
        return owners;
    }

    function getThreshold() public view returns (uint256) {
        return threshold;
    }

    receive() external payable {}
}
