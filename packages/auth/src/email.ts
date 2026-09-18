import { randomUUID } from 'node:crypto';
// The client TYPE comes from @brandspace/database, the only package permitted
// to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import { redact, systemClock, type Clock } from '@brandspace/shared';

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

export type EmailTemplateKey =
  | 'workspace.invitation'
  | 'workspace.invitation.resent'
  | 'auth.password_reset'
  /*
   * Phase 9. The two signup templates, and the pair is the point: an address
   * that is FREE gets a verification link, one that is TAKEN gets a notice. The
   * caller cannot tell which was sent, so neither can an attacker enumerating
   * addresses (§10).
   */
  | 'auth.email_verification'
  | 'auth.signup.exists'
  | 'workspace.suspended';

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

  async send(): Promise<{ readonly messageId: string }> {
    throw new Error(
      `Email provider "${this.key}" has no implementation. ` +
        'Choose a provider in Platform Admin, or leave it as the outbox (D-41).',
    );
  }
}

/**
 * Build the provider named by configuration.
 *
 * Unknown or unset names resolve to the outbox rather than to a vendor: an
 * accidental production send is worse than an obvious missing one.
 */
export function createEmailProvider(
  prisma: PrismaClient,
  providerKey?: string,
  clock: Clock = systemClock,
): EmailProvider {
  if (!providerKey || providerKey === 'outbox' || providerKey === 'mock') {
    return new OutboxEmailProvider(prisma, clock);
  }
  return new UnconfiguredEmailProvider(providerKey);
}
