# Owner Control Center — Simple and Advanced mode review set

Final screenshots for owner review (D-307 … D-314, `docs/ADMIN-CONTROL-CENTER.md` §23), captured from
the real application against a freshly reset and seeded local database. Nothing here is mocked. The
seed is the end-to-end fixture set, so the data is honest but small: five customers, two fixture plans
and development stand-ins for AI and social.

- `NN-<screen>-<en|ar>-<desktop|mobile>.png`: every Simple screen at 1440px and 390px, in English
  (LTR) and Arabic (RTL). Screens: Home, Customers, Customer detail, Plans & Pricing, Plan edit,
  Features, AI, Connect AI, AI profile, Integrations, Integration setup, Usage & Billing, System.
- `00-mode-switch-<simple|advanced>-<locale>.png`: the top bar in each mode.
- `14-advanced-overview-*` and `15-advanced-configuration-*`: Advanced mode, unchanged.
- `16-simple-mode-on-an-advanced-screen-*`: an Advanced screen opened in Simple mode. It renders with
  a note offering the switch, and is never redirected or hidden.

The Features screen shows its empty state because the seed registers no features. The E2E suite
creates one and exercises the on/off flow (`tests/e2e/owner-simple-mode.spec.ts`).
