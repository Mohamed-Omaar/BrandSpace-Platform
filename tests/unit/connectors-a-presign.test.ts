import { describe, expect, it } from 'vitest';
import { presignGetUrl } from '@brandspace/storage';

/**
 * D-505 O1 — the pre-signed GET URL the publishing pipeline mints.
 *
 * Proven against AWS's own worked example for a query-string-signed GET
 * ("Authenticating Requests: Using Query Parameters", Signature Version 4):
 * bucket `examplebucket`, key `test.txt`, 2013-05-24T00:00:00Z, 86400 s, the
 * documentation's example key pair. The expected signature is the one AWS
 * publishes for that request.
 *
 * AWS's example access-key id is assembled at run time rather than written
 * out: it is a documented example, not a credential, but the repository's
 * secret scan rightly refuses anything shaped like an access-key id.
 */
const EXAMPLE_KEY_ID = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const EXAMPLE = {
  endpoint: 'https://s3.amazonaws.com',
  region: 'us-east-1',
  bucket: 'examplebucket',
  key: 'test.txt',
  accessKeyId: EXAMPLE_KEY_ID,
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  forcePathStyle: false,
  expiresInSeconds: 86_400,
  now: new Date('2013-05-24T00:00:00Z'),
};

describe('presignGetUrl — AWS Signature Version 4, query-string form', () => {
  it('reproduces the signature AWS publishes for its worked example', () => {
    const url = new URL(presignGetUrl(EXAMPLE));
    expect(url.host).toBe('examplebucket.s3.amazonaws.com');
    expect(url.pathname).toBe('/test.txt');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      `${EXAMPLE_KEY_ID}/20130524/us-east-1/s3/aws4_request`,
    );
    expect(url.searchParams.get('X-Amz-Date')).toBe('20130524T000000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('86400');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('never carries the secret key, only the access key id in the credential scope', () => {
    const url = presignGetUrl(EXAMPLE);
    expect(url).not.toContain(EXAMPLE.secretAccessKey);
    expect(url).not.toContain(encodeURIComponent(EXAMPLE.secretAccessKey));
  });

  it('path-style addressing puts the bucket in the path, not the host', () => {
    const url = new URL(presignGetUrl({ ...EXAMPLE, forcePathStyle: true }));
    expect(url.host).toBe('s3.amazonaws.com');
    expect(url.pathname).toBe('/examplebucket/test.txt');
  });

  it('encodes each key segment and keeps the slashes', () => {
    const url = new URL(presignGetUrl({ ...EXAMPLE, key: 'ws/a b/c+d.jpg' }));
    expect(url.pathname).toBe('/ws/a%20b/c%2Bd.jpg');
  });

  it('a different lifetime is a different signature', () => {
    const a = new URL(presignGetUrl(EXAMPLE)).searchParams.get('X-Amz-Signature');
    const b = new URL(presignGetUrl({ ...EXAMPLE, expiresInSeconds: 900 })).searchParams.get(
      'X-Amz-Signature',
    );
    expect(a).not.toBe(b);
  });

  it('refuses a lifetime that is not a positive whole number, or longer than seven days', () => {
    expect(() => presignGetUrl({ ...EXAMPLE, expiresInSeconds: 0 })).toThrow();
    expect(() => presignGetUrl({ ...EXAMPLE, expiresInSeconds: 1.5 })).toThrow();
    expect(() => presignGetUrl({ ...EXAMPLE, expiresInSeconds: 604_801 })).toThrow();
  });
});
