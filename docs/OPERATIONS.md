# Operations — backup, recovery, rotation and incident response

> **الملخص التنفيذي بالعربية**
>
> هذه الوثيقة تصف ما تحتاجه المنصة لتعمل في الإنتاج: النسخ الاحتياطي والتحقق منه، إجراء الاستعادة،
> استرداد الطوابير، سياسة التراجع عن الترحيلات، تدوير المفاتيح السرية، وأساسيات الاستجابة للحوادث.
>
> **القاعدة الأهم في هذه الوثيقة:** ما تملكه المنصة اليوم ≠ ما يجب أن يوفّره الاستضافة.
> كل قسم يفصل بوضوح بين **قدرة المنصة** (موجودة في الكود ومُختبرة) و**مسؤولية النشر** (قرار المالك ومزود الاستضافة).
> لا تدّعي هذه الوثيقة وجود نسخ احتياطية في بنية تحتية لم تُنشر بعد.

---

## 0. How to read this document

Every section below separates three things, and the separation is the point. A runbook that blurs
them is how a team discovers on the worst possible day that the backups everyone assumed existed
were a paragraph in a document.

| Marker                        | Means                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| **Platform capability**       | It is implemented in this repository and proven by a test. It exists now.            |
| **Deployment responsibility** | The platform depends on it and the hosting provider supplies it. Not code.           |
| **Owner decision**            | It needs a commercial or contractual choice nobody has made yet. Named, not guessed. |

**Nothing in this document claims a backup exists.** BrandSpace has not been deployed. What follows is
what the platform requires, what it already does for itself, and what has to be true of wherever it
eventually runs.

---

## 1. What has to survive

Four stores, and they fail differently.

| Store                       | Holds                                                                    | Loss means                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **PostgreSQL**              | Every tenant row, the configuration history, the credit ledger, invoices | The business is gone. This is the one that matters.                                                                             |
| **Object storage**          | Uploaded files, generated media, brand documents                         | Customers' own work is gone; the database still references it, so the product shows broken assets rather than an honest absence |
| **The secret vault's KEKs** | The key-encryption keys, held by the environment or a KMS                | Every stored secret is unreadable ciphertext. A database backup without its keys is not a backup                                |
| **Redis**                   | Queued jobs in flight                                                    | Recoverable. See §5 — the platform is designed so this is an inconvenience                                                      |

**The third row is the one teams get wrong.** Backing up the database and not the key material
produces a restore that comes up, authenticates nobody against a provider, and cannot decrypt a single
social token. The KEKs must be backed up **separately, by a different mechanism, with different
access** — that separation is the whole reason D-136 and D-206 gave three key domains three keys.

---

## 2. Database backup

**Deployment responsibility.** BrandSpace requires, and does not itself provide:

- **Point-in-time recovery** with a retention window of at least 30 days. `docs/DATABASE.md` §11 names
  30 days PITR plus 12 monthly snapshots as the target.
- **Backups stored in a different failure domain** from the primary — a different region or at minimum a
  different account. A backup on the same disk as the database is a copy, not a backup.
- **Encryption at rest** on the backup itself, with its own key.

**Platform capability.** Two properties of this schema make a restore materially safer than average,
and both are worth knowing before an incident:

- **Row-level security travels with the data.** Every policy is created by a migration, so a restored
  database has tenant isolation from the moment it comes up. There is no post-restore step that
  somebody can forget, and no window where the tenant role can read across workspaces.
- **The three database roles are created by `scripts/sql/setup-database-roles.sql`, not by a
  migration.** A restore into a fresh cluster therefore needs that script run FIRST, or the migration
  that grants to `brandspace_app` fails. This is the single most likely restore surprise; it is here
  rather than in a comment for that reason.

### 2.1 Verifying a backup

**Deployment responsibility, with a platform-supplied test.** An unverified backup is a belief.
Verification means restoring it somewhere and asking the database questions, not checking that a file
exists:

1. Restore into an isolated cluster.
2. Run `scripts/sql/setup-database-roles.sql` with fresh passwords.
3. Run `pnpm gate:isolation` — the D-29 gate reads the schema and fails if any tenant-owned table lost
   its RLS policy in transit.
4. Run the isolation suite (`pnpm test:isolation`) against the restored database. It is the same suite
   CI runs, and it proves tenant isolation against the actual restored rows rather than against a
   fixture.
5. Compare `SELECT count(*)` on `workspace`, `invoice`, `credit_transaction` and `ai_usage_ledger`
   against the source. Those four are the ones whose loss is not recoverable from anywhere else.

**Cadence: quarterly, and after any change to the backup configuration.** A restore drill that has
never been run is a runbook, not a capability.

---

## 3. Restore procedure

**Deployment responsibility.** The order matters, and two steps are easy to do in the wrong sequence.

1. **Stop the writers.** Scale the API and the workers to zero. A restore with writers running produces
   a database that disagrees with itself.
2. **Restore the database** to the chosen point in time.
3. **Restore, or confirm, the KEKs.** If the vault keys are not the same values, the restored data is
   ciphertext. Confirm BEFORE step 5, because discovering it after customers are back is worse.
4. **Run the role setup script** if the cluster is new.
5. **Run `pnpm db:migrate:deploy`.** A point-in-time restore may land before a migration that the code
   expects.
6. **Start the API, confirm `/health/ready` returns `ready`** — which now probes the database for real
   (Phase 10 §19) rather than answering `ok` unconditionally.
7. **Start the workers.** Queued jobs are re-dispatched by the reconciliation sweep (§5).
8. **Reconcile payments.** Any provider event delivered during the outage was either recorded before the
   restore point or will be redelivered by the provider. The webhook inbox is idempotent on the
   provider's own event id, so replaying is safe and doing nothing is not.

### 3.1 What a restore does NOT undo

- **External side effects already performed.** A social post published before the restore point stays
  published; a payment captured stays captured. The platform's record may move backwards, the world
  does not. Reconcile rather than assume.
- **Emails already sent.** The outbox row may vanish; the mail does not come back.

---

## 4. Object storage

**Deployment responsibility.** Versioning and cross-region replication on the bucket, plus a lifecycle
policy that matches the retention windows configured in `assets` and `brand-brain`.

**Platform capability.** Storage keys are `ws/<workspace>/brand/<brand>/<id>`, assigned by the caller
rather than by the driver, so a bucket's contents are attributable to a workspace without consulting
the database. That is what makes a partial restore — one customer's files — possible at all.

**The database and the bucket can be restored to different points**, and the product handles the two
directions differently, which is worth knowing:

- **Database newer than bucket**: rows reference objects that are not there. The Asset Library shows the
  asset in its stored state and the download fails. Honest, and recoverable when the bucket catches up.
- **Bucket newer than database**: orphaned objects nothing references. Harmless, and reclaimable.

---

## 5. Queue recovery

**Platform capability, and it is deliberately strong.** Redis is treated as a dispatch optimisation
rather than a system of record:

- **Every background job is idempotent and safe to retry** (CLAUDE.md §5).
- **Dispatch is not the correctness path.** `MaintenanceScheduler` in `apps/api` re-dispatches unclaimed
  ingestion work on a configured cadence (`operations.maintenance.ingestionReconcileSeconds`), so a lost
  queue message becomes a delay bounded by that interval rather than work that never happens.
- **Readiness does not depend on it** (Phase 10 §19). With Redis gone the platform serves every screen
  and every synchronous request; background work stops and says so on the health surface.

**Losing Redis entirely is therefore a degradation, not a data loss.** Flush it and let the sweep
re-enqueue.

### 5.1 Timed automations after an outage (Phase 2B-3 PR 3, D-427)

The timed G13 producers (REVIEW_WAITING_24H, CAMPAIGN_STARTED, CAMPAIGN_ENDED, SCHEDULE_GAP,
FACT_EXPIRING) run in the same maintenance sweep and keep their place in the database, not in memory.
When the API comes back after an outage, nothing needs to be run by hand:

- **Bounded catch-up.** Each rule produces at most **25** occurrences per visit
  (`TIMED_PRODUCER_LIMITS.maxOccurrencesPerVisit`); a rule with more is due again at once and continues
  from its cursor on the next sweep. Nothing is dropped, and the fair queue keeps one busy rule from
  starving the others.
- **Campaign starts and ends more than 24 hours old are not announced.** A boundary older than
  `campaignBoundaryMaxLatenessHours` when the sweep reaches it is skipped and the cursor moves past it.
  Each rule that skips some logs `timed automation occurrences skipped as late` with the count — the
  line to look for after a long outage.
- **Reviews still waiting and facts still expiring fire late**, because delivery re-checks that they are
  still true; one that stopped being true in between ends SKIPPED `occurrence_stale`.
- **A schedule gap is a state**: only whether the next three days are empty now matters, so an outage
  produces at most one gap event per rule.
- **Nothing before a rule's arming is produced**, however long the gap (D-417).

Two API replicas sweeping at once are safe: the dedupe key keeps one event per occurrence and the cursor
only moves forward. A sweep interrupted before its commit leaves neither events nor cursor behind.

---

## 6. Migrations — forward-fix, not rollback

**Platform capability and a standing policy.**

**There is no down migration in this repository, and that is deliberate.** A down migration that drops a
column is a data-loss primitive sitting in the repository waiting for somebody to run it against
production at 3am. The policy is:

- **Forward-fix.** A bad migration is corrected by a new migration.
- **Expand, migrate, contract** for anything destructive: add the new shape, backfill, switch the code,
  and remove the old shape in a LATER release — so at no point is a running version reading a shape that
  no longer exists.
- **A migration is reviewed for its lock profile.** An `ALTER TABLE` that rewrites a large table takes an
  ACCESS EXCLUSIVE lock and stops the product.
- **Migrations run from the migrator role**, which owns the schema and is never used to serve a request.
- **Every release waits for its migrations.** The api, worker, dashboard and admin report ready only
  once `_prisma_migrations` holds every migration their build was made with
  (`docs/RAILWAY-DEPLOYMENT.md` §4.4). A new migration folder therefore needs `pnpm db:manifest` in the
  same commit; the unit suite fails without it.

**If a migration must be undone**, the mechanism is a point-in-time restore (§3), not a down script.

### 6.1 Never re-run an applied migration by hand

`prisma migrate deploy` records every migration it applies and never applies one twice, so an ordinary
deploy is safe. Running a migration file again **by hand** is not: `psql -f …/migration.sql`, or
`prisma migrate resolve --rolled-back` followed by a deploy, replays SQL that was written for the
database as it stood on the day it shipped.

**`20260926090000_notes_manage_permission` is the standing example, and must never be re-run after
`20260927090000_q12_viewer_content_read`.** The notes migration grants `notes.manage` to every role
that holds `content.read`. When it first ran, the Viewer (`client_viewer`) held no `content.read`, so it
received nothing. The Q12 second release gives the Viewer `content.read`, so replaying the notes
migration afterwards would hand the Viewer `notes.manage` — the right to resolve, reopen, assign and
triage conversations, which Q12 withholds from it (D-323). Should a grant ever need repairing, write a
new, reviewed migration; do not replay an old one.

### 6.2 Rolling the application back after `SETUP` knowledge exists (D-335)

**Migration `20261003090000_setup_origin_and_goal_key` adds the value `SETUP` to the enum
`"BrandKnowledgeOrigin"`.** The migration itself is safe while the previous release is live, because that
release never writes `SETUP` and no row holds it until the new release writes one. It is **not** safe to
run the previous release against a database in which the new release has already written `SETUP` rows:

- the previous release's Prisma client does not know the value and **fails when it reads such a row**
  (`brand_knowledge_item.origin` or `brand_knowledge_version.origin`) — Brand Brain, retrieval for AI
  context, Strategy and Create all read those rows;
- its precedence table (`originRank`) does not know the value either;
- **PostgreSQL cannot remove an enum value in place**, so the migration cannot simply be reversed, and
  §6's policy forbids a down script anyway.

**The procedure, in this order:**

1. **Do not route traffic to the previous release yet.** Keep the current release serving, or put the
   product in maintenance, while steps 2–3 happen.
2. **Ship a forward corrective migration**, reviewed like any other and deployed through the normal
   `prisma migrate deploy` path (never by hand, §6.1). It rewrites every `SETUP` origin to `DOCUMENT`, the
   origin that shares its precedence rank (HUMAN, then SETUP = DOCUMENT, then AI_INFERRED), so no
   precedence decision changes. The enum value stays defined but unused.
3. **Verify** that `SELECT count(*) FROM "brand_knowledge_item" WHERE "origin" = 'SETUP'` and the same
   count on `"brand_knowledge_version"` are both `0`.
4. **Only then** may the previous application release serve traffic.

`brand.primaryGoalKey` needs nothing: the previous release neither reads nor writes it. The Setup label
is lost by the rewrite (those facts read "From a document"); the text, versions and precedence are
unchanged.

**The exact SQL of that future corrective migration.** It is documented here and deliberately **not**
added to the migration chain now; nothing in this repository runs it, and it must never be run by hand
against a real database. Two protections have to be lifted for the rewrite and are put back in the same
transaction, exactly as earlier data migrations do: both tables are under FORCE row-level security, which
binds even their owner (the migrator role), so without `NO FORCE` the UPDATEs would silently change
nothing; and `brand_knowledge_version` is append-only (its trigger refuses every UPDATE, D-65). FORCE is
then asserted rather than assumed.

```sql
-- Forward corrective migration: SETUP knowledge becomes DOCUMENT (same rank, D-335),
-- so a release that predates SETUP can read every row again. Run only as a reviewed
-- migration through `prisma migrate deploy`, never by hand.
BEGIN;

ALTER TABLE "brand_knowledge_item" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_version" NO FORCE ROW LEVEL SECURITY;

UPDATE "brand_knowledge_item"
   SET "origin" = 'DOCUMENT', "updatedAt" = now()
 WHERE "origin" = 'SETUP';

-- The history is append-only (D-65). This rewrite is the one sanctioned exception:
-- it changes the origin label only, never text, version numbers or authorship.
ALTER TABLE "brand_knowledge_version" DISABLE TRIGGER brand_knowledge_version_append_only;
UPDATE "brand_knowledge_version"
   SET "origin" = 'DOCUMENT'
 WHERE "origin" = 'SETUP';
ALTER TABLE "brand_knowledge_version" ENABLE TRIGGER brand_knowledge_version_append_only;

ALTER TABLE "brand_knowledge_item" FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_version" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid IN ('"brand_knowledge_item"'::regclass, '"brand_knowledge_version"'::regclass)
       AND (relrowsecurity IS NOT TRUE OR relforcerowsecurity IS NOT TRUE)
  ) THEN
    RAISE EXCEPTION 'brand knowledge tables must have RLS ENABLED and FORCED after this migration';
  END IF;
END $$;

COMMIT;
```

(Prisma runs a migration file inside its own transaction; in the actual migration file the explicit
`BEGIN`/`COMMIT` lines are therefore omitted, and the statements run as one unit.)

### 6.3 The live-slot index is forward-only (Phase 2B-2, item 9, D-332 amended)

`20261006130000_calendar_slot_live_excludes_failed` narrows the partial unique index
`calendar_slot_one_live_per_item` from `status <> 'CANCELLED'` to `status NOT IN ('CANCELLED',
'FAILED')`, so a post that failed with nothing published can be scheduled again as a NEW slot while the
old FAILED slot stays as history.

**It is forward-only.** As soon as any post has a FAILED slot and a newer slot, the previous, stricter
index cannot be recreated — the rows it would forbid now exist, and they are correct history. Never
replay an older index definition by hand.

- **Rolling the APPLICATION back is safe** without touching the index: the previous release counts a
  FAILED slot as live, so it simply refuses to schedule such a post again; every read still works, and
  the looser index never forbids anything it does.
- **If the stricter rule is ever wanted again**, it is a NEW migration that first decides what to do
  with the posts that hold two slots (for example, cancel the older FAILED slot, keeping its jobs), and
  only then recreates the index — reviewed like any destructive change (§6).

### 6.4 Phase 2C-1: "Use Brand Brain" and "valid until" on an application rollback (D-355, D-356)

Both migrations only ADD columns with safe defaults, so they are safe while the previous release is live,
and rolling the APPLICATION back needs no database change — but two customer promises lapse until the
new release is back:

- **`20261007090000_brand_use_brand_brain`** (`brand.useBrandBrain`, default `true`). The previous
  release does not read the column, so a brand that switched Brand Brain off is grounded on its approved
  facts again by captions, tools, Creative, Strategy and the Copilot.
- **`20261007100000_knowledge_valid_until`** (`validUntil` on `brand_knowledge_item` and
  `brand_knowledge_version`, `brand_knowledge_item.supersededByItemId`). The previous release does not
  read `validUntil`, so **an EXPIRED fact is usable again and grounds AI writing** until the new release
  returns, or until someone clears the date or archives the fact. A fact archived as superseded stays
  archived; the previous release simply ignores the link.

**Release note for the operator:** if the application must be rolled back past Phase 2C-1, tell the
affected customers (or archive the expired facts that matter) before routing traffic to it. Never drop
the columns to "undo" the migrations (§6); the next forward release reads them again unchanged.

### 6.5 Phase 2C-2: `brand_font` and typography v2 on an application rollback (D-363, D-364)

`20261007110000_brand_font` only ADDS a table, so it is safe while the previous release is live. If the
application is rolled back past Phase 2C-2:

- The previous release does not read `brand_font`, and reads a v2 `brand.typography` value
  (`{ en, ar }`) as no fonts, so the asset kit, Creative's identity card and generation show no brand
  fonts until the new release returns. Nothing is deleted.
- **The previous release's Settings → Brand save rewrites `brand.typography` as a v1
  `{ heading, body }`.** A brand saved there during the rollback loses its four slots and, once the new
  release is back, reads its v1 names as the English slots (the "legacy name" fallback). Uploaded
  fonts themselves are kept in `brand_font` and can be chosen again from Look & voice.

**Release note for the operator:** if a rollback past Phase 2C-2 is needed, tell customers that font
choices made in Look & voice may need to be picked again. Never drop the table to "undo" the migration
(§6).

### 6.6 Phase 2C-3: MEMBER candidates, recorded usage, and an application rollback (D-369 – D-383)

Three migrations, with **different** rollback characteristics. Do not treat them alike.

- **`20261008100000_content_knowledge_usage` (M5)** only ADDS a table. The previous release neither reads
  nor writes it, so an application rollback needs no database change: the Studio shows no "Used N Brand
  Brain facts", Home shows no changed-fact item and "Used in N posts" disappears until the new release is
  back. The rows are kept and are read again, unchanged, by the next forward release. Never drop the
  table to "undo" the migration (§6).
- **`20261008090000_candidate_source_member` (M4a)** adds the value `MEMBER` to the enum
  `"BrandCandidateSource"`, and **`20261008091000_candidate_member_check` (M4b)** adds
  `brand_knowledge_candidate.proposedByUserId` and the MEMBER branch of the candidate CHECK. Both are
  safe while the previous release is live — it never writes `MEMBER` and never sets the column — **but
  they are NOT simply rollback-safe once the new release has written a MEMBER candidate** ("Send for
  review", D-377):
  - the previous release's Prisma client does not know the value `MEMBER` and **fails when it decodes
    such a row**: its review inbox (`status = 'PENDING'`) and its "accept the confident ones" preview
    both read pending candidates with their `sourceKind`, so ONE pending MEMBER candidate breaks the
    Brand Brain page for that brand;
  - **PostgreSQL cannot remove an enum value in place**, and §6's policy forbids a down script.

**The procedure, in this order** (the same shape as §6.2):

1. **Do not route traffic to the previous release yet.** Keep the current release serving, or put the
   product in maintenance, while steps 2–3 happen.
2. **Ship a forward corrective migration**, reviewed like any other and deployed through the normal
   `prisma migrate deploy` path (never by hand, §6.1). It **rejects every PENDING MEMBER candidate** —
   the reviewer is recorded as nobody (`reviewedByUserId` NULL), the reason as `release_rollback`, and
   one `brand_brain.candidate.rejected` audit event is written per candidate (actor `SYSTEM`) naming the
   candidate, its area and key, and why. **Nothing is deleted**: the candidate rows, their proposer
   (`proposedByUserId`), their proposed text and the original `brand_brain.fact.proposed` audit events all
   stay. The enum value stays defined.
3. **Verify** that `SELECT count(*) FROM "brand_knowledge_candidate" WHERE "sourceKind" = 'MEMBER' AND
"status" = 'PENDING'` is `0`.
4. **Only then** may the previous application release serve traffic.

**What the previous release can and cannot decode afterwards — verified against the previous release's
code (`staging` at the Phase 2C-2 merge).** Every list it reads is filtered to PENDING (the review inbox,
the confident-candidates preview, the setup wizard's review step — which also filters
`sourceKind = 'DOCUMENT'`), is a count or a group-by that decodes no `sourceKind`, or selects only
`brandId` (`setupReviewInProgress`), or is filtered by a document or an insight that a MEMBER row does
not have (ingestion, `proposeLearning`). So after step 2 no list, count or page of the previous release
decodes a MEMBER row. The ONE remaining read is a review submitted for a specific candidate id
(`reviewCandidate` loads the whole row): a stale review form for a MEMBER candidate that was open before
the rollback would fail with a server error instead of "already reviewed". Nothing is written by that
failure. The rejected MEMBER rows become readable again, unchanged, when the new release returns; the
members whose proposals were rejected by step 2 must send them again.

**The exact SQL of that future corrective migration.** It is documented here and deliberately **not**
added to the migration chain; nothing in this repository runs it, no application script, worker or job
implements it, and it must never be run by hand against a real database. `brand_knowledge_candidate` and
`audit_event` are under FORCE row-level security, which binds even their owner (the migrator role), so
FORCE is lifted for the statements and put back in the same transaction, then asserted rather than
assumed — exactly as §6.2's corrective migration does.

```sql
-- Forward corrective migration: before an application rollback past Phase 2C-3,
-- reject every PENDING MEMBER candidate so the previous release (which does not
-- know BrandCandidateSource.MEMBER) never decodes one. Nothing is deleted; each
-- rejection is audited. Run only as a reviewed migration through
-- `prisma migrate deploy`, never by hand.
BEGIN;

ALTER TABLE "brand_knowledge_candidate" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_event" NO FORCE ROW LEVEL SECURITY;

-- The audit trail first: one event per candidate being rejected, written while
-- the candidates are still PENDING so the same predicate selects them.
INSERT INTO "audit_event"
  ("id", "workspaceId", "occurredAt", "actorType", "action", "resourceType",
   "resourceId", "brandId", "severity", "outcome", "reason", "after")
SELECT gen_random_uuid(), c."workspaceId", now(), 'SYSTEM',
       'brand_brain.candidate.rejected', 'BrandKnowledgeCandidate',
       c."id", c."brandId", 'NOTICE', 'SUCCESS', 'release_rollback',
       jsonb_build_object('area', c."area", 'itemKey', c."itemKey",
                          'sourceKind', 'MEMBER', 'reason', 'release_rollback')
  FROM "brand_knowledge_candidate" c
 WHERE c."sourceKind" = 'MEMBER' AND c."status" = 'PENDING';

UPDATE "brand_knowledge_candidate"
   SET "status" = 'REJECTED',
       "reviewedAt" = now(),
       "reviewReason" = 'release_rollback'
 WHERE "sourceKind" = 'MEMBER' AND "status" = 'PENDING';

ALTER TABLE "brand_knowledge_candidate" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "brand_knowledge_candidate"
     WHERE "sourceKind" = 'MEMBER' AND "status" = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'a PENDING MEMBER candidate remains';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid IN ('"brand_knowledge_candidate"'::regclass, '"audit_event"'::regclass)
       AND (relrowsecurity IS NOT TRUE OR relforcerowsecurity IS NOT TRUE)
  ) THEN
    RAISE EXCEPTION 'RLS must be ENABLED and FORCED after this migration';
  END IF;
END $$;

COMMIT;
```

(As in §6.2, Prisma runs a migration file inside its own transaction; in the actual migration file the
explicit `BEGIN`/`COMMIT` lines are omitted. `gen_random_uuid()` is built into PostgreSQL 13+.)

**Release note for the operator:** tell the affected workspaces that facts sent for review in the new
release were declined by the rollback and need sending again once it is back; "Used N Brand Brain facts",
the changed-fact banner and Home's changed-fact item are absent while the previous release serves.

---

### 6.7 Phase 2C-4: the live-checksum index (M6) and the knowledge signature (M7) (D-395, D-400)

`20261009090000_brand_source_live_checksum` replaces the unique index on `brand_source_document
(workspaceId, brandId, checksum)` with a partial unique index on the same key `WHERE "deletedAt" IS
NULL`, so a removed source releases its checksum.

- **Rolling the APPLICATION back is safe** without touching the index. The previous release reads and
  writes live rows only, its duplicate check already filters `deletedAt IS NULL`, and it has no Remove.
  Removed sources stay removed; FAILED rows written by this release read as FAILED with a reason the
  previous release shows through its general message.
- **The index is forward-only once a file has come back.** As soon as a brand holds a removed document
  and a live one with the same checksum, the older, stricter index cannot be recreated — the rows it
  would forbid are correct history. Never replay the old definition by hand; if the stricter rule were
  ever wanted, it is a NEW, reviewed migration that first decides what happens to those rows (§6).

`20261009100000_insight_knowledge_signature` adds a nullable column. The previous release ignores it;
dropping it loses only the baselines, after which every strategy reads as "no baseline" and never
alerts.

### 6.8 Phase 2B-3: the G13 enum values and `PREFLIGHT_REFUSED` are forward-only (D-404, D-414)

M1a (`20261010090000_automation_g13_trigger_values`), M1b
(`20261010091000_automation_g13_action_values`) and M2
(`20261011090000_publish_attempt_preflight_refused`) only ADD enum values; M1c
(`20261010092000_automation_g13_checks_and_state`) widens CHECKs and adds two nullable columns. All four
are safe while the previous release is live. **PostgreSQL cannot remove an enum value in place**, and
§6's policy forbids a down script, so none of them is reversed — ever. (M1a's, M1b's and M1c's comments
point at §6.3 for this caveat; this section is where it is written down. Applied migrations are never edited,
§6.1.)

- **Rolling the APPLICATION back from Phase 2B-3 PR 2 needs no database change.** Nothing in the previous
  release decodes a `publish_attempt.outcome` (its only read of the table is the highest
  `attemptNumber`), so `PREFLIGHT_REFUSED` rows are inert to it. They stay, immutable (DATABASE.md
  §17.3), and the next forward release reads them again.
- **What lapses until the new release is back:** failures stop concluding with an attempt row and stop
  raising POST_FAILED; a stored rule on a G13 action (NOTIFY_PERSON, ADD_TO_CAMPAIGN,
  SCHEDULE_NEXT_FREE_SLOT, MAKE_DRAFT_COPY) is not executable in the previous release, so its runs act on
  nothing — one that reaches its action is recorded FAILED `unknown_action`; `armedAt` is ignored, so an
  enabled rule may react to an event from before it was armed; CONTENT_APPROVED is keyed by item again.
  No data is lost or rewritten by any of these.
- **Never "undo" M2 by rewriting rows.** `publish_attempt` is immutable by trigger for every role; the
  evidence is correct history.

### 6.9 Phase 2B-3 PR 3: no migration; rolling the application back (D-434)

PR 3 adds no migration (DATABASE.md §18.11), so **rolling the application back from PR 3 needs no
database change**. What differs until the new release is back:

- **No timed event is produced.** The previous release's sweep has no producer for the five timed
  triggers; `dueWatermark` and the SCHEDULE_GAP edge memory are left as they are and resume on the way
  forward (nothing before a rule's arming is produced, D-417).
- **An event produced before the rollback and not yet delivered is delivered by the previous worker,
  WITHOUT the occurrence re-check.** Its engine does not check the trigger: a NOTIFY_PERSON rule on a
  timed trigger sends its `automation.notice` (with PR 2's live recipient check) even if the review was
  decided in between; a REMIND_REVIEWER rule ends `FAILED unknown_action` and sends nothing, as every
  non-executable action does there. To avoid either, let the outbox drain (the dispatch sweep, §5)
  before rolling back.
- **`approval.reminder` rows already written stay**; the previous release has no words for the key, so
  the notification feed shows its generic headline and the notifications page shows the key.

No data is lost or rewritten.

### 6.10 Phase 2B-3 PR 4: M3's indexes, and rolling the application back (D-435 – D-441)

M3 (`20261012090000_…`, `20261012091000_…`, `20261012092000_…`) only creates three indexes, each with
`CREATE INDEX CONCURRENTLY IF NOT EXISTS` as the file's single statement (DATABASE.md §18.12). While one
builds, `metric_observation` or `publish_job` keeps taking reads and writes; the build waits for
transactions already running on the table, so a long transaction delays the build, not the other way
round.

- **A failed or interrupted build leaves an INVALID index**, which PostgreSQL maintains on writes but
  never uses. Find it with
  `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`
  then `DROP INDEX CONCURRENTLY IF EXISTS "<name>";` and deploy again — `IF NOT EXISTS` would otherwise
  skip the rebuild. Never mark it valid by hand.
- **Removing an M3 index** (only if one is shown to hurt): `DROP INDEX CONCURRENTLY IF EXISTS "<name>";`,
  one statement per session, outside a transaction. It does not block writes either. The migration stays
  recorded as applied (§6.1); the queries still run, only slower. Put the index back with the migration's
  own statement.
- **Rolling the APPLICATION back from PR 4 needs no database change.** The previous release neither
  reads nor needs the indexes, and its configuration schema drops the unknown `events` block when it
  parses the `automations` document.
- **What lapses until the new release is back:** neither analytics event is produced; the cursors and
  the weekly edge memory are left as they are and resume on the way forward (nothing before a rule's
  arming is produced, D-417). The previous release treats the two triggers as not yet authorable, so rules
  on them stay stored and cannot be created. An event produced before the rollback and not yet delivered
  would be delivered WITHOUT the occurrence re-check — let the outbox drain (§5) before rolling back.

No data is lost or rewritten.

### 6.11 F6: `brandScope` never NULL — the lock timeout and what to do if it fires (D-442, D-443)

`20261013090000_brand_scope_not_null` is ONE explicit transaction. It takes ACCESS EXCLUSIVE on
`membership` and `invitation` from its first `ALTER TABLE` until COMMIT, so while it runs every
request that reads a membership — every signed-in request — waits. It is quick: about 60 ms on a few
thousand rows, about 9 s on 500,000 memberships of which half were NULL, nearly all of it the
backfill.

**The lock timeout.** The migration starts with `SET LOCAL lock_timeout = '5s'` (owner decision D1).
If a long transaction holds a lock on either table, the migration does not queue every request behind
itself: after five seconds it stops with `canceling statement due to lock timeout`, and the whole
transaction rolls back — FORCE was never left lifted, no row changed, the column stays nullable.

**If it times out:**

1. **Nothing is broken, and nothing is urgent.** The application keeps working on the old schema:
   every reader treats NULL and `{}` the same (`brandInScope` and the scope filters), so the only
   effect of waiting is that owners stored NULL still miss the three `resolveRecipients` notices
   (`automation.confirmation_required`, a NOTIFY rule's `automation.notice`,
   `brand_brain.learning_proposed`), as they did before.
2. **Tell Prisma the attempt rolled back** — it records a failed migration and refuses to deploy
   past it:

   ```sh
   pnpm --filter @brandspace/database exec prisma migrate resolve --rolled-back 20261013090000_brand_scope_not_null
   ```

   Run it with `DATABASE_MIGRATION_URL` pointing at the migrator role for that environment, from a
   trusted operator shell. This only updates `_prisma_migrations`; it runs no SQL on the tables.
   It is NOT the replay §6.1 forbids: a timed-out F6 never committed, so nothing of it was applied.
   Confirm that first — `attnotnull` still false and FORCE still on:

   ```sql
   SELECT c.relname, c.relforcerowsecurity, a.attnotnull
     FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'brandScope'
    WHERE c.relname IN ('membership', 'invitation');
   ```

3. **Find what held the lock** before retrying, if it may still be there:

   ```sql
   SELECT pid, state, xact_start, left(query, 80) AS query
     FROM pg_stat_activity
    WHERE xact_start < now() - interval '5 seconds' AND datname = current_database()
    ORDER BY xact_start;
   ```

4. **Redeploy** (the normal release path runs `prisma migrate deploy`). The migration runs from the
   start; it is safe to run again.

Never raise the timeout inside the applied file (§6.1), and never run the statements by hand
outside one transaction: FORCE must never be observable as lifted.

**Rolling the application back after F6** needs no database change. The previous release's inserts
leave the column out and now get `{}`; it reads `{}` exactly as it read NULL. Forward-only (§6): no
down script; NULL cannot be restored and would mean the same thing.

## 7. Secret rotation

**Platform capability.** Every provider credential is a REFERENCE in configuration and a row in the
vault, so rotating one is a Control Center action rather than a deploy:

1. Store the new value in **Platform Admin → Secrets**. The write is audited; the value is never
   readable again.
2. **Test Connection** from **Platform Admin → Integrations**, which records the outcome against the
   provider (Phase 10 §10).
3. Activate.

`SECRET_CATEGORY_DEFINITIONS` records, per family, whether zero-downtime rotation is possible — most AI
providers accept several live keys, most payment providers do not. That flag is the difference between
rotating during business hours and needing a window.

**KEK rotation is different and harder.** The three key-encryption keys wrap every data key in the
vault. Rotating one means re-wrapping, which requires both the old and the new key present at once.
`KeyProvider` is the seam that makes this possible without touching any caller — `wrapDataKey` /
`unwrapDataKey` and nothing else — and moving to a cloud KMS is a new implementation of that one file.

**Owner decision.** Which KMS, and the rotation cadence it enforces. Until one is chosen,
`LocalDevelopmentKeyProvider` is the only implementation and it refuses to run in production, so this
decision blocks production rather than being silently deferred.

---

## 8. Incident response basics

**Platform capability** — what is already available when something goes wrong:

| Question                                      | Where the answer is                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Is the platform serving traffic?              | `/health/ready` — a real probe, with `not_ready` reserved for a required dependency being down |
| What is degraded?                             | The same response's `degradedCapabilities`, and the Control Center health screen               |
| Did a provider stop working?                  | **Integrations**, which records every connection check including the refusals                  |
| Who changed what, and when?                   | The audit log. Every state change writes an `AuditEvent` (CLAUDE.md §5)                        |
| What did this configuration look like before? | Configuration version history, with rollback                                                   |
| Did a customer's payment actually go through? | The billing event inbox, with the reconciled outcome per provider event                        |
| What did this AI request cost?                | The AI usage explorer, per request, with the cost basis it was charged under                   |

### 8.1 The first three actions

1. **Establish whether data is at risk.** If yes, stop the writers before investigating. An hour of
   downtime is recoverable; an hour of corruption may not be.
2. **Capture the evidence before changing anything.** The audit log and the configuration history are
   append-only and will still be there; a process's memory will not.
3. **Say what is happening.** An incident nobody outside the response knows about is two incidents.

### 8.2 Credential compromise

Rotate first, investigate second — §7 makes rotation a minutes-long Control Center action, and a
credential that might be compromised should be treated as compromised.

- **A provider credential**: rotate it, then read the Integrations verification history to see when it
  last worked.
- **A KEK**: this is the severe case. Every secret sealed under it must be re-wrapped, and until that is
  done the old key cannot be destroyed. Plan for it to take hours, not minutes.
- **A platform user's session**: revoke the session; MFA is mandatory for platform roles (D-27), so a
  password alone does not admit anybody.

---

## 9. RPO and RTO

**Owner decision, and deliberately unfilled.**

| Target                         | Value | Depends on                                                                                                            |
| ------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------- |
| **RPO** — acceptable data loss | _TBD_ | The hosting provider's PITR granularity, and the commercial answer to "how much billing data may we lose"             |
| **RTO** — acceptable downtime  | _TBD_ | A timed restore drill (§2.1). Until one has been run, any number here would be a guess                                |
| **Backup retention**           | _TBD_ | The longest of: the tax retention obligation in each market sold to, and the contractual commitment made to customers |

**These are blank on purpose.** Writing "RPO: 5 minutes" without a provider that offers it, or "RTO: 1
hour" without having timed a restore, would be the most dangerous kind of documentation: a number a
team plans around that nothing supports.

The first restore drill produces the RTO. The chosen hosting plan produces the RPO. Both belong in
`docs/DECISIONS.md` when they are made.

---

## 10. What Phase 10 deliberately did not build

- **A metrics backend.** Request volume, queue depth over time and latency histograms need a
  time-series store, and choosing one is an owner decision (D-217). The platform emits structured logs
  and spans through a provider-neutral boundary; nothing here is blocked on the choice except the
  charts.
- **An alerting configuration.** Thresholds are a function of the traffic a deployment actually sees.
- **A status page.** It is a public-website feature and an external hosting decision.
- **Automated backup verification.** §2.1 is a procedure a person runs. Automating it needs an
  environment to run in.

---

## 11. CI headroom (D-454)

Two CI limits were raised on measurement. Nothing was skipped, hidden or weakened, and the retries,
workers, sharding, reporter and test selection did not change.

- **Typecheck heap: 4 GB.** `pnpm typecheck` runs in one step of the "Format, lint, typecheck" job,
  now with `NODE_OPTIONS=--max-old-space-size=4096`. The `tests` package alone needs about 2.7 GB on
  staging @ `2672bad` (`tsc --extendedDiagnostics` reports `Memory used: 2,728,528K`), which is at
  the runner's default Node heap. It crashed with `JavaScript heap out of memory` on PR #63, a
  change that did not move the measurement (2,733,768K).
- **Playwright E2E job: 60 → 90 minutes.** A normal run of the 1,041 tests takes about 47 minutes
  for Playwright alone (PR #63, first run on `51642f8`: 47.2 m; the job 50.5 m). A slower runner
  then went past 60 minutes twice with no failure in the code under review: 594 and 647 of 1,041
  tests finished at the cancel, and a full local run of PR #63's head (`d401fb3`) had no failures.

- **Test names in the CI log.** The CI reporters are `dot`, `list`, `html` and `json`; `list` was
  added so a run cancelled before its summary still names each test, its status and its duration.

- **Two E2E shards (D-455).** The Playwright job runs as two shards by project, each with its own
  database and seed; the check named "Playwright E2E (RTL/LTR + accessibility)" is now an aggregate
  that passes only when both shards pass. A coverage step fails a shard if the two lists stop covering
  the whole suite exactly once — a new project must be added to one of them.

- **Per-test timeout: 30 → 45 seconds (D-456).** The tests that timed out ran 31–36 s on the slower
  runners. Retries, the `expect` timeout and assertions are unchanged.

**Tracked for the final review:**

- The type-checking cost of the `tests` package, and whether two E2E shards stay enough as the suite
  grows. Raising a ceiling again is not the answer to a suite that keeps growing.
- **Production risk — overlapping maintenance sweeps under load.** `MaintenanceScheduler.start()`
  runs each sweep on `setInterval` with `void run()` and no in-flight guard, so a pass slower than its
  interval starts another on top of it and they compete for the database. It is not active in the
  measured runs (about 3 s of database time per 11 minutes of E2E), but under production load a slow
  pass would compound. The proposed fix — skip a tick while the previous pass is still running — is
  deferred by owner decision on #64.
