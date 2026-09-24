import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Content Studio stylesheet is a TRANSCRIPTION of the approved demo.
 *
 * This is the test that would have caught Phase 5A. That orb passed typecheck,
 * lint, axe, 273 Playwright assertions and a design-system audit while being a
 * different design, because nothing in the suite compared it to the thing it
 * was a port of. `tests/unit/ui-fidelity-manifest.test.ts` does that for Brand
 * Brain; this does it for `postsPage()` and `composer()`.
 *
 * For every selector the two screens depend on, each `property: value` pair in
 * the pinned snapshot must appear in `packages/ui/src/content-studio.css`. A
 * dropped declaration fails and a changed value fails — including the ones a
 * reviewer's eye slides over, like a `gap` that grew by a pixel.
 *
 * It also runs the OTHER direction on the same blocks: a declaration the port
 * ADDED that the demo never had fails too. That direction is the one that
 * matters. Phase 5A's lavender container was an ADDED `background` sitting after
 * the demo's `background: transparent`, which overrides it while leaving it
 * present — so a one-way check would have passed.
 */

const ROOT = path.resolve(__dirname, '../..');
const DEMO = path.join(ROOT, 'docs/visual-reference/full-demo');
const ported = readFileSync(path.join(ROOT, 'packages/ui/src/content-studio.css'), 'utf8');

const snapshots = ['styles-1.css', 'styles-2.css', 'styles-3.css'].map((file) =>
  readFileSync(path.join(DEMO, file), 'utf8'),
);

/**
 * Normalise a declaration so only MEANING is compared.
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
 * THE ONE CLASS OF SUBSTITUTION THE CONTRACT ALLOWS (rule 4 and CLAUDE.md §4):
 * the demo is an English-only prototype and `text-align: left` renders Arabic
 * backwards. The logical property is IDENTICAL in LTR, and the mapping is
 * written down here so a genuine drift cannot hide behind it.
 */
const LOGICAL: ReadonlyArray<readonly [string, string]> = [
  ['text-align:left', 'text-align:start'],
  ['text-align:right', 'text-align:end'],
  ['margin-left', 'margin-inline-start'],
  ['margin-right', 'margin-inline-end'],
];

/**
 * The SECOND permitted substitution class: a background shorthand carrying only
 * a colour, written as the longhand that says so (P6-02).
 *
 * `background: var(--soft)` and `background-color: var(--soft)` paint the same
 * pixels. They differ in what they RESET: the shorthand also clears
 * `background-image`, so it silently erased the select chevron that
 * `tokens.css` applies to every select in the product — the rule outranks an
 * element rule on specificity, so the control was handed back to the browser's
 * own arrow. See `docs/UI-FIDELITY-CONTRACT.md` §4 for the authorisation.
 *
 * NARROW ON PURPOSE, and checked rather than assumed: it applies only where the
 * demo's own value is a bare colour — a `var()` or a hex. A demo declaration
 * carrying a gradient, an image or several layers is NOT a colour and is
 * compared literally, so `.cs-gradient-a` and friends cannot drift through this
 * door. A genuine change of fill still fails, because the VALUE is unchanged by
 * the mapping.
 *
 * APPLIED TO BOTH SIDES, so the two spellings compare equal in either direction:
 * a port rule that still writes the shorthand is not made to fail, and one that
 * writes the longhand is not made to look like an addition.
 */
const COLOUR_ONLY_BACKGROUND = /^background:(var\(--[a-z-]+\)|#[0-9a-f]{3,8}|transparent)$/;

function mapBackgroundLonghand(declaration: string): string {
  return COLOUR_ONLY_BACKGROUND.test(declaration)
    ? declaration.replace('background:', 'background-color:')
    : declaration;
}

/**
 * Flatten a stylesheet into `[selector, declarations]` pairs.
 *
 * A HAND-ROLLED WALK RATHER THAN A REGEX, because a regex cannot see nesting
 * and the demo's breakpoints are `@media` blocks — a pattern that matched
 * `{...}` without a stack would read the first rule INSIDE a media query as the
 * media query's own body and silently find nothing for every selector after it.
 * Comments are stripped first so a brace inside one cannot open a block.
 */
function rules(css: string): { selector: string; declarations: string[] }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; declarations: string[] }[] = [];

  const walk = (source: string): void => {
    let cursor = 0;
    while (cursor < source.length) {
      const open = source.indexOf('{', cursor);
      if (open === -1) return;
      const head = source.slice(cursor, open).trim();

      let depth = 1;
      let index = open + 1;
      while (index < source.length && depth > 0) {
        if (source[index] === '{') depth += 1;
        else if (source[index] === '}') depth -= 1;
        index += 1;
      }
      const body = source.slice(open + 1, index - 1);

      // An at-rule holds rules, not declarations. Its BREAKPOINT is asserted
      // separately; here we only need to see through it to the rules inside.
      if (head.startsWith('@')) walk(body);
      else {
        for (const selector of head.split(',')) {
          out.push({
            selector: selector.trim().replace(/\s+/g, ' '),
            declarations: body
              .split(';')
              .map((part) => normalise(part))
              .filter((part) => part.length > 0),
          });
        }
      }
      cursor = index;
    }
  };

  walk(text);
  return out;
}

const DEMO_RULES = snapshots.flatMap((css) => rules(css));
const PORT_RULES = rules(ported);

/**
 * Every declaration the demo applies to `selector`, across its three
 * stylesheets and across grouped rules.
 *
 * ACCUMULATED RATHER THAN TAKEN FROM THE FIRST MATCH, because the demo splits a
 * single element's styling across grouped selectors on purpose: `.tabs` gets
 * its flex layout from `.filter-row,.tabs`, its padding and background from
 * `.segmented,.tabs`, and nothing from a rule of its own. A reader of one rule
 * would port a third of the element.
 */
function demoDeclarations(selector: string): string[] {
  const found = DEMO_RULES.filter((rule) => rule.selector === selector).flatMap((rule) =>
    rule.declarations.map((declaration) => {
      const mapped = LOGICAL.find(([physical]) => declaration.startsWith(physical));
      return mapBackgroundLonghand(
        mapped ? declaration.replace(mapped[0], mapped[1]) : declaration,
      );
    }),
  );
  if (found.length === 0) throw new Error(`selector "${selector}" is not in the snapshot`);
  return found;
}

/** The port's own declarations for a selector, likewise accumulated. */
function portedDeclarations(selector: string): string[] {
  const found = PORT_RULES.filter((rule) => rule.selector === selector).flatMap((rule) =>
    rule.declarations.map(mapBackgroundLonghand),
  );
  if (found.length === 0) throw new Error(`selector "${selector}" is not in the port`);
  return found;
}

/**
 * The demo's `:root` variables, and the port's page-scoped names for them.
 *
 * The port scopes them to `.content-page` rather than `:root` so it cannot
 * recolour a screen it was never about, and prefixes them so they cannot
 * collide with the Brand Brain port's. The VALUES are the demo's, which is what
 * the mapping preserves — `--muted` excepted, and that exception is asserted
 * separately below with its reason.
 */
const VARIABLE_MAP: ReadonlyArray<readonly [string, string]> = [
  ['--soft', '--cs-soft'],
  ['--purple', '--cs-purple'],
  ['--yellow', '--cs-yellow'],
  ['--ink', '--cs-ink'],
  ['--success', '--cs-success'],
  ['--warning', '--cs-warning'],
  ['--soft-shadow', '--cs-soft-shadow'],
  ['--muted', '--cs-muted'],
];

function mapVariables(declaration: string): string {
  let out = declaration;
  for (const [demo, port] of VARIABLE_MAP) out = out.replaceAll(`var(${demo})`, `var(${port})`);
  return out;
}

/**
 * Demo selector → the port's prefixed name.
 *
 * The prefix is the ONLY thing that changes. Every selector the two screens
 * render is here; a selector missing from this table is a selector nothing
 * checks.
 */
const SELECTORS: ReadonlyArray<readonly [string, string]> = [
  ['.view-toolbar', '.cs-view-toolbar'],
  ['.view-toolbar h2', '.cs-view-toolbar h2'],
  ['.section-kicker', '.cs-section-kicker'],
  ['.tabs', '.cs-tabs'],
  ['.tabs button', '.cs-tabs button'],
  ['.tabs button.selected', '.cs-tabs button.selected'],
  ['.filter-row', '.cs-filter-row'],
  ['.search-field', '.cs-search-field'],
  ['.card-grid', '.cs-card-grid'],
  ['.post-card', '.cs-post-card'],
  ['.post-art', '.cs-post-art'],
  ['.post-art>span', '.cs-post-art > span'],
  ['.post-info', '.cs-post-info'],
  ['.post-info b', '.cs-post-info b'],
  ['.post-info small', '.cs-post-info small'],
  ['.gradient-a', '.cs-gradient-a'],
  ['.gradient-b', '.cs-gradient-b'],
  ['.gradient-c', '.cs-gradient-c'],
  ['.gradient-d', '.cs-gradient-d'],
  ['.status', '.cs-status'],
  ['.status.review', '.cs-status.review'],
  ['.status.draft', '.cs-status.draft'],
  ['.surface-card', '.cs-surface-card'],
  ['.field', '.cs-field'],
  ['.field label', '.cs-field label'],
  ['.field textarea', '.cs-field textarea'],
  ['.form-row', '.cs-form-row'],
  ['.form-actions', '.cs-form-actions'],
  ['.channel-row', '.cs-channel-row'],
  ['.channel', '.cs-channel'],
  ['.channel.selected', '.cs-channel.selected'],
  ['.primary-button', '.cs-primary-button'],
  ['.dark-button', '.cs-dark-button'],
  ['.ghost-button', '.cs-ghost-button'],
  ['.compact', '.cs-compact'],
  ['.select-like', '.cs-select'],
];

/**
 * Declarations the port is permitted to hold that the demo does not, listed one
 * by one with the reason. Anything not in here fails.
 */
const PERMITTED_ADDITIONS: Record<string, readonly string[]> = {
  // The demo groups `.section-head,.view-toolbar` and `.filter-row,.tabs` in
  // one rule and `.view-toolbar`/`.segmented,.tabs` in another; the port
  // flattens each pair into the single prefixed selector, so nothing is added —
  // only spelt in one place. No entry is needed for those.
  //
  // `.cs-field textarea` in the demo also inherits the `.field textarea,
  // .field input,.field select,.input-like` block. The port spells that group
  // out too, so the inherited declarations appear under the grouped selector
  // rather than here.
  '.cs-post-art > span': [],

  /*
   * THE SELECT CHEVRON'S SIZE, on the two rules that render a select (P6-02).
   *
   * Not a visual change to the demo's control: the fill, radius, padding, type
   * and geometry are unchanged and still compared. These two custom properties
   * only tell `tokens.css` how much trailing room THIS control can spare for the
   * one dropdown marker the product draws — a 36px filter select at 9px type
   * cannot take the default 2.75rem.
   *
   * The marker itself is the authorised deviation recorded in
   * `docs/UI-FIDELITY-CONTRACT.md` §4: the demo's `.select-like` is a static
   * `<div>` with no options and therefore no affordance, and rendering it as a
   * real `<select>` — which the demo's own `.field select` rule contemplates —
   * gave it the browser's arrow instead. The owner authorised one consistent,
   * RTL-mirrored marker in the Phase 6 brief.
   */
  '.cs-select': ['--bs-select-chevron-inset:0.5rem', '--bs-select-chevron-space:1.75rem'],
};

describe('the Content Studio stylesheet is a transcription of the pinned demo', () => {
  it.each(SELECTORS)('%s keeps every declaration the demo gives it', (demo, port) => {
    const expected = demoDeclarations(demo).map(mapVariables);
    const actual = portedDeclarations(port);
    for (const declaration of expected) {
      expect(actual, `${port} lost "${declaration}"`).toContain(declaration);
    }
  });

  it.each(SELECTORS)('%s adds nothing the demo does not have', (demo, port) => {
    const expected = new Set(demoDeclarations(demo).map(mapVariables));
    const permitted = new Set(PERMITTED_ADDITIONS[port] ?? []);
    for (const declaration of portedDeclarations(port)) {
      if (expected.has(declaration) || permitted.has(declaration)) continue;
      throw new Error(
        `${port} adds "${declaration}", which the demo does not have. ` +
          `Add it to PERMITTED_ADDITIONS with a reason, or remove it.`,
      );
    }
  });

  it('the demo variables carry the demo values, and the one exception is deliberate', () => {
    /*
     * `--muted` is the ONLY colour the port does not take verbatim, and it is
     * not a new decision: `packages/ui/src/tokens.ts` already carries `#6A6A72`
     * as the platform's documented deviation, because the demo's `#717179`
     * measures 4.44:1 on its own `--soft` — under the AA minimum at the 8px and
     * 9px this design uses it at.
     *
     * Asserted against the token rather than against a literal, so the two
     * cannot drift into being two answers.
     */
    const declarations = portedDeclarations('.content-page');
    expect(declarations).toContain('--cs-ink:#111114');
    expect(declarations).toContain('--cs-soft:#f5f5f6');
    expect(declarations).toContain('--cs-purple:#7935fe');
    expect(declarations).toContain('--cs-yellow:#ffdd15');
    expect(declarations).toContain('--cs-success:#16794b');
    expect(declarations).toContain('--cs-warning:#875f00');
    // Whitespace is normalised away by `normalise`, so the expectation is too.
    expect(declarations).toContain(normalise('--cs-soft-shadow: 0 12px 35px rgba(16,14,28,.06)'));

    // The exception, in its own block in §2. The demo's own value appears
    // nowhere as a DECLARATION — it is named in §2's prose, which is where an
    // override belongs, so the check is against the declarations rather than
    // against the file's text.
    expect(declarations).toContain('--cs-muted:#6a6a72');
    for (const rule of PORT_RULES) {
      for (const declaration of rule.declarations) {
        expect(declaration, `${rule.selector} still uses the demo's under-AA grey`).not.toContain(
          '#717179',
        );
      }
    }
  });

  it('the media queries use the demo’s own breakpoints and values', () => {
    for (const width of ['1200px', '900px', '640px']) {
      expect(ported, `the ${width} breakpoint is missing`).toContain(
        `@media (max-width: ${width})`,
      );
    }
    // The three-column composer is the ONE authorised geometry deviation: the
    // Copilot is Phase 7, so the grid carries two tracks. Everything else about
    // the breakpoints is the demo's.
    expect(ported).toContain('grid-template-columns: minmax(350px, 1fr) 340px');
    expect(ported).toContain('grid-template-columns: minmax(340px, 1fr) 330px');
    expect(ported).not.toContain('300px');
  });

  it('the composer markup is the demo’s composition', () => {
    /*
     * The class names a reviewer would look for, asserted against the VIEW
     * rather than the stylesheet — a stylesheet full of ported rules nothing
     * renders is not a port.
     *
     * THE LIBRARY IS NO LONGER A DEMO PORT. The owner's final UX contract
     * (D-277 §15, D-282) replaced its gradient cards with a media-first library
     * built from the design system; that decision supersedes this assertion
     * for `/content`, and `docs/UI-FIDELITY-CONTRACT.md` records it.
     */
    const composer = readFileSync(
      path.join(ROOT, 'apps/dashboard/src/app/[locale]/content/compose/composer-view.tsx'),
      'utf8',
    );

    for (const className of [
      'cs-view-toolbar',
      'cs-composer',
      'cs-surface-card',
      'cs-channel-row',
      'cs-channel',
      'cs-field',
      'cs-form-row',
      'cs-form-actions',
    ]) {
      expect(composer, `the composer does not render .${className}`).toContain(className);
    }

    // The Copilot column is Phase 7 and must not appear early.
    expect(composer).not.toContain('copilot-panel');
  });
});
