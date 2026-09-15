# The UI Fidelity Contract

> **الملخص بالعربية**
>
> العرض التوضيحي المعتمد ليس مصدر إلهام — بل هو **المواصفة الملزمة** لواجهة المنتج.
> يجب نقل الشيفرة الأصلية كما هي، لا إعادة تصميمها. أي انحراف مقصود يحتاج قرارًا مسجّلًا.

**Status: binding on every customer-facing route from Phase 5A onward.**

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

| Deviation                                                                 | Authority        | Reason                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`copilotPanel()` — the composer's third column — is not rendered**      | Phase boundary   | The AI Copilot is Phase 7 (`docs/ROADMAP.md`). Shipping its markup with nothing behind it would be a screen that lies about what the product does. The `.composer` grid therefore carries two tracks (`minmax(350px,1fr) 340px`) rather than three; every other declaration is the demo's                                                     |
| **`socialPreview()`'s static mock becomes the generated variants**        | Rules 5 and 6    | The demo's second column is a hard-coded Instagram post with an invented sentence. It is replaced, in the same column and the same `surface-card`, by the real variants: the caption per channel, its count against that channel's CONFIGURED limit, the computed validation, the retrieved sources and the five editing tools                |
| **The "Campaign" and "Publish" pickers become Language and Content type** | Phase boundary   | Campaigns and scheduling belong to the Social Calendar, not to scope item 3. The `.form-row` geometry — `1fr 1fr`, `gap:10px`, collapsing to one column at 640px — is ported unchanged and carries this scope's own two controls                                                                                                              |
| **`.media-strip` and `.thumb` are not ported at all**                     | Rule 2           | Attaching media is the publishing pipeline's, and `content_variant.assetIds` has no customer-facing picker in this scope item. Porting a stylesheet for an element nothing renders would be dead code claiming to be fidelity                                                                                                                 |
| **Tabs are All / Drafts / In review / Archived**                          | Rules 5 and 6    | The demo's five tabs include Scheduled and Published, which are states Phase 5B-2 cannot reach — the schema's own comment says so. A tab that can only ever read zero is an invented number. The `.tabs` treatment, the counts' position and the `·` separator are unchanged                                                                  |
| **Real data replaces every demo literal**                                 | Rules 5 and 6    | `All · 28`, the eight invented posts, "NEW CHAPTER" and the scripted caption are demo values. Their POSITION, TYPOGRAPHY and TREATMENT are unchanged; the counts are `groupBy` results, the cards are real drafts and the art carries the draft's own title                                                                                   |
| **`post-art` gradients are chosen from the draft id**                     | Rule 5           | The demo assigns one of four gradients per invented card by hand. A real library has no such list, so the gradient is derived deterministically from the row's id: a draft keeps the same face across reloads, and the visual fixture renders the same page every run rather than one that has to be re-approved                              |
| **Physical directions become logical properties**                         | `CLAUDE.md` §4   | `text-align: left` on `.post-card` renders Arabic backwards. `text-align: start` is identical in LTR. The same one-class substitution the Brand Brain port records                                                                                                                                                                            |
| **`--muted` is one step darker (`#6A6A72`)**                              | `tokens.ts`      | The demo's `#717179` measures 4.44:1 on its own `--soft`, where the draft status pill and the search placeholder sit — under the AA 4.5:1 minimum at 8px and 9px. This is NOT a new decision: `packages/ui/src/tokens.ts` already carries `#6A6A72` as the platform's documented deviation for this exact value. Measured 4.92:1 on `#F5F5F6` |
| **A visible `:focus-visible` ring is added**                              | D-85's precedent | The demo sets `outline: 0` on every field and ships no focus rule at all — it is a prototype nobody tabs through. WCAG 2.2 AA requires a visible indicator. The ring is drawn OUTSIDE the control, so the approved resting appearance is unchanged                                                                                            |
| **The search field gains a visually hidden `<label>`**                    | `CLAUDE.md` §4   | The demo names its search box with a `placeholder` alone, which is not an accessible name. The placeholder stays exactly as the demo wrote it; the label is `.cs-sr-only` and changes no pixel                                                                                                                                                |
| **`.select-like` is a real `<select>`**                                   | Rule 5           | A `<div>` in the demo because a prototype has no options. The demo's own rule already groups `.select-like` with the filter-row buttons, so `.cs-select` carries those declarations verbatim                                                                                                                                                  |

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

| Route                | Why no reference                                                                                                                                                                                                                                                                                                                                                                                                                       | Composed from                                                                                                                                                                                                                                                                                                                                        | Recorded |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `/[locale]/assets`   | The demo's `#customer/media` route is `simpleFeaturePage('media')` — a "Future product preview" placeholder with three identical cards. No Asset Library design exists in the Landing repository at the pinned commit                                                                                                                                                                                                                  | `packages/ui` tokens and primitives; the shared dashboard shell; the demo's own `view-toolbar`, card, chip, drawer and empty-state geometry as already ported for Brand Brain and the members, plan and settings routes                                                                                                                              | D-98     |
| `/[locale]/calendar` | The demo's `#customer/calendar` route IS a design (`calendar()` in `demo/app-2.js`), and it was already PORTED into `packages/ui`'s `ContentCalendar` during the design-system phase — its month grid transcribes the demo's `.calendar`, `.weekday` and `.day` geometry. This route is not a second port of the same thing; it is that component with the workspace's own slots behind it, plus the three states the demo has none of | `packages/ui`'s `ContentCalendar` (the existing demo port), `Dialog`, `Field`, `StateMessage`, `Button` and the design tokens; the shared dashboard shell. The additions are live period navigation, a scheduling dialog and a slot dialog — composed from existing primitives, with no new colour, font, shadow, layout system or interaction model | D-118    |
