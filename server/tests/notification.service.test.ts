import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotificationService } from '../src/services/notification/notification.service';
import { NotificationEventType, WithdrawalNotificationEvent, KycApprovedEvent } from '../src/services/notification/notification.types';
import { ConsoleProvider } from '../src/services/notification/providers/console.provider';
import { SendGridProvider } from '../src/services/notification/providers/sendgrid.provider';
import { env as config } from '../src/config/env';

vi.mock('../src/config/env', () => ({
  env: {
    NOTIFICATION_PROVIDER: 'console',
    SENDGRID_API_KEY: ''
  }
}));

describe('NotificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with ConsoleProvider by default', () => {
    const service = new NotificationService();
    expect((service as any).provider).toBeInstanceOf(ConsoleProvider);
  });

  it('fails fast if SendGrid is requested but no API key is provided', () => {
    config.NOTIFICATION_PROVIDER = 'sendgrid';
    config.SENDGRID_API_KEY = '';

    expect(() => {
      new NotificationService();
    }).toThrow(/SENDGRID_API_KEY is missing/);
  });

  it('initializes with SendGridProvider if key is provided', () => {
    config.NOTIFICATION_PROVIDER = 'sendgrid';
    config.SENDGRID_API_KEY = 'SG.mock_key';
    const service = new NotificationService();
    expect((service as any).provider).toBeInstanceOf(SendGridProvider);
  });

  it('sanitizes Withdrawal payload (no destinationAddress)', async () => {
    config.NOTIFICATION_PROVIDER = 'console';
    const service = new NotificationService();

    const providerSpy = vi.spyOn((service as any).provider, 'sendEmail');

    const payload: WithdrawalNotificationEvent & { destinationAddress?: string } = {
      userId: 'u1',
      email: 'test@test.com',
      withdrawalId: 'w1',
      asset: 'USDT',
      amount: '100',
      network: 'ETH',
      destinationAddress: '0x123secret'
    };

    await service.handleEvent(NotificationEventType.WITHDRAWAL_REQUESTED, payload);

    expect(providerSpy).toHaveBeenCalledWith(
      'test@test.com',
      NotificationEventType.WITHDRAWAL_REQUESTED,
      {
        withdrawalId: 'w1',
        asset: 'USDT',
        amount: '100',
        network: 'ETH',
        reason: undefined
      } // destinationAddress must NOT be passed to provider
    );
  });
});
