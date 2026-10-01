import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import {
  AUTOMATION_AI_ACTIONS_FEATURE,
  createAutomationAiQuota,
  type AutomationAiQuota,
} from '@brandspace/entitlements';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2B-3 PR 6 — THE AI CAP'S CLAIM AND RELEASE, AGAINST REAL POSTGRESQL.
 *
 * The limit comes from the active configuration (a fixture plan written below
 * for the test's own workspace) through `TenantCatalogueSource`; the month is
 * a fixed label, never today's.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const LABEL = '2031-04';

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 90_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

const inA = <T>(fn: (quota: AutomationAiQuota) => Promise<T>) =>
  withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        createAutomationAiQuota({
          db,
          workspaceId: fixtures.a.workspaceId,
          environment: 'DEVELOPMENT',
        }),
      ),
    { prisma: app },
  ) as Promise<T>;

async function counter(workspaceId: string, label = LABEL): Promise<number | null> {
  const row = await platform.usageCounter.findFirst({
    where: {
      workspaceId,
      featureKey: AUTOMATION_AI_ACTIONS_FEATURE,
      periodStart: new Date(`${label}-01T00:00:00.000Z`),
    },
    select: { usedValue: true },
  });
  return row?.usedValue ?? null;
}

describe('claim and release', () => {
  it('a workspace whose plan does not set the cap claims nothing', async () => {
    expect(await inA((quota) => quota.limit())).toBe(0);
    expect(await inA((quota) => quota.claim(randomUUID(), LABEL))).toBe('cap_reached');
    expect(await counter(fixtures.a.workspaceId)).toBeNull();
  });

  it('at a cap of 2: two claims, the third refused, one row per month label', async () => {
    // A workspace override, not a shared plan snapshot: this test's own
    // workspace gets its own cap and nothing global moves.
    await platform.workspaceOverride.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        featureKey: AUTOMATION_AI_ACTIONS_FEATURE,
        enabled: true,
        limitValue: 2,
        reason: 'PR 6 cap counter fixture',
        grantedByPlatformUserId: fixtures.platformUserId,
      },
    });
    expect(await inA((quota) => quota.limit())).toBe(2);

    const [r1, r2, r3] = [randomUUID(), randomUUID(), randomUUID()];
    expect(await inA((quota) => quota.claim(r1, LABEL))).toBe('claimed');
    expect(await inA((quota) => quota.claim(r2, LABEL))).toBe('claimed');
    expect(await inA((quota) => quota.claim(r3, LABEL))).toBe('cap_reached');
    expect(await counter(fixtures.a.workspaceId)).toBe(2);

    // A replayed claim is the same claim, not a third.
    expect(await inA((quota) => quota.claim(r1, LABEL))).toBe('claimed');
    expect(await counter(fixtures.a.workspaceId)).toBe(2);

    // Another month is another row.
    expect(await inA((quota) => quota.claim(randomUUID(), '2031-05'))).toBe('claimed');
    expect(await counter(fixtures.a.workspaceId, '2031-05')).toBe(1);
    expect(await counter(fixtures.a.workspaceId)).toBe(2);

    // Released exactly once, however often it is asked.
    await inA((quota) => quota.release(r1, LABEL));
    await inA((quota) => quota.release(r1, LABEL));
    expect(await counter(fixtures.a.workspaceId)).toBe(1);

    // A run that never claimed gives nothing back.
    await inA((quota) => quota.release(r3, LABEL));
    await inA((quota) => quota.release(randomUUID(), LABEL));
    expect(await counter(fixtures.a.workspaceId)).toBe(1);

    // The freed slot can be taken again.
    expect(await inA((quota) => quota.claim(randomUUID(), LABEL))).toBe('claimed');
    expect(await counter(fixtures.a.workspaceId)).toBe(2);

    // Workspace B never moved.
    expect(await counter(fixtures.b.workspaceId)).toBeNull();
  });
});
