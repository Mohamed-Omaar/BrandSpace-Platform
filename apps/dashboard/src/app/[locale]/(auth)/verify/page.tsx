import Link from 'next/link';
import { colorTokens } from '@brandspace/ui';
import { getPrisma } from '@brandspace/database';
import { OutboxEmailProvider, SignupService } from '@brandspace/auth';
import { translator } from '../../../../i18n/messages';
import { AuthCard } from '../../../../components/auth-card';

export const dynamic = 'force-dynamic';

/**
 * Following the verification link.
 *
 * THE TOKEN IS CONSUMED HERE, once. A second visit — a refresh, a forwarded
 * link, a mail client that prefetches — finds it used and says the link is no
 * longer valid, which is exactly what it says for an expired or invented one.
 * The three cases are deliberately indistinguishable (§10).
 *
 * WHY A PAGE RATHER THAN AN ACTION. The link arrives from an inbox as a GET, so
 * the page IS the request. The consumption is a conditional UPDATE, so two
 * simultaneous loads race and exactly one wins.
 */
export default async function VerifyPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = translator(locale);
  const query = await searchParams;
  const token = typeof query['token'] === 'string' ? query['token'] : '';

  const prisma = getPrisma();
  const service = new SignupService({
    prisma,
    email: new OutboxEmailProvider(prisma),
    // Never used on this path; verification does not send mail. Supplied
    // because the constructor requires one, and a throwing stub would be a trap
    // for the next person who adds a send here.
    verificationLink: (value) => `/${locale}/verify?token=${encodeURIComponent(value)}`,
  });

  const result = token ? await service.verifyEmail(token).catch(() => null) : null;

  return (
    <AuthCard locale={locale} heading={t('verify.title')}>
      {result ? (
        <>
          <p data-testid="verify-success">{t('verify.doneTitle')}</p>
          <p>{t('verify.doneBody')}</p>
        </>
      ) : (
        <>
          <p data-testid="verify-failed">{t('verify.failedTitle')}</p>
          <p>{t('verify.failedBody')}</p>
        </>
      )}
      <Link href={`/${locale}/sign-in`} style={{ color: colorTokens.brandPurple }}>
        {t('verify.signIn')}
      </Link>
    </AuthCard>
  );
}
