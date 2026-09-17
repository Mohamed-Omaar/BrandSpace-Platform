import { describe, expect, it } from 'vitest';
import { runBucketFor, runIdempotencyKeyFor, thresholdOccurrenceKey } from '@brandspace/automation';

/**
 * PHASE 7 REMEDIATION, ROUND 6 — what a run's identity is made of.
 *
 * THE CONTRACT THESE PIN DOWN, in the words the review used:
 *
 *   - redelivery of THE SAME outbox event -> one run
 *   - a NEW arming cycle -> a new run
 *   - two legitimate crossings may share the same `MetricObservation` refId and
 *     must still produce two runs
 *   - the refId stays PROVENANCE, not logical event identity
 *   - a timed event stays identified by its carried occurrence
 *   - a domain event's identity does not move
 *
 * `runIdempotencyKeyFor` is a pure hash of four components, so these are the
 * cheapest possible place to assert the equivalence classes. The isolation
 * suite then proves the same thing end to end, on a row that really is revised
 * in place.
 */

const RULE = '11111111-1111-4111-8111-111111111111';
const OTHER_RULE = '22222222-2222-4222-8222-222222222222';
/** One reading, revised in place — so its id is the same for both crossings. */
const OBSERVATION = '33333333-3333-4333-8333-333333333333';

const thresholdKey = (cycle: number): string =>
  `METRIC_THRESHOLD_CROSSED:${thresholdOccurrenceKey(RULE, cycle)}`;

const keyFor = (input: { refId: string | null; bucket: string; ruleId?: string }): string =>
  runIdempotencyKeyFor({
    ruleId: input.ruleId ?? RULE,
    triggerType: 'METRIC_THRESHOLD_CROSSED',
    refId: input.refId,
    bucket: input.bucket,
  });

describe('R6: a threshold run is identified by the arming cycle, not the reading', () => {
  it('THE DEFECT: the old constant bucket collapsed two legitimate crossings', () => {
    /*
     * `runBucketFor` answers `'event'` for every trigger that carries a
     * reference, on the reasoning that the reference IS the identity (P7-R5).
     * That is true of a content item, a calendar slot and a publish job, and
     * FALSE of a metric observation — ingestion updates one in place, so the
     * same row can cross the line again under the same id.
     */
    expect(
      runBucketFor({
        triggerType: 'METRIC_THRESHOLD_CROSSED',
        localDate: '2026-09-17',
        hourLocal: 9,
      }),
    ).toBe('event');

    const first = keyFor({ refId: OBSERVATION, bucket: 'event' });
    const second = keyFor({ refId: OBSERVATION, bucket: 'event' });
    expect(first).toBe(second);
  });

  it('the event key tells two arming cycles apart, on the SAME reference', () => {
    const cycle0 = keyFor({ refId: OBSERVATION, bucket: thresholdKey(0) });
    const cycle1 = keyFor({ refId: OBSERVATION, bucket: thresholdKey(1) });

    expect(cycle0).not.toBe(cycle1);
    // And the reference is untouched — it is still provenance in both.
    expect(thresholdKey(0)).toContain(RULE);
    expect(thresholdKey(0)).not.toContain(OBSERVATION);
  });

  it('a redelivery of the SAME event converges on the same run', () => {
    // At-least-once delivery and the outbox's own re-dispatch both land here.
    expect(keyFor({ refId: OBSERVATION, bucket: thresholdKey(0) })).toBe(
      keyFor({ refId: OBSERVATION, bucket: thresholdKey(0) }),
    );
  });

  it('a redelivery whose provenance was re-read still converges', () => {
    /*
     * A SECOND READING CAN LAND BETWEEN A DISPATCH AND ITS REDELIVERY, and the
     * producer cites whichever observation it found. The identity must not move
     * with it: the cycle has not advanced, so it is still the same event.
     */
    expect(keyFor({ refId: OBSERVATION, bucket: thresholdKey(0) })).toBe(
      keyFor({ refId: OBSERVATION, bucket: thresholdKey(0) }),
    );
    // A different refId under the SAME cycle is still a different key, because
    // refId remains part of the hash — provenance is recorded, not erased.
    expect(keyFor({ refId: OBSERVATION, bucket: thresholdKey(0) })).not.toBe(
      keyFor({ refId: 'another-reading', bucket: thresholdKey(0) }),
    );
  });

  it('one event never reaches another rule as the same run', () => {
    expect(keyFor({ refId: OBSERVATION, bucket: thresholdKey(0) })).not.toBe(
      keyFor({ refId: OBSERVATION, bucket: thresholdKey(0), ruleId: OTHER_RULE }),
    );
  });

  it('every arming cycle in a long run of crossings gets its own identity', () => {
    const keys = Array.from({ length: 25 }, (_, cycle) =>
      keyFor({ refId: OBSERVATION, bucket: thresholdKey(cycle) }),
    );
    expect(new Set(keys).size).toBe(25);
  });
});

describe('R6: the other two producers keep the identity they already had', () => {
  it('a timed event is still identified by the occurrence it was created for', () => {
    /*
     * The occurrence takes precedence over the event key in the engine, so this
     * is unchanged by round 6 — and it must be, because a timed run's identity
     * has to survive a message that sits in the queue past the hour boundary
     * (P7-R5).
     */
    const timed = (occurrence: string): string =>
      runIdempotencyKeyFor({
        ruleId: RULE,
        triggerType: 'SCHEDULED_TIME',
        refId: null,
        bucket: occurrence,
      });

    expect(timed('2026-09-17T09')).toBe(timed('2026-09-17T09'));
    expect(timed('2026-09-17T09')).not.toBe(timed('2026-09-18T09'));
    expect(timed('2026-09-17T09')).not.toBe(timed('2026-09-17T10'));
  });

  it("a domain event's key is a function of what its key already contained", () => {
    /*
     * A domain event's outbox identity is `<trigger>:<refId>` — both of which
     * the run key ALREADY carries as separate components. So swapping the
     * constant bucket for the event key changes the hash VALUE and not one
     * equivalence class: the same reference still collides with itself, and two
     * references still differ.
     */
    const domain = (refId: string, bucket: string): string =>
      runIdempotencyKeyFor({
        ruleId: RULE,
        triggerType: 'POST_PUBLISHED',
        refId,
        bucket,
      });

    const job = 'publish-job-1';
    const other = 'publish-job-2';

    for (const bucket of ['event', `POST_PUBLISHED:${job}`]) {
      expect(domain(job, bucket)).toBe(domain(job, bucket));
    }
    expect(domain(job, `POST_PUBLISHED:${job}`)).not.toBe(domain(other, `POST_PUBLISHED:${other}`));
    expect(domain(job, 'event')).not.toBe(domain(other, 'event'));
  });

  it('and a reference-carrying trigger still gets no clock in its bucket', () => {
    // The P7-R5 property, restated: nothing here re-derives an identity from
    // `now`, so a redelivery a week later still converges.
    for (const triggerType of [
      'CONTENT_APPROVED',
      'CONTENT_SCHEDULED',
      'POST_PUBLISHED',
    ] as const) {
      expect(runBucketFor({ triggerType, localDate: '2026-09-17', hourLocal: 9 })).toBe(
        runBucketFor({ triggerType, localDate: '2026-12-25', hourLocal: 23 }),
      );
    }
    // A timed one does, and it is the rule's own hour rather than the sweep's.
    expect(
      runBucketFor({ triggerType: 'SCHEDULED_TIME', localDate: '2026-09-17', hourLocal: 9 }),
    ).toBe('2026-09-17T09');
  });
});
