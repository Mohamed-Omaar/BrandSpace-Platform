import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_DEFINITIONS,
  LIVE_SOCIAL_ADDRESS_KEYS,
  publicApiBaseUrlFrom,
  socialPlatformAddresses,
} from '@brandspace/integrations';

/**
 * CONNECTORS A — the addresses the Control Center shows for the owner to
 * register with Meta, TikTok and X: generated from the API's base URL, never
 * typed, and never a vendor entry without an adapter.
 */
describe('socialPlatformAddresses', () => {
  const staging = socialPlatformAddresses('https://api.example.test/');
  const urls = (key: string) =>
    Object.fromEntries(
      staging
        .find((platform) => platform.providerKey === key)!
        .addresses.map((address) => [address.key, address.url]),
    );

  it('Facebook: redirect, webhook, deauthorize and data deletion, on our own API', () => {
    expect(urls('facebook')).toEqual({
      redirectUri: 'https://api.example.test/v1/social/callback/facebook',
      webhookUrl: 'https://api.example.test/v1/social/webhooks/facebook',
      deauthorizeUrl: 'https://api.example.test/v1/social/deauthorize/facebook',
      dataDeletionUrl: 'https://api.example.test/v1/social/data-deletion/facebook',
    });
  });

  it('Instagram is the same Meta app: its own redirect only, pointing at Facebook for the rest', () => {
    expect(urls('instagram')).toEqual({
      redirectUri: 'https://api.example.test/v1/social/callback/instagram',
    });
    expect(staging.find((platform) => platform.providerKey === 'instagram')?.sharesAppWith).toBe(
      'facebook',
    );
  });

  it('TikTok: redirect and webhook; X: redirect', () => {
    expect(urls('tiktok')).toEqual({
      redirectUri: 'https://api.example.test/v1/social/callback/tiktok',
      webhookUrl: 'https://api.example.test/v1/social/webhooks/tiktok',
    });
    expect(urls('x')).toEqual({
      redirectUri: 'https://api.example.test/v1/social/callback/x',
    });
  });

  it('an address is live exactly when its route is in this build (LIVE_SOCIAL_ADDRESS_KEYS)', () => {
    // Step B registered Meta's webhook, deauthorize and data-deletion routes;
    // TikTok's webhook arrives with step C.
    expect(
      Object.fromEntries(
        Object.entries(LIVE_SOCIAL_ADDRESS_KEYS).map(([key, live]) => [key, [...live]]),
      ),
    ).toEqual({
      facebook: ['redirectUri', 'webhookUrl', 'deauthorizeUrl', 'dataDeletionUrl'],
      instagram: ['redirectUri'],
      tiktok: ['redirectUri'],
      x: ['redirectUri'],
    });
    for (const platform of staging) {
      for (const address of platform.addresses) {
        expect(address.live, `${platform.providerKey}.${address.key}`).toBe(
          LIVE_SOCIAL_ADDRESS_KEYS[platform.providerKey].has(address.key),
        );
      }
    }
    const tiktokWebhook = staging
      .find((platform) => platform.providerKey === 'tiktok')!
      .addresses.find((address) => address.key === 'webhookUrl');
    expect(tiktokWebhook?.live).toBe(false);
  });

  it('every live inbound address is a route the API registers', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const source = ['apps/api/src/routes/social.ts', 'apps/api/src/routes/social-inbound.ts']
      .map((file) => readFileSync(path.join(root, file), 'utf8'))
      .join('\n');
    for (const platform of staging) {
      for (const address of platform.addresses.filter((candidate) => candidate.live)) {
        const pathOnly = new URL(address.url).pathname;
        const registered =
          address.key === 'redirectUri'
            ? source.includes("'/v1/social/callback/:provider'")
            : source.includes(`'${pathOnly}'`);
        expect(registered, `${platform.providerKey}.${address.key} ${pathOnly}`).toBe(true);
      }
    }
  });

  it('the Hub lists only providers with an adapter: Meta since step B, and the development double', () => {
    const social = INTEGRATION_DEFINITIONS.filter((definition) => definition.category === 'social');
    expect(social.map((definition) => definition.providerKey)).toEqual([
      'facebook',
      'instagram',
      'mock',
    ]);
    expect(social.every((definition) => definition.adapterAvailable)).toBe(true);
    // One Meta app: Instagram declares no credential and uses Facebook's.
    const instagram = social.find((definition) => definition.providerKey === 'instagram')!;
    expect(instagram.sharesCredentialWith).toBe('facebook');
    expect(instagram.credentialFields).toEqual([]);
  });
});

describe('publicApiBaseUrlFrom — the running environment, never a written-down domain', () => {
  it('uses PUBLIC_API_BASE_URL as the environment states it, without a trailing slash', () => {
    expect(
      publicApiBaseUrlFrom({
        APP_ENV: 'staging',
        PUBLIC_API_BASE_URL: 'https://api-x.up.example.test/',
      }),
    ).toBe('https://api-x.up.example.test');
  });

  it('falls back to the local API only in development', () => {
    expect(publicApiBaseUrlFrom({})).toBe('http://localhost:3003');
    expect(publicApiBaseUrlFrom({ APP_ENV: 'development' })).toBe('http://localhost:3003');
  });

  it('on staging or production with nothing set, answers null rather than guessing', () => {
    expect(publicApiBaseUrlFrom({ APP_ENV: 'staging' })).toBeNull();
    expect(publicApiBaseUrlFrom({ APP_ENV: 'production', PUBLIC_API_BASE_URL: '  ' })).toBeNull();
  });
});
