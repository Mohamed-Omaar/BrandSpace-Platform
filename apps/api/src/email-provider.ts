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
 * A resolved provider plus how long it may be trusted.
 *
 * THE CACHE IS SHORT AND DELIBERATE. Resolving means a configuration read and a
 * decryption, and doing both on every verification email would make signup a
 * database round trip slower than it needs to be. But a cache that never
 * expires means rotating a key in the Control Center does not take effect until
 * a redeploy — so it expires, and quickly enough that rotation is a minute's
 * wait rather than an operation.
 */
interface CachedProvider {
  readonly provider: EmailProvider;
  readonly expiresAt: number;
}

const PROVIDER_TTL_MS = 60_000;
let cached: CachedProvider | null = null;

/** Drop the memoised provider. Used by tests and after a configuration change. */
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
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.provider;
  const provider = await buildProvider(prisma);
  cached = { provider, expiresAt: now + PROVIDER_TTL_MS };
  return provider;
}
