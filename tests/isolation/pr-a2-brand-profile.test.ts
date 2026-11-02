import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import type { AiGateway, AiGatewayResult } from '@brandspace/ai-gateway';
import {
  BRAND_PROFILE_LABEL,
  BrandBrainChatService,
  brandProfileFor,
} from '@brandspace/brand-brain';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PR A2 (item 9) — THE BRAND PROFILE IS APPROVED KNOWLEDGE, READ-ONLY, ONE SOURCE.
 *
 * The owner's test: the chat answers the brand colour #7935FE. The scripted
 * model answers only from what it was SHOWN, so the answer proves the profile
 * reached the context; nothing is copied into facts.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

/** A model that answers with the first hex colour it was shown, else "unknown". */
function colourReader() {
  const seen: string[] = [];
  const gateway = {
    async execute(request: {
      input?: { prompt?: string; untrustedContext?: readonly string[] };
    }): Promise<AiGatewayResult> {
      const shown = [request.input?.prompt ?? '', ...(request.input?.untrustedContext ?? [])].join(
        '\n',
      );
      seen.push(shown);
      // Only the CONTEXT blocks, never the question itself.
      const colour = /#[0-9A-F]{6}/.exec((request.input?.untrustedContext ?? []).join('\n'))?.[0];
      return {
        requestId: randomUUID(),
        status: 'SUCCEEDED',
        modelKey: 'mock',
        attemptedModelKeys: ['mock'],
        output: {
          kind: 'text',
          text: JSON.stringify({
            kind: 'answer',
            answer: colour ? `Your brand colour is ${colour}.` : 'unknown',
          }),
        },
        usage: { promptTokens: 1, completionTokens: 1 },
        creditsChargedMilli: 1000n,
        providerCostMicroMinor: 0n,
        failureClass: null,
        failureMessage: null,
        replayed: false,
        latencyMs: 1,
      } as unknown as AiGatewayResult;
    },
  } as unknown as AiGateway;
  return { gateway, seen };
}

const chat = (db: TenantScopedClient, gateway: AiGateway) =>
  new BrandBrainChatService({
    db,
    workspaceId: fixtures.a.workspaceId,
    gateway,
    policy: { retentionDays: 30, maxContextItems: 12, maxContextChars: 12_000 },
  });

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  await platform.brand.update({
    where: { id: fixtures.a.brandId },
    data: {
      colorPalette: ['#7935FE', '#ffdd15'],
      typography: { heading: 'IBM Plex Sans Arabic', body: 'Inter' },
      websiteUrl: 'https://example.com',
    },
  });
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('item 9 — the brand profile in the AI context', () => {
  it('the chat answers the brand colour #7935FE, with no fact about colours', async () => {
    const factsBefore = await platform.brandKnowledgeItem.count({
      where: { brandId: fixtures.a.brandId },
    });
    const model = colourReader();
    const turn = await inA((db) =>
      chat(db, model.gateway).send({
        brandId: fixtures.a.brandId,
        message: 'What is our brand colour?',
        idempotencyKey: `profile-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
      }),
    );
    expect(turn.assistantMessage.body).toBe('Your brand colour is #7935FE.');
    // Labelled, and stated to be approved and read-only.
    expect(model.seen.at(-1)).toContain(BRAND_PROFILE_LABEL);
    expect(model.seen.at(-1)).toMatch(/approved profile/);
    // One source: nothing was copied into facts.
    expect(
      await platform.brandKnowledgeItem.count({ where: { brandId: fixtures.a.brandId } }),
    ).toBe(factsBefore);
  });

  it('the Arabic question is recognised as a profile question too', async () => {
    const model = colourReader();
    const turn = await inA((db) =>
      chat(db, model.gateway).send({
        brandId: fixtures.a.brandId,
        message: 'ما لون علامتنا التجارية؟',
        idempotencyKey: `profile-ar-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
      }),
    );
    expect(turn.assistantMessage.body).toContain('#7935FE');
  });

  it('a question nothing answers that is not about the profile is still refused for free', async () => {
    const model = colourReader();
    const turn = await inA((db) =>
      chat(db, model.gateway).send({
        brandId: fixtures.a.brandId,
        message: 'What is our refund policy for wholesale buyers?',
        idempotencyKey: `profile-miss-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
      }),
    );
    expect(turn.insufficientKnowledge).toBe(true);
    expect(model.seen).toHaveLength(0);
  });

  it('the profile is read from the brand row: colours, fonts and website, normalised', async () => {
    const profile = await inA((db) => brandProfileFor(db, fixtures.a.brandId));
    expect(profile?.colours).toEqual(['#7935FE', '#FFDD15']);
    expect(profile?.fonts).toEqual(['IBM Plex Sans Arabic', 'Inter']);
    expect(profile?.websiteUrl).toBe('https://example.com');
  });

  it('ISOLATION: another workspace cannot read this brand’s profile', async () => {
    const profile = await withWorkspace(
      fixtures.b.workspaceId,
      (db) => brandProfileFor(db, fixtures.a.brandId),
      { prisma: app },
    );
    expect(profile).toBeNull();
  });
});
