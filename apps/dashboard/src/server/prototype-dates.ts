/**
 * THE ONE DATE AND TIME STYLE (review of #67, round 3, C2).
 *
 * The prototype writes a moment as "Oct 16 · 10:00" and a span as
 * "5 Oct – 1 Nov": the short month and the day, a middle dot, and a 24-hour
 * clock — never a weekday, a year in the current year, or AM/PM. Arabic keeps
 * the same shape with Arabic month names and Western digits (§4: Western Arabic
 * numerals by default).
 *
 * PURE, AND NOT `server-only`: the unit suite imports it directly. Every
 * function takes the time zone it should read the instant in — the
 * workspace's, or the slot's own — so the same instant never reads as two days.
 */

function tag(locale: string): string {
  return locale === 'ar' ? 'ar-u-nu-latn' : 'en-US';
}

function parts(
  instant: Date,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat(tag(locale), { ...options, timeZone }).formatToParts(
    instant,
  )) {
    out[part.type] = part.value;
  }
  return out;
}

/** "Oct 16" / "16 أكتوبر" — the date alone, with the year only when it is not this one. */
export function dayLabel(instant: Date, locale: string, timeZone: string, now?: Date): string {
  const p = parts(instant, locale, timeZone, { month: 'short', day: 'numeric', year: 'numeric' });
  const thisYear = now ? parts(now, locale, timeZone, { year: 'numeric' }).year : p.year;
  const base = locale === 'ar' ? `${p.day} ${p.month}` : `${p.month} ${p.day}`;
  return p.year === thisYear ? base : `${base}, ${p.year}`;
}

/** "10:00" — the 24-hour clock. */
export function clockLabel(instant: Date, locale: string, timeZone: string): string {
  const p = parts(instant, locale, timeZone, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${p.hour}:${p.minute}`;
}

/** "Oct 16 · 10:00" — a moment. */
export function whenLabel(instant: Date, locale: string, timeZone: string, now?: Date): string {
  return `${dayLabel(instant, locale, timeZone, now)} · ${clockLabel(instant, locale, timeZone)}`;
}

/**
 * "Oct 16 · 10:00" from a stored wall-clock intent (`YYYY-MM-DDTHH:mm`, a slot's
 * `scheduledLocalTime`), read as written — no zone is applied to it, because
 * it has none.
 */
export function localWhenLabel(local: string, locale: string, now?: Date): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  const instant = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
  return whenLabel(instant, locale, 'UTC', now);
}

/** "5 Oct" — one end of a span, day first, as the prototype's campaign rows write it. */
export function rangeDay(instant: Date, locale: string, timeZone: string): string {
  const p = parts(instant, locale, timeZone, { month: 'short', day: 'numeric' });
  return `${p.day} ${p.month}`;
}

/** "5 Oct – 1 Nov" — a span of days, day first. */
export function rangeLabel(start: Date, end: Date, locale: string, timeZone: string): string {
  return `${rangeDay(start, locale, timeZone)} – ${rangeDay(end, locale, timeZone)}`;
}

/*
 * ROUND 4 (1.8) — DROP-IN FORMATTERS, so a screen that held an
 * `Intl.DateTimeFormat` keeps calling `.format(date)` and gets the one style.
 */
export interface DateFormatterLike {
  format(value: Date): string;
}

/** `.format(date)` → "Oct 16" (the year only for another year). */
export function dayFormatter(locale: string, timeZone = 'UTC', now?: Date): DateFormatterLike {
  return { format: (value) => dayLabel(value, locale, timeZone, now) };
}

/** `.format(date)` → "Oct 16 · 10:00". */
export function whenFormatter(locale: string, timeZone = 'UTC', now?: Date): DateFormatterLike {
  return { format: (value) => whenLabel(value, locale, timeZone, now) };
}

/**
 * The locale tag for a formatter that writes names (a weekday, a month) and
 * must still write Western digits: `ar-u-nu-latn` in Arabic, `en-US` in English.
 */
export function latinTag(locale: string): string {
  return tag(locale);
}

/** A number as the prototype writes it in both languages: `1,240`. */
export function numberLabel(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat('en-US', options).format(value);
}
