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

The application connects as a role that **cannot bypass row-level security and owns no table**.
This is not a detail — it is what makes the isolation guarantee real, and the isolation test suite
refuses to run on a privileged connection.

```bash
sudo -u postgres psql <<'SQL'
-- Owner/migrator: owns the schema, runs migrations, never serves a request.
-- CREATEDB is only so Prisma can create its shadow database.
CREATE ROLE brandspace_migrator LOGIN PASSWORD 'choose-a-local-password' NOBYPASSRLS CREATEDB;

-- Application role: what the API and workers use. Owns nothing, cannot bypass RLS.
CREATE ROLE brandspace_app LOGIN PASSWORD 'choose-another-local-password' NOBYPASSRLS;

CREATE DATABASE brandspace_dev  OWNER brandspace_migrator;
CREATE DATABASE brandspace_test OWNER brandspace_migrator;
SQL
```

Verify both roles are unprivileged — if either shows `t`, the isolation tests would prove nothing:

```bash
sudo -u postgres psql -Atc \
  "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'brandspace%';"
# expected: brandspace_app|f|f  and  brandspace_migrator|f|f
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
suite. **No passwords are seeded** — authentication flows arrive in Phase 2.

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
pnpm test              # everything
pnpm test:unit         # unit tests, no database needed
pnpm test:isolation    # tenant isolation + RLS, needs PostgreSQL
pnpm gate:isolation    # the D-29 coverage gate
```

`tests/unit/prisma-config.test.ts` runs the Prisma CLI with a **scrubbed
environment** — nothing inherited — to prove `generate` works on a clean checkout
and that connecting commands fail closed without leaking a connection string.
Verification that only ever runs with `.env` exported cannot catch that class of
bug, which is exactly how it reached CI the first time.

`pnpm verify` runs the whole chain exactly as CI does:

```bash
pnpm verify   # format:check → lint → typecheck → isolation gate → tests
```

### What the isolation suite proves

Tenant isolation is enforced in **two independent layers**, and both are tested separately:

| Suite                                      | Layer        | What it proves                                                                                                                                                 |
| ------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/isolation/tenant-isolation.test.ts` | application  | The tenant-scoped client cannot read, list, search, count, mutate, or re-parent another workspace's rows                                                       |
| `tests/isolation/rls-raw-sql.test.ts`      | **database** | The same holds for raw SQL on a plain `pg` connection, with **no application code in the path**                                                                |
| `tests/isolation/as-platform.test.ts`      | escape hatch | `asPlatform()` requires a platform actor with verified MFA and a written reason, and always writes an audit event — including when the wrapped operation fails |

The raw-SQL suite is the important one. It bypasses Prisma entirely, which is the only way to
demonstrate the claim in `docs/SECURITY.md` §2 that isolation holds _even if the application layer is
completely bypassed_.

### The isolation gate (D-29)

`pnpm gate:isolation` parses `schema.prisma`, treats every model with a `workspaceId` field as
tenant-owned, and fails the build unless that model:

1. is declared in `packages/database/src/tenant-models.ts`,
2. has `ENABLE` **and** `FORCE ROW LEVEL SECURITY` in a migration,
3. has an RLS policy, and
4. is actually exercised by the isolation suite.

Adding a tenant-owned model without tests is therefore a build failure, not a review oversight.
`tests/unit/isolation-gate.test.ts` asserts the gate fails when it should — a safety mechanism nobody
has watched fire is not known to work.

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
  auth/                Session realms and actor types
  ui/                  Design tokens, RTL/LTR direction
  config/              Versioned configuration service        (Phase 2)
  entitlements/        Plans, features, flags, limits         (Phase 3)
  ai-gateway/          Provider-agnostic AI gateway           (Phase 4)
  social-connectors/   Per-platform connectors                (Phase 6)
  billing/             Payment abstraction                    (Phase 8)
tests/
  unit/        Unit tests
  isolation/   Tenant isolation, raw-SQL RLS, asPlatform auditing
scripts/
  isolation-gate.ts    The D-29 CI gate
```

Module boundaries are enforced by lint rules generated from the dependency matrix in
`eslint.config.mjs`, mirroring `docs/ARCHITECTURE.md` §4.1. A package may never import an app; an app
may never import another app; and `packages/database` is the only package that may touch PostgreSQL
directly. `tests/unit/module-boundaries.test.ts` asserts each rule in both directions.

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
  platformActor, // must have verified MFA (D-27)
  { action: 'platform.workspace.read', reason: 'Investigating ticket SUP-1234' },
  async (db) => db.workspace.findMany(),
);
```

`asPlatform()` refuses a caller without a platform actor, without verified MFA, or without a written
reason, and writes an `AuditEvent` even when the wrapped operation throws.

---

## Security notes for contributors

- Never commit `.env`, credentials, tokens, or customer data. CI fails the build on tracked `.env`
  files and on credential-shaped strings.
- Never bypass RLS except through `asPlatform()`.
- Never weaken a test to make it pass. If a test fails, either the code is wrong or the test encodes
  the wrong expectation — decide which, and say so.
- Every new tenant-owned model needs schema + migration + RLS policy + isolation test in the same
  pull request.

See [`docs/SECURITY.md`](docs/SECURITY.md) and [`CLAUDE.md`](CLAUDE.md) §2.
