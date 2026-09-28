'use client';

import { useEffect, useRef, useState } from 'react';
import {
  colorTokens,
  typographyTokens,
  CONTROL_CLASS,
  useOverlayBehaviour,
  usePresence,
  visuallyHiddenStyle,
} from '@brandspace/ui';
import { translator } from '../../../i18n/messages';
import type { AreaCardData, BrandBrainPermissions } from './brand-brain-view';
import {
  archiveKnowledgeAction,
  createKnowledgeAction,
  updateKnowledgeAction,
  uploadSourceAction,
} from './actions';

/** Q19 — the key question a person chose to answer: its fact key and its words. */
export interface QuestionFocus {
  readonly itemKey: string;
  readonly prompt: string;
}

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
 *
 * PHASE 2C: the area's KEY QUESTIONS (Q19) with the unanswered ones turning
 * into the add form's key and placeholder; "valid until" and an Edit form on
 * each fact (D6); and NO review list — candidates are reviewed in the one inbox
 * (D4), which this drawer links to.
 */
export function AreaDrawer({
  locale,
  brandId,
  area: requestedArea,
  focus,
  permissions,
  onClose,
  onAskAbout,
  onReview,
}: {
  locale: string;
  brandId: string;
  area: AreaCardData | null;
  /** Set from "What's missing": the question to answer in the add form. */
  focus: QuestionFocus | null;
  permissions: BrandBrainPermissions;
  onClose: () => void;
  onAskAbout: (area: string) => void;
  /** D4 — open the one review inbox at this area's first candidate. */
  onReview: (area: string) => void;
}) {
  const t = translator(locale);
  // The question being answered: from "What's missing", or chosen here.
  const [chosen, setChosen] = useState<QuestionFocus | null>(focus);
  useEffect(() => setChosen(focus), [focus, requestedArea?.area]);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const open = requestedArea !== null;
  // MO5: while the drawer leaves (180 ms) it keeps showing the area it showed.
  const shownArea = useRef<AreaCardData | null>(requestedArea);
  if (requestedArea) shownArea.current = requestedArea;
  const area = requestedArea ?? shownArea.current;

  // C8 (Phase 2B-2b): Escape, the focus trap, focus in (to the close button)
  // and focus back out come from the shared overlay stack, so a menu or dialog
  // opened from this drawer stacks on it and Escape closes only the top one.
  useOverlayBehaviour({ open, onClose, containerRef: panelRef, initialFocusRef: closeRef });

  useEffect(() => {
    if (!open) return;

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

    return () => {
      document.body.style.overflow = previousOverflow;
      for (const sibling of siblings) sibling.removeAttribute('inert');
    };
  }, [open]);

  const { present, leaving } = usePresence(open, panelRef);
  if (!present || !area) return null;
  const leavingProps = leaving ? { 'data-leaving': '', 'aria-hidden': true, inert: true } : {};

  return (
    <>
      <div
        onClick={onClose}
        data-testid="drawer-overlay"
        {...leavingProps}
        aria-hidden="true"
        style={{ position: 'fixed', inset: 0, background: 'rgba(17,17,20,.18)', zIndex: 40 }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={area.label}
        data-testid="area-drawer"
        // MO5 (§8 overrides this route's pinned motion, D-348): opens from the
        // card's side, rows in order, and leaves before it unmounts.
        className="bs-pop"
        data-origin="end"
        {...leavingProps}
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
            label={t('bb.questionsAnswered')}
            value={t('bb.answeredOf')
              .replace('{answered}', String(area.answered))
              .replace('{total}', String(area.total))}
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

        {/* --- Key questions (Q19) ------------------------------------------ */}
        {area.questions.length > 0 ? (
          <section data-testid="drawer-questions" style={{ display: 'grid', gap: 6 }}>
            <h3 style={{ margin: 0, fontSize: typographyTokens.label.fontSize }}>
              {t('bb.questionsAnswered')}
            </h3>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
              {area.questions.map((question) => (
                <li
                  key={question.itemKey}
                  data-testid={`drawer-question-${question.itemKey}`}
                  data-answered={question.answered ? 'true' : 'false'}
                  style={{ fontSize: typographyTokens.bodySm.fontSize }}
                >
                  <span aria-hidden="true">{question.answered ? '✓ ' : '○ '}</span>
                  {question.answered || !permissions.edit ? (
                    <span>
                      {question.prompt}
                      <span style={visuallyHiddenStyle()}>
                        {' '}
                        {question.answered ? t('bb.questionAnswered') : t('bb.questionOpen')}
                      </span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        setChosen({ itemKey: question.itemKey, prompt: question.prompt })
                      }
                      data-testid={`drawer-answer-${question.itemKey}`}
                      style={{
                        border: 0,
                        padding: 0,
                        background: 'none',
                        color: colorTokens.brandPurplePressed,
                        textDecoration: 'underline',
                        cursor: 'pointer',
                        font: 'inherit',
                        textAlign: 'start',
                      }}
                    >
                      {question.prompt}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
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
                    {t('bb.version')} {item.version} · {item.originLabel} ·{' '}
                    {/*
                      THE LAYER AND ITS AUTHORITY POSITION, together. "Strategy"
                      alone says where the fact lives; "2 of 4" says what that
                      means when two facts disagree — which is the question a
                      reader actually has when they are looking at a conflict.
                    */}
                    <span title={t('bb.memory.authorityHint')} data-testid={`bb-memory-${item.id}`}>
                      {item.memoryLabel} ({item.memoryRank}/{item.memoryDepth})
                    </span>
                    {item.stale ? ` · ${t('bb.attention.stale_items')}` : ''}
                  </small>
                </header>
                {/*
                  D6 — THE END DATE, AND WHAT IT MEANS NOW. Expired is not stale:
                  a stale fact is still used in writing; an expired one never is.
                */}
                {item.expired ? (
                  <small
                    data-testid={`bb-expired-${item.id}`}
                    style={{ fontWeight: 700, fontSize: typographyTokens.micro.fontSize }}
                  >
                    {t('bb.expired')}
                  </small>
                ) : item.validUntil ? (
                  <small
                    data-testid={`bb-valid-until-${item.id}`}
                    style={{
                      color: colorTokens.textMuted,
                      fontSize: typographyTokens.micro.fontSize,
                    }}
                  >
                    {t('bb.validUntilShown').replace('{date}', item.validUntil)}
                  </small>
                ) : null}
                {item.provenance ? (
                  <small
                    data-testid={`bb-provenance-${item.id}`}
                    style={{
                      color: colorTokens.textMuted,
                      fontSize: typographyTokens.micro.fontSize,
                    }}
                  >
                    {item.provenance}
                  </small>
                ) : null}
                {/* D6 remainder — from recorded usage (M5), never from caption text. */}
                <small
                  data-testid={`bb-used-in-${item.id}`}
                  style={{
                    color: colorTokens.textMuted,
                    fontSize: typographyTokens.micro.fontSize,
                  }}
                >
                  {item.usedInPosts === 1
                    ? t('bb.usedInOnePost')
                    : t('bb.usedInPosts').replace('{count}', String(item.usedInPosts))}
                </small>
                <p
                  style={{
                    margin: 0,
                    fontSize: typographyTokens.bodySm.fontSize,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    ...(item.expired ? { color: colorTokens.textMuted } : {}),
                  }}
                >
                  {item.body}
                </p>
                {permissions.edit ? (
                  /*
                   * EDIT — a new version through the ordinary update path, with the
                   * fact's end date beside its words (D6). A native disclosure, the
                   * same pattern the review's "edit, then accept" uses.
                   */
                  <details data-testid={`edit-item-${item.id}`}>
                    <summary
                      style={{
                        cursor: 'pointer',
                        fontSize: typographyTokens.caption.fontSize,
                        fontWeight: 700,
                      }}
                    >
                      {t('bb.editFact')}
                    </summary>
                    <form
                      action={updateKnowledgeAction}
                      style={{ display: 'grid', gap: 8, marginBlockStart: 8 }}
                    >
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="area" value={area.area} />
                      <input type="hidden" name="itemId" value={item.id} />
                      <input
                        className={CONTROL_CLASS}
                        name="titleEn"
                        defaultValue={item.edit.titleEn}
                        aria-label={t('bb.newItem.titleEn')}
                        dir="ltr"
                        style={drawerInputStyle}
                      />
                      <input
                        className={CONTROL_CLASS}
                        name="titleAr"
                        defaultValue={item.edit.titleAr}
                        aria-label={t('bb.newItem.titleAr')}
                        dir="rtl"
                        style={drawerInputStyle}
                      />
                      <textarea
                        className={CONTROL_CLASS}
                        name="bodyEn"
                        rows={3}
                        defaultValue={item.edit.bodyEn}
                        aria-label={t('bb.newItem.bodyEn')}
                        dir="ltr"
                        style={{ ...drawerInputStyle, resize: 'vertical' }}
                      />
                      <textarea
                        className={CONTROL_CLASS}
                        name="bodyAr"
                        rows={3}
                        defaultValue={item.edit.bodyAr}
                        aria-label={t('bb.newItem.bodyAr')}
                        dir="rtl"
                        style={{ ...drawerInputStyle, resize: 'vertical' }}
                      />
                      <ValidUntilField
                        id={`valid-until-${item.id}`}
                        label={t('bb.validUntil')}
                        hint={t('bb.validUntilHint')}
                        defaultValue={item.validUntil ?? ''}
                        testId={`valid-until-${item.id}`}
                      />
                      <button
                        type="submit"
                        data-testid={`save-item-${item.id}`}
                        style={{
                          ...reviewButtonStyle(colorTokens.ink, colorTokens.surface),
                          justifySelf: 'start',
                        }}
                      >
                        {t('common.save')}
                      </button>
                    </form>
                  </details>
                ) : null}
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

        {/* --- Review: the ONE inbox (D4) ---------------------------------- */}
        {area.pendingCandidates > 0 ? (
          <section data-testid="drawer-review" style={{ display: 'grid', gap: 8 }}>
            <p style={{ margin: 0, fontSize: typographyTokens.bodySm.fontSize }}>
              {t('bb.drawerWaiting').replace('{count}', String(area.pendingCandidates))}
            </p>
            {permissions.review ? (
              <button
                type="button"
                data-testid="drawer-open-inbox"
                onClick={() => onReview(area.area)}
                style={{
                  ...reviewButtonStyle(colorTokens.ink, colorTokens.surface),
                  justifySelf: 'start',
                }}
              >
                {t('bb.intelReview')}
              </button>
            ) : null}
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
            {chosen ? (
              <p
                data-testid="new-item-question"
                style={{ margin: 0, fontSize: typographyTokens.bodySm.fontSize, fontWeight: 700 }}
              >
                {chosen.prompt}
              </p>
            ) : null}
            <input
              // Q19 — a chosen question sets the key of the fact that answers it.
              key={chosen?.itemKey ?? 'free'}
              className={CONTROL_CLASS}
              name="itemKey"
              required
              defaultValue={chosen?.itemKey ?? ''}
              placeholder="identity.positioning"
              aria-label={t('bb.newItem.key')}
              data-testid="new-item-key"
              style={drawerInputStyle}
            />
            <input
              className={CONTROL_CLASS}
              name="titleEn"
              placeholder={t('bb.newItem.titleEn')}
              aria-label={t('bb.newItem.titleEn')}
              data-testid="new-item-title-en"
              style={drawerInputStyle}
            />
            <input
              className={CONTROL_CLASS}
              name="titleAr"
              placeholder={t('bb.newItem.titleAr')}
              aria-label={t('bb.newItem.titleAr')}
              style={drawerInputStyle}
            />
            <textarea
              className={CONTROL_CLASS}
              name="bodyEn"
              rows={3}
              // Q19 — the question itself is the placeholder (D3).
              placeholder={chosen?.prompt ?? t('bb.newItem.bodyEn')}
              aria-label={t('bb.newItem.bodyEn')}
              data-testid="new-item-body-en"
              style={{ ...drawerInputStyle, resize: 'vertical' }}
            />
            <textarea
              className={CONTROL_CLASS}
              name="bodyAr"
              rows={3}
              placeholder={chosen?.prompt ?? t('bb.newItem.bodyAr')}
              aria-label={t('bb.newItem.bodyAr')}
              style={{ ...drawerInputStyle, resize: 'vertical' }}
            />
            {/*
              D7 (decision 4.b) — the same Add rule as the chat. With review
              rights the fact is approved now and may carry an end date; with
              edit alone it is SENT FOR REVIEW, and the reviewer sets the date.
            */}
            {permissions.review ? (
              <ValidUntilField
                id="new-item-valid-until"
                label={t('bb.validUntil')}
                hint={t('bb.validUntilHint')}
                defaultValue=""
                testId="new-item-valid-until"
              />
            ) : (
              <p
                data-testid="new-item-review-note"
                style={{ margin: 0, fontSize: typographyTokens.micro.fontSize }}
              >
                {t('bb.sendForReviewNote')}
              </p>
            )}
            <button
              type="submit"
              data-testid="save-knowledge"
              style={{
                ...reviewButtonStyle(colorTokens.brandPurple, colorTokens.surface),
                justifySelf: 'start',
              }}
            >
              {permissions.review ? t('bb.addApprove') : t('bb.sendForReview')}
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
              aria-label={t('bb.uploadChoose')}
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

/**
 * D6 — "valid until": a native date input (a calendar day, no time), empty for
 * "no end date". The hint says whose calendar it is — the workspace's.
 */
function ValidUntilField({
  id,
  label,
  hint,
  defaultValue,
  testId,
}: {
  id: string;
  label: string;
  hint: string;
  defaultValue: string;
  testId: string;
}) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: typographyTokens.caption.fontSize, fontWeight: 700 }}>
        {label}
      </label>
      <input
        id={id}
        type="date"
        name="validUntil"
        className={CONTROL_CLASS}
        defaultValue={defaultValue}
        aria-describedby={`${id}-hint`}
        data-testid={testId}
        style={drawerInputStyle}
      />
      <small
        id={`${id}-hint`}
        style={{ color: colorTokens.textMuted, fontSize: typographyTokens.micro.fontSize }}
      >
        {hint}
      </small>
    </div>
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
