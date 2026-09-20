/**
 * Geography choices used during customer onboarding.
 *
 * Country is an identity/profile fact, not a commercial-routing decision. The
 * user may create a workspace in any ISO 3166-1 alpha-2 country even when a
 * payment provider has not been connected for that country yet. Checkout owns
 * the later question of whether BrandSpace can charge there.
 */

export const ISO_COUNTRY_CODES = ["AW","AF","AO","AI","AX","AL","AD","AE","AR","AM","AS","AQ","TF","AG","AU","AT","AZ","BI","BE","BJ","BQ","BF","BD","BG","BH","BS","BA","BL","BY","BZ","BM","BO","BR","BB","BN","BT","BV","BW","CF","CA","CC","CH","CL","CN","CI","CM","CD","CG","CK","CO","KM","CV","CR","CU","CW","CX","KY","CY","CZ","DE","DJ","DM","DK","DO","DZ","EC","EG","ER","EH","ES","EE","ET","FI","FJ","FK","FR","FO","FM","GA","GB","GE","GG","GH","GI","GN","GP","GM","GW","GQ","GR","GD","GL","GT","GF","GU","GY","HK","HM","HN","HR","HT","HU","ID","IM","IN","IO","IE","IR","IQ","IS","IL","IT","JM","JE","JO","JP","KZ","KE","KG","KH","KI","KN","KR","KW","LA","LB","LR","LY","LC","LI","LK","LS","LT","LU","LV","MO","MF","MA","MC","MD","MG","MV","MX","MH","MK","ML","MT","MM","ME","MN","MP","MZ","MR","MS","MQ","MU","MW","MY","YT","NA","NC","NE","NF","NG","NI","NU","NL","NO","NP","NR","NZ","OM","PK","PA","PN","PE","PH","PW","PG","PL","PR","KP","PT","PY","PS","PF","QA","RE","RO","RU","RW","SA","SD","SN","SG","GS","SH","SJ","SB","SL","SV","SM","SO","PM","RS","SS","ST","SR","SK","SI","SE","SZ","SX","SC","SY","TC","TD","TG","TH","TJ","TK","TM","TL","TO","TT","TN","TR","TV","TW","TZ","UG","UA","UM","UY","US","UZ","VA","VC","VE","VG","VI","VN","VU","WF","WS","YE","ZA","ZM","ZW"] as const;

const COUNTRY_CODE_SET = new Set<string>(ISO_COUNTRY_CODES);

export interface LocaleOption {
  readonly value: string;
  readonly label: string;
}

export function isIsoCountryCode(value: string): boolean {
  return COUNTRY_CODE_SET.has(value.trim().toUpperCase());
}

/** Localised country labels, sorted the way the current interface language sorts. */
export function countryOptions(locale: string): LocaleOption[] {
  const displayNames = new Intl.DisplayNames([locale], { type: 'region' });
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  return ISO_COUNTRY_CODES.map((code) => ({
    value: code,
    label: displayNames.of(code) ?? code,
  })).sort((a, b) => collator.compare(a.label, b.label));
}

/**
 * IANA time zones supplied by the runtime itself.
 *
 * The stored value stays the canonical IANA identifier; the label makes the
 * last segment readable while keeping the exact identifier visible.
 */
export function timeZoneOptions(locale: string): LocaleOption[] {
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  return zones
    .map((value) => {
      const city = value.split('/').at(-1)?.replaceAll('_', ' ') ?? value;
      return { value, label: city === value ? value : `${city} — ${value}` };
    })
    .sort((a, b) => collator.compare(a.label, b.label));
}
