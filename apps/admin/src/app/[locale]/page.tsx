import { redirect } from 'next/navigation';
import { getPlatformActor } from '../../server/platform-context';

/**
 * Entry point. Server-side redirect based on the real session — a browser that
 * simply navigates to /console still hits the console layout's own guard.
 */
export default async function AdminRoot({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const actor = await getPlatformActor().catch(() => null);
  redirect(actor ? `/${locale}/console` : `/${locale}/login`);
}
