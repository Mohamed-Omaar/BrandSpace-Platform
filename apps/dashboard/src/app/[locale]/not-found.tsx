'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { buttonClass, buttonStyle } from '@brandspace/ui';
import { translator } from '../../i18n/messages';
import { RouteState } from '../../components/route-state';

/**
 * NOT FOUND — ONE SHAPE FOR EVERY MISS (Phase 6 final, D-277 §51, D-299).
 *
 * A page that does not exist, a record in another workspace and a screen this
 * member's role may not open all answer `notFound()`, and all of them render
 * THIS, identically — so the page cannot tell one from another (CLAUDE.md
 * §2.1). It says so in the reader's language and offers Home.
 *
 * The one exception is a page on the known navigation list, which every member
 * can see listed: it answers "No access to this page" instead (D-322, Q5 —
 * `NoAccessPage`). Records inside those pages still come here.
 */
export default function NotFound() {
  const params = useParams<{ locale?: string }>();
  const locale = params?.locale === 'ar' ? 'ar' : 'en';
  const t = translator(locale);
  return (
    <RouteState
      kind="empty"
      testId="route-not-found"
      title={t('errors.notFound.title')}
      description={t('errors.notFound.body')}
      action={
        <Link
          href={`/${locale}/overview`}
          className={buttonClass('brand')}
          style={buttonStyle('brand', 'sm')}
          data-testid="route-not-found-home"
        >
          {t('errors.route.home')}
        </Link>
      }
    />
  );
}
