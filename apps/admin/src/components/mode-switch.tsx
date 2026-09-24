'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LanguageSwitcher,
  buttonClass,
  buttonStyle,
  colorTokens,
  layoutTokens,
  motionTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { setConsoleModeAction } from '../app/[locale]/console/mode/actions';
import type { ConsoleMode } from '../server/console-mode';

/**
 * SIMPLE | ADVANCED — the Control Center's presentation switch (D-307).
 *
 * A form with two submit buttons rather than a client toggle, so it works
 * before hydration and without script, and so the choice reaches the server —
 * which is what lets the next page render in the chosen presentation on its
 * first paint. The current path travels with it; the action accepts it only
 * when it is a path inside this console.
 *
 * VISUALLY IT IS `LinkTabs`, token for token: the muted track and the raised
 * white pill with the pressed-purple label (CLAUDE.md §4.2 rule 4 — reuse
 * before creating). The semantics differ, so the element differs: this is a
 * choice between two states, so it is a group of toggle buttons carrying
 * `aria-pressed`, not navigation.
 */
export function ModeSwitch({
  locale,
  mode,
  labels,
}: {
  readonly locale: string;
  readonly mode: ConsoleMode;
  readonly labels: { readonly group: string; readonly simple: string; readonly advanced: string };
}) {
  const pathname = usePathname();
  const options: readonly { readonly value: ConsoleMode; readonly label: string }[] = [
    { value: 'simple', label: labels.simple },
    { value: 'advanced', label: labels.advanced },
  ];
  return (
    <form action={setConsoleModeAction} data-testid="mode-switch">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="next" value={pathname} />
      <div
        role="group"
        aria-label={labels.group}
        style={{
          display: 'inline-flex',
          gap: spacingTokens['3xs'],
          padding: spacingTokens['3xs'],
          borderRadius: radiusTokens.control,
          background: colorTokens.surfaceMuted,
          flexShrink: 0,
        }}
      >
        {options.map((option) => {
          const current = option.value === mode;
          return (
            <button
              key={option.value}
              type="submit"
              name="mode"
              value={option.value}
              aria-pressed={current}
              data-testid={`mode-${option.value}`}
              className="bs-pressable"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                // 38px outer, like every other top-bar control: 32px + 2×3px.
                minBlockSize: `calc(${layoutTokens.iconButton} - 2 * ${spacingTokens['3xs']})`,
                paddingInline: spacingTokens.sm,
                border: 0,
                borderRadius: radiusTokens.md,
                fontFamily: 'inherit',
                ...typographyTokens.button,
                // Current = the raised pill AND `aria-pressed`: never colour alone.
                background: current ? colorTokens.surface : 'transparent',
                color: current ? colorTokens.brandPurplePressed : colorTokens.textSecondary,
                boxShadow: current ? shadowTokens.card : 'none',
                cursor: current ? 'default' : 'pointer',
                transition: `color ${motionTokens.fast} ${motionTokens.easeOut}`,
                whiteSpace: 'nowrap',
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </form>
  );
}

/**
 * The language control, pointed at the SAME screen in the other language.
 *
 * The layout used to build this link from an `activePath` it never received,
 * so switching language from any console screen landed on the console home.
 * The path is only known in the browser, so the link is built here.
 */
export function ConsoleLanguageSwitch({
  locale,
  ariaLabel,
}: {
  readonly locale: string;
  readonly ariaLabel: string;
}) {
  const pathname = usePathname();
  const other = locale === 'ar' ? 'en' : 'ar';
  const prefix = `/${locale}/`;
  const href = pathname.startsWith(prefix)
    ? `/${other}/${pathname.slice(prefix.length)}`
    : `/${other}/console`;
  return (
    <LanguageSwitcher
      href={href}
      targetLocale={other}
      targetLabel={other === 'ar' ? 'العربية' : 'English'}
      ariaLabel={ariaLabel}
    />
  );
}

/**
 * THE NOTE AN ADVANCED SCREEN CARRIES IN SIMPLE MODE (D-308).
 *
 * An Advanced route opened by URL, a bookmark or a link from a Simple screen
 * renders exactly as it always has: the mode is not an access control, so it
 * neither redirects nor 404s. It says what kind of screen this is and offers
 * the two ways out. Rendered by the layout, which persists across navigation,
 * so it reads the path in the browser.
 */
export function AdvancedScreenNotice({
  locale,
  advancedOnlyPaths,
  labels,
}: {
  readonly locale: string;
  readonly advancedOnlyPaths: readonly string[];
  readonly labels: {
    readonly message: string;
    readonly switchLabel: string;
    readonly homeLabel: string;
  };
}) {
  const pathname = usePathname();
  const base = `/${locale}/console`;
  const onAdvancedScreen = advancedOnlyPaths.some(
    (href) => pathname === `${base}${href}` || pathname.startsWith(`${base}${href}/`),
  );
  if (!onAdvancedScreen) return null;
  return (
    <div
      role="note"
      data-testid="advanced-screen-note"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: spacingTokens.sm,
        marginBlockEnd: spacingTokens.md,
        padding: spacingTokens.md,
        borderRadius: radiusTokens.card,
        background: colorTokens.surfaceLavender,
        color: colorTokens.textPrimary,
        ...typographyTokens.bodySm,
      }}
    >
      <span style={{ flex: '1 1 18rem' }}>{labels.message}</span>
      <form action={setConsoleModeAction}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="next" value={pathname} />
        <button
          type="submit"
          name="mode"
          value="advanced"
          className={buttonClass('neutral')}
          style={buttonStyle('neutral', 'sm')}
          data-testid="advanced-note-switch"
        >
          {labels.switchLabel}
        </button>
      </form>
      <Link
        href={base}
        className={buttonClass('ghost')}
        style={buttonStyle('ghost', 'sm')}
        data-testid="advanced-note-home"
      >
        {labels.homeLabel}
      </Link>
    </div>
  );
}

/**
 * A SWITCH TO ADVANCED THAT LANDS ON A SPECIFIC SCREEN — "View technical
 * details". Simple and Advanced share URLs, so a plain link to the technical
 * view of the same route would render Simple again; this changes the mode
 * and goes there in one step.
 */
export function AdvancedLink({
  locale,
  href,
  label,
  testId,
}: {
  readonly locale: string;
  /** Path after `/console`. */
  readonly href: string;
  readonly label: string;
  readonly testId?: string;
}) {
  return (
    <form action={setConsoleModeAction} style={{ display: 'inline' }}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="next" value={`/${locale}/console${href}`} />
      <button
        type="submit"
        name="mode"
        value="advanced"
        className={buttonClass('ghost')}
        style={buttonStyle('ghost', 'sm')}
        data-testid={testId ?? 'advanced-link'}
      >
        {label}
      </button>
    </form>
  );
}
