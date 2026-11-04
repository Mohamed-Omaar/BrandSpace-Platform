import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { UsageService } from '@brandspace/entitlements';
import {
  BrandIngestionService,
  ExtractorRegistry,
  InMemoryObjectStore,
  PlainTextExtractor,
  extractSourceDocument,
  type ExtractedText,
  type ExtractionInput,
  type ExtractionLimits,
  type IngestionPolicy,
  type TextExtractor,
} from '@brandspace/brand-brain';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PR U — A READER THAT CANNOT RUN IS RETRIED WITH BACKOFF, THEN STOPS.
 *
 * Staging's worker ran Node 20; pdf.js threw a TypeError before reading a
 * byte, and the job failed as `extraction_failed`. Now the reason is
 * `reader_unavailable`: retryable (the runtime can be fixed between attempts),
 * re-queued `retryBackoffSeconds` later, and FAILED for good on the configured
 * last attempt, with the customer-facing key stored and nothing else.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;

const POLICY: IngestionPolicy = {
  allowedMimeTypes: ['text/plain'],
  maxFileBytes: 1024 * 1024,
  maxDocumentsPerBrand: 500,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  chunkTargetChars: 300,
  chunkOverlapChars: 50,
  maxChunksPerDocument: 50,
  minimumCandidateConfidenceMilli: 400,
};
const LIMITS: ExtractionLimits = {
  maxPages: 50,
  maxTextChars: 200_000,
  maxArchiveEntries: 256,
  maxArchiveBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 200,
  timeoutMs: 30_000,
};

/** A reader whose runtime is missing something: what pdf.js did on Node 20. */
class BrokenReader implements TextExtractor {
  supports(mimeType: string): boolean {
    return mimeType === 'text/plain';
  }
  async extract(_input: ExtractionInput): Promise<ExtractedText> {
    throw new TypeError('Promise.withResolvers is not a function');
  }
}

type Db = Parameters<Parameters<typeof withWorkspace>[1]>[0];
const NOW = new Date('2026-11-03T12:00:00.000Z');

function service(db: Db, store: InMemoryObjectStore) {
  return new BrandIngestionService({
    db,
    workspaceId: fixtures.a.workspaceId,
    storage: { usage: new UsageService({ prisma: db as unknown as PrismaClient }), limitGb: null },
    store,
    policy: POLICY,
    extractors: new ExtractorRegistry([new PlainTextExtractor(LIMITS)]),
    clock: { now: () => NOW },
  });
}

const inA = <T>(fn: (db: Db) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('PR U · reader_unavailable', () => {
  it('is retried after the configured backoff and fails for good on the last attempt', async () => {
    const store = new InMemoryObjectStore();
    const { jobId, documentId } = await inA(async (db) => {
      const { document, job } = await service(db, store).upload({
        brandId: fixtures.a.brandId,
        fileName: `pr-u-${randomUUID().slice(0, 6)}.txt`,
        mimeType: 'text/plain',
        bytes: new TextEncoder().encode(`Our tone is calm and warm.\n${randomUUID()}`),
        idempotencyKey: `pr-u-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
      });
      return { jobId: job.id, documentId: document.id };
    });

    const broken = new ExtractorRegistry([new BrokenReader()], { timeoutMs: 5_000 });
    for (const attempt of [1, 2, 3]) {
      const started = await inA((db) => service(db, store).startProcessing(jobId, attempt));
      expect(started.claimed).toBe(true);
      const outcome = await extractSourceDocument({ store, extractors: broken, started });
      expect(outcome).toMatchObject({
        ok: false,
        reason: 'reader_unavailable',
        terminal: false,
        diagnostic: {
          stage: 'parse',
          errorClass: 'TypeError',
          mimeType: 'text/plain',
        },
      });
      const result = await inA((db) => service(db, store).finishProcessing(started, outcome));
      const job = await inA((db) =>
        db.brandIngestionJob.findUniqueOrThrow({ where: { id: jobId } }),
      );
      const document = await inA((db) =>
        db.brandSourceDocument.findUniqueOrThrow({ where: { id: documentId } }),
      );

      if (attempt < POLICY.maxAttempts) {
        // Retried: back in the queue, not before the backoff, still PROCESSING.
        expect(job).toMatchObject({ stage: 'QUEUED', attempts: attempt });
        expect(job.nextAttemptAt?.getTime()).toBe(
          NOW.getTime() + POLICY.retryBackoffSeconds * 1000,
        );
        expect(document.status).toBe('PROCESSING');
        expect(result.status).toBe('PROCESSING');
      } else {
        // The usual attempts are spent: FAILED for good, with the key only.
        expect(job).toMatchObject({
          stage: 'FAILED',
          attempts: 3,
          failureMessage: 'reader_unavailable',
          failureCode: 'reader_unavailable',
        });
        expect(document).toMatchObject({ status: 'FAILED', failureMessage: 'reader_unavailable' });
      }
    }

    // A fourth delivery claims nothing.
    const late = await inA((db) => service(db, store).startProcessing(jobId, 4));
    expect(late.claimed).toBe(false);
  });
});
