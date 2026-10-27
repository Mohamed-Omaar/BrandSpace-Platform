/**
 * D-572 — STORAGE USED, FROM THE EXACT BYTES.
 *
 * The storage counter's `usedValue` is the whole gigabytes the total occupies,
 * ROUNDED UP (B-1), so a workspace holding a few megabytes read "1 / 5". The
 * usage rows read the counter's exact bytes (`usedBytes`) instead: below one
 * gigabyte in megabytes, from one gigabyte in gigabytes to one decimal — the
 * prototype's "3.1 / 50". Binary units, matching `BYTES_PER_GB`.
 */
const MB = 1024 * 1024;
const GB = 1024 * MB;

export interface StorageUsed {
  /** The number as it reads: "12", "0.4", "3.1". */
  readonly amount: string;
  readonly unit: 'MB' | 'GB';
}

export function storageUsed(bytes: number): StorageUsed {
  const safe = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  const format = (value: number, digits: number) =>
    new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, useGrouping: false }).format(
      value,
    );
  if (safe < GB) {
    const mb = safe / MB;
    return { amount: format(mb, mb < 10 ? 1 : 0), unit: 'MB' };
  }
  return { amount: format(safe / GB, 1), unit: 'GB' };
}

/** The share of the ceiling used, from bytes: 0–100, or null with no ceiling. */
export function storagePercent(bytes: number, limitGb: number): number | null {
  if (!(limitGb > 0)) return null;
  return Math.min(100, (Math.max(0, bytes) / (limitGb * GB)) * 100);
}
