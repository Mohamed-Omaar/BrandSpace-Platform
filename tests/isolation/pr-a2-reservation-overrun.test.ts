import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alertReservationOverrun,
  RESERVATION_OVERRUN_ALERT_ACTION,
} from '../../apps/api/src/ai-gateway-factory';

/**
 * PR A2 (item 12, F-107) — THE OWNER HEARS WHEN A REQUEST OUTRAN ITS
 * RESERVATION. Once per UTC day, task and model, even when several requests
 * raise it at the same moment: one audit event (keys and counts, no content)
 * and one fixed-text email to each active platform owner.
 */
let platform: PrismaClient;

beforeAll(() => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
});

afterAll(async () => {
  await platform?.$disconnect();
});

describe('PR A2 (item 12) — the reservation-overrun alert', () => {
  it('raised at once by several requests, it is one audit event and one email per owner', async () => {
    const taskKey = `caption.generate.${randomUUID().slice(0, 8)}`;
    // A day nobody else uses, so the de-duplication record is this run's alone.
    const now = new Date(Date.UTC(2300 + Math.floor(Math.random() * 600), 0, 1));
    const reason = `overrun:${now.toISOString().slice(0, 10)}:${taskKey}:gpt-5.4-mini`;
    const overrun = {
      requestId: randomUUID(),
      taskKey,
      modelKey: 'gpt-5.4-mini',
      reservedMilli: 2000n,
      meteredMilli: 3000n,
      overrunPercent: 50,
      thresholdPercent: 25,
    };
    const owners = await platform.platformUser.findMany({
      where: { status: 'ACTIVE', role: { key: 'platform_owner' } },
      select: { email: true },
    });
    expect(owners.length).toBeGreaterThan(0);
    const startedAt = new Date();

    const raised = await Promise.all(
      Array.from({ length: 4 }, () => alertReservationOverrun(overrun, now)),
    );
    expect(raised.filter(Boolean)).toHaveLength(1);

    const events = await platform.auditEvent.findMany({
      where: { action: RESERVATION_OVERRUN_ALERT_ACTION, reason, workspaceId: null },
      select: { severity: true, actorType: true, after: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ severity: 'WARNING', actorType: 'SYSTEM' });
    expect(events[0]?.after).toEqual({
      taskKey,
      modelKey: 'gpt-5.4-mini',
      reservedMilliCredits: '2000',
      meteredMilliCredits: '3000',
      overrunPercent: 50,
      thresholdPercent: 25,
    });

    const emails = await platform.emailMessage.findMany({
      where: { templateKey: 'platform.ai_reservation_overrun', createdAt: { gte: startedAt } },
      select: { toEmail: true },
    });
    expect(emails.map((e) => e.toEmail.toLowerCase()).sort()).toEqual(
      owners.map((o) => o.email.toLowerCase()).sort(),
    );

    // The same day, task and model again: nothing more.
    expect(await alertReservationOverrun(overrun, now)).toBe(false);
    expect(
      await platform.emailMessage.count({
        where: { templateKey: 'platform.ai_reservation_overrun', createdAt: { gte: startedAt } },
      }),
    ).toBe(owners.length);
  }, 60_000);
});
