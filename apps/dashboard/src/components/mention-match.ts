/**
 * The pure half of the @-mention typeahead (D-277 §28): what is being typed,
 * and who it could mean. Not a client module, so the unit suite imports it.
 */
/** PR D (Notes 1) — the "@ Mention" button asks the field with this `id` to open its list. */
export const MENTION_OPEN_EVENT = 'brandspace:mention-open';

/**
 * PR D (Notes 4) — a note's body cut into plain runs and the mentions in it:
 * each `@Name` of a person the note mentions, longest names first so "@Sara
 * Ali" is not read as "@Sara". A renamed person's old "@Name" stays plain text.
 */
export function mentionRuns(
  body: string,
  names: readonly string[],
): readonly { readonly text: string; readonly mention: boolean }[] {
  const tokens = [...new Set(names.filter((name) => name.trim() !== ''))]
    .sort((a, b) => b.length - a.length)
    .map((name) => `@${name}`);
  if (tokens.length === 0) return body === '' ? [] : [{ text: body, mention: false }];
  const runs: { text: string; mention: boolean }[] = [];
  let rest = body;
  while (rest !== '') {
    let at = -1;
    let token = '';
    for (const candidate of tokens) {
      const index = rest.indexOf(candidate);
      if (index !== -1 && (at === -1 || index < at)) {
        at = index;
        token = candidate;
      }
    }
    if (at === -1) {
      runs.push({ text: rest, mention: false });
      break;
    }
    if (at > 0) runs.push({ text: rest.slice(0, at), mention: false });
    runs.push({ text: token, mention: true });
    rest = rest.slice(at + token.length);
  }
  return runs;
}

export interface MentionMember {
  readonly userId: string;
  readonly name: string;
}

/** The `@query` the caret is at the end of, or null. */
export function mentionQuery(textBeforeCaret: string): string | null {
  const match = /(?:^|\s)@([^\s@]{0,30})$/u.exec(textBeforeCaret);
  return match ? (match[1] ?? '') : null;
}

/** Members whose name starts with — or has a word starting with — the query. */
export function mentionMatches(
  members: readonly MentionMember[],
  query: string,
  limit = 6,
): readonly MentionMember[] {
  const q = query.toLocaleLowerCase();
  return members
    .filter((member) => {
      const name = member.name.toLocaleLowerCase();
      return q === '' || name.startsWith(q) || name.split(/\s+/).some((word) => word.startsWith(q));
    })
    .slice(0, limit);
}
