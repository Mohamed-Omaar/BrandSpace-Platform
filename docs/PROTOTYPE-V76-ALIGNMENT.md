# Prototype v76 ↔ repository alignment

**Branch:** `feat/prototype-v76-alignment` (from `staging` @ `bbb8771`, 2026-09-25) · **Target of the PR:** `staging` — never `main`.
**Prototype:** BrandSpace design canvas v76 (`Main.dc.html` customer app, `Auth.dc.html` sign-in + onboarding).
**Status of this document:** comparison only. Nothing in the code has been changed yet.

Each prototype decision (ids A1–C8, full text in the appendix) was checked against the code on this branch:
**EXISTS** matches · **PARTIAL** some of it exists · **MISSING** not built · **CONFLICTS** the repo deliberately does it differently (a `D-` decision records why).

---

## 0. Owner decisions (all answered 2026-09-25)

These items contradict recorded decisions or change security rules. Claude Code must not implement them until the owner answers, and each answer becomes a new `D-` entry in `docs/DECISIONS.md`.

| #   | Question                                                                                                                                                                                                                                                                                                                                                                                                                       | Prototype wants                                                                                            | Repo today                                                        | Recorded as                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | ~~Does a plan belong to the account or to each workspace?~~ **DECIDED (owner, 2026-09-25):** every plan carries a **workspace allowance** (e.g. 1 or 2). An owner whose plan allows more than one sees “+ New workspace” with usage “used / allowed” (e.g. 1/2); at the limit the option shows the usage and an upgrade message; on a plan that allows only 1 the option is **not shown at all**. Billing stays per workspace. | —                                                                                                          | Plan is per workspace; no workspace quota                         | Implement: `PlanQuotas.workspaces` + `limit.workspaces`; count workspaces the user owns (not deleted) against the allowance of the owner's plan; enforce in `WorkspaceOnboardingService.create`; UI per the rule above                                                                                                   |
| Q2  | ~~Show the workspace switcher in the sidebar?~~ **DECIDED (owner, 2026-09-25): yes, like the prototype.** The sidebar brand card opens the switcher: every workspace with “role · plan”, a check on the current one, usage “used / allowed” for owners (see Q1), “+ New workspace” per Q1. This reverses D-302 for the switcher; record a new D-entry.                                                                         | —                                                                                                          | Workspace hidden; “Switch business” in the account menu           | D-302 (superseded for the switcher)                                                                                                                                                                                                                                                                                      |
| Q2b | **NEW (owner, 2026-09-25): several brands inside one workspace is switched OFF for now** so customers aren't confused: one workspace = one business = one brand.                                                                                                                                                                                                                                                               | Brands section hidden in the switcher, Settings → Brands hidden, “Brands n/limit” hidden in Plan & billing | Multi-brand is live (`limit.brands`, brand creation, brand scope) | Implement as a platform feature in the Control Center (D-314 feature flags, e.g. `feature.multi_brand`) set to **nobody**; the customer UI hides brand creation/switching and Settings → Brands when off; server refuses a second brand when off. Keep all multi-brand code so it can be switched back on per plan later |
| Q3  | ~~Owner **"View as teammate"~~ **DECIDED:** read-only preview only — owner sees exactly what the teammate sees; every change action is refused with “Preview only”; banner + “Back to my view”; each preview start is an audit event. Record as a D-entry clarifying it is not the impersonation D-28 forbids.                                                                                                                 | Read-only preview with banner                                                                              | Impersonation is prohibited                                       | D-28, R-30, SECURITY §417                                                                                                                                                                                                                                                                                                |
| Q4  | ~~Per-member permission overrides~~ **DECIDED: deferred.** No per-member overrides for now; the Team screen shows the role's permissions read-only (“From the role”).                                                                                                                                                                                                                                                          | Yes (grant/deny single keys)                                                                               | A role _is_ its permission set                                    | `permissions.ts:180`                                                                                                                                                                                                                                                                                                     |
| Q5  | ~~"No access to this page"** screen~~ **DECIDED:** “No access to this page” only for routes in the known navigation list; any other URL keeps the 404 behaviour (CLAUDE.md §2.1 preserved).                                                                                                                                                                                                                                    | Yes                                                                                                        | Forbidden must look identical to missing (404)                    | CLAUDE.md §2.1                                                                                                                                                                                                                                                                                                           |
| Q6  | ~~⌘K search~~ **DECIDED: separate later phase.** Build a permission- and brand-scope-aware search backend first, then the ⌘K palette; D-276 stays until then.                                                                                                                                                                                                                                                                  | Yes                                                                                                        | Removed until a search domain exists                              | D-276                                                                                                                                                                                                                                                                                                                    |
| Q7  | ~~Country sets the time zone~~ **DECIDED:** country **preselects** its usual time zone as a suggestion; the customer can change it before saving (compatible with D-194: nothing is saved that the customer didn't confirm).                                                                                                                                                                                                   | Auto-set (editable)                                                                                        | Never guessed                                                     | D-194 — suggest "preselect, stays editable"                                                                                                                                                                                                                                                                              |
| Q8  | ~~Editing a **scheduled** post by someone without `content.schedule`~~ **DECIDED: prototype rule.** An edit by someone without `content.schedule` cancels the slot (quota refunded) and returns the post to DRAFT; it needs approval again. New D-entry superseding the code comments in `library.ts`.                                                                                                                         | Unschedule → draft (needs approval again)                                                                  | Stays scheduled; publish blocked by approval fingerprint          | code comments `library.ts` 696–734, D-223/230                                                                                                                                                                                                                                                                            |
| Q9  | ~~Expired connection** (`NEEDS_REAUTH`)~~ **DECIDED: warn, don't block.** `NEEDS_REAUTH` is a warning in Studio/Calendar; posts are held until reconnection or deadline (existing behaviour); `REVOKED` still blocks.                                                                                                                                                                                                          | Warn, still allow scheduling                                                                               | Blocking                                                          | `publish-readiness.ts:77`                                                                                                                                                                                                                                                                                                |
| Q10 | ~~Default reviewer auto-assignment~~ **DECIDED: both.** On submit, the review is auto-assigned to the first eligible approver who isn't the author (non-owners before the owner) and shown as “assigned to X”; any other member with `content.approve` for that brand can still decide it (queue shows assigned-to-me first). Amends D-127.                                                                                    | First approver ≠ author, non-owners first                                                                  | Unassigned = anyone may pick up                                   | D-127                                                                                                                                                                                                                                                                                                                    |
| Q11 | ~~Permission to **change a post's campaign~~ **DECIDED: keep the repo.** Choosing a campaign when a post is created needs `content.create`; moving an existing post to another campaign (or removing it) needs `campaigns.manage` (D-224, D-232).                                                                                                                                                                              | `content.create`                                                                                           | `campaigns.manage` (changes what a campaign reports)              | D-224, D-232                                                                                                                                                                                                                                                                                                             |
| Q12 | ~~Client viewer** sees "waiting for your feedback"~~ **DECIDED:** `client_viewer` gains read access to content (`content.read`) and may comment only (notes); still no create/approve. New D-entry amending D-62/D-130.                                                                                                                                                                                                        | Yes                                                                                                        | Viewer has `workspace.read` only                                  | D-62, D-130, U-06                                                                                                                                                                                                                                                                                                        |
| Q13 | ~~Billing visibility~~ **DECIDED: keep the repo.** Admins can view billing read-only (`billing.read`); only the owner changes plan or buys credits (`billing.manage`).                                                                                                                                                                                                                                                         | Owner only                                                                                                 | Admins can view (`billing.read`)                                  | SECURITY §4.3                                                                                                                                                                                                                                                                                                            |
| Q14 | ~~Brand chat grounding~~ **DECIDED:** brand chat answers from **approved** knowledge only — set `maxContextChunks` to 0 (or remove unreviewed chunks from retrieval).                                                                                                                                                                                                                                                          | Approved facts only                                                                                        | Approved facts + up to 8 unreviewed document chunks               | `config/src/domains.ts:849`                                                                                                                                                                                                                                                                                              |
| Q15 | ~~Link tracking** (public redirect endpoint)~~ **DECIDED: deferred** to its own phase with a security/privacy review.                                                                                                                                                                                                                                                                                                          | Yes, "Source: BrandSpace"                                                                                  | Not built; new public surface                                     | —                                                                                                                                                                                                                                                                                                                        |
| Q16 | ~~Password reset** lands on workspace list~~ **DECIDED: keep the repo.** After a password reset the user signs in again.                                                                                                                                                                                                                                                                                                       | Yes                                                                                                        | Back to sign-in                                                   | security decision                                                                                                                                                                                                                                                                                                        |
| Q17 | ~~Plan names~~ **DECIDED:** the prototype uses the repo's plan names (Starter / Growth / Scale / Enterprise). Workspace allowance per plan is a new quota (placeholder values in the prototype: Starter 1 · Growth 2 · Scale 5 · Enterprise 20; trial 1).                                                                                                                                                                      | Starter / Growth / Pro                                                                                     | Starter / Growth / Scale / Enterprise                             | `docs/PRODUCT.md:515` — prototype should adopt repo names                                                                                                                                                                                                                                                                |

---

## 1. Bugs found during the comparison (fix regardless of the prototype)

| Bug                                                | Where                                                                                                              | Effect                                                        | Fix                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| B-1 Storage counted per upload in whole GB         | `packages/assets/src/upload.ts` `#consumeStorage` (`Math.max(1, Math.ceil(bytes / BYTES_PER_GB))`)                 | Every file costs ≥ 1 GB; five 1 MB photos exhaust a 5 GB plan | Meter bytes (new byte counter or `SUM(byteSize)`), compare to the GB limit; recompute existing counters     |
| B-2 Published posts are editable                   | `packages/content/src/library.ts` `editVariant` (no status guard); `draft-editor.tsx` read-only only by permission | Content of a published post can change after the fact         | Throw `contentNotEditable` for `PUBLISHING/PUBLISHED/PARTIALLY_PUBLISHED`; composer read-only + "Duplicate" |
| B-3 Editing a post in review keeps the review open | `revokeApprovalOnEdit` handles only `APPROVED` and `SCHEDULED`                                                     | Reviewer approves text that changed under them                | In the same transaction: `ContentApprovalService.cancel()` → `CANCELLED`, item → `DRAFT`, notify reviewer   |
| B-4 Reschedule has no slot-status guard            | `packages/content/src/calendar.ts` `reschedule()`                                                                  | A publishing/published slot could be moved                    | Allow only `PLANNED`/`SCHEDULED`                                                                            |
| B-5 Owner can change their own role                | `packages/auth` memberships `changeRole` / `changeBrandAccess`                                                     | Self-demotion/escalation paths                                | Refuse when actor user id = member user id                                                                  |
| B-6 Schedule link shown without permission         | `content-library.tsx` Schedule link not gated on `can.schedule`                                                    | Dead end (server refuses)                                     | Gate the link                                                                                               |
| B-7 Restore permission mismatch                    | UI shows restore for `can.submit`, server checks `content.edit`                                                    | Inconsistent                                                  | Use `content.archive` for archive + restore                                                                 |
| B-8 Brand Brain uploads not counted in storage     | `packages/brand-brain/src/ingestion.ts`                                                                            | Unmetered storage                                             | Charge the same storage quota                                                                               |
| B-9 Disconnect is one click                        | `integrations-view.tsx:297`                                                                                        | Accidental disconnects                                        | Two-step confirm                                                                                            |
| B-10 Buying credits has no in-app confirm          | `billing/actions.tsx` `BuyPackButton`                                                                              | Accidental purchases                                          | Confirmation step (credits, price)                                                                          |

### Phase 1 progress

- **B-1 fixed.** The `limit.storage_gb` counter carries the exact byte total in `usage_counter.usedBytes` (BIGINT), and upload admission compares only those bytes against `storage_gb × BYTES_PER_GB` in one conditional `INSERT … ON CONFLICT DO UPDATE … WHERE` (`UsageService.consumeBytes`); refunds (duplicate, unused declaration, expired session, purge) give back exact bytes (`refundBytes`). `usedValue` on that row is derived — the total's gigabytes rounded up once — and is used for display and reporting only. `BYTES_PER_GB` keeps its value (1024³) and is now defined once in `@brandspace/entitlements`. **Deployment:** the migration `20260925120000_storage_bytes_meter` adds the columns and backfills every workspace from its stored files in one transaction, so no existing workspace starts at 0 bytes; no ordering step is needed. `pnpm storage:recompute` (dry run by default, `--apply` to write, `--workspace <id>` for one) is the follow-up check. **Asset versions (completed in B-1):** `AssetVersionService` now requires the byte meter and charges every new version's exact bytes the same way, reserving before the object is written under a per-attempt key, persisting in one tenant-scoped savepoint, and compensating (object delete + exact refund) when the savepoint does not commit; restores charge nothing; purge refunds each distinct object once. Derivatives stay outside the quota.
- **B-2 fixed.** `editVariant` and the studio's AI tools refuse (`CONFLICT`) while a post is `PUBLISHING`, `PUBLISHED` or `PARTIALLY_PUBLISHED` (`READ_ONLY_CONTENT_STATUSES`); the AI tools refuse before the model is called, so no credit is spent. The composer opens such a post read-only with a note and **Duplicate** (for members with `content.create`).
- **B-3 fixed.** Any edit to a post `IN_REVIEW` (manual or AI) runs `ContentApprovalService.withdrawForEdit` in the edit's own transaction: the open cycle becomes `CANCELLED` under the same row lock `decide()` takes, the post returns to `DRAFT`, `content.review_cancelled` is audited with reason `edited_during_review`, and the reviewers who were asked get the new `approval.withdrawn_after_edit` notification (ar/en). `CHANGES_REQUESTED` is unchanged. The composer warns before such an edit.
- **B-4 fixed.** `ContentCalendarService.reschedule` moves only `PLANNED`/`SCHEDULED` slots (`RESCHEDULABLE_SLOT_STATUSES`), with the status in the update's `WHERE` so a slot the publisher claims mid-request is not moved; others get `CONFLICT` and nothing changes. The calendar drawer hides the reschedule form for such slots.
- **B-5 fixed.** `MembershipService.changeRole` and `changeBrandAccess` refuse (`FORBIDDEN`) when the actor is the member being changed, before anything else is checked or written. The team screen no longer offers role or brand-access controls on the reader's own row (desktop and phone). Existing isolation tests that used a self-change to reach another rule now reach it through a different person; each rule's assertion is unchanged.
- **B-6 fixed.** The Content Library shows **Schedule** only to members holding `content.schedule`, the permission every calendar action requires.
- **B-7 fixed.** `ContentLibraryService.transition` now takes the actor's permissions and decides from the item's real status: archiving and restoring out of `ARCHIVED` need `content.archive`; returning a `CHANGES_REQUESTED` post to draft stays `content.edit`. The composer's **Restore** button is gated on `content.archive` (it was `content.submit`).
- **B-8 fixed.** `BrandIngestionService.upload` charges the document's exact bytes to the same `limit.storage_gb` byte meter as the asset library (`consumeBytes`), after every byte-free refusal and before anything is stored, keyed per workspace and upload so a retry is charged once; at the limit it refuses with the library's storage message and stores nothing. It refuses to upload without the meter wired in. Migration `20260925130000_storage_bytes_brand_sources` recomputes every counter from assets, pending uploads and live source documents in one transaction (documents uploaded earlier were never charged); `pnpm storage:recompute` measures the same. There is no source-document delete path yet; when one is added it must refund with `refundBytes`.
- **B-9 fixed.** **Disconnect** on Connected accounts is two steps: the first click opens an explanation (what happens to scheduled posts) and a separate danger button submits, using the no-JavaScript `<details>` pattern the automations screen already uses for delete. `disconnectAccountAction` refuses any post without the confirming field before anything is sent.
- **B-10 fixed.** **Buy** on a credit pack opens a confirmation (`packages/ui` `Dialog`) stating the pack's credits and its server-resolved price; only **Continue to payment** requests a checkout, and Cancel is first so a stray Enter cannot buy. Still only the pack key is sent. The Phase 9 commerce E2E spec clicks through the confirmation.

---

## 2. Status by area

### A. Workspaces, plans, roles, permissions, settings

| Id  | Decision                                              | Status              | Main gap                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Several workspaces, switcher with role · plan         | CONFLICTS (D-302)   | Add plan to `listWorkspaces` (`packages/auth/src/customer-session.ts`); sidebar placement needs Q2                                                                                                                                             |
| A2  | Only owners create workspaces, limited by plan        | MISSING             | `PlanQuotas.workspaces` + `limit.workspaces`; count owned, non-deleted workspaces in `WorkspaceOnboardingService.create`; "New workspace" entry for existing owners (`onboarding/workspace/page.tsx:41–48` currently redirects them); needs Q1 |
| A3  | Brands per workspace by plan                          | PARTIAL             | Server quota exists (`server/brand-creation.ts`); add Settings → Brands list with "+ Add brand" (`brand.manage`), upgrade message instead of generic `QUOTA_EXCEEDED`                                                                          |
| A4  | Roles, overrides, brand access, keys                  | PARTIAL             | All roles + keys exist (owner key is `workspace_owner`; prototype `member.manage` = `member.invite/remove/assign_role` + `workspace.update`); overrides need `MembershipPermissionOverride` (Q4)                                               |
| A5  | Hidden nav, no-access, "Ask <owner>" messages, search | PARTIAL             | Nav + Create + Copilot gating exist; shared denial message using `perms.desc.*` and `Workspace.ownerUserId`; no-access (Q5); search (Q6); hide credits without `copilot.use`                                                                   |
| A6  | Role-specific Home                                    | PARTIAL             | Choose Home sections by permissions: review queue / my drafts · sent · my scheduled (filter `createdByUserId`) / top posts                                                                                                                     |
| A7  | Owner "View as"                                       | MISSING + CONFLICTS | Only as read-only preview if Q3 approved                                                                                                                                                                                                       |
| A8  | Settings tabs gated; role-change rules                | PARTIAL             | Add Approvals, AI, Notifications, Publishing-defaults tabs; workspace deletion flow (`workspace.delete`, confirm, waiting period, audit); B-5                                                                                                  |
| A9  | Draft→Save settings; General fields                   | PARTIAL             | `Workspace.industry/city/websiteUrl/weekStartsOn`; searchable country + time zone from `packages/shared/src/geography.ts`; calendar honours week start; shared sticky save bar                                                                 |
| A10 | Settings that change behaviour                        | MISSING (mostly)    | `NotificationPreference` applied in `notifications/src/recipients.ts`; UI for `Workspace.arabicDialect` (D-115); `suggestionsEnabled`, `hashtagsInFirstComment`, `linkTrackingEnabled`, `defaultChannels`, `defaultPostTime`                   |
| A11 | Connections                                           | PARTIAL             | Q9; B-9; refuse scheduling to `REVOKED` channels                                                                                                                                                                                               |
| A12 | Credits never negative; purchase confirm              | EXISTS (mostly)     | B-10                                                                                                                                                                                                                                           |

### B. Content lifecycle

| Id  | Decision                                             | Status                      | Main gap                                                                                                                                                                       |
| --- | ---------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | One post store                                       | PARTIAL (richer on purpose) | Keep `ContentStatus` (10 states); map in UI: review = IN_REVIEW/CHANGES_REQUESTED/APPROVED, sched = SCHEDULED/PUBLISHING, pub = PUBLISHED/PARTIALLY_PUBLISHED; add slides (B9) |
| B2  | Author kept; defaults on new posts                   | PARTIAL                     | `ContentTemplate` (+ `isDefault`) and `PublishingDefaults`; apply in `createManualItem`/`generate`; composer prefill                                                           |
| B3  | Editing rules                                        | PARTIAL                     | B-2, B-3; Q8; "no past scheduling" EXISTS (`#resolveInstant`)                                                                                                                  |
| B4  | Sending rules & default reviewer                     | PARTIAL                     | Submit-only already forced to review; default reviewer (Q10) in `approvals.ts submit()`; `eligibleReviewers` must include override-granted approvers (after Q4)                |
| B5  | Approvals page per person; note required for changes | PARTIAL                     | Tabs "For me"/"Sent" (default Sent without `content.approve`); `noteRequired` on REQUEST_CHANGES (server + client). Banner + author notification EXIST (D-288)                 |
| B6  | Per-recipient notifications                          | EXISTS                      | —                                                                                                                                                                              |
| B7  | Calendar drag/move/new-on-day/past days              | PARTIAL                     | Drag scheduled slots → `reschedule` same HH:mm; disable past-day drops; "new post" on empty future days (`packages/ui/src/calendar.tsx`); B-4                                  |
| B8  | Posts "…" menu                                       | PARTIAL                     | Library card menu: move, unschedule, archive (two-step), restore, campaign (Q11), view on channel (`PublishJob.externalPostUrl`); B-6, B-7. Retry gating EXISTS                |
| B9  | Studio                                               | PARTIAL                     | `ContentVariant.slides Json` (or `ContentSlide`); templates; inline date/time; reviewer `<select>` fed by `eligibleReviewers` (server already accepts `assignedToUserId`)      |
| B10 | Performance                                          | PARTIAL                     | Metric support + "—" + CSV EXIST (D-146); PDF export; link tracking (Q15)                                                                                                      |
| B11 | Campaign results                                     | PARTIAL                     | Period = campaign dates (not last 30 days), add clicks, best campaign, "ends in N days", start-early moves `startDate` to today, "No results yet"                              |
| B12 | Automations                                          | EXISTS                      | Edit form for an existing rule (`updateRule` without `enabled`)                                                                                                                |
| B13 | Notes                                                | EXISTS                      | Threads must attach to an entity (no free-standing threads) — prototype OK                                                                                                     |
| B14 | Copilot                                              | PARTIAL                     | Read-only `approvals.summary` tool (`content.read`, brand scope)                                                                                                               |

### C. Brand Brain, strategy, onboarding, media, shell

| Id  | Decision                                         | Status                | Main gap                                                                                                                                                                                                                                |
| --- | ------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Brand Brain areas, states, versions, bulk accept | PARTIAL               | `acceptConfidentCandidatesAction` + `BrandKnowledgeService.reviewCandidates()` (one transaction, skip conflicts, threshold in config, `brand_brain.review`)                                                                             |
| C2  | Brand chat                                       | PARTIAL               | Real grounded LLM already (keep it); add correction intent → "Replace" card → `updateKnowledgeAction`; "Save as fact" → `createKnowledgeAction`; Q14                                                                                    |
| C3  | Uploads / website / sources / gaps               | PARTIAL               | Website ingestion with SSRF-safe fetcher (security review); approved-fact counts per source; gaps EXIST                                                                                                                                 |
| C4  | Identity editing                                 | PARTIAL               | Swatch editor; voice words (pick one source of truth: TONE_OF_VOICE area recommended); logo replace-by-upload                                                                                                                           |
| C5  | Strategy                                         | PARTIAL — largest gap | Relational `Strategy`, `StrategyPillar`, `StrategyKpi`, `StrategyTopic` (FK to `ContentItem`), `ContentItem.pillarId` (SetNull), `StrategyReview @@unique(strategyId, periodKey)` + idempotent gateway call; backfill from Insight JSON |
| C6  | Onboarding wizard                                | PARTIAL               | Industry list + "Something else"; `Workspace.teamSize`; ≥1 language client-side; custom goal (HUMAN strategy item); Ready ideas → compose/creative prefilled; Q7, Q16. Terms, goal→objective, sign-up locale EXIST                      |
| C7  | Media & storage                                  | PARTIAL               | B-1, B-8; breakdown by kind/source; "latest N of M files"                                                                                                                                                                               |
| C8  | Shell                                            | PARTIAL               | Rail, i18n parity EXIST; search (Q6); shared popover manager (one open at a time); toast host replacing `?ok=` banners                                                                                                                  |

---

## 3. Suggested implementation order (for Claude Code)

Work on this branch, one commit per item, tests with each, PR into `staging` only.

**Phase 1 — bugs, no product decision needed**
B-1 (with counter recompute script) · B-2 · B-3 · B-4 · B-5 · B-6 · B-7 · B-8 · B-9 · B-10.

**Phase 2 — agreed features, no conflict**
A3 Brands list + upgrade message · A5 shared denial message ("Ask <owner>") · A6 permission-based Home sections · A8 missing Settings tabs + workspace deletion flow · A9 General fields + week start + sticky save bar · A10 notification preferences + AI language UI + suggestions / first-comment hashtags / posting defaults · B5 tabs + required note · B7 calendar drag & past days · B8 library menu · B9 slides, templates, inline schedule, reviewer select · B11 campaign period & counters · B12 rule edit · B14 approvals tool · C1 bulk accept · C2 correction + save-as-fact · C3 approved counts per source · C4 identity editor · C6 industry list, team size, custom goal, Ready ideas · C7 breakdown · C8 popover manager + toasts.

**Phase 3 — decided features that need bigger changes (Section 0 is answered; deferred items: A4 overrides, C8/Q6 search, B10/Q15 link tracking)**
A1/A2 (Q1, Q2) · A4 overrides (Q4) · A5 no-access page (Q5) · A7 view-as (Q3) · B3 scheduled-edit rule (Q8) · B4 default reviewer (Q10) · B8 campaign permission (Q11) · A11 expired connection (Q9) · B10 link tracking (Q15) · C3 website reading (security review) · C5 strategy data model (migration) · C6 time zone from country (Q7), password-reset landing (Q16) · C8 search (Q6) · A6 client viewer (Q12) · A8 billing visibility (Q13) · C2 grounding (Q14).

Every change must keep: RLS and brand scope, audit events, `ar` + `en` message parity (`tests/unit/dashboard-i18n-parity.test.ts`), and the production safety checks.

## 4. Phone layout (prototype v81, artboard 3 · `Mobile.dc.html`)

The phone artboard now runs the **same logic as desktop** (same post store, roles, permissions, workspaces, plans, view-as, settings). Only the layout changes. Compare the repo's mobile shell (< 768px) against these rules; do this **after Phase 1 is merged**.

| #   | Rule                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | **Bottom tab bar (5):** Home · Calendar · **+ Create** (only with `content.create`; current while in Studio) · Approvals with pending badge (without approvals access → Posts; without Posts → Performance) · Menu.                                                                                        |
| M2  | **Top bar:** menu · workspace name + page title (tap = workspace sheet) · search · bell with unread count.                                                                                                                                                                                                 |
| M3  | **Drawer:** workspace card (role · plan) · the same nav groups as the desktop sidebar, filtered by permissions · badges (approvals pending = amber, publishing failed = red, notes unread) · Copilot with credits (only `copilot.use`) · "View as" (owner only) · footer: user, language switch, sign out. |
| M4  | **Workspace sheet:** list with role · plan and a check on the current one · usage `n/limit` hidden when the plan allows 1 · "New workspace" only for the owner and below the limit; at the limit it shows the usage and opens upgrade. Switching closes the drawer and sheets.                             |
| M5  | **Overlays:** notifications, Copilot and workspace are bottom sheets; search is full screen. Only one overlay open at a time (opening one closes the others).                                                                                                                                              |
| M6  | **Homes and access:** the same role homes as desktop (A6), the same "No access to this page" (A5) and the view-as banner at the top (A7).                                                                                                                                                                  |
| M7  | **Calendar = agenda list** on phone. Drag and drop is desktop-only; the note says to move a post from its menu.                                                                                                                                                                                            |
| M8  | **Studio:** topic, channels, caption with AI (`copilot.use`), rewrite tools, **When** picker (best time / pick date+time / right after approval, with suggested slots), **Reviewer** picker, pre-send reason line, the same send rules as desktop (B4).                                                    |
| M9  | **Approvals:** "Waiting for me / Sent by me" tabs, the note field, Approve · Request changes (note required) · Reject.                                                                                                                                                                                     |
| M10 | **Media:** Library/Generate tabs, storage card (used / plan quota, breakdown bar), filters, generate panel with format and credits.                                                                                                                                                                        |
| M11 | **Settings:** section chips with the same gating as desktop (A8) and a sticky "unsaved changes" bar with Cancel/Save.                                                                                                                                                                                      |
| M12 | Touch targets ≥ 44px, `ar` RTL throughout, no hover-only actions.                                                                                                                                                                                                                                          |

---

## 5. Prototype v90: what changed since v76

**Compared on:** `feat/prototype-v76-alignment` @ `0029ee8` (after Phase 1), 2026-09-25.
**Prototype:** BrandSpace design canvas v90 (`Main.dc.html`, `Auth.dc.html`).

The ids D1–H2 are prototype items; their short text is in Appendix B. They are not repo decisions, which are always written with a hyphen (`D-28`).

**No sample data.** The prototype's demo workspace ("Reema Café") exists only to demonstrate the design. The real product must never seed sample content into a customer workspace; every page needs a designed empty state instead (G9). The comparison found no seeding in the repo. The analytics mock adapter outside production is tagged `MOCK` and stays.

### 5.0 Owner decisions (answered 2026-09-25)

Each answer becomes a new `D-` entry in `docs/DECISIONS.md` when it is implemented.

| #   | Question                                                                | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q18 | Which permission guards actions that spend credits?                     | Keep the per-feature keys, and **also** require `copilot.use` on every action that spends credits. Members without `copilot.use` don't see credit-spending buttons or the credit balance.                                                                                                                                                                                                                                                                                       |
| Q19 | Brand Brain completeness vs the repo's "no score" rule (`minimumItems`) | Show a list of **key questions per area**, as "answered n of m". There is no percentage and no overall score, so the no-score rule is kept. The questions live in config; Offers questions depend on the industry (food, fashion, beauty, services). "What's missing" lists the top unanswered questions.                                                                                                                                                                       |
| Q20 | Grounding for writing, not only for chat                                | Extends Q14 to all AI writing: captions, strategy, Copilot and Brand Brain chat use only **approved, non-expired facts**. Uploaded documents and websites are sources that propose pending facts; their raw chunks are never retrieved into prompts. This is what makes "Used N facts" and "Fix it" accurate.                                                                                                                                                                   |
| Q21 | Attaching a campaign to an existing post                                | Clarifies Q11. Attaching a campaign to a post that has none needs `content.create`, the same as choosing one at creation. Moving a post to another campaign, or removing its campaign, needs `campaigns.manage`. The same rule applies in the Posts menu and in the Studio.                                                                                                                                                                                                     |
| Q22 | What happens to scheduled posts when the workspace time zone changes    | They keep their **local clock time** (09:00 stays 09:00): each future `PLANNED`/`SCHEDULED` slot is re-computed in the new zone in one transaction. Slots that are `PUBLISHING` or later are untouched. The settings warning says so, and the change is an audit event (Security → Activity).                                                                                                                                                                                   |
| Q23 | Two-step verification details                                           | Authenticator app (TOTP) only, no SMS. **10** backup codes (the repo's number; the prototype was changed to match). Setup uses a QR code or a typed key, then a 6-digit check, then the codes are shown. Turning it off needs the **password or a current code**. "New phone" re-enrols and needs a current code. The owner can require it for the workspace: members without it are asked to enrol at their next sign-in, and while it is required a member can't turn it off. |
| Q3  | View as (re-confirmed)                                                  | Implement Q3 on the **support-mode pattern**: a read-only permission preview. There is no session switch; every change action is refused with "Preview only"; the start of each preview is audited. It is offered only for members who have joined, not pending invites. This is not the impersonation D-28 forbids.                                                                                                                                                            |

### 5.1 Status by item

These statuses come from the v90 comparison. Claude Code re-checks every row in its report before writing any code.

| Id  | Item                                                                                                                                                                               | Status                 | Main gap / links to §2 and §0                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Brand Brain tabs: Knowledge · Look & voice · Sources, and a separate chat tab; area "Identity" renamed "About the business"                                                        | PARTIAL                | Tabs and labels; a single Voice card (voice words, Tone facts, Do/Don't rules). Links to C4.                                                                                                                                                                                                     |
| D2  | Four font slots, plus uploaded fonts                                                                                                                                               | PARTIAL                | Heading and body per language; uploads go through the asset pipeline and the storage quota (TTF/OTF/WOFF/WOFF2, 5 MB, up to 4 per language); templates use them.                                                                                                                                 |
| D3  | Key questions per area                                                                                                                                                             | MISSING                | Q19.                                                                                                                                                                                                                                                                                             |
| D4  | One review inbox, confidence labels, conflicts shown side by side, bulk accept with a preview                                                                                      | MISSING                | Links to C1 (`reviewCandidates`).                                                                                                                                                                                                                                                                |
| D5  | Sources: real uploads, editable website, counts per source, remove with keep or drop                                                                                               | PARTIAL                | Website source (**migration**, SSRF-safe fetch, security review as in C3); approved and pending counts per source.                                                                                                                                                                               |
| D6  | "Valid until" on facts; expired facts excluded from writing and chat; "Used in N posts"                                                                                            | MISSING                | `validUntil` (**migration**). It is separate from the repo's STALE state, which means "review due".                                                                                                                                                                                              |
| D7  | Brand Brain chat modes: Ask / Add / Edit / Remove, plus handoff to Copilot                                                                                                         | MISSING                | Links to C2 (correction and save-as-fact). Changes made in the chat update the area cards immediately.                                                                                                                                                                                           |
| D8  | Copilot answers from the same facts, names what is missing, never saves facts itself                                                                                               | PARTIAL                | Q20.                                                                                                                                                                                                                                                                                             |
| D9  | Writing uses Brand Brain; "Used N facts" in the Studio; the Settings → AI "Use Brand Brain" toggle really turns it off                                                             | PARTIAL                | Q20; record which facts each variant used.                                                                                                                                                                                                                                                       |
| D10 | A fact used in a caption changed or expired: rewrite or keep, and "Needs you" on Home                                                                                              | MISSING                | Depends on D6 and D9.                                                                                                                                                                                                                                                                            |
| D11 | Performance insight → "Save as learning" (pending fact)                                                                                                                            | MISSING                | —                                                                                                                                                                                                                                                                                                |
| D12 | Home lines: facts waiting for review; "Brand Brain is missing: …"                                                                                                                  | MISSING                | Depends on D3 and D4.                                                                                                                                                                                                                                                                            |
| D13 | The Strategy "Brand Brain changed" alert fires only when approved facts change                                                                                                     | MISSING                | A signature of approved facts and their versions; **migration** if it is stored.                                                                                                                                                                                                                 |
| E1  | View as                                                                                                                                                                            | MISSING                | Q3, as re-confirmed above; A7.                                                                                                                                                                                                                                                                   |
| E2  | "No access" also for non-owners and when a page is reached from search                                                                                                             | PARTIAL                | Q5 (known routes only; otherwise 404).                                                                                                                                                                                                                                                           |
| E3  | Permission per action (duplicate, sources, look, review, credits, pause, strategy, report, connections)                                                                            | PARTIAL                | Mostly enforced on the server; Q18 for credits.                                                                                                                                                                                                                                                  |
| E4  | New permission `templates.manage` (owner, admin, marketing manager, designer)                                                                                                      | MISSING                | New key and role grants (**migration** if roles are seeded); links to B2.                                                                                                                                                                                                                        |
| E5  | Changing a post's campaign                                                                                                                                                         | CONFLICT → decided     | Q21. `setContentCampaign` also needs the editable-status and withdraw checks (F1).                                                                                                                                                                                                               |
| E6  | Denial messages ("… doesn't have the “X” permission … ask <owner>"; owner-only wording)                                                                                            | MISSING                | A5.                                                                                                                                                                                                                                                                                              |
| E7  | The client viewer's Home "feedback" links to the calendar                                                                                                                          | MISSING                | Q12.                                                                                                                                                                                                                                                                                             |
| F1  | Any edit to a post in review pulls it back to draft (channels, date, format, tags, slides, design, campaign); "Make a new copy" opens the copy                                     | PARTIAL                | Extend B-3 to every edit path, including `setContentCampaign`.                                                                                                                                                                                                                                   |
| F2  | No scheduling in the past; new posts default to tomorrow; best-time on today moves to tomorrow 09:00                                                                               | PARTIAL                | Server check exists (`#resolveInstant`); UI defaults and messages.                                                                                                                                                                                                                               |
| F3  | A simulated approval never acts as the current user                                                                                                                                | EXISTS                 | —                                                                                                                                                                                                                                                                                                |
| F4  | Strategy topic status comes from the real post                                                                                                                                     | MISSING                | Depends on C5 (`StrategyTopic` → `ContentItem`).                                                                                                                                                                                                                                                 |
| F5  | Performance and Home count published posts from the same live list                                                                                                                 | PARTIAL                | Archived posts are still counted.                                                                                                                                                                                                                                                                |
| F6  | The automations log is recorded history                                                                                                                                            | EXISTS                 | —                                                                                                                                                                                                                                                                                                |
| G1  | Settings save bar on every draftable tab                                                                                                                                           | MISSING                | A9 (sticky save bar).                                                                                                                                                                                                                                                                            |
| G2  | Notification preferences per person                                                                                                                                                | MISSING                | A10 (`NotificationPreference` per member, **migration**).                                                                                                                                                                                                                                        |
| G3  | The AI writing language follows the UI language; the wizard's posting languages set it                                                                                             | PARTIAL                | A10; G8.                                                                                                                                                                                                                                                                                         |
| G4  | Two-step verification                                                                                                                                                              | PARTIAL                | Q23: QR image, "New phone", turning off with password or code, owner requirement.                                                                                                                                                                                                                |
| G5  | Time-zone change keeps the local clock time; the change is audited                                                                                                                 | CONFLICT → decided     | Q22.                                                                                                                                                                                                                                                                                             |
| G6  | Country sets time zone, holidays and best times; industry sets Offers questions and observances; "affects" notes; ★ holiday chips                                                  | MISSING                | Q7 (country only preselects the time zone); holiday and observance data per country and industry.                                                                                                                                                                                                |
| G7  | Workspace allowance from the owner's plan                                                                                                                                          | MISSING                | A1/A2, Q1.                                                                                                                                                                                                                                                                                       |
| G8  | Wizard: required names, terms unticked, editable sign-up, handoff of facts (origin "Setup"), accounts, languages, goal, city                                                       | PARTIAL                | Needs a "Setup" fact origin and an AI-language field; links to C6.                                                                                                                                                                                                                               |
| G9  | Designed empty state on every page                                                                                                                                                 | PARTIAL                | Copy and calls to action.                                                                                                                                                                                                                                                                        |
| G10 | Getting-started checklist built from real state, filtered by permissions                                                                                                           | PARTIAL                | —                                                                                                                                                                                                                                                                                                |
| G11 | First-run tour, shown once per person                                                                                                                                              | MISSING                | Per-user flags (tour done, checklist hidden, hints seen) stored per user, not per device (**migration**).                                                                                                                                                                                        |
| G12 | First-visit hints on Brand Brain and Strategy                                                                                                                                      | MISSING                | Uses the G11 flags.                                                                                                                                                                                                                                                                              |
| G13 | Automations v2: each event offers only its own conditions (with values) and actions; personal alerts move to Settings → Notifications; asks-first actions become approval requests | PARTIAL                | B12 engine exists; add per-event condition/action lists, values (channel, campaign, format, person), a monthly cap for credit actions (Q18), approval requests with Approve / Skip on Home that lapse after 24 h (**migration**), and drop rules whose trigger or action moved to Notifications. |
| H1  | Official platform marks                                                                                                                                                            | EXISTS except LinkedIn | The owner supplies LinkedIn's official SVG for `PLATFORM_MARK_PATHS` (`packages/ui/src/platform-icons.tsx`). Never draw it by hand.                                                                                                                                                              |
| H2  | Phone layout                                                                                                                                                                       | See §4                 | M1–M12. The phone prototype is updated to v90 separately.                                                                                                                                                                                                                                        |

### 5.2 Migrations this needs

These are migration **files only**. Claude Code never applies them to staging or production.

- D5: website source.
- D6: `validUntil` on facts.
- D9: which facts each variant used.
- D13: the approved-facts signature, if it is stored.
- E4: `templates.manage`.
- G2: per-member notification preferences.
- G8: the "Setup" fact origin and the AI language.
- G11: per-user first-run flags.
- G13: rule condition/action values and caps; automation approval requests.

§2 already lists the models for C5 (strategy) and B9 (slides and templates).

### 5.3 Implementation order

This replaces §3 Phase 2 and Phase 3 for everything not built yet. Each part is:

- its own branch from `staging`, merged into `staging` through its own PR;
- report first, with no code until the owner approves the report;
- one commit per item, with tests.

**Phase 2A: permissions and the post lifecycle**

- A5 + E6 denial messages; E2/Q5 no-access page.
- E3 + Q18.
- A6 role homes + E7/Q12.
- B3/Q8; F1; F2; F5.
- B4/Q10; B5.
- B7 calendar; B8 menu + Q21.

**Phase 2B: settings, workspaces, onboarding**

- A1/A2/G7 (Q1, Q2); A3 hidden while Q2b is off.
- A8 tabs, workspace deletion and billing visibility (Q13).
- A9 + G1; A10 + G2 + G3; A11/Q9.
- G4/Q23; G5/Q22; G6/Q7.
- G8 + C6 + Q16.
- E4 + B2 templates; B9 studio.
- B11; B12 + G13 automations; B14; C7.
- C8 popovers and toasts.

**Phase 2C: Brand Brain v2**

- C1–C4 + D1–D13.
- Q14 / Q19 / Q20.
- Website reading (C3, D5) after its security review.

**Phase 2D: empty workspaces and the first run**

- G9–G12.

**Phase 2E: phone**

- §4 M1–M12, after the desktop parts it depends on.

**Phase 3**

- A7/E1 view-as (Q3).
- C5 strategy data model, then F4.
- Deferred: A4 overrides (Q4), search (Q6), link tracking (Q15).

**Any time:** H1, LinkedIn's official mark, once the owner provides the file.

Every change keeps:

- RLS and brand scope;
- audit events;
- `ar` + `en` parity (`tests/unit/dashboard-i18n-parity.test.ts`);
- the production safety checks.

---

## 6. Prototype v94: Phase 2B-1 (settings, security, workspaces, onboarding)

**Branch:** `feat/prototype-v90-phase-2b1` from `staging` @ `5c8f311` · **PR target:** `staging`, never `main`.

The Phase 2B-1 brief (owner, 2026-09-26) is the source of truth for this phase; the rows below record
what it adds to §5 and how each item was built. Items not listed here are unchanged by this phase.

### 6.1 New in v94

- **UI-1. One global scrollbar style**, in the design system rather than per screen: thin, no arrow
  buttons, a transparent track, a subtle thumb that darkens on hover. Chrome/Edge through the
  `::-webkit-scrollbar` pseudo-elements; Firefox through `scrollbar-width` / `scrollbar-color`.
  Elements that deliberately hide their scrollbar stay hidden. **Built:** `packages/ui/src/tokens.css`
  (tokens `--bs-scrollbar-thumb`, `--bs-scrollbar-thumb-hover`); the sidebar navigation gained the
  demo's `.nav-scroll` hiding rules as `.bs-nav-scroll`; `UI-FIDELITY-CONTRACT.md` §6.3.31.

### 6.2 How Phase 2B-1 was built

- **Q2b (D-327).** `feature.multi_brand` is a Control Center feature registered by nobody in code, so
  it fails closed ("Nobody"). While it is off the server refuses a second brand (`createBrandFor`),
  the member acts on the workspace's oldest brand they may see (no brand selector), and Plan & usage
  hides the brand-limit rows. All multi-brand code is kept. The end-to-end seed turns it on for the one
  multi-brand fixture workspace only.
- **Q1 / A2 / G7 — the allowance (D-326).** Plans gain a `workspaces` quota (Control Center plan
  editor, `null` = unlimited). It is an ACCOUNT allowance read from the plans the owner's workspaces
  are on (`workspaceAllowance` in `@brandspace/entitlements`), not a per-workspace `limit.*`
  entitlement and not a new billing record. `WorkspaceOnboardingService.create` enforces it in one
  transaction, after locking the owner's row; a member who owns no workspace may not create one.
- **Q1 / Q2 — the switcher (D-326).** With one brand in view, the rail card opens every business as
  "role · plan" (current ticked) and, for an owner, "Workspaces: used of allowed" with "+ New
  workspace" below the allowance or an upgrade note at it; nothing on a plan that allows one. The
  new-workspace page admits an owner under the same rule the server enforces.
- **A8 — Settings tabs.** Settings → Approvals (`/settings/approvals`, `approvals.policy.manage`)
  now holds the brand approval rules, through the same action and audit event; the Approvals queue
  links to it. Settings → Notifications and Settings → AI arrive with A10/G2/G3 (item 4 below).
  **Publishing defaults is deferred to Phase 2B-2** (owner, 2026-09-26): its contents — default
  channels and time, hashtags in the first comment, templates — are B2/E4.
- **A8 — workspace deletion (D-328).** Owner only, two confirmations (typed name + password),
  refused while a paid plan still renews; 30-day configurable wait during which the workspace is
  closed to every member (pending screen, API refuses, no credits, nothing publishes), owners can
  cancel, members are told in-app; then a job marks it DELETED. Migration
  `20260928090000_workspace_deletion_request`. **Q13 (billing visibility)** needed no change:
  `billing.read` (Owner, Admin) sees billing read-only, `billing.manage` (Owner) changes it.
- **G6 / Q7 (D-329).** Country preselects its usual time zone (editable). Holidays by country,
  observances by industry and posting times per country are `content.calendar` configuration, empty by
  default; ★ chips on the calendar open the Studio for that day; configured times say "Suggested time",
  never "best time", and measured times win. The industry list is `onboarding.industries` with each
  industry's Offers question set for Brand Brain v2 to read. The Egypt / Saudi Arabia / UAE draft is
  `docs/CALENDAR-OBSERVANCES-DRAFT.md` — UNVERIFIED, NOT ACTIVATED.
- **A9 / G1 — General and the save bar (D-330).** General edits name, language, country, time zone
  (validated), city (Egypt's governorates only; cleared elsewhere) and week start (the calendar
  follows it), each with a line saying what it changes; the sole brand's industry (catalogue + "Something
  else") and website are edited here while multi-brand is off, with `brand.manage`. A sticky save bar —
  "All changes saved" / "Unsaved changes" with Cancel · Save — sits under General and Approvals.
  Migration `20260929090000_workspace_general_fields`.
- **A10 / G2 / G3 — my notifications and the AI language (D-331).** Settings → Notifications (every
  member, their own switches) filters four categories of their bell — approvals, publishing,
  automations, Brand Brain reviews — inside the one notification writer; workspace notices always
  arrive. Settings → AI (`brand.manage`) edits the brand's AI writing language (`Brand.defaultLocale`),
  which a new brand now takes from its creator's interface language (amends D-277). Migration
  `20260930090000_notification_preference`. Suggestions on/off, first-comment hashtags, link tracking
  and default channels/time stay with Publishing defaults in Phase 2B-2.
- **A11 / Q9 — expired connections (D-332).** Expired warns (calendar, and "Expired" in the Studio with
  its explanation on the next line); revoked/disabled blocks, and the server refuses scheduling onto it.
  The hold is real: the expired channel's job waits for the reconnection until the lateness deadline,
  then fails with "reconnect the account", while the other channels publish on time. No migration.
- **G4 / Q23 — two-step verification (D-333).** QR code and typed key drawn on the server (no seed in a
  URL), recovery codes shown once from a short-lived httpOnly cookie, off with a code or the password,
  "New phone" keeping the old phone until the new one proves itself, every proof a counted step-up. The
  Owner can require it (`workspace.security.manage`, Owner only): members without it are sent to set it up,
  the API answers 404, and nobody there can turn theirs off. Migrations
  `20261001090000_workspace_security_manage_permission` (DATA) and `20261002090000_workspace_require_mfa`.

---

## Appendix — prototype decisions (v76)

Short form of each decision (the full prototype lives in the BrandSpace design canvas, v76):

- **A1** Several workspaces per person, different role in each; switcher lists "role · plan"; each workspace keeps its own data.
- **A2** Only an owner creates another workspace, within the plan's workspace limit; new workspace = onboarding → trial.
- **A3** Brands per workspace limited by plan; add-brand blocked at the limit with upgrade message.
- **A4** Nine roles; per-member overrides; per-brand access; keys as in `packages/shared/src/permissions.ts`.
- **A5** Nav hides unusable pages; "no access" screen; "Ask <owner>" denial message; Create/Copilot/credits hidden without permission; ⌘K results filtered by permission.
- **A6** Home by role: full / review queue / my drafts · sent · scheduled / top posts / waiting for feedback.
- **A7** Owner-only "View as" with banner.
- **A8** Settings tabs gated by permission; nobody edits own role; only owner assigns Admin.
- **A9** Draft→Save settings; General: name (propagates), industry (list + free text), country (searchable), time zone (27 zones, warning), city, website, week start (calendar follows).
- **A10** Notification switches filter the bell; AI writing language; suggestions on/off; hashtags in first comment; link tracking on/off; default channels/time.
- **A11** Expired connection warns but allows scheduling; two-step disconnect blocks sending to that channel.
- **A12** Credits never negative; purchase needs `billing.manage` + confirm.
- **B1–B14** One post store; author kept; published read-only; edit in review → draft; no past scheduling; submit-only must review; default reviewer; approvals "For me"/"Sent", note required for changes, feedback shown to author; per-recipient notifications; calendar drag/move; posts menu with permissions; studio (AI by topic + language, slides saved, templates, previews, checks, date/time, reviewer); performance "—" for unsupported metrics, CSV/PDF, link tracking; campaign results from its published posts; automations; notes with mentions; copilot by intent.
- **C1–C8** Brand Brain bulk accept; chat answers from approved facts, proposes corrections, saves new facts; uploads/website produce pending facts; identity editable; strategy with KPI, pillars by identity, channel mix, topics linked to drafts, one review per period; onboarding fields carried into the app; storage breakdown; shell (rail, ⌘K, one popover at a time, glass UI, ar/en).

---

## Appendix B — prototype additions (v90)

Short form of each item compared in §5 (the full prototype lives in the BrandSpace design canvas, v90).

### D. Brand Brain v2

- **D1. Tabs.** There are three tabs: Knowledge · Look & voice · Sources. There is also a separate chat tab, "Talk with the brand".
  - The area "Identity" was renamed "About the business".
  - Look & voice contains: logo, templates, colours, fonts, and one Voice card (voice words + Tone facts + Do/Don't rules, all editable there).
- **D2. Fonts.** There are four font slots: heading and body, in Arabic and in English, each chosen from a list.
  - Uploaded fonts are allowed: TTF/OTF/WOFF/WOFF2, up to 5 MB, max 4 per language. Uploaded fonts can be renamed, have their file replaced, or be removed; removing a font that is in use falls back to the default.
  - Templates render headlines with the heading font and badges with the body font, picked by the text's language.
- **D3. Completeness uses key questions per area, not fact counts** — shown as "answered n of m", with no percentage (Q19).
  - Examples for Offers in food: what you sell / prices / hours & offers.
  - The Offers questions change with the industry: fashion, beauty, services.
  - The hero card "What's missing" lists the top missing questions. Clicking one opens that area with the question as the input placeholder.
- **D4. One review inbox.**
  - Pending facts from all areas are shown one card at a time. Each card shows the snippet from the source, the area, and a confidence label (High ≥85 / Medium 70–84 / Low <70) with an explanation.
  - Actions: Accept / Edit & accept / Reject / Later.
  - When a fact conflicts with an approved one, old and new are shown side by side, and accepting archives the old one.
  - "Accept the confident ones" shows a preview list and needs a confirm.
- **D5. Sources.**
  - Real file upload: PDF, Word, PowerPoint or text, up to 20 MB. Any other file shows a failed row with the reason.
  - Website URL can be edited, with validation, and re-read.
  - Each source shows its approved and pending counts and a list of its facts, and has Read again and Remove. Remove asks whether to keep or drop the facts; dropping archives them.
- **D6. Facts.**
  - Optional "valid until" date. Expired facts are shown dimmed as "Expired · not used in writing", and they are excluded from AI writing and from chat answers.
  - Each fact shows "Used in N posts".
  - Versions and archive work as before.
- **D7. Brand Brain chat.** It has mode buttons: Ask about a fact / Add a new fact / Edit a fact / Remove a fact.
  - **Add:** pick an area. Someone with `brand_brain.review` gets "Add & approve"; others get "Send for review".
  - **Edit:** finds the closest fact (including expired ones) and shows the old one struck through next to the new one.
  - **Remove:** shows up to 3 matching facts. Removing archives the fact and can be undone.
  - **Handoff:** job-like requests ("make 3 posts about…") get a card saying "This is a job for Copilot", listing the facts that will be used, with a button "Send to Copilot". Copilot then opens with the request and builds the plan from it: count, topic, and campaign if one is named.
  - All chat actions update the area cards immediately.
- **D8. Copilot (Q20).**
  - It answers brand questions from the same approved facts and names the area.
  - When a fact is missing, it says so (for example "doesn't have Prices yet (Offers)").
  - When asked to save a fact, it doesn't save it. It redirects to the Brand Brain chat with the fact pre-filled in Add mode.
- **D9. Writing uses Brand Brain.**
  - Captions include a relevant fact (offer or branches) and apply the tone and rules: no hype, no "the best", the emoji rule.
  - The Studio shows "Used N Brand Brain facts" with the list and "Fix it" on each one.
  - The Settings → AI toggle "Use Brand Brain" really turns this off.
- **D10. When a fact used in a caption changes, expires or is removed:**
  - The Studio shows a banner with the old fact → the new one, and two buttons: "Rewrite with the new fact · 1 credit" and "Keep as is".
  - Any scheduled or in-review post whose caption contains an old or expired fact appears in Home "Needs you".
- **D11. Performance.** Insight cards have "Save as learning", which sends a pending fact to Learnings.
- **D12. Home.** Shows "Brand Brain · N facts waiting for your review" and "Brand Brain is missing: <question>".
- **D13. Brand Brain changed alert on Strategy.** It fires only when approved facts actually change: compare a signature of the approved facts and their versions.

### E. Permissions and roles

- **E1. "View as" is strictly read-only.** Any attempt to change data shows "Preview only". View-as is only offered for members who have joined, not pending invites.
- **E2. Permission checks apply to every non-owner signed-in person**, not only to view-as. Hidden pages show "No access" even if reached through search.
- **E3. Permissions needed per action:**
  - duplicate → `content.create`
  - Brand Brain sources → `brand_brain.upload`
  - logo, colours, fonts, voice, add/edit/archive facts → `brand_brain.edit`
  - accept/reject → `brand_brain.review`
  - anything that spends credits → `copilot.use`
  - campaign pause → `campaigns.manage`
  - strategy, including the month plan → `strategy.manage`
  - weekly report → `analytics.export`
  - connect/disconnect → `integrations.manage`
  - **Deviation (owner, Phase 2A approval):** logo, colours and fonts stay on `brand.manage`, so no
    role gains brand-identity rights; only fact archiving moves (from `brand_brain.delete` to
    `brand_brain.edit`). Voice and facts already used `brand_brain.edit`.
- **E4. New permission `templates.manage`.** Given by default to owner, admin, marketing manager and designer. Anyone who can create posts can use templates; saving, deleting or changing the default template needs this permission.
- **E5. Changing a post's campaign follows the same rule in the Posts menu and in the Studio (Q21):** attaching a campaign to a post that has none needs `content.create`; moving it to another campaign or removing it needs `campaigns.manage`.
- **E6. Denial messages.**
  - "<Name> doesn't have the “X” permission. Permissions come from the role · ask <owner> to change your role."
  - Owner-only actions say "… is owner-only".
  - Per-member overrides stay locked (from the role).
- **E7. Client viewer.** The home "feedback" section links to the calendar.

### F. Content lifecycle fixes

- **F1.** Any edit to a post in review pulls it back to draft and cancels the approval request. This covers channels, date, format, tags, headline, slides, design and campaign, not only the caption. Published posts are fully read-only, and "Make a new copy" opens the copy.
- **F2.** No scheduling in the past, including earlier today; compare date and time.
  - New posts default to tomorrow.
  - Best-time on today moves to tomorrow 09:00.
  - Moving a post onto a past day in the calendar shows a message.
- **F3.** The simulated approval must not act as the current user.
- **F4.** Strategy topic status is derived from the real post (idea/draft/in review/scheduled/published).
  - "Draft the ideas" links each draft to its topic and adds a caption.
  - A Story topic opens as Story.
- **F5.** Performance and Home count published posts from the same live list, so archived posts are excluded from both.
- **F6.** The automations activity log is recorded history: turning a rule off or changing a post doesn't rewrite it.

### G. Settings, workspaces, onboarding

- **G1. Settings Save.** Every draftable section (General, Approvals, Publishing defaults, Notifications, AI) has a visible bottom bar.
  - When there are no changes: "All changes saved" with Save disabled.
  - When there are changes: "unsaved changes" with Cancel/Save.
- **G2.** Notification preferences are per person.
- **G3.** The default AI writing language follows the UI language; the wizard's posting languages set it.
- **G4. Two-step verification (Q23).** Authenticator app (TOTP) plus 10 backup codes; there is no SMS.
  - Turning it on: scan a QR code or type the key, then verify a 6-digit code, then see the backup codes.
  - "New phone" moves it to another device.
  - Turning it off needs the password or a current code.
  - The owner can require it for the team; once required, it can't be turned off.
- **G5. Time zone.** Scheduled posts keep their local clock time after a change, and the warning says so. The time-zone change and the default-template change are written to the Security → Activity log.
- **G6. Country and industry.**
  - Country sets the time zone, the calendar holidays and the best posting times (the Gulf uses 10:00/16:00/21:00).
  - Industry changes the Brand Brain Offers questions and adds industry observances to the calendar.
  - Settings shows under each field what it affects.
  - Calendar holidays show as a ★ chip, and clicking one opens the Studio for that day.
- **G7. Workspaces.**
  - The allowance comes from the owner's account plan (Growth = 2), not from the trial plan of a new workspace.
  - The Auth workspace list respects the limit ("Create workspace · 1/2", or an upgrade note).
  - Created workspaces persist with their settings (industry, country, time zone).
  - The multi-brand flag is off, so "Brands they work on" is hidden.
- **G8. Wizard.**
  - Business and brand name are required. Terms start unticked. Sign-up fields are editable, with email and 12-character password checks. The reset password must match.
  - A new workspace from inside the app starts blank, with a Back button.
  - The handoff to the app carries:
    - the facts accepted in the wizard, which go to Brand Brain with the source "Setup"
    - the accounts that were not connected (shown as not connected)
    - the posting languages, which set the AI language
    - the goal key (translated in the app, and it also updates the Brand Brain Strategy fact)
    - the city, which is emptied when the country is not Egypt
  - Area names match Brand Brain.
- **G9. Empty workspaces (the real product has no sample data).** Every page has a designed empty state:
  - Strategy: "No strategy yet", "Build a 90-day plan · 3 credits".
  - Performance: "Your numbers will show up here", "Connect accounts".
  - Notes, Media library and Campaigns each have one line explaining the page and the next action.
  - Home performance: "no numbers yet".
- **G10. Getting-started checklist on Home**, built from real state.
  - Steps: Brand profile ✓ / Connect accounts / Teach Brand Brain (n/10) / First post / Schedule or send for review / Invite team.
  - Only the steps the person's permissions allow are shown.
  - It has "Not needed" and hides itself when complete.
  - It also appears on the role homes.
- **G11. First-run tour.** Four bubbles: menu, Create, Brand Brain, Copilot.
  - Shown once per person, on an empty workspace, with Next and Skip.
  - Can be run again from the user menu with "Take the tour".
  - Not shown in view-as.
  - The per-person flags (tour done, checklist hidden, hints seen) are stored per user, not per device.
- **G12. First-visit hints** appear only on Brand Brain and Strategy, in empty workspaces, and can be dismissed.

- **G13. Automations v2.**
  - Events: a post is approved / published / fails to publish / waits for review over 24 h; a campaign starts / ends; weekly engagement drops 20%; nothing is scheduled for the next 3 days; a post lands in the top 10%; an account connection expires within 7 days; a Brand Brain fact expires within 7 days.
  - Each event offers only the conditions (channel, campaign, format, each with a value) and actions that make sense for it.
  - Actions: schedule in the next free slot (posts without a time), notify a chosen person, add to a campaign, remind the reviewer, draft 3 ideas (credits, a monthly cap of 2/4/8, needs `copilot.use`), make a draft copy, try publishing once more (asks first, `publishing.manage`), pause the campaign (asks first, `campaigns.manage`, needs a campaign condition).
  - Personal alerts (failed posts, approvals, credits, Brand Brain reviews) live only in Settings → Notifications; the old "notify me / email me", credits and new-fact rules are removed.
  - Asks-first actions create a request shown on Home "Needs you" and at the top of Automations to people holding the permission, with Approve / Skip; unanswered requests lapse after 24 hours and nothing runs. The activity log records waiting / approved by / skipped by.

### H. Assets

- **H1. Platform icons** must use the official brand files. LinkedIn stays without a mark until the official SVG from LinkedIn's brand page is added to `PLATFORM_MARK_PATHS` (see the comment in `packages/ui/src/platform-icons.tsx`).
- **H2. Phone layout rules M1–M12** are in §4. The phone prototype will be updated to v90 separately.
