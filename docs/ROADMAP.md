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
3. **First real adapters** — text and image, behind configuration. **[Owner decision D-13: which providers]**
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

- [ ] Owner adds a provider, tests the connection, activates it, and routes a task — all from Admin
- [ ] Disabling a model takes effect immediately for all traffic
- [ ] A successful request charges exactly the right credits and writes one ledger row
- [ ] A failed request charges **nothing**; a retried request charges **once**
- [ ] Fallback works for eligible error classes and does not fire for ineligible ones
- [ ] Per-workspace budgets block before a provider call is made
- [ ] Admin shows real provider cost, credits charged, and estimated margin
- [ ] The customer-facing product never exposes the platform API key in any response or bundle

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
