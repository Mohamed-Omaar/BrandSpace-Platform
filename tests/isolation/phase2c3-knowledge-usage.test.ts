import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import type { AiGateway, AiGatewayResult } from '@brandspace/ai-gateway';
import {
  BrandKnowledgeService,
  contentWithFactChanges,
  isFlagged,
  keepFactChange,
  loadCurrentUsage,
  recordKnowledgeUsage,
  usageChangeFor,
  usedInPostsCounts,
  variantKnowledgeUsage,
  workspaceKnowledgeAsOf,
} from '@brandspace/brand-brain';
import { ContentStudioService, parseContentPolicy } from '@brandspace/content';
import type { CustomerWorkspaceContext } from '@brandspace/auth';
import { attentionItems } from '../../apps/dashboard/src/server/command-center';
import { saveBrandUseBrandBrain } from '../../apps/dashboard/src/server/publishing-defaults';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2C-3 (Item 4) — RECORDED FACT USAGE, D10 AND THE CHAT'S DOMAIN RULES,
 * against real PostgreSQL under the application role (RLS on).
 *
 *   - `content_knowledge_usage` (M5): tenant isolation, brand scope, the scope
 *     trigger, and the one-current-use index;
 *   - D9: what a generation or a caption tool records is EXACTLY the facts the
 *     grounding layer returned (ids + versions), in the caption's transaction;
 *     nothing when Brand Brain is off; a manual edit keeps the record; the next
 *     AI write supersedes it and history stays;
 *   - D10: `usageChangeFor` on stored rows — changed, a metadata-only version
 *     bump (NOT a change), expired, replaced, removed — "Keep as is" and the
 *     re-alert, PUBLISHED never flagged, and the `refresh_facts` rewrite: its
 *     grounding starts from the recorded ids only, one charge, one write;
 *   - Home "Needs you": SCHEDULED and IN_REVIEW only, behind its permissions;
 *   - "Used in N posts": distinct live posts from current usage only;
 *   - the chat's domain rules: `expectedVersion`, Undo's precondition and the
 *     MEMBER candidate with its CHECK (M4a/M4b).
 */

const MARK_OFFER = 'OFFER-MARK-2C3';
const MARK_PLACE = 'PLACE-MARK-2C3';
const MARK_LATE = 'LATE-UNRELATED-MARK-2C3';
const MARK_PENDING = 'PENDING-MARK-2C3';
const MARK_REPLACEMENT = 'REPLACEMENT-MARK-2C3';

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const STALENESS = { reviewIntervalDays: 90 };
const CONTENT_POLICY = parseContentPolicy(defaultPayload('content'));

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const actor = (brandScope: readonly string[] = []) => ({
  userId: fixtures.a.userId,
  permissionKeys: [] as readonly string[],
  brandScope,
});

/** Settings → AI "Use Brand Brain", through its own audited writer. */
const switchBrandBrain = (db: TenantScopedClient, enabled: boolean) =>
  saveBrandUseBrandBrain(
    db,
    { workspaceId: fixtures.a.workspaceId, actorUserId: fixtures.a.userId, brandScope: [] },
    { brandId: fixtures.a.brandId, enabled },
  );

const knowledge = (db: TenantScopedClient) =>
  new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId });

/* ------------------------------------------------------------ a scripted model */

interface Call {
  readonly idempotencyKey: string;
  readonly text: string;
}

/**
 * A gateway double with the gateway's own idempotency: the same key returns
 * the recorded result (`replayed: true`) without calling the model again. It
 * records what every request carried, so a test reads exactly which facts a
 * prompt held.
 */
function scripted(respond: (text: string) => string) {
  const calls: Call[] = [];
  const done = new Map<string, AiGatewayResult>();
  const textOf = (request: { input?: { prompt?: string; untrustedContext?: readonly string[] } }) =>
    [request.input?.prompt ?? '', ...(request.input?.untrustedContext ?? [])].join('\n');
  const gateway = {
    async execute(request: {
      idempotencyKey: string;
      input?: { prompt?: string; untrustedContext?: readonly string[] };
    }): Promise<AiGatewayResult> {
      const replay = done.get(request.idempotencyKey);
      if (replay) return { ...replay, replayed: true, creditsChargedMilli: 0n };
      const text = textOf(request);
      calls.push({ idempotencyKey: request.idempotencyKey, text });
      const result = {
        requestId: randomUUID(),
        status: 'SUCCEEDED',
        modelKey: 'mock',
        attemptedModelKeys: ['mock'],
        output: { kind: 'text', text: respond(text) },
        usage: { promptTokens: 1, completionTokens: 1 },
        creditsChargedMilli: 100n,
        providerCostMicroMinor: 0n,
        failureClass: null,
        failureMessage: null,
        replayed: false,
        latencyMs: 1,
      } as unknown as AiGatewayResult;
      done.set(request.idempotencyKey, result);
      return result;
    },
    async quote(request: { input?: { prompt?: string; untrustedContext?: readonly string[] } }) {
      calls.push({ idempotencyKey: 'quote', text: textOf(request) });
      return { taskKey: 'caption.generate', estimateMilli: 1_234n, modelKeys: ['mock'] };
    },
  } as unknown as AiGateway;
  return { gateway, calls };
}

const CAPTION = JSON.stringify({
  title: 'Cold brew post',
  variants: [{ platformKey: 'instagram', body: 'Cold brew downtown today.', hashtags: [] }],
});
const REWRITTEN = JSON.stringify({ body: 'A rewritten caption.', hashtags: ['fresh'] });

const studio = (db: TenantScopedClient, gateway: AiGateway) =>
  new ContentStudioService({
    db,
    workspaceId: fixtures.a.workspaceId,
    gateway,
    policy: CONTENT_POLICY,
  });

let facts: {
  offer: string;
  place: string;
};

async function newFact(input: {
  area: 'OFFERS' | 'IDENTITY' | 'PROOF_POINTS';
  key: string;
  title: string;
  body: string;
  validUntil?: Date | null;
}): Promise<string> {
  return inA(async (db) => {
    const item = await knowledge(db).createItem({
      brandId: fixtures.a.brandId,
      area: input.area,
      itemKey: input.key,
      title: { en: input.title },
      body: { en: input.body },
      actor: actor(),
      policy: STALENESS,
      validUntil: input.validUntil ?? null,
    });
    return item.id;
  });
}

/** A fresh post generated over the brief, with the facts it recorded. */
async function generate(brief = 'cold brew downtown', gateway = scripted(() => CAPTION)) {
  const result = await inA((db) =>
    studio(db, gateway.gateway).generate({
      brandId: fixtures.a.brandId,
      brief,
      locale: 'EN',
      platformKeys: ['instagram'],
      idempotencyKey: `gen-${randomUUID()}`,
      actorUserId: fixtures.a.userId,
      planKey: null,
      actorBrandScope: [],
      retention: { subscriptionActive: true },
    }),
  );
  const variant = result.variants[0];
  if (!variant) throw new Error('no variant');
  return { item: result.item, variant, gateway };
}

const currentRows = (variantId: string) =>
  inA((db) =>
    db.contentKnowledgeUsage.findMany({
      where: { contentVariantId: variantId, supersededAt: null },
      orderBy: { knowledgeItemId: 'asc' },
    }),
  );

const allRows = (variantId: string) =>
  inA((db) => db.contentKnowledgeUsage.findMany({ where: { contentVariantId: variantId } }));

async function setStatus(itemId: string, status: string) {
  await platform.contentItem.update({ where: { id: itemId }, data: { status: status as never } });
}

async function flaggedFor(variantId: string): Promise<boolean[]> {
  return inA(async (db) => {
    const rows = await loadCurrentUsage(db, { contentVariantId: variantId });
    const asOf = await workspaceKnowledgeAsOf(db);
    return rows.map((row) => isFlagged(row, asOf));
  });
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  facts = {
    offer: await newFact({
      area: 'OFFERS',
      key: 'offers.current',
      title: 'Cold brew offer',
      body: `Cold brew two for one. ${MARK_OFFER}`,
    }),
    place: await newFact({
      area: 'IDENTITY',
      key: 'identity.location',
      title: 'Downtown kiosk',
      body: `Our kiosk is downtown. ${MARK_PLACE}`,
    }),
  };
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

/* ======================================================================== */

describe('M5 — content_knowledge_usage: tenant isolation (RLS) and brand scope', () => {
  it('another workspace cannot read, count, update or delete a usage row', async () => {
    const { variant } = await generate();
    const rows = await currentRows(variant.id);
    expect(rows.length).toBeGreaterThan(0);
    const id = rows[0]!.id;

    const fromB = await inB(async (db) => ({
      one: await db.contentKnowledgeUsage.findFirst({ where: { id } }),
      count: await db.contentKnowledgeUsage.count({ where: { contentVariantId: variant.id } }),
      updated: await db.contentKnowledgeUsage.updateMany({
        where: { id },
        data: { supersededAt: new Date() },
      }),
      deleted: await db.contentKnowledgeUsage.deleteMany({ where: { id } }),
    }));
    expect(fromB).toEqual({ one: null, count: 0, updated: { count: 0 }, deleted: { count: 0 } });
    expect((await currentRows(variant.id)).map((row) => row.id)).toContain(id);
  });

  it('a row naming another workspace is refused by the tenant policy', async () => {
    const { item, variant } = await generate();
    await expect(
      inA((db) =>
        db.contentKnowledgeUsage.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId: item.id,
            contentVariantId: variant.id,
            knowledgeItemId: facts.offer,
            knowledgeVersion: 1,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("another workspace's fact cannot be recorded against this workspace's post", async () => {
    const { item, variant } = await generate();
    await expect(
      inA((db) =>
        recordKnowledgeUsage(db, {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          contentItemId: item.id,
          contentVariantId: variant.id,
          facts: [{ itemId: fixtures.b.knowledgeItemId, version: 1 }],
          aiRequestId: null,
        }),
      ),
    ).rejects.toThrow();
  });

  it('the scope trigger refuses a variant of another post or a fact of another brand', async () => {
    const first = await generate();
    const second = await generate();
    const otherBrand = await inA((db) =>
      db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          slug: `other-${randomUUID().slice(0, 8)}`,
          name: 'Other brand',
          status: 'ACTIVE',
          defaultLocale: 'EN',
          supportedLocales: ['EN'],
        },
      }),
    );
    const otherFact = await inA(async (db) =>
      knowledge(db).createItem({
        brandId: otherBrand.id,
        area: 'OFFERS',
        itemKey: 'offers.current',
        title: { en: 'Other' },
        body: { en: 'Other brand fact' },
        actor: actor(),
        policy: STALENESS,
      }),
    );
    await expect(
      inA((db) =>
        db.contentKnowledgeUsage.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId: first.item.id,
            contentVariantId: second.variant.id,
            knowledgeItemId: facts.offer,
            knowledgeVersion: 1,
          },
        }),
      ),
    ).rejects.toThrow(/own content item|23514|violates/i);
    await expect(
      inA((db) =>
        db.contentKnowledgeUsage.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId: first.item.id,
            contentVariantId: first.variant.id,
            knowledgeItemId: otherFact.id,
            knowledgeVersion: 1,
          },
        }),
      ),
    ).rejects.toThrow(/same brand|23514|violates/i);
  });

  it('a member scoped to another brand reads no usage of this brand', async () => {
    const { variant } = await generate();
    const scoped = await inA((db) =>
      variantKnowledgeUsage(db, {
        variantIds: [variant.id],
        brandScope: [randomUUID()],
      }),
    );
    expect(scoped.size).toBe(0);
    const unscoped = await inA((db) =>
      variantKnowledgeUsage(db, { variantIds: [variant.id], brandScope: [] }),
    );
    expect(unscoped.get(variant.id)?.length).toBeGreaterThan(0);
  });

  it('ENABLE and FORCE row level security are on, with the standard policies', async () => {
    const rows = await platform.$queryRaw<{ rls: boolean; force: boolean }[]>`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS force
      FROM pg_class WHERE relname = 'content_knowledge_usage'`;
    expect(rows[0]).toEqual({ rls: true, force: true });
    const policies = await platform.$queryRaw<{ polname: string }[]>`
      SELECT polname FROM pg_policy WHERE polrelid = 'content_knowledge_usage'::regclass
      ORDER BY polname`;
    expect(policies.map((row) => row.polname)).toEqual(['platform_access', 'tenant_isolation']);
  });
});

/* ======================================================================== */

describe('D9 — what AI writing recorded', () => {
  it('a generation records exactly the grounded facts, at their versions, and no other', async () => {
    const { variant, gateway } = await generate();
    const rows = await currentRows(variant.id);
    const recorded = rows.map((row) => [row.knowledgeItemId, row.knowledgeVersion]).sort();
    expect(recorded).toEqual(
      [
        [facts.offer, 1],
        [facts.place, 1],
      ].sort(),
    );
    // What was recorded is what the prompt carried — both facts, nothing else.
    const prompt = gateway.calls[0]!.text;
    expect(prompt).toContain(MARK_OFFER);
    expect(prompt).toContain(MARK_PLACE);
    expect(rows.every((row) => row.aiRequestId !== null)).toBe(true);
  });

  it('a later version of a fact is recorded at that version', async () => {
    const id = await newFact({
      area: 'PROOF_POINTS',
      key: `proof.${randomUUID().slice(0, 6)}`,
      title: 'Awarded roaster',
      body: 'Awarded roaster zanzibarine',
    });
    await inA((db) =>
      knowledge(db).updateItem({
        itemId: id,
        title: { en: 'Awarded roaster' },
        body: { en: 'Awarded roaster zanzibarine, twice' },
        actor: actor(),
        policy: STALENESS,
      }),
    );
    const { variant } = await generate('zanzibarine');
    const rows = await currentRows(variant.id);
    expect(rows.find((row) => row.knowledgeItemId === id)?.knowledgeVersion).toBe(2);
  });

  it('Brand Brain off records nothing', async () => {
    await inA((db) => switchBrandBrain(db, false));
    try {
      const { variant, gateway } = await generate();
      expect(await currentRows(variant.id)).toEqual([]);
      expect(gateway.calls[0]!.text).not.toContain(MARK_OFFER);
    } finally {
      await inA((db) => switchBrandBrain(db, true));
    }
  });

  it('a caption tool that grounded on nothing supersedes the old set and records nothing', async () => {
    const { variant } = await generate();
    await platform.contentVariant.update({
      where: { id: variant.id },
      data: { body: 'qwertyuiop asdfghjkl' },
    });
    await inA((db) =>
      studio(db, scripted(() => REWRITTEN).gateway).applyTool({
        variantId: variant.id,
        tool: 'shorten',
        idempotencyKey: `tool-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        actorPermissionKeys: ['content.edit'],
      }),
    );
    expect(await currentRows(variant.id)).toEqual([]);
    const history = await allRows(variant.id);
    expect(history.length).toBe(2);
    expect(history.every((row) => row.supersededAt !== null)).toBe(true);
  });

  it('the next AI write supersedes the current set and keeps history; the hashtag tool does not', async () => {
    const { variant } = await generate();
    const before = await currentRows(variant.id);
    await inA((db) =>
      studio(db, scripted(() => REWRITTEN).gateway).applyTool({
        variantId: variant.id,
        tool: 'hashtags',
        idempotencyKey: `tags-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        actorPermissionKeys: ['content.edit'],
      }),
    );
    expect((await currentRows(variant.id)).map((row) => row.id)).toEqual(
      before.map((row) => row.id),
    );
    // The rewrite tool writes new words: a new current set; the old one kept.
    await platform.contentVariant.update({
      where: { id: variant.id },
      data: { body: 'Cold brew downtown today.' },
    });
    await inA((db) =>
      studio(db, scripted(() => REWRITTEN).gateway).applyTool({
        variantId: variant.id,
        tool: 'rewrite',
        idempotencyKey: `rw-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        actorPermissionKeys: ['content.edit'],
      }),
    );
    const after = await currentRows(variant.id);
    expect(after.length).toBe(before.length);
    expect(after.map((row) => row.id)).not.toEqual(before.map((row) => row.id));
    const history = await allRows(variant.id);
    expect(
      history
        .filter((row) => row.supersededAt !== null)
        .map((row) => row.id)
        .sort(),
    ).toEqual(before.map((row) => row.id).sort());
  });

  it('a manual edit keeps the recorded usage', async () => {
    const { variant } = await generate();
    const before = await currentRows(variant.id);
    await inA((db) =>
      studio(db, scripted(() => REWRITTEN).gateway).editVariant({
        variantId: variant.id,
        body: 'Written by a person now.',
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        actorPermissionKeys: ['content.edit'],
      }),
    );
    expect(await currentRows(variant.id)).toEqual(before);
  });

  it('a failed save leaves neither the caption nor its usage (one transaction)', async () => {
    const itemsBefore = await platform.contentItem.count({
      where: { workspaceId: fixtures.a.workspaceId },
    });
    const usageBefore = await platform.contentKnowledgeUsage.count({
      where: { workspaceId: fixtures.a.workspaceId },
    });
    await expect(
      inA(async (db) => {
        await studio(db, scripted(() => CAPTION).gateway).generate({
          brandId: fixtures.a.brandId,
          brief: 'cold brew downtown',
          locale: 'EN',
          platformKeys: ['instagram'],
          idempotencyKey: `atomic-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actorBrandScope: [],
          retention: { subscriptionActive: true },
        });
        throw new Error('the save fails after the usage was written');
      }),
    ).rejects.toThrow(/save fails/);
    expect(
      await platform.contentItem.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    ).toBe(itemsBefore);
    expect(
      await platform.contentKnowledgeUsage.count({
        where: { workspaceId: fixtures.a.workspaceId },
      }),
    ).toBe(usageBefore);

    // And a usage write that fails takes the caption write with it.
    const { variant } = await generate();
    await expect(
      inA(async (db) => {
        await db.contentVariant.update({ where: { id: variant.id }, data: { body: 'changed' } });
        await recordKnowledgeUsage(db, {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          contentItemId: variant.contentItemId,
          contentVariantId: variant.id,
          facts: [{ itemId: fixtures.b.knowledgeItemId, version: 1 }],
          aiRequestId: null,
        });
      }),
    ).rejects.toThrow();
    const reread = await platform.contentVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(reread.body).toBe('Cold brew downtown today.');
    expect((await currentRows(variant.id)).length).toBe(2);
  });
});

/* ======================================================================== */

describe('D10 — usageChangeFor on stored rows, Keep as is, and the re-alert', () => {
  it('a title/body change alerts; a metadata-only bump does not', async () => {
    const id = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Morning roast',
      body: 'Morning roast quillicent',
    });
    const { variant } = await generate('quillicent');
    // A far-future end date: a new version with the same title and body.
    await inA((db) =>
      knowledge(db).updateItem({
        itemId: id,
        title: { en: 'Morning roast' },
        body: { en: 'Morning roast quillicent' },
        validUntil: new Date('2999-12-31T00:00:00Z'),
        actor: actor(),
        policy: STALENESS,
      }),
    );
    const rows = await inA((db) => loadCurrentUsage(db, { contentVariantId: variant.id }));
    const row = rows.find((entry) => entry.knowledgeItemId === id)!;
    expect(row.current.version).toBe(2);
    expect(usageChangeFor(row, new Date())).toBeNull();

    await inA((db) =>
      knowledge(db).updateItem({
        itemId: id,
        title: { en: 'Morning roast' },
        body: { en: 'Morning roast quillicent, now oat milk' },
        actor: actor(),
        policy: STALENESS,
      }),
    );
    const changed = (
      await inA((db) => loadCurrentUsage(db, { contentVariantId: variant.id }))
    ).find((entry) => entry.knowledgeItemId === id)!;
    expect(usageChangeFor(changed, new Date())?.kind).toBe('changed');
  });

  it('Keep as is dismisses exactly that change; a later change alerts again', async () => {
    const id = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Evening brew',
      body: 'Evening brew velocimorph',
    });
    const { variant } = await generate('velocimorph');
    const edit = (body: string) =>
      inA((db) =>
        knowledge(db).updateItem({
          itemId: id,
          title: { en: 'Evening brew' },
          body: { en: body },
          actor: actor(),
          policy: STALENESS,
        }),
      );
    await edit('Evening brew velocimorph, now decaf');
    const change = async () => {
      const [row] = await inA((db) =>
        loadCurrentUsage(db, { contentVariantId: variant.id, knowledgeItemId: id }),
      );
      return usageChangeFor(row!, new Date())!;
    };
    const first = await change();
    expect(await flaggedFor(variant.id)).toContain(true);

    // A signature that is not the current change writes nothing.
    await expect(
      inA((db) =>
        keepFactChange(db, {
          workspaceId: fixtures.a.workspaceId,
          contentVariantId: variant.id,
          knowledgeItemId: id,
          signature: '0'.repeat(64),
          actorUserId: fixtures.a.userId,
          brandScope: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await inA((db) =>
      keepFactChange(db, {
        workspaceId: fixtures.a.workspaceId,
        contentVariantId: variant.id,
        knowledgeItemId: id,
        signature: first.signature,
        actorUserId: fixtures.a.userId,
        brandScope: [],
      }),
    );
    const kept = await currentRows(variant.id);
    const keptRow = kept.find((row) => row.knowledgeItemId === id)!;
    expect(keptRow.dismissedChangeSignature).toBe(first.signature);
    expect(keptRow.dismissedByUserId).toBe(fixtures.a.userId);
    expect(keptRow.dismissedAt).not.toBeNull();
    const rows = await inA((db) =>
      loadCurrentUsage(db, { contentVariantId: variant.id, knowledgeItemId: id }),
    );
    expect(isFlagged(rows[0]!, new Date())).toBe(false);
    const audit = await platform.auditEvent.findFirst({
      where: { workspaceId: fixtures.a.workspaceId, action: 'content.knowledge_change.kept' },
    });
    expect(audit).not.toBeNull();

    await edit('Evening brew velocimorph, now with oat milk');
    const second = await change();
    expect(second.signature).not.toBe(first.signature);
    const again = await inA((db) =>
      loadCurrentUsage(db, { contentVariantId: variant.id, knowledgeItemId: id }),
    );
    expect(isFlagged(again[0]!, new Date())).toBe(true);
  });

  it('expired (in the workspace day), replaced and removed', async () => {
    const expiring = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Spring deal',
      body: 'Spring deal marzipanicle',
    });
    const archivedWithReplacement = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Old hours',
      body: 'Old hours marzipanicle',
    });
    const removed = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Gone promo',
      body: 'Gone promo marzipanicle',
    });
    const { variant } = await generate('marzipanicle');
    const replacement = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'New hours',
      body: `New hours ${MARK_REPLACEMENT}`,
    });
    await inA(async (db) => {
      const service = knowledge(db);
      await service.updateItem({
        itemId: expiring,
        title: { en: 'Spring deal' },
        body: { en: 'Spring deal marzipanicle' },
        validUntil: new Date('2020-01-01T00:00:00Z'),
        actor: actor(),
        policy: STALENESS,
      });
      await service.archiveItem({
        itemId: archivedWithReplacement,
        actor: actor(),
        supersededByItemId: replacement,
      });
      await service.archiveItem({ itemId: removed, actor: actor() });
    });
    const rows = await inA((db) => loadCurrentUsage(db, { contentVariantId: variant.id }));
    const asOf = await inA((db) => workspaceKnowledgeAsOf(db));
    const kind = (id: string) =>
      usageChangeFor(
        rows.find((row) => row.knowledgeItemId === id)!,
        asOf,
      )?.kind;
    expect(kind(expiring)).toBe('expired');
    expect(kind(archivedWithReplacement)).toBe('replaced');
    expect(kind(removed)).toBe('removed');
    // The old version reference is kept whatever happened to the fact.
    expect(rows.find((row) => row.knowledgeItemId === removed)?.usedVersion).toBe(1);
  });

  it('PUBLISHING and PUBLISHED posts are never flagged', async () => {
    const id = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Brunch',
      body: 'Brunch florbinate',
    });
    const { item, variant } = await generate('florbinate');
    await inA((db) => knowledge(db).archiveItem({ itemId: id, actor: actor() }));
    for (const status of ['PUBLISHING', 'PUBLISHED']) {
      await setStatus(item.id, status);
      expect(await flaggedFor(variant.id)).not.toContain(true);
      expect(await inA((db) => contentWithFactChanges(db, { brandScope: [] }))).not.toContain(
        item.id,
      );
    }
  });
});

/* ======================================================================== */

describe('D10 — the refresh_facts rewrite', () => {
  it('starts only from the recorded facts: current versions, replacements, never an unrelated or pending fact', async () => {
    const changing = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Iced latte',
      body: 'Iced latte glimmerfrost',
    });
    const retiring = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Old menu',
      body: 'Old menu glimmerfrost',
    });
    const expiring = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Weekend deal',
      body: 'Weekend deal glimmerfrost EXPIRING-MARK-2C3',
    });
    const { item, variant } = await generate('glimmerfrost');
    await setStatus(item.id, 'APPROVED');

    // After the caption: a new usable fact sharing its words, and a pending one.
    await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Late unrelated',
      body: `glimmerfrost ${MARK_LATE}`,
    });
    await inA((db) =>
      knowledge(db).proposeFact({
        brandId: fixtures.a.brandId,
        area: 'OFFERS',
        itemKey: `offers.${randomUUID().slice(0, 6)}`,
        title: { en: 'Pending' },
        body: { en: `glimmerfrost ${MARK_PENDING}` },
        actor: actor(),
      }),
    );
    const replacement = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'New menu',
      body: `New menu ${MARK_REPLACEMENT}`,
    });
    await inA(async (db) => {
      const service = knowledge(db);
      await service.updateItem({
        itemId: changing,
        title: { en: 'Iced latte' },
        body: { en: 'Iced latte glimmerfrost NEW-TEXT-2C3' },
        actor: actor(),
        policy: STALENESS,
      });
      await service.archiveItem({
        itemId: retiring,
        actor: actor(),
        supersededByItemId: replacement,
      });
      await service.updateItem({
        itemId: expiring,
        title: { en: 'Weekend deal' },
        body: { en: 'Weekend deal glimmerfrost EXPIRING-MARK-2C3' },
        validUntil: new Date('2020-01-01T00:00:00Z'),
        actor: actor(),
        policy: STALENESS,
      });
    });

    const model = scripted(() => REWRITTEN);
    const quote = await inA((db) =>
      studio(db, model.gateway).quoteTool({
        variantId: variant.id,
        tool: 'refresh_facts',
        planKey: null,
        actorBrandScope: [],
      }),
    );
    expect(quote.estimateMilli).toBe(1_234n);
    await inA((db) =>
      studio(db, model.gateway).applyTool({
        variantId: variant.id,
        tool: 'refresh_facts',
        idempotencyKey: `refresh-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        actorPermissionKeys: ['content.edit', 'copilot.use'],
      }),
    );
    const execution = model.calls.find((call) => call.idempotencyKey !== 'quote')!;
    // The quote asked the SAME request the rewrite then made.
    expect(model.calls.find((call) => call.idempotencyKey === 'quote')!.text).toBe(execution.text);
    expect(execution.text).toContain('NEW-TEXT-2C3');
    expect(execution.text).toContain(MARK_REPLACEMENT);
    expect(execution.text).not.toContain('EXPIRING-MARK-2C3');
    expect(execution.text).not.toContain(MARK_LATE);
    expect(execution.text).not.toContain(MARK_PENDING);

    // The new current set is exactly what the rewrite used.
    const rows = await currentRows(variant.id);
    const ids = rows.map((row) => row.knowledgeItemId);
    expect(ids).toContain(changing);
    expect(ids).toContain(replacement);
    expect(ids).not.toContain(expiring);
    expect(ids).not.toContain(retiring);
    expect(rows.find((row) => row.knowledgeItemId === changing)?.knowledgeVersion).toBe(2);
    // D-223: an APPROVED post edited by the rewrite returns to DRAFT.
    const after = await platform.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe('DRAFT');
  });

  it('a repeated, double or second-tab rewrite charges once and writes once', async () => {
    const id = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Cortado',
      body: 'Cortado brindlewort',
    });
    const { variant } = await generate('brindlewort');
    await inA((db) =>
      knowledge(db).updateItem({
        itemId: id,
        title: { en: 'Cortado' },
        body: { en: 'Cortado brindlewort, bigger' },
        actor: actor(),
        policy: STALENESS,
      }),
    );
    const model = scripted(() => REWRITTEN);
    const run = () =>
      inA((db) =>
        studio(db, model.gateway).applyTool({
          variantId: variant.id,
          tool: 'refresh_facts',
          // A different client key each time: the server derives its own.
          idempotencyKey: `refresh-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actorBrandScope: [],
          actorPermissionKeys: ['content.edit', 'copilot.use'],
        }),
      );
    const outcomes = await Promise.allSettled([run(), run()]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled').length).toBe(1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected') as
      PromiseRejectedResult | undefined;
    expect(refused?.reason).toMatchObject({ code: 'CONFLICT' });
    // One model call, one write, one current set.
    expect(model.calls.filter((call) => call.idempotencyKey !== 'quote').length).toBe(1);
    const rows = await allRows(variant.id);
    const current = rows.filter((row) => row.supersededAt === null);
    expect(current.filter((row) => row.knowledgeItemId === id).length).toBe(1);
    // And later still nothing is left to rewrite.
    await expect(run()).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('is refused, free, on a published post or when nothing changed', async () => {
    const { item, variant } = await generate();
    const model = scripted(() => REWRITTEN);
    const run = () =>
      inA((db) =>
        studio(db, model.gateway).applyTool({
          variantId: variant.id,
          tool: 'refresh_facts',
          idempotencyKey: `refresh-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actorBrandScope: [],
          actorPermissionKeys: ['content.edit', 'copilot.use'],
        }),
      );
    await expect(run()).rejects.toMatchObject({ code: 'CONFLICT' });
    await setStatus(item.id, 'PUBLISHED');
    await expect(run()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(model.calls).toEqual([]);
  });

  it('with Brand Brain off the rewrite is ungrounded and records no usage', async () => {
    const id = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Flat white',
      body: 'Flat white snorkelquill SWITCHED-OFF-MARK',
    });
    const { variant } = await generate('snorkelquill');
    await inA((db) => knowledge(db).archiveItem({ itemId: id, actor: actor() }));
    await inA((db) => switchBrandBrain(db, false));
    try {
      const model = scripted(() => REWRITTEN);
      await inA((db) =>
        studio(db, model.gateway).applyTool({
          variantId: variant.id,
          tool: 'refresh_facts',
          idempotencyKey: `refresh-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actorBrandScope: [],
          actorPermissionKeys: ['content.edit', 'copilot.use'],
        }),
      );
      expect(model.calls[0]!.text).not.toContain('BRAND BRAIN CONTEXT');
      expect(model.calls[0]!.text).not.toContain(MARK_OFFER);
      expect(await currentRows(variant.id)).toEqual([]);
    } finally {
      await inA((db) => switchBrandBrain(db, true));
    }
  });
});

/* ======================================================================== */

describe('Home "Needs you" — brand-brain-fact-changed', () => {
  const session = (permissionKeys: readonly string[]): CustomerWorkspaceContext =>
    ({
      workspaceId: fixtures.a.workspaceId,
      permissionKeys,
      brandScope: [],
    }) as unknown as CustomerWorkspaceContext;

  it('lists only SCHEDULED and IN_REVIEW posts with an undismissed change, to those who can act', async () => {
    const id = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Mocha',
      body: 'Mocha trombolisk',
    });
    const scheduled = await generate('trombolisk');
    const inReview = await generate('trombolisk');
    const draft = await generate('trombolisk');
    const approved = await generate('trombolisk');
    await setStatus(scheduled.item.id, 'SCHEDULED');
    await setStatus(inReview.item.id, 'IN_REVIEW');
    await setStatus(approved.item.id, 'APPROVED');
    await inA((db) =>
      knowledge(db).updateItem({
        itemId: id,
        title: { en: 'Mocha' },
        body: { en: 'Mocha trombolisk, dark' },
        actor: actor(),
        policy: STALENESS,
      }),
    );
    const listed = await inA((db) => contentWithFactChanges(db, { brandScope: [] }));
    expect(listed).toContain(scheduled.item.id);
    expect(listed).toContain(inReview.item.id);
    expect(listed).not.toContain(draft.item.id);
    expect(listed).not.toContain(approved.item.id);
    // Surfaced only: the scheduled post is still scheduled.
    const still = await platform.contentItem.findUniqueOrThrow({
      where: { id: scheduled.item.id },
    });
    expect(still.status).toBe('SCHEDULED');

    const withEverything = await inA((db) =>
      attentionItems(db, session(['content.read', 'content.edit', 'copilot.use'])),
    );
    expect(withEverything.some((item) => item.kind === 'brand-brain-fact-changed')).toBe(true);
    for (const missing of ['content.edit', 'copilot.use']) {
      const keys = ['content.read', 'content.edit', 'copilot.use'].filter((key) => key !== missing);
      const without = await inA((db) => attentionItems(db, session(keys)));
      expect(without.some((item) => item.kind === 'brand-brain-fact-changed')).toBe(false);
    }
    // A member scoped to another brand is told nothing about this one.
    const scopedOut = await inA((db) => contentWithFactChanges(db, { brandScope: [randomUUID()] }));
    expect(scopedOut).toEqual([]);
  });
});

/* ======================================================================== */

describe('"Used in N posts" — distinct live posts from current usage', () => {
  it('counts posts, not rows; ignores superseded, archived and deleted', async () => {
    const id = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Affogato',
      body: 'Affogato perpendiculum',
    });
    const count = () =>
      inA(
        async (db) => (await usedInPostsCounts(db, { brandId: fixtures.a.brandId })).get(id) ?? 0,
      );
    expect(await count()).toBe(0);
    const one = await generate('perpendiculum');
    const two = await generate('perpendiculum');
    const three = await generate('perpendiculum');
    expect(await count()).toBe(3);
    // A later version on another post still counts as the same fact.
    await inA((db) =>
      knowledge(db).updateItem({
        itemId: id,
        title: { en: 'Affogato' },
        body: { en: 'Affogato perpendiculum, with gelato' },
        actor: actor(),
        policy: STALENESS,
      }),
    );
    await generate('perpendiculum');
    expect(await count()).toBe(4);
    await setStatus(one.item.id, 'ARCHIVED');
    await platform.contentItem.update({
      where: { id: two.item.id },
      data: { deletedAt: new Date() },
    });
    expect(await count()).toBe(2);
    // Superseded: a rewrite that grounded on nothing drops the fact from the post.
    await platform.contentVariant.update({
      where: { id: three.variant.id },
      data: { body: 'zzzz yyyy' },
    });
    await inA((db) =>
      studio(db, scripted(() => REWRITTEN).gateway).applyTool({
        variantId: three.variant.id,
        tool: 'shorten',
        idempotencyKey: `n-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        actorPermissionKeys: ['content.edit'],
      }),
    );
    expect(await count()).toBe(1);
    // Another workspace sees none of it.
    expect((await inB((db) => usedInPostsCounts(db, { brandId: fixtures.a.brandId }))).size).toBe(
      0,
    );
  });
});

/* ======================================================================== */

describe('the chat’s domain rules — expectedVersion, Undo, MEMBER candidates', () => {
  it('a stale expectedVersion is "changed since" and writes nothing', async () => {
    const id = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Tea',
      body: 'Tea selection',
    });
    await inA((db) =>
      knowledge(db).updateItem({
        itemId: id,
        title: { en: 'Tea' },
        body: { en: 'Tea selection, two' },
        expectedVersion: 1,
        actor: actor(),
        policy: STALENESS,
      }),
    );
    await expect(
      inA((db) =>
        knowledge(db).updateItem({
          itemId: id,
          title: { en: 'Tea' },
          body: { en: 'Somebody else’s edit' },
          expectedVersion: 1,
          actor: actor(),
          policy: STALENESS,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', publicDetails: { expectedLockVersion: 1 } });
    const row = await platform.brandKnowledgeItem.findUniqueOrThrow({ where: { id } });
    expect(row.version).toBe(2);
    expect(row.body).toEqual({ en: 'Tea selection, two' });
  });

  it('Undo restores only the archive just made, once', async () => {
    const id = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Scones',
      body: 'Scones daily',
    });
    const archived = await inA((db) => knowledge(db).archiveItem({ itemId: id, actor: actor() }));
    const undo = (archivedVersion: number) =>
      inA((db) =>
        knowledge(db).undoArchive({
          itemId: id,
          archivedVersion,
          actor: actor(),
          policy: STALENESS,
        }),
      );
    const restored = await undo(archived.version);
    expect(restored.status).toBe('ACTIVE');
    expect(restored.body).toEqual({ en: 'Scones daily' });
    // Twice: nothing is written.
    await expect(undo(archived.version)).rejects.toMatchObject({ code: 'CONFLICT' });
    const afterDouble = await platform.brandKnowledgeItem.findUniqueOrThrow({ where: { id } });
    expect(afterDouble.version).toBe(restored.version);

    // Undo after a later change to the fact writes nothing either.
    const again = await inA((db) => knowledge(db).archiveItem({ itemId: id, actor: actor() }));
    await inA((db) =>
      knowledge(db).rollback({
        itemId: id,
        toVersion: again.version - 1,
        actor: actor(),
        policy: STALENESS,
      }),
    );
    await inA((db) =>
      knowledge(db).updateItem({
        itemId: id,
        title: { en: 'Scones' },
        body: { en: 'Scones and jam' },
        actor: actor(),
        policy: STALENESS,
      }),
    );
    await expect(undo(again.version)).rejects.toMatchObject({ code: 'CONFLICT' });
    const final = await platform.brandKnowledgeItem.findUniqueOrThrow({ where: { id } });
    expect(final.body).toEqual({ en: 'Scones and jam' });
    // Another workspace's Undo on this fact is a plain miss.
    await expect(
      inB((db) =>
        new BrandKnowledgeService({ db, workspaceId: fixtures.b.workspaceId }).undoArchive({
          itemId: id,
          archivedVersion: final.version,
          actor: { userId: fixtures.b.userId, permissionKeys: [], brandScope: [] },
          policy: STALENESS,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('Send for review creates a PENDING MEMBER candidate, never an ACTIVE fact; accepted, it is HUMAN', async () => {
    const key = `offers.member-${randomUUID().slice(0, 6)}`;
    const { candidateId } = await inA((db) =>
      knowledge(db).proposeFact({
        brandId: fixtures.a.brandId,
        area: 'OFFERS',
        itemKey: key,
        title: { en: 'Member proposal' },
        body: { en: 'Proposed by a member' },
        actor: actor(),
      }),
    );
    const candidate = await platform.brandKnowledgeCandidate.findUniqueOrThrow({
      where: { id: candidateId },
    });
    expect(candidate).toMatchObject({
      status: 'PENDING',
      sourceKind: 'MEMBER',
      proposedByUserId: fixtures.a.userId,
      sourceDocumentId: null,
      insightId: null,
    });
    expect(
      await platform.brandKnowledgeItem.count({
        where: { brandId: fixtures.a.brandId, itemKey: key },
      }),
    ).toBe(0);
    // The ONE inbox: the pending candidates of the brand.
    const inbox = await inA((db) =>
      db.brandKnowledgeCandidate.findMany({
        where: { brandId: fixtures.a.brandId, status: 'PENDING' },
        select: { id: true },
      }),
    );
    expect(inbox.map((row) => row.id)).toContain(candidateId);
    // Not in the bulk "accept the confident ones".
    const confident = await inA((db) =>
      knowledge(db).confidentCandidates({
        brandId: fixtures.a.brandId,
        minimumConfidenceMilli: 0,
        brandScope: [],
      }),
    );
    expect(confident.map((row) => row.id)).not.toContain(candidateId);

    const accepted = await inA((db) =>
      knowledge(db).reviewCandidate({
        candidateId,
        decision: 'accept',
        actor: actor(),
        policy: STALENESS,
      }),
    );
    const item = await platform.brandKnowledgeItem.findUniqueOrThrow({
      where: { id: accepted.itemId! },
    });
    expect(item).toMatchObject({ status: 'ACTIVE', origin: 'HUMAN' });
  });

  it('the M4b CHECK: a MEMBER candidate needs its proposer and carries no document or insight', async () => {
    const base = {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      area: 'OFFERS' as const,
      itemKey: `offers.check-${randomUUID().slice(0, 6)}`,
      extractedTitle: { en: 'x' },
      extractedBody: { en: 'x' },
      confidenceMilli: 1000,
      evidence: {},
      sourceKind: 'MEMBER' as const,
    };
    await expect(inA((db) => db.brandKnowledgeCandidate.create({ data: base }))).rejects.toThrow();
    await expect(
      inA((db) =>
        db.brandKnowledgeCandidate.create({
          data: {
            ...base,
            proposedByUserId: fixtures.a.userId,
            sourceDocumentId: fixtures.a.sourceDocumentId,
          },
        }),
      ),
    ).rejects.toThrow();
    const ok = await inA((db) =>
      db.brandKnowledgeCandidate.create({
        data: { ...base, proposedByUserId: fixtures.a.userId },
      }),
    );
    expect(ok.sourceKind).toBe('MEMBER');
    // A DOCUMENT candidate still needs its document, as before.
    await expect(
      inA((db) =>
        db.brandKnowledgeCandidate.create({
          data: { ...base, sourceKind: 'DOCUMENT', proposedByUserId: null },
        }),
      ),
    ).rejects.toThrow();
  });

  it('the local lookup finds expired facts, never archived ones, at most three', async () => {
    const expired = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Winter drinks',
      body: 'Winter drinks pumpernickelade',
      validUntil: new Date('2020-01-01T00:00:00Z'),
    });
    const gone = await newFact({
      area: 'OFFERS',
      key: `offers.${randomUUID().slice(0, 6)}`,
      title: 'Archived drinks',
      body: 'Archived pumpernickelade',
    });
    for (let index = 0; index < 3; index += 1) {
      await newFact({
        area: 'OFFERS',
        key: `offers.${randomUUID().slice(0, 6)}`,
        title: `More drinks ${index}`,
        body: 'pumpernickelade',
      });
    }
    await inA((db) => knowledge(db).archiveItem({ itemId: gone, actor: actor() }));
    const found = await inA((db) =>
      knowledge(db).matchFacts({
        brandId: fixtures.a.brandId,
        query: 'winter pumpernickelade',
        limit: 3,
        brandScope: [],
      }),
    );
    expect(found.length).toBe(3);
    expect(found[0]!.id).toBe(expired);
    expect(found.map((fact) => fact.id)).not.toContain(gone);
  });
});
