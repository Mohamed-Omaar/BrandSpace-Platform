/**
 * The pure half of the @-mention typeahead (D-277 §28): what is being typed,
 * and who it could mean. Not a client module, so the unit suite imports it.
 */
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
