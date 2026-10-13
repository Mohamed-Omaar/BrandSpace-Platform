import { describe, expect, it } from 'vitest';
import { parseConfigPayload } from '@brandspace/config';

/**
 * CONNECTORS A — the configuration the readiness step adds (D-505).
 *
 * Every platform value is the owner's: the schema carries shapes and bounds,
 * and defaults that keep today's behaviour. Nothing here names a platform's
 * number.
 */

type Publishing = {
  providers: Record<
    string,
    {
      mediaRules: Record<string, Record<string, unknown>>;
      rateLimit: { requestsPerWindow: number; windowSeconds: number } | null;
      mediaByUrl: boolean;
    }
  >;
  dispatch: {
    expiringSoonHours: number;
    publishPollSeconds: number;
    publishPollMaxMinutes: number;
  };
  media: { fetchUrlTtlSeconds: number };
};

const publishing = (payload: unknown) => parseConfigPayload('publishing', payload) as Publishing;

const app = (providerKey: string, overrides: Record<string, unknown> = {}) => ({
  providerKey,
  appId: 'app-1',
  redirectUri: 'https://api.example/v1/social/callback/' + providerKey,
  ...overrides,
});

describe('publishing — the new fields keep today’s behaviour by default', () => {
  it('no media rule, no request budget, bytes not URLs', () => {
    const parsed = publishing({});
    for (const key of ['facebook', 'instagram', 'tiktok', 'linkedin', 'x']) {
      expect(parsed.providers[key]!.mediaRules).toEqual({});
      expect(parsed.providers[key]!.rateLimit).toBeNull();
      expect(parsed.providers[key]!.mediaByUrl).toBe(false);
    }
  });

  it('expiring soon is 24 hours (the constant it replaces); polls every 30 s for an hour', () => {
    expect(publishing({}).dispatch).toMatchObject({
      expiringSoonHours: 24,
      publishPollSeconds: 30,
      publishPollMaxMinutes: 60,
    });
  });

  it('a pre-signed media URL lives 15 minutes unless the owner changes it (D-505 O1)', () => {
    expect(publishing({}).media.fetchUrlTtlSeconds).toBe(900);
    expect(publishing({ media: { fetchUrlTtlSeconds: 300 } }).media.fetchUrlTtlSeconds).toBe(300);
    expect(() => publishing({ media: { fetchUrlTtlSeconds: 30 } })).toThrow();
    expect(() => publishing({ media: { fetchUrlTtlSeconds: 7_200 } })).toThrow();
  });

  it('a media rule is per post kind, every field optional', () => {
    const parsed = publishing({
      providers: {
        instagram: {
          mediaRules: { image: { mimeTypes: ['image/jpeg'], maxBytes: 8_000_000 } },
        },
      },
    });
    expect(parsed.providers['instagram']!.mediaRules['image']).toMatchObject({
      mimeTypes: ['image/jpeg'],
      maxBytes: 8_000_000,
      minWidth: null,
      maxAspectRatio: null,
      maxDurationSeconds: null,
    });
  });

  it('refuses a rule for a post kind that does not exist, and a malformed MIME type', () => {
    expect(() => publishing({ providers: { instagram: { mediaRules: { gif: {} } } } })).toThrow();
    expect(() =>
      publishing({ providers: { instagram: { mediaRules: { image: { mimeTypes: ['jpeg'] } } } } }),
    ).toThrow();
  });

  it('a request budget needs both numbers, positive', () => {
    expect(
      publishing({
        providers: { tiktok: { rateLimit: { requestsPerWindow: 6, windowSeconds: 60 } } },
      }).providers['tiktok']!.rateLimit,
    ).toEqual({ requestsPerWindow: 6, windowSeconds: 60 });
    expect(() =>
      publishing({
        providers: { tiktok: { rateLimit: { requestsPerWindow: 0, windowSeconds: 60 } } },
      }),
    ).toThrow();
  });
});

describe('integrations.social-apps — settings, one Meta app, versioned subject keys', () => {
  const socialApps = (payload: unknown) => parseConfigPayload('integrations.social-apps', payload);

  it('settings are named strings and default to none', () => {
    const parsed = socialApps({
      applications: [app('facebook', { settings: { apiVersion: 'v1' } })],
    }) as {
      applications: { settings: Record<string, string>; sharesCredentialWith: string | null }[];
    };
    expect(parsed.applications[0]!.settings).toEqual({ apiVersion: 'v1' });
    expect(parsed.applications[0]!.sharesCredentialWith).toBeNull();
    expect(() =>
      socialApps({ applications: [app('facebook', { settings: { 'bad key': 'x' } })] }),
    ).toThrow();
  });

  it('instagram may share facebook’s credential (D-505 O3)', () => {
    expect(() =>
      socialApps({
        applications: [app('facebook'), app('instagram', { sharesCredentialWith: 'facebook' })],
      }),
    ).not.toThrow();
  });

  it('refuses sharing with itself, with an absent entry, through a chain, or across app ids', () => {
    expect(() =>
      socialApps({ applications: [app('facebook', { sharesCredentialWith: 'facebook' })] }),
    ).toThrow(/its own/);
    expect(() =>
      socialApps({ applications: [app('instagram', { sharesCredentialWith: 'facebook' })] }),
    ).toThrow(/not configured/);
    expect(() =>
      socialApps({
        applications: [
          app('facebook', { sharesCredentialWith: 'tiktok' }),
          app('instagram', { sharesCredentialWith: 'facebook' }),
          app('tiktok'),
        ],
      }),
    ).toThrow(/holds its own/);
    expect(() =>
      socialApps({
        applications: [
          app('facebook'),
          app('instagram', { appId: 'other', sharesCredentialWith: 'facebook' }),
        ],
      }),
    ).toThrow(/same app id/);
  });

  it('the current subject-hash version must be a listed key, and each version appears once', () => {
    expect(() =>
      socialApps({
        subjectHashKeys: [{ version: 1, secretRef: 'ref-1' }],
        subjectHashVersion: 1,
      }),
    ).not.toThrow();
    expect(() => socialApps({ subjectHashKeys: [], subjectHashVersion: 1 })).toThrow(/listed keys/);
    expect(() =>
      socialApps({
        subjectHashKeys: [
          { version: 1, secretRef: 'a' },
          { version: 1, secretRef: 'b' },
        ],
      }),
    ).toThrow(/once/);
  });
});
