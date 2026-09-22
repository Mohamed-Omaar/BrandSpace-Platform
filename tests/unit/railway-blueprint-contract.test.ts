import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateStartupConfiguration, type StartupServiceProfile } from '@brandspace/shared';

/**
 * THE BLUEPRINT AND THE ENVIRONMENT CONTRACT MUST AGREE — and until now nothing
 * checked that they did.
 *
 * WHAT THIS TEST EXISTS BECAUSE OF. The production `web` service refused to
 * boot for days with CI green. `assertProductionSafety` required an https
 * `PUBLIC_API_BASE_URL` of every profile; `.railway/railway.ts` correctly did
 * not set it on `web`, which reads no environment variable at all; and
 * `tests/unit/production-safety.test.ts` exercised the `web` profile with a
 * hand-written fixture that happened to INCLUDE the missing variable. Three
 * files, two of them right, and the one test that could have caught it was
 * asserting a configuration no deployment has.
 *
 * The defect was never in any single file. It was that the contract existed in
 * two places — the Zod schema plus the profile tables in `packages/shared`, and
 * the per-service `env` blocks in `.railway/railway.ts` — with nothing binding
 * them. This test is that binding.
 *
 * HOW IT WORKS, AND WHY IT PARSES TEXT. `.railway/` is deliberately not a pnpm
 * workspace member (its own package.json says so), so it cannot be imported: it
 * pins the Railway authoring DSL and must stay out of the application
 * dependency graph. Parsing it is therefore the only way to read the artefact
 * that is actually deployed rather than a copy of it — and a copy is precisely
 * what this test exists to forbid.
 *
 * THE PARSER FAILS LOUDLY. Every step that could silently produce an empty or
 * partial answer asserts instead: the five services must be found, every spread
 * must resolve to a known fragment, and each service must end up with a
 * plausible number of variables. A blueprint restructured beyond the parser's
 * understanding breaks this test rather than quietly passing it, which is the
 * property that makes it worth having.
 */

const BLUEPRINT_PATH = path.resolve(__dirname, '../../.railway/railway.ts');
const SOURCE = readFileSync(BLUEPRINT_PATH, 'utf8');

/** The five services the blueprint declares, and the profile each one runs as. */
const SERVICE_PROFILES: Record<string, StartupServiceProfile> = {
  web: 'web',
  dashboard: 'dashboard',
  admin: 'admin',
  api: 'api',
  worker: 'worker',
};

/**
 * Variable names from an object literal's top level.
 *
 * Matches `NAME:` at the start of a line, which is how every variable in the
 * blueprint is written. Nested objects (`deploy`, `build`) are never passed to
 * this function — only `env` blocks and the fragment consts are.
 */
function variableNamesIn(block: string): string[] {
  return [...block.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1] as string);
}

/**
 * `awsIdentityFor(service, keys)` returns the IAM pair. Resolved by name rather
 * than by evaluating the call, because the pair it returns is fixed.
 */
const AWS_IDENTITY = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];

/** Extract `const <name> = { … };` from the blueprint, by brace balance. */
function objectLiteral(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = {`);
  expect(
    start,
    `blueprint fragment "${name}" not found — has railway.ts been restructured?`,
  ).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = SOURCE.indexOf('{', start); i < SOURCE.length; i += 1) {
    const ch = SOURCE[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces reading blueprint fragment "${name}".`);
}

/** The reusable env fragments the service blocks spread. */
const FRAGMENT_NAMES = [
  'commonEnv',
  'databaseEnv',
  'platformDatabaseEnv',
  'platformVaultEnv',
  'socialVaultEnv',
  'customerMfaVaultEnv',
  'publicUrlEnv',
  'storageEnv',
  // Phase 4. Carried by the dashboard and the API alone; see the
  // client-origin assertions below for why the narrowness is the point.
  'clientOriginEnv',
] as const;

/**
 * Fragments spread other fragments — `platformDatabaseEnv` is
 * `{ ...databaseEnv, DATABASE_PLATFORM_URL }`. Resolving only the top level
 * silently loses `DATABASE_URL`, which would make every assertion below weaker
 * than it looks, so this resolves transitively.
 */
function resolveFragment(name: string, seen: Set<string> = new Set()): string[] {
  expect(seen.has(name), `circular spread through "${name}" in the blueprint`).toBe(false);
  seen.add(name);
  const block = objectLiteral(name);
  const names = new Set(variableNamesIn(block));
  for (const [, nested] of block.matchAll(/\.\.\.([a-zA-Z]+)(\(|,)/g)) {
    const fragment = nested as string;
    if (fragment === 'awsIdentityFor') {
      AWS_IDENTITY.forEach((n) => names.add(n));
      continue;
    }
    if (!FRAGMENT_NAMES.includes(fragment as (typeof FRAGMENT_NAMES)[number])) continue;
    resolveFragment(fragment, seen).forEach((n) => names.add(n));
  }
  return [...names];
}

const FRAGMENTS: Record<string, string[]> = Object.fromEntries(
  FRAGMENT_NAMES.map((name) => [name, resolveFragment(name)]),
);

/** Every variable the blueprint sets on one service, with spreads resolved. */
function blueprintVariablesFor(service: string): string[] {
  const start = SOURCE.indexOf(`const ${service} = service('${service}', {`);
  expect(start, `service "${service}" not found in the blueprint`).toBeGreaterThan(-1);

  const envStart = SOURCE.indexOf('env: {', start);
  expect(envStart, `service "${service}" has no env block`).toBeGreaterThan(-1);

  let depth = 0;
  let envBlock = '';
  for (let i = SOURCE.indexOf('{', envStart); i < SOURCE.length; i += 1) {
    const ch = SOURCE[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        envBlock = SOURCE.slice(envStart, i + 1);
        break;
      }
    }
  }
  expect(envBlock.length, `could not read the env block for "${service}"`).toBeGreaterThan(0);

  const names = new Set(variableNamesIn(envBlock));

  for (const [, spread] of envBlock.matchAll(/\.\.\.([a-zA-Z]+)(\(|,)/g)) {
    const fragment = spread as string;
    if (fragment === 'awsIdentityFor') {
      AWS_IDENTITY.forEach((n) => names.add(n));
      continue;
    }
    const resolved = FRAGMENTS[fragment];
    expect(
      resolved,
      `service "${service}" spreads "${fragment}", which this test does not know how to ` +
        'resolve. Add it to FRAGMENTS rather than letting the contract go unchecked.',
    ).toBeDefined();
    (resolved ?? []).forEach((n) => names.add(n));
  }

  // `internalServiceToken` is a single sealed value, not an object fragment.
  if (/INTERNAL_SERVICE_TOKEN\s*:/.test(envBlock)) names.add('INTERNAL_SERVICE_TOKEN');

  return [...names];
}

/**
 * A plausible production value for one variable name.
 *
 * VALUES ARE SHAPED, NOT REAL. Nothing here is a credential: the ARNs name
 * account `000000000000`, the secrets are repeated letters, and the hosts are
 * `example`. The shape matters because the schema validates URLs and minimum
 * lengths, and because the three key domains must differ from one another.
 */
/**
 * The value the blueprint ACTUALLY declares for the client-origin strategy.
 *
 * Read out of the source rather than hard-coded here, so this fixture cannot
 * disagree with the blueprint: if somebody changes it to `direct`, the
 * production contract refuses it and these tests go red — which is the whole
 * point of the coupling.
 */
function declaredClientOriginStrategy(): string {
  const match = /CLIENT_ORIGIN_STRATEGY: '([a-z-]+)'/.exec(SOURCE);
  expect(match, 'the blueprint declares no CLIENT_ORIGIN_STRATEGY').not.toBeNull();
  return match![1]!;
}

function valueFor(name: string): string {
  if (name === 'CLIENT_ORIGIN_STRATEGY') return declaredClientOriginStrategy();
  if (name === 'NODE_ENV') return 'production';
  if (name === 'APP_ENV') return 'production';
  if (name === 'LOG_LEVEL') return 'info';
  if (name === 'DATA_REGION') return 'eu-west';
  if (name === 'OTEL_SERVICE_NAME') return 'brandspace';
  if (name === 'PORT' || name === 'WORKER_PORT') return '3000';
  if (name.endsWith('_KMS_KEY_ARN')) {
    // Distinct per domain: the contract refuses one key wearing three names.
    return `arn:aws:kms:eu-west-1:000000000000:key/${name.toLowerCase()}`;
  }
  if (name === 'DATABASE_PLATFORM_URL') {
    return 'postgresql://brandspace_platform:pw@postgres.railway.internal:5432/railway';
  }
  if (name.startsWith('DATABASE_')) {
    return 'postgresql://brandspace_app:pw@postgres.railway.internal:5432/railway';
  }
  if (name === 'REDIS_URL') return 'redis://default:pw@redis.railway.internal:6379';
  if (name === 'BRANDSPACE_API_URL') return 'http://api.railway.internal:3003';
  if (name === 'BRANDSPACE_POSTGRES_PRIVATE_HOST') return 'postgres.railway.internal';
  if (name === 'STORAGE_ENDPOINT') return 'https://account.r2.cloudflarestorage.com';
  if (name === 'STORAGE_BUCKET') return 'brandspace-production-media';
  if (name.startsWith('PUBLIC_') || name.endsWith('_URL')) return 'https://app.example.com';
  // Everything else is a secret: long enough for the schema's minimums, and
  // distinct per name so the "these must all differ" rules are satisfied.
  return `${name.toLowerCase()}-${'x'.repeat(48)}`;
}

function environmentFor(service: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const name of blueprintVariablesFor(service)) env[name] = valueFor(name);
  return env as NodeJS.ProcessEnv;
}

describe('the Railway blueprint satisfies the production environment contract', () => {
  it('finds all five services and a plausible variable set for each', () => {
    // The parser's own guard. An empty or tiny result means railway.ts moved
    // and every assertion below would be vacuous.
    for (const service of Object.keys(SERVICE_PROFILES)) {
      const names = blueprintVariablesFor(service);
      expect(names.length, `${service} has implausibly few variables`).toBeGreaterThanOrEqual(4);
      expect(names).toContain('APP_ENV');
    }
  });

  it.each(Object.entries(SERVICE_PROFILES))(
    'the %s service starts with exactly the variables the blueprint gives it',
    (service, profile) => {
      /*
       * THE ASSERTION THE OUTAGE NEEDED. The fixture is built from the
       * blueprint and from nothing else, so a variable the contract requires
       * but the blueprint does not set fails here — which is precisely the
       * `web` / `PUBLIC_API_BASE_URL` case, and precisely what a hand-written
       * superset fixture cannot catch.
       *
       * It fails in the other direction too: a variable the blueprint sets that
       * the profile is FORBIDDEN to hold (a key domain it may not reach, a
       * session secret it has no use for) is refused by the same call.
       */
      const result = validateStartupConfiguration(environmentFor(service), profile);
      expect(result.ok, `${service}: ${result.problems.join(' | ')}`).toBe(true);
      expect(result.environment).toBe('PRODUCTION');
    },
  );

  it('the web service is not asked for an origin it never reads', () => {
    /*
     * The regression, named. `apps/web/src` reads no environment variable
     * beyond `NEXT_RUNTIME`, so requiring `PUBLIC_API_BASE_URL` of it was
     * requiring a value that could only ever be decoration — and the schema's
     * `http://localhost` default turned its absence into a refusal about OAuth
     * callbacks the marketing site does not have.
     */
    const names = blueprintVariablesFor('web');
    expect(names).not.toContain('PUBLIC_API_BASE_URL');
    expect(validateStartupConfiguration(environmentFor('web'), 'web').ok).toBe(true);
  });

  it.each(Object.entries(SERVICE_PROFILES))(
    'the %s service names the variable when a required one is removed',
    (service, profile) => {
      /*
       * Proves the contract is load-bearing rather than permissive, and that
       * its refusals are usable. Removing a required variable must produce a
       * message that NAMES it — an operator reading a crash loop needs to know
       * which variable on which of five services, which is exactly what the
       * `web` outage did not tell anybody.
       *
       * `validateStartupConfiguration` THROWS in production rather than
       * returning a result, so each probe is caught individually.
       */
      const full = environmentFor(service);
      const refusals: { name: string; message: string }[] = [];

      for (const name of Object.keys(full)) {
        const withoutIt = { ...full };
        delete withoutIt[name];
        try {
          validateStartupConfiguration(withoutIt as NodeJS.ProcessEnv, profile);
        } catch (error: unknown) {
          refusals.push({ name, message: (error as Error).message });
        }
      }

      for (const refusal of refusals) {
        expect(
          refusal.message,
          `removing ${refusal.name} from ${service} produced a message that does not name it`,
        ).toContain(refusal.name);
      }

      if (service === 'web') {
        /*
         * THE MARKETING SITE REQUIRES NOTHING, and that is the fix rather than
         * an oversight. `apps/web/src` reads no environment variable beyond
         * `NEXT_RUNTIME`; requiring one of it is how this service spent days
         * refusing to boot over an origin it never consults.
         */
        expect(refusals, 'web should require none of its own variables').toHaveLength(0);
      } else {
        expect(
          refusals.length,
          `${service} requires none of its own variables, so the contract is not load-bearing`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it('refuses an http public URL on a service that does require one', () => {
    // The https rule still bites where the profile genuinely consumes the
    // origin. Scoping it per profile narrowed WHERE it applies, not whether.
    const env = { ...environmentFor('api'), PUBLIC_API_BASE_URL: 'http://api.example.com' };
    expect(() => validateStartupConfiguration(env as NodeJS.ProcessEnv, 'api')).toThrow(
      /PUBLIC_API_BASE_URL must use https/i,
    );
  });

  it('refuses an http public URL even on a service that does not require one', () => {
    // A stray http origin is a misconfiguration wherever it appears. Now that
    // an absent variable is absent rather than silently localhost, refusing a
    // present-but-http value costs nothing and catches a real mistake.
    const env = { ...environmentFor('web'), PUBLIC_WEB_URL: 'http://brandspace.cc' };
    expect(() => validateStartupConfiguration(env as NodeJS.ProcessEnv, 'web')).toThrow(
      /PUBLIC_WEB_URL must use https/i,
    );
  });
});

/**
 * THE CLIENT-ORIGIN CONTRACT REACHES EXACTLY THE SERVICES THAT READ IT.
 *
 * WHY THIS IS A BLUEPRINT ASSERTION AND NOT ONLY AN ENV ONE. `env.ts` refuses to
 * start a production `dashboard` or `api` without `CLIENT_ORIGIN_STRATEGY`. That
 * is the runtime half. This is the other half: the blueprint is what actually
 * puts the variable on the service, and a contract enforced by a process that
 * nobody configured is a crash loop rather than a protection.
 *
 * AND IT REACHES NO FURTHER. The marketing site, the Control Center and the
 * worker never establish a customer's source address, so the variable would be
 * configuration nobody reads — which is configuration that drifts, and later
 * gets copied somewhere it changes behaviour.
 */
describe('the client-origin contract is carried to its consumers only', () => {
  const CONSUMERS = ['dashboard', 'api'];
  const NON_CONSUMERS = ['web', 'admin', 'worker'];

  it.each(CONSUMERS)('%s declares CLIENT_ORIGIN_STRATEGY', (service) => {
    expect(blueprintVariablesFor(service)).toContain('CLIENT_ORIGIN_STRATEGY');
  });

  it.each(NON_CONSUMERS)('%s does NOT declare it', (service) => {
    expect(blueprintVariablesFor(service)).not.toContain('CLIENT_ORIGIN_STRATEGY');
  });

  it('sets it to railway-edge, which is the contract Railway documents', () => {
    /*
     * A LITERAL, NOT AN OWNER SETTING, because it is a property of Railway
     * rather than of this deployment: the edge proxy strips a client-supplied
     * X-Forwarded-For and writes the real connecting address FIRST. Counting
     * hops from the right cannot be correct there — the number of internal hops
     * changes with the routing path when the CDN layer is in it.
     */
    const declaration = SOURCE.slice(SOURCE.indexOf('const clientOriginEnv'));
    expect(declaration.slice(0, 300)).toContain("CLIENT_ORIGIN_STRATEGY: 'railway-edge'");
  });

  it('carries NO hop count, because railway-edge does not read one', () => {
    // A stray TRUSTED_PROXY_HOPS here would be inert but misleading: a reader
    // would reasonably conclude the deployment counts from the right.
    for (const service of [...CONSUMERS, ...NON_CONSUMERS]) {
      expect(blueprintVariablesFor(service)).not.toContain('TRUSTED_PROXY_HOPS');
    }
  });
});
