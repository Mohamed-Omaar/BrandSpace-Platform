import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePublishingPolicy } from '@brandspace/social-connectors';
import type { SocialConnection, TenantScopedClient } from '@brandspace/database';
import {
  isAssessed,
  isBlocking,
  publishReadiness,
  type ChannelReadinessState,
} from '../../apps/dashboard/src/server/publish-readiness';

/**
 * PHASE 6 · P6-10 — A SCHEDULED POST WITH NOWHERE TO GO SAYS SO.
 *
 * THE DEFECT. `PublishPipelineService.materialiseSlot()` creates one job per
 * ACTIVE connection that has a matching variant. A brand with no connection for
 * a channel produces NO JOB: the method returns `skipped:
 * 'no_active_connection'`, the scheduler's sweep counts zero, and the slot
 * stays `SCHEDULED` for ever. Nothing is written, nothing fails, nothing is
 * audited, and nothing tells the person who scheduled it. A planner looking at
 * the month saw posts that read as on their way and had no route to a platform.
 *
 * WHAT THIS FILE PINS:
 *
 *   - the five states, and which of them actually block a post;
 *   - an ACTIVE connection with an EXPIRED token is NOT ready, which is the
 *     case the pipeline's own `status: 'ACTIVE'` filter would wave through;
 *   - a provider the platform has switched off in configuration blocks even
 *     with a healthy account behind it, because `materialiseSlot` skips it;
 *   - a slot with no channels at all is BLOCKED, not ready — the empty-reduce
 *     trap, which is the most confident possible way to be wrong;
 *   - readiness is computed from the ITEM'S CURRENT VARIANTS, not the slot's
 *     recorded plan;
 *   - BrandScope reaches the database as a predicate and INTERSECTS the brand
 *     set rather than replacing it.
 */

const NOW = new Date('2026-09-23T12:00:00.000Z');
const WORKSPACE = 'workspace-1';

/**
 * A POLICY WITH THE TWO PROVIDERS THIS FILE USES SWITCHED ON.
 *
 * THE SHIPPED DEFAULT IS `enabled: false` FOR EVERY PROVIDER, and that is
 * correct rather than inconvenient: whether BrandSpace can publish to Instagram
 * is a platform decision made in versioned configuration, not a constant
 * (CLAUDE.md §2.2). A fixture that took `parsePublishingPolicy({})` as "normal"
 * would have reported `UNSUPPORTED` for everything — which is what the first
 * run of this file did, and it was the fixture that was wrong.
 *
 * Built by overriding the parsed document rather than by writing a policy out,
 * so the rest of the shape stays whatever configuration says it is.
 */
const BASE = parsePublishingPolicy({});
const POLICY = {
  ...BASE,
  providers: {
    ...BASE.providers,
    instagram: { ...BASE.providers.instagram, enabled: true },
    linkedin: { ...BASE.providers.linkedin, enabled: true },
  },
};

/** A connection row, with only the fields `toConnectionView` reads set. */
function connection(overrides: Partial<SocialConnection> = {}): SocialConnection {
  return {
    id: overrides.id ?? 'conn-1',
    brandId: overrides.brandId ?? 'brand-1',
    provider: overrides.provider ?? 'INSTAGRAM',
    displayName: overrides.displayName ?? '@northwind',
    avatarUrl: null,
    targetKind: 'PROFILE',
    status: overrides.status ?? 'ACTIVE',
    grantedScopes: [],
    connectedAt: NOW,
    tokenExpiresAt: overrides.tokenExpiresAt ?? null,
    lastSyncedAt: null,
    lastCheckedAt: null,
    consecutiveFailureCount: 0,
    lastFailureClass: null,
    ...overrides,
  } as SocialConnection;
}

/** A tenant client that answers one query and records what it was asked. */
function fakeDb(rows: readonly SocialConnection[]) {
  const asked: unknown[] = [];
  const db = {
    socialConnection: {
      findMany: (args: { where: unknown }) => {
        asked.push(args.where);
        return Promise.resolve([...rows]);
      },
    },
  } as unknown as TenantScopedClient;
  return { db, asked };
}

interface SlotSpec {
  slotId?: string;
  brandId?: string;
  status?: string;
  variantPlatformKeys?: readonly string[];
}

async function readiness(
  rows: readonly SocialConnection[],
  slots: readonly SlotSpec[],
  options: { brandScope?: readonly string[]; policy?: typeof POLICY } = {},
) {
  const { db, asked } = fakeDb(rows);
  const map = await publishReadiness({
    db,
    workspaceId: WORKSPACE,
    policy: options.policy ?? POLICY,
    brandScope: options.brandScope ?? [],
    now: NOW,
    slots: slots.map((slot, index) => ({
      slotId: slot.slotId ?? `slot-${index}`,
      brandId: slot.brandId ?? 'brand-1',
      status: slot.status ?? 'SCHEDULED',
      variantPlatformKeys: slot.variantPlatformKeys ?? ['instagram'],
    })),
  });
  return { map, asked };
}

async function stateOf(
  rows: readonly SocialConnection[],
  slot: SlotSpec = {},
  options: { policy?: typeof POLICY } = {},
): Promise<ChannelReadinessState | undefined> {
  const { map } = await readiness(rows, [slot], options);
  return map.get(slot.slotId ?? 'slot-0')?.state;
}

describe('P6-10 · the five states', () => {
  it('calls a healthy account ready', async () => {
    expect(await stateOf([connection()])).toBe('READY');
  });

  it('calls a brand with no account for the channel NOT_CONNECTED', async () => {
    expect(await stateOf([])).toBe('NOT_CONNECTED');
  });

  it('calls a connection the provider revoked NEEDS_REAUTH', async () => {
    expect(await stateOf([connection({ status: 'REVOKED' })])).toBe('NEEDS_REAUTH');
  });

  it('calls one the platform disabled NEEDS_REAUTH too', async () => {
    // Different cause, same consequence for the planner: the post will not go
    // out through this account and somebody has to do something about it.
    expect(await stateOf([connection({ status: 'DISABLED' })])).toBe('NEEDS_REAUTH');
  });

  it('calls one still mid-OAuth NEEDS_REAUTH', async () => {
    // `PENDING` means the callback never completed. Never publishable.
    expect(await stateOf([connection({ status: 'PENDING' })])).toBe('NEEDS_REAUTH');
  });

  it('refuses to call an ACTIVE connection with an EXPIRED token ready', async () => {
    /*
     * THE CASE THE PIPELINE'S OWN FILTER WOULD WAVE THROUGH. `materialiseSlot`
     * selects `status: 'ACTIVE'` and does not look at the token, so it creates
     * a job that the worker then fails at the provider. Reporting "ready" here
     * would be technically describing the row and wrongly describing the
     * outcome — and the outcome is the only thing the planner asked about.
     */
    const expired = connection({ tokenExpiresAt: new Date(NOW.getTime() - 60_000) });
    expect(await stateOf([expired])).toBe('NEEDS_REAUTH');
  });

  it('warns about a token that expires inside the day without blocking', async () => {
    const soon = connection({ tokenExpiresAt: new Date(NOW.getTime() + 3 * 3_600_000) });
    expect(await stateOf([soon])).toBe('EXPIRING');
    expect(isBlocking('EXPIRING')).toBe(false);
  });

  it('leaves a token expiring next week alone', async () => {
    const later = connection({ tokenExpiresAt: new Date(NOW.getTime() + 7 * 24 * 3_600_000) });
    expect(await stateOf([later])).toBe('READY');
  });

  it('calls a channel that maps to no provider UNSUPPORTED', async () => {
    expect(await stateOf([connection()], { variantPlatformKeys: ['pinterest'] })).toBe(
      'UNSUPPORTED',
    );
  });

  it('blocks everything but READY and EXPIRING', async () => {
    expect(isBlocking('READY')).toBe(false);
    expect(isBlocking('EXPIRING')).toBe(false);
    expect(isBlocking('NEEDS_REAUTH')).toBe(true);
    expect(isBlocking('NOT_CONNECTED')).toBe(true);
    expect(isBlocking('UNSUPPORTED')).toBe(true);
  });
});

describe('P6-10 · the platform switch outranks the account', () => {
  it('reports UNSUPPORTED for a disabled provider even with a healthy account', async () => {
    /*
     * `materialiseSlot` checks `capabilitiesFor(...).enabled` and SKIPS the
     * connection when it is off. An answer that looked only at the account
     * would say "ready" about a channel the platform has turned off — correct
     * about the row, wrong about the post, and it would send the customer
     * looking for a fault in an account that has nothing wrong with it.
     */
    const disabled = {
      ...POLICY,
      providers: {
        ...POLICY.providers,
        instagram: { ...POLICY.providers.instagram, enabled: false },
      },
    };
    expect(await stateOf([connection()], {}, { policy: disabled })).toBe('UNSUPPORTED');
  });

  it('ranks UNSUPPORTED above the fixable blockers', async () => {
    // A slot with one unreachable channel and one unconnected one reports the
    // unreachable one, because reconnecting an account does not help it.
    const { map } = await readiness([], [{ variantPlatformKeys: ['instagram', 'pinterest'] }]);
    expect(map.get('slot-0')?.state).toBe('UNSUPPORTED');
  });
});

describe('P6-10 · which slots are assessed at all', () => {
  it.each(['PLANNED', 'PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED', 'FAILED', 'CANCELLED'])(
    'says nothing about a %s slot',
    async (status) => {
      /*
       * READINESS IS A CLAIM ABOUT AN ATTEMPT THAT HAS NOT HAPPENED. A PLANNED
       * slot has not been cleared to go, and the four terminal states have
       * already met whatever connections they were going to meet — their truth
       * is in the publishing history, not in a prediction. An absent entry
       * renders no row, which is the honest rendering of "does not apply".
       */
      expect(isAssessed(status)).toBe(false);
      const { map } = await readiness([], [{ status }]);
      expect(map.size).toBe(0);
    },
  );

  it('assesses a SCHEDULED slot', async () => {
    expect(isAssessed('SCHEDULED')).toBe(true);
    const { map } = await readiness([], [{ status: 'SCHEDULED' }]);
    expect(map.size).toBe(1);
  });

  it('asks the database nothing when no slot is assessed', async () => {
    // A month of published posts should not cost a connection query.
    const { asked } = await readiness([], [{ status: 'PUBLISHED' }, { status: 'PLANNED' }]);
    expect(asked).toHaveLength(0);
  });
});

describe('P6-10 · the worst channel is the slot', () => {
  it('reports the blocker when one of two channels is fine', async () => {
    // Instagram is connected, LinkedIn is not. The post goes out by half, which
    // for a planner is a problem rather than a success.
    const { map } = await readiness(
      [connection()],
      [{ variantPlatformKeys: ['instagram', 'linkedin'] }],
    );
    expect(map.get('slot-0')?.state).toBe('NOT_CONNECTED');
  });

  it('lists only the blocked channel, not the healthy one', async () => {
    const { map } = await readiness(
      [connection()],
      [{ variantPlatformKeys: ['instagram', 'linkedin'] }],
    );
    const blocked = map.get('slot-0')?.channels.filter((channel) => isBlocking(channel.state));
    expect(blocked?.map((channel) => channel.platformKey)).toEqual(['linkedin']);
  });

  it('treats a slot with no channels as blocked rather than ready', async () => {
    /*
     * THE EMPTY-REDUCE TRAP. Seeding the fold with `READY` would make a slot
     * whose variants have all been deleted the most reassuring row on the
     * screen — and `materialiseSlot` returns `no_matching_variant` for it, so
     * it publishes nothing at all.
     */
    expect(await stateOf([connection()], { variantPlatformKeys: [] })).toBe('NOT_CONNECTED');
  });

  it('one healthy account is enough when a stale one sits beside it', async () => {
    // The pipeline creates a job per matching connection, so the healthy one
    // still posts. Naming the stale one as the blocker would ask the customer
    // to fix something that is not stopping anything.
    const rows = [
      connection({ id: 'stale', status: 'NEEDS_REAUTH' }),
      connection({ id: 'good', status: 'ACTIVE', displayName: '@northwind-main' }),
    ];
    const { map } = await readiness(rows, [{}]);
    expect(map.get('slot-0')?.state).toBe('READY');
    expect(map.get('slot-0')?.channels[0]?.accountName).toBe('@northwind-main');
  });

  it('collapses two variants for the same platform into one channel', async () => {
    // Two variants publish through the same account; listing it twice would
    // read as two problems when there is one.
    const { map } = await readiness([], [{ variantPlatformKeys: ['instagram', 'instagram'] }]);
    expect(map.get('slot-0')?.channels).toHaveLength(1);
  });

  it('matches a platform key whatever its case', async () => {
    expect(await stateOf([connection()], { variantPlatformKeys: ['Instagram'] })).toBe('READY');
  });
});

describe('P6-10 · BrandScope is a query predicate that intersects', () => {
  it('adds no scope term when the scope is empty, because empty is unrestricted', async () => {
    const { asked } = await readiness([connection()], [{}], { brandScope: [] });
    expect(asked[0]).toEqual({ workspaceId: WORKSPACE, AND: [{ brandId: { in: ['brand-1'] } }] });
  });

  it('ANDs the scope beside the brand set rather than replacing it', async () => {
    /*
     * THE "LATER KEY WINS" DEFECT, which is why `brandIdQueryFilter` exists at
     * all. Two spreads both setting `brandId` would let the scope REPLACE the
     * slots' own brand set — widening the read from the brands on this month's
     * calendar to every brand the member may see. `AND` can only narrow.
     */
    const { asked } = await readiness(
      [connection()],
      [{ brandId: 'brand-1' }, { brandId: 'brand-2', slotId: 'slot-b' }],
      { brandScope: ['brand-1'] },
    );
    expect(asked[0]).toEqual({
      workspaceId: WORKSPACE,
      AND: [{ brandId: { in: ['brand-1', 'brand-2'] } }, { brandId: { in: ['brand-1'] } }],
    });
  });

  it('asks about each brand once however many slots it has', async () => {
    const { asked } = await readiness(
      [connection()],
      [{ slotId: 'a' }, { slotId: 'b' }, { slotId: 'c' }],
    );
    expect(asked[0]).toEqual({ workspaceId: WORKSPACE, AND: [{ brandId: { in: ['brand-1'] } }] });
  });

  it('never selects a credential', async () => {
    /*
     * A token cannot leak from a query that does not load one. `social_credential`
     * is a separate table for exactly this reason, and nothing here joins it —
     * asserted on the query itself rather than on the result, because an
     * `include` that fetched one would still produce a correct-looking answer.
     */
    const { asked } = await readiness([connection()], [{}]);
    expect(JSON.stringify(asked[0])).not.toMatch(/credential|token|secret/i);
  });
});

describe('P6-10 · the answer reaches the screen, and the old claim is gone', () => {
  const PAGE = readFileSync('apps/dashboard/src/app/[locale]/calendar/page.tsx', 'utf8');
  const VIEW = readFileSync('apps/dashboard/src/app/[locale]/calendar/calendar-view.tsx', 'utf8');
  const MESSAGES = readFileSync('apps/dashboard/src/i18n/messages.ts', 'utf8');

  it('no longer tells the planner that nothing publishes', () => {
    /*
     * THE SECOND DEFECT THIS WORKSTREAM CLOSED, and it is the same failure in
     * the opposite direction. `calendar.mockTarget` — "Mock target — nothing
     * publishes yet" — was the description of EVERY slot dialog. It was true in
     * Phase 5. Phase 6 shipped real connections and `apps/api`'s scheduler
     * began sweeping due slots into publish jobs, and the sentence became a
     * statement that the product does not do the thing it had just started
     * doing. Asserted as ABSENCE, because a key left in the table is a key a
     * future screen can reach for.
     */
    expect(MESSAGES).not.toContain('mockTarget');
    expect(MESSAGES).not.toContain('nothing publishes yet');
    expect(PAGE).not.toContain('mockTarget');
    expect(VIEW).not.toContain('mockTarget');
  });

  it('computes readiness from the variants, not from the slot plan', () => {
    // `slot.platformKeys` records what was PLANNED and is deliberately never
    // updated when a variant changes. Reading it here would answer about a post
    // that no longer exists.
    expect(PAGE).toContain('variantPlatformKeys: view.variants.map');
    expect(PAGE).not.toMatch(/variantPlatformKeys: view\.slot\.platformKeys/);
  });

  it('names all five states in both languages', () => {
    for (const state of ['READY', 'EXPIRING', 'NEEDS_REAUTH', 'NOT_CONNECTED', 'UNSUPPORTED']) {
      const occurrences = [
        ...MESSAGES.matchAll(new RegExp(`'calendar\\.readiness\\.${state}':`, 'g')),
      ];
      expect(occurrences, `calendar.readiness.${state} is not in both message tables`).toHaveLength(
        2,
      );
    }
  });

  it('offers the fix link only to somebody who may act on it', () => {
    // Connecting and reconnecting an account needs `integrations.manage`.
    // Sending a member without it to a route that will refuse them is the dead
    // control §20 forbids; the COUNT is still shown, because knowing the post
    // will not go out is what lets them ask somebody who can fix it.
    expect(PAGE).toMatch(
      /permissionKeys\.includes\('integrations\.manage'\)[\s\S]{0,400}calendar\.readinessFix/,
    );
  });

  it('withholds the account name from a reader who may not see accounts', () => {
    // The calendar needs `content.read`; connected accounts are an
    // `integrations.read` surface. The STATE is about the reader's own post;
    // the account's display name is not theirs to know.
    expect(PAGE).toContain("workspace.permissionKeys.includes('integrations.read')");
    expect(PAGE).toContain('mayReadAccounts ? channel.accountName : null');
  });

  it('counts the blocked slots for the banner rather than listing them', () => {
    expect(PAGE).toContain('blockedCount');
    expect(PAGE).toMatch(/blockedCount > 0 \? \(/);
  });
});
