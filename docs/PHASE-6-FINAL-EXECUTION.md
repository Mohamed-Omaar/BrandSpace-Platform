# Phase 6 — Final UX / Product Correction: Execution

> **الملخص بالعربية**
>
> هذا المستند يتتبّع تنفيذ عقد تجربة المستخدم النهائي للمرحلة السادسة (D-277). كل متطلب رئيسي
> يحمل حالة واحدة: **DONE** (تجربة العميل مُسلَّمة فعلًا)، **PARTIAL**، **MISSING**، أو **BLOCKED**.
> وجود الكود وحده لا يعني DONE. العمل على فرع Staging فقط، دون دمج في `main` ودون أي مساس بالإنتاج.

**Branch:** `feat/phase-5-staging-full-e2e` · **Started from:** `4d678af` · **PR #37:** open, draft, NOT MERGED ·
**Production:** untouched.

**Authorities.** Product / UX / IA: `docs/PHASE-6-FINAL-UX-CONTRACT.md` (owner decision D-277).
Visual: the design system (`packages/ui`, `docs/DESIGN-SYSTEM.md`). `docs/UI-FIDELITY-CONTRACT.md` is
superseded for composition on every surface the contract redesigns, and still binding for visual
language, tokens, accessibility, responsive and RTL behaviour.

**Status vocabulary.** DONE — the customer experience the contract describes is delivered and proven.
PARTIAL — part of it is delivered; the gap is named. MISSING — not started or not delivered. BLOCKED —
cannot be delivered from here; the blocker is named. "Code exists" is never DONE.

---

## 1. Requirement matrix

Updated as each workstream lands. The evidence column names the test or screen that proves it.

| §   | Requirement                                          | Status  | Evidence / gap                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3   | Final sidebar IA                                     | DONE    | Sidebar = Home, Brand (titled with the selected brand), Plan, Create, Publish, Improve, Automate, Settings; moved areas reachable from top bar / Settings — `phase6-navigation`, `phase8-navigation` unit; `approvals`, `customer-app` E2E |
| 4   | Global shell / real top bar (P6-16)                  | DONE    | `phase6-topbar.spec.ts`                                                                                                                                                                                                                    |
| 5   | English default customer language                    | DONE    | `CUSTOMER_DEFAULT_LOCALE = en`; 59 action fallbacks; content language = explicit → brand → EN; schema defaults EN (migration) — `phase6-english-default` unit, `customer-app` E2E (locale-less → /en, /ar honoured)                        |
| 6   | First-run Setup Wizard                               | MISSING |                                                                                                                                                                                                                                            |
| 7   | Home / Command Center                                | MISSING |                                                                                                                                                                                                                                            |
| 8   | Four proactive-intelligence types, kept distinct     | MISSING |                                                                                                                                                                                                                                            |
| 9   | Preference learning                                  | MISSING |                                                                                                                                                                                                                                            |
| 10  | Repeated-workflow detection                          | MISSING |                                                                                                                                                                                                                                            |
| 11  | Brand Profile + Brand Kit                            | MISSING |                                                                                                                                                                                                                                            |
| 12  | Living Brand Brain                                   | MISSING |                                                                                                                                                                                                                                            |
| 13  | Strategy / Plan                                      | MISSING |                                                                                                                                                                                                                                            |
| 14  | Campaign Project Room                                | MISSING |                                                                                                                                                                                                                                            |
| 15  | Content Library                                      | MISSING |                                                                                                                                                                                                                                            |
| 16  | Global + Create                                      | PARTIAL | P6-16 menu; wording to align                                                                                                                                                                                                               |
| 17  | Create Post entry (4 paths incl. Repurpose)          | MISSING |                                                                                                                                                                                                                                            |
| 18  | Capability-driven format selection                   | MISSING |                                                                                                                                                                                                                                            |
| 19  | Guided basics                                        | MISSING |                                                                                                                                                                                                                                            |
| 20  | Main composer (context / editor / preview)           | MISSING |                                                                                                                                                                                                                                            |
| 21  | Platform variants + friendly validation              | MISSING |                                                                                                                                                                                                                                            |
| 22  | Live social preview                                  | MISSING |                                                                                                                                                                                                                                            |
| 23  | Carousel                                             | MISSING |                                                                                                                                                                                                                                            |
| 24  | Reel                                                 | MISSING |                                                                                                                                                                                                                                            |
| 25  | Media drawer inside composer                         | MISSING |                                                                                                                                                                                                                                            |
| 26  | Creative Studio + contextual generation              | MISSING |                                                                                                                                                                                                                                            |
| 27  | Post lifecycle clarity + approval-revocation warning | MISSING |                                                                                                                                                                                                                                            |
| 28  | Notes: Asset subject, due, important, typeahead      | MISSING |                                                                                                                                                                                                                                            |
| 29  | Approvals + Notes as one flow                        | MISSING |                                                                                                                                                                                                                                            |
| 30  | Asset Library + rights contract                      | MISSING |                                                                                                                                                                                                                                            |
| 31  | Brand Kit view                                       | MISSING |                                                                                                                                                                                                                                            |
| 32  | Calendar (views, unscheduled tray, drawer)           | MISSING |                                                                                                                                                                                                                                            |
| 33  | Publishing (Queue / Published / Failed / Accounts)   | PARTIAL | `/publishing` Queue / Published / Failed / Accounts with real jobs, retry, cancel, human-started reconnect; notifications deep-link to tabs. Gap: thumbnails, readiness column, post-reconnect "Retry" prompt (C16)                        |
| 34  | Analytics order (What changed first)                 | MISSING |                                                                                                                                                                                                                                            |
| 35  | Intelligence                                         | MISSING |                                                                                                                                                                                                                                            |
| 36  | Learn → Brand Brain loop, visible                    | MISSING |                                                                                                                                                                                                                                            |
| 37  | Global Copilot drawer with context                   | MISSING |                                                                                                                                                                                                                                            |
| 38  | Copilot action UX (preview / result / Undo)          | MISSING |                                                                                                                                                                                                                                            |
| 39  | Automations discovery                                | MISSING |                                                                                                                                                                                                                                            |
| 40  | Notifications dropdown                               | MISSING |                                                                                                                                                                                                                                            |
| 41  | Social / friendly feel                               | MISSING |                                                                                                                                                                                                                                            |
| 42  | Microcopy                                            | MISSING |                                                                                                                                                                                                                                            |
| 43  | Empty states                                         | MISSING |                                                                                                                                                                                                                                            |
| 44  | Settings organisation                                | PARTIAL | Settings holds Workspace, Brand, Connections, Team, Roles & permissions, Security, Data controls, Activity, Plan, Billing in one frame; opens on the first readable section. Gap: Plan and Billing are still two sections (C23)            |
| 45  | Team                                                 | MISSING |                                                                                                                                                                                                                                            |
| 46  | Billing / usage                                      | MISSING |                                                                                                                                                                                                                                            |
| 47  | Activity (global + contextual timelines)             | MISSING |                                                                                                                                                                                                                                            |
| 48  | Mobile                                               | MISSING |                                                                                                                                                                                                                                            |
| 49  | RTL / Arabic                                         | MISSING |                                                                                                                                                                                                                                            |
| 50  | Accessibility                                        | MISSING |                                                                                                                                                                                                                                            |
| 51  | Loading / error / permission states                  | MISSING |                                                                                                                                                                                                                                            |
| 60  | Screenshot review set                                | MISSING |                                                                                                                                                                                                                                            |

## 2. Screen inventory and route map

_Filled as screens are rebuilt._

## 3. Backend reuse map

_Filled as screens are rebuilt: for each screen, the services and routes it reads and writes._

## 4. New schema changes

_None yet._

## 5. Decision log

- **D-277** — this contract is the product / UX / IA authority; the design system stays the visual
  authority; UI-FIDELITY composition rules superseded for redesigned surfaces.

## 6. Deliberate exclusions (contract §52)

AI video generation; voice generation; a graphic-design editor; social listening; sentiment
monitoring; a unified social inbox; ads buying; CRM; real-time co-editing; external/guest approval;
multi-step approval chains; client portal; agency white-label; semantic asset search; arbitrary
automation code/webhooks; global product search.

## 7. Test map

_Filled per workstream._

## 8. Staging acceptance matrix

_Filled at the end: each §55–§60 journey step, how it was proven, and on which build._
