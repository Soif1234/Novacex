import { INSURANCE_FUND_ACCOUNT_ID } from './insurance-fund.service';
import { ADL_SUSPENSE_ACCOUNT_ID } from './adl.service';
import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { FuturesLiquidationEntity, PositionSide } from '../../models/futures.model';
import { futuresRiskService, FuturesRiskService } from './risk.service';
import { futuresPositionService, FuturesPositionService } from './position.service';
import { developmentMarkPriceProvider, IMarkPriceProvider } from './mark-price.provider';
import { LedgerService, ledgerService } from '../ledger/ledger.service';
import {
  PositionNotFoundError,
  PositionAlreadyLiquidatedError,
  LiquidationNotEligibleError,
} from './errors';
import { decimalCompare, decimalNormalize, decimalZero, decimalSubtract, decimalAdd, decimalDivide, decimalMultiply } from '../ledger/decimal';
import { eventBus } from '../market/event-bus';
import { logger } from '../../config/logger';



export interface LiquidationPolicy {
    partialReductionStepPct: string;
    minimumNotionalBypass: string;
}

export const TEST_ONLY_DEFAULT_LIQUIDATION_POLICY: LiquidationPolicy = {
    partialReductionStepPct: '0.5',
    minimumNotionalBypass: '100',
};

export class FuturesLiquidationService {
  constructor(
    private database: IDatabaseConnection = db,
    private risk: FuturesRiskService = futuresRiskService,
    private positions: FuturesPositionService = futuresPositionService,
    private ledger: LedgerService = ledgerService,
    private markPrices: IMarkPriceProvider = developmentMarkPriceProvider
  ) {}

  public async evaluateAndLiquidate(positionId: string, overrideMarkPrice?: string): Promise<any> {
    
    // We wrap the entire liquidation in a single atomic transaction
    const { liquidation, position, markPrice, totalRealizedPnl, totalFee, totalReturn, deficit, finalStatus } = await this.database.transaction(async (txClient) => {
      // 1. Lock the position row for update to prevent concurrent liquidations
      const res = await txClient.query<any>('SELECT * FROM futures_positions WHERE id = $1 FOR UPDATE', [positionId]);
      const row = res.rows[0];
      if (!row) {
        throw new PositionNotFoundError(positionId);
      }
      if (row.status !== 'OPEN') {
        throw new PositionAlreadyLiquidatedError(positionId);
      }
      
      const pos = await this.positions.getPositionById(positionId); 
      if (!pos) throw new PositionNotFoundError(positionId);
      if (pos.status !== 'OPEN') throw new PositionAlreadyLiquidatedError(positionId);

      const mark = overrideMarkPrice
        ? decimalNormalize(overrideMarkPrice)
        : await this.markPrices.getMarkPrice(pos.symbol);

      pos.markPrice = mark;

      const [usdtRowRes, futRowRes] = await Promise.all([
        txClient.query<any>('SELECT available_balance, locked_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2', [pos.accountId, 'USDT']),
        txClient.query<any>('SELECT available_balance, locked_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2', [pos.accountId, 'FUTURES_USDT']),
      ]);

      const usdtRow = usdtRowRes.rows[0];
      const futRow = futRowRes.rows[0];
      let collateralAsset = 'FUTURES_USDT';
      let currentAvail = '0';

      const usdtLocked = usdtRow ? String(usdtRow.locked_balance ?? usdtRow.lockedBalance ?? '0') : '0';
      const futLocked = futRow ? String(futRow.locked_balance ?? futRow.lockedBalance ?? '0') : '0';

      if (usdtRow && decimalCompare(usdtLocked, '0') > 0) {
        collateralAsset = 'USDT';
        currentAvail = String(usdtRow.available_balance ?? usdtRow.availableBalance ?? '0');
      } else if (futRow && decimalCompare(futLocked, '0') > 0) {
        collateralAsset = 'FUTURES_USDT';
        currentAvail = String(futRow.available_balance ?? futRow.availableBalance ?? '0');
      } else if (usdtRow && decimalCompare(String(usdtRow.available_balance ?? usdtRow.availableBalance ?? '0'), '0') > 0) {
        collateralAsset = 'USDT';
        currentAvail = String(usdtRow.available_balance ?? usdtRow.availableBalance ?? '0');
      } else if (futRow) {
        collateralAsset = 'FUTURES_USDT';
        currentAvail = String(futRow.available_balance ?? futRow.availableBalance ?? '0');
      }




      const isEligible = this.risk.checkLiquidation(pos, currentAvail);
      if (!isEligible) {
        const equity = this.risk.calculatePositionEquity(pos, currentAvail);
        throw new LiquidationNotEligibleError(positionId, equity, pos.maintenanceMargin);
      }

      const cleanMarkPrice = decimalNormalize(mark);
      
      let remainingQuantity = pos.quantity;
      let remainingIM = pos.initialMargin;
      
      let totalReducedQuantity = '0';
      let totalRealizedPnl = '0';
      let totalFee = '0';
      let totalInsuranceDelta = '0';
      
      // We will aggregate all financial impacts and hit the ledger ONCE
      let totalReleasedIM = '0';
      let totalUserDeduction = '0';
      let totalUserCredit = '0';
      let totalDeficitToInsurance = '0';
      
      let isFullyLiquidated = false;
      let isSafe = false;

      while (!isFullyLiquidated && !isSafe) {
        const mockPos = { 
            ...pos, 
            quantity: remainingQuantity, 
            initialMargin: remainingIM,
            markPrice: cleanMarkPrice,
        };
        const equity = this.risk.calculatePositionEquity(mockPos, currentAvail);
        const mm = this.risk.calculateMaintenanceMargin(remainingQuantity, pos.entryPrice, '0.005');
        mockPos.maintenanceMargin = mm;
        
        if (decimalCompare(equity, mm) >= 0) {
            isSafe = true;
            break;
        }

        let stepQty = remainingQuantity;
        const isBankrupt = decimalCompare(equity, '0') <= 0;
        
        if (!isBankrupt) {
            
              const reductionPct = TEST_ONLY_DEFAULT_LIQUIDATION_POLICY.partialReductionStepPct;
              const minNotional = TEST_ONLY_DEFAULT_LIQUIDATION_POLICY.minimumNotionalBypass;
              const halfQty = decimalMultiply(remainingQuantity, reductionPct);
              const halfNotional = this.risk.calculateNotional(halfQty, cleanMarkPrice);
              if (decimalCompare(halfNotional, minNotional) >= 0) {

                stepQty = halfQty;
            }
        }
        
        if (decimalCompare(stepQty, remainingQuantity) >= 0) {
            stepQty = remainingQuantity;
            isFullyLiquidated = true;
        }

        const stepRatio = decimalDivide(stepQty, remainingQuantity);
        const stepIM = decimalMultiply(remainingIM, stepRatio);
        const stepRPnl = this.risk.calculateUnrealizedPnl(pos.side, stepQty, pos.entryPrice, cleanMarkPrice);
        const stepNotional = this.risk.calculateNotional(stepQty, cleanMarkPrice);
        const stepFee = decimalMultiply(stepNotional, '0.0005');
        
        totalReleasedIM = decimalAdd(totalReleasedIM, stepIM);
        
        const userNet = decimalSubtract(stepRPnl, stepFee);
        
        if (decimalCompare(userNet, '0') > 0) {
            totalUserCredit = decimalAdd(totalUserCredit, userNet);
            currentAvail = decimalAdd(currentAvail, decimalAdd(stepIM, userNet));
            totalInsuranceDelta = decimalAdd(totalInsuranceDelta, stepFee);
        } else {
            // The deduction covers the user's FULL remaining obligation (trading
            // loss plus fee) exactly as before: lossToCover = |userNet| = |PnL - fee|.
            const lossToCover = decimalSubtract('0', userNet);
            const virtualAvail = decimalAdd(currentAvail, stepIM);
            
            let actualDeduction = '0';
            let deficitToInsurance = '0';
            
            if (pos.marginMode === 'ISOLATED') {
               actualDeduction = decimalCompare(stepIM, lossToCover) >= 0 ? lossToCover : stepIM;
            } else {
               actualDeduction = decimalCompare(virtualAvail, lossToCover) >= 0 ? lossToCover : virtualAvail;
            }

            // ADL-recoverable deficit = the UNCOVERED TRADING LOSS only. The
            // trading fee is a separate revenue item, already paid out of the
            // user's deduction and credited to the insurance fund below; folding
            // it into the deficit would make ADL recover the fee a second time
            // (double-count) and overdraw the fund. Clamp at zero so a fully
            // covered liquidation books no deficit, preserving the original
            // fully-covered fee economics.
            const uncoveredObligation = decimalSubtract(lossToCover, actualDeduction);
            deficitToInsurance = decimalSubtract(uncoveredObligation, stepFee);
            if (decimalCompare(deficitToInsurance, '0') < 0) {
                deficitToInsurance = '0';
            }
            
            totalUserDeduction = decimalAdd(totalUserDeduction, actualDeduction);
            totalDeficitToInsurance = decimalAdd(totalDeficitToInsurance, deficitToInsurance);
            
            currentAvail = decimalAdd(currentAvail, stepIM);
            currentAvail = decimalSubtract(currentAvail, actualDeduction);
            
            const insuranceFundNet = decimalSubtract(stepFee, deficitToInsurance);
            totalInsuranceDelta = decimalAdd(totalInsuranceDelta, insuranceFundNet);
        }

        totalReducedQuantity = decimalAdd(totalReducedQuantity, stepQty);
        totalRealizedPnl = decimalAdd(totalRealizedPnl, stepRPnl);
        totalFee = decimalAdd(totalFee, stepFee);

        remainingQuantity = decimalSubtract(remainingQuantity, stepQty);
        remainingIM = decimalSubtract(remainingIM, stepIM);
      }
      
      // Perform ONE ledger transaction for the accumulated amounts
      const liquidationId = crypto.randomUUID();
        const entries: Array<any> = [];
        let adlDraw = '0';
      if (decimalCompare(totalReleasedIM, '0') > 0) {
          entries.push(
              { accountId: pos.accountId, asset: collateralAsset, direction: 'DEBIT', amount: totalReleasedIM, balancePool: 'locked' },
              { accountId: pos.accountId, asset: collateralAsset, direction: 'CREDIT', amount: totalReleasedIM, balancePool: 'available' }
          );
      }
      if (decimalCompare(totalUserCredit, '0') > 0) {
          entries.push({ accountId: pos.accountId, asset: collateralAsset, direction: 'CREDIT', amount: totalUserCredit, balancePool: 'available' });
      }
      if (decimalCompare(totalUserDeduction, '0') > 0) {
          entries.push({ accountId: pos.accountId, asset: collateralAsset, direction: 'DEBIT', amount: totalUserDeduction, balancePool: 'available' });
          const userLoss = decimalSubtract(totalUserDeduction, totalFee);
          if (decimalCompare(userLoss, '0') > 0) {
            entries.push({ accountId: '11111111-1111-1111-1111-111111111111', asset: collateralAsset, direction: 'CREDIT', amount: userLoss, balancePool: 'available' });
          }
      }
      if (decimalCompare(totalFee, '0') > 0) {
          entries.push({ accountId: INSURANCE_FUND_ACCOUNT_ID, asset: collateralAsset, direction: 'CREDIT', amount: totalFee, balancePool: 'available' });
      }

      if (decimalCompare(totalDeficitToInsurance, '0') > 0) {
          const vaultRes = await txClient.query<any>('SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2', [INSURANCE_FUND_ACCOUNT_ID, collateralAsset]);
          const vaultBal = vaultRes.rows[0]?.available_balance || '0';
            let ifDraw = totalDeficitToInsurance;
            adlDraw = '0';
          if (decimalCompare(vaultBal, totalDeficitToInsurance) < 0) {
              ifDraw = vaultBal;
              adlDraw = decimalSubtract(totalDeficitToInsurance, vaultBal);
          }
          if (decimalCompare(ifDraw, '0') > 0) {
              entries.push({ accountId: INSURANCE_FUND_ACCOUNT_ID, asset: collateralAsset, direction: 'DEBIT', amount: ifDraw, balancePool: 'available' });
          }
          if (decimalCompare(adlDraw, '0') > 0) {
              entries.push({ accountId: ADL_SUSPENSE_ACCOUNT_ID, asset: collateralAsset, direction: 'DEBIT', amount: adlDraw, balancePool: 'available' });
          }
          entries.push({ accountId: '11111111-1111-1111-1111-111111111111', asset: collateralAsset, direction: 'CREDIT', amount: totalDeficitToInsurance, balancePool: 'available' });
      }


      
      if (entries.length > 0) {
          const liqStepRef = `FUTURES-LIQ-${pos.id}-${new Date(pos.updatedAt || Date.now()).getTime()}`;
          await this.ledger.postTransaction({

            accountId: pos.accountId,
            transactionType: 'FUTURES_LIQUIDATION',
            referenceId: liqStepRef,
            description: `Futures Liquidation Settlement: ${pos.symbol} ${pos.side} ${totalReducedQuantity} @ ${mark}`,
            entries,}, txClient);
      }

      // Calculate final DB values
      const finalStatus = isFullyLiquidated ? 'LIQUIDATED' : 'OPEN';
      const finalMM = this.risk.calculateMaintenanceMargin(remainingQuantity, pos.entryPrice, '0.005');
      const totalAccumulatedRealizedPnl = decimalAdd(pos.realizedPnl || '0', totalRealizedPnl);

      await txClient.query(
        `UPDATE futures_positions SET
          quantity = $1, mark_price = $2, initial_margin = $3,
          maintenance_margin = $4, liquidation_price = $5, realized_pnl = $6,
          status = $7, updated_at = NOW()
        WHERE id = $8`,
        [remainingQuantity, cleanMarkPrice, remainingIM, finalMM, pos.liquidationPrice, totalAccumulatedRealizedPnl, finalStatus, pos.id]
      );

            const imPerUnit = decimalDivide(pos.initialMargin, pos.quantity);
      const bankruptcyPrice = pos.side === 'LONG' 
          ? decimalSubtract(pos.entryPrice, imPerUnit) 
          : decimalAdd(pos.entryPrice, imPerUnit);

      const liq: FuturesLiquidationEntity = {
        id: liquidationId,
        positionId: pos.id,
        accountId: pos.accountId,
        symbol: pos.symbol,
        side: pos.side,
        quantity: totalReducedQuantity,
        bankruptcyPrice: bankruptcyPrice,
        liquidationPrice: pos.liquidationPrice,
        lossAmount: totalRealizedPnl,
        insuranceFundDelta: totalInsuranceDelta,
        createdAt: new Date(),
      };

      await txClient.query(
        `INSERT INTO futures_liquidations (
          id, position_id, account_id, symbol, side, quantity,
          bankruptcy_price, liquidation_price, loss_amount, insurance_fund_delta, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          liquidationId, liq.positionId, liq.accountId, liq.symbol, liq.side, liq.quantity,
          liq.bankruptcyPrice, liq.liquidationPrice, liq.lossAmount, liq.insuranceFundDelta, liq.createdAt,
        ]
      );

        if (decimalCompare(adlDraw, '0') > 0) {
            await txClient.query(`INSERT INTO futures_adl_events (liquidation_id, symbol, side, target_deficit, status) VALUES ($1, $2, $3, $4, 'PENDING')`, [liquidationId, pos.symbol, pos.side, adlDraw]);
        }

      
      const userTotalNet = decimalSubtract(totalUserCredit, totalUserDeduction);
      let tReturn = '0';
      let def = '0';
      if (decimalCompare(userTotalNet, '0') > 0) {
        tReturn = userTotalNet;
      } else {
        def = decimalSubtract('0', userTotalNet);
      }

      return { ...liq, liquidation: liq, position: { ...pos, quantity: remainingQuantity, initialMargin: remainingIM, maintenanceMargin: finalMM }, markPrice: mark, totalRealizedPnl, totalFee, totalReturn: tReturn, deficit: def, finalStatus };
    });

    try {
      const accRes = await this.database.query<any>('SELECT user_id AS "userId" FROM accounts WHERE id = $1', [position.accountId]);
      const acc = accRes.rows[0];
      const userId = acc ? (acc.userId || acc.user_id) : undefined;

      eventBus.publish({
        id: crypto.randomUUID(),
        type: 'futures.liquidated',
        channel: 'user:positions',
        userId,
        symbol: position.symbol,
        timestamp: Date.now(),
        version: '1.0.0',
        payload: {
          liquidationId: liquidation.id,
          positionId: position.id,
          symbol: position.symbol,
          side: position.side,
          quantity: liquidation.quantity, 
          markPrice,
          lossAmount: totalRealizedPnl,
          fee: totalFee,
          totalReturn: totalReturn,
          timestamp: Date.now(),
        },
      });

      eventBus.publish({
        id: crypto.randomUUID(),
        type: 'futures.position.updated',
        channel: 'user:positions',
        userId,
        symbol: position.symbol,
        timestamp: Date.now(),
        version: '1.0.0',
        payload: {
          positionId: position.id,
          symbol: position.symbol,
          side: position.side,
          quantity: position.quantity,
          entryPrice: position.entryPrice,
          markPrice,
          liquidationPrice: position.liquidationPrice,
          leverage: position.leverage,
          marginMode: position.marginMode,
          realizedPnl: totalRealizedPnl,
          status: finalStatus,
          timestamp: Date.now(),
        },
      });
    } catch (evtErr: any) {
      logger.warn('Failed to emit liquidation events', { error: evtErr.message });
    }

    logger.warn('Futures position partially/fully liquidated', {
      positionId: position.id,
      accountId: position.accountId,
      symbol: position.symbol,
      side: position.side,
      markPrice,
      lossAmount: totalRealizedPnl,
      reducedQuantity: liquidation.quantity,
      remainingQuantity: position.quantity,
      finalStatus
    });

    return { ...liquidation, liquidation, position, markPrice, totalRealizedPnl, totalFee, totalReturn, deficit, finalStatus };
  }

  public async getLiquidations(accountId: string): Promise<FuturesLiquidationEntity[]> {
    const res = await this.database.query<any>(
      'SELECT * FROM futures_liquidations WHERE account_id = $1 ORDER BY created_at DESC',
      [accountId]
    );
    return res.rows.map(r => ({
      id: r.id,
      positionId: r.positionId || r.position_id,
      accountId: r.accountId || r.account_id,
      symbol: r.symbol,
      side: (r.side || r.position_side) as PositionSide,
      quantity: r.quantity,
      bankruptcyPrice: r.bankruptcyPrice || r.bankruptcy_price,
      liquidationPrice: r.liquidationPrice || r.liquidation_price,
      lossAmount: r.lossAmount || r.loss_amount,
      insuranceFundDelta: r.insuranceFundDelta || r.insurance_fund_delta || decimalZero(),
      createdAt: new Date(r.createdAt || r.created_at),
    }));
  }
}

export const futuresLiquidationService = new FuturesLiquidationService();
