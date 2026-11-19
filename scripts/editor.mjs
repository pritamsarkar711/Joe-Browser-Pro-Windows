/**
 * Open the profile editor and capture it at several widths.
 *
 * The editor is the densest surface in the app: a long form with two columns, a fingerprint
 * panel and a toolbar. It is where a fixed-width control overflows.
 */
import { _electron as electron } from 'playwright-core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const root = process.argv[2] ?? 'C:/temp/joe-editor';
const data = await mkdtemp(path.join(tmpdir(), 'joe-editor-'));

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
  await page.waitForTimeout(700);
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
  await page.screenshot({ path: file });
  report.push({ name, width, ...overflow, file });
  console.log(name, width, JSON.stringify(overflow));
}

await page.setViewportSize({ width: 1320, height: 860 });
await page.waitForTimeout(500);

const newProfile = page.locator('button', { hasText: 'New profile' }).first();
if (await newProfile.count()) {
  await newProfile.click({ timeout: 20000 });
  await page.waitForTimeout(1500);
} else {
  console.log('no new-profile button');
}

for (const width of [520, 900, 1320]) {
  await capture('editor', width);
}

// The fingerprint panel is the other half of the editor.
const fp = page.locator('button', { hasText: 'Fingerprint' }).first();
if (await fp.count()) {
  await fp.click();
  await page.waitForTimeout(900);
  for (const width of [560, 1320]) {
    await capture('editor-fingerprint', width);
  }
}

console.log('errors:', errors.slice(0, 10));
writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
await app.close();
