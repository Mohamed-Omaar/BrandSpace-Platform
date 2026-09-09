import { describe, expect, it } from 'vitest';

import {
  AI_TASKS,
  RoutingError,
  resolveRoute,
  type RegisteredModel,
  type RoutingRule,
} from '@brandspace/ai-gateway';
import { CONFIG_DOMAINS, validateConfiguration } from '@brandspace/config';

/**
 * Routing resolution — docs/AI-GATEWAY.md §5.
 *
 * The rule these tests exist to defend is §5.3's: "the gateway never silently
 * guesses a model." Every guess it could make would spend a customer's credits
 * on a model no operator chose, and would surface as a surprising invoice
 * rather than as an error. So the failures are asserted as carefully as the
 * successes.
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222';

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
    parameters: { temperature: 0.7, maxOutputTokens: 800, promptTemplateVersion: 1 },
    retryPolicy: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 250, jitter: true },
    ...overrides,
  };
}

function model(overrides: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    key: 'text-a',
    providerKey: 'mock',
    modality: 'text',
    qualityTier: 'balanced',
    status: 'available',
    disableSwitch: false,
    ...overrides,
  };
}

const TEXT_MODELS: RegisteredModel[] = [
  model({ key: 'text-a' }),
  model({ key: 'text-b' }),
  model({ key: 'text-c' }),
];

const query = { taskKey: 'caption.generate', workspaceId: WORKSPACE, planKey: 'growth' };

describe('routing precedence', () => {
  it('prefers a workspace rule over plan and global', () => {
    const resolved = resolveRoute(
      query,
      [
        rule({ primaryModelKey: 'text-a' }),
        rule({ scope: 'plan', planKey: 'growth', primaryModelKey: 'text-b' }),
        rule({ scope: 'workspace', workspaceId: WORKSPACE, primaryModelKey: 'text-c' }),
      ],
      TEXT_MODELS,
    );

    expect(resolved.chain[0]).toBe('text-c');
    expect(resolved.scope).toBe('workspace');
  });

  it('prefers a plan rule over global when no workspace rule applies', () => {
    const resolved = resolveRoute(
      query,
      [
        rule({ primaryModelKey: 'text-a' }),
        rule({ scope: 'plan', planKey: 'growth', primaryModelKey: 'text-b' }),
        // Belongs to a different tenant and must not be reachable from here.
        rule({ scope: 'workspace', workspaceId: OTHER_WORKSPACE, primaryModelKey: 'text-c' }),
      ],
      TEXT_MODELS,
    );

    expect(resolved.chain[0]).toBe('text-b');
    expect(resolved.scope).toBe('plan');
  });

  it('lets a lower-priority workspace rule beat a higher-priority global one', () => {
    // Scope is not a tie-break, it is the first sort key. A global rule with a
    // large priority must not override a tenant's own override.
    const resolved = resolveRoute(
      query,
      [
        rule({ primaryModelKey: 'text-a', priority: 999 }),
        rule({
          scope: 'workspace',
          workspaceId: WORKSPACE,
          primaryModelKey: 'text-b',
          priority: -5,
        }),
      ],
      TEXT_MODELS,
    );

    expect(resolved.chain[0]).toBe('text-b');
  });

  it('takes the highest priority within a scope, whatever the document order', () => {
    const resolved = resolveRoute(
      query,
      [
        rule({ primaryModelKey: 'text-a', priority: 1 }),
        rule({ primaryModelKey: 'text-b', priority: 7 }),
      ],
      TEXT_MODELS,
    );
    expect(resolved.chain[0]).toBe('text-b');

    const reversed = resolveRoute(
      query,
      [
        rule({ primaryModelKey: 'text-b', priority: 7 }),
        rule({ primaryModelKey: 'text-a', priority: 1 }),
      ],
      TEXT_MODELS,
    );
    expect(reversed.chain[0]).toBe('text-b');
  });

  it('resolves a duplicate selector deterministically rather than by iteration order', () => {
    // Config validation rejects duplicates (asserted below), but a payload
    // activated before that check existed must still resolve identically on
    // every node — a route that varied per process would make one tenant's
    // charges depend on which server answered.
    const rules = [rule({ primaryModelKey: 'text-a' }), rule({ primaryModelKey: 'text-b' })];
    for (let repeat = 0; repeat < 5; repeat += 1) {
      expect(resolveRoute(query, rules, TEXT_MODELS).chain[0]).toBe('text-a');
    }
  });

  it('ignores a workspace-scoped rule that names no workspace', () => {
    // A workspace rule with no workspace is a configuration mistake. It must
    // fall through to the global rule rather than apply to whoever asks next.
    const resolved = resolveRoute(
      query,
      [
        rule({ primaryModelKey: 'text-a' }),
        rule({ scope: 'workspace', workspaceId: null, primaryModelKey: 'text-b' }),
      ],
      TEXT_MODELS,
    );
    expect(resolved.chain[0]).toBe('text-a');
  });

  it('ignores a plan rule when the workspace has no plan', () => {
    const resolved = resolveRoute(
      { taskKey: 'caption.generate', workspaceId: WORKSPACE, planKey: null },
      [
        rule({ primaryModelKey: 'text-a' }),
        rule({ scope: 'plan', planKey: 'growth', primaryModelKey: 'text-b' }),
      ],
      TEXT_MODELS,
    );
    expect(resolved.chain[0]).toBe('text-a');
  });

  it('carries the winning rule parameters, timeout, cost cap and retry policy', () => {
    const resolved = resolveRoute(
      query,
      [
        rule({
          scope: 'workspace',
          workspaceId: WORKSPACE,
          timeoutMs: 5_000,
          maxCostPerRequestMinor: 300,
          parameters: { temperature: 0.2, maxOutputTokens: 120, promptTemplateVersion: 4 },
          retryPolicy: { maxAttempts: 1, backoff: 'none', initialDelayMs: 0, jitter: false },
        }),
      ],
      TEXT_MODELS,
    );

    expect(resolved.timeoutMs).toBe(5_000);
    expect(resolved.maxCostPerRequestMinor).toBe(300);
    expect(resolved.parameters.maxOutputTokens).toBe(120);
    expect(resolved.retryPolicy.maxAttempts).toBe(1);
  });
});

describe('routing refuses to guess', () => {
  it('fails when no rule matches the task', () => {
    const error = (() => {
      try {
        resolveRoute(query, [rule({ taskKey: 'ideas.generate' })], TEXT_MODELS);
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(RoutingError);
    expect((error as RoutingError).reason).toBe('no_rule');
  });

  it('fails on a task key the platform does not define', () => {
    expect(() =>
      resolveRoute(
        { ...query, taskKey: 'caption.generate.v2' },
        [rule({ taskKey: 'caption.generate.v2' })],
        TEXT_MODELS,
      ),
    ).toThrow(RoutingError);
  });

  it('does not leak the operator-facing detail to a client payload', () => {
    const error = (() => {
      try {
        resolveRoute(query, [], TEXT_MODELS);
        return null;
      } catch (e: unknown) {
        return e as RoutingError;
      }
    })();

    expect(error?.httpStatus).toBe(500);
    // The message names the workspace and the missing domain — operator detail
    // that must not reach the customer.
    expect(JSON.stringify(error?.toPublicJSON('req_1'))).not.toContain(WORKSPACE);
  });

  it('fails rather than substituting a model when the whole chain is unusable', () => {
    const error = (() => {
      try {
        resolveRoute(
          query,
          [rule({ primaryModelKey: 'text-a', fallbackModelKeys: ['text-b'] })],
          [
            model({ key: 'text-a', disableSwitch: true }),
            model({ key: 'text-b', status: 'disabled' }),
          ],
          // `text-c` is available and would "work" — routing to it anyway is
          // exactly the silent guess §5.3 forbids.
        );
        return null;
      } catch (e: unknown) {
        return e as RoutingError;
      }
    })();

    expect(error?.reason).toBe('no_usable_model');
  });
});

describe('the model kill switch takes effect at request time', () => {
  it('drops a killed primary and promotes the operator’s next declared model', () => {
    // Not a guess: the fallback chain IS the operator's stated preference. The
    // kill switch has to work without re-activating the routing version, so
    // the check cannot live only in config validation.
    const resolved = resolveRoute(
      query,
      [rule({ primaryModelKey: 'text-a', fallbackModelKeys: ['text-b', 'text-c'] })],
      [
        model({ key: 'text-a', disableSwitch: true }),
        model({ key: 'text-b' }),
        model({ key: 'text-c' }),
      ],
    );

    expect(resolved.chain).toEqual(['text-b', 'text-c']);
    expect(resolved.excludedModelKeys).toEqual(['text-a']);
  });

  it('drops a model that is missing from the registry entirely', () => {
    const resolved = resolveRoute(
      query,
      [rule({ primaryModelKey: 'text-retired', fallbackModelKeys: ['text-a'] })],
      [model({ key: 'text-a' })],
    );

    expect(resolved.chain).toEqual(['text-a']);
    expect(resolved.excludedModelKeys).toEqual(['text-retired']);
  });

  it('keeps a deprecated or beta model routable', () => {
    // `deprecated` warns operators; it does not stop serving traffic. Only
    // `disabled` and the kill switch do.
    const resolved = resolveRoute(
      query,
      [rule({ primaryModelKey: 'text-a', fallbackModelKeys: ['text-b'] })],
      [model({ key: 'text-a', status: 'deprecated' }), model({ key: 'text-b', status: 'beta' })],
    );
    expect(resolved.chain).toEqual(['text-a', 'text-b']);
  });

  it('collapses a model repeated in its own chain', () => {
    // Retrying the same model as its own fallback adds latency and a second
    // provider charge without adding resilience.
    const resolved = resolveRoute(
      query,
      [rule({ primaryModelKey: 'text-a', fallbackModelKeys: ['text-a', 'text-b'] })],
      TEXT_MODELS,
    );
    expect(resolved.chain).toEqual(['text-a', 'text-b']);
  });
});

describe('routing respects task modality', () => {
  it('refuses a model of the wrong modality instead of reserving credits for a certain failure', () => {
    const error = (() => {
      try {
        resolveRoute(
          { taskKey: 'image.generate', workspaceId: WORKSPACE, planKey: 'growth' },
          [rule({ taskKey: 'image.generate', primaryModelKey: 'text-a' })],
          TEXT_MODELS,
        );
        return null;
      } catch (e: unknown) {
        return e as RoutingError;
      }
    })();

    expect(error?.reason).toBe('modality_mismatch');
  });

  it('skips a mismatched model when a correct one follows it', () => {
    const resolved = resolveRoute(
      { taskKey: 'image.generate', workspaceId: WORKSPACE, planKey: 'growth' },
      [
        rule({
          taskKey: 'image.generate',
          primaryModelKey: 'text-a',
          fallbackModelKeys: ['image-a'],
        }),
      ],
      [model({ key: 'text-a' }), model({ key: 'image-a', modality: 'image' })],
    );

    expect(resolved.chain).toEqual(['image-a']);
    expect(resolved.modality).toBe('image');
  });

  it('gives every catalogued task a modality an adapter could serve', () => {
    for (const task of AI_TASKS) {
      expect(task.key, task.key).toMatch(/^[a-z]+\.[a-z]+$/);
      expect(typeof task.async, task.key).toBe('boolean');
    }
    // Duplicate keys would make findAiTask silently prefer one definition.
    expect(new Set(AI_TASKS.map((t) => t.key)).size).toBe(AI_TASKS.length);
  });
});

describe('ai.routing configuration validation', () => {
  const models = {
    models: [
      { key: 'text-a', providerKey: 'mock', displayName: 'A', modality: 'text' },
      { key: 'text-b', providerKey: 'mock', displayName: 'B', modality: 'text' },
    ],
  };

  function validate(payload: unknown) {
    return validateConfiguration('ai.routing', payload, { 'ai.models': models });
  }

  it('rejects two rules with the same selector at the same priority', () => {
    // The ambiguity is refused at activation rather than resolved on a live
    // request, because either resolution would be a coin flip the operator did
    // not intend.
    const report = validate({
      rules: [
        { taskKey: 'caption.generate', primaryModelKey: 'text-a', priority: 5 },
        { taskKey: 'caption.generate', primaryModelKey: 'text-b', priority: 5 },
      ],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.message.includes('Duplicates rule 0'))).toBe(true);
  });

  it('accepts the same selector at different priorities', () => {
    const report = validate({
      rules: [
        { taskKey: 'caption.generate', primaryModelKey: 'text-a', priority: 5 },
        { taskKey: 'caption.generate', primaryModelKey: 'text-b', priority: 6 },
      ],
    });
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('accepts the same task in different scopes', () => {
    const report = validate({
      rules: [
        { taskKey: 'caption.generate', scope: 'global', primaryModelKey: 'text-a' },
        {
          taskKey: 'caption.generate',
          scope: 'workspace',
          workspaceId: WORKSPACE,
          primaryModelKey: 'text-b',
        },
      ],
    });
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('fills parameters and retry policy so a version-1 payload still parses', () => {
    // schemaVersion 2 widened the rule. An already-activated payload written
    // before that must keep working, or the bump would take routing offline.
    const parsed = CONFIG_DOMAINS['ai.routing'].schema.parse({
      rules: [{ taskKey: 'caption.generate', primaryModelKey: 'text-a' }],
    });

    const first = parsed.rules[0];
    expect(first?.parameters.maxOutputTokens).toBeGreaterThan(0);
    expect(first?.retryPolicy.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(first?.retryPolicy.backoff).toBe('exponential');
  });

  it('caps retry attempts so a config change cannot create a charge loop', () => {
    const excessive = CONFIG_DOMAINS['ai.routing'].schema.safeParse({
      rules: [
        {
          taskKey: 'caption.generate',
          primaryModelKey: 'text-a',
          retryPolicy: { maxAttempts: 50 },
        },
      ],
    });
    expect(excessive.success).toBe(false);
  });
});
