import type { PlanDetail } from './plan-catalogue';

/**
 * HOW MANY WORKSPACES AN OWNER MAY OWN (Q1 / A2 / G7, prototype v94 Phase 2B-1).
 *
 * THE ALLOWANCE IS READ FROM THE PLANS THE OWNER ALREADY HAS — there is no
 * account plan, no second subscription and no new billing record. Billing stays
 * per workspace (Q1); this only asks the plans those workspaces are on how
 * many workspaces an owner on them may have, and takes the most generous.
 *
 * THE RULE (owner-approved, recorded in D-326):
 *
 *   - COUNTED ("used"): every workspace the person OWNS (`ownerUserId`) that
 *     is not deleted — `deletedAt` null and status other than DELETED. A
 *     workspace pending deletion still counts until it is actually DELETED,
 *     so deleting and re-creating cannot be used to exceed the allowance.
 *   - CONTRIBUTING ("allowed"): the `workspaces` quota of each owned,
 *     non-deleted workspace's plan, where
 *       · a subscription that is CANCELLED or EXPIRED contributes nothing — the
 *         same terminal rule `EntitlementService.contextFor` applies (D-246);
 *       · a TRIALING subscription contributes only when the owner has NO
 *         workspace whose subscription is ACTIVE or PAST_DUE, so creating a
 *         trial workspace can never raise the allowance (G7: "from the owner's
 *         account plan, not from the trial plan of a new workspace");
 *       · a workspace that has NEVER HAD A PLAN (no plan key, no subscription)
 *         states no ceiling, which the precedence engine already reads as "no
 *         ceiling applies" for a quota with a null default (precedence.ts,
 *         `neverHadAPlan`) — the same answer, not a new one;
 *       · a plan key the active catalogue does not contain contributes nothing.
 *   - `null` IS UNLIMITED, exactly as for every other plan quota. The highest
 *     stated number wins; any unlimited contribution makes it unlimited.
 *   - NOTHING CONTRIBUTING MEANS NOTHING MORE MAY BE CREATED. A person who owns
 *     no workspace at all may still create their first: that is the sign-up
 *     path, not an allowance.
 *
 * PURE. The caller reads the facts (`OwnedWorkspaceFact`) and the active plan
 * catalogue; this decides. The facts are read on the PLATFORM connection,
 * because the owner's workspaces are several tenants and no single tenant
 * context can see them all.
 */

export type AllowanceSubscriptionStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'PAUSED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'CHECKOUT_PENDING'
  | 'SUSPENDED';

export interface OwnedWorkspaceFact {
  readonly workspaceId: string;
  readonly status: string;
  readonly deletedAt: Date | null;
  readonly planKey: string | null;
  /** The workspace's subscription status, or null when it has none. */
  readonly subscriptionStatus: AllowanceSubscriptionStatus | string | null;
}

export interface WorkspaceAllowance {
  /** Owned workspaces that count against the allowance. */
  readonly used: number;
  /** How many may be owned; `null` is unlimited. */
  readonly allowed: number | null;
  /** Whether one more may be created now. */
  readonly canCreate: boolean;
}

const TERMINAL: ReadonlySet<string> = new Set(['CANCELLED', 'EXPIRED']);
const PAID: ReadonlySet<string> = new Set(['ACTIVE', 'PAST_DUE']);

/** The owned workspaces that count: not deleted, by either marker. */
export function countedWorkspaces(
  owned: readonly OwnedWorkspaceFact[],
): readonly OwnedWorkspaceFact[] {
  return owned.filter((row) => row.deletedAt === null && row.status !== 'DELETED');
}

export function workspaceAllowance(
  owned: readonly OwnedWorkspaceFact[],
  plans: readonly PlanDetail[],
): WorkspaceAllowance {
  const counted = countedWorkspaces(owned);
  const used = counted.length;
  const hasPaid = counted.some(
    (row) => row.subscriptionStatus !== null && PAID.has(row.subscriptionStatus),
  );

  let allowed: number | null = 0;
  let unlimited = false;
  for (const row of counted) {
    const status = row.subscriptionStatus;
    if (status !== null && TERMINAL.has(status)) continue;
    if (status === 'TRIALING' && hasPaid) continue;
    if (row.planKey === null) {
      // Never had a plan: no ceiling is stated anywhere (see the header).
      if (status === null) unlimited = true;
      continue;
    }
    const plan = plans.find((candidate) => candidate.key === row.planKey);
    if (!plan) continue;
    const quota = plan.quotas.workspaces;
    if (quota === null) {
      unlimited = true;
      continue;
    }
    allowed = Math.max(allowed, quota);
  }

  if (unlimited) allowed = null;
  const canCreate = used === 0 || allowed === null || used < allowed;
  return { used, allowed, canCreate };
}

/**
 * The facts `workspaceAllowance` decides from, for one person.
 *
 * `db` MUST BE THE PLATFORM CONNECTION (see the header). Typed structurally so
 * this package does not need the generated client's full surface.
 */
export async function ownedWorkspaceFacts(
  db: {
    readonly workspace: {
      findMany(args: unknown): Promise<
        ReadonlyArray<{
          id: string;
          status: string;
          deletedAt: Date | null;
          planKey: string | null;
          subscription: { status: string } | null;
        }>
      >;
    };
  },
  userId: string,
): Promise<readonly OwnedWorkspaceFact[]> {
  const rows = await db.workspace.findMany({
    where: { ownerUserId: userId },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      planKey: true,
      subscription: { select: { status: true } },
    },
  });
  return rows.map((row) => ({
    workspaceId: row.id,
    status: row.status,
    deletedAt: row.deletedAt,
    planKey: row.planKey,
    subscriptionStatus: row.subscription?.status ?? null,
  }));
}
