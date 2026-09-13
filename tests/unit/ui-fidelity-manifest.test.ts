import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { brandBrainTokens } from '@brandspace/ui';

/**
 * The pinned UI authority cannot drift silently.
 *
 * `docs/UI-FIDELITY-CONTRACT.md` names an upstream commit and a SHA-256 for every
 * file the Brand Brain route is ported from. This asserts the vendored snapshot
 * still matches those values — so a future session cannot edit the reference to
 * agree with an implementation, and cannot quietly refresh it to a newer upstream
 * without the manifest changing in the same commit.
 *
 * The checksums are duplicated here ON PURPOSE. A test that read them out of the
 * document it is checking would pass for any pair of values that happened to
 * agree, which is exactly the failure mode this exists to prevent.
 */

const ROOT = path.resolve(__dirname, '../..');
const SNAPSHOT = path.join(ROOT, 'docs/visual-reference/brand-brain-native');

/** Landing repository commit the Brand Brain route is pinned to. */
const PINNED_COMMIT = 'b01d94738672c64f651098512c03faf4554ebb97';

const PINNED: ReadonlyArray<readonly [string, string]> = [
  ['brand-brain-native.css', 'e5b8ca5308a6bc84db4789e6424328fe7ea85086e310abbab6aa124820081034'],
  ['brand-brain-native.js', 'dc91db029fb8388aece3b47cdb00de05b654002f2c1df8efd458803722591085'],
  ['brand-brain-nav.js', '9dd56cfb137633dabf89e8b62c530de8551530dc49775c40eb56d81ec4d80e91'],
  ['demo.index.html', '0bae6b9e58c203bff107f3eb23c1b92e716e25000867ca5d232a7d68f327b893'],
];

function sha256(file: string): string {
  return createHash('sha256')
    .update(readFileSync(path.join(SNAPSHOT, file)))
    .digest('hex');
}

describe('the vendored Brand Brain reference', () => {
  it.each(PINNED)('%s still matches its pinned checksum', (file, expected) => {
    expect(sha256(file)).toBe(expected);
  });

  it('the contract document names the same commit and checksums', () => {
    // The document is what a human reads; this keeps it honest against the
    // constants above rather than the other way round.
    const contract = readFileSync(path.join(ROOT, 'docs/UI-FIDELITY-CONTRACT.md'), 'utf8');
    expect(contract).toContain(PINNED_COMMIT);
    for (const [file, checksum] of PINNED) {
      expect(contract, `${file} checksum missing from the manifest`).toContain(checksum);
    }
  });

  it('the live demo loads the files the manifest calls authoritative', () => {
    /*
     * The reason `brand-brain-native.*` is the authority and the standalone
     * `brand-brain/index.html` prototype is not: the host page loads one and not
     * the other. Asserted against the vendored host page so the claim stays true
     * rather than remaining a sentence somebody wrote once.
     */
    const host = readFileSync(path.join(SNAPSHOT, 'demo.index.html'), 'utf8');
    expect(host).toContain('brand-brain-native.css');
    expect(host).toContain('brand-brain-native.js');
  });

  it('every route in the manifest declares a source file and a pinned commit', () => {
    const contract = readFileSync(path.join(ROOT, 'docs/UI-FIDELITY-CONTRACT.md'), 'utf8');
    const manifest = contract.slice(contract.indexOf('## 3. Route-to-reference manifest'));
    const rows = manifest
      .split('\n')
      .filter((line) => line.startsWith('| `/') && line.includes('|'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Route, source, repo, commit, checksum — a row missing either of the last
      // two is a route that cannot be verified.
      expect(row, `manifest row has no pinned commit: ${row}`).toContain(PINNED_COMMIT);
      expect(row, `manifest row has no checksum: ${row}`).toMatch(/[0-9a-f]{64}/);
    }
  });
});

/**
 * The port is checked against the snapshot MECHANICALLY, declaration by
 * declaration.
 *
 * This is the test that would have caught Phase 5A. The previous orb passed
 * typecheck, lint, axe, 273 Playwright assertions and a design-system audit
 * while being a different design: a lavender container, a black rounded square,
 * the customer's brand name in the centre and white cards where the demo draws
 * 12px dots. Nothing in the suite compared it to the thing it was a port of.
 *
 * So: for each selector the orb depends on, every `property: value` pair in the
 * snapshot must appear in the transcription. A dropped declaration fails, and a
 * changed value fails — including the ones a reviewer's eye slides over, like a
 * stage background that stopped being `transparent`.
 */
describe('the Brand Brain stylesheet is a transcription of the snapshot', () => {
  const snapshot = readFileSync(path.join(SNAPSHOT, 'brand-brain-native.css'), 'utf8');
  const ported = readFileSync(path.join(ROOT, 'packages/ui/src/brand-brain.css'), 'utf8');

  /**
   * Normalise a declaration so that only MEANING is compared.
   *
   * The snapshot is minified and the port is Prettier-formatted, so the two
   * disagree about whitespace and about whether a decimal carries its leading
   * zero (`.82` against `0.82`). Neither changes a pixel. Everything else does,
   * and is compared literally.
   */
  function normalise(text: string): string {
    return text
      .toLowerCase()
      .replace(/(^|[^0-9])\.(?=[0-9])/g, '$10.')
      .replace(/\s+/g, '');
  }

  /**
   * The demo's physical directions, and the logical property each becomes.
   *
   * THIS IS THE ONE CLASS OF SUBSTITUTION THE CONTRACT ALLOWS (rule 4 and
   * CLAUDE.md §4): the demo is an English-only prototype and `text-align: left`
   * or `margin-right` renders Arabic backwards. The logical property produces an
   * IDENTICAL result in LTR, so nothing about the approved design changes — and
   * the mapping is written down here so a genuine drift cannot hide behind it.
   */
  const LOGICAL: ReadonlyArray<readonly [string, string]> = [
    ['text-align:left', 'text-align:start'],
    ['text-align:right', 'text-align:end'],
    ['margin-left', 'margin-inline-start'],
    ['margin-right', 'margin-inline-end'],
  ];

  function declarations(css: string, selector: string): string[] {
    const index = css.indexOf(`${selector}{`);
    if (index < 0) throw new Error(`selector "${selector}" is not in the snapshot`);
    const body = css.slice(index + selector.length + 1, css.indexOf('}', index));
    return body
      .split(';')
      .map((part) => normalise(part))
      .filter((part) => part.length > 0)
      .map((part) => {
        const mapped = LOGICAL.find(([physical]) => part.startsWith(physical));
        return mapped ? part.replace(mapped[0], mapped[1]) : part;
      });
  }

  /** The port's own block for a selector, from the transcription in §1. */
  function portedDeclarations(selector: string): string[] {
    const pattern = new RegExp(`(^|\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`);
    const match = pattern.exec(ported);
    if (!match) throw new Error(`selector "${selector}" is not in the port`);
    return (match[2] ?? '')
      .split(';')
      .map((part) => normalise(part))
      .filter((part) => part.length > 0);
  }

  /*
   * The declarations that decide what the orb looks like. `.bb-orb-stage` and
   * `.bb-orb-center` are here because they are precisely where the previous
   * version went wrong; the rest are the geometry the port is worthless without.
   */
  const SELECTORS = [
    '.bb-hero',
    '.bb-orb-stage',
    '.bb-orb-canvas',
    '.bb-orb-center',
    '.bb-orb-label',
    '.bb-orb-hint',
    '.bb-orbit-node',
    '.bb-hero-stats',
    '.bb-stats-view',
    '.bb-completion',
    '.bb-progress',
    '.bb-progress i',
    '.bb-brain-chat',
    '.bb-grid',
    '.bb-card',
  ];

  /**
   * Every declaration the port ADDS to one of those selectors, and why.
   *
   * The list is exhaustive by construction: the assertion below fails on
   * anything not in it. That is the half the first version of this test was
   * missing — checking only that the demo's declarations survived let a second,
   * later declaration override one of them and still pass, which is exactly how
   * a lavender container could reappear behind a `background: transparent` that
   * was still, technically, present.
   */
  const ALLOWED_EXTRAS: Record<string, readonly string[]> = {
    // Safari still needs the prefix for the hero's frosted panel.
    '.bb-hero': ['-webkit-backdrop-filter:blur(18px)'],
    // A `<button>` does not inherit the page's font or colour; the demo's card
    // is a button too and relies on a global reset this app does not have.
    '.bb-card': ['font:inherit', 'color:inherit'],
  };

  /**
   * Declarations the port deliberately DROPS, and why.
   *
   * One entry, and it is the difference between a demo and a product: the demo
   * hard-codes the progress bar at 82%. The real width is the computed
   * completion, set inline from server data, so the fixed width must not be here
   * to fight it.
   */
  const ALLOWED_OMISSIONS: Record<string, readonly string[]> = {
    '.bb-progress i': ['width:82%'],
  };

  it.each(SELECTORS)('%s keeps every declaration the demo gives it', (selector) => {
    const expected = declarations(snapshot, selector);
    const actual = portedDeclarations(selector);
    const omissions = ALLOWED_OMISSIONS[selector] ?? [];

    const missing = expected.filter(
      (declaration) => !actual.includes(declaration) && !omissions.includes(declaration),
    );
    expect(missing, `${selector} lost or changed these declarations`).toEqual([]);
  });

  it.each(SELECTORS)('%s adds nothing the demo did not have', (selector) => {
    const expected = declarations(snapshot, selector);
    const allowed = ALLOWED_EXTRAS[selector] ?? [];

    const extra = portedDeclarations(selector).filter(
      (declaration) => !expected.includes(declaration) && !allowed.includes(declaration),
    );
    expect(extra, `${selector} gained declarations that are not the demo's`).toEqual([]);
  });

  /*
   * The four contrast overrides are the ONLY departures, so they are listed:
   * a fifth appearing without a decision is a silent redesign.
   */
  it('declares its accessibility departures instead of hiding them', () => {
    expect(ported).toContain("§2  THE ONLY VALUES THAT ARE NOT THE DEMO'S");
    for (const ratio of ['2.85:1', '3.72:1', '4.09:1', '3.80:1']) {
      expect(ported, `a departure is listed without its measured ratio`).toContain(ratio);
    }
  });
});

describe('the orb component is a transcription of the snapshot', () => {
  const snapshot = readFileSync(path.join(SNAPSHOT, 'brand-brain-native.js'), 'utf8');
  const orb = readFileSync(
    path.join(ROOT, 'apps/dashboard/src/app/[locale]/brand-brain/brand-orb.tsx'),
    'utf8',
  );

  /**
   * The demo's own constants. Each is a number that changes what the orb looks
   * like, and each is quoted from the snapshot so the pair cannot drift.
   */
  const CONSTANTS: ReadonlyArray<readonly [string, string]> = [
    ['orb scale', '1.3'],
    ['rotation rate', '0.000055'],
    ['orbit rate', '0.000012'],
    ['perspective', '700'],
    ['node radius factor', '0.41'],
    ['node ellipse factor', '0.72'],
    ['pointer repulsion radius', '105'],
    ['neighbour window', '24'],
    ['energy decay', '0.965'],
  ];

  it.each(CONSTANTS)('keeps the demo’s %s', (_name, value) => {
    // Present in the snapshot (possibly written `.000055`) and in the port.
    const bare = value.replace(/^0\./, '.');
    expect(snapshot.includes(value) || snapshot.includes(bare)).toBe(true);
    expect(orb).toContain(value);
  });

  it('keeps the demo’s six orbit angles, in the demo’s order', () => {
    expect(snapshot).toContain('[3.55,5.42,.3,2.83,1.62,4.7]');
    expect(orb.replace(/\s+/g, '')).toContain('[3.55,5.42,0.3,2.83,1.62,4.7]');
  });

  it('colours the particles with tokens carrying the demo’s exact values', () => {
    // The token trap, closed: a token that is CLOSE would repaint the orb.
    expect(brandBrainTokens.orbOuter).toBe('#7935fe');
    expect(brandBrainTokens.orbInner).toBe('#ffdd15');
    expect(brandBrainTokens.orbInk).toBe('#111114');
    for (const value of Object.values(brandBrainTokens)) {
      if (value === '#ffffff') continue; // the demo writes the flare as `#fff`.
      expect(snapshot, `${value} is not a colour the demo uses`).toContain(value);
    }
  });

  it('draws the demo’s composition and nothing else', () => {
    // Positive: the four elements the demo puts on the stage.
    for (const className of [
      'bb-orb-stage',
      'bb-orb-canvas',
      'bb-orb-center',
      'bb-orb-label',
      'bb-orb-hint',
      'bb-orbit-node',
    ]) {
      expect(orb, `the stage no longer renders .${className}`).toContain(className);
    }

    /*
     * Negative, and this half is the point. Each of these is something the
     * Phase 5A orb did that the demo does not do, written as a rule so it cannot
     * come back: no container surface behind the stage, no filled centre, no
     * card-shaped node, and never the customer's brand name in the middle.
     */
    expect(orb).not.toMatch(/brandName/);
    expect(orb).not.toMatch(/backgroundColor|borderRadius|boxShadow/);
  });
});
