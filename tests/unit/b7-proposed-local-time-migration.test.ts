import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * BATCH 7 PR C (B1.0) — `content_item.proposedLocalTime` IS ADDITIVE,
 * FORWARD-ONLY AND SHORT-LOCKED.
 *
 * One nullable column and one shape CHECK, in one transaction with a lock
 * timeout. Every existing row gets NULL, which the CHECK admits. The CHECK is
 * proven against real PostgreSQL in tests/isolation/b7-proposed-local-time.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = '20261016090000_content_item_proposed_local_time';

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

describe('B1.0 — the proposed publish time', () => {
  const statements = statementsOf(NAME);

  it('is one transaction that gives up after five seconds without its lock', () => {
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toBe(`SET LOCAL lock_timeout = '5s'`);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('adds one nullable column and one shape CHECK, nothing else', () => {
    expect(statements.slice(2, -1)).toEqual([
      `ALTER TABLE "content_item" ADD COLUMN "proposedLocalTime" TEXT`,
      `ALTER TABLE "content_item" ADD CONSTRAINT "content_item_proposed_local_time_shape" CHECK ( "proposedLocalTime" IS NULL OR "proposedLocalTime" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' )`,
    ]);
  });

  it('never rewrites a row, drops anything or touches a policy', () => {
    const sql = statements.join(' ').toUpperCase();
    for (const word of ['UPDATE ', 'DELETE ', 'DROP ', 'POLICY', 'GRANT', 'REVOKE']) {
      expect(sql, word).not.toContain(word);
    }
  });

  it('is the last migration the build expects', () => {
    expect(EXPECTED_MIGRATIONS.at(-1)).toBe(NAME);
  });
});
