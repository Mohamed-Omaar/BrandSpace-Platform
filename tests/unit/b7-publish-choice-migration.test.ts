import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * BATCH 7 PR C (Option B, D-489) — `content_item.publishChoice` IS ADDITIVE,
 * FORWARD-ONLY, SHORT-LOCKED AND LEAVES RLS FORCED.
 *
 * One enum type, one NOT NULL column with a constant default (NONE), one
 * guarded backfill for rows that already hold a proposed time, and one CHECK
 * tying the two together — in one transaction with a lock timeout, FORCE
 * lifted only for the backfill and proven restored before COMMIT (D-112, as
 * the F6 migration does). The CHECK is proven against real PostgreSQL in
 * tests/isolation/b7-proposed-local-time.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = '20261016091000_content_item_publish_choice';

const statements = readFileSync(
  path.join(root, 'packages/database/prisma/migrations', NAME, 'migration.sql'),
  'utf8',
)
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .replace(/DO \$\$[\s\S]*?\$\$;/, () => 'DO $$ … $$;')
  .split(';')
  .map((statement) => statement.replace(/\s+/g, ' ').trim())
  .filter((statement) => statement.length > 0);

describe('Option B — the publish choice', () => {
  it('is one transaction, lock timeout first, FORCE lifted and restored around the work', () => {
    expect(statements).toEqual([
      'BEGIN',
      `SET LOCAL lock_timeout = '5s'`,
      'ALTER TABLE "content_item" NO FORCE ROW LEVEL SECURITY',
      `CREATE TYPE "PublishChoice" AS ENUM ('NONE', 'PICK', 'AFTER_APPROVAL')`,
      `ALTER TABLE "content_item" ADD COLUMN "publishChoice" "PublishChoice" NOT NULL DEFAULT 'NONE'`,
      `UPDATE "content_item" SET "publishChoice" = 'PICK' WHERE "proposedLocalTime" IS NOT NULL`,
      `ALTER TABLE "content_item" ADD CONSTRAINT "content_item_publish_choice_time" CHECK (("publishChoice" = 'PICK') = ("proposedLocalTime" IS NOT NULL))`,
      'ALTER TABLE "content_item" FORCE ROW LEVEL SECURITY',
      'DO $$ … $$',
      'COMMIT',
    ]);
  });

  it('proves FORCE before it commits', () => {
    const sql = readFileSync(
      path.join(root, 'packages/database/prisma/migrations', NAME, 'migration.sql'),
      'utf8',
    );
    expect(sql).toMatch(/relforcerowsecurity/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it('drops nothing and touches no policy or grant', () => {
    const sql = statements.join(' ').toUpperCase();
    for (const word of ['DROP ', 'DELETE ', 'POLICY', 'GRANT', 'REVOKE']) {
      expect(sql, word).not.toContain(word);
    }
  });

  it('is the last migration the build expects, after the proposed time', () => {
    expect(EXPECTED_MIGRATIONS.slice(-2)).toEqual([
      '20261016090000_content_item_proposed_local_time',
      NAME,
    ]);
  });
});
