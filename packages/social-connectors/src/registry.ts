import type { SocialProvider } from '@brandspace/database';
import type { Environment } from '@brandspace/config';
import { MockSocialConnectorAdapter } from './mock-adapters';
import { capabilitiesFor, SOCIAL_PROVIDERS, type PublishingPolicy } from './policy';
import type { SocialConnectorAdapter } from './adapter';
import { providerNotEnabled } from './errors';

/**
 * Which implementation answers for a provider.
 *
 * ONE PLACE WHERE AN IMPLEMENTATION IS CHOSEN, so enabling a real connector is a
 * registration and a configuration change rather than an edit to the pipeline.
 * Nothing above this file knows whether it is talking to Meta or to a mock.
 *
 * REAL ADAPTERS ARE NOT WRITTEN YET, AND THIS SAYS SO. Every platform here
 * requires business verification and app review before it issues a production
 * credential (D-18, D-19) — an owner-driven process measured in weeks. Shipping
 * an adapter that has never been run against the real API would be claiming an
 * integration that does not exist, which is worse than saying it does not.
 *
 * SO PRODUCTION FAILS LOUDLY. `createConnectorRegistry` refuses to hand back a
 * mock in a PRODUCTION environment: a deployment with no real connector must
 * not come up looking healthy and publish into the void.
 */

export interface ConnectorRegistry {
  /** The adapter for a provider, or a refusal if it is not enabled. */
  get(provider: SocialProvider): SocialConnectorAdapter;
  /** Providers a customer may actually connect right now. */
  enabledProviders(): readonly SocialProvider[];
}

export interface ConnectorRegistryOptions {
  readonly policy: PublishingPolicy;
  readonly environment: Environment;
  /**
   * Explicit overrides, for tests that need one provider to behave unusually
   * without reaching into a module-level singleton.
   */
  readonly adapters?: Partial<Record<SocialProvider, SocialConnectorAdapter>>;
}

export function createConnectorRegistry(options: ConnectorRegistryOptions): ConnectorRegistry {
  const built = new Map<SocialProvider, SocialConnectorAdapter>();

  for (const provider of SOCIAL_PROVIDERS) {
    const override = options.adapters?.[provider];
    if (override) {
      built.set(provider, override);
      continue;
    }
    const capabilities = capabilitiesFor(options.policy, provider);
    if (options.environment === 'PRODUCTION') {
      /*
       * NO MOCK IN PRODUCTION, EVER. A registry that silently returned one
       * would accept publish jobs, mark them PUBLISHED and store an external id
       * that points at nothing — the customer would believe they had posted.
       * Failing at resolution is the only honest behaviour.
       */
      continue;
    }
    built.set(provider, new MockSocialConnectorAdapter(provider, capabilities));
  }

  return {
    get(provider: SocialProvider): SocialConnectorAdapter {
      const adapter = built.get(provider);
      if (!adapter) throw providerNotEnabled();
      if (!adapter.capabilities.enabled) throw providerNotEnabled();
      return adapter;
    },
    enabledProviders(): readonly SocialProvider[] {
      return SOCIAL_PROVIDERS.filter((provider) => {
        const adapter = built.get(provider);
        return adapter !== undefined && adapter.capabilities.enabled;
      });
    },
  };
}
