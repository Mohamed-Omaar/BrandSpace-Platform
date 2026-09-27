import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { AppError } from '@brandspace/shared';

/**
 * PHASE 2B-1 REVIEW, ITEM 10 — NEXT.JS CONTROL FLOW IS NEVER SWALLOWED.
 *
 * `requireWorkspaceAction` answers a closed workspace, a missing second factor
 * or an expired session by REDIRECTING, which Next.js implements by throwing.
 * A `catch` that turned that throw into `?error=…` sent the person to the wrong
 * page with a false error. Every try/catch this PR added or rewrote re-throws
 * control flow first, as the cancel action already did.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
// `next` is the dashboard's dependency, so it is loaded the way the dashboard resolves it.
const { notFound, redirect, unstable_rethrow } = createRequire(
  path.join(root, 'apps/dashboard/package.json'),
)('next/navigation') as {
  notFound: () => never;
  redirect: (url: string) => never;
  unstable_rethrow: (error: unknown) => void;
};

const CATCHES = [
  'apps/dashboard/src/app/[locale]/settings/actions.ts',
  'apps/dashboard/src/app/[locale]/settings/ai/actions.ts',
  'apps/dashboard/src/app/[locale]/settings/data/actions.ts',
  'apps/dashboard/src/app/[locale]/settings/notifications/actions.ts',
  'apps/dashboard/src/app/api/settings/timezone-preview/route.ts',
];

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('Review item 10 · control flow is re-thrown before anything else', () => {
  it('each catch block re-throws first, before logging or building an error redirect', () => {
    for (const file of CATCHES) {
      const source = read(file);
      const blocks = [...source.matchAll(/\} catch \(error: unknown\) \{([\s\S]*?)\n {2}\}/g)];
      expect(blocks.length, file).toBeGreaterThan(0);
      for (const block of blocks) {
        const firstStatement = (block[1] ?? '')
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line !== '' && !line.startsWith('//'));
        expect(firstStatement, file).toBe('unstable_rethrow(error);');
      }
    }
  });

  it('what it re-throws: a redirect and a notFound — and not an application error', () => {
    const redirected = thrown(() => redirect('/en/mfa-setup'));
    expect(() => unstable_rethrow(redirected)).toThrow();
    const missing = thrown(() => notFound());
    expect(() => unstable_rethrow(missing)).toThrow();
    // An ordinary failure is left for the catch block to report.
    expect(() => unstable_rethrow(new AppError('FORBIDDEN', 'No.'))).not.toThrow();
    expect(() => unstable_rethrow(new Error('database down'))).not.toThrow();
  });
});
