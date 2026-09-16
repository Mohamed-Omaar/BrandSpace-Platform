import {
  parseConfigPayload,
  type ConfigurationService,
  type Environment,
} from '@brandspace/config';
import type { SocialProvider } from '@brandspace/database';

/**
 * Where the publishing policy comes from, and who may ask for it.
 *
 * NOTHING IN THIS FILE IS A POLICY VALUE. CLAUDE.md §2.2 puts platform
 * capabilities, scopes, retry schedules and the lateness tolerance in
 * owner-managed configuration; the schema in `packages/config/src/domains.ts`
 * is the single place a default lives, and this is the plumbing that carries an
 * activated document to the surfaces that run on it.
 *
 * TWO ENTRY POINTS, THE SAME PARSE, exactly as the Content Studio does it:
 *   - `resolvePublishingPolicy` needs a ConfigurationService and therefore the
 *     PLATFORM identity. Only `apps/api` and `apps/admin` may hold that (F-07).
 *   - Everything tenant-side reads `TenantPublishingPolicySource` — the
 *     projection in `entitlement_catalogue_snapshot`, which the tenant role may
 *     read and may not write.
 */

export const PUBLISHING_CONFIG_DOMAIN = 'publishing';

/** The lowercase configuration key for a provider enum value. */
export const PROVIDER_CONFIG_KEYS = {
  FACEBOOK: 'facebook',
  INSTAGRAM: 'instagram',
  TIKTOK: 'tiktok',
  LINKEDIN: 'linkedin',
  X: 'x',
} as const satisfies Record<SocialProvider, string>;

export type ProviderConfigKey = (typeof PROVIDER_CONFIG_KEYS)[SocialProvider];

/** Every provider this phase knows about, in a stable order for rendering. */
export const SOCIAL_PROVIDERS = [
  'FACEBOOK',
  'INSTAGRAM',
  'TIKTOK',
  'LINKEDIN',
  'X',
] as const satisfies readonly SocialProvider[];

export interface ProviderCapabilities {
  readonly enabled: boolean;
  readonly postKinds: readonly string[];
  readonly maxBodyCharacters: number;
  readonly maxHashtags: number;
  readonly maxMediaItems: number;
  readonly supportsFirstComment: boolean;
  readonly supportsDelete: boolean;
  readonly supportsNativeScheduling: boolean;
  readonly supportsPostLookup: boolean;
  readonly scopes: readonly string[];
  readonly targetKind: string;
}

export interface PublishingPolicy {
  readonly providers: Readonly<Record<ProviderConfigKey, ProviderCapabilities>>;
  readonly oauth: {
    readonly stateTtlSeconds: number;
    readonly maxConnectionsPerWorkspace: number;
  };
  readonly retry: {
    readonly maxAttempts: number;
    readonly initialBackoffSeconds: number;
    readonly backoffMultiplier: number;
    readonly maxBackoffSeconds: number;
    readonly jitterRatio: number;
  };
  readonly dispatch: {
    readonly latenessToleranceMinutes: number;
    readonly sweepBatchSize: number;
    readonly tokenRefreshAtLifetimeRatio: number;
  };
}

export function parsePublishingPolicy(payload: unknown): PublishingPolicy {
  return parseConfigPayload(PUBLISHING_CONFIG_DOMAIN, payload) as PublishingPolicy;
}

/** Capabilities for one provider, resolved from the active policy. */
export function capabilitiesFor(
  policy: PublishingPolicy,
  provider: SocialProvider,
): ProviderCapabilities {
  return policy.providers[PROVIDER_CONFIG_KEYS[provider]];
}

/** Read the active `publishing` document. Platform surfaces only. */
export async function resolvePublishingPolicy(
  configuration: Pick<ConfigurationService, 'get'>,
  environment: Environment,
): Promise<PublishingPolicy> {
  return parsePublishingPolicy(await configuration.get(PUBLISHING_CONFIG_DOMAIN, environment));
}

/**
 * The slice of the tenant-scoped client this source needs. Structural rather
 * than the full `PrismaClient`, so a caller can hand it the scoped client it
 * already holds inside a workspace transaction.
 */
export interface PublishingCatalogueReader {
  readonly entitlementCatalogueSnapshot: {
    findUnique(args: {
      where: { domain_environment: { domain: string; environment: Environment } };
    }): Promise<{ payload: unknown } | null>;
  };
}

export class TenantPublishingPolicySource {
  readonly #db: PublishingCatalogueReader;
  readonly #environment: Environment;

  constructor(db: PublishingCatalogueReader, environment: Environment) {
    this.#db = db;
    this.#environment = environment;
  }

  async load(): Promise<PublishingPolicy> {
    const row = await this.#db.entitlementCatalogueSnapshot.findUnique({
      where: {
        domain_environment: { domain: PUBLISHING_CONFIG_DOMAIN, environment: this.#environment },
      },
    });
    // No snapshot means nothing has been activated yet, not an error: parsing
    // `{}` through the schema yields that schema's own defaults, which is what
    // `ConfigurationService.get` returns on the platform side in the same
    // situation.
    return parsePublishingPolicy(row?.payload ?? {});
  }
}
