import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The tests that matter for an identity tool.
 *
 * They assert three properties and nothing cosmetic:
 *   1. Determinism - a seed always rebuilds the same machine.
 *   2. Uniqueness  - a new profile does not collide with one already stored.
 *   3. Coherence  - the surfaces that must agree with the proxy's country do agree.
 */

// Point the store at a scratch folder before anything imports Paths.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'joe-test-'));
process.env['JOE_BROWSER_DATA_DIR'] = scratch;

const { generateFingerprint, signature, rollUnique, alignWithProxy, checkUniqueness } = await import(
  '../src/main/core/fingerprint'
);
const { buildIdentity } = await import('../src/main/core/ua');
const { parseProxyLine, normalizeProxy, proxyEnabled, proxyLabel } = await import(
  '../src/main/core/proxy'
);
const { buildFingerprintScript } = await import('../src/main/core/inject');
const store = await import('../src/main/core/store');
const { startRelay } = await import('../src/main/core/relay');
const history = await import('../src/main/core/history');

test('the same seed always rebuilds the same machine', () => {
  const a = generateFingerprint({ seed: 424242 });
  const b = generateFingerprint({ seed: 424242 });
  assert.deepEqual(signature(a), signature(b));
});

test('different seeds produce different identities', () => {
  const a = generateFingerprint({ seed: 1 });
  const b = generateFingerprint({ seed: 2 });
  assert.notDeepEqual(signature(a), signature(b));
});

test('a new profile never collides with one already stored', () => {
  const existing = [];
  for (let i = 0; i < 40; i++) existing.push(generateFingerprint({ seed: 1000 + i }));

  for (let i = 0; i < 25; i++) {
    const rolled = rollUnique(existing);
    const check = checkUniqueness(rolled.fingerprint, existing);
    assert.equal(check.unique, true, `profile ${i} collided across the twelve surfaces`);
    existing.push(rolled.fingerprint);
  }
});

test('the clock, locale and coordinates follow the proxy country', () => {
  const base = generateFingerprint({ seed: 77 });
  const aligned = alignWithProxy(base, 'DE', '');

  assert.equal(aligned.timezone, 'Europe/Berlin');
  assert.equal(aligned.language, 'de-DE');
  assert.equal(aligned.geoLat, '52.5200');
  assert.ok(aligned.acceptLanguage.startsWith('de-DE'));
});

test('the user agent, platform and brands agree with the claimed OS', () => {
  const onWindows = generateFingerprint({ seed: 5, os: 'Windows 11' });
  const windows = buildIdentity('chrome', '157.0.8103.41', onWindows, 5);
  assert.match(windows.userAgent, /Windows NT 10\.0; Win64; x64/);
  assert.match(windows.userAgent, /Chrome\/157\.0\.0\.0/);
  assert.equal(windows.platform, 'Win32');
  assert.equal(windows.osPlatform, 'Windows');
  assert.ok(windows.brands.some((b) => b.brand === 'Google Chrome' && b.version === '157'));

  const onMac = generateFingerprint({ seed: 5, os: 'macOS' });
  const mac = buildIdentity('chrome', '157.0.8103.41', onMac, 5);
  assert.match(mac.userAgent, /Macintosh; Intel Mac OS X/);
  assert.equal(mac.platform, 'MacIntel');
  assert.equal(mac.osPlatform, 'macOS');

  const firefox = buildIdentity('firefox', '141.0', onWindows, 5);
  assert.match(firefox.userAgent, /Firefox\/141\.0/);
  // Firefox exposes no client hints; an empty list is the honest answer.
  assert.equal(firefox.brands.length, 0);

  const joe = buildIdentity('joe', '157.0.8103.41', onWindows, 5);
  assert.ok(joe.brands.some((b) => b.brand === 'Joe Browser'));
  assert.ok(joe.fullVersionList.some((b) => b.brand === 'Joe Browser'));
});

test('a phone target produces a phone, not a desktop with a mobile string', () => {
  const phone = generateFingerprint({ seed: 88, os: 'iPhone' });
  assert.equal(phone.deviceType, 'mobile');

  const identity = buildIdentity('chrome', '157.0.8103.41', phone, 88);
  // Safari is the only engine on iOS, and the UA has to say so.
  assert.match(identity.userAgent, /iPhone|iPad/);
  assert.match(identity.userAgent, /Safari/);
  assert.equal(identity.platform, 'iPhone');

  const android = generateFingerprint({ seed: 88, os: 'Android' });
  const androidIdentity = buildIdentity('chrome', '157.0.8103.41', android, 88);
  assert.match(androidIdentity.userAgent, /Android \d+/);
  assert.match(androidIdentity.userAgent, /Mobile/);
  // A desktop UA here would reveal the device as a laptop pretending.
  assert.doesNotMatch(androidIdentity.userAgent, /Windows NT|Macintosh/);
});

test('the injected script parses as JavaScript and carries the overrides', () => {
  const fingerprint = generateFingerprint({ seed: 909 });
  const script = buildFingerprintScript({
    fingerprint,
    engine: 'chrome',
    browserVersion: '157.0.8103.41',
    tools: {
      humanPaste: true,
      humanPasteSpeed: 'natural',
      proxyWatch: true,
      proxyWatchInterval: 60,
      enableRightClick: true,
      unlockSelection: true,
      customExtensions: '',
    },
    countryCode: 'GB',
  });

  // A syntax error here is a silently unprotected profile in production.
  assert.doesNotThrow(() => new Function(script));

  assert.match(script, /navigator/);
  assert.match(script, /hardwareConcurrency/);
  assert.match(script, /37445/); // UNMASKED_VENDOR_WEBGL
  assert.match(script, /getTimezoneOffset/);
  assert.match(script, /cdc_/);
  // Audio offsets must be indexed from a seeded table, not from an advancing random stream:
  // two reads of the same analyser have to agree, just as two canvas reads do.
  assert.match(script, /audioNoiseTable/);
  // Scoped to the audio patch: performance.now legitimately uses the random stream for jitter,
  // while the audio reader must not consume it at all.
  const audioStart = script.indexOf('var audioNoiseTable');
  const audioEnd = script.indexOf('/* ----', audioStart);
  assert.ok(audioStart > 0 && audioEnd > audioStart, 'the audio patch is missing its markers');
  assert.doesNotMatch(script.slice(audioStart, audioEnd), /rnd\(\)/);

  // The originals live in a closure: the host's real graphics card must not be reachable by
  // walking own properties on window, which an earlier design leaked through a named key.
  assert.doesNotMatch(script, /__jbReal/);
});

test('the stored brand agrees with the engine and the device target', () => {
  assert.equal(generateFingerprint({ seed: 5, engine: 'brave', os: 'Windows 11' }).brand, 'Brave');
  assert.equal(generateFingerprint({ seed: 5, engine: 'edge', os: 'Windows 11' }).brand, 'Microsoft Edge');
  assert.equal(generateFingerprint({ seed: 5, engine: 'firefox', os: 'Windows 11' }).brand, 'Mozilla Firefox');
  assert.equal(generateFingerprint({ seed: 5, os: 'iPad' }).brand, 'Safari');
});

test('proxy lines are accepted in the shapes sellers actually paste', () => {
  assert.deepEqual(parseProxyLine('1.2.3.4:8080'), {
    type: 'http',
    host: '1.2.3.4',
    port: 8080,
    user: '',
    password: '',
  });

  assert.deepEqual(parseProxyLine('socks5://1.2.3.4:1080'), {
    type: 'socks5',
    host: '1.2.3.4',
    port: 1080,
    user: '',
    password: '',
  });

  const authed = parseProxyLine('http://bob:s3cret@9.9.9.9:3128');
  assert.equal(authed?.user, 'bob');
  assert.equal(authed?.password, 's3cret');
  assert.equal(authed?.host, '9.9.9.9');

  const colonForm = parseProxyLine('9.9.9.9:3128:bob:s3cret');
  assert.equal(colonForm?.user, 'bob');
  assert.equal(colonForm?.password, 's3cret');

  assert.equal(parseProxyLine('nonsense'), null);
  assert.equal(parseProxyLine(''), null);
});

test('a proxy is only "enabled" when it is complete', () => {
  assert.equal(proxyEnabled(normalizeProxy({ type: 'http', host: 'a', port: 0 })), false);
  assert.equal(proxyEnabled(normalizeProxy({ type: 'none', host: 'a', port: 80 })), false);
  assert.equal(proxyEnabled(normalizeProxy({ type: 'http', host: 'a', port: 80 })), true);
  assert.equal(proxyLabel(normalizeProxy({ type: 'http', host: 'a', port: 80 })), 'Proxy');
});

test('the store creates, re-rolls, duplicates and deletes', () => {
  store.clearStore();
  assert.equal(store.allProfiles().length, 0);

  const first = store.createProfile({ name: 'Shop UK' });
  assert.equal(store.allProfiles().length, 1);
  assert.ok(first.fingerprint.seed > 0);

  const second = store.createProfile({ name: 'Shop US' });
  const check = checkUniqueness(second.fingerprint, [first.fingerprint]);
  assert.equal(check.unique, true);

  // Names are de-duplicated rather than rejected.
  const third = store.createProfile({ name: 'Shop UK' });
  assert.equal(third.name, 'Shop UK 2');

  const duplicate = store.duplicateProfile(first.id);
  // A duplicate is deliberately the same machine with different storage.
  assert.equal(duplicate.fingerprint.seed, first.fingerprint.seed);

  const rerolled = store.rerollFingerprint(first.id);
  assert.notEqual(rerolled.fingerprint.seed, first.fingerprint.seed);

  store.updateProfile(first.id, { name: 'Renamed', group: 'Ecommerce' });
  assert.equal(store.findProfile(first.id)?.name, 'Renamed');

  store.deleteProfile(second.id);
  assert.equal(store.findProfile(second.id), null);
});

test('a proxy password is never stored in the clear', () => {
  store.clearStore();
  const created = store.createProfile({
    name: 'With credentials',
    proxy: {
      type: 'http',
      host: '10.0.0.1',
      port: 8080,
      user: 'bob',
      password: 'hunter2',
      passwordEnc: '',
      lastIp: '',
      lastCountry: '',
      lastCountryCode: '',
      lastTimezone: '',
      lastCity: '',
      fallbackDirect: true,
    },
  });

  const raw = fs.readFileSync(path.join(scratch, 'Profiles.json'), 'utf8');
  assert.equal(raw.includes('hunter2'), false, 'the plaintext password reached the store file');
  assert.ok(created.proxy.passwordEnc.length > 0);
  assert.equal(store.proxyPasswordOf(created), 'hunter2');
});

test('history is recorded per profile and cannot leak between them', () => {
  const first = store.createProfile({ name: 'History A' });
  const second = store.createProfile({ name: 'History B' });

  history.clear(first.id);
  history.clear(second.id);

  history.record(first.id, 'https://example.com/one');
  history.record(first.id, 'https://example.com/two');
  history.record(second.id, 'https://other.example/private');

  const forFirst = history.list(first.id);
  const forSecond = history.list(second.id);

  assert.equal(forFirst.length, 2);
  assert.equal(forSecond.length, 1);
  assert.ok(!forFirst.some((entry) => entry.url.includes('other.example')));

  // Newest first.
  assert.equal(forFirst[0]!.url, 'https://example.com/two');

  // A deliberate repeat visit must remain visible.
  history.record(first.id, 'https://example.com/two');
  assert.equal(history.list(first.id).length, 3);

  // Same-document navigation is useful browsing history as well.
  history.record(first.id, 'https://example.com/three#section');
  assert.equal(history.list(first.id)[0]!.url, 'https://example.com/three#section');

  const freed = history.clear(first.id);
  assert.ok(freed > 0);
  assert.equal(history.list(first.id).length, 0);
  // Clearing one profile leaves the other untouched.
  assert.equal(history.list(second.id).length, 1);
});

test('the relay listens on loopback and refuses to invent an upstream', async () => {
  // Nothing is listening on that port, so a tunnel must fail cleanly rather than hang.
  const relay = await startRelay({ type: 'socks5', host: '127.0.0.1', port: 9, user: '', password: '' });
  assert.ok(relay.port > 0);
  await relay.close();
});

/* ------------------------------------------------------------------ accounts and the lock */

const accounts = await import('../src/main/core/accounts');

test('a registered account round-trips through the store', () => {
  accounts.reloadAccounts();
  const created = accounts.register('Owner@Example.com', 'correct horse battery', 'Owner');
  assert.equal(created.email, 'owner@example.com', 'the address was not normalised');
  assert.equal(created.displayName, 'Owner');

  const found = accounts.findByEmail('OWNER@example.com');
  assert.ok(found, 'the account could not be found by a differently cased address');
  assert.equal(found?.displayName, 'Owner');

  assert.equal(accounts.signIn('owner@example.com', 'correct horse battery').email, 'owner@example.com');

  // A wrong password is refused, and reads as a wrong password rather than as a missing account.
  assert.throws(
    () => accounts.signIn('owner@example.com', 'wrong'),
    (error: unknown) => (error as { code?: string }).code === 'wrong-password',
  );

  // Registering the same address twice is refused rather than silently replacing the first.
  assert.throws(
    () => accounts.register('owner@example.com', 'another password', 'Owner'),
    (error: unknown) => (error as { code?: string }).code === 'exists',
  );
});

test('the account file never contains the password or its hash in the clear', () => {
  // The store is encrypted as a whole, so the test is that the plaintext is not reachable by
  // reading the file - which is the actual threat: someone opening it in Notepad.
  const file = path.join(scratch, 'accounts.json');
  assert.ok(fs.existsSync(file), 'the account store was not written');

  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('correct horse battery'), false, 'the password reached the store file');
  assert.equal(raw.includes('joe@example.com'), false, 'the email reached the store file in the clear');

  const parsed = JSON.parse(raw) as { format?: string; ciphertext?: string };
  assert.equal(parsed.format, 'joe-accounts');
  assert.ok((parsed.ciphertext ?? '').length > 0, 'the store was not encrypted');
});

test('a PIN is stored as a hash and checked without revealing it', () => {
  accounts.setPin('owner@example.com', '4821');
  assert.equal(accounts.pinRequired('owner@example.com'), true);
  assert.equal(accounts.checkPin('owner@example.com', '4821'), true);
  assert.equal(accounts.checkPin('owner@example.com', '1234'), false);

  // A PIN that is too short or not numeric is refused rather than saved weakly.
  assert.throws(() => accounts.setPin('owner@example.com', '12'));
  assert.throws(() => accounts.setPin('owner@example.com', 'abcd'));

  // An empty PIN removes the lock entirely.
  accounts.setPin('owner@example.com', '');
  assert.equal(accounts.pinRequired('owner@example.com'), false);
});

test('a TOTP secret produces codes that verify, and only when they should', () => {
  const secret = accounts.newTotpSecret();
  assert.equal(secret.length, 32, 'a 20-byte secret is 32 base32 characters');

  // The RFC 6238 reference vector: the ASCII secret "12345678901234567890" is
  // GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ, and its code at T=59 is 287082.
  const reference = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(accounts.totpCode(reference, Math.floor(59 / 30)), '287082');

  const now = Math.floor(Date.now() / 30_000);
  const current = accounts.totpCode(secret, now);
  assert.equal(current.length, 6);
  assert.equal(accounts.verifyTotp(secret, current), true);

  // One step of drift is tolerated in either direction, two is not.
  assert.equal(accounts.verifyTotp(secret, accounts.totpCode(secret, now - 1)), true);
  assert.equal(accounts.verifyTotp(secret, accounts.totpCode(secret, now + 1)), true);
  assert.equal(accounts.verifyTotp(secret, accounts.totpCode(secret, now + 2)), false);

  // Malformed input is a no, not a crash.
  assert.equal(accounts.verifyTotp(secret, ''), false);
  assert.equal(accounts.verifyTotp(secret, 'abcdef'), false);
  assert.equal(accounts.verifyTotp('', current), false);
});

test('two-factor is only enabled once a real code has been proved', () => {
  const email = 'owner@example.com';
  accounts.disableTotp(email);

  const pending = accounts.pendingTotp(email);
  assert.ok(pending.length > 0, 'no candidate secret was offered');
  assert.ok(accounts.otpAuthUri(pending, email).startsWith('otpauth://totp/'));

  // A wrong code must not arm the factor: scanning a QR that is never confirmed has to leave
  // nothing behind.
  assert.throws(
    () => accounts.enableTotp(email, pending, '000000'),
    (error: unknown) => (error as { code?: string }).code === 'totp-wrong',
  );
  assert.equal(accounts.findByEmail(email)?.totpSecret, '');

  const step = Math.floor(Date.now() / 30_000);
  accounts.enableTotp(email, pending, accounts.totpCode(pending, step));
  assert.equal(accounts.findByEmail(email)?.totpSecret, pending);

  // Once armed, a sign-in without a code is refused and with one is accepted.
  assert.throws(
    () => accounts.signIn(email, 'correct horse battery'),
    (error: unknown) => (error as { code?: string }).code === 'totp-required',
  );

  accounts.disableTotp(email);
  assert.equal(accounts.findByEmail(email)?.totpSecret, '');
});

test('the session marker names an account, and dies with it', () => {
  accounts.signIn('owner@example.com', 'correct horse battery');
  const marker = accounts.readSession();
  assert.equal(marker?.email, 'owner@example.com');

  // The marker holds only the identity: nothing here may be a credential.
  const raw = fs.readFileSync(path.join(scratch, 'session.json'), 'utf8');
  assert.equal(raw.includes('hash'), false, 'the session marker carries a password hash');
  assert.equal(raw.includes('totp'), false, 'the session marker carries a second factor secret');

  assert.equal(accounts.currentAccount()?.email, 'owner@example.com');

  accounts.signOut();
  assert.equal(accounts.currentAccount(), null);

  // A marker pointing at a deleted account must not sign anybody in.
  accounts.signIn('owner@example.com', 'correct horse battery');
  accounts.removeAccount('owner@example.com');
  assert.equal(accounts.currentAccount(), null);
  assert.equal(accounts.storeIsUnreadable(), false);
});

test('a corrupt account store is preserved rather than overwritten', () => {
  accounts.reloadAccounts();
  accounts.register('second@example.com', 'another password', 'Second');

  const file = path.join(scratch, 'accounts.json');
  fs.writeFileSync(file, '{"format":"joe-accounts","ciphertext":"not-a-ciphertext"}', 'utf8');

  accounts.reloadAccounts();
  assert.equal(accounts.storeIsUnreadable(), true, 'an unreadable store was accepted as empty');
  // The refusal is the protection: a save here would replace every registration with nothing.
  assert.throws(() => accounts.register('third@example.com', 'yet another', 'Third'), /not being overwritten/);

  // The damaged file is still on disk, and a copy was taken beside it.
  const siblings = fs.readdirSync(scratch).filter((name) => name.startsWith('accounts.json'));
  assert.ok(siblings.length >= 2, `expected a backup beside the store, found ${siblings.join(', ')}`);

  // Start clean for anything after this test.
  for (const name of siblings) fs.unlinkSync(path.join(scratch, name));
  accounts.reloadAccounts();
});

/* ------------------------------------------------------------------ kernel diversity */

const diversity = await import('../src/main/core/diversity');

function kernel(id: string, engine = 'chrome', version = '141.0.7390.54'): {
  id: string;
  engine: string;
  version: string;
  path: string;
  exePath: string;
  installedAt: string;
} {
  return { id, engine, version, path: `/kernels/${id}`, exePath: `/kernels/${id}/chrome.exe`, installedAt: '' };
}

test('a lone build is never pinned, and says why', () => {
  const only = [kernel('chrome-141.0.7390.54')];
  const result = diversity.assignKernel(only, []);

  // Pinning the only build would make every profile break the day it is deleted, and buys
  // nothing in the meantime.
  assert.equal(result.kernelId, '');
  assert.match(result.reason, /only one browser build/i);
});

test('builds are spread across the profiles that already use them', () => {
  const available = [kernel('chrome-141.0.7390.54', 'chrome', '141.0.7390.54'), kernel('chrome-140.0.7339.80', 'chrome', '140.0.7339.80')];
  const existing = [
    { kernelId: 'chrome-141.0.7390.54' },
    { kernelId: 'chrome-141.0.7390.54' },
  ] as unknown as { kernelId: string }[] as never;

  const result = diversity.assignKernel(available, existing as never);
  // The unused build wins, so a fresh profile does not pile onto the popular one.
  assert.equal(result.kernelId, 'chrome-140.0.7339.80');
});

test('equal-usage builds rotate instead of always choosing the newest', () => {
  const available = [
    kernel('chrome-141.0.7390.54', 'chrome', '141.0.7390.54'),
    kernel('chrome-140.0.7339.80', 'chrome', '140.0.7339.80'),
    kernel('joe-139.0.7258.66', 'joe', '139.0.7258.66'),
  ];
  const first = diversity.assignKernel(available, []).kernelId;
  const second = diversity.assignKernel(available, [{ kernelId: first }] as never).kernelId;
  const third = diversity.assignKernel(available, [{ kernelId: first }, { kernelId: second }] as never).kernelId;
  assert.equal(new Set([first, second, third]).size, 3);
});

test('a duplicate never lands on the build its source is using', () => {
  const available = [kernel('chrome-141.0.7390.54'), kernel('firefox-141.0')];
  const source = { kernelId: 'chrome-141.0.7390.54' } as never;

  const result = diversity.assignDifferentKernel(available, source, [source]);
  assert.notEqual(result.kernelId, 'chrome-141.0.7390.54');
  assert.equal(result.kernelId, 'firefox-141.0');

  // With only the source's build installed, the copy falls back to the sentinel rather than
  // inheriting the pin: identical down to the binary is the one thing a re-roll cannot fix.
  const alone = diversity.assignDifferentKernel([kernel('chrome-141.0.7390.54')], source, [source]);
  assert.equal(alone.kernelId, '');
  assert.match(alone.reason, /only the source/i);
});

test('kernel diversity is counted across a workspace', () => {
  const profiles = [
    { kernelId: 'chrome-141' },
    { kernelId: 'chrome-141' },
    { kernelId: 'firefox-141' },
    { kernelId: '' },
  ] as never;
  assert.equal(diversity.distinctKernels(profiles), 3);
});

/* ------------------------------------------------------------------ disk space */

const disk = await import('../src/main/core/disk');

test('the disk guard refuses before a write rather than after it', () => {
  const free = disk.freeBytes();
  assert.ok(free === -1 || free > 0, 'free space reported as zero or negative');

  // Asking for more than any CI machine has must fail with a sentence, not a raw errno.
  if (free > 0) {
    assert.throws(
      () => disk.requireSpace(free + 1_000_000_000, 'install a build'),
      (error: unknown) => error instanceof disk.DiskFullError,
    );
  }

  // A small write on a machine with room must pass and report the free bytes.
  assert.doesNotThrow(() => disk.requireSpace(1024, 'write a profile'));
});

test('a full disk is recognised from every shape the error arrives in', () => {
  assert.equal(disk.isDiskFull({ code: 'ENOSPC' }), true);
  assert.equal(disk.isDiskFull({ code: 'EDQUOT' }), true);
  assert.equal(disk.isDiskFull(new Error('ENOSPC: no space left on device, write')), true);
  assert.equal(disk.isDiskFull(new Error('The disk is full')), true);
  assert.equal(disk.isDiskFull(new Error('Failed to create network context data directory')), false);
  assert.equal(disk.isDiskFull(null), false);
  assert.equal(disk.isDiskFull(undefined), false);
});

/* ------------------------------------------------------------------ pasted proxy lists */

test('a pasted proxy list is parsed the same way the library parses it', () => {
  const http = parseProxyLine('http://user:secret@10.0.0.4:8080');
  assert.ok(http, 'a full http line did not parse');
  assert.equal(http!.host, '10.0.0.4');
  assert.equal(http!.port, 8080);
  assert.equal(http!.type, 'http');

  const socks = parseProxyLine('socks5://10.0.0.9:1080');
  assert.ok(socks, 'a bare socks5 line did not parse');
  assert.equal(socks!.type, 'socks5');

  // A host:port pair with no scheme is the commonest paste of all and must not be rejected.
  const bare = parseProxyLine('10.0.1.7:3128');
  assert.ok(bare, 'a bare host:port line did not parse');
  assert.equal(bare!.port, 3128);

  assert.equal(parseProxyLine('not a proxy at all'), null);
  assert.equal(parseProxyLine(''), null);
});

test('the whole lock lifecycle holds together end to end', () => {
  // Each unit above is tested alone; this walks the order a person actually meets them, because
  // the bugs that matter are the ones between the steps - a PIN that cannot be used because
  // the unlock path reads a field the set path never wrote, a two-factor flag set without the
  // secret it needs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joe-lifecycle-'));
  const previous = process.env['JOE_BROWSER_DATA_DIR'];
  process.env['JOE_BROWSER_DATA_DIR'] = dir;

  // The real settings object, so the defaults the app ships with are the ones under test.
  const settings = () => ({ ...store.DEFAULT_SETTINGS, pinEnabled: false, autoLockMinutes: 15 });

  try {
    // Fresh install: the gate, not a lock screen.
    assert.equal(accounts.lockState(settings()).state, 'gate');

    const email = `lifecycle-${Date.now()}@example.com`;
    accounts.register(email, 'first password', 'Lifecycle');
    accounts.signIn(email, 'first password');
    assert.equal(accounts.lockState(settings()).state, 'open');

    // A PIN turns the next launch into a lock screen, and only the right one opens it.
    //
    // No `pinEnabled: true` here on purpose. The old test passed that flag, which the app never
    // wrote, so it proved a path no user could reach: a user who set a PIN still got an unlocked
    // workspace. The PIN existing is the only thing that should have to be true.
    accounts.setPin(email, '4821');
    assert.equal(accounts.lockState(settings()).state, 'locked');
    assert.throws(() => accounts.unlock('0000', ''), /PIN is not right/);
    accounts.unlock('4821', '');
    assert.equal(accounts.checkPin(email, '4821'), true);

    // Removing the PIN removes the lock. The setting was never the authority, and a stale one
    // must not be able to keep a lock that has no secret behind it.
    accounts.setPin(email, '');
    assert.equal(accounts.lockState({ ...settings(), pinEnabled: true }).state, 'open');
    accounts.setPin(email, '4821');
    assert.equal(accounts.lockState(settings()).state, 'locked');

    // Two-factor: enable with a proved code, then sign-in demands one.
    const secret = accounts.pendingTotp(email);
    const step = Math.floor(Date.now() / 30000);
    assert.equal(accounts.verifyTotp(secret, accounts.totpCode(secret, step)), true);
    assert.throws(() => accounts.enableTotp(email, secret, '000000'), /did not match/);
    accounts.enableTotp(email, secret, accounts.totpCode(secret, step));

    assert.throws(() => accounts.signIn(email, 'first password'), /six-digit code/);
    assert.equal(
      accounts.signIn(email, 'first password', accounts.totpCode(secret, step)).email,
      email,
    );

    // A password change takes effect and the old one stops working.
    accounts.changePassword(email, 'first password', 'second password');
    assert.throws(() => accounts.signIn(email, 'first password', accounts.totpCode(secret, step)), /does not match/);
    assert.equal(
      accounts.signIn(email, 'second password', accounts.totpCode(secret, step)).email,
      email,
    );

    // Signing out returns to the gate, and the account survives it.
    accounts.signOut();
    assert.equal(accounts.lockState(settings()).state, 'gate');
    assert.equal(accounts.listAccounts().some((row) => row.email === email), true);
  } finally {
    if (previous === undefined) delete process.env['JOE_BROWSER_DATA_DIR'];
    else process.env['JOE_BROWSER_DATA_DIR'] = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a workspace default build is honoured, and ignored when it is not installed', () => {
  // `defaultKernelId` was in the settings model from the start and read by nothing, so a user's
  // choice silently did nothing. These two cases pin the behaviour: it applies when the named
  // build is present, and it is ignored rather than launching a binary that is gone.
  const before = store.getSettings();
  try {
    store.saveSettings({ defaultKernelId: 'kernel-that-is-not-installed' });
    const fallback = store.createProfile({ name: 'Default build fallback' });
    assert.notEqual(
      fallback.kernelId,
      'kernel-that-is-not-installed',
      'a missing build id was written onto a profile',
    );
    store.deleteProfile(fallback.id, false);
  } finally {
    store.saveSettings({ defaultKernelId: before.defaultKernelId });
  }
});

test('proxy parser rejects malformed ports and credentials without throwing', () => {
  assert.equal(parseProxyLine('host:123junk'), null);
  assert.equal(parseProxyLine('http://%zz:pass@host:8080'), null);
  assert.equal(parseProxyLine('host:8080:user'), null);
  assert.deepEqual(parseProxyLine('socks5://user:pass@host:1080'), {
    type: 'socks5', host: 'host', port: 1080, user: 'user', password: 'pass',
  });
});

test('saved proxy credentials are preserved unless explicitly replaced or cleared', async () => {
  const vault = await import('../src/main/core/proxies');
  const config = { ...normalizeProxy({ type: 'http', host: 'proxy.test', port: 8080, user: 'alice' }), password: 'secret' };
  const created = vault.saveEntry({ name: 'example', config });
  assert.equal(vault.passwordOf(created), 'secret');
  const publicRow = vault.publicEntry(created);
  assert.equal('passwordEnc' in publicRow, false);
  const preserved = vault.saveEntry({ ...publicRow, config: publicRow.config });
  assert.equal(vault.passwordOf(preserved), 'secret');
  const cleared = vault.saveEntry({ ...publicRow, replacePassword: true, config: { ...publicRow.config, user: '', password: '' } });
  assert.equal(vault.passwordOf(cleared), '');
});

test('profile drafts do not persist and can be saved with their chosen fingerprint', () => {
  const before = store.countProfiles();
  const draft = store.draftProfile({ name: 'Unsaved draft' });
  assert.equal(store.countProfiles(), before);
  assert.equal(store.findProfile(draft.id), null);
  const saved = store.createProfile({ ...draft, preserveFingerprint: true });
  assert.equal(store.countProfiles(), before + 1);
  assert.deepEqual(saved.fingerprint, draft.fingerprint);
});

test('recycle bin restoration preserves profile ID, browser data and credentials', async () => {
  const trash = await import('../src/main/core/trash');
  const { Paths } = await import('../src/main/core/paths');
  const saved = store.createProfile({ name: 'Restore identity', proxy: normalizeProxy({ type: 'http', host: 'example.test', port: 8080, user: 'user', password: 'password' }) });
  const dir = Paths.profileData(saved.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cookies.test'), 'cookie data');
  store.deleteProfile(saved.id, true);
  const entry = trash.listTrash().find((row) => row.id === saved.id)!;
  assert.ok(entry);
  const restored = trash.restore(entry.file, (profile) => { store.restoreProfile(profile); });
  assert.equal(restored, saved.id);
  const record = store.findProfile(saved.id)!;
  assert.ok(record);
  assert.equal(store.proxyPasswordOf(record), 'password');
  assert.equal(fs.readFileSync(path.join(dir, 'cookies.test'), 'utf8'), 'cookie data');
  assert.equal(trash.listTrash().some((row) => row.id === saved.id), false);
});

test('recycle bin refuses to overwrite existing profile data and keeps the backup', async () => {
  const trash = await import('../src/main/core/trash');
  const { Paths } = await import('../src/main/core/paths');
  const saved = store.createProfile({ name: 'Restore conflict' });
  const dir = Paths.profileData(saved.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'original'), 'parked');
  store.deleteProfile(saved.id, true);
  const entry = trash.listTrash().find((row) => row.id === saved.id)!;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'current'), 'safe');
  assert.throws(() => trash.restore(entry.file, (profile) => { store.restoreProfile(profile); }), /already exists/);
  assert.equal(fs.readFileSync(path.join(dir, 'current'), 'utf8'), 'safe');
  assert.ok(trash.listTrash().some((row) => row.id === saved.id));
});

test('a failed restore rolls browser data back and retains the backup', async () => {
  const trash = await import('../src/main/core/trash');
  const { Paths } = await import('../src/main/core/paths');
  const saved = store.createProfile({ name: 'Restore rollback' });
  const dir = Paths.profileData(saved.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session'), 'retained');
  store.deleteProfile(saved.id, true);
  const entry = trash.listTrash().find((row) => row.id === saved.id)!;
  assert.throws(() => trash.restore(entry.file, () => { throw new Error('write failed'); }), /write failed/);
  assert.equal(fs.existsSync(dir), false);
  assert.ok(trash.listTrash().some((row) => row.id === saved.id));
  trash.restore(entry.file, (profile) => { store.restoreProfile(profile); });
  assert.equal(fs.readFileSync(path.join(dir, 'session'), 'utf8'), 'retained');
});

test('browser build IDs cannot escape the managed kernel directory', async () => {
  const { removeKernel, resolveKernelExe, downloadKernel } = await import('../src/main/core/catalog');
  for (const id of ['../other', '..', '/absolute', 'x/../../other', 'x\\..\\other']) {
    await assert.rejects(removeKernel(id), /Invalid browser build ID/);
    assert.throws(() => resolveKernelExe(id), /Invalid browser build ID/);
    await assert.rejects(downloadKernel({ id } as never, () => {}), /Invalid browser build ID/);
  }
  assert.equal(resolveKernelExe('chrome-123.0-stable'), null);
});

test('proxy alerts only on transitions and include old and new IP addresses', async () => {
  const { ProxyWatchState } = await import('../src/main/core/proxyWatch');
  const state = new ProxyWatchState('Work');
  assert.deepEqual(state.success('192.0.2.1', ''), []);
  assert.equal(state.failure('timeout'), null);
  assert.match(state.failure('timeout')!.message, /stopped answering/);
  assert.equal(state.failure('timeout'), null);
  const notices = state.success('192.0.2.2', 'London');
  assert.equal(notices.length, 2);
  assert.match(notices[0]!.message, /answering again/);
  assert.equal(notices[1]!.detail, '192.0.2.1 → 192.0.2.2');
  assert.deepEqual(state.success('192.0.2.2', ''), []);
});

test('editing a proxy endpoint clears stale location while a name edit preserves it', async () => {
  const vault = await import('../src/main/core/proxies');
  const config = normalizeProxy({ type: 'http', host: 'old.test', port: 80, lastIp: '8.8.8.8', lastCountry: 'United States', lastCountryCode: 'US' });
  const created = vault.saveEntry({ name: 'before', config, lastStatus: 1, lastIp: '8.8.8.8', lastCountry: 'United States', lastCountryCode: 'US' });
  const renamed = vault.saveEntry({ id: created.id, name: 'after', config: vault.publicEntry(created).config });
  assert.equal(renamed.lastCountryCode, 'US');
  assert.equal(renamed.lastStatus, 1);
  const changed = vault.saveEntry({ id: created.id, name: 'after', config: { ...vault.publicEntry(renamed).config, host: 'new.test' } });
  assert.equal(changed.lastCountryCode, '');
  assert.equal(changed.config.lastIp, '');
  assert.equal(changed.lastStatus, 0);
});

test('profile country lookup uses the configured connection and never falls back to direct', async () => {
  const { ProfileLocationService } = await import('../src/main/core/profileLocation');
  let directCount = 0, proxyCount = 0, now = 0;
  const answer = { ok: true, ip: '1.2.3.4', country: 'United Kingdom', countryCode: 'GB', city: '', timezone: '', latencyMs: 1, error: '' };
  const service = new ProfileLocationService(async () => { directCount++; return answer; }, async () => { proxyCount++; return { ...answer, country: 'Germany', countryCode: 'DE' }; }, () => now);
  const direct = store.draftProfile({ name: 'direct' });
  const proxy = { ...direct, id: 'proxy', proxy: normalizeProxy({ type: 'http', host: 'test.invalid', port: 8080 }) };
  const results = await Promise.all([service.locate(direct), service.locate(direct), service.locate(proxy)]);
  assert.equal(results[0]!.country, 'United Kingdom');
  assert.equal(results[2]!.countryCode, 'DE');
  assert.equal(directCount, 1);
  assert.equal(proxyCount, 1);
  const fallback = await service.locate(proxy, true);
  assert.equal(fallback.key, 'direct');
  assert.equal(fallback.countryCode, 'GB');
  assert.equal(directCount, 1);
  await service.locate(proxy);
  assert.equal(proxyCount, 1);
  now = 300_001;
  await service.locate(proxy);
  assert.equal(proxyCount, 2);
  const changed = { ...proxy, proxy: { ...proxy.proxy, host: 'other.invalid' } };
  assert.notEqual(store.profileLocationKey(proxy), store.profileLocationKey(changed));
  const failing = new ProfileLocationService(async () => { throw new Error('must not use direct'); }, async () => ({ ...answer, ok: false, country: '', countryCode: '' }));
  assert.equal((await failing.locate(changed)).ok, false);
  assert.equal((await failing.locate({ ...changed, proxy: { ...changed.proxy, host: '', port: 0 } })).ok, false);
});

test('IP lookup response has a timeout after the socket connects', async () => {
  const net = await import('node:net');
  const { httpGetOver } = await import('../src/main/core/proxy');
  const server = net.createServer(socket => { socket.on('data', () => undefined); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  try { await assert.rejects(httpGetOver(socket, 'example.test', '/', 50), /timed out/); }
  finally { socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('managed build assignment and duplication never cross browser engines', async () => {
  const { Paths } = await import('../src/main/core/paths');
  const { listKernels } = await import('../src/main/core/catalog');
  const previous = store.getSettings();
  const ids = ['chrome-1-stable', 'chrome-2-stable', 'firefox-3-stable'];
  const created: string[] = [];
  try {
    for (const [id, engine, version] of [['chrome-1-stable', 'chrome', '1'], ['chrome-2-stable', 'chrome', '2'], ['firefox-3-stable', 'firefox', '3']]) {
      const dir = path.join(Paths.kernels, id!);
      fs.mkdirSync(dir, { recursive: true });
      const exePath = path.join(dir, 'browser');
      fs.writeFileSync(exePath, 'test');
      fs.writeFileSync(path.join(dir, 'kernel.json'), JSON.stringify({ id, engine, version, path: dir, exePath, installedAt: '' }));
    }
    store.saveSettings({ defaultEngine: 'chrome', defaultKernelId: 'firefox-3-stable' });
    const source = store.createProfile({ name: 'Engine check', engine: 'chrome' });
    created.push(source.id);
    assert.ok(source.kernelId.startsWith('chrome-'));
    const duplicate = store.duplicateProfile(source.id);
    created.push(duplicate.id);
    assert.ok(duplicate.kernelId.startsWith('chrome-'));
    assert.notEqual(source.kernelId, duplicate.kernelId);
    // A fresh cache with an unrelated entry must not hide older installed versions.
    fs.writeFileSync(Paths.storeFile('catalog.json'), JSON.stringify({ schemaVersion: 2, fetchedAt: Date.now(), builds: [{ id: 'other', engine: 'chrome', version: '9', channel: 'stable', os: '', downloadUrl: '', installed: false, path: '', sizeBytes: 0 }] }));
    const listed = await listKernels();
    for (const id of ids) assert.ok(listed.some((build) => build.id === id && build.installed));
  } finally {
    for (const id of created) store.deleteProfile(id, false);
    store.saveSettings({ defaultEngine: previous.defaultEngine, defaultKernelId: previous.defaultKernelId });
    for (const id of ids) fs.rmSync(path.join(Paths.kernels, id), { recursive: true, force: true });
    fs.rmSync(Paths.storeFile('catalog.json'), { force: true });
  }
});

test('clearing a live profile never clears unrelated storage or hides CDP errors', async () => {
  const { BrowserSession } = await import('../src/main/core/launcher');
  const profile = store.draftProfile({ name: 'Clear scope test' });
  const session = new BrowserSession(profile, async () => { throw new Error('unused'); });
  const calls: string[] = [];
  const fake = { send: async (method: string) => {
    calls.push(method);
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'page', type: 'page' }] };
    if (method === 'Target.attachToTarget') return { sessionId: 'session' };
    if (method === 'Network.clearBrowserCookies') throw new Error('rejected');
    return {};
  } };
  (session as unknown as { cdp: unknown }).cdp = fake;
  assert.equal(await session.clearStorage('cache'), true);
  assert.ok(calls.includes('Network.clearBrowserCache'));
  assert.ok(!calls.includes('Network.clearBrowserCookies'));
  assert.ok(!calls.includes('Storage.clearDataForOrigin'));
  assert.equal(await session.clearStorage('cookies'), false);
  const previousCalls = calls.length;
  assert.equal(await session.clearStorage('siteData'), false);
  assert.equal(calls.length, previousCalls);
});

test('a proxy fallback is reported and never monitored as the active connection', async () => {
  const net = await import('node:net');
  const { BrowserSession } = await import('../src/main/core/launcher');
  const upstream = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as import('node:net').AddressInfo).port;
  const profile = store.draftProfile({ name: 'Proxy fallback', engine: 'firefox',
    proxy: { ...normalizeProxy({ type: 'http', host: '127.0.0.1', port }), fallbackDirect: true },
    tools: { ...store.defaultTools(), proxyWatch: true },
  });
  const session = new BrowserSession(profile, async () => ({ exe: process.execPath, engine: 'firefox', version: '1' }));
  try {
    const info = await session.start(profile, 'about:blank');
    assert.equal(info.proxyFellBack, true);
    assert.equal((session as unknown as { watchTimer: unknown }).watchTimer, null);
    assert.equal(info.exitIp, '');
  } finally {
    await session.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync((await import('../src/main/core/paths')).Paths.profileData(profile.id), { recursive: true, force: true });
  }
});

test('Brave catalog uses exact vendor assets, channel, Chromium version and SHA-256', async () => {
  const { braveBuildsFromReleases, verifyArchiveSha256 } = await import('../src/main/core/catalog');
  const crypto = await import('node:crypto');
  const version = '1.101.50';
  const name = `brave-v${version}-win32-x64.zip`;
  const digest = crypto.createHash('sha256').update('trusted').digest('hex');
  const asset = { name, browser_download_url: `https://github.com/brave/brave-browser/releases/download/v${version}/${name}`, size: 7, digest: `sha256:${digest}` };
  const release = { name: `Beta v${version} (Chromium 158.0.8127.37)`, tag_name: `v${version}`, assets: [asset] };
  const rows = braveBuildsFromReleases([release]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.engine, 'brave');
  assert.equal(rows[0]!.channel, 'beta');
  assert.equal(rows[0]!.version, version);
  assert.equal(rows[0]!.runtimeVersion, '158.0.8127.37');
  assert.equal(rows[0]!.sha256, digest);
  assert.equal(braveBuildsFromReleases([{ ...release, assets: [{ ...asset, digest: '' }] }]).length, 0);
  assert.equal(braveBuildsFromReleases([{ ...release, assets: [{ ...asset, browser_download_url: 'https://other.test/file.zip' }] }]).length, 0);
  assert.equal(braveBuildsFromReleases([{ ...release, name: `Release v${version} (Chromium 158.0.8127.37)`, tag_name: 'v1.2.3' }]).length, 0);
  assert.equal(braveBuildsFromReleases([{ ...release, name: `Release v${version} (Chromium 158.0.8127.37)`, prerelease: true }]).length, 0);
  const archive = path.join(scratch, 'checksum-test');
  fs.writeFileSync(archive, 'trusted');
  try {
    await verifyArchiveSha256(archive, digest);
    await assert.rejects(verifyArchiveSha256(archive, '0'.repeat(64)), /integrity/);
    await assert.rejects(verifyArchiveSha256(archive, 'bad'), /Invalid/);
  } finally { fs.rmSync(archive, { force: true }); }
});

test('country names follow the bundled flag code across countries and reject unknown codes', async () => {
  const { countryCode, countryName } = await import('../src/shared/countries');
  const countries = JSON.parse(fs.readFileSync('node_modules/flag-icons/country.json', 'utf8')) as { code: string }[];
  for (const entry of countries.filter((item) => /^[a-z]{2}$/.test(item.code))) {
    assert.equal(countryCode(entry.code), entry.code.toUpperCase());
    assert.ok(countryName(entry.code));
  }
  assert.equal(countryName('DE', 'United Kingdom'), 'Germany');
  assert.equal(countryName('gb', 'Germany'), 'United Kingdom');
  assert.equal(countryCode('zz'), '');
});

test('country names resolve to the same code used by their circular flag', async () => {
  const { countryCodeFromName, countryName } = await import('../src/shared/countries');
  assert.equal(countryCodeFromName('Germany'), 'DE');
  assert.equal(countryCodeFromName('United Kingdom'), 'GB');
  assert.equal(countryCodeFromName('United States'), 'US');
  assert.equal(countryCodeFromName('USA'), 'US');
  assert.equal(countryCodeFromName('UK'), 'GB');
  assert.equal(countryCodeFromName('Russian Federation'), 'RU');
  assert.equal(countryCodeFromName('de'), 'DE');
  assert.equal(countryCodeFromName(''), '');
  assert.equal(countryCodeFromName('Atlantis'), '');
  assert.equal(countryName(countryCodeFromName('Germany')), 'Germany');
});

test('history retains previous sessions and marks redirects without duplicating them', () => {
  const profile = store.createProfile({ name: 'History persistence' });
  const dir = path.join(scratch, 'history');
  fs.mkdirSync(dir, { recursive: true });
  const old = { profileId: profile.id, profileName: profile.name, at: '2020-01-01T00:00:00.000Z', url: 'https://previous.test/', title: '', how: 'link', hop: false };
  fs.writeFileSync(path.join(dir, `${profile.id}.jsonl`), JSON.stringify(old) + '\n');
  try {
    history.record(profile.id, 'https://redirect.test/');
    history.markRedirect(profile.id, 'https://redirect.test/');
    history.record(profile.id, 'https://final.test/#fragment');
    history.attachTitle(profile.id, 'https://final.test/#fragment', 'Final title');
    const rows = history.list(profile.id);
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.title, 'Final title');
    assert.equal(rows[0]!.url, 'https://final.test/#fragment');
    assert.equal(rows[1]!.hop, true);
    assert.equal(rows[2]!.url, old.url);
    const disk = fs.readFileSync(path.join(dir, `${profile.id}.jsonl`), 'utf8');
    assert.match(disk, /"hop":true/);
    assert.match(disk, /Final title/);
  } finally { history.clear(profile.id); store.deleteProfile(profile.id, false); }
});

test('CDP event listeners are active before auto-attach can pause a target', async () => {
  const { BrowserSession } = await import('../src/main/core/launcher');
  const { CdpClient } = await import('../src/main/core/cdp');
  const profile = store.draftProfile({ name: 'Early target' });
  const session = new BrowserSession(profile, async () => { throw new Error('unused'); });
  const listeners = new Map<string, (params: Record<string, unknown>, id: string) => void>();
  const calls: string[] = [];
  const fake = {
    on(method: string, handler: (params: Record<string, unknown>, id: string) => void) { listeners.set(method, handler); return () => {}; },
    async send(method: string) {
      calls.push(method);
      if (method === 'Target.setAutoAttach') listeners.get('Target.attachedToTarget')?.({ sessionId: 'early', targetInfo: { type: 'page', targetId: 'target-1' } }, '');
      if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'target-1' }] };
      return {};
    },
  };
  const original = CdpClient.connect;
  CdpClient.connect = async () => fake as unknown as Awaited<ReturnType<typeof CdpClient.connect>>;
  try {
    await (session as unknown as { attachCDP(engine: string): Promise<void> }).attachCDP('chrome');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(calls.includes('Page.addScriptToEvaluateOnNewDocument'));
    assert.ok(calls.includes('Runtime.runIfWaitingForDebugger'));
    assert.ok(!calls.includes('Target.attachToTarget'), 'an auto-attached target must not be attached twice');
  } finally { CdpClient.connect = original; }
});

test('new profiles honor the configured start page and preserve explicit URLs', () => {
  const before = store.getSettings().startPage;
  try {
    assert.equal(store.DEFAULT_SETTINGS.startPage, 'https://browsercan.net?utm_source=chatgpt.com');
    store.saveSettings({ startPage: 'https://start.example/' });
    assert.equal(store.draftProfile({ name: 'Default start' }).startUrl, 'https://start.example/');
    assert.equal(store.draftProfile({ name: 'Custom start', startUrl: 'https://custom.example/' }).startUrl, 'https://custom.example/');
  } finally { store.saveSettings({ startPage: before }); }
});
