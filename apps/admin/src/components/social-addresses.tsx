import {
  socialPlatformAddresses,
  type SocialAddressKey,
  type SocialPlatformAddresses,
} from '@brandspace/integrations';
import { SectionHeader, colorTokens, fontTokens, typographyTokens } from '@brandspace/ui';
import { Cell, DataTable } from './admin-shell';
import { CopyValue } from './copy-value';

/**
 * CONNECTORS A — "ADDRESSES TO REGISTER", on the Social platforms page.
 *
 * Every URL the owner pastes into the Meta, TikTok and X developer apps,
 * GENERATED from the API's public base URL for this environment and shown
 * read-only with a Copy button — never typed, so it cannot be mistyped or
 * pointed somewhere else. Built from the console's existing table and section
 * header (CLAUDE.md §4.2: an approved design-system extension, recorded in
 * docs/UI-FIDELITY-CONTRACT.md §6). Addresses whose route arrives in step B are
 * marked so, because registering them early is fine and calling them live
 * would not be.
 */

const PLATFORM_NAMES: Readonly<Record<SocialPlatformAddresses['providerKey'], [string, string]>> = {
  facebook: ['Facebook (Meta app)', 'فيسبوك (تطبيق Meta)'],
  instagram: ['Instagram (the same Meta app)', 'إنستغرام (تطبيق Meta نفسه)'],
  tiktok: ['TikTok', 'تيك توك'],
  x: ['X', 'X'],
};

const ADDRESS_NAMES: Readonly<Record<SocialAddressKey, [string, string]>> = {
  redirectUri: ['OAuth redirect (callback) URL', 'رابط إعادة التوجيه (OAuth)'],
  webhookUrl: ['Webhook URL', 'رابط الويب هوك'],
  deauthorizeUrl: ['Deauthorize callback URL', 'رابط إلغاء التفويض'],
  dataDeletionUrl: ['Data deletion request URL', 'رابط طلب حذف البيانات'],
};

export function SocialAddresses({
  isArabic,
  apiBaseUrl,
}: {
  readonly isArabic: boolean;
  readonly apiBaseUrl: string;
}) {
  const pick = ([en, ar]: [string, string]) => (isArabic ? ar : en);
  return (
    <div data-testid="social-addresses">
      <SectionHeader
        title={isArabic ? 'عناوين للتسجيل لدى المنصات' : 'Addresses to register'}
        description={
          isArabic
            ? 'انسخ كل عنوان إلى تطبيق المطوّر لدى المنصة. يولّدها Brandspace لهذه البيئة؛ لا تُكتب يدويًا.'
            : 'Copy each address into the platform’s developer app. Brandspace generates them for this environment; they are never typed by hand.'
        }
      />
      <DataTable
        headers={[
          isArabic ? 'المنصة' : 'Platform',
          isArabic ? 'العنوان' : 'Address',
          isArabic ? 'القيمة' : 'Value',
          '',
        ]}
      >
        {socialPlatformAddresses(apiBaseUrl).flatMap((platform) =>
          platform.addresses.map((address, index) => (
            <tr
              key={`${platform.providerKey}:${address.key}`}
              data-testid={`social-address-${platform.providerKey}-${address.key}`}
            >
              <Cell>
                {index === 0 ? (
                  <>
                    <div>{pick(PLATFORM_NAMES[platform.providerKey])}</div>
                    {platform.sharesAppWith ? (
                      <div style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                        {isArabic
                          ? 'أضف رابط إعادة التوجيه هذا إلى تطبيق فيسبوك نفسه؛ بقية العناوين هي عناوين فيسبوك.'
                          : 'Add this redirect to the same Facebook app; its other addresses are Facebook’s.'}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </Cell>
              <Cell>
                <div>{pick(ADDRESS_NAMES[address.key])}</div>
                {address.live ? null : (
                  <div style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                    {isArabic
                      ? 'يُبنى في الخطوة B — يمكن تسجيله الآن.'
                      : 'Built in step B — safe to register now.'}
                  </div>
                )}
              </Cell>
              <Cell>
                <code style={{ fontFamily: fontTokens.mono, overflowWrap: 'anywhere' }}>
                  {address.url}
                </code>
              </Cell>
              <Cell>
                <CopyValue
                  value={address.url}
                  text={isArabic ? 'نسخ' : 'Copy'}
                  label={
                    isArabic
                      ? `نسخ ${pick(ADDRESS_NAMES[address.key])} — ${pick(PLATFORM_NAMES[platform.providerKey])}`
                      : `Copy the ${pick(PLATFORM_NAMES[platform.providerKey])} ${pick(ADDRESS_NAMES[address.key])}`
                  }
                  copiedLabel={isArabic ? 'نُسخ' : 'Copied'}
                  failedLabel={
                    isArabic ? 'تعذّر النسخ؛ حدّد النص وانسخه.' : 'Could not copy; select the text.'
                  }
                  testId={`copy-${platform.providerKey}-${address.key}`}
                />
              </Cell>
            </tr>
          )),
        )}
      </DataTable>
    </div>
  );
}
