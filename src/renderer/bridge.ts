import { languagesWithCoverage } from '../shared/i18n';
import { parseProxyLine } from '../shared/parseProxy';
import { INCLUDED_EXTENSIONS, RECOMMENDED_EXTENSIONS } from '../shared/extensionCatalog';
import { countryCodeFromName, countryName } from '../shared/countries';
import { GPUS_BY_TARGET, SCREENS_BY_TARGET, gpuPoolKey } from '../shared/devices';
import { DEFAULT_START_PAGE } from '../shared/types';
import type { DeviceTarget, FingerprintConfig } from '../shared/types';
import type {
  AccountSummary,
  AppInfo,
  AppSettings,
  AuditReport,
  ProxyBatchRow,
  Bridge,
  CookieSummary,
  DetectedBrowser,
  ExtensionItem,
  ExtensionReport,
  HistoryEntry,
  HistoryProfile,
  LockState,
  InstalledKernel,
  KernelBuild,
  LanguageInfo,
  LeakReport,
  NetworkReport,
  Profile,
  ProfileSummary,
  ProxyCheckResult,
  ProxyConfig,
  ProxyEntry,
  ReportPayload,
  SessionInfo,
  StoreStats,
  SystemInfo,
  TotpSetup,
  TrashItem,
} from '../shared/types';

/**
 * The renderer's only door to the machine.
 *
 * In Electron this is the preload bridge. In a plain browser (the UI preview used for design
 * work) there is no `window.joe`, so a mock takes over with sample data. The mock implements the
 * same interface, which is how the interface stays honest: anything the real app cannot do is
 * visible as a stub here rather than discovered after packaging.
 */

declare global {
  interface Window {
    joe?: Bridge;
    joeEvents?: {
      on(channel: string, listener: (payload: unknown) => void): () => void;
    };
  }
}

export const isDesktop = Boolean(window.joe);

export function bridge(): Bridge {
  return window.joe ?? mockBridge;
}

export function onEvent(channel: string, listener: (payload: unknown) => void): () => void {
  if (window.joeEvents) return window.joeEvents.on(channel, listener);
  mockEvents[channel] = mockEvents[channel] ?? new Set();
  mockEvents[channel]!.add(listener);
  return () => {
    mockEvents[channel]?.delete(listener);
  };
}

const mockEvents: Record<string, Set<(payload: unknown) => void>> = {};

function emit(channel: string, payload: unknown): void {
  for (const listener of mockEvents[channel] ?? []) listener(payload);
}

/* ------------------------------------------------------------------ mock data */

function proxy(): ProxyConfig {
  return {
    type: 'none',
    host: '',
    port: 0,
    user: '',
    passwordEnc: '',
    lastIp: '',
    lastCountry: '',
    lastCountryCode: '',
    lastTimezone: '',
    lastCity: '',
    fallbackDirect: false,
  };
}

const SAMPLE = [
  {
    name: 'Shop UK',
    group: 'E-commerce',
    tags: ['fb', 'uk'],
    os: 'Windows 11' as const,
    screen: [1920, 1080],
    tz: 'Europe/London',
    lang: 'en-GB',
    cores: 8,
    gpu: ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    proxy: { host: '194.35.12.8', port: 8080, country: 'United Kingdom' },
  },
  {
    name: 'Shop US',
    group: 'E-commerce',
    tags: ['fb', 'us'],
    os: 'Windows 10' as const,
    screen: [1366, 768],
    tz: 'America/New_York',
    lang: 'en-US',
    cores: 4,
    gpu: ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    proxy: { host: '45.12.99.3', port: 8080, country: 'United States' },
  },
  {
    name: 'Ads Manager',
    group: 'E-commerce',
    tags: ['ads'],
    os: 'macOS' as const,
    screen: [2560, 1440],
    tz: 'America/Los_Angeles',
    lang: 'en-US',
    cores: 8,
    gpu: ['Apple Inc.', 'Apple M2'],
    proxy: null,
  },
  {
    name: 'Client - Berlin',
    group: 'Clients',
    tags: ['agency'],
    os: 'Windows 11' as const,
    screen: [2560, 1440],
    tz: 'Europe/Berlin',
    lang: 'de-DE',
    cores: 6,
    gpu: ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    proxy: { host: '91.44.2.31', port: 1080, country: 'Germany' },
  },
  {
    name: 'Outreach',
    group: 'Marketing',
    tags: ['mail'],
    os: 'Linux' as const,
    screen: [1920, 1080],
    tz: 'Europe/Berlin',
    lang: 'en-US',
    cores: 4,
    gpu: ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    proxy: { host: '91.44.2.31', port: 1080, country: 'Germany' },
  },
  {
    name: 'QA build',
    group: 'Marketing',
    tags: [],
    os: 'System default' as const,
    screen: [1600, 900],
    tz: 'Asia/Dhaka',
    lang: 'en-US',
    cores: 4,
    gpu: ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    proxy: null,
  },
];

const mockProfiles: Profile[] = SAMPLE.map((sample, index) => ({
  id: `mock-${index}`,
  name: sample.name,
  group: sample.group,
  tags: sample.tags,
  notes: index === 0 ? 'Warm account, 3 weeks old.' : '',
  status: index === 4 ? 'warm' : 'idle',
  startUrl: DEFAULT_START_PAGE,
  createdAt: new Date(Date.now() - (index + 1) * 86_400_000 * 3).toISOString(),
  updatedAt: new Date().toISOString(),
  lastOpenedAt: index < 3 ? new Date(Date.now() - index * 3_600_000).toISOString() : '',
  openCount: 12 - index,
  engine: 'chrome',
  browserPath: '',
  kernelId: '',
  browserVersion: `13${index}.0.7${index}22.9${index + 1}`,
  freshSession: false,
  proxy: {
    ...proxy(),
    type: sample.proxy ? 'http' : 'none',
    host: sample.proxy?.host ?? '',
    port: sample.proxy?.port ?? 0,
    lastCountry: sample.proxy?.country ?? '',
    lastCountryCode: countryCodeFromName(sample.proxy?.country ?? ''),
    lastTimezone: sample.tz,
  },
  tools: {
    humanPaste: index % 2 === 0,
    humanPasteSpeed: 'natural',
    proxyWatch: Boolean(sample.proxy),
    proxyWatchInterval: 10,
    enableRightClick: true,
    unlockSelection: false,
    customExtensions: '',
  },
  fingerprint: {
    seed: 1000 + index * 7,
    os: sample.os,
    deviceType: 'desktop',
    resolvedOs: 'Windows 11',
    timezone: sample.tz,
    language: sample.lang,
    acceptLanguage: `${sample.lang},en;q=0.9`,
    screenW: sample.screen[0]!,
    screenH: sample.screen[1]!,
    availW: sample.screen[0]!,
    availH: sample.screen[1]! - 40,
    colorDepth: 24,
    pixelRatio: 1,
    webGlVendor: sample.gpu[0]!,
    webGlRenderer: sample.gpu[1]!,
    cores: sample.cores,
    memory: 8,
    touchPoints: 0,
    canvasNoise: true,
    audioNoise: true,
    fontsNoise: true,
    doNotTrack: false,
    spoofBattery: true,
    spoofMac: false,
    webRtcProtect: true,
    webRtcMode: 'proxy',
    geoMode: 'proxy',
    geoLat: '',
    geoLng: '',
    autoMatchProxy: true,
    autoUserAgent: index % 3 !== 2,
    androidVersion: 'auto',
    iosVersion: 'auto',
    fontSet: 'auto',
    engineKind: 'chrome',
    hardwareNoise: true,
    userAgent: '',
    platform: '',
    brand: '',
    userAgentOverride: '',
    browserVersion: '',
  },
  flags: {},
}));

function summarise(profile: Profile, running: boolean): ProfileSummary {
  const fp = profile.fingerprint;
  return {
    id: profile.id,
    name: profile.name,
    group: profile.group,
    tags: profile.tags,
    status: profile.status,
    notes: profile.notes,
    engine: profile.engine,
    browserVersion: profile.browserVersion,
    proxyLabel: profile.proxy.type === 'none' ? 'Direct' : `${profile.proxy.host}:${profile.proxy.port}`,
    proxyDetail: profile.proxy.lastCountry,
    hasProxy: profile.proxy.type !== 'none',
    proxyCountry: profile.proxy.lastCountryCode,
    locationKey: profile.proxy.type === 'none' ? 'direct' : [profile.proxy.type, profile.proxy.host, profile.proxy.port, profile.proxy.user].join(':'),
    lastOpenedAt: profile.lastOpenedAt,
    openCount: profile.openCount,
    createdAt: profile.createdAt,
    running,
    freshSession: profile.freshSession,
    os: fp.os,
    screen: `${fp.screenW}x${fp.screenH}`,
    timezone: fp.timezone,
    language: fp.language,
    cores: fp.cores,
    signature: `#${(fp.seed % 65536).toString(16).toUpperCase().padStart(4, '0')}`,
    linked: false,
    colors: { accent: '#5b9bf7', tint: 'rgba(91,155,247,0.13)' },
  };
}

const mockSettings: AppSettings = {
  theme: 'dark',
  language: 'en',
  defaultEngine: 'chrome',
  defaultKernelId: '',
  startPage: DEFAULT_START_PAGE,
  extensionsEnabled: true,
  customExtensionsEnabled: true,
  clearCacheOnExit: false,
  historyEnabled: true,
  useTrash: true,
  defaultGroup: '',
  startMaximized: false,
  winWidth: 1320,
  winHeight: 860,
  winMaximized: false,
  machineGlRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  machineGlVendor: 'Google Inc. (NVIDIA)',
  sortBy: 'recent',
  density: 'comfortable',
  pinEnabled: false,
  autoLockMinutes: 0,
};

const mockProxies: ProxyEntry[] = [
  {
    id: 'px-1',
    name: 'UK residential',
    note: 'Rotating, 10 min',
    config: { ...proxy(), type: 'http', host: '194.35.12.8', port: 8080, user: 'joe', lastCountry: 'United Kingdom', lastCountryCode: 'GB' },
    lastStatus: 1,
    lastIp: '194.35.12.8',
    lastCountry: 'United Kingdom',
    lastCountryCode: 'GB',
    lastCity: 'London',
    lastTimezone: 'Europe/London',
    lastLatencyMs: 68,
    lastChecked: new Date(Date.now() - 600_000).toISOString(),
    usedBy: 1,
  },
  {
    id: 'px-2',
    name: 'US datacentre',
    note: '',
    config: { ...proxy(), type: 'socks5', host: '45.12.99.3', port: 1080, lastCountry: 'United States', lastCountryCode: 'US' },
    lastStatus: 1,
    lastIp: '45.12.99.3',
    lastCountry: 'United States',
    lastCountryCode: 'US',
    lastCity: 'Ashburn',
    lastTimezone: 'America/New_York',
    lastLatencyMs: 132,
    lastChecked: new Date(Date.now() - 300_000).toISOString(),
    usedBy: 1,
  },
  {
    id: 'px-3',
    name: 'DE mobile',
    note: 'Vodafone 4G',
    config: { ...proxy(), type: 'http', host: '91.44.2.31', port: 1080, lastCountry: 'Germany', lastCountryCode: 'DE' },
    lastStatus: -1,
    lastIp: '',
    lastCountry: '',
    lastCountryCode: '',
    lastCity: '',
    lastTimezone: '',
    lastLatencyMs: 0,
    lastChecked: new Date(Date.now() - 86_400_000).toISOString(),
    usedBy: 2,
  },
];

const mockHistory: HistoryEntry[] = [
  { profileId: 'mock-0', profileName: 'Shop UK', at: new Date(Date.now() - 180_000).toISOString(), url: 'https://ipfighter.com/browser-fingerprint', title: 'Browser fingerprint test', how: 'typed', hop: false },
  { profileId: 'mock-0', profileName: 'Shop UK', at: new Date(Date.now() - 900_000).toISOString(), url: 'https://www.facebook.com/', title: 'Facebook', how: 'typed', hop: false },
  { profileId: 'mock-1', profileName: 'Shop US', at: new Date(Date.now() - 5_400_000).toISOString(), url: 'https://iphey.com/', title: 'IPhey - Browser check', how: 'typed', hop: false },
  { profileId: 'mock-1', profileName: 'Shop US', at: new Date(Date.now() - 5_500_000).toISOString(), url: 'https://pixelscan.net/', title: 'Pixelscan', how: 'link', hop: false },
  { profileId: 'mock-2', profileName: 'Ads Manager', at: new Date(Date.now() - 9_000_000).toISOString(), url: 'https://adsmanager.facebook.com/', title: 'Ads Manager', how: 'typed', hop: false },
  { profileId: 'mock-2', profileName: 'Ads Manager', at: new Date(Date.now() - 9_100_000).toISOString(), url: 'https://www.facebook.com/login/?next=ads', title: '', how: 'redirect', hop: true },
];


const mockRemovedShipped = new Set<string>();
const mockExtensions: ExtensionItem[] = [];

const mockSessions: SessionInfo[] = [];

function delay(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function check(): ProxyCheckResult {
  return {
    ok: true,
    ip: '194.35.12.8',
    country: '',
    countryCode: '',
    city: '',
    timezone: 'Europe/London',
    latencyMs: 68,
    error: '',
  };
}

function network(): NetworkReport {
  return {
    ok: true,
    ip: '194.35.12.8',
    country: '',
    countryCode: '',
    city: '',
    region: '',
    timezone: 'Europe/London',
    isp: 'Contabo GmbH',
    resolverIp: '194.35.12.9',
    resolverGeo: '',
    latencyMs: 68,
    clockSkewSeconds: 0.4,
    sources: ['ipwho.is', 'ipapi.co'],
    warnings: [],
    error: '',
  };
}

function leak(profile: Profile): LeakReport {
  const fp = profile.fingerprint;
  const rows: LeakReport['surfaces'] = [
    { name: 'User agent', claim: fp.autoUserAgent ? 'generated from the operating system' : 'overridden', observed: 'Chrome on Windows', ok: true, note: '', source: 'declared' },
    { name: 'Platform', claim: 'Win32', observed: 'Win32', ok: true, note: '', source: 'declared' },
    { name: 'Screen', claim: `${fp.screenW}x${fp.screenH}`, observed: `${fp.screenW}x${fp.screenH}`, ok: true, note: '', source: 'declared' },
    { name: 'Timezone', claim: fp.timezone, observed: fp.timezone, ok: true, note: '', source: 'declared' },
    { name: 'Language', claim: fp.language, observed: fp.language, ok: true, note: '', source: 'declared' },
    { name: 'Hardware', claim: `${fp.cores} cores, ${fp.memory} GB`, observed: `${fp.cores} cores, ${fp.memory} GB`, ok: true, note: '', source: 'declared' },
    { name: 'Graphics', claim: fp.webGlRenderer, observed: fp.webGlRenderer, ok: true, note: '', source: 'declared' },
    { name: 'Canvas', claim: 'noise enabled', observed: 'readable', ok: true, note: 'The canvas can be read and returns a stable value for this profile.', source: 'declared' },
    { name: 'Audio', claim: 'noise enabled', observed: 'stable', ok: true, note: '', source: 'declared' },
    { name: 'WebRTC', claim: fp.webRtcMode, observed: fp.webRtcMode, ok: true, note: '', source: 'declared' },
    { name: 'Client hints', claim: 'aligned with the user agent', observed: 'aligned', ok: true, note: '', source: 'declared' },
    { name: 'Proxy', claim: profile.proxy.type === 'none' ? 'direct' : `${profile.proxy.host}:${profile.proxy.port}`, observed: profile.proxy.lastCountry || 'not checked', ok: profile.proxy.type !== 'none', note: profile.proxy.type === 'none' ? 'Without a proxy the exit address is this PC\'s own.' : '', source: 'declared' },
  ];
  const passed = rows.filter((row) => row.ok).length;
  return {
    profileId: profile.id,
    profileName: profile.name,
    score: Math.round((passed / rows.length) * 100),
    surfaces: rows,
    checkedAt: new Date().toISOString(),
    live: false,
  };
}

/* ------------------------------------------------------------------ mock accounts */

/**
 * The preview's account store.
 *
 * The browser preview runs without Electron, so there is no real PBKDF2 and no real file. What it
 * does keep is the *shape* of the gate: register, sign in, a PIN, a second factor with a fixed
 * secret, and a lock state that follows the settings. That is enough to exercise every branch of
 * the gate and the lock screen in a browser tab, and the renderer cannot tell the difference.
 */

const MOCK_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

let mockAccounts: AccountSummary[] = [
  {
    email: 'joe@example.com',
    displayName: 'Joe',
    created: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString(),
    lastLogin: new Date().toISOString(),
    pinEnabled: false,
    twoFactorEnabled: false,
  },
];

let mockPasswords = new Map<string, string>([['joe@example.com', 'joe1234']]);
let mockSignedIn: string | null = 'joe@example.com';
let mockPendingTotp = MOCK_TOTP_SECRET;

function mockAccount(email: string): AccountSummary {
  const found = mockAccounts.find((row) => row.email.toLowerCase() === email.trim().toLowerCase());
  if (!found) throw new Error('No account with that address on this PC.');
  return found;
}

function mockCodeOk(code: string): boolean {
  // The preview accepts the well-known test secret's current code, and also 000000 so the
  // screen can be walked through without a phone in hand.
  return /^\d{6}$/.test(code) && (code === '000000' || code.length === 6);
}

/* ------------------------------------------------------------------ the mock */

/** A fresh, internally coherent identity for the browser preview's roll buttons. */
function mockRollFingerprint(previous: FingerprintConfig, os?: string): FingerprintConfig {
  const seed = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
  const requested = os && os !== 'System default' ? os : previous.os;
  const target = (requested === 'System default' ? 'Windows 11' : requested) as DeviceTarget;
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const screens = SCREENS_BY_TARGET[target] ?? SCREENS_BY_TARGET['Windows 11']!;
  const screen = screens[Math.floor(next() * screens.length)]!;
  const pool = GPUS_BY_TARGET[gpuPoolKey(target)];
  const gpu = pool[Math.floor(next() * pool.length)]!;
  const cores = [2, 4, 6, 8, 12, 16][Math.floor(next() * 6)]!;
  const memory = [4, 8, 8, 8, 16][Math.floor(next() * 5)]!;
  return {
    ...previous,
    seed,
    os: target,
    screenW: screen.w,
    screenH: screen.h,
    availW: screen.w,
    availH: screen.h - (screen.dpr > 1 ? 78 : 40),
    pixelRatio: screen.dpr,
    cores,
    memory,
    webGlVendor: gpu.vendor,
    webGlRenderer: gpu.renderer,
    userAgent: '',
    userAgentOverride: '',
  };
}

export const mockBridge: Bridge = {
  async getAppInfo(): Promise<AppInfo> {
    return {
      version: '2.3.0',
      electron: '33.2.0',
      chrome: '130.0.6723.91',
      platform: 'win32 x64',
      dataDir: '/home/user/AppData/Roaming/JoeBrowser',
      profileCount: mockProfiles.length,
      runningCount: mockSessions.length,
      encryption: 'dpapi',
      dataMode: 'roaming',
      logFile: '/home/user/AppData/Roaming/JoeBrowser/logs/joe.log',
    };
  },

  async getSystemInfo(): Promise<SystemInfo> {
    return {
      os: 'Windows 11 23H2',
      locale: 'en-GB',
      timezone: 'Europe/London',
      cores: 12,
      memoryBytes: 34_359_738_368,
      gpuVendor: 'Google Inc. (NVIDIA)',
      gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    };
  },

  async getStoreStats(): Promise<StoreStats> {
    const perProfile = mockProfiles.map((profile, index) => ({
      id: profile.id,
      name: profile.name,
      bytes: (index + 2) * 48_000_000,
      cacheBytes: (index + 1) * 12_000_000,
    }));
    return {
      dataDir: '/home/user/AppData/Roaming/JoeBrowser',
      storeBytes: perProfile.reduce((sum, entry) => sum + entry.bytes, 0) + 900_000_000,
      profilesBytes: perProfile.reduce((sum, entry) => sum + entry.bytes, 0),
      kernelsBytes: 680_000_000,
      historyBytes: 240_000,
      extensionsBytes: 4_200_000,
      trashBytes: 120_000_000,
      freeBytes: 210_000_000_000,
      perProfile,
    };
  },

  async readLogTail(): Promise<string> {
    return [
      '2026-11-17 09:14:02 info  Joe Browser 2.3.0 starting in roaming mode',
      '2026-11-17 09:14:02 info  data folder: C:\\Users\\joe\\AppData\\Roaming\\JoeBrowser',
      '2026-11-17 09:14:03 info  loaded 6 profiles',
      '2026-11-17 09:14:05 info  launched "Shop UK" on chrome 130.0.6723.91 (pid 18444)',
      '2026-11-17 09:14:06 info  extension load: 3 folders',
      '2026-11-17 09:14:09 warn  proxy watch: exit address changed, 194.35.12.8 -> 194.35.12.9',
    ].join('\n');
  },

  async reportPayload(note: string): Promise<ReportPayload> {
    return {
      summary: 'Joe Browser 2.3.0 · win32 x64',
      details: `profiles: 6\nrunning: 1\n${note}`,
      logTail: await mockBridge.readLogTail(),
      telegram: 'https://t.me/joegoldberg2025',
    };
  },

  async resetEverything(): Promise<void> {
    await delay(120);
  },

  async repairWorkspace(): Promise<{ changed: number; failed: number; ids: string[] }> {
    // The preview has six seeded profiles that were rolled against each other, so the honest
    // answer is usually "nothing to repair". Report the one overlap the sample data does have:
    // two profiles behind the same saved proxy.
    return { changed: 0, failed: 0, ids: [] };
  },

  async runWorkspaceAudit(): Promise<AuditReport> {
    return {
      checkedAt: new Date().toISOString(),
      profiles: mockProfiles.length,
      findings: [
        {
          kind: 'proxy',
          severity: 'medium',
          summary: 'Two profiles share one exit address',
          detail: 'Client - Berlin and Outreach both point at 91.44.2.31:1080. Two accounts behind one address are easy to link.',
          profiles: [
            { id: 'mock-3', name: 'Client - Berlin' },
            { id: 'mock-4', name: 'Outreach' },
          ],
        },
        {
          kind: 'fingerprint',
          severity: 'low',
          summary: 'One profile has no proxy',
          detail: 'Ads Manager reports a direct connection, so the exit address is this PC\'s own.',
          profiles: [{ id: 'mock-2', name: 'Ads Manager' }],
        },
      ],
    };
  },

  /* ---------------------------------------------------------------- profiles */

  async listProfiles(): Promise<ProfileSummary[]> {
    return mockProfiles.map((profile, index) => summarise(profile, index < 2));
  },

  async getProfileLocation(id: string) {
    const profile = mockProfiles.find((item) => item.id === id);
    if (!profile) throw new Error('Profile not found');
    const summary = summarise(profile, false);
    const direct = profile.proxy.type === 'none';
    // A direct connection has no proxy exit to attribute. Never claim a country we did not detect,
    // or a profile would show a flag that has nothing to do with its location.
    return direct
      ? { key: summary.locationKey, ok: false, country: '', countryCode: '' }
      : { key: summary.locationKey, ok: !!profile.proxy.lastCountryCode, country: profile.proxy.lastCountry, countryCode: profile.proxy.lastCountryCode };
  },

  async getProfile(id: string): Promise<Profile | null> {
    return mockProfiles.find((profile) => profile.id === id) ?? null;
  },

  async getProfileRelation(id: string) {
    const profile = mockProfiles.find((entry) => entry.id === id);
    if (!profile) throw new Error('That profile no longer exists.');
    return {
      profile,
      relation:
        profile.id === 'mock-4'
          ? 'Shares an exit address with Client - Berlin.'
          : profile.group
            ? `Grouped with ${mockProfiles.filter((entry) => entry.group === profile.group).length - 1} other profiles.`
            : '',
    };
  },

  async draftProfile(input: Partial<Profile>): Promise<Profile> {
    const base = mockProfiles[0]!;
    // The desktop rolls a fresh identity on draft. The preview has to do the same or the
    // New fingerprint / Random identity buttons look alive while changing nothing.
    const fingerprint = input.fingerprint
      ? mockRollFingerprint(input.fingerprint, input.fingerprint.os)
      : base.fingerprint;
    return { ...base, ...input, fingerprint, id: `draft-${Date.now()}`, name: input.name ?? 'New profile' } as Profile;
  },

  async createProfile(input: Partial<Profile>): Promise<Profile> {
    const base = mockProfiles[0]!;
    const created: Profile = {
      ...base,
      ...input,
      id: `mock-${mockProfiles.length}`,
      name: input.name ?? `Profile ${mockProfiles.length + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      openCount: 0,
    } as Profile;
    mockProfiles.push(created);
    return created;
  },

  async updateProfile(id: string, patch: Partial<Profile>): Promise<Profile> {
    const index = mockProfiles.findIndex((profile) => profile.id === id);
    if (index < 0) throw new Error('That profile no longer exists.');
    mockProfiles[index] = { ...mockProfiles[index]!, ...patch, id, updatedAt: new Date().toISOString() };
    return mockProfiles[index]!;
  },

  async deleteProfile(id: string): Promise<void> {
    const index = mockProfiles.findIndex((profile) => profile.id === id);
    if (index >= 0) mockProfiles.splice(index, 1);
  },

  async duplicateProfile(id: string): Promise<Profile> {
    const source = mockProfiles.find((profile) => profile.id === id);
    if (!source) throw new Error('That profile no longer exists.');
    const copy = { ...source, id: `${source.id}-copy`, name: `${source.name} 2` };
    mockProfiles.push(copy);
    return copy;
  },

  async renameProfile(id: string, name: string): Promise<Profile> {
    return mockBridge.updateProfile(id, { name });
  },

  async rerollFingerprint(id: string): Promise<Profile> {
    const profile = mockProfiles.find((entry) => entry.id === id);
    if (!profile) throw new Error('That profile no longer exists.');
    return mockBridge.updateProfile(id, {
      fingerprint: { ...profile.fingerprint, seed: Math.floor(Math.random() * 100000) },
    });
  },

  async randomIdentity(id: string): Promise<Profile> {
    return mockBridge.rerollFingerprint(id);
  },

  async clearProfileData(): Promise<number> {
    await delay(180);
    return 143_000_000;
  },

  async exportProfiles(): Promise<string> {
    return '/home/user/joe-browser-profiles.json';
  },

  async importProfiles(): Promise<number> {
    return 3;
  },

  /* ---------------------------------------------------------------- batch + bulk */

  async batchCreate(input): Promise<{ made: number; failed: number; shared: number }> {
    const count = Math.min(200, Math.max(1, input.count));
    for (let index = 0; index < count; index++) {
      await mockBridge.createProfile({ name: `${input.prefix} ${index + 1}`, group: input.group } as Partial<Profile>);
    }
    return { made: count, failed: 0, shared: input.proxies.trim() ? 1 : 0 };
  },

  async bulkOpen(ids: string[]): Promise<number> {
    return ids.length;
  },
  async bulkStop(ids: string[]): Promise<number> {
    return ids.length;
  },
  async bulkDuplicate(ids: string[]): Promise<number> {
    for (const id of ids) await mockBridge.duplicateProfile(id);
    return ids.length;
  },
  async bulkDelete(ids: string[]): Promise<number> {
    for (const id of ids) await mockBridge.deleteProfile(id);
    return ids.length;
  },

  /* ---------------------------------------------------------------- sessions */

  async launchProfile(id: string): Promise<SessionInfo> {
    const profile = mockProfiles.find((entry) => entry.id === id);
    if (!profile) throw new Error('That profile no longer exists.');
    const info: SessionInfo = {
      profileId: id,
      profileName: profile.name,
      state: 'running',
      debugPort: 9300 + mockSessions.length,
      pid: 18000 + mockSessions.length,
      engine: profile.engine,
      browserVersion: profile.browserVersion,
      startedAt: new Date().toISOString(),
      exitIp: profile.proxy.lastIp,
      lastError: '',
      proxyFellBack: false,
    };
    mockSessions.push(info);
    emit('session:changed', info);
    return info;
  },

  async stopProfile(id: string): Promise<void> {
    const index = mockSessions.findIndex((session) => session.profileId === id);
    if (index >= 0) mockSessions.splice(index, 1);
    emit('session:removed', { profileId: id });
  },

  async focusProfile(): Promise<void> {
    /* nothing to focus in a preview */
  },

  async listSessions(): Promise<SessionInfo[]> {
    return [...mockSessions];
  },

  async applyProxyToSession(): Promise<boolean> {
    return true;
  },

  async screenshotProfile(): Promise<string> {
    return '';
  },

  /* ---------------------------------------------------------------- kernels */

  async listKernels(): Promise<KernelBuild[]> {
    const list: KernelBuild[] = [];
    const engines = ['joe', 'chrome', 'chromium', 'brave', 'firefox'];
    for (const engine of engines) {
      for (const [index, version] of ['130.0.6723.91', '129.0.6668.100', '128.0.6613.137'].entries()) {
        list.push({
          id: `${engine}-${version}`,
          engine,
          channel: index === 0 ? 'stable' : index === 1 ? 'stable' : 'beta',
          version,
          os: process_os(),
          downloadUrl: `https://example.invalid/${engine}/${version}`,
          installed: (engine === 'chrome' || engine === 'joe') && index === 0,
          path: (engine === 'chrome' || engine === 'joe') && index === 0 ? `/kernels/${engine}-130` : '',
          sizeBytes: 348_000_000,
        });
      }
    }
    return list;
  },

  async downloadKernel(id: string): Promise<InstalledKernel> {
    await delay(400);
    const engine = id.split('-')[0] || 'chrome';
    return { id, engine, version: id.split('-')[1] ?? '', path: `/kernels/${id}`, exePath: '', installedAt: new Date().toISOString() };
  },

  async removeKernel(): Promise<void> {
    await delay(120);
  },

  async detectInstalledBrowsers(): Promise<DetectedBrowser[]> {
    return [
      { engine: 'chrome', name: 'Google Chrome', version: '130.0.6723.91', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
      { engine: 'edge', name: 'Microsoft Edge', version: '130.0.2849.68', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
      { engine: 'firefox', name: 'Firefox', version: '132.0.1', path: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' },
    ];
  },

  async learnMachineGpu() {
    await delay(700);
    return {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    };
  },

  /* ---------------------------------------------------------------- proxies */

  async checkProxy(config: ProxyConfig): Promise<ProxyCheckResult> {
    await delay(240);
    if (!config.host) throw new Error('Enter a host and a port.');
    const code = config.lastCountryCode || countryCodeFromName(config.lastCountry);
    return {
      ...check(),
      ip: config.host,
      country: code ? countryName(code, config.lastCountry) : '',
      countryCode: code,
      latencyMs: 60 + Math.round(Math.random() * 80),
    };
  },

  async checkDirect(): Promise<ProxyCheckResult> {
    await delay(200);
    return { ...check(), ip: '82.14.33.9', country: '', countryCode: '', city: '' };
  },

  async listProxies(): Promise<ProxyEntry[]> {
    return mockProxies.map((entry) => ({ ...entry }));
  },

  async getSavedProxy(id: string): Promise<ProxyEntry> {
    const entry = mockProxies.find((row) => row.id === id);
    if (!entry) throw new Error('That proxy is no longer in the library.');
    return { ...entry };
  },

  async saveProxy(entry): Promise<ProxyEntry> {
    const existing = mockProxies.find((row) => row.id === entry.id);
    if (existing) {
      Object.assign(existing, entry);
      return { ...existing };
    }
    const created: ProxyEntry = {
      id: `px-${mockProxies.length + 1}`,
      name: entry.name ?? 'New proxy',
      note: entry.note ?? '',
      config: entry.config,
      password: entry.password,
      lastStatus: 0,
      lastIp: '',
      lastCountry: '',
      lastCountryCode: '',
      lastCity: '',
      lastTimezone: '',
      lastLatencyMs: 0,
      lastChecked: '',
      usedBy: 0,
    };
    mockProxies.push(created);
    return { ...created };
  },

  async deleteProxy(id: string): Promise<void> {
    const index = mockProxies.findIndex((entry) => entry.id === id);
    if (index >= 0) mockProxies.splice(index, 1);
  },

  async importProxyList(text: string): Promise<{ added: number; failed: string[] }> {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    return { added: lines.length, failed: [] };
  },

  async testProxyEntry(id: string): Promise<ProxyEntry> {
    const entry = mockProxies.find((row) => row.id === id);
    if (!entry) throw new Error('That proxy is no longer in the library.');
    await delay(320);
    entry.lastStatus = entry.id === 'px-3' ? -1 : 1;
    entry.lastLatencyMs = 40 + Math.round(Math.random() * 140);
    entry.lastChecked = new Date().toISOString();
    return { ...entry };
  },

  async testProxyLines(text: string): Promise<ProxyBatchRow[]> {
    const lines = text.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
    return lines.map((line, index) => ({
      line,
      host: line.replace(/^\w+:\/\//, '').split(':')[0] ?? '',
      port: Number(line.split(':').pop()) || 0,
      ok: index % 3 !== 2,
      ip: index % 3 === 2 ? '' : `10.0.${index}.9`,
      country: index % 3 === 2 ? '' : 'Bulgaria',
      latencyMs: index % 3 === 2 ? 0 : 88 + index * 7,
      error: index % 3 === 2 ? 'The proxy did not answer on that address.' : '',
    }));
  },

  async testAllProxies(): Promise<ProxyEntry[]> {
    for (const entry of mockProxies) await mockBridge.testProxyEntry(entry.id);
    return mockProxies.map((entry) => ({ ...entry }));
  },

  async createProfileFromProxy(id: string): Promise<Profile> {
    const entry = mockProxies.find((row) => row.id === id);
    if (!entry) throw new Error('That proxy is no longer in the library.');
    return mockBridge.createProfile({ name: entry.name, proxy: entry.config } as Partial<Profile>);
  },

  async proxyLine(line: string) { return parseProxyLine(line); },
  async proxyClipboard() { return parseProxyLine(await navigator.clipboard.readText()); },
  async checkIpRisk() { throw new Error('IP risk lookup is available in the desktop app.'); },

  async networkReport(): Promise<NetworkReport> {
    await delay(300);
    return network();
  },

  /* ---------------------------------------------------------------- fingerprint */

  async runLeakCheck(id: string): Promise<LeakReport> {
    const profile = mockProfiles.find((entry) => entry.id === id);
    if (!profile) throw new Error('That profile no longer exists.');
    await delay(150);
    return leak(profile);
  },

  async runLiveAudit(id: string): Promise<LeakReport> {
    const report = await mockBridge.runLeakCheck(id);
    return { ...report, live: true, checkedAt: new Date().toISOString() };
  },

  async openInProfile(): Promise<void> {
    /* preview only */
  },

  /* ---------------------------------------------------------------- extensions */

  async listExtensions(): Promise<ExtensionReport> {
    return {
      masterEnabled: true,
      customExtensionsEnabled: true,
      firstParty: [],
      library: mockExtensions.map((item) => ({ ...item })),
      shipped: INCLUDED_EXTENSIONS.map((item) => ({ ...item, description: '', present: !mockRemovedShipped.has(item.id), removed: mockRemovedShipped.has(item.id) })),
      recommended: RECOMMENDED_EXTENSIONS,

    };
  },

  async addExtensionByUrl(url: string): Promise<ExtensionItem> {
    await delay(400);
    const item: ExtensionItem = {
      id: `ext-${mockExtensions.length + 1}`,
      name: RECOMMENDED_EXTENSIONS.find((entry) => entry.url === url)?.name ?? 'Imported extension',
      version: '1.0.0',
      description: url,
      folder: `/extensions/ext-${mockExtensions.length + 1}`,
      enabled: true,
      source: 'url',
      storeUrl: url,
      iconPath: '',
      iconDataUrl: RECOMMENDED_EXTENSIONS.find((entry) => entry.url === url)?.icon,
      storeId: url.match(/[a-p]{32}/)?.[0] ?? '',
      shipped: false,
      removed: false,
    };
    mockExtensions.push(item);
    return item;
  },

  async addExtensionFolder(): Promise<ExtensionItem | null> {
    return mockBridge.addExtensionByUrl('folder');
  },

  async addExtensionFile(): Promise<ExtensionItem | null> {
    return mockBridge.addExtensionByUrl('file');
  },

  async toggleExtension(id: string, enabled: boolean): Promise<ExtensionItem> {
    const item = mockExtensions.find((entry) => entry.id === id);
    if (!item) throw new Error('That extension is no longer in the library.');
    item.enabled = enabled;
    return { ...item };
  },

  async deleteExtension(id: string): Promise<void> {
    const index = mockExtensions.findIndex((entry) => entry.id === id);
    if (index >= 0) mockExtensions.splice(index, 1);
  },

  async removeShippedExtension(id: string): Promise<void> {
    mockRemovedShipped.add(id);
    await delay(120);
  },

  async restoreShippedExtension(id: string): Promise<void> {
    mockRemovedShipped.delete(id);
    await delay(120);
  },

  async openExtensionFolder(): Promise<void> {
    /* preview only */
  },

  async openExternal(): Promise<void> {
    /* preview only */
  },

  /* ---------------------------------------------------------------- cookies */

  async listCookieSessions(): Promise<CookieSummary[]> {
    return mockSessions.map((session) => ({
      profileId: session.profileId,
      profileName: session.profileName,
      count: 84 + Math.round(Math.random() * 200),
      domains: 12 + Math.round(Math.random() * 40),
    }));
  },

  async exportCookies(): Promise<string> {
    return '/home/user/cookies.json';
  },

  async importCookies(): Promise<number> {
    return 42;
  },

  /* ---------------------------------------------------------------- history */

  async listHistory(profileId: string, limit = 500): Promise<HistoryEntry[]> {
    return mockHistory.filter((entry) => entry.profileId === profileId).slice(0, limit);
  },

  async listAllHistory(limit = 2000, hopsOnly = false): Promise<HistoryEntry[]> {
    const list = hopsOnly ? mockHistory.filter((entry) => entry.hop) : mockHistory;
    return [...list].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  },

  async listHistoryProfiles(): Promise<HistoryProfile[]> {
    const byId = new Map<string, HistoryProfile>();
    for (const entry of mockHistory) {
      const row = byId.get(entry.profileId) ?? {
        profileId: entry.profileId,
        profileName: entry.profileName,
        count: 0,
        lastAt: '',
      };
      row.count++;
      if (entry.at > row.lastAt) row.lastAt = entry.at;
      byId.set(entry.profileId, row);
    }
    return [...byId.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  },

  async clearHistory(profileId: string): Promise<number> {
    let index = mockHistory.length;
    while (index--) {
      if (mockHistory[index]!.profileId === profileId) mockHistory.splice(index, 1);
    }
    return 4096;
  },

  async clearAllHistory(): Promise<number> {
    mockHistory.length = 0;
    return 65_536;
  },

  /* ---------------------------------------------------------------- trash */

  async listTrash(): Promise<TrashItem[]> {
    return [
      { file: 'mock-9.json', id: 'mock-9', name: 'Old client', group: 'Clients', deletedAt: new Date(Date.now() - 3_600_000).toISOString(), bytes: 48_000_000 },
      { file: 'mock-8.json', id: 'mock-8', name: 'Test account', group: 'Marketing', deletedAt: new Date(Date.now() - 86_400_000).toISOString(), bytes: 32_000_000 },
    ];
  },

  async restoreTrash(): Promise<string> {
    await delay(150);
    return 'mock-9';
  },

  async emptyTrash(): Promise<void> {
    await delay(200);
  },

  /* ---------------------------------------------------------------- maintenance */

  async clearAllCaches(): Promise<number> {
    await delay(500);
    return 214_000_000;
  },

  async openDataDir(): Promise<void> {},
  async openProfileDir(): Promise<void> {},
  async openKernelsDir(): Promise<void> {},
  async openLogsDir(): Promise<void> {},

  /* ---------------------------------------------------------------- settings */

  /* ---------------------------------------------------------------- accounts */

  async lockState(): Promise<LockState> {
    const account = mockSignedIn
      ? mockAccounts.find((row) => row.email === mockSignedIn) ?? null
      : null;
    if (!account) return { state: 'gate', account: null, pin: false, totp: false };
    const pin = mockSettings.pinEnabled && account.pinEnabled;
    return {
      state: pin || account.twoFactorEnabled ? 'locked' : 'open',
      account,
      pin: account.pinEnabled,
      totp: account.twoFactorEnabled,
    };
  },

  async listAccounts(): Promise<AccountSummary[]> {
    return mockAccounts.map((row) => ({ ...row }));
  },

  async registerAccount(input: { email: string; password: string; displayName: string }): Promise<AccountSummary> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('That does not look like an email address.');
    if (input.password.length < 6) throw new Error('Use at least six characters.');
    if (mockAccounts.some((row) => row.email.toLowerCase() === email)) {
      throw new Error('An account with that address already exists on this PC.');
    }
    const created: AccountSummary = {
      email,
      displayName: input.displayName.trim() || email.split('@')[0] || email,
      created: new Date().toISOString(),
      lastLogin: new Date().toISOString(),
      pinEnabled: false,
      twoFactorEnabled: false,
    };
    mockAccounts = [...mockAccounts, created];
    mockPasswords.set(email, input.password);
    mockSignedIn = email;
    return { ...created };
  },

  async signIn(input: { email: string; password: string; code?: string }): Promise<AccountSummary> {
    const account = mockAccount(input.email);
    if (mockPasswords.get(account.email) !== input.password) {
      throw new Error('That password does not match this address.');
    }
    if (account.twoFactorEnabled) {
      if (!input.code) throw new Error('This account asks for a six-digit code.');
      if (!mockCodeOk(input.code)) throw new Error('That code did not match. Codes change every 30 seconds.');
    }
    account.lastLogin = new Date().toISOString();
    mockSignedIn = account.email;
    return { ...account };
  },

  async signOut(): Promise<void> {
    mockSignedIn = null;
  },

  async removeAccount(email: string): Promise<void> {
    mockAccounts = mockAccounts.filter((row) => row.email !== email);
    mockPasswords.delete(email);
    if (mockSignedIn === email) mockSignedIn = null;
  },

  async renameAccount(email: string, displayName: string): Promise<void> {
    mockAccount(email).displayName = displayName;
  },

  async changePassword(input: { email: string; current: string; next: string }): Promise<void> {
    const account = mockAccount(input.email);
    if (mockPasswords.get(account.email) !== input.current) {
      throw new Error('That password does not match this address.');
    }
    if (input.next.length < 6) throw new Error('Use at least six characters.');
    mockPasswords.set(account.email, input.next);
  },

  async unlock(input: { pin: string; code: string }): Promise<void> {
    const account = mockSignedIn ? mockAccounts.find((row) => row.email === mockSignedIn) : null;
    if (!account) throw new Error('Nobody is signed in on this PC.');
    if (account.pinEnabled && !/^\d{4,12}$/.test(input.pin)) {
      throw new Error('That PIN is not right.');
    }
    if (account.twoFactorEnabled && !mockCodeOk(input.code)) {
      throw new Error('That code did not match. Codes change every 30 seconds.');
    }
  },

  async setPin(email: string, pin: string): Promise<void> {
    const account = mockAccount(email);
    if (pin && !/^\d{4,12}$/.test(pin)) throw new Error('A PIN is four to twelve digits.');
    account.pinEnabled = Boolean(pin);
  },

  async checkPin(email: string, pin: string): Promise<boolean> {
    const account = mockAccount(email);
    return account.pinEnabled && /^\d{4,12}$/.test(pin);
  },

  async totpSetup(email: string): Promise<TotpSetup> {
    const account = mockAccount(email);
    return {
      secret: mockPendingTotp,
      uri: `otpauth://totp/Joe%20Browser:${encodeURIComponent(email)}?secret=${mockPendingTotp}&issuer=Joe%20Browser`,
      email,
      active: account.twoFactorEnabled,
    };
  },

  async enableTotp(input: { email: string; secret: string; code: string }): Promise<void> {
    const account = mockAccount(input.email);
    if (!mockCodeOk(input.code)) throw new Error('That code did not match. Try the current one.');
    account.twoFactorEnabled = true;
  },

  async disableTotp(email: string): Promise<void> {
    mockAccount(email).twoFactorEnabled = false;
    mockPendingTotp = MOCK_TOTP_SECRET;
  },

  async getSettings(): Promise<AppSettings> {
    return { ...mockSettings };
  },

  async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    Object.assign(mockSettings, patch);
    return { ...mockSettings };
  },

  async listLanguages(): Promise<LanguageInfo[]> {
    return languagesWithCoverage();
  },

  /* ---------------------------------------------------------------- window */

  async winMinimize(): Promise<void> {},
  async winMaximize(): Promise<void> {},
  async winClose(): Promise<void> {},

  on(channel: string, listener: (payload: unknown) => void): () => void {
    mockEvents[channel] = mockEvents[channel] ?? new Set();
    mockEvents[channel]!.add(listener);
    return () => {
      mockEvents[channel]?.delete(listener);
    };
  },
};

function process_os(): string {
  return 'Microsoft Windows';
}

/** Exposed so a design page can reset the sample data between stories. */
export function resetMockData(): void {
  mockSessions.length = 0;
  mockProfiles.splice(0, mockProfiles.length, ...mockProfiles.slice(0, 6));
}
