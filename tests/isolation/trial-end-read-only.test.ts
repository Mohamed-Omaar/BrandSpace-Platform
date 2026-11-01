import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { ContentLibraryService, type ContentPolicy } from '@brandspace/content';
import {
  CreditLedgerService,
  EntitlementService,
  INERT_CREDIT_POLICY,
  type CatalogueSource,
} from '@brandspace/entitlements';
import { appRoleClient } from './fixtures';

/**
 * D-584 (check-up 2026-10-28, M-5): WHEN THE FREE TRIAL ENDS, THE WORKSPACE IS
 * READ-ONLY — no AI, no new post, no publishing; data kept; the platform owner
 * can extend the trial. On real PostgreSQL, through the app role for tenant
 * writes, so the rule is proven where it is enforced.
 *
 * The isolation half: one workspace's ended trial changes nothing for another.
 */

class EmptyCatalogue implements CatalogueSource {
  async load(): Promise<Record<string, unknown>> {
    return {};
  }
  async versionId(): Promise<string | null> {
    return null;
  }
}

const CONTENT_POLICY = {
  dialects: {
    defaultKey: 'msa',
    supported: [{ key: 'msa', labelKey: 'content.dialect.msa', bcp47: 'ar' }],
  },
  platforms: [
    {
      key: 'instagram',
      labelKey: 'content.platform.instagram',
      maxBodyChars: 2_200,
      maxHashtags: 30,
      allowsFirstComment: true,
      maxMediaItems: 10,
    },
  ],
  generation: {
    maxVariantsPerRequest: 4,
    maxDraftsPerBrand: 500,
    maxContextItems: 12,
    maxContextChunks: 8,
    maxContextChars: 12_000,
    maxBriefChars: 2_000,
  },
  retention: { cancellationGraceDays: 30, minCustomerRetentionDays: 7 },
  calendar: {
    weekStartsOn: 0,
    maxDaysAhead: 365,
    minLeadMinutes: 5,
    maxSlotsPerDay: 25,
    requireApprovalBeforeScheduling: false,
  },
  learning: {
    preferenceMinObservations: 4,
    preferenceMinPosts: 3,
    workflowMinRepeats: 4,
    windowDays: 90,
    snoozeDays: 30,
  },
  approvals: {
    requireApprovalBeforeScheduling: false,
    allowSelfApproval: false,
    clientApprovalEnabled: false,
    maxNoteLength: 400,
    maxCyclesPerItem: 5,
  },
} satisfies ContentPolicy;

const OWNER = {
  platformUserId: randomUUID(),
  roleKey: 'platform_owner',
  permissionKeys: ['platform.plan.assign'],
  mfaVerified: true,
};

let platform: PrismaClient;
let app: PrismaClient;
let ledger: CreditLedgerService;
let assigner: EntitlementService;

interface Trialing {
  readonly workspaceId: string;
  readonly brandId: string;
  readonly userId: string;
}

async function workspaceWithTrial(trialEndsAt: Date, status: 'TRIALING' | 'EXPIRED') {
  const id = randomUUID();
  const user = await platform.user.create({
    data: { email: `d584-${id}@example.local`, name: 'Trial', status: 'ACTIVE', timezone: 'UTC' },
  });
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      slug: `d584-${id.slice(0, 12)}`,
      name: 'D-584 fixture',
      ownerUserId: user.id,
      status: 'TRIALING',
      country: 'SA',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      planKey: 'd584-plan',
    },
  });
  const brand = await platform.brand.create({
    data: { workspaceId: id, name: 'D-584 brand', slug: `d584-${id.slice(0, 8)}` },
  });
  const start = new Date(trialEndsAt.getTime() - 90 * 86_400_000);
  await platform.workspaceSubscription.create({
    data: {
      workspaceId: id,
      planKey: 'd584-plan',
      status,
      currency: 'USD',
      pinnedMonthlyMinor: 0,
      pinnedAnnualMinor: 0,
      currentPeriodStart: start,
      currentPeriodEnd: trialEndsAt,
      trialStartedAt: start,
      trialEndsAt,
    },
  });
  await ledger.grant({
    workspaceId: id,
    source: 'TRIAL_GRANT',
    credits: 10,
    reason: 'D-584 fixture credits',
    idempotencyKey: `d584-grant-${id}`,
    expiresAt: null,
  });
  return { workspaceId: id, brandId: brand.id, userId: user.id } satisfies Trialing;
}

function reserve(workspaceId: string) {
  return ledger.reserve({
    workspaceId,
    estimateMilliCredits: 1_000n,
    purpose: 'test.d584',
    idempotencyKey: `d584-${randomUUID()}`,
  });
}

function createPost(t: Trialing) {
  return withWorkspace(
    t.workspaceId,
    (db) =>
      new ContentLibraryService({
        db,
        workspaceId: t.workspaceId,
        policy: CONTENT_POLICY,
      }).createManualItem({
        brandId: t.brandId,
        title: 'After the trial',
        locale: 'EN',
        variants: [{ platformKey: 'instagram', body: 'A new post.' }],
        actorUserId: t.userId,
        actorBrandScope: [],
        expiresAt: null,
        idempotencyKey: `d584-${randomUUID()}`,
      }),
    { prisma: app },
  );
}

const TRIAL_ENDED = { code: 'ENTITLEMENT_REQUIRED', publicDetails: { reason: 'TRIAL_ENDED' } };

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  app = appRoleClient();
  ledger = new CreditLedgerService({ prisma: platform, policy: INERT_CREDIT_POLICY });
  assigner = new EntitlementService({
    prisma: platform,
    catalogueSource: new EmptyCatalogue(),
    environment: 'DEVELOPMENT',
    cacheTtlMs: 0,
    ledger,
  });
}, 60_000);

afterAll(async () => {
  await platform?.$disconnect();
  await app?.$disconnect();
});

describe('D-584 — an ended trial is read-only', () => {
  it('an EXPIRED trial reserves no credit, so no AI runs', async () => {
    const t = await workspaceWithTrial(new Date(Date.now() - 86_400_000), 'EXPIRED');
    await expect(reserve(t.workspaceId)).rejects.toMatchObject(TRIAL_ENDED);
  });

  it('a TRIALING row past its end date counts as ended before the sweep runs', async () => {
    const t = await workspaceWithTrial(new Date(Date.now() - 60_000), 'TRIALING');
    await expect(reserve(t.workspaceId)).rejects.toMatchObject(TRIAL_ENDED);
    await expect(createPost(t)).rejects.toMatchObject(TRIAL_ENDED);
  });

  it('no new post can be created, and nothing existing is touched', async () => {
    const t = await workspaceWithTrial(new Date(Date.now() - 86_400_000), 'EXPIRED');
    const before = await platform.contentItem.count({ where: { workspaceId: t.workspaceId } });
    await expect(createPost(t)).rejects.toMatchObject(TRIAL_ENDED);
    expect(await platform.contentItem.count({ where: { workspaceId: t.workspaceId } })).toBe(
      before,
    );
  });

  it('a running trial is unaffected', async () => {
    const t = await workspaceWithTrial(new Date(Date.now() + 10 * 86_400_000), 'TRIALING');
    await expect(reserve(t.workspaceId)).resolves.toMatchObject({ status: 'OPEN' });
    await expect(createPost(t)).resolves.toBeTruthy();
  });

  it("ISOLATION: one workspace's ended trial changes nothing for another", async () => {
    const ended = await workspaceWithTrial(new Date(Date.now() - 86_400_000), 'EXPIRED');
    const running = await workspaceWithTrial(new Date(Date.now() + 86_400_000), 'TRIALING');
    await expect(reserve(ended.workspaceId)).rejects.toMatchObject(TRIAL_ENDED);
    await expect(reserve(running.workspaceId)).resolves.toMatchObject({ status: 'OPEN' });
    await expect(createPost(running)).resolves.toBeTruthy();
  });
});

describe('D-584 — the platform owner extends a trial', () => {
  it('extending an ended trial makes the workspace writable again, audited, with no credits added', async () => {
    const t = await workspaceWithTrial(new Date(Date.now() - 86_400_000), 'EXPIRED');
    const grantsBefore = await platform.creditGrant.count({
      where: { workspaceId: t.workspaceId },
    });

    const { trialEndsAt } = await assigner.extendTrial(
      OWNER,
      t.workspaceId,
      14,
      'Customer asked for more time',
    );
    // From today, not from the old end date.
    expect(trialEndsAt.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);

    const row = await platform.workspaceSubscription.findUniqueOrThrow({
      where: { workspaceId: t.workspaceId },
    });
    expect(row.status).toBe('TRIALING');
    expect(row.trialEndsAt?.getTime()).toBe(trialEndsAt.getTime());
    await expect(reserve(t.workspaceId)).resolves.toMatchObject({ status: 'OPEN' });
    await expect(createPost(t)).resolves.toBeTruthy();

    expect(await platform.creditGrant.count({ where: { workspaceId: t.workspaceId } })).toBe(
      grantsBefore,
    );
    const audit = await platform.auditEvent.findFirst({
      where: { workspaceId: t.workspaceId, action: 'platform.trial.extended' },
    });
    expect(audit?.actorId).toBe(OWNER.platformUserId);
  });

  it('extending a running trial adds to its end date', async () => {
    const end = new Date(Date.now() + 5 * 86_400_000);
    const t = await workspaceWithTrial(end, 'TRIALING');
    const { trialEndsAt } = await assigner.extendTrial(OWNER, t.workspaceId, 7, 'Beta extension');
    expect(trialEndsAt.getTime()).toBe(end.getTime() + 7 * 86_400_000);
  });

  it('refuses a platform user without platform.plan.assign, and changes nothing', async () => {
    const t = await workspaceWithTrial(new Date(Date.now() - 86_400_000), 'EXPIRED');
    await expect(
      assigner.extendTrial(
        { ...OWNER, permissionKeys: [] },
        t.workspaceId,
        14,
        'Not allowed to do this',
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const row = await platform.workspaceSubscription.findUniqueOrThrow({
      where: { workspaceId: t.workspaceId },
    });
    expect(row.status).toBe('EXPIRED');
  });

  it('refuses a paid subscription and a bad number of days', async () => {
    const t = await workspaceWithTrial(new Date(Date.now() - 86_400_000), 'EXPIRED');
    await platform.workspaceSubscription.update({
      where: { workspaceId: t.workspaceId },
      data: { status: 'ACTIVE' },
    });
    await expect(
      assigner.extendTrial(OWNER, t.workspaceId, 14, 'Paid plan, no trial'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      assigner.extendTrial(OWNER, t.workspaceId, 0, 'Zero days is nothing'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
