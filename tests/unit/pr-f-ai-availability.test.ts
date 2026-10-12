import { describe, expect, it } from 'vitest';

import {
  AI_NOT_AVAILABLE_MESSAGE,
  AI_TASKS,
  aiAvailability,
  aiAvailableFor,
  type AiConfiguration,
  type RegisteredModel,
  type RoutingRule,
} from '@brandspace/ai-gateway';

/**
 * PR F (b), Q9, D-507 — IS AI AVAILABLE FOR THIS TASK, FOR THIS WORKSPACE?
 *
 * The answer the gateway would reach without running anything: a route
 * resolves, and a model in its chain belongs to an ACTIVE provider with an
 * adapter registered here — and in production, never a development double.
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222';
const query = { workspaceId: WORKSPACE, planKey: 'starter' };

function rule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    taskKey: 'caption.generate',
    scope: 'global',
    planKey: null,
    workspaceId: null,
    primaryModelKey: 'text-a',
    fallbackModelKeys: [],
    timeoutMs: 20_000,
    maxCostPerRequestMinor: null,
    priority: 0,
    parameters: {
      temperature: 0.7,
      maxOutputTokens: 800,
      promptTemplateVersion: 1,
      persistOutput: false,
      outputRetentionDays: null,
    },
    retryPolicy: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 250, jitter: true },
    moderateInput: false,
    moderationModelKey: null,
    ...overrides,
  };
}

function model(overrides: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    key: 'text-a',
    providerKey: 'real',
    modality: 'text',
    qualityTier: 'balanced',
    status: 'available',
    disableSwitch: false,
    ...overrides,
  };
}

type Config = Pick<AiConfiguration, 'providers' | 'models' | 'routingRules' | 'capabilityRouting'>;

function config(overrides: Partial<Config> = {}): Config {
  return {
    providers: [
      {
        key: 'real',
        baseUrl: 'https://ai.example',
        apiKeySecretRef: 'ref',
        status: 'active',
        timeoutMs: 1,
      },
    ],
    models: [model()],
    routingRules: [rule()],
    ...overrides,
  };
}

const adapters = (
  registered: readonly string[] = ['real'],
  production = false,
  developmentOnly: readonly string[] = ['mock'],
) => ({ registered: new Set(registered), production, developmentOnly: new Set(developmentOnly) });

describe('aiAvailableFor', () => {
  it('true when a route resolves to an active provider with an adapter here', () => {
    expect(aiAvailableFor('caption.generate', query, config(), adapters())).toBe(true);
  });

  it('false with no routing rule for the task (nothing configured)', () => {
    expect(
      aiAvailableFor('caption.generate', query, config({ routingRules: [] }), adapters()),
    ).toBe(false);
    expect(aiAvailableFor('image.generate', query, config(), adapters())).toBe(false);
  });

  it('false for a task the platform does not have', () => {
    expect(aiAvailableFor('no.such.task', query, config(), adapters())).toBe(false);
  });

  it('false while the provider is not active', () => {
    for (const status of ['draft', 'validated', 'disabled'] as const) {
      const off = config({
        providers: [
          {
            key: 'real',
            baseUrl: 'https://ai.example',
            apiKeySecretRef: 'ref',
            status,
            timeoutMs: 1,
          },
        ],
      });
      expect(aiAvailableFor('caption.generate', query, off, adapters()), status).toBe(false);
    }
  });

  it('false when no adapter for the provider is registered in this process', () => {
    expect(aiAvailableFor('caption.generate', query, config(), adapters([]))).toBe(false);
  });

  it('false when the model is switched off', () => {
    expect(
      aiAvailableFor(
        'caption.generate',
        query,
        config({ models: [model({ disableSwitch: true })] }),
        adapters(),
      ),
    ).toBe(false);
  });

  it('a development double NEVER counts in production, even if registered and active', () => {
    const mock = config({
      providers: [
        { key: 'mock', baseUrl: 'mock://', apiKeySecretRef: null, status: 'active', timeoutMs: 1 },
      ],
      models: [model({ providerKey: 'mock' })],
    });
    expect(aiAvailableFor('caption.generate', query, mock, adapters(['mock'], false))).toBe(true);
    expect(aiAvailableFor('caption.generate', query, mock, adapters(['mock'], true))).toBe(false);
  });

  it('a usable fallback in the chain is enough', () => {
    const chain = config({
      models: [model({ key: 'text-a', providerKey: 'gone' }), model({ key: 'text-b' })],
      routingRules: [rule({ fallbackModelKeys: ['text-b'] })],
    });
    expect(aiAvailableFor('caption.generate', query, chain, adapters())).toBe(true);
  });

  it('answers for the workspace asked about: a rule for another workspace does not count', () => {
    const scoped = config({
      routingRules: [rule({ scope: 'workspace', workspaceId: OTHER_WORKSPACE })],
    });
    expect(aiAvailableFor('caption.generate', query, scoped, adapters())).toBe(false);
    expect(
      aiAvailableFor(
        'caption.generate',
        { ...query, workspaceId: OTHER_WORKSPACE },
        scoped,
        adapters(),
      ),
    ).toBe(true);
  });
});

describe('aiAvailability', () => {
  it('answers every task with true or false, and carries nothing else', () => {
    const answer = aiAvailability(query, config(), adapters());
    expect(Object.keys(answer).sort()).toEqual(AI_TASKS.map((task) => task.key).sort());
    for (const value of Object.values(answer)) expect(typeof value).toBe('boolean');
    expect(answer['caption.generate']).toBe(true);
    expect(answer['image.generate']).toBe(false);
  });
});

describe('the gateway, when nothing can run', () => {
  it('tells the customer AI is not available yet — not that it is busy', () => {
    expect(AI_NOT_AVAILABLE_MESSAGE).toBe('AI isn’t available yet.');
  });
});
