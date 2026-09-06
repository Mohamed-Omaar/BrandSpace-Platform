import Link from 'next/link';
import { colorTokens, layoutTokens, radiusTokens, spacingTokens, typographyTokens } from './tokens';
import { BuildingIcon, CheckIcon, GlobeIcon } from './icons';
import { DropdownMenu } from './overlays';
import { menuItemStyle } from './menu-style';

/**
 * Workspace and language switchers.
 *
 * BOTH ARE LINKS, NOT CLIENT STATE. Switching a workspace is a server action
 * that re-verifies membership and rewrites the session; switching a language
 * changes the URL, because `dir` and `lang` are routing properties in this
 * product rather than a stored preference. Neither switcher decides anything —
 * it navigates, and the server decides.
 */

export interface WorkspaceOption {
  readonly id: string;
  readonly name: string;
  readonly roleName: string;
  readonly href: string;
  readonly current?: boolean;
}

export function WorkspaceSwitcher({
  label,
  current,
  options,
  manageHref,
  manageLabel,
  manageTestId,
}: {
  readonly label: string;
  readonly current: { readonly name: string; readonly roleName: string };
  readonly options: readonly WorkspaceOption[];
  readonly manageHref?: string | undefined;
  readonly manageLabel?: string | undefined;
  readonly manageTestId?: string | undefined;
}) {
  return (
    <DropdownMenu
      label={label}
      testId="workspace-switcher"
      align="start"
      trigger="card"
      triggerContent={
        // THE SIDEBAR CARD (D-59): an avatar, the workspace name, the role
        // beneath it. Two lines rather than one run-on chip, because the role
        // is a different fact from the workspace and reading them as one
        // sentence is how people end up in the wrong tenant.
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: spacingTokens.sm,
            minInlineSize: 0,
            flex: '1 1 auto',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-grid',
              placeItems: 'center',
              // `.workspace-avatar { width: 34px; height: 34px; radius: 11px;
              //  background: linear-gradient(145deg, purple, #a878ff) }` — the
              // one place in the rail the brand colour appears, and the reason
              // the switcher reads as an identity rather than another button.
              inlineSize: layoutTokens.railAvatar,
              blockSize: layoutTokens.railAvatar,
              flexShrink: 0,
              borderRadius: '0.6875rem',
              background: `linear-gradient(145deg, ${colorTokens.brandPurple}, #A878FF)`,
              color: colorTokens.brandPurpleInk,
            }}
          >
            <BuildingIcon size={16} />
          </span>
          <span
            className="bs-rail-copy"
            style={{ display: 'grid', minInlineSize: 0, gap: '0.0625rem' }}
          >
            <span
              data-testid="active-workspace"
              style={{
                ...typographyTokens.label,
                color: colorTokens.textPrimary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {current.name}
            </span>
            <span
              data-testid="active-role"
              style={{
                ...typographyTokens.caption,
                fontWeight: 500,
                color: colorTokens.textMuted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {current.roleName}
            </span>
          </span>
        </span>
      }
    >
      {options.map((option) => (
        <Link
          key={option.id}
          href={option.href}
          role="menuitem"
          // The current workspace is marked by a tick AND `aria-current`, never
          // by colour alone.
          aria-current={option.current ? 'true' : undefined}
          style={{
            ...menuItemStyle(),
            background: option.current ? colorTokens.brandPurpleTint : 'transparent',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              color: option.current ? colorTokens.brandPurple : 'transparent',
            }}
          >
            <CheckIcon size={16} />
          </span>
          <span style={{ display: 'grid', minInlineSize: 0 }}>
            <span style={{ fontWeight: 600 }}>{option.name}</span>
            <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
              {option.roleName}
            </span>
          </span>
        </Link>
      ))}
      {manageHref && manageLabel ? (
        <a
          href={manageHref}
          role="menuitem"
          data-testid={manageTestId}
          style={{ ...menuItemStyle(), color: colorTokens.brandPurple }}
        >
          {manageLabel}
        </a>
      ) : null}
    </DropdownMenu>
  );
}

/**
 * Language switcher.
 *
 * A real link with `hreflang` and the target language written IN that language
 * — "العربية", not "Arabic" — so a reader who cannot read the current interface
 * can still find their own.
 */
export function LanguageSwitcher({
  href,
  targetLocale,
  targetLabel,
  ariaLabel,
}: {
  readonly href: string;
  readonly targetLocale: string;
  readonly targetLabel: string;
  readonly ariaLabel: string;
}) {
  return (
    <a
      href={href}
      hrefLang={targetLocale}
      lang={targetLocale}
      aria-label={ariaLabel}
      data-testid="locale-switch"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: spacingTokens.xs,
        minBlockSize: '2.25rem',
        paddingInline: spacingTokens.sm,
        borderRadius: radiusTokens.md,
        border: `1px solid ${colorTokens.borderStrong}`,
        color: colorTokens.textPrimary,
        textDecoration: 'none',
        ...typographyTokens.caption,
        fontWeight: 600,
      }}
    >
      <GlobeIcon size={16} />
      {targetLabel}
    </a>
  );
}

/**
 * The Support Mode banner.
 *
 * PERSISTENT AND UNMISTAKABLE (docs/SECURITY.md §8, D-28). It is `position:
 * sticky` at the very top so it cannot be scrolled away, it uses the yellow
 * accent as a full-width surface with near-black ink — the one place a yellow
 * surface is correct, and it still never carries white text — and the copy says
 * in plain words that the reader is platform staff and NOT the customer.
 *
 * A support session must never look like a normal customer session. That is why
 * this is a band across the top rather than a discreet chip.
 */
export function SupportModeBanner({
  text,
  detail,
  testId,
}: {
  readonly text: string;
  readonly detail?: string | undefined;
  readonly testId?: string | undefined;
}) {
  return (
    <div
      role="status"
      data-testid={testId ?? 'support-mode-banner'}
      style={{
        position: 'sticky',
        insetBlockStart: 0,
        zIndex: 20,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacingTokens.sm,
        paddingInline: spacingTokens.md,
        paddingBlock: spacingTokens.sm,
        background: colorTokens.brandYellow,
        color: colorTokens.brandYellowInk,
        borderBlockEnd: `2px solid ${colorTokens.warning}`,
        ...typographyTokens.bodySm,
        fontWeight: 700,
        textAlign: 'center',
      }}
    >
      <span>{text}</span>
      {detail ? <span style={{ fontWeight: 500 }}>{detail}</span> : null}
    </div>
  );
}
