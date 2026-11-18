import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { SessionManager } from '../src/main/core/launcher';
import { createProfile, deleteProfile, findProfileOrThrow, flushStore, invalidateStore, saveSettings, updateProfile } from '../src/main/core/store';
import { execFileSync } from 'node:child_process';
import { Paths } from '../src/main/core/paths';
import { listKernels, downloadKernel, resolveKernelExe } from '../src/main/core/catalog';
import { addFromUrl, ensureShipped, shippedState } from '../src/main/core/library';
import { INCLUDED_EXTENSIONS } from '../src/shared/extensionCatalog';
import { ensureHumanPasteExtension } from '../src/main/core/humanPaste';
import { chromium } from 'playwright-core';

/** Exercise the actual manager with real browser storage on a controlled loopback origin. */
async function verifyProfileLifecycle(): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<title>Joe profile lifecycle</title>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const sessions = new SessionManager();
  async function inspect(id: string, expected: string, write?: string): Promise<void> {
    const info = await sessions.launch(findProfileOrThrow(id), origin);
    assert.equal(info.state, 'running');
    const endpoint = `http://127.0.0.1:${info.debugPort}`;
    let connection: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    try {
      // A process can be running before its DevTools HTTP listener starts. Playwright
      // does not retry connection refusals while discovering the websocket URL.
      const deadline = Date.now() + 30_000;
      let lastError: unknown;
      while (Date.now() < deadline && sessions.isRunning(id)) {
        try {
          const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
          const version = await response.json() as { webSocketDebuggerUrl?: string };
          if (response.ok && version.webSocketDebuggerUrl) {
            connection = await chromium.connectOverCDP(version.webSocketDebuggerUrl, { timeout: 10_000 });
            break;
          }
          lastError = new Error(`No DevTools websocket in HTTP ${response.status} response`);
        } catch (error) { lastError = error; }
        await delay(250);
      }
      if (!connection) {
        throw new Error(`DevTools never became ready for ${info.profileName} (state: ${info.state}, pid: ${info.pid})`, { cause: lastError });
      }
      const context = connection.contexts()[0]!;
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(origin, { timeout: 30_000 });
      assert.equal(await page.title(), 'Joe profile lifecycle');
      const actual = await page.evaluate(() => ({
        cookie: document.cookie,
        storage: localStorage.getItem('joe-smoke') ?? '',
      }));
      assert.deepEqual(actual, { cookie: expected ? `joe-smoke=${expected}` : '', storage: expected });
      if (write) await page.evaluate(value => {
        document.cookie = `joe-smoke=${value}; Max-Age=3600; Path=/`;
        localStorage.setItem('joe-smoke', value);
      }, write);
    } finally {
      try { await sessions.stop(id); }
      finally { await connection?.close(); }
    }
  }
  try {
    saveSettings({ extensionsEnabled: false });
    const first = createProfile({ name: 'Smoke A', engine: 'chrome', startUrl: origin });
    const second = createProfile({ name: 'Smoke B', engine: 'chrome', startUrl: origin });
    console.log('Launching profiles through SessionManager, starting with no managed Chrome installed');
    await inspect(first.id, '', 'alpha');
    await inspect(second.id, '', 'beta');
    updateProfile(first.id, { name: 'Smoke A edited' });
    flushStore();
    invalidateStore();
    assert.equal(findProfileOrThrow(first.id).name, 'Smoke A edited');
    await inspect(first.id, 'alpha');
    await inspect(second.id, 'beta');
    updateProfile(first.id, { freshSession: true });
    await inspect(first.id, '', 'temporary');
    await inspect(first.id, '');
    updateProfile(first.id, { freshSession: false });
    await inspect(first.id, 'alpha');
    deleteProfile(first.id, false);
    assert.throws(() => findProfileOrThrow(first.id), /no longer exists/);
    assert.ok(!fs.existsSync(Paths.profileData(first.id)), 'Deleted profile storage remains on disk');
    await inspect(second.id, 'beta');
    console.log('PASS: managed provisioning, profile isolation, storage persistence, fresh sessions and deletion.');
  } finally {
    try { await sessions.stopAll(); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}

/** Network-dependent vendor integration check, deliberately separate from offline unit tests. */
async function main(): Promise<void> {
  assert.equal(process.platform, 'win32');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joe-live-test-'));
  process.env.JOE_BROWSER_DATA_DIR = root;
  // Windows Chromium's AppContainer needs read and traverse access to the test binaries.
  // The runner's private temporary directory is not guaranteed to grant that by default.
  execFileSync('icacls', [root, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)'], { windowsHide: true });
  try {
    console.log('Installing the two original default extensions');
    await ensureShipped();
    const defaults = shippedState();
    assert.deepEqual(defaults.map((item) => item.id), INCLUDED_EXTENSIONS.map((item) => item.id));
    for (const item of defaults) {
      assert.equal(item.present, true, item.name);
      const manifest = JSON.parse(fs.readFileSync(path.join(Paths.extensions, 'shipped', item.id, 'manifest.json'), 'utf8'));
      assert.ok(manifest.key, 'The verified publisher key was not preserved');
    }
    console.log('Installing a signed Chrome Web Store package');
    const url = 'https://chromewebstore.google.com/detail/singlefile/mpiodijhokgodhhofbcjdecpffjipkle';
    const extension = await addFromUrl(url);
    assert.equal(extension.item?.storeId, 'mpiodijhokgodhhofbcjdecpffjipkle');
    assert.ok(fs.existsSync(path.join(extension.item!.folder, 'manifest.json')));
    await verifyProfileLifecycle();
    const builds = await listKernels();
    const build = builds.find((entry) => entry.engine === 'chrome' && entry.installed && entry.channel.toLowerCase() === 'stable');
    assert.ok(build, 'The profile launcher did not provision stable Chrome');
    const executable = resolveKernelExe(build.id);
    assert.ok(executable && executable.startsWith(Paths.kernels + path.sep));
    console.log('Downloading and launching a verified app-managed Brave build');
    const brave = builds.find((entry) => entry.engine === 'brave' && entry.channel === 'stable');
    assert.ok(brave?.sha256 && brave.runtimeVersion, 'No verified Brave stable build was found');
    const braveInstall = await downloadKernel(brave, () => {});
    assert.equal(braveInstall.runtimeVersion, brave.runtimeVersion);
    const braveExe = resolveKernelExe(braveInstall.id);
    assert.ok(braveExe && path.basename(braveExe).toLowerCase() === 'brave.exe');
    const braveContext = await chromium.launchPersistentContext(path.join(root, 'brave-profile'), {
      executablePath: braveExe, headless: true, timeout: 45_000,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    try {
      const page = braveContext.pages()[0] ?? await braveContext.newPage();
      await page.goto('data:text/html,<title>Brave smoke</title>');
      assert.equal(await page.title(), 'Brave smoke');
    } finally { await braveContext.close(); }
    console.log('Checking Paste as Human extension loads in the managed browser');
    const paste = ensureHumanPasteExtension('instant');
    const browser = await chromium.launchPersistentContext(path.join(root, 'extension-profile'), {
      executablePath: executable, headless: true,
      args: [`--disable-extensions-except=${paste}`, `--load-extension=${paste}`],
      timeout: 90_000,
    });
    try {
      const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 30_000 });
      assert.match(worker.url(), /^chrome-extension:\/\//);
      assert.equal(await worker.evaluate(() => typeof chrome.contextMenus), 'object');
    } finally { await browser.close(); }

    console.log('PASS: authenticated store install, Chrome and Brave download, extraction, and headless launch.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
