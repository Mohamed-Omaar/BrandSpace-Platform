import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { optionalMessage, translator } from '../../apps/dashboard/src/i18n/messages';

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

describe('a key that might not exist is asked for correctly', () => {
  /*
   * THE DEFECT, WHICH APPEARED THREE TIMES INDEPENDENTLY. Some labels are built
   * from a value the DATABASE supplies — an audit entry's actor type, a
   * notification's template key, a publish job's failure code — so the key is
   * only known at runtime and may have no translation. All three screens tested
   * for the miss by comparing the result against the key.
   *
   * THAT TEST IS ALWAYS FALSE. `translator` returns `dictionary[key]`, so a
   * miss is `undefined`, not the key: the comparison never matches, the
   * fallback never runs, and `undefined` is rendered as nothing. A failed
   * publish reported no failure; an unrecognised notification had no headline.
   */
  it('translator returns undefined for a key it does not have, NOT the key', () => {
    const t = translator('en');
    expect(t('publishing.code.nothing.like.this' as never)).toBeUndefined();
  });

  it('so `translated === key` can never detect a miss', () => {
    const t = translator('en');
    const key = 'publishing.code.nothing.like.this';
    expect(t(key as never) === key).toBe(false);
  });

  it('optionalMessage answers null for a miss, in both languages', () => {
    expect(optionalMessage('en', 'publishing.code.nothing.like.this')).toBeNull();
    expect(optionalMessage('ar', 'publishing.code.nothing.like.this')).toBeNull();
  });

  it('and answers the real sentence for a key that exists', () => {
    expect(optionalMessage('en', 'publishing.failure.content_rejected')).toBeTruthy();
    expect(optionalMessage('ar', 'publishing.failure.content_rejected')).toBeTruthy();
    expect(optionalMessage('en', 'publishing.failure.content_rejected')).not.toBe(
      optionalMessage('ar', 'publishing.failure.content_rejected'),
    );
  });

  it('NO SCREEN COMPARES A TRANSLATION AGAINST ITS KEY any more', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
          /*
           * COMMENTS STRIPPED FIRST. Two of the files below EXPLAIN this
           * defect, quoting the comparison in prose — and a guard that cannot
           * tell an explanation from the code it warns about would forbid
           * writing the explanation down.
           */
          const source = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');
          /*
           * THE SHAPE, NOT THE WORD. A `k !== key` inside a checkbox filter is
           * a different `key` entirely, so the pattern requires the LEFT side
           * to be a translation: either `t(...)` directly, or one of the names
           * a translation result is given before it is compared.
           */
          const misuse =
            /\bt\([^)]*\)\s*(===|!==)\s*\w*[Kk]ey\b/.test(source) ||
            /\b(translated|headline|codeMessage|sentence|label)\s*(===|!==)\s*\w*[Kk]ey\b/.test(
              source,
            );
          if (misuse) {
            offenders.push(full.slice(full.indexOf('apps/dashboard')));
          }
        }
      }
    };
    walk(resolve(import.meta.dirname, '../../apps/dashboard/src'));
    expect(offenders).toEqual([]);
  });
});
