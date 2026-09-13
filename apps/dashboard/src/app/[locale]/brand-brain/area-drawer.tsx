'use client';

import { useEffect, useRef } from 'react';
import { colorTokens, typographyTokens, CONTROL_CLASS } from '@brandspace/ui';
import { translator } from '../../../i18n/messages';
import type { AreaCardData, BrandBrainPermissions, CandidateData } from './brand-brain-view';
import {
  archiveKnowledgeAction,
  createKnowledgeAction,
  reviewCandidateAction,
  uploadSourceAction,
} from './actions';

/**
 * The knowledge-area detail drawer.
 *
 * ACCESSIBILITY IS THE DESIGN HERE, not a pass over it afterwards:
 *
 *   - `role="dialog"` + `aria-modal`, so assistive technology announces it as a
 *     layer over the page rather than more of the page.
 *   - FOCUS MOVES IN on open and RETURNS to the trigger on close. A drawer that
 *     leaves focus behind strands a keyboard user at the top of the document.
 *   - Focus is TRAPPED while open. Tab from the last control wraps to the
 *     first, so a keyboard user cannot fall into the page underneath.
 *   - Escape closes.
 *   - The page behind is `inert`, so nothing under the overlay is clickable,
 *     focusable or reachable — a pointer-events-only overlay still lets Tab
 *     walk straight through it.
 *   - Body scroll is locked, so the page does not drift behind the drawer.
 *
 * EVERY CONTROL IS REAL OR ABSENT. A button that looks live and answers 404 is
 * worse than a missing one, so each block is gated on its own permission.
 */
export function AreaDrawer({
  locale,
  brandId,
  area,
  candidates,
  permissions,
  onClose,
  onAskAbout,
}: {
  locale: string;
  brandId: string;
  area: AreaCardData | null;
  candidates: readonly CandidateData[];
  permissions: BrandBrainPermissions;
  onClose: () => void;
  onAskAbout: (area: string) => void;
}) {
  const t = translator(locale);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const open = area !== null;

  useEffect(() => {
    if (!open) return;

    // Remember where focus was, so it can go back exactly there.
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Everything that is not the drawer becomes inert. `inert` removes the
    // subtree from the accessibility tree AND from the tab order, which an
    // overlay alone does not.
    const siblings: HTMLElement[] = [];
    const panel = panelRef.current;
    if (panel?.parentElement) {
      for (const child of Array.from(document.body.children)) {
        if (child instanceof HTMLElement && !child.contains(panel)) {
          siblings.push(child);
          child.setAttribute('inert', '');
        }
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input:not([type="hidden"]), select, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      for (const sibling of siblings) sibling.removeAttribute('inert');
      returnFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!area) return null;

  return (
    <>
      <div
        onClick={onClose}
        data-testid="drawer-overlay"
        aria-hidden="true"
        style={{ position: 'fixed', inset: 0, background: 'rgba(17,17,20,.18)', zIndex: 40 }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={area.label}
        data-testid="area-drawer"
        style={{
          position: 'fixed',
          insetBlock: 0,
          insetInlineEnd: 0,
          width: 'min(480px, 100%)',
          maxWidth: '100vw',
          background: 'rgba(255,255,255,.98)',
          boxShadow: '-20px 0 70px rgba(25,20,40,.16)',
          zIndex: 41,
          padding: '20px',
          overflowY: 'auto',
          // The panel is its own scroller, so long content never makes the page
          // behind it scroll and never overflows a small screen horizontally.
          overscrollBehavior: 'contain',
          display: 'grid',
          gap: 14,
          alignContent: 'start',
        }}
      >
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 10 }}
        >
          <div style={{ minWidth: 0 }}>
            <h2
              style={{ margin: 0, fontSize: typographyTokens.h2.fontSize, letterSpacing: '-.04em' }}
            >
              {area.label}
            </h2>
            <p
              style={{
                margin: '6px 0 0',
                color: colorTokens.textMuted,
                fontSize: typographyTokens.bodySm.fontSize,
                lineHeight: 1.6,
              }}
            >
              {area.description}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('bb.detailClose')}
            data-testid="drawer-close"
            style={{
              border: 0,
              borderRadius: 12,
              width: 36,
              height: 36,
              background: colorTokens.controlSurface,
              cursor: 'pointer',
              font: 'inherit',
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: 10,
            margin: 0,
          }}
        >
          {/* The VALUE is translated on the server; this is its caption. */}
          <Field label={t('bb.fieldStatus')} value={area.statusLabel} testId="drawer-status" />
          <Field
            label={t('bb.knowledgeItems')}
            value={`${area.activeItems} / ${area.requiredItems}`}
            testId="drawer-count"
          />
          {area.pendingCandidates > 0 ? (
            <Field
              label={t('bb.pendingCount')}
              value={String(area.pendingCandidates)}
              testId="drawer-pending"
            />
          ) : null}
        </dl>

        {area.attention.length > 0 ? (
          <p
            data-testid="drawer-attention"
            style={{
              margin: 0,
              padding: 12,
              borderRadius: 14,
              background: colorTokens.brandYellowTint,
              fontSize: typographyTokens.bodySm.fontSize,
            }}
          >
            {area.attention.join(' · ')}
          </p>
        ) : null}

        {permissions.chat ? (
          <button
            type="button"
            data-testid="drawer-ask"
            onClick={() => onAskAbout(area.area)}
            style={{
              justifySelf: 'start',
              border: 0,
              borderRadius: 12,
              padding: '9px 14px',
              background: colorTokens.brandPurple,
              color: colorTokens.surface,
              fontWeight: 700,
              fontSize: typographyTokens.bodySm.fontSize,
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            {t('bb.chatOpen')}
          </button>
        ) : null}

        {/* --- Existing knowledge ------------------------------------------ */}
        <section style={{ display: 'grid', gap: 8 }}>
          {area.items.length === 0 ? (
            <p
              data-testid="drawer-empty"
              style={{
                margin: 0,
                color: colorTokens.textMuted,
                fontSize: typographyTokens.bodySm.fontSize,
              }}
            >
              {t('bb.detailEmpty')}
            </p>
          ) : (
            area.items.map((item) => (
              <article
                key={item.id}
                data-testid={`knowledge-item-${item.id}`}
                style={{
                  padding: 12,
                  borderRadius: 14,
                  background: colorTokens.surfaceSoft,
                  display: 'grid',
                  gap: 6,
                }}
              >
                <header
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                    alignItems: 'baseline',
                  }}
                >
                  <b style={{ fontSize: typographyTokens.label.fontSize }}>
                    {item.title || item.itemKey}
                  </b>
                  <small
                    style={{
                      color: colorTokens.textMuted,
                      fontSize: typographyTokens.micro.fontSize,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('bb.version')} {item.version} · {item.originLabel}
                    {item.stale ? ` · ${t('bb.attention.stale_items')}` : ''}
                  </small>
                </header>
                <p
                  style={{
                    margin: 0,
                    fontSize: typographyTokens.bodySm.fontSize,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {item.body}
                </p>
                {permissions.remove ? (
                  <form action={archiveKnowledgeAction} style={{ justifySelf: 'start' }}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="area" value={area.area} />
                    <input type="hidden" name="itemId" value={item.id} />
                    <button
                      type="submit"
                      data-testid={`archive-${item.id}`}
                      style={{
                        border: 0,
                        borderRadius: 10,
                        padding: '6px 10px',
                        background: colorTokens.surfaceMuted,
                        fontSize: typographyTokens.caption.fontSize,
                        fontWeight: 700,
                        cursor: 'pointer',
                        font: 'inherit',
                      }}
                    >
                      {t('bb.archive')}
                    </button>
                  </form>
                ) : null}
              </article>
            ))
          )}
        </section>

        {/* --- Review queue ------------------------------------------------- */}
        {permissions.review ? (
          <section data-testid="drawer-review" style={{ display: 'grid', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: typographyTokens.label.fontSize }}>
              {t('bb.reviewTitle')}
            </h3>
            {candidates.length === 0 ? (
              <p
                style={{
                  margin: 0,
                  color: colorTokens.textMuted,
                  fontSize: typographyTokens.bodySm.fontSize,
                }}
              >
                {t('bb.reviewNone')}
              </p>
            ) : (
              candidates.map((candidate) => (
                <article
                  key={candidate.id}
                  data-testid={`candidate-${candidate.id}`}
                  style={{
                    padding: 12,
                    borderRadius: 14,
                    background: colorTokens.surfaceLavender,
                    display: 'grid',
                    gap: 6,
                  }}
                >
                  <b style={{ fontSize: typographyTokens.bodySm.fontSize }}>
                    {candidate.title || candidate.itemKey}
                  </b>
                  <p
                    style={{
                      margin: 0,
                      fontSize: typographyTokens.bodySm.fontSize,
                      lineHeight: 1.55,
                    }}
                  >
                    {candidate.body}
                  </p>
                  <small
                    style={{
                      color: colorTokens.textMuted,
                      fontSize: typographyTokens.micro.fontSize,
                    }}
                  >
                    {t('bb.reviewConfidence')}: {candidate.confidencePercent}%
                    {candidate.replacesExisting ? ` · ${t('bb.reviewExisting')}` : ''}
                  </small>
                  {candidate.evidence.length > 0 ? (
                    <small
                      style={{
                        color: colorTokens.textMuted,
                        fontSize: typographyTokens.micro.fontSize,
                      }}
                    >
                      {t('bb.reviewEvidence')}: {candidate.evidence.join(' / ')}
                    </small>
                  ) : null}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <form action={reviewCandidateAction}>
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="area" value={area.area} />
                      <input type="hidden" name="candidateId" value={candidate.id} />
                      <input type="hidden" name="decision" value="accept" />
                      <button
                        type="submit"
                        data-testid={`accept-${candidate.id}`}
                        style={reviewButtonStyle(colorTokens.ink, colorTokens.surface)}
                      >
                        {t('bb.reviewAccept')}
                      </button>
                    </form>
                    <form action={reviewCandidateAction}>
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="area" value={area.area} />
                      <input type="hidden" name="candidateId" value={candidate.id} />
                      <input type="hidden" name="decision" value="reject" />
                      <button
                        type="submit"
                        data-testid={`reject-${candidate.id}`}
                        style={reviewButtonStyle(colorTokens.surfaceMuted, colorTokens.ink)}
                      >
                        {t('bb.reviewReject')}
                      </button>
                    </form>
                  </div>
                </article>
              ))
            )}
          </section>
        ) : null}

        {/* --- Add knowledge ------------------------------------------------ */}
        {permissions.edit ? (
          <form
            action={createKnowledgeAction}
            data-testid="add-knowledge-form"
            style={{
              display: 'grid',
              gap: 8,
              padding: 12,
              borderRadius: 14,
              background: colorTokens.surfaceSoft,
            }}
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="brandId" value={brandId} />
            <input type="hidden" name="area" value={area.area} />
            <input
              className={CONTROL_CLASS}
              name="itemKey"
              required
              placeholder="identity.positioning"
              aria-label="key"
              data-testid="new-item-key"
              style={drawerInputStyle}
            />
            <input
              className={CONTROL_CLASS}
              name="titleEn"
              placeholder="Title (EN)"
              aria-label="Title EN"
              data-testid="new-item-title-en"
              style={drawerInputStyle}
            />
            <input
              className={CONTROL_CLASS}
              name="titleAr"
              placeholder="العنوان (AR)"
              aria-label="Title AR"
              style={drawerInputStyle}
            />
            <textarea
              className={CONTROL_CLASS}
              name="bodyEn"
              rows={3}
              placeholder="Body (EN)"
              aria-label="Body EN"
              data-testid="new-item-body-en"
              style={{ ...drawerInputStyle, resize: 'vertical' }}
            />
            <textarea
              className={CONTROL_CLASS}
              name="bodyAr"
              rows={3}
              placeholder="النص (AR)"
              aria-label="Body AR"
              style={{ ...drawerInputStyle, resize: 'vertical' }}
            />
            <button
              type="submit"
              data-testid="save-knowledge"
              style={{
                ...reviewButtonStyle(colorTokens.brandPurple, colorTokens.surface),
                justifySelf: 'start',
              }}
            >
              {t('common.save')}
            </button>
          </form>
        ) : null}

        {/* --- Upload into this area ---------------------------------------- */}
        {permissions.upload ? (
          <form
            action={uploadSourceAction}
            encType="multipart/form-data"
            data-testid="drawer-upload-form"
            style={{ display: 'grid', gap: 8 }}
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="brandId" value={brandId} />
            <input type="hidden" name="area" value={area.area} />
            <input
              type="file"
              name="file"
              required
              aria-label={t('bb.upload')}
              data-testid="drawer-upload-input"
              style={{ font: 'inherit', fontSize: typographyTokens.bodySm.fontSize }}
            />
            <button
              type="submit"
              data-testid="drawer-upload-submit"
              style={{
                ...reviewButtonStyle(colorTokens.ink, colorTokens.surface),
                justifySelf: 'start',
              }}
            >
              {t('bb.upload')}
            </button>
          </form>
        ) : null}
      </div>
    </>
  );
}

function Field({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div style={{ padding: 10, borderRadius: 12, background: colorTokens.surfaceSoft }}>
      <dt
        style={{
          color: colorTokens.textMuted,
          fontSize: typographyTokens.micro.fontSize,
          textTransform: 'uppercase',
          letterSpacing: '.08em',
        }}
      >
        {label}
      </dt>
      <dd
        data-testid={testId}
        style={{ margin: '6px 0 0', fontSize: typographyTokens.bodySm.fontSize, fontWeight: 700 }}
      >
        {value}
      </dd>
    </div>
  );
}

const drawerInputStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 10,
  border: '1px solid rgba(17,17,20,.14)',
  font: 'inherit',
  fontSize: typographyTokens.bodySm.fontSize,
  minWidth: 0,
};

function reviewButtonStyle(background: string, color: string): React.CSSProperties {
  return {
    border: 0,
    borderRadius: 10,
    padding: '8px 12px',
    background,
    color,
    fontSize: typographyTokens.caption.fontSize,
    fontWeight: 800,
    cursor: 'pointer',
    font: 'inherit',
  };
}
