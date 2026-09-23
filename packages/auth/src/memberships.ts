// The client TYPE comes from @brandspace/database, the only package permitted
// to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';
import { assignableRoleKeys as rolesAssignableBy, assertMayAssignRole } from './role-assignment';
import { resolveGrantableBrandScope } from './brand-access';

/**
 * Workspace membership management — docs/DATABASE.md §3.3.
 *
 * TWO INVARIANTS, both enforced inside the transaction that would break them,
 * not by a check the caller is trusted to have done:
 *
 *   1. A workspace always keeps at least one ACTIVE Workspace Owner. Removing
 *      or demoting the last one is refused. Without this, a workspace can be
 *      orphaned — nobody can invite, nobody can change the plan, and only a
 *      platform actor can rescue it.
 *
 *   2. Nobody may grant a role they do not themselves hold the authority to
 *      grant. `workspace_admin` may not mint another `workspace_owner`, which
 *      would be a one-step escalation to the authority it was denied.
 */

/**
 * Run `fn` atomically, whether or not the caller already opened a transaction.
 *
 * The customer application calls these services INSIDE `withWorkspace()`, which
 * is itself a transaction that has set the tenant GUC. Prisma's interactive
 * transaction client exposes no `$transaction`, so opening another one there
 * would throw. The Control Center calls the same services on a full client and
 * does need one.
 *
 * Detecting which we hold keeps the atomicity guarantee in both cases without
 * two copies of every method: inside a scoped transaction the work is already
 * atomic, so running inline is correct rather than a compromise.
 */
async function runAtomically<T>(
  prisma: PrismaClient,
  fn: (db: PrismaClient) => Promise<T>,
): Promise<T> {
  const maybe = prisma as unknown as { $transaction?: unknown };
  if (typeof maybe.$transaction === 'function') {
    return prisma.$transaction(async (tx) => fn(tx as unknown as PrismaClient));
  }
  return fn(prisma);
}

/*
 * THE LADDER MOVED TO `./role-assignment`, and that is the fix for the
 * invitation escalation: `InvitationService` is the other path by which a
 * role reaches a person, and it was not consulting this table. One
 * definition, imported by both, is what makes the two paths agree.
 */

export interface MemberSummary {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly roleKey: string;
  readonly roleNameEn: string;
  readonly roleNameAr: string;
  readonly status: string;
  readonly joinedAt: Date | null;
  readonly isWorkspaceOwner: boolean;
  /** P6-13 — the brands this member sees; empty is every brand in the workspace. */
  readonly brandScope: readonly string[];
}

export interface MembershipActor {
  readonly userId: string;
  readonly roleKey: string;
  readonly permissionKeys: readonly string[];
}

export interface MembershipServiceOptions {
  readonly prisma: PrismaClient;
  readonly clock?: Clock;
}

export class MembershipService {
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;

  constructor(options: MembershipServiceOptions) {
    this.#prisma = options.prisma;
    this.#clock = options.clock ?? systemClock;
  }

  async list(workspaceId: string): Promise<MemberSummary[]> {
    const [workspace, memberships] = await Promise.all([
      this.#prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { ownerUserId: true },
      }),
      this.#prisma.membership.findMany({
        where: { workspaceId, status: { not: 'REMOVED' } },
        include: { user: true, role: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return memberships.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      roleKey: m.role.key,
      roleNameEn: m.role.nameEn,
      roleNameAr: m.role.nameAr,
      status: m.status,
      joinedAt: m.acceptedAt,
      isWorkspaceOwner: workspace?.ownerUserId === m.userId,
      brandScope: m.brandScope,
    }));
  }

  /**
   * Which roles this actor may assign.
   *
   * Exposed so the UI can render only assignable options — but the server-side
   * check below is the control. Hiding an option is not authorization.
   */
  assignableRoleKeys(actorRoleKey: string): readonly string[] {
    return rolesAssignableBy(actorRoleKey);
  }

  /**
   * Change a member's role.
   *
   * Refuses when: the actor lacks `member.assign_role`; the target role is
   * above what the actor may assign; the target role belongs to another realm
   * or another workspace; or the change would leave the workspace with no
   * active owner.
   */
  async changeRole(
    workspaceId: string,
    actor: MembershipActor,
    membershipId: string,
    newRoleId: string,
  ): Promise<void> {
    if (!actor.permissionKeys.includes('member.assign_role')) {
      throw new AppError('FORBIDDEN', 'Changing a member role requires member.assign_role.');
    }

    await runAtomically(this.#prisma, async (tx) => {
      // First, before anything is read or written: the owner check below is a
      // COUNT, and a count under READ COMMITTED cannot see a concurrent
      // demotion. See `#lockWorkspace`.
      await this.#lockWorkspace(tx, workspaceId);

      const membership = await tx.membership.findFirst({
        where: { id: membershipId, workspaceId, status: { not: 'REMOVED' } },
        include: { role: true },
      });
      if (!membership) throw new AppError('NOT_FOUND', 'Member not found.');

      const newRole = await tx.role.findUnique({ where: { id: newRoleId } });
      if (!newRole || newRole.realm !== 'WORKSPACE') {
        throw new AppError('VALIDATION_FAILED', 'Unknown workspace role.');
      }
      if (newRole.workspaceId !== null && newRole.workspaceId !== workspaceId) {
        throw new AppError('VALIDATION_FAILED', 'Unknown workspace role.');
      }

      assertMayAssignRole(actor.roleKey, newRole.key, 'Changing a member role');
      // Nor may an actor edit somebody who outranks what they can assign —
      // otherwise an admin could demote the owner and then take the workspace.
      if (!rolesAssignableBy(actor.roleKey).includes(membership.role.key)) {
        throw new AppError('FORBIDDEN', 'Your role may not change that member.');
      }

      await tx.membership.update({ where: { id: membershipId }, data: { roleId: newRoleId } });
      await this.#assertOwnerRemains(tx, workspaceId);

      await tx.auditEvent.create({
        data: {
          workspaceId,
          actorType: 'USER',
          actorId: actor.userId,
          action: 'workspace.member.role_changed',
          resourceType: 'membership',
          resourceId: membershipId,
          severity: 'NOTICE',
          outcome: 'SUCCESS',
          before: { roleKey: membership.role.key },
          after: { roleKey: newRole.key },
        },
      });
    });

    // A role change invalidates nothing by itself — permissions are recomputed
    // on every resolve — but the audit trail records when it happened.
  }

  /**
   * Change which brands a member can see (P6-13).
   *
   * THE SAME AUTHORITY AS A ROLE CHANGE, because BrandScope IS authorization:
   * `member.assign_role`, and only over a member whose role the actor could
   * assign (an admin cannot narrow the owner). The requested brands go through
   * `resolveGrantableBrandScope`, so they must be this workspace's, and a
   * brand-restricted actor can grant only a subset of their own brands.
   *
   * THE WORKSPACE OWNER IS NEVER RESTRICTED. An owner who could be narrowed out
   * of a brand would still own the workspace that contains it — billing,
   * deletion and ownership transfer over something they cannot see — so the
   * owner's scope stays "every brand".
   *
   * TAKES EFFECT ON THE MEMBER'S NEXT REQUEST: the session resolves BrandScope
   * from the membership row every time, so there is nothing to revoke.
   */
  async changeBrandAccess(
    workspaceId: string,
    actor: MembershipActor & { readonly brandScope: readonly string[] },
    membershipId: string,
    brandScope: readonly string[],
  ): Promise<void> {
    if (!actor.permissionKeys.includes('member.assign_role')) {
      throw new AppError('FORBIDDEN', 'Changing brand access requires member.assign_role.');
    }

    await runAtomically(this.#prisma, async (tx) => {
      await this.#lockWorkspace(tx, workspaceId);

      const membership = await tx.membership.findFirst({
        where: { id: membershipId, workspaceId, status: { not: 'REMOVED' } },
        include: { role: true },
      });
      if (!membership) throw new AppError('NOT_FOUND', 'Member not found.');

      if (!rolesAssignableBy(actor.roleKey).includes(membership.role.key)) {
        throw new AppError('FORBIDDEN', 'Your role may not change that member.');
      }

      const next = await resolveGrantableBrandScope(tx, {
        workspaceId,
        actorBrandScope: actor.brandScope,
        requested: brandScope,
      });

      const workspace = await tx.workspace.findUnique({
        where: { id: workspaceId },
        select: { ownerUserId: true },
      });
      if (workspace?.ownerUserId === membership.userId && next.length > 0) {
        throw new AppError('VALIDATION_FAILED', 'The workspace owner always sees every brand.');
      }

      await tx.membership.update({ where: { id: membershipId }, data: { brandScope: next } });
      await tx.auditEvent.create({
        data: {
          workspaceId,
          actorType: 'USER',
          actorId: actor.userId,
          action: 'workspace.member.brand_access_changed',
          resourceType: 'membership',
          resourceId: membershipId,
          severity: 'NOTICE',
          outcome: 'SUCCESS',
          before: { brandScope: membership.brandScope },
          after: { brandScope: next },
        },
      });
    });
  }

  /**
   * Remove a member (soft: status REMOVED, so the history survives).
   *
   * The last active owner cannot be removed. Their sessions scoped to this
   * workspace are revoked, so access ends at once rather than at token expiry.
   */
  async remove(
    workspaceId: string,
    actor: MembershipActor,
    membershipId: string,
    reason: string,
  ): Promise<void> {
    if (!actor.permissionKeys.includes('member.remove')) {
      throw new AppError('FORBIDDEN', 'Removing a member requires member.remove.');
    }

    const removedUserId = await runAtomically(this.#prisma, async (tx) => {
      // Same mutex as `changeRole`, same order. A removal and a demotion
      // racing each other is the same write skew as two demotions.
      await this.#lockWorkspace(tx, workspaceId);

      const membership = await tx.membership.findFirst({
        where: { id: membershipId, workspaceId, status: { not: 'REMOVED' } },
        include: { role: true },
      });
      if (!membership) throw new AppError('NOT_FOUND', 'Member not found.');

      const allowed = rolesAssignableBy(actor.roleKey);
      if (!allowed.includes(membership.role.key)) {
        throw new AppError('FORBIDDEN', 'Your role may not remove that member.');
      }

      await tx.membership.update({
        where: { id: membershipId },
        data: { status: 'REMOVED' },
      });
      await this.#assertOwnerRemains(tx, workspaceId);

      await tx.auditEvent.create({
        data: {
          workspaceId,
          actorType: 'USER',
          actorId: actor.userId,
          action: 'workspace.member.removed',
          resourceType: 'membership',
          resourceId: membershipId,
          severity: 'NOTICE',
          outcome: 'SUCCESS',
          reason,
          before: { roleKey: membership.role.key, userId: membership.userId },
        },
      });
      return membership.userId;
    });

    await this.#prisma.customerSession.updateMany({
      where: { userId: removedUserId, activeWorkspaceId: workspaceId, revokedAt: null },
      data: { revokedAt: this.#clock.now(), revokedReason: 'Membership removed' },
    });
  }

  /**
   * Serialise every membership change that could affect ownership — A-5.
   *
   * THE RACE THIS CLOSES. `#assertOwnerRemains` is a COUNT, and a count takes
   * no locks. Two owners, two concurrent demotions: T1 demotes A then counts,
   * T2 demotes B then counts. Under READ COMMITTED each sees only its own
   * uncommitted write plus committed data, so T1 still sees B as an owner and
   * T2 still sees A. Both count one, both pass, both commit — and the
   * workspace has no owner at all. Textbook write skew: two transactions each
   * reading what the other is about to invalidate, touching DIFFERENT rows so
   * nothing conflicts.
   *
   * Neither row-level locking on the memberships nor a stricter count fixes
   * it, because the rows being written are not the rows being read. What is
   * needed is a mutex over the SET, and the workspace row is the natural one:
   * every membership belongs to exactly one workspace, so taking it first
   * serialises all of that workspace's ownership-affecting changes while
   * leaving other workspaces entirely unaffected.
   *
   * Taken BEFORE the membership row is touched, always in this order, so two
   * of these can queue but never deadlock.
   */
  async #lockWorkspace(tx: Pick<PrismaClient, '$queryRaw'>, workspaceId: string): Promise<void> {
    await tx.$queryRaw`
      SELECT "id" FROM "workspace" WHERE "id" = ${workspaceId}::uuid FOR UPDATE`;
  }

  /**
   * The owner invariant.
   *
   * Runs INSIDE the caller's transaction and after the write, so it sees the
   * post-change state and rolls the whole thing back when the workspace would
   * be left ownerless.
   *
   * Correct ONLY because `#lockWorkspace` ran first: without that, this count
   * is the read half of the write skew documented above.
   */
  async #assertOwnerRemains(
    tx: Pick<PrismaClient, 'membership' | 'workspace'>,
    workspaceId: string,
  ): Promise<void> {
    const owners = await tx.membership.count({
      where: { workspaceId, status: 'ACTIVE', role: { key: 'workspace_owner' } },
    });
    if (owners === 0) {
      throw new AppError(
        'CONFLICT',
        'A workspace must always keep at least one active Workspace Owner.',
      );
    }
  }
}
