import { describe, expect, it } from 'vitest';
import { parseEnv, validateStartupConfiguration } from '@brandspace/shared';

const BASE = {
  DATABASE_URL: 'postgresql://app:pw@localhost:5432/db',
  CUSTOMER_SESSION_SECRET: 'a'.repeat(40),
  PLATFORM_SESSION_SECRET: 'b'.repeat(40),
} as const;

describe('environment parsing', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = parseEnv({ ...BASE } as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe('development');
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
    // D-03: the GCC region is configuration, so it stays portable.
    expect(env.DATA_REGION).toBe('local');
  });

  it('refuses to start without a database URL', () => {
    const { DATABASE_URL: _omitted, ...rest } = BASE;
    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('refuses a session secret that is too short', () => {
    expect(() =>
      parseEnv({ ...BASE, CUSTOMER_SESSION_SECRET: 'short' } as NodeJS.ProcessEnv),
    ).toThrow(/CUSTOMER_SESSION_SECRET/);
  });

  it('names the failing variable without printing its value', () => {
    try {
      parseEnv({ ...BASE, CUSTOMER_SESSION_SECRET: 'super-secret-but-short' } as NodeJS.ProcessEnv);
      throw new Error('should have thrown');
    } catch (e: unknown) {
      const message = (e as Error).message;
      expect(message).toContain('CUSTOMER_SESSION_SECRET');
      expect(message).not.toContain('super-secret-but-short');
    }
  });

  it('rejects a shared signing key between the two realms in production', () => {
    const shared = 'c'.repeat(40);
    expect(() =>
      parseEnv({
        ...BASE,
        NODE_ENV: 'production',
        CUSTOMER_SESSION_SECRET: shared,
        PLATFORM_SESSION_SECRET: shared,
      } as NodeJS.ProcessEnv),
    ).toThrow(/must not share a signing key|must differ/);
  });

  it('rejects placeholder secrets in production', () => {
    expect(() =>
      parseEnv({
        ...BASE,
        NODE_ENV: 'production',
        PLATFORM_SESSION_SECRET: 'REPLACE_WITH_change-me-placeholder-value-0000',
      } as NodeJS.ProcessEnv),
    ).toThrow(/placeholder/);
  });

  it('allows a shared key outside production, so local setup is not blocked', () => {
    const shared = 'd'.repeat(40);
    expect(() =>
      parseEnv({
        ...BASE,
        NODE_ENV: 'development',
        CUSTOMER_SESSION_SECRET: shared,
        PLATFORM_SESSION_SECRET: shared,
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('allows the production web profile to start with no database credential', () => {
    expect(() =>
      validateStartupConfiguration(
        {
          NODE_ENV: 'production',
          APP_ENV: 'production',
          PUBLIC_WEB_URL: 'https://www.brandspace.test',
          PUBLIC_API_BASE_URL: 'https://api.brandspace.test',
        } as NodeJS.ProcessEnv,
        'web',
      ),
    ).not.toThrow();
  });

  it('still requires a database credential for data-bearing production services', () => {
    expect(() =>
      validateStartupConfiguration(
        {
          NODE_ENV: 'production',
          APP_ENV: 'production',
          PUBLIC_WEB_URL: 'https://www.brandspace.test',
          PUBLIC_API_BASE_URL: 'https://api.brandspace.test',
          CUSTOMER_SESSION_SECRET: 'c'.repeat(40),
          CUSTOMER_MFA_VAULT_KMS_KEY_ARN:
            'arn:aws:kms:eu-west-1:123456789012:key/customer-mfa-test',
          AWS_ACCESS_KEY_ID: 'test-access-key',
          AWS_SECRET_ACCESS_KEY: 'test-secret-key-that-is-long-enough',
        } as NodeJS.ProcessEnv,
        'dashboard',
      ),
    ).toThrow(/DATABASE_URL/);
  });
});
