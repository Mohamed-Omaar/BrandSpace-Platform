'use client';

import { useEffect, useId, useState, type Ref } from 'react';
import { Button, CONTROL_CLASS, Dialog, colorTokens, typographyTokens } from '@brandspace/ui';
import { translator } from '../../../i18n/messages';
import type { CandidateData } from './brand-brain-view';
import { acceptConfidentCandidatesAction, reviewCandidateAction } from './actions';

/**
 * D4 + C1 (Phase 2C) — THE ONE REVIEW INBOX.
 *
 * Pending facts from every area, ONE CARD AT A TIME, oldest first, inside the
 * approved demo's own intelligence card: `.bb-intel`, `.bb-learning` and its
 * `.accept` / `.later` buttons are the demo's markup, transcribed in
 * `@brandspace/ui/brand-brain.css`. The per-area review list the drawer used to
 * carry is gone — there is one queue.
 *
 * Each card shows the source's own words, the area, a confidence LABEL from the
 * configured thresholds and why, and — when the candidate would replace an
 * approved fact — both side by side. Actions: Accept · Edit & accept · Reject ·
 * Later ("Later" only moves on; it writes nothing). Where precedence refuses a
 * plain accept (an analytics learning against a human, document or setup fact:
 * owner decision 2.a, D-65), Accept is not offered: Reject, or "Edit fact" —
 * an ordinary human edit of the approved fact.
 *
 * "Accept the confident ones" previews the list in a dialog and posts only the
 * ids the person saw; the server re-checks every one (`reviewCandidates`).
 */

export interface ConfidentPreviewEntry {
  readonly id: string;
  readonly title: string;
  readonly areaLabel: string;
  readonly confidencePercent: number;
}

export function ReviewInbox({
  ref,
  locale,
  brandId,
  candidates,
  confident,
  pendingTotal,
  focusArea,
  focusCandidateId,
  canReview,
  canEdit,
  onEditFact,
}: {
  ref?: Ref<HTMLDivElement>;
  locale: string;
  brandId: string;
  candidates: readonly CandidateData[];
  confident: readonly ConfidentPreviewEntry[];
  pendingTotal: number;
  /** Set from an area drawer: jump to that area's first candidate. */
  focusArea: string | null;
  /** `?candidate=` — open the inbox on that candidate (a link from elsewhere). */
  focusCandidateId: string | null;
  canReview: boolean;
  canEdit: boolean;
  onEditFact: (area: string) => void;
}) {
  const t = translator(locale);
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      candidates.findIndex((candidate) => candidate.id === focusCandidateId),
    ),
  );
  const [confirming, setConfirming] = useState(false);
  const formId = useId();
  const titleId = useId();

  useEffect(() => {
    if (!focusArea) return;
    const found = candidates.findIndex((candidate) => candidate.area === focusArea);
    if (found >= 0) setIndex(found);
  }, [focusArea, candidates]);

  const count = candidates.length;
  const current = count > 0 ? candidates[index % count] : undefined;

  return (
    <div className="bb-intel" data-testid="intel-card" ref={ref} aria-labelledby={titleId}>
      <div className="bb-intel-head">
        <h4 id={titleId}>{t('bb.inboxTitle')}</h4>
        <span className="bb-badge" data-testid="review-inbox-count">
          {t('bb.inboxWaiting').replace('{count}', String(pendingTotal))}
        </span>
      </div>

      {!canReview ? (
        <div className="bb-learning">
          <p>{pendingTotal > 0 ? t('bb.inboxForReviewers') : t('bb.intelNone')}</p>
        </div>
      ) : !current ? (
        <div className="bb-learning" data-testid="review-inbox-empty">
          <p>{t('bb.intelNone')}</p>
        </div>
      ) : (
        <div
          className="bb-learning"
          key={current.id}
          data-testid={`intel-${current.id}`}
          aria-live="polite"
        >
          <small>
            {current.areaLabel} ·{' '}
            {current.source === 'ANALYTICS'
              ? t('bb.learningFromPerformance')
              : current.source === 'MEMBER'
                ? t('bb.learningFromMember')
                : t('bb.learningFromDocument')}{' '}
            ·{' '}
            <span data-testid="review-inbox-position">
              {t('bb.inboxPosition')
                .replace('{n}', String((index % count) + 1))
                .replace('{count}', String(count))}
            </span>
          </small>
          <b>{current.title || current.itemKey}</b>

          {current.replaced ? (
            /*
             * D4 — OLD AND NEW SIDE BY SIDE. Accepting makes the proposal the
             * approved fact; the old one is kept in the history (a new version,
             * or archived as superseded), never deleted.
             */
            <div
              data-testid={`inbox-compare-${current.id}`}
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))',
                gap: 10,
                margin: '8px 0',
              }}
            >
              <div data-testid={`inbox-current-${current.id}`}>
                <small>{t('bb.reviewExisting')}</small>
                <p>
                  <s>{current.replaced.body || current.replaced.title}</s>
                </p>
              </div>
              <div data-testid={`inbox-proposed-${current.id}`}>
                <small>{t('bb.reviewProposed')}</small>
                <p>{current.body}</p>
              </div>
            </div>
          ) : (
            <p>{current.body}</p>
          )}

          {current.snippet ? (
            <p data-testid={`inbox-snippet-${current.id}`}>
              {t('bb.inboxSnippet')}: “{current.snippet}”
            </p>
          ) : null}
          {current.measured ? (
            <p data-testid={`intel-evidence-${current.id}`}>{current.measured}</p>
          ) : null}
          {current.source === 'MEMBER' ? (
            // D7 — a person's own words carry no confidence; who sent it does.
            <p data-testid={`intel-proposed-by-${current.id}`}>{current.proposedBy}</p>
          ) : (
            <p data-testid={`intel-confidence-${current.id}`}>
              {current.confidenceLabel} · {current.confidencePercent}% — {current.confidenceWhy}
            </p>
          )}
          {current.source === 'ANALYTICS' ? <p>{t('bb.learningAcceptNote')}</p> : null}
          {current.conflict ? (
            <p role="note" data-testid={`candidate-conflict-${current.id}`}>
              {current.conflict}
            </p>
          ) : null}
          {current.sourceHref ? (
            <p>
              <a href={current.sourceHref} data-testid={`candidate-insight-${current.id}`}>
                {t('bb.reviewOpenFinding')}
              </a>
            </p>
          ) : null}

          <div className="bb-learning-actions">
            {current.acceptAllowed ? (
              <form action={reviewCandidateAction}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="area" value={current.area} />
                <input type="hidden" name="candidateId" value={current.id} />
                <input type="hidden" name="decision" value="accept" />
                <button type="submit" className="accept" data-testid={`accept-${current.id}`}>
                  {t('bb.reviewAccept')}
                </button>
              </form>
            ) : null}
            <form action={reviewCandidateAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="area" value={current.area} />
              <input type="hidden" name="candidateId" value={current.id} />
              <input type="hidden" name="decision" value="reject" />
              <button type="submit" className="later" data-testid={`reject-${current.id}`}>
                {t('bb.reviewReject')}
              </button>
            </form>
            {!current.acceptAllowed && current.replaced && canEdit ? (
              <button
                type="button"
                className="later"
                data-testid={`edit-fact-${current.id}`}
                onClick={() => onEditFact(current.replaced!.area)}
              >
                {t('bb.inboxEditFact')}
              </button>
            ) : null}
            {count > 1 ? (
              <button
                type="button"
                className="later"
                data-testid={`later-${current.id}`}
                onClick={() => setIndex((value) => (value + 1) % count)}
              >
                {t('bb.inboxLater')}
              </button>
            ) : null}
          </div>

          {!current.acceptAllowed ? (
            <p data-testid={`inbox-precedence-${current.id}`}>{t('bb.inboxPrecedence')}</p>
          ) : (
            /*
             * EDIT, THEN ACCEPT — a native disclosure, keyboard-operable without
             * script, holding the same inputs the drawer's add form uses. The
             * service keeps the original extraction beside the reviewer's text.
             */
            <details data-testid={`edit-${current.id}`}>
              <summary
                style={{
                  cursor: 'pointer',
                  fontSize: typographyTokens.caption.fontSize,
                  fontWeight: 700,
                }}
              >
                {t('bb.reviewEdit')}
              </summary>
              <form
                action={reviewCandidateAction}
                style={{ display: 'grid', gap: 8, marginBlockStart: 8 }}
              >
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="area" value={current.area} />
                <input type="hidden" name="candidateId" value={current.id} />
                <input type="hidden" name="decision" value="accept_edited" />
                <input
                  className={CONTROL_CLASS}
                  name="titleEn"
                  defaultValue={current.edit.titleEn}
                  aria-label={t('bb.reviewEditTitleEn')}
                  dir="ltr"
                  style={inputStyle}
                />
                <input
                  className={CONTROL_CLASS}
                  name="titleAr"
                  defaultValue={current.edit.titleAr}
                  aria-label={t('bb.reviewEditTitleAr')}
                  dir="rtl"
                  style={inputStyle}
                />
                <textarea
                  className={CONTROL_CLASS}
                  name="bodyEn"
                  rows={3}
                  defaultValue={current.edit.bodyEn}
                  aria-label={t('bb.reviewEditBodyEn')}
                  dir="ltr"
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
                <textarea
                  className={CONTROL_CLASS}
                  name="bodyAr"
                  rows={3}
                  defaultValue={current.edit.bodyAr}
                  aria-label={t('bb.reviewEditBodyAr')}
                  dir="rtl"
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
                <div className="bb-learning-actions">
                  <button
                    type="submit"
                    className="accept"
                    data-testid={`accept-edited-${current.id}`}
                  >
                    {t('bb.reviewAcceptEdited')}
                  </button>
                </div>
              </form>
            </details>
          )}
        </div>
      )}

      {canReview && confident.length > 0 ? (
        <div className="bb-learning-actions">
          <button
            type="button"
            className="accept"
            data-testid="accept-confident-open"
            onClick={() => setConfirming(true)}
          >
            {t('bb.acceptConfident').replace('{count}', String(confident.length))}
          </button>
        </div>
      ) : null}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('bb.acceptConfidentTitle')}
        description={t('bb.acceptConfidentBody')}
        closeLabel={t('bb.detailClose')}
        testId="accept-confident-dialog"
        footer={
          <>
            <Button
              variant="neutral"
              onClick={() => setConfirming(false)}
              data-testid="accept-confident-cancel"
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="brand"
              type="submit"
              form={formId}
              data-testid="accept-confident-confirm"
            >
              {t('bb.acceptConfidentConfirm').replace('{count}', String(confident.length))}
            </Button>
          </>
        }
      >
        <form id={formId} action={acceptConfidentCandidatesAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="brandId" value={brandId} />
          <ul data-testid="accept-confident-list" style={{ margin: 0, paddingInlineStart: 18 }}>
            {confident.map((entry) => (
              <li
                key={entry.id}
                data-testid={`accept-confident-${entry.id}`}
                style={{
                  fontSize: typographyTokens.bodySm.fontSize,
                  color: colorTokens.textPrimary,
                }}
              >
                <input type="hidden" name="candidateId" value={entry.id} />
                {entry.title} · {entry.areaLabel} · {entry.confidencePercent}%
              </li>
            ))}
          </ul>
        </form>
      </Dialog>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 10,
  border: '1px solid rgba(17,17,20,.14)',
  font: 'inherit',
  fontSize: typographyTokens.bodySm.fontSize,
  minWidth: 0,
};
