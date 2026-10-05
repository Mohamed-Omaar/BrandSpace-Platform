# Prototype parity evidence (D-468)

Side-by-side screenshots for each ported batch: the vendored prototype
(`../prototype-2026-09-27/`, opened unchanged) on the left, the product on the
right, at 1440×900, in English and Arabic. Frame 1 is the first view; later
frames scroll the page's `<main>` one view at a time.

Regenerate with the opt-in spec (it writes the raw pairs; nothing is asserted):

```
BRANDSPACE_PARITY=1 BRANDSPACE_PARITY_DIR=<dir> npx playwright test tests/e2e/prototype-parity.spec.ts --project=chromium-desktop
```

The product side shows the deterministic E2E fixture workspace, so its names,
figures and greeting differ from the prototype's sample data by design.

- `batch-1/` — the app shell and Home.
- `batch-2-6/` — every other customer screen, frame 1 (`Auth.dc.html` for sign-in, sign-up and the
  setup wizard; the Copilot and notifications pairs open the panel on Home; the Approvals pair seeds
  one post in review on the E2E database first).
