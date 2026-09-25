import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BYTES_PER_GB, gigabytesFor } from '@brandspace/entitlements';

/**
 * B-1 — the gigabytes a storage counter shows are the TOTAL's, rounded up
 * once. Per-file rounding made a 1 MB photo cost a whole gigabyte.
 */
describe('gigabytesFor (B-1)', () => {
  it('keeps the plan gigabyte the repository already sold', () => {
    expect(BYTES_PER_GB).toBe(1024 * 1024 * 1024);
  });

  it('is zero for nothing and one for a started gigabyte', () => {
    expect(gigabytesFor(0)).toBe(0);
    expect(gigabytesFor(1)).toBe(1);
    expect(gigabytesFor(BYTES_PER_GB)).toBe(1);
    expect(gigabytesFor(BYTES_PER_GB + 1)).toBe(2);
  });

  it('rounds the total once, not each file', () => {
    const fivePhotos = 5 * 1024 * 1024;
    expect(gigabytesFor(fivePhotos)).toBe(1);
    // Beyond what a 32-bit counter could hold, which is why it is BIGINT.
    expect(gigabytesFor(300n * BigInt(BYTES_PER_GB) - 1n)).toBe(300);
  });
});

describe('the storage migration backfills (B-1, B-8)', () => {
  it.each(['20260925120000_storage_bytes_meter', '20260925130000_storage_bytes_brand_sources'])(
    '%s divides by the same gigabyte the application uses',
    (migration) => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const sql = readFileSync(
        path.resolve(here, `../../packages/database/prisma/migrations/${migration}/migration.sql`),
        'utf8',
      );
      const divisors = [...sql.matchAll(/::numeric \/ (\d+)/g)].map((m) => Number(m[1]));
      expect(divisors.length).toBeGreaterThan(0);
      expect(new Set(divisors)).toEqual(new Set([BYTES_PER_GB]));
    },
  );
});
