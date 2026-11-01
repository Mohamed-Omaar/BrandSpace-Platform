import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueues, enqueue, enqueueReplacingFinished } from '@brandspace/jobs';

/*
 * WITH REDIS DOWN, A DISPATCH REPORTS INSTEAD OF HANGING (check-up 2026-10-28, M-7).
 *
 * The producer connection used `maxRetriesPerRequest: null`, so with `REDIS_URL`
 * set and Redis unreachable `enqueue()` waited in ioredis's offline queue until
 * Redis came back: the review measured it still waiting at 20 s. An upload, a
 * Brand Brain re-read or a queued automation then span for the whole outage
 * instead of saving and leaving the dispatch to the reconciliation sweep.
 *
 * Port 1 on loopback refuses every connection, which is what an outage looks
 * like from the producer's side.
 */

const previous = process.env['REDIS_URL'];

beforeAll(() => {
  process.env['REDIS_URL'] = 'redis://127.0.0.1:1';
});

afterAll(async () => {
  await closeQueues();
  if (previous === undefined) delete process.env['REDIS_URL'];
  else process.env['REDIS_URL'] = previous;
});

describe('enqueue with Redis unreachable', () => {
  it('returns dispatched: false within the dispatch deadline', async () => {
    const started = Date.now();
    const result = await enqueue('media-processing', 'ingest', {
      idempotencyKey: 'redis-down-check',
    });
    expect(result).toEqual({ dispatched: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('bounds the replace-finished path the same way', async () => {
    const started = Date.now();
    const result = await enqueueReplacingFinished('media-processing', 'ingest', {
      idempotencyKey: 'redis-down-check-2',
    });
    expect(result).toEqual({ dispatched: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});
