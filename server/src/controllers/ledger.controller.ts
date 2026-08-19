import { Request, Response, NextFunction } from 'express';
import { ledgerService } from '../services/ledger/ledger.service';
import { LedgerTxType } from '../models/ledger.model';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../config/logger';

/**
 * GET /api/v1/ledger/balances
 * Returns all balances for the authenticated user's accounts.
 */
export async function getBalances(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user || !req.accounts) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const accountId = req.query.accountId as string | undefined;
    const asset = req.query.asset as string | undefined;

    // If a specific account is requested, verify ownership
    if (accountId) {
      const isOwned = req.accounts.some(acc => acc.id === accountId);
      if (!isOwned) {
        throw new AppError('Access denied: account does not belong to you', 403, 'OWNERSHIP_DENIED');
      }

      if (asset) {
        const balance = await ledgerService.getBalance(accountId, asset);
        res.json({ success: true, data: { balances: [balance] } });
      } else {
        const balances = await ledgerService.getAllBalances(accountId);
        res.json({ success: true, data: { balances } });
      }
    } else {
      // Return balances for all owned accounts
      const allBalances = [];
      for (const acc of req.accounts) {
        const balances = await ledgerService.getAllBalances(acc.id);
        allBalances.push(...balances);
      }
      res.json({ success: true, data: { balances: allBalances } });
    }
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/ledger/history
 * Returns paginated ledger history for the authenticated user's account.
 */
export async function getHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user || !req.accounts) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const accountId = req.query.accountId as string;
    if (!accountId) {
      throw new AppError('accountId query parameter is required', 400, 'MISSING_ACCOUNT_ID');
    }

    // Verify ownership
    const isOwned = req.accounts.some(acc => acc.id === accountId);
    if (!isOwned) {
      throw new AppError('Access denied: account does not belong to you', 403, 'OWNERSHIP_DENIED');
    }

    const result = await ledgerService.getHistory(accountId, {
      asset: req.query.asset as string | undefined,
      transactionType: req.query.transactionType as LedgerTxType | undefined,
      referenceId: req.query.referenceId as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/ledger/reconcile
 * ADMIN ONLY — reconcile wallet balance against ledger entries.
 * Does NOT auto-fix. Reports discrepancies.
 */
export async function reconcile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const accountId = req.query.accountId as string;
    const asset = req.query.asset as string;

    if (!accountId || !asset) {
      throw new AppError('accountId and asset query parameters are required', 400, 'MISSING_PARAMETERS');
    }

    const result = await ledgerService.reconcile(accountId, asset);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
