import type { TikTokFetch } from '@brandspace/social-connectors';

/**
 * CONNECTORS C — RECORDED TIKTOK ANSWERS, for the adapter contract tests.
 *
 * Each body has the shape TikTok documents for that call (the page cited
 * beside it). The ids and tokens are invented and obviously fake. Nothing here
 * was fetched from TikTok: the suite never calls a real platform, and the first
 * real call is the owner's, on staging, in TikTok's sandbox.
 */

export const TIKTOK = {
  // doc/oauth-user-access-token-management — code or refresh → tokens
  token: (refresh: string | null = 'rft.test-refresh-2') => ({
    access_token: 'act.test-access-2',
    expires_in: 86_400,
    open_id: 'test-open-id-0001',
    refresh_expires_in: 31_536_000,
    ...(refresh === null ? {} : { refresh_token: refresh }),
    scope: 'user.info.basic,video.publish',
    token_type: 'Bearer',
  }),
  // same page — an OAuth error is top level
  oauthError: (code: string) => ({
    error: code,
    error_description: 'A sentence TikTok wrote, which must never reach a customer or a log.',
    log_id: 'test-log-id',
  }),
  // doc/tiktok-api-v2-get-user-info — the creator
  user: {
    data: {
      user: {
        open_id: 'test-open-id-0001',
        display_name: 'Test Bakery',
        avatar_url: 'https://example.test/tiktok-avatar.jpg',
      },
    },
    error: { code: 'ok', message: '', log_id: 'test-log-id' },
  },
  // doc/content-posting-api-reference-query-creator-info
  creatorInfo: (overrides: Record<string, unknown> = {}) => ({
    data: {
      creator_avatar_url: 'https://example.test/tiktok-avatar.jpg',
      creator_username: 'testbakery',
      creator_nickname: 'Test Bakery',
      privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
      comment_disabled: false,
      duet_disabled: false,
      stitch_disabled: true,
      max_video_post_duration_sec: 300,
      ...overrides,
    },
    error: { code: 'ok', message: '', log_id: 'test-log-id' },
  }),
  // doc/content-posting-api-reference-direct-post — video init
  videoInit: {
    data: {
      publish_id: 'v_pub_file~v2-1.7000000000000000001',
      upload_url:
        'https://open-upload.tiktokapis.com/video/?upload_id=7000000000001&upload_token=test-only',
    },
    error: { code: 'ok', message: '', log_id: 'test-log-id' },
  },
  // doc/content-posting-api-reference-photo-post — photo init
  photoInit: {
    data: { publish_id: 'p_pub_url~v2.7000000000000000002' },
    error: { code: 'ok', message: '', log_id: 'test-log-id' },
  },
  // docs/en/content-posting-api-reference-get-video-status
  status: (status: string, extra: Record<string, unknown> = {}) => ({
    data: { status, ...extra },
    error: { code: 'ok', message: '', log_id: 'test-log-id' },
  }),
  // a content or user endpoint's error
  apiError: (code: string) => ({
    data: {},
    error: {
      code,
      message: 'A sentence TikTok wrote, which must never reach a customer or a log.',
      log_id: 'test-log-id',
    },
  }),
  revoked: {},
};

export interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** JSON or form bodies as text; uploads as their byte length. */
  readonly body: string | number | undefined;
}

type Answer = { status: number; body: unknown } | 'network';

/**
 * A transport that answers by path (the part after `/v2/`, or `upload` for the
 * upload URL) from a queue per path, and records every call.
 */
export function recordedTikTok(routes: Record<string, Answer[]>): {
  fetch: TikTokFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queues = new Map(Object.entries(routes).map(([key, list]) => [key, [...list]]));
  const fetch: TikTokFetch = async (url, init) => {
    const parsed = new URL(url);
    const key = parsed.hostname.startsWith('open-upload')
      ? 'upload'
      : parsed.pathname.replace(/^\/v2\//, '');
    calls.push({
      method: init.method,
      url,
      headers: init.headers,
      body: init.body instanceof Uint8Array ? init.body.byteLength : init.body,
    });
    const queue = queues.get(key);
    const next = queue?.shift();
    if (!next) throw new Error(`no recorded answer for ${init.method} ${key}`);
    if (next === 'network') throw new Error('socket hang up');
    return { status: next.status, text: async () => JSON.stringify(next.body) };
  };
  return { fetch, calls };
}

export const ok = (body: unknown) => ({ status: 200, body });
