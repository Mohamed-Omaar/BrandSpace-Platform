import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS } from '../../packages/database/src/migration-manifest';

/**
 * D-574 — THE KEK RE-WRAP MAY REPLACE A VERSION'S WRAPPED DATA KEY, AND NOTHING ELSE.
 *
 * The forward migration replaces `app.reject_secret_material_mutation()` exactly
 * as approved (owner, 2026-10-28, with the amendment that the version's identity
 * is always immutable): the material and the identity can never change; the
 * wrapped key, its provider and its key id change only under the
 * transaction-scoped flag `app.kek_rewrap`. The behaviour is proven against
 * PostgreSQL in tests/isolation/kek-rewrap.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = '20261028090000_secret_version_kek_rewrap';
const sql = readFileSync(
  path.join(root, 'packages/database/prisma/migrations', NAME, 'migration.sql'),
  'utf8',
);
const code = sql
  .split('\n')
  .map((line) => line.replace(/\s*--.*$/, ''))
  .join('\n');

describe('D-574 · the secret_version trigger migration', () => {
  it('is followed only by the PR A AI output failure classes', () => {
    expect(EXPECTED_MIGRATIONS.slice(EXPECTED_MIGRATIONS.indexOf(NAME))).toEqual([
      NAME,
      '20261101090000_ai_output_failure_classes',
      // P1: each person's light / dark / device choice (D-592).
      '20261102090000_user_colour_scheme',
      // PR B: one Copilot conversation per person per brand (D-591).
      '20261102120000_one_assistant',
    ]);
  });

  it('replaces the function only: no trigger, table or grant is touched', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION app\.reject_secret_material_mutation\(\)/);
    expect(code).not.toMatch(/\b(DROP|ALTER|GRANT|REVOKE|CREATE TRIGGER|DELETE|TRUNCATE)\b/i);
  });

  it('always refuses a change to the material or the identity', () => {
    const always = code.slice(code.indexOf('IF NEW."id"'), code.indexOf('END IF;'));
    for (const column of [
      'id',
      'secretRecordId',
      'version',
      'ciphertext',
      'iv',
      'authTag',
      'encryptionContext',
    ]) {
      expect(always, column).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`);
    }
    expect(always).not.toContain('app.kek_rewrap');
  });

  it('lets only the wrapped key, its provider and its key id change, and only under the flag', () => {
    const gated = code.slice(code.indexOf('IF (NEW."wrappedDataKey"'));
    for (const column of ['wrappedDataKey', 'keyProvider', 'keyId']) {
      expect(gated, column).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`);
    }
    expect(gated).toContain(`coalesce(current_setting('app.kek_rewrap', true), '') <> 'on'`);
  });
});
