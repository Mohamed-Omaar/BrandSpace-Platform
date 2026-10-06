import Link from 'next/link';
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
import { SettingsFrame } from '../../../../components/settings-frame';
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
  const { customer, workspace, messageLocale } = await requireWorkspace(locale);
  const t = translator(messageLocale);

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
      heading={t('nav.settings')}
      description={t('settings.p.subtitle')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.name ?? customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      {ok && statusMessage(ok, locale) && (
        <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner>
      )}

      <SettingsFrame
        brandSource={workspace}
        locale={locale}
        permissionKeys={workspace.permissionKeys}
        selected="security"
      >
        {/*
          ROUND 4, GATE 2b — THE PROTOTYPE'S SECURITY SECTION (`Main.dc.html`
          lines 1465–1472): ONE card of compact rows — two-step sign-in with its
          state and action, the backup codes, "require it for everyone", other
          devices, the activity log — and each flow opening as an inset panel
          under its row (`margin: 0 18px 14px; padding: 14px 16px;
          border-radius: 16px`). Every form, action, permission and test id is
          the product's own, unchanged.
        */}
        <section className="bsp-card bsp-secu">
          <div className="bsp-secu-block" data-testid="mfa-card">
            <div className="bsp-row bsp-secu-row">
              <span className="bsp-secu-text">
                <span className="bsp-secu-t">{t('security.mfaHeading')}</span>
                <span className="bsp-secu-s">{t('security.mfaExplain')}</span>
              </span>
              <span
                className={account.mfaEnabled ? 'bsp-pill bsp-p-ok' : 'bsp-pill bsp-p-neu'}
                data-testid="mfa-state"
              >
                {account.mfaEnabled ? t('security.mfaOn') : t('security.mfaOff')}
              </span>
              {/* NOT ENROLLED, AND ENROLMENT NOT YET STARTED. */}
              {mfaAvailable && !account.mfaEnabled && !pending ? (
                <form action={beginMfaEnrolmentAction}>
                  <input type="hidden" name="locale" value={locale} />
                  <button type="submit" data-testid="mfa-begin" className="bsp-btn bsp-sm bsp-pur">
                    {t('security.enrolStart')}
                  </button>
                </form>
              ) : null}
            </div>

            {!mfaAvailable ? (
              <p className="bsp-secu-panel bsp-secu-note">{t('security.unavailable')}</p>
            ) : null}

            {/* MID-ENROLMENT: a QR code and the typed key, drawn from the server. */}
            {mfaAvailable && !account.mfaEnabled && pending ? (
              <div className="bsp-secu-panel bsp-secu-setup">
                <MfaEnrolmentPanel
                  locale={locale}
                  otpauthUri={pending.otpauthUri}
                  secret={pending.secret}
                  action={confirmMfaEnrolmentAction}
                  from="security"
                  labels={enrolmentLabels}
                />
              </div>
            ) : null}

            {/* ENROLLED, A NEW PHONE BEING SET UP: the old one works until this one proves itself. */}
            {account.mfaEnabled && pending ? (
              <div className="bsp-secu-panel bsp-secu-setup">
                <b className="bsp-secu-pt">{t('security.newPhoneHeading')}</b>
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
                    className="bsp-btn bsp-sm bsp-ghost"
                  >
                    {t('common.cancel')}
                  </button>
                </form>
              </div>
            ) : null}

            {/* ENROLLED: "New phone" costs a current code. */}
            {mfaAvailable && account.mfaEnabled && !pending ? (
              <form action={beginNewPhoneAction} className="bsp-secu-panel bsp-secu-inline">
                <input type="hidden" name="locale" value={locale} />
                <span className="bsp-secu-s">{t('security.newPhoneExplain')}</span>
                <span className="bsp-secu-fields">
                  <input
                    className="bs-control bsp-secu-in"
                    id="new-phone-code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    placeholder={t('security.code')}
                    aria-label={t('security.code')}
                    data-testid="mfa-new-phone-code"
                  />
                  <button
                    type="submit"
                    data-testid="mfa-new-phone-begin"
                    className="bsp-btn bsp-sm bsp-sec"
                  >
                    {t('security.newPhone')}
                  </button>
                </span>
              </form>
            ) : null}

            {/* ENROLLED AND REQUIRED: it cannot be turned off, and the page says why. */}
            {account.mfaEnabled && requiredBy ? (
              <p className="bsp-secu-panel bsp-secu-note" data-testid="mfa-required-note">
                {t('security.requiredCannotDisable').replace(
                  '{workspace}',
                  requiredBy.workspaceName,
                )}
              </p>
            ) : null}

            {/* ENROLLED: turning it off costs a current code OR the password. */}
            {account.mfaEnabled && !requiredBy ? (
              <form action={disableMfaAction} className="bsp-secu-panel bsp-secu-off">
                <input type="hidden" name="locale" value={locale} />
                <span className="bsp-secu-s">{t('security.disableExplain')}</span>
                <span className="bsp-secu-fields">
                  <input
                    className="bs-control bsp-secu-in"
                    id="disable-code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder={t('security.code')}
                    aria-label={t('security.code')}
                    data-testid="mfa-disable-code"
                  />
                  <input
                    className="bs-control bsp-secu-in"
                    id="disable-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    placeholder={t('security.orPassword')}
                    aria-label={t('security.orPassword')}
                    data-testid="mfa-disable-password"
                  />
                  <button
                    type="submit"
                    data-testid="mfa-disable"
                    className="bsp-btn bsp-sm bsp-sec"
                  >
                    {t('security.disable')}
                  </button>
                </span>
              </form>
            ) : null}
          </div>

          {/* THE CODES, SHOWN ONCE, and the backup-codes row. */}
          {account.mfaEnabled || issuedCodes.length > 0 ? (
            <div className="bsp-secu-block" data-testid="recovery-card">
              <div className="bsp-row bsp-secu-row">
                <span className="bsp-secu-text">
                  <span className="bsp-secu-t bsp-sm">{t('security.recoveryHeading')}</span>
                  <span className="bsp-secu-s">
                    {account.mfaEnabled ? (
                      <span data-testid="recovery-remaining">
                        {t('security.recoveryRemaining')}: {remainingCodes}
                      </span>
                    ) : (
                      t('security.recoveryExplain')
                    )}
                  </span>
                </span>
              </div>
              {issuedCodes.length > 0 ? (
                <div className="bsp-secu-panel bsp-secu-codes" data-testid="recovery-codes">
                  <b className="bsp-secu-pt">{t('security.recoveryOnce')}</b>
                  <span className="bsp-secu-s">{t('security.recoveryExplain')}</span>
                  <ul className="bsp-secu-code-grid">
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
                      className="bsp-btn bsp-sm bsp-sec"
                    >
                      {t('security.recoverySaved')}
                    </button>
                  </form>
                </div>
              ) : null}
              {account.mfaEnabled ? (
                <form
                  action={regenerateRecoveryCodesAction}
                  className="bsp-secu-panel bsp-secu-inline"
                >
                  <input type="hidden" name="locale" value={locale} />
                  <span className="bsp-secu-s">{t('security.recoveryRegenerateExplain')}</span>
                  <span className="bsp-secu-fields">
                    <input
                      className="bs-control bsp-secu-in"
                      id="regen-code"
                      name="code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      required
                      placeholder={t('security.code')}
                      aria-label={t('security.code')}
                      data-testid="recovery-regen-code"
                    />
                    <button
                      type="submit"
                      data-testid="recovery-regenerate"
                      className="bsp-btn bsp-sm bsp-sec"
                    >
                      {t('security.recoveryRegenerate')}
                    </button>
                  </span>
                </form>
              ) : null}
            </div>
          ) : null}

          {/*
            G4 / Q23 (D-333) — THE OWNER REQUIRES IT FOR EVERYONE. Offered only
            with `workspace.security.manage` (the Owner); the action checks it
            again and refuses to turn it on before the Owner's own is on.
          */}
          {mayRequire ? (
            <form
              action={setWorkspaceMfaRequirementAction}
              className="bsp-secu-block bsp-secu-req"
              data-testid="mfa-requirement-card"
            >
              <input type="hidden" name="locale" value={locale} />
              <CheckboxRow
                name="requireMfa"
                label={t('security.requireLabel').replace('{workspace}', workspace.workspaceName)}
                hint={t('security.requireHint')}
                checked={workspace.requireMfa === true}
                testId="mfa-require"
              />
              <button
                type="submit"
                data-testid="mfa-require-save"
                className="bsp-btn bsp-sm bsp-sec bsp-secu-req-save"
              >
                {t('common.save')}
              </button>
            </form>
          ) : null}

          <form
            action={signOutOtherSessionsAction}
            className="bsp-row bsp-secu-row"
            data-testid="sessions-card"
          >
            <input type="hidden" name="locale" value={locale} />
            <span className="bsp-secu-text">
              <span className="bsp-secu-t">{t('security.sessionsHeading')}</span>
              <span className="bsp-secu-s">{t('security.sessionsExplain')}</span>
            </span>
            <button type="submit" data-testid="sessions-revoke" className="bsp-btn bsp-sm bsp-sec">
              {t('security.signOutOthers')}
            </button>
          </form>

          <div className="bsp-row bsp-secu-row" data-testid="security-activity">
            <span className="bsp-secu-t bsp-secu-grow">{t('security.activityLog')}</span>
            <Link href={`/${locale}/activity`} className="bsp-btn bsp-sm bsp-ghost">
              {t('data.open')}
            </Link>
          </div>
        </section>
      </SettingsFrame>
    </WorkspaceShell>
  );
}
