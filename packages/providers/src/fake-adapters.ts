import { createHmac, timingSafeEqual } from 'node:crypto';
import { systemClock } from '@brandspace/shared';
import type {
  AdapterContext,
  AiAdapter,
  ConnectionTestResult,
  EmailAdapter,
  ObservabilityAdapter,
  PaymentAdapter,
  SocialOAuthAdapter,
  StorageAdapter,
} from './contracts';

/**
 * Fake adapters.
 *
 * Deterministic, offline implementations used by tests, local development, and
 * the Control Center's "test connection" button before a real provider is
 * configured. They are NOT stubs waiting to be filled in — they are the
 * mechanism that lets the entire configuration and secret pipeline be exercised
 * end to end without a single real credential.
 *
 * Each one FAILS when a required credential is missing, so "test connection"
 * tells the truth about whether the secret was actually stored and resolvable.
 */

function requireCredentials(
  ctx: AdapterContext,
  keys: readonly string[],
  provider: string,
): ConnectionTestResult | null {
  const missing = keys.filter((key) => !ctx.credentials[key] || ctx.credentials[key] === '');
  if (missing.length === 0) return null;
  return {
    ok: false,
    latencyMs: 0,
    // Names the missing key, never any value.
    message: `${provider}: missing credential(s): ${missing.join(', ')}`,
    // A diagnostic stamp on a connection-test result, not an input to any
    // decision — the same exemption the logger takes for its timestamps.
    checkedAt: systemClock.now().toISOString(),
  };
}

function ok(
  provider: string,
  details?: Record<string, string | number | boolean>,
): ConnectionTestResult {
  return {
    ok: true,
    latencyMs: 12,
    message: `${provider}: connection test succeeded (fake adapter — no external call was made)`,
    // A diagnostic stamp on a connection-test result, not an input to any
    // decision — the same exemption the logger takes for its timestamps.
    checkedAt: systemClock.now().toISOString(),
    ...(details ? { details } : {}),
  };
}

export const fakeAiAdapter: AiAdapter = {
  key: 'fake-ai',
  kind: 'ai',
  requiredCredentialKeys: ['apiKey'],
  async testConnection(ctx) {
    return (
      requireCredentials(ctx, this.requiredCredentialKeys, 'Fake AI') ??
      ok('Fake AI', { models: 2 })
    );
  },
  async listModels() {
    return [
      { key: 'fake-text-fast', displayName: 'Fake Text (fast)' },
      { key: 'fake-text-premium', displayName: 'Fake Text (premium)' },
    ];
  },
  async generateText(input) {
    // Deterministic: the same prompt always yields the same output, so tests
    // never flake on model non-determinism.
    const text = `[fake:${input.modelKey}] ${input.prompt.slice(0, 120)}`;
    return {
      text,
      promptTokens: Math.ceil(input.prompt.length / 4),
      completionTokens: Math.ceil(text.length / 4),
    };
  },
};

export const fakeEmailAdapter: EmailAdapter = {
  key: 'fake-email',
  kind: 'email',
  requiredCredentialKeys: ['apiKey'],
  async testConnection(ctx) {
    return requireCredentials(ctx, this.requiredCredentialKeys, 'Fake Email') ?? ok('Fake Email');
  },
  async send(input) {
    return {
      providerMessageId: `fake-${Buffer.from(input.to).toString('base64url').slice(0, 12)}`,
    };
  },
};

export const fakePaymentAdapter: PaymentAdapter = {
  key: 'fake-payment',
  kind: 'payment',
  requiredCredentialKeys: ['secretKey', 'webhookSecret'],
  async testConnection(ctx) {
    return (
      requireCredentials(ctx, this.requiredCredentialKeys, 'Fake Payment') ?? ok('Fake Payment')
    );
  },
  capabilities() {
    return { supportsProration: true, supportsHostedCheckout: true, supportsMultiCurrency: true };
  },
  verifyWebhookSignature(raw, signature, secret) {
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  },
};

export const fakeStorageAdapter: StorageAdapter = {
  key: 'fake-storage',
  kind: 'storage',
  requiredCredentialKeys: ['accessKeyId', 'secretAccessKey'],
  async testConnection(ctx) {
    return (
      requireCredentials(ctx, this.requiredCredentialKeys, 'Fake Storage') ?? ok('Fake Storage')
    );
  },
  async createUploadUrl(input) {
    return {
      url: `https://fake-storage.local/upload/${encodeURIComponent(input.key)}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  },
  async createDownloadUrl(input) {
    return {
      url: `https://fake-storage.local/download/${encodeURIComponent(input.key)}`,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
    };
  },
};

export const fakeSocialOAuthAdapter: SocialOAuthAdapter = {
  key: 'fake-social',
  kind: 'social_oauth',
  requiredCredentialKeys: ['clientId', 'clientSecret'],
  async testConnection(ctx) {
    return requireCredentials(ctx, this.requiredCredentialKeys, 'Fake Social') ?? ok('Fake Social');
  },
  buildAuthorizationUrl(input, ctx) {
    const url = new URL('https://fake-social.local/oauth/authorize');
    url.searchParams.set('client_id', ctx.credentials['clientId'] ?? 'unset');
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', input.scopes.join(' '));
    return url.toString();
  },
  async exchangeCode() {
    return {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      expiresInSeconds: 3600,
    };
  },
};

export const fakeObservabilityAdapter: ObservabilityAdapter = {
  key: 'fake-observability',
  kind: 'observability',
  requiredCredentialKeys: [],
  async testConnection() {
    return ok('Fake Observability');
  },
  describeTarget(ctx) {
    const endpoint = String(ctx.settings['endpoint'] ?? '');
    try {
      return { endpointHost: endpoint ? new URL(endpoint).host : null, protocol: 'otlp-http' };
    } catch {
      return { endpointHost: null, protocol: 'otlp-http' };
    }
  },
};

/** All fakes, for test setup and for the Control Center's provider list. */
export const ALL_FAKE_ADAPTERS = [
  fakeAiAdapter,
  fakeEmailAdapter,
  fakePaymentAdapter,
  fakeStorageAdapter,
  fakeSocialOAuthAdapter,
  fakeObservabilityAdapter,
] as const;
