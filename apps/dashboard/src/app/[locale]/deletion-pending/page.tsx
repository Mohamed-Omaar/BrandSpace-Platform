import Link from 'next/link';
import { buttonStyle, colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { holdsPermission } from '../../../server/customer-context';
import { pendingDeletionSession } from '../../../server/pending-deletion';
import { statusMessage, translator } from '../../../i18n/messages';
import { AuthCard } from '../../../components/auth-card';
import { signOutAction } from '../(auth)/actions';
import { cancelWorkspaceDeletionAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * "SCHEDULED FOR DELETION" (A8, D-328).
 *
 * The only screen a workspace pending deletion shows anybody: which workspace,
 * and the date it will be deleted. An owner (`workspace.delete`) can cancel
 * here; every other member is told who can. Nothing of the workspace's data is
 * read or shown — the workspace is closed while it waits.
 *
 * DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): the `AuthCard` the workspace
 * chooser and the no-workspace screen already use, with the same buttons.
 */
export default async function DeletionPendingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { workspace } = await pendingDeletionSession(locale);
  const mayCancel = holdsPermission(workspace, 'workspace.delete');
  const date = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(workspace.deletionScheduledFor);
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  return (
    <AuthCard locale={locale} heading={t('deletion.title')}>
      <div data-testid="deletion-pending" style={{ display: 'grid', gap: spacingTokens.md }}>
        {error ? (
          <p role="alert" style={{ color: colorTokens.danger, margin: 0 }}>
            {statusMessage(error, locale, ref)}
          </p>
        ) : null}
        <p style={{ ...typographyTokens.body, margin: 0 }} data-testid="deletion-pending-date">
          {t('deletion.body')
            .replace('{workspace}', workspace.workspaceName)
            .replace('{date}', date)}
        </p>
        {mayCancel ? (
          <form action={cancelWorkspaceDeletionAction}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" style={buttonStyle('primary')} data-testid="deletion-cancel">
              {t('deletion.cancel')}
            </button>
          </form>
        ) : (
          <p
            style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary, margin: 0 }}
            data-testid="deletion-ask-owner"
          >
            {t('deletion.askOwner')}
          </p>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm }}>
          <Link href={`/${locale}/workspaces`} style={buttonStyle('ghost', 'sm')}>
            {t('deletion.otherWorkspace')}
          </Link>
          <form action={signOutAction}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" style={buttonStyle('ghost', 'sm')} data-testid="sign-out">
              {t('nav.signOut')}
            </button>
          </form>
        </div>
      </div>
    </AuthCard>
  );
}
