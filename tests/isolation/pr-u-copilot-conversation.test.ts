import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import type { AiGateway, AiGatewayResult } from '@brandspace/ai-gateway';
import {
  CONVERSATION_RULES,
  CopilotOrchestrator,
  REPLY_MAX_CHARS,
  parseCopilotPolicy,
  resolveLiveAuthorization,
  productFactsLines,
  readableSize,
  type LiveAuthorization,
  type ProductFacts,
} from '@brandspace/copilot';
import { TenantBrandBrainPolicySource } from '@brandspace/brand-brain';
import { currentEnvironment } from '@brandspace/shared';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PR U — THE STAGING CONVERSATION, SCRIPTED.
 *
 * The screenshot: "what files can I upload so you understand the brand?",
 * then "the types", "file types", "PDF? yes" — and the same list of file types
 * three times, with Excel and "any file" in it. Three causes, three checks:
 *
 *   1. the model never saw its own earlier answers while Brand Brain was off
 *      (every ASSISTANT turn was dropped), so it could not avoid repeating
 *      them. Now only answers that quoted Brand Brain are left out;
 *   2. it had no list of what the product accepts. Now PRODUCT FACTS come from
 *      the activated `brand-brain` configuration on every turn;
 *   3. it had no rules on how to talk, and wrote both languages every turn.
 *      Now CONVERSATION_RULES, one reply, in the person's language.
 *
 * CI never calls a real provider: a scripted gateway records each prompt and
 * answers from a script, so what is checked is what the model is GIVEN.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let auth: LiveAuthorization;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

interface Script {
  readonly replies: string[];
  readonly prompts: string[];
}

function scriptedGateway(script: Script): AiGateway {
  return {
    async execute(input: { input?: { prompt?: string } }): Promise<AiGatewayResult> {
      script.prompts.push(input.input?.prompt ?? '');
      const reply = script.replies.shift() ?? 'OK.';
      return {
        requestId: randomUUID(),
        status: 'SUCCEEDED',
        modelKey: 'scripted',
        attemptedModelKeys: ['scripted'],
        output: { kind: 'text', text: JSON.stringify({ reply, steps: [] }) },
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

function copilot(
  db: TenantScopedClient,
  script: Script,
  productFacts?: () => Promise<ProductFacts | null>,
) {
  return new CopilotOrchestrator({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: parseCopilotPolicy(defaultPayload('copilot')),
    gateway: scriptedGateway(script),
    ...(productFacts ? { productFacts } : {}),
  });
}

async function freshSession(script: Script): Promise<string> {
  const session = await inA((db) =>
    copilot(db, script).openSession({
      authorization: auth,
      brandId: fixtures.a.brandId,
      surface: 'general',
      locale: 'EN',
      expiresAt: null,
    }),
  );
  // One conversation per person and brand (D-594): start this one clean.
  await inA((db) =>
    db.copilotMessage.deleteMany({
      where: { workspaceId: fixtures.a.workspaceId, sessionId: session.id },
    }),
  );
  return session.id;
}

async function say(
  sessionId: string,
  script: Script,
  request: string,
  productFacts?: () => Promise<ProductFacts | null>,
) {
  return inA((db) =>
    copilot(db, script, productFacts).turn({
      sessionId,
      request,
      authorization: auth,
      planKey: null,
      idempotencyKey: `pr-u-${randomUUID()}`,
      locale: 'EN',
      expiresAt: null,
    }),
  );
}

const setBrandBrain = (on: boolean) =>
  inA((db) => db.brand.update({ where: { id: fixtures.a.brandId }, data: { useBrandBrain: on } }));

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  const resolved = await inA((db) =>
    resolveLiveAuthorization(db, fixtures.a.workspaceId, fixtures.a.userId),
  );
  if (!resolved) throw new Error('the fixture membership is missing');
  auth = resolved;
}, 60_000);

afterAll(async () => {
  await setBrandBrain(true).catch(() => undefined);
  await app?.$disconnect();
});

const LIST_REPLY =
  'يمكنك رفع ملفات PDF وWord وPowerPoint والنصوص وCSV وMarkdown. أرسل الملف وسأقترح الحقائق.';

describe('PR U · the staging conversation, with Brand Brain off', () => {
  it('every turn sees the earlier answers, the rules, the real file types and Arabic', async () => {
    await setBrandBrain(false);
    const script: Script = {
      replies: [
        LIST_REPLY,
        'هل تقصد أنواع الملفات؟',
        'نعم، الأنواع المذكورة أعلاه.',
        'نعم، PDF مقبول.',
      ],
      prompts: [],
    };
    const sessionId = await freshSession(script);
    const turns = [
      'ايه نوع الملفات اللى اقدر ارفعهالك هنا عشان تفهم البراند',
      'الانواع',
      'انواع الملفات',
      'و لا اية Pdf ايوه يعنى',
    ];
    for (const request of turns) await say(sessionId, script, request);

    /*
     * The real list: whatever this database's activated `brand-brain`
     * configuration says (the defaults on a fresh database; another suite may
     * have activated a narrower one), read the way the Copilot reads it.
     */
    const policy = await inA((db) =>
      new TenantBrandBrainPolicySource(db, currentEnvironment()).load(),
    );
    const expected = productFactsLines({ upload: policy.ingestion, extraction: policy.extraction });
    expect(expected.join('\n')).toContain('Brand Brain reads ONLY these file types:');

    expect(script.prompts).toHaveLength(4);
    for (const prompt of script.prompts) {
      expect(prompt).toContain(CONVERSATION_RULES);
      expect(prompt).toContain('REPLY LANGUAGE: Arabic.');
      expect(prompt).toContain(expected.join('\n'));
      expect(prompt).not.toMatch(/Excel|\.xlsx/);
      // One reply, never the two-language summary.
      expect(prompt).toContain('{"reply":string,');
      expect(prompt).not.toContain('"summary":{"ar"');
    }

    // The fourth turn sees the three earlier answers (Brand Brain is off, and
    // none of them quoted it) and the three earlier questions.
    const last = script.prompts[3] ?? '';
    expect(last).toContain(LIST_REPLY);
    expect(last).toContain('هل تقصد أنواع الملفات؟');
    expect(last).toContain('نعم، الأنواع المذكورة أعلاه.');
    expect(last).toContain('الانواع');
    // The rule that stops the third copy of the list.
    expect(last).toContain('Never repeat what you already said in this conversation.');
  });

  it('answers that quoted Brand Brain stay out while it is off; ungrounded ones stay in', async () => {
    await setBrandBrain(false);
    const script: Script = { replies: [], prompts: [] };
    const sessionId = await freshSession(script);
    const base = {
      workspaceId: fixtures.a.workspaceId,
      sessionId,
      kind: 'message',
      status: 'complete',
    };
    const at = (seconds: number) => new Date(Date.now() - 60_000 + seconds * 1000);
    await inA((db) =>
      db.copilotMessage.createMany({
        data: [
          {
            ...base,
            role: 'USER',
            body: 'What is our tone?',
            correlationId: randomUUID(),
            createdAt: at(1),
          },
          {
            ...base,
            role: 'ASSISTANT',
            body: 'GROUNDED: your tone is warm, per Brand Brain.',
            citations: [{ kind: 'knowledge', id: randomUUID(), area: 'VOICE', version: 1 }],
            correlationId: randomUUID(),
            createdAt: at(2),
          },
          {
            ...base,
            role: 'USER',
            body: 'What files can I add?',
            correlationId: randomUUID(),
            createdAt: at(3),
          },
          {
            ...base,
            role: 'ASSISTANT',
            body: 'UNGROUNDED: PDF, Word and text files.',
            citations: [],
            correlationId: randomUUID(),
            createdAt: at(4),
          },
          {
            ...base,
            role: 'ASSISTANT',
            body: 'LEGACY: written before answers recorded their citations.',
            correlationId: randomUUID(),
            createdAt: at(5),
          },
        ],
      }),
    );

    await say(sessionId, script, 'And PowerPoint?');
    const off = script.prompts[0] ?? '';
    expect(off).toContain('UNGROUNDED: PDF, Word and text files.');
    expect(off).not.toContain('GROUNDED: your tone');
    expect(off).not.toContain('LEGACY:');
    // The person's own words are always kept.
    expect(off).toContain('What is our tone?');

    // Switched back on, every answer is context again.
    await setBrandBrain(true);
    await say(sessionId, script, 'And PowerPoint, again?');
    const on = script.prompts[1] ?? '';
    expect(on).toContain('GROUNDED: your tone is warm');
    expect(on).toContain('UNGROUNDED: PDF, Word and text files.');
    expect(on).toContain('LEGACY:');
  });

  it('a new answer records what it was given from Brand Brain: [] when nothing', async () => {
    await setBrandBrain(false);
    const script: Script = { replies: ['Short answer.'], prompts: [] };
    const sessionId = await freshSession(script);
    await say(sessionId, script, 'Which file types do you read?');
    const stored = await inA((db) =>
      db.copilotMessage.findFirstOrThrow({
        where: { workspaceId: fixtures.a.workspaceId, sessionId, role: 'ASSISTANT' },
      }),
    );
    expect(stored.citations).toEqual([]);
    expect(stored.body).toBe('Short answer.');
  });
});

describe('PR U · one reply, in the person’s language, bounded', () => {
  it('stores and returns ONE reply; a one-word follow-up keeps the Arabic', async () => {
    await setBrandBrain(true);
    const script: Script = { replies: ['نعم، يمكنك رفع ملف PDF.', 'نعم.'], prompts: [] };
    const sessionId = await freshSession(script);
    const turn = await say(sessionId, script, 'هل أستطيع رفع ملف PDF؟');
    expect(turn.summary).toEqual({ ar: 'نعم، يمكنك رفع ملف PDF.', en: 'نعم، يمكنك رفع ملف PDF.' });
    await say(sessionId, script, 'PDF?');
    expect(script.prompts[1]).toContain('REPLY LANGUAGE: Arabic.');
  });

  it('English for an English question', async () => {
    const script: Script = { replies: ['Yes.'], prompts: [] };
    const sessionId = await freshSession(script);
    await say(sessionId, script, 'Can I upload a PDF here?');
    expect(script.prompts[0]).toContain('REPLY LANGUAGE: English.');
  });

  it(`a reply longer than ${REPLY_MAX_CHARS} characters is cut at a sentence end, never failed`, async () => {
    const sentence = 'This sentence explains one thing about the brand. ';
    const script: Script = { replies: [sentence.repeat(60)], prompts: [] };
    const sessionId = await freshSession(script);
    const turn = await say(sessionId, script, 'Tell me everything about how you read files');
    expect(turn.summary.en.length).toBeLessThanOrEqual(REPLY_MAX_CHARS);
    expect(turn.summary.en.endsWith('.')).toBe(true);
  });

  it('a reply recorded in the old two-language format is still shown', async () => {
    const script: Script = { replies: [], prompts: [] };
    const sessionId = await freshSession(script);
    const legacy: AiGateway = {
      ...scriptedGateway(script),
      async execute(): Promise<AiGatewayResult> {
        const result = await scriptedGateway(script).execute({} as never);
        return {
          ...result,
          output: {
            kind: 'text',
            text: JSON.stringify({ summary: { ar: 'نعم', en: 'Yes' }, steps: [] }),
          },
        };
      },
    } as unknown as AiGateway;
    const turn = await inA((db) =>
      new CopilotOrchestrator({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: parseCopilotPolicy(defaultPayload('copilot')),
        gateway: legacy,
      }).turn({
        sessionId,
        request: 'هل تقرأ ملفات PDF؟',
        authorization: auth,
        planKey: null,
        idempotencyKey: `pr-u-${randomUUID()}`,
        locale: 'EN',
        expiresAt: null,
      }),
    );
    expect(turn.summary.ar).toBe('نعم');
  });
});

describe('PR U · PRODUCT FACTS follow the configuration', () => {
  it('sizes read as a person reads them, never "0.0 MB"', () => {
    expect(readableSize(20 * 1024 * 1024)).toBe('20 MB');
    expect(readableSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(readableSize(512 * 1024)).toBe('512 KB');
    expect(readableSize(64)).toBe('64 bytes');
  });

  it('a narrower accepted list is what the model is told; an unreadable one says "not sure"', async () => {
    const script: Script = { replies: [], prompts: [] };
    const sessionId = await freshSession(script);
    const onlyPdf = async (): Promise<ProductFacts> => ({
      upload: {
        allowedMimeTypes: ['application/pdf'],
        maxFileBytes: 5 * 1024 * 1024,
        maxDocumentsPerBrand: 9,
      },
      extraction: { maxPages: 40 },
    });
    await say(sessionId, script, 'What can I upload?', onlyPdf);
    expect(script.prompts[0]).toContain(
      'Brand Brain reads ONLY these file types: PDF (.pdf) with selectable text. Every other type is not accepted.',
    );
    expect(script.prompts[0]).toContain(
      'Each file may be up to 5 MB; at most the first 40 pages are read; a brand may hold up to 9 files.',
    );
    expect(script.prompts[0]).not.toContain('Word (.docx)');

    await say(sessionId, script, 'And now?', async () => {
      throw new Error('configuration unavailable');
    });
    expect(script.prompts[1]).toContain('could not be loaded just now');
    expect(script.prompts[1]).not.toContain('reads ONLY these file types');
  });
});
