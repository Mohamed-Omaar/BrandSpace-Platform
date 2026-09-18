import { describe, expect, it } from 'vitest';
import {
  capabilitiesFor,
  createConnectorRegistry,
  FAILURE_BEHAVIOUR,
  MockSocialConnectorAdapter,
  parsePublishingPolicy,
  PROVIDER_CONFIG_KEYS,
  providerForPlatformKey,
  SOCIAL_PROVIDERS,
  type PublishingPolicy,
} from '@brandspace/social-connectors';

/**
 * The connector CONTRACT, exercised against every provider.
 *
 * WHY EVERY ADAPTER RUNS THE SAME TESTS. "Capabilities are declared, not assumed
 * equal" (docs/SOCIAL-INTEGRATIONS.md §1.7) cuts both ways: what each platform
 * CAN do differs, and how every adapter BEHAVES must not. A suite that tested
 * one adapter would pass on the day a second one returned a different shape for
 * a failure, and the pipeline would then branch on a provider name somewhere.
 *
 * NO NETWORK, NO CLOCK, NO RANDOMNESS. Every assertion below is a pure function
 * of its input, which is what makes a publishing test something other than a
 * source of intermittent red builds.
 */

function everyProviderEnabled(overrides: Record<string, unknown> = {}): PublishingPolicy {
  const capability = {
    enabled: true,
    postKinds: ['text', 'image'],
    maxBodyCharacters: 1_000,
    maxHashtags: 10,
    maxMediaItems: 4,
    supportsFirstComment: false,
    supportsDelete: false,
    supportsNativeScheduling: false,
    supportsPostLookup: true,
    scopes: ['scope.one'],
    targetKind: 'profile',
    ...overrides,
  };
  return parsePublishingPolicy({
    providers: Object.fromEntries(
      Object.values(PROVIDER_CONFIG_KEYS).map((key) => [key, capability]),
    ),
  });
}

const policy = everyProviderEnabled();
const registry = createConnectorRegistry({ policy, environment: 'DEVELOPMENT' });

const application = {
  appId: 'test-only-app',
  clientSecret: 'test-only-secret-not-real',
  redirectUri: 'https://api-staging.brandspace.cc/v1/social/callback/x',
};

describe('every provider in this phase has an adapter', () => {
  it('covers Meta (Facebook and Instagram), TikTok, LinkedIn and X', () => {
    expect([...SOCIAL_PROVIDERS]).toEqual(['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'LINKEDIN', 'X']);
    for (const provider of SOCIAL_PROVIDERS) {
      expect(registry.get(provider).provider).toBe(provider);
    }
  });

  it('maps a content platform key to its provider, and back', () => {
    expect(providerForPlatformKey('instagram')).toBe('INSTAGRAM');
    expect(providerForPlatformKey('LinkedIn')).toBe('LINKEDIN');
    expect(providerForPlatformKey('x')).toBe('X');
    // An unknown platform key yields NULL rather than a guess: publishing a
    // variant written for a platform we cannot identify is worse than not.
    expect(providerForPlatformKey('threads')).toBeNull();
  });

  it('a DISABLED provider cannot be reached at all', () => {
    const disabled = createConnectorRegistry({
      policy: parsePublishingPolicy({ providers: { x: { enabled: false } } }),
      environment: 'DEVELOPMENT',
    });
    expect(() => disabled.get('X')).toThrow();
    expect(disabled.enabledProviders()).not.toContain('X');
  });

  it('A PRODUCTION ENVIRONMENT GETS NO MOCK — it fails loudly instead', () => {
    /*
     * The alternative is a deployment that comes up healthy, accepts publish
     * jobs, marks them PUBLISHED and stores an external id pointing at nothing.
     * The customer would believe they had posted.
     */
    const production = createConnectorRegistry({ policy, environment: 'PRODUCTION' });
    expect(production.enabledProviders()).toEqual([]);
    for (const provider of SOCIAL_PROVIDERS) {
      expect(() => production.get(provider)).toThrow();
    }
  });
});

describe('the authorization URL', () => {
  for (const provider of SOCIAL_PROVIDERS) {
    it(`${provider}: carries state and PKCE, and NEVER the client secret`, () => {
      const url = new URL(
        registry.get(provider).buildAuthorizationUrl({
          state: 'opaque-state-value',
          codeChallenge: 'challenge-value',
          scopes: ['scope.one'],
          application,
        }),
      );
      expect(url.searchParams.get('state')).toBe('opaque-state-value');
      expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('client_id')).toBe(application.appId);
      expect(url.searchParams.get('redirect_uri')).toBe(application.redirectUri);
      // The one assertion that matters: this string goes to a browser.
      expect(url.toString()).not.toContain(application.clientSecret);
    });
  }
});

describe('publishing is deterministic and honours declared capabilities', () => {
  const credentials = { accessToken: 'mock-access-token', refreshToken: null };

  it('THE SAME IDEMPOTENCY KEY YIELDS THE SAME EXTERNAL POST ID', async () => {
    /*
     * Modelling what a real provider's idempotency token buys. Without this the
     * duplicate-prevention tests would be asserting something the mock does not
     * actually do.
     */
    const adapter = registry.get('LINKEDIN');
    const request = {
      externalAccountId: 'acct-1',
      body: 'hello',
      hashtags: [],
      firstComment: null,
      media: [],
      idempotencyKey: 'stable-key',
    };
    const first = await adapter.publish({ request, credentials });
    const second = await adapter.publish({ request, credentials });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.externalPostId).toBe(second.externalPostId);
    }
  });

  it('A DIFFERENT KEY IS A DIFFERENT POST', async () => {
    const adapter = registry.get('LINKEDIN');
    const base = {
      externalAccountId: 'acct-1',
      body: 'hello',
      hashtags: [],
      firstComment: null,
      media: [],
    };
    const a = await adapter.publish({
      request: { ...base, idempotencyKey: 'key-a' },
      credentials,
    });
    const b = await adapter.publish({
      request: { ...base, idempotencyKey: 'key-b' },
      credentials,
    });
    if (a.ok && b.ok) expect(a.externalPostId).not.toBe(b.externalPostId);
  });

  it('A CAPTION OVER THE DECLARED CEILING IS REJECTED, not silently truncated', async () => {
    const adapter = registry.get('INSTAGRAM');
    const outcome = await adapter.publish({
      request: {
        externalAccountId: 'acct-1',
        body: 'x'.repeat(adapter.capabilities.maxBodyCharacters + 1),
        hashtags: [],
        firstComment: null,
        media: [],
        idempotencyKey: 'too-long',
      },
      credentials,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureClass).toBe('CONTENT_REJECTED');
  });

  it('AN UNSUPPORTED ACTION FAILS CLEARLY, as UNSUPPORTED', async () => {
    /*
     * Not as a content error, and not by letting the platform reject it. The
     * customer needs to know the platform cannot do this at all, which is a
     * different fact from "this particular post was refused".
     */
    const adapter = registry.get('TIKTOK');
    expect(adapter.capabilities.supportsFirstComment).toBe(false);
    const outcome = await adapter.publish({
      request: {
        externalAccountId: 'acct-1',
        body: 'hello',
        hashtags: [],
        firstComment: 'a first comment',
        media: [],
        idempotencyKey: 'first-comment',
      },
      credentials,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureClass).toBe('UNSUPPORTED');
  });

  it('a failure NEVER carries the provider raw body — only a bounded summary', async () => {
    const adapter = registry.get('X');
    const outcome = await adapter.publish({
      request: {
        externalAccountId: 'acct-1',
        body: 'a very specific caption nobody should see echoed back',
        hashtags: [],
        firstComment: null,
        media: [],
        idempotencyKey: 'reject-content',
      },
      credentials,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.safeSummary.length).toBeLessThanOrEqual(500);
      expect(outcome.safeSummary).not.toContain('a very specific caption');
      // The CODE is ours and stable; the provider's own code is separate.
      expect(outcome.failureCode).toMatch(/^mock\./);
    }
  });

  it('every mock exposes the same failure SHAPE, whichever provider it is', async () => {
    for (const provider of SOCIAL_PROVIDERS) {
      const outcome = await registry.get(provider).publish({
        request: {
          externalAccountId: 'acct-1',
          body: 'hello',
          hashtags: [],
          firstComment: null,
          media: [],
          idempotencyKey: 'rate-limit',
        },
        credentials,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failureClass).toBe('RATE_LIMITED');
        expect(outcome.retryAfterSeconds).toBe(60);
        expect(typeof outcome.safeSummary).toBe('string');
      }
    }
  });
});

describe('error classification never guesses', () => {
  it('an unrecognised error is UNKNOWN, and UNKNOWN is not retryable', () => {
    /*
     * The rule that prevents a duplicate post: an unknown failure we resend is
     * how a caption goes out twice, so `UNKNOWN` is neither retryable nor
     * indeterminate. It surfaces to a human, which is the honest outcome.
     */
    const adapter = registry.get('FACEBOOK');
    expect(adapter.classifyError(new Error('something we have never seen'))).toBe('UNKNOWN');
    expect(FAILURE_BEHAVIOUR.UNKNOWN.retryable).toBe(false);
    expect(FAILURE_BEHAVIOUR.UNKNOWN.indeterminate).toBe(false);
  });

  it('recognises the four classes it can be sure about', () => {
    const adapter = registry.get('FACEBOOK');
    expect(adapter.classifyError(new Error('token revoked'))).toBe('AUTH_REVOKED');
    expect(adapter.classifyError(new Error('token expired'))).toBe('AUTH_EXPIRED');
    expect(adapter.classifyError(new Error('request timeout'))).toBe('TIMEOUT');
    expect(adapter.classifyError(new Error('rate exceeded'))).toBe('RATE_LIMITED');
  });
});

describe('the failure taxonomy is complete and internally consistent', () => {
  it('a class that needs reconnection is never automatically retried', () => {
    /*
     * Retrying a revoked authorization asks the same question and gets the same
     * answer five times, while the customer waits for a post that cannot go.
     */
    for (const [failureClass, behaviour] of Object.entries(FAILURE_BEHAVIOUR)) {
      if (behaviour.needsReconnect && failureClass !== 'AUTH_EXPIRED') {
        expect(behaviour.retryable, `${failureClass} must not auto-retry`).toBe(false);
      }
    }
  });

  it('a class that cannot usefully be retried by hand is not offered a button', () => {
    for (const [failureClass, behaviour] of Object.entries(FAILURE_BEHAVIOUR)) {
      if (behaviour.needsReconnect) {
        expect(
          behaviour.manualRetryUseful,
          `${failureClass} needs a reconnection, not a retry`,
        ).toBe(false);
      }
    }
  });

  it('DUPLICATE_CONTENT is treated as indeterminate, never as a reason to send again', () => {
    expect(FAILURE_BEHAVIOUR.DUPLICATE_CONTENT.indeterminate).toBe(true);
    expect(FAILURE_BEHAVIOUR.DUPLICATE_CONTENT.retryable).toBe(false);
  });

  it('TIMEOUT is indeterminate — the request left and the answer did not return', () => {
    expect(FAILURE_BEHAVIOUR.TIMEOUT.indeterminate).toBe(true);
  });
});

describe('capabilities come from configuration and nothing else', () => {
  it('a changed ceiling changes the adapter, with no code edit', () => {
    const tighter = everyProviderEnabled({ maxBodyCharacters: 280 });
    const tightened = createConnectorRegistry({ policy: tighter, environment: 'DEVELOPMENT' });
    expect(tightened.get('X').capabilities.maxBodyCharacters).toBe(280);
    expect(capabilitiesFor(tighter, 'X').maxBodyCharacters).toBe(280);
  });

  it('DEFAULTS ARE DISABLED — a provider is off until an owner turns it on', () => {
    /*
     * The safe default. A newly deployed environment must not offer a
     * connection nobody has configured an application for.
     */
    const untouched = parsePublishingPolicy({});
    for (const provider of SOCIAL_PROVIDERS) {
      expect(capabilitiesFor(untouched, provider).enabled).toBe(false);
    }
  });

  it('an explicit override applies to exactly one provider', () => {
    const mixed = parsePublishingPolicy({
      providers: { x: { enabled: true, maxBodyCharacters: 280 } },
    });
    expect(capabilitiesFor(mixed, 'X').enabled).toBe(true);
    expect(capabilitiesFor(mixed, 'LINKEDIN').enabled).toBe(false);
  });
});

describe('a directly constructed adapter behaves like a registered one', () => {
  it('honours the capabilities it is handed', async () => {
    const adapter = new MockSocialConnectorAdapter('X', {
      ...capabilitiesFor(policy, 'X'),
      supportsFirstComment: true,
    });
    const outcome = await adapter.publish({
      request: {
        externalAccountId: 'acct-1',
        body: 'hello',
        hashtags: [],
        firstComment: 'now supported',
        media: [],
        idempotencyKey: 'first-comment-allowed',
      },
      credentials: { accessToken: 'mock', refreshToken: null },
    });
    expect(outcome.ok).toBe(true);
  });
});
