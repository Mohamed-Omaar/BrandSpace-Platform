import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { statusMessage } from '../../apps/dashboard/src/i18n/messages';

/**
 * D11 (Phase 2B-2) — EVERY SUCCESS CODE A CUSTOMER ACTION EMITS HAS WORDS.
 *
 * `ok=SAVED` had none: pages that guard with `statusMessage(ok)` showed
 * nothing, and three that do not showed an empty green banner. This walks the
 * dashboard's server actions for the literal codes they put in the URL
 * (`ok: 'CODE'` and `ok=CODE`) and requires text for each, in both languages.
 * A code built at runtime (`PREFERENCE_${…}`) is not a literal and is covered
 * where it is built.
 *
 * Phase 2B-2b (item 8): also `done(locale, 'CODE')`, the helper Settings →
 * Publishing redirects through — the gap the Phase 2B-2 report found, where
 * `SETTINGS_SAVED` and the template codes were never checked.
 */

const root = path.resolve(__dirname, '../../apps/dashboard/src/app');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return files(full);
    return /actions\.tsx?$/.test(entry) ? [full] : [];
  });
}

function emittedCodes(): Map<string, string> {
  const codes = new Map<string, string>();
  for (const file of files(root)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bok: '([A-Z][A-Z_]*[A-Z])'/g)) {
      codes.set(match[1]!, path.relative(root, file));
    }
    for (const match of source.matchAll(/[?&]ok=([A-Z][A-Z_]*[A-Z])(?![A-Z_$])/g)) {
      codes.set(match[1]!, path.relative(root, file));
    }
    for (const match of source.matchAll(/\bdone\(\s*locale,\s*'([A-Z][A-Z_]*[A-Z])'\s*\)/g)) {
      codes.set(match[1]!, path.relative(root, file));
    }
  }
  return codes;
}

describe('D11 · success codes have words', () => {
  it('finds the codes it is meant to check', () => {
    const codes = emittedCodes();
    expect(codes.has('SAVED')).toBe(true);
    expect(codes.has('TEMPLATE_SAVED')).toBe(true);
    expect(codes.size).toBeGreaterThan(20);
    // Settings → Publishing, reached only through `done(locale, …)`; these two
    // codes come from nowhere else, so finding them proves the pattern works.
    for (const code of ['TEMPLATE_DELETED', 'TEMPLATE_DEFAULT_CHANGED']) {
      expect(codes.get(code), code).toBe(
        path.join('[locale]', 'settings', 'publishing', 'actions.ts'),
      );
    }
    expect(codes.has('SETTINGS_SAVED')).toBe(true);
  });

  it.each([...emittedCodes().entries()])('%s (from %s) has English and Arabic text', (code) => {
    expect(statusMessage(code, 'en'), code).not.toBeNull();
    expect(statusMessage(code, 'ar'), code).toMatch(/[؀-ۿ]/);
  });
});
