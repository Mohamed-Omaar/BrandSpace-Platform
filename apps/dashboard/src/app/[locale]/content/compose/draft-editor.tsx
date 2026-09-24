'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  LIFECYCLE_PATH,
  countCharacters,
  fill,
  formatCredits,
  inlineActionsFor,
  lifecycleIndex,
  parseHashtags,
  previewFormatFor,
  variantIssues,
  type EditorIssue,
} from '../../../../server/composer-editor';
import { useRouter } from 'next/navigation';
import type { MediaOptionView } from './media-picker';
import { MediaSlides } from './media-slides';
import { MediaDrawer, type CreativeFormatOption } from './media-drawer';
import { VariantPreview, previewLabels } from './variant-preview';
import type { ComposerDraft, ComposerPlatform, ComposerVariant } from './composer-view';

/**
 * THE DRAFT EDITOR (Phase 6 final, D-277 §20-§22 and §27, D-284).
 *
 * Three columns once a post exists: CONTEXT (where the post stands, the Brand
 * Brain it was grounded in, its campaign), the EDITOR (one tab per platform
 * variant, the caption, hashtags and first comment, inline AI actions, friendly
 * validation with the fix beside it), and the LIVE PREVIEW (the approved
 * `SocialPostPreview`, in the post's own format, following every keystroke).
 *
 * AN APPROVED DESIGN-SYSTEM EXTENSION inside the ported composer: every control
 * keeps the port's classes (`cs-surface-card`, `cs-field`, `cs-channel`,
 * `cs-notice`, `cs-ghost-button`, `cs-dark-button`); the one addition is the
 * three-track grid, recorded in docs/UI-FIDELITY-CONTRACT.md §6.3.11.
 *
 * NOTHING HERE WRITES WITHOUT A PERSON PRESSING SAVE. There is no background
 * autosave, deliberately: every save is audited, and a save of an APPROVED post
 * revokes its approval — something that must never happen because somebody
 * paused mid-sentence. What the editor does instead is say whether the words on
 * screen are saved, and stop a navigation that would lose them.
 */

export interface DraftEditorProps {
  readonly locale: string;
  readonly t: Record<string, string>;
  readonly draft: ComposerDraft;
  readonly platforms: readonly ComposerPlatform[];
  readonly campaigns: readonly { id: string; name: string }[];
  readonly mediaOptions: readonly MediaOptionView[];
  readonly brandName: string;
  readonly brandHandle: string;
  readonly tools: readonly string[];
  readonly busy: string | null;
  readonly now: number;
  readonly can: {
    edit: boolean;
    submit: boolean;
    archive: boolean;
    manageCampaigns: boolean;
    uploadMedia: boolean;
  };
  /** The Creative Studio's formats, for "Generate with AI" in the media drawer. */
  readonly creativeFormats: readonly CreativeFormatOption[];
  readonly canGenerateMedia: boolean;
  /** An image carried from the Creative Studio: on the slides, unsaved. */
  readonly attach?: MediaOptionView | null;
  readonly onTool: (variantId: string, tool: string, argument?: string) => void;
  readonly actions: {
    save(formData: FormData): Promise<void>;
    transition(formData: FormData): Promise<void>;
    submitForReview(formData: FormData): Promise<void>;
    cancelReview(formData: FormData): Promise<void>;
    setCampaign(formData: FormData): Promise<void>;
    uploadMedia(formData: FormData): Promise<void>;
  };
}

interface LiveVariant {
  readonly version: string;
  readonly body: string;
  readonly hashtagText: string;
  readonly firstComment: string;
  readonly assetIds: readonly string[];
  readonly cover: string | null;
}

const hashtagTextOf = (variant: ComposerVariant) =>
  variant.hashtags.map((tag) => `#${tag}`).join(' ');

/** What is on screen for a variant: the local edit of THIS version, or the row. */
function liveOf(
  edits: Readonly<Record<string, LiveVariant>>,
  variant: ComposerVariant,
): LiveVariant {
  const edit = edits[variant.id];
  if (edit && edit.version === variant.updatedAt) return edit;
  return {
    version: variant.updatedAt,
    body: variant.body,
    hashtagText: hashtagTextOf(variant),
    firstComment: variant.firstComment ?? '',
    assetIds: variant.assetIds,
    cover: variant.coverAssetId ?? null,
  };
}

export function DraftEditor({
  locale,
  t,
  draft,
  platforms,
  campaigns,
  mediaOptions,
  brandName,
  brandHandle,
  tools,
  busy,
  now,
  can,
  creativeFormats,
  canGenerateMedia,
  attach = null,
  onTool,
  actions,
}: DraftEditorProps) {
  const router = useRouter();
  const fieldId = useId();
  const [active, setActive] = useState(draft.variants[0]?.id ?? '');
  const [compare, setCompare] = useState(false);
  const [toneArgument, setToneArgument] = useState('');

  /*
   * WHAT IS ON SCREEN, PER VARIANT. Keyed by the variant's `updatedAt`, so a
   * save or an AI edit that changed the row replaces the local copy — and a
   * copy for an older version is simply ignored rather than shown over the
   * newer words.
   */
  const [edits, setEdits] = useState<Readonly<Record<string, LiveVariant>>>(() => {
    if (!attach) return {};
    const seeded: Record<string, LiveVariant> = {};
    for (const variant of draft.variants) {
      const platform = platforms.find((p) => p.key === variant.platformKey);
      if (!platform || platform.maxMediaItems === 0) continue;
      const base = liveOf({}, variant);
      if (base.assetIds.includes(attach.id) || base.assetIds.length >= platform.maxMediaItems) {
        continue;
      }
      seeded[variant.id] = { ...base, assetIds: [...base.assetIds, attach.id] };
    }
    return seeded;
  });
  const live = (variant: ComposerVariant): LiveVariant => liveOf(edits, variant);
  const change = (variant: ComposerVariant, patch: Partial<LiveVariant>) =>
    setEdits((current) => ({ ...current, [variant.id]: { ...live(variant), ...patch } }));
  const isDirty = (variant: ComposerVariant): boolean => {
    const value = live(variant);
    return (
      value.body !== variant.body ||
      value.hashtagText.trim() !== hashtagTextOf(variant) ||
      value.firstComment !== (variant.firstComment ?? '') ||
      value.assetIds.join(',') !== variant.assetIds.join(',') ||
      value.cover !== (variant.coverAssetId ?? null)
    );
  };
  const anyDirty = draft.variants.some(isDirty);

  /*
   * DO NOT LOSE A DRAFT ON NAVIGATION (§27). A reload, a closed tab or a typed
   * address while words are unsaved asks first; the browser owns the wording.
   * Saving clears it, because the saved row becomes what is on screen.
   */
  const dirtyRef = useRef(anyDirty);
  useEffect(() => {
    dirtyRef.current = anyDirty;
  }, [anyDirty]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  /*
   * THE MEDIA DRAWER — for which variant, and whether it replaces a slide.
   */
  const [drawer, setDrawer] = useState<{ variantId: string; replace: number | null } | null>(null);
  /*
   * AN IMAGE GENERATED FROM THE DRAWER IS ATTACHED THE MOMENT IT IS USABLE.
   * It is an ordinary asset going through the same scan, so it is not in the
   * library list yet; the page is re-read every few seconds until it is, then
   * it joins the variant's slides (still unsaved, like any other change).
   */
  const [pending, setPending] = useState<{
    variantId: string;
    assetId: string;
    tries: number;
  } | null>(null);
  useEffect(() => {
    if (!pending) return;
    if (mediaOptions.some((option) => option.id === pending.assetId)) {
      const variant = draft.variants.find((row) => row.id === pending.variantId);
      if (variant) {
        setEdits((current) => {
          const base = liveOf(current, variant);
          if (base.assetIds.includes(pending.assetId)) return current;
          return {
            ...current,
            [variant.id]: { ...base, assetIds: [...base.assetIds, pending.assetId] },
          };
        });
      }
      setPending(null);
      return;
    }
    if (pending.tries >= 40) return;
    const timer = window.setTimeout(() => {
      setPending((current) => (current ? { ...current, tries: current.tries + 1 } : current));
      router.refresh();
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [pending, mediaOptions, router, draft.variants]);

  const drawerVariant = drawer
    ? draft.variants.find((variant) => variant.id === drawer.variantId)
    : undefined;

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = draft.variants.length;
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0 && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const rtl = document.documentElement.dir === 'rtl';
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? count - 1
          : (index + (rtl ? -step : step) + count) % count;
    const target = draft.variants[next];
    if (!target) return;
    setActive(target.id);
    tabRefs.current[target.id]?.focus();
  };

  const format = previewFormatFor(draft.contentType);
  const labels = useMemo(() => previewLabels(t), [t]);
  const actionsFor = inlineActionsFor(tools);
  const statusIndex = lifecycleIndex(draft.status);
  const brainHref = `/${locale}/brand-brain`;

  const mediaFor = (ids: readonly string[]) =>
    ids
      .map((id) => mediaOptions.find((option) => option.id === id))
      .filter((option): option is MediaOptionView => option !== undefined);

  const previewOf = (variant: ComposerVariant, testId: string) => {
    const value = live(variant);
    return (
      <VariantPreview
        locale={locale}
        platformKey={variant.platformKey}
        format={format}
        body={value.body}
        hashtags={parseHashtags(value.hashtagText)}
        media={mediaFor(value.assetIds)}
        cover={value.cover ? (mediaFor([value.cover])[0] ?? null) : null}
        accountName={brandName}
        accountHandle={brandHandle}
        status="DRAFT"
        approval={approvalStateOf(draft.status)}
        labels={labels}
        testId={testId}
      />
    );
  };

  const activeVariant =
    draft.variants.find((variant) => variant.id === active) ?? draft.variants[0];

  /*
   * §20 — WHAT AN AI EDIT WOULD COST, BEFORE IT RUNS. One quote per saved
   * version of the visible variant, through the same gateway quote the edit
   * itself reserves against. It reserves nothing. The edits differ only in one
   * directive line, so one figure is stated as "about" rather than seven calls.
   */
  const [estimates, setEstimates] = useState<Readonly<Record<string, string>>>({});
  const estimateKey = activeVariant ? `${activeVariant.id}:${activeVariant.updatedAt}` : '';
  const canQuote = can.edit && actionsFor.length > 0 && activeVariant !== undefined;
  useEffect(() => {
    if (!canQuote || !activeVariant || estimateKey in estimates) return;
    let current = true;
    fetch('/api/content/tool-quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ variantId: activeVariant.id, tool: 'rewrite' }),
    })
      .then(async (response) =>
        response.ok ? ((await response.json()) as { estimateMilli?: string }) : null,
      )
      .then((payload) => {
        if (current && payload?.estimateMilli) {
          setEstimates((all) => ({ ...all, [estimateKey]: String(payload.estimateMilli) }));
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [canQuote, activeVariant, estimateKey, estimates]);
  const estimate = estimates[estimateKey];

  return (
    <div className="cs-draft-layout" data-testid="draft-editor">
      {/* ------------------------------------------------ CONTEXT --- */}
      <aside className="cs-surface-card cs-draft-context" data-testid="draft-context">
        <span className="cs-section-kicker">{t['editor.context.title']}</span>

        {/* §27 — where the post stands, as a path rather than a word. */}
        <ol className="cs-lifecycle" aria-label={t['editor.lifecycle.label']}>
          {LIFECYCLE_PATH.map((step, index) => (
            <li
              key={step}
              className={
                index === statusIndex ? 'current' : index < statusIndex ? 'done' : undefined
              }
              aria-current={index === statusIndex ? 'step' : undefined}
            >
              {t[`content.status.${step}`] ?? step}
            </li>
          ))}
        </ol>
        <p className="cs-hint" data-testid="composer-status">
          {t[`content.status.${draft.status}`] ?? draft.status}
        </p>
        {draft.status === 'CHANGES_REQUESTED' ? (
          <p className="cs-hint">{t['editor.lifecycle.changesRequested']}</p>
        ) : null}

        <dl className="cs-draft-facts">
          <div>
            <dt>{t['content.composer.contentType']}</dt>
            <dd>{t[`content.type.${draft.contentType}`] ?? draft.contentType}</dd>
          </div>
          {draft.arabicDialect ? (
            <div data-testid="content-dialect">
              <dt>{t['content.composer.dialect']}</dt>
              <dd>{t[`content.dialect.${draft.arabicDialect}`] ?? draft.arabicDialect}</dd>
            </div>
          ) : null}
        </dl>

        {/*
          §20 — THE BRAND BRAIN IS AUTOMATIC, AND SAYS SO QUIETLY. The sources
          are what retrieval returned for this draft, never the model's claims.
        */}
        <details className="cs-brain" data-testid="draft-brain">
          <summary>{fill(t['editor.brain.using'] ?? '{brand}', { brand: brandName })}</summary>
          {draft.citations.length > 0 ? (
            <div data-testid="content-citations">
              <span className="cs-section-kicker">{t['editor.brain.basedOn']}</span>
              <div className="cs-citations">
                {draft.citations.map((citation, index) => (
                  <span key={`${citation.label}-${index}`}>{citation.label}</span>
                ))}
              </div>
            </div>
          ) : (
            <p className="cs-hint">{t['editor.brain.noSources']}</p>
          )}
          <Link className="cs-ghost-button cs-compact" href={brainHref}>
            {t['editor.brain.open']}
          </Link>
        </details>

        {draft.insufficientKnowledge ? (
          <div className="cs-notice warning" role="status" data-testid="content-insufficient">
            <b>{t['content.insufficient']}</b>
            <p>{t['editor.insufficientBody']}</p>
            <div className="cs-channel-row">
              <Link
                className="cs-ghost-button cs-compact"
                href={`/${locale}/onboarding?step=learn`}
              >
                {t['editor.insufficient.add']}
              </Link>
              <Link className="cs-ghost-button cs-compact" href={brainHref}>
                {t['editor.brain.open']}
              </Link>
            </div>
          </div>
        ) : null}

        {can.manageCampaigns ? (
          <form
            action={actions.setCampaign}
            className="cs-field"
            data-testid="content-campaign-form"
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="itemId" value={draft.id} />
            <label htmlFor={`${fieldId}-campaign`}>{t['campaigns.composerLabel']}</label>
            <select
              id={`${fieldId}-campaign`}
              name="campaignId"
              defaultValue={draft.campaignId ?? ''}
              data-testid="content-campaign"
            >
              <option value="">{t['campaigns.composerNone']}</option>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="cs-ghost-button cs-compact"
              data-testid="content-campaign-save"
            >
              {t['content.composer.saveEdit']}
            </button>
          </form>
        ) : null}
      </aside>

      {/* ------------------------------------------------- EDITOR --- */}
      <section
        className="cs-surface-card cs-draft-editor"
        aria-live="polite"
        data-testid="content-results"
      >
        {attach && can.edit ? (
          <div className="cs-notice info" role="status" data-testid="editor-attached-media">
            {(t['editor.media.attached'] ?? '{name}').replace('{name}', attach.name)}
          </div>
        ) : null}

        {draft.status === 'APPROVED' && can.edit ? (
          <div className="cs-notice warning" role="note" data-testid="editor-approved-warning">
            {t['editor.approvedWarning']}
          </div>
        ) : null}

        {draft.variants.length === 0 ? (
          <p className="cs-empty">{t['content.composer.resultsEmpty']}</p>
        ) : (
          <>
            <div
              role="tablist"
              aria-label={t['editor.variants.label']}
              className="cs-channel-row"
              data-testid="variant-tabs"
            >
              {draft.variants.map((variant, index) => {
                const selected = variant.id === activeVariant?.id;
                const platform = platforms.find((p) => p.key === variant.platformKey);
                return (
                  <button
                    key={variant.id}
                    ref={(node) => {
                      tabRefs.current[variant.id] = node;
                    }}
                    type="button"
                    role="tab"
                    id={`${fieldId}-tab-${variant.id}`}
                    aria-controls={`${fieldId}-panel-${variant.id}`}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className={selected ? 'cs-channel selected' : 'cs-channel'}
                    data-testid={`variant-tab-${variant.platformKey}`}
                    onClick={() => setActive(variant.id)}
                    onKeyDown={(event) => onTabKey(event, index)}
                  >
                    {platform?.label ?? variant.platformKey}
                    {isDirty(variant) ? <span aria-hidden="true"> •</span> : null}
                  </button>
                );
              })}
            </div>

            {draft.variants.map((variant) => {
              const platform = platforms.find((p) => p.key === variant.platformKey);
              const value = live(variant);
              const selected = variant.id === activeVariant?.id;
              const hashtags = parseHashtags(value.hashtagText);
              const issues = platform
                ? variantIssues(platform, draft.contentType, {
                    body: value.body,
                    hashtags,
                    mediaKinds: mediaFor(value.assetIds).map((option) => option.kind),
                  })
                : [];
              const characters = countCharacters(value.body);
              const limit = platform?.maxBodyChars ?? 0;
              const dirty = isDirty(variant);
              return (
                <form
                  key={variant.id}
                  id={`${fieldId}-panel-${variant.id}`}
                  role="tabpanel"
                  aria-labelledby={`${fieldId}-tab-${variant.id}`}
                  hidden={!selected}
                  action={actions.save}
                  className="cs-variant-panel"
                  data-testid="content-variant"
                  data-platform={variant.platformKey}
                  onSubmit={() => {
                    dirtyRef.current = false;
                  }}
                >
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="itemId" value={draft.id} />
                  <input type="hidden" name="variantId" value={variant.id} />

                  <div className="cs-field">
                    <label htmlFor={`${fieldId}-${variant.id}`}>{t['editor.caption']}</label>
                    <textarea
                      id={`${fieldId}-${variant.id}`}
                      name="body"
                      value={value.body}
                      dir="auto"
                      readOnly={!can.edit}
                      onChange={(event) => change(variant, { body: event.target.value })}
                      aria-describedby={`${fieldId}-${variant.id}-count`}
                    />
                    <div
                      id={`${fieldId}-${variant.id}-count`}
                      className={limit > 0 && characters > limit ? 'cs-counter over' : 'cs-counter'}
                    >
                      <span>
                        {characters} {t['content.composer.of']} {limit}{' '}
                        {t['content.composer.characters']}
                      </span>
                      <span data-testid="content-validation">
                        {dirty
                          ? t['editor.unsaved']
                          : t[`content.validation.${variant.validationState}`]}
                      </span>
                    </div>
                  </div>

                  {/*
                    §21 — WHAT IS WRONG, IN WORDS, WITH THE FIX BESIDE IT. The
                    numbers are the platform's configured limits.
                  */}
                  {issues.length > 0 ? (
                    <ul className="cs-issues" data-testid={`editor-issues-${variant.platformKey}`}>
                      {issues.map((issue) => (
                        <IssueRow
                          key={issue.key}
                          issue={issue}
                          t={t}
                          canFix={can.edit}
                          canShorten={tools.includes('shorten') && busy === null}
                          onShorten={() => onTool(variant.id, 'shorten')}
                          mediaTarget={`${fieldId}-${variant.id}-media`}
                        />
                      ))}
                    </ul>
                  ) : null}

                  {/*
                    THE HASHTAG FIELD IS ALWAYS RENDERED (PHASE 2 correction):
                    it is the only hashtag input in the product.
                  */}
                  <div className="cs-field">
                    <label htmlFor={`${fieldId}-${variant.id}-tags`}>
                      {t['content.composer.hashtags']}
                    </label>
                    <input
                      id={`${fieldId}-${variant.id}-tags`}
                      name="hashtags"
                      value={value.hashtagText}
                      placeholder={t['content.composer.hashtags']}
                      readOnly={!can.edit}
                      onChange={(event) => change(variant, { hashtagText: event.target.value })}
                      data-testid={`content-hashtags-${variant.platformKey}`}
                    />
                  </div>

                  {/*
                    FIRST COMMENT, ONLY WHERE THE PLATFORM ALLOWS ONE. Elsewhere
                    the stored value travels untouched as a hidden field, so
                    saving a caption never erases it.
                  */}
                  {platform?.allowsFirstComment ? (
                    <div className="cs-field">
                      <label htmlFor={`${fieldId}-${variant.id}-comment`}>
                        {t['editor.firstComment']}
                      </label>
                      <input
                        id={`${fieldId}-${variant.id}-comment`}
                        name="firstComment"
                        value={value.firstComment}
                        readOnly={!can.edit}
                        dir="auto"
                        onChange={(event) => change(variant, { firstComment: event.target.value })}
                        data-testid={`content-first-comment-${variant.platformKey}`}
                      />
                    </div>
                  ) : null}

                  <div id={`${fieldId}-${variant.id}-media`} tabIndex={-1}>
                    <MediaSlides
                      locale={locale}
                      t={t}
                      options={mediaOptions}
                      value={value.assetIds}
                      maxItems={platform?.maxMediaItems ?? 0}
                      numbered={draft.contentType === 'CAROUSEL' || value.assetIds.length > 1}
                      coverable={draft.contentType === 'REEL' || draft.contentType === 'VIDEO'}
                      cover={value.cover}
                      disabled={!can.edit}
                      testId={`content-media-${variant.platformKey}`}
                      onChange={(assetIds) => change(variant, { assetIds })}
                      onCoverChange={(cover) => change(variant, { cover })}
                      onOpenDrawer={(replace) => setDrawer({ variantId: variant.id, replace })}
                    />
                    {pending?.variantId === variant.id ? (
                      <p className="cs-hint" role="status" data-testid="media-generating">
                        {pending.tries >= 40
                          ? t['editor.media.generateSlow']
                          : t['editor.media.generating']}
                      </p>
                    ) : null}
                  </div>

                  {can.edit ? (
                    <>
                      {/* §20 — small changes where the text is; no Copilot needed. */}
                      {actionsFor.length > 0 ? (
                        <div
                          className="cs-channel-row"
                          role="group"
                          aria-label={t['editor.ai.label']}
                          data-testid={`editor-ai-${variant.platformKey}`}
                        >
                          {actionsFor.map((action) => (
                            <button
                              key={action.key}
                              type="button"
                              className="cs-channel"
                              disabled={busy !== null || dirty}
                              data-testid="content-tool"
                              data-tool={action.tool}
                              data-action={action.key}
                              onClick={() =>
                                onTool(
                                  variant.id,
                                  action.tool,
                                  action.tool === 'tone'
                                    ? (action.argument ?? toneArgument)
                                    : undefined,
                                )
                              }
                            >
                              {busy === `${variant.id}:${action.tool}`
                                ? t['content.tool.running']
                                : t[`editor.ai.${action.key}`]}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <p className="cs-hint">
                        {dirty ? t['editor.ai.saveFirst'] : t['editor.ai.hint']}
                      </p>
                      {!dirty && selected && estimate !== undefined ? (
                        <p
                          className="cs-hint"
                          data-testid={`editor-estimate-${variant.platformKey}`}
                        >
                          {fill(t['editor.ai.estimate'] ?? '{credits}', {
                            credits: formatCredits(estimate),
                          })}
                        </p>
                      ) : null}

                      <div className="cs-form-actions">
                        <span
                          className="cs-hint"
                          data-testid={`editor-saved-${variant.platformKey}`}
                        >
                          {dirty
                            ? t['editor.unsaved']
                            : fill(t['editor.saved'] ?? '{when}', {
                                when: relativeLabel(variant.updatedAt, now, t),
                              })}
                        </span>
                        <button
                          type="submit"
                          className={dirty ? 'cs-dark-button' : 'cs-ghost-button cs-compact'}
                          data-testid={`editor-save-${variant.platformKey}`}
                        >
                          {t['content.composer.saveEdit']}
                        </button>
                      </div>
                    </>
                  ) : null}
                </form>
              );
            })}

            <div className="cs-form-actions">
              {can.submit && draft.status === 'ARCHIVED' ? (
                <form action={actions.transition}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="itemId" value={draft.id} />
                  <input type="hidden" name="to" value="DRAFT" />
                  <button type="submit" className="cs-ghost-button cs-compact">
                    {t['content.composer.restore']}
                  </button>
                </form>
              ) : null}
              {can.submit && (draft.status === 'DRAFT' || draft.status === 'CHANGES_REQUESTED') ? (
                <form action={actions.submitForReview}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="itemId" value={draft.id} />
                  <button
                    type="submit"
                    className="cs-ghost-button cs-compact"
                    disabled={anyDirty}
                    title={anyDirty ? t['editor.saveBeforeReview'] : undefined}
                    data-testid="submit-for-review"
                  >
                    {t['content.composer.submit']}
                  </button>
                </form>
              ) : null}
              {can.submit && draft.status === 'IN_REVIEW' && draft.openApprovalId ? (
                <form action={actions.cancelReview}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="itemId" value={draft.id} />
                  <input type="hidden" name="approvalId" value={draft.openApprovalId} />
                  <button
                    type="submit"
                    className="cs-ghost-button cs-compact"
                    data-testid="withdraw-review"
                  >
                    {t['content.composer.withdraw']}
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

            {can.edit && tools.includes('tone') ? (
              <div className="cs-field">
                <label htmlFor={`${fieldId}-tone`}>{t['content.tool.toneArgument']}</label>
                <div className="cs-channel-row">
                  <input
                    id={`${fieldId}-tone`}
                    value={toneArgument}
                    onChange={(event) => setToneArgument(event.target.value)}
                  />
                  {activeVariant ? (
                    <button
                      type="button"
                      className="cs-channel"
                      disabled={
                        busy !== null || toneArgument.trim() === '' || isDirty(activeVariant)
                      }
                      data-testid="editor-custom-tone"
                      onClick={() => onTool(activeVariant.id, 'tone', toneArgument.trim())}
                    >
                      {t['content.tool.tone']}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>

      {/* ------------------------------------------------ PREVIEW --- */}
      <aside className="cs-surface-card cs-draft-preview" data-testid="draft-preview">
        <div className="cs-preview-head">
          <span className="cs-section-kicker">{t['editor.preview.title']}</span>
          {draft.variants.length > 1 ? (
            <button
              type="button"
              className="cs-ghost-button cs-compact"
              aria-pressed={compare}
              data-testid="preview-compare"
              onClick={() => setCompare((value) => !value)}
            >
              {compare ? t['editor.preview.single'] : t['editor.preview.compare']}
            </button>
          ) : null}
        </div>
        {compare
          ? draft.variants.map((variant) => (
              <div key={variant.id}>
                {previewOf(variant, `content-preview-${variant.platformKey}`)}
              </div>
            ))
          : activeVariant
            ? previewOf(activeVariant, `content-preview-${activeVariant.platformKey}`)
            : null}
      </aside>
      {drawerVariant ? (
        <MediaDrawer
          open
          onClose={() => setDrawer(null)}
          locale={locale}
          t={t}
          itemId={draft.id}
          brandId={draft.brandId}
          options={mediaOptions}
          attached={live(drawerVariant).assetIds}
          replacing={drawer?.replace !== null && drawer?.replace !== undefined}
          preferVertical={['REEL', 'STORY', 'VIDEO'].includes(draft.contentType)}
          canUpload={can.uploadMedia}
          canGenerate={canGenerateMedia && creativeFormats.length > 0}
          creativeFormats={creativeFormats}
          defaultPrompt={live(drawerVariant).body.slice(0, 1_000)}
          defaultFormat={
            ['REEL', 'STORY', 'VIDEO'].includes(draft.contentType) &&
            creativeFormats.some((format) => format.key === 'story')
              ? 'story'
              : (creativeFormats[0]?.key ?? '')
          }
          uploadAction={actions.uploadMedia}
          onPick={(assetId) => {
            const current = live(drawerVariant).assetIds;
            const replace = drawer?.replace ?? null;
            const next =
              replace === null
                ? [...current, assetId]
                : current.map((id, index) => (index === replace ? assetId : id));
            change(drawerVariant, { assetIds: next });
            setDrawer(null);
          }}
          onGenerated={(assetId) => {
            setPending({ variantId: drawerVariant.id, assetId, tries: 0 });
            setDrawer(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function IssueRow({
  issue,
  t,
  canFix,
  canShorten,
  onShorten,
  mediaTarget,
}: {
  readonly issue: EditorIssue;
  readonly t: Record<string, string>;
  readonly canFix: boolean;
  readonly canShorten: boolean;
  readonly onShorten: () => void;
  readonly mediaTarget: string;
}) {
  return (
    <li className={issue.severity === 'error' ? 'error' : 'warning'} data-issue={issue.key}>
      <span>{fill(t[issue.key] ?? issue.key, issue.values)}</span>
      {canFix && issue.fix === 'shorten' && canShorten ? (
        <button type="button" className="cs-ghost-button cs-compact" onClick={onShorten}>
          {t['editor.fix.shorten']}
        </button>
      ) : null}
      {canFix && issue.fix === 'media' ? (
        <button
          type="button"
          className="cs-ghost-button cs-compact"
          onClick={() => document.getElementById(mediaTarget)?.focus()}
        >
          {t['editor.fix.media']}
        </button>
      ) : null}
    </li>
  );
}

function approvalStateOf(
  status: ComposerDraft['status'],
): 'NOT_REQUIRED' | 'NEEDS_APPROVAL' | 'APPROVED' | 'CHANGES_REQUESTED' {
  switch (status) {
    case 'IN_REVIEW':
      return 'NEEDS_APPROVAL';
    case 'APPROVED':
      return 'APPROVED';
    case 'CHANGES_REQUESTED':
      return 'CHANGES_REQUESTED';
    default:
      return 'NOT_REQUIRED';
  }
}

/** "just now", "5 minutes ago", "3 hours ago", or the date. Server clock. */
function relativeLabel(iso: string, now: number, t: Record<string, string>): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return t['editor.when.now'] ?? '';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return fill(t['editor.when.minutes'] ?? '{n}', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return fill(t['editor.when.hours'] ?? '{n}', { n: hours });
  return fill(t['editor.when.days'] ?? '{n}', { n: Math.round(hours / 24) });
}
