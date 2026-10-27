import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aiAvailableFor,
  assessPlatformBudget,
  customerMessageFor,
  platformPeriodStarts,
  platformThresholdsReached,
  PlatformAiPausedError,
  type AiConfiguration,
  type PlatformBudgetLimits,
} from '@brandspace/ai-gateway';
import { renderEmail } from '@brandspace/auth';
import { validateConfiguration } from '@brandspace/config';
import { findIntegration } from '@brandspace/integrations';
import { applyProviderRecord } from '../../packages/integrations/src/mapping';
import { sanitizeAttributes } from '@brandspace/observability';
import {
  FORMAL_ARABIC_INSTRUCTION,
  answerLanguageInstruction,
  languageInstruction,
  redact,
  toPublicErrorCode,
} from '@brandspace/shared';
import { draftIdeasPrompt } from '@brandspace/automation';
import { withAiKeyRotation } from '../../apps/admin/src/server/owner-readiness';
import { statusMessage } from '../../apps/dashboard/src/i18n/messages';

/**
 * D-573 — the platform's own AI provider: the rules that need no database.
 * The money path, fallback and the concurrent ceiling run against PostgreSQL
 * in `tests/isolation/d573-ai-provider.test.ts`.
 */

const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

describe('D-573 · the platform ceiling sum and decision', () => {
  const limits: PlatformBudgetLimits = {
    providerCostPerDayMicroMinor: 1_000,
    providerCostPerMonthMicroMinor: 10_000,
    currency: 'USD',
  };

  it('admits up to the ceiling and refuses past it, day before month', () => {
    const spend = { todayMicroMinor: 900n, thisMonthMicroMinor: 5_000n };
    expect(assessPlatformBudget(limits, spend, 100n)).toEqual({ allowed: true, breached: null });
    expect(assessPlatformBudget(limits, spend, 101n)).toEqual({ allowed: false, breached: 'day' });
    expect(
      assessPlatformBudget(limits, { todayMicroMinor: 0n, thisMonthMicroMinor: 9_950n }, 100n),
    ).toEqual({ allowed: false, breached: 'month' });
  });

  it('no ceiling never refuses', () => {
    const open = {
      ...limits,
      providerCostPerDayMicroMinor: null,
      providerCostPerMonthMicroMinor: null,
    };
    expect(
      assessPlatformBudget(
        open,
        { todayMicroMinor: 10n ** 15n, thisMonthMicroMinor: 10n ** 15n },
        10n ** 12n,
      ).allowed,
    ).toBe(true);
  });

  it('reports 80% and 100% per period, and a refusal as 100%', () => {
    const starts = platformPeriodStarts(new Date('2026-10-27T15:00:00Z'));
    expect(starts.day.toISOString()).toBe('2026-10-27T00:00:00.000Z');
    expect(starts.month.toISOString()).toBe('2026-10-01T00:00:00.000Z');

    const at79 = platformThresholdsReached(
      limits,
      { todayMicroMinor: 790n, thisMonthMicroMinor: 0n },
      starts,
    );
    expect(at79).toEqual([]);
    const at80 = platformThresholdsReached(
      limits,
      { todayMicroMinor: 800n, thisMonthMicroMinor: 0n },
      starts,
    );
    expect(at80.map((c) => `${c.period}:${c.thresholdPercent}`)).toEqual(['day:80']);
    const full = platformThresholdsReached(
      limits,
      { todayMicroMinor: 1_000n, thisMonthMicroMinor: 8_000n },
      starts,
    );
    expect(full.map((c) => `${c.period}:${c.thresholdPercent}`)).toEqual([
      'day:80',
      'day:100',
      'month:80',
    ]);
    const refused = platformThresholdsReached(
      limits,
      { todayMicroMinor: 950n, thisMonthMicroMinor: 0n },
      starts,
      'day',
    );
    expect(refused.map((c) => `${c.period}:${c.thresholdPercent}`)).toEqual(['day:80', 'day:100']);
  });

  it('the customer sees the owner’s words, as AI_PAUSED, in en and ar', () => {
    const error = new PlatformAiPausedError('day');
    expect(error.code).toBe('AI_PAUSED');
    expect(error.httpStatus).toBe(503);
    expect(toPublicErrorCode(error)).toBe('AI_PAUSED');
    expect(statusMessage('AI_PAUSED', 'en')).toBe(
      'AI is paused right now. Please try again later.',
    );
    expect(statusMessage('AI_PAUSED', 'ar')).toBe(
      'الذكاء الاصطناعي متوقف مؤقتًا. حاول مرة أخرى لاحقًا.',
    );
  });
});

describe('D-573 · configuration validation', () => {
  const provider = (baseUrl: string) => ({
    key: 'openai',
    adapter: 'openai',
    name: 'OpenAI',
    baseUrl,
    apiKeySecretRef: 'integration/ai/openai/staging/apiKey',
    status: 'draft',
    timeoutMs: 30_000,
    maxConcurrency: 8,
    noTrainingGuarantee: false,
    dataRetentionPolicy: 'unverified',
  });

  it.each([
    'http://api.openai.com/v1',
    'https://169.254.169.254/v1',
    'https://localhost/v1',
    'https://api.openai.com:8443/v1',
    'https://user:pw@api.openai.com/v1',
  ])('refuses a provider at %s', (baseUrl) => {
    const report = validateConfiguration('ai.providers', { providers: [provider(baseUrl)] });
    expect(report.valid).toBe(false);
  });

  it('accepts a provider at its official https address', () => {
    const report = validateConfiguration('ai.providers', {
      providers: [provider('https://api.openai.com/v1')],
    });
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('refuses an allow-list entry that is an address or a private name', () => {
    for (const host of ['10.0.0.1', 'localhost', 'metadata.google.internal']) {
      const report = validateConfiguration('ai.providers', { providers: [], allowedHosts: [host] });
      expect(report.valid, host).toBe(false);
    }
  });

  const model = (costCurrency: string) => ({
    key: 'text-model-x',
    providerKey: 'openai',
    displayName: 'Text',
    modality: 'text',
    qualityTier: 'balanced',
    status: 'beta',
    disableSwitch: false,
    inputCostPerUnitMicroMinor: 1,
    outputCostPerUnitMicroMinor: 1,
    costUnit: '1k_tokens',
    costCurrency,
    qualityBenchmarkRef: null,
  });

  it('refuses a model priced in another currency than the platform ceiling (no conversion)', () => {
    const budgets = { platform: { currency: 'USD' } };
    expect(
      validateConfiguration('ai.models', { models: [model('EUR')] }, { 'ai.budgets': budgets })
        .valid,
    ).toBe(false);
    expect(
      validateConfiguration('ai.models', { models: [model('USD')] }, { 'ai.budgets': budgets })
        .valid,
    ).toBe(true);
    expect(
      validateConfiguration(
        'ai.budgets',
        { platform: { currency: 'SAR' } },
        { 'ai.models': { models: [model('USD')] } },
      ).valid,
    ).toBe(false);
  });

  it('refuses a daily platform ceiling above the monthly one', () => {
    const report = validateConfiguration('ai.budgets', {
      platform: { providerCostPerDayMicroMinor: 20, providerCostPerMonthMicroMinor: 10 },
    });
    expect(report.valid).toBe(false);
  });

  it('a beta model needs no benchmark, so it is routable on staging (D-17)', () => {
    const report = validateConfiguration('ai.models', { models: [model('USD')] });
    expect(report.valid).toBe(true);
  });
});

describe('D-573 · the Control Center saves only an allowed host, and names the adapter', () => {
  const definition = findIntegration('ai', 'openai');

  it('the catalogue entry exists, is real, and starts from the official address', () => {
    expect(definition?.developmentOnly).toBe(false);
    expect(definition?.defaultSettings?.['baseUrl']).toBe('https://api.openai.com/v1');
  });

  it('records the adapter on a new provider', () => {
    const next = applyProviderRecord({
      definition: definition!,
      domain: 'ai.providers',
      document: { providers: [] },
      settings: { baseUrl: 'https://api.openai.com/v1' },
      secretRefs: { apiKey: 'integration/ai/openai/staging/apiKey' },
    });
    const saved = (next['providers'] as Record<string, unknown>[])[0];
    expect(saved?.['adapter']).toBe('openai');
    expect(saved?.['status']).toBe('draft');
    // Only the reference: never a value.
    expect(saved?.['apiKeySecretRef']).toBe('integration/ai/openai/staging/apiKey');
  });

  it('refuses another host unless the owner allowed it', () => {
    const write = (allowedHosts: string[]) =>
      applyProviderRecord({
        definition: definition!,
        domain: 'ai.providers',
        document: { providers: [], allowedHosts },
        settings: { baseUrl: 'https://proxy.example.com/v1' },
        secretRefs: {},
      });
    expect(() => write([])).toThrow(/allow-list/);
    expect(() => write(['proxy.example.com'])).not.toThrow();
    expect(() =>
      applyProviderRecord({
        definition: definition!,
        domain: 'ai.providers',
        document: { providers: [] },
        settings: { baseUrl: 'http://api.openai.com/v1' },
        secretRefs: {},
      }),
    ).toThrow(/https/);
  });
});

describe('D-573 · availability turns on when a real provider is active', () => {
  const configuration = (status: 'active' | 'validated'): AiConfiguration => ({
    providers: [
      {
        key: 'openai',
        adapterKey: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKeySecretRef: 'ref',
        status,
        timeoutMs: 30_000,
      },
    ],
    models: [
      {
        key: 'text-model-x',
        providerKey: 'openai',
        modality: 'text',
        qualityTier: 'balanced',
        status: 'beta',
        disableSwitch: false,
      },
    ],
    costBases: [],
    routingRules: [
      {
        taskKey: 'caption.generate',
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: 'text-model-x',
        fallbackModelKeys: [],
        timeoutMs: 30_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.7,
          maxOutputTokens: 400,
          promptTemplateVersion: 1,
          persistOutput: false,
          outputRetentionDays: null,
        },
        retryPolicy: { maxAttempts: 1, backoff: 'none', initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      },
    ],
    creditRules: [],
    budgets: {
      defaults: {
        creditsPerDayMilli: null,
        creditsPerMonthMilli: null,
        maxConcurrentRequests: null,
      },
      perPlan: [],
    },
  });
  const adapters = (production: boolean) => ({
    registered: new Set(production ? ['openai'] : ['openai', 'mock']),
    production,
    developmentOnly: new Set(['mock']),
  });
  const query = { workspaceId: '00000000-0000-4000-8000-000000000001', planKey: null };

  it('on in production and staging once active; off while only validated', () => {
    expect(aiAvailableFor('caption.generate', query, configuration('active'), adapters(true))).toBe(
      true,
    );
    expect(
      aiAvailableFor('caption.generate', query, configuration('active'), adapters(false)),
    ).toBe(true);
    expect(
      aiAvailableFor('caption.generate', query, configuration('validated'), adapters(false)),
    ).toBe(false);
  });

  it('a record pointing at the development double is never available in production', () => {
    const base = configuration('active');
    const viaMock: AiConfiguration = {
      ...base,
      providers: base.providers.map((p) => ({ ...p, adapterKey: 'mock' })),
    };
    expect(aiAvailableFor('caption.generate', query, viaMock, adapters(true))).toBe(false);
  });
});

describe('D-573 · formal Arabic on every text task (D-474)', () => {
  it('one instruction, formal, no dialect, Latin digits', () => {
    expect(FORMAL_ARABIC_INSTRUCTION).toMatch(/Modern Standard Arabic/);
    expect(FORMAL_ARABIC_INSTRUCTION).toMatch(/no dialect/);
    expect(FORMAL_ARABIC_INSTRUCTION).toMatch(/0-9/);
    expect(languageInstruction('AR')).toContain(FORMAL_ARABIC_INSTRUCTION);
    expect(languageInstruction('ar')).toContain(FORMAL_ARABIC_INSTRUCTION);
    expect(languageInstruction('EN')).not.toContain('Arabic');
  });

  it('a conversation answers in the reader’s language, falling back to the brand’s, never fixed to English', () => {
    const arabicBrand = answerLanguageInstruction('AR');
    expect(arabicBrand).toMatch(/language the customer wrote/);
    expect(arabicBrand).toMatch(/answer in Arabic\./);
    expect(arabicBrand).toContain(FORMAL_ARABIC_INSTRUCTION);
    expect(answerLanguageInstruction('EN')).toMatch(/answer in English\./);
  });

  it('the automation’s draft ideas ask for formal Arabic for an Arabic brand', () => {
    const prompt = draftIdeasPrompt({ trigger: 'SCHEDULE_GAP', locale: 'AR' });
    expect(prompt).toContain(FORMAL_ARABIC_INSTRUCTION);
    expect(draftIdeasPrompt({ trigger: 'SCHEDULE_GAP', locale: 'EN' })).not.toContain(
      FORMAL_ARABIC_INSTRUCTION,
    );
  });

  it.each([
    ['packages/content/src/studio.ts', 'languageInstruction('],
    ['packages/brand-brain/src/chat.ts', 'answerLanguageInstruction('],
    ['packages/copilot/src/orchestrator.ts', 'FORMAL_ARABIC_INSTRUCTION'],
    ['packages/analytics/src/insights.ts', 'FORMAL_ARABIC_INSTRUCTION'],
    ['packages/intelligence/src/strategy.ts', 'FORMAL_ARABIC_INSTRUCTION'],
    ['packages/automation/src/draft-ideas.ts', 'FORMAL_ARABIC_INSTRUCTION'],
  ])('%s asks in the shared words', (file, needle) => {
    expect(read(file)).toContain(needle);
  });

  it('no prompt names an Arabic dialect any more', () => {
    for (const file of [
      'packages/content/src/studio.ts',
      'packages/brand-brain/src/chat.ts',
      'packages/copilot/src/orchestrator.ts',
    ]) {
      expect(read(file), file).not.toMatch(/`Arabic dialect:/);
    }
  });

  it('the Copilot route no longer pins the turn to English', () => {
    expect(read('apps/api/src/routes/copilot.ts')).not.toMatch(/locale: 'EN',\s*\n\s*expiresAt/);
  });
});

describe('D-573 · readiness and the secret rotation', () => {
  const ready = {
    state: 'ready' as const,
    reason: 'ok' as const,
    provider: { en: 'OpenAI', ar: 'OpenAI' },
  };

  it('before the rotation is recorded: reissue the key afterwards, and leave the KEK alone', () => {
    const area = withAiKeyRotation(ready, {
      rotationCompletedAt: null,
      realKeysSetAt: [new Date('2026-10-26T10:00:00Z')],
    });
    expect(area.state).toBe('ready');
    expect(area.notes).toEqual(['ai_reissue_after_rotation', 'kek_rewrap_first']);
  });

  it('the KEK warning stands even before any AI key is saved', () => {
    expect(
      withAiKeyRotation(ready, { rotationCompletedAt: null, realKeysSetAt: [] }).notes,
    ).toEqual(['kek_rewrap_first']);
  });

  it('a key saved before the recorded rotation needs attention; one saved after does not', () => {
    const before = withAiKeyRotation(ready, {
      rotationCompletedAt: '2026-10-28',
      realKeysSetAt: [new Date('2026-10-26T10:00:00Z')],
    });
    expect(before.state).toBe('needs_attention');
    expect(before.reason).toBe('ai_key_before_rotation');
    const after = withAiKeyRotation(ready, {
      rotationCompletedAt: '2026-10-28',
      realKeysSetAt: [new Date('2026-10-29T10:00:00Z')],
    });
    expect(after).toEqual(ready);
  });

  it('the Control Center says the KEK sentence verbatim, in en and ar', () => {
    const copy = read('apps/admin/src/i18n/simple.ts');
    expect(copy).toContain(
      "'note.kek_rewrap_first': 'Do not change SECRET_VAULT_KEK until the re-wrap command exists.'",
    );
    expect(copy).toContain(
      "'note.kek_rewrap_first': 'لا تغيّر SECRET_VAULT_KEK قبل أن يتوفر أمر إعادة التغليف.'",
    );
  });
});

describe('D-573 · no app names a vendor or branches on a provider key', () => {
  const APP_DIRS = ['apps/api/src', 'apps/admin/src', 'apps/dashboard/src', 'apps/web/src'];

  it('no app source names the first provider', () => {
    for (const dir of APP_DIRS) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        expect(readFileSync(file, 'utf8').toLowerCase(), file).not.toContain('openai');
      }
    }
  });

  it('the Control Center tester has one AI path and no development-double case', () => {
    const tester = read('apps/admin/src/server/integration-tester.ts');
    expect(tester).not.toContain("'ai:mock'");
    expect(tester).not.toContain('MockProviderAdapter');
    expect(tester).toContain("input.category === 'ai'");
  });

  it('no API route builds its own gateway or its own adapter map', () => {
    for (const file of sourceFiles(join(ROOT, 'apps/api/src'))) {
      const text = readFileSync(file, 'utf8');
      if (file.endsWith('ai-gateway-factory.ts')) continue;
      expect(text, file).not.toMatch(/new AiGateway\(/);
      expect(text, file).not.toMatch(/new MockProviderAdapter\(/);
      expect(text, file).not.toMatch(/credentials: \{ resolve: async \(\) => null \}/);
    }
  });
});

describe('D-573 · provider cost never reaches a customer', () => {
  it('no customer-facing source reads a provider cost', () => {
    const dirs = [
      'apps/api/src',
      'apps/dashboard/src',
      'packages/content/src',
      'packages/brand-brain/src',
      'packages/copilot/src',
      'packages/analytics/src',
      'packages/intelligence/src',
      'packages/creative/src',
      'packages/automation/src',
    ];
    for (const dir of dirs) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const text = readFileSync(file, 'utf8');
        expect(text, file).not.toMatch(/providerCost/);
      }
    }
  });
});

describe('D-573 · the credential is never in a log, a span, an error or a message', () => {
  const KEY = 'sk-proj-d573LeakCanary000000000000000000';
  const GOOGLE = 'AIzaSyD573LeakCanary0000000000000000000';

  it('the redaction layer removes both key shapes and both header names', () => {
    const scrubbed = JSON.stringify(
      redact({
        headers: { authorization: `Bearer ${KEY}`, 'x-api-key': 'plain-value', 'api-key': 'v' },
        message: `failed with ${KEY} and ${GOOGLE}`,
      }),
    );
    expect(scrubbed).not.toContain(KEY);
    expect(scrubbed).not.toContain(GOOGLE);
    expect(scrubbed).not.toContain('plain-value');
    expect(String(redact(`key=${GOOGLE}`))).not.toContain(GOOGLE);
  });

  it('span attributes are sanitized the same way', () => {
    const attributes = sanitizeAttributes({
      'http.request.header.authorization': `Bearer ${KEY}`,
      'error.message': `provider said ${KEY}`,
    });
    expect(JSON.stringify(attributes)).not.toContain(KEY);
  });

  it('no customer message for any failure class carries a key, host or vendor', () => {
    for (const failureClass of [
      'AUTH_ERROR',
      'QUOTA_EXCEEDED',
      'RATE_LIMITED',
      'MODEL_UNAVAILABLE',
      'PROVIDER_UNAVAILABLE',
      'TIMEOUT',
    ] as const) {
      const message = customerMessageFor(failureClass);
      expect(message).not.toMatch(/sk-|https?:|openai/i);
    }
  });
});

describe('D-573 · the owner’s alert email', () => {
  it('renders in both languages with no figure and no link', () => {
    for (const locale of ['EN', 'AR'] as const) {
      const rendered = renderEmail({
        to: 'owner@example.test',
        templateKey: 'platform.ai_spend_alert',
        locale,
      });
      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.text).toMatch(/80%/);
      expect(rendered.text).not.toMatch(/https?:\/\//);
    }
  });
});

describe('D-573 · maxConcurrency is documented as not enforced', () => {
  it('the docs say so where the setting is described', () => {
    expect(read('docs/AI-GATEWAY.md')).toMatch(/maxConcurrency[^\n]*not enforced/i);
    expect(read('docs/CONTROL-CENTER-SETTINGS.md')).toMatch(/maxConcurrency[^\n]*not enforced/i);
  });
});
