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

/**
 * Three DISTINCT key ARNs, shaped like real ones.
 *
 * No `example` anywhere in them, deliberately: the placeholder scan refuses any
 * variable whose name matches `SECRET|KEK|PASSWORD|KEY` and whose value carries
 * a template marker, and `…KMS_KEY_ARN` matches that name pattern. A fixture
 * using a documentation ARN would be refused for the right reason and read like
 * a bug.
 */
const KMS = {
  platform: 'arn:aws:kms:eu-west-1:111122223333:key/11111111-1111-1111-1111-111111111111',
  social: 'arn:aws:kms:eu-west-1:111122223333:key/22222222-2222-2222-2222-222222222222',
  customerMfa: 'arn:aws:kms:eu-west-1:111122223333:key/33333333-3333-3333-3333-333333333333',
} as const;

/** The AWS identity a service presents to KMS. Its own, never shared. */
const AWS_IDENTITY = {
  AWS_ACCESS_KEY_ID: 'AKIA1111111111111111',
  AWS_SECRET_ACCESS_KEY: 'w'.repeat(40),
} as const;

const COMPLETE = {
  NODE_ENV: 'production',
  APP_ENV: 'production',
  DATABASE_URL: 'postgresql://app:pw@db:5432/brandspace',
  DATABASE_PLATFORM_URL: 'postgresql://platform:pw@db:5432/brandspace',
  CUSTOMER_SESSION_SECRET: 'a'.repeat(48),
  PLATFORM_SESSION_SECRET: 'b'.repeat(48),
  SECRET_VAULT_KMS_KEY_ARN: KMS.platform,
  SOCIAL_TOKEN_VAULT_KMS_KEY_ARN: KMS.social,
  CUSTOMER_MFA_VAULT_KMS_KEY_ARN: KMS.customerMfa,
  ...AWS_IDENTITY,
  PUBLIC_WEB_URL: 'https://brandspace.example',
  PUBLIC_API_BASE_URL: 'https://api.brandspace.example',
  PUBLIC_DASHBOARD_BASE_URL: 'https://app.brandspace.example',
} satisfies NodeJS.ProcessEnv;

/** The public URLs every profile needs, so each fixture below stays readable. */
const PUBLIC_URLS = {
  PUBLIC_WEB_URL: COMPLETE.PUBLIC_WEB_URL,
  PUBLIC_API_BASE_URL: COMPLETE.PUBLIC_API_BASE_URL,
} as const;

const DEPLOYED = { NODE_ENV: 'production', APP_ENV: 'production' } as const;

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
  it('accepts a complete production environment', () => {
    expect(() => parseEnv({ ...COMPLETE })).not.toThrow();
  });

  it('requires a MANAGED key for all three domains, not a KEK', () => {
    /*
     * THE F-09 CONTRACT, STATED AS A REFUSAL. In production `createKeyProvider`
     * throws rather than derive a key from a KEK — that provider keeps the key
     * in the same environment as the data it protects — so a deployment
     * missing an ARN cannot seal anything in that domain. Before this, the
     * process came up and found out at the first save.
     */
    for (const missing of [
      'SECRET_VAULT_KMS_KEY_ARN',
      'SOCIAL_TOKEN_VAULT_KMS_KEY_ARN',
      'CUSTOMER_MFA_VAULT_KMS_KEY_ARN',
    ]) {
      const env = { ...COMPLETE } as Record<string, unknown>;
      delete env[missing];
      expect(() => parseEnv(env as NodeJS.ProcessEnv), missing).toThrow(new RegExp(missing));
    }
  });

  it('no longer requires a domain KEK in production, and does not fall back to one', () => {
    /*
     * The KEKs are absent from COMPLETE entirely and it passes. Requiring them
     * used to force every production deployment to carry three keys it could
     * not legally use — and an unusable key in an environment is still a key
     * in an environment.
     *
     * A KEK WITHOUT ITS ARN IS NOT A FALLBACK: it is a refusal, which is the
     * half of this that matters.
     */
    const kekOnly = { ...COMPLETE, SECRET_VAULT_KEK: 'c'.repeat(48) } as Record<string, unknown>;
    delete kekOnly['SECRET_VAULT_KMS_KEY_ARN'];
    expect(() => parseEnv(kekOnly as NodeJS.ProcessEnv)).toThrow(/SECRET_VAULT_KMS_KEY_ARN/);
  });

  it('tolerates a staging KEK alongside the production key', () => {
    // The same blueprint builds staging, where the KEK is what encrypts. Its
    // presence here is unused, not wrong.
    expect(() =>
      parseEnv({ ...COMPLETE, SECRET_VAULT_KEK: 'c'.repeat(48) } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('refuses two key domains sharing one managed key', () => {
    // The whole point of D-136 and D-206: one leaked key must not unwrap
    // platform credentials, customer OAuth tokens and MFA seeds alike. Three
    // variables pointing at one CMK satisfies every other rule in this file.
    expect(() =>
      parseEnv({ ...COMPLETE, SOCIAL_TOKEN_VAULT_KMS_KEY_ARN: KMS.platform } as NodeJS.ProcessEnv),
    ).toThrow(/must all differ/i);
  });

  it('refuses two key domains sharing one KEK', () => {
    expect(() =>
      parseEnv({
        ...COMPLETE,
        SECRET_VAULT_KEK: 'c'.repeat(48),
        SOCIAL_TOKEN_VAULT_KEK: 'c'.repeat(48),
      } as NodeJS.ProcessEnv),
    ).toThrow(/must all differ/i);
  });

  it('requires the AWS identity that makes those keys usable', () => {
    // Railway runs no instance role, so a service with a key and no credentials
    // cannot call KMS at all — and would discover that at the first save.
    for (const missing of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      const env = { ...COMPLETE } as Record<string, unknown>;
      delete env[missing];
      expect(() => parseEnv(env as NodeJS.ProcessEnv), missing).toThrow(new RegExp(missing));
    }
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

  it('accepts the API profile without either session signing key', () => {
    const apiEnv: NodeJS.ProcessEnv = { ...COMPLETE };
    delete apiEnv['CUSTOMER_SESSION_SECRET'];
    delete apiEnv['PLATFORM_SESSION_SECRET'];

    expect(() => validateStartupConfiguration(apiEnv, 'api')).not.toThrow();
  });

  it('refuses session signing keys on the API process', () => {
    const apiEnv: NodeJS.ProcessEnv = { ...COMPLETE };
    delete apiEnv['PLATFORM_SESSION_SECRET'];
    apiEnv['CUSTOMER_SESSION_SECRET'] = 'x'.repeat(48);

    expect(() => validateStartupConfiguration(apiEnv, 'api')).toThrow(
      /CUSTOMER_SESSION_SECRET.*must not be present/i,
    );
  });
});

/**
 * THE KEY-DOMAIN BLAST RADIUS, PER SERVICE.
 *
 * Each of the four deployed processes gets exactly the domains it uses, and is
 * REFUSED the others in both forms — the managed key and the KEK alike. This is
 * F-07, D-136 and D-206 stated as something that runs at start-up rather than
 * as three paragraphs of documentation, and the negative half is the half that
 * matters: a service that merely *happens* not to be given a key today is one
 * variable away from holding it tomorrow.
 *
 * The fixtures are deliberately minimal — each carries what its service is
 * entitled to and nothing else — so a rule that quietly started requiring more
 * would fail here rather than pass by inheriting COMPLETE.
 */
describe('each service holds exactly the key domains it uses', () => {
  const PROFILES = [
    {
      profile: 'admin' as const,
      env: {
        ...DEPLOYED,
        ...PUBLIC_URLS,
        ...AWS_IDENTITY,
        DATABASE_URL: COMPLETE.DATABASE_URL,
        DATABASE_PLATFORM_URL: COMPLETE.DATABASE_PLATFORM_URL,
        PLATFORM_SESSION_SECRET: COMPLETE.PLATFORM_SESSION_SECRET,
        SECRET_VAULT_KMS_KEY_ARN: KMS.platform,
      },
      permitted: ['SECRET_VAULT_KMS_KEY_ARN'],
      refused: [
        ['SOCIAL_TOKEN_VAULT_KMS_KEY_ARN', KMS.social],
        ['CUSTOMER_MFA_VAULT_KMS_KEY_ARN', KMS.customerMfa],
        ['SOCIAL_TOKEN_VAULT_KEK', 'd'.repeat(48)],
        ['CUSTOMER_MFA_VAULT_KEK', 'e'.repeat(48)],
      ] as [string, string][],
    },
    {
      profile: 'dashboard' as const,
      env: {
        ...DEPLOYED,
        ...PUBLIC_URLS,
        ...AWS_IDENTITY,
        DATABASE_URL: COMPLETE.DATABASE_URL,
        CUSTOMER_SESSION_SECRET: COMPLETE.CUSTOMER_SESSION_SECRET,
        CUSTOMER_MFA_VAULT_KMS_KEY_ARN: KMS.customerMfa,
      },
      permitted: ['CUSTOMER_MFA_VAULT_KMS_KEY_ARN'],
      refused: [
        ['SECRET_VAULT_KMS_KEY_ARN', KMS.platform],
        ['SOCIAL_TOKEN_VAULT_KMS_KEY_ARN', KMS.social],
        ['SECRET_VAULT_KEK', 'c'.repeat(48)],
        ['SOCIAL_TOKEN_VAULT_KEK', 'd'.repeat(48)],
      ] as [string, string][],
    },
    {
      profile: 'worker' as const,
      env: {
        ...DEPLOYED,
        ...PUBLIC_URLS,
        ...AWS_IDENTITY,
        DATABASE_URL: COMPLETE.DATABASE_URL,
        SOCIAL_TOKEN_VAULT_KMS_KEY_ARN: KMS.social,
      },
      permitted: ['SOCIAL_TOKEN_VAULT_KMS_KEY_ARN'],
      refused: [
        ['SECRET_VAULT_KMS_KEY_ARN', KMS.platform],
        ['CUSTOMER_MFA_VAULT_KMS_KEY_ARN', KMS.customerMfa],
        ['SECRET_VAULT_KEK', 'c'.repeat(48)],
        ['CUSTOMER_MFA_VAULT_KEK', 'e'.repeat(48)],
      ] as [string, string][],
    },
    {
      profile: 'api' as const,
      env: { ...COMPLETE, CUSTOMER_SESSION_SECRET: undefined, PLATFORM_SESSION_SECRET: undefined },
      permitted: [
        'SECRET_VAULT_KMS_KEY_ARN',
        'SOCIAL_TOKEN_VAULT_KMS_KEY_ARN',
        'CUSTOMER_MFA_VAULT_KMS_KEY_ARN',
      ],
      refused: [] as [string, string][],
    },
  ];

  it.each(PROFILES)('$profile starts with exactly its own domains', ({ profile, env }) => {
    expect(() => validateStartupConfiguration(env as NodeJS.ProcessEnv, profile)).not.toThrow();
  });

  it.each(PROFILES)(
    '$profile refuses to start without one of them',
    ({ profile, env, permitted }) => {
      for (const name of permitted) {
        const without = { ...env } as Record<string, unknown>;
        delete without[name];
        expect(
          () => validateStartupConfiguration(without as NodeJS.ProcessEnv, profile),
          `${profile} without ${name}`,
        ).toThrow(new RegExp(name));
      }
    },
  );

  it.each(PROFILES)(
    '$profile refuses a key domain it must not reach',
    ({ profile, env, refused }) => {
      for (const [name, value] of refused) {
        expect(
          () =>
            validateStartupConfiguration({ ...env, [name]: value } as NodeJS.ProcessEnv, profile),
          `${profile} with ${name}`,
        ).toThrow(/must not be present/i);
      }
    },
  );

  it.each(PROFILES)('$profile needs its own AWS identity', ({ profile, env }) => {
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      const without = { ...env } as Record<string, unknown>;
      delete without[name];
      expect(
        () => validateStartupConfiguration(without as NodeJS.ProcessEnv, profile),
        `${profile} without ${name}`,
      ).toThrow(new RegExp(name));
    }
  });

  it('the marketing site holds no key domain and no AWS identity at all', () => {
    const webEnv = { ...DEPLOYED, ...PUBLIC_URLS, DATABASE_URL: COMPLETE.DATABASE_URL };
    expect(() => validateStartupConfiguration(webEnv as NodeJS.ProcessEnv, 'web')).not.toThrow();

    const forbidden: [string, string][] = [
      ['SECRET_VAULT_KMS_KEY_ARN', KMS.platform],
      ['CUSTOMER_MFA_VAULT_KMS_KEY_ARN', KMS.customerMfa],
      ['AWS_ACCESS_KEY_ID', AWS_IDENTITY.AWS_ACCESS_KEY_ID],
      ['DATABASE_PLATFORM_URL', COMPLETE.DATABASE_PLATFORM_URL],
      ['PLATFORM_SESSION_SECRET', COMPLETE.PLATFORM_SESSION_SECRET],
    ];
    for (const [name, value] of forbidden) {
      expect(
        () =>
          validateStartupConfiguration({ ...webEnv, [name]: value } as NodeJS.ProcessEnv, 'web'),
        name,
      ).toThrow(/must not be present/i);
    }
  });
});

describe('startup validation, continued', () => {
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
