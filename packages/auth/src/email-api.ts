import { AppError, createLogger, internalErrorFields } from '@brandspace/shared';
import type { EmailMessageInput, EmailProvider } from './email';

/**
 * How an app without the vault key sends email: by asking the API to.
 *
 * TWO CALLERS, ONE RESOLUTION PATH. The customer dashboard uses this because it
 * must not hold a provider credential; the Control Center uses it because there
 * should be exactly one place deciding which provider is active, and that place
 * is `apps/api/src/email-provider.ts`. A second resolver in a second app is a
 * second answer to "who is sending our mail".
 *
 * THE CALLING PROCESS CANNOT RESOLVE A PROVIDER CREDENTIAL, AND FOR THE
 * DASHBOARD THAT IS DELIBERATE.
 * The Resend API key lives in the platform secret vault, sealed under
 * `SECRET_VAULT_KEK` — a key domain the dashboard does not hold and must not
 * (D-136, F-07, docs/SECURITY.md §2.4). A login surface that could unwrap a
 * platform provider credential is one request-forgery bug away from leaking it.
 *
 * SO THE LAST HOP MOVES, AND NOTHING ELSE DOES. This is an `EmailProvider` like
 * any other, so `SignupService`, `InvitationService` and the password-reset
 * action are handed it exactly where they were handed an outbox before. Their
 * transactions, their rate limits and their deliberate silence about whether an
 * address exists are all unchanged.
 *
 * WHAT CROSSES THE WIRE: a template key from the closed set, a locale, a
 * recipient, and a link the dashboard composed from a token it just issued.
 * No subject, no body, no credential. The API renders the words from the
 * platform's own catalogue, so this cannot compose a message the product would
 * not have sent itself.
 *
 * IT FAILS LOUDLY. A provider that swallowed a delivery failure would let an
 * invitation be recorded as sent and never arrive — the exact lie the outbox
 * was refused in production for telling.
 */

const log = createLogger({ context: { component: 'auth.email.api' } });

export class ApiEmailProvider implements EmailProvider {
  /*
   * The key names the TRANSPORT, not the vendor. Which vendor actually sends is
   * resolved inside the API from the activated configuration, and this process
   * has no business knowing the answer.
   */
  readonly key = 'api';

  async send(message: EmailMessageInput): Promise<{ readonly messageId: string }> {
    const base = process.env['BRANDSPACE_API_URL'];
    const token = process.env['INTERNAL_SERVICE_TOKEN'];

    if (!base || !token) {
      /*
       * NOT A SILENT NO-OP. A missing configuration here means every
       * verification link and every invitation quietly disappears, and the
       * customer is left with an account they cannot finish creating and no
       * error anywhere. The caller logs this against a correlation id and shows
       * a failure.
       */
      throw new AppError(
        'INTERNAL',
        'Email delivery is not configured: BRANDSPACE_API_URL and INTERNAL_SERVICE_TOKEN are both required.',
      );
    }

    let response: Response;
    try {
      response = await fetch(`${base.replace(/\/+$/, '')}/v1/internal/email/deliver`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The ONLY credential this process holds for the API, and it proves
          // "I am the dashboard" — never "I am this customer".
          'x-brandspace-service-token': token,
        },
        body: JSON.stringify({
          to: message.to,
          templateKey: message.templateKey,
          locale: message.locale,
          ...(message.workspaceId ? { workspaceId: message.workspaceId } : {}),
          ...(message.variables ? { variables: message.variables } : {}),
          ...(message.link ? { link: message.link } : {}),
        }),
      });
    } catch (error: unknown) {
      log.error('email delivery could not reach the API', internalErrorFields(error));
      throw new AppError('INTERNAL', 'Email delivery is unavailable.');
    }

    if (!response.ok) {
      // The status, and the template that failed. Never the recipient and never
      // the link: this line goes to an operator's log.
      log.error('email delivery was refused', {
        status: response.status,
        templateKey: message.templateKey,
      });
      throw new AppError('INTERNAL', 'Email delivery was refused.');
    }

    const payload: unknown = await response.json().catch(() => null);
    const messageId =
      typeof payload === 'object' && payload !== null && 'messageId' in payload
        ? String((payload as { messageId: unknown }).messageId)
        : '';
    return { messageId };
  }
}
