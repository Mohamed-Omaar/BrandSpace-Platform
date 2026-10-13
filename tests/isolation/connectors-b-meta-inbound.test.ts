import { createHmac, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { SecretService } from '@brandspace/secrets';
import { subjectHash } from '@brandspace/social-connectors';
import { captureConfig, type ActivatedConfig } from './config-activation';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import { processSocialInboundEvents } from '../../apps/api/src/social-inbound';

/**
 * CONNECTORS B — META'S WEBHOOK, DEAUTHORIZE AND DATA-DELETION ADDRESSES,
 * END TO END against real PostgreSQL (D-533): through the API's own routes,
 * with a Meta app configured exactly as the Control Center saves one (secret
 * references resolved by the Secret Service, two subject-hash key versions),
 * then through the maintenance sweep.
 *
 *   - nothing Meta did not sign is written;
 *   - a redelivery is the same row, and the same confirmation code;
 *   - a deauthorize finds the person's connections in EVERY workspace, under
 *     EVERY listed key version, and revokes each inside its own workspace;
 *   - a data deletion also erases what Meta gave us about the account and
 *     keeps the customer's own content; its status page says so;
 *   - nobody else's connection is touched, and the raw user id is stored
 *     nowhere.
 */

const ENV = 'DEVELOPMENT' as const;
const BASE = 'https://api.example.test';
const APP_SECRET = `test-app-secret-${randomUUID()}`;
const VERIFY_TOKEN = `test-verify-token-${randomUUID()}`;
const KEY_V1 = `test-subject-key-1-${randomUUID()}`;
const KEY_V2 = `test-subject-key-2-${randomUUID()}`;

type Server = {
  inject(options: Record<string, unknown>): Promise<{
    statusCode: number;
    body: string;
    headers: Record<string, unknown>;
  }>;
  close(): Promise<unknown>;
  ready(): Promise<unknown>;
};

let server: Server;
let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let socialApps: ActivatedConfig;

const base64Url = (value: Buffer | string) =>
  Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function signedRequest(userId: string, secret = APP_SECRET): string {
  const encoded = base64Url(
    JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: 1_760_000_000, user_id: userId }),
  );
  return `${base64Url(createHmac('sha256', secret).update(encoded).digest())}.${encoded}`;
}

const form = (value: string) => `signed_request=${encodeURIComponent(value)}`;

const post = (url: string, payload: string, headers: Record<string, string>) =>
  server.inject({ method: 'POST', url, payload, headers });

async function sweep(options: { maxAttempts?: number; failIn?: string } = {}) {
  return processSocialInboundEvents({
    platform,
    inWorkspace: (workspaceId, fn) => {
      if (options.failIn === workspaceId) throw new Error('simulated workspace failure');
      return withWorkspace(workspaceId, fn, { prisma: app });
    },
    environment: ENV,
    now: new Date(),
    batchSize: 50,
    maxAttempts: options.maxAttempts ?? 10,
    leaseSeconds: 300,
  });
}

/** A Meta connection for `userId`, hashed under key `version`, in a workspace. */
async function metaConnection(
  side: 'a' | 'b',
  provider: 'FACEBOOK' | 'INSTAGRAM',
  userId: string,
  version: 1 | 2,
) {
  const world = fixtures[side];
  return withWorkspace(
    world.workspaceId,
    async (db) => {
      const connection = await db.socialConnection.create({
        data: {
          workspaceId: world.workspaceId,
          brandId: world.brandId,
          provider,
          externalAccountId: `meta-${randomUUID()}`,
          displayName: 'The Real Page Name',
          avatarUrl: 'https://example.test/avatar.png',
          targetKind: provider === 'FACEBOOK' ? 'page' : 'business_account',
          status: 'ACTIVE',
          grantedScopes: ['pages_manage_posts'],
          connectedByUserId: world.userId,
          connectedAt: new Date(),
          providerSubjectHash: subjectHash(userId, {
            version,
            secret: version === 1 ? KEY_V1 : KEY_V2,
          }),
        },
      });
      const periodStart = new Date('2026-09-01T00:00:00Z');
      const periodEnd = new Date('2026-09-02T00:00:00Z');
      await db.metricObservation.create({
        data: {
          workspaceId: world.workspaceId,
          brandId: world.brandId,
          socialConnectionId: connection.id,
          provider,
          subjectType: 'ACCOUNT',
          subjectExternalId: connection.externalAccountId,
          metricKey: 'impressions',
          granularity: 'DAY',
          periodStart,
          periodEnd,
          value: BigInt(42),
          unit: 'COUNT',
          observedAt: periodEnd,
          sourceKind: 'PROVIDER',
          sourceVersion: 'test-meta-1',
          observationKey: `test-${randomUUID()}`,
        },
      });
      return connection;
    },
    { prisma: app },
  );
}

const stateOf = (side: 'a' | 'b', connectionId: string) =>
  withWorkspace(
    fixtures[side].workspaceId,
    async (db) => ({
      connection: await db.socialConnection.findUniqueOrThrow({
        where: { id: connectionId },
        select: {
          status: true,
          displayName: true,
          avatarUrl: true,
          externalAccountId: true,
          providerSubjectHash: true,
          grantedScopes: true,
        },
      }),
      observations: await db.metricObservation.count({
        where: { socialConnectionId: connectionId },
      }),
      audits: (
        await db.auditEvent.findMany({
          where: { resourceId: connectionId },
          select: { action: true, actorType: true },
        })
      )
        .map((row) => `${row.actorType}:${row.action}`)
        .sort(),
    }),
    { prisma: app },
  );

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);

  const secrets = new SecretService({ prisma: platform });
  const actor = {
    platformUserId: (await platform.platformUser.findFirstOrThrow()).id,
    roleKey: 'platform_owner',
    mfaVerified: true,
    permissionKeys: ['platform.secret.manage', 'platform.secret.read'],
  };
  const ref = (name: string) => `integration/social/facebook/development/${name}-${randomUUID()}`;
  const refs = {
    clientSecret: ref('clientSecret'),
    webhookSecret: ref('webhookSecret'),
    keyV1: ref('subject-v1'),
    keyV2: ref('subject-v2'),
  };
  for (const [key, value] of [
    ['clientSecret', APP_SECRET],
    ['webhookSecret', VERIFY_TOKEN],
    ['keyV1', KEY_V1],
    ['keyV2', KEY_V2],
  ] as const) {
    await secrets.createSecret(actor, {
      ref: refs[key],
      name: `Connectors B test ${key}`,
      category: 'social_oauth_app',
      environment: ENV,
      value,
    });
  }
  socialApps = await captureConfig(platform, 'integrations.social-apps', { projected: false });
  await socialApps.activate({
    applications: [
      {
        providerKey: 'facebook',
        appId: '900000000000001',
        redirectUri: `${BASE}/v1/social/callback/facebook`,
        scopes: [],
        clientSecretRef: refs.clientSecret,
        webhookSecretRef: refs.webhookSecret,
        status: 'active',
        settings: {},
        sharesCredentialWith: null,
      },
    ],
    subjectHashKeys: [
      { version: 1, secretRef: refs.keyV1 },
      { version: 2, secretRef: refs.keyV2 },
    ],
    subjectHashVersion: 2,
  });

  vi.stubEnv('PUBLIC_API_BASE_URL', BASE);
  vi.resetModules();
  const { buildServer } = await import('../../apps/api/src/server');
  server = (await buildServer()) as unknown as Server;
  await server.ready();
}, 120_000);

afterAll(async () => {
  try {
    await socialApps?.restore();
  } finally {
    await server?.close();
    await app?.$disconnect();
    await platform?.$disconnect();
    vi.unstubAllEnvs();
  }
});

describe('the webhook address', () => {
  const body = () =>
    Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: randomUUID(), time: 1 }] }));
  const signature = (bytes: Buffer, secret = APP_SECRET) =>
    `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;

  it('answers the subscription check only with the owner’s verify token', async () => {
    const ask = (token: string) =>
      server.inject({
        method: 'GET',
        url: `/v1/social/webhooks/facebook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1158201444`,
      });
    const ok = await ask(VERIFY_TOKEN);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');
    expect((await ask('a-guess')).statusCode).toBe(403);
  });

  it('writes nothing Meta did not sign; a signed delivery is one row, however often it arrives', async () => {
    const bytes = body();
    const before = await platform.socialInboundEvent.count();
    const forged = await post('/v1/social/webhooks/facebook', bytes.toString(), {
      'content-type': 'application/json',
      'x-hub-signature-256': signature(bytes, 'not-the-app-secret'),
    });
    expect(forged.statusCode).toBe(403);
    expect(await platform.socialInboundEvent.count()).toBe(before);

    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await post('/v1/social/webhooks/facebook', bytes.toString(), {
        'content-type': 'application/json',
        'x-hub-signature-256': signature(bytes),
      });
      expect(response.statusCode).toBe(200);
    }
    expect(await platform.socialInboundEvent.count()).toBe(before + 1);

    // No field is subscribed in step B: the sweep sets it aside, kept as evidence.
    await sweep();
    const row = await platform.socialInboundEvent.findFirstOrThrow({
      where: { kind: 'WEBHOOK' },
      orderBy: { receivedAt: 'desc' },
    });
    expect(row).toMatchObject({ status: 'IGNORED', failureCode: 'inbound.no_subscribed_field' });
  });
});

describe('the deauthorize address', () => {
  it('refuses an unsigned request and writes nothing', async () => {
    const before = await platform.socialInboundEvent.count();
    const response = await post(
      '/v1/social/deauthorize/facebook',
      form(signedRequest('10229999000000777', 'not-the-app-secret')),
      { 'content-type': 'application/x-www-form-urlencoded' },
    );
    expect(response.statusCode).toBe(403);
    expect(await platform.socialInboundEvent.count()).toBe(before);
  });

  it('revokes the person’s connections in every workspace, under every key version — and nothing else', async () => {
    const person = `1022${Date.now()}`;
    const inA = await metaConnection('a', 'FACEBOOK', person, 1); // an older key version
    const inB = await metaConnection('b', 'INSTAGRAM', person, 2);
    const someoneElse = await metaConnection('a', 'FACEBOOK', `${person}9`, 2);

    const response = await post('/v1/social/deauthorize/facebook', form(signedRequest(person)), {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(response.statusCode).toBe(200);

    const event = await platform.socialInboundEvent.findFirstOrThrow({
      where: {
        kind: 'DEAUTHORIZE',
        subjectHash: subjectHash(person, { version: 2, secret: KEY_V2 }),
      },
    });
    // The raw id is stored nowhere: only the current-version hash and the ids found.
    expect(JSON.stringify(event)).not.toContain(person);
    expect(
      (event.payload as { connections: { connectionId: string }[] }).connections
        .map((entry) => entry.connectionId)
        .sort(),
    ).toEqual([inA.id, inB.id].sort());

    expect(await sweep()).toBeGreaterThanOrEqual(1);
    for (const [side, id] of [
      ['a', inA.id],
      ['b', inB.id],
    ] as const) {
      const after = await stateOf(side, id);
      expect(after.connection).toMatchObject({ status: 'REVOKED', grantedScopes: [] });
      // A deauthorize revokes; it does not erase.
      expect(after.connection.displayName).toBe('The Real Page Name');
      expect(after.observations).toBe(1);
      expect(after.audits).toEqual(['SYSTEM:social.connection.removed_at_platform']);
    }
    expect((await stateOf('a', someoneElse.id)).connection.status).toBe('ACTIVE');
    expect(
      (await platform.socialInboundEvent.findUniqueOrThrow({ where: { id: event.id } })).status,
    ).toBe('PROCESSED');

    // A second pass, and a redelivery, change nothing.
    await post('/v1/social/deauthorize/facebook', form(signedRequest(person)), {
      'content-type': 'application/x-www-form-urlencoded',
    });
    await sweep();
    expect((await stateOf('a', inA.id)).audits).toHaveLength(1);
  });
});

describe('the data-deletion address', () => {
  it('answers Meta’s documented shape; a redelivery gets the same code', async () => {
    const person = `2033${Date.now()}`;
    await metaConnection('a', 'FACEBOOK', person, 2);
    const ask = () =>
      post('/v1/social/data-deletion/facebook', form(signedRequest(person)), {
        'content-type': 'application/x-www-form-urlencoded',
      });
    const first = await ask();
    expect(first.statusCode).toBe(200);
    const answer = JSON.parse(first.body) as { url: string; confirmation_code: string };
    expect(Object.keys(answer).sort()).toEqual(['confirmation_code', 'url']);
    expect(answer.confirmation_code).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(answer.url).toBe(
      `${BASE}/v1/social/data-deletion/facebook/status/${answer.confirmation_code}`,
    );
    expect(JSON.parse((await ask()).body)).toEqual(answer);
    expect(
      await platform.socialDataDeletionRequest.count({
        where: { confirmationCode: answer.confirmation_code },
      }),
    ).toBe(1);
  });

  it('erases what Meta gave us about the account, keeps the row, and says COMPLETED', async () => {
    const person = `3044${Date.now()}`;
    const connection = await metaConnection('b', 'FACEBOOK', person, 2);
    const response = await post('/v1/social/data-deletion/facebook', form(signedRequest(person)), {
      'content-type': 'application/x-www-form-urlencoded',
    });
    const { confirmation_code: code } = JSON.parse(response.body) as { confirmation_code: string };
    expect(
      await platform.socialDataDeletionRequest.findUniqueOrThrow({
        where: { confirmationCode: code },
      }),
    ).toMatchObject({ status: 'RECEIVED', connectionsFound: 1, connectionsDeleted: 0 });

    const waiting = await server.inject({
      method: 'GET',
      url: `/v1/social/data-deletion/facebook/status/${code}`,
    });
    expect(waiting.statusCode).toBe(200);
    expect(waiting.body).toContain('waiting to be processed');

    await sweep();

    const after = await stateOf('b', connection.id);
    expect(after.connection).toEqual({
      status: 'REVOKED',
      displayName: 'Facebook',
      avatarUrl: null,
      externalAccountId: `erased-${connection.id}`,
      providerSubjectHash: null,
      grantedScopes: [],
    });
    expect(after.observations).toBe(0);
    expect(after.audits).toEqual([
      'SYSTEM:social.connection.data_deleted',
      'SYSTEM:social.connection.removed_at_platform',
    ]);
    expect(
      await platform.socialDataDeletionRequest.findUniqueOrThrow({
        where: { confirmationCode: code },
      }),
    ).toMatchObject({ status: 'COMPLETED', connectionsFound: 1, connectionsDeleted: 1 });

    const done = await server.inject({
      method: 'GET',
      url: `/v1/social/data-deletion/facebook/status/${code}`,
    });
    expect(done.statusCode).toBe(200);
    expect(done.headers['cache-control']).toBe('no-store');
    expect(done.body).toContain('Completed.');
    expect(done.body).toContain('اكتمل.');
    expect(done.body).not.toContain(person);
    expect(done.body).not.toContain(connection.id);

    const unknown = await server.inject({
      method: 'GET',
      url: '/v1/social/data-deletion/facebook/status/NoSuchCode0000000000000',
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('the sweep — a failure is retried, then left FAILED for a person', () => {
  it('a workspace that fails puts the delivery back; past maxAttempts it is FAILED, never dropped', async () => {
    const person = `4055${Date.now()}`;
    const connection = await metaConnection('a', 'FACEBOOK', person, 2);
    await post('/v1/social/deauthorize/facebook', form(signedRequest(person)), {
      'content-type': 'application/x-www-form-urlencoded',
    });
    const event = await platform.socialInboundEvent.findFirstOrThrow({
      where: {
        kind: 'DEAUTHORIZE',
        subjectHash: subjectHash(person, { version: 2, secret: KEY_V2 }),
      },
    });

    await sweep({ failIn: fixtures.a.workspaceId, maxAttempts: 2 });
    expect(
      await platform.socialInboundEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).toMatchObject({ status: 'RECEIVED', attempts: 1, claimToken: null });

    await sweep({ failIn: fixtures.a.workspaceId, maxAttempts: 2 });
    expect(
      await platform.socialInboundEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).toMatchObject({ status: 'FAILED', attempts: 2, failureCode: 'inbound.processing_failed' });
    expect((await stateOf('a', connection.id)).connection.status).toBe('ACTIVE');
  });
});
