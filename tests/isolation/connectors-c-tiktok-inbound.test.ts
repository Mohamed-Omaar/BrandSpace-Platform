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
 * CONNECTORS C — TIKTOK'S WEBHOOK, END TO END against real PostgreSQL:
 * through the API's own route, with a TikTok app configured as the Control
 * Center saves one (its secret resolved by the Secret Service), then through
 * the maintenance sweep.
 *
 *   - nothing TikTok did not sign, nothing outside the timestamp tolerance and
 *     nothing addressed to another app is written;
 *   - `authorization.removed` revokes the person's TikTok connections in every
 *     workspace, each inside its own, and touches nothing else;
 *   - `post.publish.*` makes the matching pending post be asked about now, and
 *     only that post;
 *   - a redelivery is the same row.
 */

const ENV = 'DEVELOPMENT' as const;
const BASE = 'https://api.example.test';
const CLIENT_KEY = `testclientkey${randomUUID().slice(0, 8)}`;
const CLIENT_SECRET = `test-tiktok-secret-${randomUUID()}`;
const SUBJECT_KEY = `test-subject-key-${randomUUID()}`;

type Server = {
  inject(options: Record<string, unknown>): Promise<{ statusCode: number; body: string }>;
  close(): Promise<unknown>;
  ready(): Promise<unknown>;
};

let server: Server;
let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let socialApps: ActivatedConfig;

function delivery(event: string, content: Record<string, unknown>, openId: string | null) {
  return Buffer.from(
    JSON.stringify({
      client_key: CLIENT_KEY,
      event,
      create_time: Math.floor(Date.now() / 1_000),
      ...(openId === null ? {} : { user_openid: openId }),
      content: JSON.stringify(content),
    }),
  );
}

function signature(raw: Buffer, options: { secret?: string; at?: number } = {}): string {
  const t = options.at ?? Math.floor(Date.now() / 1_000);
  const s = createHmac('sha256', options.secret ?? CLIENT_SECRET)
    .update(`${t}.`)
    .update(raw)
    .digest('hex');
  return `t=${t},s=${s}`;
}

const send = (raw: Buffer, header?: string) =>
  server.inject({
    method: 'POST',
    url: '/v1/social/webhooks/tiktok',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      ...(header === undefined ? {} : { 'tiktok-signature': header }),
    },
  });

async function sweep() {
  return processSocialInboundEvents({
    platform,
    inWorkspace: (workspaceId, fn) => withWorkspace(workspaceId, fn, { prisma: app }),
    environment: ENV,
    now: new Date(),
    batchSize: 50,
    maxAttempts: 10,
    leaseSeconds: 300,
  });
}

async function connection(
  side: 'a' | 'b',
  provider: 'TIKTOK' | 'FACEBOOK',
  openId: string,
): Promise<string> {
  const world = fixtures[side];
  return withWorkspace(
    world.workspaceId,
    async (db) => {
      const row = await db.socialConnection.create({
        data: {
          workspaceId: world.workspaceId,
          brandId: world.brandId,
          provider,
          externalAccountId: `tiktok-${randomUUID()}`,
          displayName: 'Creator',
          targetKind: 'profile',
          status: 'ACTIVE',
          grantedScopes: ['video.publish'],
          connectedByUserId: world.userId,
          connectedAt: new Date(),
          providerSubjectHash: subjectHash(openId, { version: 1, secret: SUBJECT_KEY }),
        },
      });
      return row.id;
    },
    { prisma: app },
  );
}

async function pendingJob(side: 'a' | 'b', connectionId: string, handle: string, dueIn: number) {
  const world = fixtures[side];
  return withWorkspace(
    world.workspaceId,
    async (db) =>
      (
        await db.publishJob.create({
          data: {
            workspaceId: world.workspaceId,
            brandId: world.brandId,
            calendarSlotId: world.calendarSlotId,
            contentItemId: world.contentItemId,
            contentVariantId: world.contentVariantId,
            socialConnectionId: connectionId,
            provider: 'TIKTOK',
            status: 'VERIFICATION_PENDING',
            idempotencyKey: `c-tiktok-${randomUUID()}`,
            scheduledAtUtc: new Date(),
            maxAttempts: 5,
            nextAttemptAt: new Date(Date.now() + dueIn),
            providerHandle: handle,
            createdByUserId: world.userId,
          },
        })
      ).id,
    { prisma: app },
  );
}

const jobDue = (side: 'a' | 'b', jobId: string) =>
  withWorkspace(
    fixtures[side].workspaceId,
    async (db) =>
      (await db.publishJob.findUniqueOrThrow({ where: { id: jobId } })).nextAttemptAt as Date,
    { prisma: app },
  );

const connectionStatus = (side: 'a' | 'b', connectionId: string) =>
  withWorkspace(
    fixtures[side].workspaceId,
    async (db) =>
      (await db.socialConnection.findUniqueOrThrow({ where: { id: connectionId } })).status,
    { prisma: app },
  );

const eventsWithKey = async (raw: Buffer) => {
  const { createHash } = await import('node:crypto');
  const key = createHash('sha256').update(raw).digest('hex');
  return platform.socialInboundEvent.findMany({ where: { provider: 'TIKTOK', dedupeKey: key } });
};

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
  const clientSecretRef = `integration/social/tiktok/development/clientSecret-${randomUUID()}`;
  const subjectRef = `integration/social/tiktok/development/subject-${randomUUID()}`;
  for (const [ref, value] of [
    [clientSecretRef, CLIENT_SECRET],
    [subjectRef, SUBJECT_KEY],
  ] as const) {
    await secrets.createSecret(actor, {
      ref,
      name: 'Connectors C test secret',
      category: 'social_oauth_app',
      environment: ENV,
      value,
    });
  }
  socialApps = await captureConfig(platform, 'integrations.social-apps', { projected: false });
  await socialApps.activate({
    applications: [
      {
        providerKey: 'tiktok',
        appId: CLIENT_KEY,
        redirectUri: `${BASE}/v1/social/callback/tiktok`,
        scopes: [],
        clientSecretRef,
        status: 'active',
        settings: {},
        sharesCredentialWith: null,
      },
    ],
    subjectHashKeys: [{ version: 1, secretRef: subjectRef }],
    subjectHashVersion: 1,
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

describe('what is refused, and writes nothing', () => {
  it('no signature, a wrong secret, or a timestamp outside the tolerance: 403', async () => {
    const raw = delivery('post.publish.complete', { publish_id: `p-${randomUUID()}` }, null);
    expect((await send(raw)).statusCode).toBe(403);
    expect((await send(raw, signature(raw, { secret: 'not-the-secret' }))).statusCode).toBe(403);
    const stale = Math.floor(Date.now() / 1_000) - 3_600;
    expect((await send(raw, signature(raw, { at: stale }))).statusCode).toBe(403);
    expect(await eventsWithKey(raw)).toHaveLength(0);
  });

  it('a signed body addressed to another app: 400', async () => {
    const raw = Buffer.from(
      JSON.stringify({ client_key: 'someone-else', event: 'post.publish.complete', content: '{}' }),
    );
    expect((await send(raw, signature(raw))).statusCode).toBe(400);
    expect(await eventsWithKey(raw)).toHaveLength(0);
  });
});

describe('authorization.removed', () => {
  it('revokes this person’s TikTok connections in every workspace, and nothing else', async () => {
    const person = `open-${randomUUID()}`;
    const inA = await connection('a', 'TIKTOK', person);
    const inB = await connection('b', 'TIKTOK', person);
    const someoneElse = await connection('a', 'TIKTOK', `open-${randomUUID()}`);
    // The same hash on a Meta connection is not TikTok's to revoke.
    const metaSameHash = await connection('a', 'FACEBOOK', person);

    const raw = delivery('authorization.removed', { reason: 1 }, person);
    const first = await send(raw, signature(raw));
    expect(first.statusCode).toBe(200);
    expect((await send(raw, signature(raw))).statusCode).toBe(200);
    const recorded = await eventsWithKey(raw);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.kind).toBe('DEAUTHORIZE');
    expect(JSON.stringify(recorded[0]?.payload)).not.toContain(person);

    await sweep();
    expect(await connectionStatus('a', inA)).toBe('REVOKED');
    expect(await connectionStatus('b', inB)).toBe('REVOKED');
    expect(await connectionStatus('a', someoneElse)).toBe('ACTIVE');
    expect(await connectionStatus('a', metaSameHash)).toBe('ACTIVE');
  });
});

describe('post.publish.*', () => {
  it('the post behind the publish id is asked about now; another post is not', async () => {
    const handle = `v_pub_file~v2-${randomUUID()}`;
    const tiktokA = await connection('a', 'TIKTOK', `open-${randomUUID()}`);
    const tiktokB = await connection('b', 'TIKTOK', `open-${randomUUID()}`);
    const target = await pendingJob('a', tiktokA, handle, 600_000);
    const other = await pendingJob('b', tiktokB, `v_pub_file~v2-${randomUUID()}`, 600_000);
    const otherDueBefore = await jobDue('b', other);

    const raw = delivery('post.publish.complete', { publish_id: handle }, null);
    expect((await send(raw, signature(raw))).statusCode).toBe(200);
    await sweep();

    expect((await jobDue('a', target)).getTime()).toBeLessThanOrEqual(Date.now());
    expect((await jobDue('b', other)).getTime()).toBe(otherDueBefore.getTime());
    expect((await eventsWithKey(raw))[0]?.status).toBe('PROCESSED');
  });

  it('a publish id nobody holds, or an event this build does not act on, is set aside', async () => {
    const unknown = delivery('post.publish.failed', { publish_id: `nobody-${randomUUID()}` }, null);
    const other = delivery('video.something.new', { anything: true }, null);
    expect((await send(unknown, signature(unknown))).statusCode).toBe(200);
    expect((await send(other, signature(other))).statusCode).toBe(200);
    await sweep();
    expect((await eventsWithKey(unknown))[0]?.status).toBe('IGNORED');
    expect((await eventsWithKey(other))[0]?.status).toBe('IGNORED');
  });
});
