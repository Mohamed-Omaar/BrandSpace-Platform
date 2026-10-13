import { describe, expect, it } from 'vitest';
import { REDACTED, redact } from '@brandspace/shared';

/**
 * CONNECTORS A (W13) — the token shapes a real social platform puts where the
 * key-name rule cannot see them. The values below are made up; none is a
 * real credential.
 */
const fakeMeta = `EAA${'B'.repeat(40)}`;
const fakeTikTokAccess = `act.${'x1'.repeat(20)}`;
const fakeTikTokRefresh = `rft.${'y2'.repeat(20)}`;

describe('W13 — query-string credentials keep their name and lose their value', () => {
  it('access_token, client_secret, fb_exchange_token, refresh_token and input_token', () => {
    for (const name of [
      'access_token',
      'client_secret',
      'fb_exchange_token',
      'refresh_token',
      'input_token',
    ]) {
      const line = `GET https://graph.example.test/v1/me?fields=id&${name}=abc123secret&x=1 failed`;
      const out = redact(line) as string;
      expect(out, name).toContain(`${name}=${REDACTED}`);
      expect(out, name).not.toContain('abc123secret');
      expect(out, name).toContain('&x=1');
    }
  });

  it('a long authorization code is redacted; a short error code is not', () => {
    const long = redact(`https://api.example.test/cb?code=${'c'.repeat(40)}&state=s`) as string;
    expect(long).toContain(`code=${REDACTED}`);
    expect(redact('https://api.example.test/cb?code=403')).toBe(
      'https://api.example.test/cb?code=403',
    );
  });

  it('a pre-signed media URL keeps everything but its signature (D-505 O1)', () => {
    const url =
      'https://bucket.r2.example.test/ws/a.jpg?X-Amz-Expires=900&X-Amz-Signature=deadbeefcafe';
    const out = redact(url) as string;
    expect(out).toContain(`X-Amz-Signature=${REDACTED}`);
    expect(out).toContain('X-Amz-Expires=900');
    expect(out).not.toContain('deadbeefcafe');
  });
});

describe('W13 — platform token shapes anywhere in a message', () => {
  it('a Meta access token and TikTok access and refresh tokens', () => {
    const message = `upstream said ${fakeMeta} / ${fakeTikTokAccess} / ${fakeTikTokRefresh}`;
    const out = redact(message) as string;
    expect(out).not.toContain(fakeMeta);
    expect(out).not.toContain(fakeTikTokAccess);
    expect(out).not.toContain(fakeTikTokRefresh);
  });

  it('ordinary words that start the same way are left alone', () => {
    expect(redact('EAA is short; act. one; rft. two')).toBe('EAA is short; act. one; rft. two');
  });

  it('inside an Error message too', () => {
    const out = redact(new Error(`fetch failed: ...?access_token=${fakeMeta}`)) as {
      message: string;
    };
    expect(out.message).not.toContain(fakeMeta);
  });
});
