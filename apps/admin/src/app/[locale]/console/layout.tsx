import type { ReactNode } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { Banner } from '@brandspace/ui';
import { redirect } from 'next/navigation';
import { AdminShell } from '../../../components/admin-shell';
import {
  currentEnvironment,
  getConfigService,
  getPlatformActor,
  getSupportModeService,
} from '../../../server/platform-context';
import { publishingGaps, type PublishingProviderShape } from '../../../server/publishing-readiness';
import { translator } from '../../../i18n/messages';
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

  /*
   * Round 6 (D-481, item d) — PUBLISHING LEFT AT ITS DEFAULTS IS SAID ON EVERY
   * PAGE, to anyone who may read configuration, until it is configured: a new
   * environment cannot ship with customers limited to text posts unnoticed.
   */
  const t = translator(locale);
  const gaps = actor.permissionKeys.includes('platform.configuration.read')
    ? await getConfigService()
        .get('publishing', currentEnvironment())
        .then((publishing) =>
          publishingGaps(
            publishing.providers as unknown as Record<string, PublishingProviderShape | undefined>,
          ),
        )
        .catch(() => null)
    : null;
  const publishingWarning =
    gaps && (gaps.textOnly || gaps.noneEnabled) ? (
      <Banner tone="warning" testId="publishing-not-configured">
        <span>
          {gaps.textOnly ? <strong>{t('console.publishing.textOnly')}</strong> : null}
          {gaps.textOnly && gaps.noneEnabled ? ' ' : null}
          {gaps.noneEnabled ? t('console.publishing.noneEnabled') : null}{' '}
          <Link
            href={`/${locale}/console/configuration?domain=publishing`}
            data-testid="publishing-not-configured-fix"
          >
            {t('console.publishing.fix')}
          </Link>
        </span>
      </Banner>
    ) : null;

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
      {publishingWarning}
      {children}
    </AdminShell>
  );
}
