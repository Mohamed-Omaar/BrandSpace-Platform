# Current Execution Phase 5 — Staging + Full E2E

> Status: STARTED after current execution Phase 4 merged and production smoke passed.
>
> Base production commit: `2d2b21a9f059cb7be1238e6fbc36d6d4c87bb740`
>
> Branch: `feat/phase-5-staging-full-e2e`

## Goal

Prove the complete BrandSpace product works as one system in an isolated Railway staging environment before any customer-experience redesign is applied to the real platform.

This phase adds no new product capability unless an end-to-end defect proves a missing implementation. Its job is deployment isolation, integration verification, complete journey testing, remediation of real integration failures, and an explicit go/no-go gate for current execution Phase 6.

## Hard rules

1. Production is not a test environment.
2. Staging must never reuse production data, database contents, Redis contents, storage buckets, storage tokens, session secrets, KEKs/KMS keys, provider credentials, OAuth applications, or domains.
3. `NODE_ENV=production` in Railway staging builds; `APP_ENV=staging` is the runtime environment discriminator.
4. Staging uses development/mock providers where the product deliberately has no real provider activated yet.
5. No production provider is activated in this phase.
6. Do not merge this phase without explicit product-owner approval.
7. Do not start current execution Phase 6 until the Phase 5 exit gate is green.

## Prerequisite owner action — Railway

The connected Railway automation tools cannot create a new environment.

Create exactly one new Railway environment in the existing BrandSpace project:

- Name: `staging`
- Do not clone/copy production variables or data.
- Do not inherit production secrets.

After the environment exists, all remaining Railway work in this phase should be performed against its environment ID only.

## Staging infrastructure contract

Follow `docs/RAILWAY-DEPLOYMENT.md` and `.railway/railway.ts`.

Staging requires its own:

- PostgreSQL instance, EU West/Amsterdam region, private only.
- Redis instance, same region, private only.
- Database roles and credentials.
- Dashboard, Admin, API, Worker and Web services.
- Railway-generated domains first; custom staging domains are optional until the first smoke passes.
- Session secrets.
- Internal service token.
- Three staging-only key-encryption keys / key domains.
- Staging-only object-storage bucket and scoped token.
- Staging-only transactional-email configuration when email items are exercised.

Never copy production values into these fields.

## Staging environment rules

Expected:

- `NODE_ENV=production`
- `APP_ENV=staging`
- `CLIENT_ORIGIN_STRATEGY=railway-edge` on Dashboard and API only.
- No `TRUSTED_PROXY_HOPS` under the Railway strategy.
- Mock/development AI provider only.
- Mock/development social connector only.
- Mock scanner where the existing architecture calls for it.
- Development/sandbox billing behavior only; no live payment provider.
- No production OAuth application credentials.

## Executable bootstrap — the exact owner inputs

Everything the repository can prepare is prepared. What remains are values that
cannot live in Git. Supply them, run the preflight, then deploy.

### 1. Railway (owner action — the environment does not exist yet)

Create ONE environment named `staging` in the existing project. Do not clone
production variables or data. Then supply:

```
RAILWAY_STAGING_ENVIRONMENT_ID=<id>
```

Provision inside it: PostgreSQL (EU West, private), Redis (same region, private),
and the five services. Generate Railway domains for `web`, `dashboard`, `admin`
and `api` before filling the public URLs below.

### 2. Cloudflare R2 (owner action — staging-only, never production's)

```
STORAGE_ENDPOINT=https://<staging-account-id>.r2.cloudflarestorage.com
STORAGE_BUCKET=<a bucket that is NOT the production bucket>
STORAGE_ACCESS_KEY_ID=<token scoped to that bucket alone>
STORAGE_SECRET_ACCESS_KEY=<the secret half>
```

The blueprint says "MUST differ between production and staging" where the
operator reads it, and the preflight rejects a template value — but **no process
can compare the two environments' buckets**. That check is yours.

### 3. Staging cryptography (owner action — generate fresh, never copy)

Staging is sealed by KEKs, not by AWS KMS. This is now enforced: a staging
service that supplies a KMS ARN instead of its KEK is refused, and one that
supplies neither names the KEK it wants **and says "in staging"** so nobody is
invited to paste production's key.

```
SECRET_VAULT_KEK=<fresh, staging only>            # admin, api
SOCIAL_TOKEN_VAULT_KEK=<fresh, staging only>      # api, worker
CUSTOMER_MFA_VAULT_KEK=<fresh, staging only>      # dashboard, api
CUSTOMER_SESSION_SECRET=<fresh>                   # dashboard
PLATFORM_SESSION_SECRET=<fresh>                   # admin
INTERNAL_SERVICE_TOKEN=<fresh>                    # dashboard, admin, api
BILLING_DEV_WEBHOOK_SECRET=<fresh>                # api — sandbox billing only
```

Three distinct KEKs. One key wearing three names is refused.

### 4. Transactional email (owner action — sandbox only)

A staging/sandbox sender that cannot reach real customers. Until it exists, the
email-dependent rows in `docs/PHASE-5-COVERAGE-MATRIX.md` (C6, G9) stay
`BLOCKED ONLY BY LIVE STAGING`. **Do not point staging at the production sender.**

### 5. Public origins

Railway-generated domains first; custom staging domains are optional until the
first smoke passes.

```
PUBLIC_WEB_URL / PUBLIC_DASHBOARD_BASE_URL / PUBLIC_ADMIN_BASE_URL / PUBLIC_API_BASE_URL
```

All https. The parser refuses `http://`.

### 6. Fixed by the blueprint — do not set by hand

```
NODE_ENV=production      # staging is a production BUILD (D-97)
APP_ENV=staging          # the only discriminator
CLIENT_ORIGIN_STRATEGY=railway-edge   # dashboard and api ONLY
```

No `TRUSTED_PROXY_HOPS` anywhere — under `railway-edge` it fails start-up.

### 7. Run the preflight before deploying

```bash
pnpm staging:preflight --env-dir <dir>      # <dir>/dashboard.env, <dir>/api.env, …
pnpm staging:preflight --service api --env-file api.env
```

It asks the same `validateStartupConfiguration` each service calls on the way up,
so it cannot drift from the real contract. It prints **names and statuses only** —
never a value — and exits non-zero until every service is ready.

## Deployment order

1. Create staging environment.
2. Provision Postgres.
3. Provision Redis.
4. Create staging database roles.
5. Apply Railway blueprint/non-secret service configuration.
6. Generate Railway domains for public services.
7. Supply staging-only secrets and public URLs.
8. Run migrations using the migration identity only.
9. Start Worker first.
10. Start API.
11. Start Dashboard.
12. Start Admin.
13. Start Web.
14. Verify health/readiness before functional tests.

## Integration defects found and fixed in the repository-side pass

Four, none of which needed a Railway environment to find.

1. **Staging was held to the production KMS contract** — every service holding a key
   domain reported itself misconfigured in staging, demanding a managed key staging
   does not use. The message invited the one fix that must never happen: pasting
   production's ARN into staging (D-256 context; fixed in `packages/shared/src/env.ts`).
2. **Staging could not carry the sandbox billing secret** its own development payment
   adapter needs.
3. **A provider activated in the Control Center did not reach the API** (D-257). The
   email provider was memoised for sixty seconds keyed on time alone, and the process
   that activates is not the process that sends. `/v1/internal/email/deliver` returned
   200 the whole time, so the failure was silent. Now stamped with the activated
   `configuration_version`: activation and disable take effect on the next send, in
   every process. **Credential rotation remains bounded by `PROVIDER_TTL_MS`, and that
   is a stated contract rather than an oversight.**
4. **A test inherited its precondition from another test** (D-258), which the stale
   cache had been standing in for. Fixed after the product defect underneath it, not
   instead of it.

## Full E2E journey

The staging battery must exercise one coherent customer journey, not isolated pages.

### Identity and onboarding

- Self-serve signup.
- Enumeration-safe behavior.
- Verification email.
- Verification token single-use behavior.
- Sign-in.
- Customer MFA enrollment and verification.
- Password reset.
- Session creation, expiry and sign-out.
- Per-account and per-source abuse ceilings.
- Invitation path where still part of the product.
- Workspace creation/onboarding.

### Workspace and Brand

- Workspace exists with correct membership/role.
- First Brand creation.
- Brand quota enforcement.
- Brand Center data.
- Brand Brain profile/knowledge setup.

### Brand Brain

- Source upload.
- Storage persistence.
- Background job dispatch.
- Worker extraction.
- Chunk/proposal path.
- Review/approval.
- Retrieval with citations.
- Chat grounded in approved knowledge.
- Human precedence over inferred learning.
- Failure path does not create false knowledge.

### Asset Library

- Upload using staging object storage.
- Metadata and ownership.
- Worker processing.
- Derivative path where supported.
- Versioning/folders/tags where already implemented.
- Redeploy does not destroy stored media.
- Cross-workspace access refused.

### Content Studio

- AI draft generation through the mock gateway.
- Credit quote/reservation/settlement.
- Failure releases reservation.
- Platform/channel variants.
- Rewrite/shorten/expand/tone.
- Arabic/English handling and glossary behavior.
- Manual editing.
- Asset attachment.

### Approvals

- Submit for review.
- Self-approval rule.
- Approve.
- Request changes/reject.
- Edit revokes earlier approval where required.
- Brand policy gate.
- Audit events and notifications.

### Calendar

- Schedule approved content.
- Month/week/day/list behavior as implemented.
- Reschedule.
- Cancel.
- Timezone correctness.
- Approval requirement respected.
- No duplicate slot/publish identity.

### Publishing

Use only the existing mock/development social connector.

- Connection contract.
- Approved scheduled item enters publish pipeline.
- Worker consumes job.
- Retry/idempotency.
- Duplicate execution does not publish twice.
- Failure state is visible and auditable.
- Disconnect/reconnect contract.
- No real social post is sent.

### Analytics / Intelligence / Copilot

Where already implemented:

- Mock analytics ingestion.
- Idempotent metric ingestion.
- Insight generation.
- Copilot grounded context.
- Mutating Copilot actions require confirmation.
- Permission is re-checked at execution time.
- Automation rules execute only inside their declared permission/brand/workspace boundary.

### Commerce and credits

- Plan resolution.
- Entitlements.
- Feature flags.
- Credit wallet.
- Reserve → execute → settle.
- Refund/release failure path.
- Monthly/quota enforcement.
- Billing/Usage UI reflects the ledger.
- No live checkout/provider activation.

### Email

Once staging transactional email is configured:

- Signup verification.
- Invitation.
- Password reset.
- No secrets or sensitive content in logs.
- Failed delivery remains explicit; never fake success.

## Isolation and security gates

For every new or exercised tenant-owned model/path:

- RLS is enabled and forced.
- Workspace boundary is tested on real PostgreSQL.
- Brand boundary is tested where applicable.
- Composite workspace/brand foreign keys remain valid.
- Tenant-scoped reads never use platform identity.
- Platform identity use is explicit and audited.
- Viewer remains read-only.
- Cross-realm sessions are rejected.
- Security headers remain present.
- Client-origin contract is active on staging Dashboard/API.
- Missing trusted origin fails closed on production-mode auth code paths.

## Database gate

Before Phase 5 can close:

- All migrations apply from empty.
- Staging migration succeeds.
- Prisma drift: no difference.
- Runtime application identity owns no schema objects.
- Migration identity is not available to request-serving services.
- No production data copied into staging.

## Failure-path gate

Deliberately exercise:

- Redis unavailable/degraded behavior.
- Object storage absent/misconfigured.
- AI provider unavailable.
- Email provider unavailable.
- Worker message loss/re-dispatch path.
- Duplicate webhook/event/job.
- Expired session/token.
- Missing origin identity.
- Rate limit exhausted.
- Insufficient credits.
- Approval missing.
- Unauthorized role.
- Cross-workspace identifiers.

A failure must be explicit, safe and auditable. No fake success.

## Verification battery

Required before owner review:

- format
- lint
- typecheck
- unit suite
- real-PostgreSQL isolation suite
- D-29 gate
- build
- secret scan
- full Playwright E2E
- Arabic RTL + English LTR
- accessibility
- fresh migration from empty
- Prisma drift check
- staging health/readiness
- staging full-journey E2E
- staging smoke test after any domain change

## Exit criteria

Phase 5 is complete only when:

1. Railway staging is isolated and healthy.
2. No production credential/data is present in staging.
3. The complete customer journey passes end to end.
4. All blocking CI jobs are green on the final head.
5. Local/full E2E has no new failure relative to the accepted baseline.
6. Database migrations/drift are clean.
7. All integration defects discovered by staging are remediated and defect-planted.
8. The product owner reviews the final report.
9. No PR is merged without explicit product-owner approval.

## Next phase gate

Only after the Phase 5 owner approval:

**Current execution Phase 6 — Customer Experience Simplification / Redesign**

That phase applies the approved customer-experience reference to the real product without deleting capabilities, including Home, Brand Brain, Content Studio, Calendar, navigation, campaigns, settings, Arabic/RTL and responsive behavior.
