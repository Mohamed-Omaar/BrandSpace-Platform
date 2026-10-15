import { AREAS, changeLines } from './registry';
import type { AreaContext, AreaSpec, Docs } from './types';
import type { ConfigDomain } from '@brandspace/config';

/**
 * ONE ACTIVATION, IN THE OWNER'S WORDS (owner review of the Simple card pages).
 *
 * The audit event records each changed leaf as a stored path —
 * `plans[starter].trialCredits` — which is right for Advanced and wrong for the
 * owner. This reads the same change through the cards instead: the document
 * before and after, the items each Simple collection makes of it, and the
 * editor's own field labels and value formats ("Fixture Starter: Trial credits:
 * 200 → 500"). A change no card shows (an Advanced-only value) is counted, not
 * spelled out: the details stay in Advanced.
 */

export interface HistoryLine {
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

export interface PlainChange {
  readonly area: AreaSpec | null;
  readonly lines: readonly HistoryLine[];
}

export function plainChange(input: {
  readonly domain: ConfigDomain;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown>;
  /** The other documents the cards read, as they are now. */
  readonly docs: Docs;
  readonly ctx: AreaContext;
}): PlainChange {
  const { domain, ctx } = input;
  const docsBefore: Docs = { ...input.docs, [domain]: input.before ?? {} };
  const docsAfter: Docs = { ...input.docs, [domain]: input.after };
  // The area named is the one whose cards show the change; a document several
  // areas write (sign-ups, industries and legal pages share one) is not
  // credited to whichever happens to be listed first.
  let area: AreaSpec | null = null;
  let firstWriter: AreaSpec | null = null;
  const lines: HistoryLine[] = [];
  const seen = new Set<string>();
  const push = (owner: AreaSpec, line: HistoryLine) => {
    const id = `${line.label}\u0000${line.before}\u0000${line.after}`;
    if (seen.has(id)) return;
    seen.add(id);
    area ??= owner;
    lines.push(line);
  };
  for (const candidate of AREAS) {
    for (const collection of candidate.collections) {
      if (!collection.domains.includes(domain)) continue;
      firstWriter ??= candidate;
      const was = new Map(collection.items(docsBefore, ctx).map((item) => [item.key, item]));
      const now = collection.items(docsAfter, ctx);
      for (const item of now) {
        const old = was.get(item.key);
        was.delete(item.key);
        if (!old) {
          push(candidate, { label: item.title, before: '—', after: ctx.t('w.added') });
          continue;
        }
        const fields = collection.fields(docsAfter, ctx, 'edit', item.key);
        for (const line of changeLines(fields, old.values, item.values, ctx)) {
          push(candidate, {
            label: `${item.title}: ${line.label}`,
            before: line.before,
            after: line.after,
          });
        }
      }
      for (const gone of was.values()) {
        push(candidate, { label: gone.title, before: '—', after: ctx.t('w.removed') });
      }
    }
  }
  return { area: area ?? firstWriter, lines };
}
