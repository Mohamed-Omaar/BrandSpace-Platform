import { createHash } from 'node:crypto';
import {
  AiGateway,
  AiProviderError,
  ConfigurationAiSource,
  customerMessageFor,
  type PlatformThresholdCrossing,
  type ProviderCredentialSource,
} from '@brandspace/ai-gateway';
import { aiAdapterRegistry } from '@brandspace/ai-gateway/adapters';
import { ConfigurationService } from '@brandspace/config';
import type { Prisma } from '@brandspace/database';
import { getPlatformClient } from '@brandspace/database/platform';
import { CreditLedgerService } from '@brandspace/entitlements';
import { SecretService } from '@brandspace/secrets';
import { createLogger, currentEnvironment, isAppError } from '@brandspace/shared';

import { getEmailProvider } from './email-provider';

/**
 * D-573 — THE ONE AI GATEWAY THIS PROCESS USES.
 *
 * Before D-573 three routes each built their own gateway with a hand-written
 * `new Map([['mock', …]])` and a credential source that always answered null,
 * so no provider record could ever reach a real adapter. Every route, the
 * scheduler and the automation executor now share this one:
 *
 *   - ADAPTERS come from the package's registry (`aiAdapterRegistry`): every
 *     real adapter, plus the development double outside production. Nothing in
 *     this file names a vendor.
 *   - THE CREDENTIAL comes from the Control Center vault, per attempt, through
 *     the Secret Service: Control Center -> vault -> `apiKeySecretRef` ->
 *     gateway -> adapter. It lives in memory for one call and is never cached,
 *     logged, stored or returned (see `vaultCredentials`).
 *   - THE PLATFORM CEILING'S ALERT goes to the platform owner (see
 *     `alertPlatformOwner`).
 */

const log = createLogger({ context: { component: 'api.ai-gateway' } });

let cachedGateway: AiGateway | null = null;
let cachedSecrets: SecretService | null = null;

function secrets(): SecretService {
  cachedSecrets ??= new SecretService({ prisma: getPlatformClient() });
  return cachedSecrets;
}

/**
 * The provider credential, resolved from the vault for ONE attempt.
 *
 *   - No reference: null (a development double needs none).
 *   - A reference with nothing stored behind it: null, which is what the
 *     contract says "has none stored" means. A real adapter then sends no
 *     credential and the provider refuses with an auth error, which the
 *     gateway classifies, releases and shows as "unavailable".
 *   - A stored credential that cannot be used (disabled, expired, undecryptable):
 *     an AUTH_ERROR whose text names no reference and no value.
 */
export function vaultCredentials(
  resolveSecret: (ref: string) => Promise<string>,
): ProviderCredentialSource {
  return {
    async resolve(secretRef) {
      if (!secretRef) return null;
      try {
        return await resolveSecret(secretRef);
      } catch (error) {
        if (isAppError(error) && error.code === 'NOT_FOUND') return null;
        throw new AiProviderError(
          'AUTH_ERROR',
          customerMessageFor('AUTH_ERROR'),
          'The provider credential could not be read from the vault.',
        );
      }
    },
  };
}

/** The gateway every route, the scheduler and the automation executor share. */
export function platformAiGateway(): AiGateway {
  if (cachedGateway) return cachedGateway;
  const platform = getPlatformClient();
  const environment = currentEnvironment();
  cachedGateway = new AiGateway({
    prisma: platform,
    ledger: new CreditLedgerService({ prisma: platform }),
    /*
     * PHASE 10 §11 STILL HOLDS: in production the registry holds no development
     * double (and `MockProviderAdapter` refuses to be built there). With no
     * ACTIVE provider whose adapter is registered, the chain finds nothing to
     * call, the request fails as MODEL_UNAVAILABLE, the reservation is
     * released and nothing is charged.
     */
    adapters: aiAdapterRegistry(environment),
    configuration: new ConfigurationAiSource(
      new ConfigurationService({ prisma: platform }),
      environment,
    ),
    credentials: vaultCredentials((ref) => secrets().resolveSecret(ref, environment)),
    environment,
    onPlatformThreshold: (crossings) => alertPlatformOwner(crossings),
  });
  return cachedGateway;
}

/** The audit action that records, once per period and threshold, that the owner was told. */
export const PLATFORM_CEILING_ALERT_ACTION = 'ai.platform_ceiling.threshold_reached';

/** One stable name per period, start and threshold — the de-duplication key. */
export function crossingReason(crossing: PlatformThresholdCrossing): string {
  const start = crossing.periodStart.toISOString().slice(0, crossing.period === 'day' ? 10 : 7);
  return `${crossing.period}:${start}:${crossing.thresholdPercent}`;
}

function lockKey(reason: string): bigint {
  return createHash('sha256')
    .update(`brandspace:ai-platform-ceiling-alert:v1:${reason}`)
    .digest()
    .readBigInt64BE(0);
}

/**
 * D-573 — TELL THE OWNER: at 80% and at 100% of the daily and the monthly
 * platform ceiling.
 *
 * EXACTLY ONCE PER PERIOD AND THRESHOLD, ACROSS PROCESSES. Each crossing takes
 * an advisory lock named for it and looks for its own audit event; only the
 * process that writes that event sends the email. The audit event is also what
 * the Control Center Home reads for its notice.
 *
 * The email carries no figure and no link: it says a ceiling alert was raised
 * and to open the Control Center, where the numbers are. Nothing about a
 * customer, a provider or a credential is in it.
 */
export async function alertPlatformOwner(
  crossings: readonly PlatformThresholdCrossing[],
): Promise<void> {
  const prisma = getPlatformClient();
  let raised = 0;
  for (const crossing of crossings) {
    const reason = crossingReason(crossing);
    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey(reason)}::bigint)`;
      const existing = await tx.auditEvent.findFirst({
        where: { action: PLATFORM_CEILING_ALERT_ACTION, reason, workspaceId: null },
        select: { id: true },
      });
      if (existing) return false;
      await tx.auditEvent.create({
        data: {
          workspaceId: null,
          actorType: 'SYSTEM',
          action: PLATFORM_CEILING_ALERT_ACTION,
          resourceType: 'ai.budgets',
          severity: crossing.thresholdPercent >= 100 ? 'CRITICAL' : 'WARNING',
          reason,
          after: {
            period: crossing.period,
            periodStart: crossing.periodStart.toISOString(),
            thresholdPercent: crossing.thresholdPercent,
            ceilingMicroMinor: String(crossing.ceilingMicroMinor),
            spentMicroMinor: String(crossing.spentMicroMinor),
            currency: crossing.currency,
          } satisfies Prisma.InputJsonValue,
        },
      });
      return true;
    });
    if (created) raised += 1;
  }
  if (raised === 0) return;

  log.warn('platform AI ceiling alert raised', { alerts: raised });
  const owners = await prisma.platformUser.findMany({
    where: { status: 'ACTIVE', role: { key: 'platform_owner' } },
    select: { email: true },
  });
  const email = await getEmailProvider(prisma);
  for (const owner of owners) {
    // One failed delivery must not stop the others; the notice on Home stands.
    await email
      .send({ to: owner.email, templateKey: 'platform.ai_spend_alert', locale: 'EN' })
      .catch(() => log.error('platform AI ceiling alert email failed', { alerts: raised }));
  }
}
