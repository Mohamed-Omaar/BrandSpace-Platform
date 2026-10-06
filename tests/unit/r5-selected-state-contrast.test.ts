import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ROUND 5 (C) — A SELECTED CHIP, TAB OR SEGMENT NEVER LOSES ITS WORDS.
 *
 * The defect class: the shared pressed chip is white on black, and a more
 * specific rule for one screen replaced only its FILL — the Brand Brain key
 * question was white on a pale purple, the media sheet's tab white on white.
 * So every rule that draws a selected state of the shared chip, tab or segment
 * and sets a background must set the text colour too. The browser check
 * (`tests/e2e/r5-selected-contrast.spec.ts`) measures the result.
 */

const root = path.resolve(__dirname, '../..');
const cssDir = path.join(root, 'packages/ui/src');
const SHARED =
  /\.bsp-chip|\.bsp-seg-item|\.bsp-seg\s*>\s*a|\.bsp-seg-|role=['"]?tab|\.bsp-tab|\.bsp-ltab/;
const SELECTED =
  /\[aria-pressed=['"]?true|\[aria-selected=['"]?true|\[aria-current|\[data-chosen|\[data-on|:checked/;

function rules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = re.exec(clean); match; match = re.exec(clean)) {
    out.push({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' });
  }
  return out;
}

describe('round 5 (C) — selected states keep their text colour', () => {
  const files = readdirSync(cssDir).filter((file) => file.endsWith('.css'));
  const offenders: string[] = [];
  let checked = 0;
  for (const file of files) {
    for (const rule of rules(readFileSync(path.join(cssDir, file), 'utf8'))) {
      for (const selector of rule.selector.split(',').map((part) => part.trim())) {
        if (!SHARED.test(selector) || !SELECTED.test(selector)) continue;
        // A pseudo-element or a descendant of the chip draws something else.
        if (/::|\s[.#\w][^\]]*$/.test(selector.replace(/\[[^\]]*\]/g, ''))) continue;
        const setsFill = /(^|[;\s])background(-color)?\s*:/.test(rule.body);
        if (!setsFill) continue;
        checked += 1;
        if (!/(^|[;\s])color\s*:/.test(rule.body)) offenders.push(`${file}: ${selector}`);
      }
    }
  }

  it('finds the rules it is meant to guard', () => {
    expect(checked).toBeGreaterThan(3);
  });

  it('every selected-state rule that sets a fill also sets the text colour', () => {
    expect(offenders).toEqual([]);
  });
});
