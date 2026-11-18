import { ProfileLocationService } from './core/profileLocation';
import { checkIpRisk } from './core/ipRisk';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AccountSummary,
  AppInfo,
  AppSettings,
  AuditReport,
  CookieSummary,
  DetectedBrowser,
  ExtensionItem,
  ExtensionReport,
  HistoryEntry,
  HistoryProfile,
  LockState,
  TotpSetup,
  InstalledKernel,
  KernelBuild,
  LanguageInfo,
  LeakReport,
  NetworkReport,
  Profile,
  ProfileSummary,
  ProxyCheckResult,
  ProxyConfig,
  ProxyBatchRow,
  ProxyEntry,
  ReportPayload,
  SessionInfo,
  StoreStats,
  SystemInfo,
  TrashItem,
} from '../shared/types';
import { TELEGRAM_USER } from '../shared/types';
import {
  allProfiles,
  clearStore,
  countProfiles,
  createProfile,
  draftProfile,
  deleteProfile,
  describeRelation,
  duplicateProfile,
  findProfile,
  flushStore,
  getSettings,
  preferredGpu,
  randomIdentity,
  renameProfile,
  rerollFingerprint,
  restoreProfile,
  sanitizeProfile,
  saveSettings,
  sortProfiles,
  summarise,
  updateProfile,
  proxyPasswordOf,
} from './core/store';
import { rollUnique } from './core/fingerprint';
import {
  detectInstalledBrowsers,
  downloadKernel,
  installedKernels,
  listKernels,
  removeKernel,
} from './core/catalog';
import {
  addFromCrxFile,
  addFromFolder,
  addFromUrl,
  deleteExtension as deleteLibraryItem,
  libraryReport,
  ensureShipped,
  removeShipped,
  restoreShipped,
  revealFolder,
  setEnabled,
} from './core/library';
import * as history from './core/history';
import { testDirect, testProxy, parseProxyLine } from './core/proxy';
import {
  deleteEntry,
  findEntry,
  importLines,
  listEntries,
  networkReport,
  passwordOf,
  publicEntry,
  saveEntry,
  testAll,
  testEntry,
  testLines as testProxyLines,
} from './core/proxies';
import { Paths } from './core/paths';
import { SessionManager } from './core/launcher';
import { buildLeakReport, liveLeakReport } from './core/leak';
import { auditWorkspace, repairWorkspace } from './core/audit';
import * as trash from './core/trash';
import { encryptionKind } from './core/secrets';
import { human, launchSpaceOk, requireSpace } from './core/disk';
import * as logs from './core/log';
import { log } from './core/log';
import {
  changePassword,
  checkPin,
  disableTotp,
  enableTotp,
  findByEmail,
  listAccounts,
  lockState,
  otpAuthUri,
  pendingTotp,
  register,
  removeAccount,
  renameAccount,
  setPin,
  signIn,
  signOut,
  unlock,
} from './core/accounts';
import { languagesWithCoverage } from '../shared/i18n';
import { resolveTarget } from '../shared/devices';

/**
 * The IPC surface.
 *
 * Every handler is wrapped so that a thrown error reaches the renderer as a rejected promise
 * with a readable message. A desktop app that shows "Error: undefined" is worse than one that
 * shows nothing, because the user cannot tell whether to retry or to reinstall.
 */

export interface IpcContext {
  sessions: SessionManager;
  broadcast(channel: string, payload: unknown): void;
}

export function registerIpc(context: IpcContext): void {
  const { sessions, broadcast } = context;

  sessions.events.on('changed', (info: SessionInfo) => {
    broadcast('session:changed', info);
    broadcast('app:changed', { profiles: countProfiles(), running: sessions.list().length });
  });
  sessions.events.on('notice', (notice: { kind: string; message: string; detail: string }) => {
    broadcast('toast', notice);
  });
  sessions.events.on('closed', (profileId: string) => {
    broadcast('session:removed', { profileId });
    broadcast('app:changed', { profiles: countProfiles(), running: sessions.list().length });
  });

  /**
   * Registers one channel. Arguments arrive untyped from the renderer, so the handler signature
   * declares what it expects and the call is narrowed once, here, rather than at every call site.
   */
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const handle = <T>(channel: string, fn: (...args: any[]) => Promise<T> | T) => {
    ipcMain.handle(channel, async (_event, ...args: any[]) => {
      try {
        return await fn(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`ipc ${channel} failed`, error);
        throw new Error(message);
      }
    });
  };

  const changed = () => broadcast('app:changed', { profiles: countProfiles(), running: sessions.list().length });

  /* ------------------------------------------------------------------ app */

  handle<AppInfo>('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    platform: `${process.platform} ${process.arch}`,
    dataDir: Paths.root,
    profileCount: countProfiles(),
    runningCount: sessions.list().length,
    encryption: encryptionKind(),
    dataMode: Paths.portable ? 'portable' : 'roaming',
    logFile: logs.log.file(),
  }));

  handle<SystemInfo>('app:system', () => {
    const settings = getSettings();
    return {
      os: `${os.type()} ${os.release()}`,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cores: os.cpus().length,
      memoryBytes: os.totalmem(),
      gpuVendor: settings.machineGlVendor,
      gpuRenderer: settings.machineGlRenderer,
    };
  });

  /* ------------------------------------------------------------------ profiles */

  handle<ProfileSummary[]>('profiles:list', () => {
    const all = allProfiles();
    const settings = getSettings();
    return sortProfiles(
      all.map((profile) => summarise(profile, sessions.isRunning(profile.id), all)),
      settings.sortBy,
    );
  });

  const profileLocations = new ProfileLocationService(
    () => testDirect(),
    (profile) => testProxy(profile.proxy, proxyPasswordOf(profile)),
  );
  handle('profiles:location', async (id: string) => {
    const profile = findProfile(id);
    if (!profile) throw new Error('That profile no longer exists.');
    return profileLocations.locate(profile, Boolean(sessions.sessionFor(id)?.info.proxyFellBack));
  });
  handle<Profile | null>('profiles:get', (id: string) => findProfile(id));

  handle<{ profile: Profile; relation: string }>('profiles:relation', (id: string) => {
    const profile = findProfile(id);
    if (!profile) throw new Error('That profile no longer exists.');
    return { profile, relation: describeRelation(profile, allProfiles()) };
  });

  const prepareProfile = (input: Partial<Profile>) => {
    const requested = { ...(input ?? {}) };
    const settings = getSettings();
    if (!requested.engine) requested.engine = settings.defaultEngine === 'auto' ? 'chrome' : settings.defaultEngine;
    if (!requested.kernelId) {
      const spread = leastUsedKernel(requested.engine);
      if (spread) requested.kernelId = spread;
    }
    if (!requested.fingerprint?.os) {
      requested.fingerprint = { ...(requested.fingerprint ?? {}), os: 'System default' } as Profile['fingerprint'];
    }
    return requested;
  };

  handle<Profile>('profiles:draft', (input: Partial<Profile>) => draftProfile(prepareProfile(input)));

  handle<Profile>('profiles:create', (input: Partial<Profile> & { preserveFingerprint?: boolean }) => {
    const created = createProfile(prepareProfile(input));
    void ensureShipped().then(() => broadcast('extensions:changed', {})).catch((error: unknown) => {
      broadcast('toast', { kind: 'warn', message: 'Default extensions could not be installed', detail: error instanceof Error ? error.message : String(error) });
      broadcast('extensions:changed', {});
    });
    changed();
    return created;
  });

  handle<Profile>('profiles:update', (id: string, patch: Partial<Profile>) => {
    const updated = updateProfile(id, patch);
    changed();
    return updated;
  });

  handle<Profile>('profiles:rename', (id: string, name: string) => {
    const updated = renameProfile(id, name);
    changed();
    return updated;
  });

  handle<void>('profiles:delete', async (id: string) => {
    await sessions.stop(id).catch(() => undefined);
    deleteProfile(id);
    changed();
  });

  handle<Profile>('profiles:duplicate', (id: string) => {
    const copy = duplicateProfile(id);
    changed();
    return copy;
  });

  handle<Profile>('profiles:reroll', (id: string) => rerollFingerprint(id));

  handle<Profile>('profiles:random', (id: string) => randomIdentity(id));

  handle<number>('profiles:clear', async (id: string, scope: 'cache' | 'cookies' | 'siteData' | 'everything') => {
    const profile = findProfile(id);
    if (!profile) throw new Error('That profile no longer exists.');

    const live = sessions.sessionFor(id);
    if (live) {
      if (scope === 'everything') {
        throw new Error('Close the profile before erasing all of its data.');
      }
      const accepted = await live.clearStorage(scope);
      if (!accepted) {
        throw new Error('The browser did not accept the clear request. Close the profile and try again.');
      }
      return 0;
    }

    const dir = path.resolve(Paths.profileData(id));
    const guard = path.resolve(Paths.profiles) + path.sep;
    if (!dir.startsWith(guard)) throw new Error('Refusing to delete a folder outside the profile store.');
    if (!fs.existsSync(dir)) return 0;

    const before = folderSize(dir);
    if (scope === 'everything') {
      fs.rmSync(dir, { recursive: true, force: true });
      return before;
    }

    const targets =
      scope === 'cache'
        ? ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache', 'Service Worker\\CacheStorage']
        : scope === 'cookies'
          ? ['Network\\Cookies', 'Network\\Cookies-wal', 'Cookies', 'Cookies-wal']
          : [
              'Local Storage',
              'Session Storage',
              'IndexedDB',
              'Service Worker',
              'CacheStorage',
              'Network\\Cookies',
              'Network\\Cookies-wal',
            ];

    let freed = 0;
    for (const root of [path.join(dir, 'Default'), dir]) {
      for (const target of targets) {
        const full = path.join(root, target);
        if (!fs.existsSync(full)) continue;
        freed += folderSize(full);
        fs.rmSync(full, { recursive: true, force: true });
      }
    }
    return freed;
  });

  /* ------------------------------------------------------------------ batch + bulk */

  handle<{ made: number; failed: number; shared: number }>(
    'profiles:batch',
    (input: { prefix: string; count: number; group: string; proxies: string }) => {
      const prefix = (input.prefix ?? '').trim() || 'Profile';
      const count = Math.max(1, Math.min(200, Number(input.count) || 10));
      const group = (input.group ?? '').trim();
      const lines = (input.proxies ?? '')
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      let made = 0;
      let failed = 0;
      let shared = 0;

      for (let index = 0; index < count; index++) {
        const taken = allProfiles();
        const parsed = lines.length > 0 ? parseProxyLine(lines[made % lines.length]!) : null;
        const proxy = parsed ? ({ ...parsed } as ProxyConfig) : undefined;

        try {
          const created = createProfile({
            name: `${prefix} ${String(made + 1).padStart(2, '0')}`,
            group,
            proxy,
            tools: { ...({} as Profile['tools']), proxyWatch: Boolean(parsed) },
          } as Partial<Profile>);
          made++;
          const comparison = describeRelation(created, taken.concat([created]));
          if (comparison) shared++;
        } catch (error) {
          log.error('batch create could not save a profile', error);
          failed++;
        }
      }

      changed();
      return { made, failed, shared };
    },
  );

  const bulk = async (
    ids: string[],
    work: (id: string) => Promise<void> | void,
  ): Promise<number> => {
    let done = 0;
    for (const id of ids) {
      try {
        await work(id);
        done++;
      } catch (error) {
        log.error(`bulk action failed for ${id}`, error);
      }
    }
    changed();
    return done;
  };

  handle<number>('profiles:bulkOpen', (ids: string[]) =>
    bulk(ids, async (id) => {
      const profile = findProfile(id);
      if (!profile) return;
      const alreadyRunning = sessions.isRunning(id);
      await sessions.launch(profile);
      if (!alreadyRunning) updateProfile(id, { lastOpenedAt: new Date().toISOString(), openCount: profile.openCount + 1 });
    }),
  );

  handle<number>('profiles:bulkStop', (ids: string[]) => bulk(ids, (id) => sessions.stop(id)));

  handle<number>('profiles:bulkDuplicate', (ids: string[]) => bulk(ids, (id) => void duplicateProfile(id)));

  handle<number>('profiles:bulkDelete', (ids: string[]) =>
    bulk(ids, async (id) => {
      await sessions.stop(id).catch(() => undefined);
      deleteProfile(id);
    }),
  );

  /* ------------------------------------------------------------------ sessions */

  handle<SessionInfo>('sessions:launch', async (id: string, url?: string) => {
    const profile = findProfile(id);
    if (!profile) throw new Error('That profile no longer exists.');
    // A browser that launches on a full volume fails with "Failed to create network context data
    // directory", which reads as a bug in this app. Say what it actually is.
    const space = launchSpaceOk();
    if (!space.ok) {
      throw new Error(
        `This drive has only ${human(space.free)} free. Free some space, or clear old profile caches from Tools, and try again.`,
      );
    }
    const alreadyRunning = sessions.isRunning(id);
    const info = await sessions.launch(profile, url);
    if (!alreadyRunning) updateProfile(id, {
      lastOpenedAt: new Date().toISOString(),
      openCount: profile.openCount + 1,
    });
    changed();
    return info;
  });

  handle<void>('sessions:stop', (id: string) => sessions.stop(id));
  handle<SessionInfo[]>('sessions:list', () => sessions.list());

  handle<void>('sessions:focus', (id: string) => {
    sessions.sessionFor(id)?.focus();
  });

  handle<boolean>('sessions:applyProxy', async (id: string, proxyId?: string) => {
    const profile = findProfile(id);
    if (!profile) throw new Error('That profile no longer exists.');

    let config = profile.proxy;
    let password = '';
    if (proxyId) {
      const entry = listEntries().find((row) => row.id === proxyId);
      if (!entry) throw new Error('That proxy is no longer in the library.');
      config = entry.config;
      password = passwordOf(entry);
      updateProfile(id, { proxy: { ...config, password } as ProxyConfig });
    } else {
      const { proxyPasswordOf } = await import('./core/store');
      password = proxyPasswordOf(profile);
    }

    const applied = await sessions.setProxy(findProfile(id) ?? profile, password);
    if (!applied) {
      throw new Error(
        'This profile opened on a direct connection, so it cannot start using a proxy without reopening.',
      );
    }
    void config;
    return true;
  });

  handle<string>('sessions:screenshot', async (id: string) => {
    const session = sessions.sessionFor(id);
    if (!session) throw new Error('Open the profile first.');
    return session.screenshot();
  });

  /* ------------------------------------------------------------------ kernels */

  handle<KernelBuild[]>('kernels:list', () => listKernels());

  handle<InstalledKernel>('kernels:download', async (id: string) => {
    const builds = await listKernels();
    const build = builds.find((entry) => entry.id === id);
    if (!build) throw new Error('That build is not in the catalog any more.');
    // Check before the download rather than after: a truncated build is worse than a refusal,
    // because it looks installed and fails at launch with a Chromium error nobody can read.
    requireSpace(build.sizeBytes || 320 * 1024 * 1024, `download ${build.engine} ${build.version}`);
    return downloadKernel(build, (received, total) => broadcast('kernel:progress', { id, received, total }));
  });

  handle<void>('kernels:remove', async (id: string) => {
    const build = installedKernels().find(item => item.id === id);
    for (const info of sessions.list()) {
      const profile = findProfile(info.profileId);
      if (profile?.kernelId === id || (build && profile?.engine === build.engine)) {
        throw new Error('A starting or running profile may be using this browser build. Close profiles using this engine first.');
      }
    }
    await removeKernel(id);
  });

  handle<DetectedBrowser[]>('browsers:detect', () => detectInstalledBrowsers());

  /**
   * Learn the graphics card this PC really has.
   *
   * A profile that answers with a card the machine does not have is one of the few things a
   * scanner can see without any database: the renderer names one GPU, and the limits that come
   * with it come from another. The original read it from a browser it launched; so does this,
   * by asking a headless run of an app-managed Chromium build.
   */
  handle<{ vendor: string; renderer: string }>('browsers:gpu', async () => {
    const { learnMachineGpu } = await import('./core/gpu');
    const learned = await learnMachineGpu();
    if (!learned.renderer) throw new Error('A graphics card could not be read on this PC.');
    saveSettings({ machineGlVendor: learned.vendor, machineGlRenderer: learned.renderer });
    return learned;
  });

  /* ------------------------------------------------------------------ proxies */

  handle<ProxyCheckResult>('proxy:check', (config: ProxyConfig, password?: string) =>
    testProxy(config, password),
  );

  handle<Partial<ProxyConfig> | null>('proxy:clipboard', () => parseProxyLine(clipboard.readText()));
  handle('proxy:risk', (ip: string) => checkIpRisk(String(ip ?? '')));
  handle<ProxyCheckResult>('proxy:checkDirect', () => testDirect());
  handle<ProxyEntry[]>('proxy:list', () => listEntries().map(publicEntry));
  handle<ProxyEntry>('proxy:get', (id: string) => {
    const entry = listEntries().find((row) => row.id === id);
    if (!entry) throw new Error('That proxy is no longer in the library.');
    return { ...publicEntry(entry), password: passwordOf(entry) };
  });

  handle<ProxyEntry>('proxy:save', (input: Partial<ProxyEntry> & { config: ProxyConfig; replacePassword?: boolean }) => {
    const saved = saveEntry(input);
    const password = passwordOf(saved);
    log.info(`saved proxy ${saved.name}`);
    return { ...publicEntry(saved), password };
  });

  handle<void>('proxy:delete', (id: string) => deleteEntry(id));

  handle<{ added: number; failed: string[] }>('proxy:import', (text: string) => {
    const result = importLines(text);
    return { added: result.added, failed: result.failed };
  });

  handle<ProxyEntry>('proxy:test', (id: string) => testEntry(id));
  handle<ProxyEntry[]>('proxy:testAll', () => testAll());
  // A pasted list checked without saving it. The original had this as its own Tools tile,
  // because buying a proxy list means finding out which lines answer before storing any.
  handle<ProxyBatchRow[]>('proxy:testLines', (text: string) => testProxyLines(String(text ?? '')));

  handle<Profile>('proxy:createProfile', async (id: string) => {
    const found = listEntries().find((row) => row.id === id);
    if (!found) throw new Error('That proxy is no longer in the library.');
    // A profile made from a proxy must carry the proxy's real exit country, not a guess from its
    // name. If the entry has never been checked, check it now so the flag and the fingerprint's
    // locale agree with the address the profile will actually use.
    let entry = found;
    if (!entry.lastCountryCode) {
      try {
        await testEntry(id);
        // Re-read the stored row: the renderer-safe copy has no ciphertext, and the profile
        // still needs the credential that was saved with the proxy.
        entry = findEntry(id) ?? entry;
      } catch {
        // An unreachable proxy still produces a profile; it simply has no country to display.
      }
    }
    const created = createProfile({
      name: entry.name || `${entry.config.host}:${entry.config.port}`,
      proxy: {
        ...entry.config,
        lastIp: entry.lastIp,
        lastCountry: entry.lastCountry,
        lastCountryCode: entry.lastCountryCode,
        lastCity: entry.lastCity,
        lastTimezone: entry.lastTimezone,
        password: passwordOf(entry),
      } as ProxyConfig,
    });
    changed();
    return created;
  });

  handle<Partial<ProxyConfig> | null>('proxy:parseLine', (line: string) => parseProxyLine(line));

  handle<NetworkReport>('proxy:network', async (proxyId?: string) => {
    if (!proxyId) return networkReport(null);
    const entry = listEntries().find((row) => row.id === proxyId);
    if (!entry) throw new Error('That proxy is no longer in the library.');
    return networkReport({ config: entry.config, password: passwordOf(entry) });
  });

  /* ------------------------------------------------------------------ import / export */

  handle<string>('profiles:export', async () => {
    const window = BrowserWindow.getFocusedWindow();
    const options = {
      title: 'Export profiles',
      defaultPath: 'joe-browser-profiles.json',
      filters: [{ name: 'Joe Browser profiles', extensions: ['json'] }],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return '';

    // Passwords are exported as ciphertext: the file is a backup of this machine's store, not a
    // portable credential, and moving it to another PC must not hand over proxy accounts.
    const payload = {
      format: 'joe-browser-profiles',
      version: 3,
      exportedAt: new Date().toISOString(),
      profiles: allProfiles(),
    };
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return result.filePath;
  });

  handle<number>('profiles:import', async (maxProfiles?: number) => {
    const window = BrowserWindow.getFocusedWindow();
    const options = {
      title: 'Import profiles',
      properties: ['openFile' as const],
      filters: [{ name: 'Joe Browser profiles', extensions: ['json'] }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return 0;

    const file = result.filePaths[0]!;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { profiles?: unknown[] };
    const incoming = Array.isArray(parsed.profiles) ? parsed.profiles : [];
    const validCount = incoming.filter((entry) => entry && typeof entry === 'object' && typeof (entry as Partial<Profile>).name === 'string').length;
    if (maxProfiles !== undefined && (!Number.isSafeInteger(maxProfiles) || maxProfiles < 0 || validCount > maxProfiles)) {
      throw new Error('This import exceeds the number of profiles available on your plan.');
    }
    let imported = 0;

    for (const entry of incoming) {
      const profile = entry as Partial<Profile>;
      if (!profile || typeof profile.name !== 'string') continue;
      createProfile({
        ...profile,
        id: undefined as unknown as string,
        // The identity travels with it. Re-rolling on import would hand the user a different
        // machine from the one their accounts were created on.
        preserveFingerprint: true,
      });
      imported++;
    }

    changed();
    return imported;
  });

  /* ------------------------------------------------------------------ fingerprint */

  handle<void>('leak:openSite', async (id: string, url: string) => {
    const session = sessions.sessionFor(id);
    if (!session) {
      throw new Error('Open the profile first - a checker has to run inside it to see its fingerprint.');
    }
    await session.openUrl(url);
  });

  handle<LeakReport>('leak:run', (id: string) => {
    const profile = findProfile(id);
    if (!profile) throw new Error('That profile no longer exists.');
    return buildLeakReport(profile);
  });

  handle<LeakReport>('leak:live', async (id: string) => {
    const profile = findProfile(id);
    if (!profile) throw new Error('That profile no longer exists.');
    const session = sessions.sessionFor(id);
    if (!session) throw new Error('Open the profile first - a live audit reads the running page.');
    const probe = await session.liveProbe();
    return liveLeakReport(profile, probe);
  });

  handle<AuditReport>('audit:run', () => auditWorkspace(allProfiles()));

  /**
   * Repairs the overlaps that can be repaired without guessing.
   *
   * A shared fingerprint and a shared seed are both fixed by re-rolling, oldest profile first so
   * the identity a user has been working in longest is the one kept. A shared proxy is reported
   * and not touched: choosing which profile should lose its connection is a decision only the
   * user can make.
   */
  handle<{ changed: number; failed: number; ids: string[] }>('audit:fix', () => {
    const before = allProfiles();
    const result = repairWorkspace(
      before,
      (profile) => {
        updateProfile(profile.id, { fingerprint: profile.fingerprint });
      },
      (profile, accepted) =>
        rollUnique(accepted.map((entry) => entry.fingerprint), {
          os: profile.fingerprint.os,
          engine: profile.engine,
          browserVersion: profile.browserVersion,
          countryCode: profile.proxy.lastCountryCode || undefined,
          preferredGpu: preferredGpu(),
        }).fingerprint,
    );
    if (result.changed > 0) broadcast('profiles:changed', {});
    return result;
  });

  /* ------------------------------------------------------------------ extensions */

  handle<ExtensionReport>('extensions:list', () => {
    const settings = getSettings();
    return libraryReport(settings.extensionsEnabled, settings.customExtensionsEnabled);
  });

  handle<ExtensionItem>('extensions:addUrl', async (url: string) => {
    const result = await addFromUrl(url);
    if (!result.item) throw new Error(result.message);
    broadcast('extensions:changed', { at: new Date().toISOString() });
    return result.item;
  });

  handle<ExtensionItem | null>('extensions:addFolder', async () => {
    const window = BrowserWindow.getFocusedWindow();
    const options = {
      title: 'Add an unpacked extension',
      properties: ['openDirectory' as const],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const item = addFromFolder(result.filePaths[0]!);
    broadcast('extensions:changed', { at: new Date().toISOString() });
    return item;
  });

  handle<ExtensionItem | null>('extensions:addFile', async () => {
    const window = BrowserWindow.getFocusedWindow();
    const options = {
      title: 'Import a .crx or .zip',
      properties: ['openFile' as const],
      filters: [{ name: 'Chrome extension', extensions: ['crx', 'zip'] }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const item = addFromCrxFile(result.filePaths[0]!);
    broadcast('extensions:changed', { at: new Date().toISOString() });
    return item;
  });

  handle<ExtensionItem>('extensions:toggle', (id: string, enabled: boolean) => {
    const item = setEnabled(id, enabled);
    broadcast('extensions:changed', { at: new Date().toISOString() });
    return item;
  });

  handle<void>('extensions:delete', (id: string) => {
    deleteLibraryItem(id);
    broadcast('extensions:changed', { at: new Date().toISOString() });
  });

  handle<void>('extensions:removeShipped', (id: string) => {
    removeShipped(id);
    broadcast('extensions:changed', { at: new Date().toISOString() });
  });

  handle<void>('extensions:restoreShipped', async (id: string) => {
    await restoreShipped(id);
    broadcast('extensions:changed', { at: new Date().toISOString() });
  });

  handle<void>('extensions:openFolder', () => revealFolder(Paths.extensions));

  /* ------------------------------------------------------------------ cookies */

  handle<CookieSummary[]>('cookies:sessions', () =>
    sessions.list().map((info) => ({
      profileId: info.profileId,
      profileName: info.profileName,
      count: 0,
      domains: 0,
    })),
  );

  handle<string>('cookies:export', async (id: string) => {
    const session = sessions.sessionFor(id);
    if (!session) throw new Error('Open the profile first. Cookies are read from a running browser.');
    const cookies = await session.exportCookies();

    const window = BrowserWindow.getFocusedWindow();
    const options = {
      title: 'Export cookies',
      defaultPath: `cookies-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`,
      filters: [{ name: 'JSON files', extensions: ['json'] }],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return '';
    fs.writeFileSync(result.filePath, JSON.stringify(cookies, null, 2), 'utf8');
    return result.filePath;
  });

  handle<number>('cookies:import', async (id: string) => {
    const session = sessions.sessionFor(id);
    if (!session) throw new Error('Open the profile first. Cookies are written to a running browser.');

    const window = BrowserWindow.getFocusedWindow();
    const options = {
      title: 'Import cookies',
      properties: ['openFile' as const],
      filters: [
        { name: 'JSON files', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return 0;

    const text = fs.readFileSync(result.filePaths[0]!, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { cookies?: unknown[] }).cookies)
        ? (parsed as { cookies: unknown[] }).cookies
        : [];
    return session.importCookies(list as Parameters<typeof session.importCookies>[0]);
  });

  /* ------------------------------------------------------------------ history */

  handle<HistoryEntry[]>('history:list', (id: string, limit?: number) => history.list(id, limit ?? 500));
  handle<HistoryEntry[]>('history:all', (limit?: number, hopsOnly?: boolean) => history.listAll(limit ?? 2000, hopsOnly));
  handle<HistoryProfile[]>('history:profiles', () => history.profiles());
  handle<number>('history:clear', (id: string) => history.clear(id));
  handle<number>('history:clearAll', () => history.clearAll());

  /* ------------------------------------------------------------------ trash */

  handle<TrashItem[]>('trash:list', () => trash.listTrash());

  handle<string>('trash:restore', (file: string) => {
    const backup = trash.peek(file);
    if (!backup) throw new Error('That entry is no longer in the bin.');
    if (findProfile(backup.id)) throw new Error('This profile already exists.');
    const id = trash.restore(file, (profile) => { restoreProfile(profile); });
    changed();
    return id;
  });

  handle<void>('trash:empty', () => {
    trash.emptyTrash();
    changed();
  });

  /* ------------------------------------------------------------------ storage */

  handle<StoreStats>('app:stats', () => {
    const profiles = allProfiles();
    const kernels = installedKernels().reduce((sum, kernel) => sum + folderSize(kernel.path), 0);
    const perProfile = profiles.map((profile) => {
      const dir = Paths.profileData(profile.id);
      return {
        id: profile.id,
        name: profile.name,
        bytes: folderSize(dir),
        cacheBytes: ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'ShaderCache', 'Service Worker\\CacheStorage']
          .reduce((sum, name) => sum + folderSize(path.join(dir, 'Default', name)), 0),
      };
    });
    const historyBytes = profiles.reduce((sum, profile) => sum + history.sizeOf(profile.id), 0);
    const freeBytes = freeSpace(Paths.root);

    return {
      dataDir: Paths.root,
      storeBytes: folderSize(Paths.root),
      profilesBytes: perProfile.reduce((sum, entry) => sum + entry.bytes, 0),
      kernelsBytes: kernels,
      historyBytes,
      extensionsBytes: folderSize(Paths.extensions),
      trashBytes: trash.trashBytes(),
      freeBytes,
      perProfile,
    };
  });

  handle<number>('app:cleanCaches', () => {
    let freed = 0;
    for (const profile of allProfiles()) {
      const dir = Paths.profileData(profile.id);
      for (const root of [path.join(dir, 'Default'), dir]) {
        for (const name of ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'ShaderCache', 'GrShaderCache', 'Service Worker\\CacheStorage']) {
          const full = path.join(root, name);
          if (!fs.existsSync(full)) continue;
          freed += folderSize(full);
          try {
            fs.rmSync(full, { recursive: true, force: true });
          } catch {
            /* a running browser holds its own cache; skip it and keep going */
          }
        }
      }
    }
    log.info(`cache clean freed ${freed} bytes`);
    return freed;
  });

  handle<void>('shell:openDataDir', () => openFolder(Paths.root));
  handle<void>('shell:openProfileDir', (id: string) => openFolder(Paths.profileData(id)));
  handle<void>('shell:openKernelsDir', () => openFolder(Paths.kernels));
  handle<void>('shell:openLogsDir', () => openFolder(Paths.logs));
  handle<void>('shell:openExternal', (url: string) => shell.openExternal(url));
  handle<string>('log:tail', (lines?: number) => logs.tail(lines ?? 200));

  /* ------------------------------------------------------------------ settings */

  handle<AppSettings>('settings:get', () => getSettings());
  handle<AppSettings>('settings:save', (patch: Partial<AppSettings>) => {
    const saved = saveSettings(patch);
    if (patch.theme) {
      nativeTheme.themeSource = saved.theme;
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        const light = saved.theme === 'light';
        window.setBackgroundColor(light ? '#f6f7fa' : '#0e1014');
        if (process.platform === 'win32' || process.platform === 'linux') {
          try { window.setTitleBarOverlay({ color: light ? '#ffffff' : '#171a20', symbolColor: light ? '#414d61' : '#b9c1ce', height: 38 }); } catch { /* Overlay not available on this window. */ }
        }
      }
    }
    return saved;
  });

  /* ---------------------------------------------------------------- accounts */

  // The gate is the first thing the window asks for, before it paints anything. It reads the
  // marker and the store, so a marker pointing at a deleted account reports `gate` rather than
  // signing in a record that no longer exists.
  handle<LockState>('account:state', () => lockState(getSettings()));
  handle<AccountSummary[]>('account:list', () => listAccounts());
  handle<AccountSummary>('account:register', (input: { email: string; password: string; displayName: string }) =>
    register(input.email, input.password, input.displayName),
  );
  handle<AccountSummary>('account:signin', (input: { email: string; password: string; code?: string }) =>
    signIn(input.email, input.password, input.code),
  );
  handle<void>('account:signout', () => signOut());
  handle<void>('account:remove', (email: string) => removeAccount(email));
  handle<void>('account:rename', (email: string, displayName: string) => renameAccount(email, displayName));
  handle<void>('account:password', (input: { email: string; current: string; next: string }) =>
    changePassword(input.email, input.current, input.next),
  );
  handle<void>('account:unlock', (input: { pin: string; code: string }) => unlock(input.pin, input.code));
  handle<void>('account:setpin', (email: string, pin: string) => setPin(email, pin));
  handle<boolean>('account:checkpin', (email: string, pin: string) => checkPin(email, pin));

  handle<TotpSetup>('account:totpSetup', (email: string): TotpSetup => {
    const account = findByEmail(email);
    const secret = pendingTotp(email);
    return {
      secret,
      uri: otpAuthUri(secret, email),
      email,
      active: Boolean(account?.totpSecret),
    };
  });
  handle<void>('account:enableTotp', (input: { email: string; secret: string; code: string }) =>
    enableTotp(input.email, input.secret, input.code),
  );
  handle<void>('account:disableTotp', (email: string) => disableTotp(email));

  handle<LanguageInfo[]>('settings:languages', () =>
    languagesWithCoverage().map((entry) => ({
      key: entry.key,
      flag: entry.flag,
      english: entry.english,
      native: entry.native,
      coverage: entry.coverage,
    })),
  );

  /* ------------------------------------------------------------------ report */

  handle<ReportPayload>('app:report', (userNote: string) => {
    const info = {
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      platform: `${process.platform} ${process.arch}`,
      os: `${os.type()} ${os.release()}`,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cores: os.cpus().length,
      memory: `${Math.round(os.totalmem() / 1073741824)} GB`,
      dataDir: Paths.root,
      profiles: countProfiles(),
      running: sessions.list().length,
      encryption: encryptionKind(),
    };
    const details = Object.entries(info)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
    const summary = `Joe Browser ${info.version} · ${info.platform}`;
    const body = `${summary}\n\n${userNote || '(no note)'}\n\n${details}`;
    clipboard.writeText(body);
    return {
      summary,
      details,
      logTail: logs.tail(120),
      telegram: `https://t.me/${TELEGRAM_USER}`,
    };
  });

  handle<void>('app:reset', async () => {
    await sessions.stopAll();
    clearStore(getSettings().useTrash);
    changed();
  });

  handle<void>('app:flush', () => flushStore());

  /** The canonical shape, so the renderer and the store cannot drift on a field name. */
  handle<Profile>('profiles:sanitize', (input: Profile) => sanitizeProfile(input));

  handle<string>('app:resolveTarget', (target: string) => resolveTarget(target as never).resolvedOs);
}

/**
 * The app-managed build of this engine used by the fewest profiles.
 * Returns '' when no matching build is installed.
 */
function leastUsedKernel(engine: string): string {
  const installed = installedKernels().filter((kernel) => kernel.engine === engine);
  if (installed.length === 0) return '';

  const usage = new Map<string, number>();
  for (const profile of allProfiles()) {
    if (profile.kernelId) usage.set(profile.kernelId, (usage.get(profile.kernelId) ?? 0) + 1);
  }

  const ranked = installed
    .map((kernel) => ({
      id: kernel.id,
      used: usage.get(kernel.id) ?? 0,
    }))
    .sort((a, b) => a.used - b.used);

  return ranked[0]?.id ?? '';
}

function folderSize(target: string): number {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      total += folderSize(path.join(target, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

function freeSpace(target: string): number {
  try {
    const stat = fs.statfsSync(target);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return 0;
  }
}

async function openFolder(folder: string): Promise<void> {
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch {
    /* the shell will report a folder it cannot open */
  }
  await shell.openPath(folder);
}
