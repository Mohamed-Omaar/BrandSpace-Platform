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
    /** Phase 2B-3 PR 6 — the AI executor (DRAFT_IDEAS). */
    readonly aiMaxAttempts: number;
    readonly aiExecutionBatchSize: number;
  };
  /**
   * Phase 2B-3 PR 4 — the analytics events' operator thresholds. Every value
   * is optional: unset means the event is not evaluated (`triggerAvailable`).
   */
  readonly events: {
    readonly weeklyEngagementDrop: { readonly minBaseline?: number | undefined };
    readonly topPost: {
      readonly populationDays?: number | undefined;
      readonly minImpressions?: number | undefined;
      readonly minPopulation?: number | undefined;
    };
  };
}

/**
 * CAN THIS TRIGGER BE EVALUATED WITH THE THRESHOLDS THIS ENVIRONMENT HAS?
 *
 * The two analytics events need operator thresholds with no default (report
 * §30); until every one they read is set, the producer does not evaluate, a
 * new rule on the event is refused, and the authoring screen shows it as not
 * set up. Every other trigger is always available.
 */
export function triggerAvailable(
  policy: Pick<AutomationPolicy, 'events'>,
  triggerType: string,
): boolean {
  switch (triggerType) {
    case 'WEEKLY_ENGAGEMENT_DROPPED':
      return policy.events.weeklyEngagementDrop.minBaseline !== undefined;
    case 'POST_TOP_10_PERCENT': {
      const top = policy.events.topPost;
      return (
        top.populationDays !== undefined &&
        top.minImpressions !== undefined &&
        top.minPopulation !== undefined
      );
    }
    default:
      return true;
  }
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
