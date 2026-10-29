import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { colorValues, effectOffValues } from '../../packages/ui/src/tokens';

/**
 * THE ONE BACKDROP (design-system programme, S5; D-5).
 *
 * There were four backdrop treatments — `rgba(12,12,14,.25)`, a slate
 * `rgba(15,23,42,.45)` with and without a 3 px blur, and `rgba(17,17,20,.28)`
 * — on two z-index scales (40–60 and a literal 70). Now every drawer, sheet and
 * dialog uses `Backdrop`: one tint, one blur, the token z-index. This keeps it
 * that way: the old tints cannot come back, and a new overlay that paints its
 * own full-window layer fails here.
 */
const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(path.join(root, dir)).flatMap((name) => {
    const rel = path.join(dir, name);
    if (name === 'node_modules' || name === '.next') return [];
    if (statSync(path.join(root, rel)).isDirectory()) return sources(rel);
    return /\.(tsx|ts|css)$/.test(name) && !/\.test\./.test(name) ? [rel] : [];
  });
}

const ALL = ['packages/ui/src', 'apps/dashboard/src', 'apps/admin/src'].flatMap(sources);

const USERS = [
  'packages/ui/src/overlays.tsx', // Dialog, SideSheet
  'packages/ui/src/post-detail-drawer.tsx',
  'packages/ui/src/copilot-shell.tsx', // the Copilot drawer and phone sheet
  'packages/ui/src/customer-shell.tsx', // the phone navigation drawer
  'packages/ui/src/app-shell.tsx', // the Control Center's navigation drawer
  'apps/dashboard/src/app/[locale]/automations/rule-dialog.tsx',
  'apps/dashboard/src/app/[locale]/campaigns/campaign-dialog.tsx',
];

describe('one backdrop', () => {
  it('the scrim tokens: one tint, one blur, on the generated :root', () => {
    const css = read('packages/ui/src/tokens.css');
    expect(css).toContain(`  --bs-scrim: ${colorValues.scrim};`);
    expect(css).toContain('  --bs-fx-backdrop-scrim: none;');
    // The Look & feel page's "blur off" switch covers the scrim too.
    expect(effectOffValues.blur['--bs-fx-backdrop-scrim']).toBe('none');
  });

  it('draws with the tokens and stacks on the token z-index', () => {
    const css = read('packages/ui/src/tokens.css');
    expect(css).toMatch(
      /\.bs-backdrop \{\s*position: fixed;\s*inset: 0;\s*background: var\(--bs-scrim\);\s*backdrop-filter: var\(--bs-fx-backdrop-scrim\);\s*\}/,
    );
    for (const layer of ['drawer', 'overlay', 'dialog']) {
      expect(css).toContain(
        `.bs-backdrop[data-backdrop='${layer}'] {\n  z-index: var(--bs-z-${layer});\n}`,
      );
    }
  });

  it.each(USERS)('%s sits on Backdrop', (file) => {
    expect(read(file)).toMatch(/<Backdrop\b/);
  });

  it('the four old treatments are gone from every stylesheet and component', () => {
    const OLD = [
      /rgba\(\s*12\s*,\s*12\s*,\s*14\s*,\s*0?\.25\s*\)/,
      /rgba\(\s*15\s*,\s*23\s*,\s*42\s*,\s*0?\.45\s*\)/,
      /--bs-lit-111114-a28/,
      /--bs-z-70\b/,
    ];
    const found = ALL.flatMap((file) =>
      OLD.filter((pattern) => pattern.test(read(file))).map((pattern) => `${file}: ${pattern}`),
    );
    expect(found).toEqual([]);
  });

  it('no component paints its own full-window layer behind an overlay', () => {
    // A fixed, inset-0 element with a background, written inline in a
    // component: that is a backdrop, and it belongs to Backdrop.
    const inline = /position: 'fixed',\s*inset: 0,(?:\s*[a-zA-Z]+: [^,\n]+,)*?\s*background: /;
    const found = ALL.filter((file) => file.endsWith('.tsx') && inline.test(read(file)));
    expect(found).toEqual([]);
  });
});
