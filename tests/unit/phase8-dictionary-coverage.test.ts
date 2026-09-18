import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY LABEL A SCREEN ASKS FOR IS A LABEL ITS PAGE SENDS — Phase 8.
 *
 * THE DEFECT THIS COVERS, WHICH SHIPPED AND WAS INVISIBLE. A dashboard page
 * builds a dictionary from an explicit list of message keys and hands it to its
 * client view; the view reads `t['content.media.legend']`. The media picker's
 * ten keys were never added to the Content Studio's list, so every one of them
 * came back `undefined` and the view's `?? ''` fallback turned each into an
 * empty string. The result rendered: a fieldset with a nameless legend, a count
 * that said nothing, an empty state with no sentence. Nothing failed. Nothing
 * logged. Both translations existed and neither was ever shown.
 *
 * TYPES CANNOT CATCH IT, and that is why this file exists. The dictionary is a
 * `Record<string, string>` by the time it crosses into the client component —
 * it has to be, because a function cannot cross that boundary and a per-page
 * key union would have to be threaded through every view. So the lookup is
 * always well-typed and sometimes empty.
 *
 * THE CHECK IS DELIBERATELY CRUDE: for every `t['some.key']` in a page's own
 * directory, the key must appear somewhere in that directory's `page.tsx`. That
 * is where the key list lives, and a key spelled there is a key translated. It
 * cannot tell a key in a list from a key in a comment — which is a trade made
 * on purpose, because the alternative is parsing TypeScript to find an array,
 * and a false PASS on a key someone wrote in prose is much cheaper than the
 * silence this replaces.
 */

const APP_DIR = resolve(import.meta.dirname, '../../apps/dashboard/src/app/[locale]');

/** Every directory under the locale segment that has a `page.tsx` of its own. */
function routeDirectories(): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir);
    if (entries.includes('page.tsx')) out.push(dir);
    for (const entry of entries) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
    }
  };
  walk(APP_DIR);
  return out;
}

/** The `t['…']` lookups in one file. */
function lookupsIn(source: string): readonly string[] {
  return [...source.matchAll(/\bt\[\s*'([a-zA-Z][\w.]*)'/g)].map((match) => match[1] as string);
}

describe('a view never asks for a label its page does not send', () => {
  for (const dir of routeDirectories()) {
    const pageSource = readFileSync(resolve(dir, 'page.tsx'), 'utf8');
    const siblings = readdirSync(dir).filter(
      (entry) => entry.endsWith('.tsx') && entry !== 'page.tsx',
    );

    for (const sibling of siblings) {
      const source = readFileSync(resolve(dir, sibling), 'utf8');
      const keys = [...new Set(lookupsIn(source))];
      if (keys.length === 0) continue;

      const relative = `${dir.slice(dir.indexOf('[locale]'))}/${sibling}`;
      it(`${relative} — every key it reads is in its page`, () => {
        const missing = keys.filter((key) => !pageSource.includes(`'${key}'`));
        expect(missing, `${relative} reads keys its page never sends`).toEqual([]);
      });
    }
  }
});
