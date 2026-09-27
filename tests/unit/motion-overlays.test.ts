import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * §8 MO5–MO7 (Phase 2B-2b, D-350) — menus, listboxes, sheets and drawers;
 * modals; the Copilot panel. Read from source; the browser half is
 * `tests/e2e/prototype-v90-phase2b2b-shell.spec.ts`.
 */

const read = (file: string) => readFileSync(file, 'utf8');
const css = read('packages/ui/src/tokens.css');
const motion = read('packages/ui/src/motion-hooks.ts');

function keyframes(name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}\n}', start));
}

describe('MO5 — opening', () => {
  it('the container fades, grows from .97 and settles 4 px; an upward one rises', () => {
    expect(keyframes('bs-pop-in')).toMatch(
      /opacity: 0;\s*scale: 0\.97;\s*translate: 0 var\(--bs-pop-from, -4px\);/,
    );
    expect(css).toContain('--bs-pop-from: 4px;');
    expect(css).toContain('animation: bs-pop-in var(--bs-motion-menu-in) var(--bs-ease-out) both;');
  });

  it('rows: opacity, 3 px blur, 3 px rise, 220 ms, 22 ms apart, capped at the 6th', () => {
    expect(keyframes('bs-row-in')).toMatch(
      /opacity: 0;\s*filter: blur\(3px\);\s*translate: 0 3px;/,
    );
    expect(css).toContain(
      '.bs-pop > :nth-child(n + 6) {\n  animation-delay: calc(var(--bs-motion-menu-row-step) * 5);',
    );
  });

  it('never filters the glass itself: the container animates no filter (§8.0)', () => {
    expect(keyframes('bs-pop-in')).not.toContain('filter');
  });

  it('menus and listboxes are the notifications sheet’s glass, not a new material', () => {
    const panel = css.slice(css.indexOf('.bs-dropdown-panel {'));
    const rule = panel.slice(0, panel.indexOf('}'));
    expect(rule).toContain('background: var(--bs-surface-glass);');
    expect(rule).toContain('backdrop-filter: blur(24px);');
    // Never the prefixed twin: the build keeps only it, and Chrome ignores it.
    expect(rule).not.toContain('-webkit-backdrop-filter');
    expect(css).toContain('--bs-surface-glass: rgba(255, 255, 255, 0.96);');
    expect(read('packages/ui/src/tokens.ts')).toContain("drawerAlpha: 'rgba(255, 255, 255, 0.96)'");
  });

  it('is on every surface §8 names', () => {
    const overlays = read('packages/ui/src/overlays.tsx');
    expect(overlays).toContain('bs-dropdown-menu bs-dropdown-panel bs-pop');
    expect(overlays).toContain('className="bs-pop"');
    for (const file of [
      'packages/ui/src/app-shell.tsx',
      'packages/ui/src/post-detail-drawer.tsx',
      'apps/dashboard/src/app/[locale]/brand-brain/area-drawer.tsx',
    ]) {
      expect(read(file), file).toContain('className="bs-pop"');
    }
    expect(read('packages/ui/src/searchable-select.tsx')).toContain("opening ? ' bs-pop' : ''");
    expect(read('apps/dashboard/src/components/mention-field.tsx')).toContain(
      "className={opening ? 'bs-pop' : undefined}",
    );
  });
});

describe('MO5 — closing', () => {
  it('fades with a 4 px lift over 180 ms while the rows blur to 4 px, then unmounts', () => {
    expect(motion).toContain("{ opacity: 0, translate: '0 -4px' }");
    expect(motion).toContain("[{ filter: 'blur(0)' }, { filter: 'blur(4px)' }]");
    expect(motion).toContain('duration: motionMs.menuOut');
  });

  it('the close is immediate: a leaving surface is inert and hidden, and reduced motion skips it', () => {
    expect(motion).toContain('prefersReducedMotion()');
    expect(css).toContain('[data-leaving] {\n  pointer-events: none;');
    for (const file of [
      'packages/ui/src/overlays.tsx',
      'packages/ui/src/app-shell.tsx',
      'packages/ui/src/searchable-select.tsx',
      'apps/dashboard/src/components/mention-field.tsx',
      'apps/dashboard/src/app/[locale]/brand-brain/area-drawer.tsx',
    ]) {
      expect(read(file), file).toMatch(/'data-leaving': '', 'aria-hidden': true, inert: true/);
    }
  });
});

describe('MO6 — modals', () => {
  it('the dialog: opacity, .98 → 1, 8 px, 300 ms; the veil: a fade and blur 0 → 3 px, 260 ms', () => {
    expect(keyframes('bs-dialog-in')).toMatch(/opacity: 0;\s*scale: 0\.98;\s*translate: 0 8px;/);
    expect(keyframes('bs-veil-in')).toMatch(/opacity: 0;\s*backdrop-filter: blur\(0\);/);
    expect(css).toContain('animation: bs-dialog-in var(--bs-motion-dialog)');
    expect(css).toMatch(
      /\.bs-veil \{\s*backdrop-filter: blur\(3px\);\s*animation: bs-veil-in var\(--bs-motion-veil\)/,
    );
    const overlays = read('packages/ui/src/overlays.tsx');
    expect(overlays).toContain('className="bs-veil"');
    expect(overlays).toContain('className="bs-dialog-in"');
  });
});

describe('MO7 — the Copilot panel', () => {
  it('opacity, .98 → 1 and 16 px, 340 ms, from the bottom end corner', () => {
    expect(keyframes('bs-copilot-in')).toMatch(/opacity: 0;\s*scale: 0\.98;\s*translate: 0 16px;/);
    expect(css).toContain('transform-origin: bottom right;');
    expect(css).toContain("[dir='rtl'] .bs-copilot-in {\n  transform-origin: bottom left;");
    expect(read('packages/ui/src/copilot-shell.tsx').match(/bs-copilot-in/g)).toHaveLength(2);
  });
});
