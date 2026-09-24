import type { ReactNode } from 'react';
import {
  AppShell,
  BrandMark,
  BuildingIcon,
  CreditIcon,
  FlagIcon,
  HomeIcon,
  KeyIcon,
  ProfileCard,
  LayersIcon,
  LifebuoyIcon,
  ListIcon,
  PlugIcon,
  PulseIcon,
  RouteIcon,
  SlidersIcon,
  SparkIcon,
  StateMessage,
  StatusBadge,
  SupportModeBanner,
  colorTokens,
  menuItemStyle,
  radiusTokens,
  spacingTokens,
  typographyTokens,
  type ShellNavSection,
  initialsFrom,
} from '@brandspace/ui';
import { translator } from '../i18n/messages';
import { simpleCopy } from '../i18n/simple';
import type { ConsoleMode } from '../server/console-mode';
import { ADVANCED_ONLY_PATHS, consoleNavigation, type ConsoleIcon } from './console-nav';
import { AdvancedScreenNotice, ConsoleLanguageSwitch, ModeSwitch } from './mode-switch';

const ICONS: Record<ConsoleIcon, ReactNode> = {
  home: <HomeIcon size={20} />,
  building: <BuildingIcon size={20} />,
  lifebuoy: <LifebuoyIcon size={20} />,
  sliders: <SlidersIcon size={20} />,
  key: <KeyIcon size={20} />,
  flag: <FlagIcon size={20} />,
  layers: <LayersIcon size={20} />,
  plug: <PlugIcon size={20} />,
  spark: <SparkIcon size={20} />,
  route: <RouteIcon size={20} />,
  list: <ListIcon size={20} />,
  pulse: <PulseIcon size={20} />,
  credit: <CreditIcon size={20} />,
};

/** The active Support Mode grant, resolved server-side by the console layout. */
export interface SupportBannerState {
  readonly workspaceName: string;
  readonly reason: string;
  readonly remainingMinutes: number;
}

export function AdminShell({
  locale,
  heading,
  description,
  actions,
  activePath,
  actorEmail,
  actorRole,
  permissionKeys,
  environment,
  mode,
  support = null,
  children,
}: {
  locale: string;
  /**
   * Optional page title.
   *
   * The console layout wraps EVERY page, and a layout cannot know the title of
   * the page inside it — so here the page keeps ownership of its own `h1` via
   * `PageHeading`, and this prop exists for the pages that let the shell render
   * it. Exactly one of the two renders a heading, never both.
   */
  heading?: string | undefined;
  description?: string | undefined;
  actions?: ReactNode;
  /** Path after `/console`, e.g. `/workspaces`. Marks the active nav item. */
  activePath?: string | undefined;
  actorEmail: string;
  actorRole: string;
  permissionKeys: readonly string[];
  environment: string;
  /** Simple or Advanced (D-307). Presentation only — never an access input. */
  mode: ConsoleMode;
  support?: SupportBannerState | null;
  children: ReactNode;
}) {
  const t = translator(locale);
  const copy = simpleCopy(locale);
  const isProduction = environment === 'PRODUCTION';

  /*
   * THE MODE CHOOSES WHICH PERMITTED SCREENS ARE LISTED (D-308). Filtering by
   * permission is still a convenience — the page answers 404 without it — and
   * the other mode's routes ride along hidden, so a screen opened by URL keeps
   * its title.
   */
  const sections: readonly ShellNavSection[] = consoleNavigation(mode)
    .map((section) => ({
      title: section.title ? (locale === 'ar' ? section.title.ar : section.title.en) : undefined,
      items: section.items
        .filter((item) => permissionKeys.includes(item.permission))
        .map((item) => ({
          href: `/${locale}/console${item.href}`,
          label: item.label(locale),
          icon: ICONS[item.icon],
          /*
           * `active` is left to the shell, which resolves it from the real
           * pathname by longest match — a layout cannot read the pathname on
           * the server; the shell is a client component and can.
           */
          ...(activePath === undefined ? {} : { active: activePath === item.href }),
          /* The longer page title, for the top bar. The nav says "AI models";
             the page is "AI model registry". */
          pageTitle: item.title(locale),
          // The existing convention, preserved: the end-to-end suite selects
          // `nav-nav.configuration` and `nav-nav.secrets` in Advanced mode.
          testId: item.testId,
          hidden: item.hidden === true,
        })),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <AppShell
      /* No subtitle in the rail: `.sidebar-top` is a fixed 42px, and
         "Platform administration" wrapped to a second line there, pushing every
         nav item down and out of alignment with the customer application. The
         same words are the top-bar eyebrow, where they have a full row. */
      brand={<BrandMark title={t('app.mark')} />}
      sections={sections}
      labels={{
        primaryNavigation: t('nav.primary'),
        openNavigation: t('nav.open'),
        closeNavigation: t('nav.close'),
        collapseSidebar: t('nav.collapse'),
        expandSidebar: t('nav.expand'),
      }}
      banner={
        support ? (
          /*
            Support Mode banner. Persistent, unmistakable, and above everything
            — docs/SECURITY.md §8. It is sticky, so it cannot be scrolled away,
            and the text says plainly that this is platform staff and NOT the
            customer: D-28 prohibits impersonation, and an ambiguous banner
            weakens that as surely as a missing check would.
          */
          <SupportModeBanner
            text={
              locale === 'ar'
                ? 'وضع الدعم — قراءة فقط · أنت موظف منصة ولستَ العميل'
                : 'SUPPORT MODE — read only · you are platform staff, not the customer'
            }
            detail={
              locale === 'ar'
                ? `${support.workspaceName} · تبقّى ${support.remainingMinutes} دقيقة`
                : `${support.workspaceName} · ${support.remainingMinutes} min left`
            }
          />
        ) : undefined
      }
      headerStart={
        /* The active environment is always visible: production actions must
           never be taken by accident. */
        <span
          data-testid="environment-badge"
          style={{
            paddingInline: spacingTokens.sm,
            paddingBlock: '2px',
            borderRadius: radiusTokens.full,
            ...typographyTokens.caption,
            fontWeight: 700,
            background: isProduction ? colorTokens.danger : colorTokens.surfaceMuted,
            color: isProduction ? colorTokens.textInverse : colorTokens.textSecondary,
            /*
             * A PRODUCTION BADGE KEEPS ITS OUTLINE. Everywhere else the border
             * came off with the rest of them, but this one is not decoration:
             * it is the signal that an action here is real, and it is the one
             * place where being visually louder than its neighbours is the
             * point. Non-production is a plain filled pill.
             */
            border: isProduction ? `1px solid ${colorTokens.danger}` : 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {environment}
        </span>
      }
      headerEnd={
        /*
         * THE MODE SWITCH AND THE LANGUAGE, AND NOTHING ELSE (D-309).
         *
         * The top bar used to carry the customer product's search, bell and
         * "+ Create", each opening a panel saying it was not connected. The
         * Control Center has no search index, no notification feed and no
         * single thing to create, so those were placeholders for capabilities
         * that do not exist here — removed rather than kept as decoration.
         */
        <>
          <ModeSwitch
            locale={locale}
            mode={mode}
            labels={{
              group: copy('mode.group'),
              simple: copy('mode.simple'),
              advanced: copy('mode.advanced'),
            }}
          />
          <ConsoleLanguageSwitch locale={locale} ariaLabel={t('nav.language')} />
        </>
      }
      /* The scope word above every console title — always, because the
         console LAYOUT renders the shell and never knows the page's own
         heading. Gating it on `heading` meant sixteen routes had a title with
         nothing above it and a top bar that read as half-empty. */
      pageEyebrow={t('app.subtitle')}
      pageTitle={heading}
      pageDescription={description}
      pageMeta={
        support ? (
          <StatusBadge
            label={locale === 'ar' ? 'وضع الدعم' : 'Support mode'}
            tone="accent"
            testId="support-mode-page-badge"
          />
        ) : undefined
      }
      profile={
        /* The same profile card the customer rail uses, with the operator's
           real identity and platform role. Sign-out lives in its menu. */
        <ProfileCard
          label={t('nav.account')}
          name={actorEmail}
          nameTestId="actor-identity"
          role={actorRole}
          initials={initialsFrom(actorEmail)}
        >
          <form action={`/${locale}/sign-out`} method="post">
            <button type="submit" role="menuitem" data-testid="sign-out" style={menuItemStyle()}>
              {t('nav.signOut')}
            </button>
          </form>
        </ProfileCard>
      }
    >
      {/*
        The title moved into the top bar (fidelity pass §4/§5), so the console
        gets the reference's single `eyebrow → h1 → actions` block rather than a
        strip followed by a detached heading. Page-level actions stay here.
      */}
      {actions ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: spacingTokens.sm,
            marginBlockEnd: spacingTokens.md,
          }}
        >
          {actions}
        </div>
      ) : null}
      {mode === 'simple' ? (
        <AdvancedScreenNotice
          locale={locale}
          advancedOnlyPaths={ADVANCED_ONLY_PATHS}
          labels={{
            message: copy('mode.advancedScreen'),
            switchLabel: copy('mode.switchToAdvanced'),
            homeLabel: copy('mode.backToSimple'),
          }}
        />
      ) : null}
      <div className="bs-section-stack">{children}</div>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------
 * PHASE 2C-B MIGRATION SURFACE.
 *
 * Phase 2C-A restyles a representative set of console screens (§8.4). These
 * aliases keep the remaining pages compiling and make them inherit the new
 * tokens, because each is the design-system component under its previous name.
 * Phase 2C-B replaces the call sites and deletes this block.
 * ------------------------------------------------------------------------- */

export { DataTable, Cell } from '@brandspace/ui';

/**
 * The lead paragraph under a console page's title.
 *
 * REPLACES `PageHeading`, and the rename is the point. Every console page used
 * to render its own `<PageHeading title=… description=… />` one block below the
 * top bar, which is exactly the detached-heading composition the reference does
 * not have. The title now lives in the top bar, resolved from the route, so a
 * page that still tried to render one would produce a second `h1` — and a page
 * that quietly dropped its title would lose the authored copy.
 *
 * So the type changed rather than the behaviour being patched: `title` is gone,
 * TypeScript named all ten call sites, and each page's title moved to
 * `NAV_SECTIONS` beside its route where a layout-rendered shell can read it.
 */
export function PageIntro({ description }: { readonly description: string }) {
  return (
    <p
      data-testid="description"
      style={{
        margin: 0,
        maxInlineSize: '68ch',
        ...typographyTokens.bodySm,
        color: colorTokens.textSecondary,
      }}
    >
      {description}
    </p>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <StateMessage title={message} />;
}
