import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extensionId, storeListingId, verifyStoreCrx } from '../src/main/core/storeCrx';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'joe-ext-test-'));
process.env.JOE_BROWSER_DATA_DIR = scratch;
const { addFromCrxFile, libraryReport, isStoreDownloadUrl, addFromUrl } = await import('../src/main/core/library');

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(name: string, content: string): Buffer {
  const fileName = Buffer.from(name), data = Buffer.from(content);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12); end.writeUInt32LE(local.length + fileName.length + data.length, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}
function varint(value: number): Buffer {
  const bytes: number[] = [];
  while (value >= 128) { bytes.push((value % 128) | 128); value = Math.floor(value / 128); }
  bytes.push(value);
  return Buffer.from(bytes);
}
function field(n: number, bytes: Buffer): Buffer { return Buffer.concat([varint(n * 8 + 2), varint(bytes.length), bytes]); }
function signedCrx(archive: Buffer): { crx: Buffer; id: string; key: Buffer } {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = pair.publicKey.export({ format: 'der', type: 'spki' });
  const id = extensionId(key);
  const signedHeader = field(1, crypto.createHash('sha256').update(key).digest().subarray(0, 16));
  const length = Buffer.alloc(4); length.writeUInt32LE(signedHeader.length);
  const signature = crypto.sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), length, signedHeader, archive]), pair.privateKey);
  const proof = Buffer.concat([field(1, key), field(2, signature)]);
  const header = Buffer.concat([field(2, proof), field(10000, signedHeader)]);
  const prefix = Buffer.alloc(12); prefix.write('Cr24'); prefix.writeUInt32LE(3, 4); prefix.writeUInt32LE(header.length, 8);
  return { crx: Buffer.concat([prefix, header, archive]), id, key };
}

test('store listing URLs require an official host and a valid ID', () => {
  const id = 'ddkjiahejlhfcafbddmgiahcphecmpfh';
  assert.equal(storeListingId(`https://chromewebstore.google.com/detail/name/${id}?hl=en`), id);
  assert.equal(storeListingId(`https://chrome.google.com/webstore/detail/${id}`), id);
  assert.equal(storeListingId(`https://chromewebstore.google.com.evil.test/detail/${id}`), null);
  assert.equal(storeListingId('https://chromewebstore.google.com/search/foo'), null);
  assert.equal(storeListingId(`http://chromewebstore.google.com/detail/${id}`), null);
});

test('CRX3 verification binds signature, archive, and listing identity', () => {
  const pkg = signedCrx(zip('manifest.json', '{"name":"Test","version":"1","manifest_version":3}'));
  assert.deepEqual(verifyStoreCrx(pkg.crx, pkg.id), pkg.key);
  assert.throws(() => verifyStoreCrx(pkg.crx, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), /identity/);
  const damaged = Buffer.from(pkg.crx); damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
  assert.throws(() => verifyStoreCrx(damaged, pkg.id), /signature/);
  assert.throws(() => verifyStoreCrx(pkg.crx.subarray(0, 20), pkg.id), /header/);
});

test('verified packages retain their identity and duplicate installs are rejected', () => {
  const pkg = signedCrx(zip('manifest.json', '{"name":"Test","version":"1","manifest_version":3}'));
  const file = path.join(scratch, 'test.crx'); fs.writeFileSync(file, pkg.crx);
  const key = verifyStoreCrx(pkg.crx, pkg.id);
  const item = addFromCrxFile(file, { publicKey: key, storeUrl: `https://chromewebstore.google.com/detail/${pkg.id}` });
  assert.equal(item.storeId, pkg.id);
  assert.equal(item.source, 'url');
  assert.equal(JSON.parse(fs.readFileSync(path.join(item.folder, 'manifest.json'), 'utf8')).key, key.toString('base64'));
  assert.equal(libraryReport(true, true).library.some((row) => row.id === item.id), true);
  assert.throws(() => addFromCrxFile(file, { publicKey: key, storeUrl: 'https://chromewebstore.google.com/' }), /already installed/);
});

test('unsafe and corrupt archives fail without leaving an installed folder', () => {
  const root = path.join(scratch, 'extensions', 'imported');
  const before = fs.readdirSync(root).sort();
  for (const [index, archive] of [zip('../escape', 'x'), zip('C:/escape', 'x'), zip('manifest.json', '{}')].entries()) {
    if (index === 2) archive[30 + 'manifest.json'.length] = archive[30 + 'manifest.json'.length]! ^ 1;
    const file = path.join(scratch, `bad-${index}.zip`); fs.writeFileSync(file, archive);
    assert.throws(() => addFromCrxFile(file));
    assert.deepEqual(fs.readdirSync(root).sort(), before);
  }
});

test('store downloads reject arbitrary and misleading redirect hosts', async () => {
  assert.equal(isStoreDownloadUrl(new URL('https://clients2.google.com/service/update2/crx')), true);
  assert.equal(isStoreDownloadUrl(new URL('https://clients2.googleusercontent.com/crx/file')), true);
  for (const url of ['https://localhost/file', 'https://127.0.0.1/file', 'https://googleusercontent.com.evil.test/file', 'https://evilgoogleusercontent.com/file', 'http://clients2.google.com/file', 'https://clients2.google.com:8443/file', 'https://x@clients2.google.com/file']) {
    assert.equal(isStoreDownloadUrl(new URL(url)), false, url);
  }
  await assert.rejects(addFromUrl('https://localhost/private.crx'), /official Chrome Web Store/);
});

test('the original included extensions have fixed IDs and safe removal', async () => {
  const { shippedState, removeShipped, profileExtensionFolders } = await import('../src/main/core/library');
  const rows = shippedState();
  assert.deepEqual(rows.map((item) => item.id), ['fklakbbaaknbgcedidhblbnhclijnhbi', 'okaeekdeohehbdanbbohcfhhlblcmjkm']);
  assert.equal(rows.every((item) => !item.present && !item.removed && item.icon), true);
  assert.throws(() => removeShipped('../outside'), /Unknown included extension/);
  removeShipped(rows[0]!.id);
  assert.equal(shippedState()[0]!.removed, true);
  const folders = profileExtensionFolders({ tools: { humanPaste: true, humanPasteSpeed: 'fast', customExtensions: '' } } as never, true, true);
  assert.equal(folders.some((folder) => folder.includes('human-paste')), true);
  assert.equal(folders.some((folder) => folder.endsWith(rows[0]!.id)), false);
});

test('extension manifest labels resolve the publisher default locale', async () => {
  const { addFromFolder } = await import('../src/main/core/library');
  const source = path.join(scratch, 'localized-source');
  fs.mkdirSync(path.join(source, '_locales', 'en'), { recursive: true });
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ name: '__MSG_name__', description: '__MSG_desc__', default_locale: 'en', version: '1', manifest_version: 3 }));
  fs.writeFileSync(path.join(source, '_locales', 'en', 'messages.json'), JSON.stringify({ Name: { message: 'Publisher name' }, desc: { message: 'Publisher description' } }));
  const item = addFromFolder(source);
  assert.equal(item.name, 'Publisher name');
  assert.equal(item.description, 'Publisher description');
});

test('recommended extensions have official listing IDs and valid optional artwork', async () => {
  const { RECOMMENDED_EXTENSIONS } = await import('../src/shared/extensionCatalog');
  assert.ok(RECOMMENDED_EXTENSIONS.length >= 10 && RECOMMENDED_EXTENSIONS.length <= 15);
  assert.ok(RECOMMENDED_EXTENSIONS.some(item => item.name === 'SingleFile' && storeListingId(item.url) === 'mpiodijhokgodhhofbcjdecpffjipkle'));
  assert.ok(RECOMMENDED_EXTENSIONS.some(item => item.name === 'Consent-O-Matic' && storeListingId(item.url) === 'mdjildafknihdffpkfmmpnpoiajfjnjd'));
  assert.ok(RECOMMENDED_EXTENSIONS.some(item => item.name === 'uBlock Origin Lite' && storeListingId(item.url) === 'ddkjiahejlhfcafbddmgiahcphecmpfh'));
  for (const item of RECOMMENDED_EXTENSIONS) {
    assert.ok(storeListingId(item.url), item.name);
    if (item.icon) assert.ok(fs.existsSync(path.join(process.cwd(), 'public', item.icon.replace(/^\.\//, ''))), item.name);
  }
});

test('recommended extensions explain their purpose and Firefox never receives Chromium folders', async () => {
  const { RECOMMENDED_EXTENSIONS } = await import('../src/shared/extensionCatalog');
  const { profileExtensionFolders } = await import('../src/main/core/library');
  assert.ok(RECOMMENDED_EXTENSIONS.some(item => item.name === 'uBlock Origin Lite'));
  for (const item of RECOMMENDED_EXTENSIONS) {
    assert.ok(item.description.length > 15, item.name);
    assert.ok(storeListingId(item.url), item.url);
  }
  const { draftProfile } = await import('../src/main/core/store');
  assert.deepEqual(profileExtensionFolders(draftProfile({ engine: 'firefox' }), true, true), []);
});
