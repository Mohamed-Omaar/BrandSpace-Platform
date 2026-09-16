import { createServer } from 'node:http';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import {
  QUEUE_DEFINITIONS,
  QUEUE_NAMES,
  queueUrl,
  type MediaProcessingPayload,
  type PublishJobsPayload,
} from '@brandspace/jobs';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { processAssetJob } from './processors/assets';
import { processIngestionJob } from './processors/ingestion';
import { processPublishJob, processVerifyJob } from './processors/publishing';

/**
 * Worker entrypoint.
 *
 * WHAT IDENTITY THIS PROCESS HOLDS. The TENANT one, and only that. F-07 and
 * docs/ARCHITECTURE.md name "ordinary workers" among the applications that must
 * never hold the platform credential, so nothing here can read across
 * workspaces: every job carries the workspace it belongs to, and the processor
 * re-enters that workspace's context before touching a row
 * (docs/ARCHITECTURE.md §9, docs/SECURITY.md §2.1 layer 8). A forged
 * `workspaceId` therefore reaches only the data that workspace's RLS policies
 * already allow — it cannot widen anything.
 *
 * WHAT SCHEDULES THE WORK. Not this process. Enumerating which tenants have
 * work waiting is a cross-tenant read, so the reconciliation sweep lives in
 * `apps/api`, the designated platform surface, and enqueues per-workspace jobs
 * here. That keeps the identity boundary intact rather than widening it for
 * convenience.
 */

const log = createLogger({ context: { service: 'worker' } });

function connection(): IORedis {
  const url = queueUrl();
  if (!url) throw new Error('REDIS_URL is required to run the worker.');
  return new IORedis(url, {
    // BullMQ requires this: with a retry limit, a blocking command that
    // outlives a reconnect is dropped and the worker silently stops consuming.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

async function main(): Promise<void> {
  log.info('worker starting', {
    queues: QUEUE_NAMES.map((name) => ({
      name,
      activeFromPhase: QUEUE_DEFINITIONS[name].activeFromPhase,
    })),
  });

  if (!queueUrl()) {
    /*
     * A CLEAR FAILURE, NOT A QUIET IDLE. A worker that starts, connects to
     * nothing and reports success is the worst of both worlds: the deployment
     * looks healthy and no job is ever processed.
     */
    log.error('REDIS_URL is not configured; the worker cannot consume any queue');
    process.exit(1);
  }

  const definition = QUEUE_DEFINITIONS['media-processing'];
  const worker = new Worker(
    'media-processing',
    async (job: Job): Promise<void> => {
      /*
       * ONE QUEUE, TWO KINDS OF WORK, ROUTED EXHAUSTIVELY.
       *
       * Both members of `MediaProcessingPayload` are handled and the default
       * arm THROWS rather than returning quietly. A message nobody handles must
       * fail loudly: a silent return acknowledges the job, so the row it points
       * at stays QUEUED forever, the reconciliation sweep re-dispatches it, and
       * the customer watches a spinner while every log line says the job
       * completed.
       */
      const payload = job.data as MediaProcessingPayload;
      switch (payload.kind) {
        case 'brand-brain.ingest-source-document':
          await processIngestionJob(payload);
          return;
        case 'assets.process-asset':
          await processAssetJob(payload);
          return;
        default: {
          const unknown: never = payload;
          throw new Error(
            `Unroutable media-processing job: ${JSON.stringify((unknown as { kind?: string }).kind)}`,
          );
        }
      }
    },
    {
      connection: connection(),
      concurrency: definition.concurrency,
      // A document that has run for this long is stuck, not slow: the
      // extraction deadline is configuration and is well under it.
      lockDuration: 5 * 60_000,
    },
  );

  worker.on('failed', (job, error) => {
    // The reason, never the payload: a job's data is a pointer, but an error
    // from deep in a parser can still carry fragments of what it was parsing.
    log.error('job failed', {
      queue: 'media-processing',
      jobId: job?.id,
      attempts: job?.attemptsMade,
      ...internalErrorFields(error),
    });
  });

  worker.on('completed', (job) => {
    log.info('job completed', { queue: 'media-processing', jobId: job.id });
  });

  /*
   * PHASE 6 — THE PUBLISH QUEUE, AND WHY IT IS A SEPARATE WORKER.
   *
   * `media-processing` is CPU and disk work bounded by our own timeouts;
   * publishing is network work bounded by somebody else's platform, where a
   * single rate-limited account can hold a slot for minutes. Sharing one worker
   * would let a throttled Instagram account starve every asset upload in the
   * workspace. Two workers, two concurrency budgets, two lock durations.
   *
   * BULLMQ'S OWN RETRY IS DELIBERATELY NOT USED FOR THE DOMAIN. `attempts: 1`
   * on the message, because the RETRY DECISION belongs to the pipeline: whether
   * a failure may be retried at all depends on its class, the backoff depends
   * on configuration, and an uncertain outcome must be VERIFIED rather than
   * resent. A queue-level retry would resend blindly, which is exactly the
   * duplicate post the whole design exists to prevent. The database row carries
   * `nextAttemptAt`, and the API's sweep re-dispatches when it is due.
   */
  const publishDefinition = QUEUE_DEFINITIONS['publish-jobs'];
  const publishWorker = new Worker(
    'publish-jobs',
    async (job: Job): Promise<void> => {
      const payload = job.data as PublishJobsPayload;
      switch (payload.kind) {
        case 'social.publish-post':
          await processPublishJob(payload);
          return;
        case 'social.verify-post':
          /*
           * THE RECOVERY PATH, AND IT CANNOT PUBLISH (D-143). A different
           * processor reaching a different pipeline method, so a verification
           * message has no route to `publish()` at all — not a guarded one,
           * none.
           */
          await processVerifyJob(payload);
          return;
        default: {
          /*
           * EXHAUSTIVENESS, ON THE PAYLOAD ITSELF now that the union has two
           * members. (While it had one, TypeScript narrowed only the literal
           * `kind` field here and not the interface, so this assignment had to
           * name `payload.kind`; with a real union it narrows the payload to
           * `never`, and `payload.kind` no longer type-checks at all.)
           *
           * Either way the property this gives us is the one that matters: the
           * day a third kind is added and left unhandled, this line stops
           * compiling rather than the message being silently dropped.
           */
          const unroutable: never = payload;
          throw new Error(`Unroutable publish job: ${JSON.stringify(unroutable)}`);
        }
      }
    },
    {
      connection: connection(),
      concurrency: publishDefinition.concurrency,
      // A publish that has run this long is stuck, not slow: every adapter call
      // is bounded well inside it.
      lockDuration: 2 * 60_000,
    },
  );

  publishWorker.on('failed', (job, error) => {
    log.error('job failed', {
      queue: 'publish-jobs',
      jobId: job?.id,
      attempts: job?.attemptsMade,
      ...internalErrorFields(error),
    });
  });

  publishWorker.on('completed', (job) => {
    log.info('job completed', { queue: 'publish-jobs', jobId: job.id });
  });

  const shutdown = async (signal: string): Promise<void> => {
    // GRACEFUL, so a document mid-parse finishes rather than being abandoned
    // half-written. BullMQ waits for active jobs before resolving.
    log.info('worker stopping', { signal });
    // BOTH WORKERS, and a publish mid-flight matters more than a parse: the
    // request may already be at the platform, so abandoning it is how a job
    // that succeeded gets recorded as one that never ran.
    await Promise.all([worker.close(), publishWorker.close()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  /*
   * A LIVENESS ENDPOINT, because a queue consumer has no other way to say it is
   * alive. An orchestrator restarts a process that stops answering; without
   * this, a worker that has lost its Redis connection and consumes nothing looks
   * exactly like one that is merely idle. It is also what lets the end-to-end
   * suite wait for the worker before driving an upload through it.
   *
   * `isRunning()` rather than a constant: it reports what the consumer is
   * actually doing, so a closed or crashed worker fails the probe.
   */
  const port = Number(process.env['WORKER_PORT'] ?? 3004);
  const health = createServer((_request, res) => {
    const ready = worker.isRunning();
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: ready ? 'ok' : 'stopped' }));
  });
  health.listen(port, '0.0.0.0');

  log.info('worker ready', {
    queue: 'media-processing',
    concurrency: definition.concurrency,
    healthPort: port,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
