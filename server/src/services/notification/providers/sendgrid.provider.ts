import { INotificationProvider } from '../notification.types';
import sgMail from '@sendgrid/mail';
import { logger } from '../../../config/logger';

export class SendGridProvider implements INotificationProvider {
  public name = 'sendgrid';
  private fromEmail: string;
  private fromName: string;

  constructor(apiKey: string, fromEmail: string, fromName: string) {
    if (!apiKey) throw new Error('SendGridProvider requires SENDGRID_API_KEY');
    sgMail.setApiKey(apiKey);
    this.fromEmail = fromEmail;
    this.fromName = fromName;
  }

  public async sendEmail(to: string, templateId: string, context: Record<string, unknown>): Promise<void> {
    try {
      await sgMail.send({
        to,
        from: {
          email: this.fromEmail,
          name: this.fromName
        },
        templateId,
        dynamicTemplateData: context
      });
      logger.info(`[SendGridProvider] Sent email to ${to}`, { templateId });
    } catch (error: any) {
      logger.error(`[SendGridProvider] Failed to send email to ${to}`, {
        templateId,
        error: error.message,
        response: error.response?.body
      });
      // Propagate error up so NotificationWorker can trigger retry logic
      throw error;
    }
  }
}
