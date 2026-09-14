import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import {
  appRoleClient,
  createIsolationFixtures,
  migrationRoleClient,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * Cross-tenant and cross-BRAND isolation for the six models Phase 5B-1 adds.
 *
 * The D-29 gate requires this file. Each model gets the assertions the earlier
 * phases established — a direct read of B's row from A returns null, a listing
 * from A excludes B, a write aimed at B is refused, and an aggregate is treated
 * as a read — plus the properties specific to an Asset Library:
 *
 *   - A CUSTOMER FILE IS THE MOST CONCRETE TENANT DATA IN THE PRODUCT. A
 *     positioning statement leaking is bad; an unreleased campaign video or a
 *     signed contract leaking is unambiguous. The storage KEY is asserted
 *     separately from the row, because a key is enough to fetch the bytes if it
 *     ever reaches a path that does not re-check the tenant.
 *
 *   - THE NULL BRAND IS EXERCISED, NOT ASSUMED. Five of the six models take a
 *     nullable brand, and a suite that only ever saw brand-scoped rows would
 *     never touch the MATCH SIMPLE exemption that makes workspace-level assets
 *     legal. Both shapes are provisioned for both tenants.
 *
 *   - THE COMPOSITE FOREIGN KEY IS ENFORCED BY THE DATABASE. A leaked brand id
 *     cannot be attached to even from inside the right workspace context: the
 *     insert fails in PostgreSQL, not in a service that remembered to look.
 *
 *   - THE VERSION HISTORY IS APPEND-ONLY IN THREE SEPARATED LAYERS, and the
 *     third is reached only by disabling the first two — exactly as
 *     `brand_knowledge_version` is tested.
 *
 *   - IDENTICAL CHECKSUMS ACROSS TENANTS ARE THE POINT. Both tenants hold an
 *     asset with the same SHA-256, so the live-dedupe unique index is proven
 *     workspace-scoped: were it global, provisioning tenant B would have failed.
 *
 * Everything runs through `withWorkspace()`, so PostgreSQL RLS — not a `where`
 * clause a test remembered — is what is being measured.
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

/** Read inside A's workspace context. */
function inA<T>(fn: (db: Parameters<Parameters<typeof withWorkspace>[1]>[0]) => Promise<T>) {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app });
}

describe('AssetFolder is tenant-owned', () => {
  it('A cannot read B folder by id', async () => {
    const row = await inA((db) =>
      db.assetFolder.findUnique({ where: { id: fixtures.b.assetFolderId } }),
    );
    expect(row).toBeNull();
  });

  it('A cannot read B WORKSPACE-LEVEL folder either', async () => {
    // The one a careless policy would miss: it has no brand to scope it, so
    // only `workspaceId` stands between the tenants.
    const row = await inA((db) =>
      db.assetFolder.findUnique({ where: { id: fixtures.b.workspaceFolderId } }),
    );
    expect(row).toBeNull();
  });

  it("A's listing contains exactly its own two folders", async () => {
    const rows = await inA((db) => db.assetFolder.findMany());
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([fixtures.a.assetFolderId, fixtures.a.workspaceFolderId].sort());
  });

  it('A cannot COUNT B folders — an aggregate is a read', async () => {
    const total = await inA((db) => db.assetFolder.count());
    expect(total).toBe(2);
  });

  it('A cannot write a folder into B', async () => {
    await expect(
      inA((db) =>
        db.assetFolder.create({
          data: { workspaceId: fixtures.b.workspaceId, name: 'smuggled' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('A cannot rename B folder', async () => {
    const result = await inA((db) =>
      db.assetFolder.updateMany({
        where: { id: fixtures.b.assetFolderId },
        data: { name: 'seized' },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('A cannot delete B folder', async () => {
    const result = await inA((db) =>
      db.assetFolder.deleteMany({ where: { id: fixtures.b.assetFolderId } }),
    );
    expect(result.count).toBe(0);
  });

  it("A cannot NEST a folder under B's folder", async () => {
    /*
     * THE PARENT POINTER IS A SECOND WAY IN, and it is not covered by the
     * policy on the row being written: the new row carries A's own
     * workspaceId, so `WITH CHECK` is satisfied. What refuses it is the
     * foreign key, which cannot see a row RLS hides — so the reference fails
     * as "not present" rather than as "belongs to someone else", which is the
     * same non-disclosure the 404 rule asks for.
     */
    await expect(
      inA((db) =>
        db.assetFolder.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            parentFolderId: fixtures.b.assetFolderId,
            name: 'reparented',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('Asset is tenant-owned and brand-scoped', () => {
  it('A cannot read B asset by id', async () => {
    const row = await inA((db) => db.asset.findUnique({ where: { id: fixtures.b.assetId } }));
    expect(row).toBeNull();
  });

  it('A cannot read B workspace-level asset by id', async () => {
    const row = await inA((db) =>
      db.asset.findUnique({ where: { id: fixtures.b.workspaceAssetId } }),
    );
    expect(row).toBeNull();
  });

  it("A's listing excludes B entirely", async () => {
    const rows = await inA((db) => db.asset.findMany());
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(fixtures.a.assetId);
    expect(ids).not.toContain(fixtures.b.assetId);
    expect(ids).not.toContain(fixtures.b.workspaceAssetId);
  });

  it('both tenants hold the SAME checksum, so live dedupe is workspace-scoped', async () => {
    // A global unique index on the checksum would have failed to provision
    // tenant B at all — and would have let one customer discover that another
    // holds a given file by trying to upload it.
    expect(fixtures.a.assetChecksum).toBe(fixtures.b.assetChecksum);
    const mine = await inA((db) =>
      db.asset.findMany({ where: { checksumSha256: fixtures.a.assetChecksum } }),
    );
    expect(mine.map((r) => r.id)).toEqual([fixtures.a.assetId]);
  });

  it('A cannot SEARCH B assets by name — a filtered read is still a read', async () => {
    const rows = await inA((db) => db.asset.findMany({ where: { name: { contains: 'hero' } } }));
    expect(rows.every((r) => r.workspaceId === fixtures.a.workspaceId)).toBe(true);
  });

  it('A cannot SEARCH B assets by tag — an array predicate is still a read', async () => {
    const rows = await inA((db) => db.asset.findMany({ where: { tags: { has: 'hero' } } }));
    expect(rows.map((r) => r.id)).toEqual([fixtures.a.assetId]);
  });

  it("A cannot discover B's storage keys", async () => {
    /*
     * A KEY IS A CAPABILITY, not merely a label. Anything that leaks one has
     * leaked the bytes to every code path that does not re-check the tenant
     * — which is why the download grant is bound to a workspace and why this
     * is asserted on its own rather than folded into the row assertions.
     */
    const rows = await inA((db) => db.asset.findMany({ select: { storageKey: true } }));
    const keys = rows.map((r) => r.storageKey).join(' ');
    expect(keys).not.toContain(fixtures.b.workspaceId);
  });

  it('A cannot write an asset into B', async () => {
    await expect(
      inA((db) =>
        db.asset.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            name: 'smuggled.png',
            kind: 'IMAGE',
            mimeType: 'image/png',
            sizeBytes: 10,
            storageKey: 'smuggled',
            checksumSha256: 'smuggled-checksum',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("A cannot attach its own asset to B's brand — the composite key refuses it", async () => {
    /*
     * THE BRAND BOUNDARY IS NOT A RESTATEMENT OF THE TENANT BOUNDARY.
     *
     * This row carries A's OWN workspaceId, so the RLS policy is satisfied and
     * the insert reaches the constraints. What refuses it is the composite
     * foreign key `(workspaceId, brandId)` against `brand(workspaceId, id)`:
     * the pair (A, B-brand) does not exist. Without it, a brand id that leaked
     * into a tenant's hands — from a URL, a screenshot, a support thread —
     * would be attachable.
     */
    await expect(
      inA((db) =>
        db.asset.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.b.brandId,
            name: 'cross-brand.png',
            kind: 'IMAGE',
            mimeType: 'image/png',
            sizeBytes: 10,
            storageKey: 'cross-brand',
            checksumSha256: 'cross-brand-checksum',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a NULL brand is accepted, which is what makes a workspace-level asset legal', async () => {
    /*
     * THE OTHER HALF OF THE ASSERTION ABOVE, and the one a reader would most
     * doubt. PostgreSQL MATCH SIMPLE satisfies a composite foreign key when any
     * referencing column is NULL, so a workspace-level row is exempt BY
     * CONSTRUCTION rather than by a special case somebody wrote. If that ever
     * stopped being true, docs/DATABASE.md §4.6 would be unimplementable and
     * this test would say so.
     */
    const created = await inA((db) =>
      db.asset.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: null,
          name: 'workspace-level.png',
          kind: 'IMAGE',
          mimeType: 'image/png',
          sizeBytes: 10,
          storageKey: `ws/${fixtures.a.workspaceId}/asset/null-brand-probe`,
          checksumSha256: `null-brand-probe-${fixtures.a.slug}`,
        },
      }),
    );
    expect(created.brandId).toBeNull();
    await inA((db) => db.asset.delete({ where: { id: created.id } }));
  });

  it('A cannot archive B asset', async () => {
    const result = await inA((db) =>
      db.asset.updateMany({
        where: { id: fixtures.b.assetId },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('A cannot delete B asset', async () => {
    const result = await inA((db) => db.asset.deleteMany({ where: { id: fixtures.b.assetId } }));
    expect(result.count).toBe(0);
  });
});

describe('AssetVersion is tenant-owned and append-only', () => {
  it('A cannot read B version rows', async () => {
    const row = await inA((db) =>
      db.assetVersion.findUnique({ where: { id: fixtures.b.assetVersionId } }),
    );
    expect(row).toBeNull();
  });

  it("A's listing excludes B", async () => {
    const rows = await inA((db) => db.assetVersion.findMany());
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.assetVersionId);
  });

  it('A cannot list B versions by asset id', async () => {
    const rows = await inA((db) =>
      db.assetVersion.findMany({ where: { assetId: fixtures.b.assetId } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('UPDATE is refused on a tenant OWN version row', async () => {
    // Not a cross-tenant assertion. A version history must be immutable even to
    // the tenant that owns it, or "this is exactly the file you uploaded" is
    // unprovable — which is the whole promise of being able to restore one.
    await expect(
      inA((db) =>
        db.assetVersion.update({
          where: { id: fixtures.a.assetVersionId },
          data: { storageKey: 'rewritten' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('DELETE is refused on a tenant own version row', async () => {
    await expect(
      inA((db) => db.assetVersion.delete({ where: { id: fixtures.a.assetVersionId } })),
    ).rejects.toThrow();
  });

  it('the row survives both refusals, with its key intact', async () => {
    const row = await inA((db) =>
      db.assetVersion.findUnique({ where: { id: fixtures.a.assetVersionId } }),
    );
    expect(row?.storageKey).not.toBe('rewritten');
  });

  /*
   * THE THREE LAYERS, SEPARATED — the same construction, and the same reason,
   * as `brand_knowledge_version`.
   *
   * The two refusals above are won by the REVOKED PRIVILEGE: PostgreSQL checks
   * privileges before it fires a trigger, so `permission denied` arrives first
   * and the trigger is never reached. That makes those tests silent about the
   * backstop — if a future migration re-granted UPDATE by accident they would
   * keep passing right up until the history became rewritable.
   *
   * So the backstop is tested by DOING EXACTLY THAT: granting the privilege
   * back, as a careless migration would, and showing the trigger still refuses.
   * The grant is reverted in `finally`, so the suite leaves the database as it
   * found it whether or not the assertion holds.
   */
  it('the trigger refuses an UPDATE even when the privilege is granted back', async () => {
    const owner = migrationRoleClient();
    const platform = platformRoleClient();
    try {
      await owner.$executeRawUnsafe(
        'GRANT UPDATE, DELETE ON "asset_version" TO brandspace_platform',
      );
      await expect(
        platform.$executeRawUnsafe(
          `UPDATE "asset_version" SET "storageKey" = 'rewritten' WHERE "id" = $1::uuid`,
          fixtures.a.assetVersionId,
        ),
      ).rejects.toThrow(/append-only/i);
      await expect(
        platform.$executeRawUnsafe(
          `DELETE FROM "asset_version" WHERE "id" = $1::uuid`,
          fixtures.a.assetVersionId,
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await owner.$executeRawUnsafe(
        'REVOKE UPDATE, DELETE ON "asset_version" FROM brandspace_platform',
      );
      await owner.$disconnect();
      await platform.$disconnect();
    }
  });

  it('an INSERT is still permitted — append-only is not read-only', async () => {
    const created = await inA((db) =>
      db.assetVersion.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          assetId: fixtures.a.assetId,
          versionNumber: 2,
          storageKey: `${fixtures.a.assetId}/v2`,
          checksumSha256: `append-probe-${fixtures.a.slug}`,
          mimeType: 'image/png',
          sizeBytes: 11,
        },
      }),
    );
    expect(created.versionNumber).toBe(2);
    // Deliberately NOT cleaned up: the row cannot be deleted, which is the
    // property under test. The fixtures are per-run, so nothing accumulates.
  });
});

describe('AssetDerivative is tenant-owned', () => {
  it('A cannot read B derivative by id', async () => {
    const row = await inA((db) =>
      db.assetDerivative.findUnique({ where: { id: fixtures.b.assetDerivativeId } }),
    );
    expect(row).toBeNull();
  });

  it("A's listing excludes B, and A cannot count B's derivatives", async () => {
    const rows = await inA((db) => db.assetDerivative.findMany());
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.assetDerivativeId);
    const total = await inA((db) => db.assetDerivative.count());
    expect(total).toBe(1);
  });

  it('A cannot write a derivative onto B asset', async () => {
    await expect(
      inA((db) =>
        db.assetDerivative.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            assetId: fixtures.b.assetId,
            kind: 'PREVIEW',
            storageKey: 'smuggled',
            mimeType: 'image/png',
            sizeBytes: 10,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('AssetUploadSession is tenant-owned', () => {
  it('A cannot read B session by id', async () => {
    const row = await inA((db) =>
      db.assetUploadSession.findUnique({ where: { id: fixtures.b.uploadSessionId } }),
    );
    expect(row).toBeNull();
  });

  it('A cannot read B session through the workspace-scoped idempotency key', async () => {
    /*
     * AN IDEMPOTENCY KEY IS CLIENT-SUPPLIED, so it is the one value a tenant is
     * most able to reproduce deliberately. If the unique index were global
     * rather than `(workspaceId, idempotencyKey)`, a tenant could both COLLIDE
     * with another tenant (denying them an upload) and read the row back.
     */
    const row = await inA((db) =>
      db.assetUploadSession.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: fixtures.b.workspaceId,
            idempotencyKey: fixtures.b.uploadIdempotencyKey,
          },
        },
      }),
    );
    expect(row).toBeNull();
  });

  it('both tenants hold the SAME shape of key without colliding', async () => {
    const mine = await inA((db) =>
      db.assetUploadSession.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: fixtures.a.workspaceId,
            idempotencyKey: fixtures.a.uploadIdempotencyKey,
          },
        },
      }),
    );
    expect(mine?.id).toBe(fixtures.a.uploadSessionId);
  });

  it("A cannot discover B's reserved storage key by listing sessions", async () => {
    const rows = await inA((db) => db.assetUploadSession.findMany());
    expect(JSON.stringify(rows)).not.toContain(fixtures.b.workspaceId);
  });

  it('A cannot open a session in B', async () => {
    await expect(
      inA((db) =>
        db.assetUploadSession.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            declaredFileName: 'smuggled.png',
            declaredMimeType: 'image/png',
            declaredSizeBytes: 10,
            storageKey: 'smuggled',
            idempotencyKey: 'smuggled-key',
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('A cannot complete B session', async () => {
    const result = await inA((db) =>
      db.assetUploadSession.updateMany({
        where: { id: fixtures.b.uploadSessionId },
        data: { status: 'ABORTED' },
      }),
    );
    expect(result.count).toBe(0);
  });
});

describe('AssetProcessingJob is tenant-owned', () => {
  it('A cannot read B job by id', async () => {
    const row = await inA((db) =>
      db.assetProcessingJob.findUnique({ where: { id: fixtures.b.assetProcessingJobId } }),
    );
    expect(row).toBeNull();
  });

  it("A's listing excludes B", async () => {
    const rows = await inA((db) => db.assetProcessingJob.findMany());
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.assetProcessingJobId);
  });

  it('A cannot enumerate B work through the reconciliation predicate', async () => {
    // The sweep selects on `(stage, nextAttemptAt)` and NOT on workspace — it
    // relies on the caller's context. A tenant running the same predicate must
    // still see only its own, or the sweep's shape would be a leak.
    const rows = await inA((db) =>
      db.assetProcessingJob.findMany({ where: { stage: { in: ['QUEUED', 'SCANNING'] } } }),
    );
    expect(rows.every((r) => r.workspaceId === fixtures.a.workspaceId)).toBe(true);
  });

  it('A cannot write a job into B', async () => {
    await expect(
      inA((db) =>
        db.assetProcessingJob.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            assetId: fixtures.b.assetId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('A cannot re-drive B job by updating its stage', async () => {
    const result = await inA((db) =>
      db.assetProcessingJob.updateMany({
        where: { id: fixtures.b.assetProcessingJobId },
        data: { stage: 'QUEUED', nextAttemptAt: new Date() },
      }),
    );
    expect(result.count).toBe(0);
  });
});
