# BrandSpace on Railway — First Deployment Smoke Test

> **الملخص التنفيذي بالعربية**
>
> قائمة تحقق للنشر الأول على Railway. تختبر **البنية التحتية** لا المنتج بأكمله.
> بعض التدفقات **لا يمكن أن تكتمل بعد** لأن المزودين الخارجيين لم يُفعّلوا عمدًا — وهي موسومة صراحة بـ «محجوب متوقَّع»، وفشلها الصامت هو ما يجب أن يقلقنا، لا رفضها الصريح.

This checks that the platform **runs**, not that the product is finished. The
full platform audit is a separate exercise.

Run it top to bottom on **staging first**, then again on production, then a
third time after custom domains are attached.

Legend: ☐ to verify · ✅ expected pass · 🚫 **expected blocked** — an external
provider is deliberately not activated, and a loud refusal is the correct
result.

---

## 0. Before anything else — the two build risks

These are first because they fail the whole deployment and cost minutes to check.

- ☐ **`tsx` survived the build.** The API and worker run `.ts` source through
  `tsx`. It is now a runtime `dependency` of both, so a build that prunes dev
  dependencies is the correct build rather than a failure mode — but check
  anyway, because "it should work now" is not "it did".
  - Check the deploy logs of `api` and `worker` for `tsx: not found` or
    `Cannot find module`.
  - If present → deployment doc §12, and something regressed the packaging that
    `tests/unit/production-runtime.test.ts` guards.
- ☐ **Private networking reached the API.** If the dashboard logs
  `BRANDSPACE_API_URL is not configured` or connection refusals to
  `api.railway.internal`, the environment may be IPv6-only while every process
  binds `0.0.0.0` — deployment doc §9.

---

## 1. Services are up

- ☐ ✅ `web` — deployment succeeded, no restart loop
- ☐ ✅ `dashboard` — deployment succeeded
- ☐ ✅ `admin` — deployment succeeded
- ☐ ✅ `api` — deployment succeeded
- ☐ ✅ `worker` — deployment succeeded
- ☐ ✅ No service is in a crash-restart cycle after five minutes

A crash loop on `api` or `worker` with an environment error is the parser doing
its job. Read the message: it names the failing variable and never prints a
value.

---

## 2. Health endpoints

```bash
curl -sS https://api.example.com/health/live
curl -sSi https://api.example.com/health/ready
```

- ☐ ✅ `/health/live` → `200`, `{"status":"ok"}`
- ☐ ✅ `/health/ready` → `200`, `database` state `ok`
- ☐ ✅ `/health/ready` reports `queue` as `ok` (Redis wired) and **not required**
- ☐ ✅ `/health/ready` reports `tracing` as `not_configured` — no collector, by design
- ☐ ✅ `/health/ready` reports `object-storage` as **`ok`** and **not required**.
  `not_configured` here names the missing `STORAGE_*` variables and means §6
  below will fail — fix it before continuing rather than after.
  - This check reports the **configuration contract**, not a live request to the
    bucket. §6 is the round trip.
- ☐ ✅ Neither response contains a hostname, role, port, driver error or version
- ☐ ✅ The worker's probe answers `{"status":"ok"}` — visible as a passing Railway healthcheck

---

## 3. Pages render

- ☐ ✅ `https://www.example.com` — marketing site, both `/en` and `/ar`
- ☐ ✅ `https://app.example.com` — dashboard reaches its sign-in page
- ☐ ✅ `https://admin.example.com` — Control Center reaches its sign-in page
- ☐ ✅ Arabic renders RTL and English LTR
- ☐ ✅ No CSP violations in the browser console — the policy is nonce-bearing on
  the two dynamic apps and a static variant on the marketing site
- ☐ ✅ Every response behind a session carries `Cache-Control: no-store`

---

## 4. Database

- ☐ ✅ Migrations are current: `prisma migrate status` with
  `DATABASE_MIGRATION_URL` reports no pending migrations
- ☐ ✅ The three roles exist and none is superuser or `BYPASSRLS`:
  ```sql
  SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
   WHERE rolname IN ('brandspace_app','brandspace_platform','brandspace_migrator');
  ```
  All three rows must read `f, f`.
- ☐ ✅ `brandspace_app` cannot become the platform role:
  ```sql
  SELECT pg_has_role('brandspace_app','brandspace_platform','MEMBER');
  ```
  Must be `f`.
- ☐ ✅ **RLS sanity.** Connected as `brandspace_app` with no tenant context set,
  a tenant-owned table returns **zero rows** — not an error, zero rows:
  ```sql
  SELECT count(*) FROM brand;   -- expect 0 with no app.workspace_id set
  ```
  A non-zero count means the connection is not the app role, or RLS is not
  forced. Stop and fix before going further: this is the property the whole
  tenancy model rests on.
- ☐ ✅ `brandspace_app` is refused on a platform-only table:
  ```sql
  SELECT count(*) FROM integration_health_check;   -- expect: permission denied
  ```
- ☐ ✅ No application service holds Railway's provisioned Postgres credential —
  check each service's `DATABASE_URL` begins `postgresql://brandspace_app:`

---

## 5. Redis and the worker

- ☐ ✅ `REDIS_URL` on each service is a Railway **reference**, not a typed literal
- ☐ ✅ Redis has no public URL and no TCP proxy
- ☐ ✅ The worker logs `worker ready` with its queue and concurrency
- ☐ ✅ **A job round-trips.** Trigger one safe piece of background work from the
  dashboard — a small Brand Brain document upload is the cheapest — and confirm
  the worker logs picking it up and completing it.
- ☐ ✅ **Degradation is graceful.** _(staging only, never production)_ Stop
  Redis. The dashboard and API keep serving; `/health/ready` still returns `200`
  with `queue` down and capability `background-jobs` degraded. Restart Redis.
  - A `503` here means the readiness contract was changed — deployment doc §5.2.

---

## 6. Object storage

Cloudflare R2, not a Railway Bucket — deployment doc §6.1. These steps **expect
to pass** once the four `STORAGE_*` values are set; the previous revision of
this document expected them all to be blocked.

- ☐ ✅ `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID` and
  `STORAGE_SECRET_ACCESS_KEY` are set on **`dashboard`, `api` and `worker` only**
- ☐ ✅ They are **not** set on `admin` or `web`
- ☐ ✅ **Staging and production use different buckets and different API tokens.**
  Compare `STORAGE_BUCKET` and `STORAGE_ACCESS_KEY_ID` across the two
  environments; if either matches, stop. A staging test that deletes an object
  is a customer file deleted.
- ☐ ✅ No variable name begins `NEXT_PUBLIC_STORAGE`, and a view-source of the
  dashboard contains no part of the access key or the endpoint

**The round trip — the proof that actually matters:**

- ☐ ✅ **Upload.** Upload an asset in the dashboard. It succeeds, and the file
  appears in the R2 bucket (check in the Cloudflare dashboard, or with
  `aws s3 ls --endpoint-url "$STORAGE_ENDPOINT"`).
- ☐ ✅ **The worker reads it back.** The asset moves out of `PROCESSING` — the
  worker fetched the object from R2 in a different process from the one that
  wrote it, which is what proves the bytes really left the container.
- ☐ ✅ **It survives a redeploy.** Redeploy `dashboard` and `worker`, then open
  the asset again. It is still there and still downloads.
  - This is the single step that would have failed on a container filesystem,
    and it is why production refuses one.
- ☐ ✅ **Integrity.** The stored checksum matches a SHA-256 of the file you
  uploaded. The adapter computes its own; it does not trust the S3 `ETag`, which
  is not a SHA-256 for multipart uploads.
- ☐ ✅ **Delete is idempotent.** Delete the asset, then delete it again through
  the same path. The second attempt does not error.

**Fail-closed still holds:**

- ☐ 🚫 **An incomplete contract refuses loudly.** _(staging only)_ Unset
  `STORAGE_BUCKET` on `dashboard` and redeploy. An upload now fails with an error
  that **names the missing variable**, and `/health/ready` reports
  `object-storage: not_configured`. Restore the value.
  - **A successful upload here is a failure of this test.** It would mean
    production accepted the filesystem store and wrote a customer file to a
    container the next restart discards.
- ☐ ✅ No service is writing to a local path under `/tmp` for customer assets
- ☐ ✅ The Integrations Hub lists `Cloudflare R2 (S3-compatible)` with **no
  configuration form and no Test connection button** — it is configured by the
  deployment, and a second configuration screen would be one nothing reads
  (deployment doc §6.5)

---

## 7. Authentication and transactional email

**Before Resend is activated**, the first three items below are 🚫 and correct.
Run this section once before activation and again after — deployment doc §16.

- ☐ ✅ **Platform owner sign-in works**, including MFA. It uses the platform
  session realm and TOTP and sends no email, so it is reachable on day one.
- ☐ ✅ The Control Center loads with a platform session
- ☐ ✅ A customer session cookie presented to the Control Center is refused
- ☐ 🚫 **Before activation:** signing up creates a `PENDING` account and the
  verification email **throws**. A silent success here would be the bug.

### 7.1 Activate Resend

- ☐ ✅ Control Center → Integrations → Transactional email → **Resend**
- ☐ ✅ Enter the API key and From address, **Save**. The screen reports success
  and the provider is still **not active** — saving is not activating.
- ☐ ✅ Re-open the page: the key shows as **masked metadata only**
  (`re-…`, a fingerprint, a last-rotated time). There is no way to read it back,
  and the input is empty rather than pre-filled.
- ☐ ✅ **Test connection** reports a result. It is still **not active** — testing
  is not activating, and nothing activates automatically after a green test.
  - A restricted _Sending access_ key reports a failure here even though it can
    send. That limitation is stated on the screen; use a key with domain read
    access to test — deployment doc §16.2.
- ☐ ✅ **Activate**, with a change reason. The activation appears in the change
  history with its author, its reason and a rollback.

### 7.2 After activation

- ☐ ✅ **Customer signup verification arrives.** Sign up with a real address you
  control; the verification email is delivered by Resend and the link verifies
  the account.
- ☐ ✅ **Resend verification** sends a second link.
- ☐ ✅ **Password reset** sends, and the link works.
- ☐ ✅ **Workspace invitation** sends, and **invitation resend** sends again.
- ☐ ✅ Every message renders correctly in **both Arabic (RTL) and English (LTR)** —
  set the account locale and repeat one flow.
- ☐ ✅ The `api` log line for each send carries the **template key and provider
  only** — no recipient address, no link.
- ☐ ✅ The Hub shows Resend as the active email provider, and the outbox as
  refused for production.

### 7.3 The secret boundary held

- ☐ ✅ `dashboard` has **no** `SECRET_VAULT_KEK` — the four customer email flows
  above work without it, because the dashboard asks the API to send
  (deployment doc §16.3)
- ☐ ✅ `INTERNAL_SERVICE_TOKEN` is set on `dashboard`, `admin` and `api`, with the
  **same value within an environment** and a **different value** between staging
  and production
- ☐ ✅ `worker` does **not** have `INTERNAL_SERVICE_TOKEN`
- ☐ ✅ `POST /v1/internal/email/deliver` from the public internet **without** the
  token answers **404**, not 401 — it does not confirm the endpoint exists:
  ```bash
  curl -sSi -X POST https://api.example.com/v1/internal/email/deliver \
    -H 'content-type: application/json' -d '{}'
  ```
- ☐ ✅ With a **wrong** token it also answers 404
- ☐ ✅ A request with a valid token but an unknown `templateKey` is refused with
  `VALIDATION_FAILED` — a caller cannot compose a message the product would not
  have sent itself

---

## 8. No development adapter is active in production

- ☐ ✅ `APP_ENV=production` on every production service
- ☐ ✅ **`BILLING_DEV_WEBHOOK_SECRET` is set on no service.** If it were, the
  process would refuse to start — confirm it is absent rather than relying on
  the crash.
- ☐ ✅ The Integrations Hub loads. **Email reports Resend as active** and
  **storage reports Cloudflare R2**; AI, social and payments report **no active
  provider** — none of them was activated by this pass
- ☐ ✅ Each development double shows as refused for production, with its reason
- ☐ 🚫 Activating a development provider in production is refused by the Hub
- ☐ ✅ The health screen reports no time-series store rather than drawing an
  empty chart

---

## 9. Logs carry no secrets

- ☐ ✅ Scan the deploy and runtime logs of all five services for: a database
  password, any KEK, a session secret, a bearer token, anything shaped
  `sk-…`/`AKIA…`/`ghp_…`
- ☐ ✅ Startup logs name missing variables **without printing values**
- ☐ ✅ Error responses carry a stable code and a correlation id, never a stack
  trace or a driver message
- ☐ ✅ No secret appears in any URL or query string

---

## 10. Restart and persistence

- ☐ ✅ Redeploy `api`; it returns healthy without manual intervention
- ☐ ✅ Data written before the redeploy is still there afterwards
- ☐ ✅ Restart `worker` mid-job; the job is retried or completed, not lost
- ☐ ✅ Configuration changed in the Control Center survives a redeploy — it lives
  in Postgres with version history, not in memory
- ☐ ✅ A deploy rollback to the previous deployment succeeds

---

## 11. Boundaries hold

- ☐ ✅ `worker` has no public domain
- ☐ ✅ `postgres` and `redis` have no public URL and no TCP proxy
- ☐ ✅ `dashboard` does **not** have `DATABASE_PLATFORM_URL`
- ☐ ✅ `dashboard` does **not** have `SECRET_VAULT_KEK` or `SOCIAL_TOKEN_VAULT_KEK`
- ☐ ✅ `web` has no database URL, no Redis URL and no key
- ☐ ✅ `worker` does **not** have `SECRET_VAULT_KEK` or `CUSTOMER_MFA_VAULT_KEK`
- ☐ ✅ `CUSTOMER_SESSION_SECRET` and `PLATFORM_SESSION_SECRET` differ
- ☐ ✅ All three KEKs differ from one another

---

## 12. Staging is not production

- ☐ ✅ Staging has its own Postgres, Redis, **R2 bucket and R2 API token**
- ☐ ✅ Staging has its own **Resend API key** and its own
  `INTERNAL_SERVICE_TOKEN`
- ☐ ✅ **No production data is in staging**
- ☐ ✅ No secret is shared between the two environments
- ☐ ✅ Staging `APP_ENV=staging`, production `APP_ENV=production`
- ☐ ✅ Staging domains are distinct and registered separately with any provider

---

## Summary of what works, and what still cannot

**Now working, after configuration** — these moved out of the blocked list in
the production-adapters pass:

| Flow                            | Status | Needs                                      |
| ------------------------------- | ------ | ------------------------------------------ |
| Asset and media upload          | ✅     | The four `STORAGE_*` values — §6           |
| Object read by the worker       | ✅     | The same values on `worker` — §6           |
| Objects survive a redeploy      | ✅     | R2 rather than a container filesystem — §6 |
| Customer signup verification    | ✅     | Resend activated — §7.2                    |
| Resend verification             | ✅     | Resend activated                           |
| Workspace invitation and resend | ✅     | Resend activated                           |
| Password reset                  | ✅     | Resend activated                           |
| Security and billing notices    | ✅     | Resend activated                           |

**Still blocked, deliberately** — no provider has been activated for any of
these, and this pass did not activate one:

| Flow                                     | Status | Blocked by                                     |
| ---------------------------------------- | ------ | ---------------------------------------------- |
| AI generation                            | 🚫     | No AI provider activated                       |
| Social account connection and publishing | 🚫     | No social app registered                       |
| Checkout and subscriptions               | 🚫     | No payment provider chosen (D-204)             |
| Trace export                             | 🚫     | No collector configured — reported, not hidden |

Every one of these refuses loudly. **If any of them appears to succeed, that is
the finding** — it means a production guard was weakened to make a deployment
look green, and the deployment is less trustworthy than a failing one.

The same rule applies in the other direction to the first table: if an upload
succeeds while `STORAGE_*` is incomplete, or a verification email reports
success while no provider is active, the guard has been weakened and the green
tick is worth less than a refusal.
