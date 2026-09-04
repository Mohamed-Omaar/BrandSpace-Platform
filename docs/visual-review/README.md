# Visual review — Phase 2C-A (revised)

Evidence for the visual-direction approval. Every image here is produced by
`tests/e2e/design-system.screenshots.spec.ts` against **freshly built applications** and the
throwaway estate `pnpm e2e:seed` creates, never by hand:

```
pnpm e2e:build
pnpm e2e:screenshots
```

Nothing in these images is a credential or a customer: the accounts are the disposable
`@brandspace.test` ones the seed generates and discards, and every value on the design showcase is a
deterministic fixture. Animations are frozen for the capture, so two runs of the same screen produce
the same image.

**Long screens are captured in readable sections.** A full-page shot of the showcase is roughly
12,000 pixels tall and illegible once scaled to fit a review window, which makes it useless as
evidence. Those screens are captured as `-top`, `-middle` and `-bottom` slices at 1:1 instead.

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

---

## What these images deliberately do NOT show

No plan name, price, quota, credit allowance, usage counter or analytics figure appears anywhere.
All of those are versioned configuration owned by Platform Admin (CLAUDE.md §2.2); a plausible-looking
number on a screenshot being submitted for approval would be a lie. Where a screen has a slot for one —
the AI-credits metric card, the library's performance column — it says the value is unavailable and why.
