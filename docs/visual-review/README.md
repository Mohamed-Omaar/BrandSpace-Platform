# Visual review — Phase 2C-A (aligned to the full demo)

Evidence for the visual-direction approval, in two halves:

- **`reference/`** — the DEMO, captured screen by screen from
  `docs/visual-reference/full-demo/`, which is the visual authority (D-60).
  Produced by `tests/e2e/demo-reference.screenshots.spec.ts`.
- **everything else** — the PRODUCT, captured from freshly built applications
  against the throwaway estate `pnpm e2e:seed` creates. Produced by
  `tests/e2e/design-system.screenshots.spec.ts`.

Both halves are captured at 1440×900 in the same browser, so a fidelity review
compares two images rather than an image against a memory of one. Nothing here
is produced by hand.

```
pnpm e2e:build

# the demo half needs the vendored demo served locally; without it that one
# capture skips and the product half still runs
python3 -m http.server 8900 --directory docs/visual-reference/full-demo &

pnpm e2e:screenshots
```

| Product capture                        | Its reference                            |
| -------------------------------------- | ---------------------------------------- |
| `01-customer-dashboard-desktop-en`     | `reference/customer-overview-en`         |
| `02-customer-dashboard-desktop-ar-rtl` | `reference/customer-overview-ar`         |
| `28-calendar-month-desktop`            | `reference/customer-calendar-en`         |
| `31-calendar-month-ar-rtl`             | `reference/customer-calendar-ar`         |
| `32-posts-library-all`                 | `reference/customer-posts-en`            |
| `36-composer-desktop`                  | `reference/customer-composer-en`         |
| `37-composer-ar-rtl`                   | `reference/customer-composer-ar`         |
| `39-design-studio-desktop`             | `reference/customer-studio-en`           |
| `05-customer-team-desktop`             | `reference/customer-team-en`             |
| `60-customer-permissions`              | `reference/customer-roles-en`            |
| `61-customer-plan`                     | `reference/customer-plan-en`             |
| `62-customer-settings`                 | `reference/customer-settings-en`         |
| `09-customer-sign-in-en`               | `reference/customer-customer-signin-en`  |
| `63-customer-workspaces`               | `reference/customer-workspace-picker-en` |
| `14-admin-overview`                    | `reference/admin-admin-overview-en`      |
| `15-admin-workspaces-directory`        | `reference/admin-workspaces-en`          |
| `16-admin-workspace-detail-*`          | `reference/admin-workspace-detail-en`    |
| `53-admin-plans`                       | `reference/admin-plans-en`               |
| `54-admin-providers`                   | `reference/admin-providers-en`           |

Where a product screen has no reference row, the demo has no equivalent screen
(the two mobile breakpoints, the Copilot states, the component gallery) or the
route belongs to a phase the demo draws but this one does not implement.

Nothing in these images is a credential or a customer: the accounts are the disposable
`@brandspace.test` ones the seed generates and discards, and every value on the design showcase is a
deterministic fixture. Animations are frozen for the capture, so two runs of the same screen produce
the same image.

**Long screens are captured in readable sections.** A full-page shot of the showcase is roughly
12,000 pixels tall and illegible once scaled to fit a review window, which makes it useless as
evidence. Those screens are captured as `-top`, `-middle` and `-bottom` slices at 1:1 instead.

**The route sweep (50–63) captures the first viewport, not the whole document.** The stored-secrets
page renders 176 rows against the seeded database, so a full-page shot of it is 42,000 pixels tall —
a grey smear once scaled into a review window, and evidence of nothing. What a reviewer needs from a
route sweep is whether the page reads as the approved direction, and that is decided above the fold.

---

## The captures

### The product, signed in

| #   | File                                   | What it shows                                                   |
| --- | -------------------------------------- | --------------------------------------------------------------- |
| 01  | `01-customer-dashboard-desktop-en`     | Workspace home, 1440px, English                                 |
| 02  | `02-customer-dashboard-desktop-ar-rtl` | The same screen in Arabic, right-to-left                        |
| 03  | `03-customer-dashboard-mobile`         | Workspace home at 390px                                         |
| 04  | `04-customer-mobile-drawer`            | The mobile navigation drawer, open                              |
| 05  | `05-customer-team-desktop`             | The team page as a table                                        |
| 06  | `06-customer-team-mobile-record-list`  | The same rows as labelled cards on a phone                      |
| 07  | `07-sidebar-expanded`                  | Sidebar expanded: sections, workspace identity, profile         |
| 08  | `08-sidebar-collapsed`                 | Sidebar collapsed to icons, with the active pill still readable |

### Signing in

| #   | File                         | What it shows                                                   |
| --- | ---------------------------- | --------------------------------------------------------------- |
| 09  | `09-customer-sign-in-en`     | The split sign-in: brand panel beside a borderless form         |
| 10  | `10-customer-sign-in-ar`     | The same, mirrored                                              |
| 11  | `11-customer-sign-in-mobile` | The phone drops the brand panel; the form is the whole screen   |
| 12  | `12-platform-admin-sign-in`  | Platform Admin's sign-in — deliberately NOT the customer's page |
| 13  | `13-platform-admin-mfa`      | The second factor, a separate screen in a separate realm        |

### Platform Admin

| #   | File                            | What it shows                                |
| --- | ------------------------------- | -------------------------------------------- |
| 14  | `14-admin-overview`             | Control Center overview                      |
| 15  | `15-admin-workspaces-directory` | The workspaces directory                     |
| 16  | `16-admin-workspace-detail-*`   | Workspace detail, in three readable sections |

### The design showcase

| #   | File                      | What it shows                                        |
| --- | ------------------------- | ---------------------------------------------------- |
| 17  | `17-showcase-en-*`        | The whole gallery in English, top / middle / bottom  |
| 18  | `18-showcase-ar-rtl-*`    | The whole gallery in Arabic, top / middle / bottom   |
| 19  | `19-support-mode-banner`  | The Support Mode band                                |
| 20  | `20-buttons-and-controls` | Every button variant, size, loading and icon form    |
| 21  | `21-forms`                | Fields at rest, with a hint, in error and in success |
| 22  | `22-component-states`     | Banners, toast, tabs, empty / error / forbidden      |
| 23  | `23-tables-and-records`   | Table, mobile record list, pagination                |
| 24  | `24-metric-cards`         | Metric cards, including the honest "unavailable"     |
| 25  | `25-social-previews`      | All seven required preview variants in one grid      |

### The prototype screens

Each of these is behind the design-showcase gate, linked from no navigation, and carries a visible
notice that it connects to nothing and performs nothing.

| #   | File                              | What it shows                                                |
| --- | --------------------------------- | ------------------------------------------------------------ |
| 26  | `26-features-hub`                 | Eleven features with their honest entitlement states         |
| 27  | `27-features-hub-mobile`          | The same on a phone                                          |
| 28  | `28-calendar-month-desktop`       | The month grid with real post chips                          |
| 29  | `29-calendar-agenda-desktop`      | The agenda as a first-class desktop view                     |
| 30  | `30-calendar-agenda-mobile`       | A phone gets the agenda, never a squeezed month grid         |
| 31  | `31-calendar-month-ar-rtl`        | The calendar mirrored                                        |
| 32  | `32-posts-library-all`            | Grid and list views, filters, status tabs                    |
| 33  | `33-posts-library-bulk-selection` | The bulk bar, which exists only once something is selected   |
| 34  | `34-posts-library-empty-state`    | A status that genuinely matches nothing                      |
| 35  | `35-posts-library-mobile`         | The library on a phone                                       |
| 36  | `36-composer-desktop`             | Editor, live preview and the contextual Copilot side by side |
| 37  | `37-composer-ar-rtl`              | The composer mirrored                                        |
| 38  | `38-composer-mobile`              | The composer stacked for a phone                             |
| 39  | `39-design-studio-desktop`        | Toolbar, tool rail, a real sample design, properties panel   |
| 40  | `40-design-studio-ar-rtl`         | The Studio mirrored                                          |
| 41  | `41-design-studio-mobile`         | The Studio stacked, with its own notice about the adaptation |

### The contextual Copilot

| #   | File                              | What it shows                                                |
| --- | --------------------------------- | ------------------------------------------------------------ |
| 42  | `42-copilot-composer-context`     | The composer's action set                                    |
| 43  | `43-copilot-studio-context`       | A different surface offering a different set                 |
| 44  | `44-copilot-processing`           | The processing state                                         |
| 45  | `45-copilot-error`                | The error state                                              |
| 46  | `46-copilot-insufficient-credits` | Insufficient credits, stating that nothing was charged       |
| 47  | `47-copilot-approval-preview`     | A proposed action with its before/after preview and its gate |
| 48  | `48-copilot-desktop-panel`        | The docked desktop panel                                     |
| 49  | `49-copilot-mobile-sheet`         | The same panel as a modal sheet on a phone                   |

### Every remaining route (§15)

Round 1 restyled a representative set and said plainly that the rest inherited the tokens without
having their layouts reworked. "Do not finish while some pages still look like the previous outlined
admin console" is a claim that has to be checked rather than repeated, so every remaining route in
both applications is here, captured at 1:1 and reviewed like the others. The sweep is what found the
identity-blue buttons on the two Control Center pages, the three invisible controls on customer
settings, the last hand-rolled `<h1>`, and the sidebar foot obscuring the last navigation item.

| #   | File                      | What it shows                                               |
| --- | ------------------------- | ----------------------------------------------------------- |
| 50  | `50-admin-configuration`  | Configuration management — domain chips, draft form         |
| 51  | `51-admin-secrets`        | Secret management — masked hints only, never a value        |
| 52  | `52-admin-flags`          | Feature flags                                               |
| 53  | `53-admin-plans`          | Plans and entitlements                                      |
| 54  | `54-admin-providers`      | Provider registry                                           |
| 55  | `55-admin-ai-models`      | AI model catalogue                                          |
| 56  | `56-admin-routing`        | Task routing                                                |
| 57  | `57-admin-audit`          | Audit log                                                   |
| 58  | `58-admin-health`         | System health                                               |
| 59  | `59-admin-support`        | Support Mode — the page that still had a raw `<h1>`         |
| 60  | `60-customer-permissions` | Roles and permissions                                       |
| 61  | `61-customer-plan`        | Plan and usage                                              |
| 62  | `62-customer-settings`    | Workspace settings — the three controls that were invisible |
| 63  | `63-customer-workspaces`  | The workspace picker                                        |

---

## What these images deliberately do NOT show

No plan name, price, quota, credit allowance, usage counter or analytics figure appears anywhere.
All of those are versioned configuration owned by Platform Admin (CLAUDE.md §2.2); a plausible-looking
number on a screenshot being submitted for approval would be a lie. Where a screen has a slot for one —
the AI-credits metric card, the library's performance column — it says the value is unavailable and why.

The Overview hero is the sharpest case. The approved reference fills the same composition with "12
scheduled", "03 in review", "28 published across 4 channels", "76% of AI credits, resets in 12 days"
and two posts on a calendar. Every one of those is a measurement of a publishing pipeline that does
not exist in this phase, so none of them is reproduced: each panel says which of three things is true
— here is the real figure, you may not see it, or the capability has not shipped. The hero's two
floating cards are abstract shapes rather than captioned posts for the same reason. A shape cannot
claim a post exists; a caption would.
