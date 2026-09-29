import {
  writeAuditEvent,
  type BrandIngestionJob,
  type BrandKnowledgeArea,
  type BrandSourceDocument,
  type Prisma,
  type TenantScopedClient,
} from '@brandspace/database';
import { QUOTA_FEATURES, QuotaExceededError, type UsageService } from '@brandspace/entitlements';
import {
  AppError,
  assertBrandInScope,
  brandIdQueryFilter,
  type Clock,
  systemClock,
} from '@brandspace/shared';
import type { ExtractorRegistry } from './extraction';
import {
  chunkText,
  ExtractionFailedError,
  ExtractionUnsupportedError,
  KeywordFactExtractor,
  type ExtractedText,
  type ExtractionFailureReason,
  type FactExtractor,
} from './extraction';
import { buildStorageKey, checksumOf, type ObjectStore } from './storage';
import {
  contentTypeMismatch,
  documentNotFound,
  duplicateUpload,
  fileTooLarge,
  readAgainUnavailable,
  sourceRefused,
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
  /**
   * B-8 — the workspace's storage quota, the SAME one the asset library
   * charges (`limit.storage_gb`, metered in exact bytes since B-1). Required
   * by `upload()`, which refuses to run without it rather than store bytes
   * nobody counted; a worker that only PROCESSES documents does not need it.
   */
  readonly storage?: {
    readonly usage: UsageService;
    /** The plan's limit in gigabytes, from the entitlements engine; null is unlimited. */
    readonly limitGb: number | null;
  };
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
  /**
   * The member's brand scope — docs/SECURITY.md §4.2, F-74.
   *
   * REQUIRED. An optional field would default to unrestricted, and a call site
   * that forgot it would silently admit every brand. Empty means unrestricted,
   * which is what the schema says and what every membership carries today.
   */
  readonly actorBrandScope: readonly string[];
}

/**
 * WHY AN UPLOAD WAS REFUSED — a stable key the dashboard translates (Phase
 * 2C-4). The same keys a processing failure stores, plus the three only the
 * door can raise. Never a sentence, never a library's words.
 */
export type UploadRefusalReason =
  'unsupported_format' | 'file_too_large' | 'content_does_not_match_type' | ExtractionFailureReason;

/**
 * What `receive()` did with one upload.
 *
 *   - `queued`   — accepted: bytes stored and charged, a job queued.
 *   - `refused`  — the bytes failed validation: a FAILED row with the reason,
 *                  nothing stored, nothing charged, no job.
 *   - `existing` — this request, or these bytes, already have a live row: it
 *                  is returned as it stands (a replayed request, or a live
 *                  FAILED row holding the checksum), and nothing is written.
 */
export type ReceiveOutcome = 'queued' | 'refused' | 'existing';

export interface ReceiveResult {
  readonly outcome: ReceiveOutcome;
  readonly document: BrandSourceDocument;
  /** The document's latest job; null for a row refused before storage. */
  readonly job: BrandIngestionJob | null;
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
  readonly #storage: IngestionServiceOptions['storage'];
  readonly #clock: Clock;

  constructor(options: IngestionServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#store = options.store;
    this.#policy = options.policy;
    this.#extractors = options.extractors;
    this.#facts = options.factExtractor ?? new KeywordFactExtractor();
    this.#storage = options.storage;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Accept an upload and queue it for processing — THE STRICT FORM.
   *
   * Every refusal is thrown as a typed error and nothing is written. The
   * dashboard uses `receive()`, which records a refusal as a visible FAILED
   * row instead (Phase 2C-4); both share the one validation and the one accept
   * path below, so there is still exactly one way a source gets stored.
   *
   * Validation happens BEFORE a byte is stored. Writing the object first and
   * validating after would leave orphaned objects behind every rejected upload,
   * and an object store nobody cleans up is a cost that compounds silently.
   */
  async upload(
    input: UploadInput,
  ): Promise<{ document: BrandSourceDocument; job: BrandIngestionJob }> {
    // BEFORE anything else. An out-of-scope brand is refused the way a missing
    // one is, and nothing is read, stored or counted on the way there.
    assertBrandInScope(input.actorBrandScope, input.brandId);

    const refusal = this.#refusalFor(input);
    if (refusal) throw refusalError(refusal);

    const checksum = await checksumOf(input.bytes);
    const request = await this.#resolveRequest(input.idempotencyKey);
    if (request.live) {
      // REQUEST idempotency: a retry of an upload whose response was lost.
      const job = await this.#latestJob(request.live.id);
      if (job) return { document: request.live, job };
      throw duplicateUpload();
    }

    // FILE identity: the same document uploaded twice.
    const duplicate = await this.#liveDuplicate(input.brandId, checksum);
    if (duplicate) throw duplicateUpload();

    await this.#assertRoomForDocument(input.brandId);
    return this.#accept(input, checksum, request.key);
  }

  /**
   * THE PRODUCT'S UPLOAD (Phase 2C-4): accept, refuse VISIBLY, or return what
   * already exists — and never answer a repeat with a raw constraint error.
   *
   * A REFUSED FILE BECOMES A FAILED ROW. Unsupported type, oversize, a
   * signature or OOXML type that disagrees with the declared type, text that is
   * not UTF-8: each is recorded as a source with `status = FAILED`, the stable
   * reason in `failureMessage`, `byteSize = 0` and an empty storage key. No
   * byte is stored and no quota is charged, so it costs nothing, and it yields
   * no chunk, no candidate and no fact. The customer sees WHY, in their own
   * language, on the row, instead of a banner that disappears.
   *
   * A FAILED ROW IS LIVE, so under M6 it holds its checksum. Uploading the same
   * bytes again — the same request, or another area, or another screen —
   * returns THAT row (`existing`) through the duplicate path, with its reason:
   * nothing new is written, nothing is charged twice, and no unique index is
   * ever reached. To try again the person uses Read again (a file that failed
   * DURING processing) or removes the row and uploads again.
   *
   * A live source that is NOT failed is still refused as a duplicate, with the
   * typed CONFLICT the screen already translates.
   */
  async receive(input: UploadInput): Promise<ReceiveResult> {
    assertBrandInScope(input.actorBrandScope, input.brandId);

    const checksum = await checksumOf(input.bytes);
    const request = await this.#resolveRequest(input.idempotencyKey);
    if (request.live) {
      return {
        outcome: 'existing',
        document: request.live,
        job: await this.#latestJob(request.live.id),
      };
    }

    const duplicate = await this.#liveDuplicate(input.brandId, checksum);
    if (duplicate) {
      if (duplicate.status !== 'FAILED') throw duplicateUpload();
      return {
        outcome: 'existing',
        document: duplicate,
        job: await this.#latestJob(duplicate.id),
      };
    }

    await this.#assertRoomForDocument(input.brandId);

    const refusal = this.#refusalFor(input);
    if (refusal) {
      const document = await this.#recordRefusal(input, checksum, request.key, refusal);
      return { outcome: 'refused', document, job: null };
    }

    const accepted = await this.#accept(input, checksum, request.key);
    return { outcome: 'queued', ...accepted };
  }

  /**
   * WHAT THE BYTES ARE, DECIDED BY THE BYTES (Phase 2C-4).
   *
   * In order, cheapest first: the configured allow-list (and an extractor that
   * can read the type), the exact configured size ceiling, the magic-number
   * signature, then the reading extractor's own bounded check — for DOCX and
   * PPTX the package's declared main part (`[Content_Types].xml`, one small
   * part inflated under the configured archive limits), for text a strict
   * UTF-8 decode of the whole file with NUL refused. The browser's type and
   * the file's extension choose WHICH checks apply; they never pass one.
   */
  #refusalFor(input: UploadInput): UploadRefusalReason | null {
    if (
      !this.#policy.allowedMimeTypes.includes(input.mimeType) ||
      !this.#extractors.supports(input.mimeType)
    ) {
      // Configuration may allow a type nothing can read; refusing at the door
      // is honest, where accepting would leave a document stuck in FAILED.
      return 'unsupported_format';
    }
    if (input.bytes.byteLength > this.#policy.maxFileBytes) return 'file_too_large';

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
    if (!checkSignature(input.mimeType, input.bytes).ok) return 'content_does_not_match_type';

    try {
      this.#extractors.validate({ bytes: input.bytes, mimeType: input.mimeType });
    } catch (error: unknown) {
      if (error instanceof ExtractionFailedError) return error.reason;
      if (error instanceof ExtractionUnsupportedError) return 'unsupported_format';
      throw error;
    }
    return null;
  }

  /**
   * THE REQUEST KEY, AND WHAT A REMOVED SOURCE DOES TO IT (Phase 2C-4).
   *
   * `idempotencyKey` is unique per workspace across EVERY row, removed ones
   * included, and the dashboard derives it from the bytes. So once a source is
   * removed, uploading the same file again would replay the removed row — or,
   * had the replay ignored it, fail on the index. And the storage charge is
   * keyed on it too, so a new upload wearing the old key would be taken as a
   * replay of the old charge and stored without being counted.
   *
   * A removed row therefore ENDS its key's generation: the next upload with the
   * same key is recorded as `<key>#2`, the one after the next removal as
   * `<key>#3`. A retried request still lands on the same live row (the chain is
   * read from the database, not from the client), the charge key follows the
   * generation, and no schema changes. A live row at any generation is the
   * request's replay.
   */
  async #resolveRequest(
    idempotencyKey: string,
  ): Promise<{ key: string; live: BrandSourceDocument | null }> {
    const generations = await this.#db.brandSourceDocument.findMany({
      where: {
        OR: [
          { idempotencyKey },
          { idempotencyKey: { startsWith: `${idempotencyKey}${GENERATION_SEPARATOR}` } },
        ],
      },
    });
    const ofThisKey = generations.filter(
      (row) =>
        row.idempotencyKey === idempotencyKey ||
        GENERATION_PATTERN.test(row.idempotencyKey.slice(idempotencyKey.length)),
    );
    const live = ofThisKey.find((row) => row.deletedAt === null) ?? null;
    if (live) return { key: live.idempotencyKey, live };
    if (ofThisKey.length === 0) return { key: idempotencyKey, live: null };
    return {
      key: `${idempotencyKey}${GENERATION_SEPARATOR}${ofThisKey.length + 1}`,
      live: null,
    };
  }

  async #latestJob(documentId: string): Promise<BrandIngestionJob | null> {
    return this.#db.brandIngestionJob.findFirst({
      where: { sourceDocumentId: documentId },
      orderBy: { queuedAt: 'desc' },
    });
  }

  async #liveDuplicate(brandId: string, checksum: string): Promise<BrandSourceDocument | null> {
    return this.#db.brandSourceDocument.findFirst({
      where: { brandId, checksum, deletedAt: null },
    });
  }

  async #assertRoomForDocument(brandId: string): Promise<void> {
    const liveCount = await this.#db.brandSourceDocument.count({
      where: { brandId, deletedAt: null },
    });
    if (liveCount >= this.#policy.maxDocumentsPerBrand) throw storageLimitReached();
  }

  /** A refused upload, recorded: FAILED, zero bytes, nothing stored, nothing charged. */
  async #recordRefusal(
    input: UploadInput,
    checksum: string,
    requestKey: string,
    reason: UploadRefusalReason,
  ): Promise<BrandSourceDocument> {
    const document = await this.#db.brandSourceDocument.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        // Nothing was stored, so nothing is counted — here or in the quota.
        byteSize: 0,
        checksum,
        // No object exists for this row; an empty key names none.
        storageKey: '',
        status: 'FAILED',
        failureMessage: reason,
        idempotencyKey: requestKey,
        uploadedByUserId: input.actorUserId,
        ...(input.targetArea ? { targetArea: input.targetArea } : {}),
      },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'brand_brain.source.refused',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'BrandSourceDocument',
      resourceId: document.id,
      brandId: input.brandId,
      // The size ATTEMPTED is metadata, kept here and not on the row, whose
      // `byteSize` means stored bytes. The content never enters an audit event.
      after: {
        fileName: input.fileName,
        mimeType: input.mimeType,
        attemptedBytes: input.bytes.byteLength,
        reason,
      },
    });
    return document;
  }

  /** The one accept path: charge, record, store, queue, audit. */
  async #accept(
    input: UploadInput,
    checksum: string,
    requestKey: string,
  ): Promise<{ document: BrandSourceDocument; job: BrandIngestionJob }> {
    /*
     * B-8 — A SOURCE DOCUMENT IS STORAGE, AND IT IS COUNTED LIKE ANY FILE.
     *
     * Brand Brain uploads went to the object store without touching the
     * workspace's storage quota, so a plan's storage limit could be exceeded
     * without limit through this door. The exact bytes are charged here,
     * AFTER every refusal that needs no bytes and BEFORE anything is written,
     * so a refused upload costs nothing and stores nothing. The key names this
     * workspace and this upload, so a retried request is charged once; the
     * replay above returns before reaching it.
     */
    await this.#chargeStorage(input.bytes.byteLength, requestKey);

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
        idempotencyKey: requestKey,
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
   * READ AGAIN (Phase 2C-4, D5) — re-process THE SAME document through the
   * same pipeline, as a NEW job.
   *
   * A NEW `brand_ingestion_job` ROW, NOT THE OLD ONE RE-QUEUED. The dispatch's
   * BullMQ job id is `ingest-<job row id>`, and BullMQ keeps finished jobs and
   * refuses a duplicate id — so re-queuing the previous row would dispatch an id
   * Redis still holds, and the read would silently never run. A fresh row gets
   * a fresh id, and the existing partial unique index
   * (`brand_ingestion_job_one_live`) keeps it to one job in flight per
   * document: a second Read again while one runs is refused, not doubled.
   *
   * Only once the previous read is TERMINAL (completed or failed), and only for
   * a document whose bytes were stored — a file refused at the door has
   * nothing to read; it is removed and uploaded again. What the read produces
   * is decided by `process()`: PENDING proposals only, reviewed candidates
   * left alone, approved knowledge never touched.
   */
  async readAgain(input: {
    readonly documentId: string;
    readonly actorUserId: string;
    readonly actorBrandScope: readonly string[];
  }): Promise<{ document: BrandSourceDocument; job: BrandIngestionJob }> {
    const document = await this.#db.brandSourceDocument.findFirst({
      where: {
        id: input.documentId,
        deletedAt: null,
        ...brandIdQueryFilter({ brandScope: input.actorBrandScope }),
      },
    });
    if (!document) throw documentNotFound();
    if (document.byteSize === 0 || document.storageKey === '') throw readAgainUnavailable();

    const previous = await this.#latestJob(document.id);
    if (previous && !TERMINAL_STAGES.has(previous.stage)) throw readAgainUnavailable();

    const job = await this.#db.brandIngestionJob.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: document.brandId,
        sourceDocumentId: document.id,
        stage: 'QUEUED',
        maxAttempts: this.#policy.maxAttempts,
        queuedAt: this.#clock.now(),
      },
    });
    const queued = await this.#db.brandSourceDocument.update({
      where: { id: document.id },
      data: { status: 'UPLOADED', failureMessage: null },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'brand_brain.source.read_again',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'BrandSourceDocument',
      resourceId: document.id,
      brandId: document.brandId,
      after: { jobId: job.id, previousJobId: previous?.id ?? null },
    });

    return { document: queued, job };
  }

  async #chargeStorage(bytes: number, idempotencyKey: string): Promise<void> {
    if (!this.#storage) {
      throw new AppError('INTERNAL', 'Uploading a source document requires the storage quota.');
    }
    try {
      await this.#storage.usage.consumeBytes({
        workspaceId: this.#workspaceId,
        featureKey: QUOTA_FEATURES.storageGb,
        limitGb: this.#storage.limitGb,
        bytes,
        idempotencyKey: `brand-source-upload:${this.#workspaceId}:${idempotencyKey}`,
      });
    } catch (error) {
      // The engine's refusal names an internal feature key; the customer is
      // told the same thing the asset library tells them.
      if (error instanceof QuotaExceededError) throw storageLimitReached();
      throw error;
    }
  }

  /**
   * Run one queued job to completion, in ONE database context.
   *
   * IDEMPOTENT AND SAFE TO RETRY (CLAUDE.md §5). Chunks and candidates for the
   * document are cleared before they are rewritten, so a job that died halfway
   * and is retried produces one clean set rather than duplicates layered on a
   * partial run. Clearing candidates is deliberately limited to PENDING ones:
   * a candidate a human already reviewed is a DECISION, and a retry must never
   * erase it.
   *
   * THE WORKER DOES NOT CALL THIS (Phase 2C-4). It runs the same three phases
   * — `startProcessing`, `extractSourceDocument`, `finishProcessing` — with the
   * extraction OUTSIDE any database transaction, so a tenant transaction is
   * never held open for the length of a parse. This composition is kept for
   * callers that already hold one short-lived context and a small document.
   */
  async process(jobId: string): Promise<ProcessResult> {
    const started = await this.startProcessing(jobId);
    const outcome = await extractSourceDocument({
      store: this.#store,
      extractors: this.#extractors,
      started,
    });
    return this.finishProcessing(started, outcome);
  }

  /**
   * PHASE 1 of 3 — claim the job: EXTRACTING, one more attempt, the document
   * PROCESSING. A short write, committed before any byte is parsed.
   */
  async startProcessing(jobId: string): Promise<StartedIngestion> {
    const job = await this.#db.brandIngestionJob.findUnique({ where: { id: jobId } });
    if (!job) throw documentNotFound();

    const document = await this.#db.brandSourceDocument.findUnique({
      where: { id: job.sourceDocumentId },
    });
    if (!document) throw documentNotFound();

    const started: StartedIngestion = {
      jobId: job.id,
      documentId: document.id,
      brandId: document.brandId,
      storageKey: document.storageKey,
      mimeType: document.mimeType,
      fileName: document.fileName,
      targetArea: document.targetArea ?? null,
      attempt: job.attempts + 1,
      maxAttempts: job.maxAttempts,
      removed: document.deletedAt !== null,
    };
    // A document removed while its job waited (Phase 2C-4): nothing is claimed
    // and nothing is parsed; Remove already ended the job.
    if (started.removed) return started;

    const now = this.#clock.now();
    await this.#db.brandIngestionJob.update({
      where: { id: job.id },
      data: { stage: 'EXTRACTING', attempts: { increment: 1 }, startedAt: now },
    });
    await this.#db.brandSourceDocument.update({
      where: { id: document.id },
      data: { status: 'PROCESSING' },
    });

    return started;
  }

  /**
   * PHASE 3 of 3 — persist what the extraction produced, atomically, in one
   * short transaction: the chunks, the PENDING candidates and the READY state,
   * or the failure and whether it is terminal.
   */
  async finishProcessing(
    started: StartedIngestion,
    outcome: ExtractionOutcome,
  ): Promise<ProcessResult> {
    /*
     * REMOVED WHILE IT WAS BEING READ (Phase 2C-4). Remove soft-deleted the
     * document, cleared its chunks, superseded its proposals and ended this
     * job; writing the extraction now would bring them back for a source that
     * no longer exists. Nothing is written.
     */
    const current = await this.#db.brandSourceDocument.findUnique({
      where: { id: started.documentId },
      select: { deletedAt: true },
    });
    if (started.removed || !current || current.deletedAt !== null) {
      return {
        documentId: started.documentId,
        status: 'FAILED',
        chunksCreated: 0,
        candidatesCreated: 0,
        failureMessage: 'source_removed',
      };
    }

    if (!outcome.ok) {
      /*
       * RETRYING A BAD FILE IS NOT A FIX. A malformed archive, a PDF with no
       * text layer and a format nothing can read are all properties of the file
       * itself: a second attempt costs the platform another parse and reaches
       * the same answer a minute later, while the customer watches a document
       * that says PROCESSING and never resolves. Only genuinely transient
       * failures — storage, a timeout — earn a retry.
       */
      const terminal =
        outcome.terminal ||
        !RETRYABLE_REASONS.has(outcome.reason) ||
        started.attempt >= started.maxAttempts;
      return this.#fail(
        started.jobId,
        started.documentId,
        outcome.reason,
        outcome.reason,
        terminal,
      );
    }

    const extracted = outcome.extracted;
    try {
      await this.#db.brandIngestionJob.update({
        where: { id: started.jobId },
        data: { stage: 'CHUNKING' },
      });

      const chunks = chunkText(extracted.text, extracted.boundaries, {
        targetChars: this.#policy.chunkTargetChars,
        overlapChars: this.#policy.chunkOverlapChars,
        maxChunks: this.#policy.maxChunksPerDocument,
      });

      // Idempotent rewrite. Chunks are derived data — deleting and recreating
      // them loses nothing, and is what makes a retry produce one clean set.
      await this.#db.brandSourceChunk.deleteMany({
        where: { sourceDocumentId: started.documentId },
      });
      if (chunks.length > 0) {
        await this.#db.brandSourceChunk.createMany({
          data: chunks.map((chunk) => ({
            workspaceId: this.#workspaceId,
            brandId: started.brandId,
            sourceDocumentId: started.documentId,
            chunkIndex: chunk.index,
            text: chunk.text,
            locator: chunk.locator,
          })),
        });
      }

      await this.#db.brandIngestionJob.update({
        where: { id: started.jobId },
        data: { stage: 'EXTRACTING_FACTS', chunksCreated: chunks.length },
      });

      const facts = await this.#facts.extract({
        chunks,
        targetArea: started.targetArea,
        minimumConfidenceMilli: this.#policy.minimumCandidateConfidenceMilli,
      });

      // Only PENDING candidates are cleared. A reviewed one is a decision.
      await this.#db.brandKnowledgeCandidate.deleteMany({
        where: { sourceDocumentId: started.documentId, status: 'PENDING' },
      });

      const storedChunks = await this.#db.brandSourceChunk.findMany({
        where: { sourceDocumentId: started.documentId },
        select: { id: true, chunkIndex: true },
      });
      const chunkIdByIndex = new Map(storedChunks.map((c) => [c.chunkIndex, c.id]));

      let created = 0;
      for (const fact of facts) {
        // A candidate whose key already has a REVIEWED candidate would
        // re-propose something a human settled. Skipped rather than re-raised.
        // This is also why Read again never duplicates approved knowledge: a
        // key this document already had ACCEPTED is not proposed again.
        const settled = await this.#db.brandKnowledgeCandidate.findFirst({
          where: {
            brandId: started.brandId,
            sourceDocumentId: started.documentId,
            itemKey: fact.itemKey,
            status: { in: ['ACCEPTED', 'EDITED_ACCEPTED', 'REJECTED'] },
          },
        });
        if (settled) continue;

        const existing = await this.#db.brandKnowledgeItem.findFirst({
          where: { brandId: started.brandId, area: fact.area, itemKey: fact.itemKey },
        });

        await this.#db.brandKnowledgeCandidate.create({
          data: {
            workspaceId: this.#workspaceId,
            brandId: started.brandId,
            sourceDocumentId: started.documentId,
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
              // D4 (Phase 2C): why the confidence is what it is, for the inbox.
              ...(e.method ? { method: e.method } : {}),
              ...(e.keywordHits !== undefined ? { keywordHits: e.keywordHits } : {}),
              ...(e.aimedArea !== undefined ? { aimedArea: e.aimedArea } : {}),
            })) as Prisma.InputJsonValue,
          },
        });
        created += 1;
      }

      await this.#db.brandIngestionJob.update({
        where: { id: started.jobId },
        data: {
          stage: 'COMPLETED',
          candidatesCreated: created,
          completedAt: this.#clock.now(),
          failureMessage: null,
          failureCode: null,
        },
      });
      await this.#db.brandSourceDocument.update({
        where: { id: started.documentId },
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
        resourceId: started.documentId,
        brandId: started.brandId,
        after: { chunks: chunks.length, candidates: created },
      });

      return {
        documentId: started.documentId,
        status: 'READY',
        chunksCreated: chunks.length,
        candidatesCreated: created,
        failureMessage: null,
      };
    } catch {
      // Chunking and proposing are our own code over text already read; a
      // failure here is ours, stored as the general reason key, never as the
      // error's words.
      return this.#fail(
        started.jobId,
        started.documentId,
        'extraction_failed',
        'extraction_failed',
        started.attempt >= started.maxAttempts,
      );
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
          // A reason KEY, like every other failure (Phase 2C-4).
          'stuck_timeout',
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

/** What `startProcessing` claimed: everything the extraction needs, and no client. */
export interface StartedIngestion {
  readonly jobId: string;
  readonly documentId: string;
  readonly brandId: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly fileName: string;
  readonly targetArea: BrandKnowledgeArea | null;
  /** This attempt's number, counting from 1. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** The document was removed before the job ran: nothing is read or written. */
  readonly removed: boolean;
}

/** What the extraction produced: the text, or a stable reason and whether it is final. */
export type ExtractionOutcome =
  | { readonly ok: true; readonly extracted: ExtractedText }
  | { readonly ok: false; readonly reason: string; readonly terminal: boolean };

/**
 * PHASE 2 of 3 — read the stored bytes and extract their text, with NO
 * database access at all (Phase 2C-4).
 *
 * THIS IS THE ONLY PLACE UNTRUSTED DOCUMENT BYTES ARE PARSED, and the worker is
 * the only process that calls it: it takes an object store and an extractor
 * registry and nothing else, so it cannot hold, open or extend a tenant
 * transaction while a parse runs up to `extraction.timeoutMs`. The registry
 * the worker passes carries that timeout for the whole operation.
 *
 * THE CUSTOMER-FACING REASON IS DECIDED HERE, NOT DERIVED FROM THE ERROR. An
 * extractor's message can carry a file path, a library version or a stack
 * fragment, and none of that belongs on a customer's screen (docs/SECURITY.md).
 * A stable key is returned instead, which the dashboard translates.
 */
export async function extractSourceDocument(input: {
  readonly store: ObjectStore;
  readonly extractors: ExtractorRegistry;
  readonly started: StartedIngestion;
}): Promise<ExtractionOutcome> {
  if (input.started.removed) return { ok: false, reason: 'source_removed', terminal: true };
  let bytes: Uint8Array | null;
  try {
    bytes = await input.store.get(input.started.storageKey);
  } catch {
    return { ok: false, reason: 'extraction_failed', terminal: false };
  }
  // The row exists and the object does not. Retrying cannot fix it.
  if (!bytes) return { ok: false, reason: 'object_missing', terminal: true };

  try {
    const extracted = await input.extractors.extract({
      bytes,
      mimeType: input.started.mimeType,
      fileName: input.started.fileName,
    });
    return { ok: true, extracted };
  } catch (error: unknown) {
    if (error instanceof ExtractionUnsupportedError) {
      return { ok: false, reason: 'unsupported_format', terminal: true };
    }
    if (error instanceof ExtractionFailedError) {
      return { ok: false, reason: error.reason, terminal: false };
    }
    return { ok: false, reason: 'extraction_failed', terminal: false };
  }
}

/** A job in one of these stages is finished; Read again may start another. */
const TERMINAL_STAGES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED']);

/** How a removed source's request key starts its next generation (`<key>#2`). */
const GENERATION_SEPARATOR = '#';
const GENERATION_PATTERN = /^#\d+$/;

/** The strict `upload()`'s typed error for each refusal reason. */
function refusalError(reason: UploadRefusalReason) {
  switch (reason) {
    case 'unsupported_format':
      return unsupportedFileType();
    case 'file_too_large':
      return fileTooLarge();
    case 'content_does_not_match_type':
    case 'ooxml_type_mismatch':
      return contentTypeMismatch();
    default:
      return sourceRefused(reason);
  }
}

/**
 * Ingestion jobs nothing has claimed, oldest first.
 *
 * SEPARATE FROM ANY DISPATCH, so the selection rule can be tested without a
 * queue — and it is the whole of the reconciliation sweep's correctness: QUEUED
 * with its next attempt due, which is exactly the condition the producer's own
 * dispatch races. A job already RUNNING is deliberately excluded, because the
 * worker holds a lock on it and re-dispatching would only queue a message the
 * processor discards. A job in a terminal stage is excluded for the same
 * reason.
 *
 * IT TAKES A CLIENT RATHER THAN OPENING ONE, and the caller's identity decides
 * what it can see. A tenant-scoped client returns that workspace's jobs; the
 * platform identity returns every tenant's, which is what the sweep in the
 * designated platform surface needs and what "ordinary workers" must not have
 * (F-07). This function grants nothing: it asks a question with whatever reach
 * the caller already had.
 */
export async function findUnclaimedIngestionJobs(
  db: {
    brandIngestionJob: {
      findMany(args: unknown): Promise<Array<{ id: string; workspaceId: string }>>;
    };
  },
  now: Date,
  limit: number,
): Promise<Array<{ id: string; workspaceId: string }>> {
  return db.brandIngestionJob.findMany({
    where: {
      stage: 'QUEUED',
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    select: { id: true, workspaceId: true },
    // Oldest first with an id tie-break: deterministic, and the document that
    // has been waiting longest goes first.
    orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}
