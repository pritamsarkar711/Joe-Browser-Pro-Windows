import type { DeviceTarget, FingerprintConfig } from '../../shared/types';
import { Rng } from './rng';
import {
  androidVersionFor,
  gpuPoolKey,
  handsetFor,
  hostTarget,
  iosVersionFor,
  isAndroidTarget,
  isIosTarget,
  resolveTarget,
  SYSTEM_TARGET,
} from '../../shared/devices';

/**
 * User agent, client hints and brands, derived from one triple: engine, version, target.
 *
 * Every surface in the profile reads from here, so a claim cannot drift: the UA string, the
 * `navigator.userAgentData` brands, the platform token and the OS version all come out of the
 * same function. That is the property a checker is looking for when it compares the UA header
 * against what JavaScript says.
 */

export interface Brand {
  brand: string;
  version: string;
}

export interface Identity {
  userAgent: string;
  platform: string;
  brands: Brand[];
  fullVersionList: Brand[];
  osPlatform: string;
  osVersion: string;
  architecture: string;
  bitness: string;
  mobile: boolean;
  appVersion: string;
  /** For Safari targets: the iOS version token used in the UA. */
  iosVersion: string;
}

const GREASE_BRANDS = [
  'Not/A)Brand',
  'Not_A Brand',
  'Not)A;Brand',
  'Not;A=Brand',
  'Not A(Brand',
];

export function majorOf(version: string): number {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major > 0 ? major : 131;
}

/** Windows 11 and 10 both report NT 10.0; the client-hint version is what separates them. */
function osVersionOf(target: DeviceTarget, device: string, fp?: FingerprintConfig): string {
  const resolved = resolveTarget(target).resolvedOs;
  if (isIosTarget(target)) {
    const v = fp ? iosVersionFor(target, fp) : '17.5';
    return v.replace('.', '_');
  }
  if (isAndroidTarget(target)) {
    const v = fp ? androidVersionFor(target, fp) : '14';
    return `${v}.0.0`;
  }
  if (device !== 'desktop') return '14.0.0';
  switch (resolved) {
    case 'Windows 11':
      return '15.0.0';
    case 'Windows 10':
      return '10.0.0';
    case 'macOS 15':
      return '15.1.0';
    case 'macOS 14':
      return '14.6.1';
    default:
      return '6.6.0';
  }
}

function macOsVersionToken(fp?: FingerprintConfig): string {
  const resolved = fp ? resolveTarget(fp.os).resolvedOs : 'macOS 15';
  return resolved === 'macOS 14' ? '10_15_7' : '10_15_7';
}

/**
 * The Chrome-on-Android UA. Android Chrome is `Linux; Android 14; Pixel 8` — the handset is
 * part of the string and it must be the handset the screen belongs to.
 */
function chromeOsToken(target: DeviceTarget, fp: FingerprintConfig): string {
  if (isAndroidTarget(target)) {
    const version = androidVersionFor(target, fp);
    return `Linux; Android ${version}; ${handsetFor(target, fp)}`;
  }
  switch (resolveTarget(target).resolvedOs) {
    case 'macOS 15':
    case 'macOS 14':
      return `Macintosh; Intel Mac OS X ${macOsVersionToken(fp)}`;
    case 'Linux':
      return 'X11; Linux x86_64';
    default:
      return 'Windows NT 10.0; Win64; x64';
  }
}

/**
 * A Safari identity, for the iPhone and iPad targets. Not a Chromium UA with an iPhone token
 * pasted in: a phone that claims to be Safari but carries `Chrome/131` and a Chromium brand list
 * is one of the loudest tells there is, so the whole shape changes here.
 */
function safariIdentity(fp: FingerprintConfig, target: DeviceTarget): Identity {
  const ios = iosVersionFor(target, fp);
  const token = ios.replace(/\./g, '_');
  const isPad = target === 'iPad';
  const userAgent = isPad
    ? `Mozilla/5.0 (iPad; CPU OS ${token} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ios} Mobile/15E148 Safari/604.1`
    : `Mozilla/5.0 (iPhone; CPU iPhone OS ${token} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ios} Mobile/15E148 Safari/604.1`;
  return {
    userAgent,
    platform: isPad ? 'iPad' : 'iPhone',
    // Safari exposes no client hints. An empty list is the honest answer, and the injected
    // script removes NavigatorUAData for this profile.
    brands: [],
    fullVersionList: [],
    osPlatform: 'iOS',
    osVersion: token,
    architecture: 'arm',
    bitness: '64',
    mobile: true,
    appVersion: userAgent.replace('Mozilla/', ''),
    iosVersion: ios,
  };
}

/**
 * Build the whole identity. `seed` drives the GREASE ordering only, so two profiles on the same
 * kernel do not share a brand permutation.
 */
export function buildIdentity(
  engine: string,
  version: string,
  fp: FingerprintConfig,
  seed: number,
): Identity {
  const target: DeviceTarget = fp.os ?? SYSTEM_TARGET;
  const device = resolveTarget(target).deviceType;
  const rng = new Rng(seed ^ 0x5f3759df);
  const major = majorOf(version);
  const full = version.includes('.') ? version : `${version}.0.0.0`;

  // iOS only ever means Safari, and Safari only ever means iOS in this app. A Firefox on an
  // iPhone is a real thing but its UA is a different shape again, and claiming it here while
  // launching Chromium would be a lie the page can see through in one property.
  if (isIosTarget(target)) return safariIdentity(fp, target);

  if (engine === 'firefox') {
    const ffMajor = majorOf(version);
    const osToken = isAndroidTarget(target)
      ? `Android ${androidVersionFor(target, fp)}; Mobile; rv:${ffMajor}.0`
      : resolveTarget(target).resolvedOs === 'Linux'
        ? 'X11; Linux x86_64'
        : resolveTarget(target).resolvedOs.startsWith('macOS')
          ? 'Macintosh; Intel Mac OS X 10.15'
          : 'Windows NT 10.0; Win64; x64';
    const userAgent = `Mozilla/5.0 (${osToken}) Gecko/20100101 Firefox/${ffMajor}.0`;
    return {
      userAgent,
      platform: isAndroidTarget(target)
        ? 'Linux armv8l'
        : resolveTarget(target).resolvedOs.startsWith('macOS')
          ? 'MacIntel'
          : resolveTarget(target).resolvedOs === 'Linux'
            ? 'Linux x86_64'
            : 'Win32',
      brands: [],
      fullVersionList: [],
      osPlatform: '',
      osVersion: '',
      architecture: '',
      bitness: '',
      mobile: device !== 'desktop',
      appVersion: userAgent.replace('Mozilla/', ''),
      iosVersion: '',
    };
  }

  const chromeToken = `Chrome/${major}.0.0.0`;
  const branded =
    engine === 'edge' ? ` Edg/${major}.0.0.0`
      : engine === 'opera' ? ` OPR/${major}.0.0.0`
        : engine === 'brave' ? ''
          : '';

  const userAgent =
    `Mozilla/5.0 (${chromeOsToken(target, fp)}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `${chromeToken} Safari/537.36${branded}` +
    (device === 'mobile' ? ' Mobile' : '');

  // The GREASE brand and its position are part of the identity: Chrome randomises them and a
  // fixed order is its own tell.
  const grease = rng.pick(GREASE_BRANDS);
  const greaseVersion = String(rng.pick([8, 24, 99, 0, 13, 24]));

  const order = rng.shuffle(['grease', 'chromium', 'brand']).map((slot) => {
    if (slot === 'grease') return { brand: grease, version: greaseVersion };
    if (slot === 'chromium') return { brand: 'Chromium', version: String(major) };
    return { brand: brandNameFor(engine), version: String(major) };
  });

  const brand = brandNameFor(engine);
  // Edge, Brave and Opera all keep Chromium in the list; Chromium and Chrome add their own.
  const fullVersionList: Brand[] = [
    { brand: grease, version: '99.0.0.0' },
    { brand: 'Chromium', version: full },
  ];
  if (engine !== 'chromium') fullVersionList.push({ brand, version: full.replace(/\.0$/, '') });

  return {
    userAgent,
    platform: isAndroidTarget(target) ? 'Linux armv8l' : resolveTarget(target).platform,
    brands: order,
    fullVersionList,
    osPlatform: resolveTarget(target).osPlatform,
    osVersion: osVersionOf(target, device, fp),
    architecture: device === 'desktop' ? 'x86' : 'arm',
    bitness: device === 'desktop' ? '64' : '32',
    mobile: device !== 'desktop',
    appVersion: userAgent.replace('Mozilla/', ''),
    iosVersion: '',
  };
}

export function brandNameFor(engine: string): string {
  switch (engine) {
    case 'joe':
      return 'Joe Browser';
    case 'edge':
      return 'Microsoft Edge';
    case 'brave':
      return 'Brave';
    case 'opera':
      return 'Opera';
    case 'chromium':
      return 'Chromium';
    default:
      return 'Google Chrome';
  }
}

/** The default language list for a target and a locale, e.g. "en-GB,en;q=0.9". */
export function acceptLanguageFor(language: string): string {
  const [base] = language.split('-');
  if (!base || base === language) return language;
  const extras = base === 'en' ? `${base};q=0.9` : `${base};q=0.9,en;q=0.8`;
  return `${language},${extras}`;
}

/** What a fresh profile for this machine would claim. */
export function systemFingerprintSeed(): number {
  void hostTarget();
  return Date.now() % 0xffffffff;
}

export { gpuPoolKey };
