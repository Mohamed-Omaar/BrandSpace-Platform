import { describe, expect, it } from 'vitest';

import {
  assertNotProduction,
  currentEnvironment,
  DevelopmentOnlyInProductionError,
  isProduction,
  parseEnv,
  validateStartupConfiguration,
} from '@brandspace/shared';
import { MockProviderAdapter } from '@brandspace/ai-gateway';
import { INTEGRATION_DEFINITIONS, selectionRefusal } from '@brandspace/integrations';

/**
 * PRODUCTION-MODE NEGATIVE TESTS — Phase 10 §28.
 *
 * These are exit gates rather than coverage. Every one of them asserts that
 * something REFUSES, and each refusal replaces a specific way the platform
 * could come up looking healthy while being wrong:
 *
 *   - the deterministic AI provider serving invented marketing copy as though
 *     a model had written it,
 *   - the outbox email provider recording `status: 'SENT'` for a verification
 *     link nobody will ever receive,
 *   - three key domains collapsed into one shared key,
 *   - a secret copied straight out of `.env.example`.
 *
 * WHY THE ENVIRONMENT IS PASSED RATHER THAN MUTATED. `process.env` is global,
 * and a test that sets `APP_ENV=production` and throws before restoring it
 * poisons every test that runs afterwards in the same worker. Every helper
 * under test takes its source explicitly for exactly this reason; the two that
 * cannot (the constructors) are exercised through a save-and-restore that runs
 * in a `finally`.
 */

const PRODUCTION = { APP_ENV: 'production' } as const;

function inProduction<T>(work: () => T): T {
  const previous = process.env['APP_ENV'];
  process.env['APP_ENV'] = 'production';
  try {
    return work();
  } finally {
    if (previous === undefined) delete process.env['APP_ENV'];
    else process.env['APP_ENV'] = previous;
  }
}

describe('which deployment is this', () => {
  it('reads APP_ENV, not NODE_ENV', () => {
    /*
     * D-97. Every built Next.js app sets `NODE_ENV=production`, including the
     * one the E2E suite serves — so a production guard keyed on it fires in
     * development. This is the assertion that keeps the guard on the right
     * variable.
     */
    expect(currentEnvironment({ APP_ENV: 'production', NODE_ENV: 'development' })).toBe(
      'PRODUCTION',
    );
    expect(currentEnvironment({ NODE_ENV: 'production' })).toBe('DEVELOPMENT');
  });

  it('defaults to DEVELOPMENT, which is the cautious direction', () => {
    // An unset variable makes the platform MORE careful about what it will run,
    // never less: development refuses nothing that production would allow.
    expect(currentEnvironment({})).toBe('DEVELOPMENT');
    expect(isProduction({})).toBe(false);
  });

  it('refuses a development double in production and names it', () => {
    expect(() => assertNotProduction('The thing', 'Do the other thing.', PRODUCTION)).toThrow(
      DevelopmentOnlyInProductionError,
    );
    expect(() => assertNotProduction('The thing', 'Do the other thing.', {})).not.toThrow();
  });
});

describe('development doubles cannot run in production', () => {
  it('refuses to construct the deterministic AI provider', () => {
    // Not "is not registered" — cannot be CONSTRUCTED. Registration was already
    // conditional in three files, which is three chances to add a fourth.
    expect(() => inProduction(() => new MockProviderAdapter())).toThrow(
      DevelopmentOnlyInProductionError,
    );
  });

  it('constructs it everywhere else, which is what it is for', () => {
    expect(() => new MockProviderAdapter()).not.toThrow();
  });

  it('refuses every development-only integration for production selection', () => {
    const developmentOnly = INTEGRATION_DEFINITIONS.filter((d) => d.developmentOnly);
    expect(developmentOnly.length).toBeGreaterThan(0);
    for (const definition of developmentOnly) {
      expect(selectionRefusal(definition, 'PRODUCTION')).not.toBeNull();
      expect(selectionRefusal(definition, 'DEVELOPMENT')).toBeNull();
    }
  });
});

describe('the production configuration contract', () => {
  const COMPLETE = {
    NODE_ENV: 'production',
    APP_ENV: 'production',
    DATABASE_URL: 'postgresql://app:pw@db:5432/brandspace',
    DATABASE_PLATFORM_URL: 'postgresql://platform:pw@db:5432/brandspace',
    CUSTOMER_SESSION_SECRET: 'a'.repeat(48),
    PLATFORM_SESSION_SECRET: 'b'.repeat(48),
    SECRET_VAULT_KEK: 'c'.repeat(48),
    SOCIAL_TOKEN_VAULT_KEK: 'd'.repeat(48),
    CUSTOMER_MFA_VAULT_KEK: 'e'.repeat(48),
    PUBLIC_WEB_URL: 'https://brandspace.example',
    PUBLIC_API_BASE_URL: 'https://api.brandspace.example',
    PUBLIC_DASHBOARD_BASE_URL: 'https://app.brandspace.example',
  } as unknown as NodeJS.ProcessEnv;

  it('accepts a complete production environment', () => {
    expect(() => parseEnv({ ...COMPLETE })).not.toThrow();
  });

  it('requires all three key domains', () => {
    for (const missing of [
      'SECRET_VAULT_KEK',
      'SOCIAL_TOKEN_VAULT_KEK',
      'CUSTOMER_MFA_VAULT_KEK',
    ]) {
      const env = { ...COMPLETE } as Record<string, unknown>;
      delete env[missing];
      expect(() => parseEnv(env as NodeJS.ProcessEnv), missing).toThrow(new RegExp(missing));
    }
  });

  it('refuses two key domains sharing one key', () => {
    // The whole point of D-136 and D-206: one leaked key must not unwrap
    // platform credentials, customer OAuth tokens and MFA seeds alike.
    expect(() =>
      parseEnv({ ...COMPLETE, SOCIAL_TOKEN_VAULT_KEK: 'c'.repeat(48) } as NodeJS.ProcessEnv),
    ).toThrow(/must all differ/i);
  });

  it('refuses a secret still holding a template marker', () => {
    expect(() =>
      parseEnv({
        ...COMPLETE,
        SECRET_VAULT_KEK: 'REPLACE_WITH_32_PLUS_CHAR_RANDOM_VALUE_FOR_VAULT',
      } as NodeJS.ProcessEnv),
    ).toThrow(/placeholder/i);
  });

  it('refuses a CI value that reached production', () => {
    expect(() =>
      parseEnv({
        ...COMPLETE,
        CUSTOMER_MFA_VAULT_KEK: `ci-only-${'x'.repeat(40)}`,
      } as NodeJS.ProcessEnv),
    ).toThrow(/placeholder/i);
  });

  it('refuses the development billing secret in production', () => {
    /*
     * Its only consumer cannot run in production at all, so its presence means
     * a production environment was assembled by copying a development one —
     * and the next thing copied might not be harmless.
     */
    expect(() =>
      parseEnv({ ...COMPLETE, BILLING_DEV_WEBHOOK_SECRET: 'z'.repeat(40) } as NodeJS.ProcessEnv),
    ).toThrow(/BILLING_DEV_WEBHOOK_SECRET/);
  });

  it('refuses http on a public URL in production', () => {
    expect(() =>
      parseEnv({ ...COMPLETE, PUBLIC_API_BASE_URL: 'http://api.example' } as NodeJS.ProcessEnv),
    ).toThrow(/https/i);
  });

  it('refuses one connection string serving as both database roles', () => {
    expect(() =>
      parseEnv({
        ...COMPLETE,
        DATABASE_PLATFORM_URL: COMPLETE['DATABASE_URL'],
      } as NodeJS.ProcessEnv),
    ).toThrow(/different roles/i);
  });
});

describe('startup validation', () => {
  it('throws in production so the process never comes up half-configured', () => {
    expect(() =>
      validateStartupConfiguration({ APP_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('reports instead of throwing outside production', () => {
    // A developer with half an environment should get a readable warning and a
    // running process, not a refusal to start.
    const result = validateStartupConfiguration({ APP_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.environment).toBe('DEVELOPMENT');
    expect(result.problems.join(' ')).toContain('DATABASE_URL');
  });

  it('never prints a value, only variable names', () => {
    const result = validateStartupConfiguration({
      APP_ENV: 'development',
      DATABASE_URL: 'not-a-url',
      CUSTOMER_SESSION_SECRET: 'super-secret-value-that-must-not-be-echoed',
    } as NodeJS.ProcessEnv);
    expect(result.problems.join(' ')).not.toContain('super-secret-value');
  });
});
