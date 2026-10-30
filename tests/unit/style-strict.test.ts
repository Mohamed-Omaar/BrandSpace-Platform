import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';
import { ratchetedFiles } from '../../scripts/style/style-rules.mjs';

/**
 * THE RATCHET IS STRICT (design-system programme, S6).
 *
 * The hard-coded-style rules (ESLint `style/no-restricted-syntax`, stylelint
 * `scale-unlimited/declaration-strict-value`) are ERRORS in every file except
 * the files scripts/style/baseline.json still lists, where they are warnings
 * and the ratchet holds the counts. A new file, or a file whose counts reached
 * zero, has zero tolerance. `pnpm lint` runs both, so CI enforces it.
 */
const root = path.resolve(__dirname, '../..');
const baseline = JSON.parse(readFileSync(path.join(root, 'scripts/style/baseline.json'), 'utf8'));
const tsHeld = Object.keys(baseline.ts) as string[];
const cssHeld = Object.keys(baseline.css) as string[];

const severity = (value: unknown) => (Array.isArray(value) ? value[0] : value);

describe('ESLint', () => {
  const eslint = new ESLint({ cwd: root });
  const rule = async (file: string) =>
    severity(
      (await eslint.calculateConfigForFile(path.join(root, file))).rules?.[
        'style/no-restricted-syntax'
      ],
    );

  it('errors in a file the ratchet does not hold, a new one included', async () => {
    expect(await rule('packages/ui/src/backdrop.tsx')).toBe(2);
    expect(await rule('apps/dashboard/src/app/[locale]/a-new-page/page.tsx')).toBe(2);
  });

  it('warns in every file the ratchet holds, route segments like [locale] included', async () => {
    const withSegment = tsHeld.find((file) => file.includes('[locale]'));
    expect(withSegment).toBeDefined();
    for (const file of [tsHeld[0]!, withSegment!]) {
      expect(await rule(file), file).toBe(1);
    }
  }, 60_000);
});

describe('stylelint', () => {
  const rule = async (file: string) => {
    const config = await stylelint.resolveConfig(path.join(root, file), { cwd: root });
    const setting = config?.rules?.['scale-unlimited/declaration-strict-value'] as
      [unknown, { severity?: string }] | undefined;
    // No severity is stylelint's default, an error; no setting at all is a bug.
    return setting ? (setting[1]?.severity ?? 'error') : 'missing';
  };

  it('errors in a stylesheet the ratchet does not hold', async () => {
    expect(await rule('packages/ui/src/gallery-console.css')).toBe('error');
    expect(await rule('packages/ui/src/a-new-sheet.css')).toBe('error');
  });

  it('warns in every stylesheet the ratchet holds', async () => {
    for (const file of cssHeld) expect(await rule(file), file).toBe('warning');
  });
});

describe('the list both configs read', () => {
  it('is the baseline, escaped for globs', () => {
    expect(ratchetedFiles('ts')).toHaveLength(tsHeld.length);
    expect(ratchetedFiles('css')).toEqual(cssHeld.sort());
    expect(ratchetedFiles('ts').some((glob) => glob.includes('\\[locale\\]'))).toBe(true);
  });

  it('pnpm lint runs stylelint too', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.lint).toBe('eslint . && pnpm lint:style');
  });
});
