-- Migration 016: Create Asset Networks Table (Phase 9.1 — Asset + Network Architecture)
--
-- Models the (asset, network) pairing explicitly: a token symbol alone does NOT
-- identify a blockchain asset (e.g. USDT on Ethereum ERC-20 vs USDT on Tron TRC-20
-- are distinct (asset, network) rows).
--
-- Additive only: does not alter migrations 001–015, the assets table, wallet
-- balances, the double-entry ledger, or any trading/futures schema.
--
-- NOTE ON DECIMALS: `decimals` here is the ON-CHAIN native token precision for the
-- given network (e.g. USDT/USDC ERC-20 = 6, ETH = 18, BTC = 8). This is DISTINCT
-- from `assets.decimals` (migration 002), which is the internal ledger display
-- precision (8) used by the frozen Phase 4 wallet math. The two must not be conflated.

-- 1. Asset Networks Table
CREATE TABLE IF NOT EXISTS asset_networks (
    asset VARCHAR(20) NOT NULL REFERENCES assets(symbol),
    network VARCHAR(32) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    decimals INT NOT NULL DEFAULT 8 CHECK (decimals >= 0),
    confirmations_required INT NOT NULL DEFAULT 12 CHECK (confirmations_required >= 1),
    min_deposit NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (min_deposit >= 0),
    min_withdrawal NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (min_withdrawal >= 0),
    withdrawal_fee NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (withdrawal_fee >= 0),
    contract_address VARCHAR(255),
    address_format VARCHAR(32) NOT NULL DEFAULT 'EVM_HEX',
    requires_memo BOOLEAN NOT NULL DEFAULT FALSE,
    network_metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (asset, network)
);

CREATE INDEX IF NOT EXISTS idx_asset_networks_active ON asset_networks(is_active);
CREATE INDEX IF NOT EXISTS idx_asset_networks_network ON asset_networks(network);

-- 2. Seed approved Phase 9.1 initial asset/network pairs (Phase 9.0 decision)
--    Initial scope: USDT-ERC20, USDC-ERC20, BTC, ETH.
--    contract_address values are the well-known public token addresses; they MUST be
--    re-verified against the chosen custody provider's canonical asset registry
--    during provider integration (Phase 9.2/9.3) before any deposit is enabled.
INSERT INTO asset_networks
    (asset, network, is_active, decimals, confirmations_required,
     min_deposit, min_withdrawal, withdrawal_fee, contract_address,
     address_format, requires_memo, network_metadata)
VALUES
    ('USDT', 'ETHEREUM', TRUE, 6, 12, '10', '10', '1',
     '0xdAC17F958D2ee523a2206206994597C13D831ec7', 'EVM_HEX', FALSE,
     '{"chainId": 1, "tokenStandard": "ERC20", "explorerUrl": "https://etherscan.io"}'),
    ('USDC', 'ETHEREUM', TRUE, 6, 12, '10', '10', '1',
     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'EVM_HEX', FALSE,
     '{"chainId": 1, "tokenStandard": "ERC20", "explorerUrl": "https://etherscan.io"}'),
    ('BTC', 'BITCOIN', TRUE, 8, 2, '0.0001', '0.0001', '0.00005',
     NULL, 'BITCOIN_BECH32', FALSE,
     '{"tokenStandard": "NATIVE", "explorerUrl": "https://mempool.space"}'),
    ('ETH', 'ETHEREUM', TRUE, 18, 12, '0.01', '0.01', '0.005',
     NULL, 'EVM_HEX', FALSE,
     '{"chainId": 1, "tokenStandard": "NATIVE", "explorerUrl": "https://etherscan.io"}')
ON CONFLICT (asset, network) DO NOTHING;
