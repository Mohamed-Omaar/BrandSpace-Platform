import { translator } from '../../../i18n/messages';
import { AuthCard } from '../../../components/auth-card';
import { signOutAction } from '../(auth)/actions';

export const dynamic = 'force-dynamic';

/**
 * The authenticated-but-workspaceless state.
 *
 * Reached when every workspace the member belongs to is suspended, archived or
 * cancelled, or when the last membership was removed. It is a legitimate state,
 * not an error, so it says what happened and offers the one action that helps.
 */
export default async function NoWorkspacePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = translator(locale);

  return (
    <AuthCard locale={locale} heading={t('ws.select')}>
      <p data-testid="no-workspace">{t('ws.none')}</p>
      <p data-testid="workspace-suspended-hint">{t('ws.suspended')}</p>
      <form action={signOutAction}>
        <input type="hidden" name="locale" value={locale} />
        <button type="submit" data-testid="sign-out" style={{ minBlockSize: '40px' }}>
          {t('nav.signOut')}
        </button>
      </form>
    </AuthCard>
  );
}
