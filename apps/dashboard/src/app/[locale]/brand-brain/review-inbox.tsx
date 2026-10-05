'use client';

import { useEffect, useId, useState, type Ref } from 'react';
import { translator } from '../../../i18n/messages';
import type { CandidateData } from './brand-brain-view';
import { reviewCandidateAction } from './actions';
import { useMessageLocale } from '../../../i18n/message-locale-context';

/**
 * D4 + C1 (Phase 2C) — THE ONE REVIEW, in the prototype's review card
 * (`Main.dc.html` lines 789–802, D-468).
 *
 * Pending facts from every area, ONE CARD AT A TIME, oldest first. It opens
 * from "Review one by one" (or an area's waiting list, or `?candidate=`) and
 * stays open across its own posts. Each card says where the fact goes, a
 * confidence LABEL from the configured thresholds and why, the fact in large
 * type, and what was found in the source; when it would replace an approved
 * fact, both side by side. Actions: Accept · Edit, then accept · Reject ·
 * Later ("Later" only moves on; it writes nothing). Where precedence refuses a
 * plain accept (an analytics learning against a human, document or setup fact:
 * owner decision 2.a, D-65), Accept is not offered: Reject, or "Edit fact" —
 * an ordinary human edit of the approved fact.
 *
 * "Edit, then accept" is the prototype's Edit button, which swaps the fact for
 * its fields and the buttons for Save and Cancel (it was a `<summary>` too
 * small to hit; owner decision on the batch 2–6 brief). The product's fields
 * are both languages of the title and body — the service keeps the original
 * extraction beside the reviewer's text.
 */

export interface ConfidentPreviewEntry {
  readonly id: string;
  readonly title: string;
  readonly areaLabel: string;
  readonly confidencePercent: number;
}

/**
 * The prototype's pill per confidence band (`p-ok` high, `p-warn` medium,
 * `p-bad` low). The band itself comes from the configured thresholds.
 */
const CONFIDENCE_PILL: Readonly<Record<CandidateData['confidenceLevel'], string>> = {
  high: 'bsp-pill bsp-p-ok',
  medium: 'bsp-pill bsp-p-warn',
  low: 'bsp-pill bsp-p-bad',
};

export function ReviewInbox({
  ref,
  locale,
  candidates,
  focusArea,
  focusCandidateId,
  canReview,
  canEdit,
  onEditFact,
  onClose,
}: {
  ref?: Ref<HTMLElement>;
  locale: string;
  candidates: readonly CandidateData[];
  /** Set from an area: jump to that area's first candidate. */
  focusArea: string | null;
  /** `?candidate=` — open on that candidate (a link from elsewhere). */
  focusCandidateId: string | null;
  canReview: boolean;
  canEdit: boolean;
  onEditFact: (area: string) => void;
  onClose: () => void;
}) {
  const t = translator(useMessageLocale(locale));
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      candidates.findIndex((candidate) => candidate.id === focusCandidateId),
    ),
  );
  const [editing, setEditing] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!focusArea) return;
    const found = candidates.findIndex((candidate) => candidate.area === focusArea);
    if (found >= 0) setIndex(found);
  }, [focusArea, candidates]);

  const count = candidates.length;
  const current = count > 0 ? candidates[index % count] : undefined;

  return (
    <section
      className="bsp-card bsp-bb-rv"
      data-testid="intel-card"
      ref={ref}
      aria-labelledby={titleId}
    >
      <div className="bsp-bb-rv-head">
        <b id={titleId}>{t('bb.rvTitle')}</b>
        {count > 0 ? (
          <span className="bsp-pill bsp-p-ai" data-testid="review-left">
            {count === 1 ? t('bb.rvLeftOne') : t('bb.rvLeft').replace('{count}', String(count))}
          </span>
        ) : null}
        <button
          type="button"
          className="bsp-btn bsp-sm bsp-ghost"
          data-testid="review-close"
          onClick={onClose}
        >
          {t('bb.rvClose')}
        </button>
      </div>

      {!canReview ? (
        <p className="bsp-bb-rv-note">
          {count > 0 ? t('bb.inboxForReviewers') : t('bb.intelNone')}
        </p>
      ) : !current ? (
        /* `x.rv.done` — line 801. */
        <div className="bsp-bb-rv-done" data-testid="review-inbox-empty">
          <b>✓ {t('bb.rvDone')}</b>
          <span>{t('bb.rvDoneSub')}</span>
          <button type="button" className="bsp-btn bsp-sm bsp-sec" onClick={onClose}>
            {t('bb.rvBack')}
          </button>
        </div>
      ) : (
        <div
          className="bsp-bb-rv-body"
          key={current.id}
          data-testid={`intel-${current.id}`}
          aria-live="polite"
        >
          <div className="bsp-bb-rv-meta">
            <span className="bsp-bb-rv-k">{t('bb.rvArea')}</span>
            <span className="bsp-pill bsp-p-neu">{current.areaLabel}</span>
            {current.source === 'MEMBER' ? (
              // D7 — a person's own words carry no confidence; who sent it does.
              <span className="bsp-bb-rv-k" data-testid={`intel-proposed-by-${current.id}`}>
                {current.proposedBy}
              </span>
            ) : (
              <span
                className={CONFIDENCE_PILL[current.confidenceLevel]}
                title={t('bb.confWhy')}
                data-testid={`intel-confidence-${current.id}`}
              >
                {current.confidenceLabel} ·{' '}
                <span className="bsp-ltr">{current.confidencePercent}%</span> —{' '}
                {current.confidenceWhy}
              </span>
            )}
            <span className="bsp-bb-rv-k">
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
            </span>
          </div>

          {editing ? (
            <form
              id={`${titleId}-edit`}
              action={reviewCandidateAction}
              className="bsp-bb-rv-edit"
              data-testid={`edit-${current.id}`}
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="area" value={current.area} />
              <input type="hidden" name="candidateId" value={current.id} />
              <input type="hidden" name="decision" value="accept_edited" />
              <input
                className="bs-control bsp-bb-in bsp-bb-in-big"
                name="titleEn"
                defaultValue={current.edit.titleEn}
                aria-label={t('bb.reviewEditTitleEn')}
                dir="ltr"
              />
              <input
                className="bs-control bsp-bb-in bsp-bb-in-big"
                name="titleAr"
                defaultValue={current.edit.titleAr}
                aria-label={t('bb.reviewEditTitleAr')}
                dir="rtl"
              />
              <textarea
                className="bs-control bsp-bb-in"
                name="bodyEn"
                rows={3}
                defaultValue={current.edit.bodyEn}
                aria-label={t('bb.reviewEditBodyEn')}
                dir="ltr"
              />
              <textarea
                className="bs-control bsp-bb-in"
                name="bodyAr"
                rows={3}
                defaultValue={current.edit.bodyAr}
                aria-label={t('bb.reviewEditBodyAr')}
                dir="rtl"
              />
            </form>
          ) : current.replaced ? (
            /*
             * D4 — OLD AND NEW SIDE BY SIDE (`x.rv.conflict`, line 797).
             * Accepting makes the proposal the approved fact; the old one is
             * kept in the history, never deleted.
             */
            <>
              <span className="bsp-bb-rv-text" dir="auto">
                {current.title || current.itemKey}
              </span>
              <div className="bsp-bb-rv-cmp" data-testid={`inbox-compare-${current.id}`}>
                <div data-testid={`inbox-current-${current.id}`}>
                  <span className="bsp-lbl">{t('bb.rvOld')}</span>
                  <span dir="auto">{current.replaced.body || current.replaced.title}</span>
                </div>
                <div className="bsp-bb-rv-new" data-testid={`inbox-proposed-${current.id}`}>
                  <span className="bsp-lbl">{t('bb.rvNew')}</span>
                  <span dir="auto">{current.body}</span>
                </div>
              </div>
            </>
          ) : (
            <>
              <span className="bsp-bb-rv-text" dir="auto">
                {current.title || current.itemKey}
              </span>
              {current.body && current.body !== current.title ? (
                <span className="bsp-bb-rv-sub" dir="auto">
                  {current.body}
                </span>
              ) : null}
            </>
          )}

          {current.snippet ? (
            <div className="bsp-bb-rv-said" data-testid={`inbox-snippet-${current.id}`}>
              <span className="bsp-lbl">{t('bb.rvSaid')}</span>
              <span dir="auto">“{current.snippet}”</span>
            </div>
          ) : null}
          {current.measured ? (
            <span className="bsp-bb-rv-k" data-testid={`intel-evidence-${current.id}`}>
              {current.measured}
            </span>
          ) : null}
          {current.source === 'ANALYTICS' ? (
            <span className="bsp-bb-rv-k">{t('bb.learningAcceptNote')}</span>
          ) : null}
          {current.conflict ? (
            <span
              role="note"
              className="bsp-bb-rv-warn"
              data-testid={`candidate-conflict-${current.id}`}
            >
              {current.conflict}
            </span>
          ) : null}
          {current.sourceHref ? (
            <a
              href={current.sourceHref}
              className="bsp-bb-rv-link"
              data-testid={`candidate-insight-${current.id}`}
            >
              {t('bb.reviewOpenFinding')}
            </a>
          ) : null}

          {editing ? (
            <div className="bsp-bb-rv-acts">
              <button
                type="submit"
                form={`${titleId}-edit`}
                className="bsp-btn bsp-pur"
                data-testid={`accept-edited-${current.id}`}
              >
                {t('bb.reviewAcceptEdited')}
              </button>
              <button type="button" className="bsp-btn bsp-ghost" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <div className="bsp-bb-rv-acts">
              {current.acceptAllowed ? (
                <form action={reviewCandidateAction}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="area" value={current.area} />
                  <input type="hidden" name="candidateId" value={current.id} />
                  <input type="hidden" name="decision" value="accept" />
                  <button
                    type="submit"
                    className="bsp-btn bsp-pur"
                    data-testid={`accept-${current.id}`}
                  >
                    {t('bb.reviewAccept')}
                  </button>
                </form>
              ) : null}
              {current.acceptAllowed ? (
                <button
                  type="button"
                  className="bsp-btn bsp-sec"
                  data-testid={`edit-open-${current.id}`}
                  onClick={() => setEditing(true)}
                >
                  {t('bb.reviewEdit')}
                </button>
              ) : null}
              <form action={reviewCandidateAction}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="area" value={current.area} />
                <input type="hidden" name="candidateId" value={current.id} />
                <input type="hidden" name="decision" value="reject" />
                <button
                  type="submit"
                  className="bsp-btn bsp-sec bsp-bb-rv-reject"
                  data-testid={`reject-${current.id}`}
                >
                  {t('bb.reviewReject')}
                </button>
              </form>
              {!current.acceptAllowed && current.replaced && canEdit ? (
                <button
                  type="button"
                  className="bsp-btn bsp-sec"
                  data-testid={`edit-fact-${current.id}`}
                  onClick={() => onEditFact(current.replaced!.area)}
                >
                  {t('bb.inboxEditFact')}
                </button>
              ) : null}
              {count > 1 ? (
                <button
                  type="button"
                  className="bsp-btn bsp-ghost"
                  data-testid={`later-${current.id}`}
                  onClick={() => setIndex((value) => (value + 1) % count)}
                >
                  {t('bb.inboxLater')}
                </button>
              ) : null}
            </div>
          )}

          {!current.acceptAllowed ? (
            <span className="bsp-bb-rv-k" data-testid={`inbox-precedence-${current.id}`}>
              {t('bb.inboxPrecedence')}
            </span>
          ) : null}
          <span className="bsp-bb-rv-foot">{t('bb.confWhy')}</span>
        </div>
      )}
    </section>
  );
}
