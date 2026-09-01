# CLAUDE.md — Permanent Project Rules for BrandSpace

> **الملخص التنفيذي بالعربية**
>
> هذا الملف هو **الدستور الدائم** لمشروع BrandSpace. كل جلسة عمل جديدة مع Claude Code يجب أن تبدأ بقراءته والالتزام به.
> يحدد الملف: هوية المنتج، القواعد التي لا يجوز كسرها (عزل بيانات العملاء، منع كتابة أي إعدادات داخل الكود، منع تسريب المفاتيح السرية)،
> بنية المستودع، معايير الكود والاختبارات، وسير العمل المعتمد للتسليم.
> **القاعدة الأهم:** لا يبدأ أي تنفيذ برمجي قبل اعتماد وثائق المعمارية من مالك المنتج، ولا يُدمج أي عمل في الفرع `main` مباشرة.
> **القاعدة الثانية:** كل سجل بيانات يخص عميلًا يجب أن يكون مرتبطًا بـ `workspaceId`، ولا يجوز لأي مستخدم في مساحة عمل أن يرى بيانات مساحة عمل أخرى بأي شكل.
> **القاعدة الثالثة:** أسماء مزودي الذكاء الاصطناعي، النماذج، الخطط، الأسعار، الحدود، ورصيد الذكاء الاصطناعي — كلها **إعدادات** تُدار من لوحة تحكم المالك، وليست كودًا.

---

## 1. What BrandSpace Is

BrandSpace is a **bilingual (Arabic RTL / English LTR), multi-tenant SaaS platform** that acts as an
AI-powered brand and social media operating system for entrepreneurs, startups, SMBs, marketing teams,
creators, agencies, and enterprise teams.

It has **three architecturally separated interfaces**:

| Interface                           | Audience                               | App              | Auth realm                                 |
| ----------------------------------- | -------------------------------------- | ---------------- | ------------------------------------------ |
| **Public Website**                  | Anonymous visitors, prospects          | `apps/web`       | none (public)                              |
| **Customer Dashboard**              | Paying customers and their teams       | `apps/dashboard` | customer session, workspace-scoped         |
| **Platform Admin / Control Center** | BrandSpace owner + internal staff only | `apps/admin`     | separate platform session, platform-scoped |

**The Platform Admin is never a "role inside the customer dashboard."** It is a separate application,
a separate session realm, a separate permission model, and a separate route namespace.

---

## 2. Non-Negotiable Rules

These rules are permanent. If a task appears to require breaking one of them, **stop and ask the product
owner** instead of proceeding.

### 2.1 Tenant isolation

- Every tenant-owned table **must** carry `workspaceId` (or be reachable only through a parent row that does).
- Every query that reads or writes tenant data **must** be constrained by the caller's resolved workspace.
- Isolation is enforced in **two independent layers**: (a) the application data-access layer, (b) PostgreSQL
  Row-Level Security. Neither layer alone is considered sufficient.
- A user in Workspace A must never **read, modify, search, export, count, enumerate, or infer** data from Workspace B.
  Even a "not found" vs "forbidden" difference in an error message is a leak: unauthorized cross-tenant access
  returns `404` shaped identically to a genuine miss.
- Any new tenant-owned model requires a corresponding isolation test in the same pull request. **No exceptions.**

### 2.2 Configuration over code

The following **must never** be hard-coded in application source, environment files, or seed constants:

AI providers · AI model names · task-to-model routing · plan names · plan prices · plan limits ·
AI credit costs · feature availability · customer-specific behavior · social integration credentials ·
notification templates · billing configuration · supported currencies · trial duration · usage limits ·
default policies · marketing website copy where CMS control is appropriate.

All of the above live in **versioned configuration** managed from Platform Admin, with validation,
activation, rollback, change history, and audit logging. See `docs/ARCHITECTURE.md` §Configuration Service.

Code may contain a **fallback bootstrap configuration** only for local development, clearly marked, never
used when `NODE_ENV=production`.

### 2.3 Secrets

- Secrets are **never** stored as ordinary configuration values and **never** returned by any API.
- Secrets are encrypted at rest with authenticated encryption (AEAD) through a vault abstraction that can
  later be backed by a cloud KMS.
- After saving, only **masked metadata** is ever readable (e.g. `sk-…a91f`, last-rotated timestamp, fingerprint).
- Secrets must never appear in logs, traces, analytics, error messages, stack traces, or API responses.
  A redaction layer is applied to every log sink and every error serializer.
- No secret may ever be shipped to, or resolvable by, frontend code. `NEXT_PUBLIC_*` must never hold a secret.
- Secret lifecycle actions (create, rotate, disable, revoke, access) are audited **without** logging the value.

### 2.4 Credits and money

- AI credit accounting uses **reserve → confirm → settle** with an immutable ledger. Balance is derived from
  the ledger, never mutated in place.
- A failed provider request **never** results in a credit deduction.
- A retry **never** results in a duplicate deduction (idempotency key per logical action).
- Balances must never go negative; concurrency is controlled by database-level locking/constraints.
- Billing events are idempotent on the provider event ID.

### 2.5 External side effects

- Publishing, deleting, disconnecting, paying, and sending external communications are **high-impact actions**.
- They require an explicit confirmation policy and produce an `AuditEvent`.
- The AI Copilot may **propose** and **preview** these actions but must **never** execute them silently.

### 2.6 Git and delivery

- **Never** push to `main`. All work happens on a task branch and is delivered for review.
- Never commit `.env` files, credentials, tokens, or customer data.
- Never request or use real API keys, OAuth tokens, or passwords during development. Use mock providers.
- Commit messages: imperative mood, scoped (`feat(ai-gateway): …`, `docs(architecture): …`).
- Do not include model or assistant identifiers in commits, PR text, or code comments.

### 2.7 Phase discipline

- **No implementation begins until the architecture documents in `docs/` are reviewed and approved.**
- Deliver in the phase order defined in `docs/ROADMAP.md`. Do not pull work forward from a later phase
  without the owner's approval recorded in `docs/DECISIONS.md`.

---

## 3. Repository Structure (planned)

```
brandspace/
├── apps/
│   ├── web/          # Public marketing website (Next.js, SSG/ISR, SEO, i18n)
│   ├── dashboard/    # Customer application
│   ├── admin/        # Platform Admin / Control Center (internal only)
│   ├── api/          # HTTP API surface + tRPC/REST routers, auth, RBAC middleware
│   └── worker/       # Background job processors (publishing, AI, analytics, notifications, billing, media)
├── packages/
│   ├── ui/                 # Design system, tokens, RTL/LTR primitives, a11y components
│   ├── database/           # Prisma schema, migrations, RLS policies, tenant-scoped client
│   ├── auth/               # Sessions, MFA, invitations, platform vs customer realms
│   ├── ai-gateway/         # Provider adapters, routing, budgets, ledger, credits
│   ├── social-connectors/  # Per-platform adapters, OAuth, publishing, analytics ingestion
│   ├── entitlements/       # Plans, features, flags, limits, overrides, precedence engine
│   ├── billing/            # Payment provider abstraction, subscriptions, invoices, webhooks
│   ├── config/             # Versioned configuration service, schemas, activation, rollback
│   └── shared/             # Types, errors, result types, logging, i18n utilities, validation
├── docs/                   # Architecture documentation (this phase)
└── tests/                  # Cross-cutting integration, isolation, and e2e suites
```

Module boundaries are enforced by lint rules on import paths. A package may not import from an app.
`packages/database` is the only package permitted to talk to PostgreSQL directly.

---

## 4. Language, Localization, and Design

- Every user-facing string is a translation key. **No hard-coded user-facing copy** in components.
- Both `ar` and `en` are first-class. Arabic is **RTL**; layout uses logical CSS properties
  (`margin-inline-start`, not `margin-left`).
- Numbers, dates, and currency use locale-aware formatting; Arabic uses Western Arabic numerals by default
  (configurable).
- Brand colors: **Blue `#00ADEE`**, **Yellow `#FFDD15`**. These are design tokens, never literals in components.
- Accessibility target: **WCAG 2.2 AA**. Keyboard navigable, correct landmarks, visible focus, adequate contrast.
- Public website performance target: Lighthouse ≥ 95, LCP < 2.0s, CLS < 0.1 on mid-tier mobile.

---

## 5. Engineering Standards

- **TypeScript strict mode everywhere.** `any` requires a written justification comment.
- All external input (HTTP body, query, params, webhooks, job payloads, AI output that becomes data)
  is validated with a schema at the boundary. Parse, don't validate ad hoc.
- Errors are typed and mapped to stable machine-readable codes. Never leak internals to clients.
- Every mutation that changes tenant or platform state writes an `AuditEvent`.
- Every background job is **idempotent** and safe to retry.
- Database access goes through the tenant-scoped client; raw SQL requires review and an explicit tenant predicate.
- No feature ships without: unit tests for logic, an integration test for the endpoint, and — for tenant-owned
  resources — an isolation test.

### Testing pyramid

| Layer       | Tool (proposed)                           | Must cover                                                     |
| ----------- | ----------------------------------------- | -------------------------------------------------------------- |
| Unit        | Vitest                                    | pure logic, credit math, routing rules, entitlement precedence |
| Integration | Vitest + Testcontainers (Postgres, Redis) | API contracts, RLS, transactions, idempotency                  |
| Isolation   | dedicated suite                           | cross-workspace read/write/search/export denial                |
| E2E         | Playwright                                | the MVP vertical slice, RTL + LTR, a11y smoke                  |
| Contract    | recorded fixtures                         | AI provider adapters, social connectors, payment webhooks      |

---

## 6. Definition of Done

A change is done when:

1. It satisfies the acceptance criteria in `docs/MVP-ACCEPTANCE-CRITERIA.md`.
2. Tests pass, including isolation tests.
3. No new hard-coded configuration was introduced.
4. Audit events exist for state changes.
5. Both `ar` and `en` strings exist for any new user-facing text.
6. Documentation in `docs/` is updated when behavior or contracts change.
7. `docs/DECISIONS.md` is updated if a decision was made or resolved.

---

## 7. How to Work in This Repository

1. Read `docs/ARCHITECTURE.md` and `docs/DECISIONS.md` before making any change.
2. Confirm which roadmap phase the task belongs to.
3. If the task requires a decision listed as _unresolved_ in `docs/DECISIONS.md`, **ask the product owner first**.
4. Prefer extending configuration over adding code branches.
5. When adding a tenant-owned entity, add: schema + migration + RLS policy + isolation test + audit events.
6. Update the relevant doc in the same change.

---

## 8. Document Map

| Document                          | Purpose                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `docs/PRODUCT.md`                 | Product definition, interfaces, personas, modules, page and screen inventory         |
| `docs/ARCHITECTURE.md`            | System architecture, tech stack, module boundaries, tenancy, configuration service   |
| `docs/DATABASE.md`                | Entities, relationships, indexes, constraints, lifecycle states, ER diagram          |
| `docs/SECURITY.md`                | Tenant isolation, RBAC, secrets, encryption, reliability, privacy, incident response |
| `docs/ADMIN-CONTROL-CENTER.md`    | Platform Admin modules, workflows, permissions, support mode                         |
| `docs/AI-GATEWAY.md`              | Provider-agnostic AI gateway, routing, budgets, credits, ledger, failure handling    |
| `docs/SOCIAL-INTEGRATIONS.md`     | Social connectors, OAuth, publishing pipeline, analytics ingestion                   |
| `docs/BILLING-AND-CREDITS.md`     | Payment abstraction, subscriptions, invoices, AI credit economics                    |
| `docs/ROADMAP.md`                 | Phase 0 → Phase 8 + future expansion                                                 |
| `docs/MVP-ACCEPTANCE-CRITERIA.md` | Testable acceptance criteria for the first vertical slice                            |
| `docs/DECISIONS.md`               | Approved assumptions, recommendations, unresolved decisions, owner approvals needed  |
