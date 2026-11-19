import test from 'node:test';
import assert from 'node:assert/strict';
import { format } from 'node:util';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * The interface, rendered.
 *
 * A typecheck proves a component compiles; it does not prove it survives its first render.
 * Every page here is mounted for real in a DOM, with the same mock bridge the browser preview
 * uses, and any React warning is treated as a failure - because the warnings that appear here
 * (a missing key, an invalid prop, a state update after unmount) are exactly the ones that
 * show up as a flicker or a broken list in the packaged app.
 *
 * The last test is the one that keeps the interface honest as it grows: every key a page asks
 * for has to exist in the English table, or a user in another language falls back to a raw dotted
 * identifier in the middle of a sentence.
 */

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

const win = dom.window as unknown as Window & typeof globalThis;

/**
 * Node 22 exposes some of these as getter-only globals, so they are redefined rather than
 * assigned. React reads them off the global object, not off `window`.
 */
function install(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

install('window', win);
install('document', win.document);
install('navigator', win.navigator);
install('HTMLElement', win.HTMLElement);
install('HTMLCanvasElement', win.HTMLCanvasElement);
install('HTMLInputElement', win.HTMLInputElement);
install('Element', win.Element);
install('Node', win.Node);
install('Event', win.Event);
install('CustomEvent', win.CustomEvent);
install('MouseEvent', win.MouseEvent);
install('KeyboardEvent', win.KeyboardEvent);
install('getComputedStyle', win.getComputedStyle.bind(win));
install('localStorage', win.localStorage);
install('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
install('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
install('IS_REACT_ACT_ENVIRONMENT', true);

const React = await import('react');
const { createRoot } = await import('react-dom/client');

// React 18.3 exports act from the package itself; react-dom/test-utils' copy is deprecated and
// logs a warning that this suite would rightly treat as a failure.
const act = (React as unknown as { act: typeof import('react')['act'] }).act;

const { App } = await import('../src/renderer/App');
const { ProfilesPage } = await import('../src/renderer/pages/ProfilesPage');
const { ProfileEditor } = await import('../src/renderer/pages/ProfileEditor');
const { HistoryPage } = await import('../src/renderer/pages/HistoryPage');
const { ProxiesPage } = await import('../src/renderer/pages/ProxiesPage');
const { ExtensionsPage } = await import('../src/renderer/pages/ExtensionsPage');
const { BrowsersPage } = await import('../src/renderer/pages/BrowsersPage');
const { ToolsPage } = await import('../src/renderer/pages/ToolsPage');
const { SettingsPage } = await import('../src/renderer/pages/SettingsPage');
const { AboutPage } = await import('../src/renderer/pages/AboutPage');
const { LeakModal } = await import('../src/renderer/pages/LeakModal');
const { BatchCreateModal } = await import('../src/renderer/pages/BatchCreateModal');
const { mockBridge } = await import('../src/renderer/bridge');
const { I18nProvider, useI18n } = await import('../src/renderer/i18n');
const { ToastProvider } = await import('../src/renderer/components/UI');
const { ENGLISH_TABLE, allKeys, coverageOf } = await import('../src/shared/i18n');
const { encodeQr, qrPath } = await import('../src/shared/qr');
const { AccountGate } = await import('../src/renderer/pages/AccountGate');
const { AdminPage } = await import('../src/renderer/pages/AdminPage');
const { SecurityPanel } = await import('../src/renderer/pages/SecurityPanel');
const { SubscriptionProvider } = await import('../src/renderer/cloud/subscription');

// The bridge the renderer expects, installed before any component looks for it.
(win as unknown as { joe: unknown }).joe = mockBridge;

/**
 * A cloud that behaves like the real one from the window's point of view: a session that can be
 * signed in or out, and an entitlement the panel can read. Installed through the documented
 * `__joeCloud` seam, so nothing here talks to the network.
 */
const premiumEntitlement = () => ({
  expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  serverTime: new Date().toISOString(),
  isAdmin: false,
  isBlocked: false,
  plan: 'premium' as const,
  source: 'server' as const,
});

const signedInUser = () => ({ id: 'local-test-user', email: 'joe@example.com' });

const fakeCloud = {
  user: signedInUser() as null | { id: string; email: string },
  entitlement: premiumEntitlement(),
  async currentUser() {
    return this.user;
  },
  async signInWithPassword(email: string) {
    this.user = { id: 'local-test-user', email };
    return this.user;
  },
  async signUp(email: string) {
    this.user = { id: 'local-test-user', email };
    return this.user;
  },
  async signOut() {
    this.user = null;
  },
  async myEntitlement() {
    return { ...this.entitlement, serverTime: new Date().toISOString() };
  },
  async startTrial() {
    return { ...premiumEntitlement(), plan: 'trial' as const, started: true };
  },
  async redeemCode() {
    return {
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      serverTime: new Date().toISOString(),
    };
  },
  async adminListUsers() {
    return [];
  },
  async adminListCodes() {
    return [];
  },
  async adminListTrialClaims() {
    return [];
  },
  async adminCreateCodes() {
    return [];
  },
  async adminRevokeCode() {
    /* no-op */
  },
  async adminSetBlocked() {
    /* no-op */
  },
  async adminSetExpiry() {
    /* no-op */
  },
};
(globalThis as unknown as { __joeCloud: typeof fakeCloud }).__joeCloud = fakeCloud;

function signIn(): void {
  fakeCloud.user = signedInUser();
  fakeCloud.entitlement = premiumEntitlement();
}
function signOutCloud(): void {
  fakeCloud.user = null;
}

const problems: string[] = [];
const originalError = console.error;
const originalWarn = console.warn;

console.error = (...args: unknown[]) => {
  problems.push(format(...args));
};
console.warn = (...args: unknown[]) => {
  const first = String(args[0] ?? '');
  // React's dev build warns about act() around an async effect; that is the harness, not the app.
  if (first.includes('not wrapped in act')) return;
  problems.push(format(...args));
};

const container = win.document.getElementById('root')!;
let liveRoot: ReturnType<typeof createRoot> | null = null;

/** Mount and keep it mounted: what a user sees is the tree on screen, not a torn-down one. */
/**
 * A page on its own still needs the two providers the shell supplies: the language table and the
 * toast queue. Mounting without them is not a test of the page, it is a test of the harness.
 */
function hosted(element: React.ReactElement): React.ReactElement {
  return React.createElement(
    I18nProvider,
    { language: 'en' },
    React.createElement(
      SubscriptionProvider,
      { user: fakeCloud.user },
      React.createElement(ToastProvider, null, element),
    ),
  );
}

async function render(element: React.ReactElement): Promise<void> {
  if (liveRoot) {
    await act(async () => {
      liveRoot!.unmount();
    });
    liveRoot = null;
  }
  container.innerHTML = '';
  liveRoot = createRoot(container);

  await act(async () => {
    liveRoot!.render(element);
    await Promise.resolve();
  });
  // Let the pages' own data loads settle before anything is asserted.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 45));
  });
}

async function teardown(): Promise<void> {
  if (!liveRoot) return;
  const root = liveRoot;
  liveRoot = null;
  await act(async () => {
    root.unmount();
  });
}

function text(): string {
  return container.textContent ?? '';
}

function reset(): void {
  problems.length = 0;
  try {
    win.localStorage.clear();
  } catch {
    /* the jsdom storage is always there; a failure here must not hide a real one */
  }
}

test.after(() => {
  console.error = originalError;
  console.warn = originalWarn;
});

/* ------------------------------------------------------------------ the shell */

/** A component that asks the translation layer for keys that are blank in some languages. */
function LanguageProbe(): React.ReactElement {
  const { t } = useI18n();
  return React.createElement('span', null, `${t('history.open')}|${t('history.open.hint')}`);
}

test('a blank translation falls back to English instead of a dotted key', async () => {
  reset();
  await render(React.createElement(I18nProvider, { language: 'de' }, React.createElement(LanguageProbe)));

  const body = text();
  assert.match(body, /Open in the profile/, 'the English label did not fill the blank translation');
  assert.ok(!body.includes('history.open'), 'a raw translation key reached the window');
});

test('the window mounts and paints the profile list', async () => {
  signIn();
  reset();
  await render(React.createElement(App));

  const body = text();
  assert.ok(body.includes('Joe Browser'), 'the brand is missing');
  assert.ok(body.includes('Profiles'), 'the profile page heading is missing');
  assert.ok(body.includes('Shop UK'), 'the sample profiles did not render');

  // Eight destinations: five workspace, three system. A page that loses its entry is a page
  // nobody can reach.
  const navButtons = [...container.querySelectorAll('.nav-item')];
  assert.equal(navButtons.length, 8, `expected 8 nav entries, found ${navButtons.length}`);

  const labels = navButtons.map((button) => (button.textContent ?? '').trim());
  for (const expected of ['Profiles', 'History', 'Proxies', 'Extensions', 'Tools', 'Browsers', 'Settings', 'About']) {
    assert.ok(
      labels.some((label) => label.includes(expected)),
      `the rail is missing ${expected}`,
    );
  }

  // The empty-state action and the header action both exist; the header one is always there.
  assert.ok(
    container.querySelector('.header-actions') !== null,
    'the header carries no actions',
  );

  assert.deepEqual(problems, [], `React reported problems: ${problems.join(' | ')}`);

  await teardown();
});

test('the rail can be collapsed without losing a destination', async () => {
  signIn();
  reset();
  await render(React.createElement(App));

  const toggle = [...container.querySelectorAll('.rail-foot button')].find((button) =>
    (button.getAttribute('title') ?? '').toLowerCase().includes('collapse'),
  );
  assert.ok(toggle, 'the rail has no collapse control');

  await act(async () => {
    toggle!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });

  assert.ok(container.querySelector('.shell.narrow') !== null, 'the rail did not collapse');
  assert.equal(container.querySelectorAll('.nav-item').length, 8, 'a destination vanished with the rail');
  assert.deepEqual(problems, [], `rail: ${problems.join(' | ')}`);

  await teardown();
});

test('every nav entry navigates to a page that renders', async () => {
  signIn();
  for (const [index, expected] of [
    [1, 'History'],
    [2, 'Proxies'],
    [3, 'Extensions'],
    [4, 'Tools'],
    [5, 'Browsers'],
    [6, 'Settings'],
    [7, 'About'],
  ] as [number, string][]) {
    reset();
    await render(React.createElement(App));

    const button = container.querySelectorAll('.nav-item')[index];
    assert.ok(button, `nav entry ${index} is missing`);

    await act(async () => {
      button.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 45));
    });

    assert.ok(text().includes(expected), `the ${expected} page did not render`);
    assert.deepEqual(problems, [], `${expected}: ${problems.join(' | ')}`);
  }

  await teardown();
});

/* ------------------------------------------------------------------ the pages */

test('every page renders on its own', async () => {
  signIn();
  const profiles = await mockBridge.listProfiles();
  const settings = await mockBridge.getSettings();
  const info = await mockBridge.getAppInfo();
  const noop = () => undefined;
  const running = new Map();
  const refresh = async () => undefined;

  const cases: [string, React.ReactElement, string][] = [
    [
      'ProfilesPage',
      React.createElement(ProfilesPage, { profiles, runningById: running, settings, saveSettings: async () => settings, refresh, toast: { toast: noop } as never }),
      'Profiles',
    ],
    ['HistoryPage', React.createElement(HistoryPage, { profiles }), 'History'],
    ['ProxiesPage', React.createElement(ProxiesPage, { profiles, refreshProfiles: refresh }), 'Proxies'],
    [
      'ExtensionsPage',
      React.createElement(ExtensionsPage, { settings, saveSettings: async () => settings }),
      'Extensions',
    ],
    ['BrowsersPage', React.createElement(BrowsersPage, { settings, saveSettings: async () => settings }), 'Browsers'],
    [
      'ToolsPage',
      React.createElement(ToolsPage, { profiles, refreshProfiles: refresh, onNavigate: noop }),
      'Tools',
    ],
    [
      'SettingsPage',
      React.createElement(SettingsPage, { settings, info, saveSettings: async () => settings, refreshProfiles: refresh, onSignedOut: () => undefined }),
      'Settings',
    ],
    ['AboutPage', React.createElement(AboutPage, { info, profiles }), 'About'],
    ['AdminPage', React.createElement(AdminPage, {}), 'Admin panel'],
  ];

  for (const [name, element, expected] of cases) {
    reset();
    // The admin panel is administrator-only; give it an administrator for its own test.
    if (name === 'AdminPage') fakeCloud.entitlement = { ...premiumEntitlement(), isAdmin: true };
    await render(hosted(element));
    if (name === 'AdminPage') signIn();
    assert.ok(text().toLowerCase().includes(expected.toLowerCase()), `${name} did not render`);
    assert.deepEqual(problems, [], `${name}: ${problems.join(' | ')}`);
  }

  await teardown();
});

test('the dialogs open with a profile behind them', async () => {
  signIn();
  const profiles = await mockBridge.listProfiles();
  const settings = await mockBridge.getSettings();
  const first = profiles[0]!;

  reset();
  await render(hosted(React.createElement(LeakModal, { profile: first, onClose: () => undefined })));
  // Either the report or its loading state has to be on screen; a blank dialog is a bug.
  assert.ok(text().length > 40, 'the fingerprint dialog rendered nothing');
  assert.deepEqual(problems, [], `LeakModal: ${problems.join(' | ')}`);

  reset();
  await render(hosted(React.createElement(BatchCreateModal, { settings, onClose: () => undefined, onCreated: () => undefined })));
  assert.ok(text().includes('Batch'), 'the batch dialog did not render');
  assert.deepEqual(problems, [], `BatchCreateModal: ${problems.join(' | ')}`);

  // The editor takes a full profile, not the summary the list carries.
  const full = (await mockBridge.getProfile(first.id))!;

  reset();
  await render(hosted(
    React.createElement(ProfileEditor, {
      profile: full,
      onClose: () => undefined,
      onSaved: () => undefined,
      settings,
      existing: profiles,
      toast: { toast: () => undefined } as never,
    }),
  ));
  assert.ok(text().includes('General'), 'the editor tabs are missing');
  assert.ok(text().includes('Fingerprint'), 'the fingerprint tab is missing');

  await teardown();
});

test('an empty store shows the empty state rather than a blank page', async () => {
  signIn();
  reset();
  const settings = await mockBridge.getSettings();
  await render(hosted(
    React.createElement(ProfilesPage, {
      profiles: [],
      runningById: new Map(),
      settings,
      saveSettings: async () => settings,
      refresh: async () => undefined,
      toast: { toast: () => undefined } as never,
    }),
  ));
  assert.deepEqual(problems, [], `empty state: ${problems.join(' | ')}`);

  // Whatever the copy says, an empty store has to offer a way out of itself.
  const buttons = [...container.querySelectorAll('button')].map((button) => (button.textContent ?? '').toLowerCase());
  assert.ok(
    buttons.some((label) => label.includes('new profile') || label.includes('create')),
    'the empty state has no create action',
  );

  await teardown();
});

test('every interactive control carries a name a person can hear', async () => {
  signIn();
  const profiles = await mockBridge.listProfiles();
  const settings = await mockBridge.getSettings();
  await render(hosted(
    React.createElement(ProfilesPage, {
      profiles,
      runningById: new Map(),
      settings,
      saveSettings: async () => settings,
      refresh: async () => undefined,
      toast: { toast: () => undefined } as never,
    }),
  ));

  const buttons = [...container.querySelectorAll('button')];
  assert.ok(buttons.length > 0, 'no buttons rendered');

  // A button whose only content is an icon still needs a name, or it is silent to a screen
  // reader and unguessable to a keyboard user.
  const unnamed = buttons.filter((button) => {
    const label = (button.textContent ?? '').trim();
    const aria = button.getAttribute('aria-label') ?? button.getAttribute('title') ?? '';
    return label.length === 0 && aria.trim().length === 0;
  });

  assert.deepEqual(
    unnamed.map((b) => b.outerHTML.slice(0, 120)),
    [],
    'these buttons have no accessible name',
  );
});

/* ------------------------------------------------------------------ the gate */

test('the gate requires an account', async () => {
  signOutCloud();
  const settings = await mockBridge.getSettings();

  reset();
  await render(hosted(React.createElement(AccountGate, { onDone: () => undefined })));
  const body = text();
  assert.ok(body.includes('Joe Browser'), 'the gate does not name the product');
  assert.ok(
    body.toLowerCase().includes('create an account') || body.toLowerCase().includes('sign in'),
    'the gate offers no way in',
  );
  // A boolean, not the element: Node's assertion diff renders a DOM node into a string large
  // enough to exhaust the heap, so a failure here would look like a crash rather than a failure.
  assert.ok(container.querySelector('.gate-skip') === null, 'local mode must not be offered');
  assert.deepEqual(problems, [], `AccountGate: ${problems.join(' | ')}`);

  // The security panel owns its local identity; with the mock bridge's local account present the
  // PIN and the second factor are on screen, without the removed lock props.
  reset();
  await render(
    hosted(
      React.createElement(SecurityPanel, {
        settings,
        saveSettings: async () => settings,
      }),
    ),
  );
  const security = text();
  assert.ok(security.includes('Security'), 'the security panel has no heading');
  assert.ok(
    security.includes('PIN') || security.toLowerCase().includes('two-factor') || security.includes('2FA'),
    'neither the PIN nor the second factor is offered',
  );
  assert.deepEqual(problems, [], `SecurityPanel: ${problems.join(' | ')}`);

  signIn();
  await teardown();
});

test('the idle lock draws over the workspace and clears with the local PIN', async () => {
  signIn();
  reset();
  let idleListener: (() => void) | null = null;
  const originalEvents = (win as unknown as { joeEvents?: unknown }).joeEvents;
  const originalLockState = mockBridge.lockState;
  const originalUnlock = mockBridge.unlock;
  let unlockCalls = 0;
  (win as unknown as { joeEvents?: unknown }).joeEvents = {
    on(channel: string, listener: () => void) {
      if (channel === 'lock:idle') idleListener = listener;
      return () => undefined;
    },
  };
  const lockedAccount = {
    email: 'joe@example.com',
    displayName: 'Joe',
    created: new Date().toISOString(),
    lastLogin: new Date().toISOString(),
    pinEnabled: true,
    twoFactorEnabled: false,
  };
  mockBridge.lockState = async () => ({ state: 'locked' as const, account: lockedAccount, pin: true, totp: false });
  mockBridge.unlock = async (input: { pin: string; code: string }) => {
    unlockCalls += 1;
    if (input.pin !== '1234') throw new Error('That PIN is not right.');
  };
  try {
    await render(React.createElement(App));
    assert.ok(container.querySelector('.lock-overlay') === null, 'the lock drew before the idle event');
    assert.ok(idleListener, 'the shell never subscribed to the idle event');

    await act(async () => {
      idleListener!();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.ok(container.querySelector('.lock-overlay'), 'the idle lock did not appear');

    const setPin = (value: string) => {
      const input = container.querySelector('.lock-overlay input[aria-label="PIN"]') as HTMLInputElement;
      assert.ok(input, 'the PIN field is missing');
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
    };

    // A wrong PIN keeps the lock up and shows why.
    await act(async () => {
      setPin('0000');
    });
    await act(async () => {
      container.querySelector('.lock-overlay form')!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(unlockCalls, 1);
    assert.ok(container.querySelector('.lock-overlay'), 'a wrong PIN dismissed the lock');
    assert.ok(text().includes('PIN') || text().includes('not right'), 'no reason for the failed unlock');

    // The right PIN clears it.
    await act(async () => {
      setPin('1234');
    });
    await act(async () => {
      container.querySelector('.lock-overlay form')!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(unlockCalls, 2);
    assert.ok(container.querySelector('.lock-overlay') === null, 'the lock did not clear on the right PIN');
    assert.deepEqual(problems, [], `lock: ${problems.join(' | ')}`);
  } finally {
    await teardown();
    (win as unknown as { joeEvents?: unknown }).joeEvents = originalEvents;
    mockBridge.lockState = originalLockState;
    mockBridge.unlock = originalUnlock;
  }
});

/* ------------------------------------------------------------------ the second factor */

test('the QR encoder produces a symbol for an otpauth URI', () => {
  const uri =
    'otpauth://totp/Joe%20Browser:me%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Joe%20Browser';
  const code = encodeQr(uri);
  assert.ok(code, 'the URI did not fit any version');
  assert.equal(code.size, code.version * 4 + 17);

  // Every finder pattern corner has to be the right shape, or no scanner will locate the symbol.
  const dark = (x: number, y: number): boolean => code.modules[y]![x]!;
  for (const [ox, oy] of [
    [0, 0],
    [code.size - 7, 0],
    [0, code.size - 7],
  ] as [number, number][]) {
    assert.equal(dark(ox, oy), true, `finder corner at ${ox},${oy} is not dark`);
    assert.equal(dark(ox + 3, oy + 3), true, 'the finder centre is not dark');
    assert.equal(dark(ox + 1, oy + 1), false, 'the finder ring is not light');
  }

  // The always-dark module, which the original wrote into the wrong corner.
  assert.equal(dark(8, code.size - 8), true, 'the dark module is missing');

  const path = qrPath(code);
  assert.ok(path.startsWith('M'), 'the path is empty');
  assert.ok(path.includes('h1v1h-1z'), 'the path is not made of modules');

  // Too much text for version 9 must be refused rather than silently truncated into a code
  // that scans as something else.
  assert.equal(encodeQr('x'.repeat(400)), null);
});

/* ------------------------------------------------------------------ the language table */

test('every key the interface asks for exists in the English table', () => {
  const known = new Set(allKeys());

  // The pages are read from source rather than from the bundle, so this catches a key that was
  // typed into a component the render tests above never happened to exercise.
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) files.push(full);
    }
  };
  walk('src/renderer');
  assert.ok(files.length > 8, `only ${files.length} renderer sources were found`);

  const used = new Map<string, string>();
  for (const file of files) {
    const body = readFileSync(file, 'utf8');
    for (const match of body.matchAll(/\bt\(\s*'([^']+)'/g)) {
      if (!used.has(match[1]!)) used.set(match[1]!, file);
    }
  }

  assert.ok(used.size > 250, `only ${used.size} literal keys were found; the scan is broken`);

  const missing = [...used].filter(([key]) => !known.has(key));
  assert.deepEqual(
    missing.map(([key, file]) => `${key} (${path.basename(file)})`),
    [],
    'these keys have no English string',
  );
});

test('the coverage figures are the real thing and never claim more than exists', () => {
  const english = Object.keys(ENGLISH_TABLE).length;
  assert.ok(english > 500, `the English table looks truncated at ${english} keys`);

  for (const language of ['de', 'ru', 'es', 'fr', 'pt', 'it', 'nl', 'pl', 'tr', 'uk', 'ar', 'zh', 'ja', 'ko']) {
    const coverage = coverageOf(language);
    assert.ok(coverage > 0, `${language} has no coverage`);
    assert.ok(coverage < 100, `${language} claims a complete table; it is a partial one`);
  }

  // English is the contract and is complete by definition.
  assert.equal(coverageOf('en'), 100);
});

test('registration enters an empty workspace and a remembered account survives remount', async () => {
  reset();
  const originalListProfiles = mockBridge.listProfiles;
  const originalListAccounts = mockBridge.listAccounts;
  let registered = false;
  mockBridge.listProfiles = async () => [];
  mockBridge.listAccounts = async () => [];
  signOutCloud();
  win.localStorage.setItem('joe-local-mode', '1');
  const originalSignUp = fakeCloud.signUp.bind(fakeCloud);
  fakeCloud.signUp = async (email: string) => {
    registered = true;
    return originalSignUp(email);
  };
  try {
    await render(React.createElement(App));
    assert.ok(container.querySelector('.gate'), 'the gate did not appear without a session');
    const setInput = (selector: string, value: string) => {
      const input = container.querySelector(selector)!;
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
    };
    // Switch to the create-account tab.
    const createTab = [...container.querySelectorAll('.gate [role="tab"]')].find((button) =>
      (button.textContent ?? '').toLowerCase().includes('create account'),
    );
    assert.ok(createTab, 'the create-account tab is missing');
    await act(async () => {
      createTab!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      setInput('input[type=email]', 'new@example.com');
      setInput('input[type=password]', 'secret123');
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(registered, true, 'sign-up was never called');
    assert.equal(fakeCloud.user?.email, 'new@example.com');
    assert.equal(container.querySelectorAll('.nav-item').length, 8);
    assert.ok(container.querySelector('.gate') === null);
    await teardown();
    await render(React.createElement(App));
    assert.equal(container.querySelectorAll('.nav-item').length, 8);
    assert.ok(container.querySelector('.gate') === null);
    assert.deepEqual(problems, []);
  } finally {
    await teardown();
    mockBridge.listProfiles = originalListProfiles;
    mockBridge.listAccounts = originalListAccounts;
    fakeCloud.signUp = originalSignUp;
    signIn();
  }
});

test('a failed startup can reload settings, app info and account state', async () => {
  signIn();
  reset();
  const original = mockBridge.getSettings;
  let calls = 0;
  mockBridge.getSettings = async () => {
    if (++calls === 1) throw new Error('Temporary startup failure');
    return original();
  };
  try {
    await render(React.createElement(App));
    assert.ok(text().includes('Temporary startup failure'));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.banner button')!.click();
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    assert.equal(calls, 2);
    assert.equal(container.querySelectorAll('.nav-item').length, 8);
    assert.ok(!text().includes('Temporary startup failure'));
    assert.deepEqual(problems, []);
  } finally {
    await teardown();
    mockBridge.getSettings = original;
  }
});

test('new profile editor creates no record until save', async () => {
  signIn();
  reset();
  const settings = await mockBridge.getSettings();
  const existing = await mockBridge.listProfiles();
  const before = existing.length;
  let saved = false;
  await render(hosted(React.createElement(ProfileEditor, {
    profile: null, onClose: () => undefined, onSaved: () => { saved = true; },
    settings, existing, toast: { toast: () => undefined } as never,
  })));
  assert.equal((await mockBridge.listProfiles()).length, before);
  const save = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Save changes'));
  assert.ok(save);
  await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(saved, true);
  assert.equal((await mockBridge.listProfiles()).length, before + 1);
  await teardown();
});

test('saving an unrelated profile edit does not send a blank proxy password', async () => {
  signIn();
  reset();
  const settings = await mockBridge.getSettings();
  const existing = await mockBridge.listProfiles();
  const profile = (await mockBridge.getProfile(existing[0]!.id))!;
  const original = mockBridge.updateProfile;
  let sent: Parameters<typeof mockBridge.updateProfile>[1] | undefined;
  mockBridge.updateProfile = async (id, patch) => { sent = patch; return { ...profile, ...patch, id }; };
  try {
    await render(hosted(React.createElement(ProfileEditor, {
      profile, onClose: () => undefined, onSaved: () => undefined,
      settings, existing, toast: { toast: () => undefined } as never,
    })));
    const save = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Save changes'));
    assert.ok(save);
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.ok(sent?.proxy);
    assert.equal(sent.proxy.password, undefined);
  } finally {
    mockBridge.updateProfile = original;
    await teardown();
  }
});

test('proxy host Ctrl+B fills all fields without toggling global shortcuts', async () => {
  signIn(); reset();
  const original = mockBridge.proxyClipboard;
  mockBridge.proxyClipboard = async () => ({ type: 'socks5', host: 'example.test', port: 1080, user: 'alice', password: 'p:word' });
  try {
    await render(hosted(React.createElement(ProxiesPage, { profiles: [], refreshProfiles: async () => undefined })));
    const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes('Add proxy'));
    assert.ok(button);
    await act(async () => { button.click(); });
    const host = container.querySelector('input[placeholder="gate.example.com"]') as HTMLInputElement;
    assert.ok(host);
    let bubbled = false;
    const listener = () => { bubbled = true; };
    win.addEventListener('keydown', listener);
    await act(async () => { host.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })); await Promise.resolve(); });
    win.removeEventListener('keydown', listener);
    const dialog = host.closest('.modal')!;
    const inputs = [...dialog.querySelectorAll('input')];
    assert.equal(host.value, 'example.test');
    assert.ok(inputs.some(input => input.value === '1080'));
    assert.ok(inputs.some(input => input.value === 'alice'));
    assert.ok(inputs.some(input => input.value === 'p:word' && input.type === 'password'));
    assert.equal(bubbled, false);
    assert.ok(!dialog.textContent?.includes('Stored encrypted'));
    assert.deepEqual(problems, []);
  } finally { mockBridge.proxyClipboard = original; await teardown(); }
});

test('profile proxy host Ctrl+B fills credentials', async () => {
  signIn(); reset();
  const original = mockBridge.proxyClipboard;
  mockBridge.proxyClipboard = async () => ({ type: 'http', host: 'profile-proxy.test', port: 3128, user: 'bob', password: 'secret' });
  try {
    const profiles = await mockBridge.listProfiles();
    const full = (await mockBridge.getProfile(profiles[0]!.id))!;
    const settings = await mockBridge.getSettings();
    await render(hosted(React.createElement(ProfileEditor, { profile: full, onClose: () => undefined, onSaved: () => undefined, settings, existing: profiles, toast: { toast: () => undefined } as never })));
    const tab = [...container.querySelectorAll('button')].find(el => el.textContent?.trim() === 'Proxy' || el.textContent?.trim() === 'Connection');
    assert.ok(tab);
    await act(async () => { tab.click(); });
    const host = container.querySelector('input[placeholder="gate.example.com"]') as HTMLInputElement;
    assert.ok(host);
    await act(async () => { host.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })); await Promise.resolve(); });
    const inputs = [...container.querySelectorAll('input')];
    assert.equal(host.value, 'profile-proxy.test');
    for (const value of ['3128', 'bob', 'secret']) assert.ok(inputs.some(input => input.value === value));
    assert.deepEqual(problems, []);
  } finally { mockBridge.proxyClipboard = original; await teardown(); }
});

test('diagnostics only sends the exit IP for a risk lookup when requested', async () => {
  signIn(); reset();
  const originalReport = mockBridge.networkReport;
  const originalRisk = mockBridge.checkIpRisk;
  let requested = '';
  mockBridge.networkReport = async () => ({ ok: true, ip: '8.8.8.8', country: 'United States', countryCode: 'US', city: 'X', region: '', timezone: 'UTC', isp: 'Example', resolverIp: '', resolverGeo: '', latencyMs: 20, clockSkewSeconds: null, sources: [], warnings: [], error: '' });
  mockBridge.checkIpRisk = async (ip) => { requested = ip; return { ip, score: 45, proxy: 'yes', type: 'VPN' }; };
  try {
    await render(hosted(React.createElement(ProxiesPage, { profiles: [], refreshProfiles: async () => undefined })));
    const diag = [...container.querySelectorAll('button')].find(el => el.textContent?.includes('Network diagnostics'));
    assert.ok(diag);
    await act(async () => { diag.click(); await Promise.resolve(); });
    assert.equal(requested, '');
    const risk = [...container.querySelectorAll('button')].find(el => el.textContent?.includes('Check risk'));
    assert.ok(risk);
    await act(async () => { risk.click(); await Promise.resolve(); });
    assert.equal(requested, '8.8.8.8');
    assert.ok(text().includes('45/100'));
    assert.ok(text().includes('not proof of fraud'));
    assert.deepEqual(problems, []);
  } finally { mockBridge.networkReport = originalReport; mockBridge.checkIpRisk = originalRisk; await teardown(); }
});

test('settings shows the actual circular flag for each available language', async () => {
  signIn(); reset();
  const settings = await mockBridge.getSettings();
  const info = await mockBridge.getAppInfo();
  await render(hosted(React.createElement(SettingsPage, { settings, info, saveSettings: async () => settings, refreshProfiles: async () => undefined, onSignedOut: () => undefined })));
  const languages = await mockBridge.listLanguages();
  assert.equal(container.querySelectorAll('.lang .country-flag').length, languages.length);
  for (const language of languages) {
    const button = [...container.querySelectorAll('.lang')].find(el => el.textContent?.includes(language.native));
    assert.ok(button, language.native);
    assert.ok(button.querySelector(`.fi-${language.flag.toLowerCase()}`), language.native);
  }
  assert.deepEqual(problems, []);
  await teardown();
});

test('profiles show the detected country flag and the selected browser mark', async () => {
  signIn(); reset();
  const settings = await mockBridge.getSettings();
  const profiles = await mockBridge.listProfiles();
  const profile = { ...profiles[0]!, engine: 'chrome', locationKey: 'route-a', hasProxy: true };
  const original = mockBridge.getProfileLocation;
  mockBridge.getProfileLocation = async () => ({ key: 'route-a', ok: true, country: 'Bangladesh', countryCode: 'BD' });
  try {
    await render(hosted(React.createElement(ProfilesPage, { profiles: [profile], runningById: new Map(), settings, saveSettings: async () => settings, refresh: async () => undefined, toast: { toast: () => undefined } as never })));
    const card = container.querySelector('[data-profile-card]')!;
    assert.ok(card.querySelector('.fi-bd'));
    assert.ok(card.textContent?.includes('Bangladesh'));
    assert.ok(card.querySelector('.avatar img[src="./brand/chrome.png"]'));
    assert.deepEqual(problems, []);
  } finally { mockBridge.getProfileLocation = original; await teardown(); }
});

test('a German proxy profile shows the German flag, not the British one', async () => {
  signIn(); reset();
  const settings = await mockBridge.getSettings();
  const profiles = await mockBridge.listProfiles();
  const berlin = profiles.find((profile) => profile.name === 'Client - Berlin')!;
  await render(hosted(React.createElement(ProfilesPage, { profiles: [berlin], runningById: new Map(), settings, saveSettings: async () => settings, refresh: async () => undefined, toast: { toast: () => undefined } as never })));
  const card = container.querySelector('[data-profile-card]')!;
  assert.ok(card.querySelector('.fi-de.fis'), 'Germany must render the German flag');
  assert.ok(!card.querySelector('.fi-gb'), 'Germany must never render the British flag');
  assert.ok(card.textContent?.includes('Germany'));
  assert.deepEqual(problems, []);
  await teardown();
});

test('settings navigation keeps essential controls and never displays language percentages', async () => {
  signIn(); reset();
  const settings = await mockBridge.getSettings();
  const info = await mockBridge.getAppInfo();
  await render(hosted(React.createElement(SettingsPage, { settings, info, saveSettings: async () => settings, refreshProfiles: async () => undefined, onSignedOut: () => undefined })));
  assert.ok(container.querySelector('.lang-grid'));
  assert.equal(container.querySelectorAll('.lang .cov').length, 0);
  assert.ok([...container.querySelectorAll('.lang')].every(el => !/\d+%/.test(el.textContent ?? '')));
  const go = async (label: string) => {
    const item = [...container.querySelectorAll('.settings-nav-item')].find(el => el.textContent?.includes(label)) as HTMLButtonElement;
    assert.ok(item, label);
    await act(async () => { item.click(); });
  };
  await go('General');
  assert.ok(container.querySelector('select'));
  await go('Account & security');
  assert.ok(text().includes('Subscription'));
  await go('Data & storage');
  assert.ok(text().includes('Reset'));
  await go('Appearance');
  assert.equal(container.querySelectorAll('.lang .country-flag').length, (await mockBridge.listLanguages()).length);
  assert.deepEqual(problems, []);
  await teardown();
});

test('theme changes immediately, keeps the shell mounted, and saves rapid changes in order', async () => {
  signIn(); reset();
  const originalGet = mockBridge.getSettings;
  const originalSave = mockBridge.saveSettings;
  const base = { ...(await originalGet()), theme: 'dark' as const };
  let persisted = { ...base } as typeof base | Awaited<ReturnType<typeof originalGet>>;
  const pending: Array<() => void> = [];
  const calls: string[] = [];
  mockBridge.getSettings = async () => ({ ...persisted });
  mockBridge.saveSettings = async patch => {
    calls.push(String(patch.theme));
    await new Promise<void>(resolve => pending.push(resolve));
    persisted = { ...persisted, ...patch };
    return { ...persisted };
  };
  try {
    await render(React.createElement(App));
    const shell = container.querySelector('.shell');
    const toggle = container.querySelector('.theme-toggle') as HTMLButtonElement;
    assert.ok(shell && toggle);
    await act(async () => { toggle.click(); await Promise.resolve(); });
    assert.equal(win.document.documentElement.dataset.theme, 'light');
    assert.ok(container.querySelector('.shell') === shell);
    assert.deepEqual(calls, ['light']);
    await act(async () => { toggle.click(); await Promise.resolve(); });
    assert.equal(win.document.documentElement.dataset.theme, 'dark');
    assert.deepEqual(calls, ['light']);
    await act(async () => { pending.shift()!(); await Promise.resolve(); await Promise.resolve(); });
    assert.equal(win.document.documentElement.dataset.theme, 'dark');
    assert.deepEqual(calls, ['light', 'dark']);
    await act(async () => { pending.shift()!(); await Promise.resolve(); await Promise.resolve(); });
    assert.equal(persisted.theme, 'dark');
    assert.ok(container.querySelector('.shell') === shell);
    assert.equal(win.localStorage.getItem('joe-theme'), 'dark');
    assert.deepEqual(problems, []);
  } finally { mockBridge.getSettings = originalGet; mockBridge.saveSettings = originalSave; await teardown(); }
});

test('restoring settings does not flash dark over the early light theme', async () => {
  signIn(); reset();
  const originalGet = mockBridge.getSettings;
  const initial = { ...(await originalGet()), theme: 'light' as const };
  let finish: ((settings: typeof initial) => void) | undefined;
  mockBridge.getSettings = () => new Promise(resolve => { finish = resolve; });
  win.document.documentElement.dataset.theme = 'light';
  try {
    await render(React.createElement(App));
    assert.equal(win.document.documentElement.dataset.theme, 'light');
    assert.ok(finish);
    await act(async () => { finish!(initial); await Promise.resolve(); });
    assert.equal(win.document.documentElement.dataset.theme, 'light');
    assert.deepEqual(problems, []);
  } finally { mockBridge.getSettings = originalGet; await teardown(); }
});

test('the preview rolls a fresh, device-appropriate fingerprint on draft', async () => {
  const profiles = await mockBridge.listProfiles();
  const profile = (await mockBridge.getProfile(profiles[0]!.id))!;
  const rolled = await mockBridge.draftProfile({
    ...profile,
    fingerprint: { ...profile.fingerprint, os: 'iPhone' },
  });
  assert.notEqual(rolled.fingerprint.seed, profile.fingerprint.seed);
  assert.equal(rolled.fingerprint.os, 'iPhone');
  assert.notEqual(rolled.fingerprint.webGlRenderer, profile.fingerprint.webGlRenderer);
});

test('profile editor removes group and tags and applies fresh device fingerprints', async () => {
  signIn(); reset();
  const settings = await mockBridge.getSettings();
  const existing = await mockBridge.listProfiles();
  const profile = (await mockBridge.getProfile(existing[0]!.id))!;
  const originalDraft = mockBridge.draftProfile;
  const originalUpdate = mockBridge.updateProfile;
  const { generateFingerprint } = await import('../src/main/core/fingerprint');
  let counter = 1000;
  let saved: typeof profile.fingerprint | undefined;
  mockBridge.draftProfile = async (input) => ({ ...profile, ...input, fingerprint: generateFingerprint({ seed: ++counter, os: input.fingerprint?.os, engine: profile.engine }) });
  mockBridge.updateProfile = async (id, patch) => { saved = patch.fingerprint; return { ...profile, ...patch, id }; };
  try {
    await render(hosted(React.createElement(ProfileEditor, { profile, onClose: () => undefined, onSaved: () => undefined, settings, existing, toast: { toast: () => undefined } as never })));
    assert.ok(!text().includes('Group / folder'));
    assert.ok(!text().includes('Tags'));
    const tab = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Fingerprint');
    assert.ok(tab);
    await act(async () => { tab.click(); });
    const click = async (label: string) => {
      const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim().endsWith(label));
      assert.ok(button, label);
      await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
    };
    await click('New fingerprint');
    await click('New fingerprint');
    assert.equal(counter, 1002);
    const picker = [...container.querySelectorAll('select')].find((item) => [...item.options].some((option) => option.value === 'iPhone'))!;
    await act(async () => { picker.value = 'iPhone'; picker.dispatchEvent(new win.Event('change', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.equal(picker.value, 'iPhone');
    assert.equal(counter, 1003);
    await click('Random identity');
    assert.notEqual(picker.value, 'iPhone');
    assert.equal(counter, 1004);
    await click('Save changes');
    assert.equal(saved?.seed, 1004);
    assert.equal(saved?.os, picker.value);
  } finally { mockBridge.draftProfile = originalDraft; mockBridge.updateProfile = originalUpdate; await teardown(); }
});

test('profile country label is derived from the same code as its flag', async () => {
  signIn(); reset();
  const settings = await mockBridge.getSettings();
  const profiles = await mockBridge.listProfiles();
  const profile = { ...profiles[0]!, locationKey: 'route-germany', hasProxy: true };
  const original = mockBridge.getProfileLocation;
  mockBridge.getProfileLocation = async () => ({ key: 'route-germany', ok: true, country: 'United Kingdom', countryCode: 'DE' });
  try {
    await render(hosted(React.createElement(ProfilesPage, { profiles: [profile], runningById: new Map(), settings, saveSettings: async () => settings, refresh: async () => undefined, toast: { toast: () => undefined } as never })));
    const card = container.querySelector('[data-profile-card]')!;
    assert.ok(card.querySelector('.fi-de.fis'));
    assert.ok(card.textContent?.includes('Germany'));
    assert.ok(!card.querySelector('.fi-gb'));
  } finally { mockBridge.getProfileLocation = original; await teardown(); }
});

test('proxy country label and circular flag use the same country code', async () => {
  signIn(); reset();
  const original = mockBridge.listProxies;
  const sample = (await original())[0]!;
  mockBridge.listProxies = async () => [{ ...sample, name: 'Test route', lastCountry: 'United Kingdom', lastCountryCode: 'DE', lastCity: '' }];
  try {
    await render(hosted(React.createElement(ProxiesPage, { profiles: [], refreshProfiles: async () => undefined })));
    const row = container.querySelector('.proxy-row')!;
    assert.ok(row.querySelector('.fi-de.fis'));
    assert.ok(row.textContent?.includes('Germany'));
    assert.ok(!row.querySelector('.fi-gb'));
  } finally { mockBridge.listProxies = original; await teardown(); }
});

test('a session that fell back to direct shows the direct location rather than the proxy location', async () => {
  signIn(); reset();
  const settings = await mockBridge.getSettings();
  const profiles = await mockBridge.listProfiles();
  const profile = { ...profiles[0]!, locationKey: 'proxy-route', hasProxy: true };
  const original = mockBridge.getProfileLocation;
  mockBridge.getProfileLocation = async () => ({ key: 'direct', ok: true, country: 'United Kingdom', countryCode: 'GB' });
  const session = { profileId: profile.id, profileName: profile.name, state: 'running', debugPort: 0, pid: 0, engine: profile.engine, browserVersion: profile.browserVersion, startedAt: '', exitIp: '', lastError: '', proxyFellBack: true } as const;
  try {
    await render(hosted(React.createElement(ProfilesPage, { profiles: [profile], runningById: new Map([[profile.id, session]]), settings, saveSettings: async () => settings, refresh: async () => undefined, toast: { toast: () => undefined } as never })));
    const card = container.querySelector('[data-profile-card]')!;
    assert.ok(card.querySelector('.fi-gb'));
    assert.ok(card.textContent?.includes('United Kingdom'));
    assert.ok(card.textContent?.includes('Direct'));
  } finally { mockBridge.getProfileLocation = original; await teardown(); }
});
