# BrandSpace Design System

> **الملخص التنفيذي بالعربية**
>
> هذه الوثيقة تصف نظام تصميم براندسبيس: الرموز (الألوان، الخطوط، المسافات، الزوايا، الظلال، حلقة التركيز، نقاط الكسر، الحركة)،
> والمكوّنات المشتركة، وسلوك الشريط الجانبي، وقواعد الاستجابة، وقواعد العربية RTL والإنجليزية LTR،
> وعقد معاينة المنشور الاجتماعي، وعقد واجهة مساعد الذكاء الاصطناعي، ومتطلبات الوصولية.
>
> **القاعدة الأهم:** كل لون وكل مقاس يُقرَّر في `packages/ui/src/tokens.ts` فقط. لا يُكتب أي لون مباشرةً داخل صفحة أو مكوّن،
> ويوجد اختبار يفشل إذا حدث ذلك.

**Phase 2C-A, revised.** This document describes the visual foundation. It is the contract the
remaining screens are migrated onto in Phase 2C-B.

**The revision inverted the hierarchy.** The first draft separated a section from the page with a
visible border on a white card sitting on a white ground — which made the border the only thing doing
the work, and made the product read as a traditional outlined admin console. It now separates by
_surface, spacing, shape and shadow_: the canvas stays white, supporting surfaces (lavender, warm
grey, off-white) carry the structure, controls are filled rather than outlined, and a border is a
hairline of last resort. See D-54 and D-55 in `docs/DECISIONS.md`.

---

## 1. Where a decision lives

| Decision                                                 | File                                      |
| -------------------------------------------------------- | ----------------------------------------- |
| Every colour, size, radius, shadow, duration, z-index    | `packages/ui/src/tokens.ts`               |
| The CSS mirror of those values, plus global rules        | `packages/ui/src/tokens.css`              |
| Icons                                                    | `packages/ui/src/icons.tsx`               |
| Controls (button, input, field)                          | `packages/ui/src/primitives.tsx`          |
| Cards, headers, grids                                    | `packages/ui/src/surfaces.tsx`            |
| Tables, badges, search, pagination, breadcrumbs          | `packages/ui/src/data.tsx`                |
| Banners, toasts, empty/error/forbidden states, skeletons | `packages/ui/src/feedback.tsx`            |
| Tooltip, menu, dialog, confirmation, tabs                | `packages/ui/src/overlays.tsx`            |
| The application shell (sidebar, drawer, header)          | `packages/ui/src/app-shell.tsx`           |
| Workspace/language switchers, Support Mode banner        | `packages/ui/src/switchers.tsx`           |
| Social post preview                                      | `packages/ui/src/social-post-preview.tsx` |
| Contextual AI Copilot shell                              | `packages/ui/src/copilot-shell.tsx`       |
| Deterministic brand artwork, avatars, media overlays     | `packages/ui/src/media.tsx`               |
| Feature cards and their entitlement states               | `packages/ui/src/feature-card.tsx`        |
| Post cards: grid, list row, calendar chip                | `packages/ui/src/post-card.tsx`           |
| Content calendar (month, week, agenda)                   | `packages/ui/src/calendar.tsx`            |
| Post composer (editor, preview, Copilot slot)            | `packages/ui/src/composer.tsx`            |
| Design Studio (toolbar, rail, artboard, properties)      | `packages/ui/src/design-studio.tsx`       |

**Applications compose; they do not decide.** `tests/unit/design-system.test.ts` scans every file in
`apps/*/src` and fails on a hex colour literal outside a comment. That rule is CLAUDE.md §4 made
enforceable: before this phase, seven semantic tints were hard-coded across three files and the two
consoles had already drifted apart.

### The client/server boundary

`packages/ui` contains both server-renderable and `'use client'` modules. **A pure function must never
be exported from a `'use client'` module**: React treats every export of a client module as a client
reference, so a server component calling it fails at runtime with _"Attempted to call X() from the
server"_. This is why `menuItemStyle` lives in `menu-style.ts`, the social-preview types and
`PLATFORM_ASPECTS` in `social-post-types.ts`, the Copilot's surface vocabulary in `copilot-types.ts`,
and the Studio's `PRESET_SIZES` in `studio-presets.ts` — each beside, not inside, its component.

**This is now enforced (F-25 closed).** `tests/unit/design-system.test.ts` reads the first line of
every module in `packages/ui/src` and, for each `'use client'` module, fails if it exports anything
but a PascalCase component, a `use…` hook, or a type. Types are erased at compile time and cost
nothing; a `const` table or a lowercase helper is a client reference and belongs in a neutral module.

For the same reason, **a component prop may never be a function** when it crosses from a server page
into a client component. The shell takes serialisable nav items — an href, a label, an icon _element_
(elements do cross the boundary) — and renders `next/link` itself.

---

## 2. Colour

**Approved brand colours** — purple `#7935FE` primary, yellow `#FFDD15` accent, white ground (D-42, D-49).

| Use                                    | Token                                                           | Rule                                                        |
| -------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| Primary action, active nav, focus ring | `brandPurple`, `focusRing`                                      | 5.60:1 on white — safe as text AND as a filled surface      |
| Hover / pressed                        | `brandPurpleHover`, `brandPurplePressed`                        | Pressed is also the text colour on the purple tint          |
| Selected surface                       | `brandPurpleTint` + `brandPurpleBorder`                         | Carries `textPrimary` and `brandPurplePressed`              |
| Accent, highlight, badge               | `brandYellow`, `brandYellowTint`                                | **Never** body text; **never** white text on it             |
| Yellow as text                         | `brandYellowText`                                               | 5.52:1 on white; the only permitted yellow-toned text       |
| Page ground                            | `appBackground` = white                                         | Never tinted. The canvas is the quiet part (D-49)           |
| Supporting surfaces                    | `surfaceSoft`, `surfaceWarm`, `surfaceLavender`, `surfaceMuted` | These carry structure, not borders (D-54)                   |
| Control fill                           | `controlSurface` + `.bs-control`                                | A control is identified by its FILL, never by an outline    |
| Accent, highlight, badge               | `brandYellow`, `brandYellowTint`                                | **Never** body text; **never** white text on it             |
| Yellow as text                         | `brandYellowText`                                               | 5.52:1 on white; the only permitted yellow-toned text       |
| Hairline (last resort)                 | `hairline`, `cardBorder`                                        | Invisible at rest; becomes a real 3:1 edge in high contrast |
| High-contrast boundary                 | `controlBorderContrast`, `borderStrong`                         | 3.4:1 — restored by `prefers-contrast: more` (D-55)         |

### How hierarchy is made, now that borders do not make it

The revision's rule, in order of preference:

1. **Surface.** A section sits on `surfaceSoft`, `surfaceWarm` or `surfaceLavender`; the page stays
   white. This is the primary separator.
2. **Space.** Generous, consistent padding and gaps. Two things are different because they are apart,
   not because a line runs between them.
3. **Type.** Scale and weight, from the table above. A card's title is a title because it is bigger.
4. **Shape.** 12–14px on controls, 16–20px on cards. A rounded filled rectangle reads as a control.
5. **Shadow.** Two very soft layers, no visible edge. A card lifts; it is not framed.
6. **Icon tiles and selective accent.** A soft tinted square behind a glyph; yellow used once in a
   view, never as a surface behind text.

**A hairline is permitted only where structure would otherwise be ambiguous** — a table's header
underline, a row separator — and it is `hairline` (`#F0F1F4`), which is deliberately invisible at rest.

### The accessibility tension, and how it is resolved (D-55)

WCAG 1.4.11 asks for a 3:1 boundary on a user-interface component. A soft `#F4F4F7` fill on white is
1.06:1, and **no** soft fill can reach 3:1 — so a borderless control cannot satisfy 1.4.11 through its
resting fill, and pretending otherwise would be dishonest. The system therefore:

- gives every control an **always-visible label** (never a placeholder standing in for one), so the
  control is identifiable without relying on its edge;
- gives every control a **5.6:1 focus ring** on `:focus-visible`, satisfying 2.4.11;
- gives an **error or success tone a real 3:1 border**, so a state is never fill-only;
- **restores full boundaries under `prefers-contrast: more`** and under `forced-colors: active`, where
  `--bs-control-border`, `--bs-hairline` and `--bs-card-border` are redefined to the contrast tokens.

This is the escape hatch the brief's own §4 sanctions ("a very soft neutral border may be used where
necessary for accessibility"), used deliberately rather than as a default.

**A text token is only as safe as the ground it was measured on.** `textMuted` clears AA on white and
on the pale surfaces and fails on `surfaceLavenderStrong` and `surfaceSunken`; `textSecondary` clears
every surface in the palette. The rule is _muted for the page ground and the pale surfaces, secondary
for a stronger tint_, and `tests/unit/contrast.test.ts` asserts the whole matrix rather than the single
white pairing the first draft checked.

**A container `opacity` is never a way to make something quieter.** It blends every descendant toward
the page and silently drops their contrast: `opacity: 0.85` on a feature card took its state badge from
`#175CD3` to an effective `#3a74da` and 4.2:1 — an AA failure with no colour changed anywhere in the
source. Quieting is done with a softer surface and a muted-but-measured text colour instead.

**Accessibility is part of the token, not a review step.** Every pairing above is asserted in
`tests/unit/contrast.test.ts` against WCAG 2.2 AA. Writing those assertions found two real failures
that had already shipped into this phase's first draft: `borderStrong` at `#98A2B3` scored 2.58:1 as a
control boundary, and `danger` at `#D92D20` scored 4.44:1 against its own tint — a banner whose text
was the one part of it that failed. Both were darkened.

The tests also assert what a colour must **not** do, because a token that quietly becomes legible is a
token somebody starts using as text: the identity blue and the accent yellow are asserted to _fail_ as
text on white.

---

## 3. Typography

Arabic **Cairo**, Latin **Inter**, selected by `html[dir]` in `tokens.css`.

The webfonts are **optional at runtime and never a build dependency**. `next/font/google` downloads
faces at build time and fails the build when it cannot reach the host, which would make every build —
in CI and offline alike — depend on a third party. That is F-06 in a new costume. Instead
`webfontHref()` emits a stylesheet link only when `BRANDSPACE_WEBFONTS=google`, and every stack ends in
system faces that ship with the operating system, so both scripts render correctly with no network.

| Step       | Size      | Use                                   |
| ---------- | --------- | ------------------------------------- |
| `display`  | 1.875rem  | Marketing-scale headline              |
| `h1`       | 1.5rem    | Page title — exactly one per page     |
| `h2`       | 1.125rem  | Card and section title                |
| `h3`       | 1rem      | Subsection, record title              |
| `body`     | 0.9375rem | Default                               |
| `bodySm`   | 0.875rem  | Dense surfaces: tables, forms, cards  |
| `label`    | 0.8125rem | Form labels, table headers, key names |
| `caption`  | 0.75rem   | Hints, metadata, badges               |
| `overline` | 0.6875rem | Sidebar section headings              |
| `numeric`  | 1.5rem    | Metric-card figures                   |

Before this phase these were literals scattered across a dozen files (`1.35rem`, `1.05rem`,
`0.6875rem`…), which is why two pages that both meant "section heading" rendered at different sizes.

---

## 4. The application shell

One implementation, used by both the Customer Dashboard and the Control Center.

### Desktop sidebar (≥ 768px)

- **Expanded** (`17rem`): icon plus text label, grouped under section headings, with the workspace
  identity above and the signed-in profile below.
- **Collapsed** (`4.5rem`): icon only, with an accessible tooltip on hover **and on keyboard focus**
  (WCAG 1.4.13). The link keeps `aria-label`, so it still has a name — without it axe reports
  `link-name` and a screen-reader user hears "link" five times.
- **Active item** is a soft filled lavender **pill** — not a row with a box drawn around it — carrying
  a purple icon and label, a small yellow accent mark _inside_ the pill, and `aria-current="page"`.
  Three signals, never colour alone.
- **Collapse state** is a per-browser display preference in `localStorage`. It is never sent to the
  server, enters no cookie, and no route, permission or query depends on it — so it cannot affect
  authentication or authorization, and a tampered value can at worst give somebody a narrow sidebar.
  It is read _after_ mount, never during render, so the server and the first client paint agree.

### Mobile (< 768px)

A drawer opened from the header — **not the desktop sidebar made narrow**. A 4rem icon rail on a 390px
screen permanently costs a sixth of the viewport and has nowhere to put a tooltip. The drawer is a real
modal: `aria-modal`, focus moved in, focus **trapped**, Escape closes, and focus **returned to the
trigger** so a keyboard user is not dumped at the top of the document. It closes on navigation and
keeps the selected workspace.

**The breakpoint is decided in CSS, not JavaScript** (`.bs-sidebar` / `.bs-drawer-trigger`). A layout
that depends on a measured viewport flickers on first paint and differs between server and client.

### Header

Brand · workspace switcher · language switcher · sign out. It **wraps**: at 390px those cannot share a
row, and a non-wrapping header pushed the page sideways. The workspace switcher is
`max-inline-size: 100%` with `min-inline-size: 0` because its content is `white-space: nowrap` and
would otherwise take its max-content width. The role name is hidden below `md` — it duplicates what the
Roles & permissions page states in full.

### Support Mode

A persistent, sticky, full-width yellow band with near-black ink — the one place a yellow surface is
correct, and it still never carries white text. The copy says in plain words that the reader is
**platform staff and not the customer** (D-28). A support session must never look like a normal
customer session, which is why this is a band across the top rather than a discreet chip.

---

## 5. Responsive rules

Verified at **390, 768, 1280 and 1440** in both directions.

- **Never scroll the page sideways.** Wide content scrolls inside its own box
  (`scrollContainerStyle()`), which is also focusable so it can be scrolled by keyboard (WCAG 2.1.1).
- **A grid item's default `min-width: auto` floors it at min-content.** `Stack` uses
  `grid-template-columns: minmax(0, 1fr)` and `cardStyle()` sets `min-inline-size: 0`. Without both, a
  card containing a table with a `min-inline-size` grows to that table's minimum and pushes the page
  sideways — 204px at 768px in the first draft, 244px again in the revision when the sidebar widened.
  It is the same bug twice, which is why the floor now lives in the card rather than in each caller.
- **Tables have a phone shape.** `DataTable` on `≥ md`, `RecordList` below it — the same rows as
  labelled cards, so column headings become visible labels instead of disappearing off the side. Both
  are in the DOM; exactly one is displayed, so a screen reader reads the data once.
- **Overflow is measured by finding the element**, not by comparing `scrollWidth` to `clientWidth`.
  That proxy fails in both directions: it counts content parked at negative offsets — Next.js puts its
  route announcer at `left: -10px`, so it reported a 10px overflow on pages with nothing overflowing —
  and it is **blind to the direction that matters in Arabic**, where content pushed past the left edge
  produces a negative offset rather than a larger scroll width. `tests/e2e/overflow.ts` walks the DOM,
  skips anything already clipped by a scrolling ancestor, and names the offending element. All four
  suites now use it (F-26 closed).

---

## 6. Arabic RTL and English LTR

- **Direction is a routing property**, not a stored preference: `dir` and `lang` derive from the URL
  segment, so both directions are reachable from one session.
- **Every layout property is logical** — `padding-inline`, `margin-block`, `border-inline-start`,
  `inset-inline-start`. `tests/unit/design-system.test.ts` fails the build on `marginLeft`,
  `paddingRight`, `textAlign: 'left'` and their kin anywhere in the design system.
- **Icons that indicate direction are logical too.** `ChevronStartIcon` points toward the inline start,
  so pagination and the collapse control read correctly in Arabic without a second icon.
- **Arrow keys follow the inline axis.** In the tab list, `ArrowRight` moves toward the start of the
  list in RTL, which is what a reader of Arabic expects.
- **Content direction is independent of interface direction.** A social post caption carries its own
  `dir`, because an Arabic caption previewed in an English interface must still read right-to-left or
  the preview misrepresents what will be published.

---

## 7. The social post preview contract

`SocialPostPreview` is a **visual contract for later phases**, not a connection to anything. No
persistence, no OAuth, no platform API, no publish button, and it never fetches remote media.

| Supported       | Values                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platforms       | Instagram, Facebook, LinkedIn, X, TikTok                                                                                                                                  |
| **Formats**     | `feed`, `story`, `reel`, `video` — **per platform**, from `PLATFORM_FORMATS`                                                                                              |
| Aspect ratios   | `1:1`, `4:5`, `16:9`, `9:16` — **per platform**, from `PLATFORM_ASPECTS`; a format may force one                                                                          |
| Media states    | image, carousel with indicator, video with play affordance and duration, loading, missing                                                                                 |
| Post states     | `DRAFT`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `FAILED`                                                                                                                 |
| Approval states | `NOT_REQUIRED`, `NEEDS_APPROVAL`, `APPROVED`, `CHANGES_REQUESTED` — independent of publishing state                                                                       |
| Also            | account identity and avatar, hashtags, caption truncation and expansion, a familiar action strip, scheduled time, mobile and desktop surfaces, Arabic and English content |

**Format is modelled separately from platform, and that is the point of the revision.** An Instagram
feed post, a Story and a Reel are three different compositions with different chrome, aspect ratios and
action strips. The first draft modelled only the platform, which is precisely why every preview looked
like the same card with a different badge. A Story now renders with a progress bar, overlaid identity
and a gradient scrim; a Reel with a trailing action column; a feed post with the caption below.

**The option lists are derived from the platform.** Choosing TikTok drops a landscape selection and
every non-video format, rather than offering a combination the platform will not accept.

**Media is deterministic brand artwork, never an empty grey box.** `AbstractMedia` composes a gradient
and a few shapes from one of six palettes derived from the brand purple and yellow, selected by a seed.
It fetches nothing, renders identically on every run — so a screenshot means the same thing twice — and
a preview with no media says "No media yet" on a lavender surface rather than showing a grey rectangle
that reads as a broken image.

The chrome is deliberately BrandSpace-shaped: a platform is identified by its name and a small accent
badge, and the frame is our own. Reproducing a platform's interface pixel-for-pixel is both a trademark
problem and a maintenance treadmill.

---

## 8. The contextual AI Copilot shell contract

A right-side docked panel on desktop (`role="complementary"` — a region, not a modal, so the page
behind it stays reachable) and a full-height modal sheet on a phone. It also embeds inline: the
composer and the Design Studio each take it as a slot.

**It is contextual, not a floating chatbot.** `CopilotContext` names the surface it is docked to
(`calendar`, `posts`, `composer`, `studio`) and the subject it is attached to, and the header states
both. `SURFACE_ACTIONS` in `copilot-types.ts` decides which suggested actions each surface offers, so a
design canvas never offers to suggest a posting time and a calendar never offers to resize a design.
Offering an action a surface cannot serve is the same failure as a button that does nothing.

It renders:

- a conversation with the **author distinguished by side, fill and avatar together**, so the
  distinction survives greyscale (1.4.1);
- **tool cards** — what a run did or would do, as an operation with a status, rather than prose in a
  chat bubble;
- **suggestion chips** drawn from the surface's action set;
- an attachment area and a modern composer;
- a **credit indication only where a real balance can be read** — the field is optional and the
  showcase passes nothing, because §2.2 forbids inventing an allowance;
- designed states for **streaming, error, insufficient credits and approval-required**.

**Two properties that the AI phase must not soften:**

1. **The composer is inert and says so.** No provider is connected and no credit is spent. A prompt box
   that looked live but did nothing would be exactly the "button that claims an unsupported action"
   this phase forbids, so it is disabled and carries a visible explanation.
2. **A mutating action is gated, and previewed before it is gated.** CLAUDE.md §2.5 lets the Copilot
   _propose_ and _preview_ a high-impact action but never execute one silently. A proposed action
   renders as a description, a **before/after preview of the exact text that would change**, a
   statement in words that it changes data, and an explicit approve/reject pair — and this shell offers
   no code path that performs anything. A person approving a change needs to see the change, not a
   summary of it. When a provider is wired in, the confirmation is already the only door.

In production navigation the Copilot stays behind the existing feature-flag and entitlement mechanism
until the AI phase. It appears in the isolated showcase for visual review.

---

## 9. Accessibility requirements

Target **WCAG 2.2 AA**. CI fails on serious and critical axe violations (F-04a).

- **Focus is always visible.** One `:focus-visible` rule in `tokens.css`, in the application primary so
  it reads on white, on a muted inset and on the purple tint. A unit test fails the build if
  `outline: none` appears in the stylesheet.
- **Colour is never the only signal** (WCAG 1.4.1): a status badge carries the status _word_, the
  active nav item carries `aria-current`, an invalid field carries an announced error.
- **Every overlay owes four things**: Escape closes, focus moves in, focus is trapped, focus returns to
  the trigger. One hook (`useOverlayBehaviour`) implements all four for the drawer, the dialog and the
  menu, so the three cannot drift apart.
- **An icon-only control names itself.** Icons are `aria-hidden` by default; `IconButton` requires a
  `label`.
- **A scrollable region is keyboard-reachable** (WCAG 2.1.1) — tables and the Copilot conversation log.
- **Pointer targets are at least 24×24** (WCAG 2.2 §2.5.8).
- **`prefers-reduced-motion` is honoured once, globally**, so no component has to remember.
- **Exactly one `h1` per page**, owned by the shell in the customer application and by the page in the
  console.
- **A control is always labelled in words.** A placeholder is never a substitute for a label — and in a
  borderless system it is the label, not the edge, that tells a reader there is a field there at all.
- **ARIA roles bring their required structure with them.** A `role="grid"` may only contain
  `role="row"`, so the calendar's CSS grid wraps each week in a row with `display: contents` rather
  than parenting `gridcell`s directly. Skipping that produced `aria-required-children` and
  `aria-required-parent` on the first draft of the calendar.
- **`aria-controls` must point at something that exists.** A tab strip used as a filter still needs a
  panel per tab, which is why the posts library renders a real `TabPanel` for every status and filters
  the records rather than leaving the reference dangling.
- **Decorative artwork carries no `img` role.** `AbstractMedia` with an empty `alt` is `aria-hidden`
  instead: a `role="img"` with an empty label is a thing a screen reader stops on and announces as
  nothing.
- **No container `opacity` as a styling device** — see §2. It is a contrast failure that leaves no
  trace in the source.

---

## 10. The design showcase

`/{locale}/design-system` in the dashboard: a gallery of every component, state, preview and Copilot
state — **and the five prototype screens**: the features hub, the content calendar, the posts library,
the post composer and the Design Studio.

**The prototype screens live here and only here.** They show flows the backend cannot yet perform, so
they are safe to have exactly while they are unreachable from the product. Each carries a visible
notice that it connects to no database and no platform and that no control on it performs a real
action, and `tests/unit/design-system.test.ts` fails if `ContentCalendar`, `PostComposer`,
`DesignStudio`, `PostGridCard`, `PostListRow` or `FeatureCard` is imported by any file in either
application other than the showcase's own client component.

**Nothing on them is invented.** No plan name, price, quota, credit allowance, usage counter or
analytics figure appears anywhere in the fixtures: every one of those is versioned configuration owned
by Platform Admin (CLAUDE.md §2.2), and a plausible-looking number on a screenshot the owner is asked
to approve would be a lie. Where a screen has a slot for such a figure — the AI-credits metric card,
the library's performance column — it states that the value is unavailable and why.

**It is not part of the product.** It is refused when `APP_ENV` is `production` or `staging`, and
additionally requires `BRANDSPACE_DESIGN_SHOWCASE=1` anywhere else. It reads no database, resolves no
session, takes no parameter that reaches a query, and is linked from no navigation. Every value on it
is a deterministic fixture using reserved `example.test` addresses. The refusal is `notFound()`, so a
probe cannot tell a disabled showcase from a route that was never built.

The gate keys on `APP_ENV`, **not** `NODE_ENV`: `next start` always sets `NODE_ENV=production`, so a
gate keyed on it would be a deletion rather than a gate — the route could never be served from a
production build, including in the end-to-end suite, which is exactly what happened to the first draft.

---

## 11. What remains for Phase 2C-B

Phase 2C-A restyled a representative set of screens as the visual-approval checkpoint. This revision
went further into the two consoles than the first draft, but **the compatibility-layer pages are still
not fully redesigned**, and this document does not claim otherwise.

### What this revision DID reach

- Every token, primitive, surface, table, badge, overlay and shell in `packages/ui`.
- The customer sign-in, password reset, workspace picker and invitation flows (through `AuthCard`).
- Platform Admin's sign-in and MFA challenge, rebuilt from raw markup onto the design system.
- **Every form control in both applications.** Forty-three inputs and selects across the consoles were
  styled with `inputStyle()` but no `bs-control` class, which under the new tokens rendered them as
  transparent rectangles — invisible until focused. All now carry it, and a unit test fails on the next
  one that does not.
- The outlined chrome that remained: the workspace chooser's tiles, the configuration domain chips, the
  secrets notice, the small buttons in both console pages, the environment badge (which keeps its
  outline deliberately — a production warning is not decoration), and the public site's header rule.

### What it did NOT reach

The following pages inherit the new tokens and are now legible and consistent, but their **layouts have
not been reworked**: console configuration, secrets, flags, plans, providers, ai-models, routing, audit,
health and support; customer permissions, plan and settings. They still compose through the
compatibility aliases at the bottom of `apps/dashboard/src/components/workspace-shell.tsx` and
`apps/admin/src/components/console-ui.tsx`.

### Still to do

1. **Migrate those pages** off the compatibility aliases and delete both alias blocks.
2. **Adopt the mobile record-list shape** on the console tables that still render only a wide table.
3. **Toast placement.** `Toast` exists and is reviewed in the showcase, but no page mounts a toast
   region yet — server-action feedback currently uses inline `Banner`, which is correct for a
   redirect-based flow. Decide whether any flow needs a transient message.
4. **Breadcrumbs** are used on the workspace detail page only. Extend to other nested console routes.
5. **Density.** One comfortable density ships. If operators ask for a compact table mode, it belongs in
   tokens, not in a page.
6. **The prototype screens need a backend before they can leave the showcase.** Calendar, library,
   composer and Studio are compositions over fixtures; each control that would mutate anything is
   inert and says so. They move into the product in the phase that gives them something to talk to,
   behind entitlements — not before.
