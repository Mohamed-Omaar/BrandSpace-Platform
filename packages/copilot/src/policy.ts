import {
  parseConfigPayload,
  type ConfigurationService,
  type Environment,
} from '@brandspace/config';

/**
 * Where the Copilot policy comes from.
 *
 * NOTHING IN THIS FILE IS A POLICY VALUE, and one thing is deliberately NOT a
 * policy value anywhere: whether an external or destructive action requires a
 * human confirmation. CLAUDE.md §2.5 and A-17 make that a permanent product
 * rule, and a configuration key that could switch it off would put it within
 * reach of an operator screen. It is a CHECK constraint on
 * `copilot_action_plan` instead — `copilot_plan_external_requires_confirmation`.
 *
 * What IS configuration is everything an operator legitimately tunes: how long a
 * confirmation stays valid, how large a plan may be, how long the undo path is
 * open, and how much of a conversation is kept.
 */

export const COPILOT_CONFIG_DOMAIN = 'copilot';

export interface CopilotPolicy {
  readonly plans: {
    readonly maxSteps: number;
    readonly confirmationTtlSeconds: number;
    readonly undoWindowSeconds: number;
    readonly maxOpenPlansPerUser: number;
  };
  readonly conversation: {
    readonly maxContextMessages: number;
    readonly maxContextChars: number;
    readonly maxRequestChars: number;
    readonly retentionDays: number;
  };
}

export function parseCopilotPolicy(payload: unknown): CopilotPolicy {
  return parseConfigPayload(COPILOT_CONFIG_DOMAIN, payload) as CopilotPolicy;
}

/** Read the active `copilot` document. Platform surfaces only (F-07). */
export async function resolveCopilotPolicy(
  configuration: Pick<ConfigurationService, 'get'>,
  environment: Environment,
): Promise<CopilotPolicy> {
  return parseCopilotPolicy(await configuration.get(COPILOT_CONFIG_DOMAIN, environment));
}

export interface CopilotCatalogueReader {
  readonly entitlementCatalogueSnapshot: {
    findUnique(args: {
      where: { domain_environment: { domain: string; environment: Environment } };
    }): Promise<{ payload: unknown } | null>;
  };
}

export class TenantCopilotPolicySource {
  readonly #db: CopilotCatalogueReader;
  readonly #environment: Environment;

  constructor(db: CopilotCatalogueReader, environment: Environment) {
    this.#db = db;
    this.#environment = environment;
  }

  async load(): Promise<CopilotPolicy> {
    const row = await this.#db.entitlementCatalogueSnapshot.findUnique({
      where: {
        domain_environment: { domain: COPILOT_CONFIG_DOMAIN, environment: this.#environment },
      },
    });
    return parseCopilotPolicy(row?.payload ?? {});
  }
}
