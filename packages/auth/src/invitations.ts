import { createHash, randomBytes } from 'node:crypto';
// The client TYPE comes from @brandspace/database, the only package permitted
// to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';
import { hashPassword } from './password';

/**
 * Workspace invitations — docs/SECURITY.md §3, docs/DATABASE.md §10.
 *
 * THE TOKEN IS NEVER STORED. Only its SHA-256 hash reaches the database; the
 * raw value exists in the returned object, goes into one email, and is then
 * gone. A database dump therefore contains no usable invitation.
 *
 * ACCEPTANCE IS ONE CONDITIONAL UPDATE requiring exactly one affected row, so
 * two concurrent acceptances of the same link cannot both succeed. Read-then-
 * write was defect R-03 in the recovery-code path; it is not repeated here.
 *
 * NOTHING LEAKS EXISTENCE. Expired, revoked, already-accepted, superseded and
 * simply-wrong tokens all produce the same error. So does a token for a
 * different email address: telling the holder "this invitation is for someone
 * else" confirms that an invitation exists and names a workspace.
 */

/**
 * Run `fn` atomically, whether or not the caller already opened a transaction.
 *
 * The customer application calls these services INSIDE `withWorkspace()`, which
 * is itself a transaction that has set the tenant GUC. The Control Center calls
 * the same services on a full client, which has no transaction yet.
 *
 * Both cases end up atomic. Prisma's interactive-transaction client still
 * exposes `$transaction`, and calling it REUSES the enclosing transaction — it
 * does not open a nested one — so the callback runs in the caller's transaction
 * with the caller's tenant context intact. The `typeof` branch below is the
 * belt: a client without the method runs inline, which is correct because it
 * can only be one that is already inside a transaction.
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

/**
 * Set the transaction-local scope the redemption path runs under.
 *
 * Both GUCs are set explicitly on every call, including to the empty string, so
 * a scope is always REPLACED rather than layered. Leaving the invitation scope
 * set while the workspace scope is active would be harmless today — the token
 * policy is inert once a workspace context exists — but a policy added later
 * would inherit a widening nobody meant to grant.
 */
async function setRedemptionScope(
  db: PrismaClient,
  scope: { invitationTokenHash?: string; workspaceId?: string },
): Promise<void> {
  const tokenHash = scope.invitationTokenHash ?? '';
  const workspaceId = scope.workspaceId ?? '';
  await db.$executeRaw`SELECT set_config('app.invitation_token_hash', ${tokenHash}, true)`;
  await db.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
}

/**
 * Open the transaction the redemption path needs, and refuse to run inside
 * somebody else's tenant context.
 *
 * `peek` and `accept` MANAGE THEIR OWN CONTEXT: no scope, then the
 * invitation-token scope, then the workspace. Because a GUC set with
 * `set_config(..., true)` is transaction-local, that only works if this owns
 * the scope for the whole transaction.
 *
 * THE CHECK IS ON THE ACTUAL CONTEXT, not on the shape of the client. Prisma's
 * interactive-transaction client still exposes `$transaction`, and calling it
 * REUSES the enclosing transaction rather than opening a nested one — so a
 * type-sniffing guard would never fire, and redemption would silently overwrite
 * the caller's `app.workspace_id` for the rest of their transaction. Reading
 * the setting answers the question that actually matters.
 */
async function inRedemptionTransaction<T>(
  prisma: PrismaClient,
  fn: (db: PrismaClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { scope: string | null }[]
    >`SELECT NULLIF(current_setting('app.workspace_id', true), '') AS scope`;
    if (rows[0]?.scope) {
      throw new AppError(
        'INTERNAL',
        'Invitation redemption manages its own transaction scope and must not be ' +
          'called inside an existing tenant context.',
      );
    }
    return fn(tx as unknown as PrismaClient);
  });
}

/** One uniform failure for every unusable token. */
const INVITATION_FAILURE = 'This invitation link is not valid.';

export const INVITATION_TTL_DAYS = 7;

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 256 bits, URL-safe. Unguessable, per docs/SECURITY.md §2.3. */
function mintInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Who is issuing the invitation. Exactly one of the two, never both.
 *
 * EACH CARRIES ITS OWN PERMISSIONS, and the service checks them. The page guard
 * and the server-action guard already check — but a server action is a public
 * HTTP endpoint and a service is directly callable, so "the caller checked" is
 * not a control. This is the R-02 lesson: in Phase 2A every secret and
 * configuration method trusted that an actor existed, and calling the service
 * directly bypassed RBAC entirely.
 */
export type Inviter =
  | {
      readonly kind: 'member';
      readonly userId: string;
      readonly permissionKeys: readonly string[];
    }
  | {
      readonly kind: 'platform';
      readonly platformUserId: string;
      readonly permissionKeys: readonly string[];
      readonly mfaVerified: boolean;
    };

/** The permission each kind of inviter must hold. */
export const MEMBER_INVITE_PERMISSION = 'member.invite';
export const PLATFORM_INVITE_PERMISSION = 'platform.workspace.invite';

/**
 * Refuse an inviter that lacks the authority, naming what is missing.
 *
 * A platform inviter additionally needs verified MFA (D-27), because inviting
 * somebody into a customer workspace is a cross-tenant write.
 */
function assertMayInvite(inviter: Inviter, operation: string): void {
  if (inviter.kind === 'member') {
    if (!inviter.permissionKeys?.includes(MEMBER_INVITE_PERMISSION)) {
      throw new AppError('FORBIDDEN', `${operation} requires ${MEMBER_INVITE_PERMISSION}.`);
    }
    return;
  }
  if (!inviter.platformUserId) {
    throw new AppError('FORBIDDEN', `${operation} requires a platform actor.`);
  }
  if (!inviter.mfaVerified) {
    throw new AppError('FORBIDDEN', `${operation} requires verified MFA (D-27).`);
  }
  if (!inviter.permissionKeys?.includes(PLATFORM_INVITE_PERMISSION)) {
    throw new AppError('FORBIDDEN', `${operation} requires ${PLATFORM_INVITE_PERMISSION}.`);
  }
}

export interface CreateInvitationInput {
  readonly workspaceId: string;
  readonly email: string;
  readonly roleId: string;
  readonly brandScope?: readonly string[];
  readonly inviter: Inviter;
}

export interface IssuedInvitation {
  readonly invitationId: string;
  /** The raw token. Put it in the link, then forget it — it is not recoverable. */
  readonly token: string;
  readonly email: string;
  readonly expiresAt: Date;
}

export interface InvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly roleKey: string;
  readonly status: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  /**
   * The inviting MEMBER's address, or null.
   *
   * Never a platform operator's address. `platform_user` is platform-owned
   * (D-33) and the tenant role has no privilege on it at all — joining it here
   * made the whole team page fail with `permission denied` the moment a
   * platform-issued invitation existed. It is also the wrong thing to show: a
   * customer learns that support acted from their own Activity Log, not by
   * being handed a named operator's email address.
   */
  readonly invitedBy: string | null;
  /** True when a platform operator issued it. The UI names the platform, not a person. */
  readonly invitedByPlatform: boolean;
}

export interface AcceptedInvitation {
  readonly workspaceId: string;
  readonly membershipId: string;
  readonly roleKey: string;
}

/**
 * Acceptance by somebody who did not have an account a moment ago — A-2.
 *
 * Carries the user id so the caller can start a session: the whole point is
 * that the invitee arrives with no identity and leaves signed in, without an
 * administrator having pre-created anything.
 */
export interface OnboardedInvitation extends AcceptedInvitation {
  readonly userId: string;
}

export interface InvitationServiceOptions {
  readonly prisma: PrismaClient;
  readonly clock?: Clock;
}

export class InvitationService {
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;

  constructor(options: InvitationServiceOptions) {
    this.#prisma = options.prisma;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Issue an invitation.
   *
   * The role must be a WORKSPACE-realm role. A platform-realm role id here
   * would mint a customer membership carrying platform permissions, so it is
   * rejected rather than trusted (privilege-escalation guard).
   */
  async create(input: CreateInvitationInput): Promise<IssuedInvitation> {
    assertMayInvite(input.inviter, 'Inviting a member');

    const email = input.email.trim().toLowerCase();
    if (!email.includes('@') || email.length < 3) {
      throw new AppError('VALIDATION_FAILED', 'A valid email address is required.');
    }

    const role = await this.#prisma.role.findUnique({ where: { id: input.roleId } });
    if (!role || role.realm !== 'WORKSPACE') {
      throw new AppError('VALIDATION_FAILED', 'Unknown workspace role.');
    }
    // A workspace-scoped custom role may only be used by its own workspace.
    if (role.workspaceId !== null && role.workspaceId !== input.workspaceId) {
      throw new AppError('VALIDATION_FAILED', 'Unknown workspace role.');
    }

    // Already a member? Re-inviting would create a second membership path.
    const existingMember = await this.#prisma.membership.findFirst({
      where: { workspaceId: input.workspaceId, status: { not: 'REMOVED' }, user: { email } },
      select: { id: true },
    });
    if (existingMember) {
      throw new AppError('CONFLICT', 'That person is already a member of this workspace.');
    }

    const token = mintInvitationToken();
    const expiresAt = new Date(
      this.#clock.now().getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    try {
      const invitation = await this.#prisma.invitation.create({
        data: {
          workspaceId: input.workspaceId,
          email,
          roleId: input.roleId,
          brandScope: [...(input.brandScope ?? [])],
          tokenHash: hashInvitationToken(token),
          expiresAt,
          invitedByUserId: input.inviter.kind === 'member' ? input.inviter.userId : null,
          invitedByPlatformUserId:
            input.inviter.kind === 'platform' ? input.inviter.platformUserId : null,
        },
      });
      return { invitationId: invitation.id, token, email, expiresAt };
    } catch (error: unknown) {
      // The partial unique index refuses a second PENDING invitation for the
      // same address. Surfacing it as a conflict beats a 500.
      if (isUniqueViolation(error)) {
        throw new AppError('CONFLICT', 'An invitation is already pending for that address.');
      }
      throw error;
    }
  }

  /**
   * Resend: supersede the old invitation and issue a NEW token.
   *
   * The previous token stops working immediately. Reusing it would mean a link
   * from an old email — possibly in a forwarded thread — stays live for as long
   * as anyone keeps resending.
   */
  async resend(
    workspaceId: string,
    invitationId: string,
    inviter: Inviter,
  ): Promise<IssuedInvitation> {
    assertMayInvite(inviter, 'Resending an invitation');

    const existing = await this.#prisma.invitation.findFirst({
      where: { id: invitationId, workspaceId },
    });
    if (!existing) throw new AppError('NOT_FOUND', 'Invitation not found.');
    if (existing.status !== 'PENDING') {
      throw new AppError('CONFLICT', 'Only a pending invitation can be resent.');
    }

    return runAtomically(this.#prisma, async (tx) => {
      // Supersede first, so the partial unique index has room for the new row.
      const superseded = await tx.invitation.updateMany({
        where: { id: invitationId, status: 'PENDING' },
        data: { status: 'SUPERSEDED' },
      });
      if (superseded.count !== 1) {
        throw new AppError('CONFLICT', 'Only a pending invitation can be resent.');
      }

      const token = mintInvitationToken();
      const expiresAt = new Date(
        this.#clock.now().getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
      );
      const replacement = await tx.invitation.create({
        data: {
          workspaceId,
          email: existing.email,
          roleId: existing.roleId,
          brandScope: existing.brandScope,
          tokenHash: hashInvitationToken(token),
          expiresAt,
          invitedByUserId: inviter.kind === 'member' ? inviter.userId : null,
          invitedByPlatformUserId: inviter.kind === 'platform' ? inviter.platformUserId : null,
        },
      });
      await tx.invitation.update({
        where: { id: invitationId },
        data: { supersededByInvitationId: replacement.id },
      });

      return {
        invitationId: replacement.id,
        token,
        email: existing.email,
        expiresAt,
      };
    });
  }

  /** Revoke a pending invitation. Terminal — the trigger refuses a revival. */
  async revoke(
    workspaceId: string,
    invitationId: string,
    reason: string,
    revoker: Inviter,
  ): Promise<void> {
    assertMayInvite(revoker, 'Revoking an invitation');

    const revoked = await this.#prisma.invitation.updateMany({
      where: { id: invitationId, workspaceId, status: 'PENDING' },
      data: { status: 'REVOKED', revokedAt: this.#clock.now(), revokedReason: reason },
    });
    if (revoked.count !== 1) {
      throw new AppError('NOT_FOUND', 'Invitation not found.');
    }
  }

  async list(workspaceId: string): Promise<InvitationSummary[]> {
    const rows = await this.#prisma.invitation.findMany({
      where: { workspaceId },
      // NO `invitedByPlatform` join: see InvitationSummary.invitedBy.
      include: { role: true, invitedByUser: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      roleKey: r.role.key,
      // Expiry is enforced on read as well as by the sweep, so a stale PENDING
      // row is displayed honestly as expired.
      status: r.status === 'PENDING' && r.expiresAt <= this.#clock.now() ? 'EXPIRED' : r.status,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      invitedBy: r.invitedByUser?.email ?? null,
      invitedByPlatform: r.invitedByPlatformUserId !== null,
    }));
  }

  /**
   * Inspect a token WITHOUT consuming it, for the acceptance page.
   *
   * Returns only what the holder of a valid token may see: the workspace name
   * and the role they are being offered. It never reveals whether an account
   * already exists for the address.
   */
  async peek(token: string): Promise<{
    readonly workspaceName: string;
    readonly email: string;
    readonly roleNameEn: string;
    readonly roleNameAr: string;
  }> {
    const tokenHash = hashInvitationToken(token);

    const invitation = await inRedemptionTransaction(this.#prisma, async (tx) => {
      // The token scope exposes exactly the row this token addresses, and only
      // while it is still pending. Everything else is read in the workspace it
      // names, under the ordinary tenant policies.
      await setRedemptionScope(tx, { invitationTokenHash: tokenHash });
      const row = await tx.invitation.findUnique({ where: { tokenHash } });
      if (!row) return null;

      await setRedemptionScope(tx, { workspaceId: row.workspaceId });
      const workspace = await tx.workspace.findUnique({ where: { id: row.workspaceId } });
      const role = await tx.role.findUnique({ where: { id: row.roleId } });
      if (!workspace || !role) return null;
      return { ...row, workspace, role };
    });

    if (!invitation || !this.#isUsable(invitation.status, invitation.expiresAt)) {
      throw new AppError('NOT_FOUND', INVITATION_FAILURE);
    }
    // An invitation into a workspace that is no longer operable is not usable.
    if (!['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(invitation.workspace.status)) {
      throw new AppError('NOT_FOUND', INVITATION_FAILURE);
    }
    return {
      workspaceName: invitation.workspace.name,
      email: invitation.email,
      roleNameEn: invitation.role.nameEn,
      roleNameAr: invitation.role.nameAr,
    };
  }

  /**
   * Accept an invitation, atomically, as `acceptingUserId`.
   *
   * The caller must already be authenticated: acceptance binds the invitation
   * to a proven identity rather than to whoever opened the link. The
   * authenticated email must match the invited address exactly (both are
   * lower-cased), so a forwarded link cannot be used by the recipient.
   */
  async accept(token: string, acceptingUserId: string): Promise<AcceptedInvitation> {
    const tokenHash = hashInvitationToken(token);
    const now = this.#clock.now();

    return inRedemptionTransaction(this.#prisma, async (tx) => {
      // THREE SCOPES, IN ORDER, and the order is the point.
      //
      //   1. NONE. The accepting user is not a member of anything yet, so the
      //      identity read must happen before any workspace context — inside
      //      one, the `user` policy shows only that workspace's members.
      //   2. THE INVITATION TOKEN. Exposes one pending row and nothing else.
      //   3. THE WORKSPACE. Every write below is an ordinary tenant write,
      //      governed by the ordinary tenant policies. Acceptance does NOT
      //      happen under the widened scope.
      await setRedemptionScope(tx, {});
      const user = await tx.user.findUnique({ where: { id: acceptingUserId } });
      if (!user) throw new AppError('NOT_FOUND', INVITATION_FAILURE);

      await setRedemptionScope(tx, { invitationTokenHash: tokenHash });
      const found = await tx.invitation.findUnique({ where: { tokenHash } });
      if (!found) throw new AppError('NOT_FOUND', INVITATION_FAILURE);

      // Same message for a wrong recipient as for a wrong token: an attacker
      // holding a forwarded link learns nothing about who it was for. Checked
      // BEFORE the workspace scope is taken, so a wrong recipient never causes
      // a read inside a workspace they have no relationship with.
      if (found.email !== user.email.trim().toLowerCase()) {
        throw new AppError('NOT_FOUND', INVITATION_FAILURE);
      }

      return this.#acceptFor(tx, { found, tokenHash, now, userId: acceptingUserId });
    });
  }

  /**
   * The acceptance itself, shared by both entry points.
   *
   * ONE implementation on purpose. `accept` and `acceptAsNewUser` differ only
   * in how the identity is established; the single-use consumption, the
   * workspace-status check, the membership and the audit event must be
   * identical, and a second copy of them is a second place for the atomicity to
   * drift. The caller has already read the invitation under the token scope and
   * established who is accepting.
   */
  async #acceptFor(
    tx: PrismaClient,
    ctx: {
      readonly found: { id: string; workspaceId: string; roleId: string; brandScope: unknown };
      readonly tokenHash: string;
      readonly now: Date;
      readonly userId: string;
    },
  ): Promise<AcceptedInvitation> {
    const { found, tokenHash, now, userId } = ctx;

    await setRedemptionScope(tx, { workspaceId: found.workspaceId });
    const workspace = await tx.workspace.findUnique({ where: { id: found.workspaceId } });
    const role = await tx.role.findUnique({ where: { id: found.roleId } });
    if (!workspace || !role) throw new AppError('NOT_FOUND', INVITATION_FAILURE);

    if (!['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(workspace.status)) {
      throw new AppError('NOT_FOUND', INVITATION_FAILURE);
    }

    // THE atomic step. Exactly one row may move PENDING -> ACCEPTED, so of
    // two concurrent acceptances one gets count 0 and fails.
    const consumed = await tx.invitation.updateMany({
      where: { tokenHash, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'ACCEPTED', acceptedAt: now, acceptedByUserId: userId },
    });
    if (consumed.count !== 1) {
      throw new AppError('NOT_FOUND', INVITATION_FAILURE);
    }

    const membership = await tx.membership.upsert({
      where: { workspaceId_userId: { workspaceId: found.workspaceId, userId } },
      create: {
        workspaceId: found.workspaceId,
        userId,
        roleId: found.roleId,
        brandScope: found.brandScope as never,
        status: 'ACTIVE',
        acceptedAt: now,
      },
      update: {
        roleId: found.roleId,
        brandScope: found.brandScope as never,
        status: 'ACTIVE',
        acceptedAt: now,
      },
    });

    await tx.auditEvent.create({
      data: {
        workspaceId: found.workspaceId,
        actorType: 'USER',
        actorId: userId,
        action: 'workspace.invitation.accepted',
        resourceType: 'invitation',
        resourceId: found.id,
        severity: 'NOTICE',
        outcome: 'SUCCESS',
        after: { roleKey: role.key },
      },
    });

    return {
      workspaceId: found.workspaceId,
      membershipId: membership.id,
      roleKey: role.key,
    };
  }

  /**
   * Accept an invitation as somebody who has no account yet — A-2.
   *
   * THE GAP THIS CLOSES. `accept` requires an already-authenticated identity,
   * and there is no sign-up route: a customer application is entered by
   * invitation, not by self-registration. So a genuinely new invitee reached
   * the acceptance page, was told to sign in, and had nothing to sign in with.
   * The journey only worked if an administrator had already created the `User`
   * row by hand — which is not a product, it is a workaround that the
   * end-to-end suite had encoded by pre-seeding the invitee.
   *
   * WHY THE TOKEN IS PROOF OF THE ADDRESS. The invitation was delivered to the
   * invited address and its raw value exists nowhere else — the database holds
   * only a SHA-256 hash. Presenting it therefore demonstrates control of that
   * mailbox, which is the same evidence a verification email provides. The
   * identity created here is marked verified for exactly that reason, and for
   * no weaker one: the address is never taken from user input, only ever from
   * the invitation row.
   *
   * WHAT IS PRESERVED, DELIBERATELY:
   *
   *   - THE UNIFORM FAILURE. Every refusal — bad token, expired, revoked,
   *     already accepted, workspace suspended, or an address that already has
   *     a usable account — is the same message. In particular the last one:
   *     branching on "you already have an account" would turn a stolen link
   *     into an account-existence oracle for the invited address.
   *   - THE ATOMIC SINGLE-USE ACCEPTANCE. The same one-row conditional UPDATE,
   *     in the same transaction as the identity it creates. Two concurrent
   *     onboardings of one link produce one member and one account.
   *   - THE SCOPE DISCIPLINE. Identity work happens with NO workspace scope
   *     (the `user` policy permits an insert only there); the membership and
   *     audit writes happen under the workspace scope, as ordinary tenant
   *     writes. Acceptance never runs under the widened token scope.
   */
  async acceptAsNewUser(token: string, password: string): Promise<OnboardedInvitation> {
    const tokenHash = hashInvitationToken(token);
    const now = this.#clock.now();

    /*
     * Hashed BEFORE the transaction, for the reason the password-reset path
     * documents: Argon2id is deliberately slow, and a rejected password must
     * not have cost a row lock — or, worse, consumed the invitation.
     */
    const passwordHash = await hashPassword(password);

    return inRedemptionTransaction(this.#prisma, async (tx) => {
      await setRedemptionScope(tx, { invitationTokenHash: tokenHash });
      const found = await tx.invitation.findUnique({ where: { tokenHash } });
      if (!found) throw new AppError('NOT_FOUND', INVITATION_FAILURE);

      // No workspace scope: the `user` policy allows a read of a global
      // identity, and an INSERT, only when no workspace context is set.
      await setRedemptionScope(tx, {});
      const email = found.email.trim().toLowerCase();
      const existing = await tx.user.findUnique({ where: { email } });

      /*
       * AN ACCOUNT THAT CAN ALREADY SIGN IN IS NOT ONBOARDED HERE. Setting a
       * password on it would be an account takeover by anyone holding a
       * forwarded link. Refused with the ordinary failure message so the
       * refusal itself reveals nothing; the page offers signing in alongside
       * this form, which is the route such a person should take.
       */
      if (existing && existing.passwordHash !== null) {
        throw new AppError('NOT_FOUND', INVITATION_FAILURE);
      }
      if (existing && (existing.status === 'DELETED' || existing.deletedAt !== null)) {
        throw new AppError('NOT_FOUND', INVITATION_FAILURE);
      }

      const user = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: {
              passwordHash,
              status: 'ACTIVE',
              emailVerifiedAt: existing.emailVerifiedAt ?? now,
              failedLoginCount: 0,
              lockedUntil: null,
            },
          })
        : await tx.user.create({
            data: {
              // From the INVITATION, never from user input.
              email,
              passwordHash,
              status: 'ACTIVE',
              emailVerifiedAt: now,
            },
          });

      const accepted = await this.#acceptFor(tx, { found, tokenHash, now, userId: user.id });
      return { ...accepted, userId: user.id };
    });
  }

  /** Mark expired invitations. Idempotent; safe to run repeatedly. */
  async expireStale(): Promise<number> {
    const result = await this.#prisma.invitation.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: this.#clock.now() } },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  }

  #isUsable(status: string, expiresAt: Date): boolean {
    return status === 'PENDING' && expiresAt > this.#clock.now();
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
