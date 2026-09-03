import { redirect } from 'next/navigation';
import { notFound } from 'next/navigation';
import { isSupportedLocale } from '@brandspace/ui';

export const dynamic = 'force-dynamic';

/**
 * The dashboard root.
 *
 * From Phase 2B the customer application is session-gated, so the root is not a
 * page: it hands off to the workspace home, which redirects to sign-in when
 * there is no session. Exactly the shape the Control Center took in Phase 2A.
 */
export default async function DashboardRoot({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  redirect(`/${locale}/overview`);
}
