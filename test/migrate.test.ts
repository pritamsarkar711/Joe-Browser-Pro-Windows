import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The two builds shared one data folder.
 *
 * Both wrote a file called `settings.json`, `accounts.json`, `extensions.json` and
 * `proxies.json` there, with schemas that cannot read each other: the original wants an integer
 * where this app writes a word, and it protects its account vault with DPAPI where this app
 * uses its own key. Whichever program saved last decided what the other one read, and the
 * original answered by refusing to start and renaming the file to `settings.json.broken`.
 *
 * These tests pin the two halves of the fix: this app's files move to names the original never
 * touches, and the original's files are left exactly where they are.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'joe-migrate-'));
process.env['JOE_BROWSER_DATA_DIR'] = scratch;

const { adoptOwnFileNames } = await import('../src/main/core/migrate');

test('the app takes its own files away from the build it shared a folder with', () => {
  fs.writeFileSync(
    path.join(scratch, 'Settings.json'),
    JSON.stringify({ theme: 'dark', sortBy: 'recent', language: 'en' }),
  );
  fs.writeFileSync(path.join(scratch, 'proxies.json'), JSON.stringify([{ id: 'a', config: {} }]));

  // These two belong to the original build and are not ours to move.
  fs.writeFileSync(path.join(scratch, 'accounts.json'), 'dpapi:AAAA');
  fs.writeFileSync(path.join(scratch, 'extensions.json'), JSON.stringify([{ Id: 'x', Name: 'y' }]));

  adoptOwnFileNames();

  assert.ok(fs.existsSync(path.join(scratch, 'AppSettings.json')), 'our settings were not taken');
  assert.ok(fs.existsSync(path.join(scratch, 'AppProxies.json')), 'our proxies were not taken');
  assert.equal(fs.existsSync(path.join(scratch, 'Settings.json')), false, 'the old name is still there');
  assert.equal(fs.existsSync(path.join(scratch, 'proxies.json')), false, 'the old name is still there');

  assert.equal(
    fs.readFileSync(path.join(scratch, 'accounts.json'), 'utf8'),
    'dpapi:AAAA',
    "the other build's account vault was touched",
  );
  assert.ok(fs.existsSync(path.join(scratch, 'extensions.json')), "the other build's library was moved");
});

test('the other build settings are left alone rather than read as ours', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'joe-migrate-legacy-'));
  // The original's own shape: `sortBy` is an index and the theme is a number.
  fs.writeFileSync(
    path.join(folder, 'settings.json'),
    JSON.stringify({ SortBy: 0, ThemeMode: 1, UiLanguage: 'en' }),
  );
  fs.writeFileSync(path.join(folder, 'AppSettings.json'), JSON.stringify({ theme: 'light' }));

  const previous = process.env['JOE_BROWSER_DATA_DIR'];
  process.env['JOE_BROWSER_DATA_DIR'] = folder;
  try {
    adoptOwnFileNames();
  } finally {
    process.env['JOE_BROWSER_DATA_DIR'] = previous;
  }

  assert.ok(fs.existsSync(path.join(folder, 'settings.json')), "the other build's settings were moved");
  assert.equal(
    fs.readFileSync(path.join(folder, 'AppSettings.json'), 'utf8'),
    JSON.stringify({ theme: 'light' }),
    'an existing file of ours was overwritten',
  );
});
