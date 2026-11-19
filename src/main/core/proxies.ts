import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';
import type {
  NetworkReport,
  ProxyBatchRow,
  ProxyCheckResult,
  ProxyConfig,
  ProxyEntry,
} from '../../shared/types';
import { Paths } from './paths';
import { readJson, writeJson } from './atomic';
import { decryptSecret, encryptSecret } from './secrets';
import { normalizeProxy, openTunnel, parseProxyLine, proxyEnabled, testProxy, upstreamOf } from './proxy';

/**
 * The saved proxy library.
 *
 * The port kept a proxy inside each profile, which meant the same credentials were re-typed for
 * every profile that needed them and a list a seller ships could not be kept anywhere. The
 * original had a vault: a proxy is saved once, checked once, and picked when a profile is made.
 * Secrets go through the same DPAPI path as a profile's password, for the same reason.
 */

const FILE = () => Paths.storeFile('AppProxies.json');

export interface StoredEntry extends ProxyEntry {
  /** The ciphertext; the plaintext is only ever put on the wire, never in the file. */
  passwordEnc: string;
}

function shape(input: Partial<StoredEntry> & { config: ProxyConfig }): StoredEntry {
  const config = normalizeProxy(input.config);
  const passwordEnc = config.password
    ? encryptSecret(config.password)
    : (input.passwordEnc ?? input.config.passwordEnc ?? config.passwordEnc ?? '');
  return {
    id: input.id || crypto.randomUUID(),
    name: (input.name ?? '').slice(0, 120),
    note: (input.note ?? '').slice(0, 400),
    config: { ...config, password: '', passwordEnc },
    passwordEnc,
    lastStatus: input.lastStatus ?? 0,
    lastIp: input.lastIp ?? config.lastIp ?? '',
    lastCountry: input.lastCountry ?? config.lastCountry ?? '',
    lastCountryCode: input.lastCountryCode ?? config.lastCountryCode ?? '',
    lastCity: input.lastCity ?? config.lastCity ?? '',
    lastTimezone: input.lastTimezone ?? config.lastTimezone ?? '',
    lastLatencyMs: input.lastLatencyMs ?? 0,
    lastChecked: input.lastChecked ?? '',
    usedBy: input.usedBy ?? 0,
  };
}

export function listEntries(): StoredEntry[] {
  const raw = readJson<StoredEntry[]>(FILE(), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry) => entry && typeof entry === 'object' && entry.config).map((entry) => shape(entry));
}

function persist(entries: StoredEntry[]): void {
  writeJson(FILE(), entries);
}

/** A copy safe to hand the renderer: never the ciphertext, only whether one exists. */
export function publicEntry(entry: StoredEntry): ProxyEntry {
  const { passwordEnc, ...visible } = entry;
  return {
    ...visible,
    config: { ...entry.config, password: '', passwordEnc: passwordEnc ? 'set' : '' },
  };
}

export function findEntry(id: string): StoredEntry | null {
  return listEntries().find((entry) => entry.id === id) ?? null;
}

export function passwordOf(entry: StoredEntry): string {
  return decryptSecret(entry.passwordEnc);
}

export function saveEntry(input: Partial<StoredEntry> & { config: ProxyConfig; replacePassword?: boolean }): StoredEntry {
  const entries = listEntries();
  const shaped = shape(input.replacePassword && !input.config.password
    ? { ...input, passwordEnc: '', config: { ...input.config, passwordEnc: '' } }
    : input);
  const index = input.id ? entries.findIndex((entry) => entry.id === input.id) : -1;
  if (index >= 0) {
    // Editing a proxy keeps the credential when the form left it blank, the way the original's
    // editor did: a password field shows nothing, and treating "unchanged" as "cleared" is how a
    // working proxy silently stops working.
    if (!input.replacePassword && !input.config.password && entries[index]!.passwordEnc) {
      shaped.passwordEnc = entries[index]!.passwordEnc;
      shaped.config.passwordEnc = entries[index]!.passwordEnc;
    }
    const previous = entries[index]!;
    const changed = previous.config.type !== shaped.config.type || previous.config.host !== shaped.config.host ||
      previous.config.port !== shaped.config.port || previous.config.user !== shaped.config.user || input.replacePassword === true;
    if (changed) {
      shaped.lastStatus = 0; shaped.lastIp = ''; shaped.lastCountry = ''; shaped.lastCountryCode = '';
      shaped.lastCity = ''; shaped.lastTimezone = ''; shaped.lastLatencyMs = 0; shaped.lastChecked = '';
      Object.assign(shaped.config, { lastIp: '', lastCountry: '', lastCountryCode: '', lastTimezone: '', lastCity: '' });
    } else {
      Object.assign(shaped, { lastStatus: previous.lastStatus, lastIp: previous.lastIp, lastCountry: previous.lastCountry,
        lastCountryCode: previous.lastCountryCode, lastCity: previous.lastCity, lastTimezone: previous.lastTimezone,
        lastLatencyMs: previous.lastLatencyMs, lastChecked: previous.lastChecked });
    }
    entries[index] = shaped;
  } else {
    entries.push(shaped);
  }
  persist(entries);
  return shaped;
}

export function deleteEntry(id: string): void {
  persist(listEntries().filter((entry) => entry.id !== id));
}

/**
 * Every shape a proxy seller ships: one per line, comma separated, or pasted as a block with
 * comments. The parse itself is the same `parseProxyLine` the profile editor uses, so a line
 * that works in one place works in both.
 */
export function importLines(text: string): { added: number; failed: string[] } {
  const lines = text
    .split(/[\r\n,;]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'));

  const entries = listEntries();
  const failed: string[] = [];
  let added = 0;

  for (const line of lines) {
    const parsed = parseProxyLine(line);
    if (!parsed || !parsed.host || !parsed.port) {
      failed.push(line.slice(0, 80));
      continue;
    }
    const config: ProxyConfig = normalizeProxy(parsed);
    const duplicate = entries.some(
      (entry) =>
        entry.config.host === config.host &&
        entry.config.port === config.port &&
        entry.config.user === config.user,
    );
    if (duplicate) continue;

    const made = shape({
      name: `${config.host}:${config.port}`,
      note: '',
      config,
    });
    entries.push(made);
    added++;
  }

  persist(entries);
  return { added, failed };
}

/**
 * Check a pasted list of proxies without saving any of them.
 *
 * The original had this as its own Tools tile, and it earns its place: buying a proxy list means
 * pasting a hundred lines and finding out which ones answer before one is stored. Saving first
 * would fill the library with dead entries that then get applied to profiles.
 *
 * It runs one at a time on purpose. Fifty tunnels opened at once saturate the local relay, and
 * the latency figure of a proxy tested that way is a measurement of the queue, not the proxy.
 */
export async function testLines(text: string): Promise<ProxyBatchRow[]> {
  const lines = text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'))
    .slice(0, 200);

  const rows: ProxyBatchRow[] = [];
  for (const line of lines) {
    const parsed = parseProxyLine(line);
    if (!parsed || !parsed.host || !parsed.port) {
      rows.push({
        line: line.slice(0, 120),
        host: '',
        port: 0,
        ok: false,
        ip: '',
        country: '',
        latencyMs: 0,
        error: 'Could not parse this line.',
      });
      continue;
    }
    const config = normalizeProxy(parsed);
    try {
      const result = await testProxy(config, config.password);
      rows.push({
        line: line.slice(0, 120),
        host: config.host,
        port: config.port,
        ok: result.ok,
        ip: result.ip,
        country: result.country,
        latencyMs: result.latencyMs,
        error: result.error,
      });
    } catch (error) {
      rows.push({
        line: line.slice(0, 120),
        host: config.host,
        port: config.port,
        ok: false,
        ip: '',
        country: '',
        latencyMs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return rows;
}

/** Check one saved proxy and write the answer back onto the row. */
export async function testEntry(id: string): Promise<ProxyEntry> {
  const entries = listEntries();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error('That proxy is no longer in the library.');

  const entry = entries[index]!;
  const result = await testProxy(entry.config, passwordOf(entry));
  // Re-read after the network request so concurrent tests and edits do not overwrite each other.
  const current = listEntries();
  const currentIndex = current.findIndex((row) => row.id === id);
  if (currentIndex < 0) throw new Error('That proxy is no longer in the library.');
  const latest = current[currentIndex]!;
  // A result for an old endpoint must not be displayed for an edited proxy.
  if (JSON.stringify(latest.config) !== JSON.stringify(entry.config) || latest.passwordEnc !== entry.passwordEnc) {
    return publicEntry(latest);
  }
  const updated: StoredEntry = {
    ...latest,
    lastStatus: result.ok ? 1 : -1,
    lastIp: result.ip || entry.lastIp,
    lastCountry: result.country || entry.lastCountry,
    lastCountryCode: result.countryCode || entry.lastCountryCode,
    lastCity: result.city || entry.lastCity,
    lastTimezone: result.timezone || entry.lastTimezone,
    lastLatencyMs: result.latencyMs,
    lastChecked: new Date().toISOString(),
  };
  current[currentIndex] = updated;
  persist(current);
  return publicEntry(updated);
}

/** Check every saved proxy, three at a time. */
export async function testAll(): Promise<ProxyEntry[]> {
  const entries = listEntries();
  const queue = entries.slice();

  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      try {
        await testEntry(next.id);
      } catch {
        /* one proxy that cannot be checked does not stop the rest */
      }
    }
  };

  await Promise.all([worker(), worker(), worker()]);
  // Return the complete current vault even if a single test failed.
  return listEntries().map(publicEntry);
}

/* ------------------------------------------------------------------ net check */

const SERVICES: { name: string; host: string; path: string }[] = [
  { name: 'ipwho.is', host: 'ipwho.is', path: '/?fields=success,ip,country,country_code,city,region,timezone,connection' },
  { name: 'ipapi.co', host: 'ipapi.co', path: '/json/' },
  { name: 'ip-api.com', host: 'ip-api.com', path: '/json/?fields=status,country,countryCode,city,regionName,timezone,isp,query' },
];

interface Echo {
  ip: string;
  country: string;
  countryCode: string;
  city: string;
  region: string;
  timezone: string;
  isp: string;
}

function httpGet(host: string, pathname: string, socket?: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      body += chunk.toString('utf8');
    };
    let body = '';
    const target = socket
      ? Promise.resolve(socket)
      : new Promise<net.Socket>((res, rej) => {
          const s = net.connect({ host, port: 80 });
          s.setTimeout(12000);
          s.once('connect', () => res(s));
          s.once('timeout', () => rej(new Error(`${host} timed out`)));
          s.once('error', rej);
        });

    void target
      .then((s) => {
        s.setTimeout(12000);
        const headers = [
          `GET ${pathname} HTTP/1.1`,
          `Host: ${host}`,
          'User-Agent: JoeBrowser/2.0 (+netcheck)',
          'Accept: application/json',
          'Connection: close',
          '',
          '',
        ].join('\r\n');
        s.on('data', onData);
        const finish = () => {
          s.removeListener('data', onData);
          resolve(body);
        };
        s.once('end', finish);
        s.once('close', finish);
        s.once('error', reject);
        s.write(headers);
      })
      .catch(reject);
  });
}

function bodyOf(raw: string): string {
  const split = raw.indexOf('\r\n\r\n');
  return split >= 0 ? raw.slice(split + 4) : raw;
}

function parseService(name: string, text: string): Echo | null {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (name === 'ipwho.is') {
      if (data['success'] === false) return null;
      const connection = (data['connection'] as Record<string, unknown> | undefined) ?? {};
      return {
        ip: String(data['ip'] ?? ''),
        country: String(data['country'] ?? ''),
        countryCode: String(data['country_code'] ?? ''),
        city: String(data['city'] ?? ''),
        region: String(data['region'] ?? ''),
        timezone: String(data['timezone'] ?? ''),
        isp: String(connection['isp'] ?? connection['org'] ?? ''),
      };
    }
    if (name === 'ipapi.co') {
      return {
        ip: String(data['ip'] ?? ''),
        country: String(data['country_name'] ?? ''),
        countryCode: String(data['country_code'] ?? ''),
        city: String(data['city'] ?? ''),
        region: String(data['region'] ?? ''),
        timezone: String(data['timezone'] ?? ''),
        isp: String(data['org'] ?? ''),
      };
    }
    if (data['status'] === 'fail') return null;
    return {
      ip: String(data['query'] ?? ''),
      country: String(data['country'] ?? ''),
      countryCode: String(data['countryCode'] ?? ''),
      city: String(data['city'] ?? ''),
      region: String(data['regionName'] ?? ''),
      timezone: String(data['timezone'] ?? ''),
      isp: String(data['isp'] ?? ''),
    };
  } catch {
    return null;
  }
}

/**
 * Network diagnostics.
 *
 * Three independent lookup services are compared, because one service that answers through a
 * cache can tell you your proxy works when it does not. The resolver is read back from an
 * outside source, and the clock is compared against the Date header the services send: a clock
 * that is minutes out is a fingerprint of its own, and no amount of canvas noise hides it.
 */
export async function networkReport(proxy?: { config: ProxyConfig; password: string } | null): Promise<NetworkReport> {
  const started = Date.now();
  const echoes: { name: string; echo: Echo }[] = [];
  const warnings: string[] = [];
  let clockSkew: number | null = null;
  let error = '';

  const sockets: net.Socket[] = [];

  for (const service of SERVICES) {
    let socket: net.Socket | null = null;
    try {
      if (proxy && proxyEnabled(proxy.config)) {
        socket = await openTunnel(upstreamOf(proxy.config, proxy.password), service.host, 80, 12000);
      }
      if (socket) sockets.push(socket);
      const raw = await httpGet(service.host, service.path, socket ?? undefined);
      const text = bodyOf(raw);

      const dateHeader = /^Date:\s*(.+)$/im.exec(raw)?.[1];
      if (dateHeader) {
        const theirs = Date.parse(dateHeader);
        if (Number.isFinite(theirs)) {
          const skew = Math.round((Date.now() - theirs) / 1000);
          if (clockSkew === null || Math.abs(skew) < Math.abs(clockSkew)) clockSkew = skew;
        }
      }

      const echo = parseService(service.name, text);
      if (echo && echo.ip) echoes.push({ name: service.name, echo });
      else warnings.push(`${service.name} answered, but not with an address.`);
    } catch (failure) {
      warnings.push(`${service.name}: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally {
      socket?.destroy();
    }
  }

  if (echoes.length === 0) {
    error = proxy
      ? 'None of the three lookup services answered through this proxy.'
      : 'None of the three lookup services answered. Check this PC’s connection.';
    return {
      ok: false,
      ip: '',
      country: '',
      countryCode: '',
      city: '',
      region: '',
      timezone: '',
      isp: '',
      resolverIp: '',
      resolverGeo: '',
      latencyMs: Date.now() - started,
      clockSkewSeconds: clockSkew,
      sources: [],
      warnings,
      error,
    };
  }

  // The address three services agree on is the address the world sees. Disagreement is worth
  // reporting rather than silently picking the first answer.
  const addresses = new Set(echoes.map((item) => item.echo.ip));
  if (addresses.size > 1) {
    warnings.push(`The services disagreed about the address: ${[...addresses].join(', ')}.`);
  }

  const primary = echoes[0]!.echo;
  const resolver = await resolverInfo();
  if (clockSkew !== null && Math.abs(clockSkew) > 90) {
    warnings.push(`This PC's clock is ${clockSkew > 0 ? 'ahead' : 'behind'} by ${Math.abs(clockSkew)} seconds.`);
  }

  return {
    ok: true,
    ip: primary.ip,
    country: primary.country,
    countryCode: primary.countryCode,
    city: primary.city,
    region: primary.region,
    timezone: primary.timezone,
    isp: primary.isp,
    resolverIp: resolver.ip,
    resolverGeo: resolver.geo,
    latencyMs: Date.now() - started,
    clockSkewSeconds: clockSkew,
    sources: echoes.map((item) => item.name),
    warnings,
    error,
  };
}

/**
 * Which DNS resolver this connection actually uses. Read from `dns.getServers()` rather than
 * guessed, because a resolver that belongs to the ISP is the thing a DNS-leak test looks for.
 */
async function resolverInfo(): Promise<{ ip: string; geo: string }> {
  const servers = dns.getServers().filter((server) => net.isIP(server) === 4);
  const ip = servers[0] ?? '';
  if (!ip) return { ip: '', geo: '' };

  try {
    const raw = await httpGet('ip-api.com', `/json/?fields=country,city,isp&query=${ip}`);
    const data = JSON.parse(bodyOf(raw)) as Record<string, unknown>;
    const place = [data['city'], data['country']].filter(Boolean).join(', ');
    return { ip, geo: place || String(data['isp'] ?? '') };
  } catch {
    return { ip, geo: '' };
  }
}

/** The registry the profile editor's "test" button and the Proxies page share. */
export async function check(config: ProxyConfig, password?: string): Promise<ProxyCheckResult> {
  return testProxy(config, password);
}

/** What this machine looks like with no proxy involved, for the comparison the page shows. */
export async function direct(): Promise<ProxyCheckResult> {
  const report = await networkReport(null);
  return {
    ok: report.ok,
    ip: report.ip,
    country: report.country,
    countryCode: report.countryCode,
    city: report.city,
    timezone: report.timezone,
    latencyMs: report.latencyMs,
    error: report.error,
  };
}

/** The pieces of this machine a report should carry, so a bug report is actionable. */
export function machineSummary(): string {
  const cpus = os.cpus();
  return [
    `${os.type()} ${os.release()} (${os.arch()})`,
    `${cpus.length} cores · ${Math.round(os.totalmem() / 1073741824)} GB`,
    `locale ${Intl.DateTimeFormat().resolvedOptions().locale} · zone ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `node ${process.versions.node} · ${path.basename(process.execPath)}`,
  ].join('\n');
}

/** True when a line looks like something `parseProxyLine` would accept. */
export function looksLikeProxy(line: string): boolean {
  return parseProxyLine(line) !== null;
}

export { fs as _fs };
