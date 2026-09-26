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

---

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
