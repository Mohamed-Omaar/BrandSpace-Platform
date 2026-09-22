import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPrisma, withWorkspace, type PrismaClient } from '@brandspace/database';
import { EMAIL_TEMPLATE_KEYS, OutboxEmailProvider, type EmailMessageInput } from '@brandspace/auth';
import { createLogger, internalErrorFields, isProduction } from '@brandspace/shared';
import { getEmailProvider } from '../email-provider';
import { route } from '../route-contract';

/**
 * The trusted email delivery surface — F-07 made operational.
 *
 * WHAT PROBLEM THIS SOLVES. The customer dashboard originates four email
 * operations: signup verification, its resend, password reset and workspace
 * invitations. Sending them for real means resolving the active provider and
 * decrypting its credential, which needs `SECRET_VAULT_KEK` — and the whole
 * point of the key-domain split is that the process serving customers does not
 * have it. Giving the dashboard that key to make email work would trade the
 * platform's blast-radius separation for a feature, which docs/SECURITY.md
 * §2.4 exists to prevent.
 *
 * So the dashboard asks, and the API sends. The dashboard's flow logic,
 * transactions and anti-enumeration behaviour are untouched; only the last hop
 * moves to a process that is already allowed to hold a provider credential.
 *
 * WHY NOT MOVE THE FLOWS THEMSELVES. Two of the four already exist as public
 * API routes and the dashboard now calls those. The other two do not, and
 * lifting them would mean moving invitation creation — which deliberately
 * writes the invitation and its outbox row in one tenant transaction — out of
 * the tenant context that makes RLS apply to it. That is a redesign of settled
 * architecture to solve a credential problem, and this route is the smaller
 * answer.
 *
 * WHAT MAKES IT NOT AN OPEN RELAY:
 *
 *   1. A SHARED SERVICE TOKEN, compared in constant time. Without it the route
 *      is a way to send mail from the platform's own verified domain to any
 *      address, which is a phishing primitive with our sending reputation
 *      attached.
 *   2. A CLOSED TEMPLATE SET. The body names a `templateKey` from the six the
 *      product declares; the words come from the platform's own catalogue. A
 *      caller cannot supply a subject or a body, so it cannot compose a message
 *      the product would not have sent itself.
 *   3. NO ARBITRARY LINK TARGET — enforced, not assumed. Every supplied link
 *      must be an absolute URL whose ORIGIN is exactly
 *      `PUBLIC_DASHBOARD_BASE_URL`. See `linkIsOurs` below for why holding the
 *      token is not enough to be trusted with this field.
 */

const log = createLogger({ context: { component: 'api.internal.email' } });

/**
 * The templates the product declares. A request naming anything else is refused
 * by the schema before it reaches the renderer, rather than failing later with a
 * lookup error.
 *
 * BUILT FROM `EMAIL_TEMPLATE_KEYS`, NOT MIRRORED FROM IT. This was a
 * hand-written list of six, and the comment above it said "mirrored here on
 * purpose". The purpose was real — the closed set is what stops a caller holding
 * the service token from composing a message the product would never send — but
 * a hand-copied closed set is a rule enforced in one place and declared in
 * another, and it drifted the first time a seventh template was added: the
 * dashboard sent `auth.password_reset.unknown`, this schema had never heard of
 * it, and every reset request for an unregistered address failed wherever
 * delivery is delegated to this route. Deriving it keeps the refusal and removes
 * the copy.
 */
export const deliverySchema = z.object({
  to: z.string().min(3).max(320),
  templateKey: z.enum(EMAIL_TEMPLATE_KEYS),
  locale: z.enum(['AR', 'EN']),
  workspaceId: z.string().uuid().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  link: z.string().max(2048).optional(),
});

/**
 * Is this link one of OURS?
 *
 * THE HOLE THIS CLOSES. The route's own contract said "no arbitrary link
 * target", and the schema enforced a length and nothing else. A caller holding
 * `INTERNAL_SERVICE_TOKEN` could therefore have a BrandSpace-branded
 * verification or password-reset message, sent from the platform's own verified
 * domain, carry a link to anywhere at all. The closed template set stops a
 * caller composing a message the product would not send; it does nothing about
 * where that message POINTS, which is the part a recipient clicks.
 *
 * WHY THE TOKEN IS NOT ENOUGH. It authenticates a PROCESS, not an intention. It
 * sits in the environment of three services, is read by anything that can see
 * their configuration, and would survive in a log or a backup long after a
 * rotation. Treating possession of it as proof that a URL is safe makes the
 * blast radius of that one string "every customer's inbox, over our sending
 * reputation" rather than "ask for one of six named templates".
 *
 * THE RULE IS ORIGIN EQUALITY, not a prefix or a suffix match.
 * `startsWith(base)` would admit `https://app.example.com.attacker.test/…`;
 * `endsWith(host)` would admit `https://attacker.test/?next=app.example.com`.
 * `URL.origin` normalises scheme, host and port and compares the three
 * together, which is the only comparison that cannot be talked around.
 *
 * PRODUCTION ADDITIONALLY REQUIRES https, because a verification link is a
 * bearer credential and `http://` puts it on the wire. `assertProductionSafety`
 * already refuses an `http://` `PUBLIC_DASHBOARD_BASE_URL` in production, so
 * this is a second independent guard rather than the only one.
 */
function linkIsOurs(link: string): boolean {
  const base = process.env['PUBLIC_DASHBOARD_BASE_URL']?.trim();
  if (!base) {
    /*
     * NO CONFIGURED ORIGIN MEANS NOTHING TO COMPARE AGAINST, so nothing is
     * accepted. Refusing here costs a link in a misconfigured development
     * checkout; the alternative — accepting anything when the variable is
     * missing — is the exact failure this function exists to prevent, arriving
     * through a forgotten variable instead of through a malicious caller.
     */
    return false;
  }

  let target: URL;
  let expected: URL;
  try {
    target = new URL(link);
    expected = new URL(base);
  } catch {
    // A relative path, a `javascript:` string, a bare host — none is an
    // absolute URL, and `new URL` is the one parser that decides that.
    return false;
  }

  if (target.origin !== expected.origin) return false;
  if (isProduction() && target.protocol !== 'https:') return false;
  return true;
}

/**
 * Is the caller the service we think it is?
 *
 * CONSTANT TIME, because a naive `===` on a secret leaks its prefix to anybody
 * who can measure a few thousand requests. Length is compared first because
 * `timingSafeEqual` throws on a mismatch, and that throw would itself be the
 * timing signal.
 */
function callerIsTrusted(req: FastifyRequest): boolean {
  const expected = process.env['INTERNAL_SERVICE_TOKEN'];
  if (!expected) return false;

  const header = req.headers['x-brandspace-service-token'];
  const presented = typeof header === 'string' ? header : '';
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

/**
 * Send the message, in the tenant context it belongs to when it has one.
 *
 * WHY THE CONTEXT MATTERS HERE AND NOT BEFORE. A provider that reaches a vendor
 * touches no table and needs no context. The OUTBOX writes a row — and
 * `email_message` is tenant-owned, so a row carrying a `workspaceId` written
 * with no `app.workspace_id` set is refused by the policy, correctly.
 *
 * That combination never arose while the dashboard wrote its own outbox row
 * inside its own tenant transaction. Delegation moved the write here, where
 * there is no ambient tenant, and a workspace invitation therefore failed with
 * a row-level-security error on a deployment that had wired the delivery
 * channel but not yet activated a provider — a staging environment, in other
 * words, which is exactly where this should work.
 *
 * SO THE CONTEXT IS ESTABLISHED FROM THE MESSAGE, and only when the message
 * names a workspace. A password reset legitimately has none: it is written
 * context-free and deliberately not readable that way.
 *
 * The transaction wraps ONLY the send. Nothing else happens inside it, so a
 * slow vendor cannot hold a tenant transaction open behind a provider that
 * does not need one — `withWorkspace` is entered only for the outbox.
 */
async function deliver(
  message: EmailMessageInput,
  workspaceId: string | undefined,
): Promise<{ readonly messageId: string; readonly provider: string }> {
  const provider = await getEmailProvider(getPrisma());

  if (provider.key !== 'outbox' || !workspaceId) {
    const result = await provider.send(message);
    return { messageId: result.messageId, provider: provider.key };
  }

  const result = await withWorkspace(workspaceId, async (db) => {
    // The scoped client is a PrismaClient minus the connection-lifecycle and
    // transaction methods — exactly the surface the outbox uses, and exactly
    // the methods it must not reach for from inside a tenant transaction. The
    // same cast and the same reasoning as `inWorkspace` in the dashboard.
    const scoped = db as unknown as PrismaClient;
    return new OutboxEmailProvider(scoped).send(message);
  });
  return { messageId: result.messageId, provider: provider.key };
}

export function registerInternalEmailRoutes(app: FastifyInstance): void {
  route(
    app,
    'POST',
    '/v1/internal/email/deliver',
    { scope: 'internal', idempotent: false },
    async (req, reply) => {
      if (!callerIsTrusted(req)) {
        /*
         * 404, NOT 401. An internal route is not a surface a browser should
         * learn exists: answering "unauthorized" confirms the endpoint to
         * anybody scanning, and there is no legitimate caller who needs to be
         * told they got the token wrong rather than the URL.
         */
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }

      const parsed = deliverySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });

      if (parsed.data.link !== undefined && !linkIsOurs(parsed.data.link)) {
        /*
         * REFUSED BEFORE A PROVIDER IS EVEN RESOLVED, so nothing reaches the
         * transport and no message is composed.
         *
         * THE REJECTED LINK IS NOT LOGGED. It is attacker-controlled text on
         * one reading and a live credential on another — a genuine reset link
         * submitted with a typo'd origin would be written to an operator's log
         * by the very line meant to catch abuse. The template key says enough
         * to find the caller; the URL adds nothing an operator can act on.
         */
        log.warn('internal email refused: link origin is not the dashboard', {
          templateKey: parsed.data.templateKey,
        });
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }

      const message = {
        to: parsed.data.to,
        templateKey: parsed.data.templateKey,
        locale: parsed.data.locale,
        ...(parsed.data.workspaceId ? { workspaceId: parsed.data.workspaceId } : {}),
        ...(parsed.data.variables ? { variables: parsed.data.variables } : {}),
        ...(parsed.data.link ? { link: parsed.data.link } : {}),
      };

      try {
        const result = await deliver(message, parsed.data.workspaceId);
        /*
         * THE TEMPLATE KEY AND THE PROVIDER, AND NOTHING ELSE. Not the
         * recipient, not the link, not the variables — this line ends up in an
         * operator's log, and a password-reset link in a log is a password
         * reset anybody with log access can perform.
         */
        log.info('internal email delivered', {
          templateKey: parsed.data.templateKey,
          provider: result.provider,
        });
        return await reply.send({ delivered: true, messageId: result.messageId });
      } catch (error: unknown) {
        /*
         * A REFUSAL IS NOT A SERVER FAULT THE CALLER CAN FIX. The dashboard gets
         * a stable code; the cause — an unconfigured provider, an unverified
         * sending domain, a rejected key — is logged once, redacted, here.
         */
        log.error('internal email delivery failed', {
          templateKey: parsed.data.templateKey,
          ...internalErrorFields(error),
        });
        return reply.code(502).send({ error: { code: 'EMAIL_NOT_DELIVERED' } });
      }
    },
  );

  /*
   * A DEPLOYMENT WITHOUT THE TOKEN CANNOT SEND CUSTOMER EMAIL, and production
   * should say so at boot rather than at the first signup. This is a warning
   * rather than a refusal because the API itself is perfectly able to serve
   * every other route without it — the capability that is missing is narrow and
   * named.
   */
  if (isProduction() && !process.env['INTERNAL_SERVICE_TOKEN']) {
    log.warn(
      'INTERNAL_SERVICE_TOKEN is not set; the dashboard cannot request email delivery ' +
        'and customer signup verification will not be sent',
    );
  }
}
