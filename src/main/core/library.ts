import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import https from 'node:https';
import { execFile } from 'node:child_process';
import type { ExtensionItem, ExtensionReport, Profile } from '../../shared/types';
import { Paths } from './paths';
import { readJson, writeJson } from './atomic';
import { extensionId, storeListingId, verifyStoreCrx } from './storeCrx';
import { INCLUDED_EXTENSIONS, RECOMMENDED_EXTENSIONS } from '../../shared/extensionCatalog';
import { ensureHumanPasteExtension } from './humanPaste';

/**
 * Local extension library. Store downloads use Google's update service and are accepted only
 * after checking that the CRX3 publisher signature matches the requested extension ID.
 * The included tools are local implementations, not the publishers' original extensions.
 */

const LIBRARY_FILE = () => Paths.storeFile('AppExtensions.json');
const IMPORTED_ROOT = () => path.join(Paths.extensions, 'imported');
const SHIPPED_ROOT = () => path.join(Paths.extensions, 'shipped');

export const SHIPPED_IDS = { tracker: INCLUDED_EXTENSIONS[0]!.id, rightClick: INCLUDED_EXTENSIONS[1]!.id };

interface LibraryRow extends ExtensionItem {
  /** For an imported extension, the folder name inside `extensions/imported`. */
  folderName: string;
}

interface LibraryShape {
  version: number;
  items: LibraryRow[];
  /** Shipped extensions the user removed and has not restored. */
  removedShipped: string[];
}

const EMPTY: LibraryShape = { version: 1, items: [], removedShipped: [] };

function load(): LibraryShape {
  const raw = readJson<LibraryShape>(LIBRARY_FILE(), EMPTY);
  return {
    version: 1,
    items: Array.isArray(raw.items) ? raw.items : [],
    removedShipped: Array.isArray(raw.removedShipped) ? raw.removedShipped : [],
  };
}

function persist(shape: LibraryShape): void {
  writeJson(LIBRARY_FILE(), shape);
}

export function storeSearchUrl(query: string): string {
  return query ? `https://chromewebstore.google.com/search/${query.trim()}` : 'https://chromewebstore.google.com/';
}

/* ------------------------------------------------------------------ manifests */

interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  default_locale?: string;
  icons?: Record<string, string>;
  action?: { default_icon?: Record<string, string> | string; default_title?: string };
  key?: string;
  content_scripts?: { js?: string[] }[];
  background?: { service_worker?: string; scripts?: string[] };
}

function readManifest(folder: string): Manifest | null {
  try {
    const text = fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8');
    return JSON.parse(text) as Manifest;
  } catch {
    return null;
  }
}

/** Chrome manifests can use __MSG_key__ placeholders resolved from their default locale. */
function manifestText(folder: string, manifest: Manifest | null, value: string | undefined): string {
  if (!value) return '';
  const match = /^__MSG_([a-zA-Z0-9_@]+)__$/.exec(value);
  const locale = manifest?.default_locale;
  if (!match || !locale || !/^[a-zA-Z0-9_-]+$/.test(locale)) return value;
  try {
    const messages = JSON.parse(fs.readFileSync(path.join(folder, '_locales', locale, 'messages.json'), 'utf8')) as Record<string, { message?: string }>;
    const key = Object.keys(messages).find((entry) => entry.toLowerCase() === match[1]!.toLowerCase());
    return (key && messages[key]?.message) || value;
  } catch { return value; }
}

/** The largest icon a package ships, as an absolute path, or '' when it ships none. */
function iconOf(folder: string, manifest: Manifest | null): string {
  if (!manifest) return '';
  const candidates: string[] = [];
  for (const [size, file] of Object.entries(manifest.icons ?? {})) {
    if (typeof file === 'string') candidates.push(`${size}:${file}`);
  }
  const action = manifest.action?.default_icon;
  if (typeof action === 'string') candidates.push(`0:${action}`);
  else if (action) for (const [size, file] of Object.entries(action)) if (typeof file === 'string') candidates.push(`${size}:${file}`);

  candidates.sort((a, b) => Number(b.split(':')[0]) - Number(a.split(':')[0]));
  for (const candidate of candidates) {
    const file = candidate.split(':').slice(1).join(':');
    const full = path.resolve(folder, file);
    const root = path.resolve(folder) + path.sep;
    try {
      if (full.startsWith(root) && fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    } catch {
      /* keep looking */
    }
  }
  return '';
}

/**
 * The store id, recovered from the `key` in the manifest.
 *
 * Chrome derives an extension's id from the first 128 bits of the SHA-256 of its public key,
 * mapping each nibble to a-p. That is how a folder can be matched to its store listing without
 * a lookup, and it is what the original did.
 */
function storeIdOf(manifest: Manifest | null): string {
  if (!manifest?.key) return '';
  try {
    const der = Buffer.from(manifest.key, 'base64');
    const hash = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
    return hash.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ installers */

function freshFolderName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'extension';
  const taken = new Set(
    (() => {
      try {
        return fs.readdirSync(IMPORTED_ROOT());
      } catch {
        return [] as string[];
      }
    })(),
  );
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}-${n++}`;
  return candidate;
}

/** Copy an unpacked folder into the library, so the source folder can move or be deleted. */
export function addFromFolder(sourceFolder: string): ExtensionItem {
  const resolved = path.resolve(sourceFolder);
  if (!fs.existsSync(path.join(resolved, 'manifest.json'))) {
    throw new Error('That folder is not an unpacked extension: it has no manifest.json.');
  }
  const manifest = readManifest(resolved);
  const name = (manifestText(resolved, manifest, manifest?.name) || path.basename(resolved)).slice(0, 120);
  const folderName = freshFolderName(name);
  const target = path.join(IMPORTED_ROOT(), folderName);

  fs.mkdirSync(IMPORTED_ROOT(), { recursive: true });
  copyTree(resolved, target);

  const item: LibraryRow = {
    id: crypto.randomUUID(),
    name,
    version: manifest?.version ?? '',
    description: (manifestText(target, manifest, manifest?.description) || 'Unpacked extension').slice(0, 240),
    folder: target,
    folderName,
    enabled: true,
    source: 'folder',
    storeUrl: '',
    iconPath: iconOf(target, manifest),
    storeId: storeIdOf(manifest),
    shipped: false,
    removed: false,
  };

  const shape = load();
  shape.items.push(item);
  persist(shape);
  return item;
}

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

/**
 * Install from a `.crx` or `.zip`.
 *
 * A CRX is a ZIP with a 16-byte-or-so header. The header length is in the first four bytes, so
 * the archive starts at that offset; stripping it and handing the rest to a zip reader is the
 * whole trick. The ZIP reader below is deliberately tiny: an extension is small, it holds no
 * entries with unusual flags, and pulling a dependency for this would be more surface than the
 * feature is worth.
 */
export function addFromCrxFile(file: string, verified?: { publicKey: Buffer; storeUrl: string }): ExtensionItem {
  if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('The extension package exceeds 64 MB.');
  const data = fs.readFileSync(file);
  const zip = crxPayload(data);
  if (!zip) throw new Error('That file is not a Chrome extension package (.crx) or a .zip.');

  const folderName = freshFolderName(path.basename(file).replace(/\.(crx|zip)$/i, ''));
  const target = path.join(IMPORTED_ROOT(), folderName);
  try {
    unzip(zip, target);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }

  const manifest = readManifest(target);
  if (!manifest) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new Error('The package has no manifest.json, so the browser would refuse it.');
  }

  if (verified) {
    const expectedId = extensionId(verified.publicKey);
    if (manifest.key && storeIdOf(manifest) !== expectedId) {
      fs.rmSync(target, { recursive: true, force: true });
      throw new Error('The manifest identity does not match the signed package.');
    }
    if (load().items.some((row) => row.storeId === expectedId)) {
      fs.rmSync(target, { recursive: true, force: true });
      throw new Error('This extension is already installed.');
    }
    manifest.key = verified.publicKey.toString('base64');
    fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  const name = (manifestText(target, manifest, manifest.name) || path.basename(file)).slice(0, 120);
  const item: LibraryRow = {
    id: crypto.randomUUID(),
    name,
    version: manifest.version ?? '',
    description: (manifestText(target, manifest, manifest.description) || 'Imported extension').slice(0, 240),
    folder: target,
    folderName,
    enabled: true,
    source: verified ? 'url' : 'file',
    storeUrl: verified?.storeUrl ?? '',
    iconPath: iconOf(target, manifest),
    storeId: storeIdOf(manifest),
    shipped: false,
    removed: false,
  };

  const shape = load();
  shape.items.push(item);
  persist(shape);
  return item;
}

function crxPayload(data: Buffer): Buffer | null {
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'Cr24') {
    const version = data.readUInt32LE(4);
    let offset: number;
    if (version === 3) {
      // v3: magic(4) version(4) header_length(4) then the header, then the zip.
      const headerLength = data.readUInt32LE(8);
      offset = 12 + headerLength;
    } else if (version === 2 && data.length >= 16) {
      // v2: magic(4) version(4) pubkey_length(4) sig_length(4) then key, sig, zip.
      const publicKeyLength = data.readUInt32LE(8);
      const signatureLength = data.readUInt32LE(12);
      offset = 16 + publicKeyLength + signatureLength;
    } else return null;
    if (offset >= data.length) return null;
    return data.subarray(offset);
  }
  // A plain zip starts with PK\x03\x04.
  if (data.length > 4 && data.readUInt32LE(0) === 0x04034b50) return data;
  return null;
}

/** CRC-32 of an unpacked ZIP member. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Extract a conventional ZIP with bounded sizes and strict path and integrity checks. */
function unzip(buffer: Buffer, target: string): void {
  const bad = () => new Error('The extension archive is invalid or unsafe.');
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad();
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0 ||
      buffer.readUInt16LE(eocd + 8) !== entries || entries > 10000 ||
      centralOffset + centralSize !== eocd) throw bad();
  let cursor = centralOffset;
  let total = 0;
  const seen = new Set<string>();
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) throw bad();
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const external = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || (flags & 1) || (method !== 0 && method !== 8) ||
        uncompressedSize > 64 * 1024 * 1024 || (total += uncompressedSize) > 256 * 1024 * 1024) throw bad();
    // Refuse symlinks and ambiguous paths, including Windows drive and alternate-stream names.
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8').replace(/\\/g, '/');
    const components = name.replace(/\/$/, '').split('/');
    if (!name || name.startsWith('/') || components.some((part) => !part || part === '.' || part === '..' || /[<>:\x00-\x1f"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
        ((external >>> 16) & 0xf000) === 0xa000) throw bad();
    const key = components.join('/').toLowerCase();
    if (seen.has(key)) throw bad();
    seen.add(key);
    cursor = next;
    if (name.endsWith('/')) continue;
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw bad();
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > centralOffset) throw bad();
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let content: Buffer;
    try {
      content = method === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
    } catch { throw bad(); }
    if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) throw bad();
    const destination = path.join(target, ...components);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, { flag: 'wx' });
  }
  if (cursor !== eocd) throw bad();
}

export function deleteExtension(id: string): void {
  const shape = load();
  const item = shape.items.find((row) => row.id === id);
  if (!item) return;
  try {
    fs.rmSync(item.folder, { recursive: true, force: true });
  } catch {
    /* a folder a running browser holds stays on disk; the row is gone either way */
  }
  shape.items = shape.items.filter((row) => row.id !== id);
  persist(shape);
}

export function setEnabled(id: string, enabled: boolean): ExtensionItem {
  const shape = load();
  const item = shape.items.find((row) => row.id === id);
  if (!item) throw new Error('That extension is no longer in the library.');
  item.enabled = enabled;
  persist(shape);
  return item;
}

/* ------------------------------------------------------------------ shipped pair */

/** Download originals, verify their publisher identity, and install atomically. */
let installingIncluded: Promise<void> | null = null;
export function ensureShipped(): Promise<void> {
  if (installingIncluded) return installingIncluded;
  installingIncluded = (async () => {
    const failures: string[] = [];
    for (const definition of INCLUDED_EXTENSIONS) {
      if (load().removedShipped.includes(definition.id)) continue;
      const target = path.join(SHIPPED_ROOT(), definition.id);
      if (fs.existsSync(path.join(target, 'manifest.json'))) continue;
      const staging = `${target}.staging-${crypto.randomUUID()}`;
      try {
        const data = await fetchStorePackage(definition.id);
        const publicKey = verifyStoreCrx(data, definition.id);
        const payload = crxPayload(data);
        if (!payload) throw new Error('Invalid extension package.');
        unzip(payload, staging);
        const manifest = readManifest(staging);
        if (!manifest) throw new Error('The extension has no manifest.');
        if (manifest.key && storeIdOf(manifest) !== definition.id) throw new Error('Extension identity mismatch.');
        manifest.key = publicKey.toString('base64');
        fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
        // Respect a removal while the download was in flight.
        if (!load().removedShipped.includes(definition.id)) {
          fs.mkdirSync(SHIPPED_ROOT(), { recursive: true });
          fs.rmSync(target, { recursive: true, force: true });
          fs.renameSync(staging, target);
        }
      } catch (error) {
        failures.push(`${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }
    if (failures.length) throw new Error(failures.join('; '));
  })().finally(() => { installingIncluded = null; });
  return installingIncluded;
}

function included(id: string) {
  const result = INCLUDED_EXTENSIONS.find((item) => item.id === id);
  if (!result) throw new Error('Unknown included extension.');
  return result;
}

export function removeShipped(id: string): void {
  included(id);
  const shape = load();
  if (!shape.removedShipped.includes(id)) shape.removedShipped.push(id);
  persist(shape);
  fs.rmSync(path.join(SHIPPED_ROOT(), id), { recursive: true, force: true });
}

export async function restoreShipped(id: string): Promise<void> {
  included(id);
  const shape = load();
  shape.removedShipped = shape.removedShipped.filter((entry) => entry !== id);
  persist(shape);
  await ensureShipped();
}

export function shippedState() {
  const shape = load();
  return INCLUDED_EXTENSIONS.map((definition) => ({
    ...definition, description: '',
    present: fs.existsSync(path.join(SHIPPED_ROOT(), definition.id, 'manifest.json')) && !shape.removedShipped.includes(definition.id),
    removed: shape.removedShipped.includes(definition.id),
  }));
}

/** Send image bytes, not a file URL that the sandbox and CSP cannot load. */
function iconDataUrl(file: string, folder: string): string {
  try {
    if (!file || !fs.realpathSync(file).startsWith(fs.realpathSync(folder) + path.sep)) return '';
    if (fs.statSync(file).size > 512 * 1024) return '';
    const bytes = fs.readFileSync(file);
    const type = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : bytes.subarray(0, 3).equals(Buffer.from([255,216,255])) ? 'image/jpeg'
      : bytes.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/) ? 'image/gif' : '';
    return type ? `data:${type};base64,${bytes.toString('base64')}` : '';
  } catch { return ''; }
}

/* ------------------------------------------------------------------ the report */

export function libraryReport(masterEnabled: boolean, customExtensionsEnabled: boolean): ExtensionReport {
  const shape = load();

  const library: ExtensionItem[] = shape.items
    .filter((item) => fs.existsSync(path.join(item.folder, 'manifest.json')))
    .map((item) => ({
      ...item,
      iconPath: '',
      iconDataUrl: iconDataUrl(item.iconPath, item.folder),
    }));

  return {
    masterEnabled,
    customExtensionsEnabled,
    firstParty: [],
    library,
    shipped: shippedState(),
    recommended: RECOMMENDED_EXTENSIONS.map((entry) => ({
      name: entry.name,
      description: entry.description,
      url: entry.url,
      icon: entry.icon,
    })),
  };
}

/**
 * Every folder this profile should load.
 *
 * The master switch off means nothing loads. `customExtensionsEnabled` off means only the app's
 * own tools and the shipped pair load, which is what the original's two settings meant.
 */
export function profileExtensionFolders(
  profile: Profile,
  masterEnabled: boolean,
  customEnabled: boolean,
): string[] {
  if (!masterEnabled || profile.engine === 'firefox') return [];

  const shape = load();
  const removed = new Set(shape.removedShipped);

  const shipped = customEnabled
    ? INCLUDED_EXTENSIONS.filter((definition) => !removed.has(definition.id))
        .map((definition) => path.join(SHIPPED_ROOT(), definition.id))
        .filter((folder) => fs.existsSync(path.join(folder, 'manifest.json')))
    : [];

  const library = customEnabled
    ? shape.items
        .filter((item) => item.enabled)
        .map((item) => item.folder)
        .filter((folder) => fs.existsSync(path.join(folder, 'manifest.json')))
    : [];

  const manual = profile.tools.customExtensions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .filter((line) => {
      try {
        return fs.existsSync(path.join(line, 'manifest.json'));
      } catch {
        return false;
      }
    });

  // A folder on a command line that contains a comma splits the list, so anything imported is
  // loaded from the app's own root where no path has one.
  const humanPaste = profile.tools.humanPaste ? [ensureHumanPasteExtension(profile.tools.humanPasteSpeed)] : [];
  return dedupe([...humanPaste, ...shipped, ...library, ...manual]);
}

function dedupe(folders: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const folder of folders) {
    const key = path.resolve(folder).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(folder);
  }
  return out;
}

/** The Chromium switches that load a list of folders. */
export function loadArgs(folders: string[]): string[] {
  if (folders.length === 0) return [];
  const safe = folders.filter((folder) => !folder.includes(','));
  if (safe.length === 0) return [];
  const joined = safe.join(',');
  return [`--load-extension=${joined}`, `--disable-extensions-except=${joined}`];
}

/** Open the folder in the OS file manager, without importing Electron into the core. */
export function revealFolder(folder: string): Promise<void> {
  return new Promise((resolve) => {
    const target = folder || Paths.extensions;
    fs.mkdirSync(target, { recursive: true });
    if (process.platform === 'win32') execFile('explorer.exe', [target], () => resolve());
    else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], () => resolve());
  });
}

/** Only the Google update service and its package CDN may be contacted, including redirects.
 * Imported local CRX files remain available through the separate file picker. */
export function isStoreDownloadUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    (host === 'clients2.google.com' || host.endsWith('.googleusercontent.com'));
}

/** Bounded store download, validating every redirect before making a request. */
export function download(url: string, timeoutMs = 30000, redirects = 0): Promise<Buffer> {
  if (redirects > 5) return Promise.reject(new Error('Too many download redirects.'));
  let parsed: URL;
  try { parsed = new URL(url); } catch { return Promise.reject(new Error('Invalid download URL.')); }
  if (!isStoreDownloadUrl(parsed)) return Promise.reject(new Error('The store download redirected to an untrusted host.'));
  return new Promise((resolve, reject) => {
    const request = https.get(parsed, { headers: { 'user-agent': 'Mozilla/5.0 JoeBrowser/2.0' }, timeout: timeoutMs }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        let next: URL;
        try { next = new URL(response.headers.location, parsed); }
        catch { reject(new Error('Invalid store download redirect.')); return; }
        resolve(download(next.toString(), timeoutMs, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`The download answered ${response.statusCode}.`));
        return;
      }
      const max = 64 * 1024 * 1024;
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) response.destroy(new Error('The extension package exceeds 64 MB.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('The extension download was interrupted.')));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('timeout', () => request.destroy(new Error('The download timed out.')));
    request.on('error', reject);
  });
}

async function fetchStorePackage(id: string): Promise<Buffer> {
  const update = new URL('https://clients2.google.com/service/update2/crx');
  update.searchParams.set('response', 'redirect');
  update.searchParams.set('prodversion', '131.0.6778.0');
  update.searchParams.set('acceptformat', 'crx3');
  update.searchParams.set('x', `id=${id}&installsource=ondemand&uc`);
  return download(update.toString());
}

/** Download and authenticate a package from an official Chrome Web Store listing. */
export async function addFromUrl(url: string): Promise<{ item: ExtensionItem | null; opened: boolean; message: string }> {
  const clean = url.trim();
  const id = storeListingId(clean);
  if (!id) throw new Error('Enter an official Chrome Web Store extension listing URL.');
  const data = await fetchStorePackage(id);
  const publicKey = verifyStoreCrx(data, id);
  fs.mkdirSync(Paths.root, { recursive: true });
  const temp = path.join(Paths.root, `download-${crypto.randomUUID()}.crx`);
  fs.writeFileSync(temp, data, { flag: 'wx' });
  try {
    const item = addFromCrxFile(temp, { publicKey, storeUrl: clean });
    return { item, opened: false, message: `${item.name} was added to the library.` };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
