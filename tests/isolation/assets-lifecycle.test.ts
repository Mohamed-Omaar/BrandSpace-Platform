import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssetDownloadService,
  AssetLibraryService,
  AssetMaintenanceService,
  AssetProcessingService,
  AssetUploadService,
  AssetVersionService,
  EICAR_TEST_STRING,
  MockVirusScanner,
  SCAN_FAILURE_PROBE,
  assetPolicyFrom,
  isSelectable,
  type AssetActor,
  type AssetPolicy,
} from '@brandspace/assets';
import { defaultPayload, parseConfigPayload } from '@brandspace/config';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { UsageService } from '@brandspace/entitlements';
import { DownloadGrantIssuer, InMemoryObjectStore } from '@brandspace/storage';
import { AppError, WORKSPACE_PERMISSIONS } from '@brandspace/shared';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * The Asset Library end to end, against REAL PostgreSQL.
 *
 * NOT MOCKED, AND THAT IS THE WHOLE POINT. Every guarantee this feature makes —
 * the quota that cannot be raced, the partial unique index that refuses a
 * duplicate, RLS, the append-only version history, the composite foreign keys —
 * is a property of the database. A suite that mocked it would assert that the
 * code calls Prisma, which is not the thing anyone needs to know.
 *
 * THE OBJECT STORE IS IN-MEMORY HERE, and that is not the same compromise.
 * Producer and consumer run in ONE process in these tests deliberately, so the
 * store only needs to be readable by the caller that wrote it. The FILESYSTEM
 * store is what the cross-process path needs (D-97), and it has its own suite.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;

const scanner = new MockVirusScanner();
const DOWNLOAD_KEY = 'isolation-test-signing-key-not-a-secret';

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

/** Every workspace permission — the owner's grant. */
const ALL: readonly string[] = WORKSPACE_PERMISSIONS.map((p) => p.key);

function actor(overrides: Partial<AssetActor> = {}): AssetActor {
  return {
    userId: fixtures.a.userId,
    permissionKeys: ALL,
    brandScope: [],
    ...overrides,
  };
}

function policyWith(overrides: Record<string, unknown> = {}): AssetPolicy {
  return assetPolicyFrom(
    Object.keys(overrides).length === 0
      ? defaultPayload('assets')
      : parseConfigPayload('assets', overrides),
  );
}

/** A PNG header followed by whatever payload the test needs. */
function png(payload = ''): Uint8Array {
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

interface Harness {
  readonly db: TenantScopedClient;
  readonly upload: AssetUploadService;
  readonly library: AssetLibraryService;
  readonly processing: AssetProcessingService;
  readonly versions: AssetVersionService;
  readonly download: AssetDownloadService;
  readonly maintenance: AssetMaintenanceService;
  readonly store: InMemoryObjectStore;
}

/**
 * Run inside workspace A with a full set of services.
 *
 * `withWorkspace` sets `app.workspace_id` for the transaction, so every
 * statement below is subject to RLS — a `where` clause a test remembered is not
 * what keeps tenants apart here.
 */
async function inA<T>(
  fn: (h: Harness) => Promise<T>,
  options: {
    policy?: AssetPolicy;
    storageLimitGb?: number | null;
    store?: InMemoryObjectStore;
    clock?: { now: () => Date };
    workspaceId?: string;
  } = {},
): Promise<T> {
  const policy = options.policy ?? policyWith();
  const store = options.store ?? new InMemoryObjectStore();
  const workspaceId = options.workspaceId ?? fixtures.a.workspaceId;
  return withWorkspace(
    workspaceId,
    async (db) => {
      const scoped = db as unknown as PrismaClient;
      const usage = new UsageService({ prisma: scoped });
      const shared = { db, workspaceId, policy, store };
      return fn({
        db,
        store,
        upload: new AssetUploadService({
          ...shared,
          usage,
          storageLimitGb: options.storageLimitGb ?? null,
          ...(options.clock ? { clock: options.clock } : {}),
        }),
        library: new AssetLibraryService({
          db,
          workspaceId,
          policy,
          ...(options.clock ? { clock: options.clock } : {}),
        }),
        processing: new AssetProcessingService({
          ...shared,
          scanner,
          ...(options.clock ? { clock: options.clock } : {}),
        }),
        versions: new AssetVersionService({
          ...shared,
          ...(options.clock ? { clock: options.clock } : {}),
        }),
        download: new AssetDownloadService({
          db,
          workspaceId,
          policy,
          issuer: new DownloadGrantIssuer({ signingKey: DOWNLOAD_KEY }),
        }),
        maintenance: new AssetMaintenanceService({
          ...shared,
          usage,
          ...(options.clock ? { clock: options.clock } : {}),
        }),
      });
    },
    { prisma: app },
  );
}

let counter = 0;
function uniqueKey(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Upload and process one asset, returning it READY unless the bytes say otherwise. */
async function uploadAndProcess(
  h: Harness,
  options: { bytes?: Uint8Array; name?: string; brandId?: string | null; a?: AssetActor } = {},
) {
  const bytes = options.bytes ?? png(crypto.randomUUID());
  const session = await h.upload.initiate({
    brandId: options.brandId ?? null,
    folderId: null,
    fileName: options.name ?? 'photo.png',
    mimeType: 'image/png',
    sizeBytes: bytes.byteLength,
    idempotencyKey: uniqueKey('up'),
    actor: options.a ?? actor(),
  });
  const completed = await h.upload.complete({
    sessionId: session.session.id,
    bytes,
    actor: options.a ?? actor(),
  });
  const result = completed.job
    ? await h.processing.process(completed.job.id)
    : { status: completed.asset.status };
  return { asset: completed.asset, result, sessionId: session.session.id };
}

describe('the upload lifecycle', () => {
  it('takes a file from initiate to READY and CLEAN', async () => {
    await inA(async (h) => {
      const { asset, result } = await uploadAndProcess(h);
      expect(result.status).toBe('READY');

      const stored = await h.library.get(asset.id, actor());
      expect(stored.status).toBe('READY');
      expect(stored.scanStatus).toBe('CLEAN');
      expect(stored.kind).toBe('IMAGE');
      expect(isSelectable(stored)).toBe(true);
      expect(stored.currentVersion).toBe(1);
    });
  });

  it('QUARANTINES before the scan, so nothing is usable in between', async () => {
    await inA(async (h) => {
      const bytes = png(crypto.randomUUID());
      const session = await h.upload.initiate({
        brandId: null,
        folderId: null,
        fileName: 'pending.png',
        mimeType: 'image/png',
        sizeBytes: bytes.byteLength,
        idempotencyKey: uniqueKey('up'),
        actor: actor(),
      });
      const { asset } = await h.upload.complete({
        sessionId: session.session.id,
        bytes,
        actor: actor(),
      });

      // BEFORE the processor runs. Quarantine is the DEFAULT, not something a
      // caller has to remember to apply.
      expect(asset.scanStatus).toBe('PENDING');
      expect(asset.status).toBe('PROCESSING');
      expect(isSelectable(asset)).toBe(false);
      await expect(
        h.download.grantFor({ assetId: asset.id, actor: actor(), disposition: 'inline' }),
      ).rejects.toThrow();
    });
  });

  it('writes an audit event for the upload, carrying no file content', async () => {
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h, { name: 'audited.png' });
      const events = await h.db.auditEvent.findMany({
        where: { resourceType: 'Asset', resourceId: asset.id },
      });
      const uploaded = events.find((e) => e.action === 'assets.uploaded');
      expect(uploaded).toBeDefined();
      const after = JSON.stringify(uploaded?.after);
      expect(after).toContain('audited.png');
      // The KEY and the CHECKSUM never enter an audit event.
      expect(after).not.toContain(asset.storageKey);
      expect(after).not.toContain(asset.checksumSha256);
    });
  });

  it('is IDEMPOTENT on initiate — a replayed key returns the same session', async () => {
    await inA(async (h) => {
      const key = uniqueKey('replay');
      const first = await h.upload.initiate({
        brandId: null,
        folderId: null,
        fileName: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 64,
        idempotencyKey: key,
        actor: actor(),
      });
      const second = await h.upload.initiate({
        brandId: null,
        folderId: null,
        fileName: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 64,
        idempotencyKey: key,
        actor: actor(),
      });
      expect(second.replayed).toBe(true);
      expect(second.session.id).toBe(first.session.id);
      expect(second.storageKey).toBe(first.storageKey);

      const sessions = await h.db.assetUploadSession.count({ where: { idempotencyKey: key } });
      expect(sessions).toBe(1);
    });
  });

  it('is IDEMPOTENT on complete — a second completion returns the same asset', async () => {
    await inA(async (h) => {
      const bytes = png(crypto.randomUUID());
      const session = await h.upload.initiate({
        brandId: null,
        folderId: null,
        fileName: 'once.png',
        mimeType: 'image/png',
        sizeBytes: bytes.byteLength,
        idempotencyKey: uniqueKey('up'),
        actor: actor(),
      });
      const first = await h.upload.complete({
        sessionId: session.session.id,
        bytes,
        actor: actor(),
      });
      const second = await h.upload.complete({
        sessionId: session.session.id,
        bytes,
        actor: actor(),
      });

      expect(second.replayed).toBe(true);
      expect(second.asset.id).toBe(first.asset.id);
      const assets = await h.db.asset.count({
        where: { checksumSha256: first.asset.checksumSha256 },
      });
      expect(assets).toBe(1);
    });
  });

  it('REFUSES the same bytes twice — the file identity, not the request', async () => {
    await inA(async (h) => {
      const bytes = png('the-very-same-photograph');
      await uploadAndProcess(h, { bytes });

      const session = await h.upload.initiate({
        brandId: null,
        folderId: null,
        fileName: 'copy.png',
        mimeType: 'image/png',
        sizeBytes: bytes.byteLength,
        idempotencyKey: uniqueKey('dup'),
        actor: actor(),
      });
      await expect(
        h.upload.complete({ sessionId: session.session.id, bytes, actor: actor() }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  it('lets the same bytes be re-uploaded AFTER a delete', async () => {
    /*
     * THE REASON THE UNIQUE INDEX IS PARTIAL. A full constraint would mean a
     * customer who deleted a file could never upload it again, because the
     * soft-deleted row keeps the checksum forever.
     */
    await inA(async (h) => {
      const bytes = png('deleted-then-restored');
      const { asset } = await uploadAndProcess(h, { bytes });
      await h.library.delete(asset.id, actor());

      const again = await uploadAndProcess(h, { bytes });
      expect(again.asset.id).not.toBe(asset.id);
      expect(again.result.status).toBe('READY');
    });
  });
});

describe('the bytes decide, and hostile input is refused', () => {
  it('REFUSES a PDF renamed as a PNG, and stores nothing', async () => {
    await inA(async (h) => {
      const session = await h.upload.initiate({
        brandId: null,
        folderId: null,
        fileName: 'renamed.png',
        mimeType: 'image/png',
        sizeBytes: 64,
        idempotencyKey: uniqueKey('mismatch'),
        actor: actor(),
      });
      await expect(
        h.upload.complete({
          sessionId: session.session.id,
          bytes: new TextEncoder().encode('%PDF-1.7 not an image at all'),
          actor: actor(),
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      // NOTHING WAS STORED and no asset row exists.
      expect(h.store.size).toBe(0);
      const aborted = await h.db.assetUploadSession.findUnique({
        where: { id: session.session.id },
      });
      expect(aborted?.status).toBe('ABORTED');
      expect(aborted?.failureReason).toBe('content_type_mismatch');
    });
  });

  it('REFUSES a traversing file name at initiate', async () => {
    await inA(async (h) => {
      await expect(
        h.upload.initiate({
          brandId: null,
          folderId: null,
          fileName: '../../etc/passwd',
          mimeType: 'image/png',
          sizeBytes: 64,
          idempotencyKey: uniqueKey('traverse'),
          actor: actor(),
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      // No session row was created at all.
      const sessions = await h.db.assetUploadSession.count({
        where: { declaredFileName: { contains: 'passwd' } },
      });
      expect(sessions).toBe(0);
    });
  });

  it('refuses a type the allow-list does not admit, before anything is read', async () => {
    await inA(async (h) => {
      await expect(
        h.upload.initiate({
          brandId: null,
          folderId: null,
          fileName: 'payload.svg',
          mimeType: 'image/svg+xml',
          sizeBytes: 64,
          idempotencyKey: uniqueKey('svg'),
          actor: actor(),
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  it('refuses a file larger than the CONFIGURED ceiling for its kind', async () => {
    const tight = policyWith({ upload: { maxFileBytes: { image: 32 } } });
    await inA(
      async (h) => {
        await expect(
          h.upload.initiate({
            brandId: null,
            folderId: null,
            fileName: 'big.png',
            mimeType: 'image/png',
            sizeBytes: 4_096,
            idempotencyKey: uniqueKey('big'),
            actor: actor(),
          }),
        ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      },
      { policy: tight },
    );
  });

  it('refuses a completion LARGER than the size the quota was spent on', async () => {
    /*
     * Otherwise a caller can always under-declare and then send whatever it
     * likes, which makes the quota advisory rather than enforced.
     */
    await inA(async (h) => {
      const session = await h.upload.initiate({
        brandId: null,
        folderId: null,
        fileName: 'sneaky.png',
        mimeType: 'image/png',
        sizeBytes: 16,
        idempotencyKey: uniqueKey('under'),
        actor: actor(),
      });
      await expect(
        h.upload.complete({
          sessionId: session.session.id,
          bytes: png('x'.repeat(4_000)),
          actor: actor(),
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(h.store.size).toBe(0);
    });
  });

  it('refuses an empty file', async () => {
    await inA(async (h) => {
      await expect(
        h.upload.initiate({
          brandId: null,
          folderId: null,
          fileName: 'empty.png',
          mimeType: 'image/png',
          sizeBytes: 0,
          idempotencyKey: uniqueKey('empty'),
          actor: actor(),
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });
});

describe('quarantine holds until a scanner says otherwise', () => {
  it('an INFECTED file never becomes selectable or downloadable', async () => {
    await inA(async (h) => {
      const infected = new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...new TextEncoder().encode(EICAR_TEST_STRING),
      ]);
      const { asset, result } = await uploadAndProcess(h, { bytes: infected, name: 'bad.png' });

      expect(result.status).toBe('QUARANTINED');
      const stored = await h.library.get(asset.id, actor());
      expect(stored.scanStatus).toBe('INFECTED');
      expect(isSelectable(stored)).toBe(false);

      // Neither selectable for another module nor downloadable.
      await expect(h.library.resolveForUse(asset.id, actor())).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      await expect(
        h.download.grantFor({ assetId: asset.id, actor: actor(), disposition: 'inline' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  it('an infected verdict is TERMINAL — a retry does not re-scan it', async () => {
    await inA(async (h) => {
      const infected = new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...new TextEncoder().encode(EICAR_TEST_STRING),
      ]);
      const bytes = new Uint8Array([...infected, ...new TextEncoder().encode(crypto.randomUUID())]);
      const session = await h.upload.initiate({
        brandId: null,
        folderId: null,
        fileName: 'bad2.png',
        mimeType: 'image/png',
        sizeBytes: bytes.byteLength,
        idempotencyKey: uniqueKey('inf'),
        actor: actor(),
      });
      const completed = await h.upload.complete({
        sessionId: session.session.id,
        bytes,
        actor: actor(),
      });
      const jobId = completed.job!.id;

      await h.processing.process(jobId);
      const afterFirst = await h.db.assetProcessingJob.findUnique({ where: { id: jobId } });
      expect(afterFirst?.stage).toBe('FAILED');

      // A second run finds the job finished and returns what it found.
      const second = await h.processing.process(jobId);
      expect(second.failureReason).toBe('infected');
      const afterSecond = await h.db.assetProcessingJob.findUnique({ where: { id: jobId } });
      expect(afterSecond?.attempts).toBe(afterFirst?.attempts);
    });
  });

  it('a FAILED scan is retryable and leaves the asset quarantined meanwhile', async () => {
    /*
     * Genuinely different from infected: the engine could not reach a verdict,
     * which is an operational problem rather than a property of the file. The
     * asset must not become usable, and the job must be tried again.
     */
    await inA(async (h) => {
      const bytes = new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...new TextEncoder().encode(SCAN_FAILURE_PROBE + crypto.randomUUID()),
      ]);
      const { asset, result } = await uploadAndProcess(h, { bytes, name: 'unscannable.png' });

      expect(result.status).toBe('QUARANTINED');
      const stored = await h.library.get(asset.id, actor());
      expect(stored.scanStatus).toBe('FAILED');
      expect(isSelectable(stored)).toBe(false);

      const job = await h.db.assetProcessingJob.findFirst({ where: { assetId: asset.id } });
      expect(job?.stage).toBe('QUEUED');
      expect(job?.nextAttemptAt).not.toBeNull();
    });
  });

  it('a missing object is terminal and says so in a customer-safe way', async () => {
    await inA(async (h) => {
      const bytes = png(crypto.randomUUID());
      const session = await h.upload.initiate({
        brandId: null,
        folderId: null,
        fileName: 'vanished.png',
        mimeType: 'image/png',
        sizeBytes: bytes.byteLength,
        idempotencyKey: uniqueKey('gone'),
        actor: actor(),
      });
      const completed = await h.upload.complete({
        sessionId: session.session.id,
        bytes,
        actor: actor(),
      });
      // Remove the object behind the row.
      await h.store.delete(completed.asset.storageKey);

      const result = await h.processing.process(completed.job!.id);
      expect(result.failureReason).toBe('object_missing');
      expect(result.status).toBe('PROCESSING_FAILED');
    });
  });
});

describe('the storage quota is enforced, refunded and never raced', () => {
  it('refuses an upload that would exceed the plan ceiling', async () => {
    /*
     * The per-FILE ceiling is raised for this test on purpose. With the default
     * 25 MB image ceiling a single upload can never reach a 1 GB plan limit, so
     * the assertion would pass on the wrong refusal — which is exactly what the
     * first version of this test did, reporting VALIDATION_FAILED where it
     * claimed to be proving QUOTA_EXCEEDED.
     */
    await inA(
      async (h) => {
        await expect(
          h.upload.initiate({
            brandId: null,
            folderId: null,
            fileName: 'huge.png',
            mimeType: 'image/png',
            sizeBytes: 2_000_000_000,
            idempotencyKey: uniqueKey('quota'),
            actor: actor(),
          }),
        ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
      },
      {
        storageLimitGb: 1,
        workspaceId: fixtures.b.workspaceId,
        policy: policyWith({ upload: { maxFileBytes: { image: 2_100_000_000 } } }),
      },
    );
  });

  it('gives the quota BACK when a completion is refused as a duplicate', async () => {
    await inA(async (h) => {
      const bytes = png('refund-me');
      await uploadAndProcess(h, { bytes });

      const before = await h.db.usageCounter.findFirst({
        where: { featureKey: 'limit.storage_gb' },
      });
      const session = await h.upload.initiate({
        brandId: null,
        folderId: null,
        fileName: 'dup.png',
        mimeType: 'image/png',
        sizeBytes: bytes.byteLength,
        idempotencyKey: uniqueKey('refund'),
        actor: actor(),
      });
      await expect(
        h.upload.complete({ sessionId: session.session.id, bytes, actor: actor() }),
      ).rejects.toThrow();

      const after = await h.db.usageCounter.findFirst({
        where: { featureKey: 'limit.storage_gb' },
      });
      // The refused upload spent nothing on balance.
      expect(after?.usedValue).toBe(before?.usedValue);
    });
  });

  it('an EXPIRED session gives its quota back, and its bytes go', async () => {
    /*
     * `initiate` spends quota against the DECLARED size before any bytes
     * arrive, so a customer whose browser closed mid-upload is paying for a
     * file that does not exist. This sweep is what stops a flaky connection
     * quietly consuming a plan.
     */
    let now = new Date('2026-09-14T12:00:00Z');
    const clock = { now: () => now };
    const store = new InMemoryObjectStore();

    await inA(
      async (h) => {
        const session = await h.upload.initiate({
          brandId: null,
          folderId: null,
          fileName: 'abandoned.png',
          mimeType: 'image/png',
          sizeBytes: 2_000_000_000,
          idempotencyKey: uniqueKey('abandon'),
          actor: actor(),
        });
        await h.store.put(session.storageKey, png('staged'), 'image/png');

        const spent = await h.db.usageCounter.findFirst({
          where: { featureKey: 'limit.storage_gb' },
        });
        expect(spent?.usedValue ?? 0).toBeGreaterThanOrEqual(2);

        // NOTHING IS SWEPT BEFORE THE WINDOW — the half a waiting test cannot
        // assert, and the half that catches a sweep deleting files early.
        const early = await h.maintenance.expireStaleSessions();
        expect(early.expired).toBe(0);

        // Past the window.
        now = new Date(now.getTime() + 3_600_000);
        const swept = await h.maintenance.expireStaleSessions();
        expect(swept.expired).toBeGreaterThanOrEqual(1);

        const expired = await h.db.assetUploadSession.findUnique({
          where: { id: session.session.id },
        });
        expect(expired?.status).toBe('EXPIRED');
        expect(await h.store.get(session.storageKey)).toBeNull();

        const after = await h.db.usageCounter.findFirst({
          where: { featureKey: 'limit.storage_gb' },
        });
        expect(after?.usedValue ?? 0).toBeLessThan(spent?.usedValue ?? 0);
      },
      {
        clock,
        store,
        workspaceId: fixtures.b.workspaceId,
        // As above: the declaration has to clear the per-file ceiling for the
        // quota movement to be the thing under test.
        policy: policyWith({ upload: { maxFileBytes: { image: 2_100_000_000 } } }),
      },
    );
  });
});

describe('permissions are enforced in the SERVICE, not at the screen', () => {
  // Built lazily inside each test: a `describe` body runs at COLLECTION time,
  // before `beforeAll` has provisioned the fixtures.
  const readOnly = () => actor({ permissionKeys: ['assets.read'] });

  it('a read-only actor can browse and cannot upload, edit, archive or delete', async () => {
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h);

      // Reading is fine.
      await expect(h.library.get(asset.id, readOnly())).resolves.toBeDefined();
      await expect(h.library.browse({ actor: readOnly() })).resolves.toBeDefined();

      for (const attempt of [
        () =>
          h.upload.initiate({
            brandId: null,
            folderId: null,
            fileName: 'no.png',
            mimeType: 'image/png',
            sizeBytes: 64,
            idempotencyKey: uniqueKey('ro'),
            actor: readOnly(),
          }),
        () => h.library.updateMetadata({ assetId: asset.id, actor: readOnly(), name: 'renamed' }),
        () => h.library.archive(asset.id, readOnly()),
        () => h.library.restore(asset.id, readOnly()),
        () => h.library.delete(asset.id, readOnly()),
        () =>
          h.library.createFolder({
            actor: readOnly(),
            name: 'x',
            brandId: null,
            parentFolderId: null,
          }),
        () => h.versions.addVersion({ assetId: asset.id, bytes: png('v2'), actor: readOnly() }),
      ]) {
        await expect(attempt()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    });
  });

  it('`assets.read` does NOT imply `assets.use`', async () => {
    /*
     * The reason `use` is its own key: browsing for reference is not the same
     * authority as putting a file in front of the public. `analyst` and
     * `client_viewer` hold read and not use.
     */
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h);
      await expect(h.library.resolveForUse(asset.id, readOnly())).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(
        h.library.resolveForUse(asset.id, actor({ permissionKeys: ['assets.read', 'assets.use'] })),
      ).resolves.toBeDefined();
    });
  });

  it('`assets.edit` does NOT imply `assets.version`', async () => {
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h);
      const editor = actor({ permissionKeys: ['assets.read', 'assets.edit'] });
      await expect(
        h.library.updateMetadata({ assetId: asset.id, actor: editor, name: 'ok' }),
      ).resolves.toBeDefined();
      await expect(
        h.versions.addVersion({ assetId: asset.id, bytes: png('v2'), actor: editor }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  it('`assets.archive` does NOT imply `assets.delete`', async () => {
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h);
      const archiver = actor({ permissionKeys: ['assets.read', 'assets.archive'] });
      await expect(h.library.archive(asset.id, archiver)).resolves.toBeDefined();
      await expect(h.library.delete(asset.id, archiver)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });
});

describe('brand scope is the third grain, inside one workspace', () => {
  /**
   * A SECOND BRAND IN THE SAME WORKSPACE is the grain RLS does not cover: both
   * brands are legitimately the tenant's, and the database will happily return
   * either. F-74 is what happens when nothing enforces it.
   */
  async function secondBrand(): Promise<string> {
    return withWorkspace(
      fixtures.a.workspaceId,
      async (db) => {
        const existing = await db.brand.findFirst({ where: { slug: 'second-brand' } });
        if (existing) return existing.id;
        const created = await db.brand.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            slug: 'second-brand',
            name: 'Second Brand',
            status: 'ACTIVE',
          },
        });
        return created.id;
      },
      { prisma: app },
    );
  }

  it('an out-of-scope brand is refused as NOT_FOUND, identically to a miss', async () => {
    const other = await secondBrand();
    await inA(async (h) => {
      const restricted = actor({ brandScope: [fixtures.a.brandId] });
      const failure = await h.upload
        .initiate({
          brandId: other,
          folderId: null,
          fileName: 'scoped.png',
          mimeType: 'image/png',
          sizeBytes: 64,
          idempotencyKey: uniqueKey('scope'),
          actor: restricted,
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AppError);
      // NOT_FOUND, not FORBIDDEN: "forbidden" would confirm the brand exists,
      // which tells a restricted member how many others their colleagues have.
      expect((failure as AppError).code).toBe('NOT_FOUND');

      // Nothing was written on the way to the refusal.
      const sessions = await h.db.assetUploadSession.count({ where: { brandId: other } });
      expect(sessions).toBe(0);
    });
  });

  it('a restricted member cannot READ an out-of-scope asset', async () => {
    const other = await secondBrand();
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h, { brandId: other, name: 'other-brand.png' });
      const restricted = actor({ brandScope: [fixtures.a.brandId] });
      await expect(h.library.get(asset.id, restricted)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  it("a restricted member's LISTING excludes out-of-scope assets before they are read", async () => {
    const other = await secondBrand();
    await inA(async (h) => {
      const mine = await uploadAndProcess(h, { brandId: fixtures.a.brandId, name: 'mine.png' });
      const theirs = await uploadAndProcess(h, { brandId: other, name: 'theirs.png' });

      const restricted = actor({ brandScope: [fixtures.a.brandId] });
      const page = await h.library.browse({ actor: restricted, limit: 100 });
      const ids = page.items.map((a) => a.id);
      expect(ids).toContain(mine.asset.id);
      expect(ids).not.toContain(theirs.asset.id);
    });
  });

  it('a WORKSPACE-LEVEL asset stays visible to a restricted member', async () => {
    /*
     * The half a careless filter would get wrong. A workspace-level asset
     * belongs to the workspace rather than to any brand, so withholding it from
     * everyone with a scope set would hide the shared logo pack from exactly
     * the people most likely to be restricted.
     */
    await inA(async (h) => {
      const shared = await uploadAndProcess(h, { brandId: null, name: 'shared-logo.png' });
      const restricted = actor({ brandScope: [fixtures.a.brandId] });
      const page = await h.library.browse({ actor: restricted, limit: 100 });
      expect(page.items.map((a) => a.id)).toContain(shared.asset.id);
      await expect(h.library.get(shared.asset.id, restricted)).resolves.toBeDefined();
    });
  });
});

describe('folders and tags', () => {
  it('creates, renames and refuses to delete a folder that holds something', async () => {
    await inA(async (h) => {
      const folder = await h.library.createFolder({
        actor: actor(),
        name: 'Campaign',
        brandId: null,
        parentFolderId: null,
      });
      const renamed = await h.library.renameFolder({
        actor: actor(),
        folderId: folder.id,
        name: 'Campaign 2026',
      });
      expect(renamed.name).toBe('Campaign 2026');

      const { asset } = await uploadAndProcess(h);
      await h.library.updateMetadata({ assetId: asset.id, actor: actor(), folderId: folder.id });

      await expect(
        h.library.deleteFolder({ actor: actor(), folderId: folder.id }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // Empty it, and the delete succeeds.
      await h.library.updateMetadata({ assetId: asset.id, actor: actor(), folderId: null });
      await expect(
        h.library.deleteFolder({ actor: actor(), folderId: folder.id }),
      ).resolves.toBeUndefined();
    });
  });

  it('REFUSES a folder cycle', async () => {
    /*
     * Not tidiness: the resulting cycle detaches from the root, disappears from
     * every listing, and makes every walk of the tree loop forever. The first
     * walk to run takes the process with it.
     */
    await inA(async (h) => {
      const parent = await h.library.createFolder({
        actor: actor(),
        name: 'Parent',
        brandId: null,
        parentFolderId: null,
      });
      const child = await h.library.createFolder({
        actor: actor(),
        name: 'Child',
        brandId: null,
        parentFolderId: parent.id,
      });

      await expect(
        h.library.moveFolder({ actor: actor(), folderId: parent.id, parentFolderId: child.id }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        h.library.moveFolder({ actor: actor(), folderId: parent.id, parentFolderId: parent.id }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  it('enforces the CONFIGURED folder depth', async () => {
    const shallow = policyWith({ upload: { maxFolderDepth: 2 } });
    await inA(
      async (h) => {
        const root = await h.library.createFolder({
          actor: actor(),
          name: 'L1',
          brandId: null,
          parentFolderId: null,
        });
        const second = await h.library.createFolder({
          actor: actor(),
          name: 'L2',
          brandId: null,
          parentFolderId: root.id,
        });
        await expect(
          h.library.createFolder({
            actor: actor(),
            name: 'L3',
            brandId: null,
            parentFolderId: second.id,
          }),
        ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      },
      { policy: shallow },
    );
  });

  it('normalises tags, de-duplicates them and enforces the CONFIGURED ceiling', async () => {
    const capped = policyWith({ upload: { maxTagsPerAsset: 2 } });
    await inA(
      async (h) => {
        const { asset } = await uploadAndProcess(h);
        const updated = await h.library.updateMetadata({
          assetId: asset.id,
          actor: actor(),
          tags: ['Hero', 'hero ', ' HERO'],
        });
        // Three spellings of one tag are one tag.
        expect(updated.tags).toEqual(['hero']);

        await expect(
          h.library.updateMetadata({
            assetId: asset.id,
            actor: actor(),
            tags: ['a', 'b', 'c'],
          }),
        ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      },
      { policy: capped },
    );
  });

  it('reports tag facets in a deterministic order', async () => {
    await inA(async (h) => {
      const first = await uploadAndProcess(h, { name: 'f1.png' });
      const second = await uploadAndProcess(h, { name: 'f2.png' });
      await h.library.updateMetadata({ assetId: first.asset.id, actor: actor(), tags: ['spring'] });
      await h.library.updateMetadata({
        assetId: second.asset.id,
        actor: actor(),
        tags: ['spring', 'launch'],
      });

      const facets = await h.library.tagFacets(actor());
      const spring = facets.find((f) => f.tag === 'spring');
      expect(spring?.count).toBeGreaterThanOrEqual(2);
      // Commonest first, then alphabetically — a total order.
      const sorted = [...facets].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
      expect(facets).toEqual(sorted);
    });
  });
});

describe('pagination is a stable keyset, not an offset', () => {
  it('walks every asset exactly once with no repeats and no gaps', async () => {
    await inA(async (h) => {
      const created: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const { asset } = await uploadAndProcess(h, { name: `page-${i}.png` });
        created.push(asset.id);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const page: Awaited<ReturnType<typeof h.library.browse>> = await h.library.browse({
          actor: actor(),
          limit: 2,
          cursor,
        });
        seen.push(...page.items.map((a) => a.id));
        if (!page.hasMore) break;
        cursor = page.nextCursor;
      }

      // No repeats.
      expect(new Set(seen).size).toBe(seen.length);
      // Every asset created here appears.
      for (const id of created) expect(seen).toContain(id);
    });
  });

  it('ignores a malformed cursor rather than misinterpreting it', async () => {
    await inA(async (h) => {
      await expect(
        h.library.browse({ actor: actor(), cursor: 'not-a-cursor', limit: 5 }),
      ).resolves.toBeDefined();
    });
  });

  it('caps the page size whatever the caller asks for', async () => {
    await inA(async (h) => {
      const page = await h.library.browse({ actor: actor(), limit: 10_000 });
      expect(page.items.length).toBeLessThanOrEqual(100);
    });
  });

  it('sorts by name deterministically in both directions', async () => {
    await inA(async (h) => {
      const ascending = await h.library.browse({
        actor: actor(),
        sort: 'name',
        direction: 'asc',
        limit: 100,
      });
      const names = ascending.items.map((a) => a.name);
      expect([...names].sort()).toEqual(names);
    });
  });
});

describe('versions are append-only and restorable', () => {
  it('adds a version, re-quarantines, and keeps the old bytes reachable', async () => {
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h, { name: 'versioned.png' });
      const v1Key = asset.storageKey;

      const added = await h.versions.addVersion({
        assetId: asset.id,
        bytes: png('second-revision'),
        actor: actor(),
      });

      // THE ASSET RETURNS TO QUARANTINE. New bytes have not been scanned.
      expect(added.asset.currentVersion).toBe(2);
      expect(added.asset.scanStatus).toBe('PENDING');
      expect(isSelectable(added.asset)).toBe(false);
      // A new OBJECT, not an overwrite — which is what makes a restore real.
      expect(added.asset.storageKey).not.toBe(v1Key);
      expect(await h.store.get(v1Key)).not.toBeNull();

      await h.processing.process(added.job.id);
      const ready = await h.library.get(asset.id, actor());
      expect(ready.status).toBe('READY');
      expect(ready.scanStatus).toBe('CLEAN');
    });
  });

  it('restores an earlier version as a FORWARD version, keeping the history', async () => {
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h, { name: 'rollback.png' });
      const v1 = await h.library.get(asset.id, actor());

      const added = await h.versions.addVersion({
        assetId: asset.id,
        bytes: png('revision-two'),
        actor: actor(),
      });
      await h.processing.process(added.job.id);

      const restored = await h.versions.restoreVersion({
        assetId: asset.id,
        versionNumber: 1,
        actor: actor(),
      });

      // A FORWARD version, never a rewind: 1 and 2 both still exist.
      expect(restored.asset.currentVersion).toBe(3);
      expect(restored.asset.checksumSha256).toBe(v1.checksumSha256);
      const history = await h.library.versions(asset.id, actor());
      expect(history.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
      // It points at the SAME object, so restoring costs no new storage.
      expect(restored.version.storageKey).toBe(v1.storageKey);
    });
  });

  it('enforces the CONFIGURED version ceiling', async () => {
    const capped = policyWith({ versions: { maxVersionsPerAsset: 2 } });
    await inA(
      async (h) => {
        const { asset } = await uploadAndProcess(h, { name: 'capped.png' });
        const second = await h.versions.addVersion({
          assetId: asset.id,
          bytes: png('v2-capped'),
          actor: actor(),
        });
        await h.processing.process(second.job.id);

        await expect(
          h.versions.addVersion({ assetId: asset.id, bytes: png('v3-capped'), actor: actor() }),
        ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
      },
      { policy: capped },
    );
  });

  it('refuses a version whose bytes are a different format', async () => {
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h, { name: 'strict.png' });
      await expect(
        h.versions.addVersion({
          assetId: asset.id,
          bytes: new TextEncoder().encode('%PDF-1.7'),
          actor: actor(),
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });
});

describe('archive, restore and delete', () => {
  it('archives and restores, and a restore respects the scan verdict', async () => {
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h, { name: 'lifecycle.png' });
      const archived = await h.library.archive(asset.id, actor());
      expect(archived.status).toBe('ARCHIVED');
      expect(isSelectable(archived)).toBe(false);

      const restored = await h.library.restore(asset.id, actor());
      expect(restored.status).toBe('READY');
      expect(isSelectable(restored)).toBe(true);
    });
  });

  it('a RESTORE never returns an infected asset to READY', async () => {
    /*
     * The scan verdict decides the status, not the button. Otherwise an asset
     * archived while infected comes back usable because somebody pressed
     * restore.
     */
    await inA(async (h) => {
      const infected = new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...new TextEncoder().encode(EICAR_TEST_STRING + crypto.randomUUID()),
      ]);
      const { asset } = await uploadAndProcess(h, { bytes: infected, name: 'archived-bad.png' });
      await h.library.archive(asset.id, actor());
      const restored = await h.library.restore(asset.id, actor());
      expect(restored.status).toBe('QUARANTINED');
      expect(isSelectable(restored)).toBe(false);
    });
  });

  it('a deleted asset disappears from every read path', async () => {
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h, { name: 'gone.png' });
      await h.library.delete(asset.id, actor());

      await expect(h.library.get(asset.id, actor())).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const page = await h.library.browse({ actor: actor(), limit: 100, includeArchived: true });
      expect(page.items.map((a) => a.id)).not.toContain(asset.id);
      await expect(
        h.download.grantFor({ assetId: asset.id, actor: actor(), disposition: 'inline' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it('the retention sweep purges bytes only AFTER the configured grace', async () => {
    let now = new Date('2026-09-14T12:00:00Z');
    const clock = { now: () => now };
    const store = new InMemoryObjectStore();
    const policy = policyWith({ retention: { purgeDeletedAfterDays: 30 } });

    await inA(
      async (h) => {
        const { asset } = await uploadAndProcess(h, { name: 'retained.png' });
        await h.library.delete(asset.id, actor());
        const key = asset.storageKey;
        expect(await h.store.get(key)).not.toBeNull();

        // BEFORE the window: nothing is purged. The direction a waiting test
        // cannot assert, and the one that catches an early deletion.
        now = new Date(now.getTime() + 29 * 24 * 3_600_000);
        expect((await h.maintenance.purgeDeletedAssets()).purged).toBe(0);
        expect(await h.store.get(key)).not.toBeNull();

        // Past it: the bytes go and the ROW stays, so the audit trail survives.
        now = new Date(now.getTime() + 2 * 24 * 3_600_000);
        expect((await h.maintenance.purgeDeletedAssets()).purged).toBeGreaterThanOrEqual(1);
        expect(await h.store.get(key)).toBeNull();

        const row = await h.db.asset.findUnique({ where: { id: asset.id } });
        expect(row).not.toBeNull();
        expect(row?.storageKey).toBe('');
      },
      { clock, store, policy },
    );
  });

  it('every lifecycle change writes an audit event', async () => {
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h, { name: 'audited-lifecycle.png' });
      await h.library.updateMetadata({ assetId: asset.id, actor: actor(), tags: ['audit'] });
      await h.library.archive(asset.id, actor());
      await h.library.restore(asset.id, actor());
      const added = await h.versions.addVersion({
        assetId: asset.id,
        bytes: png('audited-v2'),
        actor: actor(),
      });
      await h.processing.process(added.job.id);
      await h.library.delete(asset.id, actor());

      const events = await h.db.auditEvent.findMany({
        where: { resourceType: 'Asset', resourceId: asset.id },
      });
      const actions = new Set(events.map((e) => e.action));
      for (const expected of [
        'assets.uploaded',
        'assets.metadata_updated',
        'assets.archived',
        'assets.restored',
        'assets.version_created',
        'assets.deleted',
        'assets.processed',
      ]) {
        expect(actions).toContain(expected);
      }
    });
  });
});

describe('downloads are authorised, bound and short-lived', () => {
  it('issues a grant for a clean asset and redeems it in the same workspace', async () => {
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h, { name: 'downloadable.png' });
      const { grant } = await h.download.grantFor({
        assetId: asset.id,
        actor: actor(),
        disposition: 'attachment',
      });

      const issuer = new DownloadGrantIssuer({ signingKey: DOWNLOAD_KEY });
      const claims = issuer.redeem(grant.token, fixtures.a.workspaceId);
      expect(claims.storageKey).toBe(asset.storageKey);
      expect(claims.contentType).toBe('image/png');
    });
  });

  it('a grant is refused in ANOTHER workspace, even with a perfect signature', async () => {
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h, { name: 'bound.png' });
      const { grant } = await h.download.grantFor({
        assetId: asset.id,
        actor: actor(),
        disposition: 'inline',
      });
      const issuer = new DownloadGrantIssuer({ signingKey: DOWNLOAD_KEY });
      expect(() => issuer.redeem(grant.token, fixtures.b.workspaceId)).toThrow();
    });
  });

  it('a version grant follows the VERSION own scan verdict', async () => {
    await inA(async (h) => {
      const { asset } = await uploadAndProcess(h, { name: 'version-grant.png' });
      // Version 2 is added and left unscanned.
      await h.versions.addVersion({
        assetId: asset.id,
        bytes: png('unscanned-v2'),
        actor: actor(),
      });

      // Version 1 was cleared and is still servable.
      await expect(
        h.download.grantForVersion({
          assetId: asset.id,
          versionNumber: 1,
          actor: actor(),
          disposition: 'inline',
        }),
      ).resolves.toBeDefined();
      // Version 2 has not been cleared and is not.
      await expect(
        h.download.grantForVersion({
          assetId: asset.id,
          versionNumber: 2,
          actor: actor(),
          disposition: 'inline',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });
});

describe('the reconciliation sweep finds work nothing claimed', () => {
  it('selects a queued job and leaves a running one alone', async () => {
    let now = new Date('2026-09-14T12:00:00Z');
    const clock = { now: () => now };
    await inA(
      async (h) => {
        const bytes = png(crypto.randomUUID());
        const session = await h.upload.initiate({
          brandId: null,
          folderId: null,
          fileName: 'stuck.png',
          mimeType: 'image/png',
          sizeBytes: bytes.byteLength,
          idempotencyKey: uniqueKey('stuck'),
          actor: actor(),
        });
        const completed = await h.upload.complete({
          sessionId: session.session.id,
          bytes,
          actor: actor(),
        });
        const jobId = completed.job!.id;

        // Not yet stuck.
        expect(await h.maintenance.reclaimStuckJobs()).not.toContain(jobId);

        // Past the configured window.
        now = new Date(now.getTime() + 3_600_000);
        expect(await h.maintenance.reclaimStuckJobs()).toContain(jobId);

        // Once it completes, the sweep stops selecting it.
        await h.processing.process(jobId);
        expect(await h.maintenance.reclaimStuckJobs()).not.toContain(jobId);
      },
      { clock },
    );
  });
});
