import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
    singleThread: true,
    // Restored with the Phase 10.4 stack (checkpoint parity): the shared env
    // schema validates HYPERLIQUID_* keys at import time; tests get inert
    // testnet placeholders so non-liquidity suites are never env-blocked.
    env: {
      HYPERLIQUID_ENV: 'testnet',
      HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY: 'test_key_vitest_mock',
      HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: '0x123',
    }
  },
});
