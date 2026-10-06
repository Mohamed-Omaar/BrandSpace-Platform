'use client';

import Link from 'next/link';
import { listOf } from './format-fit';

/** Which channels have a working account per brand, and which can be connected at all. */
export interface ChannelAccess {
  /** Brand id → the channel keys with an ACTIVE connection. */
  readonly connected: Readonly<Record<string, readonly string[]>>;
  /** The channel keys the operator has enabled for connecting (`publishing.providers.<key>.enabled`). */
  readonly connectable: readonly string[];
  /** The existing Integrations page, for a member who may connect accounts; `null` otherwise. */
  readonly connectHref: string | null;
}

/**
 * ROUND 6 (D-481) — ONE CALM LINE BESIDE "POST TO". A post is drafted for any
 * channel its format suits; an account is needed only to publish or schedule
 * for real, and that check and its messages are unchanged. So nothing here
 * blocks: it says which chosen channels still need connecting (with the
 * existing connect page) and which cannot be connected yet at all.
 */
export function ChannelAccessLine({
  access,
  brandId,
  channels,
  labelOf,
  locale,
  t,
}: {
  readonly access: ChannelAccess | null | undefined;
  readonly brandId: string | null;
  readonly channels: readonly string[];
  readonly labelOf: (key: string) => string;
  readonly locale: string;
  readonly t: Readonly<Record<string, string>>;
}) {
  if (!access || !brandId || channels.length === 0) return null;
  const connected = access.connected[brandId] ?? [];
  const missing = channels.filter((key) => !connected.includes(key));
  if (missing.length === 0) return null;
  const toConnect = missing.filter((key) => access.connectable.includes(key));
  const unavailable = missing.filter((key) => !access.connectable.includes(key));
  const names = (keys: readonly string[]) => listOf(locale, keys.map(labelOf));
  return (
    <span className="bsp-st-hint bsp-st-connect" data-testid="studio-connect">
      {toConnect.length > 0 ? (
        <span data-testid="studio-connect-line">
          {(t['studio.connect.line'] ?? '{channels}').replace('{channels}', names(toConnect))}{' '}
          {access.connectHref ? (
            <Link href={access.connectHref} data-testid="studio-connect-link">
              {t['studio.connect.link']}
            </Link>
          ) : null}
        </span>
      ) : null}
      {unavailable.length > 0 ? (
        <span data-testid="studio-connect-unavailable">
          {(t['studio.connect.unavailable'] ?? '{channels}').replace(
            '{channels}',
            names(unavailable),
          )}
        </span>
      ) : null}
    </span>
  );
}
