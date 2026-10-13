/**
 * CONNECTORS A — THE ADDRESSES THE OWNER REGISTERS WITH EACH PLATFORM.
 *
 * Every one is ours: it is where our own route lives, built from the API's
 * public base URL (`PUBLIC_API_BASE_URL`, per environment) and never typed by
 * hand. The OAuth callbacks exist; Meta's webhook, deauthorize and
 * data-deletion routes were built in step B; TikTok's webhook arrives with
 * step C, and its address is shown already so the app can be prepared.
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
 * THE INBOUND SOCIAL ROUTES THIS BUILD SERVES, per platform and address kind.
 * The OAuth callbacks always exist. Connectors B registered Meta's webhook,
 * deauthorize and data-deletion routes (`apps/api/src/routes/social-inbound.ts`)
 * and added them here IN THE SAME CHANGE, so the Control Center stops saying
 * "register later" the moment a route ships and never claims one that is not
 * there. PER PLATFORM, because a kind of address is not one route: Meta's
 * webhook exists, TikTok's arrives with step C.
 * `tests/unit/connectors-a-social-addresses.test.ts` checks every live address
 * against the API's registered routes.
 */
export const LIVE_SOCIAL_ADDRESS_KEYS: Readonly<
  Record<SocialPlatformAddresses['providerKey'], ReadonlySet<SocialAddressKey>>
> = {
  facebook: new Set<SocialAddressKey>([
    'redirectUri',
    'webhookUrl',
    'deauthorizeUrl',
    'dataDeletionUrl',
  ]),
  instagram: new Set<SocialAddressKey>(['redirectUri']),
  tiktok: new Set<SocialAddressKey>(['redirectUri']),
  x: new Set<SocialAddressKey>(['redirectUri']),
};

export interface SocialPlatformAddresses {
  readonly providerKey: 'facebook' | 'instagram' | 'tiktok' | 'x';
  readonly addresses: readonly SocialAddress[];
  /** Instagram: the Meta app's other addresses are Facebook's. */
  readonly sharesAppWith: 'facebook' | null;
}

export function socialPlatformAddresses(apiBaseUrl: string): readonly SocialPlatformAddresses[] {
  const base = apiBaseUrl.replace(/\/+$/, '');
  const at = (path: string) => `${base}/v1/social/${path}`;
  const platforms: {
    providerKey: SocialPlatformAddresses['providerKey'];
    sharesAppWith: 'facebook' | null;
    addresses: { key: SocialAddressKey; url: string }[];
  }[] = [
    {
      providerKey: 'facebook',
      sharesAppWith: null,
      addresses: [
        {
          key: 'redirectUri',
          url: at('callback/facebook'),
        },
        {
          key: 'webhookUrl',
          url: at('webhooks/facebook'),
        },
        {
          key: 'deauthorizeUrl',
          url: at('deauthorize/facebook'),
        },
        {
          key: 'dataDeletionUrl',
          url: at('data-deletion/facebook'),
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
        },
        {
          key: 'webhookUrl',
          url: at('webhooks/tiktok'),
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
        },
      ],
    },
  ];
  return platforms.map((platform) => ({
    ...platform,
    addresses: platform.addresses.map((address) => ({
      ...address,
      live: LIVE_SOCIAL_ADDRESS_KEYS[platform.providerKey].has(address.key),
    })),
  }));
}
