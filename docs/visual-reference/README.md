# The approved visual reference

`full-demo/` holds the **current** authority for BrandSpace's visual direction:
a byte-for-byte snapshot of the full product demo, vendored from

- repository `Mohamed-Omaar/Brandspace-Landing-page`
- commit `10765e8cf4f5b89c91b144863330459611248b16`

and taken from that commit's `demo/` and `brand-brain-preview/` directories.

The upstream repository is **read-only** for this project. Nothing here has
ever been pushed back to it, and nothing should be.

## What was vendored, and its checksums

| File here | Upstream path | SHA-256 |
| --- | --- | --- |
| `full-demo/index.html` | `demo/index.html` | `9e7ce73e89209a799bc2087f59f4c591b712210e0397296959e4b4167a9796a7` |
| `full-demo/styles-1.css` | `demo/styles-1.css` | `9569b83dedbbc3e24edc090397eadd3da03a9a1228ed1e2ea7b62b9cd1174d75` |
| `full-demo/styles-2.css` | `demo/styles-2.css` | `fffa17614b8a01feb8f33bb36211366a5bbe9c1eac007867358a7893af8a66a9` |
| `full-demo/styles-3.css` | `demo/styles-3.css` | `6319a57e97f0c506be1bcdc0cbe7edb3248277243345244f636da5c1d7d228f1` |
| `full-demo/mobile-fix.css` | `demo/mobile-fix.css` | `0f19b04b74b7918e08af15cfdbfd62253f0e9eba2265b15253c715997cc34026` |
| `full-demo/app-1.js` | `demo/app-1.js` | `3e83d59b939e4f5edacf5466c5779fef6141287a5299c5e993bbfeb0266a518d` |
| `full-demo/app-2.js` | `demo/app-2.js` | `669339437605cf3c50fc13c23b10f793d0c4f142d1abd1e89d7c8be98ee7e7fe` |
| `full-demo/app-3.js` | `demo/app-3.js` | `c5bf05a56a9a0c02f8248b414be5cf3b5b320e0f4706046a125cca3c69260152` |
| `full-demo/app-4.js` | `demo/app-4.js` | `e79280a534e86bac860597896304abe59ab4c7cc0a0ab7d3edbfb73f3dc96dcf` |
| `full-demo/brand-brain-preview.index.html` | `brand-brain-preview/index.html` | `6b8ca001ed1227d91ea5ef262a1a4566b00a2202babed88ea1251169d13c662a` (recorded as a FUTURE authority, not implemented) |

Verify at any time with `sha256sum docs/visual-reference/full-demo/*`.

## The superseded reference

`superseded-2026-09-05/` holds the earlier three-file reference (`index.html`,
`styles.css`, `app.js`). It is kept for history and is **no longer the
authority**. Where the two disagree, `full-demo/` wins — including on the four
departures the old README recorded, which were re-derived against the full
demo's own values (see below) rather than carried over.

## The palette this demo defines

Measured from the snapshot itself, not from memory:

| Colour | Occurrences | Role |
| --- | --- | --- |
| Purple `#7935FE` | 4 (the `--purple` root variable) | The single primary action colour |
| Yellow `#FFDD15` | 6 (the `--yellow` root variable) | Accent and highlight only |
| Ink `#111114` and white `#FFF` | 33+ | The interface itself |
| Blue `#00ADEE` | **0, in all ten files** | Not part of this design |

The demo's own `.public-*` marketing screens use the same purple, yellow and white. That is the evidence
behind **D-61**: the brand is purple everywhere, the marketing site included, and `#00ADEE` is retired.

## Rules for this directory

- **Never edited, formatted or linted.** It is excluded from ESLint and from
  Prettier for exactly that reason: a reformatted copy is no longer a copy.
- **Never imported, built or served** by application code. It is documentation.
  (It is served locally on a throwaway static server during a fidelity pass, so
  the demo can be measured in a real browser rather than read off its CSS.)
- **Never a source of truth for behaviour.** The demo is a static prototype:
  its posts are hard-coded objects, its buttons switch a CSS class, and nothing
  in it is connected to a database, a permission or a tenant. Tenant isolation,
  RLS, realm separation, RBAC, MFA, Support Mode, secret handling,
  configuration versioning, audit immutability, entitlement precedence and the
  credit ledger remain the technical source of truth and are untouched by any
  visual pass.
- **Never a licence to invent data.** The demo supplies GEOMETRY. Post counts,
  analytics, credits, pricing, plans, connected accounts, billing and provider
  health are shown only where the workspace really has them, and are otherwise
  an honest empty or unavailable state at the same box count and dimensions.

## Brand Brain

`full-demo/brand-brain-preview.index.html` is recorded here as the **future**
visual authority for the Brand Brain screens. Phase 5 owns that work; nothing
in it is implemented today, and no part of it should be pulled forward without
an approval recorded in `docs/DECISIONS.md`.

## Where the demo is deliberately not followed

Every departure below is either an accessibility requirement, a security or
realm boundary, real application data, or a phase boundary — the only grounds
the brief allows.

| Demo | What ships | Why |
| --- | --- | --- |
| `--muted: #717179` | `textMuted: #6A6A72` | 4.44:1 on the demo's own `--soft` (`#F5F5F6`), where the search placeholder and the draft status pill sit, and 4.29:1 on the lavender the composer's selected account chip uses. Seven steps darker clears 4.5:1 on all thirteen surfaces, floor 4.54:1. |
| `--subtle: #A3A3AA` | `textSubtle: #717178` | 2.36:1 on the sidebar ground. It carries `.nav-group-title`, which is text. |
| `.nav-badge { color: #777 on #eee }` | `textMuted` on `surfaceMuted` | 3.86:1 — below AA for 7px text. |
| `.search-button kbd { color: #999 }` | `#767676` | 2.85:1 on white. |
| `.day.muted > strong { color: #bbb }` | `textMuted` | 1.9:1. Out-of-month days are quieted with the muted text colour, not a washed-out grey. |
| `.auth-stage` orbs showing through | opaque `.auth-stage` wash | With the ambient orbs behind it, the "forgot password" link measured 4.12:1 on a yellow blend (axe `color-contrast`, serious). The demo's stage is opaque; ours now is too. |
| `outline: 3px solid rgba(121,53,254,.32)` | 2px solid `#7935FE` | The demo's ring composites to `#D4BEFF` on white — 1.67:1, far below the 3:1 WCAG 2.4.11 requires. Solid purple is 5.59:1. |
| A permanent 78px icon rail below 900px | an accessible drawer below 768px | A real mobile drawer with focus management, Escape and focus return. A permanent rail on a 390px screen also costs a sixth of the only scarce dimension. |
| Tooltips via `:hover::after` | `role="tooltip"` on hover **and** `:focus-visible` | A CSS pseudo-element cannot be reached by keyboard and is not in the accessibility tree (WCAG 1.4.13). |
| A platform badge and a status row inside the post preview | the same information in the panel around it | The demo's post has neither inside it. The information is real workspace state, so it is moved, not dropped. |
| A grid of media assets in the Studio's asset column | the column, its heading, and an honest empty state | There is no `Media` model and no media library in this phase. The column keeps its width, ground, padding and heading. |
| A settings nav listing sections that do not exist | a settings nav of the real pages this member can open | A row that leads nowhere is a placeholder link. |

The reverse also happened once, and is worth naming: a **brand panel beside the
sign-in form** was added in an earlier round to fill what looked like an empty
half-screen in the superseded reference. The full demo answers that differently
— one `min(420px, 100%)` card centred on the stage, carrying the brand mark, an
overline and a 34px heading — so the panel is gone and the card is the whole
composition. That marketing copy belongs on the public website, which is its
audience.

Accessibility is **not** a reason to change logo size, wordmark gap, sidebar
width, nav-row geometry, heading position, card radius, card layout, Calendar
geometry, Social Preview geometry, Composer column proportions, Studio
proportions or spacing — and none of the rows above does.

## What the demo has that this phase does not

Not deviations — screens and content the demo draws for phases that have not
shipped. Each is absent rather than mocked up, because a screen that looks
finished and does nothing is worse than one that is not there.

| Demo screen | Status here |
| --- | --- |
| Analytics, Reports, AI usage, Content ideas, Campaigns, Media library, Approvals, Social accounts | No route. They belong to Phase 3 and later. |
| Brand kit / Brand Brain | Phase 5. `brand-brain-preview.index.html` is recorded above as its future authority. |
| Billing, Credits, Plans as commercial screens | The plan page shows RESOLVED entitlements and the real credit balance; prices, quotas and trial terms are configuration the owner has not approved. |
| The demo's numbers — 28 published, 76% of credits, 24 workspaces, 186 users, 64% margin, 2.8 GB, "All systems operational" | Never reproduced. Real where the workspace has them, an honest empty or unavailable state otherwise, at the demo's box count and dimensions. |
| A `•••` menu on every directory row | The row's own controls are inline where they exist. The demo's menu opens nothing. |
| The `.public-*` marketing screens | `apps/web` owns those, and this phase did not touch it. |

Two smaller differences remain on screens that DO exist, and both are listed
here rather than fixed:

- **The top bar keeps its icon buttons and the language switcher on a phone.**
  The demo hides them below 640px. The language switcher is the only way to
  change language on a phone, so hiding it would remove a function rather than
  a decoration; the bar wraps to two rows instead.
- **Identity tiles use the seeded brand palette, not the demo's solid ink.**
  The demo has one avatar and never needs to tell two apart; a workspace
  directory has many, and a stable colour per row is what makes a long list
  scannable. Everything else about the tile — its size, radius, gap and
  position — is the demo's.
