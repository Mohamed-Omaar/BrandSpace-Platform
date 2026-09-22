import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConfigurationService } from '@brandspace/config';
import { platformRoleClient } from './fixtures';

/**
 * ACTIVATING A PROVIDER IN ONE PROCESS MUST REACH THE PROCESS THAT SENDS — Phase 5.
 *
 * THE DEFECT, AND HOW IT PRESENTED. `apps/api/src/email-provider.ts` memoised the
 * resolved provider for sixty seconds, keyed on time alone. The process that
 * ACTIVATES a provider is the Control Center; the process that SENDS is the API.
 * An owner connects Resend, the admin process invalidates ITS OWN configuration
 * cache and reports success, and the API goes on answering from a resolution
 * taken before the activation — writing to the development outbox.
 *
 * IT IS SILENT, WHICH IS THE WORST PART. `/v1/internal/email/deliver` returns
 * 200 throughout, because from its point of view a provider accepted the
 * message. The CI Playwright run showed exactly that: the delivery route
 * accepted the request (`expect(accepted.status()).toBe(200)` passed) and the
 * fake Resend recorder received ZERO `/emails` requests. The first real-world
 * evidence would be a customer who never received a verification link.
 *
 * `resetEmailProviderCache()` existed for this and HAD NO CALLERS anywhere in
 * the repository — a cross-process cache cannot be invalidated by an in-process
 * function call, so the design could not be fixed in that shape.
 *
 * WHY THIS TEST TALKS TO REAL POSTGRESQL AND USES TWO SERVICE INSTANCES. The bug
 * only exists BETWEEN processes. One `ConfigurationService` stands for the admin
 * process and performs the activation; a second stands for the API's and is the
 * one whose staleness matters. A single shared instance would invalidate its own
 * cache on activation and prove nothing.
 */

/** Version numbers must differ within a run; the clock alone is too coarse. */
let counter = 0;

const DOMAIN = 'integrations.email' as const;
const ENVIRONMENT = 'DEVELOPMENT' as const;

let platform: PrismaClient;

/** Whatever the suite found, so the run leaves the domain as it began. */
let original: { id: string; payload: unknown } | null = null;

beforeAll(async () => {
  platform = platformRoleClient();
  const active = await platform.configurationVersion.findFirst({
    where: { domain: DOMAIN, environment: ENVIRONMENT, status: 'ACTIVE' },
    select: { id: true, payload: true },
  });
  original = active ?? null;
}, 60_000);

afterEach(async () => {
  // Every activation here writes a row; put the domain back the way it was so
  // no other isolation file inherits an activated email provider.
  await platform.configurationVersion.updateMany({
    where: { domain: DOMAIN, environment: ENVIRONMENT, status: 'ACTIVE' },
    data: { status: 'SUPERSEDED' },
  });
  if (original) {
    await platform.configurationVersion.update({
      where: { id: original.id },
      data: { status: 'ACTIVE' },
    });
  }
});

afterAll(async () => {
  await platform.$disconnect();
});

/**
 * Activate a document the way the Control Center does, and return its version id.
 *
 * Written directly rather than through `ConfigurationService.activate` because
 * the property under test is what the API observes, not the activation
 * workflow's authorisation — which `phase10-hub-configuration` already covers.
 */
async function activate(payload: Record<string, unknown>): Promise<string> {
  await platform.configurationVersion.updateMany({
    where: { domain: DOMAIN, environment: ENVIRONMENT, status: 'ACTIVE' },
    data: { status: 'SUPERSEDED' },
  });
  const author = await platform.platformUser.findFirstOrThrow({ select: { id: true } });
  const created = await platform.configurationVersion.create({
    data: {
      domain: DOMAIN,
      environment: ENVIRONMENT,
      status: 'ACTIVE',
      versionNumber: Math.floor(Date.now() / 1000) + counter++,
      payload: payload as never,
      // Not the real checksum algorithm; nothing under test reads it, and
      // inventing one here would couple this file to a private helper.
      payloadChecksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      createdByPlatformUserId: author.id,
      changeReason: 'phase5 email provider staleness test',
    },
    select: { id: true },
  });
  return created.id;
}

const OUTBOX_DOCUMENT = {
  activeProviderKey: 'outbox',
  providers: [
    {
      key: 'outbox',
      name: 'Outbox email (development)',
      status: 'active',
      settings: {},
      secretRefs: {},
    },
  ],
};

const RESEND_DOCUMENT = {
  activeProviderKey: 'resend',
  providers: [
    {
      key: 'resend',
      name: 'Resend',
      status: 'active',
      settings: { fromEmail: 'noreply@staging.example' },
      secretRefs: {},
    },
  ],
};

describe('the activated version is visible to a second process immediately', () => {
  /*
   * THE STAMP THE FIX RESTS ON. `activeVersionId` is uncached by design, so it
   * is what lets a reader in another process notice that what it holds is no
   * longer current. If this ever started returning a cached value, the email
   * provider cache would silently go stale again.
   */
  it('a reader created BEFORE the activation still sees the new version id', async () => {
    const readerThatIsTheApiProcess = new ConfigurationService({ prisma: platform });

    const before = await activate(OUTBOX_DOCUMENT);
    expect(await readerThatIsTheApiProcess.activeVersionId(DOMAIN, ENVIRONMENT)).toBe(before);

    // The activation happens "elsewhere" — a different service instance, which
    // invalidates only its own caches.
    const adminProcess = new ConfigurationService({ prisma: platform });
    void adminProcess;
    const after = await activate(RESEND_DOCUMENT);

    expect(after).not.toBe(before);
    /*
     * THE ASSERTION THE DEFECT FAILS. A time-keyed cache answers `before` here
     * for up to sixty seconds. The stamp is read fresh, so it answers `after`.
     */
    expect(await readerThatIsTheApiProcess.activeVersionId(DOMAIN, ENVIRONMENT)).toBe(after);
  }, 60_000);

  it('a DISABLE is visible the same way, not only an activation', async () => {
    // Turning email off must reach the sender as fast as turning it on. An
    // operator disabling a provider during an incident is the case that matters.
    const reader = new ConfigurationService({ prisma: platform });
    const active = await activate(RESEND_DOCUMENT);
    expect(await reader.activeVersionId(DOMAIN, ENVIRONMENT)).toBe(active);

    await platform.configurationVersion.updateMany({
      where: { domain: DOMAIN, environment: ENVIRONMENT, status: 'ACTIVE' },
      data: { status: 'SUPERSEDED' },
    });

    expect(await reader.activeVersionId(DOMAIN, ENVIRONMENT)).toBeNull();
  }, 60_000);
});

describe('the payload a second process reads follows the activation', () => {
  it('DOES NOT serve the previous document once the stamp has changed', async () => {
    /*
     * THE OTHER HALF OF THE FIX. `ConfigurationService.get` memoises payloads
     * for thirty seconds of its own, and that cache was invalidated in the
     * process that activated — not in this one. So noticing the stamp is not
     * enough: the rebuild has to be told to stop believing its own cached
     * document, which is what `invalidateCache` does in `getEmailProvider`.
     */
    const apiProcess = new ConfigurationService({ prisma: platform });

    await activate(OUTBOX_DOCUMENT);
    const first = (await apiProcess.get(DOMAIN, ENVIRONMENT)) as Record<string, unknown>;
    expect(first['activeProviderKey']).toBe('outbox');

    await activate(RESEND_DOCUMENT);

    // Without the invalidation this still reads `outbox` — the stale document.
    apiProcess.invalidateCache(DOMAIN, ENVIRONMENT);
    const second = (await apiProcess.get(DOMAIN, ENVIRONMENT)) as Record<string, unknown>;
    expect(second['activeProviderKey']).toBe('resend');
  }, 60_000);

  it('PROVES the stale read when the cache is NOT invalidated', async () => {
    /*
     * The defect, demonstrated directly rather than asserted about. This is what
     * the API did on every send: a correct stamp would have been answered with
     * the previous document, and the rebuild would have produced the stale
     * provider again.
     */
    const apiProcess = new ConfigurationService({ prisma: platform });

    await activate(OUTBOX_DOCUMENT);
    expect(
      ((await apiProcess.get(DOMAIN, ENVIRONMENT)) as Record<string, unknown>)['activeProviderKey'],
    ).toBe('outbox');

    await activate(RESEND_DOCUMENT);

    const stale = (await apiProcess.get(DOMAIN, ENVIRONMENT)) as Record<string, unknown>;
    expect(stale['activeProviderKey']).toBe('outbox');
  }, 60_000);
});
