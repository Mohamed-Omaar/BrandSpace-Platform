# BrandSpace — Data Model

> **الملخص التنفيذي بالعربية**
>
> هذا المستند يعرّف **نموذج البيانات الكامل** للمنصة: الكيانات، العلاقات، الفهارس، القيود، ودورة حياة كل كيان.
>
> **المبدأ الأول:** كل جدول يخص عميلًا يحتوي على عمود `workspaceId` إلزامي، وفهرس يبدأ بهذا العمود، وسياسة أمان على مستوى الصف (RLS)
> في PostgreSQL تمنع أي تسريب بين العملاء حتى لو أخطأ الكود.
>
> **المبدأ الثاني:** السجلات المالية (رصيد الذكاء الاصطناعي، الفواتير، سجل الاستخدام) **غير قابلة للتعديل أو الحذف** — الرصيد يُحسب من دفتر
> حركات ثابت (Immutable Ledger)، وأي تصحيح يتم بحركة عكسية جديدة وليس بتعديل حركة قديمة.
>
> **المبدأ الثالث:** لا تُحذف البيانات فعليًا في الحالات الحساسة، بل تُعلَّم بـ `deletedAt` (حذف ناعم)، مع مسار حذف نهائي منفصل ومُدقَّق
> عند طلب العميل أو انتهاء مدة الاحتفاظ.
>
> يتضمن المستند مخطط علاقات (ER Diagram) يوضح البنية الكاملة، وقائمة الفهارس المطلوبة للأداء، وحالات دورة الحياة لكل كيان رئيسي.

---

## 1. Conventions

| Convention     | Rule                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Primary keys   | UUID v7 (time-ordered) — index locality without exposing sequence counts                                             |
| Timestamps     | `createdAt`, `updatedAt` (UTC, `timestamptz`); `deletedAt` where soft delete applies                                 |
| Tenant column  | `workspaceId uuid NOT NULL` on every tenant-owned table                                                              |
| Brand column   | `brandId uuid` where brand-scoped, with a constraint that the brand belongs to `workspaceId`                         |
| Actor columns  | `createdByUserId`, `updatedByUserId` where attribution matters                                                       |
| Money          | `amountMinor bigint` + `currency char(3)` — never floats                                                             |
| Credits        | `integer` in whole credits (or `bigint` in milli-credits — see DECISIONS D-14)                                       |
| Enums          | PostgreSQL enums for closed sets; text + config validation for owner-extensible sets                                 |
| Localized text | `jsonb` shaped `{"ar": "...", "en": "..."}` for content the owner edits                                              |
| Soft delete    | Applies to `Brand`, `ContentItem`, `Asset`, `Campaign`, `AutomationRule`. Never to ledgers or audit                  |
| Immutable      | `AIUsageLedger`, `CreditTransaction`, `AuditEvent`, `ConfigurationVersion`, `PublishAttempt`, `Invoice` (post-issue) |
| Indexes        | Every tenant query path has an index whose **leading column is `workspaceId`**                                       |

**Naming:** tables are singular PascalCase in Prisma, snake_case in Postgres.

---

## 2. Entity Relationship Diagram

```mermaid
erDiagram
  WORKSPACE ||--o{ MEMBERSHIP : has
  USER ||--o{ MEMBERSHIP : holds
  ROLE ||--o{ MEMBERSHIP : grants
  ROLE ||--o{ ROLE_PERMISSION : includes
  PERMISSION ||--o{ ROLE_PERMISSION : in

  WORKSPACE ||--o{ BRAND : contains
  BRAND ||--o{ BRAND_KNOWLEDGE : documents
  BRAND ||--o{ CAMPAIGN : runs
  CAMPAIGN ||--o{ CONTENT_ITEM : contains
  CONTENT_ITEM ||--o{ CONTENT_VARIANT : has
  CONTENT_ITEM ||--o{ APPROVAL : requires
  CONTENT_ITEM ||--o{ COMMENT : discussed_in
  BRAND ||--o{ ASSET : owns
  CONTENT_VARIANT }o--o{ ASSET : uses
  CONTENT_ITEM ||--o{ CALENDAR_SLOT : scheduled_in

  SOCIAL_PROVIDER ||--o{ SOCIAL_APP_CONFIGURATION : configured_by
  SOCIAL_PROVIDER ||--o{ SOCIAL_CONNECTION : type_of
  WORKSPACE ||--o{ SOCIAL_CONNECTION : owns
  BRAND ||--o{ SOCIAL_CONNECTION : assigned_to
  CALENDAR_SLOT ||--o{ PUBLISH_JOB : produces
  SOCIAL_CONNECTION ||--o{ PUBLISH_JOB : targets
  PUBLISH_JOB ||--o{ PUBLISH_ATTEMPT : logs
  PUBLISH_JOB ||--o{ METRIC_SNAPSHOT : measured_by
  SOCIAL_CONNECTION ||--o{ METRIC_SNAPSHOT : measured_by
  BRAND ||--o{ INSIGHT : explains

  AI_PROVIDER ||--o{ AI_PROVIDER_CREDENTIAL : authenticated_by
  AI_PROVIDER ||--o{ AI_MODEL : offers
  AI_MODEL ||--o{ AI_ROUTING_RULE : primary_for
  AI_ROUTING_RULE ||--o{ AI_REQUEST : routes
  AI_REQUEST ||--o{ AI_USAGE_LEDGER : records
  WORKSPACE ||--|| CREDIT_WALLET : owns
  CREDIT_WALLET ||--o{ CREDIT_TRANSACTION : ledger
  AI_USAGE_LEDGER ||--o| CREDIT_TRANSACTION : settles

  PLAN ||--o{ PLAN_ENTITLEMENT : defines
  FEATURE ||--o{ PLAN_ENTITLEMENT : referenced_by
  WORKSPACE ||--o{ WORKSPACE_OVERRIDE : customized_by
  FEATURE ||--o{ WORKSPACE_OVERRIDE : referenced_by
  PLAN ||--o{ SUBSCRIPTION : sold_as
  WORKSPACE ||--o{ SUBSCRIPTION : holds
  SUBSCRIPTION ||--o{ INVOICE : bills

  WORKSPACE ||--o{ AUTOMATION_RULE : automates
  AUTOMATION_RULE ||--o{ AUTOMATION_RUN : executes
  WORKSPACE ||--o{ NOTIFICATION : receives
  WORKSPACE ||--o{ AUDIT_EVENT : records
  CONFIGURATION_VERSION ||--o{ CONFIGURATION_VERSION : supersedes
```

---

## 3. Identity and Access

### 3.1 `User`

Global identity. **Not** tenant-owned — a user may belong to several workspaces.

| Field                                            | Type            | Notes                                                                                  |
| ------------------------------------------------ | --------------- | -------------------------------------------------------------------------------------- |
| `id`                                             | uuid            | PK                                                                                     |
| `email`                                          | citext          | unique, case-insensitive                                                               |
| `emailVerifiedAt`                                | timestamptz     | null until confirmed                                                                   |
| `passwordHash`                                   | text            | Argon2id; null for SSO-only users                                                      |
| `name`, `avatarAssetId`                          | text/uuid       |                                                                                        |
| `locale`                                         | enum(`ar`,`en`) | default from signup                                                                    |
| `timezone`                                       | text            | IANA                                                                                   |
| `mfaEnabled`, `mfaSecretRef`                     | bool/text       | secret stored via Secret Service, never inline                                         |
| `mfaSecretMaterial`, `mfaPendingSecretMaterial`  | jsonb null      | a customer's sealed TOTP seed (D-206), and the one being set up on a new phone (D-333) |
| `status`                                         | enum            | `pending`, `active`, `suspended`, `deleted`                                            |
| `lastLoginAt`, `failedLoginCount`, `lockedUntil` |                 | brute-force protection                                                                 |

Indexes: `unique(email)`, `(status)`.
Lifecycle: `pending → active → suspended → deleted` (soft, then purge after retention window).

### 3.2 `Workspace`

The isolation boundary.

| Field                                                                      | Type                         | Notes                                                                                    |
| -------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `id`, `slug`                                                               | uuid / citext unique         | slug used in URLs                                                                        |
| `name`, `legalName`, `country`, `defaultLocale`, `timezone`, `currency`    |                              |                                                                                          |
| `type`                                                                     | enum                         | `individual`, `startup`, `company`, `creator`, `agency`, `enterprise`                    |
| `status`                                                                   | enum                         | `trialing`, `active`, `past_due`, `suspended`, `cancelled`, `deleted`                    |
| `ownerUserId`                                                              | uuid                         | current Workspace Owner                                                                  |
| `parentWorkspaceId`                                                        | uuid null                    | reserved for agency grouping (no data access implication)                                |
| `dataRetentionDays`, `analyticsRetentionDays`                              | int                          | from plan, overridable                                                                   |
| `suspendedAt`, `suspendedReason`, `trialEndsAt`                            |                              |                                                                                          |
| `deletionRequestedAt`, `deletionScheduledFor`, `deletionRequestedByUserId` | timestamptz null / uuid null | the owner's deletion request and its date (D-328); both or neither (CHECK)               |
| `city`                                                                     | text null                    | an ISO 3166-2:EG governorate code, Egypt only (CHECK `workspace_city_egypt_only`, D-330) |
| `weekStartsOn`                                                             | int null                     | 0 = Sunday … 6 = Saturday (CHECK); null follows `content.calendar.weekStartsOn` (D-330)  |
| `requireMfa`                                                               | boolean, default false       | every member must have two-step verification on here (D-333)                             |

Indexes: `unique(slug)`, `(status)`, `(ownerUserId)`.

**Lifecycle**

```mermaid
stateDiagram-v2
  [*] --> Trialing
  Trialing --> Active: subscription paid
  Trialing --> Suspended: trial expired
  Active --> PastDue: payment failed
  PastDue --> Active: payment recovered
  PastDue --> Suspended: grace period elapsed
  Suspended --> Active: reactivated by admin or payment
  Active --> Cancelled: customer cancels
  Cancelled --> Deleted: after retention window
```

### 3.3 `Membership`

User ↔ Workspace with role and optional brand restriction.

| Field                                                                         | Type        | Notes                                       |
| ----------------------------------------------------------------------------- | ----------- | ------------------------------------------- |
| `id`, `workspaceId`, `userId`, `roleId`                                       | uuid        |                                             |
| `brandScope`                                                                  | uuid[] null | null = all brands; array = restricted set   |
| `status`                                                                      | enum        | `invited`, `active`, `suspended`, `removed` |
| `invitedByUserId`, `invitationTokenHash`, `invitationExpiresAt`, `acceptedAt` |             | token stored hashed only                    |

Constraints: `unique(workspaceId, userId)` where `status <> 'removed'`.
Indexes: `(workspaceId, status)`, `(userId, status)`.
Rule: **a workspace must always have at least one active Workspace Owner** — enforced by a transaction check
on role change and member removal.

### 3.4 `Role` and `Permission`

`Role`: `id`, `workspaceId` (null for system roles), `key`, `name` (localized), `scope` (`platform`|`workspace`),
`isSystem`, `description`. System roles are seeded from configuration; custom workspace roles are a
post-MVP option gated by plan.

`Permission`: `id`, `key` (e.g. `content.publish`), `resource`, `action`, `minScope`
(`platform`|`workspace`|`brand`|`campaign`), `description`.

`RolePermission`: `roleId`, `permissionId`, plus optional `constraint jsonb` (e.g. `{"ownOnly": true}`).

Indexes: `unique(role.workspaceId, role.key)`, `unique(permission.key)`, `unique(roleId, permissionId)`.

---

## 4. Brand and Content

### 4.1 `Brand`

| Field                                                                          | Notes                                                                                                                                                           |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `workspaceId`, `slug`, `name`                                            | `unique(workspaceId, slug)`                                                                                                                                     |
| `industry`, `description`, `websiteUrl`, `defaultLocale`, `supportedLocales[]` |                                                                                                                                                                 |
| `primaryGoalKey`                                                               | text null — the first goal's identifier (`LEADS`), CHECK `brand_primary_goal_key_shape`; trusted only while setup wrote `goal.primary`'s latest version (D-335) |
| `logoAssetId`, `colorPalette jsonb`, `typography jsonb`, `voiceProfile jsonb`  | brand kit                                                                                                                                                       |
| `status`                                                                       | `draft`, `active`, `archived`                                                                                                                                   |
| `deletedAt`                                                                    | soft delete                                                                                                                                                     |

Indexes: `(workspaceId, status)`, `unique(workspaceId, slug)`.

### 4.2 `BrandKnowledgeItem` and the Brand Brain tables — AS BUILT (Phase 5A)

> **This section describes what exists.** The Phase-0 sketch below it (§4.2a) is kept because
> decisions elsewhere reference it, but where the two differ the tables here are the authority.

Nine tables, every one TENANT-OWNED and additionally BRAND-SCOPED. The brand boundary is a
composite foreign key `(workspaceId, brandId)` referencing `brand(workspaceId, id)`, so a row
pointing at another workspace's brand is refused by PostgreSQL and not by a service that remembered
to check. RLS alone would admit such a row, because it would carry its own `workspaceId`.

| Table                                              | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brand`                                            | One brand in a workspace. `unique(workspaceId, slug)`, soft delete                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `brand_knowledge_item`                             | The canonical unit. `area`, `memory` (D-64), `origin` (D-65 human precedence: HUMAN, then DOCUMENT and SETUP (D-335) level, then AI_INFERRED; where the row came from, never changed by later versions), `status`, `itemKey`, localized `title`/`body`, `confidenceMilli` (NULL for human knowledge — a human statement is not a probability), provenance columns, `evidence`, `version`, `indexVector`, staleness and conflict columns. `unique(workspaceId, brandId, area, itemKey)` |
| `brand_knowledge_version`                          | APPEND-ONLY history. UPDATE and DELETE revoked from both roles, FORCE RLS leaves the owner without a policy, and a trigger refuses the operation outright — three independent layers                                                                                                                                                                                                                                                                                                   |
| `brand_source_document`                            | An uploaded source. The BYTES ARE NOT HERE: a `storageKey` points into object storage. `unique(workspaceId, brandId, checksum)` is duplicate protection by content; `unique(workspaceId, idempotencyKey)` is request replay                                                                                                                                                                                                                                                            |
| `brand_source_chunk`                               | Retrievable chunks with a human-readable `locator`, so a citation points somewhere a person can check                                                                                                                                                                                                                                                                                                                                                                                  |
| `brand_knowledge_candidate`                        | **The governance boundary.** Extraction writes here and never to `brand_knowledge_item`, so no upload can change approved knowledge on its own. The extraction is preserved even when a reviewer edits before accepting                                                                                                                                                                                                                                                                |
| `brand_ingestion_job`                              | Lifecycle, attempts and customer-safe failure text. A partial unique index keeps at most one live job per document                                                                                                                                                                                                                                                                                                                                                                     |
| `brand_brain_conversation` / `brand_brain_message` | Chat. D-78: the message row is the artifact, carries its own `expiresAt`, and the purge clears the BODY while leaving `aiRequestId` and the ledger link intact                                                                                                                                                                                                                                                                                                                         |

**Enums:** `BrandStatus`, `BrandKnowledgeArea` (ten areas), `BrandMemoryLayer` (D-64's four memories),
`BrandKnowledgeOrigin`, `BrandKnowledgeStatus`, `BrandSourceStatus`, `BrandIngestionStage`,
`BrandCandidateStatus`.

**Retrieval index.** `indexVector Float[]` holds a deterministic local vector, not a vendor
embedding: D-13 deferred provider selection, and `embeddingModelKey` is recorded so re-indexing on a
change is detectable. A pgvector column and an ANN index replace it behind the same interface once a
provider is approved.

**Foreign keys BETWEEN these tables are composite with `workspaceId` too** (D-112, F-80, F-83), for
the reason §4.6 gives about the Asset Library: PostgreSQL evaluates referential integrity with RLS
BYPASSED, so a plain parent id is an existence oracle over the whole platform. Phase 5A shipped
**eight** plain ones and all eight were confirmed exploitable:

| Key                                          | Now references                             | `ON DELETE`                        |
| -------------------------------------------- | ------------------------------------------ | ---------------------------------- |
| `brand_source_chunk.sourceDocumentId`        | `brand_source_document(workspaceId,id)`    | `CASCADE`                          |
| `brand_ingestion_job.sourceDocumentId`       | `brand_source_document(workspaceId,id)`    | `CASCADE`                          |
| `brand_brain_message.conversationId`         | `brand_brain_conversation(workspaceId,id)` | `CASCADE`                          |
| `brand_knowledge_candidate.sourceDocumentId` | `brand_source_document(workspaceId,id)`    | `CASCADE`                          |
| `brand_knowledge_candidate.targetItemId`     | `brand_knowledge_item(workspaceId,id)`     | `SET NULL ("targetItemId")`        |
| `brand_knowledge_item.sourceDocumentId`      | `brand_source_document(workspaceId,id)`    | `SET NULL ("sourceDocumentId")`    |
| `brand_knowledge_item.conflictsWithItemId`   | `brand_knowledge_item(workspaceId,id)`     | `SET NULL ("conflictsWithItemId")` |
| `brand_knowledge_version.knowledgeItemId`    | `brand_knowledge_item(workspaceId,id)`     | `CASCADE`                          |

The first three are F-80; the rest are F-83, found by asking the catalogue about the whole module
rather than the four tables F-80 happened to name. `brand_source_document`,
`brand_brain_conversation` and `brand_knowledge_item` each carry the `@@unique([workspaceId, id])`
those keys reference. Every referential action is unchanged from Phase 5A.

**A composite `ON DELETE SET NULL` names its column** (D-114). PostgreSQL nulls EVERY referencing
column of a key, so a bare `SET NULL` on `(workspaceId, targetItemId)` would null `workspaceId` —
which is `NOT NULL`, so the parent delete would FAIL rather than null the reference. The column list
restricts it to the one nullable reference, and `pg_constraint.confdelsetcols` is what the isolation
suite asserts. Prisma cannot express the list and warns about these three relations; the migration is
hand-written for exactly that reason, and a migrations-only database still shows no drift.

**A migration that validates tenant data must lift FORCE RLS to see it** (D-113). Migrations run as
the table owner, `brandspace_migrator`, which no policy on these tables names; under FORCE RLS the
owner therefore reads nothing, and `ADD CONSTRAINT FOREIGN KEY` will validate against an empty set
and still mark the constraint valid. The migration lifts FORCE inside its own transaction — under the
ACCESS EXCLUSIVE lock `ALTER TABLE` already holds, so no other session can observe it — and refuses
to commit unless all eight tables are ENABLED and FORCED again.

**An item with recorded history cannot be deleted at all**, and that is Phase 5A behaviour the
composite key preserved rather than introduced: `brand_knowledge_version.knowledgeItemId` cascades,
and the cascade reaches the append-only trigger, which refuses the DELETE and takes the statement
with it.

Migrations: `20260913140000_phase_5_brand_brain`,
`20260914200000_f80_brand_brain_composite_foreign_keys`. Isolation coverage:
`tests/isolation/phase5-tenancy.test.ts` (41 tests),
`tests/isolation/f80-brand-brain-composite-keys.test.ts` (38 tests) and
`tests/isolation/f80-migration-upgrade.test.ts` (15 tests).

### 4.2a `BrandKnowledge` — the original Phase 0 sketch

Structured brand facts and uploaded documents, chunked and embedded for retrieval.

| Field                                            | Notes                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `workspaceId`, `brandId`                   |                                                                                                                                    |
| `type`                                           | `identity`, `audience`, `tone`, `offer`, `proof`, `objection`, `rule_do`, `rule_dont`, `glossary`, `competitor`, `faq`, `document` |
| `title`, `content jsonb`                         | localized `{ar, en}`                                                                                                               |
| `sourceAssetId`                                  | for uploaded documents                                                                                                             |
| `chunkIndex`, `chunkText`, `embedding vector(N)` | one row per chunk for `document` type                                                                                              |
| `embeddingModelKey`, `embeddedAt`                | so re-embedding on model change is detectable                                                                                      |
| `status`                                         | `draft`, `active`, `stale`, `archived`                                                                                             |
| `version`                                        | incremented on edit; retrieval cites version                                                                                       |

Indexes: `(workspaceId, brandId, type)`, `(workspaceId, brandId, status)`,
HNSW/IVFFlat on `embedding` **partitioned or filtered by `workspaceId`** so ANN search never scans other tenants.

### 4.2b The Asset Library tables — AS BUILT (Phase 5B-1)

Six tables. Every one is TENANT-OWNED; five are additionally BRAND-SCOPED, and the sixth — `Asset`
itself — is brand-scoped **optionally**, because a workspace-level file that every brand shares is a
real shape and not a degenerate one (D-101).

| Table                  | What it holds                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `asset_folder`         | A named folder, nesting through a self-reference. `parentId` is composite, so a folder cannot be adopted by another workspace's tree. Depth is bounded by activated configuration, checked in the service. `unique(workspaceId, brandId, parentId, name)` over live rows                   |
| `asset`                | One logical file. The BYTES ARE NOT HERE — a `storageKey` points into the object store, exactly as `brand_source_document` does. Carries `kind`, `status`, `scanStatus`, `sizeBytes`, `checksumSha256`, `originalFilename` (normalised), provenance and soft delete. `brandId` is nullable |
| `asset_version`        | APPEND-ONLY history, one row per uploaded revision. Three independent layers hold the invariant (D-102)                                                                                                                                                                                    |
| `asset_derivative`     | A generated rendition — thumbnail, preview — with its own key, bounds and kind. The MODEL is complete; no encoder produces bytes yet (D-107)                                                                                                                                               |
| `asset_upload_session` | The reserve-then-commit record for one upload. Holds the declared size and type, the issued grant, an `idempotencyKey` and an expiry. `unique(workspaceId, idempotencyKey)` makes a replayed completion return the first result rather than a second asset                                 |
| `asset_processing_job` | Lifecycle, attempts, stage and customer-safe failure text — the same shape `brand_ingestion_job` uses, so the reconciliation sweep reasons about both the same way. A partial unique index keeps at most one live job per asset                                                            |

**Enums:** `AssetKind`, `AssetSource`, `AssetScanStatus`, `AssetStatus`, `AssetDerivativeKind`,
`AssetUploadSessionStatus`, `AssetProcessingStage`.

**Every intra-library foreign key is composite with `workspaceId` (D-99, generalised to the whole
platform as D-112), and this is not belt-and-braces.**
PostgreSQL evaluates referential integrity with RLS BYPASSED. A plain `folderId` column would therefore
accept another workspace's folder id — and even where it did not, the difference between "inserted" and
"constraint violated" answers the question _does this id exist in some workspace?_, which is exactly the
inference §2.1 of `CLAUDE.md` forbids. Composite keys make the referenced row invisible rather than
merely unusable. Each parent carries the `@@unique([workspaceId, id])` the child references.

**Duplicate protection is a partial unique index over live rows** (D-100):
`(workspaceId, checksumSha256) WHERE "deletedAt" IS NULL`. Content identity, not filename identity —
and scoped to what is still there, so archiving a file does not permanently poison its checksum.

**`asset_version` is append-only in three layers** (D-102), because one is a single mistake away from
being none:

1. `UPDATE` and `DELETE` are revoked from both application roles — except a column-level
   `GRANT UPDATE ("scanStatus")`, which is the one field the scanner writes after the row exists.
2. FORCE RLS is on and the owner has no policy, so even the table owner cannot rewrite history.
3. A trigger compares every immutable column field by field and raises if any of them moved, so the
   narrow column grant cannot be used as a doorway.

Migration: `20260914120000_phase_5b_asset_library`. Isolation coverage:
`tests/isolation/phase5b-asset-tenancy.test.ts` (42 tests) and
`tests/isolation/assets-lifecycle.test.ts` (51 tests).

### 4.3 `Campaign`

`id`, `workspaceId`, `brandId`, `name`, `objective`, `description`, `startDate`, `endDate`,
`channels text[]`, `budgetMinor`, `currency`, `kpis jsonb`, `strategyInsightId`, `ownerUserId`,
`status` (`draft`, `planned`, `active`, `paused`, `completed`, `archived`), `deletedAt`.

Indexes: `(workspaceId, brandId, status)`, `(workspaceId, startDate, endDate)`.

### 4.4 `ContentItem`

The canonical content object (channel-agnostic).

| Field                                                                                | Notes                                    |
| ------------------------------------------------------------------------------------ | ---------------------------------------- |
| `id`, `workspaceId`, `brandId`, `campaignId` (null)                                  |                                          |
| `title`, `contentType` (`post`,`carousel`,`story`,`reel`,`video`,`article`,`thread`) |                                          |
| `primaryLocale`, `pillar`, `tags text[]`                                             |                                          |
| `status`                                                                             | see lifecycle below                      |
| `createdByUserId`, `aiRequestId` (null)                                              | provenance: which AI request produced it |
| `approvalRequired bool`, `currentApprovalId`                                         |                                          |
| `deletedAt`                                                                          |                                          |

**Lifecycle**

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> InReview: submit
  InReview --> ChangesRequested: reviewer rejects
  ChangesRequested --> InReview: resubmit
  InReview --> Approved: approver approves
  Approved --> Scheduled: placed on calendar
  Scheduled --> Publishing: job picked up
  Publishing --> Published: all targets succeeded
  Publishing --> PartiallyPublished: some targets failed
  Publishing --> Failed: all targets failed
  PartiallyPublished --> Publishing: retry failed targets
  Failed --> Scheduled: rescheduled
  Approved --> Archived
  Published --> Archived
```

Indexes: `(workspaceId, brandId, status)`, `(workspaceId, campaignId)`, `(workspaceId, brandId, createdAt desc)`.

### 4.5 `ContentVariant`

Per-platform, per-locale rendering of a content item.

`id`, `workspaceId`, `contentItemId`, `platformKey`, `locale`, `body text`, `hashtags text[]`,
`mentions text[]`, `linkUrl`, `firstComment`, `assetIds uuid[]`, `platformOptions jsonb`
(e.g. IG carousel order, YT title/description/category), `validationState`
(`unvalidated`, `valid`, `warnings`, `invalid`), `validationErrors jsonb`, `characterCount`,
`aiRequestId`.

Constraints: `unique(contentItemId, platformKey, locale)`.
Indexes: `(workspaceId, contentItemId)`.

### 4.4b The AI Content Studio tables — AS BUILT (Phase 5B-2)

§4.4 and §4.5 above are the DESIGN. This is what the migration
`20260915090000_phase_5b_2_ai_content_studio` actually created, which is narrower in two ways
and wider in three.

**NARROWER.** `campaignId`, `pillar`, `approvalRequired` and `currentApprovalId` are **not**
created: campaigns belong to the Social Calendar and approvals to the Approvals module, and a
column with no writer is a column whose meaning nobody has settled. `CalendarSlot`, `Approval`
and `Comment` are likewise untouched. The lifecycle diagram above stands as the design; Phase
5B-2 reaches **`DRAFT`, `IN_REVIEW` and `ARCHIVED` only**, and `ContentStudioService.transition`
refuses every other target rather than half-implementing the next phase's states.

**WIDER**, in three columns the design predates:

| Column                                     | Table                          | Why                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arabicDialect`                            | both, and `workspace`, `brand` | D-115. The dialect a draft was WRITTEN IN, recorded on the row — because the configured default can change and a draft must still be able to say what it actually is |
| `citations jsonb`, `insufficientKnowledge` | `content_item`                 | AC-11.4 and the free-refusal path: what retrieval returned, and whether it returned enough. Written from RETRIEVAL, never from the model's own text                  |
| `expiresAt`, `bodyPurgedAt`                | both                           | D-116 and D-117. When this content may be purged, and when its body actually was — so a purged draft is visibly purged rather than silently blank                    |

**Tenancy.** Both tables carry `workspaceId`, both have RLS `ENABLED` and `FORCED`, and **every
foreign key to a tenant-owned parent is composite** — `content_item_brand_fkey` on
`(workspaceId, brandId)` and `content_variant_item_fkey` on `(workspaceId, contentItemId)`.
D-112 made that the platform rule after F-80 and F-83; these are the first keys written under it,
and `tests/isolation/phase5b2-content-tenancy.test.ts` asserts the refusal from inside the
attacker's OWN workspace, which is the case RLS does not cover.

**`content_item` constraints and indexes.** `unique(workspaceId, id)` (the composite-FK parent
scope), `unique(workspaceId, idempotencyKey)` (AC-11.2 — a retried generation returns the first
draft rather than billing twice), and indexes on `(workspaceId, brandId, status)`,
`(workspaceId, brandId, updatedAt desc)` and `(expiresAt)` for the purge sweep.

**`content_variant` constraints and indexes.** `unique(contentItemId, platformKey, locale)` as
designed, plus `(workspaceId, contentItemId)` and `(expiresAt)`.

**`assetIds uuid[]` carries no foreign key, and cannot.** PostgreSQL has no array element
reference, so the array is validated in the service rather than by the database. Recorded here
rather than left to be discovered: it is the one place in these tables where referential
integrity is the application's job, and a reader should not have to infer that from its absence.

**PHASE 8 NAMES WHERE THAT JOB IS DONE (D-199).** `publishableAssetWhere()` in
`packages/assets/src/publishable.ts` IS the tenant boundary for this column, and there is exactly
one of it: the Content Studio applies it when an author attaches a picture and the publish pipeline
applies it again just before a payload reaches a provider. Two implementations would mean one of
them admitting what the other refuses — a post that can never go out, or a refusal that is theatre.
Admissible means this workspace, this brand OR the workspace-shared shelf (`brandId IS NULL`),
inside the caller's BrandScope as a query predicate (D-132), `READY` and `CLEAN`, and of a kind a
post can carry. The scope clause is deliberately not the ordinary one: restricting `brandId` to the
scope would hide the shared shelf, which a scoped member must still be able to use.

**`workspace.aiContentRetentionDays`** is the D-117 control. `NULL` means "follow the
subscription" (D-116); a value means the customer asked for something shorter. It is bounded by
the CHECK `workspace_ai_content_retention_days_positive` (`> 0`), so "delete on write" is not
expressible even through a crafted request, and floored at write time by
`content.retention.minCustomerRetentionDays`. It can only ever SHORTEN the window — a large value
does not extend a cancelled account's grace period past what the owner approved.

### 4.6 `Asset`

`id`, `workspaceId`, `brandId` (null = workspace-level), `folderId`, `name`, `kind`
(`image`,`video`,`audio`,`document`,`font`), `mimeType`, `sizeBytes`, `width`, `height`,
`durationMs`, `storageKey`, `checksumSha256`, `derivatives jsonb`, `source`
(`upload`,`ai_generated`,`imported`), `aiRequestId`, `license`, `rightsExpiryAt`, `tags text[]`,
`scanStatus` (`pending`,`clean`,`infected`,`failed`), `status`
(`uploading`,`processing`,`ready`,`processing_failed`,`quarantined`,`archived`), `version`,
`replacesAssetId`, `deletedAt`.

Indexes: `(workspaceId, brandId, status)`, `(workspaceId, kind)`, `(workspaceId, checksumSha256)` for dedupe,
GIN on `tags`.
Rule: an asset is usable only when `status='ready' AND scanStatus='clean'`.

### 4.7 `CalendarSlot`

`id`, `workspaceId`, `brandId`, `contentItemId`, `socialConnectionIds uuid[]`,
`scheduledAtUtc timestamptz`, `scheduledLocalTime`, `timezone`, `recurrenceRule` (null),
`status` (`planned`,`scheduled`,`locked`,`publishing`,`published`,`failed`,`cancelled`),
`lockedAt`, `lockedBy`, `publishJobIds uuid[]`.

Indexes: `(workspaceId, brandId, scheduledAtUtc)`, `(status, scheduledAtUtc)` for the due-slot sweeper.
Constraint: a slot may not enter `scheduled` if its content item requires approval and is not `Approved`.

### 4.7b The Content Calendar table — AS BUILT (Phase 5B-2)

§4.7 above is the DESIGN. This is what the migration
`20260915120000_phase_5b_2_content_calendar` actually created, which is narrower in three ways
and wider in three.

**NARROWER.** `socialConnectionIds`, `publishJobIds`, `recurrenceRule`, `lockedAt` and `lockedBy`
are **not** created: every one of them belongs to the publishing pipeline, and the pipeline is
Phase 6. `status` likewise carries `PLANNED`, `SCHEDULED` and `CANCELLED` only — `LOCKED`,
`PUBLISHING`, `PUBLISHED` and `FAILED` are states no code in this phase can enter, and a state
nothing can reach is a state whose meaning nobody has settled.

**WIDER**, in three columns the design predates:

| Column                | Why                                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `targetKind`          | AC-14.7. The publishing target is a MOCK, said in the data rather than only in a comment. Phase 6 adds real connection targets beside it; until then nothing in the system can name one |
| `platformKeys`        | Derived from the item's variants when the slot is created, so a slot still renders its channels after a variant is edited. A calendar is a plan, and a plan records what was planned    |
| `usageIdempotencyKey` | AC-14.5. The quota event this slot consumed, so cancelling refunds exactly what scheduling took and a retry cannot double-count                                                         |

**THE SLOT IS THE _WHEN_; `ContentItem` REMAINS THE SOURCE OF TRUTH FOR THE WHAT AND THE STATE.**
There is no caption, no status copy and no channel list here that `content_item` already answers.
`ContentCalendarService.schedule()` moves the item to `SCHEDULED` in the same transaction as the
slot write and `cancel()` moves it back, so the two can never disagree about whether something is
on the calendar — and `ContentLibraryService.transition()` refuses to move a `SCHEDULED` item at
all, so it cannot be archived out from under a live slot.

**THREE TIME COLUMNS, AND WHY ONE IS NOT ENOUGH (AC-14.2, AC-14.3).** A timestamp cannot answer
"what time did the customer MEAN?" across a daylight-saving boundary: 09:00 local converted to UTC
in January and read back in July is 08:00 or 10:00, and neither is what anyone asked for. So the
INTENT (`scheduledLocalTime` + `timezone`) is stored beside the INSTANT (`scheduledAtUtc`), and the
instant is derived from the intent. `scheduledLocalTime` is TEXT rather than a timestamp
deliberately — it is a wall-clock with no offset, and giving it one would invent the very fact the
column exists to preserve. `timezone` is COPIED from the workspace rather than joined, because a
workspace that relocates must not silently move every post it has already scheduled.

**Tenancy.** `workspaceId`, RLS `ENABLED` and `FORCED`, and **both foreign keys to a tenant-owned
parent composite** — `calendar_slot_brand_fkey` on `(workspaceId, brandId)` and
`calendar_slot_item_fkey` on `(workspaceId, contentItemId)`. The second is exactly F-80 and F-83's
shape, and `tests/isolation/phase5b2-calendar-tenancy.test.ts` asserts the refusal from inside the
attacker's OWN workspace — the case RLS does not cover — and that a real foreign draft id and a
fabricated one fail identically.

**Constraints.** `calendar_slot_local_time_shape` (`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$`) keeps the
intent recomputable; `calendar_slot_cancelled_consistently` keeps `status` and `cancelledAt` from
disagreeing; and `calendar_slot_one_live_per_item` is a PARTIAL unique index on
`(workspaceId, contentItemId) WHERE status <> 'CANCELLED'` — partial because a full one would mean
a draft taken off the calendar could never be put back, the same shape D-100 settled for the asset
checksum.

**Indexes.** `(workspaceId, scheduledAtUtc)` and `(workspaceId, brandId, scheduledAtUtc)` for the
month and week ranges, `(workspaceId, contentItemId)` for the item's own lookup, and
`(status, scheduledAtUtc)` for the due-slot sweep Phase 6 will add.

### 4.8 `Approval` and `Comment`

`Approval`: `id`, `workspaceId`, `subjectType` (`content_item`,`campaign`,`asset`), `subjectId`,
`requestedByUserId`, `assignedToUserId`/`assignedToRoleId`, `status`
(`pending`,`approved`,`rejected`,`cancelled`,`expired`), `decidedByUserId`, `decidedAt`, `note`,
`dueAt`, `stepIndex`, `policySnapshot jsonb` (the approval rules in force at request time).

`Comment`: `id`, `workspaceId`, `subjectType`, `subjectId`, `parentCommentId`, `authorUserId`,
`body`, `mentions uuid[]`, `anchor jsonb` (position in text or region on an image),
`resolvedAt`, `resolvedByUserId`, `deletedAt`.

Indexes: `(workspaceId, subjectType, subjectId)`, `(workspaceId, assignedToUserId, status)`.

### 4.8b The Approvals tables — AS BUILT (Phase 5B-3)

§4.8 above is the DESIGN. This is what the migration
`20260915180000_phase_5b_3_approvals_activity_notifications` actually created.

**`approval` — NARROWER than §4.8 in three ways.**

`assignedToRoleId`, `dueAt` and `stepIndex` are **not** created. Assignment to a ROLE, review
deadlines and multi-step chains are a workflow builder, and this milestone builds a single-step
review. A column with no writer is a column whose meaning nobody has settled — the same rule §4.4b
applied to `campaignId`. `subjectType` carries `CONTENT_ITEM`, `CAMPAIGN` and `ASSET` because the
design names all three, but only `CONTENT_ITEM` is reachable: the others have no service behind
them, and `contentItemId` is a real typed column rather than a polymorphic id precisely so the
composite foreign key D-112 requires can exist at all.

**WIDER**, in three columns the design predates:

| Column        | Why                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brandId`     | Every approval is brand-scoped, and the composite key to `brand(workspaceId, id)` is what makes the BRAND boundary a database fact rather than a service convention |
| `requestNote` | §4.8 has one `note`. A requester's context and a reviewer's verdict are different statements by different people and are kept apart, so the history can show both   |
| `cycle`       | Which round of review this is, from 1. Makes the history orderable without depending on clock resolution, and gives the policy ceiling something to count           |

**Constraints that encode the rules.** `approval_subject_present` — a `CONTENT_ITEM` approval must
name its item. `approval_decision_consistent` — a decided row carries both its decider and its
timestamp, and a pending one carries neither, so half a decision is not a state the history can
render. `approval_one_open_per_item`, a PARTIAL unique index on `status = 'PENDING'` — two open
reviews for one draft is two reviewers each believing their verdict decided it, and a full unique
index would stop a closed cycle ever being followed by another.

**`approval_policy` — the per-brand rules** (ROADMAP Phase 5 scope item 6, "policy per brand").
Every column is NULLABLE and **NULL means "no opinion"**, resolving to the activated
`content.approvals` default. A row exists only once somebody has deliberately departed from the
defaults, so changing a default still reaches every brand that never chose otherwise. One row per
brand, by unique index.

### 4.8c Approval integrity — the corrective pass (Phase 5B-3, D-128)

`20260915210000_phase_5b_3_approval_integrity` narrows what
`20260915180000` granted, because that migration's grants did not match its own
comment: §9 said `notification` was "the only one of the three the application
may DELETE" and then granted DELETE on all three.

|                                                                              |                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DELETE revoked** from `brandspace_app` on `approval` and `approval_policy` | An approval is the record that somebody reviewed something. A policy row is reset by setting its columns back to NULL — "no opinion", which is what an absent row means — so DELETE buys nothing there either, and `updatedByUserId` is worth keeping. The PLATFORM role keeps DELETE for tenant offboarding and the D-116 purge |
| **`approval_write_once`**, a `BEFORE UPDATE` trigger                         | A decided or withdrawn cycle never changes again, and a cycle's IDENTITY — `subjectType`, `contentItemId`, `requestedByUserId`, `cycle`, `createdAt`, `policySnapshot` — never changes at all. The legitimate `PENDING` → terminal transition is untouched, which is the whole workflow                                          |

A trigger rather than a CHECK because the rule is about the TRANSITION — old row
versus new row — and a CHECK sees only the new one. Test fixtures clean up as
the PLATFORM role rather than the production grant being widened to suit them.

### 4.8d `approvedFingerprint` — what the verdict was granted over (Phase 2, D-223)

`20260921090000_approval_content_fingerprint` adds one nullable JSONB column to
`approval`. It holds `{ item, variants: { [variantId]: hash } }`, computed from
the variants as they stood at the moment of approval and written inside the same
row lock that records the verdict.

**It exists because an approval recorded a decision and nothing about the
words.** A `SCHEDULED` item is deliberately not returned to `DRAFT` by an edit —
the calendar owns that edge — so a caption changed after scheduling published
under a verdict granted to different text. The publish preflight now recomputes
the same hash from the variant it is about to send and refuses on a mismatch.

**NULLABLE AND NOT BACKFILLED, on purpose.** An approval granted before this
migration cannot prove what it covered, and deriving a fingerprint from today's
rows would certify precisely the edit the column exists to catch. The comparison
FAILS CLOSED on a null, so those approvals must be re-granted rather than
trusted.

The column is written by the same `UPDATE` that decides the cycle, so
`approval_write_once` (§4.8c) governs it unchanged: a decided cycle's
fingerprint never changes again — which is also why a test that needs a
pre-migration approval INSERTS one rather than clearing an existing row.

**BOTH HALVES OF THE VALUE ARE ENFORCED (D-230).** `item` is a hash over the
whole variant set and changes when one is added or removed; `variants[id]` is
one row's own. The publish preflight compares BOTH, reading every variant of
the item rather than only the one being sent — a check against a single row
would pass while a channel the reviewer never saw went out beside it.

### 4.8e `social_connection.analyticsCursorsEnsuredAt` (Phase 2, D-229)

`20260921120000_social_connection_cursor_sweep_rotation` adds one nullable
`TIMESTAMPTZ` to `social_connection`, plus an index on
`("status", "analyticsCursorsEnsuredAt")`.

It exists because the analytics sweep enumerated ACTIVE connections with **no
cursor at all**, which repairs "never provisioned" and nothing else: a
connection holding a partial cursor set stopped matching and was skipped for
ever. Dropping the filter alone would starve everything past `take: batch`
(D-182), so the sweep now rotates over a durable cursor — `ASC NULLS FIRST`,
parked to `now` inside the tenant's own transaction after a successful pass.

**NULLABLE AND NOT BACKFILLED**, deliberately: NULL means "never ensured" and
sorts first, so every connection that exists today is at the front of the queue
on the first tick after the migration. A backfill would say they had all just
been checked.

**IT IS NOT INGESTION STATE.** Cursor progress, retry backoff and freshness
live on `analytics_ingestion_cursor` and are written only by ingestion; the
ensure statement remains `ON CONFLICT DO NOTHING` and cannot reset an existing
row.

### 9.3b The `notification` table — AS BUILT (Phase 5B-3)

§9.3 above is the DESIGN. Three differences, each with a reason.

**`userId` IS NOT NULL.** §9.3 allows NULL for "workspace-wide". A workspace-wide row has no
per-reader unread state, which is the single thing this table exists to hold; fan-out to several
members is several rows, each independently readable and independently marked.

**NO RENDERED TEXT.** `renderedSubject` and `renderedBodyRef` are not created. The row carries a
`templateKey` and a payload, and the reader's locale picks the sentence at READ time — storing one
language would make a bilingual workspace's inbox monolingual in whichever language the actor
happened to be using.

**NO DELIVERY COLUMNS.** `status`, `sentAt`, `providerMessageId`, `failureCode`, `priority` and
`groupKey` are not created, and a CHECK pins `channel` to `IN_APP` (D-123). There is no transport in
this platform to deliver with; a delivery status on a row nothing delivers would be a fiction, and
the CHECK is what makes the limitation a fact rather than a convention.

**WIDER** in `linkPath`, `brandId`, `resourceType` and `resourceId` — where the notification points.
`notification_link_is_relative` refuses anything that is not a relative path, so a row can never
carry an absolute redirect target written by one tenant and followed by another's browser.

### 9.3c The `notification_preference` table — prototype v94 Phase 2B-1 (D-331)

| Field                               | Type        | Notes                                                                                                     |
| ----------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| `workspaceId`, `userId`, `category` | uuid / text | unique together; `category` is CHECKed to `approvals`, `publishing`, `automations`, `brand_brain_reviews` |
| `enabled`                           | boolean     | only "off" needs a row: NO ROW MEANS ON                                                                   |

Tenant-owned: ENABLE + FORCE RLS with `tenant_isolation` / `platform_access`, FKs to `workspace` and
`user` (both CASCADE). Read by `NotificationService.create`, which leaves out a recipient who switched
the template's category off; workspace notices belong to no category and are always written.

### The Activity Log adds NO TABLE (Phase 5B-3, D-124)

`docs/PRODUCT.md` §5 module 17 lists `AuditEvent` as the Activity Log's entity, and that is exactly
what it reads. There is no customer-facing event table: a second record of the same facts would
drift from the first at the earliest writer that updated one and forgot the other, and it would be a
MUTABLE one — which is what AC-15.7 and the append-only trigger on `audit_event` exist to prevent.
The customer screen is a scoped, paged projection that returns actor, action, resource and outcome,
and never the `before`/`after` diffs.

---

## 5. Social

### 5.1 `SocialProvider` (configuration-backed registry)

`id`, `key` (`facebook`,`instagram`,`tiktok`,`linkedin`,`youtube`,`x`,…), `name`, `status`
(`available`,`beta`,`disabled`), `capabilities jsonb` (publish kinds, media limits, character limits,
scheduling support, analytics support), `authType` (`oauth2`), `requiredScopes text[]`,
`apiVersion`, `docsUrl`. **Platform-level, not tenant-owned.**

### 5.2 `SocialAppConfiguration`

The BrandSpace-owned application credentials per provider per environment.

`id`, `providerId`, `environment` (`development`,`staging`,`production`), `appId`,
`clientIdRef secretRef`, `clientSecretRef secretRef`, `redirectUri`, `scopes text[]`,
`webhookSecretRef`, `status` (`draft`,`validated`,`active`,`disabled`),
`lastValidatedAt`, `lastHealthAt`, `healthStatus`, `createdByPlatformUserId`, `rotatedAt`.

Constraint: `unique(providerId, environment)` where `status='active'`. **No secret values stored here** —
only references resolved by the Secret Service.

### 5.3 `SocialConnection` (tenant-owned)

A customer's connected account.

| Field                                                                                                          | Notes                                                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `id`, `workspaceId`, `brandId` (null = workspace-level), `providerId`                                          |                                                                                   |
| `externalAccountId`, `externalAccountName`, `accountType` (`page`,`profile`,`business`,`channel`), `avatarUrl` |                                                                                   |
| `accessTokenRef`, `refreshTokenRef`                                                                            | encrypted via Secret Service; **never returned by API**                           |
| `tokenExpiresAt`, `refreshExpiresAt`, `scopesGranted text[]`, `scopesMissing text[]`                           |                                                                                   |
| `status`                                                                                                       | `connecting`, `active`, `needs_reauth`, `expired`, `revoked`, `disabled`, `error` |
| `healthStatus`, `lastHealthCheckAt`, `lastErrorCode`, `lastErrorAt`, `consecutiveFailures`                     |                                                                                   |
| `connectedByUserId`, `connectedAt`, `disconnectedAt`, `disconnectedByUserId`                                   |                                                                                   |
| `rateLimitState jsonb`                                                                                         | provider-reported quota state                                                     |

Constraints: `unique(workspaceId, providerId, externalAccountId)` where not revoked.
Indexes: `(workspaceId, status)`, `(status, tokenExpiresAt)` for proactive refresh.

**Lifecycle**

```mermaid
stateDiagram-v2
  [*] --> Connecting
  Connecting --> Active: OAuth callback verified
  Connecting --> Error: callback failed
  Active --> NeedsReauth: scope removed or refresh failed
  Active --> Expired: token expiry passed
  NeedsReauth --> Active: customer reconnects
  Expired --> Active: refresh succeeded
  Active --> Revoked: revoked at provider or by customer
  Active --> Disabled: disabled by admin or plan downgrade
  Revoked --> [*]
```

### 5.4 `PublishJob` and `PublishAttempt`

`PublishJob`: `id`, `workspaceId`, `brandId`, `contentItemId`, `contentVariantId`,
`calendarSlotId`, `socialConnectionId`, `providerId`, `idempotencyKey` (unique),
`scheduledAtUtc`, `status` (`queued`,`processing`,`succeeded`,`failed`,`cancelled`,`dead_letter`),
`attemptCount`, `nextAttemptAt`, `externalPostId`, `externalPostUrl`,
`failureCode`, `failureMessage`, `requiresConfirmation bool`, `confirmedByUserId`, `confirmedAt`.

Constraints: `unique(idempotencyKey)`; `unique(contentVariantId, socialConnectionId, calendarSlotId)`
prevents accidental double-scheduling.
Indexes: `(workspaceId, status)`, `(status, nextAttemptAt)`, `(workspaceId, brandId, scheduledAtUtc)`.

`PublishAttempt` (immutable): `id`, `workspaceId`, `publishJobId`, `attemptNumber`, `startedAt`,
`finishedAt`, `outcome` (`success`,`retryable_error`,`permanent_error`,`timeout`),
`httpStatus`, `providerErrorCode`, `providerResponse jsonb` (**redacted of tokens**),
`requestFingerprint`, `durationMs`.

Indexes: `(workspaceId, publishJobId, attemptNumber)`.

### 5.5 `MetricSnapshot` and `Insight`

`MetricSnapshot`: `id`, `workspaceId`, `brandId`, `providerId`, `socialConnectionId`,
`subjectType` (`post`,`account`), `subjectExternalId`, `publishJobId` (null),
`periodStart`, `periodEnd`, `granularity` (`hour`,`day`,`week`,`month`,`lifetime`),
`metrics jsonb` (impressions, reach, engagement, clicks, saves, shares, views, watchTime, followers…),
`currency` (for spend, future), `collectedAt`, `sourceVersion`.

Constraints: `unique(workspaceId, socialConnectionId, subjectExternalId, granularity, periodStart)`
— makes ingestion idempotent via upsert.
Indexes: `(workspaceId, brandId, periodStart desc)`, `(workspaceId, publishJobId)`.
Retention: pruned per `Workspace.analyticsRetentionDays`.

`Insight`: `id`, `workspaceId`, `brandId`, `type` (`strategy`,`analytics_explanation`,`recommendation`,
`trend`,`content_gap`,`anomaly`), `title`, `body jsonb` (localized), `evidence jsonb`
(metric refs, content refs, Brand Brain citations), `periodStart`, `periodEnd`,
`aiRequestId`, `confidence`, `status` (`new`,`seen`,`accepted`,`dismissed`), `expiresAt`.

Indexes: `(workspaceId, brandId, type, createdAt desc)`.

---

## 6. AI

### 6.1 `AIProvider`

`id`, `key` (`openai`,`anthropic`,`google`,`mock`,…), `name`, `baseUrl`, `authScheme`,
`status` (`draft`,`validated`,`active`,`disabled`), `defaultTimeoutMs`, `maxConcurrency`,
`rateLimitConfig jsonb`, `healthStatus`, `lastHealthCheckAt`, `notes`. **Platform-level.**

### 6.2 `AIProviderCredential`

`id`, `providerId`, `environment`, `label`, `secretRef`, `maskedHint` (e.g. `…a91f`),
`fingerprint` (hash for equality checks without the value), `status`
(`active`,`rotating`,`disabled`,`revoked`), `createdByPlatformUserId`, `activatedAt`,
`lastRotatedAt`, `lastUsedAt`, `expiresAt`, `scopeNotes`.

**The credential value is never a column.** Only `secretRef` is stored; resolution happens server-side.
Constraint: at most one `active` credential per `(providerId, environment)` unless rotation is in progress.

### 6.3 `AIModel`

`id`, `providerId`, `key` (provider's model id), `displayName`,
`modality` (`text`,`image`,`video`,`voice`,`embedding`,`moderation`),
`capabilities jsonb` (context window, max output, streaming, tools, JSON mode, languages, image sizes),
`inputCostPerUnitMinor`, `outputCostPerUnitMinor`, `unit` (`1k_tokens`,`image`,`second`,`character`),
`currency`, `status` (`available`,`beta`,`deprecated`,`disabled`), `disableSwitch bool`,
`qualityTier` (`fast`,`balanced`,`premium`), `notes`.

Constraint: `unique(providerId, key, environment)`.
Rule: a disabled model is immediately unusable by routing, even for in-flight rules.

### 6.4 `AIRoutingRule`

Maps a **task** to a model chain.

`id`, `taskKey` (`caption.generate`, `ideas.generate`, `plan.monthly`, `strategy.generate`,
`analytics.explain`, `copilot.chat`, `image.generate`, `video.generate`, `moderation.check`,
`brand.retrieve` …), `scope` (`global`,`plan`,`workspace`), `planId` (null), `workspaceId` (null),
`primaryModelId`, `fallbackModelIds uuid[]` (ordered), `parameters jsonb` (temperature, max tokens,
system prompt version), `qualityTier`, `maxCostPerRequestMinor`, `timeoutMs`, `retryPolicy jsonb`,
`priority int`, `status`, `configurationVersionId`.

Resolution order: workspace rule → plan rule → global rule. Highest `priority` wins within a scope.
Indexes: `(taskKey, scope, priority desc)`, `(workspaceId, taskKey)`.

### 6.5 `AIRequest`

One logical AI action.

| Field                                                               | Notes                                                                                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `workspaceId`, `brandId` (null), `userId` (null for system)   |                                                                                                                                          |
| `taskKey`, `idempotencyKey` (unique)                                |                                                                                                                                          |
| `routingRuleId`, `resolvedModelId`, `attemptedModelIds uuid[]`      |                                                                                                                                          |
| `status`                                                            | `pending`, `reserved`, `running`, `succeeded`, `failed`, `cancelled`, `timeout`, `moderation_blocked`                                    |
| `inputSummary jsonb`                                                | **audit-safe**: token/asset counts, language, brand refs, prompt template id — never raw customer content unless retention policy allows |
| `outputRefType`, `outputRefId`                                      | points at ContentItem / Asset / Insight                                                                                                  |
| `promptTokens`, `completionTokens`, `imageCount`, `durationSeconds` | usage units                                                                                                                              |
| `providerCostMinor`, `currency`                                     | actual provider cost                                                                                                                     |
| `creditsReserved`, `creditsCharged`                                 | credits                                                                                                                                  |
| `latencyMs`, `retryCount`, `failureCode`, `failureMessage`          |                                                                                                                                          |
| `byok bool`, `byokCredentialId`                                     | customer-supplied key path                                                                                                               |

Indexes: `unique(idempotencyKey)`, `(workspaceId, createdAt desc)`, `(workspaceId, taskKey, status)`,
`(status, createdAt)` for stuck-request sweeps.

**Lifecycle**

```mermaid
stateDiagram-v2
  [*] --> Pending
  Pending --> Reserved: credits reserved
  Reserved --> Running: provider call started
  Running --> Succeeded: response validated
  Running --> Failed: permanent error
  Running --> Timeout: deadline exceeded
  Running --> Running: fallback model attempt
  Succeeded --> [*]: reservation settled, credits charged
  Failed --> [*]: reservation released, zero charge
  Timeout --> [*]: reservation released, zero charge
```

### 6.6 `AIUsageLedger` (immutable)

`id`, `workspaceId`, `aiRequestId`, `occurredAt`, `taskKey`, `providerId`, `modelId`,
`usageUnits jsonb`, `providerCostMinor`, `currency`, `creditsCharged`,
`creditTransactionId`, `userId`, `brandId`, `environment`.

Append-only. No updates, no deletes. Corrections are new rows referencing `correctsLedgerId`.
Indexes: `(workspaceId, occurredAt desc)`, `(workspaceId, taskKey, occurredAt)`, `(modelId, occurredAt)`.
This table is the source for admin cost/margin reporting.

---

## 7. Credits

### 7.1 `CreditWallet`

`id`, `workspaceId` (unique), `currentBalance`, `reservedBalance`, `lifetimeGranted`,
`lifetimeConsumed`, `lowBalanceThreshold`, `lowBalanceNotifiedAt`, `hardLimitEnabled`,
`overageEnabled`, `overageCapCredits`, `lastResetAt`, `nextResetAt`, `version` (optimistic lock).

**`currentBalance` is a materialized projection of the ledger**, updated only inside the same transaction as
the transaction row, and reconcilable by replaying `CreditTransaction`. A nightly job asserts equality and
alerts on drift.

Constraints: `CHECK (currentBalance >= 0)`, `CHECK (reservedBalance >= 0)`.

### 7.1a `CreditGrant` (Phase 3) — the FIFO bucket

`id`, `workspaceId`, `walletId`, `source`
(`plan_grant`,`trial_grant`,`promotional_grant`,`pack_purchase`,`admin_adjustment`,`rollover`),
`amountMilliCredits`, `remainingMilliCredits`, `reservedMilliCredits`, `expiresAt` (null = never),
`sourceTransactionId` (unique), `reason`, `grantedAt`.

**A PROJECTION, like `currentBalance`.** The ledger remains the source of truth: the GRANT
row carries `expiresAt` and every CHARGE row carries `sourceGrantId`, so
`remainingMilliCredits` is reconstructible by replay. The column exists so choosing the
next bucket is a short indexed read rather than an aggregate over the whole ledger.

Three quantities, kept apart deliberately:

```
remaining = amount − (charges settled against this bucket)   ← what replay computes
reserved  = estimates currently held against this bucket
spendable = remaining − reserved
```

Holding a reservation moves `reserved` only, so an open reservation never makes the bucket
disagree with the ledger — and two concurrent reservations cannot both allocate the same
credits, which they could if a reservation left no per-bucket trace.

Constraints: `CHECK (remaining BETWEEN 0 AND amount)`, `CHECK (reserved BETWEEN 0 AND remaining)`,
`CHECK (amount > 0)`. A trigger refuses any change to `amountMilliCredits`, `source`,
`workspaceId`, `grantedAt` or `sourceTransactionId`: rewriting those would break replay
SILENTLY — reconciliation would still report zero drift while the numbers underneath had
changed.

Indexes: `(workspaceId, expiresAt, grantedAt)` for the consumption order,
`(walletId, remainingMilliCredits)`.

### 7.1b `CreditReservation` (Phase 3)

`id`, `workspaceId`, `walletId`, `idempotencyKey` (unique), `estimateMilliCredits`,
`settledMilliCredits`, `status` (`open`,`settled`,`released`,`expired`), `allocations jsonb`,
`purpose`, `expiresAt`, `createdAt`, `settledAt`, `releasedAt`, `releaseReason`.

The ledger records every movement; this row holds the STATE that makes
`reserve → confirm → settle` safe. `allocations` freezes which buckets FIFO chose at
reserve time, so settlement charges the buckets the customer was quoted against rather
than re-deciding against a wallet that has since moved. `expiresAt` is what the sweeper
reads: an abandoned reservation must be released, and the leak count must stay at zero.

Constraint: `CHECK (settledMilliCredits IS NULL OR settledMilliCredits BETWEEN 0 AND estimateMilliCredits)`.
Charging above the reserved amount is the one way a wallet could go negative behind its own
CHECK, so the database refuses it directly. A trigger refuses re-opening a terminal
reservation, which is how the same estimate would be charged twice.

Indexes: `(workspaceId, status)`, `(status, expiresAt)` for the sweeper.

### 7.2 `CreditTransaction` (immutable)

`id`, `workspaceId`, `walletId`, `type`
(`plan_grant`,`addon_purchase`,`promotional_grant`,`admin_adjustment`,`reservation`,`reservation_release`,
`usage_charge`,`refund`,`expiry`,`reset`), `amount` (signed), `balanceAfter`, `reason`,
`aiRequestId` (null), `invoiceId` (null), `expiresAt` (for expiring grants), `sourceBucketId`
(which grant the usage consumed, for FIFO expiry), `idempotencyKey` (unique),
`actorType` (`system`,`user`,`platform_user`), `actorId`, `occurredAt`, `metadata jsonb`.

Indexes: `unique(idempotencyKey)`, `(workspaceId, occurredAt desc)`, `(walletId, type)`,
`(workspaceId, expiresAt)` for expiry sweeps.

**Concurrency:** all balance-changing operations run inside a transaction that begins with
`SELECT … FROM credit_wallet WHERE id = $1 FOR UPDATE`. Combined with `CHECK (currentBalance >= 0)` and
the unique idempotency key, this makes negative balances, lost updates, and duplicate deductions impossible.

---

## 8. Plans, Entitlements, Billing

### 8.1 `Plan`

`id`, `key`, `name jsonb` (localized), `description jsonb`, `tier`, `visibility`
(`public`,`private`,`legacy`), `status` (`draft`,`active`,`grandfathered`,`retired`),
`monthlyPriceMinor`, `annualPriceMinor`, `currency`, `supportedCurrencies jsonb` (per-currency prices),
`trialDays`, `monthlyCredits`, `creditRolloverPolicy`, `overagePolicy jsonb`,
`upgradeBehavior`, `downgradeBehavior`, `sortOrder`, `configurationVersionId`.

Retired plans remain readable so existing subscriptions still resolve.

### 8.2 `Feature`

`id`, `key` (`ai.image_generation`, `social.publish`, `automations`, `byok`, …), `name jsonb`,
`category`, `valueType` (`boolean`,`quota`,`enum`), `defaultValue jsonb`,
`dependsOnFeatureKeys text[]`, `status`.

### 8.3 `PlanEntitlement`

`id`, `planId`, `featureId`, `enabled`, `limitValue` (null = unlimited), `limitPeriod`
(`day`,`month`,`billing_cycle`,`total`), `metadata jsonb`.
Constraint: `unique(planId, featureId)`.

Standard quota features: users, brands, social accounts, scheduled posts/month, storage GB,
analytics retention days, AI credits/month, per-feature AI limits.

### 8.4 `WorkspaceOverride`

Owner-granted, per-customer deviation.

`id`, `workspaceId`, `featureId`, `enabled`, `limitValue`, `reason`, `grantedByPlatformUserId`,
`effectiveFrom`, `effectiveUntil` (null = permanent), `status`.
Constraint: `unique(workspaceId, featureId, effectiveFrom)`.

**Precedence** (highest wins): workspace override → percentage/beta/country/date flag rules → plan
entitlement → feature default. Full rules in `docs/ADMIN-CONTROL-CENTER.md` §Feature Flags.

### 8.4a `UsageCounter` and `UsageEvent` (Phase 3)

`UsageCounter`: `id`, `workspaceId`, `featureKey`, `periodStart`, `periodEnd`, `usedValue`.
Constraint: `unique(workspaceId, featureKey, periodStart)`, `CHECK (usedValue >= 0)`.

`UsageEvent`: `id`, `workspaceId`, `featureKey`, `idempotencyKey` (unique), `amount`,
`counterId`, `occurredAt`. Append-only for both roles (REVOKE plus a trigger).

**Why the unique key on the counter matters.** It is what makes the check and the
increment ONE statement:

```sql
INSERT INTO usage_counter (…) VALUES (…, $n, …)
ON CONFLICT ("workspaceId", "featureKey", "periodStart")
DO UPDATE SET "usedValue" = usage_counter."usedValue" + $n
WHERE usage_counter."usedValue" + $n <= $limit
RETURNING "usedValue"
```

PostgreSQL evaluates the WHERE against the row it has just locked, so the losing request
updates nothing and gets no row back. A read-then-write implementation passes every
sequential test and fails the moment two requests arrive together — which is the normal
outcome of two clicks, not a rare interleaving.

Idempotency is a SECOND, independent mechanism: the `UsageEvent` row is inserted in the
same transaction and its key is unique, so a retried recording aborts the transaction and
leaves the counter untouched. The event carries a feature key and an amount; it never
carries request content.

### 8.4b `BetaCohortMembership` (Phase 3)

`id`, `workspaceId`, `cohortKey`, `addedByPlatformUserId`, `reason`, `addedAt`.
Constraint: `unique(workspaceId, cohortKey)`.

Cohort DEFINITIONS are configuration (`beta-cohorts`); membership is a row for the same
reason a `WorkspaceOverride` is — per-customer state with an author, a reason and a date,
belonging in the audit trail rather than in a configuration document that would grow a
line per customer. Until this model existed the precedence engine's beta dimension read a
hard-coded empty set, so a flag targeted at a cohort could never match anyone.

### 8.5 `Subscription`

`id`, `workspaceId`, `planId`, `status` (`trialing`,`active`,`past_due`,`paused`,`cancelled`,`expired`),
`billingInterval` (`month`,`year`), `currency`, `quantitySeats`, `addOns jsonb`,
`currentPeriodStart`, `currentPeriodEnd`, `trialEndsAt`, `cancelAtPeriodEnd`, `cancelledAt`,
`gracePeriodEndsAt`, `providerKey`, `providerSubscriptionId`, `providerCustomerId`,
`couponCode`, `discountJson`, `taxProfile jsonb`, `pendingPlanChange jsonb`.

> **Phase 3 ships `WorkspaceSubscription`, which is NOT this model yet.** It carries the
> plan, the PINNED price and its source configuration version, the billing interval, the
> cycle boundaries, the trial dates and a scheduled plan change — and no provider
> reference, no invoice linkage and no payment state, because payment collection is
> Phase 7 and this phase must not simulate it. One row per workspace, evolving in place,
> so the trial history cannot be erased by starting again.
>
> The pinned price is the whole reason the record exists now: AC-04.7 requires that
> changing a plan's price does not reprice existing customers, and a system that reads
> the price out of the live catalogue at render time cannot have that property, however
> carefully it is written. Phase 7 extends this record rather than replacing it.

Indexes: `(workspaceId, status)`, `unique(providerKey, providerSubscriptionId)`,
`(status, currentPeriodEnd)` for renewal sweeps.

**Lifecycle**

```mermaid
stateDiagram-v2
  [*] --> Trialing
  Trialing --> Active: first successful payment
  Trialing --> Expired: trial ended, no payment
  Active --> PastDue: payment failed
  PastDue --> Active: retry succeeded
  PastDue --> Cancelled: dunning exhausted
  Active --> Paused: admin pause
  Paused --> Active
  Active --> Cancelled: customer cancels
  Cancelled --> Expired: period end reached
```

### 8.6 `Invoice`

`id`, `workspaceId`, `subscriptionId`, `number` (unique, sequential per workspace/tenant),
`status` (`draft`,`open`,`paid`,`void`,`uncollectible`,`refunded`,`partially_refunded`),
`currency`, `subtotalMinor`, `discountMinor`, `taxMinor`, `totalMinor`, `amountPaidMinor`,
`amountRefundedMinor`, `lineItems jsonb`, `taxBreakdown jsonb`, `issuedAt`, `dueAt`, `paidAt`,
`providerKey`, `providerInvoiceId`, `pdfStorageKey`, `billingAddress jsonb`.

Immutable once `status='open'` or later; corrections are credit notes.
Indexes: `(workspaceId, issuedAt desc)`, `unique(providerKey, providerInvoiceId)`, `unique(number)`.

---

## 9. Automation, Notifications, Platform Ops

### 9.1 `AutomationRule`

`id`, `workspaceId`, `brandId` (null), `name`, `trigger jsonb`
(`content.approved`, `publish.failed`, `metric.threshold`, `schedule.cron`, `connection.needs_reauth`…),
`conditions jsonb`, `actions jsonb` (`schedule_content`, `notify`, `create_approval`, `generate_content`,
`tag`, `webhook`), `enabled`, `maxRunsPerDay`, `requiresApprovalForExternalActions bool`,
`createdByUserId`, `lastRunAt`, `deletedAt`.

Rule: an automation may **never** perform an external publish without either an explicit standing
authorization recorded on the rule or a human approval step.

### 9.2 `AutomationRun`

`id`, `workspaceId`, `ruleId`, `triggeredBy jsonb`, `startedAt`, `finishedAt`,
`status` (`running`,`succeeded`,`failed`,`skipped`,`blocked_by_policy`),
`actionsExecuted jsonb`, `errorCode`, `errorMessage`, `idempotencyKey` (unique).

Indexes: `(workspaceId, ruleId, startedAt desc)`.

### 9.3 `Notification`

`id`, `workspaceId`, `userId` (null = workspace-wide), `templateKey`, `locale`,
`channel` (`in_app`,`email`,`sms`,`whatsapp`,`push`), `payload jsonb`, `renderedSubject`,
`renderedBodyRef`, `status` (`queued`,`sent`,`delivered`,`failed`,`bounced`,`suppressed`),
`readAt`, `sentAt`, `providerMessageId`, `failureCode`, `idempotencyKey` (unique),
`priority`, `groupKey` (for digest collapsing).

Indexes: `(workspaceId, userId, readAt)`, `(status, createdAt)`.

Notification **templates** live in the Configuration Service (versioned, bilingual, previewable,
test-sendable, rollback-able), not in this table.

### 9.4 `AuditEvent` (immutable)

| Field                                                                                             | Notes                                                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `id`, `occurredAt`                                                                                |                                                                                      |
| `workspaceId`                                                                                     | null for platform-only events                                                        |
| `actorType` (`user`,`platform_user`,`system`,`automation`,`copilot`), `actorId`, `actorEmailHash` |                                                                                      |
| `action`                                                                                          | e.g. `content.published`, `plan.activated`, `secret.rotated`, `support_mode.entered` |
| `resourceType`, `resourceId`, `brandId`                                                           |                                                                                      |
| `severity` (`info`,`notice`,`warning`,`critical`)                                                 |                                                                                      |
| `before jsonb`, `after jsonb`                                                                     | **redacted**; secrets and tokens never included                                      |
| `ip`, `userAgent`, `requestId`, `traceId`, `sessionId`                                            |                                                                                      |
| `supportModeSessionId`                                                                            | set when the action occurred under support mode                                      |
| `outcome` (`success`,`denied`,`error`), `reason`                                                  |                                                                                      |

Indexes: `(workspaceId, occurredAt desc)`, `(actorId, occurredAt desc)`,
`(resourceType, resourceId, occurredAt desc)`, `(action, occurredAt desc)`.
Append-only, enforced by revoking UPDATE/DELETE from the application role. Retention is long
(default 24 months, configurable), and export is supported.

### 9.5 `ConfigurationVersion` (immutable)

`id`, `domain`, `environment`, `versionNumber`, `schemaVersion`, `payload jsonb`,
`payloadChecksum`, `status` (`draft`,`validated`,`active`,`superseded`,`discarded`),
`previousVersionId`, `validationReport jsonb`, `impactPreview jsonb`,
`createdByPlatformUserId`, `activatedByPlatformUserId`, `activatedAt`, `deactivatedAt`,
`changeReason`, `rollbackOfVersionId`.

Constraints: `unique(domain, environment, versionNumber)`; a partial unique index guarantees **at most one
`active` version per `(domain, environment)`**.
Indexes: `(domain, environment, status)`, `(activatedAt desc)`.

---

## 10. Supporting Tables (not enumerated in the brief but required)

| Table                                       | Purpose                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Session` / `PlatformSession`               | separate session stores per realm, with device metadata and revocation                                                               |
| `Invitation`                                | if modelled separately from `Membership` for platform-initiated invites                                                              |
| `SecretRecord`                              | vault metadata: `ref`, `scope`, `environment`, `version`, `maskedHint`, `fingerprint`, `rotatedAt`, `status` — never the value       |
| `IdempotencyKey`                            | `key`, `scope`, `workspaceId`, `requestHash`, `responseSnapshot`, `status`, `expiresAt`                                              |
| `WebhookEvent`                              | inbound provider events: `providerKey`, `externalEventId` (unique), `signatureValid`, `payload`, `status`, `processedAt`, `attempts` |
| `OutboxEvent`                               | transactional outbox so domain events are never lost between DB commit and queue enqueue                                             |
| `AssetFolder`                               | asset library hierarchy                                                                                                              |
| `SupportModeSession`                        | `platformUserId`, `workspaceId`, `reason`, `ticketRef`, `grantedAt`, `expiresAt`, `endedAt`, `permissionsSnapshot`                   |
| `DataExportRequest` / `DataDeletionRequest` | GDPR-style lifecycle with status and artifacts                                                                                       |
| `RateLimitCounter`                          | if persisted beyond Redis for auditability                                                                                           |

---

## 11. Index Strategy Summary

1. **Every** tenant-owned table: `(workspaceId, <most common filter>, <sort column> DESC)`.
2. Foreign keys are always indexed (Postgres does not do this automatically).
3. Status-scan tables (`PublishJob`, `AIRequest`, `Notification`, `CalendarSlot`) get partial indexes on
   in-flight states only — e.g. `WHERE status IN ('queued','processing')` — keeping sweeper queries small.
4. Unique idempotency indexes on `AIRequest`, `PublishJob`, `CreditTransaction`, `AutomationRun`,
   `Notification`, `WebhookEvent`.
5. GIN indexes on `tags` arrays and on searchable `jsonb`; full-text search columns are generated and
   workspace-filtered.
6. Vector index on `BrandKnowledge.embedding` with the workspace predicate applied inside the query.
7. Time-series growth (`MetricSnapshot`, `AIUsageLedger`, `AuditEvent`, `PublishAttempt`) is monitored;
   monthly partitioning is planned once a table exceeds ~50M rows.

---

## 12. Constraints That Encode Business Rules

| Rule                                               | Enforcement                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Credit balance never negative                      | `CHECK (currentBalance >= 0)` + `FOR UPDATE` lock                                                                    |
| No duplicate AI charge                             | `unique(AIRequest.idempotencyKey)` + `unique(CreditTransaction.idempotencyKey)`                                      |
| No double publish                                  | `unique(PublishJob.idempotencyKey)` and `unique(variant, connection, slot)`                                          |
| One active config per domain/env                   | partial unique index on `status='active'`                                                                            |
| One active credential per provider/env             | partial unique index                                                                                                 |
| Brand belongs to workspace                         | composite FK `(workspaceId, brandId)` referencing `Brand(workspaceId, id)`                                           |
| A referenced row belongs to the caller's workspace | every tenant-to-tenant FK is composite on `workspaceId` against the parent's `unique(workspaceId, id)` (D-99, D-112) |
| Workspace keeps an owner                           | transactional guard on membership/role change                                                                        |
| Only approved content publishes                    | guard on `CalendarSlot` transition + re-check at job execution time                                                  |
| Analytics ingestion is idempotent                  | natural unique key + upsert                                                                                          |
| Ledgers are append-only                            | `REVOKE UPDATE, DELETE` from the application role                                                                    |

---

## 13. Data Lifecycle and Retention

| Data                           | Default retention                     | Notes                                                                                                                                        |
| ------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit events                   | 24 months                             | configurable per plan; exportable                                                                                                            |
| Metric snapshots               | per plan (`analyticsRetentionDays`)   | pruned by a scheduled job                                                                                                                    |
| AI request input summaries     | 90 days                               | raw prompt/response bodies are **not** stored by default (R-23)                                                                              |
| AI usage ledger                | 7 years                               | financial record                                                                                                                             |
| Credit transactions / invoices | 7 years                               | financial record                                                                                                                             |
| Soft-deleted content           | 30 days, then purge                   | restorable within the window                                                                                                                 |
| Deleted workspace              | 30-day grace, then irreversible purge | export offered first; the grace is `workspace.deletionScheduledFor` (D-328) — marked DELETED at its end; physical purge is the §15 lifecycle |
| Publish attempts               | 12 months                             | provider responses redacted                                                                                                                  |
| Backups                        | 30 days PITR + 12 monthly snapshots   | restore tested quarterly                                                                                                                     |

---

## 14. Platform-Owned Tables (implemented in Phase 2A)

> **ملخّص بالعربية**
>
> هذه الجداول تخص المنصة نفسها لا العملاء: هوية مسؤولي المنصة وجلساتهم، إصدارات الإعدادات، والمفاتيح السرية
> المشفّرة. لا تحتوي على `workspaceId`، ولا يملك دور التطبيق أي صلاحية عليها إطلاقًا.

These carry **no `workspaceId`**. They are not tenant data, and the tenant application role has no privilege on
them at all — a query from `brandspace_app` returns _permission denied_, not an empty result.

| Table                        | Purpose                                 | Notable constraints                                                                                                                                        |
| ---------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform_user`              | Platform Admin identity                 | `email` unique; `mfaSecretRef` is a vault reference, never a secret; `lockedUntil` drives lockout                                                          |
| `platform_session`           | Admin sessions                          | `tokenHash` unique — the token itself is never stored; `mfaVerifiedAt IS NULL` grants nothing                                                              |
| `platform_mfa_recovery_code` | Single-use recovery codes               | stored as SHA-256 hashes; `usedAt` burns one on use                                                                                                        |
| `configuration_version`      | Versioned configuration documents       | partial unique index `(domain, environment) WHERE status = 'ACTIVE'`; trigger rejects editing an ACTIVE payload                                            |
| `secret_record`              | Secret identity and lifecycle           | unique `(ref, environment)`                                                                                                                                |
| `secret_version`             | Encrypted material, one row per version | partial unique index `(secretRecordId) WHERE status = 'ACTIVE'`; trigger rejects any change to ciphertext, IV, auth tag, wrapped key or encryption context |

### 14.1 Protection

Each of the six has, in the same migration that creates it:

```sql
ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "<table>" FORCE  ROW LEVEL SECURITY;
CREATE POLICY platform_only ON "<table>"
  TO brandspace_platform USING (true) WITH CHECK (true);
REVOKE ALL ON "<table>" FROM brandspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "<table>" TO brandspace_platform;
```

Two independent controls, so neither is load-bearing alone: the grant is gone, **and** the policy names only
the platform role, so a future blanket `GRANT` still yields zero rows.

`platform_user` joined this set in migration `20260901210500_platform_user_isolation`. It was created in Phase
1 as an unclassified table and picked up the RLS migration's `GRANT ... ON ALL TABLES IN SCHEMA public`, which
left its password hashes readable by the tenant role. See `docs/DECISIONS.md` F-10.

### 14.2 Secret material columns

`secret_version` stores `ciphertext`, `iv`, `authTag`, `wrappedDataKey` and `encryptionContext`. The plaintext
appears in no column, no index and no log. The encryption context binds the ciphertext to
`(ref, environment, version)` as AEAD additional data, so a row copied to another environment fails to decrypt
rather than quietly working.

### 14.3 The tenancy registry is the source of truth

`packages/database/src/tenant-models.ts` classifies **every** model as tenant-owned, platform-owned, identity,
or a global catalogue. `scripts/isolation-gate.ts` fails the build when a model is unclassified, when the
classification disagrees with the schema, when a platform-owned table lacks its policy or its revoke, or when
the isolation suite never exercises it. A model nobody thought about is a build failure, not a default.

---

## 15. Phase 2B Tables — Customers, Invitations, Entitlements, Credits

> **ملخّص بالعربية**
>
> جداول المرحلة 2B: جلسات العملاء ورموز إعادة تعيين كلمة المرور (هوية عالمية، لا تخص مساحة عمل)،
> الدعوات ذات الرمز المُخزَّن كتجزئة فقط، استثناءات الاستحقاقات لكل عميل، محفظة الأرصدة ودفترها غير القابل
> للتعديل، وصندوق البريد الصادر. كل جدول يحمل `workspaceId` محميّ بـ RLS واختبار عزل.

### 15.1 Tenant-owned

| Table                | Purpose                            | Notable constraints                                                                                                                                                                                         |
| -------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invitation`         | A workspace invitation             | `unique(tokenHash)`; partial unique `(workspaceId, email) WHERE status='PENDING'`; CHECK exactly one inviter; CHECK the address is lower-case; trigger refuses reviving a terminal row or editing the token |
| `workspace_override` | Per-customer entitlement deviation | partial unique `(workspaceId, featureKey) WHERE status='ACTIVE'`                                                                                                                                            |
| `credit_wallet`      | One wallet per workspace           | `unique(workspaceId)`; `CHECK (balanceMilliCredits >= 0)`; `CHECK (reservedMilliCredits >= 0)`                                                                                                              |
| `credit_transaction` | The immutable ledger               | `unique(idempotencyKey)`; `UPDATE`/`DELETE` revoked from **both** roles; trigger as the second stop                                                                                                         |
| `email_message`      | The outbox (nullable tenant key)   | `workspaceId IS NULL` for messages that precede any workspace, e.g. a password reset                                                                                                                        |

### 15.2 Identity, RLS-protected, not tenant-owned

`customer_session` and `password_reset_token` carry no `workspaceId`, because a `User` is a global identity
and the workspace is chosen **after** authentication. They are still RLS-protected, with the tightest
policy in the schema:

```sql
CREATE POLICY tenant_isolation ON "customer_session"
  TO brandspace_app
  USING      (app.current_workspace_id() IS NULL)
  WITH CHECK (app.current_workspace_id() IS NULL);
```

Readable **only** with no workspace context — that is, from the authentication path. A member acting inside
workspace A cannot read session rows at all: not another tenant's, and not even their own. Authentication
itself works because it runs before any workspace is known, which the isolation suite asserts in both
directions so the policy cannot be "narrow" by simply being broken.

### 15.3 Changes to existing tables

`workspace` gains: `statusReason`, `statusChangedAt`, `statusChangedByPlatformUserId`, `archivedAt` (the
provenance of a lifecycle change, so a suspension is never an unexplained state); `planKey`,
`planAssignedAt`, `planAssignedByPlatformUserId` (D-40 — superseded by `Subscription` when billing
arrives); `lockVersion` (optimistic concurrency for platform edits); and `lastActivityAt`, which is **null**
until a customer session touches the workspace and is displayed as "none yet" rather than as a date.

`WorkspaceStatus` gains `ARCHIVED`: retained, read-only, out of the working set. There is no hard-delete
path through any interface (CLAUDE.md §2.5).

A CHECK constraint requires `statusReason` whenever the status is `SUSPENDED`, `ARCHIVED` or `CANCELLED`.
An unexplained lifecycle change is the one support cannot answer.

### 15.4 The context-less reads, and the two write-only widenings

Four Phase 2B questions arise **before** any workspace context exists. Each is answered by the narrowest
policy that can answer it, and no wider:

| Question                                  | Policy                                    | Keyed on                     | Shape                       |
| ----------------------------------------- | ----------------------------------------- | ---------------------------- | --------------------------- |
| Which workspaces may this session act in? | `session_membership`, `session_workspace` | `app.session_token_hash`     | `SELECT` only, tenant role  |
| What does this invitation offer?          | `invitation_by_token`                     | `app.invitation_token_hash`  | `SELECT` only, PENDING only |
| May the login path record what happened?  | `audit_event` `WITH CHECK`                | NULL workspace, NULL context | write only, never readable  |
| May the reset path queue a message?       | `email_message` `WITH CHECK`              | NULL workspace, NULL context | write only, never readable  |

The two read widenings expose rows the caller already holds a 256-bit secret for. The two write widenings
leave `USING` untouched, so what they permit to be written can never be read back by any tenant — and
inside a workspace a NULL-workspace write is still refused, so a tenant cannot detach a record from their
own history.

**A trap worth naming.** PostgreSQL applies `USING` to `INSERT … RETURNING`, and reports the refusal as
`new row violates row-level security policy` — a _write_ error for a write the policy allows. Any table
whose `WITH CHECK` is wider than its `USING` will do this, so both the audit path and the outbox generate
the row id and insert without `RETURNING`.

### 15.5 Credit units

Milli-credits are stored; whole credits are displayed (D-14). `balanceMilliCredits` is a materialised
projection of the ledger, updated only inside the same transaction as its `CreditTransaction` row.
`CreditService.reconcile()` replays the ledger and reports the drift, which must be zero.

## 16. Workspace-scoped foreign keys, as built (D-112 / D-131)

Every foreign key from a tenant-owned child to a tenant-owned parent is
composite on `workspaceId` against a `(workspaceId, id)` unique on the parent.
PostgreSQL evaluates referential integrity as the table owner with RLS
bypassed, so a plain single-column key resolves another tenant's row perfectly
well and the difference between "inserted" and "violates foreign key" answers
_does that id exist?_

The rule reached Brand Brain in `20260914200000` (F-80/F-83) and the rest of the
platform in `20260915234500`:

| Child                | Column(s)                       | Parent            | Constraint                       |
| -------------------- | ------------------------------- | ----------------- | -------------------------------- |
| `credit_transaction` | `workspaceId, walletId`         | `credit_wallet`   | `credit_transaction_wallet_fkey` |
| `credit_grant`       | `workspaceId, walletId`         | `credit_wallet`   | `credit_grant_wallet_fkey`       |
| `credit_reservation` | `workspaceId, walletId`         | `credit_wallet`   | `credit_reservation_wallet_fkey` |
| `ai_usage_ledger`    | `workspaceId, aiRequestId`      | `ai_request`      | `ai_usage_ledger_request_fkey`   |
| `ai_usage_ledger`    | `workspaceId, correctsLedgerId` | `ai_usage_ledger` | `ai_usage_ledger_corrects_fkey`  |

`ON UPDATE NO ACTION` throughout: a `workspaceId` is never rewritten, and a key
that silently followed one would be a cross-tenant move rather than an update.
The delete actions are unchanged from the plain keys they replaced.

### 16.1 `role` — the exception, and why it needs a trigger

`role."workspaceId"` is **nullable**: a system role is shared by every workspace
(`NULL`), a custom role belongs to exactly one. A child whose `workspaceId` is
NOT NULL can never match a parent row whose `workspaceId` IS NULL, so the
composite key above is impossible by construction here, not merely missing.

`membership` and `invitation` are guarded instead by
`app.role_reference_is_workspace_scoped()`
(`20260915235000_d112_role_reference_is_workspace_scoped`).

**A NULL WORKSPACE IS NOT THE SAME AS A SYSTEM ROLE, AND THE TRIGGER CHECKS THE
REALM FIRST (D-133).** Two different populations carry `workspaceId IS NULL`:
WORKSPACE-realm system roles, which genuinely are shared by every workspace, and
**every PLATFORM-realm role** — `platform_owner` among them — which belongs to
the Control Center and to no workspace at all. `role`'s RLS policy
(`"workspaceId" IS NULL OR "workspaceId" = app.current_workspace_id()`) makes
all of them visible inside a tenant context, and customer sessions compute their
permissions straight from `membership.role.permissions` without checking the
realm. So the trigger refuses anything whose `realm <> 'WORKSPACE'` **regardless
of `workspaceId`**, and only then requires a custom role to belong to the row's
own workspace.

It reads `role` as the invoker, so in a tenant context another workspace's
custom role is simply not visible and the lookup finds nothing — refusing on
"not found" IS the tenancy check, and it is indistinguishable from a fabricated
id. In a platform context every role is visible, and the explicit comparisons
are what refuse a cross-wired write.

`role_permission` has no tenant key of its own and inherits the role's, so it
raises no cross-tenant question.

---

## 17. Phase 6 — Social Publishing

Five tenant-owned tables. Every one carries a non-null `workspaceId`, has `ENABLE + FORCE` row-level
security with a `tenant_isolation` policy, and reaches every tenant-owned parent through a COMPOSITE key
on `(workspaceId, <parent id>)` — D-112, with no exceptions in this phase.

| Table                | Tenant key | Brand            | Notes                                                                                                                               |
| -------------------- | ---------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `social_connection`  | NOT NULL   | NOT NULL (D-138) | One live connection per (brand, provider, external account), as a PARTIAL unique index so a revoked one does not block reconnection |
| `social_credential`  | NOT NULL   | via connection   | Envelope-encrypted token material. At most one live version per connection                                                          |
| `social_oauth_state` | NOT NULL   | NOT NULL         | `stateHash` unique PLATFORM-wide; the verifier is encrypted                                                                         |
| `publish_job`        | NOT NULL   | NOT NULL         | `(workspaceId, idempotencyKey)` unique. `RESTRICT` on the connection, deliberately                                                  |
| `publish_attempt`    | NOT NULL   | via job          | **Immutable** by trigger (every role, including the owner) and **not tenant-deletable** by privilege — see §17.3                    |

### 17.1 The constraints that carry a rule

Several CHECK constraints here encode an invariant rather than a format, and each is worth naming because
a reader should not have to infer why it exists:

- `publish_job_published_has_post` — a `PUBLISHED` job has an external post id and a timestamp, and a job
  with them is `PUBLISHED`. **The whole duplicate-prevention design rests on this**: if a job could be
  `PUBLISHED` with no external id, "did this already go out?" would have no answer, and the only safe
  behaviour left would be to never retry anything.
- `publish_job_failed_has_class` — a failure with no class cannot be retried correctly, explained to the
  customer, or counted.
- `social_credential_hint_is_masked` — `maskedHint` is at most eight characters. A future call site that
  passed the token itself into that column would be storing a credential where every audit view reads.
- `publish_attempt_summary_bounded` — 500 characters. A provider's raw body routinely echoes the caption
  it rejected, and a column with no ceiling is where somebody eventually drops it.
- `social_connection_one_live_per_account` and `social_credential_one_live_per_connection` — both PARTIAL,
  so the states that must not collide cannot, while a revoked connection or a retired credential does not
  block the reconnection that follows it.

### 17.2 `calendar_slot` gained its publishing states

Phase 5B-2 deliberately stopped at `PLANNED` / `SCHEDULED` / `CANCELLED`, on the grounds that "a state no
code can enter is a state whose meaning nobody has settled". This phase settles them: `PUBLISHING`,
`PUBLISHED`, `PARTIALLY_PUBLISHED` and `FAILED` are added, matched one-to-one with the `ContentStatus`
values that already existed, so a slot and its item can never describe the same situation differently.
The values are ADDED, so every existing row keeps its status and every existing query keeps its meaning.

### 17.3 Immutability is a trigger; non-deletability is a privilege

`publish_attempt` is the evidence a support case and a platform dispute both rest on, so it may not be
rewritten. That is a trigger, and it fires for every role including the table owner.

**Deletion is a different question, and a trigger is the wrong instrument for it.** A `BEFORE DELETE`
trigger fires for a CASCADED delete too, and PostgreSQL gives a row trigger no way to tell one from a
direct statement. The first draft of this migration used one, and the result was that deleting a calendar
slot — or a content item, a brand, or a workspace, all of which cascade down to this table — failed the
moment a single attempt existed. The Phase 5B-2 and 5B-3 suites went red against a table they know nothing
about, which is what a cross-phase regression looks like from the inside.

So `DELETE` is **revoked from `brandspace_app`** instead, and the migration asserts the revoke survived the
`GRANT` four lines above it. A cascade is performed as the table owner and is unaffected; a `DELETE`
issued by the tenant is refused outright.

The guarantee that results is precise, and is worth stating precisely rather than as "append-only":

- An attempt **cannot be edited** after it is written.
- An attempt **cannot be removed from a sequence** to make a history read differently.
- An attempt **goes with the job it belongs to** when that job is deleted — evidence about a thing that no
  longer exists has no subject.
- The **platform identity keeps `DELETE`**, because erasure on request is a platform operation and must
  remain possible.

### 17.4 The pending grant on `social_oauth_state` (D-142)

A grant that offers more than one publishable target does not produce a connection at the callback,
because **a connection row IS a chosen target** and nobody has chosen one. The exchanged token is
sealed onto the in-flight authorization instead:

| Column                                           | Holds                                                                                                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pendingCiphertext` … `pendingEncryptionContext` | The AES-256-GCM envelope, wrapped data key and authenticated context. The same protection a `social_credential` gets, under the same key domain (D-136), because a pending grant **is** a live credential. |
| `offeredTargets`                                 | What the provider said this grant can publish to. The customer's own page names, under the customer's own RLS. No token.                                                                                   |
| `grantedScopes`                                  | Carried across the pause so the connection records the same scopes it would have recorded directly.                                                                                                        |
| `selectionTokenHash`                             | SHA-256 of the single-use secret authorising the choice. Unique platform-wide, for the same reason `stateHash` is.                                                                                         |
| `selectionExpiresAt`, `selectionConsumedAt`      | The same TTL the authorization had, and the same conditional-UPDATE consumption.                                                                                                                           |

`social_oauth_state_pending_grant_is_whole` makes the two half-states unrepresentable: a selection
secret with no sealed token is a selection that cannot complete, and a sealed token with no secret is
a token nobody can reach and nobody can revoke. Once the grant becomes a credential every one of
these columns is set back to NULL.

### 17.5 Recovering a stalled claim (D-143)

`publish_job` gained no column for this — `claimedAt` already existed, written by the conditional
claim — but it gained the index that makes finding a stalled row a lookup:

```sql
CREATE INDEX "publish_job_status_claimedAt_idx" ON "publish_job" ("status", "claimedAt");
```

A job is stale when `status = 'PUBLISHING'` and `claimedAt` is older than
`publishing.dispatch.claimLeaseSeconds`. That is evidence its worker is gone and **evidence of
nothing else**: recovery moves it to `VERIFICATION_PENDING` and asks the provider, or leaves it for a
person where the provider cannot be asked. The move is a conditional UPDATE, so a worker that turns
out to be alive and settles a moment later simply wins — its real outcome lands on top of the guess.

---

## 18. Phase 7 — Analytics and Copilot

Twelve tenant-owned tables and one column on an existing one. Every table carries a non-null
`workspaceId`, has `ENABLE + FORCE` row-level security with a `tenant_isolation` policy naming only
`brandspace_app`, and reaches every tenant-owned parent through a COMPOSITE key on
`(workspaceId, <parent id>)` — D-112, with no exceptions in this phase either. Every column-scoped
`SET NULL` names its own column (D-114), so a vanished parent never nulls the tenant key.

| Table                        | Tenant key | Brand       | Notes                                                                                                                            |
| ---------------------------- | ---------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `metric_observation`         | NOT NULL   | NOT NULL    | One row per measurement. `(workspaceId, observationKey)` unique — the identity of the MEASUREMENT, not of the fetch (D-145)      |
| `analytics_ingestion_cursor` | NOT NULL   | NOT NULL    | Durable progress per (connection, subject type, granularity). Carries the lease, the backoff and the freshness                   |
| `analytics_ingestion_run`    | NOT NULL   | NOT NULL    | Operations evidence. **Terminal once** by trigger, and **not tenant-deletable** by privilege                                     |
| `campaign`                   | NOT NULL   | NOT NULL    | No budget, no currency, no attribution — deliberately narrower than §4.3 anticipated (D-155). `version` is optimistic locking    |
| `insight`                    | NOT NULL   | NOT NULL    | Generated prose and its lifecycle. `(workspaceId, idempotencyKey)` unique, so a retry replays rather than regenerates            |
| `insight_evidence`           | NOT NULL   | NOT NULL    | The measurements the prose rests on. **Append-only** by trigger and **not tenant-deletable** by privilege (D-148)                |
| `copilot_session`            | NOT NULL   | nullable    | One person's conversation. Brand is optional: "what happened last week" names no brand                                           |
| `copilot_message`            | NOT NULL   | via session | `body` is nullable and a purge is STAMPED, so a purged turn is visibly purged rather than silently blank                         |
| `copilot_action_plan`        | NOT NULL   | nullable    | `confirmationTokenHash` unique PLATFORM-wide. **Frozen once confirmed** by trigger                                               |
| `copilot_tool_call`          | NOT NULL   | via plan    | `(workspaceId, idempotencyKey)` unique — the key is DERIVED from the plan, ordinal, tool and arguments, so a retry cannot re-run |
| `automation_rule`            | NOT NULL   | NOT NULL    | Closed trigger and action enums. Stores no authority — see §18.2                                                                 |
| `automation_run`             | NOT NULL   | NOT NULL    | `(workspaceId, idempotencyKey)` unique on an hour bucket. `confirmationTokenHash` unique PLATFORM-wide, single-use by trigger    |

`content_item` gained one nullable column, `campaignId`, with a composite foreign key and a
column-scoped `ON DELETE SET NULL ("campaignId")`. `brand_knowledge_candidate` gained `sourceKind`,
`insightId` and `conflictsWithItemId`, and its `sourceDocumentId` became nullable — a learning inferred
from performance has no source document, and a CHECK requires exactly one provenance to be present.

### 18.1 The constraints that carry a rule

Each of these encodes an invariant rather than a format, and each closes a way a future call site could
make the data lie:

- `metric_observation_value_sign` — a COUNT and a duration cannot be negative; a DELTA can, because
  losing followers is a real measurement. A provider returning `-5` impressions is a parsing bug, and
  this is where it stops.
- `metric_observation_ratio_bounds` — a rate is parts per mille and cannot exceed 1000.
- `metric_observation_account_has_no_post` — an account-level reading may not point at our content rows.
- `insight_evidence_metric_is_measured` — **the anti-fabrication constraint.** A `METRIC` or
  `METRIC_COMPARISON` evidence row must carry a metric key, a value, a unit and a window. An evidence row
  with a label and no measurement would be a citation pointing at nothing, which is exactly the shape a
  fabricated one takes.
- `insight_evidence_comparison_has_two_sides` — a comparison must have something to compare with.
- `copilot_plan_external_requires_confirmation` — **CLAUDE.md §2.5 as a database constraint.** A plan
  whose strictest step leaves the platform or destroys something may not exist with
  `requiresConfirmation` false. No screen, no payload and no refactor can produce one.
- `copilot_plan_execution_follows_confirmation` — a plan that has not been confirmed has not started.
- `copilot_plan_confirmation_is_attributable` — "confirmed by nobody" is the state a replay would leave.
- `automation_rule_external_requires_confirmation` — the same §2.5 rule reached by the other door: an
  automation is not a way around the Copilot's confirmation boundary.
- `copilot_message_purge_is_recorded` — a purged body carries its purge stamp, and a body that is still
  there has none.

### 18.2 Triggers, and why each one is a trigger

- `insight_evidence_no_update` — evidence is what a customer is shown INSTEAD of trusting the model's
  sentence. A record that can be edited afterwards is not evidence.
- `analytics_run_completes_once` — a run leaves `RUNNING` exactly once, into a terminal status with its
  counters and its finish time. Its identity may never move.
- `copilot_plan_frozen_once_confirmed` — the steps and the hash of a CONFIRMED plan cannot change. This
  closes the attack the plan hash alone does not: change the plan and KEEP the confirmation.
- `automation_run_confirmation_single_use` — a confirmed run may not be re-confirmed, and may not be
  RE-AIMED at a different action or resource. `resourceId` holds what a human agreed to; what the
  confirmed action PRODUCED goes in `actionResult`, so the two can never be confused.

### 18.3 Privileges, where a policy is not enough

`DELETE` is revoked from `brandspace_app` on `insight_evidence` and `analytics_ingestion_run`. RLS would
merely scope a delete to the tenant's own rows; the point here is that the tenant role may not delete
these rows AT ALL. Pruning them past their retention window is a platform operation, for the same reason
`publish_attempt` and `ai_usage_ledger` already carry: a record somebody can erase is not a record.

### 18.4 Retention

Three windows, two owners, and both are declared in `AI_OUTPUT_RETENTION_REGISTRY`:

| Artefact                                        | Window                                     | Owner                   | What happens                                                                                         |
| ----------------------------------------------- | ------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `metric_observation`, `analytics_ingestion_run` | `analytics.retention.*`, narrowed per plan | `@brandspace/analytics` | DELETED                                                                                              |
| `insight` + evidence                            | `analytics.retention.insightRetentionDays` | `@brandspace/analytics` | DELETED (evidence by cascade)                                                                        |
| `copilot_message.body`, plans, sessions         | `copilot.conversation.retentionDays`       | `@brandspace/copilot`   | Body NULLED and stamped; an unconfirmed plan EXPIRES and surrenders its token; a session is ARCHIVED |

A Copilot message ROW survives its body, because the shape of the conversation and its links to plans,
tool calls and audit events must outlive the words — an audit event pointing at a row that no longer
exists is a dangling reference in a security record. `audit_event`, `credit_transaction`,
`ai_usage_ledger` and `ai_request` are never touched by either pass.

### 18.5 Phase 7 remediation — `insight.sourceInsightId`

One nullable column, one composite foreign key, one index; migration
`20260916230000_phase_7_remediation_strategy_provenance`.

| Column            | Type   | Notes                                                                             |
| ----------------- | ------ | --------------------------------------------------------------------------------- |
| `sourceInsightId` | `UUID` | The insight this one was generated FROM. Today: a `MONTHLY_PLAN` → its `STRATEGY` |

**Why it exists.** "Grounded in the accepted strategy" lived entirely in a prompt: the generated plan
stored no link, so a reader could not tell which strategy it followed from and nothing could detect a plan
still being shown after its strategy was superseded (D-166).

**The key is COMPOSITE (D-112) and SELF-REFERENTIAL.** `FOREIGN KEY ("workspaceId", "sourceInsightId")
REFERENCES "insight"("workspaceId", "id")`. A plain `sourceInsightId -> insight(id)` would resolve another
workspace's insight — PostgreSQL evaluates referential integrity as the table owner with RLS bypassed —
and "inserted" versus "violates foreign key" would answer "does that insight exist?" across the tenant
boundary.

**`ON DELETE SET NULL` NAMES ITS COLUMN (D-114):** `ON DELETE SET NULL ("sourceInsightId")`. A bare SET
NULL on a composite key nulls every referencing column, `workspaceId` included, and `workspaceId` is NOT
NULL — the delete would fail outright. `SET NULL` rather than cascade because a plan outlives the proposal
it came from: deleting the strategy must not delete the month's work.

No RLS change: `insight` already carries the tenant policy, and a new column on an existing table inherits
it.

### 18.6 Phase 7 remediation round 2 — `automation_event`, and five narrowed idempotency keys

**`automation_event` is the automation outbox.** One row per domain event worth
evaluating rules against, written inside the transaction that caused it — so an
event commits with the approval, the scheduling or the publish, or not at all. No
domain package imports the queue; the reconciliation sweep dispatches what is
waiting, and `deliveredAt` is the only field that retires a row.

Three CHECK constraints carry rules that would otherwise be conventions:

| Constraint                                     | What it refuses                                                                                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automation_event_ref_matches_trigger`         | A producer naming the wrong kind of row for its trigger — a `POST_PUBLISHED` event carrying a `ContentItem` reference would aim three content-shaped actions at a publish job's id.                                                 |
| `automation_event_occurrence_is_timed`         | An occurrence on anything but `SCHEDULED_TIME`. The occurrence IS a timed run's bucket, and one on an event identified by its reference would silently re-bucket it.                                                                |
| `automation_event_rule_addressed_when_derived` | A schedule or a threshold event that names no rule. Both are computed FROM one rule's configuration, and delivering one to a rule that configured a different hour or number fires a rule whose own settings say it should not run. |

It carries `ENABLE + FORCE` row-level security, a `tenant_isolation` policy naming
only `brandspace_app`, and a composite `(workspaceId, brandId)` foreign key to
`brand` (D-112), like every other tenant-owned table.

**Five idempotency uniques were narrowed to match their services' replay identity**
(D-170), because round 1 narrowed the lookups and left the constraints saying
something wider:

| Table                 | Unique index                                                      |
| --------------------- | ----------------------------------------------------------------- |
| `copilot_action_plan` | `(workspaceId, sessionId, idempotencyKey)`                        |
| `content_item`        | `(workspaceId, brandId, createdByUserId, idempotencyKey)`         |
| `campaign`            | `(workspaceId, brandId, createdByUserId, idempotencyKey)`         |
| `insight`             | `(workspaceId, brandId, type, generatedByUserId, idempotencyKey)` |
| `brand_brain_message` | `(workspaceId, conversationId, idempotencyKey)`                   |

The two F-84 upload paths are deliberately untouched: their lookups have not been
narrowed, so their constraints and their services still agree.

### 18.7 Phase 7 remediation round 3 — threshold memory and a proposal's ending

**`automation_rule` remembers which side its metric is on.** Three columns, and
the nullable one carries the load:

| Column                 | Meaning                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `thresholdBreached`    | `null` = never evaluated, and that is NOT `false`. The first evaluation records the side and fires nothing, because a rule created while the metric is already past the line has not seen anything cross since somebody asked for it.                                    |
| `thresholdCycle`       | The identity of the current ARMING. It advances when the metric returns to the non-triggered side, and the outbox's dedupe key is built from it — so every sweep inside one arming writes one event between them, and the next genuine crossing writes exactly one more. |
| `thresholdEvaluatedAt` | When the side was last established, for an operator reading the row.                                                                                                                                                                                                     |

`automation_rule_threshold_cycle_non_negative` keeps the cycle counting forwards.

**`AutomationRunStatus` gained `EXPIRED`,** distinct from `CANCELLED`: cancelled
is a decision somebody made, expired is one nobody made. A proposal whose
confirmation window closes moves there, its digest is cleared, and the screen
stops offering a Confirm control for something that can no longer be confirmed
and whose content is by then days stale.

Neither is a new table, and both are runtime state on a row that already carried
`lastRunAt`, `lastRunStatus` and `runCount`.

### 18.8 Phase 7 remediation round 4 — the rule-derived producers' fair-work cursor

**`automation_rule` carries its own place in a queue.**

| Column             | Meaning                                                                                                                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nextEvaluationAt` | **NOT NULL**, default `now()`. When the scheduler should next look at this rule. The two rule-derived producers select `lte now()`, order by it ascending with `id` as a total tie-break, and park every rule they visit in the same transaction that writes its event. |
| `lastEvaluatedAt`  | Advisory. When a sweep last actually looked, for an operator reading the row.                                                                                                                                                                                           |

One index, and it is the only cross-tenant one on the table:
`("triggerType", "enabled", "nextEvaluationAt")`. The sweep asks a
platform-wide question, so it cannot lead with `workspaceId`; that is the
enumeration half of F-07, and every row the sweep then reads or writes inside a
workspace still goes through `withWorkspace` under that tenant's own RLS.

**Why a cursor at all.** An outbox row RETIRES — `deliveredAt` removes it from
its own query — so `take: batch` there is honest pagination through shrinking
work. **An evaluated rule does not retire.** It is enabled before the sweep and
enabled after it, so the identical query on the next minute was free to return
the identical subset, and past `batch` rules the ones outside it were never
evaluated at all. For `METRIC_THRESHOLD_CROSSED` that is a memory that never
advances; for `SCHEDULED_TIME` it is worse than lateness, because the trigger's
whole meaning is "in the customer's own hour" and an hour nobody looked at is an
occurrence missed permanently and silently.

**Why NOT NULL.** `ORDER BY … ASC` puts NULLs LAST in PostgreSQL. A nullable
cursor would have sent every rule that had never been evaluated — which is every
newly created rule — to the back of the very queue that exists to reach it. The
migration backfills existing rows from `createdAt`, so they enter in creation
order rather than all sharing one instant.

**The backfill lifts FORCE for one transaction, and proves it put it back.**
`automation_rule` is `ENABLE + FORCE` and the MIGRATOR role is NOBYPASSRLS like
every other role (docs/SECURITY.md §2.2), so a plain `UPDATE` in a migration does
not fail — it reports `UPDATE 0` and commits, and the backfill would have shipped
doing nothing. The migration therefore uses PostgreSQL's own prescribed remedy,
the same shape as the F-80/F-83 migration: `NO FORCE` for the duration of the
transaction, the `UPDATE`, `FORCE` again, and a `DO` block that refuses to commit
unless the catalogue shows the table `ENABLED` and `FORCED`. `ALTER TABLE` holds
an ACCESS EXCLUSIVE lock to COMMIT, so no other session can observe the lifted
state; `ENABLE ROW LEVEL SECURITY` is untouched, no policy is touched, and the
application and platform roles are unaffected throughout. The upgrade suite
applies the file against rules that already exist and asserts both halves.

**The bound this buys.** Every enabled rule reaches the front within
`ceil(rules / batch)` passes, and no rule can hold the front, because visiting
it is what moves it back. A timed rule parks to its real next occurrence, half
an hour early so a daylight-saving shift cannot push the wake past the window,
capped at one hour so nothing is invisible for longer than the occurrence it is
waiting for. With a minutely cadence that gives `batch × 60` timed rules an
hour — 12,000 at the default batch of 200, past which the batch, not the
ordering, is what needs raising.

---

## 19. Phase 9 — Commerce & Onboarding

Thirteen models: eight tenant-owned commercial tables, two platform-owned, three identity-scoped.
All carry RLS with `FORCE`, a policy, D-29 registration and isolation coverage.

| Model                    | Ownership    | What it holds                                                  |
| ------------------------ | ------------ | -------------------------------------------------------------- |
| `BillingProfile`         | tenant       | Commercial identity; **the trusted provider-customer mapping** |
| `CheckoutSession`        | tenant       | One hosted checkout, with the amount WE calculated             |
| `Invoice`                | tenant       | Our own document; numbered at issue, immutable after           |
| `InvoiceLine`            | tenant       | Explicit lines, localized in BOTH languages at write time      |
| `CreditNote`             | tenant       | A correction. Never an edit of an invoice                      |
| `CreditNoteLine`         | tenant       | What a credit note reverses                                    |
| `PaymentAttempt`         | tenant       | The dunning trail; "we tried four times" as a queryable fact   |
| `CreditPackPurchase`     | tenant       | One prepaid pack and the ONE ledger grant it produced          |
| `BillingEvent`           | **platform** | The webhook inbox                                              |
| `InvoiceNumberSequence`  | **platform** | The seller's gapless number series                             |
| `EmailVerificationToken` | identity     | Single-use, expiring, stored only as a SHA-256 hash            |
| `UserLegalAcceptance`    | identity     | Which version of which document, accepted when                 |
| `UserMfaRecoveryCode`    | identity     | Hashes only; the plaintext is shown once and never stored      |

### 19.1 Every monetary row stores its currency AND that currency's scale

`1000` is `10.00` SAR and `1.000` KWD. Three of the seven launch currencies are three-digit, so a
scale read from the live catalogue at render time would silently re-denominate an issued invoice the
moment an owner corrected a typo. Amounts are `BIGINT`; no floating-point value reaches the database
(D-207).

### 19.2 The constraints that carry a rule

| Constraint                      | What it makes impossible                                          |
| ------------------------------- | ----------------------------------------------------------------- |
| `checkout_session_one_subject`  | A checkout for both a plan and a pack, or for neither             |
| `checkout_session_amounts_sane` | A total that is not `amount + tax`                                |
| `invoice_totals_sane`           | A total that is not `subtotal − discount + tax`                   |
| `invoice_issued_has_number`     | An issued invoice with no number, or a number with no issue date  |
| `invoice_credited_within_total` | Crediting back more than was invoiced                             |
| `credit_pack_purchase_sane`     | **A COMPLETED purchase that does not name the grant it produced** |
| `*_scale_sane`                  | A currency scale outside 0–6                                      |
| `user_mfa_enrolment_coherent`   | An account flagged for MFA with no enrolment material             |

The pack constraint is the one worth naming twice: it is what makes "paid once, granted once" a
database property rather than a worker's good intentions (D-196).

### 19.3 Why the webhook inbox is platform-owned

An event arrives **before anyone knows whose it is**. The workspace is DERIVED by looking the
provider customer id up in `billing_profile` — a mapping we wrote — and never read from the event
body. A row that cannot be resolved is kept as `UNRESOLVED` rather than guessed at or dropped. The
tenant role has no privilege on `billing_event` at all: one workspace being able to COUNT another's
payment events would be a disclosure in itself (D-208).

### 19.4 Invoice numbering is a locked counter, not a sequence

`app.allocate_invoice_number(prefix, year, padding)` advances `invoice_number_sequence` under a row
lock inside the caller's own transaction. A sequence is not transactional: a rolled-back issue would
leave a permanent gap in an accounting series that several of the markets this platform sells in
expect to be gapless.

It is an ORDINARY function — not `SECURITY DEFINER` — and only `brandspace_platform` holds EXECUTE.
That was a finding rather than a preference: `FORCE ROW LEVEL SECURITY` binds a definer too, so the
first version was refused by the very policy protecting the counter, and the D-29 gate then correctly
refused a second policy naming another role. Issuing an invoice is a SYSTEM act in response to an
authoritative provider event, never a customer action (D-209).

### 19.5 Two composite-key notes

- Four new foreign keys use the D-114 column-scoped `ON DELETE SET NULL ("column")` form. A plain
  composite `SET NULL` fails at runtime because `workspaceId` is `NOT NULL`.
- `checkout_session.workspaceId` and `invoice.workspaceId` reference `billing_profile.workspaceId` —
  single-column keys between tenant-owned tables, which the D-112 gate otherwise forbids. They are
  safe for exactly the reason the `workspace` anchor is: the child's value is pinned to the caller's
  own workspace by RLS, so the only fact the key can reveal is one about that workspace, and there is
  no id an attacker can vary. The gate now recognises `workspaceId -> workspaceId` as a shape rather
  than needing a named exemption; every other single-column key still does.

### 19.6 Customer MFA on the identity row

`user.mfaSecretMaterial` holds the AEAD envelope for a customer's TOTP seed — ciphertext, iv, auth
tag, wrapped data key and the authenticated context that binds it to that one user. The seed itself
is never stored: the plaintext exists only in the QR code shown once at enrolment. It is sealed under
`CUSTOMER_MFA_VAULT_KEK`, a third key domain, for the reasons in D-206.

---

## 20. Phase 10 — Integrations

### 20.1 One table, and it holds observations

`integration_health_check` is **platform-owned**: ENABLE + FORCE row-level security, a `platform_only`
policy, `REVOKE ALL ... FROM brandspace_app`, and isolation coverage proving the tenant role is refused
a read, a count and a write.

| Column                      | Notes                                                                            |
| --------------------------- | -------------------------------------------------------------------------------- |
| `category`, `providerKey`   | The registry's vocabulary. Plain text, so adding a category needs no migration   |
| `environment`               | `DeploymentEnvironment`                                                          |
| `outcome`                   | `OK` / `FAILED` / `NOT_CONFIGURED` / `REFUSED`                                   |
| `latencyMs`                 | Null when nothing was attempted                                                  |
| `message`                   | Operator-facing, safe to display. Never a credential, never a raw provider error |
| `requestedByPlatformUserId` | `ON DELETE SET NULL`                                                             |
| `checkedAt`                 | Indexed with the lookup key, descending                                          |

**Why a table and not configuration.** Which provider is configured, with which settings and which
credential references, is CONFIGURATION — versioned, validated, activatable, rollback-able, and it stays
in the configuration service. "The credential worked at 14:02" is an OBSERVATION: not a setting anybody
chose, and versioning it alongside the settings would turn every health check into a configuration
change with an author and an activation.

**Why no tenant access at all.** A row names a platform credential reference and whether it works. One
workspace being able to COUNT BrandSpace's provider failures is a disclosure in itself, so the policy
admits `brandspace_platform` and nobody else — the same reasoning that made `billing_event`
platform-owned in Phase 9.

**`ON DELETE SET NULL`, not CASCADE.** An operator leaving the company must not erase the record that a
production credential was verified before it was used. An isolation test reads
`information_schema.referential_constraints` and asserts the rule rather than trusting the schema file.

### 20.2 The index is named explicitly, and drift is how that was found

`@@index(..., map: "integration_health_check_lookup_idx")`. Prisma's generated name for this index is
truncated to `integration_health_check_category_providerKey_environment_c_idx`, while the migration
writes the readable one — a difference the drift check in `f80-migration-upgrade` caught before it
reached a review. The schema now names it, so the two agree.
