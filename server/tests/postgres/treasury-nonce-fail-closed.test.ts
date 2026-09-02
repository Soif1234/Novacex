import { describe, it, expect, vi, beforeEach } from "vitest";
import { TreasuryManagerService } from "../../src/services/treasury/treasury-manager.service";

vi.mock("ethers", async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        ethers: {
            ...actual.ethers,
            verifyTypedData: vi.fn().mockReturnValue("0xAdminAddress")
        }
    };
});

describe("F1 P0 - Fail-Closed Treasury Nonce", () => {
    let treasuryManager: TreasuryManagerService;
    let treasuryService: any;
    let custodyService: any;
    let safeVerifier: any;
    let mockDb: any;
    let mockTxClient: any;

    beforeEach(() => {
        process.env.TREASURY_SAFE_ADDRESS = "0xSafe";
        process.env.TREASURY_SAFE_OWNER_ADDRESS = "0xAdminAddress";
        process.env.TREASURY_SAFE_CHAIN_ID = "1";

        mockTxClient = {
            query: vi.fn()
        };

        mockDb = {
            query: vi.fn(),
            transaction: vi.fn(async (cb) => {
                return await cb(mockTxClient);
            })
        };

        treasuryService = {
            getDatabase: () => mockDb,
            insertTreasuryTransaction: vi.fn(),
            getDomainConfig: () => ({
                trustedOwnerAddress: "0xAdminAddress",
                trustedSafeAddress: "0xSafe",
                trustedChainId: 1
            })
        };

        custodyService = {
            isEnabled: () => true
        };

        safeVerifier = {
            verifySafeOnChain: vi.fn().mockResolvedValue(true)
        };

        treasuryManager = new TreasuryManagerService(custodyService, treasuryService, safeVerifier);
    });

    const createArgs = (nonce, intentId) => [
        "ethereum", "ETH", "10", "admin", "0xSig", nonce, Math.floor(Date.now() / 1000) + 1000, intentId
    ];

    it("C. row missing -> rejected", async () => {
        const args = createArgs(0, "intent-missing");

        // Setup mock to return NO ROWS for treasury_config
        mockTxClient.query.mockImplementation(async (sql, params) => {
            if (sql.includes("FROM treasury_config")) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        await expect(treasuryManager.consolidateToSafe(...args)).rejects.toThrow(/treasury_config not initialized for network ethereum/);

        // Ensure no transaction queries were made beyond the nonce check
        expect(mockTxClient.query.mock.calls.filter(call => call[0].includes("INSERT INTO treasury_transactions")).length).toBe(0);
    });

    it("A. row exists + correct nonce -> allowed", async () => {
        const args = createArgs(0, "intent-valid");

        mockTxClient.query.mockImplementation(async (sql, params) => {
            if (sql.includes("FROM treasury_config")) {
                return { rows: [{ admin_nonce: "0" }] }; // Expected nonce 0
            }
            if (sql.includes("UPDATE treasury_config")) {
                return { rows: [] };
            }
            if (sql.includes("INSERT INTO treasury_transactions")) {
                return { rows: [{ id: 1 }] };
            }
            return { rows: [] };
        });

        // The method will ultimately fail when it tries to do custody service stuff which is not mocked,
        // but it will pass the nonce check. Let us mock custodyService.submitTreasuryTransfer to pass.
        custodyService.submitTreasuryTransfer = vi.fn().mockResolvedValue({ id: "withdrawal-1" });

        const res = await treasuryManager.consolidateToSafe(...args);
        expect(res).toBeDefined();

        // Verify nonce was updated
        expect(mockTxClient.query.mock.calls.some(call => call[0].includes("UPDATE treasury_config"))).toBe(true);
    });

    it("B. row exists + wrong nonce -> rejected", async () => {
        const args = createArgs(1, "intent-wrong-nonce");

        mockTxClient.query.mockImplementation(async (sql, params) => {
            if (sql.includes("FROM treasury_config")) {
                return { rows: [{ admin_nonce: "0" }] }; // Expected 1, DB has 0
            }
            return { rows: [] };
        });

        await expect(treasuryManager.consolidateToSafe(...args)).rejects.toThrow(/Invalid nonce. Expected 0, got 1/);
    });
});
