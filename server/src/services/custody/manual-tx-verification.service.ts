/**
 * Phase 11K — Manual Safe Mode: On-Chain Transaction Verification
 *
 * This service verifies that a REAL blockchain transaction matches an
 * authorized backend intent BEFORE the intent is marked SUBMITTED/CONFIRMED.
 *
 * Core principle: the backend NEVER signs, NEVER broadcasts, NEVER holds a
 * private key, and NEVER allocates an outbound Ethereum nonce. Execution is
 * performed by a HUMAN (Safe 1-of-1 / MetaMask / cold EOA). This service is
 * the read-only bridge that reconciles what actually happened on-chain with
 * what the backend authorized.
 *
 * The verification is FAIL-CLOSED: any mismatch (wrong chain, wrong sender,
 * wrong destination, wrong amount, reverted receipt, unknown transaction,
 * unallowlisted token) rejects the confirmation. An operator's assertion
 * alone is NEVER accepted — the transaction must be independently verified
 * against the configured RPC endpoint.
 *
 * Financial math: amounts are compared in EXACT base units via
 * ethers.parseEther / ethers.parseUnits. No parseFloat / Number() / toFixed
 * is used anywhere in this file.
 */
import { ethers } from 'ethers';
import { env } from '../../config/env';
import { db } from '../../config/database';
import { logger } from '../../config/logger';

/** A physical blockchain tx hash — the ONLY value accepted for confirmation. */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Result of an on-chain verification attempt. */
export interface OnChainVerificationResult {
  verified: boolean;
  reason?: string;
  /** Transaction receipt status (0 = reverted, 1 = success) when mined. */
  receiptStatus?: number;
}

/** Fields shared by both withdrawal and treasury verification. */
interface BaseVerifyParams {
  network: string;
  txHash: string;
  /** Authorized sender: the address the backend expects to sign. */
  expectedSender: string;
  /** Authorized destination. */
  expectedDestination: string;
  asset: string;
  /** Authorized amount in HUMAN units (e.g. '0.5' ETH, '100' USDT). */
  expectedAmount: string;
}

/**
 * Resolve the RPC URL for a network. Only read endpoints are used.
 * The manual mode relies on ETHEREUM_RPC_URL (env). Unknown networks fail
 * closed (null), which rejects verification.
 */
function rpcUrlForNetwork(network: string): string | null {
  if (!network) return null;
  if (network.toUpperCase() === 'ETHEREUM') return env.ETHEREUM_RPC_URL || null;
  return null;
}

export class ManualTxVerificationService {
  /** Verify a customer withdrawal transaction against the stored intent. */
  public async verifyWithdrawalTx(params: BaseVerifyParams): Promise<OnChainVerificationResult> {
    return this.verify(params, env.CUSTODY_CHAIN_ID);
  }

  /** Verify a treasury consolidation transaction against the intent. */
  public async verifyTreasuryTx(
    params: BaseVerifyParams,
    expectedChainId: number
  ): Promise<OnChainVerificationResult> {
    return this.verify(params, expectedChainId);
  }

  private async verify(
    params: BaseVerifyParams,
    expectedChainId: number
  ): Promise<OnChainVerificationResult> {
    try {
      const { network, txHash, expectedSender, expectedDestination, asset, expectedAmount } = params;

      // 1. Transaction hash format.
      if (!TX_HASH_RE.test(txHash)) {
        return { verified: false, reason: 'transaction hash is not a valid 0x-prefixed 64-hex hash' };
      }

      // 2. Sender must be configured (fail closed — never guess).
      if (!expectedSender || !/^0x[0-9a-fA-F]{40}$/.test(expectedSender)) {
        return { verified: false, reason: 'authorized sender is not configured' };
      }
      if (!expectedDestination || !/^0x[0-9a-fA-F]{40}$/.test(expectedDestination)) {
        return { verified: false, reason: 'authorized destination is not configured' };
      }

      // 3. RPC availability.
      const rpcUrl = rpcUrlForNetwork(network);
      if (!rpcUrl) {
        return { verified: false, reason: `no read RPC configured for network ${network}` };
      }
      const provider = new ethers.JsonRpcProvider(rpcUrl);

      // 4. Chain ID verification (rejects cross-chain replay).
      const networkInfo = await provider.getNetwork();
      if (Number(networkInfo.chainId) !== expectedChainId) {
        return {
          verified: false,
          reason: `chainId mismatch: expected ${expectedChainId}, RPC reports ${networkInfo.chainId}`,
        };
      }

      // 5. Transaction existence.
      const tx = await provider.getTransaction(txHash);
      if (!tx) {
        return { verified: false, reason: 'transaction not found on-chain' };
      }

      // 6. Sender verification (case-insensitive).
      if (!tx.from || tx.from.toLowerCase() !== expectedSender.toLowerCase()) {
        return { verified: false, reason: `sender mismatch: expected ${expectedSender}, got ${tx.from}` };
      }

      // 7. Asset-specific verification.
      let valueOk = false;
      if (asset.toUpperCase() === 'ETH') {
        // Native ETH: to == destination, value >= authorized amount.
        if (!tx.to || tx.to.toLowerCase() !== expectedDestination.toLowerCase()) {
          return { verified: false, reason: `destination mismatch: expected ${expectedDestination}, got ${tx.to}` };
        }
        const expectedValue = ethers.parseEther(expectedAmount);
        if (tx.value < expectedValue) {
          return {
            verified: false,
            reason: `amount below authorized amount: tx value ${tx.value.toString()} < authorized ${expectedValue.toString()}`,
          };
        }
        valueOk = true;
      } else {
        // ERC20: transaction must target an allowlisted contract and carry a
        // Transfer event from sender to destination for >= the authorized amount.
        const token = await this.lookupToken(network, asset);
        if (!token || !token.contract_address) {
          return { verified: false, reason: `asset ${asset} is not allowlisted for network ${network}` };
        }
        const contractAddress = ethers.getAddress(token.contract_address);
        if (!tx.to || tx.to.toLowerCase() !== contractAddress.toLowerCase()) {
          return { verified: false, reason: 'transaction does not target the allowlisted token contract' };
        }
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) {
          return { verified: false, reason: 'transaction receipt not found (pending?)' };
        }
        if (receipt.status === 0) {
          return { verified: false, reason: 'transaction reverted on-chain', receiptStatus: 0 };
        }
        const decimals = this.safeDecimals(token.decimals);
        const expectedValue = ethers.parseUnits(expectedAmount, decimals);
        const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
        let matched = false;
        for (const log of receipt.logs || []) {
          if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
          try {
            const parsed = iface.parseLog(log);
            if (!parsed) continue;
            const from: string = String(parsed.args.from).toLowerCase();
            const to: string = String(parsed.args.to).toLowerCase();
            const value: bigint = BigInt(parsed.args.value);
            if (
              from === expectedSender.toLowerCase() &&
              to === expectedDestination.toLowerCase() &&
              value >= expectedValue
            ) {
              matched = true;
              break;
            }
          } catch {
            // Unparseable log on this contract — ignore, keep scanning.
            continue;
          }
        }
        if (!matched) {
          return { verified: false, reason: 'no matching Transfer event (from/to/amount)' };
        }
        valueOk = true;
      }

      // 8. Receipt status check (native ETH path): a mined-and-reverted tx is
      // never acceptable even if the sender/destination/value matched, and a
      // transaction with NO receipt (still in the mempool / not yet mined) is
      // NOT final execution evidence — it must not be recorded as verified.
      // A dropped/replaced pending tx must never leave an intent recorded as
      // confirmed with no on-chain evidence (Phase 11K-B F2).
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        return { verified: false, reason: 'transaction not yet mined (pending)' };
      }
      if (receipt.status === 0) {
        return { verified: false, reason: 'transaction reverted on-chain', receiptStatus: 0 };
      }
      if (!valueOk) {
        return { verified: false, reason: 'transaction value could not be verified' };
      }

      return {
        verified: true,
        receiptStatus: Number(receipt.status),
      };
    } catch (err: any) {
      logger.warn('[ManualTxVerification] Verification failed (will fail closed)', {
        reason: err?.message || String(err),
      });
      return { verified: false, reason: `verification error: ${err?.message || String(err)}` };
    }
  }

  /** Look up the allowlisted token contract for (network, asset). */
  private async lookupToken(
    network: string,
    asset: string
  ): Promise<{ contract_address: string | null; decimals: number | null } | null> {
    const res = await db.query(
      `SELECT contract_address, decimals FROM asset_networks WHERE asset = $1 AND network = $2 AND is_active = TRUE LIMIT 1`,
      [asset, network]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0] as { contract_address: string | null; decimals: number | null };
    return {
      contract_address: row.contract_address || null,
      decimals: row.decimals == null ? null : Number(row.decimals),
    };
  }

  private safeDecimals(decimals: number | null): number {
    if (decimals != null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 77) {
      return decimals;
    }
    return 18;
  }
}

export const manualTxVerificationService = new ManualTxVerificationService();
