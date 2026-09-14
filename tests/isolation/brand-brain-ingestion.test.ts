import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { withWorkspace } from '@brandspace/database';
import {
  BrandIngestionService,
  ExtractorRegistry,
  InMemoryObjectStore,
  PlainTextExtractor,
  defaultExtractors,
  type ExtractionLimits,
  type IngestionPolicy,
} from '@brandspace/brand-brain';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Ingestion against a real PostgreSQL.
 *
 * The assertions that would let a weakened pipeline through: an upload that
 * reaches approved knowledge directly, a duplicate that creates a second
 * document, a retry that doubles the chunks, and a failure message that leaks
 * an extractor's internals onto a customer's screen.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;

const POLICY: IngestionPolicy = {
  allowedMimeTypes: ['text/plain', 'text/markdown', 'text/csv'],
  maxFileBytes: 1024 * 1024,
  maxDocumentsPerBrand: 50,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  chunkTargetChars: 300,
  chunkOverlapChars: 50,
  maxChunksPerDocument: 50,
  minimumCandidateConfidenceMilli: 400,
};

/** Generous: these tests are about the pipeline, not about the ceilings. */
const LIMITS: ExtractionLimits = {
  maxPages: 50,
  maxTextChars: 200_000,
  maxArchiveEntries: 256,
  maxArchiveBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 200,
  timeoutMs: 30_000,
};

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Every type the default extractors claim, so the wide policy admits them. */
const ALL_SUPPORTED_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  DOCX_TYPE,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/pdf',
];

const DOCUMENT = [
  'Our mission is to help independent retailers compete with national chains.',
  '',
  'Our audience is founders of small retail businesses in the Gulf region.',
  '',
  'We never make price comparisons against named competitors.',
  '',
  'Our service includes a monthly content package and a quarterly strategy review.',
].join('\n');

type ScopedDb = Parameters<Parameters<typeof withWorkspace>[1]>[0];

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

let counter = 0;
const nextKey = () => `upload-${(counter += 1)}-${Date.now()}`;

async function inA<T>(
  fn: (svc: BrandIngestionService, db: ScopedDb, store: InMemoryObjectStore) => Promise<T>,
): Promise<T> {
  const store = new InMemoryObjectStore();
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new BrandIngestionService({
          db,
          workspaceId: fixtures.a.workspaceId,
          store,
          policy: POLICY,
          extractors: new ExtractorRegistry([new PlainTextExtractor(LIMITS)]),
        }),
        db,
        store,
      ),
    { prisma: app },
  );
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('upload validation happens before a byte is stored', () => {
  it('refuses a disallowed media type', async () => {
    await expect(
      inA((svc) =>
        svc.upload({
          brandId: fixtures.a.brandId,
          fileName: 'payload.exe',
          mimeType: 'application/x-msdownload',
          bytes: bytesOf('MZ'),
          idempotencyKey: nextKey(),
          actorUserId: fixtures.a.userId,
        }),
      ),
    ).rejects.toThrow(/not supported/i);
  });

  it('refuses a file over the size ceiling', async () => {
    await expect(
      inA((svc) =>
        svc.upload({
          brandId: fixtures.a.brandId,
          fileName: 'huge.txt',
          mimeType: 'text/plain',
          bytes: bytesOf('x'.repeat(POLICY.maxFileBytes + 1)),
          idempotencyKey: nextKey(),
          actorUserId: fixtures.a.userId,
        }),
      ),
    ).rejects.toThrow(/larger than the allowed size/i);
  });

  it('STORES NOTHING when validation fails', async () => {
    // An object store nobody cleans up is a cost that compounds silently.
    const size = await inA(async (svc, _db, store) => {
      await svc
        .upload({
          brandId: fixtures.a.brandId,
          fileName: 'payload.exe',
          mimeType: 'application/x-msdownload',
          bytes: bytesOf('MZ'),
          idempotencyKey: nextKey(),
          actorUserId: fixtures.a.userId,
        })
        .catch(() => undefined);
      return store.size;
    });
    expect(size).toBe(0);
  });

  it('writes an audit event carrying the file NAME but never its content', async () => {
    const secret = 'CONFIDENTIAL-CONTRACT-CLAUSE';
    const events = await inA(async (svc, db) => {
      const { document } = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'contract.txt',
        mimeType: 'text/plain',
        bytes: bytesOf(`Our mission is clear. ${secret}`),
        idempotencyKey: nextKey(),
        actorUserId: fixtures.a.userId,
      });
      return db.auditEvent.findMany({ where: { resourceId: document.id } });
    });
    const serialized = JSON.stringify(events);
    expect(serialized).toContain('contract.txt');
    expect(serialized).not.toContain(secret);
  });
});

describe('the two idempotency keys answer two different questions', () => {
  it('the SAME REQUEST replays the original document', async () => {
    const key = nextKey();
    const { first, second } = await inA(async (svc) => {
      const a = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'guidelines.txt',
        mimeType: 'text/plain',
        bytes: bytesOf(DOCUMENT),
        idempotencyKey: key,
        actorUserId: fixtures.a.userId,
      });
      const b = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'guidelines.txt',
        mimeType: 'text/plain',
        bytes: bytesOf(DOCUMENT),
        idempotencyKey: key,
        actorUserId: fixtures.a.userId,
      });
      return { first: a, second: b };
    });
    // A retry of a request whose response was lost. One document, one job.
    expect(second.document.id).toBe(first.document.id);
    expect(second.job.id).toBe(first.job.id);
  });

  it('the SAME FILE under a different request is REFUSED as a duplicate', async () => {
    // A person uploading the same PDF twice from two screens is making a
    // mistake, and deserves a different answer from a lost response.
    await expect(
      inA(async (svc) => {
        await svc.upload({
          brandId: fixtures.a.brandId,
          fileName: 'same.txt',
          mimeType: 'text/plain',
          bytes: bytesOf('Our mission is identical content for the duplicate test.'),
          idempotencyKey: nextKey(),
          actorUserId: fixtures.a.userId,
        });
        return svc.upload({
          brandId: fixtures.a.brandId,
          fileName: 'same-renamed.txt',
          mimeType: 'text/plain',
          bytes: bytesOf('Our mission is identical content for the duplicate test.'),
          idempotencyKey: nextKey(),
          actorUserId: fixtures.a.userId,
        });
      }),
    ).rejects.toThrow(/already been uploaded/i);
  });
});

describe('processing produces candidates and NEVER knowledge', () => {
  it('chunks the document and proposes candidates', async () => {
    const result = await inA(async (svc, db) => {
      const { document, job } = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'brand.txt',
        mimeType: 'text/plain',
        // Deliberately distinct from every other upload in this file: duplicate
        // protection is per brand and per CONTENT, and these tests share one
        // brand. Reusing the text would be refused as a duplicate — which is
        // the pipeline working, not a failure of this test.
        bytes: bytesOf(DOCUMENT.replace('independent', 'family-run')),
        idempotencyKey: nextKey(),
        actorUserId: fixtures.a.userId,
      });
      const outcome = await svc.process(job.id);
      const chunks = await db.brandSourceChunk.count({
        where: { sourceDocumentId: document.id },
      });
      const candidates = await db.brandKnowledgeCandidate.findMany({
        where: { sourceDocumentId: document.id },
      });
      const stored = await db.brandSourceDocument.findUnique({ where: { id: document.id } });
      return { outcome, chunks, candidates, stored };
    });

    expect(result.outcome.status).toBe('READY');
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.stored?.status).toBe('READY');
    expect(result.stored?.chunkCount).toBe(result.chunks);
    // Every candidate is PENDING. Nothing is approved by uploading.
    expect(result.candidates.every((c) => c.status === 'PENDING')).toBe(true);
  });

  it('CREATES NO KNOWLEDGE ITEM — the governance boundary holds', async () => {
    /*
     * The structural guarantee: this pipeline cannot promote anything, because
     * `ingestion.ts` does not import the knowledge service at all.
     */
    const created = await inA(async (svc, db) => {
      const before = await db.brandKnowledgeItem.count({ where: { brandId: fixtures.a.brandId } });
      const { job } = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'no-promote.txt',
        mimeType: 'text/plain',
        bytes: bytesOf(DOCUMENT.replace('mission', 'purpose')),
        idempotencyKey: nextKey(),
        actorUserId: fixtures.a.userId,
      });
      await svc.process(job.id);
      const after = await db.brandKnowledgeItem.count({ where: { brandId: fixtures.a.brandId } });
      return after - before;
    });
    expect(created).toBe(0);
  });

  it('every candidate carries EVIDENCE pointing at a real chunk', async () => {
    // D-65: an inferred entry cites the specific data supporting it, and the
    // citation is inspectable by the customer.
    const evidence = await inA(async (svc, db) => {
      const { document, job } = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'evidence.txt',
        mimeType: 'text/plain',
        bytes: bytesOf(DOCUMENT.replace('Gulf', 'Levant')),
        idempotencyKey: nextKey(),
        actorUserId: fixtures.a.userId,
      });
      await svc.process(job.id);
      const candidates = await db.brandKnowledgeCandidate.findMany({
        where: { sourceDocumentId: document.id },
      });
      const chunkIds = new Set(
        (await db.brandSourceChunk.findMany({ where: { sourceDocumentId: document.id } })).map(
          (c) => c.id,
        ),
      );
      return candidates.map((c) => ({
        evidence: c.evidence as unknown as { chunkId: string | null; quote: string }[],
        chunkIds,
      }));
    });

    expect(evidence.length).toBeGreaterThan(0);
    for (const entry of evidence) {
      expect(entry.evidence.length).toBeGreaterThan(0);
      for (const e of entry.evidence) {
        expect(e.chunkId).not.toBeNull();
        expect(entry.chunkIds.has(e.chunkId as string)).toBe(true);
        // The quote IS the source text, so it is checkable by construction.
        expect(e.quote.length).toBeGreaterThan(0);
      }
    }
  });

  it('is IDEMPOTENT — reprocessing does not double the chunks', async () => {
    const { firstChunks, secondChunks } = await inA(async (svc, db) => {
      const { document, job } = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'reprocess.txt',
        mimeType: 'text/plain',
        bytes: bytesOf(DOCUMENT.replace('retailers', 'grocers')),
        idempotencyKey: nextKey(),
        actorUserId: fixtures.a.userId,
      });
      await svc.process(job.id);
      const a = await db.brandSourceChunk.count({ where: { sourceDocumentId: document.id } });
      await svc.process(job.id);
      const b = await db.brandSourceChunk.count({ where: { sourceDocumentId: document.id } });
      return { firstChunks: a, secondChunks: b };
    });
    expect(secondChunks).toBe(firstChunks);
  });

  it('a retry NEVER erases a candidate a human already reviewed', async () => {
    /*
     * Clearing is limited to PENDING candidates. A reviewed one is a DECISION,
     * and a reprocess that wiped it would silently undo a person's judgement.
     */
    const survived = await inA(async (svc, db) => {
      const { document, job } = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'decided.txt',
        mimeType: 'text/plain',
        bytes: bytesOf(DOCUMENT.replace('quarterly', 'annual')),
        idempotencyKey: nextKey(),
        actorUserId: fixtures.a.userId,
      });
      await svc.process(job.id);
      const first = await db.brandKnowledgeCandidate.findFirst({
        where: { sourceDocumentId: document.id },
      });
      await db.brandKnowledgeCandidate.update({
        where: { id: first?.id ?? '' },
        data: { status: 'REJECTED', reviewedByUserId: fixtures.a.userId, reviewedAt: new Date() },
      });
      await svc.process(job.id);
      return db.brandKnowledgeCandidate.findUnique({ where: { id: first?.id ?? '' } });
    });
    expect(survived).not.toBeNull();
    expect(survived?.status).toBe('REJECTED');
  });
});

describe('failure states are honest and safe', () => {
  it('a missing object goes terminal with a customer-safe message', async () => {
    const result = await inA(async (svc, db, store) => {
      const { document, job } = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'vanishing.txt',
        mimeType: 'text/plain',
        bytes: bytesOf(DOCUMENT.replace('monthly', 'weekly')),
        idempotencyKey: nextKey(),
        actorUserId: fixtures.a.userId,
      });
      const stored = await db.brandSourceDocument.findUniqueOrThrow({
        where: { id: document.id },
      });
      // The row exists; the object does not. Retrying cannot fix it.
      await store.delete(stored.storageKey);
      const outcome = await svc.process(job.id);
      const after = await db.brandSourceDocument.findUnique({ where: { id: document.id } });
      const jobAfter = await db.brandIngestionJob.findUnique({ where: { id: job.id } });
      return { outcome, after, jobAfter };
    });

    expect(result.outcome.status).toBe('FAILED');
    expect(result.after?.status).toBe('FAILED');
    expect(result.jobAfter?.stage).toBe('FAILED');
    // No path, no library name, no stack fragment.
    expect(result.after?.failureMessage).toBe('The uploaded file could not be read.');
    expect(result.after?.failureMessage).not.toMatch(/\/|Error|at\s/);
    // The internal code is kept for operators, separately.
    expect(result.jobAfter?.failureCode).toBe('object_missing');
  });

  it('the sweep reconciles a stuck job without starving on one bad row', async () => {
    const reconciled = await inA(async (svc, db) => {
      const { job } = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'stuck.txt',
        mimeType: 'text/plain',
        bytes: bytesOf(DOCUMENT.replace('compete', 'thrive')),
        idempotencyKey: nextKey(),
        actorUserId: fixtures.a.userId,
      });
      await db.brandIngestionJob.update({
        where: { id: job.id },
        data: {
          stage: 'EXTRACTING',
          attempts: 3,
          startedAt: new Date(Date.now() - 3600_000),
        },
      });
      const count = await svc.sweepStuckJobs(60);
      const after = await db.brandIngestionJob.findUnique({ where: { id: job.id } });
      return { count, stage: after?.stage, message: after?.failureMessage };
    });

    expect(reconciled.count).toBeGreaterThan(0);
    expect(reconciled.stage).toBe('FAILED');
    expect(reconciled.message).toBe('Processing took too long and was stopped.');
  });

  it('a retryable failure leaves the document PROCESSING, not FAILED', async () => {
    // Showing FAILED before the retries are spent tells the customer something
    // that is not yet true.
    const status = await inA(async (svc, db) => {
      const { document, job } = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'retryable.txt',
        mimeType: 'text/plain',
        bytes: bytesOf(DOCUMENT.replace('chains', 'groups')),
        idempotencyKey: nextKey(),
        actorUserId: fixtures.a.userId,
      });
      await db.brandIngestionJob.update({
        where: { id: job.id },
        data: { stage: 'EXTRACTING', attempts: 0, startedAt: new Date(Date.now() - 3600_000) },
      });
      await svc.sweepStuckJobs(60);
      const after = await db.brandSourceDocument.findUnique({ where: { id: document.id } });
      const jobAfter = await db.brandIngestionJob.findUnique({ where: { id: job.id } });
      return { doc: after?.status, job: jobAfter?.stage, next: jobAfter?.nextAttemptAt };
    });
    expect(status.doc).toBe('PROCESSING');
    expect(status.job).toBe('QUEUED');
    expect(status.next).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Real documents, through the whole pipeline (F-70)
// ---------------------------------------------------------------------------

/**
 * The formats customers actually have, ingested end to end.
 *
 * Phase 5A refused PDF, Word and PowerPoint at upload because nothing could
 * read them. That was the honest behaviour for a capability that did not exist,
 * and it meant the three formats a brand's material is usually in could not
 * reach Brand Brain at all. These assert the whole path: signature check,
 * extraction, chunking, locators, and candidates proposed for review — and that
 * a hostile file is refused somewhere along it rather than processed.
 *
 * The `extractors` here are the DEFAULT set, not a stub. A test that passed
 * with a fake extractor would prove nothing about the formats it names.
 */

const WIDE_POLICY: IngestionPolicy = { ...POLICY, allowedMimeTypes: ALL_SUPPORTED_TYPES };

async function inAWithRealExtractors<T>(
  fn: (svc: BrandIngestionService, db: ScopedDb, store: InMemoryObjectStore) => Promise<T>,
): Promise<T> {
  const store = new InMemoryObjectStore();
  const extractors = new ExtractorRegistry(await defaultExtractors(LIMITS));
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new BrandIngestionService({
          db,
          workspaceId: fixtures.a.workspaceId,
          store,
          policy: WIDE_POLICY,
          extractors,
        }),
        db,
        store,
      ),
    { prisma: app },
  );
}

function docxBytes(
  paragraphs: readonly string[],
  extra: Record<string, Uint8Array> = {},
): Uint8Array {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
    ),
    ...extra,
  });
}

function pdfBytes(lines: readonly string[]): Uint8Array {
  const content = lines
    .map((line, index) => `BT /F1 12 Tf 20 ${180 - index * 20} Td (${line}) Tj ET`)
    .join('\n');
  return new Uint8Array(
    Buffer.from(
      `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${content.length}>>stream
${content}
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
`,
      'latin1',
    ),
  );
}

describe('the formats customers actually have', () => {
  it('reads a Word document and proposes candidates from it', async () => {
    const result = await inAWithRealExtractors(async (svc) => {
      const { job } = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'brand-guidelines.docx',
        mimeType: DOCX_TYPE,
        bytes: docxBytes([
          'Our mission is to help independent retailers compete with national chains.',
          'Our audience is founders of small retail businesses in the Gulf region.',
          'We never make price comparisons against named competitors.',
        ]),
        idempotencyKey: nextKey(),
        actorUserId: fixtures.a.userId,
      });
      return svc.process(job.id);
    });

    expect(result.status).toBe('READY');
    expect(result.chunksCreated).toBeGreaterThan(0);
    expect(result.candidatesCreated).toBeGreaterThan(0);
  });

  it('reads a PDF and records a page locator a customer can check', async () => {
    const { result, chunks } = await inAWithRealExtractors(async (svc, db) => {
      const { document, job } = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'company-profile.pdf',
        mimeType: 'application/pdf',
        bytes: pdfBytes([
          'Our mission is to make brand knowledge usable',
          'Our audience is small retail founders',
        ]),
        idempotencyKey: nextKey(),
        actorUserId: fixtures.a.userId,
      });
      const processed = await svc.process(job.id);
      return {
        result: processed,
        chunks: await db.brandSourceChunk.findMany({
          where: { sourceDocumentId: document.id },
          orderBy: { chunkIndex: 'asc' },
        }),
      };
    });

    expect(result.status).toBe('READY');
    expect(chunks.length).toBeGreaterThan(0);
    // D-65: "a citation the customer cannot check is not evidence."
    expect(chunks[0]?.locator).toMatch(/^page \d+$/);
  });

  it('refuses a file whose content does not match its declared type', async () => {
    // The rename attack: a PDF called `.docx` would otherwise reach the ZIP
    // reader, which is "feed the wrong parser attacker-controlled bytes".
    await expect(
      inAWithRealExtractors((svc) =>
        svc.upload({
          brandId: fixtures.a.brandId,
          fileName: 'disguised.docx',
          mimeType: DOCX_TYPE,
          bytes: pdfBytes(['nothing to see']),
          idempotencyKey: nextKey(),
          actorUserId: fixtures.a.userId,
        }),
      ),
    ).rejects.toThrow(/do not match its type/i);
  });

  it('fails a macro-bearing document TERMINALLY, with a reason key and no retry', async () => {
    const { result, job } = await inAWithRealExtractors(async (svc, db) => {
      const { job: queued } = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'macro.docx',
        mimeType: DOCX_TYPE,
        bytes: docxBytes(['Harmless looking text about our mission.'], {
          'word/vbaProject.bin': strToU8('macro payload'),
        }),
        idempotencyKey: nextKey(),
        actorUserId: fixtures.a.userId,
      });
      const processed = await svc.process(queued.id);
      return {
        result: processed,
        job: await db.brandIngestionJob.findUniqueOrThrow({ where: { id: queued.id } }),
      };
    });

    expect(result.status).toBe('FAILED');
    // A REASON KEY, never a sentence and never a parser's own words.
    expect(result.failureMessage).toBe('archive_unsafe_entry');
    // TERMINAL on the first attempt: retrying a bad file costs another parse
    // and reaches the same answer, while the customer watches PROCESSING.
    expect(job.stage).toBe('FAILED');
    expect(job.attempts).toBe(1);
  });

  it('says a scanned PDF has no text layer rather than recording an empty one', async () => {
    const result = await inAWithRealExtractors(async (svc) => {
      const { job } = await svc.upload({
        brandId: fixtures.a.brandId,
        fileName: 'scan.pdf',
        mimeType: 'application/pdf',
        bytes: new Uint8Array(
          Buffer.from(
            `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
`,
            'latin1',
          ),
        ),
        idempotencyKey: nextKey(),
        actorUserId: fixtures.a.userId,
      });
      return svc.process(job.id);
    });

    expect(result.status).toBe('FAILED');
    expect(result.failureMessage).toBe('pdf_has_no_text_layer');
  });
});
