import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  dataDeletionConfirmationCode,
  inboundDedupeKey,
  metaSubscriptionChallenge,
  metaWebhookSignatureValid,
  parseMetaSignedRequest,
} from '@brandspace/social-connectors';

/**
 * CONNECTORS B — HOW A DELIVERY IS PROVEN TO BE META'S (D-533), as Meta
 * documents each proof: the subscription verify token, `X-Hub-Signature-256`
 * over the raw body, and the `signed_request` of the deauthorize and
 * data-deletion callbacks. The routes and the processing are proven against
 * real PostgreSQL in tests/isolation/connectors-b-meta-inbound.test.ts.
 */

const SECRET = 'test-only-app-secret';

const base64Url = (value: Buffer | string) =>
  Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A `signed_request` built exactly as Meta builds one. */
export function signedRequest(payload: Record<string, unknown>, secret = SECRET): string {
  const encoded = base64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(encoded).digest();
  return `${base64Url(signature)}.${encoded}`;
}

describe('the webhook subscription check', () => {
  const query = (token: string) => ({
    'hub.mode': 'subscribe',
    'hub.verify_token': token,
    'hub.challenge': '1158201444',
  });

  it('echoes the challenge only for the owner’s verify token', () => {
    expect(metaSubscriptionChallenge(query('owner-token'), 'owner-token')).toBe('1158201444');
    expect(metaSubscriptionChallenge(query('guess'), 'owner-token')).toBeNull();
    expect(metaSubscriptionChallenge(query('owner-token-longer'), 'owner-token')).toBeNull();
    expect(
      metaSubscriptionChallenge(
        { ...query('owner-token'), 'hub.mode': 'unsubscribe' },
        'owner-token',
      ),
    ).toBeNull();
    expect(metaSubscriptionChallenge({ 'hub.mode': 'subscribe' }, 'owner-token')).toBeNull();
  });
});

describe('a webhook delivery: X-Hub-Signature-256 over the raw bytes', () => {
  const body = Buffer.from('{"object":"page","entry":[{"id":"111","time":1760000000}]}');
  const header = (bytes: Buffer, secret = SECRET) =>
    `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;

  it('accepts exactly these bytes under the app secret', () => {
    expect(metaWebhookSignatureValid(body, header(body), SECRET)).toBe(true);
  });

  it('refuses one changed byte, another secret, a missing or malformed header', () => {
    const changed = Buffer.from(body.toString().replace('111', '112'));
    expect(metaWebhookSignatureValid(changed, header(body), SECRET)).toBe(false);
    expect(metaWebhookSignatureValid(body, header(body, 'another-secret'), SECRET)).toBe(false);
    expect(metaWebhookSignatureValid(body, undefined, SECRET)).toBe(false);
    expect(metaWebhookSignatureValid(body, 'sha1=abc', SECRET)).toBe(false);
    expect(metaWebhookSignatureValid(body, 'sha256=not-hex', SECRET)).toBe(false);
  });

  it('a redelivery of the same bytes has the same dedupe key', () => {
    expect(inboundDedupeKey(body)).toBe(inboundDedupeKey(Buffer.from(body)));
    expect(inboundDedupeKey(body)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('signed_request — deauthorize and data deletion', () => {
  const payload = {
    algorithm: 'HMAC-SHA256',
    issued_at: 1_760_000_000,
    user_id: '10229999000000001',
  };

  it('gives the person’s id and when Meta issued it, when Meta signed it', () => {
    expect(parseMetaSignedRequest(signedRequest(payload), SECRET)).toEqual({
      userId: '10229999000000001',
      issuedAt: 1_760_000_000,
    });
  });

  it('refuses another secret, a changed payload, another algorithm, no user, and junk', () => {
    expect(parseMetaSignedRequest(signedRequest(payload, 'another-secret'), SECRET)).toBeNull();
    const [signature] = signedRequest(payload).split('.');
    const forged = `${signature}.${base64Url(JSON.stringify({ ...payload, user_id: '1' }))}`;
    expect(parseMetaSignedRequest(forged, SECRET)).toBeNull();
    expect(
      parseMetaSignedRequest(signedRequest({ ...payload, algorithm: 'NONE' }), SECRET),
    ).toBeNull();
    expect(
      parseMetaSignedRequest(signedRequest({ algorithm: 'HMAC-SHA256', issued_at: 1 }), SECRET),
    ).toBeNull();
    for (const junk of ['', 'a', 'a.b.c', '!!!.???', `${'a'.repeat(9_000)}.b`]) {
      expect(parseMetaSignedRequest(junk, SECRET), junk.slice(0, 10)).toBeNull();
    }
  });
});

describe('the confirmation code a person is given', () => {
  it('is 24 unambiguous letters and digits, and differs every time', () => {
    const codes = new Set(Array.from({ length: 200 }, () => dataDeletionConfirmationCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Za-km-z2-9]{24}$/);
  });
});
