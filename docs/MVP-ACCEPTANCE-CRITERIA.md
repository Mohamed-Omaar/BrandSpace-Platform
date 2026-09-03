# BrandSpace — MVP Vertical Slice Acceptance Criteria

> **الملخص التنفيذي بالعربية**
>
> هذا المستند يحوّل **الشريحة الرأسية الأولى** (أول رحلة كاملة عبر النظام) إلى **معايير قبول قابلة للاختبار** — أي جُمل يمكن إثبات صحتها
> آليًا بنعم أو لا، وليست أوصافًا عامة.
>
> **الرحلة المطلوب إثباتها:** مالك المنصة يسجّل الدخول ← يهيّئ مزود ذكاء اصطناعي وهمي ← يختبره ويفعّله ← ينشئ خطة ← يضبط الرصيد والميزات ←
> ينشئ مساحة عمل لعميل ← يعيّن الخطة ← العميل يقبل الدعوة ويسجّل الدخول ← ينشئ علامة تجارية ← يكمل عقل العلامة ← يولّد مسودة محتوى ←
> يُخصم الرصيد بشكل صحيح ← يظهر الاستخدام والتكلفة في مركز التحكم ← يضيف المسودة إلى التقويم ← تظهر أحداث التدقيق ←
> **واختبارات آلية تثبت العزل بين مساحات العمل وصحة حساب الرصيد**.
>
> **لا يتضمن النطاق نشرًا حقيقيًا على منصات التواصل** — يُستخدم مزود وهمي فقط قبل بيانات الاعتماد الإنتاجية.
>
> كل معيار له **معرّف** (AC-xx) ليمكن الإشارة إليه في الاختبارات ومراجعة القبول.

---

## 1. Scope of the Vertical Slice

### In scope

Platform Admin authentication · mock AI provider configuration · plan creation · credit and feature
configuration · workspace provisioning · invitation and customer sign-in · brand creation · basic Brand Brain ·
AI content draft generation · credit reservation and settlement · admin usage and cost visibility ·
adding a draft to the Social Calendar · audit events · automated isolation and credit-accounting tests ·
Arabic and English UI.

### Explicitly out of scope

Real social publishing · real AI provider credentials · real payment processing · analytics ingestion ·
AI Copilot · automations · public marketing website · creative/image generation · approvals workflow
(present as data, not required by the slice).

### Verification method legend

**[E2E]** Playwright end-to-end · **[INT]** integration test · **[UNIT]** unit test ·
**[ISO]** isolation suite · **[MAN]** manual verification with evidence · **[SEC]** security check in CI

---

## 2. Step 1 — Platform Owner Signs In

| ID      | Criterion                                                                                                                           | Method     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| AC-01.1 | The Platform Admin app is served on a hostname distinct from the customer dashboard, and is excluded from `robots.txt` and sitemaps | [INT][MAN] |
| AC-01.2 | A Platform Owner with valid credentials and a valid TOTP code reaches the Admin overview                                            | [E2E]      |
| AC-01.3 | Login without a TOTP code fails for Platform Owner and Platform Admin — MFA cannot be skipped                                       | [E2E]      |
| AC-01.4 | A valid **customer** session cookie presented to any Admin route returns 401/403 and never renders admin content                    | [INT]      |
| AC-01.5 | A valid **platform** session cookie presented to a customer dashboard route does not grant customer access                          | [INT]      |
| AC-01.6 | The customer and platform sessions use different cookie names and different signing keys                                            | [INT][SEC] |
| AC-01.7 | Five consecutive failed logins trigger rate limiting with a documented backoff                                                      | [INT]      |
| AC-01.8 | A `platform.login.succeeded` audit event is written with actor, IP, user agent, and timestamp                                       | [INT]      |
| AC-01.9 | The Admin UI renders correctly in both Arabic (RTL) and English (LTR)                                                               | [E2E]      |

---

## 3. Step 2 — Configure a Mock AI Provider

| ID      | Criterion                                                                                                                                                          | Method      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| AC-02.1 | The owner can create an AI provider entry (key, name, base URL, timeout, concurrency) from Admin **without any code change or deployment**                         | [E2E]       |
| AC-02.2 | Provider configuration is stored as a `ConfigurationVersion` in `draft` status with the author recorded                                                            | [INT]       |
| AC-02.3 | Invalid input (malformed URL, missing required field, non-HTTPS base URL) is rejected with a field-level error and nothing is saved                                | [E2E][INT]  |
| AC-02.4 | An API credential can be saved for the provider in a masked input field                                                                                            | [E2E]       |
| AC-02.5 | After saving, **no** API response, page, log line, trace, or error message contains the credential value — only `maskedHint` (last 4), fingerprint, and timestamps | [INT][SEC]  |
| AC-02.6 | The credential value is stored encrypted with authenticated encryption; the ciphertext is not usable outside its `(ref, environment, version)` context             | [UNIT][INT] |
| AC-02.7 | There is **no** UI action anywhere in the product that reveals a stored secret                                                                                     | [MAN][SEC]  |
| AC-02.8 | A `secret.created` audit event exists containing the ref and actor and **not** the value                                                                           | [INT]       |
| AC-02.9 | The development environment's provider configuration is independent of staging and production                                                                      | [INT]       |

---

## 4. Step 3 — Test and Activate the Provider

| ID       | Criterion                                                                                                                 | Method     |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | ---------- |
| AC-03.1  | "Test connection" performs a live probe against the mock provider and displays the result (success/failure, latency)      | [E2E]      |
| AC-03.2  | A failing test displays the error class and does **not** allow activation                                                 | [E2E]      |
| AC-03.3  | Activation transitions the configuration version to `active`, and the previous active version to `superseded`, atomically | [INT]      |
| AC-03.4  | Exactly one `active` configuration version exists per domain per environment, enforced by a database constraint           | [INT]      |
| AC-03.5  | Activation propagates to running processes within the cache TTL (≤ 60 seconds) without a restart                          | [INT]      |
| AC-03.6  | The owner can register at least one model for the provider with modality, unit costs, and quality tier                    | [E2E]      |
| AC-03.7  | The owner can create a routing rule mapping `caption.generate` to the mock model with a fallback, timeout, and max cost   | [E2E]      |
| AC-03.8  | A routing rule referencing a disabled or non-existent model fails validation and cannot be activated                      | [INT]      |
| AC-03.9  | Rollback restores the previous configuration and creates a **new** activation record — history is never rewritten         | [E2E][INT] |
| AC-03.10 | `config.activated` and `ai.provider.activated` audit events exist with a payload diff                                     | [INT]      |

---

## 5. Step 4 — Create a Plan

| ID      | Criterion                                                                                                                                                                                       | Method |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| AC-04.1 | The owner creates a plan from Admin with: key, bilingual name, monthly and annual price, currency, trial days, and sort order                                                                   | [E2E]  |
| AC-04.2 | Plan quotas are settable: users, brands, social accounts, scheduled posts/month, storage GB, analytics retention days                                                                           | [E2E]  |
| AC-04.3 | **No plan name, price, limit, or trial duration appears anywhere in application source code** — verified by a repository scan in CI                                                             | [SEC]  |
| AC-04.4 | A plan with an invalid configuration (missing price for a supported currency, negative limit, unknown feature reference) cannot be activated, and the validation report names the exact problem | [INT]  |
| AC-04.5 | Activation shows an impact preview listing affected workspaces before the owner confirms                                                                                                        | [E2E]  |
| AC-04.6 | Plan activation writes an audit event with the payload diff and the actor                                                                                                                       | [INT]  |
| AC-04.7 | Changing the price of an active plan does not change the price of existing subscriptions                                                                                                        | [INT]  |

---

## 6. Step 5 — Configure AI Credits and Feature Access

| ID      | Criterion                                                                                                                                         | Method |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| AC-05.1 | The owner sets the plan's monthly AI credit allowance and rollover policy                                                                         | [E2E]  |
| AC-05.2 | The owner sets the credit cost for `caption.generate` per model, and the editor displays the implied gross margin at the configured provider cost | [E2E]  |
| AC-05.3 | The owner enables or disables features per plan (e.g. `ai.content_generation`, `calendar`)                                                        | [E2E]  |
| AC-05.4 | Enabling a feature whose dependency is disabled is rejected at validation time with the dependency named                                          | [INT]  |
| AC-05.5 | `entitlements.can(workspace, feature)` returns the correct value for every precedence combination: default, plan, flag rule, workspace override   | [UNIT] |
| AC-05.6 | The entitlement resolution trace in Admin names which rule decided the effective value                                                            | [E2E]  |
| AC-05.7 | Percentage rollout is deterministic — the same workspace always resolves the same way for a given rule                                            | [UNIT] |
| AC-05.8 | A feature kill switch disables the feature for everyone within the cache TTL, overriding all other rules                                          | [INT]  |

---

## 7. Step 6 — Create a Customer Workspace

| ID      | Criterion                                                                                                                     | Method     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| AC-06.1 | The owner creates a workspace with name, slug, type, country, locale, timezone, and currency                                  | [E2E]      |
| AC-06.2 | The workspace is created with `status = trialing` and a `trialEndsAt` derived from **configuration**, not a constant          | [INT]      |
| AC-06.3 | A `CreditWallet` is created for the workspace in the same transaction                                                         | [INT]      |
| AC-06.4 | A duplicate slug is rejected                                                                                                  | [INT]      |
| AC-06.5 | `workspace.created` audit event exists with the actor and initial settings                                                    | [INT]      |
| AC-06.6 | Creating a workspace does **not** grant the platform actor ambient read access to its data — reads still require Support Mode | [INT][ISO] |

---

## 8. Step 7 — Assign the Plan

| ID      | Criterion                                                                                                      | Method |
| ------- | -------------------------------------------------------------------------------------------------------------- | ------ |
| AC-07.1 | The owner assigns the plan to the workspace; a `Subscription` is created in `trialing`                         | [E2E]  |
| AC-07.2 | Plan credits are granted to the wallet as a `plan_grant` `CreditTransaction`, and the balance equals the grant | [INT]  |
| AC-07.3 | The workspace's effective entitlements immediately reflect the plan                                            | [INT]  |
| AC-07.4 | Assignment shows a before/after preview of entitlement and credit changes before confirmation                  | [E2E]  |
| AC-07.5 | `subscription.created` and `credit.granted` audit events exist                                                 | [INT]  |

---

## 9. Step 8 — Customer Accepts the Invitation and Signs In

| ID      | Criterion                                                                                                           | Method     |
| ------- | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| AC-08.1 | The owner sends an invitation specifying role and (optional) brand scope                                            | [E2E]      |
| AC-08.2 | The invitation token is single-use, expiring, and stored **hashed** — the raw token exists only in the emailed link | [INT][SEC] |
| AC-08.3 | An expired, already-used, or tampered token is rejected with a clear message and no account is created              | [INT]      |
| AC-08.4 | Accepting the invitation creates the `User` (if new) and an active `Membership` with the specified role             | [E2E][INT] |
| AC-08.5 | The customer signs in and lands on the Command Center scoped to their workspace                                     | [E2E]      |
| AC-08.6 | The customer's session grants **no** access to Platform Admin routes                                                | [INT]      |
| AC-08.7 | The dashboard renders correctly in Arabic (RTL) and English (LTR), with locale taken from the user's preference     | [E2E]      |
| AC-08.8 | `membership.invited` and `membership.accepted` audit events exist and are visible in the workspace Activity Log     | [INT][E2E] |

---

## 10. Step 9 — Customer Creates a Brand

| ID      | Criterion                                                                                                                       | Method     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| AC-09.1 | The customer creates a brand with name, industry, description, and default locale                                               | [E2E]      |
| AC-09.2 | The brand is created with the caller's `workspaceId`; the client cannot set or override it                                      | [INT][ISO] |
| AC-09.3 | Creating a brand beyond the plan's brand limit is rejected with an upgrade-prompt error code, distinct from a permission denial | [INT]      |
| AC-09.4 | A user without `brand.create` receives 403 and no brand is created                                                              | [INT]      |
| AC-09.5 | `brand.created` audit event exists                                                                                              | [INT]      |

---

## 11. Step 10 — Customer Completes Basic Brand Brain

| ID      | Criterion                                                                                                                             | Method |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| AC-10.1 | The customer fills at least: identity, audience, tone of voice, and one offer — in Arabic and/or English                              | [E2E]  |
| AC-10.2 | Brand Brain entries are stored with both `workspaceId` and `brandId`, and a constraint guarantees the brand belongs to that workspace | [INT]  |
| AC-10.3 | Completion status is shown so the customer knows what is still missing                                                                | [E2E]  |
| AC-10.4 | Content is stored as localized values, so a third locale would require no schema change                                               | [INT]  |
| AC-10.5 | Editing an entry increments its version and preserves the previous value for citation integrity                                       | [INT]  |
| AC-10.6 | `brand_knowledge.updated` audit events exist                                                                                          | [INT]  |

---

## 12. Step 11 — Customer Generates a Content Draft

| ID      | Criterion                                                                                                                                                     | Method     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| AC-11.1 | The customer requests AI content generation for the brand and sees the **credit cost before confirming**                                                      | [E2E]      |
| AC-11.2 | The request is authorized against permission, entitlement, and plan limits before any provider call                                                           | [INT]      |
| AC-11.3 | The request resolves a routing rule and calls the **mock provider** through the adapter interface — no provider SDK is imported outside `packages/ai-gateway` | [INT][SEC] |
| AC-11.4 | The prompt includes Brand Brain context, and the resulting `ContentItem` records which Brand Brain entries and versions were cited                            | [INT][E2E] |
| AC-11.5 | The generated draft is created as a `ContentItem` in `draft` status, linked to the `AIRequest` that produced it                                               | [INT]      |
| AC-11.6 | The API response contains **no** provider API key, no provider raw error, and no internal identifiers beyond the request ID                                   | [INT][SEC] |
| AC-11.7 | Generation works and produces sensible output in both Arabic and English                                                                                      | [E2E]      |
| AC-11.8 | If no routing rule resolves, the request fails with a clear configuration error and alerts the owner — the gateway never picks a model on its own             | [INT]      |
| AC-11.9 | Output is validated against a schema; a malformed provider response is a retryable error and is never persisted                                               | [INT]      |

---

## 13. Step 12 — AI Credits Are Safely Deducted

This is the most important group in the slice.

| ID       | Criterion                                                                                                                            | Method     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| AC-12.1  | Before the provider call, a `reservation` transaction is written and `reservedBalance` increases by the estimate                     | [INT]      |
| AC-12.2  | On success, the reservation is settled into a `usage_charge` for the **actual** amount; any over-estimate is released                | [INT]      |
| AC-12.3  | `wallet.currentBalance` after the request equals `previousBalance − creditsCharged`, exactly                                         | [INT]      |
| AC-12.4  | **A failed provider request charges zero credits** — balance is unchanged and no `usage_charge` row exists                           | [INT]      |
| AC-12.5  | **A timed-out request charges zero credits**, and the sweeper releases the reservation                                               | [INT]      |
| AC-12.6  | **A retried request charges exactly once** — replaying the same idempotency key returns the original result with no new transaction  | [INT]      |
| AC-12.7  | A moderation-blocked request charges zero credits                                                                                    | [INT]      |
| AC-12.8  | **50 concurrent requests against a wallet with capacity for 10 result in exactly 10 charges**, and the balance never goes below zero | [INT]      |
| AC-12.9  | The database rejects any attempt to drive `currentBalance` below zero (`CHECK` constraint)                                           | [INT]      |
| AC-12.10 | `UPDATE` and `DELETE` on `credit_transaction` and `ai_usage_ledger` fail for the application role                                    | [INT][SEC] |
| AC-12.11 | Replaying the entire `CreditTransaction` ledger reproduces `currentBalance` exactly                                                  | [INT]      |
| AC-12.12 | The nightly reconciliation job reports zero drift and zero leaked reservations                                                       | [INT]      |
| AC-12.13 | With a zero balance, an AI request is refused with `insufficient_credits`, and non-AI functionality still works                      | [E2E][INT] |
| AC-12.14 | Exactly one `AIUsageLedger` row is written per successful request, containing provider cost, credits charged, model, and task        | [INT]      |

---

## 14. Step 13 — Usage and Cost Appear in Platform Admin

| ID      | Criterion                                                                                                                                                    | Method     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| AC-13.1 | The AI usage explorer shows the request with task, model, provider, status, latency, tokens, provider cost, and credits charged                              | [E2E]      |
| AC-13.2 | Figures can be sliced by workspace, plan, task, model, and date range                                                                                        | [E2E]      |
| AC-13.3 | Estimated gross margin (credit revenue attributed − provider cost) is shown per workspace and in aggregate, and is arithmetically correct against the ledger | [E2E][INT] |
| AC-13.4 | The request inspector shows **audit-safe metadata only** — no raw prompt or completion text unless retention is explicitly enabled                           | [INT][SEC] |
| AC-13.5 | The workspace's credit balance and burn rate are visible in Admin and match the customer's own view                                                          | [E2E]      |
| AC-13.6 | Viewing these figures requires a platform permission and is available to Operations Viewer in read-only form                                                 | [INT]      |
| AC-13.7 | Cost alert thresholds can be configured, and a simulated breach fires an alert                                                                               | [INT]      |

---

## 15. Step 14 — Customer Adds the Draft to the Social Calendar

| ID      | Criterion                                                                                                 | Method     |
| ------- | --------------------------------------------------------------------------------------------------------- | ---------- |
| AC-14.1 | The customer places the draft on the calendar at a chosen date and time                                   | [E2E]      |
| AC-14.2 | A `CalendarSlot` is created storing UTC time, intended local time, and the workspace timezone             | [INT]      |
| AC-14.3 | The slot displays at the correct local time for viewers in different timezones, and across a DST boundary | [INT][E2E] |
| AC-14.4 | The calendar renders correctly in RTL (Arabic) with correct week start and date formatting                | [E2E]      |
| AC-14.5 | Scheduling beyond the plan's monthly scheduled-post quota is rejected with an upgrade prompt              | [INT]      |
| AC-14.6 | With approval required, an unapproved item **cannot** be scheduled                                        | [INT]      |
| AC-14.7 | The slot targets a **mock** publishing target — no real social platform call occurs anywhere in the slice | [INT][SEC] |
| AC-14.8 | Rescheduling and cancelling update the slot and write audit events                                        | [E2E][INT] |
| AC-14.9 | `content.scheduled` audit event exists                                                                    | [INT]      |

---

## 16. Step 15 — Audit Events Are Visible

| ID      | Criterion                                                                                                                 | Method     |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | ---------- |
| AC-15.1 | Every state-changing action in steps 1–14 produced an audit event                                                         | [INT]      |
| AC-15.2 | The customer's Activity Log shows their workspace's events in readable, localized form                                    | [E2E]      |
| AC-15.3 | The customer's Activity Log contains **zero** events from any other workspace                                             | [ISO]      |
| AC-15.4 | The platform audit log shows all events with actor, resource, outcome, and redacted before/after diffs                    | [E2E]      |
| AC-15.5 | Audit events contain no secrets, tokens, passwords, or raw credentials — verified by a pattern scan over generated events | [INT][SEC] |
| AC-15.6 | Denied authorization attempts are also audited                                                                            | [INT]      |
| AC-15.7 | Audit events cannot be updated or deleted through any application code path                                               | [INT][SEC] |
| AC-15.8 | Events carry `requestId` and `traceId` that correlate with application logs                                               | [INT]      |

---

## 17. Step 16 — Automated Tests Prove Isolation and Credit Accounting

### 17.1 Tenant isolation (all **[ISO]**, all blocking in CI)

Setup: Workspace A and Workspace B, each with a user, a brand, Brand Brain entries, a content item, a
calendar slot, an AI request, and a credit wallet.

| ID       | Criterion                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| AC-16.1  | A's user requesting B's brand/content/asset/slot/knowledge by ID receives **404**, identical in body and shape to a genuine miss |
| AC-16.2  | Every list endpoint called by A returns zero rows belonging to B, on any page, filter, or sort                                   |
| AC-16.3  | Text search from A never returns B's content                                                                                     |
| AC-16.4  | **Vector search from A never returns B's Brand Brain chunks**, with the predicate applied inside the ANN query                   |
| AC-16.5  | Update or delete of any B resource from A returns 404 and leaves B's row byte-identical                                          |
| AC-16.6  | Creating a child record under a B parent from A is rejected                                                                      |
| AC-16.7  | Any export produced by A contains zero B rows                                                                                    |
| AC-16.8  | Counts, aggregates, and dashboard metrics for A exclude B entirely                                                               |
| AC-16.9  | A cannot obtain a signed storage URL for a B object, and B's object keys are not enumerable                                      |
| AC-16.10 | A queue job with a forged `workspaceId` fails authorization rather than executing                                                |
| AC-16.11 | Raw SQL executed as the application role with A's context returns zero B rows — **RLS holds independently of application code**  |
| AC-16.12 | The application database role does not have `BYPASSRLS` and is not the table owner                                               |
| AC-16.13 | A's AI request cannot consume B's credit wallet, and A cannot read B's wallet, ledger, or usage                                  |
| AC-16.14 | A's user cannot enumerate B's members, invitations, or roles                                                                     |
| AC-16.15 | Switching workspaces clears client caches; no B data appears from a stale cache                                                  |
| AC-16.16 | Every tenant-owned Prisma model is covered by the generated isolation test; **CI fails if a model has no coverage**              |
| AC-16.17 | Error messages and HTTP status codes never disclose whether a resource exists in another workspace                               |

### 17.2 Credit accounting (all **[INT]**/**[UNIT]**, all blocking in CI)

| ID       | Criterion                                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| AC-16.18 | Ledger replay reproduces the wallet balance for every seeded scenario                                                      |
| AC-16.19 | Failure, timeout, and moderation-block paths each charge exactly zero                                                      |
| AC-16.20 | Retry with the same idempotency key charges exactly once                                                                   |
| AC-16.21 | Concurrency test: N parallel requests on a wallet sized for M (M < N) produce exactly M charges and a non-negative balance |
| AC-16.22 | Reservation leaks are zero after the sweeper runs                                                                          |
| AC-16.23 | FIFO-by-expiry consumption is respected, and each charge records its source grant bucket                                   |
| AC-16.24 | Monthly reset applies the plan's rollover policy exactly                                                                   |
| AC-16.25 | Admin credit adjustments produce ledger rows and audit events, and never edit a balance directly                           |
| AC-16.26 | Refund of a usage charge produces a compensating row; the original row is unmodified                                       |

---

## 18. Cross-Cutting Criteria

### 18.1 Configuration-driven

| ID      | Criterion                                                                                                                                                    | Method     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| AC-17.1 | A repository scan finds **no** hard-coded plan names, prices, limits, trial durations, AI provider names, model names, or credit costs in application source | [SEC]      |
| AC-17.2 | The entire slice can be reconfigured (new plan, new credit cost, new routing rule, feature toggled) with **zero deployments**                                | [MAN][E2E] |
| AC-17.3 | Every configuration change is versioned, validated, activated, auditable, and reversible                                                                     | [INT]      |

### 18.2 Bilingual and accessible

| ID      | Criterion                                                                             | Method |
| ------- | ------------------------------------------------------------------------------------- | ------ |
| AC-17.4 | Every screen in the slice renders correctly in Arabic RTL and English LTR             | [E2E]  |
| AC-17.5 | The build fails if a translation key is missing in either locale                      | [SEC]  |
| AC-17.6 | Automated axe checks report zero critical or serious violations on every slice screen | [E2E]  |
| AC-17.7 | Every flow in the slice is completable using only the keyboard                        | [E2E]  |
| AC-17.8 | Dates, numbers, and times are locale-formatted and timezone-correct                   | [INT]  |

### 18.3 Security

| ID       | Criterion                                                                                                                                              | Method |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| AC-17.9  | No secret value appears in any HTTP response, log line, trace, error message, or frontend bundle — verified by an automated scan over a full slice run | [SEC]  |
| AC-17.10 | Every route declares a scope and permission; the generated route report shows zero unprotected routes                                                  | [SEC]  |
| AC-17.11 | Rate limits are enforced on authentication, AI, and export endpoints                                                                                   | [INT]  |
| AC-17.12 | Security headers (CSP, HSTS, `X-Content-Type-Options`, `frame-ancestors`) are present on all three apps                                                | [INT]  |
| AC-17.13 | Dependency, secret, and static analysis scans pass with no high-severity findings                                                                      | [SEC]  |
| AC-17.14 | No real API keys, OAuth tokens, or credentials exist anywhere in the repository or in test fixtures                                                    | [SEC]  |

### 18.4 Observability and reliability

| ID       | Criterion                                                                                     | Method |
| -------- | --------------------------------------------------------------------------------------------- | ------ |
| AC-17.15 | Every request and job emits a trace with `traceId`, `workspaceId`, and `actorId`              | [INT]  |
| AC-17.16 | Health endpoints report readiness of database, Redis, storage, and migration state            | [INT]  |
| AC-17.17 | Killing and restarting a worker mid-job causes no duplicate side effects and no lost jobs     | [INT]  |
| AC-17.18 | A simulated provider outage produces a graceful, actionable error, and no credits are charged | [INT]  |

### 18.5 Performance

| ID       | Criterion                                                                                                  | Method |
| -------- | ---------------------------------------------------------------------------------------------------------- | ------ |
| AC-17.19 | Dashboard p95 API latency < 500 ms for read endpoints under seeded load                                    | [INT]  |
| AC-17.20 | AI generation returns or streams first output within the configured timeout, with a visible progress state | [E2E]  |
| AC-17.21 | Calendar renders 200 slots without layout jank on a mid-tier device                                        | [E2E]  |

---

## 19. Definition of Done for the Vertical Slice

The slice is complete when **all** of the following hold:

1. Every AC above passes in CI, with isolation and credit tests blocking.
2. The full 16-step journey runs as a single automated E2E test in **both** Arabic and English.
3. The product owner can perform the entire journey manually in staging without engineering assistance.
4. No real provider credentials exist anywhere; only the mock provider is configured.
5. No hard-coded configuration was introduced (verified by scan).
6. Every state change in the journey has an audit event.
7. Documentation in `docs/` matches the implemented behavior.
8. A demo recording of the journey exists in both locales.

---

## 20. Traceability Matrix

| Journey step                             | Acceptance criteria |
| ---------------------------------------- | ------------------- |
| 1. Platform Owner signs in               | AC-01.1 – AC-01.9   |
| 2. Configures a mock AI provider         | AC-02.1 – AC-02.9   |
| 3. Tests and activates the provider      | AC-03.1 – AC-03.10  |
| 4. Creates a plan                        | AC-04.1 – AC-04.7   |
| 5. Configures credits and features       | AC-05.1 – AC-05.8   |
| 6. Creates a customer workspace          | AC-06.1 – AC-06.6   |
| 7. Assigns the plan                      | AC-07.1 – AC-07.5   |
| 8. Customer accepts invitation, signs in | AC-08.1 – AC-08.8   |
| 9. Customer creates a brand              | AC-09.1 – AC-09.5   |
| 10. Completes basic Brand Brain          | AC-10.1 – AC-10.6   |
| 11. Generates a content draft            | AC-11.1 – AC-11.9   |
| 12. Credits safely deducted              | AC-12.1 – AC-12.14  |
| 13. Usage and cost in Admin              | AC-13.1 – AC-13.7   |
| 14. Draft added to the calendar          | AC-14.1 – AC-14.9   |
| 15. Audit events visible                 | AC-15.1 – AC-15.8   |
| 16. Isolation and credit tests           | AC-16.1 – AC-16.26  |
| Cross-cutting                            | AC-17.1 – AC-17.21  |

---

## 21. Phase 2A Status Against These Criteria

> **ملخّص بالعربية**
>
> هذا الجدول يوضح بدقة أي معايير القبول تحققت في المرحلة 2A وأيها لم يتحقق بعد. لم يُعدَّل أي معيار
> ليطابق ما بُني؛ المعايير كما هي، والحالة مذكورة بصدق.

No criterion below was reworded to match what was built. They read as written in Phase 0; only the status
column is new.

### 21.1 Met

| ID       | Where it is proven                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| AC-01.1  | `apps/admin` is a separate app with `robots: { index: false }`; asserted in `tests/e2e/admin-console.spec.ts`             |
| AC-01.2  | E2E: password + TOTP reaches the console and shows the signed-in actor                                                    |
| AC-01.3  | E2E and isolation: a password-only session resolves to **no actor**, and `/console` redirects to sign-in                  |
| AC-01.4  | Isolation + E2E: a token not in `platform_session` resolves to nothing; the realms share no session store                 |
| AC-01.6  | `tests/unit/realms.test.ts` — different cookie names, audiences, and signing-key sources                                  |
| AC-01.7  | **Adapted**: 10 failed attempts (across either factor) lock the account for 15 minutes, refused with the uniform error    |
| AC-01.8  | `platform.login.succeeded` written with actor, IP and timestamp; denials and lockouts audited too                         |
| AC-01.9  | E2E: sign-in and console render in `ar`/RTL and `en`/LTR, with axe, keyboard and overflow checks on every console page    |
| AC-02.2  | Configuration is stored as a `ConfigurationVersion` in `DRAFT` with `createdByPlatformUserId`                             |
| AC-02.3  | Two-stage validation; an invalid payload cannot be activated, and malformed JSON is rejected without a stack trace        |
| AC-02.4  | The secret value field is `type="password"` and never round-trips                                                         |
| AC-02.5  | E2E asserts the plaintext is absent from the **raw HTTP response**, not merely from the DOM; only mask + fingerprint show |
| AC-02.6  | AES-256-GCM per-version data key, wrapped by a KEK; the encryption context is AEAD data, so a replayed ciphertext fails   |
| AC-02.7  | There is no decrypt-and-display code path at all (D-32); E2E enumerates every control on the page to confirm              |
| AC-02.8  | `secret.created` carries the ref and actor; the isolation suite greps every audit row for the value                       |
| AC-02.9  | Environment separation tested across DEVELOPMENT / STAGING / PRODUCTION for both configuration and secrets                |
| AC-03.3  | Activation is atomic; the previous ACTIVE becomes SUPERSEDED in the same transaction                                      |
| AC-03.4  | A **partial unique index** enforces it; the isolation suite proves the database refuses a second ACTIVE                   |
| AC-03.8  | Semantic validation rejects a routing rule pointing at a disabled model                                                   |
| AC-03.9  | Rollback creates a new version; a trigger refuses to rewrite an ACTIVE payload                                            |
| AC-03.10 | `config.activated` is written with the domain, version and reason                                                         |

### 21.2 Not met, and why

| ID      | Status                                                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01.5 | Not testable yet — there is no customer session to present. Phase 2B.                                                                                                                   |
| AC-02.1 | **Partly.** Providers are configured from Admin with no deployment, but through the JSON editor rather than a per-field form (D-30). Field-level errors on a form arrive with the form. |
| AC-03.1 | Provider adapters expose `testConnection()` and the health page runs it, but the Control Center has no per-provider "Test connection" button yet.                                       |
| AC-03.2 | Follows AC-03.1.                                                                                                                                                                        |
| AC-03.5 | **Single-instance only.** In-process cache with a 30-second TTL; cross-instance invalidation over Redis pub/sub is not implemented (F-12).                                              |
| AC-03.6 | The `ai.models` domain and its schema exist; the model-registry form does not.                                                                                                          |
| AC-03.7 | The `ai.routing` domain and its validation exist; the routing-rule form does not.                                                                                                       |
| §5–§16  | Plans, customers, invitations, brands, content, credits, calendar and the customer-facing slice are **not built**. They are Phase 2B and later.                                         |

### 21.3 The vertical slice

§19's end-to-end journey is **not** covered, and no test claims otherwise. It requires customer
authentication, workspaces created from Admin, and the AI gateway — none of which exist yet. What Phase 2A
delivered is the machinery those steps depend on: configuration, secrets, admin identity, and the audit trail.

---

## 22. Phase 2B Status Against These Criteria

> **ملخّص بالعربية**
>
> ما تحقّق فعليًا في المرحلة 2B مقابل معايير القبول، وما لم يتحقّق ولماذا. لم تُعَد صياغة أي معيار ليطابق ما
> بُني: المعايير غير المحقّقة مذكورة كما هي، مع سبب واضح لكل واحد.

No criterion below was reworded to match what was built. Where something is partial, it says so and says
which half is missing.

### 22.1 Met

| ID             | Criterion, and what makes it true                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC-01.5        | **A customer session is rejected by the Control Center.** Previously "not testable — there is no customer session". There is now: the browser suite signs in as a customer and navigates to `/console`, which redirects to sign-in. The realms share no session store, so the rejection is structural. |
| §5 (partial)   | **The owner creates a customer, a workspace and a wallet in one audited transaction**, edits it under optimistic concurrency, and moves it through a lifecycle that refuses unsafe transitions and demands a written reason.                                                                           |
| §6             | **Invitations**: unguessable token stored only as a hash, single-use under concurrency, expiring, revocable, resend-by-supersession, bound to the invited address, and refusing to reveal anything on failure.                                                                                         |
| §7             | **Workspace RBAC** enforced at navigation, page, action and service, with the last-owner and no-escalation invariants enforced inside the transaction that would break them.                                                                                                                           |
| §8 (machinery) | **Entitlement precedence** — all nine levels, kill switch first and unconditional, stable percentage rollout, override validation including dependencies. **Credits** — immutable ledger, idempotent adjustment, row-locked concurrency, no negative balance, replay reconciliation.                   |
| §9             | **Support Mode** — permission + verified MFA + written reason + short expiry, read-only, audited on entry, access, denial, expiry and termination, visible in the customer's own Activity Log, and provably unable to become a customer session or reach a second workspace.                           |
| AC-17.x        | **Isolation tests** cover every new tenant-owned model; the D-29 gate now guards ten tenant-owned and six platform-owned models.                                                                                                                                                                       |

### 22.2 Not met, and why

| ID                              | Status                                                                                                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §5 (rest)                       | **Brands, content, calendar and publishing are not built.** Phase 4–6. The Control Center shows the workspace's identity, status, plan, members, entitlements, credits and audited activity — the operational context §3.3 calls for — and shows nothing it does not have. |
| Self-serve sign-up              | **Not built.** Customers arrive by invitation, which proves control of the address. Sign-up needs email verification, which is F-18.                                                                                                                                       |
| Customer MFA                    | **Not built** (F-17). `docs/SECURITY.md` §3 makes it optional for customers and mandatory for platform roles; only the platform half exists.                                                                                                                               |
| Per-IP rate limiting            | **Not built** (F-19). Both realms lock an account after 10 failed attempts; neither throttles by source address.                                                                                                                                                           |
| Plan editor, prices, allowances | **Deliberately absent.** D-06…D-12 are unanswered owner decisions, so no tier, price or quota is invented (D-40). The machinery reads whatever the owner later configures.                                                                                                 |
| Reserve / settle credits        | **Not built.** Adjustment, ledger and reconciliation exist; reserve→confirm→settle arrives with the AI Gateway that needs it.                                                                                                                                              |
| Support Mode content view       | **Not built.** Support sees operational context, not customer content. Content masking (§8) needs content to mask.                                                                                                                                                         |
| Elevated Support write grant    | **Not issued** (F-16). `assertMayWrite()` always refuses and audits.                                                                                                                                                                                                       |
| §19 vertical slice              | **Still not covered**, and no test claims otherwise. It needs the AI gateway. Phase 2B closed the customer-authentication and workspace-provisioning halves of it.                                                                                                         |

### 22.3 What changed in the criteria themselves

Nothing. Two entries moved from "not met" to "met" (AC-01.5 and the §5/§6 provisioning criteria) because
the behaviour now exists and is tested, not because the wording was softened.
