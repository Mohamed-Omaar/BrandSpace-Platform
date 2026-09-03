import {
  colorTokens,
  scrollContainerStyle,
  spacingTokens,
  visuallyHiddenStyle,
} from '@brandspace/ui';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { statusMessage, translator } from '../../../i18n/messages';
import {
  CustomerBanner,
  CustomerCard,
  CustomerEmpty,
  WorkspaceShell,
  customerButtonStyle,
  customerInputStyle,
  customerSecondaryButtonStyle,
  customerTableStyle,
  customerTdStyle,
  customerThStyle,
} from '../../../components/workspace-shell';
import {
  changeRoleAction,
  inviteMemberAction,
  removeMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * Team: members and invitations.
 *
 * Requires `member.read`; without it the page is a 404 rather than a 403, so a
 * role cannot learn which screens exist but are closed to it. Each control is
 * additionally gated on the permission that governs it — and the SERVICE checks
 * again behind every form.
 */
export default async function MembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const session = await requireWorkspace(locale, 'member.read');
  const { workspace } = session;

  // Every read runs inside the tenant context, so RLS — not a `where` clause
  // this page remembered — is what keeps another tenant's rows out.
  const { members, invitations, roles, assignable } = await inWorkspace(
    workspace.workspaceId,
    async ({ db, memberships, invitations: invitationService }) => ({
      members: await memberships.list(workspace.workspaceId),
      invitations: workspace.permissionKeys.includes('member.invite')
        ? await invitationService.list(workspace.workspaceId)
        : [],
      roles: await db.role.findMany({
        where: { realm: 'WORKSPACE', workspaceId: null },
        orderBy: { key: 'asc' },
      }),
      // Only the roles THIS member may hand out. The service refuses anything
      // else, so the list cannot be used to escalate by editing an option value.
      assignable: memberships.assignableRoleKeys(workspace.roleKey),
    }),
  );

  const assignableRoles = roles.filter((r) => assignable.includes(r.key));

  const may = (key: string) => workspace.permissionKeys.includes(key);
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  return (
    <WorkspaceShell
      locale={locale}
      heading={t('members.title')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      permissionKeys={workspace.permissionKeys}
    >
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      {ok && statusMessage(ok, locale) && (
        <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner>
      )}

      <CustomerCard title={t('members.title')} testId="members-card">
        <div style={scrollContainerStyle()}>
          <table style={customerTableStyle()} data-testid="members-table">
            <thead>
              <tr>
                <th style={customerThStyle()}>{t('members.email')}</th>
                <th style={customerThStyle()}>{t('members.role')}</th>
                <th style={customerThStyle()}>{t('members.status')}</th>
                {(may('member.assign_role') || may('member.remove')) && (
                  <th style={customerThStyle()} />
                )}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.membershipId} data-testid={`member-${m.email}`}>
                  <td style={customerTdStyle()}>
                    {m.email}
                    {m.isWorkspaceOwner && (
                      <span
                        data-testid={`owner-badge-${m.email}`}
                        style={{
                          marginInlineStart: spacingTokens.xs,
                          fontSize: '0.6875rem',
                          color: colorTokens.brandPurple,
                          fontWeight: 700,
                        }}
                      >
                        OWNER
                      </span>
                    )}
                  </td>
                  <td style={customerTdStyle()}>{locale === 'ar' ? m.roleNameAr : m.roleNameEn}</td>
                  <td style={customerTdStyle()}>{m.status}</td>
                  {(may('member.assign_role') || may('member.remove')) && (
                    <td style={customerTdStyle()}>
                      <div style={{ display: 'flex', gap: spacingTokens.xs, flexWrap: 'wrap' }}>
                        {may('member.assign_role') && assignableRoles.length > 0 && (
                          <form action={changeRoleAction} style={{ display: 'flex', gap: '4px' }}>
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="membershipId" value={m.membershipId} />
                            <label htmlFor={`role-${m.membershipId}`} style={visuallyHiddenStyle()}>
                              {t('members.changeRole')}
                            </label>
                            <select
                              id={`role-${m.membershipId}`}
                              name="roleId"
                              defaultValue=""
                              style={{ ...customerInputStyle(), maxInlineSize: '11rem' }}
                            >
                              <option value="">{t('members.changeRole')}</option>
                              {assignableRoles.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {locale === 'ar' ? r.nameAr : r.nameEn}
                                </option>
                              ))}
                            </select>
                            <button
                              type="submit"
                              data-testid={`change-role-${m.email}`}
                              style={customerSecondaryButtonStyle()}
                            >
                              {t('common.save')}
                            </button>
                          </form>
                        )}
                        {may('member.remove') && (
                          <form action={removeMemberAction}>
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="membershipId" value={m.membershipId} />
                            <button
                              type="submit"
                              data-testid={`remove-member-${m.email}`}
                              style={{
                                ...customerSecondaryButtonStyle(),
                                color: colorTokens.danger,
                                borderColor: colorTokens.danger,
                              }}
                            >
                              {t('members.remove')}
                            </button>
                          </form>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p
          data-testid="last-owner-rule"
          style={{
            marginBlockEnd: 0,
            fontSize: '0.8125rem',
            color: colorTokens.textSecondary,
          }}
        >
          {t('members.lastOwner')}
        </p>
      </CustomerCard>

      {may('member.invite') && (
        <CustomerCard title={t('members.invitations')} testId="invitations-card">
          {invitations.length === 0 ? (
            <CustomerEmpty message={t('common.empty')} />
          ) : (
            <div style={scrollContainerStyle()}>
              <table style={customerTableStyle()} data-testid="invitations-table">
                <thead>
                  <tr>
                    <th style={customerThStyle()}>{t('members.email')}</th>
                    <th style={customerThStyle()}>{t('members.role')}</th>
                    <th style={customerThStyle()}>{t('members.status')}</th>
                    <th style={customerThStyle()} />
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((i) => (
                    <tr key={i.id} data-testid={`invitation-${i.email}`}>
                      <td style={customerTdStyle()}>{i.email}</td>
                      <td style={customerTdStyle()}>{i.roleKey}</td>
                      <td style={customerTdStyle()}>{i.status}</td>
                      <td style={customerTdStyle()}>
                        {i.status === 'PENDING' && (
                          <div style={{ display: 'flex', gap: spacingTokens.xs, flexWrap: 'wrap' }}>
                            <form action={resendInvitationAction}>
                              <input type="hidden" name="locale" value={locale} />
                              <input type="hidden" name="invitationId" value={i.id} />
                              <button
                                type="submit"
                                data-testid={`resend-${i.email}`}
                                style={customerSecondaryButtonStyle()}
                              >
                                {t('members.resend')}
                              </button>
                            </form>
                            <form action={revokeInvitationAction}>
                              <input type="hidden" name="locale" value={locale} />
                              <input type="hidden" name="invitationId" value={i.id} />
                              <button
                                type="submit"
                                data-testid={`revoke-${i.email}`}
                                style={customerSecondaryButtonStyle()}
                              >
                                {t('members.revoke')}
                              </button>
                            </form>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form action={inviteMemberAction} style={{ marginBlockStart: spacingTokens.lg }}>
            <input type="hidden" name="locale" value={locale} />
            <label
              htmlFor="invite-email"
              style={{ display: 'block', fontWeight: 600, fontSize: '0.8125rem' }}
            >
              {t('members.email')}
            </label>
            <input
              id="invite-email"
              name="email"
              type="email"
              required
              style={customerInputStyle()}
            />
            <label
              htmlFor="invite-role"
              style={{
                display: 'block',
                fontWeight: 600,
                fontSize: '0.8125rem',
                marginBlockStart: spacingTokens.sm,
              }}
            >
              {t('members.role')}
            </label>
            <select id="invite-role" name="roleId" style={customerInputStyle()}>
              {assignableRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {locale === 'ar' ? r.nameAr : r.nameEn}
                </option>
              ))}
            </select>
            <button
              type="submit"
              data-testid="invite-submit"
              style={{ ...customerButtonStyle(), marginBlockStart: spacingTokens.md }}
            >
              {t('members.invite')}
            </button>
          </form>
        </CustomerCard>
      )}
    </WorkspaceShell>
  );
}
