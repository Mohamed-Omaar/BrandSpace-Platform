# BrandSpace on Railway — Deployment Blueprint

> **الملخص التنفيذي بالعربية**
>
> هذه الوثيقة هي **مخطط النشر** على Railway. لم يُنشأ أي مشروع، ولم يُنشر أي شيء، ولم تُضف أي بيانات اعتماد حقيقية، ولم يُفعّل أي مزوّد خارجي.
> تصف الوثيقة الخدمات الخمس المطلوبة، وقاعدة البيانات بثلاثة أدوار ذات صلاحيات دنيا، وRedis، والتخزين، والمتغيرات البيئية، وترتيب التنفيذ المستقبلي.
> **ثلاث حقائق يجب قراءتها قبل أي نشر:** (١) لا يجوز إعطاء أي خدمة `DATABASE_URL` الذي تنشئه Railway لأنه حساب مالك القاعدة ويُبطل عزل المستأجرين؛ (٢) لا يوجد في المستودع محوّل تخزين S3 بعد، لذا سيرفض الإنتاج رفع الملفات؛ (٣) لا يوجد مزوّد بريد، لذا سيفشل تحقق البريد الإلكتروني بصوت عالٍ بدل الادعاء بالنجاح.

**Status: blueprint only.** No Railway project exists. Nothing has been deployed.
No production credential has been added. No external provider has been activated.
`railway config apply` has not been run.

Read this document before `.railway/railway.ts`. The file carries the decisions;
this carries the reasons.

| Companion document                   | What it holds                                            |
| ------------------------------------ | -------------------------------------------------------- |
| `docs/RAILWAY-ENVIRONMENT-MATRIX.md` | Every environment variable, its source, and who needs it |
| `docs/RAILWAY-SMOKE-TEST.md`         | What to verify on the first deployment, in order         |
| `docs/OPERATIONS.md`                 | Backup, restore and incident procedure (pre-dates this)  |
| `docs/SECURITY.md`                   | The tenancy and secret architecture this preserves       |

---

## 0. Three findings that change the plan

Discovery against the repository — not assumption — turned up three things that
a generic Railway blueprint would have got wrong. They are stated first because
each one changes what the owner should expect from the first deployment.

> **Revised after the production-adapters pass.** §0.2 described a missing S3
> adapter and named Railway Buckets as the target. Both have changed: the
> adapter exists, and the target is Cloudflare R2, outside Railway entirely.
> The original finding is kept below, struck through, because the reasoning it
> records — why a container filesystem is not storage — is what the new answer
> is built on. §6 is rewritten accordingly. Transactional email moved the same
> way: §16 no longer describes a capability that waits on code.

### 0.1 Railway's PostgreSQL credential must never reach an application service

Railway provisions Postgres with one credential, and it is the instance owner.
BrandSpace's entire tenant isolation model (`docs/SECURITY.md` §2.4) rests on the
opposite: three roles, none of them superuser, none of them owning the tables
they read. PostgreSQL does not enforce row-level security against a table's
owner, and ignores it entirely for a superuser. So handing Railway's
`DATABASE_URL` to the dashboard would not weaken isolation — it would end it,
silently, while every test in the repository still passed.

The three roles are created **after** provisioning, by the owner, with
`scripts/sql/setup-database-roles.sql`. §3 has the procedure.

### 0.2 ~~There is no S3 adapter, so production uploads fail closed~~ — RESOLVED

**Superseded.** The original finding read:

> `packages/storage` defines an `ObjectStore` interface and ships exactly one
> implementation — `FilesystemObjectStore` — which `createObjectStore()` refuses
> to return when `APP_ENV=production`. There is no S3 client anywhere in the
> repository … So the `STORAGE_*` contract exists and nothing consumes it.
> **Asset upload cannot work on the first deployment.**

`packages/storage/src/s3-object-store.ts` now implements `ObjectStore` against
the S3 protocol, and `createObjectStore()` returns it in production when the
`STORAGE_*` contract is complete. What did **not** change is the refusal: an
incomplete contract in production throws and names the missing variables, and
the filesystem store is still unreachable there. Production never silently
falls back to local disk, `/tmp` or memory.

The target is **Cloudflare R2**, not Railway Buckets — §6 has the reasoning.
Nothing above `packages/storage` knows either name: the adapter speaks generic
S3 to an endpoint, so moving to AWS S3, MinIO or Backblaze is a change of five
environment variables.

**Asset upload works on the first deployment, once the owner supplies the five
`STORAGE_*` values.** It is no longer a blocker; it is a configuration step,
and §22 lists it as one.

### 0.3 Public URLs must exist before the first production boot succeeds

`assertProductionSafety` refuses to start a production process whose
`PUBLIC_WEB_URL` or `PUBLIC_API_BASE_URL` begins with `http://`, and the schema
defaults are `http://localhost:…`. The API and the worker call
`validateStartupConfiguration()` on the way up and **throw** in production.

So a domain — even a generated `*.up.railway.app` one — has to exist before the
API will start at all. The deployment order in §20 is arranged around this; the
generic "deploy, then add domains" sequence would produce a crash-looping API
and a confusing first hour.

---

## 1. The runtime, as the repository defines it

### 1.1 Processes

Five, from `pnpm-workspace.yaml` and the five `apps/*/package.json` files.

| App              | Package                 | Kind    | Start script             | Listens on              |
| ---------------- | ----------------------- | ------- | ------------------------ | ----------------------- |
| `apps/web`       | `@brandspace/web`       | Next.js | `next start --port 3000` | 3000 (hard-coded)       |
| `apps/dashboard` | `@brandspace/dashboard` | Next.js | `next start --port 3001` | 3001 (hard-coded)       |
| `apps/admin`     | `@brandspace/admin`     | Next.js | `next start --port 3002` | 3002 (hard-coded)       |
| `apps/api`       | `@brandspace/api`       | Fastify | `tsx src/server.ts`      | `PORT` ?? 3003, 0.0.0.0 |
| `apps/worker`    | `@brandspace/worker`    | BullMQ  | `tsx src/main.ts`        | `WORKER_PORT` ?? 3004   |

No sixth process is invented. The API hosts the maintenance scheduler in-process
(`apps/api/src/server.ts`), so there is no separate cron service.

### 1.2 Two facts about how these run

**The Next.js start scripts hard-code their ports.** `next start --port 3000`
ignores an assigned `PORT`. Rather than shadow the shipped scripts with start
commands that have to be kept in step with `package.json`, the blueprint pins
`PORT` to the port each script already uses. Private-network addresses become
deterministic as a side effect: `http://api.railway.internal:3003`.

**The API and worker execute TypeScript directly.** Neither has a build script.
Both run `tsx`, and both import `.ts` source from workspace packages
(`packages/*/package.json` sets `"main": "./src/index.ts"`). Package `build`
scripts emit declarations only — `tsc --emitDeclarationOnly` — so there is no
compiled JavaScript to run.

**`tsx` is therefore a RUNTIME dependency, and is now declared as one.** It was
a `devDependency`, which made any dev-dependency-pruning build crash on start
with `tsx: not found` — after the image was built, after the deploy was
accepted, at the moment traffic arrived. It has been moved to `dependencies` in
`apps/api/package.json` and `apps/worker/package.json`, the lockfile records it
there, and `tests/unit/production-runtime.test.ts` fails if either regresses.
Verified by a real production-only install (`pnpm deploy --prod`) of both
services: `tsx` resolves and executes in the pruned tree, and `typescript` is
correctly absent from it.

### 1.3 Which process needs which capability

Read from the source, not assumed.

| Capability                                  | web |   dashboard   | admin |      api      |    worker     |
| ------------------------------------------- | :-: | :-----------: | :---: | :-----------: | :-----------: |
| Tenant database (`DATABASE_URL`)            |  —  |      ✅       |  ✅   |      ✅       |      ✅       |
| Platform database (`DATABASE_PLATFORM_URL`) |  —  |       —       |  ✅   |      ✅       |       —       |
| Redis / BullMQ                              |  —  | ✅ (producer) |  ✅   | ✅ (producer) | ✅ (consumer) |
| Customer session secret                     |  —  |      ✅       |   —   |       —       |       —       |
| Platform session secret                     |  —  |       —       |  ✅   |       —       |       —       |
| `SECRET_VAULT_KEK`                          |  —  |       —       |  ✅   |      ✅       |       —       |
| `SOCIAL_TOKEN_VAULT_KEK`                    |  —  |       —       |   —   |      ✅       |      ✅       |
| `CUSTOMER_MFA_VAULT_KEK`                    |  —  |      ✅       |   —   |      ✅       |       —       |
| Object storage                              |  —  |      ✅       |   —   |      ✅       |      ✅       |
| Public ingress                              | ✅  |      ✅       |  ✅   |      ✅       |       —       |

**On the API holding the platform credential.** The comment in
`packages/shared/src/env.ts` says `DATABASE_PLATFORM_URL` should be absent from
"tenant-facing API processes". The API as built is not purely tenant-facing: it
hosts the maintenance scheduler and the billing-webhook and onboarding paths,
eight of its route modules import `@brandspace/database/platform`. The blueprint
reflects the code as written rather than the comment's intent, and flags the
divergence: splitting the platform surface out of the API is a real
architectural question, and not one a deployment blueprint should decide.

**On the key domains.** Each process gets only the key domains it uses. The
dashboard verifies a TOTP code at sign-in so it holds `CUSTOMER_MFA_VAULT_KEK`
and neither of the others — a login request must not be able to unwrap a
platform provider credential. The worker unwraps customer social tokens when
publishing, so it holds `SOCIAL_TOKEN_VAULT_KEK` alone. This is D-136 and D-206
expressed as a deployment topology.

### 1.4 Region, and a residency problem

`docs/DECISIONS.md` D-03 wants GCC / Middle East data residency. **Railway has no
Middle East region.** At the time of writing it offers, by slug:

| Region                     | Slug                     |
| -------------------------- | ------------------------ |
| US West (California)       | `us-west2`               |
| US East (Virginia)         | `us-east4-eqdc4a`        |
| EU West (Amsterdam)        | `europe-west4-drams3a`   |
| Southeast Asia (Singapore) | `asia-southeast1-eqsg3a` |

The blueprint uses **EU West** as the closest region with a comparable legal
regime, and sets `DATA_REGION=eu-west` so the platform reports where it actually
is rather than where it was intended to be.

**This is an owner decision, not a default.** If GCC residency is a commitment
already made to customers, Railway cannot satisfy it and the platform choice has
to be revisited before launch, not after. Verify the slugs in the Railway
dashboard before the first apply — region identifiers are Railway's to change and
these were not read from a live project.

---

## 2. Topology

### Public services

| Service     | Why public                                                                        |
| ----------- | --------------------------------------------------------------------------------- |
| `web`       | The marketing site                                                                |
| `dashboard` | The customer application                                                          |
| `admin`     | The Platform Control Center — internal staff, but over the internet               |
| `api`       | `PUBLIC_API_BASE_URL` is what OAuth callbacks and future payment webhooks address |

The API is public **only** for inbound callbacks. The dashboard and Control
Center reach it over the private network at `http://api.railway.internal:3003`;
no internal traffic leaves Railway.

### Private services

| Service    | Why private                                                                 |
| ---------- | --------------------------------------------------------------------------- |
| `worker`   | Consumes queues. Its liveness endpoint is for Railway's probe, nobody else. |
| `postgres` | No public URL, no TCP proxy                                                 |
| `redis`    | No public URL, no TCP proxy                                                 |

There is **no Railway Bucket**. Object storage is Cloudflare R2, outside the
project entirely — §6.1 has the reasoning and says to delete one if the earlier
revision of this blueprint led to it being created.

### Per-service configuration

Every service: source `Mohamed-Omaar/BrandSpace-Platform`, root directory the
repository root, builder Railpack, restart `ON_FAILURE` with 10 retries, one
replica, region EU West.

| Service     | Build command                                        | Start command                               | Healthcheck     | Drain | Watch paths                                                       |
| ----------- | ---------------------------------------------------- | ------------------------------------------- | --------------- | ----- | ----------------------------------------------------------------- |
| `web`       | _(Railpack default)_                                 | `pnpm --filter @brandspace/web start`       | `/`             | 30 s  | `apps/web/**`, `packages/ui/**`, `packages/shared/**`, root files |
| `dashboard` | `prisma generate && pnpm --filter …/dashboard build` | `pnpm --filter @brandspace/dashboard start` | `/`             | 30 s  | `apps/dashboard/**`, `packages/**`, root files                    |
| `admin`     | `prisma generate && pnpm --filter …/admin build`     | `pnpm --filter @brandspace/admin start`     | `/`             | 30 s  | `apps/admin/**`, `packages/**`, root files                        |
| `api`       | `prisma generate`                                    | `pnpm --filter @brandspace/api start`       | `/health/ready` | 30 s  | `apps/api/**`, `packages/**`, root files                          |
| `worker`    | `prisma generate`                                    | `pnpm --filter @brandspace/worker start`    | `/`             | 120 s | `apps/worker/**`, `packages/**`, root files                       |

**No pre-deploy command on any application service.** Migrations are a separate
job — §4 explains why.

The worker drains for 120 seconds because BullMQ's `close()` waits for active
jobs, and a publish already in flight at a social platform must not be
abandoned: abandoning it is how a job that succeeded gets recorded as one that
never ran.

---

## 3. PostgreSQL

### 3.1 One instance, one database, three roles

One Railway Postgres instance per environment. One logical database. Three login
roles, exactly as `scripts/sql/setup-database-roles.sql` defines them:

| Role                  | Powers                                                             | Used by                       | Variable                 |
| --------------------- | ------------------------------------------------------------------ | ----------------------------- | ------------------------ |
| `brandspace_migrator` | Owns the schema, runs DDL. NOBYPASSRLS.                            | The migration job only        | `DATABASE_MIGRATION_URL` |
| `brandspace_app`      | Owns nothing. NOBYPASSRLS. No policy grants it cross-tenant sight. | dashboard, admin, api, worker | `DATABASE_URL`           |
| `brandspace_platform` | Cross-tenant via role-targeted RLS policies. NOBYPASSRLS.          | admin, api                    | `DATABASE_PLATFORM_URL`  |

None is superuser. None may bypass RLS. `brandspace_app` is explicitly **not** a
member of `brandspace_platform`, so `SET ROLE` into the platform identity fails —
cross-tenant visibility is a property of which credential opened the connection,
not a session variable the application can set.

The SQL file verifies all of this and raises rather than leaving a weak database
in place.

### 3.2 Provisioning procedure

Run once per environment, after Railway provisions Postgres and **before**
migrations. Railway's own credential is used here and then never again by an
application.

```bash
# 1. Connect with Railway's provisioned credential (the instance owner).
railway link                       # select project + environment
railway connect postgres           # opens psql against the provisioned instance

# 2. From a shell with that DATABASE_URL exported, create the three roles.
#    Generate three distinct passwords first; never reuse one.
psql "$RAILWAY_PROVIDED_DATABASE_URL" \
  -v migrator_password="$(openssl rand -base64 36)" \
  -v app_password="$(openssl rand -base64 36)" \
  -v platform_password="$(openssl rand -base64 36)" \
  -f scripts/sql/setup-database-roles.sql
```

Capture each password as it is generated — the script does not print them and
Railway will not show a sealed variable again.

Then compose three connection strings against the **private** hostname and set
them as sealed service variables:

```
postgresql://brandspace_app:<app_password>@<postgres>.railway.internal:5432/railway?sslmode=disable
postgresql://brandspace_platform:<platform_password>@<postgres>.railway.internal:5432/railway?sslmode=disable
postgresql://brandspace_migrator:<migrator_password>@<postgres>.railway.internal:5432/railway?sslmode=disable
```

The worker carries `BRANDSPACE_POSTGRES_PRIVATE_HOST`, a reference to the
Postgres service's `RAILWAY_PRIVATE_DOMAIN`, so the hostname can be read without
opening the database credential. Confirm the database name against the
provisioned instance — Railway's default is `railway`.

### 3.3 SSL, and why `sslmode=disable` on the private network

Railway's private network is an encrypted WireGuard mesh between services in one
environment; traffic never leaves it. Railway's Postgres image does not present
a certificate a client can verify by default, so `sslmode=require` adds a
handshake without adding a verified peer.

**Over the public TCP proxy the answer is the opposite** — if anything ever
connects from outside Railway, it must use TLS. Nothing in this blueprint does:
no service uses `DATABASE_PUBLIC_URL`, and no TCP proxy is declared.

### 3.4 Ordering constraint

The RLS migration (`20260901102700_row_level_security`) contains
`GRANT … TO brandspace_app` and `ALTER DEFAULT PRIVILEGES FOR ROLE
brandspace_migrator`. **The roles must exist before migrations run**, or the
first migration fails on an unknown role. Roles first, migrations second, always.

### 3.5 Connection limits

Five services, several holding a Prisma pool, plus a migration job. Railway's
Postgres plans set `max_connections`; Prisma's default pool is `num_cpus * 2 + 1`
per process. With one replica each this is comfortable. **Before raising any
replica count**, set an explicit `connection_limit` in each URL's query string
and check the sum against the instance's `max_connections`. No pooler (PgBouncer)
is proposed for the initial deployment: it would be infrastructure carrying no
current load, and BrandSpace's `set_config(..., true)` tenant binding is
transaction-scoped, which is compatible with transaction pooling but has not
been tested against one.

---

## 4. Migrations

### 4.1 Who runs them

**A dedicated one-off job, not a pre-deploy command on an application service.**

Railway's pre-deploy command runs before a service's new deployment goes live.
It is the obvious place for `prisma migrate deploy`, and it is the wrong one
here for two reasons:

1. **It would put the migrator credential inside a runtime service.** The whole
   point of a separate `DATABASE_MIGRATION_URL` is that the process serving
   requests cannot perform DDL. A pre-deploy command runs in the service's own
   environment, so the service would hold a credential that owns the schema —
   permanently, not just during the migration.

2. **Four services would race.** A pre-deploy on dashboard, admin, api and
   worker means four concurrent `prisma migrate deploy` runs. Prisma takes an
   advisory lock, so the outcome is "three wait" rather than corruption — but
   three deployments then block on a migration they did not need to run, and a
   failure surfaces four times in four places.

The job: a Railway service with the same source, no domain, no healthcheck,
restart policy `NEVER`, run manually or by the deployment pipeline, whose start
command is:

```
pnpm --filter @brandspace/database exec prisma migrate deploy
```

It needs exactly two variables: `DATABASE_MIGRATION_URL` and `NODE_ENV`.
`packages/database/prisma.config.ts` reads `DATABASE_MIGRATION_URL` first and
falls back to `DATABASE_URL`; set only the former so a misconfiguration fails
rather than quietly migrating as the application role.

This job is **not** declared in `.railway/railway.ts`. A service whose entire
purpose is to run once and exit, declared in a file that is applied repeatedly,
invites an accidental re-run. §22 lists it as an owner action with its exact
configuration.

### 4.2 Failure, drift and rollback

- **On failure:** the job exits non-zero and application services are not
  deployed. `prisma migrate deploy` is transactional per migration; a failed
  migration leaves the database at the last complete one and the `_prisma_migrations`
  table records the failure. Resolve with `prisma migrate resolve` after
  understanding the cause — never by editing the table.
- **Drift:** `prisma migrate status` against `DATABASE_MIGRATION_URL` reports it.
  The repository's own isolation suite checks migrations-from-empty and drift on
  every CI run, so drift in production means someone changed the database by
  hand.
- **Rollback:** forward-fix only. `docs/OPERATIONS.md` §6 is the standing
  policy and this blueprint does not change it. A deployment rollback on Railway
  reverts _code_, not schema, so a migration must be compatible with the
  previous release for a rollback to be safe.

---

## 5. Redis and BullMQ

### 5.1 The queue architecture

`packages/jobs` opens one shared `ioredis` connection per process
(`packages/jobs/src/client.ts`) and builds a BullMQ `Queue` per queue name. The
worker runs three consumers: media processing, publishing and analytics.

| Service     | Role                                                           |
| ----------- | -------------------------------------------------------------- |
| `dashboard` | Producer — asset upload, Brand Brain ingestion                 |
| `admin`     | Producer                                                       |
| `api`       | Producer, and the maintenance scheduler that dispatches sweeps |
| `worker`    | Consumer — the only consumer                                   |

`REDIS_URL` is wired as a Railway reference variable to the Redis service, so the
credential is never typed anywhere and rotates with the service.

### 5.2 Outage behaviour, and why readiness ignores Redis

`enqueue()` returns `{ dispatched: false }` when `REDIS_URL` is unset rather than
throwing, and `/health/ready` reports the queue as a **non-required** dependency
with capability `background-jobs`.

This is deliberate and the blueprint preserves it. Without Redis the platform
still serves every screen, every read and every synchronous AI call; what stops
is background work. Answering "not ready" would remove a working product from
routing to protect a queue. The readiness payload still _says_ the queue is
down, so an operator sees it.

The worker is the opposite case: it is nothing but a queue consumer, so its
liveness endpoint reports `worker.isRunning()` and Railway restarts it when the
consumer stops.

### 5.3 Concurrency and persistence

Multiple worker replicas are **safe by construction** — BullMQ distributes jobs
across consumers and every processor is idempotent by the repository's own
standard (`CLAUDE.md` §5). One replica initially because there is no load, not
because more would be wrong.

Railway's Redis persists to a volume. BullMQ state is operational, not a system
of record: a lost queue means re-dispatching sweeps, which `docs/OPERATIONS.md`
§5 already covers. Redis is not backed up and does not need to be.

---

## 6. Object storage

### 6.1 Cloudflare R2, and why not Railway Buckets

BrandSpace stores objects in **Cloudflare R2**, reached over the S3 protocol.
The earlier revision of this document named Railway Buckets. That was written
when no adapter existed and the choice was theoretical; with an adapter in hand,
three things decided it the other way:

1. **Blast radius.** Railway holds the database, the queue and all five
   application processes. Putting customer files there too means one vendor
   account is the single point of loss for everything — including the backups'
   destination if they ever land beside the data they back up.
   `docs/OPERATIONS.md` treats storage and compute as separable, and they should
   stay separable.
2. **Egress.** R2 charges nothing for egress. Customer media is read far more
   often than it is written — every asset thumbnail, every preview, every
   download grant — and an egress-billed store makes the product's most ordinary
   operation the line item that grows fastest.
3. **A managed bucket is not a commitment either way.** The adapter speaks
   generic S3. If R2 turns out to be wrong, the migration is a bucket copy and
   five environment variables, not a code change.

**If a Railway Bucket was already created from the earlier blueprint, delete
it.** It is unwired, it is not referenced by `.railway/railway.ts` any more, and
leaving a provisioned empty bucket in the project invites somebody to assume it
holds something.

### 6.2 The five variables

`readS3Configuration()` in `packages/storage/src/factory.ts` is the only reader.

| Variable                    | Required | Where it comes from                                                                            |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `STORAGE_ENDPOINT`          | yes      | The R2 **S3 API** origin for the account. Contains the account id — treat as secret.           |
| `STORAGE_BUCKET`            | yes      | Bucket name. **Must differ between production and staging.**                                   |
| `STORAGE_ACCESS_KEY_ID`     | yes      | An R2 API token scoped to this bucket. Never an account-wide token.                            |
| `STORAGE_SECRET_ACCESS_KEY` | yes      | The secret half. Cloudflare shows it once.                                                     |
| `STORAGE_REGION`            | no       | R2 requires `auto`, which is the schema default. Leave unset.                                  |
| `STORAGE_FORCE_PATH_STYLE`  | no       | `true` only for gateways needing `host/bucket/key`, such as MinIO. Leave unset for R2 and AWS. |

**All four required values or none.** A partial configuration is the worst
outcome — it constructs, accepts an upload and fails at the provider with an
error that names a bucket rather than a missing variable — so the factory
refuses and lists exactly which names are absent.

### 6.3 Which services get them, and which deliberately do not

| Service     | `STORAGE_*` | Why                                                                                                                                                              |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard` | yes         | Asset uploads and Brand Brain ingestion run in this process.                                                                                                     |
| `api`       | yes         | Creative routes and maintenance sweeps read and write objects.                                                                                                   |
| `worker`    | yes         | Asset processing and ingestion — the heaviest object user of the five.                                                                                           |
| `admin`     | **no**      | Displays file metadata; never moves bytes. It already holds the platform database identity and the secret vault key, and a bucket credential there buys nothing. |
| `web`       | **no**      | Static marketing site. Touches no customer data at all.                                                                                                          |

**No `NEXT_PUBLIC_` prefix, ever.** These are server-side variables; Next.js
inlines only `NEXT_PUBLIC_*` into client bundles, so no browser receives any
part of them. `CLAUDE.md` §2.3 makes this a rule rather than a habit.

### 6.4 Production and staging must not share a bucket

Railway stores variables per environment, so the declaration in
`.railway/railway.ts` produces two independent sets — but nothing stops an
operator pasting the same values into both. A staging run that deletes an object
is a customer file deleted. Two buckets, two API tokens, and
`docs/RAILWAY-ENVIRONMENT-MATRIX.md` carries it as a checklist item.

### 6.5 It is configured by the deployment, not in the Control Center

The Integrations Hub lists `Cloudflare R2 (S3-compatible)` under Object storage
so the owner can see what the platform is connected to — with **no form**. It
declares no credential fields and no setting fields, and it is not testable from
that screen.

That is deliberate. The object store is constructed synchronously inside worker
processors and request handlers, long before any configuration read could be
awaited; it sits at the same level as `DATABASE_URL` and `REDIS_URL`. A Hub form
would be a second place to configure one thing, and the second place would be
the one nothing reads — an owner rotating a key there would believe they had
rotated it. Transactional email is the opposite case and does get a form (§16),
because it is resolved per send by a process that can read the platform database
and decrypt a credential.

### 6.6 How to tell whether it is working

- `GET /health/ready` on the API reports an `object-storage` check. `ok` means
  the `STORAGE_*` contract is complete; `not_configured` names the missing
  variables. It deliberately makes **no request to the bucket** — Railway probes
  readiness continuously, and a `HeadBucket` per probe is a paid request several
  times a minute to re-answer a question whose answer never changes.
- The real proof is the round trip: upload a file in the dashboard, confirm the
  worker processed it, redeploy, confirm it is still there.
  `docs/RAILWAY-SMOKE-TEST.md` §6 is that procedure.

### 6.7 Still open

Presigned URLs, CORS rules and lifecycle policy. The adapter does not issue
presigned URLs today — `capabilities.signedUrls` is `false` in the registry and
downloads go through `DownloadGrantIssuer` — so nothing is blocked by their
absence. They are the natural next storage decision, not this pass's.

---

## 7. Environment variables

`docs/RAILWAY-ENVIRONMENT-MATRIX.md` is the authoritative matrix — every
variable, its class, its consumers, its format and its production rule. It is a
separate file because it is a reference table, not a narrative.

Two variables joined it in this pass, both owner-supplied and both sealed:
the four `STORAGE_*` values (§6.2) and `INTERNAL_SERVICE_TOKEN` (§16.3).

The one thing to repeat here, because it is the most expensive mistake
available: **`BILLING_DEV_WEBHOOK_SECRET` must not be set in production.**
`assertProductionSafety` throws if it is. Its only consumer is the development
payment adapter, which cannot run in production — so its presence means a
production environment was assembled by copying a development one, and the next
thing copied might not be harmless.

---

## 8. Production and staging

Two Railway environments in one project. **Nothing is shared.**

| Concern                  | Production                      | Staging                                 |
| ------------------------ | ------------------------------- | --------------------------------------- |
| `APP_ENV`                | `production`                    | `staging`                               |
| `NODE_ENV`               | `production`                    | `production` (it is a built app)        |
| Postgres                 | Its own instance                | Its own instance, no production data    |
| Redis                    | Its own instance                | Its own instance                        |
| Object storage           | Its own R2 bucket and API token | **A different** R2 bucket and API token |
| Every secret             | Unique                          | Unique — never a copy of production     |
| Domains                  | The real ones                   | `*.up.railway.app` or `staging.*`       |
| OAuth callbacks          | Production origins              | Staging origins, registered separately  |
| Email                    | Resend, its own API key         | Resend, **a different** API key         |
| `LOG_LEVEL`              | `info`                          | `debug`                                 |
| `INTERNAL_SERVICE_TOKEN` | Its own value                   | **A different** value                   |
| AI / social / payments   | None activated                  | None activated                          |

**Production data must never be copied into staging.** If staging needs
realistic data it gets seeded data, not a restore: a restore brings customer
personal data into an environment with weaker access control, which is a
notifiable event in most of the jurisdictions BrandSpace intends to serve.

`APP_ENV` is what separates them at runtime, not `NODE_ENV` (D-97). Staging's
`APP_ENV=staging` means development doubles are _still_ refused — `selectionRefusal()`
permits them only in development and test — so staging exercises the same
fail-closed paths production will.

---

## 9. Networking

| From                             | To                              | Path                                             | Protocol            |
| -------------------------------- | ------------------------------- | ------------------------------------------------ | ------------------- |
| Internet                         | `web`                           | Public domain                                    | HTTPS               |
| Internet                         | `dashboard`                     | Public domain                                    | HTTPS               |
| Internet                         | `admin`                         | Public domain                                    | HTTPS               |
| Internet                         | `api`                           | Public domain — OAuth callbacks, future webhooks | HTTPS               |
| `dashboard`                      | `api`                           | `http://api.railway.internal:3003`               | HTTP over WireGuard |
| `admin`                          | `api`                           | `http://api.railway.internal:3003`               | HTTP over WireGuard |
| dashboard / admin / api / worker | `postgres`                      | `<postgres>.railway.internal:5432`               | private             |
| dashboard / admin / api / worker | `redis`                         | reference variable, private domain               | private             |
| `dashboard` / `api` / `worker`   | Cloudflare R2                   | Outbound HTTPS to `STORAGE_ENDPOINT`             | HTTPS               |
| `api`                            | Resend                          | Outbound HTTPS to `api.resend.com`               | HTTPS               |
| `api` / `worker`                 | AI / social / payment providers | Outbound HTTPS — **none activated**              | HTTPS               |

Internal traffic uses `http://`, not `https://`: Railway's private network is
already encrypted with WireGuard, and terminating TLS inside it buys a second
encryption layer and a certificate to manage.

**Private networking and IPv6.** Railway supports IPv4 and IPv6 privately in
environments created after 16 October 2025; older environments are IPv6-only.
Every BrandSpace process binds `0.0.0.0` — the API explicitly
(`app.listen({ host: '0.0.0.0' })`), the worker explicitly, and Next.js by
default. On an IPv6-only private network a service bound to `0.0.0.0` is not
reachable over the private domain. **Verify this on the first staging deploy**:
if the dashboard cannot reach `api.railway.internal`, this is why, and the fix
is binding `::` — a small, targeted repository change, not a topology change.

---

## 10. Domains

Not configured. The layout below uses placeholders because the repository
defines no canonical domain and inventing one would be inventing a brand.

| Service     | Placeholder         | DNS record                                                             |
| ----------- | ------------------- | ---------------------------------------------------------------------- |
| `web`       | `www.example.com`   | CNAME → Railway target; apex via ALIAS/ANAME or Railway's apex support |
| `dashboard` | `app.example.com`   | CNAME → Railway target                                                 |
| `admin`     | `admin.example.com` | CNAME → Railway target                                                 |
| `api`       | `api.example.com`   | CNAME → Railway target                                                 |

Railway issues and renews certificates once DNS resolves. Add the custom domain
in Railway first, then create the record it gives you.

### URLs that will depend on these

Every one of them is built at request time from `PUBLIC_API_BASE_URL` or
`PUBLIC_DASHBOARD_BASE_URL`, never written in code — which is what lets staging
use its own hostnames without a code change.

- **Social OAuth callbacks** — `{PUBLIC_API_BASE_URL}/v1/social/callback/...`, one per
  platform, registered in each provider's developer console.
- **Payment webhook** — `{PUBLIC_API_BASE_URL}/v1/billing/webhook/<provider>`, the
  path the Integrations Hub already generates and displays read-only.
- **Customer return URLs** — built from `PUBLIC_DASHBOARD_BASE_URL`.
- **Email links** — verification and invitation, from `PUBLIC_DASHBOARD_BASE_URL`.

None can be registered until domains exist, and none matters until §15's
providers are activated.

---

## 11. Health checks

| Service     | Path            | What it proves                                                                                                     |
| ----------- | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `api`       | `/health/ready` | The tenant database answered within 2 s; the queue, tracing and `STORAGE_*` contract are reported but non-required |
| `worker`    | `/`             | `worker.isRunning()` — the BullMQ consumer is consuming                                                            |
| `web`       | `/`             | The Next.js server renders                                                                                         |
| `dashboard` | `/`             | The Next.js server renders                                                                                         |
| `admin`     | `/`             | The Next.js server renders                                                                                         |

**Readiness, not liveness, for the API's routing probe.** `/health/live` checks
nothing external by design — a liveness probe that touched the database would
restart the whole fleet the moment the database blinked. `/health/ready` returns
503 when the tenant database is down, which is exactly when Railway should stop
routing to that instance.

**The semantics are preserved, not reinterpreted.** `/health/ready` reports the
queue, tracing and object storage as non-required: Redis being down degrades
`background-jobs` and leaves the service ready. Railway will keep routing to it,
which is the documented intent.

**The `object-storage` check reports configuration, not reachability**, and says
so in its own `detail`. `ok` means the `STORAGE_*` contract is complete;
`not_configured` names the missing variables. It makes no request to the bucket:
Railway probes readiness continuously, and a `HeadBucket` per probe would be a
paid request several times a minute to re-answer a question whose answer never
changes. It is non-required for the same reason the queue is — without storage
the platform still serves every screen and every non-media action, and
`createObjectStore` already refuses loudly where the missing capability actually
matters. The round-trip proof is `docs/RAILWAY-SMOKE-TEST.md` §6.

No new endpoint was created. The Next.js apps have no dedicated health route, so
`/` is used — it exercises rendering, middleware and the CSP path, which is more
than a static handler would.

`healthcheckTimeout` is 300 s on every service: a cold Next.js start plus Prisma
client load can exceed a short default, and a healthcheck that times out during
startup produces a restart loop that looks like a crash.

---

## 12. Build strategy

### Recommendation: Railpack, repo-root builds, pnpm workspace filters

All five services build from the repository root with Railpack, each with a
`buildCommand` that filters to its own package.

**Why not a root-directory-per-service deployment.** The apps import workspace
packages by `workspace:*`. A build rooted at `apps/api` has no
`pnpm-workspace.yaml` above it and no lockfile, so pnpm cannot resolve
`@brandspace/shared` at all.

**Why not Dockerfiles.** Five Dockerfiles would duplicate the same pnpm install
and Prisma generate five times, and every one of them is a file that drifts from
`package.json` silently. Docker earns its complexity when the build needs
system packages or a multi-stage prune; this build needs neither.

**Why Railpack rather than Nixpacks.** Railpack is Railway's current default and
reads `packageManager: pnpm@10.33.0` from the root `package.json`, so the
lockfile is honoured without configuration.

### ~~The one thing Railpack must not do~~ — RESOLVED

The previous revision named this the single highest-risk item in the blueprint:
if the production image pruned dev dependencies, the API and worker would crash
on start with `tsx: not found`, because `tsx` was a devDependency and both
services run `.ts` source through it.

**It is fixed at the source rather than worked around at the deployment.** `tsx`
is now a runtime dependency of both services (§1.2), so a pruning build is no
longer a failure mode — it is the correct build. The Dockerfile fallback the
previous revision proposed is unnecessary and was dropped.

The smoke test still checks that both services start, because "it should work
now" is not the same as "it did".

### Build-time environment

Next.js builds instantiate Prisma at module scope, so `DATABASE_URL` must be
_present_ at build time — the CI build job proves it with a placeholder value
and contacts nothing. On Railway the real service variable is present during the
build, which satisfies it without special handling.

`prisma generate` is offline: `packages/database/prisma.config.ts` demands a
database URL only for `migrate`, `db`, `studio` and `introspect`.

---

## 13. Watch paths

Listed per service in §2. The rule behind them:

**Correctness before thrift.** Every service except `web` consumes shared
workspace packages, and a package change that did not rebuild its consumers
would leave a service running against code that no longer exists. So
`packages/**` rebuilds dashboard, admin, api and worker. Only `web` — which
imports `@brandspace/ui` and `@brandspace/shared` and nothing else — gets a
narrower list.

Root files (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
`.railway/**`) rebuild everything: a lockfile change can alter any service's
dependency tree.

Schema changes live under `packages/database/**`, so they are covered by
`packages/**`. They rebuild `web` not at all, correctly — `web` touches no
database.

---

## 14. Infrastructure as Code

`.railway/railway.ts`, authored against the `railway` DSL pinned in
`.railway/package.json`. `railway.json` and `railway.toml` are **deprecated** —
Railway's stated cutoff for them is 2026-12-01 — and neither is used here.

### What the file expresses

Project, both environments, Postgres, Redis, five services with their source,
builder, build command, watch patterns, start command, healthcheck, restart
policy, replica count, region, drain seconds, and every non-secret variable.

**No Railway Bucket.** An earlier revision declared one, unwired, against the
day an S3 adapter existed. That adapter now exists and stores objects in
Cloudflare R2 instead (§6.1), so the bucket was removed rather than left as a
provisioned resource nothing reads.

### What it deliberately does not express

| Not in the file         | Why, and where it is instead                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret **values**       | Declared with `isSealed` + `preserveExisting` and no value. Applying can never overwrite what the owner set; reading can never reveal it.                                                     |
| The three database URLs | Owner-supplied after role creation (§3.2). Railway's own credential must never be referenced.                                                                                                 |
| Domains                 | §10. A domain in a file is a domain nobody verified they control.                                                                                                                             |
| `STORAGE_*` **values**  | §6. The five variable declarations ARE in the file, sealed and value-less, and wired to `dashboard`, `api` and `worker` only. What is absent is any endpoint, bucket name, account id or key. |
| The migration job       | §4.1. A run-once service in a repeatedly-applied file invites a re-run.                                                                                                                       |
| Volumes                 | Nothing needs one. The apps are stateless; Postgres and Redis manage their own.                                                                                                               |
| Backup schedules        | §17 — verify what Railway provides before declaring anything.                                                                                                                                 |

### Validation performed

| Check                                                                                        | Result                                                                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `tsc --noEmit` against the real `railway@3.11.0` types, `strict: true`                       | Passes                                                                                                              |
| Offline dry run: execute the program for both environments, inspect the resulting definition | 7 resources, all five services, expected commands and references                                                    |
| Secret declarations carry no value                                                           | Confirmed — they normalise to `{type:'raw', value:{description, isSealed, preserveExisting}}` with no `value` field |

```bash
cd .railway && npm install && ../node_modules/.bin/tsc -p tsconfig.json
```

**`railway config plan` was not run.** The IaC engine now ships in the Railway
CLI (minimum 5.42.1), not the SDK — the SDK's `railway-iac-ts` binary is a shim
that says so. `plan` needs an authenticated CLI linked to a project, and no
project exists. Run it as the first step of §20 once the project is created; it
is read-only and shows the diff before anything is applied.

---

## 15. External providers

None. Not AI, not social, not payment, not email, not observability. No
production credential for any vendor appears anywhere in this blueprint.

The platform is designed to start without them and fails closed where a
capability is genuinely unavailable:

| Capability        | Without a provider                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| AI generation     | The deterministic provider refuses to construct in production; AI features are unavailable, the platform runs |
| Social publishing | Mock connectors refuse in production; no account can be connected                                             |
| Payments          | The development adapter refuses in production; checkout is unavailable                                        |
| Email             | `UnconfiguredEmailProvider` **throws** until Resend is activated — §16                                        |
| Object storage    | `createObjectStore` throws, naming the missing `STORAGE_*` variables — §6                                     |
| Observability     | Spans are created locally and nothing is exported; readiness reports it                                       |

**No guard is weakened to make the first deployment green.** A green deployment
that pretends to publish, charge or email is worse than a deployment that says
it cannot.

---

## 16. Email

### 16.1 Resend, configured from the Control Center

Transactional email goes through **Resend**, reached over its HTTP API by
`packages/auth/src/email-resend.ts`. Nothing above that file knows the vendor's
name: signup, invitation and password-reset services take an `EmailProvider`,
and this is one.

Unlike object storage (§6.5), email **is** configured in the Integrations Hub
rather than by environment variable, because it is resolved per send by a
process that can read the platform database and decrypt a credential. The owner
workflow is:

> Control Center → Integrations → Transactional email → Resend → enter the API
> key and From address → **Save** → **Activate**.

**Save ≠ Activate.** Two deliberate acts. Saving writes the key to the Secret
Service and the settings to the Configuration Service and activates nothing.
Activating is a full configuration change with an author, a reason, an audit
trail and a rollback.

**There is no Test connection step, and §16.2 explains why.** The proof that
the credential works is the controlled smoke email after activation, which is
the same operation the credential exists to perform.

### 16.2 Settings, and the one credential

| Field      | Kind    | Note                                                                                                                                                   |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API key    | secret  | Write-only. Stored through the Secret Service; only masked metadata is ever readable afterwards. Configuration holds a **reference**, never the value. |
| From email | setting | Required. Must be on a domain verified in Resend.                                                                                                      |
| From name  | setting | Optional display name.                                                                                                                                 |
| Reply-To   | setting | Optional.                                                                                                                                              |

Nothing else. A larger form would be inventing settings the product does not
use.

#### The credential is a SENDING-ACCESS key, and that decides the rest

Use a Resend API key with **Sending access**, restricted to the verified sending
domain. That is the least privilege that can do the job: it can send, and it can
do nothing else — it cannot list domains, read the account or manage anything.

**Which is why there is no Test connection button.** Every non-destructive check
Resend offers is a READ, and a send-only key is refused all of them. A button
here had exactly three possible behaviours, and all three are worse than no
button:

1. Call `GET /domains` and report 401 — telling an owner their correctly-scoped
   production key is broken. A red tick on a working credential trains people to
   ignore ticks.
2. Ask for a **Full Access** key so the read succeeds — widening a production
   credential's scope to light up a UI element, and then keeping it at that
   scope in the vault forever.
3. Send a probe message — an unsolicited email, to a real inbox, every time an
   operator presses a button.

The registry marks Resend `testable: false`, the Hub omits the button, and
`IntegrationsService.testConnection` **refuses the request at the service** as
well — a hidden control is presentation, not authorisation.

**What proves the key instead:** the controlled smoke email after activation
(`docs/RAILWAY-SMOKE-TEST.md` §7.2). One real signup, to an address the owner
controls. It is the same operation the credential exists to perform, which makes
it the only honest test of a send-only key.

**Do not widen the key to get a green tick.** Nothing in the product asks for a
Full Access key, and nothing should.

### 16.3 The secret boundary, and the internal delivery route

Four email operations originate in the **customer dashboard**: signup
verification, its resend, password reset and workspace invitations. Sending them
for real means resolving the active provider and decrypting its credential,
which needs `SECRET_VAULT_KEK` — and the whole point of the key-domain split
(D-136, F-07, `docs/SECURITY.md` §2.4) is that the process serving customers
does not have it.

**That key was not given to the dashboard.** Instead the dashboard asks and the
API sends:

```
dashboard  ──POST /v1/internal/email/deliver──▶  api
  (no vault key, no provider credential)          (resolves the active provider,
                                                   decrypts the key, sends)
```

The dashboard's flow logic, transactions and anti-enumeration behaviour are
untouched — only the last hop moved to a process already allowed to hold a
provider credential. `apps/api/src/email-provider.ts` is the single place in the
repository that decides which provider sends.

What stops the route being an open relay:

1. **A shared service token**, `INTERNAL_SERVICE_TOKEN`, compared in constant
   time. Without it the route answers **404** — not 401, which would confirm the
   endpoint to anybody scanning.
2. **A closed template set.** The body names one of the six templates the
   product declares; the words come from the platform's own catalogue. A caller
   cannot supply a subject or a body.
3. **No arbitrary link target.** The link is a path the dashboard composed from
   a token it just issued.

`INTERNAL_SERVICE_TOKEN` is a **service** token, not a provider credential: it
grants exactly one capability, and it cannot read anything back. At least 32
characters, random, and different per environment. It is set on `dashboard`,
`admin` and `api` — not on `worker`, which sends through the notification
pipeline instead.

### 16.4 What is logged, and what is not

Never: the API key, the `Authorization` header, or the provider's own error
text. Resend explains a refusal by quoting the request it refused, so its
message routinely contains the recipient address. Only the HTTP status and
Resend's machine code (`validation_error`, `invalid_api_key` …) escape, and the
code is shape-checked before use. The operator who needs the vendor's wording
has it in Resend's dashboard, addressed by the message id — which is where
request content belongs.

The delivery log line carries the template key and the provider. Not the
recipient, not the link: a password-reset link in a log is a password reset
anybody with log access can perform.

### 16.5 Flows that work once Resend is activated

All of these were _expected blocked_ in the previous revision and are now
_expected to pass_ after configuration:

- Customer signup email verification
- Resend verification
- Password reset
- Workspace invitation, and invitation resend
- Security and account notices
- Billing transactional mail

**One correction this pass had to make for any of them to work.** Every link the
dashboard put in an email was a PATH — `/en/verify?token=…`. That was invisible
while the outbox held the message and a developer read it in a browser already
on the dashboard's origin. In a real inbox the reader is somewhere else
entirely, and the link resolves to nothing: a customer who cannot click the
verification link cannot finish signing up, with no error anywhere. Links are
now built from `PUBLIC_DASHBOARD_BASE_URL`, and production refuses to build one
without it rather than guessing an origin.

Before activation they still fail closed: `UnconfiguredEmailProvider.send()`
throws rather than reporting a delivery that did not happen, and production
never silently falls back to the outbox (D-41). Development and test are
unchanged — `OutboxEmailProvider` writes its auditable row and nothing leaves
the system.

**Platform owner sign-in is not affected** either way — it uses the platform
session realm and TOTP, neither of which sends mail — so the Control Center is
reachable and the Hub can be used to configure email as the first act of
operating the platform.

---

## 17. Backups and recovery

**Verify each capability in the Railway dashboard before relying on it.** What
follows was read from documentation, not from a provisioned instance, and
`docs/OPERATIONS.md` §2 is explicit that an unverified backup is not a backup.

### PostgreSQL

Railway's Postgres image supports **point-in-time recovery** via pgBackRest:
every WAL segment archived to a private Railway bucket, weekly full and daily
incremental base backups, the last four full backups retained — roughly a
four-week window. Restores create a **new sibling database service**; cutting
over is a separate, manual step.

- **Confirm PITR is enabled** for the production instance. Do not assume it is on
  by default.
- A restore is a new service, so the cutover is: restore → verify → repoint
  `DATABASE_URL` / `DATABASE_PLATFORM_URL` / `DATABASE_MIGRATION_URL` → redeploy.
  The three roles must be recreated on the restored instance (§3.2) — a restore
  brings the schema and data, and role passwords are cluster-level.
- `docs/OPERATIONS.md` §3 already defines the restore drill. **Run it on staging
  before launch.** A restore procedure nobody has executed is a hypothesis.

### Object storage

**Not covered by the Railway backup, because it is not on Railway.** Objects
live in Cloudflare R2 (§6.1), and a Railway restore brings back the database
rows that reference files without bringing back the files.

Two decisions the owner now owes, since the adapter exists and the bucket will
hold real customer media:

- **Bucket versioning**, so an accidental delete or overwrite is recoverable.
  The platform's delete path is idempotent and does not tombstone.
- **Lifecycle policy** for abandoned multipart uploads and for objects whose
  owning row was hard-deleted.

Neither is expressible in `.railway/railway.ts` — they are Cloudflare settings.
`docs/OPERATIONS.md` §3's restore drill should be extended to cover a database
restore whose object references must still resolve.

### Secrets and configuration

Railway sealed variables are **not recoverable** — that is the point of sealing.
Losing `SECRET_VAULT_KEK` means every stored provider credential is
unrecoverable ciphertext; losing `SOCIAL_TOKEN_VAULT_KEK` means every customer
reconnects their social accounts; losing `CUSTOMER_MFA_VAULT_KEK` means every
customer re-enrols their authenticator.

**The three KEKs must be escrowed outside Railway** — a password manager or an
HSM the owner controls — before the first customer exists.
`docs/OPERATIONS.md` §7 covers rotation.

Configuration documents live in Postgres with version history, so they are
covered by the database backup.

### Deployment rollback

Railway keeps previous deployments and can redeploy one. This reverts **code,
not schema** — see §4.2.

---

## 18. Scaling

| Service     | Shape                            | Initial | Before raising it                                         |
| ----------- | -------------------------------- | :-----: | --------------------------------------------------------- |
| `web`       | Stateless, horizontally scalable |    1    | Nothing — it is safe now                                  |
| `dashboard` | Stateless, horizontally scalable |    1    | Check Postgres connection totals (§3.5)                   |
| `admin`     | Stateless, horizontally scalable |    1    | Internal use; unlikely to need more                       |
| `api`       | **Singleton for now**            |    1    | The in-process maintenance scheduler — see below          |
| `worker`    | Queue consumer, scalable         |    1    | Safe by construction; raise when queue depth justifies it |

**Why the API is a singleton.** `server.ts` starts `MaintenanceScheduler`
in-process when run directly, so N replicas run N sweep loops. The sweeps read
_unclaimed_ work (`findUnclaimedIngestionJobs`, `findUnclaimedAssetJobs`), which
suggests duplicates contend rather than double-act — but that has not been
proven for every sweep, and "probably idempotent" is not a basis for running
something twice against customer data.

To raise it, establish one of: every sweep is provably idempotent under
concurrency, or the scheduler moves behind a leader election, or it moves out of
the API into its own singleton service. The third is cleanest and would also
resolve §1.3's observation about the API holding the platform credential.

**No autoscaling.** There is no traffic to scale to, and autoscaling on a service
with an in-process scheduler would multiply the exact thing that should stay
single.

---

## 19. Cost-aware topology

**Mandatory:** `web`, `dashboard`, `admin`, `api`, `worker`, Postgres, Redis.
Seven. None can be removed without removing a capability or breaking isolation.

**Plus two external services, neither billed by Railway:** a Cloudflare R2
bucket (§6) and a Resend account (§16). The Railway Bucket that an earlier
revision listed here as deferrable no longer exists in the blueprint at all.

**Could be collapsed, and should not be:**

- `admin` into `dashboard` — they are separate session realms and separate
  database identities. Merging them would put `DATABASE_PLATFORM_URL` in the
  process serving customers. This is the one saving that must never be taken.
- `api` into `dashboard` — the dashboard would inherit the platform credential
  and the scheduler.
- `worker` into `api` — background work would compete with request latency, and
  the API would need `SOCIAL_TOKEN_VAULT_KEK`.

**Genuinely optional now:**

- The **migration job** exists only while it runs.
- **Staging** can be created later than production, though creating it first is
  the point of §20.

**One replica everywhere**, per §18.

No monthly figure is given. Railway's pricing is usage-based and current rates
were not verified; a number invented here would be quoted back later as a
commitment.

---

## 20. Deployment order

Corrected from the generic sequence in two places, both consequences of §0.

> **Domains move before first boot** (step 9, not step 15) — `assertProductionSafety`
> refuses `http://` public URLs in production, so the API cannot start without an
> https origin.
>
> **Roles move before migrations** (step 7, before step 10) — the RLS migration
> grants privileges to roles that must already exist.

**Do staging end to end first.** Every step below runs against staging, is
verified with `docs/RAILWAY-SMOKE-TEST.md`, and only then repeats for production.

1. **Prerequisites.** Railway account, workspace with billing, GitHub connected
   to `Mohamed-Omaar/BrandSpace-Platform`. Railway CLI ≥ 5.42.1.
2. **Create the project.** `railway init`, then `railway config plan` to preview
   `.railway/railway.ts` — read-only, no changes.
3. **Create the staging environment.**
4. **Provision Postgres**, region EU West. Private only.
5. **Provision Redis**, same region. Private only.
6. **Create the Cloudflare R2 bucket and its scoped API token** (§6). A
   separate bucket and a separate token for staging and for production. This is
   outside Railway.
7. **Create the three database roles** (§3.2). Capture the three passwords.
8. **`railway config apply`.** Creates the five services with their build,
   deploy and non-secret configuration. They will not start yet: their secrets
   are declared and empty.
9. **Generate Railway domains** for `web`, `dashboard`, `admin`, `api`. Take the
   four https origins.
10. **Set the secrets and URLs.** Three database URLs, two session secrets,
    three KEKs, six public URLs, the four `STORAGE_*` values from step 6, and
    `INTERNAL_SERVICE_TOKEN` — per service, per
    `docs/RAILWAY-ENVIRONMENT-MATRIX.md`. Generate with §22's commands. Escrow
    the three KEKs outside Railway now, not later.
11. **Run migrations.** The one-off job from §4.1, with `DATABASE_MIGRATION_URL`
    only. It must succeed before anything else deploys.
12. **Deploy the private services** — `worker` first, so queue consumers exist
    before producers.
13. **Deploy the public services** — `api`, then `dashboard`, `admin`, `web`.
14. **Verify health.** `/health/live` and `/health/ready` on the API; the
    worker's probe; each Next.js app renders.
15. **Smoke test.** `docs/RAILWAY-SMOKE-TEST.md`, every item.
16. **Bootstrap the platform owner** and sign in to the Control Center with MFA.
17. **Custom domains** (§10), then update the six public URL variables and
    redeploy so callbacks are built from the real origins.
18. **Re-run the smoke test** against the custom domains.
19. **Repeat 3–18 for production**, with its own instances and its own secrets.
20. **Activate Resend** in the Integrations Hub (§16.1): enter the key and From
    address, Save, Activate. Until this step, customer signup
    verification, invitations and password reset are expected to fail closed.
    Re-run the smoke test's email items afterwards.
21. **Only then**, the remaining external integrations — AI, social, payments —
    one category at a time, through the Integrations Hub, each verified with
    Test Connection before activation. None of them is activated by this pass.

---

## 21. Smoke test

`docs/RAILWAY-SMOKE-TEST.md`.

---

## 22. Owner actions required

Only what genuinely needs the owner. Everything expressible in the repository is
in the repository.

1. **Authorise Railway.** Create the account/workspace, choose the billing plan,
   connect GitHub to this repository, install the Railway CLI and `railway login`.
2. **Choose the region — and decide about GCC residency.** §1.4. Railway has no
   Middle East region. If residency has been promised to customers, this decision
   comes before deployment, not after.
3. **Create the three database roles** and capture their passwords. §3.2.
4. **Generate and set every secret.** Never by hand, never reused across
   environments:
   ```bash
   # Session secrets and KEKs — 48 bytes, base64. Each one generated separately.
   openssl rand -base64 48    # CUSTOMER_SESSION_SECRET
   openssl rand -base64 48    # PLATFORM_SESSION_SECRET   (must differ)
   openssl rand -base64 48    # SECRET_VAULT_KEK
   openssl rand -base64 48    # SOCIAL_TOKEN_VAULT_KEK    (must differ)
   openssl rand -base64 48    # CUSTOMER_MFA_VAULT_KEK    (must differ)

   # Database role passwords — 36 bytes is ample for a private-network credential.
   openssl rand -base64 36
   ```
   The environment parser rejects anything containing `change-me`, `placeholder`,
   `example`, `devonly`, `localhost`, `replace_with`, `ci-only` or `test-only`, so
   a copied template value fails at boot rather than at the first sign-in.
5. **Escrow the three KEKs** outside Railway before the first customer. §17.
6. **Create the migration job** — the one Railway service this blueprint
   deliberately leaves out of IaC:
   - Source: this repository, root directory `/`
   - Start command: `pnpm --filter @brandspace/database exec prisma migrate deploy`
   - Variables: `DATABASE_MIGRATION_URL`, `NODE_ENV=production`
   - No domain, no healthcheck, restart policy `NEVER`
7. **DNS.** Add each custom domain in Railway, then create the CNAME it gives
   you. §10.
8. **Confirm PITR is enabled** on the production Postgres, and run a restore
   drill on staging. §17.
9. **Create a Resend account**, verify the sending domain, and generate an API
   key with **Sending access, restricted to that domain** — the least privilege
   that can send. Do **not** create a Full Access key: nothing in the product
   needs one, and §16.2 explains why no UI asks for one either. A separate key
   per environment.
10. **Generate `INTERNAL_SERVICE_TOKEN`** — `openssl rand -base64 48` — and set
    the same value on `dashboard`, `admin` and `api`, different per environment.
11. **Decide bucket versioning and lifecycle policy** in Cloudflare (§17), since
    the bucket will now hold real customer media.
12. **If a Railway Bucket was created from the earlier revision of this
    blueprint, delete it.** It is no longer referenced and holds nothing (§6.1).
13. **Approve the deployment itself**, after reviewing this blueprint.

> The two follow-ups the previous revision listed here are **done**: `tsx` is a
> runtime dependency of `apps/api` and `apps/worker`, and the S3 object store
> adapter exists. Neither is an owner action any more.

---

## 23. Open questions for the owner

1. **GCC residency vs Railway's regions.** §1.4. The only question here that
   could invalidate the platform choice — and note that object storage is now a
   second residency decision: R2 buckets have their own location hint.
2. **Bucket versioning and lifecycle policy.** §17. The bucket holds customer
   media and the platform's delete path does not tombstone.
3. **Presigned URLs.** §6.7. Downloads go through `DownloadGrantIssuer` today
   and nothing is blocked, but it is the natural next storage decision.
4. **Should the maintenance scheduler leave the API?** §18. It is what keeps the
   API a singleton, and moving it would also let the API drop the platform
   database credential (§1.3).
5. **IPv6-only private networking.** §9. Cheap to check on the first staging
   deploy, and cheap to fix if it bites.
