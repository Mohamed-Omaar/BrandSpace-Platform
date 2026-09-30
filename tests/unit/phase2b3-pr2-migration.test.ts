import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PublishAttemptOutcome } from '@prisma/client';
import { EXPECTED_MIGRATIONS as MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * PHASE 2B-3, PR 2 — M2, the one migration this PR carries.
 *
 * One enum value, in a migration of its own (the D-379 pattern), and nothing
 * else: no table, no column, no index, no row written.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const NAME = '20261011090000_publish_attempt_preflight_refused';
const sql = readFileSync(
  path.join(root, 'packages/database/prisma/migrations', NAME, 'migration.sql'),
  'utf8',
);
const statements = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')
  .split(';')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

describe('M2 — PREFLIGHT_REFUSED on PublishAttemptOutcome', () => {
  it('is exactly one ALTER TYPE … ADD VALUE IF NOT EXISTS, alone in its file', () => {
    expect(statements).toEqual([
      `ALTER TYPE "PublishAttemptOutcome" ADD VALUE IF NOT EXISTS 'PREFLIGHT_REFUSED'`,
    ]);
  });

  it('writes no row and changes no table', () => {
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(sql).not.toMatch(/\b(CREATE|ALTER) TABLE\b/);
    expect(sql).not.toMatch(/\bCREATE (UNIQUE )?INDEX\b/);
  });

  it('is the last migration in the manifest, directly after M1c', () => {
    expect(MIGRATIONS.at(-1)).toBe(NAME);
    expect(MIGRATIONS.at(-2)).toBe('20261010092000_automation_g13_checks_and_state');
  });

  it('the Prisma enum agrees, and keeps every earlier value', () => {
    expect(Object.values(PublishAttemptOutcome).sort()).toEqual(
      [
        'INDETERMINATE',
        'PERMANENT_FAILURE',
        'PREFLIGHT_REFUSED',
        'RETRYABLE_FAILURE',
        'SUCCEEDED',
      ].sort(),
    );
  });
});
