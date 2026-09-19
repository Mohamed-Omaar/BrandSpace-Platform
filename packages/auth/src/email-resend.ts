import { AppError, isProduction } from '@brandspace/shared';
import type { EmailMessageInput, EmailProvider } from './email';
import { renderEmail } from './email-templates';

/**
 * Resend — the first production email provider.
 *
 * NO VENDOR SDK, DELIBERATELY. Resend's API is one POST with a JSON body, and
 * the repository already hand-rolls its payment and social adapters for the
 * same reason: a dependency that wraps one request brings its own transitive
 * tree, its own retry policy and its own idea of what to log, and the last of
 * those is the one that matters here. This file controls exactly what leaves
 * the process and exactly what reaches a log line.
 *
 * NOTHING ABOVE THIS FILE KNOWS THE WORD "RESEND". Auth, signup and invitation
 * services take an `EmailProvider`; this is one. Swapping vendor is a registry
 * entry and a sibling of this file.
 *
 * THE CREDENTIAL ARRIVES AS AN ARGUMENT AND IS NEVER READ FROM THE ENVIRONMENT.
 * It lives in the Secret Service, is resolved server-side by a surface that is
 * allowed to (the API and the Control Center), and is handed here. A
 * constructor that read `process.env` would let any process with the variable
 * set become a sender, which is precisely the boundary F-07 draws.
 */

/** The HTTP seam. Tests pass a fake; production passes nothing and gets `fetch`. */
export type ResendFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ResendEmailProviderOptions {
  readonly apiKey: string;
  readonly fromEmail: string;
  readonly fromName?: string | undefined;
  readonly replyTo?: string | undefined;
  /** Override for tests. Defaults to Resend's public API. */
  readonly baseUrl?: string | undefined;
  readonly fetch?: ResendFetch | undefined;
}

const DEFAULT_BASE_URL = 'https://api.resend.com';

/**
 * A non-production override for the host the adapter talks to.
 *
 * WHY IT EXISTS. The end-to-end suite proves that activating Resend in the
 * Control Center changes which adapter a customer signup reaches — and proving
 * it needs the real registry, the real configuration read, the real decryption
 * and this real adapter, with only the HOST the request lands on replaced.
 * Stubbing the provider instead would prove that the stub was installed.
 *
 * WHY IT IS HERE RATHER THAN IN EACH CALLER. Two processes construct this
 * adapter — the API resolves the active provider to send, and the Control
 * Center constructs one to test a key — and a seam that existed in one of them
 * would make Test Connection reach the real vendor while delivery reached the
 * fake. One definition, one guard.
 *
 * REFUSED IN PRODUCTION, UNCONDITIONALLY. Redirecting the platform's mail to an
 * operator-chosen host is a way to read every verification link the product
 * issues, so this is not a setting: production ignores the variable whatever it
 * contains. It is declared in `docs/RAILWAY-ENVIRONMENT-MATRIX.md` §F, with the
 * other development-and-test-only names.
 */
export function resendTransportOverride(): { readonly baseUrl?: string } {
  if (isProduction()) return {};
  const override = process.env['BRANDSPACE_RESEND_BASE_URL']?.trim();
  return override ? { baseUrl: override } : {};
}

/**
 * Turn a provider failure into something safe to raise.
 *
 * WHAT NEVER COMES BACK OUT: the request body, the Authorization header, the
 * raw response — and, the reason this function is stricter than it first was,
 * THE PROVIDER'S FREE-TEXT MESSAGE. Resend explains a refusal by quoting the
 * request it refused, so its `message` field routinely contains the recipient
 * address and can contain any field the request carried. Forwarding it, even
 * truncated, puts that text into whatever log, error tracker or HTTP response
 * the caller happens to have. A unit test proved the point by refusing a
 * message with a body that named the credential: the truncated reason carried
 * it through.
 *
 * SO ONLY TWO THINGS ESCAPE: the HTTP status, and the machine code Resend puts
 * in `name` (`validation_error`, `invalid_api_key`, `rate_limit_exceeded` …).
 * The code is checked against a conservative shape before it is used, because
 * a field that is documented as an identifier is still a field the vendor
 * fills in — and a shape that admits no `@`, no space and no punctuation
 * beyond `_` cannot carry an address or a request echo.
 *
 * An operator who needs the vendor's own wording has it in Resend's dashboard,
 * addressed by the message id, which is where request content belongs.
 */
const SAFE_PROVIDER_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function describeFailure(status: number, payload: unknown): string {
  const name =
    typeof payload === 'object' && payload !== null && 'name' in payload
      ? String((payload as { name: unknown }).name)
      : '';
  const code = SAFE_PROVIDER_CODE.test(name) ? name : '';
  return code
    ? `Resend refused the message (HTTP ${status}, ${code}).`
    : `Resend refused the message (HTTP ${status}).`;
}

export class ResendEmailProvider implements EmailProvider {
  readonly key = 'resend';
  readonly #apiKey: string;
  readonly #from: string;
  readonly #replyTo: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: ResendFetch;

  constructor(options: ResendEmailProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new AppError('VALIDATION_FAILED', 'Resend requires an API key.');
    }
    if (!options.fromEmail.trim()) {
      throw new AppError('VALIDATION_FAILED', 'Resend requires a From address.');
    }
    this.#apiKey = options.apiKey.trim();
    const name = options.fromName?.trim();
    const address = options.fromEmail.trim();
    // `Name <address>` is the only shape Resend accepts for a display name.
    this.#from = name ? `${name} <${address}>` : address;
    this.#replyTo = options.replyTo?.trim() || undefined;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

    /*
     * A REAL SENDER NEEDS A REAL TRANSPORT. Outside production a test may inject
     * a fake; in production the absence of one would mean somebody wired a stub
     * into the sending path, and every verification link would vanish into it.
     */
    if (!options.fetch && isProduction() && typeof fetch !== 'function') {
      throw new AppError('INTERNAL', 'No HTTP transport is available to reach Resend.');
    }
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** The address messages are sent from. Not a credential; safe in an operator log. */
  get from(): string {
    return this.#from;
  }

  async send(message: EmailMessageInput): Promise<{ readonly messageId: string }> {
    const rendered = renderEmail(message);
    const response = await this.#post('/emails', {
      from: this.#from,
      to: [message.to.trim().toLowerCase()],
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      ...(this.#replyTo ? { reply_to: this.#replyTo } : {}),
    });

    /*
     * THE PROVIDER'S OWN ID, when it gives one. The `EmailProvider` contract
     * returns a message id, and an external id is what makes a delivery
     * traceable in Resend's dashboard later. A missing one is not an error —
     * the message was accepted — so the id falls back to empty rather than
     * failing a send that succeeded.
     */
    const id =
      typeof response === 'object' && response !== null && 'id' in response
        ? String((response as { id: unknown }).id)
        : '';
    return { messageId: id };
  }

  /**
   * Can this credential send?
   *
   * `GET /domains` IS THE LEAST SIDE-EFFECTFUL OPERATION THAT PROVES ANYTHING.
   * It reads, it writes nothing, it sends no mail, and it fails with 401 for a
   * bad key — which is the question Test Connection is asking.
   *
   * ITS LIMITATION IS DOCUMENTED RATHER THAN HIDDEN. A Resend key restricted to
   * *Sending access* cannot list domains and answers 401 even though it can
   * send perfectly well, so a restricted key reports "not verified" here. The
   * honest alternatives were both worse: sending a real probe message (a side
   * effect, to a real inbox) or returning success because a key is present (a
   * green tick that proves only that a string was typed). The Hub's note says
   * which key to use.
   */
  async verifyCredential(): Promise<void> {
    await this.#get('/domains');
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    return this.#request(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async #get(path: string): Promise<unknown> {
    return this.#request(path, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.#apiKey}` },
    });
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, init);
    } catch {
      /*
       * THE CAUSE IS DROPPED ON PURPOSE. A fetch failure's message carries the
       * URL, and the URL is fine — but an error CHAIN carries the request
       * options with it in several runtimes, and those hold the Authorization
       * header. Re-throwing a clean error costs one line of detail and removes
       * a way for the key to reach a log.
       */
      throw new AppError('INTERNAL', 'Resend could not be reached.');
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new AppError('INTERNAL', describeFailure(response.status, payload));
    }
    return payload;
  }
}
