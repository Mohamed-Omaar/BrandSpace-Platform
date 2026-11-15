import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B2 (owner, 2026-11-14) — ONE LANGUAGE PER PAGE, KEPT THAT WAY.
 *
 * The browser used to download both dictionaries on every page because client
 * components imported `i18n/messages.ts`. Now a page loads only its own
 * language (`i18n/words-context.tsx`, an `import()` per language). This walks
 * every `'use client'` module's static imports and fails if any of them can
 * reach `messages.ts` or a whole dictionary again. A `'use server'` module is
 * only referenced from the browser, never bundled, so the walk stops there.
 */

const ROOT = path.resolve(__dirname, '../../apps/dashboard/src');
const FORBIDDEN = ['i18n/messages.ts', 'i18n/dict/en.ts', 'i18n/dict/ar.ts'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/** Static VALUE imports and re-exports (type-only ones are erased). */
function valueImports(file: string, source: string): string[] {
  const out: string[] = [];
  const statements = /^(import|export)\s+(type\s+)?([^;]*?)\s+from\s+'([^']+)'/gms;
  for (const match of source.matchAll(statements)) {
    if (match[2]) continue;
    const clause = match[3] ?? '';
    const named = /\{([^}]*)\}/.exec(clause);
    const onlyTypes =
      named !== null &&
      !/^\s*\w+\s*,/.test(clause) &&
      (named[1] ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .every((part) => part.startsWith('type '));
    if (onlyTypes) continue;
    const target = resolve(file, match[4] ?? '');
    if (target) out.push(target);
  }
  return out;
}

const directive = (source: string) => source.trimStart().slice(0, 14);

describe('B2 · a page in the browser carries one language', () => {
  const all = files(ROOT);
  const sources = new Map(all.map((file) => [file, readFileSync(file, 'utf8')]));
  const clients = all.filter((file) => /^['"]use client['"]/.test(directive(sources.get(file)!)));

  it('no client module reaches messages.ts or a whole dictionary through its imports', () => {
    const leaks: string[] = [];
    for (const client of clients) {
      const from = new Map<string, string | null>([[client, null]]);
      const queue = [client];
      while (queue.length > 0) {
        const current = queue.shift()!;
        const source = sources.get(current) ?? '';
        if (current !== client && /^['"]use server['"]/.test(directive(source))) continue;
        for (const next of valueImports(current, source)) {
          if (from.has(next)) continue;
          from.set(next, current);
          queue.push(next);
        }
      }
      for (const forbidden of FORBIDDEN) {
        const target = path.join(ROOT, forbidden);
        if (!from.has(target)) continue;
        const chain: string[] = [];
        for (let at: string | null = target; at; at = from.get(at) ?? null) {
          chain.push(path.relative(ROOT, at));
        }
        leaks.push(chain.join(' <- '));
      }
    }
    expect(leaks).toEqual([]);
  });

  it('the words provider loads each language with import(), never both statically', () => {
    const provider = sources.get(path.join(ROOT, 'i18n/words-context.tsx'))!;
    expect(provider).toContain("import('./dict/en')");
    expect(provider).toContain("import('./dict/ar')");
    expect(provider).not.toMatch(/^import [^;]*from '\.\/dict\/(en|ar)'/m);
  });

  it('there are client modules to check (the walk is not vacuous)', () => {
    expect(clients.length).toBeGreaterThan(50);
  });
});
