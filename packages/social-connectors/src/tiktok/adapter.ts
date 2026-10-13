import type { PublishFailureClass } from '@brandspace/database';
import type {
  AdapterApplication,
  AdapterCredentials,
  AuthorizationRequest,
  ConnectionHealth,
  PublishFailure,
  PublishMedia,
  PublishOutcome,
  PublishRequest,
  PublishTarget,
  SocialConnectorAdapter,
  TokenBundle,
} from '../adapter';
import type { ProviderCapabilities } from '../policy';
import {
  classifyTikTokError,
  classifyTikTokFailReason,
  dataOf,
  optionalString,
  stringField,
  TIKTOK_AUTHORIZE_URL,
  TIKTOK_SAFE_SUMMARIES,
  TikTokApiError,
  tiktokFailureCode,
  tiktokRequest,
  TikTokShapeError,
  TikTokTransportError,
  tiktokUpload,
  type TikTokFetch,
} from './api';
import {
  interactionFlags,
  isTikTokPrivacyLevel,
  readTikTokOptions,
  tiktokOptionsProblems,
  type CreatorPostingInfo,
  type TikTokPrivacyLevel,
} from './options';

/**
 * CONNECTORS C — A TIKTOK ACCOUNT, THROUGH LOGIN KIT AND THE CONTENT POSTING
 * API'S DIRECT POST (D-505).
 *
 *   - ONE GRANT, ONE ACCOUNT. A TikTok login is one creator; the target is
 *     that creator (`open_id`), and disconnecting it revokes the grant at
 *     TikTok (`POST /oauth/revoke/`) — nothing else shares it.
 *   - TOKENS ROTATE. The access token lasts 24 hours and the refresh token 365
 *     days (developers.tiktok.com/doc/oauth-user-access-token-management). A
 *     refresh may answer a NEW refresh token; whatever it answers is returned
 *     and the caller seals it as the next credential version, so the stored
 *     refresh token is always the latest. The proactive refresh (W6) keeps a
 *     connection with no post due from lapsing.
 *   - VIDEO GOES AS BYTES (`FILE_UPLOAD`, D-505 O1): `video/init` answers a
 *     `publish_id` and an `upload_url`; the file is PUT in chunks, in order;
 *     then the post is TikTok's to finish, so the answer is `pending` with the
 *     `publish_id` and `checkPublish` asks `status/fetch` until it is done.
 *   - PHOTOS GO BY URL (`PULL_FROM_URL`), so they need the pipeline's
 *     pre-signed URL (`mediaByUrl`) on a domain verified with TikTok. The owner
 *     turns on `mediaByUrl` and the photo post kinds only once the domain is
 *     verified; without a URL a photo post is refused before any call.
 *   - TIKTOK'S GUIDELINES ARE ENFORCED HERE TOO, not only in the Studio:
 *     `creator_info` is asked before every post, the author's privacy level
 *     must be one it offers (no default), interactions the creator turned off
 *     stay off, and the video must fit the creator's maximum duration. While
 *     the app is unaudited (`forcedAudience: 'private'`) every post is sent
 *     "Only me" (`SELF_ONLY`).
 *   - NOTHING IS SENT TWICE. TikTok takes no idempotency key and offers no
 *     lookup (`supportsPostLookup` stays false). An upload that fails before
 *     its last chunk publishes nothing and may be tried again; once the last
 *     chunk is sent, a lost answer is asked about by `publish_id`, never sent
 *     again.
 *
 * NOT YET RUN AGAINST TIKTOK. Every request and answer is TikTok's documented
 * shape (cited per call) and is exercised by recorded fixtures
 * (`tests/unit/connectors-c-tiktok-adapter.test.ts`). The first real run is
 * the owner's, on staging, in TikTok's sandbox.
 */

export interface TikTokAdapterOptions {
  readonly fetch?: TikTokFetch;
  /** Per-call ceiling for JSON calls. Default 30 s. */
  readonly timeoutMs?: number;
}

/**
 * THE CHUNK RULES OF `FILE_UPLOAD` (developers.tiktok.com/docs/en/
 * content-posting-api-media-transfer-guide): a chunk is 5–64 MB, the last may
 * be larger (up to 128 MB) to carry the remainder, a file under 5 MB is one
 * chunk, a file over 64 MB is several, 1–1000 chunks, `total_chunk_count` =
 * floor(size ÷ chunk_size). Decimal megabytes, so the bound holds whichever
 * way TikTok counts a megabyte.
 */
export const TIKTOK_MAX_CHUNK_BYTES = 64_000_000;

export interface ChunkPlan {
  readonly chunkSize: number;
  readonly totalChunkCount: number;
  /** [firstByte, endExclusive) for each chunk, in order. */
  readonly ranges: readonly (readonly [number, number])[];
}

/** One chunk up to 64 MB; above that, 64 MB chunks with the remainder in the last. */
export function chunkPlan(totalBytes: number): ChunkPlan {
  if (!Number.isInteger(totalBytes) || totalBytes <= 0) {
    throw new TikTokShapeError('a video must have bytes');
  }
  if (totalBytes <= TIKTOK_MAX_CHUNK_BYTES) {
    return { chunkSize: totalBytes, totalChunkCount: 1, ranges: [[0, totalBytes]] };
  }
  const chunkSize = TIKTOK_MAX_CHUNK_BYTES;
  const totalChunkCount = Math.floor(totalBytes / chunkSize);
  const ranges: [number, number][] = [];
  for (let index = 0; index < totalChunkCount; index += 1) {
    const first = index * chunkSize;
    const end = index === totalChunkCount - 1 ? totalBytes : first + chunkSize;
    ranges.push([first, end]);
  }
  return { chunkSize, totalChunkCount, ranges };
}

/** A creator_info answer that refuses means "cannot post now", not "broken". */
const CANNOT_POST_CODES = new Set([
  'spam_risk_too_many_posts',
  'spam_risk_user_banned_from_posting',
  'reached_active_user_cap',
  'spam_risk_too_many_pending_share',
]);

export class TikTokAccountAdapter implements SocialConnectorAdapter {
  readonly provider = 'TIKTOK' as const;
  readonly capabilities: ProviderCapabilities;
  readonly #apiVersion: string;
  readonly #fetch: TikTokFetch;
  readonly #timeoutMs: number | undefined;

  constructor(capabilities: ProviderCapabilities, options: TikTokAdapterOptions = {}) {
    if (capabilities.apiVersion === null) {
      throw new Error('The TIKTOK adapter needs publishing.providers.tiktok.apiVersion.');
    }
    this.capabilities = capabilities;
    this.#apiVersion = capabilities.apiVersion;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as TikTokFetch);
    this.#timeoutMs = options.timeoutMs;
  }

  #call(input: {
    method?: 'GET' | 'POST';
    path: string;
    query?: Record<string, string>;
    json?: unknown;
    form?: Record<string, string>;
    accessToken?: string;
  }): Promise<Record<string, unknown>> {
    return tiktokRequest({
      fetch: this.#fetch,
      apiVersion: this.#apiVersion,
      ...input,
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
    });
  }

  /**
   * The Login Kit page (developers.tiktok.com/doc/login-kit-web): `client_key`,
   * comma-separated `scope`, `redirect_uri`, `state`. NO PKCE ON THE WEB: TikTok
   * documents the challenge for desktop and mobile apps only; a web client is
   * protected by the single-use `state` and keeps its secret on the server.
   */
  buildAuthorizationUrl(request: AuthorizationRequest): string {
    const url = new URL(TIKTOK_AUTHORIZE_URL);
    url.searchParams.set('client_key', request.application.appId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', request.scopes.join(','));
    url.searchParams.set('redirect_uri', request.application.redirectUri);
    url.searchParams.set('state', request.state);
    return url.toString();
  }

  /** `POST /oauth/token/`, `grant_type=authorization_code`. */
  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    application: AdapterApplication;
  }): Promise<TokenBundle> {
    const answer = await this.#call({
      path: 'oauth/token/',
      form: {
        client_key: input.application.appId,
        client_secret: input.application.clientSecret,
        code: input.code,
        grant_type: 'authorization_code',
        redirect_uri: input.application.redirectUri,
      },
    });
    return tokenBundle(answer, null);
  }

  /**
   * `POST /oauth/token/`, `grant_type=refresh_token`. TikTok may answer a new
   * refresh token; when it does not, the one in hand is still the valid one,
   * and it is what goes back to be stored.
   */
  async refreshToken(input: {
    refreshToken: string;
    application: AdapterApplication;
  }): Promise<TokenBundle> {
    const answer = await this.#call({
      path: 'oauth/token/',
      form: {
        client_key: input.application.appId,
        client_secret: input.application.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
      },
    });
    return tokenBundle(answer, input.refreshToken);
  }

  /** `POST /oauth/revoke/`: the grant is this one account's, so it is revoked. */
  async revoke(input: {
    credentials: AdapterCredentials;
    application: AdapterApplication;
  }): Promise<void> {
    await this.#call({
      path: 'oauth/revoke/',
      form: {
        client_key: input.application.appId,
        client_secret: input.application.clientSecret,
        token: input.credentials.accessToken,
      },
    });
  }

  /** The one creator the grant is (`GET /user/info/`, `user.info.basic`). */
  async listTargets(input: { credentials: AdapterCredentials }): Promise<readonly PublishTarget[]> {
    const user = await this.#user(input.credentials.accessToken);
    return [
      {
        externalAccountId: stringField(user, 'open_id'),
        displayName: optionalString(user, 'display_name') ?? stringField(user, 'open_id'),
        avatarUrl: optionalString(user, 'avatar_url'),
        targetKind: 'profile',
      },
    ];
  }

  async checkHealth(input: { credentials: AdapterCredentials }): Promise<ConnectionHealth> {
    try {
      await this.#user(input.credentials.accessToken);
      return { healthy: true, failureClass: null };
    } catch (error) {
      return { healthy: false, failureClass: classifyTikTokError(error) };
    }
  }

  async #user(accessToken: string): Promise<Record<string, unknown>> {
    const answer = await this.#call({
      method: 'GET',
      path: 'user/info/',
      query: { fields: 'open_id,display_name,avatar_url' },
      accessToken,
    });
    const user = dataOf(answer)['user'];
    if (user === null || typeof user !== 'object' || Array.isArray(user)) {
      throw new TikTokShapeError('user/info without user');
    }
    return user as Record<string, unknown>;
  }

  /**
   * `POST /post/publish/creator_info/query/` (developers.tiktok.com/doc/
   * content-posting-api-reference-query-creator-info). A refusal that means
   * "this creator cannot post now" is an answer, not an error: the Studio
   * shows it and stops.
   */
  async postingOptions(input: { credentials: AdapterCredentials }): Promise<CreatorPostingInfo> {
    let data: Record<string, unknown>;
    try {
      data = dataOf(
        await this.#call({
          path: 'post/publish/creator_info/query/',
          json: {},
          accessToken: input.credentials.accessToken,
        }),
      );
    } catch (error) {
      if (error instanceof TikTokApiError && error.code && CANNOT_POST_CODES.has(error.code)) {
        return {
          nickname: '',
          username: null,
          avatarUrl: null,
          privacyLevels: [],
          commentDisabled: true,
          duetDisabled: true,
          stitchDisabled: true,
          maxVideoSeconds: null,
          cannotPostReason: error.code,
        };
      }
      throw error;
    }
    const levels = Array.isArray(data['privacy_level_options'])
      ? data['privacy_level_options'].filter(isTikTokPrivacyLevel)
      : [];
    const max = data['max_video_post_duration_sec'];
    return {
      nickname: optionalString(data, 'creator_nickname') ?? '',
      username: optionalString(data, 'creator_username'),
      avatarUrl: optionalString(data, 'creator_avatar_url'),
      privacyLevels: levels,
      commentDisabled: data['comment_disabled'] === true,
      duetDisabled: data['duet_disabled'] === true,
      stitchDisabled: data['stitch_disabled'] === true,
      maxVideoSeconds: typeof max === 'number' && max > 0 ? max : null,
      cannotPostReason: null,
    };
  }

  async publish(input: {
    request: PublishRequest;
    credentials: AdapterCredentials;
  }): Promise<PublishOutcome> {
    const { request } = input;
    const accessToken = input.credentials.accessToken;
    if (request.firstComment)
      return this.#refused('UNSUPPORTED', 'tiktok.first_comment_unsupported');
    const options = readTikTokOptions(request.options);
    const forcedPrivate = this.capabilities.forcedAudience === 'private';
    const photos = request.postKind === 'image' || request.postKind === 'carousel';
    if (!photos && request.postKind !== 'video' && request.postKind !== 'reel') {
      return this.#refused('UNSUPPORTED', `tiktok.${request.postKind}_unsupported`);
    }
    // Checked before any call: what the author must have chosen.
    const early = tiktokOptionsProblems(options, null, forcedPrivate);
    if (early.length > 0) return this.#refused('CONTENT_REJECTED', early[0] as string);

    let creator: CreatorPostingInfo;
    try {
      creator = await this.postingOptions({ credentials: input.credentials });
    } catch (error) {
      return this.#failure(error);
    }
    if (creator.cannotPostReason) {
      return this.#refused(
        classifyTikTokFailReason(creator.cannotPostReason),
        `tiktok.${creator.cannotPostReason}`,
      );
    }
    const problems = tiktokOptionsProblems(options, creator, forcedPrivate);
    if (problems.length > 0) return this.#refused('CONTENT_REJECTED', problems[0] as string);
    const privacyLevel: TikTokPrivacyLevel = forcedPrivate
      ? 'SELF_ONLY'
      : (options.privacyLevel as TikTokPrivacyLevel);
    const flags = interactionFlags(options, creator);
    const caption = captionOf(request);

    try {
      if (photos)
        return await this.#publishPhotos(
          request,
          caption,
          privacyLevel,
          flags,
          options,
          accessToken,
        );
      return await this.#publishVideo(
        request,
        caption,
        privacyLevel,
        flags,
        options,
        creator,
        accessToken,
      );
    } catch (error) {
      return this.#failure(error);
    }
  }

  /** `POST /post/publish/video/init/` with `FILE_UPLOAD`, then the chunks, in order. */
  async #publishVideo(
    request: PublishRequest,
    caption: string,
    privacyLevel: TikTokPrivacyLevel,
    flags: ReturnType<typeof interactionFlags>,
    options: ReturnType<typeof readTikTokOptions>,
    creator: CreatorPostingInfo,
    accessToken: string,
  ): Promise<PublishOutcome> {
    const video = request.media[0];
    if (request.media.length !== 1 || !video || !video.mimeType.startsWith('video/')) {
      return this.#refused('MEDIA_INVALID', 'tiktok.video_shape');
    }
    if (
      creator.maxVideoSeconds !== null &&
      typeof video.durationMs === 'number' &&
      video.durationMs > creator.maxVideoSeconds * 1_000
    ) {
      return this.#refused('MEDIA_INVALID', 'tiktok.video_too_long_for_creator');
    }
    const bytes = video.bytes;
    const plan = chunkPlan(bytes.byteLength);
    const init = dataOf(
      await this.#call({
        path: 'post/publish/video/init/',
        accessToken,
        json: {
          post_info: {
            title: caption,
            privacy_level: privacyLevel,
            disable_comment: flags.disableComment,
            disable_duet: flags.disableDuet,
            disable_stitch: flags.disableStitch,
            brand_content_toggle: options.disclosure.enabled && options.disclosure.brandedContent,
            brand_organic_toggle: options.disclosure.enabled && options.disclosure.yourBrand,
          },
          source_info: {
            source: 'FILE_UPLOAD',
            video_size: bytes.byteLength,
            chunk_size: plan.chunkSize,
            total_chunk_count: plan.totalChunkCount,
          },
        },
      }),
    );
    const publishId = stringField(init, 'publish_id');
    const uploadUrl = stringField(init, 'upload_url');
    const pending: PublishOutcome = {
      ok: 'pending',
      providerHandle: publishId,
      providerStatusCode: 200,
    };
    for (let index = 0; index < plan.ranges.length; index += 1) {
      const [first, end] = plan.ranges[index] as readonly [number, number];
      const last = index === plan.ranges.length - 1;
      try {
        await tiktokUpload({
          fetch: this.#fetch,
          uploadUrl,
          mimeType: video.mimeType,
          chunk: bytes.subarray(first, end),
          firstByte: first,
          totalBytes: bytes.byteLength,
        });
      } catch (error) {
        // The LAST chunk sent with no answer may have completed the file, and
        // a complete file is published by TikTok: ask, never resend.
        if (last && error instanceof TikTokTransportError) return pending;
        // An earlier chunk: the file is incomplete and TikTok publishes nothing.
        return this.#failure(error);
      }
    }
    return pending;
  }

  /** `POST /post/publish/content/init/` with `PULL_FROM_URL` (photos). */
  async #publishPhotos(
    request: PublishRequest,
    caption: string,
    privacyLevel: TikTokPrivacyLevel,
    flags: ReturnType<typeof interactionFlags>,
    options: ReturnType<typeof readTikTokOptions>,
    accessToken: string,
  ): Promise<PublishOutcome> {
    if (
      request.media.length === 0 ||
      request.media.some((item) => !item.mimeType.startsWith('image/'))
    ) {
      return this.#refused('MEDIA_INVALID', 'tiktok.photo_shape');
    }
    const urls = request.media.map((item: PublishMedia) => item.fetchUrl ?? null);
    if (urls.some((url) => url === null)) {
      return this.#refused('MEDIA_INVALID', 'tiktok.photo_needs_verified_url');
    }
    const init = dataOf(
      await this.#call({
        path: 'post/publish/content/init/',
        accessToken,
        json: {
          media_type: 'PHOTO',
          post_mode: 'DIRECT_POST',
          post_info: {
            description: caption,
            privacy_level: privacyLevel,
            disable_comment: flags.disableComment,
            brand_content_toggle: options.disclosure.enabled && options.disclosure.brandedContent,
            brand_organic_toggle: options.disclosure.enabled && options.disclosure.yourBrand,
          },
          source_info: {
            source: 'PULL_FROM_URL',
            photo_cover_index: 0,
            photo_images: urls,
          },
        },
      }),
    );
    return {
      ok: 'pending',
      providerHandle: stringField(init, 'publish_id'),
      providerStatusCode: 200,
    };
  }

  /**
   * `POST /post/publish/status/fetch/` (developers.tiktok.com/docs/en/
   * content-posting-api-reference-get-video-status). PROCESSING_UPLOAD and
   * PROCESSING_DOWNLOAD are still pending; PUBLISH_COMPLETE is the post;
   * FAILED carries a `fail_reason` word. A private post has no public id, so
   * the publish id stands for it and no link is shown.
   */
  async checkPublish(input: {
    providerHandle: string;
    externalAccountId: string;
    credentials: AdapterCredentials;
  }): Promise<PublishOutcome> {
    const pending: PublishOutcome = {
      ok: 'pending',
      providerHandle: input.providerHandle,
      providerStatusCode: 200,
    };
    try {
      const data = dataOf(
        await this.#call({
          path: 'post/publish/status/fetch/',
          json: { publish_id: input.providerHandle },
          accessToken: input.credentials.accessToken,
        }),
      );
      const status = optionalString(data, 'status');
      if (status === 'PROCESSING_UPLOAD' || status === 'PROCESSING_DOWNLOAD') return pending;
      if (status === 'FAILED') {
        const reason = optionalString(data, 'fail_reason');
        const safeReason = reason && /^[a-z0-9_]{1,80}$/.test(reason) ? reason : 'failed';
        return this.#refused(classifyTikTokFailReason(reason), `tiktok.${safeReason}`);
      }
      if (status === 'PUBLISH_COMPLETE') {
        const ids = Array.isArray(data['publicaly_available_post_id'])
          ? data['publicaly_available_post_id'].filter(
              (id): id is string | number => typeof id === 'string' || typeof id === 'number',
            )
          : [];
        const postId = ids.length > 0 ? String(ids[0]) : input.providerHandle;
        return {
          ok: true,
          externalPostId: postId,
          externalPostUrl: null,
          providerStatusCode: 200,
        };
      }
      return this.#refused('UNKNOWN', 'tiktok.status_unknown');
    } catch (error) {
      return this.#failure(error);
    }
  }

  classifyError(error: unknown): PublishFailureClass {
    return classifyTikTokError(error);
  }

  #failure(error: unknown): PublishFailure {
    const failureClass = classifyTikTokError(error);
    return {
      ok: false,
      failureClass,
      failureCode: tiktokFailureCode(error),
      providerStatusCode: error instanceof TikTokApiError ? error.status : null,
      providerErrorCode: error instanceof TikTokApiError ? error.code : null,
      safeSummary: TIKTOK_SAFE_SUMMARIES[failureClass],
    };
  }

  #refused(failureClass: PublishFailureClass, failureCode: string): PublishFailure {
    return {
      ok: false,
      failureClass,
      failureCode,
      providerStatusCode: null,
      providerErrorCode: null,
      safeSummary: TIKTOK_SAFE_SUMMARIES[failureClass],
    };
  }
}

/** The token endpoint's answer as a bundle; `fallbackRefresh` when none is returned. */
function tokenBundle(answer: Record<string, unknown>, fallbackRefresh: string | null): TokenBundle {
  const expiresIn = answer['expires_in'];
  const scope = optionalString(answer, 'scope');
  return {
    accessToken: stringField(answer, 'access_token'),
    refreshToken: optionalString(answer, 'refresh_token') ?? fallbackRefresh,
    expiresInSeconds: typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : null,
    grantedScopes: scope
      ? scope
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
    subjectId: optionalString(answer, 'open_id'),
  };
}

/** The caption TikTok receives: the author's text, then the hashtags. */
export function captionOf(request: Pick<PublishRequest, 'body' | 'hashtags'>): string {
  const tags = request.hashtags
    .map((tag) => tag.replace(/^#+/, '').trim())
    .filter((tag) => tag.length > 0)
    .map((tag) => `#${tag}`)
    .join(' ');
  return tags.length === 0 ? request.body : `${request.body}\n\n${tags}`;
}
