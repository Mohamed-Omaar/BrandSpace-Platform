import { AppError } from '@brandspace/shared';

/**
 * MAJOR ↔ MINOR UNITS, PER CURRENCY (D-313).
 *
 * Plans store prices in minor units (`monthlyMinor`). The Simple plan editor
 * lets the owner type "29.00" instead of "2900", and this is the ONE place
 * that conversion happens. The number of minor digits comes from the currency
 * itself (ISO 4217, via `Intl`): JPY has none, KWD has three. Nothing here
 * converts between currencies (D-08).
 */
export function minorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * "29", "29.5", "29.50" → 2950 for a two-digit currency. Empty is zero, as in
 * the minor-unit form. More decimals than the currency has, a sign, a
 * thousands separator or anything else is REFUSED, never rounded: a price is
 * money, and a silently rounded price is a different price.
 */
export function majorToMinor(raw: string, currency: string): number {
  const value = raw.trim();
  if (value === '') return 0;
  const digits = minorDigits(currency);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2] ?? '').length > digits) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Enter the ${currency} price as a plain amount, like 29.00.`,
    );
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(digits, '0') || '0');
  const minor = whole * 10 ** digits + fraction;
  if (!Number.isSafeInteger(minor)) {
    throw new AppError('VALIDATION_FAILED', `The ${currency} price is too large.`);
  }
  return minor;
}

/** 2950 → "29.50" for display in an input, in the currency's own digits. */
export function minorToMajorInput(minor: number, currency: string): string {
  const digits = minorDigits(currency);
  if (digits === 0) return String(minor);
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(minor);
  const whole = Math.floor(absolute / 10 ** digits);
  const fraction = String(absolute % 10 ** digits).padStart(digits, '0');
  return `${sign}${whole}.${fraction}`;
}

/** 2950 USD → "$29.50" in the reader's locale, Western digits in Arabic. */
export function formatMinor(minor: number, currency: string, locale: string): string {
  const digits = minorDigits(currency);
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en', {
    style: 'currency',
    currency,
  }).format(minor / 10 ** digits);
}
