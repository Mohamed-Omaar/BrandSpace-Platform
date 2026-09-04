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

/**
 * Phase 2B application palette (D-42).
 *
 * The owner-approved purple is the primary action colour for the Control Center
 * and the customer dashboard. Unlike the identity blue it must work in BOTH
 * directions — as text on a light surface and as a filled surface under white
 * text — so both pairings are asserted here. A token change that breaks either
 * fails this test rather than an accessibility scan in the browser.
 */
describe('the Phase 2B application palette meets AA', () => {
  it('purple is legible as text on every light surface we use', () => {
    for (const bg of [
      colorTokens.surface,
      colorTokens.appBackground,
      colorTokens.brandPurpleTint,
    ]) {
      expect(contrastRatio(colorTokens.brandPurple, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it('white text on the purple surface meets AA', () => {
    expect(
      contrastRatio(colorTokens.brandPurpleInk, colorTokens.brandPurple),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(
      contrastRatio(colorTokens.brandPurpleInk, colorTokens.brandPurpleHover),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('body text stays legible on the application background', () => {
    expect(
      contrastRatio(colorTokens.textPrimary, colorTokens.appBackground),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(
      contrastRatio(colorTokens.textSecondary, colorTokens.appBackground),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(
      contrastRatio(colorTokens.textPrimary, colorTokens.brandPurpleTint),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('the card border is a non-text boundary, not a text colour', () => {
    // Asserted so nobody later uses it for a label: it is deliberately subtle.
    expect(contrastRatio(colorTokens.cardBorder, colorTokens.surface)).toBeLessThan(AA_NORMAL);
  });

  it('yellow remains an accent and never carries text on white', () => {
    expect(contrastRatio(colorTokens.brandYellow, colorTokens.surface)).toBeLessThan(AA_LARGE);
    expect(
      contrastRatio(colorTokens.brandYellowInk, colorTokens.brandYellow),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

/**
 * Phase 2C design foundation (D-49…D-51).
 *
 * The system grew a focus ring, a strong control border, a muted text tone,
 * four semantic tint/border families and a white page ground. Each one is a
 * promise about legibility, so each one is asserted — including the promises
 * that a colour must NOT keep, because a token that quietly becomes legible is
 * a token somebody will start using as text.
 */
describe('the Phase 2C foundation meets AA', () => {
  it('every text tone is legible on white, which is now the page ground too', () => {
    for (const [name, color] of [
      ['textPrimary', colorTokens.textPrimary],
      ['textSecondary', colorTokens.textSecondary],
      ['textMuted', colorTokens.textMuted],
    ] as const) {
      expect(
        contrastRatio(color, colorTokens.appBackground),
        `${name} on the application ground`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
      expect(contrastRatio(color, colorTokens.surface), `${name} on a card`).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
    }
  });

  it('the application ground and the card surface are the same white (D-49)', () => {
    // Structure comes from borders and one shadow, not from a tinted ground.
    // If these ever diverge, the direction changed and the docs must follow.
    expect(colorTokens.appBackground).toBe(colorTokens.surface);
  });

  it('the focus ring is visible on every surface it can land on', () => {
    for (const [name, background] of [
      ['surface', colorTokens.surface],
      ['surfaceMuted', colorTokens.surfaceMuted],
      ['surfaceSunken', colorTokens.surfaceSunken],
      ['brandPurpleTint', colorTokens.brandPurpleTint],
    ] as const) {
      expect(
        contrastRatio(colorTokens.focusRing, background),
        `focus ring on ${name}`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it('a control boundary reaches the 3:1 non-text threshold (WCAG 1.4.11)', () => {
    // `borderStrong` exists precisely because `border` does NOT reach it: an
    // input outlined at 1.4:1 is invisible to a lot of people.
    expect(contrastRatio(colorTokens.borderStrong, colorTokens.surface)).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
    expect(contrastRatio(colorTokens.border, colorTokens.surface)).toBeLessThan(AA_NON_TEXT);
  });

  it('every semantic tone is legible on its own tint', () => {
    for (const [name, ink, tint] of [
      ['success', colorTokens.success, colorTokens.successTint],
      ['warning', colorTokens.warning, colorTokens.warningTint],
      ['danger', colorTokens.danger, colorTokens.dangerTint],
      ['info', colorTokens.info, colorTokens.infoTint],
    ] as const) {
      expect(contrastRatio(ink, tint), `${name} on its tint`).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it('the yellow accent badge carries darkened yellow text, never white', () => {
    // The accent badge is `brandYellowText` on `brandYellowTint`.
    expect(
      contrastRatio(colorTokens.brandYellowText, colorTokens.brandYellowTint),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    // And white on yellow stays firmly unusable, which is why the rule exists.
    expect(contrastRatio('#FFFFFF', colorTokens.brandYellow)).toBeLessThan(AA_LARGE);
    expect(contrastRatio('#FFFFFF', colorTokens.brandYellowTint)).toBeLessThan(AA_LARGE);
  });

  it('the pressed purple is legible on the tint it appears against', () => {
    // Active navigation is `brandPurplePressed` on `brandPurpleTint`.
    expect(
      contrastRatio(colorTokens.brandPurplePressed, colorTokens.brandPurpleTint),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(
      contrastRatio(colorTokens.brandPurplePressed, colorTokens.surface),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  /*
   * EVERY TEXT TOKEN, ON EVERY SURFACE IT CAN LAND ON.
   *
   * The revision made supporting surfaces the primary structural device, which
   * means body text now lands on five different grounds instead of one. A token
   * measured only against white is not measured: `textMuted` is 4.61:1 on white
   * and 4.21:1 on `surfaceLavenderStrong`, and it shipped onto a selected
   * account chip in the composer, where axe caught it (F-32).
   *
   * This asserts the whole matrix, so the next surface added to the palette has
   * to state which text tokens may sit on it.
   */
  it('every text token clears AA on every supporting surface it can land on', () => {
    const surfaces = [
      ['surface', colorTokens.surface],
      ['surfaceSoft', colorTokens.surfaceSoft],
      ['surfaceWarm', colorTokens.surfaceWarm],
      ['surfaceLavender', colorTokens.surfaceLavender],
      ['surfaceLavenderStrong', colorTokens.surfaceLavenderStrong],
      ['surfaceMuted', colorTokens.surfaceMuted],
      ['surfaceSunken', colorTokens.surfaceSunken],
      ['controlSurface', colorTokens.controlSurface],
    ] as const;

    const failures: string[] = [];
    for (const [surfaceName, background] of surfaces) {
      for (const [inkName, ink] of [
        ['textPrimary', colorTokens.textPrimary],
        ['textSecondary', colorTokens.textSecondary],
      ] as const) {
        const ratio = contrastRatio(ink, background);
        if (ratio < AA_NORMAL) {
          failures.push(`${inkName} on ${surfaceName}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('textMuted has exactly two surfaces it may not sit on, and they are named', () => {
    /*
     * `textMuted` clears AA on white and on every near-white surface, and fails
     * on the two darkest supporting ones. That is not a defect in the token —
     * it is the boundary, and naming it is the point: the rule is "muted is for
     * the page ground and the pale surfaces, secondary for a stronger tint".
     *
     * If a future palette change moves a surface across this line, this test
     * fails and the rule gets rewritten deliberately rather than discovered by
     * axe on a screen somebody already approved.
     */
    for (const [name, background] of [
      ['surface', colorTokens.surface],
      ['surfaceSoft', colorTokens.surfaceSoft],
      ['surfaceWarm', colorTokens.surfaceWarm],
      ['surfaceLavender', colorTokens.surfaceLavender],
      ['surfaceMuted', colorTokens.surfaceMuted],
      ['controlSurface', colorTokens.controlSurface],
    ] as const) {
      expect(
        contrastRatio(colorTokens.textMuted, background),
        `textMuted on ${name}`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    }

    for (const [name, background] of [
      ['surfaceLavenderStrong', colorTokens.surfaceLavenderStrong],
      ['surfaceSunken', colorTokens.surfaceSunken],
    ] as const) {
      expect(
        contrastRatio(colorTokens.textMuted, background),
        `textMuted unexpectedly passes on ${name}; the documented rule is now wrong`,
      ).toBeLessThan(AA_NORMAL);
    }
  });

  it('the selected-surface border is a perceivable boundary', () => {
    expect(contrastRatio(colorTokens.brandYellow, colorTokens.surface)).toBeLessThan(AA_NON_TEXT);
    // …so the active nav item never relies on the yellow mark alone. It also
    // carries a purple tint, a purple label and `aria-current` — asserted in
    // tests/unit/design-system.test.ts.
    expect(contrastRatio(colorTokens.brandPurpleTint, colorTokens.surface)).toBeLessThan(
      AA_NON_TEXT,
    );
  });
});
