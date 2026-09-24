import Link from 'next/link';
import {
  colorTokens,
  motionTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
} from './tokens';

/**
 * URL-ADDRESSABLE TABS — the `Tabs` look, as navigation (Phase 6 final, D-277).
 *
 * `Tabs` switches panels that are already rendered, in client state. Several
 * redesigned screens need tabs that are ADDRESSES instead — Publishing's
 * Queue / Published / Failed / Accounts, a campaign's project-room tabs, the
 * Asset Library's views — so a tab can be linked to, bookmarked, reloaded and
 * reached from a notification. That is navigation, so it is a `nav` of links
 * with `aria-current`, not a `tablist` (which promises arrow-key panel
 * switching a server-rendered page does not do).
 *
 * THE SAME VISUAL TREATMENT AS `Tabs`, token for token: the muted track, the
 * raised white pill for the current tab with the pressed-purple label, the
 * caption-size count badge. No new visual language (CLAUDE.md §4.2 rule 5);
 * the reason for a second component is the semantics, recorded here.
 *
 * NOT `'use client'`: it renders on the server with the page.
 */
export interface LinkTab {
  readonly id: string;
  readonly href: string;
  readonly label: string;
  /** A real count, when the screen has one. Absent rather than zero-padded. */
  readonly badge?: string | undefined;
}

export function LinkTabs({
  label,
  tabs,
  currentId,
  testId,
}: {
  /** The navigation's accessible name. */
  readonly label: string;
  readonly tabs: readonly LinkTab[];
  readonly currentId: string;
  readonly testId?: string | undefined;
}) {
  return (
    <nav
      aria-label={label}
      data-testid={testId ?? 'link-tabs'}
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        gap: spacingTokens['3xs'],
        padding: spacingTokens['3xs'],
        borderRadius: radiusTokens.lg,
        background: colorTokens.surfaceMuted,
        maxInlineSize: '100%',
      }}
    >
      {tabs.map((tab) => {
        const current = tab.id === currentId;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={current ? 'page' : undefined}
            data-testid={`tab-${tab.id}`}
            className="bs-pressable"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: spacingTokens.xs,
              minBlockSize: '2.25rem',
              paddingInline: spacingTokens.md,
              borderRadius: radiusTokens.md,
              ...typographyTokens.bodySm,
              fontWeight: 600,
              textDecoration: 'none',
              // Current = the raised white pill AND `aria-current`: never colour alone.
              background: current ? colorTokens.surface : 'transparent',
              color: current ? colorTokens.brandPurplePressed : colorTokens.textSecondary,
              boxShadow: current ? shadowTokens.card : 'none',
              transition: `color ${motionTokens.fast} ${motionTokens.easeOut}`,
            }}
          >
            {tab.label}
            {tab.badge ? (
              <span
                style={{
                  paddingInline: spacingTokens.xs,
                  borderRadius: radiusTokens.full,
                  background: current
                    ? colorTokens.surfaceLavenderStrong
                    : colorTokens.surfaceSunken,
                  color: current ? colorTokens.brandPurplePressed : colorTokens.textSecondary,
                  ...typographyTokens.caption,
                }}
              >
                {tab.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
