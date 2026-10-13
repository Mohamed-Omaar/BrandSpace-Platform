import { describe, expect, it } from 'vitest';
import {
  classifyMetaError,
  createConnectorRegistry,
  FacebookPageAdapter,
  InstagramAccountAdapter,
  MetaGraphError,
  MetaTransportError,
  MockSocialConnectorAdapter,
  parsePublishingPolicy,
  type PublishingPolicy,
  type PublishRequest,
} from '@brandspace/social-connectors';
import { META, recordedGraph } from '../support/meta-graph-fixtures';

/**
 * CONNECTORS B — THE META ADAPTERS AGAINST RECORDED GRAPH ANSWERS (D-533).
 *
 * Every call goes through an injected transport that answers with the shapes
 * Meta documents (`tests/support/meta-graph-fixtures.ts`) and records what was
 * sent, so each test can say both what the adapter did with an answer and
 * exactly what it asked Meta. Nothing reaches the network.
 */

const VERSION = 'v26.0';

function policy(overrides: Record<string, unknown> = {}): PublishingPolicy {
  const meta = {
    enabled: true,
    postKinds: ['text', 'image', 'carousel', 'reel'],
    scopes: ['pages_show_list', 'pages_manage_posts'],
    mediaByUrl: true,
    apiVersion: VERSION,
    ...overrides,
  };
  return parsePublishingPolicy({ providers: { facebook: meta, instagram: meta } });
}

const application = {
  appId: '900000000000001',
  clientSecret: 'test-only-app-secret',
  redirectUri: 'https://api.example.test/v1/social/callback/facebook',
};

const credentials = { accessToken: 'EAAtestPageToken', refreshToken: null };

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    externalAccountId: '111000000000001',
    body: 'Fresh bread today',
    hashtags: ['bakery'],
    firstComment: null,
    media: [],
    idempotencyKey: 'job-1',
    postKind: 'text',
    linkUrl: null,
    options: {},
    ...overrides,
  };
}

const image = (n: number, mimeType = 'image/jpeg') => ({
  assetId: `asset-${n}`,
  mimeType,
  sizeBytes: 1_000,
  width: 1_080,
  height: 1_080,
  fileName: `photo-${n}.jpg`,
  bytes: new Uint8Array(),
  fetchUrl: `https://media.example.test/signed/${n}?X-Amz-Signature=test`,
});

const facebook = (routes: Parameters<typeof recordedGraph>[0], overrides = {}) => {
  const graph = recordedGraph(routes);
  const adapter = new FacebookPageAdapter(policy(overrides).providers.facebook, {
    fetch: graph.fetch,
  });
  return { adapter, calls: graph.calls };
};

const instagram = (routes: Parameters<typeof recordedGraph>[0], overrides = {}) => {
  const graph = recordedGraph(routes);
  const adapter = new InstagramAccountAdapter(policy(overrides).providers.instagram, {
    fetch: graph.fetch,
  });
  return { adapter, calls: graph.calls };
};

describe('Meta login — the dialog, the exchange, the person', () => {
  it('the dialog URL carries the configured version, the app id, the redirect, PKCE and state — never the secret', () => {
    const { adapter } = facebook({});
    const url = new URL(
      adapter.buildAuthorizationUrl({
        state: 'state-1',
        codeChallenge: 'challenge-1',
        scopes: ['pages_show_list', 'pages_manage_posts'],
        application,
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(`https://www.facebook.com/${VERSION}/dialog/oauth`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: application.appId,
      redirect_uri: application.redirectUri,
      response_type: 'code',
      state: 'state-1',
      scope: 'pages_show_list,pages_manage_posts',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
    });
    expect(url.toString()).not.toContain(application.clientSecret);
  });

  it('with a Facebook Login for Business configuration, config_id replaces scope', () => {
    const { adapter } = facebook({});
    const url = new URL(
      adapter.buildAuthorizationUrl({
        state: 's',
        codeChallenge: 'c',
        scopes: ['pages_show_list'],
        application: { ...application, settings: { loginConfigId: '555000000000001' } },
      }),
    );
    expect(url.searchParams.get('config_id')).toBe('555000000000001');
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it('code → short-lived → long-lived token; the person and what they actually granted', async () => {
    const { adapter, calls } = facebook({
      'GET oauth/access_token': [{ body: META.shortToken }, { body: META.longToken }],
      'GET me': { body: META.me },
      'GET me/permissions': { body: META.permissions },
    });
    const bundle = await adapter.exchangeCode({
      code: 'code-1',
      codeVerifier: 'verifier-1',
      application,
    });
    expect(bundle).toEqual({
      accessToken: META.longToken.access_token,
      refreshToken: null,
      expiresInSeconds: META.longToken.expires_in,
      grantedScopes: [
        'pages_show_list',
        'pages_manage_posts',
        'pages_read_engagement',
        'instagram_basic',
      ],
      subjectId: META.me.id,
    });
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      `GET /${VERSION}/oauth/access_token`,
      `GET /${VERSION}/oauth/access_token`,
      `GET /${VERSION}/me`,
      `GET /${VERSION}/me/permissions`,
    ]);
    expect(calls[0]!.url.searchParams.get('code_verifier')).toBe('verifier-1');
    expect(calls[1]!.url.searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(calls[1]!.url.searchParams.get('fb_exchange_token')).toBe(META.shortToken.access_token);
    // After the documented token endpoint, the token travels in a header only.
    for (const call of calls.slice(2)) {
      expect(call.url.toString()).not.toContain('EAA');
      expect(call.headers['authorization']).toBe(`Bearer ${META.longToken.access_token}`);
    }
  });

  it('a refused code is an error with Meta’s numbers and none of Meta’s words', async () => {
    const { adapter } = facebook({
      'GET oauth/access_token': { status: 400, body: META.error(100, 36_007) },
    });
    const thrown = await adapter
      .exchangeCode({ code: 'bad', codeVerifier: 'v', application })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(MetaGraphError);
    expect(String((thrown as Error).message)).not.toContain('A message Meta wrote');
    expect(String((thrown as Error).message)).toContain('code 100');
  });

  it('no refresh token, and a disconnect never removes the whole Meta grant', async () => {
    const { adapter, calls } = facebook({});
    await expect(adapter.refreshToken()).rejects.toThrow();
    await expect(adapter.revoke()).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('Facebook Pages', () => {
  it('lists every granted Page across Meta’s cursor', async () => {
    const { adapter, calls } = facebook({
      'GET me/accounts': [{ body: META.accountsPage1 }, { body: META.accountsPage2 }],
    });
    const targets = await adapter.listTargets({ credentials });
    expect(targets).toEqual([
      {
        externalAccountId: '111000000000001',
        displayName: 'Test Bakery',
        avatarUrl: 'https://example.test/bakery.png',
        targetKind: 'page',
      },
      {
        externalAccountId: '111000000000002',
        displayName: 'Test Florist',
        avatarUrl: null,
        targetKind: 'page',
      },
    ]);
    expect(calls[1]!.url.searchParams.get('after')).toBe('QVFIUAFTER1');
  });

  it('binds the chosen Page to its own token, which does not expire', async () => {
    const { adapter, calls } = facebook({ 'GET 111000000000001': { body: META.pageToken } });
    const bound = await adapter.bindTarget({
      credentials: { accessToken: 'EAAtestLongLived', refreshToken: null },
      externalAccountId: '111000000000001',
    });
    expect(bound).toEqual({ accessToken: META.pageToken.access_token, expiresInSeconds: null });
    expect(calls[0]!.url.searchParams.get('fields')).toBe('access_token');
  });

  it('a text post goes to the feed, with the hashtags and the link', async () => {
    const { adapter, calls } = facebook({ 'POST 111000000000001/feed': { body: META.feedPost } });
    const outcome = await adapter.publish({
      request: request({ linkUrl: 'https://bakery.example.test/' }),
      credentials,
    });
    expect(outcome).toEqual({
      ok: true,
      externalPostId: META.feedPost.id,
      externalPostUrl: `https://www.facebook.com/${META.feedPost.id}`,
      providerStatusCode: 200,
    });
    expect(Object.fromEntries(calls[0]!.form!)).toEqual({
      message: 'Fresh bread today\n\n#bakery',
      link: 'https://bakery.example.test/',
    });
  });

  it('one photo is published from its pre-signed URL; the post id is the feed story', async () => {
    const { adapter, calls } = facebook({
      'POST 111000000000001/photos': { body: META.photoPost },
    });
    const outcome = await adapter.publish({
      request: request({ postKind: 'image', media: [image(1)] }),
      credentials,
    });
    expect(outcome).toMatchObject({ ok: true, externalPostId: META.photoPost.post_id });
    expect(calls[0]!.form!.get('url')).toBe(image(1).fetchUrl);
    expect(calls[0]!.form!.get('caption')).toBe('Fresh bread today\n\n#bakery');
  });

  it('several photos are uploaded unpublished, then attached to one post', async () => {
    const { adapter, calls } = facebook({
      'POST 111000000000001/photos': [
        { body: META.unpublishedPhoto(1) },
        { body: META.unpublishedPhoto(2) },
      ],
      'POST 111000000000001/feed': { body: META.feedPost },
    });
    const outcome = await adapter.publish({
      request: request({ postKind: 'carousel', media: [image(1), image(2)] }),
      credentials,
    });
    expect(outcome).toMatchObject({ ok: true, externalPostId: META.feedPost.id });
    expect(calls.map((call) => call.form!.get('published'))).toEqual(['false', 'false', null]);
    expect(calls[2]!.form!.get('attached_media[1]')).toBe(
      JSON.stringify({ media_fbid: META.unpublishedPhoto(2).id }),
    );
  });

  it('refuses before any call what it cannot publish: video, a first comment, media without a URL', async () => {
    const { adapter, calls } = facebook({});
    expect(
      await adapter.publish({
        request: request({ postKind: 'reel', media: [image(1, 'video/mp4')] }),
        credentials,
      }),
    ).toMatchObject({ ok: false, failureClass: 'UNSUPPORTED' });
    expect(
      await adapter.publish({ request: request({ firstComment: 'First!' }), credentials }),
    ).toMatchObject({ ok: false, failureClass: 'UNSUPPORTED' });
    expect(
      await adapter.publish({
        request: request({
          postKind: 'image',
          media: [{ ...image(1), fetchUrl: undefined }] as never,
        }),
        credentials,
      }),
    ).toMatchObject({ ok: false, failureClass: 'MEDIA_INVALID' });
    expect(calls).toEqual([]);
  });

  it('a refused post is a failure in our words, with Meta’s code kept for support', async () => {
    const { adapter } = facebook({
      'POST 111000000000001/feed': { status: 400, body: META.error(368) },
    });
    const outcome = await adapter.publish({ request: request(), credentials });
    expect(outcome).toEqual({
      ok: false,
      failureClass: 'CONTENT_REJECTED',
      failureCode: 'meta.368',
      providerStatusCode: 400,
      providerErrorCode: '368',
      safeSummary: 'Meta rejected this post.',
    });
  });
});

describe('Instagram — container, then publish', () => {
  const igRequest = (overrides: Partial<PublishRequest> = {}) =>
    request({
      externalAccountId: '17841400000000001',
      postKind: 'image',
      media: [image(1)],
      ...overrides,
    });

  it('lists only Pages with a linked Instagram professional account', async () => {
    const { adapter } = instagram({
      'GET me/accounts': [{ body: META.accountsPage1 }, { body: META.accountsPage2 }],
    });
    expect(await adapter.listTargets({ credentials })).toEqual([
      {
        externalAccountId: '17841400000000001',
        displayName: 'testbakery',
        avatarUrl: 'https://example.test/ig-bakery.png',
        targetKind: 'business_account',
      },
    ]);
  });

  it('publish creates a container and answers pending with its id — nothing is public yet', async () => {
    const { adapter, calls } = instagram({
      'POST 17841400000000001/media': { body: META.container },
    });
    const outcome = await adapter.publish({ request: igRequest(), credentials });
    expect(outcome).toEqual({
      ok: 'pending',
      providerHandle: META.container.id,
      providerStatusCode: 200,
    });
    expect(Object.fromEntries(calls[0]!.form!)).toEqual({
      image_url: image(1).fetchUrl,
      caption: 'Fresh bread today\n\n#bakery',
    });
    expect(calls.some((call) => call.url.pathname.endsWith('media_publish'))).toBe(false);
  });

  it('a reel is a REELS container from the video’s URL', async () => {
    const { adapter, calls } = instagram({
      'POST 17841400000000001/media': { body: META.container },
    });
    await adapter.publish({
      request: igRequest({ postKind: 'reel', media: [image(1, 'video/mp4')] }),
      credentials,
    });
    expect(calls[0]!.form!.get('media_type')).toBe('REELS');
    expect(calls[0]!.form!.get('video_url')).toBe(image(1).fetchUrl);
  });

  it('a carousel creates each child, then the parent naming them', async () => {
    const { adapter, calls } = instagram({
      'POST 17841400000000001/media': [
        { body: META.carouselChild(1) },
        { body: META.carouselChild(2) },
        { body: META.container },
      ],
    });
    const outcome = await adapter.publish({
      request: igRequest({ postKind: 'carousel', media: [image(1), image(2)] }),
      credentials,
    });
    expect(outcome).toMatchObject({ ok: 'pending', providerHandle: META.container.id });
    expect(calls[0]!.form!.get('is_carousel_item')).toBe('true');
    expect(calls[2]!.form!.get('media_type')).toBe('CAROUSEL');
    expect(calls[2]!.form!.get('children')).toBe(
      `${META.carouselChild(1).id},${META.carouselChild(2).id}`,
    );
  });

  it('checkPublish: IN_PROGRESS waits; FINISHED is made public once, with its permalink', async () => {
    const waiting = instagram({
      'GET 17890000000000001': { body: META.containerStatus('IN_PROGRESS') },
    });
    expect(
      await waiting.adapter.checkPublish({
        providerHandle: META.container.id,
        externalAccountId: '17841400000000001',
        credentials,
      }),
    ).toEqual({ ok: 'pending', providerHandle: META.container.id, providerStatusCode: 200 });
    expect(waiting.calls).toHaveLength(1);

    const ready = instagram({
      'GET 17890000000000001': { body: META.containerStatus('FINISHED') },
      'POST 17841400000000001/media_publish': { body: META.published },
      'GET 17920000000000001': { body: META.media },
    });
    expect(
      await ready.adapter.checkPublish({
        providerHandle: META.container.id,
        externalAccountId: '17841400000000001',
        credentials,
      }),
    ).toEqual({
      ok: true,
      externalPostId: META.published.id,
      externalPostUrl: META.media.permalink,
      providerStatusCode: 200,
      observed: { caption: META.media.caption },
    });
    const publishCalls = ready.calls.filter((call) => call.url.pathname.endsWith('media_publish'));
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]!.form!.get('creation_id')).toBe(META.container.id);
  });

  it('checkPublish: ERROR, EXPIRED and an already-PUBLISHED container are never resent', async () => {
    const answer = async (status: string) => {
      const { adapter, calls } = instagram({
        'GET 17890000000000001': { body: META.containerStatus(status) },
      });
      const outcome = await adapter.checkPublish({
        providerHandle: META.container.id,
        externalAccountId: '17841400000000001',
        credentials,
      });
      expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
      return outcome;
    };
    expect(await answer('ERROR')).toMatchObject({ ok: false, failureClass: 'MEDIA_INVALID' });
    expect(await answer('EXPIRED')).toMatchObject({
      ok: false,
      failureCode: 'meta.container_expired',
    });
    // Indeterminate: the pipeline leaves it for verification, never resends.
    expect(await answer('PUBLISHED')).toMatchObject({
      ok: false,
      failureClass: 'DUPLICATE_CONTENT',
    });
  });
});

describe('Instagram — dailyPublishCap, checked against Instagram’s own count', () => {
  const ask = { externalAccountId: '17841400000000001', credentials };

  it('at the cap, a new post creates no container and waits to retry', async () => {
    const { adapter, calls } = instagram(
      { 'GET 17841400000000001/content_publishing_limit': { body: META.publishingLimit(25) } },
      { dailyPublishCap: 25 },
    );
    const outcome = await adapter.publish({
      request: request({ ...ask, postKind: 'image', media: [image(1)] }),
      credentials,
    });
    expect(outcome).toMatchObject({
      ok: false,
      failureClass: 'RATE_LIMITED',
      failureCode: 'meta.instagram_daily_cap',
    });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      `/${VERSION}/17841400000000001/content_publishing_limit`,
    ]);
  });

  it('a finished container over the cap is not made public; it waits', async () => {
    const { adapter, calls } = instagram(
      {
        'GET 17890000000000001': { body: META.containerStatus('FINISHED') },
        'GET 17841400000000001/content_publishing_limit': { body: META.publishingLimit(30) },
      },
      { dailyPublishCap: 30 },
    );
    expect(await adapter.checkPublish({ providerHandle: META.container.id, ...ask })).toMatchObject(
      { ok: 'pending' },
    );
    expect(calls.some((call) => call.url.pathname.endsWith('media_publish'))).toBe(false);
  });

  it('Instagram’s own lower total wins over ours', async () => {
    const { adapter } = instagram(
      { 'GET 17841400000000001/content_publishing_limit': { body: META.publishingLimit(10, 10) } },
      { dailyPublishCap: 50 },
    );
    expect(
      await adapter.publish({
        request: request({ ...ask, postKind: 'image', media: [image(1)] }),
        credentials,
      }),
    ).toMatchObject({ ok: false, failureClass: 'RATE_LIMITED' });
  });

  it('under the cap the container is created; with no cap the count is not asked', async () => {
    const under = instagram(
      {
        'GET 17841400000000001/content_publishing_limit': { body: META.publishingLimit(3) },
        'POST 17841400000000001/media': { body: META.container },
      },
      { dailyPublishCap: 25 },
    );
    expect(
      await under.adapter.publish({
        request: request({ ...ask, postKind: 'image', media: [image(1)] }),
        credentials,
      }),
    ).toMatchObject({ ok: 'pending' });

    const uncapped = instagram({ 'POST 17841400000000001/media': { body: META.container } });
    await uncapped.adapter.publish({
      request: request({ ...ask, postKind: 'image', media: [image(1)] }),
      credentials,
    });
    expect(uncapped.calls.map((call) => call.url.pathname)).toEqual([
      `/${VERSION}/17841400000000001/media`,
    ]);
  });
});

describe('Meta error numbers → failure classes', () => {
  const graphError = (
    code: number,
    subcode: number | null = null,
    status = 400,
    transient = false,
  ) => new MetaGraphError({ status, code, subcode, transient });

  it.each([
    [graphError(190, 463), 'AUTH_REVOKED'],
    [graphError(190), 'AUTH_REVOKED'],
    [graphError(10), 'INSUFFICIENT_SCOPE'],
    [graphError(200), 'INSUFFICIENT_SCOPE'],
    [graphError(4), 'RATE_LIMITED'],
    [graphError(32), 'RATE_LIMITED'],
    [graphError(80_001), 'RATE_LIMITED'],
    [graphError(9, 2_207_042), 'RATE_LIMITED'],
    [graphError(506), 'DUPLICATE_CONTENT'],
    [graphError(368), 'CONTENT_REJECTED'],
    [graphError(100, 2_207_026), 'MEDIA_INVALID'],
    [graphError(100, 33), 'TARGET_UNAVAILABLE'],
    [graphError(2, null, 500), 'PLATFORM_UNAVAILABLE'],
    [graphError(100, null, 400, true), 'PLATFORM_UNAVAILABLE'],
    [graphError(100), 'UNKNOWN'],
    [new MetaTransportError(), 'TIMEOUT'],
    [new Error('anything else'), 'UNKNOWN'],
  ] as const)('%s → %s', (error, expected) => {
    expect(classifyMetaError(error)).toBe(expected);
  });
});

describe('which adapter answers', () => {
  it('DEVELOPMENT keeps the deterministic mock; STAGING and PRODUCTION use Meta’s adapters', () => {
    const configured = policy();
    expect(
      createConnectorRegistry({ policy: configured, environment: 'DEVELOPMENT' }).get('FACEBOOK'),
    ).toBeInstanceOf(MockSocialConnectorAdapter);
    for (const environment of ['STAGING', 'PRODUCTION'] as const) {
      const registry = createConnectorRegistry({ policy: configured, environment });
      expect(registry.get('FACEBOOK')).toBeInstanceOf(FacebookPageAdapter);
      expect(registry.get('INSTAGRAM')).toBeInstanceOf(InstagramAccountAdapter);
    }
  });

  it('without a Graph API version, Meta cannot be connected in production', () => {
    const registry = createConnectorRegistry({
      policy: policy({ apiVersion: null }),
      environment: 'PRODUCTION',
    });
    expect(() => registry.get('FACEBOOK')).toThrow();
    expect(registry.enabledProviders()).toEqual([]);
  });

  it('the version is configuration: only `vN` or `vN.N` is accepted', () => {
    expect(policy({ apiVersion: 'v26.0' }).providers.facebook.apiVersion).toBe('v26.0');
    expect(() => policy({ apiVersion: '26.0' })).toThrow();
    expect(() => policy({ apiVersion: 'v26.0/../me' })).toThrow();
    expect(parsePublishingPolicy({}).providers.facebook.apiVersion).toBeNull();
    expect(parsePublishingPolicy({}).providers.instagram.dailyPublishCap).toBeNull();
  });
});
