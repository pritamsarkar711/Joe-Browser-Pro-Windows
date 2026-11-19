import { _electron as electron } from 'playwright-core';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

/** Test the packaged installer and account gate without bypassing authentication. */

if (process.platform !== 'win32') throw new Error('Run this packaged installer test on Windows.');
const root = await mkdtemp(path.join(tmpdir(), 'joe-installer-test-'));
const destination = path.join(root, 'Custom install folder');
const data = path.join(root, 'workspace');
const executablePath = path.join(destination, 'Joe Browser.exe');
let app;
const errors = [];

/**
 * NSIS needs its `/D=` argument last and unquoted, and Node quotes arguments containing spaces.
 * A generated command file is the only way to keep both the custom folder (with a space) and the
 * exact command line NSIS expects.
 */
function runCommandFile(name, command) {
  const file = path.join(root, name);
  writeFileSync(file, `@echo off\r\n${command}\r\nexit /b %ERRORLEVEL%\r\n`, 'utf8');
  // Node refuses to spawn a .cmd directly; cmd.exe is the interpreter it is meant for.
  execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', file], { timeout: 180000, stdio: 'inherit' });
}
async function launch() {
  app = await electron.launch({ executablePath, env: { ...process.env, JOE_BROWSER_DATA_DIR: data }, timeout: 60000 });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  return page;
}
async function accountGate(page) {
  await page.locator('.gate input[type=email]').waitFor();
  assert.equal(await page.locator('.gate-skip').count(), 0, 'Account sign-in must be required');
  assert.equal(await page.locator('.recovery').count(), 0, `Renderer recovery: ${await page.locator('body').innerText()}; errors: ${errors.join(' | ')}`);
}

try {
  console.log('Installing to', destination);
  // A per-user install is what the product offers by default; running this test as an
  // administrator would hide failures that only happen without elevation. This NSIS build
  // accepts a quoted /D value and needs it to keep a folder name with spaces intact.
  runCommandFile('install.cmd', `"${path.resolve('release/JoeBrowserSetup.exe')}" /S /currentuser /D="${destination}"`);
  await access(executablePath);
  console.log('Launching installed application');
  let page = await launch();
  await accountGate(page);
  // Legacy local-mode choice must not bypass the account gate after upgrading.
  await page.evaluate(() => localStorage.setItem('joe-local-mode', '1'));
  await app.close(); app = null;
  page = await launch();
  await accountGate(page);
  // After the real gate checks, use an isolated cloud stub solely to inspect the workspace UI.
  // This does not replace the gate test above or exercise live Supabase authentication.
  await page.addInitScript(() => {
    globalThis.__joeCloud = {
      currentUser: async () => ({ id: 'ui-test', email: 'ui-test@example.test' }),
      myEntitlement: async () => ({ expiresAt: null, serverTime: new Date().toISOString(), isAdmin: false, isBlocked: false, plan: null, source: 'server' }),
      signOut: async () => {},
    };
  });
  await page.reload();
  await page.locator('.shell .nav-item').first().waitFor();
  for (let i = 0; i < 8; i++) {
    await page.locator('.nav-item').nth(i).click();
    for (let n = 0; n < 2; n++) {
      const frames = await page.evaluate(async () => {
        const button = document.querySelector('.theme-toggle');
        const shell = document.querySelector('.shell');
        const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
        button.click();
        const result = [];
        for (let j = 0; j < 4; j++) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          result.push({ mode: document.documentElement.dataset.theme, background: getComputedStyle(document.body).backgroundColor,
            html: getComputedStyle(document.documentElement).backgroundColor, shell: shell.isConnected && !!document.querySelector('.shell'), next });
        }
        return result;
      });
      for (const frame of frames) {
        const expected = frame.next === 'light' ? 'rgb(246, 247, 250)' : 'rgb(14, 16, 20)';
        assert.equal(frame.mode, frame.next, `Theme reverted on page ${i}`);
        assert.equal(frame.background, expected, `Incorrect body background on page ${i}`);
        assert.equal(frame.html, expected, `Incorrect root background on page ${i}`);
        assert.equal(frame.shell, true, `Workspace disappeared on page ${i}`);
      }
    }
  }
  // Check the packaged font and the profile editor at desktop and narrow widths.
  await page.evaluate(() => document.fonts.ready);
  assert.match(await page.evaluate(() => getComputedStyle(document.body).fontFamily), /IBM Plex Sans/);
  assert.equal(await page.evaluate(() => document.fonts.check('400 14px "IBM Plex Sans"')), true);
  await page.locator('.nav-item').first().click();
  await page.locator('.header').getByRole('button', { name: 'New profile' }).click();
  const editor = page.getByRole('dialog', { name: 'New profile' });
  await editor.waitFor();
  await editor.locator('input[value="https://browsercan.net?utm_source=chatgpt.com"]').waitFor();
  assert.equal(await editor.getByText('Group / folder', { exact: true }).count(), 0);
  assert.equal(await editor.getByText('Tags', { exact: true }).count(), 0);
  for (const width of [1100, 520]) {
    await page.setViewportSize({ width, height: 760 });
    for (const tab of ['General', 'Fingerprint', 'Privacy', 'Proxy', 'Tools']) {
      await editor.getByRole('tab', { name: tab, exact: true }).click();
      const overflow = await editor.evaluate(el => {
        const body = el.querySelector('.modal-body');
        return el.scrollWidth > el.clientWidth + 1 || body.scrollWidth > body.clientWidth + 1;
      });
      assert.equal(overflow, false, `${tab} editor overflows at ${width}`);
    }
  }
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.nav-item').nth(6).click();
  for (const width of [1100, 520]) {
    await page.setViewportSize({ width, height: 760 });
    await page.locator('.lang').first().waitFor();
    const layout = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.lang')].map(el => el.getBoundingClientRect());
      const content = document.querySelector('.settings-groups').getBoundingClientRect();
      const overlap = items.some((a, i) => items.slice(i + 1).some(b => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1));
      return { overlap, fits: content.left >= 0 && content.right <= window.innerWidth + 1, percentages: [...document.querySelectorAll('.lang')].some(el => /\d+%/.test(el.textContent)) };
    });
    assert.equal(layout.overlap, false, `Language cards overlap at ${width}`);
    assert.equal(layout.fits, true, `Settings content overflows at ${width}`);
    assert.equal(layout.percentages, false, 'Language coverage percentages remain visible');
  }
  assert.deepEqual(errors, []);
  await app.close(); app = null;
  const uninstaller = path.join(destination, 'Uninstall Joe Browser.exe');
  await access(uninstaller);
  // _?= runs the uninstaller in place so the process waits for uninstall to finish, and it has
  // the same last-argument and no-quotes requirement as /D.
  runCommandFile('uninstall.cmd', `"${uninstaller}" /S _?=${destination}`);
  // Uninstall must preserve user data.
  await access(data);
  await access(path.join(data, 'profiles'));
  console.log('PASS: install, account gate, theme frames, settings layout, and uninstall.');
} catch (error) {
  const detail = String(error?.stack || error).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::error title=Windows installed smoke test::${detail}`);
  throw error;
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
}
