import { describe, expect, it } from 'vitest';
import {
  chunkPlan,
  classifyTikTokError,
  createConnectorRegistry,
  MockSocialConnectorAdapter,
  parsePublishingPolicy,
  TikTokAccountAdapter,
  TikTokApiError,
  TikTokTransportError,
  TIKTOK_MAX_CHUNK_BYTES,
  type PublishingPolicy,
  type PublishRequest,
} from '@brandspace/social-connectors';
import { ok, recordedTikTok, TIKTOK } from '../support/tiktok-fixtures';

/**
 * CONNECTORS C — THE TIKTOK ADAPTER AGAINST RECORDED ANSWERS (D-505).
 *
 * Every call goes through an injected transport that answers with the shapes
 * TikTok documents (`tests/support/tiktok-fixtures.ts`) and records what was
 * sent, so each test says both what the adapter did with an answer and exactly
 * what it asked TikTok. Nothing reaches the network.
 */

function policy(overrides: Record<string, unknown> = {}): PublishingPolicy {
  return parsePublishingPolicy({
    providers: {
      tiktok: {
        enabled: true,
        postKinds: ['video', 'image', 'carousel'],
        scopes: ['user.info.basic', 'video.publish'],
        apiVersion: 'v2',
        ...overrides,
      },
    },
  });
}

const application = {
  appId: 'testclientkey0001',
  clientSecret: 'test-only-client-secret',
  redirectUri: 'https://api.example.test/v1/social/callback/tiktok',
};

const credentials = { accessToken: 'act.test-access-1', refreshToken: 'rft.test-refresh-1' };

const chosen = {
  privacyLevel: 'PUBLIC_TO_EVERYONE',
  allowComment: true,
  allowDuet: false,
  allowStitch: true,
  disclosure: { enabled: true, yourBrand: true, brandedContent: false },
};

function video(bytes = 1_000, durationMs: number | null = 30_000) {
  return {
    assetId: 'asset-video',
    mimeType: 'video/mp4',
    sizeBytes: bytes,
    width: 1_080,
    height: 1_920,
    fileName: 'clip.mp4',
    bytes: new Uint8Array(bytes),
    durationMs,
  };
}

const photo = (n: number, signed = true) => ({
  assetId: `asset-${n}`,
  mimeType: 'image/jpeg',
  sizeBytes: 1_000,
  width: 1_080,
  height: 1_350,
  fileName: `photo-${n}.jpg`,
  bytes: new Uint8Array(),
  ...(signed ? { fetchUrl: `https://media.example.test/signed/${n}?X-Amz-Signature=test` } : {}),
});

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    externalAccountId: 'test-open-id-0001',
    body: 'Fresh bread today',
    hashtags: ['bakery'],
    firstComment: null,
    media: [video()],
    idempotencyKey: 'job-1',
    postKind: 'video',
    linkUrl: null,
    options: chosen,
    ...overrides,
  };
}

const tiktok = (routes: Parameters<typeof recordedTikTok>[0], overrides = {}) => {
  const recorded = recordedTikTok(routes);
  const adapter = new TikTokAccountAdapter(policy(overrides).providers.tiktok, {
    fetch: recorded.fetch,
  });
  return { adapter, calls: recorded.calls };
};

// A sent body: each top-level field is an object (post_info, source_info) or a word.
const json = (body: unknown) => JSON.parse(String(body)) as Record<string, Record<string, unknown>>;

describe('TikTok login — the page, the exchange, the creator', () => {
  it('the login URL carries the client key, comma-separated scopes, the redirect and state — no secret, no PKCE', () => {
    const { adapter } = tiktok({});
    const url = new URL(
      adapter.buildAuthorizationUrl({
        state: 'opaque-state',
        codeChallenge: 'ignored-on-web',
        scopes: ['user.info.basic', 'video.publish'],
        application,
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(url.searchParams.get('client_key')).toBe(application.appId);
    expect(url.searchParams.get('scope')).toBe('user.info.basic,video.publish');
    expect(url.searchParams.get('redirect_uri')).toBe(application.redirectUri);
    expect(url.searchParams.get('state')).toBe('opaque-state');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.toString()).not.toContain(application.clientSecret);
    expect(url.searchParams.has('code_challenge')).toBe(false);
  });

  it('exchanges the code at /oauth/token/ as a form and keeps the open id as the subject', async () => {
    const { adapter, calls } = tiktok({ 'oauth/token/': [ok(TIKTOK.token())] });
    const bundle = await adapter.exchangeCode({
      code: 'test-code',
      codeVerifier: 'v',
      application,
    });
    expect(bundle).toEqual({
      accessToken: 'act.test-access-2',
      refreshToken: 'rft.test-refresh-2',
      expiresInSeconds: 86_400,
      grantedScopes: ['user.info.basic', 'video.publish'],
      subjectId: 'test-open-id-0001',
    });
    const sent = new URLSearchParams(String(calls[0]?.body));
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('client_key')).toBe(application.appId);
    expect(sent.get('redirect_uri')).toBe(application.redirectUri);
    expect(calls[0]?.url).not.toContain('test-code');
  });

  it('a refresh returns the NEW refresh token, so the rotated one is what gets stored', async () => {
    const { adapter, calls } = tiktok({ 'oauth/token/': [ok(TIKTOK.token('rft.rotated'))] });
    const bundle = await adapter.refreshToken({ refreshToken: 'rft.test-refresh-1', application });
    expect(bundle.refreshToken).toBe('rft.rotated');
    expect(new URLSearchParams(String(calls[0]?.body)).get('grant_type')).toBe('refresh_token');
  });

  it('a refresh that returns no refresh token keeps the one in hand (never stores null)', async () => {
    const { adapter } = tiktok({ 'oauth/token/': [ok(TIKTOK.token(null))] });
    const bundle = await adapter.refreshToken({ refreshToken: 'rft.test-refresh-1', application });
    expect(bundle.refreshToken).toBe('rft.test-refresh-1');
  });

  it('a refused refresh (invalid_grant) is a reconnection, and TikTok’s sentence goes nowhere', async () => {
    const { adapter } = tiktok({
      'oauth/token/': [{ status: 400, body: TIKTOK.oauthError('invalid_grant') }],
    });
    const error = await adapter
      .refreshToken({ refreshToken: 'rft.test-refresh-1', application })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TikTokApiError);
    expect(adapter.classifyError(error)).toBe('AUTH_REVOKED');
    expect(String((error as Error).message)).not.toContain('TikTok wrote');
  });

  it('the target is the one creator, read with the token in the header', async () => {
    const { adapter, calls } = tiktok({ 'user/info/': [ok(TIKTOK.user)] });
    const targets = await adapter.listTargets({ credentials });
    expect(targets).toEqual([
      {
        externalAccountId: 'test-open-id-0001',
        displayName: 'Test Bakery',
        avatarUrl: 'https://example.test/tiktok-avatar.jpg',
        targetKind: 'profile',
      },
    ]);
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${credentials.accessToken}`);
    expect(calls[0]?.url).not.toContain(credentials.accessToken);
  });

  it('revoking sends the token to /oauth/revoke/ with the client key and secret', async () => {
    const { adapter, calls } = tiktok({ 'oauth/revoke/': [ok(TIKTOK.revoked)] });
    await adapter.revoke({ credentials, application });
    const sent = new URLSearchParams(String(calls[0]?.body));
    expect(sent.get('token')).toBe(credentials.accessToken);
    expect(sent.get('client_key')).toBe(application.appId);
  });
});

describe('creator info — what the account may post now', () => {
  it('reads the nickname, the audiences, the locked interactions and the longest video', async () => {
    const { adapter } = tiktok({ 'post/publish/creator_info/query/': [ok(TIKTOK.creatorInfo())] });
    expect(await adapter.postingOptions({ credentials })).toEqual({
      nickname: 'Test Bakery',
      username: 'testbakery',
      avatarUrl: 'https://example.test/tiktok-avatar.jpg',
      privacyLevels: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
      commentDisabled: false,
      duetDisabled: false,
      stitchDisabled: true,
      maxVideoSeconds: 300,
      cannotPostReason: null,
    });
  });

  it('"cannot post now" is an answer the Studio shows, not an error', async () => {
    const { adapter } = tiktok({
      'post/publish/creator_info/query/': [
        { status: 403, body: TIKTOK.apiError('spam_risk_too_many_posts') },
      ],
    });
    const info = await adapter.postingOptions({ credentials });
    expect(info.cannotPostReason).toBe('spam_risk_too_many_posts');
    expect(info.privacyLevels).toEqual([]);
  });
});

describe('a video post — FILE_UPLOAD in chunks, then asked about, never resent', () => {
  it('asks creator info first, then sends the author’s choices and the chunk plan, then the bytes', async () => {
    const { adapter, calls } = tiktok({
      'post/publish/creator_info/query/': [ok(TIKTOK.creatorInfo())],
      'post/publish/video/init/': [ok(TIKTOK.videoInit)],
      upload: [{ status: 201, body: {} }],
    });
    const outcome = await adapter.publish({ request: request(), credentials });
    expect(outcome).toEqual({
      ok: 'pending',
      providerHandle: TIKTOK.videoInit.data.publish_id,
      providerStatusCode: 200,
    });
    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'PUT']);
    const init = json(calls[1]?.body);
    expect(init['post_info']).toEqual({
      title: 'Fresh bread today\n\n#bakery',
      privacy_level: 'PUBLIC_TO_EVERYONE',
      disable_comment: false,
      // Off by the author.
      disable_duet: true,
      // On by the author, but the creator turned Stitch off in TikTok.
      disable_stitch: true,
      brand_content_toggle: false,
      brand_organic_toggle: true,
    });
    expect(init['source_info']).toEqual({
      source: 'FILE_UPLOAD',
      video_size: 1_000,
      chunk_size: 1_000,
      total_chunk_count: 1,
    });
    expect(calls[2]?.url).toBe(TIKTOK.videoInit.data.upload_url);
    expect(calls[2]?.headers['content-range']).toBe('bytes 0-999/1000');
    expect(calls[2]?.headers['content-type']).toBe('video/mp4');
    expect(calls[2]?.headers['authorization']).toBeUndefined();
  });

  it('while the app is unaudited every post goes "Only me", whatever was chosen', async () => {
    const { adapter, calls } = tiktok(
      {
        'post/publish/creator_info/query/': [ok(TIKTOK.creatorInfo())],
        'post/publish/video/init/': [ok(TIKTOK.videoInit)],
        upload: [{ status: 201, body: {} }],
      },
      { forcedAudience: 'private' },
    );
    const outcome = await adapter.publish({
      request: request({ options: { ...chosen, privacyLevel: 'SELF_ONLY' } }),
      credentials,
    });
    expect(outcome.ok).toBe('pending');
    expect(json(calls[1]?.body)['post_info']?.['privacy_level']).toBe('SELF_ONLY');
  });

  it('no privacy level chosen: refused before any call (TikTok allows no default)', async () => {
    const { adapter, calls } = tiktok({});
    const outcome = await adapter.publish({
      request: request({ options: { ...chosen, privacyLevel: null } }),
      credentials,
    });
    expect(outcome).toMatchObject({ ok: false, failureCode: 'tiktok.privacy_level_missing' });
    expect(calls).toHaveLength(0);
  });

  it('a privacy level the account no longer offers is refused after creator info, before the init', async () => {
    const { adapter, calls } = tiktok({
      'post/publish/creator_info/query/': [
        ok(TIKTOK.creatorInfo({ privacy_level_options: ['FOLLOWER_OF_CREATOR', 'SELF_ONLY'] })),
      ],
    });
    const outcome = await adapter.publish({ request: request(), credentials });
    expect(outcome).toMatchObject({ ok: false, failureCode: 'tiktok.privacy_level_not_offered' });
    expect(calls).toHaveLength(1);
  });

  it('branded content cannot be "Only me"', async () => {
    const { adapter } = tiktok({});
    const outcome = await adapter.publish({
      request: request({
        options: {
          ...chosen,
          privacyLevel: 'SELF_ONLY',
          disclosure: { enabled: true, yourBrand: false, brandedContent: true },
        },
      }),
      credentials,
    });
    expect(outcome).toMatchObject({ ok: false, failureCode: 'tiktok.branded_content_private' });
  });

  it('a video longer than this creator may post is refused before the init', async () => {
    const { adapter, calls } = tiktok({
      'post/publish/creator_info/query/': [ok(TIKTOK.creatorInfo())],
    });
    const outcome = await adapter.publish({
      request: request({ media: [video(1_000, 301_000)] }),
      credentials,
    });
    expect(outcome).toMatchObject({ ok: false, failureCode: 'tiktok.video_too_long_for_creator' });
    expect(calls).toHaveLength(1);
  });

  it('a creator who cannot post now is refused as rate limited, with TikTok’s word', async () => {
    const { adapter } = tiktok({
      'post/publish/creator_info/query/': [
        { status: 403, body: TIKTOK.apiError('spam_risk_too_many_posts') },
      ],
    });
    const outcome = await adapter.publish({ request: request(), credentials });
    expect(outcome).toMatchObject({
      ok: false,
      failureClass: 'RATE_LIMITED',
      failureCode: 'tiktok.spam_risk_too_many_posts',
    });
  });

  it('a big file goes in 64 MB chunks, in order, the remainder riding on the last', async () => {
    const size = TIKTOK_MAX_CHUNK_BYTES * 2 + 123;
    const { adapter, calls } = tiktok({
      'post/publish/creator_info/query/': [ok(TIKTOK.creatorInfo())],
      'post/publish/video/init/': [ok(TIKTOK.videoInit)],
      upload: [
        { status: 206, body: {} },
        { status: 201, body: {} },
      ],
    });
    const outcome = await adapter.publish({
      request: request({ media: [video(size)] }),
      credentials,
    });
    expect(outcome.ok).toBe('pending');
    expect(json(calls[1]?.body)['source_info']).toMatchObject({
      video_size: size,
      chunk_size: TIKTOK_MAX_CHUNK_BYTES,
      total_chunk_count: 2,
    });
    expect(calls.slice(2).map((call) => call.headers['content-range'])).toEqual([
      `bytes 0-${TIKTOK_MAX_CHUNK_BYTES - 1}/${size}`,
      `bytes ${TIKTOK_MAX_CHUNK_BYTES}-${size - 1}/${size}`,
    ]);
  });

  it('an earlier chunk lost: nothing will publish, so it is a failure that may be tried again', async () => {
    const size = TIKTOK_MAX_CHUNK_BYTES * 2;
    const { adapter } = tiktok({
      'post/publish/creator_info/query/': [ok(TIKTOK.creatorInfo())],
      'post/publish/video/init/': [ok(TIKTOK.videoInit)],
      upload: ['network'],
    });
    const outcome = await adapter.publish({
      request: request({ media: [video(size)] }),
      credentials,
    });
    expect(outcome).toMatchObject({ ok: false, failureClass: 'TIMEOUT' });
  });

  it('the LAST chunk’s answer lost: the file may be complete, so it is asked about, not resent', async () => {
    const { adapter } = tiktok({
      'post/publish/creator_info/query/': [ok(TIKTOK.creatorInfo())],
      'post/publish/video/init/': [ok(TIKTOK.videoInit)],
      upload: ['network'],
    });
    const outcome = await adapter.publish({ request: request(), credentials });
    expect(outcome).toEqual({
      ok: 'pending',
      providerHandle: TIKTOK.videoInit.data.publish_id,
      providerStatusCode: 200,
    });
  });

  it('a first comment and a text post are refused before any call', async () => {
    const { adapter, calls } = tiktok({});
    expect(
      await adapter.publish({ request: request({ firstComment: 'hi' }), credentials }),
    ).toMatchObject({ ok: false, failureClass: 'UNSUPPORTED' });
    expect(
      await adapter.publish({ request: request({ postKind: 'text', media: [] }), credentials }),
    ).toMatchObject({ ok: false, failureCode: 'tiktok.text_unsupported' });
    expect(calls).toHaveLength(0);
  });
});

describe('a photo post — only by a pre-signed URL on a verified domain', () => {
  it('sends PULL_FROM_URL with the pipeline’s URLs and no Duet or Stitch', async () => {
    const { adapter, calls } = tiktok({
      'post/publish/creator_info/query/': [ok(TIKTOK.creatorInfo())],
      'post/publish/content/init/': [ok(TIKTOK.photoInit)],
    });
    const outcome = await adapter.publish({
      request: request({ postKind: 'carousel', media: [photo(1), photo(2)] }),
      credentials,
    });
    expect(outcome).toEqual({
      ok: 'pending',
      providerHandle: TIKTOK.photoInit.data.publish_id,
      providerStatusCode: 200,
    });
    const init = json(calls[1]?.body);
    expect(init['media_type']).toBe('PHOTO');
    expect(init['post_mode']).toBe('DIRECT_POST');
    expect(init['source_info']).toEqual({
      source: 'PULL_FROM_URL',
      photo_cover_index: 0,
      photo_images: [photo(1).fetchUrl, photo(2).fetchUrl],
    });
    expect(init['post_info']).not.toHaveProperty('disable_duet');
    expect(init['post_info']).not.toHaveProperty('disable_stitch');
  });

  it('without a pre-signed URL a photo post is refused before the init', async () => {
    const { adapter, calls } = tiktok({
      'post/publish/creator_info/query/': [ok(TIKTOK.creatorInfo())],
    });
    const outcome = await adapter.publish({
      request: request({ postKind: 'image', media: [photo(1, false)] }),
      credentials,
    });
    expect(outcome).toMatchObject({ ok: false, failureCode: 'tiktok.photo_needs_verified_url' });
    expect(calls).toHaveLength(1);
  });
});

describe('checkPublish — the status of a publish id', () => {
  const ask = (answer: unknown) => {
    const { adapter } = tiktok({ 'post/publish/status/fetch/': [ok(answer)] });
    return adapter.checkPublish({
      providerHandle: 'v_pub_file~v2-1.7000000000000000001',
      externalAccountId: 'test-open-id-0001',
      credentials,
    });
  };

  it('still processing is still pending', async () => {
    expect(await ask(TIKTOK.status('PROCESSING_UPLOAD'))).toMatchObject({ ok: 'pending' });
    expect(await ask(TIKTOK.status('PROCESSING_DOWNLOAD'))).toMatchObject({ ok: 'pending' });
  });

  it('complete with a public id is the post', async () => {
    expect(
      await ask(
        TIKTOK.status('PUBLISH_COMPLETE', { publicaly_available_post_id: [7300000000000001] }),
      ),
    ).toEqual({
      ok: true,
      externalPostId: '7300000000000001',
      externalPostUrl: null,
      providerStatusCode: 200,
    });
  });

  it('complete and private (no public id): the publish id stands for it', async () => {
    expect(await ask(TIKTOK.status('PUBLISH_COMPLETE'))).toMatchObject({
      ok: true,
      externalPostId: 'v_pub_file~v2-1.7000000000000000001',
    });
  });

  it('failed carries TikTok’s reason word as the code and its class', async () => {
    expect(
      await ask(TIKTOK.status('FAILED', { fail_reason: 'duration_check_failed' })),
    ).toMatchObject({
      ok: false,
      failureClass: 'MEDIA_INVALID',
      failureCode: 'tiktok.duration_check_failed',
    });
  });
});

describe('error classes', () => {
  it.each([
    ['access_token_invalid', 401, 'AUTH_EXPIRED'],
    ['invalid_grant', 400, 'AUTH_REVOKED'],
    ['scope_not_authorized', 401, 'INSUFFICIENT_SCOPE'],
    ['rate_limit_exceeded', 429, 'RATE_LIMITED'],
    ['spam_risk_too_many_posts', 403, 'RATE_LIMITED'],
    ['spam_risk_user_banned_from_posting', 403, 'TARGET_UNAVAILABLE'],
    ['privacy_level_option_mismatch', 400, 'CONTENT_REJECTED'],
    ['unaudited_client_can_only_post_to_private_accounts', 403, 'CONTENT_REJECTED'],
    ['url_ownership_unverified', 403, 'MEDIA_INVALID'],
    ['internal_error', 500, 'PLATFORM_UNAVAILABLE'],
    ['something_new', 400, 'UNKNOWN'],
  ] as const)('%s → %s', (code, status, expected) => {
    expect(classifyTikTokError(new TikTokApiError({ status, code }))).toBe(expected);
  });

  it('no answer is a timeout; anything not TikTok’s is unknown', () => {
    expect(classifyTikTokError(new TikTokTransportError())).toBe('TIMEOUT');
    expect(classifyTikTokError(new Error('x'))).toBe('UNKNOWN');
  });
});

describe('the chunk plan', () => {
  it('one chunk up to 64 MB, then 64 MB chunks with the remainder in the last', () => {
    expect(chunkPlan(4_000_000)).toEqual({
      chunkSize: 4_000_000,
      totalChunkCount: 1,
      ranges: [[0, 4_000_000]],
    });
    expect(chunkPlan(TIKTOK_MAX_CHUNK_BYTES)).toMatchObject({ totalChunkCount: 1 });
    const plan = chunkPlan(TIKTOK_MAX_CHUNK_BYTES * 3 + 5);
    expect(plan.totalChunkCount).toBe(3);
    expect(plan.ranges.at(-1)).toEqual([
      TIKTOK_MAX_CHUNK_BYTES * 2,
      TIKTOK_MAX_CHUNK_BYTES * 3 + 5,
    ]);
    // The last chunk stays within TikTok's 128 MB ceiling.
    for (const [first, end] of plan.ranges) expect(end - first).toBeLessThanOrEqual(128_000_000);
  });
});

describe('the registry', () => {
  it('answers TikTok with the real adapter in STAGING when apiVersion is set, the mock in DEVELOPMENT', () => {
    const configured = policy();
    expect(
      createConnectorRegistry({ policy: configured, environment: 'STAGING' }).get('TIKTOK'),
    ).toBeInstanceOf(TikTokAccountAdapter);
    expect(
      createConnectorRegistry({ policy: configured, environment: 'DEVELOPMENT' }).get('TIKTOK'),
    ).toBeInstanceOf(MockSocialConnectorAdapter);
  });

  it('without apiVersion TikTok is not connectable outside development', () => {
    const registry = createConnectorRegistry({
      policy: policy({ apiVersion: null }),
      environment: 'PRODUCTION',
    });
    expect(registry.enabledProviders()).not.toContain('TIKTOK');
  });
});
