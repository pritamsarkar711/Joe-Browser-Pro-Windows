/**
 * Walk the pages at several widths and capture each one.
 *
 * The empty workspace is one layout; the settings pane, the browsers list and the profile editor
 * are the dense ones, and they are where a fixed column or a wide table overflows.
 */
import { _electron as electron } from 'playwright-core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const root = process.argv[2] ?? 'C:/temp/joe-pages';
const data = await mkdtemp(path.join(tmpdir(), 'joe-pages-'));

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, JOE_BROWSER_DATA_DIR: data },
  timeout: 60000,
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(2500);

const report = [];

async function capture(name, width, height = 860) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate((w) => {
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > w + 1 || rect.left < -1) {
        bad.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').filter(Boolean).join('.')} right=${Math.round(rect.right)} left=${Math.round(rect.left)}`);
      }
    }
    return { bad: bad.slice(0, 10), scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  }, width);
  const file = path.join(root, `${name}-${width}.png`);
  await page.screenshot({ path: file, fullPage: false });
  report.push({ name, width, ...overflow, file });
  console.log(name, width, JSON.stringify(overflow));
}

/** Navigate by the rail's label text; the title attribute only exists in the collapsed rail. */
async function openRail(label) {
  const target = page.locator('.rail .nav-item', { hasText: label }).first();
  if (await target.count()) {
    await target.click();
    await page.waitForTimeout(800);
    return true;
  }
  return false;
}

for (const width of [520, 900, 1320]) {
  await capture(`profiles`, width);
}

// The rail is icon-only below 980px, so the page is opened through the rail's expanded state.
await page.setViewportSize({ width: 1320, height: 860 });
await page.waitForTimeout(400);

for (const [name, label] of [['settings', 'Settings'], ['browsers', 'Browsers'], ['proxies', 'Proxies'], ['extensions', 'Extensions'], ['tools', 'Tools']]) {
  const ok = await openRail(label);
  if (!ok) {
    console.log('nav miss', label);
    continue;
  }
  await capture(name, 1320);
  await capture(name, 560);
}

console.log('errors:', errors.slice(0, 10));
writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
await app.close();
