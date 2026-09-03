# BrandSpace Design System

> **الملخص التنفيذي بالعربية**
>
> هذه الوثيقة تصف نظام تصميم براندسبيس: الرموز (الألوان، الخطوط، المسافات، الزوايا، الظلال، حلقة التركيز، نقاط الكسر، الحركة)،
> والمكوّنات المشتركة، وسلوك الشريط الجانبي، وقواعد الاستجابة، وقواعد العربية RTL والإنجليزية LTR،
> وعقد معاينة المنشور الاجتماعي، وعقد واجهة مساعد الذكاء الاصطناعي، ومتطلبات الوصولية.
>
> **القاعدة الأهم:** كل لون وكل مقاس يُقرَّر في `packages/ui/src/tokens.ts` فقط. لا يُكتب أي لون مباشرةً داخل صفحة أو مكوّن،
> ويوجد اختبار يفشل إذا حدث ذلك.

**Phase 2C-A.** This document describes the visual foundation. It is the contract the remaining
screens are migrated onto in Phase 2C-B.

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
| AI Copilot shell                                         | `packages/ui/src/copilot-shell.tsx`       |

**Applications compose; they do not decide.** `tests/unit/design-system.test.ts` scans every file in
`apps/*/src` and fails on a hex colour literal outside a comment. That rule is CLAUDE.md §4 made
enforceable: before this phase, seven semantic tints were hard-coded across three files and the two
consoles had already drifted apart.

### The client/server boundary

`packages/ui` contains both server-renderable and `'use client'` modules. **A pure function must never
be exported from a `'use client'` module**: React treats every export of a client module as a client
reference, so a server component calling it fails at runtime with _"Attempted to call X() from the
server"_. This is why `menuItemStyle` lives in `menu-style.ts` and the social-preview types and
`PLATFORM_ASPECTS` live in `social-post-types.ts` rather than beside their components.

For the same reason, **a component prop may never be a function** when it crosses from a server page
into a client component. The shell takes serialisable nav items — an href, a label, an icon _element_
(elements do cross the boundary) — and renders `next/link` itself.

---

## 2. Colour

**Approved brand colours** — purple `#7935FE` primary, yellow `#FFDD15` accent, white ground (D-42, D-49).

| Use                                    | Token                                    | Rule                                                      |
| -------------------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| Primary action, active nav, focus ring | `brandPurple`, `focusRing`               | 5.60:1 on white — safe as text AND as a filled surface    |
| Hover / pressed                        | `brandPurpleHover`, `brandPurplePressed` | Pressed is also the text colour on the purple tint        |
| Selected surface                       | `brandPurpleTint` + `brandPurpleBorder`  | Carries `textPrimary` and `brandPurplePressed`            |
| Accent, highlight, badge               | `brandYellow`, `brandYellowTint`         | **Never** body text; **never** white text on it           |
| Yellow as text                         | `brandYellowText`                        | 5.52:1 on white; the only permitted yellow-toned text     |
| Page ground and cards                  | `appBackground` = `surface` = white      | Separation comes from `cardBorder` plus one shadow (D-49) |
| Control boundary                       | `borderStrong`                           | 3.4:1 — WCAG 1.4.11 requires 3:1 for a UI component edge  |
| Divider, decorative edge               | `border`, `cardBorder`                   | Deliberately below 3:1; never used to outline a control   |

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

- **Expanded** (`16rem`): icon plus text label.
- **Collapsed** (`4rem`): icon only, with an accessible tooltip on hover **and on keyboard focus**
  (WCAG 1.4.13). The link keeps `aria-label`, so it still has a name — without it axe reports
  `link-name` and a screen-reader user hears "link" five times.
- **Active item** carries three signals, never colour alone: a purple tint, a purple label, a yellow
  accent mark on the inline-start edge, plus `aria-current="page"`.
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
- **A grid item's default `min-width: auto` floors it at min-content.** `Stack` therefore uses
  `grid-template-columns: minmax(0, 1fr)`. Without it a card containing a table with a
  `min-inline-size` grew to that table's minimum and pushed the page 204px sideways at 768px.
- **Tables have a phone shape.** `DataTable` on `≥ md`, `RecordList` below it — the same rows as
  labelled cards, so column headings become visible labels instead of disappearing off the side. Both
  are in the DOM; exactly one is displayed, so a screen reader reads the data once.
- **Overflow is measured by finding the element**, not by comparing `scrollWidth` to `clientWidth`.
  That proxy counts content parked at negative offsets — Next.js puts its route announcer at
  `left: -10px` — and reported a 10px overflow on pages with nothing overflowing. The suite walks the
  DOM, skips anything already clipped by a scrolling ancestor, and names the offending element.

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

| Supported     | Values                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Platforms     | Instagram, Facebook, LinkedIn, X, TikTok                                                                                    |
| Aspect ratios | `1:1`, `4:5`, `16:9`, `9:16` — **per platform**, from `PLATFORM_ASPECTS`                                                    |
| Media states  | image, video poster with duration, loading, missing                                                                         |
| Post states   | `DRAFT`, `SCHEDULED`, `PUBLISHED`, `FAILED`                                                                                 |
| Also          | account identity, caption truncation and expansion, scheduled time, mobile and desktop surfaces, Arabic and English content |

**The ratio list is derived from the platform.** Choosing TikTok drops a landscape selection rather
than offering a combination the platform will not accept.

The chrome is deliberately BrandSpace-shaped: a platform is identified by its name and a 3px accent
mark, and the frame is our own. Reproducing a platform's interface pixel-for-pixel is both a trademark
problem and a maintenance treadmill.

---

## 8. The AI Copilot shell contract

A right-side docked panel on desktop (`role="complementary"` — a region, not a modal, so the page
behind it stays reachable) and a full-height modal sheet on a phone.

It renders a conversation, a prompt field, suggested actions, an attachment area and an approval
region, with designed states for **streaming, error, insufficient credits and approval-required**.

**Two properties that the AI phase must not soften:**

1. **The composer is inert and says so.** No provider is connected and no credit is spent. A prompt box
   that looked live but did nothing would be exactly the "button that claims an unsupported action"
   this phase forbids, so it is disabled and carries a visible explanation.
2. **A mutating action is gated.** CLAUDE.md §2.5 lets the Copilot _propose_ and _preview_ a
   high-impact action but never execute one silently. A proposed action renders as a description plus
   an explicit approve/reject pair, states in words that it changes data, and this shell offers no code
   path that performs anything. When a provider is wired in, the confirmation is already the only door.

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

---

## 10. The design showcase

`/{locale}/design-system` in the dashboard: a gallery of every component, state, preview and Copilot
state, for visual review.

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

Phase 2C-A restyled a representative set of screens as the visual-approval checkpoint. Still to do:

1. **Migrate the remaining pages** off the compatibility aliases at the bottom of
   `apps/dashboard/src/components/workspace-shell.tsx` and `apps/admin/src/components/console-ui.tsx`,
   then delete both blocks. Those pages already inherit the new tokens; they have not been re-laid-out.
   Remaining: customer reset, invitation acceptance, workspace picker, no-workspace, permissions, plan,
   settings; console configuration, secrets, flags, plans, providers, ai-models, routing, audit, health,
   support, login.
2. **Adopt the mobile record-list shape** on the console tables that still render only a wide table.
3. **Toast placement.** `Toast` exists and is reviewed in the showcase, but no page mounts a toast
   region yet — server-action feedback currently uses inline `Banner`, which is correct for a
   redirect-based flow. Decide whether any flow needs a transient message.
4. **Breadcrumbs** are used on the workspace detail page only. Extend to other nested console routes.
5. **Density.** One comfortable density ships. If operators ask for a compact table mode, it belongs in
   tokens, not in a page.
6. **`tests/e2e/customer-app.spec.ts`** still measures horizontal overflow with the
   `scrollWidth − clientWidth` proxy. It passes today, but it is the same fragile measurement the
   design-system suite replaced; align it when those pages are migrated.
