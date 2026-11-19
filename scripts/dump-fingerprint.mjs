import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Writes the injected fingerprint script to a file so it can be read and syntax-checked. */

const entry = join(tmpdir(), 'joe-fp-dump.ts');
const out = join(tmpdir(), 'joe-fp-dump.mjs');

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
export const script = buildFingerprintScript({
  fingerprint: generateFingerprint({ seed: 101 }),
  engine: 'chromium',
  browserVersion: '132.0.0.0',
  tools,
  countryCode: 'US',
});
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

const { script } = await import(`file://${out.replace(/\\/g, '/')}`);
writeFileSync('scripts/fingerprint-script.js', script);
console.log('written', script.length, 'chars');
