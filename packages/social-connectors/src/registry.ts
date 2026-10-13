import type { SocialProvider } from '@brandspace/database';
import type { Environment } from '@brandspace/config';
import { MockSocialConnectorAdapter } from './mock-adapters';
import { FacebookPageAdapter } from './meta/facebook';
import type { GraphFetch } from './meta/graph';
import { InstagramAccountAdapter } from './meta/instagram';
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
 * REAL ADAPTERS, WHERE ONE EXISTS (connectors step B, D-533): Facebook Pages
 * and Instagram, through Meta's Graph API. They answer in STAGING and
 * PRODUCTION, and only when the provider's `apiVersion` is configured; in
 * DEVELOPMENT (local and the E2E suite) the deterministic mock still answers,
 * because no development environment holds a Meta app. TikTok, LinkedIn and X
 * have no real adapter yet, so outside DEVELOPMENT they are not registered at
 * all and cannot be connected.
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
  /** The transport real adapters use. Tests hand in recorded answers. */
  readonly fetch?: GraphFetch;
}

/**
 * The real adapter for a provider, or null where none is written or its
 * configuration is incomplete (no `apiVersion`: not connectable).
 */
function realAdapterFor(
  provider: SocialProvider,
  capabilities: ReturnType<typeof capabilitiesFor>,
  fetch: GraphFetch | undefined,
): SocialConnectorAdapter | null {
  if (capabilities.apiVersion === null) return null;
  const options = fetch ? { fetch } : {};
  if (provider === 'FACEBOOK') return new FacebookPageAdapter(capabilities, options);
  if (provider === 'INSTAGRAM') return new InstagramAccountAdapter(capabilities, options);
  return null;
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
    if (options.environment !== 'DEVELOPMENT') {
      const real = realAdapterFor(provider, capabilities, options.fetch);
      if (real) {
        built.set(provider, real);
        continue;
      }
    }
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
