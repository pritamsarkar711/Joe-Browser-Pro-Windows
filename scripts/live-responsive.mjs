/**
 * Checks the interface at the sizes a phone or a tablet actually uses.
 *
 * The window is resized for real, through the same path a person's finger or a window manager
 * would use, and every page is walked at every size. A page that has to scroll sideways, a
 * control that has been clipped, or a window that has drifted into a corner is the thing this
 * is looking for - the kind of fault that only appears on a 360-point-wide screen.
 *
 *   node scripts/live-responsive.mjs [outDir]
 */
import { _electron as electron } from 'playwright-core';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const outDir = process.argv[2] ?? 'C:/temp/joe-responsive';
mkdirSync(outDir, { recursive: true });

/** The screens worth being usable on. */
const SIZES = [
  { name: 'android-360x800', width: 360, height: 800 },
  { name: 'iphone-se-375x667', width: 375, height: 667 },
  { name: 'iphone-14-390x844', width: 390, height: 844 },
  { name: 'iphone-14-max-430x932', width: 430, height: 932 },
  { name: 'ipad-768x1024', width: 768, height: 1024 },
  { name: 'ipad-pro-1024x1366', width: 1024, height: 1366 },
];

const PAGES = [
  ['profiles', 'Profiles'],
  ['history', 'History'],
  ['proxies', 'Proxies'],
  ['extensions', 'Extensions'],
  ['tools', 'Tools'],
  ['browsers', 'Browsers'],
  ['settings', 'Settings'],
  ['about', 'About'],
];

const app = await electron.launch({ args: ['.'], timeout: 60000 });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(3000);

/** The size the window had before the sweep, so the sweep does not become the user's window. */
const original = await app.evaluate(async ({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  return win ? win.getBounds() : null;
});

/** Resizes the real window and waits for the renderer to lay out again. */
async function resize(width, height) {
  const bounds = await app.evaluate(async ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    win.setBounds({ width: size.width, height: size.height });
    return win.getBounds();
  }, { width, height });
  await page.waitForTimeout(700);
  return bounds;
}

/** Everything that leaves the window, or that is cut in half by it. */
async function measure() {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const overflowing = [];
    const clipped = [];

    /** A strip that scrolls on purpose may hold content wider than the window. */
    const inScroller = (el) => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === 'auto' || overflow === 'scroll') return true;
      }
      return false;
    };

    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.position === 'fixed') continue;
      const label = `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').filter(Boolean).slice(0, 2).join('.')}`;
      if ((rect.right > width + 1 || rect.left < -1) && !inScroller(el)) {
        overflowing.push(`${label} ${Math.round(rect.left)}..${Math.round(rect.right)}`);
      }
      // A control whose text is cut mid-word is a fault. One that ends in an ellipsis is not.
      if (
        el instanceof HTMLElement &&
        el.scrollWidth > el.clientWidth + 2 &&
        style.overflowX === 'hidden' &&
        style.textOverflow !== 'ellipsis' &&
        el.clientWidth > 0 &&
        !inScroller(el)
      ) {
        clipped.push(`${label} ${el.scrollWidth}>${el.clientWidth}`);
      }
    }
    return {
      width,
      height,
      scrollWidth: document.documentElement.scrollWidth,
      overflowing: overflowing.slice(0, 6),
      clipped: clipped.slice(0, 6),
      railVisible: Boolean(document.querySelector('.rail')),
      railWidth: document.querySelector('.rail')?.getBoundingClientRect().width ?? 0,
      headerHeight: document.querySelector('.header')?.getBoundingClientRect().height ?? 0,
    };
  });
}

const report = [];
for (const size of SIZES) {
  const bounds = await resize(size.width, size.height);

  for (const [name, label] of PAGES) {
    const item = page.locator('.rail .nav-item', { hasText: label }).first();
    if (!(await item.count())) {
      report.push({ size: size.name, page: name, found: false });
      continue;
    }
    await item.click();
    await page.waitForTimeout(700);
    const measured = await measure();
    const file = path.join(outDir, `${size.name}-${name}.png`);
    await page.screenshot({ path: file });
    const row = { size: size.name, page: name, window: bounds, ...measured, file };
    report.push(row);
    const trouble = measured.overflowing.length || measured.clipped.length || measured.scrollWidth > measured.width + 1;
    console.log(
      `${trouble ? 'BAD ' : 'ok  '} ${size.name} ${name} ${measured.width}x${measured.height}` +
        (measured.overflowing.length ? ` overflow:${JSON.stringify(measured.overflowing)}` : '') +
        (measured.clipped.length ? ` clipped:${JSON.stringify(measured.clipped)}` : '') +
        (measured.scrollWidth > measured.width + 1 ? ` scrollWidth:${measured.scrollWidth}` : ''),
    );
  }
}

console.log('errors:', errors.slice(0, 10));
writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

// Put the window back where it was: the app remembers its size, and a sweep that leaves the
// user with a phone-sized window is a fault of the sweep, not of the app.
if (original) {
  await app.evaluate(async ({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setBounds(size);
  }, original);
  await page.waitForTimeout(500);
}

await app.close();
