import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatCredits } from '../../apps/dashboard/src/server/composer-editor';

/*
 * F-109 (D-14) — the credit DISPLAY rounding rule (docs/BILLING-AND-CREDITS.md
 * §13.1): WHOLE credits, rounded away from zero. It replaces Round 4's one
 * decimal. Presentation only — the milli figure itself is never rounded.
 */
describe('formatCredits — whole credits, rounded up', () => {
  it.each([
    ['0', '0'],
    ['1', '1'],
    ['100', '1'],
    ['101', '1'],
    ['369', '1'],
    ['999', '1'],
    ['1000', '1'],
    ['1001', '2'],
    ['1050', '2'],
    ['1100', '2'],
    ['2000', '2'],
    ['12345', '13'],
    ['250000', '250'],
  ])('%s milli reads %s', (milli, shown) => {
    expect(formatCredits(milli)).toBe(shown);
  });

  it('keeps the sign and rounds a negative amount away from zero', () => {
    expect(formatCredits('-369')).toBe('-1');
    expect(formatCredits('-2000')).toBe('-2');
  });

  it('always shows a whole number', () => {
    for (let milli = 0; milli <= 3_000; milli += 7) {
      expect(formatCredits(String(milli))).toMatch(/^\d+$/);
    }
  });

  it('never shows a cost below what it is', () => {
    for (let milli = 0; milli <= 3_000; milli += 7) {
      expect(Number(formatCredits(String(milli))) * 1_000).toBeGreaterThanOrEqual(milli);
    }
  });

  it('shows a whole-credit charge exactly', () => {
    for (const credits of [1, 2, 12, 60]) {
      expect(formatCredits(String(credits * 1_000))).toBe(String(credits));
    }
  });

  it('is exact past the float range — the figure never goes through a number', () => {
    expect(formatCredits('90071992547409930001')).toBe('90071992547409931');
  });

  it('reads a malformed figure as zero rather than throwing', () => {
    expect(formatCredits('abc')).toBe('0');
  });

  it('is the one formatter the Studio, Media and Copilot cost quotes use', () => {
    const root = path.resolve(__dirname, '../../apps/dashboard/src/app/[locale]');
    const creative = readFileSync(path.join(root, 'creative/creative-studio-view.tsx'), 'utf8');
    const copilot = readFileSync(path.join(root, 'copilot/copilot-view.tsx'), 'utf8');
    expect(creative).toContain("from '../../../server/composer-editor'");
    expect(copilot).toContain("import { formatCredits } from '../../../server/composer-editor'");
    expect(copilot).not.toMatch(/costMilli \/ 1_000/);
  });
});
