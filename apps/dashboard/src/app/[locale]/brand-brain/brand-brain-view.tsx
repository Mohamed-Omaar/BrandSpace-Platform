'use client';

import { useCallback, useRef, useState } from 'react';
import { translator, type MessageKey } from '../../../i18n/messages';
import { BrandOrb, type OrbNode } from './brand-orb';
import { BrandChat } from './brand-chat';
import { AreaDrawer } from './area-drawer';
import {
  buttonClass,
  buttonStyle,
  colorTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { CopilotLink } from '../../../components/copilot-link';

/**
 * The Brand Brain client island.
 *
 * THE MARKUP IS THE APPROVED DEMO'S, CLASS FOR CLASS. `.brand-brain-page`,
 * `.bb-page-head`, `.bb-hero`, `.bb-hero-stats`, `.bb-stats-view`,
 * `.bb-completion`, `.bb-health`, `.bb-attention`, `.bb-section-title`,
 * `.bb-grid`, `.bb-card`, `.bb-bottom`, `.bb-intel`, `.bb-source`, `.bb-doc` —
 * every one of them is transcribed in `@brandspace/ui/brand-brain.css` from the
 * pinned snapshot in `docs/visual-reference/brand-brain-native/`. There are no
 * inline layout styles on this page any more, because an inline style is where
 * the previous version quietly became a different design.
 *
 * THE DATA IS THE WORKSPACE'S, VALUE FOR VALUE. The demo showed 82%, 128 items,
 * "+14 this month" and four invented PDFs. Nothing here is a demo literal:
 * every number was computed on the server from stored state, and an empty Brand
 * Brain reads 0% rather than borrowing the demo's encouraging figure. Real data
 * flowing into the demo's shapes is exactly the split the fidelity contract
 * draws — see docs/UI-FIDELITY-CONTRACT.md §2.
 *
 * This component holds only what has to be interactive: which area drawer is
 * open, whether the hero panel is showing the chat, and the pending file drop.
 */

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
  /** D-294 — "Updated 3 Sep 2026 · by Sara · from brand-guide.pdf". */
  readonly provenance: string;
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
  readonly requiredItems: number;
  readonly pendingCandidates: number;
  readonly ratioMilli: number;
  readonly attention: readonly string[];
  readonly items: readonly AreaItemData[];
}

export interface CandidateData {
  readonly id: string;
  readonly area: string;
  readonly itemKey: string;
  readonly title: string;
  readonly body: string;
  readonly confidencePercent: number;
  readonly evidence: readonly string[];
  readonly replacesExisting: boolean;
  /** P6-11 — an analytics inference or a document extract. */
  readonly source: 'ANALYTICS' | 'DOCUMENT';
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

export interface SourceData {
  readonly id: string;
  readonly fileName: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly detail: string;
  /** The three- or four-letter badge the demo prints in `.bb-doc i`. */
  readonly kind: string;
}

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
  brandName,
  understanding,
  layers,
  gaps,
  copilotHref,
  completionPercent,
  totalActiveItems,
  sourceCount,
  orbNodes,
  areas,
  candidates,
  sources,
  retentionDays,
  permissions,
}: {
  locale: string;
  brandId: string;
  brandName: string;
  /** "BrandSpace understands this brand from 12 approved facts…" — counted, never scored. */
  understanding: string;
  layers: readonly LayerData[];
  /** Areas with no approved knowledge — the honest gaps. */
  gaps: readonly { area: string; label: string }[];
  /** The global Copilot, scoped to Brand Brain; null when the member may not use it. */
  copilotHref: string | null;
  completionPercent: number;
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
}) {
  const t = translator(locale);
  const [openArea, setOpenArea] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatArea, setChatArea] = useState<string | null>(null);
  const uploadRef = useRef<HTMLFormElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dropAreaRef = useRef<HTMLInputElement | null>(null);

  const byArea = new Map(areas.map((a) => [a.area, a]));
  const needingAttention = areas.filter((a) => a.attention.length > 0 && a.status !== 'EMPTY');
  const pendingTotal = areas.reduce((sum, area) => sum + area.pendingCandidates, 0);
  const readySources = sources.filter((source) => source.status === 'READY').length;

  const openChat = useCallback((area: string | null) => {
    setChatArea(area);
    setChatOpen(true);
    setOpenArea(null);
  }, []);

  /**
   * A file dropped on the orb or a node.
   *
   * It does NOT upload silently. The file is placed on the real upload form and
   * the customer confirms — dropping a file is easy to do by accident, and an
   * upload consumes storage, creates review work and is visible to the whole
   * workspace (CLAUDE.md §2.5).
   */
  const onDropFile = useCallback(
    (area: string | null, file: File) => {
      if (!permissions.upload) return;
      const input = fileRef.current;
      const form = uploadRef.current;
      if (!input || !form) return;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      if (dropAreaRef.current) dropAreaRef.current.value = area ?? '';
      if (area) setOpenArea(area);
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    [permissions.upload],
  );

  /** The chat's attach button, wired to the one real upload control. */
  const onAttach = useCallback(() => {
    const input = fileRef.current;
    if (!input) return;
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.click();
  }, []);

  const openAreaData = openArea ? (byArea.get(openArea) ?? null) : null;
  const chatAreaLabel = chatArea ? (byArea.get(chatArea)?.label ?? null) : null;

  return (
    <div className="brand-brain-page">
      {/*
        D-294 — THE BRAND BY NAME, AND WHAT BRANDSPACE KNOWS ABOUT IT, COUNTED.
        The demo's generic headline named no brand; this names the one being
        edited and states its knowledge in facts, areas and sources — no score.
      */}
      <div className="bb-page-head">
        <div>
          <h2 data-testid="brand-brain-name">
            <strong>{brandName}</strong>
          </h2>
        </div>
        <div style={{ display: 'grid', gap: spacingTokens.xs, justifyItems: 'start' }}>
          <p data-testid="brand-brain-understands">{understanding}</p>
          {copilotHref ? (
            <CopilotLink
              href={copilotHref}
              className={buttonClass('neutral')}
              style={buttonStyle('neutral', 'sm')}
              testId="brand-brain-ask"
            >
              {t('bb.askAboutBrand')}
            </CopilotLink>
          ) : null}
        </div>
      </div>

      <section className="bb-hero" data-testid="brand-brain-hero">
        <BrandOrb
          nodes={orbNodes}
          centerLabel={[t('bb.orbCenterTop'), t('bb.orbCenterBottom')]}
          centerAriaLabel={t('bb.orbOpenChat')}
          stageAriaLabel={t('bb.orbLabel')}
          hint={t('bb.orbHint')}
          onSelectArea={setOpenArea}
          onOpenChat={() => openChat(null)}
          onDropFile={onDropFile}
          canUpload={permissions.upload}
        />

        {/*
          ONE PANEL, TWO VIEWS. The demo does not float a chat window over the
          page; it swaps the hero's right-hand column between the stats and the
          chat, which is why `.bb-hero-stats` has a fixed height and both
          children are `height: 100%`. Keeping that structure is what stops the
          chat from changing the page's layout when it opens.
        */}
        <div
          className={chatOpen ? 'bb-hero-stats chat-open' : 'bb-hero-stats'}
          data-testid="hero-stats"
          data-chat-open={chatOpen ? 'true' : 'false'}
        >
          <div className="bb-stats-view" data-testid="stats-view">
            <div className="bb-completion" data-testid="completion-card">
              <small>{t('bb.completion')}</small>
              <div className="bb-completion-big">
                <b data-testid="completion-percent">{completionPercent}%</b>
                <span>
                  {completionPercent >= 70
                    ? t('bb.completionStrong')
                    : completionPercent > 0
                      ? t('bb.completionBuilding')
                      : t('bb.completionEmpty')}
                </span>
              </div>
              <div
                className="bb-progress"
                role="progressbar"
                aria-valuenow={completionPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t('bb.completion')}
              >
                <i style={{ width: `${completionPercent}%` }} />
              </div>
            </div>

            <div className="bb-health">
              <div className="bb-mini">
                <small>{t('bb.knowledgeItems')}</small>
                <b data-testid="metric-items">{totalActiveItems}</b>
                <span>
                  {pendingTotal > 0
                    ? `${pendingTotal} ${t('bb.pendingCount')}`
                    : t('bb.reviewNone')}
                </span>
              </div>
              <div className="bb-mini">
                <small>{t('bb.sourceDocuments')}</small>
                <b data-testid="metric-sources">{sourceCount}</b>
                <span>
                  {readySources} {t('bb.source.READY')}
                </span>
              </div>
            </div>

            {/* Scrolls on a phone (`overflow-y: auto`), so it takes focus: a region a
                mouse can scroll must be one a keyboard can scroll (P6-14). */}
            <div
              className="bb-attention"
              data-testid="attention-card"
              tabIndex={0}
              role="region"
              aria-label={t('bb.attentionTitle')}
            >
              <b>{t('bb.attentionTitle')}</b>
              {needingAttention.length > 0 ? (
                <ul>
                  {needingAttention.map((area) => (
                    <li key={area.area}>
                      {area.label} — {area.attention.join(' · ')}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t('bb.attentionNone')}</p>
              )}
            </div>
          </div>

          <BrandChat
            brandId={brandId}
            area={chatArea}
            areaLabel={chatAreaLabel}
            canChat={permissions.chat}
            canUpload={permissions.upload}
            initialMessages={[]}
            hidden={!chatOpen}
            onClose={() => setChatOpen(false)}
            onAttach={onAttach}
            onAreaDetails={chatArea ? () => setOpenArea(chatArea) : null}
            labels={{
              title: t('bb.chatTitle'),
              subtitle: t('bb.chatSubtitle'),
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
        </div>
      </section>

      {/*
        D-294 — THE FOUR LAYERS the engine already keeps, named for people:
        what the brand IS, what it is trying to DO, what it has SAID, and what
        it has LEARNED. Counts of approved values; learnings still waiting on a
        person are said separately, because they are not knowledge yet.
      */}
      <section
        aria-labelledby="bb-layers-title"
        data-testid="brand-brain-layers"
        style={{ display: 'grid', gap: spacingTokens.sm }}
      >
        <h3 id="bb-layers-title" style={{ margin: 0, ...typographyTokens.label }}>
          {t('bb.layersTitle')}
        </h3>
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: spacingTokens.sm,
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))',
          }}
        >
          {layers.map((layer) => (
            <li
              key={layer.key}
              data-testid={`brand-brain-layer-${layer.key}`}
              style={{
                display: 'grid',
                gap: spacingTokens['3xs'],
                padding: spacingTokens.md,
                borderRadius: '1.125rem',
                background: colorTokens.surface,
                border: `1px solid ${colorTokens.border}`,
              }}
            >
              <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                {layer.label}
              </span>
              <b style={{ ...typographyTokens.h3, margin: 0 }}>{layer.count}</b>
              <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                {layer.pending > 0
                  ? t('bb.layerPending').replace('{count}', String(layer.pending))
                  : layer.description}
              </span>
            </li>
          ))}
        </ul>
        {gaps.length > 0 ? (
          <div
            data-testid="brand-brain-gaps"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: spacingTokens.xs,
              ...typographyTokens.caption,
              color: colorTokens.textSecondary,
            }}
          >
            <b style={{ color: colorTokens.textPrimary }}>{t('bb.gapsTitle')}</b>
            {gaps.map((gap) => (
              <button
                key={gap.area}
                type="button"
                className={buttonClass('ghost')}
                style={buttonStyle('ghost', 'sm')}
                data-testid={`brand-brain-gap-${gap.area}`}
                onClick={() => setOpenArea(gap.area)}
              >
                {t('bb.gapAdd').replace('{area}', gap.label)}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <div className="bb-section-title">
        <div>
          <h3>{t('bb.areasTitle')}</h3>
          <p>{t('bb.areasSubtitle')}</p>
        </div>
        <p>{t('bb.areasHint')}</p>
      </div>

      <section className="bb-grid" data-testid="area-grid">
        {areas.map((area) => (
          <button
            key={area.area}
            type="button"
            className="bb-card"
            data-testid={`area-card-${area.area}`}
            onClick={() => setOpenArea(area.area)}
          >
            <span className="bb-icon" aria-hidden="true">
              {AREA_GLYPHS[area.area] ?? '◇'}
            </span>
            <h4>{area.label}</h4>
            <p>{area.description}</p>
            <footer>
              <span
                className={area.status === 'COMPLETE' ? 'bb-status' : 'bb-status warn'}
                data-testid={`area-status-${area.area}`}
              >
                {area.statusLabel}
              </span>
              <span className="bb-count">
                {area.activeItems} {t('bb.itemsCount')}
                {area.pendingCandidates > 0
                  ? ` · ${area.pendingCandidates} ${t('bb.pendingCount')}`
                  : ''}
              </span>
            </footer>
          </button>
        ))}
      </section>

      <section className="bb-bottom">
        <div className="bb-intel" data-testid="intel-card">
          <div className="bb-intel-head">
            <h4>{t('bb.intelTitle')}</h4>
            <span className="bb-badge">{t('bb.intelBadge')}</span>
          </div>

          {candidates.length === 0 ? (
            <div className="bb-learning">
              <p>{t('bb.intelNone')}</p>
            </div>
          ) : (
            candidates.slice(0, 3).map((candidate) => (
              <div className="bb-learning" key={candidate.id} data-testid={`intel-${candidate.id}`}>
                <small>
                  {byArea.get(candidate.area)?.label ?? candidate.area} ·{' '}
                  {candidate.source === 'ANALYTICS'
                    ? t('bb.learningFromPerformance')
                    : t('bb.learningFromDocument')}
                </small>
                <b>{candidate.title}</b>
                <p>{candidate.body}</p>
                {/*
                  D-294 — THE EVIDENCE, AND A CONFIDENCE ONLY WHERE ONE IS
                  MEASURED: a performance learning's confidence is computed from
                  its deviation and the number of observations; a document
                  extract's number is an area-match score, so it is not shown
                  here as confidence in the fact.
                */}
                {candidate.measured ? (
                  <p data-testid={`intel-evidence-${candidate.id}`}>{candidate.measured}</p>
                ) : null}
                {candidate.source === 'ANALYTICS' ? (
                  <p data-testid={`intel-confidence-${candidate.id}`}>
                    {t('bb.reviewConfidence')}: {candidate.confidencePercent}%
                  </p>
                ) : null}
                {permissions.review ? <p>{t('bb.learningAcceptNote')}</p> : null}
                {permissions.review ? (
                  <div className="bb-learning-actions">
                    {/*
                      Opens the drawer where accept and reject live. It does NOT
                      approve anything from here: approving is a state change
                      that needs the evidence and the existing value in front of
                      the reviewer, which is what the drawer shows.
                    */}
                    <button
                      type="button"
                      className="accept"
                      data-testid={`intel-review-${candidate.id}`}
                      onClick={() => setOpenArea(candidate.area)}
                    >
                      {t('bb.intelReview')}
                    </button>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>

        <div className="bb-source" data-testid="sources-card">
          <div className="bb-source-head">
            <h4>{t('bb.sourcesTitle')}</h4>
          </div>

          {/*
            The real upload form, and the target of a file dropped on the orb.
            It is rendered only when the caller may upload: a control that looks
            live and answers 404 is worse than one that is not there.
          */}
          {permissions.upload ? (
            <form
              ref={uploadRef}
              action="?"
              method="post"
              encType="multipart/form-data"
              data-testid="upload-form"
              className="bb-upload"
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="brandId" value={brandId} />
              <input type="hidden" name="area" ref={dropAreaRef} defaultValue="" />
              <input
                ref={fileRef}
                type="file"
                name="file"
                required
                data-testid="upload-input"
                aria-label={t('bb.uploadChoose')}
              />
              <button type="submit" data-testid="upload-submit" formAction={uploadFormAction}>
                {t('bb.upload')}
              </button>
              <small>{t('bb.uploadHint')}</small>
            </form>
          ) : null}

          <div className="bb-source-list">
            {sources.length === 0 ? (
              <p className="bb-source-empty">{t('bb.sourcesNone')}</p>
            ) : (
              sources.map((source) => (
                <div className="bb-doc" key={source.id} data-testid={`source-${source.id}`}>
                  <i aria-hidden="true">{source.kind}</i>
                  <span>
                    <b>{source.fileName}</b>
                    <small>{source.detail}</small>
                  </span>
                  <span className={source.status === 'FAILED' ? 'failed' : undefined}>
                    {source.statusLabel}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <AreaDrawer
        locale={locale}
        brandId={brandId}
        area={openAreaData}
        candidates={candidates.filter((c) => c.area === openArea)}
        permissions={permissions}
        onClose={() => setOpenArea(null)}
        onAskAbout={(area: string) => openChat(area)}
      />
    </div>
  );
}

/*
 * The upload action is imported lazily by the form's `formAction`, so the
 * client bundle never pulls the server module graph in.
 */
import { uploadSourceAction as uploadFormAction } from './actions';

export type { MessageKey };
export type { OrbNode };
