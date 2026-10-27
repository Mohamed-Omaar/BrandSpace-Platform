import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import { storagePercent, storageUsed } from '../../apps/dashboard/src/components/storage-usage';

/**
 * D-572 (owner's edits list, item 4) — PLAN & BILLING SHOWED "STORAGE (GB) 1 / 5"
 * FOR A NEARLY EMPTY WORKSPACE: it printed the counter's whole gigabytes,
 * rounded up. Storage now reads the counter's exact bytes — megabytes below one
 * gigabyte, gigabytes to one decimal from it.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('storage used, from bytes', () => {
  it('below one gigabyte reads in MB, one decimal under 10', () => {
    expect(storageUsed(0)).toEqual({ amount: '0', unit: 'MB' });
    expect(storageUsed(0.4 * MB)).toEqual({ amount: '0.4', unit: 'MB' });
    expect(storageUsed(3 * MB + 200_000)).toEqual({ amount: '3.2', unit: 'MB' });
    expect(storageUsed(12 * MB)).toEqual({ amount: '12', unit: 'MB' });
    expect(storageUsed(GB - 1)).toEqual({ amount: '1024', unit: 'MB' });
  });

  it('from one gigabyte reads in GB to one decimal — the prototype’s "3.1"', () => {
    expect(storageUsed(GB)).toEqual({ amount: '1', unit: 'GB' });
    expect(storageUsed(3.1 * GB)).toEqual({ amount: '3.1', unit: 'GB' });
    expect(storageUsed(50 * GB)).toEqual({ amount: '50', unit: 'GB' });
  });

  it('never negative, never NaN', () => {
    expect(storageUsed(-5)).toEqual({ amount: '0', unit: 'MB' });
    expect(storageUsed(Number.NaN)).toEqual({ amount: '0', unit: 'MB' });
  });

  it('the bar is the share of the ceiling in bytes, with no ceiling none', () => {
    expect(storagePercent(12 * MB, 5)).toBeCloseTo((12 / (5 * 1024)) * 100, 6);
    expect(storagePercent(10 * GB, 5)).toBe(100);
    expect(storagePercent(GB, 0)).toBeNull();
  });
});

describe('the screens read bytes, not the rounded-up gigabytes', () => {
  it('Plan & billing: "12 MB / 5 GB" below a gigabyte, "3.1 / 50" from one', () => {
    const billing = read('apps/dashboard/src/app/[locale]/billing/page.tsx');
    expect(billing).toMatch(/featureKey === QUOTA_FEATURES\.storageGb\)\?\.usedBytes/);
    // The units are the reader's words: "12 MB / 5 GB", "12 ميغابايت / 5 غيغابايت".
    expect(billing).toMatch(
      /inMb \? t\('plan\.unitMb'\)\.replace\('\{n\}', used\.amount\) : used\.amount/,
    );
    expect(billing).toMatch(
      /inMb \? t\('plan\.unitGb'\)\.replace\('\{n\}', String\(limit\)\) : String\(limit\)/,
    );
  });

  it('Usage & limits and the quota table use the same reading, en and ar', () => {
    const plan = read('apps/dashboard/src/app/[locale]/plan/page.tsx');
    expect(plan).toContain('storageText(storedBytes)');
    expect(plan).toContain('storageText(counter.usedBytes)');
    expect(messages.en['plan.unitMb']).toBe('{n} MB');
    expect(messages.ar['plan.unitMb']).toBe('{n} ميغابايت');
  });

  it('the counter reader returns the exact bytes', () => {
    expect(read('packages/entitlements/src/usage.ts')).toMatch(/usedBytes: Number\(r\.usedBytes\)/);
  });
});
