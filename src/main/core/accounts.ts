import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Account, AccountSummary, AppSettings } from '../../shared/types';
import { writeJson, readJson } from './atomic';
import { Paths } from './paths';
import { decryptSecret, encryptSecret } from './secrets';
import { log } from './log';

/**
 * Local accounts, the app lock and a second factor.
 *
 * The original gated the whole application behind an email account, with an optional PIN typed
 * at every launch and an optional authenticator-app code. That is not a cloud account: there is
 * no server, no verification mail and no sync. An "account" is a row in one encrypted file with
 * a salted PBKDF2 hash, and its only jobs are to name the person using the workspace and to hold
 * the lock settings.
 *
 * Three decisions worth stating, because each one is a defect avoided:
 *
 *  - The password hash is PBKDF2-SHA512 with 600,000 iterations. The original used SHA1 at
 *    100,000; that was defensible when it was written and is not now.
 *  - A store that cannot be read is never overwritten. The original learned this the hard way:
 *    a DPAPI failure read as "no accounts", and the next save replaced every registration with
 *    an empty list. Here an unreadable or undecryptable file is copied aside and the write is
 *    refused until it can be read.
 *  - The session marker on disk holds only the email and the display name. The hash, the PIN and
 *    the TOTP secret never leave `accounts.json`.
 */

const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const PIN_ITERATIONS = 260_000;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export type AccountError =
  | 'bad-email'
  | 'bad-password'
  | 'exists'
  | 'missing'
  | 'wrong-password'
  | 'locked'
  | 'totp-required'
  | 'totp-wrong'
  | 'pin-wrong'
  | 'store-unreadable'
  | 'no-account';

/** A typed failure the renderer can turn into a sentence in the user's language. */
export class AccountFailure extends Error {
  readonly code: AccountError;
  constructor(code: AccountError, message: string) {
    super(message);
    this.code = code;
    this.name = 'AccountFailure';
  }
}

/* ------------------------------------------------------------------ storage */

const accountsFile = () => Paths.storeFile('AppAccounts.json');
const sessionFile = () => Paths.storeFile('session.json');

let unreadable = false;
let cached: Account[] | null = null;

function normalizeEmail(email: string): string {
  return (email ?? '').trim().toLowerCase();
}

function looksLikeEmail(email: string): boolean {
  // Deliberately loose. A gate that rejects a valid address because of a regex is worse than
  // one that accepts a typo, since the address is only ever used as a label here.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function readStore(): Account[] {
  if (cached) return cached;

  const file = accountsFile();
  if (!fs.existsSync(file)) {
    unreadable = false;
    cached = [];
    return cached;
  }

  try {
    const raw = fs.readFileSync(file, 'utf8');
    const envelope = JSON.parse(raw) as { format?: string; ciphertext?: string } | Account[];
    let list: Account[];

    if (Array.isArray(envelope)) {
      // A file from before encryption, or hand-edited. Read it rather than refusing.
      list = envelope;
    } else {
      const plain = decryptSecret(envelope.ciphertext ?? '');
      if (!plain) throw new Error('the store could not be decrypted');
      list = JSON.parse(plain) as Account[];
    }

    if (!Array.isArray(list)) throw new Error('the store is not a list');
    unreadable = false;
    cached = list;
    return list;
  } catch (error) {
    // Preserve the evidence before anything can overwrite it, then refuse to write. Losing a
    // registration is recoverable; silently replacing ten of them is not.
    log.error('Account store is unreadable', error);
    try {
      const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    } catch {
      /* The backup is a courtesy; the refusal below is the protection. */
    }
    unreadable = true;
    cached = [];
    return cached;
  }
}

function writeStore(list: Account[]): void {
  if (unreadable) {
    throw new AccountFailure(
      'store-unreadable',
      'The account file could not be read, so it is not being overwritten. A backup is beside it.',
    );
  }
  const json = JSON.stringify(list);
  writeJson(accountsFile(), {
    format: 'joe-accounts',
    version: 1,
    ciphertext: encryptSecret(json),
  });
  cached = list;
}

export function reloadAccounts(): void {
  cached = null;
  unreadable = false;
  readStore();
}

export function storeIsUnreadable(): boolean {
  return unreadable;
}

/* ------------------------------------------------------------------ hashing */

function hash(password: string, salt: Buffer, iterations: number): string {
  return crypto.pbkdf2Sync(password, salt, iterations, KEY_BYTES, 'sha512').toString('base64');
}

function makePassword(password: string): { salt: string; hash: string; iterations: number } {
  const salt = crypto.randomBytes(SALT_BYTES);
  return {
    salt: salt.toString('base64'),
    hash: hash(password, salt, ITERATIONS),
    iterations: ITERATIONS,
  };
}

function verifyPassword(password: string, record: Account): boolean {
  const salt = Buffer.from(record.salt, 'base64');
  const expected = Buffer.from(record.hash, 'base64');
  const actual = Buffer.from(hash(password, salt, record.iterations || ITERATIONS), 'base64');
  // Length first: timingSafeEqual throws on a length mismatch, and a throw here would read as a
  // wrong password with a different code path than a wrong password.
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function makePin(pin: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(SALT_BYTES);
  return { salt: salt.toString('base64'), hash: hash(pin, salt, PIN_ITERATIONS) };
}

function verifyPin(pin: string, record: Account): boolean {
  if (!record.pinHash || !record.pinSalt) return false;
  const expected = Buffer.from(record.pinHash, 'base64');
  const actual = Buffer.from(hash(pin, Buffer.from(record.pinSalt, 'base64'), PIN_ITERATIONS), 'base64');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/* ------------------------------------------------------------------ account operations */

export function accountCount(): number {
  return readStore().length;
}

export function listAccounts(): AccountSummary[] {
  return readStore()
    .map((account) => toSummary(account))
    .sort((a, b) => (a.lastLogin || a.created).localeCompare(b.lastLogin || b.created) * -1);
}

function toSummary(account: Account): AccountSummary {
  return {
    email: account.email,
    displayName: account.displayName,
    created: account.created,
    lastLogin: account.lastLogin,
    pinEnabled: Boolean(account.pinHash),
    twoFactorEnabled: Boolean(account.totpSecret),
  };
}

export function findByEmail(email: string): Account | null {
  const key = normalizeEmail(email);
  return readStore().find((account) => normalizeEmail(account.email) === key) ?? null;
}

export function register(email: string, password: string, displayName: string): AccountSummary {
  const clean = normalizeEmail(email);
  if (!looksLikeEmail(clean)) throw new AccountFailure('bad-email', 'That does not look like an email address.');
  if ((password ?? '').length < 6) {
    throw new AccountFailure('bad-password', 'Use at least six characters.');
  }
  if (findByEmail(clean)) throw new AccountFailure('exists', 'An account with that address already exists on this PC.');

  const credentials = makePassword(password);
  const record: Account = {
    email: clean,
    displayName: (displayName ?? '').trim() || clean.split('@')[0] || clean,
    salt: credentials.salt,
    hash: credentials.hash,
    iterations: credentials.iterations,
    created: new Date().toISOString(),
    lastLogin: new Date().toISOString(),
    pinEnabled: false,
    pinSalt: '',
    pinHash: '',
    totpSecret: '',
    totpPending: '',
  };

  const list = [...readStore(), record];
  writeStore(list);
  openSession(record);
  return toSummary(record);
}

export function signIn(email: string, password: string, code?: string): AccountSummary {
  const account = findByEmail(email);
  if (!account) throw new AccountFailure('missing', 'No account with that address on this PC.');
  if (!verifyPassword(password ?? '', account)) {
    throw new AccountFailure('wrong-password', 'That password does not match this address.');
  }

  if (account.totpSecret) {
    if (!code) throw new AccountFailure('totp-required', 'This account asks for a six-digit code.');
    if (!verifyTotp(account.totpSecret, code)) {
      throw new AccountFailure('totp-wrong', 'That code did not match. Codes change every 30 seconds.');
    }
  }

  account.lastLogin = new Date().toISOString();
  writeStore(readStore().map((row) => (normalizeEmail(row.email) === normalizeEmail(account.email) ? account : row)));
  openSession(account);
  return toSummary(account);
}

export function changePassword(email: string, current: string, next: string): void {
  const account = findByEmail(email);
  if (!account) throw new AccountFailure('missing', 'No account with that address on this PC.');
  if (!verifyPassword(current ?? '', account)) {
    throw new AccountFailure('wrong-password', 'That password does not match this address.');
  }
  if ((next ?? '').length < 6) throw new AccountFailure('bad-password', 'Use at least six characters.');

  const credentials = makePassword(next);
  account.salt = credentials.salt;
  account.hash = credentials.hash;
  account.iterations = credentials.iterations;
  writeStore(readStore().map((row) => (normalizeEmail(row.email) === normalizeEmail(email) ? account : row)));
}

export function renameAccount(email: string, displayName: string): void {
  const account = findByEmail(email);
  if (!account) throw new AccountFailure('missing', 'No account with that address on this PC.');
  account.displayName = (displayName ?? '').trim() || account.displayName;
  writeStore(readStore().map((row) => (normalizeEmail(row.email) === normalizeEmail(email) ? account : row)));
  const session = readSession();
  if (session && normalizeEmail(session.email) === normalizeEmail(email)) {
    openSession(account);
  }
}

export function removeAccount(email: string): void {
  const list = readStore().filter((account) => normalizeEmail(account.email) !== normalizeEmail(email));
  writeStore(list);

  // The marker must not survive its account: a stale marker used to sign back in the record it
  // pointed at, which no longer exists.
  const session = readSession();
  if (!session || normalizeEmail(session.email) === normalizeEmail(email)) {
    try {
      if (fs.existsSync(sessionFile())) fs.unlinkSync(sessionFile());
    } catch (error) {
      log.error('Cannot clear the session marker', error);
    }
  }
}

/* ------------------------------------------------------------------ lock settings */

export function setPin(email: string, pin: string): void {
  const account = findByEmail(email);
  if (!account) throw new AccountFailure('missing', 'No account with that address on this PC.');

  if (!pin) {
    account.pinSalt = '';
    account.pinHash = '';
    account.pinEnabled = false;
  } else {
    if (!/^\d{4,12}$/.test(pin)) throw new AccountFailure('pin-wrong', 'A PIN is four to twelve digits.');
    const record = makePin(pin);
    account.pinSalt = record.salt;
    account.pinHash = record.hash;
    account.pinEnabled = true;
  }

  writeStore(readStore().map((row) => (normalizeEmail(row.email) === normalizeEmail(email) ? account : row)));
}

export function checkPin(email: string, pin: string): boolean {
  const account = findByEmail(email);
  if (!account) return false;
  return verifyPin(pin ?? '', account);
}

export function pinRequired(email: string): boolean {
  return Boolean(findByEmail(email)?.pinHash);
}

/* ------------------------------------------------------------------ the second factor */

export function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function otpAuthUri(secret: string, email: string, issuer = 'Joe Browser'): string {
  const label = encodeURIComponent(`${issuer}:${normalizeEmail(email)}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The candidate secret waiting for its first valid code. */
export function pendingTotp(email: string): string {
  const account = findByEmail(email);
  if (!account) throw new AccountFailure('missing', 'No account with that address on this PC.');
  // Offer the stored secret when one is already active, so the same code can be re-scanned
  // after a phone is replaced. A fresh candidate otherwise, and the dialog reuses it for the
  // whole session so the QR does not change under the user's phone.
  if (account.totpSecret) return account.totpSecret;
  if (!account.totpPending) {
    account.totpPending = newTotpSecret();
    writeStore(readStore().map((row) => (normalizeEmail(row.email) === normalizeEmail(email) ? account : row)));
  }
  return account.totpPending;
}

export function enableTotp(email: string, secret: string, code: string): void {
  const account = findByEmail(email);
  if (!account) throw new AccountFailure('missing', 'No account with that address on this PC.');
  if (!/^\d{6}$/.test((code ?? '').trim())) {
    throw new AccountFailure('totp-wrong', 'Enter the six digits from the authenticator.');
  }
  if (!verifyTotp(secret, code)) {
    throw new AccountFailure('totp-wrong', 'That code did not match. Try the current one.');
  }
  account.totpSecret = secret;
  account.totpPending = '';
  writeStore(readStore().map((row) => (normalizeEmail(row.email) === normalizeEmail(email) ? account : row)));
}

export function disableTotp(email: string): void {
  const account = findByEmail(email);
  if (!account) throw new AccountFailure('missing', 'No account with that address on this PC.');
  account.totpSecret = '';
  account.totpPending = '';
  writeStore(readStore().map((row) => (normalizeEmail(row.email) === normalizeEmail(email) ? account : row)));
}

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = (text ?? '').trim().replace(/[\s-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of clean) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpCode(secret: string, step: number): string {
  const key = base32Decode(secret);
  if (key.length === 0) return '';
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step % 2 ** 32, 4);
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

/** True when the code matches now, or within one 30-second step either way. */
export function verifyTotp(secret: string, code: string): boolean {
  const clean = (code ?? '').trim().replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const step = Math.floor(Date.now() / 30_000);
  for (let drift = -1; drift <= 1; drift++) {
    if (totpCode(secret, step + drift) === clean) return true;
  }
  return false;
}

/** Seconds left in the current step, for the countdown beside the code field. */
export function totpSecondsLeft(): number {
  return 30 - Math.floor((Date.now() / 1000) % 30);
}

/* ------------------------------------------------------------------ the session marker */

export function openSession(account: Account): void {
  // Only the identity. A marker that also carried the hash would be a second copy of the
  // credential, sitting in a file the app reads before it has asked anyone for a password.
  writeJson(sessionFile(), {
    email: account.email,
    displayName: account.displayName,
    at: new Date().toISOString(),
  });
}

export function readSession(): { email: string; displayName: string; at: string } | null {
  try {
    if (!fs.existsSync(sessionFile())) return null;
    const raw = readJson<{ email?: string; displayName?: string; at?: string }>(sessionFile(), {});
    if (!raw.email || typeof raw.email !== 'string') return null;
    return { email: raw.email, displayName: raw.displayName ?? raw.email, at: raw.at ?? '' };
  } catch {
    return null;
  }
}

/** The account the marker names, but only if it still exists in the store. */
export function currentAccount(): AccountSummary | null {
  const marker = readSession();
  if (!marker) return null;
  const account = findByEmail(marker.email);
  return account ? toSummary(account) : null;
}

export function signOut(): void {
  try {
    if (fs.existsSync(sessionFile())) fs.unlinkSync(sessionFile());
  } catch (error) {
    log.error('Cannot clear the session marker', error);
  }
}

/**
 * What the window should show before anything else is drawn.
 *
 * `gate` means no account exists yet, so the welcome screen is the only way in. `locked` means a
 * session exists but a PIN or a second factor was configured: the workspace must not paint until
 * the code has been accepted.
 */
export function lockState(_settings?: AppSettings): {
  state: 'gate' | 'locked' | 'open';
  account: AccountSummary | null;
  pin: boolean;
  totp: boolean;
} {
  const account = currentAccount();
  if (!account) {
    return { state: accountCount() === 0 ? 'gate' : 'gate', account: null, pin: false, totp: false };
  }

  /*
   * A PIN that exists is a PIN that locks.
   *
   * This used to require `settings.pinEnabled` as well, and nothing ever set that flag: a user
   * set a PIN from the Security panel, the account recorded it, and the app still opened
   * straight to the workspace. The account is the authority - it is what actually holds the
   * hash - and a second switch that has to agree with it is a switch that can silently disagree.
   *
   * The Settings toggle now only offers to *remove* a PIN it can already see, so there is one
   * source of truth and no way to turn the lock "on" without a secret behind it.
   */
  const pin = account.pinEnabled;
  const totp = account.twoFactorEnabled;
  return {
    state: pin || totp ? 'locked' : 'open',
    account,
    pin,
    totp,
  };
}

/** Unlocks the current session. Both factors are checked when both are configured. */
export function unlock(pin: string, code: string): void {
  const account = currentAccount();
  if (!account) throw new AccountFailure('no-account', 'Nobody is signed in on this PC.');

  if (account.pinEnabled && !checkPin(account.email, pin)) {
    throw new AccountFailure('pin-wrong', 'That PIN is not right.');
  }
  if (account.twoFactorEnabled) {
    const record = findByEmail(account.email);
    if (!record?.totpSecret || !verifyTotp(record.totpSecret, code)) {
      throw new AccountFailure('totp-wrong', 'That code did not match. Codes change every 30 seconds.');
    }
  }
}

/** Exported for the tests: a fixed clock is the only way to assert a known code. */
export const _internals = { hash, verifyPassword, makePassword, totpCode, ITERATIONS, PIN_ITERATIONS };
