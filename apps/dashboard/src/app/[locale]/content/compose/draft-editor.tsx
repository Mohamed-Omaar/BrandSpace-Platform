'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  countCharacters,
  fill,
  formatCredits,
  inlineActionsFor,
  parseHashtags,
  previewFormatFor,
  variantIssues,
  type EditorIssue,
} from '../../../../server/composer-editor';
import { useRouter } from 'next/navigation';
import { SegmentPill, type MediaSeed } from '@brandspace/ui';
import { ChannelMark, PostArt } from '../../calendar/prototype-calendar';
import type { MediaOptionView } from './media-picker';
import { MediaSlides } from './media-slides';
import { InlineSchedule } from './inline-schedule';
import { MediaDrawer, type CreativeFormatOption } from './media-drawer';
import { VariantPreview, previewLabels } from './variant-preview';
import { MoreDisclosure } from '../../../../components/more-disclosure';
import { previewGeometry } from './preview-geometry';
import type {
  ComposerDraft,
  ComposerPlatform,
  ComposerVariant,
  VariantKnowledgeView,
} from './composer-view';

/**
 * THE DRAFT EDITOR — the prototype's Studio (`Main.dc.html` lines 329–537,
 * D-468 batch 2), wired to the post that exists.
 *
 * The composition is the prototype's: the banner for the post being edited,
 * the settings card (format, the channels it goes to, when, campaign), the
 * editor card with its Words and Design tabs beside the 380px preview card,
 * the per-channel checks, and the sticky bar with the status and the next
 * step. Every control the editor had keeps its behaviour and its test id:
 * one version per channel (the "Post to" chips are its tabs), inline AI
 * actions, friendly validation with the fix beside it, the media slides and
 * drawer, review, scheduling inline, templates and archive.
 *
 * NOTHING HERE WRITES WITHOUT A PERSON PRESSING SAVE. There is no background
 * autosave, deliberately: every save is audited, and a save of an APPROVED post
 * revokes its approval — something that must never happen because somebody
 * paused mid-sentence. What the editor does instead is say whether the words on
 * screen are saved, and stop a navigation that would lose them.
 */

export interface DraftEditorProps {
  readonly locale: string;
  /** Q9 (D-332): a channel whose account has expired — "Expired", and what it means. */
  readonly expiredChannels?: Readonly<
    Record<string, { readonly label: string; readonly explanation: string }>
  >;
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
    /** B-2 — "Duplicate" makes a new post, so it needs `content.create`. */
    create?: boolean;
    edit: boolean;
    submit: boolean;
    archive: boolean;
    manageCampaigns: boolean;
    /** Q21 — may file a post that has no campaign yet. */
    attachCampaign?: boolean;
    uploadMedia: boolean;
    schedule?: boolean;
    /** Q12 — may open the Brand Brain (`brand_brain.read`); a link otherwise refused. */
    readBrain?: boolean;
    /** Q12 — may add knowledge (`brand_brain.edit`), the onboarding "learn" step. */
    teachBrain?: boolean;
    /** E4 (Phase 2B-2) — may save this post as a template (`templates.manage`). */
    manageTemplates?: boolean;
    /** D10 (Phase 2C-3) — may rewrite with AI: `content.edit` AND `copilot.use`. */
    rewriteFacts?: boolean;
  };
  /**
   * B9 / F2 (Phase 2B-2) — what the inline date and time start from: the
   * workspace's today and tomorrow, and the brand's default time.
   */
  readonly scheduling?: {
    readonly today: string;
    readonly tomorrow: string;
    readonly defaultTime: string;
  } | null;
  /** Item 9 — a FAILED post: what the Publishing screen would say about it. */
  readonly failed?: { readonly message: string } | null;
  /** D-288 — the approval policy and a changes request, when there is one. */
  readonly review?: {
    readonly requiresApproval: boolean;
    /**
     * Q10 — who may be asked to review, default first (members before the
     * owner, never the author). Empty when the reader may not send for review.
     */
    readonly reviewers?: readonly { readonly userId: string; readonly name: string }[];
    readonly changes: {
      readonly note: string | null;
      readonly reviewer: string | null;
      readonly threadIds: readonly string[];
    } | null;
  } | null;
  /** The Creative Studio's formats, for "Generate with AI" in the media drawer. */
  readonly creativeFormats: readonly CreativeFormatOption[];
  readonly canGenerateMedia: boolean;
  /** An image carried from the Creative Studio: on the slides, unsaved. */
  readonly attach?: MediaOptionView | null;
  /** G6 (D-329): the ★ day the Studio was opened for; its Schedule link opens there. */
  readonly plannedDate?: string | null;
  readonly onTool: (variantId: string, tool: string, argument?: string) => void;
  readonly actions: {
    save(formData: FormData): Promise<void>;
    transition(formData: FormData): Promise<void>;
    submitForReview(formData: FormData): Promise<void>;
    cancelReview(formData: FormData): Promise<void>;
    setCampaign(formData: FormData): Promise<void>;
    uploadMedia(formData: FormData): Promise<void>;
    resubmit(formData: FormData): Promise<void>;
    duplicate?(formData: FormData): Promise<void>;
    /** B9 (Phase 2B-2) — schedule from here, inline. */
    scheduleFromStudio?(formData: FormData): Promise<void>;
    /** E4 (Phase 2B-2) — save this post as a template. */
    saveAsTemplate?(formData: FormData): Promise<void>;
    /** D10 (Phase 2C-3) — "Keep as is" on one changed fact. */
    keepFactChange?(formData: FormData): Promise<void>;
  };
}

interface LiveVariant {
  readonly version: string;
  readonly body: string;
  readonly hashtagText: string;
  readonly firstComment: string;
  readonly assetIds: readonly string[];
  readonly cover: string | null;
  /** B9 — slide headlines by image. */
  readonly headlines: Readonly<Record<string, string>>;
}

const headlinesOf = (variant: ComposerVariant): Record<string, string> =>
  Object.fromEntries((variant.slides ?? []).map((slide) => [slide.assetId, slide.headline]));

/** Only the headlines of images still on the slides, blank ones left out. */
const headlineKey = (headlines: Readonly<Record<string, string>>, assetIds: readonly string[]) =>
  assetIds
    .map((id) => [id, (headlines[id] ?? '').trim()] as const)
    .filter(([, headline]) => headline !== '')
    .map(([id, headline]) => `${id}:${headline}`)
    .join('|');

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
    headlines: headlinesOf(variant),
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
  plannedDate = null,
  expiredChannels = {},
  review = null,
  scheduling = null,
  failed = null,
  onTool,
  actions,
}: DraftEditorProps) {
  const router = useRouter();
  const fieldId = useId();
  // One copy per render of this post, however often "Duplicate" is clicked.
  const duplicateToken = `composer:${draft.id}:${draft.variants.map((v) => v.updatedAt).join(',')}`;
  const [active, setActive] = useState(draft.variants[0]?.id ?? '');
  const [compare, setCompare] = useState(false);
  const [toneArgument, setToneArgument] = useState('');
  // The prototype's Words / Design tabs; an image carried in opens on Design.
  const [tab, setTab] = useState<'words' | 'visual'>(attach ? 'visual' : 'words');
  const [whenOpen, setWhenOpen] = useState(false);

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
      value.cover !== (variant.coverAssetId ?? null) ||
      headlineKey(value.headlines, value.assetIds) !==
        headlineKey(headlinesOf(variant), variant.assetIds)
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

  /*
   * D10 (Phase 2C-3) — A FACT THIS CAPTION USED CHANGED, EXPIRED OR WAS
   * REMOVED. The banner lists the active variant's undismissed changes; its
   * Rewrite is priced by the SAME quote path the rewrite reserves against
   * (`/api/content/tool/quote`, tool `refresh_facts`) — never a fixed price.
   */
  const flaggedFacts: readonly VariantKnowledgeView[] =
    activeVariant?.knowledge?.filter((entry) => entry.flagged) ?? [];
  const [refreshEstimates, setRefreshEstimates] = useState<Readonly<Record<string, string>>>({});
  const refreshKey =
    activeVariant && flaggedFacts.length > 0
      ? `${activeVariant.id}:${activeVariant.updatedAt}:${flaggedFacts
          .map((entry) => entry.signature)
          .join(',')}`
      : '';
  const canQuoteRefresh = can.rewriteFacts === true && can.edit && refreshKey !== '';
  useEffect(() => {
    if (!canQuoteRefresh || !activeVariant || refreshKey in refreshEstimates) return;
    let current = true;
    fetch('/api/content/tool-quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ variantId: activeVariant.id, tool: 'refresh_facts' }),
    })
      .then(async (response) =>
        response.ok ? ((await response.json()) as { estimateMilli?: string }) : null,
      )
      .then((payload) => {
        if (current && payload?.estimateMilli) {
          setRefreshEstimates((all) => ({ ...all, [refreshKey]: String(payload.estimateMilli) }));
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [canQuoteRefresh, activeVariant, refreshKey, refreshEstimates]);
  const refreshEstimate = refreshEstimates[refreshKey];
  // "with the new fact" when a newer or replacement fact exists; otherwise "without".
  const rewriteWithNew = flaggedFacts.some(
    (entry) => entry.state === 'changed' || entry.state === 'replaced',
  );
  const factTitle = (entry: VariantKnowledgeView, which: 'used' | 'now' | 'new') =>
    (which === 'used' ? entry.usedTitle : which === 'new' ? entry.newTitle : entry.title) ??
    t['editor.facts.removedFact'] ??
    '';

  /*
   * Q10 — WHO TO ASK. "Automatic" sends the review to the default reviewer the
   * service picks (the first name below); choosing a name asks that person.
   * Either way anyone who may approve for the brand can decide it.
   */
  const reviewerPicker = (id: string) =>
    review?.reviewers && review.reviewers.length > 0 ? (
      <span className="bsp-chip bsp-st-rev">
        <label className="bsp-st-rev-label" htmlFor={`${fieldId}-${id}`}>
          {t['editor.reviewer.label']}
        </label>
        <select
          id={`${fieldId}-${id}`}
          className="bs-control bsp-st-rev-select"
          name="assignedToUserId"
          defaultValue=""
          data-testid={`${id}-reviewer`}
        >
          <option value="">
            {fill(t['editor.reviewer.auto'] ?? '{name}', { name: review.reviewers[0]?.name ?? '' })}
          </option>
          {review.reviewers.map((reviewer) => (
            <option key={reviewer.userId} value={reviewer.userId}>
              {reviewer.name}
            </option>
          ))}
        </select>
      </span>
    ) : null;

  const channelOf = (platformKey: string) => ({
    key: platformKey,
    name: platforms.find((p) => p.key === platformKey)?.label ?? platformKey,
  });
  const panelId = (variant: ComposerVariant) => `${fieldId}-panel-${variant.id}`;

  /*
   * WHAT EACH CHANNEL'S CHECK CARD SAYS — the same configured limits and the
   * same `variantIssues` the editor always validated with, read from the words
   * on screen. The rows are the prototype's caption, hashtags and media.
   */
  const checkOf = (variant: ComposerVariant) => {
    const platform = platforms.find((p) => p.key === variant.platformKey);
    const value = live(variant);
    const hashtags = parseHashtags(value.hashtagText);
    const media = mediaFor(value.assetIds);
    const issues = platform
      ? variantIssues(platform, draft.contentType, {
          body: value.body,
          hashtags,
          mediaKinds: media.map((option) => option.kind),
          expiredMedia: media.filter((option) => option.rightsExpired).length,
        })
      : [];
    const characters = countCharacters(value.body);
    const limit = platform?.maxBodyChars ?? 0;
    const has = (keys: readonly string[]) => issues.some((issue) => keys.includes(issue.key));
    return {
      platform,
      issues,
      hashtags,
      characters,
      limit,
      rows: [
        {
          key: 'caption',
          ok: !has(['editor.issue.empty', 'editor.issue.tooLong']),
          value: `${characters} / ${limit}`,
        },
        {
          key: 'tags',
          ok: !has(['editor.issue.tooManyHashtags']),
          value: `${hashtags.length} / ${platform?.maxHashtags ?? 0}`,
        },
        {
          key: 'media',
          ok: !issues.some(
            (issue) => issue.fix === 'media' || issue.key === 'editor.issue.tooMuchMedia',
          ),
          value: `${value.assetIds.length} / ${platform?.maxMediaItems ?? 0}`,
        },
      ],
    };
  };

  /* "Choose media" from a check: the Design tab of that channel, then its slides. */
  const focusMedia = (variant: ComposerVariant) => {
    setActive(variant.id);
    setTab('visual');
    window.setTimeout(() => document.getElementById(`${fieldId}-${variant.id}-media`)?.focus(), 0);
  };

  const mayScheduleHere = Boolean(
    can.schedule &&
    ((draft.status === 'DRAFT' && review && !review.requiresApproval) ||
      draft.status === 'APPROVED'),
  );
  const epTone = draft.readOnly ? 'pub' : (EP_TONE[draft.status] ?? 'draft');
  const firstMedia = activeVariant ? mediaFor(live(activeVariant).assetIds)[0] : undefined;
  const epArt = {
    src:
      firstMedia?.previewToken && firstMedia.kind !== 'VIDEO'
        ? `/${locale}/assets/file/${firstMedia.previewToken}`
        : null,
    seed: (draft.id.charCodeAt(0) % 6) as MediaSeed,
  };
  const activeValue = activeVariant ? live(activeVariant) : null;
  const activeDirty = activeVariant ? isDirty(activeVariant) : false;
  const statusLabel = t[`content.status.${draft.status}`] ?? draft.status;

  return (
    <div className="bsp-st" data-testid="draft-editor">
      {/*
        THE POST BEING EDITED — the prototype's banner for an existing post
        (`ep`): its picture, "Editing", its status, its title, and what that
        status means here, with the ways on. Every note is the product's own.
      */}
      <section className="bsp-st-ep" data-tone={epTone} data-testid="draft-context">
        <span className="bsp-st-ep-art" aria-hidden="true">
          <PostArt art={epArt} />
        </span>
        <span className="bsp-st-ep-copy">
          <span className="bsp-st-ep-kick">
            <span>{t['studio.editing']}</span>
            <span className={`bsp-xstatus ${XSTATUS[draft.status] ?? 'bsp-neu'}`}>
              {statusLabel}
            </span>
          </span>
          <span className="bsp-st-ep-title" dir="auto">
            {draft.title}
          </span>
          {attach && can.edit ? (
            <span className="bsp-st-ep-note" role="status" data-testid="editor-attached-media">
              {(t['editor.media.attached'] ?? '{name}').replace('{name}', attach.name)}
            </span>
          ) : null}
          {draft.readOnly ? (
            <span className="bsp-st-ep-note" role="note" data-testid="editor-published-readonly">
              {t['editor.published.readOnly']}
            </span>
          ) : null}
          {draft.status === 'IN_REVIEW' && can.edit ? (
            <span className="bsp-st-ep-note" role="note" data-testid="editor-in-review-warning">
              {t['editor.inReviewWarning']}
            </span>
          ) : null}
          {draft.status === 'APPROVED' && can.edit ? (
            <span className="bsp-st-ep-note" role="note" data-testid="editor-approved-warning">
              {t['editor.approvedWarning']}
            </span>
          ) : null}
          {/* Q8 — what saving does to a scheduled post depends on who saves it. */}
          {draft.status === 'SCHEDULED' && can.edit ? (
            <span className="bsp-st-ep-note" role="note" data-testid="editor-scheduled-warning">
              {can.schedule
                ? t['editor.scheduledWarning.scheduler']
                : t['editor.scheduledWarning.unschedules']}
            </span>
          ) : null}
          {draft.status === 'CHANGES_REQUESTED' ? (
            <span className="bsp-st-ep-note">{t['editor.lifecycle.changesRequested']}</span>
          ) : null}
          {/* The prototype's note line names the campaign the post is filed under. */}
          {draft.campaignId && campaigns.some((campaign) => campaign.id === draft.campaignId) ? (
            <span className="bsp-st-ep-note" data-testid="editor-campaign-note">
              {statusLabel} · {campaigns.find((campaign) => campaign.id === draft.campaignId)?.name}
            </span>
          ) : null}
          {review?.requiresApproval && draft.status === 'DRAFT' ? (
            <span className="bsp-st-ep-note" data-testid="editor-needs-approval">
              {t['editor.next.needsApproval']}
            </span>
          ) : null}
        </span>
        {draft.readOnly && can.create && actions.duplicate ? (
          <form action={actions.duplicate}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="itemId" value={draft.id} />
            <input type="hidden" name="token" value={duplicateToken} />
            <button type="submit" className="bsp-btn bsp-sm bsp-pur" data-testid="editor-duplicate">
              {t['content.action.duplicate']}
            </button>
          </form>
        ) : null}
        {can.submit && draft.status === 'IN_REVIEW' && draft.openApprovalId ? (
          <form action={actions.cancelReview}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="itemId" value={draft.id} />
            <input type="hidden" name="approvalId" value={draft.openApprovalId} />
            <button type="submit" className="bsp-btn bsp-sm" data-testid="withdraw-review">
              {t['content.composer.withdraw']}
            </button>
          </form>
        ) : null}

        {/*
          ITEM 9 (D-332 amended) — A POST THAT FAILED WITH NOTHING PUBLISHED.
          The late message the Publishing screen shows (when it was late), and
          the ways on: Reschedule (the calendar's dialog for this post) — or,
          where the brand requires approval, sending it for review again from
          the bar below — and "Make a new copy", which stays.
        */}
        {draft.status === 'FAILED' && failed ? (
          <div className="bsp-st-ep-more" role="note" data-testid="editor-failed-notice">
            <p className="bsp-st-ep-note">{failed.message}</p>
            <div className="bsp-st-ep-acts">
              {can.schedule && !review?.requiresApproval ? (
                <Link
                  className="bsp-btn bsp-sm"
                  href={`/${locale}/calendar?item=${draft.id}`}
                  data-testid="editor-reschedule"
                >
                  {t['editor.failed.reschedule']}
                </Link>
              ) : null}
              {review?.requiresApproval && can.submit ? (
                <span className="bsp-st-ep-note" data-testid="editor-failed-review-hint">
                  {t['editor.failed.reviewAgain']}
                </span>
              ) : null}
              {can.create && actions.duplicate ? (
                <form action={actions.duplicate}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="itemId" value={draft.id} />
                  <input type="hidden" name="token" value={duplicateToken} />
                  <button
                    type="submit"
                    className="bsp-btn bsp-sm bsp-sec"
                    data-testid="editor-failed-duplicate"
                  >
                    {t['content.action.duplicate']}
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        ) : null}

        {/*
          D-288 — CHANGES REQUESTED, AS ONE FLOW: the reviewer's reason,
          then "I made the changes" — an optional answer on their thread,
          the thread resolved, and the post sent for review again.
        */}
        {draft.status === 'CHANGES_REQUESTED' ? (
          <div className="bsp-st-ep-more" data-testid="changes-requested-panel">
            <b className="bsp-st-ep-sub">
              {review?.changes?.reviewer
                ? fill(t['editor.changes.by'] ?? '{name}', { name: review.changes.reviewer })
                : t['editor.changes.title']}
            </b>
            {review?.changes?.note ? (
              <p className="bsp-st-ep-note" dir="auto" data-testid="changes-requested-note">
                {review.changes.note}
              </p>
            ) : null}
            {can.submit ? (
              <form action={actions.resubmit} className="bsp-st-resubmit">
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="itemId" value={draft.id} />
                {(review?.changes?.threadIds ?? []).map((threadId) => (
                  <input key={threadId} type="hidden" name="threadId" value={threadId} />
                ))}
                <label className="bsp-st-label" htmlFor={`${fieldId}-resubmit`}>
                  {t['editor.changes.reply']}
                </label>
                <textarea
                  id={`${fieldId}-resubmit`}
                  className="bsp-st-input"
                  name="reply"
                  dir="auto"
                  maxLength={2_000}
                  data-testid="resubmit-reply"
                />
                <div className="bsp-st-ep-acts">
                  {reviewerPicker('resubmit')}
                  <button
                    type="submit"
                    className="bsp-btn bsp-sm bsp-pur"
                    disabled={anyDirty}
                    title={anyDirty ? t['editor.saveBeforeReview'] : undefined}
                    data-testid="resubmit-submit"
                  >
                    {t['editor.changes.resubmit']}
                  </button>
                </div>
              </form>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* -------------------------------------------- the settings card --- */}
      <section className="bsp-card bsp-st-set">
        <div className="bsp-st-f bsp-st-f5">
          <span className="bsp-lbl">{t['studio.format']}</span>
          {/*
            THE PROTOTYPE'S SWITCH (review of #67). The format is chosen when a
            post is written and is not changed afterwards, so the switch shows
            the post's format pressed and the others are not offered.
          */}
          <div
            className="bsp-seg bsp-st-seg-full"
            role="group"
            aria-label={t['studio.format']}
            data-testid="editor-format"
            data-value={draft.contentType}
          >
            <SegmentPill selector='[aria-pressed="true"]' />
            {[
              ...EDITOR_FORMATS,
              ...(EDITOR_FORMATS.includes(draft.contentType) ? [] : [draft.contentType]),
            ].map((type) => (
              <button
                key={type}
                type="button"
                className="bsp-seg-item"
                aria-pressed={type === draft.contentType}
                disabled={type !== draft.contentType}
                data-value={type}
              >
                {t[`content.type.${type}`] ?? type}
              </button>
            ))}
          </div>
          {draft.arabicDialect ? (
            <span className="bsp-st-hint" data-testid="content-dialect">
              {t['content.composer.dialect']} ·{' '}
              {t[`content.dialect.${draft.arabicDialect}`] ?? draft.arabicDialect}
            </span>
          ) : null}
        </div>
        <div className="bsp-st-f bsp-st-f7">
          <span className="bsp-lbl" id={`${fieldId}-postto`}>
            {t['studio.postTo']}
          </span>
          {draft.variants.length > 0 ? (
            <div
              role="tablist"
              aria-labelledby={`${fieldId}-postto`}
              className="bsp-st-chips"
              data-testid="variant-tabs"
            >
              {draft.variants.map((variant, index) => {
                const selected = variant.id === activeVariant?.id;
                const channel = channelOf(variant.platformKey);
                return (
                  <button
                    key={variant.id}
                    ref={(node) => {
                      tabRefs.current[variant.id] = node;
                    }}
                    type="button"
                    role="tab"
                    id={`${fieldId}-tab-${variant.id}`}
                    aria-controls={panelId(variant)}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className="bsp-chip"
                    data-testid={`variant-tab-${variant.platformKey}`}
                    onClick={() => setActive(variant.id)}
                    onKeyDown={(event) => onTabKey(event, index)}
                  >
                    <ChannelMark channel={channel} size={14} label={false} />
                    <span className="bsp-ltr">{channel.name}</span>
                    {isDirty(variant) ? <span aria-hidden="true"> •</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="bsp-st-f bsp-st-f4">
          <span className="bsp-lbl">{t['studio.when']}</span>
          <span className="bsp-st-anchor">
            <button
              type="button"
              className="bsp-chip bsp-st-wide"
              aria-haspopup="dialog"
              aria-expanded={whenOpen}
              data-testid="editor-when"
              onClick={() => setWhenOpen((open) => !open)}
            >
              <span className="bsp-st-when-label">
                <CalendarGlyph />
                <span>
                  {plannedDate ? (
                    <span className="bsp-ltr">{plannedDate}</span>
                  ) : draft.status === 'SCHEDULED' ? (
                    statusLabel
                  ) : (
                    t['studio.whenUnset']
                  )}
                </span>
              </span>
            </button>
            {/*
              THE PUBLISH TIME, where the prototype keeps it: the calendar's
              own date and time controls (B9 / F2), offered exactly where the
              Schedule step is, and the calendar for everything else.
            */}
            <div
              role="dialog"
              aria-label={t['studio.whenTitle']}
              className="bsp-st-when"
              hidden={!whenOpen}
            >
              <span className="bsp-st-when-title">{t['studio.whenTitle']}</span>
              {/*
                B9 / F2 (Phase 2B-2) — THE DATE AND TIME, INLINE, wherever the
                Schedule link is offered: the same states, the same
                permission, the same service call. The link stays for the
                calendar view.
              */}
              {scheduling &&
              actions.scheduleFromStudio &&
              can.schedule &&
              ((draft.status === 'DRAFT' && review && !review.requiresApproval) ||
                draft.status === 'APPROVED') ? (
                <InlineSchedule
                  locale={locale}
                  itemId={draft.id}
                  today={scheduling.today}
                  tomorrow={scheduling.tomorrow}
                  defaultTime={scheduling.defaultTime}
                  plannedDate={plannedDate}
                  disabled={anyDirty}
                  action={actions.scheduleFromStudio}
                  t={t}
                />
              ) : (
                <span className="bsp-st-when-note">
                  {review?.requiresApproval && draft.status === 'DRAFT'
                    ? t['editor.next.needsApproval']
                    : statusLabel}
                </span>
              )}
              <button
                type="button"
                className="bsp-btn bsp-sm bsp-st-end"
                onClick={() => setWhenOpen(false)}
              >
                {t['studio.whenDone']}
              </button>
            </div>
          </span>
        </div>
        <div className="bsp-st-f bsp-st-f4 bsp-st-c9">
          <span className="bsp-lbl">{t['campaigns.composerLabel']}</span>
          {/*
            Q21 — a post with no campaign may be filed by anyone who may create
            posts; moving or removing a campaign needs campaigns.manage.
          */}
          {can.manageCampaigns || (can.attachCampaign && draft.campaignId === null) ? (
            <form
              action={actions.setCampaign}
              className="bsp-st-inline"
              data-testid="content-campaign-form"
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="itemId" value={draft.id} />
              <select
                id={`${fieldId}-campaign`}
                name="campaignId"
                defaultValue={draft.campaignId ?? ''}
                aria-label={t['campaigns.composerLabel']}
                className="bs-control bsp-chip bsp-cal-select bsp-st-select"
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
                className="bsp-btn bsp-sm bsp-sec"
                data-testid="content-campaign-save"
              >
                {t['content.composer.saveEdit']}
              </button>
            </form>
          ) : (
            <span className="bsp-st-fixed">
              {campaigns.find((campaign) => campaign.id === draft.campaignId)?.name ??
                t['campaigns.composerNone']}
            </span>
          )}
        </div>
      </section>

      {draft.variants.length === 0 ? (
        <section className="bsp-card bsp-st-ed" aria-live="polite" data-testid="content-results">
          <p className="bsp-st-none">{t['content.composer.resultsEmpty']}</p>
        </section>
      ) : (
        <div className="bsp-st-grid">
          {/* ------------------------------------------------ the editor --- */}
          <section className="bsp-card bsp-st-ed" aria-live="polite" data-testid="content-results">
            <div className="bsp-seg" role="group" aria-label={t['editor.variants.label']}>
              <SegmentPill selector='[aria-pressed="true"]' />
              <button
                type="button"
                className="bsp-seg-item"
                aria-pressed={tab === 'words'}
                data-testid="studio-tab-words"
                onClick={() => setTab('words')}
              >
                {t['studio.tabWords']}
                {activeValue && activeValue.body.trim() !== '' ? (
                  <span className="bsp-st-ok"> ✓</span>
                ) : null}
              </button>
              <button
                type="button"
                className="bsp-seg-item"
                aria-pressed={tab === 'visual'}
                data-testid="studio-tab-visual"
                onClick={() => setTab('visual')}
              >
                {t['studio.tabVisual']}
                {activeValue && activeValue.assetIds.length > 0 ? (
                  <span className="bsp-st-ok"> ✓</span>
                ) : null}
              </button>
            </div>

            {draft.variants.map((variant) => {
              const platform = platforms.find((p) => p.key === variant.platformKey);
              const value = live(variant);
              const selected = variant.id === activeVariant?.id;
              const hashtags = parseHashtags(value.hashtagText);
              const { characters, limit } = checkOf(variant);
              const dirty = isDirty(variant);
              const toolButton = (action: (typeof actionsFor)[number]) => (
                <button
                  key={action.key}
                  type="button"
                  className="bsp-chip bsp-st-sm"
                  disabled={busy !== null || dirty}
                  data-testid="content-tool"
                  data-tool={action.tool}
                  data-action={action.key}
                  onClick={() =>
                    onTool(
                      variant.id,
                      action.tool,
                      action.tool === 'tone' ? (action.argument ?? toneArgument) : undefined,
                    )
                  }
                >
                  {busy === `${variant.id}:${action.tool}`
                    ? t['content.tool.running']
                    : t[`editor.ai.${action.key}`]}
                </button>
              );
              return (
                <form
                  key={variant.id}
                  id={panelId(variant)}
                  role="tabpanel"
                  aria-labelledby={`${fieldId}-tab-${variant.id}`}
                  hidden={!selected}
                  action={actions.save}
                  className="bsp-st-panel"
                  data-testid="content-variant"
                  data-platform={variant.platformKey}
                  onSubmit={() => {
                    dirtyRef.current = false;
                  }}
                >
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="itemId" value={draft.id} />
                  <input type="hidden" name="variantId" value={variant.id} />

                  <div className="bsp-st-words" hidden={tab !== 'words'}>
                    <div className="bsp-st-field">
                      <label className="bsp-st-label" htmlFor={`${fieldId}-${variant.id}`}>
                        {t['editor.caption']}
                      </label>
                      <textarea
                        id={`${fieldId}-${variant.id}`}
                        className="bsp-st-caption"
                        name="body"
                        value={value.body}
                        dir="auto"
                        readOnly={!can.edit}
                        onChange={(event) => change(variant, { body: event.target.value })}
                        aria-describedby={`${fieldId}-${variant.id}-count`}
                      />
                      <span
                        id={`${fieldId}-${variant.id}-count`}
                        className="bsp-st-count"
                        data-over={limit > 0 && characters > limit ? 'true' : undefined}
                      >
                        <span className="bsp-ltr">
                          {characters} / {limit}
                        </span>{' '}
                        ·{' '}
                        <span data-testid="content-validation">
                          {dirty
                            ? t['editor.unsaved']
                            : t[`content.validation.${variant.validationState}`]}
                        </span>
                      </span>
                      {/* §20 — small changes where the text is; no Copilot needed. */}
                      {can.edit && actionsFor.length > 0 ? (
                        <div
                          className="bsp-st-tools"
                          role="group"
                          aria-label={t['editor.ai.label']}
                          data-testid={`editor-ai-${variant.platformKey}`}
                        >
                          {/*
                            THE PROTOTYPE'S FOUR EDITS under the caption; the
                            product's others (rewrite, more detail, hashtags)
                            are the same buttons under "⋯" (review of #67).
                          */}
                          {actionsFor
                            .filter((action) => MAIN_TOOLS.includes(action.key))
                            .map(toolButton)}
                          {actionsFor.some((action) => !MAIN_TOOLS.includes(action.key)) ? (
                            <MoreDisclosure
                              label={t['editor.ai.more'] ?? ''}
                              testId={`editor-ai-more-${variant.platformKey}`}
                            >
                              <div className="bsp-st-chips">
                                {actionsFor
                                  .filter((action) => !MAIN_TOOLS.includes(action.key))
                                  .map(toolButton)}
                              </div>
                            </MoreDisclosure>
                          ) : null}
                          {!dirty && selected && estimate !== undefined ? (
                            <span
                              className="bsp-st-hint"
                              data-testid={`editor-estimate-${variant.platformKey}`}
                            >
                              {fill(t['editor.ai.estimate'] ?? '{credits}', {
                                credits: formatCredits(estimate),
                              })}
                            </span>
                          ) : (
                            <span className="bsp-st-hint">
                              {dirty ? t['editor.ai.saveFirst'] : t['editor.ai.hint']}
                            </span>
                          )}
                        </div>
                      ) : null}
                    </div>

                    {/*
                      THE HASHTAG FIELD IS ALWAYS RENDERED (PHASE 2 correction):
                      it is the only hashtag input in the product. The chips
                      above it are the same line, one tag each.
                    */}
                    <div className="bsp-st-tags">
                      <div className="bsp-st-tags-head">
                        <label className="bsp-st-label" htmlFor={`${fieldId}-${variant.id}-tags`}>
                          {t['content.composer.hashtags']}
                        </label>
                        <span className="bsp-st-tags-count bsp-ltr">
                          {hashtags.length} / {platform?.maxHashtags ?? 0}
                        </span>
                      </div>
                      <div className="bsp-st-tag-row">
                        {hashtags.map((tag) => (
                          <span key={tag} className="bsp-chip bsp-st-tag">
                            <bdi>#{tag}</bdi>
                            {can.edit ? (
                              <button
                                type="button"
                                className="bsp-st-tag-x"
                                aria-label={fill(t['studio.tagRemove'] ?? '{tag}', {
                                  tag: `#${tag}`,
                                })}
                                onClick={() =>
                                  change(variant, {
                                    hashtagText: hashtags
                                      .filter((other) => other !== tag)
                                      .map((other) => `#${other}`)
                                      .join(' '),
                                  })
                                }
                              >
                                ✕
                              </button>
                            ) : null}
                          </span>
                        ))}
                        {hashtags.length === 0 ? (
                          <span className="bsp-st-none">{t['studio.tagsNone']}</span>
                        ) : null}
                      </div>
                      <input
                        id={`${fieldId}-${variant.id}-tags`}
                        className="bsp-st-tag-input"
                        name="hashtags"
                        value={value.hashtagText}
                        placeholder={t['content.composer.hashtags']}
                        readOnly={!can.edit}
                        onChange={(event) => change(variant, { hashtagText: event.target.value })}
                        data-testid={`content-hashtags-${variant.platformKey}`}
                      />
                      {/*
                        FIRST COMMENT, ONLY WHERE THE PLATFORM ALLOWS ONE.
                        Elsewhere the stored value travels untouched as a
                        hidden field, so saving a caption never erases it.
                      */}
                      {platform?.allowsFirstComment ? (
                        <div className="bsp-st-field">
                          <label
                            className="bsp-st-label"
                            htmlFor={`${fieldId}-${variant.id}-comment`}
                          >
                            {t['editor.firstComment']}
                          </label>
                          <input
                            id={`${fieldId}-${variant.id}-comment`}
                            className="bsp-st-tag-input"
                            name="firstComment"
                            value={value.firstComment}
                            readOnly={!can.edit}
                            dir="auto"
                            onChange={(event) =>
                              change(variant, { firstComment: event.target.value })
                            }
                            data-testid={`content-first-comment-${variant.platformKey}`}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div
                    className="bsp-st-visual"
                    id={`${fieldId}-${variant.id}-media`}
                    tabIndex={-1}
                    hidden={tab !== 'visual'}
                  >
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
                      headlines={value.headlines}
                      onHeadlineChange={(assetId, headline) =>
                        change(variant, { headlines: { ...value.headlines, [assetId]: headline } })
                      }
                    />
                    {pending?.variantId === variant.id ? (
                      <p className="bsp-st-hint" role="status" data-testid="media-generating">
                        {pending.tries >= 40
                          ? t['editor.media.generateSlow']
                          : t['editor.media.generating']}
                      </p>
                    ) : null}
                  </div>
                </form>
              );
            })}

            {tab === 'words' ? (
              <>
                {can.edit && tools.includes('tone') ? (
                  <div className="bsp-st-field">
                    <label className="bsp-st-label" htmlFor={`${fieldId}-tone`}>
                      {t['content.tool.toneArgument']}
                    </label>
                    <div className="bsp-st-inline">
                      <input
                        id={`${fieldId}-tone`}
                        className="bsp-st-tag-input"
                        value={toneArgument}
                        onChange={(event) => setToneArgument(event.target.value)}
                      />
                      {activeVariant ? (
                        <button
                          type="button"
                          className="bsp-btn bsp-sm bsp-sec"
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

                {/*
                  D10 (Phase 2C-3) — A FACT THIS CAPTION USED CHANGED, EXPIRED
                  OR WAS REMOVED: the prototype's `capFix`. Old → new, old →
                  replacement, or "no longer valid for writing"; Rewrite
                  (quoted, never automatic) or Keep as is. The post is never
                  unscheduled and never blocked from publishing by this.
                */}
                {activeVariant && flaggedFacts.length > 0 && can.edit ? (
                  <div
                    className="bsp-st-capfix"
                    role="status"
                    data-testid="fact-change-banner"
                    data-variant={activeVariant.id}
                  >
                    <b>⚠ {t['editor.facts.bannerTitle']}</b>
                    {flaggedFacts.map((entry) => (
                      <div
                        key={entry.knowledgeItemId}
                        className="bsp-st-capfix-row"
                        data-testid={`fact-change-${entry.knowledgeItemId}`}
                        data-kind={entry.state}
                      >
                        <span className="bsp-st-area">{entry.areaLabel}</span>
                        {entry.state === 'changed' || entry.state === 'replaced' ? (
                          <span>
                            <s dir="auto">{factTitle(entry, 'used')}</s> →{' '}
                            <b dir="auto">{factTitle(entry, 'new')}</b>
                          </span>
                        ) : (
                          <span>
                            <s dir="auto">{factTitle(entry, 'used')}</s> ·{' '}
                            {entry.state === 'expired'
                              ? t['editor.facts.expiredInvalid']
                              : t['editor.facts.removedInvalid']}
                          </span>
                        )}
                        {actions.keepFactChange && entry.signature ? (
                          <form action={actions.keepFactChange}>
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="itemId" value={draft.id} />
                            <input type="hidden" name="variantId" value={activeVariant.id} />
                            <input
                              type="hidden"
                              name="knowledgeItemId"
                              value={entry.knowledgeItemId}
                            />
                            <input type="hidden" name="signature" value={entry.signature} />
                            <button
                              type="submit"
                              className="bsp-btn bsp-sm bsp-ghost"
                              data-testid={`fact-keep-${entry.knowledgeItemId}`}
                            >
                              {t['editor.facts.keep']}
                            </button>
                          </form>
                        ) : null}
                      </div>
                    ))}
                    {can.rewriteFacts ? (
                      <div className="bsp-st-inline">
                        <button
                          type="button"
                          className="bsp-btn bsp-sm bsp-pur"
                          disabled={
                            busy !== null || isDirty(activeVariant) || refreshEstimate === undefined
                          }
                          data-testid="fact-rewrite"
                          data-with-new={rewriteWithNew ? 'true' : 'false'}
                          onClick={() => onTool(activeVariant.id, 'refresh_facts')}
                        >
                          {busy === `${activeVariant.id}:refresh_facts`
                            ? t['content.tool.running']
                            : fill(
                                (rewriteWithNew
                                  ? t['editor.facts.rewriteNew']
                                  : t['editor.facts.rewriteWithout']) ?? '{credits}',
                                {
                                  credits:
                                    refreshEstimate === undefined
                                      ? '…'
                                      : formatCredits(refreshEstimate),
                                },
                              )}
                        </button>
                      </div>
                    ) : null}
                    {isDirty(activeVariant) ? (
                      <span className="bsp-st-hint">{t['editor.ai.saveFirst']}</span>
                    ) : null}
                  </div>
                ) : null}

                {/*
                  D9 (Phase 2C-3) — "USED N BRAND BRAIN FACTS", for the
                  variant on screen: the prototype's `bbUse` line. Exactly what
                  its current AI version recorded (M5), at the version it used,
                  and what each is now. Never read from the words.
                */}
                {activeVariant ? (
                  <section className="bsp-st-bb" data-testid="variant-facts">
                    <div className="bsp-st-bb-line">
                      <SparkGlyph />
                      <span data-testid="variant-facts-count">
                        {(activeVariant.knowledge?.length ?? 0) === 0
                          ? draft.brandBrainOn === false
                            ? t['editor.facts.off']
                            : t['editor.facts.none']
                          : (activeVariant.knowledge?.length ?? 0) === 1
                            ? t['editor.facts.usedOne']
                            : fill(t['editor.facts.used'] ?? '{count}', {
                                count: String(activeVariant.knowledge?.length ?? 0),
                              })}
                      </span>
                    </div>
                    {(activeVariant.knowledge?.length ?? 0) > 0 ? (
                      <div className="bsp-st-bb-list">
                        {(activeVariant.knowledge ?? []).map((entry) => (
                          <div
                            key={entry.knowledgeItemId}
                            className="bsp-st-bb-row"
                            data-testid={`variant-fact-${entry.knowledgeItemId}`}
                            data-state={entry.state}
                          >
                            <span className="bsp-st-area">{entry.areaLabel}</span>
                            <span dir="auto" className="bsp-st-grow">
                              <b>{factTitle(entry, 'now')}</b> · v{entry.usedVersion} ·{' '}
                              <span data-testid={`variant-fact-state-${entry.knowledgeItemId}`}>
                                {t[`editor.facts.state.${entry.state}`]}
                              </span>
                            </span>
                            {entry.fixHref ? (
                              <Link
                                className="bsp-st-link"
                                href={entry.fixHref}
                                data-testid={`variant-fact-fix-${entry.knowledgeItemId}`}
                              >
                                {t['editor.facts.fix']}
                              </Link>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </section>
                ) : null}

                {/*
                  §20 — THE BRAND BRAIN IS AUTOMATIC, AND SAYS SO QUIETLY. The
                  sources are what retrieval returned for this draft, never the
                  model's claims.
                */}
                <details className="bsp-st-bb" data-testid="draft-brain">
                  <summary className="bsp-st-bb-line bsp-st-summary">
                    {fill(t['editor.brain.using'] ?? '{brand}', { brand: brandName })}
                  </summary>
                  {draft.citations.length > 0 ? (
                    <div className="bsp-st-bb-list" data-testid="content-citations">
                      <span className="bsp-st-area">{t['editor.brain.basedOn']}</span>
                      {draft.citations.map((citation, index) => (
                        <span
                          key={`${citation.label}-${index}`}
                          className="bsp-st-bb-row"
                          dir="auto"
                        >
                          {citation.label}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="bsp-st-hint">{t['editor.brain.noSources']}</p>
                  )}
                  {can.readBrain ? (
                    <Link className="bsp-st-link" href={brainHref}>
                      {t['editor.brain.open']} →
                    </Link>
                  ) : null}
                </details>

                {draft.insufficientKnowledge ? (
                  <div className="bsp-st-capfix" role="status" data-testid="content-insufficient">
                    <b>{t['content.insufficient']}</b>
                    <span className="bsp-st-capfix-row">{t['editor.insufficientBody']}</span>
                    {/* Q12 — only the doors this member may walk through. */}
                    {can.teachBrain || can.readBrain ? (
                      <div className="bsp-st-inline">
                        {can.teachBrain ? (
                          <Link
                            className="bsp-btn bsp-sm bsp-sec"
                            href={`/${locale}/onboarding?step=learn`}
                          >
                            {t['editor.insufficient.add']}
                          </Link>
                        ) : null}
                        {can.readBrain ? (
                          <Link className="bsp-btn bsp-sm bsp-ghost" href={brainHref}>
                            {t['editor.brain.open']}
                          </Link>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </section>

          {/* ----------------------------------------------- the preview --- */}
          <section className="bsp-card bsp-st-prev" data-testid="draft-preview">
            <div className="bsp-st-prev-head">
              <span className="bsp-lbl">{t['studio.preview']}</span>
              {/*
                "Compare previews" — the product's, not the prototype's: under
                the one "⋯" at the end of the label row (review of #67).
              */}
              {draft.variants.length > 1 ? (
                <MoreDisclosure label={t['studio.moreOptions'] ?? ''} testId="preview-more">
                  <button
                    type="button"
                    className="bsp-chip bsp-st-sm"
                    aria-pressed={compare}
                    data-testid="preview-compare"
                    onClick={() => setCompare((value) => !value)}
                  >
                    {compare ? t['editor.preview.single'] : t['editor.preview.compare']}
                  </button>
                </MoreDisclosure>
              ) : null}
            </div>
            {draft.variants.length > 1 && !compare ? (
              <div
                className="bsp-seg bsp-st-seg-full"
                role="group"
                aria-label={t['studio.preview']}
              >
                <SegmentPill selector='[aria-pressed="true"]' />
                {draft.variants.map((variant) => {
                  const channel = channelOf(variant.platformKey);
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      aria-pressed={variant.id === activeVariant?.id}
                      title={channel.name}
                      className="bsp-ltr bsp-st-prev-tab"
                      data-testid={`preview-tab-${variant.platformKey}`}
                      onClick={() => setActive(variant.id)}
                    >
                      <ChannelMark channel={channel} size={13} label={false} />
                      <span>{channel.name}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {!compare && activeVariant ? (
              <span className="bsp-st-size bsp-ltr">
                {previewGeometry(draft.contentType, activeVariant.platformKey)}
              </span>
            ) : null}
            {compare
              ? draft.variants.map((variant) => (
                  <div key={variant.id}>
                    {previewOf(variant, `content-preview-${variant.platformKey}`)}
                  </div>
                ))
              : activeVariant
                ? previewOf(activeVariant, `content-preview-${activeVariant.platformKey}`)
                : null}
          </section>
        </div>
      )}

      {/* ------------------------------------------------- the checks --- */}
      {draft.variants.length > 0 ? (
        <section className="bsp-card bsp-st-checks" data-testid="studio-checks">
          <div className="bsp-st-checks-head">
            <span className="bsp-lbl">{t['studio.checks']}</span>
          </div>
          <div className="bsp-st-checks-grid">
            {draft.variants.map((variant) => {
              const check = checkOf(variant);
              const expired = expiredChannels[variant.platformKey];
              const bad = check.rows.some((row) => !row.ok);
              const channel = channelOf(variant.platformKey);
              return (
                <div
                  key={variant.id}
                  className="bsp-st-check"
                  data-testid={`studio-check-${variant.platformKey}`}
                >
                  <div className="bsp-st-check-head">
                    <span className="bsp-st-check-mark">
                      <ChannelMark channel={channel} size={14} label={false} />
                    </span>
                    <span className="bsp-ltr bsp-st-check-name">{channel.name}</span>
                    <span
                      className={`bsp-xstatus ${expired || bad ? 'bsp-warn' : ''} bsp-st-noshrink`}
                    >
                      {expired ? expired.label : bad ? t['studio.fix'] : t['studio.ready']}
                    </span>
                  </div>
                  {check.rows.map((row) => (
                    <div key={row.key} className="bsp-st-check-row" data-ok={row.ok}>
                      <span aria-hidden="true">{row.ok ? '✓' : '✕'}</span>
                      <span>{t[`studio.row.${row.key}`]}</span>
                      <span className="bsp-ltr" title={row.value}>
                        {row.value}
                      </span>
                    </div>
                  ))}
                  {/*
                    §21 — WHAT IS WRONG, IN WORDS, WITH THE FIX BESIDE IT. The
                    numbers are the platform's configured limits.
                  */}
                  {check.issues.length > 0 || expired ? (
                    <ul
                      className="bsp-st-issues"
                      data-testid={`editor-issues-${variant.platformKey}`}
                    >
                      {/*
                        Q9 (D-332) — THE ACCOUNT FOR THIS CHANNEL HAS EXPIRED. A
                        warning row in the list the Studio already has: the
                        short status, and what it means on its own line.
                      */}
                      {expiredChannels[variant.platformKey] ? (
                        <li
                          className="warning"
                          data-issue="channel.expired"
                          data-testid={`editor-channel-expired-${variant.platformKey}`}
                        >
                          <span>
                            <b>{expiredChannels[variant.platformKey]?.label}</b>
                            <span style={{ display: 'block' }}>
                              {expiredChannels[variant.platformKey]?.explanation}
                            </span>
                          </span>
                        </li>
                      ) : null}
                      {check.issues.map((issue) => (
                        <IssueRow
                          key={issue.key}
                          issue={issue}
                          t={t}
                          canFix={can.edit}
                          canShorten={tools.includes('shorten') && busy === null}
                          onShorten={() => onTool(variant.id, 'shorten')}
                          onMedia={() => focusMedia(variant)}
                        />
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/*
        THE PRODUCT'S OTHER WAYS ON, which the prototype's Studio does not
        draw (D-468 (c)): restore, save as template, archive.
      */}
      {(can.archive && draft.status === 'ARCHIVED') ||
      (can.manageTemplates && actions.saveAsTemplate) ||
      (can.archive && draft.status !== 'ARCHIVED') ? (
        <div className="bsp-st-more">
          {/* B-7 — restore is the other half of archive: `content.archive`. */}
          {can.archive && draft.status === 'ARCHIVED' ? (
            <form action={actions.transition}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="itemId" value={draft.id} />
              <input type="hidden" name="to" value="DRAFT" />
              <button type="submit" className="bsp-btn bsp-sm bsp-sec">
                {t['content.composer.restore']}
              </button>
            </form>
          ) : null}
          {can.manageTemplates && actions.saveAsTemplate ? (
            /*
             * E4 — SAVE AS TEMPLATE, a disclosure like Archive beside it:
             * the name is the one thing a template needs that the post
             * does not already say.
             */
            <details data-testid="save-as-template">
              <summary className="bsp-btn bsp-sm bsp-ghost">{t['editor.template.save']}</summary>
              <form action={actions.saveAsTemplate} className="bsp-st-disclosed">
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="itemId" value={draft.id} />
                <label className="bsp-st-label" htmlFor={`${fieldId}-template-name`}>
                  {t['editor.template.name']}
                </label>
                <input
                  id={`${fieldId}-template-name`}
                  className="bsp-st-tag-input"
                  name="name"
                  required
                  maxLength={80}
                  dir="auto"
                  data-testid="save-as-template-name"
                />
                <span className="bsp-st-hint">{t['editor.template.hint']}</span>
                <button
                  type="submit"
                  className="bsp-btn bsp-sm bsp-pur bsp-st-end"
                  data-testid="save-as-template-submit"
                >
                  {t['editor.template.confirm']}
                </button>
              </form>
            </details>
          ) : null}
          {can.archive && draft.status !== 'ARCHIVED' ? (
            /*
             * B8 — ARCHIVE ASKS FIRST, the same two steps as the Posts
             * menu: the disclosure opens the question, the button inside
             * answers it with the `intent` the server requires.
             */
            <details data-testid="archive-disclosure">
              <summary className="bsp-btn bsp-sm bsp-ghost">
                {t['content.composer.archive']}
              </summary>
              <form action={actions.transition} className="bsp-st-disclosed">
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="itemId" value={draft.id} />
                <input type="hidden" name="to" value="ARCHIVED" />
                <input type="hidden" name="intent" value="ARCHIVE" />
                <span className="bsp-st-hint">{t['content.archive.confirmBody']}</span>
                <button
                  type="submit"
                  className="bsp-btn bsp-sm bsp-st-end"
                  data-testid="archive-confirm"
                >
                  {t['content.archive.confirm']}
                </button>
              </form>
            </details>
          ) : null}
        </div>
      ) : null}

      {/* ---------------------------------------------- the sticky bar --- */}
      <div className="bsp-st-bar">
        <span
          className={`bsp-pill ${STATUS_PILL[draft.status] ?? 'bsp-p-neu'}`}
          data-testid="composer-status"
        >
          {statusLabel}
        </span>
        {activeVariant && can.edit ? (
          <span className="bsp-st-saved" data-testid={`editor-saved-${activeVariant.platformKey}`}>
            {activeDirty
              ? t['editor.unsaved']
              : fill(t['editor.saved'] ?? '{when}', {
                  when: relativeLabel(activeVariant.updatedAt, now, t),
                })}
          </span>
        ) : null}
        <span className="bsp-st-note">
          {anyDirty && can.submit && (draft.status === 'DRAFT' || draft.status === 'FAILED')
            ? t['editor.saveBeforeReview']
            : null}
        </span>
        {activeVariant && can.edit ? (
          <button
            type="submit"
            form={panelId(activeVariant)}
            className={activeDirty ? 'bsp-btn bsp-pur' : 'bsp-btn bsp-sec'}
            data-testid={`editor-save-${activeVariant.platformKey}`}
          >
            {t['content.composer.saveEdit']}
          </button>
        ) : null}
        {/*
          D-288 — THE NEXT STEP FOLLOWS THE BRAND'S POLICY. A brand that
          needs approval before scheduling asks for review first; one
          that does not goes straight to the calendar, and review stays
          available. An approved post's next step is always the calendar.
        */}
        {(draft.status === 'DRAFT' || draft.status === 'FAILED') && can.submit ? (
          <form action={actions.submitForReview} className="bsp-st-inline">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="itemId" value={draft.id} />
            {reviewerPicker('submit')}
            <button
              type="submit"
              className={review?.requiresApproval ? 'bsp-btn bsp-pur' : 'bsp-btn bsp-sec'}
              disabled={anyDirty}
              title={anyDirty ? t['editor.saveBeforeReview'] : undefined}
              data-testid="submit-for-review"
            >
              {t['content.composer.submit']}
            </button>
          </form>
        ) : null}
        {mayScheduleHere ? (
          <Link
            className="bsp-btn bsp-pur"
            href={`/${locale}/calendar?item=${draft.id}${plannedDate ? `&date=${plannedDate}` : ''}`}
            aria-disabled={anyDirty}
            data-testid="editor-schedule"
          >
            {t['editor.next.schedule']}
          </Link>
        ) : null}
      </div>

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

const STATUS_PILL: Readonly<Record<string, string>> = {
  DRAFT: 'bsp-p-neu',
  IN_REVIEW: 'bsp-p-warn',
  CHANGES_REQUESTED: 'bsp-p-warn',
  APPROVED: 'bsp-p-ok',
  SCHEDULED: 'bsp-p-info',
  ARCHIVED: 'bsp-p-neu',
  FAILED: 'bsp-p-bad',
};

const XSTATUS: Readonly<Record<string, string>> = {
  DRAFT: 'bsp-neu',
  IN_REVIEW: 'bsp-warn',
  CHANGES_REQUESTED: 'bsp-warn',
  APPROVED: '',
  SCHEDULED: 'bsp-info',
  ARCHIVED: 'bsp-neu',
  FAILED: 'bsp-bad',
};

/** The prototype's banner background per state (`EPV.bg`). */
const EP_TONE: Readonly<Record<string, string>> = {
  IN_REVIEW: 'review',
  SCHEDULED: 'sched',
  FAILED: 'failed',
};

/** The prototype's four formats (`Main.dc.html` line 341). */
const EDITOR_FORMATS: readonly string[] = ['POST', 'CAROUSEL', 'REEL', 'STORY'];
/** The prototype's four AI edits under the caption; the rest sit under "⋯". */
const MAIN_TOOLS: readonly string[] = ['shorten', 'friendlier', 'professional', 'translate'];

export function CalendarGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.25" y="5" width="17.5" height="16" rx="2" />
      <path d="M3.25 9.5h17.5M8 3v4M16 3v4" />
    </svg>
  );
}

export function SparkGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.5l-1.6-5.3L5 10.6 10.4 9z" />
    </svg>
  );
}

function IssueRow({
  issue,
  t,
  canFix,
  canShorten,
  onShorten,
  onMedia,
}: {
  readonly issue: EditorIssue;
  readonly t: Record<string, string>;
  readonly canFix: boolean;
  readonly canShorten: boolean;
  readonly onShorten: () => void;
  readonly onMedia: () => void;
}) {
  return (
    <li className={issue.severity === 'error' ? 'error' : 'warning'} data-issue={issue.key}>
      <span>{fill(t[issue.key] ?? issue.key, issue.values)}</span>
      {canFix && issue.fix === 'shorten' && canShorten ? (
        <button type="button" className="bsp-st-link" onClick={onShorten}>
          {t['editor.fix.shorten']}
        </button>
      ) : null}
      {canFix && issue.fix === 'media' ? (
        <button type="button" className="bsp-st-link" onClick={onMedia}>
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
