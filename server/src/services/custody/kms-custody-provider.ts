import { KMSClient, SignCommand, GetPublicKeyCommand, MessageType } from '@aws-sdk/client-kms';
import { ICustodyAdapter } from './custody-adapter.js';
import { WithdrawalRequest, CustodyTransaction, CustodyTransactionStatus, CustodyAssetNetwork, CustodyAccount, CustodyBalance, CustodyProviderCapability, CustodyProviderHealth, DepositAddress, GetOrCreateDepositAddressRequest, TreasuryTransferRequest, HOUSE_TREASURY_ACCOUNT_ID, SweepStatusResult } from './custody.types.js';
import { getAddressFromKmsPublicKey, parseKmsSignature } from './kms-crypto.js';
import { CustodyTransactionNotFoundError, SweepDustError, SweepZeroBalanceError, SweepReconciliationRequiredError } from './custody.errors.js';
import { env } from '../../config/env.js';
import { ethers, Transaction } from 'ethers';

export interface KmsNetworkConfig {
    rpcUrl: string;
    keyId: string;
    chainId: bigint;
    factoryAddress?: string;
    implementationAddress?: string;
    initCodeHash?: string;
}

export class KmsCustodyProvider implements ICustodyAdapter {
    public readonly providerId = 'kms';

    constructor(
        private kmsClient: KMSClient,
        private config: { [network: string]: KmsNetworkConfig },
        private database: any
    ) {}

    public getCapabilities(): CustodyProviderCapability[] {
        return [
            CustodyProviderCapability.WITHDRAWAL_REQUEST,
            CustodyProviderCapability.WITHDRAWAL_STATUS,
            CustodyProviderCapability.TREASURY_TRANSFER
        ];
    }
    public hasCapability(c: CustodyProviderCapability): boolean {
        return this.getCapabilities().includes(c);
    }
    public async healthCheck(): Promise<CustodyProviderHealth> { return { healthy: true } as CustodyProviderHealth; }
    public async getSupportedAssetNetworks(): Promise<CustodyAssetNetwork[]> { return []; }
    public async getAccounts(): Promise<CustodyAccount[]> { return []; }
    public async getBalances(accountId?: string): Promise<CustodyBalance[]> { return []; }
    public async getOrCreateDepositAddress(request: GetOrCreateDepositAddressRequest): Promise<DepositAddress> {
        const conf = this.config[request.network];
        if (!conf) throw new Error('Network ' + request.network + ' not supported by KMS provider');

        if (!conf.factoryAddress || !conf.implementationAddress || !conf.initCodeHash) {
            throw new Error(`Deposit addresses not configured for network ${request.network}`);
        }

        const factoryAddress = ethers.getAddress(conf.factoryAddress);
        const implementationAddress = ethers.getAddress(conf.implementationAddress);

        const expectedInitCode = ethers.solidityPacked(
            ['bytes', 'bytes20', 'bytes'],
            [
                '0x3d602d80600a3d3981f3363d3d373d3d3d363d73',
                implementationAddress,
                '0x5af43d82803e903d91602b57fd5bf3'
            ]
        );
        const expectedInitCodeHash = ethers.keccak256(expectedInitCode);

        if (expectedInitCodeHash !== conf.initCodeHash) {
            throw new Error(`CRITICAL: initCodeHash mismatch. Expected ${expectedInitCodeHash} but got ${conf.initCodeHash}`);
        }

        const salt = ethers.keccak256(
            ethers.solidityPacked(['string', 'string'], [request.userId, request.network])
        );

        const address = ethers.getCreate2Address(
            factoryAddress,
            salt,
            expectedInitCodeHash
        );

        return {
            address,
            asset: request.asset,
            network: request.network,
            userId: request.userId,
            requiresMemo: false,
            providerId: this.providerId,
            status: 'ACTIVE',
            createdAt: new Date(),
            metadata: {
                factoryAddress,
                implementationAddress,
                initCodeHash: expectedInitCodeHash,
                salt
            }
        };
    }

    public async getWithdrawalStatus(clientWithdrawalId: string): Promise<WithdrawalRequest> {
        const res = await this.database.query(
            'SELECT id, account_id, asset, amount, network, destination_address, destination_tag, crypto_status, provider_withdrawal_id, created_at, updated_at FROM withdrawals WHERE id = $1',
            [clientWithdrawalId]
        );
        if (res.rows.length === 0) {
            throw new Error('Withdrawal ' + clientWithdrawalId + ' not found');
        }

        const w = res.rows[0];
        let txHash = w.provider_withdrawal_id;

        const req: WithdrawalRequest = {
            clientWithdrawalId: w.id,
            accountId: w.account_id,
            asset: w.asset,
            amount: w.amount,
            network: w.network,
            destinationAddress: w.destination_address,
            destinationMemo: w.destination_tag,
            status: (w.crypto_status || 'PENDING') as CustodyTransactionStatus,
            providerReference: txHash,
            providerWithdrawalId: txHash,
            createdAt: w.created_at,
            updatedAt: w.updated_at
        };

        if (w.network && (w.crypto_status === 'BROADCAST' || w.crypto_status === 'SUBMITTED' || w.crypto_status === 'CONFIRMED' || w.crypto_status === 'FAILED')) {
            const conf = this.config[w.network];
            if (!conf) throw new Error('Unknown network configuration for ' + w.network);
            const provider = new ethers.JsonRpcProvider(conf.rpcUrl);

            const histRes = await this.database.query(
                'SELECT tx_hash, raw_signed_tx FROM withdrawal_transactions WHERE withdrawal_id = $1 ORDER BY created_at DESC',
                [w.id]
            );

            let anyPending = false;
            let winningTx = null;
            let winningReceipt = null;

            for (const h of (histRes?.rows || [])) {
                const receipt = await provider.getTransactionReceipt(h.tx_hash);
                if (receipt && receipt.status !== undefined) {
                    winningTx = h;
                    winningReceipt = receipt;
                    break;
                }
                const tx = await provider.getTransaction(h.tx_hash);
                if (tx) {
                    anyPending = true;
                }
            }

            if (winningTx && winningReceipt) {
                const originalTx = Transaction.from(winningTx.raw_signed_tx);
                const senderAddress = await this.getHotWalletAddress(w.network);

                // If it's a cancellation transaction (value=0, to=self)
                if (originalTx.to?.toLowerCase() === senderAddress.toLowerCase() && originalTx.value === 0n) {
                    // Cancellation won. To the customer, the withdrawal FAILED.
                    req.status = 'FAILED';
                    req.providerWithdrawalId = winningTx.tx_hash;
                    req.providerReference = winningTx.tx_hash;
                } else {
                    // Normal withdrawal or speed-up won
                    if (winningReceipt.status === 1) {
                        req.status = 'CONFIRMED';
                    } else if (winningReceipt.status === 0) {
                        req.status = 'FAILED';
                    }
                    req.providerWithdrawalId = winningTx.tx_hash;
                    req.providerReference = winningTx.tx_hash;
                }
            } else {
                // Nothing has mined yet.
                req.status = 'PENDING';
            }
        }

        return req;
    }

    public async getTransaction(providerTransactionId: string): Promise<CustodyTransaction> { throw new Error("Method not implemented."); }
    public async updateTransactionStatus(providerTransactionId: string, status: CustodyTransactionStatus): Promise<CustodyTransaction> { throw new Error("Method not implemented."); }

    public async getHotWalletAddress(network: string): Promise<string> {
        const conf = this.config[network];
        if (!conf) throw new Error(`Network ${network} not configured in KMS`);
        const result = await this.kmsClient.send(new GetPublicKeyCommand({ KeyId: conf.keyId }));
        if (!result.PublicKey) throw new Error("No public key returned from KMS");
        return getAddressFromKmsPublicKey(result.PublicKey);
    }

    public async requestWithdrawal(request: WithdrawalRequest): Promise<WithdrawalRequest> {
        const conf = this.config[request.network];
        if (!conf) throw new Error(`Network ${request.network} not supported`);

        const senderAddress = await this.getHotWalletAddress(request.network);
        const provider = new ethers.JsonRpcProvider(conf.rpcUrl);

        let nonce: number | undefined;

        // DB Transaction 0: Check for existing signing intent (Recovery)
        let existingTx: any = null;
        await this.database.transaction(async (txClient: any) => {
            const res = await txClient.query(
                `SELECT tx_hash, raw_signed_tx, status, network_nonce FROM withdrawal_transactions
                 WHERE withdrawal_id = $1 ORDER BY created_at DESC LIMIT 1`,
                [request.clientWithdrawalId]
            );
            if (res.rows.length > 0) {
                existingTx = res.rows[0];
            }
        });

        if (existingTx) {
            // We have a prior signing intent. Re-verify integrity.
            const recoveredTx = Transaction.from(existingTx.raw_signed_tx);
            if (recoveredTx.hash !== existingTx.tx_hash) {
                throw new Error("CRITICAL: Persisted raw_signed_tx hash does not match persisted tx_hash");
            }
            if (recoveredTx.from?.toLowerCase() !== senderAddress.toLowerCase()) {
                throw new Error("CRITICAL: Persisted raw_signed_tx sender does not match hot wallet");
            }

            // Check mempool state
            let onChainTx = null;
            try {
                onChainTx = await provider.getTransaction(existingTx.tx_hash);
            } catch (e: any) {
                // Ignore transient network errors here, assume not found
            }

            if (onChainTx) {
                // Tx is known to the network
                const receipt = await provider.getTransactionReceipt(existingTx.tx_hash);
                if (receipt) {
                    // Mined. Update DB statuses.
                    await this.database.transaction(async (txClient: any) => {
                        await txClient.query(`UPDATE withdrawal_transactions SET status = 'CONFIRMED' WHERE tx_hash = $1`, [existingTx.tx_hash]);
                        await txClient.query(`UPDATE withdrawals SET crypto_status = 'CONFIRMED' WHERE id = $1`, [request.clientWithdrawalId]);
                    });
                    return { ...request, providerWithdrawalId: existingTx.tx_hash, status: 'CONFIRMED' };
                } else {
                    // Pending. Just update status if needed.
                    await this.database.transaction(async (txClient: any) => {
                        await txClient.query(`UPDATE withdrawal_transactions SET status = 'BROADCAST' WHERE tx_hash = $1`, [existingTx.tx_hash]);
                        await txClient.query(`UPDATE withdrawals SET crypto_status = 'BROADCAST' WHERE id = $1`, [request.clientWithdrawalId]);
                    });
                    return { ...request, providerWithdrawalId: existingTx.tx_hash, status: 'BROADCAST' };
                }
            } else {
                // Not found on network. We must safely rebroadcast EXACT bytes.
                try {
                    await provider.broadcastTransaction(existingTx.raw_signed_tx);
                } catch (e: any) {
                    if (!e.message.includes("already known") && !e.message.includes("nonce too low")) {
                        throw new Error(`Rebroadcast failed: ${e.message}`);
                    }
                }

                await this.database.transaction(async (txClient: any) => {
                    await txClient.query(`UPDATE withdrawal_transactions SET status = 'BROADCAST' WHERE tx_hash = $1`, [existingTx.tx_hash]);
                    await txClient.query(`UPDATE withdrawals SET crypto_status = 'BROADCAST' WHERE id = $1`, [request.clientWithdrawalId]);
                });
                return { ...request, providerWithdrawalId: existingTx.tx_hash, status: 'BROADCAST' };
            }
        }

        // --- NEW SIGNING INTENT FLOW ---

        // DB Transaction 1: Idempotency and Nonce Reservation
        await this.database.transaction(async (txClient: any) => {
            const withdrawalRes = await txClient.query(
                `SELECT crypto_status, network_nonce, provider_withdrawal_id FROM withdrawals WHERE id = $1 FOR UPDATE`,
                [request.clientWithdrawalId]
            );

            if (withdrawalRes.rows.length > 0) {
                const w = withdrawalRes.rows[0];
                if (w.crypto_status === 'BROADCAST' || w.crypto_status === 'CONFIRMED') {
                    throw new Error(`Idempotency fault: Withdrawal ${request.clientWithdrawalId} already broadcast`);
                }

                // Phase 10.4 Step 6E-4C-2 (P1): nonce-reuse recovery must key on the
                // DURABLE reserved nonce, not on a single crypto_status string.
                // claimApprovedWithdrawals/claimStuckWithdrawals normalize claimed rows
                // to 'SUBMITTING', and the worker may legitimately leave rows in
                // 'SIGNING' or 'UNKNOWN' after a post-reservation failure. In every
                // one of those states, if a nonce was reserved, it MUST be reused —
                // never re-allocated (a re-allocation burns the reserved nonce and
                // permanently gaps the shared hot-wallet sequence).
                if (w.network_nonce != null && ['SIGNING', 'SUBMITTING', 'UNKNOWN'].includes(w.crypto_status)) {
                    nonce = parseInt(w.network_nonce, 10);

                    // Guard 1 ('latest'): if the reserved nonce was already mined by
                    // something else, broadcast state is genuinely unknown.
                    const currentOnChainNonce = await provider.getTransactionCount(senderAddress);
                    if (currentOnChainNonce > nonce) {
                        throw new Error(`CRITICAL: Nonce ${nonce} was assigned to this withdrawal, but on-chain nonce is ${currentOnChainNonce}. Broadcast status is UNKNOWN. Do not blindly reuse.`);
                    }
                    // Guard 2 ('pending'): an unknown transaction already pending at or
                    // below the reserved nonce blocks this one — surface it instead of
                    // signing into a doomed nonce.
                    const pendingOnChainNonce = await provider.getTransactionCount(senderAddress, 'pending');
                    if (pendingOnChainNonce > nonce) {
                        throw new Error(`CRITICAL: Nonce ${nonce} was assigned to this withdrawal, but ${pendingOnChainNonce - nonce} external transaction(s) are pending at or below it. Manual reconciliation required. Do not blindly reuse.`);
                    }
                    return;
                }
                if (w.crypto_status === 'SIGNING' && w.network_nonce == null) {
                    throw new Error(`Withdrawal is in SIGNING state but has no assigned nonce`);
                }
            }

            // Allocate a new nonce
            const nonceRes = await txClient.query(
                `SELECT next_nonce FROM hot_wallet_nonces WHERE network = $1 AND address = $2 FOR UPDATE`,
                [request.network, senderAddress.toLowerCase()]
            );

            if (nonceRes.rows.length === 0) {
                const onChainNonce = await provider.getTransactionCount(senderAddress);
                nonce = onChainNonce;
                await txClient.query(
                    `INSERT INTO hot_wallet_nonces (network, address, next_nonce, updated_at) VALUES ($1, $2, $3, NOW())`,
                    [request.network, senderAddress.toLowerCase(), nonce + 1]
                );
            } else {
                nonce = parseInt(nonceRes.rows[0].next_nonce, 10);
                await txClient.query(
                    `UPDATE hot_wallet_nonces SET next_nonce = next_nonce + 1, updated_at = NOW() WHERE network = $1 AND address = $2`,
                    [request.network, senderAddress.toLowerCase()]
                );
            }

            if (withdrawalRes.rows.length > 0) {
                await txClient.query(
                    `UPDATE withdrawals SET network_nonce = $1, crypto_status = 'SIGNING' WHERE id = $2`,
                    [nonce, request.clientWithdrawalId]
                );
            }
        });

        if (nonce === undefined) {
            throw new Error("Failed to reserve nonce");
        }

        let txData = '0x';
        let toAddress: string = request.destinationAddress;
        let value = 0n;

        if (request.asset !== 'ETH') {
            throw new Error("Only ETH implemented in this isolated test, ERC20 requires ABI");
        } else {
            value = ethers.parseEther(request.amount); // Exact precision
        }

        const txParams: any = {
            to: toAddress,
            value: value,
            data: txData,
            nonce: nonce,
            chainId: conf.chainId,
            type: 2,
            maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
            maxFeePerGas: ethers.parseUnits('20', 'gwei'),
            gasLimit: 21000n
        };

        const tx = Transaction.from(txParams);
        const digest = tx.unsignedHash;

        const signRes = await this.kmsClient.send(new SignCommand({
            KeyId: conf.keyId,
            Message: ethers.getBytes(digest),
            MessageType: MessageType.DIGEST,
            SigningAlgorithm: 'ECDSA_SHA_256'
        }));

        if (!signRes.Signature) throw new Error("KMS did not return a signature");

        const signature = parseKmsSignature(signRes.Signature, digest, senderAddress);
        tx.signature = signature;

        if (tx.from?.toLowerCase() !== senderAddress.toLowerCase()) {
            throw new Error(`CRITICAL: Reconstructed transaction signer ${tx.from} does not match expected KMS sender ${senderAddress}`);
        }
        if (tx.to?.toLowerCase() !== toAddress.toLowerCase()) {
            throw new Error("CRITICAL: Transaction destination mutated");
        }
        if (tx.value !== value) {
            throw new Error("CRITICAL: Transaction value mutated");
        }
        if (tx.chainId !== conf.chainId) {
            throw new Error("CRITICAL: Transaction chainId mutated");
        }
        if (tx.nonce !== nonce) {
            throw new Error("CRITICAL: Transaction nonce mutated");
        }

        const serialized = tx.serialized;
        const expectedTxHash = tx.hash;
        if (!expectedTxHash) throw new Error("Could not derive signed transaction hash");

        // DB Transaction 2: Persist the EXACT raw signed transaction
        await this.database.transaction(async (txClient: any) => {
            await txClient.query(
                `INSERT INTO withdrawal_transactions (withdrawal_id, network, network_nonce, tx_hash, raw_signed_tx, status)
                 VALUES ($1, $2, $3, $4, $5, 'PENDING')`,
                [request.clientWithdrawalId, request.network, nonce, expectedTxHash, serialized]
            );

            // Legacy fallback update for provider_withdrawal_id
            const res = await txClient.query(`SELECT id FROM withdrawals WHERE id = $1`, [request.clientWithdrawalId]);
            if (res.rows.length > 0) {
                await txClient.query(
                    `UPDATE withdrawals SET provider_withdrawal_id = $1 WHERE id = $2`,
                    [expectedTxHash, request.clientWithdrawalId]
                );
            }
        });

        // Broadcast (Network Call outside DB transaction)
        let txResponse;
        try {
            txResponse = await provider.broadcastTransaction(serialized);
        } catch (e: any) {
            // Re-throw safely: The intent is permanently saved in withdrawal_transactions.
            throw new Error(`Broadcast failed or timed out: ${e.message}`);
        }

        // DB Transaction 3: Mark Broadcast Success
        await this.database.transaction(async (txClient: any) => {
            await txClient.query(
                `UPDATE withdrawal_transactions SET status = 'BROADCAST' WHERE tx_hash = $1`,
                [expectedTxHash]
            );

            const res = await txClient.query(`SELECT id FROM withdrawals WHERE id = $1`, [request.clientWithdrawalId]);
            if (res.rows.length > 0) {
                await txClient.query(
                    `UPDATE withdrawals SET crypto_status = 'BROADCAST' WHERE id = $1`,
                    [request.clientWithdrawalId]
                );
            }
        });

        const result: WithdrawalRequest = {
            ...request,
            providerWithdrawalId: txResponse.hash,
            status: 'BROADCAST',
            providerReference: txResponse.hash,
            updatedAt: new Date()
        };
        return result;
    }

    // -------------------------------------------------------------------------
    // Phase 10.4 (unfreeze) — HOUSE TREASURY custody boundary
    //
    // Dedicated treasury transfer operation, structurally separate from the
    // customer withdrawal path:
    //   - correlation = treasuryIntentId (never a customer withdrawal id)
    //   - artifacts live in treasury_custody_artifacts (never in
    //     withdrawal_transactions, which is FK-bound to customer withdrawals)
    //   - same hot_wallet_nonces domain (SELECT ... FOR UPDATE, atomic
    //     increment) — collision-free sharing with withdrawals and sweeps
    //   - same safety sequence: reserve → sign → validate → persist EXACT
    //     bytes → broadcast → recover by rebroadcasting EXACT bytes
    //   - ONE intent = ONE artifact row (UNIQUE) = ONE physical tx
    // -------------------------------------------------------------------------

    public async submitTreasuryTransfer(request: TreasuryTransferRequest): Promise<WithdrawalRequest> {
        const conf = this.config[request.network];
        if (!conf) throw new Error(`Network ${request.network} not supported`);

        // Native-asset transfers only (mirrors the customer path's current scope).
        if (request.asset !== 'ETH') {
            throw new Error(`Treasury transfer: only native ETH is implemented (got ${request.asset})`);
        }

        const senderAddress = await this.getHotWalletAddress(request.network);
        const provider = new ethers.JsonRpcProvider(conf.rpcUrl);

        const artifactsRes = await this.database.query(
            `SELECT id, network_nonce, tx_hash, raw_signed_tx, status
             FROM treasury_custody_artifacts
             WHERE treasury_intent_id = $1
             ORDER BY created_at DESC`,
            [request.treasuryIntentId]
        );
        const artifacts = artifactsRes?.rows || [];

        // --- RECOVERY / DUPLICATE-SUBMISSION PATH ---
        // Any artifact with persisted exact bytes is authoritative: the intent
        // already has (at most) ONE physical transaction. Never sign again.
        for (const art of artifacts) {
            if (!art.raw_signed_tx || !art.tx_hash) continue;
            const receipt = await provider.getTransactionReceipt(art.tx_hash);
            if (receipt && receipt.status !== undefined) {
                // Already mined — idempotent result, no second transaction.
                const status: CustodyTransactionStatus = receipt.status === 1 ? 'CONFIRMED' : 'FAILED';
                if (art.status !== 'BROADCAST') {
                    await this.database.query(
                        `UPDATE treasury_custody_artifacts SET status = 'BROADCAST', updated_at = NOW() WHERE id = $1`,
                        [art.id]
                    );
                }
                return this.treasuryResult(request, status, art.tx_hash);
            }
            const pending = await provider.getTransaction(art.tx_hash);
            if (pending) {
                return this.treasuryResult(request, 'BROADCAST', art.tx_hash);
            }
            // Signed but neither mined nor pending → rebroadcast EXACT bytes.
            try {
                await provider.broadcastTransaction(art.raw_signed_tx);
            } catch (e: any) {
                if (!e.message.includes("already known") && !e.message.includes("nonce too low")) {
                    throw new Error(`Treasury rebroadcast failed: ${e.message}`);
                }
            }
            await this.database.query(
                `UPDATE treasury_custody_artifacts SET status = 'BROADCAST', updated_at = NOW() WHERE id = $1`,
                [art.id]
            );
            return this.treasuryResult(request, 'BROADCAST', art.tx_hash);
        }

        // --- RESERVATION / RESUME PATH ---
        // No artifact with signed bytes exists. Either a fresh intent (reserve a
        // nonce + create the artifact row atomically) or a crash between
        // reservation and signing (reuse the DURABLE reserved nonce — never
        // re-allocate, which would burn a nonce and gap the shared sequence).
        let nonce: number | undefined = undefined;
        let artifactId: string | undefined = undefined;

        await this.database.transaction(async (txClient: any) => {
            const artRes = await txClient.query(
                `SELECT id, network_nonce FROM treasury_custody_artifacts WHERE treasury_intent_id = $1 FOR UPDATE`,
                [request.treasuryIntentId]
            );

            if (artRes.rows.length > 0) {
                // Crash-before-sign resume: durable nonce MUST be reused.
                const art = artRes.rows[0];
                artifactId = art.id;
                if (art.network_nonce == null) {
                    throw new Error(`Treasury artifact ${request.treasuryIntentId} is in RESERVING state without a reserved nonce`);
                }
                nonce = parseInt(art.network_nonce, 10);

                // Guard 1 ('latest'): reserved nonce already mined externally.
                const currentOnChainNonce = await provider.getTransactionCount(senderAddress);
                if (currentOnChainNonce > nonce) {
                    throw new Error(`CRITICAL: Treasury nonce ${nonce} was reserved, but on-chain nonce is ${currentOnChainNonce}. Broadcast status is UNKNOWN. Manual reconciliation required.`);
                }
                // Guard 2 ('pending'): external txs pending at or below it.
                const pendingOnChainNonce = await provider.getTransactionCount(senderAddress, 'pending');
                if (pendingOnChainNonce > nonce) {
                    throw new Error(`CRITICAL: Treasury nonce ${nonce} is blocked by ${pendingOnChainNonce - nonce} external pending transaction(s). Manual reconciliation required.`);
                }
                return;
            }

            // Fresh intent: reserve nonce and create the artifact atomically.
            const nonceRes = await txClient.query(
                `SELECT next_nonce FROM hot_wallet_nonces WHERE network = $1 AND address = $2 FOR UPDATE`,
                [request.network, senderAddress.toLowerCase()]
            );
            if (nonceRes.rows.length === 0) {
                const onChainNonce = await provider.getTransactionCount(senderAddress);
                nonce = onChainNonce;
                await txClient.query(
                    `INSERT INTO hot_wallet_nonces (network, address, next_nonce, updated_at) VALUES ($1, $2, $3, NOW())`,
                    [request.network, senderAddress.toLowerCase(), nonce + 1]
                );
            } else {
                nonce = parseInt(nonceRes.rows[0].next_nonce, 10);
                await txClient.query(
                    `UPDATE hot_wallet_nonces SET next_nonce = next_nonce + 1, updated_at = NOW() WHERE network = $1 AND address = $2`,
                    [request.network, senderAddress.toLowerCase()]
                );
            }

            const insertRes = await txClient.query(
                `INSERT INTO treasury_custody_artifacts (treasury_intent_id, network, network_nonce, status)
                 VALUES ($1, $2, $3, 'RESERVING') RETURNING id`,
                [request.treasuryIntentId, request.network, nonce]
            );
            artifactId = insertRes.rows[0].id;
        });

        if (nonce === undefined || artifactId === undefined) {
            throw new Error("Failed to reserve treasury nonce");
        }

        // --- SIGN + VALIDATE (same primitives as the customer path) ---
        const value = ethers.parseEther(request.amount);
        // 60000: plain EOA transfers need 21000, but the trusted destination is
        // the Safe CONTRACT — executing its receive()/fallback costs more than
        // the 21000 base transfer (proven live: 21000 reverts with out-of-gas).
        const txParams: any = {
            to: request.destinationAddress,
            value: value,
            data: '0x',
            nonce: nonce,
            chainId: conf.chainId,
            type: 2,
            maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
            maxFeePerGas: ethers.parseUnits('20', 'gwei'),
            gasLimit: 60000n
        };

        const tx = Transaction.from(txParams);
        const digest = tx.unsignedHash;
        const signRes = await this.kmsClient.send(new SignCommand({
            KeyId: conf.keyId,
            Message: ethers.getBytes(digest),
            MessageType: MessageType.DIGEST,
            SigningAlgorithm: 'ECDSA_SHA_256'
        }));
        if (!signRes.Signature) throw new Error("KMS did not return a signature");

        const signature = parseKmsSignature(signRes.Signature, digest, senderAddress);
        tx.signature = signature;

        if (tx.from?.toLowerCase() !== senderAddress.toLowerCase()) {
            throw new Error(`CRITICAL: Reconstructed treasury transaction signer ${tx.from} does not match expected KMS sender ${senderAddress}`);
        }
        if (tx.to?.toLowerCase() !== request.destinationAddress.toLowerCase()) {
            throw new Error("CRITICAL: Treasury transaction destination mutated");
        }
        if (tx.value !== value) {
            throw new Error("CRITICAL: Treasury transaction value mutated");
        }
        if (tx.chainId !== conf.chainId) {
            throw new Error("CRITICAL: Treasury transaction chainId mutated");
        }
        if (tx.nonce !== nonce) {
            throw new Error("CRITICAL: Treasury transaction nonce mutated");
        }

        const serialized = tx.serialized;
        const expectedTxHash = tx.hash;
        if (!expectedTxHash) throw new Error("Could not derive signed treasury transaction hash");

        // Persist EXACT bytes BEFORE broadcast (crash-safe).
        await this.database.query(
            `UPDATE treasury_custody_artifacts
             SET tx_hash = $1, raw_signed_tx = $2, status = 'SIGNED', updated_at = NOW()
             WHERE id = $3`,
            [expectedTxHash, serialized, artifactId]
        );

        // Broadcast (network call outside DB transaction; artifact is durable).
        let txResponse;
        try {
            txResponse = await provider.broadcastTransaction(serialized);
        } catch (e: any) {
            throw new Error(`Treasury broadcast failed or timed out: ${e.message}`);
        }

        await this.database.query(
            `UPDATE treasury_custody_artifacts SET status = 'BROADCAST', updated_at = NOW() WHERE id = $1`,
            [artifactId]
        );

        return this.treasuryResult(request, 'BROADCAST', txResponse.hash);
    }

    public async getTreasuryTransferStatus(treasuryIntentId: string): Promise<WithdrawalRequest> {
        const artifactsRes = await this.database.query(
            `SELECT id, network, network_nonce, tx_hash, raw_signed_tx, status, created_at, updated_at
             FROM treasury_custody_artifacts
             WHERE treasury_intent_id = $1
             ORDER BY created_at DESC`,
            [treasuryIntentId]
        );
        const art = (artifactsRes?.rows || [])[0];
        if (!art) {
            throw new CustodyTransactionNotFoundError(`Treasury transfer ${treasuryIntentId}`);
        }

        const result: WithdrawalRequest = {
            clientWithdrawalId: treasuryIntentId,
            accountId: HOUSE_TREASURY_ACCOUNT_ID,
            asset: 'ETH',
            network: art.network,
            amount: '0', // physical status lookup; amount authority is the treasury intent row
            destinationAddress: '',
            status: (art.status === 'BROADCAST' ? 'BROADCAST' : 'PENDING') as CustodyTransactionStatus,
            providerReference: art.tx_hash || undefined,
            providerWithdrawalId: art.tx_hash || undefined,
            createdAt: art.created_at,
            updatedAt: art.updated_at
        };

        if (art.tx_hash && art.raw_signed_tx) {
            const conf = this.config[art.network];
            if (conf) {
                const provider = new ethers.JsonRpcProvider(conf.rpcUrl);
                const receipt = await provider.getTransactionReceipt(art.tx_hash);
                if (receipt && receipt.status !== undefined) {
                    result.status = receipt.status === 1 ? 'CONFIRMED' : 'FAILED';
                } else {
                    const pending = await provider.getTransaction(art.tx_hash);
                    result.status = pending ? 'BROADCAST' : 'PENDING';
                }
            }
        }

        return result;
    }

    /** WithdrawalRequest-shaped result for the treasury domain (CAL contract). */
    private treasuryResult(
        request: TreasuryTransferRequest,
        status: CustodyTransactionStatus,
        txHash: string | null
    ): WithdrawalRequest {
        return {
            clientWithdrawalId: request.treasuryIntentId,
            accountId: HOUSE_TREASURY_ACCOUNT_ID,
            asset: request.asset,
            network: request.network,
            amount: request.amount,
            destinationAddress: request.destinationAddress,
            status,
            providerReference: txHash || undefined,
            providerWithdrawalId: txHash || undefined,
            createdAt: new Date(),
            updatedAt: new Date()
        };
    }


    public async checkSweepStatus(txHash: string, network: string): Promise<SweepStatusResult> {
        const conf = this.config[network];
        if (!conf) throw new Error(`Network ${network} not supported`);

        const provider = new ethers.JsonRpcProvider(conf.rpcUrl);
        const receipt = await provider.getTransactionReceipt(txHash);

        if (!receipt) {
            return { status: 'BROADCAST' };
        }

        if (receipt.status === 0) {
            return {
                status: 'FAILED',
                blockNumber: receipt.blockNumber,
                blockHash: receipt.blockHash,
            };
        }

        const currentBlock = await provider.getBlockNumber();
        const confirmations = (currentBlock - receipt.blockNumber) + 1;

        const netRes = await this.database.query(
            `SELECT confirmations_required FROM asset_networks WHERE network = $1 LIMIT 1`,
            [network]
        );
        const reqConf = netRes.rows[0]?.confirmations_required ?? 12;

        if (confirmations >= reqConf) {
            return {
                status: 'CONFIRMED',
                blockNumber: receipt.blockNumber,
                blockHash: receipt.blockHash,
                confirmations,
            };
        }

        return {
            status: 'BROADCAST',
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
            confirmations,
        };
    }

    public async sweepDepositAddress(
        network: string,
        depositAddress: string,
        asset: string,
        pendingSweepIds: string[]
    ): Promise<string> {
        const conf = this.config[network];
        if (!conf) throw new Error(`Network ${network} not supported`);

        const provider = new ethers.JsonRpcProvider(conf.rpcUrl);
        const senderAddress = await this.getHotWalletAddress(network);

        const res = await this.database.query(
            `SELECT address_metadata FROM deposit_addresses WHERE network = $1 AND blockchain_address = $2 LIMIT 1`,
            [network, depositAddress]
        );
        if (res.rows.length === 0) throw new Error("Deposit address not found");
        const metadata = res.rows[0].address_metadata;

        const factoryAddress = ethers.getAddress(metadata.factoryAddress);
        const salt = metadata.salt;
        const initCodeHash = metadata.initCodeHash;

        const expectedAddress = ethers.getCreate2Address(factoryAddress, salt, initCodeHash);
        if (expectedAddress.toLowerCase() !== depositAddress.toLowerCase()) {
            throw new Error("CRITICAL: Deterministic address mismatch. FAIL CLOSED.");
        }

        let tokenAddress: string | null = null;
        if (asset !== 'ETH') {
            const tokenRes = await this.database.query(
                `SELECT contract_address FROM asset_networks WHERE asset = $1 AND network = $2 LIMIT 1`,
                [asset, network]
            );
            if (tokenRes.rows.length === 0 || !tokenRes.rows[0].contract_address) {
                throw new Error("Token contract not found in asset_networks");
            }
            tokenAddress = ethers.getAddress(tokenRes.rows[0].contract_address);
        }

        // 1. Check physical balance
        let balance = 0n;
        if (asset === 'ETH') {
            balance = await provider.getBalance(depositAddress);
        } else {
            const erc20 = new ethers.Contract(tokenAddress!, ['function balanceOf(address) view returns (uint256)'], provider);
            balance = await erc20.balanceOf(depositAddress);
        }

        // 1b. Zero-balance investigation (P2 — never silently terminate).
        // A zero balance with pending sweep rows must be explained:
        //   A. previously swept (a CONFIRMED sweep covers this forwarder+asset)
        //   B. external movement / stale detection / corruption (no such sweep)
        //   D. RPC inconsistency (transient zero read)
        if (balance === 0n) {
            // Re-query once to rule out a transient RPC inconsistency before
            // drawing any conclusion. No nonce has been reserved at this point.
            let balanceAgain = 0n;
            try {
                if (asset === 'ETH') {
                    balanceAgain = await provider.getBalance(depositAddress);
                } else {
                    const erc20Again = new ethers.Contract(tokenAddress!, ['function balanceOf(address) view returns (uint256)'], provider);
                    balanceAgain = await erc20Again.balanceOf(depositAddress);
                }
            } catch {
                // Treat a failing re-query as unexplained rather than transient:
                // consistent RPC failures surface through the normal error path.
            }
            if (balanceAgain !== 0n) {
                balance = balanceAgain;
            } else {
                // Search sweep history: has ANY confirmed sweep already moved this
                // forwarder's balance for this asset?
                const histRes = await this.database.query(
                    `SELECT st.tx_hash FROM sweep_transactions st
                     WHERE st.network = $1 AND st.status = 'CONFIRMED'
                       AND EXISTS (
                         SELECT 1 FROM pending_sweeps ps2
                         JOIN blockchain_deposits bd2 ON ps2.deposit_id = bd2.id
                         WHERE ps2.sweep_txid = st.tx_hash
                           AND bd2.to_address = $2 AND bd2.asset = $3 AND bd2.network = $1
                       )
                     ORDER BY st.confirmed_at DESC NULLS LAST
                     LIMIT 1`,
                    [network, depositAddress, asset]
                );
                const settledTxHash = histRes.rows.length > 0 ? histRes.rows[0].tx_hash : null;
                throw new SweepZeroBalanceError(network, depositAddress, asset, settledTxHash);
            }
        }

        // 2. Fetch fee data and perform DUST checks BEFORE any nonce allocation / state mutation
        const feeData = await provider.getFeeData();
        const maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits('20', 'gwei');
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei');
        const gasLimit = 200000n;

        const FactoryABI = [
            "function deployAndSweepETH(bytes32 salt) external returns (address proxy)",
            "function deployAndSweepERC20(bytes32 salt, address token) external returns (address proxy)"
        ];
        const factoryContract = new ethers.Contract(factoryAddress, FactoryABI);

        let txData = '0x';
        if (asset === 'ETH') {
            txData = factoryContract.interface.encodeFunctionData("deployAndSweepETH", [salt]);
            const cost = maxFeePerGas * gasLimit;
            if (balance <= cost) {
                // Must throw DUST BEFORE nonce allocation
                throw new SweepDustError(asset, network, `balance ${balance.toString()} wei <= gas cost ${cost.toString()} wei`);
            }
        } else {
            // P2: ERC20 dust gate — same dust-before-nonce discipline as ETH.
            // No oracle is introduced in this correction step (see env docs):
            // the economic policy is a configurable per-asset minimum in BASE
            // UNITS (smallest token denomination), enforced strictly BEFORE the
            // nonce transaction. Remaining limitation: without a price source
            // the threshold cannot be expressed in fiat/native value, so
            // operators must configure CUSTODY_SWEEP_MIN_TOKEN_UNITS per asset.
            const minUnits = KmsCustodyProvider.getMinTokenUnits(asset);
            if (balance < minUnits) {
                throw new SweepDustError(asset, network, `balance ${balance.toString()} base units < configured minimum ${minUnits.toString()}`);
            }
            txData = factoryContract.interface.encodeFunctionData("deployAndSweepERC20", [salt, tokenAddress]);
            // Sweepability pre-check: estimate the actual sweep gas. This proves
            // the sweep can execute (forwarder deployment + token transfer)
            // BEFORE reserving a nonce. Estimation failure is treated as
            // transient (no nonce, no signing, retry next tick). Note: without
            // a token/native price source the gas cost cannot be compared to
            // the token balance's value — that economic limitation is
            // documented and partially mitigated by the base-units gate above.
            try {
                await provider.estimateGas({
                    to: factoryAddress,
                    data: txData,
                    from: senderAddress,
                });
            } catch (e: any) {
                throw new Error(`SWEEP_GAS_ESTIMATE_UNAVAILABLE: ${e?.message || e}`);
            }
        }

        // 3. Check for existing signing intent (Recovery)
        let existingTx: any = null;
        await this.database.transaction(async (txClient: any) => {
            const psRes = await txClient.query(`SELECT sweep_txid FROM pending_sweeps WHERE id = ANY($1)`, [pendingSweepIds]);
            let sweepTxId: string | null = null;
            for (const r of psRes.rows) {
                if (r.sweep_txid) sweepTxId = r.sweep_txid;
            }
            if (sweepTxId) {
                const res = await txClient.query(
                    `SELECT tx_hash, raw_signed_tx, status, network_nonce FROM sweep_transactions WHERE tx_hash = $1 LIMIT 1`,
                    [sweepTxId]
                );
                if (res.rows.length > 0) {
                    existingTx = res.rows[0];
                }
            }
        });

        if (existingTx) {
            const recoveredTx = Transaction.from(existingTx.raw_signed_tx);
            if (recoveredTx.hash !== existingTx.tx_hash) {
                throw new Error("CRITICAL: Persisted raw_signed_tx hash does not match persisted tx_hash");
            }
            if (recoveredTx.from?.toLowerCase() !== senderAddress.toLowerCase()) {
                throw new Error("CRITICAL: Persisted raw_signed_tx sender does not match hot wallet");
            }
            if (recoveredTx.nonce !== Number(existingTx.network_nonce)) {
                throw new Error("CRITICAL: Persisted raw_signed_tx nonce does not match stored network_nonce");
            }
            if (recoveredTx.chainId !== conf.chainId) {
                throw new Error("CRITICAL: Persisted raw_signed_tx chainId does not match configured chainId");
            }
            if (recoveredTx.to?.toLowerCase() !== factoryAddress.toLowerCase()) {
                throw new Error("CRITICAL: Persisted raw_signed_tx destination does not match factory address");
            }
            if (recoveredTx.data !== txData) {
                throw new Error("CRITICAL: Persisted raw_signed_tx calldata does not match expected sweep transaction data");
            }
            if (recoveredTx.value !== 0n) {
                throw new Error("CRITICAL: Persisted raw_signed_tx value mutated");
            }

            let onChainTx = null;
            try {
                onChainTx = await provider.getTransaction(existingTx.tx_hash);
            } catch (e: any) {
                // Ignore transient network errors here, assume not found
            }

            const sweepStatusResult = await this.checkSweepStatus(existingTx.tx_hash, network);

            if (sweepStatusResult.status === 'CONFIRMED') {
                await this.database.transaction(async (txClient: any) => {
                    await txClient.query(
                        `UPDATE sweep_transactions SET status = 'CONFIRMED', block_number = $1, block_hash = $2, confirmed_at = NOW() WHERE tx_hash = $3`,
                        [sweepStatusResult.blockNumber, sweepStatusResult.blockHash, existingTx.tx_hash]
                    );
                    await txClient.query(`UPDATE pending_sweeps SET status = 'CONFIRMED' WHERE sweep_txid = $1`, [existingTx.tx_hash]);
                    await txClient.query(`UPDATE sweep_intents SET status = 'CONFIRMED', updated_at = NOW() WHERE sweep_txid = $1`, [existingTx.tx_hash]);
                });
                return existingTx.tx_hash;
            } else if (sweepStatusResult.status === 'FAILED') {
                await this.database.transaction(async (txClient: any) => {
                    await txClient.query(`UPDATE sweep_transactions SET status = 'FAILED' WHERE tx_hash = $1`, [existingTx.tx_hash]);
                    await txClient.query(`UPDATE pending_sweeps SET status = 'PENDING', sweep_txid = NULL WHERE sweep_txid = $1`, [existingTx.tx_hash]);
                    await txClient.query(`UPDATE sweep_intents SET status = 'FAILED', updated_at = NOW() WHERE sweep_txid = $1`, [existingTx.tx_hash]);
                });
                throw new Error(`Previous sweep transaction ${existingTx.tx_hash} reverted on-chain`);
            } else if (onChainTx || sweepStatusResult.blockNumber) {
                await this.database.transaction(async (txClient: any) => {
                    await txClient.query(`UPDATE sweep_transactions SET status = 'BROADCAST' WHERE tx_hash = $1`, [existingTx.tx_hash]);
                    await txClient.query(`UPDATE pending_sweeps SET status = 'BROADCAST' WHERE sweep_txid = $1`, [existingTx.tx_hash]);
                    await txClient.query(`UPDATE sweep_intents SET status = 'BROADCAST', updated_at = NOW() WHERE sweep_txid = $1`, [existingTx.tx_hash]);
                });
                return existingTx.tx_hash;
            } else {
                // Not found on network. We must safely rebroadcast EXACT bytes.
                try {
                    await provider.broadcastTransaction(existingTx.raw_signed_tx);
                } catch (e: any) {
                    if (!e.message.includes("already known") && !e.message.includes("nonce too low")) {
                        throw new Error(`Rebroadcast failed: ${e.message}`);
                    }
                }
                await this.database.transaction(async (txClient: any) => {
                    await txClient.query(`UPDATE sweep_transactions SET status = 'BROADCAST' WHERE tx_hash = $1`, [existingTx.tx_hash]);
                    await txClient.query(`UPDATE pending_sweeps SET status = 'BROADCAST' WHERE sweep_txid = $1`, [existingTx.tx_hash]);
                    await txClient.query(`UPDATE sweep_intents SET status = 'BROADCAST', updated_at = NOW() WHERE sweep_txid = $1`, [existingTx.tx_hash]);
                });
                return existingTx.tx_hash;
            }
        }

        // 4. Fresh signing flow (ONLY if no existingTx artifact).
        //
        // P0 (Step 6E-4C-2): the reserved nonce is durably associated with a
        // sweep_intents row created ATOMICALLY with the nonce reservation.
        // Invariant: nonce reservation + sweep intent identity + reserved
        // nonce commit in ONE database transaction, so a crash after
        // reservation but before sweep_transactions insertion can never burn
        // a nonce — recovery reuses intent.network_nonce.
        let nonce: number | undefined;
        let intentId: string | undefined;

        // 4a. Recovery: an open intent (nonce reserved, no artifact) for this
        // group MUST be reused — never allocate a new nonce over it.
        const openIntentRes = await this.database.query(
            `SELECT id, network_nonce FROM sweep_intents
             WHERE network = $1 AND address = $2 AND asset = $3
               AND status = 'SIGNING' AND sweep_txid IS NULL
             ORDER BY created_at DESC
             LIMIT 1`,
            [network, depositAddress.toLowerCase(), asset]
        );

        if (openIntentRes.rows.length > 0) {
            const openIntent = openIntentRes.rows[0];
            const reserved = parseInt(openIntent.network_nonce, 10);

            // Verify chain state before reusing the reserved nonce: distinguish
            // unused / pending / mined / externally replaced.
            let latestCount = -1;
            let pendingCount = -1;
            try {
                latestCount = await provider.getTransactionCount(senderAddress, 'latest');
                pendingCount = await provider.getTransactionCount(senderAddress, 'pending');
            } catch (e: any) {
                // RPC down: leave the intent intact (still recoverable) and fail
                // this attempt without touching the nonce sequence.
                throw new Error(`SWEEP_INTENT_RECOVERY_RPC_UNAVAILABLE: ${e?.message || e}`);
            }

            if (latestCount > reserved) {
                // Nonce consumed by an externally mined transaction — the intent
                // can never be filled by us. Surface manual reconciliation; the
                // nonce sequence itself is not gapped (chain moved past N), but
                // the sweep's funds state is unknown.
                await this.database.transaction(async (txClient: any) => {
                    await txClient.query(`UPDATE sweep_intents SET status = 'RECONCILIATION', updated_at = NOW() WHERE id = $1`, [openIntent.id]);
                    await txClient.query(`UPDATE pending_sweeps SET status = 'RECONCILIATION', updated_at = NOW() WHERE sweep_intent_id = $1`, [openIntent.id]);
                });
                throw new SweepReconciliationRequiredError(openIntent.id, reserved, `on-chain nonce ${latestCount} already consumed the reserved nonce (external replacement or divergence)`);
            }
            if (pendingCount > latestCount && reserved < pendingCount) {
                // An unknown transaction is pending in the mempool at or below the
                // reserved nonce. Signing into this nonce now would race it.
                await this.database.transaction(async (txClient: any) => {
                    await txClient.query(`UPDATE sweep_intents SET status = 'RECONCILIATION', updated_at = NOW() WHERE id = $1`, [openIntent.id]);
                    await txClient.query(`UPDATE pending_sweeps SET status = 'RECONCILIATION', updated_at = NOW() WHERE sweep_intent_id = $1`, [openIntent.id]);
                });
                throw new SweepReconciliationRequiredError(openIntent.id, reserved, `external transaction(s) pending at or below the reserved nonce (latest=${latestCount}, pending=${pendingCount})`);
            }

            // Safe reuse: nonce is unused on-chain (latest == reserved and no
            // external pending tx occupies it). Re-link rows and RE-SIGN with
            // the SAME nonce. hot_wallet_nonces is intentionally untouched.
            nonce = reserved;
            intentId = openIntent.id;
            await this.database.transaction(async (txClient: any) => {
                await txClient.query(
                    `UPDATE pending_sweeps SET status = 'SIGNING', sweep_intent_id = $1, updated_at = NOW() WHERE id = ANY($2)`,
                    [intentId, pendingSweepIds]
                );
            });
        } else {
            // 4b. Fresh intent: nonce reservation + durable intent identity +
            // row linkage, committed atomically.
            await this.database.transaction(async (txClient: any) => {
                const nonceRes = await txClient.query(
                    `SELECT next_nonce FROM hot_wallet_nonces WHERE network = $1 AND address = $2 FOR UPDATE`,
                    [network, senderAddress.toLowerCase()]
                );

                if (nonceRes.rows.length === 0) {
                    const onChainNonce = await provider.getTransactionCount(senderAddress);
                    nonce = onChainNonce;
                    await txClient.query(
                        `INSERT INTO hot_wallet_nonces (network, address, next_nonce, updated_at) VALUES ($1, $2, $3, NOW())`,
                        [network, senderAddress.toLowerCase(), nonce + 1]
                    );
                } else {
                    nonce = parseInt(nonceRes.rows[0].next_nonce, 10);
                    await txClient.query(
                        `UPDATE hot_wallet_nonces SET next_nonce = next_nonce + 1, updated_at = NOW() WHERE network = $1 AND address = $2`,
                        [network, senderAddress.toLowerCase()]
                    );
                }

                const intentRes = await txClient.query(
                    `INSERT INTO sweep_intents (network, address, asset, network_nonce, status)
                     VALUES ($1, $2, $3, $4, 'SIGNING') RETURNING id`,
                    [network, depositAddress.toLowerCase(), asset, nonce]
                );
                intentId = intentRes.rows[0].id;

                await txClient.query(
                    `UPDATE pending_sweeps SET status = 'SIGNING', sweep_intent_id = $1, updated_at = NOW() WHERE id = ANY($2)`,
                    [intentId, pendingSweepIds]
                );
            });
        }

        if (nonce === undefined || intentId === undefined) throw new Error("Failed to reserve sweep nonce/intent");

        const txParams: any = {
            to: factoryAddress,
            value: 0n,
            data: txData,
            nonce: nonce,
            chainId: conf.chainId,
            type: 2,
            maxPriorityFeePerGas,
            maxFeePerGas,
            gasLimit
        };

        const tx = Transaction.from(txParams);
        const digest = tx.unsignedHash;

        const signRes = await this.kmsClient.send(new SignCommand({
            KeyId: conf.keyId,
            Message: ethers.getBytes(digest),
            MessageType: MessageType.DIGEST,
            SigningAlgorithm: 'ECDSA_SHA_256'
        }));

        if (!signRes.Signature) throw new Error("KMS signature failed");

        const signature = parseKmsSignature(signRes.Signature, digest, senderAddress);
        tx.signature = signature;

        const serialized = tx.serialized;
        const expectedTxHash = tx.hash;
        if (!expectedTxHash) throw new Error("Could not derive signed transaction hash");

        await this.database.transaction(async (txClient: any) => {
            await txClient.query(
                `INSERT INTO sweep_transactions (network, network_nonce, tx_hash, raw_signed_tx, status)
                 VALUES ($1, $2, $3, $4, 'PENDING')`,
                [network, nonce, expectedTxHash, serialized]
            );

            await txClient.query(
                `UPDATE pending_sweeps SET sweep_txid = $1 WHERE id = ANY($2)`,
                [expectedTxHash, pendingSweepIds]
            );

            // Intent now carries a durable artifact — same transaction, so an
            // intent with no artifact can only exist in the SIGNING state.
            await txClient.query(
                `UPDATE sweep_intents SET status = 'SIGNED', sweep_txid = $1, updated_at = NOW() WHERE id = $2`,
                [expectedTxHash, intentId]
            );
        });

        try {
            await provider.broadcastTransaction(serialized);
        } catch (e: any) {
            throw new Error(`Broadcast failed: ${e.message}`);
        }

        await this.database.transaction(async (txClient: any) => {
            await txClient.query(
                `UPDATE sweep_transactions SET status = 'BROADCAST' WHERE tx_hash = $1`,
                [expectedTxHash]
            );
            await txClient.query(
                `UPDATE pending_sweeps SET status = 'BROADCAST' WHERE sweep_txid = $1`,
                [expectedTxHash]
            );
            await txClient.query(
                `UPDATE sweep_intents SET status = 'BROADCAST', updated_at = NOW() WHERE id = $1`,
                [intentId]
            );
        });

        return expectedTxHash;
    }

    /**
     * P2 (Step 6E-4C-2): ERC20 dust policy.
     *
     * Configured via CUSTODY_SWEEP_MIN_TOKEN_UNITS as a CSV of
     * `ASSET=BASE_UNITS` pairs (smallest token denomination), e.g.
     * `USDT=1000000,USDC=1000000`. Default when unconfigured: 0n — sweep
     * everything (previous behavior).
     *
     * KNOWN ECONOMIC LIMITATION (documented, not hidden): no fiat/native
     * oracle is introduced in this correction step, so the threshold is in
     * raw base units and cannot account for the token's market value or the
     * native gas price. Operators must set per-asset minimums; the ETH path
     * retains the true native gas-cost dust check.
     */
    private static getMinTokenUnits(asset: string): bigint {
        const raw = (env.CUSTODY_SWEEP_MIN_TOKEN_UNITS || '').trim();
        if (!raw) return 0n;
        for (const pair of raw.split(',')) {
            const [k, v] = pair.split('=').map(s => s.trim());
            if (k && v && k.toUpperCase() === asset.toUpperCase()) {
                try {
                    const parsed = BigInt(v);
                    return parsed < 0n ? 0n : parsed;
                } catch {
                    return 0n; // Malformed config must never brick sweeps.
                }
            }
        }
        return 0n;
    }

    /**
     * P2 (Step 6E-4C-2): presence probe for a broadcast sweep transaction.
     * Distinguishes still-pending (in mempool), mined, and dropped (known to
     * neither mempool nor chain). `nonceConsumed` reports whether the chain's
     * latest nonce has moved past the artifact's nonce — strong evidence the
     * original transaction was replaced or a foreign transaction used the
     * same nonce. Replacement identification itself is NOT possible through
     * standard RPC without a historical scan — documented limitation; the
     * state is left explicitly unresolved (STALE_BROADCAST) rather than
     * guessed.
     */
    public async getSweepTxPresence(
        txHash: string,
        network: string,
        expectedNonce?: number
    ): Promise<{ present: boolean; mined: boolean; nonceConsumed: boolean | null }> {
        const conf = this.config[network];
        if (!conf) throw new Error(`Network ${network} not supported`);

        const provider = new ethers.JsonRpcProvider(conf.rpcUrl);

        let mined = false;
        let present = false;
        try {
            const receipt = await provider.getTransactionReceipt(txHash);
            if (receipt) {
                mined = true;
                present = true;
            }
        } catch { /* treat as not visible yet */ }
        if (!present) {
            try {
                const tx = await provider.getTransaction(txHash);
                present = !!tx;
            } catch { /* treat as not visible */ }
        }

        let nonceConsumed: boolean | null = null;
        if (expectedNonce != null) {
            try {
                const latest = await provider.getTransactionCount(await this.getHotWalletAddress(network), 'latest');
                nonceConsumed = latest > expectedNonce;
            } catch {
                nonceConsumed = null;
            }
        }

        return { present, mined, nonceConsumed };
    }

    /**
     * P2 (Step 6E-4C-2): physical-vs-database custody reconciliation for one
     * (network, forwarder, asset) group. PURELY OPERATIONAL — compares
     * on-chain forwarder balance against the DB's expected remaining balance
     * (confirmed deposits not covered by an in-flight or confirmed sweep) and
     * records discrepancies into custody_reconciliation_events. NEVER touches
     * wallet_balances, ledger_entries, or any user-facing balance.
     *
     * Semantics:
     *   DB == chain  → balanced (no event)
     *   DB <  chain  → EXTRA_FUNDS event (physical surplus vs known deposits)
     *   DB >  chain  → SHORTFALL event (funds moved without a recorded
     *                  successful sweep — external movement or lost sweep)
     */
    public async reconcileDepositAddress(
        network: string,
        address: string,
        asset: string
    ): Promise<{ expectedRemaining: string; physical: string; status: 'BALANCED' | 'EXTRA_FUNDS' | 'SHORTFALL' }> {
        const conf = this.config[network];
        if (!conf) throw new Error(`Network ${network} not supported`);
        const provider = new ethers.JsonRpcProvider(conf.rpcUrl);

        // Physical balance now (in base units).
        let physical = 0n;
        let decimals = 18;
        let tokenAddress: string | null = null;
        if (asset === 'ETH') {
            physical = await provider.getBalance(address);
        } else {
            const tokenRes = await this.database.query(
                `SELECT contract_address, decimals FROM asset_networks WHERE asset = $1 AND network = $2 LIMIT 1`,
                [asset, network]
            );
            if (tokenRes.rows.length === 0 || !tokenRes.rows[0].contract_address) {
                throw new Error("Token contract not found in asset_networks");
            }
            tokenAddress = ethers.getAddress(tokenRes.rows[0].contract_address);
            const d = parseInt(tokenRes.rows[0].decimals, 10);
            if (Number.isInteger(d) && d >= 0) decimals = d;
            const erc20 = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], provider);
            physical = await erc20.balanceOf(address);
        }

        // Expected remaining = confirmed deposits for this forwarder+asset
        // NOT covered by a confirmed sweep AND NOT in flight (signed/broadcast
        // artifacts or an open intent mean the funds may legitimately have
        // left the forwarder already — those are not shortfalls).
        const expRes = await this.database.query(
            `SELECT COALESCE(SUM(bd.amount), 0) AS expected_remaining
             FROM blockchain_deposits bd
             LEFT JOIN pending_sweeps ps ON ps.deposit_id = bd.id
             LEFT JOIN sweep_transactions st ON st.tx_hash = ps.sweep_txid
             LEFT JOIN sweep_intents si ON si.id = ps.sweep_intent_id
             WHERE bd.to_address = $1 AND bd.asset = $2 AND bd.network = $3
               AND bd.status = 'CONFIRMED'
               AND (
                     ps.id IS NULL
                     OR (ps.sweep_txid IS NULL AND (ps.sweep_intent_id IS NULL OR si.status IS NULL OR si.status = 'FAILED' OR si.status = 'RECONCILIATION'))
                     OR st.status = 'FAILED'
                   )`,
            [address, asset, network]
        );
        const expectedRemainingRaw = expRes.rows[0]?.expected_remaining ?? '0';
        // Convert the DB human-unit sum into the SAME base units as the chain
        // balance so the comparison is scale-correct (USDT=6, ETH=18, ...).
        const expectedBase = ethers.parseUnits(String(expectedRemainingRaw), decimals);

        let status: 'BALANCED' | 'EXTRA_FUNDS' | 'SHORTFALL';
        if (physical === expectedBase) {
            status = 'BALANCED';
        } else if (physical > expectedBase) {
            status = 'EXTRA_FUNDS';
        } else {
            status = 'SHORTFALL';
        }

        if (status !== 'BALANCED') {
            await this.database.query(
                `INSERT INTO custody_reconciliation_events (network, address, asset, kind, expected_amount, physical_amount, details)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    network,
                    address,
                    asset,
                    status,
                    expectedRemainingRaw,
                    (Number(physical) / Math.pow(10, decimals)).toString(),
                    JSON.stringify({ physicalBaseUnits: physical.toString(), expectedBaseUnits: expectedBase.toString(), decimals }),
                ]
            );
        }

        return {
            expectedRemaining: expectedRemainingRaw,
            physical: (Number(physical) / Math.pow(10, decimals)).toString(),
            status,
        };
    }
}