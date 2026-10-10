import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * PHASE 2B-3 PR 6 — M5a AND M5b ARE ADDITIVE, FORWARD-ONLY AND SHORT-LOCKED.
 *
 *   M5a  two enum values, in their own file (a value added by ADD VALUE cannot
 *        be used in the transaction that added it, and M5b's CHECKs name both).
 *   M5b  three columns and three CHECKs in one transaction with a lock timeout,
 *        and its partial index in a file of its own, CONCURRENTLY (the M4
 *        pattern), so writes keep flowing while it builds.
 *
 * The CHECKs are proven against real PostgreSQL in
 * tests/isolation/phase2b3-pr6-m5-checks.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const M5A = '20261015090000_automation_ai_execution_status';
const M5B = '20261015091000_automation_ai_execution_lease';
const M5B_INDEX = '20261015092000_automation_run_execution_due_index';

function statementsOf(name: string): string[] {
  return readFileSync(
    path.join(root, 'packages/database/prisma/migrations', name, 'migration.sql'),
    'utf8',
  )
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement.length > 0);
}

describe('M5a — the two AI run statuses', () => {
  it('only adds the two values, idempotently', () => {
    expect(statementsOf(M5A)).toEqual([
      `ALTER TYPE "AutomationRunStatus" ADD VALUE IF NOT EXISTS 'AWAITING_EXECUTION'`,
      `ALTER TYPE "AutomationRunStatus" ADD VALUE IF NOT EXISTS 'EXECUTING'`,
    ]);
  });
});

describe('M5b — the executor lease', () => {
  const statements = statementsOf(M5B);
  const sql = statements.join(' ');

  it('is one transaction that gives up after five seconds without its lock', () => {
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toBe(`SET LOCAL lock_timeout = '5s'`);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('adds three columns that every existing row already satisfies', () => {
    expect(sql).toContain(
      `ALTER TABLE "automation_run" ADD COLUMN "executionLeaseId" UUID, ADD COLUMN "executionAvailableAt" TIMESTAMPTZ(6), ADD COLUMN "executionAttempts" INTEGER NOT NULL DEFAULT 0`,
    );
  });

  it('adds the three CHECKs', () => {
    expect(sql).toContain(
      `"automation_run_execution_attempts_bounded" CHECK ("executionAttempts" BETWEEN 0 AND 20)`,
    );
    expect(sql).toContain(
      `"automation_run_execution_lease_matches_status" CHECK (("status" = 'EXECUTING') = ("executionLeaseId" IS NOT NULL))`,
    );
    expect(sql).toContain(
      `"automation_run_execution_due_is_set" CHECK ( "status" NOT IN ('AWAITING_EXECUTION', 'EXECUTING') OR "executionAvailableAt" IS NOT NULL )`,
    );
  });

  it('drops, rewrites, deletes, grants and touches no policy or row', () => {
    const upper = sql.toUpperCase();
    for (const forbidden of ['DROP', 'UPDATE ', 'INSERT', 'DELETE', 'GRANT', 'POLICY', 'FORCE']) {
      expect(upper, forbidden).not.toContain(forbidden);
    }
  });

  it('builds its partial index CONCURRENTLY, as its own single statement', () => {
    expect(statementsOf(M5B_INDEX)).toEqual([
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "automation_run_execution_due_idx" ON "automation_run" ("executionAvailableAt") WHERE "status" IN ('AWAITING_EXECUTION', 'EXECUTING')`,
    ]);
  });
});

describe('M5 — order and schema', () => {
  it('M5a, then M5b, then its index, directly after M4; only batch 7 PR C follows', () => {
    const at = EXPECTED_MIGRATIONS.indexOf(M5A);
    expect(EXPECTED_MIGRATIONS.slice(at - 1)).toEqual([
      '20261014090000_automation_run_awaiting_expiry_index',
      M5A,
      M5B,
      M5B_INDEX,
      '20261016090000_content_item_proposed_local_time',
      '20261016091000_content_item_publish_choice',
    ]);
  });

  it('the schema declares the statuses and columns, and points at the index', () => {
    const schema = readFileSync(path.join(root, 'packages/database/prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/^\s+AWAITING_EXECUTION$/m);
    expect(schema).toMatch(/^\s+EXECUTING$/m);
    expect(schema).toMatch(/^\s+executionLeaseId\s+String\?\s+@db\.Uuid$/m);
    expect(schema).toMatch(/^\s+executionAvailableAt\s+DateTime\?\s+@db\.Timestamptz\(6\)$/m);
    expect(schema).toMatch(/^\s+executionAttempts\s+Int\s+@default\(0\)$/m);
    expect(schema).toContain('`automation_run_execution_due_idx` on');
  });
});
