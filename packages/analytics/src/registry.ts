import type { SocialProvider } from '@brandspace/database';
import type { Environment } from '@brandspace/config';
import { MockAnalyticsConnectorAdapter } from './mock-adapters';
import type { AnalyticsConnectorAdapter } from './adapter';
import { analyticsSourceUnavailable } from './errors';

/**
 * Which implementation answers for a provider's analytics.
 *
 * ONE PLACE WHERE AN IMPLEMENTATION IS CHOSEN, so enabling a real analytics
 * connector is a registration and a configuration change rather than an edit to
 * the ingestion service. Nothing above this file knows whether it is talking to
 * Meta or to a deterministic mock.
 *
 * REAL ADAPTERS ARE NOT WRITTEN YET, AND THIS SAYS SO. Every platform here
 * requires business verification and app review before it issues a production
 * analytics credential (D-18, D-19) — an owner-driven process measured in weeks,
 * and one this phase was explicitly told not to start. Shipping an adapter that
 * has never been run against the real API would be claiming an integration that
 * does not exist.
 *
 * SO PRODUCTION FAILS LOUDLY, exactly as `createConnectorRegistry` does for
 * publishing. A mock is never returned in a PRODUCTION environment: a deployment
 * with no real source must not come up healthy, ingest arithmetic, and show a
 * customer a chart of numbers no platform ever reported. That is worse than an
 * empty screen, because an empty screen is honest.
 */

export interface AnalyticsRegistry {
  /** The adapter for a provider, or a refusal when none is available. */
  get(provider: SocialProvider): AnalyticsConnectorAdapter;
  /** Whether a provider can be asked for analytics at all right now. */
  has(provider: SocialProvider): boolean;
  /** Providers with a usable analytics source, in a stable order. */
  availableProviders(): readonly SocialProvider[];
}

const PROVIDERS: readonly SocialProvider[] = ['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'LINKEDIN', 'X'];

export interface AnalyticsRegistryOptions {
  readonly environment: Environment;
  /**
   * Explicit overrides, for tests that need one provider to behave unusually
   * without reaching into a module-level singleton.
   */
  readonly adapters?: Partial<Record<SocialProvider, AnalyticsConnectorAdapter>>;
}

export function createAnalyticsRegistry(options: AnalyticsRegistryOptions): AnalyticsRegistry {
  const built = new Map<SocialProvider, AnalyticsConnectorAdapter>();

  for (const provider of PROVIDERS) {
    const override = options.adapters?.[provider];
    if (override) {
      /*
       * AN OVERRIDE IN PRODUCTION MUST STILL BE A REAL SOURCE. Without this
       * check the production guard below would be bypassable by the very seam
       * that exists to make testing possible — a test helper is not a way to
       * register a mock in production.
       */
      if (options.environment === 'PRODUCTION' && override.sourceKind === 'MOCK') continue;
      built.set(provider, override);
      continue;
    }
    if (options.environment === 'PRODUCTION') continue;
    built.set(provider, new MockAnalyticsConnectorAdapter(provider));
  }

  return {
    get(provider: SocialProvider): AnalyticsConnectorAdapter {
      const adapter = built.get(provider);
      if (!adapter || !adapter.capabilities.enabled) throw analyticsSourceUnavailable();
      return adapter;
    },
    has(provider: SocialProvider): boolean {
      const adapter = built.get(provider);
      return adapter !== undefined && adapter.capabilities.enabled;
    },
    availableProviders(): readonly SocialProvider[] {
      return PROVIDERS.filter((provider) => {
        const adapter = built.get(provider);
        return adapter !== undefined && adapter.capabilities.enabled;
      });
    },
  };
}
