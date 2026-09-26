import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SignupService } from '@brandspace/auth';
import { getPrisma, withoutTenantContext } from '@brandspace/database';
import { TenantOnboardingPolicySource } from '@brandspace/onboarding';
import { Banner } from '@brandspace/ui';
import {
  currentEnvironment,
  getCustomerAuth,
  getSessionToken,
  requireCustomer,
} from '../../../server/customer-context';
import { statusMessage, translator } from '../../../i18n/messages';
import { AuthCard, authButtonStyle } from '../../../components/auth-card';
import { MfaEnrolmentPanel } from '../../../components/mfa-enrolment';
import { beginMfaEnrolmentAction, confirmMfaEnrolmentAction } from '../settings/security/actions';

export const dynamic = 'force-dynamic';

/**
 * TWO-STEP VERIFICATION, REQUIRED BY THE WORKSPACE (G4 / Q23, prototype v94
 * Phase 2B-1, D-333).
 *
 * Where `requireWorkspace` sends a member whose workspace requires two-step
 * and who has not turned it on — before any page of the workspace is shown or
 * any action runs. It needs only a signed-in person, never the workspace, so
 * it cannot loop back into the gate that sent them here. Setting it up takes
 * them to Settings → Security, where the recovery codes are shown once.
 *
 * DESIGN-SYSTEM EXTENSION: the sign-in card (`AuthCard`) and the shared
 * enrolment panel — nothing new.
 */
export default async function MfaSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const customer = await requireCustomer(locale);
  if (customer.mfaEnabled) redirect(`/${locale}/overview`);

  const workspaces = await getCustomerAuth()
    .listWorkspaces((await getSessionToken()) ?? '', {
      includePendingDeletion: true,
      includeMfaRequired: true,
    })
    .catch(() => []);
  const requiring = workspaces.find(
    (workspace) => workspace.workspaceId === customer.activeWorkspaceId && workspace.requireMfa,
  );
  // Nothing requires it (any more): there is nothing to do here.
  if (!requiring) redirect(`/${locale}/overview`);

  const policy = await withoutTenantContext(
    async (db) => new TenantOnboardingPolicySource(db, currentEnvironment()).load(),
    { prisma: getPrisma() },
  );
  const pending = await new SignupService({
    prisma: getPrisma(),
    // Nothing on this page sends mail; both are required by the constructor.
    email: { key: 'unused', send: async () => ({ messageId: '' }) },
    verificationLink: () => '',
  }).pendingEnrolment(customer.userId);

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  return (
    <AuthCard
      locale={locale}
      heading={t('mfaSetup.title')}
      description={t('mfaSetup.body').replace('{workspace}', requiring.workspaceName)}
    >
      {error ? (
        <div role="alert" data-testid="mfa-setup-error">
          <Banner tone="error">{statusMessage(error, locale, ref)}</Banner>
        </div>
      ) : null}
      {!policy.mfa.customerEnrolmentEnabled ? (
        <Banner tone="warning">{t('security.unavailable')}</Banner>
      ) : pending ? (
        <MfaEnrolmentPanel
          locale={locale}
          otpauthUri={pending.otpauthUri}
          secret={pending.secret}
          action={confirmMfaEnrolmentAction}
          from="setup"
          labels={{
            scan: t('security.enrolScan'),
            qrAlt: t('security.qrAlt'),
            typeKey: t('security.typeKey'),
            code: t('security.code'),
            confirm: t('security.confirm'),
          }}
          testId="mfa-setup"
        />
      ) : (
        <form action={beginMfaEnrolmentAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="from" value="setup" />
          <button type="submit" data-testid="mfa-setup-begin" style={authButtonStyle()}>
            {t('mfaSetup.start')}
          </button>
        </form>
      )}
      {workspaces.length > 1 ? (
        <Link href={`/${locale}/workspaces`} data-testid="mfa-setup-other">
          {t('mfaSetup.other')}
        </Link>
      ) : null}
    </AuthCard>
  );
}
