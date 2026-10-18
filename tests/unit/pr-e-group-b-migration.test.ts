import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * PR E (Group B, D-496) — THREE COLUMNS FOR THREE ROWS, IN ONE ADDITIVE,
 * FORWARD-ONLY, SHORT-LOCKED MIGRATION, exactly as the owner approved it:
 * `campaign.plannedPostCount` with its CHECK (Campaigns 1),
 * `brand.aiDraftsToReview` NOT NULL DEFAULT false (Settings 3; new brands are
 * written ON by brand creation) and `insight.snoozedUntil` (Home 4). No UPDATE
 * and no RLS lift; RLS is proven enabled and forced on all three before COMMIT.
 * The CHECK and the tenant boundary are proven against real PostgreSQL in
 * tests/isolation/pr-e-group-b-fields.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = '20261020090000_group_b_fields';
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

describe('PR E — the Group B fields', () => {
  it('is one transaction: the lock timeout, the four changes in order, then the proof', () => {
    expect(statements).toEqual([
      'BEGIN',
      `SET LOCAL lock_timeout = '5s'`,
      `ALTER TABLE "campaign" ADD COLUMN "plannedPostCount" INTEGER`,
      `ALTER TABLE "campaign" ADD CONSTRAINT "campaign_planned_post_count_positive" CHECK ("plannedPostCount" IS NULL OR "plannedPostCount" > 0)`,
      `ALTER TABLE "brand" ADD COLUMN "aiDraftsToReview" BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE "insight" ADD COLUMN "snoozedUntil" TIMESTAMPTZ(3)`,
      'DO $$ … $$',
      'COMMIT',
    ]);
  });

  it('proves RLS enabled and forced on campaign, brand and insight before it commits', () => {
    expect(sql).toMatch(/ARRAY\['campaign', 'brand', 'insight'\]/);
    expect(sql).toMatch(/relrowsecurity/);
    expect(sql).toMatch(/relforcerowsecurity/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it('never rewrites a row, lifts RLS, drops anything, adds a table or touches a policy', () => {
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
    ]) {
      expect(upper, word).not.toContain(word);
    }
  });

  it('comes directly after batch 7 PR C, and only connectors A and B and the AI apps migration follow it', () => {
    expect(EXPECTED_MIGRATIONS.slice(-7)).toEqual([
      '20261016090000_content_item_publish_time',
      NAME,
      '20261021090000_connectors_a_handles_and_subjects',
      // Connectors B: the inbound-event and data-deletion tables, then two lookup indexes.
      '20261022090000_connectors_b_inbound_tables',
      '20261022091000_social_connection_subject_lookup_index',
      '20261022092000_publish_job_handle_lookup_index',
      // D-566: Connected AI apps (the remote MCP server).
      '20261023090000_ai_app_connections',
    ]);
  });
});
