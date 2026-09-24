import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PHASE 6 · P6-02 — CONTROLS COME FROM THE DESIGN SYSTEM, AND A CALL SITE
 * CANNOT OPT OUT BY FORGETTING.
 *
 * The owner reported buttons rendering in browser chrome and selects whose
 * dropdown markers did not match each other. Both were BYPASSES of a design
 * system that was already correct, and both were invisible to every check we
 * had: the pages typechecked, linted, passed their tests and rendered — just
 * not in the product's own visual language.
 *
 * So the fix had to be the system plus a guard, not the pages. The chevron and
 * the date-picker normalisation now key on the ELEMENT in `tokens.css`, which
 * covers a select nobody remembered to class; this file covers what CSS cannot
 * reach — a `<button>` with no styling at all, which no stylesheet can rescue
 * because there is nothing to hook.
 *
 * WHY SOURCE TEXT RATHER THAN A RENDER. What is being asserted is a property of
 * every call site in two applications, including server components that never
 * mount in a unit test and routes reachable only behind a permission. Rendering
 * would test the handful somebody remembered to render; reading the source
 * tests all of them, and the failure message names the file and line to fix.
 *
 * THIS IS A FLOOR, NOT A STYLE GUIDE. It asks only whether a control carries
 * SOME styling decision. Whether that decision is the right one is what review
 * and the fidelity contract are for.
 */

const ROOTS = ['apps/dashboard/src', 'apps/admin/src'];

/**
 * Controls that legitimately carry neither a class nor an inline style, each
 * because an ancestor rule in the design system's own stylesheets styles them.
 *
 * ADDING A LINE HERE IS A DECISION, and the reason goes beside it. An entry
 * that names a rule which does not exist is the bypass this file exists to
 * catch, wearing an exemption.
 */
const STYLED_BY_ANCESTOR_RULE: readonly { readonly file: string; readonly rule: string }[] = [
  {
    file: 'apps/dashboard/src/app/[locale]/brand-brain/brand-brain-view.tsx',
    rule: ".bb-upload button[type='submit'] in packages/ui/src/brand-brain.css",
  },
  {
    file: 'apps/dashboard/src/app/[locale]/brand-brain/brand-chat.tsx',
    rule: '.bb-chat-suggestions button in packages/ui/src/brand-brain.css',
  },
];

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (entry.endsWith('.tsx')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * The opening tags of one element, with their line numbers.
 *
 * Brace-aware, because a JSX attribute value is an expression that can contain
 * a `>` — `onClick={() => send()}` ends the tag six characters early to a naive
 * scan, and the attributes after it would be missed. That is exactly how a
 * styled control would be misreported as a bare one.
 */
function openingTags(source: string, element: string): readonly { line: number; tag: string }[] {
  const found: { line: number; tag: string }[] = [];
  /*
   * COMMENTS ARE BLANKED, NOT REMOVED — this check caught itself doing the
   * wrong thing. The comment explaining the billing fix contains the words
   * `<button>`, and the scan reported that prose as an unstyled control while
   * the real control two lines below was correct. Replacing each comment with
   * spaces of the same length keeps every remaining line number exact, so the
   * failure message still points at the file and line somebody has to open.
   */
  const scanned = source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
  const opener = new RegExp(`<${element}(?=[\\s/>])`, 'g');
  let match: RegExpExecArray | null;
  while ((match = opener.exec(scanned)) !== null) {
    let depth = 0;
    let index = match.index;
    while (index < scanned.length) {
      const char = scanned[index];
      if (char === '>' && depth === 0) break;
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      index += 1;
    }
    found.push({
      line: scanned.slice(0, match.index).split('\n').length,
      tag: scanned.slice(match.index, index + 1),
    });
  }
  return found;
}

/**
 * The rules in a stylesheet, as (selector, body) pairs.
 *
 * Comments are stripped first: a `background:` inside a comment is prose, and
 * a selector-looking line inside one is not a rule. Nested at-rules are handled
 * by ignoring any "selector" that starts with `@` or is empty.
 */
function rules(css: string): readonly { selector: string; body: string }[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; body: string }[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutComments)) !== null) {
    const selector = (match[1] ?? '').trim();
    if (selector === '' || selector.startsWith('@')) continue;
    out.push({ selector, body: match[2] ?? '' });
  }
  return out;
}

const EXEMPT_FILES = new Set(STYLED_BY_ANCESTOR_RULE.map((e) => e.file));

describe('P6-02 · no control renders in browser chrome', () => {
  it('every <button> carries a class or an inline style', () => {
    const bare: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        if (EXEMPT_FILES.has(file)) continue;
        const source = readFileSync(file, 'utf8');
        for (const { line, tag } of openingTags(source, 'button')) {
          if (tag.includes('className=') || tag.includes('style=')) continue;
          bare.push(`${file}:${line}`);
        }
      }
    }

    // The two that shipped bare were the accounting export — the control the
    // owner reported — and the Control Center's billing-event replay.
    expect(
      bare,
      `These <button> elements carry no styling at all, so they render in the browser's own ` +
        `chrome. Use the Button component, or buttonStyle() WITH buttonClass() where a plain ` +
        `submit is required:\n  ${bare.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every exemption names a file that exists and a rule that is really there', () => {
    // An exemption is only honest while the rule it cites is still in the
    // stylesheet. Deleting the rule and keeping the line here would leave a
    // bare control looking approved.
    for (const { file, rule } of STYLED_BY_ANCESTOR_RULE) {
      expect(() => statSync(file), `${file} is exempted but does not exist`).not.toThrow();

      const words = rule.split(' ');
      const stylesheet = words[words.length - 1] ?? '';
      const selector = words.slice(0, words.indexOf('in')).join(' ');
      expect(stylesheet, `the exemption for ${file} names no stylesheet`).toMatch(/\.css$/);
      const css = readFileSync(stylesheet, 'utf8');
      expect(css, `${stylesheet} no longer contains ${selector}`).toContain(selector);
    }
  });
});

describe('P6-02 · the select chevron is the element rule, not a class', () => {
  const tokens = readFileSync('packages/ui/src/tokens.css', 'utf8');

  it('normalises appearance for every select, however it is classed', () => {
    // Keyed on `.bs-control` this covered most selects and missed seven, which
    // is how two different dropdown markers came to sit side by side. A bare
    // `select` selector is the only form a new call site cannot fall out of.
    expect(tokens).toMatch(/\nselect \{[^}]*appearance: none;/);
  });

  it('mirrors the marker for RTL', () => {
    expect(tokens).toMatch(/html\[dir='rtl'\] select \{[^}]*background-position: left/);
  });

  it('sizes the marker through custom properties, so a small control can fit', () => {
    // The override a 36px filter select needs. Overriding the VARIABLES keeps
    // one glyph; overriding the RULE is how a second treatment starts.
    expect(tokens).toContain('--bs-select-chevron-inset');
    expect(tokens).toContain('--bs-select-chevron-space');
  });

  it('no stylesheet uses the background SHORTHAND on the select ELEMENT', () => {
    // `background: var(--cs-soft)` resets `background-image` as well as the
    // colour, and those rules outrank the element rule on specificity — so the
    // shorthand silently erased the chevron and handed the control back to the
    // browser. `background-color` says what was meant.
    //
    // ONLY WHERE THE SUBJECT IS THE SELECT ITSELF. `select option`,
    // `::picker(select)` and the panel rules paint a different box that carries
    // no chevron, and the shorthand is correct there — an earlier version of
    // this check flagged all four and was measuring its own regex.
    const offenders: string[] = [];
    for (const sheet of ['content-studio.css', 'brand-brain.css', 'tokens.css']) {
      const path = join('packages/ui/src', sheet);
      for (const { selector, body } of rules(readFileSync(path, 'utf8'))) {
        const subjects = selector.split(',').map((part) => part.trim());
        const paintsTheControl = subjects.some(
          (part) => /(^|[\s>+~])select(\.[\w-]+|:not\([^)]*\))*$/.test(part) && part !== '',
        );
        if (!paintsTheControl) continue;
        if (/(^|\n)\s*background:\s/.test(body)) {
          offenders.push(`${path}: ${subjects.join(', ')}`);
        }
      }
    }
    expect(
      offenders,
      `Use background-color, not the background shorthand, on a select:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('withdraws the chevron where the browser draws its own picker icon', () => {
    // THE "TWO DOWN ARROWS" REGRESSION. `appearance: base-select` and
    // `appearance: none` are the same specificity, so the later one wins: the
    // browser drew `::picker-icon` AND the chevron image was still painted
    // underneath. Inside the @supports block the product's marker stands down.
    const block = tokens.slice(tokens.indexOf('@supports (appearance: base-select)'));
    expect(block).toMatch(/select \{[^}]*background-image: none;/);
  });
});

describe('P6-02 · date fields keep the product geometry', () => {
  const tokens = readFileSync('packages/ui/src/tokens.css', 'utf8');

  it('normalises the native picker indicator', () => {
    // A browser-drawn glyph at its own size and colour, beside a normalised
    // chevron, is two design languages in one toolbar.
    expect(tokens).toContain('::-webkit-calendar-picker-indicator');
  });

  it('positions the indicator logically, so Arabic mirrors it', () => {
    expect(tokens).toMatch(/::-webkit-calendar-picker-indicator \{[^}]*margin-inline-start/);
  });
});
