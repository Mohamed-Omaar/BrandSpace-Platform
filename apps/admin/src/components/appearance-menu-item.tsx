'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { nextColourScheme, type ColourScheme } from '@brandspace/shared/theme';
import { chooseConsoleColourSchemeAction } from '../app/[locale]/console/appearance/actions';

const CHANNEL = 'bs-cc-color-scheme';

const isScheme = (value: unknown): value is ColourScheme =>
  value === 'light' || value === 'dark' || value === 'system';

/**
 * PR E — THE CONTROL CENTER'S APPEARANCE ITEM: light → dark → device → light,
 * drawn at once. Every colour is a custom property `/theme.css` keys on
 * `<html data-color-scheme>`, so writing the attribute repaints the page in the
 * same frame; the operator's other Control Center tabs take the same value
 * from the channel; the action keeps it for the next page.
 */
export function ConsoleAppearanceMenuItem({
  scheme,
  label,
  names,
}: {
  readonly scheme: ColourScheme;
  readonly label: string;
  readonly names: Readonly<Record<ColourScheme, string>>;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<ColourScheme>(scheme);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (!isScheme(value) || document.documentElement.dataset['colorScheme'] === value) return;
      document.documentElement.dataset['colorScheme'] = value;
      setCurrent(value);
      router.refresh();
    };
    return () => channel.close();
  }, [router]);

  const choose = () => {
    const shown = document.documentElement.dataset['colorScheme'];
    const target = nextColourScheme(isScheme(shown) ? shown : current);
    document.documentElement.dataset['colorScheme'] = target;
    setCurrent(target);
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(CHANNEL);
      channel.postMessage(target);
      channel.close();
    }
    startTransition(async () => {
      await chooseConsoleColourSchemeAction(target);
    });
  };

  return (
    <button
      type="button"
      role="menuitem"
      data-testid="account-appearance"
      data-scheme={current}
      className="bs-console-menu-item"
      onClick={choose}
    >
      {label}
      <b aria-live="polite">{names[current]}</b>
    </button>
  );
}
