import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * PHASE 2B-3 PR 5 — M4 IS ONE PARTIAL INDEX, BUILT WITHOUT BLOCKING WRITES.
 *
 * One `CREATE INDEX CONCURRENTLY IF NOT EXISTS` statement and nothing else, so
 * Prisma runs it outside a transaction block and inserts and updates keep
 * flowing while it builds (SHARE UPDATE EXCLUSIVE). The lapse sweep that reads
 * it is proven against real PostgreSQL in tests/isolation/phase2b3-pr5-*.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const M4 = '20261014090000_automation_run_awaiting_expiry_index';

const statements = readFileSync(
  path.join(root, 'packages/database/prisma/migrations', M4, 'migration.sql'),
  'utf8',
)
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((statement) => statement.replace(/\s+/g, ' ').trim())
  .filter((statement) => statement.length > 0);

describe('M4 — the asks-first expiry index', () => {
  it('is exactly one CREATE INDEX CONCURRENTLY IF NOT EXISTS, partial on the waiting runs', () => {
    expect(statements).toEqual([
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "automation_run_awaiting_expiry_idx" ON "automation_run" ("confirmationExpiresAt") WHERE "status" = 'AWAITING_CONFIRMATION'`,
    ]);
  });

  it('drops, alters, rewrites, locks or grants nothing', () => {
    const sql = statements.join(' ').toUpperCase();
    for (const forbidden of [
      'DROP',
      'ALTER',
      'UPDATE ',
      'INSERT',
      'DELETE',
      'LOCK',
      'GRANT',
      'POLICY',
      'BEGIN',
      'COMMIT',
    ]) {
      expect(sql, forbidden).not.toContain(forbidden);
    }
  });

  it('comes directly after F6, and only PR 6 M5a/M5b follow it', () => {
    const at = EXPECTED_MIGRATIONS.indexOf(M4);
    expect(EXPECTED_MIGRATIONS.slice(at + 1)).toEqual([
      '20261015090000_automation_ai_execution_status',
      '20261015091000_automation_ai_execution_lease',
      '20261015092000_automation_run_execution_due_index',
      // Batch 7 PR C: when a post goes out (the proposed time and the publish choice).
      '20261016090000_content_item_publish_time',
    ]);
    expect(EXPECTED_MIGRATIONS[at - 1]).toBe('20261013090000_brand_scope_not_null');
  });

  it('the schema points at it from the model it indexes', () => {
    const schema = readFileSync(path.join(root, 'packages/database/prisma/schema.prisma'), 'utf8');
    expect(schema).toContain('`automation_run_awaiting_expiry_idx` on (confirmationExpiresAt)');
  });
});
