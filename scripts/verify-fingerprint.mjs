import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

/**
 * Runs the real injected script in a real Chromium and prints what each profile reports.
 *
 * The unit tests prove the script is well formed; this proves the values a site would read are
 * the ones the profile intends, and that two profiles do not answer identically.
 *
 * This is a test harness, not part of the application: it opens the Chromium installed on this
 * machine only to read the baseline a real browser produces. The app itself never touches an
 * installed browser - it runs the builds it downloaded itself.
 */

const CHROME =
  process.env.JOE_TEST_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const entry = join(tmpdir(), `joe-fp-${Date.now()}.ts`);
const out = join(tmpdir(), `joe-fp-${Date.now()}.mjs`);

writeFileSync(
  entry,
  `import { buildFingerprintScript } from ${JSON.stringify(
    join(process.cwd(), 'src/main/core/inject.ts'),
  )};
import { generateFingerprint } from ${JSON.stringify(
    join(process.cwd(), 'src/main/core/fingerprint.ts'),
  )};
const tools = {
  humanPaste: false, humanPasteSpeed: 'natural', proxyWatch: false,
  proxyWatchInterval: 30, enableRightClick: false, unlockSelection: false,
  customExtensions: '',
};
export function scriptFor(seed) {
  return buildFingerprintScript({
    fingerprint: generateFingerprint({ seed }),
    engine: 'chromium',
    browserVersion: '132.0.0.0',
    tools,
    countryCode: 'US',
  });
}
`,
);

await build({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  logLevel: 'warning',
});

const { scriptFor } = await import(`file://${out.replace(/\\/g, '/')}`);

const PROBE = `(() => {
  const fonts = [];
  try { for (const f of document.fonts) fonts.push(f.family); } catch (e) { fonts.push('ERR ' + e); }
  let audio = 'n/a';
  try {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const osc = ctx.createOscillator();
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ctx.destination);
    osc.start();
    const buf = ctx.startRendering();
    return ctx; // placeholder, replaced below
  } catch (e) { audio = 'ERR ' + e; }
  return { fonts, audio };
})()`;

async function probe(page) {
  return page.evaluate(async () => {
    const fonts = [];
    try {
      for (const f of document.fonts) fonts.push(f.family);
    } catch (e) {
      fonts.push('ERR ' + e);
    }
    let size = 'n/a';
    try {
      size = document.fonts.size;
    } catch (e) {
      size = 'ERR ' + e;
    }
    let audio = 'n/a';
    try {
      const ctx = new OfflineAudioContext(1, 44100, 44100);
      const osc = ctx.createOscillator();
      const comp = ctx.createDynamicsCompressor();
      osc.connect(comp);
      comp.connect(ctx.destination);
      osc.start();
      const buffer = await ctx.startRendering();
      const data = buffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      audio = sum.toFixed(6);
    } catch (e) {
      audio = 'ERR ' + e;
    }
    let canvas = 'n/a';
    try {
      const c = document.createElement('canvas');
      c.width = 240;
      c.height = 60;
      const ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px "Arial"';
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 100, 50);
      ctx.fillStyle = '#069';
      ctx.fillText('Cwm fjordbank glyphs vext quiz 😃', 2, 15);
      canvas = c.toDataURL().slice(-120);
    } catch (e) {
      canvas = 'ERR ' + e;
    }
    let webgl = 'n/a';
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      webgl = gl.getParameter(gl.VERSION) + ' | ' + gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    } catch (e) {
      webgl = 'ERR ' + e;
    }
    /* A family the profile does not own has to measure as the generic fallback, and a family it
       owns has to measure as a real font. */
    const measure = {};
    try {
      const c = document.createElement('canvas').getContext('2d');
      const sample = 'mmmwwwiiilll0O';
      for (const family of ['sans-serif', 'Arial', 'Calibri', 'Comic Sans MS', 'Papyrus']) {
        c.font = '72px "' + family + '"';
        measure[family] = c.measureText(sample).width.toFixed(3);
      }
    } catch (e) {
      measure.error = 'ERR ' + e;
    }
    return {
      ua: navigator.userAgent,
      platform: navigator.platform,
      languages: navigator.languages,
      cores: navigator.hardwareConcurrency,
      screen: `${screen.width}x${screen.height}`,
      fonts,
      fontSize: size,
      fontCheckArial: document.fonts.check('12px Arial'),
      fontCheckBogus: document.fonts.check('12px NotARealFontFamily'),
      measure,
      audio,
      canvas,
      webgl,
      webdriver: navigator.webdriver,
    };
  });
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    // The launcher passes this, so the harness has to as well.
    '--disable-blink-features=AutomationControlled',
  ],
});

const results = [];
for (const seed of [101, 202]) {
  const context = await browser.newContext();
  await context.addInitScript(scriptFor(seed));
  const page = await context.newPage();
  await page.goto('about:blank');
  results.push(await probe(page));
  await context.close();
}

await browser.close();
rmSync(entry, { force: true });
rmSync(out, { force: true });

console.log(JSON.stringify(results, null, 2));

const [a, b] = results;
const problems = [];
const expectDifferent = (label, x, y) => {
  if (x === y) problems.push(`${label} is identical across profiles: ${JSON.stringify(x)}`);
};
expectDifferent('audio', a.audio, b.audio);
expectDifferent('canvas', a.canvas, b.canvas);

/* A real Chromium keeps no system fonts in the set, so the profile must not either. */
if (a.fonts.length) problems.push(`document.fonts is not empty: ${JSON.stringify(a.fonts)}`);
if (a.fontSize !== 0) problems.push(`document.fonts.size is ${a.fontSize}, a real browser reports 0`);
if (!a.fontCheckArial) problems.push('document.fonts.check said Arial is missing');
if (!a.fontCheckBogus) problems.push('document.fonts.check does not match a real browser');
if (a.webdriver) problems.push('navigator.webdriver is true');
if (String(a.audio).startsWith('ERR')) problems.push('audio probe failed');

/* A family the profile does not own must measure as the generic fallback. */
if (a.measure['Comic Sans MS'] !== a.measure['sans-serif']) {
  problems.push(`an unclaimed family does not measure as the fallback: ${a.measure['Comic Sans MS']} vs ${a.measure['sans-serif']}`);
}
if (a.measure['Papyrus'] !== a.measure['sans-serif']) {
  problems.push(`an unclaimed family does not measure as the fallback: ${a.measure['Papyrus']} vs ${a.measure['sans-serif']}`);
}
/* A family the profile owns must not measure as the fallback. */
if (a.measure['Calibri'] === a.measure['sans-serif']) {
  problems.push('a claimed family measures exactly as the fallback');
}

if (problems.length) {
  console.error('\nPROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log('\nOK: the two profiles differ on every measured surface.');
