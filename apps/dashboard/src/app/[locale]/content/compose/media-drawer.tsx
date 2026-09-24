'use client';

import { useId, useMemo, useState } from 'react';
import { AssetThumb, MediaChip, SideSheet, colorTokens, radiusTokens } from '@brandspace/ui';
import {
  aspectLabel,
  durationLabel,
  fill,
  fingerprint,
  formatCredits,
} from '../../../../server/composer-editor';
import type { MediaOptionView } from './media-picker';

/**
 * ADD MEDIA WITHOUT LEAVING THE POST (Phase 6 final, D-277 §25-§26, D-285).
 *
 * One side sheet, three ways in:
 *   - LIBRARY — the one Asset Library, this brand plus the shared shelf, READY
 *     and CLEAN only (the list the server already narrowed).
 *   - UPLOAD — the one upload pipeline (`uploadComposerMediaAction`): same
 *     permission, quota, signature check and scan. The file becomes choosable
 *     when its scan finishes, and the sheet says so rather than pretending.
 *   - GENERATE — the Creative Studio's own generation, grounded in the brand,
 *     quoted before it spends. The image is an ordinary Asset (AI_GENERATED)
 *     that goes through the same scan; the editor attaches it to this post the
 *     moment it is usable, so nobody walks Creative → Assets → Content.
 */
export interface CreativeFormatOption {
  readonly key: string;
  readonly label: string;
}

export function MediaDrawer({
  open,
  onClose,
  locale,
  t,
  itemId,
  brandId,
  options,
  attached,
  replacing,
  preferVertical,
  canUpload,
  canGenerate,
  creativeFormats,
  defaultPrompt,
  defaultFormat,
  uploadAction,
  onPick,
  onGenerated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly locale: string;
  readonly t: Record<string, string>;
  readonly itemId: string;
  readonly brandId: string;
  readonly options: readonly MediaOptionView[];
  readonly attached: readonly string[];
  readonly replacing: boolean;
  /** A Reel, Story or video: vertical media first. */
  readonly preferVertical: boolean;
  readonly canUpload: boolean;
  readonly canGenerate: boolean;
  readonly creativeFormats: readonly CreativeFormatOption[];
  readonly defaultPrompt: string;
  readonly defaultFormat: string;
  readonly uploadAction: (formData: FormData) => Promise<void>;
  readonly onPick: (assetId: string) => void;
  readonly onGenerated: (assetId: string) => void;
}) {
  const fieldId = useId();
  const [tab, setTab] = useState<'library' | 'upload' | 'generate'>('library');
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [formatKey, setFormatKey] = useState(defaultFormat);
  const [estimate, setEstimate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // One key per ask: a retry of the same prompt and format never bills twice.
  const [attempt] = useState(() => crypto.randomUUID());

  const sorted = useMemo(() => {
    // D-286: a lapsed licence is never offered, even when it is already attached.
    const offered = options.filter((option) => !option.rightsExpired);
    if (!preferVertical) return offered;
    const vertical = (option: MediaOptionView) =>
      option.width && option.height ? option.height > option.width : false;
    return [...offered].sort((a, b) => Number(vertical(b)) - Number(vertical(a)));
  }, [options, preferVertical]);

  const post = async (path: string, body: unknown) => {
    setFailure(null);
    const response = await fetch(`/api/creative/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const code = (payload as { error?: { code?: string } } | null)?.error?.code ?? '';
      setFailure(
        (code === 'QUOTA_EXCEEDED' ? t['content.error.quota'] : t['editor.media.generateFailed']) ??
          '',
      );
      return null;
    }
    return payload;
  };

  const tabs = [
    { key: 'library' as const, show: true },
    { key: 'upload' as const, show: canUpload && !replacing },
    { key: 'generate' as const, show: canGenerate },
  ].filter((entry) => entry.show);

  return (
    <SideSheet
      open={open}
      onClose={onClose}
      title={(replacing ? t['editor.media.replaceTitle'] : t['editor.media.drawerTitle']) ?? ''}
      description={t['editor.media.drawerBody']}
      closeLabel={t['editor.media.close'] ?? ''}
      testId="media-drawer"
    >
      <div role="tablist" aria-label={t['editor.media.drawerTitle']} className="cs-channel-row">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={tab === entry.key ? 'cs-channel selected' : 'cs-channel'}
            data-testid={`media-tab-${entry.key}`}
            onClick={() => setTab(entry.key)}
          >
            {t[`editor.media.tab.${entry.key}`]}
          </button>
        ))}
      </div>

      {tab === 'library' ? (
        sorted.length === 0 ? (
          <p className="cs-hint" data-testid="media-library-empty">
            {t['content.media.empty']}
          </p>
        ) : (
          <ul className="cs-media-grid" data-testid="media-library">
            {sorted.map((option) => {
              const already = attached.includes(option.id);
              const aspect = aspectLabel(option.width, option.height);
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    className="cs-media-choice"
                    disabled={already}
                    aria-pressed={already}
                    data-testid={`media-choose-${option.id}`}
                    onClick={() => onPick(option.id)}
                  >
                    <span style={{ position: 'relative', display: 'inline-block' }}>
                      {option.previewToken ? (
                        <AssetThumb
                          src={`/${locale}/assets/file/${option.previewToken}`}
                          alt=""
                          size="5rem"
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          style={{
                            display: 'inline-block',
                            inlineSize: '5rem',
                            blockSize: '5rem',
                            borderRadius: radiusTokens.sm,
                            background: colorTokens.surfaceMuted,
                          }}
                        />
                      )}
                      {option.kind === 'VIDEO' ? (
                        <MediaChip placement="start-end">
                          {durationLabel(option.durationMs) ?? t['content.media.video']}
                        </MediaChip>
                      ) : null}
                    </span>
                    <span className="cs-hint" style={{ marginTop: 0, overflowWrap: 'anywhere' }}>
                      {option.name}
                      {aspect ? ` · ${aspect}` : ''}
                      {option.shared ? ` · ${t['assets.filter.shared']}` : ''}
                    </span>
                    <b className="cs-hint" style={{ marginTop: 0 }}>
                      {already
                        ? t['editor.media.added']
                        : replacing
                          ? t['editor.media.use']
                          : t['editor.media.addThis']}
                    </b>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}

      {tab === 'upload' ? (
        <form action={uploadAction} className="cs-field" data-testid="composer-upload-form">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="itemId" value={itemId} />
          <label htmlFor={`${fieldId}-file`}>{t['content.media.uploadLabel']}</label>
          <input
            id={`${fieldId}-file`}
            type="file"
            name="file"
            required
            accept="image/*,video/*"
            data-testid="composer-upload-file"
          />
          <p className="cs-hint">{t['content.media.uploadNotice']}</p>
          <button type="submit" className="cs-dark-button" data-testid="composer-upload-submit">
            {t['content.media.uploadSubmit']}
          </button>
        </form>
      ) : null}

      {tab === 'generate' ? (
        <div className="cs-field" data-testid="media-generate">
          <label htmlFor={`${fieldId}-prompt`}>{t['editor.media.prompt']}</label>
          <textarea
            id={`${fieldId}-prompt`}
            value={prompt}
            maxLength={1_000}
            dir="auto"
            data-testid="media-generate-prompt"
            onChange={(event) => {
              setPrompt(event.target.value);
              setEstimate(null);
            }}
          />
          <label htmlFor={`${fieldId}-format`}>{t['editor.media.format']}</label>
          <select
            id={`${fieldId}-format`}
            value={formatKey}
            data-testid="media-generate-format"
            onChange={(event) => {
              setFormatKey(event.target.value);
              setEstimate(null);
            }}
          >
            {creativeFormats.map((format) => (
              <option key={format.key} value={format.key}>
                {format.label}
              </option>
            ))}
          </select>
          {estimate !== null ? (
            <p className="cs-hint" data-testid="media-generate-estimate">
              {fill(t['editor.media.estimate'] ?? '{credits}', {
                credits: formatCredits(estimate),
              })}
            </p>
          ) : null}
          {failure ? (
            <p className="cs-hint" role="alert">
              {failure}
            </p>
          ) : null}
          <div className="cs-form-actions">
            <button
              type="button"
              className="cs-ghost-button cs-compact"
              disabled={busy}
              data-testid="media-generate-quote"
              onClick={async () => {
                setBusy(true);
                const payload = await post('quote', { formatKey });
                if (payload) setEstimate(String(payload['estimateMilli'] ?? '0'));
                setBusy(false);
              }}
            >
              {t['content.composer.estimate']}
            </button>
            <button
              type="button"
              className="cs-dark-button"
              disabled={busy || prompt.trim() === ''}
              data-testid="media-generate-submit"
              onClick={async () => {
                setBusy(true);
                const payload = await post('generate', {
                  brandId,
                  brief: prompt.trim(),
                  formatKey,
                  idempotencyKey: `composer:${itemId}:${attempt}:${formatKey}:${fingerprint(prompt.trim())}`,
                });
                setBusy(false);
                if (payload && typeof payload['assetId'] === 'string') {
                  onGenerated(payload['assetId']);
                }
              }}
            >
              {busy ? t['content.composer.generating'] : t['editor.media.generate']}
            </button>
          </div>
          <p className="cs-hint">{t['editor.media.generateHint']}</p>
        </div>
      ) : null}
    </SideSheet>
  );
}
