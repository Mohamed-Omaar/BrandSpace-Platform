'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  Button,
  buttonClass,
  buttonStyle,
  colorTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { translator } from '../../i18n/messages';
import { RouteState } from '../../components/route-state';

/**
 * A SCREEN THAT FAILED TO RENDER (Phase 6 final, D-277 §51, D-299).
 *
 * Next's default was an unstyled English page. This says, in the reader's
 * language, that the screen did not load and that NOTHING WAS CHANGED — a
 * render cannot have written anything — and offers Try again and Home. The
 * only detail shown is `digest`, the opaque reference Next assigns so support
 * can find the server log; never the message or the stack (CLAUDE.md §2.3).
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams<{ locale?: string }>();
  const locale = params?.locale === 'ar' ? 'ar' : 'en';
  const t = translator(locale);
  return (
    <RouteState
      kind="error"
      testId="route-error"
      title={t('errors.route.title')}
      description={t('errors.route.body')}
      action={
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: spacingTokens.xs }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => reset()}
            data-testid="route-error-retry"
          >
            {t('errors.route.retry')}
          </Button>
          <Link
            href={`/${locale}/overview`}
            className={buttonClass('neutral')}
            style={buttonStyle('neutral', 'sm')}
            data-testid="route-error-home"
          >
            {t('errors.route.home')}
          </Link>
        </span>
      }
      footnote={
        error.digest ? (
          <p style={{ ...typographyTokens.caption, color: colorTokens.textMuted, margin: 0 }}>
            {t('errors.route.reference').replace('{ref}', error.digest)}
          </p>
        ) : null
      }
    />
  );
}
