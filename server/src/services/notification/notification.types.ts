export enum NotificationEventType {
  USER_REGISTERED = 'notification.user_registered',
  WITHDRAWAL_REQUESTED = 'notification.withdrawal_requested',
  WITHDRAWAL_PENDING_REVIEW = 'notification.withdrawal_pending_review',
  WITHDRAWAL_APPROVED = 'notification.withdrawal_approved',
  WITHDRAWAL_REJECTED = 'notification.withdrawal_rejected',
  KYC_APPROVED = 'notification.kyc_approved'
}

export interface BaseNotificationEvent {
  userId: string;
  email: string;
}

export interface UserRegisteredEvent extends BaseNotificationEvent {}

export interface KycApprovedEvent extends BaseNotificationEvent {
  tier: string;
}

export interface WithdrawalNotificationEvent extends BaseNotificationEvent {
  withdrawalId: string;
  asset: string;
  amount: string;
  network: string;
  // Strictly no destinationAddress to prevent PII exposure
  reason?: string; // e.g. for rejected
}

export interface INotificationProvider {
  name: string;
  sendEmail(to: string, templateId: string, context: Record<string, unknown>): Promise<void>;
}
