/**
 * Queue definitions — docs/ARCHITECTURE.md §9.
 *
 * Each queue is a future service-extraction boundary. Every job carries tenant
 * context and is idempotent; the worker re-resolves and re-applies the tenant
 * context before touching data, so a forged workspaceId fails authorization rather
 * than executing (docs/SECURITY.md §2.1 layer 8).
 */

export const QUEUE_NAMES = [
  'ai-jobs',
  'publish-jobs',
  'analytics-ingest',
  'notifications',
  'billing-events',
  'media-processing',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export interface QueueDefinition {
  readonly name: QueueName;
  readonly concurrency: number;
  readonly maxAttempts: number;
  readonly backoff: 'exponential' | 'fixed';
  /** The phase in which this queue starts processing real work. */
  readonly activeFromPhase: number;
}

export const QUEUE_DEFINITIONS: Record<QueueName, QueueDefinition> = {
  'ai-jobs': {
    name: 'ai-jobs',
    concurrency: 10,
    maxAttempts: 3,
    backoff: 'exponential',
    activeFromPhase: 4,
  },
  'publish-jobs': {
    name: 'publish-jobs',
    concurrency: 5,
    maxAttempts: 5,
    backoff: 'exponential',
    activeFromPhase: 6,
  },
  'analytics-ingest': {
    name: 'analytics-ingest',
    concurrency: 5,
    maxAttempts: 3,
    backoff: 'exponential',
    activeFromPhase: 7,
  },
  notifications: {
    name: 'notifications',
    concurrency: 20,
    maxAttempts: 5,
    backoff: 'exponential',
    activeFromPhase: 2,
  },
  'billing-events': {
    name: 'billing-events',
    concurrency: 2,
    maxAttempts: 8,
    backoff: 'exponential',
    activeFromPhase: 8,
  },
  'media-processing': {
    name: 'media-processing',
    concurrency: 3,
    maxAttempts: 3,
    backoff: 'fixed',
    activeFromPhase: 5,
  },
};

/** Every job payload carries the tenant context it must be re-authorized against. */
export interface TenantJobPayload {
  readonly workspaceId: string;
  readonly requestedByUserId?: string;
  readonly idempotencyKey: string;
  readonly traceId?: string;
}
