import fs from 'fs';
import dotenv from 'dotenv';
process.env.HYPERLIQUID_ENV = 'testnet';

const envConfig = dotenv.parse(fs.readFileSync('.env'));
const testnetKey = envConfig.HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY;
const testnetAccount = envConfig.HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS;

if (!testnetKey || !testnetAccount) {
    throw new Error("Missing testnet keys in .env");
}

import { db } from '../src/config/database';
import { HyperliquidAdapter } from '../src/services/liquidity/hyperliquid/hyperliquid.adapter';
import { FuturesHedgeManager } from '../src/services/liquidity/futures-hedge.manager';
import Decimal from 'decimal.js';
import { test } from 'vitest';

const mockExposureGuard = {
  checkPreHedge: async () => {},
  recordHedgeExecution: async () => {},
  evaluateNettingOpportunity: async () => false
} as any;

test('HLP-4 Validation', async () => {
  console.log("==========================================");
  console.log("1. INITIALIZE CLIENTS");
  console.log("==========================================");
  const adapter = new HyperliquidAdapter({
      hyperliquidEnv: 'testnet',
      agentPrivateKey: testnetKey,
      accountAddress: testnetAccount
  });
  const hyperliquidClient = adapter.getClient();

  const futuresHedgeManager = new FuturesHedgeManager(adapter, mockExposureGuard, db as any);

  console.log("==========================================");
  console.log("2. VERIFY FUNDING");
  console.log("==========================================");
  console.log("Target Account:", testnetAccount);

  const state = await hyperliquidClient.getClearinghouseState(testnetAccount);
  console.log("Hyperliquid clearinghouseState:", JSON.stringify(state, null, 2));

  const marginSummary = state.marginSummary;
  console.log("Account Value:", marginSummary.accountValue);
  console.log("Withdrawable:", marginSummary.withdrawable);
  console.log("Total Margin Used:", marginSummary.totalMarginUsed);

  if (new Decimal(marginSummary.accountValue).isZero()) {
     throw new Error("ACCOUNT VALUE IS 0 - STOPPING");
  }

  console.log("==========================================");
  console.log("3. VERIFY TEST ORDER PARAMETERS");
  console.log("==========================================");
  const meta: any = await hyperliquidClient.postInfo({ type: "metaAndAssetCtxs" });
  const universe = meta[0].universe;
  const ctxs = meta[1];
  let assetIndex = -1;
  let szDecimals = 0;
  for (let i = 0; i < universe.length; i++) {
     if (universe[i].name === 'BTC') {
       assetIndex = i;
       szDecimals = universe[i].szDecimals;
     }
  }
  const btcCtx = ctxs[assetIndex];
  console.log("BTC-PERP Mark Price:", btcCtx.markPx);
  console.log("szDecimals:", szDecimals);

  const notional = new Decimal(0.001).mul(btcCtx.markPx);
  console.log("Planned size: 0.001 BTC");
  console.log("Actual Notional:", notional.toFixed(4), "USDC");
  const marginReq = notional.div(20);
  console.log("Estimated Minimum Margin (20x):", marginReq.toFixed(4), "USDC");

  console.log("==========================================");
  console.log("4. PRE-EXECUTION NOVACEX STATE");
  console.log("==========================================");
  const houseExposure = await db.query('SELECT * FROM house_exposure WHERE market = $1', ['BTC-PERP']);
  const intents = await db.query('SELECT * FROM hedge_intents WHERE market = $1', ['BTC-PERP']);
  const extOrders = await db.query('SELECT * FROM external_orders WHERE market = $1', ['BTC-PERP']);
  const extFills = await db.query('SELECT * FROM external_fills WHERE market = $1', ['BTC-PERP']);
  const venuePos = await db.query('SELECT * FROM venue_positions WHERE market = $1', ['BTC-PERP']);
  console.log("house_exposure rows:", houseExposure.rows.length);
  console.log("hedge_intents rows:", intents.rows.length);
  console.log("external_orders rows:", extOrders.rows.length);
  console.log("external_fills rows:", extFills.rows.length);
  console.log("venue_positions rows:", venuePos.rows.length);

  console.log("==========================================");
  console.log("5. CUSTOMER ISOLATION SNAPSHOT");
  console.log("==========================================");
  const balances = await db.query("SELECT SUM(balance) as total FROM balances WHERE asset = 'USDC'");
  console.log("Total Customer USDC Balance:", balances.rows[0].total);

  console.log("==========================================");
  console.log("6. REAL TINY HEDGE");
  console.log("==========================================");
  const intent = await futuresHedgeManager.createHedgeIntent('BTC-PERP', 'BUY', '0.001', 'MANUAL_RISK_POLICY', '0.001');
  console.log("Created Intent:", intent.hedgeIntentId);

  await futuresHedgeManager.executeHedgeIntent(intent);

  console.log("==========================================");
  console.log("7. REAL HYPERLIQUID RESPONSE");
  console.log("==========================================");
  // Wait a moment for async execution processing to persist to DB
  await new Promise(r => setTimeout(r, 2000));

  const updatedIntent = await db.query("SELECT * FROM hedge_intents WHERE hedge_intent_id = $1", [intent.hedgeIntentId]);
  const extOrder = await db.query("SELECT * FROM external_orders WHERE hedge_intent_id = $1", [intent.hedgeIntentId]);

  console.log("Intent Status:", updatedIntent.rows[0]?.status);
  console.log("External Order Status:", extOrder.rows[0]?.status);
  console.log("Filled Qty:", extOrder.rows[0]?.executed_quantity);
  console.log("Venue Order ID:", extOrder.rows[0]?.venue_order_id);

  console.log("==========================================");
  console.log("8. VENUE POSITION");
  console.log("==========================================");
  const state2 = await hyperliquidClient.getClearinghouseState(testnetAccount);
  console.log("Hyperliquid assetPositions:", JSON.stringify(state2.assetPositions, null, 2));

  console.log("==========================================");
  console.log("9. LOCAL PERSISTENCE");
  console.log("==========================================");
  const fills = await db.query("SELECT * FROM external_fills WHERE cloid = $1", [extOrder.rows[0]?.cloid]);
  console.log("External Fills Count:", fills.rows.length);
  if (fills.rows.length > 0) {
      console.log("Fill Price:", fills.rows[0].price);
      console.log("Fill Fee:", fills.rows[0].fee);
  }

  console.log("==========================================");
  console.log("10. CUSTOMER ISOLATION");
  console.log("==========================================");
  const balances2 = await db.query("SELECT SUM(balance) as total FROM balances WHERE asset = 'USDC'");
  console.log("Total Customer USDC Balance AFTER:", balances2.rows[0].total);
  if (balances.rows[0].total !== balances2.rows[0].total) {
      console.log("WARNING: CUSTOMER BALANCE CHANGED");
  } else {
      console.log("Customer isolation verified.");
  }
}, 30000);
