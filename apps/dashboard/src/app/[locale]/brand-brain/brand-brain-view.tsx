'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { translator, type MessageKey } from '../../../i18n/messages';
import { BrandOrb, type OrbNode } from './brand-orb';
import { BrandChat, type ChatStart } from './brand-chat';
import { AreaDrawer, type QuestionFocus } from './area-drawer';
import { ReviewInbox, type ConfidentPreviewEntry } from './review-inbox';
import { VoiceCard } from './voice-card';
import { LookCard, type LookViewData } from './look-card';
import { SourceRow, type SourceRowData } from './source-row';
import { SegmentPill } from '@brandspace/ui';
import { acceptConfidentCandidatesAction, uploadSourceAction as uploadFormAction } from './actions';
import { CopilotLink } from '../../../components/copilot-link';
import { useMessageLocale } from '../../../i18n/message-locale-context';

/**
 * The Brand Brain client island — PORTED from the approved prototype (D-468):
 * `docs/visual-reference/prototype-2026-09-27/Main.dc.html`, lines 757–926.
 *
 * Four tabs in the prototype's segmented switch. KNOWLEDGE is the hero (the
 * orb beside the count), "What's missing", the To review banner with its
 * confident-ones card and the one review card, and the ten area cards — or,
 * with an area open, that area in place of the grid (the prototype's inline
 * area view; it was a drawer). LOOK & VOICE and SOURCES are the prototype's
 * cards; TALK WITH THE BRAND is its chat card.
 *
 * THE DATA IS THE WORKSPACE'S, VALUE FOR VALUE: every number was computed on
 * the server from stored state. The allowed differences are listed in
 * docs/UI-FIDELITY-CONTRACT.md §4.5 (Brand Brain).
 */

export type BrandBrainTab = 'knowledge' | 'look' | 'sources' | 'chat';

export interface AreaItemData {
  readonly id: string;
  readonly itemKey: string;
  readonly title: string;
  readonly body: string;
  readonly origin: string;
  readonly originLabel: string;
  /*
   * WHICH OF THE FOUR MEMORIES THIS FACT LIVES IN (P6-07).
   *
   * The screen carried `origin` — human, document, AI — and never the LAYER,
   * which is the other half of the model and the half that decides precedence.
   * A reader could see that a fact was AI-inferred and not that it sat in the
   * lowest-authority memory and therefore could never overwrite anything above
   * it. `memoryRank` is the position the engine itself uses, so the screen
   * explains the rule rather than restating an opinion about it.
   */
  readonly memory: string;
  readonly memoryLabel: string;
  readonly memoryRank: number;
  readonly memoryDepth: number;
  readonly version: number;
  readonly stale: boolean;
  /** D6 — the fact's last valid day (`YYYY-MM-DD`, workspace-local), or null. */
  readonly validUntil: string | null;
  /** D6 — that day has passed in the workspace's time zone: not used in writing. */
  readonly expired: boolean;
  /** Both languages as stored, for the Edit form. */
  readonly edit: {
    readonly titleEn: string;
    readonly titleAr: string;
    readonly bodyEn: string;
    readonly bodyAr: string;
  };
  /** D-294 — "Updated 3 Sep 2026 · by Sara · from brand-guide.pdf". */
  readonly provenance: string;
  /**
   * D6 remainder (Phase 2C-3) — distinct live posts whose current recorded
   * usage holds this fact (M5). A count; no post is named.
   */
  readonly usedInPosts: number;
}

/** C4 + decision 2.b — the one Voice card, from TONE_OF_VOICE and DO_DONT facts. */
export interface VoiceData {
  readonly words: AreaItemData | null;
  readonly tone: readonly AreaItemData[];
  readonly dos: readonly AreaItemData[];
  readonly donts: readonly AreaItemData[];
  readonly unsorted: readonly AreaItemData[];
}

/** Q19 — one of "What's missing". */
export interface MissingQuestionData {
  readonly area: string;
  readonly areaLabel: string;
  readonly itemKey: string;
  readonly prompt: string;
}

/** D-294 — one of the four memories, counted. */
export interface LayerData {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly count: number;
  /** Learnings waiting on a person (the LEARNING layer only). */
  readonly pending: number;
}

export interface AreaCardData {
  readonly area: string;
  readonly label: string;
  readonly description: string;
  readonly status: 'COMPLETE' | 'NEEDS_ATTENTION' | 'IN_PROGRESS' | 'EMPTY';
  readonly statusLabel: string;
  readonly activeItems: number;
  /** Q19 — "answered n of m": the area's key questions with a usable answer. */
  readonly answered: number;
  readonly total: number;
  readonly questions: readonly {
    readonly itemKey: string;
    readonly prompt: string;
    readonly answered: boolean;
  }[];
  readonly pendingCandidates: number;
  readonly attention: readonly string[];
  /** The reasons behind `attention`, untranslated, to group them. */
  readonly attentionCodes: readonly string[];
  readonly items: readonly AreaItemData[];
}

export interface CandidateData {
  readonly id: string;
  readonly area: string;
  readonly itemKey: string;
  readonly title: string;
  readonly body: string;
  readonly confidencePercent: number;
  /** D4 — High / Medium / Low, translated, from the configured thresholds. */
  readonly confidenceLabel: string;
  /** The configured band the label names — it picks the prototype's pill. */
  readonly confidenceLevel: 'high' | 'medium' | 'low';
  /** D4 — why, from what was recorded when the candidate was made. */
  readonly confidenceWhy: string;
  readonly areaLabel: string;
  /** D4 — the source's own words. */
  readonly snippet: string | null;
  /** D4 — the approved fact this would replace, shown beside it. */
  readonly replaced: {
    readonly area: string;
    readonly title: string;
    readonly body: string;
  } | null;
  /** Decision 2.a — false where precedence refuses a plain accept (D-65). */
  readonly acceptAllowed: boolean;
  readonly evidence: readonly string[];
  readonly replacesExisting: boolean;
  /** P6-11 — an analytics inference or a document extract; D7 — or a member's proposal. */
  readonly source: 'ANALYTICS' | 'DOCUMENT' | 'MEMBER';
  /** D7 — "Proposed by Sara", for a MEMBER candidate; null otherwise. */
  readonly proposedBy: string | null;
  /** The finding an analytics learning was drawn from, when the reader may open it. */
  readonly sourceHref: string | null;
  /** The measurements behind an analytics learning, as a translated sentence. */
  readonly measured: string | null;
  /** A human-approved fact this learning disagrees with, as a translated sentence. */
  readonly conflict: string | null;
  /** Both languages of the proposal, to prefill an edit-then-accept. */
  readonly edit: {
    readonly titleEn: string;
    readonly titleAr: string;
    readonly bodyEn: string;
    readonly bodyAr: string;
  };
}

/** One source row — see `source-row.tsx` (Phase 2C-4, D5). */
export type SourceData = SourceRowData;

export interface BrandBrainPermissions {
  readonly edit: boolean;
  readonly upload: boolean;
  readonly review: boolean;
  readonly remove: boolean;
  readonly chat: boolean;
}

/**
 * The demo's glyph for each card.
 *
 * Eight are the demo's own, taken from its markup. STRATEGY and LEARNINGS have
 * no demo card — the demo shows eight areas and the product has ten (D-87) — so
 * they take the demo's own intelligence mark and its sibling rather than a
 * glyph from somewhere else.
 */
const AREA_GLYPHS: Record<string, string> = {
  IDENTITY: '◇',
  AUDIENCE: '◎',
  TONE_OF_VOICE: '✎',
  OFFERS: '▦',
  PROOF_POINTS: '✓',
  DO_DONT: '↔',
  COMPETITORS: '⌁',
  GLOSSARY: 'Aa',
  STRATEGY: '✧',
  LEARNINGS: '✦',
};

export function BrandBrainView({
  locale,
  brandId,
  understanding,
  layers,
  missing,
  voice,
  look,
  initialTab,
  focusCandidateId,
  reviewOpen = false,
  confident,
  copilotHref,
  profileHref,
  answered,
  totalQuestions,
  totalActiveItems,
  sourceCount,
  orbNodes,
  areas,
  candidates,
  sources,
  retentionDays,
  permissions,
  chatStart = null,
  initialFocus = null,
}: {
  locale: string;
  brandId: string;
  /** The brand's name — the page's eyebrow says it (the prototype's `T.brandName`). */
  brandName: string;
  /** "BrandSpace understands this brand from 12 approved facts…" — counted, never scored. */
  understanding: string;
  layers: readonly LayerData[];
  /** Q19 — the first unanswered key questions ("What's missing"). */
  missing: readonly MissingQuestionData[];
  voice: VoiceData;
  /**
   * Phase 2C-2 — colours, logo and fonts, with whether this member may change
   * them (`brand.manage`) and upload files (`assets.upload`). Null without
   * `brand.read`.
   */
  look: {
    readonly data: LookViewData;
    readonly canManage: boolean;
    readonly canUpload: boolean;
  } | null;
  initialTab: BrandBrainTab;
  /** `?candidate=` — the review opens on this candidate. */
  focusCandidateId: string | null;
  /** The review card was open when its form posted: it stays open on the way back. */
  reviewOpen?: boolean;
  /** D4 — the preview for "Accept the confident ones". Empty without review rights. */
  confident: readonly ConfidentPreviewEntry[];
  /** The global Copilot, scoped to Brand Brain; null when the member may not use it. */
  copilotHref: string | null;
  /** D-298 (§11) — the brand's identity, one click from its knowledge; null without `brand.read`. */
  profileHref: string | null;
  /** Q19 — key questions answered across every area, and how many there are. No score. */
  answered: number;
  totalQuestions: number;
  totalActiveItems: number;
  sourceCount: number;
  orbNodes: readonly OrbNode[];
  areas: readonly AreaCardData[];
  candidates: readonly CandidateData[];
  sources: readonly SourceData[];
  /**
   * The configured retention window. Never a number this app chose: it is read
   * from the tenant-readable configuration projection, so the notice states what
   * an owner actually activated (D-78, CLAUDE.md §2.2).
   */
  retentionDays: number;
  permissions: BrandBrainPermissions;
  /** D7/D8/D9 — the chat opens in Add (a handoff) or Edit ("Fix it"), prefilled. */
  chatStart?: ChatStart | null;
  /** D12 (Phase 2C-4) — Home's missing-question link: this area, this question. */
  initialFocus?: {
    readonly area: string;
    readonly itemKey: string;
    readonly prompt: string;
  } | null;
}) {
  const t = translator(useMessageLocale(locale));
  const [tab, setTabState] = useState<BrandBrainTab>(initialTab);
  const [openArea, setOpenArea] = useState<string | null>(initialFocus?.area ?? null);
  const [focus, setFocus] = useState<QuestionFocus | null>(
    initialFocus ? { itemKey: initialFocus.itemKey, prompt: initialFocus.prompt } : null,
  );
  const [chatArea, setChatArea] = useState<string | null>(null);
  const [inboxArea, setInboxArea] = useState<string | null>(null);
  const [rvOpen, setRvOpen] = useState(reviewOpen || focusCandidateId !== null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [pendingDrop, setPendingDrop] = useState<{ file: File; area: string | null } | null>(null);
  const [chosenName, setChosenName] = useState<string | null>(null);
  const uploadRef = useRef<HTMLFormElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dropAreaRef = useRef<HTMLInputElement | null>(null);
  const inboxRef = useRef<HTMLElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);

  const byArea = new Map(areas.map((a) => [a.area, a]));
  /*
   * WHAT NEEDS ATTENTION, beyond what the card already says: unanswered key
   * questions are its chips and waiting facts are the To review banner, so
   * only the other reasons (stale, expired, in conflict) ride at its end —
   * where the prototype puts "1 expired fact" — one pill per reason.
   */
  const attentionPills = [
    ...new Set(
      areas.flatMap((area) =>
        area.status === 'EMPTY'
          ? []
          : area.attentionCodes.filter(
              (code) => code !== 'unanswered_questions' && code !== 'pending_review',
            ),
      ),
    ),
  ].map((code) => {
    const named = areas.filter((area) => area.attentionCodes.includes(code));
    const index = named[0]?.attentionCodes.indexOf(code) ?? -1;
    return {
      code,
      label: index >= 0 ? (named[0]?.attention[index] ?? code) : code,
      areas: named.map((area) => area.label),
    };
  });
  const pendingTotal = areas.reduce((sum, area) => sum + area.pendingCandidates, 0);
  const readySources = sources.filter((source) => source.status === 'READY').length;
  const missingCount = Math.max(0, totalQuestions - answered);

  /*
   * THE TAB IS AN ADDRESS (D1): it is written into `?tab=` without a
   * navigation, so a reload, a shared link and a form's redirect all land on
   * the same tab.
   */
  const setTab = useCallback((next: BrandBrainTab) => {
    setTabState(next);
    try {
      const url = new URL(window.location.href);
      if (next === 'knowledge') url.searchParams.delete('tab');
      else url.searchParams.set('tab', next);
      window.history.replaceState(window.history.state, '', url);
    } catch {
      // A sandboxed frame without history access keeps the tab in state only.
    }
  }, []);

  const openChat = useCallback(
    (area: string | null) => {
      setChatArea(area);
      setOpenArea(null);
      setTab('chat');
    },
    [setTab],
  );

  /**
   * A file dropped on the orb or a node, or chosen with "Upload files".
   *
   * It does NOT upload silently. The file is placed on the real upload form —
   * on the Sources tab — and the customer confirms: an upload consumes storage,
   * creates review work and is visible to the whole workspace (CLAUDE.md §2.5).
   */
  const onDropFile = useCallback(
    (area: string | null, file: File) => {
      if (!permissions.upload) return;
      setPendingDrop({ file, area });
      setTab('sources');
    },
    [permissions.upload, setTab],
  );

  // Once the Sources tab has mounted its form, the dropped file lands on it.
  useEffect(() => {
    if (tab !== 'sources' || !pendingDrop) return;
    const input = fileRef.current;
    const form = uploadRef.current;
    if (!input || !form) return;
    const transfer = new DataTransfer();
    transfer.items.add(pendingDrop.file);
    input.files = transfer.files;
    setChosenName(pendingDrop.file.name);
    if (dropAreaRef.current) dropAreaRef.current.value = pendingDrop.area ?? '';
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setPendingDrop(null);
  }, [tab, pendingDrop]);

  /** The chat's attach button, wired to the one real upload control on Sources. */
  const onAttach = useCallback(() => {
    setTab('sources');
    window.requestAnimationFrame(() => fileRef.current?.focus());
  }, [setTab]);

  /** Q19 — "What's missing": open the area with that question in the add form. */
  const askMissing = useCallback((entry: MissingQuestionData) => {
    setFocus({ itemKey: entry.itemKey, prompt: entry.prompt });
    setOpenArea(entry.area);
  }, []);

  /** "Review one by one", or an area's candidates: the one review card. */
  const openReview = useCallback((area: string | null) => {
    setBulkOpen(false);
    setInboxArea(area);
    setRvOpen(true);
    window.requestAnimationFrame(() =>
      inboxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }, []);

  const openAreaData = openArea ? (byArea.get(openArea) ?? null) : null;
  const chatAreaLabel = chatArea ? (byArea.get(chatArea)?.label ?? null) : null;

  const tabs: { id: BrandBrainTab; label: string; badge?: string }[] = [
    {
      id: 'knowledge',
      label: t('bb.tab.knowledge'),
      ...(pendingTotal > 0 ? { badge: String(pendingTotal) } : {}),
    },
    { id: 'look', label: t('bb.tab.look') },
    { id: 'sources', label: t('bb.tab.sources') },
    { id: 'chat', label: t('bb.tab.chat') },
  ];

  /*
   * D-357 — the hero reads "answered n of m". The prototype sets its count in
   * 52px with the words beside it; the number here is that big figure, and the
   * sentence around it is the one D-357 fixed.
   */
  const voiceCard = (
    <VoiceCard
      locale={locale}
      brandId={brandId}
      voice={voice}
      canEdit={permissions.edit}
      profileHref={profileHref}
    />
  );

  const [answeredBefore = '', answeredAfter = ''] = t('bb.answeredOf').split('{answered}');

  return (
    <div className="bsp-bb">
      {/*
        D1 — FOUR TABS, in the prototype's segmented switch (`.seg`, line 761,
        and the "Talk with the brand" segment it appends, line 4273). They stay
        a real tablist: arrow keys move along it, in reading order.
      */}
      <div
        ref={tabsRef}
        className="bsp-seg bsp-bb-tabs"
        role="tablist"
        aria-label={t('bb.tabsLabel')}
        data-testid="brand-brain-tabs"
        onKeyDown={(event) => {
          const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
          if (!keys.includes(event.key)) return;
          event.preventDefault();
          const index = tabs.findIndex((entry) => entry.id === tab);
          const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
          const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
          let next = index;
          if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = tabs.length - 1;
          else if (event.key === forward) next = (index + 1) % tabs.length;
          else next = (index - 1 + tabs.length) % tabs.length;
          const target = tabs[next];
          if (target) {
            setTab(target.id);
            tabsRef.current?.querySelector<HTMLElement>(`#tab-${target.id}`)?.focus();
          }
        }}
      >
        <SegmentPill selector='[aria-selected="true"]' />
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`tab-${entry.id}`}
            className="bsp-seg-item"
            data-testid={`tab-${entry.id}`}
            aria-selected={entry.id === tab}
            aria-controls={`panel-${entry.id}`}
            tabIndex={entry.id === tab ? 0 : -1}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {entry.badge ? <span className="bsp-bb-tabn">{entry.badge}</span> : null}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        data-testid={`panel-${tab}`}
        tabIndex={-1}
        className="bsp-bb-panel"
      >
        {tab === 'knowledge' ? (
          <>
            {openAreaData ? null : (
              /*
                THE HERO — `Main.dc.html` lines 765–779: a 450px orb column
                beside the count, the lead and the two actions. D-357 keeps the
                count as key questions answered, with no bar; D-294 adds what
                BrandSpace understands and the four layers under it.
              */
              <section className="bsp-card bsp-bb-hero" data-testid="brand-brain-hero">
                <div className="bsp-bb-orbcol">
                  <BrandOrb
                    nodes={orbNodes}
                    centerAriaLabel={t('bb.orbOpenChat')}
                    stageAriaLabel={t('bb.orbLabel')}
                    onSelectArea={setOpenArea}
                    onOpenChat={() => openChat(null)}
                    onDropFile={onDropFile}
                    canUpload={permissions.upload}
                  />
                  <span className="bsp-bb-hint">{t('bb.orbHint')}</span>
                </div>
                <div className="bsp-bb-herotext" data-testid="completion-card">
                  <b className="bsp-bb-count" data-testid="completion-answered">
                    {answeredBefore}
                    <span className="bsp-bb-big bsp-ltr">{answered}</span>
                    {answeredAfter.replace('{total}', String(totalQuestions))}
                  </b>
                  <p className="bsp-bb-und" data-testid="brand-brain-understands">
                    {understanding}
                  </p>
                  <p className="bsp-bb-lead">{t('bb.lead')}</p>
                  <ul
                    className="bsp-bb-layers"
                    data-testid="brand-brain-layers"
                    aria-label={t('bb.layersTitle')}
                  >
                    {layers.map((layer) => (
                      <li
                        key={layer.key}
                        className="bsp-pill bsp-p-neu"
                        data-testid={`brand-brain-layer-${layer.key}`}
                        title={layer.description}
                      >
                        {layer.label} · <b className="bsp-ltr">{layer.count}</b>
                        {layer.pending > 0
                          ? ` · ${t('bb.layerPending').replace('{count}', String(layer.pending))}`
                          : ''}
                      </li>
                    ))}
                    <li className="bsp-pill bsp-p-neu">
                      {t('bb.knowledgeItems')} ·{' '}
                      <b className="bsp-ltr" data-testid="metric-items">
                        {totalActiveItems}
                      </b>
                    </li>
                    <li className="bsp-pill bsp-p-neu">
                      {t('bb.sourceDocuments')} ·{' '}
                      <b className="bsp-ltr" data-testid="metric-sources">
                        {sourceCount}
                      </b>
                      {sourceCount > 0 ? ` · ${readySources} ${t('bb.source.READY')}` : ''}
                    </li>
                  </ul>
                  <div className="bsp-bb-acts">
                    <button
                      type="button"
                      className="bsp-btn bsp-sm bsp-pur"
                      data-testid="brand-brain-ask-brand"
                      onClick={() => openChat(null)}
                    >
                      {t('bb.askBrand')}
                    </button>
                    {permissions.upload ? (
                      <label className="bsp-btn bsp-sm bsp-bb-pick">
                        {t('bb.uploadFiles')}
                        <input
                          type="file"
                          className="bs-control bsp-bb-file"
                          aria-label={t('bb.uploadFiles')}
                          data-testid="brand-brain-upload"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) onDropFile(null, file);
                            event.target.value = '';
                          }}
                        />
                      </label>
                    ) : null}
                    {copilotHref ? (
                      <CopilotLink
                        href={copilotHref}
                        className="bsp-btn bsp-sm bsp-sec"
                        testId="brand-brain-ask"
                      >
                        {t('bb.askAboutBrand')}
                      </CopilotLink>
                    ) : null}
                    {profileHref ? (
                      <Link
                        href={profileHref}
                        className="bsp-btn bsp-sm bsp-ghost"
                        data-testid="brand-brain-profile"
                      >
                        {t('bb.openProfile')}
                      </Link>
                    ) : null}
                  </div>
                </div>
              </section>
            )}

            {/*
              Q19 — WHAT'S MISSING (`Main.dc.html` line 781): the first
              unanswered key questions as chips, each opening its area with the
              question chosen; what needs attention rides at the end, where the
              prototype puts its expired-facts pill.
            */}
            {openAreaData || (missing.length === 0 && attentionPills.length === 0) ? null : (
              <section className="bsp-card bsp-bb-miss" data-testid="brand-brain-missing">
                <span className="bsp-bb-miss-t">
                  <b>
                    {missing.length > 0 ? t('bb.missingTitle') : t('bb.attentionTitle')}{' '}
                    {missing.length > 0 ? (
                      <span className="bsp-ltr bsp-bb-miss-n">{missingCount}</span>
                    ) : null}
                  </b>
                  {missing.length > 0 ? <span>{t('bb.missingSub')}</span> : null}
                </span>
                <span className="bsp-bb-miss-q">
                  {missing.map((entry) => (
                    <button
                      key={`${entry.area}:${entry.itemKey}`}
                      type="button"
                      className="bsp-chip"
                      data-testid={`brand-brain-missing-${entry.itemKey}`}
                      onClick={() => askMissing(entry)}
                    >
                      <span className="bsp-bb-miss-a">{entry.areaLabel} ·</span> {entry.prompt}{' '}
                      <span className="bsp-bb-miss-plus" aria-hidden="true">
                        +
                      </span>
                    </button>
                  ))}
                </span>
                {attentionPills.map((pill) => (
                  <span
                    key={pill.code}
                    className={`bsp-pill ${pill.code === 'stale_items' ? 'bsp-p-warn' : 'bsp-p-bad'}`}
                    title={pill.areas.join(' · ')}
                    data-testid={`brand-brain-attention-${pill.code}`}
                  >
                    {pill.label} · <span className="bsp-ltr">{pill.areas.length}</span>
                  </span>
                ))}
              </section>
            )}

            {/*
              D4 — TO REVIEW (`Main.dc.html` lines 783–786): the count, "Accept
              the confident ones" and "Review one by one".
            */}
            {pendingTotal > 0 ? (
              <section className="bsp-bb-rvbar" data-testid="review-banner">
                <span className="bsp-pill bsp-p-ai">{t('bb.toReview')}</span>
                <span className="bsp-bb-rvbar-t" data-testid="review-inbox-count">
                  {t('bb.factsWaiting').replace('{count}', String(pendingTotal))}
                </span>
                {permissions.review ? (
                  <>
                    <button
                      type="button"
                      className="bsp-btn bsp-sm bsp-sec"
                      aria-expanded={bulkOpen}
                      data-testid="accept-confident-open"
                      onClick={() => setBulkOpen((open) => !open)}
                    >
                      {confident.length > 0
                        ? t('bb.acceptConfident').replace('{count}', String(confident.length))
                        : t('bb.acceptHigh')}
                    </button>
                    <button
                      type="button"
                      className="bsp-btn bsp-sm bsp-pur"
                      data-testid="review-one-by-one"
                      onClick={() => openReview(null)}
                    >
                      {t('bb.oneByOne')}
                    </button>
                  </>
                ) : (
                  <span className="bsp-bb-rvbar-n">{t('bb.inboxForReviewers')}</span>
                )}
              </section>
            ) : null}

            {bulkOpen && permissions.review ? (
              <ConfidentCard
                locale={locale}
                brandId={brandId}
                confident={confident}
                onCancel={() => setBulkOpen(false)}
                onOneByOne={() => openReview(null)}
              />
            ) : null}

            {rvOpen ? (
              <ReviewInbox
                ref={inboxRef}
                locale={locale}
                candidates={candidates}
                focusArea={inboxArea}
                focusCandidateId={focusCandidateId}
                canReview={permissions.review}
                canEdit={permissions.edit}
                onEditFact={(area) => setOpenArea(area)}
                onClose={() => setRvOpen(false)}
              />
            ) : null}

            {openAreaData ? (
              <AreaDrawer
                locale={locale}
                brandId={brandId}
                area={openAreaData}
                candidates={candidates.filter((entry) => entry.area === openAreaData.area)}
                focus={focus}
                permissions={permissions}
                onClose={() => {
                  setOpenArea(null);
                  setFocus(null);
                }}
                onAskAbout={(area: string) => openChat(area)}
                onReview={openReview}
              />
            ) : (
              /* The ten areas — `.xgrid` of `.xcard`s, four across (lines 805–815). */
              <section className="bsp-xgrid bsp-bb-grid" data-testid="area-grid">
                {areas.map((area) => (
                  <button
                    key={area.area}
                    type="button"
                    className="bsp-xcard bsp-bb-card"
                    data-testid={`area-card-${area.area}`}
                    onClick={() => setOpenArea(area.area)}
                  >
                    <span className="bsp-xicon" aria-hidden="true">
                      {AREA_GLYPHS[area.area] ?? '◇'}
                    </span>
                    <span className="bsp-xtitle">{area.label}</span>
                    <span className="bsp-xdesc">{area.description}</span>
                    <span className="bsp-xfoot">
                      <span
                        className={`bsp-xstatus ${AREA_X[area.status]}`}
                        data-testid={`area-status-${area.area}`}
                      >
                        {area.statusLabel}
                      </span>
                      <span className="bsp-xcount" data-testid={`area-answered-${area.area}`}>
                        {area.total > 0
                          ? t('bb.answeredOf')
                              .replace('{answered}', String(area.answered))
                              .replace('{total}', String(area.total))
                          : `${area.activeItems} ${t('bb.itemsCount')}`}
                        {area.pendingCandidates > 0
                          ? ` · ${area.pendingCandidates} ${t('bb.pendingCount')}`
                          : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </section>
            )}
          </>
        ) : null}

        {tab === 'look' ? (
          /*
            LOOK & VOICE — `Main.dc.html` lines 868–876: a three-column grid of
            cards; the voice and fonts cards run the full width.
          */
          <section className="bsp-bb-look" data-testid="brand-brain-look">
            {look ? (
              <LookCard
                locale={locale}
                brandId={brandId}
                look={look.data}
                canManage={look.canManage}
                canUpload={look.canUpload}
              >
                {voiceCard}
              </LookCard>
            ) : (
              voiceCard
            )}
          </section>
        ) : null}

        {tab === 'sources' ? (
          /* SOURCES — `Main.dc.html` lines 878–897: the upload card, then the list. */
          <section className="bsp-bb-src" id="bb-sources" data-testid="sources-card">
            {/*
              The real upload form, and the target of a dropped or chosen file.
              It is rendered only when the caller may upload: a control that
              looks live and answers 404 is worse than one that is not there.
            */}
            {permissions.upload ? (
              <form
                ref={uploadRef}
                action="?"
                method="post"
                encType="multipart/form-data"
                data-testid="upload-form"
                className="bsp-card bsp-bb-upcard"
              >
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="brandId" value={brandId} />
                <input type="hidden" name="tab" value="sources" />
                <input type="hidden" name="area" ref={dropAreaRef} defaultValue="" />
                <span className="bsp-bb-uprow">
                  <label className="bsp-btn bsp-pur bsp-bb-pick">
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
                    </svg>
                    {t('bb.uploadFiles')}
                    <input
                      ref={fileRef}
                      type="file"
                      name="file"
                      required
                      className="bs-control bsp-bb-file"
                      data-testid="upload-input"
                      aria-label={t('bb.uploadChoose')}
                      onChange={(event) => setChosenName(event.target.files?.[0]?.name ?? null)}
                    />
                  </label>
                  {chosenName ? (
                    <span className="bsp-bb-upname bsp-ltr" data-testid="upload-chosen">
                      {chosenName}
                    </span>
                  ) : null}
                  <UploadSubmit label={t('bb.upload')} pendingLabel={t('bb.uploading')} />
                </span>
                <small className="bsp-bb-uphint">{t('bb.uploadHint')}</small>
              </form>
            ) : null}

            <div className="bsp-card bsp-bb-srclist">
              {sources.length === 0 ? (
                <p className="bsp-bb-srcempty">{t('bb.sourcesNone')}</p>
              ) : (
                <ul data-testid="source-list">
                  {sources.map((source) => (
                    <SourceRow
                      key={source.id}
                      locale={locale}
                      source={source}
                      canUpload={permissions.upload}
                      canDrop={permissions.upload && permissions.edit}
                    />
                  ))}
                </ul>
              )}
            </div>
          </section>
        ) : null}

        {tab === 'chat' ? (
          /* TALK WITH THE BRAND — the prototype's chat card (lines 899–925). */
          <BrandChat
            locale={locale}
            areas={areas.map((entry) => ({ area: entry.area, label: entry.label }))}
            modes={{ edit: permissions.edit, review: permissions.review }}
            copilotHref={copilotHref}
            start={chatStart}
            brandId={brandId}
            area={chatArea}
            areaLabel={chatAreaLabel}
            canChat={permissions.chat}
            canUpload={permissions.upload}
            initialMessages={[]}
            onClose={() => setTab('knowledge')}
            onAttach={onAttach}
            onAreaDetails={
              chatArea
                ? () => {
                    setTab('knowledge');
                    setOpenArea(chatArea);
                  }
                : null
            }
            labels={{
              // The prototype's chat head: "Brand Brain", answering from n facts.
              title: t('bb.title'),
              subtitle: t('bb.chatSubFacts').replace('{count}', String(totalActiveItems)),
              placeholder: t('bb.chatPlaceholder'),
              send: t('bb.chatSend'),
              cancel: t('bb.chatCancel'),
              thinking: t('bb.chatThinking'),
              empty: t('bb.chatEmpty'),
              sources: t('bb.chatSources'),
              insufficient: t('bb.chatInsufficient'),
              disclaimer: t('bb.chatDisclaimer'),
              retention: t('bb.chatRetention').replace('{days}', String(retentionDays)),
              expired: t('bb.chatExpired'),
              error: t('bb.chatError'),
              close: t('bb.chatClose'),
              contextAll: t('bb.chatContextAll'),
              areaDetails: t('bb.chatAreaDetails'),
              attach: t('bb.chatAttach'),
              suggestions: [
                {
                  label: t('bb.suggestPositioningLabel'),
                  prompt: t('bb.suggestPositioningPrompt'),
                },
                { label: t('bb.suggestGapsLabel'), prompt: t('bb.suggestGapsPrompt') },
                { label: t('bb.suggestVoiceLabel'), prompt: t('bb.suggestVoicePrompt') },
              ],
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The prototype's status chip per area state (`['xstatus neu', 'xstatus warn', 'xstatus']`). */
const AREA_X: Readonly<Record<AreaCardData['status'], string>> = {
  EMPTY: 'bsp-neu',
  IN_PROGRESS: 'bsp-warn',
  NEEDS_ATTENTION: 'bsp-warn',
  COMPLETE: '',
};

/**
 * "Accept the confident ones" — the prototype's card under the banner
 * (`Main.dc.html` line 787): the list it will accept, Accept them, Cancel. It
 * posts only the ids the person saw; the server re-checks every one.
 */
function ConfidentCard({
  locale,
  brandId,
  confident,
  onCancel,
  onOneByOne,
}: {
  locale: string;
  brandId: string;
  confident: readonly ConfidentPreviewEntry[];
  onCancel: () => void;
  onOneByOne: () => void;
}) {
  const t = translator(useMessageLocale(locale));
  return (
    <section className="bsp-card bsp-bb-bulk" data-testid="accept-confident-dialog">
      {confident.length > 0 ? (
        <form action={acceptConfidentCandidatesAction} className="bsp-bb-bulk-f">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="brandId" value={brandId} />
          <b>{t('bb.bulkTitle').replace('{count}', String(confident.length))}</b>
          <ul data-testid="accept-confident-list">
            {confident.map((entry) => (
              <li key={entry.id} data-testid={`accept-confident-${entry.id}`}>
                <input type="hidden" name="candidateId" value={entry.id} />
                <span className="bsp-pill bsp-p-ok bsp-ltr">{entry.confidencePercent}%</span>
                <span dir="auto" className="bsp-bb-bulk-x">
                  {entry.title}
                </span>
                <span className="bsp-bb-bulk-a">{entry.areaLabel}</span>
              </li>
            ))}
          </ul>
          <span className="bsp-bb-bulk-acts">
            <button
              type="submit"
              className="bsp-btn bsp-sm bsp-pur"
              data-testid="accept-confident-confirm"
            >
              {t('bb.bulkOk')}
            </button>
            <button
              type="button"
              className="bsp-btn bsp-sm bsp-ghost"
              data-testid="accept-confident-cancel"
              onClick={onCancel}
            >
              {t('common.cancel')}
            </button>
          </span>
        </form>
      ) : (
        <>
          <span className="bsp-bb-bulk-none">{t('bb.bulkNone')}</span>
          <button type="button" className="bsp-btn bsp-sm bsp-sec" onClick={onOneByOne}>
            {t('bb.oneByOne')}
          </button>
        </>
      )}
    </section>
  );
}

/**
 * The upload button, with its in-flight state (Phase 2C-4): "Uploading…" and
 * disabled while the file travels, so a 20 MiB document does not read as a
 * button that did nothing, and a second press cannot send it twice.
 */
function UploadSubmit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="bsp-btn bsp-sm bsp-sec"
      data-testid="upload-submit"
      formAction={uploadFormAction}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

export type { MessageKey };
export type { OrbNode };
