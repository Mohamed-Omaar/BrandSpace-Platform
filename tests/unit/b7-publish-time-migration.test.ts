import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * BATCH 7 PR C (B1.0, Option B, D-487/D-489) — WHEN A POST GOES OUT, IN ONE
 * ADDITIVE, FORWARD-ONLY, SHORT-LOCKED MIGRATION.
 *
 * The proposed time, the PublishChoice type, the choice column (NOT NULL
 * DEFAULT 'NONE') and both CHECKs, in that order, in one transaction with a
 * lock timeout. No UPDATE and no RLS lift: the time column is added in the
 * same transaction, so every existing row is ('NONE', NULL) and satisfies the
 * CHECKs. RLS is proven enabled and forced before COMMIT. Both CHECKs are
 * proven against real PostgreSQL in tests/isolation/b7-proposed-local-time.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = '20261016090000_content_item_publish_time';
const sql = readFileSync(
  path.join(root, 'packages/database/prisma/migrations', NAME, 'migration.sql'),
  'utf8',
);
const statements = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .replace(/DO \$\$[\s\S]*?\$\$;/, () => 'DO $$ … $$;')
  .split(';')
  .map((statement) => statement.replace(/\s+/g, ' ').trim())
  .filter((statement) => statement.length > 0);

describe('B1.0 + Option B — when a post goes out', () => {
  it('is one transaction: the lock timeout, then the five changes in order, then the proof', () => {
    expect(statements).toEqual([
      'BEGIN',
      `SET LOCAL lock_timeout = '5s'`,
      `ALTER TABLE "content_item" ADD COLUMN "proposedLocalTime" TEXT`,
      `CREATE TYPE "PublishChoice" AS ENUM ('NONE', 'PICK', 'AFTER_APPROVAL')`,
      `ALTER TABLE "content_item" ADD COLUMN "publishChoice" "PublishChoice" NOT NULL DEFAULT 'NONE'`,
      `ALTER TABLE "content_item" ADD CONSTRAINT "content_item_proposed_local_time_shape" CHECK ( "proposedLocalTime" IS NULL OR "proposedLocalTime" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' )`,
      `ALTER TABLE "content_item" ADD CONSTRAINT "content_item_publish_choice_time" CHECK (("publishChoice" = 'PICK') = ("proposedLocalTime" IS NOT NULL))`,
      'DO $$ … $$',
      'COMMIT',
    ]);
  });

  it('proves RLS enabled and forced before it commits', () => {
    expect(sql).toMatch(/relrowsecurity/);
    expect(sql).toMatch(/relforcerowsecurity/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it('never rewrites a row, lifts RLS, drops anything or touches a policy', () => {
    const upper = statements.join(' ').toUpperCase();
    for (const word of ['UPDATE ', 'DELETE ', 'DROP ', 'NO FORCE', 'POLICY', 'GRANT', 'REVOKE']) {
      expect(upper, word).not.toContain(word);
    }
  });

  it('is the last migration the build expects, directly after PR 6', () => {
    expect(EXPECTED_MIGRATIONS.slice(-2)).toEqual([
      '20261015092000_automation_run_execution_due_index',
      NAME,
    ]);
  });
});
