import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { motionMs } from '../../packages/ui/src/tokens';

/**
 * §8 (Phase 2B-2b, D-348) — the motion foundation, as rules: one set of
 * numbers in CSS and script, reduced motion OFF, no press motion, the hover
 * lift and the loading loops exactly as §8 writes them.
 */

const css = readFileSync('packages/ui/src/tokens.css', 'utf8');
const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The body of the first rule for `selector`. */
function rule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `${selector} is missing`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('}', start));
}

describe('§8 durations', () => {
  it('every --bs-motion-* token equals its script mirror, and there are no strays', () => {
    const declared = [...css.matchAll(/--bs-motion-([a-z-]+):\s*(\d+)ms;/g)].map(
      ([, name, value]) => [name, Number(value)] as const,
    );
    expect(Object.fromEntries(declared)).toEqual(
      Object.fromEntries(Object.entries(motionMs).map(([key, value]) => [kebab(key), value])),
    );
  });

  it('carries §8’s numbers exactly', () => {
    expect(motionMs).toMatchObject({
      page: 440,
      pageLate: 300,
      pageStep: 45,
      pill: 440,
      collapse: 380,
      labelOut: 110,
      labelIn: 220,
      labelInDelay: 150,
      seg: 380,
      menuRow: 220,
      menuRowStep: 22,
      menuOut: 180,
      dialog: 300,
      veil: 260,
      copilot: 340,
      toastIn: 420,
      toastStep: 50,
      toastCheckDelay: 160,
      toastOut: 280,
      bar: 800,
      barStep: 35,
      line: 1000,
      dot: 360,
      dotStep: 40,
      count: 650,
      loop: 1600,
      hover: 220,
      dragLift: 180,
      drop: 360,
      settle: 300,
    });
    // MO5 "180–200 ms" opening; state feedback is capped at 200 ms.
    expect(motionMs.menuIn).toBeGreaterThanOrEqual(180);
    expect(motionMs.menuIn).toBeLessThanOrEqual(200);
    expect(motionMs.state).toBeLessThanOrEqual(200);
  });
});

describe('reduced motion is OFF, not faster (owner answer 9)', () => {
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {'));

  it('switches animation and transition off entirely', () => {
    expect(block).toMatch(/animation: none !important;/);
    expect(block).toMatch(/transition: none !important;/);
    expect(css).not.toContain('animation-duration: 0.01ms');
    expect(css).not.toContain('transition-duration: 0.01ms');
  });

  it('script animations ask first', () => {
    const helper = readFileSync('packages/ui/src/motion.ts', 'utf8');
    expect(helper).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
  });
});

describe('MO14 — hover lifts, pressing does not move', () => {
  it('no :active transform anywhere in the shared stylesheet', () => {
    expect(css).not.toMatch(/:active[^{]*\{[^}]*transform/);
    expect(rule(css, '.bs-pressable')).not.toContain('transform');
  });

  it('a clickable card lifts 2 px over 220 ms, with a larger shadow than it rests on', () => {
    expect(rule(css, '.bs-liftable:hover')).toContain('translateY(-2px)');
    expect(rule(css, '.bs-liftable:hover')).toContain('var(--bs-shadow-card)');
    expect(rule(css, '.bs-card-liftable:hover')).toContain('translateY(-2px)');
    expect(rule(css, '.bs-card-liftable:hover')).toContain('var(--bs-shadow-shell)');
    expect(css).toContain('transform var(--bs-motion-hover) var(--bs-ease-out)');
  });

  it('a pressable tile keeps its lift transition', () => {
    const both = rule(css, '.bs-pressable.bs-liftable,\n.bs-pressable.bs-card-liftable');
    expect(both).toContain('transform var(--bs-motion-hover)');
  });

  it('Brand Brain cards and post cards lift the §8 way', () => {
    const bb = readFileSync('packages/ui/src/brand-brain.css', 'utf8');
    expect(rule(bb, '.bb-card:hover')).toContain('translateY(-2px)');
    expect(rule(bb, '.bb-card')).toContain('var(--bs-motion-hover)');
    expect(
      readFileSync('apps/dashboard/src/app/[locale]/content/content-library.tsx', 'utf8'),
    ).toContain('className="bs-card-liftable"');
  });
});

describe('MO13 — loading', () => {
  it('reading pulses 1 → .55 over 1.6 s; generating shimmers on a 1.6 s linear loop', () => {
    const pulse = css.slice(css.indexOf('@keyframes bs-pulse'), css.indexOf('.bs-pulse {'));
    expect(pulse).toContain('opacity: 0.55;');
    expect(rule(css, '.bs-pulse')).toContain('var(--bs-motion-loop)');
    expect(rule(css, '.bs-shimmer')).toContain('var(--bs-motion-loop) linear infinite');
    expect(readFileSync('packages/ui/src/feedback.tsx', 'utf8')).toContain(
      'className="bs-shimmer"',
    );
  });
});
