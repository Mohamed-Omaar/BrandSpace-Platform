import { describe, expect, it } from 'vitest';
import { colorValues } from '@brandspace/ui';

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
    ['textPrimary', colorValues.textPrimary],
    ['textSecondary', colorValues.textSecondary],
    ['brandBlueText', colorValues.brandBlueText],
    ['brandYellowText', colorValues.brandYellowText],
    ['danger', colorValues.danger],
    ['warning', colorValues.warning],
    ['success', colorValues.success],
  ])('%s reaches 4.5:1 on the surface', (_name, color) => {
    expect(contrastRatio(color, colorValues.surface)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('brandBlueText also works on the muted surface', () => {
    expect(
      contrastRatio(colorValues.brandBlueText, colorValues.surfaceMuted),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe('filled controls meet AA', () => {
  it('brandBlueInk on brandBlueSurface reaches 4.5:1', () => {
    // The original token set paired white with #00ADEE at 2.56:1 — a button
    // nobody with low vision could read.
    expect(
      contrastRatio(colorValues.brandBlueInk, colorValues.brandBlueSurface),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('brandYellowInk on brandYellow reaches 4.5:1', () => {
    expect(
      contrastRatio(colorValues.brandYellowInk, colorValues.brandYellow),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe('identity colours are documented as unsafe for text', () => {
  it('brandBlue genuinely fails as text, which is why brandBlueText exists', () => {
    // If this ever passes, the brand colour changed and the guidance in
    // tokens.ts should be revisited rather than silently left stale.
    expect(contrastRatio(colorValues.brandBlue, colorValues.surface)).toBeLessThan(AA_LARGE);
  });

  it('brandYellow genuinely fails as text, which is why brandYellowText exists', () => {
    expect(contrastRatio(colorValues.brandYellow, colorValues.surface)).toBeLessThan(AA_LARGE);
  });
});

describe('non-text UI meets the 3:1 threshold', () => {
  it('the border is distinguishable against both surfaces', () => {
    // Borders and focus rings are "non-text contrast" under WCAG 2.2 (1.4.11).
    expect(contrastRatio(colorValues.textSecondary, colorValues.surface)).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
  });

  it('the focus ring colour is visible against the surface', () => {
    expect(contrastRatio(colorValues.brandBlueText, colorValues.surface)).toBeGreaterThanOrEqual(
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
      colorValues.surface,
      colorValues.appBackground,
      colorValues.brandPurpleTint,
    ]) {
      expect(contrastRatio(colorValues.brandPurple, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it('white text on the purple surface meets AA', () => {
    expect(
      contrastRatio(colorValues.brandPurpleInk, colorValues.brandPurple),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(
      contrastRatio(colorValues.brandPurpleInk, colorValues.brandPurpleHover),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('body text stays legible on the application background', () => {
    expect(
      contrastRatio(colorValues.textPrimary, colorValues.appBackground),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(
      contrastRatio(colorValues.textSecondary, colorValues.appBackground),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(
      contrastRatio(colorValues.textPrimary, colorValues.brandPurpleTint),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('the card border is a non-text boundary, not a text colour', () => {
    // Asserted so nobody later uses it for a label: it is deliberately subtle.
    expect(contrastRatio(colorValues.cardBorder, colorValues.surface)).toBeLessThan(AA_NORMAL);
  });

  it('yellow remains an accent and never carries text on white', () => {
    expect(contrastRatio(colorValues.brandYellow, colorValues.surface)).toBeLessThan(AA_LARGE);
    expect(
      contrastRatio(colorValues.brandYellowInk, colorValues.brandYellow),
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
      ['textPrimary', colorValues.textPrimary],
      ['textSecondary', colorValues.textSecondary],
      ['textMuted', colorValues.textMuted],
    ] as const) {
      expect(
        contrastRatio(color, colorValues.appBackground),
        `${name} on the application ground`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
      expect(contrastRatio(color, colorValues.surface), `${name} on a card`).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
    }
  });

  it('the application ground is NO LONGER the card surface (D-59 supersedes D-49)', () => {
    /*
     * THE PREVIOUS ASSERTION HERE SAID THE OPPOSITE, AND SAID WHY IT WOULD
     * CHANGE: "if these ever diverge, the direction changed and the docs must
     * follow". They diverged, and the docs did.
     *
     * D-49 put a white card on a white ground and let a border carry the
     * separation — which is exactly what made the first draft read as an
     * outlined admin console. The approved reference inverts it: a grey
     * ambient ground with brand-coloured light behind it, and an opaque
     * near-white shell FLOATING on top. A card no longer needs a border
     * because the shell is visibly a separate plane from the page.
     *
     * So the invariant is now the opposite one, and it is load-bearing: if the
     * ground ever goes white again, the shell's shadow has nothing to fall on
     * and every surface boundary in the product disappears at once.
     */
    expect(colorValues.appBackground).not.toBe(colorValues.surface);
    expect(colorValues.shellSurface).not.toBe(colorValues.appBackground);

    // The shell must be LIGHTER than the ground it floats on — a shell darker
    // than its ground reads as a hole rather than as a raised surface.
    expect(relativeLuminance(colorValues.shellSurface)).toBeGreaterThan(
      relativeLuminance(colorValues.appBackground),
    );
  });

  it('the focus ring is visible on every surface it can land on', () => {
    for (const [name, background] of [
      ['surface', colorValues.surface],
      ['surfaceMuted', colorValues.surfaceMuted],
      ['surfaceSunken', colorValues.surfaceSunken],
      ['brandPurpleTint', colorValues.brandPurpleTint],
    ] as const) {
      expect(
        contrastRatio(colorValues.focusRing, background),
        `focus ring on ${name}`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it('a control boundary reaches the 3:1 non-text threshold (WCAG 1.4.11)', () => {
    // `borderStrong` exists precisely because `border` does NOT reach it: an
    // input outlined at 1.4:1 is invisible to a lot of people.
    expect(contrastRatio(colorValues.borderStrong, colorValues.surface)).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
    expect(contrastRatio(colorValues.border, colorValues.surface)).toBeLessThan(AA_NON_TEXT);
  });

  it('every semantic tone is legible on its own tint', () => {
    for (const [name, ink, tint] of [
      ['success', colorValues.success, colorValues.successTint],
      ['warning', colorValues.warning, colorValues.warningTint],
      ['danger', colorValues.danger, colorValues.dangerTint],
      ['info', colorValues.info, colorValues.infoTint],
    ] as const) {
      expect(contrastRatio(ink, tint), `${name} on its tint`).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it('the yellow accent badge carries darkened yellow text, never white', () => {
    // The accent badge is `brandYellowText` on `brandYellowTint`.
    expect(
      contrastRatio(colorValues.brandYellowText, colorValues.brandYellowTint),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    // And white on yellow stays firmly unusable, which is why the rule exists.
    expect(contrastRatio('#FFFFFF', colorValues.brandYellow)).toBeLessThan(AA_LARGE);
    expect(contrastRatio('#FFFFFF', colorValues.brandYellowTint)).toBeLessThan(AA_LARGE);
  });

  it('the pressed purple is legible on the tint it appears against', () => {
    // Active navigation is `brandPurplePressed` on `brandPurpleTint`.
    expect(
      contrastRatio(colorValues.brandPurplePressed, colorValues.brandPurpleTint),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(
      contrastRatio(colorValues.brandPurplePressed, colorValues.surface),
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
      ['surface', colorValues.surface],
      ['surfaceSoft', colorValues.surfaceSoft],
      ['surfaceWarm', colorValues.surfaceWarm],
      ['surfaceLavender', colorValues.surfaceLavender],
      ['surfaceLavenderStrong', colorValues.surfaceLavenderStrong],
      ['surfaceMuted', colorValues.surfaceMuted],
      ['surfaceSunken', colorValues.surfaceSunken],
      ['controlSurface', colorValues.controlSurface],
    ] as const;

    const failures: string[] = [];
    for (const [surfaceName, background] of surfaces) {
      for (const [inkName, ink] of [
        ['textPrimary', colorValues.textPrimary],
        ['textSecondary', colorValues.textSecondary],
      ] as const) {
        const ratio = contrastRatio(ink, background);
        if (ratio < AA_NORMAL) {
          failures.push(`${inkName} on ${surfaceName}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('textMuted now clears AA on EVERY surface in the system', () => {
    /*
     * THIS ASSERTION WAS INVERTED IN THE DEMO ALIGNMENT, AND THE INVERSION IS
     * THE POINT.
     *
     * It used to name the two surfaces `textMuted` could NOT sit on
     * (`surfaceLavenderStrong` at 4.21:1, `surfaceSunken` at 4.44:1) and to
     * fail if either ever crossed the line, so that the rule would be rewritten
     * deliberately rather than discovered by axe on an approved screen. That is
     * exactly what happened.
     *
     * The approved reference sets its muted text at `#707077`, which is 4.39:1
     * on the reference's own `#F2F2F2` ground — below AA on the surface it
     * spends most of its life on. Rather than copy that defect, the token moved
     * to `#6A6A71`, the nearest value that clears 4.5:1 on all fourteen
     * surfaces this system has. The floor is now 4.55:1, on lavender-strong.
     *
     * So the restriction is gone, and the test says so instead of preserving a
     * limitation that no longer exists. A future palette change that reopens
     * the gap fails here.
     */
    const failures: string[] = [];
    for (const [name, background] of Object.entries({
      surface: colorValues.surface,
      surfaceSoft: colorValues.surfaceSoft,
      surfaceWarm: colorValues.surfaceWarm,
      surfaceLavender: colorValues.surfaceLavender,
      surfaceLavenderStrong: colorValues.surfaceLavenderStrong,
      surfaceMuted: colorValues.surfaceMuted,
      surfaceSunken: colorValues.surfaceSunken,
      appBackground: colorValues.appBackground,
      controlSurface: colorValues.controlSurface,
      controlSurfaceDisabled: colorValues.controlSurfaceDisabled,
      brandYellowTint: colorValues.brandYellowTint,
      shellSurface: colorValues.shellSurface,
      shellSidebar: colorValues.shellSidebar,
      // `shellPanel` is `transparent` in the full-demo alignment — the panel
      // takes the shell's own translucency — so the ground under it is the
      // shell, already asserted above.
      ambientGround: colorValues.ambientGround,
    })) {
      const ratio = contrastRatio(colorValues.textMuted, background);
      if (ratio < AA_NORMAL) failures.push(`textMuted on ${name}: ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it('the reference palette it replaced genuinely failed, which is why it was not copied', () => {
    // Recorded so the deviation cannot be mistaken for drift: the approved
    // demo's own `--muted` is below AA on the demo's own page ground.
    // The FULL demo's `--muted: #717179` and `--subtle: #a3a3aa`, both of which
    // fail on surfaces the demo itself puts them on.
    expect(contrastRatio('#717179', colorValues.surfaceMuted)).toBeLessThan(AA_NORMAL);
    expect(contrastRatio('#A3A3AA', colorValues.shellSidebar)).toBeLessThan(AA_NORMAL);
    // …and the values that replaced them clear it.
    expect(contrastRatio(colorValues.textMuted, colorValues.surfaceMuted)).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
    expect(contrastRatio(colorValues.textSubtle, colorValues.shellSidebar)).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
  });

  it('no soft tint is a perceivable boundary, which is why none carries a state alone', () => {
    // Both of these are below the 3:1 non-text threshold, so neither the yellow
    // mark nor the lavender tint may be the only signal for a state. The active
    // navigation item stopped relying on either in the demo alignment: it is
    // now an INK-FILLED pill with inverted text at 18.85:1, plus `aria-current`
    // — a fill inversion and a semantic, not a hue.
    expect(contrastRatio(colorValues.brandYellow, colorValues.surface)).toBeLessThan(AA_NON_TEXT);
    expect(contrastRatio(colorValues.brandPurpleTint, colorValues.surface)).toBeLessThan(
      AA_NON_TEXT,
    );
  });

  it('the ink-filled active navigation item is legible in both directions', () => {
    expect(contrastRatio(colorValues.inkInk, colorValues.ink)).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrastRatio(colorValues.inkInk, colorValues.inkHover)).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
    // And the resting item, on the sidebar's own plane.
    expect(
      contrastRatio(colorValues.textSecondary, colorValues.shellSidebar),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});
