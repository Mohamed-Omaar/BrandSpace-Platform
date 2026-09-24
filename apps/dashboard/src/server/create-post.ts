/**
 * CREATE POST — the pure half (Phase 6 final, D-277 §17-§19, D-283).
 *
 * PURE, AND NOT `server-only`: the unit suite imports it directly.
 */

/** How a person starts (§17). */
export const CREATE_MODES = ['ai', 'write', 'idea', 'repurpose'] as const;
export type CreateMode = (typeof CREATE_MODES)[number];

export function createModeFrom(value: unknown): CreateMode | null {
  return (CREATE_MODES as readonly string[]).includes(String(value))
    ? (String(value) as CreateMode)
    : null;
}

/*
 * ---------------------------------------------------------------------------
 * FORMATS, FROM THE REAL CAPABILITY REGISTRY (§18)
 * ---------------------------------------------------------------------------
 *
 * Each content format needs one of these post kinds from the publishing
 * capability registry (`publishing.providers.<key>.postKinds`, owner
 * configuration). A format is offered only for platforms whose ENABLED
 * provider declares a kind it needs; a platform with no enabled provider can
 * still be drafted for, as a plain post, because nothing about it is known.
 */
export const FORMAT_POST_KINDS: Readonly<Record<string, readonly string[]>> = {
  POST: ['text', 'image'],
  CAROUSEL: ['carousel'],
  REEL: ['reel'],
  STORY: ['story'],
  VIDEO: ['video'],
  ARTICLE: ['article'],
  THREAD: ['thread'],
};

/** The social-first formats shown first; the rest sit under "More formats". */
export const PRIMARY_FORMATS = ['POST', 'CAROUSEL', 'REEL', 'STORY', 'VIDEO'] as const;

export interface ProviderKinds {
  readonly enabled: boolean;
  readonly postKinds: readonly string[];
}

/**
 * For each format, the platforms that can carry it. A format with no platform
 * is absent from the result, so the composer cannot offer it.
 */
export function platformsByFormat(
  formats: readonly string[],
  platformKeys: readonly string[],
  providers: Readonly<Record<string, ProviderKinds | undefined>>,
): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, string[]> = {};
  for (const format of formats) {
    const needs = FORMAT_POST_KINDS[format] ?? [];
    const supported = platformKeys.filter((key) => {
      const provider = providers[key];
      if (!provider?.enabled) return format === 'POST';
      return needs.some((kind) => provider.postKinds.includes(kind));
    });
    if (supported.length > 0) result[format] = supported;
  }
  return result;
}

/*
 * ---------------------------------------------------------------------------
 * THE POST'S GOAL (§19)
 * ---------------------------------------------------------------------------
 *
 * A post's goal steers the words; it is not a campaign objective and is not
 * stored as one. It travels in the generation brief. The RECOMMENDATION is
 * grounded: the brand's first goal (STRATEGY memory, D-278), mapped from the
 * campaign vocabulary it is stored in.
 */
export const POST_GOALS = ['EDUCATE', 'ENGAGE', 'PROMOTE', 'AWARENESS', 'LEADS', 'LAUNCH'] as const;
export type PostGoal = (typeof POST_GOALS)[number];

const OBJECTIVE_TO_GOAL: Readonly<Record<string, PostGoal>> = {
  AWARENESS: 'AWARENESS',
  ENGAGEMENT: 'ENGAGE',
  LEADS: 'LEADS',
  LAUNCH: 'LAUNCH',
  TRAFFIC: 'PROMOTE',
  RETENTION: 'ENGAGE',
  // D-303: a steady rhythm is kept by posts people answer; authority is earned by teaching.
  CONSISTENCY: 'ENGAGE',
  AUTHORITY: 'EDUCATE',
};

export function goalForObjective(objective: string | null | undefined): PostGoal | null {
  return objective ? (OBJECTIVE_TO_GOAL[objective] ?? null) : null;
}

/*
 * ---------------------------------------------------------------------------
 * REPURPOSE (§17)
 * ---------------------------------------------------------------------------
 *
 * The source post's own words become EXPLICIT, BOUNDED source material in the
 * brief — not "model memory". The new draft is generated from it; the old
 * post is never touched.
 */
export function repurposeBrief(
  template: string,
  source: { readonly title: string; readonly body: string },
  maxChars: number,
): string {
  const head = template.replace('{title}', source.title);
  const room = Math.max(0, maxChars - head.length - 8);
  const body =
    source.body.length > room ? `${source.body.slice(0, Math.max(0, room - 1))}…` : source.body;
  return `${head}\n\n"""\n${body}\n"""`.slice(0, maxChars);
}
