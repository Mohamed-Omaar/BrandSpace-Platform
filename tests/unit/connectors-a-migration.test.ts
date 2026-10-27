import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * CONNECTORS STEP A (D-505) — FOUR COLUMNS, ONE ADDITIVE, FORWARD-ONLY,
 * SHORT-LOCKED MIGRATION, exactly as the owner approved it:
 * `publish_job.providerHandle` and `publish_attempt.providerHandle` (W5) and
 * `social_connection.providerSubjectHash` / `social_oauth_state.pendingSubjectHash`
 * (W10), each nullable with its shape CHECK. The subject hash carries its key
 * version ("v<n>:" + 64 hex) so a key rotation never breaks a lookup (owner,
 * approval of A). No UPDATE, no table, no index, no RLS lift; RLS is proven
 * enabled and forced on all four before COMMIT. The CHECKs and the tenant
 * boundary are proven against real PostgreSQL in
 * tests/isolation/connectors-a-columns.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = '20261021090000_connectors_a_handles_and_subjects';
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

const SUBJECT = String.raw`'^v[0-9]{1,4}:[0-9a-f]{64}$'`;

describe('connectors A — handles and subjects', () => {
  it('is one transaction: the lock timeout, the eight changes in order, then the proof', () => {
    expect(statements).toEqual([
      'BEGIN',
      `SET LOCAL lock_timeout = '5s'`,
      `ALTER TABLE "publish_job" ADD COLUMN "providerHandle" TEXT`,
      `ALTER TABLE "publish_job" ADD CONSTRAINT "publish_job_provider_handle_shape" CHECK ("providerHandle" IS NULL OR char_length("providerHandle") BETWEEN 1 AND 512)`,
      `ALTER TABLE "publish_attempt" ADD COLUMN "providerHandle" TEXT`,
      `ALTER TABLE "publish_attempt" ADD CONSTRAINT "publish_attempt_provider_handle_shape" CHECK ("providerHandle" IS NULL OR char_length("providerHandle") BETWEEN 1 AND 512)`,
      `ALTER TABLE "social_connection" ADD COLUMN "providerSubjectHash" TEXT`,
      `ALTER TABLE "social_connection" ADD CONSTRAINT "social_connection_provider_subject_hash_shape" CHECK ("providerSubjectHash" IS NULL OR "providerSubjectHash" ~ ${SUBJECT})`,
      `ALTER TABLE "social_oauth_state" ADD COLUMN "pendingSubjectHash" TEXT`,
      `ALTER TABLE "social_oauth_state" ADD CONSTRAINT "social_oauth_state_pending_subject_hash_shape" CHECK ("pendingSubjectHash" IS NULL OR "pendingSubjectHash" ~ ${SUBJECT})`,
      'DO $$ … $$',
      'COMMIT',
    ]);
  });

  it('proves RLS enabled and forced on the four tables before it commits', () => {
    expect(sql).toMatch(
      /ARRAY\['publish_job', 'publish_attempt', 'social_connection', 'social_oauth_state'\]/,
    );
    expect(sql).toMatch(/relrowsecurity/);
    expect(sql).toMatch(/relforcerowsecurity/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it('never rewrites a row, lifts RLS, drops anything, adds a table or index, or touches a policy', () => {
    const upper = statements.join(' ').toUpperCase();
    for (const word of [
      'UPDATE ',
      'DELETE ',
      'DROP ',
      'NO FORCE',
      'POLICY',
      'GRANT',
      'REVOKE',
      'CREATE TABLE',
      'CREATE INDEX',
      'CREATE UNIQUE',
      'ALTER TYPE',
    ]) {
      expect(upper, word).not.toContain(word);
    }
  });

  it('comes directly after PR E, and only connectors B, the AI apps migrations and the D-573 ceiling follow it', () => {
    const at = EXPECTED_MIGRATIONS.indexOf(NAME);
    expect(EXPECTED_MIGRATIONS[at - 1]).toBe('20261020090000_group_b_fields');
    expect(EXPECTED_MIGRATIONS.slice(at + 1)).toEqual([
      '20261022090000_connectors_b_inbound_tables',
      '20261022091000_social_connection_subject_lookup_index',
      '20261022092000_publish_job_handle_lookup_index',
      // D-566: Connected AI apps (the remote MCP server).
      '20261023090000_ai_app_connections',
      // D-568: the rotation link made composite on the workspace (D-112).
      '20261023091000_ai_app_token_replaced_scoped',
      // D-573: the platform AI ceiling's in-flight estimate.
      '20261027100000_ai_platform_spend_ceiling',
    ]);
  });
});
