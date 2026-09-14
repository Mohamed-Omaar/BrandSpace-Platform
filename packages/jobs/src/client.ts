import { Queue, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { createLogger } from '@brandspace/shared';
import { QUEUE_DEFINITIONS, type QueueName } from './queues';

/**
 * Producing side of the queue.
 *
 * ONE CONNECTION PER PROCESS, opened lazily. A Next.js server action that
 * opened a Redis connection per request would exhaust the server's file
 * descriptors long before it exhausted Redis.
 *
 * REDIS IS OPTIONAL, AND WHAT THAT MEANS DEPENDS ON THE ENVIRONMENT. A
 * developer running the dashboard alone should not have to run Redis to see an
 * upload work, so `enqueue` reports that it could not dispatch and the caller
 * decides. In production the caller must NOT quietly do the work itself — see
 * `mayProcessInline` — because inline processing in a request handler is
 * unbounded work on the latency path and a document that dies with the process.
 */

const log = createLogger({ context: { component: 'jobs.client' } });

let connection: Redis | null = null;
const queues = new Map<QueueName, Queue>();

export function queueUrl(): string | null {
  return process.env['REDIS_URL'] ?? null;
}

/**
 * Whether a caller that could not enqueue may do the work inline instead.
 *
 * FALSE IN PRODUCTION, ALWAYS. The brief's rule, and the right one: inline
 * processing is a silent capacity and reliability change — the request holds a
 * connection for the whole parse, one slow document delays every other request
 * on that instance, and a deploy mid-parse loses the work with no record that
 * it was lost. Outside production it is the difference between a working local
 * setup and one that needs a Redis container to try an upload.
 */
export function mayProcessInline(): boolean {
  return (process.env['APP_ENV'] ?? 'development') !== 'production';
}

function redis(): Redis {
  const url = queueUrl();
  if (!url) throw new Error('REDIS_URL is not configured.');
  connection ??= new IORedis(url, {
    // BullMQ requires this: with a retry limit, a blocking command that outlives
    // a reconnect is dropped and the worker silently stops consuming.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return connection;
}

export function queueFor(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    const definition = QUEUE_DEFINITIONS[name];
    queue = new Queue(name, {
      connection: redis(),
      defaultJobOptions: {
        attempts: definition.maxAttempts,
        backoff: { type: definition.backoff === 'fixed' ? 'fixed' : 'exponential', delay: 5_000 },
        // Keep a bounded history. An unbounded completed set is a slow Redis
        // memory leak that shows up weeks later as an eviction.
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    });
    queues.set(name, queue);
  }
  return queue;
}

export interface EnqueueResult {
  readonly dispatched: boolean;
}

/**
 * Dispatch a job, reporting rather than throwing when it cannot.
 *
 * A failure here is NOT a failure of the caller's operation: the upload has
 * already been recorded, and the reconciliation sweep exists precisely so that
 * a lost dispatch degrades punctuality rather than correctness
 * (docs/ARCHITECTURE.md §9). The caller logs, and carries on.
 */
export async function enqueue<Payload extends { readonly idempotencyKey: string }>(
  name: QueueName,
  jobName: string,
  payload: Payload,
  options: JobsOptions = {},
): Promise<EnqueueResult> {
  if (!queueUrl()) return { dispatched: false };

  /*
   * BULLMQ REFUSES A CUSTOM JOB ID CONTAINING `:` — it uses the colon as its own
   * key separator in Redis. Checked here, and named, because the way it fails
   * otherwise is the worst kind: the dispatch throws deep inside the library,
   * this function reports "could not dispatch", the reconciliation sweep picks
   * the row up, dispatches it again, fails again, and the document is retried
   * forever while every log line says only that something went wrong.
   */
  if (payload.idempotencyKey.includes(':')) {
    log.error('a job key contains a colon, which BullMQ cannot use as a job id', {
      queue: name,
      job: jobName,
    });
    return { dispatched: false };
  }

  try {
    await queueFor(name).add(jobName, payload, {
      // THE IDEMPOTENCY KEY IS THE JOB ID. BullMQ refuses a duplicate id, so a
      // double dispatch — a retried server action, a reconciler racing the
      // producer — becomes a no-op in Redis rather than a second parse.
      jobId: payload.idempotencyKey,
      ...options,
    });
    return { dispatched: true };
  } catch (error: unknown) {
    log.error('could not dispatch a job', {
      queue: name,
      job: jobName,
      // The message only. A Redis error can carry a host and a port.
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return { dispatched: false };
  }
}

/** Close the process-wide connection. Used by tests and by shutdown handlers. */
export async function closeQueues(): Promise<void> {
  for (const queue of queues.values()) await queue.close();
  queues.clear();
  await connection?.quit().catch(() => undefined);
  connection = null;
}
