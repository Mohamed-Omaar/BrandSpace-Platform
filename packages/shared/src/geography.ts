/**
 * Geographic constants shared by onboarding surfaces.
 *
 * Country is a customer answer, not a commerce-market gate. Keep the complete
 * ISO 3166-1 alpha-2 inventory here so every customer can identify where their
 * workspace operates even before payment routing exists for that country.
 */
export const ISO_COUNTRY_CODES = [
  'AD',
  'AE',
  'AF',
  'AG',
  'AI',
  'AL',
  'AM',
  'AO',
  'AQ',
  'AR',
  'AS',
  'AT',
  'AU',
  'AW',
  'AX',
  'AZ',
  'BA',
  'BB',
  'BD',
  'BE',
  'BF',
  'BG',
  'BH',
  'BI',
  'BJ',
  'BL',
  'BM',
  'BN',
  'BO',
  'BQ',
  'BR',
  'BS',
  'BT',
  'BV',
  'BW',
  'BY',
  'BZ',
  'CA',
  'CC',
  'CD',
  'CF',
  'CG',
  'CH',
  'CI',
  'CK',
  'CL',
  'CM',
  'CN',
  'CO',
  'CR',
  'CU',
  'CV',
  'CW',
  'CX',
  'CY',
  'CZ',
  'DE',
  'DJ',
  'DK',
  'DM',
  'DO',
  'DZ',
  'EC',
  'EE',
  'EG',
  'EH',
  'ER',
  'ES',
  'ET',
  'FI',
  'FJ',
  'FK',
  'FM',
  'FO',
  'FR',
  'GA',
  'GB',
  'GD',
  'GE',
  'GF',
  'GG',
  'GH',
  'GI',
  'GL',
  'GM',
  'GN',
  'GP',
  'GQ',
  'GR',
  'GS',
  'GT',
  'GU',
  'GW',
  'GY',
  'HK',
  'HM',
  'HN',
  'HR',
  'HT',
  'HU',
  'ID',
  'IE',
  'IL',
  'IM',
  'IN',
  'IO',
  'IQ',
  'IR',
  'IS',
  'IT',
  'JE',
  'JM',
  'JO',
  'JP',
  'KE',
  'KG',
  'KH',
  'KI',
  'KM',
  'KN',
  'KP',
  'KR',
  'KW',
  'KY',
  'KZ',
  'LA',
  'LB',
  'LC',
  'LI',
  'LK',
  'LR',
  'LS',
  'LT',
  'LU',
  'LV',
  'LY',
  'MA',
  'MC',
  'MD',
  'ME',
  'MF',
  'MG',
  'MH',
  'MK',
  'ML',
  'MM',
  'MN',
  'MO',
  'MP',
  'MQ',
  'MR',
  'MS',
  'MT',
  'MU',
  'MV',
  'MW',
  'MX',
  'MY',
  'MZ',
  'NA',
  'NC',
  'NE',
  'NF',
  'NG',
  'NI',
  'NL',
  'NO',
  'NP',
  'NR',
  'NU',
  'NZ',
  'OM',
  'PA',
  'PE',
  'PF',
  'PG',
  'PH',
  'PK',
  'PL',
  'PM',
  'PN',
  'PR',
  'PS',
  'PT',
  'PW',
  'PY',
  'QA',
  'RE',
  'RO',
  'RS',
  'RU',
  'RW',
  'SA',
  'SB',
  'SC',
  'SD',
  'SE',
  'SG',
  'SH',
  'SI',
  'SJ',
  'SK',
  'SL',
  'SM',
  'SN',
  'SO',
  'SR',
  'SS',
  'ST',
  'SV',
  'SX',
  'SY',
  'SZ',
  'TC',
  'TD',
  'TF',
  'TG',
  'TH',
  'TJ',
  'TK',
  'TL',
  'TM',
  'TN',
  'TO',
  'TR',
  'TT',
  'TV',
  'TW',
  'TZ',
  'UA',
  'UG',
  'UM',
  'US',
  'UY',
  'UZ',
  'VA',
  'VC',
  'VE',
  'VG',
  'VI',
  'VN',
  'VU',
  'WF',
  'WS',
  'YE',
  'YT',
  'ZA',
  'ZM',
  'ZW',
] as const;

export type IsoCountryCode = (typeof ISO_COUNTRY_CODES)[number];

const ISO_COUNTRY_SET = new Set<string>(ISO_COUNTRY_CODES);

export function isIsoCountryCode(value: string): value is IsoCountryCode {
  return ISO_COUNTRY_SET.has(value.trim().toUpperCase());
}

export interface LocalizedOption {
  readonly value: string;
  readonly label: string;
}

/** Localised country labels, sorted for the current interface language. */
export function countryOptions(locale: string): LocalizedOption[] {
  const displayNames = new Intl.DisplayNames([locale], { type: 'region' });
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  return ISO_COUNTRY_CODES.map((code) => ({
    value: code,
    label: displayNames.of(code) ?? code,
  })).sort((a, b) => collator.compare(a.label, b.label));
}

/** Searchable IANA time-zone choices. Stored values stay canonical identifiers. */
export function timeZoneOptions(locale: string): LocalizedOption[] {
  const supportedValuesOf = (
    Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }
  ).supportedValuesOf;
  const runtimeZones = supportedValuesOf ? supportedValuesOf('timeZone') : [];
  const zones = runtimeZones.includes('UTC') ? runtimeZones : ['UTC', ...runtimeZones];
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });

  return zones
    .map((value) => {
      const city = value.split('/').at(-1)?.replaceAll('_', ' ') ?? value;
      return { value, label: city === value ? value : `${city} — ${value}` };
    })
    .sort((a, b) => collator.compare(a.label, b.label));
}

/**
 * WHERE A COUNTRY USUALLY KEEPS ITS CLOCK (Q7, prototype v94 Phase 2B-1).
 *
 * Choosing a country PRESELECTS this zone as a suggestion; the person can
 * change it before saving, and nothing is saved that they did not confirm
 * (D-194 stands: there is still no product-wide default).
 *
 * REFERENCE DATA, NOT CONFIGURATION — the same kind of fact as the ISO list
 * above. A country with ONE zone is read from the runtime's own time-zone data
 * (`Intl.Locale#timeZones`), so nothing is typed out here. A country that
 * spans several has no single answer; for those, the zone of its capital or
 * largest city is named below, and any other several-zone country gets no
 * suggestion at all rather than an arbitrary one. The answer is always one of
 * `timeZoneOptions`' values, or null.
 */
const PRIMARY_ZONE_OF_SEVERAL: Readonly<Record<string, string>> = {
  AR: 'America/Buenos_Aires',
  AU: 'Australia/Sydney',
  BR: 'America/Sao_Paulo',
  CA: 'America/Toronto',
  CD: 'Africa/Kinshasa',
  CL: 'America/Santiago',
  CN: 'Asia/Shanghai',
  CY: 'Asia/Nicosia',
  DE: 'Europe/Berlin',
  EC: 'America/Guayaquil',
  ES: 'Europe/Madrid',
  ID: 'Asia/Jakarta',
  KZ: 'Asia/Almaty',
  MN: 'Asia/Ulaanbaatar',
  MX: 'America/Mexico_City',
  MY: 'Asia/Kuala_Lumpur',
  NZ: 'Pacific/Auckland',
  PG: 'Pacific/Port_Moresby',
  PS: 'Asia/Hebron',
  PT: 'Europe/Lisbon',
  RU: 'Europe/Moscow',
  UA: 'Europe/Kiev',
  US: 'America/New_York',
  UZ: 'Asia/Tashkent',
};

export function suggestedTimeZone(country: string): string | null {
  const code = country.trim().toUpperCase();
  if (!isIsoCountryCode(code)) return null;
  const supportedValuesOf = (
    Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }
  ).supportedValuesOf;
  const known = new Set(supportedValuesOf ? supportedValuesOf('timeZone') : []);
  let zones: readonly string[] = [];
  try {
    zones =
      (new Intl.Locale(`und-${code}`) as Intl.Locale & { timeZones?: readonly string[] })
        .timeZones ?? [];
  } catch {
    zones = [];
  }
  const only = zones.length === 1 ? zones[0] : undefined;
  const candidate = only ?? PRIMARY_ZONE_OF_SEVERAL[code] ?? null;
  return candidate !== null && known.has(candidate) ? candidate : null;
}

/** Every country's suggestion, for a client form to preselect from. */
export function suggestedTimeZones(): Readonly<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const code of ISO_COUNTRY_CODES) {
    const zone = suggestedTimeZone(code);
    if (zone) map[code] = zone;
  }
  return map;
}

/**
 * Customer-facing billing is intentionally simple for launch. The billing
 * engine remains multi-currency internally; onboarding does not expose that
 * complexity until a product decision enables it.
 */
export const DEFAULT_BILLING_CURRENCY = 'USD' as const;
