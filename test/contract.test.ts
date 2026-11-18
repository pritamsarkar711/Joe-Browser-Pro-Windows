import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { runInNewContext } from 'node:vm';

/**
 * Contract tests over the source tree itself.
 *
 * Every one of these guards a failure that TypeScript cannot catch and that a user would meet as
 * a dead control rather than an error:
 *
 *  - a bridge method with no preload entry throws "is not a function" in the packaged app;
 *  - a channel the preload invokes with no main-process handler hangs forever on an unhandled
 *    promise, and the button that called it spins;
 *  - a translation key used by a page but absent from the English table renders the key itself;
 *  - a `window.prompt`/`confirm`/`alert` silently does nothing in Electron, because the packaged
 *    renderer has no browser chrome to show one.
 *
 * They read the repository as text on purpose. A test that imported these modules would need
 * Electron, and the point is to check the wiring, which only exists as source.
 */

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

const preload = read('src/preload/index.ts');
const types = read('src/shared/types.ts');
const ipc = read('src/main/ipc.ts');
const mainIndex = read('src/main/index.ts');
const main = ipc + '\n' + mainIndex;

/** The method names declared on the Bridge interface. */
function bridgeMethods(): string[] {
  const start = types.indexOf('export interface Bridge {');
  const end = types.indexOf('\n}', start);
  const block = types.slice(start, end);
  return [...block.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*\(/gm)].map((match) => match[1]!);
}

/** Every channel the preload invokes. */
function invokedChannels(): string[] {
  return [...new Set([...preload.matchAll(/invoke\('([a-zA-Z0-9:_-]+)'/g)].map((m) => m[1]!))];
}

/**
 * Every channel the main process handles.
 *
 * Two shapes have to be matched, and both cost a false alarm before they were:
 *
 *  - `handle<T>(\n  'channel'` — the generic and the channel on different lines;
 *  - `handle<{ made: number }>('channel'` — a generic containing its own braces and colons, which
 *    a `[^>]*` body cannot span.
 *
 * So the generic is skipped by balanced-bracket scan rather than by regex.
 */
function handledChannels(): Set<string> {
  const found = new Set<string>();
  const marker = /handle\s*/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(main)) !== null) {
    let index = match.index + match[0].length;
    if (main[index] === '<') {
      // Walk to the matching '>', counting nested angle brackets.
      let depth = 0;
      for (; index < main.length; index++) {
        const char = main[index];
        if (char === '<') depth++;
        else if (char === '>') {
          depth--;
          if (depth === 0) {
            index++;
            break;
          }
        }
      }
    }
    // After the generic comes the opening paren, then the channel: `handle<AppInfo>('app:info'`.
    const channel = /^\(\s*'([a-zA-Z0-9:_-]+)'/.exec(main.slice(index));
    if (channel) found.add(channel[1]!);
  }
  return found;
}

test('every bridge method has a preload implementation', () => {
  // `on` is the event subscription, declared as a method rather than an arrow property because
  // it takes two arguments and returns an unsubscribe function. Every other member is a
  // `name: (...) => invoke(...)` property.
  const missing = bridgeMethods().filter((method) => {
    if (method === 'on') return !/^\s{2}on\(/m.test(preload);
    return !new RegExp(`\\b${method}\\s*:`, 'm').test(preload);
  });
  assert.deepEqual(missing, [], `bridge methods with no preload entry: ${missing.join(', ')}`);
});

test('every channel the preload invokes has a main-process handler', () => {
  const handled = handledChannels();
  const dangling = invokedChannels().filter((channel) => !handled.has(channel));
  assert.deepEqual(dangling, [], `channels with no handler: ${dangling.join(', ')}`);
});

test('the mock bridge implements every bridge method', () => {
  const mock = read('src/renderer/bridge.ts');
  const missing = bridgeMethods().filter(
    (method) => !new RegExp(`^\\s*(?:async\\s+)?${method}\\s*\\(`, 'm').test(mock),
  );
  assert.deepEqual(missing, [], `mock bridge is missing: ${missing.join(', ')}`);
});

test('every translation key a page uses exists in English', () => {
  const i18n = read('src/shared/i18n.ts');
  const start = i18n.indexOf('const EN: Table = {');
  const end = i18n.indexOf('\n};', start);
  const english = new Set(
    [...i18n.slice(start, end).matchAll(/^\s{2}'([^']+)':/gm)].map((m) => m[1]!),
  );

  const rendererFiles = fs
    .readdirSync(path.join(root, 'src/renderer'), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.tsx') || name.endsWith('.ts'));

  const missing: string[] = [];
  for (const file of rendererFiles) {
    const source = read(path.join('src/renderer', file));
    // Only literal keys. A template key such as `sort.${id}` is resolved from a known set and
    // is checked by the page tests instead.
    for (const match of source.matchAll(/\bt\('([a-zA-Z][a-zA-Z0-9._-]*)'/g)) {
      const key = match[1]!;
      if (!english.has(key) && !missing.includes(key)) missing.push(key);
    }
  }
  assert.deepEqual(missing.sort(), [], `keys used but not defined: ${missing.join(', ')}`);
});

test('no renderer code calls a browser dialog that Electron does not implement', () => {
  const rendererFiles = fs
    .readdirSync(path.join(root, 'src/renderer'), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.tsx') || name.endsWith('.ts'));

  const offenders: string[] = [];
  for (const file of rendererFiles) {
    const source = read(path.join('src/renderer', file));
    // `window.prompt` and friends are undefined in a packaged renderer: the call throws or the
    // dialog never appears, and a rename silently does nothing.
    if (/\bwindow\.(prompt|confirm|alert)\s*\(/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `dialogs that do not exist in Electron: ${offenders.join(', ')}`);
});

test('every language table ends with a closing brace', () => {
  const i18n = read('src/shared/i18n.ts');
  const tables = [...i18n.matchAll(/const ([A-Z]{2}): Table = \{/g)].map((m) => m[1]!);
  // A regex edit once swallowed the closing brace on every table and TypeScript still compiled
  // the file, because the tables that followed absorbed the bodies. This catches it.
  assert.ok(tables.length >= 15, `expected 15 language tables, found ${tables.length}`);
  for (const code of tables) {
    const start = i18n.indexOf(`const ${code}: Table = {`);
    const end = i18n.indexOf('\n};', start);
    assert.ok(end > start, `table ${code} has no closing brace`);
    const body = i18n.slice(start, end);
    assert.ok(body.length > 50, `table ${code} looks empty`);
  }
});

test('the entry points the packaged app loads are the ones the build produces', () => {
  /*
   * This inspects build output, so it needs a build to have run. It used to assume one had -
   * which passed locally on a working tree that still had a `dist/` folder and failed on CI,
   * where `npm test` runs before `npm run build`. A test that depends on a leftover artifact is
   * a test that reports on the machine, not on the code.
   *
   * CI orders build before test so this really checks the output. When it runs on a clean tree,
   * building here is the honest alternative to skipping: skipping would turn the strongest
   * packaging check in the suite into a green tick that proves nothing.
   */
  const pkg = JSON.parse(read('package.json')) as { main: string; version: string };

  if (!fs.existsSync(path.join(root, 'dist/renderer/index.html'))) {
    // A clean checkout has no dist. Build it rather than skip: the whole point of this test is to
    // prove the thing that gets packaged is wired correctly, and a skipped version proves nothing.
    const { execFileSync } = childProcess;
    execFileSync('npm', ['run', 'build'], {
      cwd: root,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
  }

  // `main` is what Electron starts. If it is wrong the app shows a blank window and nothing else.
  assert.ok(fs.existsSync(path.join(root, pkg.main)), `package.json main does not exist: ${pkg.main}`);

  // The preload is referenced by an absolute path inside the asar. A typo there removes the
  // whole bridge and every button in the window goes dead.
  assert.ok(
    fs.existsSync(path.join(root, 'dist/preload/index.js')),
    'dist/preload/index.js is not in the build output',
  );

  // The window loads this file in a packaged app; in dev it loads the Vite server instead.
  assert.ok(
    fs.existsSync(path.join(root, 'dist/renderer/index.html')),
    'dist/renderer/index.html is not in the build output',
  );

  // The renderer HTML must reference the hashed bundle that was actually emitted, not a stale one.
  const html = read('dist/renderer/index.html');
  for (const match of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
    const asset = match[1]!;
    assert.ok(
      fs.existsSync(path.join(root, 'dist/renderer', asset)),
      `index.html references a file that was not emitted: ${asset}`,
    );
  }

  // A version of 0.0.0 or an empty string becomes the installer's name and the release tag.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `version is not semver: ${pkg.version}`);
  assert.notEqual(pkg.version, '0.0.0');

  // The packaging config must not name a directory that does not exist: `asarUnpack` over a
  // missing path is accepted by electron-builder and silently unpacks nothing.
  const builder = read('electron-builder.yml');
  for (const match of builder.matchAll(/^\s*-\s+([A-Za-z0-9_.*-]+\/\*\*?\/\*)\s*$/gm)) {
    const glob = match[1]!;
    const dir = glob.split('/')[0]!;
    assert.ok(
      fs.existsSync(path.join(root, dir)) || dir === 'dist',
      `electron-builder.yml references a directory that does not exist: ${dir}`,
    );
  }
});

test('the release workflow builds what it says it publishes', () => {
  const workflow = read('.github/workflows/release.yml');

  // The three gates must run before the artifact is built, or a broken commit can be released.
  const typecheck = workflow.indexOf('npm run typecheck');
  const tests = workflow.indexOf('npm test');
  const build = workflow.indexOf('npm run build');
  const packaging = workflow.indexOf('electron-builder');
  for (const [name, index] of [
    ['typecheck', typecheck],
    ['test', tests],
    ['build', build],
    ['packaging', packaging],
  ] as const) {
    assert.ok(index > 0, `the release workflow does not run ${name}`);
  }
  assert.ok(typecheck < packaging, 'typecheck runs after packaging');
  assert.ok(tests < packaging, 'tests run after packaging');
  assert.ok(build < packaging, 'the build runs after packaging');

  // The build has to come before the tests, not after. The contract tests inspect build output,
  // so the other order asks them about a directory that does not exist yet - which is exactly the
  // failure that broke the first release run on Windows and not on Linux, where a stale `dist/`
  // from an earlier session made the same suite pass.
  assert.ok(build < tests, 'the build runs after the tests');

  /*
   * The live workflow still hard-codes `v2.0.0`. It cannot be edited from here: the GitHub App
   * that pushes this repository has `contents: write` but not the separate `workflows`
   * permission, so a push touching .github/workflows/ is refused outright.
   *
   * The replacement is staged at ci/release.yml and the test below checks it. This
   * assertion exists so the pin cannot be forgotten: the moment someone with workflow rights
   * copies the staged file over, the check passes.
   */
  const pinned = /tag_name:\s*v\d+\.\d+\.\d+/.test(workflow);
  if (pinned) {
    assert.ok(
      fs.existsSync(path.join(root, 'ci/release.yml')),
      'the live workflow pins a literal tag and no replacement is staged',
    );
  }

  // The installer linked by the README must be uploaded.
  for (const artifact of ['JoeBrowserSetup.exe']) {
    assert.ok(workflow.includes(artifact), `the workflow does not publish ${artifact}`);
  }

  // Pinning the release to the built commit is checked in the staged file below: the live one
  // predates it and cannot be edited from here.
});

test('the staged workflow replacement is correct and drops the pinned tag', () => {
  const staged = read('ci/release.yml');

  // The two files must stay identical: one is the source of truth and the other is what GitHub
  // runs. They drifted once already, and only one of them runs.
  assert.equal(staged, read('.github/workflows/release.yml'), 'ci/release.yml and the live workflow differ');

  // This file is what a maintainer copies to .github/workflows/release.yml. It must not carry
  // the defect it exists to fix.
  assert.doesNotMatch(
    staged,
    /tag_name:\s*v\d+\.\d+\.\d+/,
    'the staged workflow still pins a literal tag',
  );
  assert.match(staged, /tag_name:\s*\$\{\{/, 'the staged workflow does not derive its tag');

  // Everything the release depends on, in the right order.
  const packaging = staged.indexOf('electron-builder');
  for (const gate of ['npm run typecheck', 'npm test', 'npm run build']) {
    const at = staged.indexOf(gate);
    assert.ok(at > 0, `the staged workflow does not run ${gate}`);
    assert.ok(at < packaging, `${gate} runs after packaging`);
  }

  // A release that publishes no binaries looks finished and is not.
  assert.match(staged, /fail_on_unmatched_files:\s*true/);
  assert.match(staged, /target_commitish:/);
  assert.match(staged, /if:\s*\$\{\{ inputs\.publish == true \}\}/, 'publishing must require explicit opt-in');

  for (const artifact of ['JoeBrowserSetup.exe']) {
    assert.ok(staged.includes(artifact), `the staged workflow does not publish ${artifact}`);
  }

  // The tag is read through the environment, not interpolated into the shell. `${{ }}` is
  // substituted before bash runs, so a tag with a quote in it would become shell syntax, and an
  // unset optional input arrives as the literal "null".
  assert.ok(staged.includes('INPUT_TAG:'), 'the tag is not passed through the environment');
  assert.ok(staged.includes('"null"'), 'an unset input is not handled');
  assert.doesNotMatch(
    staged,
    /^\s+tag="\$\{\{ inputs\.tag \}\}"/m,
    'the tag is interpolated straight into the script',
  );

  // It has to be valid YAML with a build job and a workflow_dispatch trigger, because the whole
  // point is that it works where the pinned one does not.
  assert.match(staged, /^on:\s*$/m);
  assert.match(staged, /workflow_dispatch:/);
  assert.match(staged, /runs-on:\s*windows-latest/);
});

test('files the build depends on are not left in an ignored directory', () => {
  // `release/` is electron-builder's output directory and is gitignored. Putting a source file
  // there looks committed and is not: it exists on the machine that wrote it and nowhere else,
  // and a test reading it passes locally and fails on a fresh clone. That mistake was made once.
  const ignored = read('.gitignore')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .map((line) => line.replace(/\/$/, ''));

  // The staged workflow and everything this suite reads must live outside those paths.
  for (const file of ['ci/release.yml', '.github/workflows/release.yml', 'package.json', 'electron-builder.yml']) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} does not exist`);
    for (const dir of ignored) {
      const top = file.split('/')[0]!;
      assert.notEqual(top, dir, `${file} lives in the ignored directory "${dir}/"`);
    }
  }
});

test('no setting is declared and then never read', () => {
  /*
   * A field on AppSettings that nothing reads is worse than a missing feature: it exists in the
   * settings file, it is defaulted, and the interface may even offer a control for it, but
   * changing it does nothing. `pinEnabled` and `defaultKernelId` were both live examples -
   * the first meant a PIN never locked the app, the second meant a chosen build was ignored.
   *
   * This reads every source file and counts real references, excluding the three places a field
   * legitimately appears while doing nothing: the interface, the defaults, and the mock.
   */
  const interfaceBlock = /export interface AppSettings \{([\s\S]*?)\n\}/.exec(types)![1]!;
  const fields = [...interfaceBlock.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]!);

  const sources = fs
    .readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .filter((name) => !name.endsWith('types.ts'))
    .filter((name) => !name.endsWith('bridge.ts')); // the preview mock mirrors the shape

  const body = sources.map((name) => read(path.join('src', name))).join('\n');

  const dead = fields.filter((field) => !new RegExp(`\\b${field}\\b`).test(body));
  assert.deepEqual(dead, [], `settings nothing reads: ${dead.join(', ')}`);
});


test('the built preload exposes every Bridge method on the actual joe object', () => {
  const exposed: Record<string, Record<string, (...args: unknown[]) => unknown>> = {};
  const subscriptions = new Map<string, (...args: unknown[]) => void>();
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: typeof exposed[string]) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: async () => undefined,
      on: (channel: string, callback: (...args: unknown[]) => void) => subscriptions.set(channel, callback),
      removeListener: (channel: string) => subscriptions.delete(channel),
    },
  };
  runInNewContext(read('dist/preload/index.js'), {
    require: (name: string) => { assert.equal(name, 'electron'); return electron; },
  });
  for (const method of bridgeMethods()) {
    assert.equal(typeof exposed.joe?.[method], 'function', `window.joe.${method} is missing at runtime`);
  }
  let received: unknown;
  const off = exposed.joe!.on!('extensions:changed', (payload: unknown) => { received = payload; }) as () => void;
  subscriptions.get('extensions:changed')!({}, 'changed');
  assert.equal(received, 'changed');
  off();
  assert.equal(subscriptions.size, 0);
});


test('Windows distribution is an assisted installer, never a portable app', () => {
  const config = read('electron-builder.yml');
  assert.match(config, /target: nsis/);
  assert.doesNotMatch(config, /target: portable|^portable:/m);
  for (const setting of [
    'oneClick: false', 'perMachine: false', 'allowElevation: true',
    'allowToChangeInstallationDirectory: true', 'license: LICENSE',
    'createDesktopShortcut: true', 'createStartMenuShortcut: true',
    'runAfterFinish: true', 'deleteAppDataOnUninstall: false',
    'artifactName: JoeBrowserSetup.${ext}',
  ]) assert.ok(config.includes(setting), `Missing installer setting: ${setting}`);

  for (const file of ['.github/workflows/release.yml', 'ci/release.yml', 'scripts/release.ps1']) {
    const source = read(file);
    assert.ok(source.includes('JoeBrowserSetup.exe'), `${file} must distribute setup`);
    assert.ok(!source.includes('JoeBrowser.exe'), `${file} must not distribute the legacy portable app`);
  }
  assert.doesNotMatch(read('README.md'), /download\/JoeBrowser\.exe/);
});
