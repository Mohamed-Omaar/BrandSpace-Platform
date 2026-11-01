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
  /*
   * A PRODUCER FAILS FAST; ONLY A CONSUMER WAITS (check-up 2026-10-28, M-7).
   *
   * This connection only ever issues non-blocking commands (`add`, `getJob`,
   * `remove`). `maxRetriesPerRequest: null` is what BullMQ requires of a
   * WORKER's blocking connection — the worker opens its own, in
   * `apps/worker/src/main.ts` — and on a producer it meant that with Redis
   * unreachable every `add()` waited in ioredis's offline queue for the whole
   * outage, so an upload or a queued action span instead of saving. With a
   * finite limit a queued command is failed after one reconnect attempt, and
   * `DISPATCH_DEADLINE_MS` below bounds the caller's wait either way.
   */
  connection ??= new IORedis(url, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
  });
  return connection;
}

/**
 * The longest a caller waits for Redis to accept a dispatch.
 *
 * TRANSPORT, NOT POLICY: a healthy Redis answers in milliseconds (31 ms was
 * measured against a live one), and a dispatch that misses this deadline is
 * reported as not dispatched, which every caller already handles — the row is
 * recorded, and the reconciliation sweep dispatches it later. The job id is the
 * idempotency key, so a late `add` that does land is never a second job.
 */
export const DISPATCH_DEADLINE_MS = 2_000;

class DispatchDeadlineError extends Error {
  override readonly name = 'DispatchDeadlineError';
}

async function withinDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DispatchDeadlineError()), DISPATCH_DEADLINE_MS);
    timer.unref?.();
  });
  // The losing side of the race must not surface as an unhandled rejection.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
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
    await withinDeadline(
      queueFor(name).add(jobName, payload, {
        // THE IDEMPOTENCY KEY IS THE JOB ID. BullMQ refuses a duplicate id, so a
        // double dispatch — a retried server action, a reconciler racing the
        // producer — becomes a no-op in Redis rather than a second parse.
        jobId: payload.idempotencyKey,
        ...options,
      }),
    );
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

/**
 * Dispatch a job whose id may already name a FINISHED job (Fix PR 1 · F2,
 * D-413).
 *
 * BullMQ keeps finished jobs (`removeOnComplete`, `removeOnFail`) and silently
 * ignores an add whose id already exists, whatever state that job is in. So a
 * reconciler re-dispatching a row that is due again — the same attempt, after
 * its message threw before the claim and exhausted BullMQ's own retries — would
 * report success and queue nothing, for as long as the old job was kept.
 *
 * A job that is still WAITING, DELAYED or ACTIVE is left exactly where it is,
 * so a sweep racing a live dispatch still adds nothing. Only a completed or
 * failed one is removed first. That is safe only because the DATABASE, not
 * Redis, decides what runs: the consumer claims its row with a compare-and-set
 * on the attempt the message names, so a second delivery of anything does
 * nothing.
 */
export async function enqueueReplacingFinished<Payload extends { readonly idempotencyKey: string }>(
  name: QueueName,
  jobName: string,
  payload: Payload,
): Promise<EnqueueResult> {
  if (!queueUrl()) return { dispatched: false };
  if (payload.idempotencyKey.includes(':')) return enqueue(name, jobName, payload);
  try {
    await withinDeadline(
      (async () => {
        const existing = await queueFor(name).getJob(payload.idempotencyKey);
        if (existing && ((await existing.isCompleted()) || (await existing.isFailed()))) {
          await existing.remove();
        }
      })(),
    );
  } catch (error: unknown) {
    log.error('could not inspect a finished job before re-dispatching it', {
      queue: name,
      job: jobName,
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return { dispatched: false };
  }
  return enqueue(name, jobName, payload);
}

/** Close the process-wide connection. Used by tests and by shutdown handlers. */
export async function closeQueues(): Promise<void> {
  for (const queue of queues.values()) await queue.close();
  queues.clear();
  await connection?.quit().catch(() => undefined);
  connection = null;
}
