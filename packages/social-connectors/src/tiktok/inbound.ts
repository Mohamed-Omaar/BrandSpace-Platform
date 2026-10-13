import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * CONNECTORS C — HOW A DELIVERY FROM TIKTOK IS PROVEN TO BE TIKTOK'S.
 *
 * TikTok signs every webhook (developers.tiktok.com/docs/en/
 * webhooks-verification): the header `TikTok-Signature: t=<unix seconds>,s=<hex>`
 * where `s` is the HMAC-SHA256, under the app's CLIENT SECRET, of
 * `<t>.<raw body>`. Checked on the RAW bytes before anything is parsed or
 * written, constant-time and length-checked; a timestamp outside the
 * configured tolerance is refused even with a good signature, so an old
 * delivery cannot be replayed.
 *
 * The body is `{ client_key, event, create_time, user_openid, content }`,
 * with `content` a JSON string (developers.tiktok.com/doc/webhooks-events).
 * Nothing here logs, and the person's `open_id` goes no further than the
 * caller that hashes it.
 */

export interface TikTokSignatureCheck {
  readonly raw: Buffer;
  readonly header: string | undefined;
  readonly clientSecret: string;
  /** Seconds since the epoch, from the caller's clock. */
  readonly nowSeconds: number;
  readonly toleranceSeconds: number;
}

export function tiktokWebhookSignatureValid(check: TikTokSignatureCheck): boolean {
  const header = check.header;
  if (!header || header.length > 512) return false;
  let timestamp: string | null = null;
  let signature: string | null = null;
  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't') timestamp = value;
    if (key === 's') signature = value;
  }
  if (!timestamp || !/^[0-9]{1,12}$/.test(timestamp)) return false;
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  if (Math.abs(check.nowSeconds - Number(timestamp)) > check.toleranceSeconds) return false;
  const expected = createHmac('sha256', check.clientSecret)
    .update(`${timestamp}.`)
    .update(check.raw)
    .digest();
  const given = Buffer.from(signature.toLowerCase(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The events this build acts on; everything else is recorded and set aside. */
export type TikTokInboundEvent =
  | { readonly kind: 'deauthorized'; readonly openId: string; readonly reason: number | null }
  | {
      readonly kind: 'publish_status';
      readonly event: string;
      readonly openId: string | null;
      readonly publishId: string;
    }
  | { readonly kind: 'other'; readonly event: string };

/**
 * A verified body, read. Null when it is not shaped as TikTok documents or is
 * for another app (`client_key` must be ours).
 */
export function parseTikTokWebhook(raw: Buffer, clientKey: string): TikTokInboundEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (record['client_key'] !== clientKey) return null;
  const event = record['event'];
  if (typeof event !== 'string' || !/^[a-z0-9_.]{1,80}$/.test(event)) return null;
  const openIdValue = record['user_openid'];
  const openId =
    typeof openIdValue === 'string' && /^[0-9A-Za-z_.:-]{1,128}$/.test(openIdValue)
      ? openIdValue
      : null;
  let content: Record<string, unknown> = {};
  if (typeof record['content'] === 'string') {
    try {
      const parsed: unknown = JSON.parse(record['content']);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        content = parsed as Record<string, unknown>;
      }
    } catch {
      content = {};
    }
  }
  if (event === 'authorization.removed') {
    if (!openId) return null;
    const reason = content['reason'];
    return { kind: 'deauthorized', openId, reason: typeof reason === 'number' ? reason : null };
  }
  if (event.startsWith('post.publish.')) {
    const publishId = content['publish_id'];
    if (typeof publishId !== 'string' || !/^[0-9A-Za-z_.~-]{1,512}$/.test(publishId)) {
      return { kind: 'other', event };
    }
    return { kind: 'publish_status', event, openId, publishId };
  }
  return { kind: 'other', event };
}
