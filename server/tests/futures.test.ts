import { describe, it, expect, beforeEach } from 'vitest';
import { DatabasePool } from '../src/config/database';
import { FuturesRiskService } from '../src/services/futures/risk.service';
import { FuturesFeeService } from '../src/services/futures/fee.service';
import { FuturesFundingService } from '../src/services/futures/funding.service';
import { FuturesPositionService } from '../src/services/futures/position.service';
import { FuturesLiquidationService } from '../src/services/futures/liquidation.service';
import { FuturesTpSlService } from '../src/services/futures/tpsl.service';
import { FuturesService } from '../src/services/futures/futures.service';
import { DevelopmentMarkPriceProvider } from '../src/services/futures/mark-price.provider';
import { LedgerService } from '../src/services/ledger/ledger.service';
import { WalletService } from '../src/services/wallet/wallet.service';
import { AuthService } from '../src/services/auth/auth.service';
import { SessionService } from '../src/services/auth/session.service';
import { FuturesErrorCode } from '../src/services/futures/errors';
import {
  decimalNormalize,
  decimalCompare,
  decimalAdd,
  decimalSubtract,
  decimalMultiply,
  decimalDivide,
  decimalZero,
} from '../src/services/ledger/decimal';

describe('Server-Side Futures Risk, Margin & Position Engine (Phase 4 Step 8)', () => {
  let database: DatabasePool;
  let ledger: LedgerService;
  let wallet: WalletService;
  let risk: FuturesRiskService;
  let feeSvc: FuturesFeeService;
  let fundingSvc: FuturesFundingService;
  let positions: FuturesPositionService;
  let markPrices: DevelopmentMarkPriceProvider;
  let liquidationSvc: FuturesLiquidationService;
  let tpslSvc: FuturesTpSlService;
  let futures: FuturesService;
  let auth: AuthService;
  let sessions: SessionService;

  let userA: { id: string; email: string; token: string; futuresId: string; spotId: string };
  let userB: { id: string; email: string; token: string; futuresId: string; spotId: string };

  beforeEach(async () => {
    database = new DatabasePool();
    await database.connect();
    database.reset!();

    
    await database.query(`INSERT INTO accounts (id, user_id, type) VALUES ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'SYSTEM_VAULT') ON CONFLICT DO NOTHING`);
    ledger = new LedgerService(database);
    await ledger.credit('11111111-1111-1111-1111-111111111111', 'FUTURES_USDT', '1000000', 'DEPOSIT', 'init_sys_if', 'sys');
    wallet = new WalletService(database, ledger);
    risk = new FuturesRiskService();
    feeSvc = new FuturesFeeService();
    fundingSvc = new FuturesFundingService();
    positions = new FuturesPositionService(database, risk);
    markPrices = new DevelopmentMarkPriceProvider();
    liquidationSvc = new FuturesLiquidationService(database, risk, positions, ledger, markPrices);
    tpslSvc = new FuturesTpSlService(database);
    futures = new FuturesService(database, ledger, risk, positions, feeSvc, markPrices);
    sessions = new SessionService(database);
    auth = new AuthService(database, sessions);

    // Signup User A
    const signupA = await auth.signup({ email: 'futuresTraderA@novacex.io', password: 'Password123!' });
    const loginA = await auth.login({ email: 'futuresTraderA@novacex.io', password: 'Password123!' });
    userA = {
      id: signupA.user.id,
      email: signupA.user.email,
      token: loginA.sessionToken,
      futuresId: signupA.user.accounts.find(a => a.type === 'FUTURES')!.id,
      spotId: signupA.user.accounts.find(a => a.type === 'SPOT')!.id,
    };

    // Signup User B
    const signupB = await auth.signup({ email: 'futuresTraderB@novacex.io', password: 'Password123!' });
    const loginB = await auth.login({ email: 'futuresTraderB@novacex.io', password: 'Password123!' });
    userB = {
      id: signupB.user.id,
      email: signupB.user.email,
      token: loginB.sessionToken,
      futuresId: signupB.user.accounts.find(a => a.type === 'FUTURES')!.id,
      spotId: signupB.user.accounts.find(a => a.type === 'SPOT')!.id,
    };

    // Fund user accounts with paper deposits
    await ledger.credit(
      userA.futuresId,
      'FUTURES_USDT',
      '50000',
      'DEPOSIT',
      `init-dep-${userA.id}`,
      'Initial paper deposit'
    );

    await ledger.credit(
      userB.futuresId,
      'FUTURES_USDT',
      '50000',
      'DEPOSIT',
      `init-dep-${userB.id}`,
      'Initial paper deposit'
    );

  });

  // =========================================================================
  // 1. RISK & MARGIN CALCULATIONS
  // =========================================================================

  describe('1. Risk & Margin Calculations', () => {
    it('1.1 should calculate position notional accurately (Quantity * Price)', () => {
      const notional = risk.calculateNotional('1.5', '50000');
      expect(decimalCompare(notional, '75000')).toBe(0);
    });

    it('1.2 should return zero notional for zero or negative inputs', () => {
      expect(decimalCompare(risk.calculateNotional('0', '50000'), '0')).toBe(0);
      expect(decimalCompare(risk.calculateNotional('1.5', '0'), '0')).toBe(0);
      expect(decimalCompare(risk.calculateNotional('-1', '50000'), '0')).toBe(0);
    });

    it('1.3 should calculate initial margin accurately for 10x leverage (Notional / 10)', () => {
      const im = risk.calculateInitialMargin('1', '50000', 10);
      expect(decimalCompare(im, '5000')).toBe(0);
    });

    it('1.4 should calculate initial margin for maximum 125x leverage', () => {
      const im = risk.calculateInitialMargin('1', '50000', 125);
      expect(decimalCompare(im, '400')).toBe(0);
    });

    it('1.5 should calculate initial margin for 1x (no leverage)', () => {
      const im = risk.calculateInitialMargin('2.5', '20000', 1);
      expect(decimalCompare(im, '50000')).toBe(0);
    });

    it('1.6 should throw on invalid leverage (<1 or >125 or fractional)', () => {
      expect(() => risk.calculateInitialMargin('1', '50000', 0)).toThrow();
      expect(() => risk.calculateInitialMargin('1', '50000', 150)).toThrow();
      expect(() => risk.calculateInitialMargin('1', '50000', 10.5)).toThrow();
    });

    it('1.7 should calculate maintenance margin accurately (Notional * MMR)', () => {
      const mm = risk.calculateMaintenanceMargin('1', '50000', '0.005');
      expect(decimalCompare(mm, '250')).toBe(0);
    });

    it('1.8 should calculate maintenance margin for 1.0% MMR', () => {
      const mm = risk.calculateMaintenanceMargin('10', '150', '0.01');
      expect(decimalCompare(mm, '15')).toBe(0);
    });

    it('1.9 should return true for sufficient available margin', () => {
      expect(risk.hasSufficientMargin('5000', '5000')).toBe(true);
      expect(risk.hasSufficientMargin('10000', '5000')).toBe(true);
    });

    it('1.10 should return false for insufficient available margin', () => {
      expect(risk.hasSufficientMargin('4999.99', '5000')).toBe(false);
      expect(risk.hasSufficientMargin('0', '100')).toBe(false);
    });
  });

  // =========================================================================
  // 2. PNL & VALUATION CALCULATIONS
  // =========================================================================

  describe('2. PnL & Valuation Engine', () => {
    it('2.1 should calculate unrealized profit on LONG position when markPrice > entryPrice', () => {
      const upnl = risk.calculateUnrealizedPnl('LONG', '2', '50000', '52000');
      expect(decimalCompare(upnl, '4000')).toBe(0); // (52000 - 50000) * 2 = 4000
    });

    it('2.2 should calculate unrealized loss on LONG position when markPrice < entryPrice', () => {
      const upnl = risk.calculateUnrealizedPnl('LONG', '2', '50000', '48000');
      expect(decimalCompare(upnl, '-4000')).toBe(0); // (48000 - 50000) * 2 = -4000
    });

    it('2.3 should calculate unrealized profit on SHORT position when markPrice < entryPrice', () => {
      const upnl = risk.calculateUnrealizedPnl('SHORT', '2', '50000', '48000');
      expect(decimalCompare(upnl, '4000')).toBe(0); // (50000 - 48000) * 2 = 4000
    });

    it('2.4 should calculate unrealized loss on SHORT position when markPrice > entryPrice', () => {
      const upnl = risk.calculateUnrealizedPnl('SHORT', '2', '50000', '53000');
      expect(decimalCompare(upnl, '-6000')).toBe(0); // (50000 - 53000) * 2 = -6000
    });

    it('2.5 should calculate realized PnL on LONG close with profit', () => {
      const rpnl = risk.calculateRealizedPnl('LONG', '1', '50000', '55000');
      expect(decimalCompare(rpnl, '5000')).toBe(0);
    });

    it('2.6 should calculate realized PnL on LONG close with loss', () => {
      const rpnl = risk.calculateRealizedPnl('LONG', '1', '50000', '45000');
      expect(decimalCompare(rpnl, '-5000')).toBe(0);
    });

    it('2.7 should calculate realized PnL on SHORT close with profit', () => {
      const rpnl = risk.calculateRealizedPnl('SHORT', '1', '50000', '45000');
      expect(decimalCompare(rpnl, '5000')).toBe(0);
    });

    it('2.8 should calculate realized PnL on SHORT close with loss', () => {
      const rpnl = risk.calculateRealizedPnl('SHORT', '1', '50000', '55000');
      expect(decimalCompare(rpnl, '-5000')).toBe(0);
    });

    it('2.9 should calculate ISOLATED position equity (IM + UPNL)', () => {
      const eqProfit = risk.calculatePositionEquity({
        marginMode: 'ISOLATED',
        side: 'LONG',
        quantity: '1',
        entryPrice: '50000',
        markPrice: '52000',
        initialMargin: '5000',
      });
      expect(decimalCompare(eqProfit, '7000')).toBe(0); // 5000 + 2000 = 7000

      const eqLoss = risk.calculatePositionEquity({
        marginMode: 'ISOLATED',
        side: 'LONG',
        quantity: '1',
        entryPrice: '50000',
        markPrice: '48000',
        initialMargin: '5000',
      });
      expect(decimalCompare(eqLoss, '3000')).toBe(0); // 5000 - 2000 = 3000
    });

    it('2.10 should calculate CROSS position equity (Available + IM + UPNL)', () => {
      const eqCross = risk.calculatePositionEquity(
        {
          marginMode: 'CROSS',
          side: 'LONG',
          quantity: '1',
          entryPrice: '50000',
          markPrice: '52000',
          initialMargin: '5000',
        },
        '10000'
      );
      expect(decimalCompare(eqCross, '17000')).toBe(0); // 10000 + 5000 + 2000 = 17000
    });
  });

  // =========================================================================
  // 3. LIQUIDATION PRICE & MARGIN RATIO
  // =========================================================================

  describe('3. Liquidation Price & Margin Ratio', () => {
    it('3.1 should calculate exact ISOLATED LONG liquidation price: LP = EP + (MM - IM) / QTY', () => {
      // QTY = 1, EP = 50000, IM = 5000 (10x), MM = 250 (0.5% MMR)
      // LP = 50000 + (250 - 5000) / 1 = 50000 - 4750 = 45250
      const lp = risk.calculateLiquidationPrice(
        {
          marginMode: 'ISOLATED',
          side: 'LONG',
          entryPrice: '50000',
          quantity: '1',
          initialMargin: '5000',
          maintenanceMargin: '250',
        },
        '0.005'
      );
      expect(decimalCompare(lp, '45250')).toBe(0);
    });

    it('3.2 should calculate exact ISOLATED SHORT liquidation price: LP = EP + (IM - MM) / QTY', () => {
      // QTY = 1, EP = 50000, IM = 5000 (10x), MM = 250 (0.5% MMR)
      // LP = 50000 + (5000 - 250) / 1 = 50000 + 4750 = 54750
      const lp = risk.calculateLiquidationPrice(
        {
          marginMode: 'ISOLATED',
          side: 'SHORT',
          entryPrice: '50000',
          quantity: '1',
          initialMargin: '5000',
          maintenanceMargin: '250',
        },
        '0.005'
      );
      expect(decimalCompare(lp, '54750')).toBe(0);
    });

    it('3.3 should calculate exact CROSS LONG liquidation price', () => {
      // QTY = 1, EP = 50000, IM = 5000, AM = 5000, MMR = 0.005
      // LP = (50000 * 1 - 5000 - 5000) / (1 * (1 - 0.005)) = 40000 / 0.995 = 40201.005025125628140704
      const lp = risk.calculateLiquidationPrice(
        {
          marginMode: 'CROSS',
          side: 'LONG',
          entryPrice: '50000',
          quantity: '1',
          initialMargin: '5000',
          maintenanceMargin: '250',
        },
        '0.005',
        '5000'
      );
      expect(decimalCompare(lp, '40201.005025125628140703')).toBe(0);
    });


    it('3.4 should calculate exact CROSS SHORT liquidation price', () => {
      // QTY = 1, EP = 50000, IM = 5000, AM = 5000, MMR = 0.005
      // LP = (50000 * 1 + 5000 + 5000) / (1 * (1 + 0.005)) = 60000 / 1.005 = 59701.492537313432835821
      const lp = risk.calculateLiquidationPrice(
        {
          marginMode: 'CROSS',
          side: 'SHORT',
          entryPrice: '50000',
          quantity: '1',
          initialMargin: '5000',
          maintenanceMargin: '250',
        },
        '0.005',
        '5000'
      );
      expect(decimalCompare(lp, '59701.492537313432835820')).toBe(0);
    });


    it('3.5 should evaluate liquidation eligibility accurately (Equity < Maintenance Margin)', () => {
      // Equity = 5000 + (45000 - 50000)*1 = 0 < 250 -> Eligible
      const eligible = risk.checkLiquidation({
        marginMode: 'ISOLATED',
        side: 'LONG',
        entryPrice: '50000',
        markPrice: '45000',
        quantity: '1',
        initialMargin: '5000',
        maintenanceMargin: '250',
      });
      expect(eligible).toBe(true);

      // Equity = 5000 + (49000 - 50000)*1 = 4000 >= 250 -> Not eligible
      const notEligible = risk.checkLiquidation({
        marginMode: 'ISOLATED',
        side: 'LONG',
        entryPrice: '50000',
        markPrice: '49000',
        quantity: '1',
        initialMargin: '5000',
        maintenanceMargin: '250',
      });
      expect(notEligible).toBe(false);
    });

    it('3.6 should calculate margin ratio and risk status (SAFE, WARNING, LIQUIDATION_RISK)', () => {
      // MM = 250, Equity = 1000 -> Ratio = 0.25 -> SAFE
      const rSafe = risk.calculateMarginRatio('250', '1000');
      expect(decimalCompare(rSafe, '0.25')).toBe(0);
      expect(risk.getRiskStatus(rSafe)).toBe('SAFE');

      // MM = 700, Equity = 1000 -> Ratio = 0.70 -> WARNING
      const rWarn = risk.calculateMarginRatio('700', '1000');
      expect(risk.getRiskStatus(rWarn)).toBe('WARNING');

      // MM = 950, Equity = 1000 -> Ratio = 0.95 -> LIQUIDATION_RISK
      const rRisk = risk.calculateMarginRatio('950', '1000');
      expect(risk.getRiskStatus(rRisk)).toBe('LIQUIDATION_RISK');

      // Zero or negative equity -> Ratio = 1.0 (100% risk)
      const rZero = risk.calculateMarginRatio('250', '0');
      expect(decimalCompare(rZero, '1')).toBe(0);
      expect(risk.getRiskStatus(rZero)).toBe('LIQUIDATION_RISK');
    });
  });

  // =========================================================================
  // 4. TRADING FEES & FUNDING
  // =========================================================================

  describe('4. Trading Fees & Funding Calculations', () => {
    it('4.1 should compute maker fee (0.02%) and taker fee (0.05%) accurately', () => {
      const maker = feeSvc.calculateExecutionFee('1', '50000', true);
      expect(maker.feeType).toBe('MAKER');
      expect(decimalCompare(maker.feeAmount, '10')).toBe(0); // 50000 * 0.0002 = 10

      const taker = feeSvc.calculateExecutionFee('1', '50000', false);
      expect(taker.feeType).toBe('TAKER');
      expect(decimalCompare(taker.feeAmount, '25')).toBe(0); // 50000 * 0.0005 = 25
    });

    it('4.2 should calculate estimated funding payments (Long pays when rate > 0, Short receives)', () => {
      fundingSvc.setFundingRate('0.0001'); // +0.01%
      const longPayment = fundingSvc.calculateEstimatedFunding(
        {
          id: 'pos-1',
          accountId: userA.futuresId,
          symbol: 'BTCUSDT',
          side: 'LONG',
          quantity: '1',
          entryPrice: '50000',
          markPrice: '50000',
          liquidationPrice: '45250',
          leverage: 10,
          marginMode: 'ISOLATED',
          initialMargin: '5000',
          maintenanceMargin: '250',
          realizedPnl: '0',
          status: 'OPEN',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        '50000',
        '0.0001'
      );
      // Long pays positive rate -> negative funding amount
      expect(decimalCompare(longPayment, '-5')).toBe(0); // 50000 * 0.0001 = 5

      const shortPayment = fundingSvc.calculateEstimatedFunding(
        {
          id: 'pos-2',
          accountId: userA.futuresId,
          symbol: 'BTCUSDT',
          side: 'SHORT',
          quantity: '1',
          entryPrice: '50000',
          markPrice: '50000',
          liquidationPrice: '54750',
          leverage: 10,
          marginMode: 'ISOLATED',
          initialMargin: '5000',
          maintenanceMargin: '250',
          realizedPnl: '0',
          status: 'OPEN',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        '50000',
        '0.0001'
      );
      // Short receives positive rate -> positive funding amount
      expect(decimalCompare(shortPayment, '5')).toBe(0);
    });
  });

  // =========================================================================
  // 5. POSITION SERVICE LIFECYCLE
  // =========================================================================

  describe('5. Futures Position Lifecycle', () => {
    it('5.1 should create a new OPEN position with accurate margin requirements and LP', async () => {
      const pos = await positions.createPosition({
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'LONG',
        quantity: '1',
        entryPrice: '50000',
        leverage: 10,
        marginMode: 'ISOLATED',
        maintenanceMarginRate: '0.005',
      });

      expect(pos.status).toBe('OPEN');
      expect(decimalCompare(pos.initialMargin, '5000')).toBe(0);
      expect(decimalCompare(pos.maintenanceMargin, '250')).toBe(0);
      expect(decimalCompare(pos.liquidationPrice, '45250')).toBe(0);
      expect(pos.side).toBe('LONG');
    });

    it('5.2 should increase position quantity and compute weighted average entry price', async () => {
      const pos = await positions.createPosition({
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'LONG',
        quantity: '1',
        entryPrice: '50000',
        leverage: 10,
        marginMode: 'ISOLATED',
        maintenanceMarginRate: '0.005',
      });

      // Add 1 BTC @ 60,000 -> Total 2 BTC, new entry price = (50000 + 60000)/2 = 55000
      const increased = await positions.increasePosition(pos, '1', '60000', '0.005');

      expect(decimalCompare(increased.quantity, '2')).toBe(0);
      expect(decimalCompare(increased.entryPrice, '55000')).toBe(0);
      expect(decimalCompare(increased.initialMargin, '11000')).toBe(0); // 5000 + 6000 = 11000
      expect(decimalCompare(increased.maintenanceMargin, '550')).toBe(0); // 110000 * 0.005 = 550
    });

    it('5.3 should partially reduce position quantity, retain entry price, and calculate realized PnL', async () => {
      const pos = await positions.createPosition({
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'LONG',
        quantity: '2',
        entryPrice: '50000',
        leverage: 10,
        marginMode: 'ISOLATED',
        maintenanceMarginRate: '0.005',
      });

      // Reduce 1 BTC @ 55,000 -> Realized PnL = (55000 - 50000)*1 = 5000 profit
      const result = await positions.reducePosition(pos, '1', '55000', '0.005');

      expect(decimalCompare(result.realizedPnl, '5000')).toBe(0);
      expect(decimalCompare(result.freedMargin, '5000')).toBe(0);
      expect(result.updatedPosition.status).toBe('OPEN');
      expect(decimalCompare(result.updatedPosition.quantity, '1')).toBe(0);
      expect(decimalCompare(result.updatedPosition.entryPrice, '50000')).toBe(0); // Unchanged!
      expect(decimalCompare(result.updatedPosition.initialMargin, '5000')).toBe(0);
    });

    it('5.4 should fully close position, set status to CLOSED, and zero out initial margin', async () => {
      const pos = await positions.createPosition({
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'LONG',
        quantity: '1',
        entryPrice: '50000',
        leverage: 10,
        marginMode: 'ISOLATED',
        maintenanceMarginRate: '0.005',
      });

      const result = await positions.reducePosition(pos, '1', '52000', '0.005');

      expect(result.updatedPosition.status).toBe('CLOSED');
      expect(decimalCompare(result.updatedPosition.quantity, '0')).toBe(0);
      expect(decimalCompare(result.updatedPosition.initialMargin, '0')).toBe(0);
      expect(decimalCompare(result.updatedPosition.maintenanceMargin, '0')).toBe(0);
      expect(decimalCompare(result.realizedPnl, '2000')).toBe(0);
    });
  });

  // =========================================================================
  // 6. SERVER-SIDE FUTURES TRADING ENGINE & ORDER LIFECYCLE
  // =========================================================================

  describe('6. Server-Side Futures Trading Service', () => {
    it('6.1 should place and execute a MARKET opening LONG order with margin lock & fee', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      const initialBal = await ledger.getBalance(userA.futuresId, 'FUTURES_USDT');
      expect(decimalCompare(initialBal.availableBalance, '50000')).toBe(0);

      // Buy 1 BTC LONG @ 50,000 with 10x leverage (Required margin = 5,000 USDT, Taker fee = 25 USDT)
      const res = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      expect(res.order.status).toBe('FILLED');
      expect(res.position).toBeDefined();
      expect(res.position?.status).toBe('OPEN');
      expect(decimalCompare(res.position!.quantity, '1')).toBe(0);
      expect(decimalCompare(res.position!.entryPrice, '50000')).toBe(0);
      expect(decimalCompare(res.trade!.fee, '25')).toBe(0);

      // Check balance: 50,000 - 5,000 (locked in position) - 25 (fee) = 44,975 available
      const postBal = await ledger.getBalance(userA.futuresId, 'FUTURES_USDT');
      expect(decimalCompare(postBal.availableBalance, '44975')).toBe(0);
      expect(decimalCompare(postBal.lockedBalance, '5000')).toBe(0);
    });

    it('6.2 should place and execute a MARKET opening SHORT order', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      // Sell 1 BTC SHORT @ 50,000 with 10x leverage
      const res = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'SHORT',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      expect(res.order.status).toBe('FILLED');
      expect(res.position?.side).toBe('SHORT');
      expect(decimalCompare(res.position!.quantity, '1')).toBe(0);
      expect(decimalCompare(res.position!.liquidationPrice, '54750')).toBe(0);
    });

    it('6.3 should close a LONG position at profit, credit PnL and return locked margin', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      // 1. Open 1 BTC LONG @ 50,000
      await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      // Price rises to 55,000 (+5,000 profit)
      markPrices.setMarkPrice('BTCUSDT', '55000');

      // 2. Close 1 BTC LONG via SELL order
      const closeRes = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
        closePosition: true,
      });

      expect(closeRes.order.status).toBe('FILLED');
      expect(closeRes.position?.status).toBe('CLOSED');

      // Margin released (5,000) + Realized profit (5,000) - Taker fees (25 + 27.50)
      // 50,000 + 5,000 - 25 - 27.5 = 54,947.50
      const finalBal = await ledger.getBalance(userA.futuresId, 'FUTURES_USDT');
      expect(decimalCompare(finalBal.availableBalance, '54947.5')).toBe(0);
      expect(decimalCompare(finalBal.lockedBalance, '0')).toBe(0); // original opening lock is separate
    });

    it('6.4 should close a LONG position at loss and debit realized loss', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      // 1. Open 1 BTC LONG @ 50,000
      await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      // Price drops to 48,000 (-2,000 loss)
      markPrices.setMarkPrice('BTCUSDT', '48000');

      // 2. Close 1 BTC LONG
      await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
        closePosition: true,
      });

      // Net credit = Freed Margin (5000) - Loss (2000) = +3000 returned to available
      // Available = 44975 + 3000 - 24 (close fee: 48000*0.0005) = 47951
      const finalBal = await ledger.getBalance(userA.futuresId, 'FUTURES_USDT');
      expect(decimalCompare(finalBal.availableBalance, '47951')).toBe(0);
    });

    it('6.5 should place a resting LIMIT order with reserved margin and cancel it releasing margin', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      // Place BUY LIMIT order below market @ 45,000 (1 BTC, 10x leverage -> requires 4,500 USDT)
      const res = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'LIMIT',
        price: '45000',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      expect(res.order.status).toBe('NEW');
      expect(decimalCompare(res.order.lockedAmount, '4500')).toBe(0);

      const lockedBal = await ledger.getBalance(userA.futuresId, 'FUTURES_USDT');
      expect(decimalCompare(lockedBal.availableBalance, '45500')).toBe(0); // 50000 - 4500
      expect(decimalCompare(lockedBal.lockedBalance, '4500')).toBe(0);

      // Cancel the limit order
      const cancelled = await futures.cancelOrder(userA.id, res.order.id);
      expect(cancelled.status).toBe('CANCELLED');

      const refundedBal = await ledger.getBalance(userA.futuresId, 'FUTURES_USDT');
      expect(decimalCompare(refundedBal.availableBalance, '50000')).toBe(0);
      expect(decimalCompare(refundedBal.lockedBalance, '0')).toBe(0);
    });

    it('6.6 should reject order when available margin is insufficient', async () => {
      // User A has 50,000 USDT. Trying to open 20 BTC @ 50,000 with 10x leverage requires 100,000 USDT
      await expect(
        futures.placeOrder({
          userId: userA.id,
          accountId: userA.futuresId,
          symbol: 'BTCUSDT',
          side: 'BUY',
          positionSide: 'LONG',
          type: 'MARKET',
          quantity: '20',
          leverage: 10,
          marginMode: 'ISOLATED',
        })
      ).rejects.toThrow(/Insufficient margin collateral/i);

      // Balance untouched
      const bal = await ledger.getBalance(userA.futuresId, 'FUTURES_USDT');
      expect(decimalCompare(bal.availableBalance, '50000')).toBe(0);
    });

    it('6.7 should reject closing order when no open position exists', async () => {
      await expect(
        futures.placeOrder({
          userId: userA.id,
          accountId: userA.futuresId,
          symbol: 'BTCUSDT',
          side: 'SELL',
          positionSide: 'LONG',
          type: 'MARKET',
          quantity: '1',
          leverage: 10,
          marginMode: 'ISOLATED',
          closePosition: true,
        })
      ).rejects.toThrow(/no open LONG position found/i);
    });

    it('6.8 should enforce leverage consistency when increasing existing position', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      // Open initial position at 10x
      await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      // Attempt to increase position with 20x leverage -> Reject
      await expect(
        futures.placeOrder({
          userId: userA.id,
          accountId: userA.futuresId,
          symbol: 'BTCUSDT',
          side: 'BUY',
          positionSide: 'LONG',
          type: 'MARKET',
          quantity: '1',
          leverage: 20,
          marginMode: 'ISOLATED',
        })
      ).rejects.toThrow(/does not match existing position leverage/i);
    });

    it('6.9 should provide idempotency with clientOrderId', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      const clientOrderId = 'client-order-12345';
      const res1 = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
        clientOrderId,
      });

      const res2 = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
        clientOrderId,
      });

      expect(res1.order.id).toBe(res2.order.id);
    });
  });

  // =========================================================================
  // 7. LIQUIDATION ENGINE
  // =========================================================================

  describe('7. Server-Side Liquidation Service', () => {
    it('7.1 should liquidate position when price crosses liquidation price', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      // 1. Open 1 BTC LONG @ 50,000 (10x, ISOLATED). LP is 45,250
      const openRes = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      const positionId = openRes.position!.id;

      // Price crashes to 44,000 (below LP 45,250)
      markPrices.setMarkPrice('BTCUSDT', '44000');

      // 2. Trigger liquidation evaluation
      const liq = await liquidationSvc.evaluateAndLiquidate(positionId, '44000');

      expect(liq).toBeDefined();
      expect(liq.positionId).toBe(positionId);
      expect(decimalCompare(liq.lossAmount, '-6000')).toBe(0);

      // Verify position status is LIQUIDATED
      const postPos = await positions.getPositionById(positionId);
      expect(postPos?.status).toBe('LIQUIDATED');
    });

    it('7.2 should reject liquidation when position is not eligible (Equity >= MM)', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      const openRes = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      // Price is 49,000 (Equity = 4,000 >= MM 250) -> Ineligible
      await expect(
        liquidationSvc.evaluateAndLiquidate(openRes.position!.id, '49000')
      ).rejects.toThrow(/not eligible for liquidation/i);
    });

    it('7.3 should reject liquidation on already liquidated position', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      const openRes = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      await liquidationSvc.evaluateAndLiquidate(openRes.position!.id, '44000');

      // Second attempt
      await expect(
        liquidationSvc.evaluateAndLiquidate(openRes.position!.id, '44000')
      ).rejects.toThrow(/already been liquidated/i);
    });

  });

  // =========================================================================
  // 8. TAKE-PROFIT & STOP-LOSS CONFIGURATION
  // =========================================================================

  describe('8. TP/SL Service', () => {
    it('8.1 should configure TP/SL on an open position', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      const openRes = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      const config = await tpslSvc.setConfig({
        userId: userA.id,
        positionId: openRes.position!.id,
        takeProfitEnabled: true,
        takeProfitPrice: '55000',
        stopLossEnabled: true,
        stopLossPrice: '48000',
      });

      expect(config.takeProfitEnabled).toBe(true);
      expect(decimalCompare(config.takeProfitPrice!, '55000')).toBe(0);
      expect(config.stopLossEnabled).toBe(true);
      expect(decimalCompare(config.stopLossPrice!, '48000')).toBe(0);

      const retrieved = await tpslSvc.getConfigForPosition(openRes.position!.id);
      expect(retrieved?.id).toBe(config.id);
    });

    it('8.2 should reject TP/SL configuration from non-owner user', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      const openRes = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      // User B attempts to configure TP/SL on User A's position
      await expect(
        tpslSvc.setConfig({
          userId: userB.id,
          positionId: openRes.position!.id,
          takeProfitEnabled: true,
          takeProfitPrice: '55000',
        })
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // 9. QUERIES & STATE RECOVERY
  // =========================================================================

  describe('9. Queries & State Recovery', () => {
    it('9.1 should query user positions with ownership verification', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      const userAPositions = await futures.getPositions(userA.id);
      expect(userAPositions.length).toBe(1);

      const userBPositions = await futures.getPositions(userB.id);
      expect(userBPositions.length).toBe(0);
    });

    it('9.2 should query order history and trade history', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      const orders = await futures.getOrderHistory(userA.id);
      expect(orders.length).toBe(1);

      const trades = await futures.getTradeHistory(userA.id);
      expect(trades.length).toBe(1);
      expect(trades[0].symbol).toBe('BTCUSDT');
    });

    it('9.3 should recover active futures state from database on startup', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      const recovery = await futures.recoverFuturesState();
      expect(recovery.openPositionsCount).toBe(1);
    });

    it('9.4 should open and close positions in CROSS margin mode', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      const openCross = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'CROSS',
      });

      expect(openCross.position?.marginMode).toBe('CROSS');
      expect(openCross.position?.status).toBe('OPEN');

      // Close position
      const closeCross = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'CROSS',
        closePosition: true,
      });

      expect(closeCross.position?.status).toBe('CLOSED');
    });

    it('9.5 should trade ETHUSDT with contract-specific MMR and leverage limits', async () => {
      markPrices.setMarkPrice('ETHUSDT', '3000');

      // ETH has 100x max leverage and 0.005 MMR
      const res = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'ETHUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '10',
        leverage: 50,
        marginMode: 'ISOLATED',
      });

      expect(res.position?.symbol).toBe('ETHUSDT');
      expect(decimalCompare(res.position!.entryPrice, '3000')).toBe(0);
      // Notional = 30,000, Initial Margin = 30000 / 50 = 600
      expect(decimalCompare(res.position!.initialMargin, '600')).toBe(0);
      // Maintenance Margin = 30000 * 0.005 = 150
      expect(decimalCompare(res.position!.maintenanceMargin, '150')).toBe(0);
    });

    it('9.6 should trade SOLUSDT with contract-specific MMR and leverage limits', async () => {
      markPrices.setMarkPrice('SOLUSDT', '150');

      // SOL has 50x max leverage and 0.01 MMR
      const res = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'SOLUSDT',
        side: 'SELL',
        positionSide: 'SHORT',
        type: 'MARKET',
        quantity: '100',
        leverage: 20,
        marginMode: 'ISOLATED',
      });

      expect(res.position?.symbol).toBe('SOLUSDT');
      expect(decimalCompare(res.position!.entryPrice, '150')).toBe(0);
      // Notional = 15,000, Initial Margin = 15000 / 20 = 750
      expect(decimalCompare(res.position!.initialMargin, '750')).toBe(0);
      // Maintenance Margin = 15000 * 0.01 = 150
      expect(decimalCompare(res.position!.maintenanceMargin, '150')).toBe(0);
    });

    it('9.7 should reject orders with quantity below contract minimum', async () => {
      // BTC minimum is 0.001
      await expect(
        futures.placeOrder({
          userId: userA.id,
          accountId: userA.futuresId,
          symbol: 'BTCUSDT',
          side: 'BUY',
          positionSide: 'LONG',
          type: 'MARKET',
          quantity: '0.0001',
          leverage: 10,
          marginMode: 'ISOLATED',
        })
      ).rejects.toThrow(/below minimum required/i);
    });

    it('9.8 should reject LIMIT orders without a limit price', async () => {
      await expect(
        futures.placeOrder({
          userId: userA.id,
          accountId: userA.futuresId,
          symbol: 'BTCUSDT',
          side: 'BUY',
          positionSide: 'LONG',
          type: 'LIMIT',
          quantity: '1',
          leverage: 10,
          marginMode: 'ISOLATED',
        })
      ).rejects.toThrow(/Limit price is required/i);
    });


    it('9.9 should retrieve open orders filtered by symbol', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');
      markPrices.setMarkPrice('ETHUSDT', '3000');

      // Place resting BTC limit
      await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'LIMIT',
        price: '40000',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      // Place resting ETH limit
      await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'ETHUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'LIMIT',
        price: '2000',
        quantity: '5',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      const allOpen = await futures.getOpenOrders(userA.id);
      expect(allOpen.length).toBe(2);

      const btcOpen = await futures.getOpenOrders(userA.id, 'BTCUSDT');
      expect(btcOpen.length).toBe(1);
      expect(btcOpen[0].symbol).toBe('BTCUSDT');
    });

    it('9.10 should retrieve single position and single order by ID with ownership verification', async () => {
      markPrices.setMarkPrice('BTCUSDT', '50000');

      const openRes = await futures.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      const pos = await futures.getPosition(userA.id, openRes.position!.id);
      expect(pos.id).toBe(openRes.position!.id);

      const ord = await futures.getOrder(userA.id, openRes.order.id);
      expect(ord.id).toBe(openRes.order.id);

      // User B cannot access User A's position or order
      await expect(futures.getPosition(userB.id, openRes.position!.id)).rejects.toThrow();
      await expect(futures.getOrder(userB.id, openRes.order.id)).rejects.toThrow();
    });

  });
});
