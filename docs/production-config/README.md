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
| `monthlyCredits`          | `plans.json`, `starter` | **500.** The trial grants the same 500 (`trialCredits`, D-556 a); Home reads "n of" the trial grant during the trial (D-514).                       |
| `quotas.workspaces`       | `plans.json`, `starter` | **1.** A trial owner can hold one workspace.                                                                                                        |
| `industries` (12)         | `onboarding.json`       | The twelve names and keys as written, with their question sets.                                                                                     |
| `recommendedHashtags`     | `content.json`          | instagram 3–5, tiktok 3–5, linkedin 1–3, x 1–2. Facebook has no entry: the `content` platforms list has none (instagram, linkedin, x, tiktok only). |
| `calendar.suggestedTimes` | `content.json`          | EG, SA and AE: 10:00, 16:00, 21:00. Shown as "Suggested time", never "best time" (D-329).                                                           |

### 5.1b Decided by the owner (#81 review)

Pinned by `tests/unit/pr-f-production-config.test.ts` ("the values the owner decided on the #81 review").

| Value       | Where          | Decided                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safeZones` | `content.json` | instagram and tiktok: `top` 13, `bottom` 22, `end` 16 (percent of a 9:16 frame). **DESIGN GUIDANCE** — the bands the approved prototype draws (`Main.dc.html` lines 462 and 489), not values Meta or TikTok publish; replace them with the platforms' own templates when the owner has them (D-500, D-505). linkedin and x have none (no 9:16 preview). |

**Also decided on the #81 review** (pinned by the same test block):

| Value                       | Where                        | Decided                                                                                                                                                                                    |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dailyPublishCap`           | `publishing.json`, instagram | **25** posts per account per rolling 24 hours (Instagram's own `quota_total`, when lower, still wins).                                                                                     |
| `expiringSoonHours`         | `publishing.json`, instagram | **168** (7 days). Instagram's long-lived token lasts about 60 days, so it is warned about a week ahead with the existing notice. Every other platform: `null`, the dispatch window (24 h). |
| `facebook` content platform | `content.json`, `platforms`  | **Added**: 2,200 characters, 30 hashtags, no first comment, 10 media items (the same limits its publishing entry enforces). No recommended hashtag range, no safe zones.                   |

#### Adding Facebook to the `content` document on staging (Control Center)

1. Open `/en/console/configuration?domain=content` on the **staging** Control Center.
2. Change reason, for example "#81: Facebook as a content platform".
3. Press **Create draft** (it starts as a copy of the active document).
4. In `platforms`, add this object (after the `instagram` entry), and change nothing else:

   ```json
   {
     "key": "facebook",
     "labelKey": "content.platform.facebook",
     "maxBodyChars": 2200,
     "maxHashtags": 30,
     "allowsFirstComment": false,
     "maxMediaItems": 10
   }
   ```

5. **Save**, then **Validate**, then **Activate**.
6. Customers can write Facebook versions at once; a Facebook post goes out only once Facebook is
   switched on in `publishing` (§5.1c) and an account is connected. Until then it is held (D-531).

### 5.1c Meta (connectors step B) — proposed, for the owner to confirm before Facebook or Instagram is switched on

Both stay `enabled: false` in `publishing.json`. Every value below is from Meta's own documentation (D-505), cited in
`docs/SOCIAL-INTEGRATIONS.md` §18; nothing here is switched on by a deploy.

| Value                   | Where                                   | Proposed                                                                                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiVersion`            | `publishing.json`, facebook + instagram | **`v26.0`**, the current Graph API version (announced 2026-07-29). Move it when Meta deprecates it; the adapters read nothing else.                                                                                                                                        |
| `dailyPublishCap`       | `publishing.json`, instagram            | **25 — approved (#81).** Meta's own pages disagree (100 on the publishing guide, 50 on the `content_publishing_limit` reference), so it is half the lower figure; the platform's own `quota_total`, when lower, wins anyway. Facebook: `null` (Meta states no such cap).   |
| `scopes`                | `publishing.json`                       | facebook: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`. instagram: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`. With a Facebook Login for Business configuration id, the configuration decides instead. |
| `postKinds`             | `publishing.json`                       | facebook: text, image, carousel (several photos on one post). instagram: image, carousel (images), reel. Video on Facebook, stories, and a carousel with a video are not published in step B.                                                                              |
| `targetKind`            | `publishing.json`                       | facebook `page`, instagram `business_account`.                                                                                                                                                                                                                             |
| `mediaByUrl`            | `publishing.json`                       | **true** for both: Meta fetches the picture or video from a short-lived pre-signed URL (D-505 O1).                                                                                                                                                                         |
| `facebook` in `content` | `content.json`, `platforms`             | **Added (#81).** See §5.1b for the entry and the staging steps.                                                                                                                                                                                                            |

### 5.1d TikTok (connectors step C) — proposed, for the owner to confirm before TikTok is switched on

Stays `enabled: false` in `publishing.json`. Values from TikTok's own pages (D-505), cited in
`docs/SOCIAL-INTEGRATIONS.md` §19.

| Value            | Where                     | Proposed                                                                                                                                                           |
| ---------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apiVersion`     | `publishing.json`, tiktok | **`v2`** — the Open API version in every TikTok path.                                                                                                              |
| `forcedAudience` | `publishing.json`, tiktok | **`private`** until TikTok audits the app: every post is "Only me" and the Studio offers only that. Set to `null` once the audit passes — configuration, not code. |
| `postKinds`      | `publishing.json`, tiktok | **`video`** only. Photos need `mediaByUrl: true` and a storage domain verified with TikTok; add `image` / `carousel` only after that.                              |
| `scopes`         | `publishing.json`, tiktok | `user.info.basic`, `video.publish`.                                                                                                                                |
| `rateLimit`      | `publishing.json`, tiktok | 6 requests per 60 s per account (TikTok's limit on the post init calls).                                                                                           |
| `mediaRules`     | `publishing.json`, tiktok | video: MP4, MOV or WebM, at most 4 GB and 600 s (TikTok's API maximum; each creator's own maximum is checked before posting).                                      |
| `maxMediaItems`  | `publishing.json`, tiktok | 1 (one video).                                                                                                                                                     |

### 5.2 Still proposed

| Value                                                              | Where                   | Proposed                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan description                                                   | `plans.json`, `starter` | "For a business running one brand on social media." / «لنشاط تجاري يدير علامة تجارية واحدة على وسائل التواصل.» The Arabic name stays `Starter`: the glossary has no plan names.                                                           |
| `steps`                                                            | `onboarding.json`       | workspace, brand, brand_profile (required); social, team, plan (optional). No `brand_brain`. `plan` is optional because it is only complete with a **paid** subscription, which cannot happen while payments are off.                     |
| Currency names                                                     | `commerce.json`         | "US dollar" / «دولار أمريكي», "Saudi riyal" / «ريال سعودي».                                                                                                                                                                               |
| Markets and tax policies                                           | `commerce.json`         | **None.** Validation requires none, and the trial needs none: workspaces are created in USD without a market. Before payments are switched on, add the markets (with `planKeys`) and their tax policies. Tax rates are an owner decision. |
| `sortOrder`, `upgradeBehavior`, `downgradeBehavior`, `taxBehavior` | `plans.json`            | Schema defaults (`exclusive` tax, immediate prorated upgrade, period-end read-only downgrade).                                                                                                                                            |
