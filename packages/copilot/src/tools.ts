import { z } from 'zod';
import type { CopilotActionClass } from '@brandspace/database';

/**
 * THE COPILOT'S TOOL REGISTRY — a CLOSED SET, and the reason the Copilot is an
 * orchestrator rather than a database shortcut.
 *
 * WHAT A TOOL IS HERE: a named, typed call into a domain service that performs
 * its OWN authorization. The model never holds a database handle, never writes a
 * `where` clause, and never chooses whether authorization applies. It chooses a
 * KEY from this table and supplies arguments that a Zod schema parses before
 * anything runs — so a tool nobody declared cannot be invoked by a model that
 * invents its name, and an argument nobody declared cannot reach a service.
 *
 * EVERY ENTRY DECLARES ALL EIGHT THINGS THE PHASE REQUIRES, in one place where a
 * reviewer can read them together rather than scattered across call sites:
 *
 *   key             stable identifier, recorded on every tool call
 *   input           a Zod schema. Parse, do not validate (CLAUDE.md §5)
 *   permission      the workspace permission the CALLER must hold AT EXECUTION
 *   brandScope      whether the tool names a brand, and therefore must be scoped
 *   actionClass     READ_ONLY / INTERNAL_REVERSIBLE / EXTERNAL_OR_DESTRUCTIVE
 *   preview         what the customer is shown BEFORE confirming
 *   spendsCredits   whether running it moves money, so the plan can quote it
 *   undoable        whether a compensation contract exists for it
 *
 * THE ACTION CLASS IS A PROPERTY OF THE TOOL, NOT OF THE REQUEST. A natural-
 * language message cannot make a publish internal, and a plan's strictest step
 * decides whether the whole plan needs a confirmation. The database enforces the
 * consequence: a plan whose `highestActionClass` is EXTERNAL_OR_DESTRUCTIVE
 * cannot exist with `requiresConfirmation` false.
 *
 * THE REGISTRY IS CODE AND NOT CONFIGURATION, deliberately and for the same
 * reason the AI task catalogue is: a tool key is what application code and a
 * prompt both name, and an operator renaming one would break the assistant
 * rather than retune it. It is also the security boundary — a configurable tool
 * list is one screen away from a tool nobody reviewed.
 */

/** A localized preview line. The dashboard renders the words from `labelKey`. */
export interface ToolPreviewLine {
  /** A stable machine code. Never customer copy. */
  readonly labelKey: string;
  /** What it is now, where there is a before. */
  readonly before?: string | undefined;
  /** What it would become. */
  readonly after: string;
}

export interface ToolDefinition {
  readonly key: string;
  readonly input: z.ZodTypeAny;
  /** The workspace permission the CALLER must hold, re-checked at execution. */
  readonly permission: string;
  /**
   * Whether the tool acts on a brand.
   *
   * `required` means the argument schema carries a `brandId` that must be inside
   * the caller's BrandScope — asserted as a predicate before the tool runs, and
   * again by the domain service it calls. `none` means the tool touches nothing
   * brand-scoped at all.
   */
  readonly brandScope: 'required' | 'none';
  readonly actionClass: CopilotActionClass;
  /** True when running it reserves AI credits, so the plan can quote a cost. */
  readonly spendsCredits: boolean;
  /**
   * Whether a COMPENSATION CONTRACT exists — an explicit, version-checked way to
   * put things back. False is honest rather than lazy: an already-published post
   * is not undoable by anything this platform can do, and claiming otherwise
   * would be the worst kind of promise.
   */
  readonly undoable: boolean;
  /**
   * The ENTITLEMENT feature key this tool needs, when it needs one.
   *
   * SEPARATE FROM THE PERMISSION, because they answer different questions. A
   * permission is "may THIS PERSON do it"; an entitlement is "does this
   * WORKSPACE's plan include it". A Marketing Manager on a plan without the
   * Copilot holds `copilot.use` and still may not run a plan — and a customer on
   * every plan still needs the permission.
   *
   * The KEY is code and the VALUE is configuration, exactly as the plan quota
   * keys are (CLAUDE.md §2.2): application code asks
   * `entitlements.can(ws, 'ai.copilot')`, and what each plan grants lives in the
   * activated `entitlements` document.
   */
  readonly entitlementKey?: string | undefined;
  /** The i18n key stem for the tool's own name in a plan. */
  readonly messageKey: string;
}

const brandArgument = z.object({ brandId: z.string().uuid() });

/** A bounded free-text field. Every one is capped; none reaches a prompt raw. */
const shortText = z.string().min(1).max(400);

export const COPILOT_TOOLS = [
  // --- A. READ_ONLY --------------------------------------------------------
  //
  // Reads. They still require a permission and still respect BrandScope: a
  // read-only tool that ignored scope would make the Copilot the easiest way in
  // the product to see another brand's numbers.
  {
    key: 'analytics.summary',
    input: brandArgument.extend({
      periodDays: z.number().int().min(1).max(400).default(28),
      compareToPrevious: z.boolean().default(true),
    }),
    permission: 'analytics.read',
    brandScope: 'required',
    actionClass: 'READ_ONLY',
    spendsCredits: false,
    undoable: false,
    messageKey: 'analyticsSummary',
  },
  {
    key: 'brand.context',
    input: brandArgument.extend({ question: shortText }),
    permission: 'brand_brain.read',
    brandScope: 'required',
    actionClass: 'READ_ONLY',
    spendsCredits: false,
    undoable: false,
    messageKey: 'brandContext',
  },
  {
    key: 'content.search',
    input: brandArgument.extend({
      query: z.string().max(200).default(''),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    permission: 'content.read',
    brandScope: 'required',
    actionClass: 'READ_ONLY',
    spendsCredits: false,
    undoable: false,
    messageKey: 'contentSearch',
  },
  {
    key: 'calendar.lookup',
    input: brandArgument.extend({ daysAhead: z.number().int().min(1).max(90).default(14) }),
    permission: 'content.read',
    brandScope: 'required',
    actionClass: 'READ_ONLY',
    spendsCredits: false,
    undoable: false,
    messageKey: 'calendarLookup',
  },
  {
    key: 'campaign.list',
    input: brandArgument,
    permission: 'campaigns.read',
    brandScope: 'required',
    actionClass: 'READ_ONLY',
    spendsCredits: false,
    undoable: false,
    messageKey: 'campaignList',
  },

  // --- B. INTERNAL_REVERSIBLE ----------------------------------------------
  //
  // They change tenant state and they can be put back. Each one has an explicit
  // compensation contract in `undo.ts` — not "run the opposite command and
  // hope" — and each contract refuses when the resource moved underneath it.
  {
    key: 'campaign.create',
    input: brandArgument.extend({
      name: z.string().min(1).max(120),
      objective: z.enum(['AWARENESS', 'ENGAGEMENT', 'TRAFFIC', 'LEADS', 'RETENTION', 'LAUNCH']),
      briefAr: z.string().max(2_000).optional(),
      briefEn: z.string().max(2_000).optional(),
      channels: z.array(z.string().min(1).max(40)).max(10).default([]),
      startDate: z.string().date().optional(),
      endDate: z.string().date().optional(),
    }),
    permission: 'campaigns.manage',
    brandScope: 'required',
    actionClass: 'INTERNAL_REVERSIBLE',
    spendsCredits: false,
    undoable: true,
    entitlementKey: 'ai.copilot',
    messageKey: 'campaignCreate',
  },
  {
    key: 'campaign.update',
    input: brandArgument.extend({
      campaignId: z.string().uuid(),
      name: z.string().min(1).max(120).optional(),
      status: z.enum(['DRAFT', 'PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED']).optional(),
    }),
    permission: 'campaigns.manage',
    brandScope: 'required',
    actionClass: 'INTERNAL_REVERSIBLE',
    spendsCredits: false,
    undoable: true,
    entitlementKey: 'ai.copilot',
    messageKey: 'campaignUpdate',
  },
  {
    key: 'content.draft',
    input: brandArgument.extend({
      brief: z.string().min(1).max(2_000),
      platformKeys: z.array(z.string().min(1).max(40)).min(1).max(6),
      locale: z.enum(['AR', 'EN']).default('EN'),
      campaignId: z.string().uuid().optional(),
    }),
    // `content.create` rather than `content.edit`, because this tool brings a
    // NEW draft into the library rather than changing one that already exists.
    // That it also spends credits is a property of the generation path — see
    // `spendsCredits` below, which is what the confirmation and the budget read.
    permission: 'content.create',
    brandScope: 'required',
    actionClass: 'INTERNAL_REVERSIBLE',
    spendsCredits: true,
    undoable: true,
    entitlementKey: 'ai.copilot',
    messageKey: 'contentDraft',
  },
  {
    key: 'calendar.place',
    input: brandArgument.extend({
      contentItemId: z.string().uuid(),
      /** `YYYY-MM-DDTHH:mm`, in the workspace's own zone. */
      localTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    }),
    permission: 'content.schedule',
    brandScope: 'required',
    actionClass: 'INTERNAL_REVERSIBLE',
    spendsCredits: false,
    undoable: true,
    entitlementKey: 'ai.copilot',
    messageKey: 'calendarPlace',
  },

  // --- C. EXTERNAL_OR_DESTRUCTIVE ------------------------------------------
  //
  // It leaves the platform. CLAUDE.md §2.5 and A-17: the Copilot may PROPOSE and
  // PREVIEW it and must never execute it silently. A natural-language request is
  // not authorization; a fresh, plan-bound, single-use human confirmation is.
  //
  // AND IT IS NOT UNDOABLE, which the registry states rather than implies. A post
  // that has reached a platform is on that platform; this product can ask the
  // platform to delete it where the provider supports deletion, but it cannot
  // undo the fact that it was published. Claiming an undo here would be the one
  // promise this design must never make.
  //
  // THERE IS NO PAYMENT, REFUND, DELETE-WORKSPACE OR DISCONNECT TOOL. Payment
  // belongs to Phase 8 and does not exist; the destructive integration actions
  // exist in the product but not as an assistant's to take, because "disconnect
  // the Instagram account" is a sentence a person can say by accident and a
  // capability nothing in this phase needs.
  {
    key: 'publishing.publish_now',
    input: brandArgument.extend({ contentItemId: z.string().uuid() }),
    permission: 'publishing.manage',
    brandScope: 'required',
    actionClass: 'EXTERNAL_OR_DESTRUCTIVE',
    spendsCredits: false,
    undoable: false,
    entitlementKey: 'ai.copilot',
    messageKey: 'publishNow',
  },
] as const satisfies readonly ToolDefinition[];

export type CopilotToolKey = (typeof COPILOT_TOOLS)[number]['key'];

const BY_KEY = new Map<string, ToolDefinition>(COPILOT_TOOLS.map((tool) => [tool.key, tool]));

export const COPILOT_TOOL_KEYS: readonly string[] = COPILOT_TOOLS.map((tool) => tool.key);

export function findTool(key: string): ToolDefinition | undefined {
  return BY_KEY.get(key);
}

export function isToolKey(key: string): key is CopilotToolKey {
  return BY_KEY.has(key);
}

/**
 * The strictest class in a set of steps.
 *
 * ONE FUNCTION, because the whole confirmation contract turns on it and a second
 * implementation would be a second opinion about whether a plan is dangerous.
 */
export function highestActionClass(keys: readonly string[]): CopilotActionClass {
  let highest: CopilotActionClass = 'READ_ONLY';
  for (const key of keys) {
    const tool = BY_KEY.get(key);
    /*
     * AN UNRECOGNISED KEY IS TREATED AS THE MOST DANGEROUS CLASS, NOT SKIPPED.
     *
     * `createPlan` refuses an unknown tool before this function is reached, so
     * this branch should be unreachable — which is exactly why it must fail
     * CLOSED rather than quietly. Skipping would classify a plan containing
     * something we do not understand as READ_ONLY, and a READ_ONLY plan runs
     * with no confirmation at all. The direction a mistake ships in matters
     * more here than anywhere else in the assistant.
     */
    if (!tool) return 'EXTERNAL_OR_DESTRUCTIVE';
    if (tool.actionClass === 'EXTERNAL_OR_DESTRUCTIVE') return 'EXTERNAL_OR_DESTRUCTIVE';
    if (tool.actionClass === 'INTERNAL_REVERSIBLE') highest = 'INTERNAL_REVERSIBLE';
  }
  return highest;
}

/**
 * Does this plan need a human confirmation before anything runs?
 *
 * TRUE FOR ANYTHING THAT CHANGES STATE, not only for external actions.
 * CLAUDE.md §2.5 requires confirmation for the external class; this product
 * requires it for INTERNAL_REVERSIBLE too, because a customer who typed a
 * sentence and got four drafts and a calendar entry without being asked has been
 * surprised by their own tooling. A read-only plan runs without ceremony, which
 * is the only case where ceremony would be noise.
 */
export function requiresConfirmation(actionClass: CopilotActionClass): boolean {
  return actionClass !== 'READ_ONLY';
}

/**
 * Tools this caller may even be OFFERED, given the permissions they hold.
 *
 * FILTERING THE OFFER IS TIDINESS; THE REFUSAL AT EXECUTION IS THE CONTROL. A
 * plan built for a Viewer would be refused step by step anyway — but offering an
 * action somebody cannot take is the dead button §20 forbids, and hiding it
 * keeps the model from proposing plans that can only fail.
 */
export function availableTools(
  permissionKeys: readonly string[],
  options: {
    /**
     * Is this conversation bound to a brand? A session that is not cannot offer
     * a tool that names one (A2) — there is no brand for the step to name, and
     * letting the model choose one out of the caller's BrandScope is exactly the
     * "the assistant acted on the wrong brand" failure. Defaults to TRUE so the
     * permission-only callers that predate brand binding keep their meaning.
     */
    readonly brandBound?: boolean;
  } = {},
): readonly ToolDefinition[] {
  const held = new Set(permissionKeys);
  const brandBound = options.brandBound ?? true;
  /*
   * WIDENED TO `ToolDefinition[]` ON PURPOSE. Every tool in the registry today
   * declares `brandScope: 'required'`, so the literal type of the array narrows
   * to that one member and TypeScript calls the comparison below unreachable.
   * It is not unreachable; it is a rule about a registry that will gain a
   * workspace-level tool, and the day it does this filter must already be right.
   *
   * IT ALSO MEANS AN UNBOUND SESSION CURRENTLY HAS NO TOOLS AT ALL, and that is
   * the intended, stated contract rather than an accident: a general
   * conversation can ask and answer, and it cannot act on anything until it is
   * admitted to a brand.
   */
  return (COPILOT_TOOLS as readonly ToolDefinition[]).filter(
    (tool) => held.has(tool.permission) && (brandBound || tool.brandScope !== 'required'),
  );
}

/**
 * Every entitlement feature key the Copilot can ask for.
 *
 * Exported so a deployment can see, in one line, exactly which plan features the
 * assistant depends on — and so the seeds that enable features for development
 * have one list to read rather than a registry to walk.
 */
export const COPILOT_ENTITLEMENT_KEYS: readonly string[] = [
  ...new Set(
    (COPILOT_TOOLS as readonly ToolDefinition[]).flatMap((tool) =>
      tool.entitlementKey === undefined ? [] : [tool.entitlementKey],
    ),
  ),
];
