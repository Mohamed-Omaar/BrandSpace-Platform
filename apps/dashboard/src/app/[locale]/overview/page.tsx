import Link from 'next/link';
import { AppShell } from '../../../components/app-shell';

export default async function SecondPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const isArabic = locale === 'ar';
  return (
    <AppShell
      locale={locale}
      heading={isArabic ? 'نظرة عامة' : 'Overview'}
      description={isArabic ? 'صفحة تحقق ثابتة.' : 'A deterministic verification page.'}
    >
      <Link href={`/${locale}`} data-testid="back-link">
        {isArabic ? 'رجوع' : 'Back'}
      </Link>
    </AppShell>
  );
}
