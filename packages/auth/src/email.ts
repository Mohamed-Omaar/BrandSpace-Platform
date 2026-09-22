import { randomUUID } from 'node:crypto';
// The client TYPE comes from @brandspace/database, the only package permitted
// to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import {
  assertNotProduction,
  isProduction,
  redact,
  systemClock,
  type Clock,
} from '@brandspace/shared';

/**
 * Outbound email — an INTERFACE, not a vendor.
 *
 * D-41: no external email provider has been chosen or approved, and CLAUDE.md
 * §2.2 forbids hard-coding one. Sending is therefore an interface with a
 * deterministic default implementation that writes to the `email_message`
 * outbox table. Tests assert against that table; nothing leaves the system.
 *
 * WHAT IS NEVER STORED: the token. An invitation or reset link is composed from
 * the raw token by the caller and handed to the provider as a fully-formed
 * URL — and the outbox stores only the template key and the redacted variables,
 * never the URL. A dump of `email_message` therefore yields no usable link.
 */

/**
 * EVERY TEMPLATE THE PRODUCT DECLARES — one runtime list, not a type alone.
 *
 * WHY IT IS A VALUE AND NOT ONLY A UNION. The API's internal delivery route
 * needs this set AT RUNTIME, to refuse a request naming anything else before it
 * reaches a renderer. A TypeScript union vanishes at compile time, so that route
 * MIRRORED the set as a hand-written `z.enum` — and the mirror drifted the first
 * time a template was added. `auth.password_reset.unknown` was declared here,
 * rendered here, sent by the dashboard, and rejected by the API as an unknown
 * value, so the reset it exists for failed for every unregistered address
 * wherever delivery is delegated. The type is now DERIVED from this array and
 * the route's schema is BUILT from it, so the two cannot disagree again.
 */
export const EMAIL_TEMPLATE_KEYS = [
  'workspace.invitation',
  'workspace.invitation.resent',
  'auth.password_reset',
  /*
   * Phase 4. THE PAIR TO `auth.password_reset`, and the pair is the point — the
   * same reasoning the two signup templates already carry. A registered address
   * gets a reset link; an unregistered one gets this. Both go out through the
   * same provider on the same request, so the CALLER cannot tell which happened
   * from the response, from the timing, or from whether the send failed.
   */
  'auth.password_reset.unknown',
  /*
   * Phase 9. The two signup templates, and the pair is the point: an address
   * that is FREE gets a verification link, one that is TAKEN gets a notice. The
   * caller cannot tell which was sent, so neither can an attacker enumerating
   * addresses (§10).
   */
  'auth.email_verification',
  'auth.signup.exists',
  'workspace.suspended',
] as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

export interface EmailMessageInput {
  readonly to: string;
  readonly templateKey: EmailTemplateKey;
  readonly locale: 'AR' | 'EN';
  readonly workspaceId?: string | undefined;
  /**
   * Template variables. Redacted before persistence; must NEVER include a raw
   * token, a password or a secret. Pass a link the recipient needs through
   * `link`, which is deliberately not persisted.
   */
  readonly variables?: Record<string, unknown> | undefined;
  /** The action URL. Delivered, never stored. */
  readonly link?: string | undefined;
}

export interface EmailProvider {
  readonly key: string;
  send(message: EmailMessageInput): Promise<{ readonly messageId: string }>;
}

/**
 * The default provider: an auditable outbox row.
 *
 * Deterministic, offline, and inspectable — which is what a test needs and what
 * an operator needs before a vendor exists.
 */
export class OutboxEmailProvider implements EmailProvider {
  readonly key = 'outbox';
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;

  constructor(prisma: PrismaClient, clock: Clock = systemClock) {
    /*
     * PHASE 10 §14 — NO FALSE "SENT" STATE IN PRODUCTION.
     *
     * This provider writes `status: 'SENT'` and delivers nothing, which is
     * exactly right for development and a lie in production: a customer who
     * never receives a verification link cannot finish signing up, and the
     * outbox row says the mail went out. Refusing at construction makes a
     * deployment with no email provider fail at start-up instead of silently
     * swallowing every verification, reset and billing notice.
     */
    assertNotProduction(
      'The outbox email provider',
      'Configure a transactional email provider in Platform Admin > Integrations before deploying to production.',
    );
    this.#prisma = prisma;
    this.#clock = clock;
  }

  /**
   * Write the outbox row.
   *
   * `createMany`, NOT `create`, and the id is generated here — because
   * `create()` issues `INSERT ... RETURNING`, and PostgreSQL applies the
   * policy's `USING` clause to the returned row. A workspace-less message
   * (a password reset) is legitimately writable with no context but is
   * deliberately NOT readable, so the RETURNING failed and reported itself as
   * "new row violates row-level security policy" — a write error for a write
   * that was actually allowed. Widening `USING` to make the read succeed would
   * let any context-less caller enumerate every reset request in the system,
   * which is the thing that clause exists to prevent.
   */
  async send(message: EmailMessageInput): Promise<{ readonly messageId: string }> {
    const messageId = randomUUID();
    await this.#prisma.emailMessage.createMany({
      data: {
        id: messageId,
        workspaceId: message.workspaceId ?? null,
        toEmail: message.to.trim().toLowerCase(),
        templateKey: message.templateKey,
        locale: message.locale,
        // The redaction layer runs even though callers are trusted: a template
        // variable added later must not be able to smuggle a credential in.
        // `link` is not part of this object at all.
        variables: (redact(message.variables ?? {}) ?? {}) as never,
        status: 'SENT',
        sentAt: this.#clock.now(),
      },
    });
    return { messageId };
  }
}

/**
 * A provider that refuses to send.
 *
 * Used when configuration names an email provider that has no implementation,
 * so the failure is loud at the call site rather than a silent no-op that looks
 * like a delivered invitation.
 */
export class UnconfiguredEmailProvider implements EmailProvider {
  readonly key: string;

  constructor(key: string) {
    this.key = key;
  }

  /*
   * IT TAKES THE MESSAGE AND DISCARDS IT, rather than declaring no parameters.
   * TypeScript accepts the narrower signature against the interface, but a
   * caller holding the CONCRETE type — a test proving the refusal, most
   * obviously — then cannot pass the message it is refusing to send.
   */
  async send(_message: EmailMessageInput): Promise<{ readonly messageId: string }> {
    throw new Error(
      `Email provider "${this.key}" has no implementation, so nothing was sent. ` +
        'Configure a transactional email provider in Platform Admin > Integrations. ' +
        'Outside production the outbox provider records messages instead (D-41).',
    );
  }
}

/**
 * Build the provider named by configuration.
 *
 * OUTSIDE PRODUCTION, an unknown or unset name resolves to the outbox rather
 * than to a vendor: an accidental production send is worse than an obvious
 * missing one.
 *
 * IN PRODUCTION THE DEFAULT IS REVERSED (Phase 10 §14). There is nothing safe
 * to fall back to: the outbox would report every message as sent and deliver
 * none, so an unconfigured production deployment gets a provider that REFUSES,
 * loudly, at the call site. Signup then fails with an error an operator can
 * see, instead of succeeding into a mailbox that never receives anything.
 */
export function createEmailProvider(
  prisma: PrismaClient,
  providerKey?: string,
  clock: Clock = systemClock,
): EmailProvider {
  const wantsOutbox = !providerKey || providerKey === 'outbox' || providerKey === 'mock';
  if (wantsOutbox && isProduction()) {
    return new UnconfiguredEmailProvider(providerKey ?? 'outbox');
  }
  if (wantsOutbox) {
    return new OutboxEmailProvider(prisma, clock);
  }
  return new UnconfiguredEmailProvider(providerKey);
}
