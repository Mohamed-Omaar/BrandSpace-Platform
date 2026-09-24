import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AdminShell } from '../../../components/admin-shell';
import {
  currentEnvironment,
  getPlatformActor,
  getSupportModeService,
} from '../../../server/platform-context';
import { SUPPORT_COOKIE } from '../../../server/support-cookie';
import { getConsoleMode } from '../../../server/console-mode-cookie';

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

  // The Support Mode banner is rendered from the RESOLVED grant, not from the
  // cookie: an expired or ended session shows no banner, so the badge can never
  // claim an access that no longer exists (docs/SECURITY.md §8).
  const store = await cookies();
  const supportSessionId = store.get(SUPPORT_COOKIE)?.value;
  const supportGrant = supportSessionId
    ? await getSupportModeService()
        .resolve(supportSessionId, actor.platformUserId)
        .catch(() => null)
    : null;

  return (
    <AdminShell
      locale={locale}
      actorEmail={actor.email}
      actorRole={actor.roleKey}
      permissionKeys={actor.permissionKeys}
      environment={currentEnvironment()}
      // Presentation only (D-307). Read AFTER the actor is resolved and never
      // passed to anything that authorizes.
      mode={await getConsoleMode()}
      support={
        supportGrant
          ? {
              workspaceName: supportGrant.workspaceName,
              reason: supportGrant.reason,
              remainingMinutes: Math.floor(supportGrant.remainingSeconds / 60),
            }
          : null
      }
    >
      {children}
    </AdminShell>
  );
}
