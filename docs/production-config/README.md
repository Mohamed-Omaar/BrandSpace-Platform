# Production configuration for the closed beta (PR F)

## 1. What these files are

Each `*.json` file in this folder is one configuration document. It is the exact JSON you paste
into a draft in the Control Center, for the **production** environment. Each file is a complete
document, so pasting it replaces the whole draft.

Nothing here runs against production. No script reads these files at deploy time. They change
nothing until you paste them and press Activate. `tests/unit/pr-f-production-config.test.ts`
checks that every file passes the real schema and the real validation, with the other files as
context.

| File                      | Domain               | Dual control |
| ------------------------- | -------------------- | :----------: |
| `plans.json`              | `plans`              |     yes      |
| `commerce.json`           | `commerce`           |     yes      |
| `credits.json`            | `credits`            |     yes      |
| `onboarding.json`         | `onboarding`         |      no      |
| `integrations-email.json` | `integrations.email` |      no      |
| `publishing.json`         | `publishing`         |      no      |
| `content.json`            | `content`            |      no      |
| `assets.json`             | `assets`             |      no      |
| `entitlements.json`       | `entitlements`       |      no      |
| `feature-flags.json`      | `feature-flags`      |      no      |

**Activate in this order:**

1. `plans`. Commerce markets name plan keys, so plans go first. The beta's `commerce.json` has
   no markets yet, but keep the order: it is the order that stays correct once markets exist.
2. `commerce`
3. `credits`
4. `onboarding`
5. `assets`
6. `publishing`
7. `content`
8. `entitlements`
9. `feature-flags`
10. `integrations.email`, last, and through the Integrations screen (see §3.1), not by pasting.

`entitlements.json` and `feature-flags.json` are the schema defaults (empty lists). That is the
correct production document. The plan's quotas become `limit.*` entitlements automatically
(`packages/entitlements/src/service.ts`, `projectPlanQuotas`). `feature.multi_brand` is
registered by nobody, so it resolves as unknown and fails closed: the trial plan does not get
several brands (D-327, D-501). AI is off, so no AI feature is granted. Activating the two empty
documents is optional; it records the decision in the version history.

## 2. Control Center steps, for each domain

You need `platform.configuration.manage` to create and save a draft, and
`platform.configuration.activate` to activate it. Every step needs verified MFA.

1. Open `/en/console/configuration?domain=<domain>` on the production Control Center. The
   page works on the environment the Control Center runs in (`APP_ENV=production`).
2. Type a change reason of 8 characters or more. For example: "PR F beta values".
3. Press **Create draft**. The draft starts as a copy of the active document, or of the
   defaults.
4. Replace the whole draft JSON with the file's content.
5. Press **Save**.
6. Press **Validate**. Fix any error before you go on. A warning does not block.
7. If the preview lists high-impact changes, tick the acknowledgement.
8. Press **Activate**. Validation runs again at activation, against the documents active at
   that moment.

**Dual control.** `plans`, `commerce`, `credits` and `ai.credit-rules` are financial domains
(`DUAL_CONTROL_DOMAINS` in `packages/config/src/service.ts`). The person who created the draft
may not activate it, unless that person holds the `platform_owner` role. With only the owner
account, the owner can draft and activate. With a second staff member, one drafts and the other
activates.

## 3. Secrets in the Control Center

### 3.1 Email (Resend)

Use **Integrations → Email → Resend** (`/en/console/integrations?category=email`). Prefer this
screen to pasting `integrations-email.json`. It writes the API key into the secret vault and the
document together:

1. Verify the sending domain first. See [`EMAIL-DNS.md`](./EMAIL-DNS.md).
2. Enter the Resend API key (Sending access, restricted to `brandspace.cc`), the From address
   `noreply@brandspace.cc`, the From name `Brandspace` and the Reply-To `support@brandspace.cc`.
3. Press **Save**. The key is stored under the reference
   `integration/email/resend/production/apiKey`. That is the reference in
   `integrations-email.json` (`integrationSecretRef` in `packages/integrations/src/registry.ts`).
4. Press **Test connection**. It sends one short message to your own signed-in address and to
   nobody else, using the saved key and From address; check that inbox. The result reads "Sent a
   test message to your address" or names why it failed, never the key. The readiness row turns
   Ready once this passes (D-516).
5. Press **Activate**. This creates and activates the same document as `integrations-email.json`.
6. Confirm delivery once more with one real signup to an address you control
   (`docs/RAILWAY-SMOKE-TEST.md` §7.2).

If you paste `integrations-email.json` instead, save the key on the Integrations screen **first**.
The document only holds the reference. Without a stored secret under that reference, every email
fails.

The key is never shown again after saving. Only a mask, a fingerprint and the date are shown.

### 3.2 Storage (Cloudflare R2)

Storage has **no form** in the Control Center. It is configured only by the deployment's
environment variables, on the **dashboard**, **api** and **worker** services:

- `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`
  (all four, or none)
- optional: `STORAGE_REGION` (leave unset for R2), `STORAGE_FORCE_PATH_STYLE` (leave unset for R2)

Why: the object store is built inside request handlers and worker jobs, before any configuration
could be read. It sits beside `DATABASE_URL` and `REDIS_URL` as infrastructure. A form would be a
second place to configure one thing, and the processes would ignore it (`cloudflare-r2` entry in
`packages/integrations/src/registry.ts`). The admin service gets no `STORAGE_*`: it never moves
file bytes. Production and staging must use different buckets and different keys.

The readiness row for storage reads the `integrations.storage` document. To make the row show
Cloudflare R2, press **Activate** on Integrations → Storage → Cloudflare R2. That writes only the
record; the processes still read the environment. Then press **Test connection**: the Control
Center asks the API to write, read back and delete one small file with the API's own bucket key,
and shows only whether each step worked (no bucket, endpoint or key). The row reads Ready once
the Test passes (D-516).

### 3.3 Malware scanner

Off for the beta (owner decision Q13). `assets.json` sets
`scanning: { required: false, provider: "none" }`. Uploads become usable without a scan, and each
one is recorded as not scanned. The readiness row reads "Beta only".

To turn Scanii on later:

1. On the **worker** service only, set `SCANII_API_KEY` and `SCANII_API_SECRET`.
2. In the `assets` document, set
   `"scanning": { "required": true, "provider": "scanii", "timeoutMs": 30000, "scanii": { "endpoint": "<Scanii's regional /v2.2/files URL copied from Scanii's docs>" } }`.
   The endpoint must be `https://`. Validation refuses `scanii` without an endpoint.
3. Validate and activate as in §2.

## 4. Marking the legal documents reviewed

The Terms and Privacy pages are a first draft, not reviewed by a lawyer. Until they are, the
readiness row reads "draft, legal review pending" (Beta only).

After a lawyer reviews the text: in the `onboarding` document, set `"reviewed": true` on each of
the two `legalDocuments`, then validate and activate. The readiness row then reads "Reviewed".

If the reviewed text changes, publish it with a new `version` (and the same new value in
`LEGAL_VERSION`, `apps/dashboard/src/legal/documents.ts`). People then accept the new version.
A new version starts as `"reviewed": false` again.

## 5. Values: confirmed, and still proposed

Everything not listed here is an owner decision already recorded (D-07 to D-12, D-501, Q6, Q7,
Q13, D-481) or a schema default.

### 5.1 Confirmed by the owner (#79 review, 2026-10-12)

These are pinned by `tests/unit/pr-f-production-config.test.ts` ("the values the owner confirmed
on the #79 review"); changing one fails that test.

| Value                     | Where                   | Confirmed                                                                                                                                           |
| ------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monthlyCredits`          | `plans.json`, `starter` | **500.** During the trial Home reads "n of" the trial grant (200), not of 500 (D-514).                                                              |
| `quotas.workspaces`       | `plans.json`, `starter` | **1.** A trial owner can hold one workspace.                                                                                                        |
| `industries` (12)         | `onboarding.json`       | The twelve names and keys as written, with their question sets.                                                                                     |
| `recommendedHashtags`     | `content.json`          | instagram 3–5, tiktok 3–5, linkedin 1–3, x 1–2. Facebook has no entry: the `content` platforms list has none (instagram, linkedin, x, tiktok only). |
| `calendar.suggestedTimes` | `content.json`          | EG, SA and AE: 10:00, 16:00, 21:00. Shown as "Suggested time", never "best time" (D-329).                                                           |

### 5.2 Still proposed

| Value                                                              | Where                   | Proposed                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan description                                                   | `plans.json`, `starter` | "For a business running one brand on social media." / «لنشاط تجاري يدير علامة تجارية واحدة على وسائل التواصل.» The Arabic name stays `Starter`: the glossary has no plan names.                                                           |
| `steps`                                                            | `onboarding.json`       | workspace, brand, brand_profile (required); social, team, plan (optional). No `brand_brain`. `plan` is optional because it is only complete with a **paid** subscription, which cannot happen while payments are off.                     |
| Currency names                                                     | `commerce.json`         | "US dollar" / «دولار أمريكي», "Saudi riyal" / «ريال سعودي».                                                                                                                                                                               |
| Markets and tax policies                                           | `commerce.json`         | **None.** Validation requires none, and the trial needs none: workspaces are created in USD without a market. Before payments are switched on, add the markets (with `planKeys`) and their tax policies. Tax rates are an owner decision. |
| `sortOrder`, `upgradeBehavior`, `downgradeBehavior`, `taxBehavior` | `plans.json`            | Schema defaults (`exclusive` tax, immediate prorated upgrade, period-end read-only downgrade).                                                                                                                                            |
