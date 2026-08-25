/**
 * Phase 9.4 — Blockchain Monitoring barrel exports
 *
 * Blockchain source abstraction, monitor, and confirmation worker.
 * All sources are provider-neutral and DISABLED unless explicitly configured.
 */

export * from './types';
export * from './blockchain-monitor.service';
export * from './confirmation-worker.service';
export * from './sources/mock-source';
export * from './sources/ethereum-source';
export * from './sources/bitcoin-source';
