import { Request, Response, NextFunction } from 'express';
import { walletService } from '../services/wallet/wallet.service';
import { withdrawalService } from '../services/wallet/withdrawal.service';
import { depositAddressService } from '../services/custody/deposit-address.service';
import { AccountType } from '../models/account.model';
import { LedgerTxType } from '../models/ledger.model';
import { AppError } from '../middleware/errorHandler';

/**
 * GET /api/v1/wallet/balances
 * Retrieves all asset balances across owned accounts for the authenticated user.
 */
export async function getBalances(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const accountId = req.query.accountId as string | undefined;
    const accountType = req.query.accountType as AccountType | undefined;

    const balances = await walletService.getBalances(req.user.id, accountId, accountType);

    res.json({
      success: true,
      data: { balances },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/wallet/admin/paper-deposit
 * Admin-only paper/demo deposit endpoint.
 */
export async function adminPaperDeposit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const { targetAccountId, asset, amount, referenceId, description, targetUserId } = req.body || {};

    if (!targetAccountId || !asset || !amount || !referenceId) {
      throw new AppError('targetAccountId, asset, amount, and referenceId are required', 400, 'MISSING_PARAMETERS');
    }

    const receipt = await walletService.paperDeposit({
      adminUserId: req.user.id,
      targetAccountId: String(targetAccountId),
      targetUserId: targetUserId ? String(targetUserId) : undefined,
      asset: String(asset),
      amount: String(amount),
      referenceId: String(referenceId),
      description: description ? String(description) : undefined,
    });

    res.json({
      success: true,
      data: receipt,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/wallet/withdraw
 * Paper/demo withdrawal endpoint for authenticated users.
 */
export async function paperWithdraw(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const { accountId, asset, amount, referenceId, destinationAddress, description } = req.body || {};

    if (!accountId || !asset || !amount || !referenceId) {
      throw new AppError('accountId, asset, amount, and referenceId are required', 400, 'MISSING_PARAMETERS');
    }

    const receipt = await walletService.paperWithdraw({
      userId: req.user.id,
      accountId: String(accountId),
      asset: String(asset),
      amount: String(amount),
      referenceId: String(referenceId),
      destinationAddress: destinationAddress ? String(destinationAddress) : undefined,
      description: description ? String(description) : undefined,
    });

    res.json({
      success: true,
      data: receipt,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/wallet/transfer
 * Internal transfer between accounts owned by the same authenticated user.
 */
export async function internalTransfer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const { fromAccountId, toAccountId, asset, amount, referenceId, description } = req.body || {};

    if (!fromAccountId || !toAccountId || !asset || !amount || !referenceId) {
      throw new AppError('fromAccountId, toAccountId, asset, amount, and referenceId are required', 400, 'MISSING_PARAMETERS');
    }

    const receipt = await walletService.transfer({
      userId: req.user.id,
      fromAccountId: String(fromAccountId),
      toAccountId: String(toAccountId),
      asset: String(asset),
      amount: String(amount),
      referenceId: String(referenceId),
      description: description ? String(description) : undefined,
    });

    res.json({
      success: true,
      data: receipt,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/wallet/transactions
 * Retrieve transaction history scoped strictly to the authenticated user.
 */
export async function getTransactions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const accountId = req.query.accountId as string | undefined;
    const asset = req.query.asset as string | undefined;
    const transactionType = req.query.transactionType as LedgerTxType | undefined;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
    const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined;

    const history = await walletService.getTransactions(req.user.id, {
      accountId,
      asset,
      transactionType,
      page,
      pageSize,
    });

    res.json({
      success: true,
      data: history,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/wallet/withdraw/crypto
 * Initiates a real crypto withdrawal.
 */
export async function cryptoWithdraw(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const { asset, network, amount, destinationAddress, destinationMemo, referenceId } = req.body || {};

    if (!asset || !network || !amount || !destinationAddress || !referenceId) {
      throw new AppError('asset, network, amount, destinationAddress, and referenceId are required', 400, 'MISSING_PARAMETERS');
    }

    const receipt = await withdrawalService.cryptoWithdraw({
      userId: req.user.id,
      asset: String(asset),
      network: String(network),
      amount: String(amount),
      destinationAddress: String(destinationAddress),
      destinationMemo: destinationMemo ? String(destinationMemo) : undefined,
      referenceId: String(referenceId),
    });

    res.json({
      success: true,
      data: { receipt },
    });
  } catch (err) {
    next(err);
  }
}

export async function getDepositAddress(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    const asset = req.query.asset as string;
    const network = req.query.network as string;
    if (!asset || !network) {
      throw new AppError('Asset and network required', 400, 'BAD_REQUEST');
    }

    const depositAddress = await depositAddressService.getOrCreateDepositAddress({
      userId: req.user.id,
      asset,
      network
    });
    
    res.json({
      success: true,
      data: {
        asset: depositAddress.asset,
        network: depositAddress.network,
        address: depositAddress.blockchainAddress,
        tag: depositAddress.memo ?? undefined,
        status: depositAddress.status,
      }
    });
  } catch (err) {
    next(err);
  }
}
