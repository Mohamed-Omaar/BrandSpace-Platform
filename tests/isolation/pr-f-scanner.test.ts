import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssetProcessingService,
  AssetUploadService,
  EICAR_TEST_STRING,
  assetPolicyFrom,
  createVirusScanner,
  isSelectable,
  type AssetActor,
} from '@brandspace/assets';
import { parseConfigPayload } from '@brandspace/config';
import { withWorkspace } from '@brandspace/database';
import { UsageService } from '@brandspace/entitlements';
import { InMemoryObjectStore } from '@brandspace/storage';
import { WORKSPACE_PERMISSIONS } from '@brandspace/shared';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PR F (g), Q13 — THE BETA RUNS WITH FILE SCANNING OFF, AND TURNING A SCANNER
 * ON IS CONFIGURATION ONLY. Against real PostgreSQL, through the real upload
 * and processing services, with the scanner built by the SAME factory the
 * worker calls, in the PRODUCTION environment:
 *
 *   - `provider: none` (with `required: false`): an upload becomes READY and
 *     usable, recorded `not_scanned` — production no longer leaves it hanging;
 *   - `provider: scanii`: the same upload goes through the scanner (here a
 *     recorded HTTP double standing in for Scanii's API), and a detection
 *     quarantines it.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

const ALL: readonly string[] = WORKSPACE_PERMISSIONS.map((p) => p.key);
const actor = (): AssetActor => ({
  userId: fixtures.a.userId,
  permissionKeys: ALL,
  brandScope: [],
});

function png(payload: string): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...new TextEncoder().encode(payload),
  ]);
}

let counter = 0;

async function uploadThrough(
  scanning: Record<string, unknown>,
  bytes: Uint8Array,
  fetchDouble?: typeof fetch,
) {
  const policy = assetPolicyFrom(parseConfigPayload('assets', { scanning }));
  const scanner = createVirusScanner({
    appEnv: 'production',
    policy: policy.scanning,
    scaniiCredentials: { apiKey: 'test-key', apiSecret: 'test-secret' },
    ...(fetchDouble ? { fetch: fetchDouble } : {}),
  });
  const workspaceId = fixtures.a.workspaceId;
  return withWorkspace(
    workspaceId,
    async (db) => {
      const store = new InMemoryObjectStore();
      const usage = new UsageService({ prisma: db as unknown as PrismaClient });
      const upload = new AssetUploadService({
        db,
        workspaceId,
        policy,
        store,
        usage,
        storageLimitGb: null,
      });
      const processing = new AssetProcessingService({ db, workspaceId, policy, store, scanner });
      counter += 1;
      const session = await upload.initiate({
        brandId: null,
        folderId: null,
        fileName: 'beta.png',
        mimeType: 'image/png',
        sizeBytes: bytes.byteLength,
        idempotencyKey: `pr-f-scan-${counter}-${crypto.randomUUID().slice(0, 8)}`,
        actor: actor(),
      });
      const completed = await upload.complete({
        sessionId: session.session.id,
        bytes,
        actor: actor(),
      });
      if (!completed.job) throw new Error('an upload must queue its processing job');
      await processing.process(completed.job.id);
      return db.asset.findUniqueOrThrow({ where: { id: completed.asset.id } });
    },
    { prisma: app },
  );
}

describe('PR F (g) · scanning off in production', () => {
  it('an upload becomes READY and usable, recorded as not scanned', async () => {
    const asset = await uploadThrough(
      { required: false, provider: 'none' },
      png(crypto.randomUUID()),
    );
    expect(asset.status).toBe('READY');
    expect(asset.scanStatus).toBe('CLEAN');
    expect(asset.scanReason).toBe('not_scanned');
    expect(isSelectable(asset)).toBe(true);
  });

  it('the mock scanner is still refused in production — "none" is a choice, not a fallback', () => {
    expect(() =>
      createVirusScanner({ appEnv: 'production', policy: { provider: 'mock' } }),
    ).toThrow(/No malware scanner is configured/);
  });
});

describe('PR F (g) · switching the scanner on routes uploads through it', () => {
  const endpoint = 'https://scanner.test/v2.2/files';
  const scanning = { required: true, provider: 'scanii', scanii: { endpoint } };

  function recordingScanii(findings: (bytes: Uint8Array) => string[]) {
    const calls: { url: string; authorization: string | null; size: number }[] = [];
    const double = (async (url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get('file') as Blob;
      const bytes = new Uint8Array(await file.arrayBuffer());
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization'),
        size: bytes.byteLength,
      });
      return new Response(JSON.stringify({ id: 'scan-1', findings: findings(bytes) }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { calls, double };
  }

  it('a clean file is sent to the scanner once and becomes READY with no "not scanned" mark', async () => {
    const scanii = recordingScanii(() => []);
    const bytes = png(crypto.randomUUID());
    const asset = await uploadThrough(scanning, bytes, scanii.double);
    expect(scanii.calls).toHaveLength(1);
    expect(scanii.calls[0]?.url).toBe(endpoint);
    expect(scanii.calls[0]?.authorization).toMatch(/^Basic /);
    expect(scanii.calls[0]?.size).toBe(bytes.byteLength);
    expect(asset.status).toBe('READY');
    expect(asset.scanStatus).toBe('CLEAN');
    expect(asset.scanReason).toBeNull();
  });

  it('a detection quarantines the file', async () => {
    const scanii = recordingScanii((bytes) =>
      new TextDecoder().decode(bytes).includes(EICAR_TEST_STRING)
        ? ['content.malicious.eicar-test-signature']
        : [],
    );
    const asset = await uploadThrough(scanning, png(EICAR_TEST_STRING), scanii.double);
    expect(scanii.calls).toHaveLength(1);
    expect(asset.scanStatus).toBe('INFECTED');
    expect(asset.status).toBe('QUARANTINED');
    expect(isSelectable(asset)).toBe(false);
  });
});
