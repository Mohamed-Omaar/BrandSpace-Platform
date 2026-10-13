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

export type SocialAddressKey = 'redirectUri' | 'webhookUrl' | 'deauthorizeUrl' | 'dataDeletionUrl';

export interface SocialAddress {
  readonly key: SocialAddressKey;
  readonly url: string;
  /** False while the route behind it is not built yet (step B). */
  readonly live: boolean;
}

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
        { key: 'redirectUri', url: at('callback/facebook'), live: true },
        { key: 'webhookUrl', url: at('webhooks/facebook'), live: false },
        { key: 'deauthorizeUrl', url: at('deauthorize/facebook'), live: false },
        { key: 'dataDeletionUrl', url: at('data-deletion/facebook'), live: false },
      ],
    },
    {
      providerKey: 'instagram',
      sharesAppWith: 'facebook',
      addresses: [{ key: 'redirectUri', url: at('callback/instagram'), live: true }],
    },
    {
      providerKey: 'tiktok',
      sharesAppWith: null,
      addresses: [
        { key: 'redirectUri', url: at('callback/tiktok'), live: true },
        { key: 'webhookUrl', url: at('webhooks/tiktok'), live: false },
      ],
    },
    {
      providerKey: 'x',
      sharesAppWith: null,
      addresses: [{ key: 'redirectUri', url: at('callback/x'), live: true }],
    },
  ];
}
