'use client';

import { useState } from 'react';
import { AssetThumb, MediaChip, colorTokens, radiusTokens, spacingTokens } from '@brandspace/ui';
import { aspectLabel, durationLabel, fill, moveItem } from '../../../../server/composer-editor';
import type { MediaOptionView } from './media-picker';

/**
 * THE MEDIA OF ONE PLATFORM VERSION, AS ORDERED SLIDES (Phase 6 final, D-277
 * §23-§25, D-285).
 *
 * A carousel is not "several files in a field": it is Slide 01, Slide 02, …,
 * in an order the author sets by dragging or with the move buttons, each one
 * removable or replaceable, and more added through the media drawer without
 * leaving the post. The order is `content_variant.assetIds`, which the save
 * action already reads in submission order — so what is on screen is exactly
 * what is stored.
 *
 * A REEL OR VIDEO MAY HAVE A COVER: one of the images, marked here and saved as
 * `coverAssetId` (a durable column, never browser state).
 *
 * THE FORM FIELDS ARE THE SAME CONTRACT AS THE OLD PICKER: `mediaPresent`
 * always, then one `assetIds` per slide in order. A platform that takes no
 * media renders nothing and submits nothing, leaving the stored media alone.
 */
export interface MediaSlidesProps {
  readonly locale: string;
  readonly t: Record<string, string>;
  readonly options: readonly MediaOptionView[];
  readonly value: readonly string[];
  readonly maxItems: number;
  /** Number the slides ("Slide 01") — a carousel. */
  readonly numbered: boolean;
  /** Offer "Use as cover" on images — a Reel or a video. */
  readonly coverable: boolean;
  readonly cover: string | null;
  readonly disabled: boolean;
  readonly testId: string;
  readonly onChange: (assetIds: readonly string[]) => void;
  readonly onCoverChange: (assetId: string | null) => void;
  /** Open the media drawer: to add, or to replace the slide at `index`. */
  readonly onOpenDrawer: (replaceIndex: number | null) => void;
}

export function MediaSlides({
  locale,
  t,
  options,
  value,
  maxItems,
  numbered,
  coverable,
  cover,
  disabled,
  testId,
  onChange,
  onCoverChange,
  onOpenDrawer,
}: MediaSlidesProps) {
  const [dragging, setDragging] = useState<number | null>(null);
  if (maxItems === 0) return null;

  const byId = new Map(options.map((option) => [option.id, option]));
  const atLimit = value.length >= maxItems;
  const label = (index: number) =>
    fill(t['editor.media.slide'] ?? '{n}', { n: String(index + 1).padStart(2, '0') });

  return (
    <fieldset className="cs-slides" data-testid={testId} disabled={disabled}>
      <legend className="cs-section-kicker">{t['content.media.legend']}</legend>
      <input type="hidden" name="mediaPresent" value="1" />
      {value.map((id) => (
        <input key={id} type="hidden" name="assetIds" value={id} />
      ))}
      {coverable ? <input type="hidden" name="coverAssetId" value={cover ?? ''} /> : null}

      <p className="cs-hint" data-testid={`${testId}-count`}>
        {fill(t['content.media.selected'] ?? '', { selected: value.length, max: maxItems })}
      </p>

      {value.length === 0 ? (
        <p className="cs-hint" data-testid={`${testId}-empty`}>
          {t['editor.media.none']}
        </p>
      ) : (
        <ol className="cs-slide-list">
          {value.map((id, index) => {
            const option = byId.get(id);
            const duration = durationLabel(option?.durationMs);
            const aspect = aspectLabel(option?.width, option?.height);
            const isCover = cover === id;
            return (
              <li
                key={id}
                draggable={!disabled}
                data-testid={`${testId}-slide-${index}`}
                data-asset-id={id}
                className={dragging === index ? 'dragging' : undefined}
                onDragStart={(event) => {
                  setDragging(index);
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging !== null && dragging !== index) {
                    onChange(moveItem(value, dragging, index));
                  }
                  setDragging(null);
                }}
                onDragEnd={() => setDragging(null)}
              >
                <span style={{ position: 'relative', display: 'inline-block' }}>
                  {option?.previewToken ? (
                    <AssetThumb
                      src={`/${locale}/assets/file/${option.previewToken}`}
                      alt={option.name}
                      size="3.25rem"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      style={{
                        display: 'inline-block',
                        inlineSize: '3.25rem',
                        blockSize: '3.25rem',
                        borderRadius: radiusTokens.sm,
                        background: colorTokens.surfaceMuted,
                      }}
                    />
                  )}
                  {option?.kind === 'VIDEO' ? (
                    <MediaChip placement="start-end">
                      {duration ?? t['content.media.video']}
                    </MediaChip>
                  ) : null}
                </span>
                <span style={{ display: 'grid', gap: spacingTokens['3xs'], minInlineSize: 0 }}>
                  <b>{numbered ? label(index) : (option?.name ?? t['editor.media.unavailable'])}</b>
                  <span className="cs-hint" style={{ marginTop: 0 }}>
                    {[
                      numbered ? option?.name : null,
                      aspect,
                      isCover ? t['editor.media.isCover'] : null,
                      option?.rightsExpired ? t['editor.media.rightsExpired'] : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="cs-slide-actions">
                  <button
                    type="button"
                    className="cs-channel"
                    aria-label={fill(t['editor.media.moveEarlier'] ?? '', { slide: label(index) })}
                    disabled={index === 0}
                    data-testid={`${testId}-earlier-${index}`}
                    onClick={() => onChange(moveItem(value, index, index - 1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="cs-channel"
                    aria-label={fill(t['editor.media.moveLater'] ?? '', { slide: label(index) })}
                    disabled={index === value.length - 1}
                    data-testid={`${testId}-later-${index}`}
                    onClick={() => onChange(moveItem(value, index, index + 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="cs-channel"
                    data-testid={`${testId}-replace-${index}`}
                    onClick={() => onOpenDrawer(index)}
                  >
                    {t['editor.media.replace']}
                  </button>
                  {coverable && option?.kind === 'IMAGE' ? (
                    <button
                      type="button"
                      className={isCover ? 'cs-channel selected' : 'cs-channel'}
                      aria-pressed={isCover}
                      data-testid={`${testId}-cover-${index}`}
                      onClick={() => onCoverChange(isCover ? null : id)}
                    >
                      {t['editor.media.useAsCover']}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="cs-channel"
                    data-testid={`${testId}-remove-${index}`}
                    onClick={() => {
                      onChange(value.filter((_, at) => at !== index));
                      if (isCover) onCoverChange(null);
                    }}
                  >
                    {t['editor.media.remove']}
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <button
        type="button"
        className="cs-ghost-button cs-compact"
        disabled={atLimit}
        data-testid={`${testId}-add`}
        onClick={() => onOpenDrawer(null)}
      >
        {atLimit ? t['content.media.atLimit'] : t['editor.media.add']}
      </button>
    </fieldset>
  );
}
