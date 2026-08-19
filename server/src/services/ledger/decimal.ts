import { InvalidAmountError } from './errors';

/**
 * Exact Decimal Arithmetic for Financial Operations
 * 
 * All monetary values are represented as string-encoded decimals.
 * Arithmetic is performed using BigInt-based fixed-point math
 * to avoid JavaScript floating-point precision errors.
 * 
 * Internal precision: 18 decimal places (matches PostgreSQL NUMERIC(36,18)).
 */

const PRECISION = 18;
const SCALE = BigInt(10) ** BigInt(PRECISION);

/**
 * Parse a decimal string into a scaled BigInt.
 * "1.5" → 1_500_000_000_000_000_000n (1.5 * 10^18)
 */
function toBigInt(value: string): bigint {
  const trimmed = value.trim();
  if (trimmed === '') throw new InvalidAmountError(value, 'empty string');

  // Validate format: optional minus, digits, optional decimal point and digits
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidAmountError(value, 'not a valid decimal number');
  }

  const negative = trimmed.startsWith('-');
  const abs = negative ? trimmed.slice(1) : trimmed;
  const parts = abs.split('.');
  const intPart = parts[0] || '0';
  const fracPart = (parts[1] || '').padEnd(PRECISION, '0').slice(0, PRECISION);

  const result = BigInt(intPart) * SCALE + BigInt(fracPart);
  return negative ? -result : result;
}

/**
 * Convert a scaled BigInt back to a decimal string with fixed precision.
 * 1_500_000_000_000_000_000n → "1.500000000000000000"
 */
function fromBigInt(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const intPart = abs / SCALE;
  const fracPart = abs % SCALE;
  const fracStr = fracPart.toString().padStart(PRECISION, '0');
  const result = `${intPart}.${fracStr}`;
  return negative ? `-${result}` : result;
}

/**
 * Validate that a string represents a valid, finite, positive amount.
 */
export function validateAmount(amount: string): void {
  if (amount === undefined || amount === null) {
    throw new InvalidAmountError(String(amount), 'amount is required');
  }

  const str = String(amount).trim();

  if (str === '' || str === 'NaN' || str === 'Infinity' || str === '-Infinity') {
    throw new InvalidAmountError(str, 'must be a finite decimal number');
  }

  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new InvalidAmountError(str, 'must be a valid decimal number');
  }

  const parsed = toBigInt(str);

  if (parsed <= 0n) {
    throw new InvalidAmountError(str, 'amount must be positive');
  }
}

/**
 * Validate that a value represents a valid non-negative amount (for balance checks).
 */
export function validateNonNegative(value: string, label: string): void {
  const parsed = toBigInt(value);
  if (parsed < 0n) {
    throw new InvalidAmountError(value, `${label} must be non-negative`);
  }
}

/**
 * Add two decimal strings with exact precision.
 */
export function decimalAdd(a: string, b: string): string {
  return fromBigInt(toBigInt(a) + toBigInt(b));
}

/**
 * Subtract b from a with exact precision.
 */
export function decimalSubtract(a: string, b: string): string {
  return fromBigInt(toBigInt(a) - toBigInt(b));
}

/**
 * Compare two decimal strings.
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
export function decimalCompare(a: string, b: string): -1 | 0 | 1 {
  const diff = toBigInt(a) - toBigInt(b);
  if (diff < 0n) return -1;
  if (diff > 0n) return 1;
  return 0;
}

/**
 * Check if a decimal string is zero.
 */
export function decimalIsZero(a: string): boolean {
  return toBigInt(a) === 0n;
}

/**
 * Check if a decimal string is positive (> 0).
 */
export function decimalIsPositive(a: string): boolean {
  return toBigInt(a) > 0n;
}

/**
 * Check if a decimal string is non-negative (>= 0).
 */
export function decimalIsNonNegative(a: string): boolean {
  return toBigInt(a) >= 0n;
}

/**
 * Return the canonical zero string.
 */
export function decimalZero(): string {
  return fromBigInt(0n);
}

/**
 * Normalize a decimal string to our fixed-precision format.
 * "1.5" → "1.500000000000000000"
 */
export function decimalNormalize(value: string): string {
  return fromBigInt(toBigInt(value));
}

/**
 * Count the number of decimal places in an amount string.
 */
export function countDecimalPlaces(amount: string): number {
  const trimmed = amount.trim();
  const parts = trimmed.split('.');
  if (parts.length < 2) return 0;
  return parts[1].length;
}

/**
 * Validate that an amount string does not exceed the allowed maximum decimal places.
 */
export function validateDecimalPrecision(amount: string, maxDecimals: number): void {
  const decimals = countDecimalPlaces(amount);
  if (decimals > maxDecimals) {
    throw new InvalidAmountError(amount, `exceeds maximum allowed precision of ${maxDecimals} decimal places`);
  }
}
