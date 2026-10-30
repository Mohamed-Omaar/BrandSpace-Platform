import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE TOOLTIP IS A CLASS (design-system programme, S5).
 *
 * `Tooltip` painted its wrapper, trigger and label inline. They are now
 * `.bs-tooltip-host`, `.bs-tooltip-trigger` and `.bs-tooltip` in tokens.css,
 * with the same declarations and tokens, so the tooltip looks the same in both
 * apps.
 */
const read = (file: string) => readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
const css = read('packages/ui/src/tokens.css');

function decls(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{\\n([\\s\\S]*?)\\n\\}`).exec(css);
  expect(match, selector).not.toBeNull();
  return Object.fromEntries(
    [...match![1]!.matchAll(/^\s*(--[a-z-]+|[a-z-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!]),
  );
}

describe('the tooltip classes', () => {
  it('the label: ink, the caption type, 4px 8px, radius 8, the overlay shadow, above everything', () => {
    expect(decls('.bs-tooltip')).toEqual({
      '--bs-tooltip-gap': 'calc(100% + var(--bsp-px-8))',
      position: 'absolute',
      'z-index': 'var(--bs-z-tooltip)',
      padding: 'var(--bsp-rem-0-25) var(--bsp-rem-0-5)',
      'border-radius': 'var(--bsp-rem-0-5)',
      background: 'var(--bs-surface-ink)',
      color: 'var(--bs-text-inverse)',
      'font-size': 'var(--bsp-fs-9)',
      'line-height': 'var(--bsp-rem-0-75)',
      'font-weight': '400',
      'letter-spacing': 'normal',
      'white-space': 'nowrap',
      'pointer-events': 'none',
      'box-shadow': 'var(--bs-shadow-overlay)',
    });
  });

  it('sets no display, so `hidden` keeps a closed tooltip closed', () => {
    expect(decls('.bs-tooltip').display).toBeUndefined();
  });

  it('the two placements, 8px off the trigger', () => {
    expect(decls(".bs-tooltip[data-placement='block-end']")).toEqual({
      'inset-block-start': 'var(--bs-tooltip-gap)',
      'inset-inline-start': '50%',
      transform: 'translateX(-50%)',
    });
    expect(decls(".bs-tooltip[data-placement='inline-end']")).toEqual({
      'inset-inline-start': 'var(--bs-tooltip-gap)',
      'inset-block-start': '50%',
      transform: 'translateY(-50%)',
    });
  });

  it('the wrapper and the trigger shrink-wrap, or stretch and centre', () => {
    expect(decls('.bs-tooltip-host')).toEqual({ position: 'relative', display: 'inline-flex' });
    expect(decls('.bs-tooltip-trigger')).toEqual({ display: 'inline-flex' });
    expect(decls('.bs-tooltip-host[data-stretch],\n.bs-tooltip-trigger[data-stretch]')).toEqual({
      'inline-size': '100%',
      'justify-content': 'center',
    });
  });
});

describe('the component', () => {
  it('carries the classes and no inline style', () => {
    const overlays = read('packages/ui/src/overlays.tsx');
    const tooltip = overlays.slice(
      overlays.indexOf('export function Tooltip'),
      overlays.indexOf('export function DropdownMenu'),
    );
    expect(tooltip).toContain('className="bs-tooltip-host"');
    expect(tooltip).toContain('className="bs-tooltip-trigger"');
    expect(tooltip).toContain('className="bs-tooltip"');
    expect(tooltip).toContain('data-placement={placement}');
    expect(tooltip).not.toMatch(/\bstyle=\{/);
  });
});
