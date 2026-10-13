import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * CONNECTORS B — HOW A DELIVERY FROM META IS PROVEN TO BE META'S (D-533).
 *
 * Three kinds of delivery reach our Meta routes, and each carries its own
 * proof, checked BEFORE anything is parsed or written:
 *
 *   - WEBHOOK SUBSCRIPTION (`GET`): Meta sends `hub.mode=subscribe`, the verify
 *     token the owner typed into the Meta app, and `hub.challenge`; we echo the
 *     challenge only when the token matches
 *     (developers.facebook.com/docs/graph-api/webhooks/getting-started).
 *   - WEBHOOK DELIVERY (`POST`): `X-Hub-Signature-256: sha256=<hex>`, the
 *     HMAC-SHA256 of the RAW body under the app secret (same page).
 *   - DEAUTHORIZE AND DATA DELETION: a form field `signed_request`,
 *     `<signature>.<payload>` in base64url, where the signature is the
 *     HMAC-SHA256 of the encoded payload under the app secret and the payload
 *     is `{ algorithm: "HMAC-SHA256", issued_at, user_id }`
 *     (developers.facebook.com/docs/development/create-an-app/app-dashboard/
 *     data-deletion-callback).
 *
 * Every comparison is constant-time and length-checked first. Nothing here
 * logs, and nothing returns the secret, the signature or the raw user id
 * beyond the caller that hashes it.
 */

function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The challenge to echo, or null when the subscription request is not ours. */
export function metaSubscriptionChallenge(
  query: Readonly<Record<string, unknown>>,
  verifyToken: string,
): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') {
    return null;
  }
  if (challenge.length === 0 || challenge.length > 256) return null;
  return constantTimeEqual(Buffer.from(token), Buffer.from(verifyToken)) ? challenge : null;
}

/** Is `X-Hub-Signature-256` the HMAC of exactly these bytes under the app secret? */
export function metaWebhookSignatureValid(
  raw: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const given = header.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  return constantTimeEqual(Buffer.from(given.toLowerCase(), 'hex'), expected);
}

function base64UrlDecode(part: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(part)) return null;
  return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export interface MetaSignedRequest {
  /** Meta's app-scoped user id. Hashed by the caller at once; never stored. */
  readonly userId: string;
  readonly issuedAt: number | null;
}

/** The verified payload of a `signed_request`, or null when it is not Meta's. */
export function parseMetaSignedRequest(
  signedRequest: string,
  appSecret: string,
): MetaSignedRequest | null {
  if (signedRequest.length === 0 || signedRequest.length > 8_192) return null;
  const parts = signedRequest.split('.');
  if (parts.length !== 2) return null;
  const [signaturePart, payloadPart] = parts as [string, string];
  const signature = base64UrlDecode(signaturePart);
  const payloadBytes = base64UrlDecode(payloadPart);
  if (!signature || !payloadBytes) return null;
  const expected = createHmac('sha256', appSecret).update(payloadPart).digest();
  if (!constantTimeEqual(signature, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (String(record['algorithm'] ?? '').toUpperCase() !== 'HMAC-SHA256') return null;
  const userId = record['user_id'];
  if (typeof userId !== 'string' && typeof userId !== 'number') return null;
  const id = String(userId);
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(id)) return null;
  const issuedAt = record['issued_at'];
  return { userId: id, issuedAt: typeof issuedAt === 'number' ? issuedAt : null };
}

/** The dedupe key a delivery is stored under: SHA-256 of its raw bytes. */
export function inboundDedupeKey(raw: Buffer | string): string {
  return createHash('sha256').update(raw).digest('hex');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * The code a person is given for their data-deletion request: 24 characters
 * from an unambiguous alphabet, from the CSPRNG (the column's CHECK allows
 * 20–64 letters and digits).
 */
export function dataDeletionConfirmationCode(): string {
  const bytes = randomBytes(24);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}
