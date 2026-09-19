import { bucket, defineRailway, github, postgres, redis, ref, service } from 'railway/iac';

/**
 * BrandSpace on Railway — Infrastructure as Code.
 *
 * READ `docs/RAILWAY-DEPLOYMENT.md` BEFORE CHANGING THIS FILE. It carries the
 * reasoning; this file carries only what the reasoning concluded.
 *
 * NOTHING HERE HAS BEEN APPLIED. No Railway project exists yet. `railway config
 * plan` previews; `railway config apply` creates. Neither has been run.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN:
 *
 *   1. NO SECRET VALUE. Every credential is declared with `preserveExisting`
 *      and `isSealed` and no value, so applying this file can never overwrite
 *      what the owner set, and reading this file can never reveal it.
 *
 *   2. NO DATABASE URL FROM RAILWAY'S OWN POSTGRES VARIABLE. Railway's
 *      `DATABASE_URL` is the instance owner — a superuser. Handing it to an
 *      application process would end row-level security on the spot, because
 *      RLS is not enforced against a table's owner and a superuser bypasses it
 *      outright. BrandSpace runs on three least-privileged roles created after
 *      provisioning (docs/RAILWAY-DEPLOYMENT.md §3). The three URLs below are
 *      owner-supplied for exactly that reason.
 *
 *   3. NO DOMAINS. The owner generates Railway domains and attaches custom ones
 *      (§10). They are listed in the deployment doc, not declared here, because
 *      a domain typed into a file is a domain nobody verified they control.
 *
 *   4. NO STORAGE WIRING, though the bucket itself is declared. See the comment
 *      on `media` below: the repository has an `ObjectStore` interface and an
 *      env contract but no S3 implementation, so wiring credentials to it today
 *      would describe a capability that does not exist.
 */

/** The GitHub source every service builds from. One repository, five processes. */
const REPO = 'Mohamed-Omaar/BrandSpace-Platform';

/**
 * THE DEPLOYMENT REGION, and an honest note about it.
 *
 * D-03 wants GCC / Middle East data residency. Railway has no Middle East
 * region: at the time of writing it offers US West, US East, EU West
 * (Amsterdam) and Southeast Asia (Singapore). EU West is the closest with a
 * comparable legal regime. This is a residency decision the owner has to take
 * knowingly, not a default to inherit — docs/RAILWAY-DEPLOYMENT.md §1.4.
 *
 * VERIFY THE SLUG IN THE RAILWAY DASHBOARD BEFORE THE FIRST APPLY. Region
 * identifiers are Railway's to change and this one was not read from a live
 * project.
 */
const REGION = 'europe-west4-drams3a';

/**
 * PORTS ARE PINNED, and that is a deliberate choice rather than an oversight.
 *
 * Railway normally assigns `PORT` and expects the process to read it. Two
 * things here make an explicit port the safer option:
 *
 *   - Every Next.js `start` script in this repository already hard-codes its
 *     port (`next start --port 3000`), so an assigned `PORT` would be ignored
 *     and the healthcheck would hit a closed socket. Pinning `PORT` to the port
 *     the script already uses makes the shipped scripts correct as written,
 *     instead of shadowing them with a start command that has to be kept in
 *     step with `package.json`.
 *
 *   - Private-network addresses become deterministic. `BRANDSPACE_API_URL` can
 *     be a literal `http://api.railway.internal:3003` instead of a reference
 *     that has to resolve a port at deploy time.
 *
 * The worker is the special case: it serves its liveness endpoint on
 * `WORKER_PORT`, not `PORT`, so both are set to the same value or Railway's
 * healthcheck would probe a port nothing is listening on.
 */
const PORTS = { web: 3000, dashboard: 3001, admin: 3002, api: 3003, worker: 3004 } as const;

/**
 * A secret this file declares but never carries.
 *
 * `preserveExisting` means an apply leaves whatever the owner set alone;
 * `isSealed` means Railway will not show it again after it is written. Together
 * they make the variable's EXISTENCE reviewable in git while its VALUE stays
 * out of it.
 */
function ownerSecret(description: string) {
  return { description, isSealed: true, preserveExisting: true, isOptional: false };
}

/** A non-secret setting the owner supplies once a domain exists. */
function ownerSetting(description: string) {
  return { description, preserveExisting: true, isOptional: false };
}

/**
 * Watch paths.
 *
 * CORRECTNESS BEFORE THRIFT (§13). Every service except the marketing site
 * consumes shared workspace packages, and a package change that did not rebuild
 * its consumers would deploy a service compiled against code that no longer
 * exists. So `packages/**` rebuilds everything that imports from it, and only
 * `web` — which depends on `ui` and `shared` alone — gets a narrower list.
 */
const ROOT_WATCH = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.railway/**'];
const SHARED_WATCH = ['packages/**', ...ROOT_WATCH];
const WEB_WATCH = ['apps/web/**', 'packages/ui/**', 'packages/shared/**', ...ROOT_WATCH];

/**
 * Prisma's client is generated, not committed, so every service that reaches
 * the database has to generate it before its own build. `web` does not: it
 * imports no database package at all.
 */
const PRISMA_GENERATE = 'pnpm --filter @brandspace/database exec prisma generate';

export default defineRailway((ctx, project) => {
  const isProduction = ctx.isEnvironment('production');

  /*
   * THE MANAGED DATA SERVICES. All three are private: none is given a domain or
   * a TCP proxy, so nothing outside the environment's private network can open
   * a connection to them.
   */
  const db = postgres('postgres', { region: REGION });
  const cache = redis('redis', { region: REGION });

  /*
   * DECLARED, AND DELIBERATELY NOT WIRED TO ANYTHING YET.
   *
   * `packages/storage` defines an `ObjectStore` interface and ships exactly one
   * implementation: a filesystem store that `createObjectStore` REFUSES to
   * return when `APP_ENV=production`. There is no S3 client in the repository —
   * no `@aws-sdk` dependency anywhere — so the `STORAGE_*` variables in
   * `packages/shared/src/env.ts` are a contract nothing currently reads.
   *
   * Wiring this bucket's credentials into those variables today would look like
   * working object storage and behave like none. The bucket is declared so the
   * infrastructure is reviewable and ready; the wiring is one commit away and
   * waits on an S3 adapter. docs/RAILWAY-DEPLOYMENT.md §6 has the exact mapping.
   *
   * Bucket regions are their own short list — `sjc`, `iad`, `ams`, `sin` — so
   * `ams` is the one that sits beside EU West.
   */
  const media = bucket('media', { region: 'ams' });

  /** Every service that opens a database connection needs these three. */
  const databaseEnv = {
    DATABASE_URL: ownerSecret(
      'brandspace_app role. NOBYPASSRLS, owns nothing, no policy grants it cross-tenant sight. NEVER Railway’s own postgres DATABASE_URL.',
    ),
  };

  const platformDatabaseEnv = {
    ...databaseEnv,
    DATABASE_PLATFORM_URL: ownerSecret(
      'brandspace_platform role. Cross-tenant, audited. Must differ from DATABASE_URL — the env parser refuses production if they match.',
    ),
  };

  /** The three key domains. Separate keys so one leak cannot unwrap the others. */
  const vaultEnv = {
    SECRET_VAULT_KEK: ownerSecret('Key-encryption key for the platform secret vault (D-136).'),
    SOCIAL_TOKEN_VAULT_KEK: ownerSecret(
      'Key-encryption key for customers’ own social OAuth tokens (D-136).',
    ),
    CUSTOMER_MFA_VAULT_KEK: ownerSecret(
      'Key-encryption key for customers’ own MFA seeds, reachable from the login surface (D-206).',
    ),
  };

  /**
   * Settings every process shares.
   *
   * `APP_ENV` is the deployment environment and `NODE_ENV` is the build mode;
   * D-97 keeps them distinct because every built Next.js app sets
   * `NODE_ENV=production` including the one the E2E suite serves.
   */
  const commonEnv = {
    NODE_ENV: 'production',
    APP_ENV: isProduction ? 'production' : 'staging',
    LOG_LEVEL: isProduction ? 'info' : 'debug',
    DATA_REGION: 'eu-west',
    OTEL_SERVICE_NAME: 'brandspace',
  };

  /**
   * Public base URLs.
   *
   * THESE BLOCK THE FIRST PRODUCTION BOOT UNTIL THEY EXIST, and the deployment
   * order in the doc is arranged around that. `assertProductionSafety` refuses
   * to start a production process whose `PUBLIC_WEB_URL` or
   * `PUBLIC_API_BASE_URL` begins with `http://`, and the schema defaults are
   * `http://localhost:...`. So a domain — even a generated `*.up.railway.app`
   * one — has to exist before the API or worker will come up at all.
   */
  const publicUrlEnv = {
    PUBLIC_WEB_URL: ownerSetting(
      'https origin of the marketing site. Must be https in production.',
    ),
    DASHBOARD_URL: ownerSetting('https origin of the customer dashboard.'),
    ADMIN_URL: ownerSetting('https origin of the Platform Control Center.'),
    API_URL: ownerSetting('https origin of the API.'),
    PUBLIC_API_BASE_URL: ownerSetting(
      'https origin every OAuth callback and webhook URL is built from. Must be https in production.',
    ),
    PUBLIC_DASHBOARD_BASE_URL: ownerSetting('https origin customers are returned to.'),
  };

  /** Where the dashboard and the Control Center reach the API, over the private network. */
  const internalApiUrl = `http://api.railway.internal:${PORTS.api}`;

  // -------------------------------------------------------------------------
  // PUBLIC SERVICES
  // -------------------------------------------------------------------------

  /**
   * The marketing site. The only service that touches neither the database nor
   * Redis, which is why its watch list and its environment are both this short.
   */
  const web = service('web', {
    source: github(REPO),
    build: { builder: 'RAILPACK', watchPatterns: WEB_WATCH },
    deploy: {
      startCommand: 'pnpm --filter @brandspace/web start',
      healthcheckPath: '/',
      healthcheckTimeout: 300,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      numReplicas: 1,
      region: REGION,
      drainingSeconds: 30,
    },
    env: {
      ...commonEnv,
      PORT: String(PORTS.web),
      PUBLIC_WEB_URL: publicUrlEnv.PUBLIC_WEB_URL,
      DASHBOARD_URL: publicUrlEnv.DASHBOARD_URL,
    },
  });

  /** The customer application. Tenant database identity only — never the platform one. */
  const dashboard = service('dashboard', {
    source: github(REPO),
    build: {
      builder: 'RAILPACK',
      buildCommand: `${PRISMA_GENERATE} && pnpm --filter @brandspace/dashboard build`,
      watchPatterns: ['apps/dashboard/**', ...SHARED_WATCH],
    },
    deploy: {
      startCommand: 'pnpm --filter @brandspace/dashboard start',
      healthcheckPath: '/',
      healthcheckTimeout: 300,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      numReplicas: 1,
      region: REGION,
      drainingSeconds: 30,
    },
    env: {
      ...commonEnv,
      ...databaseEnv,
      ...publicUrlEnv,
      PORT: String(PORTS.dashboard),
      REDIS_URL: ref(cache, 'REDIS_URL'),
      BRANDSPACE_API_URL: internalApiUrl,
      CUSTOMER_SESSION_SECRET: ownerSecret(
        'Signing key for the CUSTOMER session realm. Must differ from PLATFORM_SESSION_SECRET.',
      ),
      /*
       * ONLY THE MFA KEY REACHES THE LOGIN SURFACE (D-206). The dashboard
       * verifies a TOTP code at sign-in, so it needs that one key domain and
       * must not hold the other two: a login request should not be able to
       * unwrap a platform provider credential or a customer's social token.
       */
      CUSTOMER_MFA_VAULT_KEK: vaultEnv.CUSTOMER_MFA_VAULT_KEK,
    },
  });

  /**
   * The Platform Control Center. The only public service holding
   * `DATABASE_PLATFORM_URL` and `SECRET_VAULT_KEK` — a separate application, a
   * separate session realm, a separate database identity.
   */
  const admin = service('admin', {
    source: github(REPO),
    build: {
      builder: 'RAILPACK',
      buildCommand: `${PRISMA_GENERATE} && pnpm --filter @brandspace/admin build`,
      watchPatterns: ['apps/admin/**', ...SHARED_WATCH],
    },
    deploy: {
      startCommand: 'pnpm --filter @brandspace/admin start',
      healthcheckPath: '/',
      healthcheckTimeout: 300,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      numReplicas: 1,
      region: REGION,
      drainingSeconds: 30,
    },
    env: {
      ...commonEnv,
      ...platformDatabaseEnv,
      ...publicUrlEnv,
      PORT: String(PORTS.admin),
      REDIS_URL: ref(cache, 'REDIS_URL'),
      BRANDSPACE_API_URL: internalApiUrl,
      PLATFORM_SESSION_SECRET: ownerSecret(
        'Signing key for the PLATFORM session realm. Must differ from CUSTOMER_SESSION_SECRET.',
      ),
      SECRET_VAULT_KEK: vaultEnv.SECRET_VAULT_KEK,
    },
  });

  /**
   * The API.
   *
   * PUBLIC, AND NOT ONLY FOR CONVENIENCE. Its public origin is what every OAuth
   * callback and every future payment webhook is addressed to
   * (`PUBLIC_API_BASE_URL`), so it needs an origin the outside world can reach.
   * The dashboard and Control Center still call it over the private network.
   *
   * IT IS ALSO THE MAINTENANCE SCHEDULER. `server.ts` starts
   * `MaintenanceScheduler` in-process when run directly, so replicas would run
   * one sweep loop each. The sweeps claim their work, so duplicates contend
   * rather than double-act, but that has not been proven for every sweep — so
   * one replica, and §18 of the doc says what to establish before raising it.
   */
  const api = service('api', {
    source: github(REPO),
    build: {
      builder: 'RAILPACK',
      buildCommand: PRISMA_GENERATE,
      watchPatterns: ['apps/api/**', ...SHARED_WATCH],
    },
    deploy: {
      startCommand: 'pnpm --filter @brandspace/api start',
      /*
       * READINESS, NOT LIVENESS, for the routing probe. `/health/ready` reports
       * `down` when the tenant database does not answer and Railway should stop
       * sending traffic to an instance that cannot serve. `/health/live` checks
       * nothing external on purpose and would answer `ok` throughout a database
       * outage.
       */
      healthcheckPath: '/health/ready',
      healthcheckTimeout: 300,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      numReplicas: 1,
      region: REGION,
      drainingSeconds: 30,
    },
    env: {
      ...commonEnv,
      ...platformDatabaseEnv,
      ...publicUrlEnv,
      ...vaultEnv,
      PORT: String(PORTS.api),
      REDIS_URL: ref(cache, 'REDIS_URL'),
    },
  });

  // -------------------------------------------------------------------------
  // PRIVATE SERVICES
  // -------------------------------------------------------------------------

  /**
   * The background worker. NO DOMAIN, deliberately: it consumes queues and
   * serves one liveness endpoint that only Railway's healthcheck needs to see.
   *
   * `PORT` and `WORKER_PORT` are set to the same value because `main.ts` reads
   * `WORKER_PORT` while Railway probes `PORT`.
   *
   * IT HOLDS THE SOCIAL TOKEN KEY AND NOT THE OTHERS. The publish processor
   * unwraps a customer's own OAuth token; it has no business unwrapping a
   * platform provider credential or an MFA seed.
   */
  const worker = service('worker', {
    source: github(REPO),
    build: {
      builder: 'RAILPACK',
      buildCommand: PRISMA_GENERATE,
      watchPatterns: ['apps/worker/**', ...SHARED_WATCH],
    },
    deploy: {
      startCommand: 'pnpm --filter @brandspace/worker start',
      healthcheckPath: '/',
      healthcheckTimeout: 300,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      numReplicas: 1,
      region: REGION,
      /*
       * LONGER THAN THE WEB SERVICES. BullMQ's `close()` waits for active jobs,
       * and a publish already in flight at the platform must not be abandoned:
       * abandoning it is how a job that succeeded gets recorded as one that
       * never ran.
       */
      drainingSeconds: 120,
    },
    env: {
      ...commonEnv,
      ...databaseEnv,
      ...publicUrlEnv,
      PORT: String(PORTS.worker),
      WORKER_PORT: String(PORTS.worker),
      REDIS_URL: ref(cache, 'REDIS_URL'),
      SOCIAL_TOKEN_VAULT_KEK: vaultEnv.SOCIAL_TOKEN_VAULT_KEK,
      /*
       * The private hostname of the Postgres instance, so the three role URLs
       * can be composed without anybody reading a password out of the
       * dashboard. Not a credential: a hostname.
       */
      BRANDSPACE_POSTGRES_PRIVATE_HOST: ref(db, 'RAILWAY_PRIVATE_DOMAIN'),
    },
  });

  return project('brandspace', {
    environments: ['production', 'staging'],
    resources: [db, cache, media, web, dashboard, admin, api, worker],
  });
});
