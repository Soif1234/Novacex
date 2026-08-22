export type CircuitBreakerMode =
  | 'SYSTEM_ACTIVE'
  | 'HALT_ALL'
  | 'HALT_TRADING'
  | 'HALT_WITHDRAWALS'
  | 'CUSTOM';

export type SystemSubsystem =
  | 'SPOT_TRADING'
  | 'FUTURES_TRADING'
  | 'WITHDRAWALS'
  | 'DEPOSITS';

export interface SystemCircuitBreakerEntity {
  id: string;
  mode: CircuitBreakerMode;
  isSpotTradingEnabled: boolean;
  isFuturesTradingEnabled: boolean;
  isWithdrawalsEnabled: boolean;
  isDepositsEnabled: boolean;
  haltReason?: string | null;
  haltedBy?: string | null;
  updatedAt: Date;
}

export interface HaltCircuitBreakerDto {
  adminUserId: string;
  mode: CircuitBreakerMode;
  reason: string;
  isSpotTradingEnabled?: boolean;
  isFuturesTradingEnabled?: boolean;
  isWithdrawalsEnabled?: boolean;
  isDepositsEnabled?: boolean;
  ipAddress?: string;
  userAgent?: string;
}

export interface ResumeCircuitBreakerDto {
  adminUserId: string;
  reason: string;
  resumeAll?: boolean;
  isSpotTradingEnabled?: boolean;
  isFuturesTradingEnabled?: boolean;
  isWithdrawalsEnabled?: boolean;
  isDepositsEnabled?: boolean;
  ipAddress?: string;
  userAgent?: string;
}

export interface PublicCircuitBreakerStatus {
  isOperational: boolean;
  mode: CircuitBreakerMode;
  subsystems: {
    spotTrading: boolean;
    futuresTrading: boolean;
    withdrawals: boolean;
    deposits: boolean;
  };
  haltReason?: string | null;
  updatedAt: Date;
}
