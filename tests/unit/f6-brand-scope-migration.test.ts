import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * F6 — `brandScope` NEVER NULL: ONE ATOMIC MIGRATION, IN D-112's ORDER.
 *
 * What is pinned here is the SHAPE, because the shape is the safety: one
 * explicit transaction, a lock timeout before the first lock (owner decision
 * D1), FORCE lifted only for the backfill and restored — and proved restored —
 * before COMMIT. Its behaviour against real PostgreSQL, under FORCE and with
 * the NOBYPASSRLS migrator, is tests/isolation/f6-brand-scope-migration.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = '20261013090000_brand_scope_not_null';
const sql = readFileSync(
  path.join(root, 'packages/database/prisma/migrations', NAME, 'migration.sql'),
  'utf8',
);
const code = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');
const [beforeCheck = '', check = ''] = code.split(/\bDO \$\$/);
const statements = beforeCheck
  .split(';')
  .map((statement) => statement.replace(/\s+/g, ' ').trim())
  .filter((statement) => statement.length > 0);

describe('F6 — the brandScope migration', () => {
  it('runs these statements, in this order, in one explicit transaction', () => {
    expect(statements).toEqual([
      'BEGIN',
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE "membership" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "invitation" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "membership" ALTER COLUMN "brandScope" SET DEFAULT ARRAY[]::UUID[]',
      'ALTER TABLE "invitation" ALTER COLUMN "brandScope" SET DEFAULT ARRAY[]::UUID[]',
      'UPDATE "membership" SET "brandScope" = ARRAY[]::UUID[] WHERE "brandScope" IS NULL',
      'UPDATE "invitation" SET "brandScope" = ARRAY[]::UUID[] WHERE "brandScope" IS NULL',
      'ALTER TABLE "membership" ALTER COLUMN "brandScope" SET NOT NULL',
      'ALTER TABLE "invitation" ALTER COLUMN "brandScope" SET NOT NULL',
      'ALTER TABLE "membership" FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "invitation" FORCE ROW LEVEL SECURITY',
    ]);
    expect(code.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('proves FORCE and NOT NULL on both tables before COMMIT, or aborts', () => {
    expect(check).toMatch(/relrowsecurity AND c\.relforcerowsecurity AND a\.attnotnull/);
    expect(check).toMatch(/RAISE EXCEPTION/);
    expect(check).toMatch(/'membership', 'invitation'/);
  });

  it('touches only NULL scopes: no restricted scope is rewritten, nothing is deleted', () => {
    for (const update of statements.filter((statement) => statement.startsWith('UPDATE'))) {
      expect(update).toMatch(/WHERE "brandScope" IS NULL$/);
    }
    expect(code).not.toMatch(/\b(DELETE|DROP|TRUNCATE|INSERT)\b/);
  });

  it('is the newest migration in the manifest, directly after M3', () => {
    const at = EXPECTED_MIGRATIONS.indexOf(NAME);
    expect(at).toBe(EXPECTED_MIGRATIONS.length - 1);
    expect(EXPECTED_MIGRATIONS[at - 1]).toBe(
      '20261012092000_publish_job_published_population_index',
    );
  });

  it('the schema carries the same default on both fields, so there is no drift', () => {
    const schema = readFileSync(path.join(root, 'packages/database/prisma/schema.prisma'), 'utf8');
    expect(schema.match(/^ {2}brandScope String\[\] @default\(\[\]\) @db\.Uuid$/gm)).toHaveLength(
      2,
    );
    expect(schema).not.toMatch(/^ {2}brandScope String\[\] @db\.Uuid$/m);
  });
});

describe('F6 D2 — the member picker filters by scope in SQL', () => {
  it('asks the database for an empty-or-this-brand scope, with no scan limit left', () => {
    const source = readFileSync(
      path.join(root, 'packages/automation/src/condition-values.ts'),
      'utf8',
    );
    expect(source).toContain(
      'OR: [{ brandScope: { isEmpty: true } }, { brandScope: { has: input.brandId } }]',
    );
    expect(source).not.toMatch(/MEMBER_SCAN_LIMIT|2_000/);
  });
});
