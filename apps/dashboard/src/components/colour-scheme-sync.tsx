'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { ColourScheme } from '@brandspace/shared/theme';

const CHANNEL = 'bs-color-scheme';

const isScheme = (value: unknown): value is ColourScheme =>
  value === 'light' || value === 'dark' || value === 'system';

/** The scheme the page is drawn in right now, from `<html data-color-scheme>`. */
export function pageColourScheme(): ColourScheme | null {
  const value = document.documentElement.dataset['colorScheme'];
  return isScheme(value) ? value : null;
}

/**
 * PR E — DRAW A SCHEME NOW, HERE AND IN EVERY OTHER TAB. Every colour on the
 * page is a custom property `/theme.css` keys on `<html data-color-scheme>`,
 * so writing the attribute repaints the whole page in the same frame: no
 * request, no reload. The other tabs take the same value from the channel.
 */
export function applyColourScheme(scheme: ColourScheme): void {
  document.documentElement.dataset['colorScheme'] = scheme;
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(scheme);
  channel.close();
}

/**
 * TWO TABS AGREE (P1). The server renders each page with the person's scheme
 * on `<html data-color-scheme>`; when a page loads with a scheme, it tells the
 * person's other open tabs, which take the same value at once instead of
 * waiting for their next navigation. It never chooses a scheme itself, and it
 * never changes the tab it runs in: that tab's value came from the server.
 *
 * PR E: a tab that takes a new value also asks the server for its page again
 * (`router.refresh()`), so the parts the server draws for a scheme — the menu's
 * label, the theme's logo — follow it too, and the pages that tab kept from
 * before are dropped.
 */
export function ColourSchemeSync({ scheme }: { readonly scheme: ColourScheme }) {
  const router = useRouter();
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (!isScheme(value) || pageColourScheme() === value) return;
      document.documentElement.dataset['colorScheme'] = value;
      router.refresh();
    };
    channel.postMessage(scheme);
    return () => channel.close();
  }, [scheme, router]);
  return null;
}
