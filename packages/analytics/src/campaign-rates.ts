import { computeDerived } from './metrics';

/**
 * B11 (Phase 2B-2b) — A CAMPAIGN'S ENGAGEMENT RATE OVER ITS WHOLE LIFE, POOLED.
 *
 * THE OWNER'S DEFINITION (D5, amended — docs/DECISIONS.md D-341): the campaign's
 * lifetime TOTAL engagements divided by its lifetime TOTAL impressions, over its
 * published posts. Pooled, not the mean of per-post rates — the same rule every
 * other rate in this package follows (`AnalyticsQueryService.summary`: "derived
 * metrics are computed AFTERWARDS from those aggregates, never averaged from
 * per-row rates"), so the Campaigns list and the campaign's own card agree.
 *
 * A POST WHOSE RATE IS UNAVAILABLE IS LEFT OUT OF BOTH SIDES. A post is one
 * content item with all its published platform posts summed. If it has no
 * engagements reading, or no impressions reading, or zero impressions, its rate
 * does not exist (`computeDerived` returns null) — and a post whose rate does not
 * exist contributes NOTHING, rather than its impressions to the denominator and
 * a silent zero to the numerator. Unavailable is never zero.
 */

/** One post's lifetime sums, as the database grouped them. */
export interface PostEngagementSums {
  readonly contentItemId: string;
  readonly campaignId: string;
  readonly engagements: bigint | null;
  readonly impressions: bigint | null;
}

export interface CampaignPooledRate {
  readonly campaignId: string;
  /** Sum over the posts that have a rate. */
  readonly engagements: bigint;
  readonly impressions: bigint;
  /** Posts that contributed. Always ≥ 1: a campaign with none is absent. */
  readonly posts: number;
  /** Parts per mille, rounded half-up — `computeDerived`'s own rounding. */
  readonly rateMilli: bigint;
}

/** Does this post have an engagement rate at all? */
function hasRate(post: PostEngagementSums): boolean {
  if (post.engagements === null || post.impressions === null) return false;
  return (
    computeDerived('engagement_rate', {
      engagements: post.engagements,
      impressions: post.impressions,
    }) !== null
  );
}

/** Pool each campaign's eligible posts. A campaign with none is left out. */
export function pooledCampaignRates(
  posts: readonly PostEngagementSums[],
): ReadonlyMap<string, CampaignPooledRate> {
  const totals = new Map<string, { engagements: bigint; impressions: bigint; posts: number }>();
  for (const post of posts) {
    if (!hasRate(post)) continue;
    const running = totals.get(post.campaignId) ?? { engagements: 0n, impressions: 0n, posts: 0 };
    running.engagements += post.engagements as bigint;
    running.impressions += post.impressions as bigint;
    running.posts += 1;
    totals.set(post.campaignId, running);
  }

  const out = new Map<string, CampaignPooledRate>();
  for (const [campaignId, sum] of totals) {
    const rateMilli = computeDerived('engagement_rate', {
      engagements: sum.engagements,
      impressions: sum.impressions,
    });
    // Unreachable while every contributing post has impressions > 0; kept so a
    // future change to `hasRate` cannot put a null rate on the leaderboard.
    if (rateMilli === null) continue;
    out.set(campaignId, { campaignId, ...sum, rateMilli });
  }
  return out;
}

/**
 * The campaigns sharing the HIGHEST pooled rate.
 *
 * COMPARED EXACTLY, as fractions, never by the rounded per-mille figure: two
 * campaigns at 4.649% and 4.651% both round to 4.7%, and they are not tied. The
 * caller breaks a genuine tie with the Campaigns list's own order
 * (`startDate desc, createdAt desc`, then `id`) — this function does not invent
 * a second performance metric to do it.
 */
export function highestPooledRates(
  rates: ReadonlyMap<string, CampaignPooledRate>,
): readonly CampaignPooledRate[] {
  let best: CampaignPooledRate[] = [];
  for (const rate of rates.values()) {
    const leader = best[0];
    if (!leader) {
      best = [rate];
      continue;
    }
    // a/b vs c/d  ⇔  a·d vs c·b, with b, d > 0.
    const left = rate.engagements * leader.impressions;
    const right = leader.engagements * rate.impressions;
    if (left > right) best = [rate];
    else if (left === right) best.push(rate);
  }
  return best;
}
