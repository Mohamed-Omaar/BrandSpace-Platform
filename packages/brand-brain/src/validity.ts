import type { TenantScopedClient } from '@brandspace/database';
import { AppError, systemClock, type Clock } from '@brandspace/shared';

/**
 * "VALID UNTIL" (prototype v90 D6, Phase 2C) — a fact's optional last day.
 *
 * THE DATE IS A LOCAL CALENDAR DAY IN THE WORKSPACE'S TIME ZONE, never an
 * instant and never the reader's browser day. A fact whose `validUntil` is the
 * 30th is usable for the whole of the 30th wherever the workspace keeps its
 * clock, and EXPIRED from the first moment of the 31st there.
 *
 * It is stored as a `DATE` (Prisma hands it back as midnight UTC of that day),
 * and "today" is computed the same way — the workspace's local date, as
 * midnight UTC — so the comparison is date against date and a change of the
 * workspace's time zone (Q22) can never move an end date.
 *
 * EXPIRY IS NOT STALENESS. STALE means "review due" and a STALE fact still
 * grounds writing; an EXPIRED fact never does (`usableKnowledgeWhere`).
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD`: the calendar date an instant falls on in a time zone. */
export function localDateIn(instant: Date, timezone: string): string {
  let formatter = FORMATTERS.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    FORMATTERS.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

/** A `YYYY-MM-DD` calendar date as the value a `DATE` column holds (midnight UTC). */
export function calendarDate(iso: string): Date {
  const match = ISO_DATE.exec(iso);
  if (!match) throw new AppError('VALIDATION_FAILED', 'A date must be YYYY-MM-DD.');
  const [, year, month, day] = match;
  const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  // `Date.UTC` rolls 2026-02-31 over to March; a real calendar date round-trips.
  if (value.toISOString().slice(0, 10) !== iso) {
    throw new AppError('VALIDATION_FAILED', 'That day does not exist.');
  }
  return value;
}

/** The `YYYY-MM-DD` a stored `DATE` value names. */
export function isoDateOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Today, in the workspace's time zone, as a `DATE` value. */
export function knowledgeAsOf(timezone: string, now: Date): Date {
  return calendarDate(localDateIn(now, timezone));
}

/**
 * Expired: the fact's last valid day is BEFORE today in the workspace's zone.
 * A fact whose last day is today is still usable, all day.
 */
export function isExpired(validUntil: Date | null, asOf: Date): boolean {
  return validUntil !== null && validUntil.getTime() < asOf.getTime();
}

/**
 * The optional end date a person typed, or null. Empty means "no end date";
 * anything else must be a real calendar day.
 */
export function parseValidUntil(raw: string | null | undefined): Date | null {
  const value = raw?.trim() ?? '';
  return value === '' ? null : calendarDate(value);
}

/**
 * Today in the time zone of the workspace this transaction is scoped to. RLS
 * makes the workspace row the only one visible. A zone the runtime does not
 * know — which the settings validation refuses — reads as UTC rather than
 * failing a generation.
 */
export async function workspaceKnowledgeAsOf(
  db: TenantScopedClient,
  clock: Clock = systemClock,
): Promise<Date> {
  const workspace = await db.workspace.findFirst({ select: { timezone: true } });
  return knowledgeAsOfSafe(workspace?.timezone ?? 'UTC', clock.now());
}

/** `knowledgeAsOf`, falling back to UTC for a zone the runtime rejects. */
export function knowledgeAsOfSafe(timezone: string, now: Date): Date {
  try {
    return knowledgeAsOf(timezone, now);
  } catch {
    return knowledgeAsOf('UTC', now);
  }
}
