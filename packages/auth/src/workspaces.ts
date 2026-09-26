// The client TYPE comes from @brandspace/database, the only package permitted
// to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';

/**
 * Customer and workspace lifecycle, operated from Platform Admin.
 *
 * docs/ADMIN-CONTROL-CENTER.md §3.3, docs/DATABASE.md §3.2.
 *
 * AUTHORISATION IS ENFORCED HERE, in the service, not only in the page or the
 * server action. R-02 in Phase 2A was exactly this mistake: the services
 * trusted "an actor exists and has MFA", so calling one directly bypassed RBAC
 * entirely. Every method below names the permission it requires and audits the
 * denial.
 *
 * THERE IS NO HARD DELETE. `archive()` retains the data and takes the workspace
 * out of the working set (CLAUDE.md §2.5). Purging belongs to the data-deletion
 * lifecycle in docs/SECURITY.md §15, which is not Phase 2B.
 */

export const PLATFORM_WORKSPACE_READ = 'platform.workspace.read';
export const PLATFORM_WORKSPACE_CREATE = 'platform.workspace.create';
export const PLATFORM_WORKSPACE_UPDATE = 'platform.workspace.update';
export const PLATFORM_WORKSPACE_SUSPEND = 'platform.workspace.suspend';

/** Status transitions the Control Center permits. Anything else is refused. */
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  TRIALING: ['ACTIVE', 'SUSPENDED', 'CANCELLED', 'ARCHIVED'],
  ACTIVE: ['SUSPENDED', 'PAST_DUE', 'CANCELLED', 'ARCHIVED'],
  PAST_DUE: ['ACTIVE', 'SUSPENDED', 'CANCELLED'],
  SUSPENDED: ['ACTIVE', 'TRIALING', 'CANCELLED', 'ARCHIVED'],
  CANCELLED: ['ARCHIVED'],
  // Terminal states. Reviving them is not a Control Center action.
  ARCHIVED: [],
  DELETED: [],
};

/** Statuses in which a customer session may operate. */
export const OPERABLE_WORKSPACE_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE'] as const;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;

export interface PlatformWorkspaceActor {
  readonly platformUserId: string;
  readonly roleKey: string;
  readonly mfaVerified: boolean;
  readonly permissionKeys: readonly string[];
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly slug: string;
  readonly ownerEmail: string;
  readonly ownerName?: string | undefined;
  readonly type?: string | undefined;
  /*
   * REQUIRED, NOT OPTIONAL WITH A FALLBACK (D-194).
   *
   * These four were optional and fell back to `SA` / `AR` / `Asia/Riyadh` /
   * `SAR`, so every workspace anybody forgot to configure became a Saudi one.
   * Making them required moves the question from runtime to COMPILE TIME: a
   * caller that does not know where its customer is cannot proceed by accident,
   * and the compiler names every place that has to ask.
   *
   * Phase 9's onboarding is what will ask a customer directly; until then the
   * platform operator supplies them, explicitly, on the create form.
   */
  readonly country: string;
  readonly defaultLocale: 'AR' | 'EN';
  readonly timezone: string;
  readonly currency: string;
  readonly planKey?: string | undefined;
  readonly trialDays?: number | undefined;
}

export interface UpdateWorkspaceInput {
  readonly name?: string | undefined;
  readonly slug?: string | undefined;
  readonly defaultLocale?: 'AR' | 'EN' | undefined;
  readonly timezone?: string | undefined;
  readonly country?: string | undefined;
  readonly currency?: string | undefined;
  /** Optimistic concurrency: the value the operator's page was rendered with. */
  readonly lockVersion: number;
}

export interface WorkspaceListItem {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly type: string;
  readonly country: string;
  readonly planKey: string | null;
  readonly memberCount: number;
  readonly createdAt: Date;
  readonly lastActivityAt: Date | null;
}

/** One page of workspaces. Same shape as `SecretPage`, deliberately (A-11). */
export interface WorkspacePage {
  readonly items: readonly WorkspaceListItem[];
  readonly page: number;
  readonly pageSize: number;
  /** Total MATCHING workspaces, not the number on this page. */
  readonly total: number;
  readonly totalPages: number;
  readonly from: number;
  readonly to: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

export const WORKSPACE_PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_WORKSPACE_PAGE_SIZE = 50;
/** A bound on ONE REQUEST, not on what an operator may see. */
export const MAX_WORKSPACE_PAGE_SIZE = 200;

function normaliseWorkspacePageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_WORKSPACE_PAGE_SIZE;
  }
  const size = Math.trunc(requested);
  if (size < 1) return DEFAULT_WORKSPACE_PAGE_SIZE;
  return Math.min(size, MAX_WORKSPACE_PAGE_SIZE);
}

export interface WorkspaceDetail extends WorkspaceListItem {
  readonly defaultLocale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly ownerEmail: string | null;
  readonly statusReason: string | null;
  readonly statusChangedAt: Date | null;
  readonly statusChangedBy: string | null;
  readonly suspendedAt: Date | null;
  readonly trialEndsAt: Date | null;
  readonly archivedAt: Date | null;
  readonly planAssignedAt: Date | null;
  readonly lockVersion: number;
}

export interface WorkspaceServiceOptions {
  readonly prisma: PrismaClient;
  readonly clock?: Clock;
}

export class WorkspaceAdminService {
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;

  constructor(options: WorkspaceServiceOptions) {
    this.#prisma = options.prisma;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * One PAGE of workspaces — A-11, the same contract F-53 established for
   * secrets (`docs/ADMIN-CONTROL-CENTER.md` §7.1).
   *
   * THIS USED TO TAKE 200 ROWS AND RETURN THEM AS THE ANSWER. No total, no
   * navigation, nothing on screen to say more existed — which is precisely the
   * SILENT DISPLAY CAP that F-53 rejected for secrets and then went unfixed
   * here. An operator with 201 customers simply stopped seeing one, and there
   * was no way to tell from the page that anything was missing.
   *
   * The distinction that matters is the same one: `pageSize` bounds what ONE
   * REQUEST materialises, `total` always reports the truth, and every record
   * stays reachable by paging.
   */
  async list(
    actor: PlatformWorkspaceActor,
    filter: {
      readonly query?: string;
      readonly status?: string;
      readonly page?: number;
      readonly pageSize?: number;
    } = {},
  ): Promise<WorkspacePage> {
    await this.#authorize(actor, 'workspace.list', PLATFORM_WORKSPACE_READ);

    const pageSize = normaliseWorkspacePageSize(filter.pageSize);
    const where = {
      deletedAt: null,
      ...(filter.status ? { status: filter.status as never } : {}),
      ...(filter.query
        ? {
            OR: [
              { name: { contains: filter.query, mode: 'insensitive' as const } },
              { slug: { contains: filter.query.toLowerCase() } },
            ],
          }
        : {}),
    };

    const total = await this.#prisma.workspace.count({ where });
    const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
    const requested = Number.isFinite(filter.page) ? Math.trunc(filter.page ?? 1) : 1;
    const page = Math.min(Math.max(requested, 1), totalPages);

    const rows = await this.#prisma.workspace.findMany({
      where,
      include: { _count: { select: { memberships: true } } },
      // `id` makes the order total, so a workspace cannot land on two pages or
      // on none when two share a creation timestamp.
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const items = rows.map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      status: w.status,
      type: w.type,
      country: w.country,
      planKey: w.planKey,
      memberCount: w._count.memberships,
      createdAt: w.createdAt,
      lastActivityAt: w.lastActivityAt,
    }));

    return {
      items,
      page,
      pageSize,
      total,
      totalPages,
      from: total === 0 ? 0 : (page - 1) * pageSize + 1,
      to: total === 0 ? 0 : (page - 1) * pageSize + items.length,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
    };
  }

  async get(actor: PlatformWorkspaceActor, workspaceId: string): Promise<WorkspaceDetail> {
    await this.#authorize(actor, 'workspace.get', PLATFORM_WORKSPACE_READ);
    const w = await this.#prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      include: { owner: true, _count: { select: { memberships: true } } },
    });
    if (!w) throw new AppError('NOT_FOUND', 'Workspace not found.');

    let statusChangedBy: string | null = null;
    if (w.statusChangedByPlatformUserId) {
      const actorRow = await this.#prisma.platformUser.findUnique({
        where: { id: w.statusChangedByPlatformUserId },
        select: { email: true },
      });
      statusChangedBy = actorRow?.email ?? null;
    }

    return {
      id: w.id,
      name: w.name,
      slug: w.slug,
      status: w.status,
      type: w.type,
      country: w.country,
      planKey: w.planKey,
      memberCount: w._count.memberships,
      createdAt: w.createdAt,
      lastActivityAt: w.lastActivityAt,
      defaultLocale: w.defaultLocale,
      timezone: w.timezone,
      currency: w.currency,
      ownerEmail: w.owner?.email ?? null,
      statusReason: w.statusReason,
      statusChangedAt: w.statusChangedAt,
      statusChangedBy,
      suspendedAt: w.suspendedAt,
      trialEndsAt: w.trialEndsAt,
      archivedAt: w.archivedAt,
      planAssignedAt: w.planAssignedAt,
      lockVersion: w.lockVersion,
    };
  }

  /**
   * Create the customer shell and their workspace in one transaction.
   *
   * The owner `User` is created WITHOUT a password: they arrive through an
   * invitation. No default credential is ever minted — the same rule that
   * closed R-04 in the seed.
   */
  async create(
    actor: PlatformWorkspaceActor,
    input: CreateWorkspaceInput,
  ): Promise<{ readonly workspaceId: string; readonly ownerUserId: string }> {
    await this.#authorize(actor, 'workspace.create', PLATFORM_WORKSPACE_CREATE);

    const slug = input.slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A slug is 3–50 characters of lower-case letters, digits and hyphens.',
      );
    }
    const name = input.name.trim();
    if (name.length < 2) throw new AppError('VALIDATION_FAILED', 'A workspace name is required.');
    const ownerEmail = input.ownerEmail.trim().toLowerCase();
    if (!ownerEmail.includes('@')) {
      throw new AppError('VALIDATION_FAILED', 'A valid owner email address is required.');
    }

    try {
      return await this.#prisma.$transaction(async (tx) => {
        const owner = await tx.user.upsert({
          where: { email: ownerEmail },
          create: {
            email: ownerEmail,
            name: input.ownerName?.trim() || null,
            // PENDING and passwordless: the invitation makes the account usable.
            status: 'PENDING',
            locale: input.defaultLocale,
            // The owner of a workspace works where the workspace works, until
            // they say otherwise. An explicit value, not a platform assumption.
            timezone: input.timezone,
          },
          update: {},
        });

        const ownerRole = await tx.role.findFirst({
          where: { key: 'workspace_owner', realm: 'WORKSPACE', workspaceId: null },
        });
        if (!ownerRole) {
          throw new AppError(
            'INTERNAL',
            'The workspace_owner system role is missing. Run the database seed.',
          );
        }

        const workspaceId = crypto.randomUUID();
        const trialDays = input.trialDays ?? 0;
        const workspace = await tx.workspace.create({
          data: {
            id: workspaceId,
            // Self-referential tenant key: a Workspace row is itself filtered by
            // the same predicate as every other tenant-owned table.
            workspaceId,
            slug,
            name,
            type: (input.type ?? 'STARTUP') as never,
            status: trialDays > 0 ? 'TRIALING' : 'ACTIVE',
            country: input.country,
            defaultLocale: input.defaultLocale,
            timezone: input.timezone,
            currency: input.currency,
            ownerUserId: owner.id,
            planKey: input.planKey ?? null,
            planAssignedAt: input.planKey ? this.#clock.now() : null,
            planAssignedByPlatformUserId: input.planKey ? actor.platformUserId : null,
            trialEndsAt:
              trialDays > 0
                ? new Date(this.#clock.now().getTime() + trialDays * 24 * 60 * 60 * 1000)
                : null,
          },
        });

        await tx.membership.create({
          data: {
            workspaceId: workspace.id,
            userId: owner.id,
            roleId: ownerRole.id,
            // INVITED until they accept: the owner is not an active member of a
            // workspace they have never signed in to.
            status: 'INVITED',
          },
        });

        // Every workspace gets a wallet at creation, so no later code path has
        // to invent one under concurrency.
        await tx.creditWallet.create({ data: { workspaceId: workspace.id } });

        await tx.auditEvent.create({
          data: {
            workspaceId: workspace.id,
            actorType: 'PLATFORM_USER',
            actorId: actor.platformUserId,
            action: 'platform.workspace.created',
            resourceType: 'workspace',
            resourceId: workspace.id,
            severity: 'NOTICE',
            outcome: 'SUCCESS',
            after: { slug, name, planKey: input.planKey ?? null },
          },
        });

        return { workspaceId: workspace.id, ownerUserId: owner.id };
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new AppError('CONFLICT', 'That workspace slug is already taken.');
      }
      throw error;
    }
  }

  /**
   * Edit workspace details under optimistic concurrency.
   *
   * `lockVersion` travels in the WHERE of a conditional UPDATE, so a second
   * operator's save is refused rather than silently discarding the first.
   */
  async update(
    actor: PlatformWorkspaceActor,
    workspaceId: string,
    input: UpdateWorkspaceInput,
  ): Promise<void> {
    await this.#authorize(actor, 'workspace.update', PLATFORM_WORKSPACE_UPDATE);

    const before = await this.#prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
    });
    if (!before) throw new AppError('NOT_FOUND', 'Workspace not found.');

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length < 2) throw new AppError('VALIDATION_FAILED', 'A workspace name is required.');
      data['name'] = name;
    }
    if (input.slug !== undefined) {
      const slug = input.slug.trim().toLowerCase();
      if (!SLUG_PATTERN.test(slug)) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A slug is 3–50 characters of lower-case letters, digits and hyphens.',
        );
      }
      data['slug'] = slug;
    }
    if (input.defaultLocale !== undefined) data['defaultLocale'] = input.defaultLocale;
    if (input.timezone !== undefined) data['timezone'] = input.timezone.trim();
    if (input.country !== undefined) {
      data['country'] = input.country.trim().toUpperCase();
      // A9 (D-330): a city is an Egyptian governorate, so it goes with Egypt
      // (CHECK `workspace_city_egypt_only` would refuse it anyway).
      if (data['country'] !== 'EG') data['city'] = null;
    }
    if (input.currency !== undefined) data['currency'] = input.currency.trim().toUpperCase();

    try {
      const updated = await this.#prisma.workspace.updateMany({
        where: { id: workspaceId, lockVersion: input.lockVersion, deletedAt: null },
        data: { ...data, lockVersion: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new AppError('CONFLICT', 'This workspace was changed by someone else. Reload.', {
          expectedLockVersion: input.lockVersion,
        });
      }
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new AppError('CONFLICT', 'That workspace slug is already taken.');
      }
      throw error;
    }

    await this.#prisma.auditEvent.create({
      data: {
        workspaceId,
        actorType: 'PLATFORM_USER',
        actorId: actor.platformUserId,
        action: 'platform.workspace.updated',
        resourceType: 'workspace',
        resourceId: workspaceId,
        severity: 'NOTICE',
        outcome: 'SUCCESS',
        before: { name: before.name, slug: before.slug, timezone: before.timezone },
        after: JSON.parse(JSON.stringify(data)),
      },
    });
  }

  /**
   * Move a workspace through its lifecycle.
   *
   * An unsafe transition is refused by name, and a reason is mandatory for
   * every state a customer would notice. Suspending or archiving revokes the
   * sessions scoped to THAT workspace only — a member of two workspaces stays
   * signed in to the other.
   */
  async changeStatus(
    actor: PlatformWorkspaceActor,
    workspaceId: string,
    nextStatus: string,
    reason: string,
    lockVersion: number,
  ): Promise<void> {
    await this.#authorize(actor, 'workspace.change_status', PLATFORM_WORKSPACE_SUSPEND);

    if (reason.trim().length < 8) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A written reason of at least 8 characters is required for a lifecycle change.',
      );
    }

    const workspace = await this.#prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
    });
    if (!workspace) throw new AppError('NOT_FOUND', 'Workspace not found.');

    const allowed = ALLOWED_TRANSITIONS[workspace.status] ?? [];
    if (!allowed.includes(nextStatus)) {
      throw new AppError(
        'CONFLICT',
        `A workspace cannot move from ${workspace.status} to ${nextStatus}.`,
      );
    }

    const now = this.#clock.now();
    const updated = await this.#prisma.workspace.updateMany({
      where: { id: workspaceId, lockVersion, deletedAt: null },
      data: {
        status: nextStatus as never,
        statusReason: reason.trim(),
        statusChangedAt: now,
        statusChangedByPlatformUserId: actor.platformUserId,
        suspendedAt: nextStatus === 'SUSPENDED' ? now : null,
        suspendedReason: nextStatus === 'SUSPENDED' ? reason.trim() : null,
        archivedAt: nextStatus === 'ARCHIVED' ? now : workspace.archivedAt,
        lockVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new AppError('CONFLICT', 'This workspace was changed by someone else. Reload.', {
        expectedLockVersion: lockVersion,
      });
    }

    if (!(OPERABLE_WORKSPACE_STATUSES as readonly string[]).includes(nextStatus)) {
      await this.#prisma.customerSession.updateMany({
        where: { activeWorkspaceId: workspaceId, revokedAt: null },
        data: { revokedAt: now, revokedReason: `Workspace ${nextStatus.toLowerCase()}` },
      });
    }

    await this.#prisma.auditEvent.create({
      data: {
        workspaceId,
        actorType: 'PLATFORM_USER',
        actorId: actor.platformUserId,
        action: `platform.workspace.${nextStatus.toLowerCase()}`,
        resourceType: 'workspace',
        resourceId: workspaceId,
        severity: nextStatus === 'SUSPENDED' || nextStatus === 'ARCHIVED' ? 'WARNING' : 'NOTICE',
        outcome: 'SUCCESS',
        reason: reason.trim(),
        before: { status: workspace.status },
        after: { status: nextStatus },
      },
    });
  }

  /** Recent audited activity for one workspace, for the detail page. */
  async recentActivity(
    actor: PlatformWorkspaceActor,
    workspaceId: string,
    take = 25,
  ): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly action: string;
      readonly occurredAt: Date;
      readonly actorType: string;
      readonly outcome: string;
      readonly reason: string | null;
    }>
  > {
    await this.#authorize(actor, 'workspace.activity', PLATFORM_WORKSPACE_READ);
    const rows = await this.#prisma.auditEvent.findMany({
      where: { workspaceId },
      orderBy: { occurredAt: 'desc' },
      take,
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      occurredAt: r.occurredAt,
      actorType: r.actorType,
      outcome: r.outcome,
      reason: r.reason,
    }));
  }

  // --- Authorisation -------------------------------------------------------

  async #authorize(
    actor: PlatformWorkspaceActor,
    operation: string,
    permission: string,
  ): Promise<void> {
    const denial = denialReason(actor, operation, permission);
    if (denial === null) return;

    if (actor?.platformUserId) {
      try {
        await this.#prisma.auditEvent.create({
          data: {
            workspaceId: null,
            actorType: 'PLATFORM_USER',
            actorId: actor.platformUserId,
            action: 'platform.workspace.access.denied',
            resourceType: 'workspace',
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

/**
 * The precise reason an actor may not perform an operation.
 *
 * Returned in full to the operator — an admin tool that says only "forbidden"
 * wastes an afternoon. It names a permission, never a payload.
 */
export function denialReason(
  actor: PlatformWorkspaceActor | null | undefined,
  operation: string,
  permission: string,
): string | null {
  if (!actor?.platformUserId) return `${operation} requires a platform actor.`;
  if (!actor.mfaVerified) return `${operation} requires verified MFA (D-27).`;
  if (!actor.permissionKeys?.includes(permission)) return `${operation} requires ${permission}.`;
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
