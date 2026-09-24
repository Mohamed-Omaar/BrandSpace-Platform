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
  type CopilotSubject,
  type LiveAuthorization,
} from '@brandspace/copilot';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 6 FINAL · D-280 — THE COPILOT KNOWS WHAT THE PERSON IS LOOKING AT.
 *
 * A conversation opened on a campaign, a post or an insight records which one.
 * That is a new way for a caller to NAME a tenant row, so it gets the same
 * treatment every other name gets:
 *
 *   - another workspace's object, another brand's object and an id that never
 *     existed are refused IDENTICALLY, before any row is written;
 *   - an admitted subject reaches the model only inside the fenced untrusted
 *     block, with its title read FRESH on every turn;
 *   - a subject deleted since the session opened is simply absent.
 *
 * Every fixture this suite needs, it creates itself.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let otherBrandId: string;
let campaignA: string;
let campaignOtherBrand: string;
let campaignB: string;
let itemA: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

interface Calls {
  readonly contexts: string[];
  readonly prompts: string[];
}

function gateway(calls: Calls): AiGateway {
  return {
    async execute(input: {
      input?: { prompt?: string; untrustedContext?: readonly string[] };
    }): Promise<AiGatewayResult> {
      calls.prompts.push(input.input?.prompt ?? '');
      calls.contexts.push(...(input.input?.untrustedContext ?? []));
      return {
        requestId: randomUUID(),
        status: 'SUCCEEDED',
        modelKey: 'mock',
        attemptedModelKeys: ['mock'],
        output: {
          kind: 'text',
          text: JSON.stringify({ summary: { ar: 'ملخص', en: 'A summary' }, steps: [] }),
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

const orchestrator = (db: TenantScopedClient, calls: Calls = { contexts: [], prompts: [] }) =>
  new CopilotOrchestrator({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: parseCopilotPolicy(defaultPayload('copilot')),
    gateway: gateway(calls),
  });

async function authorization(): Promise<LiveAuthorization> {
  const resolved = await inA((db) =>
    resolveLiveAuthorization(db, fixtures.a.workspaceId, fixtures.a.userId),
  );
  if (!resolved) throw new Error('the fixture membership is missing');
  return resolved;
}

async function refusal(subject: CopilotSubject): Promise<{ code: string; message: string }> {
  const auth = await authorization();
  try {
    await inA((db) =>
      orchestrator(db).openSession({
        authorization: auth,
        brandId: fixtures.a.brandId,
        surface: 'campaigns',
        locale: 'EN',
        expiresAt: null,
        subject,
      }),
    );
  } catch (error: unknown) {
    const shaped = error as { code?: string; message?: string };
    return { code: shaped.code ?? 'NOT_AN_APP_ERROR', message: shaped.message ?? '' };
  }
  throw new Error('expected a refusal, but the session opened');
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);

  const suffix = randomUUID().slice(0, 8);
  otherBrandId = (
    await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        name: `Other brand ${suffix}`,
        slug: `other-brand-${suffix}`,
        status: 'ACTIVE',
        defaultLocale: 'EN',
        supportedLocales: ['EN'],
      },
      select: { id: true },
    })
  ).id;
  const campaign = (workspaceId: string, brandId: string, name: string) =>
    platform.campaign
      .create({
        data: { workspaceId, brandId, name, objective: 'AWARENESS' },
        select: { id: true },
      })
      .then((row) => row.id);
  campaignA = await campaign(fixtures.a.workspaceId, fixtures.a.brandId, 'October Awareness');
  campaignOtherBrand = await campaign(fixtures.a.workspaceId, otherBrandId, 'Other brand plan');
  campaignB = await campaign(fixtures.b.workspaceId, fixtures.b.brandId, 'Foreign campaign');
  itemA = (
    await platform.contentItem.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        title: 'Signs your cat may be unwell',
        status: 'DRAFT',
      },
      select: { id: true },
    })
  ).id;
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('D-280 · a subject is admitted against the session’s brand, or nothing opens', () => {
  it('another workspace’s, another brand’s and a fabricated subject are refused identically', async () => {
    const before = await inA((db) => db.copilotSession.count());

    const foreign = await refusal({ type: 'CAMPAIGN', id: campaignB });
    const otherBrand = await refusal({ type: 'CAMPAIGN', id: campaignOtherBrand });
    const fabricated = await refusal({ type: 'CAMPAIGN', id: randomUUID() });
    const wrongKind = await refusal({ type: 'CONTENT_ITEM', id: campaignA });

    for (const refused of [foreign, otherBrand, fabricated, wrongKind]) {
      expect(refused.code).toBe('NOT_FOUND');
      expect(refused.message).toBe(foreign.message);
    }
    // NOTHING WAS WRITTEN: the refusal is an admission, before the row.
    expect(await inA((db) => db.copilotSession.count())).toBe(before);
  });

  it('a brand-less session cannot carry a subject', async () => {
    const auth = await authorization();
    await expect(
      inA((db) =>
        orchestrator(db).openSession({
          authorization: auth,
          brandId: null,
          surface: 'general',
          locale: 'EN',
          expiresAt: null,
          subject: { type: 'CAMPAIGN', id: campaignA },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the database refuses half a subject', async () => {
    await expect(
      inA((db) =>
        db.copilotSession.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            userId: fixtures.a.userId,
            brandId: fixtures.a.brandId,
            subjectType: 'CAMPAIGN',
            subjectId: null,
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      inA((db) =>
        db.copilotSession.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            userId: fixtures.a.userId,
            brandId: fixtures.a.brandId,
            subjectType: 'WORKSPACE',
            subjectId: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('D-280 · an admitted subject reaches the model fenced, and fresh', () => {
  it('a campaign subject: the kind in the instruction, the name only in the fenced block', async () => {
    const auth = await authorization();
    const session = await inA((db) =>
      orchestrator(db).openSession({
        authorization: auth,
        brandId: fixtures.a.brandId,
        surface: 'campaigns',
        locale: 'EN',
        expiresAt: null,
        subject: { type: 'CAMPAIGN', id: campaignA },
      }),
    );
    expect(session.subjectType).toBe('CAMPAIGN');
    expect(session.subjectId).toBe(campaignA);

    const calls: Calls = { contexts: [], prompts: [] };
    await inA((db) =>
      orchestrator(db, calls).turn({
        sessionId: session.id,
        request: 'Plan two more posts for this',
        authorization: auth,
        planKey: null,
        idempotencyKey: `subject-${randomUUID()}`,
        locale: 'EN',
        expiresAt: null,
      }),
    );
    const prompt = calls.prompts[0] ?? '';
    expect(prompt).toContain('THE CUSTOMER IS LOOKING AT ONE CAMPAIGN');
    // The customer-written name is NOT in the unfenced instruction.
    expect(prompt).not.toContain('October Awareness');
    const fenced = calls.contexts.find((block) => block.includes('CURRENT SUBJECT'));
    expect(fenced).toContain('October Awareness');
  });

  it('a subject deleted since the session opened is simply absent', async () => {
    const auth = await authorization();
    const session = await inA((db) =>
      orchestrator(db).openSession({
        authorization: auth,
        brandId: fixtures.a.brandId,
        surface: 'content',
        locale: 'EN',
        expiresAt: null,
        subject: { type: 'CONTENT_ITEM', id: itemA },
      }),
    );
    await platform.contentItem.update({ where: { id: itemA }, data: { deletedAt: new Date() } });

    const calls: Calls = { contexts: [], prompts: [] };
    await inA((db) =>
      orchestrator(db, calls).turn({
        sessionId: session.id,
        request: 'Shorten it',
        authorization: auth,
        planKey: null,
        idempotencyKey: `subject-${randomUUID()}`,
        locale: 'EN',
        expiresAt: null,
      }),
    );
    expect(calls.prompts[0]).not.toContain('LOOKING AT ONE');
    expect(calls.contexts.some((block) => block.includes('CURRENT SUBJECT'))).toBe(false);
  });
});
