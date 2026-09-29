import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import type { AiGateway, AiGatewayResult } from '@brandspace/ai-gateway';
import {
  BrandBrainChatService,
  BrandKnowledgeService,
  type KeyQuestion,
} from '@brandspace/brand-brain';
import {
  CopilotOrchestrator,
  parseCopilotPolicy,
  resolveLiveAuthorization,
  type LiveAuthorization,
} from '@brandspace/copilot';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2C-3 — BRAND BRAIN ASK (D7) AND THE COPILOT'S BRAND ANSWERS (D8),
 * through the real services on real PostgreSQL.
 *
 *   - Ask returns ONE structured answer: `answer` or `job`. A job is decided
 *     by the same model call — exactly one call, never a classifier — and it
 *     names the areas its facts came from, from retrieval.
 *   - A question nothing usable answers is FREE (no model call) and names the
 *     key question and area that would answer it.
 *   - The Copilot names the areas of its brand facts, says what is missing in
 *     the product's words, and NEVER writes Brand Brain knowledge: a save
 *     request proposes no step and is handed to Brand Brain → Add.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const KEY_QUESTIONS: {
  areas: Partial<Record<string, readonly KeyQuestion[]>>;
  offersSets: Record<string, readonly KeyQuestion[]>;
} = {
  areas: {
    OFFERS: [
      {
        key: 'prices',
        itemKey: 'offers.prices',
        prompt: { en: 'What are your prices?', ar: 'ما أسعاركم؟' },
      },
    ],
  },
  offersSets: {},
};

function scripted(respond: (text: string) => string) {
  const calls: string[] = [];
  const gateway = {
    async execute(request: {
      input?: { prompt?: string; untrustedContext?: readonly string[] };
    }): Promise<AiGatewayResult> {
      const text = [request.input?.prompt ?? '', ...(request.input?.untrustedContext ?? [])].join(
        '\n',
      );
      calls.push(text);
      return {
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
    },
    async quote() {
      return { taskKey: 'copilot.chat', estimateMilli: 1n, modelKeys: ['mock'] };
    },
  } as unknown as AiGateway;
  return { gateway, calls };
}

const chat = (db: TenantScopedClient, gateway: AiGateway) =>
  new BrandBrainChatService({
    db,
    workspaceId: fixtures.a.workspaceId,
    gateway,
    policy: { retentionDays: 30, maxContextItems: 12, maxContextChars: 12_000 },
  });

const ask = (gateway: AiGateway, message: string) =>
  inA((db) =>
    chat(db, gateway).send({
      brandId: fixtures.a.brandId,
      message,
      idempotencyKey: `ask-${randomUUID()}`,
      actorUserId: fixtures.a.userId,
      planKey: null,
      actorBrandScope: [],
      keyQuestions: KEY_QUESTIONS as never,
    }),
  );

const orchestrator = (db: TenantScopedClient, gateway: AiGateway) =>
  new CopilotOrchestrator({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: parseCopilotPolicy(defaultPayload('copilot')),
    gateway,
  });

async function authorization(): Promise<LiveAuthorization> {
  const resolved = await inA((db) =>
    resolveLiveAuthorization(db, fixtures.a.workspaceId, fixtures.a.userId),
  );
  if (!resolved) throw new Error('the fixture membership is missing');
  return resolved;
}

async function copilotTurn(gateway: AiGateway, request: string) {
  const auth = await authorization();
  const session = await inA((db) =>
    orchestrator(db, gateway).openSession({
      authorization: auth,
      brandId: fixtures.a.brandId,
      surface: 'general',
      locale: 'EN',
      expiresAt: null,
    }),
  );
  return inA((db) =>
    orchestrator(db, gateway).turn({
      sessionId: session.id,
      request,
      authorization: auth,
      planKey: null,
      idempotencyKey: `turn-${randomUUID()}`,
      locale: 'EN',
      expiresAt: null,
      keyQuestions: KEY_QUESTIONS as never,
    }),
  );
}

const PLAN = (fields: Record<string, unknown>) =>
  JSON.stringify({
    summary: { ar: 'جواب', en: 'An answer' },
    steps: [{ toolKey: 'content.draft', arguments: { brandId: fixtures.a.brandId, brief: 'x' } }],
    ...fields,
  });

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  await inA((db) =>
    new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).createItem({
      brandId: fixtures.a.brandId,
      area: 'OFFERS',
      itemKey: 'offers.current',
      title: { en: 'Cold brew offer' },
      body: { en: 'Cold brew is two for one on Fridays.' },
      actor: { userId: fixtures.a.userId, permissionKeys: [], brandScope: [] },
      policy: { reviewIntervalDays: 90 },
    }),
  );
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('D7 — Brand Brain Ask: answer, job or missing', () => {
  it('an answer names the areas it came from, from retrieval', async () => {
    const model = scripted(() => JSON.stringify({ kind: 'answer', answer: 'Two for one.' }));
    const turn = await ask(model.gateway, 'What is the cold brew offer?');
    expect(turn.kind).toBe('answer');
    expect(turn.areas).toEqual(['OFFERS']);
    expect(turn.assistantMessage.body).toBe('Two for one.');
  });

  it('a job is decided in the SAME structured answer — one call, no classifier', async () => {
    const postsBefore = await platform.contentItem.count({
      where: { workspaceId: fixtures.a.workspaceId },
    });
    const variantsBefore = await platform.contentVariant.count({
      where: { workspaceId: fixtures.a.workspaceId },
    });
    const model = scripted(() =>
      JSON.stringify({ kind: 'job', answer: 'Make three posts about cold brew.' }),
    );
    const turn = await ask(model.gateway, 'make 3 posts about cold brew');
    expect(turn.kind).toBe('job');
    expect(model.calls.length).toBe(1);
    // The prompt asks for the structured shape; the customer's words are fenced.
    expect(model.calls[0]).toContain('{"kind":"answer"|"job","answer":string}');
    expect(model.calls[0]).toContain('--- BEGIN CUSTOMER QUESTION');
    // Brand Brain chat never creates posts, variants or drafts.
    expect(
      await platform.contentItem.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    ).toBe(postsBefore);
    expect(
      await platform.contentVariant.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    ).toBe(variantsBefore);
  });

  it('an answer that is not the agreed shape is not stored', async () => {
    const model = scripted(() => 'free prose, not JSON');
    await expect(ask(model.gateway, 'What is the cold brew offer?')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('a miss is free and names the key question and area', async () => {
    const model = scripted(() => {
      throw new Error('a miss must not call the model');
    });
    const turn = await ask(model.gateway, 'What are your prices?');
    expect(turn.kind).toBe('missing');
    expect(turn.creditsChargedMilli).toBe(0n);
    expect(turn.missing).toMatchObject({ area: 'OFFERS', itemKey: 'offers.prices' });
    expect(model.calls).toEqual([]);
  });
});

describe('D8 — the Copilot answers from the same facts and never saves one', () => {
  it('a brand answer names the areas its facts came from', async () => {
    const model = scripted(() => PLAN({ brandBrainQuestion: true, steps: [] }));
    const turn = await copilotTurn(model.gateway, 'What is the cold brew offer?');
    expect(turn.notice).toBeNull();
    expect(turn.brandFactAreas).toEqual(['OFFERS']);
    expect(model.calls[0]).toContain('Cold brew is two for one');
  });

  it('a brand question nothing answers says so, naming the key question', async () => {
    const model = scripted(() => PLAN({ brandBrainQuestion: true }));
    const turn = await copilotTurn(model.gateway, 'What are your prices?');
    expect(turn.notice).toBe('brand_brain_missing');
    expect(turn.missing).toMatchObject({ area: 'OFFERS', itemKey: 'offers.prices' });
    expect(turn.steps).toEqual([]);
  });

  it('a save request proposes nothing, writes no knowledge and hands off to Brand Brain Add', async () => {
    const before = await platform.brandKnowledgeItem.count({
      where: { workspaceId: fixtures.a.workspaceId },
    });
    const candidatesBefore = await platform.brandKnowledgeCandidate.count({
      where: { workspaceId: fixtures.a.workspaceId },
    });
    const model = scripted(() =>
      PLAN({
        saveFact: { area: 'OFFERS', title: 'Friday hours', body: 'Open until 11 on Fridays' },
      }),
    );
    const turn = await copilotTurn(model.gateway, 'Save that we are open until 11 on Fridays');
    expect(turn.steps).toEqual([]);
    expect(turn.saveFact).toEqual({
      area: 'OFFERS',
      title: 'Friday hours',
      body: 'Open until 11 on Fridays',
    });
    expect(
      await platform.brandKnowledgeItem.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    ).toBe(before);
    expect(
      await platform.brandKnowledgeCandidate.count({
        where: { workspaceId: fixtures.a.workspaceId },
      }),
    ).toBe(candidatesBefore);
    // And the prompt tells the model it cannot save facts.
    expect(model.calls[0]).toContain('You cannot save, add or change brand facts');
  });

  it('with Brand Brain off, D-355’s notice is unchanged', async () => {
    await platform.brand.update({
      where: { id: fixtures.a.brandId },
      data: { useBrandBrain: false },
    });
    try {
      const model = scripted(() => PLAN({ brandBrainQuestion: true }));
      const turn = await copilotTurn(model.gateway, 'What is the cold brew offer?');
      expect(turn.notice).toBe('brand_brain_off');
      expect(turn.brandFactAreas).toEqual([]);
      expect(model.calls[0]).not.toContain('Cold brew is two for one');
    } finally {
      await platform.brand.update({
        where: { id: fixtures.a.brandId },
        data: { useBrandBrain: true },
      });
    }
  });
});
