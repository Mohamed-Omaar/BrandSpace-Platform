'use client';

import { useState, useTransition, type MouseEvent } from 'react';
import { nextColourScheme, type ColourScheme } from '@brandspace/shared/theme';
import { chooseColourSchemeAction } from '../app/[locale]/appearance/actions';
import { applyColourScheme, pageColourScheme } from './colour-scheme-sync';

/**
 * PR E — THE ACCOUNT MENU'S APPEARANCE ITEM, APPLIED AT ONCE.
 *
 * light → dark → device → light, as before (`nextColourScheme`). A press draws
 * the next scheme on this page in the same frame (`applyColourScheme`), tells
 * the other tabs, and stores the choice through `chooseColourSchemeAction`,
 * which re-renders the page on the server and drops every page the router
 * kept — so nothing anywhere stays in the old scheme and no refresh is needed.
 * The menu stays open on the new label, so pressing again keeps cycling.
 *
 * Still a link to `/appearance`, which does the same with a redirect, for a
 * browser that has not run the script yet.
 */
export function AppearanceMenuItem({
  locale,
  back,
  scheme,
  label,
  names,
}: {
  readonly locale: string;
  readonly back: string;
  /** The scheme the server rendered this page with. */
  readonly scheme: ColourScheme;
  readonly label: string;
  readonly names: Readonly<Record<ColourScheme, string>>;
}) {
  const [current, setCurrent] = useState<ColourScheme>(scheme);
  const [, startTransition] = useTransition();
  const next = nextColourScheme(current);

  const choose = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    // What the page shows now, which another tab may have moved since render.
    const target = nextColourScheme(pageColourScheme() ?? current);
    applyColourScheme(target);
    setCurrent(target);
    startTransition(async () => {
      await chooseColourSchemeAction(target);
    });
  };

  return (
    <a
      href={`/${locale}/appearance?to=${next}&back=${encodeURIComponent(back)}`}
      role="menuitem"
      data-testid="account-appearance"
      data-scheme={current}
      className="bsp-menu-item bsp-menu-split"
      onClick={choose}
    >
      {label}
      <b aria-live="polite">{names[current]}</b>
    </a>
  );
}
