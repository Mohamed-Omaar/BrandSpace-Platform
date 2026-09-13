import type { ConfigurationService, Environment } from '@brandspace/config';

import type { AiModality } from './adapter';
import type { AiConfiguration, AiConfigurationSource } from './gateway';

/**
 * The bridge from versioned configuration to the gateway — CLAUDE.md §2.2.
 *
 * Everything the gateway routes, prices and limits by is read HERE, from the
 * active configuration version, and nowhere else. No provider name, model name,
 * rate, ceiling or credit cost appears in gateway source; the closest the code
 * gets to one is this file's knowledge of which domain each lives in.
 *
 * A domain nobody has activated yet parses to its empty-but-valid default, so a
 * fresh installation routes nothing and refuses clearly rather than falling
 * over — `resolveRoute` turns that empty payload into "no rule configured".
 */
export class ConfigurationAiSource implements AiConfigurationSource {
  readonly #configuration: ConfigurationService;
  readonly #environment: Environment;

  constructor(configuration: ConfigurationService, environment: Environment) {
    this.#configuration = configuration;
    this.#environment = environment;
  }

  async load(): Promise<AiConfiguration> {
    // Read together rather than one at a time: five sequential round trips on
    // the path of every AI request is latency the customer pays for. The
    // service caches each domain, so a warm process does no I/O at all.
    const [providers, models, routing, creditRules, budgets] = await Promise.all([
      this.#configuration.get('ai.providers', this.#environment),
      this.#configuration.get('ai.models', this.#environment),
      this.#configuration.get('ai.routing', this.#environment),
      this.#configuration.get('ai.credit-rules', this.#environment),
      this.#configuration.get('ai.budgets', this.#environment),
    ]);

    return {
      providers: providers.providers.map((provider) => ({
        key: provider.key,
        baseUrl: provider.baseUrl,
        apiKeySecretRef: provider.apiKeySecretRef,
        status: provider.status,
        timeoutMs: provider.timeoutMs,
      })),
      models: models.models.map((model) => ({
        key: model.key,
        providerKey: model.providerKey,
        modality: model.modality as AiModality,
        qualityTier: model.qualityTier,
        status: model.status,
        disableSwitch: model.disableSwitch,
      })),
      // Only models whose rates an operator has actually entered get a cost
      // basis. The rest have none, and `providerCostMicroMinor` refuses them
      // rather than recording a cost of zero and reporting infinite margin.
      costBases: models.models
        .filter(
          (model) =>
            model.inputCostPerUnitMicroMinor !== null && model.outputCostPerUnitMicroMinor !== null,
        )
        .map((model) => ({
          modelKey: model.key,
          inputCostPerUnitMicroMinor: model.inputCostPerUnitMicroMinor,
          outputCostPerUnitMicroMinor: model.outputCostPerUnitMicroMinor,
          costUnit: model.costUnit,
          costCurrency: model.costCurrency,
        })),
      routingRules: routing.rules.map((rule) => ({
        taskKey: rule.taskKey,
        scope: rule.scope,
        planKey: rule.planKey,
        workspaceId: rule.workspaceId,
        primaryModelKey: rule.primaryModelKey,
        fallbackModelKeys: rule.fallbackModelKeys,
        timeoutMs: rule.timeoutMs,
        maxCostPerRequestMinor: rule.maxCostPerRequestMinor,
        priority: rule.priority,
        parameters: rule.parameters,
        retryPolicy: rule.retryPolicy,
      })),
      creditRules: creditRules.costs.map((cost) => ({
        taskKey: cost.taskKey,
        modelKey: cost.modelKey,
        baseMilliCredits: cost.baseMilliCredits,
        perUnitMilliCredits: cost.perUnitMilliCredits,
        unit: cost.unit,
      })),
      budgets: { defaults: budgets.defaults, perPlan: budgets.perPlan },
    };
  }
}
