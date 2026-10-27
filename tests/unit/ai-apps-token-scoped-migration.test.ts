import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * D-568 — THE ROTATION LINK STAYS INSIDE ONE WORKSPACE (D-112).
 *
 * `ai_app_token.replacedById` pointed at its successor with a plain
 * single-column key; the platform-wide D-112 invariant
 * (tests/isolation/d112-platform-wide-invariant.test.ts) refuses that between
 * tenant-owned rows. This forward migration makes the key composite on
 * "workspaceId", exactly as reviewed and approved as sent (2026-10-19, D-568): one transaction, the unique
 * index the key needs, drop and re-add the key with `SET NULL ("replacedById")`,
 * and a proof. Nothing else changes.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = '20261023091000_ai_app_token_replaced_scoped';
const sql = readFileSync(
  path.join(root, 'packages/database/prisma/migrations', NAME, 'migration.sql'),
  'utf8',
);
const statements = sql
  .split('\n')
  .map((line) => line.replace(/\s*--.*$/, ''))
  .join('\n')
  .replace(/DO \$\$[\s\S]*?END \$\$;/, () => 'DO $$ … $$;')
  .split(';')
  .map((statement) => statement.replace(/\s+/g, ' ').trim())
  .filter((statement) => statement.length > 0);

describe('D-568 · the AI apps token key, scoped to the workspace', () => {
  it('is exactly the statements reviewed and approved as sent (2026-10-19), in one transaction, ending in the proof', () => {
    expect(statements).toEqual([
      'BEGIN',
      `SET LOCAL lock_timeout = '5s'`,
      'CREATE UNIQUE INDEX "ai_app_token_workspaceId_id_key" ON "ai_app_token" ("workspaceId", "id")',
      'ALTER TABLE "ai_app_token" DROP CONSTRAINT "ai_app_token_replaced_fkey"',
      'ALTER TABLE "ai_app_token" ADD CONSTRAINT "ai_app_token_replaced_fkey" FOREIGN KEY ("workspaceId", "replacedById") REFERENCES "ai_app_token"("workspaceId", "id") ON DELETE SET NULL ("replacedById") ON UPDATE CASCADE',
      'DO $$ … $$',
      'COMMIT',
    ]);
  });

  it('proves the key is composite and RLS is still forced before committing', () => {
    expect(sql).toMatch(/array_length\(conkey, 1\) = 2/);
    expect(sql).toMatch(/relrowsecurity AND relforcerowsecurity/);
  });

  it('touches no row, policy or grant', () => {
    const upper = statements.join(' ').toUpperCase();
    for (const word of [
      'UPDATE "',
      'DELETE FROM',
      'INSERT ',
      'POLICY',
      'GRANT',
      'REVOKE',
      'DROP TABLE',
    ]) {
      expect(upper, word).not.toContain(word);
    }
  });

  it('comes directly after the AI apps migration, and only the D-573 platform ceiling follows', () => {
    expect(EXPECTED_MIGRATIONS.slice(-3)).toEqual([
      '20261023090000_ai_app_connections',
      NAME,
      '20261027100000_ai_platform_spend_ceiling',
    ]);
  });
});
