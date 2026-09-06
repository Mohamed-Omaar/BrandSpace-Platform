# The approved visual reference

`index.html`, `styles.css` and `app.js` in this directory are the owner-approved
visual demo, vendored **verbatim** from the files supplied for review. They are
the authority for the platform's visual direction (D-59).

They are kept here, in the repository, for one reason: the direction was
approved against *these exact files*, and a link to a hosted demo is not
durable evidence — the host can change, expire or become unreachable, and it
already did. Anyone reviewing a screen against "the approved design" needs the
thing that was approved, not a description of it.

## Rules for this directory

- **Never edited, formatted or linted.** It is excluded from ESLint and from
  Prettier for exactly that reason: a reformatted copy is no longer a copy.
- **Never imported, built or served.** No application code depends on anything
  here. It is documentation.
- **Never a source of truth for behaviour.** The reference is a static
  prototype: its posts are a hard-coded object, its buttons switch a CSS class,
  and nothing in it is connected to a database, a permission or a tenant.
  Existing BrandSpace functionality and security remain the technical source of
  truth, as §2 of the brief requires.

## Where the reference was deliberately not followed

Reproduced faithfully in almost every respect. Four departures, each made for a
reason that is recorded rather than hidden — see `docs/DECISIONS.md` (D-59) for
the full text:

| Reference | What ships | Why |
| --- | --- | --- |
| `--muted: #707077` | `textMuted: #6A6A71` | The reference's muted text is 4.39:1 on the reference's own `#F2F2F2` ground — below WCAG AA for normal text. `#6A6A71` is the nearest value that clears 4.5:1 on all fourteen surfaces in this system. |
| `outline: 3px solid rgba(121,53,254,.32)` | 2px solid `#7935FE` | The reference's focus ring composites to `#D4BEFF` on white — 1.67:1, far below the 3:1 WCAG 2.4.11 requires of a focus indicator. Solid purple is 5.59:1. |
| A 68px icon rail below 780px | An accessible drawer below 768px | §6 of the brief requires a real mobile drawer with focus management, Escape and focus return. A permanent rail on a 390px screen also costs a sixth of the only scarce dimension. |
| Tooltips via `:hover::after` | `role="tooltip"` on hover **and** `:focus-visible` | A CSS pseudo-element cannot be reached by keyboard and is not in the accessibility tree, so the collapsed sidebar would have been unusable without a mouse (WCAG 1.4.13). |

Two more values are not reproduced at all: the reference's 8–9px type
(`.calendar-post small`, `.timestamp`, `.post-art small`) and its
`.day.faded { color: #b8b8bd }` on `#fafafa`, which is 1.89:1. Out-of-month
calendar days are quieted with a surface change instead of washed-out grey —
the F-28 lesson.
