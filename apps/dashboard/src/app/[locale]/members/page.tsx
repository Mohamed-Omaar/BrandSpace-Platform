import {
  Avatar,
  Banner,
  Button,
  Card,
  Cell,
  DataTable,
  Field,
  RecordList,
  Stack,
  StateMessage,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  initialsFrom,
  inputStyle,
  layoutTokens,
  spacingTokens,
  statusTone,
  typographyTokens,
  visuallyHiddenStyle,
  type MediaSeed,
} from '@brandspace/ui';
import { brandScopeFilter } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { brandContextFor } from '../../../server/brand-context';
import { optionalMessage, statusMessage, translator } from '../../../i18n/messages';
import { SettingsFrame } from '../../../components/settings-frame';
import { WorkspaceShell } from '../../../components/workspace-shell';
import {
  changeRoleAction,
  inviteMemberAction,
  removeMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
  changeBrandAccessAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * Brand-access choices sit in a tight list, so each row holds the WCAG 2.5.8
 * minimum target height and the control itself is sized like the approvals
 * checkboxes — a default 13px box stacked 4px apart fails the target-size rule
 * on a phone.
 */
const accessChoiceStyle = {
  display: 'flex',
  gap: spacingTokens.xs,
  alignItems: 'center',
  minBlockSize: layoutTokens.minTargetSize,
} as const;
const accessInputStyle = { inlineSize: '20px', blockSize: '20px', margin: 0 } as const;

/**
 * Team: members and invitations.
 *
 * Requires `member.read`; without it the page is a 404 rather than a 403, so a
 * role cannot learn which screens exist but are closed to it. Each control is
 * additionally gated on the permission that governs it — and the SERVICE checks
 * again behind every form.
 *
 * PHASE 2C: the same rows render TWICE — as a table on a wide screen and as
 * labelled cards on a phone — with CSS choosing between them. A table squeezed
 * into 390px either overflows the page or loses its column headings; neither is
 * an acceptable way to show who has access to a workspace.
 */
/**
 * A stable palette per member, so the same address is the same colour on every
 * render — the deterministic-artwork rule (D-57) applied to identity tiles.
 */
function avatarSeed(email: string): MediaSeed {
  const index = [...email].reduce((total, character) => total + character.charCodeAt(0), 0) % 6;
  return index as MediaSeed;
}

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
  const { members, invitations, invitationTotal, roles, assignable, brands } = await inWorkspace(
    workspace.workspaceId,
    async ({ db, memberships, invitations: invitationService }) => ({
      members: await memberships.list(workspace.workspaceId),
      invitations: workspace.permissionKeys.includes('member.invite')
        ? await invitationService.list(workspace.workspaceId)
        : [],
      // A-11. `list` is capped. The total is read separately so the page can
      // say which it is showing rather than implying the list is complete.
      invitationTotal: workspace.permissionKeys.includes('member.invite')
        ? await invitationService.count(workspace.workspaceId)
        : 0,
      roles: await db.role.findMany({
        where: { realm: 'WORKSPACE', workspaceId: null },
        orderBy: { key: 'asc' },
      }),
      // Only the roles THIS member may hand out. The service refuses anything
      // else, so the list cannot be used to escalate by editing an option value.
      assignable: memberships.assignableRoleKeys(workspace.roleKey),
      /*
       * THE BRANDS THIS VIEWER CAN SEE — the only brands they may grant, and
       * the only brand NAMES this page shows. A member's access to a brand the
       * viewer cannot see is counted ("and 2 more"), never named.
       */
      brands: await db.brand.findMany({
        where: {
          workspaceId: workspace.workspaceId,
          deletedAt: null,
          ...brandScopeFilter(workspace.brandScope),
        },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    }),
  );
  const brandNames = new Map(brands.map((brand) => [brand.id, brand.name]));
  const viewerRestricted = workspace.brandScope.length > 0;

  /** "All brands", or the brands by name — counting any the viewer cannot see. */
  function accessLabel(scope: readonly string[]): string {
    if (scope.length === 0) return t('members.access.all');
    const named = scope.flatMap((id) => {
      const name = brandNames.get(id);
      return name ? [name] : [];
    });
    const hidden = scope.length - named.length;
    return hidden > 0
      ? `${named.join('، ')}${named.length > 0 ? ' ' : ''}${t('members.access.more').replace('{count}', String(hidden))}`
      : named.join(locale === 'ar' ? '، ' : ', ');
  }

  /**
   * The brand-access controls, shared by the invitation form and the
   * per-member editor. "All brands" is offered only to a viewer who holds it
   * themselves; a restricted viewer can grant only a subset of their own.
   * Native radios and checkboxes, so it works without script.
   */
  function accessFields(idPrefix: string, current: readonly string[]) {
    const all = current.length === 0 && !viewerRestricted;
    return (
      <fieldset
        style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: spacingTokens.xs }}
        data-testid={`${idPrefix}-access`}
      >
        <legend style={{ ...typographyTokens.label, marginBlockEnd: spacingTokens.xs }}>
          {t('members.access.title')}
        </legend>
        {!viewerRestricted ? (
          <label style={accessChoiceStyle}>
            <input
              type="radio"
              name="access"
              value="all"
              defaultChecked={all}
              style={accessInputStyle}
            />
            <span style={typographyTokens.bodySm}>{t('members.access.all')}</span>
          </label>
        ) : null}
        <label style={accessChoiceStyle}>
          <input
            type="radio"
            name="access"
            value="selected"
            defaultChecked={!all}
            style={accessInputStyle}
          />
          <span style={typographyTokens.bodySm}>{t('members.access.selected')}</span>
        </label>
        <div
          style={{
            display: 'grid',
            gap: spacingTokens['2xs'],
            paddingInlineStart: spacingTokens.lg,
          }}
        >
          {brands.map((brand) => (
            <label key={brand.id} style={accessChoiceStyle}>
              <input
                type="checkbox"
                name="brandId"
                value={brand.id}
                defaultChecked={current.includes(brand.id)}
                style={accessInputStyle}
              />
              <span style={typographyTokens.bodySm}>{brand.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  function accessForm(membershipId: string, current: readonly string[], testKey: string) {
    return (
      <details data-testid={`brand-access-${testKey}`}>
        <summary
          style={{ ...buttonStyle('ghost', 'sm'), listStyle: 'none' }}
          className={buttonClass('ghost')}
        >
          {t('members.access.change')}
        </summary>
        <form
          action={changeBrandAccessAction}
          style={{ display: 'grid', gap: spacingTokens.sm, marginBlockStart: spacingTokens.xs }}
        >
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="membershipId" value={membershipId} />
          {accessFields(`member-${testKey}`, current)}
          <button
            type="submit"
            style={buttonStyle('neutral', 'sm')}
            className={buttonClass('neutral')}
            data-testid={`save-brand-access-${testKey}`}
          >
            {t('common.save')}
          </button>
        </form>
      </details>
    );
  }

  const assignableRoles = roles.filter((r) => assignable.includes(r.key));

  /** A membership or invitation status in the reader's language (P6-15). */
  const statusLabel = (kind: 'memberStatus' | 'inviteStatus', status: string): string =>
    optionalMessage(locale, `members.${kind}.${status}`) ?? status;

  const may = (key: string) => workspace.permissionKeys.includes(key);
  const mayManage = may('member.assign_role') || may('member.remove');
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  const ownerBadge = (email: string) => (
    <StatusBadge label={t('members.owner')} tone="accent" testId={`owner-badge-${email}`} />
  );

  function roleForm(membershipId: string, email: string) {
    return (
      <form action={changeRoleAction} style={{ display: 'flex', gap: spacingTokens.xs }}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="membershipId" value={membershipId} />
        <label htmlFor={`role-${membershipId}`} style={visuallyHiddenStyle()}>
          {t('members.changeRole')}
        </label>
        <select
          className="bs-control"
          id={`role-${membershipId}`}
          name="roleId"
          defaultValue=""
          style={{ ...inputStyle(), maxInlineSize: '11rem' }}
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
          data-testid={`change-role-${email}`}
          style={buttonStyle('neutral', 'sm')}
        >
          {t('common.save')}
        </button>
      </form>
    );
  }

  function removeForm(membershipId: string, email: string) {
    return (
      <form action={removeMemberAction}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="membershipId" value={membershipId} />
        <button
          type="submit"
          data-testid={`remove-member-${email}`}
          style={buttonStyle('danger', 'sm')}
        >
          {t('members.remove')}
        </button>
      </form>
    );
  }

  function invitationActions(id: string, email: string, status: string) {
    if (status !== 'PENDING') return null;
    return (
      <div style={{ display: 'flex', gap: spacingTokens.xs, flexWrap: 'wrap' }}>
        <form action={resendInvitationAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="invitationId" value={id} />
          <button
            type="submit"
            data-testid={`resend-${email}`}
            style={buttonStyle('neutral', 'sm')}
          >
            {t('members.resend')}
          </button>
        </form>
        <form action={revokeInvitationAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="invitationId" value={id} />
          <button
            type="submit"
            data-testid={`revoke-${email}`}
            style={buttonStyle('neutral', 'sm')}
          >
            {t('members.revoke')}
          </button>
        </form>
      </div>
    );
  }

  const memberHeaders = [
    t('members.email'),
    t('members.role'),
    t('members.access.title'),
    t('members.status'),
    ...(mayManage ? [t('members.actions')] : []),
  ];

  const brandContext = await brandContextFor(session.workspace, '/members');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      activePath="/members"
      heading={t('members.title')}
      description={t('members.description')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={session.customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      <SettingsFrame locale={locale} permissionKeys={workspace.permissionKeys} selected="members">
        {error && <Banner tone="error">{statusMessage(error, locale, ref)}</Banner>}
        {ok && statusMessage(ok, locale) && (
          <Banner tone="success">{statusMessage(ok, locale)}</Banner>
        )}

        <Stack>
          <Card
            title={t('members.title')}
            testId="members-card"
            footer={
              <p
                data-testid="last-owner-rule"
                style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textSecondary }}
              >
                {t('members.lastOwner')}
              </p>
            }
          >
            <div className="bs-wide-only">
              <DataTable
                headers={memberHeaders}
                caption={t('members.title')}
                testId="members-table"
              >
                {members.map((m) => (
                  <tr key={m.membershipId} data-testid={`member-${m.email}`}>
                    <Cell>
                      {/*
                      `.record-main { display: flex; gap: 9px; align-items: center }`
                      with `.record-main .avatar { border-radius: 11px }` — the
                      demo's directory rows lead with a rounded identity tile,
                      which is also what makes a long list of addresses
                      scannable. The initials come from the address already
                      shown beside them; nothing new is invented.
                    */}
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.5625rem',
                          flexWrap: 'wrap',
                        }}
                      >
                        <Avatar
                          initials={initialsFrom(m.email)}
                          seed={avatarSeed(m.email)}
                          shape="tile"
                        />
                        {m.email}
                        {m.isWorkspaceOwner ? ownerBadge(m.email) : null}
                      </span>
                    </Cell>
                    <Cell>{locale === 'ar' ? m.roleNameAr : m.roleNameEn}</Cell>
                    <Cell>
                      <span data-testid={`member-access-${m.email}`}>
                        {accessLabel(m.brandScope)}
                      </span>
                    </Cell>
                    <Cell>
                      <StatusBadge
                        label={statusLabel('memberStatus', m.status)}
                        tone={statusTone(m.status)}
                      />
                    </Cell>
                    {mayManage ? (
                      <Cell>
                        <div style={{ display: 'flex', gap: spacingTokens.xs, flexWrap: 'wrap' }}>
                          {may('member.assign_role') && assignableRoles.length > 0
                            ? roleForm(m.membershipId, m.email)
                            : null}
                          {may('member.assign_role') &&
                          !m.isWorkspaceOwner &&
                          assignable.includes(m.roleKey)
                            ? accessForm(m.membershipId, m.brandScope, m.email)
                            : null}
                          {may('member.remove') ? removeForm(m.membershipId, m.email) : null}
                        </div>
                      </Cell>
                    ) : null}
                  </tr>
                ))}
              </DataTable>
            </div>

            {/* The same members, shaped for a phone: column headings become
              visible labels instead of disappearing off the side. */}
            <div className="bs-narrow-only">
              <RecordList
                testId="members-list"
                actionsLabel={t('members.actions')}
                records={members.map((m) => ({
                  id: m.membershipId,
                  title: (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: spacingTokens.xs,
                        flexWrap: 'wrap',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {m.email}
                      {m.isWorkspaceOwner ? ownerBadge(`${m.email}-mobile`) : null}
                    </span>
                  ),
                  fields: [
                    {
                      label: t('members.role'),
                      value: locale === 'ar' ? m.roleNameAr : m.roleNameEn,
                    },
                    { label: t('members.access.title'), value: accessLabel(m.brandScope) },
                    {
                      label: t('members.status'),
                      value: (
                        <StatusBadge
                          label={statusLabel('memberStatus', m.status)}
                          tone={statusTone(m.status)}
                        />
                      ),
                    },
                  ],
                  actions: mayManage ? (
                    <>
                      {may('member.assign_role') && assignableRoles.length > 0
                        ? roleForm(`${m.membershipId}-m`, `${m.email}-mobile`)
                        : null}
                      {may('member.assign_role') &&
                      !m.isWorkspaceOwner &&
                      assignable.includes(m.roleKey)
                        ? accessForm(m.membershipId, m.brandScope, `${m.email}-mobile`)
                        : null}
                      {may('member.remove')
                        ? removeForm(m.membershipId, `${m.email}-mobile`)
                        : null}
                    </>
                  ) : undefined,
                }))}
              />
            </div>
          </Card>

          {may('member.invite') && (
            <Card title={t('members.invitations')} testId="invitations-card">
              {invitations.length === 0 ? (
                <StateMessage
                  title={t('members.noInvitations')}
                  description={t('members.noInvitationsHint')}
                />
              ) : (
                <>
                  {invitationTotal > invitations.length && (
                    <p
                      data-testid="invitations-capped"
                      role="status"
                      style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
                    >
                      {locale === 'ar'
                        ? `عرض أحدث ${invitations.length} من ${invitationTotal}`
                        : `Showing the most recent ${invitations.length} of ${invitationTotal}`}
                    </p>
                  )}
                  <div className="bs-wide-only">
                    <DataTable
                      headers={[
                        t('members.email'),
                        t('members.role'),
                        t('members.access.title'),
                        t('members.status'),
                        t('members.actions'),
                      ]}
                      caption={t('members.invitations')}
                      testId="invitations-table"
                    >
                      {invitations.map((i) => (
                        <tr key={i.id} data-testid={`invitation-${i.email}`}>
                          <Cell>{i.email}</Cell>
                          <Cell>{locale === 'ar' ? i.roleNameAr : i.roleNameEn}</Cell>
                          <Cell>{accessLabel(i.brandScope)}</Cell>
                          <Cell>
                            <StatusBadge
                              label={statusLabel('inviteStatus', i.status)}
                              tone={statusTone(i.status)}
                            />
                          </Cell>
                          <Cell>{invitationActions(i.id, i.email, i.status)}</Cell>
                        </tr>
                      ))}
                    </DataTable>
                  </div>
                  <div className="bs-narrow-only">
                    <RecordList
                      testId="invitations-list"
                      actionsLabel={t('members.actions')}
                      records={invitations.map((i) => ({
                        id: i.id,
                        title: <span style={{ overflowWrap: 'anywhere' }}>{i.email}</span>,
                        fields: [
                          {
                            label: t('members.role'),
                            value: locale === 'ar' ? i.roleNameAr : i.roleNameEn,
                          },
                          { label: t('members.access.title'), value: accessLabel(i.brandScope) },
                          {
                            label: t('members.status'),
                            value: (
                              <StatusBadge
                                label={statusLabel('inviteStatus', i.status)}
                                tone={statusTone(i.status)}
                              />
                            ),
                          },
                        ],
                        actions:
                          invitationActions(i.id, `${i.email}-mobile`, i.status) ?? undefined,
                      }))}
                    />
                  </div>
                </>
              )}

              <form
                action={inviteMemberAction}
                style={{ marginBlockStart: spacingTokens.lg, maxInlineSize: '28rem' }}
              >
                <input type="hidden" name="locale" value={locale} />
                <Field label={t('members.email')} htmlFor="invite-email" required>
                  <input
                    className="bs-control"
                    id="invite-email"
                    name="email"
                    type="email"
                    required
                    style={inputStyle()}
                  />
                </Field>
                <Field label={t('members.role')} htmlFor="invite-role" required>
                  <select
                    className="bs-control"
                    id="invite-role"
                    name="roleId"
                    style={inputStyle()}
                  >
                    {assignableRoles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {locale === 'ar' ? r.nameAr : r.nameEn}
                      </option>
                    ))}
                  </select>
                </Field>
                {brands.length > 0 ? (
                  <div style={{ marginBlockEnd: spacingTokens.md }}>
                    {accessFields('invite', [])}
                  </div>
                ) : null}
                <Button type="submit" data-testid="invite-submit">
                  {t('members.invite')}
                </Button>
              </form>
            </Card>
          )}
        </Stack>
      </SettingsFrame>
    </WorkspaceShell>
  );
}
