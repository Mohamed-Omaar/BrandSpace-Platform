import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Cross-tenant and cross-BRAND isolation for the two models Phase 5B-2 adds.
 *
 * The D-29 gate requires this file. Each model gets the assertions every
 * earlier phase established — a direct read of B's row from A returns null, a
 * listing from A excludes B, a write aimed at B is refused, and an aggregate is
 * treated as a read — plus the properties specific to CONTENT:
 *
 *   - A DRAFT IS THE MOST COMMERCIALLY SENSITIVE TEXT IN THE PRODUCT. A
 *     positioning statement leaking is bad; an unannounced launch caption
 *     leaking is a competitor reading a company's calendar. The BODY is
 *     asserted separately from the row, because the row's existence is a
 *     smaller disclosure than its words.
 *
 *   - THE COMPOSITE KEY IS ENFORCED BY THE DATABASE, NOT BY THE SERVICE. F-80
 *     and F-83 were exactly this shape — a child pointing at a tenant-owned
 *     parent by id alone — and `content_variant.contentItemId` is the first new
 *     key written after D-112 made the composite form the platform rule. So the
 *     refusal is asserted from inside A's OWN workspace context, which is the
 *     case RLS does not cover and the case both findings were about.
 *
 *   - THE IDEMPOTENCY KEY IS WORKSPACE-SCOPED. Both tenants hold a draft with
 *     the same key; were the unique index global, provisioning tenant B would
 *     have failed outright.
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

function inA<T>(fn: (db: Parameters<Parameters<typeof withWorkspace>[1]>[0]) => Promise<T>) {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app });
}

describe('ContentItem is tenant-owned', () => {
  it('A cannot read B draft by id', async () => {
    const row = await inA((db) =>
      db.contentItem.findUnique({ where: { id: fixtures.b.contentItemId } }),
    );
    expect(row).toBeNull();
  });

  it("A's library listing excludes B", async () => {
    const rows = await inA((db) => db.contentItem.findMany());
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.contentItemId);
    expect(rows.map((r) => r.id)).toContain(fixtures.a.contentItemId);
  });

  it("no title in A's library is B's", async () => {
    const rows = await inA((db) => db.contentItem.findMany());
    expect(JSON.stringify(rows)).not.toContain(fixtures.b.slug);
  });

  it('A cannot count B drafts — an aggregate is a read', async () => {
    const count = await inA((db) =>
      db.contentItem.count({ where: { brandId: fixtures.b.brandId } }),
    );
    expect(count).toBe(0);
  });

  it("A cannot read B's draft by its idempotency key", async () => {
    // The key is identical in shape across tenants; only the workspace differs.
    const row = await inA((db) =>
      db.contentItem.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: fixtures.b.workspaceId,
            idempotencyKey: fixtures.b.contentIdempotencyKey,
          },
        },
      }),
    );
    expect(row).toBeNull();
  });

  it('A cannot write a draft into B', async () => {
    await expect(
      inA((db) =>
        db.contentItem.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            title: 'smuggled',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("A cannot attach its own draft to B's brand — the composite key refuses it", async () => {
    /*
     * A's OWN workspaceId, so RLS admits the row and the insert reaches the
     * constraints. What refuses it is `content_item_brand_fkey` on
     * `(workspaceId, brandId)`: the pair (A, B-brand) does not exist.
     */
    await expect(
      inA((db) =>
        db.contentItem.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.b.brandId,
            title: 'cross-brand',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('A cannot archive B draft', async () => {
    const result = await inA((db) =>
      db.contentItem.updateMany({
        where: { id: fixtures.b.contentItemId },
        data: { status: 'ARCHIVED' },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('A cannot delete B draft', async () => {
    const result = await inA((db) =>
      db.contentItem.deleteMany({ where: { id: fixtures.b.contentItemId } }),
    );
    expect(result.count).toBe(0);
  });
});

describe('ContentVariant is tenant-owned — it holds the caption itself', () => {
  it('A cannot read B variant by id', async () => {
    const row = await inA((db) =>
      db.contentVariant.findUnique({ where: { id: fixtures.b.contentVariantId } }),
    );
    expect(row).toBeNull();
  });

  it("A cannot list B's variants through the parent item id", async () => {
    const rows = await inA((db) =>
      db.contentVariant.findMany({ where: { contentItemId: fixtures.b.contentItemId } }),
    );
    expect(rows).toHaveLength(0);
  });

  it("no caption in A ever contains B's words", async () => {
    const rows = await inA((db) => db.contentVariant.findMany());
    const text = rows.map((r) => r.body ?? '').join(' ');
    expect(text).not.toContain(fixtures.b.slug);
    expect(text).toContain(fixtures.a.slug);
  });

  it('A cannot write a variant into B', async () => {
    await expect(
      inA((db) =>
        db.contentVariant.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            contentItemId: fixtures.b.contentItemId,
            platformKey: 'instagram',
            locale: 'EN',
            body: 'smuggled',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("A cannot attach a variant to B's DRAFT from inside its own workspace — F-80/F-83's shape", async () => {
    /*
     * THE CASE RLS DOES NOT COVER, and the reason D-112 exists.
     *
     * The row carries A's own workspaceId, so the tenant policy admits it and
     * the insert reaches the constraints. Referential integrity then runs with
     * RLS BYPASSED — so a plain `contentItemId` would have resolved B's draft
     * perfectly well and accepted the row, attaching A's caption to a draft A
     * cannot read. `content_variant_item_fkey` on `(workspaceId, contentItemId)`
     * is what refuses it: the PAIR does not exist.
     */
    await expect(
      inA((db) =>
        db.contentVariant.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId: fixtures.b.contentItemId,
            platformKey: 'linkedin',
            locale: 'EN',
            body: 'attached to another tenant draft',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a real foreign draft id and a fabricated one fail identically', async () => {
    /*
     * THE ORACLE, CLOSED RATHER THAN MOVED. A boundary that refused a real
     * foreign id with one error and an invented one with another would still
     * answer "does this id name a draft?". Both must be indistinguishable.
     */
    const attempt = (contentItemId: string) =>
      inA((db) =>
        db.contentVariant.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId,
            platformKey: 'x',
            locale: 'EN',
            body: 'probe',
          },
        }),
      );

    const observe = async (promise: Promise<unknown>) => {
      try {
        await promise;
        throw new Error('ACCEPTED');
      } catch (error: unknown) {
        const e = error as {
          code?: unknown;
          meta?: {
            driverAdapterError?: {
              cause?: { originalCode?: unknown; constraint?: { index?: unknown } };
            };
          };
        };
        const cause = e.meta?.driverAdapterError?.cause;
        return {
          code: String(e.code),
          sqlState: String(cause?.originalCode),
          constraint: String(cause?.constraint?.index),
        };
      }
    };

    const real = await observe(attempt(fixtures.b.contentItemId));
    const invented = await observe(attempt(randomUUID()));
    expect(real).toEqual(invented);
    expect(real.constraint).toBe('content_variant_item_fkey');
  });

  it('A cannot rewrite B caption', async () => {
    const result = await inA((db) =>
      db.contentVariant.updateMany({
        where: { id: fixtures.b.contentVariantId },
        data: { body: 'overwritten' },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('A cannot delete B variant', async () => {
    const result = await inA((db) =>
      db.contentVariant.deleteMany({ where: { id: fixtures.b.contentVariantId } }),
    );
    expect(result.count).toBe(0);
  });
});

describe('the content tables carry the platform guarantees', () => {
  it('RLS is ENABLED and FORCED on both', async () => {
    const rows = await app.$queryRawUnsafe<{ relname: string; ok: boolean }[]>(
      `SELECT relname, (relrowsecurity AND relforcerowsecurity) AS ok
         FROM pg_class WHERE relname IN ('content_item', 'content_variant')`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.ok, row.relname).toBe(true);
  });

  it('every foreign key to a tenant-owned parent is composite (D-112)', async () => {
    const rows = await app.$queryRawUnsafe<{ relation: string }[]>(
      `SELECT c.conrelid::regclass::text || '.' || c.conname AS relation
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'f'
          AND t.relname IN ('content_item', 'content_variant')
          AND cardinality(c.conkey) = 1
          AND c.confrelid <> 'workspace'::regclass`,
    );
    expect(rows.map((r) => r.relation)).toEqual([]);
  });

  it('a workspace retention window cannot be zero or negative (D-117)', async () => {
    /*
     * The customer's own control is bounded by the DATABASE, not only by the
     * settings form: "delete on write" is not a retention policy, and a
     * negative window is nonsense the service should not be the only thing
     * refusing.
     *
     * Run INSIDE A's workspace context on purpose. Outside it, RLS hides the
     * row and the UPDATE reports zero rows changed — which would have made this
     * test pass for the wrong reason, proving the policy rather than the CHECK.
     */
    await expect(
      inA((db) =>
        db.$executeRawUnsafe(
          `UPDATE "workspace" SET "aiContentRetentionDays" = 0 WHERE "id" = $1::uuid`,
          fixtures.a.workspaceId,
        ),
      ),
    ).rejects.toThrow();

    // And the legitimate value is accepted, so the constraint is a bound rather
    // than a blanket refusal.
    await inA((db) =>
      db.$executeRawUnsafe(
        `UPDATE "workspace" SET "aiContentRetentionDays" = 30 WHERE "id" = $1::uuid`,
        fixtures.a.workspaceId,
      ),
    );
    const after = await inA((db) =>
      db.workspace.findUnique({
        where: { id: fixtures.a.workspaceId },
        select: { aiContentRetentionDays: true },
      }),
    );
    expect(after?.aiContentRetentionDays).toBe(30);

    await inA((db) =>
      db.$executeRawUnsafe(
        `UPDATE "workspace" SET "aiContentRetentionDays" = NULL WHERE "id" = $1::uuid`,
        fixtures.a.workspaceId,
      ),
    );
  });
});
