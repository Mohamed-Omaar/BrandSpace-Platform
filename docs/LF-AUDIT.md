# Look & feel — the pre-build audit (LF)

The short audit the owner's brief asks for before the Look & feel page (Control Center → Simple →
"Look & feel" / «الشكل»): what is configurable now, the tokens the page would drive, the schema
question, and the tests. Written after S6 merged (staging `08f6e7f`).

## 1. What is configurable now

- **Nothing about the look is configuration today.** Every value is a design token in
  `packages/ui/src/tokens.ts`, generated into the `:root` block of `tokens.css` (S2). Changing one
  means a release.
- **S4 left switches at their neutral value**, ready for a theme to set:
  - `--bs-motion-level`, `--bs-motion-speed` and `--bs-motion-scale` (every `--bs-dur-*` multiplies
    by the scale, and `prefers-reduced-motion` always wins);
  - `--bs-radius-scale`;
  - the `--bs-fx-*` blur values and `--bs-fx-backdrop-scrim`;
  - the sidebar widths (`--bs-sidebar-*`, `--bsp-sidebar-*`) and the content width
    (`--bs-shell-max-width`, `--bsp-frame-max-inline`).
- **Brand fonts are not the app's look.** They are per-brand customer content
  (`apps/dashboard/src/server/brand-fonts.ts`) and stay out of scope.
- **The configuration service already gives us everything the rules ask for:** draft, validate,
  preview (impact), activate, audit, roll back and history (`packages/config`). The Simple Control
  Center edits domains through it (`apps/admin/src/server/simple-areas`). Reads are cached for 30 s,
  so an activated look is visible within a minute.

## 2. The tokens the page would drive

| Control                              | Tokens                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Primary (scale generated)            | `--bs-brand-purple` and its `-hover`, `-pressed`, `-ink`, `-tint` and `-border` shades, `--bs-focus-ring`, plus the 23 purple `--bs-lit-7935fe-*` uses |
| Secondary, background, surface, text | `--bs-brand-yellow*`, `--bs-app-background` and the ambient gradient, `--bs-surface*`, `--bs-text-*`                                                   |
| Status                               | `--bs-success`, `--bs-warning`, `--bs-danger`, `--bs-info` and their tints                                                                             |
| Radius, shadows, density             | `--bs-radius-scale`, the `--bs-shadow-*` set, and a new `--bs-density` multiplier on control padding                                                   |
| Buttons, fields                      | the `--bs-btn-*` and `--bs-control-*` sets from S5 (fill, size, border width)                                                                          |
| Text                                 | `--bs-font-latin`, `--bs-font-arabic`, and new `--bs-font-scale` and `--bs-line-height-*` values                                                       |
| Motion, effects                      | `--bs-motion-level`, `--bs-motion-speed`, and the `--bs-fx-*` blur, gradient and glass switches                                                        |
| Layout                               | `--bs-sidebar-*`, `--bsp-sidebar-*`, `--bs-shell-max-width`                                                                                            |

**Two findings that set the size of the work:**

1. **The customer app hard-codes its colours.** The prototype stylesheets use **209 value-named
   colour tokens** (`--bs-lit-*`, 471 uses in `prototype.css`), including the purple shades. A new
   primary or a dark mode recolours only what reads a semantic token. Each `--bs-lit-*` needs a
   role: a semantic token, or a `color-mix()` of one. That role-mapping is the bulk of the colour
   and dark-mode work.
2. **The four fonts are already self-hosted** (corrected after the audit was sent: it first said
   none were). Cairo, Inter, IBM Plex Sans Arabic and Tajawal ship as OFL files in
   `apps/dashboard/public/fonts`, catalogued in `BUNDLED_FONTS` for brand fonts. The theme reuses
   them; the Control Center gets copies so its preview can draw them.

**Fidelity.** The original look is the prototype, unchanged (D-468). A theme is an owner-approved
deviation that applies only when the owner activates one, and "reset to the original look" brings
it back.

## 3. Schema change: none expected

- **The theme is a new configuration domain, `theme`.** `ConfigurationVersion.domain` is a plain
  string column, so the domain needs no migration.
- **Each user's light / dark / device choice is a cookie,** per device. Following a user across
  devices would need a column (`User.colorScheme`). If the owner wants that, the exact SQL is sent
  first.
- **Logos and the favicon go in the object store** through the existing upload safety rules (type
  sniffing, size limits, no SVG script). The theme document records only their keys.
- **The safe-mode recovery link reuses the platform session and MFA.** It needs no new table.

## 4. Tests

- **Unit:**
  - the theme schema and its defaults (the original look, value for value);
  - the primary-scale generator and the readable-text pick;
  - WCAG AA contrast validation: text, buttons and focus, in light and dark, en and ar, with a
    plain-language refusal reason;
  - the CSS-variable writer (the only output is variables, and it escapes values).
- **Integration:** draft → validate → activate → audit → undo → reset through the configuration
  service, against throwaway PostgreSQL.
- **E2E:**
  - the Simple page in en and ar;
  - the live preview (Home, Studio, a form with every field type, buttons in every state, a
    table, an empty state, sign-in);
  - an activated theme reaching the dashboard without a release;
  - the Control Center staying on the original look by default;
  - the recovery link restoring the original look.
- **Gallery:** baselines stay the original look. A theme never reaches the gallery's fixed
  screenshots.

## 5. Proposed order: four PRs instead of one

The spec is several weeks of work, so I propose four PRs, each reviewable on its own:

1. **LF-1 · the engine.** The `theme` domain, its validation (contrast included), the presets,
   writing the active theme as CSS variables in both apps, "Keep the Control Center on the
   original look" (ON by default), the safe-mode recovery link, and the ROADMAP "later" items.
2. **LF-2 · the page.** Simple → Look & feel: presets and "Save as my preset", colours with the
   generated scale, shape, buttons, fields, text size and line height, motion, effects and layout,
   with the live preview.
3. **LF-3 · dark mode.** Each `--bs-lit-*` mapped to a role, the generated and adjustable dark
   palette, and light / dark / device with each user's override.
4. **LF-4 · fonts and logo.** The self-hosted font list, and the logos for light and dark surfaces,
   the collapsed mark and the favicon.
