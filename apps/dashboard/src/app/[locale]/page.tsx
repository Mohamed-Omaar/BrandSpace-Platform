import Link from 'next/link';
import { AppShell } from '../../components/app-shell';

/**
 * Phase 1 scaffold. Deliberately contains NO product features — it exists so the
 * E2E suite has a deterministic, offline page to assert direction, landmarks,
 * keyboard navigation and accessibility against.
 */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const isArabic = locale === 'ar';
  return (
    <AppShell
      locale={locale}
      heading={isArabic ? 'لوحة التحكم' : 'Dashboard'}
      description={
        isArabic
          ? 'المرحلة الأولى: الأساسات فقط. لا توجد ميزات منتج بعد.'
          : 'Phase 1: foundations only. No product features yet.'
      }
    >
      <p data-testid="phase-note">Customer application shell.</p>
      <Link href={`/${locale}/overview`} data-testid="primary-link">
        {isArabic ? 'نظرة عامة' : 'Overview'}
      </Link>
    </AppShell>
  );
}
