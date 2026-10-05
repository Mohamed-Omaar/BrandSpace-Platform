'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { translator } from '../../../i18n/messages';
import { readAgainSourceAction, removeSourceAction } from './actions';
import { useMessageLocale } from '../../../i18n/message-locale-context';

/**
 * ONE SOURCE, WITH WHAT IT IS RESPONSIBLE FOR (Phase 2C-4, D5) — the
 * prototype's source row (`Main.dc.html` lines 889–893, D-468).
 *
 * The type badge, the name over its meta (type, size, date; a failure's
 * reason under it), then the actions: "n facts · Show" (the facts and
 * candidates it is responsible for), Read again, and Remove — which opens the
 * prototype's inline confirmation: remove and keep its facts, or (with
 * `brand_brain.edit`) remove it and its facts, or Cancel. Removing is a
 * high-impact action and still takes that second, explicit press
 * (CLAUDE.md §2.5).
 *
 * NOTHING HERE DECIDES A PERMISSION. The page passes what the member holds and
 * the row simply leaves out a control they cannot use; the actions re-check
 * (`brand_brain.upload`, and `brand_brain.edit` for Drop) on the server.
 */

export interface SourceFactData {
  readonly id: string;
  readonly title: string;
  readonly areaLabel: string;
  readonly stateLabel: string;
}

export interface SourceRowData {
  readonly id: string;
  readonly fileName: string;
  readonly kind: string;
  readonly status: string;
  readonly statusLabel: string;
  /** Pages/chunks when read, or the FAILED reason in the reader's language. */
  readonly detail: string;
  /** "PDF · 1.2 MB · 29 Sep 2026" — type, stored size and upload date. */
  readonly meta: string;
  readonly approvedCount: number;
  readonly pendingCount: number;
  readonly facts: readonly SourceFactData[];
  readonly pending: readonly SourceFactData[];
  /** Stored bytes exist and no read is running: Read again can start one. */
  readonly canReadAgain: boolean;
  /** Queued or being read right now. */
  readonly reading: boolean;
}

export function SourceRow({
  locale,
  source,
  canUpload,
  canDrop,
}: {
  readonly locale: string;
  readonly source: SourceRowData;
  /** `brand_brain.upload` — Read again and Remove. */
  readonly canUpload: boolean;
  /** `brand_brain.upload` AND `brand_brain.edit` — "Drop its facts". */
  readonly canDrop: boolean;
}) {
  const t = translator(useMessageLocale(locale));
  const detailId = useId();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const removeRef = useRef<HTMLButtonElement | null>(null);
  const failed = source.status === 'FAILED';
  const number = new Intl.NumberFormat('en-US');
  const count = (key: 'bb.source.approvedCount' | 'bb.source.pendingCount', n: number) =>
    t(key).replace('{n}', number.format(n));

  // The confirmation takes focus when it opens, and gives it back when it closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (removing) keepRef.current?.focus();
    else if (wasOpen.current) removeRef.current?.focus();
    wasOpen.current = removing;
  }, [removing]);

  return (
    <li className="bsp-bb-srow" data-testid={`source-${source.id}`} data-status={source.status}>
      <div className="bsp-row bsp-bb-srow-main">
        <span className="bsp-bb-ext" aria-hidden="true">
          {source.kind}
        </span>
        <span className="bsp-bb-srow-t">
          <b className="bsp-ltr">{source.fileName}</b>
          <span data-testid={`source-meta-${source.id}`}>{source.meta}</span>
          {source.detail ? (
            <span data-testid={`source-detail-${source.id}`}>{source.detail}</span>
          ) : null}
        </span>
        {canUpload && source.reading ? (
          <span
            className="bsp-pill bsp-p-ai bs-pulse"
            role="status"
            data-testid={`source-reading-${source.id}`}
          >
            {t('bb.source.reading')}
          </span>
        ) : failed || source.status !== 'READY' ? (
          /* Gate 2b — the prototype pills only a read in progress or a failure. */
          <span
            className={failed ? 'bsp-pill bsp-p-bad' : 'bsp-pill bsp-p-neu'}
            data-testid={`source-status-${source.id}`}
          >
            {source.statusLabel}
          </span>
        ) : null}
        <button
          type="button"
          className="bsp-chip bsp-bb-srow-show"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((value) => !value)}
          data-testid={`source-toggle-${source.id}`}
        >
          {/* The prototype's chip: "6 approved · 1 to review · Facts". */}
          {count('bb.source.approvedCount', source.approvedCount)} ·{' '}
          {count('bb.source.pendingCount', source.pendingCount)} ·{' '}
          {open ? t('bb.source.hideDetails') : t('bb.source.showDetails')}
        </button>
        {canUpload && source.canReadAgain ? (
          <form action={readAgainSourceAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="documentId" value={source.id} />
            <button
              type="submit"
              className="bsp-btn bsp-sm bsp-ghost"
              data-testid={`source-read-again-${source.id}`}
            >
              {t('bb.source.readAgain')}
            </button>
          </form>
        ) : null}
        {canUpload ? (
          <button
            ref={removeRef}
            type="button"
            className="bsp-btn bsp-sm bsp-ghost bsp-bb-danger"
            aria-expanded={removing}
            onClick={() => setRemoving(true)}
            data-testid={`source-remove-${source.id}`}
          >
            {t('bb.source.remove')}
          </button>
        ) : null}
      </div>

      {removing ? (
        /* `r.rmOpen` — line 892: the question, Keep, Drop, Cancel. */
        <form
          action={removeSourceAction}
          className="bsp-bb-rm"
          role="group"
          aria-label={t('bb.source.removeTitle').replace('{name}', source.fileName)}
          data-testid={`source-remove-dialog-${source.id}`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setRemoving(false);
            }
          }}
        >
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="documentId" value={source.id} />
          <span className="bsp-bb-rm-q">
            <b>{t('bb.source.removeTitle').replace('{name}', source.fileName)}</b>
            <small>{t('bb.source.removeBody')}</small>
          </span>
          <button
            ref={keepRef}
            type="submit"
            name="mode"
            value="keep"
            className="bsp-btn bsp-sm bsp-sec"
            title={t('bb.source.keepHint')}
            data-testid={`source-remove-keep-${source.id}`}
          >
            {t('bb.source.keep')}
          </button>
          {canDrop ? (
            <button
              type="submit"
              name="mode"
              value="drop"
              className="bsp-btn bsp-sm bsp-bb-drop"
              title={t('bb.source.dropHint').replace('{n}', number.format(source.approvedCount))}
              data-testid={`source-remove-drop-${source.id}`}
            >
              {t('bb.source.drop')}
            </button>
          ) : null}
          <button
            type="button"
            className="bsp-btn bsp-sm bsp-ghost"
            onClick={() => setRemoving(false)}
            data-testid={`source-remove-cancel-${source.id}`}
          >
            {t('common.cancel')}
          </button>
        </form>
      ) : null}

      {open ? (
        /* `r.open` — line 893: each fact with its state and area. */
        <div className="bsp-bb-sfacts" id={detailId} data-testid={`source-facts-${source.id}`}>
          <b className="bsp-lbl">{t('bb.source.factsTitle')}</b>
          {source.facts.length === 0 ? (
            <span className="bsp-bb-sfacts-none">{t('bb.source.noFacts')}</span>
          ) : (
            source.facts.map((fact) => (
              <span key={fact.id} className="bsp-bb-sfact" data-testid={`source-fact-${fact.id}`}>
                <span className="bsp-pill bsp-p-ok">{fact.stateLabel}</span>
                <span dir="auto">{fact.title}</span>
                <span className="bsp-bb-sfact-a">{fact.areaLabel}</span>
              </span>
            ))
          )}
          <b className="bsp-lbl">{t('bb.source.pendingTitle')}</b>
          {source.pending.length === 0 ? (
            <span className="bsp-bb-sfacts-none">{t('bb.source.noPending')}</span>
          ) : (
            source.pending.map((candidate) => (
              <span
                key={candidate.id}
                className="bsp-bb-sfact"
                data-testid={`source-pending-${candidate.id}`}
              >
                <span className="bsp-pill bsp-p-ai">{candidate.stateLabel}</span>
                <span dir="auto">{candidate.title}</span>
                <span className="bsp-bb-sfact-a">{candidate.areaLabel}</span>
              </span>
            ))
          )}
        </div>
      ) : null}
    </li>
  );
}
