import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { findUnclaimedIngestionJobs, purgeExpiredChatContent } from '@brandspace/brand-brain';
import { purgeExpiredOutputs } from '@brandspace/ai-gateway';
import { INGEST_SOURCE_DOCUMENT, closeQueues, enqueue, queueFor, queueUrl } from '@brandspace/jobs';
import { appRoleClient, createIsolationFixtures, platformRoleClient } from './fixtures';
import type { IsolationFixtures } from './fixtures';

/**
 * Background maintenance: the retention purge (F-72) and the ingestion
 * reconciliation sweep.
 *
 * BOTH EXISTED AS METHODS AND NEITHER RAN. `purgeExpiredChatContent` was
 * written and tested in Phase 5A and nothing called it on a timer, so D-78's
 * retention window was enforceable and not enforced. Ingestion had no runner at
 * all, so a server action did the parsing inline.
 *
 * THE CLOCK IS INJECTED, NOT WAITED FOR. Every assertion below about "past its
 * window" is made by handing the purge a clock positioned after the window,
 * which is the only way to test a ninety-day retention rule in a test suite that
 * has to finish in a minute — and the only way to assert the NEGATIVE case, that
 * a clock BEFORE the window purges nothing.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;

type ScopedDb = Parameters<Parameters<typeof withWorkspace>[1]>[0];

const at = (iso: string) => ({ now: () => new Date(iso) });

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await closeQueues();
  await app?.$disconnect();
  await platform?.$disconnect();
});

async function inA<T>(fn: (db: ScopedDb) => Promise<T>): Promise<T> {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app });
}

/** One assistant message whose body is past its retention window. */
async function expiredMessage(expiresAt: string, aiRequestId: string | null): Promise<string> {
  return inA(async (db) => {
    const conversation = await db.brandBrainConversation.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        startedByUserId: fixtures.a.userId,
        expiresAt: new Date(expiresAt),
      },
    });
    const message = await db.brandBrainMessage.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        conversationId: conversation.id,
        role: 'ASSISTANT',
        body: 'An answer that quotes approved brand knowledge.',
        citations: [{ kind: 'knowledge', id: 'k1', label: 'Positioning' }],
        expiresAt: new Date(expiresAt),
        idempotencyKey: `purge-${crypto.randomUUID()}`,
        ...(aiRequestId ? { aiRequestId } : {}),
      },
    });
    return message.id;
  });
}

describe('the D-78 retention purge', () => {
  it('clears the body and the citations once the window has passed', async () => {
    const id = await expiredMessage('2026-01-01T00:00:00.000Z', null);

    const purged = await inA(async (db) =>
      purgeExpiredChatContent({ db, clock: at('2026-06-01T00:00:00.000Z') }),
    );
    expect(purged).toBeGreaterThanOrEqual(1);

    const after = await inA(async (db) =>
      db.brandBrainMessage.findUniqueOrThrow({ where: { id } }),
    );
    expect(after.body).toBeNull();
    expect(after.citations).toBeNull();
    expect(after.bodyPurgedAt).not.toBeNull();
  });

  it('purges NOTHING before the window, which is what the window means', async () => {
    const id = await expiredMessage('2027-01-01T00:00:00.000Z', null);

    // A clock positioned before the expiry. The negative case is the one that
    // proves the purge is driven by the window rather than by "everything old".
    await inA(async (db) => purgeExpiredChatContent({ db, clock: at('2026-06-01T00:00:00.000Z') }));

    const after = await inA(async (db) =>
      db.brandBrainMessage.findUniqueOrThrow({ where: { id } }),
    );
    expect(after.body).not.toBeNull();
    expect(after.bodyPurgedAt).toBeNull();
  });

  it('KEEPS THE ROW AND ITS ACCOUNTING. D-78 drops content, never metadata', async () => {
    const aiRequest = await platform.aiRequest.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        taskKey: 'copilot.chat',
        resolvedModelKey: 'mock-fast',
        status: 'SUCCEEDED',
        idempotencyKey: `purge-accounting-${crypto.randomUUID()}`,
        // The charge may never exceed the reservation (a CHECK constraint), so
        // the fixture reserves what it charges — as a real request does.
        creditsReservedMilli: 250n,
        creditsChargedMilli: 250n,
        completedAt: new Date('2026-01-01T00:00:00.000Z'),
        deadlineAt: new Date('2026-01-01T00:05:00.000Z'),
      },
      select: { id: true },
    });
    const id = await expiredMessage('2026-01-01T00:00:00.000Z', aiRequest.id);

    await inA(async (db) => purgeExpiredChatContent({ db, clock: at('2026-06-01T00:00:00.000Z') }));

    const after = await inA(async (db) =>
      db.brandBrainMessage.findUniqueOrThrow({ where: { id } }),
    );
    // The row survives, and with it the link the platform bills and audits on.
    expect(after.aiRequestId).toBe(aiRequest.id);
    expect(after.role).toBe('ASSISTANT');
    expect(after.createdAt).toBeInstanceOf(Date);
    // And the charge itself is untouched: a purge is not a refund.
    const request = await platform.aiRequest.findUniqueOrThrow({ where: { id: aiRequest.id } });
    expect(request.creditsChargedMilli).toBe(250n);
  });

  it('is idempotent: a second pass over the same rows clears nothing', async () => {
    await expiredMessage('2026-01-01T00:00:00.000Z', null);

    const first = await inA(async (db) =>
      purgeExpiredChatContent({ db, clock: at('2026-06-01T00:00:00.000Z') }),
    );
    const second = await inA(async (db) =>
      purgeExpiredChatContent({ db, clock: at('2026-06-01T00:00:00.000Z') }),
    );

    expect(first).toBeGreaterThanOrEqual(1);
    // `bodyPurgedAt` is what makes the second pass a no-op rather than a second
    // pointless write of the same nulls.
    expect(second).toBe(0);
  });

  it('is BOUNDED and makes progress across passes', async () => {
    for (let index = 0; index < 3; index += 1) {
      await expiredMessage('2026-01-01T00:00:00.000Z', null);
    }

    // One row per pass, so a backlog cannot monopolise the database in a single
    // statement — and so repeated passes still drain it.
    const one = await inA(async (db) =>
      purgeExpiredChatContent({ db, clock: at('2026-06-01T00:00:00.000Z'), limit: 1 }),
    );
    expect(one).toBe(1);

    const rest = await inA(async (db) =>
      purgeExpiredChatContent({ db, clock: at('2026-06-01T00:00:00.000Z'), limit: 100 }),
    );
    expect(rest).toBeGreaterThanOrEqual(2);

    const remaining = await inA(async (db) =>
      db.brandBrainMessage.count({
        where: { expiresAt: { lt: new Date('2026-06-01T00:00:00.000Z') }, body: { not: null } },
      }),
    );
    expect(remaining).toBe(0);
  });

  it('does not reach another workspace, even running as a maintenance pass', async () => {
    // The sweep enters each tenant's own context rather than deleting across
    // tenants, so a purge for A must leave B's expired content alone until B's
    // own pass runs. This is the assertion that keeps a maintenance job from
    // becoming a cross-tenant write path.
    const inB = await withWorkspace(
      fixtures.b.workspaceId,
      async (db) => {
        const conversation = await db.brandBrainConversation.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            startedByUserId: fixtures.b.userId,
            expiresAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        });
        const message = await db.brandBrainMessage.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            conversationId: conversation.id,
            role: 'ASSISTANT',
            body: "Workspace B's own answer.",
            expiresAt: new Date('2026-01-01T00:00:00.000Z'),
            idempotencyKey: `purge-b-${crypto.randomUUID()}`,
          },
        });
        return message.id;
      },
      { prisma: app },
    );

    await inA(async (db) =>
      purgeExpiredChatContent({ db, clock: at('2026-06-01T00:00:00.000Z'), limit: 1_000 }),
    );

    const survivor = await withWorkspace(
      fixtures.b.workspaceId,
      async (db) => db.brandBrainMessage.findUniqueOrThrow({ where: { id: inB } }),
      { prisma: app },
    );
    expect(survivor.body).not.toBeNull();
  });
});

describe('the gateway output purge', () => {
  const configuration = (days: number | null) => ({
    load: async () => ({
      providers: [],
      models: [],
      costBases: [],
      routingRules: [
        {
          taskKey: 'copilot.chat',
          scope: 'global' as const,
          planKey: null,
          workspaceId: null,
          primaryModelKey: 'mock-fast',
          fallbackModelKeys: [],
          timeoutMs: 5_000,
          maxCostPerRequestMinor: null,
          priority: 0,
          parameters: {
            temperature: 0.3,
            maxOutputTokens: 128,
            promptTemplateVersion: 1,
            persistOutput: days !== null,
            outputRetentionDays: days,
          },
          retryPolicy: {
            maxAttempts: 1,
            backoff: 'none' as const,
            initialDelayMs: 0,
            jitter: false,
          },
          moderateInput: false,
          moderationModelKey: null,
        },
      ],
      creditRules: [],
      budgets: {
        defaults: {
          creditsPerDayMilli: null,
          creditsPerMonthMilli: null,
          maxConcurrentRequests: null,
        },
        perPlan: [],
      },
    }),
  });

  async function requestWithOutput(completedAt: string): Promise<string> {
    const row = await platform.aiRequest.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        taskKey: 'copilot.chat',
        resolvedModelKey: 'mock-fast',
        status: 'SUCCEEDED',
        idempotencyKey: `gw-purge-${crypto.randomUUID()}`,
        creditsReservedMilli: 100n,
        creditsChargedMilli: 100n,
        completedAt: new Date(completedAt),
        deadlineAt: new Date(completedAt),
        outputPayload: { text: 'A retained answer.' },
      },
      select: { id: true },
    });
    return row.id;
  }

  it('clears a payload past its window and keeps the accounting', async () => {
    const id = await requestWithOutput('2026-01-01T00:00:00.000Z');

    const purged = await purgeExpiredOutputs({
      prisma: platform,
      configuration: configuration(30) as never,
      clock: at('2026-06-01T00:00:00.000Z'),
    });
    expect(purged).toBeGreaterThanOrEqual(1);

    const after = await platform.aiRequest.findUniqueOrThrow({ where: { id } });
    expect(after.outputPayload).toBeNull();
    // Everything the platform bills and audits on is still there.
    expect(after.creditsChargedMilli).toBe(100n);
    expect(after.status).toBe('SUCCEEDED');
    expect(after.taskKey).toBe('copilot.chat');
  });

  it('purges nothing when the rule sets no window', async () => {
    const id = await requestWithOutput('2026-01-01T00:00:00.000Z');

    // No window means no commitment to clear it, and inventing one here would
    // be deciding a retention policy in code (CLAUDE.md §2.2).
    await purgeExpiredOutputs({
      prisma: platform,
      configuration: configuration(null) as never,
      clock: at('2026-06-01T00:00:00.000Z'),
    });

    const after = await platform.aiRequest.findUniqueOrThrow({ where: { id } });
    expect(after.outputPayload).not.toBeNull();
  });

  it('is idempotent', async () => {
    await requestWithOutput('2026-01-01T00:00:00.000Z');
    const options = {
      prisma: platform,
      configuration: configuration(30) as never,
      clock: at('2026-06-01T00:00:00.000Z'),
    };
    expect(await purgeExpiredOutputs(options)).toBeGreaterThanOrEqual(1);
    expect(await purgeExpiredOutputs(options)).toBe(0);
  });
});

describe('the ingestion reconciliation sweep', () => {
  /** One ingestion job in a given stage, with its own source document. */
  async function job(stage: 'QUEUED' | 'EXTRACTING' | 'FAILED', nextAttemptAt: Date | null) {
    return inA(async (db) => {
      const document = await db.brandSourceDocument.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          fileName: 'sweep.txt',
          mimeType: 'text/plain',
          byteSize: 12,
          checksum: crypto.randomUUID().replace(/-/g, ''),
          storageKey: `sweep/${crypto.randomUUID()}`,
          status: 'UPLOADED',
          idempotencyKey: `sweep-${crypto.randomUUID()}`,
          uploadedByUserId: fixtures.a.userId,
        },
      });
      return db.brandIngestionJob.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          sourceDocumentId: document.id,
          stage,
          ...(nextAttemptAt ? { nextAttemptAt } : {}),
        },
      });
    });
  }

  it('finds a queued job whose attempt is due, and leaves the rest alone', async () => {
    const due = await job('QUEUED', null);
    const backingOff = await job('QUEUED', new Date(Date.now() + 60 * 60_000));
    // EXTRACTING is this pipeline's "a worker is on it".
    const running = await job('EXTRACTING', null);
    const failed = await job('FAILED', null);

    const found = await inA(async (db) => findUnclaimedIngestionJobs(db, new Date(), 500));
    const ids = new Set(found.map((entry) => entry.id));

    expect(ids.has(due.id)).toBe(true);
    // Still backing off after a retryable failure: dispatching it now would
    // spend the attempt early.
    expect(ids.has(backingOff.id)).toBe(false);
    // A worker holds a lock on it; the processor would discard the message.
    expect(ids.has(running.id)).toBe(false);
    expect(ids.has(failed.id)).toBe(false);
  });

  it('is bounded and deterministic', async () => {
    await job('QUEUED', null);
    await job('QUEUED', null);

    const first = await inA(async (db) => findUnclaimedIngestionJobs(db, new Date(), 1));
    const second = await inA(async (db) => findUnclaimedIngestionJobs(db, new Date(), 1));

    expect(first).toHaveLength(1);
    // The same pass twice returns the same row: oldest first with an id
    // tie-break, so a bounded sweep cannot starve one job by luck of ordering.
    expect(second[0]?.id).toBe(first[0]?.id);
  });

  it('dispatches a queued job, and refuses to dispatch it twice', async () => {
    if (!queueUrl()) {
      throw new Error(
        'REDIS_URL is not configured. The queue path is the point of this test; ' +
          'skipping it would leave the background-job architecture unproven.',
      );
    }

    const jobId = crypto.randomUUID();
    const payload = {
      kind: INGEST_SOURCE_DOCUMENT,
      workspaceId: fixtures.a.workspaceId,
      idempotencyKey: `ingest-${jobId}`,
      ingestionJobId: jobId,
    } as const;

    const queue = queueFor('media-processing');
    await queue.remove(payload.idempotencyKey).catch(() => undefined);

    // A DELTA, not an absolute count. The queue is shared with whatever else
    // this environment is running, and a test that asserts "the queue holds
    // exactly one job" fails for reasons that have nothing to do with it.
    const pending = async (): Promise<number> => {
      const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
      return (counts['waiting'] ?? 0) + (counts['delayed'] ?? 0) + (counts['active'] ?? 0);
    };
    const before = await pending();

    const first = await enqueue('media-processing', INGEST_SOURCE_DOCUMENT, payload);
    expect(first.dispatched).toBe(true);

    const queued = await queue.getJob(payload.idempotencyKey);
    expect(queued).not.toBeNull();
    // THE PAYLOAD IS A POINTER. No file name, no bytes, no extracted text:
    // Redis is not tenant-isolated and is not encrypted at rest the way the
    // database is.
    expect(Object.keys(queued?.data ?? {}).sort()).toEqual([
      'idempotencyKey',
      'ingestionJobId',
      'kind',
      'workspaceId',
    ]);

    expect(await pending()).toBe(before + 1);

    // The SECOND dispatch — a reconciler racing the producer — adds nothing,
    // because the idempotency key IS the job id and BullMQ refuses a duplicate.
    // Without that, every sweep would queue another parse of the same document.
    await enqueue('media-processing', INGEST_SOURCE_DOCUMENT, payload);
    expect(await pending()).toBe(before + 1);
    expect((await queue.getJob(payload.idempotencyKey))?.timestamp).toBe(queued?.timestamp);

    await queue.remove(payload.idempotencyKey).catch(() => undefined);
  });
});

beforeEach(async () => {
  // Nothing to reset: every test above creates its own rows and asserts on
  // those. Declared so the intent is explicit rather than absent.
});
