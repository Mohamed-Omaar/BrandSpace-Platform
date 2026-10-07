'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { DropdownMenu } from './overlays';
import { PrefetchLink } from './prefetch-link';
import { PrototypeIcon, type PrototypeGlyph } from './prototype-icons';

/**
 * THE RAIL'S CARDS, THE TOP BAR'S CONTROLS AND THE FLOATING COPILOT, PORTED
 * FROM `prototype-2026-09-27` (D-468). Their look is `prototype.css` alone
 * (`.bcard`, `.ucard`, `.ibtn`, `.btn.pur`, `.fab`, the glass menus); their
 * behaviour is the design system's — `DropdownMenu`'s menu-button keys,
 * focus return and outside-click dismissal, forms for anything the server
 * decides, links for anything that navigates.
 *
 * Every test hook the controls they replace carried is kept.
 */

/** The card's face: `.bcard` — the initial tile, the name, the caption, the chevron. */
function brandFace(current: { readonly name: string; readonly caption: string }) {
  const initial = Array.from(current.name.trim())[0]?.toUpperCase() ?? '';
  return (
    <>
      <span className="bsp-bcard-mark" aria-hidden="true">
        {initial}
      </span>
      <span className="bsp-bcard-copy bsp-nl bs-rail-copy">
        <span className="bsp-bcard-name" data-testid="active-brand">
          <bdi>{current.name}</bdi>
        </span>
        <span className="bsp-bcard-caption" data-testid="active-brand-caption">
          {current.caption}
        </span>
      </span>
    </>
  );
}

const chevron = (
  <span className="bsp-nl" aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0 }}>
    <PrototypeIcon glyph="down" size={16} stroke={2} />
  </span>
);

/** `.bmenu`: `top: 64px; inset-inline-start: 0; width: 240px; z-index: 25`. */
const BMENU = {
  top: 'var(--bsp-px-64)',
  insetInlineStart: 0,
  width: 'var(--bsp-px-240)',
  zIndex: 25,
} as const;

/** One brand and nothing to choose: the card, a link where the profile may be read. */
export function PrototypeBrandCard({
  label,
  current,
  href,
}: {
  readonly label: string;
  readonly current: { readonly name: string; readonly caption: string };
  readonly href?: string | undefined;
}) {
  return href ? (
    <Link href={href} aria-label={label} className="bsp-bcard" data-testid="brand-card">
      {brandFace(current)}
    </Link>
  ) : (
    <div aria-label={label} role="group" className="bsp-bcard" data-testid="brand-card">
      {brandFace(current)}
    </div>
  );
}

/** A menu row the server decides: a form posting to `action`. */
function formRow({
  action,
  hiddenFields,
  field,
  value,
  testId,
  current,
  name,
  caption,
  tile,
}: {
  readonly action: (formData: FormData) => void | Promise<void>;
  readonly hiddenFields: Readonly<Record<string, string>>;
  readonly field: string;
  readonly value: string;
  readonly testId: string;
  readonly current: boolean;
  readonly name: string;
  readonly caption?: string | undefined;
  readonly tile?: { readonly initial: string; readonly color: string } | undefined;
}) {
  return (
    <form action={action} key={value} style={{ margin: 0 }}>
      {Object.entries(hiddenFields).map(([key, fieldValue]) => (
        <input key={key} type="hidden" name={key} value={fieldValue} />
      ))}
      <input type="hidden" name={field} value={value} />
      <button
        type="submit"
        role="menuitem"
        data-testid={testId}
        aria-current={current ? 'true' : undefined}
        className="bsp-menu-item"
        // `gap: 10px; background: rgba(121,53,254,.08) (current) | transparent;
        //  border-radius: 10px; padding: 7px 8px`.
        style={{
          gap: 'var(--bsp-px-10)',
          padding: 'var(--bsp-px-7) var(--bsp-px-8)',
          background: current ? 'rgba(121, 53, 254, 0.08)' : 'transparent',
        }}
      >
        {tile ? (
          <span
            aria-hidden="true"
            style={{
              width: 'var(--bsp-px-26)',
              height: 'var(--bsp-px-26)',
              borderRadius: 'var(--bsp-px-8)',
              background: tile.color,
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              fontWeight: 800,
              fontSize: 'var(--bsp-fs-12)',
              flexShrink: 0,
            }}
          >
            {tile.initial}
          </span>
        ) : null}
        <span style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span
            style={{
              fontSize: 'var(--bsp-fs-13)',
              fontWeight: 600,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            <bdi>{name}</bdi>
          </span>
          {caption ? (
            <span style={{ fontSize: 'var(--bsp-fs-11)', color: '#8a8a92' }}>{caption}</span>
          ) : null}
        </span>
        {current ? (
          <span aria-hidden="true" style={{ color: '#5312c4', fontWeight: 800 }}>
            ✓
          </span>
        ) : null}
      </button>
    </form>
  );
}

/**
 * The workspace colours of the prototype's `.bmenu` rows,
 * `['#7935fe', '#175cd3', '#16794b', '#b8794a'][i % 4]`.
 */
const PROTOTYPE_WORKSPACE_COLOURS = ['#7935fe', '#175cd3', '#16794b', '#b8794a'] as const;

export interface PrototypeBusinessOption {
  readonly id: string;
  readonly name: string;
  /** "Role · Plan". */
  readonly caption: string;
  readonly current?: boolean | undefined;
}

/** `.bcard` opening `.bmenu`: "Workspaces · used/allowed", one row per business. */
export function PrototypeBusinessSwitcher({
  label,
  heading,
  current,
  options,
  action,
  hiddenFields,
  footer,
}: {
  readonly label: string;
  /** `Workspaces · 1/2` — the menu's first line. */
  readonly heading?: ReactNode;
  readonly current: { readonly name: string; readonly caption: string };
  readonly options: readonly PrototypeBusinessOption[];
  readonly action: (formData: FormData) => void | Promise<void>;
  readonly hiddenFields: Readonly<Record<string, string>>;
  readonly footer?: ReactNode;
}) {
  return (
    <DropdownMenu
      label={label}
      testId="workspace-switcher"
      align="start"
      trigger="card"
      triggerClassName="bsp-bcard"
      triggerContent={brandFace(current)}
      affordance={chevron}
      menuClassName="bsp-menu bsp-bmenu"
      menuStyle={BMENU}
    >
      {heading ? (
        <span
          className="bsp-menu-head"
          style={{ padding: 'var(--bsp-px-4) var(--bsp-px-8) var(--bsp-px-2)' }}
        >
          {heading}
        </span>
      ) : null}
      {options.map((option, index) =>
        formRow({
          action,
          hiddenFields,
          field: 'workspaceId',
          value: option.id,
          testId: `workspace-option-${option.id}`,
          current: option.current === true,
          name: option.name,
          caption: option.caption,
          tile: {
            initial: Array.from(option.name.trim())[0]?.toUpperCase() ?? '',
            color:
              PROTOTYPE_WORKSPACE_COLOURS[index % PROTOTYPE_WORKSPACE_COLOURS.length] ?? '#7935fe',
          },
        }),
      )}
      {footer}
    </DropdownMenu>
  );
}

export interface PrototypeBrandOption {
  readonly id: string;
  readonly name: string;
  readonly caption?: string | undefined;
  readonly current?: boolean | undefined;
}

/** Several brands in view: the same card, opening the brands. */
export function PrototypeBrandSwitcher({
  label,
  heading,
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
  readonly heading?: ReactNode;
  readonly current: { readonly name: string; readonly caption: string };
  readonly options: readonly PrototypeBrandOption[];
  readonly action: (formData: FormData) => void | Promise<void>;
  readonly hiddenFields: Readonly<Record<string, string>>;
  readonly allOption?: { readonly label: string; readonly current: boolean } | undefined;
  readonly emptyLabel?: string | undefined;
  readonly manageHref?: string | undefined;
  readonly manageLabel?: string | undefined;
}) {
  return (
    <DropdownMenu
      label={label}
      testId="brand-switcher"
      align="start"
      trigger="card"
      triggerClassName="bsp-bcard"
      triggerContent={brandFace(current)}
      affordance={chevron}
      menuClassName="bsp-menu bsp-bmenu"
      menuStyle={BMENU}
    >
      {heading ? (
        <span
          className="bsp-menu-head"
          style={{ padding: 'var(--bsp-px-4) var(--bsp-px-8) var(--bsp-px-2)' }}
        >
          {heading}
        </span>
      ) : null}
      {allOption
        ? formRow({
            action,
            hiddenFields,
            field: 'brandId',
            value: 'all',
            testId: 'brand-option-all',
            current: allOption.current,
            name: allOption.label,
          })
        : null}
      {options.map((option) =>
        formRow({
          action,
          hiddenFields,
          field: 'brandId',
          value: option.id,
          testId: `brand-option-${option.id}`,
          current: option.current === true,
          name: option.name,
          caption: option.caption,
        }),
      )}
      {options.length === 0 && emptyLabel ? (
        <p className="bsp-menu-item" style={{ margin: 0, cursor: 'default', color: '#6a6a72' }}>
          {emptyLabel}
        </p>
      ) : null}
      {manageHref && manageLabel ? (
        <a
          href={manageHref}
          role="menuitem"
          data-testid="manage-brand"
          className="bsp-menu-item"
          style={{
            fontSize: 'var(--bsp-fs-12-5)',
            fontWeight: 600,
            color: '#5312c4',
            padding: 'var(--bsp-px-7) var(--bsp-px-10)',
          }}
        >
          {manageLabel}
        </a>
      ) : null}
    </DropdownMenu>
  );
}

/**
 * `.ucard` opening `.umenu`: the avatar, the name, the role and `⋮`; the menu
 * opens upward (`bottom: 64px; width: 230px; z-index: 30`) with the person's
 * name and email at its head.
 */
export function PrototypeUserCard({
  label,
  name,
  email,
  role,
  initials,
  nameTestId = 'profile-name',
  children,
}: {
  readonly label: string;
  readonly name: string;
  readonly email?: string | undefined;
  readonly role: string;
  readonly initials: string;
  readonly nameTestId?: string;
  readonly children: ReactNode;
}) {
  return (
    <DropdownMenu
      label={label}
      testId="profile-menu"
      align="start"
      trigger="card"
      placement="block-start"
      triggerClassName="bsp-ucard"
      triggerContent={
        <>
          <span className="bsp-ucard-mark" aria-hidden="true">
            {initials}
          </span>
          <span className="bsp-ucard-copy bsp-nl bs-rail-copy">
            <span className="bsp-ucard-name" data-testid={nameTestId}>
              <bdi>{name}</bdi>
            </span>
            <span className="bsp-ucard-role" data-testid="profile-role">
              {role}
            </span>
          </span>
        </>
      }
      affordance={
        <span className="bsp-ucard-more bsp-nl" aria-hidden="true">
          <PrototypeIcon glyph="more" size={16} />
        </span>
      }
      menuClassName="bsp-menu bsp-umenu bsp-rise"
      menuStyle={{
        bottom: 'var(--bsp-px-64)',
        insetInlineStart: 0,
        width: 'var(--bsp-px-230)',
        zIndex: 30,
      }}
    >
      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          padding: 'var(--bsp-px-8) var(--bsp-px-10) var(--bsp-px-6)',
        }}
      >
        <b style={{ fontSize: 'var(--bsp-fs-13)' }}>
          <bdi>{name}</bdi>
        </b>
        {email ? (
          <span
            className="bsp-ltr"
            style={{ fontSize: 'var(--bsp-fs-11)', color: '#8a8a92', textAlign: 'start' }}
          >
            {email}
          </span>
        ) : null}
      </span>
      {children}
    </DropdownMenu>
  );
}

/** A plain row of the user menu: `padding: 8px 10px; font-size: 13px`. */
export function PrototypeMenuLink({
  href,
  testId,
  children,
  trailing,
  hrefLang,
}: {
  readonly href: string;
  readonly testId?: string | undefined;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
  readonly hrefLang?: string | undefined;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      data-testid={testId}
      className="bsp-menu-item"
      {...(hrefLang ? { hrefLang } : {})}
      style={{ justifyContent: trailing ? 'space-between' : undefined, gap: 'var(--bsp-px-8)' }}
    >
      {children}
      {trailing}
    </Link>
  );
}

/** One of the top bar's square controls: `.ibtn`, 40px, the glyph at 18px. */
export function PrototypeTopbarLink({
  href,
  label,
  glyph,
  count,
  countLabel,
  current = false,
  testId,
  showCount = true,
}: {
  readonly href: string;
  readonly label: string;
  readonly glyph: PrototypeGlyph;
  readonly count?: number | null | undefined;
  readonly countLabel?: string | undefined;
  readonly current?: boolean;
  readonly testId: string;
  /** The bell draws its count; the notes control does not (the rail does). */
  readonly showCount?: boolean;
}) {
  const active = typeof count === 'number' && count > 0;
  const name = active && countLabel ? `${label}, ${countLabel}` : label;
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <Link
        href={href}
        className="bsp-ibtn"
        aria-label={name}
        title={label}
        aria-current={current ? 'page' : undefined}
        data-testid={testId}
        data-indicator={active ? String(count) : undefined}
      >
        <PrototypeIcon glyph={glyph} />
        {active && showCount ? (
          <span className="bsp-ibtn-count" aria-hidden="true" data-testid={`${testId}-dot`}>
            {count > 99 ? '99+' : String(count)}
          </span>
        ) : null}
      </Link>
    </span>
  );
}

export interface PrototypeCreateItem {
  readonly key: string;
  readonly href: string;
  readonly label: string;
  readonly sub: string;
  readonly glyph: PrototypeGlyph;
}

/**
 * `.btn.pur` with the plus, opening the Create menu: a 36px icon tile, the
 * label at 14px/700 and its line at 12px; the first row is the highlighted one.
 */
export function PrototypeCreateMenu({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly PrototypeCreateItem[];
}) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu
      label={label}
      testId="topbar-create"
      trigger="primary"
      align="end"
      triggerClassName="bsp-btn bsp-pur"
      affordance={null}
      triggerContent={
        <>
          <PrototypeIcon glyph="plus" size={16} stroke={2.25} />
          {label}
        </>
      }
      menuClassName="bsp-menu bsp-create-menu"
      menuStyle={{
        top: 'var(--bsp-px-50)',
        insetInlineEnd: 0,
        width: 'var(--bsp-px-330)',
        zIndex: 20,
      }}
    >
      {items.map((item) => (
        <PrefetchLink
          key={item.key}
          href={item.href}
          role="menuitem"
          data-testid={`topbar-create-${item.key}`}
          className="bsp-create-item"
        >
          <span className="bsp-create-icon" aria-hidden="true">
            <PrototypeIcon glyph={item.glyph} size={18} stroke={1.9} />
          </span>
          <span className="bsp-create-copy">
            <span className="bsp-create-label">{item.label}</span>
            <span className="bsp-create-sub">{item.sub}</span>
          </span>
        </PrefetchLink>
      ))}
    </DropdownMenu>
  );
}

/** The language square: `.ibtn` carrying the other language's two letters at 13px/800. */
export function PrototypeLanguageSwitch({
  href,
  targetLocale,
  targetLetters,
  label,
}: {
  readonly href: string;
  readonly targetLocale: string;
  readonly targetLetters: string;
  readonly label: string;
}) {
  return (
    <a
      href={href}
      hrefLang={targetLocale}
      lang={targetLocale}
      aria-label={label}
      title={label}
      data-testid="locale-switch"
      className="bsp-ibtn bsp-lang"
    >
      {targetLetters}
    </a>
  );
}

/** `.fab`: the glass pill with the gradient spark and the word "Copilot". */
export function PrototypeCopilotFab({
  href,
  label,
  current = false,
  testId,
}: {
  readonly href: string;
  readonly label: string;
  readonly current?: boolean;
  readonly testId: string;
}) {
  return (
    <Link
      href={href}
      className="bsp-fab"
      title={label}
      aria-current={current ? 'page' : undefined}
      data-testid={testId}
    >
      <span className="bsp-fab-mark" aria-hidden="true">
        <PrototypeIcon glyph="spark" size={17} stroke={0} />
      </span>
      <span data-testid={`${testId}-label`}>{label}</span>
    </Link>
  );
}
