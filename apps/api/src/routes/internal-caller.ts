import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * The header a trusted Brandspace process presents to an internal route.
 *
 * The dashboard and the Control Center send it; nothing a browser holds ever
 * carries it.
 */
export const SERVICE_TOKEN_HEADER = 'x-brandspace-service-token';

/**
 * Is the caller the service we think it is?
 *
 * ONE COPY FOR EVERY INTERNAL ROUTE. It lived inside the email delivery route
 * while that was the only one; a second internal route (the storage self-test)
 * would otherwise have been a second hand-written comparison, and the first
 * one somebody "simplified" to `===` would leak the token's prefix.
 *
 * CONSTANT TIME, because a naive `===` on a secret leaks its prefix to anybody
 * who can measure a few thousand requests. Length is compared first because
 * `timingSafeEqual` throws on a mismatch, and that throw would itself be the
 * timing signal.
 *
 * NO TOKEN CONFIGURED MEANS NOBODY IS TRUSTED. An empty expected value would
 * otherwise match an empty header.
 */
export function callerIsTrusted(req: FastifyRequest): boolean {
  const expected = process.env['INTERNAL_SERVICE_TOKEN'];
  if (!expected) return false;

  const header = req.headers[SERVICE_TOKEN_HEADER];
  const presented = typeof header === 'string' ? header : '';
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}
