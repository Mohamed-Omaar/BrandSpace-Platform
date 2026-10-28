# Secret rotation — the owner's runbook (D-574)

> **الملخص بالعربية.** هذا دليل المالك لتدوير أسرار المنصة، خطوة بخطوة وبالترتيب: بيئة staging أولًا
> ثم الإنتاج. يبدأ بمفاتيح تغليف الخزنة (KEK) — المفتاح الجديد بجانب القديم، ثم أمر إعادة التغليف،
> ثم التحقق، ثم حذف القديم — ثم كلمات مرور قاعدة البيانات وRedis، وأسرار الجلسات، ومفتاح تجزئة هوية
> المنصات الاجتماعية، ثم إعادة إصدار المفاتيح الخارجية (AWS وMeta وTikTok وResend ومفتاح الذكاء
> الاصطناعي)، وأخيرًا تسجيل تاريخ الإتمام في `operations.secretRotation.completedAt`.
> **المالك ينفّذ كل خطوة على Railway بنفسه؛ لا يغيّر أحد غيره شيئًا هناك.**

**Who does what.** The owner makes every change on Railway, in the Control Center and at each
provider. Nothing in this repository, and nobody working on it, changes a Railway variable. No value
is ever pasted into a chat, an issue, a pull request or a commit.

**Why now.** Railway said on 2026-10-21 that environment variables may have leaked. Until this
runbook has been completed and its day recorded (step 6), Control Center Home → Is Brandspace
ready keeps the AI row on "needs attention" (D-573).

**Do staging first, completely, then production.** Staging is where a mistake costs nothing.

---

## Before you start (both environments)

- A terminal with the Railway CLI, signed in: `railway link` → the project → the environment.
- A way to generate keys: `openssl rand -base64 48` for a KEK or a session secret,
  `openssl rand -base64 36` for a database password. Generate each value when you need it, paste
  it straight into Railway, and do not keep a copy anywhere else.
- Your Control Center account (platform owner) — its email is the `--actor` below.
- A quiet hour. Steps 1 and 2 restart services; nobody should be saving keys in the Control Center
  or connecting social accounts while a KEK changes.

**Service letters**, as in `docs/RAILWAY-ENVIRONMENT-MATRIX.md`: **D** dashboard, **A** admin,
**P** api, **K** worker.

---

## Step 1 — The three vault keys (KEKs)

Each KEK wraps the data keys of one key domain. The secret values themselves are never decrypted or
re-encrypted: only each small data key is unwrapped with the old KEK and wrapped again with the new
one.

| Domain        | Variable                 | Services | What it protects                          |
| ------------- | ------------------------ | -------- | ----------------------------------------- |
| `platform`    | `SECRET_VAULT_KEK`       | A P      | provider keys saved in the Control Center |
| `social`      | `SOCIAL_TOKEN_VAULT_KEK` | P K      | customers' social account tokens          |
| `customerMfa` | `CUSTOMER_MFA_VAULT_KEK` | D P      | customers' authenticator-app seeds        |

**Production is different.** When a service has `<domain>_KMS_KEY_ARN` set (production must), that
domain is sealed by AWS KMS and the KEK variable is not used to seal anything; there is nothing to
re-wrap. In production skip 1.1–1.5 for every domain with a KMS ARN and do step 1.6 instead. The
re-wrap command refuses to run in production.

Do 1.1–1.5 for **one domain at a time**, `platform` first, then `social`, then `customerMfa`.

### 1.1 Put the new key beside the old one

In Railway, on **every service of that domain** (the table above), in one staged change:

1. Add `<KEK>_PREVIOUS` with the **current** (old) value — copy it from `<KEK>` on that service.
2. Change `<KEK>` to a **new** value: `openssl rand -base64 48`. The same new value on every service of
   the domain.
3. Deploy the staged change.

From now on every service seals with the new key and still opens anything sealed with the old one.
Nothing is unreadable at any point. The services refuse to start if `<KEK>_PREVIOUS` equals `<KEK>`,
equals another domain's key, or sits on a service outside its domain.

### 1.2 Dry run

```bash
railway ssh --service api
# inside the service:
pnpm secrets:rewrap-kek --domain platform --actor <your Control Center email> --dry-run
```

It prints counts only, never a key or a value:

```
domain: platform (dry run: nothing changed)
total: 12
already under the new key: 0
would re-wrap: 12
failed: 0
verified with the new key: 0
```

`failed` must be **0**. If it is not, `<KEK>_PREVIOUS` does not hold the key those envelopes were
sealed with: stop, check the value, and do not go on. Nothing was changed.

### 1.3 Re-wrap

The same command without `--dry-run`:

```bash
pnpm secrets:rewrap-kek --domain platform --actor <your Control Center email>
```

It checks every envelope first and **writes nothing** if any opens with neither key. Then it re-wraps
one envelope per transaction, re-reads every envelope and opens each with the **new key alone**.

- It is safe to run again. A second run reports everything as `already under the new key` and changes
  nothing. If the run is interrupted (a closed terminal, a restart), run it again: it finishes the
  rest.
- It writes one audit event per run (`secret.kek_rewrap.checked`, `.completed` or `.failed`) with you
  as the actor, the domain and the counts. Never a value.

### 1.4 Verify

The command's last line must be:

```
Every envelope opens with the new key. SECRET_VAULT_KEK_PREVIOUS can now be removed.
```

with `failed: 0` and `verified with the new key` equal to `total`. Exit code 0.

Any other ending (exit code 1) means: **keep `<KEK>_PREVIOUS`**, find the cause, run again.

Then check by use: Control Center → Integrations → the AI provider → **Test** (platform); a
connected social account still publishes or its connection page shows it connected (social); a
customer with an authenticator app can still sign in (customerMfa).

### 1.5 Remove the old key

In Railway, on every service of that domain: **delete `<KEK>_PREVIOUS`** and deploy. Then run the
dry run once more: `already under the new key` must equal `total`.

Repeat 1.1–1.5 for the next domain.

### 1.6 Production with KMS

- In AWS KMS, turn on **automatic key rotation** for each of the three keys (or rotate on demand). The
  ARN does not change, the old key material stays available to decrypt, and nothing is re-wrapped.
- The leak concerned Railway variables, so the exposed secret is the **AWS access key** on D A P K, not
  the KMS key itself. That is step 5.1.
- `SECRET_VAULT_KEK` is still demanded by the production owner bootstrap guard. Replace any KEK value
  set in production with a new one (`openssl rand -base64 48`, a different value per domain) so no
  exposed value stays set; with a KMS ARN present it seals nothing, so nothing needs re-wrapping.

---

## Step 2 — Database and Redis passwords

### 2.1 The three application roles (`brandspace_app`, `brandspace_platform`, `brandspace_migrator`)

Do one role at a time. Between the password change and the redeploy, **new** connections from that
role are refused; open connections keep working. Keep the gap short.

1. `railway connect postgres` (Railway's own instance credential).
2. In `psql`: `\password brandspace_app` — it prompts twice and does not echo or keep the value in the
   history. Use `openssl rand -base64 36` for the value.
3. Straight away, in Railway, update the password inside `DATABASE_URL` on **D A P K** (one staged
   change) and deploy.
4. Repeat for `brandspace_platform` (`DATABASE_PLATFORM_URL` on **A P**) and `brandspace_migrator`
   (`DATABASE_MIGRATION_URL` on the migration job only).

Check: every service reaches healthy, `/health/ready` answers `ready`, and you can sign in to the
dashboard and the Control Center.

### 2.2 Railway's own Postgres credential

Changing the Postgres service's password variable alone does **not** change the password inside an
existing database. Change it in `psql` first (`\password postgres`), then set the Postgres service's
password variables (`PGPASSWORD`, `POSTGRES_PASSWORD`) to the same value. No BrandSpace service uses
this credential (`docs/RAILWAY-ENVIRONMENT-MATRIX.md`, class B); only you do, for `railway connect`.

### 2.3 Redis

1. On the Redis service, set `REDIS_PASSWORD` to a new value and deploy the Redis service.
2. `REDIS_URL` on **D A P K** is a reference to the Redis service, so it follows; redeploy D A P K.

Do it at a quiet time: background work waits while Redis restarts. Every job is idempotent and safe to
retry (CLAUDE.md §5). Check that the worker reaches healthy and that a scheduled post still goes out.

---

## Step 3 — Session secrets

| Variable                  | Service | What changes when it rotates                                       |
| ------------------------- | ------- | ------------------------------------------------------------------ |
| `CUSTOMER_SESSION_SECRET` | D       | Asset download links issued before the change stop working.        |
| `PLATFORM_SESSION_SECRET` | A       | Nothing a person notices; it is required to differ from the above. |
| `INTERNAL_SERVICE_TOKEN`  | D A P   | Must be the same on all three; set them in one staged change.      |

Sessions are random tokens stored as hashes, not signed with these secrets, so **rotating them signs
nobody out**. A customer who had a download open asks for it again. Use `openssl rand -base64 48` for
each, three different values.

---

## Step 4 — The social subject-hash key (D-526)

This key turns a platform user's id (Meta's, TikTok's) into a keyed hash, so a callback from the
platform finds the right connection. It lives in the Control Center, not in Railway.

**What rotating it would break, if done carelessly:** a connection hashed under a removed key can no
longer be found by a platform callback (a deauthorize or data-deletion request from Meta) until that
account reconnects. **How it is handled:** every hash carries its key's version, and a lookup tries
every listed version, so the old key stays listed until nothing uses it.

1. Control Center → Secrets: store the new key (`openssl rand -base64 48`).
2. Configuration → `integrations.social-apps`: **add** `{ version: <next>, secretRef: <new ref> }` to
   `subjectHashKeys` and set `subjectHashVersion` to it. **Keep the old entry.** New connections and
   reconnections now use the new key.
3. Remove the old entry only when this answers 0 (`docs/OPERATIONS.md` §7.1):

   ```sql
   SELECT count(*) FROM "social_connection" WHERE "providerSubjectHash" LIKE 'v<old>:%';
   ```

   Until then leave it listed: it costs nothing and keeps every callback working.

---

## Step 5 — Reissue the external keys

For each: create the new key at the provider, save it, test it, and only then revoke the old one.
Keys saved in the Control Center are sealed by the vault (step 1 must be finished first).

1. **AWS** (production, and staging if it has one): IAM → the user behind `AWS_ACCESS_KEY_ID` →
   create a second access key → set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` on **D A P K**,
   deploy → check every service is healthy (they reach KMS at start) → **deactivate**, then delete,
   the old access key.
2. **Meta** (Facebook and Instagram): Meta for Developers → the app → Settings → Basic → reset the
   **App secret**. Then Control Center → Integrations → Facebook → save the new app secret → **Test**.
   Also replace the webhook verify token there and in Meta's webhook settings, together.
3. **TikTok**: TikTok for Developers → the app → reset the **Client secret** → Control Center →
   Integrations → TikTok → save → **Test**.
4. **Resend**: Resend → API Keys → create a key for this environment's domain → Control Center →
   Integrations → Email (Resend) → save → **Test** (send yourself one) → delete the old key at Resend.
5. **The AI key**: at the provider, create a key scoped to this environment's project with a hard
   monthly spending limit → Control Center → Integrations → AI → save → **Test** → revoke the old key
   at the provider.
6. **The rest of class C/E**, if set: the R2 storage token (`STORAGE_ACCESS_KEY_ID`,
   `STORAGE_SECRET_ACCESS_KEY` on D P K) and the Scanii pair on the worker — new token at the provider,
   set, deploy, check, revoke the old.

---

## Step 6 — Record it

Control Center → Configuration → `operations` → set **`secretRotation.completedAt`** to today
(`YYYY-MM-DD`) and activate.

Home → Is Brandspace ready then stops asking for the rotation. An AI key saved **before** that day
still reads "needs attention" — that is step 5.5 telling you it was missed.

---

## Then production

Repeat steps 1–6 in the production environment, with 1.6 in place of 1.1–1.5 for every domain sealed
by KMS. Record the production day separately in production's own configuration.

---

## If something goes wrong

| What you see                                                     | What it means and what to do                                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A service will not start after 1.1                               | The message names the variable (never the value): `_PREVIOUS` equals the new key, another domain's key, or is on the wrong service. Fix and deploy. |
| Dry run: `failed` above 0                                        | `_PREVIOUS` is not the key those envelopes were sealed with. Nothing changed. Put the right old value back.                                         |
| Re-wrap: `Not every envelope verified`                           | Keep `_PREVIOUS`. Run again; if it repeats, stop and ask for help before removing anything.                                                         |
| A Control Center key or a social account stops working after 1.5 | `_PREVIOUS` was removed too early. Put the old value back as `_PREVIOUS`, deploy, run 1.3 again.                                                    |
| `/health/ready` not ready after step 2                           | A connection string still holds the old password. Compare the service's variable with what you set in `psql`.                                       |
