import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { commercePolicyFrom, type CommercePolicy } from '@brandspace/billing';
import { findPlan, readPlanCatalogue } from '@brandspace/entitlements';
import { WorkspaceDeletionService, WorkspaceOnboardingService } from '@brandspace/onboarding';
import { deletionRequestDetails } from '../../apps/dashboard/src/server/deletion-request-details';
import { appRoleClient, ensureWorkspaceRbac, platformRoleClient } from './fixtures';
import { CATALOGUE } from '../support/commerce-fixture';
import { PLANS_FIXTURE } from '../support/plans-fixture';

/**
 * PHASE 2B-1 REVIEW, ITEM 9 — THE "SCHEDULED FOR DELETION" SCREEN SAYS WHO
 * ASKED AND WHEN, read inside the workspace's own RLS context, AGAINST REAL
 * POSTGRESQL. Another workspace's context learns nothing; a requester who has
 * left is not named.
 */

let app: PrismaClient;
let platform: PrismaClient;
let policy: CommercePolicy;
const plans = readPlanCatalogue(PLANS_FIXTURE as unknown as Record<string, unknown>);

interface Fixture {
  readonly workspaceId: string;
  readonly ownerId: string;
}

async function fixture(label: string): Promise<Fixture> {
  const ownerId = (
    await platform.user.create({
      data: {
        email: `p2b1-pending-${label}-${crypto.randomUUID().slice(0, 8)}@example.local`,
        name: 'Mona Owner',
        status: 'ACTIVE',
        locale: 'EN',
        timezone: 'UTC',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
  const created = await new WorkspaceOnboardingService().create(
    platform as unknown as TenantScopedClient,
    {
      ownerUserId: ownerId,
      name: `Pending ${label}`,
      slug: `p2b1-pend-${crypto.randomUUID().slice(0, 12)}`,
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
  return { workspaceId: created.workspaceId, ownerId };
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

describe('Review item 9 · who asked for the deletion, and when', () => {
  it('names the requester and the time, inside the workspace’s own context', async () => {
    const f = await fixture('details');
    const before = Date.now();
    const { scheduledFor } = await request(f);
    const details = await inTenant(f.workspaceId, (db) =>
      deletionRequestDetails(db, f.workspaceId),
    );
    expect(details.requestedByName).toBe('Mona Owner');
    expect(details.requestedAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(details.scheduledFor).toEqual(scheduledFor);
  });

  it('another workspace’s context learns nothing, and a requester who left is not named', async () => {
    const f = await fixture('details-rls');
    const other = await fixture('details-other');
    await request(f);
    // From another tenant, RLS hides the row: nothing at all.
    expect(
      await inTenant(other.workspaceId, (db) => deletionRequestDetails(db, f.workspaceId)),
    ).toEqual({ requestedAt: null, requestedByName: null, scheduledFor: null });
    // The requester left: the date stays, the name goes.
    await platform.membership.deleteMany({
      where: { workspaceId: f.workspaceId, userId: f.ownerId },
    });
    const details = await inTenant(f.workspaceId, (db) =>
      deletionRequestDetails(db, f.workspaceId),
    );
    expect(details.requestedByName).toBeNull();
    expect(details.requestedAt).not.toBeNull();
  });
});
