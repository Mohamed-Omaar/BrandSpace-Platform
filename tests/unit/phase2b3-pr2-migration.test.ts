import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PublishAttemptOutcome } from '@prisma/client';
import { EXPECTED_MIGRATIONS as MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * PHASE 2B-3, PR 2 — M2, the one migration this PR carries.
 *
 * One enum value, in a migration of its own (the D-379 pattern), and nothing
 * else: no table, no column, no index, no row written.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const NAME = '20261011090000_publish_attempt_preflight_refused';
const sql = readFileSync(
  path.join(root, 'packages/database/prisma/migrations', NAME, 'migration.sql'),
  'utf8',
);
const statements = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')
  .split(';')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

describe('M2 — PREFLIGHT_REFUSED on PublishAttemptOutcome', () => {
  it('is exactly one ALTER TYPE … ADD VALUE IF NOT EXISTS, alone in its file', () => {
    expect(statements).toEqual([
      `ALTER TYPE "PublishAttemptOutcome" ADD VALUE IF NOT EXISTS 'PREFLIGHT_REFUSED'`,
    ]);
  });

  it('writes no row and changes no table', () => {
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(sql).not.toMatch(/\b(CREATE|ALTER) TABLE\b/);
    expect(sql).not.toMatch(/\bCREATE (UNIQUE )?INDEX\b/);
  });

  it('comes directly after M1c, and only the PR 4 M3 indexes, F6, the PR 5 M4 index and PR 6 M5a/M5b follow it', () => {
    const at = MIGRATIONS.indexOf(NAME);
    expect(MIGRATIONS[at - 1]).toBe('20261010092000_automation_g13_checks_and_state');
    // Phase 2B-3 PR 4 — M3, three concurrent index builds, come after M2;
    // then F6, brandScope never NULL; then PR 5's M4 expiry index; then PR 6's
    // M5a run statuses and M5b lease (with its index).
    expect(MIGRATIONS.slice(at + 1)).toEqual([
      '20261012090000_metric_observation_brand_window_index',
      '20261012091000_metric_observation_item_pooling_index',
      '20261012092000_publish_job_published_population_index',
      '20261013090000_brand_scope_not_null',
      '20261014090000_automation_run_awaiting_expiry_index',
      '20261015090000_automation_ai_execution_status',
      '20261015091000_automation_ai_execution_lease',
      '20261015092000_automation_run_execution_due_index',
    ]);
  });

  it('the Prisma enum agrees, and keeps every earlier value', () => {
    expect(Object.values(PublishAttemptOutcome).sort()).toEqual(
      [
        'INDETERMINATE',
        'PERMANENT_FAILURE',
        'PREFLIGHT_REFUSED',
        'RETRYABLE_FAILURE',
        'SUCCEEDED',
      ].sort(),
    );
  });
});
