import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { commercePolicyFrom, type CommercePolicy } from '@brandspace/billing';
import { findPlan, readPlanCatalogue } from '@brandspace/entitlements';
import { memberCatalogueFor } from '@brandspace/automation';
import { notifyLearningReviewers } from '@brandspace/intelligence';
import { resolveRecipients } from '@brandspace/notifications';
import { WorkspaceOnboardingService } from '@brandspace/onboarding';
import { appRoleClient, ensureWorkspaceRbac, platformRoleClient } from './fixtures';
import { CATALOGUE } from '../support/commerce-fixture';

/**
 * F6 — AN ONBOARDED OWNER IS TOLD ABOUT THEIR OWN BRANDS.
 *
 * Onboarding writes the owner's membership without a `brandScope`. Every reader
 * in code reads that as "every brand", but `resolveRecipients` asks PostgreSQL
 * — `cardinality(scope) = 0 OR scope @> [brand]` — and both are NULL, not true,
 * for a NULL array. So the one member with the widest access was never a
 * recipient of `automation.confirmation_required`, an older NOTIFY rule's
 * `automation.notice`, or `brand_brain.learning_proposed`.
 *
 * Written before the fix and run red against f05d875; green once
 * `20261013090000_brand_scope_not_null` makes the column `{}` by default and
 * never NULL. The owner here is written by the REAL onboarding service, so the
 * test exercises exactly the path customers take.
 */

let platform: PrismaClient;
let app: PrismaClient;
let policy: CommercePolicy;
const run = randomUUID().slice(0, 8);

const plans = readPlanCatalogue({
  plans: [
    {
      key: `f6-${run}`,
      name: { en: 'F6', ar: 'F6' },
      tier: 1,
      status: 'active',
      visibility: 'public',
      prices: [{ currency: 'USD', monthlyMinor: 100, annualMinor: 1000 }],
      trialDays: 14,
      quotas: { workspaces: 5 },
    },
  ],
});
const TRIAL = findPlan(plans, `f6-${run}`)!;

interface Onboarded {
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly brandId: string;
  readonly otherBrandId: string;
  /** A member restricted to `otherBrandId`: told about that brand only. */
  readonly restrictedUserId: string;
}

let onboarded: Onboarded;

const inWorkspace = <T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(workspaceId, fn as never, { prisma: app }) as Promise<T>;

async function onboard(): Promise<Onboarded> {
  const owner = await platform.user.create({
    data: {
      email: `f6-owner-${randomUUID().slice(0, 8)}@example.local`,
      name: 'F6 owner',
      status: 'ACTIVE',
      locale: 'EN',
      timezone: 'UTC',
      emailVerifiedAt: new Date(),
    },
  });
  const { workspaceId } = await new WorkspaceOnboardingService().create(
    platform as unknown as TenantScopedClient,
    {
      ownerUserId: owner.id,
      name: 'F6 onboarding fixture',
      slug: `f6-${randomUUID().slice(0, 12)}`,
      country: 'EG',
      defaultLocale: 'EN',
      timezone: 'Africa/Cairo',
      currency: 'USD',
      billingEmail: `f6-billing-${randomUUID().slice(0, 8)}@example.local`,
    },
    policy,
    TRIAL,
    null,
    plans,
  );
  const brand = (label: string) =>
    platform.brand.create({
      data: {
        workspaceId,
        slug: `f6-${label}-${randomUUID().slice(0, 8)}`,
        name: `F6 ${label}`,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
  const brandId = (await brand('here')).id;
  const otherBrandId = (await brand('other')).id;

  // A colleague with every permission the owner has, restricted to the OTHER
  // brand — so a fix that told everybody would not pass.
  const ownerRole = await platform.membership.findFirstOrThrow({
    where: { workspaceId, userId: owner.id },
    select: { roleId: true },
  });
  const restricted = await platform.user.create({
    data: {
      email: `f6-restricted-${randomUUID().slice(0, 8)}@example.local`,
      name: 'F6 restricted',
      status: 'ACTIVE',
      timezone: 'UTC',
      emailVerifiedAt: new Date(),
    },
  });
  await platform.membership.create({
    data: {
      workspaceId,
      userId: restricted.id,
      roleId: ownerRole.roleId,
      status: 'ACTIVE',
      acceptedAt: new Date(),
      brandScope: [otherBrandId],
    },
  });
  return {
    workspaceId,
    ownerUserId: owner.id,
    brandId,
    otherBrandId,
    restrictedUserId: restricted.id,
  };
}

beforeAll(async () => {
  platform = platformRoleClient();
  app = appRoleClient();
  await ensureWorkspaceRbac(platform);
  policy = commercePolicyFrom(CATALOGUE as unknown as Record<string, unknown>);
  onboarded = await onboard();
}, 120_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

describe('F6 · an owner written by onboarding', () => {
  it('is stored with an empty scope — every brand — never NULL', async () => {
    const [row] = await platform.$queryRaw<{ scope: string | null }[]>`
      SELECT "brandScope"::text AS scope FROM "membership"
       WHERE "workspaceId" = ${onboarded.workspaceId}::uuid AND "userId" = ${onboarded.ownerUserId}::uuid`;
    expect(row?.scope).toBe('{}');
  });

  it('is a recipient for their brand, for both permissions resolveRecipients is asked', async () => {
    for (const permissionKey of ['publishing.manage', 'brand_brain.review']) {
      const here = await inWorkspace(onboarded.workspaceId, (db) =>
        resolveRecipients({
          db,
          workspaceId: onboarded.workspaceId,
          permissionKey,
          brandId: onboarded.brandId,
        }),
      );
      expect(here, permissionKey).toContain(onboarded.ownerUserId);
      // BrandScope still decides for everyone else.
      expect(here, permissionKey).not.toContain(onboarded.restrictedUserId);

      const other = await inWorkspace(onboarded.workspaceId, (db) =>
        resolveRecipients({
          db,
          workspaceId: onboarded.workspaceId,
          permissionKey,
          brandId: onboarded.otherBrandId,
        }),
      );
      expect(other, permissionKey).toEqual(
        expect.arrayContaining([onboarded.ownerUserId, onboarded.restrictedUserId]),
      );
    }
  });

  it('receives the brand-scoped learning notice for their brand', async () => {
    const insightId = randomUUID();
    await inWorkspace(onboarded.workspaceId, (db) =>
      notifyLearningReviewers(db, onboarded.workspaceId, {
        brandId: onboarded.brandId,
        insightId,
        createdCandidateIds: [randomUUID()],
      }),
    );
    const recipients = await inWorkspace(onboarded.workspaceId, (db) =>
      db.notification.findMany({
        where: { templateKey: 'brand_brain.learning_proposed', resourceId: insightId },
        select: { userId: true },
      }),
    );
    expect(recipients.map((row) => row.userId)).toContain(onboarded.ownerUserId);
    expect(recipients.map((row) => row.userId)).not.toContain(onboarded.restrictedUserId);
  });

  it('is offered by the member picker, which now asks the database for the scope (D2)', async () => {
    const list = (brandId: string) =>
      inWorkspace(onboarded.workspaceId, (db) =>
        memberCatalogueFor(db, {
          workspaceId: onboarded.workspaceId,
          brandId,
          viewerBrandScope: [],
        }),
      ).then((choices) => choices.map((choice) => choice.id));
    const here = await list(onboarded.brandId);
    expect(here).toContain(onboarded.ownerUserId);
    expect(here).not.toContain(onboarded.restrictedUserId);
    expect(await list(onboarded.otherBrandId)).toEqual(
      expect.arrayContaining([onboarded.ownerUserId, onboarded.restrictedUserId]),
    );
  });
});
