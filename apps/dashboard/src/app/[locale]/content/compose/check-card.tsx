'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { MissingMedia } from '@brandspace/config/publishing-media';
import { checkView } from './check-rows';
import { ChannelMark } from '../../calendar/prototype-calendar';

/**
 * "WILL IT LAND RIGHT?" — ONE CHANNEL'S CARD (Studio review, owner decision 2 —
 * D-569), ported from `Main.dc.html:518-521` with its rows from `:2365-2372`
 * and its states from `:2396-2399`: the mark, the name and the status; the
 * expired line; Size, Caption, Hashtags and Media, each ✓, ✕ or "!"; and the
 * connect link. The new post and the draft both draw it, so the two cannot
 * drift apart.
 *
 * Every number is the product's own: the size from the preview geometry, the
 * limits and the recommended hashtag range from configuration, the media need
 * from the channel's configured post kinds (`missingMediaFor`). The product's
 * own validation in words (`children`) follows the rows.
 */

export type CheckConnection = 'connected' | 'expired' | 'notConnected';

export interface CheckCardProps {
  readonly channel: { readonly key: string; readonly name: string };
  readonly contentType: string;
  /** `previewGeometry(contentType, key)`: "1080 × 1350 · 4:5". */
  readonly geometry: string;
  readonly caption: { readonly characters: number; readonly limit: number; readonly ok: boolean };
  readonly hashtags: {
    readonly count: number;
    readonly max: number;
    readonly recommended?: { readonly min: number; readonly max: number } | undefined;
    readonly ok: boolean;
  };
  readonly media: {
    readonly kinds: readonly string[];
    readonly needs: MissingMedia | null;
    readonly ok: boolean;
  };
  readonly connection: CheckConnection;
  /** The status word for an expired account ("Expired"), as the server translated it. */
  readonly expiredLabel?: string | undefined;
  /** D-332's longer explanation of an expired account, kept as the line's tooltip. */
  readonly expiredExplanation?: string | undefined;
  /** The Integrations page, for a member who may connect accounts; `null` hides the link. */
  readonly connectHref: string | null;
  readonly t: Readonly<Record<string, string>>;
  readonly testId: string;
  readonly children?: ReactNode;
}

export function CheckCard(props: CheckCardProps) {
  const { channel, t, connection } = props;
  const { rows, status, cta } = checkView(props);
  return (
    <div className="bsp-st-check" data-testid={props.testId} data-connection={connection}>
      <div className="bsp-st-check-head">
        <span className="bsp-st-check-mark">
          <ChannelMark channel={channel} size={14} label={false} />
        </span>
        <span className="bsp-ltr bsp-st-check-name">{channel.name}</span>
        <span
          className={`bsp-xstatus ${status.className} bsp-st-noshrink`}
          data-testid={`${props.testId}-status`}
        >
          {status.label}
        </span>
      </div>
      {connection === 'expired' ? (
        <span
          className="bsp-st-check-expired"
          title={props.expiredExplanation}
          data-testid={`${props.testId}-expired`}
        >
          {t['studio.expiredLine']}
        </span>
      ) : null}
      {rows.map((row) => (
        <div
          key={row.key}
          className="bsp-st-check-row"
          data-ok={row.state === 'ok' ? 'true' : row.state === 'warn' ? 'warn' : 'false'}
          data-testid={`${props.testId}-${row.key}`}
        >
          <span aria-hidden="true">
            {row.state === 'ok' ? '✓' : row.state === 'warn' ? '!' : '✕'}
          </span>
          <span>{t[`studio.row.${row.key}`]}</span>
          {/* Numbers read left to right; the media words read in the reader's language. */}
          <span className={row.key === 'media' ? undefined : 'bsp-ltr'} title={row.value}>
            {row.value}
          </span>
        </div>
      ))}
      {props.children}
      {cta && props.connectHref ? (
        <Link
          href={props.connectHref}
          className="bsp-st-check-cta"
          data-testid={`${props.testId}-connect`}
        >
          {cta.replace('{channel}', `\u2068${channel.name}\u2069`)}
        </Link>
      ) : null}
    </div>
  );
}
