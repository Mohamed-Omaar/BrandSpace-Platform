/**
 * WHAT MEDIA A CHANNEL NEEDS BEFORE A POST CAN GO OUT (Studio review, owner
 * decision 1 — D-569).
 *
 * PURE AND DEPENDENCY-FREE, so the Studio's check card can judge it in the
 * browser (`@brandspace/config/publishing-media`) and the content services can
 * refuse on the server with the same answer. Nothing here is a channel fact:
 * every rule is read from the channel's configured capability —
 * `publishing.providers.<key>.postKinds` and `.mediaRules` (CLAUDE.md §2.2).
 */

/**
 * W2 — WHICH POST KINDS EACH CONTENT FORMAT CAN BE PUBLISHED AS. The one map
 * the composer (which formats a platform can carry), the pipeline (what a post
 * is, when it is sent) and this rule read, so the three cannot disagree.
 * `@brandspace/social-connectors` re-exports it.
 */
export const FORMAT_POST_KINDS: Readonly<Record<string, readonly string[]>> = {
  POST: ['text', 'image'],
  CAROUSEL: ['carousel'],
  REEL: ['reel'],
  STORY: ['story'],
  VIDEO: ['video'],
  ARTICLE: ['article'],
  THREAD: ['thread'],
};

/** Post kinds that are a video before they are anything else. */
const VIDEO_KINDS: ReadonlySet<string> = new Set(['video', 'reel']);

/** The slice of a channel's configured capability this rule reads. */
export interface ChannelMediaCapability {
  /** `publishing.providers.<key>.postKinds`: the shapes the channel accepts. */
  readonly postKinds: readonly string[];
  /** `publishing.providers.<key>.mediaRules`: per post kind, e.g. `minItems`. */
  readonly mediaRules?: Readonly<Record<string, { readonly minItems?: number | null } | undefined>>;
}

/** What is missing: a picture (or any visual), or a video. */
export type MissingMedia = 'picture' | 'video';

/**
 * What this channel still needs before the post can go out, or null.
 *
 *   - A channel that accepts only video kinds (TikTok's `['video']`) needs a
 *     video, whatever the format: no video attached is "Needs a video".
 *   - A plain post with nothing attached is a `text` post; a channel that does
 *     not accept `text` (Instagram) needs a picture — or a video, when it
 *     accepts no picture kind at all.
 *   - A post kind whose configured `mediaRules.<kind>.minItems` is above zero
 *     needs that media, and nothing attached falls short of it.
 *
 * A channel with no configured capability is not judged here (it can still be
 * drafted for as a plain post), and the format-channel pairs a channel cannot
 * carry at all are refused where the format is chosen.
 */
export function missingMediaFor(
  contentType: string,
  mediaKinds: readonly string[],
  capability: ChannelMediaCapability | null | undefined,
): MissingMedia | null {
  if (!capability || capability.postKinds.length === 0) return null;
  const accepts = capability.postKinds;
  const hasVideo = mediaKinds.includes('VIDEO');
  if (accepts.every((kind) => VIDEO_KINDS.has(kind))) return hasVideo ? null : 'video';

  const none = mediaKinds.length === 0;
  const kind =
    contentType === 'POST'
      ? none
        ? 'text'
        : 'image'
      : (FORMAT_POST_KINDS[contentType]?.[0] ?? null);
  if (kind === null) return null;
  if (contentType === 'POST' && none && !accepts.includes('text')) {
    return accepts.includes('image') || accepts.includes('carousel') ? 'picture' : 'video';
  }
  const minItems = capability.mediaRules?.[kind]?.minItems ?? 0;
  if (minItems > 0 && none) return VIDEO_KINDS.has(kind) ? 'video' : 'picture';
  return null;
}
