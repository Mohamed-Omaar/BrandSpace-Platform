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
import { currentEnvironment, requireWorkspace } from '../../../../server/customer-context';
import { brandContextFor } from '../../../../server/brand-context';
import { settingsNavItems } from '../../../../server/settings-nav';
import { statusMessage, translator } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import {
  beginMfaEnrolmentAction,
  confirmMfaEnrolmentAction,
  disableMfaAction,
  regenerateRecoveryCodesAction,
  signOutOtherSessionsAction,
} from './actions';

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

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;
  const otpauth = typeof query['otpauth'] === 'string' ? query['otpauth'] : null;
  /*
   * SHOWN ONCE, AND THE PAGE SAYS SO. Only the hashes are stored, so this is
   * literally the only render in which these strings exist anywhere.
   */
  const issuedCodes = typeof query['codes'] === 'string' ? query['codes'].split(' ') : [];

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
            {mfaAvailable && !account.mfaEnabled && !otpauth && (
              <form action={beginMfaEnrolmentAction}>
                <input type="hidden" name="locale" value={locale} />
                <button type="submit" data-testid="mfa-begin" style={buttonStyle('primary')}>
                  {t('security.enrolStart')}
                </button>
              </form>
            )}

            {/* MID-ENROLMENT: the seed is on screen and nowhere else. */}
            {mfaAvailable && !account.mfaEnabled && otpauth && (
              <form
                action={confirmMfaEnrolmentAction}
                style={{ display: 'grid', gap: spacingTokens.md }}
              >
                <input type="hidden" name="locale" value={locale} />
                <p style={typographyTokens.bodySm}>{t('security.enrolScan')}</p>
                <p style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted }}>
                  {t('security.enrolUri')}
                </p>
                <code
                  data-testid="mfa-otpauth"
                  style={{
                    ...typographyTokens.caption,
                    wordBreak: 'break-all',
                    color: colorTokens.textMuted,
                  }}
                >
                  {otpauth}
                </code>
                <Field label={t('security.code')} htmlFor="enrol-code">
                  <input
                    className="bs-control"
                    id="enrol-code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    data-testid="mfa-code"
                    style={inputStyle()}
                  />
                </Field>
                <div>
                  <button type="submit" data-testid="mfa-confirm" style={buttonStyle('primary')}>
                    {t('security.confirm')}
                  </button>
                </div>
              </form>
            )}

            {/* ENROLLED: turning it off costs a working code. */}
            {account.mfaEnabled && (
              <form action={disableMfaAction} style={{ display: 'grid', gap: spacingTokens.md }}>
                <input type="hidden" name="locale" value={locale} />
                <p style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted }}>
                  {t('security.disableExplain')}
                </p>
                <Field label={t('security.code')} htmlFor="disable-code">
                  <input
                    className="bs-control"
                    id="disable-code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    data-testid="mfa-disable-code"
                    style={inputStyle()}
                  />
                </Field>
                <div>
                  <button type="submit" data-testid="mfa-disable" style={buttonStyle('neutral')}>
                    {t('security.disable')}
                  </button>
                </div>
              </form>
            )}
          </div>
        </Card>

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
                <div data-testid="recovery-codes">
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
