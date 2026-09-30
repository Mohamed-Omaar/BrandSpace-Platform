import { TIMED_PRODUCER_LIMITS } from './registry';
import { thresholdTransition, type ThresholdTransition } from './schedule';

/**
 * PHASE 2B-3 PR 3 — THE ARITHMETIC OF THE TIMED G13 PRODUCERS, as pure functions.
 *
 * The producers themselves live in the API's `MaintenanceScheduler` sweep and
 * read the database under the tenant's own RLS. Everything here decides — from
 * values the caller read — which occurrences are due, how far the rule's cursor
 * moves, and when the rule is next looked at. Pure, so every boundary (the 24th
 * hour, local midnight across a daylight-saving change, the 25th occurrence) is
 * a unit test rather than a clock.
 *
 * NO BACKFILL (D-417, OD-21). A rule reacts only to what becomes due AFTER it
 * was armed. The floor below is the later of `armedAt` and the rule's own cursor
 * (`dueWatermark`), so a cursor left from an earlier arming can never reach back
 * past the current one — switching a rule off and on again does not replay what
 * happened while it was off.
 */

/**
 * THE LOCAL CALENDAR, INJECTED. The one question this package cannot answer
 * with `Intl` alone is "which instant is 00:00 on this day in this zone" — the
 * answer needs the platform's single zoned-time resolver, which moves a
 * midnight that does not exist (a daylight-saving gap) forward and picks the
 * earlier of a midnight that happens twice. The API and the worker supply
 * `instantForIntent`; nothing here does offset arithmetic of its own.
 */
export interface LocalCalendarPort {
  /** The instant of local 00:00 on `dayKey` (`YYYY-MM-DD`), or null for an invalid day or zone. */
  localMidnight(dayKey: string, timezone: string): Date | null;
}

/** A due subject: when it fell due, and the id that breaks ties. */
/**
 * PHASE 2B-3 PR 3 — BRAND BRAIN'S ONE ANSWER TO "MAY THIS FACT BE USED TODAY?"
 *
 * Injected, not imported: this package does not depend on Brand Brain, and
 * there must be exactly one copy of the rule (owner decision F — the existing
 * usable rule: ACTIVE or STALE, and not expired). The API and the worker pass
 * `knowledgeAsOfSafe` and `usableKnowledgeWhere` straight through.
 */
export interface KnowledgeValidityPort {
  /** Today in the zone, as the `DATE` value a `validUntil` is compared with. */
  asOf(timezone: string, now: Date): Date;
  /** The predicate every generative path uses to choose facts. */
  usableWhere(asOf: Date): {
    status: { in: ('ACTIVE' | 'STALE')[] };
    OR: ({ validUntil: null } | { validUntil: { gte: Date } })[];
  };
}

export interface DueCandidate {
  readonly due: Date;
  readonly id: string;
}

/**
 * The earliest instant a new occurrence may be due at — exclusive. Null when
 * the rule was never armed, which the producer treats as "produce nothing".
 */
export function producerFloor(rule: {
  readonly armedAt: Date | null;
  readonly dueWatermark: Date | null;
}): Date | null {
  if (!rule.armedAt) return null;
  if (!rule.dueWatermark) return rule.armedAt;
  return rule.dueWatermark.getTime() > rule.armedAt.getTime() ? rule.dueWatermark : rule.armedAt;
}

/** The latest instant this sweep may treat as due — inclusive. */
export function producerCeiling(now: Date): Date {
  return new Date(now.getTime() - TIMED_PRODUCER_LIMITS.watermarkLagSeconds * 1_000);
}

/**
 * WHICH DUE SUBJECTS THIS VISIT EMITS, AND WHERE THE CURSOR MOVES.
 *
 * Due in `(floor, ceiling]`, oldest first, the id breaking ties. At most
 * `maxOccurrencesPerVisit` — EXCEPT that every subject sharing the due instant
 * of the last one taken is taken too: the next visit's floor is exclusive, so a
 * tie split across two visits would lose its second half.
 *
 * The cursor moves to the ceiling when everything due was taken, and otherwise
 * to the due instant of the last subject taken, so the next visit continues
 * exactly there. `more` says the rule should be visited again at once.
 */
export function selectDue<T extends DueCandidate>(input: {
  readonly candidates: readonly T[];
  readonly floor: Date;
  readonly ceiling: Date;
  readonly cap?: number;
}): { readonly emit: readonly T[]; readonly watermark: Date; readonly more: boolean } {
  const cap = input.cap ?? TIMED_PRODUCER_LIMITS.maxOccurrencesPerVisit;
  const due = input.candidates
    .filter(
      (candidate) =>
        candidate.due.getTime() > input.floor.getTime() &&
        candidate.due.getTime() <= input.ceiling.getTime(),
    )
    .sort((a, b) => a.due.getTime() - b.due.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (due.length <= cap) {
    return { emit: due, watermark: laterOf(input.floor, input.ceiling), more: false };
  }
  const last = due[cap - 1] as T;
  const taken = due.filter((candidate) => candidate.due.getTime() <= last.due.getTime());
  return {
    emit: taken,
    watermark: last.due,
    more: taken.length < due.length,
  };
}

function laterOf(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * WHEN THE RULE IS NEXT LOOKED AT: the next thing it is waiting for, but never
 * later than an hour (the automation sweep's existing park ceiling) and never
 * before now. `more` — a visit that stopped at the cap — means now.
 */
export function nextVisitAt(input: {
  readonly now: Date;
  readonly next: Date | null;
  readonly more: boolean;
  readonly maxAheadSeconds: number;
}): Date {
  if (input.more) return input.now;
  const ceiling = input.now.getTime() + input.maxAheadSeconds * 1_000;
  if (!input.next) return new Date(ceiling);
  return new Date(Math.max(input.now.getTime(), Math.min(input.next.getTime(), ceiling)));
}

/**
 * A `YYYY-MM-DD` key moved by whole calendar days. Date arithmetic on the key
 * itself — the same technique as the calendar's `nextDayKey` — so no daylight
 * saving change can land it on the same day or skip one.
 */
export function shiftDayKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  const moved = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return moved.toISOString().slice(0, 10);
}

/** The `YYYY-MM-DD` a stored `DATE` column value names. */
export function dayKeyOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Today's `YYYY-MM-DD` in the workspace's zone. */
export function localDayKey(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * THE EDGE OF AN EDGE-TRIGGERED EVENT, WITH ARMING TAKEN INTO ACCOUNT.
 *
 * The D-177 state machine (`thresholdTransition`) establishes on its first
 * evaluation and fires only on a later change. Its memory, though, outlives an
 * arming: a rule switched off while in one state and on again later would find
 * its old memory and fire on a change that happened while nobody was
 * listening. So memory recorded BEFORE the current arming counts as no memory,
 * and the first visit after arming establishes again (D-417).
 */
export function edgeTransitionSinceArming(input: {
  readonly armedAt: Date;
  readonly evaluatedAt: Date | null;
  readonly previous: boolean | null;
  readonly current: boolean | null;
}): ThresholdTransition {
  const remembered =
    input.evaluatedAt && input.evaluatedAt.getTime() >= input.armedAt.getTime()
      ? input.previous
      : null;
  return thresholdTransition({ previous: remembered, current: input.current });
}

/**
 * The `YYYY-MM-DD` an event key ends with — the date a campaign or fact
 * occurrence was produced FOR — or null when the key carries none.
 */
export function dayKeyInEventKey(eventKey: string | null | undefined): string | null {
  const last = eventKey?.split(':').at(-1) ?? '';
  return /^\d{4}-\d{2}-\d{2}$/.test(last) ? last : null;
}
