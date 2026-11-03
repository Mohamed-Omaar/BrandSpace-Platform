'use client';

import { useState } from 'react';
import { ConfirmDialog } from '@brandspace/ui';
import { MoreDisclosure } from '../../../components/more-disclosure';

/**
 * PR B (D-594) — THE ONE CONVERSATION'S OWN CONTROLS: search inside it,
 * "New topic", and "Clear conversation" (behind ⋯, with a confirmation), plus
 * the line under the composer: what this message will cost and how long the
 * conversation is kept.
 *
 * An APPROVED DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): the prototype's Copilot
 * has no conversation history to search or clear. One row on the page and in
 * the panel (`bs-cpt`: search, New topic, ⋯), built from the shared
 * `bs-control`, `bsp-chip`, `MoreDisclosure` and `ConfirmDialog`, with design
 * tokens only: no inline style, no literal.
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
}: {
  readonly labels: ConversationToolLabels;
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly onNewTopic: () => void;
  readonly onClear: () => void;
  readonly disabled: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="bs-cpt" data-testid="copilot-conversation-tools">
      <input
        type="search"
        className="bs-control bs-cpt-search"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        placeholder={labels.searchPlaceholder}
        aria-label={labels.search}
        maxLength={200}
        data-testid="copilot-search"
      />
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
