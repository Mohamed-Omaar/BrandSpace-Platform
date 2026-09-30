import { randomUUID } from 'node:crypto';
import type { AutomationRule, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  AutomationEngine,
  NOTIFY_TEMPLATE_NOT_ALLOWED,
  parseAutomationPolicy,
  type AutomationActor,
  type AutomationPolicy,
  type TriggerEvent,
} from '@brandspace/automation';
import { NotificationService } from '@brandspace/notifications';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';
import { seedStoredRule } from './stored-automation-rule';

/**
 * FIX PR 1 · F5 (D-412) — A NOTIFY RULE SENDS `automation.notice` AND NOTHING
 * ELSE, against real PostgreSQL.
 *
 * The rule's template key used to be any string. Through the Copilot's rule
 * tool a rule could name a notice nobody can mute, and an unknown key made the
 * mute filter drop its category, muting everyone who had switched any category
 * off. Now the key is refused when the rule is written, a stored one outside
 * the set fails CLOSED at run time, and the notification writer refuses a key
 * it cannot classify.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

function owner(): AutomationActor {
  return {
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: ['workspace.read', 'automation.manage', 'automation.read'],
    brandScope: [],
  };
}

function engineFor(db: TenantScopedClient, notified: string[]): AutomationEngine {
  return new AutomationEngine({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy,
    ports: {
      notifications: {
        notify: async (input) => {
          notified.push(input.templateKey);
          return { recipients: 1 };
        },
      },
    },
  });
}

const event = (): TriggerEvent => ({
  type: 'CONTENT_APPROVED',
  brandId: fixtures.a.brandId,
  refType: 'ContentItem',
  refId: randomUUID(),
  facts: { 'content.status': 'APPROVED' },
});

/**
 * A STORED NOTIFY rule (Phase 2B-3 PR 2: NOTIFY is no longer offered for new
 * rules; stored ones still run, and are still edited through
 * `updateEditableRule`, which is now the door a template key can arrive by).
 */
const storedNotify = () =>
  inA((db) =>
    seedStoredRule(db, {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      name: `F5 ${randomUUID().slice(0, 8)}`,
      triggerType: 'CONTENT_APPROVED',
      actionType: 'NOTIFY',
      actionConfig: { templateKey: 'automation.notice' },
      createdByUserId: fixtures.a.userId,
      enabled: true,
    }),
  );

/** Edit a stored NOTIFY rule's template, as the edit screen or an API would. */
const editTemplate = (rule: AutomationRule, templateKey: string) =>
  inA((db) =>
    engineFor(db, []).updateEditableRule({
      ruleId: rule.id,
      expectedVersion: rule.version,
      actionConfig: { templateKey },
      actor: owner(),
    }),
  );

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseAutomationPolicy(defaultPayload('automations'));
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('F5 · writing a NOTIFY rule accepts automation.notice only', () => {
  it.each([
    'workspace.deletion_requested',
    'automation.confirmation_required',
    'approval.requested',
    'not.a.template',
    '',
  ])('refuses %j, and leaves the stored template as it was', async (templateKey) => {
    const rule = await storedNotify();
    await expect(editTemplate(rule, templateKey)).rejects.toThrow();
    const row = await inA((db) => db.automationRule.findUniqueOrThrow({ where: { id: rule.id } }));
    expect(row.actionConfig).toEqual({ templateKey: 'automation.notice' });
    expect(row.version).toBe(rule.version);
  });

  it('accepts automation.notice', async () => {
    const rule = await editTemplate(await storedNotify(), 'automation.notice');
    expect((rule.actionConfig as { templateKey: string }).templateKey).toBe('automation.notice');
  });

  it('and no NEW NOTIFY rule is written at all (Phase 2B-3 PR 2)', async () => {
    const before = await inA((db) => db.automationRule.count());
    await expect(
      inA((db) =>
        engineFor(db, []).createRule({
          brandId: fixtures.a.brandId,
          name: `F5 ${randomUUID().slice(0, 8)}`,
          triggerType: 'CONTENT_APPROVED',
          triggerConfig: {},
          conditions: [],
          actionType: 'NOTIFY',
          actionConfig: { templateKey: 'automation.notice' },
          enabled: true,
          actor: owner(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await inA((db) => db.automationRule.count())).toBe(before);
  });
});

describe('F5 · a stored rule outside the set fails closed at run time', () => {
  it.each(['workspace.deletion_requested', 'not.a.template'])(
    'a rule naming %j ends FAILED notify_template_not_allowed, and nothing is sent',
    async (templateKey) => {
      const rule = await storedNotify();
      // A row written before the set was enforced, or around the engine.
      const stored = await inA((db) =>
        db.automationRule.update({
          where: { id: rule.id },
          data: { actionConfig: { templateKey } },
        }),
      );
      const notified: string[] = [];
      const outcome = await inA((db) =>
        engineFor(db, notified).run({
          rule: stored,
          event: event(),
          resolveActor: async () => owner(),
        }),
      );
      expect(outcome.status).toBe('FAILED');
      expect(outcome.run?.failureCode).toBe(NOTIFY_TEMPLATE_NOT_ALLOWED);
      expect(notified).toEqual([]);
    },
  );

  it('a rule naming automation.notice still sends it', async () => {
    const rule = await storedNotify();
    const notified: string[] = [];
    const outcome = await inA((db) =>
      engineFor(db, notified).run({ rule, event: event(), resolveActor: async () => owner() }),
    );
    expect(outcome.status).toBe('SUCCEEDED');
    expect(notified).toEqual(['automation.notice']);
  });
});

describe('F5 · the notification writer refuses a key it cannot classify', () => {
  it('an unknown template writes no row for anybody — muted or not', async () => {
    const key = `f5-unknown-${randomUUID()}`;
    await expect(
      inA((db) =>
        new NotificationService({ db, workspaceId: fixtures.a.workspaceId }).create({
          userIds: [fixtures.a.userId],
          templateKey: 'not.a.template' as never,
          idempotencyKey: key,
        }),
      ),
    ).rejects.toThrow(/not in the catalogue/);
    expect(
      await inA((db) => db.notification.count({ where: { idempotencyKey: { startsWith: key } } })),
    ).toBe(0);
  });

  it('automation.notice is muted by the Automations switch, and by nothing else', async () => {
    const service = (db: TenantScopedClient) =>
      new NotificationService({ db, workspaceId: fixtures.a.workspaceId });
    // The reader switches PUBLISHING off: an automation notice still arrives.
    await inA((db) =>
      db.notificationPreference.upsert({
        where: {
          workspaceId_userId_category: {
            workspaceId: fixtures.a.workspaceId,
            userId: fixtures.a.userId,
            category: 'publishing',
          },
        },
        create: {
          workspaceId: fixtures.a.workspaceId,
          userId: fixtures.a.userId,
          category: 'publishing',
          enabled: false,
        },
        update: { enabled: false },
      }),
    );
    const first = await inA((db) =>
      service(db).create({
        userIds: [fixtures.a.userId],
        templateKey: 'automation.notice',
        idempotencyKey: `f5-notice-${randomUUID()}`,
      }),
    );
    expect(first).toBe(1);

    // AUTOMATIONS off: now it does not.
    await inA((db) =>
      db.notificationPreference.upsert({
        where: {
          workspaceId_userId_category: {
            workspaceId: fixtures.a.workspaceId,
            userId: fixtures.a.userId,
            category: 'automations',
          },
        },
        create: {
          workspaceId: fixtures.a.workspaceId,
          userId: fixtures.a.userId,
          category: 'automations',
          enabled: false,
        },
        update: { enabled: false },
      }),
    );
    const second = await inA((db) =>
      service(db).create({
        userIds: [fixtures.a.userId],
        templateKey: 'automation.notice',
        idempotencyKey: `f5-notice-${randomUUID()}`,
      }),
    );
    expect(second).toBe(0);
  });
});
