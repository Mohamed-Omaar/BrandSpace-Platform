import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { commercePolicyFrom, type CommercePolicy } from '@brandspace/billing';
import { findPlan, readPlanCatalogue } from '@brandspace/entitlements';
import { WorkspaceDeletionService, WorkspaceOnboardingService } from '@brandspace/onboarding';
import type { Clock } from '@brandspace/shared';
import { appRoleClient, ensureWorkspaceRbac, platformRoleClient } from './fixtures';
import { CATALOGUE } from '../support/commerce-fixture';
import { PLANS_FIXTURE } from '../support/plans-fixture';

/**
 * PHASE 2B-1 REVIEW, ITEMS 7–8 — WORKSPACE DELETION, HARDENED, AGAINST REAL
 * POSTGRESQL.
 *
 *   7. the deadline's DELETED + deletedAt + session revocation + audit happen
 *      in ONE transaction per workspace: a failure between steps leaves it
 *      pending, never half deleted, and the next pass finishes it;
 *   8. a plan that still renews stops the deletion — at the request, where
 *      the subscription row is locked (a concurrent resume is waited for and
 *      seen), and again at the deadline, where it is flagged and audited once
 *      and billing is never touched;
 */

let app: PrismaClient;
let platform: PrismaClient;
let policy: CommercePolicy;
const plans = readPlanCatalogue(PLANS_FIXTURE as unknown as Record<string, unknown>);
const later = (days: number): Clock => ({ now: () => new Date(Date.now() + days * 86_400_000) });

interface Fixture {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly memberId: string;
}

async function user(label: string, name: string): Promise<string> {
  return (
    await platform.user.create({
      data: {
        email: `p2b1-harden-${label}-${crypto.randomUUID().slice(0, 8)}@example.local`,
        name,
        status: 'ACTIVE',
        locale: 'EN',
        timezone: 'UTC',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
}

async function fixture(label: string): Promise<Fixture> {
  const ownerId = await user(`${label}-owner`, 'Mona Owner');
  const created = await new WorkspaceOnboardingService().create(
    platform as unknown as TenantScopedClient,
    {
      ownerUserId: ownerId,
      name: `Harden ${label}`,
      slug: `p2b1-hard-${crypto.randomUUID().slice(0, 12)}`,
      country: 'EG',
      defaultLocale: 'EN',
      timezone: 'Africa/Cairo',
      currency: 'USD',
      billingEmail: `billing-${crypto.randomUUID().slice(0, 8)}@example.local`,
    },
    policy,
    findPlan(plans, 'fixture-starter'),
    null,
    plans,
  );
  const memberId = await user(`${label}-member`, 'Member');
  const role = await platform.role.findFirstOrThrow({
    where: { key: 'content_creator', workspaceId: null, realm: 'WORKSPACE' },
    select: { id: true },
  });
  await platform.membership.create({
    data: {
      workspaceId: created.workspaceId,
      userId: memberId,
      roleId: role.id,
      status: 'ACTIVE',
      acceptedAt: new Date(),
    },
  });
  return { workspaceId: created.workspaceId, ownerId, memberId };
}

const inTenant = <T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(workspaceId, fn, { prisma: app });

const request = (f: Fixture) =>
  inTenant(f.workspaceId, (db) =>
    new WorkspaceDeletionService().request(db, {
      workspaceId: f.workspaceId,
      actorUserId: f.ownerId,
      actorName: 'Mona Owner',
      graceDays: 30,
    }),
  );

const setSubscription = (
  f: Fixture,
  data: { status?: 'ACTIVE' | 'CANCELLED'; cancelAtPeriodEnd?: boolean },
) => platform.workspaceSubscription.update({ where: { workspaceId: f.workspaceId }, data });

const state = (f: Fixture) =>
  platform.workspace.findUniqueOrThrow({
    where: { id: f.workspaceId },
    select: { status: true, deletedAt: true, deletionScheduledFor: true },
  });

const audits = async (f: Fixture, action: string) =>
  platform.auditEvent.count({ where: { workspaceId: f.workspaceId, action } });

/** The platform client, with one tenant call inside each transaction made to fail. */
function failingInside(model: 'customerSession' | 'auditEvent', method: string): PrismaClient {
  return new Proxy(platform, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== '$transaction') {
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      }
      return (fn: (tx: unknown) => Promise<unknown>) =>
        target.$transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(inner, name, r) {
                const delegate = Reflect.get(inner, name, r) as Record<string, unknown>;
                if (name !== model) return delegate;
                return new Proxy(delegate, {
                  get(d, m) {
                    if (m === method) {
                      return async () => {
                        throw new Error(`injected failure in ${String(model)}.${String(m)}`);
                      };
                    }
                    const f = Reflect.get(d, m) as unknown;
                    return typeof f === 'function'
                      ? (f as (...a: unknown[]) => unknown).bind(d)
                      : f;
                  },
                });
              },
            }),
          ),
        );
    },
  }) as PrismaClient;
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  await ensureWorkspaceRbac(platform);
  policy = commercePolicyFrom(CATALOGUE as unknown as Record<string, unknown>);
}, 120_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

describe('Review item 7 · the final transition is one transaction per workspace', () => {
  for (const [model, method] of [
    ['customerSession', 'updateMany'],
    ['auditEvent', 'create'],
  ] as const) {
    it(`a failure in ${model}.${method} leaves the workspace pending, not half deleted; the next pass finishes it`, async () => {
      const f = await fixture(`fail-${model}`);
      await request(f);
      const finisher = new WorkspaceDeletionService({ clock: later(31) });

      await expect(finisher.finishDue(failingInside(model, method), 500)).rejects.toThrow(
        /injected failure/,
      );
      const after = await state(f);
      expect(after.status).not.toBe('DELETED');
      expect(after.deletedAt).toBeNull();
      expect(after.deletionScheduledFor).not.toBeNull();
      expect(await audits(f, 'workspace.deleted')).toBe(0);

      const finished = await finisher.finishDue(platform, 500);
      expect(finished).toContain(f.workspaceId);
      expect((await state(f)).status).toBe('DELETED');
      expect(await audits(f, 'workspace.deleted')).toBe(1);
    });
  }
});

describe('Review item 8 · a plan that still renews is never deleted', () => {
  it('the request locks the subscription: a resume committing concurrently is waited for and refuses it', async () => {
    const f = await fixture('race-request');
    // Set to end at the period end: on its own, the request would be accepted.
    await setSubscription(f, { status: 'ACTIVE', cancelAtPeriodEnd: true });

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // The owner RESUMES the plan in another transaction that holds the row.
    const resume = platform.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "workspace_subscription" SET "cancelAtPeriodEnd" = false
                            WHERE "workspaceId" = ${f.workspaceId}::uuid`;
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Settled into a value at once, so its refusal is handled even while this
    // test is still awaiting the resume below.
    const attempt = request(f).then(
      (accepted) => ({ accepted }),
      (error: unknown) => error,
    );
    // The request is now waiting for the lock; let the resume commit.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await resume;

    expect(await attempt).toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: 'CANCEL_PLAN_FIRST' },
    });
    expect((await state(f)).deletionScheduledFor).toBeNull();
  });

  it('at the deadline a resumed plan stops the deletion: flagged and audited once, billing untouched', async () => {
    const f = await fixture('race-finish');
    await setSubscription(f, { status: 'ACTIVE', cancelAtPeriodEnd: true });
    await request(f);
    // Resumed while it waited.
    await setSubscription(f, { cancelAtPeriodEnd: false });

    const finisher = new WorkspaceDeletionService({ clock: later(31) });
    expect(await finisher.finishDue(platform, 500)).not.toContain(f.workspaceId);
    expect(await finisher.finishDue(platform, 500)).not.toContain(f.workspaceId);
    const after = await state(f);
    expect(after.status).not.toBe('DELETED');
    expect(after.deletedAt).toBeNull();
    expect(after.deletionScheduledFor).not.toBeNull();
    const blocked = await platform.auditEvent.findMany({
      where: { workspaceId: f.workspaceId, action: 'workspace.deletion_blocked' },
      select: { reason: true, outcome: true },
    });
    expect(blocked).toEqual([{ reason: 'CANCEL_PLAN_FIRST', outcome: 'DENIED' }]);
    // Billing is never cancelled by the deletion.
    expect(
      await platform.workspaceSubscription.findUniqueOrThrow({
        where: { workspaceId: f.workspaceId },
        select: { status: true, cancelAtPeriodEnd: true },
      }),
    ).toEqual({ status: 'ACTIVE', cancelAtPeriodEnd: false });

    // Once the plan is set to end again, the next pass deletes it.
    await setSubscription(f, { cancelAtPeriodEnd: true });
    expect(await finisher.finishDue(platform, 500)).toContain(f.workspaceId);
    expect((await state(f)).status).toBe('DELETED');
  });
});
