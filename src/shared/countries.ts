import { FLAG_CODES } from './flagCodes';

// Match only flags bundled by flag-icons; never render an empty or unrelated flag.
const available: Set<string> = new Set(FLAG_CODES);
const names = new Intl.DisplayNames(['en'], { type: 'region' });

export function countryCode(value: string): string {
  const code = (value || '').trim().toUpperCase();
  return available.has(code) ? code : '';
}

/** Code is the common source for both the displayed name and flag. */
export function countryName(code: string, fallback = ''): string {
  const normalized = countryCode(code);
  if (!normalized) return fallback;
  const name = names.of(normalized);
  return name && name !== normalized ? name : fallback || normalized;
}

/**
 * Country name -> ISO code, using the same table as the flags so a name can never resolve to a
 * flag the bundle does not ship. Provider APIs are inconsistent about names ("USA", "UK",
 * "Russian Federation", ...), so the reverse of the display names is built once and a small set
 * of aliases covers the variants that occur in proxy and IP-lookup responses.
 */
const BY_NAME = new Map<string, string>();
for (const code of FLAG_CODES) {
  const name = names.of(code);
  if (name && name !== code) BY_NAME.set(name.toUpperCase(), code);
}

const ALIASES: Record<string, string> = {
  USA: 'US',
  'UNITED STATES OF AMERICA': 'US',
  UK: 'GB',
  'GREAT BRITAIN': 'GB',
  ENGLAND: 'GB',
  'RUSSIAN FEDERATION': 'RU',
  'REPUBLIC OF KOREA': 'KR',
  'KOREA, REPUBLIC OF': 'KR',
  'VIET NAM': 'VN',
  CZECHIA: 'CZ',
  'TAIWAN, PROVINCE OF CHINA': 'TW',
  'HONG KONG SAR': 'HK',
  'MACAO SAR': 'MO',
  'IRAN, ISLAMIC REPUBLIC OF': 'IR',
  'BOLIVIA, PLURINATIONAL STATE OF': 'BO',
  'VENEZUELA, BOLIVARIAN REPUBLIC OF': 'VE',
  'TANZANIA, UNITED REPUBLIC OF': 'TZ',
  'MOLDOVA, REPUBLIC OF': 'MD',
  'SYRIAN ARAB REPUBLIC': 'SY',
  'BRUNEI DARUSSALAM': 'BN',
  "LAO PEOPLE'S DEMOCRATIC REPUBLIC": 'LA',
};

/** Returns '' when the name is unknown; callers then show a globe instead of guessing a flag. */
export function countryCodeFromName(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';
  const direct = countryCode(trimmed);
  if (direct) return direct;
  const upper = trimmed.toUpperCase();
  return BY_NAME.get(upper) ?? ALIASES[upper] ?? '';
}
