import fs from 'node:fs';
import path from 'node:path';
import { Paths } from './paths';
import { log } from './log';

/**
 * One-time cleanup of the files this app used to share with the original Windows build.
 *
 * Both programs kept their data in `%APPDATA%\JoeBrowser` and both wrote a file called
 * `settings.json`, `accounts.json`, `extensions.json` and `proxies.json` there - with schemas
 * that have nothing in common. On Windows the file names differ only in case, so the two apps
 * were writing over each other: the original read `"sortBy": "recent"` where it wanted an
 * integer, refused to start and renamed the file to `settings.json.broken`, and the first save
 * from this app would have replaced the original's account vault with a file it cannot decrypt.
 *
 * The files this app owns now carry a prefix of their own, and this moves the ones that are
 * still under the old name. A file that holds the original's shape is left exactly where it is:
 * it belongs to the other program, and this app has no business reading or deleting it.
 */

interface Rename {
  from: string;
  to: string;
  /** True only when the file holds this app's shape rather than the original's. */
  mine: (value: unknown) => boolean;
}

const RENAMES: Rename[] = [
  {
    from: 'Settings.json',
    to: 'AppSettings.json',
    mine: (value) => {
      const row = value as Record<string, unknown> | null;
      if (!row || typeof row !== 'object') return false;
      // The original stores `sortBy` as an index and calls the theme `ThemeMode`.
      return typeof row.sortBy === 'string' && typeof row.theme === 'string';
    },
  },
  {
    from: 'accounts.json',
    to: 'AppAccounts.json',
    mine: (value) => {
      const row = value as { format?: unknown } | null;
      return Boolean(row && typeof row === 'object' && row.format === 'joe-accounts');
    },
  },
  {
    from: 'extensions.json',
    to: 'AppExtensions.json',
    mine: (value) => {
      const row = value as { items?: unknown } | null;
      return Boolean(row && typeof row === 'object' && !Array.isArray(row) && Array.isArray(row.items));
    },
  },
  {
    from: 'proxies.json',
    to: 'AppProxies.json',
    mine: (value) => {
      if (!Array.isArray(value)) return false;
      return value.every((row) => {
        const entry = row as { id?: unknown; Id?: unknown } | null;
        // The original writes `Id`; this app writes `id`.
        return Boolean(entry && typeof entry === 'object' && typeof entry.id === 'string');
      });
    },
  },
];

/**
 * Reads the file without touching it. `readJson` would move a file it cannot parse aside, and one
 * of the files being probed belongs to the other app: it must come out of this untouched.
 */
function readShape(file: string): unknown {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    if (!text.trim()) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Moves the old names aside. Safe to run on every launch: a file that is already gone is
 * skipped, and a target that already exists is never overwritten.
 */
export function adoptOwnFileNames(): void {
  const root = Paths.root;
  for (const rename of RENAMES) {
    const from = path.join(root, rename.from);
    const to = path.join(root, rename.to);
    try {
      if (!fs.existsSync(from)) continue;
      if (fs.existsSync(to)) continue;
      const shape = readShape(from);
      if (shape === undefined || !rename.mine(shape)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      log.info(`moved ${rename.from} to ${rename.to}`);
    } catch (error) {
      log.error(`cannot move ${rename.from} aside`, error);
    }
  }
}
