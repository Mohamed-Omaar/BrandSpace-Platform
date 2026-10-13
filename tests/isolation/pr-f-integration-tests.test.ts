import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ConfigurationService } from '@brandspace/config';
import { SecretService } from '@brandspace/secrets';
import { IntegrationsService } from '@brandspace/integrations';
import { PLATFORM_PERMISSIONS } from '@brandspace/shared';
import { ensurePlatformRole, platformRoleClient } from './fixtures';
import { captureConfig, type ActivatedConfig } from './config-activation';
import { integrationAreaState } from '../../apps/admin/src/server/owner-readiness';

// `server-only` is a build-time marker with no Node implementation; mocked by
// the path the admin app resolves it to (the bare id does not resolve here).
vi.mock('server-only', () => ({}));
vi.mock('../../apps/admin/node_modules/server-only/index.js', () => ({}));

/**
 * PR F — READINESS CAN READ "READY" FOR EMAIL AND STORAGE.
 *
 * Readiness says "Connected" only after a recorded check passed, and until
 * this change neither Resend nor Cloudflare R2 had a Test — so the verdict
 * could never be ready. Against real PostgreSQL and a real API server:
 *
 *   1. `POST /v1/internal/storage/self-test` answers exactly like a missing
 *      path to anybody without the service token, and with it runs a real
 *      write / read / delete round trip against the API's own store (here the
 *      development filesystem store), leaves nothing behind, and answers with
 *      the allowed keys only.
 *   2. The internal email route will not send the Control Center's test
 *      message, whoever holds the token.
 *   3. The Control Center's REAL tester, through the REAL Integrations
 *      service, asks that API, records OK — and the storage readiness area
 *      reads `ready`.
 */

const TOKEN = 'isolation-internal-service-token-'.padEnd(48, '0');
const ENV = 'DEVELOPMENT' as const;

type Server = {
  inject(options: Record<string, unknown>): Promise<{ statusCode: number; body: string }>;
  listen(options: { port: number; host: string }): Promise<string>;
  server: { address(): AddressInfo | string | null };
  close(): Promise<unknown>;
  ready(): Promise<unknown>;
};

let server: Server;
let storeDir: string;
let platform: PrismaClient;
let storage: ActivatedConfig;
let ownerId: string;
const createdChecks: string[] = [];

function owner() {
  return {
    platformUserId: ownerId,
    roleKey: 'platform_owner',
    mfaVerified: true,
    permissionKeys: PLATFORM_PERMISSIONS.map((permission) => permission.key),
  };
}

async function selfTest(headers: Record<string, string>) {
  return server.inject({
    method: 'POST',
    url: '/v1/internal/storage/self-test',
    headers: { 'content-type': 'application/json', ...headers },
    payload: {},
  });
}

async function leftovers(): Promise<string[]> {
  return readdir(path.join(storeDir, '_brandspace', 'self-test')).catch(() => []);
}

beforeAll(async () => {
  storeDir = await mkdtemp(path.join(tmpdir(), 'brandspace-self-test-'));
  vi.stubEnv('INTERNAL_SERVICE_TOKEN', TOKEN);
  vi.stubEnv('BRANDSPACE_OBJECT_STORE_DIR', storeDir);
  // No bucket: the API's factory hands out the development filesystem store.
  for (const name of [
    'STORAGE_ENDPOINT',
    'STORAGE_BUCKET',
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY',
  ]) {
    vi.stubEnv(name, undefined);
  }

  vi.resetModules();
  const { buildServer } = await import('../../apps/api/src/server');
  server = (await buildServer()) as unknown as Server;
  await server.ready();

  platform = platformRoleClient();
  const roleId = await ensurePlatformRole(platform);
  ownerId = (
    await platform.platformUser.create({
      data: {
        email: `storage-owner-${crypto.randomUUID()}@brandspace.local`,
        name: 'Storage Test Owner',
        status: 'ACTIVE',
        roleId,
      },
    })
  ).id;
  storage = await captureConfig(platform, 'integrations.storage', { projected: false });
}, 120_000);

afterAll(async () => {
  try {
    await storage?.restore();
    if (createdChecks.length > 0) {
      await platform.integrationHealthCheck.deleteMany({ where: { id: { in: createdChecks } } });
    }
  } finally {
    await server?.close();
    await platform?.$disconnect();
    await rm(storeDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

describe('PR F · POST /v1/internal/storage/self-test', () => {
  it('answers 404, shaped like a missing path, without the token', async () => {
    const response = await selfTest({});
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'NOT_FOUND' } });
    expect(await leftovers()).toEqual([]);
  });

  it('answers the same 404 to a wrong token, including one of the right length', async () => {
    for (const presented of ['wrong', 'x'.repeat(TOKEN.length)]) {
      const response = await selfTest({ 'x-brandspace-service-token': presented });
      expect(response.statusCode, presented).toBe(404);
      expect(JSON.parse(response.body)).toEqual({ error: { code: 'NOT_FOUND' } });
    }
    expect(await leftovers()).toEqual([]);
  });

  it('runs the round trip with the token, leaves nothing behind, and says nothing else', async () => {
    const response = await selfTest({ 'x-brandspace-service-token': TOKEN });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(typeof body['latencyMs']).toBe('number');
    // Exactly the allowed keys: no endpoint, bucket, key, region or error.
    expect(Object.keys(body).sort()).toEqual(['latencyMs', 'ok']);
    expect(response.body).not.toContain(storeDir);
    expect(response.body).not.toContain('_brandspace');

    // The reserved prefix is empty afterwards: the write happened (the
    // directory exists) and the delete took the file with it.
    const directory = path.join(storeDir, '_brandspace', 'self-test');
    expect(await readdir(directory)).toEqual([]);
  });
});

describe('PR F · the internal email route refuses the Control Center’s test message', () => {
  it('answers 422 to the right token asking for integration.test_message', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/internal/email/deliver',
      headers: { 'content-type': 'application/json', 'x-brandspace-service-token': TOKEN },
      payload: { to: 'anyone@example.test', templateKey: 'integration.test_message', locale: 'EN' },
    });
    // 422 (not 404) proves the token was accepted and the SCHEMA refused it.
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'VALIDATION_FAILED' } });
  });
});

describe('PR F · a passed storage Test makes the storage area ready', () => {
  it('records OK from the real tester through the real API, and readiness reads ready', async () => {
    // The Control Center's process: it reaches the API over HTTP, as deployed.
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    vi.stubEnv('BRANDSPACE_API_URL', address);

    // R2 is the active storage provider, as the beta configures it.
    await storage.activate({
      activeProviderKey: 'cloudflare-r2',
      providers: [
        {
          key: 'cloudflare-r2',
          name: 'Cloudflare R2 (S3-compatible)',
          status: 'active',
          settings: {},
          secretRefs: {},
        },
      ],
    });

    const configuration = new ConfigurationService({ prisma: platform });
    const secrets = new SecretService({ prisma: platform });
    const integrations = new IntegrationsService({ prisma: platform, configuration, secrets });
    const { integrationTester } = await import('../../apps/admin/src/server/integration-tester');

    // First a failure, so the "ready" below is caused by this run's pass and
    // not inherited from an earlier one.
    await integrations.testConnection({
      actor: owner(),
      category: 'storage',
      providerKey: 'cloudflare-r2',
      environment: ENV,
      tester: {
        async test() {
          return { ok: false, latencyMs: 1, message: 'The test file could not be written.' };
        },
      },
      requestedByPlatformUserId: ownerId,
    });
    const failedArea = integrationAreaState(
      (await integrations.list(owner(), ENV)).filter((view) => view.category === 'storage'),
    );
    expect(failedArea).toMatchObject({ state: 'needs_attention', reason: 'failed' });

    const view = await integrations.testConnection({
      actor: owner(),
      category: 'storage',
      providerKey: 'cloudflare-r2',
      environment: ENV,
      tester: integrationTester(),
      requestedByPlatformUserId: ownerId,
    });
    expect(view.connection).toBe('ok');
    expect(view.lastMessage).toBe('Wrote, read back and deleted a small test file.');
    expect(view.lastMessage).not.toContain(TOKEN);

    const area = integrationAreaState(
      (await integrations.list(owner(), ENV)).filter((view) => view.category === 'storage'),
    );
    expect(area).toEqual({
      state: 'ready',
      reason: 'ok',
      provider: { en: 'Cloudflare R2 (S3-compatible)', ar: 'Cloudflare R2 (متوافق مع S3)' },
    });

    // Nothing left in the reserved prefix after the real round trip either.
    expect(await leftovers()).toEqual([]);

    const checks = await platform.integrationHealthCheck.findMany({
      where: {
        category: 'storage',
        providerKey: 'cloudflare-r2',
        requestedByPlatformUserId: ownerId,
      },
      select: { id: true, message: true },
    });
    createdChecks.push(...checks.map((check) => check.id));
    expect(JSON.stringify(checks)).not.toContain(TOKEN);
  });
});
