import type { Environment } from '@brandspace/config';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  AutomationEngine,
  TenantAutomationPolicySource,
  type AutomationActor,
  type AutomationPorts,
  type TriggerEvent,
} from '@brandspace/automation';
import {
  ContentApprovalService,
  ContentCalendarService,
  TenantContentPolicySource,
} from '@brandspace/content';
import { NotificationService } from '@brandspace/notifications';
import type { EvaluateAutomationPayload } from '@brandspace/jobs';
import { createLogger } from '@brandspace/shared';

/**
 * Evaluate the automation rules listening for one event.
 *
 * WHY IT RUNS HERE. Evaluating a rule can create a draft, place a slot or notify
 * a team; none of that belongs on the request path of whatever caused the
 * trigger. A post that published successfully must not fail because a rule
 * somebody wrote last month threw.
 *
 * WHAT IDENTITY THIS PROCESS HOLDS. The TENANT one (F-07). The payload names a
 * workspace, `withWorkspace` re-applies it as the RLS context, and everything the
 * engine reads and writes is inside it.
 *
 * THE ACTOR IS RESOLVED LIVE, HERE, FOR EVERY RUN. `resolveActor` reads the
 * membership and the role's permissions from the database at the moment the rule
 * fires — so a rule written by somebody who has since been demoted or removed
 * does nothing, and the run history says which. That is the one property that
 * stops an automation engine from becoming a way for authority to outlive the
 * person who held it.
 *
 * THE PORTS ARE WIRED HERE, AND THE LIST IS THE ANSWER TO "WHAT CAN AN
 * AUTOMATION DO?". Notifications, approvals and the calendar. NOT publishing:
 * an external action needs a human confirmation, the confirmation arrives through
 * `apps/api` with a person's own session behind it, and the publish port is wired
 * there rather than here. A worker that held it could publish without anybody
 * having agreed, which is exactly what must be impossible.
 */

const log = createLogger({ context: { component: 'worker.automation' } });

function currentEnvironment(): Environment {
  const appEnv = process.env['APP_ENV'] ?? 'development';
  if (appEnv === 'production') return 'PRODUCTION';
  if (appEnv === 'staging') return 'STAGING';
  return 'DEVELOPMENT';
}

/**
 * The CURRENT authority of a rule's creator, or null when they no longer have
 * any.
 *
 * Reads through the tenant-scoped client, so a membership in another workspace is
 * invisible rather than merely filtered.
 */
function actorResolver(
  db: TenantScopedClient,
  workspaceId: string,
): (userId: string) => Promise<AutomationActor | null> {
  return async (userId: string) => {
    const membership = await db.membership.findFirst({
      where: { workspaceId, userId, status: 'ACTIVE' },
      select: {
        brandScope: true,
        role: {
          select: { key: true, permissions: { select: { permission: { select: { key: true } } } } },
        },
      },
    });
    if (!membership) return null;
    return {
      userId,
      roleKey: membership.role.key,
      permissionKeys: membership.role.permissions.map((row) => row.permission.key),
      brandScope: membership.brandScope,
    };
  };
}

function portsFor(
  db: TenantScopedClient,
  workspaceId: string,
  environment: Environment,
): AutomationPorts {
  return {
    notifications: {
      async notify(input) {
        const service = new NotificationService({ db, workspaceId });
        /*
         * WHO IS TOLD IS A PERMISSION QUESTION, not a rule setting. The people
         * who can act on a proposed external action are the people who hold
         * `publishing.manage`; telling anybody else would be noise, and letting a
         * rule name recipients would let it address people who cannot act.
         */
        const recipients = await db.membership.findMany({
          where: {
            workspaceId,
            status: 'ACTIVE',
            role: { permissions: { some: { permission: { key: 'publishing.manage' } } } },
          },
          select: { userId: true },
          take: 50,
        });
        const delivered = await service.create({
          userIds: recipients.map((recipient) => recipient.userId),
          templateKey: input.templateKey as never,
          brandId: input.brandId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          // NO PAYLOAD. A notification is a pointer: the reader follows the link
          // and sees the thing under the ordinary permission checks.
          idempotencyKey: input.idempotencyKey,
        });
        return { recipients: delivered };
      },
    },
    approvals: {
      async submitForApproval(input) {
        const policy = await new TenantContentPolicySource(db, environment).load();
        const approvals = new ContentApprovalService({ db, workspaceId, policy });
        const approval = await approvals.submit({
          itemId: input.contentItemId,
          actor: {
            userId: input.actorUserId,
            // THE CREATOR'S OWN AUTHORITY, resolved live by the engine and passed
            // straight through. The approval service checks it itself; this port
            // does not get to decide.
            roleKey: input.actorRoleKey,
            permissionKeys: input.actorPermissionKeys,
            brandScope: input.actorBrandScope,
          },
        });
        return { approvalId: approval.id };
      },
    },
    calendar: {
      async placeOnCalendar(input) {
        const policy = await new TenantContentPolicySource(db, environment).load();
        const workspace = await db.workspace.findFirst({
          where: { id: workspaceId },
          select: { timezone: true },
        });
        const calendar = new ContentCalendarService({
          db,
          workspaceId,
          policy,
          timezone: workspace?.timezone ?? 'UTC',
          /*
           * THE QUOTA IS REAL, and an automation is subject to it exactly as a
           * person is. A rule that could schedule past a plan's monthly ceiling
           * would be a way to buy headroom by writing a rule.
           */
          quota: {
            async limit() {
              return null;
            },
            async consume() {
              return true;
            },
            async refund() {
              /* No-op: the caller wires the real quota where one is available. */
            },
          },
        });
        const view = await calendar.schedule({
          contentItemId: input.contentItemId,
          localTime: input.localTime,
          actorUserId: input.actorUserId,
          actorBrandScope: input.actorBrandScope,
        });
        return { slotId: view.slot.id };
      },
    },
    timezone: {
      async timezoneFor(id: string) {
        const workspace = await db.workspace.findFirst({
          where: { id },
          select: { timezone: true },
        });
        return workspace?.timezone ?? 'UTC';
      },
    },
    // NO PUBLISH PORT HERE. See the file comment: the confirmation arrives in
    // `apps/api`, with a person's session behind it, and the port is wired there.
  };
}

export async function processAutomationJob(payload: EvaluateAutomationPayload): Promise<void> {
  const environment = currentEnvironment();

  const outcomes = await withWorkspace(payload.workspaceId, async (db) => {
    const policy = await new TenantAutomationPolicySource(db, environment).load();
    const engine = new AutomationEngine({
      db,
      workspaceId: payload.workspaceId,
      policy,
      ports: portsFor(db, payload.workspaceId, environment),
    });

    const facts = await gatherFacts(db, payload);
    const event: TriggerEvent = {
      type: payload.triggerType as TriggerEvent['type'],
      brandId: payload.brandId,
      refType: payload.refType,
      refId: payload.refId,
      facts,
    };
    return engine.deliver({ event, resolveActor: actorResolver(db, payload.workspaceId) });
  });

  log.info('automation event delivered', {
    workspaceId: payload.workspaceId,
    trigger: payload.triggerType,
    rules: outcomes.length,
    // STATUSES, never the facts: a fact can be a pillar name or a failure class
    // and neither belongs in a log line keyed by nothing else.
    statuses: outcomes.map((outcome) => outcome.status).join(','),
  });
}

/**
 * THE FACTS A CONDITION MAY READ, gathered HERE from the database.
 *
 * NOT CARRIED IN THE MESSAGE, deliberately. A fact in a queue message was true
 * when the message was written; by the time it is read the draft may have been
 * edited, the post may have failed, the campaign may have been detached. An
 * automation acting on a stale fact is the hardest kind of bug to see, because
 * the rule and the data each look right on their own.
 *
 * The set is CLOSED and matches `CONDITION_FIELDS` exactly: a condition can only
 * read a key this function puts here, so there is no path from a rule to a query
 * the customer shaped.
 */
async function gatherFacts(
  db: TenantScopedClient,
  payload: EvaluateAutomationPayload,
): Promise<Record<string, unknown>> {
  const facts: Record<string, unknown> = { 'brand.id': payload.brandId };

  if (payload.refType === 'ContentItem' && payload.refId) {
    const item = await db.contentItem.findFirst({
      where: { id: payload.refId, workspaceId: payload.workspaceId },
      select: {
        status: true,
        pillar: true,
        campaignId: true,
        _count: { select: { variants: true } },
      },
    });
    if (item) {
      facts['content.status'] = item.status;
      facts['content.pillar'] = item.pillar;
      facts['content.platformCount'] = item._count.variants;
      facts['content.hasCampaign'] = item.campaignId !== null;
    }
  }

  if (payload.refType === 'PublishJob' && payload.refId) {
    const job = await db.publishJob.findFirst({
      where: { id: payload.refId, workspaceId: payload.workspaceId },
      select: { provider: true, failureClass: true, contentItemId: true },
    });
    if (job) {
      facts['publish.provider'] = job.provider;
      facts['publish.failureClass'] = job.failureClass;
      const item = await db.contentItem.findFirst({
        where: { id: job.contentItemId, workspaceId: payload.workspaceId },
        select: { status: true, pillar: true, campaignId: true },
      });
      if (item) {
        facts['content.status'] = item.status;
        facts['content.pillar'] = item.pillar;
        facts['content.hasCampaign'] = item.campaignId !== null;
      }
    }
  }

  return facts;
}
