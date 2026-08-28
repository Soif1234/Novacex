import { INotificationProvider } from '../notification.types';
import { logger } from '../../../config/logger';

export class ConsoleProvider implements INotificationProvider {
  public name = 'console';

  public async sendEmail(to: string, templateId: string, context: Record<string, unknown>): Promise<void> {
    logger.info(`[ConsoleProvider] Simulating email to ${to}`, {
      templateId,
      context
    });
  }
}
