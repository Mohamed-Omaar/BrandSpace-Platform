import { FORMAT_POST_KINDS as CONFIGURED_FORMAT_POST_KINDS } from '@brandspace/config';
import type { PublishMedia, PublishPostKind } from './adapter';

/**
 * W2 — WHICH POST KINDS EACH CONTENT FORMAT CAN BE PUBLISHED AS. The map now
 * lives beside the media rule that reads it (`@brandspace/config`,
 * `publishing-media.ts`, D-569); this is the same object, typed as the post
 * kinds an adapter knows.
 */
export const FORMAT_POST_KINDS = CONFIGURED_FORMAT_POST_KINDS as Readonly<
  Record<string, readonly PublishPostKind[]>
>;

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

/** What the capability registry says one provider can carry (`publishing.providers.<key>`). */
export interface ProviderKinds {
  readonly enabled: boolean;
  readonly postKinds: readonly string[];
}

/**
 * For each format, the platforms that can carry it. A format with no platform
 * is absent from the result, so a composer cannot offer it. `enabled` is read
 * nowhere here (D-481): what a channel can carry is its type's, not whether it
 * can be connected right now. A platform the registry does not describe can
 * still be drafted for, as a plain post.
 *
 * Moved here from the dashboard (D-566) so the Studio's "Post to" and the MCP
 * server's `create_post` refuse the same format-channel pairs.
 */
export function platformsByFormat(
  formats: readonly string[],
  platformKeys: readonly string[],
  providers: Readonly<Record<string, ProviderKinds | undefined>>,
): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, string[]> = {};
  for (const format of formats) {
    const needs = FORMAT_POST_KINDS[format] ?? [];
    const supported = platformKeys.filter((key) => {
      const provider = providers[key];
      if (!provider) return format === 'POST';
      return needs.some((kind) => provider.postKinds.includes(kind));
    });
    if (supported.length > 0) result[format] = supported;
  }
  return result;
}
