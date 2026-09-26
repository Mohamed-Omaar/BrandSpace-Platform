import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { commercePolicyFrom, type CommercePolicy } from '@brandspace/billing';
import { CustomerAuthService, hashPassword } from '@brandspace/auth';
import { CreditLedgerService, findPlan, readPlanCatalogue } from '@brandspace/entitlements';
import { WorkspaceDeletionService, WorkspaceOnboardingService } from '@brandspace/onboarding';
import type { Clock } from '@brandspace/shared';
import { appRoleClient, ensureWorkspaceRbac, platformRoleClient } from './fixtures';
import { CATALOGUE } from '../support/commerce-fixture';
import { PLANS_FIXTURE } from '../support/plans-fixture';

/**
 * PROTOTYPE v94 PHASE 2B-1, A8 (D-328) — THE OWNER'S WORKSPACE DELETION,
 * AGAINST REAL POSTGRESQL.
 *
 *   - request: sets the date from the grace period, audits, tells every other
 *     member in-app; refused while a paid plan still renews; one at a time;
 *   - pending: the workspace drops out of every list a caller acts from, but
 *     its owner can still switch into it to cancel; no credit is reserved;
 *   - cancel: clears it, audits, tells the members;
 *   - finish: past the deadline a job marks it DELETED, revokes its sessions
 *     and audits; a cancelled or not-yet-due one is untouched; a rerun is a
 *     no-op;
 *   - tenancy: one workspace's context can neither request nor cancel
 *     another's.
 */

let app: PrismaClient;
let platform: PrismaClient;
let policy: CommercePolicy;
const plans = readPlanCatalogue(PLANS_FIXTURE as unknown as Record<string, unknown>);
const PASSWORD = `p2b1-${crypto.randomUUID()}`;

interface Fixture {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly ownerEmail: string;
  readonly memberId: string;
}

async function verifiedUser(label: string): Promise<{ id: string; email: string }> {
  const email = `p2b1-del-${label}-${crypto.randomUUID().slice(0, 8)}@example.local`;
  const user = await platform.user.create({
    data: {
      email,
      name: `Deletion ${label}`,
      status: 'ACTIVE',
      locale: 'EN',
      timezone: 'UTC',
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(PASSWORD),
    },
  });
  return { id: user.id, email };
}

async function fixture(label: string): Promise<Fixture> {
  const owner = await verifiedUser(`${label}-owner`);
  const created = await new WorkspaceOnboardingService().create(
    platform as unknown as TenantScopedClient,
    {
      ownerUserId: owner.id,
      name: `Deletion ${label}`,
      slug: `p2b1-del-${crypto.randomUUID().slice(0, 12)}`,
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
  const member = await verifiedUser(`${label}-member`);
  const role = await platform.role.findFirstOrThrow({
    where: { key: 'content_creator', workspaceId: null, realm: 'WORKSPACE' },
    select: { id: true },
  });
  await platform.membership.create({
    data: {
      workspaceId: created.workspaceId,
      userId: member.id,
      roleId: role.id,
      status: 'ACTIVE',
      acceptedAt: new Date(),
    },
  });
  return {
    workspaceId: created.workspaceId,
    ownerId: owner.id,
    ownerEmail: owner.email,
    memberId: member.id,
  };
}

function inTenant<T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(workspaceId, fn, { prisma: app });
}

function request(f: Fixture, service = new WorkspaceDeletionService()) {
  return inTenant(f.workspaceId, (db) =>
    service.request(db, {
      workspaceId: f.workspaceId,
      actorUserId: f.ownerId,
      actorName: 'Owner',
      graceDays: 30,
    }),
  );
}

function cancel(f: Fixture) {
  return inTenant(f.workspaceId, (db) =>
    new WorkspaceDeletionService().cancel(db, {
      workspaceId: f.workspaceId,
      actorUserId: f.ownerId,
      actorName: 'Owner',
    }),
  );
}

async function auditActions(workspaceId: string): Promise<string[]> {
  const rows = await platform.auditEvent.findMany({
    where: { workspaceId, action: { startsWith: 'workspace.dele' } },
    orderBy: { occurredAt: 'asc' },
    select: { action: true },
  });
  return rows.map((row) => row.action);
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

describe('A8 · requesting deletion', () => {
  it('schedules it grace days out, audits it and tells every other member in-app', async () => {
    const f = await fixture('request');
    const before = Date.now();
    const { scheduledFor } = await request(f);
    const days = (scheduledFor.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);

    const row = await platform.workspace.findUniqueOrThrow({
      where: { id: f.workspaceId },
      select: {
        deletionRequestedAt: true,
        deletionScheduledFor: true,
        deletionRequestedByUserId: true,
        status: true,
        deletedAt: true,
      },
    });
    expect(row.deletionScheduledFor?.toISOString()).toBe(scheduledFor.toISOString());
    expect(row.deletionRequestedByUserId).toBe(f.ownerId);
    // Nothing is deleted yet.
    expect(row.deletedAt).toBeNull();
    expect(row.status).not.toBe('DELETED');
    expect(await auditActions(f.workspaceId)).toEqual(['workspace.deletion_requested']);

    const notified = await platform.notification.findMany({
      where: { workspaceId: f.workspaceId, templateKey: 'workspace.deletion_requested' },
      select: { userId: true, channel: true },
    });
    expect(notified).toEqual([{ userId: f.memberId, channel: 'IN_APP' }]);

    await expect(request(f)).rejects.toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: 'ALREADY_PENDING' },
    });
  });

  it('is refused while a paid plan still renews, and nothing is written', async () => {
    const f = await fixture('paid');
    await platform.workspaceSubscription.update({
      where: { workspaceId: f.workspaceId },
      data: { status: 'ACTIVE', cancelAtPeriodEnd: false },
    });
    await expect(request(f)).rejects.toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: 'CANCEL_PLAN_FIRST' },
    });
    const row = await platform.workspace.findUniqueOrThrow({
      where: { id: f.workspaceId },
      select: { deletionScheduledFor: true },
    });
    expect(row.deletionScheduledFor).toBeNull();
    expect(await auditActions(f.workspaceId)).toEqual([]);

    // Once the plan is set to end, the request goes through.
    await platform.workspaceSubscription.update({
      where: { workspaceId: f.workspaceId },
      data: { cancelAtPeriodEnd: true },
    });
    await expect(request(f)).resolves.toMatchObject({ scheduledFor: expect.any(Date) });
  });

  it('one workspace’s context can neither request nor cancel another’s', async () => {
    const a = await fixture('tenant-a');
    const b = await fixture('tenant-b');
    await expect(
      inTenant(a.workspaceId, (db) =>
        new WorkspaceDeletionService().request(db, {
          workspaceId: b.workspaceId,
          actorUserId: a.ownerId,
          actorName: 'A',
          graceDays: 30,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await request(b);
    await expect(
      inTenant(a.workspaceId, (db) =>
        new WorkspaceDeletionService().cancel(db, {
          workspaceId: b.workspaceId,
          actorUserId: a.ownerId,
          actorName: 'A',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const row = await platform.workspace.findUniqueOrThrow({
      where: { id: b.workspaceId },
      select: { deletionScheduledFor: true },
    });
    expect(row.deletionScheduledFor).not.toBeNull();
  });
});

describe('A8 · while it waits, nobody works in it', () => {
  it('drops out of the list every caller acts from, and only its owner can switch in to cancel', async () => {
    const f = await fixture('pending-list');
    const auth = new CustomerAuthService({ prisma: app });
    const session = await auth.signIn({ email: f.ownerEmail, password: PASSWORD });
    await auth.switchWorkspace(session.token, f.workspaceId);
    await request(f);

    const acting = await auth.listWorkspaces(session.token);
    expect(acting.map((w) => w.workspaceId)).not.toContain(f.workspaceId);

    const shown = await auth.listWorkspaces(session.token, { includePendingDeletion: true });
    const pending = shown.find((w) => w.workspaceId === f.workspaceId);
    expect(pending?.deletionScheduledFor).toBeInstanceOf(Date);

    // The session keeps it as its workspace, so the dashboard can show the
    // "scheduled for deletion" screen rather than losing it.
    expect((await auth.resolve(session.token))?.activeWorkspaceId).toBe(f.workspaceId);
    await expect(auth.switchWorkspace(session.token, f.workspaceId)).resolves.toMatchObject({
      workspaceId: f.workspaceId,
    });
  });

  it('reserves no credit', async () => {
    const f = await fixture('pending-credits');
    await request(f);
    await expect(
      new CreditLedgerService({ prisma: platform }).reserve({
        workspaceId: f.workspaceId,
        estimateMilliCredits: 1_000n,
        purpose: 'test.pending_deletion',
        idempotencyKey: `p2b1-del-${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      publicDetails: { reason: 'WORKSPACE_PENDING_DELETION' },
    });
    expect(await platform.creditReservation.count({ where: { workspaceId: f.workspaceId } })).toBe(
      0,
    );
  });
});

describe('A8 · cancelling', () => {
  it('clears the request, audits it and tells the members; a second cancel is refused', async () => {
    const f = await fixture('cancel');
    await request(f);
    await cancel(f);
    const row = await platform.workspace.findUniqueOrThrow({
      where: { id: f.workspaceId },
      select: {
        deletionRequestedAt: true,
        deletionScheduledFor: true,
        deletionRequestedByUserId: true,
      },
    });
    expect(row).toEqual({
      deletionRequestedAt: null,
      deletionScheduledFor: null,
      deletionRequestedByUserId: null,
    });
    expect(await auditActions(f.workspaceId)).toEqual([
      'workspace.deletion_requested',
      'workspace.deletion_cancelled',
    ]);
    expect(
      await platform.notification.count({
        where: {
          workspaceId: f.workspaceId,
          userId: f.memberId,
          templateKey: 'workspace.deletion_cancelled',
        },
      }),
    ).toBe(1);
    await expect(cancel(f)).rejects.toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: 'NOT_PENDING' },
    });
  });

  it('a request and its date are a pair: the database refuses half of one', async () => {
    const f = await fixture('coherent');
    await expect(
      platform.workspace.update({
        where: { id: f.workspaceId },
        data: { deletionScheduledFor: new Date() },
      }),
    ).rejects.toThrow(/workspace_deletion_request_coherent/);
  });
});

describe('A8 · finishing at the deadline', () => {
  const later = (days: number): Clock => ({
    now: () => new Date(Date.now() + days * 86_400_000),
  });

  it('marks a due workspace DELETED, revokes its sessions and audits; nothing twice', async () => {
    const due = await fixture('finish-due');
    const notYet = await fixture('finish-not-yet');
    const cancelled = await fixture('finish-cancelled');
    await request(due);
    await request(notYet, new WorkspaceDeletionService({ clock: later(20) }));
    await request(cancelled);
    await cancel(cancelled);

    const auth = new CustomerAuthService({ prisma: app });
    const session = await auth.signIn({ email: due.ownerEmail, password: PASSWORD });
    await auth.switchWorkspace(session.token, due.workspaceId);

    const finisher = new WorkspaceDeletionService({ clock: later(31) });
    const finished = await finisher.finishDue(platform as unknown as TenantScopedClient, 500);
    expect(finished).toContain(due.workspaceId);
    expect(finished).not.toContain(notYet.workspaceId);
    expect(finished).not.toContain(cancelled.workspaceId);

    const row = await platform.workspace.findUniqueOrThrow({
      where: { id: due.workspaceId },
      select: { status: true, deletedAt: true, statusReason: true },
    });
    expect(row.status).toBe('DELETED');
    expect(row.deletedAt).not.toBeNull();
    expect(row.statusReason).not.toBeNull();
    expect(await auditActions(due.workspaceId)).toEqual([
      'workspace.deletion_requested',
      'workspace.deleted',
    ]);
    const revoked = await platform.customerSession.findFirstOrThrow({
      where: { activeWorkspaceId: due.workspaceId, userId: due.ownerId },
      select: { revokedAt: true },
    });
    expect(revoked.revokedAt).not.toBeNull();

    for (const untouched of [notYet, cancelled]) {
      const other = await platform.workspace.findUniqueOrThrow({
        where: { id: untouched.workspaceId },
        select: { status: true, deletedAt: true },
      });
      expect(other.deletedAt).toBeNull();
      expect(other.status).not.toBe('DELETED');
    }

    // A rerun finishes nothing twice.
    const again = await finisher.finishDue(platform as unknown as TenantScopedClient, 500);
    expect(again).not.toContain(due.workspaceId);
    expect(await auditActions(due.workspaceId)).toHaveLength(2);
  });
});
