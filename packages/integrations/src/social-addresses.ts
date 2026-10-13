/**
 * CONNECTORS A — THE ADDRESSES THE OWNER REGISTERS WITH EACH PLATFORM.
 *
 * Every one is ours: it is where our own route lives, built from the API's
 * public base URL (`PUBLIC_API_BASE_URL`, per environment) and never typed by
 * hand. The OAuth callback exists today; the webhook, deauthorize and
 * data-deletion routes are built in step B, and their addresses are shown now
 * so the platform apps can be prepared (owner, schema approval of step A).
 *
 * ONE META APP (D-505 O2/O3): Facebook and Instagram share it, so Instagram
 * lists only its own redirect and points at Facebook's for the rest — one app
 * has one deauthorize URL, one data-deletion URL and one webhook.
 *
 * NO VENDOR ENTRY IS CREATED HERE. The Hub lists a provider only when an
 * adapter for it exists; these are addresses, and the vendor entries arrive
 * with their adapters (steps B and C).
 */

/**
 * The API's public base URL as the RUNNING ENVIRONMENT states it
 * (`PUBLIC_API_BASE_URL`), or null. Never a written-down domain: on staging it
 * is the API service's own address (a custom domain if one is attached, the
 * host's generated one otherwise). The local fallback is for development only
 * (`APP_ENV` unset or `development`); anywhere else a missing value is null,
 * so a screen says so instead of showing an address that would not work.
 */
export function publicApiBaseUrlFrom(
  source: Readonly<Record<string, string | undefined>>,
): string | null {
  const configured = source['PUBLIC_API_BASE_URL']?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const appEnv = source['APP_ENV'] ?? 'development';
  return appEnv === 'development' ? 'http://localhost:3003' : null;
}

export type SocialAddressKey = 'redirectUri' | 'webhookUrl' | 'deauthorizeUrl' | 'dataDeletionUrl';

export interface SocialAddress {
  readonly key: SocialAddressKey;
  readonly url: string;
  /**
   * Whether the route behind it exists in this build. A platform CHECKS a
   * webhook, deauthorize or data-deletion URL when it is registered, so one
   * whose route is not built must not be registered yet.
   */
  readonly live: boolean;
}

/**
 * THE INBOUND SOCIAL ROUTES THIS BUILD SERVES, by address kind. The OAuth
 * callback always exists. The others are added here IN THE SAME CHANGE that
 * registers their route in the API — the API's route registration reads this
 * list too — so the Control Center's "Register after step B" note disappears
 * by itself the moment a route ships, and can never claim a route that is not
 * there.
 */
export const LIVE_SOCIAL_ADDRESS_KEYS: ReadonlySet<SocialAddressKey> = new Set<SocialAddressKey>([
  'redirectUri',
]);

export interface SocialPlatformAddresses {
  readonly providerKey: 'facebook' | 'instagram' | 'tiktok' | 'x';
  readonly addresses: readonly SocialAddress[];
  /** Instagram: the Meta app's other addresses are Facebook's. */
  readonly sharesAppWith: 'facebook' | null;
}

export function socialPlatformAddresses(apiBaseUrl: string): readonly SocialPlatformAddresses[] {
  const base = apiBaseUrl.replace(/\/+$/, '');
  const at = (path: string) => `${base}/v1/social/${path}`;
  return [
    {
      providerKey: 'facebook',
      sharesAppWith: null,
      addresses: [
        {
          key: 'redirectUri',
          url: at('callback/facebook'),
          live: LIVE_SOCIAL_ADDRESS_KEYS.has('redirectUri'),
        },
        {
          key: 'webhookUrl',
          url: at('webhooks/facebook'),
          live: LIVE_SOCIAL_ADDRESS_KEYS.has('webhookUrl'),
        },
        {
          key: 'deauthorizeUrl',
          url: at('deauthorize/facebook'),
          live: LIVE_SOCIAL_ADDRESS_KEYS.has('deauthorizeUrl'),
        },
        {
          key: 'dataDeletionUrl',
          url: at('data-deletion/facebook'),
          live: LIVE_SOCIAL_ADDRESS_KEYS.has('dataDeletionUrl'),
        },
      ],
    },
    {
      providerKey: 'instagram',
      sharesAppWith: 'facebook',
      addresses: [
        {
          key: 'redirectUri',
          url: at('callback/instagram'),
          live: LIVE_SOCIAL_ADDRESS_KEYS.has('redirectUri'),
        },
      ],
    },
    {
      providerKey: 'tiktok',
      sharesAppWith: null,
      addresses: [
        {
          key: 'redirectUri',
          url: at('callback/tiktok'),
          live: LIVE_SOCIAL_ADDRESS_KEYS.has('redirectUri'),
        },
        {
          key: 'webhookUrl',
          url: at('webhooks/tiktok'),
          live: LIVE_SOCIAL_ADDRESS_KEYS.has('webhookUrl'),
        },
      ],
    },
    {
      providerKey: 'x',
      sharesAppWith: null,
      addresses: [
        {
          key: 'redirectUri',
          url: at('callback/x'),
          live: LIVE_SOCIAL_ADDRESS_KEYS.has('redirectUri'),
        },
      ],
    },
  ];
}
