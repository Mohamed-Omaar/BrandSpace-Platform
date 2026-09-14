import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * F-80 — THE THREE PHASE 5A FOREIGN KEYS THAT WERE CROSS-TENANT EXISTENCE
 * ORACLES, AND THE PROOF THEY ARE NOT ANY MORE.
 *
 * WHAT THE EXISTING SUITE ALREADY COVERS, AND WHY IT MISSED THIS.
 * `phase5-tenancy.test.ts` asserts that A cannot write a chunk or a message
 * into B. Every one of those writes carries **B's workspaceId**, so RLS refuses
 * them before a constraint is ever consulted — the assertions are correct and
 * they pass, and they say nothing at all about the case F-80 describes.
 *
 * THE CASE F-80 DESCRIBES IS THE ROW THAT PASSES RLS. It carries A's OWN
 * workspaceId — so the policy is satisfied and the insert reaches the
 * constraints — and a **foreign id** in the reference column. PostgreSQL
 * evaluates referential integrity with RLS BYPASSED, as the table owner rather
 * than as the caller, so a plain `sourceDocumentId` saw B's document perfectly
 * well and accepted it. Two things followed:
 *
 *   1. THE WRITE LANDED. A message could be posted into a conversation its
 *      author could not read, and a chunk attached to a document belonging to
 *      someone else.
 *   2. EVEN WHERE A WRITE FAILED, THE FAILURE TALKED. "Inserted" versus
 *      "constraint violated" answers *does this id exist somewhere on the
 *      platform?* — the inference CLAUDE.md §2.1 forbids, and the same reason
 *      an unauthorised read must be shaped identically to a genuine miss.
 *
 * WHAT IS BEING MEASURED HERE. Every assertion runs through `withWorkspace()`
 * on the APPLICATION role — NOBYPASSRLS, owner of nothing — so what refuses a
 * write is PostgreSQL, never a `where` clause a test remembered. The positive
 * cases matter as much as the negative ones: a composite key that refused
 * everything would pass a suite of refusals and break the product.
 *
 * The migration's own properties — that it upgrades an existing main database
 * without losing a row, and that a migrations-only database has no drift —
 * are proven in `f80-migration-upgrade.test.ts`, which needs its own database
 * and therefore its own file.
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

/** Run inside A's workspace context, on the application role. */
function inA<T>(fn: (db: Parameters<Parameters<typeof withWorkspace>[1]>[0]) => Promise<T>) {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app });
}

/** Everything a refused write tells the caller. */
interface Refusal {
  /** Prisma's error code — P2003 is a foreign-key violation. */
  readonly code: string;
  /** The PostgreSQL SQLSTATE the driver actually received — 23503. */
  readonly sqlState: string;
  /** The constraint PostgreSQL named. */
  readonly constraint: string;
  /** PostgreSQL's own message, which names the table and constraint only. */
  readonly detail: string;
}

/**
 * The shape a caller actually observes when a write is refused.
 *
 * DELIBERATELY THE DRIVER'S VIEW, NOT PRISMA'S SUMMARY. Prisma's `message`
 * quotes the call site and the arguments, so comparing messages would compare
 * the probe rather than the answer. What a probing caller can distinguish is
 * the SQLSTATE, the constraint PostgreSQL named, and PostgreSQL's own message —
 * and those three must be identical between "your id is real but belongs to
 * someone else" and "your id is invented".
 */
async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  let accepted = false;
  try {
    await promise;
    accepted = true;
  } catch (error: unknown) {
    const e = error as {
      code?: unknown;
      meta?: {
        driverAdapterError?: {
          cause?: {
            originalCode?: unknown;
            originalMessage?: unknown;
            constraint?: { index?: unknown };
          };
        };
      };
    };
    const cause = e.meta?.driverAdapterError?.cause;
    return {
      code: String(e.code),
      sqlState: String(cause?.originalCode),
      constraint: String(cause?.constraint?.index),
      detail: String(cause?.originalMessage),
    };
  }
  if (accepted) throw new Error('the write was ACCEPTED; F-80 has regressed');
  throw new Error('unreachable');
}

/** An id that is syntactically valid and belongs to nothing, anywhere. */
function fabricatedId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// The relationships still work. This block comes FIRST on purpose: a boundary
// that also blocks the product is not a fix, and a suite that only proves
// refusals cannot tell the two apart.
// ---------------------------------------------------------------------------

describe('within one workspace the three relationships still work', () => {
  it('a chunk attaches to a document in the same workspace', async () => {
    const created = await inA((db) =>
      db.brandSourceChunk.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          sourceDocumentId: fixtures.a.sourceDocumentId,
          chunkIndex: 9_001,
          text: `same-workspace chunk for ${fixtures.a.slug}`,
          locator: 'page 1',
        },
      }),
    );
    expect(created.sourceDocumentId).toBe(fixtures.a.sourceDocumentId);

    // And it reads back through the relation, which is the path retrieval takes.
    const readBack = await inA((db) =>
      db.brandSourceChunk.findUnique({
        where: { id: created.id },
        include: { document: true },
      }),
    );
    expect(readBack?.document.id).toBe(fixtures.a.sourceDocumentId);

    await inA((db) => db.brandSourceChunk.delete({ where: { id: created.id } }));
  });

  it('an ingestion job attaches to a document in the same workspace', async () => {
    const created = await inA((db) =>
      db.brandIngestionJob.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          sourceDocumentId: fixtures.a.sourceDocumentId,
          // A TERMINAL stage, so this row does not collide with the partial
          // unique index that keeps at most one LIVE job per document.
          stage: 'COMPLETED',
        },
      }),
    );
    expect(created.sourceDocumentId).toBe(fixtures.a.sourceDocumentId);
    await inA((db) => db.brandIngestionJob.delete({ where: { id: created.id } }));
  });

  it('a message attaches to a conversation in the same workspace', async () => {
    const created = await inA((db) =>
      db.brandBrainMessage.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          conversationId: fixtures.a.conversationId,
          role: 'user',
          body: `same-workspace message for ${fixtures.a.slug}`,
        },
      }),
    );
    expect(created.conversationId).toBe(fixtures.a.conversationId);

    const readBack = await inA((db) =>
      db.brandBrainMessage.findUnique({
        where: { id: created.id },
        include: { conversation: true },
      }),
    );
    expect(readBack?.conversation.id).toBe(fixtures.a.conversationId);

    await inA((db) => db.brandBrainMessage.delete({ where: { id: created.id } }));
  });

  it('deleting a document still cascades to its chunks and jobs', async () => {
    /*
     * ON DELETE CASCADE HAD TO SURVIVE THE CHANGE. The composite key replaced
     * a plain one that cascaded; had the replacement dropped that, a deleted
     * document would leave orphans behind and the deletion path would start
     * failing on a constraint instead. Asserted on a throwaway document so
     * nothing the other suites rely on is removed.
     */
    const doc = await inA((db) =>
      db.brandSourceDocument.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          fileName: 'cascade-probe.txt',
          mimeType: 'text/plain',
          byteSize: 12,
          checksum: `cascade-probe-${fixtures.a.slug}`,
          storageKey: `ws/${fixtures.a.workspaceId}/cascade-probe`,
          idempotencyKey: `cascade-probe-${fixtures.a.slug}`,
        },
      }),
    );

    await inA((db) =>
      db.brandSourceChunk.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          sourceDocumentId: doc.id,
          chunkIndex: 0,
          text: 'cascade probe',
        },
      }),
    );
    await inA((db) =>
      db.brandIngestionJob.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          sourceDocumentId: doc.id,
          stage: 'COMPLETED',
        },
      }),
    );

    await inA((db) => db.brandSourceDocument.delete({ where: { id: doc.id } }));

    expect(
      await inA((db) => db.brandSourceChunk.count({ where: { sourceDocumentId: doc.id } })),
    ).toBe(0);
    expect(
      await inA((db) => db.brandIngestionJob.count({ where: { sourceDocumentId: doc.id } })),
    ).toBe(0);
  });

  it('deleting a conversation still cascades to its messages', async () => {
    const conversation = await inA((db) =>
      db.brandBrainConversation.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          title: 'cascade probe',
        },
      }),
    );
    await inA((db) =>
      db.brandBrainMessage.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          conversationId: conversation.id,
          role: 'user',
          body: 'cascade probe',
        },
      }),
    );

    await inA((db) => db.brandBrainConversation.delete({ where: { id: conversation.id } }));

    expect(
      await inA((db) => db.brandBrainMessage.count({ where: { conversationId: conversation.id } })),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The refusals. Each of these three inserts was ACCEPTED before this change.
// ---------------------------------------------------------------------------

describe("a foreign parent id is refused by PostgreSQL, from inside the caller's OWN workspace", () => {
  it('brand_source_chunk.sourceDocumentId — B document, A workspace', async () => {
    /*
     * THE ROW IS LEGAL AS FAR AS RLS IS CONCERNED. `workspaceId` is A's, so the
     * tenant policy admits it and the insert reaches the constraints. What
     * refuses it is `brand_source_chunk_document_fkey` on
     * `(workspaceId, sourceDocumentId)`: the PAIR (A, B-document) does not
     * exist, even though the document does.
     */
    const { code, sqlState, constraint } = await refusal(
      inA((db) =>
        db.brandSourceChunk.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            sourceDocumentId: fixtures.b.sourceDocumentId,
            chunkIndex: 9_100,
            text: 'attached to a document in another workspace',
          },
        }),
      ),
    );
    // P2003 is Prisma's foreign-key violation; 23503 is PostgreSQL's own.
    expect(code).toBe('P2003');
    expect(sqlState).toBe('23503');
    expect(constraint).toBe('brand_source_chunk_document_fkey');
  });

  it('brand_ingestion_job.sourceDocumentId — B document, A workspace', async () => {
    const { code, sqlState, constraint } = await refusal(
      inA((db) =>
        db.brandIngestionJob.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            sourceDocumentId: fixtures.b.sourceDocumentId,
            stage: 'QUEUED',
          },
        }),
      ),
    );
    expect(code).toBe('P2003');
    expect(sqlState).toBe('23503');
    expect(constraint).toBe('brand_ingestion_job_document_fkey');
  });

  it('brand_brain_message.conversationId — B conversation, A workspace', async () => {
    /*
     * THE SHARPEST OF THE THREE. This insert previously SUCCEEDED: a leaked
     * conversation id was not merely probeable but writable, and the message
     * landed in a conversation its author could not read — visible to the other
     * tenant, attributable to nobody they know.
     */
    const { code, sqlState, constraint } = await refusal(
      inA((db) =>
        db.brandBrainMessage.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            conversationId: fixtures.b.conversationId,
            role: 'user',
            body: 'posted into another tenant conversation',
          },
        }),
      ),
    );
    expect(code).toBe('P2003');
    expect(sqlState).toBe('23503');
    expect(constraint).toBe('brand_brain_message_conversation_fkey');
  });

  it('an UPDATE cannot move an existing row onto a foreign parent either', async () => {
    /*
     * A CONSTRAINT THAT ONLY GUARDED INSERT WOULD BE HALF A BOUNDARY. Create a
     * legitimate row, then try to repoint it at B's conversation — the same
     * refusal has to apply.
     */
    const mine = await inA((db) =>
      db.brandBrainMessage.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          conversationId: fixtures.a.conversationId,
          role: 'user',
          body: 'legitimate',
        },
      }),
    );

    const { code, sqlState, constraint } = await refusal(
      inA((db) =>
        db.brandBrainMessage.update({
          where: { id: mine.id },
          data: { conversationId: fixtures.b.conversationId },
        }),
      ),
    );
    expect(code).toBe('P2003');
    expect(sqlState).toBe('23503');
    expect(constraint).toBe('brand_brain_message_conversation_fkey');

    await inA((db) => db.brandBrainMessage.delete({ where: { id: mine.id } }));
  });
});

// ---------------------------------------------------------------------------
// The oracle itself. The refusals above are necessary; this is the part that
// makes them SUFFICIENT.
// ---------------------------------------------------------------------------

describe('the refusal discloses nothing about whether the foreign id exists', () => {
  /*
   * WHY THIS IS THE ASSERTION THAT MATTERS.
   *
   * A boundary that refuses a real foreign id with one error and an invented id
   * with a different one has not closed the leak — it has moved it. The caller
   * still learns "this id names something", which across a few thousand probes
   * is an enumeration of another tenant's documents and conversations.
   *
   * So each case is run TWICE: once with the other tenant's genuine id, once
   * with a UUID that belongs to nothing. What the caller can observe — the
   * error class and the constraint named — must be BYTE-IDENTICAL. This is the
   * write-side form of the same rule §2.1 states for reads, where an
   * unauthorised hit must be shaped exactly like a genuine miss.
   */

  it('a real foreign document id and a fabricated one fail identically (chunk)', async () => {
    const makeChunk = (sourceDocumentId: string) =>
      inA((db) =>
        db.brandSourceChunk.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            sourceDocumentId,
            chunkIndex: 9_200,
            text: 'probe',
          },
        }),
      );

    const real = await refusal(makeChunk(fixtures.b.sourceDocumentId));
    const invented = await refusal(makeChunk(fabricatedId()));

    expect(real).toEqual(invented);
  });

  it('a real foreign document id and a fabricated one fail identically (ingestion job)', async () => {
    const makeJob = (sourceDocumentId: string) =>
      inA((db) =>
        db.brandIngestionJob.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            sourceDocumentId,
            stage: 'QUEUED',
          },
        }),
      );

    const real = await refusal(makeJob(fixtures.b.sourceDocumentId));
    const invented = await refusal(makeJob(fabricatedId()));

    expect(real).toEqual(invented);
  });

  it('a real foreign conversation id and a fabricated one fail identically (message)', async () => {
    const makeMessage = (conversationId: string) =>
      inA((db) =>
        db.brandBrainMessage.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            conversationId,
            role: 'user',
            body: 'probe',
          },
        }),
      );

    const real = await refusal(makeMessage(fixtures.b.conversationId));
    const invented = await refusal(makeMessage(fabricatedId()));

    expect(real).toEqual(invented);
  });

  it('a read of a foreign parent is a plain miss, not a forbidden', async () => {
    /*
     * THE READ HALF, restated here so the two sides are visible together: the
     * write now behaves the way the read always did. A's context cannot see B's
     * document at all, so the service's 404 is a genuine "not found" rather
     * than a masked "not yours" — nothing downstream had to remember to mask it.
     */
    expect(
      await inA((db) =>
        db.brandSourceDocument.findUnique({ where: { id: fixtures.b.sourceDocumentId } }),
      ),
    ).toBeNull();
    expect(
      await inA((db) => db.brandSourceDocument.findUnique({ where: { id: fabricatedId() } })),
    ).toBeNull();
    expect(
      await inA((db) =>
        db.brandBrainConversation.findUnique({ where: { id: fixtures.b.conversationId } }),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The catalogue. A future migration that quietly restores a plain key would
// pass every behavioural test above only until someone noticed; this reads the
// database's own definition and fails immediately.
// ---------------------------------------------------------------------------

describe('the constraints are composite in the database catalogue', () => {
  const expected = [
    ['brand_source_chunk', 'brand_source_chunk_document_fkey', 'sourceDocumentId'],
    ['brand_ingestion_job', 'brand_ingestion_job_document_fkey', 'sourceDocumentId'],
    ['brand_brain_message', 'brand_brain_message_conversation_fkey', 'conversationId'],
  ] as const;

  it.each(expected)('%s.%s references (workspaceId, %s)', async (table, constraint, column) => {
    const rows = await app.$queryRawUnsafe<{ definition: string }[]>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE contype = 'f' AND conname = $1 AND conrelid = $2::regclass`,
      constraint,
      table,
    );

    expect(rows).toHaveLength(1);
    const definition = rows[0]!.definition;
    expect(definition).toContain(`FOREIGN KEY ("workspaceId", "${column}")`);
    expect(definition).toContain('ON DELETE CASCADE');
  });

  it('no plain single-column key to either parent survives', async () => {
    /*
     * DROPPING THE OLD CONSTRAINT IS PART OF THE FIX, NOT HOUSEKEEPING. Leaving
     * it in place beside the composite one would keep the oracle alive: the
     * plain key would still be consulted, and still answer.
     */
    const rows = await app.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname
         FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid IN (
            'brand_source_chunk'::regclass,
            'brand_ingestion_job'::regclass,
            'brand_brain_message'::regclass)
          AND cardinality(conkey) = 1
          AND confrelid IN (
            'brand_source_document'::regclass,
            'brand_brain_conversation'::regclass)`,
    );
    expect(rows).toEqual([]);
  });

  it('each parent carries the (workspaceId, id) unique the children reference', async () => {
    const rows = await app.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN (
          'brand_source_document_workspaceId_id_key',
          'brand_brain_conversation_workspaceId_id_key')
        ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'brand_brain_conversation_workspaceId_id_key',
      'brand_source_document_workspaceId_id_key',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Nothing else moved.
// ---------------------------------------------------------------------------

describe('the surrounding Phase 5A guarantees are untouched', () => {
  it('RLS is still ENABLED and FORCED on all five tables', async () => {
    const rows = await app.$queryRawUnsafe<{ relname: string; ok: boolean }[]>(
      `SELECT relname, (relrowsecurity AND relforcerowsecurity) AS ok
         FROM pg_class
        WHERE relname IN (
          'brand_source_document', 'brand_source_chunk', 'brand_ingestion_job',
          'brand_brain_conversation', 'brand_brain_message')`,
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.ok, row.relname).toBe(true);
  });

  it('brand_knowledge_version is still append-only to the application role', async () => {
    // The migration issues no GRANT or REVOKE; this proves it did not disturb
    // the three-layer append-only guarantee sitting next door.
    const rows = await app.$queryRawUnsafe<{ privilege_type: string }[]>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_name = 'brand_knowledge_version'
          AND grantee = 'brandspace_app'
          AND privilege_type IN ('UPDATE', 'DELETE')`,
    );
    expect(rows).toEqual([]);
  });

  it('the brand boundary on all three tables still stands', async () => {
    // A row with A's workspace and B's brand must still be refused — the
    // composite brand key was already correct and had to stay correct.
    await expect(
      inA((db) =>
        db.brandBrainConversation.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.b.brandId,
            title: 'cross-brand',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
