'use client';

import { useId, useState } from 'react';
import { Button, Dialog } from '@brandspace/ui';
import { translator } from '../../../i18n/messages';
import { readAgainSourceAction, removeSourceAction } from './actions';
import { useMessageLocale } from '../../../i18n/message-locale-context';

/**
 * ONE SOURCE, WITH WHAT IT IS RESPONSIBLE FOR (Phase 2C-4, D5).
 *
 * THE ROW IS THE DEMO'S. `.bb-doc` — badge, name over detail, status — is
 * transcribed unchanged, so the Sources card still reads as the approved demo.
 * Below it, an APPROVED DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2, recorded in
 * docs/UI-FIDELITY-CONTRACT.md §6): a meta line (type, size, date, counts) and
 * the three actions the demo describes but never drew — the facts list, Read
 * again and Remove — built from the card's own type scale and the shared
 * `Dialog`. No new colour, radius, shadow or font.
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
  const removeFormId = useId();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [mode, setMode] = useState<'keep' | 'drop'>('keep');
  const failed = source.status === 'FAILED';
  const count = (key: 'bb.source.approvedCount' | 'bb.source.pendingCount', n: number) =>
    t(key).replace('{n}', new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en').format(n));

  return (
    <li className="bb-doc-item" data-testid={`source-${source.id}`} data-status={source.status}>
      <div className="bb-doc">
        <i aria-hidden="true">{source.kind}</i>
        <span>
          <b>{source.fileName}</b>
          <small data-testid={`source-detail-${source.id}`}>{source.detail}</small>
        </span>
        <span className={failed ? 'failed' : undefined} data-testid={`source-status-${source.id}`}>
          {source.statusLabel}
        </span>
      </div>

      <div className="bb-doc-meta">
        <small data-testid={`source-meta-${source.id}`}>
          {source.meta} · {count('bb.source.approvedCount', source.approvedCount)} ·{' '}
          {count('bb.source.pendingCount', source.pendingCount)}
        </small>
        <span className="bb-doc-actions">
          <button
            type="button"
            className="bb-doc-action"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((value) => !value)}
            data-testid={`source-toggle-${source.id}`}
          >
            {open ? t('bb.source.hideDetails') : t('bb.source.showDetails')}
          </button>
          {canUpload && source.canReadAgain ? (
            <form action={readAgainSourceAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="documentId" value={source.id} />
              <button
                type="submit"
                className="bb-doc-action"
                data-testid={`source-read-again-${source.id}`}
              >
                {t('bb.source.readAgain')}
              </button>
            </form>
          ) : null}
          {canUpload && source.reading ? (
            <small role="status" data-testid={`source-reading-${source.id}`}>
              {t('bb.source.reading')}
            </small>
          ) : null}
          {canUpload ? (
            <button
              type="button"
              className="bb-doc-action"
              onClick={() => {
                setMode('keep');
                setRemoving(true);
              }}
              data-testid={`source-remove-${source.id}`}
            >
              {t('bb.source.remove')}
            </button>
          ) : null}
        </span>
      </div>

      {open ? (
        <div className="bb-doc-detail" id={detailId} data-testid={`source-facts-${source.id}`}>
          <h5>{t('bb.source.factsTitle')}</h5>
          {source.facts.length === 0 ? (
            <p>{t('bb.source.noFacts')}</p>
          ) : (
            <ul>
              {source.facts.map((fact) => (
                <li key={fact.id} data-testid={`source-fact-${fact.id}`}>
                  <b dir="auto">{fact.title}</b>
                  <small>
                    {fact.areaLabel} · {fact.stateLabel}
                  </small>
                </li>
              ))}
            </ul>
          )}
          <h5>{t('bb.source.pendingTitle')}</h5>
          {source.pending.length === 0 ? (
            <p>{t('bb.source.noPending')}</p>
          ) : (
            <ul>
              {source.pending.map((candidate) => (
                <li key={candidate.id} data-testid={`source-pending-${candidate.id}`}>
                  <b dir="auto">{candidate.title}</b>
                  <small>
                    {candidate.areaLabel} · {candidate.stateLabel}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        title={t('bb.source.removeTitle').replace('{name}', source.fileName)}
        description={t('bb.source.removeBody')}
        closeLabel={t('bb.detailClose')}
        testId={`source-remove-dialog-${source.id}`}
        footer={
          <>
            <Button variant="neutral" onClick={() => setRemoving(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="brand"
              type="submit"
              form={removeFormId}
              data-testid={`source-remove-confirm-${source.id}`}
            >
              {t('bb.source.removeConfirm')}
            </Button>
          </>
        }
      >
        <form id={removeFormId} action={removeSourceAction} className="bb-remove-choice">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="documentId" value={source.id} />
          <fieldset>
            <legend>{t('bb.source.removeChoose')}</legend>
            <label>
              <input
                type="radio"
                name="mode"
                value="keep"
                checked={mode === 'keep'}
                onChange={() => setMode('keep')}
                data-testid={`source-remove-keep-${source.id}`}
              />
              <span>
                <b>{t('bb.source.keep')}</b>
                <small>{t('bb.source.keepHint')}</small>
              </span>
            </label>
            {canDrop ? (
              <label>
                <input
                  type="radio"
                  name="mode"
                  value="drop"
                  checked={mode === 'drop'}
                  onChange={() => setMode('drop')}
                  data-testid={`source-remove-drop-${source.id}`}
                />
                <span>
                  <b>{t('bb.source.drop')}</b>
                  <small>
                    {t('bb.source.dropHint').replace(
                      '{n}',
                      new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en').format(
                        source.approvedCount,
                      ),
                    )}
                  </small>
                </span>
              </label>
            ) : null}
          </fieldset>
        </form>
      </Dialog>
    </li>
  );
}
