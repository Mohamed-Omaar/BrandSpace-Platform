import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ui from '../../packages/ui/src/data';

/**
 * THE TABLE IS A CLASS (design-system programme, S5).
 *
 * `thStyle()`, `tdStyle()`, the Control Center's `tableStyle()` and the
 * customer app's identical `customerTableStyle()` painted every table inline.
 * The declarations are now `.bs-table`, `.bs-th` and `.bs-td` in tokens.css,
 * which both apps load. This pins them to what the helpers painted, token for
 * token, so the move changes neither look.
 */
const css = readFileSync(path.resolve(__dirname, '../../packages/ui/src/tokens.css'), 'utf8');
const read = (file: string) => readFileSync(path.resolve(__dirname, '../..', file), 'utf8');

function decls(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{\\n([\\s\\S]*?)\\n\\}`).exec(css);
  expect(match, selector).not.toBeNull();
  return Object.fromEntries(
    [...match![1]!.matchAll(/^\s*([a-z-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!]),
  );
}

describe('the table classes', () => {
  it('the hairline rule and the header tracking are the inline values, as variables', () => {
    expect(decls(':is(.bs-th, .bs-td)')).toEqual({
      '--bs-table-rule': '1px solid var(--bs-hairline)',
      '--bs-table-head-tracking': '0.04em',
    });
  });

  it('.bs-table is what tableStyle() / customerTableStyle() painted', () => {
    expect(decls('.bs-table')).toEqual({
      'inline-size': '100%',
      'border-collapse': 'collapse',
      'font-size': 'var(--bsp-fs-11)',
      'text-align': 'start',
    });
  });

  it("DataTable's table adds the rest of the small body type", () => {
    expect(decls('.bs-table.bs-table-body')).toEqual({
      'line-height': 'var(--bsp-rem-1)',
      'font-weight': '400',
      'letter-spacing': 'normal',
    });
  });

  it("DataTable's scroll box is scrollContainerStyle() plus its soft surface", () => {
    expect(decls('.bs-table-scroll')).toEqual({
      'overflow-x': 'auto',
      'max-inline-size': '100%',
      'min-inline-size': '0',
      position: 'relative',
      'border-radius': 'var(--bsp-rem-0-6875)',
      background: 'var(--bs-surface)',
    });
  });

  it('.bs-th is what thStyle() painted: 8px 16px, 9px at 600, uppercase, a hairline', () => {
    expect(decls('.bs-th')).toEqual({
      'text-align': 'start',
      'padding-block': 'var(--bsp-rem-0-5)',
      'padding-inline': 'var(--bsp-rem-1)',
      background: 'transparent',
      'border-block-end': 'var(--bs-table-rule)',
      color: 'var(--bs-text-muted)',
      'font-size': 'var(--bsp-fs-9)',
      'line-height': 'var(--bsp-rem-0-75)',
      'font-weight': '600',
      'letter-spacing': 'var(--bs-table-head-tracking)',
      'text-transform': 'uppercase',
      'white-space': 'nowrap',
    });
  });

  it('.bs-td is what tdStyle() painted: 16px, a row separator, ink', () => {
    expect(decls('.bs-td')).toEqual({
      'padding-block': 'var(--bsp-rem-1)',
      'padding-inline': 'var(--bsp-rem-1)',
      'border-block-end': 'var(--bs-table-rule)',
      'vertical-align': 'middle',
      color: 'var(--bs-text-primary)',
    });
  });

  it('a selected row keeps its lavender fill under the pointer, as the inline style did', () => {
    expect(decls(".bs-row[aria-selected='true'],\n.bs-row[aria-selected='true']:hover")).toEqual({
      background: 'var(--bs-surface-lavender)',
    });
  });

  it('no other rule names table, th or td, so the class keeps the precedence the inline style had', () => {
    for (const file of [
      'packages/ui/src/tokens.css',
      'packages/ui/src/prototype.css',
      'packages/ui/src/content-studio.css',
      'packages/ui/src/brand-brain.css',
      'packages/ui/src/gallery-console.css',
      'packages/ui/src/entry.css',
    ]) {
      const rules = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
      expect(rules, file).not.toMatch(/(^|[\s,>+~(])(table|thead|tbody|tr|th|td)\s*[,{:[>.]/m);
    }
  });
});

describe('the API', () => {
  it('the inline helpers are gone; the classes replace them', () => {
    expect('thStyle' in ui).toBe(false);
    expect('tdStyle' in ui).toBe(false);
    expect(ui.TABLE_CLASS).toBe('bs-table');
    expect(ui.TH_CLASS).toBe('bs-th');
    expect(ui.TD_CLASS).toBe('bs-td');
    expect(read('apps/admin/src/components/console-ui.tsx')).not.toMatch(
      /function (table|th|td)Style/,
    );
    expect(read('apps/dashboard/src/components/customer-styles.ts')).not.toMatch(
      /customer(Table|Th|Td)Style/,
    );
  });
});
