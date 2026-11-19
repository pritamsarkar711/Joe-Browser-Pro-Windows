import fs from 'node:fs';
import path from 'node:path';
import type { HistoryEntry, HistoryProfile } from '../../shared/types';
import { Paths } from './paths';
import { allProfiles, getSettings } from './store';

/**
 * Per-profile browsing history.
 *
 * Kept as one JSON Lines file per profile, outside the browser's own user-data-dir: the browser
 * owns that folder and rewrites it on every launch, so anything stored inside it is not ours to
 * keep. A profile's history is therefore isolated by construction - two profiles literally
 * cannot share a file - and clearing it is a delete rather than a scan.
 *
 * Append-only is the right shape here: a navigation is an event, the file only grows forward,
 * and a crash mid-write costs one trailing line rather than the whole record.
 *
 * What the port lacked, and the original had: the hop flag (a page only passed through on the way
 * to another), the title attached after the page settles, the workspace-wide index, the count per
 * profile, and the "clear everything" that Settings offers.
 */

const DIR = () => path.join(Paths.root, 'history');
const FILE = (profileId: string) => path.join(DIR(), `${profileId}.jsonl`);

/** A runaway page must not be able to fill the disk one navigation at a time. */
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 5000;

const recent = new Map<string, HistoryEntry[]>();
const lastTitle = new Map<string, string>();

function normaliseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Whether an address is worth recording. Data URLs, extension pages and the browser's own
 * internals are not "pages the profile visited", and recording them buries the useful entries.
 */
export function interesting(url: string): boolean {
  if (!url) return false;
  if (!/^https?:/i.test(url)) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url)) return true;
  return true;
}

function enabled(): boolean {
  try {
    return getSettings().historyEnabled;
  } catch {
    return true;
  }
}

function nameOf(profileId: string): string {
  try {
    return allProfiles().find((profile) => profile.id === profileId)?.name ?? '';
  } catch {
    return '';
  }
}

/**
 * Record one navigation.
 *
 * `how` mirrors the original's vocabulary: `typed` for a URL a start page opened, `link` for a
 * request a page made, `redirect` for a hop. A hop is still recorded - it is how a URL reached
 * only through a redirect can be found again - but the index can filter it out.
 */
export function record(profileId: string, rawUrl: string, how = 'link', hop = false): void {
  if (!enabled()) return;
  const url = normaliseUrl(rawUrl);
  if (!url || !interesting(url)) return;

  const entry: HistoryEntry = {
    profileId,
    profileName: nameOf(profileId),
    at: new Date().toISOString(),
    url,
    title: '',
    how: hop ? 'redirect' : how,
    hop,
  };

  let list = recent.get(profileId);
  if (!list) {
    // Load the existing file before appending; otherwise a new session hides older visits.
    list = listFromDisk(profileId, MAX_ENTRIES).reverse();
    recent.set(profileId, list);
  }
  list.push(entry);
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);

  try {
    Paths.ensure(DIR());
    const file = FILE(profileId);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');

    const stat = fs.statSync(file);
    if (stat.size > MAX_BYTES) {
      const keep = list.slice(-Math.floor(MAX_ENTRIES / 2));
      fs.writeFileSync(file, keep.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
      recent.set(profileId, keep);
    }
  } catch {
    // A locked or unwritable file loses this entry; the session keeps working.
  }
}

/**
 * One navigation, seen twice.
 *
 * The browser reports the start of a navigation and then the commit of the document. An
 * ordinary navigation reaches here twice with the same address: the first is the hop, the
 * second is the page the user is actually on, and the second has to win - it is the one in
 * the address bar. A redirect chain arrives as several starts and one commit, so every
 * address the chain passed through stays recorded as a hop.
 */
export function recordNavigation(profileId: string, rawUrl: string, phase: 'started' | 'committed'): void {
  if (!enabled()) return;
  const url = normaliseUrl(rawUrl);
  if (!url || !interesting(url)) return;

  const list = recent.get(profileId);
  const last = list?.[list.length - 1];
  if (last && last.url === url) {
    // The same address twice: the second sighting is the page itself, so it is no longer a hop.
    if (phase === 'committed' && last.hop) clearHop(profileId, last);
    return;
  }

  if (phase === 'started') {
    record(profileId, url, 'redirect', true);
    return;
  }
  record(profileId, url, 'link', false);
}

/** Removes the hop flag from the newest entry, which turned out to be the page itself. */
function clearHop(profileId: string, entry: HistoryEntry): void {
  entry.hop = false;
  entry.how = 'link';
  try {
    const file = FILE(profileId);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (!lines.length) return;
    const disk = JSON.parse(lines[lines.length - 1]!) as HistoryEntry;
    if (disk.url !== entry.url || disk.at !== entry.at) return;
    lines[lines.length - 1] = JSON.stringify(entry);
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    /* the in-memory copy is still right for this session */
  }
}

/**
 * Attach the title a page settles on.
 *
 * The browser reports it a moment after the navigation, by which time the entry is already on
 * disk. Rewriting the whole file for every title would be a write per page load, so the title is
 * kept in memory and written by the next append; a title that never lands is a blank cell, which
 * is honest.
 */
export function attachTitle(profileId: string, url: string, title: string): void {
  if (!title) return;
  const target = normaliseUrl(url);
  lastTitle.set(profileId, title.slice(0, 300));

  const list = recent.get(profileId);
  if (!list) return;
  for (let index = list.length - 1; index >= 0; index--) {
    const item = list[index]!;
    if (item.url === target && !item.title) {
      item.title = title.slice(0, 300);
      break;
    }
  }

  // Rewrite only the trailing entries, which is where a fresh navigation lives.
  try {
    const file = FILE(profileId);
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    let changed = false;
    for (let index = lines.length - 1; index >= Math.max(0, lines.length - 40); index--) {
      try {
        const parsed = JSON.parse(lines[index]!) as HistoryEntry;
        if (parsed.url === target && !parsed.title) {
          parsed.title = title.slice(0, 300);
          lines[index] = JSON.stringify(parsed);
          changed = true;
          break;
        }
      } catch {
        /* a torn line is left as it is */
      }
    }
    if (changed) fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    /* the in-memory copy is still right for this session */
  }
}

export function list(profileId: string, limit = 500): HistoryEntry[] {
  const memory = recent.get(profileId);
  if (memory && memory.length > 0) {
    return memory.slice(-limit).reverse();
  }

  return listFromDisk(profileId, limit);
}

function listFromDisk(profileId: string, limit: number): HistoryEntry[] {
  try {
    const file = FILE(profileId);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const parsed: HistoryEntry[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        parsed.push({ ...entry, profileName: entry.profileName || nameOf(profileId) });
      } catch { /* Ignore an incomplete trailing record. */ }
    }
    return parsed.reverse();
  } catch { return []; }
}

/** Every profile's history in one list, newest first, for the History page. */
export function listAll(limit = 2000, hopsOnly = false): HistoryEntry[] {
  const entries: HistoryEntry[] = [];

  for (const { profileId } of historyFiles()) {
    entries.push(...list(profileId, limit));
  }

  const filtered = hopsOnly ? entries.filter((entry) => entry.hop) : entries;
  return filtered
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

function historyFiles(): { profileId: string; file: string; bytes: number }[] {
  try {
    if (!fs.existsSync(DIR())) return [];
    return fs
      .readdirSync(DIR())
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const full = path.join(DIR(), name);
        let bytes = 0;
        try {
          bytes = fs.statSync(full).size;
        } catch {
          bytes = 0;
        }
        return { profileId: name.replace(/\.jsonl$/, ''), file: full, bytes };
      });
  } catch {
    return [];
  }
}

/** A row per profile that has a history, with the count the History page shows. */
export function profiles(): HistoryProfile[] {
  const byId = new Map<string, HistoryProfile>();

  for (const profile of allProfiles()) {
    byId.set(profile.id, { profileId: profile.id, profileName: profile.name, count: 0, lastAt: '' });
  }

  for (const { profileId } of historyFiles()) {
    const entries = list(profileId, 5000);
    const existing = byId.get(profileId);
    const row: HistoryProfile = existing ?? {
      profileId,
      profileName: nameOf(profileId) || 'Deleted profile',
      count: 0,
      lastAt: '',
    };
    row.count = entries.length;
    row.lastAt = entries[0]?.at ?? '';
    byId.set(profileId, row);
  }

  return [...byId.values()]
    .filter((row) => row.count > 0)
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export function count(profileId: string): number {
  try {
    const file = FILE(profileId);
    if (!fs.existsSync(file)) return 0;
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function clear(profileId: string): number {
  recent.delete(profileId);
  lastTitle.delete(profileId);
  try {
    const file = FILE(profileId);
    if (!fs.existsSync(file)) return 0;
    const size = fs.statSync(file).size;
    fs.rmSync(file, { force: true });
    return size;
  } catch {
    return 0;
  }
}

export function clearAll(): number {
  recent.clear();
  lastTitle.clear();
  let freed = 0;
  try {
    if (!fs.existsSync(DIR())) return 0;
    for (const name of fs.readdirSync(DIR())) {
      const full = path.join(DIR(), name);
      try {
        freed += fs.statSync(full).size;
        fs.rmSync(full, { force: true });
      } catch {
        /* a locked file is left for the next attempt */
      }
    }
  } catch {
    /* nothing more can be done */
  }
  return freed;
}

/** Called when a profile is deleted, so its file does not outlive it. */
export function forget(profileId: string): void {
  clear(profileId);
}

export function sizeOf(profileId: string): number {
  try {
    return fs.statSync(FILE(profileId)).size;
  } catch {
    return 0;
  }
}

export function totalBytes(): number {
  return historyFiles().reduce((sum, entry) => sum + entry.bytes, 0);
}
