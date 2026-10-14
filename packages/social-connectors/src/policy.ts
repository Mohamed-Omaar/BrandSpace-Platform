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

/** One post kind's media rule (W3). Null: not checked. */
export interface MediaRule {
  readonly mimeTypes: readonly string[];
  readonly maxBytes: number | null;
  readonly minWidth: number | null;
  readonly maxWidth: number | null;
  readonly minHeight: number | null;
  readonly maxHeight: number | null;
  readonly minAspectRatio: number | null;
  readonly maxAspectRatio: number | null;
  readonly minDurationSeconds: number | null;
  readonly maxDurationSeconds: number | null;
  readonly minItems: number | null;
  readonly maxItems: number | null;
}

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
  /** Connectors A (W3): media rules by post kind. */
  readonly mediaRules: Readonly<Partial<Record<string, MediaRule>>>;
  /** Connectors A (W12): the per-account request budget, or null. */
  readonly rateLimit: { readonly requestsPerWindow: number; readonly windowSeconds: number } | null;
  /** D-505 O1: the platform fetches media from a pre-signed URL. */
  readonly mediaByUrl: boolean;
  /** Connectors B: the platform API version calls are pinned to, or null. */
  readonly apiVersion: string | null;
  /** Connectors B: posts per account per rolling 24 hours, or null (unchecked). */
  readonly dailyPublishCap: number | null;
  /** Connectors B: this platform's expiring-soon window in hours, or null (the dispatch one). */
  readonly expiringSoonHours: number | null;
  /**
   * Connectors C: the audience every post is forced to while the platform app
   * is unaudited (`'private'`: TikTok's "Only me"), or null once it is audited.
   */
  readonly forcedAudience: 'private' | null;
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
    readonly claimLeaseSeconds: number;
    readonly staleClaimBatchSize: number;
    readonly reconnectRecheckSeconds: number;
    readonly expiringSoonHours: number;
    readonly publishPollSeconds: number;
    readonly publishPollMaxMinutes: number;
  };
  readonly media: {
    readonly fetchUrlTtlSeconds: number;
  };
  /** Connectors B: verified platform deliveries (`social_inbound_event`). */
  readonly inbound: {
    readonly retentionDays: number;
    readonly purgeBatchSize: number;
    readonly processBatchSize: number;
    readonly maxAttempts: number;
    /** Connectors C: a signed delivery's timestamp tolerance, in seconds. */
    readonly signatureToleranceSeconds: number;
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
