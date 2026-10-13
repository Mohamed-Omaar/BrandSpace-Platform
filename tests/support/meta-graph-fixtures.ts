/**
 * CONNECTORS B — RECORDED META GRAPH ANSWERS, for the adapter contract tests.
 *
 * Each body has the shape Meta documents for that call (the page cited beside
 * it). The ids and tokens are invented and obviously fake. Nothing here was
 * fetched from Meta: this repository never calls a real platform in a test,
 * and the first real call is the owner's, on staging (D-533).
 */

export const META = {
  // facebook-login/guides/advanced/manual-flow — code → short-lived token
  shortToken: { access_token: 'EAAtestShortLived', token_type: 'bearer', expires_in: 5_183 },
  // facebook-login/guides/access-tokens/get-long-lived — the exchange
  longToken: { access_token: 'EAAtestLongLived', token_type: 'bearer', expires_in: 5_183_944 },
  // graph-api/reference/user — the app-scoped user id
  me: { id: '10229999000000001' },
  // graph-api/reference/user/permissions
  permissions: {
    data: [
      { permission: 'pages_show_list', status: 'granted' },
      { permission: 'pages_manage_posts', status: 'granted' },
      { permission: 'pages_read_engagement', status: 'granted' },
      { permission: 'instagram_basic', status: 'granted' },
      { permission: 'instagram_content_publish', status: 'declined' },
    ],
  },
  // pages-api/getting-started — the Pages a person granted, page 1 of 2
  accountsPage1: {
    data: [
      {
        id: '111000000000001',
        name: 'Test Bakery',
        picture: { data: { url: 'https://example.test/bakery.png' } },
        instagram_business_account: {
          id: '17841400000000001',
          username: 'testbakery',
          profile_picture_url: 'https://example.test/ig-bakery.png',
        },
      },
    ],
    paging: {
      cursors: { before: 'QVFIUBEFORE', after: 'QVFIUAFTER1' },
      next: 'https://graph.facebook.com/next',
    },
  },
  accountsPage2: {
    data: [{ id: '111000000000002', name: 'Test Florist', picture: { data: { url: null } } }],
    paging: { cursors: { before: 'QVFIUBEFORE2', after: 'QVFIUAFTER2' } },
  },
  // pages-api — a Page's own token, from a long-lived user token
  pageToken: { access_token: 'EAAtestPageToken', id: '111000000000001' },
  // pages-api/posts — a feed post
  feedPost: { id: '111000000000001_222000000000001' },
  // graph-api/reference/page/photos — one published photo
  photoPost: { id: '333000000000001', post_id: '111000000000001_222000000000002' },
  unpublishedPhoto: (n: number) => ({ id: `33300000000010${n}` }),
  // instagram-graph-api/content-publishing — a container
  container: { id: '17890000000000001' },
  carouselChild: (n: number) => ({ id: `1789000000000010${n}` }),
  // reference/ig-container — status_code
  containerStatus: (status: string) => ({ status_code: status, id: '17890000000000001' }),
  // reference/ig-user/media_publish
  published: { id: '17920000000000001' },
  // reference/ig-media
  media: {
    id: '17920000000000001',
    permalink: 'https://www.instagram.com/p/TESTONLY/',
    caption: 'Fresh bread today\n\n#bakery',
  },
  // reference/ig-user/content_publishing_limit
  publishingLimit: (usage: number, total = 50) => ({
    data: [{ quota_usage: usage, config: { quota_total: total, quota_duration: 86_400 } }],
  }),
  // graph-api/guides/error-handling
  error: (code: number, subcode?: number, transient = false) => ({
    error: {
      message: 'A message Meta wrote, which must never reach a customer or a log.',
      type: 'OAuthException',
      code,
      ...(subcode === undefined ? {} : { error_subcode: subcode }),
      is_transient: transient,
      fbtrace_id: 'AtestTraceId',
    },
  }),
} as const;

export interface RecordedCall {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly form: URLSearchParams | null;
}

/**
 * A fake Graph transport: answers by `METHOD path` (version stripped), in
 * order when one route is asked several times, and records every call.
 */
export function recordedGraph(
  routes: Record<string, { status?: number; body: unknown } | { status?: number; body: unknown }[]>,
) {
  const calls: RecordedCall[] = [];
  const queues = new Map(
    Object.entries(routes).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : [value],
    ]),
  );
  const fetch = async (
    url: string,
    init: { method: string; headers: Readonly<Record<string, string>>; body?: string },
  ) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/v[0-9.]+\//, '');
    const key = `${init.method} ${path}`;
    calls.push({
      method: init.method,
      url: parsed,
      headers: init.headers,
      form: init.body === undefined ? null : new URLSearchParams(init.body),
    });
    const queue = queues.get(key);
    const answer = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (!answer) return { status: 404, text: async () => JSON.stringify(META.error(803)) };
    return { status: answer.status ?? 200, text: async () => JSON.stringify(answer.body) };
  };
  return { fetch, calls };
}
