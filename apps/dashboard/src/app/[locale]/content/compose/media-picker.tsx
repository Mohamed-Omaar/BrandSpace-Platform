'use client';

import { useState } from 'react';
import { AssetThumb, MediaChip, colorTokens, radiusTokens, spacingTokens } from '@brandspace/ui';

/**
 * THE COMPOSER'S MEDIA PICKER (AC-27.2, AC-27.3).
 *
 * ONE LIBRARY. Every option here is a row of the SAME `Asset` table the Asset
 * Library screen reads — the brand's own images and the workspace-shared shelf,
 * READY and CLEAN. There is no Content Studio media store (D-193).
 *
 * A CHECKBOX GRID RATHER THAN A DIALOG, deliberately. The picker lives inside
 * the variant's own `<form>`, so choosing media and saving the caption are ONE
 * submission: a picker that posted separately would leave a moment where the
 * saved caption and the saved media disagreed, and would need its own error
 * state for a failure the author did not cause.
 *
 * THE HIDDEN MARKER IS LOAD-BEARING (D-184). Unchecking every box submits NO
 * `assetIds` at all, which is indistinguishable from a form that never had a
 * picker — so `mediaPresent` says "this submission is about media", and the
 * service then treats an empty list as "remove the media" rather than as "leave
 * it alone". Missing is not empty, and here they are opposite instructions.
 *
 * CLIENT STATE HOLDS ONLY WHAT IS CHECKED, so the count and the ceiling can be
 * shown while typing. The server re-resolves every id through
 * `ContentMediaResolver` regardless; nothing here is an authorization.
 */

export interface MediaOptionView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly shared: boolean;
  /** A same-origin, expiring grant. `null` when no inline preview is possible. */
  readonly previewToken: string | null;
  /** PHASE 6 FINAL — measured facts, when the processor recorded them. */
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationMs?: number | null;
  /** D-286 — attached, but its licence has ended. */
  readonly rightsExpired?: boolean;
}

export interface MediaPickerLabels {
  readonly legend: string;
  readonly none: string;
  readonly empty: string;
  readonly shared: string;
  readonly video: string;
  readonly selectedCount: (selected: number, max: number) => string;
  readonly atLimit: string;
  readonly uploadHint: string;
}

export function MediaPicker({
  locale,
  options,
  selected,
  maxItems,
  disabled,
  labels,
  testId,
  onChange,
}: {
  readonly locale: string;
  readonly options: readonly MediaOptionView[];
  readonly selected: readonly string[];
  readonly maxItems: number;
  readonly disabled: boolean;
  readonly labels: MediaPickerLabels;
  readonly testId: string;
  /** PHASE 6 FINAL — the selection as it changes, for the live preview. */
  readonly onChange?: (assetIds: readonly string[]) => void;
}) {
  const [chosen, setChosen] = useState<readonly string[]>(selected);

  /*
   * A PLATFORM THAT TAKES NO MEDIA GETS NO PICKER. Rendering a disabled grid
   * for TikTok's caption-only variant would be the dead control §20 forbids;
   * the ceiling is an operator's fact and zero is a legal value for it.
   */
  if (maxItems === 0) return null;

  const atLimit = chosen.length >= maxItems;

  const toggle = (id: string, checked: boolean): void => {
    const next = checked
      ? [...chosen.filter((value) => value !== id), id]
      : chosen.filter((value) => value !== id);
    setChosen(next);
    onChange?.(next);
  };

  return (
    <fieldset
      data-testid={testId}
      style={{ border: 'none', margin: 0, padding: 0, display: 'grid', gap: spacingTokens.xs }}
    >
      <legend className="cs-section-kicker" style={{ padding: 0 }}>
        {labels.legend}
      </legend>

      {/*
        THE MARKER THAT MAKES "no media" SAYABLE. Always submitted, never
        conditional: without it, clearing the last image would be silently
        read as "do not change the media".
      */}
      <input type="hidden" name="mediaPresent" value="1" />

      {options.length === 0 ? (
        <p className="cs-hint" data-testid={`${testId}-empty`}>
          {labels.empty}{' '}
          <a href={`/${locale}/assets`} className="cs-inline-link">
            {labels.uploadHint}
          </a>
        </p>
      ) : (
        <>
          <p className="cs-hint" data-testid={`${testId}-count`}>
            {labels.selectedCount(chosen.length, maxItems)}
            {atLimit ? ` · ${labels.atLimit}` : ''}
          </p>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexWrap: 'wrap',
              gap: spacingTokens.sm,
            }}
          >
            {options.map((option) => {
              const isChosen = chosen.includes(option.id);
              // A box that would exceed the ceiling is disabled, not hidden:
              // the author can see what they would have to uncheck first.
              const blocked = !isChosen && atLimit;
              return (
                <li key={option.id}>
                  <label
                    style={{
                      display: 'grid',
                      justifyItems: 'center',
                      gap: spacingTokens['2xs'],
                      padding: spacingTokens['2xs'],
                      borderRadius: radiusTokens.md,
                      background: isChosen ? colorTokens.brandPurpleTint : 'transparent',
                      opacity: blocked ? 0.45 : 1,
                      cursor: disabled || blocked ? 'not-allowed' : 'pointer',
                      maxInlineSize: '6rem',
                    }}
                  >
                    <span style={{ position: 'relative', display: 'inline-block' }}>
                      {option.previewToken ? (
                        <AssetThumb
                          src={`/${locale}/assets/file/${option.previewToken}`}
                          alt={option.name}
                          size="4rem"
                          testId={`${testId}-thumb-${option.id}`}
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          style={{
                            display: 'inline-block',
                            inlineSize: '4rem',
                            blockSize: '4rem',
                            borderRadius: radiusTokens.sm,
                            background: colorTokens.surfaceMuted,
                          }}
                        />
                      )}
                      {option.kind === 'VIDEO' ? (
                        <MediaChip placement="start-end">{labels.video}</MediaChip>
                      ) : null}
                    </span>
                    <input
                      type="checkbox"
                      name="assetIds"
                      value={option.id}
                      defaultChecked={isChosen}
                      disabled={disabled || blocked}
                      data-testid={`${testId}-option-${option.id}`}
                      onChange={(event) => toggle(option.id, event.target.checked)}
                    />
                    {/*
                      THE NAME IS THE LABEL, not a tooltip. A grid of thumbnails
                      a screen reader announces as "checkbox, checkbox" is a
                      control only some readers have.
                    */}
                    <span
                      className="cs-hint"
                      style={{
                        textAlign: 'center',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {option.name}
                      {option.shared ? ` · ${labels.shared}` : ''}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </fieldset>
  );
}
