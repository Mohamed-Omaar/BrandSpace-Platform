import Link from 'next/link';
import {
  Banner,
  RecordList,
  StatusBadge,
  buttonClass,
  colorTokens,
  initialsFrom,
  personInitials,
  inputStyle,
  layoutTokens,
  spacingTokens,
  statusTone,
  typographyTokens,
  visuallyHiddenStyle,
} from '@brandspace/ui';
import { ROLE_DEFINITIONS, brandScopeFilter, systemClock } from '@brandspace/shared';
import { QUOTA_FEATURES } from '@brandspace/entitlements';
import {
  inWorkspace,
  memberDisplayName,
  requireWorkspacePage,
} from '../../../server/customer-context';
import { NoAccessPage } from '../../../components/no-access-page';
import { PermissionNotice } from '../../../components/permission-notice';
import { brandContextFor } from '../../../server/brand-context';
import {
  OWNER_ONLY_PERMISSIONS,
  customerRoleName,
  optionalMessage,
  statusMessage,
  translator,
} from '../../../i18n/messages';
import { SettingsFrame } from '../../../components/settings-frame';
import { WorkspaceShell } from '../../../components/workspace-shell';
import { MoreDisclosure } from '../../../components/more-disclosure';
import {
  changeRoleAction,
  inviteMemberAction,
  removeMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
  changeBrandAccessAction,
} from './actions';
import { dayLabel } from '../../../server/prototype-dates';
import { permissionGroups } from '../../../server/permission-groups';
import { PermissionGroupsList } from '../../../components/permission-groups-view';

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
const accessInputStyle = {
  inlineSize: 'var(--bsp-px-20)',
  blockSize: 'var(--bsp-px-20)',
  margin: 0,
} as const;

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
/**
 * THE PROTOTYPE'S TEAM AVATAR (review of #67, round 3): a solid tile with
 * white initials, coloured by the person's place in the list — purple, ink,
 * brown, green (`members` and `newMember`, `Main.dc.html` line 2965). The
 * colours are the stylesheet's (`.bsp-tm-av[data-c]`).
 */
function TeamAvatar({
  initials,
  index,
  size = 36,
}: {
  readonly initials: string;
  readonly index: number;
  readonly size?: 36 | 48;
}) {
  return (
    <span aria-hidden="true" className="bsp-tm-av" data-c={index % 4} data-size={size}>
      {initials}
    </span>
  );
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
  const access = await requireWorkspacePage(locale, '/members');
  const { messageLocale } = access.session;
  const t = translator(messageLocale);
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const session = access.session;
  const { workspace } = session;

  // Every read runs inside the tenant context, so RLS — not a `where` clause
  // this page remembered — is what keeps another tenant's rows out.
  const { members, invitations, invitationTotal, roles, assignable, brands, seatLimit } =
    await inWorkspace(
      workspace.workspaceId,
      async ({ db, memberships, invitations: invitationService, entitlements }) => ({
        members: await memberships.list(workspace.workspaceId),
        /*
         * Review of #67 — the prototype's "3 of 8 seats used": the plan's seat
         * quota (`limit.seats`), resolved by the entitlements engine through
         * plan, override and default like every other limit. Null is no limit,
         * and then the head row counts people instead of inventing a ceiling.
         */
        seatLimit: await entitlements
          .limit(workspace.workspaceId, QUOTA_FEATURES.seats)
          .catch(() => null),
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
  // The owner is always a member, so their name comes from the list already read.
  const owner = members.find((m) => m.isWorkspaceOwner);
  const ownerName = owner?.name?.trim() || owner?.email || '';
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
        className="bsp-tm-access"
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
        <summary style={{ listStyle: 'none' }} className={buttonClass('ghost', 'sm')}>
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

            className={buttonClass('neutral', 'sm')}
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
    optionalMessage(messageLocale, `members.${kind}.${status}`) ?? status;

  const may = (key: string) => workspace.permissionKeys.includes(key);
  // B-5 — nobody is offered a change to their own role or brand access; the
  // service refuses it anyway.
  const isSelf = (member: { userId: string }) => member.userId === session.customer.userId;
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
          style={{ ...inputStyle(), maxInlineSize: 'var(--bsp-rem-11)' }}
        >
          <option value="">{t('members.changeRole')}</option>
          {assignableRoles.map((r) => (
            <option key={r.id} value={r.id}>
              {customerRoleName(locale === 'ar' ? r.nameAr : r.nameEn)}
            </option>
          ))}
        </select>
        <button
          type="submit"
          data-testid={`change-role-${email}`}
          className={buttonClass('neutral', 'sm')}
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
          className={buttonClass('danger', 'sm')}
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
            className={buttonClass('neutral', 'sm')}
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
            className={buttonClass('neutral', 'sm')}
          >
            {t('members.revoke')}
          </button>
        </form>
      </div>
    );
  }

  /*
   * D-298 (§41/§45) — A PERSON, NOT AN ADDRESS. The first column is the
   * member: their name where they gave one, the address under it, and when
   * they joined. Nothing is invented for a member without a name.
   */
  // Round 3 (C2) — the prototype's day style: "Oct 16".
  const joined = { format: (value: Date) => dayLabel(value, locale, 'UTC', systemClock.now()) };
  const memberIdentity = (m: (typeof members)[number]) => (
    <span style={{ display: 'grid', gap: 'var(--bsp-rem-0-125)', minInlineSize: 0 }}>
      {m.name?.trim() ? (
        <strong data-testid={`member-name-${m.email}`} style={typographyTokens.bodySm}>
          {m.name.trim()}
        </strong>
      ) : null}
      <span
        style={{
          ...(m.name?.trim() ? typographyTokens.caption : typographyTokens.bodySm),
          color: m.name?.trim() ? colorTokens.textSecondary : colorTokens.textPrimary,
          overflowWrap: 'anywhere',
        }}
      >
        {m.email}
      </span>
      {m.joinedAt ? (
        <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
          {t('members.joined').replace('{date}', joined.format(m.joinedAt))}
        </span>
      ) : null}
    </span>
  );

  const brandContext = await brandContextFor(session.workspace, '/members');

  /*
   * D-468 — ONE MEMBER, OPENED: the prototype's member page (`Main.dc.html`
   * lines 1390–1402), at `?member=<membership>` so it works without script.
   * An id that is not a member of this workspace opens nothing.
   */
  const openId = typeof query['member'] === 'string' ? query['member'] : null;
  const opened = openId ? (members.find((m) => m.membershipId === openId) ?? null) : null;
  const listHref = `/${locale}/members`;
  const roleName = (m: { roleNameAr: string; roleNameEn: string }) =>
    customerRoleName(locale === 'ar' ? m.roleNameAr : m.roleNameEn);
  const memberMeta = (m: (typeof members)[number]) => (
    <span className="bsp-tm-meta">
      <span className="bsp-tm-email">{m.email}</span>
      <span data-testid={`member-access-${m.email}`}>
        {t('members.access.title')}: {accessLabel(m.brandScope)}
      </span>
      {m.joinedAt ? (
        <span>{t('members.joined').replace('{date}', joined.format(m.joinedAt))}</span>
      ) : null}
    </span>
  );
  /*
   * Review of #67 — THE PROTOTYPE'S ROW SAYS ONE THING under the name: the
   * brand access ("Reema Café"; the owner "Full access"). The address and the
   * joining date are on the member's own page (`?member=`), one press away.
   */
  const rowMeta = (m: (typeof members)[number]) => (
    <span className="bsp-tm-meta">
      <span data-testid={`member-access-${m.email}`}>
        <span className="bs-sr-only">{t('members.access.title')}: </span>
        {m.isWorkspaceOwner ? t('members.fullAccess') : accessLabel(m.brandScope)}
      </span>
    </span>
  );
  const activeSeats = members.filter((m) => m.status === 'ACTIVE').length;
  const statusPill = (status: string) =>
    status === 'ACTIVE' ? null : (
      <span className="bsp-pill bsp-p-neu">{statusLabel('memberStatus', status)}</span>
    );

  const inviteForm = (
    <form action={inviteMemberAction} id="invite" className="bsp-tm-invite bsp-fdis-form">
      <input type="hidden" name="locale" value={locale} />
      <label className="bsp-tm-field" htmlFor="invite-email">
        <span className="bsp-lbl">{t('members.email')}</span>
        <input
          className="bs-control bsp-tm-input"
          id="invite-email"
          name="email"
          type="email"
          required
        />
      </label>
      <label className="bsp-tm-field" htmlFor="invite-role">
        <span className="bsp-lbl">{t('members.role')}</span>
        <select className="bs-control bsp-tm-input" id="invite-role" name="roleId">
          {assignableRoles.map((r) => (
            <option key={r.id} value={r.id}>
              {customerRoleName(locale === 'ar' ? r.nameAr : r.nameEn)}
            </option>
          ))}
        </select>
      </label>
      {brands.length > 0 ? <div className="bsp-tm-wide">{accessFields('invite', [])}</div> : null}
      <button type="submit" className="bsp-btn bsp-pur" data-testid="invite-submit">
        {t('members.invite')}
      </button>
    </form>
  );

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      activePath="/members"
      heading={t('nav.settings')}
      description={t('settings.p.subtitle')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={session.customer.name ?? session.customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      <SettingsFrame
        brandSource={workspace}
        locale={locale}
        permissionKeys={workspace.permissionKeys}
        selected="members"
      >
        {error && <Banner tone="error">{statusMessage(error, locale, ref)}</Banner>}
        {ok && statusMessage(ok, locale) && (
          <Banner tone="success">{statusMessage(ok, locale)}</Banner>
        )}

        {opened ? (
          <>
            <Link href={listHref} className="bsp-btn bsp-sm bsp-ghost bsp-tm-back">
              ← {t('members.title')}
            </Link>
            {/* The member: a 48px tile, the name at 19px, who they are. */}
            <section className="bsp-card bsp-tm-hero" data-testid="member-detail">
              <TeamAvatar
                initials={personInitials(opened.name, opened.email)}
                index={Math.max(0, members.indexOf(opened))}
                size={48}
              />
              <span className="bsp-tm-main">
                <span className="bsp-tm-hname">{opened.name?.trim() || opened.email}</span>
                {memberMeta(opened)}
              </span>
              {opened.isWorkspaceOwner && roleName(opened) === t('members.owner') ? null : (
                <span className="bsp-pill bsp-p-neu">{roleName(opened)}</span>
              )}
              {opened.isWorkspaceOwner ? ownerBadge(opened.email) : null}
              {statusPill(opened.status)}
            </section>

            {opened.isWorkspaceOwner ? (
              <section className="bsp-card bsp-tm-lock">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="5" y="11" width="14" height="10" rx="2" />
                  <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                </svg>
                {t('members.lastOwner')}
              </section>
            ) : null}

            {/*
              THE ROLE, as the prototype's chips: each is the existing role
              change, posted — the member's own role is the pressed one.
            */}
            {may('member.assign_role') && !isSelf(opened) && assignableRoles.length > 0 ? (
              <section className="bsp-card bsp-tm-box" data-testid="member-role">
                <span className="bsp-lbl">{t('members.role')}</span>
                <form action={changeRoleAction} className="bsp-tm-chips">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="membershipId" value={opened.membershipId} />
                  {assignableRoles.map((r) => (
                    <button
                      key={r.id}
                      type="submit"
                      name="roleId"
                      value={r.id}
                      className="bsp-chip"
                      aria-pressed={r.key === opened.roleKey}
                      data-testid={`change-role-${opened.email}-${r.key}`}
                    >
                      {customerRoleName(locale === 'ar' ? r.nameAr : r.nameEn)}
                    </button>
                  ))}
                </form>
              </section>
            ) : null}

            {/* BRAND ACCESS, the existing all-or-some choice and its save. */}
            {may('member.assign_role') &&
            !isSelf(opened) &&
            !opened.isWorkspaceOwner &&
            assignable.includes(opened.roleKey) ? (
              <section className="bsp-card bsp-tm-box">
                <form action={changeBrandAccessAction} className="bsp-tm-form">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="membershipId" value={opened.membershipId} />
                  {accessFields(`member-${opened.email}`, opened.brandScope)}
                  <button
                    type="submit"
                    className="bsp-btn bsp-sm bsp-sec"
                    data-testid={`save-brand-access-${opened.email}`}
                  >
                    {t('common.save')}
                  </button>
                </form>
              </section>
            ) : null}

            {/*
              Round 4, 2.1 — WHAT THIS MEMBER CAN DO, as the prototype's
              two-column groups under the role (lines 1409–1420). Read from
              the role's definition, the same one the role chips change; the
              rows state the role's answer where the prototype draws its
              locked "From the role" pill. No permission key is rendered.
            */}
            <PermissionGroupsList
              groups={permissionGroups(
                ROLE_DEFINITIONS.find((role) => role.key === opened.roleKey)?.permissionKeys ?? [],
                OWNER_ONLY_PERMISSIONS,
              )}
              t={t}
              testId="member-perms"
            />
            <p className="bsp-pg-audit" style={{ margin: 0 }}>
              {t('perms.logged')}
            </p>

            {may('member.remove') ? (
              <section className="bsp-card bsp-tm-box bsp-tm-end">
                {removeForm(opened.membershipId, opened.email)}
              </section>
            ) : null}
          </>
        ) : (
          <>
            {/*
              THE TEAM, as the prototype's card (lines 1382–1388): the head row
              with "+ Invite", then a row per member — the tile, the name and
              who they are, the role pill, and "Manage" to open them.
            */}
            <section className="bsp-card bsp-tm" data-testid="members-card">
              <div className="bsp-row bsp-tm-row bsp-tm-top">
                <span className="bsp-tm-count" data-testid="members-seats">
                  {seatLimit !== null
                    ? t('members.seats')
                        .replace('{used}', String(activeSeats))
                        .replace('{limit}', String(seatLimit))
                    : members.length === 1
                      ? t('members.count.one')
                      : t('members.count').replace('{count}', String(members.length))}
                </span>
                {/*
                  "+ Invite" opens the invitation form in place (review of #67,
                  rule 2): the prototype's button, the product's real form.
                */}
                {may('member.invite') ? (
                  <MoreDisclosure
                    label={t('members.invite')}
                    testId="members-invite-open"
                    align="end"
                    summary={`+ ${t('members.inviteShort')}`}
                    summaryClassName="bsp-btn bsp-sm bsp-pur"
                  >
                    {inviteForm}
                  </MoreDisclosure>
                ) : null}
              </div>
              <div className="bs-wide-only">
                <ul
                  className="bsp-tm-list"
                  aria-label={t('members.title')}
                  data-testid="members-table"
                >
                  {members.map((m, index) => (
                    <li
                      key={m.membershipId}
                      className="bsp-row bsp-tm-row"
                      data-testid={`member-${m.email}`}
                    >
                      <TeamAvatar initials={personInitials(m.name, m.email)} index={index} />
                      <span className="bsp-tm-main">
                        <span className="bsp-tm-name" data-testid={`member-name-${m.email}`}>
                          {m.name?.trim() || m.email}
                        </span>
                        {rowMeta(m)}
                      </span>
                      {/* One "Owner" on the owner's row, as the prototype's. */}
                      {m.isWorkspaceOwner && roleName(m) === t('members.owner') ? null : (
                        <span className="bsp-pill bsp-p-neu">{roleName(m)}</span>
                      )}
                      {m.isWorkspaceOwner ? ownerBadge(m.email) : null}
                      {statusPill(m.status)}
                      {mayManage ? (
                        <Link
                          href={`${listHref}?member=${m.membershipId}`}
                          className="bsp-tm-manage"
                          data-testid={`member-manage-${m.email}`}
                        >
                          {t('members.managePerms')} →
                        </Link>
                      ) : null}
                    </li>
                  ))}
                  {/*
                    THE PROTOTYPE'S INVITED ROW ("Laila Hassan · Invite sent"):
                    each invitation is a row of the same list, its resend and
                    revoke under the row's "⋯".
                  */}
                  {invitations.map((i, index) => (
                    <li
                      key={i.id}
                      className="bsp-row bsp-tm-row"
                      data-testid={`invitation-${i.email}`}
                    >
                      <TeamAvatar initials={initialsFrom(i.email)} index={members.length + index} />
                      <span className="bsp-tm-main">
                        <span className="bsp-tm-name">{i.email}</span>
                        <span className="bsp-tm-meta">
                          <span>
                            {i.status === 'PENDING'
                              ? t('members.inviteSent')
                              : statusLabel('inviteStatus', i.status)}
                            {' · '}
                            <span className="bs-sr-only">{t('members.access.title')}: </span>
                            {accessLabel(i.brandScope)}
                          </span>
                        </span>
                      </span>
                      <span className="bsp-pill bsp-p-neu">{roleName(i)}</span>
                      {i.status === 'PENDING' ? (
                        <MoreDisclosure
                          label={t('members.actions')}
                          testId={`invitation-more-${i.email}`}
                          align="end"
                        >
                          {invitationActions(i.id, i.email, i.status)}
                        </MoreDisclosure>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {invitationTotal > invitations.length && (
                  <p data-testid="invitations-capped" role="status" className="bsp-tm-note">
                    {locale === 'ar'
                      ? `عرض أحدث ${invitations.length} من ${invitationTotal}`
                      : `Showing the most recent ${invitations.length} of ${invitationTotal}`}
                  </p>
                )}
              </div>

              {/* The same members, shaped for a phone: the product's phone layout. */}
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
                        {memberIdentity(m)}
                        {m.isWorkspaceOwner ? ownerBadge(`${m.email}-mobile`) : null}
                      </span>
                    ),
                    fields: [
                      { label: t('members.role'), value: roleName(m) },
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
                        {may('member.assign_role') && !isSelf(m) && assignableRoles.length > 0
                          ? roleForm(`${m.membershipId}-m`, `${m.email}-mobile`)
                          : null}
                        {may('member.assign_role') &&
                        !isSelf(m) &&
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
              <p data-testid="last-owner-rule" className="bsp-tm-note">
                {t('members.lastOwner')}
              </p>
            </section>

            {/* On a phone the invitations keep their own card (the phone layout as it is). */}
            {may('member.invite') && (
              <section className="bsp-card bsp-tm bs-narrow-only" data-testid="invitations-card">
                <div className="bsp-row bsp-tm-row bsp-tm-top">
                  <span className="bsp-tm-count">{t('members.invitations')}</span>
                </div>
                {invitations.length === 0 ? (
                  <div className="bsp-tm-none">
                    <b>{t('members.noInvitations')}</b> {t('members.noInvitationsHint')}
                  </div>
                ) : (
                  <>
                    <div className="bs-narrow-only">
                      <RecordList
                        testId="invitations-list"
                        actionsLabel={t('members.actions')}
                        records={invitations.map((i) => ({
                          id: i.id,
                          title: <span style={{ overflowWrap: 'anywhere' }}>{i.email}</span>,
                          fields: [
                            { label: t('members.role'), value: roleName(i) },
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
              </section>
            )}
            {/* A5/E6 — the invite form is not offered; say why rather than leave a gap. */}
            {!may('member.invite') && (
              <PermissionNotice
                locale={locale}
                permissionKey="member.invite"
                memberName={memberDisplayName(session.customer)}
                ownerName={ownerName}
              />
            )}
          </>
        )}
      </SettingsFrame>
    </WorkspaceShell>
  );
}
