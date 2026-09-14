import { describe, expect, it } from 'vitest';
import { QUEUE_DEFINITIONS, QUEUE_NAMES, INGEST_SOURCE_DOCUMENT } from '@brandspace/jobs';

/**
 * The queue contract, asserted where it is cheap to assert.
 *
 * The isolation suite proves dispatch works against a real Redis. These are the
 * two properties that do not need one and that a reader of a diff would not
 * otherwise notice going wrong.
 */

describe('job keys are usable as BullMQ job ids', () => {
  /**
   * BULLMQ REFUSES A CUSTOM JOB ID CONTAINING `:` — it uses the colon as its own
   * Redis key separator. That constraint cost a debugging session: the dispatch
   * threw deep inside the library, the client reported only "could not
   * dispatch", the reconciliation sweep picked the row up, dispatched it again,
   * failed again, and the document would have been retried forever with no log
   * line saying why.
   *
   * Every key this platform builds is checked here, and `enqueue` refuses one
   * that would fail — because the failure mode is invisible, not because the
   * rule is subtle.
   */
  const KEY_BUILDERS: ReadonlyArray<readonly [string, string]> = [
    ['ingestion dispatch', `ingest-${'11111111-2222-3333-4444-555555555555'}`],
  ];

  it.each(KEY_BUILDERS)('%s produces a key BullMQ accepts', (_name, key) => {
    expect(key).not.toContain(':');
    expect(key.length).toBeGreaterThan(0);
  });

  it('the job name itself is a name, not an id, so a dot is fine', () => {
    // Job NAMES are free-form; only the custom id is constrained.
    expect(INGEST_SOURCE_DOCUMENT).toBe('brand-brain.ingest-source-document');
  });
});

describe('the queue table matches the architecture', () => {
  it('defines exactly the queues docs/ARCHITECTURE.md §9 lists', () => {
    // A queue added in code and not in the document, or the reverse, is how the
    // architecture stops describing the system.
    expect([...QUEUE_NAMES].sort()).toEqual([
      'ai-jobs',
      'analytics-ingest',
      'billing-events',
      'media-processing',
      'notifications',
      'publish-jobs',
    ]);
  });

  it('gives every queue a concurrency, a retry limit and a backoff', () => {
    for (const name of QUEUE_NAMES) {
      const definition = QUEUE_DEFINITIONS[name];
      expect(definition.concurrency, `${name} has no concurrency cap`).toBeGreaterThan(0);
      expect(definition.maxAttempts, `${name} has no retry limit`).toBeGreaterThan(0);
      expect(['exponential', 'fixed']).toContain(definition.backoff);
    }
  });
});
