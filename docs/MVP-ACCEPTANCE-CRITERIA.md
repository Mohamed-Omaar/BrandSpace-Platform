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

| ID       | Criterion                                                                                                                                                                                       | Method     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| AC-04.1  | The owner creates a plan from Admin with: key, bilingual name, monthly and annual price, currency, trial days, and sort order                                                                   | [E2E]      |
| AC-04.2  | Plan quotas are settable: users, brands, social accounts, scheduled posts/month, storage GB, analytics retention days                                                                           | [E2E]      |
| AC-04.3  | **No plan name, price, limit, or trial duration appears anywhere in application source code** — verified by a repository scan in CI                                                             | [SEC]      |
| AC-04.4  | A plan with an invalid configuration (missing price for a supported currency, negative limit, unknown feature reference) cannot be activated, and the validation report names the exact problem | [INT]      |
| AC-04.5  | Activation shows an impact preview listing affected workspaces before the owner confirms                                                                                                        | [E2E]      |
| AC-04.6  | Plan activation writes an audit event with the payload diff and the actor                                                                                                                       | [INT]      |
| AC-04.7  | Changing the price of an active plan does not change the price of existing subscriptions                                                                                                        | [INT]      |
| AC-04.8  | The four approved plans — `starter`, `growth`, `scale`, `enterprise` — are creatable with the values in `docs/PRODUCT.md` §10A, entirely from Admin (D-06, D-07, D-10)                          | [E2E]      |
| AC-04.9  | **No plan named "Agency" and no `client_viewer` plan feature exists in the plan catalogue or any customer-facing surface** (D-62). The stored RBAC key is unchanged; it is simply never sold    | [SEC]      |
| AC-04.10 | Both SAR and USD price tables are set explicitly per plan, and **no code path FX-converts a display price at runtime** (D-08)                                                                   | [INT][SEC] |
| AC-04.11 | A trial is 14 days, requires no card, grants 200 credits, and a workspace cannot start a second trial (D-09)                                                                                    | [E2E]      |

---

## 6. Step 5 — Configure AI Credits and Feature Access

| ID       | Criterion                                                                                                                                                                                     | Method     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| AC-05.1  | The owner sets the plan's monthly AI credit allowance and rollover policy                                                                                                                     | [E2E]      |
| AC-05.2  | The owner sets the credit cost for `caption.generate` per model, and the editor displays the implied gross margin at the configured provider cost                                             | [E2E]      |
| AC-05.3  | The owner enables or disables features per plan (e.g. `ai.content_generation`, `calendar`)                                                                                                    | [E2E]      |
| AC-05.4  | Enabling a feature whose dependency is disabled is rejected at validation time with the dependency named                                                                                      | [INT]      |
| AC-05.5  | `entitlements.can(workspace, feature)` returns the correct value for every precedence combination: default, plan, flag rule, workspace override                                               | [UNIT]     |
| AC-05.6  | The entitlement resolution trace in Admin names which rule decided the effective value                                                                                                        | [E2E]      |
| AC-05.7  | Percentage rollout is deterministic — the same workspace always resolves the same way for a given rule                                                                                        | [UNIT]     |
| AC-05.8  | A feature kill switch disables the feature for everyone within the cache TTL, overriding all other rules                                                                                      | [INT]      |
| AC-05.9  | **`brand.brain`, `ai.strategy`, `ai.copilot` and `ai.content_generation` are enabled on EVERY paid plan** including Starter, and Starter's Copilot is functional rather than read-only (D-63) | [INT]      |
| AC-05.10 | At zero available credits an AI action is refused with a clear message and a top-up path; **no postpaid overage is charged and no invoice line is created** (D-11)                            | [INT][E2E] |
| AC-05.11 | Purchased packs expire after 12 months, promotional credits after 3 months, plan credits roll over up to one monthly allowance, and consumption is FIFO by nearest expiry (D-12)              | [INT]      |
| AC-05.12 | A downgrade leaves resources over the new limit **read-only and undeleted**, and they are restored on re-upgrade                                                                              | [INT][E2E] |

> **PHASE 3 STATUS, 2026-09-07.** What is demonstrated, and what is not.
>
> | Criterion        | Status                                                                                                                                                                                                                                                                                                                  |
> | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | AC-04.1, AC-04.2 | **Met.** A structured editor with every field, including the six quota dimensions                                                                                                                                                                                                                                       |
> | AC-04.3          | **Met.** No plan name, price, limit or trial duration in application source; `tests/unit/module-boundaries.test.ts` scans for it                                                                                                                                                                                        |
> | AC-04.4          | **Met.** A missing supported currency, an unknown feature reference, a duplicate key, a capped rollover with no cap and an enum grant with no value are each refused, and the report names the exact path                                                                                                               |
> | AC-04.5          | **Met.** The preview lists the workspaces that would exceed a new limit, by slug and dimension — not merely a count                                                                                                                                                                                                     |
> | AC-04.6          | **Met.** Activation writes an audit event with the actor and the payload diff (Phase 2A)                                                                                                                                                                                                                                |
> | AC-04.7          | **Met.** The agreed price is pinned on the subscription with its source version; an integration test reprices the catalogue and asserts the subscription does not move                                                                                                                                                  |
> | AC-04.8          | **Partially demonstrated.** The four plans are creatable entirely from Admin and the e2e suite creates one end to end. **No plan has been entered into any environment**, because the prices are provisional (D-07) and entering them would look like a launch decision nobody has made                                 |
> | AC-04.9          | **Met.** Validation refuses an Agency plan in either language and a `client_viewer` plan feature; the stored RBAC key is untouched                                                                                                                                                                                      |
> | AC-04.10         | **Met.** One explicitly entered price per supported currency; no code path converts one at runtime                                                                                                                                                                                                                      |
> | AC-04.11         | **Met.** Trial length and credits are configuration; a second trial is refused by a record that is set once and never cleared                                                                                                                                                                                           |
> | AC-05.1, AC-05.3 | **Met.** Allowance, rollover policy and per-plan feature grants are all editable                                                                                                                                                                                                                                        |
> | AC-05.2          | **Not in this phase.** The credit-cost editor and its margin display need real provider costs, which is Phase 4 (D-15)                                                                                                                                                                                                  |
> | AC-05.4          | **Met.** Per plan, not merely globally: enabling a feature whose dependency that same plan leaves off is refused with the dependency named                                                                                                                                                                              |
> | AC-05.5, AC-05.7 | **Met** (Phase 2B engine), covered by unit tests                                                                                                                                                                                                                                                                        |
> | AC-05.6          | **Met** (Phase 2B); the same call decides and explains                                                                                                                                                                                                                                                                  |
> | AC-05.8          | **Met.** A kill switch beats an explicit override, and the one-press control activates in the same action rather than leaving a draft                                                                                                                                                                                   |
> | AC-05.9          | **Enforceable, not yet configured.** Nothing prevents the approved matrix being entered; it has not been, for the same reason as AC-04.8                                                                                                                                                                                |
> | AC-05.10         | **Met.** A refused reservation writes zero `USAGE_CHARGE` rows, and there is no postpaid path to write an invoice line with                                                                                                                                                                                             |
> | AC-05.11         | **Met.** Expiry per source, FIFO by nearest expiry, and rollover capped at one allowance are each asserted against a real database                                                                                                                                                                                      |
> | AC-05.12         | **Partially met.** A downgrade is scheduled for period end and applies at the boundary; excess CREDITS are retained until their own expiry. "Resources over the new limit become read-only" cannot be fully demonstrated until there are resources to hold — brands, social accounts and posts arrive in Phases 5 and 6 |

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

| ID       | Criterion                                                                                                                                                                                                  | Method |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| AC-10.1  | The customer fills at least: identity, audience, tone of voice, and one offer — in Arabic and/or English                                                                                                   | [E2E]  |
| AC-10.2  | Brand Brain entries are stored with both `workspaceId` and `brandId`, and a constraint guarantees the brand belongs to that workspace                                                                      | [INT]  |
| AC-10.3  | Completion status is shown so the customer knows what is still missing                                                                                                                                     | [E2E]  |
| AC-10.4  | Content is stored as localized values, so a third locale would require no schema change                                                                                                                    | [INT]  |
| AC-10.5  | Editing an entry increments its version and preserves the previous value for citation integrity                                                                                                            | [INT]  |
| AC-10.6  | `brand_knowledge.updated` audit events exist                                                                                                                                                               | [INT]  |
| AC-10.7  | Brand Brain is reachable on **every paid plan**, Starter included — it is the intelligence layer, not a premium add-on (D-63)                                                                              | [E2E]  |
| AC-10.8  | Entries record which of the four memories they belong to: Canonical Brand Knowledge, Strategy, Content, or Performance/Learning (D-64)                                                                     | [INT]  |
| AC-10.9  | A human-entered Canonical entry and an inferred learning that contradict each other **both persist**, the human entry wins at retrieval, and the conflict is surfaced rather than silently resolved (D-65) | [INT]  |
| AC-10.10 | An entry in `proposed` state is **never** returned as retrieval grounding; only `approved` entries ground a generation (D-65)                                                                              | [INT]  |

> **Scope note.** AC-10.8 to AC-10.10 describe the Phase 5 Brand Brain backend. They are recorded now so
> that phase is built against the principle in `docs/PRODUCT.md` §6A rather than retrofitted to it. They
> are **not** in the Phase 2C-A or Phase 3 exit criteria.

---

## 12. Step 11 — Customer Generates a Content Draft

| ID      | Criterion                                                                                                                                                                                        | Method     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| AC-11.1 | The customer requests AI content generation for the brand and sees the **credit cost before confirming**                                                                                         | [E2E]      |
| AC-11.2 | The request is authorized against permission, entitlement, and plan limits before any provider call                                                                                              | [INT]      |
| AC-11.3 | The request resolves a routing rule and calls the **mock provider** through the adapter interface — no provider SDK is imported outside `packages/ai-gateway`                                    | [INT][SEC] |
| AC-11.4 | The prompt includes Brand Brain context, and the resulting `ContentItem` records which Brand Brain entries and versions were cited                                                               | [INT][E2E] |
| AC-11.5 | The generated draft is created as a `ContentItem` in `draft` status, linked to the `AIRequest` that produced it                                                                                  | [INT]      |
| AC-11.6 | The API response contains **no** provider API key, no provider raw error, and no internal identifiers beyond the request ID                                                                      | [INT][SEC] |
| AC-11.7 | Generation works and produces sensible output in both Arabic and English                                                                                                                         | [E2E]      |
| AC-11.8 | Where a generation proposes a Brand Brain write-back, the proposal carries provenance, evidence, confidence and an approval state, and is **never** committed on the model's own decision (D-65) | [INT][SEC] |
| AC-11.8 | If no routing rule resolves, the request fails with a clear configuration error and alerts the owner — the gateway never picks a model on its own                                                | [INT]      |
| AC-11.9 | Output is validated against a schema; a malformed provider response is a retryable error and is never persisted                                                                                  | [INT]      |

**Verified in Phase 5B-2.** Where each criterion is proven:

| ID          | Proof                                                                                                                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AC-11.1** | `ContentStudioService.quote()` runs the gateway's own route resolution and returns what `generate()` reserves. `tests/isolation/content-studio-lifecycle.test.ts` asserts the quote EQUALS the amount reserved and that quoting moves no credit; `tests/e2e/content-studio.spec.ts` shows it on the screen before confirming |
| **AC-11.2** | Permission at the route (`content.create`) and brand scope in the service, both before any provider call; the idempotency key replays the first draft and makes no second gateway call                                                                                                                                       |
| **AC-11.3** | Routing resolves through the gateway; the only adapter registered is the mock, reached through `AiProviderAdapter`. No provider SDK is imported anywhere — `packages/content` imports `@brandspace/ai-gateway` and nothing else AI-related                                                                                   |
| **AC-11.4** | `citations` is written from what the RETRIEVER returned, never from the model's text, so a fabricated source is impossible rather than unlikely. Asserted against the retrieved chunk and item ids                                                                                                                           |
| **AC-11.5** | The draft is created `DRAFT` with `aiRequestId` set to the request that produced it                                                                                                                                                                                                                                          |
| **AC-11.6** | The API returns the draft, its variants, the citations and the credits charged — no model key, provider, prompt or raw error. The E2E scans the rendered DOM for each of those strings on both the success and the failure path                                                                                              |
| **AC-11.7** | Both locales, and D-115's dialect resolution on top: brand → workspace → the activated default                                                                                                                                                                                                                               |
| **AC-11.8** | The Content Studio proposes NO Brand Brain write-back, asserted by taking candidate, item and version counts across a real generation. An unrouted task fails as a configuration error and reserves nothing — the gateway picks no model of its own                                                                          |
| **AC-11.9** | The model's output is parsed before it is persisted. Prose instead of JSON fails and writes no row; a fenced JSON body is accepted; a variant for an unrequested platform is dropped and the fan-out is bounded                                                                                                              |

**One honest limitation.** No provider is selected (D-13), and the mock SELECTS retrieved material
rather than generating, so it does not produce the JSON envelope the schema requires. In a browser
the grounded path therefore reaches AC-11.9's refusal; the parsed-draft branch of AC-11.4 and
AC-11.5 is proven in the isolation suite through a scripted adapter. Both outcomes are asserted.
Relaxing the parser so prose became a draft is exactly what AC-11.9 forbids.

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

**Verified in Phase 5B-2.** Where each criterion is proven:

| ID          | Proof                                                                                                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AC-14.1** | `ContentCalendarService.schedule()` places a draft at a chosen wall-clock; `tests/e2e/content-calendar.spec.ts` drives it from the picker to a chip in the agenda                                                                                                                                                    |
| **AC-14.2** | A `CalendarSlot` storing `scheduledAtUtc`, `scheduledLocalTime` and `timezone`. The isolation suite asserts all three agree, and the arithmetic is checked independently: Riyadh is UTC+3, so 09:00 local is 06:00Z                                                                                                  |
| **AC-14.3** | The same wall-clock is a DIFFERENT instant either side of a DST boundary — New York 09:00 is 14:00Z in January and 13:00Z in July — and both render back as 09:00. A skipped hour resolves forward to the jump target; an ambiguous one to the earlier occurrence. `tests/unit/content-calendar.test.ts` covers each |
| **AC-14.4** | The month grid is a real `role="grid"` with seven column headers; the E2E asserts `dir="rtl"`, Arabic weekday names with no English fallback, computed `direction: rtl` on the grid, and that the first column is the configured week start                                                                          |
| **AC-14.5** | `limit.scheduled_posts` resolved through the entitlements engine and consumed BEFORE the row exists. Beyond the ceiling the refusal is `QUOTA_EXCEEDED` — the code the dashboard already turns into an upgrade prompt — and nothing is written. Cancelling refunds it                                                |
| **AC-14.6** | `calendar.requireApprovalBeforeScheduling`. With the gate on, an unapproved item is refused and an `APPROVED` one is admitted — both asserted. **Partially met, and honestly**: the gate is built and tested, but the workflow that grants approval is Phase 5B-3, so the gate ships OFF                             |
| **AC-14.7** | Every slot's `targetKind` is `MOCK`, asserted over all of them. A test reads `packages/content/src/calendar.ts` itself and fails on `fetch(`, `node:http`, `axios`, `undici` or `social-connectors`, because "we did not call a social API" stays true only until somebody adds an import                            |
| **AC-14.8** | Rescheduling moves the slot and writes `content.rescheduled` carrying both times; cancelling writes `content.schedule_cancelled`, refunds the quota and returns the item to `DRAFT`. The E2E does all three in one journey                                                                                           |
| **AC-14.9** | `content.scheduled` exists, carries the local time, the zone and a channel COUNT — and the test asserts the caption and the title are **absent**, not merely that the times are present                                                                                                                              |

**Two deviations, both recorded.** AC-14.6 is partially met as described above. AC-14.2's
`CalendarSlot` is narrower than `docs/DATABASE.md` §4.7's design — no `socialConnectionIds`,
`publishJobIds`, `recurrenceRule` or lock columns, and no publishing states — because every one of
them belongs to the Phase 6 pipeline. §4.7b records what was built and why.

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

**Verified in Phase 5B-3**, for the rows this milestone owns. Where each is proven:

| ID          | Proof                                                                                                                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AC-15.2** | `/[locale]/activity` renders the workspace's events with actor, action, resource and time, in the reader's own language. `tests/e2e/approvals.spec.ts` asserts the list renders, that the page STATES which grade the reader has, and that the Arabic route is `dir="rtl"` with Arabic text rather than a key falling through |
| **AC-15.3** | The `workspaceId` predicate is in the query and RLS enforces it independently. `tests/isolation/phase5b3-approvals-tenancy.test.ts` asserts A's events exclude B's. The reader's GRADE is also a predicate: a brand-graded reader with an empty scope matches nothing, which a unit test pins                                 |
| **AC-15.6** | A refused approval writes `content.approval_denied` with `outcome = DENIED` and its reason. It is written through `denialSink` on a SEPARATE connection, because the refusal rolls back the transaction it was raised in — `tests/isolation/content-approvals.test.ts` asserts the row survives                               |
| **AC-15.7** | Unchanged and re-asserted: UPDATE and DELETE on `audit_event` are revoked from both roles and refused by a trigger. The Activity Log adds no writer at all (D-124)                                                                                                                                                            |

---

## 16A. Phase 5B-3 — Approvals, Command Center, Activity Log, Notifications

The 16-step journey does not contain an approval step: `docs/MVP-ACCEPTANCE-CRITERIA.md` §1 puts the
approvals workflow explicitly **out of the vertical slice** ("present as data, not required by the
slice"). The milestone is nevertheless a required part of Phase 5 — ROADMAP scope items 6, 7 and 8 —
so its criteria are stated here rather than left unwritten, in the same form as the steps above.

| ID       | Criterion                                                                                                                                                   | Method           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| AC-16.1  | A member with `content.submit` can send a draft for review; the item moves to `IN_REVIEW` and an `Approval` cycle opens in the same transaction             | [INT][E2E]       |
| AC-16.2  | A reviewer can approve, request changes, or reject; each verdict moves the item's own status and is recorded against the person who gave it                 | [INT][E2E]       |
| AC-16.3  | Both refusals return the content to an **editable** state — content is never trapped by the workflow                                                        | [INT]            |
| AC-16.4  | `IN_REVIEW` and `APPROVED` are unreachable except through the approvals service — there is **one** content lifecycle                                        | [INT]            |
| AC-16.5  | Self-approval is refused by default and permitted only where the brand's policy allows it (D-122); the policy in force is snapshotted                       | [INT][E2E]       |
| AC-16.6  | Viewer (read-only) **cannot approve at all**, and no configuration can lift it (D-130, D-62; supersedes D-121). The role stays exactly `['workspace.read']` | [INT][UNIT][E2E] |
| AC-16.7  | The approval history for an item shows every cycle, its verdict, its decider and its round number, to members who may read the content                      | [INT]            |
| AC-16.8  | Editing an approved item revokes the approval and records why                                                                                               | [INT]            |
| AC-16.9  | Calendar scheduling honours the **real** approval state, per brand — closing AC-14.6 and D-120                                                              | [INT]            |
| AC-16.10 | Every approval-changing operation is tenant-scoped, permission-checked and audited, including denials                                                       | [ISO][INT]       |
| AC-16.11 | The Command Center aggregates the modules rather than duplicating them, and still states what it cannot measure                                             | [E2E]            |
| AC-16.12 | The Activity Log is workspace-scoped, permission-graded, chronological and filterable, and leaks no cross-workspace actor or object                         | [ISO][E2E]       |
| AC-16.13 | Notifications are produced from domain events, scoped to the workspace, addressed per member, with server-enforced read state and a badge                   | [INT][E2E]       |
| AC-16.14 | No external delivery of any kind occurs — in-app only (D-123), enforced by a database constraint                                                            | [INT][SEC]       |
| AC-16.15 | Every new screen works in Arabic and English, in RTL and LTR, on a phone, by keyboard, and is clean under axe at WCAG 2.2 AA                                | [E2E]            |

**Verified in Phase 5B-3.** Where each criterion is proven:

| ID           | Proof                                                                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AC-16.1**  | `ContentApprovalService.submit()` writes the `approval` and moves the item inside one `withWorkspace` transaction. `tests/isolation/content-approvals.test.ts` asserts both; the E2E drives it from the composer's own button                                                                           |
| **AC-16.2**  | `decide()` with each of the three verdicts, asserted against the item's resulting status AND the approval's `decidedByUserId` and `decidedAt`. A decided cycle refuses a second verdict                                                                                                                 |
| **AC-16.3**  | `REQUEST_CHANGES` → `CHANGES_REQUESTED`, `REJECT` → `DRAFT`. Both editable, both resubmittable, and the difference between them survives in the history rather than in the item's status                                                                                                                |
| **AC-16.4**  | `ContentLibraryService.transition()` no longer accepts `IN_REVIEW`, and never accepted `APPROVED`. A test asserts the direct move is refused and the item stays a draft — the milestone's central integrity change, measured rather than described                                                      |
| **AC-16.5**  | Refused for the requester AND for the author when somebody else submitted, permitted once the brand allows it. The snapshot is asserted by changing the policy afterwards and re-reading the row. The E2E meets the refusal in the browser and lifts it through the policy form                         |
| **AC-16.6**  | `mayApproveForBrand` is unit-tested across every role against both policy states, and end-to-end through the service. A separate test pins `client_viewer` to exactly `['workspace.read']`, so the role cannot be widened by accident                                                                   |
| **AC-16.7**  | `historyForItem()` returns every cycle ordered by round; a test drives two rounds and asserts `['CHANGES_REQUESTED', 'APPROVED']` and `[1, 2]`. The screen renders it for members who may read the content                                                                                              |
| **AC-16.8**  | `editVariant` on an `APPROVED` item returns it to `DRAFT` and writes `content.approval_revoked` with `reason: edited_after_approval`. Asserted directly                                                                                                                                                 |
| **AC-16.9**  | With the brand gate on, an unapproved item is refused and one approved THROUGH THE WORKFLOW schedules. In 5B-2 that second test could only be written by setting the column directly, which is why D-120 shipped the gate off. `CHANGES_REQUESTED` content cannot be scheduled at all                   |
| **AC-16.10** | `tests/isolation/phase5b3-approvals-tenancy.test.ts` — 28 assertions across the three tables, including the composite-key refusal from inside the attacker's own workspace and the identical failure of a real and a fabricated id. Denials are audited on a separate connection (AC-15.6)              |
| **AC-16.11** | Every Command Center figure is read through the module that owns it — the approvals queue through `ContentApprovalService.pendingCount`, activity through `ActivityLogService`, the badge through `NotificationService`. The publishing card still states its reason; the E2E asserts it is still there |
| **AC-16.12** | Scope is a query predicate, graded four ways from `audit.read` (D-125). Keyset paged on `(occurredAt, id)`. The filter's options are the actions occurring within the reader's own scope, so it cannot be used to probe                                                                                 |
| **AC-16.13** | `NotificationService.create` is called by the approvals service, never by a route. `(workspaceId, idempotencyKey)` is unique, so a replayed event writes nothing; `markRead` filters on the reader's own id, so a stranger's attempt changes nothing and reads as a miss                                |
| **AC-16.14** | `notification_channel_is_deliverable` — a CHECK constraint pinning every row to `IN_APP`. No mail, SMS, push or webhook client is imported anywhere in the milestone                                                                                                                                    |
| **AC-16.15** | `tests/e2e/approvals.spec.ts` runs axe over all three routes in both locales, asserts `dir="rtl"` and real Arabic on the Arabic route, asserts the navigation links are reachable by role, and asserts the approvals screen does not scroll horizontally at 390px                                       |

**Corrected after a code-level review** (`docs/SECURITY.md` §26). Seven findings
that every green suite above had passed over, and what now proves each:

| Finding                                                                                                                                                                                                            | Fix                                                                                                                                                                                         | Proof                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **AC-16.12 was not met.** The Activity Log's caller filter REPLACED the authorization predicate: `?brandId=` overwrote a brand-graded reader's scope and `?actorId=` overwrote an own-graded reader's actor clause | Every predicate composed with `AND`, so a filter can only intersect                                                                                                                         | `tests/isolation/activity-log-scope.test.ts` — and both escalation tests FAIL against the previous composition                                                                             |
| **The BrandScope rule was inverted.** An empty membership scope was read as "no brands" rather than the platform's "unrestricted"                                                                                  | `brandIdScopeFilter()` in `@brandspace/shared`, one helper for brand-scoped child rows                                                                                                      | The same file asserts an empty scope sees every brand; a unit test asserts it agrees with `brandInScope()`                                                                                 |
| **AC-16.6 was not reachable** — and the feature has since been **withdrawn**. D-121's grant contradicted D-62, so the repair was not to make it reachable but to remove it (D-130, `docs/SECURITY.md` §26.9)       | `mayApproveForBrand` takes only a permission list; the route, the actions and `reviewSubject()` all require `content.read`; the column is unpatchable, `z.literal(false)`, and CHECK-pinned | `tests/e2e/viewer-read-only.spec.ts` · `content-approvals.test.ts` §_D-62 — the Viewer is strictly read-only_ · `approval-recipients.test.ts` · `approvals-activity-notifications.test.ts` |
| **AC-16.13 was not met.** Recipients ignored membership status and BrandScope                                                                                                                                      | `eligibleReviewers()`: ACTIVE membership ∩ BrandScope ∩ effective authority                                                                                                                 | `tests/isolation/approval-recipients.test.ts` (12 assertions, including cross-brand disclosure)                                                                                            |
| **AC-16.9 had a hole.** An `IN_REVIEW` item could be scheduled with the gate off, and a later verdict moved it out from under the live slot                                                                        | `IN_REVIEW` is not schedulable at all                                                                                                                                                       | `tests/isolation/approvals-concurrency.test.ts`                                                                                                                                            |
| **AC-16.2 was not concurrency-safe.** Two verdicts on one cycle could both succeed                                                                                                                                 | `SELECT … FOR UPDATE` plus a conditional transition on `status = 'PENDING'`                                                                                                                 | The same file races real transactions; all three assertions fail against the previous code                                                                                                 |
| **AC-16.5's snapshot was decorative.** `decide()` re-read the CURRENT policy, so a flip retroactively changed an open cycle                                                                                        | D-126 — the snapshot governs `allowSelfApproval` and `clientApprovalEnabled`; identity stays current                                                                                        | The same file, both for self-approval and for the Viewer grant                                                                                                                             |

Two further corrections with no AC of their own: **D-127** makes assignment real
and server-enforced rather than recorded and ignored, and **D-128** revokes
DELETE on the approval tables from the application role and makes a terminal
cycle immutable (`tests/isolation/phase5b3-approvals-tenancy.test.ts`).

**An eighth finding, which fixing the seventh exposed** (`docs/SECURITY.md`
§26.7b, **D-129**). Enforcing the snapshot in `decide()` left the approvals
screen computing its buttons from the brand's LIVE policy, and
`reviewSubject().mayDecide` answering from the permission and status alone — so
both offered verdicts the server then refused. Not an authorization hole: every
such press was correctly denied, and no rule here is enforced by hiding a
control. It was a correctness defect, and it is now closed at both surfaces
through the single exported `policyFromSnapshot`. Proved by
`content-approvals.test.ts` › _reviewSubject().mayDecide AGREES with decide():
self, under the snapshot_, `approval-recipients.test.ts` › _and
reviewSubject().mayDecide SAYS SO, rather than offering a button that refuses_
— both confirmed failing against the previous code — and by the end-to-end
journey, which now asserts that the open cycle is unmoved by the flip and only
the resubmitted cycle may be approved.

**And then a product-architecture correction, which removed one of them
outright** (`docs/SECURITY.md` §26.9, **D-130**). Findings 2 and 3 above were
repairs to D-121's Viewer approval grant. A review found D-121 in conflict with
**D-62** — the MVP is not an agency product and has no Client Portal, client
hand-off workflow or external reviewer surface — so the grant was withdrawn
rather than repaired. AC-16.6 now reads the opposite way, and is proved the
opposite way: Viewer cannot approve, cannot read a review subject, cannot be
assigned one, is never notified about one, and gets NOT_FOUND from
`/approvals` in both locales. `mayApproveForBrand` no longer accepts a role key
or a policy at all, which is the strongest form the assertion can take. The
_structure_ a future External Review / Guest Approval actor would need —
cycles, assignment, snapshots, immutable history, subject types, notes, the
notification architecture — is preserved untouched, and none of that capability
is built.

**Two deviations, both recorded.** Notifications are **in-app only** where ROADMAP scope item 8 says
"in-app + email": no mail transport exists in the platform, and D-123 records email as Phase 10
launch hardening. `docs/DATABASE.md` §4.8's **`Comment`** is not built — threads, mentions and
anchored positions are a collaboration surface of their own; the approval's request and decision
notes carry the review's context. Both are listed in `docs/ROADMAP.md` under "deliberately not
built".

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

---

## 23. Phase 6 Acceptance Criteria — Social Publishing

These extend the MVP slice rather than restating it. Each is testable, and the `[ ]` column names the
layer that settles it: `[U]` unit, `[ISO]` isolation against real PostgreSQL, `[E2E]` a real browser.

### 23.1 Connections

| ID       | Criterion                                                                                                                    | Layer |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ----- |
| AC-18.1  | A customer connects an account by OAuth. **No screen anywhere requests a social password**                                   | [ISO] |
| AC-18.2  | The authorization URL carries state and a PKCE S256 challenge, and **never the client secret**                               | [U]   |
| AC-18.3  | The state is stored HASHED; the value that travelled through the browser is nowhere in the database                          | [ISO] |
| AC-18.4  | The PKCE verifier is stored ENCRYPTED, bound by context to its workspace and state                                           | [ISO] |
| AC-18.5  | A state may be consumed exactly once; two concurrent callbacks yield exactly one connection                                  | [ISO] |
| AC-18.6  | A state belonging to another workspace cannot complete into this one, and is not consumed by the attempt                     | [ISO] |
| AC-18.7  | A mismatched redirect URI is refused                                                                                         | [ISO] |
| AC-18.8  | Expired, consumed, forged and foreign states are refused with an **identical** message                                       | [ISO] |
| AC-18.9  | A partial scope grant yields `NEEDS_REAUTH`, not a connection that renders healthy                                           | [ISO] |
| AC-18.10 | A brand outside the actor's BrandScope is refused as not-found, identically to one that never existed                        | [ISO] |
| AC-18.11 | The connection ceiling is enforced BEFORE the customer is sent to a consent screen                                           | [ISO] |
| AC-18.12 | Disconnecting revokes at the provider where reachable, clears the credential, and records whether the revocation landed      | [ISO] |
| AC-18.13 | A refresh writes a NEW credential version and retires the old one; a connection with no refresh token becomes `NEEDS_REAUTH` | [ISO] |

### 23.2 Tokens

| ID       | Criterion                                                                                                       | Layer       |
| -------- | --------------------------------------------------------------------------------------------------------------- | ----------- |
| AC-18.14 | A token is never in an API response, an audit event, a notification, a log line or a rendered page              | [ISO] [E2E] |
| AC-18.15 | Credentials are encrypted under a key domain SEPARATE from the platform secret vault; neither opens the other's | [U]         |
| AC-18.16 | A credential row moved to another connection or another workspace **fails to decrypt**                          | [U]         |
| AC-18.17 | With no social KEK configured, the vault refuses to start rather than storing anything unprotected              | [U]         |
| AC-18.18 | A queue message carries identifiers only — never a token, a caption or an account name                          | [U]         |

### 23.3 Publishing

| ID       | Criterion                                                                                                            | Layer |
| -------- | -------------------------------------------------------------------------------------------------------------------- | ----- |
| AC-18.19 | The idempotency key is derived from `(workspace, slot, connection, variant)` with no clock and no randomness         | [U]   |
| AC-18.20 | A second execution of a completed job **does not send again**, and adds no second attempt record                     | [ISO] |
| AC-18.21 | Two jobs for the same triple cannot exist in one workspace; the same key in two workspaces can                       | [ISO] |
| AC-18.22 | **Content in review never publishes**, even with the approval gate switched off                                      | [ISO] |
| AC-18.23 | Approval withdrawn between scheduling and dispatch stops the post with `APPROVAL_REVOKED`                            | [ISO] |
| AC-18.24 | A timeout whose post landed is recorded as PUBLISHED after verification — **never retried**                          | [ISO] |
| AC-18.25 | Where a provider cannot be asked, an indeterminate attempt **stops** at `VERIFICATION_PENDING` and waits for a human | [ISO] |
| AC-18.26 | A permanent failure is not retried; a rate limit is, honouring `Retry-After` with jitter                             | [ISO] |
| AC-18.27 | `UNKNOWN` is neither retryable nor indeterminate                                                                     | [U]   |
| AC-18.28 | A revoked authorization marks the CONNECTION, not only the job, and cannot be retried by hand                        | [ISO] |
| AC-18.29 | A queued post can be cancelled; a published one cannot                                                               | [ISO] |
| AC-18.30 | Cancel and retry apply BrandScope as a query predicate; an out-of-scope job is not-found and is not changed          | [ISO] |
| AC-18.31 | Every attempt is recorded with a bounded, redacted summary and no provider prose                                     | [ISO] |
| AC-18.32 | `publish_attempt` cannot be updated or deleted, even by its own tenant                                               | [ISO] |
| AC-18.33 | The slot and the content item end in states derived from their jobs, never set independently                         | [ISO] |

### 23.4 Providers

| ID       | Criterion                                                                                    | Layer |
| -------- | -------------------------------------------------------------------------------------------- | ----- |
| AC-18.34 | Every provider has an adapter, and every adapter satisfies the same contract                 | [U]   |
| AC-18.35 | Capabilities come from configuration; changing a ceiling changes behaviour with no code edit | [U]   |
| AC-18.36 | A provider is DISABLED by default and cannot be reached until an owner enables it            | [U]   |
| AC-18.37 | An unsupported action fails clearly as `UNSUPPORTED`, not as a content error                 | [U]   |
| AC-18.38 | **A PRODUCTION environment resolves no mock adapter at all** and fails loudly                | [U]   |

### 23.5 Tenancy, authorization and interface

| ID       | Criterion                                                                                                          | Layer     |
| -------- | ------------------------------------------------------------------------------------------------------------------ | --------- |
| AC-18.39 | All five tables are `ENABLE + FORCE` RLS; cross-tenant read, list, count, write, update and delete are all refused | [ISO]     |
| AC-18.40 | Every foreign key to a tenant-owned parent is composite; a foreign id is refused identically to an invented one    | [ISO]     |
| AC-18.41 | `integrations.manage` is held by the Owner, the Admin and the Marketing Manager, and by nobody else                | [U]       |
| AC-18.42 | **`client_viewer` holds no Phase 6 permission** and gets 404 on `/integrations` in both locales                    | [U] [E2E] |
| AC-18.43 | No platform-realm role holds a workspace publishing key                                                            | [U]       |
| AC-18.44 | The screen renders in Arabic and English, RTL and LTR, with no horizontal overflow at 390 px                       | [E2E]     |
| AC-18.45 | The screen is clean under axe (WCAG 2.2 AA) in both locales, with one `h1` and full keyboard operation             | [E2E]     |
| AC-18.46 | A failure is explained by OUR translated sentence; the stored machine code is never shown to a person              | [E2E]     |

### 23.6 The second review pass (P6-R1 … P6-R5)

| ID       | Criterion                                                                                                                                                                                 | Evidence    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| AC-18.49 | A provider's redirect — a browser `GET` to `/v1/social/callback/{provider}` with `code` and `state` — completes the flow and answers `303` to the dashboard                               | [E2E]       |
| AC-18.50 | The callback completes with NO session cookie present, from a context holding none                                                                                                        | [E2E]       |
| AC-18.51 | A forged state, an absent state, an unknown provider and a provider-side denial all answer `303` to the same path; only `declined` is distinguished, and no `error_description` is echoed | [E2E]       |
| AC-18.52 | A grant offering several targets creates NO connection and returns a selection secret                                                                                                     | [Isolation] |
| AC-18.53 | The pending grant's token is encrypted at rest and its selection secret is stored hashed                                                                                                  | [Isolation] |
| AC-18.54 | Choosing the SECOND offered target connects to that one; a target not on the list is refused identically to a forged secret                                                               | [Isolation] |
| AC-18.55 | The choice is single-use, refused for another member, and refused outside the brand scope — all with one sentence                                                                         | [Isolation] |
| AC-18.56 | The customer is shown the choice with no option pre-selected, and picking one connects that page                                                                                          | [E2E]       |
| AC-18.57 | Refreshing a token outside the caller's brand scope is refused identically to a fabricated id, and rotates nothing                                                                        | [Isolation] |
| AC-18.58 | `execute()` on a `VERIFICATION_PENDING` job invokes `publish()` zero times                                                                                                                | [Isolation] |
| AC-18.59 | `retry()` refuses a `VERIFICATION_PENDING` job and every indeterminate failure class                                                                                                      | [Isolation] |
| AC-18.60 | A `PUBLISHING` job past its claim lease is recovered, verified by provider lookup, and never resent                                                                                       | [Isolation] |
| AC-18.61 | A provider without post lookup is never automatically resent, however long it has waited                                                                                                  | [Isolation] |
| AC-18.62 | A duplicate queue delivery invokes `publish()` zero times in every non-`QUEUED` state                                                                                                     | [Isolation] |
| AC-18.63 | Six concurrent materialisations of one slot produce one job, and none of them fails                                                                                                       | [Isolation] |

### 23.7 Not claimed

**AC-18.47 and AC-18.48 are deliberately absent.** There is no criterion asserting a successful publish to
a real platform, and none asserting webhook signature verification: no real provider credential exists
until app review completes (D-18, D-19, D-135), and nothing can send a webhook to verify (D-140). Writing
an acceptance criterion that no test can settle would make this document less useful, not more complete.

---

## 24. Phase 7 Acceptance Criteria — Analytics and Copilot

Each is stated so it can be failed. The suite that settles it is named, because a criterion nothing
exercises is a sentence rather than a criterion.

### AC-16 Ingestion

| ID      | Criterion                                                                                                                       | Settled by                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| AC-16.1 | Two writers converging on one observation produce exactly ONE row, and the later value wins only if it is at least as fresh     | `phase7-analytics-service` (real PostgreSQL) |
| AC-16.2 | A late redelivery carrying an OLDER reading does not roll a stored figure backwards, and is reported as unchanged               | `phase7-analytics-service`                   |
| AC-16.3 | Two schedulers cannot claim one cursor; a sweep in one workspace never claims another's                                         | `phase7-analytics-service`                   |
| AC-16.4 | Retry backoff grows, is capped, is jittered, and every retry is in the future                                                   | `phase7-analytics` (unit)                    |
| AC-16.5 | A mock adapter is unreachable in `PRODUCTION`, including as an explicit override, and every observation records its source kind | `phase7-analytics` (unit)                    |
| AC-16.6 | Ingestion consumes no AI credits                                                                                                | design: no gateway call exists on the path   |

### AC-17 Smart Analytics

| ID      | Criterion                                                                                                                                                | Settled by                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| AC-17.1 | A metric with no observations is `null` with a stated reason — never `0`; a rate with a zero or missing denominator is `null`                            | `phase7-analytics` (unit), E2E  |
| AC-17.2 | A rate is computed from the TOTALS, not averaged from daily rates, and rounds half-up                                                                    | `phase7-analytics` (unit)       |
| AC-17.3 | A change from a zero baseline is `null`, not a percentage                                                                                                | `phase7-analytics` (unit)       |
| AC-17.4 | BrandScope narrows the TOTAL, not just the list — a scoped summary returns the scoped sum                                                                | `phase7-analytics-service`      |
| AC-17.5 | An export contains zero rows from another workspace, carries no internal identifier, and neutralises every formula prefix — asserted on the file's bytes | `phase7-analytics-service`, E2E |
| AC-17.6 | Every chart has a tabular representation of the same figures, and a gap is drawn as a gap                                                                | E2E                             |
| AC-17.7 | A screen containing any `MOCK` figure says so                                                                                                            | E2E                             |

### AC-18 Grounded insights

| ID      | Criterion                                                                                                                                      | Settled by                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| AC-18.1 | Below the evidence floor: no provider call, no reservation, no credit movement, and the customer is told why                                   | `phase7-grounding` (real PostgreSQL)          |
| AC-18.2 | Every persisted `METRIC` evidence row carries a metric key, a value, a unit and a window, and points at a real observation with the same value | `phase7-grounding`                            |
| AC-18.3 | A citation to an ordinal outside the package refuses the whole generation; nothing is persisted                                                | `phase7-grounding`                            |
| AC-18.4 | A correctly-cited claim containing an unmeasured numeral refuses too — including in Arabic-Indic digits                                        | `phase7-grounding`, `phase7-analytics` (unit) |
| AC-18.5 | A retry with the same key replays: no second provider call, no second charge, no leaked reservation                                            | `phase7-grounding`                            |
| AC-18.6 | An anomaly states its baseline, its window, the observed change and the threshold it crossed, and is found without hindsight                   | `phase7-analytics` (unit)                     |

### AC-19 The Copilot

| ID       | Criterion                                                                                                                       | Settled by                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| AC-19.1  | Every tool names a permission that exists; a caller holding nothing is offered nothing; `client_viewer` is offered nothing      | `phase7-copilot-automation` (unit)                  |
| AC-19.2  | One external step lifts the whole plan's class and forces a confirmation; an UNKNOWN tool key classifies as external            | `phase7-copilot-automation` (unit)                  |
| AC-19.3  | The raw confirmation token is returned once and only its digest is stored                                                       | `phase7-copilot-security` (real PostgreSQL)         |
| AC-19.4  | A replayed confirmation is refused; a stale plan hash is refused; a different user is refused; a cancelled plan's token is dead | `phase7-copilot-security`                           |
| AC-19.5  | A refused confirmation is AUDITED and survives the transaction that refused it, and the audit carries no token                  | `phase7-copilot-security`                           |
| AC-19.6  | An unconfirmed plan will not execute; a confirmed plan executes once; two concurrent executions produce one run                 | `phase7-copilot-security`                           |
| AC-19.7  | A membership revoked between confirmation and execution stops the plan                                                          | `phase7-copilot-security`                           |
| AC-19.8  | The MVP journey — create a campaign, confirm, execute, undo — works, and the undo ARCHIVES rather than erases                   | `phase7-copilot-security`                           |
| AC-19.9  | A plan, a tool call or an undo belonging to another workspace is unreachable, unconfirmable and unexecutable                    | `phase7-copilot-tenancy`, `phase7-copilot-security` |
| AC-19.10 | No screen shows a model name, a provider, a prompt, a schema error or a token                                                   | E2E                                                 |

### AC-20 Automations

| ID      | Criterion                                                                                                                                                    | Settled by                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| AC-20.1 | The action registry contains no webhook, script, SQL or URL action                                                                                           | `phase7-copilot-automation` (unit)           |
| AC-20.2 | A rule cannot be created for an action its author may not perform, or for a brand outside their scope                                                        | `phase7-automation-engine` (real PostgreSQL) |
| AC-20.3 | Authority is re-resolved on every run: a lost permission, a narrowed brand scope or a lost membership blocks the run with a stated reason                    | `phase7-automation-engine`                   |
| AC-20.4 | A condition that does not hold is SKIPPED, not FAILED                                                                                                        | `phase7-automation-engine`                   |
| AC-20.5 | Two concurrent deliveries of one event produce exactly one run, and the action runs at most once                                                             | `phase7-automation-engine`                   |
| AC-20.6 | An external action stops at `AWAITING_CONFIRMATION`, publishes nothing, and notifies                                                                         | `phase7-automation-engine`                   |
| AC-20.7 | A confirmer without the action's permission is refused and the refusal is audited; a wrong token publishes nothing; a replayed token publishes nothing twice | `phase7-automation-engine`                   |
| AC-20.8 | A surface with no publish port cannot publish at all — the run is blocked by policy                                                                          | `phase7-automation-engine`                   |

### AC-21 Isolation, migration and the Viewer

| ID      | Criterion                                                                                                                                              | Settled by                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| AC-21.1 | All twelve new models: cross-tenant read, list, count, AGGREGATE, search, write, update, delete and re-parent are all refused                          | `phase7-*-tenancy`                                    |
| AC-21.2 | A foreign id and a fabricated id are indistinguishable                                                                                                 | `phase7-analytics-tenancy`                            |
| AC-21.3 | The migration applies to a POPULATED database from current main, and every pre-existing row survives — compared by id                                  | `phase7-migration-upgrade`                            |
| AC-21.4 | After the upgrade: RLS enabled AND forced on all twelve, a tenant policy on each, DELETE revoked on the two evidence tables, every tenant FK composite | `phase7-migration-upgrade`                            |
| AC-21.5 | A migrations-only database matches the Prisma schema — no drift                                                                                        | `f80-migration-upgrade` drift check                   |
| AC-21.6 | `client_viewer` holds exactly `workspace.read`; all four Phase 7 routes answer 404 in both locales and appear in no navigation                         | `phase2b-boundaries` (unit), `viewer-read-only` (E2E) |

## 25. Phase 8 Acceptance Criteria — Product Completion

**Phase 8 is an umbrella phase delivered in several workstreams (D-195).** AC-22 … AC-25 belong to
workstream 1; AC-26 … AC-30 belong to workstreams 2 … 6. **All of them are now settled**, and each
section below names the suite that settles it — this introduction is a summary of those sections and
never a claim ahead of them.

**AC-30.4 is settled by a FUNCTIONAL journey, not by reachability.** `phase8-journey` proves every
area is reachable and coherent in both locales; `phase8-flow` drives the customer's own actions
through the browser against the approved development/mock adapters — brand selection, Brand Profile,
Brand Brain, strategy, a campaign, content filed under it, an uploaded picture, a generated image in
the Creative Studio, that image in the Asset Library and in the social preview, submission, approval,
scheduling, a real publish through the mock pipeline, its history, analytics, and a proposed learning
arriving in the governed Brand Brain review queue. Reachability alone would not have settled it.

### AC-22 Global Brand Context (Phase 8 — workstream 1, settled)

| ID      | Criterion                                                                                                                                          | Settled by                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| AC-22.1 | A member with unrestricted BrandScope is offered every live brand in their workspace; a restricted member is offered only theirs                   | `phase8-brand-context` (real PostgreSQL)  |
| AC-22.2 | A brand id from another workspace can never be selected, and is indistinguishable from one that does not exist                                     | `phase8-brand-context`                    |
| AC-22.3 | A brand the member's scope excludes cannot be selected and its name is never disclosed                                                             | `phase8-brand-context`                    |
| AC-22.4 | Switching workspace drops an incompatible selection without asking whether that brand exists anywhere                                              | `phase8-brand-context` (unit + isolation) |
| AC-22.5 | The selection survives ordinary navigation, and an explicit `?brand=` in the URL wins over it without rewriting it                                 | `phase8-brand-context` (unit), E2E        |
| AC-22.6 | A brand-required screen NEVER silently selects the first brand: with no valid selection it asks, and with no brands at all it offers to create one | `phase8-brand-context`, E2E               |
| AC-22.7 | "All Brands" aggregates only the brands the CURRENT MEMBER may access                                                                              | `phase8-brand-context`                    |

### AC-23 Brand Profile and canonical identity assets (Phase 8 — workstream 1, settled)

| ID      | Criterion                                                                                                               | Settled by             |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| AC-23.1 | Reading Brand Profile requires `brand.read`; updating it requires `brand.update`; both refuse out of scope with a 404   | `phase8-brand-profile` |
| AC-23.2 | A canonical logo cannot reference an asset in another workspace — the composite key refuses it at the database          | `phase8-brand-profile` |
| AC-23.3 | A canonical logo cannot reference ANOTHER brand's asset; only the brand's own or a workspace-shared asset is admissible | `phase8-brand-profile` |
| AC-23.4 | A quarantined, failed or deleted asset cannot become a canonical logo                                                   | `phase8-brand-profile` |
| AC-23.5 | Deleting the referenced asset clears the reference and never the tenant key                                             | `phase8-brand-profile` |
| AC-23.6 | Every Brand Profile update writes an `AuditEvent`                                                                       | `phase8-brand-profile` |
| AC-23.7 | The screen renders in AR and EN, and the no-logo state says so rather than showing a broken image                       | E2E                    |

### AC-24 Asset Library context (Phase 8 — workstream 1, settled)

| ID      | Criterion                                                                                          | Settled by             |
| ------- | -------------------------------------------------------------------------------------------------- | ---------------------- |
| AC-24.1 | "Shared" returns exactly the assets with `brandId = null`                                          | `phase8-asset-context` |
| AC-24.2 | Selecting one brand never returns another brand's assets                                           | `phase8-asset-context` |
| AC-24.3 | "All Assets" is the member's scope plus shared — never the whole workspace for a restricted member | `phase8-asset-context` |
| AC-24.4 | A brand outside the member's scope cannot be requested as a filter                                 | `phase8-asset-context` |

### AC-25 No product-wide country assumption (Phase 8 — workstream 1, settled)

| ID      | Criterion                                                                                                   | Settled by                 |
| ------- | ----------------------------------------------------------------------------------------------------------- | -------------------------- |
| AC-25.1 | The database declares no country, locale, timezone or currency default for a workspace, and none for a user | `phase8-locale-defaults`   |
| AC-25.2 | Creating a workspace without those values is refused rather than defaulted                                  | `phase8-locale-defaults`   |
| AC-25.3 | The migration preserves every existing stored value exactly                                                 | `phase8-migration-upgrade` |
| AC-25.4 | The Arabic dialect default remains MSA                                                                      | `phase8-locale-defaults`   |

### AC-26 Campaigns (Phase 8 — workstream 2, settled)

| ID      | Criterion                                                                                                                  | Settled by              |
| ------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| AC-26.1 | A customer creates a campaign with an objective, a brief, start and end dates, and channels/platforms                      | `phase8-campaign-form`  |
| AC-26.2 | A campaign can be read, updated and archived; the status lifecycle is explicit and every transition writes an `AuditEvent` | `phase8-campaigns`      |
| AC-26.3 | Content is linked to a campaign, and the campaign's content view lists exactly its own linked content                      | `phase8-campaigns`      |
| AC-26.4 | Campaign performance is computed from the Phase 7 analytics layer — no second analytics stack                              | `phase8-surface-guards` |
| AC-26.5 | Every campaign read and write is workspace-scoped and BrandScope-enforced; a foreign campaign id answers 404               | `phase8-campaigns`      |
| AC-26.6 | The Campaigns sidebar entry appears only with the screen, and is gated on the permission its route requires                | `phase8-navigation`     |

### AC-27 Media in the AI Content Studio (Phase 8 — workstream 3, settled)

| ID      | Criterion                                                                                                              | Settled by                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| AC-27.1 | Media can be uploaded during content creation, into the ONE Asset Library — no second library is created               | `phase8-dictionary-coverage`, E2E |
| AC-27.2 | An existing asset can be chosen: shared assets and the selected brand's assets, and nothing outside the member's scope | `phase8-content-media`            |
| AC-27.3 | Media attaches to content and to platform variants where the platform makes that meaningful                            | `phase8-content-media`            |
| AC-27.4 | Content editing is media-aware, and the social preview shows what will actually be published                           | `phase8-dictionary-coverage`, E2E |
| AC-27.5 | A variant's media respects that platform's own constraints, and a violation is refused with a stated reason            | `phase8-content-media`            |

### AC-28 AI Creative Studio (Phase 8 — workstream 4, settled)

| ID      | Criterion                                                                                                            | Settled by               |
| ------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| AC-28.1 | A customer generates an on-brand image using Brand Profile identity inputs and Brand Brain context where appropriate | `phase8-creative-studio` |
| AC-28.2 | Output format and platform are selectable, and supported platform formats are adapted/resized                        | `phase8-creative-studio` |
| AC-28.3 | Generated media is saved into the ONE Asset Library as an ordinary asset, with provenance recorded                   | `phase8-creative-studio` |
| AC-28.4 | Generated media is selectable inside the Content Studio with no export/import step                                   | `phase8-content-media`   |
| AC-28.5 | Generation is priced, reserved, confirmed and settled through the AI Gateway ledger like every other AI action       | `phase8-creative-studio` |
| AC-28.6 | A failed generation deducts nothing, and a retry never deducts twice                                                 | `phase8-creative-studio` |
| AC-28.7 | No logo is stamped onto a generated visual automatically (D-193)                                                     | `phase8-creative-studio` |
| AC-28.8 | No model, provider or prompt is named anywhere in the customer surface                                               | `phase8-surface-guards`  |

### AC-29 The media workflow, end to end (Phase 8 — workstream 5, settled)

| ID      | Criterion                                                                                                     | Settled by                                           |
| ------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| AC-29.1 | Approvals are media-aware: a reviewer sees the media they are approving                                       | `phase8-publish-media`, E2E                          |
| AC-29.2 | The Calendar is media-aware                                                                                   | `phase8-publish-media`, E2E                          |
| AC-29.3 | The publishing contract carries media payloads, and the provider abstraction accepts them                     | `phase8-publish-media`                               |
| AC-29.4 | A post with media moves through approval, scheduling and publishing without losing its media                  | `phase8-publish-media`                               |
| AC-29.5 | Mock/development adapters prove the whole path end to end; no real provider credential is required            | `phase8-publish-media`                               |
| AC-29.6 | A failed media publish is reported honestly in the reader's language and is safe to retry without duplicating | `phase8-publish-media`, `phase8-dictionary-coverage` |

### AC-30 Marketing Intelligence, navigation and the Phase 8 exit journey (Phase 8 — workstream 6, settled)

| ID      | Criterion                                                                                                                                                                                                                                                                                  | Settled by                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| AC-30.1 | Marketing Intelligence is a real customer-facing surface, integrated with the shell and the brand context                                                                                                                                                                                  | `phase8-intelligence`, E2E                                        |
| AC-30.2 | Every one of the eighteen navigation areas is reachable, and no entry is a placeholder link (D-188)                                                                                                                                                                                        | `phase8-navigation`, E2E                                          |
| AC-30.3 | The product reads as one system in `ar` and `en`, RTL and LTR, at phone width, at WCAG 2.2 AA                                                                                                                                                                                              | `phase8-journey` E2E                                              |
| AC-30.4 | **The exit journey runs end to end:** Workspace → Brand → Brand Profile → Brand Brain → Assets → AI Strategy → Campaign → AI Content Studio → media selection/upload → AI Creative Studio → Approval → Calendar → Publish → Analytics → Marketing Intelligence → learning into Brand Brain | `phase8-flow` E2E (functional), `phase8-journey` E2E (coherence)  |
| AC-30.5 | The whole journey is workspace-isolated and BrandScope-enforced at every step                                                                                                                                                                                                              | `phase8-intelligence`, `phase8-publish-media`, `phase8-campaigns` |

---

## 26. Phase 9 Acceptance Criteria — Commerce & Onboarding

> Every row below is settled by a named suite. `phase9-commerce` and `phase9-account` run against
> REAL PostgreSQL; `phase9-commerce.spec` drives a real browser across two origins.

### AC-31 Money and multi-currency (Phase 9, settled)

| ID      | Criterion                                                                                                      | Settled by                              |
| ------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| AC-31.1 | No floating-point value is the canonical representation of money; amounts are integer minor units              | `money-and-currency`, `phase9-commerce` |
| AC-31.2 | Every monetary row carries its currency AND that currency's own scale; three-digit currencies stay three-digit | `phase9-commerce`                       |
| AC-31.3 | Two amounts in different currencies, or at different scales, cannot be added, compared or netted               | `money-and-currency`                    |
| AC-31.4 | All seven launch currencies price from configuration; none is a default, and none is derived from another      | `money-and-currency`                    |
| AC-31.5 | A plan with no price in the customer's currency is UNAVAILABLE with a stated reason — never converted          | `money-and-currency`, `phase9-commerce` |

### AC-32 The provider-agnostic commercial architecture (Phase 9, settled)

| ID      | Criterion                                                                                                     | Settled by             |
| ------- | ------------------------------------------------------------------------------------------------------------- | ---------------------- |
| AC-32.1 | No production payment provider is named, configured or credentialed anywhere in the repository (D-204)        | `billing-provider`     |
| AC-32.2 | The adapter contract has no method that could accept a card, a CVC or a payment instrument                    | `billing-provider`     |
| AC-32.3 | Provider capabilities are declared and read, never assumed equal                                              | `billing-provider`     |
| AC-32.4 | Every commercial workflow is proven end to end through a deterministic development adapter                    | `phase9-commerce`, E2E |
| AC-32.5 | Provider references are stored separately from canonical billing state and are never authorization boundaries | `commerce-tenancy`     |

### AC-33 Checkout, reconciliation and webhook authority (Phase 9, settled)

| ID      | Criterion                                                                                     | Settled by             |
| ------- | --------------------------------------------------------------------------------------------- | ---------------------- |
| AC-33.1 | A request never carries an amount; the price is resolved server-side and written down first   | `phase9-commerce`, E2E |
| AC-33.2 | A browser redirect never marks anything paid; only a verified event does                      | `phase9-commerce`, E2E |
| AC-33.3 | The signature is verified over the RAW body, before parsing                                   | `billing-provider`     |
| AC-33.4 | A delivery that fails verification writes nothing at all                                      | `phase9-commerce`      |
| AC-33.5 | A replayed event is a duplicate that changes nothing and does not overwrite the first outcome | `phase9-commerce`      |
| AC-33.6 | An event older than the state it describes is recorded and NOT applied                        | `phase9-commerce`      |
| AC-33.7 | An event that matches no trusted mapping is UNRESOLVED, never guessed at or dropped           | `phase9-commerce`      |
| AC-33.8 | A provider amount that does not match ours is a CRITICAL audit and a refusal                  | `phase9-commerce`      |
| AC-33.9 | A captured delivery replayed hours later is refused by the timestamp inside the signed string | `billing-provider`     |

### AC-34 Invoices, credit notes and dunning (Phase 9, settled)

| ID      | Criterion                                                                                         | Settled by                            |
| ------- | ------------------------------------------------------------------------------------------------- | ------------------------------------- |
| AC-34.1 | An issued invoice has a number from the seller's own series; a draft that is discarded burns none | `phase9-commerce`                     |
| AC-34.2 | Twenty simultaneous issues get twenty distinct numbers; a rolled-back issue returns its number    | `phase9-commerce`, `commerce-tenancy` |
| AC-34.3 | An issued invoice is never edited; a correction is a credit note                                  | `phase9-commerce`                     |
| AC-34.4 | A credit note cannot exceed its invoice, and is refused identically on a retry with a new amount  | `phase9-commerce`                     |
| AC-34.5 | Invoice lines carry BOTH languages, written at issue time                                         | `phase9-commerce`, E2E                |
| AC-34.6 | Tax is applied from the market's configured policy; no jurisdiction is named in code              | `billing-provider`                    |
| AC-34.7 | The dunning clock starts at the first failure and is not restarted by later failures              | `phase9-commerce`                     |
| AC-34.8 | A provider's decline message never reaches our rows                                               | `phase9-commerce`                     |
| AC-34.9 | Suspension withdraws access and retains data; nothing in the billing path deletes anything        | `phase9-commerce`                     |

### AC-35 Signup, verification and customer MFA (Phase 9, settled)

| ID      | Criterion                                                                                     | Settled by            |
| ------- | --------------------------------------------------------------------------------------------- | --------------------- |
| AC-35.1 | Signup returns an identical result for a free address and a taken one                         | `phase9-account`      |
| AC-35.2 | An unverified account cannot sign in                                                          | `phase9-account`      |
| AC-35.3 | A verification link works once; expired, used and invented links are indistinguishable        | `phase9-account`      |
| AC-35.4 | Verifying an address does not reactivate a suspended account                                  | `phase9-account`      |
| AC-35.5 | The legal acceptance records WHICH version was accepted, and a stale version is refused       | `phase9-account`      |
| AC-35.6 | The password floor comes from configuration, not from a constant                              | `phase9-account`, E2E |
| AC-35.7 | An MFA seed is never stored in clear, and material copied to another account fails to decrypt | `phase9-account`      |
| AC-35.8 | An MFA-enrolled session resolves to nothing until a code is presented                         | `phase9-account`      |
| AC-35.9 | A recovery code is spent exactly once; disabling MFA requires a working code                  | `phase9-account`      |

### AC-36 Onboarding and the acquisition journey (Phase 9, settled)

| ID      | Criterion                                                                                                                                                      | Settled by                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| AC-36.1 | Country, locale, timezone and currency are all asked for explicitly; nothing is preselected (D-194)                                                            | `phase9-commerce`, E2E                        |
| AC-36.2 | A country the platform does not sell in, and a currency a market does not offer, are both refused honestly                                                     | `phase9-commerce`                             |
| AC-36.3 | A workspace gets one trial, ever, with its credits granted in the same transaction                                                                             | `phase9-commerce`                             |
| AC-36.4 | An owner whose email is unverified cannot create a workspace                                                                                                   | `phase9-commerce`                             |
| AC-36.5 | Onboarding progress is DERIVED from the data; a step completed elsewhere is complete (D-210)                                                                   | E2E                                           |
| AC-36.6 | **The acquisition journey runs end to end:** sign up → verify → sign in → create workspace → billing → hosted checkout → signed event → numbered, paid invoice | `phase9-commerce.spec` E2E                    |
| AC-36.7 | Abandoning checkout charges nothing and says so; the workspace stays on its trial                                                                              | `phase9-commerce.spec` E2E                    |
| AC-36.8 | A prepaid pack raises the balance by exactly the pack, once                                                                                                    | `phase9-commerce.spec` E2E, `phase9-commerce` |
| AC-36.9 | The commercial screens work in `ar` and `en`, RTL and LTR, at WCAG 2.2 AA with zero axe violations                                                             | `phase9-commerce.spec` E2E                    |

### AC-37 Prepaid credits stay prepaid (Phase 9, settled)

| ID      | Criterion                                                                                        | Settled by                                |
| ------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| AC-37.1 | There is no code path that can extend credit; the ledger bridge is one grant-only function       | `phase9-commerce`                         |
| AC-37.2 | A completed pack purchase cannot exist without naming the grant it produced (a CHECK constraint) | `phase9-commerce`, `commerce-tenancy`     |
| AC-37.3 | Two events about the same purchase grant credits once                                            | `phase9-commerce`                         |
| AC-37.4 | Reaching zero stops AI execution; the balance never goes negative                                | `credit-protocol`, `entitlements-credits` |

### AC-38 Tenant isolation over commercial data (Phase 9, settled)

| ID      | Criterion                                                                                                  | Settled by                      |
| ------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------- |
| AC-38.1 | A workspace cannot read, count, search, enumerate or mutate another's billing data                         | `commerce-tenancy`              |
| AC-38.2 | Holding another tenant's provider session id, provider customer id or invoice NUMBER resolves nothing      | `commerce-tenancy`              |
| AC-38.3 | A real id from another workspace and a fabricated id fail identically                                      | `commerce-tenancy`              |
| AC-38.4 | The tenant role has no access to the webhook inbox or the invoice-number counter at all                    | `commerce-tenancy`              |
| AC-38.5 | Every new tenant-owned model carries `workspaceId`, RLS with FORCE, a policy, D-29 registration and a test | `isolation-gate`, `rls-raw-sql` |
