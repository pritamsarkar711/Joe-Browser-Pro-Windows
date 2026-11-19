import { chromium } from 'playwright-core';

/**
 * What an unmodified Chrome reports, so the spoofed values can be compared against it.
 *
 * A test harness, not part of the application: it reads the baseline of the Chromium installed
 * on this machine. The app itself never touches an installed browser.
 */

const CHROME =
  process.env.JOE_TEST_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = await browser.newPage();
await page.goto('about:blank');
const out = await page.evaluate(() => {
  const fonts = [];
  for (const f of document.fonts) fonts.push(f.family);
  const gl = document.createElement('canvas').getContext('webgl');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    fonts,
    fontSize: document.fonts.size,
    checkArial: document.fonts.check('12px Arial'),
    checkCalibri: document.fonts.check('12px Calibri'),
    checkBogus: document.fonts.check('12px NotARealFontFamily'),
    checkQuoted: document.fonts.check('12px "Courier New"'),
    checkBold: document.fonts.check('bold 12px Arial'),
    vendor: gl.getParameter(gl.VENDOR),
    renderer: gl.getParameter(gl.RENDERER),
    unmaskedVendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
    unmaskedRenderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL),
    webdriver: navigator.webdriver,
    ua: navigator.userAgent,
    platform: navigator.platform,
  };
});
await browser.close();
console.log(JSON.stringify(out, null, 2));
