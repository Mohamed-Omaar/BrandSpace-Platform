# Control Center settings inventory

> **بالعربية باختصار:** هذه قائمة بكل إعداد تقرؤه المنصة: أين يظهر في الوضع البسيط (قبل هذا التغيير وبعده)، وماذا يفعل في جملة واحدة، وهل يمكن للمالك تغييره بأمان بنفسه أم أنه تقني أو حساس فيبقى في الوضع المتقدم مع عبارة «يغيّره المطوّر».

Owner decision (Control Center Simple mode, D-558): the Simple mode is the owner's everyday
control panel. This is item 1(a) of that decision — **every setting the platform reads**, and for
each one:

- **Simple before** — whether the owner could see/change it in Simple mode before this change.
- **Simple now** — where it lives now: a card page (`edit`), shown read-only as "Changed by your
  developer" (`shown`), or not on a Simple page (`—`; Advanced → Configuration has every one).
- **What it does** — one plain sentence.
- **Owner?** — `safe` (the owner may change it himself) or `risky` (technical or easy to get
  wrong: it stays in Advanced, and the Simple page shows it as "Changed by your developer").

Every setting below lives in a versioned configuration document (CLAUDE.md §2.2). Simple and
Advanced change them through the same Configuration Service — draft, validate, impact preview,
activate, audit (D-312). Secrets are never configuration values; they appear here only as
"keys", which are set in the guided set-ups and never shown.

## Plans — `plans` (Simple: **Plans & Pricing**, one card per plan)

| Setting                                                 | What it does                                                       | Simple before        | Simple now                                      | Owner?                   |
| ------------------------------------------------------- | ------------------------------------------------------------------ | -------------------- | ----------------------------------------------- | ------------------------ |
| `key`                                                   | The plan's short name inside the platform.                         | edit (new plans)     | edit (new plans; locked after)                  | safe                     |
| `name` (en/ar)                                          | The plan name customers see.                                       | edit                 | edit                                            | safe                     |
| `description` (en/ar)                                   | One line under the name.                                           | edit                 | edit                                            | safe                     |
| `status` + `visibility`                                 | Whether the plan is on sale, unlisted, not ready or archived.      | edit                 | edit ("Who can choose it"), Archive             | safe                     |
| `prices[].monthlyMinor` / `annualMinor`                 | The price customers see (payments are off).                        | edit                 | edit, per currency                              | safe                     |
| `trialDays`                                             | How long the free trial lasts.                                     | edit                 | edit (Free trial on/off + days)                 | safe                     |
| `trialCredits`                                          | Credits a new workspace receives when its trial starts.            | edit                 | edit                                            | safe                     |
| `monthlyCredits`                                        | Credits a paying workspace receives each month.                    | edit                 | edit                                            | safe                     |
| `quotas.brands`                                         | Brands per workspace.                                              | edit                 | edit (number or "No limit")                     | safe                     |
| `quotas.workspaces`                                     | Workspaces per owner.                                              | edit                 | edit                                            | safe                     |
| `quotas.seats`                                          | Team members per workspace.                                        | edit                 | edit                                            | safe                     |
| `quotas.socialAccounts`                                 | Social accounts per workspace.                                     | edit                 | edit                                            | safe                     |
| `quotas.scheduledPostsPerMonth`                         | Scheduled posts per month.                                         | edit                 | edit                                            | safe                     |
| `quotas.storageGb`                                      | Storage per workspace.                                             | edit                 | edit                                            | safe                     |
| `quotas.automationAiActionsPerMonth`                    | AI actions automations may take each month.                        | edit                 | edit (on/off + number)                          | safe                     |
| `quotas.trialAutomationAiActionsPerMonth`               | The same during the trial.                                         | edit                 | edit                                            | safe                     |
| `quotas.analyticsRetentionDays`                         | How long performance data is kept.                                 | edit                 | shown                                           | risky                    |
| `tier`, `sortOrder`                                     | Order of plans and which is "lower" (decides the trial plan).      | —                    | — (set on create)                               | risky                    |
| `badge`                                                 | A small label on the plan card.                                    | —                    | —                                               | safe (not yet in Simple) |
| `taxBehavior`                                           | Whether prices include tax.                                        | —                    | shown                                           | risky                    |
| `trialRequiresCard`                                     | Whether a card is needed to start a trial (payments are off).      | —                    | —                                               | risky                    |
| `creditRollover`                                        | Whether unused credits carry over.                                 | —                    | shown                                           | risky                    |
| `addOns`                                                | Extras sold with the plan.                                         | —                    | shown                                           | risky                    |
| `overagePolicy`, `upgradeBehavior`, `downgradeBehavior` | What happens over a limit, on upgrade, on downgrade.               | —                    | —                                               | risky                    |
| Included features                                       | Which plan-decided features the plan gets (`entitlements` grants). | edit (Features page) | edit on the plan card **and** the Features page | safe                     |

## Trial and credits — `credits`, and the trial plan (Simple: **Trial & credits**)

| Setting                                                    | What it does                                                          | Simple before      | Simple now                    | Owner? |
| ---------------------------------------------------------- | --------------------------------------------------------------------- | ------------------ | ----------------------------- | ------ |
| Trial plan's `trialDays`, `trialCredits`, `monthlyCredits` | What a new workspace gets (the cheapest active plan with trial days). | edit (on the plan) | edit (card "A new workspace") | safe   |
| `planGrantExpiryMonths`                                    | When plan credits expire (0 = never).                                 | —                  | edit                          | safe   |
| `promotionalExpiryMonths`                                  | When gift credits expire.                                             | —                  | edit                          | safe   |
| `purchasedPackExpiryMonths`                                | When bought credits expire.                                           | —                  | edit                          | safe   |
| `lowBalanceThresholdPercents`                              | When customers are warned they are running low.                       | —                  | edit (two warnings)           | safe   |
| `hardStopAtZero`                                           | AI actions stop at zero credits.                                      | —                  | shown                         | risky  |
| `consumptionOrder`                                         | Which credits are used first.                                         | —                  | shown                         | risky  |
| `reservationTimeoutSeconds`                                | How long credits are held for an action in progress.                  | —                  | shown                         | risky  |

## Channels and publishing — `content.platforms`, `publishing` (Simple: **Channels**, **Publishing**)

| Setting                                                                                               | What it does                                                          | Simple before        | Simple now                                                   | Owner?       |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------ | ------------ |
| `content.platforms` membership                                                                        | Whether a channel appears in "Post to", the Calendar and Automations. | —                    | edit (Shown to customers; hiding refused while posts use it) | safe         |
| `content.platforms[].maxBodyChars`                                                                    | Longest post text the Studio allows.                                  | —                    | edit (never above the channel's own limit)                   | safe         |
| `content.platforms[].maxHashtags`                                                                     | Most hashtags the Studio allows.                                      | —                    | edit                                                         | safe         |
| `content.platforms[].maxMediaItems`                                                                   | Most pictures/videos on one post.                                     | —                    | edit                                                         | safe         |
| `content.platforms[].allowsFirstComment`                                                              | Whether a first comment can be added.                                 | —                    | edit                                                         | safe         |
| `content.platforms[].labelKey`                                                                        | The name key the Studio uses.                                         | —                    | shown                                                        | risky        |
| `publishing.providers[].postKinds`                                                                    | Post formats offered for the channel.                                 | —                    | edit                                                         | safe         |
| `publishing.providers[].enabled`                                                                      | Whether customers may connect and publish.                            | edit (Integrations)  | edit (refused for a channel with no connector)               | safe         |
| `publishing.providers[].dailyPublishCap`                                                              | Most posts per account per day.                                       | —                    | edit                                                         | safe         |
| `publishing.providers[].apiVersion`, `scopes`, `rateLimit`, `mediaRules`, `expiringSoonHours`, `max*` | The platform's own API facts and limits.                              | —                    | shown                                                        | risky        |
| `publishing.retry.maxAttempts`                                                                        | Attempts before a post is marked failed.                              | —                    | edit                                                         | safe         |
| `publishing.retry` backoff, `dispatch`, `media`, `oauth`, `inbound`                                   | Retry timing, lateness, upload and webhook mechanics.                 | —                    | shown (backoff, dispatch, inbound)                           | risky        |
| `integrations.social-apps`                                                                            | The Meta / TikTok apps: IDs, redirect URLs, keys, status.             | edit (guided set-up) | guided set-up linked from Publishing                         | risky (keys) |

## Sign-ups and security — `onboarding` (Simple: **Sign-ups & security**)

| Setting                         | What it does                                   | Simple before | Simple now                    | Owner? |
| ------------------------------- | ---------------------------------------------- | ------------- | ----------------------------- | ------ |
| `signup.open`                   | Anyone can sign up, or invitation only.        | —             | edit                          | safe   |
| `signup.minPasswordLength`      | Shortest new password (8–128; 12 recommended). | —             | edit                          | safe   |
| `mfa.customerEnrolmentEnabled`  | Customers may add a second sign-in step.       | —             | edit                          | safe   |
| `mfa.requiredForCustomers`      | Every customer must use one.                   | —             | edit (refused unless offered) | safe   |
| `signup.verificationTtlMinutes` | How long an email confirmation link works.     | —             | shown                         | risky  |
| `mfa.recoveryCodeCount`         | Recovery codes issued.                         | —             | shown                         | risky  |
| `abuse.*`                       | Sign-in and sign-up rate ceilings.             | —             | shown                         | risky  |
| `workspaceDeletion.graceDays`   | Days before a deleted workspace is erased.     | —             | shown                         | risky  |
| `steps`                         | The first-run checklist.                       | —             | shown (count)                 | risky  |
| Control Center sign-in (D-27)   | MFA is mandatory for every platform role.      | —             | not a setting                 | —      |

## Uploads — `assets` (Simple: **Uploads**)

| Setting                                                                        | What it does                                                | Simple before  | Simple now             | Owner? |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- | -------------- | ---------------------- | ------ |
| `upload.allowedMimeTypes.*`                                                    | File types accepted per kind.                               | —              | edit                   | safe   |
| `upload.maxFileBytes.*`                                                        | Largest file per kind.                                      | —              | edit (in MB)           | safe   |
| `scanning.provider`                                                            | Malware scanner: none, Scanii (or the development scanner). | readiness only | edit (with disclaimer) | safe   |
| `scanning.required`                                                            | Files must pass the scan before use.                        | —              | edit                   | safe   |
| `scanning.scanii.endpoint`                                                     | The scanner's web address.                                  | —              | edit                   | safe   |
| `upload.maxAssetsPerBrand`, `maxTagsPerAsset`                                  | Per-brand and per-file ceilings.                            | —              | shown                  | risky  |
| `versions`, `derivatives`, `processing`, `download`, `retention`, `brandFonts` | File versions, previews, processing, link lifetimes, purge. | —              | shown (some)           | risky  |

## Email — `integrations.email` (Simple: **Email**)

| Setting                                                       | What it does                            | Simple before | Simple now             | Owner? |
| ------------------------------------------------------------- | --------------------------------------- | ------------- | ---------------------- | ------ |
| `providers[].settings.fromName`                               | The sender name on every email.         | edit (guided) | edit                   | safe   |
| `providers[].settings.fromEmail`                              | The sender address.                     | edit (guided) | edit                   | safe   |
| `providers[].settings.replyTo`                                | Reply-to address.                       | edit (guided) | shown; guided set-up   | safe   |
| `providers[].secretRefs` (key), `status`, `activeProviderKey` | The service key, Test and switching on. | edit (guided) | guided set-up (linked) | risky  |

## Content — `onboarding.industries`, `content` (Simple: **Content**)

| Setting                                                        | What it does                                     | Simple before | Simple now                 | Owner?                   |
| -------------------------------------------------------------- | ------------------------------------------------ | ------------- | -------------------------- | ------------------------ |
| `onboarding.industries`                                        | The industries customers choose from.            | —             | edit (add, rename, remove) | safe                     |
| `content.calendar.suggestedTimes`                              | "Suggested time" per country.                    | —             | edit (add, edit, remove)   | safe                     |
| `content.platforms[].recommendedHashtags`                      | The hashtag range the Studio recommends.         | —             | edit                       | safe                     |
| `content.platforms[].safeZones`                                | Where a channel's buttons cover a story/reel.    | —             | edit                       | safe                     |
| `content.dialects`                                             | Writing styles offered.                          | —             | shown                      | risky                    |
| `content.calendar` (horizon, slots, week start, approval gate) | Calendar limits and the approval gate.           | —             | shown                      | risky                    |
| `content.calendar.holidays`, `observances`                     | Public holidays and industry occasions.          | —             | shown (counts)             | safe (not yet in Simple) |
| `content.generation`, `retention`, `approvals`, `learning`     | AI generation, retention and learning mechanics. | —             | —                          | risky                    |
| `brand-brain.questions.offersSets`                             | The question sets industries point at.           | —             | shown                      | risky                    |

## Legal pages — `onboarding.legalDocuments` (Simple: **Legal pages**)

| Setting                                     | What it does                                    | Simple before  | Simple now                  | Owner? |
| ------------------------------------------- | ----------------------------------------------- | -------------- | --------------------------- | ------ |
| `legalDocuments[].version`                  | The version people accept at sign-up.           | —              | edit                        | safe   |
| `legalDocuments[].reviewed`                 | The owner's "reviewed by a lawyer" mark.        | readiness only | edit                        | safe   |
| `legalDocuments[].title`, `url`, `required` | Which documents, their pages, whether required. | —              | shown                       | risky  |
| The text of the pages                       | Written in code (`apps/dashboard/src/legal`).   | —              | shown ("by your developer") | risky  |

## Features and flags — `entitlements`, `feature-flags` (Simple: **Features**)

Production ships **no** features or flags; they are added in Advanced. Each one then appears here:

| Setting                                                          | What it does                                            | Simple before   | Simple now                             | Owner? |
| ---------------------------------------------------------------- | ------------------------------------------------------- | --------------- | -------------------------------------- | ------ |
| A yes/no feature decided per plan                                | Which plans get it.                                     | edit (Features) | edit (Features, and on each plan card) | safe   |
| A feature's everyone/nobody switch                               | Turns a feature on or off for all.                      | edit (Features) | edit (Features)                        | safe   |
| Numeric or targeted features, kill switches, workspace targeting | Limits as features, emergency off, per-workspace rules. | shown           | shown                                  | risky  |

## AI — `ai.*` (Simple: **AI**)

| Setting                                                                   | What it does                                  | Simple before | Simple now                                                       | Owner? |
| ------------------------------------------------------------------------- | --------------------------------------------- | ------------- | ---------------------------------------------------------------- | ------ |
| `ai.capability-routing.activeProfile`                                     | Economy / Balanced / Premium.                 | edit          | edit; the page says "not available yet" until a provider is live | safe   |
| `ai.providers`, `ai.models`, `ai.routing`, `ai.capability-routing.routes` | Which provider and model does what.           | shown         | shown                                                            | risky  |
| `ai.credit-rules`                                                         | Credits per AI action and the margin targets. | —             | —                                                                | risky  |
| `ai.budgets`                                                              | Spending ceilings per plan.                   | —             | —                                                                | risky  |

## AI apps — `ai-apps`, `feature.ai_apps` (Simple: **AI apps**, D-566)

| Setting                                                 | What it does                                                       | Simple before | Simple now                   | Owner? |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ------------- | ---------------------------- | ------ |
| `enabled`                                               | Customers can connect AI apps at all. Off stops every app at once. | —             | edit                         | safe   |
| `rateLimit.maxCallsPerConnection`                       | Requests one connected app may make per window.                    | —             | edit                         | safe   |
| `feature.ai_apps` per plan                              | Which plans include AI apps.                                       | —             | edit (and on each plan card) | safe   |
| `rateLimit.windowSeconds`                               | The window requests are counted in.                                | —             | shown ("by your developer")  | risky  |
| `oauth.accessTokenTtlSeconds`, `refreshTokenTtlDays`    | How long an app's sign-in lasts.                                   | —             | shown                        | risky  |
| `oauth.authorizationCodeTtlSeconds`                     | How long the one-time sign-in code works.                          | —             | shown                        | risky  |
| `oauth.registrationPerIpPerHour`, `tokenPerIpPerMinute` | Requests accepted from one address.                                | —             | shown                        | risky  |
| `oauth.unusedClientRetentionDays`                       | When an app that never connected is removed.                       | —             | shown                        | risky  |
| `allowedOrigins`                                        | Websites allowed to call the MCP address from a browser.           | —             | shown                        | risky  |
| The `feature.ai_apps` kill switch                       | Emergency off for the feature.                                     | —             | shown (Advanced)             | risky  |

## Everything else (Advanced only, listed so nothing is hidden)

| Domain                                                                 | What it does                                                                   | Simple        | Owner?                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------- | ------------------------ |
| `beta-cohorts`                                                         | Which workspaces are in the beta cohorts.                                      | —             | risky                    |
| `usage-limits`                                                         | Platform-wide usage ceilings.                                                  | —             | risky                    |
| `brand-brain` (upload, ingestion, extraction, knowledge, chat, review) | How the Brand Brain reads and answers.                                         | —             | risky                    |
| `content.retention`, `content.learning`                                | How long drafts and signals are kept.                                          | —             | risky                    |
| `integrations.storage`                                                 | Where files are stored, and its key.                                           | guided set-up | risky (keys)             |
| `integrations.payment`                                                 | The payment provider (payments are off).                                       | guided set-up | risky (keys)             |
| `integrations.observability`                                           | Error and trace reporting.                                                     | guided set-up | risky (keys)             |
| `analytics`                                                            | Ingestion, backfill, freshness, anomaly and export.                            | —             | risky                    |
| `copilot`                                                              | Copilot plans and conversation limits.                                         | —             | risky                    |
| `automations`                                                          | Automation limits and execution.                                               | —             | risky                    |
| `templates`                                                            | Notification templates.                                                        | —             | risky                    |
| `website`                                                              | Public site name, locale, announcement, pages.                                 | —             | safe (not yet in Simple) |
| `operations`                                                           | Maintenance mode, support-mode time limit, currencies, trial default.          | —             | risky                    |
| `commerce`                                                             | Payments, currencies, markets, tax, credit packs, checkout, dunning, invoices. | —             | risky                    |
| `ai.credit-rules`, `ai.budgets`                                        | Credit costs and AI budgets.                                                   | —             | risky                    |

## Who may change what

- Seeing a Simple page needs `platform.configuration.read`; changing anything on it needs
  `platform.configuration.manage` **and** `platform.configuration.activate`, and MFA (D-27).
  Without them the page shows the cards read-only and offers no change control.
- The Team page needs `platform.user.read`; the Change history needs `platform.audit.read`.
- Every change, Simple or Advanced, writes one `config.activated` audit event with each changed
  value old → new (credential-like names masked), and can be undone per card ("Undo last change"),
  which is itself a new version.
