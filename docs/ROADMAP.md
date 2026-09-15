# BrandSpace — Delivery Roadmap

> **الملخص التنفيذي بالعربية**
>
> خطة التنفيذ مقسّمة إلى **تسع مراحل** متتابعة، كل مرحلة لها مخرجات واضحة وشروط قبول قابلة للاختبار، ولا تبدأ مرحلة قبل اكتمال سابقتها.
>
> - **المرحلة ٠ — المعمارية:** (هذه المرحلة) توثيق المنتج والمعمارية والأمان وقاعدة البيانات — **تنتهي باعتماد مالك المنتج**.
> - **المرحلة ١ — الأساسات:** المستودع، قاعدة البيانات، العزل بين العملاء، المصادقة، الصلاحيات، الترجمة، نظام التصميم.
> - **المرحلة ٢ — مركز التحكم:** لوحة المالك، إدارة العملاء، الإعدادات المُصدَّرة، إدارة الأسرار، سجل التدقيق.
> - **المرحلة ٣ — الخطط والاستحقاقات والرصيد:** الخطط، مفاتيح الميزات، محرك الاستحقاقات، محفظة الرصيد ودفتر الحركات.
> - **المرحلة ٤ — بوابة الذكاء الاصطناعي:** المزودون، النماذج، التوجيه، الحجز والتسوية، المزود الوهمي (Mock).
> - **المرحلة ٥ — رحلة العميل:** العلامة التجارية، عقل العلامة، استوديو المحتوى، التقويم، الموافقات — **وهنا تكتمل الشريحة الرأسية الأولى**.
> - **المرحلة ٦ — الربط والنشر الفعلي:** حسابات التواصل، OAuth، النشر المجدول، إعادة المحاولة.
> - **المرحلة ٧ — التحليلات والمساعد الذكي:** استقبال المقاييس، الرؤى، المساعد الذكي، الأتمتة.
> - **المرحلة ٨ — الفوترة والإطلاق:** الدفع، الفواتير، الموقع العام، الأداء، الأمان، الإطلاق.
> - **التوسعات المستقبلية:** بعد الإطلاق.
>
> **التقدير الزمني تقريبي ويعتمد على حجم الفريق**، والأولوية دائمًا للجودة والأمان على السرعة.

---

## How to Read This Roadmap

- Phases are **sequential**; each has explicit exit criteria that must be demonstrably met before the next begins.
- Effort estimates assume a small team (2–4 engineers) and are **ranges, not commitments**.
- Every phase ends with: tests green (including isolation tests), documentation updated, and a demo.
- Anything marked **[Owner decision]** requires product-owner input before that phase can start.

| Phase | Theme                            | Rough effort |
| ----- | -------------------------------- | ------------ |
| 0     | Architecture                     | 1–2 weeks    |
| 1     | Foundations                      | 3–4 weeks    |
| 2     | Platform Admin                   | 3–4 weeks    |
| 3     | Plans, Entitlements, Credits     | 2–3 weeks    |
| 4     | AI Gateway                       | 3–4 weeks    |
| 5     | Customer Brand & Content Journey | 4–5 weeks    |
| 6     | Social Connections & Publishing  | 5–7 weeks    |
| 7     | Analytics & Copilot              | 4–5 weeks    |
| 8     | Billing & Launch                 | 4–5 weeks    |

---

## Phase 0 — Architecture _(current phase)_

**Goal:** a reviewed, approved blueprint so implementation never guesses.

### Deliverables

- `CLAUDE.md` — permanent project rules
- `docs/PRODUCT.md`, `ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`
- `docs/ADMIN-CONTROL-CENTER.md`, `AI-GATEWAY.md`, `SOCIAL-INTEGRATIONS.md`, `BILLING-AND-CREDITS.md`
- `docs/ROADMAP.md`, `MVP-ACCEPTANCE-CRITERIA.md`, `DECISIONS.md`

### Exit criteria

- [ ] Product owner has read every document (Arabic executive summaries provided for this purpose)
- [ ] Every item in `DECISIONS.md` §4 ("Requires owner approval") has a recorded decision
- [ ] Tech stack recommendations approved or amended
- [ ] Plan structure and pricing direction approved in principle
- [ ] First vertical slice scope confirmed
- [ ] **Explicit written approval to begin Phase 1**

**No code is written in this phase. No dependencies are installed.**

---

## Phase 1 — Foundations

**Goal:** a repository where the hard invariants — tenant isolation, authentication, authorization,
bilingual UI — are proven before any feature exists.

### Scope

1. **Monorepo** — workspace tooling, TypeScript strict config, ESLint with import-boundary rules,
   Prettier, commit hooks, CI pipeline.
2. **Database** — Prisma schema for the identity and tenancy core (`User`, `Workspace`, `Membership`,
   `Role`, `Permission`, `AuditEvent`), migrations, seed for local development.
3. **Tenant isolation** — RLS policies, the tenant-scoped Prisma client, `asPlatform()` escape hatch,
   and the schema-driven isolation test generator.
4. **Authentication** — customer and platform realms, sign-up, email verification, login, password reset,
   sessions, TOTP MFA, invitations.
5. **Authorization** — permission registry, role definitions, route contract middleware, the generated
   route/permission report.
6. **Audit** — `AuditEvent` writer, redaction layer, activity log query API.
7. **Design system** — `packages/ui` with tokens (`#7935FE`, `#FFDD15`), typography for Arabic and Latin,
   RTL/LTR primitives, accessible base components, dark/light readiness.
8. **i18n** — message catalogues, typed keys, locale routing, RTL layout verification in E2E.
9. **App shells** — `apps/web`, `apps/dashboard`, `apps/admin` with routing, layout, and auth wiring only.
10. **Observability** — structured logging with redaction, OpenTelemetry tracing, health endpoints.
11. **Environments** — dev/staging/production separation, IaC skeleton, deployment pipeline.

### Exit criteria

> **Status after Phase 2A:** the tenancy, isolation, boundary, bilingual and
> accessibility criteria are met, and OTLP span export (F-05) is now done.
> Customer authentication remains outstanding — it is Phase 2B work.

- [~] A user can sign up, verify email, log in, and enable MFA — **partially done (2B)**. Customer **log in** is complete: separate realm, no enumeration, atomic lockout, password reset, invitation acceptance. **Self-serve sign-up** and **customer MFA** are not built (F-17, F-18); customers arrive by invitation, which proves control of the address
- [x] A platform user can log in to Admin; a customer session is rejected there — **done (Phase 2A)**; password + mandatory TOTP, and a customer token resolves to no actor because the realms share no session store
- [x] Two workspaces exist and the isolation suite passes for every seeded model — **done** (88 isolation tests, incl. the two-pool model)
- [x] The route/permission report shows zero unprotected routes — **done** (registration throws without a scope)
- [x] Both locales render correctly in RTL and LTR, verified in E2E — **done** (114 Playwright tests across all three interfaces)
- [x] CI runs typecheck, lint, unit, isolation, E2E and a11y checks — all blocking — **done** (7 jobs)
- [ ] Staging deploys automatically from the main branch — **outstanding**; nothing is deployed yet (D-02)

---

## Phase 2 — Platform Admin

**Goal:** the owner can operate the platform's structure without code.

### Scope

1. **Admin shell** — navigation, platform roles, mandatory MFA, step-up auth, environment banner.
2. **Configuration Service** — `ConfigurationVersion`, domain schemas, validation, activation, rollback,
   diff view, impact preview, change history, cache invalidation.
3. **Secret Service** — vault abstraction, AEAD envelope encryption, `secretRef` resolution, masked metadata,
   rotation workflow, lifecycle auditing, KMS-ready interface.
4. **Customers & Workspaces** — directory, workspace detail, create customer/workspace, invitations,
   suspend/reactivate, limits, entitlement resolution trace.
5. **Support Mode** — time-boxed, reason-tagged, read-only sessions with full auditing and customer visibility.
6. **Platform audit log** — filtering, diffs, export.
7. **Integrations shell** — the generic configure → validate → test → save → activate → rotate lifecycle,
   with the **mock provider** as the first concrete integration.
8. **System health** — queue dashboards, dead-letter queue with replay, kill switches.

### Exit criteria

> **Status after Phase 2B.** Phase 2 was split: **2A** delivered the Admin shell, the
> Configuration Service, the Secret Service and observability; **2B** delivered customers,
> workspaces, customer authentication, invitations, workspace RBAC, entitlements,
> credits and Support Mode. Phase 2 is complete.

- [x] Owner creates a workspace and invites a user entirely from Admin — **done (2B)**; create customer + workspace + wallet in one audited transaction, invite, resend, revoke
- [x] A configuration version can be drafted, validated, activated, and rolled back — with history — **done (2A)**; 17 domains, two-stage validation, impact preview, atomic activation, optimistic concurrency, rollback as a new version
- [x] A secret can be stored and rotated; **no interface anywhere reveals its value** — **done (2A)**; envelope encryption, no reveal path exists, asserted against the raw HTTP response
- [x] Support mode grants time-boxed read-only access, appears in the customer's activity log, and expires — **done (2B)**; permission + verified MFA + written reason, a persistent banner with a countdown, expiry enforced on every resolve, and the entry event written against the workspace so the customer sees it
- [x] Every admin action produces an audit event — **done (2A)** for the actions that exist: sign-in, MFA, denials, lockouts, configuration draft/validate/activate/rollback, secret create/rotate/disable/enable/revoke
- [x] Platform Owner and Platform Admin cannot log in without MFA — **done (2A)**; a password-only session resolves to no actor at all

---

## Phase 2C — Design System and Visual Direction

> **Inserted between Phase 2B and Phase 3 (D-49).** A UI foundation only. It changes no database
> ownership, no RLS policy, no permission and no commercial assumption, and pulls no functional
> feature forward from a later phase. **The phase order below is unchanged.**

**Phase 2C-A — the foundation and the visual-approval checkpoint. Delivered.**

- [x] Centralised tokens: colour, typography, spacing, radii, shadows, focus ring, breakpoints,
      motion, z-index and layout — all in `packages/ui`, with a unit test that fails on a hex literal
      anywhere in `apps/*/src`
- [x] One icon family, drawn in the repository (D-51)
- [x] A responsive application shell shared by both consoles: collapsible sidebar with tooltips and a
      persisted preference, an accessible mobile drawer with a focus trap, a wrapping header
- [x] The shared component system: buttons, forms, cards, metric cards, tables with a phone shape,
      tabs, search, pagination, badges, menus, dialogs and confirmations, toasts, skeletons,
      empty/error/permission-denied/no-results states, tooltip, breadcrumbs, switchers
- [x] `SocialPostPreview` — five platforms, four aspect ratios, media and post states, bilingual
      captions. A visual contract with no persistence, no OAuth and no platform API
- [x] The AI Copilot visual shell — panel and sheet, streaming/error/insufficient-credit/approval
      states, an inert composer that says so, and a mutating action that cannot run without an
      explicit approval
- [x] Applied to the representative screens: customer sign-in, workspace home and team; console
      overview, workspaces directory and workspace detail; the Support Mode banner
- [x] An isolated design showcase, refused in production and linked from no navigation (D-53)

**Phase 2C-B — apply the approved direction to the remaining screens.** Not started. Scope is listed
in `docs/DESIGN-SYSTEM.md` §11: migrate the pages still using the compatibility aliases, delete both
alias blocks, extend the mobile record-list shape to the console tables, and decide toast placement.

---

## Phase 3 — Plans, Entitlements and Credits

> **Status: DELIVERED, 2026-09-07.** Authorised by the owner after the decision gate
> merged. Phase 2B had pulled the entitlement and credit MACHINERY forward (D-40); this
> phase added what was missing rather than rebuilding it — the plan editor, the feature
> registry, the flag targeting surface, reserve/confirm/settle with FIFO buckets and
> expiry, cycle resets, quota enforcement, and the customer's own view of all of it.
>
> **D-06 … D-12 are ANSWERED** (2026-09-07). Four plans — Starter, Growth, Scale,
> Enterprise — with approved provisional prices, limits, trial terms and credit policy.
> The values live in `docs/PRODUCT.md` §10A and are **configuration, never source**:
> no plan name, price, limit or allowance has been entered into any environment by
> this phase, and none appears in application source.
>
> **Still provisional.** The prices and quotas need a second review before production
> launch (D-07), and the credit economics must not be activated as final until Phase 4
> measures real provider costs against the required gross margin (D-15). Nothing in
> this phase treats either as settled.

**Goal:** commercial rules are data, and credit accounting is provably correct — before any AI exists.

### Scope

1. **Plan management** — plan editor, per-currency pricing, trial settings, quotas, feature grants, add-ons,
   overage policy, upgrade/downgrade behavior, plan lifecycle and impact preview.
2. **Feature registry** — features, value types, dependencies, defaults.
3. **Feature flags** — all eight targeting dimensions, precedence engine, stable percentage rollout,
   kill switches, rollback.
4. **Entitlements engine** — `entitlements.can()` / `.limit()`, resolution trace, caching, and the
   dashboard's upgrade-prompt error path.
5. **Credit wallet and ledger** — wallet, immutable transactions, reserve/confirm/settle primitives,
   grants, expiry with FIFO consumption, cycle resets, low-balance thresholds, admin adjustments,
   reconciliation job.
6. **Usage limits** — quota enforcement middleware and per-plan rate limits.

### Exit criteria

- [x] Owner creates a plan with prices, limits, features, and credits — with no code change — **done**; a structured editor over a versioned draft, with a price field per supported currency and the six quota dimensions. Semantic validation refuses an incomplete currency table, an Agency plan (D-62), postpaid overage under a hard stop (D-11) and a downgrade that deletes a resource (D-12)
- [x] Assigning a plan to a workspace changes what that workspace can do, immediately — **done (2B)**, and now covered by an integration test that changes the plan and re-resolves
- [x] The entitlement trace explains every effective value — **done (2B)**; the same call decides and explains
- [x] A feature flag can target by plan, workspace, beta group, country, date range, and percentage — and roll back — **done**; the engine shipped in 2B, and this phase added the editor, the printed precedence order, real beta-cohort membership where the engine previously read a hard-coded empty set, and a one-press kill switch that validates and activates in the same action
- [x] Credit reserve/settle/release primitives pass the full concurrency and idempotency suite — **done**; ten parallel reservations against a wallet sized for three grant exactly three, one idempotency key raced ten times produces one hold, a failed request writes zero charges, and settlement can never exceed what was reserved
- [x] Ledger replay reproduces balances exactly; the reconciliation job reports zero drift — **done**; asserted after a full grant/reserve/settle/release/expire cycle, and surfaced on the workspace page rather than only in a job's log

### Delivered beyond the original scope

- **Subscriptions.** Not billing — no provider, no invoice, no payment. The record that
  pins the agreed price at assignment (AC-04.7 cannot hold without it), remembers that a
  workspace has had its one trial (AC-04.11), and carries the cycle boundary the monthly
  grant and rollover sweep run on.
- **Credit buckets with FIFO-by-expiry.** D-12's consumption order needs per-bucket state;
  a wallet balance alone cannot express "spend the credits that lapse soonest".
- **Quota enforcement.** The check and the increment are one statement, so two requests at
  the limit cannot both pass.

### Not in this phase, deliberately

No AI provider call, no task pricing, no model routing, no Brand Brain backend, no
content or social persistence, no media storage, no analytics ingestion, no payment
collection, checkout, webhook or invoice. The credit primitives PREPARE Phase 4 and do
not simulate it: `purpose` is an opaque task key and nothing here knows what a model
costs.

---

## Pre-Phase-4 hardening — F-53

**Not a phase.** One defect and the test-data problem behind it, closed before Phase 4 opens so that the
Control Center page Phase 4 builds on is sound and a long-lived database stops drifting.

- `SecretService.listSecrets` returns one PAGE, with the contract in `docs/ADMIN-CONTROL-CENTER.md` §7.1.
- Every suite that writes secrets owns and removes exactly its own rows — `docs/ARCHITECTURE.md` §3.9.

Phase 3's scope and completion are unchanged by this, and **no Phase 4 work is started here**: no
providers, models, routing, AI requests, Brand Brain, content models, social integrations, billing or
payment functionality, and no commercial plan price or credit value entered or activated in any
environment.

---

## Post-Phase-3 audit remediation

**Not a phase.** Eleven findings from an independent audit of Phase 3, closed
before Phase 4 opens. Recorded as A-1…A-12 in `docs/DECISIONS.md` with the root
cause, the fix and the test evidence for each.

The pattern worth carrying forward: **most of them were things that looked
done.** `enabledForPlans` was declared, schema'd, surfaced in the Control
Centre and read by nothing. `assignPlan` wrote a plan key and no subscription.
Support mode carried a comment asserting one live session per operator that
nothing enforced. The end-to-end suite pre-created the invitee's account,
which is exactly what hid the fact that a new invitee had no way in. In each
case the artefact — a field, a comment, a passing test — was evidence that the
work had been done, and was not.

Three classes recurred:

- **Read-then-write under concurrency.** The last-owner count, settle/release
  status checks, support-mode session creation. Every one passed sequentially;
  every one failed the moment two requests arrived together, which is the
  normal outcome of two clicks.
- **Multi-statement operations that were called atomic.** Password reset, the
  cycle boundary, plan assignment, audit events. A crash between statements
  left states nobody had designed.
- **Configuration that resolved to nothing.** Plan targeting, enum
  entitlements, dependency re-evaluation.

Phase 3's scope and completion are unchanged. **No Phase 4 work was started**:
no providers, models, routing, AI requests, Brand Brain, content models, social
integrations, billing or payment functionality, and no commercial plan price or
credit value entered or activated in any environment.

---

## Phase 4 — AI Gateway

**Goal:** provider-agnostic AI with correct economics, proven end-to-end with a mock provider.

### Scope

1. **Gateway core** — request pipeline, authorization, idempotency, status model, timeout sweeper.
2. **Adapter interface** and the **mock adapter** (deterministic, latency- and cost-simulated).
3. **First real adapters** — text and image, behind configuration. **[D-13 approved 2026-09-13:
   provider ARCHITECTURE approved — one primary plus one fallback per modality — with exact
   vendors pending benchmark, privacy verification and owner approval. No real adapter is built
   in Phase 4.]**
4. **Model registry** — modalities, capabilities, unit costs, quality tiers, disable switch.
5. **Routing** — task catalogue, rules with primary + ordered fallbacks, scope resolution, parameters,
   timeouts, max cost per request, live test bench.
6. **Economics** — cost estimation, credit calculation, reserve → settle, zero charge on failure,
   no duplicate charge on retry, `AIUsageLedger`.
7. **Reliability** — retries, circuit breakers, health checks, rate limiting, per-workspace budgets.
8. **Safety** — input/output moderation, structured-output validation, prompt-injection containment.
9. **Admin AI screens** — providers, credentials, models, routing, credit costs, budgets, usage explorer,
   request inspector, cost alerts.

### Exit criteria

- [x] Owner adds a provider, tests the connection, activates it, and routes a task — all from Admin
- [x] Disabling a model takes effect immediately for all traffic
- [x] A successful request charges exactly the right credits and writes one ledger row
- [x] A failed request charges **nothing**; a retried request charges **once**
- [x] Fallback works for eligible error classes and does not fire for ineligible ones
- [x] Per-workspace budgets block before a provider call is made
- [x] Admin shows real provider cost and credits charged; margin is shown as **unknown** until the owner
      prices a credit (D-15), rather than reported as a number the platform cannot actually compute
- [x] The customer-facing product never exposes the platform API key in any response or bundle

### Delivered, and what was deliberately not

The gateway, the mock adapter, routing, economics, reliability, budgets, input moderation and the Admin
usage explorer and request inspector are built and tested. Three items in the scope list above are
**deliberately not built in Phase 4**, each for a stated reason rather than as an omission:

| Not built                                                   | Why                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First real adapters**                                     | D-13 approved the architecture and deferred vendor selection pending benchmarking, pricing comparison, privacy review, no-training and zero-retention confirmation, and owner sign-off on the routing table. Those gates are now enforced at provider activation. The adapter contract and mock make adding one a single `classifyError` away |
| **Circuit breakers, health probes, provider rate limiting** | Operational refinements over real providers. Tuning a breaker against a mock that fails exactly when told would encode a fiction                                                                                                                                                                                                              |
| **Output moderation, BYOK**                                 | Output moderation belongs with the workflows that persist generated content (Phase 5). BYOK needs workspace-scoped secret storage; a BYOK path that fell back to the platform key would bill us                                                                                                                                               |

Production **routing configuration** remains gated on D-17 (the Arabic model quality evaluation) and D-13
(vendor selection). Neither blocks the gateway code, which is provider-agnostic by construction. Both gates
are now enforced in configuration validation rather than left to process: a model cannot reach `available`
without a recorded benchmark, and a provider cannot be activated without its privacy, no-training and
retention confirmations.

**D-16 (approved 2026-09-13)** fixed the MVP modalities at **text and image**. **Video generation is
excluded from the MVP and is a Phase 7+ candidate requiring a separate cost, latency and product review.**
`resolveRoute` refuses an out-of-scope task, so the exclusion holds even if a routing rule for one were
activated.

---

## Phase 5 — Customer Brand and Content Journey

**Goal:** the customer-facing value loop, completing the **first MVP vertical slice**.

### Scope

1. **Brand Center** — create/edit brands, brand kit, logos, palette, typography, voice.
2. **Brand Brain** — structured sections (bilingual), document upload, chunking, embeddings via
   `brand.retrieve`, retrieval with citations, staleness handling.
   **Built against the principle and the four-memory architecture in `docs/PRODUCT.md` §6A** (D-63, D-64):
   Canonical Brand Knowledge · Strategy Memory · Content Memory · Performance/Learning Memory, with
   provenance, evidence, confidence, approval state, versioning, reproducibility, and human precedence
   over inferred learnings (D-65). Brand Brain is in **every paid plan** — it is the intelligence layer,
   not a premium add-on.
3. **AI Content Studio** — caption/idea generation, per-platform variants, rewrite/shorten/expand/tone,
   ar↔en translation with glossary preservation, credit cost shown before generation.
4. **Asset Library** — upload with pre-signed URLs, virus scanning, derivatives, folders, tags, versions.
5. **Social Calendar** — month/week/day/list views, drag to reschedule, timezone correctness,
   **mock publishing targets only**.
6. **Approvals** — request, assign, approve/reject, comments, policy per brand.
7. **Command Center** — the daily home aggregating the above.
8. **Activity Log** and **Notifications** (in-app + email) for the customer.

### Exit criteria — the vertical slice is demonstrable end to end

- [ ] Every acceptance criterion in `docs/MVP-ACCEPTANCE-CRITERIA.md` passes
- [ ] The full 16-step journey (owner configures a mock provider → customer places an AI draft on the calendar)
      runs as an automated E2E test in both Arabic and English
- [ ] Isolation tests cover every new tenant-owned model
- [ ] Credit accounting is correct for every content generation path

**Milestone: the MVP vertical slice is complete and reviewable by the product owner.**

### Delivered in Phase 5A — Brand Brain

Scope items 1 and 2 (Brand Center foundations and the Brand Brain) are built. The rest of Phase 5 —
AI Content Studio, Asset Library, Social Calendar, Approvals, Command Center, Activity Log and
customer Notifications — remains outstanding, so the phase is **not complete** and the milestone
above is not claimed.

| Delivered                        | What it is                                                                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brand and Brand Brain schema** | Nine tenant-owned tables behind two independent boundaries: RLS on `workspaceId`, and a composite foreign key `(workspaceId, brandId)` that makes the BRAND boundary a database fact rather than a service convention |
| **Knowledge governance**         | D-65 in full — provenance, evidence, confidence, approval state, append-only versioning, rollback as a forward version, conflict surfacing, and human precedence enforced at the write                                |
| **Source ingestion**             | Upload → extract → chunk → propose, with two distinct idempotency keys, duplicate protection by content checksum, retries, a stuck-job sweep, and customer-safe failure messages                                      |
| **Retrieval and context**        | Deterministic local index, four-memory precedence ordering, a bounded context spent in precedence order, and prompt-injection containment applied to knowledge as well as to chunks                                   |
| **Brand Brain chat**             | Grounded answers with citations built from what was retrieved, an honest refusal that costs no credits, and D-78 retention with a customer-facing notice                                                              |
| **Customer UI**                  | The approved demo as a real screen: interactive orb, ten area cards, a modal detail drawer, knowledge review, sources, and the chat panel — RTL and LTR, keyboard operable, WCAG 2.2 AA                               |

**Deliberately not built, each for a stated reason:**

| Not built                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A real embedding provider**        | D-13 approved the provider architecture and deferred vendor selection pending privacy, no-training and retention review. The index is local and deterministic, and replaceable behind its interface                                                                                                                                                                                                                         |
| **OCR**                              | The only way to get text out of an image, and no option clears this feature's bar: the maintained engine fetches its language model over the network at run time, its output is not reproducible across versions — which D-65 requires — and its Arabic accuracy is far below its Latin. Images are refused at upload rather than accepted and mistranscribed (D-93). Revisit if an option appears without those properties |
| **Write-back of inferred learnings** | D-64's return path needs analytics, which is Phase 7. The schema carries it — memory layer, origin, confidence, evidence — so it is not a retrofit                                                                                                                                                                                                                                                                          |

**Two rows previously stood here and were removed, because the Phase 5A corrective pass built both.**
They are named rather than silently deleted, so a reader who remembers them can see what changed:

| Previously "not built"                    | What is actually merged                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PDF, DOCX and PPTX extractors**         | Built (F-70, D-94). PDF is read with Mozilla's pdf.js (Apache-2.0), configured so it cannot compile and cannot fetch; Word and PowerPoint are read with a bounded ZIP reader (`fflate`, MIT) and an element scan rather than a document-conversion library. Page, character, archive, ratio and wall-clock ceilings all come from activated configuration, and the declared media type never chooses the parser — the file's own signature does                   |
| **A background job runner for ingestion** | Built (F-69, D-95, D-96). Queue definitions live in `packages/jobs`, the dashboard writes the durable row and dispatches to `media-processing`, and `apps/worker` consumes and parses. Production cannot process inline at all; outside production a missing `REDIS_URL` still falls back so a developer needs no Redis container. A reconciliation sweep in `apps/api` re-dispatches unclaimed work, so a lost message costs punctuality rather than correctness |

---

### Delivered in Phase 5B-1 — Asset Library

Scope item 4 is built. **Scope items 5, 6, 7 and 8 remain outstanding**, so Phase 5 is still not
complete and the milestone above is still not claimed. (Scope item 3 was delivered afterwards — see
Phase 5B-2 below.)

| Delivered                   | What it is                                                                                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Asset Library schema**    | Six tenant-owned tables (`docs/DATABASE.md` §4.2b) behind two independent boundaries, with **every intra-library foreign key composite with `workspaceId`** — closing the cross-tenant existence oracle a plain key leaves open (D-99)                                                         |
| **Upload lifecycle**        | Entitlement, permission, brand scope and configured limits resolved **before bytes**; a provider-agnostic upload session; idempotent completion keyed per logical action; the kind decided from the bytes, never from the browser's claim                                                      |
| **Quarantine and scanning** | An asset is unreachable until a scan returns CLEAN. `isSelectable()` requires READY **and** CLEAN **and** not deleted, and a row that is READY but not CLEAN is refused — proven by a test that writes exactly that row                                                                        |
| **Queue-backed processing** | `media-processing` runs in the real worker through `packages/jobs`, with safe retries, duplicate-delivery tolerance, and the same reconciliation sweep that already recovers stuck ingestion jobs                                                                                              |
| **Folders, tags, versions** | Bounded nesting from activated configuration, append-only version history in three separated layers (D-102), archive and restore, and content-checksum duplicate protection over live rows                                                                                                     |
| **Serving**                 | Opaque HMAC-signed, time-limited download grants (D-103). No storage key, provider object key or filesystem path ever reaches the browser, and every wrong grant returns an identical `404`                                                                                                    |
| **Customer UI**             | `/[locale]/assets` — browse, folders, tags, search, filter, sort, upload with progress, per-state presentation for processing, failed, quarantined and ready, preview, detail, versions, archive and restore, and selection for a future consuming module. AR and EN, RTL and LTR, WCAG 2.2 AA |
| **Configuration, not code** | File size, allowed types, folder depth, version count and derivative ceilings all come from the activated `assets` configuration domain; the storage quota comes from `limit.storage_gb` through the entitlements engine                                                                       |

**Deliberately not built, each for a stated reason:**

| Not built                        | Why                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A production storage adapter** | No vendor is approved (D-110, F-77). The `ObjectStore` boundary is provider-agnostic and the filesystem implementation behind it is real and cross-process, which is enough for development, test and CI. **Production fails closed** rather than accepting a file it cannot keep (D-105) |
| **A production virus scanner**   | No engine is selected (D-111, F-78). The gate, the quarantine state, the failure path and the audit trail are all real; what decides CLEAN is a deterministic mock. **Production fails closed** (D-106)                                                                                   |
| **Derivative bytes**             | No image encoder has been reviewed, and every candidate decodes untrusted bytes in native code (D-107, F-79). The `asset_derivative` model, its RLS, its bounds and its lifecycle are complete, so adding one later is a worker and configuration change, not a migration                 |
| **SVG support**                  | SVG is an executable document. Accepting it means an unreviewed sanitiser or active content on the app origin, so it is refused outright rather than half-supported (D-108, F-81)                                                                                                         |
| **OCR**                          | Unchanged from Phase 5A, and deliberately not revisited here. Images are valid Asset Library media; extracting text from them is a separate decision                                                                                                                                      |

**The route is a design-system EXTENSION, not a demo port.** The approved demo routes `media` to a
placeholder, so under D-98 the screen was built from the platform's own tokens, components and
interaction patterns, and is recorded in `docs/UI-FIDELITY-CONTRACT.md` §6.3. The owner may refine it
in the F-76 parity pass.

---

### Delivered in Phase 5B-2 — AI Content Studio + Content Calendar

Scope item 3 is built, and with it the PLANNING half of scope item 5 — the calendar. **Publishing
(the rest of item 5), approvals (item 6), the Command Center (item 7) and the activity log and
notifications (item 8) remain outstanding**, so Phase 5 is still not complete and the exit criteria
above are still not claimed.

The approved Phase 5B breakdown is: **5B-1** Asset Library ✅ · **5B-2** Content Studio + Content
Calendar ✅ · **5B-3** Approvals + Command Center + Activity Log + Notifications · then the final UI
polish and audit.

**The AI Content Studio:**

| Delivered                          | What it is                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Content schema**                 | `content_item` and `content_variant` (`docs/DATABASE.md` §4.4b), RLS enabled and forced, and **every foreign key to a tenant-owned parent composite with `workspaceId`** — the first keys written under D-112 after F-80 and F-83                                               |
| **Grounded generation**            | One brief becomes a per-channel variant set, grounded through Brand Brain's OWN retriever — the same four-memory precedence and the same fenced untrusted-context channel the chat uses, so the two cannot disagree about the same brand                                        |
| **Citations from retrieval**       | `citations` is written from what the retriever returned, never from the model's text, so a fabricated source is impossible rather than merely unlikely (AC-11.4)                                                                                                                |
| **The cost, before it is spent**   | `quote()` runs the gateway's own route resolution and returns the number `generate()` reserves — a READ that moves no credit and writes no `ai_request` (AC-11.1)                                                                                                               |
| **A free refusal**                 | When retrieval finds nothing to ground on, no gateway call is made and no credit moves. The draft is still created, empty and marked, so the refusal is visible in the library rather than only in a toast                                                                      |
| **Editing tools**                  | rewrite · shorten · expand · tone · ar↔en translation — a CLOSED set rather than a free-text instruction, because a free-text instruction from a browser is a prompt the customer writes and the platform pays for. Translation preserves the glossary, brand voice and dialect |
| **Per-platform validation**        | Character count by GRAPHEME (`Intl.Segmenter`, so an emoji or an Arabic cluster counts as one), hashtag ceilings and first-comment support, all from the activated `content` configuration                                                                                      |
| **Output parsed before persisted** | A malformed provider response is a retryable failure and never becomes a row; a variant for a platform nobody asked for is dropped and the fan-out is bounded by the configured ceiling (AC-11.9)                                                                               |
| **Dialect (D-115)**                | Resolved brand → workspace → the activated default, which ships as MSA, and RECORDED on the row — because the default can change and a draft must still be able to say what it was written in. No dialect is hard-coded                                                         |
| **Retention (D-116, D-117)**       | Subscription-linked expiry with a 30-day cancellation grace, a workspace control in Settings enforced in the SERVICE and by a database CHECK, and a registry that fails the build when a feature persists AI output without declaring a retention owner                         |
| **Customer UI**                    | `/[locale]/content` and `/[locale]/content/compose` — a **mechanical port** of the approved demo's `postsPage()` and `composer()`, AR and EN, RTL and LTR, WCAG 2.2 AA, with a declaration-by-declaration transcription test against the pinned snapshot                        |
| **Configuration, not code**        | Dialects, channels, character limits, hashtag ceilings, the fan-out ceiling, the brief length and both retention windows all come from the activated `content` domain. Nothing on the screen or in the service is a literal                                                     |

**The Content Calendar** (docs/PRODUCT.md §5 module 6, AC-14.1 – AC-14.9):

| Delivered                           | What it is                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`calendar_slot`**                 | One tenant-owned table (`docs/DATABASE.md` §4.7b), RLS enabled and forced, and **both foreign keys to a tenant-owned parent composite** — `calendar_slot_item_fkey` is the third key written under D-112 and exactly F-80 and F-83's shape                                                             |
| **The item stays the truth**        | The slot records WHEN; `content_item` records what it is and what state it is in. Scheduling moves the item to `SCHEDULED` and cancelling moves it back, in the same transaction — and the library REFUSES to transition a scheduled item, so it cannot be archived out from under a plan              |
| **Intent, not just an instant**     | `scheduledLocalTime` + `timezone` beside `scheduledAtUtc` (AC-14.2, AC-14.3). A skipped wall-clock resolves FORWARD to the jump target; an ambiguous one resolves to the earlier occurrence and says so. A single timestamp cannot express "09:00, whenever that is"                                   |
| **A month is the customer's month** | The range is computed in the workspace's zone and queried in UTC, so the first hours of a local month are not stranded on the previous page                                                                                                                                                            |
| **Plan, move, take off**            | Schedule, reschedule and cancel, each audited with times and a channel count and never a caption (AC-14.8, AC-14.9)                                                                                                                                                                                    |
| **Quota, taken and returned**       | `limit.scheduled_posts` resolved through the entitlements engine and consumed before the row exists; cancelling refunds it (AC-14.5). The key is per SLOT — keying it per item leaked a slot's worth of quota, which the tests caught                                                                  |
| **The approval gate**               | AC-14.6, built and tested, and shipped OFF because nothing can grant approval until 5B-3. The owner turns it on when there is a workflow behind it                                                                                                                                                     |
| **Customer UI**                     | `/[locale]/calendar` — month, week and agenda views, live period navigation, a scheduling dialog, and move/remove from the slot itself. Composed from `packages/ui`'s existing `ContentCalendar`, which becomes an AGENDA below `md` rather than seven unreadable columns. AR/EN, RTL/LTR, WCAG 2.2 AA |
| **Configuration, not code**         | Week start, planning horizon, minimum notice, per-day ceiling and the approval gate all come from the activated `content.calendar` domain                                                                                                                                                              |

**Deliberately not built, each for a stated reason:**

| Not built                                   | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The composer's Copilot column**           | The AI Copilot is Phase 7. Shipping `copilotPanel()`'s markup with nothing behind it would be a screen that lies about what the product does (`docs/UI-FIDELITY-CONTRACT.md` §4.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Campaigns, scheduling, approvals**        | Scope items 5 and 6. `content_item` therefore has no `campaignId`, `approvalRequired` or `currentApprovalId`: a column with no writer is a column whose meaning nobody has settled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **`SCHEDULED` and `PUBLISHED` transitions** | The enum declares them because the lifecycle is designed; `transition()` refuses every target beyond `DRAFT`, `IN_REVIEW` and `ARCHIVED`, rather than half-implementing a later phase's states                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Attaching media**                         | `content_variant.assetIds` exists and is service-validated, but a picker belongs with the publishing pipeline. The demo's `.media-strip` is not ported at all rather than ported and left dead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **A real provider**                         | D-13 approved the provider architecture and deferred vendor selection. The mock adapter is the only one registered; routing, reservation, settlement, budgets, idempotency and the ledger row are all real. It SELECTS retrieved material rather than generating and is deliberately not steerable from a prompt, so it does not produce the JSON envelope the studio's schema requires: **in a browser the grounded path reaches AC-11.9's refusal**, and the parsed-draft branch is proven in `tests/isolation/content-studio-lifecycle.test.ts` through a scripted adapter. Both outcomes are asserted in `tests/e2e/content-studio.spec.ts`; relaxing the parser so prose became a draft is exactly what AC-11.9 forbids |
| **Image generation**                        | AI Creative Studio is `docs/PRODUCT.md` §5 module 8 and a separate scope item. Nothing here generates or stores an image                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Real publishing**                         | AC-14.7 asks for a MOCK target and forbids a real platform call anywhere in the slice. Every slot's `targetKind` is `MOCK`, and a test asserts the calendar module imports no connector and no transport. Connectors, OAuth and the publish pipeline are Phase 6                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **`CalendarSlot`'s publishing columns**     | `socialConnectionIds`, `publishJobIds`, `recurrenceRule`, `lockedAt` and `lockedBy` from §4.7's design, and the `LOCKED`/`PUBLISHING`/`PUBLISHED`/`FAILED` states. Every one belongs to the pipeline; a state nothing can reach is a state whose meaning nobody has settled                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Drag to reschedule**                      | `docs/PRODUCT.md` §5 module 6 lists it. Moving a slot IS implemented and is keyboard-operable through the slot dialog; native drag-and-drop is an interaction with no accessible equivalent this module has built yet, and shipping the mouse half alone would make the feature unusable for exactly the people WCAG 2.2 AA is about. Recorded for the final UI polish pass                                                                                                                                                                                                                                                                                                                                                  |

---

## Phase 6 — Social Connections and Publishing

**Goal:** real external publishing, reliably.

### Scope

1. **Connector framework** — adapter interface, provider registry, capability declarations.
2. **Platform app configuration** — per provider per environment, in Admin.
3. **OAuth flows** — authorization, callback, PKCE, state, target selection, scope verification.
4. **Token management** — encrypted storage, proactive and reactive refresh, rotation, revocation,
   `needs_reauth` recovery.
5. **Platform adapters** — Facebook, Instagram, LinkedIn first; then TikTok, YouTube, X.
   **[Owner decision D-18: launch platform priority]**
6. **Publishing pipeline** — pre-flight checks, publish jobs, idempotency, uncertain-outcome verification,
   retry classification, dead-letter queue, per-target statuses, confirmation policies.
7. **Content validation** — per-platform rules, enforced at schedule time and again at publish time.
8. **Webhooks** — signature verification, idempotent processing, revocation and status events.
9. **Social Media Hub UI** — connections, health, scopes, publish results.

### Exit criteria

- [ ] A customer connects an account by OAuth; **no password is ever requested**
- [ ] Scheduled content publishes at the correct time in the workspace timezone
- [ ] Unapproved content cannot publish, even via a directly enqueued job
- [ ] A timed-out send is verified rather than blindly retried — no duplicate posts in any test
- [ ] Expired tokens auto-refresh; failed refresh pauses jobs and prompts reconnection
- [ ] Failed jobs reach the dead-letter queue and are replayable from Admin
- [ ] Every publish, delete, and disconnect requires confirmation and writes an audit event
- [ ] At least three platforms verified against real sandbox/production apps

**Prerequisite the owner must start early:** platform app review and business verification for each network.

---

## Phase 7 — Analytics and Copilot

**Goal:** the loop closes — performance data becomes insight becomes better strategy.

> **Video generation lands here at the earliest — D-16, approved 2026-09-13.** It was excluded from the MVP
> and recorded as a Phase 7+ candidate requiring a **separate cost, latency and product review** before any
> work starts. `video.generate` stays in the task catalogue marked outside MVP scope, and the routing
> resolver refuses it, so nothing can serve it until that review approves it.

### Scope

1. **Analytics ingestion** — scheduled pulls, backoff windows, idempotent upserts, backfill, freshness
   indicators, retention pruning, rate-limit sharing with publishing.
2. **Smart Analytics** — dashboards per brand, campaign, platform, and post; comparisons and trends;
   RTL-correct charts; export.
3. **AI insights** — `analytics.explain` grounded in real metrics (never invented numbers), recommendations,
   anomaly detection.
4. **AI Strategy** — strategy generation, content pillars, monthly plans, channel mix, grounded in Brand Brain.
5. **Marketing Intelligence** — content gap analysis, trend suggestions, competitive context.
6. **AI Copilot** — tool layer with per-call authorization, action classes, previews, confirmations,
   action-plan recording, tool-result recording, undo.
7. **Automations** — trigger → condition → action rules, run history, policy limits on external actions.

### Exit criteria

- [ ] Metrics ingest idempotently and are visible per post, account, campaign, and brand
- [ ] Analytics explanations cite the actual metric values they reference
- [ ] The Copilot can create a campaign, draft content, and place it on the calendar — with a preview and
      an undo path
- [ ] The Copilot **cannot** publish, delete, disconnect, pay, or send external communications without
      explicit human confirmation, and its tool calls are authorized against the user's real permissions
- [ ] Automations never perform an unauthorized external action
- [ ] Copilot isolation tests confirm it can never reach another workspace's data

---

## Phase 8 — Billing and Launch

**Goal:** take real money and open the doors.

### Scope

1. **Payment provider adapter** — hosted checkout and portal, subscriptions, one-time charges, refunds.
   **[Owner decision D-21: provider(s) and markets]**
2. **Subscription lifecycle** — trials, upgrades with proration, downgrades with impact checks,
   cancellation, dunning, grace periods, suspension.
3. **Invoices** — generation, numbering, tax handling, bilingual PDFs, credit notes.
4. **Billing webhooks** — verified, idempotent, ordered, reconciled.
5. **Customer billing portal** and **platform billing reports**.
6. **Credit purchase** — packs, add-ons, overage.
7. **Public website** — all 15 pages, CMS-driven, bilingual, SEO complete, config-driven pricing page,
   status page.
8. **Launch readiness** — performance budgets met, penetration test completed and findings resolved,
   restore drill passed, load test passed, legal documents published, support processes documented,
   monitoring and alerting verified, incident runbooks written.

### Exit criteria

- [ ] A customer subscribes, is charged, receives an invoice, and gets the right entitlements
- [ ] Payment failure moves through dunning to suspension and recovers correctly
- [ ] Upgrade and downgrade behave exactly as specified, including credit handling
- [ ] Webhook replays change nothing; spoofed webhooks are rejected
- [ ] Public site scores ≥ 95 Lighthouse on performance, accessibility, best practices, and SEO in both locales
- [ ] Penetration test findings of high severity are resolved
- [ ] A production restore drill has been completed and timed
- [ ] Status page, legal pages, and support workflows are live

**Launch.**

---

## Future Expansion (post-launch, unordered)

| Area              | Items                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI**            | Voice generation, video editing, brand-tuned models, multi-agent workflows, AI-generated ad variants, image editing/inpainting                                       |
| **Social**        | Threads, Pinterest, Snapchat, Telegram, WhatsApp Business, Google Business Profile; unified social inbox; comment moderation with AI; social listening and sentiment |
| **Collaboration** | Real-time co-editing, richer approval chains, client review portals, white-label agency portals                                                                      |
| **Analytics**     | Competitor benchmarking, attribution, custom dashboards, scheduled report delivery, data warehouse export                                                            |
| **Enterprise**    | SSO (SAML/OIDC), SCIM provisioning, custom roles, data residency options, dedicated instances, contractual SLAs, audit export API                                    |
| **Commerce**      | Marketplace of templates and strategies, partner/reseller program, affiliate program, usage-based enterprise pricing                                                 |
| **Platform**      | Public API + SDKs, outbound webhooks, Zapier/Make connectors, CRM integrations (HubSpot, Salesforce), mobile apps, browser extension                                 |
| **Content**       | Advanced creative editor, brand-compliance auto-checking, UGC management, content repurposing pipelines, localization beyond ar/en                                   |
| **Operations**    | Multi-region deployment, service extraction (AI, publishing, analytics workers), advanced cost optimization, self-hosted model options                               |

---

## Cross-Phase Continuous Work

Present in **every** phase, not deferred:

| Track                   | Commitment                                                    |
| ----------------------- | ------------------------------------------------------------- |
| Tenant isolation tests  | Every new tenant-owned model, same pull request — CI-enforced |
| Bilingual support       | Every user-facing string in `ar` and `en`, RTL verified       |
| Accessibility           | WCAG 2.2 AA checks in CI on every new screen                  |
| Audit events            | Every state change                                            |
| Configuration over code | No hard-coded plans, prices, limits, models, or providers     |
| Documentation           | `docs/` updated in the same change as the behavior            |
| Security                | Dependency, secret, and static scanning on every CI run       |
| Performance             | Budgets enforced per route                                    |
| Observability           | Traces and metrics for every new subsystem                    |
