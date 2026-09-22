import { describe, expect, it } from 'vitest';
import { validateStartupConfiguration, type StartupServiceProfile } from '@brandspace/shared';

/**
 * STAGING IS A PRODUCTION BUILD THAT IS NOT PRODUCTION — Phase 5.
 *
 * THE DEFECT THIS SUITE EXISTS FOR. A Railway staging build sets
 * `NODE_ENV=production` (D-97 — every built Next.js app does), so
 * `assertProductionSafety` runs for staging exactly as it runs for production.
 * It then applied PRODUCTION-ONLY rules to it. A staging service configured
 * precisely as `.railway/railway.ts` and docs/CURRENT-EXECUTION-PHASE-5.md
 * describe — holding its own staging KEK, no managed key, and the development
 * payment adapter's loopback secret — reported itself misconfigured on every one
 * of the four services that hold a key domain:
 *
 *     CUSTOMER_MFA_VAULT_KMS_KEY_ARN is required in production for this service.
 *     BILLING_DEV_WEBHOOK_SECRET must not be set in production …
 *
 * in a deployment that is NOT production, naming variables staging is not meant
 * to have and forbidding one it needs.
 *
 * WHY THAT IS A SECURITY DEFECT AND NOT A NUISANCE. The obvious way to clear
 * "KMS key required" is to paste production's ARN into staging. That is one
 * managed key serving two environments — a staging test able to decrypt
 * production customers' secrets — which is the single thing Phase 5's isolation
 * rules exist to prevent. A message that invites the wrong fix is worse than no
 * message.
 *
 * SO THE CONTRACT IS NOW PER-DEPLOYMENT: production is sealed by KMS, staging by
 * its own KEK, each REQUIRED in its own environment. The forbid half — a service
 * must not hold a key domain it does not use — is unchanged and applies to both,
 * because that is the blast-radius boundary and staging is where people
 * experiment.
 */

const PUBLIC_URLS = {
  PUBLIC_WEB_URL: 'https://staging-web.up.railway.app',
  PUBLIC_API_BASE_URL: 'https://staging-api.up.railway.app',
  PUBLIC_DASHBOARD_BASE_URL: 'https://staging-dash.up.railway.app',
  PUBLIC_ADMIN_BASE_URL: 'https://staging-admin.up.railway.app',
  DASHBOARD_URL: 'https://staging-dash.up.railway.app',
  ADMIN_URL: 'https://staging-admin.up.railway.app',
  API_URL: 'https://staging-api.up.railway.app',
};

const APP_DB = 'postgresql://brandspace_app:pw@db.internal:5432/railway';
const PLATFORM_DB = 'postgresql://brandspace_platform:pw@db.internal:5432/railway';

/** Distinct per name, so the "these must all differ" rules are satisfied. */
const value = (name: string) => `staging-${name}-${'z'.repeat(40)}`;
const arn = (domain: string) => `arn:aws:kms:eu-west-1:000000000000:key/${domain}`;

/**
 * A STAGING service exactly as the blueprint builds it.
 *
 * `NODE_ENV=production` with `APP_ENV=staging` is the invariant under test, not
 * an accident of the fixture: Railway staging IS a production build.
 */
function stagingEnv(profile: StartupServiceProfile): Record<string, string> {
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    APP_ENV: 'staging',
    DATA_REGION: 'eu-west',
    ...PUBLIC_URLS,
  };
  if (profile !== 'web') env['DATABASE_URL'] = APP_DB;
  if (profile === 'dashboard') {
    env['CUSTOMER_SESSION_SECRET'] = value('customer-session');
    env['CUSTOMER_MFA_VAULT_KEK'] = value('customer-mfa-kek');
    env['CLIENT_ORIGIN_STRATEGY'] = 'railway-edge';
  }
  if (profile === 'api') {
    env['DATABASE_PLATFORM_URL'] = PLATFORM_DB;
    env['SECRET_VAULT_KEK'] = value('secret-vault-kek');
    env['SOCIAL_TOKEN_VAULT_KEK'] = value('social-token-kek');
    env['CUSTOMER_MFA_VAULT_KEK'] = value('customer-mfa-kek');
    env['INTERNAL_SERVICE_TOKEN'] = value('internal-service-token');
    env['CLIENT_ORIGIN_STRATEGY'] = 'railway-edge';
  }
  if (profile === 'admin') {
    env['DATABASE_PLATFORM_URL'] = PLATFORM_DB;
    env['PLATFORM_SESSION_SECRET'] = value('platform-session');
    env['SECRET_VAULT_KEK'] = value('secret-vault-kek');
    env['INTERNAL_SERVICE_TOKEN'] = value('internal-service-token');
  }
  if (profile === 'worker') {
    env['SOCIAL_TOKEN_VAULT_KEK'] = value('social-token-kek');
  }
  return env;
}

function check(profile: StartupServiceProfile, extra: Record<string, string> = {}) {
  return validateStartupConfiguration(
    { ...stagingEnv(profile), ...extra } as NodeJS.ProcessEnv,
    profile,
  );
}

const KEY_HOLDERS: StartupServiceProfile[] = ['dashboard', 'api', 'admin', 'worker'];
const EVERY_SERVICE: StartupServiceProfile[] = [...KEY_HOLDERS, 'web'];

describe('a staging service as the blueprint builds it starts clean', () => {
  it.each(EVERY_SERVICE)('%s validates with its staging KEK and no managed key', (profile) => {
    const result = check(profile);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('is recognised as STAGING even though NODE_ENV says production', () => {
    // The invariant the whole phase rests on (D-97). If this ever reads
    // PRODUCTION, every production guard fires against staging and every
    // isolation rule that distinguishes the two is silently void.
    expect(check('dashboard').environment).toBe('STAGING');
  });

  it('is STILL staging when NODE_ENV is production and nothing else says so', () => {
    const result = validateStartupConfiguration(
      { ...stagingEnv('web'), NODE_ENV: 'production', APP_ENV: 'staging' } as NodeJS.ProcessEnv,
      'web',
    );
    expect(result.environment).toBe('STAGING');
  });
});

describe('production is unchanged — it is still sealed by KMS', () => {
  function productionEnv(profile: StartupServiceProfile): Record<string, string> {
    const env: Record<string, string> = { ...stagingEnv(profile), APP_ENV: 'production' };
    // Production supplies the managed keys and the identity that calls them.
    if (profile === 'dashboard') env['CUSTOMER_MFA_VAULT_KMS_KEY_ARN'] = arn('customer-mfa');
    if (profile === 'api') {
      env['SECRET_VAULT_KMS_KEY_ARN'] = arn('secret-vault');
      env['SOCIAL_TOKEN_VAULT_KMS_KEY_ARN'] = arn('social-token');
      env['CUSTOMER_MFA_VAULT_KMS_KEY_ARN'] = arn('customer-mfa');
    }
    if (profile === 'admin') env['SECRET_VAULT_KMS_KEY_ARN'] = arn('secret-vault');
    if (profile === 'worker') env['SOCIAL_TOKEN_VAULT_KMS_KEY_ARN'] = arn('social-token');
    if (profile !== 'web') {
      env['AWS_ACCESS_KEY_ID'] = 'aws-access-key-id-for-unit-tests';
      env['AWS_SECRET_ACCESS_KEY'] = value('aws-secret');
    }
    return env;
  }

  it.each(KEY_HOLDERS)('%s STILL REFUSES production with only a KEK', (profile) => {
    const withoutKms = { ...productionEnv(profile) };
    for (const name of Object.keys(withoutKms)) {
      if (name.endsWith('_KMS_KEY_ARN')) delete withoutKms[name];
    }
    expect(() => validateStartupConfiguration(withoutKms as NodeJS.ProcessEnv, profile)).toThrow(
      /_KMS_KEY_ARN is required in production/,
    );
  });

  it.each(EVERY_SERVICE)('%s starts in production with its managed key', (profile) => {
    expect(() =>
      validateStartupConfiguration(productionEnv(profile) as NodeJS.ProcessEnv, profile),
    ).not.toThrow();
  });
});

describe('the blast-radius boundary holds in staging too', () => {
  /*
   * THE FORBID HALF IS NOT RELAXED. Requiring a different key in staging must
   * not become "staging may hold anything": a service that carries a domain it
   * does not use has the same excess reach there, and staging is precisely where
   * somebody pastes a spare value to make an error go away.
   */
  it('refuses a staging dashboard holding the PLATFORM key domain', () => {
    const result = check('dashboard', { SECRET_VAULT_KEK: value('platform-kek') });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/SECRET_VAULT_KEK/);
  });

  it('refuses a staging worker holding the customer MFA key domain', () => {
    const result = check('worker', { CUSTOMER_MFA_VAULT_KEK: value('mfa-kek') });
    expect(result.ok).toBe(false);
  });

  it('refuses a staging service pointing two domains at ONE key', () => {
    // One key wearing two names collapses two blast radii into one — the whole
    // reason there are three domains (D-136, D-206).
    const shared = value('one-key-for-everything');
    const result = check('api', { SECRET_VAULT_KEK: shared, SOCIAL_TOKEN_VAULT_KEK: shared });
    expect(result.ok).toBe(false);
  });

  it('refuses a staging web service holding any credential at all', () => {
    const result = check('web', { DATABASE_URL: APP_DB });
    expect(result.ok).toBe(false);
  });

  it('refuses a staging dashboard holding the PLATFORM database identity', () => {
    const result = check('dashboard', { DATABASE_PLATFORM_URL: PLATFORM_DB });
    expect(result.ok).toBe(false);
  });
});

describe('the development payment adapter belongs to staging, not production', () => {
  /*
   * `DevelopmentPaymentProvider` calls `assertNotProduction`, so it CONSTRUCTS
   * in staging — which is exactly what Phase 5 asks for: sandbox billing, no
   * live provider (D-204). Its loopback signing secret was nevertheless refused
   * wherever `assertProductionSafety` ran, which includes staging. Staging could
   * not carry the one secret its own billing path needs.
   */
  it('ACCEPTS the loopback billing secret in staging', () => {
    const result = check('api', { BILLING_DEV_WEBHOOK_SECRET: value('billing-loopback') });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('STILL refuses it in production', () => {
    const production = {
      ...stagingEnv('api'),
      APP_ENV: 'production',
      SECRET_VAULT_KMS_KEY_ARN: arn('secret-vault'),
      SOCIAL_TOKEN_VAULT_KMS_KEY_ARN: arn('social-token'),
      CUSTOMER_MFA_VAULT_KMS_KEY_ARN: arn('customer-mfa'),
      AWS_ACCESS_KEY_ID: 'aws-access-key-id-for-unit-tests',
      AWS_SECRET_ACCESS_KEY: value('aws-secret'),
      BILLING_DEV_WEBHOOK_SECRET: value('billing-loopback'),
    };
    expect(() => validateStartupConfiguration(production as NodeJS.ProcessEnv, 'api')).toThrow(
      /BILLING_DEV_WEBHOOK_SECRET must not be set in production/,
    );
  });
});

describe('the message names the deployment it is talking about', () => {
  it('says "in staging" for a staging service, not "in production"', () => {
    /*
     * TRUTHFULNESS WITH A SECURITY CONSEQUENCE. "Required in production" shown
     * to a staging operator invites them to copy the value from the environment
     * the sentence names — and for a key domain that means one managed key
     * serving both, which is the contamination Phase 5 exists to prevent.
     */
    const incomplete = { ...stagingEnv('dashboard') };
    delete incomplete['CUSTOMER_MFA_VAULT_KEK'];
    const result = validateStartupConfiguration(incomplete as NodeJS.ProcessEnv, 'dashboard');

    expect(result.problems.join(' ')).toMatch(/is required in staging/);
    expect(result.problems.join(' ')).not.toMatch(/is required in production/);
  });
});

describe('the client-origin contract reaches staging unchanged', () => {
  it('a staging dashboard and api still require it', () => {
    const dashboard = { ...stagingEnv('dashboard') };
    delete dashboard['CLIENT_ORIGIN_STRATEGY'];
    expect(validateStartupConfiguration(dashboard as NodeJS.ProcessEnv, 'dashboard').ok).toBe(
      false,
    );

    const api = { ...stagingEnv('api') };
    delete api['CLIENT_ORIGIN_STRATEGY'];
    expect(validateStartupConfiguration(api as NodeJS.ProcessEnv, 'api').ok).toBe(false);
  });

  it('staging cannot quietly choose "direct"', () => {
    // Behind Railway's edge the transport peer is a proxy, so `direct` would put
    // every staging caller into one rate-limit bucket — and a contract that
    // differs between staging and production is one staging cannot prove.
    expect(check('dashboard', { CLIENT_ORIGIN_STRATEGY: 'direct' }).ok).toBe(false);
  });

  it('staging carries no hop count under railway-edge', () => {
    expect(check('api', { TRUSTED_PROXY_HOPS: '1' }).ok).toBe(false);
  });
});
