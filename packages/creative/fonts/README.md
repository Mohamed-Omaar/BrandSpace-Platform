# Fonts for headlines drawn on images (PR B, D-607)

The same bundled families the product offers for a brand's typography (`BUNDLED_FONTS` in
`@brandspace/shared`), copied from `apps/dashboard/public/fonts`. Each directory keeps its `OFL.txt`:
every family here is licensed under the SIL Open Font License 1.1, which allows commercial use and
bundling with software. IBM Plex Sans Arabic is the default headline font (owner, 2026-11-14).

Server-side only: `packages/creative/src/composite.ts` registers a family with `@napi-rs/canvas` when
a headline uses it. A font a customer uploaded is never used for this.
