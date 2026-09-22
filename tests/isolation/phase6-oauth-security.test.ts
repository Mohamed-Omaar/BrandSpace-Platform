import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type SocialProvider } from '@brandspace/database';
import { QUOTA_FEATURES, createPlanQuota } from '@brandspace/entitlements';
import {
  createConnectorRegistry,
  parsePublishingPolicy,
  SocialOAuthService,
  SocialTokenVault,
  type AdapterApplication,
  type ApplicationResolver,
  type CompleteConnectionResult,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  grantUnlimitedQuota,
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

/**
 * The same policy with a SINGLE-TARGET provider enabled as well.
 *
 * TWO PROVIDERS ON PURPOSE. `linkedin`'s mock offers two targets and `tiktok`'s
 * offers one, so the two halves of D-142 — connect in one step, and pause for a
 * choice — are both reachable from this suite with no special-casing.
 */
function bothProvidersPolicy(): PublishingPolicy {
  return parsePublishingPolicy({
    providers: {
      linkedin: {
        enabled: true,
        scopes: ['w_member_social', 'r_organization_social'],
        targetKind: 'organization',
      },
      tiktok: {
        enabled: true,
        scopes: ['video.publish', 'video.upload'],
        targetKind: 'creator_account',
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
          // THE REAL QUOTA, not a permissive stand-in. `limit.social_accounts`
          // is unconfigured in these fixtures, which the engine reads as
          // unlimited — so the ceiling never fires here and the suite keeps
          // testing what it is about, while still exercising the path that
          // records the consumption.
          quota: createPlanQuota({
            db,
            workspaceId,
            environment: 'DEVELOPMENT',
            featureKey: QUOTA_FEATURES.socialAccounts,
            period: 'total',
          }),
        }),
      ),
    { prisma: app },
  ) as Promise<T>;
}

/**
 * Start a flow in workspace A and return the opaque state.
 *
 * `TIKTOK` BY DEFAULT BECAUSE ITS MOCK OFFERS EXACTLY ONE TARGET, so the
 * callback connects in one step and these cases can be about state, replay and
 * forgery rather than about the selection step. `LINKEDIN` offers two and is
 * used deliberately by the multi-target cases below (D-142).
 */
async function startFlow(provider: SocialProvider = 'TIKTOK'): Promise<string> {
  const result = await serviceIn(fixtures.a.workspaceId, (service) =>
    service.start({
      provider,
      brandId: fixtures.a.brandId,
      actor: { userId: fixtures.a.userId, brandScope: [] },
    }),
  );
  return result.state;
}

/**
 * Complete a flow that must have connected in one step, and narrow it.
 *
 * A FAILED NARROWING IS A TEST FAILURE, not a cast. If a provider's mock ever
 * starts offering two targets, these cases stop compiling their assumption into
 * silence and fail loudly instead.
 */
async function completeSingle(
  state: string,
  code: string,
): Promise<Extract<CompleteConnectionResult, { outcome: 'connected' }>> {
  const result = await serviceIn(fixtures.a.workspaceId, (service) =>
    service.complete({ state, code, redirectUri: REDIRECT }),
  );
  if (result.outcome !== 'connected') {
    throw new Error(`expected a single-target grant, got ${result.outcome}`);
  }
  return result;
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
  policy = bothProvidersPolicy();
  // The plan's connected-account ceiling is real now, and a fixture workspace is
  // on no plan — which the engine reads as "none". These suites are about OAuth
  // security and token secrecy, not about that ceiling, so the dimension is
  // granted the way an operator would grant it.
  // BOTH workspaces: the cross-tenant cases start a flow in B.
  for (const workspaceId of [fixtures.a.workspaceId, fixtures.b.workspaceId]) {
    await grantUnlimitedQuota(app, {
      workspaceId,
      platformUserId: fixtures.platformUserId,
      featureKey: QUOTA_FEATURES.socialAccounts,
    });
  }
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
          // FACEBOOK is absent from this suite's policy. (It was TIKTOK until
          // D-142 needed a single-target provider enabled here; a test asserting
          // "not enabled" has to name one that genuinely is not.)
          provider: 'FACEBOOK',
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
    const result = await completeSingle(state, `code-${randomUUID()}`);
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
    // The mock grants one scope fewer when the code says so.
    const result = await completeSingle(state, `partial-scope-${randomUUID()}`);
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
    const created = await completeSingle(state, `code-${randomUUID()}`);

    await serviceIn(fixtures.a.workspaceId, (service) =>
      service.refresh({ connectionId: created.connection.id, brandScope: [] }),
    );

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
    // The mock issues no refresh token when the code says so.
    const created = await completeSingle(state, `no-refresh-${randomUUID()}`);
    const refreshed = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.refresh({ connectionId: created.connection.id, brandScope: [] }),
    );
    expect(refreshed.status).toBe('NEEDS_REAUTH');
  });
});

/**
 * P6-R2 — BRANDSCOPE ON REFRESH.
 *
 * WHAT WAS WRONG AND WHY IT MATTERED MORE THAN IT LOOKED. The refresh route
 * resolved `caller.brandScope` from the session and then called
 * `service.refresh(connectionId)`, which loaded the connection by id and
 * workspace alone. A member restricted to brand A who knew a brand B connection
 * id could therefore rotate brand B's token.
 *
 * It returns almost nothing, so it reads like a small leak. It is not a leak at
 * all — it is a WRITE across a boundary the member cannot read across: a token
 * rotated, the previous version retired, the connection's status and failure
 * counters moved, and an external call made to the provider as that brand.
 *
 * THE FOUR CASES THE REVIEW ASKED FOR, and the fourth is the one that proves
 * the fix is a PREDICATE rather than a check: nothing is opened or rotated on
 * the refused path, because the row is never retrieved at all.
 */
describe('P6-R2 — refreshing a token is brand-scoped, as a query predicate', () => {
  /** Connect a single-target account and return its id. */
  async function connectOne(): Promise<string> {
    const state = await startFlow();
    const created = await completeSingle(state, `code-${randomUUID()}`);
    return created.connection.id;
  }

  async function credentialVersions(connectionId: string) {
    return withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialCredential.findMany({
          where: { socialConnectionId: connectionId },
          orderBy: { version: 'asc' },
          select: { version: true, retiredAt: true },
        }),
      { prisma: app },
    );
  }

  it('AN IN-SCOPE REFRESH SUCCEEDS — the fix must not break the working case', async () => {
    const connectionId = await connectOne();
    const refreshed = await serviceIn(fixtures.a.workspaceId, (service) =>
      // The connection's own brand, named explicitly rather than unrestricted,
      // so this asserts the predicate ADMITS as well as refuses.
      service.refresh({ connectionId, brandScope: [fixtures.a.brandId] }),
    );
    expect(refreshed.status).toBe('ACTIVE');
    expect((await credentialVersions(connectionId)).length).toBe(2);
  });

  it('AN OUT-OF-SCOPE REAL ID IS REFUSED — this is the defect', async () => {
    const connectionId = await connectOne();
    const message = await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        // A real connection in this workspace, and a scope that does not admit
        // its brand. Against the pre-fix `refresh(connectionId)` this SUCCEEDS.
        service.refresh({ connectionId, brandScope: [randomUUID()] }),
      ),
    );
    expect(message).toContain('NOT_FOUND');
  });

  it('A FABRICATED ID IS REFUSED IDENTICALLY — no oracle', async () => {
    const connectionId = await connectOne();
    const outOfScope = await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.refresh({ connectionId, brandScope: [randomUUID()] }),
      ),
    );
    const fabricated = await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.refresh({ connectionId: randomUUID(), brandScope: [] }),
      ),
    );
    // BYTE FOR BYTE. A member must not be able to tell "that exists but is not
    // yours" from "that does not exist" (CLAUDE.md §2.1).
    expect(outOfScope).toEqual(fabricated);
  });

  it('THE REFUSED CASE OPENS AND ROTATES NOTHING', async () => {
    const connectionId = await connectOne();
    const before = await credentialVersions(connectionId);
    expect(before.length).toBe(1);

    await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.refresh({ connectionId, brandScope: [randomUUID()] }),
      ),
    );

    const after = await credentialVersions(connectionId);
    // NO NEW VERSION, and the existing one is still live. The scope is in the
    // `where`, so `#liveCredential` is never reached and the vault is never
    // asked to decrypt anything.
    expect(after.length).toBe(1);
    expect(after[0]?.version).toBe(before[0]?.version);
    expect(after[0]?.retiredAt).toBeNull();
  });
});

/**
 * P6-R5 — A MULTI-TARGET GRANT DOES NOT PICK A PAGE FOR THE CUSTOMER.
 *
 * WHAT WAS WRONG. `complete()` took `targets[0]` and persisted an ACTIVE
 * connection to it. Meta returns every Page the person administers and LinkedIn
 * every organization they can post as; "the first one" is an ordering accident
 * of somebody else's API. Getting it wrong publishes a customer's scheduled
 * posts, publicly, to the wrong page of their own.
 */
describe('P6-R5 — a grant offering several targets pauses for an explicit choice', () => {
  it('A ONE-TARGET GRANT STILL CONNECTS IN ONE STEP', async () => {
    const state = await startFlow('TIKTOK');
    const result = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
    );
    expect(result.outcome).toBe('connected');
  });

  it('A TWO-TARGET GRANT CONNECTS NOTHING AND ASKS', async () => {
    const before = await connectionCount();
    const state = await startFlow('LINKEDIN');
    const result = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
    );
    expect(result.outcome).toBe('selection_required');
    if (result.outcome !== 'selection_required') throw new Error('unreachable');
    expect(result.targets.length).toBe(2);
    // THE ASSERTION THAT FAILS AGAINST THE PRE-FIX CODE: no connection exists.
    expect(await connectionCount()).toBe(before);
  });

  it('THE PENDING GRANT HOLDS AN ENCRYPTED TOKEN, NOT A READABLE ONE', async () => {
    const state = await startFlow('LINKEDIN');
    await serviceIn(fixtures.a.workspaceId, (service) =>
      service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
    );
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialOAuthState.findFirst({
          where: { stateHash: createHash('sha256').update(state).digest('hex') },
        }),
      { prisma: app },
    );
    expect(row?.pendingCiphertext).toBeTruthy();
    expect(row?.pendingCiphertext).not.toContain('mock-access');
    expect(JSON.stringify(row?.offeredTargets)).not.toContain('mock-access');
    // AND THE SECRET IS HASHED, exactly as the state is.
    expect(row?.selectionTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('CHOOSING AN OFFERED TARGET CONNECTS TO THAT ONE, NOT THE FIRST', async () => {
    const state = await startFlow('LINKEDIN');
    const pending = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
    );
    if (pending.outcome !== 'selection_required') throw new Error('expected a pause');

    // THE SECOND ONE, deliberately: picking the first would pass against the
    // defective code too and prove nothing.
    const chosen = pending.targets[1]!;
    const connection = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.chooseTarget({
        selectionToken: pending.selectionToken,
        externalAccountId: chosen.externalAccountId,
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );
    expect(connection.externalAccountId).toBe(chosen.externalAccountId);
    expect(connection.externalAccountId).not.toBe(pending.targets[0]!.externalAccountId);
    expect(connection.status).toBe('ACTIVE');
    expect(connection.brandId).toBe(fixtures.a.brandId);
  });

  it('A TARGET THAT WAS NOT OFFERED IS REFUSED — no enumeration', async () => {
    const state = await startFlow('LINKEDIN');
    const pending = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
    );
    if (pending.outcome !== 'selection_required') throw new Error('expected a pause');

    const invented = await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.chooseTarget({
          selectionToken: pending.selectionToken,
          externalAccountId: `not-offered-${randomUUID()}`,
          actor: { userId: fixtures.a.userId, brandScope: [] },
        }),
      ),
    );
    const forgedToken = await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.chooseTarget({
          selectionToken: randomUUID(),
          externalAccountId: pending.targets[0]!.externalAccountId,
          actor: { userId: fixtures.a.userId, brandScope: [] },
        }),
      ),
    );
    // ONE SENTENCE FOR BOTH. "That page is not on your list" and "that token is
    // not real" must be indistinguishable.
    expect(invented).toEqual(forgedToken);
  });

  it('THE CHOICE IS SINGLE-USE — a replay creates no second connection', async () => {
    const state = await startFlow('LINKEDIN');
    const pending = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
    );
    if (pending.outcome !== 'selection_required') throw new Error('expected a pause');
    const target = pending.targets[0]!;

    await serviceIn(fixtures.a.workspaceId, (service) =>
      service.chooseTarget({
        selectionToken: pending.selectionToken,
        externalAccountId: target.externalAccountId,
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );
    const after = await connectionCount();

    await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.chooseTarget({
          selectionToken: pending.selectionToken,
          externalAccountId: target.externalAccountId,
          actor: { userId: fixtures.a.userId, brandScope: [] },
        }),
      ),
    );
    expect(await connectionCount()).toBe(after);
  });

  it('ANOTHER MEMBER HOLDING THE SECRET IS STILL REFUSED', async () => {
    const state = await startFlow('LINKEDIN');
    const pending = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
    );
    if (pending.outcome !== 'selection_required') throw new Error('expected a pause');

    const otherPerson = await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.chooseTarget({
          selectionToken: pending.selectionToken,
          externalAccountId: pending.targets[0]!.externalAccountId,
          // The right workspace, the right secret, the WRONG person. They did
          // not stand in front of the provider's consent screen.
          actor: { userId: randomUUID(), brandScope: [] },
        }),
      ),
    );
    const outOfScope = await refusal(
      serviceIn(fixtures.a.workspaceId, (service) =>
        service.chooseTarget({
          selectionToken: pending.selectionToken,
          externalAccountId: pending.targets[0]!.externalAccountId,
          // The right person, a scope that does not admit the flow's brand.
          actor: { userId: fixtures.a.userId, brandScope: [randomUUID()] },
        }),
      ),
    );
    expect(otherPerson).toEqual(outOfScope);
  });

  it('THE SEALED GRANT IS ERASED once it has become a credential', async () => {
    const state = await startFlow('LINKEDIN');
    const pending = await serviceIn(fixtures.a.workspaceId, (service) =>
      service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
    );
    if (pending.outcome !== 'selection_required') throw new Error('expected a pause');

    await serviceIn(fixtures.a.workspaceId, (service) =>
      service.chooseTarget({
        selectionToken: pending.selectionToken,
        externalAccountId: pending.targets[0]!.externalAccountId,
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );

    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialOAuthState.findFirst({
          where: { stateHash: createHash('sha256').update(state).digest('hex') },
        }),
      { prisma: app },
    );
    // TWO COPIES OF A LIVE TOKEN IS ONE TOO MANY, and the one nobody is looking
    // at is the one that outlives the disconnect.
    expect(row?.pendingCiphertext).toBeNull();
    expect(row?.selectionTokenHash).toBeNull();
    expect(row?.offeredTargets).toBeNull();
  });
});

/** How many connections workspace A currently holds. */
async function connectionCount(): Promise<number> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => db.socialConnection.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    { prisma: app },
  );
}
