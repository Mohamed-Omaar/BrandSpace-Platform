import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  colorTokens,
  layoutTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
} from './tokens';
import { BuildingIcon, CheckIcon, TagIcon } from './icons';
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
              /*
               * `.experience-icon { width: 38px; height: 38px; radius: 12px;
               *  background: linear-gradient(145deg,#eee5ff,#fff5b3) }` — a
               * pale lavender-to-cream tile, not a saturated purple one.
               */
              inlineSize: layoutTokens.railAvatar,
              blockSize: layoutTokens.railAvatar,
              flexShrink: 0,
              borderRadius: radiusTokens.control,
              background: 'linear-gradient(145deg, #EEE5FF, #FFF5B3)',
              color: colorTokens.textPrimary,
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
                // `.workspace-copy strong { font-size: 12px }` at weight 700.
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
                // `.workspace-copy small { font-size: 9px; margin-top: 2px }`.
                ...typographyTokens.caption,
                marginBlockStart: spacingTokens['3xs'],
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
 * THE BRAND CARD'S FACE — shared by the switcher's trigger and the single-brand
 * card, so the two can never drift into two looks for one fact.
 */
function brandCardContent(current: { readonly name: string; readonly caption: string }) {
  return (
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
          // The workspace card's tile, to the pixel. A different size here
          // would read as a different KIND of control.
          inlineSize: layoutTokens.railAvatar,
          blockSize: layoutTokens.railAvatar,
          flexShrink: 0,
          borderRadius: radiusTokens.control,
          background: 'linear-gradient(145deg, #EEE5FF, #FFF5B3)',
          color: colorTokens.textPrimary,
        }}
      >
        <TagIcon size={16} />
      </span>
      <span
        className="bs-rail-copy"
        style={{ display: 'grid', minInlineSize: 0, gap: '0.0625rem' }}
      >
        <span
          data-testid="active-brand"
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
          data-testid="active-brand-caption"
          style={{
            ...typographyTokens.caption,
            marginBlockStart: spacingTokens['3xs'],
            color: colorTokens.textMuted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {current.caption}
        </span>
      </span>
    </span>
  );
}

/**
 * ONE BRAND, NO MENU (Phase 6 final acceptance, D-302).
 *
 * A member who can reach exactly one brand has nothing to choose, and a
 * dropdown with one row asks them to learn a concept — "a brand is a thing you
 * select" — for no benefit. The same card, the same two lines, the same tile;
 * a link to the brand's profile where the member may read it, plain otherwise.
 * The selector returns, unchanged, the moment a second brand is reachable.
 */
export function BrandCard({
  label,
  current,
  href,
}: {
  readonly label: string;
  readonly current: { readonly name: string; readonly caption: string };
  readonly href?: string | undefined;
}) {
  const style = {
    display: 'flex',
    alignItems: 'center',
    gap: spacingTokens.sm,
    inlineSize: '100%',
    minInlineSize: 0,
    overflow: 'hidden',
    padding: layoutTokens.railCardPad,
    minBlockSize: '3.625rem',
    border: '1px solid transparent',
    borderRadius: radiusTokens.rail,
    background: colorTokens.surface,
    boxShadow: shadowTokens.rail,
    color: colorTokens.textPrimary,
    textDecoration: 'none',
    textAlign: 'start',
  } as const;
  return href ? (
    <Link
      href={href}
      aria-label={label}
      className="bs-pressable"
      data-testid="brand-card"
      style={style}
    >
      {brandCardContent(current)}
    </Link>
  ) : (
    <div aria-label={label} role="group" data-testid="brand-card" style={style}>
      {brandCardContent(current)}
    </div>
  );
}

/**
 * THE GLOBAL BRAND SELECTOR (D-190).
 *
 * IT IS THE WORKSPACE CARD'S SIBLING, NOT A SECOND NAVIGATION SYSTEM. Same
 * `DropdownMenu`, same `trigger="card"` surface, same avatar tile, same two
 * lines of copy, same tick-plus-`aria-current` marking. Nothing here is a new
 * visual language: the ONLY differences from `WorkspaceSwitcher` are the glyph
 * (a tag, because a brand is an identity applied to work) and the second line,
 * which says what the selection MEANS rather than repeating a role.
 *
 * WHY THE ITEMS ARE FORMS. The workspace switcher navigates, because switching
 * workspace rewrites the session the server already owns. A brand selection is
 * remembered in a cookie and a link cannot set one — so each option posts to a
 * server action, exactly as the profile card's sign-out does. The markup shape
 * is the one the rail already uses.
 *
 * THE AGGREGATE OPTION IS OFFERED ONLY WHERE IT MEANS SOMETHING. A page that
 * needs exactly one brand gets no "All Brands" row, because a control that sets
 * a state the page cannot act on is the dead control the fidelity contract
 * forbids.
 */
export interface BrandSwitcherOption {
  readonly id: string;
  readonly name: string;
  /** The second line: what this brand is, in the reader's language. */
  readonly caption?: string | undefined;
  readonly current?: boolean | undefined;
}

export function BrandSwitcher({
  label,
  current,
  options,
  action,
  hiddenFields,
  allOption,
  emptyLabel,
  manageHref,
  manageLabel,
}: {
  readonly label: string;
  /** The trigger's two lines: the selection, and what kind of selection it is. */
  readonly current: { readonly name: string; readonly caption: string };
  readonly options: readonly BrandSwitcherOption[];
  /** The server action each option posts to. */
  readonly action: (formData: FormData) => void | Promise<void>;
  /** Fields every option carries — the locale and the path to return to. */
  readonly hiddenFields: Readonly<Record<string, string>>;
  /** Rendered first when the route admits an aggregate. */
  readonly allOption?: { readonly label: string; readonly current: boolean } | undefined;
  /** Shown instead of options when this member can act on no brand. */
  readonly emptyLabel?: string | undefined;
  readonly manageHref?: string | undefined;
  readonly manageLabel?: string | undefined;
}) {
  const row = (
    value: string,
    name: string,
    caption: string | undefined,
    isCurrent: boolean,
    testId: string,
  ) => (
    <form action={action} key={value}>
      {Object.entries(hiddenFields).map(([field, fieldValue]) => (
        <input key={field} type="hidden" name={field} value={fieldValue} />
      ))}
      <input type="hidden" name="brandId" value={value} />
      <button
        type="submit"
        role="menuitem"
        data-testid={testId}
        // The current brand is marked by a tick AND `aria-current`, never by
        // colour alone — the rule the workspace switcher already follows.
        aria-current={isCurrent ? 'true' : undefined}
        style={{
          ...menuItemStyle(),
          background: isCurrent ? colorTokens.brandPurpleTint : 'transparent',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            color: isCurrent ? colorTokens.brandPurple : 'transparent',
          }}
        >
          <CheckIcon size={16} />
        </span>
        <span style={{ display: 'grid', minInlineSize: 0 }}>
          <span style={{ fontWeight: 600 }}>{name}</span>
          {caption ? (
            <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
              {caption}
            </span>
          ) : null}
        </span>
      </button>
    </form>
  );

  return (
    <DropdownMenu
      label={label}
      testId="brand-switcher"
      align="start"
      trigger="card"
      triggerContent={brandCardContent(current)}
    >
      {allOption
        ? row('all', allOption.label, undefined, allOption.current, 'brand-option-all')
        : null}
      {options.map((option) =>
        row(
          option.id,
          option.name,
          option.caption,
          option.current === true,
          `brand-option-${option.id}`,
        ),
      )}
      {options.length === 0 && emptyLabel ? (
        <p
          style={{
            ...menuItemStyle(),
            cursor: 'default',
            color: colorTokens.textMuted,
            margin: 0,
          }}
        >
          {emptyLabel}
        </p>
      ) : null}
      {manageHref && manageLabel ? (
        <a
          href={manageHref}
          role="menuitem"
          data-testid="manage-brand"
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
/**
 * The language action, as the full demo's `.language-button` renders it.
 *
 * `.ghost-button.language-button { width: 38px; padding: 0; background:
 *  var(--soft); border-radius: 12px; font-size: 10px; font-weight: 800 }` — a
 * 38px soft square carrying two letters, matching the icon buttons beside it.
 * It used to be an outlined pill, which is the only outlined control that was
 * left in the top bar and read as borrowed from a different system.
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
      title={targetLabel}
      data-testid="locale-switch"
      className="bs-control"
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        inlineSize: layoutTokens.iconButton,
        blockSize: layoutTokens.iconButton,
        flexShrink: 0,
        borderRadius: radiusTokens.control,
        border: '1px solid transparent',
        color: colorTokens.textPrimary,
        textDecoration: 'none',
        ...typographyTokens.button,
        textTransform: 'uppercase',
      }}
    >
      {targetLocale}
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

/**
 * THE PROFILE CARD at the foot of the rail (§8).
 *
 * `.profile-button { background: #fff; border-radius: 16px; padding: 8px;
 *  grid-template-columns: 38px minmax(0,1fr) 22px; gap: 8px }` with
 * `.profile-avatar { width: 38px; height: 38px; border-radius: 12px;
 *  background: linear-gradient(145deg, var(--purple), #5223b8); font-size: 10px;
 *  font-weight: 800 }` and a `•••` affordance.
 *
 * The `•••` is REAL: it opens a menu holding sign-out and anything else that
 * belongs to the signed-in person. A standalone sign-out row was the previous
 * shape, and it is visually unrelated to the demo — §8 rules it out by name.
 */
export function ProfileCard({
  label,
  name,
  nameTestId = 'profile-name',
  role,
  initials,
  children,
}: {
  /** The menu's accessible name — the card's copy can be hidden when collapsed. */
  readonly label: string;
  readonly name: string;
  /**
   * The test hook on the name line. The Control Center identifies the operator
   * here — the same element the old standalone identity row carried — so the
   * "who is signed in" assertion keeps pointing at the one place that answers
   * it, rather than at markup the demo does not have.
   */
  readonly nameTestId?: string;
  readonly role: string;
  readonly initials: string;
  /** Menu items: sign out, and whatever else belongs to the person. */
  readonly children: ReactNode;
}) {
  return (
    <DropdownMenu
      label={label}
      testId="profile-menu"
      align="start"
      trigger="card"
      placement="block-start"
      triggerContent={
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
              inlineSize: layoutTokens.railAvatar,
              blockSize: layoutTokens.railAvatar,
              flexShrink: 0,
              borderRadius: radiusTokens.control,
              background: `linear-gradient(145deg, ${colorTokens.brandPurple}, #5223B8)`,
              color: colorTokens.brandPurpleInk,
              fontSize: '0.625rem',
              fontWeight: 800,
            }}
          >
            {initials}
          </span>
          <span className="bs-rail-copy" style={{ display: 'grid', minInlineSize: 0 }}>
            <span
              data-testid={nameTestId}
              style={{
                ...typographyTokens.label,
                color: colorTokens.textPrimary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {name}
            </span>
            <span
              data-testid="profile-role"
              style={{
                ...typographyTokens.caption,
                marginBlockStart: spacingTokens['3xs'],
                color: colorTokens.textMuted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {role}
            </span>
          </span>
        </span>
      }
    >
      {children}
    </DropdownMenu>
  );
}
