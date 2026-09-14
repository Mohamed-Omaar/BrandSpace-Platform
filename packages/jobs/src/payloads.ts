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
