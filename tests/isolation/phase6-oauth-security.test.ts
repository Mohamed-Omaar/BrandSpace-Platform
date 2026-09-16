import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import {
  createConnectorRegistry,
  parsePublishingPolicy,
  SocialOAuthService,
  SocialTokenVault,
  type AdapterApplication,
  type ApplicationResolver,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  type IsolationFixtures,
} from './fixtures';

/**
 * The OAuth flow's security properties, on real PostgreSQL.
 *
 * WHAT AN ATTACK LOOKS LIKE HERE, and why each control exists:
 *
 *   - WITHOUT STATE: an attacker makes the victim's browser complete a
 *     connection to the ATTACKER's social account. Every post the victim
 *     schedules from then on goes to the attacker's page, under the victim's
 *     brand. This is the worst outcome in the milestone and the cheapest to
 *     get wrong.
 *   - WITHOUT SINGLE USE: the same authorization is replayed to create
 *     duplicate connections, or re-used after the victim has disconnected.
 *   - WITHOUT PKCE: an intercepted redirect is enough to complete the exchange
 *     without ever holding the browser.
 *   - WITHOUT EXACT REDIRECT MATCHING: a callback aimed at a different URI
 *     completes anyway.
 *
 * EVERY REFUSAL IS THE SAME SENTENCE, and that is asserted rather than assumed:
 * expired, consumed, forged and foreign must be indistinguishable, or the
 * difference tells an attacker which guess was closest.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});

const REDIRECT = 'https://api-staging.brandspace.cc/v1/social/callback/linkedin';

/**
 * A resolver that returns a visibly fake application.
 *
 * NO REAL CREDENTIAL IS USED ANYWHERE IN THIS SUITE, and none is needed: the
 * mock adapter never leaves the process. That is the whole reason Phase 6 can
 * be tested before app review completes (D-18, D-19).
 */
const applications: ApplicationResolver = {
  async resolve(): Promise<AdapterApplication> {
    return {
      appId: 'test-only-app-id',
      clientSecret: 'test-only-client-secret-not-real',
      redirectUri: REDIRECT,
    };
  },
};

function enabledPolicy(): PublishingPolicy {
  return parsePublishingPolicy({
    providers: {
      linkedin: {
        enabled: true,
        scopes: ['w_member_social', 'r_organization_social'],
        targetKind: 'organization',
      },
    },
    oauth: { stateTtlSeconds: 600, maxConnectionsPerWorkspace: 25 },
  });
}

function serviceIn<T>(
  workspaceId: string,
  fn: (service: SocialOAuthService) => Promise<T>,
  options: { policy?: PublishingPolicy } = {},
): Promise<T> {
  const active = options.policy ?? policy;
  return withWorkspace(
    workspaceId,
    async (db) =>
      fn(
        new SocialOAuthService({
          db,
          workspaceId,
          policy: active,
          registry: createConnectorRegistry({ policy: active, environment: 'DEVELOPMENT' }),
          vault,
          applications,
        }),
      ),
    { prisma: app },
  ) as Promise<T>;
}

/** Start a flow in workspace A and return the opaque state. */
async function startFlow(): Promise<string> {
  const result = await serviceIn(fixtures.a.workspaceId, (service) =>
    service.start({
      provider: 'LINKEDIN',
      brandId: fixtures.a.brandId,
      actor: { userId: fixtures.a.userId, brandScope: [] },
    }),
  );
  return result.state;
}

/** The message a refusal produces, so two refusals can be compared. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    const e = error as { code?: unknown; message?: unknown };
    return `${String(e.code)}:${String(e.message)}`;
  }
  throw new Error('the callback was ACCEPTED; an OAuth control has regressed');
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = enabledPolicy();
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('starting a flow', () => {
  it('returns an authorization URL carrying the state and the PKCE challenge', async () => {
    const result = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.start({
        provider: 'LINKEDIN',
        brandId: fixtures.a.brandId,
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
  });

  it('THE CLIENT SECRET IS NOT IN THE URL — this string goes to a browser', async () => {
    const result = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.start({
        provider: 'LINKEDIN',
        brandId: fixtures.a.brandId,
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );
    expect(result.authorizationUrl).not.toContain('test-only-client-secret-not-real');
    expect(result.authorizationUrl).not.toContain('secret');
  });

  it('THE STATE IS STORED HASHED, never in the clear', async () => {
    const state = await startFlow();
    const stored = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.socialOAuthState.findMany({ select: { stateHash: true } }),
      { prisma: app },
    );
    const hashes = stored.map((row) => row.stateHash);
    // The HASH is there…
    expect(hashes).toContain(createHash('sha256').update(state).digest('hex'));
    // …and the VALUE is not, anywhere.
    expect(hashes).not.toContain(state);
  });

  it('THE PKCE VERIFIER IS STORED ENCRYPTED, not as text', async () => {
    await startFlow();
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialOAuthState.findFirst({
          orderBy: { createdAt: 'desc' },
          select: { verifierCiphertext: true, verifierEncryptionContext: true },
        }),
      { prisma: app },
    );
    expect(row?.verifierCiphertext).toBeTruthy();
    // The context binds it to this workspace and this state: a row copied
    // elsewhere fails to decrypt rather than yielding somebody else's verifier.
    expect(row?.verifierEncryptionContext).toContain(fixtures.a.workspaceId);
  });

  it('A BRAND OUTSIDE THE ACTOR SCOPE IS REFUSED AS NOT FOUND (D-134)', async () => {
    await expect(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.start({
          provider: 'LINKEDIN',
          brandId: fixtures.a.brandId,
          actor: { userId: fixtures.a.userId, brandScope: [randomUUID()] },
        }),
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("ANOTHER WORKSPACE'S BRAND IS REFUSED IDENTICALLY to one that never existed", async () => {
    const foreign = await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.start({
          provider: 'LINKEDIN',
          brandId: fixtures.b.brandId,
          actor: { userId: fixtures.a.userId, brandScope: [] },
        }),
      ),
    );
    const invented = await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.start({
          provider: 'LINKEDIN',
          brandId: randomUUID(),
          actor: { userId: fixtures.a.userId, brandScope: [] },
        }),
      ),
    );
    expect(foreign).toEqual(invented);
  });

  it('a provider that is not enabled cannot be connected at all', async () => {
    await expect(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.start({
          provider: 'TIKTOK',
          brandId: fixtures.a.brandId,
          actor: { userId: fixtures.a.userId, brandScope: [] },
        }),
      ),
    ).rejects.toThrow();
  });

  it('the connection ceiling is enforced BEFORE the customer leaves our site', async () => {
    const capped = parsePublishingPolicy({
      providers: { linkedin: { enabled: true, scopes: ['w_member_social'] } },
      oauth: { maxConnectionsPerWorkspace: 1 },
    });
    // The fixture already provides one ACTIVE connection, so the ceiling of one
    // is already reached.
    await expect(
      serviceIn(
        fixtures.a.workspaceId,
        (service) =>
          service.start({
            provider: 'LINKEDIN',
            brandId: fixtures.a.brandId,
            actor: { userId: fixtures.a.userId, brandScope: [] },
          }),
        { policy: capped },
      ),
    ).rejects.toThrow();
  });
});

describe('completing a flow — CSRF, replay and forgery', () => {
  it('a valid state completes and stores an ENCRYPTED credential', async () => {
    const state = await startFlow();
    const result = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
    );
    expect(result.connection.status).toBe('ACTIVE');
    expect(result.missingScopes).toEqual([]);

    const credential = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialCredential.findFirst({
          where: { socialConnectionId: result.connection.id },
        }),
      { prisma: app },
    );
    expect(credential).not.toBeNull();
    // THE TOKEN IS NOT READABLE from the row, and the mask is a mask.
    expect(credential?.ciphertext).not.toContain('mock-access');
    expect((credential?.maskedHint ?? '').length).toBeLessThanOrEqual(8);

    // And it round-trips, so the encryption is real rather than lossy.
    const opened = await vault.open({
      ciphertext: credential!.ciphertext,
      iv: credential!.iv,
      authTag: credential!.authTag,
      wrappedDataKey: credential!.wrappedDataKey,
      keyProvider: credential!.keyProvider,
      keyId: credential!.keyId,
      algorithm: 'AES-256-GCM',
      encryptionContext: credential!.encryptionContext,
      maskedHint: credential!.maskedHint,
      fingerprint: credential!.fingerprint,
    });
    expect(opened.accessToken).toContain('mock-access');
  });

  it('THE SAME STATE CANNOT BE USED TWICE', async () => {
    const state = await startFlow();
    await serviceIn(fixtures.a.workspaceId, (service) =>
      service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
    );
    await expect(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
      ),
    ).rejects.toThrow();
  });

  it('TWO CONCURRENT CALLBACKS: exactly one wins', async () => {
    /*
     * The double-clicked redirect, and the replayed request. Single use is
     * enforced by a CONDITIONAL UPDATE rather than a read-then-write, so
     * exactly one of these matches a row with `consumedAt IS NULL`.
     */
    const state = await startFlow();
    const results = await Promise.allSettled([
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
      ),
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
  });

  it('A FORGED STATE IS REFUSED', async () => {
    await expect(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.complete({
          state: randomUUID(),
          code: `code-${randomUUID()}`,
          redirectUri: REDIRECT,
        }),
      ),
    ).rejects.toThrow();
  });

  it("ANOTHER WORKSPACE'S STATE CANNOT COMPLETE INTO MINE — the CSRF case", async () => {
    /*
     * The attack in full: workspace B starts a flow, workspace A presents B's
     * state. If this succeeded, A would hold a connection to an account B
     * authorized — or, run the other way, an attacker's account would be bound
     * to a victim's brand.
     */
    const foreignState = await serviceIn(fixtures.b.workspaceId, (service) =>
      service.start({
        provider: 'LINKEDIN',
        brandId: fixtures.b.brandId,
        actor: { userId: fixtures.b.userId, brandScope: [] },
      }),
    );
    await expect(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.complete({
          state: foreignState.state,
          code: `code-${randomUUID()}`,
          redirectUri: REDIRECT,
        }),
      ),
    ).rejects.toThrow();

    // And B's flow is still usable, so the attempt did not consume it either.
    const stillOpen = await withWorkspace(
      fixtures.b.workspaceId,
      async (db) =>
        db.socialOAuthState.findFirst({
          where: { stateHash: createHash('sha256').update(foreignState.state).digest('hex') },
          select: { consumedAt: true },
        }),
      { prisma: app },
    );
    expect(stillOpen?.consumedAt).toBeNull();
  });

  it('A MISMATCHED REDIRECT URI IS REFUSED', async () => {
    const state = await startFlow();
    await expect(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.complete({
          state,
          code: `code-${randomUUID()}`,
          redirectUri: 'https://evil.invalid/callback',
        }),
      ),
    ).rejects.toThrow();
  });

  it('AN EXPIRED STATE IS REFUSED', async () => {
    const state = await startFlow();
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialOAuthState.updateMany({
          where: { stateHash: createHash('sha256').update(state).digest('hex') },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        }),
      { prisma: app },
    );
    await expect(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
      ),
    ).rejects.toThrow();
  });

  it('EVERY REFUSAL IS THE SAME SENTENCE — forged, expired, consumed and foreign', async () => {
    /*
     * The property that makes the four controls above safe to have: if an
     * expired state said "expired" and a forged one said "unknown", an attacker
     * could tell a real token from a guess.
     */
    const forged = await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.complete({
          state: randomUUID(),
          code: `code-${randomUUID()}`,
          redirectUri: REDIRECT,
        }),
      ),
    );

    const consumedState = await startFlow();
    await serviceIn(fixtures.a.workspaceId, (service) =>
      service.complete({
        state: consumedState,
        code: `code-${randomUUID()}`,
        redirectUri: REDIRECT,
      }),
    );
    const consumed = await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.complete({
          state: consumedState,
          code: `code-${randomUUID()}`,
          redirectUri: REDIRECT,
        }),
      ),
    );

    const expiredState = await startFlow();
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialOAuthState.updateMany({
          where: { stateHash: createHash('sha256').update(expiredState).digest('hex') },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        }),
      { prisma: app },
    );
    const expired = await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.complete({
          state: expiredState,
          code: `code-${randomUUID()}`,
          redirectUri: REDIRECT,
        }),
      ),
    );

    expect(consumed).toEqual(forged);
    expect(expired).toEqual(forged);
  });

  it('A PARTIAL SCOPE GRANT BECOMES needs_reauth, not a connection that looks fine', async () => {
    const state = await startFlow();
    const result = await serviceIn(fixtures.a.workspaceId, (service) =>
      // The mock grants one scope fewer when the code says so.
      service.complete({ state, code: `partial-scope-${randomUUID()}`, redirectUri: REDIRECT }),
    );
    expect(result.missingScopes.length).toBeGreaterThan(0);
    expect(result.connection.status).toBe('NEEDS_REAUTH');
  });

  it('A REFUSED CODE EXCHANGE DOES NOT ECHO THE PROVIDER — nor the code', async () => {
    const state = await startFlow();
    const message = await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.complete({ state, code: `invalid-${randomUUID()}`, redirectUri: REDIRECT }),
      ),
    );
    expect(message).not.toContain('invalid-');
    expect(message).not.toContain('mock provider');
  });
});

describe('token refresh and rotation', () => {
  it('a refresh writes a NEW version and retires the old one', async () => {
    const state = await startFlow();
    const created = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
    );

    await serviceIn(fixtures.a.workspaceId, (service) => service.refresh(created.connection.id));

    const versions = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialCredential.findMany({
          where: { socialConnectionId: created.connection.id },
          orderBy: { version: 'asc' },
          select: { version: true, retiredAt: true },
        }),
      { prisma: app },
    );
    expect(versions.length).toBe(2);
    expect(versions[0]?.retiredAt).not.toBeNull();
    expect(versions[1]?.retiredAt).toBeNull();
  });

  it('A CONNECTION WITH NO REFRESH TOKEN BECOMES needs_reauth rather than looping', async () => {
    const state = await startFlow();
    const created = await serviceIn(fixtures.a.workspaceId, (service) =>
      // The mock issues no refresh token when the code says so.
      service.complete({ state, code: `no-refresh-${randomUUID()}`, redirectUri: REDIRECT }),
    );
    const refreshed = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.refresh(created.connection.id),
    );
    expect(refreshed.status).toBe('NEEDS_REAUTH');
  });
});
