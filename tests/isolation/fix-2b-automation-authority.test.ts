import { randomUUID } from 'node:crypto';
import type { AutomationRule, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { isAppError } from '@brandspace/shared';
import {
  AUTOMATION_BRAND_ARCHIVED_REASON,
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
 * FIX PR 2b, B3.7 (F7) — THE AUTOMATION AUTHORITY REMAINDERS, AGAINST REAL
 * POSTGRESQL.
 *
 *   - No rule is created for an ARCHIVED brand, and none is switched on for
 *     one; switching one OFF still works. The refusal carries its own reason.
 *   - A brand of another workspace is the ordinary "not found" — exactly like
 *     a brand that does not exist — whether or not it is archived there, so
 *     the refusal says nothing about another tenant (D-132).
 *   - Every edit re-checks the ACTION's permission, not only an edit to the
 *     action's own settings: a new name, description or daily cap from a
 *     person who may not perform the action is refused, and nothing is
 *     stored. Switching a rule off needs only `automation.manage`.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;
let liveBrandId: string;
let archivedBrandId: string;
let archivedInB: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const engine = (db: TenantScopedClient) =>
  new AutomationEngine({ db, workspaceId: fixtures.a.workspaceId, policy, ports: {} });

/** SCHEDULE_NEXT_FREE_SLOT needs `content.schedule`; `withAction: false` leaves it out. */
function actor(withAction = true): AutomationActor {
  return {
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: [
      'workspace.read',
      'automation.manage',
      ...(withAction ? ['content.schedule'] : []),
    ],
    brandScope: [],
  };
}

async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'OK';
  } catch (error: unknown) {
    if (!isAppError(error)) return `UNEXPECTED:${String(error)}`;
    const reason = error.publicDetails['reason'];
    return typeof reason === 'string' ? `${error.code}:${reason}` : error.code;
  }
}

const create = (brandId: string) =>
  outcome(() =>
    inA((db) =>
      engine(db).createRule({
        brandId,
        name: `fix-2b rule ${randomUUID().slice(0, 8)}`,
        triggerType: 'CONTENT_APPROVED',
        triggerConfig: {},
        conditions: [],
        actionType: 'SCHEDULE_NEXT_FREE_SLOT',
        actionConfig: {},
        enabled: true,
        actor: actor(),
      }),
    ),
  );

async function brand(workspaceId: string, status: 'ACTIVE' | 'ARCHIVED'): Promise<string> {
  const row = await platform.brand.create({
    data: {
      workspaceId,
      slug: `fix-2b-${status.toLowerCase()}-${randomUUID().slice(0, 8)}`,
      name: `Fix 2b ${status}`,
      status,
    },
    select: { id: true },
  });
  return row.id;
}

function storedRule(brandId: string, enabled = false): Promise<AutomationRule> {
  return inA((db) =>
    seedStoredRule(db, {
      workspaceId: fixtures.a.workspaceId,
      brandId,
      name: `fix-2b stored ${randomUUID().slice(0, 8)}`,
      triggerType: 'CONTENT_APPROVED',
      actionType: 'SCHEDULE_NEXT_FREE_SLOT',
      createdByUserId: fixtures.a.userId,
      enabled,
    }),
  );
}

const reread = (id: string) => inA((db) => db.automationRule.findFirstOrThrow({ where: { id } }));

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseAutomationPolicy(defaultPayload('automations'));
  liveBrandId = await brand(fixtures.a.workspaceId, 'ACTIVE');
  archivedBrandId = await brand(fixtures.a.workspaceId, 'ARCHIVED');
  archivedInB = await brand(fixtures.b.workspaceId, 'ARCHIVED');
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('B3.7 — no rule is made or switched on for an archived brand', () => {
  it('creates one for a live brand and refuses an archived one, storing nothing', async () => {
    expect(await create(liveBrandId)).toBe('OK');
    expect(await create(archivedBrandId)).toBe(`CONFLICT:${AUTOMATION_BRAND_ARCHIVED_REASON}`);
    const stored = await inA((db) =>
      db.automationRule.count({ where: { brandId: archivedBrandId } }),
    );
    expect(stored).toBe(0);
  });

  it("refuses another workspace's brand exactly as it refuses one that does not exist", async () => {
    const crossed = await create(archivedInB);
    const missing = await create(randomUUID());
    expect(crossed).toBe('NOT_FOUND');
    expect(crossed).toBe(missing);
  });

  it('refuses switching a rule on once its brand is archived; switching it off still works', async () => {
    const brandId = await brand(fixtures.a.workspaceId, 'ACTIVE');
    const off = await storedRule(brandId, false);
    const on = await storedRule(brandId, true);
    await platform.brand.update({ where: { id: brandId }, data: { status: 'ARCHIVED' } });

    expect(
      await outcome(() =>
        inA((db) => engine(db).updateRule({ ruleId: off.id, enabled: true, actor: actor() })),
      ),
    ).toBe(`CONFLICT:${AUTOMATION_BRAND_ARCHIVED_REASON}`);
    expect((await reread(off.id)).enabled).toBe(false);

    expect(
      await outcome(() =>
        inA((db) => engine(db).updateRule({ ruleId: on.id, enabled: false, actor: actor() })),
      ),
    ).toBe('OK');
    expect((await reread(on.id)).enabled).toBe(false);
  });
});

describe('B3.7 — every edit re-checks the action permission', () => {
  it('updateRule: a new name or daily cap needs the action permission; switching off does not', async () => {
    const rule = await storedRule(liveBrandId, true);
    for (const change of [{ name: 'renamed without authority' }, { maxRunsPerDay: 1 }]) {
      expect(
        await outcome(() =>
          inA((db) => engine(db).updateRule({ ruleId: rule.id, ...change, actor: actor(false) })),
        ),
      ).toBe('FORBIDDEN');
    }
    const unchanged = await reread(rule.id);
    expect(unchanged.name).toBe(rule.name);
    expect(unchanged.version).toBe(rule.version);

    expect(
      await outcome(() =>
        inA((db) =>
          engine(db).updateRule({ ruleId: rule.id, enabled: false, actor: actor(false) }),
        ),
      ),
    ).toBe('OK');
    expect((await reread(rule.id)).enabled).toBe(false);
  });

  it('updateEditableRule: a new name or description needs the action permission', async () => {
    const rule = await storedRule(liveBrandId, false);
    for (const change of [{ name: 'edited without authority' }, { description: 'new words' }]) {
      const current = await reread(rule.id);
      expect(
        await outcome(() =>
          inA((db) =>
            engine(db).updateEditableRule({
              ruleId: rule.id,
              expectedVersion: current.version,
              ...change,
              actor: actor(false),
            }),
          ),
        ),
      ).toBe('FORBIDDEN');
    }
    const unchanged = await reread(rule.id);
    expect(unchanged.name).toBe(rule.name);
    expect(unchanged.version).toBe(rule.version);

    // The same edit by a person who holds the action's permission is saved.
    expect(
      await outcome(() =>
        inA((db) =>
          engine(db).updateEditableRule({
            ruleId: rule.id,
            expectedVersion: unchanged.version,
            name: `fix-2b edited ${randomUUID().slice(0, 8)}`,
            actor: actor(true),
          }),
        ),
      ),
    ).toBe('OK');
  });
});
