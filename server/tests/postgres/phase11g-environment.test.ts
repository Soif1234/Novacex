
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TreasuryMonitorService } from "../../src/services/treasury/treasury-monitor.service";
import { SafeVerificationService } from "../../src/services/treasury/safe-verification.service";
import { env } from "../../src/config/env";
import { logger } from "../../src/config/logger";

vi.mock("../../src/config/logger", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }
}));

vi.mock("ethers", async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        ethers: {
            ...actual.ethers,
            JsonRpcProvider: vi.fn().mockImplementation(function() { return {
                getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
                getCode: vi.fn().mockResolvedValue("0x1234"),
                getBlockNumber: vi.fn().mockResolvedValue(100),
                getBlock: vi.fn().mockResolvedValue({ hash: "0xblockhash" }),
            }; }),
            Contract: vi.fn().mockImplementation(function() { return {
                getOwners: vi.fn().mockResolvedValue(["0xOwner"]),
                getThreshold: vi.fn().mockResolvedValue(1n)
            }; })
        }
    };
});

describe("Phase 11G - Environment Readiness & Fail Closed", () => {
    let mockTreasuryService: any;
    let safeVerifier: SafeVerificationService;
    let monitor: TreasuryMonitorService;
    let originalEnv: any;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.TREASURY_SAFE_ADDRESS = "0xSafe";
        process.env.TREASURY_SAFE_OWNER_ADDRESS = "0xOwner";
        process.env.TREASURY_SAFE_CHAIN_ID = "1";
        process.env.RPC_URL = "http://localhost:8545";

        mockTreasuryService = {
            getSyncStatus: vi.fn().mockResolvedValue(null),
            getTreasuryConfig: vi.fn().mockResolvedValue({ allowedTokens: [] }),
            updateSyncStatus: vi.fn().mockResolvedValue(undefined),
            getDatabase: () => ({ transaction: vi.fn() })
        };

        safeVerifier = new SafeVerificationService();
        monitor = new TreasuryMonitorService(mockTreasuryService, safeVerifier, "ETHEREUM");
        vi.clearAllMocks();
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("1. Missing TREASURY_SAFE_ADDRESS -> Monitor fails closed and logs error", async () => {
        delete process.env.TREASURY_SAFE_ADDRESS;
        await monitor.runOnce();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Missing trusted Safe configuration for network"));
        expect(mockTreasuryService.getSyncStatus).not.toHaveBeenCalled();
    });

    it("2. Missing TREASURY_SAFE_OWNER_ADDRESS -> Monitor fails closed", async () => {
        delete process.env.TREASURY_SAFE_OWNER_ADDRESS;
        await monitor.runOnce();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Missing trusted Safe configuration for network"));
        expect(mockTreasuryService.getSyncStatus).not.toHaveBeenCalled();
    });

    it("3. Missing TREASURY_SAFE_CHAIN_ID -> Monitor fails closed", async () => {
        delete process.env.TREASURY_SAFE_CHAIN_ID;
        await monitor.runOnce();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Missing trusted Safe configuration for network"));
        expect(mockTreasuryService.getSyncStatus).not.toHaveBeenCalled();
    });

    it("4. Chain ID mismatch between environment (1337) and provider (1) -> Verifier fails closed", async () => {
        process.env.TREASURY_SAFE_CHAIN_ID = "1337"; // Mismatch!

        await monitor.runOnce();

        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Chain ID mismatch"));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Safe on-chain verification against TRUSTED config failed"));
        expect(mockTreasuryService.getSyncStatus).not.toHaveBeenCalled();
    });

    it("5. RPC Failure (Network error) -> Verifier catches, returns false, Monitor fails closed", async () => {
        // Mock provider to throw
        const { ethers } = await import("ethers");
        ethers.JsonRpcProvider.mockImplementationOnce(function() { return {
            getNetwork: vi.fn().mockRejectedValue(new Error("RPC timeout")),
        }; });

        await monitor.runOnce();

        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Error verifying Safe on chain: RPC timeout"));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Safe on-chain verification against TRUSTED config failed"));
        expect(mockTreasuryService.getSyncStatus).not.toHaveBeenCalled();
    });

    it("6. Safe Drift: EOA instead of contract (code = 0x) -> fails closed", async () => {
        const { ethers } = await import("ethers");
        ethers.JsonRpcProvider.mockImplementationOnce(function() { return {
            getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
            getCode: vi.fn().mockResolvedValue("0x"),
        }; });

        await monitor.runOnce();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("No contract code at"));
        expect(mockTreasuryService.getSyncStatus).not.toHaveBeenCalled();
    });

    it("7. Safe Drift: Wrong owner address -> fails closed", async () => {
        const { ethers } = await import("ethers");
        ethers.Contract.mockImplementationOnce(function() { return {
            getOwners: vi.fn().mockResolvedValue(["0xAttacker"]),
            getThreshold: vi.fn().mockResolvedValue(1n)
        }; });

        await monitor.runOnce();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Owner mismatch. Expected 0xOwner, found 0xattacker"));
        expect(mockTreasuryService.getSyncStatus).not.toHaveBeenCalled();
    });
});
