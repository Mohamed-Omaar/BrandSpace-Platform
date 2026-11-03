'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ProgressBar } from '@brandspace/ui';
import { sendWithProgress } from '../../../components/upload-field';
import { approveSourceFactsAction } from '../brand-brain/actions';

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
    }
  | { readonly kind: 'approved'; readonly accepted: number }
  | { readonly kind: 'failed'; readonly refused: boolean };

const STAGE_PERCENT: Readonly<Record<string, number>> = {
  QUEUED: 10,
  EXTRACTING: 35,
  CHUNKING: 55,
  EXTRACTING_FACTS: 80,
  COMPLETED: 100,
};

export function SourceCard({
  file,
  locale,
  brandId,
  canReview,
  labels,
  onDone,
}: {
  readonly file: File;
  readonly locale: string;
  readonly brandId: string;
  readonly canReview: boolean;
  readonly labels: SourceCardLabels;
  readonly onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ask' });
  const live = useRef(true);
  const askedWhole = useRef(false);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const detail = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`;

  const add = async () => {
    setPhase({ kind: 'uploading', percent: 0 });
    const form = new FormData();
    form.set('locale', locale);
    form.set('brandId', brandId);
    form.set('file', file);
    try {
      const outcome = await sendWithProgress('brand-source', form, (percent) => {
        if (live.current) setPhase({ kind: 'uploading', percent });
      });
      const location = typeof outcome['location'] === 'string' ? outcome['location'] : '';
      const params = new URL(location, window.location.origin).searchParams;
      const sourceId = params.get('source');
      if (!sourceId || params.get('error')) {
        setPhase({ kind: 'failed', refused: params.get('error') === 'SOURCE_REFUSED' });
        return;
      }
      setPhase({ kind: 'reading', sourceId, stage: 'QUEUED' });
    } catch {
      setPhase({ kind: 'failed', refused: false });
    }
  };

  // Follow the file while the worker reads it.
  const reading = phase.kind === 'reading' ? phase.sourceId : null;
  useEffect(() => {
    if (!reading) return;
    let stopped = false;
    const tick = async () => {
      const response = await fetch(`/api/brand-brain/source?id=${encodeURIComponent(reading)}`, {
        cache: 'no-store',
      }).catch(() => null);
      if (stopped || !response?.ok) return;
      const status = (await response.json()) as {
        status: string;
        stage: string | null;
        pages: number | null;
        found: number;
        skippedDuplicates: number;
        readBy: string;
      };
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
        });
      } else if (status.status === 'FAILED' || status.status === 'QUARANTINED') {
        setPhase({ kind: 'failed', refused: false });
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

  return (
    <section className="bsp-card bsp-bb-bulk" data-testid="copilot-source-card" aria-live="polite">
      {phase.kind === 'ask' ? (
        <>
          <b data-testid="copilot-source-ask">{labels.askTitle.replace('{file}', file.name)}</b>
          <span className="bsp-st-hint">{labels.askBody}</span>
          <span className="bsp-bb-bulk-acts">
            <button
              type="button"
              className="bsp-btn bsp-sm bsp-pur"
              data-testid="copilot-source-add"
              onClick={() => void add()}
            >
              {labels.add}
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
            label={labels.progressLabel.replace('{file}', file.name)}
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

      {phase.kind === 'failed' ? (
        <b data-testid="copilot-source-failed">{phase.refused ? labels.refused : labels.failed}</b>
      ) : null}
    </section>
  );
}
