'use client';

import { useState } from 'react';
import { ConfirmDialog } from '@brandspace/ui';
import { MoreDisclosure } from '../../../components/more-disclosure';

/**
 * PR B (D-591) — THE ONE CONVERSATION'S OWN CONTROLS: search inside it,
 * "New topic", and "Clear conversation" (behind ⋯, with a confirmation), plus
 * the line under the composer: what this message will cost and how long the
 * conversation is kept.
 *
 * An APPROVED DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): the prototype's Copilot
 * has no conversation history to search or clear. Composed only of the shared
 * classes the Studio already uses (`bsp-st-inline`, `bsp-chip`, `bs-control`,
 * `bsp-st-hint`), `MoreDisclosure` and the shared `ConfirmDialog`: no inline
 * style, no new class, no literal.
 */
export interface ConversationToolLabels {
  readonly search: string;
  readonly searchPlaceholder: string;
  readonly newTopic: string;
  readonly more: string;
  readonly clear: string;
  readonly clearTitle: string;
  readonly clearBody: string;
  readonly clearConfirm: string;
  readonly cancel: string;
  readonly close: string;
}

export function ConversationTools({
  labels,
  search,
  onSearch,
  onNewTopic,
  onClear,
  disabled,
  attach,
}: {
  readonly labels: ConversationToolLabels;
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly onNewTopic: () => void;
  readonly onClear: () => void;
  readonly disabled: boolean;
  /**
   * PR B — "+", the retired Brand Brain chat's attach: a file chosen here is
   * only held in the tab until its Add card is confirmed (`SourceCard`).
   */
  readonly attach?: { readonly label: string; readonly onFile: (file: File) => void };
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="bsp-st-inline" data-testid="copilot-conversation-tools">
      <input
        type="search"
        className="bs-control bsp-st-select"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        placeholder={labels.searchPlaceholder}
        aria-label={labels.search}
        maxLength={200}
        data-testid="copilot-search"
      />
      {attach ? (
        <label className="bsp-chip bsp-st-sm" data-testid="copilot-attach">
          + {attach.label}
          <input
            type="file"
            className="bs-control bsp-bb-file"
            aria-label={attach.label}
            data-testid="copilot-attach-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) attach.onFile(file);
              event.target.value = '';
            }}
          />
        </label>
      ) : null}
      <button
        type="button"
        className="bsp-chip bsp-st-sm"
        onClick={onNewTopic}
        disabled={disabled}
        data-testid="copilot-new-topic"
      >
        {labels.newTopic}
      </button>
      <MoreDisclosure label={labels.more} testId="copilot-more" align="end">
        <button
          type="button"
          className="bsp-chip bsp-st-sm"
          onClick={() => setConfirming(true)}
          disabled={disabled}
          data-testid="copilot-clear"
        >
          {labels.clear}
        </button>
      </MoreDisclosure>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onClear();
        }}
        title={labels.clearTitle}
        description={labels.clearBody}
        confirmLabel={labels.clearConfirm}
        cancelLabel={labels.cancel}
        closeLabel={labels.close}
        testId="copilot-clear-dialog"
      />
    </div>
  );
}

/** The line under the composer: this message's price, and the retention rule. */
export function ConversationFoot({
  price,
  retention,
}: {
  readonly price: string | null;
  readonly retention: string | null;
}) {
  if (!price && !retention) return null;
  return (
    <div className="bsp-st-inline" data-testid="copilot-foot">
      {price ? (
        <span className="bsp-st-hint" data-testid="copilot-message-price">
          {price}
        </span>
      ) : null}
      {retention ? (
        <span className="bsp-st-hint" data-testid="copilot-retention">
          {retention}
        </span>
      ) : null}
    </div>
  );
}
