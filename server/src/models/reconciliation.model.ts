export type ThreatAlertSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ThreatAlertStatus = 'ACTIVE' | 'RESOLVED' | 'IGNORED';
export type ThreatAlertCategory =
  | 'RECONCILIATION_MISMATCH'
  | 'NEGATIVE_BALANCE'
  | 'DOUBLE_ENTRY_VIOLATION'
  | 'UNAUTHORIZED_ACCESS'
  | 'RATE_LIMIT_ANOMALY'
  | 'CIRCUIT_BREAKER_TRIGGERED'
  | 'SUSPICIOUS_TRANSACTION';

export interface SecurityThreatAlertEntity {
  id: string;
  severity: ThreatAlertSeverity;
  category: ThreatAlertCategory | string;
  title: string;
  description: string;
  metadata: Record<string, unknown>;
  status: ThreatAlertStatus;
  resolvedBy?: string | null;
  resolvedAt?: Date | null;
  resolutionNotes?: string | null;
  createdAt: Date;
}

export interface CreateThreatAlertDto {
  severity: ThreatAlertSeverity;
  category: ThreatAlertCategory | string;
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface ResolveThreatAlertDto {
  adminUserId: string;
  status: 'RESOLVED' | 'IGNORED';
  resolutionNotes: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface QueryThreatAlertsDto {
  status?: ThreatAlertStatus;
  severity?: ThreatAlertSeverity;
  category?: string;
  page?: number;
  pageSize?: number;
}

export interface ReconciliationDiscrepancyDetail {
  type: 'BALANCE_MISMATCH' | 'NEGATIVE_BALANCE' | 'DOUBLE_ENTRY_VIOLATION' | 'LOCKED_MISMATCH' | 'CUSTODY_MISMATCH' | 'CUSTODY_API_ERROR';
  accountId?: string;
  asset?: string;
  walletAvailable?: string;
  walletLocked?: string;
  walletTotal?: string;
  ledgerComputed?: string;
  internalTotal?: string;
  custodyTotal?: string;
  tolerance?: string;
  pendingDepositTolerance?: string;
  pendingWithdrawalTolerance?: string;
  severity?: 'WARNING' | 'CRITICAL';
  discrepancy?: string;
  transactionId?: string;
  reason: string;
}

export interface ReconciliationReportEntity {
  id: string;
  status: 'PASSED' | 'DISCREPANCY_DETECTED' | 'ERROR';
  accountsChecked: number;
  discrepanciesCount: number;
  details: ReconciliationDiscrepancyDetail[];
  triggeredBy: string;
  createdAt: Date;
}

export interface QueryReconciliationReportsDto {
  status?: string;
  page?: number;
  pageSize?: number;
}
