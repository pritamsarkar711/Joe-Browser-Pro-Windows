/**
 * The contract between the main process and the renderer.
 *
 * Everything the UI can ask for is declared on `Bridge`, and everything it can be told is on
 * `MainEvents`. The renderer never imports Node; it only ever sees this file.
 */

export type ProxyType = 'none' | 'http' | 'https' | 'socks5';

export type DeviceType = 'desktop' | 'mobile' | 'tablet';

/**
 * Device targets, matching the original's seven-option picker. "System default" means the
 * platform this app is running on, which is what a real browser on this PC would report.
 */
export type DeviceTarget =
  | 'System default'
  | 'Windows 11'
  | 'Windows 10'
  | 'macOS'
  | 'Linux'
  | 'Android'
  | 'iPhone'
  | 'iPad';

/** The concrete operating system a target resolves to. */
export type ResolvedOs = 'Windows 11' | 'Windows 10' | 'macOS 15' | 'macOS 14' | 'Linux';

export type GeoMode = 'proxy' | 'system' | 'custom' | 'block';

export interface ProxyConfig {
  type: ProxyType;
  host: string;
  port: number;
  user: string;
  /** Never persisted in the clear; the store keeps only `passwordEnc`. */
  password?: string;
  passwordEnc: string;
  lastIp: string;
  lastCountry: string;
  lastCountryCode: string;
  lastTimezone: string;
  lastCity: string;
  /** Keep the session alive on a direct connection when the proxy stops answering. */
  fallbackDirect: boolean;
}

export interface ToolConfig {
  humanPaste: boolean;
  /** relaxed | natural | fast | instant */
  humanPasteSpeed: string;
  proxyWatch: boolean;
  proxyWatchInterval: number;
  enableRightClick: boolean;
  unlockSelection: boolean;
  /** One absolute path per line. */
  customExtensions: string;
}

export interface FingerprintConfig {
  seed: number;
  /** The picker value: a DeviceTarget. `deviceType` and `resolvedOs` follow from it. */
  os: DeviceTarget;
  deviceType: DeviceType;
  /** The concrete OS string the profile reports, derived from `os`. */
  resolvedOs: ResolvedOs;
  /** IANA name, e.g. Europe/London. */
  timezone: string;
  language: string;
  acceptLanguage: string;
  screenW: number;
  screenH: number;
  availW: number;
  availH: number;
  colorDepth: number;
  pixelRatio: number;
  webGlVendor: string;
  webGlRenderer: string;
  cores: number;
  memory: number;
  touchPoints: number;
  canvasNoise: boolean;
  audioNoise: boolean;
  fontsNoise: boolean;
  doNotTrack: boolean;
  spoofBattery: boolean;
  spoofMac: boolean;
  webRtcProtect: boolean;
  /** off | proxy | public */
  webRtcMode: string;
  geoMode: GeoMode;
  geoLat: string;
  geoLng: string;
  autoMatchProxy: boolean;
  autoUserAgent: boolean;
  /** auto, or an Android version such as "14". */
  androidVersion: string;
  /** auto, or an iOS version such as "17.5". */
  iosVersion: string;
  /** auto | windows | macos | linux | minimal */
  fontSet: string;
  /** auto | chrome | firefox: which engine the UA is generated for. */
  engineKind: string;
  hardwareNoise: boolean;
  /** Filled in at launch; not persisted. */
  userAgent: string;
  platform: string;
  brand: string;
  userAgentOverride: string;
  browserVersion: string;
}

export interface Profile {
  id: string;
  name: string;
  group: string;
  tags: string[];
  notes: string;
  /** Free-form account status marker, as in the original. */
  status: string;
  startUrl: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  openCount: number;
  /** Engine key, e.g. chromium | chrome | brave | edge | firefox | custom */
  engine: string;
  /** A custom executable, used when engine is 'custom'. */
  browserPath: string;
  /** Folder name inside the kernels directory, or '' to follow the app default. */
  kernelId: string;
  /** Full version the profile claims, e.g. 157.0.8103.41 */
  browserVersion: string;
  /** Clear cookies, storage and history when this profile closes. */
  freshSession: boolean;
  proxy: ProxyConfig;
  tools: ToolConfig;
  fingerprint: FingerprintConfig;
  /** Per-profile clipboard-paste marker so Firefox and Chromium do not double-type. */
  flags: Record<string, boolean>;
}

export interface ProfileSummary {
  id: string;
  name: string;
  group: string;
  tags: string[];
  status: string;
  notes: string;
  engine: string;
  browserVersion: string;
  proxyLabel: string;
  proxyDetail: string;
  hasProxy: boolean;
  proxyCountry: string;
  /** Opaque connection fingerprint used to discard outdated location lookups. */
  locationKey: string;
  lastOpenedAt: string;
  openCount: number;
  createdAt: string;
  running: boolean;
  freshSession: boolean;
  os: DeviceTarget;
  screen: string;
  timezone: string;
  language: string;
  cores: number;
  /** Short signature of the identity, shown on the card. */
  signature: string;
  /** True when another profile in the workspace shares a strong surface with this one. */
  linked: boolean;
  colors: { accent: string; tint: string };
}

export type SortMode = 'recent' | 'name' | 'created' | 'running' | 'os' | 'group';

export interface KernelBuild {
  /** Stable identity: engine + version + channel. */
  id: string;
  engine: string;
  channel: string;
  version: string;
  /** 'Microsoft Windows' etc, shown on the card. */
  os: string;
  downloadUrl: string;
  /** Vendor-provided SHA-256 for a verified archive, when available. */
  sha256?: string;
  /** Underlying browser engine version when it differs from the product version. */
  runtimeVersion?: string;
  installed: boolean;
  /** Populated once installed. */
  path: string;
  sizeBytes: number;
}

export interface InstalledKernel {
  id: string;
  engine: string;
  version: string;
  path: string;
  exePath: string;
  runtimeVersion?: string;
  installedAt: string;
}

export interface DetectedBrowser {
  engine: string;
  name: string;
  version: string;
  path: string;
}

export type LaunchState = 'starting' | 'running' | 'closing' | 'stopped' | 'failed';

export interface SessionInfo {
  profileId: string;
  profileName: string;
  state: LaunchState;
  debugPort: number;
  pid: number;
  engine: string;
  browserVersion: string;
  startedAt: string;
  exitIp: string;
  lastError: string;
  /** True when the proxy failed and the session opened directly. */
  proxyFellBack: boolean;
}

export interface ProxyBatchRow {
  /** The line as the user pasted it, so a failure can be pointed at. */
  line: string;
  host: string;
  port: number;
  ok: boolean;
  ip: string;
  country: string;
  latencyMs: number;
  error: string;
}

export interface ProfileLocation {
  key: string;
  country: string;
  countryCode: string;
  ok: boolean;
}

export interface ProxyCheckResult {
  ok: boolean;
  ip: string;
  country: string;
  countryCode: string;
  city: string;
  timezone: string;
  latencyMs: number;
  error: string;
}

/** One saved proxy in the library. */
export interface ProxyEntry {
  id: string;
  name: string;
  note: string;
  config: ProxyConfig;
  /** The decrypted password, only ever present in transit. */
  password?: string;
  /** 0 = never checked, 1 = working, -1 = failed. */
  lastStatus: number;
  lastIp: string;
  lastCountry: string;
  lastCountryCode: string;
  lastCity: string;
  lastTimezone: string;
  lastLatencyMs: number;
  lastChecked: string;
  /** Which profiles currently point at this proxy. */
  usedBy: number;
}

export interface NetworkReport {
  ok: boolean;
  ip: string;
  country: string;
  countryCode: string;
  city: string;
  region: string;
  timezone: string;
  isp: string;
  resolverIp: string;
  resolverGeo: string;
  latencyMs: number;
  /** Seconds between this machine's clock and the internet's, or null when unknown. */
  clockSkewSeconds: number | null;
  /** Which lookup services answered, e.g. ["ipwho.is", "ipapi.co"]. */
  sources: string[];
  warnings: string[];
  error: string;
}

export interface LeakSurface {
  name: string;
  claim: string;
  observed: string;
  ok: boolean;
  note: string;
  /** live = read from the running browser; declared = read from the stored identity. */
  source: 'live' | 'declared';
}

export interface LeakReport {
  profileId: string;
  profileName: string;
  score: number;
  surfaces: LeakSurface[];
  checkedAt: string;
  live: boolean;
}

/** The workspace audit: profiles that share a fingerprint, proxy or build. */
export interface AuditFinding {
  kind: 'fingerprint' | 'proxy' | 'kernel' | 'seed';
  severity: 'high' | 'medium' | 'low';
  summary: string;
  detail: string;
  profiles: { id: string; name: string }[];
}

export interface AuditReport {
  checkedAt: string;
  profiles: number;
  findings: AuditFinding[];
}

export interface CookieRecord {
  domain: string;
  name: string;
  value: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

export interface CookieSummary {
  profileId: string;
  profileName: string;
  count: number;
  domains: number;
}

/**
 * One entry in the extension library. `source` records how it got there, which decides how it
 * is removed: a shipped extension is restored from the app, an imported one is just deleted.
 */
export interface ExtensionItem {
  id: string;
  name: string;
  version: string;
  description: string;
  folder: string;
  enabled: boolean;
  /** url | folder | file | builtin */
  source: string;
  storeUrl: string;
  /** Absolute path of the icon inside the package, or '' when it ships none. */
  iconPath: string;
  /** Safe, bounded image data for the sandboxed renderer. */
  iconDataUrl?: string;
  /** The id the extension is known by on the store, recovered from the manifest key. */
  storeId: string;
  /** True when this is one of the app's own written extensions. */
  shipped: boolean;
  /** True when the user removed a shipped extension and has not restored it. */
  removed: boolean;
}

export interface ExtensionReport {
  masterEnabled: boolean;
  customExtensionsEnabled: boolean;
  /** The three first-party tool scripts, always written by the app. */
  firstParty: { id: string; name: string; description: string; enabled: boolean }[];
  /** Everything in the library. */
  library: ExtensionItem[];
  /** The two included extensions and whether each is present. */
  shipped: { id: string; name: string; description: string; present: boolean; removed: boolean; icon: string }[];
  recommended: { name: string; description: string; url: string; icon: string }[];
}

export interface AppSettings {
  theme: 'dark' | 'light';
  language: string;
  /** auto | chrome | chromium | edge | brave | firefox */
  defaultEngine: string;
  defaultKernelId: string;
  startPage: string;
  extensionsEnabled: boolean;
  customExtensionsEnabled: boolean;
  clearCacheOnExit: boolean;
  /** Master switch for the per-profile history recorder. */
  historyEnabled: boolean;
  /** Keep deleted profiles in the recycle bin instead of erasing them. */
  useTrash: boolean;
  /** Group assigned to profiles created with Batch create. */
  defaultGroup: string;
  /** Open the window maximised. */
  startMaximized: boolean;
  /** Restored window geometry from the last session. */
  winWidth: number;
  winHeight: number;
  winMaximized: boolean;
  /** The graphics card this PC really has, learned from a launched browser. */
  machineGlRenderer: string;
  machineGlVendor: string;
  /** Sort order for the profile grid. */
  sortBy: SortMode;
  /** Show the profile grid as cards or as dense rows. */
  density: 'comfortable' | 'compact';
  /** Ask for a PIN when the app starts. */
  pinEnabled: boolean;
  /** Auto-lock the window after this many idle minutes; 0 disables. */
  autoLockMinutes: number;
}

/**
 * A local account.
 *
 * Not a cloud identity: there is no server and no sync. It names the person using this
 * workspace and holds the app lock - a PIN typed at launch and an optional authenticator code.
 */
export interface AccountSummary {
  email: string;
  displayName: string;
  created: string;
  lastLogin: string;
  pinEnabled: boolean;
  twoFactorEnabled: boolean;
}

/** The stored record. The hash fields never cross the IPC boundary. */
export interface Account {
  email: string;
  displayName: string;
  salt: string;
  hash: string;
  iterations: number;
  created: string;
  lastLogin: string;
  pinEnabled: boolean;
  pinSalt: string;
  pinHash: string;
  totpSecret: string;
  /** A candidate secret that has been shown as a QR but not yet proven with a code. */
  totpPending: string;
}

/**
 * What the window must do before it may paint the workspace.
 *
 * `gate`   - no account exists; show the welcome screen.
 * `locked` - a session exists but a PIN or a code is configured.
 * `open`   - nothing stands between the user and their profiles.
 */
export interface LockState {
  state: 'gate' | 'locked' | 'open';
  account: AccountSummary | null;
  pin: boolean;
  totp: boolean;
}

export interface TotpSetup {
  secret: string;
  /** An otpauth:// URI; the renderer draws the QR from it, so no bitmap crosses the bridge. */
  uri: string;
  email: string;
  /** True when this secret is already active rather than a new candidate. */
  active: boolean;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  platform: string;
  dataDir: string;
  profileCount: number;
  runningCount: number;
  /** dpapi | aes | none */
  encryption: string;
  /** Where this build keeps its data: roaming %APPDATA% or a portable folder. */
  dataMode: 'roaming' | 'portable';
  logFile: string;
}

export interface HistoryEntry {
  profileId: string;
  profileName: string;
  at: string;
  url: string;
  title: string;
  /** typed | link | reload | redirect — `redirect` is what the original called a hop. */
  how: string;
  /** True when the page was only passed through on the way to another. */
  hop: boolean;
}

export interface HistoryProfile {
  profileId: string;
  profileName: string;
  count: number;
  lastAt: string;
}

export interface StoreStats {
  dataDir: string;
  storeBytes: number;
  profilesBytes: number;
  kernelsBytes: number;
  historyBytes: number;
  extensionsBytes: number;
  trashBytes: number;
  freeBytes: number;
  /** Every profile folder with its size, for the "clear cache (143 MB)" labels. */
  perProfile: { id: string; name: string; bytes: number; cacheBytes: number }[];
}

export interface TrashItem {
  file: string;
  id: string;
  name: string;
  group: string;
  deletedAt: string;
  bytes: number;
}

export interface ToastPayload {
  kind: 'info' | 'success' | 'warn' | 'error';
  message: string;
  detail: string;
}

export interface ReportPayload {
  summary: string;
  details: string;
  logTail: string;
  telegram: string;
}

export interface SystemInfo {
  os: string;
  locale: string;
  timezone: string;
  cores: number;
  memoryBytes: number;
  gpuVendor: string;
  gpuRenderer: string;
}

export interface LanguageInfo {
  key: string;
  /** ISO country code, rendered as a flag badge. */
  flag: string;
  english: string;
  native: string;
  /** Share of the interface this language actually covers, 0–100. */
  coverage: number;
}

export interface Bridge {
  getAppInfo(): Promise<AppInfo>;
  getSystemInfo(): Promise<SystemInfo>;

  listProfiles(): Promise<ProfileSummary[]>;
  getProfile(id: string): Promise<Profile | null>;
  getProfileLocation(id: string): Promise<ProfileLocation>;
  /** The stored profile plus a sentence describing anything it shares with the workspace. */
  getProfileRelation(id: string): Promise<{ profile: Profile; relation: string }>;
  draftProfile(input: Partial<Profile>): Promise<Profile>;
  createProfile(input: Partial<Profile> & { preserveFingerprint?: boolean }): Promise<Profile>;
  updateProfile(id: string, patch: Partial<Profile>): Promise<Profile>;
  deleteProfile(id: string): Promise<void>;
  duplicateProfile(id: string): Promise<Profile>;
  rerollFingerprint(id: string): Promise<Profile>;
  /** Roll a whole new identity, including the device target. */
  randomIdentity(id: string): Promise<Profile>;
  renameProfile(id: string, name: string): Promise<Profile>;
  clearProfileData(id: string, scope: 'cache' | 'cookies' | 'siteData' | 'everything'): Promise<number>;

  /* batch + bulk */
  batchCreate(input: { prefix: string; count: number; group: string; proxies: string }): Promise<{ made: number; failed: number; shared: number }>;
  bulkOpen(ids: string[]): Promise<number>;
  bulkStop(ids: string[]): Promise<number>;
  bulkDuplicate(ids: string[]): Promise<number>;
  bulkDelete(ids: string[]): Promise<number>;

  /* launch */
  launchProfile(id: string, url?: string): Promise<SessionInfo>;
  stopProfile(id: string): Promise<void>;
  focusProfile(id: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;

  /* kernels + browsers */
  listKernels(): Promise<KernelBuild[]>;
  downloadKernel(id: string): Promise<InstalledKernel>;
  removeKernel(id: string): Promise<void>;
  detectInstalledBrowsers(): Promise<DetectedBrowser[]>;
  /** Launch a throwaway profile to read the graphics card this PC really has. */
  learnMachineGpu(): Promise<{ vendor: string; renderer: string }>;

  /* proxies */
  checkProxy(config: ProxyConfig, password?: string): Promise<ProxyCheckResult>;
  checkDirect(): Promise<ProxyCheckResult>;
  listProxies(): Promise<ProxyEntry[]>;
  /** Resolve credentials only when the user selects a saved proxy. */
  getSavedProxy(id: string): Promise<ProxyEntry>;
  saveProxy(entry: Partial<ProxyEntry> & { config: ProxyConfig; replacePassword?: boolean }): Promise<ProxyEntry>;
  deleteProxy(id: string): Promise<void>;
  importProxyList(text: string): Promise<{ added: number; failed: string[] }>;
  testProxyEntry(id: string): Promise<ProxyEntry>;
  testAllProxies(): Promise<ProxyEntry[]>;
  /** Check a pasted list without saving it - the original's "proxy batch test". */
  testProxyLines(text: string): Promise<ProxyBatchRow[]>;
  /** Point a running session at this saved proxy without closing its tabs. */
  applyProxyToSession(profileId: string, proxyId: string): Promise<boolean>;
  createProfileFromProxy(proxyId: string): Promise<Profile>;
  proxyLine(line: string): Promise<Partial<ProxyConfig> | null>;
  proxyClipboard(): Promise<Partial<ProxyConfig> | null>;
  checkIpRisk(ip: string): Promise<{ ip: string; score: number; proxy: string; type: string }>;
  networkReport(proxyId?: string): Promise<NetworkReport>;

  /* profiles: import / export */
  exportProfiles(): Promise<string>;
  importProfiles(maxProfiles?: number): Promise<number>;

  /* fingerprint */
  runLeakCheck(id: string): Promise<LeakReport>;
  /** Read the live page of a running profile over CDP. */
  runLiveAudit(id: string): Promise<LeakReport>;
  /** Static workspace audit: fingerprints, proxies, builds and seeds against each other. */
  runWorkspaceAudit(): Promise<AuditReport>;
  openInProfile(id: string, url: string): Promise<void>;
  screenshotProfile(id: string): Promise<string>;

  /* extensions */
  listExtensions(id?: string): Promise<ExtensionReport>;
  addExtensionByUrl(url: string): Promise<ExtensionItem>;
  addExtensionFolder(): Promise<ExtensionItem | null>;
  addExtensionFile(): Promise<ExtensionItem | null>;
  toggleExtension(id: string, enabled: boolean): Promise<ExtensionItem>;
  deleteExtension(id: string): Promise<void>;
  removeShippedExtension(id: string): Promise<void>;
  restoreShippedExtension(id: string): Promise<void>;
  openExtensionFolder(): Promise<void>;
  openExternal(url: string): Promise<void>;

  /* cookies */
  exportCookies(profileId: string): Promise<string>;
  importCookies(profileId: string): Promise<number>;
  listCookieSessions(): Promise<CookieSummary[]>;

  /* history */
  listHistory(profileId: string, limit?: number): Promise<HistoryEntry[]>;
  listAllHistory(limit?: number, hopsOnly?: boolean): Promise<HistoryEntry[]>;
  listHistoryProfiles(): Promise<HistoryProfile[]>;
  clearHistory(id: string): Promise<number>;
  clearAllHistory(): Promise<number>;

  /* trash */
  listTrash(): Promise<TrashItem[]>;
  restoreTrash(file: string): Promise<string>;
  emptyTrash(): Promise<void>;

  /* storage + maintenance */
  getStoreStats(): Promise<StoreStats>;
  clearAllCaches(): Promise<number>;
  openDataDir(): Promise<void>;
  openProfileDir(id: string): Promise<void>;
  openKernelsDir(): Promise<void>;
  openLogsDir(): Promise<void>;
  readLogTail(lines?: number): Promise<string>;

  /* settings + languages */
  /* accounts and the app lock */
  lockState(): Promise<LockState>;
  listAccounts(): Promise<AccountSummary[]>;
  registerAccount(input: { email: string; password: string; displayName: string }): Promise<AccountSummary>;
  signIn(input: { email: string; password: string; code?: string }): Promise<AccountSummary>;
  signOut(): Promise<void>;
  removeAccount(email: string): Promise<void>;
  renameAccount(email: string, displayName: string): Promise<void>;
  changePassword(input: { email: string; current: string; next: string }): Promise<void>;
  unlock(input: { pin: string; code: string }): Promise<void>;
  setPin(email: string, pin: string): Promise<void>;
  checkPin(email: string, pin: string): Promise<boolean>;
  totpSetup(email: string): Promise<TotpSetup>;
  enableTotp(input: { email: string; secret: string; code: string }): Promise<void>;
  disableTotp(email: string): Promise<void>;

  getSettings(): Promise<AppSettings>;
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  listLanguages(): Promise<LanguageInfo[]>;

  /* report */
  reportPayload(userNote: string): Promise<ReportPayload>;

  resetEverything(): Promise<void>;

  /* diagnostic + window */
  runWorkspaceAudit(): Promise<AuditReport>;
  /** Re-rolls the overlaps that can be repaired without guessing. */
  repairWorkspace(): Promise<{ changed: number; failed: number; ids: string[] }>;
  winMinimize(): Promise<void>;
  winMaximize(): Promise<void>;
  winClose(): Promise<void>;
  /** Main-process events. Each subscription returns its own unsubscribe. */
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

export interface MainEvents {
  'session:changed': SessionInfo;
  'session:removed': { profileId: string };
  'kernel:progress': { id: string; received: number; total: number };
  toast: ToastPayload;
  'app:changed': { profiles: number; running: number };
  'extensions:changed': { at: string };
}

/** The fingerprint checkers, opened inside the profile's own session. */
export const CHECK_SITES = [
  { name: 'iphey', url: 'https://iphey.com/' },
  { name: 'pixelscan', url: 'https://pixelscan.net/' },
  { name: 'browserscan', url: 'https://www.browserscan.net/' },
  { name: 'ipfighter', url: 'https://ipfighter.com/browser-fingerprint' },
  { name: 'whoer.net', url: 'https://whoer.net/' },
  { name: 'whoer.com', url: 'https://whoer.com/' },
] as const;

export const PROXY_TYPES: ProxyType[] = ['none', 'http', 'https', 'socks5'];
export const DEVICE_TARGETS: DeviceTarget[] = [
  'System default',
  'Windows 11',
  'Windows 10',
  'macOS',
  'Linux',
  'Android',
  'iPhone',
  'iPad',
];
export const CHANNELS = ['stable', 'beta', 'dev', 'canary'] as const;
export const SORT_MODES: { id: SortMode; label: string }[] = [
  { id: 'recent', label: 'Recent' },
  { id: 'name', label: 'Name' },
  { id: 'created', label: 'Created' },
  { id: 'running', label: 'Running first' },
  { id: 'os', label: 'Operating system' },
];
export const HUMAN_PASTE_SPEEDS = ['relaxed', 'natural', 'fast', 'instant'] as const;
export const WEBRTC_MODES = [
  { id: 'proxy', label: 'Proxy only' },
  { id: 'public', label: 'Public address only' },
  { id: 'off', label: 'Disabled' },
] as const;
export const GEO_MODES = [
  { id: 'proxy', label: 'Match the proxy' },
  { id: 'system', label: 'Match this PC' },
  { id: 'custom', label: 'Custom coordinates' },
  { id: 'block', label: 'Block the request' },
] as const;
export const FONT_SETS = [
  { id: 'auto', label: 'Automatic' },
  { id: 'windows', label: 'Windows' },
  { id: 'macos', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
  { id: 'ios', label: 'iOS' },
  { id: 'android', label: 'Android' },
  { id: 'minimal', label: 'Minimal' },
] as const;
/** Joe Browser is an app-owned engine built on app-managed Chromium builds. */
export const JOE_ENGINE = 'joe';
export const THE_FINGERPRINT_TEST_URL = 'https://browsercan.net';
/** The page a new profile opens on. Kept separate from the fingerprint test target. */
export const DEFAULT_START_PAGE = 'https://browsercan.net?utm_source=chatgpt.com';
export const TELEGRAM_USER = 'joegoldberg2025';
