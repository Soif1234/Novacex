# Manual Forwarder Sweep Runbook

## Overview
Because automatic sweeping (`SweepWorker`) is disabled in Manual Safe mode to prevent exposing server-side signing keys, forwarder deposits will securely accumulate on-chain in the individual deposit forwarder contracts. Operations teams must manually execute the sweep.

## Prerequisites
- A Web3 provider like MetaMask connected to the correct network.
- Sufficient native gas tokens (e.g. ETH) in the executing operator wallet to fund the transaction.

## Procedure

**1. Identify Forwarder**
Locate the user's assigned forwarder contract address (e.g. from the admin dashboard or database `deposit_addresses` table).

**2. Verify Network**
Ensure your MetaMask wallet is connected to the exact network (e.g. Ethereum Mainnet `ChainID: 1`).

**3. Verify HOT_WALLET Immutable Destination (CRITICAL)**
*NO ARBITRARY DESTINATION IS PERMITTED.*
Read the `HOT_WALLET` state variable from the forwarder contract on Etherscan or via RPC.
Verify that the `HOT_WALLET` explicitly matches the `CUSTODY_HOT_WALLET_ADDRESS` used by the exchange. If it does not match, **ABORT IMMEDIATELY**.

**4. Verify Asset**
Confirm the asset (Native ETH or specific ERC20 token address) that has accumulated in the forwarder.

**5. Read Current Balance**
Check the current balance of the forwarder contract for the identified asset to verify there is a non-zero balance to sweep.

**6. Construct Sweep Call**
Prepare to execute the `flush(address token)` function on the forwarder contract.
- If sweeping native ETH, pass the zero address or the specific constant used by the contract (often `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`).
- If sweeping an ERC20 token, pass the exact token contract address.

**7. Operator Signs with MetaMask**
Submit the `flush` transaction. The transaction requires gas but does not require special administrative privileges, as the forwarder contract hardcodes the destination to the immutable `HOT_WALLET`.

**8. Broadcast**
Wait for the transaction to be broadcasted to the mempool.

**9. Record tx_hash**
Document the resulting transaction hash.

**10. Backend Reconciliation**
The exchange backend `BlockchainMonitorWorker` will eventually detect the transfer into the `CUSTODY_HOT_WALLET_ADDRESS` and attribute it accordingly.

**11. Confirmation Depth**
Wait for standard confirmation depth (e.g., 12 blocks for Ethereum) before considering the funds securely swept.

**12. Failure/Reorg Handling**
If the transaction reverts (e.g., out of gas) or is reorged out of the chain, the funds remain safely in the forwarder contract. Repeat the procedure from Step 5 with higher gas settings if necessary.
