import { randomUUID } from 'node:crypto';
import type { AutomationRule, PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { closeQueues, EVALUATE_AUTOMATION } from '@brandspace/jobs';
import { isAppError } from '@brandspace/shared';
import {
  AutomationEngine,
  parseAutomationPolicy,
  type AutomationActor,
  type AutomationPolicy,
} from '@brandspace/automation';
import { ContentApprovalService, parseContentPolicy } from '@brandspace/content';
import { processAutomationJob } from '../../apps/worker/src/processors/automation';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2B-3, PR 2 — THE G13 ACTIONS, WRITTEN THROUGH `createRule` AND RUN
 * THROUGH THE REAL WORKER PROCESSOR, AGAINST REAL POSTGRESQL.
 *
 * Every action runs under the rule creator's LIVE authority, re-resolved on the
 * run, and re-checks what it names (a person, a campaign) with the predicate
 * the save used. A redelivery of the same event is the same run.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;
let otherBrandId: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

function author(overrides: Partial<AutomationActor> = {}): AutomationActor {
  return {
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: [
      'workspace.read',
      'automation.manage',
      'content.create',
      'content.schedule',
      'campaigns.manage',
    ],
    brandScope: [],
    ...overrides,
  };
}

const engine = (db: TenantScopedClient) =>
  new AutomationEngine({ db, workspaceId: fixtures.a.workspaceId, policy, ports: {} });

async function member(
  status: 'ACTIVE' | 'SUSPENDED',
  brandScope: string[] | null,
): Promise<string> {
  const user = await platform.user.create({
    data: {
      email: `pr2-actions-${randomUUID()}@example.test`,
      name: `Actions ${randomUUID().slice(0, 6)}`,
      timezone: 'UTC',
    },
    select: { id: true },
  });
  const role = await platform.role.findFirstOrThrow({
    where: { key: 'content_creator', workspaceId: null },
    select: { id: true },
  });
  await platform.membership.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      userId: user.id,
      roleId: role.id,
      status,
      ...(brandScope === null ? {} : { brandScope }),
    },
  });
  return user.id;
}

async function post(status: 'APPROVED' | 'DRAFT' = 'APPROVED'): Promise<string> {
  return inA(async (db) => {
    const item = await db.contentItem.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        title: `PR 2 actions ${randomUUID().slice(0, 8)}`,
        primaryLocale: 'EN',
        status,
        createdByUserId: fixtures.a.userId,
      },
    });
    await db.contentVariant.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: 'A caption.',
        characterCount: 10,
        validationState: 'VALID',
      },
    });
    return item.id;
  });
}

async function createRule(input: {
  actionType: string;
  actionConfig: Record<string, unknown>;
  triggerType?: string;
}): Promise<AutomationRule> {
  return inA((db) =>
    engine(db).createRule({
      brandId: fixtures.a.brandId,
      name: `pr2 actions ${randomUUID().slice(0, 8)}`,
      triggerType: (input.triggerType ?? 'CONTENT_APPROVED') as never,
      triggerConfig: {},
      conditions: [],
      actionType: input.actionType as never,
      actionConfig: input.actionConfig,
      enabled: true,
      actor: author(),
    }),
  );
}

async function refusalOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'OK';
  } catch (error: unknown) {
    return isAppError(error) ? error.code : `UNEXPECTED:${String(error)}`;
  }
}

/** A CONTENT_APPROVED event about `itemId`, through the worker, `times` deliveries. */
async function approve(itemId: string, times = 1): Promise<void> {
  const approvalId = randomUUID();
  const event = await inA((db) =>
    db.automationEvent.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        triggerType: 'CONTENT_APPROVED',
        refType: 'ContentItem',
        refId: itemId,
        dedupeKey: `CONTENT_APPROVED:${approvalId}`,
        dispatchedAt: new Date(),
      },
    }),
  );
  for (let delivery = 0; delivery < times; delivery += 1) {
    await processAutomationJob({
      kind: EVALUATE_AUTOMATION,
      workspaceId: fixtures.a.workspaceId,
      idempotencyKey: `automation-event-${event.id}`,
      eventId: event.id,
      eventKey: event.dedupeKey,
      brandId: fixtures.a.brandId,
      triggerType: 'CONTENT_APPROVED',
      refType: 'ContentItem',
      refId: itemId,
      ruleId: null,
      occurrence: null,
    });
  }
}

const runsOf = (ruleId: string) =>
  inA((db) =>
    db.automationRun.findMany({
      where: { ruleId },
      select: { status: true, failureCode: true, resourceType: true, resourceId: true },
    }),
  );

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseAutomationPolicy(defaultPayload('automations'));
  otherBrandId = (
    await inA((db) =>
      db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          slug: `pr2-actions-other-${randomUUID().slice(0, 8)}`,
          name: 'PR 2 actions other',
          status: 'ACTIVE',
        },
        select: { id: true },
      }),
    )
  ).id;
}, 60_000);

afterEach(async () => {
  await inA((db) =>
    db.automationRule.updateMany({
      where: { workspaceId: fixtures.a.workspaceId, name: { startsWith: 'pr2 actions' } },
      data: { deletedAt: new Date(), enabled: false },
    }),
  );
});

afterAll(async () => {
  await closeQueues();
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('NOTIFY_PERSON — notify a chosen person (D4)', () => {
  const noticesFor = (userId: string) =>
    inA((db) =>
      db.notification.findMany({
        where: { userId, templateKey: 'automation.notice' },
        select: { payload: true, linkPath: true, resourceType: true, resourceId: true },
      }),
    );

  it('the named member gets one automation.notice — no payload, no link — and nobody else', async () => {
    const person = await member('ACTIVE', [fixtures.a.brandId]);
    const rule = await createRule({
      actionType: 'NOTIFY_PERSON',
      actionConfig: { userId: person },
    });
    const itemId = await post();
    await approve(itemId, 2);
    const runs = await inA((db) =>
      db.automationRun.findMany({ where: { ruleId: rule.id }, select: { id: true, status: true } }),
    );
    expect(runs.map((run) => run.status)).toEqual(['SUCCEEDED']);
    expect(await noticesFor(person)).toEqual([
      { payload: {}, linkPath: null, resourceType: 'ContentItem', resourceId: itemId },
    ]);
    // Everything THIS run wrote went to that one person. (Another enabled rule
    // of the fixture workspace may notify its own recipients about the event.)
    const written = await inA((db) =>
      db.notification.findMany({
        where: { idempotencyKey: { startsWith: `automation-run:${runs[0]?.id}:` } },
        select: { userId: true },
      }),
    );
    expect(written).toEqual([{ userId: person }]);
  });

  it('a member who muted automations is not notified, and the run still succeeds', async () => {
    const person = await member('ACTIVE', []);
    await platform.notificationPreference.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: person,
        category: 'automations',
        enabled: false,
      },
    });
    const rule = await createRule({
      actionType: 'NOTIFY_PERSON',
      actionConfig: { userId: person },
    });
    await approve(await post());
    expect((await runsOf(rule.id)).map((run) => run.status)).toEqual(['SUCCEEDED']);
    expect(await noticesFor(person)).toEqual([]);
  });

  it('a member who left or lost the brand after the rule was saved: BLOCKED, nobody told', async () => {
    for (const change of ['suspended', 'rescoped'] as const) {
      const person = await member('ACTIVE', []);
      const rule = await createRule({
        actionType: 'NOTIFY_PERSON',
        actionConfig: { userId: person },
      });
      await platform.membership.updateMany({
        where: { workspaceId: fixtures.a.workspaceId, userId: person },
        data: change === 'suspended' ? { status: 'SUSPENDED' } : { brandScope: [otherBrandId] },
      });
      await approve(await post());
      expect(await runsOf(rule.id), change).toEqual([
        {
          status: 'BLOCKED_BY_POLICY',
          failureCode: 'recipient_unavailable',
          resourceType: null,
          resourceId: null,
        },
      ]);
      expect(await noticesFor(person), change).toEqual([]);
    }
  });

  it('a person who cannot be named is refused at save, shaped like a miss', async () => {
    const outside = await member('ACTIVE', [otherBrandId]);
    for (const userId of [outside, fixtures.b.userId, randomUUID()]) {
      expect(
        await refusalOf(() =>
          createRule({ actionType: 'NOTIFY_PERSON', actionConfig: { userId } }),
        ),
      ).toBe('NOT_FOUND');
    }
  });

  it('pairs with CONTENT_APPROVED, POST_PUBLISHED and POST_FAILED — and nothing else', async () => {
    const person = await member('ACTIVE', []);
    for (const triggerType of ['POST_PUBLISHED', 'POST_FAILED']) {
      expect(
        await refusalOf(() =>
          createRule({
            actionType: 'NOTIFY_PERSON',
            actionConfig: { userId: person },
            triggerType,
          }),
        ),
        triggerType,
      ).toBe('OK');
    }
    expect(
      await refusalOf(() =>
        createRule({
          actionType: 'NOTIFY_PERSON',
          actionConfig: { userId: person },
          triggerType: 'CONTENT_SCHEDULED',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('a creator who lost workspace.read is blocked before anyone is told', async () => {
    const person = await member('ACTIVE', []);
    const rule = await createRule({
      actionType: 'NOTIFY_PERSON',
      actionConfig: { userId: person },
    });
    const outcome = await inA((db) =>
      new AutomationEngine({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy,
        ports: {
          notifications: {
            notify: async () => ({ recipients: 0 }),
            notifyPerson: async () => {
              throw new Error('must not be called');
            },
          },
        },
      }).run({
        rule,
        event: {
          type: 'CONTENT_APPROVED',
          brandId: fixtures.a.brandId,
          refType: 'ContentItem',
          refId: fixtures.a.contentItemId,
          eventKey: `CONTENT_APPROVED:${randomUUID()}`,
          facts: {},
        },
        resolveActor: async () => author({ permissionKeys: ['automation.manage'] }),
      }),
    );
    expect(outcome.status).toBe('BLOCKED_BY_AUTHORIZATION');
    expect(outcome.run?.failureCode).toBe('creator_lost_permission');
  });
});

describe('ADD_TO_CAMPAIGN — add to a campaign, attach-only (D8)', () => {
  async function campaign(input: { brandId?: string } = {}): Promise<string> {
    const row = await inA((db) =>
      db.campaign.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: input.brandId ?? fixtures.a.brandId,
          name: `pr2 actions campaign ${randomUUID().slice(0, 8)}`,
          objective: 'AWARENESS',
          status: 'ACTIVE',
          createdByUserId: fixtures.a.userId,
        },
        select: { id: true },
      }),
    );
    return row.id;
  }
  const itemRow = (itemId: string) =>
    inA((db) =>
      db.contentItem.findUniqueOrThrow({
        where: { id: itemId },
        select: { campaignId: true, status: true },
      }),
    );

  it('a post with no campaign is attached to the configured one, and it is audited', async () => {
    const campaignId = await campaign();
    const rule = await createRule({ actionType: 'ADD_TO_CAMPAIGN', actionConfig: { campaignId } });
    const itemId = await post();
    await approve(itemId, 2);
    expect(await runsOf(rule.id)).toEqual([
      { status: 'SUCCEEDED', failureCode: null, resourceType: 'ContentItem', resourceId: itemId },
    ]);
    expect((await itemRow(itemId)).campaignId).toBe(campaignId);
    const audit = await inA((db) =>
      db.auditEvent.count({ where: { action: 'campaign.content_attached', resourceId: itemId } }),
    );
    expect(audit).toBe(1);
  });

  it('a post already in a campaign is SKIPPED and keeps its campaign', async () => {
    const own = await campaign();
    const configured = await campaign();
    const rule = await createRule({
      actionType: 'ADD_TO_CAMPAIGN',
      actionConfig: { campaignId: configured },
    });
    const itemId = await post();
    await inA((db) => db.contentItem.update({ where: { id: itemId }, data: { campaignId: own } }));
    await approve(itemId);
    expect((await runsOf(rule.id))[0]).toMatchObject({
      status: 'SKIPPED',
      failureCode: 'already_in_campaign',
    });
    expect((await itemRow(itemId)).campaignId).toBe(own);
  });

  it('a post waiting for review is SKIPPED content_in_review: no change, the review stays open', async () => {
    const campaignId = await campaign();
    const rule = await createRule({ actionType: 'ADD_TO_CAMPAIGN', actionConfig: { campaignId } });
    const itemId = await post('DRAFT');
    const approval = await inA((db) =>
      new ContentApprovalService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: parseContentPolicy(defaultPayload('content')),
      }).submit({
        itemId,
        actor: {
          userId: fixtures.a.userId,
          roleKey: 'workspace_owner',
          permissionKeys: ['content.read', 'content.submit'],
          brandScope: [],
        },
      }),
    );
    await approve(itemId);
    expect((await runsOf(rule.id))[0]).toMatchObject({
      status: 'SKIPPED',
      failureCode: 'content_in_review',
    });
    expect(await itemRow(itemId)).toEqual({ campaignId: null, status: 'IN_REVIEW' });
    const stillOpen = await inA((db) =>
      db.approval.findUniqueOrThrow({ where: { id: approval.id }, select: { status: true } }),
    );
    expect(stillOpen.status).toBe('PENDING');
  });

  it('a post publishing or published is SKIPPED content_not_editable', async () => {
    const campaignId = await campaign();
    const rule = await createRule({ actionType: 'ADD_TO_CAMPAIGN', actionConfig: { campaignId } });
    const itemId = await post();
    await inA((db) =>
      db.contentItem.update({ where: { id: itemId }, data: { status: 'PUBLISHED' } }),
    );
    await approve(itemId);
    expect((await runsOf(rule.id))[0]).toMatchObject({
      status: 'SKIPPED',
      failureCode: 'content_not_editable',
    });
    expect((await itemRow(itemId)).campaignId).toBeNull();
  });

  it('the configured campaign deleted after the rule was saved: BLOCKED campaign_unavailable', async () => {
    const campaignId = await campaign();
    const rule = await createRule({ actionType: 'ADD_TO_CAMPAIGN', actionConfig: { campaignId } });
    await inA((db) =>
      db.campaign.update({ where: { id: campaignId }, data: { deletedAt: new Date() } }),
    );
    const itemId = await post();
    await approve(itemId);
    expect((await runsOf(rule.id))[0]).toMatchObject({
      status: 'BLOCKED_BY_POLICY',
      failureCode: 'campaign_unavailable',
    });
    expect((await itemRow(itemId)).campaignId).toBeNull();
  });

  it('a campaign of another brand or workspace is refused at save, shaped like a miss', async () => {
    for (const campaignId of [await campaign({ brandId: otherBrandId }), fixtures.b.campaignId]) {
      expect(
        await refusalOf(() =>
          createRule({ actionType: 'ADD_TO_CAMPAIGN', actionConfig: { campaignId } }),
        ),
      ).toBe('NOT_FOUND');
    }
  });

  it('either content.create or campaigns.manage is enough; neither blocks the run', async () => {
    const campaignId = await campaign();
    const rule = await createRule({ actionType: 'ADD_TO_CAMPAIGN', actionConfig: { campaignId } });
    const attached: string[] = [];
    const run = (permissionKeys: string[]) =>
      inA((db) =>
        new AutomationEngine({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy,
          ports: {
            campaigns: {
              addToCampaign: async (input) => {
                attached.push(input.contentItemId);
                return { kind: 'attached' };
              },
            },
          },
        }).run({
          rule,
          event: {
            type: 'CONTENT_APPROVED',
            brandId: fixtures.a.brandId,
            refType: 'ContentItem',
            refId: fixtures.a.contentItemId,
            eventKey: `CONTENT_APPROVED:${randomUUID()}`,
            facts: {},
          },
          resolveActor: async () => author({ permissionKeys }),
        }),
      );
    expect((await run(['content.create'])).status).toBe('SUCCEEDED');
    expect((await run(['campaigns.manage'])).status).toBe('SUCCEEDED');
    const neither = await run(['workspace.read', 'automation.manage']);
    expect(neither.status).toBe('BLOCKED_BY_AUTHORIZATION');
    expect(neither.run?.failureCode).toBe('creator_lost_permission');
    expect(attached).toHaveLength(2);
  });

  it('pairs with CONTENT_APPROVED only', async () => {
    const campaignId = await campaign();
    for (const triggerType of ['POST_PUBLISHED', 'POST_FAILED']) {
      expect(
        await refusalOf(() =>
          createRule({ actionType: 'ADD_TO_CAMPAIGN', actionConfig: { campaignId }, triggerType }),
        ),
        triggerType,
      ).toBe('VALIDATION_FAILED');
    }
  });
});
