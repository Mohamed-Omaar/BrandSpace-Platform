# BrandSpace

Bilingual (Arabic RTL / English LTR), multi-tenant SaaS platform — an AI-powered brand and social
media operating system.

> **Status: Phase 1 — Foundations.**
> The monorepo, tenancy core, isolation guarantees, and CI gates are in place.
> **No product features are implemented yet.** See [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Architecture at a glance

Three architecturally separated interfaces, one modular monolith behind them:

| Surface            | Package          | Port (local) | Production host       |
| ------------------ | ---------------- | ------------ | --------------------- |
| Public website     | `apps/web`       | 3000         | `brandspace.cc`       |
| Customer dashboard | `apps/dashboard` | 3001         | `app.brandspace.cc`   |
| Platform Admin     | `apps/admin`     | 3002         | `admin.brandspace.cc` |
| HTTP API           | `apps/api`       | 3003         | —                     |
| Background workers | `apps/worker`    | —            | —                     |

Customer and platform sessions are separate realms: different cookie names, signing keys, and token
audiences. A customer session is not merely rejected by Platform Admin — it cannot be verified there.

Full documentation is in [`docs/`](docs/); start with
[`ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`SECURITY.md`](docs/SECURITY.md).
Permanent project rules are in [`CLAUDE.md`](CLAUDE.md).

---

## Prerequisites

| Tool       | Version                          |
| ---------- | -------------------------------- |
| Node.js    | ≥ 22                             |
| pnpm       | ≥ 10                             |
| PostgreSQL | 16+                              |
| Redis      | 7+ (not yet required in Phase 1) |

---

## Local development

### 1. Install

```bash
pnpm install
```

### 2. Create the database roles

**Three roles, deliberately** — this is the two-pool security model (F-01), and it is what makes
the isolation guarantee real rather than aspirational.

| Role                  | Purpose                                                   | Cross-tenant access                   |
| --------------------- | --------------------------------------------------------- | ------------------------------------- |
| `brandspace_migrator` | Owns the schema, runs migrations. Never serves a request. | none                                  |
| `brandspace_app`      | Serves **every tenant request**. Owns nothing.            | **none — no policy names it**         |
| `brandspace_platform` | Serves audited platform operations only.                  | granted by a role-targeted RLS policy |

None of them has `BYPASSRLS`. The platform role's access comes from a policy that is _evaluated
normally_, not a privilege that skips evaluation — so `WITH CHECK` still applies to it and the
behaviour stays visible in `pg_policies`.

```bash
sudo -u postgres psql \
  -v migrator_password=choose-a-local-password \
  -v app_password=choose-another-local-password \
  -v platform_password=choose-a-third-local-password \
  -f scripts/sql/setup-database-roles.sql

sudo -u postgres psql -c "CREATE DATABASE brandspace_dev  OWNER brandspace_migrator;"
sudo -u postgres psql -c "CREATE DATABASE brandspace_test OWNER brandspace_migrator;"
```

The script verifies its own work and fails loudly if any role is privileged or if `brandspace_app`
is a member of `brandspace_platform` (which would let it `SET ROLE` into the platform identity).
Confirm:

```bash
sudo -u postgres psql -Atc \
  "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'brandspace%';"
# all three must show |f|f

sudo -u postgres psql -Atc \
  "SELECT pg_has_role('brandspace_app','brandspace_platform','MEMBER');"
# must be f
```

### 3. Configure the environment

```bash
cp .env.example       .env
cp .env.test.example  .env.test
```

Then edit both and replace every `REPLACE_WITH_…` placeholder.
`.env` and `.env.test` are git-ignored and **must never be committed**.

Generate the session secrets (the two realm secrets must differ):

```bash
openssl rand -base64 48   # CUSTOMER_SESSION_SECRET
openssl rand -base64 48   # PLATFORM_SESSION_SECRET
openssl rand -base64 48   # SECRET_VAULT_KEK
```

### 4. Migrate and seed

```bash
pnpm db:migrate    # applies schema + row-level-security migrations
pnpm db:seed       # one Platform Owner, two isolated workspaces
```

These read `.env` (or `.env.test` when `NODE_ENV=test`) automatically — no
variables need to be exported into your shell first, and no `dotenv` CLI is
required. If no database URL is configured they **fail closed** with an error
naming the missing variable; the value is never printed.

`prisma generate` is different on purpose: client generation reads the schema and
writes TypeScript without opening a connection, so it needs **no environment at
all** and works on a completely clean checkout. This is what the three CI jobs
that run it depend on.

The seed creates:

| Account                  | Realm    | Notes                                          |
| ------------------------ | -------- | ---------------------------------------------- |
| `owner@brandspace.local` | platform | Platform Owner. 2FA required at sign-in (D-27) |
| `amal@acme.local`        | customer | Workspace Owner of `acme-agency`               |
| `noor@northstar.local`   | customer | Workspace Owner of `north-star`                |

Two separate workspaces exist so tenant isolation can be inspected by hand as well as by the test
suite.

From Phase 2B the customer application is real, and the seeded workspace owners can sign in — under the
same rule as the Platform Owner, and only if you choose a password:

```bash
SEED_CUSTOMER_PASSWORD='REPLACE_WITH_A_STRONG_LOCAL_ONLY_VALUE' pnpm db:seed
```

Leave it unset and they are created **passwordless**: the accounts exist, hold their memberships, and
cannot be signed into until somebody invites them or sets a password. No default credential is ever
minted, for the same reason it is not for the platform side.

The Platform Owner **is** signable-in from Phase 2A, but only if you choose a password:

```bash
SEED_PLATFORM_PASSWORD='REPLACE_WITH_A_STRONG_LOCAL_ONLY_VALUE' pnpm db:seed
```

Replace the placeholder — the seed rejects it as written, deliberately, so the line above cannot be
copy-pasted into working use.

There is **no default**. Leave the variable unset and the owner is created without a password and simply
cannot sign in — the safe outcome, since a committed default would be a known credential for every database
this seed is ever pointed at. A value that is present but short or placeholder-shaped is a hard error, and the
rejected value is never printed.

The seed enrols the owner in TOTP and prints the enrolment URI and recovery codes **once**, and only when it
can see a terminal: if stdout is redirected, piped, or running in CI, the details are withheld rather than
written into a log that is retained and searchable. Re-run the seed interactively, or set
`SEED_PRINT_MFA_ENROLMENT=1` if you are certain the output is not captured.

**Upgrading an existing database:** re-run `pnpm db:seed` after pulling the Phase 2A security-review
changes **and again after Phase 2B**. Permissions and role grants are seeded rows, so the Phase 2A
least-privilege split (`platform.configuration.*`, `platform.secret.*`) and the Phase 2B additions
(`billing.*`, `credits.read`, `platform.workspace.update`, `platform.workspace.invite`,
`platform.plan.assign`, `platform.entitlement.override`, `platform.credit.adjust`) only take effect once
they are re-synced.

Phase 2B also changed one existing grant: `workspace_admin` was defined as "every workspace permission
except two", which silently swept in `billing.manage` — an authority `docs/SECURITY.md` §4.3 reserves for
the Workspace Owner. It is now an explicit deny list. Re-seeding removes the grant from existing
databases, because the seed replaces a role's permissions rather than merging them.

### 5. Run

```bash
pnpm --filter @brandspace/web       dev   # http://localhost:3000
pnpm --filter @brandspace/dashboard dev   # http://localhost:3001
pnpm --filter @brandspace/admin     dev   # http://localhost:3002
pnpm --filter @brandspace/api       dev   # http://localhost:3003
pnpm --filter @brandspace/worker    dev
```

---

## Testing

```bash
pnpm test              # unit + isolation
pnpm test:unit         # unit tests, no database needed
pnpm test:isolation    # tenant isolation + RLS + platform role, needs PostgreSQL
pnpm gate:isolation    # the D-29 coverage gate

pnpm e2e:build         # build the three apps (Playwright serves the production output)
pnpm e2e:seed          # seed the test database + a throwaway Control Center account
pnpm test:e2e          # runs e2e:seed, then Playwright
pnpm test:e2e:ui       # the same suite in Playwright's UI mode
pnpm test:e2e:report   # open the HTML report from the last run
```

The E2E suite needs a **migrated test database**, because the Control Center is a real, session-gated
application — a suite that only exercised the signed-out state would prove nothing about it:

```bash
cp .env.test.example .env.test        # then fill in your local role passwords
NODE_ENV=test pnpm db:migrate:deploy
pnpm test:e2e
```

`pnpm e2e:seed` runs the repository seed against the **test** database and then creates a throwaway Platform
Owner: a freshly generated password, a freshly generated TOTP seed, fresh recovery codes, written to
`.e2e-admin.json` (git-ignored, mode 0600, replaced on every run). Nothing there is a real credential and
nothing survives the next seed. The public website and customer dashboard are served with a **placeholder**
database URL and no platform credential at all — their not having one is part of what the suite checks.

First E2E run only, to fetch the browser:

```bash
pnpm exec playwright install --with-deps chromium
```

If you already have a compatible Chromium and would rather not download another, point Playwright
at it — this changes which binary runs the tests, never what is tested:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium pnpm test:e2e
```

`tests/unit/prisma-config.test.ts` runs the Prisma CLI with a **scrubbed
environment** — nothing inherited — to prove `generate` works on a clean checkout
and that connecting commands fail closed without leaking a connection string.
Verification that only ever runs with `.env` exported cannot catch that class of
bug, which is exactly how it reached CI the first time.

`pnpm verify` runs the whole chain exactly as CI does:

```bash
pnpm verify       # format:check → lint → typecheck → isolation gate → unit + isolation tests
pnpm verify:all   # the above, plus the app builds and the Playwright suite
```

Run it at least once in a **clean shell** with nothing exported. Verification that only ever runs
with `.env` loaded cannot catch a missing-environment defect — that is exactly how one reached CI
(`docs/DECISIONS.md` F-06):

```bash
env -i PATH="$PATH" HOME="$HOME" bash -c 'pnpm verify'
```

### What the isolation suite proves

Tenant isolation is enforced in **two independent layers**, and both are tested separately:

| Suite                                      | Layer              | What it proves                                                                                                                                                                    |
| ------------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/isolation/tenant-isolation.test.ts` | application        | The tenant-scoped client cannot read, list, search, count, mutate, or re-parent another workspace's rows                                                                          |
| `tests/isolation/rls-raw-sql.test.ts`      | **database**       | The same holds for raw SQL on a plain `pg` connection, with **no application code in the path**                                                                                   |
| `tests/isolation/as-platform.test.ts`      | escape hatch       | `asPlatform()` requires a valid platform role, verified MFA, a written reason and a correlation id, and always writes an audit event — including when the wrapped operation fails |
| `tests/isolation/platform-role.test.ts`    | **two-pool model** | The tenant role cannot forge platform access by any means: the old GUC is gone, `SET ROLE` is denied, no policy names it, and it cannot grant itself membership                   |

The raw-SQL suite is the important one. It bypasses Prisma entirely, which is the only way to
demonstrate the claim in `docs/SECURITY.md` §2 that isolation holds _even if the application layer is
completely bypassed_.

### The isolation gate (D-29)

`pnpm gate:isolation` reads `schema.prisma`, the tenancy registry
(`packages/database/src/tenant-models.ts`), every migration and the isolation suite, and fails the build
unless all four agree:

1. **every** model is classified in the registry — tenant-owned, platform-owned, identity, or a global
   catalogue. A model nobody classified is a failure, not a default;
2. the classification matches the schema (a model with `workspaceId` is tenant-owned, and vice versa);
3. tenant-owned models have `ENABLE` **and** `FORCE ROW LEVEL SECURITY` plus a policy;
4. platform-owned models additionally have a policy scoped to `brandspace_platform` and every privilege
   revoked from `brandspace_app`;
5. the isolation suite actually exercises each of them.

Requirement 1 exists because of a real bug: `platform_user` carried no `workspaceId`, so the original gate
skipped it, and the RLS migration's blanket `GRANT ... ON ALL TABLES` left the Platform Owner's password hash
readable by the tenant role (`docs/DECISIONS.md` F-10). "Not tenant data" is not the same as "safe".

Adding a model without protection or tests is therefore a build failure, not a review oversight.
`tests/unit/isolation-gate.test.ts` asserts the gate fails when it should, in six different ways — a safety
mechanism nobody has watched fire is not known to work.

---

## Repository layout

```
apps/
  web/         Public website        (Next.js)
  dashboard/   Customer application  (Next.js)
  admin/       Platform Control Center (Next.js, separate session realm)
  api/         HTTP API              (Fastify, route security contracts)
  worker/      Background queues     (BullMQ)
packages/
  shared/              Errors, result types, env schema, logging + redaction, permissions, roles
  database/            Prisma schema, migrations, RLS, tenant-scoped client, asPlatform()
  auth/                Session realms, Argon2id passwords, TOTP MFA, platform sessions
  ui/                  Design tokens, RTL/LTR direction
  config/              Versioned configuration service — 17 domains, validation, activation, rollback
  secrets/             Envelope-encrypted vault; the only decrypt path, and no reveal path
  observability/       OpenTelemetry tracing + span attribute redaction
  providers/           Provider adapter contracts and deterministic fakes
  entitlements/        Plans, features, flags, limits         (Phase 3)
  ai-gateway/          Provider-agnostic AI gateway           (Phase 4)
  social-connectors/   Per-platform connectors                (Phase 6)
  billing/             Payment abstraction                    (Phase 8)
tests/
  unit/        Unit tests (incl. module boundaries, contrast, prisma config)
  isolation/   Tenant isolation, raw-SQL RLS, platform role, asPlatform auditing,
               platform services (config + secrets), Platform Admin authentication
  e2e/         Playwright: RTL/LTR, keyboard, responsive, accessibility, and the
               Control Center journeys (sign-in, MFA, configuration, secrets)
scripts/
  isolation-gate.ts        The D-29 CI gate
  sql/setup-database-roles.sql  Canonical three-role definition
```

Module boundaries are enforced by lint rules generated from the dependency matrix in
`eslint.config.mjs`, mirroring `docs/ARCHITECTURE.md` §4.1. A package may never import an app; an app
may never import another app; and `packages/database` is the only package that may touch PostgreSQL
directly. `tests/unit/module-boundaries.test.ts` asserts each rule in both directions.

---

## Customer authentication and workspace scope

From Phase 2B the customer dashboard is a real, session-gated application. Two things are worth knowing
before working on it:

**The two realms share nothing.** A customer session lives in `customer_session`, a platform session in
`platform_session`. Different cookie, audience, signing key, TTL and `SameSite`. A platform token
presented to the customer app resolves to `null` because its hash is not in that table — not because a
check rejected it.

**Reading workspace data requires a context.** Everything the customer app reads or writes goes through
`inWorkspace()` (`apps/dashboard/src/server/customer-context.ts`), which runs inside `withWorkspace()` —
a transaction that sets `app.workspace_id`, so PostgreSQL RLS applies to every statement including raw
SQL. Two questions precede any workspace, and each has its own narrow mechanism:

| Question                                  | Mechanism                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which workspaces may this session act in? | `withCustomerSession()` sets a transaction-local session-token hash; the `session_membership` and `session_workspace` policies grant exactly that session's own active memberships. SELECT only, tenant role only, and only with a NULL workspace context. |
| What does the plan entitle them to?       | `entitlement_catalogue_snapshot`, a tenant-readable projection the Configuration Service writes when it activates one of three domains. `configuration_version` itself stays platform-owned with every privilege revoked.                                  |

Neither uses `SECURITY DEFINER`. Both are visible in `pg_policies` or as an ordinary table, and both are
asserted in `tests/isolation/`.

---

## Accessing customer data

Application code reads tenant data through `withWorkspace()`:

```ts
import { withWorkspace } from '@brandspace/database';

const brands = await withWorkspace(workspaceId, async (db) => db.brand.findMany());
```

Every call runs in a transaction that sets `app.workspace_id`, so PostgreSQL RLS applies to
everything inside — including raw SQL. There is no unscoped path.

Cross-tenant access has exactly one entry point, and it is audited:

```ts
import { asPlatform } from '@brandspace/database';

await asPlatform(
  platformActor, // valid platform role + verified MFA (D-27)
  {
    action: 'platform.workspace.read',
    reason: 'Investigating ticket SUP-1234',
    requestId, // correlation id, required
  },
  async (db) => db.workspace.findMany(),
);
```

`asPlatform()` fails closed without a platform actor, a valid platform role, verified MFA, a written
reason, or a correlation id — and writes an `AuditEvent` even when the wrapped operation throws,
because the audit is written on a separate connection.

#### The two-pool model (F-01)

`asPlatform()` runs on the **platform pool**, a connection as `brandspace_platform`. Cross-tenant
visibility is a property of _which role connected_ — decided by the credential in the connection
string — not a session variable the application can set.

The earlier design used a PostgreSQL GUC (`app.is_platform_mode()`) that `brandspace_app` could set
itself, so anyone able to run arbitrary SQL as the tenant role could grant themselves cross-tenant
access. That function is now **dropped**, and the tenant role cannot reach platform visibility by any
SQL it can execute: no policy names it, and it is not a member of the platform role, so `SET ROLE`
fails.

|                               | `brandspace_app`                         | `brandspace_platform`       |
| ----------------------------- | ---------------------------------------- | --------------------------- |
| Environment variable          | `DATABASE_URL`                           | `DATABASE_PLATFORM_URL`     |
| Present in                    | every tenant-facing process              | **platform processes only** |
| RLS policy                    | `tenant_isolation` (workspace predicate) | `platform_access` (full)    |
| `BYPASSRLS`                   | no                                       | **no**                      |
| Can `SET ROLE` into the other | no                                       | no                          |

`DATABASE_PLATFORM_URL` must be **absent** from the public website, the customer dashboard,
tenant-facing API processes and ordinary workers. Where it is absent, `asPlatform()` fails closed —
the correct behaviour for a process with no business doing cross-tenant work.

The pool module is not exported from `@brandspace/database`, an ESLint rule rejects importing it from
anywhere but `asPlatform()` and the platform-client seam, and `tests/unit/platform-pool-boundary.test.ts`
asserts all three.

Phase 2A added a second restricted module for the same reason. `@brandspace/database/platform` hands
`apps/admin` and `apps/api` a platform-scoped client for **platform-owned** data — configuration, secrets,
admin sessions — which no tenant policy covers. It is restricted by an ESLint rule, by `import 'server-only'`
in the admin server context (a client-component import becomes a build error), and by the pool's own browser
guard. `@brandspace/secrets` is restricted the same way, because it holds the only decrypt path.

**Residual risk, stated plainly:** anyone holding `DATABASE_PLATFORM_URL` has cross-tenant access.
That credential _is_ the boundary now. What changed is that compromising the tenant application role
no longer grants cross-tenant access — previously it did. Narrowing it further (short-lived credentials from
a secret manager, and splitting read-only from read-write platform access) is still open as F-07.

---

## Security notes for contributors

- Never commit `.env`, credentials, tokens, or customer data. CI fails the build on tracked `.env`
  files and on credential-shaped strings.
- Never bypass RLS except through `asPlatform()`.
- Never weaken a test to make it pass. If a test fails, either the code is wrong or the test encodes
  the wrong expectation — decide which, and say so.
- Every new tenant-owned model needs schema + migration + RLS policy + isolation test in the same
  pull request.
- Every new model of **any** kind must be classified in `packages/database/src/tenant-models.ts`. A
  platform-owned table additionally needs its `platform_only` policy and `REVOKE ALL ... FROM
brandspace_app`. The isolation gate fails the build otherwise.
- Never add a way to display a stored secret. `resolveSecret()` is the only decrypt path and it is
  server-side; masked hints and fingerprints are what the interface shows.
- Never put a credential, token, email address or connection string into a span or a log. The redaction
  layer exists, but it is the last line of defence, not the first.

See [`docs/SECURITY.md`](docs/SECURITY.md) and [`CLAUDE.md`](CLAUDE.md) §2.
