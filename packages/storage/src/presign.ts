import { createHash, createHmac } from 'node:crypto';

/**
 * D-505 O1 — A PRE-SIGNED, READ-ONLY, SHORT-LIVED URL FOR ONE OBJECT.
 *
 * WHY THIS EXISTS NOW. Some social platforms do not accept a file's bytes:
 * they fetch it themselves from a URL. The owner decided (D-505, amending
 * D-200) that the PUBLISHING PIPELINE — never an adapter — mints such a URL for
 * exactly the files on one post, after every tenant check, living minutes. An
 * adapter still never sees a storage key or a bucket credential.
 *
 * AWS SIGNATURE VERSION 4, QUERY-STRING FORM, written out rather than pulled in
 * from another SDK package: it is a short, published algorithm, it needs no
 * network and no new dependency, and the unit test proves it against AWS's own
 * worked example. Every S3-compatible store (R2 included) accepts it.
 *
 * WHAT IT GRANTS: `GET` of one key, until `expiresInSeconds` after `now`.
 * Nothing else — no listing, no write, no other key. The URL is a bearer
 * credential for that one file for that long, so it is never logged.
 */

export interface PresignInput {
  /** Origin of the S3-compatible API, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly key: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly expiresInSeconds: number;
  readonly now: Date;
}

/** RFC 3986 encoding, as SigV4 requires: only unreserved characters stay. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** `20130524T000000Z` and `20130524`. */
function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export function presignGetUrl(input: PresignInput): string {
  // AWS's own ceiling for a SigV4 pre-signed URL is seven days.
  if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1) {
    throw new Error('A pre-signed URL needs a positive whole number of seconds.');
  }
  if (input.expiresInSeconds > 604_800) {
    throw new Error('A pre-signed URL cannot live longer than seven days.');
  }
  const origin = new URL(input.endpoint);
  const host = input.forcePathStyle ? origin.host : `${input.bucket}.${origin.host}`;
  const encodedKey = input.key.split('/').map(encodeRfc3986).join('/');
  const canonicalUri = input.forcePathStyle
    ? `/${encodeRfc3986(input.bucket)}/${encodedKey}`
    : `/${encodedKey}`;

  const { amzDate, dateStamp } = amzDates(input.now);
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = query
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return `${origin.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
