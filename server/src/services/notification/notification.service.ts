import { INotificationProvider, NotificationEventType, BaseNotificationEvent, WithdrawalNotificationEvent, KycApprovedEvent } from './notification.types';
import { ConsoleProvider } from './providers/console.provider';
import { SendGridProvider } from './providers/sendgrid.provider';
import { env as config } from '../../config/env';
import { logger } from '../../config/logger';

export class NotificationService {
  private provider: INotificationProvider;

  constructor() {
    const providerName = config.NOTIFICATION_PROVIDER || 'console';

    if (providerName === 'sendgrid') {
      if (!config.SENDGRID_API_KEY) {
        throw new Error('FATAL: NOTIFICATION_PROVIDER is sendgrid but SENDGRID_API_KEY is missing');
      }
      this.provider = new SendGridProvider(
        config.SENDGRID_API_KEY,
        config.NOTIFICATION_FROM_EMAIL || 'noreply@mallick.exchange',
        config.NOTIFICATION_FROM_NAME || 'Mallick Exchange'
      );
    } else {
      this.provider = new ConsoleProvider();
    }

    logger.info(`NotificationService initialized with provider: ${this.provider.name}`);
  }

  public async handleEvent(type: NotificationEventType, payload: any): Promise<void> {
    const { email } = payload as BaseNotificationEvent;

    // Map event type to templateId (in a real system, these would be SendGrid template IDs)
    // For now, we just use the event type string as the template identifier
    const templateId = type;

    // Sanitize context for the template
    const context = this.buildContext(type, payload);

    await this.provider.sendEmail(email, templateId, context);
  }

  private buildContext(type: NotificationEventType, payload: any): Record<string, unknown> {
    switch (type) {
      case NotificationEventType.WITHDRAWAL_REQUESTED:
      case NotificationEventType.WITHDRAWAL_PENDING_REVIEW:
      case NotificationEventType.WITHDRAWAL_APPROVED:
      case NotificationEventType.WITHDRAWAL_REJECTED: {
        const wPayload = payload as WithdrawalNotificationEvent;
        // Explicitly reconstruct to guarantee no PII leakage
        return {
          withdrawalId: wPayload.withdrawalId,
          asset: wPayload.asset,
          amount: wPayload.amount,
          network: wPayload.network,
          reason: wPayload.reason
        };
      }
      case NotificationEventType.KYC_APPROVED: {
        const kPayload = payload as KycApprovedEvent;
        return {
          tier: kPayload.tier
        };
      }
      case NotificationEventType.USER_REGISTERED: {
        return {};
      }
      default:
        return {};
    }
  }
}

export const notificationService = new NotificationService();
