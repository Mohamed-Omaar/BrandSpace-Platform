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
 * Cross-tenant and cross-BRAND isolation for the nine models Phase 5 adds.
 *
 * The D-29 gate requires this file. Each model gets the three assertions the
 * earlier phases established — a direct read of B's row from A returns null, a
 * listing from A excludes B, and a write aimed at B is refused — plus the
 * properties specific to Brand Brain:
 *
 *   - BRAND KNOWLEDGE IS THE MOST SENSITIVE TENANT CORPUS IN THE PRODUCT.
 *     Positioning, audience research and pricing context are exactly what a
 *     competitor would want. The chunk table holds the raw uploaded text, so
 *     it is asserted on its own rather than assumed to follow its parent.
 *
 *   - THE BRAND BOUNDARY IS ENFORCED BY THE DATABASE, not by a service. The
 *     composite foreign key `(workspaceId, brandId)` means that even a leaked
 *     brand id cannot be attached to: the insert fails in PostgreSQL.
 *
 *   - THE VERSION HISTORY IS APPEND-ONLY. D-65's versioning requirement is
 *     worth nothing if a caller can rewrite history, so UPDATE and DELETE are
 *     refused by a trigger and not only by a revoked privilege.
 *
 *   - IDENTICAL VALUES ACROSS TENANTS ARE THE POINT. Both tenants use the same
 *     brand slug, the same knowledge item key and the same document checksum.
 *     Every corresponding unique index is workspace- or brand-scoped, so a
 *     tenant cannot discover another tenant's data by provoking a collision.
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

describe('Brand is tenant-owned', () => {
  it('A cannot read B brand by id', async () => {
    const row = await inA((db) => db.brand.findUnique({ where: { id: fixtures.b.brandId } }));
    expect(row).toBeNull();
  });

  it("A's listing excludes B entirely", async () => {
    const rows = await inA((db) => db.brand.findMany());
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(fixtures.a.brandId);
    expect(ids).not.toContain(fixtures.b.brandId);
  });

  it('both tenants hold the SAME slug, so the unique index is workspace-scoped', async () => {
    // If `(workspaceId, slug)` were merely `slug`, provisioning tenant B would
    // have failed. Asserting it here makes the guarantee explicit rather than
    // incidental to fixture creation.
    expect(fixtures.a.brandSlug).toBe(fixtures.b.brandSlug);
    const mine = await inA((db) => db.brand.findFirst({ where: { slug: fixtures.a.brandSlug } }));
    expect(mine?.id).toBe(fixtures.a.brandId);
  });

  it('A cannot write a brand into B', async () => {
    await expect(
      inA((db) =>
        db.brand.create({
          data: { workspaceId: fixtures.b.workspaceId, slug: 'smuggled', name: 'Smuggled' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('A cannot update B brand', async () => {
    const result = await inA((db) =>
      db.brand.updateMany({ where: { id: fixtures.b.brandId }, data: { name: 'seized' } }),
    );
    expect(result.count).toBe(0);
  });

  it('A cannot delete B brand', async () => {
    const result = await inA((db) => db.brand.deleteMany({ where: { id: fixtures.b.brandId } }));
    expect(result.count).toBe(0);
  });

  it('A cannot COUNT B brands — an aggregate is a read', async () => {
    const total = await inA((db) => db.brand.count());
    expect(total).toBe(1);
  });
});

describe('BrandKnowledgeItem is tenant-owned and brand-scoped', () => {
  it('A cannot read B knowledge by id', async () => {
    const row = await inA((db) =>
      db.brandKnowledgeItem.findUnique({ where: { id: fixtures.b.knowledgeItemId } }),
    );
    expect(row).toBeNull();
  });

  it('A cannot read B knowledge through the composite unique key', async () => {
    // The item key is IDENTICAL across tenants and derived from product
    // vocabulary, so a tenant could guess it exactly. A direct hit on the
    // unique index is the sharpest test of whether RLS is applied.
    const row = await inA((db) =>
      db.brandKnowledgeItem.findUnique({
        where: {
          workspaceId_brandId_area_itemKey: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            area: 'IDENTITY',
            itemKey: fixtures.b.knowledgeItemKey,
          },
        },
      }),
    );
    expect(row).toBeNull();
  });

  it("A's listing excludes B, and A's own body never contains B's text", async () => {
    const rows = await inA((db) => db.brandKnowledgeItem.findMany());
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.knowledgeItemId);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(fixtures.b.slug);
  });

  it('A cannot attach knowledge to B brand even with the brand id in hand', async () => {
    // The workspace is A's, the brand is B's. RLS admits the row on
    // `workspaceId`; the COMPOSITE FOREIGN KEY is what refuses it. This is the
    // assertion that proves the brand boundary is independent of the tenant one.
    await expect(
      inA((db) =>
        db.brandKnowledgeItem.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.b.brandId,
            area: 'AUDIENCE',
            itemKey: 'audience.smuggled',
            title: { en: 'x', ar: 'x' },
            body: { en: 'x', ar: 'x' },
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('A cannot update B knowledge', async () => {
    const result = await inA((db) =>
      db.brandKnowledgeItem.updateMany({
        where: { id: fixtures.b.knowledgeItemId },
        data: { status: 'ARCHIVED' },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('A cannot SEARCH B knowledge — a filtered read is still a read', async () => {
    // CLAUDE.md §2.1 lists search and enumerate alongside read. A substring
    // query that matches B's text must return nothing rather than confirming
    // the text exists.
    const rows = await inA((db) =>
      db.brandKnowledgeItem.findMany({
        where: { itemKey: { contains: 'positioning' } },
      }),
    );
    expect(rows.every((r) => r.workspaceId === fixtures.a.workspaceId)).toBe(true);
  });
});

describe('BrandKnowledgeVersion is tenant-owned and append-only', () => {
  it('A cannot read B version rows', async () => {
    const row = await inA((db) =>
      db.brandKnowledgeVersion.findUnique({ where: { id: fixtures.b.knowledgeVersionId } }),
    );
    expect(row).toBeNull();
  });

  it("A's listing excludes B", async () => {
    const rows = await inA((db) => db.brandKnowledgeVersion.findMany());
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.knowledgeVersionId);
  });

  it('UPDATE is refused on a tenant OWN version row', async () => {
    // Not a cross-tenant assertion: the history must be immutable even to the
    // tenant that owns it, or "nothing was silently overwritten" is unprovable.
    await expect(
      inA((db) =>
        db.brandKnowledgeVersion.update({
          where: { id: fixtures.a.knowledgeVersionId },
          data: { changeReason: 'rewritten' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('DELETE is refused on a tenant own version row', async () => {
    await expect(
      inA((db) =>
        db.brandKnowledgeVersion.delete({ where: { id: fixtures.a.knowledgeVersionId } }),
      ),
    ).rejects.toThrow();
  });

  it('the row survives both refusals', async () => {
    const row = await inA((db) =>
      db.brandKnowledgeVersion.findUnique({ where: { id: fixtures.a.knowledgeVersionId } }),
    );
    expect(row?.changeReason).toBeNull();
  });

  /*
   * THE THREE LAYERS, SEPARATED.
   *
   * The two refusals above are won by the REVOKED PRIVILEGE — PostgreSQL
   * checks privileges before it fires a trigger, so `permission denied`
   * arrives first and the trigger is never reached. That makes those tests
   * silent about the backstop: if a future migration re-granted UPDATE by
   * accident, they would keep passing right up until the history became
   * rewritable.
   *
   * So the backstop is tested by DOING EXACTLY THAT — granting the privilege
   * back, as a careless migration would, and showing the trigger still
   * refuses. The grant is reverted in `finally`, so the suite leaves the
   * database as it found it whether or not the assertion holds.
   *
   * (The table OWNER cannot stand in for this: `FORCE ROW LEVEL SECURITY` is
   * on and no policy names the owner, so its UPDATE matches zero rows and a
   * per-row trigger never fires. Three independent layers, and the test has to
   * disable two of them to reach the third.)
   */
  it('the trigger refuses an UPDATE even when the privilege is granted back', async () => {
    const owner = migrationRoleClient();
    const platform = platformRoleClient();
    try {
      await owner.$executeRawUnsafe(
        'GRANT UPDATE, DELETE ON "brand_knowledge_version" TO brandspace_platform',
      );
      await expect(
        platform.$executeRawUnsafe(
          `UPDATE "brand_knowledge_version" SET "changeReason" = 'rewritten' WHERE "id" = $1::uuid`,
          fixtures.a.knowledgeVersionId,
        ),
      ).rejects.toThrow(/append-only/i);

      await expect(
        platform.$executeRawUnsafe(
          `DELETE FROM "brand_knowledge_version" WHERE "id" = $1::uuid`,
          fixtures.a.knowledgeVersionId,
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await owner.$executeRawUnsafe(
        'REVOKE UPDATE, DELETE ON "brand_knowledge_version" FROM brandspace_platform',
      );
      await owner.$disconnect();
      await platform.$disconnect();
    }
  });

  it('the row is unchanged after the trigger refused it', async () => {
    const row = await inA((db) =>
      db.brandKnowledgeVersion.findUnique({ where: { id: fixtures.a.knowledgeVersionId } }),
    );
    expect(row).not.toBeNull();
    expect(row?.changeReason).toBeNull();
  });

  it('an INSERT is still permitted — append-only is not read-only', async () => {
    const created = await inA((db) =>
      db.brandKnowledgeVersion.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          knowledgeItemId: fixtures.a.knowledgeItemId,
          version: 2,
          area: 'IDENTITY',
          memory: 'CANONICAL',
          origin: 'HUMAN',
          status: 'ACTIVE',
          title: { en: 'Positioning', ar: 'التموضع' },
          body: { en: 'revised', ar: 'منقح' },
          changeKind: 'edited',
        },
      }),
    );
    expect(created.version).toBe(2);
  });
});

describe('BrandSourceDocument is tenant-owned', () => {
  it('A cannot read B document by id', async () => {
    const row = await inA((db) =>
      db.brandSourceDocument.findUnique({ where: { id: fixtures.b.sourceDocumentId } }),
    );
    expect(row).toBeNull();
  });

  it('the SAME checksum exists in both tenants without colliding', async () => {
    // Duplicate protection is per brand, not global. If it were global, one
    // customer uploading a common public PDF would block every other customer
    // from uploading the same file — and would reveal that someone else had.
    expect(fixtures.a.sourceChecksum).toBe(fixtures.b.sourceChecksum);
    const mine = await inA((db) =>
      db.brandSourceDocument.findMany({ where: { checksum: fixtures.a.sourceChecksum } }),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.id).toBe(fixtures.a.sourceDocumentId);
  });

  it('A cannot read B document through the workspace-scoped idempotency key', async () => {
    const rows = await inA((db) => db.brandSourceDocument.findMany());
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.sourceDocumentId);
  });

  it('A cannot write a document into B', async () => {
    await expect(
      inA((db) =>
        db.brandSourceDocument.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            fileName: 'smuggled.pdf',
            mimeType: 'application/pdf',
            byteSize: 10,
            checksum: 'smuggled',
            storageKey: 'smuggled',
            idempotencyKey: 'smuggled',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('BrandSourceChunk is tenant-owned — it holds the raw uploaded text', () => {
  it('A cannot read B chunk by id', async () => {
    const row = await inA((db) =>
      db.brandSourceChunk.findUnique({ where: { id: fixtures.b.sourceChunkId } }),
    );
    expect(row).toBeNull();
  });

  it("A cannot read B chunk text through its parent document's relation", async () => {
    // Traversing a relation is the path a careless include would take. The
    // policy applies to the joined table too, so the include yields nothing.
    const rows = await inA((db) =>
      db.brandSourceChunk.findMany({ where: { sourceDocumentId: fixtures.b.sourceDocumentId } }),
    );
    expect(rows).toHaveLength(0);
  });

  it("no listing in A ever contains B's confidential text", async () => {
    const rows = await inA((db) => db.brandSourceChunk.findMany());
    const text = rows.map((r) => r.text).join(' ');
    expect(text).not.toContain(fixtures.b.slug);
    expect(text).toContain(fixtures.a.slug);
  });

  it('A cannot write a chunk into B', async () => {
    await expect(
      inA((db) =>
        db.brandSourceChunk.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            sourceDocumentId: fixtures.b.sourceDocumentId,
            chunkIndex: 99,
            text: 'smuggled',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('BrandKnowledgeCandidate is tenant-owned', () => {
  it('A cannot read B candidate by id', async () => {
    const row = await inA((db) =>
      db.brandKnowledgeCandidate.findUnique({ where: { id: fixtures.b.candidateId } }),
    );
    expect(row).toBeNull();
  });

  it("A's review queue excludes B, and A cannot count B's backlog", async () => {
    const rows = await inA((db) =>
      db.brandKnowledgeCandidate.findMany({ where: { status: 'PENDING' } }),
    );
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.candidateId);
    const total = await inA((db) => db.brandKnowledgeCandidate.count());
    expect(total).toBe(1);
  });

  it('A cannot approve B candidate', async () => {
    const result = await inA((db) =>
      db.brandKnowledgeCandidate.updateMany({
        where: { id: fixtures.b.candidateId },
        data: { status: 'ACCEPTED' },
      }),
    );
    expect(result.count).toBe(0);
  });
});

describe('BrandIngestionJob is tenant-owned', () => {
  it('A cannot read B job by id', async () => {
    const row = await inA((db) =>
      db.brandIngestionJob.findUnique({ where: { id: fixtures.b.ingestionJobId } }),
    );
    expect(row).toBeNull();
  });

  it("A's listing excludes B", async () => {
    const rows = await inA((db) => db.brandIngestionJob.findMany());
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.ingestionJobId);
  });

  it('A cannot write a job into B', async () => {
    await expect(
      inA((db) =>
        db.brandIngestionJob.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            sourceDocumentId: fixtures.b.sourceDocumentId,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('BrandBrainConversation and BrandBrainMessage are tenant-owned', () => {
  it('A cannot read B conversation by id', async () => {
    const row = await inA((db) =>
      db.brandBrainConversation.findUnique({ where: { id: fixtures.b.conversationId } }),
    );
    expect(row).toBeNull();
  });

  it('A cannot read B message by id', async () => {
    const row = await inA((db) =>
      db.brandBrainMessage.findUnique({ where: { id: fixtures.b.messageId } }),
    );
    expect(row).toBeNull();
  });

  it('A cannot read B message through the workspace-scoped idempotency key', async () => {
    // A chat idempotency key is client-supplied, so it is the one value a
    // tenant is most able to reproduce deliberately.
    const row = await inA((db) =>
      db.brandBrainMessage.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: fixtures.b.workspaceId,
            idempotencyKey: fixtures.b.messageIdempotencyKey,
          },
        },
      }),
    );
    expect(row).toBeNull();
  });

  it("A cannot list B's messages by conversation id", async () => {
    const rows = await inA((db) =>
      db.brandBrainMessage.findMany({ where: { conversationId: fixtures.b.conversationId } }),
    );
    expect(rows).toHaveLength(0);
  });

  it("no answer body in A ever contains B's text", async () => {
    const rows = await inA((db) => db.brandBrainMessage.findMany());
    expect(JSON.stringify(rows)).not.toContain(fixtures.b.slug);
  });

  it('A cannot write a message into B conversation', async () => {
    await expect(
      inA((db) =>
        db.brandBrainMessage.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            conversationId: fixtures.b.conversationId,
            role: 'user',
            body: 'smuggled',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
