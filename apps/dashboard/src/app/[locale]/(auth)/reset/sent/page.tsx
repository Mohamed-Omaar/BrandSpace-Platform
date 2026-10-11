import Link from 'next/link';
import { translator } from '../../../../../i18n/messages';
import { AuthCard } from '../../../../../components/auth-card';

export const dynamic = 'force-dynamic';

/**
 * PR D (Auth 5) — "THE LINK IS ON ITS WAY" (`Auth.dc.html` lines 81–87).
 *
 * The screen after "Send me a link". It used to land on sign-in with a banner.
 * The words are the same for every address — registered or not — so this
 * screen confirms nothing about which accounts exist (§10), exactly as the
 * banner did. The prototype's "I opened the link" button is left out: the
 * link in the email is what opens the next screen, and a button here would
 * lead nowhere.
 */
export default async function ResetSentPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = translator(locale);
  return (
    <AuthCard
      locale={locale}
      eyebrow={t('auth.eyebrow.password')}
      heading={t('reset.sentTitle')}
      footer={
        <Link href={`/${locale}/sign-in`} data-testid="reset-back">
          <span aria-hidden="true">{locale === 'ar' ? '→' : '←'}</span> {t('reset.backToSignIn')}
        </Link>
      }
    >
      <p className="bsp-auth-sent" role="status" data-testid="reset-sent">
        {t('reset.sentBody')}
      </p>
    </AuthCard>
  );
}
