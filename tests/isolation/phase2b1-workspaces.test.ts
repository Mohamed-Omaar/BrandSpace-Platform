import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantScopedClient } from '@brandspace/database';
import { commercePolicyFrom, type CommercePolicy } from '@brandspace/billing';
import { findPlan, readPlanCatalogue } from '@brandspace/entitlements';
import { WorkspaceOnboardingService } from '@brandspace/onboarding';
import { ensureWorkspaceRbac, platformRoleClient } from './fixtures';
import { CATALOGUE } from '../support/commerce-fixture';

/**
 * PROTOTYPE v94 PHASE 2B-1, ITEM 1 — THE WORKSPACE ALLOWANCE, AGAINST REAL
 * POSTGRESQL (Q1 / A2 / G7, D-326): enforced where a workspace is written
 * (`WorkspaceOnboardingService.create`), counted per owner and never across
 * another person's workspaces, serialised on the owner's row.
 *
 * Every plan and number is a FIXTURE standing in for Control Center
 * configuration (AC-04.3).
 */

let platform: PrismaClient;
let policy: CommercePolicy;
const run = crypto.randomUUID().slice(0, 8);

const plans = readPlanCatalogue({
  plans: [
    {
      key: `ws-one-${run}`,
      name: { en: 'One', ar: 'واحد' },
      tier: 1,
      status: 'active',
      visibility: 'public',
      prices: [{ currency: 'USD', monthlyMinor: 100, annualMinor: 1000 }],
      trialDays: 14,
      quotas: { workspaces: 1 },
    },
    {
      key: `ws-two-${run}`,
      name: { en: 'Two', ar: 'اثنان' },
      tier: 2,
      status: 'active',
      visibility: 'public',
      prices: [{ currency: 'USD', monthlyMinor: 200, annualMinor: 2000 }],
      trialDays: 14,
      quotas: { workspaces: 2 },
    },
    {
      key: `ws-five-${run}`,
      name: { en: 'Five', ar: 'خمسة' },
      tier: 3,
      status: 'active',
      visibility: 'public',
      prices: [{ currency: 'USD', monthlyMinor: 300, annualMinor: 3000 }],
      trialDays: 14,
      quotas: { workspaces: 5 },
    },
  ],
});
const ONE = findPlan(plans, `ws-one-${run}`);
const TWO = findPlan(plans, `ws-two-${run}`);
const FIVE = findPlan(plans, `ws-five-${run}`);

async function verifiedUser(label: string): Promise<string> {
  const user = await platform.user.create({
    data: {
      email: `p2b1-${label}-${crypto.randomUUID().slice(0, 8)}@example.local`,
      name: `Phase 2B-1 ${label}`,
      status: 'ACTIVE',
      locale: 'EN',
      timezone: 'UTC',
      emailVerifiedAt: new Date(),
    },
  });
  return user.id;
}

function create(ownerUserId: string, trialPlan = ONE) {
  return new WorkspaceOnboardingService().create(
    platform as unknown as TenantScopedClient,
    {
      ownerUserId,
      name: 'Allowance fixture',
      slug: `p2b1-${crypto.randomUUID().slice(0, 12)}`,
      country: 'EG',
      defaultLocale: 'EN',
      timezone: 'Africa/Cairo',
      currency: 'USD',
      billingEmail: `billing-${crypto.randomUUID().slice(0, 8)}@example.local`,
    },
    policy,
    trialPlan,
    null,
    plans,
  );
}

async function setSubscription(
  workspaceId: string,
  planKey: string,
  status: 'ACTIVE' | 'CANCELLED',
): Promise<void> {
  await platform.workspace.update({ where: { id: workspaceId }, data: { planKey } });
  await platform.workspaceSubscription.update({
    where: { workspaceId },
    data: { planKey, status },
  });
}

async function ownedCount(userId: string): Promise<number> {
  return platform.workspace.count({ where: { ownerUserId: userId } });
}

beforeAll(async () => {
  platform = platformRoleClient();
  await ensureWorkspaceRbac(platform);
  policy = commercePolicyFrom(CATALOGUE as unknown as Record<string, unknown>);
}, 120_000);

afterAll(async () => {
  await platform.$disconnect();
});

describe('Q1 · the workspace allowance is enforced where a workspace is written', () => {
  it('lets a new owner create their first workspace, then stops at the trial plan allowance', async () => {
    const owner = await verifiedUser('first');
    await create(owner);
    await expect(create(owner)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      publicDetails: { reason: 'WORKSPACE_ALLOWANCE_REACHED', used: 1, allowed: 1 },
    });
    expect(await ownedCount(owner)).toBe(1);
  });

  it('takes the allowance from the owner’s paid plan, and a new trial never raises it', async () => {
    const owner = await verifiedUser('paid');
    const first = await create(owner);
    await setSubscription(first.workspaceId, TWO.key, 'ACTIVE');

    // The second workspace starts on the FIVE plan's trial — which must not
    // count while a paid workspace exists.
    await create(owner, FIVE);
    await expect(create(owner, FIVE)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      publicDetails: { used: 2, allowed: 2 },
    });
    expect(await ownedCount(owner)).toBe(2);
  });

  it('a cancelled plan contributes nothing', async () => {
    const owner = await verifiedUser('cancelled');
    const first = await create(owner, FIVE);
    await setSubscription(first.workspaceId, FIVE.key, 'CANCELLED');
    await expect(create(owner)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('counts a workspace that is not operable, and stops counting it once DELETED', async () => {
    const owner = await verifiedUser('deleted');
    const first = await create(owner);
    await platform.workspace.update({
      where: { id: first.workspaceId },
      data: {
        status: 'SUSPENDED',
        statusReason: 'Fixture: not operable',
        statusChangedAt: new Date(),
      },
    });
    await expect(create(owner)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });

    await platform.workspace.update({
      where: { id: first.workspaceId },
      data: {
        status: 'DELETED',
        deletedAt: new Date(),
        statusReason: 'Fixture: deleted',
        statusChangedAt: new Date(),
      },
    });
    // Nothing counts any more and nothing contributes: this is a first workspace again.
    await expect(create(owner)).resolves.toMatchObject({ workspaceId: expect.any(String) });
  });

  it('never counts another person’s workspaces', async () => {
    const busy = await verifiedUser('busy');
    await create(busy, FIVE);
    await create(busy, FIVE);
    const other = await verifiedUser('other');
    await expect(create(other)).resolves.toMatchObject({ workspaceId: expect.any(String) });
  });

  it('only an owner creates another workspace: a member who owns none is refused', async () => {
    const owner = await verifiedUser('host');
    const hosted = await create(owner, FIVE);
    const member = await verifiedUser('member');
    const role = await platform.role.findFirstOrThrow({
      where: { key: 'content_creator', workspaceId: null, realm: 'WORKSPACE' },
      select: { id: true },
    });
    await platform.membership.create({
      data: {
        workspaceId: hosted.workspaceId,
        userId: member,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
    await expect(create(member)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      publicDetails: { reason: 'WORKSPACE_OWNER_ONLY' },
    });
    expect(await ownedCount(member)).toBe(0);
  });

  it('serialises concurrent requests on the owner: at the limit, exactly one succeeds', async () => {
    const owner = await verifiedUser('race');
    const first = await create(owner);
    await setSubscription(first.workspaceId, TWO.key, 'ACTIVE');
    const results = await Promise.allSettled([create(owner), create(owner), create(owner)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await ownedCount(owner)).toBe(2);
  });
});
