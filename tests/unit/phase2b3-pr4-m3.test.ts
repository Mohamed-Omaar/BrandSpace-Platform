import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * PHASE 2B-3 PR 4 — M3 IS INDEXES ONLY, AND NONE OF THEM BLOCKS WRITES.
 *
 * Each migration is ONE `CREATE INDEX CONCURRENTLY IF NOT EXISTS` statement and
 * nothing else: `CONCURRENTLY` takes SHARE UPDATE EXCLUSIVE, so inserts and
 * updates keep flowing while the index builds, and it can only run outside a
 * transaction block — which Prisma gives a single-statement migration. A
 * second statement in the same file would put it back inside one and fail the
 * deploy; any other statement would make M3 more than indexes.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const M3 = {
  '20261012090000_metric_observation_brand_window_index': {
    table: 'metric_observation',
    name: 'metric_observation_brand_metric_granularity_idx',
    columns: '("workspaceId", "brandId", "metricKey", "granularity", "periodStart")',
    where: null,
  },
  '20261012091000_metric_observation_item_pooling_index': {
    table: 'metric_observation',
    name: 'metric_observation_item_metric_granularity_idx',
    columns: '("workspaceId", "contentItemId", "metricKey", "granularity")',
    where: null,
  },
  '20261012092000_publish_job_published_population_index': {
    table: 'publish_job',
    name: 'publish_job_published_population_idx',
    columns: '("workspaceId", "brandId", "publishedAt")',
    where: `"status" = 'PUBLISHED'`,
  },
} as const;

/** The SQL a migration runs, with comments removed and whitespace collapsed. */
function statements(folder: string): string[] {
  const sql = readFileSync(
    path.join(root, 'packages/database/prisma/migrations', folder, 'migration.sql'),
    'utf8',
  );
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement.length > 0);
}

describe('M3 — three concurrent index builds, nothing else', () => {
  for (const [folder, index] of Object.entries(M3)) {
    it(`${folder}: exactly one CREATE INDEX CONCURRENTLY IF NOT EXISTS`, () => {
      const run = statements(folder);
      expect(run).toHaveLength(1);
      expect(run[0]).toBe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}" ON "${index.table}" ${index.columns}` +
          (index.where ? ` WHERE ${index.where}` : ''),
      );
    });
  }

  it('no M3 file drops, alters, rewrites, locks or grants anything', () => {
    for (const folder of Object.keys(M3)) {
      const sql = statements(folder).join(' ').toUpperCase();
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
        expect(sql, `${folder} ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('the manifest lists the three, after M2, in order', () => {
    const folders = Object.keys(M3);
    const at = folders.map((folder) => EXPECTED_MIGRATIONS.indexOf(folder));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(EXPECTED_MIGRATIONS.indexOf('20261011090000_publish_attempt_preflight_refused')).toBe(
      at[0]! - 1,
    );
  });

  it('the schema declares the two plain indexes by the same names, and points at the partial one', () => {
    const schema = readFileSync(path.join(root, 'packages/database/prisma/schema.prisma'), 'utf8');
    expect(schema).toContain('map: "metric_observation_brand_metric_granularity_idx"');
    expect(schema).toContain('map: "metric_observation_item_metric_granularity_idx"');
    expect(schema).toContain('`publish_job_published_population_idx`');
  });
});
