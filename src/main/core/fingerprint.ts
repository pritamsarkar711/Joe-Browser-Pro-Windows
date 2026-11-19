import type {
  DeviceTarget,
  FingerprintConfig,
  ResolvedOs,
} from '../../shared/types';
import { Rng, hashString } from './rng';
import { acceptLanguageFor, brandNameFor, buildIdentity } from './ua';
import { BY_CODE, ZONES } from '../../shared/zones';
import {
  GPUS_BY_TARGET,
  SCREENS_BY_TARGET,
  SYSTEM_TARGET,
  androidVersionFor,
  gpuPoolKey,
  hostTarget,
  iosVersionFor,
  isAndroidTarget,
  isIosTarget,
  resolveTarget,
  touchPointsFor,
} from '../../shared/devices';

/**
 * The identity factory.
 *
 * Rules this file lives by:
 *  - A coherent identity beats a random one. Every field is drawn from pools that occur
 *    together in the real world (a 4-core machine does not carry 32 GB of RAM, and a phone is
 *    not 3840 pixels wide at a device pixel ratio of 1).
 *  - The same seed always yields the same machine, so a profile is stable across launches.
 *  - A new identity must differ from every profile already in the store across twelve
 *    surfaces, or it is re-rolled. Two profiles that share a canvas hash are one profile as
 *    far as any site that sees both is concerned.
 */

export const SURFACES = [
  'userAgent',
  'platform',
  'screen',
  'webgl',
  'cores',
  'memory',
  'timezone',
  'language',
  'fonts',
  'canvas',
  'audio',
  'touch',
] as const;

export type Surface = (typeof SURFACES)[number];

interface GpuCard {
  vendor: string;
  renderer: string;
  weight: number;
}

/** Kept for compatibility with the old signature; the pools now live in shared/devices.ts. */
const GPU_WINDOWS: GpuCard[] = GPUS_BY_TARGET['desktop-windows'];
const GPU_MAC: GpuCard[] = GPUS_BY_TARGET['desktop-mac'];
const GPU_LINUX: GpuCard[] = GPUS_BY_TARGET['desktop-linux'];

const CORES_MEMORY: readonly (readonly [number, number, number])[] = [
  // [cores, gigabytes, weight] - values Chromium actually reports (memory is capped at 8).
  [4, 8, 26],
  [8, 8, 30],
  [6, 8, 12],
  [12, 8, 10],
  [16, 8, 8],
  [2, 4, 6],
  [10, 8, 4],
  [20, 8, 2],
];

/** A phone reports few cores and little RAM; a desktop with 20 cores in a phone is nonsense. */
const MOBILE_CORES_MEMORY: readonly (readonly [number, number, number])[] = [
  [8, 8, 46],
  [8, 4, 22],
  [6, 8, 12],
  [4, 4, 10],
  [8, 6, 10],
];

const FONT_SETS: Record<string, string[]> = {
  windows: [
    'Arial', 'Calibri', 'Cambria', 'Consolas', 'Courier New', 'Georgia', 'Segoe UI',
    'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Segoe UI Symbol',
    'Microsoft Sans Serif', 'MS Gothic', 'Franklin Gothic Medium', 'Gabriola',
  ],
  macos: [
    'Helvetica', 'Helvetica Neue', 'Menlo', 'Monaco', 'Optima', 'Palatino', 'San Francisco',
    'Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'Avenir',
    'Avenir Next', 'Futura', 'Geneva', 'Lucida Grande',
  ],
  linux: [
    'DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Noto Sans', 'Cantarell', 'Arial',
    'Courier New', 'Georgia', 'Times New Roman', 'FreeSans', 'Liberation Serif',
  ],
  minimal: ['Arial', 'Courier New', 'Times New Roman'],
  ios: ['Helvetica', 'Helvetica Neue', 'Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'Avenir'],
  android: ['Roboto', 'Noto Sans', 'Droid Sans', 'Arial', 'Courier New', 'Georgia'],
};

const LANG_BY_OS: Record<ResolvedOs, string[]> = {
  'Windows 11': ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'pt-BR', 'nl-NL', 'pl-PL', 'tr-TR', 'ru-RU', 'en-IN'],
  'Windows 10': ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'pt-BR', 'it-IT', 'tr-TR', 'pl-PL'],
  'macOS 15': ['en-US', 'en-GB', 'de-DE', 'ja-JP', 'fr-FR', 'es-ES', 'ko-KR'],
  'macOS 14': ['en-US', 'en-GB', 'de-DE', 'ja-JP', 'fr-FR', 'es-ES'],
  Linux: ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ru-RU'],
};

export interface GenerateOptions {
  seed?: number;
  /** The picker value. Everything else follows from it. */
  os?: DeviceTarget;
  engine?: string;
  browserVersion?: string;
  /** Country code from a tested proxy, used to pull timezone and locale into agreement. */
  countryCode?: string;
  /** A renderer to prefer, when the app has learned this machine's real card. */
  preferredGpu?: { vendor: string; renderer: string } | null;
}

export function generateFingerprint(options: GenerateOptions = {}): FingerprintConfig {
  const seed = options.seed ?? Rng.seed();
  return buildFromSeed(seed, options);
}

function buildFromSeed(seed: number, options: GenerateOptions): FingerprintConfig {
  const rng = new Rng(seed);
  const target: DeviceTarget = options.os ?? SYSTEM_TARGET;
  const resolved = resolveTarget(target);
  const deviceType = resolved.deviceType;
  const mobile = deviceType !== 'desktop';

  const screens = SCREENS_BY_TARGET[target] ?? SCREENS_BY_TARGET['System default']!;
  const screen = rng.weighted(screens.map((s) => [s, s.weight] as const));

  const pool = GPUS_BY_TARGET[gpuPoolKey(target)];
  const learned = options.preferredGpu;
  // A real card on this PC is better than a synthetic one, but only when the profile is not
  // claiming a different machine: an M2 renderer on a Windows target is worse than no signal.
  const gpu =
    learned && !mobile && resolved.resolvedOs.startsWith('Windows')
      ? { vendor: learned.vendor, renderer: learned.renderer, weight: 1 }
      : rng.weighted(pool.map((g) => [g, g.weight] as const));

  const [cores, memory] = rng.weighted(
    (mobile ? MOBILE_CORES_MEMORY : CORES_MEMORY).map((row) => [row, row[2]] as const),
  );

  const language = pickLanguage(rng, resolved.resolvedOs, options.countryCode, mobile);
  const zone = resolveZone(language, options.countryCode, rng);

  const fontSet = fontSetFor(target);
  const engine = options.engine ?? 'chrome';
  const browserVersion = options.browserVersion ?? '157.0.8103.41';

  const base: FingerprintConfig = {
    seed,
    os: target,
    deviceType,
    resolvedOs: resolved.resolvedOs,
    timezone: zone,
    language,
    acceptLanguage: acceptLanguageFor(language),
    screenW: screen.w,
    screenH: screen.h,
    availW: screen.w,
    // Desktop: the height left after a taskbar. Mobile: the browser's own chrome, so a phone
    // reports availHeight several dozen pixels under screen.height too.
    availH: screen.h - (mobile ? 78 : taskbarFor(screen.h)),
    colorDepth: 24,
    pixelRatio: screen.dpr,
    webGlVendor: gpu.vendor,
    webGlRenderer: gpu.renderer,
    cores,
    memory,
    touchPoints: touchPointsFor(target, seed),
    canvasNoise: true,
    audioNoise: true,
    fontsNoise: true,
    doNotTrack: false,
    spoofBattery: true,
    spoofMac: false,
    webRtcProtect: true,
    webRtcMode: 'proxy',
    geoMode: 'proxy',
    geoLat: zone ? BY_CODE.get(options.countryCode?.toUpperCase() ?? '')?.lat ?? '' : '',
    geoLng: zone ? BY_CODE.get(options.countryCode?.toUpperCase() ?? '')?.lng ?? '' : '',
    autoMatchProxy: true,
    autoUserAgent: true,
    androidVersion: 'auto',
    iosVersion: 'auto',
    fontSet,
    engineKind: engine === 'firefox' ? 'firefox' : 'chrome',
    hardwareNoise: true,
    userAgent: '',
    platform: resolved.platform,
    brand: isIosTarget(target) ? 'Safari' : engine === 'firefox' ? 'Mozilla Firefox' : brandNameFor(engine),
    userAgentOverride: '',
    browserVersion,
  };

  const identity = buildIdentity(engine, browserVersion, base, seed);
  return {
    ...base,
    userAgent: identity.userAgent,
    platform: identity.platform,
    // The brand stored on the profile is the engine's own name. Deriving it from the client-hint
    // list picked whichever of Chromium/Chrome happened to come first after the GREASE entry,
    // and an empty list (Firefox) fell through to Google Chrome.
    brand: base.brand,
    androidVersion: isAndroidTarget(target) ? androidVersionFor(target, base) : 'auto',
    iosVersion: isIosTarget(target) ? iosVersionFor(target, base) : 'auto',
  };
}

/** A plausible taskbar height for a desktop screen. */
function taskbarFor(height: number): number {
  if (height >= 2000) return 80;
  if (height >= 1300) return 48;
  return 40;
}

function fontSetFor(target: DeviceTarget): string {
  if (isIosTarget(target)) return 'ios';
  if (isAndroidTarget(target)) return 'android';
  const resolved = resolveTarget(target).resolvedOs;
  if (resolved === 'Linux') return 'linux';
  if (resolved.startsWith('macOS')) return 'macos';
  return 'windows';
}

function pickLanguage(rng: Rng, os: ResolvedOs, countryCode: string | undefined, mobile: boolean): string {
  if (countryCode) {
    const zone = BY_CODE.get(countryCode.toUpperCase());
    if (zone) return zone.langs[0]!;
  }
  if (mobile) {
    // A phone's default locale is overwhelmingly its region's.
    return rng.pick(['en-US', 'en-GB', 'en-US', 'de-DE', 'es-ES', 'fr-FR', 'pt-BR', 'ja-JP', 'en-IN']);
  }
  return rng.pick(LANG_BY_OS[os]);
}

function resolveZone(language: string, countryCode: string | undefined, rng: Rng): string {
  if (countryCode) {
    const zone = BY_CODE.get(countryCode.toUpperCase());
    if (zone) return zone.timezone;
  }
  // A language without a region would otherwise pick a timezone that contradicts it; prefer a
  // zone whose locale shares the language base.
  const base = language.split('-')[0];
  const candidates = ZONES.filter((z) => z.locale.split('-')[0] === base);
  if (candidates.length > 0) return rng.pick(candidates).timezone;
  return rng.pick(ZONES).timezone;
}

/** The twelve-surface signature two profiles must not share. */
export function signature(fp: FingerprintConfig): Record<Surface, string> {
  return {
    userAgent: fp.userAgent || '',
    platform: `${fp.platform}|${fp.deviceType}`,
    screen: `${fp.screenW}x${fp.screenH}@${fp.pixelRatio}`,
    webgl: `${fp.webGlVendor}|${fp.webGlRenderer}`,
    cores: String(fp.cores),
    memory: String(fp.memory),
    timezone: fp.timezone,
    language: `${fp.language}|${fp.acceptLanguage}`,
    fonts: fp.fontSet,
    canvas: String(fp.seed % 100000),
    audio: String(hashString(`${fp.seed}:audio`) % 100000),
    touch: `${fp.touchPoints}|${fp.spoofBattery ? 'b' : '-'}`,
  };
}

export interface UniquenessResult {
  unique: boolean;
  attempts: number;
  collisions: Partial<Record<Surface, number>>;
}

/**
 * Compare a candidate against every existing profile. `strict` requires a near-total separation
 * across the twelve surfaces. The relaxed pass refuses only the pairs a checker treats as one
 * machine - the same canvas with the same graphics card, or the same canvas on the same screen -
 * because a shared core count or a shared time zone is not a duplicate device.
 */
export function checkUniqueness(
  candidate: FingerprintConfig,
  existing: FingerprintConfig[],
  strict = true,
): UniquenessResult {
  const mine = signature(candidate);
  const collisions: Partial<Record<Surface, number>> = {};
  let collided = false;

  for (const other of existing) {
    const theirs = signature(other);
    let shared = 0;
    const sharedSurfaces = new Set<Surface>();
    for (const surface of SURFACES) {
      if (mine[surface] === theirs[surface]) {
        collisions[surface] = (collisions[surface] ?? 0) + 1;
        shared++;
        sharedSurfaces.add(surface);
      }
    }
    const fatal = strict
      ? shared >= SURFACES.length - 2
      : (sharedSurfaces.has('canvas') && (sharedSurfaces.has('webgl') || sharedSurfaces.has('screen')));
    if (fatal) collided = true;
  }

  return { unique: !collided, attempts: 1, collisions };
}

export type Relation = 'distinct' | 'linked' | 'remote';

export interface Comparison {
  relation: Relation;
  /** The strongest shared surface, when two profiles are linked. */
  surface: Surface | '';
  /** How many surfaces the two share. */
  shared: number;
  /** A sentence for the editor: "Shares WebGL renderer and screen with Shop UK". */
  summary: string;
  /** The other profile in the strongest comparison. */
  other: FingerprintConfig | null;
}

/**
 * How this identity relates to the rest of the workspace.
 *
 * "Unique" is a claim the app should only make when it is true, so this returns the strongest
 * relationship rather than a bare boolean. The editor shows the sentence; the audit page groups
 * by it; the card gets a small linked marker.
 */
export function compareWithWorkspace(
  candidate: FingerprintConfig,
  others: FingerprintConfig[],
): Comparison {
  const mine = signature(candidate);
  let best: Comparison = { relation: 'distinct', surface: '', shared: 0, summary: '', other: null };

  for (const other of others) {
    const theirs = signature(other);
    const sharedSurfaces: Surface[] = [];
    for (const surface of SURFACES) if (mine[surface] === theirs[surface]) sharedSurfaces.push(surface);
    const shared = sharedSurfaces.length;

    // Two machines with the same UA, screen, GPU, clock and touch profile are one machine to
    // any site that sees both, whatever else differs.
    const strong = sharedSurfaces.filter((s) =>
      ['webgl', 'screen', 'timezone', 'platform', 'touch', 'userAgent'].includes(s),
    );

    if (shared > best.shared) {
      const surface = (strong[0] ?? sharedSurfaces[0] ?? '') as Surface | '';
      best = {
        relation: strong.length >= 2 ? 'linked' : shared >= 8 ? 'linked' : 'remote',
        surface,
        shared,
        summary:
          strong.length >= 2
            ? `shares ${strong.slice(0, 2).map(labelOf).join(' and ')} with another profile`
            : `shares ${shared} of ${SURFACES.length} surfaces with another profile`,
        other,
      };
    }
  }

  if (best.shared === 0) best = { relation: 'distinct', surface: '', shared: 0, summary: '', other: null };
  return best;
}

export function labelOf(surface: Surface): string {
  const labels: Record<Surface, string> = {
    userAgent: 'the user agent',
    platform: 'the platform',
    screen: 'the screen',
    webgl: 'the graphics card',
    cores: 'the core count',
    memory: 'the memory',
    timezone: 'the clock',
    language: 'the language',
    fonts: 'the font list',
    canvas: 'the canvas hash',
    audio: 'the audio hash',
    touch: 'the touch profile',
  };
  return labels[surface];
}

/**
 * Roll a new identity and re-roll it until it is distinct from everything already stored.
 * After 240 attempts the loop stops instead of spinning: a wall of near-identical machines is
 * less useful than an honest profile the user can adjust by hand.
 */
export function rollUnique(
  existing: FingerprintConfig[],
  options: GenerateOptions = {},
): { fingerprint: FingerprintConfig; result: UniquenessResult } {
  let fingerprint = generateFingerprint(options);
  let result = checkUniqueness(fingerprint, existing);

  for (let attempt = 1; attempt <= 240 && !result.unique; attempt++) {
    fingerprint = generateFingerprint({ ...options, seed: Rng.seed() });
    result = checkUniqueness(fingerprint, existing);
    result.attempts = attempt + 1;
  }

  if (!result.unique) {
    // Last resort: force the rarest surfaces apart by re-rolling against a relaxed comparison.
    for (let attempt = 0; attempt < 60; attempt++) {
      fingerprint = generateFingerprint({ ...options, seed: Rng.seed() });
      const relaxed = checkUniqueness(fingerprint, existing, false);
      if (relaxed.unique) {
        result = relaxed;
        break;
      }
    }
  }

  return { fingerprint, result };
}

/** Align clock, locale and coordinates with the exit country of the proxy. */
export function alignWithProxy(
  fp: FingerprintConfig,
  countryCode: string,
  timezone: string,
): FingerprintConfig {
  if (!countryCode) return fp;
  const zone = BY_CODE.get(countryCode.toUpperCase());
  const language = zone?.langs[0] ?? fp.language;
  return {
    ...fp,
    timezone: zone?.timezone || timezone || fp.timezone,
    language,
    acceptLanguage: acceptLanguageFor(language),
    geoLat: zone?.lat ?? fp.geoLat,
    geoLng: zone?.lng ?? fp.geoLng,
  };
}

export function fontsFor(fontSet: string): string[] {
  return FONT_SETS[fontSet] ?? FONT_SETS['windows']!;
}

/**
 * The pools the editor's pickers are built from. Exported so the renderer can offer the same
 * choices the factory draws from, instead of a hand-written list that drifts.
 */
export const POOLS = {
  gpus: {
    windows: GPU_WINDOWS,
    macos: GPU_MAC,
    linux: GPU_LINUX,
    ios: GPUS_BY_TARGET.ios,
    android: GPUS_BY_TARGET.android,
  },
  coresMemory: CORES_MEMORY,
  fontSets: Object.keys(FONT_SETS),
  languages: [...new Set(Object.values(LANG_BY_OS).flat())].sort(),
  screens: SCREENS_BY_TARGET,
  hostTarget,
};
