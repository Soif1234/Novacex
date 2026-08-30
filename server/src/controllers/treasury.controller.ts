import { Request, Response } from 'express';
import { treasuryManagerService } from '../services/treasury/treasury-manager.service';
import { logger } from '../config/logger';

export class TreasuryController {
  public static async consolidateToSafe(req: Request, res: Response) {
    try {
      const { network, asset, amount } = req.body;

      if (!network || !asset || !amount) {
        return res.status(400).json({ error: 'Missing required fields: network, asset, amount' });
      }

      logger.info(`Admin triggering treasury consolidation`, {
        network,
        asset,
        amount,
        admin: (req as any).user?.id
      });

      const adminId = (req as any).user?.id;
      const result = await treasuryManagerService.consolidateToSafe(network, asset, amount, adminId);

      return res.status(200).json({
        message: 'Treasury consolidation requested',
        request: result
      });
    } catch (err: any) {
      logger.error(`TreasuryController.consolidateToSafe error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }
}
