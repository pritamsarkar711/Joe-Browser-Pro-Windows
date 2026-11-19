/**
 * Open the packaged renderer in a real Electron window at several widths and capture it.
 *
 * The screenshots are the point: a layout that overflows is visible in one and not in the other,
 * and no assertion about a CSS rule proves that as well as a picture does.
 */
import { _electron as electron } from 'playwright-core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const root = process.argv[2] ?? 'C:/temp/joe-shots';
const data = await mkdtemp(path.join(tmpdir(), 'joe-viewport-'));

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

const widths = [480, 700, 900, 1320];
const report = [];

for (const width of widths) {
  await page.setViewportSize({ width, height: 800 });
  await page.waitForTimeout(700);

  // Every element that sticks out past the window is a layout bug waiting to be clipped.
  const overflow = await page.evaluate((w) => {
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > w + 1 || rect.left < -1) {
        bad.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').filter(Boolean).join('.')} right=${Math.round(rect.right)} left=${Math.round(rect.left)}`);
      }
    }
    return {
      bad: bad.slice(0, 12),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  }, width);

  const file = path.join(root, `width-${width}.png`);
  await page.screenshot({ path: file });
  report.push({ width, ...overflow, file });
  console.log(width, JSON.stringify(overflow));
}

console.log('errors:', errors.slice(0, 10));
writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
await app.close();
