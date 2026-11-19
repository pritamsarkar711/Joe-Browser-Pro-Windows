import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import type { ClientRequest } from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import type { InstalledKernel, KernelBuild } from '../../shared/types';
import { Paths } from './paths';
import { readJson, writeJson } from './atomic';
import { requireSpace } from './disk';

/**
 * The browser kernel catalog.
 *
 * Joe Browser does not ship a browser; it manages real published builds. The list comes from
 * the vendors' own metadata (Chrome for Testing and Mozilla product
 * details for Firefox) and is cached on disk, so the Browsers page opens instantly and a
 * machine that is briefly offline still shows what it saw last.
 *
 * Nothing is downloaded until something needs it: a profile pinned to a build this machine does
 * not have, or a click on Install.
 */

const CFT_KNOWN_GOOD = 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';
const CFT_LAST_KNOWN = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const BRAVE_RELEASES = 'https://api.github.com/repos/brave/brave-browser/releases?per_page=40';
const MOZILLA_VERSIONS = 'https://product-details.mozilla.org/1.0/firefox_versions.json';

const CACHE_FILE = () => Paths.storeFile('catalog.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** How many past majors stay pinnable. Chrome reaches back eight, matching the old build. */
const MAJORS_TO_KEEP = 8;

interface CacheShape {
  schemaVersion?: number;
  fetchedAt: number;
  builds: KernelBuild[];
}

interface CftVersionEntry {
  version: string;
  downloads?: { chrome?: { platform: string; url: string; sha256?: string }[]; chromium?: { platform: string; url: string; sha256?: string }[] };
}

interface CftShape {
  versions?: CftVersionEntry[];
  channels?: Record<string, { version: string; downloads?: CftVersionEntry['downloads'] }>;
}

function httpsJson<T>(url: string, timeoutMs = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    // The socket timeout does not cover the name lookup, so a machine with no route to the
    // vendor waits on DNS for as long as the resolver allows. A deadline on the whole request
    // is what actually bounds the wait.
    let request: ClientRequest;
    const deadline = setTimeout(() => {
      request.destroy(new Error(`${url} timed out`));
    }, timeoutMs);
    const finish = () => clearTimeout(deadline);

    request = https.get(
      url,
      { headers: { 'user-agent': 'JoeBrowser/2.0 (+desktop)' }, timeout: timeoutMs },
      (response) => {
        if (response.statusCode && response.statusCode >= 400) {
          response.resume();
          finish();
          reject(new Error(`${url} answered ${response.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          finish();
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch (error) {
            reject(new Error(`Could not read the JSON from ${url}: ${(error as Error).message}`));
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error(`${url} timed out`)));
    request.on('error', (error) => {
      finish();
      reject(error);
    });
  });
}

function platformSuffix(): string {
  return process.platform === 'win32' ? 'win64' : process.platform === 'darwin' ? 'mac-x64' : 'linux64';
}

function buildId(engine: string, version: string, channel: string): string {
  return `${engine}-${version}-${channel}`;
}

function pickUrl(entries: { platform: string; url: string }[] | undefined): string {
  const suffix = platformSuffix();
  return entries?.find((e) => e.platform === suffix)?.url ?? '';
}

/** The vendor's hash for this platform's archive, when the catalog publishes one. */
function pickSha256(entries: { platform: string; url: string; sha256?: string }[] | undefined): string {
  const suffix = platformSuffix();
  const entry = entries?.find((e) => e.platform === suffix);
  const hash = entry?.sha256 ?? '';
  return /^[a-f0-9]{64}$/i.test(hash) ? hash.toLowerCase() : '';
}

function channelOf(version: string, channels: Record<string, string>): string {
  for (const [name, value] of Object.entries(channels)) {
    if (value === version) return name;
  }
  return 'known-good';
}

async function fetchChromiumBuilds(): Promise<KernelBuild[]> {
  const suffix = platformSuffix();
  const builds: KernelBuild[] = [];

  // Both Chrome for Testing documents are read at once. Asked in sequence, a machine with no
  // route to Google waits for one timeout before it even starts the second request, and the
  // Browsers page sits empty for twice as long as it needs to.
  const [lastResult, knownResult] = await Promise.allSettled([
    httpsJson<CftShape>(CFT_LAST_KNOWN),
    httpsJson<CftShape>(CFT_KNOWN_GOOD),
  ]);

  let channels: Record<string, string> = {};
  if (lastResult.status === 'fulfilled') {
    const last = lastResult.value;
    for (const [name, info] of Object.entries(last.channels ?? {})) {
      channels[name] = info.version;
    }
    // The channel list is also the honest source for the pre-release builds.
    for (const [name, info] of Object.entries(last.channels ?? {})) {
      for (const product of ['chrome', 'chromium'] as const) {
        const url = pickUrl(info.downloads?.[product]);
        if (!url) continue;
        builds.push({
          id: buildId(product, info.version, name),
          engine: product,
          channel: name,
          version: info.version,
          os: suffix,
          downloadUrl: url,
          sha256: pickSha256(info.downloads?.[product]),
          installed: false,
          path: '',
          sizeBytes: 0,
        });
      }
    }
  }

  const known = knownResult.status === 'fulfilled' ? knownResult.value : { versions: [] };
  const knownGood = (known.versions ?? []).filter((entry) => entry.downloads?.chrome || entry.downloads?.chromium);

  // Keep the newest build of each major, newest first, so the page is eight rows rather than
  // several hundred point releases.
  const byMajor = new Map<string, CftVersionEntry>();
  for (const entry of knownGood) {
    const major = entry.version.split('.')[0] ?? '';
    const current = byMajor.get(major);
    if (!current || compareVersions(entry.version, current.version) > 0) {
      byMajor.set(major, entry);
    }
  }

  const newest = [...byMajor.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .slice(0, MAJORS_TO_KEEP);

  for (const [, entry] of newest) {
    const channel = channelOf(entry.version, channels);
    for (const product of ['chrome', 'chromium'] as const) {
      const url = pickUrl(entry.downloads?.[product]);
      if (!url) continue;
      const id = buildId(product, entry.version, channel);
      if (builds.some((b) => b.id === id)) continue;
      builds.push({
        id,
        engine: product,
        channel,
        version: entry.version,
        os: suffix,
        downloadUrl: url,
        sha256: pickSha256(entry.downloads?.[product]),
        installed: false,
        path: '',
        sizeBytes: 0,
      });
    }
  }

  return builds;
}

/**
 * Joe Browser uses the published Chrome for Testing archives as its Chromium runtime.
 * They are a separate engine entry because a Joe Browser profile gets its own window, branding and
 * built-in tools - the archive is only the real engine underneath. Keeping the vendor URL means a
 * download comes directly from the vendor, not an unverified third-party mirror.
 * This is a managed wrapper, not a separately patched or independently signed browser engine.
 */
export function joeBuildsFromChromium(chromium: KernelBuild[]): KernelBuild[] {
  return chromium
    .filter((build) => build.engine === 'chrome' && build.channel.toLowerCase() === 'stable')
    .slice(0, 4)
    .map((build) => ({
      ...build,
      id: build.id.replace(/^chrome-/, 'joe-'),
      engine: 'joe',
      channel: 'stable',
    }));
}

async function fetchFirefoxBuilds(): Promise<KernelBuild[]> {
  // Mozilla's stable Windows releases are installers, not ZIP archives; macOS releases
  // are DMGs. Neither format is supported by our extraction pipeline.
  if (process.platform !== 'linux') return [];
  const suffix = platformSuffix();
  const details = await httpsJson<Record<string, string>>(MOZILLA_VERSIONS);
  const versions: { channel: string; version: string }[] = [];

  for (const [key, channel] of [
    ['LATEST_FIREFOX_VERSION', 'stable'],
    ['FIREFOX_ESR', 'esr'],
  ] as const) {
    const version = details[key];
    if (version && !version.includes('b') && !version.includes('a')) {
      versions.push({ channel, version });
    }
  }

  return versions.map(({ channel, version }) => {
    return {
      id: buildId('firefox', version, channel),
      engine: 'firefox',
      channel,
      version,
      os: suffix,
      downloadUrl:
        `https://archive.mozilla.org/pub/firefox/releases/${version}/linux-x86_64/en-US/firefox-${version}.tar.bz2`,
      installed: false,
      path: '',
      sizeBytes: 0,
    };
  });
}

interface BraveRelease {
  draft?: boolean;
  prerelease?: boolean;
  name?: string;
  tag_name?: string;
  assets?: { name?: string; browser_download_url?: string; size?: number; digest?: string }[];
}

/** Parse only vendor releases with a matching Windows archive and GitHub-provided digest. */
export function braveBuildsFromReleases(releases: BraveRelease[]): KernelBuild[] {
  const builds: KernelBuild[] = [];
  const counts: Record<string, number> = { stable: 0, beta: 0, nightly: 0 };
  for (const release of releases) {
    if (release.draft || typeof release.name !== 'string' || typeof release.tag_name !== 'string') continue;
    const match = /^(Release|Beta|Nightly) v(\d+\.\d+\.\d+) \(Chromium (\d+\.\d+\.\d+\.\d+)\)/i.exec(release.name.trim());
    if (!match || release.tag_name !== `v${match[2]}`) continue;
    const channel = match[1]!.toLowerCase() === 'release' ? 'stable' : match[1]!.toLowerCase();
    // Brave can publish release-channel candidates as GitHub prereleases before shipping.
    if (channel === 'stable' && release.prerelease) continue;
    if ((counts[channel] ?? 0) >= (channel === 'stable' ? 4 : 2)) continue;
    const fileName = `brave-v${match[2]}-win32-x64.zip`;
    const expectedUrl = `https://github.com/brave/brave-browser/releases/download/${release.tag_name}/${fileName}`;
    const asset = release.assets?.find((item) => item.name === fileName && item.browser_download_url === expectedUrl);
    const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset?.digest ?? '');
    if (!asset || !digest || !Number.isSafeInteger(asset.size) || (asset.size ?? 0) <= 0) continue;
    builds.push({
      id: buildId('brave', match[2]!, channel), engine: 'brave', channel,
      version: match[2]!, runtimeVersion: match[3]!, sha256: digest[1]!.toLowerCase(),
      os: 'win64', downloadUrl: expectedUrl, sizeBytes: asset.size!, installed: false, path: '',
    });
    counts[channel] = (counts[channel] ?? 0) + 1;
  }
  return builds;
}

async function fetchBraveBuilds(): Promise<KernelBuild[]> {
  if (process.platform !== 'win32' || process.arch !== 'x64') return [];
  // Brave's release list carries every asset of every build, so the answer is megabytes. It is
  // asked for a shorter window than the other vendors - forty releases cover a stable channel
  // several times over - and it is given longer to arrive, because a deadline that is too
  // short loses the whole engine rather than one build.
  const releases = await httpsJson<BraveRelease[]>(BRAVE_RELEASES, 45000);
  if (!Array.isArray(releases)) throw new Error('Could not read Brave release metadata.');
  return braveBuildsFromReleases(releases);
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Kernel IDs are directory names, never paths supplied by a renderer. */
function kernelDirectory(id: string): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id) || id === '.' || id === '..') {
    throw new Error('Invalid browser build ID.');
  }
  return path.join(Paths.kernels, id);
}

function installedIndex(): Map<string, InstalledKernel> {
  const dir = Paths.kernels;
  const map = new Map<string, InstalledKernel>();
  if (!fs.existsSync(dir)) return map;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaFile = path.join(dir, entry.name, 'kernel.json');
    if (!fs.existsSync(metaFile)) continue;
    const meta = readJson<InstalledKernel | null>(metaFile, null);
    if (meta && meta.id === entry.name) {
      try { if (resolveKernelExe(meta.id)) map.set(meta.id, meta); } catch { /* Ignore malformed metadata. */ }
    }
  }
  return map;
}

/** The kernels already on disk, synchronously - used to spread profiles across builds. */
export function installedKernels(): InstalledKernel[] {
  return [...installedIndex().values()];
}

/**
 * One catalog refresh, shared by everyone who asks for it.
 *
 * The Browsers page, a new profile and a batch of profiles all need the same vendor lists. Left
 * alone, each of them opens its own connection to three vendors, and a machine with no route to
 * them waits for the timeout three times over.
 */
let catalogRefresh: Promise<KernelBuild[]> | null = null;

async function gatherCatalog(cached: KernelBuild[], installedCount: number): Promise<KernelBuild[]> {
  if (catalogRefresh) return catalogRefresh;
  catalogRefresh = (async () => {
    const gathered: KernelBuild[] = [];
    const results = await Promise.allSettled([fetchChromiumBuilds(), fetchFirefoxBuilds(), fetchBraveBuilds()]);
    const sourceEngines = [['chrome', 'chromium'], ['firefox'], ['brave']];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') gathered.push(...result.value);
      else gathered.push(...cached.filter((build) => sourceEngines[index]?.includes(build.engine)));
    });

    let builds = cached;
    if (gathered.length > 0) {
      builds = gathered;
    }
    // Joe Browser is derived from the Chromium catalog, not fetched from it as a fourth vendor.
    const withoutJoe = builds.filter((build) => build.engine !== 'joe');
    builds = [...withoutJoe, ...joeBuildsFromChromium(withoutJoe)];
    if (gathered.length > 0) {
      writeJson(CACHE_FILE(), { schemaVersion: 4, fetchedAt: Date.now(), builds } satisfies CacheShape);
    } else if (builds.length === 0 && installedCount === 0) {
      throw new Error(
        'The browser catalog could not be reached. Check the connection and try again - ' +
          'existing installations still work.',
      );
    }
    return builds;
  })().finally(() => {
    catalogRefresh = null;
  });
  return catalogRefresh;
}

export async function listKernels(forceRefresh = false): Promise<KernelBuild[]> {
  const cache = readJson<CacheShape>(CACHE_FILE(), { fetchedAt: 0, builds: [] });
  const fresh = cache.schemaVersion === 4 && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  // Discard legacy entries with a fabricated archive URL, including old cached results.
  let builds = cache.builds.filter((build) =>
    (build.engine !== 'firefox' || (process.platform === 'linux' && build.channel !== 'dev')) &&
    // Brave's real archive metadata arrived in schema 2. A version check, not equality: bumping
    // the schema again must not filter Brave out of a cache that already holds valid builds.
    ((cache.schemaVersion ?? 0) >= 2 || build.engine !== 'brave'),
  );
  const installed = installedIndex();

  if (!fresh || forceRefresh || builds.length === 0) {
    builds = await gatherCatalog(builds, installed.size);
  }

  // Previously installed versions remain selectable and removable after vendor catalogs rotate.
  const catalogIds = new Set(builds.map((build) => build.id));
  for (const local of installed.values()) {
    if (!catalogIds.has(local.id)) {
      builds = [...builds, {
        id: local.id, engine: local.engine, version: local.version,
        channel: 'installed', os: platformSuffix(), downloadUrl: '',
        installed: true, path: local.exePath, sizeBytes: 0,
      }];
    }
  }
  return builds
    .map((build) => {
      const local = installed.get(build.id);
      return local
        ? { ...build, installed: true, path: local.exePath }
        : { ...build, installed: false, path: '' };
    })
    .sort((a, b) => b.engine.localeCompare(a.engine) || compareVersions(b.version, a.version));
}

export async function downloadKernel(
  build: KernelBuild,
  onProgress: (received: number, total: number) => void,
): Promise<InstalledKernel> {
  const targetDir = kernelDirectory(build.id);
  if (fs.existsSync(targetDir)) {
    const existing = readJson<InstalledKernel | null>(path.join(targetDir, 'kernel.json'), null);
    if (existing?.id === build.id && existing.engine === build.engine && resolveKernelExe(build.id)) return existing;
  }

  if (fs.existsSync(targetDir)) throw new Error('The browser build folder already exists but is invalid. Remove it before reinstalling.');
  if (!build.downloadUrl) throw new Error('This build has no download address.');
  if (!build.downloadUrl.startsWith('https://')) {
    throw new Error('Refusing to download a build over a connection that is not HTTPS.');
  }

  Paths.ensure(Paths.kernels);
  requireSpace((build.sizeBytes || 320 * 1024 * 1024) * 3, `install ${build.engine} ${build.version}`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'joe-kernel-'));
  const archivePath = path.join(tempDir, archiveNameFor(build));

  const staging = `${targetDir}.staging-${crypto.randomUUID()}`;
  try {
    if (build.engine === 'brave' && !/^[a-f0-9]{64}$/i.test(build.sha256 ?? '')) {
      throw new Error('Brave release integrity information is missing. Refresh the browser catalog.');
    }
    await downloadFile(build.downloadUrl, archivePath, onProgress);
    if (build.sha256) await verifyArchiveSha256(archivePath, build.sha256);
    fs.mkdirSync(staging, { recursive: true });
    await extract(archivePath, staging);
    const exePath = locateLauncher(staging, build.engine);
    if (!exePath) throw new Error('The downloaded archive did not contain a browser launcher.');
    const meta: InstalledKernel = {
      id: build.id, engine: build.engine, version: build.version,
      path: targetDir, exePath: path.join(targetDir, path.relative(staging, exePath)),
      runtimeVersion: build.runtimeVersion, installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(staging, 'kernel.json'), JSON.stringify(meta, null, 2), 'utf8');
    // Do not delete a competing install. A second download can be safely retried.
    if (fs.existsSync(targetDir)) throw new Error('This browser build was installed by another request.');
    fs.renameSync(staging, targetDir);
    return meta;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function verifyArchiveSha256(file: string, expected: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error('Invalid archive integrity information.');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const actual = hash.digest('hex');
  if (actual !== expected.toLowerCase()) throw new Error('The browser archive failed its SHA-256 integrity check.');
}

function archiveNameFor(build: KernelBuild): string {
  if (build.engine === 'firefox') return process.platform === 'win32' ? 'firefox.zip' : 'firefox.tar.bz2';
  return 'browser.zip';
}

function downloadFile(
  url: string,
  destination: string,
  onProgress: (received: number, total: number) => void,
  redirectsLeft = 5,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'user-agent': 'JoeBrowser/2.0' } }, (response) => {
      const status = response.statusCode ?? 0;

      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('The download redirected too many times.'));
          return;
        }
        const next = new URL(response.headers.location, url);
        if (next.protocol !== 'https:') {
          reject(new Error('Refusing an insecure browser download redirect.'));
          return;
        }
        resolve(downloadFile(next.href, destination, onProgress, redirectsLeft - 1));
        return;
      }

      if (status !== 200) {
        response.resume();
        reject(new Error(`The download answered ${status}.`));
        return;
      }

      const total = Number(response.headers['content-length'] ?? 0);
      let received = 0;
      let lastProgress = 0;
      const file = fs.createWriteStream(destination);

      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastProgress >= 100 || (total > 0 && received === total)) {
          lastProgress = now;
          onProgress(received, total);
        }
      });
      response.pipe(file);

      file.on('finish', () => file.close(() => {
        if (total > 0 && received !== total) reject(new Error('The browser download was incomplete.'));
        else resolve();
      }));
      response.on('aborted', () => { file.destroy(); reject(new Error('The browser download was interrupted.')); });
      file.on('error', (error) => {
        file.destroy();
        reject(error);
      });
      response.on('error', reject);
    });

    request.on('error', reject);
    request.setTimeout(60000, () => request.destroy(new Error('The download stalled.')));
  });
}

function extract(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      // Windows ships bsdtar, which reads zip; Expand-Archive covers tar.bz2 poorly, so the
      // Firefox archive is unpacked with tar as well.
      const isTar = archive.endsWith('.tar.bz2');
      const command = isTar
        ? { file: 'tar', args: ['-xjf', archive, '-C', into] }
        : { file: 'tar', args: ['-xf', archive, '-C', into] };
      // Git for Windows also ships GNU tar; it treats C: paths as remote hosts. Use Windows' bsdtar.
      const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      execFile(systemTar, command.args, { windowsHide: true }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`Could not unpack the archive: ${stderr || error.message}`));
        else resolve();
      });
      return;
    }

    const args = archive.endsWith('.tar.bz2')
      ? ['-xjf', archive, '-C', into]
      : ['-xf', archive, '-C', into];
    execFile('tar', args, (error, _stdout, stderr) => {
      if (error) reject(new Error(`Could not unpack the archive: ${stderr || error.message}`));
      else resolve();
    });
  });
}

function locateLauncher(root: string, engine: string): string | null {
  const names =
    engine === 'brave'
      ? ['brave.exe']
      : engine === 'firefox'
      ? ['firefox.exe', 'firefox']
      : engine === 'chromium'
        ? ['chrome.exe', 'chromium', 'Chromium']
        : ['chrome.exe', 'chrome', 'Google Chrome'];

  const walk = (dir: string, depth: number): string | null => {
    if (depth > 4) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const name of names) {
      const direct = entries.find((e) => e.isFile() && e.name.toLowerCase() === name.toLowerCase());
      if (direct) return path.join(dir, direct.name);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = walk(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  };

  return walk(root, 0);
}

export async function removeKernel(id: string): Promise<void> {
  const dir = kernelDirectory(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

export function resolveKernelExe(id: string): string | null {
  const dir = kernelDirectory(id);
  const meta = readJson<InstalledKernel | null>(path.join(dir, 'kernel.json'), null);
  if (!meta || meta.id !== id) return null;
  // Never execute paths taken from metadata outside the managed build folder.
  const candidate = path.resolve(meta.exePath || '');
  if (candidate.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(candidate)) {
    const realDir = fs.realpathSync(dir);
    const realCandidate = fs.realpathSync(candidate);
    if (realCandidate.startsWith(realDir + path.sep) && fs.statSync(realCandidate).isFile()) return realCandidate;
  }
  return locateLauncher(dir, meta.engine);
}

