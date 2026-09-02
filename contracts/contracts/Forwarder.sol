// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title Forwarder
 * @notice Immutable minimal proxy implementation for sweeping deposits to the KMS Hot Wallet.
 * @dev Designed to be used behind an EIP-1167 minimal proxy.
 */
contract Forwarder {
    address public immutable HOT_WALLET;

    /**
     * @param _hotWallet The immutable destination address for all sweeps.
     */
    constructor(address _hotWallet) {
        require(_hotWallet != address(0), "Invalid hot wallet");
        HOT_WALLET = _hotWallet;
    }

    /**
     * @notice Allows the contract to receive ETH.
     */
    receive() external payable {}

    /**
     * @notice Sweeps the entire native ETH balance to the HOT_WALLET.
     */
    function sweepETH() external {
        uint256 balance = address(this).balance;
        require(balance > 0, "Zero balance");

        (bool success, ) = HOT_WALLET.call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    /**
     * @notice Sweeps the entire balance of the given ERC20 token to the HOT_WALLET.
     * @param token The address of the ERC20 token to sweep.
     */
    function sweepERC20(address token) external {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "Zero token balance");

        // Use low-level call to handle both standard and non-standard ERC20s (e.g., missing return value)
        // SafeERC20 logic simplified for sweep-only operation.
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, HOT_WALLET, balance)
        );

        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            "ERC20 transfer failed"
        );
    }
}
