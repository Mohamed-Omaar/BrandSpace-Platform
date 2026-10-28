import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AiAppConnectionStatus, AiAppTokenKind } from '@prisma/client';
import { EXPECTED_MIGRATIONS } from '../../packages/database/src/migration-manifest';
import {
  GLOBAL_MODELS,
  MODEL_TABLE_NAMES,
  STRICT_TENANT_MODELS,
} from '../../packages/database/src/tenant-models';

/**
 * D-566 — CONNECTED AI APPS: ONE MIGRATION, EXACTLY AS THE OWNER APPROVED IT
 * (audit §4, approved 2026-10-18).
 *
 * One transaction: two enums, the hash-lookup function, five tables with their
 * CHECKs and indexes, RLS enabled and forced on all five, the tenant and
 * platform policies, the two read-only hash-lookup policies, the grants, and a
 * self-check that fails the migration if RLS is not forced or the tenant role
 * can write the client registry. Nothing existing is altered.
 *
 * The tenant boundary, the lookups and the CHECKs are proven against real
 * PostgreSQL in tests/isolation/ai-apps-tables.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = '20261023090000_ai_app_connections';
const sql = readFileSync(
  path.join(root, 'packages/database/prisma/migrations', NAME, 'migration.sql'),
  'utf8',
);
const statements = sql
  .split('\n')
  .map((line) => line.replace(/\s*--.*$/, ''))
  .join('\n')
  .replace(/DO \$\$[\s\S]*?END \$\$;/, () => 'DO $$ … $$;')
  .replace(/AS \$\$[\s\S]*?\$\$;/, () => 'AS $$ … $$;')
  .split(';')
  .map((statement) => statement.replace(/\s+/g, ' ').trim())
  .filter((statement) => statement.length > 0);

const TABLES = [
  'ai_app_client',
  'ai_app_connection',
  'ai_app_authorization_code',
  'ai_app_token',
  'ai_app_rate_window',
];
const TENANT_TABLES = TABLES.slice(1);

describe('D-566 · the AI apps migration', () => {
  it('is one transaction with a short lock timeout, ending in the proof', () => {
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toBe(`SET LOCAL lock_timeout = '5s'`);
    expect(statements.at(-2)).toBe('DO $$ … $$');
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('creates the two enums, the function, the five tables and their indexes, and nothing else', () => {
    const creates = statements.filter(
      (statement) => statement.startsWith('CREATE ') && !statement.startsWith('CREATE POLICY'),
    );
    expect(creates.map((statement) => statement.split(' (')[0]?.split(' AS ')[0])).toEqual([
      'CREATE TYPE "AiAppConnectionStatus"',
      'CREATE TYPE "AiAppTokenKind"',
      'CREATE OR REPLACE FUNCTION app.current_ai_app_token_hash() RETURNS text LANGUAGE sql STABLE',
      'CREATE TABLE "ai_app_client"',
      'CREATE UNIQUE INDEX "ai_app_client_clientId_key" ON "ai_app_client"',
      'CREATE TABLE "ai_app_connection"',
      'CREATE UNIQUE INDEX "ai_app_connection_workspaceId_id_key" ON "ai_app_connection"',
      'CREATE INDEX "ai_app_connection_workspaceId_status_idx" ON "ai_app_connection"',
      'CREATE INDEX "ai_app_connection_userId_idx" ON "ai_app_connection"',
      'CREATE INDEX "ai_app_connection_clientId_idx" ON "ai_app_connection"',
      'CREATE TABLE "ai_app_authorization_code"',
      'CREATE UNIQUE INDEX "ai_app_authorization_code_codeHash_key" ON "ai_app_authorization_code"',
      'CREATE INDEX "ai_app_authorization_code_expiresAt_idx" ON "ai_app_authorization_code"',
      'CREATE TABLE "ai_app_token"',
      'CREATE UNIQUE INDEX "ai_app_token_tokenHash_key" ON "ai_app_token"',
      'CREATE INDEX "ai_app_token_connectionId_kind_idx" ON "ai_app_token"',
      'CREATE INDEX "ai_app_token_expiresAt_idx" ON "ai_app_token"',
      'CREATE TABLE "ai_app_rate_window"',
      'CREATE INDEX "ai_app_rate_window_windowStart_idx" ON "ai_app_rate_window"',
    ]);
  });

  it('never alters, rewrites or drops anything that already exists, and never lifts RLS', () => {
    const upper = statements.join(' ').toUpperCase();
    for (const word of [
      'ALTER TYPE',
      'ALTER COLUMN',
      'ADD COLUMN',
      'UPDATE "',
      'DELETE FROM',
      'INSERT ',
      'DROP ',
      'NO FORCE',
      'DISABLE ROW',
      'SECURITY DEFINER',
      'BYPASSRLS',
    ]) {
      expect(upper, word).not.toContain(word);
    }
    // Every ALTER TABLE is an RLS switch on one of the five new tables.
    for (const statement of statements.filter((s) => s.startsWith('ALTER TABLE'))) {
      expect(statement).toMatch(
        /^ALTER TABLE "(ai_app_client|ai_app_connection|ai_app_authorization_code|ai_app_token|ai_app_rate_window)" (ENABLE|FORCE) ROW LEVEL SECURITY$/,
      );
    }
  });

  it('enables and forces RLS on all five tables, and proves it before committing', () => {
    for (const table of TABLES) {
      expect(statements).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(statements).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toMatch(/relrowsecurity AND relforcerowsecurity/);
    expect(sql).toMatch(
      /has_table_privilege\('brandspace_app', 'public\.ai_app_client', 'INSERT, UPDATE, DELETE'\)/,
    );
  });

  it('isolates the four tenant tables by workspace and gives the platform role its own policy', () => {
    for (const table of TENANT_TABLES) {
      expect(statements).toContain(
        `CREATE POLICY tenant_isolation ON "${table}" TO brandspace_app USING ("workspaceId" = app.current_workspace_id()) WITH CHECK ("workspaceId" = app.current_workspace_id())`,
      );
    }
    for (const table of TABLES) {
      expect(statements).toContain(
        `CREATE POLICY platform_access ON "${table}" TO brandspace_platform USING (true) WITH CHECK (true)`,
      );
    }
  });

  it('allows a hash lookup only outside a workspace, read-only, and only for the hash the caller holds', () => {
    expect(statements).toContain(
      `CREATE POLICY token_lookup ON "ai_app_token" FOR SELECT TO brandspace_app USING (app.current_workspace_id() IS NULL AND app.current_ai_app_token_hash() IS NOT NULL AND "tokenHash" = app.current_ai_app_token_hash())`,
    );
    expect(statements).toContain(
      `CREATE POLICY code_lookup ON "ai_app_authorization_code" FOR SELECT TO brandspace_app USING (app.current_workspace_id() IS NULL AND app.current_ai_app_token_hash() IS NOT NULL AND "codeHash" = app.current_ai_app_token_hash())`,
    );
    expect(sql).toMatch(/NULLIF\(current_setting\('app\.ai_app_token_hash', true\), ''\)/);
  });

  it('lets the tenant role read the client registry and never write it', () => {
    expect(statements).toContain(
      `CREATE POLICY catalogue_read ON "ai_app_client" FOR SELECT TO brandspace_app USING (true)`,
    );
    expect(statements).toContain(`REVOKE ALL ON "ai_app_client" FROM brandspace_app`);
    expect(statements).toContain(`GRANT SELECT ON "ai_app_client" TO brandspace_app`);
    const grants = statements.filter((s) => s.startsWith('GRANT'));
    for (const grant of grants.filter((g) => g.includes('"ai_app_client"'))) {
      if (grant.includes('brandspace_app'))
        expect(grant).toBe(`GRANT SELECT ON "ai_app_client" TO brandspace_app`);
    }
  });

  it('keeps every code and token inside its connection workspace (composite foreign keys)', () => {
    for (const table of ['ai_app_authorization_code', 'ai_app_token', 'ai_app_rate_window']) {
      expect(sql).toMatch(
        new RegExp(
          `"${table}_connection_fkey" FOREIGN KEY \\("workspaceId", "connectionId"\\)\\s+REFERENCES "ai_app_connection"\\("workspaceId", "id"\\)`,
        ),
      );
    }
  });

  it('stores hashes only, and bounds every lifetime', () => {
    expect(sql).toMatch(
      /"ai_app_authorization_code_hash_shape"\s+CHECK \("codeHash" ~ '\^\[0-9a-f\]\{64\}\$'\)/,
    );
    expect(sql).toMatch(
      /"ai_app_token_hash_shape"\s+CHECK \("tokenHash" ~ '\^\[0-9a-f\]\{64\}\$'\)/,
    );
    expect(sql).toMatch(/"expiresAt" <= "createdAt" \+ INTERVAL '10 minutes'/);
    expect(sql).toMatch(/"expiresAt" <= "createdAt" \+ INTERVAL '90 days'/);
    expect(sql).toMatch(
      /"scopes" <@ ARRAY\['brandspace\.read','brandspace\.write','offline_access'\]::TEXT\[\]/,
    );
  });

  it('the Prisma enums and the tenancy registry agree', () => {
    expect(Object.values(AiAppConnectionStatus).sort()).toEqual(['ACTIVE', 'REVOKED']);
    expect(Object.values(AiAppTokenKind).sort()).toEqual(['ACCESS', 'REFRESH']);
    expect(GLOBAL_MODELS).toContain('AiAppClient');
    for (const model of [
      'AiAppConnection',
      'AiAppAuthorizationCode',
      'AiAppToken',
      'AiAppRateWindow',
    ]) {
      expect(STRICT_TENANT_MODELS as readonly string[]).toContain(model);
    }
    expect(MODEL_TABLE_NAMES['AiAppToken']).toBe('ai_app_token');
  });

  it('comes directly after connectors B; only its D-112 fix (D-568) and the D-573 ceiling follow', () => {
    expect(EXPECTED_MIGRATIONS.slice(-5)).toEqual([
      '20261022092000_publish_job_handle_lookup_index',
      NAME,
      '20261023091000_ai_app_token_replaced_scoped',
      // D-573: the platform AI ceiling's in-flight estimate.
      '20261027100000_ai_platform_spend_ceiling',
      // D-574: the KEK re-wrap may replace a version's wrapped data key.
      '20261028090000_secret_version_kek_rewrap',
    ]);
  });
});
