import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { QUOTA_FEATURES, UsageService } from '@brandspace/entitlements';
import {
  BrandIngestionService,
  BrandKnowledgeService,
  InMemoryObjectStore,
  extractSourceDocument,
  extractorRegistryFor,
  groundingFor,
  loadCurrentUsage,
  recordKnowledgeUsage,
  removeSource,
  sourceKnowledge,
  usageChangeFor,
  type ExtractionLimits,
  type IngestionPolicy,
  type ReceiveResult,
  type UploadInput,
} from '@brandspace/brand-brain';
import { closeQueues, enqueue, queueFor, queueUrl } from '@brandspace/jobs';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import { docxPackage } from '../support/ooxml';

/**
 * PHASE 2C-4 (Item 5, D5) — SOURCES against real PostgreSQL under the
 * application role (RLS on):
 *
 *   - M6: two LIVE rows with one checksum are impossible; a live FAILED row
 *     holds the slot; a soft-deleted row releases it;
 *   - a refused file is a FAILED row (zero bytes, nothing stored or charged),
 *     and the same bytes again return it — never a constraint error;
 *   - a file that failed DURING processing: re-upload returns it, Read again
 *     retries it through the pipeline, Remove + re-upload starts afresh;
 *   - Read again is a NEW job with a new dispatch id, and really runs;
 *   - Remove: soft delete, chunks gone, PENDING → SUPERSEDED, the stored bytes
 *     refunded ONCE; Keep leaves facts alone; Drop archives only what the source
 *     CURRENTLY owns, through `archiveItem`, and D10 sees it;
 *   - tenant and brand isolation of every source path;
 *   - chunks, source text and pending proposals never reach grounding.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
/** One store for the whole file: bytes written in one transaction are read in the next. */
const store = new InMemoryObjectStore();

const TEXT = 'text/plain';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const POLICY: IngestionPolicy = {
  allowedMimeTypes: [TEXT, 'text/csv', 'text/markdown', DOCX],
  maxFileBytes: 64 * 1024,
  maxDocumentsPerBrand: 200,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  chunkTargetChars: 400,
  chunkOverlapChars: 50,
  maxChunksPerDocument: 50,
  minimumCandidateConfidenceMilli: 400,
};

const LIMITS: ExtractionLimits = {
  maxPages: 50,
  maxTextChars: 200_000,
  maxArchiveEntries: 64,
  maxArchiveBytes: 4 * 1024 * 1024,
  maxCompressionRatio: 200,
  timeoutMs: 20_000,
};

const STALENESS = { reviewIntervalDays: 90 };

type Scoped = TenantScopedClient;

const inA = <T>(fn: (db: Scoped) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: Scoped) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

async function service(db: Scoped, workspaceId: string): Promise<BrandIngestionService> {
  return new BrandIngestionService({
    db,
    workspaceId,
    store,
    policy: POLICY,
    storage: { usage: new UsageService({ prisma: db as unknown as PrismaClient }), limitGb: null },
    extractors: await extractorRegistryFor(LIMITS),
  });
}

const uploader = (brandScope: readonly string[] = []) => ({
  actorUserId: fixtures.a.userId,
  actorBrandScope: brandScope,
});

function input(bytes: Uint8Array, over: Partial<UploadInput> = {}): UploadInput {
  return {
    brandId: fixtures.a.brandId,
    fileName: 'brand.txt',
    mimeType: TEXT,
    bytes,
    idempotencyKey: `iso2c4:${randomUUID()}`,
    ...uploader(),
    ...over,
  };
}

const receive = (value: UploadInput) =>
  inA(async (db) => (await service(db, fixtures.a.workspaceId)).receive(value));

/** The worker's three steps, each in its own transaction — exactly as production runs them. */
async function runJob(jobId: string) {
  const started = await inA(async (db) =>
    (await service(db, fixtures.a.workspaceId)).startProcessing(jobId),
  );
  const outcome = await extractSourceDocument({
    store,
    extractors: await extractorRegistryFor(LIMITS),
    started,
  });
  return inA(async (db) =>
    (await service(db, fixtures.a.workspaceId)).finishProcessing(started, outcome),
  );
}

/** The workspace's stored-byte counter — the B-8 meter. */
async function storedBytes(workspaceId: string): Promise<bigint> {
  const counter = await platform.usageCounter.findFirst({
    where: { workspaceId, featureKey: QUOTA_FEATURES.storageGb },
    orderBy: { periodStart: 'desc' },
  });
  return counter?.usedBytes ?? 0n;
}

const liveRows = (checksumOf: string) =>
  platform.brandSourceDocument.count({
    where: { workspaceId: fixtures.a.workspaceId, checksum: checksumOf, deletedAt: null },
  });

const member = (permissionKeys: readonly string[], brandScope: readonly string[] = []) => ({
  userId: fixtures.a.userId,
  permissionKeys,
  brandScope,
});

const remove = (documentId: string, mode: 'keep' | 'drop', permissions: readonly string[]) =>
  inA((db) =>
    removeSource(db, {
      workspaceId: fixtures.a.workspaceId,
      documentId,
      mode,
      actor: member(permissions),
      usage: new UsageService({ prisma: db as unknown as PrismaClient }),
    }),
  );

let sentenceCounter = 0;
/** A document of keyword sentences, unique per call so checksums never collide. */
function documentText(extra = ''): string {
  sentenceCounter += 1;
  // Leading words that are unique per call: the extractor derives a fact's KEY
  // from a sentence's first words, so two documents here never share a fact
  // unless a test means them to.
  const tag = `z${randomUUID().slice(0, 8)}${sentenceCounter}`;
  return [
    `${tag} audience is founders of independent bakeries in the Gulf region.`,
    '',
    `${tag} service includes a monthly content package for every client.`,
    extra,
  ].join('\n');
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await closeQueues();
  await app?.$disconnect();
  await platform?.$disconnect();
});

/* ======================================================================== */

describe('M6 — one LIVE source per brand and checksum', () => {
  it('refuses a second live row, lets a removed one go, and a FAILED row holds the slot', async () => {
    const checksum = randomUUID().replace(/-/g, '').padEnd(64, '0');
    const row = (key: string) => ({
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      fileName: 'm6.txt',
      mimeType: TEXT,
      byteSize: 0,
      checksum,
      storageKey: '',
      status: 'FAILED' as const,
      failureMessage: 'unsupported_format',
      idempotencyKey: `m6:${key}`,
    });

    const failed = await inA((db) => db.brandSourceDocument.create({ data: row('one') }));
    // A live FAILED row holds the checksum: a second live row is refused.
    await expect(
      inA((db) => db.brandSourceDocument.create({ data: row('two') })),
    ).rejects.toMatchObject({ code: 'P2002' });

    // Soft-deleted, it releases it: the same checksum is accepted again...
    await inA((db) =>
      db.brandSourceDocument.update({ where: { id: failed.id }, data: { deletedAt: new Date() } }),
    );
    await inA((db) => db.brandSourceDocument.create({ data: row('three') }));
    // ...and two LIVE rows remain impossible.
    await expect(
      inA((db) => db.brandSourceDocument.create({ data: row('four') })),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await liveRows(checksum)).toBe(1);
  });

  it('is the partial index the migration declares', async () => {
    const indexes = await platform.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'brand_source_document'`;
    const names = indexes.map((index) => index.indexname);
    expect(names).toContain('brand_source_document_live_checksum_key');
    expect(names).not.toContain('brand_source_document_workspaceId_brandId_checksum_key');
    const live = indexes.find(
      (index) => index.indexname === 'brand_source_document_live_checksum_key',
    );
    expect(live?.indexdef).toMatch(/UNIQUE/);
    expect(live?.indexdef).toMatch(/WHERE \("deletedAt" IS NULL\)/);
  });
});

/* ======================================================================== */

describe('a refused file is a FAILED row, and the same bytes again return it', () => {
  it('records the refusal: FAILED, zero bytes, no object, no charge, no job, no candidate', async () => {
    const before = await storedBytes(fixtures.a.workspaceId);
    const storedBefore = store.size;
    // A PDF's bytes declared as a Word document: the signature disagrees.
    const bytes = new Uint8Array(Buffer.from(`%PDF-1.4 ${randomUUID()}`, 'latin1'));
    const first = await receive(input(bytes, { fileName: 'renamed.docx', mimeType: DOCX }));

    expect(first.outcome).toBe('refused');
    expect(first.document).toMatchObject({
      status: 'FAILED',
      byteSize: 0,
      storageKey: '',
      failureMessage: 'content_does_not_match_type',
    });
    expect(first.job).toBeNull();
    expect(store.size).toBe(storedBefore);
    expect(await storedBytes(fixtures.a.workspaceId)).toBe(before);
    expect(
      await platform.brandKnowledgeCandidate.count({
        where: { sourceDocumentId: first.document.id },
      }),
    ).toBe(0);
    expect(
      await platform.auditEvent.count({
        where: { resourceId: first.document.id, action: 'brand_brain.source.refused' },
      }),
    ).toBe(1);
  });

  it('the same refused bytes TWICE — same request and another area — return the one row', async () => {
    const bytes = strToU8(`binary\u0000payload ${randomUUID()}`);
    const key = `iso2c4:${randomUUID()}`;
    const first = await receive(input(bytes, { idempotencyKey: key }));
    const again = await receive(input(bytes, { idempotencyKey: key }));
    const otherArea = await receive(input(bytes, { idempotencyKey: `${key}-offers` }));

    expect(first.outcome).toBe('refused');
    // A NUL byte in the first bytes: not text at all, so the signature refuses it.
    expect(first.document.failureMessage).toBe('content_does_not_match_type');
    for (const repeat of [again, otherArea]) {
      expect(repeat.outcome).toBe('existing');
      expect(repeat.document.id).toBe(first.document.id);
      expect(repeat.document.failureMessage).toBe('content_does_not_match_type');
    }
    expect(await liveRows(first.document.checksum)).toBe(1);
  });

  it('refuses an oversize file at exactly one byte over the configured ceiling', async () => {
    const atLimit = new Uint8Array(POLICY.maxFileBytes).fill(0x61);
    atLimit.set(strToU8(`Our audience ${randomUUID()} `), 0);
    const over = new Uint8Array(POLICY.maxFileBytes + 1).fill(0x62);
    const accepted = await receive(input(atLimit));
    const refused = await receive(input(over));
    expect(accepted.outcome).toBe('queued');
    expect(refused.outcome).toBe('refused');
    expect(refused.document.failureMessage).toBe('file_too_large');
  });
});

/* ======================================================================== */

describe('a file that failed DURING processing', () => {
  it('re-upload returns it; Read again retries it; Remove + re-upload starts afresh', async () => {
    // Valid UTF-8 with no text in it: accepted at the door, stored and
    // charged, then failed by the worker (`no_text_found`, terminal).
    const bytes = strToU8(`   \n\t  \n${' '.repeat(randomUUID().length % 7)}  `);
    const unique = new Uint8Array([...bytes, 0x20, 0x20, ...strToU8(' '.repeat(3))]);
    const counter0 = await storedBytes(fixtures.a.workspaceId);

    const first = await receive(input(unique));
    expect(first.outcome).toBe('queued');
    const processed = await runJob(first.job!.id);
    expect(processed.status).toBe('FAILED');
    expect(processed.failureMessage).toBe('no_text_found');
    const counter1 = await storedBytes(fixtures.a.workspaceId);
    expect(counter1 - counter0).toBe(BigInt(unique.byteLength));

    // 1) The same bytes again: the FAILED row, as it stands — nothing charged twice.
    const again = await receive(input(unique));
    expect(again.outcome).toBe('existing');
    expect(again.document.id).toBe(first.document.id);
    expect(again.document.status).toBe('FAILED');
    expect(await storedBytes(fixtures.a.workspaceId)).toBe(counter1);

    // 2) Read again: a NEW job, which really runs, and fails safely again.
    const reread = await inA(async (db) =>
      (await service(db, fixtures.a.workspaceId)).readAgain({
        documentId: first.document.id,
        ...uploader(),
      }),
    );
    expect(reread.job.id).not.toBe(first.job!.id);
    const second = await runJob(reread.job.id);
    expect(second.status).toBe('FAILED');
    const jobs = await platform.brandIngestionJob.findMany({
      where: { sourceDocumentId: first.document.id },
    });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.stage === 'FAILED')).toBe(true);

    // 3) Remove + re-upload: refunded once, a NEW live row, charged afresh.
    await remove(first.document.id, 'keep', ['brand_brain.upload']);
    expect(await storedBytes(fixtures.a.workspaceId)).toBe(counter0);
    const fresh = await receive(input(unique));
    expect(fresh.outcome).toBe('queued');
    expect(fresh.document.id).not.toBe(first.document.id);
    expect(fresh.document.idempotencyKey).not.toBe(first.document.idempotencyKey);
    expect(await liveRows(first.document.checksum)).toBe(1);
    expect(await storedBytes(fixtures.a.workspaceId)).toBe(counter1);
  });

  it('the SAME REQUEST KEY after a removal starts the next generation and is charged again', async () => {
    const bytes = strToU8(documentText());
    const key = `ui:${fixtures.a.workspaceId}:${fixtures.a.brandId}:auto:${randomUUID()}`;
    const before = await storedBytes(fixtures.a.workspaceId);
    const first = await receive(input(bytes, { idempotencyKey: key }));
    await remove(first.document.id, 'keep', ['brand_brain.upload']);
    const second = await receive(input(bytes, { idempotencyKey: key }));
    const replay = await receive(input(bytes, { idempotencyKey: key }));

    expect(second.outcome).toBe('queued');
    expect(second.document.idempotencyKey).toBe(`${key}#2`);
    // A retry of that upload lands on the same live row.
    expect(replay.outcome).toBe('existing');
    expect(replay.document.id).toBe(second.document.id);
    expect(await storedBytes(fixtures.a.workspaceId)).toBe(before + BigInt(bytes.byteLength));
  });
});

/* ======================================================================== */

describe('Read again — a fresh job that really runs', () => {
  it('re-reads after a completed ingestion, creates PENDING proposals only, duplicates nothing approved', async () => {
    const text = documentText();
    const first = await receive(input(strToU8(text)));
    expect((await runJob(first.job!.id)).status).toBe('READY');

    // Accept one proposal: it is now approved knowledge from this document.
    const accepted = await platform.brandKnowledgeCandidate.findFirstOrThrow({
      where: { sourceDocumentId: first.document.id, status: 'PENDING' },
    });
    await inA((db) =>
      new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).reviewCandidate({
        candidateId: accepted.id,
        decision: 'accept',
        actor: member(['brand_brain.review']),
        policy: STALENESS,
      }),
    );
    const itemsBefore = await platform.brandKnowledgeItem.count({
      where: { brandId: fixtures.a.brandId, itemKey: accepted.itemKey },
    });

    const reread = await inA(async (db) =>
      (await service(db, fixtures.a.workspaceId)).readAgain({
        documentId: first.document.id,
        ...uploader(),
      }),
    );
    expect(reread.job.id).not.toBe(first.job!.id);
    expect(reread.job.stage).toBe('QUEUED');
    expect((await runJob(reread.job.id)).status).toBe('READY');

    const after = await platform.brandKnowledgeCandidate.findMany({
      where: { sourceDocumentId: first.document.id },
    });
    // The accepted key is not proposed again; everything new is PENDING.
    expect(after.filter((c) => c.itemKey === accepted.itemKey)).toHaveLength(1);
    expect(after.filter((c) => c.id !== accepted.id).every((c) => c.status === 'PENDING')).toBe(
      true,
    );
    expect(
      await platform.brandKnowledgeItem.count({
        where: { brandId: fixtures.a.brandId, itemKey: accepted.itemKey },
      }),
    ).toBe(itemsBefore);
  });

  it('is refused while a read is still running, and for a file refused before storage', async () => {
    const queued = await receive(input(strToU8(documentText())));
    await expect(
      inA(async (db) =>
        (await service(db, fixtures.a.workspaceId)).readAgain({
          documentId: queued.document.id,
          ...uploader(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const refused = await receive(input(strToU8(`\u0000${randomUUID()}`)));
    await expect(
      inA(async (db) =>
        (await service(db, fixtures.a.workspaceId)).readAgain({
          documentId: refused.document.id,
          ...uploader(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('the dispatch id is new, so a job BullMQ already holds cannot swallow the re-read', async () => {
    if (!queueUrl()) return;
    const queue = queueFor('media-processing');
    const oldId = `ingest-${randomUUID()}`;
    const newId = `ingest-${randomUUID()}`;
    const payload = (id: string) => ({
      kind: 'brand-brain.ingest-source-document' as const,
      workspaceId: fixtures.a.workspaceId,
      requestedByUserId: fixtures.a.userId,
      idempotencyKey: id,
      ingestionJobId: id.slice('ingest-'.length),
    });
    try {
      await enqueue('media-processing', 'brand-brain.ingest-source-document', payload(oldId));
      const held = await queue.getJob(oldId);
      // Re-queuing THE SAME id is a no-op in Redis — the job it names is the old one.
      await enqueue('media-processing', 'brand-brain.ingest-source-document', {
        ...payload(oldId),
        requestedByUserId: randomUUID(),
      });
      expect((await queue.getJob(oldId))?.timestamp).toBe(held?.timestamp);
      expect((await queue.getJob(oldId))?.data.requestedByUserId).toBe(fixtures.a.userId);
      // A NEW job row's id is a new job.
      await enqueue('media-processing', 'brand-brain.ingest-source-document', payload(newId));
      expect(await queue.getJob(newId)).toBeTruthy();
    } finally {
      await (await queue.getJob(oldId))?.remove();
      await (await queue.getJob(newId))?.remove();
    }
  });
});

/* ======================================================================== */

describe('Remove — the base behaviour, Keep and Drop', () => {
  async function readySourceWithAcceptedFact() {
    const text = documentText();
    const received = await receive(input(strToU8(text)));
    await runJob(received.job!.id);
    const candidates = await platform.brandKnowledgeCandidate.findMany({
      where: { sourceDocumentId: received.document.id, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const [acceptedCandidate, pendingCandidate] = candidates as [
      (typeof candidates)[number],
      (typeof candidates)[number],
    ];
    const { itemId } = await inA((db) =>
      new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).reviewCandidate({
        candidateId: acceptedCandidate.id,
        decision: 'accept',
        actor: member(['brand_brain.review']),
        policy: STALENESS,
      }),
    );
    return { received, itemId: itemId as string, pendingCandidate };
  }

  it('soft-deletes, clears chunks, SUPERSEDES pending proposals and refunds the bytes ONCE', async () => {
    const { received, pendingCandidate } = await readySourceWithAcceptedFact();
    const before = await storedBytes(fixtures.a.workspaceId);
    expect(
      await platform.brandSourceChunk.count({ where: { sourceDocumentId: received.document.id } }),
    ).toBeGreaterThan(0);

    const result = await remove(received.document.id, 'keep', ['brand_brain.upload']);

    const row = await platform.brandSourceDocument.findUniqueOrThrow({
      where: { id: received.document.id },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(
      await platform.brandSourceChunk.count({ where: { sourceDocumentId: received.document.id } }),
    ).toBe(0);
    const pending = await platform.brandKnowledgeCandidate.findUniqueOrThrow({
      where: { id: pendingCandidate.id },
    });
    expect(pending.status).toBe('SUPERSEDED');
    expect(
      await platform.brandKnowledgeCandidate.count({
        where: { sourceDocumentId: received.document.id, status: 'REJECTED' },
      }),
    ).toBe(0);
    expect(result.refundedBytes).toBe(received.document.byteSize);
    expect(result.storageKeyToDelete).toBe(row.storageKey);
    expect(await storedBytes(fixtures.a.workspaceId)).toBe(
      before - BigInt(received.document.byteSize),
    );
    expect(
      await platform.auditEvent.count({
        where: { resourceId: received.document.id, action: 'brand_brain.source.removed' },
      }),
    ).toBe(1);

    // A replay is a miss, and refunds nothing more.
    await expect(
      remove(received.document.id, 'keep', ['brand_brain.upload']),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await storedBytes(fixtures.a.workspaceId)).toBe(
      before - BigInt(received.document.byteSize),
    );
  });

  it('KEEP leaves every approved fact exactly as it was', async () => {
    const { received, itemId } = await readySourceWithAcceptedFact();
    const before = await platform.brandKnowledgeItem.findUniqueOrThrow({ where: { id: itemId } });
    await remove(received.document.id, 'keep', ['brand_brain.upload']);
    const after = await platform.brandKnowledgeItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(after.status).toBe('ACTIVE');
    expect(after.version).toBe(before.version);
  });

  it('DROP archives only what the source CURRENTLY owns, and D10 sees the archive', async () => {
    const { received, itemId } = await readySourceWithAcceptedFact();

    // A second approved fact from the same source, then edited by a person:
    // its current version is theirs, so it no longer belongs to the source.
    const other = await platform.brandKnowledgeCandidate.findFirstOrThrow({
      where: { sourceDocumentId: received.document.id, status: 'PENDING' },
    });
    const { itemId: editedId } = await inA((db) =>
      new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).reviewCandidate({
        candidateId: other.id,
        decision: 'accept',
        actor: member(['brand_brain.review']),
        policy: STALENESS,
      }),
    );
    await inA((db) =>
      new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).updateItem({
        itemId: editedId as string,
        title: { en: 'Written by a person later' },
        body: { en: 'A person rewrote this fact after the document proposed it.' },
        actor: member(['brand_brain.edit']),
        policy: STALENESS,
      }),
    );

    const owned = await inA((db) =>
      sourceKnowledge(db, {
        brandId: fixtures.a.brandId,
        documentIds: [received.document.id],
        brandScope: [],
      }),
    );
    expect(owned.get(received.document.id)?.facts.map((f) => f.itemId)).toEqual([itemId]);

    // A post that used the owned fact.
    const fact = await platform.brandKnowledgeItem.findUniqueOrThrow({ where: { id: itemId } });
    await inA((db) =>
      recordKnowledgeUsage(db, {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        contentItemId: fixtures.a.contentItemId,
        contentVariantId: fixtures.a.contentVariantId,
        facts: [{ itemId, version: fact.version }],
        aiRequestId: null,
      }),
    );

    const result = await remove(received.document.id, 'drop', [
      'brand_brain.upload',
      'brand_brain.edit',
    ]);
    expect(result.archivedItemIds).toEqual([itemId]);

    const archived = await platform.brandKnowledgeItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(archived.status).toBe('ARCHIVED');
    const version = await platform.brandKnowledgeVersion.findFirstOrThrow({
      where: { knowledgeItemId: itemId, version: archived.version },
    });
    expect(version.changeKind).toBe('archived');
    expect(version.changeReason).toBe('source_removed');
    const kept = await platform.brandKnowledgeItem.findUniqueOrThrow({
      where: { id: editedId as string },
    });
    expect(kept.status).toBe('ACTIVE');

    // The EXISTING D10 rule flags the post: the fact it used was removed.
    const rows = await inA((db) =>
      loadCurrentUsage(db, { contentVariantId: fixtures.a.contentVariantId }),
    );
    const row = rows.find((entry) => entry.knowledgeItemId === itemId);
    expect(row && usageChangeFor(row, new Date())?.kind).toBe('removed');
  });

  it('DROP without brand_brain.edit is refused and changes nothing', async () => {
    const { received, itemId } = await readySourceWithAcceptedFact();
    await expect(
      remove(received.document.id, 'drop', ['brand_brain.upload']),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const row = await platform.brandSourceDocument.findUniqueOrThrow({
      where: { id: received.document.id },
    });
    expect(row.deletedAt).toBeNull();
    const fact = await platform.brandKnowledgeItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(fact.status).toBe('ACTIVE');
  });

  it('a job that runs after its document was removed writes nothing', async () => {
    const received = await receive(input(strToU8(documentText())));
    await remove(received.document.id, 'keep', ['brand_brain.upload']);
    const result = await runJob(received.job!.id);
    expect(result.status).toBe('FAILED');
    expect(result.failureMessage).toBe('source_removed');
    expect(
      await platform.brandSourceChunk.count({ where: { sourceDocumentId: received.document.id } }),
    ).toBe(0);
    expect(
      await platform.brandKnowledgeCandidate.count({
        where: { sourceDocumentId: received.document.id, status: 'PENDING' },
      }),
    ).toBe(0);
  });
});

/* ======================================================================== */

describe('source ownership — the CURRENT version decides', () => {
  it('a later version from another source moves the fact away; pending counts by sourceDocumentId', async () => {
    const shared = `z${randomUUID().slice(0, 8)} audience is founders of independent bakeries in the Gulf region.`;
    const first = await receive(input(strToU8(`${shared}\n\nfiller text for the first source.`)));
    await runJob(first.job!.id);
    const candidate = await platform.brandKnowledgeCandidate.findFirstOrThrow({
      where: { sourceDocumentId: first.document.id, status: 'PENDING' },
    });
    const { itemId } = await inA((db) =>
      new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).reviewCandidate({
        candidateId: candidate.id,
        decision: 'accept',
        actor: member(['brand_brain.review']),
        policy: STALENESS,
      }),
    );

    // The same sentence (same key) from a second document, accepted: a newer
    // version of the SAME fact, now owned by the second document.
    const second = await receive(
      input(strToU8(`${shared}\n\nfiller text for the second source ${randomUUID()}.`)),
    );
    await runJob(second.job!.id);
    const secondCandidate = await platform.brandKnowledgeCandidate.findFirstOrThrow({
      where: {
        sourceDocumentId: second.document.id,
        itemKey: candidate.itemKey,
        status: 'PENDING',
      },
    });
    await inA((db) =>
      new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).reviewCandidate({
        candidateId: secondCandidate.id,
        decision: 'accept',
        actor: member(['brand_brain.review']),
        policy: STALENESS,
      }),
    );

    const owned = await inA((db) =>
      sourceKnowledge(db, {
        brandId: fixtures.a.brandId,
        documentIds: [first.document.id, second.document.id],
        brandScope: [],
      }),
    );
    expect(owned.get(first.document.id)?.facts.map((f) => f.itemId)).not.toContain(itemId);
    expect(owned.get(second.document.id)?.facts.map((f) => f.itemId)).toContain(itemId);
    const pendingFirst = await platform.brandKnowledgeCandidate.count({
      where: { sourceDocumentId: first.document.id, status: 'PENDING' },
    });
    expect(owned.get(first.document.id)?.pending).toHaveLength(pendingFirst);

    // Drop on the FIRST source archives nothing it no longer owns.
    const dropped = await remove(first.document.id, 'drop', [
      'brand_brain.upload',
      'brand_brain.edit',
    ]);
    expect(dropped.archivedItemIds).not.toContain(itemId);
    const fact = await platform.brandKnowledgeItem.findUniqueOrThrow({
      where: { id: itemId as string },
    });
    expect(fact.status).toBe('ACTIVE');
  });
});

/* ======================================================================== */

describe('tenant and brand isolation of every source path', () => {
  it('another workspace cannot read, re-read or remove a source', async () => {
    const mine = await receive(input(strToU8(documentText())));
    await expect(
      inB((db) =>
        removeSource(db, {
          workspaceId: fixtures.b.workspaceId,
          documentId: mine.document.id,
          mode: 'keep',
          actor: {
            userId: fixtures.b.userId,
            permissionKeys: ['brand_brain.upload'],
            brandScope: [],
          },
          usage: new UsageService({ prisma: db as unknown as PrismaClient }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      inB(async (db) =>
        (await service(db, fixtures.b.workspaceId)).readAgain({
          documentId: mine.document.id,
          actorUserId: fixtures.b.userId,
          actorBrandScope: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const read = await inB((db) =>
      sourceKnowledge(db, {
        brandId: fixtures.a.brandId,
        documentIds: [mine.document.id],
        brandScope: [],
      }),
    );
    expect(read.get(mine.document.id)).toEqual({ facts: [], pending: [] });
    expect(
      await inB((db) => db.brandSourceDocument.count({ where: { id: mine.document.id } })),
    ).toBe(0);
  });

  it('a member scoped to another brand cannot re-read or remove it', async () => {
    const mine = await receive(input(strToU8(documentText())));
    const otherBrand = randomUUID();
    await expect(
      inA((db) =>
        removeSource(db, {
          workspaceId: fixtures.a.workspaceId,
          documentId: mine.document.id,
          mode: 'keep',
          actor: member(['brand_brain.upload'], [otherBrand]),
          usage: new UsageService({ prisma: db as unknown as PrismaClient }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      inA(async (db) =>
        (await service(db, fixtures.a.workspaceId)).readAgain({
          documentId: mine.document.id,
          ...uploader([otherBrand]),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // And an upload into a brand outside the scope is a miss before anything is read.
    await expect(
      receive(input(strToU8(documentText()), { actorBrandScope: [otherBrand] })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

/* ======================================================================== */

describe('Q20 — sources never ground writing', () => {
  it('chunks, source text and pending proposals stay out of the grounding', async () => {
    const mark = `SOURCEONLY${randomUUID().slice(0, 8).toUpperCase()}`;
    const text = `Our audience is founders who buy ${mark} pastries every morning.\n\nOur service includes ${mark} delivery for every client.`;
    const received: ReceiveResult = await receive(input(strToU8(text)));
    await runJob(received.job!.id);
    expect(
      await platform.brandSourceChunk.count({ where: { sourceDocumentId: received.document.id } }),
    ).toBeGreaterThan(0);
    expect(
      await platform.brandKnowledgeCandidate.count({
        where: { sourceDocumentId: received.document.id, status: 'PENDING' },
      }),
    ).toBeGreaterThan(0);

    const grounding = await inA((db) =>
      groundingFor(db, {
        brandId: fixtures.a.brandId,
        question: `${mark} pastries delivery audience`,
        purpose: 'ask',
        maxItems: 20,
        maxChars: 20_000,
      }),
    );
    expect(grounding.contextText).not.toContain(mark);
    expect(JSON.stringify(grounding)).not.toContain(mark);
  });

  it('a DOCX source is read by the worker into chunks and PENDING candidates only', async () => {
    const received = await receive(
      input(
        docxPackage([
          `Our audience is founders of independent bakeries ${randomUUID().slice(0, 6)}.`,
          'Our service includes a monthly content package.',
        ]),
        { fileName: 'brand.docx', mimeType: DOCX },
      ),
    );
    expect(received.outcome).toBe('queued');
    expect((await runJob(received.job!.id)).status).toBe('READY');
    const statuses = await platform.brandKnowledgeCandidate.findMany({
      where: { sourceDocumentId: received.document.id },
      select: { status: true, sourceKind: true },
    });
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((c) => c.status === 'PENDING' && c.sourceKind === 'DOCUMENT')).toBe(true);
  });
});
