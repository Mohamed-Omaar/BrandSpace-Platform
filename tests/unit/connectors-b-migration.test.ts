import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SocialDataDeletionStatus,
  SocialInboundEventKind,
  SocialInboundEventStatus,
} from '@prisma/client';
import { EXPECTED_MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * CONNECTORS STEP B — THREE MIGRATIONS, EXACTLY AS THE OWNER APPROVED THEM.
 *
 * B1 is one transaction: three enums, the two PLATFORM-OWNED tables with their
 * CHECKs and indexes, RLS enabled and forced, a platform_only policy, the
 * tenant role's privileges revoked, and a self-check that fails the migration
 * if either table is reachable by the tenant role. B2 and B3 are each a single
 * CREATE INDEX CONCURRENTLY, which cannot run inside a transaction, so each is
 * the only statement in its file (the M3 convention, OPERATIONS §6.10).
 *
 * The tenant boundary and the CHECKs are proven against real PostgreSQL in
 * tests/isolation/connectors-b-tables.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const B1 = '20261022090000_connectors_b_inbound_tables';
const B2 = '20261022091000_social_connection_subject_lookup_index';
const B3 = '20261022092000_publish_job_handle_lookup_index';
const read = (name: string) =>
  readFileSync(
    path.join(root, 'packages/database/prisma/migrations', name, 'migration.sql'),
    'utf8',
  );
const statementsOf = (sql: string) =>
  sql
    .split('\n')
    .map((line) => line.replace(/\s*--.*$/, ''))
    .join('\n')
    .replace(/DO \$\$[\s\S]*?\$\$;/, () => 'DO $$ … $$;')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement.length > 0);

const b1 = read(B1);
const b1Statements = statementsOf(b1);

describe('connectors B · B1 — the inbound-event and data-deletion tables', () => {
  it('is one transaction with a short lock timeout, ending in the proof', () => {
    expect(b1Statements[0]).toBe('BEGIN');
    expect(b1Statements[1]).toBe(`SET LOCAL lock_timeout = '5s'`);
    expect(b1Statements.at(-2)).toBe('DO $$ … $$');
    expect(b1Statements.at(-1)).toBe('COMMIT');
  });

  it('creates the three enums and the two tables, and nothing else is created or changed', () => {
    const creates = b1Statements.filter((statement) => statement.startsWith('CREATE '));
    expect(creates.map((statement) => statement.split(' (')[0]?.split(' AS ')[0])).toEqual([
      'CREATE TYPE "SocialInboundEventKind"',
      'CREATE TYPE "SocialInboundEventStatus"',
      'CREATE TYPE "SocialDataDeletionStatus"',
      'CREATE TABLE "social_inbound_event"',
      'CREATE UNIQUE INDEX "social_inbound_event_provider_kind_dedupeKey_key" ON "social_inbound_event"',
      'CREATE INDEX "social_inbound_event_status_receivedAt_idx" ON "social_inbound_event"',
      'CREATE INDEX "social_inbound_event_status_claimedAt_idx" ON "social_inbound_event"',
      'CREATE TABLE "social_data_deletion_request"',
      'CREATE UNIQUE INDEX "social_data_deletion_request_confirmationCode_key" ON "social_data_deletion_request"',
      'CREATE UNIQUE INDEX "social_data_deletion_request_inboundEventId_key" ON "social_data_deletion_request"',
      'CREATE INDEX "social_data_deletion_request_provider_subjectHash_idx" ON "social_data_deletion_request"',
      'CREATE INDEX "social_data_deletion_request_status_requestedAt_idx" ON "social_data_deletion_request"',
      'CREATE POLICY platform_only ON "social_inbound_event" TO brandspace_platform USING',
      'CREATE POLICY platform_only ON "social_data_deletion_request" TO brandspace_platform USING',
    ]);
    const upper = b1Statements.join(' ').toUpperCase();
    for (const word of ['UPDATE "', 'DELETE FROM', 'DROP ', 'NO FORCE', 'ALTER TYPE', 'INSERT ']) {
      expect(upper, word).not.toContain(word);
    }
  });

  it('is platform-only: RLS enabled and forced, the tenant role revoked, the platform role granted', () => {
    for (const table of ['social_inbound_event', 'social_data_deletion_request']) {
      expect(b1Statements).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(b1Statements).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(b1Statements).toContain(`REVOKE ALL ON "${table}" FROM brandspace_app`);
      expect(b1Statements).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO brandspace_platform`,
      );
    }
    expect(b1).not.toMatch(/TO brandspace_app/);
  });

  it('proves the boundary before it commits', () => {
    expect(b1).toMatch(/relrowsecurity AND relforcerowsecurity/);
    expect(b1).toMatch(/has_table_privilege\('brandspace_app'/);
    expect(b1).toMatch(/RAISE EXCEPTION 'connectors B: not platform-only/);
  });

  it('holds no token, secret or raw platform user id: hashes and codes are shape-checked', () => {
    expect(b1).toContain(`CHECK ("dedupeKey" ~ '^[0-9a-f]{64}$')`);
    expect(b1).toContain(
      `CHECK ("subjectHash" IS NULL OR "subjectHash" ~ '^v[0-9]{1,4}:[0-9a-f]{64}$')`,
    );
    expect(b1).toContain(`CHECK ("subjectHash" ~ '^v[0-9]{1,4}:[0-9a-f]{64}$')`);
    expect(b1).toContain(`CHECK ("confirmationCode" ~ '^[A-Za-z0-9]{20,64}$')`);
    expect(b1).toContain('CHECK (pg_column_size("payload") <= 65536)');
    expect(b1).not.toMatch(/"(accessToken|token|secret|userId|platformUserId)"/);
  });

  it('a deletion request survives the inbound event it came from', () => {
    expect(b1).toMatch(
      /FOREIGN KEY \("inboundEventId"\) REFERENCES "social_inbound_event" \("id"\)\s+ON DELETE SET NULL/,
    );
  });

  it('the Prisma enums agree with the SQL', () => {
    expect(Object.values(SocialInboundEventKind)).toEqual([
      'WEBHOOK',
      'DEAUTHORIZE',
      'DATA_DELETION',
    ]);
    expect(Object.values(SocialInboundEventStatus)).toEqual([
      'RECEIVED',
      'PROCESSING',
      'PROCESSED',
      'IGNORED',
      'FAILED',
    ]);
    expect(Object.values(SocialDataDeletionStatus)).toEqual([
      'RECEIVED',
      'IN_PROGRESS',
      'COMPLETED',
    ]);
  });
});

describe('connectors B · B2 and B3 — one concurrent index each, nothing else', () => {
  it('B2 is the subject lookup, partial, and the only statement', () => {
    expect(statementsOf(read(B2))).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "social_connection_provider_subject_hash_idx" ON "social_connection" ("provider", "providerSubjectHash") WHERE "providerSubjectHash" IS NOT NULL',
    ]);
  });

  it('B3 is the handle lookup, partial, and the only statement', () => {
    expect(statementsOf(read(B3))).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "publish_job_provider_handle_idx" ON "publish_job" ("provider", "providerHandle") WHERE "providerHandle" IS NOT NULL',
    ]);
  });
});

describe('connectors B · order', () => {
  it('the three come directly after connectors A, in order, and are the last', () => {
    expect(EXPECTED_MIGRATIONS.slice(-4)).toEqual([
      '20261021090000_connectors_a_handles_and_subjects',
      B1,
      B2,
      B3,
    ]);
  });
});
