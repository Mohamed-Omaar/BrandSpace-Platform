# Current execution Phase 6 — UX Integration

> **الملخص التنفيذي بالعربية**
>
> هذه المرحلة **ليست إعادة تصميم**. النظام البصري الحالي لـ BrandSpace — الهيكل، الشريط الجانبي، الألوان،
> الخطوط، الأزرار، البطاقات، الحقول، الظلال، الأنصاف، عائلة الأيقونات، سلوك RTL/LTR ورموز `packages/ui` —
> **مُقفل** ولا يتغير.
> نموذج Phase 6 HTML هو مرجع **بنية المعلومات وتجربة المستخدم وتدفّق المنتج فقط**، وليس مرجعًا بصريًا.
> العمل على بيئة **Staging فقط**: لا إنتاج، لا دمج في `main`، لا نشر اجتماعي حقيقي، ولا بيانات تجريبية مُختلقة
> في تجربة العميل.

**Branch:** `feat/phase-5-staging-full-e2e` → Phase 6 continues from its head.
**Status:** NOT MERGED · NOT DEPLOYED TO PRODUCTION · staging only.

---

## 1. The two authorities, and which one wins where

Phase 6 has two reference authorities and they govern **different** things. Confusing them is the
failure this section exists to prevent.

| Authority                                                                                                     | Governs                                                                                                                                          | Never governs                                         |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **The current BrandSpace design system** (`packages/ui`, the approved routes, `docs/UI-FIDELITY-CONTRACT.md`) | Every pixel: colour, type, spacing, grid, radius, shadow, icon family, motion, control geometry, shell and sidebar appearance, RTL/LTR behaviour | What screens exist, what they contain, how work flows |
| **The Phase 6 iteration-3 prototype**                                                                         | Information architecture, navigation grouping, product flow, interaction model, what belongs on a screen and in what order                       | **Any visual styling whatsoever**                     |

Written as the formula the brief gives:

> CURRENT BRANDSPACE DESIGN SYSTEM = visual authority
> PHASE 6 ITERATION 3 = product/UX architecture authority

**Consequence for every commit in this phase:** a Phase 6 change may move a thing, group a thing,
name a thing, or add a missing state. It may not restyle a thing. Where Phase 6 needs a screen that
has no approved reference, CLAUDE.md §4.2 applies unchanged — build it from the platform's own
established visual language and record it as an approved design-system extension, never as a new
visual language.

**The prototype file is not vendored into this repository.** `brandspace_phase6_iteration3_researched_unified(1).html`
was supplied to the owner's session as a brief, not committed. The IA it defines is transcribed into
this document's §3 and §4 so the work has a checkable source inside the repo; if the file is later
vendored, it goes under `docs/visual-reference/` and is cited here — and it still carries **no**
visual authority.

---

## 2. Safety contract for this phase

These are restated from the brief because a phase document that omits them is how they get lost.

1. Production is not touched — not read, not changed, not deployed, not migrated.
2. No production secret, variable, service, database, domain, credential or customer datum is read,
   rotated, copied or migrated.
3. Nothing is merged to `main`. Work stops before merge and waits for explicit owner approval.
4. Staging only: the existing feature branch and the Railway **staging** environment, `APP_ENV=staging`.
5. No secret appears in logs, commits, output, screenshots or PR text.
6. Tenant isolation, RLS, RBAC, audit logging, idempotency and configuration-over-code are preserved
   by every change in this phase. A new tenant-owned model arrives with its isolation test in the
   same commit (CLAUDE.md §2.1) — no exceptions, and Notes is the model this applies to.
7. No real social publishing is performed.
8. No invented demo data in the real staging customer experience. Real data, honest empty states, or
   an explicit unavailable state naming the reason.

---

## 3. Implementation matrix

Classification, per the brief:

- **EXISTING** — ships and is substantially correct. Audit, close UX/contract gaps, move on. **Do not rebuild.**
- **NEEDS UX REWORK** — the backend and domain are real; the surface does not yet express the Phase 6 IA.
- **NEEDS BACKEND WORK** — the surface exists or is straightforward; a domain capability is missing or wrong.
- **MISSING** — neither exists.

Every classification below is from reading the current branch, and cites what was read.

### 3.1 Shell, navigation and context

| #   | Area                                                                                      | Classification         | Evidence on this branch                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | App shell, sidebar, drawer, collapse, focus management                                    | **EXISTING**           | `packages/ui/src/app-shell.tsx`; one implementation shared by dashboard and Control Center. **Locked — visual authority.**                                                                                                                                                                                                                                        |
| 2   | Sidebar **grouping** into CORE / PLAN / CREATE / PUBLISH / IMPROVE / AUTOMATE / WORKSPACE | **NEEDS UX REWORK**    | `AppShell` already takes `readonly ShellNavSection[]` with per-section titles, and `apps/admin` already uses grouped sections (`admin-shell.tsx:54` `NAV_SECTIONS`). The customer dashboard passes **one unnamed section containing all 22 items** (`workspace-shell.tsx:366`). Regrouping uses the shipped mechanism — no new component, no new visual language. |
| 3   | Dead navigation                                                                           | **EXISTING (correct)** | Every `NAV` entry is gated on the permission its route requires, and each route re-checks with `requireWorkspace(...)` and answers 404. Hidden links are tidiness; the routes are the control. Preserve this when regrouping.                                                                                                                                     |
| 4   | Global Workspace Selector                                                                 | **EXISTING**           | `WorkspaceSwitcher` in `packages/ui/src/switchers.tsx`, fed by `availableWorkspaces`.                                                                                                                                                                                                                                                                             |
| 5   | Global Brand Selector as the single source of brand context                               | **EXISTING**           | `BrandSwitcher` + `brandContext` + `selectBrandAction`; D-190 already removed per-page brand pickers from Analytics and the composer rail, and `brandTrigger()` refuses to guess a brand (`brand/all/unselected/empty` are four distinct, visible states). Audit the remaining 7 pages for a second brand control; do not add one.                                |
| 6   | Command Center / Home                                                                     | **NEEDS UX REWORK**    | `/[locale]/overview` exists with an approved hero. Phase 6 asks it to become the Command Center. Content and composition change; the hero's visual treatment does not.                                                                                                                                                                                            |

### 3.2 The named blockers

| #   | Area                                                     | Classification         | Evidence on this branch                                                                                                                                  |
| --- | -------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | **Shared control consistency** (P6-02)                   | **NEEDS UX REWORK**    | Root-caused in §4.1. Real, reproducible, and fixable only through `packages/ui`.                                                                         |
| 8   | **Customer password floor, Show/Hide, Confirm** (P6-03a) | **NEEDS BACKEND WORK** | The floor of 12 is hard-coded in four places (§4.2). Sign-up already reads `policy.signup.minPasswordLength` from configuration; the other paths do not. |
| 9   | **New-workspace brand quota refusal** (P6-03b)           | **NEEDS BACKEND WORK** | Root-caused in §4.3. A defect in how a quota feature's _absent_ default is collapsed, plus a message that is false for the case that triggers it.        |

### 3.3 Collaboration

| #   | Area                            | Classification | Evidence on this branch                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | **Notes / Comments / Mentions** | **MISSING**    | 84 Prisma models; no `Note`, `Comment` or `Mention` among them. This is the one genuinely new tenant-owned capability in Phase 6. It arrives with `workspaceId`, RLS ENABLE+FORCE, permission checks, 404 masking, audit events and an isolation test in the same commit. Mentions resolve only within the same workspace. **Notes are not Brand Brain knowledge** and never write into it. |
| 11  | Notifications                   | **EXISTING**   | `model Notification` (schema:3246) and `/[locale]/notifications`. Notes wire into it rather than growing a second delivery path.                                                                                                                                                                                                                                                            |
| 12  | Approvals                       | **EXISTING**   | Approval domain is the source of truth and stays so. Phase 6 adds one contract: **"Needs work" creates or attaches a collaboration Note and notifies** — which is blocked on #10.                                                                                                                                                                                                           |
| 13  | Activity log                    | **EXISTING**   | `/[locale]/activity`; grades what a reader may see rather than refusing them.                                                                                                                                                                                                                                                                                                               |

### 3.4 Brand Brain and the learning loop

| #   | Area                                                                                                       | Classification      | Evidence on this branch                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 14  | Four memory layers (Canonical / Strategy / Content / Performance-Learning)                                 | **EXISTING**        | `enum BrandMemoryLayer { CANONICAL STRATEGY CONTENT LEARNING }` (schema:1681) with `memoryPrecedence()` ordering retrieval — Canonical outranks Strategy outranks Content outranks Learning, "always, and not as a tie-break". **Do not rebuild this.**                        |
| 15  | Provenance and authority levels                                                                            | **EXISTING**        | Provenance enum with HUMAN ≻ DOCUMENT ≻ AI_INFERRED, and the rule that no AI-inferred item may overwrite a human one (schema:1688). D-65's seven write-back requirements — provenance, evidence, confidence — are in the schema (`confidenceMilli` at 1886, 1988, 2163, 4367). |
| 16  | Conflict surfacing with evidence, confidence, source, Accept / Edit / Dismiss                              | **NEEDS UX REWORK** | The domain carries everything the UI needs; the surface does not yet present a conflict as a conflict. Silent overwrite must remain impossible.                                                                                                                                |
| 17  | Learning loop OBSERVE → DETECT → PROPOSE → EVIDENCE → HUMAN REVIEW → ACCEPT/EDIT/DISMISS → GOVERNED MEMORY | **NEEDS UX REWORK** | Schema:3721 already states a learning re-enters Brand Brain at its **lowest** authority. The loop's governance exists; its visibility does not.                                                                                                                                |
| 18  | Readiness indicator                                                                                        | **MISSING**         | No `readiness` anywhere in the dashboard or `packages/brand-brain`. Per the brief it ships as **Complete / Partial / Missing** — never a hard-coded or fabricated percentage, and never a fabricated confidence or metric.                                                     |

### 3.5 Product modules

| #   | Area                               | Classification | Evidence on this branch                                                                                                         |
| --- | ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 19  | AI Strategy                        | **EXISTING**   | `/[locale]/strategy`, gated `strategy.read`.                                                                                    |
| 20  | Campaigns                          | **EXISTING**   | `/campaigns`, `/campaigns/new`, `/campaigns/[campaignId]`.                                                                      |
| 21  | Content Studio                     | **EXISTING**   | `/content`, `/content/compose`. Carries most of the §4.1 control defects.                                                       |
| 22  | Creative Studio                    | **EXISTING**   | `/creative`, gated `assets.upload`.                                                                                             |
| 23  | Asset Library                      | **EXISTING**   | `/assets`; the first approved design-system extension (CLAUDE.md §4.2).                                                         |
| 24  | Calendar                           | **EXISTING**   | `/calendar`.                                                                                                                    |
| 25  | Social accounts / publishing       | **EXISTING**   | `/integrations`, gated `integrations.read`. Mock connectors only in staging; **no real publishing.**                            |
| 26  | Analytics                          | **EXISTING**   | `/analytics`; already honest about absent metrics (`unavailable` + one of six named reasons, never a zero).                     |
| 27  | Marketing Intelligence / Learnings | **EXISTING**   | `/intelligence`, gated `strategy.read`.                                                                                         |
| 28  | Copilot                            | **EXISTING**   | `/copilot`, gated `copilot.use`; proposes and previews, never executes silently (CLAUDE.md §2.5).                               |
| 29  | Automations                        | **EXISTING**   | `/automations`, gated `automation.read`.                                                                                        |
| 30  | Team / Members / Permissions       | **EXISTING**   | `/members`, `/permissions`.                                                                                                     |
| 31  | Settings                           | **EXISTING**   | `/settings`, `/settings/brand`, `/settings/security`.                                                                           |
| 32  | Billing & Usage                    | **EXISTING**   | `/plan` (entitlement) and `/billing` (invoices, payment, accounting export) — deliberately two screens answering two questions. |

**Summary: 19 EXISTING · 8 NEEDS UX REWORK · 3 NEEDS BACKEND WORK · 2 MISSING.**

The shape of Phase 6 is therefore: **one new tenant-owned capability (Notes), two blockers to clear,
and an information-architecture pass over surfaces whose domains already work.** Nothing in §3.5 is
rebuilt.

---

## 4. Root causes for the blockers

Each was established by reading the code on this branch, not inferred from the symptom.

### 4.1 P6-02 — control consistency

Four defects were reported. Each was root-caused rather than taken at face value, and **two of the
four first-pass counts in this section were wrong and are corrected here** — the audit heuristic
(a `<button>` carrying neither `className` nor `style`) over-counted, and the first explanation of the
doubled arrow was wrong about the mechanism.

**(a) Bare browser-default buttons — TWO, not four.** The heuristic flagged four; two of them are
styled by an ancestor rule in the design system's own stylesheet and are fine:
`brand-brain-view.tsx:441` (`.bb-upload button[type='submit']`) and `brand-chat.tsx:316`
(`.bb-chat-suggestions button`). The two genuinely unstyled controls, with no class, no inline style
and no rule that could reach them, were:

- `apps/dashboard/src/app/[locale]/billing/page.tsx:437` — the submit of the accounting export form.
  **This is the button the owner reported**, sitting between two design-system date fields in the
  browser's own grey chrome.
- `apps/admin/src/app/[locale]/console/health/page.tsx:236` — the Control Center's billing-event
  replay, one per table row.

Both now take `buttonStyle()` **with** `buttonClass()`. They stay plain `<button type="submit">`
rather than the `Button` component deliberately: `Button` is a client component defaulting to
`type="button"`, and both forms exist to work with no JavaScript at all. `buttonClass` was private
and is now exported, because the style alone is half a button — `:hover`, `:active` and `:disabled`
cannot be expressed inline, so a call site taking one and not the other gets a control that looks
right and feels dead.

**(b) The doubled dropdown arrow — the cause is `appearance: base-select`.** The first reading of
this section blamed the selects that carry no design-system class. That is a real defect (see (c))
but it produces a _mismatched_ marker, not a doubled one. The doubling is in `tokens.css` itself:

```
select.bs-control            { appearance: none; background-image: <chevron> }   /* ~line 628 */
@supports (appearance: base-select) {
  select:not([multiple])     { appearance: base-select }                          /* ~line 1129 */
}
```

Both selectors are specificity **(0,1,1)** — `:not()` contributes nothing itself but its argument
does — so the later declaration wins and `base-select` takes effect. The browser then draws its own
`::picker-icon` **while the chevron background-image is still painted underneath it**. Two markers,
on precisely the selects that had adopted the design system, in precisely the browsers that support
customizable selects. Inside the `@supports` block the product's chevron now stands down and the
trailing space returns to ordinary padding, so there is exactly one marker in every browser.

**(c) Selects wearing the browser's arrow.** Seven selects carry neither `bs-control` nor
`bs-select`, so the class-keyed rule never reached them — five in `content/compose/composer-view.tsx`
(499, 581, 676, 687, 825) with no class at all, and `content/content-library-view.tsx:189` with
`.cs-select`. Worse, `.cs-select` and `.cs-field select` in `content-studio.css` set the
**`background` shorthand**, which resets `background-image` as well as the colour and outranks an
element rule on specificity — so even after re-keying, the chevron would have been erased there.

`.cs-select` is the sharpest case for fidelity rather than taste: it renders the demo's
`.select-like`, which **in the demo is a static `<div>` with no arrow at all**. The native arrow was
never part of the approved design; it arrived with the conversion to a real `<select>`.

The fix is therefore keyed on the **element**, so a select cannot opt out by forgetting a class, with
two custom properties (`--bs-select-chevron-inset`, `--bs-select-chevron-space`) so a 36px filter
select at 9px type can fit the same glyph at its own scale. The two shorthands became
`background-color`. The demo's fill, radius, padding and type are untouched.

**(d) Selected option rows merging.** `select:not([multiple]) option` gives each row a radius and a
lavender highlight when `:checked`, `:hover` or `:focus`, and no separation. The selected row and the
row the pointer is on are adjacent as soon as you move one step, so the two highlights met edge to
edge and read as one taller block with a pinched waist rather than two rows one of which is chosen.
`.bs-dropdown-option` never showed this because its panel gives it room. The native list now gets a
1px vertical margin.

**(e) Date inputs.** Six `type="date"` inputs (`billing:415,430`, `campaign-form-view:148,159`,
`calendar-view:238,329`) carried `bs-control` and `inputStyle()`, but nothing normalised the native
picker indicator — a browser-drawn glyph at its own size and colour, at the **physical** trailing
edge, so in Arabic it sat opposite every other control's mirrored marker. The indicator is kept (on
some platforms it is the only affordance that opens the picker) and given the product's inset, the
chevron's size and a logical margin, with the field's own direction corrected for RTL.

**The guard.** All of the above is fixable a second time by the next call site that forgets, so
`tests/unit/phase6-control-consistency.test.ts` fails on a `<button>` with no styling anywhere in
either app, on the chevron being re-keyed to a class, on a `background` shorthand returning to a
select, and on the `@supports` stand-down being removed. Exemptions are listed with the rule that
justifies them, and the test fails if a cited rule stops existing. It found one defect in itself
while being written — it matched the words `<button>` inside a JSX comment — which is why it blanks
comments before scanning while preserving line numbers.

### 4.2 P6-03a — the password floor

The customer floor of 12 characters is hard-coded in four places, while sign-up already reads it from
configuration:

| Location                                                           | Current                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `packages/auth/src/password.ts:19`                                 | `if (plaintext.length < 12) throw` — the domain floor                     |
| `apps/dashboard/src/app/[locale]/(auth)/actions.ts:234` and `:315` | `if (password.length < 12)`                                               |
| `apps/dashboard/src/app/[locale]/(auth)/reset/[token]/page.tsx:48` | `minLength={12}`                                                          |
| `apps/dashboard/src/app/[locale]/invitations/[token]/page.tsx:131` | `minLength={12}`                                                          |
| `apps/dashboard/src/app/[locale]/(auth)/sign-up/page.tsx:132`      | `minLength={policy.signup.minPasswordLength}` — **already configuration** |

**RESOLVED.** `ABSOLUTE_MIN_PASSWORD_LENGTH` (8) and `ABSOLUTE_MAX_PASSWORD_LENGTH` (128) live in
`@brandspace/shared`, bound the configuration schema and are the only floor the domain enforces; the
policy in force is resolved from configuration at every boundary through one accessor,
`signupPolicy()`. The hard-coded copies are removed rather than re-typed, and a guard fails on the
SHAPE of the defect — any comparison of a password length against a literal, not just against 12 —
so writing `< 8` would be caught too.

The ceiling is new and is not cosmetic: Argon2id hashes whatever it is given, so an unbounded
password on an unauthenticated endpoint is a cheap way to spend the server's memory budget.

Argon2id at m=19456/t=2/p=1 is unchanged, every server action still validates independently, the
F-19 abuse ceilings are untouched, and a test asserts Platform Admin reads none of this.

The UI is **one component** — `packages/ui/src/password-field.tsx` — rather than four hand-rolled
inputs, carrying the reveal toggle, the confirmation with live mismatch, and a rules list stated
before anything is typed. **The confirmation is deliberately unnamed and is never submitted**: a
client-side match is the caller checking their own input, so no action reads it and a test fails if
one starts to.

**One thing this uncovered and did NOT fix.** `docs/SECURITY.md` §3 has always listed a
breached-password check beside the length policy, and nothing in the repository implements one. That
matters more after this change than before it, because NIST's position is that a shorter minimum is
safe _because_ candidates are screened against known-breached corpora — the two halves were meant to
ship together and only one ever did. It is recorded as **F-89** and the requirements table now says
it is not implemented, rather than the document continuing to claim a control the product lacks.

### 4.3 P6-03b — the new-workspace brand quota refusal

The chain, end to end:

1. `packages/onboarding/src/workspace.ts:180` writes
   `planKey: offersTrial ? trialPlan.key : null`, where `offersTrial` requires **all three** of: a
   configured trial plan, `trialDays > 0`, and a price in the workspace's chosen currency. A staging
   environment with no configured customer plans fails the first condition, so **`planKey` is `null`**.
2. Creating the first brand calls `createTotalResourceQuota({ dimension: 'brands' })`
   (`plan-quota.ts`), which asks `EntitlementService.limit(workspaceId, 'limit.brands')`.
3. With `planKey === null`, `resolveOwnRules` falls past step 8 ("no plan assigned") to step 9,
   **feature default**. `limit.brands` is declared in the bootstrap projection as
   `{ valueType: 'quota', defaultValue: null }` (`service.ts:900`).
4. Step 9 computes `limitValue = null` (not a number), `enumValue = null`, and
   `enabled = (defaultValue === true)` → `false`. It returns **`enabled: false, limitValue: null`**.
5. `EntitlementService.limit()` then does `if (!decision.enabled) return 0` — **collapsing
   "no ceiling declared" into "a ceiling of zero"**.
6. `usage.consume({ limitValue: 0 })` refuses, `createPlanQuota.consume` returns `false`, and the
   customer is shown `QUOTA_EXCEEDED`: _"This workspace has reached a limit on its plan. Free some
   space or ask an admin to change the plan."_

Two things are wrong, and they are separable.

**The message is false for this case.** The workspace has no plan, has reached no limit, and has
nothing to free. Every instruction in that sentence is unactionable for the customer it is shown to.

**The collapse contradicts the engine's own stated rule.** `limit()`'s own comment says _"`null` is
unlimited and `0` is none, and a caller that collapses the two locks out exactly the customers who
paid for no limit"_ — and step 9 paired with `limit()` is precisely that collapse, performed on the
engine's own behalf. Step 9 is applying a **boolean** feature's rule (`defaultValue === true`) to a
**quota** feature, for which the meaningful default is a ceiling, and whose absent default means _no
ceiling stated_, not _a ceiling of zero_.

The fix is therefore in the `feature_default` branch for `valueType: 'quota'` only, and it is
constrained by three things that must not change:

- `unknown_feature` continues to fail closed. A typo in a feature key must never grant anything, and
  that is a different branch of the ladder.
- Cases 2 and 3 are decided at **step 8** by a plan entitlement and are untouched: a plan stating
  `brands = 0` still refuses, and a plan stating `brands = 1` still admits exactly one.
- **No brand allowance is hard-coded anywhere.** The ceiling remains whatever configuration states —
  a plan entitlement, a workspace override, or a declared feature default. What changes is only what
  the engine does when configuration states _nothing_.

The existing isolation assertions that a workspace on no plan "gets nothing"
(`tests/isolation/entitlement-resolution.test.ts:225`) and that `limit()` returns 0 for a disabled
feature (`:234`) are about **boolean** features — `ai.copilot`, `approvals.workflow` — and are
preserved unchanged.

Whether staging additionally needs its plan configuration repaired is a separate question from this
defect, and is answered in §6. **Repairing staging would hide this defect rather than fix it**: any
customer reaching a workspace with no applicable plan, in any environment, hits the same wall.

The four cases the owner requires are proven as tests, not asserted in prose:

1. no applicable plan → the first brand is **not** refused;
2. a plan with `brands = 0` → refused;
3. a plan with `brands = 1` → the first succeeds, the second is refused;
4. replay / double submit is idempotent and consumes no second slot.

---

## 5. Workstream order

P6-02 and P6-03 first, as the named blockers, then the sequence.

| ID    | Workstream                                                                     | Depends on |
| ----- | ------------------------------------------------------------------------------ | ---------- |
| P6-01 | Audit, matrix, design-authority lock (this document)                           | —          |
| P6-02 | Shared UI consistency: buttons, selects, arrows, option spacing, inputs, dates | —          |
| P6-03 | Auth + onboarding UX + the no-plan brand quota blocker                         | —          |
| P6-04 | Navigation grouping, discoverability, Command Center                           | P6-02      |
| P6-05 | Notes / mentions / contextual collaboration + notifications                    | —          |
| P6-06 | Approvals integration with Notes                                               | P6-05      |
| P6-07 | Living Brand Brain UI: provenance, governance, conflicts, learnings            | —          |
| P6-08 | Strategy + Campaign contextual integration                                     | P6-07      |
| P6-09 | Content + Creative + Assets contextual integration                             | P6-02      |
| P6-10 | Calendar + Publishing operational integration                                  | P6-02      |
| P6-11 | Analytics + Marketing Intelligence + learnings + Pulse                         | P6-07      |
| P6-12 | Copilot contextual actions + Automations integration                           | P6-05      |
| P6-13 | Team / Activity / Settings / Billing integration                               | P6-02      |
| P6-14 | Arabic RTL + responsive + accessibility parity pass                            | all        |
| P6-15 | Full staging E2E + security/isolation regression + cleanup                     | all        |

---

## 6. Staging delivery

Verified before any staging claim is made, and never assumed:

- the branch is the Phase 6 feature branch, not `main`;
- the Railway environment reads **Staging**;
- `APP_ENV=staging` (D-97 — never `NODE_ENV`, which every built Next.js app sets to `production`);
- no production credential is present, which `pnpm staging:preflight` checks by name and status
  without printing a value;
- the development doubles refuse construction under `APP_ENV=production` (D-215), so a staging
  deployment cannot silently become a production one;
- no real social publishing is performed.

Whether staging's plan configuration is itself stale is checked here **after** §4.3 is fixed, so the
fix is proven on its own merits first. If staging configuration or seed data needs repair, the repair
is **staging only** and is recorded in this document.

---

## 7. Verification

Every level, per the brief: unit · integration · isolation · E2E in **both** EN and AR · accessibility ·
responsive. The regression methodology carried forward from Phases 4 and 5 applies to every defect
fixed in this phase — write the test, plant the defect, show the test fail, restore, keep the test.

### 7.1 Defect plants performed so far

Each was shown FAILING with the defect in place and PASSING once restored. A test that does not fail
when its defect is reinstated is not evidence of anything.

| #   | Planted defect                                                                   | Failed              |
| --- | -------------------------------------------------------------------------------- | ------------------- |
| 1   | The quota default collapse restored (`quotaWithNoStatedCeiling` forced false)    | 2 unit, 3 isolation |
| 2   | The `planEnded` narrowing dropped, so a cancelled subscription gets unlimited    | 1 unit              |
| 3   | The concurrent-replay guard removed from `usage.consume`                         | 1 isolation         |
| 4   | `.cs-select`'s fill changed away from the demo's value                           | 2 unit (fidelity)   |
| 5   | A gradient rewritten as a colour longhand, to test the substitution's narrowness | 2 unit (fidelity)   |
| 6   | The accounting export button returned to bare                                    | 1 unit              |
| 7   | The select chevron re-keyed to a class instead of the element                    | 1 unit              |
| 8   | The `background` shorthand returned to `.cs-field select`                        | 1 unit              |
| 9   | `CONTROL_CLASS` removed from the password input                                  | 1 unit              |
| 10  | The 12-character floor hard-coded back into `hashPassword`                       | 2 unit              |
| 11  | A server action made to read the password confirmation                           | 1 unit              |
| 12  | The confirmation field given a `name`, so it submits                             | 1 unit              |
| 13  | `MIN_OWNER_PASSWORD_LENGTH` lowered to the customer floor                        | 1 unit              |

Plant 9 was invalid on the first attempt — the substitute class `bs-control-PLANTED` contains the
substring the scan looks for, so it passed. Recorded because a plant that does not actually remove
the property proves the opposite of what it claims, and the second attempt used a class that shares
no substring.

### 7.2 Results on this branch

| Gate                             | Result                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                             | **2238 passed**, 94 files (2232 before the merge brought the owner's 6)                                                                                                                                                                                                                                                                                                                     |
| Isolation (real PostgreSQL)      | **Green in CI on a fresh database.** Locally, 9 tests in `phase7-round6`/`round7` fail on this container's long-lived database: 7312 accumulated `automation_rule` rows starve their `BATCH = 500` sweep. Proven by raising the batch above the row count, which makes them pass unchanged. Recorded as **F-90** — unrelated to Phase 6, and invisible to CI because CI migrates from empty |
| D-29 tenant-isolation gate       | 65 tenant-owned, 9 platform-owned — all covered                                                                                                                                                                                                                                                                                                                                             |
| Typecheck                        | clean across every package and app                                                                                                                                                                                                                                                                                                                                                          |
| Lint                             | clean (after fixing the seven errors the merge brought in — D-263)                                                                                                                                                                                                                                                                                                                          |
| Build                            | clean                                                                                                                                                                                                                                                                                                                                                                                       |
| Secret scan (CI's exact pattern) | no new matches; the only hits are the pre-existing allowlisted redaction fixtures                                                                                                                                                                                                                                                                                                           |

---

## 8. Close-out

Phase 6 stops before merge and waits for explicit owner approval, with the sixteen-point report the
brief specifies.

**STAGING ONLY · NO PRODUCTION · NO MERGE.**
