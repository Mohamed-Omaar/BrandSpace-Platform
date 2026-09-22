import { afterEach, describe, expect, it } from 'vitest';
import {
  ClientOriginConfigurationError,
  MAX_TRUSTED_PROXY_HOPS,
  clientOriginStrategy,
  parseTrustedProxyHops,
  requestContext,
  validateStartupConfiguration,
} from '@brandspace/shared';

/**
 * PRODUCTION CANNOT START WITHOUT A CLIENT-ORIGIN CONTRACT — Phase 4, review fix.
 *
 * THE STATE THIS EXISTS TO MAKE IMPOSSIBLE. The live deployment was verified to
 * have NO origin configuration on either `dashboard` or `api`. Under the reading
 * this code shipped with, that meant `requestContext` returned no address, and
 * `AuthRateLimiter.enforce` skipped any dimension whose subject was undefined —
 * so every unauthenticated customer request in production ran with the
 * per-ACCOUNT ceiling only and NO per-source ceiling at all. Nothing failed,
 * nothing logged, and the deployment looked entirely healthy. That is the worst
 * shape a security control can have: absent and indistinguishable from present.
 *
 * SO THERE ARE TWO LOCKS, AND BOTH ARE ASSERTED HERE:
 *
 *   1. START-UP — a production `dashboard` or `api` with no declared strategy
 *      refuses to boot, so the state above cannot be reached by omission.
 *   2. PER REQUEST — if a production request still arrives with no establishable
 *      origin, the limiter REFUSES it generically rather than proceeding with no
 *      source budget. (Asserted against the real limiter in
 *      `tests/isolation/phase4-auth-abuse.test.ts`.)
 *
 * ONLY THE TWO CONSUMERS. `web`, `admin` and `worker` never establish a
 * customer's source address; requiring it of them would be configuration nobody
 * reads, which is configuration that drifts.
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL);
});

/** A production environment that is complete APART from the thing under test. */
function productionEnv(profile: 'dashboard' | 'api' | 'web' | 'admin' | 'worker') {
  const base: Record<string, string> = {
    NODE_ENV: 'production',
    APP_ENV: 'production',
    DATA_REGION: 'eu-west',
    PUBLIC_WEB_URL: 'https://brandspace.example',
    PUBLIC_DASHBOARD_BASE_URL: 'https://app.brandspace.example',
    PUBLIC_ADMIN_BASE_URL: 'https://admin.brandspace.example',
    PUBLIC_API_BASE_URL: 'https://api.brandspace.example',
    DASHBOARD_URL: 'https://app.brandspace.example',
    ADMIN_URL: 'https://admin.brandspace.example',
    API_URL: 'https://api.brandspace.example',
  };
  const appDb = 'postgresql://brandspace_app:pw@db.internal:5432/railway';
  const platformDb = 'postgresql://brandspace_platform:pw@db.internal:5432/railway';
  const secret = (name: string) => `${name}-${'x'.repeat(48)}`;

  // Each key domain travels with its own KMS key (D-136, D-206); the contract
  // refuses one key wearing three names, so these are distinct on purpose.
  const arn = (domain: string) => `arn:aws:kms:eu-west-1:000000000000:key/${domain}`;

  /*
   * A KMS key is reached with an identity, so every profile that holds an ARN
   * holds these too. `web` holds nothing at all and must not.
   */
  if (profile !== 'web') {
    base['DATABASE_URL'] = appDb;
    base['AWS_ACCESS_KEY_ID'] = 'AKIA7SDFKJHG3MNBVCXZ';
    base['AWS_SECRET_ACCESS_KEY'] = secret('aws');
  }
  if (profile === 'dashboard') {
    base['CUSTOMER_SESSION_SECRET'] = secret('customer');
    base['CUSTOMER_MFA_KEK'] = secret('mfa');
    base['CUSTOMER_MFA_VAULT_KMS_KEY_ARN'] = arn('customer-mfa');
  }
  if (profile === 'api') {
    base['DATABASE_PLATFORM_URL'] = platformDb;
    base['SECRET_VAULT_KEK'] = secret('vault');
    base['SOCIAL_TOKEN_KEK'] = secret('social');
    base['CUSTOMER_MFA_KEK'] = secret('mfa');
    base['SECRET_VAULT_KMS_KEY_ARN'] = arn('secret-vault');
    base['SOCIAL_TOKEN_VAULT_KMS_KEY_ARN'] = arn('social-token');
    base['CUSTOMER_MFA_VAULT_KMS_KEY_ARN'] = arn('customer-mfa');
    base['INTERNAL_SERVICE_TOKEN'] = secret('internal');
  }
  if (profile === 'admin') {
    base['DATABASE_PLATFORM_URL'] = platformDb;
    base['PLATFORM_SESSION_SECRET'] = secret('platform');
    base['SECRET_VAULT_KEK'] = secret('vault');
    base['SECRET_VAULT_KMS_KEY_ARN'] = arn('secret-vault');
  }
  if (profile === 'worker') {
    base['SOCIAL_TOKEN_KEK'] = secret('social');
    base['SOCIAL_TOKEN_VAULT_KMS_KEY_ARN'] = arn('social-token');
  }
  return base as NodeJS.ProcessEnv;
}

function startup(profile: 'dashboard' | 'api' | 'web' | 'admin' | 'worker', extra = {}) {
  return () =>
    validateStartupConfiguration(
      { ...productionEnv(profile), ...extra } as NodeJS.ProcessEnv,
      profile,
    );
}

describe('a production consumer refuses to start without the contract', () => {
  it('DASHBOARD fails when CLIENT_ORIGIN_STRATEGY is absent', () => {
    expect(startup('dashboard')).toThrow(/CLIENT_ORIGIN_STRATEGY is required in production/);
  });

  it('API fails when CLIENT_ORIGIN_STRATEGY is absent', () => {
    expect(startup('api')).toThrow(/CLIENT_ORIGIN_STRATEGY is required in production/);
  });

  it('the message says what to set, because an operator reads it in a crash loop', () => {
    expect(startup('dashboard')).toThrow(/railway-edge/);
  });

  it('both start once the contract is declared', () => {
    expect(startup('dashboard', { CLIENT_ORIGIN_STRATEGY: 'railway-edge' })).not.toThrow();
    expect(startup('api', { CLIENT_ORIGIN_STRATEGY: 'railway-edge' })).not.toThrow();
  });
});

describe('services that never establish a source address do not require it', () => {
  it.each(['web', 'admin', 'worker'] as const)('%s starts without it', (profile) => {
    expect(startup(profile)).not.toThrow();
  });
});

describe('malformed configuration is refused, never coerced', () => {
  it('rejects a strategy that is not one of the three', () => {
    expect(startup('dashboard', { CLIENT_ORIGIN_STRATEGY: 'trust-everything' })).toThrow();
  });

  it('rejects an empty strategy exactly as firmly as an absent one', () => {
    // The schema's enum refuses it before the contract check is reached, so the
    // sentence differs from the absent case. What matters is that neither starts.
    expect(startup('dashboard', { CLIENT_ORIGIN_STRATEGY: '' })).toThrow();
  });

  it('REFUSES "direct" in production, where it means one bucket for everyone', () => {
    // Behind any balancer the transport peer is the balancer, so `direct` would
    // put every customer in the world into a single rate-limit subject.
    expect(startup('dashboard', { CLIENT_ORIGIN_STRATEGY: 'direct' })).toThrow(
      /must not be "direct"/,
    );
  });

  it.each([
    ['an empty hop count', ''],
    ['a trailing-garbage hop count', '1abc'],
    ['a fractional hop count', '1.5'],
    ['a negative hop count', '-1'],
    ['a zero hop count', '0'],
    ['an excessive hop count', '99'],
    ['a hexadecimal hop count', '0x1'],
    ['a spaced pair', '1 2'],
  ])('xff-hops rejects %s', (_label, hops) => {
    expect(
      startup('dashboard', { CLIENT_ORIGIN_STRATEGY: 'xff-hops', TRUSTED_PROXY_HOPS: hops }),
    ).toThrow();
  });

  it('xff-hops accepts a well-formed hop count', () => {
    expect(
      startup('dashboard', { CLIENT_ORIGIN_STRATEGY: 'xff-hops', TRUSTED_PROXY_HOPS: '1' }),
    ).not.toThrow();
  });

  it('the parser itself throws rather than returning a safe-looking number', () => {
    /*
     * THE OLD READER COERCED ALL OF THESE TO 0, and 0 means "do not read the
     * header at all" — so a typo silently disabled the per-source limiter and
     * looked exactly like a working configuration.
     */
    for (const raw of ['', '   ', '1abc', '1.5', '-3', 'lots', '0']) {
      expect(() => parseTrustedProxyHops(raw)).toThrow(ClientOriginConfigurationError);
    }
    expect(() => parseTrustedProxyHops(String(MAX_TRUSTED_PROXY_HOPS + 1))).toThrow(
      ClientOriginConfigurationError,
    );
    expect(parseTrustedProxyHops('1')).toBe(1);
    expect(parseTrustedProxyHops(String(MAX_TRUSTED_PROXY_HOPS))).toBe(MAX_TRUSTED_PROXY_HOPS);
  });

  it('an unknown strategy throws at the reader rather than falling back', () => {
    expect(() =>
      clientOriginStrategy({ CLIENT_ORIGIN_STRATEGY: 'nearly-right' } as NodeJS.ProcessEnv),
    ).toThrow(ClientOriginConfigurationError);
  });
});

/**
 * THE RAILWAY READING — the leftmost entry, because the edge wrote it.
 *
 * Railway's edge proxy strips a client-supplied `X-Forwarded-For` and writes the
 * real connecting address FIRST. A right-counted hop index cannot be correct
 * there at all: Railway adds a variable number of internal hops depending on
 * whether the CDN layer is in the routing path, so any fixed count is wrong
 * some of the time — which is the worst way for a rate limiter to be wrong.
 */
describe('the railway-edge strategy', () => {
  const RAILWAY = { CLIENT_ORIGIN_STRATEGY: 'railway-edge' } as NodeJS.ProcessEnv;

  it('takes the leftmost entry, which the edge wrote', () => {
    expect(requestContext({ headers: { 'x-forwarded-for': '203.0.113.9' }, env: RAILWAY }).ip).toBe(
      '203.0.113.9',
    );
  });

  it('is UNMOVED by however many internal hops Railway adds', () => {
    // One hop, then two: the CDN path adds one and the answer must not change.
    expect(
      requestContext({ headers: { 'x-forwarded-for': '203.0.113.9, 100.64.0.1' }, env: RAILWAY })
        .ip,
    ).toBe('203.0.113.9');
    expect(
      requestContext({
        headers: { 'x-forwarded-for': '203.0.113.9, 100.64.0.1, 100.64.0.2' },
        env: RAILWAY,
      }).ip,
    ).toBe('203.0.113.9');
  });

  it('GIVES A DASHBOARD SERVER ACTION AN ADDRESS, with no socket to fall back on', () => {
    // The path every customer browser takes. A Next.js server action sees
    // headers and no transport peer; this must still yield a limiter subject.
    const context = requestContext({ headers: { 'x-forwarded-for': '203.0.113.9' }, env: RAILWAY });
    expect(context.ip).toBe('203.0.113.9');
    expect(context.ip?.trim()).not.toBe('');
  });

  it('falls back to the socket peer when the request did not come through the edge', () => {
    expect(requestContext({ headers: {}, socketAddress: '10.0.0.1', env: RAILWAY }).ip).toBe(
      '10.0.0.1',
    );
  });

  it('reports nothing rather than inventing an address when there is neither', () => {
    // Honest — and in production the limiter turns this into a refusal rather
    // than letting the request proceed with no source budget.
    expect(requestContext({ headers: {}, env: RAILWAY }).ip).toBeUndefined();
  });
});
