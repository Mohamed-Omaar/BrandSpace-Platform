import { createServer } from 'node:http';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import {
  QUEUE_DEFINITIONS,
  QUEUE_NAMES,
  queueUrl,
  type IngestSourceDocumentPayload,
} from '@brandspace/jobs';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { processIngestionJob } from './processors/ingestion';

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
      const payload = job.data as IngestSourceDocumentPayload;
      await processIngestionJob(payload);
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

  const shutdown = async (signal: string): Promise<void> => {
    // GRACEFUL, so a document mid-parse finishes rather than being abandoned
    // half-written. BullMQ waits for active jobs before resolving.
    log.info('worker stopping', { signal });
    await worker.close();
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
