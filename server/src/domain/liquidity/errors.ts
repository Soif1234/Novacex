export enum ProviderErrorCode {
  AUTHENTICATION_FAILURE = 'AUTHENTICATION_FAILURE',
  AUTHORIZATION_FAILURE = 'AUTHORIZATION_FAILURE',
  INVALID_REQUEST = 'INVALID_REQUEST',
  INSUFFICIENT_LIQUIDITY = 'INSUFFICIENT_LIQUIDITY',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  RATE_LIMIT = 'RATE_LIMIT',
  TIMEOUT = 'TIMEOUT',
  NETWORK_FAILURE = 'NETWORK_FAILURE',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  UNSUPPORTED_OPERATION = 'UNSUPPORTED_OPERATION',
  ORDER_REJECTED = 'ORDER_REJECTED',
  UNKNOWN_EXECUTION_STATE = 'UNKNOWN_EXECUTION_STATE',
}

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly providerId: string,
    public readonly originalError?: any
  ) {
    super(message);
    this.name = 'ProviderError';
    
    // Ensure credentials never leak into Error stack traces or serialized representations
    // We intentionally scrub originalError if it looks like an Axios/Fetch credentialed request.
    if (this.originalError && typeof this.originalError === 'object') {
      delete this.originalError.config;
      delete this.originalError.request;
      delete this.originalError.response?.config;
    }
  }
}
