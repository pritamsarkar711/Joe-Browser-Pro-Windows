import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeResolver } from '../src/main/core/runtime';
import { joeBuildsFromChromium } from '../src/main/core/catalog';
import type { InstalledKernel, KernelBuild, Profile } from '../src/shared/types';

const stable: KernelBuild = { id: 'chrome-150-stable', engine: 'chrome', version: '150.0.0.0', channel: 'Stable', os: 'win64', downloadUrl: 'https://vendor.test/browser.zip', installed: false, path: '', sizeBytes: 0 };
const profile = { engine: 'chrome', kernelId: '' } as Profile;
const local = (build: KernelBuild): InstalledKernel => ({ ...build, exePath: '/managed/chrome.exe', installedAt: '' });

test('Joe derives its runtime from actual Chrome for Testing stable metadata', () => {
  const rows = joeBuildsFromChromium([stable, { ...stable, id: 'chrome-beta', channel: 'Beta' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.engine, 'joe');
  assert.equal(rows[0]!.id, 'joe-150-stable');
  assert.equal(rows[0]!.downloadUrl, stable.downloadUrl);
});

test('fresh profile provisions stable once across concurrent launches and reuses it offline', async () => {
  const installed: InstalledKernel[] = [];
  let calls = 0;
  let catalogs = 0;
  const resolve = createRuntimeResolver({
    installed: () => installed,
    executable: () => installed.length ? '/managed/chrome.exe' : null,
    catalog: async () => { catalogs++; return [stable, { ...stable, id: 'canary', channel: 'Canary', version: '999' }]; },
    install: async build => { calls++; await new Promise(r => setTimeout(r, 10)); const item = local(build); installed.push(item); return item; },
  });
  const [a, b] = await Promise.all([resolve(profile), resolve(profile)]);
  assert.equal(a.version, stable.version);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  const before = catalogs;
  await resolve(profile);
  assert.equal(catalogs, before, 'installed profiles must work without a catalog request');
});

test('pinned profiles never silently change versions and unsupported engines fail explicitly', async () => {
  const resolve = createRuntimeResolver({ installed: () => [], executable: () => null,
    catalog: async () => [stable], install: async () => { throw new Error('must not install'); } });
  await assert.rejects(resolve({ ...profile, kernelId: 'missing' }), /pinned build/);
  await assert.rejects(resolve({ ...profile, engine: 'edge' }), /No downloadable edge/);
});

test('a failed runtime download can be retried', async () => {
  let calls = 0;
  const resolve = createRuntimeResolver({ installed: () => [], executable: () => '/managed/chrome.exe',
    catalog: async () => [stable], install: async build => { if (++calls === 1) throw new Error('offline'); return local(build); } });
  await assert.rejects(resolve(profile), /offline/);
  assert.equal((await resolve(profile)).engine, 'chrome');
  assert.equal(calls, 2);
});
