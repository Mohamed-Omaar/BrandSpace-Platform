import {
  parseConfigPayload,
  type ConfigurationService,
  type Environment,
} from '@brandspace/config';

/**
 * Where the automation policy comes from.
 *
 * WHAT IS DELIBERATELY NOT HERE: the trigger, condition and action REGISTRIES,
 * and the requirement that an external action waits for a person. Both are code —
 * a configurable action list is one step from an arbitrary webhook, and a
 * configurable confirmation requirement would put CLAUDE.md §2.5 within reach of
 * an operator screen. The confirmation requirement is a CHECK constraint on
 * `automation_rule`.
 */

export const AUTOMATIONS_CONFIG_DOMAIN = 'automations';

export interface AutomationPolicy {
  readonly limits: {
    readonly maxRulesPerWorkspace: number;
    readonly maxRulesPerBrand: number;
    readonly maxRunsPerRulePerDay: number;
    readonly maxConditionsPerRule: number;
  };
  readonly execution: {
    readonly confirmationTtlSeconds: number;
    readonly dispatchBatchSize: number;
    readonly claimLeaseSeconds: number;
    readonly runRetentionDays: number;
  };
}

export function parseAutomationPolicy(payload: unknown): AutomationPolicy {
  return parseConfigPayload(AUTOMATIONS_CONFIG_DOMAIN, payload) as AutomationPolicy;
}

export async function resolveAutomationPolicy(
  configuration: Pick<ConfigurationService, 'get'>,
  environment: Environment,
): Promise<AutomationPolicy> {
  return parseAutomationPolicy(await configuration.get(AUTOMATIONS_CONFIG_DOMAIN, environment));
}

export interface AutomationCatalogueReader {
  readonly entitlementCatalogueSnapshot: {
    findUnique(args: {
      where: { domain_environment: { domain: string; environment: Environment } };
    }): Promise<{ payload: unknown } | null>;
  };
}

export class TenantAutomationPolicySource {
  readonly #db: AutomationCatalogueReader;
  readonly #environment: Environment;

  constructor(db: AutomationCatalogueReader, environment: Environment) {
    this.#db = db;
    this.#environment = environment;
  }

  async load(): Promise<AutomationPolicy> {
    const row = await this.#db.entitlementCatalogueSnapshot.findUnique({
      where: {
        domain_environment: { domain: AUTOMATIONS_CONFIG_DOMAIN, environment: this.#environment },
      },
    });
    return parseAutomationPolicy(row?.payload ?? {});
  }
}
