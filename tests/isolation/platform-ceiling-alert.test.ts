import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigurationService } from '@brandspace/config';
import { platformCeilingNotice } from '../../apps/admin/src/server/platform-ceiling';
import { createIsolationFixtures, appRoleClient, type IsolationFixtures } from './fixtures';
import { captureConfig, type ActivatedConfig } from './config-activation';

/**
 * D-573 FOLLOW-UP (#91 review) — THE OWNER'S ALERT, END TO END.
 *
 *   1. `alertPlatformOwner` raises each crossing ONCE per period and threshold
 *      even when two separate PROCESSES raise it at the same moment: one audit
 *      event, and exactly one email to each active platform owner.
 *   2. Control Center Home's notice (`loadPlatformCeiling`) reads the platform
 *      spend from real rows against `ai.budgets.platform` and names the highest
 *      level reached.
 */

const run = promisify(execFile);
const CHILD = path.join(__dirname, 'helpers', 'platform-alert-child.ts');
const ACTION = 'ai.platform_ceiling.threshold_reached';

let platform: PrismaClient;
let fixtures: IsolationFixtures;
let budgets: ActivatedConfig;
const createdRequestIds: string[] = [];

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  fixtures = await createIsolationFixtures(appRoleClient());
  budgets = await captureConfig(platform, 'ai.budgets', { projected: false });
}, 90_000);

afterAll(async () => {
  await budgets?.restore();
  if (createdRequestIds.length > 0) {
    await platform.aiRequest.deleteMany({ where: { id: { in: createdRequestIds } } });
  }
  await platform?.$disconnect();
});

/** A period nobody else will ever use, so the de-duplication record is this run's alone. */
function uniquePeriodStart(): Date {
  const year = 2200 + Math.floor(Math.random() * 700);
  const month = Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  return new Date(Date.UTC(year, month, day));
}

function raiseInChild(crossings: unknown[], startAt = Date.now()): Promise<{ stdout: string }> {
  return run(
    process.execPath,
    ['--import', 'tsx', CHILD, JSON.stringify(crossings), String(startAt)],
    {
      env: process.env,
      cwd: path.join(__dirname, '..', '..'),
      timeout: 60_000,
    },
  );
}

describe('D-573 · the owner is alerted once, across processes', () => {
  it('four processes raising the same crossings at once write one audit event each, and one email per owner', async () => {
    const periodStart = uniquePeriodStart();
    const crossings = [80, 100].map((thresholdPercent) => ({
      period: 'day',
      periodStart: periodStart.toISOString(),
      thresholdPercent,
      ceilingMicroMinor: 500_000_000,
      spentMicroMinor: String(thresholdPercent * 5_000_000),
      currency: 'USD',
    }));
    const reasons = [80, 100].map((t) => `day:${periodStart.toISOString().slice(0, 10)}:${t}`);
    const owners = await platform.platformUser.findMany({
      where: { status: 'ACTIVE', role: { key: 'platform_owner' } },
      select: { email: true },
    });
    expect(owners.length).toBeGreaterThan(0);
    const startedAt = new Date();

    // Four separate processes, each connected first, all raising at one instant.
    const startAt = Date.now() + 8_000;
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => raiseInChild(crossings, startAt)),
    );
    for (const outcome of outcomes) {
      // The child's own log lines come first; its last line says it finished.
      expect(outcome.stdout.trim().split('\n').at(-1)).toBe('done');
    }

    for (const reason of reasons) {
      const events = await platform.auditEvent.findMany({
        where: { action: ACTION, reason, workspaceId: null },
        select: { severity: true, after: true, actorType: true },
      });
      expect(events, reason).toHaveLength(1);
      expect(events[0]?.actorType).toBe('SYSTEM');
      expect(events[0]?.severity).toBe(reason.endsWith(':100') ? 'CRITICAL' : 'WARNING');
    }

    // Both crossings were new, so the one process that raised them sent ONE email per owner.
    const emails = await platform.emailMessage.findMany({
      where: { templateKey: 'platform.ai_spend_alert', createdAt: { gte: startedAt } },
      select: { toEmail: true },
    });
    expect(emails.map((e) => e.toEmail.toLowerCase()).sort()).toEqual(
      owners.map((o) => o.email.toLowerCase()).sort(),
    );

    // Raising the same crossings again changes nothing at all.
    await raiseInChild(crossings);
    for (const reason of reasons) {
      expect(
        await platform.auditEvent.count({ where: { action: ACTION, reason, workspaceId: null } }),
      ).toBe(1);
    }
    expect(
      await platform.emailMessage.count({
        where: { templateKey: 'platform.ai_spend_alert', createdAt: { gte: startedAt } },
      }),
    ).toBe(owners.length);
  }, 120_000);
});

describe('D-573 · the Home notice reads real spend against the platform ceiling', () => {
  async function spendNow(): Promise<bigint> {
    const { measurePlatformSpend } = await import('@brandspace/ai-gateway');
    return (await measurePlatformSpend(platform, new Date())).todayMicroMinor;
  }

  async function inFlight(estimate: bigint): Promise<void> {
    const row = await platform.aiRequest.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        taskKey: 'caption.generate',
        idempotencyKey: `ceiling-notice-${randomUUID()}`,
        routingTaskKey: 'caption.generate',
        resolvedModelKey: 'notice-fixture',
        status: 'PENDING',
        attemptedModelKeys: [],
        inputSummary: { kind: 'text', promptChars: 0, contextParts: 0 },
        creditsReservedMilli: 0n,
        deadlineAt: new Date(Date.now() + 60_000),
        providerCostEstimateMicroMinor: estimate,
      },
      select: { id: true },
    });
    createdRequestIds.push(row.id);
  }

  /** The same reading Control Center Home makes (`loadPlatformCeiling`), on real rows. */
  async function notice() {
    return platformCeilingNotice({
      configuration: new ConfigurationService({ prisma: platform, cacheTtlMs: 0 }),
      prisma: platform,
      environment: 'DEVELOPMENT',
    });
  }

  it('no ceiling, no notice', async () => {
    await budgets.activate({
      platform: {
        providerCostPerDayMicroMinor: null,
        providerCostPerMonthMicroMinor: null,
        currency: 'USD',
      },
    });
    expect(await notice()).toBeNull();
  });

  it('below 80% nothing; at 80% a warning; at 100% paused; the month outranks the day', async () => {
    await inFlight(1_000_000n);
    const spent = await spendNow();
    expect(spent).toBeGreaterThan(0n);

    const day = (ceiling: bigint, month: bigint | null = null) =>
      budgets.activate({
        platform: {
          providerCostPerDayMicroMinor: Number(ceiling),
          providerCostPerMonthMicroMinor: month === null ? null : Number(month),
          currency: 'USD',
        },
      });

    await day((spent * 100n) / 70n);
    expect(await notice()).toBeNull();

    await day((spent * 100n) / 85n);
    expect(await notice()).toEqual({ period: 'day', percent: 80 });

    await day(spent);
    expect(await notice()).toEqual({ period: 'day', percent: 100 });

    // A monthly ceiling at 100% outranks a daily one at 100%.
    const month = await spendNow();
    await day(spent, month);
    expect(await notice()).toEqual({ period: 'month', percent: 100 });
  });
});
