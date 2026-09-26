/**
 * Creating a workspace from the customer's own answers — Phase 9 §12, §14.
 *
 * Workspace identity and commercial checkout are separate concerns. Country,
 * locale and timezone are persisted from explicit customer answers. Currency is
 * supplied by the caller (USD in the launch onboarding route) and remains an
 * explicit field so the billing engine can stay multi-currency without making
 * currency a signup question.
 *
 * Payment-market and provider routing are NOT prerequisites for workspace
 * creation. They are enforced when the customer attempts a commercial action.
 *
 * ONE TRIAL, ONCE, EVER (D-09). The trial and its credit grant commit in the
 * SAME transaction as the workspace, keyed on the workspace id. A retried
 * request finds `trialStartedAt` already set and grants nothing; a crash between
 * the two is impossible because there is no "between".
 *
 * WHY THIS NEEDS THE PLATFORM CONNECTION. `workspace` carries FORCE ROW LEVEL
 * SECURITY and the row being inserted IS the tenant that would authorise it —
 * there is no context to set before it exists. Creation is therefore a platform
 * operation on behalf of a verified customer, and everything after it runs in
 * the new workspace's own context.
 */

import type { TenantScopedClient } from '@brandspace/database';
import type { CommercePolicy } from '@brandspace/billing';
import { ownedWorkspaceFacts, workspaceAllowance, type PlanDetail } from '@brandspace/entitlements';
import {
  AppError,
  CITY_COUNTRY,
  isEgyptCityCode,
  normaliseCurrency,
  type Clock,
  systemClock,
} from '@brandspace/shared';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,48})[a-z0-9]$/;
const MILLI_PER_CREDIT = 1_000n;

export interface CreateWorkspaceFromOnboardingInput {
  readonly ownerUserId: string;
  readonly name: string;
  readonly slug: string;
  readonly type?: string;
  /** ISO 3166-1 alpha-2, chosen by the customer. */
  readonly country: string;
  readonly defaultLocale: 'AR' | 'EN';
  /** An IANA zone, chosen by the customer. Validated, never defaulted. */
  readonly timezone: string;
  /**
   * G8 (D-335): the business's city, an ISO 3166-2:EG governorate code. Asked
   * for Egypt only; for any other country it is dropped, and a code that is
   * not a governorate is refused.
   */
  readonly city?: string | null;
  /** Billing currency assigned by the caller's product policy. */
  readonly currency: string;
  readonly billingEmail: string;
  readonly legalName?: string | null;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface WorkspaceCreated {
  readonly workspaceId: string;
  readonly slug: string;
  /** Null when no plan offers a trial, which is a configuration fact, not a bug. */
  readonly trialPlanKey: string | null;
  readonly trialEndsAt: Date | null;
  readonly trialCredits: number;
}

export interface WorkspaceOnboardingOptions {
  readonly clock?: Clock;
}

export class WorkspaceOnboardingService {
  readonly #clock: Clock;

  constructor(options: WorkspaceOnboardingOptions = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  /** Validate the onboarding facts this service must persist safely. */
  assertOnboardingAnswers(
    _policy: CommercePolicy,
    input: { readonly country: string; readonly currency: string; readonly timezone: string },
  ): void {
    /*
     * Workspace creation is identity/onboarding, not checkout.
     *
     * A customer may create a workspace before a payment provider or a market
     * routing rule exists. Commercial availability is enforced when they try
     * to buy something; blocking the workspace here made a missing payment
     * integration look like a broken signup flow.
     *
     * Country and currency are still stored explicitly so later billing can
     * evaluate the right policy. The route controls the customer-facing
     * defaults; this service only validates the timezone it must persist.
     */
    if (!isValidTimezone(input.timezone)) {
      throw new AppError('VALIDATION_FAILED', 'That is not a recognised timezone.', {
        field: 'timezone',
      });
    }
  }

  /**
   * Create the workspace, its membership, its wallet, its billing profile and —
   * if a plan offers one — its single trial, in ONE transaction.
   *
   * `db` MUST BE PLATFORM-SCOPED. See the file header.
   */
  async create(
    db: TenantScopedClient,
    input: CreateWorkspaceFromOnboardingInput,
    commerce: CommercePolicy,
    trialPlan: PlanDetail | null,
    planVersionId: string | null,
    /**
     * The ACTIVE plan catalogue, which the workspace allowance is read from
     * (Q1, D-326). Required: an allowance decided without the catalogue would
     * be a guess.
     */
    plans: readonly PlanDetail[],
  ): Promise<WorkspaceCreated> {
    const slug = input.slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A workspace address is 3–50 characters of lower-case letters, digits and hyphens.',
        { field: 'slug' },
      );
    }
    const name = input.name.trim();
    if (name.length < 2) {
      throw new AppError('VALIDATION_FAILED', 'A workspace name is required.', { field: 'name' });
    }

    this.assertOnboardingAnswers(commerce, input);

    const owner = await db.user.findUnique({
      where: { id: input.ownerUserId },
      select: { id: true, emailVerifiedAt: true, status: true, deletedAt: true },
    });
    if (!owner || owner.deletedAt || owner.status !== 'ACTIVE') {
      throw new AppError('FORBIDDEN', 'That account cannot create a workspace.');
    }
    if (!owner.emailVerifiedAt) {
      // An unverified address must not become the owner of a commercial
      // relationship: every invoice, every dunning notice and every recovery
      // path is addressed to it.
      throw new AppError('FORBIDDEN', 'Verify your email address first.');
    }

    return inOneTransaction(db, async (tx) => {
      await this.#assertWithinAllowance(tx, owner.id, plans);
      return this.#createFor(tx, input, trialPlan, planVersionId, owner.id, slug, name);
    });
  }

  /**
   * THE WORKSPACE ALLOWANCE (Q1 / A2, D-326), enforced where the row is written.
   *
   * ONLY AN OWNER CREATES ANOTHER WORKSPACE (A2). A person who owns none may
   * create their first — the sign-up path — unless they are already a member of
   * some other business: joining one by invitation does not make somebody an
   * owner, and the allowance comes from an owner's plans.
   *
   * THE OWNER'S ROW IS LOCKED FIRST, so two concurrent requests from the same
   * person serialise here: the second one counts the first one's workspace and
   * is refused at the limit, rather than both reading the same count.
   */
  async #assertWithinAllowance(
    tx: TenantScopedClient,
    ownerUserId: string,
    plans: readonly PlanDetail[],
  ): Promise<void> {
    await (
      tx as unknown as { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }
    ).$queryRaw`SELECT "id" FROM "user" WHERE "id" = ${ownerUserId}::uuid FOR UPDATE`;

    const facts = await ownedWorkspaceFacts(tx as never, ownerUserId);
    const allowance = workspaceAllowance(facts, plans);
    if (allowance.used === 0) {
      const memberships = await tx.membership.count({
        where: {
          userId: ownerUserId,
          status: 'ACTIVE',
          workspace: { deletedAt: null, status: { not: 'DELETED' } },
        },
      });
      if (memberships > 0) {
        throw new AppError(
          'FORBIDDEN',
          'Only the owner of a business can create another workspace.',
          { reason: 'WORKSPACE_OWNER_ONLY' },
        );
      }
      return;
    }
    if (!allowance.canCreate) {
      throw new AppError(
        'QUOTA_EXCEEDED',
        'Your plan allows no more workspaces. Upgrade to add another.',
        {
          reason: 'WORKSPACE_ALLOWANCE_REACHED',
          used: allowance.used,
          allowed: allowance.allowed ?? 0,
        },
      );
    }
  }

  async #createFor(
    db: TenantScopedClient,
    input: CreateWorkspaceFromOnboardingInput,
    trialPlan: PlanDetail | null,
    planVersionId: string | null,
    ownerId: string,
    slug: string,
    name: string,
  ): Promise<WorkspaceCreated> {
    const owner = { id: ownerId };

    const ownerRole = await db.role.findFirst({
      where: { key: 'workspace_owner', realm: 'WORKSPACE', workspaceId: null },
      select: { id: true },
    });
    if (!ownerRole) {
      throw new AppError('INTERNAL', 'The workspace_owner system role is missing.');
    }

    const country = input.country.trim().toUpperCase();
    const currency = normaliseCurrency(input.currency);
    const now = this.#clock.now();

    const trialDays = trialPlan?.trialDays ?? 0;
    const pricing = trialPlan
      ? trialPlan.prices.find((p) => normaliseCurrency(p.currency) === currency)
      : undefined;
    const offersTrial = trialPlan !== null && trialDays > 0 && pricing !== undefined;
    const trialEndsAt = offersTrial ? new Date(now.getTime() + trialDays * 86_400_000) : null;

    try {
      /*
       * ALREADY INSIDE A TRANSACTION. `db` is the client a platform-scoped
       * runner handed us, which is itself a transaction — so these writes
       * already commit or roll back together, and opening a second one from
       * here is not possible and not needed.
       */
      const workspaceId = await (async (tx: TenantScopedClient) => {
        const id = crypto.randomUUID();
        await tx.workspace.create({
          data: {
            id,
            // Self-referential tenant key, so a Workspace row is filtered by the
            // same predicate as every other tenant-owned table.
            workspaceId: id,
            slug,
            name,
            type: (input.type ?? 'STARTUP') as never,
            status: offersTrial ? 'TRIALING' : 'ACTIVE',
            country,
            defaultLocale: input.defaultLocale,
            timezone: input.timezone.trim(),
            city: cityFor(country, input.city),
            currency,
            ownerUserId: owner.id,
            planKey: offersTrial ? trialPlan.key : null,
            planAssignedAt: offersTrial ? now : null,
            trialEndsAt,
          },
        });

        await tx.membership.create({
          data: {
            workspaceId: id,
            userId: owner.id,
            roleId: ownerRole.id,
            // ACTIVE, not INVITED: this person is signed in and just created it.
            status: 'ACTIVE',
            acceptedAt: now,
          },
        });

        await tx.creditWallet.create({ data: { workspaceId: id } });

        await tx.billingProfile.create({
          data: {
            workspaceId: id,
            billingEmail: input.billingEmail.trim().toLowerCase(),
            legalName: input.legalName?.trim() || null,
            // Defaults to where the workspace operates and may be changed later:
            // a company can be billed somewhere it does not trade.
            country,
          },
        });

        if (offersTrial && pricing) {
          await tx.workspaceSubscription.create({
            data: {
              workspaceId: id,
              planKey: trialPlan.key,
              status: 'TRIALING',
              billingInterval: 'MONTH',
              currency,
              // THE PRICE IS PINNED AT ASSIGNMENT (AC-04.7). A later catalogue
              // edit changes what NEW customers are offered and nothing here.
              pinnedMonthlyMinor: pricing.monthlyMinor,
              pinnedAnnualMinor: pricing.annualMinor,
              pinnedMonthlyCredits: trialPlan.monthlyCredits,
              pinnedFromVersionId: planVersionId,
              currentPeriodStart: now,
              // The trial IS the first period, so its end and the cycle boundary
              // are the same instant — anything else grants a monthly allowance
              // in the middle of a trial that already granted its own.
              currentPeriodEnd: trialEndsAt ?? now,
              trialStartedAt: now,
              trialEndsAt,
            },
          });

          if (trialPlan.trialCredits > 0) {
            await grantTrialCredits(tx, id, trialPlan.trialCredits, now);
          }
        }

        await tx.auditEvent.create({
          data: {
            workspaceId: id,
            actorType: 'USER',
            actorId: owner.id,
            action: 'customer.workspace.created',
            resourceType: 'workspace',
            resourceId: id,
            severity: 'NOTICE',
            outcome: 'SUCCESS',
            ip: input.ip ?? null,
            userAgent: input.userAgent ?? null,
            after: {
              slug,
              country,
              currency,
              defaultLocale: input.defaultLocale,
              timezone: input.timezone.trim(),
              trialPlanKey: offersTrial ? trialPlan.key : null,
            },
          },
        });

        return id;
      })(db);

      return {
        workspaceId,
        slug,
        trialPlanKey: offersTrial && pricing ? trialPlan.key : null,
        trialEndsAt: offersTrial && pricing ? trialEndsAt : null,
        trialCredits: offersTrial && pricing ? trialPlan.trialCredits : 0,
      };
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new AppError('CONFLICT', 'That workspace address is already taken.', {
          field: 'slug',
        });
      }
      throw error;
    }
  }
}

/**
 * Run `fn` in ONE transaction on `db`.
 *
 * The platform client a caller passes can open one, and the allowance check,
 * the owner-row lock and every row this service writes must commit or roll
 * back together — the lock only serialises anything while it is held. A client
 * that is ALREADY a transaction (no `$transaction`) runs `fn` inline.
 */
async function inOneTransaction<T>(
  db: TenantScopedClient,
  fn: (tx: TenantScopedClient) => Promise<T>,
): Promise<T> {
  const runner = db as unknown as {
    $transaction?: (callback: (tx: TenantScopedClient) => Promise<T>) => Promise<T>;
  };
  return typeof runner.$transaction === 'function' ? runner.$transaction(fn) : fn(db);
}

/**
 * The trial allowance, written as an immutable ledger movement.
 *
 * WRITTEN HERE RATHER THAN THROUGH THE LEDGER SERVICE because it must commit
 * with the workspace, and the service opens its own transaction. It uses the
 * SAME rows, the SAME idempotency key column and the SAME invariants — the
 * transaction is what differs, not the accounting.
 *
 * THE KEY IS THE WORKSPACE. `trial:<id>` is unique in the database, so a second
 * trial grant for the same workspace is refused by PostgreSQL even if some
 * future path forgets to check `trialStartedAt` first.
 */
async function grantTrialCredits(
  tx: TenantScopedClient,
  workspaceId: string,
  credits: number,
  now: Date,
): Promise<void> {
  const amount = BigInt(credits) * MILLI_PER_CREDIT;
  const wallet = await tx.creditWallet.findUniqueOrThrow({
    where: { workspaceId },
    select: { id: true, balanceMilliCredits: true },
  });

  const transaction = await tx.creditTransaction.create({
    data: {
      workspaceId,
      walletId: wallet.id,
      type: 'TRIAL_GRANT',
      amountMilliCredits: amount,
      // The wallet is brand new in this same transaction, so the balance after
      // is the grant itself. Written rather than derived at read time: the
      // ledger is the record, and a replay has to be able to check it.
      balanceAfterMilliCredits: wallet.balanceMilliCredits + amount,
      idempotencyKey: `trial:${workspaceId}`,
      actorType: 'SYSTEM',
      reason: 'Trial credits',
    },
    select: { id: true },
  });

  await tx.creditGrant.create({
    data: {
      workspaceId,
      walletId: wallet.id,
      source: 'TRIAL_GRANT',
      amountMilliCredits: amount,
      remainingMilliCredits: amount,
      sourceTransactionId: transaction.id,
      grantedAt: now,
      // The trial allowance lapses with the trial: credits from a trial are not
      // a balance a customer keeps by never converting.
      expiresAt: null,
      reason: 'Trial credits',
    },
  });

  await tx.creditWallet.update({
    where: { workspaceId },
    data: {
      balanceMilliCredits: { increment: amount },
      lifetimeGrantedMilliCredits: { increment: amount },
    },
  });
}

/**
 * Is this a zone the runtime recognises?
 *
 * ASKED OF THE PLATFORM, not of a list in this file. A hard-coded set of zones
 * goes stale every time a jurisdiction changes its rules, and the ICU data the
 * runtime already ships is the authority the formatting will use anyway.
 */
export function isValidTimezone(zone: string): boolean {
  const candidate = zone.trim();
  if (!candidate) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** G8 (D-335): a city only for Egypt, and only a governorate code. */
function cityFor(country: string, city: string | null | undefined): string | null {
  const value = city?.trim() ?? '';
  if (country !== CITY_COUNTRY || value === '') return null;
  if (!isEgyptCityCode(value)) throw new AppError('VALIDATION_FAILED', 'Choose a city.');
  return value;
}
