import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import type { AiGateway, AiGatewayResult } from '@brandspace/ai-gateway';
import {
  CopilotOrchestrator,
  parseCopilotPolicy,
  resolveLiveAuthorization,
  type LiveAuthorization,
} from '@brandspace/copilot';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PR 2 (D-598) — THE COPILOT SEES THE BRAND.
 *
 * Staging, 2026-11-04 07:15 (Arabic conversation): right after "4 facts
 * approved." the owner asked «اية هما» and was told there were no approved
 * facts; «كلمني عن البراند» got "send me what it offers"; «اديك ألوان
 * البراند؟» got "send me the colours" — although the colours are in brand
 * settings. Causes: retrieval needs a shared WORD with the question, and a
 * brand question with no matching fact had the model's answer replaced by
 * "Brand Brain doesn't have that yet". Now:
 *
 *   - no shared word → the brand's usable facts are given instead (overview);
 *   - what was approved in the last day is named, by title;
 *   - the brand profile (colours, fonts, logo, name) answers its own questions
 *     and is never asked for;
 *   - the "missing" notice stays only for a key question nobody answered.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let auth: LiveAuthorization;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

interface Seen {
  readonly prompts: string[];
  readonly contexts: string[][];
}

function gateway(seen: Seen, brandBrainQuestion = true): AiGateway {
  return {
    async execute(input: {
      input?: { prompt?: string; untrustedContext?: readonly string[] };
    }): Promise<AiGatewayResult> {
      seen.prompts.push(input.input?.prompt ?? '');
      seen.contexts.push([...(input.input?.untrustedContext ?? [])]);
      return {
        requestId: randomUUID(),
        status: 'SUCCEEDED',
        modelKey: 'scripted',
        attemptedModelKeys: ['scripted'],
        output: {
          kind: 'text',
          text: JSON.stringify({ reply: 'The model’s own answer.', steps: [], brandBrainQuestion }),
        },
        usage: { promptTokens: 1, completionTokens: 1 },
        creditsChargedMilli: 100n,
        providerCostMicroMinor: 0n,
        failureClass: null,
        failureMessage: null,
        replayed: false,
        latencyMs: 1,
      };
    },
    async quote() {
      return { estimateMilli: 0n } as never;
    },
  } as unknown as AiGateway;
}

async function ask(request: string, seen: Seen, brandBrainQuestion = true) {
  const copilot = (db: TenantScopedClient) =>
    new CopilotOrchestrator({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: parseCopilotPolicy(defaultPayload('copilot')),
      gateway: gateway(seen, brandBrainQuestion),
    });
  const session = await inA((db) =>
    copilot(db).openSession({
      authorization: auth,
      brandId: fixtures.a.brandId,
      surface: 'general',
      locale: 'AR',
      expiresAt: null,
    }),
  );
  return inA((db) =>
    copilot(db).turn({
      sessionId: session.id,
      request,
      authorization: auth,
      planKey: null,
      idempotencyKey: `pr2-${randomUUID()}`,
      locale: 'AR',
      expiresAt: null,
    }),
  );
}

const fresh = (): Seen => ({ prompts: [], contexts: [] });

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  const resolved = await inA((db) =>
    resolveLiveAuthorization(db, fixtures.a.workspaceId, fixtures.a.userId),
  );
  if (!resolved) throw new Error('the fixture membership is missing');
  auth = resolved;
  await inA(async (db) => {
    await db.brand.update({
      where: { id: fixtures.a.brandId },
      data: { useBrandBrain: true, colorPalette: ['#7935FE', '#FFDD15'] },
    });
    // An English fact from a file, approved just now.
    await db.brandKnowledgeItem.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        area: 'OFFERS',
        memory: 'CANONICAL',
        origin: 'HUMAN',
        status: 'ACTIVE',
        itemKey: `offers.pr2-${randomUUID().slice(0, 8)}`,
        title: { en: 'Mobile vet visits at home' },
        body: { en: 'VETS VAN brings a licensed vet to the customer’s door across Riyadh.' },
        createdByUserId: fixtures.a.userId,
        version: 1,
      },
    });
  });
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('PR 2 · the Copilot sees the brand', () => {
  it('«اية هما» right after approving: the facts are given and the model’s answer stands', async () => {
    const seen = fresh();
    const turn = await ask('اية هما', seen);
    const context = seen.contexts[0]?.join('\n') ?? '';
    // No word shared with the English facts, and still they are given.
    expect(context).toContain('BRAND BRAIN CONTEXT');
    expect(context).toContain('VETS VAN brings a licensed vet');
    // And what was approved in the last day is named.
    expect(context).toContain('APPROVED IN THE LAST DAY');
    expect(context).toContain('OFFERS: Mobile vet visits at home');
    expect(turn.notice).toBeNull();
    expect(turn.summary.ar).toBe('The model’s own answer.');
  });

  it('«كلمني عن البراند»: the overview is given, no "missing" notice', async () => {
    const seen = fresh();
    const turn = await ask('كلمني عن البراند', seen);
    expect(seen.contexts[0]?.join('\n')).toContain('VETS VAN brings a licensed vet');
    expect(turn.notice).toBeNull();
  });

  it('«اديك ألوان البراند؟»: the colours are in the profile, never asked for', async () => {
    const seen = fresh();
    const turn = await ask('اديك ألوان البراند؟', seen);
    expect(seen.contexts[0]?.join('\n')).toContain('Brand colours: #7935FE, #FFDD15');
    expect(seen.prompts[0]).toContain('never ask the person to send them');
    expect(turn.notice).toBeNull();
  });

  it('with Brand Brain switched off, no fact and no "approved" list is read', async () => {
    await inA((db) =>
      db.brand.update({ where: { id: fixtures.a.brandId }, data: { useBrandBrain: false } }),
    );
    try {
      const seen = fresh();
      await ask('اية هما', seen, false);
      const context = seen.contexts[0]?.join('\n') ?? '';
      expect(context).not.toContain('BRAND BRAIN CONTEXT');
      expect(context).not.toContain('APPROVED IN THE LAST DAY');
    } finally {
      await inA((db) =>
        db.brand.update({ where: { id: fixtures.a.brandId }, data: { useBrandBrain: true } }),
      );
    }
  });
});
