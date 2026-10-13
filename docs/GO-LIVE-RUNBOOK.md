# Go-live runbook: staging → production (PR F)

A read-only analysis. Nothing in this document was run against production or Railway. Every
statement about the code cites the file it was read from, on branch `claude/pr-f-beta-readiness`.
Facts about the live Railway project come from the owner and are marked **(owner)**.

## 1. Summary

- **(owner)** Production services `dashboard`, `api`, `admin` and `worker` deploy from `main`.
  Their last deployments (2026-09-19, `590717e`, the PR #29 merge) failed at the HEALTHCHECK
  stage. The logs have expired. `migration`, Postgres, Redis, `db-setup` and `landing` are up.
- So the build passed and a container started, but no healthcheck answered 2xx in time. Without
  logs the cause is not known. §2 lists the likely causes and how to tell them apart on the next
  attempt.
- `main` has moved since then: the remote `main` is `2d2b21a` (PR #36, 2026-09-22), 113 commits
  after `590717e`, and nothing deployed it to production. Check whether auto-deploy is on for the
  four services before the merge, so the release happens when you expect it.
- `main` (`2d2b21a`) is an ancestor of `staging` (`e7929e2`), 543 commits behind. The
  staging → main merge has no conflicts.
- The code now enforces much more at boot than `590717e` did. A production service with a
  missing, extra, placeholder or `http://` variable **refuses to start** and never passes its
  healthcheck (`packages/shared/src/env.ts:651-764`, thrown only under `APP_ENV=production`,
  `env.ts:808`). The variable lists in §5 are the contract.
- The database must hold all **91** migrations (`packages/database/prisma/migrations`, identical to
  `EXPECTED_MIGRATIONS` in `packages/database/src/migration-manifest.ts`) before any of the four
  services reports ready. At `590717e` there were 41.
- Expected end state: every service healthy; configuration activated from
  `docs/production-config/`; Resend active and Tested; storage Tested; the Control Center
  readiness verdict **"not ready"** for one known reason (AI is off, §4 step 10), with the scanner
  and legal rows on "Beta only".

## 2. Why the last deploy probably failed

None of these is confirmed. Each says what to look for in Railway's **Build Logs** and **Deploy
Logs** on the next attempt. One distinction separates most of them: the healthcheck log line says
either "service unavailable" (nothing listening on `PORT`) or a status code (something answered).

| #   | Hypothesis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | How to confirm on the next attempt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | **Boot-time environment refusal under `APP_ENV=production`.** Most likely, because it fails all four services the same way. At `590717e` (`git show 590717e:packages/shared/src/env.ts`): `PUBLIC_WEB_URL` and `PUBLIC_API_BASE_URL` defaulted to `http://localhost:…` (lines 63, 135) and the https check applied to **every** service (line 434), so each of the four needed both set to `https://…`; each permitted key domain's KMS ARN and the AWS key pair were required with no staging/production distinction (lines 273-318). The dashboard and admin run the same check in `instrumentation.ts`; a throw there makes `next start` exit 1 (`node_modules/next/dist/server/lib/start-server.js:443`, Next 16.3.4). | Deploy Logs show one of: `Invalid environment configuration:`, `… is required in production for the <service> service`, `… must not be present in production for this service`, `… must use https in production`, `… still holds a placeholder value in production`, `CLIENT_ORIGIN_STRATEGY is required in production`; for Next apps also `An error occurred while loading the instrumentation hook`. Then the container restarts (ON_FAILURE) and the healthcheck says "service unavailable". The message names the variable, never the value. |
| H2  | **`PORT` not pinned.** `next start --port 3001` / `--port 3002` ignore Railway's `PORT` (`apps/dashboard/package.json:8`, `apps/admin/package.json:8`), and Railway probes `PORT`. The worker serves its probe on `WORKER_PORT` (default 3004), not `PORT` (`apps/worker/src/main.ts:107`). **Not a cause for `api`**: it listens on `PORT` itself (`apps/api/src/server.ts`, the listener).                                                                                                                                                                                                                                                                                                                               | Deploy Logs show Next's `Ready` on `localhost:3001` (or 3002), or the worker's `worker ready … healthPort: 3004`, with no crash, while every healthcheck attempt says "service unavailable". The service's Variables tab shows `PORT` missing or different from 3001 / 3002 / 3004.                                                                                                                                                                                                                                                               |
| H3  | **`api` could not reach the database as `brandspace_app`.** At `590717e` `/health/ready` was `SELECT 1` on `DATABASE_URL` (`git show 590717e:apps/api/src/routes/health.ts`, line 137); a missing role, a wrong password or host, or Railway's public host instead of the private one gives 503.                                                                                                                                                                                                                                                                                                                                                                                                                           | Healthcheck attempts fail **with status 503** (not "service unavailable"). Today the body reads `database: down` for this case and `schema: down` for missing migrations (`apps/api/src/routes/health.ts:138-175`). Check from your machine with `psql` and the same URL; a 2 s timeout is the probe's deadline (`packages/database/src/schema-readiness.ts:98`).                                                                                                                                                                                 |
| H4  | **Build or start command not configured.** The live config was entered by hand (`.railway/railway.ts` says it was never applied, line 9). The root `pnpm build` builds only `packages/*` (`package.json:13`), so a default Railpack build never builds the Next apps; the root has no `start` script, and `api` / `worker` have no build output (they run `tsx`).                                                                                                                                                                                                                                                                                                                                                          | Build Logs show which command ran. Deploy Logs show `Could not find a production build in the '.next' directory` (dashboard, admin), or `Missing script: start`, or `tsx: not found`. Compare each service's Settings with §3.                                                                                                                                                                                                                                                                                                                    |
| H5  | **A redirect.** Unlikely for `/en/reset`: the path has a locale, so the middleware does not redirect it (`apps/dashboard/src/middleware.ts`, the `hasLocale` branch), and the page needs no database.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Healthcheck attempts fail with status 307 or 308.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| H6  | **Healthcheck timeout.** Unlikely: nothing at `590717e` waited on anything slow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | No error lines; the process is still starting when Railway prints that the healthcheck failed. Compare the service's timeout (Railway default, or `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`) with the start time in the logs.                                                                                                                                                                                                                                                                                                                             |

**New ways the next attempt can fail, which `590717e` could not:**

- **Migrations not applied.** All four services answer 503 until every one of the 91 migrations
  is recorded as finished (§3). Deploy Logs of dashboard and admin show
  `not ready: migrations pending`; the worker logs `worker waiting for migrations`.
- **Migration `20261005090000_runtime_roles_read_migration_history` missing or failed.** Without
  SELECT on `_prisma_migrations` the readiness query is refused, and the probe reports
  `database: down` (not `schema: down`) on all four, because the error is caught as "could not
  ask" (`schema-readiness.ts:107-115`). The migration runs as `brandspace_migrator` and grants on
  `_prisma_migrations`; if that table was created by another role (for example an early
  migration run as Railway's superuser), the GRANT can fail. Check the table's owner first.
- **`CLIENT_ORIGIN_STRATEGY`** did not exist at `590717e`. It is now required on `dashboard` and
  `api` (`env.ts:606-649`). A hand-entered config will not have it.

## 3. What each service needs to pass its healthcheck on a fresh production

Common to all four: source `Mohamed-Omaar/BrandSpace-Platform`, root directory = repository root,
builder Railpack, `APP_ENV=production`, `NODE_ENV=production`. Railway probes the port in `PORT`.
The environment check runs first; if it throws, nothing listens.

The readiness rule used by all four: every name in `EXPECTED_MIGRATIONS` is in
`_prisma_migrations` with `finished_at` set and `rolled_back_at` empty
(`packages/database/src/schema-readiness.ts:57-70`). Extra migrations in the database are fine.

### dashboard

| Item          | Value                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build command | `pnpm --filter @brandspace/database exec prisma generate && pnpm --filter @brandspace/dashboard build` (`.railway/railway.ts:383`). `DATABASE_URL` must be present at build time.                                                                    |
| Start command | `pnpm --filter @brandspace/dashboard start` → `next start --port 3001`                                                                                                                                                                               |
| Port          | `PORT=3001`, pinned (`.railway/railway.ts:77`; the script ignores `PORT`)                                                                                                                                                                            |
| Healthcheck   | **Change `/en/reset` to `/api/health/ready`.** It reads `_prisma_migrations` on the tenant pool: 200 when all migrations are applied, 503 otherwise (`apps/dashboard/src/app/api/health/ready/route.ts:28`). `/en/reset` only proves a page renders. |
| Startup check | `validateStartupConfiguration(process.env, 'dashboard')` in `apps/dashboard/src/instrumentation.ts:21`                                                                                                                                               |
| Database role | `brandspace_app` (`DATABASE_URL`). Never the platform role.                                                                                                                                                                                          |
| Migrations    | All 91 applied, and `20261005090000` grants it SELECT on `_prisma_migrations`                                                                                                                                                                        |
| Redis         | Not needed for the healthcheck. Needed to queue uploads and ingestion (production never runs queued work inline).                                                                                                                                    |

### api

| Item          | Value                                                                                                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build command | `pnpm --filter @brandspace/database exec prisma generate` (`.railway/railway.ts:520`). No app build: it runs TypeScript through `tsx`, a runtime dependency.                                                                                        |
| Start command | `pnpm --filter @brandspace/api start` → `tsx src/server.ts`                                                                                                                                                                                         |
| Port          | Reads `PORT` (default 3003, `apps/api/src/server.ts`, the listener). Set `PORT=3003`, because dashboard and admin reach it at `http://api.railway.internal:3003` (`BRANDSPACE_API_URL`).                                                            |
| Healthcheck   | `/health/ready` (`apps/api/src/routes/health.ts:37`). Required: `database` and `schema`. Reported, not required: `queue` (is `REDIS_URL` set), `object-storage` (is the `STORAGE_*` set complete), `tracing`. 503 only when a required check fails. |
| Startup check | `validateStartupConfiguration(process.env, 'api')` (`apps/api/src/server.ts`, `buildServer`)                                                                                                                                                        |
| Database role | `brandspace_app` (`DATABASE_URL`, used by the probe) and `brandspace_platform` (`DATABASE_PLATFORM_URL`)                                                                                                                                            |
| Migrations    | All 91. The maintenance scheduler starts only after they are applied.                                                                                                                                                                               |
| Redis         | Not needed for the healthcheck. Needed for background work.                                                                                                                                                                                         |

### admin

| Item          | Value                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Build command | `pnpm --filter @brandspace/database exec prisma generate && pnpm --filter @brandspace/admin build` (`.railway/railway.ts:450`)      |
| Start command | `pnpm --filter @brandspace/admin start` → `next start --port 3002`                                                                  |
| Port          | `PORT=3002`, pinned                                                                                                                 |
| Healthcheck   | `/api/health/ready`. Same rule as the dashboard, read on the **platform** pool (`apps/admin/src/app/api/health/ready/route.ts:28`). |
| Startup check | `validateStartupConfiguration(process.env, 'admin')` (`apps/admin/src/instrumentation.ts:21`)                                       |
| Database role | `brandspace_platform` (probe, Control Center) and `brandspace_app` (`DATABASE_URL`, required at boot)                               |
| Migrations    | All 91                                                                                                                              |
| Redis         | Not needed for the healthcheck                                                                                                      |

### worker

| Item          | Value                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build command | `pnpm --filter @brandspace/database exec prisma generate`                                                                                                                                              |
| Start command | `pnpm --filter @brandspace/worker start` → `tsx src/main.ts`                                                                                                                                           |
| Port          | `WORKER_PORT=3004` **and** `PORT=3004`. The probe listens on `WORKER_PORT` (`apps/worker/src/main.ts:107`); Railway probes `PORT`.                                                                     |
| Healthcheck   | `/` (any path). 503 `waiting_for_migrations` until the migrations are applied, then 200 while the consumer runs (`main.ts:108-117`, `:125`).                                                           |
| Startup check | `validateStartupConfiguration(process.env, 'worker')` (`main.ts:66`). A throw ends in `process.exit(1)` (`main.ts:356`). Without `REDIS_URL` it exits 1 **before** the probe starts (`main.ts:81-89`). |
| Database role | `brandspace_app`                                                                                                                                                                                       |
| Migrations    | All 91                                                                                                                                                                                                 |
| Redis         | **Required** — no Redis, no process.                                                                                                                                                                   |

### migration job (already up)

Start command `pnpm --filter @brandspace/database exec prisma migrate deploy`, variables
`DATABASE_MIGRATION_URL` and `NODE_ENV` only, no domain, no healthcheck, restart `NEVER`
(`docs/RAILWAY-DEPLOYMENT.md` §4.1). `prisma.config.ts` reads `DATABASE_MIGRATION_URL` first and
falls back to `DATABASE_URL`; with only the former set, a mistake fails instead of migrating as
the app role.

### Database roles (before any migration)

`scripts/sql/setup-database-roles.sql` must have run **as the instance owner** before the first
migration. It creates `brandspace_migrator`, `brandspace_app` and `brandspace_platform` (all
`NOBYPASSRLS`, none superuser), makes `brandspace_migrator` own schema `public`, and refuses to
finish if a check fails. **(owner)** `db-setup` is up; what it runs is not in this repository
(`docs/RAILWAY-DEPLOYMENT.md` §4.3). Confirm the three roles exist (`\du` as the instance owner)
rather than assume it.

## 4. Release path, in order

1. **One PR, `staging` → `main`.** Merged only on the owner's word. Before merging, decide whether
   auto-deploy should fire on merge; if it does, steps 3-4 must already be prepared, because the
   four services deploy at once.
2. **Database roles.** Confirm the three roles exist and that `_prisma_migrations` is owned by
   `brandspace_migrator` (§2). If the roles are missing, run `setup-database-roles.sql` as the
   instance owner (`pnpm db:roles` prints the command).
3. **Migration job.** Redeploy `migration` from the new `main`. Wait until it exits 0. Confirm with
   `prisma migrate status` against `DATABASE_MIGRATION_URL`: nothing pending, 91 applied.
4. **Services: dashboard, api, admin, worker.** For each: set the build and start commands, `PORT`
   (and `WORKER_PORT`), the healthcheck path, the **pre-deploy command** below and the variables in §5,
   then deploy.
   - **Pre-deploy command** (Settings → Deploy → Pre-deploy Command), the same on all four:
     `pnpm --filter @brandspace/database wait-for-migrations`. It waits, before the release starts,
     until the database holds every migration that release needs, so the healthcheck clock never runs
     out on a migration that is merely slower than the deploy (the #80 race, where admin was marked
     FAILED; `docs/RAILWAY-DEPLOYMENT.md` §4.5). It reads `_prisma_migrations` with the service's own
     `DATABASE_URL` and never migrates. Optional: `WAIT_FOR_MIGRATIONS_TIMEOUT_SECONDS` (default 1800).
     If it gives up, the deployment stops and the previous release keeps serving: let `migration`
     finish, then redeploy.
   - **Staging too:** set the same pre-deploy command on staging's four services before the next merge. Before deploying,
     run the startup contract locally on your own machine against a copy of each service's
     variables:
     `pnpm staging:preflight --env-dir <dir>` (files `<dir>/dashboard.env`, `api.env`, `admin.env`,
     `worker.env`), or `--env-file <file> --service <name>`. It prints names and statuses, never
     values. **It is written for staging:** its first line will say `APP_ENV … staging must set
APP_ENV=staging` and its verdict will be "not ready" for that reason alone. Ignore that line;
     read the `startup contract` lines, which run the real production rules
     (`scripts/staging-preflight.ts:162-171`, `:194-200`). Each service then reaches 2xx only after
     step 3.
5. **The first owner account.** Before any configuration: the Control Center needs a platform
   account to sign in. From your machine: `railway link` (production), `railway ssh --service api`,
   then `BOOTSTRAP_PLATFORM_OWNER_EMAIL='<your address>' pnpm bootstrap:production-owner` at a real
   terminal. It prompts for the password; `BOOTSTRAP_PLATFORM_OWNER_PASSWORD` exists only as a
   process-local fallback for a shell that cannot prompt, never as a Railway variable
   (`packages/database/prisma/bootstrap-production-owner.ts:710`). It refuses unless
   `APP_ENV=production`, `NODE_ENV=production`, `DATABASE_PLATFORM_URL` and
   **`SECRET_VAULT_KEK`** are set and not placeholders, `SECRET_VAULT_KMS_KEY_ARN` is set (with the
   AWS pair), and stdin/stdout are a TTY (`bootstrap-owner-guards.ts:152-185`, `:203`, `:235`).
   Note: `SECRET_VAULT_KEK` is demanded by the guard even though the KMS key is what seals in
   production (`packages/vault/src/key-provider.ts:319`); `docs/RAILWAY-DEPLOYMENT.md` §24.2
   does not list it. Scan the QR, enter the code, store the recovery codes.
6. **Configuration.** Sign in to the Control Center with MFA and activate the documents in
   `docs/production-config/` in the order its README gives (`plans` first, then `commerce`, …).
7. **Secrets and providers.**
   - Storage: the `STORAGE_*` variables on dashboard, api and worker (step 4). Then Integrations →
     Storage → Cloudflare R2: press **Activate** so the readiness row names it, and press **Test
     connection**. The Control Center asks the API to write, read back and delete one small file
     with the API's own bucket key (`POST /v1/internal/storage/self-test`, service token); the
     screen shows only whether each step worked. It needs `BRANDSPACE_API_URL` and
     `INTERNAL_SERVICE_TOKEN` on admin (§5).
   - Scanner: off. `assets.json` already says so. Do not set `SCANII_*`.
   - Email: after step 8, so links use the final domain (below).
8. **Domains.** Dashboard, api and admin on `brandspace.cc` subdomains of your choice; `landing`
   stays on `www`. The first boot already needs https origins (`PUBLIC_DASHBOARD_BASE_URL` on
   dashboard and api, `PUBLIC_API_BASE_URL` on admin and api), so either attach the custom domains
   before step 4, or start with Railway's generated `*.up.railway.app` domains and switch. After
   switching, update those two variables and redeploy the services that carry them. Every email
   link and OAuth callback is built from them.
9. **Email.** Verify `brandspace.cc` in Resend (`docs/production-config/EMAIL-DNS.md`), then
   Integrations → Email → Resend: key, From, Save, **Test connection**, Activate
   (`docs/production-config/README.md` §3.1). The Test sends one message to the signed-in
   owner's own address and to nobody else; check that inbox. Then confirm with one real signup.
10. **Readiness check** (Control Center home). Expected rows:
    - Ready: trial (`starter`, 90 days, priced in USD, every quota set), password (12), sender
      (Brandspace), post kinds, industries.
    - Beta only (counted as passing): scanner (off), legal (draft, review pending).
    - Not required while payments are off: payment, plans.
    - Ready after a passing Test (steps 7 and 9): email (Resend) and storage (Cloudflare R2).
      If either still reads "Switched on, but the connection has not been tested yet", press its
      Test; a failed Test names the step that failed and never shows a key or a bucket.
    - **Not ready, knowingly:** AI (required in production, and off for the beta). The verdict
      therefore reads "not ready"; record that as accepted for the closed beta.

## 5. Every variable each production service needs (names only)

Compare these with each service's Variables tab in Railway. "Forbidden" means the service refuses
to start if the variable is present.

### dashboard

- **Required at boot:** `NODE_ENV`, `APP_ENV`, `PORT` (3001), `DATABASE_URL`,
  `CUSTOMER_SESSION_SECRET`, `CUSTOMER_MFA_VAULT_KMS_KEY_ARN`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `PUBLIC_DASHBOARD_BASE_URL` (https), `CLIENT_ORIGIN_STRATEGY`
  (`railway-edge`)
- **Required to work:** `REDIS_URL`, `BRANDSPACE_API_URL` (`http://api.railway.internal:3003`),
  `INTERNAL_SERVICE_TOKEN` (without it the dashboard sends no email), `STORAGE_ENDPOINT`,
  `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`
- **Optional:** `CUSTOMER_MFA_VAULT_KEK` (permitted, unused in production), `STORAGE_REGION`,
  `STORAGE_FORCE_PATH_STYLE`, `DATA_REGION`, `LOG_LEVEL`, `OTEL_SERVICE_NAME`,
  `OTEL_EXPORTER_OTLP_ENDPOINT`, `PUBLIC_API_BASE_URL` / `PUBLIC_WEB_URL` (https if set)
- **Forbidden:** `DATABASE_PLATFORM_URL`, `PLATFORM_SESSION_SECRET`, `SECRET_VAULT_KMS_KEY_ARN`,
  `SECRET_VAULT_KEK`, `SOCIAL_TOKEN_VAULT_KMS_KEY_ARN`, `SOCIAL_TOKEN_VAULT_KEK`,
  `BILLING_DEV_WEBHOOK_SECRET`, `TRUSTED_PROXY_HOPS`
- **Never:** `DATABASE_MIGRATION_URL` (policy, not checked at boot)

### api

- **Required at boot:** `NODE_ENV`, `APP_ENV`, `PORT` (3003), `DATABASE_URL`,
  `DATABASE_PLATFORM_URL`, `SECRET_VAULT_KMS_KEY_ARN`, `SOCIAL_TOKEN_VAULT_KMS_KEY_ARN`,
  `CUSTOMER_MFA_VAULT_KMS_KEY_ARN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `PUBLIC_API_BASE_URL` (https), `PUBLIC_DASHBOARD_BASE_URL` (https), `CLIENT_ORIGIN_STRATEGY`
  (`railway-edge`)
- **Required to work:** `REDIS_URL`, `INTERNAL_SERVICE_TOKEN`, `STORAGE_ENDPOINT`,
  `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`
- **Optional:** `SECRET_VAULT_KEK` (needed only by the owner bootstrap guard, §4 step 5),
  `SOCIAL_TOKEN_VAULT_KEK`, `CUSTOMER_MFA_VAULT_KEK`, `STORAGE_REGION`, `STORAGE_FORCE_PATH_STYLE`,
  `DATA_REGION`, `LOG_LEVEL`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `AWS_REGION`
- **Forbidden:** `CUSTOMER_SESSION_SECRET`, `PLATFORM_SESSION_SECRET`,
  `BILLING_DEV_WEBHOOK_SECRET`, `TRUSTED_PROXY_HOPS`

### admin

- **Required at boot:** `NODE_ENV`, `APP_ENV`, `PORT` (3002), `DATABASE_URL`,
  `DATABASE_PLATFORM_URL`, `PLATFORM_SESSION_SECRET`, `SECRET_VAULT_KMS_KEY_ARN`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `PUBLIC_API_BASE_URL` (https)
- **Required to work:** `REDIS_URL`, `BRANDSPACE_API_URL` (`http://api.railway.internal:3003`),
  `INTERNAL_SERVICE_TOKEN`
- **Optional:** `SECRET_VAULT_KEK`, `PUBLIC_DASHBOARD_BASE_URL` / `PUBLIC_WEB_URL` (https if set),
  `DATA_REGION`, `LOG_LEVEL`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`
- **Forbidden:** `CUSTOMER_SESSION_SECRET`, `SOCIAL_TOKEN_VAULT_KMS_KEY_ARN`,
  `SOCIAL_TOKEN_VAULT_KEK`, `CUSTOMER_MFA_VAULT_KMS_KEY_ARN`, `CUSTOMER_MFA_VAULT_KEK`,
  `BILLING_DEV_WEBHOOK_SECRET`
- **Not given, by design:** `STORAGE_*`, `CLIENT_ORIGIN_STRATEGY` (not read by admin)

### worker

- **Required at boot:** `NODE_ENV`, `APP_ENV`, `PORT` (3004), `WORKER_PORT` (3004),
  `DATABASE_URL`, `SOCIAL_TOKEN_VAULT_KMS_KEY_ARN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `REDIS_URL`
- **Required to work:** `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`,
  `STORAGE_SECRET_ACCESS_KEY`
- **Only when Scanii is turned on:** `SCANII_API_KEY`, `SCANII_API_SECRET` (new in PR F)
- **Optional:** `SOCIAL_TOKEN_VAULT_KEK`, `STORAGE_REGION`, `STORAGE_FORCE_PATH_STYLE`,
  `BRANDSPACE_POSTGRES_PRIVATE_HOST` (read by no code), `DATA_REGION`, `LOG_LEVEL`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`
- **Forbidden:** `DATABASE_PLATFORM_URL`, `CUSTOMER_SESSION_SECRET`, `PLATFORM_SESSION_SECRET`,
  `INTERNAL_SERVICE_TOKEN`, `SECRET_VAULT_KMS_KEY_ARN`, `SECRET_VAULT_KEK`,
  `CUSTOMER_MFA_VAULT_KMS_KEY_ARN`, `CUSTOMER_MFA_VAULT_KEK`, `BILLING_DEV_WEBHOOK_SECRET`

### migration job

`DATABASE_MIGRATION_URL`, `NODE_ENV`. Nothing else.

### Rules across services

- No placeholder text (`change-me`, `placeholder`, `example`, `devonly`, `localhost`,
  `replace_with`, `ci-only`, `test-only`) in any variable whose name contains `SECRET`, `KEK`,
  `PASSWORD` or `KEY` (`env.ts:680-699`). That includes `AWS_*`, `STORAGE_*_KEY*` and `SCANII_*`.
- `CUSTOMER_SESSION_SECRET` ≠ `PLATFORM_SESSION_SECRET`; `DATABASE_PLATFORM_URL` ≠
  `DATABASE_URL`; the three KMS ARNs all different; the KEKs all different (`env.ts:507-516`,
  `:658-678`).
- Every `PUBLIC_*` URL that is set is `https://` (`env.ts:564-572`).
- Each service has its **own** AWS key pair, scoped to its own keys only.
- `BILLING_DEV_WEBHOOK_SECRET` is set nowhere (`env.ts:755`).
- Session secrets and `INTERNAL_SERVICE_TOKEN` are at least 32 characters (`env.ts` schema).

## 6. Rollback

- **If a new deployment never passes its healthcheck,** Railway does not switch traffic to it, and
  whatever was serving keeps serving. Since the September deployments failed, check in the
  Deployments tab what, if anything, is active on each service before you start.
- **Redeploying an older deployment reverts code, not the schema.** Migrations are forward-only
  (`docs/OPERATIONS.md` §6). Each migration is written to work with **the release just before
  it**, not with code 50 migrations older. Once step 3 has applied migrations 42-91, redeploying
  `590717e`-era code onto that schema is an untested combination. Prefer to fix forward: correct
  the variable or setting the Deploy Logs name, and redeploy the same commit. A newer database is
  still "ready" for older code that knows fewer migrations (`schema-readiness.ts:18-22`).
- **Configuration** is never edited in place. Control Center → Configuration → the domain → the
  version history → **Roll back** on an earlier version, with a reason of 8+ characters. It creates
  a new version with the old payload and activates it, with high-impact changes pre-acknowledged
  (`rollback`, `packages/config/src/service.ts:738`). For `plans`, `commerce` and `credits`, the
  dual-control rule applies to the rollback too: only the `platform_owner` may roll back a version
  they created themselves.
- **Turning things off by configuration**, without a deploy:
  - close signup: `onboarding.signup.open: false` (invitation only);
  - stop email: Integrations → Email → Resend → Disable;
  - channels: already `enabled: false` for every channel in `publishing`;
  - payments: already off (`commerce.payments.enabled: false`);
  - a flagged feature: a `killSwitch` in `feature-flags` wins over every other rule.

## 7. Documentation that disagrees with the code

Listed only; those files were not edited.

**`docs/RAILWAY-DEPLOYMENT.md`**

1. §0.3 says production refuses when `PUBLIC_WEB_URL` or `PUBLIC_API_BASE_URL` is `http://`, that
   the schema defaults are `http://localhost`, and that "the API and the worker" run the check.
   Now: no localhost defaults; the required URLs are per service (`PROFILE_PUBLIC_URLS`,
   `env.ts:396`): dashboard `PUBLIC_DASHBOARD_BASE_URL`, admin `PUBLIC_API_BASE_URL`, api both,
   worker none; `PUBLIC_WEB_URL` is required by nobody. All five services run the check (the Next
   apps in `instrumentation.ts`).
2. §11's table is outdated: it gives `/` for dashboard, admin and web (dashboard and admin are now
   `/api/health/ready`, web `/en/status`; a bare `/` answers 307), describes `/health/ready` as
   database-only (it also requires `schema`), and says "The Next.js apps have no dedicated health
   route". §2 and §4.4 have the correct paths.
3. `CLIENT_ORIGIN_STRATEGY` appears nowhere in the document, including §20 step 10's list of what
   to set, although dashboard and api refuse to start without it.
4. §20 step 10 and step 17 speak of "six public URLs". Three are read (`PUBLIC_API_BASE_URL`,
   `PUBLIC_DASHBOARD_BASE_URL`, and `PUBLIC_WEB_URL` by nobody); `DASHBOARD_URL`, `ADMIN_URL` and
   `API_URL` are read by no code (`env.ts` comment above `PUBLIC_URL_NAMES`).
5. §24.2 does not say the bootstrap also requires `SECRET_VAULT_KEK`
   (`bootstrap-owner-guards.ts:172-176`).
6. §1.3 says the dashboard and worker hold `CUSTOMER_MFA_VAULT_KEK` / `SOCIAL_TOKEN_VAULT_KEK`; in
   production what they must hold is the matching KMS ARN.
7. No mention of `SCANII_API_KEY` / `SCANII_API_SECRET` or of scanning being off for the beta.
8. ~~§20 step 21: Resend and Cloudflare R2 have no Test Connection~~ — both have one since the #79
   review (D-516); step 21 is accurate again.

**`docs/RAILWAY-ENVIRONMENT-MATRIX.md`**

1. The per-service summary table has no `CLIENT_ORIGIN_STRATEGY` row (class D says it is required
   on dashboard and api).
2. No `SCANII_API_KEY` / `SCANII_API_SECRET` rows (worker, only when Scanii is on).
3. Class C says `SECRET_VAULT_KEK` is "not required in production"; the owner bootstrap requires
   it (`bootstrap-owner-guards.ts:172-176`).
4. Class C and the rules list say the KEK provider is refused "when `NODE_ENV=production`"; the
   key provider now refuses it when `APP_ENV=production` (`packages/vault/src/key-provider.ts:355`).
5. Class A says `PORT` is pinned "to the port each app's `start` script already uses". True for the
   three Next apps; the api reads `PORT` itself and the worker's probe reads `WORKER_PORT`.

**`docs/RAILWAY-SMOKE-TEST.md`**

1. §2 checks only the api's `/health/ready` for `database`; it does not check `schema`, the
   dashboard's and admin's `/api/health/ready`, or that the worker answers 503
   `waiting_for_migrations` before migrations.
2. §5 expects `/health/ready` to show `queue` down after stopping Redis. The `queue` check only
   reports whether `REDIS_URL` is set (`apps/api/src/routes/health.ts:63`), so
   it stays `ok` while Redis is stopped.
3. §6 says unsetting `STORAGE_BUCKET` on the **dashboard** makes `/health/ready` report
   `object-storage: not_configured`. That check exists only on the **api**, and reads the api's own
   variables.
4. §1 says an environment crash loop is "on `api` or `worker`"; dashboard and admin refuse the same
   way (their `instrumentation.ts`).
5. No step covers scanning being off (`assets.scanning.provider: "none"`), or Scanii.

**Also stale, outside those three files:** the comment in `.railway/railway.ts:232-241` still says
`assertProductionSafety` refuses an `http://` `PUBLIC_WEB_URL` or `PUBLIC_API_BASE_URL` on every
service and that the schema defaults are `http://localhost`.
