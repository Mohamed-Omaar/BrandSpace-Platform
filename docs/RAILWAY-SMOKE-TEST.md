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

- ☐ **`tsx` survived the build.** The API and worker run `tsx` from
  `devDependencies` against `.ts` source. If Railpack pruned dev dependencies,
  both crash immediately with `tsx: not found`.
  - Check the deploy logs of `api` and `worker` for `tsx: not found` or
    `Cannot find module`.
  - If present → deployment doc §12. The fix is one line per `package.json`.
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

- ☐ 🚫 **Upload fails closed.** Attempt an asset upload. Expected: a refusal
  naming _"No object store is configured."_
  - **A successful upload is a failure of this test.** It would mean production
    accepted the filesystem store and wrote a customer file to a container that
    the next restart discards.
- ☐ ✅ No `STORAGE_*` variable is set on any service
- ☐ ✅ No service is writing to a local path under `/tmp` for customer assets

Deployment doc §6. This unblocks when an S3 adapter exists.

---

## 7. Authentication

- ☐ ✅ **Platform owner sign-in works**, including MFA. It uses the platform
  session realm and TOTP and sends no email, so it is reachable on day one.
- ☐ ✅ The Control Center loads with a platform session
- ☐ ✅ A customer session cookie presented to the Control Center is refused
- ☐ 🚫 **Customer signup cannot complete.** Signing up creates a `PENDING`
  account and the verification email **throws** — _"Email provider 'outbox' has
  no implementation, so nothing was sent."_
  - Correct. A silent success here would be the bug.
- ☐ 🚫 Workspace invitation emails do not send
- ☐ 🚫 Password reset does not send

To exercise customer flows before email is connected, verify an account
directly in the database on **staging only**, and record that you did.

---

## 8. No development adapter is active in production

- ☐ ✅ `APP_ENV=production` on every production service
- ☐ ✅ **`BILLING_DEV_WEBHOOK_SECRET` is set on no service.** If it were, the
  process would refuse to start — confirm it is absent rather than relying on
  the crash.
- ☐ ✅ The Integrations Hub loads and every category reports **no active
  provider**
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

- ☐ ✅ Staging has its own Postgres, Redis and bucket
- ☐ ✅ **No production data is in staging**
- ☐ ✅ No secret is shared between the two environments
- ☐ ✅ Staging `APP_ENV=staging`, production `APP_ENV=production`
- ☐ ✅ Staging domains are distinct and registered separately with any provider

---

## Summary of what cannot work yet, and why that is correct

| Flow                                     | Status | Blocked by                                     |
| ---------------------------------------- | ------ | ---------------------------------------------- |
| Asset and media upload                   | 🚫     | No S3 adapter — deployment doc §6              |
| Customer signup verification             | 🚫     | No email provider — §16                        |
| Workspace invitations                    | 🚫     | No email provider                              |
| Password reset                           | 🚫     | No email provider                              |
| AI generation                            | 🚫     | No AI provider activated                       |
| Social account connection and publishing | 🚫     | No social app registered                       |
| Checkout and subscriptions               | 🚫     | No payment provider chosen (D-204)             |
| Trace export                             | 🚫     | No collector configured — reported, not hidden |

Every one of these refuses loudly. **If any of them appears to succeed, that is
the finding** — it means a production guard was weakened to make a deployment
look green, and the deployment is less trustworthy than a failing one.
