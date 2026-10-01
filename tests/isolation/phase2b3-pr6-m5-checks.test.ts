import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIsolationFixtures,
  platformRoleClient,
  appRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2B-3 PR 6 — M5b'S THREE CHECKS, AGAINST REAL POSTGRESQL.
 *
 *   - a lease id exists exactly while the run is EXECUTING;
 *   - a run waiting for, or held by, the executor always says when it is due;
 *   - the attempt count stays within 0..20.
 *
 * Every existing run already satisfies all three: NULL, NULL and 0.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let ruleId: string;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  const rule = await platform.automationRule.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      name: `pr6 m5 ${randomUUID()}`,
      enabled: false,
      triggerType: 'SCHEDULE_GAP',
      triggerConfig: {},
      conditions: [],
      actionType: 'DRAFT_IDEAS',
      actionConfig: {},
      createdByUserId: fixtures.a.userId,
    },
    select: { id: true },
  });
  ruleId = rule.id;
}, 90_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

type RunShape = {
  status: 'RUNNING' | 'AWAITING_EXECUTION' | 'EXECUTING' | 'SUCCEEDED';
  executionLeaseId?: string | null;
  executionAvailableAt?: Date | null;
  executionAttempts?: number;
};

async function insert(shape: RunShape): Promise<string | null> {
  try {
    await platform.automationRun.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        ruleId,
        triggerType: 'SCHEDULE_GAP',
        idempotencyKey: `pr6-m5-${randomUUID()}`,
        actionType: 'DRAFT_IDEAS',
        correlationId: randomUUID(),
        ...shape,
      },
    });
    return null;
  } catch (error) {
    return String((error as Error).message);
  }
}

const due = new Date('2026-10-15T09:00:00.000Z');

describe('M5b — the lease CHECKs', () => {
  it('an existing run shape (no lease, nothing due, 0 attempts) is accepted', async () => {
    expect(await insert({ status: 'RUNNING' })).toBeNull();
    expect(await insert({ status: 'SUCCEEDED', executionAttempts: 1 })).toBeNull();
  });

  it('a lease exists exactly while EXECUTING', async () => {
    expect(
      await insert({
        status: 'EXECUTING',
        executionLeaseId: randomUUID(),
        executionAvailableAt: due,
      }),
    ).toBeNull();
    expect(await insert({ status: 'EXECUTING', executionAvailableAt: due })).toContain(
      'automation_run_execution_lease_matches_status',
    );
    expect(
      await insert({
        status: 'AWAITING_EXECUTION',
        executionLeaseId: randomUUID(),
        executionAvailableAt: due,
      }),
    ).toContain('automation_run_execution_lease_matches_status');
    expect(await insert({ status: 'SUCCEEDED', executionLeaseId: randomUUID() })).toContain(
      'automation_run_execution_lease_matches_status',
    );
  });

  it('a waiting or executing run always says when it is due', async () => {
    expect(await insert({ status: 'AWAITING_EXECUTION', executionAvailableAt: due })).toBeNull();
    expect(await insert({ status: 'AWAITING_EXECUTION' })).toContain(
      'automation_run_execution_due_is_set',
    );
    expect(await insert({ status: 'EXECUTING', executionLeaseId: randomUUID() })).toContain(
      'automation_run_execution_due_is_set',
    );
  });

  it('the attempt count stays within 0..20', async () => {
    expect(await insert({ status: 'SUCCEEDED', executionAttempts: 20 })).toBeNull();
    expect(await insert({ status: 'SUCCEEDED', executionAttempts: 21 })).toContain(
      'automation_run_execution_attempts_bounded',
    );
    expect(await insert({ status: 'SUCCEEDED', executionAttempts: -1 })).toContain(
      'automation_run_execution_attempts_bounded',
    );
  });
});
