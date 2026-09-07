import type { PrismaClient } from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';

/**
 * Beta cohort membership — the targeting dimension the precedence engine has
 * always supported and never had data for.
 *
 * The cohort DEFINITIONS are configuration (`beta-cohorts`). Membership is a
 * row, for the same reason a workspace override is: it is per-customer state
 * with an author, a reason and a date, and it belongs in the audit trail rather
 * than in a configuration document that would grow a line per customer.
 */

export const COHORT_MANAGE_PERMISSION = 'platform.entitlement.override';

export interface CohortActor {
  readonly platformUserId: string;
  readonly roleKey: string;
  readonly mfaVerified: boolean;
  readonly permissionKeys: readonly string[];
}

export interface CohortMembershipView {
  readonly workspaceId: string;
  readonly cohortKey: string;
  readonly reason: string;
  readonly addedAt: Date;
}

export class BetaCohortService {
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;

  constructor(options: { prisma: PrismaClient; clock?: Clock }) {
    this.#prisma = options.prisma;
    this.#clock = options.clock ?? systemClock;
  }

  async membershipsFor(workspaceId: string): Promise<CohortMembershipView[]> {
    const rows = await this.#prisma.betaCohortMembership.findMany({
      where: { workspaceId },
      orderBy: { cohortKey: 'asc' },
    });
    return rows.map((r) => ({
      workspaceId: r.workspaceId,
      cohortKey: r.cohortKey,
      reason: r.reason,
      addedAt: r.addedAt,
    }));
  }

  async membersOf(cohortKey: string, take = 100): Promise<CohortMembershipView[]> {
    const rows = await this.#prisma.betaCohortMembership.findMany({
      where: { cohortKey },
      orderBy: { addedAt: 'desc' },
      take,
    });
    return rows.map((r) => ({
      workspaceId: r.workspaceId,
      cohortKey: r.cohortKey,
      reason: r.reason,
      addedAt: r.addedAt,
    }));
  }

  /**
   * Put a workspace in a cohort.
   *
   * `knownCohortKeys` comes from the active `beta-cohorts` configuration. A
   * membership of a cohort nobody defined would target nothing and look like a
   * flag that silently does not work, so it is refused here.
   */
  async add(
    actor: CohortActor,
    workspaceId: string,
    cohortKey: string,
    reason: string,
    knownCohortKeys: readonly string[],
  ): Promise<void> {
    await this.#authorize(actor, 'cohorts.add');

    if (reason.trim().length < 8) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Adding a workspace to a cohort requires a written reason of at least 8 characters.',
      );
    }
    if (knownCohortKeys.length > 0 && !knownCohortKeys.includes(cohortKey)) {
      throw new AppError('VALIDATION_FAILED', `Unknown beta cohort "${cohortKey}".`);
    }

    await this.#prisma.$transaction(async (tx) => {
      await tx.betaCohortMembership.upsert({
        where: { workspaceId_cohortKey: { workspaceId, cohortKey } },
        create: {
          workspaceId,
          cohortKey,
          addedByPlatformUserId: actor.platformUserId,
          reason: reason.trim(),
          addedAt: this.#clock.now(),
        },
        update: { reason: reason.trim() },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId,
          actorType: 'PLATFORM_USER',
          actorId: actor.platformUserId,
          action: 'platform.beta_cohort.added',
          resourceType: 'beta_cohort_membership',
          resourceId: workspaceId,
          severity: 'NOTICE',
          outcome: 'SUCCESS',
          reason: reason.trim(),
          after: { cohortKey },
        },
      });
    });
  }

  async remove(actor: CohortActor, workspaceId: string, cohortKey: string): Promise<void> {
    await this.#authorize(actor, 'cohorts.remove');

    const removed = await this.#prisma.betaCohortMembership.deleteMany({
      where: { workspaceId, cohortKey },
    });
    if (removed.count === 0) {
      throw new AppError('NOT_FOUND', 'That workspace is not in that cohort.');
    }

    await this.#prisma.auditEvent.create({
      data: {
        workspaceId,
        actorType: 'PLATFORM_USER',
        actorId: actor.platformUserId,
        action: 'platform.beta_cohort.removed',
        resourceType: 'beta_cohort_membership',
        resourceId: workspaceId,
        severity: 'NOTICE',
        outcome: 'SUCCESS',
        before: { cohortKey },
      },
    });
  }

  async #authorize(actor: CohortActor, operation: string): Promise<void> {
    const denial = cohortDenialReason(actor, operation);
    if (denial === null) return;

    if (actor?.platformUserId) {
      try {
        await this.#prisma.auditEvent.create({
          data: {
            workspaceId: null,
            actorType: 'PLATFORM_USER',
            actorId: actor.platformUserId,
            action: 'platform.beta_cohort.access.denied',
            resourceType: 'beta_cohort_membership',
            severity: 'WARNING',
            outcome: 'DENIED',
            reason: denial,
          },
        });
      } catch {
        // A denial that cannot be recorded is still a denial.
      }
    }
    throw new AppError('FORBIDDEN', denial);
  }
}

export function cohortDenialReason(
  actor: CohortActor | null | undefined,
  operation: string,
): string | null {
  if (!actor?.platformUserId) return `${operation} requires a platform actor.`;
  if (!actor.mfaVerified) return `${operation} requires verified MFA (D-27).`;
  if (!actor.permissionKeys?.includes(COHORT_MANAGE_PERMISSION)) {
    return `${operation} requires ${COHORT_MANAGE_PERMISSION}.`;
  }
  return null;
}
