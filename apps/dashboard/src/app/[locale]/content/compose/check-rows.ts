import type { MissingMedia } from '@brandspace/config/publishing-media';

/**
 * "WILL IT LAND RIGHT?" — WHAT ONE CHANNEL'S CARD SAYS (D-569), pure so the
 * unit suite reads it without a browser. `check-card.tsx` draws it.
 *
 *   - Size, from the preview geometry; always ✓.
 *   - Caption, "n / limit"; ✕ when empty or over the limit.
 *   - Hashtags, "n (3–5)" from the configured recommended range ("n / max"
 *     where none is configured); ✕ over the limit, "!" outside the range.
 *   - Media, "Image" / "Video" / "n slides"; "No picture yet" / "Needs a video"
 *     when the channel's configured post kinds need it; ✕ on a media issue.
 *   - Status: "Not connected" (only where the channel can be connected),
 *     "Expired", "Needs a fix" (any ✕), else "Ready" ("!" tints it).
 */

export type RowState = 'ok' | 'warn' | 'bad';

export interface CheckInput {
  readonly contentType: string;
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
  readonly connection: 'connected' | 'expired' | 'notConnected';
  readonly expiredLabel?: string | undefined;
  readonly connectHref: string | null;
  readonly t: Readonly<Record<string, string>>;
}

export interface CheckView {
  readonly rows: readonly {
    readonly key: string;
    readonly state: RowState;
    readonly value: string;
  }[];
  readonly status: { readonly label: string | undefined; readonly className: string };
  /** "Reconnect {channel} →" / "Connect {channel} →", or null for no link. */
  readonly cta: string | null;
}

export function mediaWords(
  t: Readonly<Record<string, string>>,
  contentType: string,
  kinds: readonly string[],
  needs: MissingMedia | null,
): string {
  if (needs === 'video') return t['studio.media.needsVideo'] ?? '';
  if (kinds.length === 0) {
    return (needs === 'picture' ? t['studio.media.noPicture'] : t['studio.media.none']) ?? '';
  }
  if (contentType === 'CAROUSEL' || kinds.length > 1) {
    return (t['studio.media.slides'] ?? '{count}').replace('{count}', String(kinds.length));
  }
  return (kinds.includes('VIDEO') ? t['studio.media.video'] : t['studio.media.image']) ?? '';
}

export function checkView(input: CheckInput): CheckView {
  const { t, connection } = input;
  const recommended = input.hashtags.recommended;
  const outsideRange =
    recommended !== undefined &&
    (input.hashtags.count < recommended.min || input.hashtags.count > recommended.max);
  const rows: CheckView['rows'] = [
    { key: 'size', state: 'ok', value: input.geometry },
    {
      key: 'caption',
      state: input.caption.ok ? 'ok' : 'bad',
      value: `${input.caption.characters} / ${input.caption.limit}`,
    },
    {
      key: 'tags',
      state: !input.hashtags.ok ? 'bad' : outsideRange ? 'warn' : 'ok',
      value: recommended
        ? `${input.hashtags.count} (${recommended.min}–${recommended.max})`
        : `${input.hashtags.count} / ${input.hashtags.max}`,
    },
    {
      key: 'media',
      state: input.media.ok ? 'ok' : 'bad',
      value: mediaWords(t, input.contentType, input.media.kinds, input.media.needs),
    },
  ];
  const bad = rows.some((row) => row.state === 'bad');
  const warn = rows.some((row) => row.state === 'warn');
  const status =
    connection === 'notConnected'
      ? { label: t['studio.notConnected'], className: 'bsp-bad' }
      : connection === 'expired'
        ? { label: input.expiredLabel ?? t['calendar.readiness.EXPIRED'], className: 'bsp-warn' }
        : bad
          ? { label: t['studio.fix'], className: 'bsp-warn' }
          : { label: t['studio.ready'], className: warn ? 'bsp-info' : '' };
  const cta =
    connection === 'connected' || !input.connectHref
      ? null
      : ((connection === 'expired' ? t['studio.reconnectChannel'] : t['studio.connectChannel']) ??
        '{channel}');
  return { rows, status, cta };
}
