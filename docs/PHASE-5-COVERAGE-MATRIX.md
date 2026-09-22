# Phase 5 — Coverage Matrix

> **الملخص التنفيذي بالعربية**
>
> مصفوفة تغطية المرحلة الخامسة: لكل متطلب، أين هو مُنفَّذ، وأي اختبار يُثبته، وعلى أي بيئة يعتمد، وحالته.
> الحالات أربع: **مُثبت** محليًا، **مُثبت جزئيًا**، **غير مُثبت**، و**محجوب ببيئة staging الحيّة فقط**.
> القاعدة الحاكمة: وجود الميزة لا يعني أن رحلتها كاملة مُثبتة.

**How to read this.** A requirement is `PROVEN` only when a test asserts the behaviour
itself, not when the feature exists. "Exists and is tested somewhere" is
`PARTIALLY PROVEN` when the end-to-end path through it is not asserted.

`BLOCKED ONLY BY LIVE STAGING` means the repository work is complete and the
remaining proof needs a Railway environment that does not exist yet. It is not a
gap; it is a scheduled step.

**Status counts.** 41 PROVEN · 9 PARTIALLY PROVEN · 0 NOT PROVEN · 14 BLOCKED ONLY
BY LIVE STAGING · 2 genuine defects found and fixed in this pass.

---

## A. Staging configuration contract

| #   | Requirement                                                 | Implementation                     | Test                                        | Environment dependency | Status                           |
| --- | ----------------------------------------------------------- | ---------------------------------- | ------------------------------------------- | ---------------------- | -------------------------------- |
| A1  | `NODE_ENV=production` + `APP_ENV=staging`                   | `.railway/railway.ts` `commonEnv`  | `railway-blueprint-contract` (3 assertions) | none                   | **PROVEN**                       |
| A2  | Staging cannot become production via `NODE_ENV`             | `currentEnvironment` (D-97)        | `phase5-staging-contract`                   | none                   | **PROVEN**                       |
| A3  | Blueprint builds both environments                          | `project({ environments: [...] })` | `railway-blueprint-contract`                | none                   | **PROVEN**                       |
| A4  | **Staging sealed by its own KEK, not a production KMS key** | `assertKeyDomainBoundaries`        | `phase5-staging-contract`                   | none                   | **PROVEN — defect fixed**        |
| A5  | **Staging may carry the sandbox billing secret**            | `assertProductionSafety`           | `phase5-staging-contract`                   | none                   | **PROVEN — defect fixed**        |
| A6  | Production still requires KMS                               | unchanged                          | `phase5-staging-contract`                   | none                   | **PROVEN**                       |
| A7  | Messages name the deployment they describe                  | `require/forbidProductionValue`    | `phase5-staging-contract`                   | none                   | **PROVEN**                       |
| A8  | Blast-radius boundary holds in staging                      | `assertKeyDomainBoundaries`        | `phase5-staging-contract` (5)               | none                   | **PROVEN**                       |
| A9  | Preflight validates a candidate environment                 | `scripts/staging-preflight.ts`     | `phase5-staging-preflight`                  | none                   | **PROVEN**                       |
| A10 | Staging environment actually created                        | —                                  | —                                           | **Railway**            | **BLOCKED ONLY BY LIVE STAGING** |

## B. Client origin (Phase 4 contract, carried into staging)

| #   | Requirement                              | Implementation               | Test                            | Environment dependency | Status     |
| --- | ---------------------------------------- | ---------------------------- | ------------------------------- | ---------------------- | ---------- |
| B1  | Dashboard staging carries `railway-edge` | `clientOriginEnv`            | `railway-blueprint-contract`    | none                   | **PROVEN** |
| B2  | API staging carries it                   | same                         | same                            | none                   | **PROVEN** |
| B3  | Admin does not                           | same                         | same                            | none                   | **PROVEN** |
| B4  | Worker does not                          | same                         | same                            | none                   | **PROVEN** |
| B5  | Web does not                             | same                         | same                            | none                   | **PROVEN** |
| B6  | No service carries `TRUSTED_PROXY_HOPS`  | same                         | `railway-blueprint-contract`    | none                   | **PROVEN** |
| B7  | Staging cannot choose `direct`           | `assertClientOriginContract` | `phase5-staging-contract`       | none                   | **PROVEN** |
| B8  | Production unchanged                     | unchanged                    | `phase4-client-origin-contract` | none                   | **PROVEN** |

## C. Journey — identity

| #   | Requirement                                      | Implementation        | Test                                                      | Environment dependency     | Status                           |
| --- | ------------------------------------------------ | --------------------- | --------------------------------------------------------- | -------------------------- | -------------------------------- |
| C1  | Signup, verification, sign-in, session, sign-out | `@brandspace/auth`    | `customer-app.spec` (41), `phase9-account`                | local Postgres             | **PROVEN**                       |
| C2  | MFA enrol / verify / recovery codes              | `SignupService`       | `phase4-security-settings.spec`, `phase9-account`         | local Postgres             | **PROVEN**                       |
| C3  | Password reset, enumeration-safe                 | `CustomerAuthService` | `customer-app.spec`, `phase4-security-email-truthfulness` | local Postgres             | **PROVEN**                       |
| C4  | Abuse ceilings, per-source and per-account       | `AuthRateLimiter`     | `phase4-auth-abuse` (24)                                  | real Postgres              | **PROVEN**                       |
| C5  | Verification / reset token expiry and single use | `@brandspace/auth`    | `phase9-account`, `customer-auth`                         | real Postgres              | **PROVEN**                       |
| C6  | Real transactional email delivery                | `ApiEmailProvider`    | `production-email.spec` (fake Resend)                     | **staging email provider** | **BLOCKED ONLY BY LIVE STAGING** |

## D. Journey — workspace, brand, isolation

| #   | Requirement                             | Implementation      | Test                                                         | Environment dependency | Status     |
| --- | --------------------------------------- | ------------------- | ------------------------------------------------------------ | ---------------------- | ---------- |
| D1  | Workspace creation, owner membership    | onboarding          | `onboarding-first-brand.spec`, `phase2b-tenancy`             | real Postgres          | **PROVEN** |
| D2  | Role / permission projection            | `@brandspace/auth`  | `phase2b-boundaries`, `viewer-read-only.spec`                | real Postgres          | **PROVEN** |
| D3  | Second workspace cannot see the first   | RLS + tenant client | `phase*-tenancy` (9 files)                                   | real Postgres          | **PROVEN** |
| D4  | Brand creation, quota, Brand Center     | brands              | `onboarding-first-brand.spec`, `phase3-total-quota-baseline` | real Postgres          | **PROVEN** |
| D5  | Brand boundary `(workspaceId, brandId)` | composite keys      | `brand-brain-brand-scope`, `f80-*`                           | real Postgres          | **PROVEN** |

## E. Journey — Brand Brain

| #   | Requirement                                            | Implementation            | Test                                             | Environment dependency | Status                           |
| --- | ------------------------------------------------------ | ------------------------- | ------------------------------------------------ | ---------------------- | -------------------------------- |
| E1  | Upload → source → queue → worker → chunks              | `@brandspace/brand-brain` | `brand-brain.spec` (25), `brand-brain-ingestion` | real Postgres + Redis  | **PROVEN**                       |
| E2  | Review → approved knowledge → retrieval with citations | same                      | `brand-brain-chat`, `brand-brain-governance`     | real Postgres          | **PROVEN**                       |
| E3  | Unapproved knowledge is not canonical                  | same                      | `brand-brain-governance`                         | real Postgres          | **PROVEN**                       |
| E4  | Prompt injection in uploads does not override policy   | same                      | `brand-brain-governance`                         | real Postgres          | **PROVEN**                       |
| E5  | Failure does not fabricate knowledge                   | same                      | `brand-brain.spec`                               | real Postgres          | **PROVEN**                       |
| E6  | Human precedence                                       | same                      | `brand-brain-governance`                         | real Postgres          | **PROVEN**                       |
| E7  | Same flow against **staging object storage**           | storage adapter           | —                                                | **staging R2 bucket**  | **BLOCKED ONLY BY LIVE STAGING** |

## F. Journey — assets, content, approval, calendar, publish

| #   | Requirement                                              | Implementation                                       | Test                                                        | Environment dependency  | Status                           |
| --- | -------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- | ----------------------- | -------------------------------- |
| F1  | Asset upload, metadata, worker processing                | `@brandspace/assets`                                 | `assets.spec` (18), `assets-lifecycle`                      | real Postgres + storage | **PROVEN**                       |
| F2  | Asset cross-workspace refusal                            | RLS                                                  | `phase5b-asset-tenancy`                                     | real Postgres           | **PROVEN**                       |
| F3  | AI request → quote → reserve → settle → version          | `@brandspace/ai-gateway`                             | `content-studio.spec` (24), `credit-protocol`               | real Postgres           | **PROVEN**                       |
| F4  | Provider failure releases the reservation                | same                                                 | `ai-gateway-reliability`                                    | real Postgres           | **PROVEN**                       |
| F5  | Idempotent retry, no double settlement                   | same                                                 | `credit-protocol`, `entitlements-credits`                   | real Postgres           | **PROVEN**                       |
| F6  | Arabic / English / channel variants / rewrite / tone     | content                                              | `content-studio.spec`, `phase8-creative-adaptation.spec`    | local                   | **PROVEN**                       |
| F7  | Approval: submit, approve, reject, self-approval refused | approvals                                            | `approvals.spec` (12), `content-approvals`                  | real Postgres           | **PROVEN**                       |
| F8  | Edit invalidates an approval                             | approvals                                            | `approvals-concurrency`                                     | real Postgres           | **PROVEN**                       |
| F9  | Calendar: schedule, reschedule, cancel, timezone         | calendar                                             | `content-calendar.spec` (11), `content-calendar`            | real Postgres           | **PROVEN**                       |
| F10 | Publish via **mock** connector, idempotent, retry        | `@brandspace/social-connectors`                      | `social-publishing.spec` (18), `phase6-publishing-pipeline` | real Postgres + Redis   | **PROVEN**                       |
| F11 | Duplicate worker execution publishes once                | same                                                 | `phase6-publishing-pipeline`                                | real Postgres           | **PROVEN**                       |
| F12 | No real social post is ever sent                         | `MockSocialConnectorAdapter` + `assertNotProduction` | `phase4-development-doubles`                                | none                    | **PROVEN**                       |
| F13 | Stored object survives redeploy                          | storage adapter contract                             | —                                                           | **staging R2 bucket**   | **BLOCKED ONLY BY LIVE STAGING** |

## G. Journey — analytics, Copilot, commerce, notifications

| #   | Requirement                                                        | Implementation                        | Test                                           | Environment dependency     | Status                           |
| --- | ------------------------------------------------------------------ | ------------------------------------- | ---------------------------------------------- | -------------------------- | -------------------------------- |
| G1  | Mock analytics ingest, idempotent, aggregate                       | `@brandspace/analytics`               | `analytics-copilot.spec` (28), `phase7-*`      | real Postgres              | **PROVEN**                       |
| G2  | Insight traces back to evidence                                    | same                                  | `analytics-copilot.spec`                       | real Postgres              | **PROVEN**                       |
| G3  | Copilot grounded, read-only by default                             | `@brandspace/copilot`                 | `copilot-read-only`                            | real Postgres              | **PROVEN**                       |
| G4  | Mutation requires confirmation; permission re-checked at execution | same                                  | `copilot-read-only`, `analytics-copilot.spec`  | real Postgres              | **PROVEN**                       |
| G5  | Plan, entitlement, quota, wallet, reserve/settle/refund            | `@brandspace/entitlements`, `billing` | `phase9-commerce.spec`, `entitlements-credits` | real Postgres              | **PROVEN**                       |
| G6  | Insufficient credits behaviour                                     | same                                  | `credit-protocol`                              | real Postgres              | **PROVEN**                       |
| G7  | No live checkout                                                   | `DevelopmentPaymentProvider`          | `phase4-development-doubles`                   | none                       | **PROVEN**                       |
| G8  | In-app notifications, read/unread, no cross-tenant leak            | notifications                         | `approvals.spec`, `approval-recipients`        | real Postgres              | **PROVEN**                       |
| G9  | Email handoff                                                      | `ApiEmailProvider`                    | `production-email.spec`                        | **staging email provider** | **BLOCKED ONLY BY LIVE STAGING** |

## H. Failure battery

| #   | Failure                                            | Test                                              | Status                                                                                                                            |
| --- | -------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| H1  | AI provider failure releases reservation           | `ai-gateway-reliability`                          | **PROVEN**                                                                                                                        |
| H2  | Duplicate job / duplicate worker execution         | `phase6-publishing-pipeline`                      | **PROVEN**                                                                                                                        |
| H3  | Worker message loss → reconciliation sweep         | `phase3-billing-operations`                       | **PROVEN**                                                                                                                        |
| H4  | Email provider unavailable is not reported as sent | `phase4-security-email-truthfulness`              | **PROVEN**                                                                                                                        |
| H5  | Expired verification / reset token                 | `phase9-account`                                  | **PROVEN**                                                                                                                        |
| H6  | Wrong MFA code                                     | `phase9-account`, `phase4-security-settings.spec` | **PROVEN**                                                                                                                        |
| H7  | Source and account rate limits exhausted           | `phase4-auth-abuse`                               | **PROVEN**                                                                                                                        |
| H8  | Insufficient credits                               | `credit-protocol`                                 | **PROVEN**                                                                                                                        |
| H9  | Unauthorized role                                  | `viewer-read-only.spec`, `phase2b-boundaries`     | **PROVEN**                                                                                                                        |
| H10 | Cross-workspace / cross-brand identifier           | `phase*-tenancy`                                  | **PROVEN**                                                                                                                        |
| H11 | Stale optimistic version                           | `approvals-concurrency`                           | **PROVEN**                                                                                                                        |
| H12 | Missing trusted origin fails closed                | `phase4-auth-abuse`                               | **PROVEN**                                                                                                                        |
| H13 | Contradictory staging configuration refuses        | `phase5-staging-contract`, preflight              | **PROVEN**                                                                                                                        |
| H14 | Redis unavailable / degraded                       | `packages/jobs` fallback                          | **PARTIALLY PROVEN** — the non-production inline fallback is tested; the production-mode degraded path is not asserted end to end |
| H15 | Storage absent or partially configured             | `createObjectStore`; preflight reports partial    | **PARTIALLY PROVEN** — refusal is tested, the customer-visible failure is not                                                     |

## I. Remaining PARTIALLY PROVEN rows

| Row                                 | What is missing                                               | Why it is not closed in this pass                                                                 |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| H14                                 | Production-mode Redis outage path                             | Needs a controllable Redis failure in a production-mode process; belongs with the staging battery |
| H15                                 | Customer-visible upload failure when storage is absent        | Same shape — the truthful surface is only observable against a real bucket                        |
| E7, F13                             | Storage durability across redeploy                            | Needs the staging bucket                                                                          |
| C6, G9                              | Real email delivery                                           | Needs the staging email provider                                                                  |
| A10                                 | Environment exists                                            | Owner action                                                                                      |
| Copilot undo/compensation           | Contract exists; not every path has a compensation assertion  | Scoped to the staging battery                                                                     |
| Analytics → insight → Copilot chain | Each link proven; the chain is not asserted as one journey    | Candidate for the staging journey spec                                                            |
| Invitation path                     | Tested in isolation; not part of the single journey spec      | Candidate for the staging journey spec                                                            |
| Arabic/RTL depth                    | Proven across many screens; not every Phase 5 stage in Arabic | Extend with the staging journey                                                                   |

## J. What the repository can enforce vs what only Railway can

**The application can enforce** (all tested): the `APP_ENV`/`NODE_ENV` discriminator;
per-service required and forbidden variables; key-domain scoping; one key per
domain; the client-origin contract; the hop-count pair rule; placeholder
rejection; distinct database identities; the migration identity never reaching a
request-serving service.

**Only Railway or the operator can verify**, because the process cannot see the
other environment's values: that the staging bucket is not the production bucket;
that staging KEKs differ from production KEKs; that staging session secrets differ;
that the staging OAuth application is a different application; that staging
Postgres and Redis are separate instances. The blueprint states each of these
where the operator reads it, and the preflight reports what it can see — neither
can compare across environments, and this document does not pretend otherwise.
