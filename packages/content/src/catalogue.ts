import {
  parseConfigPayload,
  type ConfigurationService,
  type Environment,
} from '@brandspace/config';
import { parseContentPolicy, type ContentPolicy } from './policy';

/**
 * Where the Content Studio's policy comes from, and who may ask for it.
 *
 * NOTHING IN THIS FILE IS A POLICY VALUE. CLAUDE.md §2.2 puts dialects,
 * platforms, character limits, fan-out ceilings and retention windows in
 * owner-managed configuration; the schema in `packages/config/src/domains.ts`
 * is the single place a default lives, and this is only the plumbing that
 * carries an activated document to the two surfaces that run on it.
 *
 * WHO MAY CALL WHICH ENTRY POINT:
 *   - `resolveContentPolicy` needs a ConfigurationService, which needs the
 *     PLATFORM database identity. Only a platform surface may hold that
 *     (F-07 / eslint.config.mjs PLATFORM_SURFACE_APPS) — in practice `apps/api`.
 *   - The customer dashboard reads `TenantContentPolicySource` instead: the
 *     projection in `entitlement_catalogue_snapshot`, which the tenant role may
 *     read and may not write, and which a CHECK constraint limits to the
 *     domains a customer is allowed to see at all.
 *
 * Both paths end at the SAME parse, so an owner who activates a new version
 * changes what the dashboard renders and what the API generates with, together.
 */

export const CONTENT_CONFIG_DOMAIN = 'content';

/** Read the active `content` document. Platform surfaces only. */
export async function resolveContentPolicy(
  configuration: Pick<ConfigurationService, 'get'>,
  environment: Environment,
): Promise<ContentPolicy> {
  return parseContentPolicy(await configuration.get(CONTENT_CONFIG_DOMAIN, environment));
}

/**
 * The tenant-side source.
 *
 * The same mechanism `TenantBrandBrainPolicySource` and
 * `TenantAssetPolicySource` use, for the same reason.
 */
export class TenantContentPolicySource {
  readonly #db: CatalogueReader;
  readonly #environment: Environment;

  constructor(db: CatalogueReader, environment: Environment) {
    this.#db = db;
    this.#environment = environment;
  }

  async load(): Promise<ContentPolicy> {
    const row = await this.#db.entitlementCatalogueSnapshot.findUnique({
      where: {
        domain_environment: { domain: CONTENT_CONFIG_DOMAIN, environment: this.#environment },
      },
    });

    /*
     * NO SNAPSHOT MEANS NOTHING HAS BEEN ACTIVATED YET, not an error.
     *
     * Parsing `{}` through the CONFIG schema yields that schema's own defaults —
     * the same values `ConfigurationService.get` returns on the platform side in
     * the same situation — and the result then goes through the service's own
     * parse, so a projection that somehow disagreed with the service's shape
     * fails here rather than half-way through a generation.
     */
    return parseContentPolicy(parseConfigPayload(CONTENT_CONFIG_DOMAIN, row?.payload ?? {}));
  }
}

/**
 * The slice of the tenant-scoped Prisma client this source needs.
 *
 * Structural rather than the full `PrismaClient`, so a caller can hand it the
 * scoped client it already has inside a workspace transaction.
 */
export interface CatalogueReader {
  readonly entitlementCatalogueSnapshot: {
    findUnique(args: {
      where: { domain_environment: { domain: string; environment: Environment } };
    }): Promise<{ payload: unknown } | null>;
  };
}
