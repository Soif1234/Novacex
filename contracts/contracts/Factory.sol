// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import "./Forwarder.sol";

contract Factory {
    address public immutable implementation;

    event ForwarderDeployed(address indexed forwarder, bytes32 indexed salt);

    constructor(address _implementation) {
        require(_implementation != address(0), "Invalid implementation");
        implementation = _implementation;
    }

    function deploy(bytes32 salt) public returns (address proxy) {
        bytes memory initCode = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
            bytes20(implementation),
            hex"5af43d82803e903d91602b57fd5bf3"
        );
        assembly {
            proxy := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        require(proxy != address(0), "CREATE2 failed");
        emit ForwarderDeployed(proxy, salt);
    }

    function deployAndSweepETH(bytes32 salt) external returns (address proxy) {
        proxy = predictDeterministicAddress(salt);
        uint32 size;
        assembly { size := extcodesize(proxy) }
        if (size == 0) deploy(salt);
        Forwarder(payable(proxy)).sweepETH();
    }

    function deployAndSweepERC20(bytes32 salt, address token) external returns (address proxy) {
        proxy = predictDeterministicAddress(salt);
        uint32 size;
        assembly { size := extcodesize(proxy) }
        if (size == 0) deploy(salt);
        Forwarder(payable(proxy)).sweepERC20(token);
    }

    function predictDeterministicAddress(bytes32 salt) public view returns (address) {
        bytes memory initCode = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
            bytes20(implementation),
            hex"5af43d82803e903d91602b57fd5bf3"
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(
            hex"ff",
            address(this),
            salt,
            keccak256(initCode)
        )))));
    }
}