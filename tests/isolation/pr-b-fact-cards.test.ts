import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { TOOL_EXECUTORS, availableTools, buildPreview } from '@brandspace/copilot';
import { systemClock } from '@brandspace/shared';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PR B (D-591) — A FACT IS A CARD. The Copilot proposes a fact, an edit or a
 * removal as a step the person confirms; the step then runs with THEIR
 * permission. With `brand_brain.review` an added fact is approved at once;
 * with edit alone it is SENT FOR REVIEW; without edit no card is offered. A
 * fact of another brand or workspace is refused in the 404 shape. Building the
 * card's preview writes nothing.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const OWNER_KEYS = ['copilot.use', 'brand_brain.read', 'brand_brain.edit', 'brand_brain.review'];
const EDITOR_KEYS = ['copilot.use', 'brand_brain.read', 'brand_brain.edit'];

async function run(
  toolKey: string,
  args: Record<string, unknown>,
  input: { workspaceId?: string; permissionKeys?: string[]; brandScope?: string[] } = {},
) {
  const executor = TOOL_EXECUTORS[toolKey];
  if (!executor) throw new Error(`${toolKey} has no executor`);
  const workspaceId = input.workspaceId ?? fixtures.a.workspaceId;
  return withWorkspace(
    workspaceId,
    async (db) =>
      executor(
        {
          db: db as TenantScopedClient,
          workspaceId,
          authorization: {
            userId: fixtures.a.userId,
            roleKey: 'workspace_owner',
            permissionKeys: input.permissionKeys ?? OWNER_KEYS,
            brandScope: input.brandScope ?? [],
          },
          clock: systemClock,
          correlationId: randomUUID(),
          idempotencyKey: `fact-${randomUUID()}`,
          planKey: null,
        } as never,
        args,
      ),
    { prisma: app },
  );
}

async function itemsOf(brandId: string) {
  return platform.brandKnowledgeItem.findMany({
    where: { brandId },
    select: { id: true, status: true, version: true, body: true },
  });
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('PR B — Brand Brain facts from a confirmed card', () => {
  it('no card is offered to a member without brand_brain.edit', () => {
    const keys = (perms: string[]) => availableTools(perms).map((tool) => tool.key);
    expect(keys(['copilot.use', 'brand_brain.read'])).not.toContain('brand_brain.add_fact');
    expect(keys(EDITOR_KEYS)).toEqual(
      expect.arrayContaining([
        'brand_brain.add_fact',
        'brand_brain.edit_fact',
        'brand_brain.remove_fact',
      ]),
    );
  });

  it('the card’s preview writes nothing', async () => {
    const before = await itemsOf(fixtures.a.brandId);
    const lines = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        buildPreview(
          {
            db: db as TenantScopedClient,
            workspaceId: fixtures.a.workspaceId,
            authorization: {
              userId: fixtures.a.userId,
              roleKey: 'workspace_owner',
              permissionKeys: OWNER_KEYS,
              brandScope: [],
            },
          } as never,
          'brand_brain.add_fact',
          { brandId: fixtures.a.brandId, area: 'OFFERS', title: 'Hours', body: 'Open at 8.' },
        ),
      { prisma: app },
    );
    expect(lines.map((line) => line.after)).toEqual(['OFFERS', 'Hours', 'Open at 8.']);
    expect(await itemsOf(fixtures.a.brandId)).toEqual(before);
  });

  it('confirmed by a reviewer: the fact is approved at once, in its own language', async () => {
    const outcome = await run('brand_brain.add_fact', {
      brandId: fixtures.a.brandId,
      area: 'OFFERS',
      title: 'ساعات العمل',
      body: 'نفتح يوميًا من الثامنة.',
    });
    expect(outcome.result).toMatchObject({ outcome: 'approved', area: 'OFFERS' });
    const item = await platform.brandKnowledgeItem.findUniqueOrThrow({
      where: { id: String(outcome.resourceId) },
      select: { status: true, origin: true, body: true },
    });
    expect(item).toMatchObject({ status: 'ACTIVE', origin: 'HUMAN' });
    expect(item.body).toMatchObject({ ar: 'نفتح يوميًا من الثامنة.' });
  });

  it('confirmed by an editor without review: sent for review, nothing active', async () => {
    const before = (await itemsOf(fixtures.a.brandId)).length;
    const outcome = await run(
      'brand_brain.add_fact',
      { brandId: fixtures.a.brandId, area: 'IDENTITY', title: 'Founded', body: 'Founded in 2019.' },
      { permissionKeys: EDITOR_KEYS },
    );
    expect(outcome.result).toMatchObject({ outcome: 'sent_for_review' });
    const candidate = await platform.brandKnowledgeCandidate.findUniqueOrThrow({
      where: { id: String(outcome.resourceId) },
      select: { status: true, sourceKind: true, proposedByUserId: true },
    });
    expect(candidate).toMatchObject({
      status: 'PENDING',
      sourceKind: 'MEMBER',
      proposedByUserId: fixtures.a.userId,
    });
    expect((await itemsOf(fixtures.a.brandId)).length).toBe(before);
  });

  it('edit makes a new version; remove archives it', async () => {
    const added = await run('brand_brain.add_fact', {
      brandId: fixtures.a.brandId,
      area: 'OFFERS',
      title: 'Cold brew',
      body: 'Cold brew is 15.',
    });
    const factId = String(added.resourceId);
    const edited = await run('brand_brain.edit_fact', {
      brandId: fixtures.a.brandId,
      factId,
      body: 'Cold brew is 18.',
    });
    expect(edited.resourceVersionAfter).toBe(Number(edited.resourceVersionBefore) + 1);
    const removed = await run('brand_brain.remove_fact', { brandId: fixtures.a.brandId, factId });
    expect(removed.result).toMatchObject({ outcome: 'removed' });
    const row = await platform.brandKnowledgeItem.findUniqueOrThrow({
      where: { id: factId },
      select: { status: true },
    });
    expect(row.status).toBe('ARCHIVED');
  });

  it('a fact of another workspace, another brand or outside the scope is the 404 shape', async () => {
    const theirs = await platform.brandKnowledgeItem.findFirstOrThrow({
      where: { workspaceId: fixtures.b.workspaceId, status: 'ACTIVE' },
      select: { id: true, brandId: true },
    });
    // Named as A's brand, from A: not found.
    await expect(
      run('brand_brain.edit_fact', {
        brandId: fixtures.a.brandId,
        factId: theirs.id,
        body: 'Overwritten.',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Named with its own brand, from A's session (RLS): not found either.
    await expect(
      run('brand_brain.remove_fact', { brandId: theirs.brandId, factId: theirs.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // A's own fact, by a member scoped to another brand: not found.
    const mine = await run('brand_brain.add_fact', {
      brandId: fixtures.a.brandId,
      area: 'OFFERS',
      title: 'Scoped',
      body: 'Only for this brand.',
    });
    await expect(
      run(
        'brand_brain.remove_fact',
        { brandId: fixtures.a.brandId, factId: String(mine.resourceId) },
        { brandScope: [randomUUID()] },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const untouched = await platform.brandKnowledgeItem.findUniqueOrThrow({
      where: { id: theirs.id },
      select: { status: true },
    });
    expect(untouched.status).toBe('ACTIVE');
  });
});
