'use client';

import { useEffect } from 'react';
import type { ColourScheme } from '@brandspace/shared/theme';

const CHANNEL = 'bs-color-scheme';

/**
 * TWO TABS AGREE (P1). The server renders each page with the person's scheme
 * on `<html data-color-scheme>`; when a page loads with a scheme, it tells the
 * person's other open tabs, which take the same value at once instead of
 * waiting for their next navigation. It never chooses a scheme itself, and it
 * never changes the tab it runs in: that tab's value came from the server.
 */
export function ColourSchemeSync({ scheme }: { readonly scheme: ColourScheme }) {
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (value === 'light' || value === 'dark' || value === 'system') {
        document.documentElement.dataset['colorScheme'] = value;
      }
    };
    channel.postMessage(scheme);
    return () => channel.close();
  }, [scheme]);
  return null;
}
