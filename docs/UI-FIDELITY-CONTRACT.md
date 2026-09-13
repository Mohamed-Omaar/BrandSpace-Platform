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

| Route                   | Authoritative source          | Upstream repo                           | Pinned commit                              | SHA-256                                                            |
| ----------------------- | ----------------------------- | --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `/[locale]/brand-brain` | `demo/brand-brain-native.css` | `Mohamed-Omaar/Brandspace-Landing-page` | `b01d94738672c64f651098512c03faf4554ebb97` | `e5b8ca5308a6bc84db4789e6424328fe7ea85086e310abbab6aa124820081034` |
| `/[locale]/brand-brain` | `demo/brand-brain-native.js`  | `Mohamed-Omaar/Brandspace-Landing-page` | `b01d94738672c64f651098512c03faf4554ebb97` | `dc91db029fb8388aece3b47cdb00de05b654002f2c1df8efd458803722591085` |
| `/[locale]/brand-brain` | `demo/brand-brain-nav.js`     | `Mohamed-Omaar/Brandspace-Landing-page` | `b01d94738672c64f651098512c03faf4554ebb97` | `9dd56cfb137633dabf89e8b62c530de8551530dc49775c40eb56d81ec4d80e91` |
| `/[locale]/brand-brain` | `demo/index.html` (host page) | `Mohamed-Omaar/Brandspace-Landing-page` | `b01d94738672c64f651098512c03faf4554ebb97` | `0bae6b9e58c203bff107f3eb23c1b92e716e25000867ca5d232a7d68f327b893` |

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

| Deviation                                            | Authority       | Reason                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`prefers-reduced-motion` draws one static frame**  | D-85            | The demo implements no reduced-motion path at all — it is a prototype. `CLAUDE.md` §4 sets WCAG 2.2 AA as a product requirement, which outranks a prototype's omission. The accommodation SHOWS the same orb; it only stops animating, so a reader who asked for less motion still gets the knowledge map |
| **Real data replaces every demo literal**            | Rule 5 and 6    | 82%, 128, 4, "12 facts · complete" and the rest are demo values. Their POSITION, TYPOGRAPHY and TREATMENT are unchanged; only the numbers come from the database                                                                                                                                          |
| **Ten area cards below the hero; six orbit nodes**   | The demo itself | The demo's orb carries exactly six nodes and its card grid carries eight. The product has ten areas, all of which appear in the grid below the hero. The ORB keeps the demo's six — adding four would be a redesign                                                                                       |
| **Five small-text colours darkened for contrast**    | D-89            | Five of the demo's greys and greens fall below the WCAG 2.2 AA 4.5:1 minimum at the sizes it uses them. Each is replaced by the nearest darker step of the SAME hue, listed with its measured before/after ratio in `packages/ui/src/brand-brain.css` §2. `.bb-count` takes the demo's own `--bb-muted`   |
| **Physical directions become logical properties**    | `CLAUDE.md` §4  | `text-align: left`, `margin-left` and `margin-right` render Arabic backwards. The logical equivalents produce an identical result in LTR. The full mapping is in `tests/unit/ui-fidelity-manifest.test.ts` so a real drift cannot hide behind it                                                          |
| **The progress bar's fixed `width: 82%` is dropped** | Rule 5          | The demo hard-codes the bar at its invented completion figure. The real width is the computed percentage, set inline from server data                                                                                                                                                                     |

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
- **Numerical screenshot comparison.** Playwright snapshot assertions against committed baselines, with
  animation frozen and dynamic content masked.

A baseline is never updated to make a failing test pass. It changes only when §3's pinned commit
changes or an owner authorises a deviation under rule 9.
