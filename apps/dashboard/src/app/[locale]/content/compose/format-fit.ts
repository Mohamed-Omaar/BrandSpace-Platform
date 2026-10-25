/**
 * ROUND 6 (owner decision D-481) — A FORMAT OR CHANNEL THAT CANNOT BE USED IS
 * DIMMED BEFORE THE PRESS, SAYS WHY, AND OFFERS THE FIX IN ONE PRESS.
 *
 * The Studio's format switch and its "Post to" chips used to be `disabled`
 * when the capability registry said no: the press did nothing, and a member
 * saw nothing happen. These helpers decide, for both the new post and the
 * draft, what each format can do with the channels on screen, so the screen
 * can say it before anyone presses.
 *
 * Pure: no React, no server, so the rules are unit-tested as they are.
 */

export type FitState = 'ok' | 'fix' | 'none';

export interface FormatFit {
  /** `ok` — usable now; `fix` — usable after a channel change; `none` — nothing carries it. */
  readonly state: FitState;
  /** The channels that can carry the format, in the order the screen shows them. */
  readonly carriers: readonly string[];
  /** The chosen channels that cannot carry it (empty unless `fix`). */
  readonly blockers: readonly string[];
  /** The channels after the one-press fix (the chosen ones minus the blockers, or the first carrier). */
  readonly next: readonly string[];
}

/** What a format can do with the chosen channels. */
export function fitOf(carriers: readonly string[], selected: readonly string[]): FormatFit {
  if (carriers.length === 0) return { state: 'none', carriers, blockers: [], next: selected };
  const blockers = selected.filter((key) => !carriers.includes(key));
  if (blockers.length === 0) return { state: 'ok', carriers, blockers, next: selected };
  const kept = selected.filter((key) => carriers.includes(key));
  return {
    state: 'fix',
    carriers,
    blockers,
    next: kept.length > 0 ? kept : [carriers[0] as string],
  };
}

/**
 * The first format, in the screen's order, that every one of these channels can
 * carry — the fix for a channel the current format cannot take. `null` when
 * there is none, and then no fix is offered.
 */
export function formatForChannels(
  formats: readonly string[],
  carriersOf: (format: string) => readonly string[],
  keys: readonly string[],
): string | null {
  return formats.find((format) => keys.every((key) => carriersOf(format).includes(key))) ?? null;
}

/** Locales whose text runs right to left. */
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);

/**
 * "Instagram and Facebook" / "Instagram, Facebook and X", in the reader's
 * language — «Facebook وInstagram وTikTok» in Arabic.
 *
 * D-569 (Studio review, owner decision 5) — IN A RIGHT-TO-LEFT LANGUAGE EACH
 * NAME IS ISOLATED (U+2068 FIRST STRONG ISOLATE … U+2069 POP DIRECTIONAL
 * ISOLATE), so a Latin channel name never takes the Arabic «و» or the
 * sentence around it into its own direction, wherever the list lands — the
 * start of a line, a tooltip, a `dir="auto"` block. English is unchanged.
 */
export function listOf(locale: string, items: readonly string[]): string {
  const rtl = RTL_LANGUAGES.has(locale.toLowerCase().split('-')[0] ?? '');
  try {
    const format = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
    if (!rtl) return format.format(items);
    return format
      .formatToParts(items)
      .map((part) => (part.type === 'element' ? `\u2068${part.value}\u2069` : part.value))
      .join('');
  } catch {
    return items.join(rtl ? '، ' : ', ');
  }
}
