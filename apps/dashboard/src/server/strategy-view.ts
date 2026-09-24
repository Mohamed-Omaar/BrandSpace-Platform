/**
 * THE STRATEGY, AS A PLAN A PERSON CAN WORK FROM (Phase 6 final, D-277 §13, D-292).
 *
 * PURE, AND NOT `server-only`: the unit suite imports it directly.
 *
 * A strategy insight's `body` is the model's JSON after the intelligence
 * package validated it against its schema and checked every claim against the
 * stored evidence (`packages/intelligence/src/strategy.ts`). It is still read
 * DEFENSIVELY here: a row written by an older schema, or edited by hand, must
 * render what it has and drop what it does not — never throw on a customer's
 * screen, and never invent a section that is not there.
 */

export interface Bilingual {
  readonly ar: string;
  readonly en: string;
}

export interface Rationale {
  readonly text: Bilingual;
  /** Ordinals of the stored evidence rows this claim rests on (`e1`, `e2`, …). */
  readonly evidenceRefs: readonly number[];
}

export interface StrategyPillar {
  readonly name: Bilingual;
  readonly sharePercent: number;
  readonly rationale: Rationale;
}

export interface StrategyChannel {
  readonly platformKey: string;
  readonly sharePercent: number;
  readonly rationale: Rationale;
}

export interface StrategyWeek {
  readonly weekNumber: number;
  readonly theme: Bilingual;
  readonly postsPlanned: number;
  readonly rationale: Rationale;
}

export interface StrategyBody {
  readonly summary: Bilingual | null;
  readonly pillars: readonly StrategyPillar[];
  readonly channelMix: readonly StrategyChannel[];
  readonly monthlyPlan: readonly StrategyWeek[];
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function bilingual(value: unknown): Bilingual | null {
  const row = record(value);
  if (!row) return null;
  const ar = typeof row['ar'] === 'string' ? row['ar'] : '';
  const en = typeof row['en'] === 'string' ? row['en'] : '';
  return ar === '' && en === '' ? null : { ar, en };
}

function rationale(value: unknown): Rationale {
  const row = record(value);
  const refs = Array.isArray(row?.['evidenceRefs'])
    ? (row['evidenceRefs'] as unknown[]).filter(
        (ref): ref is number => typeof ref === 'number' && Number.isInteger(ref) && ref > 0,
      )
    : [];
  return { text: bilingual(row?.['text']) ?? { ar: '', en: '' }, evidenceRefs: refs };
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The stored body, narrowed; anything malformed is dropped, not guessed. */
export function parseStrategyBody(body: unknown): StrategyBody {
  const row = record(body);
  const pillars = list(row?.['pillars']).flatMap((entry): StrategyPillar[] => {
    const pillar = record(entry);
    const name = bilingual(pillar?.['name']);
    const share = finite(pillar?.['sharePercent']);
    return name && share !== null
      ? [{ name, sharePercent: share, rationale: rationale(pillar?.['rationale']) }]
      : [];
  });
  const channelMix = list(row?.['channelMix']).flatMap((entry): StrategyChannel[] => {
    const channel = record(entry);
    const key = channel?.['platformKey'];
    const share = finite(channel?.['sharePercent']);
    return typeof key === 'string' && /^[a-z0-9_-]{1,40}$/.test(key) && share !== null
      ? [{ platformKey: key, sharePercent: share, rationale: rationale(channel?.['rationale']) }]
      : [];
  });
  const monthlyPlan = list(row?.['monthlyPlan']).flatMap((entry): StrategyWeek[] => {
    const week = record(entry);
    const number = finite(week?.['weekNumber']);
    const theme = bilingual(week?.['theme']);
    const posts = finite(week?.['postsPlanned']);
    return number !== null && theme && posts !== null
      ? [
          {
            weekNumber: number,
            theme,
            postsPlanned: Math.max(0, Math.round(posts)),
            rationale: rationale(week?.['rationale']),
          },
        ]
      : [];
  });
  return {
    summary: bilingual(row?.['summary']),
    pillars,
    channelMix,
    monthlyPlan: [...monthlyPlan].sort((a, b) => a.weekNumber - b.weekNumber),
  };
}

/** A bilingual value in the reader's language, falling back to the other. */
export function pick(value: Bilingual | null | undefined, locale: string): string {
  if (!value) return '';
  return (locale === 'ar' ? value.ar || value.en : value.en || value.ar).trim();
}

/*
 * ---------------------------------------------------------------------------
 * FROM A WEEK OF THE PLAN TO WORK (§13 "practical opportunities")
 * ---------------------------------------------------------------------------
 *
 * Each action is an ADDRESS that opens an existing flow with the week's theme
 * filled in — nothing is created, scheduled or published from this screen.
 * A campaign still goes through the campaign form and its audited action; a
 * post still goes through Create Post and its credit quote.
 */

/** The channels a plan emphasises, strongest first — at most `limit`. */
export function leadingChannels(body: StrategyBody, limit = 3): string[] {
  return [...body.channelMix]
    .sort((a, b) => b.sharePercent - a.sharePercent)
    .slice(0, limit)
    .map((channel) => channel.platformKey);
}

export function campaignHref(input: {
  readonly locale: string;
  readonly week: StrategyWeek;
  readonly channels: readonly string[];
  readonly objective: string | null;
}): string {
  const params = new URLSearchParams({
    name: pick(input.week.theme, input.locale).slice(0, 120),
    brief: pick(input.week.rationale.text, input.locale).slice(0, 1_000),
  });
  if (input.objective) params.set('objective', input.objective);
  for (const channel of input.channels) params.append('channels', channel);
  return `/${input.locale}/campaigns/new?${params.toString()}`;
}

export function contentHref(input: {
  readonly locale: string;
  readonly week: StrategyWeek;
}): string {
  const theme = pick(input.week.theme, input.locale);
  const why = pick(input.week.rationale.text, input.locale);
  const brief = [theme, why].filter(Boolean).join(' — ').slice(0, 1_000);
  return `/${input.locale}/content/compose?${new URLSearchParams({ mode: 'ai', brief }).toString()}`;
}
