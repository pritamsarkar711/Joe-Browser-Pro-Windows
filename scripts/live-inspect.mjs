/**
 * Captures the application the way a person sees it.
 *
 * The other scripts look at layout in isolation. This one opens the real data folder, waits for
 * the browser catalogue to arrive, and walks every page, because the pages that look wrong are
 * usually the ones that depend on something that has not finished loading: a build list, an
 * account, a profile.
 *
 *   node scripts/live-inspect.mjs [dataDir] [outDir]
 */
import { _electron as electron } from 'playwright-core';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const dataDir = process.argv[2] ?? '';
const outDir = process.argv[3] ?? 'C:/temp/joe-live';
mkdirSync(outDir, { recursive: true });

const env = { ...process.env };
if (dataDir) env.JOE_BROWSER_DATA_DIR = dataDir;

const app = await electron.launch({ args: ['.'], env, timeout: 60000 });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(4000);

/** The window has to be on screen for the capture to mean anything. */
const windowState = await app.evaluate(async ({ BrowserWindow, screen }) => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) return null;
  const bounds = w.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  return {
    visible: w.isVisible(),
    bounds,
    workArea: area,
    // How far the window is from the middle of the screen it is on, in points.
    offCentre: {
      x: Math.round(bounds.x + bounds.width / 2 - (area.x + area.width / 2)),
      y: Math.round(bounds.y + bounds.height / 2 - (area.y + area.height / 2)),
    },
  };
});
console.log('window:', JSON.stringify(windowState));

const pages = [
  ['profiles', 'Profiles'],
  ['history', 'History'],
  ['proxies', 'Proxies'],
  ['extensions', 'Extensions'],
  ['tools', 'Tools'],
  ['browsers', 'Browsers'],
  ['settings', 'Settings'],
  ['about', 'About'],
];

const report = [];
for (const [name, label] of pages) {
  const item = page.locator('.rail .nav-item', { hasText: label }).first();
  if (!(await item.count())) {
    report.push({ name, found: false });
    continue;
  }
  await item.click();
  // The catalogue and the account are fetched, not bundled: a page captured before they arrive
  // shows a spinner where the content should be.
  await page.waitForTimeout(3500);
  const overflow = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > window.innerWidth + 1 || rect.left < -1) {
        bad.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').filter(Boolean).join('.')}`);
      }
    }
    return { bad: bad.slice(0, 8), scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  });
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  report.push({ name, found: true, ...overflow, file });
  console.log(name, JSON.stringify(overflow));
}

console.log('errors:', errors.slice(0, 10));
writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
await app.close();
