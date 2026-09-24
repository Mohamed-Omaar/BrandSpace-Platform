/**
 * THE FIRST-RUN SETUP WIZARD'S STATE — Phase 6 final, D-277 §6.
 *
 * PURE, AND NOT `server-only`: the unit suite imports it directly. It reads the
 * message dictionaries only for the goal's labels, which are plain data.
 *
 * NO PROGRESS IS STORED. The owner's contract forbids "a fake
 * onboarding-progress source of truth", and this is what honours it: every
 * step's completion is a question asked of the domain's own rows — is there a
 * brand, a source document, a pending extraction, an active connection, a goal
 * in the brand's strategy memory — so a step done from its own screen (Brand
 * Brain, Connections) is done here too, and a thing later deleted makes its
 * step incomplete again.
 *
 * "SKIP FOR NOW" IS NAVIGATION, NOT A WRITE. Skipping moves the reader to the
 * next step's address; nothing records that they skipped, and nothing nags
 * them afterwards — the wizard ends at "You're ready to start" whether or not
 * every optional step was done (§6 step 7: "Do not continue setup forever").
 */

import { messages } from '../i18n/messages';

export const SETUP_STEPS = ['workspace', 'brand', 'learn', 'review', 'connect', 'goal'] as const;
export type SetupStepKey = (typeof SETUP_STEPS)[number];

/** Every address the wizard has: its steps, then the finish line. */
export type SetupView = Exclude<SetupStepKey, 'workspace'> | 'done';
const VIEWS: readonly SetupView[] = ['brand', 'learn', 'review', 'connect', 'goal', 'done'];

/** What the domain says, read under RLS for the one brand the wizard is about. */
export interface SetupFacts {
  /** Null when the workspace has no brand yet — or several, and none chosen. */
  readonly brandId: string | null;
  /** Source documents on this brand, by where their ingestion is. */
  readonly sources: {
    readonly total: number;
    readonly processing: number;
    readonly failed: number;
  };
  /** Extracted candidates still waiting for a human decision. */
  readonly pendingCandidates: number;
  /** Candidates a human has already decided — accepted, edited or rejected. */
  readonly decidedCandidates: number;
  /** ACTIVE knowledge on the brand: what the AI can actually be grounded in. */
  readonly activeKnowledge: number;
  /** Connected social accounts for this brand that are ACTIVE. */
  readonly activeConnections: number;
  /**
   * The brand's goal item, when there is one, and the objective it names —
   * null when the item was retitled by hand into something else.
   */
  readonly goal: { readonly itemId: string; readonly objective: SetupGoal | null } | null;
}

export interface SetupStepState {
  readonly key: SetupStepKey;
  readonly complete: boolean;
}

/**
 * EACH STEP'S TRUTH CONDITION.
 *
 *   workspace  — the wizard runs inside one, so it exists.
 *   brand      — a brand is chosen (created, or the only one there is).
 *   learn      — at least one document was given to the Brand Brain.
 *   review     — documents exist, none is still being read, and nothing
 *                extracted is waiting for a decision. With no documents there
 *                is nothing to review, and the step is NOT claimed done.
 *   connect    — an ACTIVE connection on this brand.
 *   goal       — a goal sits in the brand's strategy memory.
 */
export function setupSteps(facts: SetupFacts): readonly SetupStepState[] {
  const hasBrand = facts.brandId !== null;
  const done: Record<SetupStepKey, boolean> = {
    workspace: true,
    brand: hasBrand,
    learn: hasBrand && facts.sources.total > 0,
    review:
      hasBrand &&
      facts.sources.total > 0 &&
      facts.sources.processing === 0 &&
      facts.pendingCandidates === 0,
    connect: hasBrand && facts.activeConnections > 0,
    goal: hasBrand && facts.goal !== null,
  };
  return SETUP_STEPS.map((key) => ({ key, complete: done[key] }));
}

/**
 * WHICH SCREEN TO SHOW.
 *
 * An explicit `?step=` wins — that is how "Skip for now" and the stepper's
 * links move — except that nothing past the brand step can be shown without a
 * brand, because every later step is ABOUT one. Without an explicit step the
 * reader lands on the first incomplete one; with everything done, the finish.
 */
export function setupView(requested: unknown, steps: readonly SetupStepState[]): SetupView {
  const brandDone = steps.find((step) => step.key === 'brand')?.complete ?? false;
  if (!brandDone) return 'brand';
  if (typeof requested === 'string' && (VIEWS as readonly string[]).includes(requested)) {
    return requested as SetupView;
  }
  const next = steps.find((step) => step.key !== 'workspace' && !step.complete);
  return next ? (next.key as SetupView) : 'done';
}

/** The step after this one — where "Continue" and "Skip for now" go. */
export function nextView(view: SetupView): SetupView {
  const index = VIEWS.indexOf(view);
  return VIEWS[Math.min(index + 1, VIEWS.length - 1)] ?? 'done';
}

/**
 * THE RECOMMENDED FIRST ACTION (§6 step 7), from what the brand actually has.
 *
 * With ACTIVE knowledge the AI has something true to plan from, so planning
 * with the Copilot is the stronger first move. Without it, a plan would be
 * generic, and the honest recommendation is to write a first post — which the
 * composer supports with or without Brand Brain.
 */
export function recommendedFirstAction(facts: SetupFacts): 'plan' | 'create' {
  return facts.activeKnowledge > 0 ? 'plan' : 'create';
}

/*
 * ---------------------------------------------------------------------------
 * THE FIRST GOAL (§6 step 6)
 * ---------------------------------------------------------------------------
 *
 * THE VOCABULARY IS THE PRODUCT'S OWN: each option is a `CampaignObjective`
 * the strategy and campaign domain already speaks, so the goal needs no
 * translation layer to become a campaign's objective later.
 *
 * "BUILD AUTHORITY" IS NOT OFFERED. The contract allows it only "if mapped
 * safely", and no existing objective means authority; mapping it onto
 * AWARENESS or ENGAGEMENT would store a goal the customer did not choose.
 * "I'M NOT SURE" STORES NOTHING — an absent goal is the truth.
 */
export const SETUP_GOALS = [
  'AWARENESS',
  'ENGAGEMENT',
  'LEADS',
  'TRAFFIC',
  'LAUNCH',
  'CONSISTENCY',
  'RETENTION',
  'AUTHORITY',
] as const;
export type SetupGoal = (typeof SETUP_GOALS)[number];

/*
 * GOALS THAT ARE NOT CAMPAIGN OBJECTIVES (Phase 6 final acceptance, D-303).
 *
 * "Post consistently" and "Build authority" are real first goals the owner
 * asked for, and they are stored exactly as every goal is — a HUMAN item in the
 * brand's STRATEGY memory. What they are NOT is a `CampaignObjective`, and
 * nothing maps them onto one: `campaignObjectiveFor` answers null for them, so
 * a campaign prefilled from the goal carries no objective rather than a
 * different one the customer did not choose. (D-278's reason for leaving
 * authority out was exactly that mapping; without it the goal is honest.)
 */
export const CAMPAIGN_OBJECTIVE_GOALS = [
  'AWARENESS',
  'ENGAGEMENT',
  'LEADS',
  'TRAFFIC',
  'LAUNCH',
  'RETENTION',
] as const;
export type CampaignObjectiveGoal = (typeof CAMPAIGN_OBJECTIVE_GOALS)[number];

export function campaignObjectiveFor(goal: SetupGoal | null): CampaignObjectiveGoal | null {
  return goal && (CAMPAIGN_OBJECTIVE_GOALS as readonly string[]).includes(goal)
    ? (goal as CampaignObjectiveGoal)
    : null;
}

/** The knowledge key the goal lives under, in the brand's STRATEGY memory. */
export const GOAL_ITEM_KEY = 'goal.primary';

/**
 * Keys under `goal.` are goals, not content pillars. The strategy engine's
 * content-gap check reads STRATEGY items as the pillars a brand declared, and
 * must skip these — `packages/intelligence/src/strategy.ts` does.
 */
export const GOAL_KEY_PREFIX = 'goal.';

export function setupGoalFrom(value: unknown): SetupGoal | 'unsure' | null {
  if (value === 'unsure') return 'unsure';
  return typeof value === 'string' && (SETUP_GOALS as readonly string[]).includes(value)
    ? (value as SetupGoal)
    : null;
}

/**
 * The goal a stored item names. The item's English title is the objective's
 * English label, written by the wizard; anything else — an item a person
 * retitled by hand in Brand Brain — is still a goal, just not one of these.
 */
export function goalFromTitle(
  titleEn: string | undefined,
  labels: Readonly<Record<SetupGoal, string>>,
): SetupGoal | null {
  if (!titleEn) return null;
  return SETUP_GOALS.find((goal) => labels[goal] === titleEn) ?? null;
}

/** The English label of each objective — what the wizard writes as the goal's title. */
export function goalLabels(locale: 'en' | 'ar'): Readonly<Record<SetupGoal, string>> {
  const dictionary = messages[locale] as Record<string, string>;
  return Object.fromEntries(
    SETUP_GOALS.map((goal) => [goal, dictionary[`setup.goal.${goal}`] ?? goal]),
  ) as Record<SetupGoal, string>;
}

/**
 * THE GOAL AS KNOWLEDGE — both languages, from the dictionaries rather than
 * from the reader's interface language, because a knowledge item is read in
 * both (CLAUDE.md §4) and the Brand Brain shows whichever its reader uses.
 */
export function goalKnowledge(goal: SetupGoal): {
  readonly title: { readonly en: string; readonly ar: string };
  readonly body: { readonly en: string; readonly ar: string };
} {
  const en = goalLabels('en')[goal];
  const ar = goalLabels('ar')[goal];
  const sentence = (locale: 'en' | 'ar', label: string) =>
    ((messages[locale] as Record<string, string>)['setup.goal.knowledgeBody'] ?? '{goal}').replace(
      '{goal}',
      label,
    );
  return { title: { en, ar }, body: { en: sentence('en', en), ar: sentence('ar', ar) } };
}
