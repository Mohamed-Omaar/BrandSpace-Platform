'use client';

import { MENTION_OPEN_EVENT } from './mention-match';

/**
 * PR D (Notes 1) — "@ Mention" (`Main.dc.html` line 969): opens the people
 * list of the note field named by `fieldId`, as typing "@" there does.
 */
export function MentionButton({
  fieldId,
  label,
  testId,
}: {
  readonly fieldId: string;
  readonly label: string;
  readonly testId: string;
}) {
  return (
    <button
      type="button"
      className="bsp-btn bsp-sm bsp-sec"
      data-testid={testId}
      onClick={() =>
        window.dispatchEvent(new CustomEvent(MENTION_OPEN_EVENT, { detail: { id: fieldId } }))
      }
    >
      <span aria-hidden="true">@</span> {label}
    </button>
  );
}
