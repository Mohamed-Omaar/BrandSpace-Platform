import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, writeDeniedAudit, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  AutomationEngine,
  parseAutomationPolicy,
  runBucketFor,
  runIdempotencyKeyFor,
  type AutomationActor,
  type AutomationPolicy,
  type AutomationPorts,
  type TriggerEvent,
} from '@brandspace/automation';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Phase 7 — the AUTOMATION ENGINE, exercised on real PostgreSQL.
 *
 * WHAT AN AUTOMATION RULE ACTUALLY IS: stored authority. Somebody wrote it once
 * and it keeps acting long afterwards, which makes it the one place in this
 * product where a permission check can quietly become historical. So the
 * properties proven here are about TIME:
 *
 *   1. Authority is RE-RESOLVED on every run, never read from the rule. A
 *      creator who lost the permission, lost the brand or lost their membership
 *      stops the rule the next time it fires.
 *   2. An EXTERNAL action never runs on its own — it stops at
 *      AWAITING_CONFIRMATION and waits for a permitted human.
 *   3. A duplicate delivery produces ONE run, and the de-duplication is a UNIQUE
 *      CONSTRAINT rather than a read.
 *   4. A condition that did not hold is a SUCCESSFUL evaluation, not a failure —
 *      most runs of most rules end there, and calling them failures would make
 *      the history unreadable.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseAutomationPolicy(defaultPayload('automations'));
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

/** What the rule's creator can do right now. The engine asks this every run. */
function owner(overrides: Partial<AutomationActor> = {}): AutomationActor {
  return {
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: [
      // `workspace.read` because NOTIFY needs exactly that and nothing more —
      // the notification carries a pointer, and following it applies the
      // ordinary checks.
      'workspace.read',
      'automation.manage',
      'automation.read',
      'notifications.read',
      'content.approve',
      'content.schedule',
      'publishing.manage',
    ],
    brandScope: [],
    ...overrides,
  };
}

interface Recorded {
  readonly notified: string[];
  readonly published: string[];
}

function engineFor(
  db: TenantScopedClient,
  recorded: Recorded,
  ports: Partial<AutomationPorts> = {},
): AutomationEngine {
  return new AutomationEngine({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy,
    ports: {
      notifications: {
        notify: async (input) => {
          recorded.notified.push(input.idempotencyKey);
          return { recipients: 1 };
        },
      },
      ...ports,
    },
    denialSink: async (event) => {
      // THE REFUSAL MUST OUTLIVE THE TRANSACTION THAT REFUSED IT — wired exactly
      // as `apps/api` wires it, so this suite tests the real configuration.
      await withWorkspace(
        fixtures.a.workspaceId,
        async (fresh) =>
          writeDeniedAudit(fresh, fixtures.a.workspaceId, {
            action: 'automation.confirmation_refused',
            actorType: 'USER',
            actorId: event.actorUserId,
            resourceType: 'AutomationRun',
            resourceId: event.runId,
            brandId: event.brandId,
            reason: event.reason,
          }),
        { prisma: app },
      );
    },
  });
}

function triggerEvent(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    type: 'CONTENT_APPROVED',
    brandId: fixtures.a.brandId,
    refType: 'ContentItem',
    refId: fixtures.a.contentItemId,
    facts: { 'content.status': 'APPROVED', 'content.platformCount': 2 },
    ...overrides,
  };
}

async function newRule(input: {
  name?: string;
  actionType?: 'NOTIFY' | 'PROPOSE_PUBLISH';
  conditions?: unknown;
  actor?: AutomationActor;
}) {
  const recorded: Recorded = { notified: [], published: [] };
  return inA((db) =>
    engineFor(db, recorded).createRule({
      brandId: fixtures.a.brandId,
      name: input.name ?? `Rule ${randomUUID().slice(0, 8)}`,
      triggerType: 'CONTENT_APPROVED',
      triggerConfig: {},
      conditions: input.conditions ?? [],
      actionType: input.actionType ?? 'NOTIFY',
      actionConfig: { templateKey: 'automation.notice' },
      enabled: true,
      actor: input.actor ?? owner(),
    }),
  );
}

describe('a rule cannot be created beyond what its author may do', () => {
  it("a brand outside the author's scope is a 404-shaped miss", async () => {
    await expect(newRule({ actor: owner({ brandScope: [randomUUID()] }) })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it("ANOTHER TENANT's brand is refused identically", async () => {
    const recorded: Recorded = { notified: [], published: [] };
    await expect(
      inA((db) =>
        engineFor(db, recorded).createRule({
          brandId: fixtures.b.brandId,
          name: `Foreign ${randomUUID().slice(0, 8)}`,
          triggerType: 'CONTENT_APPROVED',
          triggerConfig: {},
          conditions: [],
          actionType: 'NOTIFY',
          actionConfig: { templateKey: 'automation.notice' },
          actor: owner({ brandScope: [fixtures.a.brandId] }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an author who cannot perform the action cannot write a rule that performs it', async () => {
    await expect(
      newRule({
        actionType: 'PROPOSE_PUBLISH',
        actor: owner({ permissionKeys: ['automation.manage', 'workspace.read'] }),
      }),
    ).rejects.toThrow();
  });

  it('a condition naming a field outside the closed registry is refused', async () => {
    await expect(
      newRule({
        conditions: [{ field: 'raw_sql', operator: 'equals', value: 'DROP TABLE' }],
      }),
    ).rejects.toThrow();
  });

  it('an unknown trigger or action is refused', async () => {
    const recorded: Recorded = { notified: [], published: [] };
    await expect(
      inA((db) =>
        engineFor(db, recorded).createRule({
          brandId: fixtures.a.brandId,
          name: `Webhook ${randomUUID().slice(0, 8)}`,
          triggerType: 'CONTENT_APPROVED',
          triggerConfig: {},
          conditions: [],
          // THE CAPABILITY THAT DOES NOT EXIST. `CALL_WEBHOOK` is not in the
          // registry and not in the enum, so customer-controlled egress is not
          // something a payload can ask for.
          actionType: 'CALL_WEBHOOK' as never,
          actionConfig: { url: 'https://evil.invalid' },
          actor: owner(),
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('a rule re-resolves its author’s authority on every run', () => {
  it('a run whose author lost the permission is BLOCKED_BY_AUTHORIZATION', async () => {
    const rule = await newRule({});
    const recorded: Recorded = { notified: [], published: [] };

    const outcome = await inA((db) =>
      engineFor(db, recorded).run({
        rule,
        event: triggerEvent(),
        // THE AUTHOR, AS THEY ARE NOW: no longer able to notify.
        // THE AUTHOR, AS THEY ARE NOW: no longer able to see the workspace the
        // notification is about.
        resolveActor: async () => owner({ permissionKeys: ['automation.read'] }),
      }),
    );
    expect(outcome.status).toBe('BLOCKED_BY_AUTHORIZATION');
    expect(outcome.run?.failureCode).toBe('creator_lost_permission');
    expect(recorded.notified).toHaveLength(0);
  });

  it('a run whose author left the workspace is BLOCKED_BY_AUTHORIZATION', async () => {
    const rule = await newRule({});
    const recorded: Recorded = { notified: [], published: [] };

    const outcome = await inA((db) =>
      engineFor(db, recorded).run({
        rule,
        event: triggerEvent({ refId: randomUUID() }),
        resolveActor: async () => null,
      }),
    );
    expect(outcome.status).toBe('BLOCKED_BY_AUTHORIZATION');
    expect(outcome.run?.failureCode).toBe('creator_no_longer_a_member');
  });

  it("a run whose author's BrandScope narrowed past this brand is blocked", async () => {
    const rule = await newRule({});
    const recorded: Recorded = { notified: [], published: [] };

    const outcome = await inA((db) =>
      engineFor(db, recorded).run({
        rule,
        event: triggerEvent({ refId: randomUUID() }),
        resolveActor: async () => owner({ brandScope: [randomUUID()] }),
      }),
    );
    expect(outcome.status).toBe('BLOCKED_BY_AUTHORIZATION');
    expect(outcome.run?.failureCode).toBe('creator_lost_brand_scope');
    expect(recorded.notified).toHaveLength(0);
  });

  it('a run whose author still holds everything SUCCEEDS and performs the action once', async () => {
    const rule = await newRule({});
    const recorded: Recorded = { notified: [], published: [] };

    const outcome = await inA((db) =>
      engineFor(db, recorded).run({
        rule,
        event: triggerEvent({ refId: randomUUID() }),
        resolveActor: async () => owner(),
      }),
    );
    expect(outcome.status).toBe('SUCCEEDED');
    expect(recorded.notified).toHaveLength(1);
  });

  it('a condition that does not hold is SKIPPED, never FAILED', async () => {
    const rule = await newRule({
      conditions: [{ field: 'content.status', operator: 'equals', value: 'DRAFT' }],
    });
    const recorded: Recorded = { notified: [], published: [] };

    const outcome = await inA((db) =>
      engineFor(db, recorded).run({
        rule,
        event: triggerEvent({ refId: randomUUID(), facts: { 'content.status': 'APPROVED' } }),
        resolveActor: async () => owner(),
      }),
    );
    expect(outcome.status).toBe('SKIPPED');
    expect(outcome.run?.conditionsHeld).toBe(false);
    expect(recorded.notified).toHaveLength(0);
  });
});

describe('a duplicate delivery produces exactly one run', () => {
  it('two concurrent deliveries of one event collapse to a single run row', async () => {
    const rule = await newRule({});
    const recorded: Recorded = { notified: [], published: [] };
    const event = triggerEvent({ refId: randomUUID() });

    /*
     * BOTH IN FLIGHT AT ONCE. This is the duplicate BullMQ delivery, and the
     * only thing standing between it and two notifications is the UNIQUE
     * constraint on `(workspaceId, idempotencyKey)` — a "read then insert"
     * loses here, because the gap between the two is where the other delivery
     * is.
     */
    await Promise.all([
      inA((db) => engineFor(db, recorded).run({ rule, event, resolveActor: async () => owner() })),
      inA((db) => engineFor(db, recorded).run({ rule, event, resolveActor: async () => owner() })),
    ]);

    /*
     * THE KEY IS DERIVED THE WAY PRODUCTION DERIVES IT (P7-R5). It used to be
     * `new Date().toISOString().slice(0, 13)` here and in the engine — the hour
     * — and this assertion would have gone GREEN while the defect was live: two
     * deliveries inside one hour did collapse, and the redelivery an hour later
     * that the constraint was supposed to catch was never exercised. The test
     * below this one now exercises exactly that.
     */
    const key = runIdempotencyKeyFor({
      ruleId: rule.id,
      triggerType: event.type,
      refId: event.refId,
      bucket: runBucketFor({
        triggerType: event.type,
        localDate: new Date().toISOString().slice(0, 10),
        hourLocal: 0,
      }),
    });
    const runs = await inA((db) => db.automationRun.findMany({ where: { idempotencyKey: key } }));
    expect(runs).toHaveLength(1);
    expect(recorded.notified.length).toBeLessThanOrEqual(1);
  });

  it('a redelivery of an already-completed run performs nothing further', async () => {
    const rule = await newRule({});
    const recorded: Recorded = { notified: [], published: [] };
    const event = triggerEvent({ refId: randomUUID() });

    await inA((db) =>
      engineFor(db, recorded).run({ rule, event, resolveActor: async () => owner() }),
    );
    expect(recorded.notified).toHaveLength(1);

    await inA((db) =>
      engineFor(db, recorded).run({ rule, event, resolveActor: async () => owner() }),
    );
    expect(recorded.notified).toHaveLength(1);
  });
});

describe('an EXTERNAL action never runs on its own', () => {
  async function awaitingRun() {
    const rule = await newRule({ actionType: 'PROPOSE_PUBLISH' });
    const recorded: Recorded = { notified: [], published: [] };
    const outcome = await inA((db) =>
      engineFor(db, recorded).run({
        rule,
        event: triggerEvent({ refId: fixtures.a.contentItemId }),
        resolveActor: async () => owner(),
      }),
    );
    return { rule, outcome, recorded };
  }

  /**
   * THE CREDENTIAL, OBTAINED THE WAY THE PRODUCT OBTAINS IT (D-179).
   *
   * `run()` used to return a live token, and these tests read it from there.
   * That was the defect: the only caller of `run()` is the WORKER, which logs a
   * status and drops whatever it returns, so the token existed for microseconds
   * inside a background process and then nowhere — and every external proposal
   * was unconfirmable by anybody.
   *
   * The run now records that a person is needed and mints nothing; an authorized
   * person's request mints the live token, after the same permission and
   * BrandScope checks `confirmRun` applies. Asking for it here is what a customer
   * pressing Confirm does, so these tests exercise the real path rather than a
   * value no real caller could hold.
   */
  async function credentialFor(runId: string): Promise<string> {
    const issued = await inA((db) =>
      engineFor(db, { notified: [], published: [] }).reissueRunConfirmation({
        runId,
        actor: owner(),
      }),
    );
    return issued.token;
  }

  it('it stops at AWAITING_CONFIRMATION, mints no credential, and publishes nothing', async () => {
    const { outcome, recorded } = await awaitingRun();
    expect(outcome.status).toBe('AWAITING_CONFIRMATION');
    expect(recorded.published).toHaveLength(0);
    // NOTHING IS MINTED BY THE RUN ITSELF (D-179). A raw credential created here
    // would be created by a process that cannot deliver it.
    expect(outcome.confirmationToken).toBeNull();

    const proposed = await inA((db) =>
      db.automationRun.findFirstOrThrow({
        where: { id: outcome.run?.id ?? '' },
        select: { confirmationTokenHash: true, confirmationExpiresAt: true, confirmedAt: true },
      }),
    );
    expect(proposed.confirmationTokenHash).toBeNull();
    // The PROPOSAL still has a window, which is what gives it an ending.
    expect(proposed.confirmationExpiresAt).not.toBeNull();
    expect(proposed.confirmedAt).toBeNull();

    const token = await credentialFor(outcome.run?.id ?? '');
    expect(token).toBeTruthy();

    const stored = await inA((db) =>
      db.automationRun.findFirstOrThrow({
        where: { id: outcome.run?.id ?? '' },
        select: { confirmationTokenHash: true, confirmedAt: true },
      }),
    );
    // ONLY THE HASH IS ON DISK. A database read cannot be replayed as a
    // confirmation — the same discipline the Copilot and the OAuth state carry.
    expect(stored.confirmationTokenHash).not.toBe(token);
    expect(stored.confirmationTokenHash).not.toBeNull();
    expect(stored.confirmedAt).toBeNull();
  });

  it('a confirmer who lacks the action’s permission is refused, and the refusal is AUDITED', async () => {
    const { outcome } = await awaitingRun();
    const recorded: Recorded = { notified: [], published: [] };
    const before = await inA((db) =>
      db.auditEvent.count({ where: { action: 'automation.confirmation_refused' } }),
    );

    // A REAL, LIVE CREDENTIAL, so the refusal below is unambiguously about the
    // PERMISSION rather than about a token that was never valid.
    const token = await credentialFor(outcome.run?.id ?? '');

    await expect(
      inA((db) =>
        engineFor(db, recorded, {
          publishing: {
            publishNow: async (input) => {
              recorded.published.push(input.contentItemId);
              return { jobsCreated: 1, slotId: randomUUID() };
            },
          },
        }).confirmRun({
          runId: outcome.run?.id ?? '',
          token,
          actor: owner({ permissionKeys: ['automation.read'] }),
        }),
      ),
    ).rejects.toThrow();

    expect(recorded.published).toHaveLength(0);
    /*
     * AND THE REFUSAL SURVIVED. The throw rolled the refusing transaction back;
     * the denial sink wrote on a different connection, which is the whole reason
     * it exists.
     */
    expect(
      await inA((db) =>
        db.auditEvent.count({ where: { action: 'automation.confirmation_refused' } }),
      ),
    ).toBe(before + 1);
  });

  it('a WRONG token is refused and publishes nothing', async () => {
    const { outcome } = await awaitingRun();
    const recorded: Recorded = { notified: [], published: [] };

    await expect(
      inA((db) =>
        engineFor(db, recorded, {
          publishing: {
            publishNow: async (input) => {
              recorded.published.push(input.contentItemId);
              return { jobsCreated: 1, slotId: randomUUID() };
            },
          },
        }).confirmRun({
          runId: outcome.run?.id ?? '',
          token: `${randomUUID()}${randomUUID()}`,
          actor: owner(),
        }),
      ),
    ).rejects.toThrow();
    expect(recorded.published).toHaveLength(0);
  });

  it('the correct token publishes ONCE, and a replay of it is refused', async () => {
    const { outcome } = await awaitingRun();
    const recorded: Recorded = { notified: [], published: [] };
    const publishing = {
      publishNow: async (input: { contentItemId: string }) => {
        recorded.published.push(input.contentItemId);
        return { jobsCreated: 1, slotId: randomUUID() };
      },
    };
    const token = await credentialFor(outcome.run?.id ?? '');

    await inA((db) =>
      engineFor(db, recorded, { publishing }).confirmRun({
        runId: outcome.run?.id ?? '',
        token,
        actor: owner(),
      }),
    );
    expect(recorded.published).toHaveLength(1);

    // THE REPLAY. Same token, same run, seconds later.
    await expect(
      inA((db) =>
        engineFor(db, recorded, { publishing }).confirmRun({
          runId: outcome.run?.id ?? '',
          token,
          actor: owner(),
        }),
      ),
    ).rejects.toThrow();
    expect(recorded.published).toHaveLength(1);
  });

  it('an engine with NO publish port cannot publish at all', async () => {
    /*
     * THE F-07 PATTERN APPLIED TO AUTOMATIONS. The worker wires no publish port,
     * so a confirmed external run there is blocked by policy rather than
     * reaching a platform — the capability is absent, not guarded.
     */
    const { outcome } = await awaitingRun();
    const recorded: Recorded = { notified: [], published: [] };
    const token = await credentialFor(outcome.run?.id ?? '');

    const run = await inA((db) =>
      engineFor(db, recorded).confirmRun({
        runId: outcome.run?.id ?? '',
        token,
        actor: owner(),
      }),
    );
    expect(run.status).toBe('BLOCKED_BY_POLICY');
    expect(run.failureCode).toBe('external_action_unavailable');
    expect(recorded.published).toHaveLength(0);
  });

  it('a run belonging to ANOTHER WORKSPACE cannot be confirmed from this one', async () => {
    const awaitingElsewhere = await inB(async (db) => {
      const run = await db.automationRun.create({
        data: {
          workspaceId: fixtures.b.workspaceId,
          brandId: fixtures.b.brandId,
          ruleId: fixtures.b.automationRuleId,
          status: 'AWAITING_CONFIRMATION',
          triggerType: 'CONTENT_APPROVED',
          idempotencyKey: `foreign-${randomUUID()}`,
          conditionsHeld: true,
          actionType: 'PROPOSE_PUBLISH',
          confirmationTokenHash: `foreign-token-${randomUUID()}`,
          confirmationExpiresAt: new Date(Date.now() + 600_000),
          correlationId: randomUUID(),
        },
      });
      return run.id;
    });

    const recorded: Recorded = { notified: [], published: [] };
    await expect(
      inA((db) =>
        engineFor(db, recorded).confirmRun({
          runId: awaitingElsewhere,
          token: 'anything',
          actor: owner(),
        }),
      ),
    ).rejects.toThrow();

    const untouched = await inB((db) =>
      db.automationRun.findFirstOrThrow({
        where: { id: awaitingElsewhere },
        select: { status: true, confirmedByUserId: true },
      }),
    );
    expect(untouched.status).toBe('AWAITING_CONFIRMATION');
    expect(untouched.confirmedByUserId).toBeNull();
  });
});
