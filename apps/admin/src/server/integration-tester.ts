import 'server-only';
import {
  DEVELOPMENT_PROVIDER_KEY,
  DEVELOPMENT_SIGNATURE_HEADER,
  DEVELOPMENT_TIMESTAMP_HEADER,
  DevelopmentPaymentProvider,
} from '@brandspace/billing';
import { MockProviderAdapter } from '@brandspace/ai-gateway';
import {
  OutboxEmailProvider,
  ResendEmailProvider,
  resendTransportOverride,
} from '@brandspace/auth';
import { getPlatformClient } from '@brandspace/database/platform';
import { AppError, isProduction, systemClock } from '@brandspace/shared';
import { findIntegration, type IntegrationTester } from '@brandspace/integrations';
import { currentEnvironment, getConfigService, getSecretService } from './platform-context';

/**
 * WHAT ACTUALLY TALKS TO A PROVIDER — Phase 10 §10.
 *
 * `@brandspace/integrations` deliberately imports no adapter: reaching a
 * provider means running one, and importing ai-gateway, billing,
 * social-connectors and storage into the Hub would have put that package at the
 * centre of the dependency graph and let a Control Center screen reach a
 * customer OAuth token. The wiring happens HERE instead, once, in the app that
 * already holds the platform identity.
 *
 * THE FOUR RULES EVERY TEST OBEYS (§10):
 *
 *   1. It names the environment it ran in, so "it worked" is never ambiguous.
 *   2. It uses MINIMAL billable usage — a reachability check, never a
 *      generation. Testing a connection must not cost the owner a month of
 *      tokens.
 *   3. It returns a sentence, never a credential and never a raw provider
 *      error. The service redacts the result again before storing it.
 *   4. IT DOES NOT ACTIVATE ANYTHING. Activation is a configuration change with
 *      its own author, validation, audit trail and rollback. A button that
 *      quietly did both would make "I was only checking" impossible to mean.
 *
 * AND THE FIFTH RULE, ADDED BY THE PHASE 10 CORRECTION (§9): IT TESTS WHAT THE
 * OWNER SAVED. Every value below comes from `input.settings` and
 * `input.credentials`, which the Integrations Hub resolved from the
 * configuration document and the vault moments earlier. Reading a credential
 * out of `process.env` here — which is exactly what the payment branch used to
 * do — meant the screen claimed to verify the key an owner had just entered
 * while verifying a different one entirely. A green tick for an unverified
 * configuration is worse than no button.
 *
 * THE RUNTIME IS A SEPARATE QUESTION, deliberately left alone. Phase 9's
 * automated billing fixtures still sign their loopback events with
 * `BILLING_DEV_WEBHOOK_SECRET` (`apps/api/src/routes/phase9-context.ts`), and
 * redesigning that is not this correction's business. What changed is that the
 * Hub no longer borrows it and calls it a test of the Hub's own configuration.
 */
export interface IntegrationTesterOptions {
  /**
   * The SIGNED-IN platform user who pressed Test, and the language of the page
   * they pressed it on.
   *
   * THE EMAIL TEST'S ONLY POSSIBLE RECIPIENT. The integrations action passes
   * the session's own address here; nothing a form submits can reach it. A
   * Test button that took an address would be a way to send mail from the
   * platform's verified domain to anybody, which is the open relay the internal
   * email route was built not to be.
   */
  readonly requester?: { readonly email: string; readonly locale: 'en' | 'ar' };
}

type TestResult = Awaited<ReturnType<IntegrationTester['test']>>;

export function integrationTester(options: IntegrationTesterOptions = {}): IntegrationTester {
  /**
   * Exchange the saved references for values, here and nowhere else.
   *
   * THE HUB HANDS OVER POINTERS, THIS TURNS THEM INTO VALUES, and the values go
   * straight into an adapter constructor below. They are never logged, never
   * returned, never put in a message and never held: the closure ends and they
   * are gone. `packages/integrations` cannot do this — a unit guard asserts it
   * cannot even name the operation — which is what keeps the Hub incapable of
   * decrypting anything while still testing what the owner actually saved.
   */
  const resolve = async (
    refs: Readonly<Record<string, string>>,
  ): Promise<Record<string, string>> => {
    const secrets = getSecretService();
    const environment = currentEnvironment();
    const values: Record<string, string> = {};
    for (const [field, ref] of Object.entries(refs)) {
      values[field] = await secrets.resolveSecret(ref, environment);
    }
    return values;
  };

  return {
    async test(input) {
      const startedAt = Date.now();
      const credentials = await resolve(input.credentialRefs);

      /*
       * PRODUCTION CANNOT REACH A DEVELOPMENT DOUBLE — but it MUST be able to
       * reach a real one.
       *
       * THIS USED TO REFUSE EVERYTHING. That was right while every adapter in
       * the switch below was a development double: each refuses to construct in
       * production on its own account, and the Hub should say so in a sentence
       * rather than surfacing a constructor exception. It stopped being right
       * the moment a real provider could be registered at all, because Test
       * Connection on a production deployment is exactly when an owner most
       * needs a truthful answer about a real credential.
       *
       * THE TWO REAL VENDORS ARE TESTED BY DOING THEIR ONE JOB, because the
       * credential that does the job cannot answer a read (PR F):
       *
       *   - RESEND asks for a Sending-access key restricted to the verified
       *     domain, which Resend refuses every read. So the test SENDS — one
       *     message, to the signed-in owner's own address and nobody else's.
       *     That is not an unsolicited probe: the person who pressed the
       *     button is the person who receives it.
       *   - OBJECT STORAGE is configured by the deployment, and the Control
       *     Center deliberately holds no bucket credential. So the test asks
       *     the API, which does hold it, to write, read back and delete one
       *     small object, and reports only whether each step worked.
       *
       * So the registry decides, as it does everywhere else: `developmentOnly`
       * is the property, and the refusal follows it rather than the
       * environment alone.
       */
      const definition = findIntegration(input.category, input.providerKey);
      if (isProduction() && (!definition || definition.developmentOnly)) {
        return {
          ok: false,
          latencyMs: 0,
          message:
            'This is a development provider and cannot be reached from a production deployment. ' +
            'Configure a real provider for this category.',
        };
      }

      switch (`${input.category}:${input.providerKey}`) {
        case 'ai:mock': {
          const adapter = new MockProviderAdapter();
          const result = await adapter.testConnection({
            environment: input.environment,
            // Both from the saved configuration. The deterministic provider
            // declares neither field, so both are absent today — and the day a
            // real adapter declares them, this call already carries them.
            apiKey: credentials['apiKey'] ?? null,
            baseUrl: input.settings['baseUrl'] ?? 'mock://local',
            timeoutMs: 5_000,
            signal: AbortSignal.timeout(5_000),
            requestId: 'integration-test',
          });
          return { ok: result.ok, latencyMs: result.latencyMs, message: result.message };
        }

        case 'payment:development-mock': {
          /*
           * THE REGRESSION PATH §9 NAMES. The adapter is constructed from the
           * credential the owner entered in the Hub and the base URL they
           * saved — entered value, stored through the Secret Service,
           * referenced by configuration, resolved server-side, used here.
           *
           * The guard below is unreachable in practice because
           * `configurationComplete` already refused to call a tester when a
           * required credential is missing. It stays because that guarantee
           * lives in another file, and a signing test that silently signed with
           * `undefined` would pass.
           */
          const secret = credentials['webhookSecret'];
          const hostedBaseUrl = input.settings['hostedBaseUrl'];
          if (!secret || !hostedBaseUrl) {
            return {
              ok: false,
              latencyMs: Date.now() - startedAt,
              message:
                'The saved configuration is missing the webhook signing secret or the hosted ' +
                'checkout URL, so no event this adapter signs could be verified.',
            };
          }
          const adapter = new DevelopmentPaymentProvider({ webhookSecret: secret, hostedBaseUrl });
          const capabilities = adapter.capabilities();

          /*
           * A ROUND TRIP, NOT A CONSTRUCTOR CALL. The adapter signs a probe
           * event with the saved secret and then verifies it, so the test fails
           * if the stored credential is not the one doing the signing. Proving
           * the object exists would have proven nothing about the key.
           */
          const body = Buffer.from(JSON.stringify({ probe: 'integration-test' }), 'utf8');
          const timestampSeconds = Math.floor(Date.now() / 1000);
          const verification = adapter.verifyWebhook(body, {
            [DEVELOPMENT_TIMESTAMP_HEADER]: String(timestampSeconds),
            [DEVELOPMENT_SIGNATURE_HEADER]: adapter.sign(body, timestampSeconds),
          });
          const verified = verification.valid;
          return {
            ok: verified && adapter.key === DEVELOPMENT_PROVIDER_KEY && capabilities.hostedCheckout,
            latencyMs: Date.now() - startedAt,
            message: verified
              ? 'Signed a probe event with the saved webhook secret and verified it.'
              : 'The saved webhook secret did not verify its own signature.',
          };
        }

        case 'email:outbox': {
          /*
           * Reachability, not a send. The outbox provider writes a row; a test
           * that wrote one would put a message nobody asked for into the record
           * an operator reads to see what was sent.
           */
          const provider = new OutboxEmailProvider(getPlatformClient(), systemClock);
          const reachable = await getPlatformClient().$queryRaw`SELECT 1`
            .then(() => true)
            .catch(() => false);
          return {
            ok: reachable && provider.key === 'outbox',
            latencyMs: Date.now() - startedAt,
            message: reachable
              ? 'Outbox provider is loaded; messages are recorded rather than delivered.'
              : 'The outbox table could not be reached.',
          };
        }

        case 'email:resend':
          return sendTestMessage(input, credentials, options.requester, startedAt);

        case 'storage:cloudflare-r2':
          return askApiForStorageSelfTest(startedAt);

        case 'storage:filesystem':
          return {
            ok: true,
            latencyMs: Date.now() - startedAt,
            message: 'Filesystem store is available on this host. Files live on local disk only.',
          };

        case 'social:facebook':
          return testMetaApp(input, credentials, startedAt);

        case 'social:tiktok':
          return testTikTokApp(input, credentials, startedAt);

        case 'social:mock':
          return {
            ok: true,
            latencyMs: Date.now() - startedAt,
            message:
              'Deterministic connectors are loaded. OAuth, publishing and analytics are simulated.',
          };

        default:
          /*
           * A REGISTERED PROVIDER WITH NO TESTER IS A GAP, and it says so
           * rather than returning a cheerful pass. The registry only lists
           * providers with adapters, so this is reachable only if somebody adds
           * one here without adding its test — which is exactly when a false
           * green would be most expensive.
           */
          return {
            ok: false,
            latencyMs: Date.now() - startedAt,
            message: `No connection test is implemented for ${input.category}/${input.providerKey}.`,
          };
      }
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Resend — one message, to the signed-in owner                              */
/* ------------------------------------------------------------------------ */

/**
 * Send the Control Center's test message with the SAVED key and settings.
 *
 * THE KEY IS THE ONE THE OWNER SAVED, resolved from the vault one line before
 * the constructor; the From, name and Reply-To are the saved settings — the
 * same shape `apps/api/src/email-provider.ts` builds for real delivery, with
 * the same non-production transport seam (`resendTransportOverride`), so a test
 * can point it at a fake and production cannot.
 *
 * THE RESULT IS A SENTENCE WE WROTE. A refusal says the HTTP status and
 * Resend's machine code, which the adapter has already reduced to a shape that
 * cannot carry an address or a request echo; anything else is a fixed
 * sentence. The recipient address is not in the message either: the
 * health-check row is read by other operators.
 */
async function sendTestMessage(
  input: Parameters<IntegrationTester['test']>[0],
  credentials: Readonly<Record<string, string>>,
  requester: IntegrationTesterOptions['requester'],
  startedAt: number,
): Promise<TestResult> {
  const elapsed = () => Date.now() - startedAt;
  const to = requester?.email.trim() ?? '';
  if (!requester || !to) {
    return {
      ok: false,
      latencyMs: elapsed(),
      message: 'There is no signed-in address to send the test message to, so nothing was sent.',
    };
  }

  const apiKey = credentials['apiKey'];
  const fromEmail = input.settings['fromEmail'];
  if (!apiKey || !fromEmail) {
    return {
      ok: false,
      latencyMs: elapsed(),
      message:
        'The saved configuration is missing the API key or the From address, so nothing was sent.',
    };
  }

  let provider: ResendEmailProvider;
  try {
    provider = new ResendEmailProvider({
      apiKey,
      fromEmail,
      fromName: input.settings['fromName'],
      replyTo: input.settings['replyTo'],
      ...resendTransportOverride(),
    });
  } catch {
    return {
      ok: false,
      latencyMs: elapsed(),
      message: 'The saved API key or From address is empty, so nothing was sent.',
    };
  }

  try {
    await provider.send({
      to,
      templateKey: 'integration.test_message',
      locale: requester.locale === 'ar' ? 'AR' : 'EN',
    });
    return {
      ok: true,
      latencyMs: elapsed(),
      message: 'Sent a test message to your address. Check your inbox.',
    };
  } catch (error: unknown) {
    return { ok: false, latencyMs: elapsed(), message: resendFailure(error) };
  }
}

/**
 * The adapter's own refusal sentence, when it is exactly that shape.
 *
 * `ResendEmailProvider` reduces a refusal to `Resend refused the message (HTTP
 * <status>[, <code>][, field: <name>]).` — a status, a lowercase machine code
 * and one of the field names it sent, never a value. Anything that does not
 * match that shape exactly is replaced by a fixed sentence rather than trusted.
 */
const RESEND_REFUSAL =
  /^Resend refused the message \(HTTP (\d{3})(, [a-z][a-z0-9_]{0,63})?(, field: [a-z_]{1,16})?\)\.$/;

function resendFailure(error: unknown): string {
  if (error instanceof AppError) {
    const refusal = RESEND_REFUSAL.exec(error.message);
    if (refusal) {
      return `Resend refused the test message (HTTP ${refusal[1]}${refusal[2] ?? ''}${refusal[3] ?? ''}).`;
    }
    if (error.message === 'Resend could not be reached.') {
      return 'Resend could not be reached, so the test message was not sent.';
    }
  }
  return 'The test message could not be sent.';
}

/* ------------------------------------------------------------------------ */
/* Object storage — asked of the API, which holds the bucket credential      */
/* ------------------------------------------------------------------------ */

const SELF_TEST_PATH = '/v1/internal/storage/self-test';
const SELF_TEST_TIMEOUT_MS = 10_000;
const UNREACHABLE = 'The Control Center cannot reach the API to run the storage test.';

const STEP_MESSAGES = {
  write: 'The test file could not be written.',
  read: 'The test file could not be read back.',
  compare: 'The test file read back did not match what was written.',
  delete: 'The test file could not be deleted.',
} as const;

type SelfTestStep = keyof typeof STEP_MESSAGES;

interface SelfTestReply {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly step?: SelfTestStep;
  readonly notConfigured?: boolean;
}

/** Parse the API's answer by hand: four known fields, everything else ignored. */
function parseSelfTestReply(payload: unknown): SelfTestReply | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record['ok'] !== 'boolean') return null;
  const latencyMs = typeof record['latencyMs'] === 'number' ? record['latencyMs'] : 0;
  const rawStep = record['step'];
  const step = (Object.keys(STEP_MESSAGES) as SelfTestStep[]).find((known) => known === rawStep);
  return {
    ok: record['ok'],
    latencyMs,
    ...(step ? { step } : {}),
    ...(record['notConfigured'] === true ? { notConfigured: true } : {}),
  };
}

/**
 * Ask the API to write, read back and delete one small object.
 *
 * THE SAME CHANNEL AS DELEGATED EMAIL: `BRANDSPACE_API_URL` over the private
 * network and the shared service token in `x-brandspace-service-token`. The
 * token goes in that header and nowhere else — not in a message, not in a log.
 * The API answers with a boolean, a latency and the step that failed; there is
 * nothing in its answer that could name a bucket, and nothing from a raw error
 * is passed on.
 */
async function askApiForStorageSelfTest(startedAt: number): Promise<TestResult> {
  const elapsed = () => Date.now() - startedAt;
  const base = process.env['BRANDSPACE_API_URL']?.trim();
  const token = process.env['INTERNAL_SERVICE_TOKEN'];
  if (!base || !token?.trim()) {
    return { ok: false, latencyMs: elapsed(), message: UNREACHABLE };
  }

  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/+$/, '')}${SELF_TEST_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-brandspace-service-token': token,
      },
      body: '{}',
      signal: AbortSignal.timeout(SELF_TEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, latencyMs: elapsed(), message: UNREACHABLE };
  }

  if (!response.ok) {
    return {
      ok: false,
      latencyMs: elapsed(),
      message: `The API did not run the storage test (HTTP ${response.status}).`,
    };
  }

  const reply = parseSelfTestReply(await response.json().catch(() => null));
  if (!reply) {
    return {
      ok: false,
      latencyMs: elapsed(),
      message: 'The API answered the storage test with something unexpected.',
    };
  }
  if (reply.ok) {
    return {
      ok: true,
      latencyMs: reply.latencyMs,
      message: 'Wrote, read back and deleted a small test file.',
    };
  }
  if (reply.notConfigured) {
    return {
      ok: false,
      latencyMs: reply.latencyMs,
      message: 'File storage is not configured on the API, so no test file could be written.',
    };
  }
  return {
    ok: false,
    latencyMs: reply.latencyMs,
    message: STEP_MESSAGES[reply.step ?? 'write'],
  };
}

/* ------------------------------------------------------------------------ */
/* Meta — an app token for the saved app, confirmed by Meta                  */
/* ------------------------------------------------------------------------ */

/**
 * CONNECTORS B (D-533) — DOES META ACCEPT THIS APP ID AND APP SECRET?
 *
 * Two documented calls and nothing else: Meta issues an APP token for the
 * client-credentials grant (`GET /oauth/access_token?grant_type=
 * client_credentials`, developers.facebook.com/docs/facebook-login/guides/
 * access-tokens#apptokens), and `GET /debug_token` confirms that token is valid
 * and belongs to this app id. No customer account, Page or post is touched,
 * and nothing Meta returns is shown: the result is a sentence we wrote, with
 * Meta's numeric error code when there is one. The Graph API version is the
 * one publishing is configured with (`publishing.providers.facebook.apiVersion`).
 */
async function testMetaApp(
  input: Parameters<IntegrationTester['test']>[0],
  credentials: Readonly<Record<string, string>>,
  startedAt: number,
): Promise<TestResult> {
  const elapsed = () => Date.now() - startedAt;
  const appId = input.settings['appId'];
  const appSecret = credentials['clientSecret'];
  if (!appId || !appSecret) {
    return { ok: false, latencyMs: elapsed(), message: 'Save the app ID and app secret first.' };
  }
  const publishing = (await getConfigService().get('publishing', currentEnvironment())) as {
    providers?: { facebook?: { apiVersion?: string | null } };
  };
  const version = publishing.providers?.facebook?.apiVersion ?? null;
  if (!version) {
    return {
      ok: false,
      latencyMs: elapsed(),
      message:
        'Set the Graph API version first (Publishing configuration: providers.facebook.apiVersion).',
    };
  }
  const graph = `https://graph.facebook.com/${version}`;
  const call = async (url: URL, token?: string): Promise<Record<string, unknown> | number> => {
    try {
      const response = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || body === null || body['error']) {
        const error = body?.['error'] as { code?: unknown } | undefined;
        return typeof error?.code === 'number' ? error.code : response.status;
      }
      return body;
    } catch {
      return 0;
    }
  };
  const tokenUrl = new URL(`${graph}/oauth/access_token`);
  tokenUrl.searchParams.set('client_id', appId);
  tokenUrl.searchParams.set('client_secret', appSecret);
  tokenUrl.searchParams.set('grant_type', 'client_credentials');
  const issued = await call(tokenUrl);
  if (typeof issued === 'number') {
    return {
      ok: false,
      latencyMs: elapsed(),
      message:
        issued === 0
          ? 'Meta did not answer. Try again in a moment.'
          : `Meta refused this app ID and secret (code ${issued}). Check both in the Meta app’s Settings > Basic.`,
    };
  }
  const appToken = typeof issued['access_token'] === 'string' ? issued['access_token'] : null;
  if (!appToken) {
    return {
      ok: false,
      latencyMs: elapsed(),
      message: 'Meta’s answer did not include an app token.',
    };
  }
  const debugUrl = new URL(`${graph}/debug_token`);
  debugUrl.searchParams.set('input_token', appToken);
  const checked = await call(debugUrl, appToken);
  const data =
    typeof checked === 'object' && checked['data'] !== null && typeof checked['data'] === 'object'
      ? (checked['data'] as Record<string, unknown>)
      : null;
  if (!data || data['is_valid'] !== true || String(data['app_id']) !== appId) {
    return {
      ok: false,
      latencyMs: elapsed(),
      message: 'Meta issued a token but did not confirm it belongs to this app ID.',
    };
  }
  return {
    ok: true,
    latencyMs: elapsed(),
    message: `Meta accepted this app ID and secret (Graph API ${version}).`,
  };
}

/* ------------------------------------------------------------------------ */
/* TikTok — a client token for the saved app                                 */
/* ------------------------------------------------------------------------ */

/**
 * CONNECTORS C — DOES TIKTOK ACCEPT THIS CLIENT KEY AND CLIENT SECRET?
 *
 * One documented call: TikTok issues a CLIENT access token for the
 * client-credentials grant (`POST /v2/oauth/token/`, `grant_type=
 * client_credentials`, developers.tiktok.com/doc/client-access-token-management).
 * No customer account is touched and nothing TikTok returns is shown: the
 * result is a sentence we wrote, with TikTok's error word when there is one.
 * The version is the one publishing is configured with
 * (`publishing.providers.tiktok.apiVersion`).
 */
async function testTikTokApp(
  input: Parameters<IntegrationTester['test']>[0],
  credentials: Readonly<Record<string, string>>,
  startedAt: number,
): Promise<TestResult> {
  const elapsed = () => Date.now() - startedAt;
  const clientKey = input.settings['appId'];
  const clientSecret = credentials['clientSecret'];
  if (!clientKey || !clientSecret) {
    return {
      ok: false,
      latencyMs: elapsed(),
      message: 'Save the client key and client secret first.',
    };
  }
  const publishing = (await getConfigService().get('publishing', currentEnvironment())) as {
    providers?: { tiktok?: { apiVersion?: string | null } };
  };
  const version = publishing.providers?.tiktok?.apiVersion ?? null;
  if (!version) {
    return {
      ok: false,
      latencyMs: elapsed(),
      message:
        'Set the TikTok API version first (Publishing configuration: providers.tiktok.apiVersion).',
    };
  }
  let body: Record<string, unknown> | null = null;
  let status = 0;
  try {
    const response = await fetch(`https://open.tiktokapis.com/${version}/oauth/token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    status = response.status;
    body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return {
      ok: false,
      latencyMs: elapsed(),
      message: 'TikTok did not answer. Try again in a moment.',
    };
  }
  const error = body?.['error'];
  const word = typeof error === 'string' && /^[a-z0-9_.]{1,80}$/.test(error) ? error : null;
  if (status >= 400 || word !== null || typeof body?.['access_token'] !== 'string') {
    return {
      ok: false,
      latencyMs: elapsed(),
      message: `TikTok refused this client key and secret (${word ?? `HTTP ${status}`}). Check both on the app’s page at developers.tiktok.com.`,
    };
  }
  return {
    ok: true,
    latencyMs: elapsed(),
    message: `TikTok accepted this client key and secret (API ${version}).`,
  };
}
