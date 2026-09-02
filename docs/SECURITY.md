# BrandSpace — Security and Reliability

> **الملخص التنفيذي بالعربية**
>
> هذا المستند يحدد **نموذج الأمان والموثوقية** للمنصة.
>
> **العزل بين العملاء** هو الالتزام الأمني الأول: كل بيانات العميل مقيّدة بـ `workspaceId` على مستوى التطبيق **وعلى مستوى قاعدة البيانات**
> عبر Row-Level Security، ومع اختبارات آلية إلزامية تثبت أن مستخدم مساحة عمل «أ» لا يستطيع قراءة أو تعديل أو البحث في أو تصدير أو حتى
> استنتاج وجود بيانات مساحة عمل «ب».
>
> **صلاحيات الأدوار (RBAC)** محددة على أربعة مستويات: المنصة، مساحة العمل، العلامة التجارية، والحملة — مع مصفوفة صلاحيات تفصيلية لكل دور.
>
> **الأسرار (المفاتيح والرموز)** لا تُخزَّن أبدًا كإعدادات عادية: تُشفَّر بتشفير موثَّق (AEAD)، لا تظهر في السجلات أو الردود، ولا يُعرض منها
> إلا آخر أربعة أحرف، مع دعم التدوير والإلغاء وفصل بيئات التطوير والاختبار والإنتاج، وجاهزية للربط بخدمة KMS سحابية مستقبلًا.
>
> ويغطي المستند أيضًا: التشفير، سجلات التدقيق، حدود المعدل، فحص الملفات، منع إساءة الاستخدام، التحقق من توقيع الـ Webhooks،
> مفاتيح منع التكرار، النسخ الاحتياطي واختبار الاستعادة، المراقبة والتنبيهات، الاستجابة للحوادث، تصدير البيانات، حذف الحساب،
> سياسات الاحتفاظ، والخصوصية، و**وضع الدعم الآمن** الذي يتيح للفريق الداخلي مساعدة العميل دون رؤية كلمات المرور أو الرموز الخام.

---

## 1. Security Principles

1. **Isolation by default.** Data access is denied unless a tenant context proves entitlement.
2. **Defense in depth.** Application scoping and database RLS are independent; either alone must be able to
   stop a breach.
3. **Least privilege.** Every actor — human, service, job, AI tool call — gets the narrowest permission set.
4. **No ambient authority.** There is no "admin bypass" available to request handlers; cross-tenant access is
   an explicit, audited, named operation.
5. **Secrets are not data.** They live in a vault abstraction, never in config rows, logs, or responses.
6. **Everything consequential is audited.** If it changes state or exposes customer data, it produces an
   `AuditEvent`.
7. **Fail closed.** Ambiguity in authorization, entitlement, or validation results in denial, not access.
8. **No silent external effects.** Publish, delete, disconnect, pay, and send require confirmation policy.

---

## 2. Tenant Isolation

### 2.1 Enforcement layers

| Layer              | Mechanism                                                       | Failure mode it stops             |
| ------------------ | --------------------------------------------------------------- | --------------------------------- |
| 1. Edge            | Hostname/route separation of the three apps                     | Admin surface exposed publicly    |
| 2. Session         | Separate realms, cookie names, signing keys, audiences          | Customer token used against Admin |
| 3. Tenant resolver | Membership verified server-side; client claims never trusted    | Header/param tampering            |
| 4. Authorization   | RBAC + resource ownership check before handler                  | Missing permission check          |
| 5. Data access     | Tenant-scoped Prisma client injects the predicate               | Developer forgets a `where`       |
| 6. Database        | RLS policies on `workspace_id`; app role cannot bypass          | Raw SQL, ORM bug, injection       |
| 7. Storage         | Workspace-prefixed keys + signed URLs issued post-authorization | Object enumeration                |
| 8. Queue           | Jobs carry tenant context and are re-authorized on execution    | Forged job payloads               |
| 9. Cache           | Cache keys namespaced by workspace                              | Cross-tenant cache poisoning/read |
| 10. Tests          | Mandatory isolation suite, schema-driven coverage gate          | Regressions and new models        |

### 2.2 RLS pattern

```sql
ALTER TABLE content_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_item FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON content_item
  USING      (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
```

- The application connects as `app_user`, which has **no** `BYPASSRLS` and is not the table owner.
- `SET LOCAL app.workspace_id` is issued at transaction start by the tenant-scoped client; it is `LOCAL`
  so it cannot leak across pooled connections.
- Connection pooling uses transaction-level pooling so the setting is always scoped to one transaction.
- Migrations run as a separate role that is never used to serve requests.
- A CI check fails the build if a tenant-owned table lacks `ENABLE`/`FORCE ROW LEVEL SECURITY` and a policy.

### 2.3 Non-inference guarantees

- Cross-tenant access returns `404` with the same body and timing characteristics as a genuine miss.
- Error messages never echo whether a resource exists elsewhere.
- Slugs, IDs, and invitation tokens are unguessable (UUIDv7 / high-entropy tokens); enumeration is
  rate-limited and alerted.
- Aggregates, counts, autocomplete, and vector similarity all carry the workspace predicate **inside** the
  query, never as a post-filter.
- Cross-tenant timing differences on authorization checks are avoided by performing the ownership check with
  a constant-shape query.

### 2.4 Platform access to tenant data — the two-pool model

`asPlatform(actor, operation)` is the only application path. It requires a platform actor holding a
valid platform role with **verified MFA**, a **written reason**, and a **correlation id**; it records
an `AuditEvent`; and for customer-data reads it must be inside a **Support Mode session** (§8).

**Cross-tenant visibility is a property of which database role connected, not of a session variable.**

|             | `brandspace_app`                         | `brandspace_platform`            | `brandspace_migrator`            |
| ----------- | ---------------------------------------- | -------------------------------- | -------------------------------- |
| Purpose     | serves every tenant request              | audited platform operations only | owns the schema, runs migrations |
| Credential  | `DATABASE_URL`                           | `DATABASE_PLATFORM_URL`          | `DATABASE_MIGRATION_URL`         |
| Present in  | every tenant-facing process              | **platform processes only**      | migration jobs only              |
| RLS policy  | `tenant_isolation` — workspace predicate | `platform_access` — full         | none (DDL is unaffected by RLS)  |
| `BYPASSRLS` | no                                       | **no**                           | no                               |
| Owns tables | no                                       | no                               | yes                              |

**Why this is secure.** The tenant role cannot obtain cross-tenant visibility by any SQL it is able
to execute:

1. No RLS policy names `brandspace_app` for cross-tenant access; `platform_access` is
   `TO brandspace_platform` only, and no policy is granted to `PUBLIC`.
2. `brandspace_app` is not a member of `brandspace_platform`, so `SET ROLE` is refused.
3. The former `app.is_platform_mode()` function is **dropped**, so no session variable can widen
   visibility. Setting the old GUC now has no effect at all.
4. `brandspace_app` cannot `GRANT` itself membership, `ALTER` its own role attributes, or
   `CREATE POLICY` naming itself — it owns nothing and holds no role-administration privilege.
5. Neither role has `BYPASSRLS`. The platform role's access is an ordinary policy, so `WITH CHECK`
   still constrains its writes and the behaviour is visible in `pg_policies` rather than hidden in a
   role attribute.
6. `audit_event` remains append-only for **both** roles: `UPDATE`/`DELETE` are revoked, with a
   trigger as a second stop. Platform operations write the audit trail; nothing may rewrite it.

Each of these is asserted in `tests/isolation/platform-role.test.ts` against a real PostgreSQL, using
raw `pg` connections with no application code in the path.

**Credential confinement.** The platform pool module is not exported from `@brandspace/database`; an
ESLint rule rejects importing it from anywhere except `asPlatform()` itself; a browser guard throws if
it is ever evaluated in a client context; and `DATABASE_PLATFORM_URL` is never a `NEXT_PUBLIC_`
variable. `tests/unit/platform-pool-boundary.test.ts` asserts all of these.

**Role membership is not managed by migrations.** Revoking a role membership requires ADMIN option on
that role, and granting the migrator that power would make it a privilege-escalation path in its own
right. `scripts/sql/setup-database-roles.sql` is the canonical definition, run by a DBA; the migration
asserts the separation and refuses to deploy without it.

**Residual risk.** Anyone holding `DATABASE_PLATFORM_URL` has cross-tenant access — that credential is
the boundary. What changed is that compromising the _tenant application role_ no longer grants
cross-tenant access, which it previously did. Further reduction (short-lived credentials from a secret
manager, and splitting read-only from write platform access) is recorded as F-07 in
`docs/DECISIONS.md` and belongs with the Secret Service in Phase 2.

---

## 3. Authentication

| Control            | Requirement                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password storage   | Argon2id, per-user salt, tuned memory/time cost                                                                                                                           |
| Password policy    | Length-first (min 12), breached-password check, no forced rotation                                                                                                        |
| Rate limiting      | Per-IP and per-account exponential backoff; lockout with unlock flow                                                                                                      |
| Email verification | Required before first login completes; signed single-use token                                                                                                            |
| MFA                | TOTP + recovery codes. Optional for customers; **mandatory for Platform Owner and Platform Admin**                                                                        |
| Step-up auth       | Required for: secret create/rotate/revoke, plan price changes, entering support mode, refunds, credit adjustments above a threshold, account deletion, ownership transfer |
| Sessions           | Short-lived access token, rotating refresh, absolute max lifetime, device list, revoke-all                                                                                |
| Invalidation       | On password change, role change, membership removal, workspace suspension, MFA reset                                                                                      |
| Invitations        | Signed, single-use, expiring, bound to workspace+role; token stored hashed                                                                                                |
| Realm separation   | Distinct cookie names, signing keys, audiences, and session tables for customer vs. platform                                                                              |
| Admin surface      | Dedicated hostname; optional IP allowlist; no public registration path                                                                                                    |
| Future             | SSO (SAML/OIDC) and SCIM for Enterprise — identity model already supports it                                                                                              |

**Cookies:** `HttpOnly`, `Secure`, `SameSite=Lax` (strict for admin), `__Host-` prefix, short TTL.
**CSRF:** double-submit token plus SameSite; all mutations require the token.

---

## 4. Authorization (RBAC)

### 4.1 Model

`Permission` = `resource.action` (e.g. `content.create`, `content.publish`, `billing.manage`).
`Role` = a named set of permissions, optionally with constraints (`ownOnly`, `assignedBrandsOnly`).
`Membership` = user + workspace + role + optional brand scope.

**Effective permission** = role permissions ∩ scope (platform / workspace / brand / campaign)
∩ entitlements (plan allows the feature) ∩ resource ownership.

All four must pass. A permission the plan does not include is denied even for a Workspace Owner
(with an upgrade-prompt error code, distinct from a permission denial).

### 4.2 Scope levels

| Scope     | Example permission         | Resolution                                        |
| --------- | -------------------------- | ------------------------------------------------- |
| Platform  | `platform.plans.manage`    | platform role only                                |
| Workspace | `workspace.members.invite` | membership role in that workspace                 |
| Brand     | `brand.content.create`     | membership role **and** brand in `brandScope`     |
| Campaign  | `campaign.approve`         | brand scope **and** campaign assignment/ownership |

### 4.3 Customer role matrix

Legend: ✅ full · 🟡 limited/conditional · ➖ none

| Capability                            | Owner | Admin              | Mktg Mgr           | Content Creator | Copywriter     | Designer         | Approver        | Analyst         | Client Viewer               |
| ------------------------------------- | ----- | ------------------ | ------------------ | --------------- | -------------- | ---------------- | --------------- | --------------- | --------------------------- |
| View workspace                        | ✅    | ✅                 | ✅                 | ✅              | ✅             | ✅               | ✅              | ✅              | 🟡 assigned brands          |
| Manage workspace settings             | ✅    | ✅                 | ➖                 | ➖              | ➖             | ➖               | ➖              | ➖              | ➖                          |
| Transfer ownership / delete workspace | ✅    | ➖                 | ➖                 | ➖              | ➖             | ➖               | ➖              | ➖              | ➖                          |
| Invite / remove members               | ✅    | ✅                 | 🟡 non-admin roles | ➖              | ➖             | ➖               | ➖              | ➖              | ➖                          |
| Assign roles                          | ✅    | 🟡 below own level | ➖                 | ➖              | ➖             | ➖               | ➖              | ➖              | ➖                          |
| Create / archive brands               | ✅    | ✅                 | 🟡 create only     | ➖              | ➖             | ➖               | ➖              | ➖              | ➖                          |
| Edit Brand Center / Brand Brain       | ✅    | ✅                 | ✅                 | 🟡 suggest      | 🟡 suggest     | 🟡 visual only   | ➖              | ➖              | ➖                          |
| Generate AI strategy                  | ✅    | ✅                 | ✅                 | ➖              | ➖             | ➖               | ➖              | ➖              | ➖                          |
| Create / edit campaigns               | ✅    | ✅                 | ✅                 | 🟡 own          | ➖             | ➖               | ➖              | ➖              | ➖                          |
| Create content drafts                 | ✅    | ✅                 | ✅                 | ✅              | ✅ text only   | 🟡 visual only   | ➖              | ➖              | ➖                          |
| Generate AI content                   | ✅    | ✅                 | ✅                 | ✅              | ✅             | 🟡 creative only | ➖              | ➖              | ➖                          |
| Generate AI creative                  | ✅    | ✅                 | ✅                 | ✅              | ➖             | ✅               | ➖              | ➖              | ➖                          |
| Upload / manage assets                | ✅    | ✅                 | ✅                 | ✅              | 🟡 own         | ✅               | ➖              | ➖              | ➖                          |
| Submit for approval                   | ✅    | ✅                 | ✅                 | ✅              | ✅             | ✅               | ➖              | ➖              | ➖                          |
| Approve / reject                      | ✅    | ✅                 | ✅                 | ➖              | ➖             | ➖               | ✅              | ➖              | 🟡 optional client approval |
| Comment                               | ✅    | ✅                 | ✅                 | ✅              | ✅             | ✅               | ✅              | ✅              | ✅                          |
| Schedule to calendar                  | ✅    | ✅                 | ✅                 | 🟡 own approved | ➖             | ➖               | ➖              | ➖              | ➖                          |
| Publish now / external publish        | ✅    | ✅                 | ✅                 | ➖              | ➖             | ➖               | ➖              | ➖              | ➖                          |
| Connect / disconnect social accounts  | ✅    | ✅                 | 🟡 connect only    | ➖              | ➖             | ➖               | ➖              | ➖              | ➖                          |
| View analytics                        | ✅    | ✅                 | ✅                 | ✅              | 🟡 own content | 🟡 own content   | ✅              | ✅              | 🟡 assigned brands          |
| Export analytics / data               | ✅    | ✅                 | ✅                 | ➖              | ➖             | ➖               | ➖              | ✅              | 🟡 if enabled               |
| Use AI Copilot                        | ✅    | ✅                 | ✅                 | ✅              | ✅             | ✅               | 🟡 read/explain | 🟡 read/explain | ➖                          |
| Create automations                    | ✅    | ✅                 | ✅                 | ➖              | ➖             | ➖               | ➖              | ➖              | ➖                          |
| View billing & invoices               | ✅    | 🟡 view only       | ➖                 | ➖              | ➖             | ➖               | ➖              | ➖              | ➖                          |
| Change plan / payment method          | ✅    | ➖                 | ➖                 | ➖              | ➖             | ➖               | ➖              | ➖              | ➖                          |
| View AI credit balance                | ✅    | ✅                 | ✅                 | 🟡 own usage    | 🟡 own usage   | 🟡 own usage     | ➖              | 🟡 aggregate    | ➖                          |
| View activity log                     | ✅    | ✅                 | 🟡 brand-scoped    | 🟡 own          | 🟡 own         | 🟡 own           | 🟡 own          | 🟡 brand-scoped | ➖                          |

### 4.4 Platform role matrix

| Capability                             | Platform Owner | Platform Admin                 | Support Agent                       | Billing Manager    | Operations Viewer |
| -------------------------------------- | -------------- | ------------------------------ | ----------------------------------- | ------------------ | ----------------- |
| View platform dashboards               | ✅             | ✅                             | 🟡 support-relevant                 | 🟡 financial       | ✅ read-only      |
| Create customers / workspaces          | ✅             | ✅                             | ➖                                  | ➖                 | ➖                |
| Send invitations                       | ✅             | ✅                             | 🟡 resend only                      | ➖                 | ➖                |
| Assign / change plans                  | ✅             | ✅                             | ➖                                  | ✅                 | ➖                |
| Start / extend trials                  | ✅             | ✅                             | 🟡 extend within cap                | ✅                 | ➖                |
| Suspend / reactivate accounts          | ✅             | ✅                             | ➖                                  | 🟡 for non-payment | ➖                |
| Add / remove AI credits                | ✅             | ✅                             | 🟡 goodwill within cap              | ✅                 | ➖                |
| Change workspace limits                | ✅             | ✅                             | ➖                                  | 🟡 quota add-ons   | ➖                |
| Toggle customer-specific features      | ✅             | ✅                             | ➖                                  | ➖                 | ➖                |
| Create / edit plans and prices         | ✅             | 🟡 draft only, owner activates | ➖                                  | 🟡 draft only      | ➖                |
| Manage feature flags                   | ✅             | ✅                             | ➖                                  | ➖                 | ➖                |
| Configure integrations                 | ✅             | ✅                             | ➖                                  | 🟡 payment only    | ➖                |
| Create / rotate / revoke secrets       | ✅             | 🟡 rotate, not reveal          | ➖                                  | 🟡 payment only    | ➖                |
| View masked credential metadata        | ✅             | ✅                             | ➖                                  | 🟡 payment only    | 🟡 health only    |
| Manage AI providers / models / routing | ✅             | ✅                             | ➖                                  | ➖                 | ➖                |
| Enter support mode                     | ✅             | ✅                             | ✅                                  | ➖                 | ➖                |
| Issue refunds / credit notes           | ✅             | 🟡 within cap                  | ➖                                  | ✅                 | ➖                |
| Edit notification templates            | ✅             | ✅                             | ➖                                  | ➖                 | ➖                |
| View audit log                         | ✅             | ✅                             | 🟡 own actions + assigned workspace | 🟡 billing events  | ✅ read-only      |
| Manage platform users and roles        | ✅             | ➖                             | ➖                                  | ➖                 | ➖                |
| Activate configuration versions        | ✅             | 🟡 non-financial domains       | ➖                                  | ➖                 | ➖                |
| Export platform data                   | ✅             | 🟡                             | ➖                                  | 🟡 financial       | ➖                |

**Separation of duties:** the actor who drafts a pricing or credit-cost change should not be the actor who
activates it. For financial configuration domains this is enforced (Platform Admin drafts, Platform Owner
activates); a documented break-glass single-actor path exists and is alerted.

### 4.5 Authorization middleware

Every route declares its contract at registration:

```ts
route({
  scope: 'workspace', // 'public' | 'platform' | 'workspace'
  permission: 'content.publish',
  resource: { type: 'contentItem', from: 'params.id' },
  entitlement: 'social.publish',
  confirmation: 'required', // high-impact action
  rateLimit: 'publish',
  idempotent: true,
});
```

The framework refuses to register a route that omits `scope`. Handlers cannot reach the database without a
resolved context. A generated **route/permission report** is committed and reviewed, so any route lacking a
permission is visible in the diff.

---

## 5. Secret Management

### 5.1 Rules

1. Secrets are **never** stored in configuration payloads, environment files checked into git, or database
   columns as plaintext.
2. Configuration references secrets by `secretRef` only (e.g. `ai/openai/production/api-key`).
3. Values are encrypted with **authenticated encryption** (AES-256-GCM or XChaCha20-Poly1305) using a
   data-encryption key wrapped by a key-encryption key (envelope encryption). The KEK is held outside the
   application database and is KMS-ready.
4. Encryption context binds ciphertext to `(ref, environment, version)` so a ciphertext cannot be replayed
   into another scope.
5. **No secret is ever returned by any API.** Reads return only: `maskedHint` (last 4), `fingerprint`,
   `status`, `version`, `createdAt`, `lastRotatedAt`, `lastUsedAt`, `expiresAt`.
6. Secrets are resolved only inside server-side adapters, held in memory for the shortest possible time, and
   never passed to any serializer that could reach a log, trace, response, or error.
7. Frontend bundles are scanned in CI for secret-looking strings; `NEXT_PUBLIC_*` variables are schema-checked
   against an allowlist.
8. Log sinks and error serializers run a **redaction layer** keyed on field names and value patterns
   (`sk-`, `Bearer `, JWT shape, high-entropy strings).
9. Development, staging, and production have **completely separate** secrets and vault namespaces.
10. Access requires a platform permission plus step-up authentication.

### 5.2 Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Created: value encrypted, only masked hint stored
  Created --> Validated: test connection succeeds
  Validated --> Active: activated for the environment
  Active --> Rotating: new version created, both accepted
  Rotating --> Active: old version retired after drain window
  Active --> Disabled: temporarily stopped
  Disabled --> Active: re-enabled
  Active --> Revoked: permanently invalidated
  Revoked --> [*]
```

**Rotation** is zero-downtime: version _n+1_ is created and validated while version _n_ remains valid;
traffic shifts; version _n_ is retired after a drain window. `lastUsedAt` proves nothing still uses the old
version before retirement.

**Audit** — every create, validate, activate, rotate, disable, revoke, and _resolve-for-use_ writes an
`AuditEvent` containing the ref, actor, environment, and outcome, and **never** the value.

**Compromise response:** revoke → rotate → invalidate dependent sessions/connections → audit the access
history of that ref → notify affected workspaces if customer tokens were involved.

### 5.3 Customer-held secrets

Customer OAuth access/refresh tokens and optional BYOK API keys use the **same** vault mechanism, scoped by
workspace. They are never shown to platform staff, including in support mode, and never returned to the
customer either — only masked metadata and connection status.

---

## 6. Encryption

| Layer                    | Control                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| In transit (public)      | TLS 1.3, HSTS with preload, no mixed content, modern cipher suites                           |
| In transit (internal)    | TLS between services; database connections require TLS with certificate verification         |
| At rest (database)       | Managed volume encryption + application-level AEAD for secret and token columns              |
| At rest (object storage) | Server-side encryption; no public objects; signed URLs with short TTL                        |
| At rest (backups)        | Encrypted; keys separate from the primary data keys                                          |
| Field-level              | Tokens, MFA secrets, BYOK keys, and any PII marked sensitive use application-level AEAD      |
| Key management           | Envelope encryption, documented key hierarchy, scheduled KEK rotation, KMS-ready abstraction |

**Browser security headers:** strict `Content-Security-Policy` (no inline scripts without nonce),
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy` minimized, `X-Frame-Options: DENY` on dashboard and admin.

---

## 7. Audit Logging

- Every state change and every customer-data access by a platform actor writes an immutable `AuditEvent`.
- Events capture: actor (type/id), action, resource, workspace, before/after (redacted), IP, user agent,
  request/trace id, outcome, and support-mode session when applicable.
- **Denied** attempts are audited too — repeated denials are a detection signal.
- The application role has `SELECT`/`INSERT` only on `audit_event`; `UPDATE`/`DELETE` are revoked.
- Customers see a filtered, human-readable Activity Log (their workspace only).
- Platform staff see the full log; access to it is itself audited.
- Exportable for compliance; retention default 24 months, configurable.

**Always-audited actions:** login/logout/failed login, MFA changes, role/membership changes, brand and content
deletion, publish/unpublish, social connect/disconnect, secret lifecycle, plan/price/entitlement changes,
credit adjustments, refunds, support mode enter/exit, configuration activation and rollback, data export,
account deletion, and every Copilot action execution.

---

## 8. Secure Support Access (Support Mode)

Platform staff sometimes must see a customer's workspace to help. That capability is a **named, bounded,
audited mode** — not a hidden superpower.

| Property      | Rule                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Entry         | Requires permission + step-up auth + a **reason** and optional ticket reference                                               |
| Duration      | Time-boxed (default 60 minutes, configurable), auto-expires                                                                   |
| Access        | **Read-only by default.** Write actions require a separate elevated grant and are individually audited                        |
| Never visible | Passwords, password hashes, MFA secrets, OAuth access/refresh tokens, BYOK keys, payment card data                            |
| Redaction     | Content bodies and Brand Brain can be masked by policy (owner-configurable; default: visible, since support usually needs it) |
| Visibility    | The workspace's Activity Log shows that support accessed the workspace, with reason and duration                              |
| Notification  | Optional workspace-owner notification on entry (configurable; default on for write-enabled sessions)                          |
| Impersonation | **True impersonation (acting as the user) is prohibited at MVP.** Support views data as a platform actor, clearly labeled     |
| Audit         | Every request inside the session carries `supportModeSessionId`                                                               |

---

## 9. Input Validation and Application Attacks

| Threat                                | Control                                                                                                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Injection (SQL)                       | Parameterized ORM queries; raw SQL requires review + explicit tenant predicate; RLS as backstop                                                                                           |
| XSS                                   | React escaping; no `dangerouslySetInnerHTML` without sanitization; strict CSP with nonces; user content sanitized on render                                                               |
| CSRF                                  | SameSite cookies + double-submit token on all mutations                                                                                                                                   |
| SSRF                                  | Outbound requests only to allowlisted hosts from configuration; URL fetching (link previews, imports) goes through a validating proxy that blocks private IP ranges and redirects to them |
| IDOR                                  | Ownership check before every resource access; 404 on cross-tenant                                                                                                                         |
| Mass assignment                       | Explicit Zod schemas; no direct object spreading into the ORM                                                                                                                             |
| Open redirect                         | Redirect targets validated against an allowlist                                                                                                                                           |
| Prototype pollution / deserialization | Schema parsing only; no `eval`, no dynamic `require` of user input                                                                                                                        |
| Dependency risk                       | Lockfiles, automated dependency scanning, SCA in CI, pinned base images, SBOM                                                                                                             |
| Secret leakage in code                | Pre-commit and CI secret scanning; blocked merge on detection                                                                                                                             |
| Clickjacking                          | `X-Frame-Options: DENY` / CSP `frame-ancestors 'none'` on authenticated apps                                                                                                              |

### 9.1 AI-specific threats

| Threat                                                                  | Control                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection via Brand Brain, uploaded documents, or social content | Retrieved content is delimited and labeled as untrusted data; system instructions are never overridable by retrieved text; tool-calling is allow-listed per user permission, not per prompt |
| Copilot privilege escalation                                            | Every tool call re-checks the user's permissions and entitlements server-side; the model's claims about permissions are ignored                                                             |
| Data exfiltration through generation                                    | Retrieval is workspace-scoped at the query level; the model never receives another tenant's context; outbound tool calls are allowlisted                                                    |
| Unsafe or brand-damaging output                                         | Moderation task before persistence/publishing; brand do/don't rules enforced as post-checks                                                                                                 |
| Cost abuse                                                              | Per-workspace and per-user budgets, rate limits, max cost per request, hard limits                                                                                                          |
| Model output treated as trusted code/data                               | AI output is parsed with a schema and never executed; generated URLs are not auto-fetched                                                                                                   |

---

## 10. Rate Limiting and Abuse Prevention

| Dimension          | Example limits (all configuration, not constants)                              |
| ------------------ | ------------------------------------------------------------------------------ |
| Per IP             | Auth endpoints, sign-up, contact form, password reset                          |
| Per user           | AI requests/minute, exports/hour, invitations/day                              |
| Per workspace      | AI requests/minute, publish jobs/hour, API calls/minute, storage upload volume |
| Per endpoint class | Read vs. write vs. AI vs. external-effect                                      |
| Per provider       | Respect upstream quotas; internal concurrency caps                             |

Responses use `429` with `Retry-After` and standard rate-limit headers. Algorithm: sliding-window or token
bucket in Redis. Limits are per-plan configurable.

**Abuse controls:** bot protection on sign-up and contact forms, disposable-email policy (configurable),
velocity checks on invitations and trials, duplicate-account heuristics, automatic throttling on anomalous
AI burn, and an owner-visible abuse queue.

---

## 11. File Upload Security

1. Pre-signed upload with a server-issued key, enforced content type, and size cap.
2. Content-type sniffing on the server — the client's declared type is not trusted.
3. Malware/virus scanning before the asset becomes `ready`; infected files are quarantined and audited.
4. Image/video re-encoding strips metadata (including GPS) and neutralizes polyglot files.
5. SVG uploads are sanitized or converted; never served inline from the app origin.
6. Assets are served from a separate domain/CDN with `Content-Disposition` where appropriate — never from the
   application origin — so a malicious file cannot execute in the app's security context.
7. Storage keys are workspace-prefixed; direct object access requires a signed, short-TTL URL.
8. Per-plan storage quotas enforced at upload authorization time.

---

## 12. Webhooks

### 12.1 Inbound (from social, payment, email providers)

- **Signature verification is mandatory** (HMAC or provider scheme), with timestamp tolerance to prevent replay.
- Raw body is preserved for signature computation before parsing.
- The provider event ID is stored with a unique constraint → processing is **idempotent**.
- Events are acknowledged fast and processed asynchronously via the `billing-events` / `analytics-ingest` queues.
- Unverified or malformed events are rejected and counted; a spike alerts.
- Out-of-order events are handled by comparing event timestamps/versions against current state.

### 12.2 Outbound (to customer systems, future)

- Signed with a per-endpoint secret, timestamped, retried with exponential backoff, with a delivery log and
  a customer-visible replay tool. Target URLs validated against SSRF rules.

---

## 13. Idempotency

| Surface                             | Key                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------- |
| HTTP mutations with external effect | `Idempotency-Key` header, stored with request hash + response snapshot  |
| AI requests                         | `AIRequest.idempotencyKey` (task + input hash + workspace + client key) |
| Publish jobs                        | `PublishJob.idempotencyKey` (variant + connection + slot)               |
| Credit movements                    | `CreditTransaction.idempotencyKey`                                      |
| Inbound webhooks                    | provider event ID                                                       |
| Automation runs                     | rule + trigger event id                                                 |

Replaying a key returns the original result; a key reused with a _different_ payload returns `409`.
Keys expire after 24 hours (configurable).

---

## 14. Reliability

### 14.1 Health and readiness

- `/health/live` (process up) and `/health/ready` (database, Redis, storage, migrations current) on each app.
- **Dependency health** for AI providers and social platforms is tracked continuously and surfaced in
  Platform Admin and on the public Status page.
- Circuit breakers per external provider; when open, the system degrades gracefully (queue, retry later,
  route to fallback model) rather than failing the user's whole action.

### 14.2 Backups and restore

| Control         | Requirement                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Database        | Continuous WAL archiving, PITR ≥ 30 days, daily snapshots, 12 monthly retained                                                        |
| Object storage  | Versioning enabled + cross-region replication for production                                                                          |
| Secrets/vault   | Backed up separately with independent key custody                                                                                     |
| Restore testing | **Quarterly restore drill into an isolated environment, timed and documented.** A backup that has never been restored is not a backup |
| Targets         | RPO ≤ 15 minutes, RTO ≤ 4 hours for the core platform                                                                                 |
| Deletion safety | Soft delete + grace window before irreversible purge                                                                                  |

### 14.3 Observability and alerting

Golden signals per endpoint and queue, plus domain alerts:

| Alert                                         | Threshold (configurable)               | Severity           |
| --------------------------------------------- | -------------------------------------- | ------------------ |
| Publish failure rate                          | > 5% over 15 min                       | critical           |
| AI provider error rate                        | > 10% over 10 min                      | critical           |
| Queue age (any queue)                         | oldest job > 10 min                    | warning → critical |
| Webhook processing lag                        | > 5 min                                | warning            |
| Daily AI provider cost                        | > configured daily cap                 | critical           |
| Credit ledger drift                           | any mismatch in nightly reconciliation | critical           |
| RLS policy violation / unscoped query attempt | any occurrence                         | critical           |
| Failed logins spike / enumeration pattern     | anomaly                                | warning            |
| Certificate/token expiry                      | < 14 days                              | warning            |
| Backup failure or missed snapshot             | any                                    | critical           |

### 14.4 Incident response

1. **Detect** — alert fires or a report arrives.
2. **Triage** — severity S1–S4; S1 = data exposure, publishing outage, billing incorrectness, or auth bypass.
3. **Contain** — feature flag off, disable a provider or connector, revoke a secret, suspend a job class.
4. **Communicate** — Status page update within 30 minutes for S1/S2; in-app banner where relevant.
5. **Resolve** — fix, verify, restore normal operation.
6. **Review** — blameless postmortem within 5 business days, with action items tracked.
7. **Notify** — if personal data was exposed, notify affected customers and, where applicable, regulators
   within the legally required window.

Every feature has a kill switch (feature flag) so containment does not require a deploy.

---

## 15. Privacy and Data Rights

| Right                   | Implementation                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Access / portability    | Self-serve workspace export (JSON + media manifest), generated async, delivered via short-lived signed URL                                                                           |
| Rectification           | Editable in-product                                                                                                                                                                  |
| Erasure                 | Account deletion request → 30-day grace (recoverable) → irreversible purge across DB, storage, backups-on-expiry, and search indexes; financial records retained as legally required |
| Restriction / objection | Workspace suspension without deletion                                                                                                                                                |
| Consent                 | Explicit consent for marketing communications; granular notification preferences                                                                                                     |
| Sub-processors          | Public list on the Security page, kept current with the active provider configuration                                                                                                |
| Data residency          | Single region at MVP; region selection is a documented future capability (see DECISIONS D-03, R-28)                                                                                  |
| PII minimization        | AI request bodies not persisted by default; only audit-safe summaries                                                                                                                |
| Cookies                 | Consent management on the public site; no non-essential tracking without consent                                                                                                     |
| DPA / SCCs              | Available for business customers; template maintained under Legal                                                                                                                    |

**Retention defaults** are listed in `docs/DATABASE.md` §13 and are configurable per plan.

---

## 16. Compliance Posture (direction, not a claim)

At MVP BrandSpace does not claim any certification. The architecture is deliberately built so that
**SOC 2 Type II** and **GDPR** readiness are achievable without redesign: immutable audit trail, least-privilege
access, encryption everywhere, documented change management (configuration versioning), tested backups,
incident response process, and vendor/sub-processor management. A formal readiness assessment is a
post-launch activity.

---

## 17. Security Testing

| Activity                                                 | Cadence                                  |
| -------------------------------------------------------- | ---------------------------------------- |
| Isolation test suite                                     | Every CI run — blocking                  |
| SAST + dependency scanning + secret scanning             | Every CI run — blocking on high severity |
| Container/base-image scanning                            | Every build                              |
| DAST against staging                                     | Weekly                                   |
| Authorization matrix tests (every role × every endpoint) | Every CI run                             |
| Third-party penetration test                             | Before public launch, then annually      |
| Restore drill                                            | Quarterly                                |
| Access review (platform users, secrets, provider apps)   | Quarterly                                |
| Threat model review                                      | Each major architectural change          |

---

## 18. Implementation Status — Phase 2A

> **ملخّص بالعربية**
>
> هذا القسم يفصل بين ما هو مُنفَّذ ومُختبَر فعليًا، وما هو تصميم لم يُبنَ بعد. كل ادّعاء أدناه مرتبط باختبار
> يمكن تشغيله. أهم ما في المرحلة: عزل بيانات المنصة عن دور التطبيق، إلزام التحقق بخطوتين، تشفير المفاتيح
> السرية بمفتاح بيانات مُغلَّف، وعدم وجود أي مسار لإظهار قيمة سرية بعد حفظها.

### 18.1 The three database identities

| Role                  | Owns schema | `BYPASSRLS` | Sees tenant data             | Sees platform data  |
| --------------------- | ----------- | ----------- | ---------------------------- | ------------------- |
| `brandspace_migrator` | yes         | no          | only via migrations          | only via migrations |
| `brandspace_app`      | no          | no          | only its request's workspace | **none at all**     |
| `brandspace_platform` | no          | no          | all, through `asPlatform()`  | yes                 |

"None at all" is literal and is asserted, not assumed: every privilege is revoked from `brandspace_app` on
every platform-owned table, so a query returns _permission denied_, not zero rows. The distinction matters —
zero rows would mean the grant still exists and only a policy stands between the tenant role and the data.

### 18.2 Platform-owned tables

`platform_user`, `platform_session`, `platform_mfa_recovery_code`, `configuration_version`, `secret_record`,
`secret_version`. Each has RLS **enabled and forced**, a policy naming `brandspace_platform` only, and every
privilege revoked from `brandspace_app`.

`platform_user` was added to this list in Phase 2A after the Control Center tests found it readable by the
tenant role — the identity migration created it and the RLS migration's blanket `GRANT ... ON ALL TABLES`
covered it, while no policy was ever written. The tenant role could read the Platform Owner's Argon2id
password hash. Recorded as F-10 in `docs/DECISIONS.md`, fixed by migration
`20260901210500_platform_user_isolation`, and the class of bug is now closed by the isolation gate: every
model must be classified in the tenancy registry, so a new model nobody thought about fails the build.

### 18.3 Platform Admin authentication

- **Password**: Argon2id, 19 MiB memory, 2 iterations, parallelism 1.
- **Two steps, and the first is worthless.** A correct password creates a session with `mfaVerifiedAt = NULL`.
  `resolveActor()` returns `null` for such a session, so a stolen pre-MFA cookie grants nothing — asserted in
  both the isolation suite and the browser suite.
- **TOTP** (RFC 6238, ±1 step). The seed lives in the Secret Service; `platform_user` stores only a reference.
- **Recovery codes**: high-entropy, stored as SHA-256 hashes, single-use, compared in constant time.
- **No enumeration**: unknown email, wrong password, suspended account, passwordless account and a locked
  account all return `Invalid credentials.` after the same Argon2 work.
- **Lockout**: 10 failed attempts across _either_ factor lock the account for 15 minutes. Counting MFA failures
  matters — without it, holding the password reduces the second factor to a million guesses.
- **Sessions**: 4-hour idle, 12-hour absolute. The token is never stored; only its SHA-256 hash is. Revocation,
  suspension and a role demotion each stop an existing session at the next request.
- **Realms cannot cross**: different cookie name, audience, signing-key source, TTL and SameSite. There is no
  shared session store for a customer token to be found in.

### 18.4 Secret storage

Envelope encryption. Each secret **version** gets its own AES-256-GCM data key; that data key is wrapped by a
key-encryption key from a `KeyProvider`. The encryption context — `ref`, environment and version number — is
the AEAD additional data, so ciphertext moved to another environment or renumbered fails to decrypt rather
than silently succeeding.

- **`resolveSecret()` is the only decrypt path**, and it is server-side. No API, page or action returns a
  plaintext value.
- **There is no reveal feature** (D-32). Operators see a masked hint (last four characters), a keyed
  fingerprint for "is this the key I meant?", status and timestamps.
- **Material is immutable**: a database trigger refuses any update to ciphertext, IV, auth tag, wrapped key or
  encryption context. Rotation creates a new version and retires the old one in one transaction; a partial
  unique index makes two ACTIVE versions impossible.
- **Fails closed**: `createKeyProvider()` throws when no key material is configured, and refuses the local
  development provider entirely when `NODE_ENV=production`. The KMS provider throws honestly rather than
  pretending to work — see F-09.
- **Nothing is logged**: audit events for create, rotate, disable, enable and revoke carry the ref and the
  actor, never the value. The isolation suite searches every raw row of the database for the plaintext.

### 18.5 Telemetry

Spans are exported over OTLP when a collector is configured and are silently disabled when one is not —
telemetry is never a deployment prerequisite, and a collector outage never changes what a request returns.
Every attribute passes `sanitizeAttributes`, which drops forbidden keys outright (password, secret, token,
api key, credential, authorization, cookie, session, email, phone, dsn, connection string) and drops any value
shaped like a connection string or bearer token under any key. A failed span records the error's _name_, never
its message, because a message can carry a connection string.

### 18.6 What these claims rest on

| Claim                                                                   | Where it is proven                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Tenant role cannot read platform data                                   | `tests/isolation/platform-services.test.ts`, `platform-auth.test.ts`                |
| MFA is mandatory and a pre-MFA session is inert                         | `tests/isolation/platform-auth.test.ts`, `tests/e2e/admin-console.spec.ts`          |
| Lockout, uniform errors, session lifecycle                              | `tests/isolation/platform-auth.test.ts`                                             |
| No plaintext secret anywhere in the database                            | `tests/isolation/platform-services.test.ts`                                         |
| No secret value in any HTTP response                                    | `tests/e2e/admin-console.spec.ts`                                                   |
| Encryption fails closed when unconfigured                               | `tests/unit/secret-crypto.test.ts`                                                  |
| No credential reaches a span                                            | `tests/unit/observability.test.ts`                                                  |
| Secret Service and platform client are unreachable from tenant surfaces | `tests/unit/module-boundaries.test.ts`, `tests/unit/platform-pool-boundary.test.ts` |
| Every model is classified and protected                                 | `scripts/isolation-gate.ts`, `tests/unit/isolation-gate.test.ts`                    |

---

## 19. Independent Security Review of PR #4 — Findings and Resolutions

> **ملخّص بالعربية**
>
> مراجعة أمنية مستقلة وجدت خمسة عيوب في المرحلة 2A. جميعها أُصلحت، ولكل منها اختبار انحدار أُثبت فشله قبل
> الإصلاح ونجاحه بعده. الأهم: القفل بعد فشل التحقق بخطوتين كان قابلًا للتجاوز تمامًا، وأدوار القراءة فقط
> كانت تستطيع تدوير المفاتيح السرية.

Five defects, recorded as R-01…R-05 in `docs/DECISIONS.md` §7. CI was green when they were found:
**the tests did not cover the failing behaviour**, which is the point worth remembering.

### 19.1 R-01 — the MFA lockout did not lock

`verifyMfa()` never read `lockedUntil`. Failed MFA attempts set it; nothing consulted it. A session created
before the lock could keep submitting codes, and a **correct** code still signed in. The counter was also a
read-modify-write (`currentCount + 1`), so ten parallel attempts each read `0`, each wrote `1`, and the
threshold was never reached.

Now:

- the lock is checked at the top of `verifyMfa()`, before the vault is touched;
- reaching the threshold **revokes every pre-MFA session** for that user, so the lock is a property of the
  stored session rather than of one `if` statement. Sessions that already passed MFA are left alone — an
  attacker guessing codes must not be able to sign a real administrator out;
- the counter is one atomic `UPDATE` that computes the new value from the row's own column, so PostgreSQL
  row locking serialises concurrent attempts and no increment is lost;
- a failure to persist the counter is **audited at CRITICAL** rather than swallowed. The attempt is refused
  either way; what must never happen is rate limiting silently switching itself off;
- every MFA-step failure — wrong code, spent recovery code, locked account, revoked or expired session —
  returns the same message. The distinction lives in the audit log.

### 19.2 R-02 — read-only roles could rotate credentials

Every secret and configuration action was gated on `platform.workspace.read`, described as "View any
workspace" and held by `support_agent`, `billing_manager` and `operations_viewer`. `SecretService` checked
only that an actor existed and had verified MFA — so calling the service directly bypassed RBAC entirely.

Five permissions now separate the authorities that were conflated:

| Permission                        | Owner | Admin | Operations viewer | Support agent | Billing manager |
| --------------------------------- | ----- | ----- | ----------------- | ------------- | --------------- |
| `platform.configuration.read`     | ✅    | ✅    | ✅                | ✖             | ✖               |
| `platform.configuration.manage`   | ✅    | ✅    | ✖                 | ✖             | ✖               |
| `platform.configuration.activate` | ✅    | ✅    | ✖                 | ✖             | ✖               |
| `platform.secret.read`            | ✅    | ✅    | ✖                 | ✖             | ✖               |
| `platform.secret.manage`          | ✅    | ✅    | ✖                 | ✖             | ✖               |

Enforced at **four** layers: the page (`requirePageActor`), the server action (`requirePlatformActor`), the
service (`ConfigActor` / `SecretActor` now carry `permissionKeys` and every method asserts), and the UI, which
hides controls a role cannot use. The service layer is the one that matters — the others are convenience.

Two deliberate exceptions, both documented in the code:

- `SecretService.resolveSecret()` takes **no actor**. It is a SYSTEM path: its callers are the MFA step, which
  runs before any actor exists, and provider adapters acting on their own behalf. An operator permission there
  would be theatre and would break sign-in. What protects it is that nothing reachable from a browser can
  import `@brandspace/secrets` at all (§18, `docs/ARCHITECTURE.md` §4.1a).
- `ConfigurationService.get()` / `getContext()` take no actor. They are the runtime accessor for application
  code reading the ACTIVE payload, which contains `secretRef` strings and no values.

Denials write an audit event naming the operation and the missing permission — never the payload the caller
was trying to write.

**Existing deployments must re-run `pnpm db:seed`.** Permissions and role mappings are seeded rows; the seed
replaces a role's grants rather than merging, so a removed permission actually disappears. A data migration
was considered and rejected: `role` is under `FORCE ROW LEVEL SECURITY` with no policy naming the migrator,
so a migration cannot read it, and granting the migrator that visibility would itself be an escalation path.

### 19.3 R-03 — a recovery code could be spent twice

`findMany({ usedAt: null })`, match in memory, `update` by id. Two concurrent requests both read the same
unused row and both succeeded. Consumption is now a single conditional write:

```sql
UPDATE platform_mfa_recovery_code
   SET "usedAt" = now()
 WHERE "platformUserId" = $1 AND "codeHash" = $2 AND "usedAt" IS NULL
```

and the caller requires exactly one affected row. This replaces `timingSafeEqual` with an equality test in
the database — a deliberate trade, stated in the code: the compared value is a SHA-256 hash of a high-entropy
code, so a timing channel there reveals nothing usable, whereas losing atomicity handed an attacker a second
use of a code the owner believed was spent.

### 19.4 R-04 — a committed development password

`seed.ts` fell back to a literal value when `SEED_PLATFORM_PASSWORD` was unset. There is now no fallback:

- variable **absent** → the Platform Owner is created with `passwordHash: null`. The account exists, is
  enrolled in MFA, and cannot be signed into. No default credential is ever created;
- variable **present but weak or placeholder-shaped** → the seed fails. Somebody tried and got it wrong, and
  ignoring that would be worse than stopping;
- the rejected value is **never** printed, in any message;
- `.env.example` and `.env.test.example` document the variable with a commented placeholder that the
  validator itself rejects, so it cannot be uncommented as-is.

### 19.5 R-05 — internal errors in redirect URLs

`safeMessage()` returned `error.message`, and the result went into a query parameter — and from there into
the address bar, browser history, access logs, `Referer` headers and screenshots. `AppError.toPublicJSON()`
had always omitted `message` for exactly this reason; the redirect path had not.

Server actions now emit a **code from a closed allowlist** (`@brandspace/shared` `toPublicErrorCode`) plus an
opaque correlation id. The page renders fixed bilingual text per code; an unrecognised code falls back to the
generic message, so a hand-crafted `?error=` cannot put words on the screen. The real error is logged once,
redacted, against the same correlation id. Success messages are codes too, because the previous
`Secret "${name}" stored` reflected operator input back through the URL.

Two adjacent gaps the boundary tests exposed, both fixed (R-05a): `redact()` did not catch a connection string
with embedded credentials inside an error _message_ — only under a sensitive key name — and
`sanitizeAttributes` did not drop `error.detail`-style span attributes.

### 19.6 What proves it

| Claim                                                         | Where                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A correct TOTP code is refused while locked                   | `tests/isolation/platform-lockout.test.ts`                                 |
| Parallel attempts lose no increments                          | same file, `Promise.all` over `MAX_FAILED_ATTEMPTS`                        |
| One recovery code, one consumption                            | same file                                                                  |
| Every role's exact configuration and secret authority         | `tests/isolation/platform-rbac.test.ts` (table-driven over all five roles) |
| Direct service calls are refused without the permission       | same file                                                                  |
| The RBAC matrix itself                                        | `tests/unit/rbac-matrix.test.ts`                                           |
| The seed refuses to invent a password                         | `tests/unit/seed-password.test.ts`                                         |
| No internal error text in a redirect, the UI, a log or a span | `tests/unit/public-error.test.ts`, `tests/unit/error-boundary.test.ts`     |
