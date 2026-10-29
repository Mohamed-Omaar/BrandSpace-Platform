import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE TICK COLOUR (design-system programme, S5; D-577).
 *
 * Every native checkbox and radio draws its tick in `--bs-check-accent` (ink),
 * from one global rule in tokens.css. Before, three colours — purple in two
 * places, ink in one, the browser's blue elsewhere. This keeps it one: no
 * stylesheet or component may set its own tick colour on a checkbox or radio.
 */
const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const SHEETS = [
  'packages/ui/src/tokens.css',
  'packages/ui/src/prototype.css',
  'packages/ui/src/entry.css',
  'packages/ui/src/content-studio.css',
  'packages/ui/src/brand-brain.css',
];

describe('one tick colour', () => {
  it('the token is ink, on the generated :root', () => {
    expect(read('packages/ui/src/tokens.css')).toContain('  --bs-check-accent: var(--bs-ink);');
  });

  it('one global rule draws every checkbox and radio with it', () => {
    expect(read('packages/ui/src/tokens.css')).toMatch(
      /input\[type='checkbox'\],\ninput\[type='radio'\] \{\n {2}accent-color: var\(--bs-check-accent\);\n\}/,
    );
  });

  it.each(SHEETS)('%s sets no other accent-color', (file) => {
    const others = (read(file).match(/accent-color:[^;]+;/g) ?? []).filter(
      (decl) => decl !== 'accent-color: var(--bs-check-accent);',
    );
    expect(others).toEqual([]);
  });
});
