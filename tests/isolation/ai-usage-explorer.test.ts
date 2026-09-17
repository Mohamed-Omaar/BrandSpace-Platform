import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AI_USAGE_READ_PERMISSION,
  AiUsageExplorer,
  DEFAULT_AI_PAGE_SIZE,
  MAX_AI_PAGE_SIZE,
  type AiExplorerActor,
} from '@brandspace/ai-gateway';

/**
 * The AI usage explorer — docs/AI-GATEWAY.md §12, docs/ADMIN-CONTROL-CENTER.md §7.1.
 *
 * The contract these tests defend is F-53 / A-11: PAGED, WITH A TRUTHFUL
 * TOTAL. A silent cap here would be worse than most, because an operator
 * reading "47 failures" would act on it and the number would be a lie about a
 * financial record.
 *
 * The suite provisions its own rows so the counts are exact, and the residue
 * from other suites is excluded by filtering on this run's workspaces —
 * asserting against a global total would make these tests depend on whatever
 * else ran first.
 */

const TASK_KEY = 'caption.generate';
const MODEL_KEY = 'mock-fast';

let platform: PrismaClient;
let explorer: AiUsageExplorer;

const CREATED_WORKSPACE_IDS: string[] = [];

function actor(permissions: readonly string[] = [AI_USAGE_READ_PERMISSION]): AiExplorerActor {
  return { platformUserId: '00000000-0000-4000-8000-0000000000ff', permissionKeys: permissions };
}

async function freshWorkspace(): Promise<string> {
  const run = crypto.randomUUID();
  const user = await platform.user.create({
    data: {
      email: `exp-${run}@example.local`,
      name: 'Explorer Fixture',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  const workspace = await platform.workspace.create({
    data: {
      country: 'US',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      id: run,
      workspaceId: run,
      slug: `exp-${run.slice(0, 12)}`,
      name: 'Explorer Fixture Workspace',
      ownerUserId: user.id,
      status: 'ACTIVE',
    },
  });
  CREATED_WORKSPACE_IDS.push(workspace.id);
  return workspace.id;
}

/** A completed request with one ledger row, so totals are exact and checkable. */
async function recordRequest(
  workspaceId: string,
  overrides: {
    status?: 'SUCCEEDED' | 'FAILED' | 'RUNNING';
    creditsChargedMilli?: bigint;
    providerCostMicroMinor?: bigint;
    modelKey?: string;
    createdAt?: Date;
    deadlineAt?: Date;
    withLedger?: boolean;
  } = {},
): Promise<string> {
  const status = overrides.status ?? 'SUCCEEDED';
  const charged = overrides.creditsChargedMilli ?? (status === 'SUCCEEDED' ? 175n : 0n);
  const modelKey = overrides.modelKey ?? MODEL_KEY;

  const row = await platform.aiRequest.create({
    data: {
      workspaceId,
      taskKey: TASK_KEY,
      idempotencyKey: `exp-${crypto.randomUUID()}`,
      resolvedModelKey: modelKey,
      attemptedModelKeys: [modelKey],
      status,
      /*
       * Always at least what is charged.
       *
       * `ai_request_charge_within_reservation` refuses anything else — and
       * refused an earlier version of this fixture, which is the constraint
       * working. A settle narrows a reservation; it never widens one.
       */
      creditsReservedMilli: charged > 500n ? charged : 500n,
      creditsChargedMilli: charged,
      providerCostMicroMinor: overrides.providerCostMicroMinor ?? 19_500n,
      deadlineAt: overrides.deadlineAt ?? new Date(Date.now() + 600_000),
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });

  if (overrides.withLedger !== false) {
    await platform.aiUsageLedger.create({
      data: {
        workspaceId,
        aiRequestId: row.id,
        taskKey: TASK_KEY,
        providerKey: 'mock',
        modelKey,
        usageUnits: { promptTokens: 500, completionTokens: 200 },
        providerCostMicroMinor: overrides.providerCostMicroMinor ?? 19_500n,
        creditsChargedMilli: charged,
        environment: 'DEVELOPMENT',
      },
    });
  }
  return row.id;
}

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  explorer = new AiUsageExplorer({ prisma: platform });
}, 90_000);

afterAll(async () => {
  // Only non-terminal rows: a terminal request has an immutable ledger entry
  // behind it, and the append-only guarantee has no test-suite exemption.
  if (platform && CREATED_WORKSPACE_IDS.length > 0) {
    await platform.aiRequest.deleteMany({
      where: {
        workspaceId: { in: CREATED_WORKSPACE_IDS },
        status: { in: ['PENDING', 'RESERVED', 'RUNNING'] },
      },
    });
  }
  await platform?.$disconnect();
});

describe('authorization', () => {
  it('refuses a caller without the AI usage permission', async () => {
    const workspaceId = await freshWorkspace();

    // The service checks, rather than trusting the page that built it: a page
    // guard and a service guard are two controls, and only one survives a
    // refactor.
    await expect(explorer.requests(actor([]), { workspaceId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('does not accept "view any workspace" as AI usage access', async () => {
    // R-02's shape: the configuration screens once rode on a permission every
    // admin-capable role holds.
    await expect(explorer.requests(actor(['platform.workspace.read']))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('gates the inspector, the rollup and the leak count too', async () => {
    const workspaceId = await freshWorkspace();
    const requestId = await recordRequest(workspaceId);

    await expect(explorer.request(actor([]), requestId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(explorer.rollup(actor([]), 'modelKey')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(explorer.leakCount(actor([]))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('the pagination contract', () => {
  it('reports a total that counts every match, not just this page', async () => {
    const workspaceId = await freshWorkspace();
    for (let i = 0; i < 7; i += 1) await recordRequest(workspaceId);

    const page = await explorer.requests(actor(), { workspaceId, pageSize: 3 });

    // The number that made the old 200-row caps silent was a missing total.
    expect(page.total).toBe(7);
    expect(page.items).toHaveLength(3);
    expect(page.totalPages).toBe(3);
    expect(page.from).toBe(1);
    expect(page.to).toBe(3);
    expect(page.hasNext).toBe(true);
    expect(page.hasPrevious).toBe(false);
  });

  it('makes every record reachable by paging', async () => {
    const workspaceId = await freshWorkspace();
    const created = new Set<string>();
    for (let i = 0; i < 7; i += 1) created.add(await recordRequest(workspaceId));

    const seen = new Set<string>();
    for (let page = 1; page <= 3; page += 1) {
      const result = await explorer.requests(actor(), { workspaceId, page, pageSize: 3 });
      for (const item of result.items) seen.add(item.id);
    }

    // A page-size cap bounds ONE REQUEST, never what an operator may see.
    expect(seen).toEqual(created);
  });

  it('clamps an out-of-range page to the last one instead of showing nothing', async () => {
    const workspaceId = await freshWorkspace();
    for (let i = 0; i < 4; i += 1) await recordRequest(workspaceId);

    // An operator who bookmarked page 9 and then filtered down gets the last
    // page, not a blank screen that looks like data loss.
    const page = await explorer.requests(actor(), { workspaceId, page: 99, pageSize: 3 });
    expect(page.page).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.to).toBe(4);
  });

  it('caps one request without hiding rows behind the cap', async () => {
    const workspaceId = await freshWorkspace();
    await recordRequest(workspaceId);

    const page = await explorer.requests(actor(), { workspaceId, pageSize: 100_000 });
    expect(page.pageSize).toBe(MAX_AI_PAGE_SIZE);
    // The total still tells the truth about how many exist.
    expect(page.total).toBe(1);
  });

  it('falls back to the default size for nonsense input', async () => {
    const workspaceId = await freshWorkspace();
    await recordRequest(workspaceId);

    for (const pageSize of [0, -5, Number.NaN]) {
      const page = await explorer.requests(actor(), { workspaceId, pageSize });
      expect(page.pageSize, String(pageSize)).toBe(DEFAULT_AI_PAGE_SIZE);
    }
  });

  it('reports an empty result honestly rather than as page one of one row', async () => {
    const workspaceId = await freshWorkspace();
    const page = await explorer.requests(actor(), { workspaceId });

    expect(page.total).toBe(0);
    expect(page.from).toBe(0);
    expect(page.to).toBe(0);
    expect(page.totalPages).toBe(1);
    expect(page.hasNext).toBe(false);
  });

  it('orders totally, so a row cannot land on two pages or on none', async () => {
    const workspaceId = await freshWorkspace();
    // Same creation timestamp: without the `id` tie-break the order between
    // these is undefined and a row can be skipped or repeated across pages.
    const sameInstant = new Date('2026-09-13T00:00:00.000Z');
    const created = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      created.add(await recordRequest(workspaceId, { createdAt: sameInstant }));
    }

    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const result = await explorer.requests(actor(), { workspaceId, page, pageSize: 2 });
      seen.push(...result.items.map((item) => item.id));
    }

    expect(new Set(seen)).toEqual(created);
    expect(seen).toHaveLength(6);
  });

  it('filters without breaking the total', async () => {
    const workspaceId = await freshWorkspace();
    await recordRequest(workspaceId, { status: 'SUCCEEDED' });
    await recordRequest(workspaceId, { status: 'SUCCEEDED' });
    await recordRequest(workspaceId, { status: 'FAILED' });

    const failed = await explorer.requests(actor(), { workspaceId, status: 'FAILED' });
    expect(failed.total).toBe(1);

    const all = await explorer.requests(actor(), { workspaceId });
    expect(all.total).toBe(3);
  });
});

describe('the request inspector', () => {
  it('returns the accounting and the attempt history', async () => {
    const workspaceId = await freshWorkspace();
    const requestId = await recordRequest(workspaceId);

    const detail = await explorer.request(actor(), requestId);

    expect(detail.id).toBe(requestId);
    expect(detail.creditsReservedMilli).toBe(500n);
    expect(detail.creditsChargedMilli).toBeLessThanOrEqual(detail.creditsReservedMilli);
    expect(detail.creditsChargedMilli).toBe(175n);
    expect(detail.providerCostMicroMinor).toBe(19_500n);
    expect(detail.attemptedModelKeys).toEqual([MODEL_KEY]);
    expect(detail.ledger).toHaveLength(1);
  });

  it('never returns the stored output, even when a rule persisted it', async () => {
    const workspaceId = await freshWorkspace();
    const requestId = await recordRequest(workspaceId);
    await platform.aiRequest.update({
      where: { id: requestId },
      data: { outputPayload: { kind: 'text', text: 'GENERATED-CONTENT-SENTINEL' } },
    });

    const detail = await explorer.request(actor(), requestId);

    // Reading a customer's generated content is a Support Mode decision with
    // its own time box and audit trail, not a side effect of opening an
    // operations screen.
    // BigInt is not JSON-serialisable, so the whole object is stringified with
    // a replacer rather than field by field — the point is that NOTHING
    // returned carries the content, including a field added later.
    const serialised = JSON.stringify(detail, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialised).not.toContain('SENTINEL');
    expect(Object.keys(detail)).not.toContain('outputPayload');
  });

  it('reports a missing request as not found', async () => {
    await expect(
      explorer.request(actor(), '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the usage rollup', () => {
  it('sums credits and provider cost per model from the ledger', async () => {
    const workspaceId = await freshWorkspace();
    await recordRequest(workspaceId, { modelKey: 'model-a', creditsChargedMilli: 100n });
    await recordRequest(workspaceId, { modelKey: 'model-a', creditsChargedMilli: 250n });
    await recordRequest(workspaceId, { modelKey: 'model-b', creditsChargedMilli: 900n });

    const rows = await explorer.rollup(actor(), 'modelKey', { workspaceId });
    const byKey = new Map(rows.map((row) => [row.key, row]));

    expect(byKey.get('model-a')?.creditsChargedMilli).toBe(350n);
    expect(byKey.get('model-a')?.requests).toBe(2);
    expect(byKey.get('model-b')?.creditsChargedMilli).toBe(900n);
  });

  it('puts the expensive thing first', async () => {
    const workspaceId = await freshWorkspace();
    await recordRequest(workspaceId, { modelKey: 'cheap', creditsChargedMilli: 10n });
    await recordRequest(workspaceId, { modelKey: 'dear', creditsChargedMilli: 5000n });

    const rows = await explorer.rollup(actor(), 'modelKey', { workspaceId });
    expect(rows[0]?.key).toBe('dear');
  });

  it('scopes to one workspace when asked', async () => {
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    await recordRequest(a, { modelKey: 'only-in-a' });
    await recordRequest(b, { modelKey: 'only-in-b' });

    const rows = await explorer.rollup(actor(), 'modelKey', { workspaceId: a });
    expect(rows.map((row) => row.key)).toContain('only-in-a');
    expect(rows.map((row) => row.key)).not.toContain('only-in-b');
  });
});

describe('the reservation-leak metric', () => {
  it('counts requests past their deadline that are still running', async () => {
    const workspaceId = await freshWorkspace();
    const before = await explorer.leakCount(actor());

    await recordRequest(workspaceId, {
      status: 'RUNNING',
      deadlineAt: new Date(Date.now() - 60_000),
      withLedger: false,
    });

    // §12 says this number must stay at zero. Relative to the reading before,
    // because other suites leave their own rows behind.
    expect(await explorer.leakCount(actor())).toBe(before + 1);
  });

  it('does not count a request still inside its deadline', async () => {
    const workspaceId = await freshWorkspace();
    const before = await explorer.leakCount(actor());

    await recordRequest(workspaceId, {
      status: 'RUNNING',
      deadlineAt: new Date(Date.now() + 600_000),
      withLedger: false,
    });

    expect(await explorer.leakCount(actor())).toBe(before);
  });
});
