import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * §8 MO1–MO4 (Phase 2B-2b, D-349) — the shell's motion, as rules read from
 * source. The browser half is `tests/e2e/prototype-v90-phase2b2b-shell.spec.ts`.
 */

const read = (file: string) => readFileSync(file, 'utf8');
const css = read('packages/ui/src/tokens.css');
const shell = read('packages/ui/src/app-shell.tsx');
const pill = read('packages/ui/src/segment-pill.tsx');

describe('MO1 — page entrance', () => {
  it('opacity, a 10 px rise and a 6 px blur, 440 ms; later blocks 300 ms without blur', () => {
    const enter = css.slice(css.indexOf('@keyframes bs-page-in {'));
    expect(enter.slice(0, enter.indexOf('}\n}'))).toMatch(
      /opacity: 0;\s*translate: 0 10px;\s*filter: blur\(6px\);/,
    );
    const plain = css.slice(css.indexOf('@keyframes bs-page-in-plain {'));
    expect(plain.slice(0, plain.indexOf('}\n}'))).not.toContain('filter');
    expect(css).toContain('animation: bs-page-in var(--bs-motion-page) var(--bs-ease-out) both;');
    expect(css).toContain('animation-duration: var(--bs-motion-page-late);');
  });

  it('45 ms apart, capped at the 7th block', () => {
    for (let n = 1; n <= 5; n += 1) {
      expect(css).toContain(
        `.bs-section-stack > :nth-child(${n}) {\n  animation-delay: calc(var(--bs-motion-page-step) * ${n});`,
      );
    }
    expect(css).toContain(
      '.bs-section-stack > :nth-child(n + 6) {\n  animation-delay: calc(var(--bs-motion-page-step) * 6);',
    );
  });

  it('glass is never blurred (§8.0)', () => {
    expect(css).toContain(":has(.bb-hero, [style*='backdrop-filter'])");
  });

  it('once per tab, through sessionStorage, and nothing when storage is refused', () => {
    const gate = shell.slice(
      shell.indexOf('function usePageEnterGate'),
      shell.indexOf('let lastRailPill'),
    );
    expect(gate).toContain('window.sessionStorage.setItem(PAGE_ENTER_KEY');
    expect(gate).toMatch(/\} catch \{\s*return;\s*\}/);
    expect(gate).toContain("flow.setAttribute('data-entered', '')");
    expect(shell).toContain("key={pathname ?? ''}");
  });
});

describe('MO2 — the rail pill', () => {
  it('one pill glides 440 ms on transform, width and height; the first placement does not', () => {
    const hook = shell.slice(
      shell.indexOf('function useNavPill'),
      shell.indexOf('function NavList'),
    );
    expect(hook).toContain("['transform', 'width', 'height']");
    expect(hook).toContain('motionMs.pill');
    expect(hook).toContain('prefersReducedMotion()');
    expect(hook).toContain('put(target, placedOnce.current)');
  });

  it('the item stops painting its own fill only once the pill is placed', () => {
    expect(css).toContain(".bs-nav-list[data-pill='placed'] a[aria-current='page'] {");
  });
});

describe('MO3 — collapse', () => {
  it('the column transition exists only after a click, at 380 ms', () => {
    expect(css).toContain(
      '[data-sidebar-motion] .bs-shell {\n    transition: grid-template-columns var(--bs-motion-collapse) var(--bs-ease-out);',
    );
    expect(css).not.toContain('transition: grid-template-columns var(--bs-duration-slow)');
  });

  it('labels fade out first (110 ms) and in after (220 ms, 150 ms late)', () => {
    expect(css).toContain('transition: opacity var(--bs-motion-label-out) var(--bs-ease-out);');
    expect(css).toMatch(
      /animation: bs-label-in var\(--bs-motion-label-in\) var\(--bs-ease-out\)\s+var\(--bs-motion-label-in-delay\) both;/,
    );
  });

  it('the state changes at once; only the layout waits', () => {
    const toggle = shell.slice(
      shell.indexOf('const toggleCollapsed'),
      shell.indexOf('const layoutCollapsed'),
    );
    expect(toggle.indexOf('setCollapsed(next);')).toBeLessThan(toggle.indexOf('setTimeout'));
    expect(shell).toContain('aria-pressed={collapsed}');
  });
});

describe('MO4 — segmented pills', () => {
  it('is in the four controls the owner named', () => {
    expect(read('packages/ui/src/link-tabs.tsx')).toContain(
      `<SegmentPill selector='[aria-current="page"]' />`,
    );
    expect(read('packages/ui/src/calendar.tsx')).toContain(
      `<SegmentPill selector='[aria-pressed="true"]' />`,
    );
    expect(read('packages/ui/src/composer.tsx')).toContain(
      `<SegmentPill selector='[aria-pressed="true"]' />`,
    );
    // Gate 2b review (4f) — the notification kinds moved from the bell's
    // popover to the Notifications page, as its `LinkTabs` (the pill above).
    expect(read('apps/dashboard/src/app/[locale]/notifications/page.tsx')).toContain('<LinkTabs');
  });

  it('slides with clip-path only — the width/height exception is MO2’s alone', () => {
    expect(pill).toContain('clip-path ${motionMs.seg}ms var(--bs-ease-out)');
    expect(pill).not.toMatch(/style\.(width|height)\s*=/);
    expect(pill).not.toMatch(/transition[^;]*\b(width|height)\b/);
  });
});
