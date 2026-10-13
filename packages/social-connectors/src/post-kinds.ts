import type { PublishMedia, PublishPostKind } from './adapter';

/**
 * W2 — WHICH POST KINDS EACH CONTENT FORMAT CAN BE PUBLISHED AS. The one map
 * the composer (which formats a platform can carry) and the pipeline (what a
 * post is, when it is sent) both read, so the two cannot disagree.
 */
export const FORMAT_POST_KINDS: Readonly<Record<string, readonly PublishPostKind[]>> = {
  POST: ['text', 'image'],
  CAROUSEL: ['carousel'],
  REEL: ['reel'],
  STORY: ['story'],
  VIDEO: ['video'],
  ARTICLE: ['article'],
  THREAD: ['thread'],
};

/**
 * The one post kind a post IS: its format's kind, and for a plain post, `text`
 * without media and `image` with it. Null for a format nothing maps.
 */
export function postKindFor(
  contentType: string,
  media: readonly Pick<PublishMedia, 'mimeType'>[],
): PublishPostKind | null {
  const kinds = FORMAT_POST_KINDS[contentType];
  if (!kinds || kinds.length === 0) return null;
  if (contentType === 'POST') return media.length === 0 ? 'text' : 'image';
  return kinds[0] ?? null;
}
