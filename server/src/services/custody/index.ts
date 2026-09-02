/**
 * Phase 9.2/9.3 — Custody Abstraction Layer (CAL) public exports.
 */

export { CustodyErrorCode, CustodyError, CustodyDisabledError, ProviderUnavailableError, UnsupportedAssetNetworkError, CustodyCapabilityUnavailableError, InvalidCustodyRequestError, CustodyTransactionNotFoundError, CustodyOperationRejectedError } from './custody.errors';
export type { CustodyErrorCodeType } from './custody.errors';
export type {
  CustodyTransactionStatus,
  CustodyTransactionDirection,
  CustodyAssetNetwork,
  CustodyAccount,
  CustodyBalance,
  DepositAddress,
  DepositAddressStatus,
  GetOrCreateDepositAddressRequest,
  WithdrawalRequest,
  CustodyTransaction,
  CustodyProviderHealth,
} from './custody.types';
export { CustodyProviderCapability, HOUSE_TREASURY_ACCOUNT_ID } from './custody.types';
export type { TreasuryTransferRequest } from './custody.types';
export type { ICustodyAdapter, ICustodyReadAdapter, ICustodyWriteAdapter } from './custody-adapter';
export { MockCustodyProvider } from './mock-custody-provider';
export type { MockCustodyProviderOptions } from './mock-custody-provider';
export { CustodyService, createCustodyService, custodyService } from './custody.service';
export type { CustodyServiceOptions } from './custody.service';
export { ManualSafeCustodyProvider } from './manual-safe-custody-provider';
export { ManualTxVerificationService, manualTxVerificationService } from './manual-tx-verification.service';
export type { OnChainVerificationResult } from './manual-tx-verification.service';
export { DepositAddressService, createDepositAddressService, depositAddressService } from './deposit-address.service';
export type { DepositAddressServiceOptions, GetOrCreateDepositAddressParams, RotateDepositAddressResult } from './deposit-address.service';