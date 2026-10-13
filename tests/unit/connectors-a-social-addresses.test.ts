import { describe, expect, it } from 'vitest';
import { INTEGRATION_DEFINITIONS, socialPlatformAddresses } from '@brandspace/integrations';

/**
 * CONNECTORS A — the addresses the Control Center shows for the owner to
 * register with Meta, TikTok and X: generated from the API's base URL, never
 * typed, and never a vendor entry without an adapter.
 */
describe('socialPlatformAddresses', () => {
  const staging = socialPlatformAddresses('https://api-staging.brandspace.cc/');
  const urls = (key: string) =>
    Object.fromEntries(
      staging
        .find((platform) => platform.providerKey === key)!
        .addresses.map((address) => [address.key, address.url]),
    );

  it('Facebook: redirect, webhook, deauthorize and data deletion, on our own API', () => {
    expect(urls('facebook')).toEqual({
      redirectUri: 'https://api-staging.brandspace.cc/v1/social/callback/facebook',
      webhookUrl: 'https://api-staging.brandspace.cc/v1/social/webhooks/facebook',
      deauthorizeUrl: 'https://api-staging.brandspace.cc/v1/social/deauthorize/facebook',
      dataDeletionUrl: 'https://api-staging.brandspace.cc/v1/social/data-deletion/facebook',
    });
  });

  it('Instagram is the same Meta app: its own redirect only, pointing at Facebook for the rest', () => {
    expect(urls('instagram')).toEqual({
      redirectUri: 'https://api-staging.brandspace.cc/v1/social/callback/instagram',
    });
    expect(staging.find((platform) => platform.providerKey === 'instagram')?.sharesAppWith).toBe(
      'facebook',
    );
  });

  it('TikTok: redirect and webhook; X: redirect', () => {
    expect(urls('tiktok')).toEqual({
      redirectUri: 'https://api-staging.brandspace.cc/v1/social/callback/tiktok',
      webhookUrl: 'https://api-staging.brandspace.cc/v1/social/webhooks/tiktok',
    });
    expect(urls('x')).toEqual({
      redirectUri: 'https://api-staging.brandspace.cc/v1/social/callback/x',
    });
  });

  it('only the callback is live in step A; the inbound routes arrive in step B', () => {
    for (const platform of staging) {
      for (const address of platform.addresses) {
        expect(address.live, `${platform.providerKey}.${address.key}`).toBe(
          address.key === 'redirectUri',
        );
      }
    }
  });

  it('adds no vendor entry to the Hub — the Hub lists only providers with an adapter', () => {
    const social = INTEGRATION_DEFINITIONS.filter((definition) => definition.category === 'social');
    expect(social.map((definition) => definition.providerKey)).toEqual(['mock']);
  });
});
