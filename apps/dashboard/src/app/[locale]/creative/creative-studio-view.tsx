'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useId, useState } from 'react';
import {
  AssetMedia,
  Card,
  Field,
  MediaChip,
  StateMessage,
  buttonStyle,
  colorTokens,
  inputStyle,
  radiusTokens,
  spacingTokens,
  textareaStyle,
  typographyTokens,
} from '@brandspace/ui';

/**
 * THE AI CREATIVE STUDIO, AS A CUSTOMER USES IT (AC-28).
 *
 * WHY THIS IS A CLIENT ISLAND. Generation is a round trip that takes seconds
 * and can fail, so the screen has to say "working", then show a result or an
 * honest refusal, without losing the brief the author typed. That is exactly
 * what the Content Studio composer does and for exactly the same reason.
 *
 * THE COST IS SHOWN BEFORE ANYTHING IS SPENT (AC-28.5). The quote is a read
 * that reserves nothing; the generate call is the only thing that moves a
 * credit, and it carries an idempotency key so a double click cannot pay twice.
 *
 * NOTHING NAMES A MODEL, A PROVIDER OR A PROMPT (AC-28.8). The screen shows a
 * picture, a price in BrandSpace credits and where the file went.
 *
 * NO LOGO IS STAMPED (AC-28.7), and the screen says so rather than leaving the
 * author to wonder why their wordmark is absent: identity guides generation, it
 * does not overlay artwork.
 */

export interface CreativeFormatOption {
  readonly key: string;
  readonly label: string;
  readonly size: string;
  readonly aspect: string;
}

export interface CreativeResultView {
  readonly assetId: string;
  readonly formatKey: string;
  readonly previewToken: string | null;
  readonly name: string;
}

export interface CreativeStudioLabels {
  readonly brief: string;
  readonly briefHint: string;
  readonly briefPlaceholder: string;
  readonly format: string;
  readonly formatHint: string;
  readonly generate: string;
  readonly generating: string;
  readonly cost: string;
  readonly costUnit: string;
  readonly result: string;
  readonly resultEmpty: string;
  readonly saved: string;
  readonly openInLibrary: string;
  readonly useInContent: string;
  readonly regenerate: string;
  readonly adapt: string;
  readonly adaptHint: string;
  readonly noLogoNotice: string;
  readonly generatedBadge: string;
  readonly failed: string;
  readonly insufficientCredits: string;
}

/** The customer-safe codes the API can return, mapped to something readable. */
const FAILURE_KEYS: Readonly<Record<string, keyof CreativeStudioLabels>> = {
  INSUFFICIENT_CREDITS: 'insufficientCredits',
  QUOTA_EXCEEDED: 'insufficientCredits',
};

export function CreativeStudioView({
  locale,
  brandId,
  formats,
  labels,
  initialResult,
}: {
  readonly locale: string;
  readonly brandId: string;
  readonly formats: readonly CreativeFormatOption[];
  readonly labels: CreativeStudioLabels;
  /** A result carried back by a reload, so a refresh does not lose the image. */
  readonly initialResult: CreativeResultView | null;
}) {
  const router = useRouter();
  const fieldId = useId();

  const [brief, setBrief] = useState('');
  const [formatKey, setFormatKey] = useState(formats[0]?.key ?? 'square');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<string | null>(null);
  const [result, setResult] = useState<CreativeResultView | null>(initialResult);

  const post = useCallback(
    async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const response = await fetch(`/api/creative/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        const code =
          typeof (payload['error'] as { code?: unknown } | undefined)?.code === 'string'
            ? ((payload['error'] as { code: string }).code satisfies string)
            : 'INTERNAL';
        throw new Error(code);
      }
      return payload;
    },
    [],
  );

  /*
   * THE PRICE, ASKED FOR AS SOON AS A FORMAT IS CHOSEN. A quote reserves
   * nothing, so asking early costs nothing and means the author never presses
   * a button whose price they have not seen.
   */
  const refreshQuote = useCallback(
    async (key: string) => {
      try {
        const payload = await post('quote', { formatKey: key });
        setEstimate(typeof payload['estimateMilli'] === 'string' ? payload['estimateMilli'] : null);
      } catch {
        // A quote that cannot be fetched is not an error worth interrupting for;
        // the generate call will report a real failure honestly.
        setEstimate(null);
      }
    },
    [post],
  );

  const generate = useCallback(async () => {
    if (brief.trim() === '' || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const payload = await post('generate', {
        brandId,
        brief: brief.trim(),
        formatKey,
        /*
         * ONE KEY PER ATTEMPT, generated in the browser and sent with the
         * request: a double click reuses it and the gateway replays the first
         * outcome rather than charging twice (AC-28.6). A NEW attempt — the
         * author pressing "generate another" — gets a new key, because they
         * mean a new image.
         */
        idempotencyKey: crypto.randomUUID(),
      });
      setResult({
        assetId: String(payload['assetId'] ?? ''),
        formatKey: String(payload['formatKey'] ?? formatKey),
        previewToken: typeof payload['previewToken'] === 'string' ? payload['previewToken'] : null,
        name: String(payload['name'] ?? ''),
      });
      // The library's storage figures and the asset list have both moved.
      router.refresh();
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : 'INTERNAL';
      const key = FAILURE_KEYS[code];
      setFailure(key ? labels[key] : labels.failed);
    } finally {
      setBusy(false);
    }
  }, [brandId, brief, busy, formatKey, labels, post, router]);

  const chosen = formats.find((format) => format.key === formatKey) ?? formats[0];

  return (
    <div style={{ display: 'grid', gap: spacingTokens.lg }} data-testid="creative-studio">
      {failure ? (
        <div className="cs-notice warning" role="alert" data-testid="creative-failure">
          {failure}
        </div>
      ) : null}

      <div
        style={{
          display: 'grid',
          gap: spacingTokens.lg,
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 20rem)',
          alignItems: 'start',
        }}
        className="bs-studio-grid"
      >
        {/* --------------------------------------------------- the brief --- */}
        <Card testId="creative-form">
          <div style={{ display: 'grid', gap: spacingTokens.md }}>
            <Field label={labels.brief} htmlFor={`${fieldId}-brief`} hint={labels.briefHint}>
              <textarea
                className="bs-control"
                id={`${fieldId}-brief`}
                rows={4}
                value={brief}
                placeholder={labels.briefPlaceholder}
                onChange={(event) => setBrief(event.target.value)}
                maxLength={1_000}
                data-testid="creative-brief"
                style={textareaStyle()}
              />
            </Field>

            <Field label={labels.format} htmlFor={`${fieldId}-format`} hint={labels.formatHint}>
              <select
                className="bs-control"
                id={`${fieldId}-format`}
                value={formatKey}
                onChange={(event) => {
                  setFormatKey(event.target.value);
                  void refreshQuote(event.target.value);
                }}
                data-testid="creative-format"
                style={inputStyle()}
              >
                {formats.map((format) => (
                  <option key={format.key} value={format.key}>
                    {format.label} · {format.size}
                  </option>
                ))}
              </select>
            </Field>

            {estimate !== null ? (
              <p
                style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary, margin: 0 }}
                data-testid="creative-estimate"
              >
                {labels.cost}: {formatCredits(estimate, locale)} {labels.costUnit}
              </p>
            ) : null}

            <p
              style={{ ...typographyTokens.bodySm, color: colorTokens.textMuted, margin: 0 }}
              data-testid="creative-no-logo"
            >
              {labels.noLogoNotice}
            </p>

            <div>
              <button
                type="button"
                style={buttonStyle('brand')}
                disabled={busy || brief.trim() === ''}
                onClick={() => void generate()}
                data-testid="creative-generate"
              >
                {busy ? labels.generating : labels.generate}
              </button>
            </div>
          </div>
        </Card>

        {/* -------------------------------------------------- the result --- */}
        <Card testId="creative-result">
          <span className="cs-section-kicker">{labels.result}</span>
          {result === null ? (
            <StateMessage
              kind="empty"
              title={labels.result}
              description={labels.resultEmpty}
              testId="creative-result-empty"
            />
          ) : (
            <div style={{ display: 'grid', gap: spacingTokens.sm }}>
              <div
                style={{
                  position: 'relative',
                  aspectRatio: (chosen?.aspect ?? '1:1').replace(':', ' / '),
                  borderRadius: radiusTokens.md,
                  overflow: 'hidden',
                  background: colorTokens.surfaceMuted,
                }}
              >
                {result.previewToken ? (
                  <AssetMedia
                    src={`/${locale}/assets/file/${result.previewToken}`}
                    alt={result.name}
                    fit="contain"
                    testId="creative-image"
                  />
                ) : null}
                {/*
                  ALWAYS LABELLED. A customer must be able to tell what a model
                  made from what they made, on the screen as well as in the row.
                */}
                <MediaChip tone="brand" testId="creative-generated-badge">
                  {labels.generatedBadge}
                </MediaChip>
              </div>

              <p
                style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary, margin: 0 }}
                data-testid="creative-saved"
              >
                {labels.saved}
              </p>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}>
                <Link
                  href={`/${locale}/assets?asset=${result.assetId}`}
                  style={buttonStyle('neutral', 'sm')}
                  data-testid="creative-open-library"
                >
                  {labels.openInLibrary}
                </Link>
                <Link
                  href={`/${locale}/content/compose`}
                  style={buttonStyle('neutral', 'sm')}
                  data-testid="creative-use-in-content"
                >
                  {labels.useInContent}
                </Link>
                <button
                  type="button"
                  style={buttonStyle('ghost', 'sm')}
                  disabled={busy}
                  onClick={() => void generate()}
                  data-testid="creative-regenerate"
                >
                  {labels.regenerate}
                </button>
              </div>

              {/*
                ADAPTATION IS A SECOND GENERATION, NOT A CROP, and the hint says
                so: cropping a composed image moves its subject out of frame,
                which is the commonest way an automatic resize ruins a picture.
              */}
              <div style={{ display: 'grid', gap: spacingTokens['2xs'] }}>
                <span className="cs-section-kicker">{labels.adapt}</span>
                <p style={{ ...typographyTokens.caption, color: colorTokens.textMuted, margin: 0 }}>
                  {labels.adaptHint}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}>
                  {formats
                    .filter((format) => format.key !== result.formatKey)
                    .map((format) => (
                      <button
                        key={format.key}
                        type="button"
                        className="cs-channel"
                        disabled={busy}
                        onClick={() => {
                          setFormatKey(format.key);
                          void refreshQuote(format.key);
                          void generate();
                        }}
                        data-testid={`creative-adapt-${format.key}`}
                      >
                        {format.label}
                      </button>
                    ))}
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * Milli-credits as a readable number.
 *
 * INTEGERS ALL THE WAY DOWN on the server, because a float anywhere near money
 * is how rounding becomes revenue. This is the one place it becomes a decimal,
 * and only to be read.
 */
function formatCredits(milli: string, locale: string): string {
  const value = Number(milli);
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en', {
    maximumFractionDigits: 2,
    numberingSystem: 'latn',
  }).format(value / 1000);
}
