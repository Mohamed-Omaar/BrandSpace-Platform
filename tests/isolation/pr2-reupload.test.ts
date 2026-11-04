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
  type ExtractionLimits,
  type IngestionPolicy,
} from '@brandspace/brand-brain';
import { appRoleClient, createIsolationFixtures, platformRoleClient } from './fixtures';
import type { IsolationFixtures } from './fixtures';

/**
 * PR 2 (D-598) — ADDING THE SAME FILE AGAIN AFTER OUR OWN FAILURE READS IT
 * AGAIN.
 *
 * Staging: the VETS VAN PDF failed three times on Node 20
 * (`extraction_failed`). Added again in the Copilot, the same bytes returned
 * that old FAILED row — nothing ran, nothing was logged, the card said
 * "failed". A failure on OUR side now starts a new read; a failure that is
 * the FILE's still answers with its reason.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

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

type Db = Parameters<Parameters<typeof withWorkspace>[1]>[0];
const store = new InMemoryObjectStore();

const service = (db: Db) =>
  new BrandIngestionService({
    db,
    workspaceId: fixtures.a.workspaceId,
    storage: { usage: new UsageService({ prisma: db as unknown as PrismaClient }), limitGb: null },
    store,
    policy: POLICY,
    extractors: new ExtractorRegistry([new PlainTextExtractor(LIMITS)]),
  });
const inA = <T>(fn: (db: Db) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const receive = (bytes: Uint8Array) =>
  inA((db) =>
    service(db).receive({
      brandId: fixtures.a.brandId,
      fileName: 'VETS-VAN.txt',
      mimeType: 'text/plain',
      bytes,
      idempotencyKey: `pr2-${randomUUID()}`,
      actorUserId: fixtures.a.userId,
      actorBrandScope: [],
    }),
  );

/** The source and its job as the worker leaves them after the last failed attempt. */
async function failAs(documentId: string, reason: string): Promise<void> {
  await platform.brandIngestionJob.updateMany({
    where: { sourceDocumentId: documentId },
    data: { stage: 'FAILED', failureMessage: reason, failureCode: reason, completedAt: new Date() },
  });
  await platform.brandSourceDocument.update({
    where: { id: documentId },
    data: { status: 'FAILED', failureMessage: reason },
  });
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('PR 2 · the same file again', () => {
  for (const reason of ['reader_unavailable', 'extraction_failed', 'stuck_timeout']) {
    it(`after OUR failure (${reason}): a new read starts, on the same source`, async () => {
      const bytes = new TextEncoder().encode(
        `VETS VAN brings the vet to your door. ${randomUUID()}`,
      );
      const first = await receive(bytes);
      expect(first.outcome).toBe('queued');
      await failAs(first.document.id, reason);

      const again = await receive(bytes);
      expect(again.outcome).toBe('queued');
      expect(again.document.id).toBe(first.document.id);
      expect(again.document.status).toBe('UPLOADED');
      expect(again.job?.stage).toBe('QUEUED');
      expect(again.job?.id).not.toBe(first.job?.id);
      expect(
        await platform.auditEvent.count({
          where: { resourceId: first.document.id, action: 'brand_brain.source.read_again' },
        }),
      ).toBe(1);
    });
  }

  it('after the FILE’s failure (no text in it): the old row and its reason, nothing new', async () => {
    const bytes = new TextEncoder().encode(`Some words. ${randomUUID()}`);
    const first = await receive(bytes);
    await failAs(first.document.id, 'no_text_found');
    const again = await receive(bytes);
    expect(again.outcome).toBe('existing');
    expect(again.document.failureMessage).toBe('no_text_found');
    expect(
      await platform.brandIngestionJob.count({ where: { sourceDocumentId: first.document.id } }),
    ).toBe(1);
  });

  it('a file already read well is still refused as a duplicate (the card says it is already there)', async () => {
    const bytes = new TextEncoder().encode(`Ready words. ${randomUUID()}`);
    const first = await receive(bytes);
    await platform.brandSourceDocument.update({
      where: { id: first.document.id },
      data: { status: 'READY' },
    });
    await expect(receive(bytes)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
