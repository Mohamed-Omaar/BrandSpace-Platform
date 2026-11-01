import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAiAdapter } from '@brandspace/ai-gateway/adapters';
import { pinnedHttpsTransport, pinnedLookup } from '@brandspace/ai-gateway/egress';
import {
  operatorFailureDetail,
  operatorFailureReason,
  type AdapterContext,
} from '@brandspace/ai-gateway';
import {
  hashtagsIntoFirstComment,
  normaliseHashtags,
  parseGeneratedContent,
} from '@brandspace/content';
import { describeArguments, findTool } from '@brandspace/copilot';

/**
 * PR A — unit half. CI never calls a real provider: the OpenAI adapter talks to
 * a local fake server, exactly as `d573-provider-adapter.test.ts` does.
 */

type Reply = { status: number; body: unknown };
let server: Server;
let port = 0;
let script: Reply[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      const next = script.shift() ?? { status: 200, body: {} };
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  script = [];
});

const toLocal = (
  _host: string,
  callback: (e: null, a: { address: string; family: number }[]) => void,
) => callback(null, [{ address: '127.0.0.1', family: 4 }]);

const adapter = new OpenAiAdapter({
  transportFor: (allowedHosts) =>
    pinnedHttpsTransport(
      allowedHosts,
      pinnedLookup(toLocal, (a) => a === '127.0.0.1'),
      { request: httpRequest, port },
    ),
});

// Assembled at runtime so the source holds no key-shaped literal (CI secret scan).
const FAKE_KEY = ['sk', 'test', 'pra-fake-key-00000000000000000'].join('-');

function ctx(): AdapterContext {
  return {
    environment: 'STAGING',
    apiKey: FAKE_KEY,
    baseUrl: 'https://api.openai.com/v1',
    timeoutMs: 5_000,
    signal: AbortSignal.timeout(5_000),
    requestId: 'req-pra',
  };
}

const text = (content: string, finish: string) => ({
  model: 'text-model-x',
  choices: [{ message: { content }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 800 },
});

async function classified(run: () => Promise<unknown>): Promise<{ cls: string; error: unknown }> {
  try {
    await run();
  } catch (error) {
    return { cls: adapter.classifyError(error), error };
  }
  throw new Error('expected the adapter to throw');
}

const textRequest = {
  modelKey: 'text-model-x',
  prompt: 'Write three captions.',
  maxOutputTokens: 800,
  outputFormat: 'json' as const,
};

describe('M-12 — a truncated or empty answer is a failure, not a result', () => {
  it('finish_reason "length" is OUTPUT_TRUNCATED', async () => {
    script = [{ status: 200, body: text('{"title":"Launch","variants":[{"platfo', 'length') }];
    const { cls, error } = await classified(() => adapter.generateText(textRequest, ctx()));
    expect(cls).toBe('OUTPUT_TRUNCATED');
    expect((error as { providerCode?: string }).providerCode).toBe('finish_length');
  });

  it('empty content is OUTPUT_TRUNCATED', async () => {
    script = [{ status: 200, body: text('   ', 'stop') }];
    const { cls } = await classified(() => adapter.generateText(textRequest, ctx()));
    expect(cls).toBe('OUTPUT_TRUNCATED');
  });

  it('a complete answer still succeeds', async () => {
    script = [{ status: 200, body: text('{"title":"t","variants":[]}', 'stop') }];
    const result = await adapter.generateText(textRequest, ctx());
    expect(result.text).toBe('{"title":"t","variants":[]}');
  });
});

describe('item 6 — the provider error code and reason reach the operator detail', () => {
  it('an HTTP error carries the provider code and its short message', async () => {
    script = [
      {
        status: 400,
        body: {
          error: {
            type: 'invalid_request_error',
            code: 'invalid_value',
            message: "Invalid value: '1080x1350'. Supported values are: '1024x1024', '1024x1536'.",
          },
        },
      },
    ];
    const { cls, error } = await classified(() =>
      adapter.generateImage(
        { modelKey: 'image-model-x', prompt: 'A cup', count: 1, size: '1080x1350' },
        ctx(),
      ),
    );
    expect(cls).toBe('INVALID_REQUEST');
    const detail = operatorFailureDetail(error);
    expect(detail.code).toBe('invalid_value');
    expect(detail.reason).toContain("Supported values are: '1024x1024'");
  });
});

describe('(b) failureReason passes through the shared redaction, capped, prompt-free', () => {
  it('redacts a key-shaped value', () => {
    const reason = operatorFailureReason(`Incorrect API key provided: ${FAKE_KEY}.`);
    expect(reason).not.toContain(FAKE_KEY);
    expect(reason).toContain('[REDACTED]');
  });

  it('redacts a credentialed URL', () => {
    const url = ['postgres://user', 'hunter2-pass@db.internal/x'].join(':');
    expect(operatorFailureReason(`upstream ${url} refused`)).not.toContain('hunter2');
  });

  it('caps at 200 characters', () => {
    expect((operatorFailureReason('x'.repeat(500)) ?? '').length).toBeLessThanOrEqual(200);
  });

  it('withholds a reason that quotes the prompt', () => {
    const prompt = 'Write about our secret autumn launch at the Riyadh boulevard store';
    const reason = operatorFailureReason(`Rejected input: "${prompt.slice(10, 50)}"`, {
      kind: 'text',
      prompt,
    });
    expect(reason).not.toContain('autumn launch');
    expect(reason).toMatch(/withheld/);
  });

  it('drops a code that does not match the column CHECK', () => {
    expect(operatorFailureDetail({ providerCode: 'bad code with spaces' }).code).toBeNull();
    expect(operatorFailureDetail({ providerCode: 'rate_limit_exceeded' }).code).toBe(
      'rate_limit_exceeded',
    );
  });
});

describe('item 7 — "##" hashtags: normalised once, on store', () => {
  it('the parser stores tags without their mark', () => {
    const parsed = parseGeneratedContent(
      JSON.stringify({
        title: 'Launch',
        variants: [
          {
            platformKey: 'instagram',
            body: 'Hello',
            hashtags: ['#coffee', '##Riyadh', 'cardamom'],
          },
        ],
      }),
      { platformKeys: ['instagram'], maxVariants: 1 },
    );
    expect(parsed.variants[0]?.hashtags).toEqual(['coffee', 'Riyadh', 'cardamom']);
  });

  it('"#a" and "a" are one tag', () => {
    expect(normaliseHashtags(['#Launch', 'launch', ' #news '])).toEqual(['Launch', 'news']);
  });

  it('a first comment built from tags carries exactly one mark per tag', () => {
    const moved = hashtagsIntoFirstComment(
      { hashtags: ['#coffee', 'tea'], firstComment: null },
      { allowsFirstComment: true },
    );
    expect(moved.firstComment).toBe('#coffee #tea');
    expect(moved.firstComment).not.toContain('##');
  });
});

describe('KNOWN bug — the Copilot prompt states each tool’s arguments', () => {
  it('describes required and optional arguments from the tool’s own schema', () => {
    const tool = findTool('content.draft');
    if (!tool) throw new Error('content.draft is not registered');
    expect(describeArguments(tool.input)).toBe(
      '{brandId: uuid, brief: string, platformKeys: string[], locale?: "AR"|"EN", campaignId?: uuid}',
    );
  });
});
