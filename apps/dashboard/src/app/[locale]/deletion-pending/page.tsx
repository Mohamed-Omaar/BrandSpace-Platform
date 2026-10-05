import Link from 'next/link';
import { colorTokens, spacingTokens, typographyTokens, buttonClass } from '@brandspace/ui';
import { holdsPermission, inWorkspace } from '../../../server/customer-context';
import { deletionRequestDetails } from '../../../server/deletion-request-details';
import { pendingDeletionSession } from '../../../server/pending-deletion';
import { statusMessage, translator } from '../../../i18n/messages';
import { AuthCard } from '../../../components/auth-card';
import { signOutAction } from '../(auth)/actions';
import { cancelWorkspaceDeletionAction } from './actions';
import { dayFormatter } from '../../../server/prototype-dates';

export const dynamic = 'force-dynamic';

/**
 * "SCHEDULED FOR DELETION" (A8, D-328).
 *
 * The only screen a workspace pending deletion shows anybody: which workspace,
 * the date it will be deleted, and who asked for it and when (review item 9). An owner (`workspace.delete`) can cancel
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
  const { workspace, messageLocale } = await pendingDeletionSession(locale);
  const t = translator(messageLocale);
  const mayCancel = holdsPermission(workspace, 'workspace.delete');
  const format = dayFormatter(locale, 'UTC');
  const date = format.format(workspace.deletionScheduledFor);
  // Review item 9: who asked, and when — read in the workspace's own context.
  const request = await inWorkspace(workspace.workspaceId, ({ db }) =>
    deletionRequestDetails(db, workspace.workspaceId),
  );
  const requestedOn = request.requestedAt ? format.format(request.requestedAt) : null;
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
        {requestedOn ? (
          <p
            style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary, margin: 0 }}
            data-testid="deletion-requested"
          >
            {(request.requestedByName ? t('deletion.requestedBy') : t('deletion.requestedOn'))
              .replace('{name}', request.requestedByName ?? '')
              .replace('{date}', requestedOn)}
          </p>
        ) : null}
        {mayCancel ? (
          <form action={cancelWorkspaceDeletionAction}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" className={buttonClass('primary')} data-testid="deletion-cancel">
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
          <Link href={`/${locale}/workspaces`} className={buttonClass('ghost', 'sm')}>
            {t('deletion.otherWorkspace')}
          </Link>
          <form action={signOutAction}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" className={buttonClass('ghost', 'sm')} data-testid="sign-out">
              {t('nav.signOut')}
            </button>
          </form>
        </div>
      </div>
    </AuthCard>
  );
}
