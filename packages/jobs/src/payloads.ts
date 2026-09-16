import type { TenantJobPayload } from './queues';

/**
 * The payloads this platform's queues carry.
 *
 * ONE FILE, SO A PRODUCER AND A CONSUMER CANNOT DISAGREE. A queue message is a
 * contract between two processes that deploy separately: the shape has to be
 * declared somewhere both can see, or the day they drift is the day jobs start
 * failing in a way neither side's tests can catch.
 *
 * Every payload extends `TenantJobPayload`, so every job carries the workspace
 * it belongs to and the idempotency key it can be replayed under
 * (docs/ARCHITECTURE.md §9).
 */

/**
 * Process one uploaded source document.
 *
 * THE PAYLOAD IS A POINTER, NEVER THE WORK. It names a `brand_ingestion_job`
 * row and nothing else: no file bytes, no extracted text, no customer content.
 * Redis is not a tenant-isolated store and is not encrypted at rest the way the
 * database is, so putting a customer's brand guidelines in a queue message
 * would move their data somewhere none of the isolation guarantees reach.
 *
 * It also makes the message SAFE TO REPLAY. The database row is the state; a
 * duplicate delivery re-reads it, finds the job already done, and stops.
 */
export interface IngestSourceDocumentPayload extends TenantJobPayload {
  readonly kind: 'brand-brain.ingest-source-document';
  readonly ingestionJobId: string;
}

/**
 * Process one uploaded asset: scan, then inspect, then derive.
 *
 * THE SAME SHAPE AND THE SAME REASONS as the ingestion payload above. It names
 * an `asset_processing_job` row and a workspace, and nothing else: no bytes, no
 * file name, no customer content. Redis is not tenant-isolated and is not
 * encrypted at rest the way the database is, so a customer file name in a queue
 * message would move their data somewhere none of the isolation guarantees
 * reach — and a file name is exactly the sort of thing that carries
 * "Acquisition-termsheet-Q4.pdf".
 *
 * IT SHARES THE `media-processing` QUEUE with Brand Brain ingestion rather than
 * taking one of its own. Both are "read a customer upload on a worker", both
 * are bounded by configured wall-clock limits, and both want the same modest
 * concurrency. A second queue would be a second thing to provision, monitor and
 * drain for no behavioural difference; the `kind` discriminant is what routes
 * them apart, and the consumer switches on it exhaustively.
 */
export interface ProcessAssetPayload extends TenantJobPayload {
  readonly kind: 'assets.process-asset';
  readonly processingJobId: string;
}

/**
 * Everything the `media-processing` queue carries.
 *
 * A DISCRIMINATED UNION, so adding a member without handling it is a compile
 * error in the consumer rather than a message that is silently dropped.
 */
export type MediaProcessingPayload = IngestSourceDocumentPayload | ProcessAssetPayload;

/** The job names BullMQ dispatches on, kept next to the payloads they belong to. */
export const INGEST_SOURCE_DOCUMENT = 'brand-brain.ingest-source-document' as const;
export const PROCESS_ASSET = 'assets.process-asset' as const;

/**
 * Publish one content variant to one connected account — Phase 6.
 *
 * THE PAYLOAD IS A POINTER, AND HERE THAT RULE IS LOAD-BEARING RATHER THAN
 * MERELY TIDY. It names a `publish_job` row and a workspace. It does NOT carry
 * the caption, the hashtags, the account name, or — above all — the OAuth
 * token. Redis is not tenant-isolated, is not encrypted at rest the way the
 * database is, and a queue message is visible to anyone who can read the
 * instance; a token in one would be a customer's whole social account sitting
 * outside every guarantee this platform makes about credentials.
 *
 * THE WORKER RESOLVES THE CREDENTIAL ITSELF, inside the workspace's own RLS
 * context, from `social_credential`, and decrypts it with the social key domain
 * (D-136). That is the only path, and it exists in one file.
 *
 * `idempotencyKey` IS CARRIED DELIBERATELY EVEN THOUGH THE ROW HOLDS IT. It is
 * what BullMQ de-duplicates on, so a double dispatch collapses before a worker
 * is ever woken — and it matches the row, so a message that somehow disagreed
 * with the database is a message the processor refuses rather than acts on.
 */
export interface PublishSocialPostPayload extends TenantJobPayload {
  readonly kind: 'social.publish-post';
  readonly publishJobId: string;
}

/**
 * Recover a job whose worker died between the claim and the answer (D-143).
 *
 * A SEPARATE KIND, NOT A FLAG ON THE ONE ABOVE, and the separation is the
 * safety property. `social.publish-post` may send; `social.verify-post` may
 * only ASK. A boolean on a single payload would put both behaviours behind one
 * code path and one `if`, which is how an uncertain outcome gets re-sent by a
 * mistake nobody notices — the exact defect this whole mechanism exists to
 * prevent. Two kinds means the publishing path is unreachable from a
 * verification message, by construction.
 */
export interface VerifySocialPostPayload extends TenantJobPayload {
  readonly kind: 'social.verify-post';
  readonly publishJobId: string;
}

/**
 * Everything the `publish-jobs` queue carries.
 *
 * The discriminant is what makes adding a kind a compile error in the consumer
 * rather than a silently dropped message.
 */
export type PublishJobsPayload = PublishSocialPostPayload | VerifySocialPostPayload;

export const PUBLISH_SOCIAL_POST = 'social.publish-post' as const;
export const VERIFY_SOCIAL_POST = 'social.verify-post' as const;

/**
 * Pull one connection's analytics for one window — Phase 7.
 *
 * THE PAYLOAD IS A POINTER, for the third time in this file and for the same
 * reasons: it names an `analytics_ingestion_cursor` row and a workspace, and
 * nothing else. No token, no metric value, no account name. Redis is not
 * tenant-isolated and is not encrypted at rest the way the database is, and a
 * customer's follower count sitting in a queue message is their performance data
 * outside every guarantee this platform makes about it.
 *
 * THE WORKER RESOLVES THE CREDENTIAL ITSELF, inside the workspace's own RLS
 * context, from `social_credential`, decrypted with the SOCIAL key domain
 * (D-136) — the same path publishing uses, and the only one.
 *
 * `kind` DISTINGUISHES A SCHEDULED PULL FROM A BACKFILL, and they are separate
 * members rather than a boolean for the reason `social.verify-post` is separate
 * from `social.publish-post`: the two walk the window in opposite directions and
 * one of them is bounded by a horizon the other does not have. A flag would put
 * both behaviours behind one `if`.
 */
export interface IngestAnalyticsPayload extends TenantJobPayload {
  readonly kind: 'analytics.ingest';
  readonly cursorId: string;
}

export interface BackfillAnalyticsPayload extends TenantJobPayload {
  readonly kind: 'analytics.backfill';
  readonly cursorId: string;
}

/**
 * Evaluate the automation rules listening for one event.
 *
 * A POINTER AGAIN: the brand, the trigger type and the row that fired it. The
 * FACTS a condition reads are gathered by the processor from the database, not
 * carried in the message — a fact in a queue message is a fact that was true when
 * the message was written and may not be when it is read, and an automation that
 * acted on stale facts would be the hardest kind of bug to see.
 */
export interface EvaluateAutomationPayload extends TenantJobPayload {
  readonly kind: 'automation.evaluate';
  readonly brandId: string;
  readonly triggerType: string;
  readonly refType: string | null;
  readonly refId: string | null;
}

/** Everything the `analytics-ingest` queue carries. */
export type AnalyticsIngestPayload =
  IngestAnalyticsPayload | BackfillAnalyticsPayload | EvaluateAutomationPayload;

export const INGEST_ANALYTICS = 'analytics.ingest' as const;
export const BACKFILL_ANALYTICS = 'analytics.backfill' as const;
export const EVALUATE_AUTOMATION = 'automation.evaluate' as const;
