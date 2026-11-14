'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ProgressBar } from '@brandspace/ui';
import { sendWithProgress } from '../../../components/upload-field';
import { approveSourceFactsAction, rejectSourceFactsAction } from '../brand-brain/actions';

/**
 * PR B (D-594) — A FILE GIVEN TO THE COPILOT IS A CARD FIRST.
 *
 *   1. "Add <file> to Brand Brain?" with Add / Not now. NOTHING is stored,
 *      fetched or read before Add: the file stays in this browser tab, and
 *      Not now forgets it.
 *   2. Add sends it through the ONE upload path Brand Brain's Sources use (the
 *      #112 relay → `uploadSourceAction`, its type, size, quota and
 *      duplicate rules), with the shared progress bar.
 *   3. The worker reads it (`brand.extract`, or today's extraction while that
 *      is not active — the card says which); the card follows the stages.
 *   4. "Read 6 pages, found 18 facts, skipped 3 because they are already in
 *      Brand Brain." The facts wait in Pending, then "Approve all, or review
 *      them?" — Approve all with the person's own review rights, Review on
 *      the Brand Brain page.
 *
 * An APPROVED DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): the prototype draws no
 * file card. Composed of the shared card, chip, button, hint classes and
 * `ProgressBar` (#112): no inline style, no new class, no literal.
 */
export interface SourceCardLabels {
  readonly askTitle: string;
  readonly askBody: string;
  readonly add: string;
  readonly notNow: string;
  readonly uploading: string;
  readonly stage: Readonly<Record<string, string>>;
  readonly progressLabel: string;
  readonly coverage: string;
  readonly coverageNoSkips: string;
  readonly coverageOne: string;
  readonly coverageNoSkipsOne: string;
  readonly todaysExtraction: string;
  readonly approveOrReview: string;
  readonly approveAll: string;
  readonly review: string;
  readonly approved: string;
  readonly failed: string;
  readonly refused: string;
  /**
   * PR U — WHY, in plain words: a stored reason key (`bb.failure.*`) in the
   * reader's language. `null` (the upload itself did not arrive) reads as
   * the general "on our side" reason.
   */
  readonly failureReason: (reason: string | null) => string;
  /** PR 2 (D-598) — the facts' list, Reject all, and an already-added file. */
  readonly rejectAll: string;
  readonly rejected: string;
  readonly alreadyAdded: string;
  readonly foundTitles: string;
  /** PR C — the website card: its question, its button, and how a refusal reads. */
  readonly websiteAsk: string;
  readonly websiteBody: string;
  readonly websiteRead: string;
  readonly websiteFailure: (code: string) => string;
}

type Phase =
  | { readonly kind: 'ask' }
  | { readonly kind: 'uploading'; readonly percent: number }
  | { readonly kind: 'reading'; readonly sourceId: string; readonly stage: string | null }
  | { readonly kind: 'whole'; readonly sourceId: string }
  | {
      readonly kind: 'done';
      readonly sourceId: string;
      readonly pages: number | null;
      readonly found: number;
      readonly skipped: number;
      readonly keyword: boolean;
      /** PR 2 — the waiting facts, by title (up to 10). */
      readonly titles: readonly string[];
    }
  | { readonly kind: 'rejected'; readonly rejected: number }
  | { readonly kind: 'already' }
  | { readonly kind: 'approved'; readonly accepted: number }
  | { readonly kind: 'failed'; readonly refused: boolean; readonly reason: string | null };

const STAGE_PERCENT: Readonly<Record<string, number>> = {
  QUEUED: 10,
  EXTRACTING: 35,
  CHUNKING: 55,
  EXTRACTING_FACTS: 80,
  COMPLETED: 100,
};

/** One source's reading state, as `/api/brand-brain/source` reports it. */
interface SourceStatus {
  readonly status: string;
  readonly stage: string | null;
  readonly pages: number | null;
  readonly found: number;
  readonly skippedDuplicates: number;
  readonly readBy: string;
  /** PR U — the stored reason key while FAILED or QUARANTINED, else null. */
  readonly failureReason?: string | null;
  /** PR 2 — the waiting facts' titles. */
  readonly pendingTitles?: readonly string[];
}

async function sourceStatus(id: string): Promise<SourceStatus | null> {
  const response = await fetch(`/api/brand-brain/source?id=${encodeURIComponent(id)}`, {
    cache: 'no-store',
  }).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json().catch(() => null)) as SourceStatus | null;
}

export function SourceCard({
  file = null,
  website = null,
  locale,
  brandId,
  canReview,
  labels,
  onAdded,
  onDone,
}: {
  /** A file the person attached — or, for the website card, null. */
  readonly file?: File | null;
  /**
   * PR C — the brand's own website, read into Brand Brain through Brand
   * Brain's own action (`readWebsiteAction`), after the person presses Read.
   */
  readonly website?: { readonly host: string | null } | null;
  readonly locale: string;
  readonly brandId: string;
  readonly canReview: boolean;
  readonly labels: SourceCardLabels;
  /** PR B — Add pressed: the file's reading is no longer a price to show. */
  readonly onAdded?: () => void;
  readonly onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' });
  const live = useRef(true);
  const askedWhole = useRef(false);
  // A card is a message: when it appears or moves to its next step, it is
  // brought into the conversation's view (only as far as needed).
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    card.current?.scrollIntoView?.({ block: 'nearest' });
  }, [phase.kind]);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const name = file ? file.name : (website?.host ?? '');
  const detail = file ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB` : name;

  const add = async () => {
    onAdded?.();
    setPhase({ kind: 'uploading', percent: 0 });
    const form = new FormData();
    form.set('locale', locale);
    form.set('brandId', brandId);
    if (file) form.set('file', file);
    try {
      const outcome = await sendWithProgress(
        file ? 'brand-source' : 'brand-website',
        form,
        (percent) => {
          if (live.current) setPhase({ kind: 'uploading', percent });
        },
      );
      const location = typeof outcome['location'] === 'string' ? outcome['location'] : '';
      const params = new URL(location, window.location.origin).searchParams;
      const sourceId = params.get('source');
      // PR C — the website was not read: say why, in the screen's own words.
      const websiteError = params.get('error');
      if (!file && websiteError?.startsWith('WEBSITE_')) {
        setPhase({ kind: 'failed', refused: true, reason: websiteError });
        return;
      }
      // PR 2 (D-598): a file already in Brand Brain is said so, not "failed".
      if (params.get('error') === 'CONFLICT') {
        setPhase({ kind: 'already' });
        return;
      }
      if (!sourceId || params.get('error')) {
        // A refused or already-failed row carries its reason: read it once.
        const reason = sourceId ? ((await sourceStatus(sourceId))?.failureReason ?? null) : null;
        if (live.current) {
          setPhase({ kind: 'failed', refused: params.get('error') === 'SOURCE_REFUSED', reason });
        }
        return;
      }
      setPhase({ kind: 'reading', sourceId, stage: 'QUEUED' });
    } catch {
      setPhase({ kind: 'failed', refused: false, reason: null });
    }
  };

  // Follow the file while the worker reads it.
  const reading = phase.kind === 'reading' ? phase.sourceId : null;
  useEffect(() => {
    if (!reading) return;
    let stopped = false;
    const tick = async () => {
      const status = await sourceStatus(reading);
      if (stopped || !status) return;
      if (status.status === 'READY' && status.readBy !== 'brand.extract' && !askedWhole.current) {
        // The worker has read it; now the whole-source reading, once.
        askedWhole.current = true;
        stopped = true;
        setPhase({ kind: 'whole', sourceId: reading });
        await fetch('/api/brand-brain/extract', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourceId: reading }),
        }).catch(() => null);
        if (live.current) setPhase({ kind: 'reading', sourceId: reading, stage: 'COMPLETED' });
        return;
      }
      if (status.status === 'READY') {
        setPhase({
          kind: 'done',
          sourceId: reading,
          pages: status.pages,
          found: status.found,
          skipped: status.skippedDuplicates,
          keyword: status.readBy !== 'brand.extract',
          titles: status.pendingTitles ?? [],
        });
      } else if (status.status === 'FAILED' || status.status === 'QUARANTINED') {
        setPhase({ kind: 'failed', refused: false, reason: status.failureReason ?? null });
      } else {
        setPhase({ kind: 'reading', sourceId: reading, stage: status.stage });
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [reading]);

  const approve = async (sourceId: string) => {
    const outcome = await approveSourceFactsAction({ locale, brandId, documentId: sourceId });
    if ('accepted' in outcome) setPhase({ kind: 'approved', accepted: outcome.accepted });
  };
  const reject = async (sourceId: string) => {
    const outcome = await rejectSourceFactsAction({ locale, brandId, documentId: sourceId });
    if ('rejected' in outcome) setPhase({ kind: 'rejected', rejected: outcome.rejected });
  };

  return (
    <section
      ref={card}
      className="bs-cpb-card"
      data-testid="copilot-source-card"
      dir="auto"
      aria-live="polite"
    >
      {phase.kind === 'ask' ? (
        <>
          <b data-testid="copilot-source-ask">
            {file
              ? labels.askTitle.replace('{file}', name)
              : labels.websiteAsk.replace('{site}', name)}
          </b>
          <span className="bsp-st-hint">{file ? labels.askBody : labels.websiteBody}</span>
          <span className="bsp-bb-bulk-acts">
            <button
              type="button"
              className="bsp-btn bsp-sm bsp-pur"
              data-testid="copilot-source-add"
              disabled={!file && !website?.host}
              onClick={() => void add()}
            >
              {file ? labels.add : labels.websiteRead}
            </button>
            <button
              type="button"
              className="bsp-btn bsp-sm bsp-ghost"
              data-testid="copilot-source-not-now"
              onClick={onDone}
            >
              {labels.notNow}
            </button>
          </span>
        </>
      ) : null}

      {phase.kind === 'uploading' || phase.kind === 'reading' || phase.kind === 'whole' ? (
        <>
          <b data-testid="copilot-source-status">
            {phase.kind === 'uploading'
              ? labels.uploading
              : phase.kind === 'whole'
                ? (labels.stage['WHOLE'] ?? labels.uploading)
                : (labels.stage[phase.stage ?? 'QUEUED'] ?? labels.uploading)}
          </b>
          <ProgressBar
            value={
              phase.kind === 'uploading'
                ? phase.percent
                : phase.kind === 'whole'
                  ? 90
                  : (STAGE_PERCENT[phase.stage ?? 'QUEUED'] ?? 10)
            }
            label={labels.progressLabel.replace('{file}', name)}
            testId="copilot-source-progress"
          />
          <span className="bsp-st-hint" data-testid="copilot-source-detail">
            {detail}
          </span>
        </>
      ) : null}

      {phase.kind === 'done' ? (
        <>
          <b data-testid="copilot-source-coverage">
            {((phase.pages ?? 1) === 1
              ? phase.skipped > 0
                ? labels.coverageOne
                : labels.coverageNoSkipsOne
              : phase.skipped > 0
                ? labels.coverage
                : labels.coverageNoSkips
            )
              .replace('{pages}', String(phase.pages ?? 1))
              .replace('{found}', String(phase.found))
              .replace('{skipped}', String(phase.skipped))}
          </b>
          {phase.keyword ? (
            <span className="bsp-st-hint" data-testid="copilot-source-todays">
              {labels.todaysExtraction}
            </span>
          ) : null}
          {phase.found > 0 && phase.titles.length > 0 ? (
            <>
              <span className="bsp-st-hint">{labels.foundTitles}</span>
              <ul data-testid="copilot-source-titles" dir="auto">
                {phase.titles.map((title, index) => (
                  <li key={`${index}-${title}`}>{title}</li>
                ))}
              </ul>
            </>
          ) : null}
          {phase.found > 0 ? (
            <>
              <span>{labels.approveOrReview}</span>
              <span className="bsp-bb-bulk-acts">
                {canReview ? (
                  <button
                    type="button"
                    className="bsp-btn bsp-sm bsp-pur"
                    data-testid="copilot-source-approve-all"
                    onClick={() => void approve(phase.sourceId)}
                  >
                    {labels.approveAll}
                  </button>
                ) : null}
                <Link
                  href={`/${locale}/brand-brain?brand=${brandId}`}
                  className="bsp-btn bsp-sm bsp-sec"
                  data-testid="copilot-source-review"
                >
                  {labels.review}
                </Link>
                {canReview ? (
                  <button
                    type="button"
                    className="bsp-btn bsp-sm bsp-sec"
                    data-testid="copilot-source-reject-all"
                    onClick={() => void reject(phase.sourceId)}
                  >
                    {labels.rejectAll}
                  </button>
                ) : null}
              </span>
            </>
          ) : null}
        </>
      ) : null}

      {phase.kind === 'approved' ? (
        <b data-testid="copilot-source-approved">
          {labels.approved.replace('{count}', String(phase.accepted))}
        </b>
      ) : null}

      {phase.kind === 'rejected' ? (
        <b data-testid="copilot-source-rejected">
          {labels.rejected.replace('{count}', String(phase.rejected))}
        </b>
      ) : null}

      {phase.kind === 'already' ? (
        <b data-testid="copilot-source-already">{labels.alreadyAdded}</b>
      ) : null}

      {phase.kind === 'failed' ? (
        <b data-testid="copilot-source-failed" dir="auto">
          {phase.reason?.startsWith('WEBSITE_')
            ? labels.websiteFailure(phase.reason)
            : phase.refused && !phase.reason
              ? labels.refused
              : `${labels.failureReason(phase.reason)} ${labels.failed}`}
        </b>
      ) : null}
    </section>
  );
}
