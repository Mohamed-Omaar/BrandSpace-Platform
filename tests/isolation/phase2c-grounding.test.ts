import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import type { AiGateway, AiGatewayResult } from '@brandspace/ai-gateway';
import { BrandBrainChatService, groundingFor } from '@brandspace/brand-brain';
import { ContentStudioService, parseContentPolicy } from '@brandspace/content';
import {
  CopilotOrchestrator,
  TOOL_EXECUTORS,
  parseCopilotPolicy,
  resolveLiveAuthorization,
  type LiveAuthorization,
} from '@brandspace/copilot';
import {
  AnalyticsQueryService,
  createAnalyticsRegistry,
  parseAnalyticsPolicy,
} from '@brandspace/analytics';
import { StrategyService } from '@brandspace/intelligence';
import { saveBrandUseBrandBrain } from '../../apps/dashboard/src/server/publishing-defaults';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2C, ITEM 1 — WHAT MAY GROUND AI WRITING, against real PostgreSQL.
 *
 * Q14 / Q20: every GENERATIVE path — Brand Brain's "Talk with the brand",
 * captions, the Studio's inline tools, the Copilot, Strategy — is grounded on
 * APPROVED facts only. Never a pending candidate, never an archived, draft or
 * proposed item, never another workspace's fact, and NEVER a document's raw
 * text, even when that text is the closest match to the question.
 *
 * D9: the brand's "Use Brand Brain" switch. Off, none of those facts reaches a
 * writing path — the Copilot included, end to end: its turn context, the
 * arguments its tools are handed, and the drafts its tools write — and nothing
 * refuses because the switch is off. Brand Brain's own chat is not affected.
 *
 * Every row carries a marker, and every recorded prompt and context is searched
 * for the markers that must never be there.
 */

const TOKEN = 'zephyrine';
const APPROVED = 'APPROVED-FACT-P2C';
const STALE = 'STALE-FACT-P2C';
const ARCHIVED = 'ARCHIVED-FACT-P2C';
const PROPOSED = 'PROPOSED-FACT-P2C';
const DRAFT = 'DRAFT-FACT-P2C';
const PENDING = 'PENDING-CANDIDATE-P2C';
const RAW_CHUNK = 'RAW-CHUNK-TEXT-P2C';
const FOREIGN = 'FOREIGN-FACT-P2C';

const FORBIDDEN = [ARCHIVED, PROPOSED, DRAFT, PENDING, RAW_CHUNK, FOREIGN];
const EVERY_FACT = [APPROVED, STALE, ...FORBIDDEN];

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

/* ------------------------------------------------------------ a recording model */

interface Recorded {
  /** Every prompt and every untrusted-context block a model was handed. */
  readonly seen: string[];
}

const recorded = (): Recorded => ({ seen: [] });

/** The markers in a piece of text, in a fixed order. */
function markersIn(text: string): string[] {
  return EVERY_FACT.filter((marker) => text.includes(marker));
}

/**
 * A SCRIPTED MODEL THAT REPEATS EVERY FACT IT WAS SHOWN. Whatever it answers —
 * a caption, a plan summary, a tool's arguments — carries the markers of the
 * facts in its input, so a fact that reached the model is visible in what the
 * model produced.
 */
function gateway(record: Recorded, respond: (seenMarkers: string) => string): AiGateway {
  const see = (input: { input?: { prompt?: string; untrustedContext?: readonly string[] } }) => {
    const parts = [input.input?.prompt ?? '', ...(input.input?.untrustedContext ?? [])];
    record.seen.push(...parts);
    return markersIn(parts.join('\n')).join(' ') || 'none';
  };
  return {
    async execute(input: {
      input?: { prompt?: string; untrustedContext?: readonly string[] };
    }): Promise<AiGatewayResult> {
      return {
        requestId: randomUUID(),
        status: 'SUCCEEDED',
        modelKey: 'mock',
        attemptedModelKeys: ['mock'],
        output: { kind: 'text', text: respond(see(input)) },
        usage: { promptTokens: 1, completionTokens: 1 },
        creditsChargedMilli: 100n,
        providerCostMicroMinor: 0n,
        failureClass: null,
        failureMessage: null,
        replayed: false,
        latencyMs: 1,
      };
    },
    async quote(input: { input?: { prompt?: string; untrustedContext?: readonly string[] } }) {
      see(input);
      return { estimateMilli: 1n } as never;
    },
  } as unknown as AiGateway;
}

const CAPTION = (echo: string) =>
  JSON.stringify({
    title: 'A post',
    variants: [{ platformKey: 'instagram', body: `A caption. ${echo}`, hashtags: [] }],
  });
const TOOL_BODY = (echo: string) => JSON.stringify({ body: `Rewritten. ${echo}`, hashtags: [] });
/** Phase 2C-3 (D7) — Ask answers in its structured shape; the facts it saw, echoed. */
const ASK = (echo: string) => JSON.stringify({ kind: 'answer', answer: `Answer. ${echo}` });

/** A Copilot plan whose summary AND tool arguments repeat what the model saw. */
const PLAN = (brandQuestion: boolean) => (echo: string) =>
  JSON.stringify({
    summary: { ar: `ملخص ${echo}`, en: `Summary ${echo}` },
    steps: [
      {
        toolKey: 'content.draft',
        arguments: { brandId: fixtures.a.brandId, brief: `Posts about ${echo}` },
      },
      { toolKey: 'brand.context', arguments: { brandId: fixtures.a.brandId, question: echo } },
    ],
    brandBrainQuestion: brandQuestion,
  });

const STRATEGY_JSON = JSON.stringify({
  summary: { ar: 'ملخص الخطة', en: 'A plan summary' },
  pillars: [
    {
      name: { ar: 'الركيزة', en: 'Pillar' },
      rationale: { evidenceRefs: [1], text: { ar: 'سبب', en: 'A reason' } },
      sharePercent: 50,
    },
  ],
  channelMix: [
    {
      platformKey: 'linkedin',
      sharePercent: 50,
      rationale: { evidenceRefs: [1], text: { ar: 'سبب', en: 'A reason' } },
    },
  ],
  monthlyPlan: [
    {
      weekNumber: 1,
      theme: { ar: 'الإطلاق', en: 'Launch' },
      postsPlanned: 3,
      rationale: { evidenceRefs: [1], text: { ar: 'سبب', en: 'A reason' } },
    },
  ],
});

/* ------------------------------------------------------------------ services */

const contentPolicy = () => parseContentPolicy(defaultPayload('content'));
const analyticsPolicy = () => parseAnalyticsPolicy(defaultPayload('analytics'));

const studio = (db: TenantScopedClient, gw: AiGateway) =>
  new ContentStudioService({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: contentPolicy(),
    gateway: gw,
  });

const strategy = (db: TenantScopedClient, gw: AiGateway, minimumKnowledgeItems?: number) =>
  new StrategyService({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: analyticsPolicy(),
    queries: new AnalyticsQueryService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: analyticsPolicy(),
      registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
    }),
    gateway: gw,
    // Left at the product's own floor unless a test says otherwise: with the
    // switch off, Strategy must write ungrounded rather than refuse at it.
    ...(minimumKnowledgeItems === undefined ? {} : { minimumKnowledgeItems }),
  });

const orchestrator = (db: TenantScopedClient, gw: AiGateway) =>
  new CopilotOrchestrator({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: parseCopilotPolicy(defaultPayload('copilot')),
    gateway: gw,
  });

async function authorization(): Promise<LiveAuthorization> {
  const resolved = await inA((db) =>
    resolveLiveAuthorization(db, fixtures.a.workspaceId, fixtures.a.userId),
  );
  if (!resolved) throw new Error('the fixture membership is missing');
  return resolved;
}

async function setSwitch(enabled: boolean): Promise<void> {
  await platform.brand.update({
    where: { id: fixtures.a.brandId },
    data: { useBrandBrain: enabled },
  });
}

const QUESTION = `What does ${TOKEN} offer?`;
const period = {
  start: new Date('2026-06-01T00:00:00.000Z'),
  end: new Date('2026-06-30T23:59:59.000Z'),
};

/* --------------------------------------------------------------------- setup */

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);

  const item = (
    workspaceId: string,
    brandId: string,
    itemKey: string,
    status: 'ACTIVE' | 'STALE' | 'ARCHIVED' | 'PROPOSED' | 'DRAFT',
    marker: string,
  ) =>
    platform.brandKnowledgeItem.create({
      data: {
        workspaceId,
        brandId,
        area: 'OFFERS',
        memory: 'CANONICAL',
        origin: 'HUMAN',
        status,
        itemKey,
        title: { en: `${TOKEN} ${marker}` },
        body: { en: `${TOKEN} offers ${marker}` },
        version: 1,
        ...(status === 'ARCHIVED' ? { archivedAt: new Date() } : {}),
      },
    });

  await item(fixtures.a.workspaceId, fixtures.a.brandId, 'p2c.approved', 'ACTIVE', APPROVED);
  await item(fixtures.a.workspaceId, fixtures.a.brandId, 'p2c.stale', 'STALE', STALE);
  await item(fixtures.a.workspaceId, fixtures.a.brandId, 'p2c.archived', 'ARCHIVED', ARCHIVED);
  await item(fixtures.a.workspaceId, fixtures.a.brandId, 'p2c.proposed', 'PROPOSED', PROPOSED);
  await item(fixtures.a.workspaceId, fixtures.a.brandId, 'p2c.draft', 'DRAFT', DRAFT);
  await item(fixtures.b.workspaceId, fixtures.b.brandId, 'p2c.foreign', 'ACTIVE', FOREIGN);

  /*
   * A READY document whose raw text is THE BEST MATCH for the question — the
   * token three times over — and a pending candidate it proposed. Neither may
   * ever reach a writing prompt.
   */
  const run = randomUUID().slice(0, 8);
  const document = await platform.brandSourceDocument.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      fileName: `p2c-${run}.txt`,
      mimeType: 'text/plain',
      byteSize: 64,
      checksum: `p2c-${run}`,
      storageKey: `ws/${fixtures.a.workspaceId}/brand-brain/p2c-${run}`,
      status: 'READY',
      idempotencyKey: `p2c-${run}`,
    },
  });
  await platform.brandSourceChunk.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      sourceDocumentId: document.id,
      chunkIndex: 0,
      text: `${TOKEN} ${TOKEN} ${TOKEN} what does it offer: ${RAW_CHUNK}`,
    },
  });
  await platform.brandKnowledgeCandidate.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      sourceDocumentId: document.id,
      area: 'OFFERS',
      itemKey: 'p2c.pending',
      extractedTitle: { en: `${TOKEN} ${PENDING}` },
      extractedBody: { en: `${TOKEN} offers ${PENDING}` },
      confidenceMilli: 900,
      evidence: [],
      status: 'PENDING',
    },
  });
});

afterAll(async () => {
  await setSwitch(true).catch(() => undefined);
  await app?.$disconnect();
  await platform?.$disconnect();
});

/* --------------------------------------------------------------------- tests */

describe('Q14 / Q20 — approved facts only, never raw document text', () => {
  it('the shared grounding returns approved and stale facts, each at its exact version', async () => {
    const grounding = await inA((db) =>
      groundingFor(db, {
        brandId: fixtures.a.brandId,
        question: QUESTION,
        purpose: 'writing',
        maxItems: 20,
        maxChars: 20_000,
      }),
    );
    expect(markersIn(grounding.contextText)).toEqual([APPROVED, STALE]);
    expect(grounding.facts).toHaveLength(2);
    for (const fact of grounding.facts) expect(fact.version).toBe(1);
    expect(grounding.citations.every((citation) => citation.kind === 'knowledge')).toBe(true);
  });

  it('Brand Brain chat (Ask) answers from approved facts only', async () => {
    const record = recorded();
    const turn = await inA((db) =>
      new BrandBrainChatService({
        db,
        workspaceId: fixtures.a.workspaceId,
        gateway: gateway(record, ASK),
        policy: { retentionDays: 30, maxContextItems: 12, maxContextChars: 12_000 },
      }).send({
        brandId: fixtures.a.brandId,
        message: QUESTION,
        idempotencyKey: `ask-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
      }),
    );
    expect(markersIn(record.seen.join('\n'))).toEqual([APPROVED, STALE]);
    expect(turn.citations.every((citation) => citation.kind === 'knowledge')).toBe(true);
  });

  it('captions, their quote and the Studio tools see approved facts only', async () => {
    const record = recorded();
    const generated = await inA((db) =>
      studio(db, gateway(record, CAPTION)).generate({
        brandId: fixtures.a.brandId,
        brief: QUESTION,
        locale: 'EN',
        platformKeys: ['instagram'],
        idempotencyKey: `gen-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        retention: { subscriptionActive: true },
      }),
    );
    const variant = generated.variants[0];
    if (!variant) throw new Error('no variant');
    await inA((db) =>
      studio(db, gateway(record, TOOL_BODY)).quote({
        brandId: fixtures.a.brandId,
        brief: QUESTION,
        platformKeys: ['instagram'],
        planKey: null,
        actorBrandScope: [],
      }),
    );
    await inA((db) =>
      studio(db, gateway(record, TOOL_BODY)).applyTool({
        variantId: variant.id,
        tool: 'rewrite',
        idempotencyKey: `tool-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        actorPermissionKeys: ['content.edit', 'content.schedule'],
      }),
    );
    expect(markersIn(record.seen.join('\n'))).toEqual([APPROVED, STALE]);
    expect(generated.citations.map((citation) => citation.kind)).toEqual([
      'knowledge',
      'knowledge',
    ]);
  });

  it('the Copilot turn sees approved facts only', async () => {
    const record = recorded();
    const auth = await authorization();
    const session = await inA((db) =>
      orchestrator(db, gateway(record, PLAN(false))).openSession({
        authorization: auth,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );
    await inA((db) =>
      orchestrator(db, gateway(record, PLAN(false))).turn({
        sessionId: session.id,
        request: QUESTION,
        authorization: auth,
        planKey: null,
        idempotencyKey: `turn-${randomUUID()}`,
        locale: 'EN',
        expiresAt: null,
      }),
    );
    expect(markersIn(record.seen.join('\n'))).toEqual([APPROVED, STALE]);
  });

  it('Strategy sees approved facts only', async () => {
    const record = recorded();
    await inA((db) =>
      // Two usable facts here, so the floor is lowered for this one: this test
      // is about WHICH facts the model sees, not how many it needs.
      strategy(
        db,
        gateway(record, () => STRATEGY_JSON),
        0,
      ).generate({
        brandId: fixtures.a.brandId,
        period,
        objective: QUESTION,
        idempotencyKey: `strategy-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        expiresAt: null,
      }),
    );
    const seen = markersIn(record.seen.join('\n'));
    expect(seen).toContain(APPROVED);
    expect(seen.filter((marker) => FORBIDDEN.includes(marker))).toEqual([]);
  });
});

describe('D9 — "Use Brand Brain" off', () => {
  beforeAll(async () => {
    await setSwitch(false);
  });
  afterAll(async () => {
    await setSwitch(true);
  });

  it('writing grounding is empty, and the knowledge table is not even read', async () => {
    let reads = 0;
    const grounding = await inA((db) =>
      groundingFor(
        new Proxy(db, {
          get(target, property, receiver) {
            if (property === 'brandKnowledgeItem') reads += 1;
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
        {
          brandId: fixtures.a.brandId,
          question: QUESTION,
          purpose: 'writing',
          maxItems: 20,
          maxChars: 20_000,
        },
      ),
    );
    expect(grounding.enabled).toBe(false);
    expect(grounding.facts).toEqual([]);
    expect(grounding.contextText).toBe('');
    expect(reads).toBe(0);
  });

  it('Brand Brain chat (Ask) is NOT affected and still answers from approved facts', async () => {
    const record = recorded();
    await inA((db) =>
      new BrandBrainChatService({
        db,
        workspaceId: fixtures.a.workspaceId,
        gateway: gateway(record, ASK),
        policy: { retentionDays: 30, maxContextItems: 12, maxContextChars: 12_000 },
      }).send({
        brandId: fixtures.a.brandId,
        message: QUESTION,
        idempotencyKey: `ask-off-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
      }),
    );
    expect(markersIn(record.seen.join('\n'))).toEqual([APPROVED, STALE]);
  });

  it('captions and tools are written UNGROUNDED rather than refused, with no fact anywhere', async () => {
    const record = recorded();
    const generated = await inA((db) =>
      studio(db, gateway(record, CAPTION)).generate({
        brandId: fixtures.a.brandId,
        brief: QUESTION,
        locale: 'EN',
        platformKeys: ['instagram'],
        idempotencyKey: `gen-off-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        retention: { subscriptionActive: true },
      }),
    );
    expect(generated.insufficientKnowledge).toBe(false);
    expect(generated.variants).toHaveLength(1);
    expect(generated.citations).toEqual([]);
    const variant = generated.variants[0];
    if (!variant) throw new Error('no variant');
    await inA((db) =>
      studio(db, gateway(record, TOOL_BODY)).applyTool({
        variantId: variant.id,
        tool: 'rewrite',
        idempotencyKey: `tool-off-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        actorPermissionKeys: ['content.edit', 'content.schedule'],
      }),
    );
    expect(markersIn(record.seen.join('\n'))).toEqual([]);
    expect(record.seen.join('\n')).not.toContain('BRAND BRAIN CONTEXT');
    expect(
      await platform.auditEvent.findFirst({
        where: { action: 'content.item.generated', resourceId: generated.item.id },
        select: { after: true },
      }),
    ).toMatchObject({ after: { brandBrain: false, knowledgeItems: 0 } });
  });

  it('Strategy is generated ungrounded instead of refusing below the knowledge floor', async () => {
    const record = recorded();
    const result = await inA((db) =>
      strategy(
        db,
        gateway(record, () => STRATEGY_JSON),
      ).generate({
        brandId: fixtures.a.brandId,
        period,
        objective: QUESTION,
        idempotencyKey: `strategy-off-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        expiresAt: null,
      }),
    );
    expect(result.insufficientGrounding).toBe(false);
    expect(result.insight).not.toBeNull();
    expect(markersIn(record.seen.join('\n'))).toEqual([]);
  });

  it('the Copilot, END TO END: no fact in its context, its history, its tool arguments or its drafts', async () => {
    const auth = await authorization();

    // A brand question asked EARLIER in this conversation, while the switch was
    // on: the model's answer repeats the facts it was shown.
    await setSwitch(true);
    const earlier = recorded();
    const session = await inA((db) =>
      orchestrator(db, gateway(earlier, PLAN(false))).openSession({
        authorization: auth,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );
    const grounded = await inA((db) =>
      orchestrator(db, gateway(earlier, PLAN(false))).turn({
        sessionId: session.id,
        request: QUESTION,
        authorization: auth,
        planKey: null,
        idempotencyKey: `turn-on-${randomUUID()}`,
        locale: 'EN',
        expiresAt: null,
      }),
    );
    // The control: while on, the answer did carry the facts into the history.
    expect(grounded.summary.en).toContain(APPROVED);

    await setSwitch(false);
    const record = recorded();
    const turn = await inA((db) =>
      orchestrator(db, gateway(record, PLAN(false))).turn({
        sessionId: session.id,
        request: `Make 3 posts about ${TOKEN}`,
        authorization: auth,
        planKey: null,
        idempotencyKey: `turn-off-${randomUUID()}`,
        locale: 'EN',
        expiresAt: null,
      }),
    );
    // Nothing the model saw — prompt, history, context — held a fact.
    expect(markersIn(record.seen.join('\n'))).toEqual([]);
    // So nothing it wrote does either: its summary and its tool arguments.
    expect(markersIn(JSON.stringify({ summary: turn.summary, steps: turn.steps }))).toEqual([]);
    // The Brand Brain tool was not even offered, and a model reaching for it anyway is refused.
    expect(record.seen.join('\n')).not.toContain('- brand.context');
    expect(turn.rejectedToolKeys).toContain('brand.context');
    expect(turn.steps.map((step) => step.toolKey)).toEqual(['content.draft']);

    // The tool itself reads nothing while the switch is off (a plan made earlier
    // is re-read live at execution).
    const toolRun = await inA((db) =>
      TOOL_EXECUTORS['brand.context']!({ db } as never, {
        brandId: fixtures.a.brandId,
        question: QUESTION,
      }),
    );
    expect(toolRun.result).toMatchObject({ knowledgeItems: 0, brandBrain: false });

    // And the drafting tool's generation is the Studio's, grounded on nothing.
    const drafted = recorded();
    await inA((db) =>
      studio(db, gateway(drafted, CAPTION)).generate({
        brandId: fixtures.a.brandId,
        brief: String(turn.steps[0]?.arguments['brief'] ?? ''),
        locale: 'EN',
        platformKeys: ['instagram'],
        idempotencyKey: `copilot-draft-off-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        retention: { subscriptionActive: true },
      }),
    );
    expect(markersIn(drafted.seen.join('\n'))).toEqual([]);
  });

  it('a brand question to the Copilot gets the notice, not an answer and not a plan', async () => {
    const auth = await authorization();
    const record = recorded();
    const session = await inA((db) =>
      orchestrator(db, gateway(record, PLAN(true))).openSession({
        authorization: auth,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );
    const turn = await inA((db) =>
      orchestrator(db, gateway(record, PLAN(true))).turn({
        sessionId: session.id,
        request: QUESTION,
        authorization: auth,
        planKey: null,
        idempotencyKey: `turn-question-${randomUUID()}`,
        locale: 'EN',
        expiresAt: null,
      }),
    );
    expect(turn.notice).toBe('brand_brain_off');
    expect(turn.steps).toEqual([]);
    expect(record.seen.join('\n')).toContain('BRAND BRAIN IS TURNED OFF FOR THIS BRAND');
    expect(markersIn(record.seen.join('\n'))).toEqual([]);
  });
});

describe('Settings → AI — the switch itself', () => {
  it('is saved per brand, audited, and never reaches another workspace', async () => {
    const context = {
      workspaceId: fixtures.a.workspaceId,
      actorUserId: fixtures.a.userId,
      brandScope: [],
    };
    await withWorkspace(
      fixtures.a.workspaceId,
      (db) => saveBrandUseBrandBrain(db, context, { brandId: fixtures.a.brandId, enabled: false }),
      { prisma: app },
    );
    expect(
      (
        await platform.brand.findUniqueOrThrow({
          where: { id: fixtures.a.brandId },
          select: { useBrandBrain: true },
        })
      ).useBrandBrain,
    ).toBe(false);
    expect(
      await platform.auditEvent.count({
        where: { action: 'brand.use_brand_brain.changed', resourceId: fixtures.a.brandId },
      }),
    ).toBe(1);

    await expect(
      withWorkspace(
        fixtures.b.workspaceId,
        (db) =>
          saveBrandUseBrandBrain(
            db,
            { ...context, workspaceId: fixtures.b.workspaceId },
            { brandId: fixtures.a.brandId, enabled: true },
          ),
        { prisma: app },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (
        await platform.brand.findUniqueOrThrow({
          where: { id: fixtures.a.brandId },
          select: { useBrandBrain: true },
        })
      ).useBrandBrain,
    ).toBe(false);
    await setSwitch(true);
  });
});
