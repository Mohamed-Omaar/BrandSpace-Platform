import { describe, expect, it } from 'vitest';
import { colorTokens } from '@brandspace/ui';

/**
 * WCAG contrast assertions for every documented token pairing.
 *
 * CLAUDE.md §4 targets WCAG 2.2 AA. Both brand colours are vivid identity
 * colours that FAIL as text on white — blue 2.56:1, yellow 1.35:1 — which is why
 * each has an explicit text variant and a surface/ink pair.
 *
 * This was not theoretical: the accessibility E2E suite caught `#00ADEE` used as
 * an h1 colour, and the original `brandBlueInk` (white) on `brandBlue` scored
 * 2.56:1, so the documented button pairing was unusable. Asserting the ratios
 * here means a future token change fails a fast unit test rather than surfacing
 * as a browser failure — or, worse, shipping.
 */

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const AA_NORMAL = 4.5;
const AA_LARGE = 3;
const AA_NON_TEXT = 3;

describe('the contrast helper is correct', () => {
  it('computes the known extremes', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });
});

describe('text on the light surface meets AA', () => {
  it.each([
    ['textPrimary', colorTokens.textPrimary],
    ['textSecondary', colorTokens.textSecondary],
    ['brandBlueText', colorTokens.brandBlueText],
    ['brandYellowText', colorTokens.brandYellowText],
    ['danger', colorTokens.danger],
    ['warning', colorTokens.warning],
    ['success', colorTokens.success],
  ])('%s reaches 4.5:1 on the surface', (_name, color) => {
    expect(contrastRatio(color, colorTokens.surface)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('brandBlueText also works on the muted surface', () => {
    expect(
      contrastRatio(colorTokens.brandBlueText, colorTokens.surfaceMuted),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe('filled controls meet AA', () => {
  it('brandBlueInk on brandBlueSurface reaches 4.5:1', () => {
    // The original token set paired white with #00ADEE at 2.56:1 — a button
    // nobody with low vision could read.
    expect(
      contrastRatio(colorTokens.brandBlueInk, colorTokens.brandBlueSurface),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('brandYellowInk on brandYellow reaches 4.5:1', () => {
    expect(
      contrastRatio(colorTokens.brandYellowInk, colorTokens.brandYellow),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe('identity colours are documented as unsafe for text', () => {
  it('brandBlue genuinely fails as text, which is why brandBlueText exists', () => {
    // If this ever passes, the brand colour changed and the guidance in
    // tokens.ts should be revisited rather than silently left stale.
    expect(contrastRatio(colorTokens.brandBlue, colorTokens.surface)).toBeLessThan(AA_LARGE);
  });

  it('brandYellow genuinely fails as text, which is why brandYellowText exists', () => {
    expect(contrastRatio(colorTokens.brandYellow, colorTokens.surface)).toBeLessThan(AA_LARGE);
  });
});

describe('non-text UI meets the 3:1 threshold', () => {
  it('the border is distinguishable against both surfaces', () => {
    // Borders and focus rings are "non-text contrast" under WCAG 2.2 (1.4.11).
    expect(contrastRatio(colorTokens.textSecondary, colorTokens.surface)).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
  });

  it('the focus ring colour is visible against the surface', () => {
    expect(contrastRatio(colorTokens.brandBlueText, colorTokens.surface)).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
  });
});
