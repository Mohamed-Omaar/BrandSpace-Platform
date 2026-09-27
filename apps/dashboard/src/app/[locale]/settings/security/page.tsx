import {
  Card,
  Field,
  SettingsSplit,
  buttonStyle,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { getPrisma, withoutTenantContext } from '@brandspace/database';
import { SignupService } from '@brandspace/auth';
import { TenantOnboardingPolicySource } from '@brandspace/onboarding';
import { cookies } from 'next/headers';
import {
  currentEnvironment,
  getCustomerAuth,
  getSessionToken,
  holdsPermission,
  requireWorkspace,
} from '../../../../server/customer-context';
import { brandContextFor } from '../../../../server/brand-context';
import { settingsNavItems } from '../../../../server/settings-nav';
import { statusMessage, translator } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import {
  beginMfaEnrolmentAction,
  beginNewPhoneAction,
  cancelNewPhoneAction,
  confirmMfaEnrolmentAction,
  confirmNewPhoneAction,
  disableMfaAction,
  dismissRecoveryCodesAction,
  regenerateRecoveryCodesAction,
  setWorkspaceMfaRequirementAction,
  signOutOtherSessionsAction,
} from './actions';
import { MfaEnrolmentPanel } from '../../../../components/mfa-enrolment';
import { CheckboxRow } from '../../../../components/checkbox-row';
import { RECOVERY_CODES_COOKIE } from '../../../../server/mfa-codes';

export const dynamic = 'force-dynamic';

/**
 * The customer's own security settings — Phase 4.
 *
 * AN APPROVED DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2), not a demo port: the
 * approved reference has no security screen, and a functional gap must not wait
 * for artwork. It is built from what already ships — `SettingsSplit`, `Card`,
 * `Field`, the button and input styles, the same banner and the same section
 * nav — and introduces no new layout system, colour family or interaction.
 *
 * WHY IT IS GATED ON NOTHING. A second factor is a property of the PERSON, and
 * the person reading this page is the only one it belongs to. Like
 * `/permissions`, the route calls `requireWorkspace(locale)` with no permission:
 * the workspace is what the shell renders around, not what authorises anything
 * here. No workspace administrator has any authority over another member's
 * authenticator, and none is offered.
 */
export default async function SecuritySettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale);

  const policy = await withoutTenantContext(
    async (db) => new TenantOnboardingPolicySource(db, currentEnvironment()).load(),
    { prisma: getPrisma() },
  );

  const prisma = getPrisma();
  const signup = new SignupService({
    prisma,
    // Nothing on this page sends mail; both are required by the constructor.
    email: { key: 'unused', send: async () => ({ messageId: '' }) },
    verificationLink: () => '',
  });

  const account = await withoutTenantContext(
    async (db) =>
      db.user.findUniqueOrThrow({
        where: { id: customer.userId },
        select: { mfaEnabled: true, mfaEnrolledAt: true },
      }),
    { prisma },
  );
  const remainingCodes = account.mfaEnabled
    ? await signup.remainingRecoveryCodes(customer.userId)
    : 0;
  /*
   * G4 / Q23 (D-333): the enrolment in progress — first time, or a new phone —
   * opened on the server so the QR code and the key are drawn here and the
   * seed never travels in a URL.
   */
  const pending = await signup.pendingEnrolment(customer.userId);
  /* Every workspace this person belongs to, to know whether any requires two-step. */
  const memberships = await getCustomerAuth()
    .listWorkspaces((await getSessionToken()) ?? '', {
      includePendingDeletion: true,
      includeMfaRequired: true,
    })
    .catch(() => []);
  const requiredBy = memberships.find((membership) => membership.requireMfa) ?? null;
  const mayRequire = holdsPermission(workspace, 'workspace.security.manage');

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;
  /*
   * SHOWN ONCE, AND THE PAGE SAYS SO. Only the hashes are stored; the codes
   * arrive in a five-minute httpOnly cookie that "I have saved them" deletes
   * (D-333) — never in the query string, where history and Referer keep them.
   */
  const issuedCodes = ((await cookies()).get(RECOVERY_CODES_COOKIE)?.value ?? '')
    .split(' ')
    .filter((code) => code !== '');
  const enrolmentLabels = {
    scan: t('security.enrolScan'),
    qrAlt: t('security.qrAlt'),
    typeKey: t('security.typeKey'),
    code: t('security.code'),
    confirm: t('security.confirm'),
  };

  const brandContext = await brandContextFor(workspace, '/settings/security');
  const mfaAvailable = policy.mfa.customerEnrolmentEnabled;

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('security.title')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      {ok && statusMessage(ok, locale) && (
        <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner>
      )}

      <SettingsSplit
        navLabel={t('settings.navLabel')}
        items={settingsNavItems({
          locale,
          permissionKeys: workspace.permissionKeys,
          selected: 'security',
        }).map((item) => ({
          href: item.href,
          label: t(item.labelKey),
          selected: item.selected,
        }))}
      >
        <Card testId="mfa-card">
          <div style={{ display: 'grid', gap: spacingTokens.md }}>
            <div>
              <b>{t('security.mfaHeading')}</b>{' '}
              <span data-testid="mfa-state">
                {account.mfaEnabled ? t('security.mfaOn') : t('security.mfaOff')}
              </span>
              <p style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted }}>
                {t('security.mfaExplain')}
              </p>
            </div>

            {!mfaAvailable && (
              <p style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted }}>
                {t('security.unavailable')}
              </p>
            )}

            {/* NOT ENROLLED, AND ENROLMENT NOT YET STARTED. */}
            {mfaAvailable && !account.mfaEnabled && !pending && (
              <form action={beginMfaEnrolmentAction}>
                <input type="hidden" name="locale" value={locale} />
                <button type="submit" data-testid="mfa-begin" style={buttonStyle('primary')}>
                  {t('security.enrolStart')}
                </button>
              </form>
            )}

            {/* MID-ENROLMENT: a QR code and the typed key, drawn from the server. */}
            {mfaAvailable && !account.mfaEnabled && pending && (
              <MfaEnrolmentPanel
                locale={locale}
                otpauthUri={pending.otpauthUri}
                secret={pending.secret}
                action={confirmMfaEnrolmentAction}
                from="security"
                labels={enrolmentLabels}
              />
            )}

            {/* ENROLLED, A NEW PHONE BEING SET UP: the old one works until this one proves itself. */}
            {account.mfaEnabled && pending && (
              <div style={{ display: 'grid', gap: spacingTokens.md }}>
                <b>{t('security.newPhoneHeading')}</b>
                <MfaEnrolmentPanel
                  locale={locale}
                  otpauthUri={pending.otpauthUri}
                  secret={pending.secret}
                  action={confirmNewPhoneAction}
                  from="security"
                  labels={enrolmentLabels}
                  testId="mfa-new-phone"
                />
                <form action={cancelNewPhoneAction}>
                  <input type="hidden" name="locale" value={locale} />
                  <button
                    type="submit"
                    data-testid="mfa-new-phone-cancel"
                    style={buttonStyle('ghost')}
                  >
                    {t('common.cancel')}
                  </button>
                </form>
              </div>
            )}

            {/* ENROLLED: "New phone" costs a current code. */}
            {mfaAvailable && account.mfaEnabled && !pending && (
              <form action={beginNewPhoneAction} style={{ display: 'grid', gap: spacingTokens.md }}>
                <input type="hidden" name="locale" value={locale} />
                <p style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted }}>
                  {t('security.newPhoneExplain')}
                </p>
                <Field label={t('security.code')} htmlFor="new-phone-code">
                  <input
                    className="bs-control"
                    id="new-phone-code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    data-testid="mfa-new-phone-code"
                    style={inputStyle()}
                  />
                </Field>
                <div>
                  <button
                    type="submit"
                    data-testid="mfa-new-phone-begin"
                    style={buttonStyle('neutral')}
                  >
                    {t('security.newPhone')}
                  </button>
                </div>
              </form>
            )}

            {/* ENROLLED AND REQUIRED: it cannot be turned off, and the page says why. */}
            {account.mfaEnabled && requiredBy ? (
              <p style={typographyTokens.bodySm} data-testid="mfa-required-note">
                {t('security.requiredCannotDisable').replace(
                  '{workspace}',
                  requiredBy.workspaceName,
                )}
              </p>
            ) : null}

            {/* ENROLLED: turning it off costs a current code OR the password. */}
            {account.mfaEnabled && !requiredBy && (
              <form action={disableMfaAction} style={{ display: 'grid', gap: spacingTokens.md }}>
                <input type="hidden" name="locale" value={locale} />
                <p style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted }}>
                  {t('security.disableExplain')}
                </p>
                <div className="bs-form-row">
                  <Field label={t('security.code')} htmlFor="disable-code">
                    <input
                      className="bs-control"
                      id="disable-code"
                      name="code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      data-testid="mfa-disable-code"
                      style={inputStyle()}
                    />
                  </Field>
                  <Field label={t('security.orPassword')} htmlFor="disable-password">
                    <input
                      className="bs-control"
                      id="disable-password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      data-testid="mfa-disable-password"
                      style={inputStyle()}
                    />
                  </Field>
                </div>
                <div>
                  <button type="submit" data-testid="mfa-disable" style={buttonStyle('neutral')}>
                    {t('security.disable')}
                  </button>
                </div>
              </form>
            )}
          </div>
        </Card>

        {/*
          G4 / Q23 (D-333) — THE OWNER REQUIRES IT FOR EVERYONE. Offered only
          with `workspace.security.manage` (the Owner); the action checks it
          again and refuses to turn it on before the Owner's own is on.
        */}
        {mayRequire ? (
          <Card testId="mfa-requirement-card">
            <form
              action={setWorkspaceMfaRequirementAction}
              style={{ display: 'grid', gap: spacingTokens.md }}
            >
              <input type="hidden" name="locale" value={locale} />
              <b>{t('security.requireHeading')}</b>
              <CheckboxRow
                name="requireMfa"
                label={t('security.requireLabel').replace('{workspace}', workspace.workspaceName)}
                hint={t('security.requireHint')}
                checked={workspace.requireMfa === true}
                testId="mfa-require"
              />
              <div>
                <button type="submit" data-testid="mfa-require-save" style={buttonStyle('primary')}>
                  {t('common.save')}
                </button>
              </div>
            </form>
          </Card>
        ) : null}

        {/* THE CODES, SHOWN ONCE. Their own card, because losing them is how
            optional MFA turns into MFA nobody switches on. */}
        {(account.mfaEnabled || issuedCodes.length > 0) && (
          <Card testId="recovery-card">
            <div style={{ display: 'grid', gap: spacingTokens.md }}>
              <div>
                <b>{t('security.recoveryHeading')}</b>
                <p style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted }}>
                  {t('security.recoveryExplain')}
                </p>
              </div>

              {issuedCodes.length > 0 && (
                <div
                  data-testid="recovery-codes"
                  style={{ display: 'grid', gap: spacingTokens.sm }}
                >
                  <p style={typographyTokens.bodySm}>
                    <b>{t('security.recoveryOnce')}</b>
                  </p>
                  <ul
                    style={{
                      ...typographyTokens.caption,
                      margin: 0,
                      paddingInlineStart: '1.25rem',
                    }}
                  >
                    {issuedCodes.map((code) => (
                      <li key={code}>
                        <code>{code}</code>
                      </li>
                    ))}
                  </ul>
                  <form action={dismissRecoveryCodesAction}>
                    <input type="hidden" name="locale" value={locale} />
                    <button
                      type="submit"
                      data-testid="recovery-codes-saved"
                      style={buttonStyle('neutral')}
                    >
                      {t('security.recoverySaved')}
                    </button>
                  </form>
                </div>
              )}

              {account.mfaEnabled && (
                <>
                  <p style={typographyTokens.bodySm} data-testid="recovery-remaining">
                    {t('security.recoveryRemaining')}: {remainingCodes}
                  </p>
                  <form
                    action={regenerateRecoveryCodesAction}
                    style={{ display: 'grid', gap: spacingTokens.md }}
                  >
                    <input type="hidden" name="locale" value={locale} />
                    <p style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted }}>
                      {t('security.recoveryRegenerateExplain')}
                    </p>
                    <Field label={t('security.code')} htmlFor="regen-code">
                      <input
                        className="bs-control"
                        id="regen-code"
                        name="code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        required
                        data-testid="recovery-regen-code"
                        style={inputStyle()}
                      />
                    </Field>
                    <div>
                      <button
                        type="submit"
                        data-testid="recovery-regenerate"
                        style={buttonStyle('neutral')}
                      >
                        {t('security.recoveryRegenerate')}
                      </button>
                    </div>
                  </form>
                </>
              )}
            </div>
          </Card>
        )}

        <Card testId="sessions-card">
          <form
            action={signOutOtherSessionsAction}
            style={{ display: 'grid', gap: spacingTokens.md }}
          >
            <input type="hidden" name="locale" value={locale} />
            <div>
              <b>{t('security.sessionsHeading')}</b>
              <p style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted }}>
                {t('security.sessionsExplain')}
              </p>
            </div>
            <div>
              <button type="submit" data-testid="sessions-revoke" style={buttonStyle('neutral')}>
                {t('security.signOutOthers')}
              </button>
            </div>
          </form>
        </Card>
      </SettingsSplit>
    </WorkspaceShell>
  );
}
