# Phase 5A — Brand Brain, as built

Screenshots of the real screen, taken from the production build against the end-to-end database.
Nothing here is a mockup: every number on these pages was computed from stored rows.

| File                         | What it shows                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `brand-brain-desktop-en.png` | The screen at 1280×900. Hero, interactive orb with its six knowledge nodes, computed completion, live counts, and the attention card                               |
| `brand-brain-desktop-ar.png` | The same screen in Arabic at 1280×900. RTL throughout — the rail, the orb stage, the cards and the chat launcher all mirror                                        |
| `brand-brain-mobile-en.png`  | 390×844. The hero collapses to one column; zero horizontal overflow                                                                                                |
| `brand-brain-mobile-ar.png`  | 390×844 in Arabic                                                                                                                                                  |
| `brand-brain-drawer-en.png`  | The knowledge-area drawer open on Tone of Voice, showing a real item with its version and origin, the computed status, the review queue and the add-knowledge form |
| `brand-brain-chat-en.png`    | The chat panel — fixed height, its own scroller, retention notice under the composer                                                                               |

## What to look for

**The numbers are real.** The approved demo hard-codes 82% completion, 128 knowledge items and
4 source documents. None of those appear. A brand with one approved item reads 5%, and an empty one
reads 0% — an end-to-end test asserts the screen does NOT show the demo's figures.

**The orb is a component, not a pasted script.** One animation frame, cancelled on unmount and when
the tab is hidden; `prefers-reduced-motion` draws a single static frame rather than hiding the map;
and if the canvas is unavailable the nodes still render and still work, because they are DOM buttons
positioned by CSS over a decorative canvas.

**The drawer is genuinely modal.** Focus moves in on open and returns to the trigger on close, Tab
wraps inside it, Escape closes, and every sibling of the panel is marked `inert` — an overlay stops
clicks but does not stop Tab.

## How these were taken

The production build of `apps/dashboard` served on port 3101 against the `.env.test` database, with
`apps/api` on 3103 for chat. The same flows are asserted by `tests/e2e/brand-brain.spec.ts`
(22 tests), including axe WCAG 2.2 AA in both locales.
