import { Request, Response } from 'express';
import { treasuryManagerService } from '../services/treasury/treasury-manager.service';
import { logger } from '../config/logger';

export class TreasuryController {
  public static async consolidateToSafe(req: Request, res: Response) {
    try {
      const { network, asset, amount, signature, nonce, expiry, intentId } = req.body;

      if (!network || !asset || !amount || !signature || nonce === undefined || !expiry || !intentId) {
        return res.status(400).json({ error: 'Missing required fields: network, asset, amount, signature, nonce, expiry, intentId' });
      }

      if (Date.now() > expiry * 1000) {
        return res.status(400).json({ error: 'Signature expired' });
      }

      logger.info(`Admin triggering treasury consolidation`, {
        network,
        asset,
        amount,
        intentId,
        admin: (req as any).user?.id
      });

      const adminId = (req as any).user?.id;
      const result = await treasuryManagerService.consolidateToSafe(network, asset, amount, adminId, signature, nonce, expiry, intentId);

      return res.status(200).json({
        message: 'Treasury consolidation requested',
        request: result
      });
    } catch (err: any) {
      logger.error(`TreasuryController.consolidateToSafe error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * POST /api/v1/admin/treasury/confirm
   *
   * Phase 11K — manual Safe mode confirmation.
   * Body: { intentId, txHash }
   * The transaction is independently verified on-chain before CONFIRMED is written.
   * No private key, no backend signing, no broadcast.
   */
  public static async confirmTreasury(req: Request, res: Response) {
    try {
      const { intentId, txHash } = req.body;

      if (!intentId || !txHash) {
        return res.status(400).json({ error: 'intentId and txHash are required' });
      }

      const adminId = (req as any).user?.id;
      await treasuryManagerService.confirmManualTreasuryTransfer(intentId, txHash, adminId);

      return res.status(200).json({ success: true, message: 'Treasury transfer confirmed on-chain' });
    } catch (err: any) {
      logger.error(`TreasuryController.confirmTreasury error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }
}
