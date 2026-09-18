/**
 * Where a customer has got to — DERIVED, never stored (§16).
 *
 * WHY THERE IS NO `onboarding_progress` TABLE. A stored step counter is a second
 * copy of the truth, and the two drift the first time anything happens outside
 * the wizard: a brand created from the Brands page, an account connected from
 * Settings, an invitation accepted by someone else. Then the checklist says
 * "add your first brand" to a customer looking at three of them.
 *
 * SO EVERY STEP IS A QUESTION ASKED OF THE DATA. That makes the journey
 * resumable by construction — closing the tab, signing in on another device,
 * abandoning it for a week and coming back all produce the same answer, because
 * the answer was never being remembered in the first place.
 *
 * AND IT MAKES IT HONEST IN THE OTHER DIRECTION TOO: a step completed outside
 * onboarding is complete here, and a thing later deleted makes its step
 * incomplete again. Nothing here can claim progress the workspace does not have.
 */

import { Prisma, type TenantScopedClient } from '@brandspace/database';
import { orderedSteps, type OnboardingPolicy, type OnboardingStepKey } from './policy';

export interface OnboardingStepState {
  readonly key: OnboardingStepKey;
  readonly required: boolean;
  readonly complete: boolean;
  /** The first incomplete required step, or the first incomplete step. */
  readonly current: boolean;
}

export interface OnboardingState {
  readonly workspaceId: string;
  readonly steps: readonly OnboardingStepState[];
  /** True when every REQUIRED step is complete. Optional steps never block. */
  readonly complete: boolean;
  readonly nextStep: OnboardingStepKey | null;
  readonly completedCount: number;
  readonly requiredCount: number;
}

/**
 * Compute the state for one workspace.
 *
 * ONE QUERY PER FACT, all counts. Reading whole rows to ask "is there at least
 * one" would pull brand content and connection metadata into a checklist that
 * needs neither.
 */
export async function onboardingStateFor(
  db: TenantScopedClient,
  workspaceId: string,
  policy: OnboardingPolicy,
): Promise<OnboardingState> {
  const rules = orderedSteps(policy);

  const [brands, profiledBrands, brainSources, socialConnections, members, subscription] =
    await Promise.all([
      db.brand.count({ where: { workspaceId, deletedAt: null } }),
      /*
       * A BRAND PROFILE IS "STARTED", not "perfect". The step asks whether the
       * customer has told us anything about who the brand is — an industry, a
       * description or a voice. Demanding completeness would leave a diligent
       * customer permanently at 80% with nothing naming the missing field.
       */
      db.brand.count({
        where: {
          workspaceId,
          deletedAt: null,
          OR: [
            { industry: { not: null } },
            { description: { not: null } },
            { voiceProfile: { not: Prisma.DbNull } },
          ],
        },
      }),
      db.brandSourceDocument.count({ where: { workspaceId, deletedAt: null } }),
      db.socialConnection.count({ where: { workspaceId, status: 'ACTIVE' } }),
      // More than the owner. An invitation that was sent counts: the customer
      // did the step, and whether a colleague has accepted yet is not theirs.
      db.membership.count({ where: { workspaceId, status: { in: ['ACTIVE', 'INVITED'] } } }),
      db.workspaceSubscription.findUnique({
        where: { workspaceId },
        select: { planKey: true, status: true },
      }),
    ]);

  const done: Record<OnboardingStepKey, boolean> = {
    // The workspace exists, or this function could not have been called for it.
    workspace: true,
    brand: brands > 0,
    brand_profile: profiledBrands > 0,
    brand_brain: brainSources > 0,
    social: socialConnections > 0,
    team: members > 1,
    /*
     * "PLAN" MEANS A PAID SUBSCRIPTION, not a trial. A trial is what the
     * customer was given; choosing a plan is the decision this step is asking
     * for, and marking it done on day one would remove the one prompt that
     * carries the conversion.
     */
    plan:
      subscription !== null && subscription.status !== 'TRIALING' && subscription.planKey !== '',
  };

  const steps = rules.map((rule) => ({
    key: rule.key,
    required: rule.required,
    complete: done[rule.key] ?? false,
    current: false,
  }));

  const nextRequired = steps.find((step) => step.required && !step.complete);
  const nextAny = steps.find((step) => !step.complete);
  const next = nextRequired ?? nextAny ?? null;

  return {
    workspaceId,
    steps: steps.map((step) => ({ ...step, current: next !== null && step.key === next.key })),
    complete: steps.every((step) => !step.required || step.complete),
    nextStep: next?.key ?? null,
    completedCount: steps.filter((step) => step.complete).length,
    requiredCount: steps.filter((step) => step.required).length,
  };
}
