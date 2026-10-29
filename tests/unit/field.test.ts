import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ui from '../../packages/ui/src/primitives';

/**
 * THE FIELD'S GEOMETRY IS A CLASS (design-system programme, S5).
 *
 * `inputStyle()` / `textareaStyle()` painted the geometry of every
 * design-system field inline. It is now `.bs-field` in tokens.css, as
 * `--bs-control-*` variables, carried by `FIELD_CLASS` / `TEXTAREA_CLASS`.
 * This pins the values to what the helpers painted, and keeps the geometry
 * OFF `.bs-control`: many fields carry `bs-control` for its fill and states but
 * draw their own size (a compact filter select, the rule builder's inputs).
 */
const css = readFileSync(path.resolve(__dirname, '../../packages/ui/src/tokens.css'), 'utf8');

function body(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{\\n([\\s\\S]*?)\\n\\}`).exec(css);
  expect(match, selector).not.toBeNull();
  return match![1]!;
}
const decls = (selector: string) =>
  Object.fromEntries(
    [...body(selector).matchAll(/^\s*([a-z-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!]),
  );

describe('the field geometry', () => {
  it('is what inputStyle() painted: 9px 12px, radius 12, 14px, full width, inherited type', () => {
    expect(decls('.bs-field')).toEqual({
      '--bs-control-pad-block': 'var(--bsp-px-9)',
      '--bs-control-pad-inline': 'var(--bsp-px-12)',
      '--bs-control-radius': 'var(--bsp-px-12)',
      '--bs-control-font-size': 'var(--bsp-fs-14)',
      'inline-size': '100%',
      'box-sizing': 'border-box',
      'padding-block': 'var(--bs-control-pad-block)',
      'padding-inline': 'var(--bs-control-pad-inline)',
      'border-radius': 'calc(var(--bs-control-radius) * var(--bs-radius-scale))',
      color: 'var(--bs-text-primary)',
      'font-family': 'inherit',
      'font-size': 'var(--bs-control-font-size)',
      'line-height': 'normal',
    });
  });

  it('a multi-line field is what textareaStyle() added, strong enough to beat the frame rule', () => {
    expect(decls('.bs-control.bs-field.bs-field-multiline')).toEqual({
      'min-block-size': 'var(--bsp-rem-7)',
      resize: 'vertical',
      'padding-block': 'var(--bsp-px-10)',
      'line-height': '1.5',
    });
  });

  it('is not on .bs-control, so a field that only wants the fill keeps its own size', () => {
    const control = decls('.bs-control');
    for (const prop of [
      'inline-size',
      'padding-block',
      'padding-inline',
      'font-size',
      'font-family',
    ]) {
      expect(control[prop], prop).toBeUndefined();
    }
  });

  it('a tone keeps the 3:1 boundary an inline style used to win', () => {
    expect(decls(".bs-control[data-tone='error']")).toEqual({
      'border-color': 'var(--bs-danger) !important',
    });
    expect(decls(".bs-control[data-tone='success']")).toEqual({
      'border-color': 'var(--bs-success) !important',
    });
  });
});

describe('the API', () => {
  it('the inline helpers are gone; the classes replace them', () => {
    expect('inputStyle' in ui).toBe(false);
    expect('textareaStyle' in ui).toBe(false);
    expect(ui.FIELD_CLASS).toBe('bs-control bs-field');
    expect(ui.TEXTAREA_CLASS).toBe('bs-control bs-field bs-field-multiline');
  });
});
