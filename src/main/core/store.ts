import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AppSettings,
  Profile,
  ProfileSummary,
  ProxyConfig,
  SortMode,
  ToolConfig,
} from '../../shared/types';
import { DEFAULT_START_PAGE, JOE_ENGINE } from '../../shared/types';
import { Paths } from './paths';
import { readJson, writeJson, writeJsonDelayed, flushPending } from './atomic';
import { normalizeProxy, proxyDetail, proxyEnabled, proxyLabel } from './proxy';
import { decryptSecret, encryptSecret } from './secrets';
import { assignDifferentKernel, assignKernel } from './diversity';
import { installedKernels } from './catalog';
import { alignWithProxy, compareWithWorkspace, generateFingerprint, labelOf, rollUnique, signature } from './fingerprint';
import { Rng } from './rng';
import { asTarget, resolveTarget, SYSTEM_TARGET } from '../../shared/devices';
import * as trash from './trash';
import { log } from './log';

/**
 * The profile store.
 *
 * One JSON document, written atomically, with passwords never leaving it in the clear. The shape
 * is versioned so a future release can migrate rather than guess.
 */

const STORE_VERSION = 3;
const PROFILES_FILE = () => Paths.storeFile('Profiles.json');
const SETTINGS_FILE = () => Paths.storeFile('Settings.json');

interface StoreShape {
  version: number;
  profiles: Profile[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  language: 'en',
  defaultEngine: 'auto',
  defaultKernelId: '',
  startPage: DEFAULT_START_PAGE,
  extensionsEnabled: true,
  customExtensionsEnabled: true,
  clearCacheOnExit: false,
  historyEnabled: true,
  useTrash: true,
  defaultGroup: '',
  startMaximized: false,
  winWidth: 0,
  winHeight: 0,
  winMaximized: false,
  machineGlRenderer: '',
  machineGlVendor: '',
  sortBy: 'recent',
  density: 'comfortable',
  pinEnabled: false,
  autoLockMinutes: 0,
};

const ACCENTS = ['#2f6bde'];

export function defaultTools(): ToolConfig {
  return {
    humanPaste: true,
    humanPasteSpeed: 'natural',
    proxyWatch: true,
    proxyWatchInterval: 60,
    enableRightClick: true,
    unlockSelection: true,
    customExtensions: '',
  };
}

let cache: StoreShape | null = null;
const listeners = new Set<() => void>();

function load(): StoreShape {
  if (cache) return cache;
  const raw = readJson<StoreShape>(PROFILES_FILE(), { version: STORE_VERSION, profiles: [] });
  const profiles = Array.isArray(raw.profiles) ? raw.profiles.map(sanitizeProfile).filter(isProfile) : [];
  cache = { version: STORE_VERSION, profiles };
  return cache;
}

function isProfile(value: Profile | null): value is Profile {
  return Boolean(value && value.id);
}

/**
 * Bring a stored record up to the current shape.
 *
 * A profile written by an older build has a five-string OS, no device type, no resolved OS and
 * no open count. Repairing here rather than at every reader is what keeps the rest of the code
 * able to assume the current shape.
 */
export function sanitizeProfile(input: Profile): Profile {
  const proxy = normalizeProxy(input.proxy);
  const target = asTarget(input.fingerprint?.os);
  const resolved = resolveTarget(target);
  const fingerprint = {
    ...generateFingerprint({ seed: input.fingerprint?.seed ?? Rng.seed(), os: target, engine: input.engine }),
    ...(input.fingerprint ?? {}),
    os: target,
    deviceType: resolved.deviceType,
    resolvedOs: resolved.resolvedOs,
  };
  fingerprint.touchPoints = resolved.deviceType === 'desktop' ? 0 : fingerprint.touchPoints || 5;
  fingerprint.platform = fingerprint.platform || resolved.platform;

  return {
    id: input.id || crypto.randomUUID(),
    name: (input.name ?? 'Profile').slice(0, 80),
    group: input.group ?? '',
    tags: Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === 'string').slice(0, 12) : [],
    notes: input.notes ?? '',
    status: input.status ?? '',
    startUrl: input.startUrl || DEFAULT_SETTINGS.startPage,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
    lastOpenedAt: input.lastOpenedAt ?? '',
    openCount: Number.isFinite(input.openCount) ? Number(input.openCount) : 0,
    engine: input.engine || 'chrome',
    browserPath: input.browserPath ?? '',
    kernelId: input.kernelId ?? '',
    browserVersion: input.browserVersion || '157.0.8103.41',
    freshSession: Boolean(input.freshSession),
    proxy,
    tools: { ...defaultTools(), ...(input.tools ?? {}) },
    fingerprint,
    flags: input.flags ?? {},
  };
}

function persist(immediate = false): void {
  const store = load();
  store.version = STORE_VERSION;
  if (immediate) writeJson(PROFILES_FILE(), store);
  else writeJsonDelayed(PROFILES_FILE(), store, 200);
  for (const listener of listeners) listener();
}

export function onStoreChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function flushStore(): void {
  if (cache) writeJson(PROFILES_FILE(), cache);
  flushPending();
}

/** Force the next read to come from disk, after something outside this module wrote the file. */
export function invalidateStore(): void {
  cache = null;
}

export function allProfiles(): Profile[] {
  return load().profiles.slice();
}

export function allFingerprints() {
  return load().profiles.map((profile) => profile.fingerprint);
}

export function findProfile(id: string): Profile | null {
  return load().profiles.find((profile) => profile.id === id) ?? null;
}

export function findProfileOrThrow(id: string): Profile {
  const found = findProfile(id);
  if (!found) throw new Error('That profile no longer exists.');
  return found;
}

/** The password is decrypted on demand and never held in the stored object. */
export function proxyPasswordOf(profile: Profile): string {
  return decryptSecret(profile.proxy.passwordEnc);
}

export interface CreateProfileInput extends Partial<Profile> {
  copyFingerprintFrom?: string;
  /** Keep the supplied identity verbatim - used when importing an exported store. */
  preserveFingerprint?: boolean;
}

/** Construct a profile without writing it, for an editor draft. */
export function draftProfile(input: CreateProfileInput): Profile {
  const store = load();
  const now = new Date().toISOString();
  const target = asTarget(input.fingerprint?.os);

  const source = input.copyFingerprintFrom ? findProfile(input.copyFingerprintFrom) : null;

  let fingerprint;
  if (input.preserveFingerprint && input.fingerprint) {
    fingerprint = input.fingerprint;
  } else if (source) {
    // A duplicate is meant to be the same machine with different storage, so the identity is
    // copied verbatim rather than rolled again.
    fingerprint = { ...source.fingerprint };
  } else {
    const rolled = rollUnique(allFingerprints(), {
      os: target,
      engine: input.engine ?? engineFor(input),
      browserVersion: input.browserVersion,
      countryCode: input.proxy?.lastCountryCode,
      preferredGpu: preferredGpu(),
    });
    fingerprint = rolled.fingerprint;
  }

  const proxy = normalizeProxy(input.proxy);
  if (input.proxy?.password) {
    proxy.passwordEnc = encryptSecret(input.proxy.password);
    proxy.password = '';
  }

  const name = uniqueName(store.profiles, input.name?.trim() || 'New profile');

  /* Which build this profile launches.
     An explicit kernel id is honoured. A copy is separated from its source above. Everything
     else is spread across whatever is installed, so a batch of twenty does not become twenty
     profiles on one binary - the original's rule, and the reason it existed. */
  /*
   * An explicit id wins, then the workspace default, then the spread.
   *
   * `defaultKernelId` was declared, defaulted to '', shown nowhere and read nowhere: a stored
   * preference that did nothing. It is consulted here so that a workspace pinned to one build
   * actually produces profiles on that build, which is the whole reason the setting exists. A
   * default naming a build that is no longer installed is ignored rather than honoured into a
   * broken launch.
   */
  let kernelId = input.kernelId ?? '';
  if (!kernelId && !source && !input.preserveFingerprint) {
    const preferred = getSettings().defaultKernelId;
    const installed = installedKernels().filter((kernel) => kernel.engine === engineFor(input));
    kernelId =
      preferred && installed.some((kernel) => kernel.id === preferred)
        ? preferred
        : assignKernel(installed, store.profiles).kernelId;
  }
  if (source) kernelId = input.kernelId ?? '';

  const profile = sanitizeProfile({
    ...(input as Profile),
    engine: engineFor(input),
    startUrl: input.startUrl || getSettings().startPage || DEFAULT_SETTINGS.startPage,
    kernelId,
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: '',
    openCount: 0,
    fingerprint,
    proxy,
    tools: {
      ...defaultTools(),
      // Joe Browser's built-in tools are part of the browser, not optional add-ons.
      ...(engineFor(input) === JOE_ENGINE ? { humanPaste: true, proxyWatch: true } : {}),
      ...(input.tools ?? {}),
    },
    flags: {},
  });

  return profile;
}

export function createProfile(input: CreateProfileInput): Profile {
  const profile = draftProfile(input);
  load().profiles.push(profile);
  persist(true);
  log.info(`created profile ${profile.name} (${profile.fingerprint.os})`);
  return profile;
}

/** Restore the original ID so its browser-data directory remains associated with it. */
export function restoreProfile(input: Profile): Profile {
  if (!input.id || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id)) throw new Error('Invalid profile identifier in the backup.');
  const store = load();
  if (store.profiles.some((entry) => entry.id === input.id)) throw new Error('This profile already exists.');
  const profile = sanitizeProfile(input);
  store.profiles.push(profile);
  try { persist(true); } catch (error) {
    store.profiles.pop();
    throw error;
  }
  return profile;
}

/** 'auto' in the settings means the browser this PC already has. */
function engineFor(input: Partial<Profile>): string {
  const settings = getSettings();
  return input.engine && input.engine !== 'auto' ? input.engine : settings.defaultEngine === 'auto' ? 'chrome' : settings.defaultEngine;
}

/** The card this PC really has, when the app has learned it. */
export function preferredGpu(): { vendor: string; renderer: string } | null {
  const settings = getSettings();
  if (!settings.machineGlRenderer) return null;
  return { vendor: settings.machineGlVendor || 'Google Inc. (NVIDIA)', renderer: settings.machineGlRenderer };
}

function uniqueName(profiles: Profile[], wanted: string): string {
  const taken = new Set(profiles.map((profile) => profile.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  let n = 2;
  while (taken.has(`${wanted} ${n}`.toLowerCase())) n++;
  return `${wanted} ${n}`;
}

export function updateProfile(id: string, patch: Partial<Profile>): Profile {
  const store = load();
  const index = store.profiles.findIndex((profile) => profile.id === id);
  if (index < 0) throw new Error('That profile no longer exists.');

  const current = store.profiles[index]!;

  let proxy: ProxyConfig = current.proxy;
  if (patch.proxy) {
    proxy = normalizeProxy({ ...current.proxy, ...patch.proxy });
    if (patch.proxy.password !== undefined && patch.proxy.password !== '') {
      proxy.passwordEnc = encryptSecret(patch.proxy.password);
    }
    if (patch.proxy.password === '') {
      // An explicit empty string clears the credential; leaving it undefined keeps it.
      proxy.passwordEnc = '';
    }
    proxy.password = '';
  }

  const merged: Profile = {
    ...current,
    ...patch,
    // Identity and creation time are not editable through a patch.
    id: current.id,
    createdAt: current.createdAt,
    kernelId: patch.engine && patch.engine !== current.engine && patch.kernelId === undefined ? '' : (patch.kernelId ?? current.kernelId),
    updatedAt: new Date().toISOString(),
    proxy,
    tools: { ...current.tools, ...(patch.tools ?? {}) },
    fingerprint: { ...current.fingerprint, ...(patch.fingerprint ?? {}) },
  };

  store.profiles[index] = sanitizeProfile(merged);
  persist(true);
  return store.profiles[index]!;
}

/**
 * Delete a profile. With the recycle bin on, the record and its browser data go there instead of
 * being erased; off, both are removed as before.
 */
export function deleteProfile(id: string, useTrash = getSettings().useTrash): void {
  const store = load();
  const index = store.profiles.findIndex((profile) => profile.id === id);
  if (index < 0) return;
  const profile = store.profiles[index]!;

  store.profiles.splice(index, 1);
  persist(true);

  if (useTrash) {
    try {
      trash.moveToTrash(profile);
      log.info(`profile ${profile.name} moved to the recycle bin`);
      return;
    } catch (error) {
      // Never turn a failed recycle-bin operation into permanent deletion.
      store.profiles.splice(index, 0, profile);
      persist(true);
      throw error;
    }
  }

  removeProfileData(id);
}

export function removeProfileData(id: string): void {
  const dir = path.resolve(Paths.profileData(id));
  const guard = path.resolve(Paths.profiles) + path.sep;
  if (!dir.startsWith(guard) || !fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    // A locked cookie database can be cleared on the next start instead of failing the delete.
    log.warn('profile data could not be removed', error);
  }
}

/**
 * A duplicate is the same machine with different storage - the fingerprint is copied verbatim -
 * but never the same binary. Inheriting the source's pinned build would leave a pair that is
 * identical down to the executable, which is the one surface a fingerprint cannot compensate
 * for.
 */
export function duplicateProfile(id: string): Profile {
  const source = findProfileOrThrow(id);
  const assignment = assignDifferentKernel(installedKernels().filter((kernel) => kernel.engine === source.engine), source, allProfiles());
  return createProfile({
    ...source,
    name: source.name,
    copyFingerprintFrom: id,
    kernelId: assignment.kernelId,
    lastOpenedAt: '',
  } as CreateProfileInput);
}

export function renameProfile(id: string, name: string): Profile {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A profile needs a name.');
  const store = load();
  return updateProfile(id, { name: uniqueName(store.profiles.filter((profile) => profile.id !== id), trimmed) });
}

export function rerollFingerprint(id: string): Profile {
  const profile = findProfileOrThrow(id);
  const others = allProfiles().filter((entry) => entry.id !== id).map((entry) => entry.fingerprint);
  const rolled = rollUnique(others, {
    os: profile.fingerprint.os,
    engine: profile.engine,
    browserVersion: profile.browserVersion,
    countryCode: profile.proxy.lastCountryCode || undefined,
    preferredGpu: preferredGpu(),
  });
  return updateProfile(id, { fingerprint: { ...rolled.fingerprint } });
}

/**
 * Roll a whole new identity, including the device target. The original's "Random identity"
 * button: two profiles created a minute apart should share nothing at all, and that includes
 * whether one of them is a phone.
 */
export function randomIdentity(id: string): Profile {
  const profile = findProfileOrThrow(id);
  const others = allProfiles().filter((entry) => entry.id !== id).map((entry) => entry.fingerprint);
  const targets = ['Windows 11', 'Windows 10', 'macOS', 'Linux', 'Android', 'iPhone', 'iPad'] as const;
  const chosen = targets[Math.floor(Math.random() * targets.length)]!;
  const rolled = rollUnique(others, {
    os: chosen,
    engine: profile.engine,
    browserVersion: profile.browserVersion,
    countryCode: profile.proxy.lastCountryCode || undefined,
    preferredGpu: preferredGpu(),
  });
  return updateProfile(id, { fingerprint: { ...rolled.fingerprint } });
}

/** Move a profile's clock, locale and coordinates to agree with its proxy. */
export function alignProfileWithProxy(id: string): Profile {
  const profile = findProfileOrThrow(id);
  if (!profile.proxy.lastCountryCode || !profile.fingerprint.autoMatchProxy) return profile;
  return updateProfile(id, {
    fingerprint: alignWithProxy(profile.fingerprint, profile.proxy.lastCountryCode, profile.proxy.lastTimezone),
  });
}

/** Changes when the configured route or its credentials change; never exposes credentials. */
export function profileLocationKey(profile: Profile): string {
  const p = profile.proxy;
  if (p.type === 'none') return 'direct';
  return crypto.createHash('sha256').update(JSON.stringify([p.type, p.host, p.port, p.user, p.passwordEnc])).digest('hex');
}

export function summarise(profile: Profile, running: boolean, all?: Profile[]): ProfileSummary {
  const accent = ACCENTS[Math.abs(hash(profile.id)) % ACCENTS.length]!;
  const comparison = all && all.length > 1
    ? compareWithWorkspace(profile.fingerprint, all.filter((entry) => entry.id !== profile.id).map((entry) => entry.fingerprint))
    : null;

  return {
    id: profile.id,
    name: profile.name,
    group: profile.group,
    tags: profile.tags,
    status: profile.status,
    notes: profile.notes,
    engine: profile.engine,
    browserVersion: profile.browserVersion,
    proxyLabel: proxyLabel(profile.proxy),
    proxyDetail: proxyDetail(profile.proxy),
    hasProxy: profile.proxy.type !== 'none',
    locationKey: profileLocationKey(profile),
    proxyCountry: profile.proxy.lastCountryCode,
    lastOpenedAt: profile.lastOpenedAt,
    openCount: profile.openCount,
    createdAt: profile.createdAt,
    running,
    freshSession: profile.freshSession,
    os: profile.fingerprint.os,
    screen: `${profile.fingerprint.screenW}×${profile.fingerprint.screenH}`,
    timezone: profile.fingerprint.timezone,
    language: profile.fingerprint.language,
    cores: profile.fingerprint.cores,
    signature: shortSignature(profile),
    linked: comparison?.relation === 'linked',
    colors: { accent, tint: `${accent}22` },
  };
}

/** A four-character mark of the identity, so two cards that share one are visible at a glance. */
export function shortSignature(profile: Profile): string {
  const parts = signature(profile.fingerprint);
  const seed = `${parts.webgl}|${parts.screen}|${parts.timezone}|${parts.canvas}`;
  return hash(seed).toString(16).slice(-4).toUpperCase().padStart(4, '0');
}

/** A sentence for the editor: how this identity relates to the rest of the workspace. */
export function describeRelation(profile: Profile, all: Profile[]): string {
  const comparison = compareWithWorkspace(
    profile.fingerprint,
    all.filter((entry) => entry.id !== profile.id).map((entry) => entry.fingerprint),
  );
  if (comparison.relation === 'distinct') return '';
  return comparison.summary ? `${comparison.summary.charAt(0).toUpperCase()}${comparison.summary.slice(1)}.` : '';
}

export function relationSurface(profile: Profile, all: Profile[]): string {
  const comparison = compareWithWorkspace(
    profile.fingerprint,
    all.filter((entry) => entry.id !== profile.id).map((entry) => entry.fingerprint),
  );
  return comparison.surface ? labelOf(comparison.surface) : '';
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function proxyIsUsable(profile: Profile): boolean {
  return !proxyEnabled(profile.proxy) || Boolean(decryptSecret(profile.proxy.passwordEnc)) || !profile.proxy.user;
}

export function getSettings(): AppSettings {
  const raw = readJson<Partial<AppSettings>>(SETTINGS_FILE(), {});
  return { ...DEFAULT_SETTINGS, ...raw };
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...getSettings(), ...patch };
  writeJson(SETTINGS_FILE(), merged);
  for (const listener of listeners) listener();
  return merged;
}

export function countProfiles(): number {
  return load().profiles.length;
}

export function clearStore(useTrash = true): void {
  const current = load().profiles;
  for (const profile of current) {
    if (useTrash) {
      try {
        trash.moveToTrash(profile);
        continue;
      } catch {
        /* fall through to the outright delete */
      }
    }
    removeProfileData(profile.id);
  }
  cache = { version: STORE_VERSION, profiles: [] };
  writeJson(PROFILES_FILE(), cache);
  writeJson(SETTINGS_FILE(), DEFAULT_SETTINGS);
  for (const listener of listeners) listener();
}

/**
 * Profiles ordered the way the grid asks for. Running sessions come first only in the "running"
 * mode; the default is recent, which is what a person looks for after a restart.
 */
export function sortProfiles(profiles: ProfileSummary[], mode: SortMode): ProfileSummary[] {
  const copy = profiles.slice();
  switch (mode) {
    case 'name':
      return copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    case 'created':
      return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case 'running':
      return copy.sort((a, b) => Number(b.running) - Number(a.running) || recentFirst(a, b));
    case 'os':
      return copy.sort((a, b) => a.os.localeCompare(b.os) || a.name.localeCompare(b.name));
    case 'group':
      return copy.sort((a, b) => (a.group || '\uffff').localeCompare(b.group || '\uffff') || a.name.localeCompare(b.name));
    default:
      return copy.sort(recentFirst);
  }
}

function recentFirst(a: ProfileSummary, b: ProfileSummary): number {
  const left = a.lastOpenedAt || a.createdAt;
  const right = b.lastOpenedAt || b.createdAt;
  return right.localeCompare(left);
}

/** Every group that has at least one profile, in the order the grid shows them. */
export function groupsOf(profiles: ProfileSummary[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const profile of profiles) {
    const key = profile.group.trim() || 'Ungrouped';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export { SYSTEM_TARGET };
