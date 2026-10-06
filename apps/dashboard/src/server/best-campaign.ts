import 'server-only';
import { highestPooledRates } from '@brandspace/analytics';
import { brandIdQueryFilter } from '@brandspace/shared';
import { inAnalytics } from './analytics-context';

/**
 * B11 (Phase 2B-2b) — THE "BEST CAMPAIGN" CARD ON THE CAMPAIGNS LIST (D-341).
 *
 * The campaign with the highest POOLED lifetime engagement rate, over the SAME
 * brands the list shows: the brand on the rail, or — for "All brands" — every
 * brand this member may access. The rate and the "unavailable is left out"
 * rule are `AnalyticsQueryService.campaignEngagementRates`; this only picks.
 *
 * A TIE IS BROKEN BY THE LIST'S OWN ORDER (`startDate desc, createdAt desc,
 * id desc`) — the campaign that would appear first — and never by inventing a
 * second performance metric.
 *
 *   - `{ kind: 'best', … }` — a winner.
 *   - `{ kind: 'none' }`    — no live campaign has a published post with a rate:
 *                             "—" and "No campaign has published yet".
 *   - `null`                — the figures could not be read. The card is not
 *                             drawn: a failed read is not "nothing published".
 */
export type BestCampaign =
  | {
      readonly kind: 'best';
      readonly campaignId: string;
      readonly name: string;
      /** Pooled engagement rate, parts per mille. */
      readonly rateMilli: bigint;
    }
  | { readonly kind: 'none' };

export async function bestCampaign(input: {
  readonly workspaceId: string;
  readonly brandId?: string | undefined;
  readonly brandScope: readonly string[];
}): Promise<BestCampaign | null> {
  try {
    return await inAnalytics(input.workspaceId, async (services) => {
      const queries = await services.queries();
      const rates = await queries.campaignEngagementRates({
        brandId: input.brandId,
        brandScope: input.brandScope,
      });
      const leaders = highestPooledRates(rates);
      if (leaders.length === 0) return { kind: 'none' } as const;

      const winner = await services.db.campaign.findFirst({
        where: {
          workspaceId: input.workspaceId,
          id: { in: leaders.map((leader) => leader.campaignId) },
          deletedAt: null,
          ...brandIdQueryFilter({ brandId: input.brandId, brandScope: input.brandScope }),
        },
        orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, name: true },
      });
      const rate = winner ? rates.get(winner.id) : undefined;
      if (!winner || !rate) return { kind: 'none' } as const;
      return {
        kind: 'best',
        campaignId: winner.id,
        name: winner.name,
        rateMilli: rate.rateMilli,
      } as const;
    });
  } catch {
    return null;
  }
}

/** A per-mille rate as the card shows it: one decimal, Western digits, a `%`. */
export function formatRateMilli(rateMilli: bigint, _locale: string): string {
  const number = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
    numberingSystem: 'latn',
  }).format(Number(rateMilli) / 10);
  return `${number}%`;
}
