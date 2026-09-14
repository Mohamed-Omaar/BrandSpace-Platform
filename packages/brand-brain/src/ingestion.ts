import {
  writeAuditEvent,
  type BrandIngestionJob,
  type BrandKnowledgeArea,
  type BrandSourceDocument,
  type Prisma,
  type TenantScopedClient,
} from '@brandspace/database';
import { type Clock, systemClock } from '@brandspace/shared';
import type { ExtractorRegistry } from './extraction';
import {
  chunkText,
  ExtractionFailedError,
  ExtractionUnsupportedError,
  KeywordFactExtractor,
  type FactExtractor,
} from './extraction';
import { buildStorageKey, checksumOf, type ObjectStore } from './storage';
import {
  contentTypeMismatch,
  documentNotFound,
  duplicateUpload,
  fileTooLarge,
  storageLimitReached,
  unsupportedFileType,
} from './errors';
import { checkSignature } from './file-signature';

/**
 * Source ingestion — upload, extract, chunk, propose.
 *
 * THE PIPELINE NEVER TOUCHES APPROVED KNOWLEDGE. It ends at
 * `brand_knowledge_candidate`. That is the governance boundary D-65 requires,
 * and it is structural here rather than a rule someone follows: this file does
 * not import `BrandKnowledgeService` and cannot promote anything.
 *
 * IDEMPOTENCY HAS TWO KEYS, BECAUSE THERE ARE TWO QUESTIONS.
 *   - `idempotencyKey` answers "is this the same REQUEST?" — a client retrying
 *     an upload whose response it lost. It replays the original document.
 *   - `checksum` answers "is this the same FILE?" — a customer uploading the
 *     same PDF twice from two screens. It refuses as a duplicate.
 * A single key could not tell those apart, and they deserve different answers:
 * one is a network artefact, the other is a person making a mistake.
 */

export interface IngestionPolicy {
  readonly allowedMimeTypes: readonly string[];
  readonly maxFileBytes: number;
  readonly maxDocumentsPerBrand: number;
  readonly maxAttempts: number;
  readonly retryBackoffSeconds: number;
  readonly chunkTargetChars: number;
  readonly chunkOverlapChars: number;
  readonly maxChunksPerDocument: number;
  readonly minimumCandidateConfidenceMilli: number;
}

export interface IngestionServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly store: ObjectStore;
  readonly policy: IngestionPolicy;
  /**
   * REQUIRED. There is no default any more: the extractors need the configured
   * limits, and a default built from nothing would be a second set of ceilings
   * that an operator cannot change (CLAUDE.md §2.2).
   */
  readonly extractors: ExtractorRegistry;
  readonly factExtractor?: FactExtractor;
  readonly clock?: Clock;
}

export interface UploadInput {
  readonly brandId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly targetArea?: BrandKnowledgeArea | undefined;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
}

/**
 * The failures where a second attempt could plausibly succeed.
 *
 * Everything absent from this set is a property of the file and goes terminal
 * on the first attempt.
 */
const RETRYABLE_REASONS: ReadonlySet<string> = new Set([
  'extraction_failed',
  'extraction_timed_out',
  'object_missing',
  'stuck_timeout',
]);

export interface ProcessResult {
  readonly documentId: string;
  readonly status: BrandSourceDocument['status'];
  readonly chunksCreated: number;
  readonly candidatesCreated: number;
  readonly failureMessage: string | null;
}

export class BrandIngestionService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #store: ObjectStore;
  readonly #policy: IngestionPolicy;
  readonly #extractors: ExtractorRegistry;
  readonly #facts: FactExtractor;
  readonly #clock: Clock;

  constructor(options: IngestionServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#store = options.store;
    this.#policy = options.policy;
    this.#extractors = options.extractors;
    this.#facts = options.factExtractor ?? new KeywordFactExtractor();
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Accept an upload and queue it for processing.
   *
   * Validation happens BEFORE a byte is stored. Writing the object first and
   * validating after would leave orphaned objects behind every rejected upload,
   * and an object store nobody cleans up is a cost that compounds silently.
   */
  async upload(
    input: UploadInput,
  ): Promise<{ document: BrandSourceDocument; job: BrandIngestionJob }> {
    if (!this.#policy.allowedMimeTypes.includes(input.mimeType)) throw unsupportedFileType();
    if (input.bytes.byteLength > this.#policy.maxFileBytes) throw fileTooLarge();

    /*
     * THE BYTES DECIDE WHAT THE FILE IS, NOT THE CALLER.
     *
     * `mimeType` arrives from the browser, which derives it from the file's
     * EXTENSION, and from a scripted upload, which can simply assert it. The
     * allow-list above is the right use for it — may this workspace upload this
     * kind of thing — and the wrong basis for choosing a parser. Feeding a PDF
     * to the ZIP reader because the file was named `.docx` is the oldest shape
     * of upload bug there is, so the signature has to agree before anything is
     * stored. See file-signature.ts.
     */
    const signature = checkSignature(input.mimeType, input.bytes);
    if (!signature.ok) throw contentTypeMismatch();

    if (!this.#extractors.supports(input.mimeType)) {
      // Configuration allows the type but nothing can read it. Refusing at the
      // door is honest; accepting would produce a document stuck in FAILED and
      // a customer who thinks the product is broken.
      throw unsupportedFileType();
    }

    // REQUEST idempotency: a retry of an upload whose response was lost.
    const replay = await this.#db.brandSourceDocument.findFirst({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (replay) {
      const job = await this.#db.brandIngestionJob.findFirst({
        where: { sourceDocumentId: replay.id },
        orderBy: { queuedAt: 'desc' },
      });
      if (job) return { document: replay, job };
    }

    const checksum = await checksumOf(input.bytes);

    // FILE identity: the same document uploaded twice.
    const duplicate = await this.#db.brandSourceDocument.findFirst({
      where: { brandId: input.brandId, checksum, deletedAt: null },
    });
    if (duplicate) throw duplicateUpload();

    const liveCount = await this.#db.brandSourceDocument.count({
      where: { brandId: input.brandId, deletedAt: null },
    });
    if (liveCount >= this.#policy.maxDocumentsPerBrand) throw storageLimitReached();

    const now = this.#clock.now();

    const document = await this.#db.brandSourceDocument.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        byteSize: input.bytes.byteLength,
        checksum,
        // Replaced immediately below. The row has to exist first so the key can
        // carry its id, which is what keeps one object per document.
        storageKey: 'pending',
        status: 'UPLOADED',
        idempotencyKey: input.idempotencyKey,
        uploadedByUserId: input.actorUserId,
        ...(input.targetArea ? { targetArea: input.targetArea } : {}),
      },
    });

    const storageKey = buildStorageKey({
      workspaceId: this.#workspaceId,
      brandId: input.brandId,
      documentId: document.id,
    });
    await this.#store.put(storageKey, input.bytes, input.mimeType);
    const stored = await this.#db.brandSourceDocument.update({
      where: { id: document.id },
      data: { storageKey },
    });

    const job = await this.#db.brandIngestionJob.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        sourceDocumentId: document.id,
        stage: 'QUEUED',
        maxAttempts: this.#policy.maxAttempts,
        queuedAt: now,
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'brand_brain.source.uploaded',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'BrandSourceDocument',
      resourceId: document.id,
      brandId: input.brandId,
      // The file NAME is metadata the customer chose; the CONTENT never enters
      // an audit event.
      after: {
        fileName: input.fileName,
        mimeType: input.mimeType,
        byteSize: input.bytes.byteLength,
      },
    });

    return { document: stored, job };
  }

  /**
   * Run one queued job to completion.
   *
   * IDEMPOTENT AND SAFE TO RETRY (CLAUDE.md §5). Chunks and candidates for the
   * document are cleared before they are rewritten, so a job that died halfway
   * and is retried produces one clean set rather than duplicates layered on a
   * partial run. Clearing candidates is deliberately limited to PENDING ones:
   * a candidate a human already reviewed is a DECISION, and a retry must never
   * erase it.
   */
  async process(jobId: string): Promise<ProcessResult> {
    const job = await this.#db.brandIngestionJob.findUnique({ where: { id: jobId } });
    if (!job) throw documentNotFound();

    const document = await this.#db.brandSourceDocument.findUnique({
      where: { id: job.sourceDocumentId },
    });
    if (!document) throw documentNotFound();

    const now = this.#clock.now();
    await this.#db.brandIngestionJob.update({
      where: { id: job.id },
      data: { stage: 'EXTRACTING', attempts: { increment: 1 }, startedAt: now },
    });
    await this.#db.brandSourceDocument.update({
      where: { id: document.id },
      data: { status: 'PROCESSING' },
    });

    try {
      const bytes = await this.#store.get(document.storageKey);
      if (!bytes) {
        // The row exists and the object does not. Real, and worth its own
        // message: retrying cannot fix it, so it goes terminal immediately.
        return this.#fail(
          job.id,
          document.id,
          'The uploaded file could not be read.',
          'object_missing',
          true,
        );
      }

      const extracted = await this.#extractors.extract({
        bytes,
        mimeType: document.mimeType,
        fileName: document.fileName,
      });

      await this.#db.brandIngestionJob.update({
        where: { id: job.id },
        data: { stage: 'CHUNKING' },
      });

      const chunks = chunkText(extracted.text, extracted.boundaries, {
        targetChars: this.#policy.chunkTargetChars,
        overlapChars: this.#policy.chunkOverlapChars,
        maxChunks: this.#policy.maxChunksPerDocument,
      });

      // Idempotent rewrite. Chunks are derived data — deleting and recreating
      // them loses nothing, and is what makes a retry produce one clean set.
      await this.#db.brandSourceChunk.deleteMany({ where: { sourceDocumentId: document.id } });
      if (chunks.length > 0) {
        await this.#db.brandSourceChunk.createMany({
          data: chunks.map((chunk) => ({
            workspaceId: this.#workspaceId,
            brandId: document.brandId,
            sourceDocumentId: document.id,
            chunkIndex: chunk.index,
            text: chunk.text,
            locator: chunk.locator,
          })),
        });
      }

      await this.#db.brandIngestionJob.update({
        where: { id: job.id },
        data: { stage: 'EXTRACTING_FACTS', chunksCreated: chunks.length },
      });

      const facts = await this.#facts.extract({
        chunks,
        targetArea: document.targetArea ?? null,
        minimumConfidenceMilli: this.#policy.minimumCandidateConfidenceMilli,
      });

      // Only PENDING candidates are cleared. A reviewed one is a decision.
      await this.#db.brandKnowledgeCandidate.deleteMany({
        where: { sourceDocumentId: document.id, status: 'PENDING' },
      });

      const storedChunks = await this.#db.brandSourceChunk.findMany({
        where: { sourceDocumentId: document.id },
        select: { id: true, chunkIndex: true },
      });
      const chunkIdByIndex = new Map(storedChunks.map((c) => [c.chunkIndex, c.id]));

      let created = 0;
      for (const fact of facts) {
        // A candidate whose key already has a REVIEWED candidate would
        // re-propose something a human settled. Skipped rather than re-raised.
        const settled = await this.#db.brandKnowledgeCandidate.findFirst({
          where: {
            brandId: document.brandId,
            sourceDocumentId: document.id,
            itemKey: fact.itemKey,
            status: { in: ['ACCEPTED', 'EDITED_ACCEPTED', 'REJECTED'] },
          },
        });
        if (settled) continue;

        const existing = await this.#db.brandKnowledgeItem.findFirst({
          where: { brandId: document.brandId, area: fact.area, itemKey: fact.itemKey },
        });

        await this.#db.brandKnowledgeCandidate.create({
          data: {
            workspaceId: this.#workspaceId,
            brandId: document.brandId,
            sourceDocumentId: document.id,
            ...(existing ? { targetItemId: existing.id } : {}),
            area: fact.area,
            itemKey: fact.itemKey,
            extractedTitle: fact.title as Prisma.InputJsonValue,
            extractedBody: fact.body as Prisma.InputJsonValue,
            confidenceMilli: fact.confidenceMilli,
            evidence: fact.evidence.map((e) => ({
              chunkId: chunkIdByIndex.get(e.chunkIndex) ?? null,
              locator: e.locator,
              quote: e.quote,
            })) as Prisma.InputJsonValue,
          },
        });
        created += 1;
      }

      await this.#db.brandIngestionJob.update({
        where: { id: job.id },
        data: {
          stage: 'COMPLETED',
          candidatesCreated: created,
          completedAt: this.#clock.now(),
          failureMessage: null,
          failureCode: null,
        },
      });
      await this.#db.brandSourceDocument.update({
        where: { id: document.id },
        data: {
          status: 'READY',
          pageCount: extracted.pageCount,
          chunkCount: chunks.length,
          textLength: extracted.text.length,
          processedAt: this.#clock.now(),
          failureMessage: null,
        },
      });

      await writeAuditEvent(this.#db, this.#workspaceId, {
        action: 'brand_brain.source.processed',
        actorType: 'SYSTEM',
        resourceType: 'BrandSourceDocument',
        resourceId: document.id,
        brandId: document.brandId,
        after: { chunks: chunks.length, candidates: created },
      });

      return {
        documentId: document.id,
        status: 'READY',
        chunksCreated: chunks.length,
        candidatesCreated: created,
        failureMessage: null,
      };
    } catch (error) {
      /*
       * THE CUSTOMER-FACING MESSAGE IS WRITTEN HERE, NOT DERIVED FROM THE
       * ERROR. An extractor's message can carry a file path, a library
       * version or a stack fragment, and none of that belongs on a customer's
       * screen (docs/SECURITY.md). The internal code is kept separately for
       * operators.
       */
      const unsupported = error instanceof ExtractionUnsupportedError;
      /*
       * A REASON KEY, NOT A SENTENCE.
       *
       * This used to store English prose in `failureMessage`, which the screen
       * then printed verbatim — hard-coded user-facing copy that an Arabic
       * reader saw in English (CLAUDE.md §4). It now stores a stable key the
       * dashboard translates, and the keys distinguish failures a customer can
       * act on: a damaged archive, a scan with no text layer and a file that is
       * simply too big all deserve different advice.
       */
      const reason: string = unsupported
        ? 'unsupported_format'
        : error instanceof ExtractionFailedError
          ? error.reason
          : 'extraction_failed';

      /*
       * RETRYING A BAD FILE IS NOT A FIX. A malformed archive, a PDF with no
       * text layer and a format nothing can read are all properties of the file
       * itself: a second attempt costs the platform another parse and reaches
       * the same answer a minute later, while the customer watches a document
       * that says PROCESSING and never resolves. Only genuinely transient
       * failures — storage, a timeout — earn a retry.
       */
      const terminal =
        unsupported || !RETRYABLE_REASONS.has(reason) || job.attempts + 1 >= job.maxAttempts;

      return this.#fail(job.id, document.id, reason, reason, terminal);
    }
  }

  /**
   * Reconcile jobs stuck past their deadline.
   *
   * The F-65 lesson from Phase 4, applied before the defect rather than after
   * it: a sweep that throws on an unfixable row hands the same row back on
   * every pass and never makes progress. Each job is reconciled independently
   * and a failure to reconcile one does not stop the rest.
   */
  async sweepStuckJobs(stuckAfterSeconds: number): Promise<number> {
    const threshold = new Date(this.#clock.now().getTime() - stuckAfterSeconds * 1000);
    const stuck = await this.#db.brandIngestionJob.findMany({
      where: {
        stage: { in: ['QUEUED', 'EXTRACTING', 'CHUNKING', 'EXTRACTING_FACTS'] },
        startedAt: { lt: threshold },
      },
      orderBy: { queuedAt: 'asc' },
      take: 100,
    });

    let reconciled = 0;
    for (const job of stuck) {
      try {
        await this.#fail(
          job.id,
          job.sourceDocumentId,
          'Processing took too long and was stopped.',
          'stuck_timeout',
          job.attempts >= job.maxAttempts,
        );
        reconciled += 1;
      } catch {
        // One unfixable row must not starve the rest of the sweep.
        continue;
      }
    }
    return reconciled;
  }

  async #fail(
    jobId: string,
    documentId: string,
    /** A stable reason key the dashboard translates — never a sentence. */
    customerMessage: string,
    internalCode: string,
    terminal: boolean,
  ): Promise<ProcessResult> {
    const now = this.#clock.now();
    await this.#db.brandIngestionJob.update({
      where: { id: jobId },
      data: {
        stage: terminal ? 'FAILED' : 'QUEUED',
        failureMessage: customerMessage,
        failureCode: internalCode,
        ...(terminal
          ? { completedAt: now }
          : {
              nextAttemptAt: new Date(now.getTime() + this.#policy.retryBackoffSeconds * 1000),
            }),
      },
    });
    await this.#db.brandSourceDocument.update({
      where: { id: documentId },
      data: {
        // A retryable failure leaves the document PROCESSING: it has not
        // finished, and showing FAILED before the retries are spent would tell
        // the customer something untrue.
        status: terminal ? 'FAILED' : 'PROCESSING',
        failureMessage: terminal ? customerMessage : null,
      },
    });
    return {
      documentId,
      status: terminal ? 'FAILED' : 'PROCESSING',
      chunksCreated: 0,
      candidatesCreated: 0,
      failureMessage: customerMessage,
    };
  }
}
