import type { ProviderCapabilities } from '../policy';
import type { AdapterCredentials, PublishOutcome, PublishRequest, PublishTarget } from '../adapter';
import { captionOf, isRecord, MetaAdapterBase, type MetaAdapterOptions } from './base';
import { optionalString, stringField } from './graph';

/**
 * CONNECTORS B — A FACEBOOK PAGE (D-505, D-533).
 *
 *   - TARGETS are the Pages the person granted (`GET /me/accounts`,
 *     developers.facebook.com/docs/pages-api/getting-started).
 *   - THE STORED TOKEN IS THE PAGE'S, not the person's: `bindTarget` asks for
 *     the chosen Page's own token (`GET /{page-id}?fields=access_token`), which
 *     Meta does not expire when it comes from a long-lived user token. The
 *     user token is used only during the connection and is never stored.
 *   - A POST is `POST /{page-id}/feed` (text, with an optional link), one photo
 *     is `POST /{page-id}/photos` from its pre-signed URL, and several photos
 *     are uploaded unpublished and attached to one feed post
 *     (developers.facebook.com/docs/pages-api/posts). Video and reels are not
 *     published by this adapter in step B; the configuration does not offer
 *     them.
 *   - NO LOOKUP: Facebook offers no idempotency key, so an attempt whose answer
 *     was lost is not retried (`supportsPostLookup` stays false) — a missing
 *     post is better than a duplicate one.
 */
export class FacebookPageAdapter extends MetaAdapterBase {
  constructor(capabilities: ProviderCapabilities, options: MetaAdapterOptions = {}) {
    super('FACEBOOK', capabilities, options);
  }

  async listTargets(input: { credentials: AdapterCredentials }): Promise<readonly PublishTarget[]> {
    const pages = await this.pagesOf(input.credentials.accessToken, 'id,name,picture{url}');
    return pages.map((page) => {
      const picture = isRecord(page['picture']) ? page['picture'] : null;
      const data = picture && isRecord(picture['data']) ? picture['data'] : null;
      return {
        externalAccountId: stringField(page, 'id'),
        displayName: optionalString(page, 'name') ?? stringField(page, 'id'),
        avatarUrl: data ? optionalString(data, 'url') : null,
        targetKind: 'page',
      };
    });
  }

  async bindTarget(input: {
    credentials: AdapterCredentials;
    externalAccountId: string;
  }): Promise<{ accessToken: string; expiresInSeconds: number | null }> {
    const page = await this.graph({
      path: encodeURIComponent(input.externalAccountId),
      query: { fields: 'access_token' },
      accessToken: input.credentials.accessToken,
    });
    return { accessToken: stringField(page, 'access_token'), expiresInSeconds: null };
  }

  async publish(input: {
    request: PublishRequest;
    credentials: AdapterCredentials;
  }): Promise<PublishOutcome> {
    const { request } = input;
    const page = encodeURIComponent(request.externalAccountId);
    const accessToken = input.credentials.accessToken;
    if (request.firstComment) return this.refused('UNSUPPORTED', 'meta.first_comment_unsupported');
    const caption = captionOf(request);
    try {
      if (request.postKind === 'text') {
        if (request.media.length > 0) return this.refused('UNSUPPORTED', 'meta.text_with_media');
        const answer = await this.graph({
          method: 'POST',
          path: `${page}/feed`,
          form: { message: caption, ...(request.linkUrl ? { link: request.linkUrl } : {}) },
          accessToken,
        });
        return this.#published(stringField(answer, 'id'));
      }
      if (request.postKind !== 'image' && request.postKind !== 'carousel') {
        return this.refused('UNSUPPORTED', `meta.facebook_${request.postKind}_unsupported`);
      }
      const urls = request.media.map((item) => item.fetchUrl ?? null);
      if (urls.length === 0 || urls.some((url) => url === null)) {
        return this.refused('MEDIA_INVALID', 'meta.media_url_missing');
      }
      if (request.media.some((item) => !item.mimeType.startsWith('image/'))) {
        return this.refused('UNSUPPORTED', 'meta.facebook_video_unsupported');
      }
      const withLink = request.linkUrl ? `${caption}\n\n${request.linkUrl}` : caption;
      if (urls.length === 1) {
        const answer = await this.graph({
          method: 'POST',
          path: `${page}/photos`,
          form: { url: urls[0] as string, caption: withLink },
          accessToken,
        });
        return this.#published(optionalString(answer, 'post_id') ?? stringField(answer, 'id'));
      }
      // Several photos: each uploaded unpublished, then one post carrying them.
      const photoIds: string[] = [];
      for (const url of urls) {
        const photo = await this.graph({
          method: 'POST',
          path: `${page}/photos`,
          form: { url: url as string, published: 'false' },
          accessToken,
        });
        photoIds.push(stringField(photo, 'id'));
      }
      const attached = Object.fromEntries(
        photoIds.map((id, index) => [
          `attached_media[${index}]`,
          JSON.stringify({ media_fbid: id }),
        ]),
      );
      const answer = await this.graph({
        method: 'POST',
        path: `${page}/feed`,
        form: { message: withLink, ...attached },
        accessToken,
      });
      return this.#published(stringField(answer, 'id'));
    } catch (error) {
      return this.failure(error);
    }
  }

  #published(postId: string): PublishOutcome {
    return {
      ok: true,
      externalPostId: postId,
      externalPostUrl: `https://www.facebook.com/${encodeURIComponent(postId)}`,
      providerStatusCode: 200,
    };
  }
}
