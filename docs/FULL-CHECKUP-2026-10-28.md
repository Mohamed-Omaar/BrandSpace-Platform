# Brandspace — full check-up before the closed beta (2026-10-28)

|                   |                                                                                                                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revision reviewed | `staging` @ `b2b55e55` (merge of PR #92). Also reviewed: PR #91 (`d4318d8b`), PR #90 (`f0894b00`)                                                                                                                                                                           |
| Mode              | **Read-only.** No code change, no PR, no migration outside a local throwaway PostgreSQL, nothing on Railway, staging or production, no script against staging or production, no secret value read or printed.                                                               |
| Local environment | PostgreSQL 16 and Redis 7 in the review container, roles created from `scripts/sql/setup-database-roles.sql` with the CI throwaway passwords, `.env.test` identical to the CI job. All five services built and run locally with `next start` / `tsx`, as in the CI e2e job. |
| Not available     | No Railway access. No GitHub API for this repository (403), so no CI run history, fork count or branch protection. No Lighthouse binary (Playwright + CDP throttling used instead). No live OpenAI calls.                                                                   |

---

## 1. Summary: is it safe to launch the closed beta?

**No, not today. It can be, after a short list of fixes and owner actions (section 13, "Blocks launch") — about 2–4 developer-days plus a few hours of owner work on Railway and GitHub.**

Why not today:

1. **The three Next.js apps run Next 16.3.4**, which `pnpm audit` lists with a **critical unauthenticated remote-code-execution advisory in the image optimiser** (GHSA-2464-fhr4-w9xw, fixed in 16.4.1). `/_next/image` is live and needs no session in admin, dashboard and web. The admin app holds the platform database URL and the platform vault key. The api runs **Fastify 5.12.1** with a high-severity authentication-bypass advisory. Both are dependency bumps, but launch must wait for them (C-1, H-1).
2. **Railway's 2026-10-21 disclosure has to be answered before customers arrive.** Every secret the services read can be rotated without data loss (section 3.4). But a hand-made staging job keeps the **staging owner's full login in Railway variables** (password, TOTP seed, recovery codes) and resets that account on every deploy. It is in neither the rotation runbook nor the environment matrix (H-2).
3. **The public repository exposes a real tester's name and personal e-mail** in a branch of live staging screenshots, plus the owner's admin login address and the full infrastructure map. No real secret is committed anywhere in history (M-1).
4. **Some things customers are promised are not true:**
   - The Terms say nothing is locked when the trial ends; onboarding says paid features stop (M-5).
   - Workspace deletion is announced as deletion, but no purge exists, although SECURITY.md promises one (M-4).
   - The legal pages still carry the D-512 placeholders.
   - The public `web` app is still the Phase-1 placeholder ("Phase 1: foundations only") while it is given a public domain (M-6).
5. **Operations has two holes:**
   - The migration job can show SUCCESS without migrating (M-8). This explains the earlier Railway incident.
   - With Redis down, uploads and every queued action hang instead of saving (M-7).

What is in good shape:

- **Tenant isolation is solid and was verified live.** Forced RLS is on every tenant table with workspace-keyed policies. The isolation gate passes, and 3,340 isolation tests pass against real PostgreSQL. No query takes `workspaceId` from user input. Every API route, server action and MCP tool is gated.
- **Migrations match the schema exactly (empty diff).**
- **Publishing is idempotent.**
- **The KEK re-wrap from PR #92 is correct** for all three key domains.
- **The production configuration documents** validate and activate cleanly.
- **The beta as configured** shows the right trial numbers (90 days, 500 credits) everywhere. It shows nothing AI-only while AI is off, and no LinkedIn or X on customer screens.

**The production beta is AI-off and AI-apps-off (as configured).** That keeps the AI-charging bugs (H-3, H-4, the known Copilot bug) and the Connected-AI-apps gaps (H-5) out of production at launch. They **block turning AI or AI apps on in production**, and they are live on **staging today**, where the real OpenAI provider is active (D-573).

### Counts (new findings, KNOWN bugs excluded)

| Critical | High | Medium | Low |
| :------: | :--: | :----: | :-: |
|    1     |  5   |   18   | 55  |

Medium: M-1…M-16 and D-1, D-2. A further 9 performance causes are measured and ranked in section 8 rather than numbered as findings. Low: L-1…L-47 and D-3…D-10.

KNOWN bugs: every queued bug the brief lists was checked. Section 4 confirms or refines them, with root causes and file:line where they were found.

---

## 2. How this was checked

Eight review tracks ran in parallel over the same checkout, plus a baseline run. Every finding below was traced in code to file:line. "CONFIRMED" means it was run, or traced end to end. "SUSPECTED" means the pattern was seen but not fully proven.

| Track                                    | What was done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline                                 | `gate:isolation`, `pnpm audit`, `test:unit`, `test:isolation` (real PostgreSQL, least-privilege roles), `lint`, `typecheck` — all locally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Application security                     | All 99 migrations applied to a throwaway DB, then the live `pg_class`/`pg_policies`/`pg_constraint` catalogue was queried. A script enumerated all 86 API routes, 197 server actions, 27 dashboard route handlers, 52 admin actions and 11 MCP tools, and the gate inside each one was read. OAuth, CSRF, sessions, uploads, headers and rate limits were read. Targeted isolation tests were re-run (kek-rewrap, ai-apps-mcp, connectors OAuth: 71 passed).                                                                                                                                                                                                                                                     |
| Repository and secrets                   | Every patch in `git log --all -p` (1,077 commits, 82 remote branches) was scanned for key formats, private keys, credentialed URLs, high-entropy strings and e-mails. Every file ever added was listed. An inventory was made of every environment variable the code reads. The `pnpm audit` results were triaged for runtime reachability.                                                                                                                                                                                                                                                                                                                                                                      |
| Correctness                              | End-to-end code traces of the customer flow, the AI gateway (reserve → call → settle), every AI task's parser, the publishing worker, the MCP tools and the Control Center configuration lifecycle. A real 15 s tenant-transaction expiry was reproduced.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Data and operations                      | Migrations applied, `prisma migrate diff` both directions, edits to applied migrations audited through git history. The migration command was made to fail seven ways and its exit codes recorded. `enqueue()` was run against a dead Redis. The worker was run through a Redis outage. Env validation was tested with bad URLs. The GO-LIVE runbook was compared line by line.                                                                                                                                                                                                                                                                                                                                  |
| Runtime UI / accessibility / performance | Production builds of all apps, run as in CI. All 10 `docs/production-config` documents were loaded through the real `createDraft → validateDraft → activate` path. Fresh en and ar sign-ups went through onboarding. About 650 screenshots were taken (en/ar × 1536×864, 1920×1080, 375×812). axe ran on every screen. Keyboard passes were made. TTFB and SQL statements per route came from the Postgres log. Cold-cache JS bytes were measured. Web vitals were measured at 4× and 6× CPU throttling. Scroll fps was measured with each visual effect removed in turn. Polling was recorded for 3 minutes visible and hidden. RSS memory was taken per service. The repo's prototype-parity spec ran (52/52). |
| Static performance                       | Per-route server data loading traced, plus polling loops, prefetch, Suspense and loading states, image delivery, CSS effects and memory model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Design system                            | Scripts inventoried every stylesheet, every custom property, every hard-coded value in CSS and TSX (with file:line, in CSV) and every inline style. A simulation changed the primary-colour and input-border tokens in a scratch copy and listed what does not follow.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tests, CI and docs                       | Skipped and conditional tests, vacuous assertions, timing patterns, CI triggers and timeouts, coverage of risky modules. Docs were checked against code: env vars, D-numbers, Control Center settings, MCP tools, AI tasks, acceptance criteria.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Baseline results

| Check                                                                      | Result                                                                                    |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm gate:isolation`                                                      | PASS — 77 tenant-owned and 11 platform-owned models have RLS and isolation coverage       |
| `pnpm test:unit`                                                           | PASS — 268 files, 4,641 tests, 0 skipped (143 s)                                          |
| `pnpm test:isolation`                                                      | PASS — 235 files, 3,340 tests, 0 skipped (1,268 s, real PostgreSQL, NOBYPASSRLS app role) |
| `pnpm lint` / `pnpm typecheck`                                             | PASS / PASS                                                                               |
| `pnpm audit`                                                               | 52 advisories: **3 critical, 21 high, 22 moderate, 6 low** (triaged in section 3.3)       |
| `prisma migrate diff` (DB built from all 99 migrations vs `schema.prisma`) | **Empty** in both directions                                                              |
| Repository parity spec `tests/e2e/prototype-parity.spec.ts`                | 52/52 against the local build                                                             |

---

## 3. Security

### 3.1 Findings

#### C-1 — Critical — Next.js 16.3.4 carries unauthenticated RCE advisories on a live endpoint

- **Area:** Dependencies (admin, dashboard, web).
- **Where:**
  - `apps/admin/package.json:26`, `apps/dashboard/package.json:36`, `apps/web/package.json:14`, `packages/ui/package.json:27` all pin `"next": "16.3.4"`.
  - No `next.config.mjs` sets `images.unoptimized`.
  - Every `proxy.ts` matcher excludes `_next`: `apps/admin/src/proxy.ts:99`, `apps/dashboard/src/proxy.ts:143`, `apps/web/src/proxy.ts:65`.
- **What happens:** `pnpm audit` lists the advisories below. The most serious is GHSA-2464-fhr4-w9xw, _unauthenticated RCE in the Image Optimization API via SVG_, fixed in 16.4.1. `/_next/image` is served without a session by all three apps. A compromise of the admin process exposes `DATABASE_PLATFORM_URL` and `SECRET_VAULT_KEK`.

  | Advisory                                                       | Severity | Applies here?                |
  | -------------------------------------------------------------- | -------- | ---------------------------- |
  | GHSA-2464-fhr4-w9xw: RCE in the Image Optimization API via SVG | critical | yes                          |
  | GHSA-673q-mjm6-r5xr: RCE in `use cache`                        | critical | not used in this code        |
  | GHSA-vcvr-r3jv-pc5j: RCE in `next/og`                          | critical | not used in this code        |
  | GHSA-cjq9-62q9-8jv4: SSRF in image optimisation                | high     | yes                          |
  | GHSA-p3m5-59mp-jv5r: Server Actions DoS                        | high     | yes; 48 `'use server'` files |
  | sharp 0.35.4: librsvg advisory                                 | —        | yes                          |

- **How confirmed:** the version and endpoint reachability were CONFIRMED in code and in `pnpm audit`. That the exploit preconditions hold is SUSPECTED; it is inferred from the advisory titles and ranges, and no exploit was attempted.
- **Smallest safe fix:**
  - Bump `next` to ≥ 16.4.1 in the three apps and `packages/ui`, then re-run unit, isolation and e2e.
  - Also set `images: { unoptimized: true }` in the three `next.config.mjs` files. No screen uses `next/image` for content; `asset-library-view.tsx:1488` uses a plain `<img>` on purpose.

#### H-1 — High — Fastify 5.12.1 on the internet-facing API has an authentication-bypass advisory

- **Area:** Dependencies (api; also serves `/mcp` and the OAuth endpoints).
- **Where:** `apps/api/package.json:37`.
- **What happens:** These advisories are fixed in 5.12.2:
  - GHSA-p68q-wchp-6fh7: _authentication bypass via malformed URLs_ (high);
  - GHSA-667r-xxjv-c9mm (high);
  - GHSA-hwr6-493r-vm6h (high);
  - GHSA-9q9j-q6p8-xq58 (high).

  A moderate DoS, GHSA-4mh8-r7rc-xpvc, is fixed in 5.12.5. `fast-uri` 4.1.3 (2 high) comes with it.

- **How confirmed:** version CONFIRMED. Whether any route guard here can be skipped was not traced (SUSPECTED).
- **Smallest safe fix:** bump `fastify` to ≥ 5.12.5, then re-run the suites.

#### H-2 — High — A staging job stores the staging owner's full login in Railway variables and resets it on every deploy

- **Area:** Secrets / Railway leak exposure.
- **Where:**
  - `packages/database/prisma/bootstrap-staging-owner.ts:90-93` reads `BOOTSTRAP_STAGING_OWNER_EMAIL`, `_PASSWORD`, `_TOTP_SECRET` and `_RECOVERY_CODES`.
  - Lines `171-202` then do the following on every run:
    - set the vault TOTP to the env value;
    - store the env recovery codes;
    - set the password hash;
    - clear lockouts;
    - revoke sessions.
  - `docs/OPERATIONS.md:1033` records the `staging-owner-bootstrap` job running on an ordinary staging push. It is not in `.railway/railway.ts`, so it was created by hand.
- **What happens:**
  - If Railway's variables leaked, these four values give a full staging Control Center takeover, MFA included.
  - Staging holds the live OpenAI key (D-573) and a real tester's account.
  - Any password or MFA change the owner makes is undone at the next deploy.
  - The variables are missing from `docs/RAILWAY-ENVIRONMENT-MATRIX.md` and `docs/SECRET-ROTATION.md`. That breaks the matrix's own class-H rule ("never added to a Railway service").
- **How confirmed:** code CONFIRMED. The current Railway state could not be checked.
- **Smallest safe fix:**
  - Delete the four variables and the job from Railway staging.
  - Re-enrol the staging owner with a new password, TOTP and recovery codes.
  - Document it in both runbooks.
  - Optionally make the script refuse to run without a TTY, as the production bootstrap already does.

#### H-5 — High (not live in production at launch) — Connected AI apps (MCP) ignore workspace status and survive a password reset

- **Area:** AuthZ — MCP server. Contradicts D-328 and D-333.
- **Where:**
  - `apps/api/src/ai-apps/mcp-route.ts:124-200`: `authenticate()` selects `workspace.status` at `:144`, and the checks at `:149-156` never read it. There is no check on `deletedAt` or `deletionScheduledFor`.
  - The refresh grant at `apps/api/src/ai-apps/oauth-routes.ts:474-531` has the same gap.
  - Customer sessions do filter correctly (`packages/auth/src/customer-session.ts:586-593`).
  - Nothing outside `apps/api/src/ai-apps` revokes `ai_app_connection` or `ai_app_token`:
    - workspace deletion only revokes customer sessions (`packages/onboarding/src/workspace-deletion.ts:283-286`);
    - `completePasswordReset` (`customer-session.ts:899-963`) and "sign out other devices" (`:743`) revoke only customer sessions.
- **What happens:** After a workspace is suspended, archived, scheduled for deletion or deleted, or requires two-step verification the user lacks, an already-connected Claude or ChatGPT can still:
  - read posts, brand facts and performance;
  - create and update drafts;
  - refresh its tokens.

  After an account takeover, the owner's password reset does not cut the attacker's AI-app connection.

- **How confirmed:** CONFIRMED by code trace in two independent tracks. Re-verified at `mcp-route.ts:136-156`.
- **Smallest safe fix:**
  - Reuse the `listWorkspaces` predicate (status ∈ TRIALING/ACTIVE/PAST_DUE, not deleted, not pending deletion, MFA rule) in `authenticate()` and in both token grants.
  - Revoke a user's AI-app connections on password reset and "sign out other devices", and a workspace's connections on suspension or deletion.
  - Add isolation tests for each.
- **Launch impact:** `docs/production-config/ai-apps.json` ships `enabled: false` and no plan has `feature.ai_apps`. This blocks turning AI apps on in production. It is live on staging.

#### M-1 — Medium — The public repository leaks a real person's data and the infrastructure map; make it private

- **Area:** Repository exposure. The repository is public.
- **Where:**
  - **Personal data:** branch `origin/codex/staging-screenshots-2026-09-25`, commit `1d094945`, `artifacts/brandspace-staging-screenshots/*.zip.part-00..07`. These are 114 live staging screenshots:
    - `dashboard__customer__en__desktop__team.png` shows a real tester's full name and personal Gmail and the business name;
    - the admin screens list the real staging customers and show the staging owner's login.
  - **Owner's admin login:** `docs/RAILWAY-DEPLOYMENT.md:1501,1526` (added in `7f30227d`) give the owner's personal Gmail as the production Platform Owner login. The same address is the author of about 250 commits.
  - **Infrastructure map**, across the docs:
    - every hostname: `brandspace.cc`, `app.`, `admin.`, `admin-staging.`, `api-staging.`, `staging.`, `send.`;
    - Railway service names, the private address `api.railway.internal:3003` and the region;
    - which service holds which key, and the database role names.
  - **Business configuration:** prices, credits and spend ceilings in `docs/production-config/*.json`.
- **What an outsider does _not_ get:** any working secret. The full-history scan found no real key, token, private key, credentialed database URL or password:
  - every key-shaped string is a test fixture;
  - one AWS-shaped literal in `e2c2338e` sat among fake fixtures and was later replaced, so the owner should confirm in IAM that no key starting `AKIA7S…` exists;
  - a 25-character dev seed password from `d1016ee3` was removed in `3858955f`, and `tests/unit/seed-password.test.ts` now refuses it.
- **What happens:** the tester's data is a PDPL/GDPR exposure. The admin e-mail and hostnames give an attacker targets for phishing and for C-1 / H-1.
- **How confirmed:** the history scan was CONFIRMED, and the screenshot zip was rebuilt (its checksum matches its README) and three images viewed. The local copy was deleted after review. Fork and star counts are unknown (no GitHub API).
- **Smallest safe fix:**
  1. Make the repository private now. This stops new exposure but does not undo what is already public; forks stay public, so check the Forks tab.
  2. Delete the screenshot branch, and ask GitHub Support to purge `1d094945`, which stays reachable by SHA.
  3. Consider telling the tester.
  4. Treat as already public: the owner's admin e-mail (consider a separate admin-only address; MFA and lockout stay on) and every hostname.

#### M-2 — Medium — Social OAuth can attach a victim's Facebook, Instagram or TikTok account to an attacker's workspace

- **Area:** OAuth (Meta, TikTok) — beta channels.
- **Where:**
  - `apps/api/src/routes/social.ts:551-646`: the public callback finds the workspace from the state hash alone (`:590`), then calls `service.complete` (`:598`).
  - `packages/social-connectors/src/oauth.ts:356-398`: `complete()` checks state, PKCE, the redirect URI and that the _starter_ may connect, but never _who is completing_.
  - `oauth.ts:459-483`: if there is exactly one target, it is connected with no selection step.
- **What happens:**
  - A beta user with `integrations.manage` clicks Connect, copies the provider authorisation URL and sends it to a victim who is signed in to Facebook or TikTok.
  - If the victim approves the consent screen, which names the Brandspace app, the victim's page tokens are stored in the attacker's workspace.
  - The attacker can then publish to the victim's page.
- **How confirmed:** CONFIRMED by code trace. Not exploited.
- **Smallest safe fix:**
  - Bind the flow to the starting browser: issue a nonce at connect, set it as a short-lived `__Host-` cookie and store its hash on `social_oauth_state`.
  - Make the callback hand off to a dashboard route that checks the signed-in user (= `startedByUserId`) and the nonce before the code exchange.
  - Add an isolation test.

#### M-3 — Medium — The Control Center second factor can be guessed slowly with no end; codes can be replayed; no IP is recorded

- **Area:** AuthN — platform realm.
- **Where:**
  - `packages/auth/src/platform-session.ts:38-39`: 10 failures give a 15-minute lock. `:387` resets the counter when the lock is applied, so the cycle repeats forever.
  - `verifyMfa` (`:125-215`) has no per-IP or per-session ceiling. The customer realm has one.
  - `packages/auth/src/mfa.ts:70-84` accepts ±1 step and keeps no last-used step, in both realms.
  - `apps/admin/src/app/[locale]/(auth)/login/actions.ts:23` and `mfa/actions.ts:25` pass no IP or user agent.
- **What happens:** with a stolen owner password, an attacker gets about 960 guesses a day, roughly an 8 % success chance per month. Intercepted codes can be replayed within about 90 s. Audit rows have no address.
- **How confirmed:** CONFIRMED by code read.
- **Smallest safe fix:**
  - Pass `requestOrigin()` from the admin actions.
  - Add the `mfa:ip` and `mfa:account` limiters to the platform realm.
  - Make the lockout progressive.
  - Store the last accepted TOTP step and refuse codes at or below it.

#### Low — security

| ID   | Finding                                                                                                                                                                                                                                                  | Where                                                                                                                           | Fix                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| L-1  | The dashboard proxy route handlers that spend credits or start checkouts accept any `Content-Type` and check no `Origin`. CSRF protection rests only on `SameSite=Lax`, so an XSS on a same-site origin could spend credits.                             | `apps/dashboard/src/app/api/content/proxy.ts:42`, `copilot/proxy.ts:43`, `commerce/proxy.ts:54`, `brand-brain/chat/route.ts:40` | Require `application/json` and a same-origin `Origin` / `Sec-Fetch-Site`.                                   |
| L-2  | PR #92 re-wrap leaves the short-lived `social_oauth_state` envelopes under the old key but still reports "safe to remove". Connects in flight then fail.                                                                                                 | `packages/secrets/src/rewrap.ts:106-121`; not in `SECRET-ROTATION.md`                                                           | Include unexpired state rows, or add the runbook step "wait `stateTtlSeconds` before removing the old key". |
| L-3  | PR #92 re-wrap: a mid-run failure writes no audit row, and `--new-var` accepts another domain's key and certifies it.                                                                                                                                    | `rewrap.ts:262-288, 312`; `apps/api/src/scripts/rewrap-kek.ts:64-75`                                                            | Write a failure audit in try/finally; refuse foreign `--old-var` / `--new-var` without an override.         |
| L-4  | The isolation gate only checks that _a_ policy exists and that a test _mentions_ the model. A `USING (true)` policy would pass. The live policies are correct today.                                                                                     | `scripts/isolation-gate.ts:127-143, 172-180`                                                                                    | Assert `pg_policies.qual` references `current_workspace_id()` after migrating.                              |
| L-5  | Runtime FORCE-RLS assertions cover six hard-coded tables, while ten migrations temporarily set `NO FORCE`.                                                                                                                                               | `tests/isolation/rls-raw-sql.test.ts:85-99`, `platform-role.test.ts:296-307`                                                    | Derive the list from the registry, like the policy check next to it.                                        |
| L-6  | The session token is not rotated at the second factor (pre-MFA row promoted in place), in both realms. `__Host-` cookies limit the risk.                                                                                                                 | `customer-session.ts:441-444`, `platform-session.ts:181-184`                                                                    | Issue a new token on MFA success.                                                                           |
| L-7  | Raw start-up errors bypass log redaction.                                                                                                                                                                                                                | `apps/api/src/server.ts:185`, `apps/worker/src/main.ts:355`                                                                     | Log through `createLogger(...).error` / `internalErrorFields`.                                              |
| L-8  | `INTERNAL_SERVICE_TOKEN` has no previous-value overlap, so rotation gives brief 404s. Its routes are on the public API; a leaked token lets anyone send the six fixed e-mail templates to any address.                                                   | `apps/api/src/.../internal-caller.ts:28-38`; `/v1/internal/email/deliver`, `/v1/internal/storage/self-test`                     | Rotate now (runbook step 3). Optionally accept a `_PREVIOUS` value and rate-limit.                          |
| L-9  | The re-wrap does not re-issue data keys. Social tokens and MFA seeds keep their values, which matters only if a database copy _also_ leaked.                                                                                                             | `rewrap.ts`                                                                                                                     | Add a contingency note: if a DB copy may have leaked, customers reconnect social accounts and re-enrol MFA. |
| L-10 | CI: actions are pinned by tag, not SHA (including third-party `pnpm/action-setup@v5`). There is no `permissions:` block. The secret scan checks current files only and misses `re_`, `EAA`, `xox`, `github_pat_`, `sk-ant-` and credentialed DB URLs.    | `.github/workflows/ci.yml` (scan job from `:561`)                                                                               | Add `permissions: contents: read`, pin by SHA, use gitleaks or trufflehog over history.                     |
| L-11 | `.gitignore` lacks `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `*.dump`, `*.zip`, `artifacts/`, `tmp/`. `tmp/staging-owner-bootstrap-trigger.txt` is tracked (harmless content).                                                                      | `.gitignore`                                                                                                                    | Add the patterns.                                                                                           |
| L-12 | SECURITY.md calls the session secrets signing keys. Sessions are actually random hashed tokens: `CUSTOMER_SESSION_SECRET` only signs asset-download links (`assets-context.ts:83`), and `PLATFORM_SESSION_SECRET` is read by nothing but the env schema. | `docs/SECURITY.md:1047`                                                                                                         | Correct the doc.                                                                                            |

### 3.2 What was checked and found fine (security)

- **Tenant isolation (verified in the live catalogue, not just in migration text):**
  - All 99 tables except `_prisma_migrations` and the three global catalogues (`permission`, `role_permission`, `entitlement_catalogue_snapshot`) have `relrowsecurity = relforcerowsecurity = true` and at least one policy.
  - Every `brandspace_app` policy on the 80 tenant tables is `"workspaceId" = app.current_workspace_id()`, apart from the intended identity and NULL-context exceptions.
  - Every tenant model is in the isolation gate and has a real cross-workspace test.
- **Single-column foreign keys between tenant tables:** only `membership.roleId → role` and `invitation.roleId → role`, both guarded by the trigger `app.role_reference_is_workspace_scoped`. Every other tenant→tenant FK is composite.
- **No query takes `workspaceId` from user input** without re-validating it against the session. The API takes it from `resolveCaller` (`phase7-context.ts:89-124`); the dashboard from `requireWorkspace` / `resolveApiWorkspace` (`customer-context.ts:268-327, 424-443`). MCP tools take no workspace argument. There is no unsafe raw SQL. RLS context is set once per transaction (`packages/database/src/tenant-client.ts:47-60`).
- **AuthN/AuthZ, every entry point gated:**
  - **API:** 86 routes, each with its declared permission; low route floors are backed by service checks.
  - **Dashboard:** 197 server actions and 27 route handlers.
  - **Control Center:** 52 server actions with `requirePlatformActor(<permission>)` and every page with `requirePageActor`.
  - **MCP:** 11 tools through `run()`, with scope, live permission and brand intersection, all audited.
  - **Viewer role (D-130 as amended by D-323)** is read-only apart from commenting.
- **Control Center realm:**
  - separate `__Host-` cookie (`SameSite=Strict`, 4 h idle / 12 h absolute) and a separate session table;
  - no admin data is reachable before `mfaVerifiedAt`;
  - unenrolled staff cannot log in;
  - 10 single-use hashed recovery codes.
- **MCP OAuth server:**
  - PKCE S256 only;
  - single-use codes, and reuse revokes the connection;
  - rotating refresh tokens with replay detection;
  - exact redirect-URI match (loopback per RFC 8252) and RFC 8707 resource binding;
  - the consent screen names the redirect host and cannot be framed;
  - open client registration (by MCP design) is rate-limited per IP.
- **Social OAuth (apart from M-2):** hashed single-use state with a TTL, sealed PKCE verifier, redirect URI rebuilt from configuration, the starter's permission re-checked, provider error text never echoed.
- **Sessions:**
  - `__Host-`, httpOnly, Secure cookies;
  - a new token on sign-in;
  - password reset revokes all customer sessions in the same transaction;
  - `?next=` is restricted to relative paths.
- **Secrets:**
  - a redacting logger and tracer, covering key names and value patterns (`sk-`, `AKIA`, JWT, PEM, credentialed URLs, Meta `EAA…`, TikTok tokens);
  - error responses carry codes only;
  - no `NEXT_PUBLIC_*` variable exists, and no client module imports a server package or reads `process.env`;
  - the OpenAI adapter never echoes provider messages and egress is host-pinned;
  - MCP tool results carry no tokens.
- **Uploads:**
  - a closed type list with magic-byte checks at initiate and at completion;
  - no SVG or HTML type;
  - size and extension checks, traversal refused, server-built storage keys;
  - quota consumed atomically;
  - quarantine until scanned;
  - downloads served as `attachment` with `nosniff` and `sandbox` CSP.
- **Rate limits:**
  - sign-in by IP and account, sign-up, verification resend, password reset and MFA (by IP and account), step-up, and account lockout;
  - ceilings come from configuration;
  - the MCP connection window, client registration and the token endpoint are limited per IP.
- **Headers:**
  - dashboard and Control Center send a nonce CSP with `strict-dynamic`, `frame-ancestors 'none'`, XFO DENY, `nosniff`, COOP and `no-store`;
  - HSTS is sent only when `APP_ENV=production` (deliberate);
  - web uses a static CSP (documented SSG trade-off);
  - the API sends `nosniff` and a referrer policy.
- **PR #92 KEK re-wrap:**
  - every envelope is classified before anything is written;
  - one conditional transaction per envelope, so it is resumable and race-safe;
  - verification uses the new key alone;
  - only `wrappedDataKey/keyProvider/keyId` change, enforced by the `20261028090000_secret_version_kek_rewrap` trigger;
  - all three domains have an unwrap-only `*_KEK_PREVIOUS` (`key-provider.ts:288, 296, 313, 381-432`), and a previous key equal to the current one is refused;
  - the test suite `tests/isolation/kek-rewrap.test.ts` is solid.
- **CI:** no `pull_request_target`, no `secrets.*`, only throwaway values, and a guard against tracked `.env` files. The Postgres and Redis blueprint has no public domain or TCP proxy (`.railway/railway.ts:137-141`).

### 3.3 Dependency vulnerabilities (`pnpm audit`, 52 advisories)

| Package (version)                                          | Severity                   | Reachable in a shipped app?                                                                                 | Fix                       |
| ---------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------- |
| next 16.3.4                                                | 3 critical, high, moderate | **Yes** (C-1). The `use cache` and `next/og` RCEs are not used here. GHSA-39w2 affects the dev server only. | ≥ 16.4.1                  |
| sharp 0.35.4 (via next)                                    | —                          | Yes, via the image optimiser                                                                                | with next                 |
| fastify 5.12.1                                             | 4 high, 1 moderate         | **Yes** (H-1)                                                                                               | ≥ 5.12.5                  |
| fast-uri 4.1.3 (via fastify)                               | 2 high, 4 moderate, 2 low  | Yes                                                                                                         | ≥ 4.2.3                   |
| fast-uri 3.1.6 (MCP SDK → ajv)                             | 2 high, others             | Possibly, low                                                                                               | ≥ 3.1.9                   |
| zod 3.25.76                                                | high (range `<4.6.6`)      | Runtime. Whether 3.x is affected is SUSPECTED; there is no 3.x fix.                                         | zod 4 migration, later    |
| body-parser 2.3.0 (MCP SDK → express)                      | high                       | No: `mcp-route.ts:2` uses the web-standard transport                                                        | ≥ 2.4.0                   |
| deepmerge-ts 7.1.5, mysql2 3.15.3 (prisma CLI)             | high                       | Migration job only / not used (Postgres)                                                                    | update prisma             |
| vite 8.2.2, @vitest/mocker, source-map-js, brace-expansion | various                    | Dev only                                                                                                    | vite 8.2.4, vitest 4.1.12 |

### 3.4 The Railway variable disclosure (2026-10-21): every secret the code reads, and whether it can be rotated safely

Service letters: D dashboard, A admin, P api, K worker, M migration job.

| Variable                                                            | Read by                  | Protects                                                                                                                          | How to rotate safely                                                                                                         | Data loss? | In `SECRET-ROTATION.md` |
| ------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------- |
| `SECRET_VAULT_KEK`                                                  | A P                      | Data keys of every Control Center secret, including the platform owner's TOTP and the OpenAI, Resend, Meta and TikTok credentials | Set `SECRET_VAULT_KEK_PREVIOUS` (unwrap-only), run `pnpm secrets:rewrap-kek --domain platform`, then remove the previous key | No         | Yes                     |
| `SOCIAL_TOKEN_VAULT_KEK`                                            | P K                      | Customer social OAuth tokens                                                                                                      | Same, `--domain social`. Wait for OAuth state TTL first (L-2)                                                                | No         | Yes                     |
| `CUSTOMER_MFA_VAULT_KEK`                                            | D P                      | Customer TOTP seeds                                                                                                               | Same, `--domain customer-mfa`                                                                                                | No         | Yes                     |
| `*_KMS_KEY_ARN` (×3)                                                | per domain               | Names the production KMS keys (not secret)                                                                                        | KMS automatic rotation                                                                                                       | No         | Yes (§1.6)              |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`                       | D A P K                  | KMS access                                                                                                                        | Create a second IAM key, deploy, deactivate the old                                                                          | No         | Yes (§5.1)              |
| `DATABASE_URL` / `DATABASE_PLATFORM_URL` / `DATABASE_MIGRATION_URL` | D A P K / A P / M        | The three DB roles                                                                                                                | `\password <role>`, update the variables, redeploy; brief gap for new connections                                            | No         | Yes (§2.1)              |
| Postgres superuser                                                  | none of ours             | Whole database                                                                                                                    | `\password postgres`                                                                                                         | No         | Yes (§2.2)              |
| `REDIS_URL`                                                         | D A P K                  | Queues                                                                                                                            | Rotate the password and restart; jobs are idempotent                                                                         | No         | Yes (§2.3)              |
| `CUSTOMER_SESSION_SECRET`                                           | D                        | Asset-download link signature only                                                                                                | Safe; open download links stop working                                                                                       | No         | Yes                     |
| `PLATFORM_SESSION_SECRET`                                           | A                        | Nothing (only read by the env schema)                                                                                             | Safe                                                                                                                         | No         | Yes                     |
| `INTERNAL_SERVICE_TOKEN`                                            | D A P                    | Internal e-mail and storage routes                                                                                                | Brief 404s during redeploy (L-8)                                                                                             | No         | Yes                     |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY`               | D P K                    | R2 media bucket                                                                                                                   | New token, deploy, revoke old                                                                                                | No         | Yes (§5.6)              |
| `SCANII_API_KEY` / `SCANII_API_SECRET`                              | K                        | Malware scanning                                                                                                                  | New key at Scanii                                                                                                            | No         | Yes                     |
| `BILLING_DEV_WEBHOOK_SECRET`                                        | P (dev only)             | Dev payment webhooks; production refuses it                                                                                       | n/a                                                                                                                          | No         | n/a                     |
| **`BOOTSTRAP_STAGING_OWNER_*` (×4)**                                | staging job              | **Staging owner's full login, MFA included**                                                                                      | **Delete them, then re-enrol the owner (H-2)**                                                                               | No         | **No**                  |
| `BOOTSTRAP_PLATFORM_OWNER_*`                                        | typed in for one command | Production bootstrap                                                                                                              | Never stored on Railway                                                                                                      | No         | Matrix only             |
| `SMOKE_SIGNUP_PASSWORD`, `STAGING_RESEND_API_KEY`                   | `scripts/staging-*.ts`   | Throwaway smoke account / a Resend key                                                                                            | Should be typed in, never stored; rotate if they were ever stored                                                            | No         | No                      |
| Railway API / deploy tokens                                         | Railway account          | The Railway account                                                                                                               | Rotate in Railway                                                                                                            | No         | No                      |

- **Not in Railway variables:** OpenAI, Resend, the Meta app secret and verify token, the TikTok client secret and the social subject-hash key all live in the Control Center vault (`integrations-email.json:14` holds only a reference). A Railway leak reaches them only as "KEK + database", so re-issue them anyway (runbook step 5).
- **MCP:** there is no MCP signing key. Tokens are 32 random bytes stored as SHA-256 (`oauth-core.ts:32-36`), so there is nothing to rotate.
- **Rotation risk:** no secret causes data loss when rotated by the runbook. Short disruptions only: DB and Redis passwords, `INTERNAL_SERVICE_TOKEN`, open download links.
- **Runbook gaps:** `SECRET-ROTATION.md` omits the `BOOTSTRAP_STAGING_OWNER_*` variables, `SMOKE_*`, `STAGING_RESEND_API_KEY`, re-enrolling the staging owner, and the Railway account token.

---

## 4. Correctness

### 4.1 Findings

#### H-3 — High — Credits are settled before the output is checked, so customers pay for unusable results, and the retry key is then dead

- **Area:** AI gateway / money. Contradicts CLAUDE.md §2.4, `docs/AI-GATEWAY.md` §7.3 and AC-11.9. Refines the KNOWN "charged failed turn".
- **Where:** `packages/ai-gateway/src/gateway.ts:907-924` settles on any provider text. The callers validate afterwards:
  - `packages/content/src/studio.ts:371-383`
  - `packages/copilot/src/orchestrator.ts:548-571`
  - `packages/brand-brain/src/chat.ts:358-360`
  - `packages/analytics/src/insights.ts:336-347`, whose own comment says "credits are already settled"
  - `packages/intelligence/src/strategy.ts:445-470`
  - `packages/creative/src/studio.ts:252-265`: no bytes, storage quota or upload failure, all after the charge
- **Retry key:** `persistOutput` defaults to false (`packages/config/src/domains.ts:322`; `gateway.ts:500-501, 1132-1134, 1629`), so a "succeeded" request replays with no output.
  - The composer key is deterministic (`composer-view.tsx:740-743`).
  - The Creative Studio keeps its key after a failure, with a comment saying "Nothing was charged", which is false here.
- **What happens:** malformed, truncated or ungrounded output is charged. Pressing Generate again with the same input fails until the input changes. D-464 accepts keeping the charge only for automation runs, and there with `persistOutput`.
- **How confirmed:** CONFIRMED by code trace.
- **Smallest safe fix:**
  - Let the caller's validator run inside `execute`; settle only if valid, otherwise release.
  - Treat a replayed success with no stored output as re-runnable.
  - Check the storage quota before generating an image.

#### H-4 — High — AI calls run inside a 15-second tenant transaction; slow generations are charged, then return 500 and lose the work

- **Area:** AI gateway / transactions.
- **Where:**
  - `packages/database/src/tenant-client.ts:55-62`: `timeout: options.timeoutMs ?? 15_000`.
  - None of these routes pass `timeoutMs`:
    - `apps/api/src/routes/creative.ts:217-316` (image generation, then upload, in one transaction);
    - `routes/content.ts:306` (generate) and `:415` (AI edit chips);
    - `routes/copilot.ts:459-558`;
    - `routes/brand-brain.ts:229`;
    - `routes/analytics.ts:136, 234`.
  - The gateway settles on the platform client (`apps/api/src/ai-gateway-factory.ts:83-87`), so the charge commits on its own. The route deadline is 30 s (`domains.ts:428`).
- **What happens:**
  - Any provider call over about 15 s (image generation, or a retry) is charged.
  - The next tenant query fails with P2028 and the route returns 500.
  - The draft, asset or message is rolled back.
  - A pooled DB connection is held for the whole call.
- **How confirmed:** CONFIRMED. A real 15,000 ms tenant transaction that idled 16 s returned `P2028 "A query cannot be executed on an expired transaction"`. The timeout was re-verified at `tenant-client.ts:61`. Publishing (`packages/social-connectors/src/publishing.ts:2862-2870`) and the automation executor (`apps/api/src/automation-ai-executor.ts:205-258`) already use the safe shape.
- **Smallest safe fix:**
  - Use the same shape as publishing: checks in transaction 1, the gateway call outside any transaction, writes in transaction 2.
  - Interim: pass `timeoutMs` greater than the route deadline plus margin.

#### Medium — correctness

| ID   | Finding                                                                                                                                                                                                                                                                                                                                         | Where                                                                                                                                                                                                                                                                    | How confirmed                                                                           | Smallest safe fix                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| M-5  | **The trial-end promise contradicts itself.** Onboarding: "When it ends, access to paid features stops and nothing is deleted." Terms: "nothing is locked when the trial ends." Which one the code does was not traced.                                                                                                                         | `apps/dashboard/src/i18n/messages.ts:8507` (en), `:4107` (ar); `apps/dashboard/src/legal/documents.ts:70`; behaviour from `packages/entitlements/src/subscription.ts:138`                                                                                                | Read on the running screens                                                             | Decide the behaviour, then make both texts state it.                                                                                             |
| M-4  | **Workspace deletion keeps all data**, although `SECURITY.md` promises a 30-day grace and then an irreversible purge, and the customer is told the workspace "will be deleted on {date}".                                                                                                                                                       | `docs/SECURITY.md:756`; `packages/onboarding/src/workspace-deletion.ts:15-19`, `apps/api/src/scheduler.ts:2526-2541` (only `status=DELETED`, session revoke, audit; no purge job exists); `messages.ts:4497`                                                             | Traced end to end                                                                       | Before launch, correct the doc and the customer wording. Track the physical purge as an owner decision (PDPL/GDPR).                              |
| M-9  | **Some Control Center settings are activated and audited, but nothing reads them.** (1) Maintenance mode: an operator turning it on in an incident changes nothing for customers. (2) The support-mode time limit: the hard-coded 60 min always applies. (3) `operations.trialDefaultDays`. (4) The whole `usage-limits` and `website` domains. | `packages/config/src/domains.ts:2895` (`maintenanceMode`; only `impact.ts:186` reads it), `:2902` vs `apps/admin/src/server/platform-context.ts:179` + `packages/auth/src/support-mode.ts:37`, `:2933`, `:3030`, `:3064`; doc `CONTROL-CENTER-SETTINGS.md:193, 203, 204` | Grep of every schema leaf across non-test source; operations and website traced by hand | Pass `ttlMinutes` from config. Mark the others "not used yet" in the doc and editor. Owner decides whether maintenance mode is built or removed. |
| M-10 | **Moderation is documented as mandatory but is opt-in, off by default and input-only.** Output moderation was never built. The real provider is live on staging.                                                                                                                                                                                | `docs/AI-GATEWAY.md:195, 507`; `domains.ts:375` (`moderateInput` default false, model null); `gateway.ts:736` (only when both set), fails open `:1275`; `ROADMAP.md:356`, `AI-GATEWAY.md:744`                                                                            | Code read; staging routing not visible                                                  | Correct §5.1/§10 and open an F-item. Owner decides moderation for the beta before production AI is on.                                           |
| M-11 | **The Integrations Hub "Activate" skips validation and leaves a stray draft** on refusal. Every later Simple-mode change on that domain is then refused as "draft open".                                                                                                                                                                        | `apps/admin/src/app/[locale]/console/integrations/actions.ts:339-346`; `apps/admin/src/server/simple-config.ts:58-60`                                                                                                                                                    | Code read                                                                               | Route it through `proposeAndActivate`, which discards failed drafts (`:86-90`).                                                                  |
| M-12 | **The OpenAI adapter treats a truncated or empty answer as success.** It does not check `finish_reason: "length"` or empty content; `maxOutputTokens` defaults to 800, which is tight for multi-variant Arabic JSON. Combined with H-3, truncated JSON is charged and then fails to parse.                                                      | `packages/ai-gateway/src/adapters/openai.ts:217-233`; `domains.ts:310`                                                                                                                                                                                                   | Code read; staging values not visible (SUSPECTED in practice)                           | Classify `length` and empty content as failures before settle; raise the limit for JSON tasks.                                                   |

#### Low — correctness

| ID   | Finding                                                                                                                                                                                                                                                                                      | Where                                                                                                       | Fix                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| L-13 | A rare path charges the wallet but records the request as FAILED with 0 charged: settle commits, then the bookkeeping transaction fails, and the release is a no-op.                                                                                                                         | `gateway.ts:910-924, 1111, 1113-1152`; `credit-ledger.ts:718`                                               | Move bookkeeping out of the provider `try` and retry it.                               |
| L-14 | The per-workspace AI concurrency limit is counted without a lock, so a burst can exceed it. Credits stay safe because the wallet is locked.                                                                                                                                                  | `gateway.ts:374-379, 1382-1384`                                                                             | Advisory lock, as the platform ceiling already uses.                                   |
| L-15 | **Trial traps.** (1) The trial is granted only if the plan has a price in the workspace's currency (USD by default), so dropping the USD price silently gives new sign-ups no trial and 0 credits. (2) The comment says trial credits lapse with the trial; the code sets `expiresAt: null`. | `packages/onboarding/src/workspace.ts:238-243, 324-325, 441-443`                                            | Add a validation or readiness warning; align code and comment after the owner decides. |
| L-16 | MCP tools return raw `AppError.message` (internal English) to the AI app.                                                                                                                                                                                                                    | `apps/api/src/ai-apps/tools.ts:302-304`                                                                     | Map codes to plain bilingual sentences.                                                |
| L-17 | Dormant: the moderation adapter is looked up by `providerKey` instead of `adapterKey`, without an active check and without `allowedHosts`. It would fail open once moderation is turned on (F-104).                                                                                          | `gateway.ts:1295-1298, 1310-1317`                                                                           | Use the main chain's lookup.                                                           |
| L-18 | `discardDraft` reads the status outside a transaction and then runs an unconditional update. A discard racing an activation can mark the new ACTIVE version DISCARDED, so the domain silently falls back to defaults. It also discards SUPERSEDED versions. Untested.                        | `packages/config/src/service.ts:800-817`                                                                    | `updateMany` with `status in (DRAFT, VALIDATED)`, check `count === 1`, add tests.      |
| L-19 | The Studio caption for a new post is capped at the AI brief limit (2000) while channels allow 2200. With AI off, a manual writer cannot type past 2000.                                                                                                                                      | `apps/dashboard/.../content/compose/composer-view.tsx:1964, 1976`; `docs/production-config/content.json:78` | Use the selected channels' `maxBodyCharacters`.                                        |
| L-20 | The workspace-address input's `pattern` is an invalid regex in v-mode (unescaped `-`), so the inline check is silently off. The server still refuses bad addresses.                                                                                                                          | `apps/dashboard/.../onboarding/workspace/form.tsx:286`                                                      | `[a-z0-9\-]`.                                                                          |

### 4.2 KNOWN bugs — confirmed, with root causes where found

| KNOWN bug                                                                                | Status                                                                                 | Root cause / where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Smallest fix                                                                                                                              |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Copilot ZodError and a charged failed turn                                               | **Confirmed.** Root cause traced.                                                      | (1) The prompt lists tools as `key (actionClass)` with no argument shape (`packages/copilot/src/orchestrator.ts:827-831`) but asks for `"arguments": object` (`:868-870`). (2) `CopilotPlanService.createPlan` calls `tool.input.parse` (`packages/copilot/src/plans.ts:297`); the raw ZodError becomes 500 via `apps/api/src/routes/phase7-context.ts:227-228`. (3) A second trigger: `saveFact.area` is a strict enum (`orchestrator.ts:126-133`) while the prompt says `string\|null` (`:861`). The charge is H-3; the lost user message is H-4's rollback.                                                    | `safeParse` per step, moving bad steps to `rejectedToolKeys`; put argument schemas in the prompt; let `area` fall back to null; plus H-3. |
| "##" hashtags                                                                            | **Confirmed.**                                                                         | The model's tags are stored verbatim (`packages/content/src/schemas.ts:96-98`) and the renderers add "#": `packages/ui/src/social-post-preview.tsx:446`, `draft-editor.tsx:267/295/519`, `approvals-view.tsx:523`, `packages/content/src/templates.ts:514`. `mergeHashtags` (`studio.ts:975`) treats "#a" and "a" as different. Published captions are stripped (`meta/base.ts:275`, `tiktok/adapter.ts:606`), **except hashtags placed in the first comment, which are published with "##"**.                                                                                                                    | Strip a leading "#" in the parser, as `templates.ts:94` already does.                                                                     |
| image.generate INVALID_REQUEST on Studio sizes                                           | **Confirmed.**                                                                         | `packages/creative/src/formats.ts:40,48,56,64` (1080×1080, 1080×1350, 1080×1920, 1200×675) are passed unchanged through `creative/src/studio.ts:232` and `adapters/openai.ts:241`. OpenAI accepts only 1024×1024, 1536×1024, 1024×1536 and auto, so the 400 is classed INVALID_REQUEST (`openai.ts:294-300`) and replayed as deterministic (`gateway.ts:264-275`). Every Studio image fails.                                                                                                                                                                                                                      | Map to the nearest supported size, then resize or crop to the format.                                                                     |
| Simple-mode AI set-up missing the D-13 privacy questions                                 | Confirmed absent from the Simple AI card.                                              | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | As queued.                                                                                                                                |
| "Conflicts with the current state" on activating an unvalidated draft                    | **Confirmed.** Root cause traced.                                                      | The configuration page reads the high-impact count from the stored preview, which is null until "Validate & preview" runs (`apps/admin/src/app/[locale]/console/configuration/page.tsx:264`), so no acknowledgement box is drawn (`:378-400`). `activate()` recomputes the preview and throws CONFLICT for unacknowledged high-impact changes (`packages/config/src/service.ts` ≈650-660). Every CONFLICT maps to the generic sentence (`apps/admin/src/i18n/status-messages.ts:29-30`). Credit rules, repricing, removals and disabling a model are always high-impact (`packages/config/src/impact.ts:85-107`). | Enable Activate only after validation (or compute the preview on render); give this refusal its own message.                              |
| Instagram "Ready" with no media                                                          | Confirmed as a **UI-only** issue.                                                      | The server refuses Instagram without media at publish time (`packages/content/src/media-readiness.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | As queued.                                                                                                                                |
| Noisy post history                                                                       | Confirmed. It also makes the Activity filter slower (section 8.7, "Also worth doing"). | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | As queued.                                                                                                                                |
| Add media drawer height and partial backdrop                                             | Confirmed. Related: there are four backdrop treatments on two z-index scales (D-5).    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | As queued.                                                                                                                                |
| Post title not editable                                                                  | Confirmed.                                                                             | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | As queued.                                                                                                                                |
| Brand Brain chat refusing small talk and answering in English                            | **Confirmed (small talk); English SUSPECTED.**                                         | Small talk: `packages/brand-brain/src/chat.ts:282` refuses for free whenever no fact matches (`retrieval.ts:279`), and the instructions say "Answer ONLY from the reference material" (`chat.ts:137-153`). English: the only Arabic in the request is the user's question, fenced as untrusted reference text (`packages/shared/src/untrusted-text.ts:83`) inside English instructions (`openai.ts:126`). The fallback language is English unless the brand's default locale is `ar` (`packages/shared/src/prompt-language.ts:42-46`).                                                                            | A conversational branch for non-fact messages; detect Arabic letters and state the answer language explicitly.                            |
| AI edit chips (Shorter/Friendlier) not effective                                         | Confirmed as reported. **Root cause not found.**                                       | The server path is correct (`studio.ts:118-121, 719-731`; `composer-editor.ts:207-214`). Three candidates: (a) the generic "never invent… without dropping any fact" instruction makes the model return near-identical text; (b) `draft-editor.tsx:270-288` keeps showing a stale local edit; (c) the edit fails through H-4 / H-3. Needs a live model and a browser.                                                                                                                                                                                                                                             | —                                                                                                                                         |
| Sessions not remembered                                                                  | **Confirmed.** Root cause traced.                                                      | The cookie `maxAge` is fixed at the 12 h idle time (`packages/auth/src/realms.ts:33`), set in `apps/dashboard/src/app/[locale]/(auth)/actions.ts:104-110, 355-361` and `settings/security/actions.ts:394`. The server slides the session to 30 days but never re-issues the cookie.                                                                                                                                                                                                                                                                                                                               | Re-issue the cookie when the server slides the session.                                                                                   |
| No post delete/trash; post card media and card heights; connector icon showing Railway's | Confirmed as reported.                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | As queued.                                                                                                                                |
| F-107, F-110                                                                             | Remain open; nothing found that changes them.                                          | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                         |

### 4.3 What was checked and found fine (correctness)

- **AI gateway:**
  - The idempotency key is claimed by a unique insert before the wallet is touched; a racing duplicate replays or is told to wait.
  - Transient failures re-run, deterministic ones replay, and every failure path releases the hold.
  - There is a per-attempt timeout and a stuck-request sweep.
  - **PR #91 cap (D-573):** `charged = min(metered, reservation)` (`gateway.ts:907-908`). The real provider cost is still recorded and the reservation covers the dearest model in the chain. It is tested (`d573-ai-provider.test.ts:399-427`).
  - Platform ceiling: advisory lock, with the owner alert sent once per period, including across processes.
- **Credit ledger:** row locks; settle and release are idempotent; FIFO buckets; reserve refuses a workspace pending deletion (`credit-ledger.ts:441-800`).
- **Publishing worker:**
  - The claim is a conditional update, so there is no double send across workers or duplicate deliveries (`publishing.ts:676-705`).
  - The send runs outside any transaction. An uncertain outcome is looked up or set to `VERIFICATION_PENDING`, never resent.
  - BullMQ retries are not used for publishing; backoff with jitter comes from config.
  - Expired or reauth-needed accounts are held until the lateness deadline; tokens are refreshed ahead (`scheduler.ts:930-1001`).
  - Per-channel media rules are checked before the provider call.
  - Tests count actual provider calls.
- **Approvals:** `FOR UPDATE` plus conditional updates.
- **Workspace deletion:** conditional claim and locked subscription row, apart from M-4 and H-5.
- **Invitations:** single-use, consumed conditionally in a transaction.
- **Seats:** not enforced by design (D-233 still open).
- **Control Center Simple mode:**
  - Every card writes through the configuration service: create draft → validate → preview → activate, behind a confirm box.
  - Undo creates a new version.
  - There are no direct DB writes in `apps/admin` outside the services.
  - Every activation is audited.
  - Dual control applies to the financial domains.
- **MCP tools:**
  - per-tool permission and scope, re-checked live on every call;
  - `create_post` is idempotent on an input hash;
  - every call is audited;
  - no credits are spent;
  - `TOOL_NAMES` (`tools.ts:69-81`) matches the 11 tools in `AI-APPS.md:46-56`.
- **AI tasks:** the 12 tasks in `AI-GATEWAY.md` §5.1 match `tasks.ts:60-150`. Routing, models and costs come from configuration, not code (CLAUDE.md §2.2).
- **Automation executor:** calls the gateway outside tenant transactions; D-464 applied as decided.
- **i18n:** ar/en parity test passes.

---

## 5. Data and migrations

### 5.1 Findings

#### M-8 — Medium — A green migration job on Railway does not prove the migration succeeded

- **Area:** Migrations / deployment. This is the question about Railway showing SUCCESS on a failed migration.
- **Where:**
  - The migration service exists only in the docs: `docs/RAILWAY-DEPLOYMENT.md` §4.1 and §22 item 6, and `docs/GO-LIVE-RUNBOOK.md:123-129`.
  - Its start command is `pnpm --filter @brandspace/database exec prisma migrate deploy`, with no healthcheck and restart policy NEVER. It is not in `.railway/railway.ts`.
- **What happens and how it was confirmed:**
  1. **The command itself fails correctly (CONFIRMED).** Exit code 1 for:
     - a SQL error halfway through the chain;
     - a re-run over the failed row (P3009);
     - the root script `pnpm db:migrate:deploy`;
     - `sh -c`;
     - a missing URL;
     - an unreachable host;
     - a non-empty schema (P3005).

     There is no `||`, `;`, pipe or wrapper anywhere in the chain.

  2. **It can exit 0 without migrating (CONFIRMED).** A misspelt filter (`--filter @brandspace/databse`) prints "No projects matched the filters" and exits 0. The same typo in the pre-deploy `wait-for-migrations` exits 0, which silently turns off the race guard. Both commands are typed into Railway by hand.
  3. **Most likely cause of the earlier SUCCESS (SUSPECTED; no Railway access, no incident record in the repo):**
     - The service has no healthcheck, so Railway marks the deployment SUCCESS, and reports it to GitHub, once the container starts.
     - The exit 1 seconds later shows only as a later "Crashed" or stopped state.
     - The typo in (2) is the other possible cause.
- **Is it fixed?** Partly.
  - The consequence is covered: the pre-deploy `wait-for-migrations` plus readiness gates stop app releases from going live on an old schema. Against a failed DB it waited and then exited 1 at its timeout, so a failed migration costs 1,800 s before the releases fail (L-24).
  - The misleading status itself is not fixed.
  - Whether the pre-deploy commands are actually set on the live services could not be checked.
- **Smallest safe fix:**
  - Run `prisma migrate deploy` as the migration service's **pre-deploy command**. A non-zero pre-deploy marks the deployment FAILED in Railway and on GitHub.
  - Use `pnpm -C packages/database exec …` (or `--fail-if-no-match`) so a typo fails. Do the same for `wait-for-migrations`.
  - Make the `prisma migrate status` check in GO-LIVE §4 step 3 mandatory.

#### Low — data

| ID   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                      | Where                                                                                                                                                    | Fix                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| L-21 | The dev seed's guard checks the `APP_ENV` _label_, not the target database. `pnpm db:seed` from a laptop holding a production URL and no `APP_ENV` would create `owner@brandspace.local` (platform_owner) and two demo workspaces in production. Seeds and both bootstraps also rewrite every system role's permissions globally: a reseed after later migrations removed `client_viewer\|notes.manage` (CONFIRMED locally). | `packages/database/prisma/seed.ts:92, 166`; `packages/shared/src/deployment.ts:74`; `bootstrap-staging-owner.ts:72`; `bootstrap-production-owner.ts:198` | Add the localhost-URL guard from `tests/e2e/seed-ai.ts:108-122` to `seed.ts`. |
| L-22 | One applied migration was edited after it landed on staging (comment-only, 3 lines). Harmless: `migrate deploy` and `status` exit 0 with the old checksum. It breaks the "never edit an applied migration" rule.                                                                                                                                                                                                             | `20261023091000_ai_app_token_replaced_scoped`: landed in `3c690bd5`, edited in `c2f99b20` (merged `3d54ee6b`)                                            | Leave it; add a CI check on migration-file edits after merge.                 |

### 5.2 What was checked and found fine (data)

- **All 99 migrations apply cleanly** with the migrator role (exit 0, about 13 s).
- **`prisma migrate diff`** (`--from-config-datasource --to-schema prisma/schema.prisma --exit-code`; Prisma 7.10 has no `--to-schema-datamodel`) is **empty**: "-- This is an empty migration." The reverse direction reports "No difference detected."
- **Forward-only:** 11 migration files have more than one commit; 10 were edited only inside the same merge (L-22 is the exception). There is no `DROP TABLE` or `DROP COLUMN`. The two `RENAME COLUMN`s are early and already on `main`. Data `UPDATE`s are bounded backfills.
- **The migration manifest** (`EXPECTED_MIGRATIONS`) equals the folder list.
- **`prisma.config.ts`** fails closed and never overrides injected variables.
- **Seeds never touch customer workspaces in production:**
  - the e2e seeds refuse production and require a localhost URL;
  - `seed-social.ts` and `seed-analytics.ts` are unguarded, but they abort unless the guarded e2e workspace exists;
  - the production bootstrap is interactive and never stored on Railway.

---

## 6. The beta as configured (`docs/production-config`)

All ten documents were loaded into a local database through the real `createDraft → validateDraft → activate` path, in the runbook's order:

- They validated with **no issues and no warnings**, and all are ACTIVE.
- `integrations-email.json` was not activated, because it names the production vault reference.
- AI is **off**: no `ai.*` domain is active.
- Two fresh accounts, one in English and one in Arabic, signed up through the UI and finished onboarding.

### 6.1 Findings

| ID   | Sev                                          | Finding                                                                                                                                                                                                                                                                                                                                                                           | Where                                                                                                           | How confirmed                                 | Smallest safe fix                                                                                                                                                                                    |
| ---- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-6  | Medium (High if `web` is the public landing) | **The public website `apps/web` is still the Phase-1 scaffold.** It says "Phase 1: foundations only. No product features yet." / "المرحلة الأولى: الأساسات فقط…". An English-only line, "Public website shell.", shows in Arabic as ".Public website shell". There are no links to terms, privacy, sign-up or pricing, and no trial numbers. The docs give `web` a public domain. | `apps/web/src/app/[locale]/page.tsx:9-27` (line 22 is the English line); `docs/RAILWAY-DEPLOYMENT.md:758, 1309` | Ran it (screenshots `landing.png`, en and ar) | If the real landing page is the separate Landing-page repository, do not give `web` a public domain, or redirect `/` to sign-up. Otherwise replace the scaffold and add the legal and sign-up links. |
| M-5  | Medium                                       | The trial-end contradiction (section 4.1).                                                                                                                                                                                                                                                                                                                                        | —                                                                                                               | —                                             | —                                                                                                                                                                                                    |
| L-23 | Low (launch item)                            | **The legal pages still carry the bracketed placeholders** ([LEGAL ENTITY NAME], [MINIMUM AGE], [HOSTING REGION]…) and the "not reviewed by a lawyer" banner. Deliberate per D-512, but they must be filled before real users are invited. Inside the signed-in app, Privacy is linked only from the upload notes, not from Settings → Data.                                      | `apps/dashboard/src/legal/documents.ts`                                                                         | Read on screen, en and ar                     | Fill the placeholders (owner/lawyer); add a Privacy link in Settings.                                                                                                                                |
| L-25 | Low                                          | **Strategy stays on the rail with AI off, but only AI can fill it.** A fresh workspace is told to "Plan one under 'Next strategy'", and that screen says "AI isn't available yet." It does not contradict Q9.                                                                                                                                                                     | `apps/dashboard/.../strategy/page.tsx:115-117`; `workspace-shell.tsx:109`                                       | Ran it                                        | Owner decision: hide the item while AI is off, or change the empty-state wording.                                                                                                                    |
| L-26 | Low                                          | Home's "Next to publish" shows a photo-like gradient thumbnail next to "Nothing scheduled", which is not an honest empty state.                                                                                                                                                                                                                                                   | Home (`shots/en/1536x864/home.png`)                                                                             | Ran it                                        | Show the empty glyph.                                                                                                                                                                                |

### 6.2 What was checked and found fine (beta configuration)

- **Trial numbers are right everywhere they appear, in English and Arabic:**
  - sign-up: "90-day free trial with 500 credits. No card needed.";
  - onboarding step 1;
  - Plan & billing: "Trial ends Jan 26, 2027" (= Oct 28 + 90), 500 trial credits, 500 AI credits, 0 of 3 accounts, 0 of 100 posts, 5 GB;
  - the Control Center's Trial & credits screen and Plans card.

  They come from configuration (`{days}` / `{credits}`; `docs/production-config/plans.json:30-32`, read at `packages/onboarding/src/workspace.ts:238-243`). The e-mail templates (verification, reset, invitation, en and ar) carry no trial numbers and render correctly in RTL.

- **With AI off, nothing AI-only is visible:**
  - no Copilot button, "Ask Copilot", AI-credits tile or profile-menu credits;
  - `/copilot`, `/intelligence`, Media → Generate, the Studio caption and Settings → AI all say "AI isn't available yet.";
  - Connected AI apps says "AI apps are turned off for this workspace.";
  - the Control Center says "AI: Disabled — AI controls are hidden from customers".
- **No LinkedIn or X on any customer screen.** A regex sweep of 26 routes × 2 languages found none; they appear only in the Control Center Channels page as "Hidden / Not available yet". The Studio offers only Instagram, Facebook and TikTok.
- **No raw keys or sample data.** No raw i18n or config keys, `undefined`, `NaN`, "sample", "demo" or "fixture" text on any customer screen (52 route × language combinations swept, plus visual review).
- **Honest empty states** in a brand-new workspace: Posts, Approvals, Calendar, Publishing log, Performance ("—", never a fake zero), Campaigns, Automations, Notes, Notifications, Media, Brand Brain (apart from L-26).
- **Legal pages:** `/terms`, `/privacy` and `/data-deletion` exist in en and ar, signed in or out. They are linked from sign-up through required checkboxes, from onboarding and from the upload notes.

---

## 7. UI / UX — en and ar, RTL, 1536×864, 1920×1080 and 375×812

Coverage:

- **Screens:** 26 dashboard screens, 19 Control Center Simple-mode pages, landing, status, sign-in, sign-up and the legal pages.
- **Variants:** en and ar, at all three viewports, as a viewport frame plus a full-page capture.
- **Workspaces:** a fresh beta-configured workspace, plus the seeded e2e fixture for populated screens.
- **Checks:** axe 4.13 (wcag2a/aa, 21a/aa, 22aa, best-practice) on every screen; keyboard passes in both languages.

### 7.1 Findings

| ID   | Sev                                                   | Finding                                                                                                                                                                                                                                                                                                                                                                                                              | Where                                                                                                                                                                                                      | Fix                                                                                                                                                                                                |
| ---- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-2  | Medium                                                | **Customer inputs ignore the input-border token, and with it the D-55 "increase contrast" restoration.** With the OS set to increase contrast, Control Center inputs get a 3:1 border; customer inputs stay at about 1.27:1 (`#e4e4e8` on white). Contradicts D-55 and DESIGN-SYSTEM §2. The rule `.bsp-frame :where(...)` (0,2,0) beats `.bs-control` (0,1,0), and a literal cannot be redirected by a media query. | `packages/ui/src/prototype.css:806-840` (`:816` border, `:839` hover) and about 13 per-screen rules; `tokens.css:984-997, 1021`                                                                            | Add `--bs-control-border-customer: #e4e4e8` (and a hover token), use it in those rules, and point it at the contrast token inside the existing `prefers-contrast` block. No default visual change. |
| L-27 | Low (a11y; the repo requires zero serious violations) | The legal pages fail axe `target-size` (serious, WCAG 2.5.8): the table-of-contents links are 15 px tall in English and 23 px in Arabic. 6 / 5 / 3 nodes in English and 8 / 12 / 5 in Arabic (terms / privacy / data-deletion). These pages are not in the e2e axe sweep.                                                                                                                                            | `apps/dashboard/src/components/legal-page.tsx`                                                                                                                                                             | 24 px minimum height; add the pages to the axe e2e.                                                                                                                                                |
| L-28 | Low                                                   | AA-failing grey `#8a8a92` (3.43:1) on 11 px text: the business-switcher caption, the account-menu e-mail, the Settings → Notifications header. Contradicts D-470(2). Ratio computed, not run in axe.                                                                                                                                                                                                                 | `packages/ui/src/prototype-rail.tsx:150, 416`; `prototype.css:9763`                                                                                                                                        | Use `var(--bsp-faint)`.                                                                                                                                                                            |
| L-29 | Low                                                   | Brand Brain orb labels collide with the dots ("Strategy", "Audience") and are cut off at the card edges at 375 px in both languages.                                                                                                                                                                                                                                                                                 | `shots/en/1536x864/brand-brain-full.png`; `sheets/ar-375x812-dash-0.jpg`                                                                                                                                   | Clamp the labels inside the orb box.                                                                                                                                                               |
| L-30 | Low                                                   | Arrows are not mirrored in RTL: "عرض الكل →", "اسأل المساعد →", "أنشئ منشورًا لها →" point right, which reads as "back".                                                                                                                                                                                                                                                                                             | `messages.ts:4249` and neighbours                                                                                                                                                                          | An icon with `scaleX(-1)` under `[dir=rtl]`.                                                                                                                                                       |
| L-31 | Low                                                   | Mixed-direction text in the Arabic Control Center: "$US 29.00 شهريًا"; "2026-10 beta draft" renders as "beta draft 2026-10".                                                                                                                                                                                                                                                                                         | Plans card; Legal pages (`sheets/ar-375x812-cc-1.jpg`)                                                                                                                                                     | Wrap Latin and number runs in `<bdi>`.                                                                                                                                                             |
| L-32 | Low                                                   | Keyboard focus falls to `<body>` after "+ Add the design" in a new post.                                                                                                                                                                                                                                                                                                                                             | Studio `composer-add-design`                                                                                                                                                                               | Move focus into the Design panel after the re-render.                                                                                                                                              |
| L-33 | Low                                                   | After a failed sign-in, focus goes to `<body>`, and the `role=alert` region also holds the "Welcome back" heading, so it is announced as an alert. A plain wrong password also shows a raw reference UUID.                                                                                                                                                                                                           | `/sign-in?error=…`                                                                                                                                                                                         | Focus the error; keep only the error inside `role=alert`.                                                                                                                                          |
| L-34 | Low                                                   | Layout shift on Campaigns (CLS 0.181 laptop / 0.397 phone) and Calendar (0.064 / 0.358), and Brand Brain on phone (0.140).                                                                                                                                                                                                                                                                                           | Measured                                                                                                                                                                                                   | Reserve tile and chip sizes (`aspect-ratio` / minimum sizes).                                                                                                                                      |
| L-35 | Low                                                   | A media file that fails to load shows a broken-image icon, or white overlay text on grey at 1.21:1 (axe `color-contrast`, serious). This will happen in production whenever an object is missing or storage is misconfigured.                                                                                                                                                                                        | Post cards, Approvals preview, onboarding logo                                                                                                                                                             | `onError` fallback to the text-only tile; hide the overlay title when there is no image.                                                                                                           |
| L-36 | Low                                                   | Copy slips: "0 of 1 key questions"; Arabic "0 من 2 أسئلة" (dual form needed); "500 رصيدًا" should be "500 رصيدٍ"; Control Center "1 brands" / "1 workspaces". On phones the 14-item Settings nav sits above the content and its group headings look like items ("الأمان" twice in a row).                                                                                                                            | `messages.ts:5423/5445, 1134, 358, 4107`                                                                                                                                                                   | Copy fixes; collapse the phone settings nav.                                                                                                                                                       |
| L-37 | Low                                                   | Control Center buttons have no hover: the inline fill blocks it, and the `.bsp-btn` class they also carry is defined only in `prototype.css`, which admin does not load. The owner's decision that the Control Center keeps its own look is respected; this is about the missing hover.                                                                                                                              | `apps/admin/.../simple-ui.tsx:91-92`, `customers.tsx:180, 793, 832, 876`, `features.tsx:272, 400`, `ai.tsx:646`, `open-drafts.tsx:113`, `mode-switch.tsx:187-233`; `packages/ui/src/primitives.tsx:89-151` | A class-based button with a console token set (D-3 in section 9).                                                                                                                                  |

### 7.2 Prototype parity (against `docs/visual-reference/prototype-2026-09-27`)

- **The repository's parity spec passed 52/52** against the local build. Side-by-side pairs are in the screenshot zip (`shots/parity-pairs/`).
- **Every visible difference except two is already a recorded decision or authorised deviation:**
  - Home without search (D-485);
  - zero-padded counts (ported from the prototype's `kfmt`);
  - media-first post tiles and filters (D-282); Calendar filters (D-290);
  - the Studio without a pillar and with the product's preview (contract §4.5);
  - the Approvals reason field; "No invoices yet";
  - Team without "View as" (D-486);
  - the Performance data-freshness banner;
  - Automations "Needs you" (B12); the Media storage bar (C7).
- **New, unrecorded differences:**
  - L-35 (the media fallback).
  - L-38: `docs/UI-FIDELITY-CONTRACT.md` §4.5 is out of date. It says "§27 no autosave… 'Saved 5 min ago'", but the Studio now says "Saves as you type" and creates the draft on first input (D-472). It lists "Write caption with AI on a written post" as left out, but the product draws it. Fix: update the contract.

### 7.3 What was checked and found fine (UI/UX)

- **Direction:** every Arabic page is `dir=rtl`. The rail, settings nav, toggles, progress bars and calendar grid mirror correctly.
- **No horizontal scroll** on any of the 312 dashboard and admin captures at 375, 1536 or 1920 px.
- **axe, fresh workspace:** the dashboard (26 routes × en/ar) has 0 violations apart from the legal pages (L-27). The landing page has 0.
- **axe, seeded workspace:**
  - Dashboard: only `region` (moderate) for the floating Copilot label, which exists only with AI on.
  - Control Center Simple (19 pages × 2): only `heading-order` (moderate) on Integrations, System, Team and Change history.
- **Contrast:** no contrast failure with real data.
- **Keyboard:**
  - Sign-in: logical order and a 2 px `#7935FE` focus ring everywhere.
  - Studio: 45 tab stops, a visible ring on every control, no trap.
  - Mobile nav drawer: focus moves in, Tab stays inside (30/30), Escape closes and returns focus.
  - Create and account menus: Escape returns focus.

---

## 8. Performance — why the app feels laggy, and the top 10 changes

The staging figures you gave fit what was measured locally: p50 20–40 ms, p90 350–530 ms, p99 ≈ 2.7 s, about 2,100 requests in 6 h from one user, and about 1.3 GB RAM idle.

- **p90 (350–530 ms)** is each page doing 170–360 SQL statements in 22–41 transactions, run one after another, with nothing shown until the whole page is ready.
- **p99 (≈ 2.7 s)** is cold starts. Staging sleeps, and each page also waits on an HTTP hop to the api.
- **The "not smooth" feel** is mainly one CSS rule. A full-window `backdrop-filter: blur(30px)` sits over an always-animating blurred background, and it drops scrolling to 7–9 fps on a throttled laptop.
- **On phones**, every page ships both full dictionaries, so they parse about 1.2 MB of JS.

Measured locally on production builds, signed in. The database is on the same machine, so real numbers on Railway are higher. Lighthouse was not available; Playwright with CDP CPU throttling was used. Headless Chromium draws in software, so the scroll numbers are a worst case. The relative comparison holds.

### 8.1 Server time per navigation (warm; SQL counted from the Postgres log, dashboard role only)

| Route                      | TTFB median (ms) | TTFB cold | SQL statements / render | Transactions | JS gzip KB | JS decoded KB | RSC prefetches on load |
| -------------------------- | ---------------- | --------- | ----------------------- | ------------ | ---------- | ------------- | ---------------------- |
| /overview (Home)           | 483              | 727       | ~358                    | 41           | 341        | 1,189         | 20                     |
| /settings                  | 493              | 492       | ~188                    | 24           | 343        | 1,196         | 33                     |
| /brand-brain               | 398              | 561       | ~286                    | 36           | 368        | 1,284         | 7                      |
| /analytics                 | 380              | 435       | ~261                    | 25           | 341        | 1,189         | 9                      |
| /notes                     | 347              | 353       | ~261                    | 32           | 343        | 1,194         | 10                     |
| /content                   | 332              | 365       | ~213                    | 27           | 350        | 1,213         | 23                     |
| /calendar                  | 316              | 454       | ~224                    | 26           | 356        | 1,232         | 14                     |
| /content/compose (Studio)  | 303              | 341       | ~209                    | 30           | 384        | 1,338         | 8                      |
| /settings/ai-apps          | 296              | 316       | ~175                    | 22           | 341        | 1,188         | 30                     |
| /automations               | 278              | 308       | ~204                    | 27           | 345        | 1,206         | 13                     |
| /members                   | 278              | 345       | ~193                    | 23           | 341        | 1,189         | 30                     |
| /assets                    | 265              | 306       | ~203                    | 24           | 355        | 1,235         | 10                     |
| /billing                   | 261              | 323       | ~206                    | 26           | 343        | 1,194         | 28                     |
| /campaigns                 | 258              | 402       | ~201                    | 25           | 348        | 1,207         | 15                     |
| /notifications             | 251              | 245       | ~171                    | 22           | 341        | 1,188         | 11                     |
| /approvals                 | 241              | 281       | ~185                    | 24           | 344        | 1,197         | 9                      |
| /publishing                | 240              | 277       | ~189                    | 24           | 341        | 1,189         | 15                     |
| /sign-in, /sign-up, /terms | —                | —         | —                       | —            | 330–331    | 1,155–1,156   | 2–5                    |
| web /en                    | —                | —         | —                       | —            | 185        | 614           | 2                      |
| admin /console             | —                | —         | —                       | —            | 186        | 617           | 0                      |

- **What one Home render does (318 statements, 36 transactions):**
  - `customer_session`, `membership`, `role`, `role_permission`, `permission` and `user` are each read **7 times**;
  - `entitlement_catalogue_snapshot` is read **17 times**;
  - plus 36 BEGIN/COMMIT and 36 `set_config` pairs.
- **A full browser navigation including prefetches** costs about 330–460 statements.
- **Pages do not stream:** TTFB equals total server time.
- **CSS and fonts per dashboard route:** CSS is 47 KB gzip; fonts are 96–120 KB.

### 8.2 Client side (web vitals; laptop = 1536×864 at 4× CPU, phone = 375×812 at 6× CPU)

| Route            | Laptop LCP | Laptop CLS | Laptop TBT | Phone LCP | Phone CLS | Phone TBT | Longest task (phone) |
| ---------------- | ---------- | ---------- | ---------- | --------- | --------- | --------- | -------------------- |
| /overview        | 1,732      | 0          | 637        | 1,236     | .006      | 2,185     | 502                  |
| /brand-brain     | 2,360      | .034       | 715        | 2,740     | .140      | **5,247** | 432                  |
| /content/compose | 1,520      | .001       | 297        | 1,560     | .006      | 652       | 363                  |
| /content         | 1,460      | 0          | 367        | 620       | .006      | 874       | 255                  |
| /approvals       | 1,572      | 0          | 584        | 1,536     | .077      | 853       | 431                  |
| /calendar        | 1,568      | .064       | 408        | 1,400     | **.358**  | 1,322     | 422                  |
| /campaigns       | 1,420      | **.181**   | 345        | 1,256     | **.397**  | 863       | 308                  |
| /analytics       | 1,380      | 0          | 275        | 1,372     | .009      | 467       | 238                  |
| /automations     | 1,240      | .049       | 389        | 1,224     | .006      | 690       | 475                  |
| /members         | 1,068      | 0          | 22         | 1,340     | .006      | 1,043     | 449                  |
| /publishing      | 1,180      | 0          | 130        | 560       | .006      | 482       | 193                  |
| /sign-up         | 212        | 0          | 172        | 232       | 0         | 384       | 228                  |

Times are in ms. The longest single click handler measured 312–840 ms on the laptop profile (one click per route, indicative only).

- **Dictionaries in every bundle:** one 516 KB chunk (136 KB gzip) holds about 6,539 dictionary entries, the whole of `src/i18n/messages.ts` (602 KB source) in both locales. It is pulled into every page, sign-in and legal pages included, because client components import it directly: `[locale]/error.tsx:6`, `not-found.tsx:6`, `components/upload-field.tsx`, `brand-brain/*`, `asset-library-view.tsx:42`, `copilot-view.tsx:23`.
- **Heavy third-party libraries are not the cause.** The runtime imports only react, next and qrcode: no chart, editor, date, icon-pack or animation libraries.

### 8.3 Scroll smoothness and the cost of the visual effects

Measured by scrolling `main` 12 px per frame for 4 s. Values are fps, with the p95 frame time in brackets.

| Viewport / CPU | Route                           | With effects | All effects removed                                 | Only `backdrop-filter` removed |
| -------------- | ------------------------------- | ------------ | --------------------------------------------------- | ------------------------------ |
| 1536 / 4×      | /overview                       | 7 (167 ms)   | 26                                                  | 19                             |
| 1536 / 4×      | /calendar                       | 8 (233 ms)   | 56                                                  | **39**                         |
| 1536 / 4×      | /content                        | 9            | 58                                                  | —                              |
| 1536 / 4×      | /analytics                      | 8            | 56                                                  | —                              |
| 1536 / 4×      | /brand-brain                    | 7            | 20 (the orb's JS remains)                           | —                              |
| 375 / 6×       | /calendar, /content, /analytics | 59–60        | 60                                                  | —                              |
| 375 / 6×       | /overview, /brand-brain         | 8–11         | 8–10 (cost is JS: 31–41 long tasks while scrolling) | —                              |

**Removing box-shadow, animations, gradients or `filter` alone changed nothing (7–9 fps). The cost is the `backdrop-filter`.**

- **The app frame:**
  - `.bs-shell.bsp-frame` is `rgba(255,255,255,.93)` with `backdrop-filter: blur(30px)` over the whole window (`packages/ui/src/prototype.css:1255-1268`).
  - Underneath is `AmbientBackground`: three 56vw orbs with `filter: blur(100px)` and an infinite 16 s translate+scale animation in a fixed layer (`packages/ui/src/ambient.tsx:30-60`, `tokens.css:721, 732-737`).
  - It is mounted by `packages/ui/src/customer-shell.tsx:753` and the admin `app-shell.tsx:863`.
  - Because the backdrop moves every frame, the full-window blur is recomputed on every frame, even on an idle page. At 93 % opacity the blur is barely visible.
- **Other blurs over moving or scrolling content:**
  - the Copilot button (`prototype.css:1758-1773`);
  - the Studio save bar (`:4453`);
  - `.bb-hero` (`brand-brain.css:80`);
  - dropdowns (`tokens.css:1948, 2191`, `prototype.css:13778`);
  - drawers and dialogs (`overlays.tsx:979`, `post-detail-drawer.tsx:131`, `copilot-shell.tsx:1054`).

  In total there are 32 `backdrop-filter` in CSS plus 5 inline, and 27 `filter: blur`.

- **The Home hero canvas** redraws every frame and calls `getBoundingClientRect()` each frame, forcing layout. There is no IntersectionObserver (`packages/ui/src/prototype-hero-canvas.tsx:113-140`), plus a 14 px blur on top (`overview-hero.tsx:206`).

### 8.4 Every polling loop

**Home recorded for 120 s visible, 60 s hidden and 15 s visible again: 0 requests after load.** No layout polls, and there is no SWR, react-query, EventSource or WebSocket.

| Loop                        | file:line                                                                            | What and how often                                                                                             | Stops when tab hidden?                         | On every page?                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RefreshWhile`              | `apps/dashboard/src/components/refresh-while.tsx:31-41`                              | Full `router.refresh()` (≈ 200–300 SQL statements each) every 2.5 s for 3 min, **then every 15 s with no end** | Skips the refresh, but the timer keeps running | No. Only while something is pending: assets (`asset-library-view.tsx:1122`), Brand Brain (`brand-brain-view.tsx:927`, `look-card.tsx:471`), onboarding (`onboarding/page.tsx:575, 925`) |
| Composer autosave + refresh | `content/compose/draft-editor.tsx:696-705`, `:713-718`; `composer-view.tsx:848, 872` | Save 900 ms after each typing pause, then a **full page refresh 600 ms later**                                 | n/a                                            | Studio only                                                                                                                                                                             |
| Composer media wait         | `draft-editor.tsx:943-946`                                                           | Refresh every 3 s, up to 40 times                                                                              | n/a                                            | Studio only                                                                                                                                                                             |
| Copilot clock               | `copilot-view.tsx:254`                                                               | 15 s local tick, no request                                                                                    | —                                              | —                                                                                                                                                                                       |

**Reconciling ~350 requests per hour from one user:**

- One stuck item (an asset scan still PENDING, a Brand Brain source still "reading", for example while the worker is down) keeps a visible tab refreshing every 15 s: about 240 full renders per hour.
- Normal browsing adds about 6 navigations × (1 page + ~3 hover prefetches + ~10 uncached thumbnails) ≈ 84 per hour.

**Recommendation:** check staging for assets with `scanStatus='PENDING'` or status UPLOADING/PROCESSING, and for Brand Brain sources stuck reading. Group the request log by `/assets/file/`, `_rsc`, `Next-Router-Prefetch` and `/v1/`.

**Fix for `RefreshWhile`:** poll a tiny status endpoint instead of re-rendering the page, use a longer interval, stop after N minutes, and pause the timer when the tab is hidden.

### 8.5 What smooth sites use that is missing

| Technique                                                       | State here                                                                                                                                                                                                                                       | Where                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instant feedback (`loading.tsx`, skeletons, Suspense streaming) | **None.** No `loading.tsx` anywhere; one `<Suspense>` (`workspace-shell.tsx:1077`); every page is `force-dynamic`                                                                                                                                | `apps/dashboard/src/app`                                                                                                                                                                                                                                                  |
| Parallel data loading                                           | Mostly sequential. `overview/page.tsx:132-575` runs about 16 independent transactions one after another; `Promise.all` inside one transaction is still serial (one connection)                                                                   | —                                                                                                                                                                                                                                                                         |
| Per-request de-duplication                                      | `getCustomer()` / `requireWorkspace()` are not `cache()`d, so the session is resolved 3–4 times per page with an UPDATE of the session row each time                                                                                             | `customer-context.ts:213-217, 268-327`; `packages/auth/src/customer-session.ts:464-510` (UPDATE at `:506`), `:546-605`; `workspace-shell.tsx:472, 538-542` (none of the 36 callers passes `availableWorkspaces`); `topbar-counts.ts:42`; N+1 in `business-switcher.ts:67` |
| Caching of rarely-changing data                                 | Config, plan and entitlement caches exist but never hit: a new service instance is built on every call. `cacheTtlMs: 0` on the api's AI-availability route                                                                                       | `packages/config/src/service.ts:293`; `apps/admin/src/server/platform-context.ts:72` (56 call sites); `apps/api/src/routes/ai-availability.ts:61`; `packages/entitlements/src/service.ts:216, 246-256`; `customer-context.ts:122-145`; `content-context.ts:108`           |
| A cross-service call per render                                 | The AI-availability HTTP hop to the api runs on every page, `no-store`, **no timeout**                                                                                                                                                           | `apps/dashboard/src/server/ai-availability.ts:29-50`; awaited at `workspace-shell.tsx:486-494`                                                                                                                                                                            |
| Image pipeline                                                  | Thumbnails go through an authenticated route with full session resolution per image and `private, no-store`. The grant URL expiry is in seconds, so the URL changes on every render. Originals up to 2 MiB go into the grid. No `loading="lazy"` | `assets/file/[token]/route.ts:50, 90`; `packages/storage/src/download.ts:150-157`; `packages/assets/src/derivatives.ts:90`; `packages/ui/src/media-image.tsx:34`; N+1 grants at `assets/page.tsx:307-316`, `server/media-picker.ts:90`                                    |
| Optimistic UI                                                   | None: 0 `useOptimistic`; 177 forms end in 142 `redirect()` / 156 `revalidatePath()`                                                                                                                                                              | —                                                                                                                                                                                                                                                                         |
| Soft navigation everywhere                                      | 6 plain `<a>` links and 7 `method="get"` forms reload the whole page                                                                                                                                                                             | `asset-library-view.tsx:870, 1480, 1512`, `media-picker.tsx:114`, `settings/brand/page.tsx:190`, `calendar/page.tsx:835`; `activity/page.tsx:168` and 6 more                                                                                                              |
| Link prefetch                                                   | On, but a hover prefetches a **full** server render. `staleTimes.dynamic: 0`                                                                                                                                                                     | `packages/ui/src/prefetch-link.tsx:52`; `apps/dashboard/next.config.mjs:32`                                                                                                                                                                                               |
| Fonts                                                           | 10 `@fontsource` faces with no preload                                                                                                                                                                                                           | `layout.tsx:22-31`                                                                                                                                                                                                                                                        |

### 8.6 Memory per service, and sleeping

RSS measured locally in MB, seeded database.

| Service   | Idle    | After about 140 navigations | Peak |
| --------- | ------- | --------------------------- | ---- |
| web       | 86–97   | 93                          | 99   |
| dashboard | 141–143 | 378–474                     | 549  |
| admin     | 151     | 248                         | 275  |
| api       | 318–397 | 358                         | 400  |
| worker    | 281–297 | 243                         | 313  |

- **There is no leak:** the dashboard plateaus and GC reclaims memory.
- **Why about 1.3 GB idle across services:**
  - each service is started through a `pnpm --filter … start` wrapper (`docs/RAILWAY-DEPLOYMENT.md:232-238`);
  - the three Next apps use `next start` without `output: 'standalone'`;
  - api and worker run TypeScript through `tsx` at runtime;
  - the worker runs three BullMQ consumers with their own connections (`apps/worker/src/main.ts:136, 207, 285`);
  - the api runs 12 scheduler timers in process (`apps/api/src/scheduler.ts:2557` onward).

  This is an estimate from code (Prisma 7 with `adapter-pg` has no engine binary).

- **Production must not sleep the api and the worker:**
  - The api's in-process scheduler is the platform's only cron: scheduled publishing, finance and deletion sweeps.
  - A sleeping worker has no inbound traffic to wake it.
  - Today both stay awake only by accident (DB polling and blocking reads).
  - Sleeping is not mentioned in `.railway/railway.ts` or any doc.
  - Disable sleeping on api and worker, and on dashboard and web too, to remove the cold-start p99.

### 8.7 Top 10 changes by impact

| #   | Change                                                                                                                                                                                                                                                                | Where                                                                                                                                   | Expected gain                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Remove the full-window `backdrop-filter` on the app frame** (keep it only on small floating elements), and make the ambient orbs static or opacity-only. Needs an owner-authorised deviation: it is a prototype value.                                              | `prototype.css:1264-1265, 1772-1773`; `tokens.css:732-737`; `ambient.tsx`                                                               | **Measured:** scrolling at 4× CPU goes from 7–9 fps to 39 fps with only the blur removed, and to 56–58 fps with the effects removed. Phones already scroll at 60 fps.                     |
| 2   | **Resolve the session, workspace list and permissions once per request** with React `cache()`, pass the list to the shell, and throttle the `lastSeenAt` UPDATE to about once a minute.                                                                               | `customer-context.ts:213, 268, 424`; `workspace-shell.tsx:472, 538`; `topbar-counts.ts:42`; `customer-session.ts:506`                   | About −40–60 % of SQL per page (318 → roughly 120–180 on Home) and −60 to −120 ms server time per navigation. The same saving applies to every server action and image request. Estimate. |
| 3   | **Add `loading.tsx` skeletons, `<Suspense>` around slow sections, and `Promise.all` across independent transactions.**                                                                                                                                                | `apps/dashboard/src/app/[locale]/**`; `overview/page.tsx:132-575`                                                                       | A skeleton appears in under 50 ms after a click (the page _feels_ instant); −30–50 % server time on Home and Studio. Estimate.                                                            |
| 4   | **One process-wide cache (15–30 s TTL)** for configuration, plans and the entitlement catalogue; memoise `policy()` per request.                                                                                                                                      | `config/src/service.ts:293`; `admin platform-context.ts:72`; `entitlements/src/service.ts:216`; `content-context.ts:108`                | The catalogue goes from 17 reads per render to 0–1. About −20 to −40 % of round trips (−20 to −60 ms per page), admin included.                                                           |
| 5   | **Stop shipping both dictionaries to every page:** pass only the needed strings (or one locale) from the server; tiny inline strings for `error.tsx` / `not-found.tsx`.                                                                                               | `error.tsx:6`, `not-found.tsx:6`, `upload-field.tsx`, `brand-brain/*`, `asset-library-view.tsx:42`, `copilot-view.tsx:23`               | About −136 KB gzip / −516 KB decoded on every page. Phone TBT drops, most on sign-in/sign-up (384 ms) and Brand Brain (5.2 s).                                                            |
| 6   | **Production deploy settings:** disable sleeping on api, worker, dashboard and web; standalone Next started with `node server.js`; compiled api/worker started with `node`.                                                                                           | Railway; `next.config.mjs`; start commands                                                                                              | Removes the ≈ 2.7 s cold-start p99. About −30–40 % memory (estimate). Also required for correctness (8.6).                                                                                |
| 7   | **Cacheable, small, lazy thumbnails:** round the grant expiry to a 10-minute bucket and send `private, max-age`; serve a thumbnail derivative; add `loading="lazy" decoding="async"`; build grants from rows already loaded; a lighter auth check on the image route. | `storage/src/download.ts:150`; `assets/file/[token]/route.ts:50, 90`; `media-image.tsx:34`; `assets/page.tsx:307`; `media-picker.ts:90` | A repeat visit to Media goes from 48 image requests (each a full session resolution on a 10-connection pool) to about 0; first-visit bytes −5 to −20×.                                    |
| 8   | **Cache the AI-availability call per workspace (30–60 s) and give it `AbortSignal.timeout(1500)`**; use the private network URL.                                                                                                                                      | `dashboard/src/server/ai-availability.ts:29-50`; `api/routes/ai-availability.ts:61`                                                     | −10 to −30 ms warm per page; a cold api no longer blocks a page (up to −1 to −2 s).                                                                                                       |
| 9   | **Stop the full-page refreshes:** the composer updates local state from the save result instead of `router.refresh()`; `RefreshWhile` polls a status endpoint, stops after N minutes and pauses when hidden.                                                          | `draft-editor.tsx:713-718, 943-946`; `refresh-while.tsx:31-41`                                                                          | About −2 requests and −300 SQL statements per typing pause; up to −240 full renders per hour per stuck tab. This likely explains most of the 2,100 requests in 6 h.                       |
| 10  | **Soft navigation and smaller client work:** `<Link>` / `next/form` for the 6 plain links and 7 GET forms; IntersectionObserver plus a 30 fps cap on the hero canvas; a 100 ms hover delay on full prefetch; reserve tile sizes on Campaigns/Calendar.                | 8.5 rows; `prototype-hero-canvas.tsx:114`; `prefetch-link.tsx:52`                                                                       | −300 to −800 ms per asset open or filter change; no per-frame layout reads on Home; CLS on Campaigns and Calendar from 0.18–0.40 to below 0.1.                                            |

**Also worth doing:**

- `useOptimistic` for mark-read, approve/decline and calendar moves.
- The missing indexes:
  - `calendar_slot (workspaceId, status)`: the topbar failed-post count on every page (`topbar-counts.ts:72-78`);
  - `audit_event (workspaceId, action)`;
  - `audit_event (workspaceId, actorId, action, occurredAt)`: `content/src/suggestions.ts:256, 354`.
- The Activity filter's in-memory `distinct`, which reads every audit row (`packages/activity/src/service.ts:177-197`, called at `activity/page.tsx:82`).
- The N+1 loops in `business-switcher.ts:67`, `publishing/page.tsx:218-220` and `automations/page.tsx:336-340`.
- The Control Center's uncached `requirePageActor` (`platform-context.ts:331`), resolved twice per page.

**Already fine:**

- RLS costs one `set_config` per transaction, not per query.
- The hot queries have indexes: content by status and updated, calendar ranges, notifications, mentions, credit transactions and the asset grid.
- There is no animation of layout properties, apart from the user-triggered sidebar collapse.
- Animation loops stop when the tab is hidden.
- There is a single Prisma client per process (pool of 10).

---

## 9. Design system consistency — "if we change a colour or the look of a field, does it change everywhere?"

### 9.1 The precise answer: **no**

- **Primary colour.** Changing `--bs-brand-purple` in `tokens.css` today changes **3 CSS declarations**: the skip link, the link colour and one dashed outline (`tokens.css:666, 683, 2144`).
- **What keeps the old purple:**
  - **the customer app's main purple button** (`.bsp-btn.bsp-pur`, `prototype.css:752-756`, literal `#7935fe`, hover `#6528e0`);
  - 105 more literal-purple CSS declarations, plus 8 places that re-define purple under another name;
  - the customer focus outlines;
  - 69 hover/pressed shades and 47 tints, all literals;
  - 7 TSX literals;
  - the e-mail templates and the hosted billing page.
- **The Control Center** follows only if `tokens.ts` is edited too. Its 965 `colorTokens.*` references are literal hex strings baked into the HTML (`packages/ui/src/tokens.ts:16-297`).
- **Input border.** `--bs-control-border` is used by **exactly one rule** (`tokens.css:1021`). Every customer-app input overrides it with a hard-coded `#e4e4e8` (`prototype.css:816`). The Control Center follows; the customer app does not follow at all.
- **How this was verified.** A scratch copy of `packages/ui/src` had purple set to `#00aa55` (in CSS and TS) and the input border set to `#ff0000`. Everything still painting the old values was listed. The full list, with the screen each item appears on, is in the evidence CSV `trace-token-change.csv` (319 rows).

**Screens that would not follow a primary-colour change, by number of literal rules:**

| Screen                                              | Rules    |
| --------------------------------------------------- | -------- |
| Brand Brain                                         | 23       |
| Studio / compose                                    | 21       |
| Setup wizard                                        | 16       |
| Settings                                            | 15       |
| Calendar                                            | 12       |
| Analytics / Performance                             | 12       |
| Brand Brain chat                                    | 12       |
| Entry screens (sign-in / sign-up)                   | 9        |
| Approvals                                           | 7        |
| Team                                                | 7        |
| Campaigns                                           | 6        |
| Media                                               | 5        |
| Notifications                                       | 5        |
| Copilot                                             | 5        |
| Notes                                               | 4        |
| Create menu, FAB, nav counts, toast, legal, listbox | 1–4 each |

All of them also keep the old primary button, focus ring and checkbox accent.

### 9.2 Every stylesheet and the two prefixes

All are in `packages/ui/src/`.

| File                 | Lines  | What it holds                                                                                                                                                                                                                                                                                                                                                            | Loaded by (order)                                                                                                                  |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.css`         | 2,210  | `:root` tokens: 71 `--bs-*` colours, 8 shadows, 9 spacing, 12 radius, 4 durations, 2 easings, 32 `--bs-motion-*`, 7 z-index, layout, ambient, gradient, 3 font stacks; the size scale `--bsp-px-*` (111), `--bsp-fs-*` (38), `--bsp-rem-*` (83) at 1.0; global rules (body, scrollbars, focus ring, reduced motion, prefers-contrast, forced-colors); 67 `.bs-*` classes | All three apps, first                                                                                                              |
| `prototype.css`      | 13,905 | The prototype port: 1,375 `.bsp-*` classes; re-defines the whole size scale at 0.88 (D-484) and `--bs-space-*` / `--bs-radius-*`; 14 `--bsp-*` colours (`:43-70`); `--cs-*` again on `.bsp-frame`; overrides 25 `.bs-*` classes                                                                                                                                          | Dashboard only, second                                                                                                             |
| `entry.css`          | 781    | Sign-in, sign-up and wizard card (31 `.bsp-auth*` classes); size scale at 0.80 (D-491)                                                                                                                                                                                                                                                                                   | Dashboard third; admin second                                                                                                      |
| `content-studio.css` | 895    | An older demo port (`.cs-*`). 41 of 64 classes are unreferenced; its `--cs-*` colours sit on `.content-page`, which no page renders                                                                                                                                                                                                                                      | `/content/compose`, `/creative`                                                                                                    |
| `brand-brain.css`    | 1,412  | An older demo port (`.bb-*`). 55 of 80 classes are unreferenced, including its root `.brand-brain-page`, so its `--bb-*` variables are defined on an element that is never rendered                                                                                                                                                                                      | `/brand-brain`                                                                                                                     |
| Inline `<style>`     | —      | Invoice print rules; brand-font CSS; the api's hosted billing page with its own hex values                                                                                                                                                                                                                                                                               | `billing/invoices/[invoiceId]/document/page.tsx:74`; `creative/page.tsx:375`; `apps/api/src/routes/billing-hosted-page.ts:293-301` |

- **Load order and stack:**
  - Dashboard: `tokens.css` → `prototype.css` → `entry.css` → `@fontsource` faces (`layout.tsx:11-31`), then the route sheets.
  - Admin: `tokens.css` → `entry.css` → fonts (`layout.tsx:10-28`).
  - Web: `tokens.css` only.
  - There is no Tailwind, CSS-in-JS or CSS modules (`ARCHITECTURE.md:106` still says Tailwind + Radix).
- **`bs-`** is the design system in `tokens.css`, used by both apps.
- **`bsp-`** ("BrandSpace prototype") is used by the dashboard, and by admin only for sign-in. It holds three things:
  - the prototype's class names, prefixed to avoid collisions;
  - the three size tables `--bsp-px-N` / `--bsp-fs-N` / `--bsp-rem-N`: the same 232 names defined three times, at 1.0, 0.88 and 0.80;
  - 14 colours.

  Admin reaches `--bsp-*` only through the TS token objects, always at 1.0.

**Defined more than once.** 267 custom-property names; 260 of them with different values.

- **Intentional:** the 232 size tokens, `--bs-space-*` ×9 and `--bs-radius-*` ×11 (D-484 / D-491).
- **Real duplicates of one name:**
  - `--cs-ink`, `--cs-purple`, `--cs-muted`, `--cs-success`, `--cs-warning` (`content-studio.css:51-56, 462` and `prototype.css:13476-13482`, same values);
  - `--cs-soft` (`#f5f5f6` vs `#f2f2f4`) and `--cs-soft-shadow`, with **different** values;
  - `--bs-select-chevron-inset` / `-space` (`tokens.css:1072` vs `content-studio.css:203, 354`);
  - `--bsp-target-min` (`tokens.css:140`, `prototype.css:86`).
- **One value under several names**, so a change has to be made in each place:

  | Value     | Names                                                                             |
  | --------- | --------------------------------------------------------------------------------- |
  | `#7935fe` | `--bs-brand-purple`, `--bs-focus-ring`, `--cs-purple`, `--bb-purple`, `--bsp-pil` |
  | `#111114` | 5 names                                                                           |
  | `#6a6a72` | 3 names                                                                           |
  | `#5312c4` | `--bs-brand-purple-pressed`, `--bsp-purple-ink`                                   |
  | `#ffdd15` | 3 names                                                                           |
  | `#26262b` | `--bs-ink-hover`, `--bsp-ink-2`                                                   |

  A third ink-hover value, `#2a2a30`, is used on the customer button (`prototype.css:750`).

- **35 classes are styled in more than one stylesheet:**
  - `.bs-control` (in three files);
  - `.bs-shell`, `.bs-topbar`, `.bs-sidebar`, `.bs-panel`, `.bs-select`, `.bs-settings-split`, `.bs-page-flow`;
  - 8 `bb-chat-*`: a dark panel in `brand-brain.css`, re-skinned light in `prototype.css:7377-7440`;
  - 8 `cs-*`;
  - the `bsp-auth-*` classes.
- **20 selectors are repeated within one file**, for example `.bsp-au-dialog` three times at `prototype.css:8649, 8667, 8968`.

### 9.3 Hard-coded values outside the token files

The full file:line list is in the evidence CSVs: `hardcoded.csv` (2,417 rows), `inline-styles.csv` (2,197 rows), `tsx-per-file.csv`.

**CSS: 2,149 literals.**

| File                       | Colour | Border width | Shadow | Duration | Easing | z-index | Blur | Letter-spacing | Size | Spacing | Other | Total     |
| -------------------------- | ------ | ------------ | ------ | -------- | ------ | ------- | ---- | -------------- | ---- | ------- | ----- | --------- |
| `prototype.css`            | 1,277  | 196          | 58     | 57       | 49     | 36      | 8    | 37             | 42   | 5       | 14    | **1,779** |
| `brand-brain.css`          | 120    | 13           | 9      | 1        | 0      | 4       | 2    | 8              | 2    | 2       | 3     | **164**   |
| `tokens.css` (rule bodies) | 18     | 12           | 4      | 0        | 1      | 5       | 8    | 0              | 29   | 11      | 16    | **104**   |
| `entry.css`                | 42     | 1            | 2      | 0        | 0      | 0       | 0    | 6              | 5    | 0       | 0     | **56**    |
| `content-studio.css`       | 30     | 7            | 1      | 0        | 0      | 0       | 0    | 3              | 3    | 1       | 1     | **46**    |

- **Colour literals:** 167 distinct hex values and 170 `rgb()`/`rgba()` values.
- **866 of the 1,315 hex uses (66 %) are exactly the value of an existing token**, so they can be replaced mechanically with no visual change.
- **Most used:** `#6a6a72` ×204, `#111114` ×156, `#fff` ×150, `#7935fe` ×85, `#5312c4` ×56.
- **Most used with no `--bs` token:** `#55555c` ×46, `#f6f3ff` ×21, `#f2f2f4` ×19, `#f5f5f7` ×19, `#e4e4e8` ×18 (the input border).

**TSX/TS: 268 literals and 2,197 inline `style=` attributes** (1,475 object literals, 722 references).

|             | Style attributes | Literals                    |
| ----------- | ---------------- | --------------------------- |
| admin       | 762              | —                           |
| dashboard   | 877              | —                           |
| web         | 3                | —                           |
| packages/ui | 555              | includes 49 colour literals |

- **The bigger hidden number: 965 `colorTokens.*` references in 106 files are literal hex values** baked into the HTML when the page renders. They do not follow `tokens.css`. Neither do `shadowTokens`, `motionTokens` / `motionMs`, `zIndexTokens` or `fontTokens`.
- **Some TS tokens do follow the CSS:** `spacingTokens`, `radiusTokens`, `typographyTokens` and `layoutTokens` are `var(--bsp-*)` strings.
- **Top TSX offenders:**
  - admin `console/workspaces/[workspaceId]/page.tsx`: 136 inline styles;
  - dashboard `overview/page.tsx`: 87;
  - admin `simple/area.tsx`: 74, plus 16 literals;
  - `asset-library-view.tsx`: 71;
  - admin `simple/customers.tsx`: 69;
  - `copilot-shell.tsx`: 64, plus 59 `colorTokens`;
  - `prototype-rail.tsx`: 12 literals (`#8a8a92` at `:150, 416`, `rgba(121,53,254,.08)` at `:115`, a palette at `:167`);
  - `media.tsx:38-43` and `switchers.tsx:86, 197, 692`;
  - admin `'28rem'` ×10 and `'68ch'` ×9.

### 9.4 Components implemented more than once (dashboard, Control Center, packages/ui)

| Component                 | Implementations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | How they differ                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Button                    | `Button` / `buttonClass()` → `.bsp-btn` (`primitives.tsx:69`, `prototype.css:725-790`) for the dashboard; `buttonStyle()` inline (`primitives.tsx:119`, legacy 36 px) for admin; admin passes **both** class and inline style, but `.bsp-btn` is not loaded there; `.bsp-wz-btn` (`:12208`), `.bsp-ibtn`, `.bsp-au-act`, `.bsp-sp-act`, `.bsp-menu-btn`, `.bsp-toast-act`, `.bsp-st-check-cta`; unused `.cs-*-button`; `.bb-chat-action` (gradient at `brand-brain.css:777`, flat at `prototype.css:7418`)  | Height, type size, radius and hover; admin has no hover (L-37)                                                                                  |
| Input / textarea          | `.bs-control` (`tokens.css:1019`, `#f5f5f6`, transparent border) + `inputStyle()` for admin; `prototype.css:806-840` (white, `#e4e4e8`, hover `#c9c9d1`) for the dashboard; `entry.css:485` (`#f4f4f5 !important`); Content Studio with no border (`content-studio.css:133, 181, 330`); Brand Brain chat dark → re-skinned (`brand-brain.css:705`, `prototype.css:7393`); about 30 per-screen classes; `customerInputStyle()` 24rem (`customer-styles.ts:28`) vs `inputStyle()` 28rem (`console-ui.tsx:62`) | Fill, border, radius, max width                                                                                                                 |
| Select / dropdown         | Native `<select>` (29 in admin, 48 in the dashboard), `SearchableSelect`, `ChipListbox`, `DropdownMenu`, `.bsp-lbx` (`prototype.css:13798`), 30 `<details>` menus                                                                                                                                                                                                                                                                                                                                           | z-index 20 / 25 / 30; different shadows                                                                                                         |
| Checkbox / radio / toggle | 29 raw checkboxes in 25 files + `CheckboxRow` (15 uses); `.bsp-ai-radio`, `.bsp-au-radio`, `.bsp-wz-radio`, `.bsp-camp-toggle`, `.bsp-vc-toggle`; no shared one in packages/ui                                                                                                                                                                                                                                                                                                                              | `accent-color` is purple in two places, ink in one, and the browser's blue elsewhere                                                            |
| Card                      | `Card` / `cardStyle()` (`surfaces.tsx:37`; 80 admin, 42 dashboard uses); `.bsp-card` (`prototype.css:843`, 67 uses); `.bsp-xcard` (`:950`, 47 uses); also `.bsp-pf-card`, `.bsp-bcard`, `.bsp-ucard`, `MetricCard`, `FeatureCard`                                                                                                                                                                                                                                                                           | Three looks side by side in the dashboard                                                                                                       |
| Badge / pill / chip       | `StatusBadge` + `statusTone` (`data.tsx:231`) via admin `AreaBadge` / `StatusPill`; `.bsp-pill` (six tones, 70 uses), `.bsp-chip` (64), `.bsp-sp-pil`, `.bb-badge`, unused `.cs-status`                                                                                                                                                                                                                                                                                                                     | Two tone palettes, one from `colorTokens` and one from literals                                                                                 |
| Modal / drawer / sheet    | `Dialog` (`overlays.tsx:594`), `ConfirmDialog`, `SideSheet` (`:924`), `PostDetailDrawer`, the Copilot panel, the AppShell drawer, the CustomerShell drawer; CSS `.bsp-au-dialog` (×3), `.bsp-cp-dialog`, `.bsp-apr-overlay`, `.bsp-post-overlay`, `.bsp-cal-pop`                                                                                                                                                                                                                                            | —                                                                                                                                               |
| Overlay / backdrop        | `rgba(12,12,14,.25)` ×5 (`copilot-shell.tsx:1034`, `post-detail-drawer.tsx:101`, `overlays.tsx:958`, `customer-shell.tsx:1018`, `app-shell.tsx:1104`); `rgba(15,23,42,.45)` ×2 (`overlays.tsx:632`, `copilot-shell.tsx:963`, a slate tint outside the palette); `rgba(17,17,20,.28)` ×2 at a literal z-index 70 (`prototype.css:8644, 8708`); `.bs-veil` blur 3 px (`tokens.css:1715`); `.bs-copilot-scrim`                                                                                                 | Four tints, some blurred, on two z-index scales: related to the KNOWN "partial backdrop"                                                        |
| Tooltip                   | `Tooltip` (`overlays.tsx:235`); a custom `role="tooltip"` (`check-card.tsx:105`); 309 native `title=`                                                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                                                               |
| Table                     | `DataTable` / `thStyle` / `tdStyle` (`data.tsx`); admin `tableStyle()` (`console-ui.tsx:66`) and dashboard `customerTableStyle()` (`customer-styles.ts:20`) are identical copies; about 43 prototype row/table classes                                                                                                                                                                                                                                                                                      | —                                                                                                                                               |
| Empty state               | `StateMessage` (`feedback.tsx:310`, 41 uses); admin `EmptyState` defined twice identically (`console-ui.tsx:45`, `admin-shell.tsx:328`); `EmptyAction`; 34 `.bsp-*-empty` classes; `.cs-empty`, `.bb-source-empty`                                                                                                                                                                                                                                                                                          | —                                                                                                                                               |
| Sidebar / shell           | Admin `AppShell` (1,258 lines); dashboard `CustomerShell` (1,150) + `prototype-rail.tsx` (658) + `workspace-shell.tsx` (1,151); web shell (61)                                                                                                                                                                                                                                                                                                                                                              | Sidebar width: admin `--bs-sidebar-expanded` 15.5rem / 4.875rem; dashboard `--bsp-px-250` / `--bsp-px-76` set in TSX (`customer-shell.tsx:739`) |
| Tabs and switches         | `LinkTabs` with two looks (`link-tabs.tsx:43-57`); `Tabs`; admin `ModeSwitch` re-implements `LinkTabs` (`mode-switch.tsx:29`); three language switches; `social-post-preview.tsx` forks a "demo" and a "prototype" look; admin `CopyValue` vs dashboard `CopyTextButton`                                                                                                                                                                                                                                    | —                                                                                                                                               |

### 9.5 Findings (design system)

| ID   | Sev    | Finding                                                                                                                                                                                                                                                                                         | Where                                                                                 | How confirmed                            | Smallest safe fix                                                                                                                                                                           |
| ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Medium | **Three sources of truth for colour**: `tokens.ts` literals, `tokens.css`, and 1,487 CSS colour literals. A re-brand, or a later Look & feel page, reaches only the Control Center, and only if both token files are edited. Contradicts CLAUDE.md §4 ("design tokens, never literals").        | 9.1–9.3                                                                               | `simulate.sh` and `trace.py` (CONFIRMED) | Generate `tokens.css` `:root` from `tokens.ts`; make `colorTokens` return `var(--bs-*)` (keeping raw values for contrast tests and e-mail); codemod the 866 exact matches. No pixel change. |
| D-2  | Medium | Customer inputs ignore the input-border token and D-55 (section 7.1).                                                                                                                                                                                                                           | —                                                                                     | —                                        | —                                                                                                                                                                                           |
| D-3  | Low    | Control Center buttons have no hover (L-37).                                                                                                                                                                                                                                                    | —                                                                                     | —                                        | —                                                                                                                                                                                           |
| D-4  | Low    | Two parallel copies of the same helpers (table style, empty state).                                                                                                                                                                                                                             | 9.4                                                                                   | Read                                     | Collapse into packages/ui.                                                                                                                                                                  |
| D-5  | Low    | Four backdrop treatments and two z-index scales.                                                                                                                                                                                                                                                | 9.4                                                                                   | Read                                     | One `Backdrop` component with `--bs-scrim` / `--bs-scrim-blur` tokens and the token z-index; the owner picks the value.                                                                     |
| D-6  | Low    | Three card looks and two badge palettes in one app.                                                                                                                                                                                                                                             | `surfaces.tsx:37-70`, `prototype.css:843, 950`; `data.tsx:231` vs `prototype.css:849` | Read                                     | Show them all in the gallery; make `Card` a thin wrapper over the class variants. Unifying them is an owner decision.                                                                       |
| D-7  | Low    | Duplicate and conflicting variables (9.2).                                                                                                                                                                                                                                                      | `dup-custom-props.csv`                                                                | CONFIRMED                                | Make `--cs-*`, `--bb-*` and the `--bsp-*` colours aliases of one token each, keeping exact values.                                                                                          |
| D-8  | Low    | About 1,000 lines of dead CSS: `brand-brain.css` 55/80 classes, `content-studio.css` 41/64, `prototype.css` 15. `--bb-*` is undefined where `brand-brain.css:67, 198, 314, 434, 529, 777` use it; the live `.bb-chat-*` rules only look right because `prototype.css` overrides them.           | —                                                                                     | Static scan (SUSPECTED)                  | Confirm with gallery screenshots, then delete.                                                                                                                                              |
| D-9  | Low    | **The colour-literal guard has blind spots:** it scans only `apps/*/src` (not packages/ui, where all 50 TSX colour literals live), only 6-digit hex, and no CSS. Parity is checked for 10 of 71 colours. The `tokens.css` header names a `tests/unit/token-parity.test.ts` that does not exist. | `tests/unit/design-system.test.ts:130-141, 166-200`                                   | Read                                     | The ratchet in 9.6.                                                                                                                                                                         |
| D-10 | Low    | **Docs drift:** DESIGN-SYSTEM §1 says every colour is in `tokens.ts` and a test enforces it; it calls `appBackground` white (the token is `#F2F2F2`, `tokens.ts:148`); it gives the sidebar as 17rem / 4.5rem (the tokens are 15.5rem / 4.875rem).                                              | `docs/DESIGN-SYSTEM.md`; `docs/ARCHITECTURE.md:106`                                   | Read                                     | Doc edits.                                                                                                                                                                                  |

**What was checked and found fine (design system):**

- `tokens.ts` and `tokens.css` agree on all 63 shared colours.
- App TSX has almost no colour literals: admin 0, web 0, dashboard 1 (a computed canvas colour).
- The spacing, radius, typography and layout TS tokens resolve to CSS variables.
- The three size tables are deliberate and tested (`b7-scale.test.ts`).
- The route sheets are scoped.
- The reduced-motion block and the focus ring are present.
- **A component gallery already exists**: `apps/dashboard/src/app/[locale]/design-system/`, refused in production and covered by tests.

### 9.6 Proposal (not built): one token source, one component set, a CI rule, a gallery

**Target:**

1. **`tokens.ts` is the only source.** A generator (about 250 lines) writes the `tokens.css` `:root` block and the 0.88 / 0.80 tables. A test fails if the committed output differs.
2. **TS token objects return `var(--bs-*)`.** Raw values are kept for contrast tests, e-mail and canvas drawing.
3. **One `components.css`**, split out of `prototype.css` and loaded by both apps. The Control Center's look becomes a token set (`[data-look=console]`), not a second implementation.
4. **A CI ratchet:**
   - **CSS:** stylelint with `stylelint-declaration-strict-value` (or a custom plugin of about 100 lines). Literals are allowed only inside the token blocks, plus `transparent`, `currentColor`, `inherit`, `0` and `none`.
   - **TSX:** an ESLint `no-restricted-syntax` rule on hex / `rgb` / `hsl` strings and on numeric `zIndex` / `fontSize` / `borderRadius` in style objects. The existing hex test is extended to packages/ui and to 3- and 8-digit hex.
   - **Baseline:** committed counts per file and category (2,149 CSS, 268 TSX, 965 baked `colorTokens`). CI fails if any count goes up; a file switches to zero tolerance when it reaches 0.
   - **Fidelity tests:** the existing ones (`ui-fidelity-manifest.test.ts:207`, `content-fidelity.test.ts:339`) get a colour-token mapping, so they keep comparing values.
5. **The gallery:** extend `/design-system` with one section per component family in 9.4. Every state, en and ar, LTR and RTL, both looks, a token page with swatches and contrast numbers, and one Playwright screenshot per section as the regression guard. About 800–1,200 lines.

**Safe order of work.** Each step should show a zero screenshot diff, except the deliberate fixes.

| #   | Step                                                                                                                                                                                                                | Size                                  | Days                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------- |
| 1   | Ratchet baseline; stylelint and ESLint rules in report-only mode; extend the hex test                                                                                                                               | 4 files, ~400 lines                   | 1                          |
| 2   | Gallery and screenshot baselines                                                                                                                                                                                    | ~1,000 lines                          | 1.5–2                      |
| 3   | Generate `tokens.css` from `tokens.ts` (byte-compare)                                                                                                                                                               | 1 script + 1 test                     | 1                          |
| 4   | `colorTokens` / `shadowTokens` / motion → `var()`; keep raw values for contrast, e-mail and canvas                                                                                                                  | ~10 call sites                        | 1                          |
| 5   | CSS codemod: the 866 exact matches; ~142 new exact-value tokens plus 170 rgba values; `--cs` / `--bb` / `--bsp` colours become aliases. Order: entry → content-studio → brand-brain → tokens → prototype by section | ~1,500 lines; codemod ~200            | 3–4                        |
| 6   | The two fixes: D-2 (input border) and L-28 (grey text)                                                                                                                                                              | ~20 lines                             | 0.5                        |
| 7   | Shadows (73), durations and easings (107), z-index (45) and blur (23) to tokens; semantic radius tokens aliasing `--bsp-px-N` (321 declarations)                                                                    | —                                     | 2                          |
| 8   | Shared components, one family per PR: Backdrop → Button → Input → Checkbox → Card → Badge → EmptyState → Table → Dialog/Drawer → Tooltip; delete dead CSS                                                           | ~30 files, net −1,500 to −2,500 lines | 5–7                        |
| 9   | Ratchet to strict; fix the docs (D-10)                                                                                                                                                                              | —                                     | 0.5                        |
|     | **Total**                                                                                                                                                                                                           |                                       | **≈ 15–19 developer-days** |

Unifying the Control Center and customer looks, or the three card styles, stays an owner decision after step 8.

### 9.7 Preparing a later "Look & feel" page: which settings are tokens today

| Setting                         | Token today?                                 | Token names                                                                        | Hard-coded where                                                                                                                                                     |
| ------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Colours                         | Partly                                       | `--bs-*` (71) + `colorTokens`                                                      | 1,487 CSS literals; 50 TSX; 965 baked `colorTokens`; duplicates `--cs-*`, `--bb-*`, `--bsp-*`; e-mail and billing page                                               |
| Radius                          | Exists, but the customer CSS does not use it | `--bs-radius-*` (12), `radiusTokens`                                               | 321 customer radius declarations use the pixel-named `--bsp-px-N` (shared with padding), plus 21 `50%`                                                               |
| Shadows                         | Partly                                       | `--bs-shadow-*` (8), `shadowTokens` (literal strings)                              | 58 in `prototype.css`, 9 in `brand-brain.css`, 4 in TSX; `--bb-shadow`, `--cs-soft-shadow`                                                                           |
| Density                         | Pre-computed tables only                     | `--bsp-px/fs/rem-*` at 1.0 / 0.88 (`prototype.css:83`) / 0.80 (`entry.css:26`)     | No single factor: each table is about 230 values regenerated by hand; 216 1–2 px borders are unscaled by design                                                      |
| Fonts                           | Yes, for the interface                       | `--bs-font-latin` / `-arabic` / `-mono`, `fontTokens`                              | `prototype.css:1336, 9622, 10983`; faces are static `@fontsource` imports, so changing a font needs a rebuild                                                        |
| Logo                            | No                                           | —                                                                                  | `BrandGlyph` SVG with `#000` / `#fff` (`app-shell.tsx:1181-1210`, deliberate per UI-FIDELITY-CONTRACT); three `icon.svg`; `apps/api/src/brand-icons`; the e-mail PNG |
| Motion level and speed          | Speed yes; level only via the OS setting     | `--bs-motion-*` (32), `--bs-duration-*`, `--bs-ease-*`, `motionMs`                 | 57 durations and 49 easings literal in `prototype.css` (e.g. `.bsp-btn` `:742-747`); only `prefers-reduced-motion` (`tokens.css:645`), no level switch               |
| Blur / gradients / glass on/off | Partly                                       | `--bs-ambient-blur`, `--bs-gradient-hero`, `--bs-surface-glass`, `--bsp-role-hero` | 16 CSS + 7 TSX blurs, 32 `backdrop-filter`, 54 CSS gradients plus TSX gradients; glass alpha values only in TS; no on/off switch                                     |
| Sidebar width                   | Admin yes; dashboard no                      | `--bs-sidebar-expanded` / `-collapsed`, `--bs-shell-sidebar-width`                 | Dashboard: `customer-shell.tsx:739` (`--bsp-px-250` / `--bsp-px-76`), `prototype.css:1256`                                                                           |
| Content width                   | Admin yes; dashboard no                      | `--bs-shell-max-width` (`tokens.css:781`)                                          | Dashboard fills the window (D-484) with per-page `--bsp-px-620` / `540` / `520`; admin TSX `'28rem'` ×10, `'68ch'` ×9                                                |

Once steps 3–8 are done, a Look & feel page can write a validated `:root{…}` block per platform or workspace, with contrast checked on save using the existing `contrast.test.ts` logic. Every screen will then follow it. The "glass off" switch also delivers performance change #1.

---

## 10. Operations

### 10.1 Findings

#### M-7 — Medium — With Redis down, every queued action hangs instead of saving

- **Where:**
  - `packages/jobs/src/client.ts:44-53`: the shared producer connection has `maxRetriesPerRequest: null` and `enableReadyCheck: false`.
  - `enqueue()` is at `:88-129`.
- **What happens:**
  - With `REDIS_URL` set and Redis unreachable, `queue.add()` waits in ioredis's offline queue until Redis returns.
  - These all spin for the whole outage instead of "saved, will be processed shortly":
    - asset upload (`apps/dashboard/src/app/[locale]/assets/actions.ts:388`);
    - Brand Brain upload and re-read (`brand-brain/actions.ts:546, 662`);
    - api `routes/automation.ts:162` and `routes/copilot.ts:339`;
    - every scheduler sweep that dispatches jobs.
  - The scheduler's `setInterval` (`apps/api/src/scheduler.ts:2557`) has no "previous pass still running" guard, so hung passes pile up.
  - `RAILWAY-DEPLOYMENT.md` §5.2 ("keeps serving without Redis") is true only when `REDIS_URL` is unset.
- **How confirmed:** CONFIRMED. The real `enqueue()` against a dead port was still waiting at 20 s and was killed by `timeout 25` (exit 124). Against a live Redis it returned `dispatched: true` in 31 ms.
- **Smallest safe fix:**
  - Give producers their own connection with a finite `maxRetriesPerRequest` and `enableOfflineQueue: false`, or race `add()` against a 2 s deadline that returns `{ dispatched: false }` so the existing sweeps dispatch later.
  - Keep `null` only on the worker's consumer connections.
  - Add a skip-if-running flag per sweep.

#### M-13 — Medium — No alerting; the scheduler can stop silently; worker health checks one consumer of three

- **Where:**
  - No alerting by design (`docs/OPERATIONS.md:905`).
  - Worker health reflects only the media consumer (`apps/worker/src/main.ts:108-116, 345`).
  - `scheduler.start()` failure is only logged (`apps/api/src/server.ts:180-182`).
  - `#cadence()` reads config once and throws on any error.
  - `initializeTracing` is called only in `apps/admin/src/instrumentation.ts:30`.
- **What happens:**
  - **Redis outage (CONFIRMED by running it):** the worker stayed `{"status":"ok"}` and logged nothing for 20 s, then recovered.
  - **Scheduler failure (traced, not run):** one DB or config error at api start leaves the api serving 200, with **no publishing dispatch, finance or deletion sweeps** until someone redeploys.
  - **Railway won't notice:** it restarts only on process exit, and uses healthchecks only to admit a deployment. The comment at `apps/api/src/routes/health.ts:84` and RAILWAY-DEPLOYMENT §5.2 say otherwise and are wrong.
  - **Tracing:** the `OTEL_*` variables do nothing on api, dashboard and worker.
- **Smallest safe fix:**
  - Retry `scheduler.start()` with backoff and expose a scheduler state in `/health/ready`.
  - Make worker health require all three consumers running and Redis connected.
  - Add an external uptime monitor and log-based alerts on "maintenance pass failed" and "could not dispatch".
  - Start tracing in api, worker and dashboard.

#### M-14 — Medium — Backups: the documented target is not what Railway provides, and no restore has been drilled

- **Where:**
  - The docs ask for ≥ 30-day PITR, a separate failure domain and 12 monthly snapshots (OPERATIONS §2, DATABASE §11).
  - Railway gives about 4 weeks of pgBackRest backups in Railway's own bucket (RAILWAY-DEPLOYMENT §17); PITR has to be confirmed as on.
  - RPO and RTO are "TBD" (OPERATIONS §9). No restore drill is recorded. R2 versioning is an open owner decision (§22 item 11).
  - Restore step 1 stops only the api and workers, but dashboard and admin also write.
- **Smallest safe fix:**
  - Confirm PITR is on.
  - Run one staging restore drill and record the RTO.
  - Turn on R2 versioning.
  - Add a nightly `pg_dump` to R2 as a second failure domain.
  - Add dashboard and admin to the stop list.

#### M-15 — Medium — The Connected-AI-apps purge never runs in a deployment

- **Where:**
  - `apps/api/src/scheduler.ts:1283` (`purgeAiApps`) is called only from `runOnce()` (`:2484`).
  - `start()` (`:2550-2687`), which the server uses (`server.ts:147, 180`), creates a timer for every other sweep but not this one.
  - The docs promise it: `OPERATIONS.md:761`, `AI-APPS.md:79`.
- **What happens:** expired codes and tokens, revoked tokens, rate windows and never-connected clients (30 days, D-566) are never deleted, so the tables grow without bound. Correctness is unaffected (expiry is checked on use).
- **How confirmed:** CONFIRMED. All 16 sweeps in `runOnce` were compared with the timers in `start()`. The test calls `purgeAiApps()` directly, so the gap is invisible to it. The same mistake happened before with `sweepPublishing` (comment at `:2599-2611`).
- **Smallest safe fix:**
  - Add `every(cadence.retentionPurgeSeconds, 'ai-apps-purge', …)`.
  - Add a unit test that fails when a `runOnce` sweep has no timer in `start()`.

#### Low — operations

| ID   | Finding                                                                                                                                                                                                                                                                                                                                                         | Where                                                   | Fix                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| L-24 | `wait-for-migrations` treats a _failed_ migration as pending, so every release waits the full 1,800 s and then says "gave up", hiding the real cause.                                                                                                                                                                                                           | `packages/database/prisma/wait-for-migrations.ts:44-75` | Exit 1 straight away on a row with `finished_at IS NULL`, `rolled_back_at IS NULL` and logs set, and say "run `migrate resolve`". |
| L-39 | The production https check on public URLs is case-sensitive `startsWith('http://')`. The api boots in production with `HTTP://…`, `ftp://…` or `https://…/v1` (CONFIRMED), which would produce wrong OAuth redirects (`social.ts:147-155`) and a wrong MCP issuer/resource (`oauth-core.ts:139-148`). `DATABASE_MIGRATION_URL` is accepted on runtime services. | `packages/shared/src/env.ts:591-599`, `:99, 179, 180`   | Parse with `new URL()`, require `https:` and path `/`; forbid `DATABASE_MIGRATION_URL` on runtime profiles.                       |
| L-40 | Changing `PUBLIC_API_BASE_URL` after launch breaks every Connected AI app (stored `resource` mismatch, `mcp-route.ts:153`) and needs the Meta and TikTok redirect registrations updated. The runbook allows starting on Railway domains and switching later.                                                                                                    | GO-LIVE §4 step 8                                       | Attach the custom domains **before** any customer connects anything, or document "reconnect required".                            |
| L-41 | `docs/GO-LIVE-RUNBOOK.md` has drifted from the code (list in section 12).                                                                                                                                                                                                                                                                                       | —                                                       | Doc update.                                                                                                                       |

### 10.2 What was checked and found fine (operations)

- **Healthchecks** (`.railway/railway.ts`; 300 s timeout, restart ON_FAILURE ×10):

  | Service   | Path                 | What it checks                                                         |
  | --------- | -------------------- | ---------------------------------------------------------------------- |
  | web       | `/en/status`         | Static page                                                            |
  | dashboard | `/api/health/ready`  | Tenant DB and schema                                                   |
  | admin     | `/api/health/ready`  | Platform DB and schema                                                 |
  | api       | `/health/ready`      | DB and schema (2 s deadline); queue, storage and tracing reported only |
  | worker    | `/` on `WORKER_PORT` | Media consumer (M-13)                                                  |
  | migration | none                 | By design (M-8)                                                        |

- **Startup order and the migration race are handled:**
  - the api scheduler starts only after `waitForSchema` (`server.ts:169-182`);
  - worker consumers start only after the schema check and answer 503 `waiting_for_migrations` until then (`main.ts:125-133`);
  - dashboard and admin readiness return 503 until migrated, and accept a newer DB, so a code rollback stays ready;
  - the pre-deploy wait works with the app role's SELECT-only grant.
- **No inline job fallback in production:** `mayProcessInline()` is false when `APP_ENV=production` (`client.ts:40-42`), and both call sites check it.
- **The worker recovers by itself** after a Redis outage (CONFIRMED).
- **Every URL built from configuration fails closed when missing:**
  - the checkout, verification link and checkout return;
  - the OAuth callback (throws) and the social return;
  - internal e-mail links and dashboard e-mail links;
  - MCP/OAuth metadata (returns null);
  - inbound webhooks (NOT_CONFIGURED);
  - `BRANDSPACE_API_URL` consumers ("unavailable").

  CORS `*` is set only on the OAuth discovery documents.

- **When Postgres is down (expected from code; not tested, because Postgres was shared):** the api stays up and returns 5xx, sweeps log and retry, BullMQ retries jobs, and readiness reports `database: down`.
- **Runbook variable lists:** every per-service variable list in GO-LIVE §5 passes `validateStartupConfiguration` in production. The forbidden ones are refused (`TRUSTED_PROXY_HOPS` under railway-edge, `INTERNAL_SERVICE_TOKEN` on the worker). Every script the runbook names exists.

---

## 11. Tests and CI

| ID   | Sev    | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Where                                                                                                                                                                                                                                       | Fix                                                                                                                                     |
| ---- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| M-16 | Medium | **The CI isolation job's limit is 20 minutes; the suite took 21.1 min locally** (1,268 s, 235 files). On a runner about as fast as this container, the required check is cancelled before it finishes. The limit has not been raised since `eb9b7203`, while the E2E job's has been raised four times.                                                                                                                                                                                                                                                                                                                 | `.github/workflows/ci.yml:126`                                                                                                                                                                                                              | Raise it to about 40 min on measurement, as the E2E job does; optionally shard.                                                         |
| L-42 | Low    | Two E2E specs never run in CI: they skip unless `BRANDSPACE_E2E_GLOBAL_CONFIG=1`, which nothing sets. D-481 cites one of them as its evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/e2e/b-held-calendar.spec.ts:63-66`, `r6-format-fit-defaults.spec.ts:61-64`; `DECISIONS.md:802`                                                                                                                                       | Add a serial CI step with the variable, or record that the D-481 evidence is manual.                                                    |
| L-43 | Low    | **E2E tests that skip themselves when the feature they test disappears**, so CI stays green if the chat orb, upload control, asset grid or activation control vanishes.                                                                                                                                                                                                                                                                                                                                                                                                                                                | `brand-brain.spec.ts:265, 290, 309, 333, 364, 664`; `assets.spec.ts:278, 294`; `plans-entitlements.spec.ts:135`; `phase10-platform.spec.ts:173-177, 482`                                                                                    | Replace each skip with `await expect(locator).toBeVisible()`.                                                                           |
| L-44 | Low    | **Tests that pass even if the guard stops refusing:** `expect.unreachable` / "should have thrown" is caught by the test's own `catch`, whose only assertion is that the message does not contain the secret. Also `tenant-isolation.test.ts:243-255` (re-parenting a membership into another workspace) uses a bare `.rejects.toThrow()` that passes on any error. Neighbouring tests do assert the refusal.                                                                                                                                                                                                           | `tests/unit/bootstrap-owner-guards.test.ts:92-100, 166-175`; `tests/unit/content-studio.test.ts:351-363`; `tests/isolation/f80-migration-upgrade.test.ts:521-528`; `tests/isolation/tenant-isolation.test.ts:243-255`                       | Use `expect(fn).toThrow(<message>)` or `expect.assertions(n)`; match the DB error code in RLS tests.                                    |
| L-45 | Low    | **Untested refusal paths in risky code:** access-token expiry and resource mismatch (`mcp-route.ts:152-153`), code expiry (`oauth-routes.ts:438`), refresh expiry (`:524-525`), disabled client (`mcp-route.ts:155`, `oauth-routes.ts:447, 527`, `consent-routes.ts:87`). Nothing in code ever sets `ai_app_client.disabledAt`, so a rogue app cannot be blocked platform-wide. Also untested: `discardDraft`, `getContext` (L-18), `finishWorkspaceDeletions` (only `finishDue` is tested), the AI-route transaction timeout (H-4), settle-before-validate (H-3) and the `start()` / `runOnce()` timer parity (M-15). | —                                                                                                                                                                                                                                           | Backdate `expiresAt` and disable a client in isolation tests; add an admin "disable app" action; tests for the others with their fixes. |
| L-46 | Low    | **CI does not run on pushes to `staging`** (push triggers only on `main`; every PR does run all jobs), so merge commits landing on staging are never tested. Playwright `retries: 1` on CI hides flaky tests, while the `ci.yml:328` comment says "no retries".                                                                                                                                                                                                                                                                                                                                                        | `ci.yml:3-7, 328`; `playwright.config.ts:313`                                                                                                                                                                                               | Add `staging` to `push.branches`; require the jobs in branch protection (unverified whether it exists); report the retried-test count.  |
| L-47 | Low    | **Timing patterns that can cause flakes:** lock races ordered by 100 / 200 ms sleeps; 30 `waitForTimeout` calls in E2E, the risky ones asserting an absence after a fixed wait. Git history shows earlier timing and date flake fixes (`596b18ae`, `9f4cdffb`, `055516f9`, `0cfa7760`, `a50f474a`).                                                                                                                                                                                                                                                                                                                    | `phase2b1-deletion-hardening.test.ts:208, 216`; `connectors-a-w1-split.test.ts:63-89, 255, 353`; `content-studio.spec.ts:717, 878`; `phase6-create-post.spec.ts:341`; `brand-brain.spec.ts:277, 338`; `final-hashtag-enter.spec.ts:97, 131` | Poll `pg_locks` instead of sleeping; tie E2E waits to the configured save delay.                                                        |

**What was checked and found fine (tests and CI):**

- **No hidden skips in Vitest:** no `.only`, `.todo`, `it.skip`, `describe.skip`, `xit`, `skipIf` / `runIf` or env-gated `return` in any Vitest file. Playwright has `forbidOnly` on CI.
- **Playwright skips:** of the 189 `test.skip` calls, about 145 are deliberate desktop-only or mobile-only skips (D-468(b)).
- **Shard coverage:** all 20 Playwright projects are in exactly one CI shard, and CI checks the shards cover the suite. `--list` reports 1,651 tests in 127 files.
- **No test excluded by config.** No test reaches the real internet.
- **The risky suites assert real effects:**
  - **KEK re-wrap:** ciphertext unchanged and wrapped key changed, the old key no longer opens anything, dry run, wrong old key, crash-resume, exit codes, audit, no leaks.
  - **AI charging:** the lifecycle (48), reliability (19) and D-573 suites check wallet changes, `reserved == 0`, ledger rows, no charge on provider failure, races and replays. They do not cover validation failures after settle (H-3).
  - **Publishing:** counts provider calls.
  - **OAuth state:** single-use, race, forged, expired, foreign and redirect-mismatch cases.
  - **MFA:** recovery codes spent exactly once; step-up lockout counted.
- **Both baseline suites are green with no environmental failures** (section 2).

---

## 12. Documentation that disagrees with the code

| Doc                                                                   | Says                                                                                                                                          | Code                                                                                                                                                                                                | Fix                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `docs/GO-LIVE-RUNBOOK.md` lines 24, 49, 81, 94, 107, 120, 149, 309    | 91 migrations                                                                                                                                 | 99 (the manifest matches the folders)                                                                                                                                                               | Update                                          |
| GO-LIVE §3 / §5                                                       | Line refs `railway.ts:383/520/450`, `:77`; `env.ts:651-764, :808, :396, :755, :606-649`; `key-provider.ts:319, :355`; `config/service.ts:738` | Now `railway.ts:403/546/471`; `assertProductionSafety` `env.ts:678-797`, `validateStartupConfiguration` `:816`, `PROFILE_PUBLIC_URLS` `:419`; the others point at unrelated lines                   | Update                                          |
| GO-LIVE §1                                                            | Branch, `main 2d2b21a`, `staging e7929e2`, "543 commits behind"                                                                               | Stale                                                                                                                                                                                               | Update                                          |
| GO-LIVE §3 / §5                                                       | No web/landing service                                                                                                                        | `web` exists with healthcheck `/en/status`                                                                                                                                                          | Add it, or record that it is not deployed (M-6) |
| GO-LIVE                                                               | —                                                                                                                                             | Missing: the D-574 `*_KEK_PREVIOUS` variables, a pointer to `SECRET-ROTATION.md`, the TikTok redirect URI, and a warning that a green migration-job status is not evidence (M-8)                    | Add                                             |
| GO-LIVE / matrix                                                      | `OTEL_*` listed for api, dashboard, worker                                                                                                    | Tracing starts only in admin (M-13)                                                                                                                                                                 | Fix the code or the doc                         |
| `docs/RAILWAY-DEPLOYMENT.md` §5.2; `apps/api/src/routes/health.ts:84` | Railway probes readiness continuously; restarts the worker when the consumer stops; serves without Redis                                      | Healthchecks are deploy-time only; enqueue hangs when `REDIS_URL` is set and Redis is down (M-7, M-13)                                                                                              | Correct                                         |
| `docs/RAILWAY-DEPLOYMENT.md:1501, 1526`                               | The owner's personal e-mail as the production owner login                                                                                     | —                                                                                                                                                                                                   | Remove from a public repo (M-1)                 |
| `docs/SECURITY.md:756`                                                | Irreversible purge 30 days after deletion                                                                                                     | No purge exists (M-4)                                                                                                                                                                               | Correct                                         |
| `docs/SECURITY.md:1047`                                               | Session secrets are signing keys                                                                                                              | Sessions are random hashed tokens (L-12)                                                                                                                                                            | Correct                                         |
| `docs/AI-GATEWAY.md:195, 507`                                         | Moderation mandatory; output moderation                                                                                                       | Opt-in, off, input-only (M-10)                                                                                                                                                                      | Correct + F-item                                |
| `docs/AI-GATEWAY.md` §7.3; AC-11.9                                    | Charge only after output validated; retryable                                                                                                 | Settles before validation (H-3)                                                                                                                                                                     | Fix the code                                    |
| `docs/OPERATIONS.md:761`; `docs/AI-APPS.md:79`                        | AI-apps purge runs on the retention cadence                                                                                                   | Never scheduled (M-15)                                                                                                                                                                              | Fix the code                                    |
| `docs/OPERATIONS.md` §2; `docs/DATABASE.md` §11                       | 30-day PITR, separate failure domain, monthly snapshots                                                                                       | Railway ≈ 4 weeks in its own bucket; no drill (M-14)                                                                                                                                                | Align                                           |
| `docs/CONTROL-CENTER-SETTINGS.md:193, 203, 204`                       | Maintenance mode, support TTL, trial default, usage limits and website settings work                                                          | Nothing reads them (M-9)                                                                                                                                                                            | Mark "not used yet"                             |
| `docs/CONTROL-CENTER-SETTINGS.md:74-77, 86-94, 204`                   | `publishing.providers[]`; onboarding rows; operations row                                                                                     | The schema is keyed by channel (`domains.ts:2040`); rows omit `signup.verificationResendCooldownSeconds`, `signup.verificationsPerHour` and `operations.maintenance.*` (read at `scheduler.ts:351`) | Update                                          |
| `docs/MVP-ACCEPTANCE-CRITERIA.md:938-962`                             | Tests `phase8-brand-profile`, `phase8-asset-context`, `phase8-locale-defaults`, `phase8-migration-upgrade`; AC-22.1 "real PostgreSQL"         | Those tests never existed (the real ones are `phase8-product-completion.test.ts:238-460` and `phase2c2-logo-check`); `phase8-brand-context` is unit-only                                            | Update                                          |
| `docs/ROADMAP.md:66`                                                  | "Phase 0 (current phase)"                                                                                                                     | Stale                                                                                                                                                                                               | Update                                          |
| `CLAUDE.md:256`                                                       | Testcontainers                                                                                                                                | Not used (CI services and a local Postgres)                                                                                                                                                         | Update                                          |
| `docs/PHASE-6-FINAL-EXECUTION.md` rows 27, 48                         | "No background autosave"; "Mobile DONE"                                                                                                       | Superseded by D-472; E2E skips cite "phone layout post-launch (D-468(b))"                                                                                                                           | Update                                          |
| `docs/UI-FIDELITY-CONTRACT.md` §4.5                                   | No autosave; "Write caption with AI" left out                                                                                                 | Both changed (L-38)                                                                                                                                                                                 | Update                                          |
| `docs/DESIGN-SYSTEM.md` §1; `docs/ARCHITECTURE.md:106`                | All colours in `tokens.ts` with a test; `appBackground` white; sidebar 17rem / 4.5rem; Tailwind + Radix                                       | See D-10                                                                                                                                                                                            | Update                                          |
| `packages/ui/src/tokens.css` header                                   | `tests/unit/token-parity.test.ts`                                                                                                             | Does not exist                                                                                                                                                                                      | Update                                          |
| `docs/SECRET-ROTATION.md`; `docs/RAILWAY-ENVIRONMENT-MATRIX.md`       | —                                                                                                                                             | Missing `BOOTSTRAP_STAGING_OWNER_*`, `SMOKE_*`, `STAGING_RESEND_API_KEY`, the Railway account token, the in-flight OAuth-state wait (L-2) and the DB-copy contingency (L-9)                         | Add                                             |

**Checked and consistent:**

- Every D-number cited in code exists in `DECISIONS.md` (D-1…D-574, no gaps).
- Every environment variable the code reads is documented, except `PORT`, `NEXT_RUNTIME` and `SEED_PRINT_MFA_ENROLMENT`.
- Every `pnpm <script>` the docs name exists.
- Every configuration domain is in `CONTROL-CENTER-SETTINGS.md`.
- The MCP tool list and the AI task list match their docs.
- `production-config/plans.json` holds a 90-day trial, 500 trial credits, 500 monthly credits and one brand.

**No code was found to contradict an owner decision**, except where already flagged: D-55 (D-2), D-328 and D-333 (H-5), D-470(2) (L-28), and the AI-charging rule in CLAUDE.md §2.4 (H-3). D-464 was confirmed as applied, and only to automation.

---

## 13. Proposed fix order

### Blocks launch (production beta as configured: AI off, AI apps off)

Code fixes (≈ 2–4 developer-days in total):

1. **C-1:** upgrade Next to ≥ 16.4.1 in all apps and `packages/ui`, and set `images.unoptimized: true`.
2. **H-1:** upgrade Fastify to ≥ 5.12.5. Re-run unit, isolation and e2e.
3. **M-2:** bind social OAuth completion to the starting session. Instagram, Facebook and TikTok are the beta's channels, and an attacker only needs to be a beta user.
4. **M-8 (code side):** use `pnpm -C` or `--fail-if-no-match` in the migration and wait commands; L-24's fast fail for failed migrations.
5. **M-7:** a finite timeout on `enqueue()` and skip-if-running on sweeps.
6. **M-15:** schedule the AI-apps purge (one line plus a parity test).
7. **M-16:** raise the CI isolation timeout, so every launch-fix PR can turn green.
8. **Copy and legal:**
   - M-5: make the trial-end texts match the behaviour.
   - M-4: make the deletion wording honest.
   - M-9: tell the owner maintenance mode does nothing; do not rely on it in an incident.

Owner actions (Railway and GitHub):

9. **Rotate after the Railway disclosure (H-2, section 3.4):**
   - Delete the `BOOTSTRAP_STAGING_OWNER_*` variables and the staging bootstrap job, and re-enrol the staging owner.
   - Rotate every secret in 3.4 using `docs/SECRET-ROTATION.md` (KEKs via the D-574 re-wrap; L-2: wait the OAuth-state TTL before removing old social keys), plus `SMOKE_*` / `STAGING_RESEND_API_KEY` if they were ever stored, and the Railway account token.
   - Re-issue the vault-held provider keys (OpenAI, Resend, Meta, TikTok).
10. **Close the repository exposure (M-1):** make the repository private, delete the screenshot branch and request a purge of `1d094945`, check forks, consider telling the tester, and move the owner's admin login off a published address.
11. **Fill the legal placeholders (L-23, D-512).**
12. **Decide the public landing (M-6):** no public domain for `web` (or a redirect), or replace it.
13. **Configure Railway production:**
    - run `prisma migrate deploy` as a **pre-deploy command** so a failure marks the deploy FAILED (M-8);
    - **disable sleeping** on api and worker (and dashboard and web);
    - attach the custom domains before any customer connects an account (L-40);
    - confirm PITR is on (M-14).

### Before turning AI on in production

- **H-3:** settle only after validation; make replays re-runnable.
- **H-4:** move AI calls out of the 15 s tenant transaction.
- **M-12:** treat truncated output as a failure.
- **KNOWN:** the Copilot ZodError fix; the image-size mapping; "##" in first comments; the D-13 privacy questions in the Simple AI set-up.
- **M-10:** the owner decides on moderation.
- **L-13:** the bookkeeping-failure path.

These are live on **staging now**, where the real OpenAI provider charges staging wallets.

### Before turning Connected AI apps on in production

- **H-5:** enforce workspace status and revoke connections on password reset, suspension and deletion.
- **L-45:** tests for the expiry and disabled-client paths, and a per-app kill switch.
- **L-16:** plain bilingual error messages from the MCP tools.

### First two weeks after launch (smoothness and safety)

- **Performance:** top-10 changes #1–#6 first. #1 (the blur) and #2 (session once per request) give most of the perceived gain.
- **M-13:** alerting, an uptime monitor, scheduler state in readiness, full worker health.
- **M-14:** a restore drill and a second backup domain.
- **M-3:** Control Center MFA hardening.
- **D-2 and the accessibility Lows:** L-27, L-28, L-32, L-33.
- **M-11:** the stray-draft fix; **L-18:** the discard race.
- **L-1:** proxy CSRF hardening.
- **L-10 / L-11:** CI hardening.

### Can wait

- The design-system programme (9.6, ≈ 15–19 developer-days). Start with steps 1–2 (ratchet and gallery), which change nothing on screen.
- Performance changes #7–#10.
- The remaining Lows and the documentation updates in section 12.
- The zod 4 migration.

---

## 14. Evidence and limits

- **Screenshots** (attached separately as a zip, with sha256) are local runs against throwaway databases:
  - `shots/en/<viewport>/` and `shots/ar/<viewport>/`: 26 dashboard screens, 19 Control Center Simple-mode pages, landing, status, sign-in, sign-up and the legal pages, at 1536×864, 1920×1080 and 375×812, each with a `-full.png` where the page scrolls;
  - `shots/email/`: rendered e-mail templates;
  - `shots/parity-pairs/`: prototype and product side by side;
  - `sheets/`: contact sheets.

  The fresh-workspace screens use the beta configuration (AI off). No staging or real customer data appears in them.

- **Design-system CSVs** (in the review scratchpad; regenerable with the scripts noted there): `hardcoded.csv`, `inline-styles.csv`, `tsx-per-file.csv`, `dup-custom-props.csv`, `classes-in-several-files.csv`, `trace-token-change.csv`.
- **Limits:**
  - No Railway access: the live service settings, pre-deploy commands, sleep flags, PITR, the migration incident logs and the current variables are unverified.
  - No GitHub API: CI history, forks, stars and branch protection are unknown.
  - No live OpenAI calls: model-behaviour parts of M-12, the Brand Brain English answers and the AI edit chips are SUSPECTED.
  - No Lighthouse: Playwright and CDP were used, without network throttling, so TTFB is loopback.
  - Postgres outage behaviour is from code only.
  - Sign-up, notes, notifications, campaigns, data export, analytics ingestion and TikTok publishing were exercised on screen but not traced line by line through every branch.
