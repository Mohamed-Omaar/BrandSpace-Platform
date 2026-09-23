import {
  capabilitiesFor,
  providerForPlatformKey,
  toConnectionView,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import type { SocialProvider, TenantScopedClient } from '@brandspace/database';

/**
 * PHASE 6 · P6-10 — WILL THIS SCHEDULED POST ACTUALLY GO OUT?
 *
 * THE DEFECT THIS EXISTS TO CLOSE. `PublishPipelineService.materialiseSlot()`
 * iterates a brand's ACTIVE connections and creates a job for each one that has
 * a matching variant. A brand with no connection for a channel produces NO JOB
 * AT ALL — the method returns `skipped: 'no_active_connection'`, the sweep
 * counts zero, and the slot stays `SCHEDULED` for ever. Nothing is written,
 * nothing fails, and nothing tells the person who scheduled it. The same
 * silence covers a connection in `NEEDS_REAUTH`, one the customer revoked, and
 * one whose provider the platform has switched off in configuration.
 *
 * So the calendar showed a month of posts that read as on their way, some of
 * which had no route to a platform and never would. This module asks the
 * question the screen could not: for each scheduled slot, is there a
 * publishable account behind every channel it is written for?
 *
 * IT ANSWERS FROM THE SAME FACTS THE PUBLISHER USES, and that is the whole
 * design constraint. `providerForPlatformKey`, `capabilitiesFor` and
 * `toConnectionView` are imported rather than re-derived, so a readiness answer
 * cannot drift into disagreeing with what the pipeline will do. A second
 * opinion about publishability would be worse than none: it would be confident
 * and occasionally wrong.
 *
 * NO `import 'server-only'`. This module is imported by the isolation suite,
 * which runs outside a React request — the same deliberate exception
 * `command-center.ts` and `approval-notes.ts` carry. Nothing here reads a
 * cookie, a header or the request; the tenant client is a parameter.
 *
 * NOTHING HERE DECRYPTS ANYTHING. `social_connection` alone is read, never
 * `social_credential`, so this cannot leak a token because it never loads one —
 * the same reason `ConnectionView` has no token-shaped field.
 */

/** What stands between a channel and its platform, from worst to fine. */
export type ChannelReadinessState =
  /** The channel maps to no provider we can publish through, or the platform
   *  has switched that provider off in versioned configuration. The customer
   *  cannot fix this, which is why it outranks the other two blockers. */
  | 'UNSUPPORTED'
  /** No account is connected for this provider on this brand. */
  | 'NOT_CONNECTED'
  /** An account exists but cannot publish: re-auth needed, revoked, disabled
   *  by the platform, or its token has already expired. */
  | 'NEEDS_REAUTH'
  /** Publishable now, and its token expires inside the refresh window. */
  | 'EXPIRING'
  /** Publishable. */
  | 'READY';

/**
 * Severity, so a slot can report the worst of its channels in one word.
 *
 * `UNSUPPORTED` IS RANKED ABOVE THE OTHER TWO BLOCKERS deliberately: connecting
 * an account fixes `NOT_CONNECTED`, reconnecting fixes `NEEDS_REAUTH`, and
 * nothing the customer can do fixes a provider the platform has turned off. A
 * summary that offered "reconnect" for a slot that also has an unreachable
 * channel would be sending somebody to do work that does not help.
 */
const SEVERITY: Record<ChannelReadinessState, number> = {
  UNSUPPORTED: 4,
  NOT_CONNECTED: 3,
  NEEDS_REAUTH: 2,
  EXPIRING: 1,
  READY: 0,
};

/** True when the state means the post cannot go out at all. */
export function isBlocking(state: ChannelReadinessState): boolean {
  return SEVERITY[state] >= SEVERITY.NEEDS_REAUTH;
}

export interface ChannelReadiness {
  readonly platformKey: string;
  readonly provider: SocialProvider | null;
  readonly state: ChannelReadinessState;
  /** The connected account's own name, when there is one to name. Never a token. */
  readonly accountName: string | null;
}

export interface SlotReadiness {
  readonly slotId: string;
  /** The worst of the channels, which is what the slot's state is. */
  readonly state: ChannelReadinessState;
  readonly channels: readonly ChannelReadiness[];
}

export interface ReadinessSlotInput {
  readonly slotId: string;
  readonly brandId: string;
  /** The slot's own publishing status, as stored. */
  readonly status: string;
  /**
   * THE ITEM'S CURRENT VARIANTS, NOT THE SLOT'S RECORDED `platformKeys`.
   *
   * The two differ on purpose. `CalendarSlot.platformKeys` is a record of what
   * was PLANNED and is deliberately not updated when a variant is edited, so
   * the chip keeps showing the plan. `materialiseSlot` matches connections
   * against the item's variants AS THEY ARE NOW. A readiness answer computed
   * from the plan would be an answer about a post that no longer exists —
   * reassuring about a channel that has since been deleted, and silent about
   * one that was added this morning.
   */
  readonly variantPlatformKeys: readonly string[];
}

/**
 * WHICH SLOTS ARE ASSESSED AT ALL.
 *
 * `SCHEDULED` and nothing else, because readiness is a claim about an attempt
 * that has not happened yet. A `PLANNED` slot is on the calendar and has not
 * been cleared to go, so warning about its accounts would put a blocker on work
 * nobody has committed to. `PUBLISHING`, `PUBLISHED`, `PARTIALLY_PUBLISHED` and
 * `FAILED` have already met the connections they were going to meet, and their
 * truth is in the publishing history rather than in a prediction.
 */
const ASSESSED_STATUSES: ReadonlySet<string> = new Set(['SCHEDULED']);

export function isAssessed(status: string): boolean {
  return ASSESSED_STATUSES.has(status);
}

export interface PublishReadinessInput {
  readonly db: TenantScopedClient;
  /**
   * THE SECOND LAYER, NOT A CONVENIENCE (CLAUDE.md §2.1).
   *
   * The client is already tenant-scoped and PostgreSQL RLS is already in FORCE
   * on `social_connection`, so this predicate is redundant — which is exactly
   * the point: isolation is enforced in two INDEPENDENT layers and neither
   * alone is considered sufficient. A read that relied on RLS alone would be a
   * read that a misconfigured role silently widens.
   */
  readonly workspaceId: string;
  readonly policy: PublishingPolicy;
  /** The member's membership scope. EMPTY MEANS UNRESTRICTED (D-132/D-134). */
  readonly brandScope: readonly string[];
  readonly slots: readonly ReadinessSlotInput[];
  readonly now: Date;
}

/**
 * Readiness for every slot worth assessing, keyed by slot id.
 *
 * Slots that are not assessed are ABSENT from the map rather than present with
 * a reassuring state — the screen then renders nothing for them, which is the
 * honest rendering of "this question does not apply" (D-184).
 */
export async function publishReadiness(
  input: PublishReadinessInput,
): Promise<Map<string, SlotReadiness>> {
  const assessed = input.slots.filter((slot) => isAssessed(slot.status));
  if (assessed.length === 0) return new Map();

  const brandIds = [...new Set(assessed.map((slot) => slot.brandId))];

  /*
   * BRANDSCOPE INTERSECTS THE BRAND SET — it does not replace it, and it is a
   * QUERY PREDICATE rather than a filter over fetched rows (D-132/D-134).
   *
   * Written as an explicit `AND` for the reason `brandIdQueryFilter` exists:
   * two spreads both setting `brandId` would silently let the later one win,
   * and here that would widen the read to the member's whole scope. `AND` can
   * only narrow. An empty scope contributes no term, because empty means
   * unrestricted and a `{ in: [] }` would mean the opposite.
   */
  const connections = await input.db.socialConnection.findMany({
    where: {
      workspaceId: input.workspaceId,
      AND: [
        { brandId: { in: brandIds } },
        ...(input.brandScope.length === 0 ? [] : [{ brandId: { in: [...input.brandScope] } }]),
      ],
    },
    orderBy: [{ provider: 'asc' }, { id: 'asc' }],
  });

  /** `brandId → provider → the connections on it`, in the query's order. */
  const byBrand = new Map<string, Map<SocialProvider, ReturnType<typeof toConnectionView>[]>>();
  for (const connection of connections) {
    const view = toConnectionView(connection, input.now);
    const providers = byBrand.get(connection.brandId) ?? new Map();
    providers.set(connection.provider, [...(providers.get(connection.provider) ?? []), view]);
    byBrand.set(connection.brandId, providers);
  }

  const readiness = new Map<string, SlotReadiness>();
  for (const slot of assessed) {
    /*
     * ONE ENTRY PER DISTINCT CHANNEL. Two variants for the same platform
     * publish through the same account, and listing it twice would read as two
     * problems when there is one.
     */
    const keys = [...new Set(slot.variantPlatformKeys.map((key) => key.toLowerCase()))].sort();
    const channels = keys.map((platformKey) =>
      channelReadiness({
        platformKey,
        policy: input.policy,
        accounts: byBrand.get(slot.brandId),
      }),
    );

    /*
     * A SLOT WITH NO CHANNELS AT ALL IS BLOCKED, not ready. `materialiseSlot`
     * finds no variant for any connection and returns `no_matching_variant`, so
     * nothing publishes — and the empty `reduce` seed would otherwise have
     * called that `READY`, which is the most confident possible way to be wrong.
     */
    const state = channels.reduce<ChannelReadinessState>(
      (worst, channel) => (SEVERITY[channel.state] > SEVERITY[worst] ? channel.state : worst),
      channels.length === 0 ? 'NOT_CONNECTED' : 'READY',
    );
    readiness.set(slot.slotId, { slotId: slot.slotId, state, channels });
  }
  return readiness;
}

function channelReadiness(input: {
  platformKey: string;
  policy: PublishingPolicy;
  accounts: Map<SocialProvider, ReturnType<typeof toConnectionView>[]> | undefined;
}): ChannelReadiness {
  const provider = providerForPlatformKey(input.platformKey);
  if (!provider) {
    return {
      platformKey: input.platformKey,
      provider: null,
      state: 'UNSUPPORTED',
      accountName: null,
    };
  }

  /*
   * THE PLATFORM'S OWN SWITCH, READ FROM VERSIONED CONFIGURATION (CLAUDE.md
   * §2.2) — and checked BEFORE the accounts, because `materialiseSlot` skips a
   * disabled provider even when a healthy account is connected to it. Reporting
   * "ready" there would describe the account correctly and the outcome wrongly.
   */
  if (!capabilitiesFor(input.policy, provider).enabled) {
    return { platformKey: input.platformKey, provider, state: 'UNSUPPORTED', accountName: null };
  }

  const accounts = input.accounts?.get(provider) ?? [];
  if (accounts.length === 0) {
    return { platformKey: input.platformKey, provider, state: 'NOT_CONNECTED', accountName: null };
  }

  /*
   * ONE PUBLISHABLE ACCOUNT IS ENOUGH, which is what the pipeline does: it
   * creates a job per connection that matches, so a brand with a healthy
   * Instagram account and a stale second one still posts. Naming the stale one
   * as the slot's blocker would ask the customer to fix something that is not
   * stopping anything.
   */
  const publishable = accounts.find((account) => account.publishable);
  if (publishable) {
    return {
      platformKey: input.platformKey,
      provider,
      state: publishable.expiringSoon ? 'EXPIRING' : 'READY',
      accountName: publishable.displayName,
    };
  }
  return {
    platformKey: input.platformKey,
    provider,
    state: 'NEEDS_REAUTH',
    accountName: accounts[0]?.displayName ?? null,
  };
}
