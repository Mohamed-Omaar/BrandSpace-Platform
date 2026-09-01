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
      heading={isArabic ? 'براندسبيس' : 'BrandSpace'}
      description={
        isArabic
          ? 'المرحلة الأولى: الأساسات فقط. لا توجد ميزات منتج بعد.'
          : 'Phase 1: foundations only. No product features yet.'
      }
    >
      <p data-testid="phase-note">Public website shell.</p>
      <Link href={`/${locale}/status`} data-testid="primary-link">
        {isArabic ? 'الحالة' : 'Status'}
      </Link>
    </AppShell>
  );
}
