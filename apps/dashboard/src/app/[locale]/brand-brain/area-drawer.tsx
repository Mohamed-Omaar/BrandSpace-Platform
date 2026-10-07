'use client';

import { useEffect, useRef, useState } from 'react';
import type { UploadRules } from '../../../components/upload-rules';
import {
  UploadFileInput,
  UploadForm,
  UploadRulesLine,
  UploadStatus,
  uploadTexts,
} from '../../../components/upload-field';
import { visuallyHiddenStyle } from '@brandspace/ui';
import { translator } from '../../../i18n/messages';
import type { AreaCardData, BrandBrainPermissions, CandidateData } from './brand-brain-view';
import {
  archiveKnowledgeAction,
  createKnowledgeAction,
  updateKnowledgeAction,
  uploadSourceAction,
} from './actions';
import { useMessageLocale } from '../../../i18n/message-locale-context';

/** Q19 — the key question a person chose to answer: its fact key and its words. */
export interface QuestionFocus {
  readonly itemKey: string;
  readonly prompt: string;
}

/**
 * ONE KNOWLEDGE AREA, IN PLACE OF THE GRID — the prototype's inline area view
 * (`Main.dc.html` lines 817–866, D-468). It was a drawer over the page; the
 * prototype opens an area where the cards were, with "← All areas" above it.
 *
 *   - The head card: the area's name and state, what it holds, its KEY
 *     QUESTIONS (Q19) as chips — an unanswered one chosen puts its key and its
 *     words in the add form — and "Open chat" about this area.
 *   - APPROVED FACTS: each with its origin, version, layer and authority
 *     position, "valid until" or Expired (D6), where it came from, how many
 *     posts used it, and Edit (a new version, with its end date) and Archive.
 *     Then the add form: with review rights a fact is approved now; with edit
 *     alone it is SENT FOR REVIEW (D7). Then an upload into this area.
 *   - WAITING FOR YOUR REVIEW: this area's candidates, each opening the one
 *     review card (D4) — there is still one queue.
 *
 * Focus moves to "← All areas" when the area opens, and back to the page when
 * it closes, so a keyboard user is never stranded. EVERY CONTROL IS REAL OR
 * ABSENT: each block is gated on its own permission.
 */
export function AreaDrawer({
  locale,
  brandId,
  area,
  candidates,
  focus,
  permissions,
  sourceRules = null,
  onClose,
  onAskAbout,
  onReview,
}: {
  /** Batch 7 (A3): what a source may be, from activated configuration. */
  sourceRules?: UploadRules | null;
  locale: string;
  brandId: string;
  area: AreaCardData;
  /** This area's pending candidates, oldest first. */
  candidates: readonly CandidateData[];
  /** Set from "What's missing": the question to answer in the add form. */
  focus: QuestionFocus | null;
  permissions: BrandBrainPermissions;
  onClose: () => void;
  onAskAbout: (area: string) => void;
  /** D4 — open the one review card at this area's first candidate. */
  onReview: (area: string) => void;
}) {
  const t = translator(useMessageLocale(locale));
  // The question being answered: from "What's missing", or chosen here.
  const [chosen, setChosen] = useState<QuestionFocus | null>(focus);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => setChosen(focus), [focus, area.area]);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const addRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
    backRef.current?.scrollIntoView({ block: 'nearest' });
  }, [area.area]);

  const choose = (question: QuestionFocus) => {
    setChosen(question);
    window.requestAnimationFrame(() => {
      addRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      addRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    });
  };

  return (
    <div className="bsp-bb-area" data-testid="area-drawer" role="region" aria-label={area.label}>
      <button
        ref={backRef}
        type="button"
        className="bsp-btn bsp-sm bsp-ghost bsp-bb-back"
        data-testid="drawer-close"
        onClick={onClose}
      >
        ← {t('bb.allAreas')}
      </button>

      <section className="bsp-card bsp-bb-ahead">
        <span className="bsp-bb-ahead-t">
          <span className="bsp-bb-ahead-n">
            <h2>{area.label}</h2>
            <span className={`bsp-pill ${AREA_PILL[area.status]}`} data-testid="drawer-status">
              {area.statusLabel}
            </span>
            {area.pendingCandidates > 0 ? (
              <span className="bsp-pill bsp-p-ai" data-testid="drawer-pending">
                {area.pendingCandidates} {t('bb.pendingCount')}
              </span>
            ) : null}
          </span>
          <span className="bsp-bb-ahead-d">{area.description}</span>
          {area.questions.length > 0 ? (
            <span className="bsp-bb-ahead-q" data-testid="drawer-questions">
              <span className="bsp-bb-ahead-k">
                {t('bb.questionsAnswered')}:{' '}
                <span data-testid="drawer-count">
                  {t('bb.answeredOf')
                    .replace('{answered}', String(area.answered))
                    .replace('{total}', String(area.total))}
                </span>
              </span>
              {area.questions.map((question) =>
                question.answered || !permissions.edit ? (
                  <span
                    key={question.itemKey}
                    className="bsp-chip bsp-bb-q"
                    data-testid={`drawer-question-${question.itemKey}`}
                    data-answered={question.answered ? 'true' : 'false'}
                  >
                    <span className="bsp-bb-q-m" aria-hidden="true">
                      {question.answered ? '✓' : '○'}
                    </span>{' '}
                    {question.prompt}
                    <span style={visuallyHiddenStyle()}>
                      {' '}
                      {question.answered ? t('bb.questionAnswered') : t('bb.questionOpen')}
                    </span>
                  </span>
                ) : (
                  <span
                    key={question.itemKey}
                    data-testid={`drawer-question-${question.itemKey}`}
                    data-answered="false"
                    className="bsp-bb-q-w"
                  >
                    <button
                      type="button"
                      className="bsp-chip bsp-bb-q"
                      aria-pressed={chosen?.itemKey === question.itemKey}
                      data-testid={`drawer-answer-${question.itemKey}`}
                      onClick={() => choose({ itemKey: question.itemKey, prompt: question.prompt })}
                    >
                      <span className="bsp-bb-q-m" aria-hidden="true">
                        ○
                      </span>{' '}
                      {question.prompt}
                    </button>
                  </span>
                ),
              )}
            </span>
          ) : null}
          {area.attention.length > 0 ? (
            <span className="bsp-bb-ahead-att" data-testid="drawer-attention">
              {area.attention.join(' · ')}
            </span>
          ) : null}
        </span>
        {permissions.chat ? (
          <button
            type="button"
            className="bsp-btn bsp-sm bsp-pur"
            data-testid="drawer-ask"
            onClick={() => onAskAbout(area.area)}
          >
            {t('bb.chatOpen')}
          </button>
        ) : null}
      </section>

      <div className="bsp-bb-acols">
        {/* --- Approved facts ------------------------------------------------ */}
        <section className="bsp-card bsp-bb-facts">
          <h3 className="bsp-bb-colh">
            {t('bb.approvedFacts')}{' '}
            <span className="bsp-ltr bsp-bb-colh-n">{area.items.length}</span>
          </h3>
          {area.items.length === 0 ? (
            <div className="bsp-row bsp-bb-empty" data-testid="drawer-empty">
              {t('bb.detailEmpty')}
            </div>
          ) : (
            area.items.map((item) => (
              <article
                key={item.id}
                className="bsp-bb-fact"
                data-expired={item.expired ? 'true' : undefined}
                data-testid={`knowledge-item-${item.id}`}
              >
                <div className="bsp-bb-fact-row">
                  <span className="bsp-bb-fact-main">
                    <b dir="auto">{item.title || item.itemKey}</b>
                    <span dir="auto" className="bsp-bb-fact-body">
                      {item.body}
                    </span>
                    <span className="bsp-bb-fact-meta">
                      {item.originLabel} ·{' '}
                      <span className="bsp-ltr">
                        {t('bb.version')} {item.version}
                      </span>{' '}
                      ·{' '}
                      <span data-testid={`bb-used-in-${item.id}`}>
                        {item.usedInPosts === 1
                          ? t('bb.usedInOnePost')
                          : t('bb.usedInPosts').replace('{count}', String(item.usedInPosts))}
                      </span>{' '}
                      ·{' '}
                      {/*
                        THE LAYER AND ITS AUTHORITY POSITION, together. "Strategy"
                        alone says where the fact lives; "2 of 4" says what that
                        means when two facts disagree.
                      */}
                      <span
                        title={t('bb.memory.authorityHint')}
                        data-testid={`bb-memory-${item.id}`}
                      >
                        {item.memoryLabel} ({item.memoryRank}/{item.memoryDepth})
                      </span>
                      {item.stale ? ` · ${t('bb.attention.stale_items')}` : ''}
                      {/*
                        D6 — THE END DATE, AND WHAT IT MEANS NOW. Expired is not
                        stale: a stale fact is still used in writing; an expired
                        one never is.
                      */}
                      {item.expired ? (
                        <span className="bsp-pill bsp-p-bad" data-testid={`bb-expired-${item.id}`}>
                          {t('bb.expired')}
                        </span>
                      ) : item.validUntil ? (
                        <span
                          className="bsp-pill bsp-p-info"
                          data-testid={`bb-valid-until-${item.id}`}
                        >
                          {t('bb.validUntilShown').replace('{date}', item.validUntil)}
                        </span>
                      ) : null}
                    </span>
                    {item.provenance ? (
                      <span className="bsp-bb-fact-meta" data-testid={`bb-provenance-${item.id}`}>
                        {item.provenance}
                      </span>
                    ) : null}
                  </span>
                  {editing === item.id ? null : (
                    <span className="bsp-bb-fact-acts">
                      {permissions.edit ? (
                        <button
                          type="button"
                          className="bsp-btn bsp-sm bsp-ghost"
                          data-testid={`edit-item-${item.id}`}
                          onClick={() => setEditing(item.id)}
                        >
                          {t('bb.editFact')}
                        </button>
                      ) : null}
                      {permissions.remove ? (
                        <form action={archiveKnowledgeAction}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="area" value={area.area} />
                          <input type="hidden" name="itemId" value={item.id} />
                          <button
                            type="submit"
                            className="bsp-btn bsp-sm bsp-ghost"
                            data-testid={`archive-${item.id}`}
                          >
                            {t('bb.archive')}
                          </button>
                        </form>
                      ) : null}
                    </span>
                  )}
                </div>
                {permissions.edit && editing === item.id ? (
                  /*
                   * EDIT — a new version through the ordinary update path, with
                   * the fact's end date beside its words (D6): the prototype's
                   * edit box (line 832).
                   */
                  <form
                    action={updateKnowledgeAction}
                    className="bsp-bb-editbox"
                    data-testid={`edit-item-form-${item.id}`}
                  >
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="area" value={area.area} />
                    <input type="hidden" name="itemId" value={item.id} />
                    <input
                      className="bs-control bsp-bb-in"
                      name="titleEn"
                      defaultValue={item.edit.titleEn}
                      aria-label={t('bb.newItem.titleEn')}
                      dir="ltr"
                    />
                    <input
                      className="bs-control bsp-bb-in"
                      name="titleAr"
                      defaultValue={item.edit.titleAr}
                      aria-label={t('bb.newItem.titleAr')}
                      dir="rtl"
                    />
                    <textarea
                      className="bs-control bsp-bb-in"
                      name="bodyEn"
                      rows={3}
                      defaultValue={item.edit.bodyEn}
                      aria-label={t('bb.newItem.bodyEn')}
                      dir="ltr"
                    />
                    <textarea
                      className="bs-control bsp-bb-in"
                      name="bodyAr"
                      rows={3}
                      defaultValue={item.edit.bodyAr}
                      aria-label={t('bb.newItem.bodyAr')}
                      dir="rtl"
                    />
                    <ValidUntilField
                      id={`valid-until-${item.id}`}
                      label={t('bb.validUntil')}
                      hint={t('bb.validUntilHint')}
                      defaultValue={item.validUntil ?? ''}
                      testId={`valid-until-${item.id}`}
                    />
                    <span className="bsp-bb-editbox-acts">
                      <button
                        type="submit"
                        className="bsp-btn bsp-sm bsp-pur"
                        data-testid={`save-item-${item.id}`}
                      >
                        {t('common.save')}
                      </button>
                      <button
                        type="button"
                        className="bsp-btn bsp-sm bsp-ghost"
                        onClick={() => setEditing(null)}
                      >
                        {t('common.cancel')}
                      </button>
                    </span>
                  </form>
                ) : null}
              </article>
            ))
          )}

          {/* --- Add knowledge: the prototype's add row (line 854) ------------ */}
          {permissions.edit ? (
            <form
              ref={addRef}
              action={createKnowledgeAction}
              className="bsp-bb-add"
              data-testid="add-knowledge-form"
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="brandId" value={brandId} />
              <input type="hidden" name="area" value={area.area} />
              {chosen ? (
                <b className="bsp-bb-add-q" data-testid="new-item-question">
                  {chosen.prompt}
                </b>
              ) : null}
              <textarea
                className="bs-control bsp-bb-in"
                name="bodyEn"
                rows={2}
                // Q19 — the question itself is the placeholder (D3).
                placeholder={chosen?.prompt ?? t('bb.newItem.bodyEn')}
                aria-label={t('bb.newItem.bodyEn')}
                data-testid="new-item-body-en"
              />
              <textarea
                className="bs-control bsp-bb-in"
                name="bodyAr"
                rows={2}
                placeholder={chosen?.prompt ?? t('bb.newItem.bodyAr')}
                aria-label={t('bb.newItem.bodyAr')}
              />
              <span className="bsp-bb-add-grid">
                <input
                  // Q19 — a chosen question sets the key of the fact that answers it.
                  key={chosen?.itemKey ?? 'free'}
                  className="bs-control bsp-bb-in"
                  name="itemKey"
                  required
                  defaultValue={chosen?.itemKey ?? ''}
                  placeholder="identity.positioning"
                  aria-label={t('bb.newItem.key')}
                  data-testid="new-item-key"
                  dir="ltr"
                />
                <input
                  className="bs-control bsp-bb-in"
                  name="titleEn"
                  placeholder={t('bb.newItem.titleEn')}
                  aria-label={t('bb.newItem.titleEn')}
                  data-testid="new-item-title-en"
                />
                <input
                  className="bs-control bsp-bb-in"
                  name="titleAr"
                  placeholder={t('bb.newItem.titleAr')}
                  aria-label={t('bb.newItem.titleAr')}
                />
              </span>
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
                <small className="bsp-bb-add-note" data-testid="new-item-review-note">
                  {t('bb.sendForReviewNote')}
                </small>
              )}
              <button type="submit" className="bsp-btn bsp-sm" data-testid="save-knowledge">
                {permissions.review ? t('bb.addApprove') : t('bb.sendForReview')}
              </button>
            </form>
          ) : null}

          {/* --- Upload into this area ---------------------------------------- */}
          {permissions.upload && sourceRules ? (
            <UploadForm
              action={uploadSourceAction}
              rules={sourceRules}
              locale={locale}
              texts={uploadTexts(t)}
              className="bsp-bb-aup"
              data-testid="drawer-upload-form"
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="brandId" value={brandId} />
              <input type="hidden" name="area" value={area.area} />
              <UploadFileInput
                name="file"
                required
                className="bs-control bsp-bb-aup-in"
                aria-label={t('bb.uploadChoose')}
                data-testid="drawer-upload-input"
              />
              <button
                type="submit"
                className="bsp-btn bsp-sm bsp-sec"
                data-testid="drawer-upload-submit"
              >
                {t('bb.upload')}
              </button>
              <UploadRulesLine className="bsp-bb-uphint" />
              <UploadStatus testId="drawer-upload-status" />
            </UploadForm>
          ) : null}
        </section>

        {/* --- Waiting for your review: the ONE review card (D4) ------------- */}
        <section className="bsp-card bsp-bb-wait" data-testid="drawer-review">
          <h3 className="bsp-bb-colh">
            {t('bb.waitingReview')}{' '}
            <span className="bsp-ltr bsp-bb-colh-p">{area.pendingCandidates}</span>
          </h3>
          {candidates.length > 0 ? (
            candidates.map((candidate) => (
              <div key={candidate.id} className="bsp-bb-wait-row">
                <span dir="auto">{candidate.title || candidate.itemKey}</span>
                <span className="bsp-bb-fact-meta">
                  {candidate.source === 'ANALYTICS'
                    ? t('bb.learningFromPerformance')
                    : candidate.source === 'MEMBER'
                      ? t('bb.learningFromMember')
                      : t('bb.learningFromDocument')}
                  {candidate.source === 'MEMBER' ? null : (
                    <>
                      {' · '}
                      <span className={CONFIDENCE_PILL[candidate.confidenceLevel]}>
                        {candidate.confidenceLabel} ·{' '}
                        <span className="bsp-ltr">{candidate.confidencePercent}%</span>
                      </span>
                    </>
                  )}
                </span>
              </div>
            ))
          ) : (
            <p className="bsp-bb-wait-none">
              {area.pendingCandidates > 0
                ? t('bb.drawerWaiting').replace('{count}', String(area.pendingCandidates))
                : t('bb.intelNone')}
            </p>
          )}
          {area.pendingCandidates > 0 && permissions.review ? (
            <button
              type="button"
              className="bsp-btn bsp-sm bsp-pur bsp-bb-wait-go"
              data-testid="drawer-open-inbox"
              onClick={() => onReview(area.area)}
            >
              {t('bb.intelReview')}
            </button>
          ) : null}
          <p className="bsp-bb-wait-foot">{t('bb.usedBy')}</p>
        </section>
      </div>
    </div>
  );
}

/** The prototype's pill per area state (`['pill p-neu', 'pill p-warn', 'pill p-ok']`). */
const AREA_PILL: Readonly<Record<AreaCardData['status'], string>> = {
  EMPTY: 'bsp-p-neu',
  IN_PROGRESS: 'bsp-p-warn',
  NEEDS_ATTENTION: 'bsp-p-warn',
  COMPLETE: 'bsp-p-ok',
};

/** The prototype's pill per configured confidence band. */
const CONFIDENCE_PILL: Readonly<Record<CandidateData['confidenceLevel'], string>> = {
  high: 'bsp-pill bsp-p-ok',
  medium: 'bsp-pill bsp-p-warn',
  low: 'bsp-pill bsp-p-bad',
};

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
    <span className="bsp-bb-until">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="date"
        name="validUntil"
        className="bs-control bsp-bb-in bsp-ltr"
        defaultValue={defaultValue}
        aria-describedby={`${id}-hint`}
        data-testid={testId}
      />
      <small id={`${id}-hint`}>{hint}</small>
    </span>
  );
}
