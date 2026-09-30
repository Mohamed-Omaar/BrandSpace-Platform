import { randomUUID } from 'node:crypto';
import type { AutomationRule, PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { isAppError } from '@brandspace/shared';
import {
  AutomationEngine,
  parseAutomationPolicy,
  type AutomationActor,
  type AutomationPolicy,
} from '@brandspace/automation';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import { seedStoredRule } from './stored-automation-rule';

/**
 * PHASE 2B-3, PR 2 — THE G13 AUTHORING CONTRACT, AGAINST REAL POSTGRESQL.
 *
 *   - The person a NOTIFY_PERSON rule names must be an ACTIVE member whose
 *     BrandScope admits the rule's brand; the campaign an ADD_TO_CAMPAIGN rule
 *     names must be a live campaign of the rule's brand. Anything else is
 *     refused shaped like a genuine miss (NOT_FOUND, D-132) and nothing is
 *     stored.
 *   - A G13 rule names only the G13 conditions for its trigger; a rule on a
 *     pre-G13 action keeps the whole produced table.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;
let otherBrandId: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

function actor(): AutomationActor {
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
  };
}

const engine = (db: TenantScopedClient) =>
  new AutomationEngine({ db, workspaceId: fixtures.a.workspaceId, policy, ports: {} });

/** A member of `workspaceId`; `null` scope writes no value — every brand. */
async function member(
  workspaceId: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'INVITED',
  brandScope: string[] | null,
): Promise<string> {
  const user = await platform.user.create({
    data: {
      email: `pr2-target-${randomUUID()}@example.test`,
      name: `Target ${randomUUID().slice(0, 6)}`,
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
      workspaceId,
      userId: user.id,
      roleId: role.id,
      status,
      ...(brandScope === null ? {} : { brandScope }),
    },
  });
  return user.id;
}

async function campaign(input: { brandId: string; deleted?: boolean }): Promise<string> {
  const row = await inA((db) =>
    db.campaign.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: input.brandId,
        name: `pr2 target ${randomUUID().slice(0, 8)}`,
        objective: 'AWARENESS',
        status: 'DRAFT',
        createdByUserId: fixtures.a.userId,
        ...(input.deleted ? { deletedAt: new Date() } : {}),
      },
      select: { id: true },
    }),
  );
  return row.id;
}

async function g13Rule(
  actionType: 'NOTIFY_PERSON' | 'ADD_TO_CAMPAIGN' | 'MAKE_DRAFT_COPY',
  actionConfig: Record<string, unknown>,
): Promise<AutomationRule> {
  return inA((db) =>
    seedStoredRule(db, {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      name: `pr2 authoring ${randomUUID().slice(0, 8)}`,
      triggerType: 'CONTENT_APPROVED',
      actionType,
      actionConfig,
      createdByUserId: fixtures.a.userId,
    }),
  );
}

/** Edit the action's settings; the code, or OK. */
async function retarget(rule: AutomationRule, actionConfig: Record<string, unknown>) {
  try {
    await inA((db) =>
      engine(db).updateEditableRule({
        ruleId: rule.id,
        expectedVersion: rule.version,
        actionConfig,
        actor: actor(),
      }),
    );
    return 'OK';
  } catch (error: unknown) {
    return isAppError(error) ? error.code : `UNEXPECTED:${String(error)}`;
  }
}

const storedConfig = (ruleId: string) =>
  inA(
    async (db) =>
      (await db.automationRule.findFirstOrThrow({ where: { id: ruleId } })).actionConfig,
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
          slug: `pr2-other-${randomUUID().slice(0, 8)}`,
          name: 'PR 2 other',
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
      where: { workspaceId: fixtures.a.workspaceId, name: { startsWith: 'pr2 authoring' } },
      data: { deletedAt: new Date(), enabled: false },
    }),
  );
});

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('the person NOTIFY_PERSON names', () => {
  it('an ACTIVE member whose scope admits the brand — unrestricted, unset, or naming it', async () => {
    const start = await member(fixtures.a.workspaceId, 'ACTIVE', []);
    const rule = await g13Rule('NOTIFY_PERSON', { userId: start });
    for (const scope of [[], null, [fixtures.a.brandId]]) {
      const userId = await member(fixtures.a.workspaceId, 'ACTIVE', scope);
      const current = await inA((db) =>
        db.automationRule.findFirstOrThrow({ where: { id: rule.id } }),
      );
      expect(await retarget(current, { userId })).toBe('OK');
      expect(await storedConfig(rule.id)).toEqual({ userId });
    }
  });

  it('anyone else is NOT_FOUND, and the stored person is unchanged', async () => {
    const keep = await member(fixtures.a.workspaceId, 'ACTIVE', []);
    const rule = await g13Rule('NOTIFY_PERSON', { userId: keep });
    const refused = [
      await member(fixtures.a.workspaceId, 'SUSPENDED', []),
      await member(fixtures.a.workspaceId, 'INVITED', []),
      await member(fixtures.a.workspaceId, 'ACTIVE', [otherBrandId]),
      await member(fixtures.b.workspaceId, 'ACTIVE', []),
      fixtures.b.userId,
      randomUUID(),
    ];
    for (const userId of refused) {
      expect(await retarget(rule, { userId })).toBe('NOT_FOUND');
      expect(await storedConfig(rule.id)).toEqual({ userId: keep });
    }
  });

  it('a value that is not a member id at all is refused by the schema', async () => {
    const keep = await member(fixtures.a.workspaceId, 'ACTIVE', []);
    const rule = await g13Rule('NOTIFY_PERSON', { userId: keep });
    expect(await retarget(rule, { userId: 'everyone' })).not.toBe('OK');
    expect(await storedConfig(rule.id)).toEqual({ userId: keep });
  });
});

describe('the campaign ADD_TO_CAMPAIGN names', () => {
  it('a live campaign of the rule’s brand is accepted', async () => {
    const first = await campaign({ brandId: fixtures.a.brandId });
    const rule = await g13Rule('ADD_TO_CAMPAIGN', { campaignId: first });
    const next = await campaign({ brandId: fixtures.a.brandId });
    expect(await retarget(rule, { campaignId: next })).toBe('OK');
    expect(await storedConfig(rule.id)).toEqual({ campaignId: next });
  });

  it('another brand’s, a deleted one, another workspace’s, or none is NOT_FOUND', async () => {
    const keep = await campaign({ brandId: fixtures.a.brandId });
    const rule = await g13Rule('ADD_TO_CAMPAIGN', { campaignId: keep });
    const refused = [
      await campaign({ brandId: otherBrandId }),
      await campaign({ brandId: fixtures.a.brandId, deleted: true }),
      fixtures.b.campaignId,
      randomUUID(),
    ];
    for (const campaignId of refused) {
      expect(await retarget(rule, { campaignId })).toBe('NOT_FOUND');
      expect(await storedConfig(rule.id)).toEqual({ campaignId: keep });
    }
  });
});

describe('the conditions a rule may name', () => {
  const setConditions = async (rule: AutomationRule, conditions: unknown) => {
    try {
      await inA((db) => engine(db).updateRule({ ruleId: rule.id, conditions, actor: actor() }));
      return 'OK';
    } catch (error: unknown) {
      return isAppError(error) ? error.code : `UNEXPECTED:${String(error)}`;
    }
  };

  it('a G13 rule names the G13 fields and nothing beyond them', async () => {
    const rule = await g13Rule('MAKE_DRAFT_COPY', {});
    expect(
      await setConditions(rule, [
        { field: 'content.channels', operator: 'includes', value: 'INSTAGRAM' },
        { field: 'content.hasCampaign', operator: 'is_false' },
        { field: 'content.type', operator: 'in', value: ['POST', 'REEL'] },
      ]),
    ).toBe('OK');
    for (const field of ['content.status', 'content.pillar', 'brand.id']) {
      expect(await setConditions(rule, [{ field, operator: 'equals', value: 'x' }]), field).toBe(
        'VALIDATION_FAILED',
      );
    }
    expect(
      await setConditions(rule, [
        { field: 'content.platformCount', operator: 'greater_than', value: 1 },
      ]),
    ).toBe('VALIDATION_FAILED');
  });

  it('a stored rule on a pre-G13 action keeps every field its trigger produces', async () => {
    const rule = await inA((db) =>
      seedStoredRule(db, {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        name: `pr2 authoring legacy ${randomUUID().slice(0, 8)}`,
        triggerType: 'CONTENT_APPROVED',
        actionType: 'PLACE_ON_CALENDAR',
        actionConfig: { offsetHours: 24 },
        createdByUserId: fixtures.a.userId,
      }),
    );
    expect(
      await setConditions(rule, [
        { field: 'content.status', operator: 'in', value: ['APPROVED'] },
        { field: 'content.platformCount', operator: 'greater_than', value: 1 },
      ]),
    ).toBe('OK');
  });
});
