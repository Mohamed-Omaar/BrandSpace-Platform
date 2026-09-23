import type { Prisma, TenantScopedClient } from '@brandspace/database';
import type { AnalyticsQueryService } from '@brandspace/analytics';
import { BrandBrainRetriever } from '@brandspace/brand-brain';
import type {
  CampaignService,
  ContentCalendarService,
  ContentStudioService,
} from '@brandspace/content';
import { type RetentionInput } from '@brandspace/content';
import { brandIdQueryFilter, type Clock } from '@brandspace/shared';
import { copilotPlanNotFound, externalActionUnavailable } from './errors';
import type { LiveAuthorization } from './authorization';
import type { ToolPreviewLine } from './tools';

/**
 * WHERE A TOOL ACTUALLY DOES ITS WORK — and the file that proves the Copilot is
 * an orchestrator rather than a privileged shortcut.
 *
 * EVERY EXECUTOR BELOW CALLS A DOMAIN SERVICE THAT PERFORMS ITS OWN
 * AUTHORIZATION. `content.draft` goes through `ContentStudioService.generate`,
 * which checks BrandScope, enforces the draft ceiling, spends credits through the
 * gateway and refuses for lack of grounding exactly as it does for a person
 * typing in the composer. `calendar.place` goes through
 * `ContentCalendarService.schedule`, which consults the brand's approval policy
 * and the monthly quota. There is no code path here that writes a content row,
 * takes a credit or skips a gate — the Copilot cannot do anything a member could
 * not do by hand, because it does it through the same code they would.
 *
 * THE COMPENSATION IS BUILT BY THE EXECUTOR THAT CAUSED THE CHANGE, at the moment
 * it caused it, and it records the resource VERSION it observed. That is what
 * lets `undo` refuse safely later: the contract says what to restore AND what the
 * world looked like when the promise was made.
 *
 * NOTHING HERE DECIDES WHETHER IT MAY RUN. Permission, BrandScope and entitlement
 * are settled by `PlanExecutionService` before an executor is called, against the
 * LIVE membership. An executor that also checked would be a second, drifting copy
 * of the rule; an executor that checked INSTEAD would put the rule somewhere a
 * new tool could forget it.
 */

/** Everything an executor may reach. Assembled by the caller, never imported. */
export interface ExecutorContext {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly authorization: LiveAuthorization;
  readonly planKey: string | null;
  readonly clock: Clock;
  /** Joins plan → tool call → domain mutation → audit event. */
  readonly correlationId: string;
  /** The idempotency key of THIS tool call, passed down to the domain service. */
  readonly idempotencyKey: string;
  readonly analytics: AnalyticsQueryService;
  readonly campaigns: CampaignService;
  readonly calendar: ContentCalendarService;
  /**
   * The Content Studio. ABSENT ON SURFACES THAT CANNOT SPEND CREDITS: the
   * customer dashboard has no AI Gateway (F-07), so it cannot construct one, and
   * a tool that needs it is simply unavailable there rather than failing at run
   * time in a way a reviewer has to notice.
   */
  readonly studio?: ContentStudioService | undefined;
  /** D-116 / D-117 inputs for anything this tool persists. */
  readonly retention: RetentionInput;
  /**
   * THE ONE DOOR TO AN EXTERNAL ACTION, and it is injected rather than imported.
   *
   * Publishing needs the social connectors, a decrypted customer token and the
   * publish queue — none of which belongs in a package the customer dashboard
   * links against. A surface that was not wired with this port cannot publish at
   * all, which is the F-07 pattern applied to the assistant.
   */
  readonly externalActions?: ExternalActionPort | undefined;
  /**
   * P6-12 — THE AUTOMATIONS DOMAIN, INJECTED. `automation.create_rule` writes
   * through `AutomationEngine.createRule` and nothing else, so every rule the
   * assistant composes meets the pairing, condition, limit and permission
   * checks a person's rule meets. A surface not wired with this port simply
   * cannot compose automations.
   */
  readonly automations?: AutomationRulePort | undefined;
}

/** The slice of `AutomationEngine` the Copilot may reach: creating, never enabling. */
export interface AutomationRulePort {
  createRule(input: {
    readonly brandId: string;
    readonly name: string;
    readonly triggerType: string;
    readonly triggerConfig: unknown;
    readonly conditions: unknown;
    readonly actionType: string;
    readonly actionConfig: unknown;
    /** Always false from the Copilot. Typed as the literal so nothing else fits. */
    readonly enabled: false;
    readonly actor: LiveAuthorization;
  }): Promise<{ readonly id: string; readonly version: number; readonly name: string }>;
}

/**
 * The narrow contract an external action is performed through.
 *
 * DELIBERATELY NARROW. It takes an already-authorized, already-confirmed request
 * and returns what happened. It cannot be used to browse, to cancel, or to reach
 * anything else — a wider port would be a wider capability for the assistant,
 * and the assistant's capabilities are the thing this phase is most careful
 * about.
 */
export interface ExternalActionPort {
  publishNow(input: {
    readonly workspaceId: string;
    readonly brandId: string;
    readonly contentItemId: string;
    readonly actorUserId: string;
    /**
     * THE CONFIRMER'S LIVE SCOPE, AND IT IS NOT OPTIONAL (P7-R3).
     *
     * Both implementations of this port used to build their own calendar with
     * `actorBrandScope: []` and a comment saying the caller had already been
     * authorized. Empty means UNRESTRICTED on this platform, so that line did
     * not "re-check anyway" — it turned the calendar's own brand check off, at
     * the exact call that leaves the product. The port now demands the scope, so
     * an implementation cannot forget to carry it and a reviewer cannot miss
     * that it did.
     *
     * It is `readonly string[]` rather than optional deliberately: a missing
     * field would default to empty, and empty is the permissive value.
     */
    readonly actorBrandScope: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<{ readonly jobsCreated: number; readonly slotId: string }>;
}

export interface ExecutorResult {
  /** Result METADATA only. Never generated content, never a provider payload. */
  readonly result: Prisma.InputJsonValue;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly resourceVersionBefore?: number | undefined;
  readonly resourceVersionAfter?: number | undefined;
  /** The explicit contract for putting this back, when there is one. */
  readonly compensation?: Prisma.InputJsonValue | undefined;
  /** The AI request this step spent, when it spent one. */
  readonly aiRequestId?: string | undefined;
  readonly creditsChargedMilli?: bigint | undefined;
}

export type ToolExecutor = (
  context: ExecutorContext,
  args: Record<string, unknown>,
) => Promise<ExecutorResult>;

/** Build the preview a customer reads before confirming. */
export type ToolPreviewBuilder = (
  context: PreviewContext,
  args: Record<string, unknown>,
) => Promise<readonly ToolPreviewLine[]>;

export interface PreviewContext {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly authorization: LiveAuthorization;
  /**
   * P6-12 — the automations registry's verdict on a proposed rule, INJECTED
   * because this package may not import `@brandspace/automation` (ARCHITECTURE
   * §4.1). Absent means a rule cannot be previewed, and the step is refused:
   * a check that was not wired fails closed rather than waving the rule
   * through to find out at execution.
   */
  readonly automationRules?: AutomationRuleCheck | undefined;
}

/** Is this trigger/action pair real, compatible, and within the caller's authority? */
export interface AutomationRuleCheck {
  admissible(input: {
    readonly triggerType: string;
    readonly actionType: string;
    readonly permissionKeys: readonly string[];
  }): boolean;
}

// ---------------------------------------------------------------------------
// READ_ONLY
// ---------------------------------------------------------------------------

const analyticsSummary: ToolExecutor = async (context, args) => {
  const brandId = String(args['brandId']);
  const periodDays = Number(args['periodDays'] ?? 28);
  const compare = args['compareToPrevious'] !== false;
  const now = context.clock.now();
  const start = new Date(now.getTime() - periodDays * 86_400_000);
  const summary = await context.analytics.summary({
    scope: { brandId },
    period: { start, end: now },
    ...(compare
      ? {
          comparison: {
            start: new Date(start.getTime() - periodDays * 86_400_000),
            end: start,
          },
        }
      : {}),
    brandScope: context.authorization.brandScope,
  });

  /*
   * THE RESULT IS METADATA, AND THE FIGURES ARE THE STORED ONES.
   *
   * A metric with no value is reported as ABSENT with its reason rather than as
   * zero — the same missing-versus-zero discipline the query layer keeps, carried
   * through to what the assistant is allowed to say. An assistant handed `0`
   * would tell the customer they earned nothing.
   */
  return {
    result: {
      freshness: summary.freshness,
      containsMockData: summary.containsMockData,
      metrics: summary.metrics.map((metric) => ({
        metricKey: metric.metricKey,
        value: metric.value === null ? null : metric.value.toString(),
        absent: metric.absent,
        changeMilli: metric.changeMilli,
      })),
    },
  };
};

const brandContext: ToolExecutor = async (context, args) => {
  const retriever = new BrandBrainRetriever({ db: context.db });
  const retrieval = await retriever.retrieve({
    brandId: String(args['brandId']),
    question: String(args['question']),
    options: { maxItems: 10, maxChunks: 4, maxChars: 6_000 },
  });
  /*
   * CITATIONS AND COUNTS, NOT THE KNOWLEDGE ITSELF.
   *
   * The retrieved TEXT goes into the model's context through the gateway's
   * fenced untrusted channel, where it is neutralized. It does not go into a
   * stored tool result, because a tool result is read back into later turns and
   * into an audit trail, and brand knowledge in either is a second copy of the
   * corpus in a place nobody expects one.
   */
  return {
    result: {
      knowledgeItems: retrieval.items.length,
      documentChunks: retrieval.chunks.length,
      insufficient: retrieval.insufficient,
      citations: retrieval.citations.map((citation) => ({
        kind: citation.kind,
        id: citation.id,
        area: citation.area ?? null,
      })),
    },
  };
};

const contentSearch: ToolExecutor = async (context, args) => {
  const items = await context.db.contentItem.findMany({
    where: {
      workspaceId: context.workspaceId,
      deletedAt: null,
      ...brandIdQueryFilter({
        brandId: String(args['brandId']),
        brandScope: context.authorization.brandScope,
      }),
      ...(args['query'] ? { title: { contains: String(args['query']), mode: 'insensitive' } } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: Number(args['limit'] ?? 10),
    select: { id: true, title: true, status: true, campaignId: true },
  });
  return { result: { items } };
};

const calendarLookup: ToolExecutor = async (context, args) => {
  const now = context.clock.now();
  const until = new Date(now.getTime() + Number(args['daysAhead'] ?? 14) * 86_400_000);
  const slots = await context.db.calendarSlot.findMany({
    where: {
      workspaceId: context.workspaceId,
      status: { not: 'CANCELLED' },
      ...brandIdQueryFilter({
        brandId: String(args['brandId']),
        brandScope: context.authorization.brandScope,
      }),
      scheduledAtUtc: { gte: now, lte: until },
    },
    orderBy: { scheduledAtUtc: 'asc' },
    take: 50,
    select: { id: true, scheduledAtUtc: true, status: true, contentItemId: true },
  });
  return {
    result: {
      slots: slots.map((slot) => ({
        id: slot.id,
        scheduledAtUtc: slot.scheduledAtUtc.toISOString(),
        status: slot.status,
        contentItemId: slot.contentItemId,
      })),
    },
  };
};

const campaignList: ToolExecutor = async (context, args) => {
  const campaigns = await context.campaigns.list({
    brandId: String(args['brandId']),
    brandScope: context.authorization.brandScope,
    take: 50,
  });
  return {
    result: {
      campaigns: campaigns.map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        objective: campaign.objective,
      })),
    },
  };
};

// ---------------------------------------------------------------------------
// INTERNAL_REVERSIBLE
// ---------------------------------------------------------------------------

const campaignCreate: ToolExecutor = async (context, args) => {
  const brief =
    args['briefAr'] || args['briefEn']
      ? { ar: String(args['briefAr'] ?? ''), en: String(args['briefEn'] ?? '') }
      : undefined;

  const campaign = await context.campaigns.create({
    brandId: String(args['brandId']),
    name: String(args['name']),
    objective: args['objective'] as never,
    ...(brief ? { brief } : {}),
    channels: (args['channels'] as string[] | undefined) ?? [],
    ...(args['startDate'] ? { startDate: new Date(String(args['startDate'])) } : {}),
    ...(args['endDate'] ? { endDate: new Date(String(args['endDate'])) } : {}),
    // THE TOOL CALL'S OWN KEY. A retried execution returns the first campaign
    // rather than making a second — the duplicate-tool-execution guard, reaching
    // all the way into the domain service rather than stopping at the Copilot.
    idempotencyKey: context.idempotencyKey,
    actor: { userId: context.authorization.userId, brandScope: context.authorization.brandScope },
  });

  return {
    result: { campaignId: campaign.id, name: campaign.name, status: campaign.status },
    resourceType: 'Campaign',
    resourceId: campaign.id,
    resourceVersionAfter: campaign.version,
    /*
     * THE COMPENSATION: archive it, but ONLY if it is still at the version this
     * step left it at and still carries no content. A campaign somebody has
     * since edited or filed posts under is not the campaign this step created,
     * and putting it away would be a second change rather than an undo.
     */
    compensation: {
      kind: 'campaign.archive',
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      requireNoContent: true,
    },
  };
};

const campaignUpdate: ToolExecutor = async (context, args) => {
  const before = await context.campaigns.get(
    String(args['campaignId']),
    context.authorization.brandScope,
  );
  const after = await context.campaigns.update({
    campaignId: before.id,
    ...(args['name'] === undefined ? {} : { name: String(args['name']) }),
    ...(args['status'] === undefined ? {} : { status: args['status'] as never }),
    actor: { userId: context.authorization.userId, brandScope: context.authorization.brandScope },
    reason: 'copilot',
  });
  return {
    result: { campaignId: after.id, status: after.status },
    resourceType: 'Campaign',
    resourceId: after.id,
    resourceVersionBefore: before.version,
    resourceVersionAfter: after.version,
    // Restore the previous values, and only while the version this step produced
    // is still the current one.
    compensation: {
      kind: 'campaign.restore_values',
      campaignId: after.id,
      expectedVersion: after.version,
      previous: { name: before.name, status: before.status },
    },
  };
};

const contentDraft: ToolExecutor = async (context, args) => {
  // A SURFACE THAT CANNOT SPEND CREDITS CANNOT DRAFT. Absent rather than
  // throwing late: the plan builder filters this tool out where the studio is
  // not wired, so the model never proposes a step that cannot run.
  if (!context.studio) throw externalActionUnavailable();

  const generation = await context.studio.generate({
    brandId: String(args['brandId']),
    brief: String(args['brief']),
    locale: (args['locale'] as 'AR' | 'EN') ?? 'EN',
    platformKeys: (args['platformKeys'] as string[]) ?? [],
    idempotencyKey: context.idempotencyKey,
    actorUserId: context.authorization.userId,
    planKey: context.planKey,
    actorBrandScope: context.authorization.brandScope,
    retention: context.retention,
  });

  if (args['campaignId']) {
    await context.campaigns.setContentCampaign({
      contentItemId: generation.item.id,
      campaignId: String(args['campaignId']),
      actor: { userId: context.authorization.userId, brandScope: context.authorization.brandScope },
    });
  }

  return {
    result: {
      contentItemId: generation.item.id,
      variants: generation.variants.length,
      // AC-11.4's discipline, carried through: the citation COUNT, not the text.
      citations: generation.citations.length,
      insufficientKnowledge: generation.insufficientKnowledge,
    },
    resourceType: 'ContentItem',
    resourceId: generation.item.id,
    ...(generation.aiRequestId ? { aiRequestId: generation.aiRequestId } : {}),
    creditsChargedMilli: generation.creditsChargedMilli,
    /*
     * ARCHIVE, NOT DELETE, and only from an undo-safe state. A draft somebody has
     * since submitted for review, approved or scheduled is now part of somebody
     * else's workflow, and taking it away is not an undo.
     */
    compensation: {
      kind: 'content.archive',
      contentItemId: generation.item.id,
      requireStatusIn: ['DRAFT'],
    },
  };
};

const calendarPlace: ToolExecutor = async (context, args) => {
  const view = await context.calendar.schedule({
    contentItemId: String(args['contentItemId']),
    localTime: String(args['localTime']),
    actorUserId: context.authorization.userId,
    actorBrandScope: context.authorization.brandScope,
  });
  return {
    result: {
      slotId: view.slot.id,
      scheduledAtUtc: view.slot.scheduledAtUtc.toISOString(),
      platformKeys: view.slot.platformKeys.length,
    },
    resourceType: 'CalendarSlot',
    resourceId: view.slot.id,
    /*
     * CANCEL THE SLOT — but only while it is still SCHEDULED and still at the
     * instant this step put it at. A slot that has been rescheduled by a person,
     * or that has already started publishing, is past the point where an undo is
     * a restoration rather than an interference.
     */
    compensation: {
      kind: 'calendar.cancel',
      slotId: view.slot.id,
      requireStatusIn: ['SCHEDULED'],
      expectedScheduledAtUtc: view.slot.scheduledAtUtc.toISOString(),
    },
  };
};

// ---------------------------------------------------------------------------
// EXTERNAL_OR_DESTRUCTIVE
// ---------------------------------------------------------------------------

const publishNow: ToolExecutor = async (context, args) => {
  // NO PORT, NO PUBLISH. Honest rather than silent.
  if (!context.externalActions) throw externalActionUnavailable();

  const outcome = await context.externalActions.publishNow({
    workspaceId: context.workspaceId,
    brandId: String(args['brandId']),
    contentItemId: String(args['contentItemId']),
    actorUserId: context.authorization.userId,
    // THE LIVE SCOPE, resolved by `execute` from the membership as it is now.
    actorBrandScope: context.authorization.brandScope,
    idempotencyKey: context.idempotencyKey,
  });

  return {
    result: { jobsCreated: outcome.jobsCreated, slotId: outcome.slotId },
    resourceType: 'CalendarSlot',
    resourceId: outcome.slotId,
    /*
     * NO COMPENSATION, AND THAT IS THE HONEST ANSWER RATHER THAN AN OMISSION.
     *
     * Once a post has reached a platform it is on that platform. Some providers
     * accept a delete and some do not; none of them can undo the fact that it was
     * published, and people may already have seen it. A compensation contract
     * here would be this design's one unkeepable promise, so there is none, and
     * `publishing.publish_now` declares `undoable: false` in the registry so the
     * UI never offers an undo it cannot honour.
     */
  };
};

/**
 * P6-12 — compose an automation rule, DISABLED.
 *
 * `enabled: false` is written here and typed as a literal on the port, so no
 * argument the model produces can turn a rule on: enabling a rule is what makes
 * it act without a person, and that stays a person's decision on the
 * Automations screen. The compensation removes the rule only while it is still
 * disabled and unedited.
 */
const automationCreateRule: ToolExecutor = async (context, args) => {
  if (!context.automations) throw externalActionUnavailable();
  const rule = await context.automations.createRule({
    brandId: String(args['brandId']),
    name: String(args['name']),
    triggerType: String(args['triggerType']),
    triggerConfig: args['triggerConfig'] ?? {},
    conditions: args['conditions'] ?? [],
    actionType: String(args['actionType']),
    actionConfig: args['actionConfig'] ?? {},
    enabled: false,
    actor: context.authorization,
  });
  return {
    result: { ruleId: rule.id, name: rule.name, enabled: false },
    resourceType: 'AutomationRule',
    resourceId: rule.id,
    resourceVersionAfter: rule.version,
    compensation: {
      kind: 'automation.remove',
      ruleId: rule.id,
      expectedVersion: rule.version,
    },
  };
};

export const TOOL_EXECUTORS: Readonly<Record<string, ToolExecutor>> = {
  'analytics.summary': analyticsSummary,
  'brand.context': brandContext,
  'content.search': contentSearch,
  'calendar.lookup': calendarLookup,
  'campaign.list': campaignList,
  'campaign.create': campaignCreate,
  'campaign.update': campaignUpdate,
  'content.draft': contentDraft,
  'calendar.place': calendarPlace,
  'publishing.publish_now': publishNow,
  'automation.create_rule': automationCreateRule,
};

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

/**
 * WHAT THE CUSTOMER READS BEFORE THEY CONFIRM.
 *
 * EVERY LINE IS A `labelKey` AND A VALUE, never a sentence: the dashboard
 * renders the words in the reader's own language, so a bilingual workspace's
 * confirmation dialog is not monolingual in whichever language the model chose.
 *
 * A PREVIEW READS AND NEVER WRITES. It runs before confirmation, which is
 * precisely when nothing may change — a preview with a side effect would make the
 * confirmation dialog the thing it is meant to guard against.
 */
export async function buildPreview(
  context: PreviewContext,
  toolKey: string,
  args: Record<string, unknown>,
): Promise<readonly ToolPreviewLine[]> {
  switch (toolKey) {
    case 'campaign.create':
      return [
        { labelKey: 'copilot.preview.campaignName', after: String(args['name'] ?? '') },
        { labelKey: 'copilot.preview.objective', after: String(args['objective'] ?? '') },
        {
          labelKey: 'copilot.preview.channels',
          after: ((args['channels'] as string[] | undefined) ?? []).join(', '),
        },
      ];
    case 'campaign.update': {
      const existing = await context.db.campaign.findFirst({
        where: {
          id: String(args['campaignId']),
          workspaceId: context.workspaceId,
          ...brandIdQueryFilter({ brandScope: context.authorization.brandScope }),
        },
        select: { name: true, status: true },
      });
      return [
        {
          labelKey: 'copilot.preview.campaignName',
          before: existing?.name ?? undefined,
          after: String(args['name'] ?? existing?.name ?? ''),
        },
        {
          labelKey: 'copilot.preview.status',
          before: existing?.status ?? undefined,
          after: String(args['status'] ?? existing?.status ?? ''),
        },
      ];
    }
    case 'content.draft':
      return [
        { labelKey: 'copilot.preview.brief', after: String(args['brief'] ?? '').slice(0, 200) },
        {
          labelKey: 'copilot.preview.platforms',
          after: ((args['platformKeys'] as string[] | undefined) ?? []).join(', '),
        },
      ];
    case 'calendar.place': {
      const item = await requireTargetItem(context, args);
      return [
        { labelKey: 'copilot.preview.content', after: item.title },
        { labelKey: 'copilot.preview.scheduledFor', after: String(args['localTime'] ?? '') },
      ];
    }
    case 'publishing.publish_now': {
      const item = await requireTargetItem(context, args);
      return [
        { labelKey: 'copilot.preview.content', after: item.title },
        // The preview SAYS what class of action this is, in the dialog, in the
        // reader's language. "Publish" and "draft" must not look alike.
        { labelKey: 'copilot.preview.external', after: 'publish' },
      ];
    }
    case 'automation.create_rule': {
      /*
       * THE PAIRING IS REFUSED AT BUILD TIME, not left to execution. A rule the
       * engine would refuse is not a plan the customer should be asked to
       * confirm; nor is one whose ACTION the caller may not perform — refused in
       * the same 404 shape as every other build-time refusal.
       */
      const triggerType = String(args['triggerType']);
      const actionType = String(args['actionType']);
      if (
        !context.automationRules?.admissible({
          triggerType,
          actionType,
          permissionKeys: context.authorization.permissionKeys,
        })
      ) {
        throw copilotPlanNotFound();
      }
      return [
        { labelKey: 'copilot.preview.ruleName', after: String(args['name'] ?? '') },
        { labelKey: 'copilot.preview.trigger', after: triggerType },
        { labelKey: 'copilot.preview.action', after: actionType },
        {
          labelKey: 'copilot.preview.conditions',
          after: String(((args['conditions'] as unknown[] | undefined) ?? []).length),
        },
        // STATED IN THE DIALOG: the rule is created switched off.
        { labelKey: 'copilot.preview.ruleEnabled', after: 'off' },
      ];
    }
    default:
      // A read-only tool has nothing to preview: it changes nothing, so there is
      // no before and no after to show.
      return [];
  }
}

/**
 * The content item a step targets — or a refusal (P7-R3).
 *
 * THREE THINGS IN ONE PREDICATE, and none of them read first and checked after:
 * the workspace, the caller's LIVE BrandScope, and — the one that was missing —
 * that the item belongs to the BRAND THE STEP NAMED. A plan could previously
 * carry `brandId: A` (which the scope check passed) and `contentItemId` pointing
 * at a B item, and nothing anywhere compared the two.
 *
 * AN EMPTY PREVIEW WAS THE WORST OF THE OPTIONS. The old code rendered
 * `item?.title ?? ''`, so a step aimed at content the caller cannot see produced
 * a plan that looked ordinary with one blank line in it — and the customer
 * confirmed it. A refusal at BUILD time means the plan never exists, which is
 * also when refusing is cheapest.
 *
 * `copilotPlanNotFound()` is the 404-shaped refusal, identical for an item that
 * is out of scope, one that belongs to a different brand, and one that was never
 * there.
 */
async function requireTargetItem(
  context: PreviewContext,
  args: Record<string, unknown>,
): Promise<{ title: string }> {
  const brandId = args['brandId'] === undefined ? undefined : String(args['brandId']);
  const item = await context.db.contentItem.findFirst({
    where: {
      id: String(args['contentItemId']),
      workspaceId: context.workspaceId,
      ...brandIdQueryFilter({ brandId, brandScope: context.authorization.brandScope }),
    },
    select: { title: true },
  });
  if (!item) throw copilotPlanNotFound();
  return { title: item.title };
}
