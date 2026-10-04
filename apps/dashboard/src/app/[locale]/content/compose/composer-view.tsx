'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { SegmentPill } from '@brandspace/ui';
import { ChannelMark } from '../../calendar/prototype-calendar';
import { generationKeyFor, manualKeyFor } from './idempotency';
import type { MediaOptionView } from './media-picker';
import { DraftEditor } from './draft-editor';
import { formatCredits } from '../../../../server/composer-editor';

/**
 * The composer — the prototype's Studio (`Main.dc.html` lines 329–537, D-468
 * batch 2). Before a post exists it is the settings card (format, the channels
 * it goes to, template, language, goal, campaign), the editor card with the
 * brief beside the preview card, and the sticky bar with Estimate, Save
 * without AI and Write the draft. Once the post exists, `DraftEditor` is the
 * same Studio for that post.
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
  /** PHASE 8 — media items this platform accepts. Zero means no picker. */
  readonly maxMediaItems: number;
  /** PHASE 6 FINAL — whether the configured platform takes a first comment. */
  readonly allowsFirstComment?: boolean;
}

export interface ComposerVariant {
  readonly id: string;
  readonly platformKey: string;
  readonly locale: ContentLocale;
  readonly body: string;
  readonly hashtags: readonly string[];
  readonly characterCount: number;
  readonly validationState: 'VALID' | 'WARNINGS' | 'INVALID';
  /** PHASE 8 — the media attached to this variant, in the author's order. */
  readonly assetIds: readonly string[];
  /** PHASE 6 FINAL — the stored first comment, when there is one. */
  readonly firstComment?: string | null;
  /** PHASE 6 FINAL (D-285) — the cover image of a Reel or video. */
  readonly coverAssetId?: string | null;
  /** B9 (Phase 2B-2) — a carousel's slide headlines, `{ assetId, headline }`. */
  readonly slides?: readonly { readonly assetId: string; readonly headline: string }[];
  /** When the row last changed — the editor's "Saved …" and its version key. */
  readonly updatedAt: string;
  /**
   * D9 (Phase 2C-3) — the Brand Brain facts the CURRENT AI version of this
   * variant recorded (M5), with what became of each since (D10). Empty when
   * nothing was recorded: Brand Brain off, no fact, or a post from before.
   */
  readonly knowledge?: readonly VariantKnowledgeView[];
}

/** One recorded fact, as the Studio shows it (D9/D10). */
export interface VariantKnowledgeView {
  readonly knowledgeItemId: string;
  readonly areaLabel: string;
  /** The version the caption used. */
  readonly usedVersion: number;
  readonly state: 'current' | 'changed' | 'replaced' | 'expired' | 'removed';
  /** The fact's title now; null for a removed fact ("Removed fact"). */
  readonly title: string | null;
  /** The title of the version the caption used (old → new). */
  readonly usedTitle: string | null;
  /** For changed: the new title; for replaced: the replacement's. */
  readonly newTitle: string | null;
  /** The change's signature, for "Keep as is"; null when nothing changed. */
  readonly signature: string | null;
  /** An undismissed change on a post D10 acts on: the banner shows it. */
  readonly flagged: boolean;
  /** "Fix it" — Brand Brain Edit on this fact; null without `brand_brain.edit`. */
  readonly fixHref: string | null;
}

export interface ComposerDraft {
  readonly id: string;
  readonly title: string;
  /*
   * Q8 — SCHEDULED is here because the composer opens a scheduled post and
   * says what saving it will do; the read-only statuses arrive as `readOnly`.
   */
  readonly status:
    | 'DRAFT'
    | 'IN_REVIEW'
    | 'CHANGES_REQUESTED'
    | 'APPROVED'
    | 'SCHEDULED'
    | 'ARCHIVED'
    /* Item 9 — a post that failed with nothing published, which may go on again. */
    | 'FAILED';
  /** Phase 5B-3 — the open review, when there is one. */
  readonly openApprovalId: string | null;
  readonly brandId: string;
  /** The post's format (POST, REEL, …) — what the preview is drawn as. */
  readonly contentType: string;
  /** PHASE 8 — the campaign this draft is filed under, when it is. */
  readonly campaignId: string | null;
  readonly arabicDialect: string | null;
  readonly insufficientKnowledge: boolean;
  readonly citations: readonly { readonly label: string }[];
  readonly variants: readonly ComposerVariant[];
  /** D9 — whether the brand's "Use Brand Brain" is on (the Studio's off notice). */
  readonly brandBrainOn?: boolean;
  /**
   * B-2 — publishing or published: a record of what was sent. Opened
   * read-only, with "Duplicate" as the way to a new version.
   */
  readonly readOnly?: boolean;
}

/**
 * E4 / B2 — a post template offered on a NEW post, already narrowed server-side
 * to the brand being composed for and the member's BrandScope. Choosing one
 * prefills the format and channels, and — only when writing it yourself — the
 * caption. Its hashtags and first comment are applied by the server to the
 * draft it creates, never through a prompt.
 */
export interface ComposerTemplate {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly contentType: string;
  readonly platformKeys: readonly string[];
  readonly body: string | null;
  readonly hashtags: readonly string[];
  readonly firstComment: string | null;
}

export interface ComposerViewProps {
  readonly locale: string;
  readonly t: Record<string, string>;
  /**
   * `defaultLocale` is the brand's CONTENT language preference — what a new
   * post is written in when the author has not chosen (D-277). Never the UI
   * locale: a team may run an Arabic-speaking brand from an English interface.
   */
  readonly brands: readonly {
    id: string;
    name: string;
    defaultLocale?: 'AR' | 'EN';
    /** A10 (Phase 2B-2) — the channels a new post for this brand starts with. */
    defaultPlatformKeys?: readonly string[];
  }[];
  /**
   * The globally selected brand, or null when the rail is on "All brands".
   *
   * NEW CONTENT TAKES THE GLOBAL SELECTION (D-190); an EXISTING draft takes its
   * own stored `brandId` and nothing can reinterpret it, because the global
   * context is a filter over what you are looking at and never a re-parenting
   * of what already exists.
   */
  readonly defaultBrandId: string | null;
  readonly platforms: readonly ComposerPlatform[];
  /**
   * PHASE 8 — the media this draft's brand may use (AC-27.2).
   *
   * Resolved SERVER-SIDE from the one Asset Library, already narrowed to the
   * brand plus the shared shelf and to READY/CLEAN rows, each with its own
   * expiring preview grant. An option this list does not carry cannot be
   * offered, and the save path re-resolves every id anyway.
   */
  readonly mediaOptions: readonly MediaOptionView[];
  /**
   * PHASE 6 FINAL (D-285) — an image brought from the Creative Studio, already
   * checked by the server. Offered on the draft's slides, unsaved.
   */
  readonly carriedMedia?: MediaOptionView | null;
  /** G6 (D-329): the day a ★ holiday chip opened the Studio for, `YYYY-MM-DD`. */
  readonly plannedDate?: string | null;
  /** Q9 (D-332): a channel whose account has expired — "Expired", and what it means. */
  readonly expiredChannels?: Readonly<
    Record<string, { readonly label: string; readonly explanation: string }>
  >;
  /** G6 (D-329): what that day is, in the reader's language. */
  readonly plannedFor?: string | null;
  readonly contentTypes: readonly string[];
  readonly maxBriefChars: number;
  readonly maxVariants: number;
  readonly draft: ComposerDraft | null;
  /**
   * PHASE 8 — the campaigns this draft could be filed under (AC-26.3).
   *
   * ALREADY NARROWED TO THE DRAFT'S OWN BRAND and to the member's BrandScope by
   * the server: a list this component filtered would be a list it had already
   * been handed, and the action re-checks both halves anyway.
   */
  readonly campaigns: readonly { id: string; name: string }[];
  readonly can: {
    create: boolean;
    edit: boolean;
    submit: boolean;
    archive: boolean;
    manageCampaigns: boolean;
    /** Q21 — may file a post that has no campaign (`content.create` or `campaigns.manage`). */
    attachCampaign?: boolean;
    uploadMedia: boolean;
    /** D-288 — may put this post on the calendar (`content.schedule`). */
    schedule?: boolean;
    /** Creative generation from the media drawer (`assets.upload`, AI credits). */
    generateMedia?: boolean;
    /**
     * Q18 — may spend credits writing a post (`content.create` AND
     * `copilot.use`). Without it the estimate and generate buttons are not
     * offered; writing it yourself still is.
     */
    generate?: boolean;
    /** Q12 — may open the Brand Brain (`brand_brain.read`); a link otherwise refused. */
    readBrain?: boolean;
    /** Q12 — may add knowledge (`brand_brain.edit`), the onboarding "learn" step. */
    teachBrain?: boolean;
    /** E4 (Phase 2B-2) — may save a post as a template (`templates.manage`). */
    manageTemplates?: boolean;
    /** D10 (Phase 2C-3) — may rewrite a caption whose fact changed (`content.edit` + `copilot.use`). */
    rewriteFacts?: boolean;
  };
  /** Item 9 (Phase 2B-2) — a FAILED post: what the Publishing screen would say about it. */
  readonly failed?: { readonly message: string } | null;
  /** B9 / F2 (Phase 2B-2) — today, tomorrow and the default time, for inline scheduling. */
  readonly scheduling?: {
    readonly today: string;
    readonly tomorrow: string;
    readonly defaultTime: string;
  } | null;
  readonly tools: readonly string[];
  /** PHASE 6 FINAL (D-285) — the Creative Studio's sizes, for the media drawer. */
  readonly creativeFormats?: readonly { key: string; label: string }[];
  /**
   * PHASE 6 FINAL (D-288) — the brand's approval policy and, after changes were
   * requested, the reviewer's reason and the thread it opened.
   */
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
  /** The server's clock at render, for "Saved 5 minutes ago". */
  readonly now?: number;
  /**
   * PHASE 6 FINAL — HOW THE PERSON CHOSE TO START (D-277 §17, D-283).
   *
   * `ai` makes Generate the primary action; `write` makes Save draft primary
   * and the text field the post itself. Both verbs stay on screen in both, so
   * nobody is locked into the path they picked a moment ago.
   */
  readonly mode?: 'ai' | 'write';
  /** A brief the reader arrived with — an idea, or a post being repurposed. */
  readonly initialBrief?: string;
  /** The campaign the reader came from, already checked against `campaigns`. */
  readonly initialCampaignId?: string;
  /** The post being repurposed, named so the reader knows what the brief holds. */
  readonly sourceTitle?: string | null;
  /** §19 — the post's goal. Steers the words; travels in the brief only. */
  readonly goals?: readonly { key: string; label: string }[];
  /** The goal recommended from the brand's own first goal (D-278), or null. */
  readonly recommendedGoal?: string | null;
  /** D-295 — this member's accepted defaults for the brand, with "Stop using". */
  readonly authorDefaults?: readonly { key: string; label: string }[];
  readonly defaultsBrandId?: string;
  readonly forgetDefault?: (formData: FormData) => Promise<void>;
  readonly initialGoal?: string;
  /**
   * §18 — for each format, the platforms whose ENABLED provider can carry it
   * (the publishing capability registry). A format with no entry is not
   * offered; a platform that cannot carry the chosen format cannot be picked.
   * Absent means "no registry answer": every format, every platform.
   */
  readonly formatPlatforms?: Readonly<Record<string, readonly string[]>>;
  /** E4 / B2 — the templates of `defaultBrandId`, the default first. */
  readonly templates?: readonly ComposerTemplate[];
  /** E4 / B2 — a template the reader arrived with (`?template=`), already checked. */
  readonly initialTemplateId?: string;
  readonly actions: {
    save(formData: FormData): Promise<void>;
    transition(formData: FormData): Promise<void>;
    submitForReview(formData: FormData): Promise<void>;
    cancelReview(formData: FormData): Promise<void>;
    setCampaign(formData: FormData): Promise<void>;
    uploadMedia(formData: FormData): Promise<void>;
    /** D-288 — answer the reviewer, resolve their thread, and resubmit. */
    resubmit(formData: FormData): Promise<void>;
    /** B-2 — a new draft from a published post, which cannot be edited. */
    duplicate?(formData: FormData): Promise<void>;
    /** B9 (Phase 2B-2) — schedule from the Studio, inline. */
    scheduleFromStudio?(formData: FormData): Promise<void>;
    /** E4 (Phase 2B-2) — save the open post as a template. */
    saveAsTemplate?(formData: FormData): Promise<void>;
    /** D10 (Phase 2C-3) — "Keep as is" on one changed Brand Brain fact. */
    keepFactChange?(formData: FormData): Promise<void>;
    /**
     * WRITE THE POST YOURSELF — no model, no credits (D-224).
     *
     * A SERVER ACTION rather than a `fetch` to `/api/content`, unlike generate
     * and quote beside it, and the difference is the point: those two need the
     * AI Gateway, which lives in `apps/api` because F-07 keeps the platform
     * database identity out of this app. This one needs nothing the dashboard
     * does not already have, so it goes straight to `ContentLibraryService` —
     * the class that has no gateway and therefore cannot charge a credit.
     */
    createManualDraft(formData: FormData): Promise<void>;
    /**
     * The campaigns a new post could be filed under, for ONE brand.
     *
     * A CALL RATHER THAN A PROP, because the answer depends on a choice made
     * in the browser: with the rail on "All brands" the composer shows its own
     * brand selector, and the server had already fixed the campaign list before
     * that choice existed. It is permission-guarded server-side, so a caller
     * who may not file a post is never handed a name.
     */
    listCampaignOptions(
      locale: string,
      brandId: string,
    ): Promise<readonly { id: string; name: string }[]>;
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
  defaultBrandId,
  platforms,
  contentTypes,
  maxBriefChars,
  maxVariants,
  draft,
  campaigns,
  mediaOptions,
  can,
  tools,
  actions,
  mode = 'ai',
  initialBrief = '',
  initialCampaignId = '',
  sourceTitle = null,
  goals = [],
  recommendedGoal = null,
  authorDefaults = [],
  defaultsBrandId = '',
  forgetDefault,
  initialGoal = '',
  formatPlatforms,
  templates = [],
  initialTemplateId = '',
  now = 0,
  creativeFormats = [],
  carriedMedia = null,
  plannedDate = null,
  expiredChannels = {},
  plannedFor = null,
  review = null,
  scheduling = null,
  failed = null,
}: ComposerViewProps) {
  const router = useRouter();
  const fieldId = useId();

  /*
   * NOT `brands[0]`. That was the silent first-brand guess wearing client state:
   * a composer opened in a four-brand workspace generated against whichever
   * brand sorted first, and the person writing the brief never saw a choice.
   *
   * A draft's own brand wins, then the rail's selection, then nothing — and
   * "nothing" disables generation rather than picking, because `canGenerate`
   * below already requires a non-empty brand.
   */
  const [brandId, setBrandId] = useState(draft?.brandId ?? defaultBrandId ?? '');

  /*
   * WHOSE POST THE PREVIEW SHOWS. The brand is the account identity a reader
   * recognises; a real connected handle belongs to the calendar, where an
   * actual account is chosen. Naming a connection here would claim the post is
   * going somewhere it has not yet been assigned.
   *
   * THE PREVIEW'S STATUS IS ALWAYS `DRAFT`, and that is not a placeholder: the
   * composer only shows content that has not been scheduled. SCHEDULED and
   * PUBLISHED belong to the calendar and the pipeline, neither reachable from
   * this screen, so claiming one would be a lie about where the post is.
   */
  const brandName = brands.find((brand) => brand.id === brandId)?.name ?? '';
  const brandHandle = brandName === '' ? '' : `@${brandName.replace(/\s+/g, '').toLowerCase()}`;
  /*
   * §18 — THE FORMATS ON OFFER ARE THE ONES SOMETHING CAN CARRY. With no
   * registry answer every configured format stays, exactly as before.
   */
  const offeredTypes = formatPlatforms
    ? contentTypes.filter((type) => (formatPlatforms[type]?.length ?? 0) > 0)
    : contentTypes;
  const carries = useCallback(
    (type: string, platformKey: string) =>
      !formatPlatforms || (formatPlatforms[type] ?? []).includes(platformKey),
    [formatPlatforms],
  );

  /*
   * E4 / B2 — THE TEMPLATE A NEW POST STARTS FROM: the one the reader arrived
   * with, else the brand's default, else none. Only on a new post, and only
   * for the brand the server listed them for.
   */
  const startingTemplate =
    draft === null
      ? (templates.find((template) => template.id === initialTemplateId) ??
        templates.find((template) => template.isDefault) ??
        null)
      : null;
  const [templateId, setTemplateId] = useState(startingTemplate?.id ?? '');
  const templateFor = (type: string, template: ComposerTemplate | null) => {
    const format =
      template && offeredTypes.includes(template.contentType) ? template.contentType : type;
    const channels = template
      ? template.platformKeys
          .filter((key) => platforms.some((platform) => platform.key === key))
          .filter((key) => carries(format, key))
          .slice(0, maxVariants)
      : [];
    return { format, channels };
  };

  const [contentType, setContentType] = useState(
    () => templateFor(offeredTypes[0] ?? contentTypes[0] ?? 'POST', startingTemplate).format,
  );
  /*
   * A10 (Phase 2B-2) — THE BRAND'S DEFAULT CHANNELS, the ones the format can
   * carry. A template's own channels come first; the first carrying channel
   * is the last resort, as before.
   */
  const brandDefaultChannels = (id: string, type: string) =>
    (brands.find((brand) => brand.id === id)?.defaultPlatformKeys ?? [])
      .filter((key) => platforms.some((platform) => platform.key === key))
      .filter((key) => carries(type, key))
      .slice(0, maxVariants);
  const [selected, setSelected] = useState<string[]>(() => {
    const fromTemplate = templateFor(contentType, startingTemplate).channels;
    if (fromTemplate.length > 0) return fromTemplate;
    const fromBrand = brandDefaultChannels(brandId, contentType);
    if (fromBrand.length > 0) return fromBrand;
    const first = platforms.find((platform) => carries(contentType, platform.key));
    return first ? [first.key] : [];
  });
  /*
   * THE CAPTION SKELETON FILLS THE TEXT ONLY WHEN WRITING IT YOURSELF — in that
   * mode the field IS the post. In AI mode the field is the brief a model
   * reads, and a template's words never go into a prompt (owner answer D4).
   */
  const [brief, setBrief] = useState(
    () =>
      initialBrief ||
      (mode === 'write' && startingTemplate?.body ? startingTemplate.body : initialBrief),
  );
  const [goal, setGoal] = useState(initialGoal || recommendedGoal || '');
  const [contentLocale, setContentLocale] = useState<ContentLocale>(
    () => brands.find((brand) => brand.id === brandId)?.defaultLocale ?? 'EN',
  );

  /*
   * THE GOAL TRAVELS IN THE BRIEF, as one plain sentence after the reader's
   * own words — the same field the model already reads, the same length
   * ceiling. It is never stored as a column: it is an instruction, not a fact.
   */
  const goalLabel = goals.find((option) => option.key === goal)?.label ?? '';
  const generationBrief =
    mode === 'ai' && goalLabel !== '' && brief.trim() !== ''
      ? `${brief}\n\n${(t['create.goal.instruction'] ?? '{goal}').replace('{goal}', goalLabel)}`
      : brief;

  /*
   * THE CAMPAIGN THIS POST WOULD BE FILED UNDER, and the options for the brand
   * it would be filed against.
   *
   * SEEDED FROM THE SERVER for the brand the page resolved — the ordinary case,
   * where the rail has a brand selected and no request is needed at all. The
   * effect below replaces the list only when the composer's own brand selector
   * moves to a DIFFERENT brand, which is the case the first version could not
   * serve: the options were decided server-side before the customer had chosen.
   *
   * THE SELECTION IS CLEARED WHENEVER THE BRAND CHANGES. A campaign belongs to
   * one brand, so carrying a choice across a brand switch would either be
   * refused by `createManualItem` or — worse if the ids ever collided — file
   * the post somewhere nobody asked for. Clearing is the honest reset.
   */
  const [campaignId, setCampaignId] = useState(initialCampaignId);
  const [campaignOptions, setCampaignOptions] =
    useState<readonly { id: string; name: string }[]>(campaigns);

  useEffect(() => {
    // Only the pre-draft form owns this; an existing draft has its own campaign
    // control, with its own action and its own list.
    if (draft !== null || !can.attachCampaign) return;
    if (brandId === '') {
      setCampaignId('');
      setCampaignOptions([]);
      return;
    }
    if (brandId === defaultBrandId) {
      // The server already answered for this brand. No request. A choice the
      // reader arrived with (`?campaign=`) survives only if it is one of these.
      setCampaignOptions(campaigns);
      setCampaignId((current) =>
        campaigns.some((campaign) => campaign.id === current) ? current : '',
      );
      return;
    }
    setCampaignId('');
    let current = true;
    actions
      .listCampaignOptions(locale, brandId)
      .then((options) => {
        if (current) setCampaignOptions(options);
      })
      .catch(() => {
        // A refusal or a lost response leaves NO options rather than the
        // previous brand's: an empty list cannot file a post under the wrong
        // brand, and a stale one could.
        if (current) setCampaignOptions([]);
      });
    return () => {
      current = false;
    };
  }, [brandId, defaultBrandId, draft, can.attachCampaign, campaigns, actions, locale]);
  const [busy, setBusy] = useState<null | 'quote' | 'generate' | string>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  /*
   * TWO KEYS, BECAUSE THE COMPOSER MAKES TWO DIFFERENT ASKS.
   *
   * Both are derived from WHAT WAS ASKED FOR rather than minted per click, so a
   * retry returns the first result instead of billing twice for a response the
   * browser lost (AC-11.2). They differ in one field, and the difference is the
   * correction: the campaign belongs to the MANUAL ask, which sends and
   * persists it, and not to the GENERATION ask, which does neither. Sharing one
   * key made a change to the campaign selector move the generation key too — so
   * pressing Generate again became a new `ai_request` and a new credit charge
   * for an ask the server could not tell had changed.
   *
   * `idempotency.ts` holds the derivation, and holds it as a pure function
   * because that is what makes this property provable without a browser.
   */
  /* Templates were listed for the page's brand; another brand has none here. */
  const offeredTemplates = brandId !== '' && brandId === defaultBrandId ? templates : [];
  const chosenTemplateId = offeredTemplates.some((template) => template.id === templateId)
    ? templateId
    : '';

  const chooseTemplate = (id: string) => {
    const previous = offeredTemplates.find((template) => template.id === chosenTemplateId) ?? null;
    const next = offeredTemplates.find((template) => template.id === id) ?? null;
    setTemplateId(id);
    setQuote(null);
    if (!next) return;
    const { format, channels } = templateFor(contentType, next);
    setContentType(format);
    if (channels.length > 0) setSelected(channels);
    // Only an empty field, or one still holding the previous template's words,
    // is replaced: nothing the person typed is ever overwritten.
    if (mode === 'write' && next.body) {
      setBrief((current) =>
        current.trim() === '' || current === (previous?.body ?? '') ? (next.body ?? '') : current,
      );
    }
  };

  const ask = useMemo(
    () => ({
      brandId,
      brief,
      platformKeys: selected,
      contentLocale,
      contentType,
      ...(chosenTemplateId ? { templateId: chosenTemplateId } : {}),
    }),
    [brandId, brief, selected, contentLocale, contentType, chosenTemplateId],
  );
  // The GENERATION ask reads the brief the model will read — goal included —
  // so choosing a different goal is a different request, not a retry.
  const generationIdempotencyKey = useMemo(
    () => generationKeyFor({ ...ask, brief: generationBrief }, draft?.id ?? null),
    [ask, generationBrief, draft?.id],
  );
  const manualIdempotencyKey = useMemo(() => manualKeyFor(ask, campaignId), [ask, campaignId]);

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
    if (!carries(contentType, key)) return;
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
    // D-300 — the same language and format the generation will send, so the
    // price shown is the price reserved.
    const payload = await post('quote', {
      brandId,
      brief: generationBrief,
      platformKeys: selected,
      locale: contentLocale,
      contentType,
    });
    if (payload) setQuote(String(payload['estimateMilli'] ?? '0'));
    setBusy(null);
  };

  const runGenerate = async () => {
    setBusy('generate');
    const payload = await post('generate', {
      brandId,
      brief: generationBrief,
      platformKeys: selected,
      locale: contentLocale,
      contentType,
      idempotencyKey: generationIdempotencyKey,
      ...(chosenTemplateId ? { templateId: chosenTemplateId } : {}),
    });
    setBusy(null);
    if (payload) {
      /*
       * THE CAMPAIGN THE READER CHOSE IS FILED THROUGH THE ONE ACTION THAT
       * FILES CAMPAIGNS (§19). Generation goes through the AI Gateway, which
       * neither takes nor stores a campaign; the association is a second,
       * audited step — attaching needs `content.create` (Q21) — and its own
       * redirect opens the new draft, with its own success or failure message.
       */
      if (campaignId !== '' && can.attachCampaign) {
        const form = new FormData();
        form.set('locale', locale);
        form.set('itemId', String(payload['itemId']));
        form.set('campaignId', campaignId);
        if (carriedMedia) form.set('attach', carriedMedia.id);
        if (plannedDate) form.set('plannedDate', plannedDate);
        await actions.setCampaign(form);
        return;
      }
      // The server component re-reads the draft under RLS. Navigating rather
      // than rendering the response is what keeps ONE source of truth for what
      // the draft says — the database, not a fetch result held in state.
      router.push(
        `/${locale}/content/compose?${new URLSearchParams({
          item: String(payload['itemId']),
          ...(carriedMedia ? { attach: carriedMedia.id } : {}),
          ...(plannedDate ? { date: plannedDate } : {}),
        }).toString()}`,
      );
      router.refresh();
    }
  };

  const runTool = async (variantId: string, tool: string, argument?: string) => {
    setBusy(`${variantId}:${tool}`);
    const payload = await post('tool', {
      variantId,
      tool,
      ...(tool === 'tone' && argument ? { argument } : {}),
      ...(tool === 'translate'
        ? { targetLocale: draftVariantLocale(draft, variantId) === 'AR' ? 'EN' : 'AR' }
        : {}),
      // The variant's VERSION is part of the key: the same tool on the same
      // words is a retry, the same tool after an edit is a new request.
      idempotencyKey: `${generationIdempotencyKey}:${tool}:${argument ?? ''}:${variantId}:${
        draft?.variants.find((variant) => variant.id === variantId)?.updatedAt ?? ''
      }`,
    });
    setBusy(null);
    if (payload) router.refresh();
  };

  const briefTooLong = generationBrief.length > maxBriefChars;
  const hasInputs =
    can.create && brandId !== '' && selected.length > 0 && brief.trim() !== '' && !briefTooLong;
  const canGenerate = hasInputs && can.generate === true;
  /*
   * THE SAME THREE ANSWERS, USED LITERALLY RATHER THAN AS A BRIEF.
   *
   * Writing a post needs a brand, at least one channel and some words — which
   * is what the editor above already collects. A second textarea headed "or
   * write it here" would be a second place for the same sentence to live, and
   * the reader would have to guess which one the button they pressed was going
   * to read.
   *
   * IT IS ALLOWED ONLY WHILE COMPOSING SOMETHING NEW. With a draft open the
   * words on screen are the VARIANTS' and each has its own save form; making a
   * second item out of the brief field at that point would be a surprise.
   */
  const canWrite = hasInputs && draft === null;
  const manualFormId = `${fieldId}-manual`;

  const chooseFormat = (next: string) => {
    setContentType(next);
    setQuote(null);
    setSelected((current) => {
      const kept = current.filter((key) => carries(next, key));
      if (kept.length > 0) return kept;
      const first = platforms.find((platform) => carries(next, platform.key));
      return first ? [first.key] : [];
    });
  };

  return (
    <div className="bsp-st-root" data-testid="content-composer">
      {failure ? (
        <div className="bsp-st-ep" data-tone="failed" role="alert" data-testid="content-failure">
          <span className="bsp-st-ep-copy">
            <span className="bsp-st-ep-title">{failure}</span>
          </span>
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
      {draft === null && carriedMedia ? (
        <div className="bsp-st-ep" role="status" data-testid="content-carried-media">
          <span className="bsp-st-ep-copy">
            <b className="bsp-st-ep-title" dir="auto">
              {(t['editor.media.carried'] ?? '{name}').replace('{name}', carriedMedia.name)}
            </b>
            <span className="bsp-st-ep-note">{t['editor.media.carriedBody']}</span>
          </span>
        </div>
      ) : null}

      {draft === null && sourceTitle ? (
        <div className="bsp-st-ep" role="status" data-testid="content-repurpose-source">
          <span className="bsp-st-ep-copy">
            <b className="bsp-st-ep-title" dir="auto">
              {(t['create.repurpose.from'] ?? '{title}').replace('{title}', sourceTitle)}
            </b>
            <span className="bsp-st-ep-note">{t['create.repurpose.fromBody']}</span>
          </span>
        </div>
      ) : null}

      {plannedDate ? (
        /*
          G6 (D-329) — the Studio was opened from a ★ day on the calendar. Said
          here and carried to the draft, so its Schedule step opens on that day.
        */
        <div
          className="bsp-st-ep"
          data-tone="sched"
          role="note"
          data-testid="composer-planned-date"
        >
          <span className="bsp-st-ep-copy">
            <b className="bsp-st-ep-title">
              {(plannedFor ? t['create.plannedFor'] : t['create.plannedDate'])
                ?.replace('{name}', plannedFor ?? '')
                .replace('{date}', plannedDate)}
            </b>
          </span>
        </div>
      ) : null}

      {brands.length === 0 ? (
        <div className="bsp-st-ep" role="status" data-testid="content-no-brand">
          <span className="bsp-st-ep-copy">
            <b className="bsp-st-ep-title">{t['content.noBrand']}</b>
            <span className="bsp-st-ep-note">{t['content.noBrandBody']}</span>
          </span>
          <Link className="bsp-btn bsp-sm bsp-sec" href={`/${locale}/brand-brain`}>
            {t['content.noBrandAction']}
          </Link>
        </div>
      ) : null}

      {draft !== null ? (
        <DraftEditor
          locale={locale}
          t={t}
          draft={draft}
          platforms={platforms}
          campaigns={campaigns}
          mediaOptions={mediaOptions}
          brandName={brandName}
          brandHandle={brandHandle}
          tools={tools}
          busy={busy}
          now={now}
          can={can}
          creativeFormats={creativeFormats}
          attach={carriedMedia}
          plannedDate={plannedDate}
          expiredChannels={expiredChannels}
          review={review}
          scheduling={scheduling}
          failed={failed}
          canGenerateMedia={can.generateMedia ?? false}
          onTool={(variantId, tool, argument) => void runTool(variantId, tool, argument)}
          actions={actions}
        />
      ) : (
        /*
          THE PROTOTYPE'S STUDIO BEFORE THE POST EXISTS (D-468): the settings
          card, the editor card beside the preview card, and the sticky bar
          with the ways to make the post. Hashtags, media and the per-channel
          checks belong to a version of the post, so they appear the moment the
          draft does — in this same Studio.
        */
        <div className="bsp-st">
          <section className="bsp-card bsp-st-set">
            {/*
              THE LOCAL PICKER SURVIVES ONLY WHERE THE GLOBAL ONE CANNOT ANSWER:
              a NEW item composed while the rail is on "All brands". With a
              brand selected this would be a second control setting the same
              thing — which is exactly how the rail and the page came to
              disagree (D-190).
            */}
            {draft === null && defaultBrandId === null && brands.length > 1 ? (
              <div className="bsp-st-f bsp-st-f12">
                <label className="bsp-lbl" htmlFor={`${fieldId}-brand`}>
                  {t['content.composer.brand']}
                </label>
                <select
                  id={`${fieldId}-brand`}
                  className="bs-control bsp-chip bsp-cal-select bsp-st-select"
                  data-testid="content-brand"
                  value={brandId}
                  onChange={(event) => {
                    setBrandId(event.target.value);
                    setQuote(null);
                    const fromBrand = brandDefaultChannels(event.target.value, contentType);
                    if (fromBrand.length > 0) setSelected(fromBrand);
                  }}
                >
                  {/*
                    THE EMPTY OPTION IS LOAD-BEARING, not decoration: a
                    `<select>` whose options do not include the current value
                    shows the first option while React still holds ''. Giving
                    '' a real option makes the control show what the state
                    actually is; `canGenerate` already requires a brand.
                  */}
                  <option value="">{t['content.composer.brandPlaceholder']}</option>
                  {brands.map((brand) => (
                    <option key={brand.id} value={brand.id}>
                      {brand.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {/*
              §18 — THE FORMAT FIRST, because it decides which channels can
              carry the post. Only formats some enabled provider accepts are
              offered, and choosing one drops the channels that cannot carry it.
            */}
            <div className="bsp-st-f bsp-st-f5">
              <span className="bsp-lbl" id={`${fieldId}-type`}>
                {t['studio.format']}
              </span>
              <div
                className="bsp-seg bsp-st-seg-full"
                role="group"
                aria-labelledby={`${fieldId}-type`}
                data-testid="content-format"
                data-value={contentType}
              >
                <SegmentPill selector='[aria-pressed="true"]' />
                {offeredTypes.map((type) => (
                  <button
                    key={type}
                    type="button"
                    className="bsp-seg-item"
                    aria-pressed={type === contentType}
                    data-value={type}
                    onClick={() => chooseFormat(type)}
                  >
                    {t[`content.type.${type}`] ?? type}
                  </button>
                ))}
              </div>
              {/* D-300 (§23) — what Generate does differently for a carousel. */}
              {contentType === 'CAROUSEL' ? (
                <span className="bsp-st-hint" data-testid="carousel-outline-hint">
                  {t['create.carousel.outlineHint']}
                </span>
              ) : null}
            </div>

            <div className="bsp-st-f bsp-st-f7">
              {/* A group rather than a label: the control is several buttons. */}
              <span id={`${fieldId}-channels`} className="bsp-lbl">
                {t['studio.postTo']}
              </span>
              <div
                className="bsp-st-chips"
                role="group"
                aria-labelledby={`${fieldId}-channels`}
                aria-describedby={`${fieldId}-channels-hint`}
              >
                {platforms.map((platform) => {
                  const on = selected.includes(platform.key);
                  const able = carries(contentType, platform.key);
                  return (
                    <button
                      key={platform.key}
                      type="button"
                      className="bsp-chip"
                      aria-pressed={on}
                      disabled={!able}
                      title={able ? undefined : t['create.format.unsupported']}
                      data-testid="content-channel"
                      data-platform={platform.key}
                      onClick={() => toggle(platform.key)}
                    >
                      <ChannelMark
                        channel={{ key: platform.key, name: platform.label }}
                        size={14}
                        label={false}
                      />
                      <span className="bsp-ltr">{platform.label}</span>
                    </button>
                  );
                })}
              </div>
              <span id={`${fieldId}-channels-hint`} className="bsp-st-hint">
                {t['content.composer.channelsHint']}
              </span>
            </div>

            {offeredTemplates.length > 0 ? (
              <div className="bsp-st-f bsp-st-f4">
                <label className="bsp-lbl" htmlFor={`${fieldId}-template`}>
                  {t['create.template.label']}
                </label>
                <select
                  id={`${fieldId}-template`}
                  className="bs-control bsp-chip bsp-cal-select bsp-st-select"
                  value={chosenTemplateId}
                  data-testid="content-template"
                  aria-describedby={`${fieldId}-template-hint`}
                  onChange={(event) => chooseTemplate(event.target.value)}
                >
                  <option value="">{t['create.template.none']}</option>
                  {offeredTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.isDefault
                        ? (t['create.template.default'] ?? '{name}').replace(
                            '{name}',
                            template.name,
                          )
                        : template.name}
                    </option>
                  ))}
                </select>
                <span id={`${fieldId}-template-hint`} className="bsp-st-hint">
                  {mode === 'write' ? t['create.template.hintWrite'] : t['create.template.hintAi']}
                </span>
              </div>
            ) : null}

            <div className="bsp-st-f bsp-st-f4">
              <label className="bsp-lbl" htmlFor={`${fieldId}-language`}>
                {t['content.composer.language']}
              </label>
              <select
                id={`${fieldId}-language`}
                className="bs-control bsp-chip bsp-cal-select bsp-st-select"
                value={contentLocale}
                onChange={(event) => setContentLocale(event.target.value as ContentLocale)}
              >
                <option value="AR">{t['content.language.AR']}</option>
                <option value="EN">{t['content.language.EN']}</option>
              </select>
            </div>

            {/*
              §19 — THE POST'S GOAL. Only where a model will read it: a post the
              person writes themselves is saved word for word. The
              recommendation is the brand's own first goal, named as such.
            */}
            {mode === 'ai' && draft === null && goals.length > 0 ? (
              <div className="bsp-st-f bsp-st-f4">
                <label className="bsp-lbl" htmlFor={`${fieldId}-goal`}>
                  {t['create.goal.label']}
                </label>
                <select
                  id={`${fieldId}-goal`}
                  className="bs-control bsp-chip bsp-cal-select bsp-st-select"
                  value={goal}
                  data-testid="content-goal"
                  onChange={(event) => {
                    setGoal(event.target.value);
                    setQuote(null);
                  }}
                >
                  <option value="">{t['create.goal.none']}</option>
                  {goals.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {recommendedGoal ? (
                  <span className="bsp-st-hint" data-testid="content-goal-recommended">
                    {(t['create.goal.recommended'] ?? '').replace(
                      '{goal}',
                      goals.find((option) => option.key === recommendedGoal)?.label ?? '',
                    )}
                  </span>
                ) : null}
                {authorDefaults.length > 0 ? (
                  <div className="bsp-st-hint" data-testid="content-defaults">
                    <b>{t['create.defaults.title']}</b>
                    <ul className="bsp-st-defaults">
                      {authorDefaults.map((entry) => (
                        <li key={entry.key} data-testid={`content-default-${entry.key}`}>
                          {entry.label}{' '}
                          {forgetDefault ? (
                            <form action={forgetDefault} className="bsp-st-inline-form">
                              <input type="hidden" name="locale" value={locale} />
                              <input type="hidden" name="brandId" value={defaultsBrandId} />
                              <input type="hidden" name="key" value={entry.key} />
                              <input type="hidden" name="decision" value="dismiss" />
                              <input type="hidden" name="forget" value="1" />
                              <input type="hidden" name="returnTo" value="/content/compose" />
                              <button type="submit" className="bsp-st-link">
                                {t['create.defaults.forget']}
                              </button>
                            </form>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/*
              THE CONTROL IS GATED ON THE PERMISSION THAT AUTHORIZES THE
              ASSOCIATION, not merely on having campaigns to show (Q21, D-318):
              filing a NEW post under a campaign is part of making it. It
              belongs to the manual form below (`form=`), and is CONTROLLED
              because the idempotency key has to include the choice.
            */}
            {can.attachCampaign && campaignOptions.length > 0 ? (
              <div className="bsp-st-f bsp-st-f4">
                <label className="bsp-lbl" htmlFor={`${fieldId}-manual-campaign`}>
                  {t['campaigns.composerLabel']}
                </label>
                <select
                  id={`${fieldId}-manual-campaign`}
                  className="bs-control bsp-chip bsp-cal-select bsp-st-select"
                  name="campaignId"
                  form={manualFormId}
                  value={campaignId}
                  onChange={(event) => setCampaignId(event.target.value)}
                  data-testid="content-manual-campaign"
                >
                  <option value="">{t['campaigns.composerNone']}</option>
                  {campaignOptions.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </section>

          <div className="bsp-st-grid">
            {/* ---------------------------------------------- the editor --- */}
            <section className="bsp-card bsp-st-ed">
              <div className="bsp-st-field">
                <label className="bsp-st-label" htmlFor={`${fieldId}-brief`}>
                  {mode === 'write' && draft === null
                    ? t['create.write.label']
                    : t['content.composer.brief']}
                </label>
                <textarea
                  id={`${fieldId}-brief`}
                  className="bsp-st-caption"
                  value={brief}
                  dir="auto"
                  maxLength={maxBriefChars}
                  placeholder={
                    mode === 'write' && draft === null
                      ? t['create.write.placeholder']
                      : t['content.composer.briefPlaceholder']
                  }
                  data-testid="content-brief"
                  onChange={(event) => {
                    setBrief(event.target.value);
                    setQuote(null);
                  }}
                />
                <span className="bsp-st-count" data-over={briefTooLong ? 'true' : undefined}>
                  <span className="bsp-ltr">
                    {generationBrief.length} / {maxBriefChars}
                  </span>
                </span>
              </div>

              {quote !== null ? (
                <div className="bsp-st-quote" role="status" data-testid="content-quote">
                  <b>
                    {t['content.composer.quoteLabel']}: {formatCredits(quote)}{' '}
                    {t['content.composer.quoteUnit']}
                  </b>
                  <span>{t['content.composer.quoteHint']}</span>
                </div>
              ) : null}

              {/*
                THE MANUAL FORM MIRRORS THE CONTROLS ABOVE; IT DOES NOT
                DUPLICATE THEM. Every hidden value here is already on the
                screen, in the controls the generate button reads — so the two
                verbs act on ONE set of answers and cannot drift apart. The
                button and the campaign sit outside it through `form=`.

                `contentType` WAS BEING DROPPED (PHASE 2 correction): the form
                sends it, so a person who chose REEL and wrote it themselves
                gets a reel.

                HASHTAGS AND MEDIA ARE DELIBERATELY NOT HERE. Both are
                properties of a VARIANT, not of the item; the draft this
                button creates opens immediately in this same Studio, where the
                per-version hashtags and media already work (D-184).

                THE IDEMPOTENCY KEY IS THE COMPOSER'S OWN, derived from the
                brand, the words, the channels and the language, so a double
                submit returns the first draft instead of making a second.
              */}
              {draft === null ? (
                <form
                  id={manualFormId}
                  action={actions.createManualDraft}
                  data-testid="content-manual-form"
                >
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="brandId" value={brandId} />
                  <input type="hidden" name="contentLocale" value={contentLocale} />
                  <input type="hidden" name="contentType" value={contentType} />
                  <input type="hidden" name="body" value={brief} />
                  <input type="hidden" name="idempotencyKey" value={manualIdempotencyKey} />
                  {chosenTemplateId ? (
                    <input type="hidden" name="templateId" value={chosenTemplateId} />
                  ) : null}
                  {carriedMedia ? (
                    <input type="hidden" name="attach" value={carriedMedia.id} />
                  ) : null}
                  {plannedDate ? (
                    <input type="hidden" name="plannedDate" value={plannedDate} />
                  ) : null}
                  {selected.map((platformKey) => (
                    <input
                      key={platformKey}
                      type="hidden"
                      name="platformKeys"
                      value={platformKey}
                    />
                  ))}
                </form>
              ) : null}
            </section>

            {/* ------------------- the preview: nothing written yet, and says so --- */}
            <section
              className="bsp-card bsp-st-prev"
              aria-live="polite"
              data-testid="content-results"
            >
              <span className="bsp-lbl">{t['studio.preview']}</span>
              <p className="bsp-st-none">{t['content.composer.resultsEmpty']}</p>
            </section>
          </div>

          {/* -------------------------------------------- the sticky bar --- */}
          <div className="bsp-st-bar">
            <span className="bsp-st-note" />
            {can.generate ? (
              <button
                type="button"
                className="bsp-btn bsp-sec"
                disabled={!canGenerate || busy !== null}
                data-testid="content-estimate"
                onClick={runQuote}
              >
                {t['content.composer.estimate']}
              </button>
            ) : null}
            <button
              type="submit"
              form={manualFormId}
              className={mode === 'write' ? 'bsp-btn bsp-pur' : 'bsp-btn bsp-sec'}
              disabled={!canWrite || busy !== null}
              data-testid="content-write-manual"
            >
              {t['content.composer.write']}
            </button>
            {can.generate ? (
              <button
                type="button"
                className={mode === 'write' ? 'bsp-btn bsp-sec' : 'bsp-btn bsp-pur'}
                disabled={!canGenerate || busy !== null}
                data-testid="content-generate"
                /*
                  THE KEY THIS BUTTON WOULD SEND, on the button that sends it.
                  It is the only way a browser test can see WHICH of the two
                  keys the composer wired to generation. It discloses nothing:
                  a hash of the customer's own inputs, already present in this
                  form as the manual submission's hidden field.
                */
                data-generation-key={generationIdempotencyKey}
                onClick={runGenerate}
              >
                {busy === 'generate'
                  ? t['content.composer.generating']
                  : t['content.composer.generate']}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function draftVariantLocale(draft: ComposerDraft | null, variantId: string): ContentLocale {
  return draft?.variants.find((variant) => variant.id === variantId)?.locale ?? 'EN';
}
