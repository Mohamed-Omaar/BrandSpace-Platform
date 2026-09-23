'use client';

import { useCallback, useRef, useState } from 'react';
import { translator, type MessageKey } from '../../../i18n/messages';
import { BrandOrb, type OrbNode } from './brand-orb';
import { BrandChat } from './brand-chat';
import { AreaDrawer } from './area-drawer';

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
      <div className="bb-page-head">
        <div>
          <h2>
            {t('bb.heroTitle')}
            <br />
            <strong>{t('bb.heroTitleAccent')}</strong>
          </h2>
        </div>
        <p>{t('bb.heroBody')}</p>
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

            <div className="bb-attention" data-testid="attention-card">
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
                <small>{byArea.get(candidate.area)?.label ?? candidate.area}</small>
                <b>{candidate.title}</b>
                <p>{candidate.body}</p>
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
