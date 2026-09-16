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
// F-83 — the five keys F-80 missed, because F-80 looked at three tables and
// the module has eight. Same class, same fix, and two of them reach places
// F-80's three did not: the GOVERNANCE boundary and the APPEND-ONLY history.
// ---------------------------------------------------------------------------

describe('F-83: the knowledge tables refuse a foreign parent id too', () => {
  it('brand_knowledge_candidate.sourceDocumentId — B document, A workspace', async () => {
    const { code, sqlState, constraint } = await refusal(
      inA((db) =>
        db.brandKnowledgeCandidate.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            sourceDocumentId: fixtures.b.sourceDocumentId,
            area: 'IDENTITY',
            itemKey: 'identity.probe',
            extractedTitle: { en: 'probe', ar: 'probe' },
            extractedBody: { en: 'probe', ar: 'probe' },
            confidenceMilli: 500,
            evidence: [],
          },
        }),
      ),
    );
    expect(code).toBe('P2003');
    expect(sqlState).toBe('23503');
    expect(constraint).toBe('brand_knowledge_candidate_document_fkey');
  });

  it('brand_knowledge_candidate.targetItemId — B item, A workspace', async () => {
    /*
     * THE GOVERNANCE BOUNDARY (D-65). `targetItemId` names the approved item a
     * candidate would EDIT once a reviewer accepts it, and the review screen
     * diffs the two. A foreign id here pointed that diff at another tenant's
     * approved brand knowledge.
     */
    const { code, sqlState, constraint } = await refusal(
      inA((db) =>
        db.brandKnowledgeCandidate.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            sourceDocumentId: fixtures.a.sourceDocumentId,
            targetItemId: fixtures.b.knowledgeItemId,
            area: 'IDENTITY',
            itemKey: 'identity.probe',
            extractedTitle: { en: 'probe', ar: 'probe' },
            extractedBody: { en: 'probe', ar: 'probe' },
            confidenceMilli: 500,
            evidence: [],
          },
        }),
      ),
    );
    expect(code).toBe('P2003');
    expect(sqlState).toBe('23503');
    expect(constraint).toBe('brand_knowledge_candidate_target_fkey');
  });

  it('brand_knowledge_item.sourceDocumentId — B document, A workspace', async () => {
    const { code, sqlState, constraint } = await refusal(
      inA((db) =>
        db.brandKnowledgeItem.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            sourceDocumentId: fixtures.b.sourceDocumentId,
            area: 'IDENTITY',
            itemKey: `identity.probe-source-${Date.now()}`,
            title: { en: 'probe', ar: 'probe' },
            body: { en: 'probe', ar: 'probe' },
          },
        }),
      ),
    );
    expect(code).toBe('P2003');
    expect(sqlState).toBe('23503');
    expect(constraint).toBe('brand_knowledge_item_source_fkey');
  });

  it('brand_knowledge_item.conflictsWithItemId — B item, A workspace', async () => {
    /*
     * A SELF-REFERENCE, and the sharpest oracle of the eight: it asked "is this
     * id a knowledge item somewhere on the platform" of the very table holding
     * every tenant's approved brand knowledge. It would also have published a
     * conflict between two tenants' items — a state the review UI renders.
     */
    const { code, sqlState, constraint } = await refusal(
      inA((db) =>
        db.brandKnowledgeItem.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            conflictsWithItemId: fixtures.b.knowledgeItemId,
            area: 'IDENTITY',
            itemKey: `identity.probe-conflict-${Date.now()}`,
            title: { en: 'probe', ar: 'probe' },
            body: { en: 'probe', ar: 'probe' },
          },
        }),
      ),
    );
    expect(code).toBe('P2003');
    expect(sqlState).toBe('23503');
    expect(constraint).toBe('brand_knowledge_item_conflict_fkey');
  });

  it('brand_knowledge_version.knowledgeItemId — B item, A workspace', async () => {
    /*
     * THE APPEND-ONLY HISTORY. A version row carries the title and body it
     * recorded, so a row misattached to another tenant's item is that tenant's
     * approved knowledge filed under someone else's identity — and the table
     * is append-only, so nothing could edit it afterwards.
     */
    const { code, sqlState, constraint } = await refusal(
      inA((db) =>
        db.brandKnowledgeVersion.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            knowledgeItemId: fixtures.b.knowledgeItemId,
            version: 99,
            area: 'IDENTITY',
            memory: 'CANONICAL',
            origin: 'HUMAN',
            status: 'ACTIVE',
            title: { en: 'probe', ar: 'probe' },
            body: { en: 'probe', ar: 'probe' },
            changeKind: 'created',
          },
        }),
      ),
    );
    expect(code).toBe('P2003');
    expect(sqlState).toBe('23503');
    expect(constraint).toBe('brand_knowledge_version_item_fkey');
  });

  it('a real foreign item id and a fabricated one fail identically', async () => {
    const makeVersion = (knowledgeItemId: string) =>
      inA((db) =>
        db.brandKnowledgeVersion.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            knowledgeItemId,
            version: 98,
            area: 'IDENTITY',
            memory: 'CANONICAL',
            origin: 'HUMAN',
            status: 'ACTIVE',
            title: { en: 'probe', ar: 'probe' },
            body: { en: 'probe', ar: 'probe' },
            changeKind: 'created',
          },
        }),
      );

    const real = await refusal(makeVersion(fixtures.b.knowledgeItemId));
    const invented = await refusal(makeVersion(fabricatedId()));
    expect(real).toEqual(invented);
  });
});

describe('F-83: the knowledge relationships still work inside one workspace', () => {
  it('a candidate attaches to its own document and targets its own item', async () => {
    const created = await inA((db) =>
      db.brandKnowledgeCandidate.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          sourceDocumentId: fixtures.a.sourceDocumentId,
          targetItemId: fixtures.a.knowledgeItemId,
          area: 'IDENTITY',
          itemKey: 'identity.same-workspace',
          extractedTitle: { en: 'ok', ar: 'ok' },
          extractedBody: { en: 'ok', ar: 'ok' },
          confidenceMilli: 700,
          evidence: [],
        },
      }),
    );
    expect(created.targetItemId).toBe(fixtures.a.knowledgeItemId);
    await inA((db) => db.brandKnowledgeCandidate.delete({ where: { id: created.id } }));
  });

  it('a NULL targetItemId is accepted — that is a candidate proposing something NEW', async () => {
    /*
     * THE MATCH SIMPLE EXEMPTION, exercised rather than assumed. A composite
     * key is satisfied whenever any referencing column is NULL, which is what
     * keeps "this candidate proposes a new item" legal. If that ever stopped
     * being true, extraction would break for every genuinely new fact.
     */
    const created = await inA((db) =>
      db.brandKnowledgeCandidate.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          sourceDocumentId: fixtures.a.sourceDocumentId,
          targetItemId: null,
          area: 'IDENTITY',
          itemKey: 'identity.brand-new',
          extractedTitle: { en: 'new', ar: 'new' },
          extractedBody: { en: 'new', ar: 'new' },
          confidenceMilli: 700,
          evidence: [],
        },
      }),
    );
    expect(created.targetItemId).toBeNull();
    await inA((db) => db.brandKnowledgeCandidate.delete({ where: { id: created.id } }));
  });

  it('an item may conflict with another item in the SAME workspace', async () => {
    const created = await inA((db) =>
      db.brandKnowledgeItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          conflictsWithItemId: fixtures.a.knowledgeItemId,
          sourceDocumentId: fixtures.a.sourceDocumentId,
          area: 'IDENTITY',
          itemKey: `identity.conflict-ok-${Date.now()}`,
          title: { en: 'ok', ar: 'ok' },
          body: { en: 'ok', ar: 'ok' },
        },
      }),
    );
    expect(created.conflictsWithItemId).toBe(fixtures.a.knowledgeItemId);
    await inA((db) => db.brandKnowledgeItem.delete({ where: { id: created.id } }));
  });
});

describe('F-83: ON DELETE SET NULL nulls the reference and NEVER the tenant key', () => {
  it('deleting a source document nulls the item reference and leaves workspaceId intact', async () => {
    /*
     * THE BEHAVIOURAL HALF of the `confdelsetcols` assertion in the catalogue
     * block. Written as a real delete because the failure mode this guards
     * against is not subtle at runtime: with a bare composite SET NULL,
     * PostgreSQL would try to null `workspaceId` too, hit its NOT NULL, and the
     * customer's delete would fail. Nothing in the migration diff would look
     * wrong; the first symptom would be a customer unable to remove a file.
     */
    const doc = await inA((db) =>
      db.brandSourceDocument.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          fileName: 'set-null-probe.txt',
          mimeType: 'text/plain',
          byteSize: 4,
          checksum: `set-null-probe-${fixtures.a.slug}`,
          storageKey: `ws/${fixtures.a.workspaceId}/set-null-probe`,
          idempotencyKey: `set-null-probe-${fixtures.a.slug}`,
        },
      }),
    );

    const item = await inA((db) =>
      db.brandKnowledgeItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          sourceDocumentId: doc.id,
          area: 'IDENTITY',
          itemKey: `identity.set-null-${Date.now()}`,
          title: { en: 'probe', ar: 'probe' },
          body: { en: 'probe', ar: 'probe' },
        },
      }),
    );

    // The delete must SUCCEED. Under a bare composite SET NULL it would raise
    // a not-null violation on "workspaceId" instead.
    await inA((db) => db.brandSourceDocument.delete({ where: { id: doc.id } }));

    const after = await inA((db) => db.brandKnowledgeItem.findUnique({ where: { id: item.id } }));
    expect(after).not.toBeNull();
    expect(after!.sourceDocumentId).toBeNull();
    // The row is still the tenant's, and still readable inside A's context —
    // which is only possible because workspaceId was never touched.
    expect(after!.workspaceId).toBe(fixtures.a.workspaceId);
    expect(after!.brandId).toBe(fixtures.a.brandId);

    await inA((db) => db.brandKnowledgeItem.delete({ where: { id: item.id } }));
  });

  it('deleting a targeted item nulls the candidate reference and leaves workspaceId intact', async () => {
    const item = await inA((db) =>
      db.brandKnowledgeItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          area: 'IDENTITY',
          itemKey: `identity.target-probe-${Date.now()}`,
          title: { en: 'probe', ar: 'probe' },
          body: { en: 'probe', ar: 'probe' },
        },
      }),
    );

    const candidate = await inA((db) =>
      db.brandKnowledgeCandidate.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          sourceDocumentId: fixtures.a.sourceDocumentId,
          targetItemId: item.id,
          area: 'IDENTITY',
          itemKey: 'identity.target-probe',
          extractedTitle: { en: 'probe', ar: 'probe' },
          extractedBody: { en: 'probe', ar: 'probe' },
          confidenceMilli: 600,
          evidence: [],
        },
      }),
    );

    await inA((db) => db.brandKnowledgeItem.delete({ where: { id: item.id } }));

    const after = await inA((db) =>
      db.brandKnowledgeCandidate.findUnique({ where: { id: candidate.id } }),
    );
    expect(after).not.toBeNull();
    expect(after!.targetItemId).toBeNull();
    expect(after!.workspaceId).toBe(fixtures.a.workspaceId);

    await inA((db) => db.brandKnowledgeCandidate.delete({ where: { id: candidate.id } }));
  });
});

// ---------------------------------------------------------------------------
// The catalogue. A future migration that quietly restores a plain key would
// pass every behavioural test above only until someone noticed; this reads the
// database's own definition and fails immediately.
// ---------------------------------------------------------------------------

describe('the constraints are composite in the database catalogue', () => {
  /** Every key F-80 and F-83 replaced, with the delete behaviour it must keep. */
  const expected = [
    // F-80.
    ['brand_source_chunk', 'brand_source_chunk_document_fkey', 'sourceDocumentId', 'CASCADE'],
    ['brand_ingestion_job', 'brand_ingestion_job_document_fkey', 'sourceDocumentId', 'CASCADE'],
    ['brand_brain_message', 'brand_brain_message_conversation_fkey', 'conversationId', 'CASCADE'],
    // F-83.
    [
      'brand_knowledge_candidate',
      'brand_knowledge_candidate_document_fkey',
      'sourceDocumentId',
      'CASCADE',
    ],
    [
      'brand_knowledge_candidate',
      'brand_knowledge_candidate_target_fkey',
      'targetItemId',
      'SET NULL',
    ],
    ['brand_knowledge_item', 'brand_knowledge_item_source_fkey', 'sourceDocumentId', 'SET NULL'],
    [
      'brand_knowledge_item',
      'brand_knowledge_item_conflict_fkey',
      'conflictsWithItemId',
      'SET NULL',
    ],
    ['brand_knowledge_version', 'brand_knowledge_version_item_fkey', 'knowledgeItemId', 'CASCADE'],
  ] as const;

  it.each(expected)(
    '%s.%s references (workspaceId, %s) and still ON DELETE %s',
    async (table, constraint, column, action) => {
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
      // The referential action is PRESERVED, not merely present: a composite
      // key that quietly became RESTRICT would pass every refusal test above
      // and change how the product deletes things.
      expect(definition).toContain(`ON DELETE ${action}`);
    },
  );

  it('every SET NULL key nulls its OWN column and never the tenant key', async () => {
    /*
     * THE ASSERTION THAT KEEPS A DELETE FROM BECOMING A DATA-LOSS BUG.
     *
     * A bare `ON DELETE SET NULL` on a composite key nulls EVERY referencing
     * column — `workspaceId` included. `workspaceId` is NOT NULL, so the parent
     * delete does not corrupt the tenant key; it fails outright, and a customer
     * deleting a source document gets an error instead of a deletion. The
     * migration therefore writes `ON DELETE SET NULL ("<column>")`, and
     * `pg_constraint.confdelsetcols` is where PostgreSQL records that.
     *
     * Read from the catalogue rather than from the clause text, because the
     * column list is the part a future edit would drop without the diff looking
     * any different.
     */
    const rows = await app.$queryRawUnsafe<{ conname: string; columns: string[] }[]>(
      // `attname` is PostgreSQL's `name` type, which the driver cannot
      // deserialise as an array element; cast to text.
      `SELECT c.conname::text AS conname,
              ARRAY(SELECT a.attname::text
                      FROM unnest(c.confdelsetcols) AS s(attnum)
                      JOIN pg_attribute a
                        ON a.attrelid = c.conrelid AND a.attnum = s.attnum) AS columns
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confdeltype = 'n'
          AND c.conrelid IN (
            'brand_knowledge_candidate'::regclass,
            'brand_knowledge_item'::regclass)
        ORDER BY c.conname`,
    );

    expect(rows.map((r) => [r.conname, r.columns])).toEqual([
      /*
       * PHASE 7 ADDED TWO MORE, and they are here rather than exempted: a
       * candidate may now point at the insight it was inferred from and at the
       * human-authored item it conflicts with, and BOTH must null their own
       * column rather than the tenant key when the target goes away. The list
       * grows with the schema, which is the point of pinning it.
       */
      ['brand_knowledge_candidate_conflict_fkey', ['conflictsWithItemId']],
      ['brand_knowledge_candidate_insight_fkey', ['insightId']],
      ['brand_knowledge_candidate_target_fkey', ['targetItemId']],
      ['brand_knowledge_item_conflict_fkey', ['conflictsWithItemId']],
      ['brand_knowledge_item_source_fkey', ['sourceDocumentId']],
    ]);

    for (const row of rows) {
      expect(row.columns, row.conname).not.toContain('workspaceId');
    }
  });

  it('NO plain foreign key of this class survives anywhere in Brand Brain', async () => {
    /*
     * THE WHOLE-MODULE ASSERTION, and the one that would have caught F-83 at
     * the time F-80 was written.
     *
     * F-80 named three keys because three tables were looked at. This query
     * looks at every Brand Brain table at once and asks the catalogue — not a
     * list somebody maintained — whether any single-column foreign key to a
     * tenant-owned parent remains. `workspace` itself is excluded: a key TO the
     * workspace table is the tenant anchor, not a reference that needs scoping.
     *
     * A new Brand Brain table with a plain parent reference fails here on the
     * day it is added, which is the point.
     */
    const rows = await app.$queryRawUnsafe<{ relation: string }[]>(
      `SELECT c.conrelid::regclass || '.' || c.conname AS relation
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'f'
          AND t.relname LIKE 'brand%'
          AND cardinality(c.conkey) = 1
          AND c.confrelid <> 'workspace'::regclass
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.relation)).toEqual([]);
  });

  it('each parent carries the (workspaceId, id) unique the children reference', async () => {
    const rows = await app.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN (
          'brand_source_document_workspaceId_id_key',
          'brand_brain_conversation_workspaceId_id_key',
          'brand_knowledge_item_workspaceId_id_key')
        ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'brand_brain_conversation_workspaceId_id_key',
      'brand_knowledge_item_workspaceId_id_key',
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
