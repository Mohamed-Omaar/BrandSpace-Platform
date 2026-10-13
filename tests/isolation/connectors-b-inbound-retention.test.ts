import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueues } from '@brandspace/jobs';
import { parsePublishingPolicy } from '@brandspace/social-connectors';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import { platformRoleClient } from './fixtures';

/**
 * CONNECTORS B — WHAT PURGES OLD `social_inbound_event` ROWS, AND AFTER HOW
 * LONG, AGAINST REAL POSTGRESQL.
 *
 * The maintenance scheduler's `purgeInboundEvents` (on the retention cadence,
 * and in every `runOnce`) deletes deliveries that FINISHED — processed,
 * ignored or failed — more than `publishing.inbound.retentionDays` ago. The
 * period is configuration: the same rows are kept under one period and
 * deleted under a shorter one. A delivery still waiting or being processed is
 * never purged, whatever its age, and a data-deletion request outlives its
 * delivery.
 *
 * Driven by an injected clock in 2099, so only this suite's rows are old.
 */

let platform: PrismaClient;
const NOW = new Date(Date.UTC(2099, 0, 31, 12, 0));
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const SUBJECT = `v1:${'c'.repeat(64)}`;

const purge = (retentionDays: number, purgeBatchSize = 500) =>
  new MaintenanceScheduler({
    environment: 'DEVELOPMENT',
    clock: { now: () => NOW },
    publishingPolicy: parsePublishingPolicy({ inbound: { retentionDays, purgeBatchSize } }),
  }).purgeInboundEvents();

async function delivery(
  status: 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'IGNORED' | 'FAILED',
  finishedDaysAgo: number,
  kind: 'WEBHOOK' | 'DATA_DELETION' = 'WEBHOOK',
) {
  const finished = ['PROCESSED', 'IGNORED', 'FAILED'].includes(status);
  return platform.socialInboundEvent.create({
    data: {
      provider: 'FACEBOOK',
      kind,
      dedupeKey: sha(randomUUID()),
      ...(kind === 'WEBHOOK' ? {} : { subjectHash: SUBJECT }),
      payload: { object: 'page' },
      status,
      receivedAt: daysAgo(finishedDaysAgo),
      ...(finished ? { processedAt: daysAgo(finishedDaysAgo) } : {}),
      ...(status === 'PROCESSING'
        ? { claimToken: randomUUID(), claimedAt: daysAgo(finishedDaysAgo) }
        : {}),
    },
  });
}

const exists = async (id: string) =>
  (await platform.socialInboundEvent.count({ where: { id } })) === 1;

beforeAll(() => {
  platform = platformRoleClient();
});

afterAll(async () => {
  await closeQueues();
  await platform?.$disconnect();
});

describe('connectors B · inbound deliveries are kept for the configured period, then purged', () => {
  it('a finished delivery older than the period is deleted; a newer one is kept', async () => {
    const old = await delivery('PROCESSED', 31);
    const recent = await delivery('PROCESSED', 29);
    const oldIgnored = await delivery('IGNORED', 45);
    const oldFailed = await delivery('FAILED', 60);

    expect(await purge(30)).toBeGreaterThanOrEqual(3);

    expect(await exists(old.id)).toBe(false);
    expect(await exists(oldIgnored.id)).toBe(false);
    expect(await exists(oldFailed.id)).toBe(false);
    expect(await exists(recent.id)).toBe(true);
  });

  it('the period is configuration: kept under 60 days, purged under 7', async () => {
    const row = await delivery('PROCESSED', 20);
    expect(await purge(60)).toBe(0);
    expect(await exists(row.id)).toBe(true);
    expect(await purge(7)).toBeGreaterThanOrEqual(1);
    expect(await exists(row.id)).toBe(false);
  });

  it('a delivery still waiting or being processed is never purged, whatever its age', async () => {
    const waiting = await delivery('RECEIVED', 400);
    const claimed = await delivery('PROCESSING', 400);
    await purge(1);
    expect(await exists(waiting.id)).toBe(true);
    expect(await exists(claimed.id)).toBe(true);
    // Leave nothing behind that a later run of this suite could trip on.
    await platform.socialInboundEvent.deleteMany({
      where: { id: { in: [waiting.id, claimed.id] } },
    });
  });

  it('a data-deletion request outlives its purged delivery', async () => {
    const delivered = await delivery('PROCESSED', 90, 'DATA_DELETION');
    const request = await platform.socialDataDeletionRequest.create({
      data: {
        provider: 'FACEBOOK',
        subjectHash: SUBJECT,
        confirmationCode: `R${randomUUID().replace(/-/g, '')}`,
        inboundEventId: delivered.id,
      },
    });
    await purge(30);
    expect(await exists(delivered.id)).toBe(false);
    const kept = await platform.socialDataDeletionRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(kept.inboundEventId).toBeNull();
  });

  it('one pass deletes at most the configured batch, oldest first, and a rerun deletes nothing twice', async () => {
    const rows = [];
    for (let age = 100; age < 105; age += 1) rows.push(await delivery('PROCESSED', age));
    expect(await purge(30, 2)).toBe(2);
    // The two oldest went first.
    expect(await exists(rows[4]!.id)).toBe(false);
    expect(await exists(rows[3]!.id)).toBe(false);
    expect(await exists(rows[0]!.id)).toBe(true);
    expect(await purge(30, 500)).toBe(3);
    expect(await purge(30, 500)).toBe(0);
  });
});
