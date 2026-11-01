/**
 * ONE HASHTAG NORMALISATION, APPLIED ON STORE (KNOWN bug "##", PR A item 7).
 *
 * The model returned tags with their mark (`#launch`), they were stored
 * verbatim, and every renderer added its own `#` — so the screen, and a first
 * comment that was published as written, read `##launch`. A tag is now stored
 * WITHOUT the mark everywhere a tag is written: the model's parser, the merge
 * of proposed tags, a person's own edit, and the first-comment builder. The
 * renderers keep adding exactly one `#`.
 */
/** `#launch`, `launch ` and `LAUNCH` are one tag, stored without the mark. */
export function normaliseHashtags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#+/, '').trim();
    if (!tag || /\s/.test(tag)) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}
