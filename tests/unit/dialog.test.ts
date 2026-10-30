import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE DIALOG, TWO LOOKS (design-system programme, S5; D-580).
 *
 * `Dialog` painted its panel inline. It is now `.bs-dialog` in tokens.css:
 *   - the console look is what the inline style painted;
 *   - the customer look (the owner's choice) is the prototype's modal, the
 *     campaign dialog's `.bsp-cp-dialog`, value for value.
 */
const read = (file: string) => readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
const tokens = read('packages/ui/src/tokens.css');
const prototype = read('packages/ui/src/prototype.css');

function decls(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{\\n([\\s\\S]*?)\\n\\}`).exec(css);
  expect(match, selector).not.toBeNull();
  return Object.fromEntries(
    [...match![1]!.matchAll(/^\s*(--[a-z-]+|[a-z-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!]),
  );
}

const CUSTOMER = '.bsp-frame .bs-dialog:not(.bs-gallery-console *)';

describe('the console look: what the inline style painted', () => {
  it('30rem, radius 18, the overlay shadow, 32px', () => {
    expect(decls(tokens, '.bs-dialog')).toEqual({
      '--bs-dialog-title-tracking': '-0.035em',
      '--bs-dialog-max-block': '90vh',
      'inline-size': '100%',
      'max-inline-size': 'var(--bsp-rem-30)',
      'max-block-size': 'var(--bs-dialog-max-block)',
      'overflow-y': 'auto',
      background: 'var(--bs-surface)',
      'border-radius': 'var(--bsp-rem-1-125)',
      'box-shadow': 'var(--bs-shadow-overlay)',
      padding: 'var(--bsp-rem-2)',
    });
  });

  it('the header, the 29px title, the secondary close, the description and the footer', () => {
    expect(decls(tokens, '.bs-dialog-head')).toEqual({
      display: 'flex',
      'align-items': 'flex-start',
      'justify-content': 'space-between',
      gap: 'var(--bsp-rem-1)',
      'margin-block-end': 'var(--bsp-rem-0-5)',
    });
    expect(decls(tokens, '.bs-dialog-title')).toEqual({
      'font-size': 'var(--bsp-fs-29)',
      'line-height': 'var(--bsp-rem-2-125)',
      'font-weight': '700',
      'letter-spacing': 'var(--bs-dialog-title-tracking)',
      color: 'var(--bs-text-primary)',
    });
    expect(decls(tokens, '.bsp-btn.bs-dialog-close')).toEqual({
      color: 'var(--bs-text-secondary)',
    });
    expect(decls(tokens, '.bs-dialog-desc')).toMatchObject({
      'margin-block-end': 'var(--bsp-rem-1)',
      'font-size': 'var(--bsp-fs-11)',
      color: 'var(--bs-text-secondary)',
    });
    expect(decls(tokens, '.bs-dialog-foot')).toEqual({
      display: 'flex',
      'flex-wrap': 'wrap',
      'justify-content': 'flex-end',
      gap: 'var(--bsp-rem-0-5)',
      'margin-block-start': 'var(--bsp-rem-1-5)',
    });
  });
});

describe("the customer look: the prototype's modal", () => {
  it("the panel is the campaign dialog's, value for value", () => {
    const cp = decls(prototype, '.bsp-cp-dialog');
    const own = decls(tokens, CUSTOMER);
    // The two values the panel holds in variables, resolved.
    expect(own['--bs-dialog-max-block']).toBe(cp['max-block-size']);
    expect(own['--bs-dialog-shadow']).toBe(cp['box-shadow']);
    for (const prop of [
      'inline-size',
      'overflow',
      'background',
      'border-radius',
      'padding',
      'box-sizing',
      'display',
      'flex-direction',
      'gap',
      'color',
      'line-height',
    ]) {
      const value = own[prop] ?? decls(tokens, '.bs-dialog')[prop];
      expect(value, prop).toBe(cp[prop]);
    }
    expect(own['max-inline-size']).toBe('none');
  });

  it("the header is the campaign dialog's, the title is `.sech` at 20px, the close is the ghost button's", () => {
    expect(decls(tokens, `${CUSTOMER} > .bs-dialog-head`)).toEqual({
      'align-items': decls(prototype, '.bsp-cp-dialog-h')['align-items'],
      gap: 'normal',
      'margin-block-end': '0',
    });
    const sech = decls(prototype, '.bsp-sech');
    const title = decls(tokens, `${CUSTOMER} .bs-dialog-title`);
    for (const prop of ['margin', 'line-height', 'font-weight']) {
      expect(title[prop], prop).toBe(sech[prop]);
    }
    // `.cp-dialog-h > .sech`: the modal's title is the section head at 20px.
    expect(title['font-size']).toBe(decls(prototype, '.bsp-cp-dialog-h > .bsp-sech')['font-size']);
    expect(decls(tokens, '.bs-dialog')['--bs-dialog-title-tracking']).toBe(sech['letter-spacing']);
    expect(decls(tokens, `${CUSTOMER} .bs-dialog-close`)).toEqual({ color: 'var(--bs-btn-fg)' });
  });

  it('the column gap spaces the description and the footer, so their own margins go', () => {
    expect(decls(tokens, `${CUSTOMER} > .bs-dialog-desc`)).toEqual({ 'margin-block-end': '0' });
    expect(decls(tokens, `${CUSTOMER} > .bs-dialog-foot`)).toEqual({ 'margin-block-start': '0' });
  });
});

describe('the component', () => {
  it('carries the classes and no inline style', () => {
    const overlays = read('packages/ui/src/overlays.tsx');
    const dialog = overlays.slice(
      overlays.indexOf('export function Dialog('),
      overlays.indexOf('export function ConfirmDialog('),
    );
    expect(dialog).toContain('className="bs-dialog bs-dialog-in"');
    for (const part of ['bs-dialog-head', 'bs-dialog-title', 'bs-dialog-desc', 'bs-dialog-foot']) {
      expect(dialog, part).toContain(`className="${part}"`);
    }
    expect(dialog).toContain('bs-dialog-close');
    expect(dialog).not.toMatch(/\bstyle=\{/);
  });
});
