import { ConfigurationService } from '@brandspace/config';
import { getPrisma, type PrismaClient } from '@brandspace/database';
import { getPlatformClient } from '@brandspace/database/platform';
import { activeProviderSelection } from '@brandspace/integrations';
import { SecretService } from '@brandspace/secrets';
import {
  OutboxEmailProvider,
  ResendEmailProvider,
  UnconfiguredEmailProvider,
  resendTransportOverride,
  type EmailProvider,
} from '@brandspace/auth';
import { createLogger, currentEnvironment, isProduction } from '@brandspace/shared';

/**
 * THE ONE PLACE THAT DECIDES WHICH EMAIL PROVIDER SENDS.
 *
 * Before this, three processes each answered that question for themselves by
 * constructing `new OutboxEmailProvider(...)` at the point of use: the API, the
 * Control Center and the customer dashboard. That was harmless while the only
 * answer was "the outbox". The moment a real provider exists it stops being
 * harmless — three call sites are three chances to send through something
 * nobody activated, and one of the three is a process that must never be able
 * to read a provider credential at all.
 *
 * WHY THIS FILE IS IN `apps/api` AND NOT IN A PACKAGE. Resolving the active
 * provider means reading CONFIGURATION and then DECRYPTING a credential, and
 * the two capabilities are deliberately split across packages that cannot both
 * be reached from one: `packages/auth` may not import `@brandspace/config`, and
 * `packages/integrations` may not decrypt. The composition happens in an app,
 * and it happens in an app that already holds `SECRET_VAULT_KEK` and the
 * platform database identity. That is the same reasoning that put
 * `IntegrationTester` in `apps/admin` rather than in `packages/integrations`.
 *
 * THE DASHBOARD IS NOT SUCH AN APP, and this file is why it does not need to
 * be. The customer-facing application asks the API to perform an email
 * operation; the API resolves the provider here. No Resend key, no
 * `SECRET_VAULT_KEK` and no plaintext credential ever reaches the dashboard's
 * process (F-07, docs/SECURITY.md §2.4).
 */

const log = createLogger({ context: { component: 'api.email' } });

let cachedConfiguration: ConfigurationService | null = null;
let cachedSecrets: SecretService | null = null;

function configuration(): ConfigurationService {
  cachedConfiguration ??= new ConfigurationService({ prisma: getPlatformClient() });
  return cachedConfiguration;
}

function secrets(): SecretService {
  cachedSecrets ??= new SecretService({ prisma: getPlatformClient() });
  return cachedSecrets;
}

/**
 * A resolved provider, the activated configuration it was built from, and how
 * long its CREDENTIAL may be trusted.
 *
 * WHY THERE IS A VERSION STAMP — Phase 5. The cache used to be time-only, and
 * the process that ACTIVATES a provider is not the process that SENDS. An owner
 * connects Resend in the Control Center; the admin process invalidates its own
 * configuration cache and reports success; the API process goes on answering
 * from a sixty-second-old resolution and keeps writing to the development
 * outbox. The internal delivery route returns 200 the whole time, because from
 * its point of view a provider accepted the message — so the failure is silent,
 * and the first evidence is a customer who never received a verification link.
 *
 * `resetEmailProviderCache` existed for exactly this and HAD NO CALLERS, in
 * this repository or anywhere else. A cross-process cache cannot be invalidated
 * by an in-process function call, so the design was unfixable in that shape.
 *
 * THE STAMP IS THE ACTIVATED VERSION ID, read uncached on every resolve. It is
 * one indexed lookup — `activeVersionId` exists for precisely this kind of
 * question and documents its own refusal to be cached — and it makes activation
 * and disable take effect on the NEXT SEND in every process, with no window.
 *
 * THE TTL SURVIVES, NARROWED TO ONE JOB AND STATED AS A CONTRACT. Rotating a
 * provider CREDENTIAL does not change the configuration document: the secret
 * reference is the same, only the sealed value behind it differs. No stamp this
 * side of reading the secret can see that, so rotation remains bounded by the
 * TTL rather than instant. **Activation and disable are immediate; a credential
 * rotation takes effect within `PROVIDER_TTL_MS`.**
 */
interface CachedProvider {
  readonly provider: EmailProvider;
  /** The `configuration_version` this provider was built from. */
  readonly versionId: string | null;
  readonly expiresAt: number;
}

const PROVIDER_TTL_MS = 60_000;
let cached: CachedProvider | null = null;

/**
 * Drop the memoised provider.
 *
 * KEPT FOR TESTS, which run several resolutions in one process and need a known
 * starting point. It is NOT the invalidation mechanism — the version stamp is,
 * because a function call cannot reach another process.
 */
export function resetEmailProviderCache(): void {
  cached = null;
}

/**
 * Build the provider the activated configuration names.
 *
 * DEVELOPMENT AND PRODUCTION DIVERGE, AND THEY DIVERGE SAFELY. With nothing
 * activated, development gets the deterministic outbox and production gets a
 * provider that REFUSES at the call site. Neither silently pretends: the outbox
 * writes an auditable row that never leaves the system, and the refusal names
 * what an operator has to configure.
 */
async function buildProvider(prisma: PrismaClient): Promise<EmailProvider> {
  const environment = currentEnvironment();
  const document = await configuration().get('integrations.email', environment);
  const selection = activeProviderSelection('email', environment, document);

  if (!selection) {
    /*
     * NOTHING IS ACTIVE. In production that is a misconfiguration and the
     * refusal has to reach the caller; the outbox would report every
     * verification link as sent and deliver none, which is how a customer ends
     * up unable to finish signing up with no error anywhere.
     */
    if (isProduction()) return new UnconfiguredEmailProvider('none');
    return new OutboxEmailProvider(prisma);
  }

  if (selection.providerKey === 'resend') {
    const ref = selection.secretRefs['apiKey'];
    if (!ref) {
      throw new Error('The active Resend integration has no API key reference configured.');
    }
    /*
     * THE ONE DECRYPTION, AND IT HAPPENS HERE. `resolveSecret` is the only path
     * from a reference to a value, it needs the key domain this process holds,
     * and the value goes straight into the adapter's constructor. It is never
     * logged, never returned and never put in a message.
     */
    const apiKey = await secrets().resolveSecret(ref, environment);
    const provider = new ResendEmailProvider({
      apiKey,
      fromEmail: selection.settings['fromEmail'] ?? '',
      fromName: selection.settings['fromName'],
      replyTo: selection.settings['replyTo'],
      /*
       * THE ONE TEST SEAM, AND IT IS AT THE NETWORK BOUNDARY. Everything above
       * this line is the real path; only the host the request lands on can be
       * redirected, and only outside production. See `resendTransportOverride`.
       */
      ...resendTransportOverride(),
    });
    // The FROM address is configuration, not a credential — an operator needs
    // to see which identity the platform is sending as.
    log.info('email provider resolved', { provider: 'resend', from: provider.from });
    return provider;
  }

  if (selection.providerKey === 'outbox') {
    /*
     * The registry already refuses to activate the outbox for production and
     * `activeProviderSelection` refuses to return it there, so reaching this
     * line in production is impossible. `OutboxEmailProvider`'s own constructor
     * refuses as well, which is the third independent guard on the one mistake
     * that would make the platform lie about sending.
     */
    return new OutboxEmailProvider(prisma);
  }

  /*
   * A PROVIDER THE REGISTRY KNOWS AND THIS FILE DOES NOT. That means an entry
   * was added ahead of its adapter, and a cheerful fallback would send through
   * whatever happened to be nearest. It refuses by name instead.
   */
  return new UnconfiguredEmailProvider(selection.providerKey);
}

/**
 * The active email provider.
 *
 * Every send in `apps/api` goes through this. Nothing in this repository should
 * construct an email provider anywhere else.
 */
export async function getEmailProvider(prisma: PrismaClient = getPrisma()): Promise<EmailProvider> {
  const environment = currentEnvironment();
  /*
   * THE STAMP, READ FIRST AND UNCACHED. One indexed lookup, and it is what makes
   * this correct across processes: the activation happened somewhere else, so
   * only the database can say whether what we hold is still current.
   */
  const versionId = await configuration().activeVersionId('integrations.email', environment);
  const now = Date.now();

  if (cached && cached.versionId === versionId && cached.expiresAt > now) return cached.provider;

  /*
   * ABOUT TO REBUILD, SO DROP THIS PROCESS'S CONFIGURATION CACHE FOR THE DOMAIN.
   * `ConfigurationService` memoises payloads for thirty seconds of its own, and
   * it was invalidated in the process that activated — not in this one. Without
   * this, a correct stamp would still be answered with the previous document and
   * the rebuild would produce the stale provider again.
   */
  configuration().invalidateCache('integrations.email', environment);

  const provider = await buildProvider(prisma);
  cached = { provider, versionId, expiresAt: now + PROVIDER_TTL_MS };
  return provider;
}
