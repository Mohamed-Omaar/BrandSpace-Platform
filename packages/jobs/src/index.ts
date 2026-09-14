/**
 * Background job definitions and the client that dispatches them.
 *
 * WHY THIS IS A PACKAGE. The queue definitions used to live inside
 * `apps/worker`, which meant the only process that could see them was the one
 * that consumes jobs — and an app may not import another app. Producers
 * therefore had no way to reach them, which is why Phase 5A processed ingestion
 * inline in a server action: not a decision, an absence of somewhere to put the
 * dispatch. The definitions are architecture (docs/ARCHITECTURE.md §9), so they
 * belong where every side of the contract can see them.
 */
export {
  QUEUE_DEFINITIONS,
  QUEUE_NAMES,
  type QueueDefinition,
  type QueueName,
  type TenantJobPayload,
} from './queues';
export {
  INGEST_SOURCE_DOCUMENT,
  type IngestSourceDocumentPayload,
  type MediaProcessingPayload,
} from './payloads';
export {
  closeQueues,
  enqueue,
  mayProcessInline,
  queueFor,
  queueUrl,
  type EnqueueResult,
} from './client';
