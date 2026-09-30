import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appRoleClient } from './fixtures';

/**
 * PHASE 2B-3, PR 2 — EVERY TRANSITION TO FAILED CONCLUDES WITH ATTEMPT
 * EVIDENCE, AGAINST REAL POSTGRESQL.
 */

let app: PrismaClient;

beforeAll(() => {
  app = appRoleClient();
});

afterAll(async () => {
  await app?.$disconnect();
});

describe('M2 — the database knows PREFLIGHT_REFUSED', () => {
  it('PublishAttemptOutcome carries the new value after every earlier one', async () => {
    const rows = await app.$queryRaw<{ value: string }[]>`
      SELECT unnest(enum_range(NULL::"PublishAttemptOutcome"))::text AS value
    `;
    expect(rows.map((row) => row.value)).toEqual([
      'SUCCEEDED',
      'RETRYABLE_FAILURE',
      'PERMANENT_FAILURE',
      'INDETERMINATE',
      'PREFLIGHT_REFUSED',
    ]);
  });
});
