# The UI Fidelity Contract

> **الملخص بالعربية**
>
> العرض التوضيحي المعتمد ليس مصدر إلهام — بل هو **المواصفة الملزمة** لواجهة المنتج.
> يجب نقل الشيفرة الأصلية كما هي، لا إعادة تصميمها. أي انحراف مقصود يحتاج قرارًا مسجّلًا.

**Status: binding on every customer-facing route from Phase 5A onward — EXCEPT where superseded below.**

> **SUPERSEDED FOR PRODUCT / UX / IA BY OWNER DECISION D-277 (2026-09-24).** The Phase 6 Final UX
> Contract (`docs/PHASE-6-FINAL-UX-CONTRACT.md`) is now the product, UX and information-architecture
> authority. For every surface it redesigns — Home, the sidebar, the Setup Wizard, Brand Brain,
> Strategy, Campaigns, Content Library, Create Post, Assets, Calendar, Publishing, Analytics,
> Intelligence, the global Copilot, Notifications and Settings — the rules below that forbid
> repositioning, simplifying or reorganising a ported composition NO LONGER APPLY. What still applies
> everywhere: the demo's and the design system's visual language (identity, colours, typography,
> tokens, primitives), the token rule (§4 — no literals, no nearest-token approximation), accessibility,
> responsive and RTL behaviour, and §4.2's rule against introducing a new visual language. Rebuilding an
> old composition because the demo used it is now the mistake, not the safeguard.

---

## 0. Why this document exists

Phase 5A built the Brand Brain screen by reading the approved demo and then **re-interpreting** it: a
lavender container the demo does not have, a black rounded square where the demo has a transparent
circle, and floating white cards where the demo has twelve-pixel dots. Every automated check passed.
Tests asserted the data was real, the focus trap worked and axe was clean — and none of that is what
the owner asked for. The result was accessible, correct, well-tested and **wrong**.

The failure was not carelessness about any single value. It was treating the demo as a mood board.
This document removes that option.

---

## 1. The ten rules

1. **The approved demo is a UI SPECIFICATION, not a loose visual reference.** It has the same standing
   as a schema or an API contract.
2. **Implementations mechanically PORT the corresponding demo HTML, CSS, layout, motion and
   interaction.** Read the demo source and transcribe it. Do not build something that resembles it.
   **Where no approved reference exists, §6 applies instead** — the screen is built from the design
   system and recorded as an extension. A missing reference is never grounds to stop.
3. **Do not redesign, improve, simplify, reposition, recolour or replace an approved visual element**
   unless an owner decision explicitly authorises it. "It looked better" is not authorisation.
   Neither is "the design system has a similar token".
4. **Converting demo code into React must not alter its visual output.** JSX and hooks are a hosting
   change. Constants, geometry, easing and composition survive the move unchanged.
5. **Dynamic production data connects through TYPED ADAPTERS.** Real data replaces demo values at the
   prop boundary; it never causes the component to be redesigned to fit.
6. **Production never uses fake demo data.** No hard-coded 82%, 128 items or 4 sources reaches a
   customer.
7. **Deterministic E2E fixtures MAY reproduce demo data**, and only for automated visual testing.
8. **Every route declares its exact demo source file and pinned source commit** in the manifest below.
9. **Any intentional visual deviation requires a recorded decision with a reason** in
   `docs/DECISIONS.md`. A deviation nobody wrote down is a defect.
10. **No phase may claim visual completion because elements are visible or accessible.** Visible is not
    faithful. Accessible is not faithful. Only measured parity against the pinned source is.

---

## 2. What "mechanically port" means in practice

| Element               | The rule                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Numeric constants** | Transcribed exactly. `orbScale = 1.3`, not "about 1.3". A rounded constant is a deviation                                                             |
| **Geometry**          | Same formula, same order of operations. Perspective, radii, angles and easing are copied, not re-derived                                              |
| **Colour**            | The demo's own value. Where a lint rule demands a token, ADD A NAMED TOKEN CARRYING THE EXACT VALUE rather than substituting the nearest existing one |
| **Composition**       | Same element nesting and stacking order. A wrapper the demo does not have is a deviation                                                              |
| **Motion**            | Same speed coefficients and the same frame loop shape                                                                                                 |
| **Interaction**       | Same events, same thresholds, same state classes                                                                                                      |
| **Responsive**        | The demo's own breakpoints and their values                                                                                                           |

**The token trap, stated explicitly.** `CLAUDE.md` §4 forbids colour literals in components, and that
rule stands. It is satisfied by defining a Brand Brain token whose value IS the demo's value — never by
reaching for a token that is merely close. Substituting an approximate design-system value to satisfy a
linter changes the approved result and is a rule-3 violation wearing a rule-4 costume.

---

## 3. Route-to-reference manifest

Every customer route declares where its visual authority lives. Future phases extend this table; they
do not replace it.

| Route                                            | Authoritative source                          | Upstream repo                           | Pinned commit                              | SHA-256                                                            |
| ------------------------------------------------ | --------------------------------------------- | --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `/[locale]/brand-brain`                          | `demo/brand-brain-native.css`                 | `Mohamed-Omaar/Brandspace-Landing-page` | `b01d94738672c64f651098512c03faf4554ebb97` | `e5b8ca5308a6bc84db4789e6424328fe7ea85086e310abbab6aa124820081034` |
| `/[locale]/brand-brain`                          | `demo/brand-brain-native.js`                  | `Mohamed-Omaar/Brandspace-Landing-page` | `b01d94738672c64f651098512c03faf4554ebb97` | `dc91db029fb8388aece3b47cdb00de05b654002f2c1df8efd458803722591085` |
| `/[locale]/brand-brain`                          | `demo/brand-brain-nav.js`                     | `Mohamed-Omaar/Brandspace-Landing-page` | `b01d94738672c64f651098512c03faf4554ebb97` | `9dd56cfb137633dabf89e8b62c530de8551530dc49775c40eb56d81ec4d80e91` |
| `/[locale]/brand-brain`                          | `demo/index.html` (host page)                 | `Mohamed-Omaar/Brandspace-Landing-page` | `b01d94738672c64f651098512c03faf4554ebb97` | `0bae6b9e58c203bff107f3eb23c1b92e716e25000867ca5d232a7d68f327b893` |
| `/[locale]/content`, `/[locale]/content/compose` | `demo/app-2.js` (`postsPage()`, `composer()`) | `Mohamed-Omaar/Brandspace-Landing-page` | `10765e8cf4f5b89c91b144863330459611248b16` | `669339437605cf3c50fc13c23b10f793d0c4f142d1abd1e89d7c8be98ee7e7fe` |
| `/[locale]/content`, `/[locale]/content/compose` | `demo/styles-1.css`                           | `Mohamed-Omaar/Brandspace-Landing-page` | `10765e8cf4f5b89c91b144863330459611248b16` | `9569b83dedbbc3e24edc090397eadd3da03a9a1228ed1e2ea7b62b9cd1174d75` |
| `/[locale]/content`, `/[locale]/content/compose` | `demo/styles-2.css`                           | `Mohamed-Omaar/Brandspace-Landing-page` | `10765e8cf4f5b89c91b144863330459611248b16` | `fffa17614b8a01feb8f33bb36211366a5bbe9c1eac007867358a7893af8a66a9` |
| `/[locale]/content`, `/[locale]/content/compose` | `demo/styles-3.css`                           | `Mohamed-Omaar/Brandspace-Landing-page` | `10765e8cf4f5b89c91b144863330459611248b16` | `6319a57e97f0c506be1bcdc0cbe7edb3248277243345244f636da5c1d7d228f1` |

**TWO PINNED COMMITS, AND WHY.** The Brand Brain rows above are pinned to the
`brand-brain-native.*` files, which D-60 superseded the full demo with FOR THAT ROUTE ONLY. Every
other customer route still takes its authority from the full demo snapshot
(`docs/visual-reference/full-demo/`, D-60, commit `10765e8c…`), which is where `postsPage()` and
`composer()` live. Both snapshots are checksummed and neither can drift silently.

**Which source is authoritative, and how that was established.** The live route is
`https://www.brandspace.cc/demo/#customer/brand-brain`. Its host page `demo/index.html` loads
`./brand-brain-native.css` (line 24) and `./brand-brain-native.js` (line 97). It does **not** load
`brand-brain/index.html`, which is a separate standalone prototype. The files the live route actually
loads are therefore the authority; the standalone prototype may be consulted only where the live demo
imports or deliberately mirrors it, and it does neither here.

A byte-for-byte snapshot is vendored at `docs/visual-reference/brand-brain-native/` so a future session
never has to resolve the live page again or guess which reference is current. Verify with
`sha256sum docs/visual-reference/brand-brain-native/*`.

> The older vendored snapshot at `docs/visual-reference/full-demo/brand-brain-preview.index.html` is the
> STANDALONE PROTOTYPE (D-60). It is superseded as the Brand Brain authority by the files above and is
> kept only so earlier decisions stay readable. Where they disagree, `brand-brain-native.*` wins.

---

## 4. Authorised deviations for `/[locale]/brand-brain`

Recorded under rule 9. Nothing else deviates.

| Deviation                                            | Authority       | Reason                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`prefers-reduced-motion` draws one static frame**  | D-85            | The demo implements no reduced-motion path at all — it is a prototype. `CLAUDE.md` §4 sets WCAG 2.2 AA as a product requirement, which outranks a prototype's omission. The accommodation SHOWS the same orb; it only stops animating, so a reader who asked for less motion still gets the knowledge map                                          |
| **Real data replaces every demo literal**            | Rule 5 and 6    | 82%, 128, 4, "12 facts · complete" and the rest are demo values. Their POSITION, TYPOGRAPHY and TREATMENT are unchanged; only the numbers come from the database                                                                                                                                                                                   |
| **Ten area cards below the hero; six orbit nodes**   | The demo itself | The demo's orb carries exactly six nodes and its card grid carries eight. The product has ten areas, all of which appear in the grid below the hero. The ORB keeps the demo's six — adding four would be a redesign                                                                                                                                |
| **Five small-text colours darkened for contrast**    | D-89            | Five of the demo's greys and greens fall below the WCAG 2.2 AA 4.5:1 minimum at the sizes it uses them. Each is replaced by the nearest darker step of the SAME hue, listed with its measured before/after ratio in `packages/ui/src/brand-brain.css` §2. `.bb-count` takes the demo's own `--bb-muted`                                            |
| **Physical directions become logical properties**    | `CLAUDE.md` §4  | `text-align: left`, `margin-left` and `margin-right` render Arabic backwards. The logical equivalents produce an identical result in LTR. The full mapping is in `tests/unit/ui-fidelity-manifest.test.ts` so a real drift cannot hide behind it                                                                                                   |
| **The progress bar's fixed `width: 82%` is dropped** | Rule 5          | The demo hard-codes the bar at its invented completion figure. The real width is the computed percentage, set inline from server data                                                                                                                                                                                                              |
| **Orbit node position and scale are quantised**      | D-91            | The demo writes fractional pixels, so a 12px dot's box changes every frame although it crosses a whole pixel about three times a second. A target that never holds still cannot be clicked reliably by assistive tooling, and Playwright refuses it outright — which is how the orb's own nodes went untested. Identical at any zoom a person uses |

---

## 4.1 Authorised deviations for `/[locale]/content` and `/[locale]/content/compose`

Recorded under rule 9. Nothing else deviates.

| Deviation                                                                                               | Authority             | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`copilotPanel()` — the composer's third column — is not rendered**                                    | Phase boundary        | The AI Copilot is Phase 7 (`docs/ROADMAP.md`). Shipping its markup with nothing behind it would be a screen that lies about what the product does. The `.composer` grid therefore carries two tracks (`minmax(350px,1fr) 340px`) rather than three; every other declaration is the demo's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **`socialPreview()`'s static mock becomes the generated variants**                                      | Rules 5 and 6         | The demo's second column is a hard-coded Instagram post with an invented sentence. It is replaced, in the same column and the same `surface-card`, by the real variants: the caption per channel, its count against that channel's CONFIGURED limit, the computed validation, the retrieved sources and the five editing tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **The "Campaign" and "Publish" pickers become Language and Content type**                               | Phase boundary        | Campaigns and scheduling belong to the Social Calendar, not to scope item 3. The `.form-row` geometry — `1fr 1fr`, `gap:10px`, collapsing to one column at 640px — is ported unchanged and carries this scope's own two controls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **`.media-strip` and `.thumb` are not ported at all**                                                   | Rule 2                | Attaching media is the publishing pipeline's, and `content_variant.assetIds` has no customer-facing picker in this scope item. Porting a stylesheet for an element nothing renders would be dead code claiming to be fidelity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **The tab strip lists the states that are REACHABLE**                                                   | Rules 5 and 6         | The demo ships five fixed tabs (All / Drafts / Review / Scheduled / Published) with invented counts. The rule applied instead is that a tab exists when its state can actually occur: a tab that can only ever read zero is an invented number. Phase 5B-2 therefore rendered four; **Phase 5B-3 renders six**, because Changes requested and Approved became reachable when the approvals workflow shipped — and content in a state with no tab is content the library cannot find, which is the one thing that screen is for. Scheduled and Published stay out until Phase 6. The `.tabs` treatment, the counts' position and the `·` separator are unchanged throughout                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Real data replaces every demo literal**                                                               | Rules 5 and 6         | `All · 28`, the eight invented posts, "NEW CHAPTER" and the scripted caption are demo values. Their POSITION, TYPOGRAPHY and TREATMENT are unchanged; the counts are `groupBy` results, the cards are real drafts and the art carries the draft's own title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **`post-art` gradients are chosen from the draft id**                                                   | Rule 5                | The demo assigns one of four gradients per invented card by hand. A real library has no such list, so the gradient is derived deterministically from the row's id: a draft keeps the same face across reloads, and the visual fixture renders the same page every run rather than one that has to be re-approved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Physical directions become logical properties**                                                       | `CLAUDE.md` §4        | `text-align: left` on `.post-card` renders Arabic backwards. `text-align: start` is identical in LTR. The same one-class substitution the Brand Brain port records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **`--muted` is one step darker (`#6A6A72`)**                                                            | `tokens.ts`           | The demo's `#717179` measures 4.44:1 on its own `--soft`, where the draft status pill and the search placeholder sit — under the AA 4.5:1 minimum at 8px and 9px. This is NOT a new decision: `packages/ui/src/tokens.ts` already carries `#6A6A72` as the platform's documented deviation for this exact value. Measured 4.92:1 on `#F5F5F6`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **A visible `:focus-visible` ring is added**                                                            | D-85's precedent      | The demo sets `outline: 0` on every field and ships no focus rule at all — it is a prototype nobody tabs through. WCAG 2.2 AA requires a visible indicator. The ring is drawn OUTSIDE the control, so the approved resting appearance is unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **The search field gains a visually hidden `<label>`**                                                  | `CLAUDE.md` §4        | The demo names its search box with a `placeholder` alone, which is not an accessible name. The placeholder stays exactly as the demo wrote it; the label is `.cs-sr-only` and changes no pixel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **`.select-like` is a real `<select>`**                                                                 | Rule 5                | A `<div>` in the demo because a prototype has no options. The demo's own rule already groups `.select-like` with the filter-row buttons, so `.cs-select` carries those declarations verbatim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **One dropdown marker, drawn by the product and mirrored for RTL**                                      | Phase 6 brief (P6-02) | The consequence of the row above, which the row above did not follow through. A `<div>` has no affordance; a real `<select>` gets the browser's arrow — at the physical edge, different in every browser, unmirrored in Arabic, and on `.cs-select` sitting beside design-system selects wearing the product's chevron. The demo never had either marker, so there is no demo answer to port and the choice is between two inconsistencies. The owner authorised the consistent one. `tokens.css` draws the marker for **every** `select` (the element, not a class, so a call site cannot forget it); `.cs-select` and `.cs-field select` set only `--bs-select-chevron-inset` and `--bs-select-chevron-space`, because a 36px control at 9px type cannot spare the default trailing room. **Where the browser supports `appearance: base-select` the product's chevron stands down** and the native `::picker-icon` is the single marker — the two were being painted on top of each other, which is the doubled arrow the owner reported. The demo's fill, radius, padding, type and geometry are unchanged |
| **`background: <colour>` is written as `background-color: <colour>` on the rules that render a select** | Phase 6 brief (P6-02) | The two paint the same pixels; they differ in what they RESET. The shorthand also clears `background-image`, and `.cs-select` / `.cs-field select` outrank an element rule on specificity — so the shorthand silently erased the marker above and handed the control back to the browser. Narrow and checked rather than asserted: `tests/unit/content-fidelity.test.ts` treats the two spellings as equal **only** where the demo's value is a bare colour, so a gradient, an image or a layered background is still compared literally and `.cs-gradient-*` cannot drift through this door. The VALUE is unchanged, so a genuine change of fill still fails                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## 4.2 Authorised deviation for the brand lockup (every route)

Recorded under rule 9. The lockup appears in the shell rail, the Control Center
and the auth card, so this deviation is platform-wide rather than per route.

| Deviation                                                    | Authority     | Reason                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The demo's CSS mark becomes the OFFICIAL BrandSpace logo** | Owner, PR #32 | The demo draws `.brand-mark` as an ink square with `border-radius: 11px` around a 15px/850 letter "B" — a placeholder standing in for a logo the prototype did not have. The product ships the real one. This is the one case where the demo is NOT the authority: a prototype's placeholder cannot outrank the company's actual mark |

**What is unchanged, and is still asserted.** The logo occupies the demo's slot
exactly — 34×34 inside `.brand { gap: 10px }` — and its artwork cuts the same
silhouette: the corner radius is 261.09 of an 877.07 viewBox, which renders at
~10.1px against the demo's 11px. The rhythm of the lockup is the demo's.

**What stopped being meaningful.** `border-radius`, `font-size` and
`font-weight` described a container that drew a square and typeset a letter. The
container now holds artwork: no radius, no background, no text. `tests/e2e/
design-system.spec.ts` → "the brand lockup" asserted all three and was updated
to the contract above — geometry, the artwork filling its slot, `flex-shrink: 0`,
the official black/white two-tone, and `aria-hidden` on both the span and the
SVG so the wordmark alone carries the accessible name.

**The artwork's `#000000` and `#FFFFFF` are not component colour literals.**
`CLAUDE.md` §4 forbids colour literals in components because a component must
take its colours from the design system. These are inside the logo's own `path`
fills — the mark's identity, fixed by the brand and not a token the platform may
re-theme. Routing them through tokens would let a palette change silently
repaint the company's logo.

---

## 5. How compliance is proven

Not by looking at a screenshot and forming an opinion:

- **Pinned checksums.** `tests/unit/ui-fidelity-manifest.test.ts` asserts the vendored snapshot still
  matches the SHA-256 values in §3, so the reference cannot drift silently.
- **Declaration-by-declaration diff.** The same suite extracts each selector's block from the snapshot
  and from `packages/ui/src/brand-brain.css` and compares them BOTH ways: a declaration the demo has
  and the port lost fails, and a declaration the port added that the demo never had fails too. The
  second direction is the one that matters — a `background` added AFTER the demo's
  `background: transparent` overrides it while leaving it present, which is exactly how Phase 5A's
  lavender container passed every check in the suite. Every permitted addition and omission is
  enumerated in that test with its reason.
- **DOM geometry assertions.** `tests/e2e/brand-brain-visual.spec.ts` measures the real rendered
  elements against the demo's own values — stage height, centre diameter, node diameter, hero column
  ratio — and fails on material drift.
- **DOM geometry, against the demo's own numbers.** `tests/e2e/brand-brain-visual.spec.ts` measures the
  rendered elements — stage height and background, centre diameter and fill, node diameter and shape,
  hero column ratio and padding, node and card counts, the chat's position inside the hero, the drawer's
  side in RTL — against values transcribed from the pinned snapshot. They are duplicated in the test
  rather than imported from the stylesheet on purpose: a test that reads its expectations from the thing
  under test asserts nothing. Each assertion names the Phase 5A defect it would have caught.
- **A deterministic fixture.** `tests/e2e/seed-visual.ts` provisions a workspace whose Brand Brain is
  RESET to a fixed state on every seed. The functional suites deliberately leave state behind, and a
  visual test pointed at their workspace would photograph a different page every run — which makes
  re-approving the baseline the only way to stay green, and that is the failure this section forbids.
  The test asserts the page against the numbers the seed recorded, so fixture drift fails as fixture
  drift.
- **Numerical screenshot comparison.** Playwright snapshot assertions against committed baselines, with
  motion reduced to a single static frame (D-86), the orb's canvas masked — its particle field is seeded
  randomly and its rotation comes from a frame timestamp, so it is the one genuinely non-deterministic
  thing on the page — and a 1% pixel-ratio tolerance, tight enough that a moved element fails.

  This half is skipped where `BRANDSPACE_VISUAL_BASELINE=0`, and the reason is worth stating rather than
  hiding: the page uses a SYSTEM font stack, and two machines with different fonts installed rasterise
  the same layout differently. A baseline that must be re-approved whenever the runner image changes
  teaches exactly the habit the rule above forbids. So the environment-independent half is what gates
  the build, and the pixel half is a tight check run where its baselines were produced.

A baseline is never updated to make a failing test pass. It changes only when §3's pinned commit
changes or an owner authorises a deviation under rule 9.

---

## 6. When a route has NO approved reference — the design-system extension

**Binding from Phase 5B-1 onward, and mirrored in `CLAUDE.md` §4.2.**

### 6.1 Why this section exists

The Asset Library is a required product module — `docs/PRODUCT.md` §5 module 13, and scope item 4 of
Phase 5. Its route in the approved demo (`#customer/media`, "Media library") is **not a design**: the
router in `demo/app-3.js` sends it to `simpleFeaturePage()` in `demo/app-2.js`, which renders a
"Future product preview" kicker, a heading, one sentence and three identical placeholder cards. Every
other mention of a media or asset library in the Landing repository is marketing copy on a public
page. There is nothing to port.

§1 rule 2 as originally written had no answer for that, and the two readings it invited were both
wrong: invent a screen (rule 3 forbids it), or refuse to build a required module until the owner
designs it (which makes missing artwork a blocker on functional delivery, indefinitely).

### 6.2 The rule

|                                                  |                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Reference exists and is complete**          | Port it mechanically. §1–§5 govern unchanged                                                                                                                                                                                                           |
| **2. No reference, or a placeholder route**      | **Build the screen.** Do not stop; do not require the owner to design it first                                                                                                                                                                         |
| **3. Build it from the platform's own language** | Existing tokens · typography · spacing and grid · cards and surfaces · buttons and controls · toolbars, search and filters · drawers and modals · empty, loading and error states · motion and interaction patterns · responsive and RTL/LTR behaviour |
| **4. Compose before creating**                   | Reuse an existing pattern. A new component or visual treatment is a last resort and carries a recorded reason                                                                                                                                          |
| **5. No new visual language**                    | No unrelated layout system, no new colour family, no new font, no new shadow style, no new interaction model                                                                                                                                           |
| **6. Record it as an EXTENSION**                 | In §6.3 below — not as a demo port, which it is not, and not as an unapproved deviation, which it also is not                                                                                                                                          |
| **7. Real data, every state**                    | Typed adapters at the prop boundary; loading, empty, processing, failed, quarantined and ready all implemented                                                                                                                                         |
| **8. Prove it like a port**                      | Deterministic fixtures, DOM geometry, responsive, RTL/LTR and accessibility tests                                                                                                                                                                      |
| **9. One final screenshot**                      | For owner review, after the targeted tests pass. Not repeated approval requests, and not screenshots generated throughout implementation                                                                                                               |
| **10. Refinable, not settled**                   | The owner may correct an extension in the final UI parity pass. Missing route artwork must not block functional delivery                                                                                                                               |

**What rule 5 costs, stated plainly.** An extension will look like the rest of BrandSpace rather than
like a screen designed for its own purpose. That is the intended trade: a screen that is unmistakably
part of this product and slightly generic is recoverable in a parity pass, and a screen with its own
colour family and its own idea of a card is not.

### 6.3 Extension manifest

Routes built under §6. Each names what it is composed FROM, so a reviewer can check rule 4 rather than
take it on trust.

| Route                      | Why no reference                                                                                                                                                                                                                                                                                                                                                                                                                       | Composed from                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Recorded |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `/[locale]/assets`         | The demo's `#customer/media` route is `simpleFeaturePage('media')` — a "Future product preview" placeholder with three identical cards. No Asset Library design exists in the Landing repository at the pinned commit                                                                                                                                                                                                                  | `packages/ui` tokens and primitives; the shared dashboard shell; the demo's own `view-toolbar`, card, chip, drawer and empty-state geometry as already ported for Brand Brain and the members, plan and settings routes                                                                                                                                                                                                                                                                         | D-98     |
| `/[locale]/calendar`       | The demo's `#customer/calendar` route IS a design (`calendar()` in `demo/app-2.js`), and it was already PORTED into `packages/ui`'s `ContentCalendar` during the design-system phase — its month grid transcribes the demo's `.calendar`, `.weekday` and `.day` geometry. This route is not a second port of the same thing; it is that component with the workspace's own slots behind it, plus the three states the demo has none of | `packages/ui`'s `ContentCalendar` (the existing demo port), `Dialog`, `Field`, `StateMessage`, `Button` and the design tokens; the shared dashboard shell. The additions are live period navigation, a scheduling dialog and a slot dialog — composed from existing primitives, with no new colour, font, shadow, layout system or interaction model                                                                                                                                            | D-118    |
| `/[locale]/approvals`      | The demo's `#customer/approvals` route is `simpleFeaturePage('approvals')` — a "Future product preview" kicker, one sentence and three identical placeholder cards. Exactly the case §6.1 was written for after the Asset Library: the router in `demo/app-3.js` sends it to the placeholder, and nothing else in the Landing repository at the pinned commit is an approvals design                                                   | `packages/ui`'s `Card`, `SectionHeader`, `StateMessage`, `StatusBadge`, `Field` and the button, spacing and typography tokens; the shared dashboard shell. The one addition is a checkbox composed from a native input with the existing label typography — `Field` renders a text control and a checkbox is the shape it does not cover                                                                                                                                                        | D-130    |
| `/[locale]/activity`       | The demo has **no activity route at all** — it is absent from `app-1.js`'s navigation, from `meta`, and from `page()`'s router. There is nothing to port                                                                                                                                                                                                                                                                               | `Card`, `SectionHeader`, `StateMessage`, `StatusBadge` and the tokens; the shared shell. The filter is a plain GET form using the existing control styles, so it works without scripting and a filtered view is a real URL                                                                                                                                                                                                                                                                      | D-124    |
| `/[locale]/notifications`  | Likewise absent from the demo. `notify()` in `demo/app-4.js` is the prototype's own "interactive preview" toast, not a notification centre                                                                                                                                                                                                                                                                                             | `Card`, `SectionHeader`, `StateMessage`, `StatusBadge` and the tokens; the shared shell. Unread is marked by an inline-start border **and** a badge carrying the word, never by colour alone (WCAG 2.2 AA 1.4.1)                                                                                                                                                                                                                                                                                | D-123    |
| `/[locale]/analytics`      | The demo's `#customer/analytics` route is `simpleFeaturePage('analytics')` — the "Future product preview" placeholder again. There is no dashboard, no chart and no metric layout to port                                                                                                                                                                                                                                              | `packages/ui`'s `MetricCard`, `Card`, `SectionHeader`, `ContentGrid`, `StateMessage`, `StatusBadge`, `DataTable` and the tokens; the shared shell; the demo's four-across metric row as already ported for the Command Center. The additions are `TrendChart`, `ComparisonChart`, `ChartDataTable`, `ChangeIndicator` and `ChartUnavailable` — see §6.4, which is where a new visual treatment has to earn its place                                                                            | D-156    |
| `/[locale]/strategy`       | Absent from the demo entirely — not in `app-1.js`'s navigation, not in `meta`, not in `page()`'s router                                                                                                                                                                                                                                                                                                                                | `Card`, `SectionHeader`, `StateMessage`, `StatusBadge`, `Field`, `Button` and the tokens; the shared shell. The generate control is a plain GET/POST form using the existing control styles, and an insight's evidence renders through the same `DataTable` the analytics route uses                                                                                                                                                                                                            | D-150    |
| `/[locale]/copilot`        | The demo has no Copilot ROUTE, but it does have the Copilot's visual SHELL, and that shell was ported into `packages/ui` during the design-system phase (`CopilotBody`, `docs/DESIGN-SYSTEM.md` §8). This route is that shell with real data behind it rather than a second visual system beside it                                                                                                                                    | `packages/ui`'s `CopilotBody` (the existing port) plus `Card`, `SectionHeader`, `Banner`, `StatusBadge`, `Button` and the tokens. The additions are the plan preview list and the confirm/reject pair — composed from existing primitives, with no new colour, font, shadow, layout system or interaction model                                                                                                                                                                                 | D-151    |
| `/[locale]/automations`    | Module 15 in `docs/PRODUCT.md`, and absent from the demo altogether                                                                                                                                                                                                                                                                                                                                                                    | `Card`, `SectionHeader`, `StateMessage`, `StatusBadge`, `Field`, `Button` and the tokens; the shared shell. The rule editor is a plain GET/POST form over the CLOSED trigger, action and CONDITION registries, so every control is a `select` over a fixed option list rather than free text; a condition's operator list, value control and closed values are all derived from `CONDITION_FIELD_CONTRACTS` (D-180), and `in`/`not_in` use a `multiple` select so the browser posts a real list | D-154    |
| `/[locale]/settings/brand` | **Brand Profile.** The demo has no brand-identity route at all — `#customer/brand` is not in `app-1.js`'s navigation, not in `meta` and not in `page()`'s router. It is also not a new KIND of screen: it is a settings form for one brand                                                                                                                                                                                             | `packages/ui`'s `SettingsSplit`, `Card`, `Field`, `StateMessage` and the input, button, spacing and typography tokens — the SAME composition `/[locale]/settings` already uses, deliberately, so a reader moving between workspace settings and brand settings meets one page design rather than two. The only addition is a row of colour swatches, each carrying its hex in a `title` and a visually-hidden span so the colour is never the only way to read the value                        | D-193    |

| `/[locale]/campaigns`, `/campaigns/new`, `/campaigns/[campaignId]` | The demo's `#customer/campaigns` route is `simpleFeaturePage('campaigns')` — the "Future product preview" placeholder with three identical cards. There is no campaign list, no campaign form and no campaign detail design in the Landing repository at the pinned commit | `packages/ui`'s `Card`, `SectionHeader`, `DataTable`, `StateMessage`, `StatusBadge`, `Field`, `Button` and the tokens; the shared shell. The list is the `DataTable` the members and activity routes already use; the form is the `Field`/`SettingsSplit` composition the settings routes use; the detail page's performance row is the SAME four-across metric row as the Command Center and Analytics. Nothing new was drawn | D-195 |
| `/[locale]/creative` | **AI Creative Studio.** The demo's `#customer/studio` route is `simpleFeaturePage('studio')` — the placeholder again. `DesignStudio` exists in `packages/ui` as a ported demo COMPONENT, but it is a layout canvas rather than a generation screen, and this route is neither a second port of it nor a redesign of it | `packages/ui`'s `Card`, `SectionHeader`, `Field`, `StateMessage`, `Button`, `AssetMedia` and the tokens; the shared shell. The format picker is a `select` over the closed `CREATIVE_FORMATS` catalogue, the quote line is caption typography, and the result is the same square `aspect-ratio: 1 / 1` frame the post card uses — so a generated image is framed exactly as a published one | D-195 |
| `/[locale]/intelligence` | **Marketing Intelligence.** Absent from the demo entirely — not in `app-1.js`'s navigation, not in `meta`, not in `page()`'s router | `Card`, `SectionHeader`, `StateMessage`, `StatusBadge`, `Field`, `Button` and the tokens; the shared shell — deliberately the SAME composition, in the same order and with the same spacing, as `/[locale]/strategy`, so a reader moving between Analytics, Intelligence and Strategy is reading one product rather than three. The evidence list is the identical markup `/strategy` renders its evidence with | D-198 |

| `/[locale]/billing`, `/billing/invoices/[invoiceId]`, `/billing/checkout/[outcome]` | **Billing & Usage.** The demo's `#customer/billing` route is `simpleFeaturePage('billing')` — the "Future product preview" placeholder with three identical cards. There is no plan grid, no invoice table, no invoice document and no checkout return state in the Landing repository at the pinned commit | `packages/ui`'s `Card`, `SectionHeader`, `Banner`, `StateMessage`, `DataTable`, `Field`, `Button` and the tokens; the shared shell. The subscription/credits pair is the SAME `bs-split-main` composition `/[locale]/plan` already uses, deliberately, so a reader moving between "what am I entitled to" and "what do I owe" meets one page design. The plan and pack grids are the auto-fit card grid the Campaigns list uses; the invoice list is the `DataTable` the members and activity routes use; the invoice document is the `Card` + definition-list composition the settings routes use. Nothing new was drawn, and no amount is rendered anywhere except through `formatMoney`, which takes the number of decimals from the currency itself | D-204, D-205 |
| `/[locale]/onboarding`, `/onboarding/workspace` | **The first-run Setup Wizard and workspace creation.** Absent from the demo entirely — not in `app-1.js`'s navigation, not in `meta`, not in `page()`'s router. Signing up is the one journey a product demo has no reason to draw. Since D-278 the checklist is a guided wizard (§6.3.6) | `Card`, `Field`, `StatusBadge`, the button variants and the tokens inside the shared shell; the stepper reuses the `LinkTabs` track-and-pill treatment. `AuthCard` — the existing sign-in/reset composition — for creation, because creating a first workspace happens before there is a workspace for the shell to be about | D-210, D-278 |
| `/[locale]/sign-up`, `/sign-up/sent`, `/verify`, `/mfa` | **Signup, verification and the second factor.** The demo has a marketing site and a signed-in product; it has no account-creation flow at all | `AuthCard`, `Field`, `Banner` and the auth control styles — the IDENTICAL composition `/sign-in` and `/reset` already use, in the same order. A reader arriving from the marketing site meets the same card they will meet again at every later sign-in | D-206 |
| `/[locale]/billing/invoices/[invoiceId]/document` | **The invoice as a printable document.** The demo has no invoice at all, and this is not a screen in the first place: it is a document that happens to be served over HTTP, with no navigation, no shell and A4 proportions | Deliberately NOT the dashboard shell, and that absence is the design decision. It is the platform's typography scale, the platform's own `surface`, `textPrimary` and `textSecondary` tokens, one new token (`documentRule` — a rule weight that survives a printer, where the screen borders do not), and the same definition-list and table composition the invoice SCREEN uses — so the two say the same thing in the same order. Its `@page` rules and print colours are declared inline on the route, because an accounting document must not be alterable by a change to a shared stylesheet. Every amount renders through `formatMoney`, which takes its decimals from the currency itself | D-216 |
| `/[locale]/settings/security` | **The customer's own security settings.** The demo has a signed-in product and no account-security screen anywhere — `#customer/security` is not in `app-1.js`'s navigation, not in `meta` and not in `page()`'s router. It is also not a new KIND of screen: it is a settings page for one person's second factor, which is why it is composed exactly like the settings pages beside it rather than designed for itself | `packages/ui`'s `SettingsSplit`, `Card`, `Field`, `buttonStyle`, `inputStyle` and the spacing and typography tokens, plus the shared shell and the same `CustomerBanner` every settings route uses — the IDENTICAL composition `/[locale]/settings` and `/[locale]/settings/brand` already use, in the same order, so a reader moving between the three meets one page design. The only additions are a `<code>` block for the otpauth string and a list of recovery codes in the same caption typography; nothing new was drawn, and no colour, font, shadow, layout system or interaction model was introduced | D-254 |

| `/[locale]/settings/data` | **Data controls.** The demo has no data-controls screen — not in `app-1.js`'s navigation, not in `meta`, not in `page()`'s router. It is a settings page listing controls that already live elsewhere, and stating plainly which self-serve controls do not exist | `packages/ui`'s `SettingsSplit`, `Card`, `SectionHeader`, `StatusBadge` and ghost `buttonStyle` links — the SAME composition every other Settings section uses, so it reads as one of them. Nothing new was drawn | D-273 |
| `/[locale]/notes` | **Notes across the product.** The demo has no notes or conversation route — its approvals, content and campaign placeholders carry no discussion, and there is no inbox of any kind to port | The IDENTICAL composition `/[locale]/notifications` uses — `Card`, `SectionHeader`, `StateMessage`, `StatusBadge`, the same list rows and the same inline-start border plus a worded badge for unread (never colour alone) — so the two inboxes are one design. Each row links back to the subject screen where the existing notes panel lives. Nothing new was drawn | D-276 |

| `/[locale]/publishing` | **Publishing — Queue, Published, Failed, Accounts.** The demo has no publishing screen; its closest route is `simpleFeaturePage`. The owner's final IA (D-277 §33) makes publishing one customer concept instead of a technical Integrations page | The `LinkTabs` strip (the existing `Tabs` visual treatment, as URL navigation), `Card`, `SectionHeader`, `StateMessage`, `StatusBadge` and `buttonStyle` actions, with the SAME list rows `/notifications` and `/notes` use. Nothing new was drawn | D-277 |

### 6.3.1 Phase 6 P6-11 — additions inside screens that were already extensions

`/analytics` and `/intelligence` were already §6 extensions (above). P6-11 adds content to them, and to
the Brand Brain review drawer, composed entirely from what those screens already use:

- **Analytics** — a _What changed_ card and a _What to do next_ card: `Card`, `SectionHeader`,
  `StatusBadge`, a token-styled list, and `buttonStyle` + `buttonClass` links and forms. No new
  component.
- **Intelligence** — _Why · What happened · What to do next_ blocks: a `label`-token heading over a
  `bodySm` list, the same scale as the evidence list beneath it. The deep-linked finding uses the existing
  `Card` tone `lavender` — an existing surface tone, not a new highlight treatment.
- **Brand Brain review drawer (a ported demo surface)** — the additions are the drawer's OWN micro
  caption style for source/measurement/conflict lines, and an _Edit, then accept_ disclosure whose
  inputs reuse `CONTROL_CLASS` + `drawerInputStyle` and whose button reuses `reviewButtonStyle`, exactly
  as the drawer's existing "add knowledge" form does. Nothing in the ported geometry changed.

### 6.3.2 Phase 6 P6-12 — Copilot and Automations additions

Both routes were already §6 extensions. The Copilot screen keeps the ported `CopilotBody` shell and
adds, inside its existing plan `Card`, a context caption, before → after in preview lines, an
inspection results list and localized status — `typographyTokens` captions and lists only. Automations
adds a brand caption, a proposal line on waiting runs, and a native `<details>` delete confirmation
styled with `buttonStyle` + `buttonClass`. The "Ask Copilot" entries on Home, Analytics, Intelligence
and Automations are ghost/primary `buttonStyle` links. Nothing new is drawn.

### 6.3.3 Phase 6 P6-13 — Team, Activity, Settings and Plan additions

`/settings/data` is a new §6 extension composed only of `SettingsSplit`, `Card`, `SectionHeader`,
`StatusBadge` and ghost `buttonStyle` links — the same parts every other Settings section uses. The Team
screen adds a Brand access column to its existing `DataTable`/`RecordList` pair and a `<details>` form
whose radios and checkboxes use native controls held to `layoutTokens.minTargetSize`, as the approvals
checkboxes are. Activity and Plan change words, not layout. Nothing new is drawn.

### 6.3.4 Phase 6 P6-14 — accessibility corrections to existing screens

No geometry changed. Plan's table wrappers take the opaque `surface` + `radiusTokens.lg` that
`DataTable` already has, because the demo's translucent `.surface-card` put 9px headings on the ambient
glow at 4.24:1; the card itself is untouched. Plan's tables and Brand Brain's `.bb-attention` take
keyboard focus (visible only as the standard focus ring). Brand Profile's locale checkboxes take the
approvals checkbox size. All three are corrections the owner may refine in the final parity pass.

### 6.3.5 Phase 6 P6-16 — the customer top bar

The top bar keeps the demo's composition and geometry exactly — `.icon-button` (38×38, soft fill, 12px
radius), `.notification-dot`, the 38px `.language-button` and `.primary-button.compact` — and changes
what each control DOES: Review, Notes, Notifications and Copilot are links to real screens and Create
opens a `DropdownMenu` of real creation flows, its trigger the unchanged purple button with no chevron
(the demo draws none; `aria-haspopup` carries it). The dot is drawn only from a real count. The search
control is removed (D-276), which is the one visible difference from the demo's bar, recorded here
rather than hidden. One glyph was added, `NoteIcon`, drawn to the family's own specification.

### 6.3.6 Phase 6 final — the first-run Setup Wizard (D-277 §6, D-278)

`/[locale]/onboarding` stopped being a checklist of links and became one guided journey: Workspace →
Brand → Learn → Review → Connect → First goal → "You're ready to start". No reference draws it, so it is
an extension composed only of what ships: the shell, `Card` for each step, `Field` and the control
classes for the brand form, the `brand` button for the one primary action per step and `neutral` for
"Skip for now", `StatusBadge` for a document's reading state and a connection's health. The stepper is
an ordered list of links carrying the `LinkTabs` treatment token for token (muted track, raised white
pill with the pressed-purple label for the current step) plus the success tint for a finished step; its
"done" state is spoken as text, not only drawn as a tick. The review step shows each extracted fact as a
soft-surface card with the same Accept / Edit, then accept / Reject controls the Brand Brain drawer
uses. No new colour, radius, shadow, font or motion.

### 6.3.7 Phase 6 final — the global Copilot drawer (D-277 §37, D-280)

`CopilotDrawer` is the demo's `.side-drawer` transcribed exactly as `PostDetailDrawer` already transcribes
it (430px, inset 20px, 28px radius, the drawer surface, blur and shadow) with the existing
`CopilotHeader` on top and the existing `CopilotView` inside. The 300px `CopilotPanel` is unchanged and
remains the composer's docked column. The context line gains one clause, "looking at “…”", in the same
caption style. No new colour, radius, shadow or motion.

### 6.3.8 Phase 6 final — Notes as conversations (D-277 §28, D-281)

The notes panel keeps its `Card` composition. Each note gains a 28px initial avatar in the lavender
tint with the pressed-purple letter (the same treatment Home's notes preview uses), the author in
bold and a relative time; the thread header gains `StatusBadge`s for Important (accent tone) and
Due / Overdue (neutral / danger), and a plain "waiting on" caption. Assignment, due date and
importance sit behind one native `<details>` disclosure in caption type, so a thread still reads as a
conversation. The @-mention suggestions are a small surface listbox (surface background, `md` radius,
the overlay shadow, lavender active row) under the field — the dropdown-menu treatment already in
`menu-style`. A deep-linked thread is drawn with the lavender surface and the purple border. No new
colour, font, radius or motion.

### 6.3.9 Phase 6 final — the media-first Content Library (D-277 §15, D-282)

`/[locale]/content` is no longer the `postsPage()` port: the owner's contract replaced the gradient
cards. The screen is composed from `LinkTabs` (status and Grid / List), the ordinary controls in a GET
form, `Card` (for "Ideas worth making"), `StatusBadge`, `AssetMedia` and the button variants. A card is
the surface-card treatment (`surfaceCardAlpha`, `cardBorder`, `2xl` radius) holding a square media well
in `surfaceSoft` with the `lg` radius; a text-only post shows its caption in `bodySm` / `textSecondary`
there. The composer (`/content/compose`) remains the demo port until its own workstream. The
manifest rows above for `/[locale]/content` now pin only the composer.

### 6.3.10 Phase 6 final — the Create Post entry (D-277 §17-§19, D-283)

`/[locale]/content/compose` without a draft opens on "What would you like to create?": four link cards
in a responsive grid using the surface-card treatment (`surfaceCardAlpha`, `cardBorder`, `2xl` radius)
with the `brandPurpleTint` icon tile, plus the idea and repurpose pickers composed from `Card`,
`StateMessage`, `StatusBadge` and the button variants. This is an APPROVED DESIGN-SYSTEM EXTENSION —
the demo's `composer()` has no entry step. The composer port itself is unchanged in geometry; inside
it the format selector moves above the channel chips (it decides which chips are enabled), a goal
selector joins the pre-draft form in AI mode, and the primary-action class swaps between Generate and
Save draft by mode — all with the port's own `cs-field`, `cs-channel`, `cs-dark-button` and
`cs-ghost-button` classes.

### 6.3.11 Phase 6 final — the draft editor (D-277 §20-§22, D-284)

With a draft open, `/[locale]/content/compose` renders `.cs-draft-layout`: three tracks (context
200–240px, editor fluid, preview 280–340px), collapsing to editor + preview at 1180px and to one
column at 760px. It is an APPROVED DESIGN-SYSTEM EXTENSION built only from the port's own classes and
colours (`cs-surface-card`, `cs-field`, `cs-channel` as the variant tabs, `cs-notice`, `cs-hint`,
`cs-counter`, `cs-citations`; `--cs-purple`, `--cs-soft`, `--cs-muted`, the port's warning and error
values). The preview track is where the demo's `copilotPanel()` column sat (§4.1): it now holds the
live `SocialPostPreview` rather than a Copilot, which is global (D-280). The pre-draft form keeps the
two-track `.cs-composer` port unchanged.

### 6.3.12 Phase 6 final — slides, the media drawer and the paged carousel (D-285)

The variant's media is `.cs-slides` / `.cs-slide-list`: rows on `--cs-soft` with the port's 13px radius,
a 3.25rem `AssetThumb`, the slide label in the port's type scale and `cs-channel` action chips; a dragged
row is outlined in `--cs-purple`. "Add media" opens `SideSheet` — a new `packages/ui` overlay that is the
Copilot drawer's geometry (`drawerAlpha`, blur, `3xl` radius, `shadowTokens.drawer`, `drawerWidth`) with
`Dialog`'s focus trap, Escape and restoration; the reason it exists is that `CopilotDrawer` is bound to
Copilot labels. Its library grid is `.cs-media-grid` / `.cs-media-choice` in the same tokens. The
`SocialPostPreview` carousel gains paging only when a caller passes `slides` and the three slide labels:
two round arrows in the existing play-button treatment (white 0.9, `surfaceInk`), the logical chevron
icons that flip in Arabic, and `CarouselDots`' existing `active` state. No new colour, font, shadow or
interaction model.

### 6.3.13 Phase 6 final — Asset Library views, badges and detail drawer (D-287)

`/[locale]/assets` keeps its §6 extension (D-98) and adds: a `LinkTabs` row of views above the filters;
tile badges in `StatusBadge` tones already in use (info = AI generated, neutral = Shared, warning =
Rights expiring, danger = Rights expired) and a caption line for "Used in"; a 24px selection checkbox
per tile (WCAG 2.5.8) feeding a bulk form of ordinary `Field` controls; and the detail moved from a card
under the grid into the `SideSheet` (D-285), with the preview, a tint link for "Use in a post" and a muted
link for Download. No new colour, font, shadow or interaction model.

### 6.3.14 Phase 6 final — the Campaign Project Room (D-289)

`/[locale]/campaigns/[id]` keeps its §6 extension composition (`Card`, `SectionHeader`, `StatusBadge`,
`MetricCard`, `StateMessage`) and adds `LinkTabs` for its six sections, a three-card overview grid, list
rows with a 3rem `AssetThumb`, and the edit form folded into a native `details`. No new visual treatment.

### 6.3.15 Phase 6 final — the calendar's tray, filters and post drawer (D-290)

`/[locale]/calendar` keeps the approved `ContentCalendar` grid, agenda and chips unchanged, and adds: a
filter row of native selects, the Unscheduled tray on the grid's `surfaceMuted` panel treatment with the
existing compact button, a caption-sized "BrandSpace noticed" line, and the post detail moved from the
centred `Dialog` into the shared `SideSheet` (D-285) holding the existing `VariantPreview`. The grid's
only new behaviour is a drop target on each day cell. No new colour, font, shadow or interaction model.

### 6.3.16 Phase 6 final — Publishing rows (D-291)

`/[locale]/publishing` keeps its §6 extension (`LinkTabs`, `Card`, `StatusBadge`, list rows) and gives each
job row a 3rem `AssetThumb` column — or a `surfaceMuted` tile with the title's first letter for a text-only
post — plus a readiness `StatusBadge` and a `success`-token line for "Account reconnected". No new visual
treatment.

### 6.3.17 Phase 6 final — Strategy as a plan (D-292)

`/[locale]/strategy` keeps its §6 extension primitives (`Card`, `SectionHeader`, `StatusBadge`, list rows)
in a two-column auto-fit grid for Audience / Key messages and Pillars / Channel mix. Shares are drawn as a
6px `surfaceMuted` track with a `brandPurple` fill beside the number (the number is the fact; the bar is
`aria-hidden`). Proposals use a dashed `border` frame to read as not-yet-accepted. No new colour, font or
shadow.

### 6.3.18 Phase 6 final — Brand Brain's head, layers and provenance (D-294)

`/[locale]/brand-brain` keeps the ported orb, hero, area grid, intel and sources cards unchanged. The
page head's demo headline is replaced by the brand's name inside the same `.bb-page-head` `h2 strong`,
with the understanding sentence in its `p` and a neutral compact button. Below the hero, a four-tile
strip on `surface` with a `border` hairline and the `h3` type step, and a caption line of ghost buttons
for gaps. Provenance is a `micro` caption under each item in the area drawer. No new colour, font or
shadow; the orb is untouched.

### 6.3.19 Phase 6 final — the bell's feed (D-297)

The top bar's bell opens the existing `SideSheet` primitive (the same sheet the Calendar and Content
drawers use). Tabs are `neutral` / `ghost` small buttons in a wrapping row; rows are a two-column grid
with a `surfaceMuted` initial disc, a `bodySm` headline, the excerpt in `textSecondary`, and a
`caption` context line; unread adds a 3px `brandPurple` inline-start edge and the word "unread". The
empty state is `StateMessage`. No new colour, font, shadow or interaction model.

### 6.3.20 Phase 6 final — Billing & usage tabs, Team member column, post history (D-298)

Billing & usage uses the existing `LinkTabs` primitive above each tab's unchanged cards. Team's member
cell stacks a `bodySm` strong name, the address in `caption` / `textSecondary` and a `textMuted` joined
line beside the existing tile avatar. "This post's history" is a `CustomerCard` below the Notes panel
holding the campaign room's timeline list, now shared as `ActivityTimeline`. The Brand Brain head gains
a ghost small "Brand profile" button next to "Ask about this brand". No new colour, font or shadow.

### 6.3.21 Phase 6 final — empty-state actions and whole-screen states (D-299)

Empty-state actions are small `brand` (first step) or `neutral` (secondary) buttons in
`StateMessage`'s existing action slot. The route error and not-found pages centre the same
`StateMessage` on `shellSurface`, max 32rem, with the same small buttons and a `caption` / `textMuted`
reference line. No new colour, font, shadow or interaction model.

### 6.4 The chart primitives — a new visual treatment, and the reason for it

Rule 4 says a new component is a last resort carrying a recorded reason. This is that reason.

**There was nothing to reuse.** No approved demo screen contains a chart of any kind, and `packages/ui`
shipped none. Analytics without a trend line is a table, and a table alone is not what the module is for.

**Rule 5 is what shaped them.** The obvious design — one colour per series, a legend — needs a palette,
and the palette was measured rather than judged:

| Candidate                        | Result                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `#7935FE` (brand purple)         | **PASS** on every check: contrast, lightness band, chroma floor                    |
| `#FFDD15` (brand yellow)         | **FAIL** — 1.31:1 against the chart surface, and outside the usable lightness band |
| `#7935FE` + a second purple step | **FAIL** — the pair is below the normal-vision separation floor                    |

Inventing a third hue to make a legend work would be a **new colour family**, which rule 5 forbids
outright and which CLAUDE.md §4 forbids independently: purple is the single primary colour and yellow is
an accent that is never text without its darkened token.

**So the charts are single-hue, and identity is carried by something other than colour.** Each series is
named by its axis label and, where there are few enough, by a direct label at the start and end of the
line. Every chart ships with `ChartDataTable` — the same figures, in a real table, in the accessibility
tree — so a chart is never the only way to read a number. A gap in the data is drawn as a GAP rather than
a point at zero, because a bucket with no reading is not a measurement of none.

**RTL is a coordinate transform, not a second chart.** The same geometry is mirrored, so an Arabic
reader sees the same shape running the direction they read; nothing is re-authored and the two cannot
drift apart.

`ChangeIndicator` pairs an arrow GLYPH with its colour for the same reason, and renders nothing at all
when there is no comparison — an indicator with no baseline would be a direction with nothing behind it.

---

### 6.5 Phase 8 — the Brand Selector, and a conflict worth recording

**THE COMPONENT.** `BrandSwitcher` (`packages/ui/src/switchers.tsx`) is the workspace card's sibling,
not a second navigation system: the same `DropdownMenu`, the same `trigger="card"` surface, the same
`layoutTokens.railAvatar` tile, the same two lines of copy, the same tick-plus-`aria-current` marking
that never relies on colour alone. Two differences, both necessary and neither a new language:

- **The glyph.** `TagIcon`, drawn in `packages/ui/src/icons.tsx` to the same 24-unit box, 1.75 stroke
  and round joinery as every other icon in that file — §4.2 rule 5 forbids a second icon style, and a
  borrowed glyph is how one starts. A tag rather than a swatch because a brand here is an IDENTITY
  APPLIED TO WORK, not a colour.
- **The items are forms.** The workspace switcher navigates, because switching workspace rewrites the
  session the server already owns. A brand selection is remembered in a cookie and a link cannot set
  one, so each option posts to a server action — exactly the markup shape the profile card's sign-out
  already uses in the same rail.

**THE CONFLICT, STATED RATHER THAN RESOLVED SILENTLY.** The Phase 8 brief describes the Workspace
Selector as living "in the top bar" and asks for the Brand Selector beside it. In the IMPLEMENTED
product the Workspace Selector is `AppShell`'s `headerStart` — the rail's identity block (D-59) — and
the top bar carries review, notes, notifications, Copilot, the language square and the create action
(§9, §10; D-276 replaced the search control, which had no domain behind it).

Both instructions cannot be followed at once. The brand selector went to the RAIL, beneath the
workspace card, because:

1. "Beside the Workspace Selector" is the more specific instruction, and it is the one the brief
   repeats ("must visually belong beside the existing Workspace Selector").
2. A selector in the top bar would be separated from the thing it is scoped BY, and would add a
   second place where scope is chosen — the "second navigation system" the same brief forbids.
3. The rail's `headerStart` already renders in the mobile drawer, so the selector is usable on a
   phone without a desktop-only control being invented for it.

The order is containment: a brand lives inside a workspace, so it reads underneath it.

### 6.6 Phase 8 — media inside surfaces that already existed

Three ported or extended screens learned to show a real picture, and none of them was redesigned to
do it. The rule followed in every case: **the frame stays, the fill changes.**

- **`AssetMedia` and `AssetThumb`** (`packages/ui/src/media.tsx`) fill exactly the boxes
  `AbstractMedia` and `MediaThumb` fill — same size, same radius, same overflow — with a customer's
  bytes instead of a gradient. The abstract artwork is not replaced and is not deprecated: it is what
  a text-only post and every design-system fixture want, and a post genuinely without media must not
  look like a post whose media failed to load.
- **The post card, list row, calendar chip and detail drawer** each render through one pair of
  helpers, so no two of them can disagree about what a post looks like. `PostRecord.mediaSrc` is an
  opaque, expiring, per-viewer download grant — never a storage key and never a signed URL in a
  column.
- **`PostStatus` gained `PARTIALLY_PUBLISHED`** (D-201). This is a design-system CHANGE rather than
  an extension, and it earns that: the Calendar now reads the canonical slot, a post that went out on
  one platform and failed on another is neither published nor failed, and a card's accessible name
  states its status in words — so picking one of the two would announce the wrong thing as fact.
- **A plain `<img>` is used deliberately.** `packages/ui` is the design system and has no framework
  dependency; a Next.js image component here would make the package unusable outside that framework
  and would try to optimise a same-origin, short-lived, per-viewer grant, which is not a static asset
  and must not be cached by an optimiser.

### 6.7 Phase 9 — the one screen that is deliberately NOT ours

The development payment provider's hosted page (`apps/api`, `/billing/checkout/:id`) is **unbranded
on purpose**, and that is a fidelity decision rather than an omission.

In the story it is telling it is somebody ELSE's site: a real hosted checkout lives on the provider's
domain, and that separation is the whole PCI argument. Dressing it in BrandSpace's design system
would teach the team — and every screenshot, and every reviewer — that the payment page is ours, when
the entire point is that it is not. It uses system fonts, no tokens and no `packages/ui` component,
and it is not registered at all when `APP_ENV=production`.

It is listed here rather than left unexplained because a reader scanning for unstyled surfaces would
otherwise find it and reasonably file a bug.

### 6.8 Phase 10 — the Control Center's Integrations Hub

The manifest above covers CUSTOMER routes. The Control Center has never had a demo reference of any
kind — it is not in the Landing repository at all — and its screens have been composed from
`packages/ui` and the `admin-shell` primitives since Phase 2A. **Integrations** continues that, and is
recorded here because it is the largest admin screen added since.

**Composed from:** `PageIntro`, `SectionHeader`, `DataTable`, `Cell`, `EmptyState` and the existing
console button, input and typography styles — the identical composition the Secrets, Plans, Providers
and Routing pages already use. Nothing new was drawn.

**Two rules it follows that are easy to get wrong on a status screen:**

- **Colour is never the only carrier of meaning** (WCAG 2.2 AA 1.4.1). Every state is a WORD first and
  a colour second: "Active", "Not active", "Complete", "Incomplete", "Working", "Failed", "Never
  tested". A reader who cannot distinguish the two greens still reads the row correctly.
- **A refusal is a sentence, not a disabled control.** When a development double cannot be activated in
  production, the page says why and what to do instead. A greyed-out button teaches nothing, and an
  owner evaluating vendors is exactly the reader who needs the reason.

**The detail route** (`/console/integrations/[category]/[providerKey]`) is the same composition again,
with the masked-credential table using the console's existing mono-caption style for the hint and the
fingerprint. The change-reason input is the existing `inputStyle()`; the activate and disable controls
are `primaryButtonStyle()` and `secondaryButtonStyle()`.

**The configuration form added by the Phase 10 correction is composed, not drawn.** Every control is
the console's existing `inputStyle()` with `.bs-control`, laid out with the same label-above-field grid
the Secrets and Configuration pages already use; the generated-values table is the same `DataTable`.
Nothing new was created for it, which is why there is no new component to record here.

**Three things about it are product decisions rather than visual ones**, recorded because a reader
scanning the form will notice each and might reasonably file a bug:

- **A secret input is always empty, including on a provider that has one saved.** It is not a rendering
  oversight; nothing in this product can read a stored value back to pre-populate it. The field's help
  text says so, and the placeholder says what an empty box means.
- **A generated value renders as a read-only row, not an input.** A webhook URL is the address of one of
  our own routes, so an input for it would be a way to redirect a payment callback.
- **The form is generated from the registry.** A provider that declares no settings and no credentials —
  which is every development double except the payment one — correctly shows no form at all.

## 7. `/[locale]/overview` — the Command Center, extended rather than re-ported

> **Superseded in composition by D-277 §7 / D-279 (Phase 6 final).** The hero, its two floating
> cards, the metric card and the surface card keep the demo's geometry and treatment; what changed is
> the ORDER and CONTENT the owner specified: greeting + selected brand, then What needs you (one action
> per row), Recommended by BrandSpace (≤3 grounded insights), Notes from your team, Coming up this
> week (day-grouped), and the Performance snapshot LAST. The floating cards now carry the real 28-day
> engagement figure and the next scheduled item (the decorative mini chart is gone). Plan, credits,
> members, activity and the notification count left Home. The sections below describe the earlier
> composition and remain as history.

The Overview is the one 5B-3 screen with a REAL demo design behind it: `overview()` in
`demo/app-2.js`, whose hero, two floating cards, four-across metric row and 1.45/0.8 dashboard split
were ported during the design-system phase and are unchanged by this milestone.

**Phase 5B-3 changed what the panels CONTAIN, not what they are.** The composition, geometry and
spacing are untouched; four placeholders that stated what they could not yet measure now carry real
figures, and one new panel — "Needs your approval", which `docs/PRODUCT.md` §5.1 names first among
the Command Center's widgets — was composed from the same `Card` and `SectionHeader` as its
neighbours.

**What deliberately still does not carry a figure**, and why that is fidelity rather than an
omission: the demo captions its floating card "Engagement is up 18.4%" and its fourth metric
"Published 28 across 4 channels". Publishing is Phase 6 and analytics Phase 7, so both would be
fabricated measurements — `CLAUDE.md` §2.2, and rule 6 of §1 above. Their POSITION, TYPOGRAPHY and
TREATMENT are the demo's; only the content says what it will hold and that it holds nothing yet.
