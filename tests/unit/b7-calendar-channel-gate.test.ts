import { describe, expect, it } from 'vitest';
import type { CalendarOptions } from '@brandspace/content';

/**
 * BATCH 7 PR C (B3.8, the F8 audit finding) — A CALENDAR CANNOT BE BUILT
 * WITHOUT ITS CHANNEL GATE.
 *
 * `channelGate` was optional, and a calendar built without it refused nothing:
 * a revoked channel could be scheduled through any caller that forgot it. It
 * is now required, as `approvalGate` was made required in PR 0. The
 * `@ts-expect-error` below is checked by the `tests` package's `tsc` (CI's
 * typecheck job): if the property ever becomes optional again, the directive
 * itself fails. Every production site passing the real gate is pinned by
 * `tests/unit/phase2b1-expired-connections.test.ts`.
 */
describe('B3.8 — ContentCalendarService requires the channel gate', () => {
  it('the TYPE refuses a calendar without `channelGate`', () => {
    // @ts-expect-error — `channelGate` is required (Batch 7 PR C). If this line
    // ever compiles, the property became optional again and `tsc` fails here.
    const missing: CalendarOptions = {
      db: undefined as never,
      workspaceId: 'w',
      policy: undefined as never,
      timezone: 'UTC',
      quota: undefined as never,
      approvalGate: undefined as never,
    };
    expect(missing.workspaceId).toBe('w');
  });
});
