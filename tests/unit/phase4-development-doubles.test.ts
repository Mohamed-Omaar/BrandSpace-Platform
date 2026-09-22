import { afterEach, describe, expect, it } from 'vitest';
import { DevelopmentOnlyInProductionError } from '@brandspace/shared';
import { FilesystemObjectStore } from '@brandspace/storage';
import { LocalDevelopmentKeyProvider } from '@brandspace/vault';
import { DevelopmentPaymentProvider } from '@brandspace/billing';
import { MockSocialConnectorAdapter } from '@brandspace/social-connectors';
import { MockAnalyticsConnectorAdapter } from '@brandspace/analytics';

/**
 * EVERY DEVELOPMENT DOUBLE REFUSES ITSELF — Phase 4, reconciling the Phase 1 note.
 *
 * WHAT THE NOTE SAID, AND WHY IT MATTERED. CLAUDE.md §2.2 states that five
 * development doubles "REFUSE to be constructed or registered when
 * APP_ENV=production", and names `assertNotProduction()` as how a double joins
 * them. Only two of them had the call. The rest relied on the FACTORY or the
 * integrations registry refusing — which is correct for the one path that goes
 * through it, and does nothing for a `new` anywhere else: a script, a helper
 * promoted to a service, a caller written by somebody who did not know the rule.
 *
 * THE LOCAL KEY PROVIDER WAS THE SHARPEST CASE. Its own doc comment said
 * "`assertNotProduction()` refuses to let it run in production", and the call
 * was not there — the refusal lived only in `createKeyProvider`. A file that
 * claims a guard it does not have is worse than one that claims nothing.
 *
 * THE FACTORY REFUSALS ARE UNCHANGED AND STILL FIRST. These are the second lock,
 * and the tests that prove the first one still pass beside this file.
 */

const ORIGINAL = process.env['APP_ENV'];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['APP_ENV'];
  else process.env['APP_ENV'] = ORIGINAL;
});

function inProduction(): void {
  // APP_ENV, never NODE_ENV — D-97. Every built Next.js app sets NODE_ENV to
  // production, including the one the E2E suite serves.
  process.env['APP_ENV'] = 'production';
}

describe('a development double cannot be constructed in production', () => {
  it('refuses the filesystem object store', () => {
    inProduction();
    expect(() => new FilesystemObjectStore('/tmp/whatever')).toThrow(
      DevelopmentOnlyInProductionError,
    );
  });

  it('refuses the local development key provider', () => {
    inProduction();
    expect(
      () => new LocalDevelopmentKeyProvider('a-key-long-enough-to-pass-the-length-check'),
    ).toThrow(DevelopmentOnlyInProductionError);
  });

  it('refuses the development payment provider', () => {
    inProduction();
    expect(
      () =>
        new DevelopmentPaymentProvider({
          webhookSecret: 'test-only-secret-not-a-real-one',
          hostedBaseUrl: 'https://example.test',
        }),
    ).toThrow(DevelopmentOnlyInProductionError);
  });

  it('refuses a mock social connector', () => {
    inProduction();
    expect(
      () =>
        new MockSocialConnectorAdapter('INSTAGRAM', {
          maxMediaCount: 10,
          supportsScheduling: true,
          supportsStories: true,
          maxCaptionLength: 2_200,
        } as never),
    ).toThrow(DevelopmentOnlyInProductionError);
  });

  it('refuses a mock analytics connector', () => {
    inProduction();
    expect(() => new MockAnalyticsConnectorAdapter('INSTAGRAM')).toThrow(
      DevelopmentOnlyInProductionError,
    );
  });
});

describe('outside production every one of them still works', () => {
  /*
   * THE OTHER HALF OF THE RULE. A guard that fired in staging — or for a
   * developer running `next build && next start` — would be D-97 all over
   * again, which is why `assertNotProduction` reads APP_ENV and why this
   * asserts the permissive direction as loudly as the refusing one.
   */
  it('constructs each double under a development environment', () => {
    process.env['APP_ENV'] = 'development';
    expect(() => new FilesystemObjectStore('/tmp/whatever')).not.toThrow();
    expect(
      () => new LocalDevelopmentKeyProvider('a-key-long-enough-to-pass-the-length-check'),
    ).not.toThrow();
    expect(() => new MockAnalyticsConnectorAdapter('INSTAGRAM')).not.toThrow();
  });

  it('constructs each double under a STAGING environment, which is a production BUILD', () => {
    process.env['APP_ENV'] = 'staging';
    expect(
      () => new LocalDevelopmentKeyProvider('a-key-long-enough-to-pass-the-length-check'),
    ).not.toThrow();
    expect(() => new MockAnalyticsConnectorAdapter('INSTAGRAM')).not.toThrow();
  });
});

/**
 * THE DEVELOPMENT SEED IS A DEVELOPMENT TOOL — Phase 4 §6.
 *
 * `pnpm db:seed` creates a Platform Owner, enrols a second factor and prints it,
 * and provisions two demonstration workspaces with their own users. It reads
 * whichever `DATABASE_PLATFORM_URL` is set, and NOTHING stopped it running
 * against a real one: the throwaway E2E seeds each carried their own guard while
 * the seed that writes an OWNER carried none.
 *
 * READ AS SOURCE, DELIBERATELY. Importing it would execute a connection, and
 * running it is the thing being prevented; what matters is that the guard is the
 * first statement of the run, and that it is the SHARED helper rather than a
 * fourth hand-rolled copy of the same `if`.
 */
describe('the development seed refuses production', () => {
  it('calls the shared guard before it does anything else', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const source = readFileSync(
      path.resolve(__dirname, '../../packages/database/prisma/seed.ts'),
      'utf8',
    );

    expect(source).toContain('assertNotProduction(');
    // From @brandspace/shared, not a local copy: three local copies already
    // exist in the E2E seeds and a fourth is a fourth thing to get wrong.
    expect(source).toMatch(/import \{[^}]*assertNotProduction[^}]*\} from '@brandspace\/shared'/s);

    const mainBody = source.slice(source.indexOf('async function main()'));
    const guardAt = mainBody.indexOf('assertNotProduction(');
    const firstWrite = Math.min(
      ...['prisma.permission.upsert', 'const prisma = client()']
        .map((marker) => mainBody.indexOf(marker))
        .filter((index) => index >= 0),
    );
    expect(guardAt).toBeGreaterThan(0);
    // BEFORE the client is even constructed: a guard that runs after the
    // connection has already reached the database it is refusing to touch.
    expect(guardAt).toBeLessThan(firstWrite);
  });
});
