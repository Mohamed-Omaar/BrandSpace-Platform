'use client';

import { useEffect, useState } from 'react';
import { formatCredits } from '../../../../server/composer-editor';

/**
 * THE DESIGN TAB'S WAYS IN, ON A POST WITH NO MEDIA YET (Studio review, owner
 * decision 3 — D-569), ported from `Main.dc.html:401-409` with the sources of
 * `:2281-2287`: "From Media" (how many the brand has), "Upload" (from the
 * device) and "Generate with AI" (its credit quote). Each opens the existing
 * "Add media" drawer (D-285) on its own tab; the media list stays below.
 *
 * Brand template is not drawn: it stays out (D-473). Generate is not drawn
 * where image generation is unavailable (no AI provider, no permission), and
 * Upload not where the member may not upload. The quote is the Creative
 * Studio's own (`/api/creative/quote`), asked once for the default size — a
 * figure the drawer quotes again before anything is spent.
 */

export type MediaSourceTab = 'library' | 'upload' | 'generate';

const ICONS: Readonly<Record<MediaSourceTab, string>> = {
  library: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
  generate: 'M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.5l-1.6-5.3L5 10.6 10.4 9z',
};

export function MediaSources({
  t,
  count,
  canUpload,
  canGenerate,
  quoteFormat,
  onOpen,
  testId,
}: {
  readonly t: Readonly<Record<string, string>>;
  /** The brand's ready pictures and videos (the drawer's library). */
  readonly count: number;
  readonly canUpload: boolean;
  readonly canGenerate: boolean;
  /** The creative size the drawer would quote first. */
  readonly quoteFormat: string;
  readonly onOpen: (tab: MediaSourceTab) => void;
  readonly testId: string;
}) {
  const [quote, setQuote] = useState<string | null>(null);
  useEffect(() => {
    if (!canGenerate || quoteFormat === '') return;
    let live = true;
    fetch('/api/creative/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formatKey: quoteFormat }),
    })
      .then(async (response) =>
        response.ok ? ((await response.json()) as { estimateMilli?: unknown }) : null,
      )
      .then((payload) => {
        if (live && payload) setQuote(String(payload.estimateMilli ?? '0'));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [canGenerate, quoteFormat]);

  const sources: readonly { tab: MediaSourceTab; label: string; sub: string }[] = [
    {
      tab: 'library' as const,
      label: t['studio.source.library'] ?? '',
      sub: (t['studio.source.librarySub'] ?? '{count}').replace('{count}', String(count)),
    },
    ...(canUpload
      ? [
          {
            tab: 'upload' as const,
            label: t['studio.source.upload'] ?? '',
            sub: t['studio.source.uploadSub'] ?? '',
          },
        ]
      : []),
    ...(canGenerate
      ? [
          {
            tab: 'generate' as const,
            label: t['studio.source.generate'] ?? '',
            sub:
              quote === null
                ? (t['studio.source.generateSub'] ?? '')
                : (t['studio.source.generateQuote'] ?? '{credits}').replace(
                    '{credits}',
                    formatCredits(quote),
                  ),
          },
        ]
      : []),
  ];

  return (
    <div className="bsp-st-sources" data-testid={testId}>
      {sources.map((source) => (
        <button
          key={source.tab}
          type="button"
          className="bsp-st-source"
          data-testid={`${testId}-${source.tab}`}
          onClick={() => onOpen(source.tab)}
        >
          <span className="bsp-st-source-icon" aria-hidden="true">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={ICONS[source.tab]} />
            </svg>
          </span>
          <span className="bsp-st-source-label">{source.label}</span>
          <span className="bsp-st-source-sub">{source.sub}</span>
        </button>
      ))}
    </div>
  );
}
