import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/**
 * PR F — ACTIVATE ONE CONFIGURATION DOCUMENT FOR A TEST, AND PUT IT BACK.
 *
 * The beta switches (`commerce.payments.enabled`, the scanner, the AI routes)
 * are read from the ACTIVE configuration on every request, so the only honest
 * test of "flip it and the product follows" is to flip the active row. Written
 * directly, as `phase5-email-provider-staleness` does: the property under test
 * is what the API and the dashboard observe, not the activation workflow's
 * authorisation, which `phase10-hub-configuration` covers. A customer-visible
 * domain is also written to the tenant-readable snapshot, exactly as
 * `ConfigurationService.activate` does in its transaction.
 *
 * Isolation files run one at a time (`fileParallelism: false`), and `restore`
 * returns the domain to the row that was active before, so no other file
 * inherits a switch this one set.
 */
const ENVIRONMENT = 'DEVELOPMENT' as const;
let counter = 0;

export interface ActivatedConfig {
  /** Make `payload` the active document (and its snapshot, when projected). */
  activate(payload: Record<string, unknown>): Promise<void>;
  /** Put back whatever was active when `captureConfig` was called. */
  restore(): Promise<void>;
}

export async function captureConfig(
  platform: PrismaClient,
  domain: string,
  options: { readonly projected: boolean },
): Promise<ActivatedConfig> {
  const original = await platform.configurationVersion.findFirst({
    where: { domain, environment: ENVIRONMENT, status: 'ACTIVE' },
    select: { id: true, payload: true },
  });
  const originalSnapshot = options.projected
    ? await platform.entitlementCatalogueSnapshot.findUnique({
        where: { domain_environment: { domain, environment: ENVIRONMENT } },
        select: { payload: true, sourceVersionId: true },
      })
    : null;

  const supersedeActive = () =>
    platform.configurationVersion.updateMany({
      where: { domain, environment: ENVIRONMENT, status: 'ACTIVE' },
      data: { status: 'SUPERSEDED' },
    });

  return {
    async activate(payload) {
      await supersedeActive();
      const author = await platform.platformUser.findFirstOrThrow({ select: { id: true } });
      const row = await platform.configurationVersion.create({
        data: {
          domain,
          environment: ENVIRONMENT,
          status: 'ACTIVE',
          versionNumber: Math.floor(Date.now() / 1000) + counter++,
          payload: payload as never,
          payloadChecksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
          createdByPlatformUserId: author.id,
          changeReason: `PR F test: ${domain}`,
        },
        select: { id: true },
      });
      if (options.projected) {
        await platform.entitlementCatalogueSnapshot.upsert({
          where: { domain_environment: { domain, environment: ENVIRONMENT } },
          create: {
            domain,
            environment: ENVIRONMENT,
            payload: payload as never,
            sourceVersionId: row.id,
          },
          update: { payload: payload as never, sourceVersionId: row.id },
        });
      }
    },
    async restore() {
      await supersedeActive();
      if (original) {
        await platform.configurationVersion.update({
          where: { id: original.id },
          data: { status: 'ACTIVE' },
        });
      }
      if (!options.projected) return;
      if (originalSnapshot) {
        await platform.entitlementCatalogueSnapshot.update({
          where: { domain_environment: { domain, environment: ENVIRONMENT } },
          data: {
            payload: originalSnapshot.payload as never,
            sourceVersionId: originalSnapshot.sourceVersionId,
          },
        });
      } else {
        await platform.entitlementCatalogueSnapshot.deleteMany({
          where: { domain, environment: ENVIRONMENT },
        });
      }
    },
  };
}
