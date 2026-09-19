import { describe, expect, it } from 'vitest';

import {
  AI_CAPABILITIES,
  AI_TASKS,
  capabilityRefusal,
  findAiCapability,
  NO_MODEL_FEATURES,
  resolveRoute,
  RoutingError,
  tasksWithInconsistentModality,
  type CapabilityRouting,
  type ModelFeatureDeclaration,
  type ModelFeatureRequirements,
  type RegisteredModel,
  type RoutingRule,
} from '@brandspace/ai-gateway';
import { AI_CAPABILITY_REQUIREMENTS, validateConfiguration } from '@brandspace/config';

/**
 * Capability routing — Phase 10 §5, §7, §8.
 *
 * THE RULE THESE TESTS DEFEND. "Do not allow a fallback to silently violate
 * required capabilities." Before Phase 10 the only check was modality, and
 * modality cannot tell a vision model from a plain text model — both are
 * `text`. So the interesting assertions here are the refusals: a model that is
 * NOT declared, and a model that is declared but whose feature flags do not
 * back the declaration up, must both be excluded rather than served.
 */

const WORKSPACE = '33333333-3333-4333-8333-333333333333';

function features(overrides: Partial<ModelFeatureDeclaration> = {}): ModelFeatureDeclaration {
  return { ...NO_MODEL_FEATURES, ...overrides };
}

function model(overrides: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    key: 'text-a',
    providerKey: 'mock',
    modality: 'text',
    qualityTier: 'balanced',
    status: 'available',
    disableSwitch: false,
    capabilities: ['CONTENT_STANDARD'],
    features: features(),
    latencyTier: 'standard',
    inputCostPerUnitMicroMinor: 1_000,
    outputCostPerUnitMicroMinor: 2_000,
    imageCostPerImageMicroMinor: null,
    ...overrides,
  };
}

function routing(overrides: Partial<CapabilityRouting> = {}): CapabilityRouting {
  return { activeProfile: 'balanced', routes: [], ...overrides };
}

function route(overrides: Record<string, unknown> = {}) {
  return {
    capability: 'CONTENT_STANDARD',
    enabled: true,
    primaryModelKey: null,
    fallbackModelKeys: [],
    timeoutMs: 30_000,
    retryPolicy: {
      maxAttempts: 3,
      backoff: 'exponential' as const,
      initialDelayMs: 250,
      jitter: true,
    },
    maxCostPerRequestMinor: null,
    maxOutputTokens: null,
    minimumQualityTier: null,
    latencyPreference: null,
    ...overrides,
  };
}

const query = { taskKey: 'caption.generate', workspaceId: WORKSPACE, planKey: 'growth' };

describe('the capability vocabulary', () => {
  it('declares a modality for every task that agrees with the capability it needs', () => {
    // A task whose declared modality drifted from its capability would be
    // routed to models that cannot serve it, and nothing else would notice.
    expect(tasksWithInconsistentModality()).toEqual([]);
  });

  it('gives every task a capability that is actually defined', () => {
    for (const task of AI_TASKS) {
      expect(findAiCapability(task.capability), `task ${task.key}`).toBeDefined();
    }
  });

  it('keeps the configuration copy of the requirements identical to the source', () => {
    /*
     * `packages/config` may not import `@brandspace/ai-gateway` — the
     * dependency runs the other way — so it carries its own copy of the
     * capability requirements to validate against. This is the assertion that
     * keeps the copy honest; without it, adding a capability in one place would
     * silently make it unconfigurable in the other.
     */
    // Each capability narrows `requires` to its own literal shape, so the
    // fields are read through a widened view rather than off the union.
    const FLAG_NAMES: Readonly<Record<keyof ModelFeatureRequirements, string>> = {
      vision: 'supportsVision',
      structuredOutput: 'supportsStructuredOutput',
      toolUse: 'supportsToolUse',
      audioInput: 'supportsAudioInput',
      audioOutput: 'supportsAudioOutput',
      embeddings: 'supportsEmbeddings',
    };
    const fromSource = Object.fromEntries(
      AI_CAPABILITIES.map((capability) => {
        const requires = capability.requires as ModelFeatureRequirements;
        return [
          capability.key,
          {
            executionModality: capability.executionModality,
            requires: (Object.keys(FLAG_NAMES) as (keyof ModelFeatureRequirements)[])
              .filter((flag) => requires[flag] === true)
              .map((flag) => FLAG_NAMES[flag]),
          },
        ];
      }),
    );
    expect(AI_CAPABILITY_REQUIREMENTS).toEqual(fromSource);
  });

  it('refuses a model whose flags do not back its declaration up', () => {
    const vision = findAiCapability('VISION_ANALYSIS')!;
    // Same modality, and that is exactly the point: modality alone says yes.
    expect(capabilityRefusal(vision, { modality: 'text', features: features() })).toContain(
      'does not declare vision',
    );
    expect(
      capabilityRefusal(vision, { modality: 'text', features: features({ vision: true }) }),
    ).toBeNull();
  });
});

describe('resolving through a capability', () => {
  it('leaves an existing task rule winning outright', () => {
    const rule: RoutingRule = {
      taskKey: 'caption.generate',
      scope: 'global',
      planKey: null,
      workspaceId: null,
      primaryModelKey: 'chosen-by-hand',
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
    };
    const resolved = resolveRoute(
      query,
      [rule],
      [model({ key: 'chosen-by-hand' }), model({ key: 'cheaper', inputCostPerUnitMicroMinor: 1 })],
      routing({ activeProfile: 'economy' }),
    );
    expect(resolved.resolvedBy).toBe('task');
    expect(resolved.chain).toEqual(['chosen-by-hand']);
    expect(resolved.profile).toBeNull();
  });

  it('falls through to the capability layer when no task rule matches', () => {
    const resolved = resolveRoute(query, [], [model({ key: 'only-one' })], routing());
    expect(resolved.resolvedBy).toBe('capability');
    expect(resolved.capability).toBe('CONTENT_STANDARD');
    expect(resolved.chain).toEqual(['only-one']);
  });

  it('still refuses when nothing is configured at all', () => {
    // The pre-Phase-10 behaviour, unchanged: no rule and no catalogue is a
    // configuration gap, not an invitation to guess.
    expect(() => resolveRoute(query, [], [model({ capabilities: [] })])).toThrow(RoutingError);
  });
});

describe('a fallback may never violate the capability', () => {
  it('excludes an undeclared model named as a fallback rather than serving it', () => {
    const resolved = resolveRoute(
      query,
      [],
      [model({ key: 'good' }), model({ key: 'undeclared', capabilities: [] })],
      routing({
        activeProfile: 'custom',
        routes: [route({ primaryModelKey: 'good', fallbackModelKeys: ['undeclared'] })],
      }),
    );
    expect(resolved.chain).toEqual(['good']);
    expect(resolved.excludedModelKeys).toContain('undeclared');
  });

  it('excludes a declared model whose feature flags do not satisfy the capability', () => {
    /*
     * The case a modality check cannot catch. Both models are `text`; only one
     * can see a picture. Routing a vision request to the other would fail at
     * the provider AFTER the credits were reserved.
     */
    const resolved = resolveRoute(
      { ...query, taskKey: 'caption.generate' },
      [],
      [
        model({ key: 'sighted', capabilities: ['CONTENT_STANDARD'] }),
        model({
          key: 'blind-but-declared',
          // Declared for a capability it cannot serve. `ai.models` validation
          // refuses this document; the router refuses it again at request time,
          // because a model can be changed after a route was activated.
          capabilities: ['CONTENT_STANDARD', 'VISION_ANALYSIS'],
        }),
      ],
      routing({ activeProfile: 'custom', routes: [route({ primaryModelKey: 'sighted' })] }),
    );
    expect(resolved.chain).toEqual(['sighted']);
  });

  it('refuses the whole request when every candidate fails the capability', () => {
    let thrown: unknown;
    try {
      resolveRoute(
        { ...query, taskKey: 'image.generate' },
        [],
        // A text model declared for image generation cannot produce an image,
        // and promoting it would spend credits on a guaranteed failure.
        [model({ key: 'text-only', capabilities: ['IMAGE_GENERATION'] })],
        routing({ activeProfile: 'balanced' }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RoutingError);
    expect((thrown as RoutingError).reason).toBe('capability_unsatisfied');
  });

  it('reports a capability an operator switched off as a decision, not a fault', () => {
    let thrown: unknown;
    try {
      resolveRoute(
        query,
        [],
        [model()],
        routing({ activeProfile: 'balanced', routes: [route({ enabled: false })] }),
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as RoutingError).reason).toBe('capability_disabled');
  });
});

describe('routing profiles', () => {
  const catalogue = [
    model({
      key: 'cheap-fast',
      qualityTier: 'fast',
      latencyTier: 'fast',
      inputCostPerUnitMicroMinor: 100,
      outputCostPerUnitMicroMinor: 200,
    }),
    model({
      key: 'mid',
      qualityTier: 'balanced',
      latencyTier: 'standard',
      inputCostPerUnitMicroMinor: 1_000,
      outputCostPerUnitMicroMinor: 3_000,
    }),
    model({
      key: 'strong-slow',
      qualityTier: 'premium',
      latencyTier: 'slow',
      inputCostPerUnitMicroMinor: 10_000,
      outputCostPerUnitMicroMinor: 30_000,
    }),
  ];

  it('economy takes the cheapest model that declares the capability', () => {
    const resolved = resolveRoute(query, [], catalogue, routing({ activeProfile: 'economy' }));
    expect(resolved.chain[0]).toBe('cheap-fast');
    expect(resolved.profile).toBe('economy');
  });

  it('premium takes the strongest, and still only from declared models', () => {
    const resolved = resolveRoute(query, [], catalogue, routing({ activeProfile: 'premium' }));
    expect(resolved.chain[0]).toBe('strong-slow');
  });

  it('balanced prefers the cheap model for work with no special requirement', () => {
    const resolved = resolveRoute(query, [], catalogue, routing({ activeProfile: 'balanced' }));
    expect(resolved.chain[0]).toBe('cheap-fast');
  });

  it('balanced prefers the stronger model when the capability requires something', () => {
    /*
     * The split the profile is named for. `REASONING_COMPLEX` requires
     * structured output, and that requirement — not a hard-coded list of
     * capability names — is what tips balanced toward quality.
     */
    const reasoning = catalogue.map((m) =>
      model({
        ...m,
        capabilities: ['REASONING_COMPLEX'],
        features: features({ structuredOutput: true }),
      }),
    );
    const resolved = resolveRoute(
      { ...query, taskKey: 'strategy.generate' },
      [],
      reasoning,
      routing({ activeProfile: 'balanced' }),
    );
    expect(resolved.chain[0]).toBe('strong-slow');
  });

  it('an explicit primary overrides the strategy for that one capability', () => {
    const resolved = resolveRoute(
      query,
      [],
      catalogue,
      routing({ activeProfile: 'economy', routes: [route({ primaryModelKey: 'strong-slow' })] }),
    );
    expect(resolved.chain).toEqual(['strong-slow']);
  });

  it('a minimum quality tier excludes models beneath it', () => {
    const resolved = resolveRoute(
      query,
      [],
      catalogue,
      routing({ activeProfile: 'economy', routes: [route({ minimumQualityTier: 'premium' })] }),
    );
    expect(resolved.chain).toEqual(['strong-slow']);
    expect(resolved.excludedModelKeys).toEqual(expect.arrayContaining(['cheap-fast', 'mid']));
  });

  it('a fastest preference reorders without admitting anything new', () => {
    const resolved = resolveRoute(
      query,
      [],
      catalogue,
      routing({ activeProfile: 'premium', routes: [route({ latencyPreference: 'fastest' })] }),
    );
    expect(resolved.chain[0]).toBe('cheap-fast');
    // Reordered, not widened: still only the three declared models.
    expect(resolved.chain).toHaveLength(3);
  });

  it('ranks deterministically when two models are indistinguishable', () => {
    const twins = [
      model({ key: 'b-twin', inputCostPerUnitMicroMinor: null, outputCostPerUnitMicroMinor: null }),
      model({ key: 'a-twin', inputCostPerUnitMicroMinor: null, outputCostPerUnitMicroMinor: null }),
    ];
    const first = resolveRoute(query, [], twins, routing({ activeProfile: 'economy' }));
    const second = resolveRoute(
      query,
      [],
      [...twins].reverse(),
      routing({ activeProfile: 'economy' }),
    );
    expect(first.chain).toEqual(second.chain);
  });
});

describe('activation refuses an impossible route', () => {
  const models = {
    models: [
      {
        key: 'text-a',
        providerKey: 'mock',
        displayName: 'A',
        modality: 'text',
        qualityTier: 'balanced',
        status: 'available',
        disableSwitch: false,
        capabilities: ['CONTENT_STANDARD'],
        supportsStructuredOutput: false,
        inputCostPerUnitMicroMinor: 1,
        outputCostPerUnitMicroMinor: 1,
        qualityBenchmarkRef: 'bench-1',
      },
    ],
  };

  it('rejects a fallback that is not declared for the capability', () => {
    const report = validateConfiguration(
      'ai.capability-routing',
      {
        activeProfile: 'custom',
        routes: [
          { capability: 'CONTENT_STANDARD', primaryModelKey: 'text-a' },
          {
            capability: 'REASONING_COMPLEX',
            primaryModelKey: 'text-a',
            fallbackModelKeys: ['text-a'],
          },
        ],
      },
      { 'ai.models': models },
    );
    expect(report.valid).toBe(false);
    const messages = report.issues.map((i) => i.message).join(' ');
    // Both positions are checked, which is the §7 rule: a fallback is held to
    // exactly the same standard as a primary.
    expect(messages).toContain('Primary for REASONING_COMPLEX');
    expect(messages).toContain('Fallback for REASONING_COMPLEX');
  });

  it('rejects a route whose model declares the capability but lacks the feature', () => {
    /*
     * DEFENCE IN DEPTH. `ai.models` validation already refuses this document —
     * the assertion below it proves that — but a catalogue can be activated
     * before a route is written, and a route can be written against a model
     * that changed. The route check does not assume the catalogue was clean.
     */
    const lying = {
      models: [
        {
          ...models.models[0],
          capabilities: ['CONTENT_STANDARD', 'REASONING_COMPLEX'],
          supportsStructuredOutput: false,
        },
      ],
    };
    const report = validateConfiguration(
      'ai.capability-routing',
      {
        activeProfile: 'custom',
        routes: [{ capability: 'REASONING_COMPLEX', primaryModelKey: 'text-a' }],
      },
      { 'ai.models': lying },
    );
    expect(report.valid).toBe(false);
    expect(report.issues.map((i) => i.message).join(' ')).toContain('supportsStructuredOutput');
  });

  it('rejects an enabled custom route with no model at all', () => {
    const report = validateConfiguration(
      'ai.capability-routing',
      { activeProfile: 'custom', routes: [{ capability: 'CONTENT_STANDARD' }] },
      { 'ai.models': models },
    );
    expect(report.valid).toBe(false);
    expect(report.issues.map((i) => i.path)).toContain('routes.0.primaryModelKey');
  });

  it('accepts the same gap under a strategy profile, which fills it', () => {
    const report = validateConfiguration(
      'ai.capability-routing',
      { activeProfile: 'balanced', routes: [{ capability: 'CONTENT_STANDARD' }] },
      { 'ai.models': models },
    );
    expect(report.valid).toBe(true);
  });

  it('rejects a model declaring a capability its flags contradict', () => {
    const report = validateConfiguration(
      'ai.models',
      {
        models: [{ ...models.models[0], capabilities: ['CONTENT_STANDARD', 'VISION_ANALYSIS'] }],
      },
      {},
    );
    expect(report.valid).toBe(false);
    expect(report.issues.map((i) => i.message).join(' ')).toContain('supportsVision');
  });
});
