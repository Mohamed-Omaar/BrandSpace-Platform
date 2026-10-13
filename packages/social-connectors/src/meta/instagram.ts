import type { ProviderCapabilities } from '../policy';
import type {
  AdapterCredentials,
  PublishOutcome,
  PublishPostKind,
  PublishRequest,
  PublishTarget,
} from '../adapter';
import { captionOf, isRecord, MetaAdapterBase, type MetaAdapterOptions } from './base';
import { optionalString, stringField } from './graph';

/**
 * CONNECTORS B — AN INSTAGRAM PROFESSIONAL ACCOUNT, THROUGH FACEBOOK LOGIN
 * (D-505 O2, D-533).
 *
 *   - TARGETS are the Instagram accounts linked to the Pages the person granted
 *     (`GET /me/accounts?fields=instagram_business_account{…}`).
 *   - THE STORED TOKEN IS THE PERSON'S LONG-LIVED USER TOKEN (about 60 days,
 *     Meta's figure). When it lapses the account needs reconnecting, which the
 *     product already warns about ahead of time (`expiringSoonHours`).
 *   - PUBLISHING IS TWO STEPS (developers.facebook.com/docs/instagram-platform/
 *     instagram-graph-api/content-publishing): `publish` creates a CONTAINER
 *     (`POST /{ig-user-id}/media`) from the media's pre-signed URL and answers
 *     `pending` with the container id; the pipeline then asks `checkPublish`,
 *     which reads the container's `status_code` and, once it is FINISHED, makes
 *     it public (`POST /{ig-user-id}/media_publish`). Nothing is ever sent
 *     twice: a lost answer is asked about by the container id, never resent.
 *   - THE DAILY CAP (`dailyPublishCap`) is checked against Instagram's own
 *     count (`GET /{ig-user-id}/content_publishing_limit`) before a container
 *     is created and again immediately before `media_publish`. The platform's
 *     own `quota_total`, when lower, wins. Over the cap a new post waits and
 *     retries on the configured backoff; a finished container waits.
 *   - Image, carousel (images) and reel are published; a carousel with a video
 *     item and stories are not, in step B.
 */
export class InstagramAccountAdapter extends MetaAdapterBase {
  constructor(capabilities: ProviderCapabilities, options: MetaAdapterOptions = {}) {
    super('INSTAGRAM', capabilities, options);
  }

  async listTargets(input: { credentials: AdapterCredentials }): Promise<readonly PublishTarget[]> {
    const pages = await this.pagesOf(
      input.credentials.accessToken,
      'id,name,instagram_business_account{id,username,profile_picture_url}',
    );
    return pages.flatMap((page) => {
      const account = isRecord(page['instagram_business_account'])
        ? page['instagram_business_account']
        : null;
      if (!account) return [];
      const id = stringField(account, 'id');
      return [
        {
          externalAccountId: id,
          displayName: optionalString(account, 'username') ?? id,
          avatarUrl: optionalString(account, 'profile_picture_url'),
          targetKind: 'business_account',
        },
      ];
    });
  }

  async publish(input: {
    request: PublishRequest;
    credentials: AdapterCredentials;
  }): Promise<PublishOutcome> {
    const { request } = input;
    const account = encodeURIComponent(request.externalAccountId);
    const accessToken = input.credentials.accessToken;
    if (request.firstComment) return this.refused('UNSUPPORTED', 'meta.first_comment_unsupported');
    const urls = request.media.map((item) => item.fetchUrl ?? null);
    if (urls.length === 0 || urls.some((url) => url === null)) {
      return this.refused('MEDIA_INVALID', 'meta.media_url_missing');
    }
    const caption = captionOf(request);
    const kind: PublishPostKind = request.postKind;
    try {
      if (await this.#overCap(account, accessToken)) {
        return this.refused('RATE_LIMITED', 'meta.instagram_daily_cap');
      }
      let container: Record<string, unknown>;
      if (kind === 'image') {
        if (request.media.length !== 1 || !request.media[0]?.mimeType.startsWith('image/')) {
          return this.refused('MEDIA_INVALID', 'meta.instagram_image_shape');
        }
        container = await this.graph({
          method: 'POST',
          path: `${account}/media`,
          form: { image_url: urls[0] as string, caption },
          accessToken,
        });
      } else if (kind === 'reel') {
        if (request.media.length !== 1 || !request.media[0]?.mimeType.startsWith('video/')) {
          return this.refused('MEDIA_INVALID', 'meta.instagram_reel_shape');
        }
        container = await this.graph({
          method: 'POST',
          path: `${account}/media`,
          form: { media_type: 'REELS', video_url: urls[0] as string, caption },
          accessToken,
        });
      } else if (kind === 'carousel') {
        if (request.media.some((item) => !item.mimeType.startsWith('image/'))) {
          return this.refused('UNSUPPORTED', 'meta.instagram_carousel_video_unsupported');
        }
        const children: string[] = [];
        for (const url of urls) {
          const child = await this.graph({
            method: 'POST',
            path: `${account}/media`,
            form: { image_url: url as string, is_carousel_item: 'true' },
            accessToken,
          });
          children.push(stringField(child, 'id'));
        }
        container = await this.graph({
          method: 'POST',
          path: `${account}/media`,
          form: { media_type: 'CAROUSEL', children: children.join(','), caption },
          accessToken,
        });
      } else {
        return this.refused('UNSUPPORTED', `meta.instagram_${kind}_unsupported`);
      }
      return {
        ok: 'pending',
        providerHandle: stringField(container, 'id'),
        providerStatusCode: 200,
      };
    } catch (error) {
      return this.failure(error);
    }
  }

  /**
   * THE CONTAINER'S STATE, AND — WHEN IT IS READY — MAKING IT PUBLIC.
   * `status_code`: FINISHED, IN_PROGRESS, ERROR, EXPIRED (not published within
   * 24 hours), PUBLISHED (developers.facebook.com/docs/instagram-platform/
   * instagram-graph-api/reference/ig-container).
   */
  async checkPublish(input: {
    providerHandle: string;
    externalAccountId: string;
    credentials: AdapterCredentials;
  }): Promise<PublishOutcome> {
    const account = encodeURIComponent(input.externalAccountId);
    const accessToken = input.credentials.accessToken;
    const pending: PublishOutcome = {
      ok: 'pending',
      providerHandle: input.providerHandle,
      providerStatusCode: 200,
    };
    try {
      const container = await this.graph({
        path: encodeURIComponent(input.providerHandle),
        query: { fields: 'status_code' },
        accessToken,
      });
      const status = optionalString(container, 'status_code');
      if (status === 'IN_PROGRESS') return pending;
      if (status === 'ERROR') return this.refused('MEDIA_INVALID', 'meta.container_error');
      // Never made public and now gone: nothing went out; a person decides.
      if (status === 'EXPIRED') return this.refused('UNKNOWN', 'meta.container_expired');
      // Public already, but the answer that named the post was lost. Not
      // resent and not guessed: left unanswered for verification to conclude.
      if (status === 'PUBLISHED') {
        return this.refused('DUPLICATE_CONTENT', 'meta.container_already_published');
      }
      if (status !== 'FINISHED') return this.refused('UNKNOWN', 'meta.container_status_unknown');
      if (await this.#overCap(account, accessToken)) return pending;
      const media = await this.graph({
        method: 'POST',
        path: `${account}/media_publish`,
        form: { creation_id: input.providerHandle },
        accessToken,
      });
      const mediaId = stringField(media, 'id');
      let permalink: string | null = null;
      let observedCaption: string | null | undefined;
      try {
        const read = await this.graph({
          path: encodeURIComponent(mediaId),
          query: { fields: 'permalink,caption' },
          accessToken,
        });
        permalink = optionalString(read, 'permalink');
        observedCaption = optionalString(read, 'caption');
      } catch {
        // The post is public; only its link could not be read back.
      }
      return {
        ok: true,
        externalPostId: mediaId,
        externalPostUrl: permalink,
        providerStatusCode: 200,
        ...(observedCaption === undefined ? {} : { observed: { caption: observedCaption } }),
      };
    } catch (error) {
      return this.failure(error);
    }
  }

  /**
   * Has this account reached the cap? Instagram counts every post the account
   * made through the API in the last 24 hours, ours or not.
   */
  async #overCap(account: string, accessToken: string): Promise<boolean> {
    const cap = this.capabilities.dailyPublishCap;
    if (cap === null) return false;
    const answer = await this.graph({
      path: `${account}/content_publishing_limit`,
      query: { fields: 'quota_usage,config' },
      accessToken,
    });
    const data =
      Array.isArray(answer['data']) && isRecord(answer['data'][0]) ? answer['data'][0] : answer;
    const usage = typeof data['quota_usage'] === 'number' ? data['quota_usage'] : 0;
    const config = isRecord(data['config']) ? data['config'] : null;
    const platformTotal =
      config && typeof config['quota_total'] === 'number' ? config['quota_total'] : null;
    const limit = platformTotal === null ? cap : Math.min(cap, platformTotal);
    return usage >= limit;
  }
}
