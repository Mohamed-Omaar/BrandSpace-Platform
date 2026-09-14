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

export type MediaProcessingPayload = IngestSourceDocumentPayload;

/** The job name BullMQ dispatches on, kept next to the payload it belongs to. */
export const INGEST_SOURCE_DOCUMENT = 'brand-brain.ingest-source-document' as const;
