/**
 * WHAT THE PERSON IS LOOKING AT (Phase 6 final, D-277 §37, D-280).
 *
 * A Copilot opened on a campaign, a post or an insight is told which one, so
 * "make this shorter" or "plan two more posts for this" has a referent. A
 * CLOSED SET of kinds: the kind is the only part that reaches the model's
 * unfenced instruction, and the object itself is admitted against the
 * session's brand by the orchestrator before the session exists.
 */
export const COPILOT_SUBJECT_TYPES = ['CAMPAIGN', 'CONTENT_ITEM', 'INSIGHT'] as const;
export type CopilotSubjectType = (typeof COPILOT_SUBJECT_TYPES)[number];

export interface CopilotSubject {
  readonly type: CopilotSubjectType;
  readonly id: string;
}

/** The noun the instruction uses for each kind — ours, never the caller's. */
export const SUBJECT_NOUN: Readonly<Record<CopilotSubjectType, string>> = {
  CAMPAIGN: 'CAMPAIGN',
  CONTENT_ITEM: 'CONTENT ITEM (a post)',
  INSIGHT: 'MARKETING INSIGHT',
};

/** A stored kind, narrowed back into the closed set. Anything else is none. */
export function copilotSubjectType(value: string | null | undefined): CopilotSubjectType | null {
  return (COPILOT_SUBJECT_TYPES as readonly string[]).includes(value ?? '')
    ? (value as CopilotSubjectType)
    : null;
}
