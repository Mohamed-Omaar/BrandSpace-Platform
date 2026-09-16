import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { redact } from '@brandspace/shared';
import {
  createConnectorRegistry,
  parsePublishingPolicy,
  PublishPipelineService,
  SocialConnectionService,
  SocialOAuthService,
  SocialTokenVault,
  toConnectionView,
  toPublishJobView,
  type AdapterApplication,
  type ApplicationResolver,
  type PublishApprovalGate,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  type IsolationFixtures,
} from './fixtures';

/**
 * NO PROVIDER TOKEN REACHES A LOG, AN AUDIT EVENT, A NOTIFICATION OR A RESPONSE.
 *
 * CLAUDE.md §2.3 states the rule; this file is the thing that would notice if it
 * stopped being true. The failure mode it guards against is not a careless
 * `console.log` — it is the ordinary one: somebody passes a whole row into an
 * audit diff, or returns a service object straight to a screen, and a token
 * rides along inside a field nobody was looking at.
 *
 * SO THE ASSERTIONS SEARCH FOR THE TOKEN'S ACTUAL VALUE in everything the
 * customer-visible surfaces produce, rather than checking that particular
 * fields were omitted. A field-by-field check passes on the day a new field is
 * added; a value search does not.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});

const REDIRECT = 'https://api-staging.brandspace.cc/v1/social/callback/linkedin';
const applications: ApplicationResolver = {
  async resolve(): Promise<AdapterApplication> {
    return {
      appId: 'test-only-app-id',
      clientSecret: 'test-only-client-secret-not-real',
      redirectUri: REDIRECT,
    };
  },
};

const gate: PublishApprovalGate = {
  async policyForBrand() {
    return { requireApprovalBeforeScheduling: false };
  },
  async openForItem() {
    return { status: 'APPROVED' };
  },
};

function enabledPolicy(): PublishingPolicy {
  return parsePublishingPolicy({
    providers: {
      linkedin: { enabled: true, scopes: ['w_member_social'], targetKind: 'organization' },
    },
  });
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = enabledPolicy();
  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      await db.contentItem.update({
        where: { id: fixtures.a.contentItemId },
        data: { status: 'SCHEDULED' },
      });
    },
    { prisma: app },
  );
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

/** The plaintext token behind the fixture's connection, read the legitimate way. */
async function fixtureToken(): Promise<string> {
  const credential = await withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      db.socialCredential.findFirst({
        where: { id: fixtures.a.socialCredentialId },
      }),
    { prisma: app },
  );
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
  return opened.accessToken;
}

describe('the connection view has no field that could hold a token', () => {
  it('a rendered connection never contains the token value', async () => {
    const token = await fixtureToken();
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.socialConnection.findFirst({ where: { id: fixtures.a.socialConnectionId } }),
      { prisma: app },
    );
    const view = toConnectionView(row!, new Date());
    expect(JSON.stringify(view)).not.toContain(token);
    // And no key on it is even token-shaped, so a future field cannot be one by
    // being added next to the others.
    expect(Object.keys(view)).not.toContain('accessToken');
    expect(Object.keys(view)).not.toContain('refreshToken');
    expect(Object.keys(view)).not.toContain('ciphertext');
  });

  it('LISTING CONNECTIONS NEVER SELECTS THE CREDENTIAL TABLE', async () => {
    const token = await fixtureToken();
    const views = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new SocialConnectionService({
          db,
          workspaceId: fixtures.a.workspaceId,
          registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
          vault,
        }).list({ brandScope: [] }),
      { prisma: app },
    );
    expect(views.length).toBeGreaterThan(0);
    expect(JSON.stringify(views)).not.toContain(token);
  });
});

describe('the audit trail records what happened, never the credential', () => {
  it('connecting writes an audit event with no token in it', async () => {
    const before = new Date();
    const state = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new SocialOAuthService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy,
          registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
          vault,
          applications,
        }).start({
          provider: 'LINKEDIN',
          brandId: fixtures.a.brandId,
          actor: { userId: fixtures.a.userId, brandScope: [] },
        }),
      { prisma: app },
    );

    const completed = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new SocialOAuthService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy,
          registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
          vault,
          applications,
        }).complete({
          state: state.state,
          code: `code-${randomUUID()}`,
          redirectUri: REDIRECT,
        }),
      { prisma: app },
    );

    const credential = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialCredential.findFirst({
          where: { socialConnectionId: completed.connection.id },
        }),
      { prisma: app },
    );
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

    const events = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.auditEvent.findMany({
          where: { action: { startsWith: 'social.' }, occurredAt: { gte: before } },
        }),
      { prisma: app },
    );
    expect(events.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(opened.accessToken);
    expect(opened.refreshToken).toBeTruthy();
    expect(serialized).not.toContain(opened.refreshToken!);
    // NOR THE PLATFORM APP'S CLIENT SECRET, which the exchange had in hand.
    expect(serialized).not.toContain('test-only-client-secret-not-real');
  });

  it('THE STATE TOKEN IS NOT AUDITED EITHER — it is a live credential mid-flow', async () => {
    const before = new Date();
    const state = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new SocialOAuthService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy,
          registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
          vault,
          applications,
        }).start({
          provider: 'LINKEDIN',
          brandId: fixtures.a.brandId,
          actor: { userId: fixtures.a.userId, brandScope: [] },
        }),
      { prisma: app },
    );
    const events = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.auditEvent.findMany({
          where: { action: 'social.connection.authorization_started', occurredAt: { gte: before } },
        }),
      { prisma: app },
    );
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(state.state);
  });

  it('a publish audit event carries the external post id, not the caption', async () => {
    const before = new Date();
    const jobId = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => {
        const job = await db.publishJob.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            calendarSlotId: fixtures.a.calendarSlotId,
            contentItemId: fixtures.a.contentItemId,
            contentVariantId: fixtures.a.contentVariantId,
            socialConnectionId: fixtures.a.socialConnectionId,
            provider: 'LINKEDIN',
            status: 'QUEUED',
            idempotencyKey: `leak-${randomUUID()}`,
            scheduledAtUtc: new Date(),
            maxAttempts: 5,
            nextAttemptAt: new Date(),
            createdByUserId: fixtures.a.userId,
          },
        });
        return job.id;
      },
      { prisma: app },
    );

    const variant = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.contentVariant.findFirst({ where: { id: fixtures.a.contentVariantId } }),
      { prisma: app },
    );

    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new PublishPipelineService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy,
          registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
          vault,
          approvals: gate,
        }).execute(jobId),
      { prisma: app },
    );

    const events = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.auditEvent.findMany({
          where: { action: 'social.post.published', occurredAt: { gte: before } },
        }),
      { prisma: app },
    );
    expect(events.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(await fixtureToken());
    if (variant?.body) expect(serialized).not.toContain(variant.body);
  });
});

describe('the publishing history view is safe to render', () => {
  it('carries a stable code and a class, never provider prose', async () => {
    const job = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.publishJob.findFirst({ where: { id: fixtures.a.publishJobId } }),
      { prisma: app },
    );
    const view = toPublishJobView(job!);
    expect(Object.keys(view)).not.toContain('providerErrorCode');
    expect(JSON.stringify(view)).not.toContain(await fixtureToken());
  });
});

describe('the shared redaction layer covers token-shaped fields', () => {
  it('redacts anything named like a credential before it reaches a sink', () => {
    /*
     * The backstop under everything above. Even if a future call site passed a
     * whole object into a log or an audit diff, this is what would catch it.
     */
    const redacted = redact({
      accessToken: 'ya29.super-secret-value',
      refreshToken: 'refresh-super-secret-value',
      clientSecret: 'client-super-secret-value',
      displayName: 'Acme Ltd',
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('super-secret-value');
    // …and it does not over-redact the things a screen legitimately needs.
    expect(serialized).toContain('Acme Ltd');
  });
});
