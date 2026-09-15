'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useId, useMemo, useState } from 'react';

/**
 * The composer — a MECHANICAL PORT of the approved demo's `composer()`
 * (`demo/app-2.js`, pinned in docs/UI-FIDELITY-CONTRACT.md §3).
 *
 * The composition is the demo's: a `view-toolbar`, then a `composer` grid whose
 * first column is a `surface-card` carrying a `channel-row` of `channel`
 * buttons, a captioned `field` textarea, a two-up `form-row` and a right-aligned
 * `form-actions` pair. Every class is transcribed in
 * `@brandspace/ui/content-studio.css`; nothing is repositioned or recoloured.
 *
 * WHAT THE DEMO'S THIRD COLUMN WAS, AND WHY IT IS NOT HERE. `composer()` ends
 * with `copilotPanel()`, which is the AI Copilot — Phase 7, not this scope item.
 * Shipping its markup with nothing behind it would be a screen that lies about
 * what the product does. The grid therefore carries two tracks, and
 * docs/UI-FIDELITY-CONTRACT.md §4.1 records it.
 *
 * WHAT THE SECOND COLUMN CARRIES. The demo's is `socialPreview()` — a static
 * Instagram mock with a hard-coded sentence. It becomes the GENERATED VARIANTS:
 * the caption per channel, its live character count against that channel's own
 * configured limit, the validation the service computed, the sources retrieval
 * actually returned, and the five editing tools. Contract rule 5 — real data at
 * the prop boundary — and recorded as an extension inside a ported route.
 *
 * NOTHING ABOUT HOW IT WAS PRODUCED REACHES THIS FILE. There is no model key,
 * no provider name, no prompt and no request id in any prop below (AC-11.6).
 */

export type ContentLocale = 'AR' | 'EN';

export interface ComposerPlatform {
  readonly key: string;
  readonly label: string;
  readonly maxBodyChars: number;
  readonly maxHashtags: number;
}

export interface ComposerVariant {
  readonly id: string;
  readonly platformKey: string;
  readonly locale: ContentLocale;
  readonly body: string;
  readonly hashtags: readonly string[];
  readonly characterCount: number;
  readonly validationState: 'VALID' | 'WARNINGS' | 'INVALID';
}

export interface ComposerDraft {
  readonly id: string;
  readonly title: string;
  readonly status: 'DRAFT' | 'IN_REVIEW' | 'ARCHIVED';
  readonly brandId: string;
  readonly arabicDialect: string | null;
  readonly insufficientKnowledge: boolean;
  readonly citations: readonly { readonly label: string }[];
  readonly variants: readonly ComposerVariant[];
}

export interface ComposerViewProps {
  readonly locale: string;
  readonly t: Record<string, string>;
  readonly brands: readonly { id: string; name: string }[];
  readonly platforms: readonly ComposerPlatform[];
  readonly contentTypes: readonly string[];
  readonly maxBriefChars: number;
  readonly maxVariants: number;
  readonly draft: ComposerDraft | null;
  readonly can: { create: boolean; edit: boolean; submit: boolean; archive: boolean };
  readonly tools: readonly string[];
  readonly actions: {
    save(formData: FormData): Promise<void>;
    transition(formData: FormData): Promise<void>;
  };
}

/** The customer-safe codes the proxy and the API can return. */
const FAILURE_KEYS: Record<string, string> = {
  QUOTA_EXCEEDED: 'content.error.quota',
  VALIDATION_FAILED: 'content.error.invalid',
  NOT_FOUND: 'content.error.notFound',
};

export function ComposerView({
  locale,
  t,
  brands,
  platforms,
  contentTypes,
  maxBriefChars,
  maxVariants,
  draft,
  can,
  tools,
  actions,
}: ComposerViewProps) {
  const router = useRouter();
  const fieldId = useId();

  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');
  const [selected, setSelected] = useState<string[]>(() =>
    platforms[0] ? [platforms[0].key] : [],
  );
  const [brief, setBrief] = useState('');
  const [contentLocale, setContentLocale] = useState<ContentLocale>(locale === 'ar' ? 'AR' : 'EN');
  const [contentType, setContentType] = useState(contentTypes[0] ?? 'POST');
  const [busy, setBusy] = useState<null | 'quote' | 'generate' | string>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [toneArgument, setToneArgument] = useState('');

  /*
   * ONE IDEMPOTENCY KEY PER BRIEF, NOT PER CLICK.
   *
   * AC-11.2: a retried request must return the first draft and make no second
   * gateway call. A key minted inside the click handler would make every retry
   * a NEW request and bill twice for a response the browser simply lost. So the
   * key is derived from what was asked for — the brand, the brief, the channels
   * and the language — and changes only when the ask does.
   */
  const idempotencyKey = useMemo(() => {
    const material = JSON.stringify([
      brandId,
      brief,
      [...selected].sort(),
      contentLocale,
      contentType,
    ]);
    let hash = 0;
    for (let i = 0; i < material.length; i += 1) {
      hash = (Math.imul(31, hash) + material.charCodeAt(i)) | 0;
    }
    return `ui:${draft?.id ?? 'new'}:${(hash >>> 0).toString(36)}:${material.length}`;
  }, [brandId, brief, selected, contentLocale, contentType, draft?.id]);

  const post = useCallback(
    async (path: string, body: unknown): Promise<Record<string, unknown> | null> => {
      setFailure(null);
      const response = await fetch(`/api/content/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        const code = (payload as { error?: { code?: string } } | null)?.error?.code ?? 'INTERNAL';
        // A CODE from a closed set chooses the words. No server text, no
        // provider name and no stack ever reaches this screen (AC-11.6).
        const key = FAILURE_KEYS[code] ?? 'content.error.generic';
        setFailure(t[key] ?? t['content.error.generic'] ?? '');
        return null;
      }
      return payload;
    },
    [t],
  );

  const toggle = (key: string) => {
    setQuote(null);
    setSelected((current) =>
      current.includes(key)
        ? current.filter((k) => k !== key)
        : current.length >= maxVariants
          ? current
          : [...current, key],
    );
  };

  const runQuote = async () => {
    setBusy('quote');
    const payload = await post('quote', { brandId, brief, platformKeys: selected });
    if (payload) setQuote(String(payload['estimateMilli'] ?? '0'));
    setBusy(null);
  };

  const runGenerate = async () => {
    setBusy('generate');
    const payload = await post('generate', {
      brandId,
      brief,
      platformKeys: selected,
      locale: contentLocale,
      contentType,
      idempotencyKey,
    });
    setBusy(null);
    if (payload) {
      // The server component re-reads the draft under RLS. Navigating rather
      // than rendering the response is what keeps ONE source of truth for what
      // the draft says — the database, not a fetch result held in state.
      router.push(`/${locale}/content/compose?item=${String(payload['itemId'])}`);
      router.refresh();
    }
  };

  const runTool = async (variantId: string, tool: string) => {
    setBusy(`${variantId}:${tool}`);
    const payload = await post('tool', {
      variantId,
      tool,
      ...(tool === 'tone' && toneArgument ? { argument: toneArgument } : {}),
      ...(tool === 'translate'
        ? { targetLocale: draftVariantLocale(draft, variantId) === 'AR' ? 'EN' : 'AR' }
        : {}),
      idempotencyKey: `${idempotencyKey}:${tool}:${variantId}`,
    });
    setBusy(null);
    if (payload) router.refresh();
  };

  const briefTooLong = brief.length > maxBriefChars;
  const canGenerate =
    can.create && brandId !== '' && selected.length > 0 && brief.trim() !== '' && !briefTooLong;

  return (
    <div className="content-page" data-testid="content-composer">
      <div className="cs-view-toolbar">
        <div>
          <span className="cs-section-kicker">{t['content.composer.eyebrow']}</span>
          <h2>{draft ? draft.title : t['content.composer.title']}</h2>
        </div>
        <Link className="cs-ghost-button cs-compact" href={`/${locale}/content`}>
          {t['content.composer.back']}
        </Link>
      </div>

      {failure ? (
        <div className="cs-notice warning" role="alert" data-testid="content-failure">
          {failure}
        </div>
      ) : null}

      {/*
        A WORKSPACE WITH NO BRAND CANNOT GENERATE, AND SAYS SO.

        Generation is grounded in a brand's own Brand Brain, so without a brand
        there is nothing to write from and the controls below are correctly
        disabled. A disabled control with no stated reason is the failure mode
        this is here to avoid: a person who cannot tell WHY a button will not
        respond concludes the product is broken. The same honest empty state the
        Brand Brain screen shows, and it links to where the brand is created.
      */}
      {brands.length === 0 ? (
        <div className="cs-notice info" role="status" data-testid="content-no-brand">
          <b>{t['content.noBrand']}</b>
          <p>{t['content.noBrandBody']}</p>
          <Link className="cs-ghost-button cs-compact" href={`/${locale}/brand-brain`}>
            {t['content.noBrandAction']}
          </Link>
        </div>
      ) : null}

      {draft?.insufficientKnowledge ? (
        <div className="cs-notice warning" role="status" data-testid="content-insufficient">
          <b>{t['content.insufficient']}</b>
          <p>{t['content.insufficientBody']}</p>
        </div>
      ) : null}

      <div className="cs-composer">
        {/* ---------------------------------------------- the editor --- */}
        <section className="cs-surface-card">
          {brands.length > 1 ? (
            <div className="cs-field">
              <label htmlFor={`${fieldId}-brand`}>{t['content.composer.brand']}</label>
              <select
                id={`${fieldId}-brand`}
                value={brandId}
                onChange={(event) => {
                  setBrandId(event.target.value);
                  setQuote(null);
                }}
              >
                {brands.map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {brand.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="cs-field">
            {/* A group rather than a label: the control below is four buttons,
                and a `<label>` can name only one. */}
            <span id={`${fieldId}-channels`} className="cs-field-label">
              {t['content.composer.channels']}
            </span>
            <div
              className="cs-channel-row"
              role="group"
              aria-labelledby={`${fieldId}-channels`}
              aria-describedby={`${fieldId}-channels-hint`}
            >
              {platforms.map((platform) => {
                const on = selected.includes(platform.key);
                return (
                  <button
                    key={platform.key}
                    type="button"
                    className={on ? 'cs-channel selected' : 'cs-channel'}
                    aria-pressed={on}
                    data-testid="content-channel"
                    data-platform={platform.key}
                    onClick={() => toggle(platform.key)}
                  >
                    {platform.label}
                  </button>
                );
              })}
            </div>
            <p id={`${fieldId}-channels-hint`} className="cs-hint">
              {t['content.composer.channelsHint']}
            </p>
          </div>

          <div className="cs-field">
            <label htmlFor={`${fieldId}-brief`}>{t['content.composer.brief']}</label>
            <textarea
              id={`${fieldId}-brief`}
              value={brief}
              maxLength={maxBriefChars}
              placeholder={t['content.composer.briefPlaceholder']}
              data-testid="content-brief"
              onChange={(event) => {
                setBrief(event.target.value);
                setQuote(null);
              }}
            />
            <div className={briefTooLong ? 'cs-counter over' : 'cs-counter'}>
              <span>
                {brief.length} {t['content.composer.of']} {maxBriefChars}{' '}
                {t['content.composer.characters']}
              </span>
            </div>
          </div>

          <div className="cs-form-row">
            <div className="cs-field">
              <label htmlFor={`${fieldId}-language`}>{t['content.composer.language']}</label>
              <select
                id={`${fieldId}-language`}
                value={contentLocale}
                onChange={(event) => setContentLocale(event.target.value as ContentLocale)}
              >
                <option value="AR">{t['content.language.AR']}</option>
                <option value="EN">{t['content.language.EN']}</option>
              </select>
            </div>
            <div className="cs-field">
              <label htmlFor={`${fieldId}-type`}>{t['content.composer.contentType']}</label>
              <select
                id={`${fieldId}-type`}
                value={contentType}
                onChange={(event) => setContentType(event.target.value)}
              >
                {contentTypes.map((type) => (
                  <option key={type} value={type}>
                    {t[`content.type.${type}`] ?? type}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {quote !== null ? (
            <div className="cs-notice info" role="status" data-testid="content-quote">
              <b>
                {t['content.composer.quoteLabel']}: {formatCredits(quote)}{' '}
                {t['content.composer.quoteUnit']}
              </b>
              <p>{t['content.composer.quoteHint']}</p>
            </div>
          ) : null}

          <div className="cs-form-actions">
            <button
              type="button"
              className="cs-ghost-button"
              disabled={!canGenerate || busy !== null}
              data-testid="content-estimate"
              onClick={runQuote}
            >
              {t['content.composer.estimate']}
            </button>
            <button
              type="button"
              className="cs-dark-button"
              disabled={!canGenerate || busy !== null}
              data-testid="content-generate"
              onClick={runGenerate}
            >
              {busy === 'generate'
                ? t['content.composer.generating']
                : t['content.composer.generate']}
            </button>
          </div>
        </section>

        {/* ------------------------------------ the generated variants --- */}
        <section className="cs-surface-card" aria-live="polite" data-testid="content-results">
          <span className="cs-section-kicker">{t['content.composer.results']}</span>

          {draft === null || draft.variants.length === 0 ? (
            <p className="cs-empty">{t['content.composer.resultsEmpty']}</p>
          ) : (
            <>
              {draft.arabicDialect ? (
                <p className="cs-hint" data-testid="content-dialect">
                  {t['content.composer.dialect']}:{' '}
                  {t[`content.dialect.${draft.arabicDialect}`] ?? draft.arabicDialect}
                </p>
              ) : null}

              {draft.variants.map((variant) => {
                const platform = platforms.find((p) => p.key === variant.platformKey);
                const limit = platform?.maxBodyChars ?? 0;
                return (
                  <form
                    key={variant.id}
                    action={actions.save}
                    className="cs-field"
                    data-testid="content-variant"
                    data-platform={variant.platformKey}
                  >
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="itemId" value={draft.id} />
                    <input type="hidden" name="variantId" value={variant.id} />
                    <label htmlFor={`${fieldId}-${variant.id}`}>
                      {platform?.label ?? variant.platformKey}
                    </label>
                    <textarea
                      id={`${fieldId}-${variant.id}`}
                      name="body"
                      defaultValue={variant.body}
                      readOnly={!can.edit}
                    />
                    <div
                      className={
                        variant.validationState === 'INVALID' ? 'cs-counter over' : 'cs-counter'
                      }
                    >
                      <span>
                        {variant.characterCount} {t['content.composer.of']} {limit}{' '}
                        {t['content.composer.characters']}
                      </span>
                      <span data-testid="content-validation">
                        {t[`content.validation.${variant.validationState}`]}
                      </span>
                    </div>
                    {variant.hashtags.length > 0 ? (
                      <>
                        <label htmlFor={`${fieldId}-${variant.id}-tags`} className="cs-sr-only">
                          {t['content.composer.hashtags']}
                        </label>
                        <input
                          id={`${fieldId}-${variant.id}-tags`}
                          name="hashtags"
                          defaultValue={variant.hashtags.map((tag) => `#${tag}`).join(' ')}
                          readOnly={!can.edit}
                        />
                      </>
                    ) : null}

                    {can.edit ? (
                      <div className="cs-channel-row">
                        <button type="submit" className="cs-ghost-button cs-compact">
                          {t['content.composer.saveEdit']}
                        </button>
                        {tools.map((tool) => (
                          <button
                            key={tool}
                            type="button"
                            className="cs-channel"
                            disabled={busy !== null}
                            data-testid="content-tool"
                            data-tool={tool}
                            onClick={() => runTool(variant.id, tool)}
                          >
                            {busy === `${variant.id}:${tool}`
                              ? t['content.tool.running']
                              : t[`content.tool.${tool}`]}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </form>
                );
              })}

              {/* AC-11.4 — the sources RETRIEVAL returned, never the model's. */}
              {draft.citations.length > 0 ? (
                <div data-testid="content-citations">
                  <span className="cs-section-kicker">{t['content.composer.sources']}</span>
                  <div className="cs-citations">
                    {draft.citations.map((citation, index) => (
                      <span key={`${citation.label}-${index}`}>{citation.label}</span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="cs-form-actions">
                {can.submit && draft.status !== 'IN_REVIEW' ? (
                  <form action={actions.transition}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="itemId" value={draft.id} />
                    <input
                      type="hidden"
                      name="to"
                      value={draft.status === 'ARCHIVED' ? 'DRAFT' : 'IN_REVIEW'}
                    />
                    <button type="submit" className="cs-ghost-button cs-compact">
                      {draft.status === 'ARCHIVED'
                        ? t['content.composer.restore']
                        : t['content.composer.submit']}
                    </button>
                  </form>
                ) : null}
                {can.archive && draft.status !== 'ARCHIVED' ? (
                  <form action={actions.transition}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="itemId" value={draft.id} />
                    <input type="hidden" name="to" value="ARCHIVED" />
                    <button type="submit" className="cs-ghost-button cs-compact">
                      {t['content.composer.archive']}
                    </button>
                  </form>
                ) : null}
              </div>
            </>
          )}

          {can.edit && tools.includes('tone') && draft && draft.variants.length > 0 ? (
            <div className="cs-field">
              <label htmlFor={`${fieldId}-tone`}>{t['content.tool.toneArgument']}</label>
              <input
                id={`${fieldId}-tone`}
                value={toneArgument}
                onChange={(event) => setToneArgument(event.target.value)}
              />
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function draftVariantLocale(draft: ComposerDraft | null, variantId: string): ContentLocale {
  return draft?.variants.find((variant) => variant.id === variantId)?.locale ?? 'EN';
}

/**
 * Credits are accounted in MILLI-units and quoted to the customer in credits.
 *
 * Kept as a string end to end: the estimate crosses the wire as one because a
 * `bigint` has no JSON form, and turning it into a `number` here would put a
 * financial figure through a float for the sake of dividing by a thousand.
 */
function formatCredits(milli: string): string {
  const negative = milli.startsWith('-');
  const digits = (negative ? milli.slice(1) : milli).padStart(4, '0');
  const whole = digits.slice(0, -3).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(-3).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
