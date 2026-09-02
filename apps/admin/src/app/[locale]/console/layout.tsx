import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { AdminShell } from '../../../components/admin-shell';
import { currentEnvironment, getPlatformActor } from '../../../server/platform-context';

export const dynamic = 'force-dynamic';

/**
 * THE server-side gate for the entire Control Center.
 *
 * Every console page nests inside this layout, so no page can be reached
 * without a session that has passed MFA and carries an admin-capable role.
 * This is enforcement, not decoration: middleware and client routing are
 * conveniences, and neither is trusted (docs/SECURITY.md §4.5).
 */
export default async function ConsoleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const actor = await getPlatformActor().catch(() => null);
  if (!actor) redirect(`/${locale}/login`);

  return (
    <AdminShell
      locale={locale}
      actorEmail={actor.email}
      actorRole={actor.roleKey}
      permissionKeys={actor.permissionKeys}
      environment={currentEnvironment()}
    >
      {children}
    </AdminShell>
  );
}
