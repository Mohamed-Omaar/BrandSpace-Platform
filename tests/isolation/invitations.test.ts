import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InvitationService,
  MembershipService,
  OutboxEmailProvider,
  hashInvitationToken,
} from '@brandspace/auth';
import { withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Invitations and memberships.
 *
 * The properties an invitation system must hold, each asserted rather than
 * asserted-about:
 *
 *   - the token is unguessable and never stored in the clear;
 *   - it is single-use, and CONCURRENT acceptances do not both win;
 *   - expiry, revocation and supersession are terminal;
 *   - a link forwarded to the wrong person is useless and reveals nothing;
 *   - a workspace always keeps an owner;
 *   - nobody can grant a role above what their own role may assign.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
let invitations: InvitationService;
/**
 * THE SAME SERVICE, ON THE TENANT ROLE — the identity the customer application
 * actually connects as, with no workspace context and no cross-tenant policy
 * behind it.
 *
 * Every redemption test above this line ran on the PLATFORM client, and that
 * gap was not academic: `peek()` and `accept()` were governed by a policy the
 * customer application never satisfies, so in the product every invitation link
 * was dead while the suite stayed green. Redemption is now asserted on the role
 * that performs it.
 */
let tenantInvitations: InvitationService;
let memberships: MembershipService;

/** Role ids, resolved once. */
let ownerRoleId: string;
let adminRoleId: string;
let analystRoleId: string;

beforeAll(async () => {
  app = appRoleClient();
  platform = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
  });
  fixtures = await createIsolationFixtures(app);
  invitations = new InvitationService({ prisma: platform });
  tenantInvitations = new InvitationService({ prisma: app });
  memberships = new MembershipService({ prisma: platform });

  ownerRoleId = (
    await platform.role.findFirstOrThrow({ where: { key: 'workspace_owner', workspaceId: null } })
  ).id;
  adminRoleId = (
    await platform.role.findFirstOrThrow({ where: { key: 'workspace_admin', workspaceId: null } })
  ).id;
  analystRoleId = (
    await platform.role.findFirstOrThrow({ where: { key: 'analyst', workspaceId: null } })
  ).id;
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

/**
 * A fully-authorised platform inviter.
 *
 * The service now checks the inviter's OWN permissions, so the tests must carry
 * them: a bare `{ kind, platformUserId }` is refused, which is the point.
 */
function platformInviter(
  overrides: Partial<{ permissionKeys: readonly string[]; mfaVerified: boolean }> = {},
) {
  return {
    kind: 'platform' as const,
    platformUserId: fixtures.platformUserId,
    permissionKeys: ['platform.workspace.invite'],
    mfaVerified: true,
    ...overrides,
  };
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.local`;
}

async function issueTo(email: string, roleId = analystRoleId) {
  return invitations.create({
    workspaceId: fixtures.a.workspaceId,
    email,
    roleId,
    inviter: platformInviter(),
  });
}

describe('the token never exists in the database', () => {
  it('stores only its SHA-256 hash', async () => {
    const email = uniqueEmail('hash');
    const issued = await issueTo(email);

    const row = await platform.invitation.findUniqueOrThrow({
      where: { id: issued.invitationId },
    });
    expect(row.tokenHash).not.toBe(issued.token);
    expect(row.tokenHash).toBe(hashInvitationToken(issued.token));
    expect(JSON.stringify(row)).not.toContain(issued.token);
  });

  it('is high-entropy and unguessable', async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const issued = await issueTo(uniqueEmail(`entropy${i}`));
      tokens.add(issued.token);
      // 32 random bytes, base64url: 43 characters.
      expect(issued.token.length).toBeGreaterThanOrEqual(43);
    }
    expect(tokens.size).toBe(5);
  });

  it('the outbox stores no link and no token', async () => {
    const email = uniqueEmail('outbox');
    const issued = await issueTo(email);
    const provider = new OutboxEmailProvider(platform);
    await provider.send({
      to: email,
      templateKey: 'workspace.invitation',
      locale: 'EN',
      workspaceId: fixtures.a.workspaceId,
      variables: { expiresAt: issued.expiresAt.toISOString() },
      link: `/en/invitations/${issued.token}`,
    });

    const rows = await platform.emailMessage.findMany({ where: { toEmail: email } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(issued.token);
    expect(JSON.stringify(rows[0])).not.toContain('/invitations/');
  });
});

describe('the outbox is written under the right context, or not at all', () => {
  const outbox = (db: unknown) => new OutboxEmailProvider(db as never);

  it('a workspace-scoped message is written INSIDE that workspace', async () => {
    const to = uniqueEmail('outbox-scoped');
    const id = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        (
          await outbox(db).send({
            to,
            templateKey: 'workspace.invitation',
            locale: 'EN',
            workspaceId: fixtures.a.workspaceId,
            link: '/en/invitations/never-stored',
          })
        ).messageId,
      { prisma: app },
    );

    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.emailMessage.findMany({ where: { id } }),
      { prisma: app },
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('/invitations/');
  });

  it('a workspace-scoped message with NO context is REFUSED, not silently dropped', async () => {
    // REGRESSION. The invitation mail used to be sent on the unscoped client,
    // after `inWorkspace` had already returned. `WITH CHECK` refused the row,
    // so an invitation was created and its mail was never queued.
    await expect(
      outbox(app).send({
        to: uniqueEmail('outbox-unscoped'),
        templateKey: 'workspace.invitation',
        locale: 'EN',
        workspaceId: fixtures.a.workspaceId,
      }),
    ).rejects.toThrow();
  });

  it('a workspace-LESS message writes with no context, and no tenant can read it', async () => {
    // The password-reset path: it must answer identically whether or not an
    // account exists, so it cannot resolve a workspace without becoming an
    // existence oracle.
    const to = uniqueEmail('outbox-reset');
    const { messageId } = await outbox(app).send({
      to,
      templateKey: 'auth.password_reset',
      locale: 'EN',
      link: '/en/reset/never-stored',
    });

    const row = await platform.emailMessage.findUniqueOrThrow({ where: { id: messageId } });
    expect(row.workspaceId).toBeNull();

    // Write-only widening: neither tenant can read it back.
    for (const workspaceId of [fixtures.a.workspaceId, fixtures.b.workspaceId]) {
      const visible = await withWorkspace(
        workspaceId,
        async (db) => db.emailMessage.findMany({ where: { id: messageId } }),
        { prisma: app },
      );
      expect(visible).toHaveLength(0);
    }
  });

  it('a workspace-LESS message is refused INSIDE a workspace', async () => {
    // So a tenant cannot detach a message from their workspace to keep it out
    // of their own record.
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          outbox(db).send({
            to: uniqueEmail('outbox-detach'),
            templateKey: 'auth.password_reset',
            locale: 'EN',
          }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });

  it("one tenant cannot write into another tenant's outbox", async () => {
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          outbox(db).send({
            to: uniqueEmail('outbox-cross'),
            templateKey: 'workspace.invitation',
            locale: 'EN',
            workspaceId: fixtures.b.workspaceId,
          }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });
});

describe('an invitation can be accepted exactly once', () => {
  it('refuses a second acceptance', async () => {
    const email = uniqueEmail('once');
    const issued = await issueTo(email);
    const user = await platform.user.create({
      data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });

    const accepted = await invitations.accept(issued.token, user.id);
    expect(accepted.workspaceId).toBe(fixtures.a.workspaceId);

    await expect(invitations.accept(issued.token, user.id)).rejects.toThrow(
      'This invitation link is not valid.',
    );
  });

  it('CONCURRENT acceptances produce exactly one membership', async () => {
    const email = uniqueEmail('race');
    const issued = await issueTo(email);
    const user = await platform.user.create({
      data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });

    const results = await Promise.allSettled([
      invitations.accept(issued.token, user.id),
      invitations.accept(issued.token, user.id),
      invitations.accept(issued.token, user.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    // Read-then-write would let more than one through — the R-03 shape.
    expect(fulfilled).toHaveLength(1);

    const rows = await platform.membership.findMany({
      where: { workspaceId: fixtures.a.workspaceId, userId: user.id },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('redemption works on the TENANT role, which is the one that performs it', () => {
  const FAILURE = 'This invitation link is not valid.';

  it('peeks a valid token with no workspace context', async () => {
    const email = uniqueEmail('tenant-peek');
    const issued = await issueTo(email);

    // No context is set, and none can be: the holder is not a member yet.
    const peeked = await tenantInvitations.peek(issued.token);
    expect(peeked.email).toBe(email);
    expect(peeked.workspaceName).toBeTruthy();
    expect(peeked.roleNameEn).toBeTruthy();
    expect(peeked.roleNameAr).toBeTruthy();
  });

  it('accepts on the tenant role and creates the membership', async () => {
    const email = uniqueEmail('tenant-accept');
    const issued = await issueTo(email);
    const user = await platform.user.create({
      data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });

    const accepted = await tenantInvitations.accept(issued.token, user.id);
    expect(accepted.workspaceId).toBe(fixtures.a.workspaceId);

    const rows = await platform.membership.findMany({
      where: { workspaceId: fixtures.a.workspaceId, userId: user.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ACTIVE');

    // The write happened inside the workspace context, so the workspace's own
    // Activity Log records it — not a context-less orphan event.
    const events = await platform.auditEvent.findMany({
      where: {
        workspaceId: fixtures.a.workspaceId,
        action: 'workspace.invitation.accepted',
        resourceId: issued.invitationId,
      },
    });
    expect(events).toHaveLength(1);
  });

  it('the token scope exposes ONE row and nothing else', async () => {
    // Two live invitations, in two different workspaces.
    const emailA = uniqueEmail('scope-a');
    const issuedA = await issueTo(emailA);
    const emailB = uniqueEmail('scope-b');
    const issuedB = await invitations.create({
      workspaceId: fixtures.b.workspaceId,
      email: emailB,
      roleId: analystRoleId,
      inviter: platformInviter(),
    });

    // Holding A's token, the tenant role sees exactly one invitation row.
    const visible = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', '', true)`;
      await tx.$executeRaw`SELECT set_config('app.invitation_token_hash', ${hashInvitationToken(
        issuedA.token,
      )}, true)`;
      return tx.invitation.findMany();
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe(issuedA.invitationId);
    expect(visible.map((r) => r.id)).not.toContain(issuedB.invitationId);
  });

  it('a token with NO scope set reads nothing at all', async () => {
    const issued = await issueTo(uniqueEmail('no-scope'));
    const visible = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', '', true)`;
      await tx.$executeRaw`SELECT set_config('app.invitation_token_hash', '', true)`;
      return tx.invitation.findMany();
    });
    expect(visible).toHaveLength(0);
    expect(visible.map((r) => r.id)).not.toContain(issued.invitationId);
  });

  it('a SPENT token reads nothing, so it cannot confirm the invitation existed', async () => {
    const email = uniqueEmail('tenant-spent');
    const issued = await issueTo(email);
    const user = await platform.user.create({
      data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await tenantInvitations.accept(issued.token, user.id);

    // The row is now ACCEPTED, and the policy only exposes PENDING rows.
    const visible = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', '', true)`;
      await tx.$executeRaw`SELECT set_config('app.invitation_token_hash', ${hashInvitationToken(
        issued.token,
      )}, true)`;
      return tx.invitation.findMany();
    });
    expect(visible).toHaveLength(0);
    await expect(tenantInvitations.peek(issued.token)).rejects.toThrow(FAILURE);
  });

  it('the WRONG recipient is refused on the tenant role too, with the same wording', async () => {
    const issued = await issueTo(uniqueEmail('tenant-wrong'));
    const someoneElse = await platform.user.create({
      data: { email: uniqueEmail('tenant-other'), status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await expect(tenantInvitations.accept(issued.token, someoneElse.id)).rejects.toThrow(FAILURE);
  });

  it('CONCURRENT tenant acceptances still produce exactly one membership', async () => {
    const email = uniqueEmail('tenant-race');
    const issued = await issueTo(email);
    const user = await platform.user.create({
      data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });

    const results = await Promise.allSettled([
      tenantInvitations.accept(issued.token, user.id),
      tenantInvitations.accept(issued.token, user.id),
      tenantInvitations.accept(issued.token, user.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await platform.membership.findMany({
      where: { workspaceId: fixtures.a.workspaceId, userId: user.id },
    });
    expect(rows).toHaveLength(1);
  });

  it('lists a PLATFORM-issued invitation without reading platform_user', async () => {
    // REGRESSION. `list()` used to join `invitedByPlatform`, which is
    // `platform_user` — a table the tenant role has no privilege on at all
    // (D-33). One platform-issued invitation therefore made the entire team
    // page fail with `permission denied for table platform_user`.
    const email = uniqueEmail('platform-issued');
    const issued = await issueTo(email); // issued by the platform inviter

    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new InvitationService({ prisma: db as unknown as PrismaClient }).list(
          fixtures.a.workspaceId,
        ),
      { prisma: app },
    );

    const row = rows.find((r) => r.id === issued.invitationId);
    expect(row).toBeDefined();
    // The platform operator is named as the PLATFORM, never as a person.
    expect(row?.invitedByPlatform).toBe(true);
    expect(row?.invitedBy).toBeNull();
    // And no operator address leaked into the payload by any other route.
    expect(JSON.stringify(rows)).not.toContain('@brandspace.local');
  });

  it('the token scope is INERT inside a workspace, so it cannot cross a tenant', async () => {
    // THE ATTACK. A signed-in member of A holds a link addressed to somebody in
    // B — forwarded, guessed, whatever — and sets the token scope while their
    // own workspace context is bound, hoping the two widenings compose.
    //
    // They do not. `invitation_by_token` requires `current_workspace_id() IS
    // NULL`, so inside a workspace it contributes nothing and only A's own
    // invitations remain visible.
    const issuedInB = await invitations.create({
      workspaceId: fixtures.b.workspaceId,
      email: uniqueEmail('cross-tenant'),
      roleId: analystRoleId,
      inviter: platformInviter(),
    });

    const visible = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${fixtures.a.workspaceId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.invitation_token_hash', ${hashInvitationToken(
        issuedInB.token,
      )}, true)`;
      return tx.invitation.findMany();
    });

    expect(visible.map((r) => r.id)).not.toContain(issuedInB.invitationId);
    for (const row of visible) {
      expect(row.workspaceId).toBe(fixtures.a.workspaceId);
    }
  });

  it('refuses to run inside an existing tenant context rather than overwriting it', async () => {
    const issued = await issueTo(uniqueEmail('tenant-nested'));
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          new InvitationService({ prisma: db as unknown as PrismaClient }).peek(issued.token),
        { prisma: app },
      ),
    ).rejects.toThrow(/its own transaction/i);
  });
});

describe('unusable invitations all fail the same way', () => {
  const FAILURE = 'This invitation link is not valid.';

  it('an expired invitation', async () => {
    const email = uniqueEmail('expired');
    const issued = await issueTo(email);
    const user = await platform.user.create({
      data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await platform.invitation.update({
      where: { id: issued.invitationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(invitations.accept(issued.token, user.id)).rejects.toThrow(FAILURE);
    await expect(invitations.peek(issued.token)).rejects.toThrow(FAILURE);
  });

  it('a revoked invitation', async () => {
    const email = uniqueEmail('revoked');
    const issued = await issueTo(email);
    const user = await platform.user.create({
      data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await invitations.revoke(
      fixtures.a.workspaceId,
      issued.invitationId,
      'no longer needed',
      platformInviter(),
    );

    await expect(invitations.accept(issued.token, user.id)).rejects.toThrow(FAILURE);
  });

  it('a token that was never issued', async () => {
    const user = await platform.user.create({
      data: { email: uniqueEmail('nobody'), status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await expect(invitations.accept('not-a-real-token', user.id)).rejects.toThrow(FAILURE);
  });

  it('the WRONG recipient — same message, so a forwarded link reveals nothing', async () => {
    const invitedEmail = uniqueEmail('invited');
    const issued = await issueTo(invitedEmail);
    const someoneElse = await platform.user.create({
      data: { email: uniqueEmail('someone-else'), status: 'ACTIVE', emailVerifiedAt: new Date() },
    });

    await expect(invitations.accept(issued.token, someoneElse.id)).rejects.toThrow(FAILURE);

    // And the invitation is still PENDING: a wrong recipient does not burn it.
    const row = await platform.invitation.findUniqueOrThrow({
      where: { id: issued.invitationId },
    });
    expect(row.status).toBe('PENDING');
  });

  it('an invitation into a suspended workspace', async () => {
    const email = uniqueEmail('suspended-ws');
    const issued = await issueTo(email);
    const user = await platform.user.create({
      data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await platform.workspace.update({
      where: { id: fixtures.a.workspaceId },
      data: { status: 'SUSPENDED', statusReason: 'Suspended for this assertion' },
    });

    await expect(invitations.accept(issued.token, user.id)).rejects.toThrow(FAILURE);

    await platform.workspace.update({
      where: { id: fixtures.a.workspaceId },
      data: { status: 'ACTIVE', statusReason: 'Reinstated' },
    });
  });
});

describe('resend supersedes rather than reuses', () => {
  it('invalidates the previous token and issues a new one', async () => {
    const email = uniqueEmail('resend');
    const first = await issueTo(email);
    const user = await platform.user.create({
      data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });

    const second = await invitations.resend(
      fixtures.a.workspaceId,
      first.invitationId,
      platformInviter(),
    );

    expect(second.token).not.toBe(first.token);
    // The old link is dead the moment the new one exists — otherwise a
    // forwarded thread keeps a live token for as long as anyone resends.
    await expect(invitations.accept(first.token, user.id)).rejects.toThrow(
      'This invitation link is not valid.',
    );
    await expect(invitations.accept(second.token, user.id)).resolves.toMatchObject({
      workspaceId: fixtures.a.workspaceId,
    });
  });

  it('records the supersession chain', async () => {
    const email = uniqueEmail('chain');
    const first = await issueTo(email);
    const second = await invitations.resend(
      fixtures.a.workspaceId,
      first.invitationId,
      platformInviter(),
    );
    const old = await platform.invitation.findUniqueOrThrow({ where: { id: first.invitationId } });
    expect(old.status).toBe('SUPERSEDED');
    expect(old.supersededByInvitationId).toBe(second.invitationId);
  });

  it('refuses to resend an invitation that is not pending', async () => {
    const email = uniqueEmail('not-pending');
    const issued = await issueTo(email);
    await invitations.revoke(
      fixtures.a.workspaceId,
      issued.invitationId,
      'revoked first',
      platformInviter(),
    );
    await expect(
      invitations.resend(fixtures.a.workspaceId, issued.invitationId, platformInviter()),
    ).rejects.toThrow(/pending/i);
  });
});

describe('the invitation service authorises its own caller', () => {
  // Found by the Phase 2B adversarial review: `create`, `resend` and `revoke`
  // trusted that the page and the server action had checked. A server action is
  // a public HTTP endpoint and a service is directly callable, so that is not a
  // control — it is the R-02 shape exactly.

  it('refuses a member inviter without member.invite', async () => {
    await expect(
      invitations.create({
        workspaceId: fixtures.a.workspaceId,
        email: uniqueEmail('unauthorised-member'),
        roleId: analystRoleId,
        inviter: {
          kind: 'member',
          userId: fixtures.a.userId,
          permissionKeys: ['workspace.read', 'member.read'],
        },
      }),
    ).rejects.toThrow('member.invite');
  });

  it('refuses a platform inviter without platform.workspace.invite', async () => {
    await expect(
      invitations.create({
        workspaceId: fixtures.a.workspaceId,
        email: uniqueEmail('unauthorised-platform'),
        roleId: analystRoleId,
        inviter: platformInviter({ permissionKeys: ['platform.workspace.read'] }),
      }),
    ).rejects.toThrow('platform.workspace.invite');
  });

  it('refuses a platform inviter without verified MFA', async () => {
    await expect(
      invitations.create({
        workspaceId: fixtures.a.workspaceId,
        email: uniqueEmail('no-mfa'),
        roleId: analystRoleId,
        inviter: platformInviter({ mfaVerified: false }),
      }),
    ).rejects.toThrow(/verified MFA/);
  });

  it('refuses an unauthorised RESEND and an unauthorised REVOKE', async () => {
    const issued = await issueTo(uniqueEmail('guarded'));

    await expect(
      invitations.resend(fixtures.a.workspaceId, issued.invitationId, {
        kind: 'member',
        userId: fixtures.a.userId,
        permissionKeys: ['member.read'],
      }),
    ).rejects.toThrow('member.invite');

    await expect(
      invitations.revoke(fixtures.a.workspaceId, issued.invitationId, 'no authority', {
        kind: 'member',
        userId: fixtures.a.userId,
        permissionKeys: ['member.read'],
      }),
    ).rejects.toThrow('member.invite');

    // Still pending: a refused call changed nothing.
    const row = await platform.invitation.findUniqueOrThrow({
      where: { id: issued.invitationId },
    });
    expect(row.status).toBe('PENDING');
  });
});

describe('invitations cannot escalate privileges', () => {
  it('refuses a PLATFORM-realm role id', async () => {
    // Minting a customer membership that carries platform permissions would be
    // a complete tenancy break, so the realm is checked, not assumed.
    const platformRole = await platform.role.findFirstOrThrow({
      where: { key: 'platform_owner', workspaceId: null },
    });
    await expect(
      invitations.create({
        workspaceId: fixtures.a.workspaceId,
        email: uniqueEmail('escalate'),
        roleId: platformRole.id,
        inviter: platformInviter(),
      }),
    ).rejects.toThrow('Unknown workspace role.');
  });

  it("refuses another workspace's custom role", async () => {
    await expect(
      invitations.create({
        workspaceId: fixtures.a.workspaceId,
        email: uniqueEmail('foreign-role'),
        roleId: fixtures.b.customRoleId,
        inviter: platformInviter(),
      }),
    ).rejects.toThrow('Unknown workspace role.');
  });

  it('refuses to invite somebody who is already a member', async () => {
    await expect(
      invitations.create({
        workspaceId: fixtures.a.workspaceId,
        email: fixtures.a.userEmail,
        roleId: analystRoleId,
        inviter: platformInviter(),
      }),
    ).rejects.toThrow(/already a member/i);
  });

  it('refuses a second pending invitation for the same address', async () => {
    const email = uniqueEmail('duplicate');
    await issueTo(email);
    await expect(issueTo(email)).rejects.toThrow(/already pending/i);
  });
});

describe('membership rules', () => {
  const owner = (userId: string) => ({
    userId,
    roleKey: 'workspace_owner',
    permissionKeys: ['member.read', 'member.invite', 'member.remove', 'member.assign_role'],
  });
  const admin = (userId: string) => ({
    userId,
    roleKey: 'workspace_admin',
    permissionKeys: ['member.read', 'member.invite', 'member.remove', 'member.assign_role'],
  });

  it('refuses to remove the LAST active Workspace Owner', async () => {
    await expect(
      memberships.remove(
        fixtures.a.workspaceId,
        owner(fixtures.a.userId),
        fixtures.a.membershipId,
        'attempting to orphan the workspace',
      ),
    ).rejects.toThrow(/at least one active Workspace Owner/i);

    const still = await platform.membership.findUniqueOrThrow({
      where: { id: fixtures.a.membershipId },
    });
    expect(still.status).toBe('ACTIVE');
  });

  it('refuses to demote the LAST active Workspace Owner', async () => {
    await expect(
      memberships.changeRole(
        fixtures.a.workspaceId,
        owner(fixtures.a.userId),
        fixtures.a.membershipId,
        analystRoleId,
      ),
    ).rejects.toThrow(/at least one active Workspace Owner/i);

    const role = await platform.membership.findUniqueOrThrow({
      where: { id: fixtures.a.membershipId },
      include: { role: true },
    });
    expect(role.role.key).toBe('workspace_owner');
  });

  /*
   * A-5. THE OWNER INVARIANT UNDER CONCURRENCY.
   *
   * `#assertOwnerRemains` is a COUNT, and a count takes no locks. Two owners,
   * two concurrent demotions: each transaction demotes a DIFFERENT membership
   * row, so nothing conflicts, and under READ COMMITTED each still sees the
   * other owner as active. Both counted one, both passed, both committed — and
   * the workspace was left with none.
   *
   * Sequentially every one of these passes. That is the point: the sequential
   * tests above cannot see this, and neither could any amount of reading.
   */
  describe('two owners cannot be removed at once', () => {
    /** A workspace with `count` owners, returning their membership ids. */
    async function workspaceWithOwners(count: number): Promise<{
      workspaceId: string;
      ownerUserId: string;
      membershipIds: string[];
    }> {
      const suffix = randomUUID();
      const founder = await platform.user.create({
        data: { email: `founder-${suffix}@example.local`, status: 'ACTIVE' },
      });
      const workspace = await platform.workspace.create({
        data: {
          id: suffix,
          workspaceId: suffix,
          slug: `owners-${suffix.slice(0, 12)}`,
          name: 'Owner race',
          ownerUserId: founder.id,
          status: 'ACTIVE',
        },
      });

      const membershipIds: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const user =
          i === 0
            ? founder
            : await platform.user.create({
                data: { email: `co-owner-${i}-${suffix}@example.local`, status: 'ACTIVE' },
              });
        const membership = await platform.membership.create({
          data: {
            workspaceId: workspace.id,
            userId: user.id,
            roleId: ownerRoleId,
            status: 'ACTIVE',
            acceptedAt: new Date(),
            brandScope: [],
          },
        });
        membershipIds.push(membership.id);
      }
      return { workspaceId: workspace.id, ownerUserId: founder.id, membershipIds };
    }

    async function activeOwners(workspaceId: string): Promise<number> {
      return platform.membership.count({
        where: { workspaceId, status: 'ACTIVE', role: { key: 'workspace_owner' } },
      });
    }

    it('parallel DEMOTIONS of the two remaining owners leave one standing', async () => {
      const { workspaceId, ownerUserId, membershipIds } = await workspaceWithOwners(2);
      expect(await activeOwners(workspaceId)).toBe(2);

      const results = await Promise.allSettled(
        membershipIds.map((id) =>
          memberships.changeRole(workspaceId, owner(ownerUserId), id, analystRoleId),
        ),
      );

      // Exactly one succeeds. The other is refused by the invariant — a
      // CONFLICT, which is the correct answer, not a crash.
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      for (const rejection of results.filter((r) => r.status === 'rejected')) {
        expect(String((rejection as PromiseRejectedResult).reason)).toMatch(
          /at least one active Workspace Owner/i,
        );
      }

      expect(
        await activeOwners(workspaceId),
        'the workspace must never be left without an owner',
      ).toBe(1);
    });

    it('parallel REMOVALS of the two remaining owners leave one standing', async () => {
      const { workspaceId, ownerUserId, membershipIds } = await workspaceWithOwners(2);

      const results = await Promise.allSettled(
        membershipIds.map((id) =>
          memberships.remove(workspaceId, owner(ownerUserId), id, 'concurrent removal'),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await activeOwners(workspaceId)).toBe(1);
    });

    it('a removal racing a demotion leaves one standing', async () => {
      // The mixed case, and the one a fix that only guarded `remove` would
      // still get wrong.
      const { workspaceId, ownerUserId, membershipIds } = await workspaceWithOwners(2);

      const results = await Promise.allSettled([
        memberships.remove(workspaceId, owner(ownerUserId), membershipIds[0]!, 'racing removal'),
        memberships.changeRole(workspaceId, owner(ownerUserId), membershipIds[1]!, analystRoleId),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await activeOwners(workspaceId)).toBe(1);
    });

    it('four owners demoted at once leave exactly one', async () => {
      // More than two, so a fix that merely serialises PAIRS is not enough.
      const { workspaceId, ownerUserId, membershipIds } = await workspaceWithOwners(4);
      expect(await activeOwners(workspaceId)).toBe(4);

      const results = await Promise.allSettled(
        membershipIds.map((id) =>
          memberships.changeRole(workspaceId, owner(ownerUserId), id, analystRoleId),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect(await activeOwners(workspaceId)).toBe(1);
    });

    it('does not serialise across workspaces', async () => {
      // The mutex is per workspace. Two unrelated workspaces demoting at the
      // same moment must both succeed — a global lock would be correct and
      // useless.
      const first = await workspaceWithOwners(2);
      const second = await workspaceWithOwners(2);

      const results = await Promise.allSettled([
        memberships.changeRole(
          first.workspaceId,
          owner(first.ownerUserId),
          first.membershipIds[0]!,
          analystRoleId,
        ),
        memberships.changeRole(
          second.workspaceId,
          owner(second.ownerUserId),
          second.membershipIds[0]!,
          analystRoleId,
        ),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      expect(await activeOwners(first.workspaceId)).toBe(1);
      expect(await activeOwners(second.workspaceId)).toBe(1);
    });
  });

  it('an ADMIN may not mint another OWNER', async () => {
    // The single-step escalation to the authority the role was denied.
    const email = uniqueEmail('victim');
    const user = await platform.user.create({
      data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    const membership = await platform.membership.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: user.id,
        roleId: analystRoleId,
        status: 'ACTIVE',
        acceptedAt: new Date(),
        brandScope: [],
      },
    });

    await expect(
      memberships.changeRole(
        fixtures.a.workspaceId,
        admin(fixtures.a.userId),
        membership.id,
        ownerRoleId,
      ),
    ).rejects.toThrow(/may not assign "workspace_owner"/);
  });

  it('an ADMIN may not remove or demote an OWNER', async () => {
    await expect(
      memberships.remove(
        fixtures.a.workspaceId,
        admin(fixtures.a.userId),
        fixtures.a.membershipId,
        'admin attempts to remove the owner',
      ),
    ).rejects.toThrow(/may not remove that member/i);

    // Deliberately a role the admin CAN assign, so the only thing that can
    // refuse this is the TARGET check — "you may not edit somebody who
    // outranks what you may assign". Using an unassignable target role would
    // pass on the other guard and prove nothing about this one.
    await expect(
      memberships.changeRole(
        fixtures.a.workspaceId,
        admin(fixtures.a.userId),
        fixtures.a.membershipId,
        analystRoleId,
      ),
    ).rejects.toThrow(/may not change that member/i);
  });

  it('an ADMIN may not assign a role at or above its own level', async () => {
    const email = uniqueEmail('level');
    const user = await platform.user.create({
      data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    const membership = await platform.membership.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: user.id,
        roleId: analystRoleId,
        status: 'ACTIVE',
        acceptedAt: new Date(),
        brandScope: [],
      },
    });
    // docs/SECURITY.md §4.3: "Assign roles — Admin: below own level."
    await expect(
      memberships.changeRole(
        fixtures.a.workspaceId,
        admin(fixtures.a.userId),
        membership.id,
        adminRoleId,
      ),
    ).rejects.toThrow(/may not assign "workspace_admin"/);
  });

  it('refuses any role change without member.assign_role', async () => {
    await expect(
      memberships.changeRole(
        fixtures.a.workspaceId,
        { userId: fixtures.a.userId, roleKey: 'workspace_owner', permissionKeys: ['member.read'] },
        fixtures.a.membershipId,
        adminRoleId,
      ),
    ).rejects.toThrow('member.assign_role');
  });

  it('refuses any removal without member.remove', async () => {
    await expect(
      memberships.remove(
        fixtures.a.workspaceId,
        { userId: fixtures.a.userId, roleKey: 'workspace_owner', permissionKeys: ['member.read'] },
        fixtures.a.membershipId,
        'no permission',
      ),
    ).rejects.toThrow('member.remove');
  });

  it('an owner CAN appoint a second owner, and then remove the first', async () => {
    const email = uniqueEmail('second-owner');
    const user = await platform.user.create({
      data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    const membership = await platform.membership.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: user.id,
        roleId: analystRoleId,
        status: 'ACTIVE',
        acceptedAt: new Date(),
        brandScope: [],
      },
    });

    await memberships.changeRole(
      fixtures.a.workspaceId,
      owner(fixtures.a.userId),
      membership.id,
      ownerRoleId,
    );

    // With two owners the invariant is satisfied, so the first may now go.
    await memberships.remove(
      fixtures.a.workspaceId,
      owner(user.id),
      fixtures.a.membershipId,
      'handing over the workspace',
    );

    const remaining = await platform.membership.count({
      where: {
        workspaceId: fixtures.a.workspaceId,
        status: 'ACTIVE',
        role: { key: 'workspace_owner' },
      },
    });
    expect(remaining).toBe(1);

    // Restore, so later files in the same run see the original shape.
    await platform.membership.update({
      where: { id: fixtures.a.membershipId },
      data: { status: 'ACTIVE', roleId: ownerRoleId },
    });
  });

  it('removing a member revokes their sessions in THAT workspace', async () => {
    const email = uniqueEmail('revoke-on-remove');
    const user = await platform.user.create({
      data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    const membership = await platform.membership.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: user.id,
        roleId: analystRoleId,
        status: 'ACTIVE',
        acceptedAt: new Date(),
        brandScope: [],
      },
    });
    const session = await platform.customerSession.create({
      data: {
        userId: user.id,
        tokenHash: `remove-test-${Date.now()}`,
        activeWorkspaceId: fixtures.a.workspaceId,
        expiresAt: new Date(Date.now() + 3600_000),
        absoluteExpiresAt: new Date(Date.now() + 7200_000),
      },
    });

    await memberships.remove(
      fixtures.a.workspaceId,
      owner(fixtures.a.userId),
      membership.id,
      'no longer with the company',
    );

    const after = await platform.customerSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.revokedAt).not.toBeNull();
  });

  it('audits every membership change', async () => {
    const events = await platform.auditEvent.findMany({
      where: {
        workspaceId: fixtures.a.workspaceId,
        action: { in: ['workspace.member.removed', 'workspace.member.role_changed'] },
      },
    });
    expect(events.length).toBeGreaterThan(0);
  });
});
