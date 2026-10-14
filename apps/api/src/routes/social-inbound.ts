import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPlatformClient } from '@brandspace/database/platform';
import { metaSubscriptionChallenge } from '@brandspace/social-connectors';
import { createLogger, internalErrorFields, systemClock } from '@brandspace/shared';
import { route } from '../route-contract';
import {
  dataDeletionStatus,
  receiveMetaDataDeletion,
  receiveMetaDeauthorize,
  receiveMetaWebhook,
  receiveTikTokWebhook,
  signedRequestFrom,
  type MetaAppSecrets,
  type SubjectKeys,
  type TikTokAppSecrets,
} from '../social-inbound';
import {
  inboundSignatureToleranceSeconds,
  metaAppSecrets,
  subjectKeys,
  tiktokAppSecrets,
} from './social';

/**
 * CONNECTORS B — THE THREE ADDRESSES THE OWNER REGISTERS IN THE META APP
 * (D-533; the Control Center lists them, `LIVE_SOCIAL_ADDRESS_KEYS`):
 *
 *   GET  /v1/social/webhooks/facebook        the webhook subscription check
 *   POST /v1/social/webhooks/facebook        a webhook delivery
 *   POST /v1/social/deauthorize/facebook     "this person removed your app"
 *   POST /v1/social/data-deletion/facebook   "delete what you hold about them"
 *   GET  /v1/social/data-deletion/facebook/status/:code   the status page Meta links to
 *
 * CONNECTORS C — AND THE ONE TIKTOK ASKS FOR:
 *
 *   POST /v1/social/webhooks/tiktok          a webhook delivery (`TikTok-Signature`)
 *
 * ONE META APP SERVES FACEBOOK AND INSTAGRAM (D-505 O3), so these are the
 * app's addresses and act on both kinds of connection.
 *
 * PUBLIC, BECAUSE META CANNOT PRESENT A SESSION. The proof is the signature,
 * checked on the RAW bytes before anything is parsed or written; a delivery
 * that is not Meta's writes nothing. The work itself is done by the
 * maintenance sweep (`social-inbound.ts`), so these answer at once.
 *
 * NO ANSWER CARRIES A SECRET, a signature, a user id or a workspace.
 */

const log = createLogger({ context: { component: 'api.social-inbound' } });

const codeParamSchema = z.object({ code: z.string().min(1).max(64) });

export interface SocialInboundDependencies {
  readonly secrets: () => Promise<MetaAppSecrets | null>;
  readonly keys: () => Promise<SubjectKeys>;
  /** The API's public base URL, for the status link Meta shows the person. */
  readonly publicBaseUrl: () => string | null;
  /** Connectors C: the TikTok app's client key and secret, or null. */
  readonly tiktokSecrets: () => Promise<TikTokAppSecrets | null>;
  /** Connectors C: how far a signed delivery's timestamp may be from now. */
  readonly signatureToleranceSeconds: () => Promise<number>;
  /** The clock a signature's timestamp is held to. */
  readonly now: () => Date;
}

const defaults: SocialInboundDependencies = {
  secrets: metaAppSecrets,
  keys: subjectKeys,
  publicBaseUrl: () => {
    const base = process.env['PUBLIC_API_BASE_URL']?.trim();
    return base ? base.replace(/\/+$/, '') : null;
  },
  tiktokSecrets: tiktokAppSecrets,
  signatureToleranceSeconds: inboundSignatureToleranceSeconds,
  now: () => systemClock.now(),
};

function rawBody(req: FastifyRequest): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
}

const NOT_CONFIGURED = { error: { code: 'NOT_CONFIGURED' } } as const;
const INVALID_SIGNATURE = { error: { code: 'INVALID_SIGNATURE' } } as const;

export async function registerSocialInboundRoutes(
  app: FastifyInstance,
  dependencies: SocialInboundDependencies = defaults,
): Promise<void> {
  // An encapsulated plugin: the raw-body parser applies to these routes only.
  await app.register(async (scoped: FastifyInstance) => {
    scoped.addContentTypeParser(
      ['application/json', 'application/x-www-form-urlencoded', 'text/plain'],
      { parseAs: 'buffer', bodyLimit: 256 * 1_024 },
      (_req, body, done) => {
        done(null, body);
      },
    );

    route(
      scoped,
      'GET',
      '/v1/social/webhooks/facebook',
      { scope: 'public' },
      async (req, reply) => {
        const secrets = await dependencies.secrets();
        const challenge = secrets?.verifyToken
          ? metaSubscriptionChallenge(req.query as Record<string, unknown>, secrets.verifyToken)
          : null;
        if (challenge === null) return reply.code(403).send();
        return reply.code(200).type('text/plain; charset=utf-8').send(challenge);
      },
    );

    route(
      scoped,
      'POST',
      '/v1/social/webhooks/facebook',
      { scope: 'public', idempotent: true },
      async (req, reply) => {
        const secrets = await dependencies.secrets();
        if (!secrets) return reply.code(503).send(NOT_CONFIGURED);
        const signature = req.headers['x-hub-signature-256'];
        const receipt = await receiveMetaWebhook({
          platform: getPlatformClient(),
          secrets,
          raw: rawBody(req),
          signature: typeof signature === 'string' ? signature : undefined,
        });
        if (!receipt.accepted) {
          log.warn('meta webhook refused', { reason: receipt.reason });
          return reply.code(receipt.reason === 'signature' ? 403 : 400).send(INVALID_SIGNATURE);
        }
        return reply.code(200).send({ received: true });
      },
    );

    route(
      scoped,
      'POST',
      '/v1/social/webhooks/tiktok',
      { scope: 'public', idempotent: true },
      async (req, reply) => {
        const secrets = await dependencies.tiktokSecrets();
        if (!secrets) return reply.code(503).send(NOT_CONFIGURED);
        const signature = req.headers['tiktok-signature'];
        const receipt = await receiveTikTokWebhook({
          platform: getPlatformClient(),
          secrets,
          keys: await dependencies.keys(),
          raw: rawBody(req),
          signature: typeof signature === 'string' ? signature : undefined,
          now: dependencies.now(),
          toleranceSeconds: await dependencies.signatureToleranceSeconds(),
        });
        if (!receipt.accepted) {
          log.warn('tiktok webhook refused', { reason: receipt.reason });
          if (receipt.reason === 'not_configured') return reply.code(503).send(NOT_CONFIGURED);
          return reply.code(receipt.reason === 'signature' ? 403 : 400).send(INVALID_SIGNATURE);
        }
        return reply.code(200).send({ received: true });
      },
    );

    route(
      scoped,
      'POST',
      '/v1/social/deauthorize/facebook',
      { scope: 'public', idempotent: true },
      async (req, reply) => {
        const secrets = await dependencies.secrets();
        if (!secrets) return reply.code(503).send(NOT_CONFIGURED);
        const receipt = await receiveMetaDeauthorize({
          platform: getPlatformClient(),
          secrets,
          keys: await dependencies.keys(),
          signedRequest: signedRequestFrom(rawBody(req)),
        });
        if (!receipt.accepted) {
          log.warn('meta deauthorize refused', { reason: receipt.reason });
          return receipt.reason === 'not_configured'
            ? reply.code(503).send(NOT_CONFIGURED)
            : reply.code(403).send(INVALID_SIGNATURE);
        }
        return reply.code(200).send({ received: true });
      },
    );

    route(
      scoped,
      'POST',
      '/v1/social/data-deletion/facebook',
      { scope: 'public', idempotent: true },
      async (req, reply) => {
        const secrets = await dependencies.secrets();
        const base = dependencies.publicBaseUrl();
        if (!secrets || base === null) return reply.code(503).send(NOT_CONFIGURED);
        try {
          const receipt = await receiveMetaDataDeletion({
            platform: getPlatformClient(),
            secrets,
            keys: await dependencies.keys(),
            signedRequest: signedRequestFrom(rawBody(req)),
          });
          if (!receipt.accepted) {
            log.warn('meta data deletion refused', { reason: receipt.reason });
            return receipt.reason === 'not_configured'
              ? reply.code(503).send(NOT_CONFIGURED)
              : reply.code(403).send(INVALID_SIGNATURE);
          }
          // Meta's documented answer: where to check, and the code to quote.
          return reply.code(200).send({
            url: `${base}/v1/social/data-deletion/facebook/status/${receipt.confirmationCode}`,
            confirmation_code: receipt.confirmationCode,
          });
        } catch (error) {
          log.error('meta data deletion not recorded', internalErrorFields(error));
          return reply.code(500).send({ error: { code: 'INTERNAL' } });
        }
      },
    );

    route(
      scoped,
      'GET',
      '/v1/social/data-deletion/facebook/status/:code',
      { scope: 'public' },
      async (req, reply) => {
        const params = codeParamSchema.safeParse(req.params);
        const found = params.success
          ? await dataDeletionStatus(getPlatformClient(), params.data.code)
          : null;
        reply.header('cache-control', 'no-store');
        reply.header('x-robots-tag', 'noindex');
        return reply
          .code(found ? 200 : 404)
          .type('text/html; charset=utf-8')
          .send(statusPage(found));
      },
    );
  });
}

/**
 * The page Meta links the person to. Both languages, because the person
 * arrives from Meta with no BrandSpace locale; it states the request's stage
 * and dates, nothing about whose data it was.
 */
export const DATA_DELETION_STATUS_COPY = {
  en: {
    title: 'Data deletion request',
    missing: 'No request with this code was found.',
    RECEIVED: 'Received. Your request is waiting to be processed.',
    IN_PROGRESS: 'In progress. The data is being deleted.',
    COMPLETED: 'Completed. The data Meta shared with Brandspace about you has been deleted.',
    requested: 'Requested',
    completed: 'Completed',
  },
  ar: {
    title: 'طلب حذف البيانات',
    missing: 'لم يُعثر على طلب بهذا الرمز.',
    RECEIVED: 'استُلم الطلب، وهو في انتظار المعالجة.',
    IN_PROGRESS: 'قيد التنفيذ. يجري حذف البيانات.',
    COMPLETED: 'اكتمل. حُذفت البيانات التي شاركتها Meta مع Brandspace عنك.',
    requested: 'تاريخ الطلب',
    completed: 'تاريخ الاكتمال',
  },
} as const;

function statusPage(
  found: { status: string; requestedAt: Date; completedAt: Date | null } | null,
): string {
  const block = (locale: 'en' | 'ar') => {
    const copy = DATA_DELETION_STATUS_COPY[locale];
    const state =
      found === null
        ? copy.missing
        : (copy[found.status as 'RECEIVED' | 'IN_PROGRESS' | 'COMPLETED'] ?? copy.RECEIVED);
    const dates =
      found === null
        ? ''
        : `<p>${copy.requested}: <time>${found.requestedAt.toISOString().slice(0, 10)}</time></p>` +
          (found.completedAt
            ? `<p>${copy.completed}: <time>${found.completedAt.toISOString().slice(0, 10)}</time></p>`
            : '');
    return `<section lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"><h1>${copy.title}</h1><p>${state}</p>${dates}</section>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${DATA_DELETION_STATUS_COPY.en.title}</title><style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5}section{margin-block-end:2rem}</style></head><body>${block('en')}${block('ar')}</body></html>`;
}
