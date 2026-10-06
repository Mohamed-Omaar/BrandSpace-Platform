import { currentEnvironment, brandIdQueryFilter } from '@brandspace/shared';
import type { TenantScopedClient } from '@brandspace/database';
import {
  BrandKnowledgeService,
  TenantBrandBrainPolicySource,
  questionsForBrand,
  workspaceKnowledgeAsOf,
} from '@brandspace/brand-brain';
import { TenantOnboardingPolicySource, offersQuestionSetFor } from '@brandspace/onboarding';

/**
 * HOME, AS `prototype-2026-09-27` COMPUTES IT (D-468) — the small pieces of its
 * logic that are presentation, transcribed, and the facts its setup checklist
 * reads, from the modules that own them. Nothing here invents a number.
 */

/**
 * Which Home a member gets: the prototype's `VA_meKind`. It names roles; the
 * product decides from PERMISSIONS (A6, so a custom role gets the Home its
 * permissions describe), with the same five outcomes:
 *
 *   owner    — creates AND approves (the owner, an admin, a marketing manager):
 *              the full Home;
 *   approver — approves, does not create: waiting for review · coming up;
 *   creator  — creates or submits, does not approve: drafts · sent · scheduled
 *              · coming up;
 *   analyst  — reads analytics and none of the above: top posts · coming up;
 *   client   — reads only: waiting for your feedback · coming up.
 */
export type HomeKind = 'owner' | 'approver' | 'creator' | 'analyst' | 'client';

export function homeKindFor(permissionKeys: readonly string[]): HomeKind {
  const may = (key: string) => permissionKeys.includes(key);
  const creates = may('content.create') || may('content.submit');
  const approves = may('content.approve');
  if (creates && approves) return 'owner';
  if (approves) return 'approver';
  if (creates) return 'creator';
  if (may('analytics.read')) return 'analyst';
  return 'client';
}

/** `kfmt`: 12,400 → "12K", 1,240 → "1.2K", 124 → "124". */
export function compactCount(value: number): string {
  if (value >= 10000) return `${Math.round(value / 1000)}K`;
  if (value >= 1000) return `${Math.round(value / 100) / 10}K`;
  return String(Math.round(value));
}

/**
 * `delta(a, b)`: "↑ +5%" in green, "↓ -8%" in red, "—" when there is no
 * baseline. From the analytics layer's own change (parts per mille), which is
 * already null when either side is missing or the baseline is zero.
 */
/**
 * ROUND 4 (4.6, review of 2a) — HOME'S "of N": THE MONTHLY GRANT.
 *
 * N is what the period reset actually grants: the subscription's PINNED
 * monthly credits. The plan catalogue's figure is the fallback for a
 * subscription that pinned none. Reading the catalogue alone dropped "of N"
 * and the bar for a plan the catalogue does not list. No subscription, no N.
 */
export function homeCreditGrant(
  subscription: { readonly pinnedMonthlyCredits: number } | null,
  catalogueMonthlyCredits: number | undefined,
): number | null {
  if (!subscription) return null;
  if (subscription.pinnedMonthlyCredits > 0) return subscription.pinnedMonthlyCredits;
  return catalogueMonthlyCredits !== undefined && catalogueMonthlyCredits > 0
    ? catalogueMonthlyCredits
    : null;
}

/**
 * ROUND 4 (4.5) — A CHANGE ONLY AGAINST A COMPLETE PREVIOUS PERIOD.
 *
 * The owner saw "+3321%": a workspace whose data began a few days into the
 * previous 28 compared a full month with a handful of days. The change is
 * shown only when the previous window was measured FROM ITS FIRST DAY (its
 * series has a value on day one); otherwise it is "—", never a percentage.
 * Presentation only: the analytics figures themselves are unchanged.
 */
export function comparableChange(
  changeMilli: number | null,
  previousPoints: readonly (number | null)[],
): number | null {
  if (changeMilli === null) return null;
  const first = previousPoints[0];
  return first === undefined || first === null ? null : changeMilli;
}

export function deltaText(changeMilli: number | null): {
  readonly text: string;
  readonly tone: 'up' | 'down' | 'none';
} {
  if (changeMilli === null) return { text: '—', tone: 'none' };
  const percent = Math.round(changeMilli / 10);
  return percent >= 0
    ? { text: `↑ +${percent}%`, tone: 'up' }
    : { text: `↓ ${percent}%`, tone: 'down' };
}

/**
 * `spark(vals)`: a 120×30 polyline, `y = h − 2 − (v − min) / max(1, max − min)
 * × (h − 4)`. A day with no observation is a GAP (a new `M`), never drawn as a
 * zero — missing and zero are different states. Nothing measured at all is the
 * prototype's own flat default, `M0 15 L120 15`.
 */
export function sparkPath(points: readonly (number | null)[]): string {
  const known = points.filter((value): value is number => value !== null);
  if (known.length === 0) return 'M0 15 L120 15';
  const max = Math.max(...known);
  const min = Math.min(...known);
  const width = 120;
  const height = 30;
  let path = '';
  let pen = false;
  points.forEach((value, index) => {
    if (value === null) {
      pen = false;
      return;
    }
    const x = Math.round((index / Math.max(1, points.length - 1)) * width);
    const y = Math.round(height - 2 - ((value - min) / Math.max(1, max - min)) * (height - 4));
    path += `${pen ? 'L' : 'M'}${x} ${y} `;
    pen = true;
  });
  return path.trim();
}

/**
 * THE SETUP CHECKLIST'S FACTS (`GS`, `Main.dc.html` line 4509) for one brand:
 * connected accounts, Brand Brain areas complete out of all, whether a first
 * post exists, whether one has been scheduled or sent for review, and how many
 * people are on the team. Each from the module that owns it.
 */
export interface SetupChecklistFacts {
  readonly connections: number;
  readonly areasComplete: number;
  readonly areasTotal: number;
  readonly brainComplete: boolean;
  readonly hasPost: boolean;
  readonly hasSent: boolean;
  readonly members: number;
}

export async function setupChecklistFacts(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly brandId: string;
    readonly brandScope: readonly string[];
  },
): Promise<SetupChecklistFacts> {
  const scope = brandIdQueryFilter({ brandId: input.brandId, brandScope: input.brandScope });
  const environment = currentEnvironment();
  const [connections, posts, sent, members, brand, policy, onboarding, asOf] = await Promise.all([
    db.socialConnection.count({ where: { brandId: input.brandId, status: 'ACTIVE' } }),
    db.contentItem.count({ where: { workspaceId: input.workspaceId, deletedAt: null, ...scope } }),
    db.calendarSlot.count({
      where: {
        workspaceId: input.workspaceId,
        status: { in: ['SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED'] },
        ...scope,
      },
    }),
    db.membership.count({ where: { workspaceId: input.workspaceId, status: 'ACTIVE' } }),
    db.brand.findFirst({ where: { id: input.brandId }, select: { industry: true } }),
    new TenantBrandBrainPolicySource(db, environment).load(),
    new TenantOnboardingPolicySource(db, environment).load(),
    workspaceKnowledgeAsOf(db),
  ]);
  const inReview =
    sent > 0
      ? 0
      : await db.contentItem.count({
          where: { workspaceId: input.workspaceId, deletedAt: null, status: 'IN_REVIEW', ...scope },
        });
  const questions = questionsForBrand(
    policy.questions,
    offersQuestionSetFor(brand?.industry ?? null, onboarding.industries),
  );
  const completion = await new BrandKnowledgeService({ db, workspaceId: input.workspaceId })
    .completion(input.brandId, questions, asOf)
    .catch(() => null);
  return {
    connections,
    areasComplete: completion
      ? completion.areas.filter((area) => area.status === 'COMPLETE').length
      : 0,
    areasTotal: completion ? completion.areas.length : 0,
    brainComplete: completion ? completion.missing.length === 0 : false,
    hasPost: posts > 0,
    hasSent: sent > 0 || inReview > 0,
    members,
  };
}
