import fs from 'node:fs';
import path from 'node:path';
import { log } from './log';

/**
 * Prepares a Chromium profile folder before the browser starts.
 *
 * Chromium decides what to show on a first run by looking at what the profile folder already
 * contains. An empty folder is a new profile, and a new profile is offered the What's New
 * page, the "make this your default browser" bar and - because the app closes the browser by
 * killing it - the "restore the pages you were on" bubble.
 *
 * The state that suppresses those prompts is written before the first launch, and the state
 * that has to stay right is repaired on every launch. The files are merged, never replaced:
 * what Chromium itself wrote - the profile's own settings, the extensions it installed - is
 * kept.
 */

type Json = Record<string, unknown>;

function readJson(file: string): Json | null {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return null;
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

/** Merges one level down: a key holding an object on both sides is merged, not replaced. */
function mergeInto(target: Json, source: Json, force: boolean): void {
  for (const [key, value] of Object.entries(source)) {
    const mine = value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
    const theirs = Object.prototype.hasOwnProperty.call(target, key)
      ? (target[key] as Json | undefined)
      : undefined;
    if (mine && theirs && typeof theirs === 'object' && !Array.isArray(theirs)) {
      mergeInto(theirs, mine, force);
      continue;
    }
    if (!force && Object.prototype.hasOwnProperty.call(target, key)) continue;
    target[key] = value;
  }
}

/**
 * Writes `values` into the file, keeping everything it already holds. With `force` the given
 * values win; without it they are only written where the file has nothing yet.
 */
function merge(file: string, values: Json, force: boolean): void {
  const doc = readJson(file) ?? {};
  mergeInto(doc, values, force);
  const temp = `${file}.joe`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(doc), 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    log.warn(`could not write ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
    try { fs.rmSync(temp, { force: true }); } catch { /* the temp file is already gone */ }
  }
}

/**
 * Prepares the folder of a profile. A failure here is not fatal: the browser still starts,
 * it only shows its first run prompts again.
 */
export function seedChromiumProfile(dataDir: string, browserVersion: string): void {
  if (!dataDir) return;
  try {
    const profile = path.join(dataDir, 'Default');
    fs.mkdirSync(profile, { recursive: true });

    // The browser is closed by killing it, so Chromium never records a clean exit. Left
    // alone it writes "Crashed" and the next launch offers to restore a session that was
    // closed on purpose.
    merge(path.join(profile, 'Preferences'), {
      profile: { exit_type: 'Normal', exited_cleanly: true },
      session: { restore_on_startup: 5 },
    }, true);

    const browser: Json = {
      default_browser_setting_enabled: false,
      default_browser_infobar_declined_count: 1,
      suppress_default_browser_prompt_for_version: '999.0.0.0',
    };
    if (browserVersion) browser.last_whats_new_version = browserVersion;

    merge(path.join(dataDir, 'Local State'), {
      profile: {
        last_used: 'Default',
        info_cache: {
          Default: {
            name: 'Default',
            exit_type: 'Normal',
            exited_cleanly: true,
            is_using_default_name: true,
            is_ephemeral: false,
          },
        },
      },
      browser,
    }, false);
  } catch (error) {
    log.warn(`could not prepare the browser profile folder: ${error instanceof Error ? error.message : String(error)}`);
  }
}
