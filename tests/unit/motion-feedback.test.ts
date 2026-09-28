import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { easeOutCubic, formatCount, parseCount } from '../../packages/ui/src/count-up-format';

/**
 * §8 MO8, MO11, MO12 (Phase 2B-2b, D-351) — the toast's motion, charts on
 * entry and the KPI count-up. The browser half is
 * `tests/e2e/prototype-v90-phase2b2b-shell.spec.ts`.
 */

const read = (file: string) => readFileSync(file, 'utf8');
const css = read('packages/ui/src/tokens.css');

describe('MO12 — a KPI counts up in its own format and ends on the exact value', () => {
  it.each([
    '1,234',
    '12.5%',
    '4.7%',
    'SAR 1,200',
    '3 GB',
    '0.5',
    '1 234',
    '9 999 999',
    '+18%',
    '42',
  ])('%s: the last frame is the server’s text exactly', (text) => {
    const format = parseCount(text);
    expect(format, text).not.toBeNull();
    expect(formatCount(format!, format!.target)).toBe(text);
  });

  it('keeps decimals, prefix, suffix and grouping on the way up', () => {
    const money = parseCount('SAR 1,200')!;
    expect(formatCount(money, 0)).toBe('SAR 0');
    expect(formatCount(money, 600)).toBe('SAR 600');
    expect(formatCount(money, 1000)).toBe('SAR 1,000');
    const rate = parseCount('12.5%')!;
    expect(formatCount(rate, 0)).toBe('0.0%');
    expect(formatCount(rate, 6.25)).toBe('6.3%');
  });

  it('does not count text without a number, zero, or a zero-padded label ("01")', () => {
    for (const text of ['—', 'DEVELOPMENT', '0', '0%', '01', '007']) {
      expect(parseCount(text), text).toBeNull();
    }
  });

  it('eases out cubically, from 0 to exactly 1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
  });

  it('the text itself never changes; the counting copy is drawn over it, 650 ms', () => {
    const component = read('packages/ui/src/count-up.tsx');
    expect(component).toContain('<span className="bs-count-final">{value}</span>');
    expect(component).toContain('motionMs.count');
    expect(component).toContain('prefersReducedMotion()');
    expect(css).toContain('content: attr(data-display);');
    expect(read('packages/ui/src/surfaces.tsx')).toContain(
      "typeof value === 'string' ? <CountUp value={value} /> : value",
    );
  });
});

describe('MO11 — charts on page entry', () => {
  it('bars grow from their start edge, 800 ms, 35 ms apart, up to the 14th', () => {
    expect(css).toMatch(/@keyframes bs-bar-grow \{\s*from \{\s*scale: 0 1;/);
    expect(css).toContain(
      'animation-delay: calc(min(var(--i, 0), 13) * var(--bs-motion-bar-step));',
    );
    expect(css).toContain(".bs-chart-bar[data-dir='rtl'] {\n  transform-origin: right center;");
  });

  it('a line draws from the reading start over 1000 ms; dots and labels pop after it', () => {
    expect(css).toMatch(/@keyframes bs-line-draw \{\s*from \{\s*clip-path: inset\(0 100% 0 0\);/);
    expect(css).toMatch(
      /@keyframes bs-line-draw-rtl \{\s*from \{\s*clip-path: inset\(0 0 0 100%\);/,
    );
    expect(css).toContain(
      'animation-delay: calc(var(--bs-motion-line) + var(--i, 0) * var(--bs-motion-dot-step));',
    );
    const charts = read('packages/ui/src/charts.tsx');
    expect(charts).toContain('<g className="bs-chart-line" data-dir={direction}>');
    expect(charts.match(/className="bs-chart-dot"/g)).toHaveLength(2);
    expect(charts).toContain('className="bs-chart-bar"');
  });
});

describe('MO8 — the toast', () => {
  it('enters from 12 px below; contents unblur 6 px, 420 ms, 50 ms apart; the check draws 160 ms late', () => {
    expect(css).toMatch(/@keyframes bs-toast-in \{\s*from \{\s*opacity: 0;\s*translate: 0 12px;/);
    expect(css).toMatch(/@keyframes bs-toast-part-in \{\s*from \{\s*filter: blur\(6px\);/);
    expect(css).toContain('animation-delay: calc(var(--bs-motion-toast-step) * 1);');
    expect(css).toMatch(
      /stroke-dasharray: 24;\s*animation: bs-check-draw var\(--bs-motion-toast-in\) var\(--bs-ease-out\)\s+var\(--bs-motion-toast-check-delay\) both;/,
    );
    expect(read('packages/ui/src/feedback.tsx')).toContain(
      "{...(tone === 'success' ? { 'data-toast-check': '' } : {})}",
    );
  });

  it('leaves by rising 14 px while its contents blur to 6 px, 280 ms', () => {
    const host = read('packages/ui/src/toast-host.tsx');
    expect(host).toContain("{ opacity: 0, translate: '0 -14px' }");
    expect(host).toContain("[{ filter: 'blur(0)' }, { filter: 'blur(6px)' }]");
    expect(host).toContain('duration: motionMs.toastOut');
    expect(host).toContain('usePresence(current !== null, toastRef, toastExit)');
  });
});
