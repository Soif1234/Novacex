import { Decimal } from 'decimal.js';

/**
 * Safely parses a JSON string with fallback and optional validator.
 * Never throws an exception.
 */
export function safeParseJSON<T>(
  data: string | null | undefined,
  fallback: T,
  validator?: (parsed: any) => boolean
): T {
  if (data === null || data === undefined || typeof data !== 'string') {
    return fallback;
  }
  try {
    const trimmed = data.trim();
    if (trimmed === '') return fallback;
    const parsed = JSON.parse(trimmed);
    if (validator && !validator(parsed)) {
      return fallback;
    }
    return parsed as T;
  } catch (e) {
    return fallback;
  }
}

/**
 * Safely parses a JSON string into an array of objects.
 * Filters out null, undefined, and non-object items, plus runs optional item validator.
 */
export function safeParseArray<T = any>(
  data: string | null | undefined,
  itemValidator?: (item: any) => boolean
): T[] {
  if (!data || typeof data !== 'string') return [];
  try {
    const trimmed = data.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter(item => {
        if (item === null || typeof item !== 'object') return false;
        if (itemValidator) return itemValidator(item);
        return true;
      }) as T[];
    }
  } catch (e) {}
  return [];
}

/**
 * Safely parses a JSON string into an object, merging with fallback.
 */
export function safeParseObject<T extends object>(
  data: string | null | undefined,
  fallback: T = {} as T,
  validator?: (obj: any) => boolean
): T {
  if (!data || typeof data !== 'string') return fallback;
  try {
    const trimmed = data.trim();
    if (!trimmed) return fallback;
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (validator && !validator(parsed)) {
        return fallback;
      }
      return { ...fallback, ...parsed };
    }
  } catch (e) {}
  return fallback;
}

/**
 * Validates whether a value is a finite, positive/valid numeric financial string or number.
 */
export function isValidFinancialString(value: any): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'number') {
    return !isNaN(value) && isFinite(value);
  }
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'NaN' || trimmed === 'Infinity' || trimmed === '-Infinity') return false;
  try {
    const d = new Decimal(trimmed);
    return !d.isNaN() && d.isFinite();
  } catch (e) {
    return false;
  }
}

/**
 * Safely parses a financial number, defaulting to fallback if invalid.
 */
export function safeParseFinancialNumber(value: any, fallback: number = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const num = typeof value === 'number' ? value : parseFloat(String(value));
  if (isNaN(num) || !isFinite(num)) return fallback;
  return num;
}

/**
 * Safely normalizes a financial string, returning fallback if invalid.
 */
export function safeParseFinancialString(value: any, fallback: string = '0'): string {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const str = String(value).trim();
    if (!str || str === 'NaN' || str === 'Infinity' || str === '-Infinity') return fallback;
    const d = new Decimal(str);
    if (d.isNaN() || !d.isFinite()) return fallback;
    return d.toString();
  } catch (e) {
    return fallback;
  }
}

/**
 * Safely formats a date timestamp without crashing on invalid or missing dates.
 */
export function safeFormatDate(timestamp: any, fallback: string = 'Date unavailable'): string {
  if (timestamp === null || timestamp === undefined || timestamp === '') {
    return fallback;
  }
  try {
    const d = typeof timestamp === 'number' || typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
    if (d instanceof Date && !isNaN(d.getTime())) {
      return d.toLocaleString();
    }
  } catch (e) {}
  return fallback;
}