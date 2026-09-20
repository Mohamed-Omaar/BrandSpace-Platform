/**
 * The webhook inbox and the reconciler — where a payment becomes a fact (§28).
 *
 * THE ORDER OF OPERATIONS IS THE SECURITY PROPERTY:
 *
 *   1. VERIFY THE SIGNATURE OVER THE RAW BYTES, before parsing. Parsing first
 *      and verifying the re-serialized result verifies a different document from
 *      the one that was signed.
 *   2. A FAILED VERIFICATION WRITES NOTHING AT ALL. Not a row, not an audit
 *      event, not a counter. An unauthenticated caller must not be able to make
 *      us store anything they chose — and "we log every rejected event" is how a
 *      table becomes an attacker's storage.
 *   3. RECORD BEFORE APPLYING. The event lands in `billing_event` with the
 *      provider's own id as a unique key, so a replay collides and is recorded
 *      as a DUPLICATE that changes nothing.
 *   4. RESOLVE THE WORKSPACE FROM A RELATIONSHIP WE WROTE — `billing_profile`,
 *      `checkout_session`, `workspace_subscription`, `invoice` — never from the
 *      event body. An event that cannot be tied to one of those is UNRESOLVED:
 *      kept, visible, and applied to nothing. Guessing would be worse than
 *      losing it.
 *   5. COMPARE THE PROVIDER'S TIMESTAMP AGAINST THE STATE IT DESCRIBES. An
 *      event older than what we already applied is STALE: recorded, deliberately
 *      not applied, so an out-of-order delivery cannot wind a subscription
 *      backwards.
 *   6. COMPARE THE AMOUNT AGAINST OUR OWN ROW. A provider event whose amount or
 *      currency does not match what we priced is a FAILURE, not a payment
 *      (§37) — the whole point of having written the amount down first.
 *
 * AND THE ONE THAT UNDERPINS ALL OF IT: NOTHING IS MARKED PAID ANYWHERE ELSE.
 * The browser's success redirect is navigation. `commerce.checkout
 * .trustBrowserRedirect` is the literal `false` so this cannot be configured
 * away (§22).
 */

import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, TenantScopedClient } from '@brandspace/database';
import { writeAuditEvent } from '@brandspace/database';
import type { PlanDetail } from '@brandspace/entitlements';
import { findPlan, termsFor } from '@brandspace/entitlements';
import { AppError, Money, type Clock, systemClock } from '@brandspace/shared';
import type {
  NormalizedBillingEvent,
  NormalizedBillingEventType,
  ProviderRegistry,
} from './adapter';
import { NORMALIZED_BILLING_EVENT_TYPES } from './adapter';
import { taxPolicyFor, type CommercePolicy, type LocalizedText } from './commerce';
import { InvoiceService, type InvoiceLineInput } from './invoices';
import type { TaxAssessment } from './tax';
import { nextDunningStep, normaliseFailureCode } from './dunning';

/**
 * The client `receive` needs, and why it is not a `TenantScopedClient`.
 *
 * THE INBOX AND THE SETTLEMENT RUN ON DIFFERENT TRANSACTION BOUNDARIES, on
 * purpose (see `#ingest`), so this method is the one place in the billing
 * package that must be able to OPEN a transaction. `TenantScopedClient` hides
 * `$transaction` precisely to say "you are already inside one" — which was true
 * of every method below and false of this one. The route papered over the
 * difference with `as never`, and the result was a settlement that autocommitted
 * statement by statement while two comments in this file asserted it was atomic.
 *
 * Naming the real requirement in the type is the fix. Everything `#apply`
 * reaches still takes a `TenantScopedClient`, because everything `#apply`
 * reaches genuinely is inside the transaction this opens.
 */
export type ReconcilerClient = PrismaClient;

export type EventOutcome =
  | 'PROCESSED'
  | 'DUPLICATE'
  | 'STALE'
  | 'UNRESOLVED'
  | 'FAILED'
  | 'RETRYABLE'
  | 'DEAD_LETTER'
  | 'IN_PROGRESS';

/**
 * How long one settlement may take.
 *
 * A settlement is several writes plus an invoice-number allocation that takes a
 * row lock, so Prisma's 5s interactive-transaction default is the wrong budget.
 * Fifteen seconds is long enough for a slow allocation under contention and far
 * short of any provider's delivery timeout.
 */
const SETTLEMENT_TIMEOUT_MS = 15_000;

/**
 * How long a processing claim is honoured before another delivery may take it.
 *
 * DELIBERATELY LONGER THAN THE SETTLEMENT TIMEOUT, and by a wide margin. The
 * lease exists for one case only — the process holding the claim died without
 * releasing it — so it must never expire under a settlement that is merely
 * slow. A settlement is bounded at `SETTLEMENT_TIMEOUT_MS`; four times that
 * leaves room for the surrounding statements and for a paused container, and a
 * minute of delay on a dead claim is invisible next to a provider's own
 * redelivery interval.
 *
 * IT ASSUMES THE APPLICATION CLOCKS AGREE TO WITHIN A MINUTE. Both the stamp
 * and the comparison come from `Clock`, so two API instances skewed by more
 * than the lease could each believe the other's live claim had expired. That
 * is an infrastructure fault rather than a race — NTP skew is measured in
 * milliseconds — and the per-path idempotency guards (the checkout's COMPLETED
 * status, `creditGrantId`'s uniqueness, `PaymentAttempt`'s idempotency key)
 * still sit underneath. Reading the cutoff from the database instead would
 * remove the assumption at the cost of raw SQL on the hot path; if that trade
 * ever looks worth making, this is the comment to come back to.
 */
const CLAIM_LEASE_MS = 60_000;

/**
 * How many times one event may be attempted before it dead-letters.
 *
 * THE SAME NUMBER THE QUEUE DEFINITION DECLARES for `billing-events`, and
 * `tests/unit/billing-retry-policy.test.ts` fails if the two ever drift. It is
 * repeated rather than imported because `@brandspace/billing` does not depend
 * on `@brandspace/jobs` and should not acquire the dependency for one integer.
 */
export const MAX_DELIVERY_ATTEMPTS = 8;

/**
 * Inbox statuses that mean "this event reached a decision, and no delivery of
 * it will ever change anything again".
 *
 * `RECEIVED` and `RETRYABLE` are deliberately absent: the first means a
 * delivery did not finish, the second means it finished by rolling back for a
 * reason that may not recur. Both must be re-attemptable. `PROCESSING` is
 * absent too, but for the opposite reason — it is not settled, it is somebody
 * else's right now, and the claim below is what decides that.
 *
 * `FAILED` IS TERMINAL AGAIN, AND THAT IS THE POINT OF THIS CHANGE rather than
 * a reversal of the last one. §20 defines FAILED as "the amount or currency
 * does not match our row": a deterministic comparison of stored data against
 * event data, which every redelivery would answer identically. Retrying it
 * forever is not resilience. What the previous fix actually needed was for a
 * TRANSIENT failure to stop being called FAILED, which is what `RETRYABLE` is.
 *
 * `DEAD_LETTER` is terminal by construction: it is the state reached when
 * retrying has already been tried and exhausted.
 *
 * `UNRESOLVED` AND `STALE` STAY TERMINAL, as a decision rather than an
 * omission. An unresolved event is one we could not tie to a workspace through
 * a mapping we wrote; the header's rule is that guessing would be worse than
 * losing it, and the row is kept visible for an operator precisely so somebody
 * decides. A stale event describes state older than what we already applied, so
 * re-applying it is the thing staleness exists to prevent.
 */
const SETTLED_INBOX_STATUSES: ReadonlySet<string> = new Set([
  'PROCESSED',
  'STALE',
  'UNRESOLVED',
  'DUPLICATE',
  'FAILED',
  'DEAD_LETTER',
]);

/**
 * Statuses a delivery may claim.
 *
 * `PROCESSING` is not here: it is claimable only through the separate expired-
 * lease branch, which carries its own time predicate.
 */
const CLAIMABLE_INBOX_STATUSES = ['RECEIVED', 'RETRYABLE'] as const;

/**
 * The `AppError` codes that mean "this event will never apply", as opposed to
 * "this attempt did not apply it".
 *
 * WHY A LIST AND NOT `error instanceof AppError`. Every deliberate refusal in
 * the apply phase is a CONFLICT — the provider's amount does not match the
 * agreed amount, the invoice, or a plan or pack that no longer exists. Those
 * are decisions about the money, reached by comparing rows we hold against an
 * event we were sent, and a redelivery reaches the same decision. Everything
 * else that can escape a settlement is infrastructure: a dropped connection, a
 * deadlock, a statement timeout, a unique-constraint collision with a
 * concurrent attempt.
 *
 * THE DEFAULT IS RETRYABLE, WHICH IS THE SAFE DIRECTION. Misclassifying a
 * transient failure as terminal loses a customer's money silently; the reverse
 * costs at most `MAX_DELIVERY_ATTEMPTS` redeliveries before the row
 * dead-letters with an alert on it. So this set is enumerated, and anything
 * unrecognised retries.
 */
const TERMINAL_FAILURE_CODES: ReadonlySet<string> = new Set(['CONFLICT']);

/** Did the apply refuse the event, or merely fail to finish applying it? */
function isTerminalFailure(error: unknown): error is AppError {
  return error instanceof AppError && TERMINAL_FAILURE_CODES.has(error.code);
}

/**
 * The inbox columns every decision in this file is made from — named once, so
 * the claim, the reload and the create cannot drift into reading different
 * things about the same row.
 */
const INBOX_SELECT = {
  id: true,
  status: true,
  resolvedWorkspaceId: true,
  attempts: true,
} as const;

interface InboxRow {
  readonly id: string;
  readonly status: string;
  readonly resolvedWorkspaceId: string | null;
  readonly attempts: number;
}

export interface DeliveryRejected {
  readonly accepted: false;
  /** Safe to log and to return. Never the signature, the body or the secret. */
  readonly reason: string;
}

export interface DeliveryAccepted {
  readonly accepted: true;
  readonly results: readonly EventResult[];
}

export interface EventResult {
  readonly billingEventId: string;
  readonly externalEventId: string;
  readonly type: string;
  readonly outcome: EventOutcome;
  readonly workspaceId: string | null;
  readonly failureReason: string | null;
}

export type DeliveryResult = DeliveryAccepted | DeliveryRejected;

/**
 * Granting prepaid credits, as a port.
 *
 * WHY A PORT AND NOT A DIRECT CALL. The ledger is Phase 3's and stays Phase 3's
 * (§1 — do not duplicate the credit ledger). This package needs exactly one
 * thing from it: "grant these credits, once, inside the transaction I am already
 * in". Handing over the whole service would let billing reach into the wallet;
 * handing over one function does not.
 */
export interface CreditGrantPort {
  /**
   * `db` IS THE SETTLEMENT TRANSACTION. That was always the contract and is now
   * also the fact: `#ingest` opens one and threads it here, so the grant, the
   * invoice and the purchase row commit together or not at all.
   */
  grantPackCredits(
    db: TenantScopedClient,
    input: {
      readonly workspaceId: string;
      readonly credits: number;
      readonly reason: string;
      readonly idempotencyKey: string;
      readonly expiresAt: Date | null;
    },
  ): Promise<string>;
}

export interface ReconcilerOptions {
  readonly providers: ProviderRegistry;
  readonly credits: CreditGrantPort;
  readonly clock?: Clock;
}

/**
 * What settling ONE already-normalized event needs.
 *
 * Split out from `ReceiveInput` because the replay path has no raw body and no
 * headers to offer: the signature was verified when the event first arrived,
 * and re-verifying bytes we no longer hold is not something this type should
 * let a caller pretend to have done.
 */
export interface SettlementInput {
  readonly providerKey: string;
  readonly policy: CommercePolicy;
  readonly plans: readonly PlanDetail[];
  readonly planVersionId: string | null;
}

export interface ReceiveInput extends SettlementInput {
  /** The UNPARSED body, exactly as it arrived. */
  readonly raw: Buffer;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ReplayInput extends SettlementInput {
  readonly billingEventId: string;
  /**
   * The platform user who asked for this. REQUIRED, and never defaulted: a
   * replay moves money, so "who" is part of the record or the record is not
   * worth keeping.
   */
  readonly actorId: string;
}

export type ReplayResult =
  | { readonly replayed: false; readonly reason: string }
  | { readonly replayed: true; readonly result: EventResult };

/**
 * The inbox states an operator may replay from.
 *
 * `PROCESSED`, `DUPLICATE` and `STALE` are absent on purpose: replaying an
 * event we already applied is how one payment becomes two, and the guards
 * inside the apply paths should not be the only thing standing between an
 * operator and that. `PROCESSING` is absent because it is somebody's claim —
 * if the holder died, the lease releases it without anyone deciding anything.
 */
const REPLAYABLE_INBOX_STATUSES: ReadonlySet<string> = new Set([
  'DEAD_LETTER',
  'FAILED',
  'UNRESOLVED',
  'RETRYABLE',
  'RECEIVED',
]);

export class BillingReconciler {
  readonly #providers: ProviderRegistry;
  readonly #credits: CreditGrantPort;
  readonly #clock: Clock;
  readonly #invoices: InvoiceService;

  constructor(options: ReconcilerOptions) {
    this.#providers = options.providers;
    this.#credits = options.credits;
    this.#clock = options.clock ?? systemClock;
    this.#invoices = new InvoiceService({ clock: this.#clock });
  }

  /**
   * Receive one delivery.
   *
   * `db` MUST BE A PLATFORM-SCOPED CLIENT. The inbox is platform-owned, the
   * workspace is not known until it is resolved, and invoice numbering is
   * refused to the tenant role. This is not a convenience: an event arrives
   * before anyone knows whose it is, so there is no tenant context to run it in.
   */
  async receive(db: ReconcilerClient, input: ReceiveInput): Promise<DeliveryResult> {
    const provider = this.#providers.get(input.providerKey);
    if (!provider) {
      return { accepted: false, reason: 'unknown_provider' };
    }

    const verification = provider.verifyWebhook(input.raw, input.headers);
    if (!verification.valid) {
      // NOTHING IS WRITTEN. See the header — an unverified caller cannot make us
      // store a row of their choosing.
      return { accepted: false, reason: verification.reason ?? 'invalid_signature' };
    }

    let events: readonly NormalizedBillingEvent[];
    try {
      events = provider.parseWebhook(input.raw);
    } catch {
      // Verified but unintelligible. Refused rather than recorded, because a
      // shape we cannot normalize is a shape we cannot reconcile.
      return { accepted: false, reason: 'unparseable_event' };
    }

    const results: EventResult[] = [];
    for (const event of events) {
      results.push(await this.#ingest(db, input, event));
    }
    return { accepted: true, results };
  }

  /**
   * THE ADMIN REPLAY TOOL — docs/BILLING-AND-CREDITS.md §5.
   *
   * A dead-lettered event is money that moved at the provider and did not move
   * here. Something has to be able to finish it once the cause is fixed, and
   * "wait for the provider to redeliver" is not that: by the time a row
   * dead-letters the provider has long since given up too.
   *
   * IT REPLAYS FROM OUR OWN STORED EVENT, not from a new delivery. The
   * normalized payload was written when the signature was verified, so a replay
   * re-applies exactly what we were told the first time — there is no path here
   * for an operator to supply an event, amend an amount, or replay something
   * that was never signed.
   *
   * IT CANNOT REPLAY A SETTLED EVENT. `REPLAYABLE_INBOX_STATUSES` excludes
   * PROCESSED, DUPLICATE and STALE, so the tool cannot be the thing that turns
   * one payment into two. The per-path idempotency guards remain underneath;
   * this is the lock on the door, not a replacement for them.
   *
   * IT IS AUDITED BEFORE IT RUNS, and names the operator. A replay that fails
   * half way still leaves the record that somebody asked for it.
   */
  async replay(db: ReconcilerClient, input: ReplayInput): Promise<ReplayResult> {
    const row = await db.billingEvent.findUnique({
      where: { id: input.billingEventId },
      select: {
        id: true,
        status: true,
        providerKey: true,
        externalEventId: true,
        payload: true,
        resolvedWorkspaceId: true,
      },
    });
    if (!row) return { replayed: false, reason: 'unknown_event' };
    if (row.providerKey !== input.providerKey) {
      return { replayed: false, reason: 'provider_mismatch' };
    }
    if (!REPLAYABLE_INBOX_STATUSES.has(row.status)) {
      // Including PROCESSED — see the header. This is the guard, not an error.
      return { replayed: false, reason: 'not_replayable' };
    }

    let event: NormalizedBillingEvent;
    try {
      event = deserialisePayload(row.externalEventId, row.payload);
    } catch {
      return { replayed: false, reason: 'unreadable_payload' };
    }

    /*
     * RESET TO RECEIVED WITH THE ATTEMPT BUDGET RESTORED, and only from the
     * status we decided was replayable a moment ago — so a delivery that
     * claimed the row in between is not trampled. If one did, the replay
     * reports that rather than fighting it.
     *
     * THIS IS THE POINT OF NO RETURN, AND THEREFORE THE POINT THE AUDIT
     * FOLLOWS. Writing the record first would mean a replay that lost this
     * race still left a trail saying an operator had replayed the event, which
     * is a false entry in the one log that is supposed to be reliable.
     */
    const reset = await db.billingEvent.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: 'RECEIVED', attempts: 0, failureReason: null, claimToken: null },
    });
    if (reset.count !== 1) return { replayed: false, reason: 'claimed_by_another_delivery' };

    /*
     * AUDITED BEFORE THE SETTLEMENT, WHEN THERE IS SOMEWHERE TO WRITE IT.
     * `audit_event` is workspace-scoped, and an UNRESOLVED row is one we could
     * not tie to a workspace — so for that one case the record has to wait
     * until the replay has resolved one, which is written below. The
     * alternative, a workspace-less audit row, would mean making the audit
     * table nullable in its tenant column to serve a single caller.
     */
    const knownWorkspaceId = row.resolvedWorkspaceId;
    if (knownWorkspaceId !== null) {
      await this.#auditReplay(db, knownWorkspaceId, input.actorId, row.id, row.status, event.type);
    }

    const result = await this.#ingest(db, input, event);

    if (knownWorkspaceId === null && result.workspaceId !== null) {
      // The mapping an operator fixed is exactly why this replay happened, so
      // now there is a workspace to record it against.
      await this.#auditReplay(
        db,
        result.workspaceId,
        input.actorId,
        row.id,
        row.status,
        event.type,
      );
    }

    return { replayed: true, result };
  }

  async #auditReplay(
    db: ReconcilerClient,
    workspaceId: string,
    actorId: string,
    billingEventId: string,
    fromStatus: string,
    eventType: string,
  ): Promise<void> {
    await writeAuditEvent(db, workspaceId, {
      action: 'billing.event.replayed',
      actorType: 'PLATFORM_USER',
      actorId,
      resourceType: 'BillingEvent',
      resourceId: billingEventId,
      severity: 'WARNING',
      outcome: 'SUCCESS',
      reason: 'An operator replayed a billing event that had not settled.',
      after: { fromStatus, eventType },
    });
  }

  // ---------------------------------------------------------------------------

  async #ingest(
    db: ReconcilerClient,
    input: SettlementInput,
    event: NormalizedBillingEvent,
  ): Promise<EventResult> {
    const row = await this.#inboxRow(db, input, event);

    if (SETTLED_INBOX_STATUSES.has(row.status)) {
      // A REPLAY OF A SETTLED EVENT CHANGES NOTHING. Not the state, and not the
      // record of what the first delivery did — the row keeps its original
      // status.
      return this.#duplicate(row, event);
    }

    /*
     * THE PROCESSING CLAIM — and the reason the previous fix needed one.
     *
     * Making an unsettled row retryable was right, and it opened this: two
     * deliveries of the SAME event can both read it as unsettled and both walk
     * into settlement. Nothing serialised them, because the settlement runs
     * OUTSIDE the inbox row's transaction — deliberately, so a rolled-back
     * apply still leaves the receipt visible. The unique index guards the
     * inbox row; it does not guard the work.
     *
     * The damage was not hypothetical. `invoice.payment_failed` writes a
     * `PaymentAttempt` keyed `attempt:<externalEventId>` under
     * `unique(workspaceId, idempotencyKey)`, so two concurrent retries of one
     * event collide there: one settles, the other takes a P2002 — and then,
     * with an unconditional status write, the loser's failure could land AFTER
     * the winner's success and leave the row saying FAILED over work that had
     * in fact been applied. The next delivery would read that and apply it
     * again.
     *
     * `#claim` is a single conditional UPDATE. Under READ COMMITTED the second
     * one blocks on the row, re-evaluates its predicate once the first commits,
     * matches nothing and reports zero rows — so exactly one delivery proceeds,
     * decided by PostgreSQL rather than by timing.
     */
    const claim = await this.#claim(db, row.id);
    if (!claim) {
      // Somebody else owns it. Re-read, because "owns it" and "finished with
      // it between our read and our claim" are different answers.
      const current = await this.#reload(db, row.id);
      if (current && SETTLED_INBOX_STATUSES.has(current.status)) {
        return this.#duplicate(current, event);
      }
      /*
       * IN FLIGHT ELSEWHERE, AND THAT DELIVERY OWNS THE RETRY SIGNAL. Reporting
       * it as retryable here too would have two deliveries asking the provider
       * to redeliver the same event, which is how a burst becomes a storm. The
       * holder's own response is what asks for a retry if its attempt fails.
       */
      return {
        billingEventId: row.id,
        externalEventId: event.externalEventId,
        type: event.type,
        outcome: 'IN_PROGRESS',
        workspaceId: current?.resolvedWorkspaceId ?? null,
        failureReason: null,
      };
    }

    const workspaceId = await this.#resolveWorkspace(db, input.providerKey, event);
    if (!workspaceId) {
      await this.#release(db, row.id, claim.token, {
        status: 'UNRESOLVED',
        failureReason: 'no_trusted_mapping',
        terminal: true,
      });
      return {
        billingEventId: row.id,
        externalEventId: event.externalEventId,
        type: event.type,
        outcome: 'UNRESOLVED',
        workspaceId: null,
        failureReason: 'no_trusted_mapping',
      };
    }

    /*
     * THE SETTLEMENT TRANSACTION.
     *
     * Everything `#apply` touches commits together or not at all: the checkout
     * row's status, the invoice and its lines, the subscription or the pack
     * purchase, the credit transaction, the credit grant bucket and the wallet
     * balance. Before this, each of those autocommitted on its own against a
     * top-level client, so a failure part-way left the customer charged and
     * invoiced with no credits, and the ledger holding a transaction row whose
     * bucket was never written — permanent drift that `credits.reconcile()`
     * would report for ever.
     *
     * THE INBOX ROW IS DELIBERATELY OUTSIDE IT. A rolled-back settlement must
     * still leave the receipt visible, or an operator cannot see that the event
     * arrived at all — and the claim above, not the transaction, is what makes
     * that safe.
     *
     * THE TIMEOUT IS RAISED because this transaction spans a whole settlement,
     * including invoice-number allocation, rather than one statement.
     */
    let outcome: EventOutcome;
    let failureReason: string | null = null;
    try {
      outcome = await db.$transaction(
        async (tx) =>
          this.#apply(tx as unknown as TenantScopedClient, db, input, event, workspaceId, row.id),
        { timeout: SETTLEMENT_TIMEOUT_MS },
      );
    } catch (error: unknown) {
      const decided = await this.#classifyFailure(db, error, claim.attempts, workspaceId, row.id);
      outcome = decided.outcome;
      failureReason = decided.failureReason;
    }

    await this.#release(db, row.id, claim.token, {
      status: outcome,
      workspaceId,
      failureReason,
      // A retryable row is not finished, so it does not get a processed time.
      terminal: outcome !== 'RETRYABLE',
    });

    return {
      billingEventId: row.id,
      externalEventId: event.externalEventId,
      type: event.type,
      outcome,
      workspaceId,
      failureReason,
    };
  }

  /**
   * Decide what a thrown settlement means, and say so in the audit log when it
   * means an operator has to act.
   *
   * THE DISTINCTION THIS DRAWS IS THE WHOLE OF THE SECOND FIX. Every exception
   * used to become FAILED, and FAILED is answered with HTTP 200, so the
   * provider never redelivered. A dropped connection during settlement was
   * therefore permanent: the customer charged by the provider, nothing applied
   * here, no retry anywhere in the system, and a row whose status claimed a
   * decision about the money had been taken when none had.
   */
  async #classifyFailure(
    db: ReconcilerClient,
    error: unknown,
    attempts: number,
    workspaceId: string,
    billingEventId: string,
  ): Promise<{ readonly outcome: EventOutcome; readonly failureReason: string | null }> {
    if (isTerminalFailure(error)) {
      // §20's FAILED: a decision about the money, reached by comparing our rows
      // against the event. The apply has already written its CRITICAL audit.
      return { outcome: 'FAILED', failureReason: error.code };
    }

    const reason = error instanceof AppError ? error.code : 'apply_failed';

    if (attempts < MAX_DELIVERY_ATTEMPTS) {
      return { outcome: 'RETRYABLE', failureReason: reason };
    }

    /*
     * THE DEAD LETTER, AND ITS ALERT. docs/BILLING-AND-CREDITS.md §5 asks for
     * "dead-letters with an alert and an admin replay tool", and an alert has
     * to be a thing that is EMITTED — a row somebody would have to go looking
     * for is not one. The audit is written on the platform connection and at
     * CRITICAL, which is the same severity an amount mismatch raises, because
     * the consequence is the same: money moved at the provider and did not move
     * here.
     */
    await writeAuditEvent(db, workspaceId, {
      action: 'billing.event.dead_lettered',
      actorType: 'SYSTEM',
      resourceType: 'BillingEvent',
      resourceId: billingEventId,
      severity: 'CRITICAL',
      outcome: 'ERROR',
      reason: 'Settlement failed repeatedly; this event needs an operator.',
      after: { attempts, failureReason: reason },
    });

    return { outcome: 'DEAD_LETTER', failureReason: reason };
  }

  /**
   * Find the inbox row, or write it.
   *
   * `findUnique` then `create` is a check-then-act, and two simultaneous
   * deliveries of one event both pass the check. The unique index on
   * (providerKey, externalEventId) is the real arbiter, so the loser re-reads
   * the winner's row and carries on from there — the claim below decides which
   * of them actually applies it. Escaping as a 500 would make the provider
   * retry a race it had already lost.
   */
  async #inboxRow(
    db: ReconcilerClient,
    input: SettlementInput,
    event: NormalizedBillingEvent,
  ): Promise<InboxRow> {
    const existing = await this.#find(db, input.providerKey, event.externalEventId);
    if (existing) return existing;

    try {
      return await db.billingEvent.create({
        data: {
          providerKey: input.providerKey,
          externalEventId: event.externalEventId,
          eventType: event.type,
          occurredAt: event.occurredAt,
          signatureVerified: true,
          payload: serialisePayload(event),
          status: 'RECEIVED',
          // ZERO, NOT ONE. The claim is what counts an attempt, so that a
          // delivery which never gets to try does not spend one.
          attempts: 0,
        },
        select: INBOX_SELECT,
      });
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.#find(db, input.providerKey, event.externalEventId);
      if (winner) return winner;
      // The unique index refused us and the row is not there to read. That is
      // not a state this schema can be in, so it is reported rather than
      // guessed at.
      throw new AppError('CONFLICT', 'The billing inbox row vanished between write and read.');
    }
  }

  async #find(
    db: ReconcilerClient,
    providerKey: string,
    externalEventId: string,
  ): Promise<InboxRow | null> {
    return db.billingEvent.findUnique({
      where: { providerKey_externalEventId: { providerKey, externalEventId } },
      select: INBOX_SELECT,
    });
  }

  async #reload(db: ReconcilerClient, id: string): Promise<InboxRow | null> {
    return db.billingEvent.findUnique({ where: { id }, select: INBOX_SELECT });
  }

  /**
   * Take ownership of one inbox row, atomically.
   *
   * ONE CONDITIONAL UPDATE IS THE WHOLE MECHANISM. `updateMany` compiles to
   * `UPDATE ... WHERE id = $1 AND (...)`, and PostgreSQL's row lock makes two
   * concurrent copies of it strictly ordered: the second waits, re-evaluates
   * its predicate against the committed row, finds `PROCESSING` outside the
   * claimable set, and reports zero rows changed. So `count === 1` is proof of
   * exclusive ownership, not a hint.
   *
   * THE EXPIRED-LEASE BRANCH is why a dead process cannot strand an event. A
   * claim older than `CLAIM_LEASE_MS` belongs to something that is not coming
   * back, and may be taken over — the token, not the status, is what stops the
   * original holder writing a result afterwards.
   *
   * THE ATTEMPT COUNT IS READ BACK rather than inferred from the row we saw
   * before claiming: another delivery may have claimed, failed and released in
   * between, and a retry budget that undercounts is a retry budget that never
   * dead-letters. The read is safe because we hold the claim.
   */
  async #claim(
    db: ReconcilerClient,
    id: string,
  ): Promise<{ token: string; attempts: number } | null> {
    const token = randomUUID();
    const now = this.#clock.now();
    const leaseExpiredBefore = new Date(now.getTime() - CLAIM_LEASE_MS);

    const claimed = await db.billingEvent.updateMany({
      where: {
        id,
        OR: [
          { status: { in: [...CLAIMABLE_INBOX_STATUSES] } },
          { status: 'PROCESSING', claimedAt: { lt: leaseExpiredBefore } },
        ],
      },
      data: {
        status: 'PROCESSING',
        claimToken: token,
        claimedAt: now,
        attempts: { increment: 1 },
        failureReason: null,
      },
    });
    if (claimed.count !== 1) return null;

    const held = await db.billingEvent.findUnique({
      where: { id },
      select: { attempts: true, claimToken: true },
    });
    // Belt and braces: if the token is not ours, we did not end up holding it.
    if (!held || held.claimToken !== token) return null;
    return { token, attempts: held.attempts };
  }

  /**
   * Write the outcome — but only while we still hold the claim.
   *
   * THE TOKEN IN THE PREDICATE IS THE POINT. Without it, a delivery whose lease
   * expired and whose claim was taken over would still overwrite the new
   * holder's result on its way out, which is precisely the "one transaction
   * succeeds while the other overwrites the row back to FAILED" defect. With
   * it, a late writer updates zero rows and changes nothing.
   */
  async #release(
    db: ReconcilerClient,
    id: string,
    token: string,
    result: {
      readonly status: EventOutcome;
      readonly workspaceId?: string;
      readonly failureReason: string | null;
      readonly terminal: boolean;
    },
  ): Promise<void> {
    await db.billingEvent.updateMany({
      where: { id, claimToken: token },
      data: {
        status: result.status === 'IN_PROGRESS' ? 'RETRYABLE' : result.status,
        ...(result.workspaceId === undefined ? {} : { resolvedWorkspaceId: result.workspaceId }),
        failureReason: result.failureReason,
        // Released, so the next delivery may claim it if it is not terminal.
        claimToken: null,
        // `claimedAt` is deliberately KEPT: on a released row it is the record
        // of when the last attempt began, which is what an operator looking at
        // a retry loop wants to see.
        processedAt: result.terminal ? this.#clock.now() : null,
      },
    });
  }

  #duplicate(row: InboxRow, event: NormalizedBillingEvent): EventResult {
    return {
      billingEventId: row.id,
      externalEventId: event.externalEventId,
      type: event.type,
      outcome: 'DUPLICATE',
      workspaceId: row.resolvedWorkspaceId,
      failureReason: null,
    };
  }

  /**
   * Find the workspace through a relationship WE wrote.
   *
   * FOUR TRUSTED MAPPINGS, tried in order of how directly we own them. Not one
   * of them reads a workspace id out of the event: `NormalizedBillingEvent` has
   * no such field, so there is nothing here for a future maintainer to reach
   * for even by accident.
   */
  async #resolveWorkspace(
    db: ReconcilerClient,
    providerKey: string,
    event: NormalizedBillingEvent,
  ): Promise<string | null> {
    if (event.providerCustomerId) {
      const profile = await db.billingProfile.findFirst({
        where: { providerKey, providerCustomerId: event.providerCustomerId },
        select: { workspaceId: true },
      });
      if (profile) return profile.workspaceId;
    }
    if (event.providerSessionId) {
      const session = await db.checkoutSession.findFirst({
        where: { providerKey, providerSessionId: event.providerSessionId },
        select: { workspaceId: true },
      });
      if (session) return session.workspaceId;
    }
    if (event.providerSubscriptionId) {
      const subscription = await db.workspaceSubscription.findFirst({
        where: { providerKey, providerSubscriptionId: event.providerSubscriptionId },
        select: { workspaceId: true },
      });
      if (subscription) return subscription.workspaceId;
    }
    if (event.providerInvoiceId) {
      const invoice = await db.invoice.findFirst({
        where: { providerKey, providerInvoiceId: event.providerInvoiceId },
        select: { workspaceId: true },
      });
      if (invoice) return invoice.workspaceId;
    }
    return null;
  }

  /**
   * `db` IS THE SETTLEMENT TRANSACTION. `auditDb` is the OUTER client — a
   * different connection, deliberately.
   *
   * Almost everything belongs in the transaction: an audit of a change that
   * rolled back would describe something that never happened. The exception is
   * a refusal, where the audit is the only record that an attempt was made at
   * all, and the rollback is the point. `asPlatform()` in @brandspace/database
   * solves the same problem the same way, and says so: the audit "is written on
   * a separate connection" precisely so a rollback cannot take it.
   */
  async #apply(
    db: TenantScopedClient,
    auditDb: ReconcilerClient,
    input: SettlementInput,
    event: NormalizedBillingEvent,
    workspaceId: string,
    billingEventId: string,
  ): Promise<EventOutcome> {
    switch (event.type) {
      case 'checkout.completed':
        return this.#applyCheckoutCompleted(db, auditDb, input, event, workspaceId, billingEventId);
      case 'checkout.cancelled':
        return this.#applyCheckoutCancelled(db, event, workspaceId);
      case 'invoice.paid':
        return this.#applyInvoicePaid(db, event, workspaceId, billingEventId);
      case 'invoice.payment_failed':
        return this.#applyPaymentFailed(db, input, event, workspaceId, billingEventId);
      case 'subscription.created':
      case 'subscription.updated':
      case 'subscription.cancelled':
        return this.#applySubscriptionEvent(db, event, workspaceId, billingEventId);
      case 'charge.refunded':
        // Recorded, not acted on. A refund BrandSpace initiated already has its
        // credit note; one initiated at the provider is an operator's business
        // and must not silently rewrite our documents.
        return 'PROCESSED';
      default:
        return 'FAILED';
    }
  }

  /**
   * The money path. A checkout the provider says is paid.
   *
   * THE SESSION IS LOOKED UP BY (workspaceId, id), never by the id alone. The
   * workspace came from a mapping we wrote; the id came from the event. Pairing
   * them means a forged id belonging to another tenant resolves to nothing —
   * indistinguishable from an id that never existed.
   */
  async #applyCheckoutCompleted(
    db: TenantScopedClient,
    auditDb: ReconcilerClient,
    input: SettlementInput,
    event: NormalizedBillingEvent,
    workspaceId: string,
    billingEventId: string,
  ): Promise<EventOutcome> {
    const session = event.checkoutSessionId
      ? await db.checkoutSession.findFirst({
          where: { workspaceId, id: event.checkoutSessionId },
        })
      : event.providerSessionId
        ? await db.checkoutSession.findFirst({
            where: { workspaceId, providerSessionId: event.providerSessionId },
          })
        : null;

    if (!session) return 'UNRESOLVED';

    if (session.status === 'COMPLETED') {
      // Already reconciled. Not an error, and nothing to do twice.
      return 'DUPLICATE';
    }

    // THE AMOUNT CHECK (§37). What the provider says moved must be what we
    // priced. A mismatch is never "close enough".
    if (
      event.amountMinor === null ||
      event.amountMinor !== session.totalMinor ||
      (event.currency ?? '').toUpperCase() !== session.currency.toUpperCase()
    ) {
      /*
       * ON THE OUTER CONNECTION, because the next statement throws and the
       * settlement transaction rolls back. An amount that does not match what
       * we priced is the single most security-relevant thing this file detects
       * (§37), and an audit that vanishes with the rollback would leave the
       * attempt invisible — exactly the evidence an operator needs.
       */
      await writeAuditEvent(auditDb, workspaceId, {
        action: 'billing.reconcile.amount-mismatch',
        actorType: 'SYSTEM',
        resourceType: 'CheckoutSession',
        resourceId: session.id,
        severity: 'CRITICAL',
        outcome: 'ERROR',
        reason: 'The provider amount does not match the agreed amount.',
        after: {
          expectedMinor: session.totalMinor.toString(),
          expectedCurrency: session.currency,
          reportedMinor: event.amountMinor === null ? null : event.amountMinor.toString(),
          reportedCurrency: event.currency,
        },
      });
      throw new AppError('CONFLICT', 'The provider amount does not match the agreed amount.');
    }

    const now = this.#clock.now();
    const completed = await db.checkoutSession.updateMany({
      where: { workspaceId, id: session.id, status: 'PENDING' },
      data: { status: 'COMPLETED', completedAt: now },
    });
    if (completed.count === 0) {
      // Another delivery won the race and is completing it. Ours changes nothing.
      return 'DUPLICATE';
    }

    const assessment = await this.#assessmentOf(db, input.policy, workspaceId, session);

    if (session.purpose === 'SUBSCRIPTION') {
      await this.#settleSubscription(db, input, {
        workspaceId,
        session,
        assessment,
        event,
        billingEventId,
        now,
      });
    } else {
      await this.#settleCreditPack(db, input, {
        workspaceId,
        session,
        assessment,
        event,
        now,
      });
    }

    return 'PROCESSED';
  }

  /**
   * The tax treatment to RECORD on the invoice for a settled checkout.
   *
   * THE AMOUNTS COME FROM THE CHECKOUT ROW, NEVER FROM RE-PRICING. What the
   * customer agreed to is what we invoice, even if the catalogue moved between
   * the redirect and the payment — that is the entire reason the amount was
   * written down before the provider was called (§25).
   *
   * Only the MODE, the RATE and the POLICY KEY are read from configuration, so
   * the document can explain which rule produced a tax figure it does not
   * recompute. When the agreed tax is zero the mode is NONE regardless, because
   * a rate that charged nothing did not apply.
   */
  async #assessmentOf(
    db: TenantScopedClient,
    policy: CommercePolicy,
    workspaceId: string,
    session: CheckoutRow,
  ): Promise<TaxAssessment> {
    const profile = await db.billingProfile.findFirst({
      where: { workspaceId },
      select: { country: true },
    });
    const taxPolicy = profile ? taxPolicyFor(policy, profile.country) : null;
    const money = (minor: bigint): Money =>
      Money.ofMinor(session.currency, minor, session.currencyScale);

    const zeroTax = session.taxMinor === 0n;
    return {
      mode: zeroTax ? 'NONE' : taxPolicy?.mode === 'inclusive' ? 'INCLUSIVE' : 'EXCLUSIVE',
      rateBasisPoints: zeroTax ? 0 : (taxPolicy?.rateBasisPoints ?? 0),
      policyKey: taxPolicy?.key ?? null,
      subtotal: money(session.amountMinor),
      tax: money(session.taxMinor),
      total: money(session.totalMinor),
    };
  }

  async #settleSubscription(
    db: TenantScopedClient,
    input: SettlementInput,
    args: {
      readonly workspaceId: string;
      readonly session: CheckoutRow;
      readonly assessment: TaxAssessment;
      readonly event: NormalizedBillingEvent;
      readonly billingEventId: string;
      readonly now: Date;
    },
  ): Promise<void> {
    const { workspaceId, session, now } = args;
    const plan = findPlan(input.plans, session.planKey);
    if (!plan) {
      throw new AppError('CONFLICT', 'The plan this checkout bought no longer exists.');
    }
    const terms = termsFor(plan, session.currency, input.planVersionId);
    if (!terms) {
      throw new AppError('CONFLICT', 'That plan has no price in the currency it was bought in.');
    }

    const line: InvoiceLineInput = {
      kind: 'SUBSCRIPTION',
      description: {
        ar: plan.nameAr,
        en: plan.nameEn,
      } satisfies LocalizedText,
      quantity: 1,
      unitAmount: args.assessment.subtotal,
      amount: args.assessment.subtotal,
      tax: args.assessment.tax,
      metadata: { planKey: plan.key, billingInterval: session.billingInterval },
    };

    const periodEnd = session.billingInterval === 'YEAR' ? addMonths(now, 12) : addMonths(now, 1);

    const draft = await this.#invoices.draft(db, {
      workspaceId,
      assessment: args.assessment,
      lines: [line],
      checkoutSessionId: session.id,
      periodStart: now,
      periodEnd,
      providerKey: session.providerKey,
      commercialSnapshot: {
        planKey: plan.key,
        billingInterval: session.billingInterval,
        currency: session.currency,
        currencyScale: session.currencyScale,
        amountMinor: session.amountMinor.toString(),
        planVersionId: session.planVersionId,
        commerceVersionId: session.commerceVersionId,
      },
    });
    const issued = await this.#invoices.issue(db, {
      workspaceId,
      invoiceId: draft.id,
      policy: input.policy,
    });
    await this.#invoices.markPaid(db, {
      workspaceId,
      invoiceId: issued.id,
      providerPaymentId: args.event.providerPaymentId,
      paidAt: now,
    });

    await db.paymentAttempt.create({
      data: {
        workspaceId,
        invoiceId: issued.id,
        checkoutSessionId: session.id,
        status: 'SUCCEEDED',
        currency: session.currency,
        currencyScale: session.currencyScale,
        amountMinor: session.totalMinor,
        providerPaymentId: args.event.providerPaymentId,
        idempotencyKey: `attempt:${args.event.externalEventId}`,
        settledAt: now,
      },
    });

    /*
     * THE SUBSCRIPTION MOVES TO ACTIVE AND PINS ITS PRICE.
     *
     * Pinned, not read live (AC-04.7): a later catalogue edit changes what NEW
     * customers are offered and nothing about this one. The dunning clock is
     * cleared in the same write — a collected payment ends the episode.
     */
    await db.workspaceSubscription.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        planKey: plan.key,
        status: 'ACTIVE',
        billingInterval: session.billingInterval ?? 'MONTH',
        currency: terms.pricing.currency.toUpperCase(),
        pinnedMonthlyMinor: terms.pricing.monthlyMinor,
        pinnedAnnualMinor: terms.pricing.annualMinor,
        pinnedMonthlyCredits: terms.monthlyCredits,
        pinnedFromVersionId: terms.sourceVersionId,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        providerKey: session.providerKey,
        providerSubscriptionId: args.event.providerSubscriptionId,
        lastEventAt: args.event.occurredAt,
        lastBillingEventId: args.billingEventId,
      },
      update: {
        planKey: plan.key,
        status: 'ACTIVE',
        billingInterval: session.billingInterval ?? 'MONTH',
        currency: terms.pricing.currency.toUpperCase(),
        pinnedMonthlyMinor: terms.pricing.monthlyMinor,
        pinnedAnnualMinor: terms.pricing.annualMinor,
        pinnedMonthlyCredits: terms.monthlyCredits,
        pinnedFromVersionId: terms.sourceVersionId,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        providerKey: session.providerKey,
        providerSubscriptionId: args.event.providerSubscriptionId,
        pendingCheckoutSessionId: null,
        pastDueSince: null,
        graceEndsAt: null,
        suspendedAt: null,
        lastEventAt: args.event.occurredAt,
        lastBillingEventId: args.billingEventId,
      },
    });

    await writeAuditEvent(db, workspaceId, {
      action: 'billing.subscription.activated',
      actorType: 'SYSTEM',
      resourceType: 'WorkspaceSubscription',
      resourceId: workspaceId,
      after: { planKey: plan.key, invoice: issued.number },
    });
  }

  /**
   * A prepaid pack. Paid once, granted once.
   *
   * THE GRANT AND THE PURCHASE COMMIT TOGETHER, and `creditGrantId` is unique
   * with a CHECK that a COMPLETED purchase must name one. So "the webhook ran
   * twice and the customer got double credits" is refused by the database, not
   * only by the idempotency check above it.
   */
  async #settleCreditPack(
    db: TenantScopedClient,
    input: SettlementInput,
    args: {
      readonly workspaceId: string;
      readonly session: CheckoutRow;
      readonly assessment: TaxAssessment;
      readonly event: NormalizedBillingEvent;
      readonly now: Date;
    },
  ): Promise<void> {
    const { workspaceId, session, now } = args;
    const pack = input.policy.creditPacks.find((p) => p.key === session.packKey);
    if (!pack) {
      throw new AppError('CONFLICT', 'The credit pack this checkout bought no longer exists.');
    }

    const existing = await db.creditPackPurchase.findFirst({
      where: { workspaceId, checkoutSessionId: session.id },
    });
    if (existing?.status === 'COMPLETED') return;

    const line: InvoiceLineInput = {
      kind: 'CREDIT_PACK',
      description: { ar: pack.name.ar, en: pack.name.en },
      quantity: 1,
      unitAmount: args.assessment.subtotal,
      amount: args.assessment.subtotal,
      tax: args.assessment.tax,
      metadata: { packKey: pack.key, credits: pack.credits },
    };

    const draft = await this.#invoices.draft(db, {
      workspaceId,
      assessment: args.assessment,
      lines: [line],
      checkoutSessionId: session.id,
      providerKey: session.providerKey,
      commercialSnapshot: {
        packKey: pack.key,
        credits: pack.credits,
        currency: session.currency,
        currencyScale: session.currencyScale,
        amountMinor: session.amountMinor.toString(),
        commerceVersionId: session.commerceVersionId,
      },
    });
    const issued = await this.#invoices.issue(db, {
      workspaceId,
      invoiceId: draft.id,
      policy: input.policy,
    });
    await this.#invoices.markPaid(db, {
      workspaceId,
      invoiceId: issued.id,
      providerPaymentId: args.event.providerPaymentId,
      paidAt: now,
    });

    const grantId = await this.#credits.grantPackCredits(db, {
      workspaceId,
      credits: pack.credits,
      reason: `Credit pack ${pack.key}`,
      // KEYED ON THE CHECKOUT, not on the event: two different provider events
      // about the same purchase must not grant twice.
      idempotencyKey: `pack:${session.id}`,
      expiresAt: pack.expiryDays ? new Date(now.getTime() + pack.expiryDays * 86_400_000) : null,
    });

    const purchaseData = {
      packKey: pack.key,
      credits: pack.credits,
      currency: session.currency,
      currencyScale: session.currencyScale,
      amountMinor: session.totalMinor,
      status: 'COMPLETED' as const,
      invoiceId: issued.id,
      creditGrantId: grantId,
      providerPaymentId: args.event.providerPaymentId,
      completedAt: now,
    };

    if (existing) {
      await db.creditPackPurchase.update({ where: { id: existing.id }, data: purchaseData });
    } else {
      await db.creditPackPurchase.create({
        data: { workspaceId, checkoutSessionId: session.id, ...purchaseData },
      });
    }

    await writeAuditEvent(db, workspaceId, {
      action: 'billing.credit-pack.purchased',
      actorType: 'SYSTEM',
      resourceType: 'CreditPackPurchase',
      resourceId: session.id,
      after: { packKey: pack.key, credits: pack.credits, invoice: issued.number },
    });
  }

  async #applyCheckoutCancelled(
    db: TenantScopedClient,
    event: NormalizedBillingEvent,
    workspaceId: string,
  ): Promise<EventOutcome> {
    if (!event.providerSessionId && !event.checkoutSessionId) return 'UNRESOLVED';
    const { count } = await db.checkoutSession.updateMany({
      where: {
        workspaceId,
        status: 'PENDING',
        ...(event.checkoutSessionId
          ? { id: event.checkoutSessionId }
          : { providerSessionId: event.providerSessionId }),
      },
      data: { status: 'CANCELLED', cancelledAt: this.#clock.now() },
    });
    return count > 0 ? 'PROCESSED' : 'DUPLICATE';
  }

  async #applyInvoicePaid(
    db: TenantScopedClient,
    event: NormalizedBillingEvent,
    workspaceId: string,
    billingEventId: string,
  ): Promise<EventOutcome> {
    if (!event.providerInvoiceId) return 'UNRESOLVED';
    const invoice = await db.invoice.findFirst({
      where: { workspaceId, providerInvoiceId: event.providerInvoiceId },
      select: { id: true, status: true, totalMinor: true, currency: true },
    });
    if (!invoice) return 'UNRESOLVED';
    if (invoice.status === 'PAID') return 'DUPLICATE';

    if (
      event.amountMinor === null ||
      event.amountMinor !== invoice.totalMinor ||
      (event.currency ?? '').toUpperCase() !== invoice.currency.toUpperCase()
    ) {
      throw new AppError('CONFLICT', 'The provider amount does not match the invoice.');
    }

    const paid = await this.#invoices.markPaid(db, {
      workspaceId,
      invoiceId: invoice.id,
      providerPaymentId: event.providerPaymentId,
      paidAt: event.occurredAt,
    });
    if (!paid) return 'DUPLICATE';

    // Collection succeeded: the dunning episode is over.
    await db.workspaceSubscription.updateMany({
      where: { workspaceId },
      data: {
        status: 'ACTIVE',
        pastDueSince: null,
        graceEndsAt: null,
        suspendedAt: null,
        lastEventAt: event.occurredAt,
        lastBillingEventId: billingEventId,
      },
    });
    return 'PROCESSED';
  }

  /**
   * Collection failed.
   *
   * THE CLOCK STARTS AT THE FIRST FAILURE AND IS NOT RESTARTED. `pastDueSince`
   * is written only when it is null, so a second failure inside the same episode
   * cannot extend the customer's grace period — nor shorten it.
   */
  async #applyPaymentFailed(
    db: TenantScopedClient,
    input: SettlementInput,
    event: NormalizedBillingEvent,
    workspaceId: string,
    billingEventId: string,
  ): Promise<EventOutcome> {
    const subscription = await db.workspaceSubscription.findUnique({ where: { workspaceId } });
    if (!subscription) return 'UNRESOLVED';

    const invoice = event.providerInvoiceId
      ? await db.invoice.findFirst({
          where: { workspaceId, providerInvoiceId: event.providerInvoiceId },
          select: { id: true, currency: true, currencyScale: true, totalMinor: true },
        })
      : null;

    const firstFailedAt = subscription.pastDueSince ?? event.occurredAt;
    const attemptsMade =
      (await db.paymentAttempt.count({
        where: { workspaceId, status: 'FAILED', attemptedAt: { gte: firstFailedAt } },
      })) + 1;

    const step = nextDunningStep({
      policy: input.policy.dunning,
      firstFailedAt,
      attemptsMade,
      now: this.#clock.now(),
    });

    await db.paymentAttempt.create({
      data: {
        workspaceId,
        invoiceId: invoice?.id ?? null,
        status: 'FAILED',
        currency: invoice?.currency ?? subscription.currency,
        currencyScale: invoice?.currencyScale ?? 2,
        amountMinor: invoice?.totalMinor ?? 0n,
        failureCode: normaliseFailureCode(event.failureCode),
        attemptNumber: attemptsMade,
        providerPaymentId: event.providerPaymentId,
        idempotencyKey: `attempt:${event.externalEventId}`,
        settledAt: event.occurredAt,
        nextRetryAt: step.kind === 'retry' ? step.at : null,
      },
    });

    const graceEndsAt =
      step.kind === 'retry' || step.kind === 'grace'
        ? new Date(firstFailedAt.getTime() + input.policy.dunning.graceDays * 86_400_000)
        : subscription.graceEndsAt;

    await db.workspaceSubscription.update({
      where: { workspaceId },
      data: {
        status: step.kind === 'suspend' ? 'SUSPENDED' : 'PAST_DUE',
        pastDueSince: subscription.pastDueSince ?? event.occurredAt,
        graceEndsAt,
        suspendedAt: step.kind === 'suspend' ? this.#clock.now() : subscription.suspendedAt,
        lastEventAt: event.occurredAt,
        lastBillingEventId: billingEventId,
      },
    });

    await writeAuditEvent(db, workspaceId, {
      action: 'billing.payment.failed',
      actorType: 'SYSTEM',
      resourceType: 'WorkspaceSubscription',
      resourceId: workspaceId,
      severity: 'WARNING',
      outcome: 'ERROR',
      reason: normaliseFailureCode(event.failureCode),
      after: { step: step.kind, attemptNumber: attemptsMade },
    });

    return 'PROCESSED';
  }

  /**
   * A subscription's own lifecycle, as the provider sees it.
   *
   * STALENESS IS DECIDED HERE. `lastEventAt` holds the provider's timestamp for
   * the last event we applied; an older one is recorded and refused, because
   * applying it would replace newer truth with older truth — the classic
   * out-of-order webhook bug.
   */
  async #applySubscriptionEvent(
    db: TenantScopedClient,
    event: NormalizedBillingEvent,
    workspaceId: string,
    billingEventId: string,
  ): Promise<EventOutcome> {
    const subscription = await db.workspaceSubscription.findUnique({ where: { workspaceId } });
    if (!subscription) return 'UNRESOLVED';

    if (subscription.lastEventAt && event.occurredAt <= subscription.lastEventAt) {
      return 'STALE';
    }

    const cancelled = event.type === 'subscription.cancelled';
    await db.workspaceSubscription.update({
      where: { workspaceId },
      data: {
        providerSubscriptionId: event.providerSubscriptionId ?? subscription.providerSubscriptionId,
        ...(event.cancelAtPeriodEnd !== null ? { cancelAtPeriodEnd: event.cancelAtPeriodEnd } : {}),
        ...(event.periodStart ? { currentPeriodStart: event.periodStart } : {}),
        ...(event.periodEnd ? { currentPeriodEnd: event.periodEnd } : {}),
        ...(cancelled ? { status: 'CANCELLED' as const, cancelledAt: event.occurredAt } : {}),
        lastEventAt: event.occurredAt,
        lastBillingEventId: billingEventId,
      },
    });
    return 'PROCESSED';
  }
}

interface CheckoutRow {
  id: string;
  workspaceId: string;
  purpose: string;
  status: string;
  planKey: string | null;
  billingInterval: 'MONTH' | 'YEAR' | null;
  packKey: string | null;
  currency: string;
  currencyScale: number;
  amountMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  planVersionId: string | null;
  commerceVersionId: string | null;
  providerKey: string;
  providerSessionId: string | null;
}

function addMonths(from: Date, months: number): Date {
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

/**
 * What gets stored in `billing_event.payload`.
 *
 * NORMALIZED, NOT RAW. The provider's own body may carry fields we have no use
 * for and no right to keep; this is the subset reconciliation reads. `bigint`
 * becomes a decimal string because JSON has no integer wide enough to be trusted
 * with money.
 */
/**
 * A unique-constraint violation, in the one shape every driver agrees on.
 *
 * Matched on the Prisma error CODE and nothing else. F-56 records that where
 * Prisma names the offending constraint moves between drivers, so matching the
 * constraint name is how this check silently stops working.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Read back what `serialisePayload` wrote — the replay path's only input.
 *
 * DEFENSIVE ON PURPOSE, even though this column is our own writing. It is JSON
 * out of a database, it survives schema changes that this function does not,
 * and the alternative to refusing a shape we do not recognise is applying a
 * half-read event to somebody's money. Every field is checked; anything
 * unexpected throws and the caller reports `unreadable_payload`.
 */
function deserialisePayload(externalEventId: string, payload: unknown): NormalizedBillingEvent {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new AppError('CONFLICT', 'The stored billing payload is not an object.');
  }
  const raw = payload as Record<string, unknown>;

  const text = (key: string): string | null => {
    const value = raw[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      throw new AppError('CONFLICT', `The stored billing payload's ${key} is not a string.`);
    }
    return value;
  };

  const when = (key: string): Date | null => {
    const value = text(key);
    if (value === null) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppError('CONFLICT', `The stored billing payload's ${key} is not a date.`);
    }
    return parsed;
  };

  const type = text('type');
  if (
    type === null ||
    !NORMALIZED_BILLING_EVENT_TYPES.includes(type as NormalizedBillingEventType)
  ) {
    throw new AppError('CONFLICT', 'The stored billing payload names no known event type.');
  }

  const occurredAt = when('occurredAt');
  if (occurredAt === null) {
    throw new AppError('CONFLICT', 'The stored billing payload has no occurredAt.');
  }

  const amountText = text('amountMinor');
  let amountMinor: bigint | null = null;
  if (amountText !== null) {
    try {
      amountMinor = BigInt(amountText);
    } catch {
      throw new AppError('CONFLICT', "The stored billing payload's amount is not an integer.");
    }
  }

  const cancelAtPeriodEnd = raw['cancelAtPeriodEnd'];
  if (
    cancelAtPeriodEnd !== null &&
    cancelAtPeriodEnd !== undefined &&
    typeof cancelAtPeriodEnd !== 'boolean'
  ) {
    throw new AppError(
      'CONFLICT',
      "The stored billing payload's cancelAtPeriodEnd is not a boolean.",
    );
  }

  return {
    externalEventId,
    type: type as NormalizedBillingEventType,
    occurredAt,
    providerCustomerId: text('providerCustomerId'),
    providerSubscriptionId: text('providerSubscriptionId'),
    providerSessionId: text('providerSessionId'),
    providerPaymentId: text('providerPaymentId'),
    providerInvoiceId: text('providerInvoiceId'),
    amountMinor,
    currency: text('currency'),
    checkoutSessionId: text('checkoutSessionId'),
    failureCode: text('failureCode'),
    cancelAtPeriodEnd: cancelAtPeriodEnd ?? null,
    periodStart: when('periodStart'),
    periodEnd: when('periodEnd'),
  };
}

function serialisePayload(event: NormalizedBillingEvent): Prisma.InputJsonValue {
  return {
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    providerCustomerId: event.providerCustomerId,
    providerSubscriptionId: event.providerSubscriptionId,
    providerSessionId: event.providerSessionId,
    providerPaymentId: event.providerPaymentId,
    providerInvoiceId: event.providerInvoiceId,
    amountMinor: event.amountMinor === null ? null : event.amountMinor.toString(),
    currency: event.currency,
    checkoutSessionId: event.checkoutSessionId,
    failureCode: event.failureCode,
    cancelAtPeriodEnd: event.cancelAtPeriodEnd,
    periodStart: event.periodStart?.toISOString() ?? null,
    periodEnd: event.periodEnd?.toISOString() ?? null,
  } satisfies Prisma.InputJsonValue;
}
