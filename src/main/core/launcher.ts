import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { CookieRecord, SessionInfo } from '../../shared/types';
import type { Profile } from '../../shared/types';
import { JOE_ENGINE } from '../../shared/types';
import { Paths } from './paths';
import { CdpClient, delay } from './cdp';
import { buildFingerprintScript } from './inject';
import { openTunnel, proxyEnabled, upstreamOf, type Upstream } from './proxy';
import { startRelay, type RelayHandle } from './relay';
import { proxyPasswordOf, getSettings } from './store';
import { ensureShipped, loadArgs, profileExtensionFolders } from './library';
import { log } from './log';
import { testProxy } from './proxy';
import { ProxyWatchState } from './proxyWatch';
import * as history from './history';
import { resolveManagedRuntime } from './runtime';
import { buildIdentity } from './ua';

/**
 * Launching a profile.
 *
 * The order matters and is deliberate:
 *   1. Resolve an app-managed browser binary for the selected engine.
 *   2. Start the relay if the profile has an authenticated proxy.
 *   3. Spawn the browser with its own user-data-dir, so cookies and storage are its own.
 *   4. Attach over CDP and stamp every new target *before* it runs, then release it.
 *
 * Step 4 is the part that separates this from a shortcut launcher. `Target.setAutoAttach` with
 * `waitForDebuggerOnStart` means the page is paused until the fingerprint script has been
 * installed, so a checker cannot win a race against injection.
 */

export interface SessionOptions {
  spawnBrowser?: typeof spawn;
  onToast?: (message: string, detail: string, nativeOnly?: boolean) => void;
}

/**
 * Joe Browser opens in Chromium's app window mode: a standalone, chrome-less window instead of a
 * tabbed browser. Its own start page is generated here so the window has a distinct identity and
 * the app's built-in tools are one click away. The page is local, so it works offline.
 */
function joeStartPage(startUrl: string): string {
  const file = Paths.storeFile('joe-start.html');
  const escape = (value: string): string => value.replace(/[&<>"']/g, (char) => (
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&#39;'
  ));
  const home = escape(startUrl || 'https://browsercan.net?utm_source=chatgpt.com');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Joe Browser</title>
<style>
:root{color-scheme:dark;--bg:#0e1014;--panel:#181c23;--line:#2a303b;--text:#eef1f6;--muted:#98a2b3;--accent:#4b86f0}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:'IBM Plex Sans',Segoe UI,system-ui,sans-serif;display:grid;place-items:center}
main{width:min(720px,90vw);padding:48px 0}.brand{display:flex;align-items:center;gap:12px;justify-content:center;margin-bottom:8px}.brand strong{font-size:26px;letter-spacing:-.02em}
p{color:var(--muted);text-align:center;margin:0 0 28px;font-size:14px}
form{display:flex;gap:8px;margin-bottom:24px}input{flex:1;min-width:0;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit;outline:none}
input:focus{border-color:var(--accent)}button{padding:12px 18px;border-radius:10px;border:0;background:var(--accent);color:#fff;font:600 14px 'IBM Plex Sans',Segoe UI,system-ui,sans-serif;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
a{display:block;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--text);text-decoration:none;transition:border-color .15s}
a:hover{border-color:var(--accent)}a b{display:block;font-size:14px}a span{display:block;color:var(--muted);font-size:12px;margin-top:4px}
footer{text-align:center;color:var(--muted);font-size:12px;margin-top:28px}
</style></head><body><main>
<div class="brand"><svg viewBox="0 0 64 64" width="38" height="38" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="10" fill="#2f6bde"/><path d="M43 15a21 21 0 1 0 6.4 5.3" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/><path d="M42 19v17.5a10 10 0 0 1-20 0" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/></svg><strong>Joe Browser</strong></div>
<p>Your space on the web.</p>
<form action="https://www.google.com/search" method="get"><input name="q" placeholder="Search the web" autofocus aria-label="Search"><button type="submit">Search</button></form>
<div class="grid">
<a href="${home}"><b>Start page</b><span>Open this profile's home</span></a>
<a href="https://browsercan.net?utm_source=chatgpt.com"><b>Fingerprint check</b><span>See what this identity reports</span></a>
<a href="https://iphey.com"><b>Connection check</b><span>See where this profile exits</span></a>
</div><footer>Paste as human · Proxy alerts · IP change notices are built in.</footer>
</main></body></html>`;
  Paths.ensure(Paths.root);
  fs.writeFileSync(file, html, 'utf8');
  return `file:///${file.replace(/\\/g, '/').replace(/ /g, '%20')}`;
}

export class BrowserSession extends EventEmitter {
  readonly profileId: string;
  readonly info: SessionInfo;

  private child: ChildProcess | null = null;
  private relay: RelayHandle | null = null;
  private cdp: CdpClient | null = null;
  private injectScript = '';
  private stamped = new Set<string>();
  private closing = false;
  private watchTimer: NodeJS.Timeout | null = null;
  private debugPort = 0;
  private dataDir: string;
  private ephemeralDir: string | null = null;
  private teardownTask: Promise<void> | null = null;
  private readonly options: SessionOptions;

  constructor(
    profile: Profile,
    exeFor: (profile: Profile) => Promise<{ exe: string; engine: string; version: string; runtimeVersion?: string }>,
    options: SessionOptions = {},
  ) {
    super();
    this.exeFor = exeFor;
    this.profileId = profile.id;
    this.options = options;
    this.dataDir = Paths.profileData(profile.id);
    this.info = {
      profileId: profile.id,
      profileName: profile.name,
      state: 'starting',
      debugPort: 0,
      pid: 0,
      engine: profile.engine,
      browserVersion: profile.browserVersion,
      startedAt: new Date().toISOString(),
      exitIp: '',
      lastError: '',
      proxyFellBack: false,
    };
  }

  private readonly exeFor: (profile: Profile) => Promise<{ exe: string; engine: string; version: string; runtimeVersion?: string }>;

  get running(): boolean {
    return this.child !== null && this.info.state !== 'stopped' && this.info.state !== 'failed';
  }

  async start(profile: Profile, startUrl?: string): Promise<SessionInfo> {
    const target = await this.exeFor(profile);
    if (this.closing) throw new Error('Profile launch was cancelled.');
    const engine = target.engine;
    const isFirefox = engine === 'firefox';

    const identity = buildIdentity(
      engine,
      target.runtimeVersion || target.version || profile.browserVersion,
      profile.fingerprint,
      profile.fingerprint.seed,
    );

    let proxyArg = '';
    if (proxyEnabled(profile.proxy)) {
      const password = proxyPasswordOf(profile);
      const relay = await startRelay(upstreamOf(profile.proxy, password));
      if (this.closing) {
        await relay.close();
        throw new Error('Profile launch was cancelled.');
      }
      this.relay = relay;
      proxyArg = `socks5://127.0.0.1:${this.relay.port}`;

      // Prove the proxy answers before the browser is pointed at it. A silent dead proxy shows
      // up later as "every site is broken", which is the least useful failure mode there is.
      try {
        // The probe must be closed again: an open tunnel left behind here is a socket that is
        // never read and never freed, and a profile opened and closed a few hundred times leaks
        // one handle each time.
        const probe = await openTunnel(upstreamOf(profile.proxy, password), 'ip-api.com', 80, 8000);
        probe.destroy();
        this.info.exitIp = '';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.closing) throw new Error('Profile launch was cancelled.');
        this.options.onToast?.(
          profile.proxy.fallbackDirect ? 'The proxy did not answer - the profile will open directly.' : 'The proxy did not answer.',
          message,
        );
        if (!profile.proxy.fallbackDirect) {
          // Record the failure first: teardown sets the state to "stopped" and emits it, so a
          // failure written afterwards is a state the window never sees.
          this.info.state = 'failed';
          this.info.lastError = message;
          this.emit('changed', this.info);
          await this.teardown();
          throw new Error(message);
        }
        await this.relay.close();
        this.relay = null;
        this.info.proxyFellBack = true;
        proxyArg = '';
      }
    }

    if (!isFirefox) {
      this.debugPort = await freePort();
      this.info.debugPort = this.debugPort;
    }

    if (this.closing) throw new Error('Profile launch was cancelled.');

    // The extensions are written on every launch, so a folder the user deleted comes back and a
    // store build that could not be fetched never leaves the tools missing.
    const settings = getSettings();
    const masterEnabled = settings.extensionsEnabled;
    if (!isFirefox && masterEnabled && settings.customExtensionsEnabled) {
      try { await ensureShipped(); }
      catch (error) {
        this.emit('notice', { kind: 'warn', message: 'Some default extensions could not be installed', detail: error instanceof Error ? error.message : String(error) });
      }
    }
    const extensions = isFirefox
      ? []
      : profileExtensionFolders(profile, masterEnabled, settings.customExtensionsEnabled);

    if (this.closing) throw new Error('Profile launch was cancelled.');
    Paths.ensure(Paths.profiles, Paths.logs);
    if (profile.freshSession) {
      this.ephemeralDir = fs.mkdtempSync(path.join(Paths.profiles, 'fresh-'));
      this.dataDir = this.ephemeralDir;
    } else {
      Paths.ensure(this.dataDir);
    }

    const args = isFirefox
      ? this.firefoxArgs(profile, proxyArg, startUrl)
      : this.chromiumArgs(profile, identity.userAgent, proxyArg, startUrl, extensions);

    if (isFirefox) {
      this.writeFirefoxPrefs(profile, identity.userAgent, proxyArg);
      // Remove only our obsolete sideloads; the built-in Chromium tool does not use extensions.
      for (const id of ['joe-paste-as-human@joebrowser.local', 'joe-right-click@joebrowser.local', 'joe-tracker-plus@joebrowser.local']) {
        try { fs.rmSync(path.join(this.dataDir, 'extensions', id), { recursive: true, force: true }); } catch { /* retry on the next launch */ }
      }
    }

    this.injectScript = buildFingerprintScript({
      fingerprint: profile.fingerprint,
      engine,
      browserVersion: target.runtimeVersion || target.version || profile.browserVersion,
      tools: profile.tools,
      countryCode: profile.proxy.lastCountryCode,
    });

    if (this.closing) throw new Error('Profile launch was cancelled.');
    const child = (this.options.spawnBrowser ?? spawn)(target.exe, args, {
      cwd: path.dirname(target.exe),
      detached: false,
      stdio: 'ignore',
      windowsHide: false,
      env: { ...process.env },
    });

    this.child = child;
    child.once('exit', (code, signal) => {
      if (!this.closing && this.info.state === 'starting') {
        this.info.state = 'failed';
        this.info.lastError = `Browser exited during startup (${signal ?? code}).`;
        this.emit('changed', this.info);
      }
      void this.teardown();
    });
    child.once('error', (error) => {
      this.info.state = 'failed';
      this.info.lastError = error.message;
      this.emit('changed', this.info);
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) void this.teardown();
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    // A successful OS spawn can still be an immediate browser startup failure.
    await delay(750);
    if (this.closing) throw new Error(this.info.lastError || 'Profile launch was cancelled.');
    log.info(`launched ${profile.name} with ${path.basename(target.exe)} ${this.info.browserVersion}`);
    this.info.pid = child.pid ?? 0;
    this.info.engine = engine;
    this.info.browserVersion = target.version || profile.browserVersion;
    this.info.state = 'running';
    this.emit('changed', this.info);

    this.startProxyWatch(profile);

    if (!isFirefox) {
      // Attach in the background: the window is already usable, and a profile must not take
      // ten seconds to open because a checker is slow to be stamped.
      void this.attachCDP(engine);
    }

    return this.info;
  }

  private chromiumArgs(
    profile: Profile,
    userAgent: string,
    proxyArg: string,
    startUrl?: string,
    extensions: string[] = [],
  ): string[] {
    const fp = profile.fingerprint;
    const args = [
      `--user-data-dir=${this.dataDir}`,
      `--remote-debugging-port=${this.debugPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-service-autorun',
      `--user-agent=${userAgent}`,
      `--lang=${fp.language}`,
      `--accept-lang=${fp.acceptLanguage}`,
      `--window-size=${Math.min(fp.screenW, 1600)},${Math.min(fp.screenH, 900)}`,
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-quic',
    ];

    if (proxyArg) {
      args.push(`--proxy-server=${proxyArg}`);
      args.push('--proxy-bypass-list=<-loopback>');
    }

    args.push(...loadArgs(extensions));

    const url = startUrl || profile.startUrl || 'about:blank';
    args.push(profile.engine === JOE_ENGINE ? `--app=${joeStartPage(url)}` : url);
    return args;
  }

  private firefoxArgs(profile: Profile, proxyArg: string, startUrl?: string): string[] {
    const args = ['-profile', this.dataDir, '-no-remote', '-new-instance'];
    void proxyArg;
    const url = startUrl || profile.startUrl || 'about:blank';
    args.push(url);
    return args;
  }

  /**
   * Firefox takes its identity from prefs, not from a command line and not from CDP. The proxy
   * password still never appears here: the relay is spoken to over SOCKS5 on loopback.
   */
  private writeFirefoxPrefs(profile: Profile, userAgent: string, proxyArg: string): void {
    const fp = profile.fingerprint;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const prefsFile = path.join(this.dataDir, 'user.js');

    const lines = [
      '// Written by Joe Browser on every launch; edits here are replaced.',
      `user_pref("general.useragent.override", ${JSON.stringify(userAgent)});`,
      `user_pref("intl.accept_languages", ${JSON.stringify(fp.language)});`,
      `user_pref("javascript.use_us_english_locale", true);`,
      `user_pref("privacy.resistFingerprinting", false);`,
      `user_pref("webgl.disabled", false);`,
      `user_pref("dom.webdriver.enabled", false);`,
      `user_pref("useAutomationExtension", false);`,
      `user_pref("toolkit.telemetry.enabled", false);`,
      `user_pref("datareporting.policy.dataSubmissionEnabled", false);`,
    ];

    if (proxyArg) {
      const port = Number(proxyArg.split(':').pop());
      lines.push(
        'user_pref("network.proxy.type", 1);',
        'user_pref("network.proxy.socks", "127.0.0.1");',
        `user_pref("network.proxy.socks_port", ${port});`,
        'user_pref("network.proxy.socks_version", 5);',
        'user_pref("network.proxy.socks_remote_dns", true);',
      );
    } else {
      lines.push('user_pref("network.proxy.type", 0);');
    }

    if (fp.timezone) {
      // Firefox honours a per-profile timezone only through this pref pair.
      lines.push(
        'user_pref("privacy.resistFingerprinting.autoDeclineNoUserInputCanvasPrompts", true);',
        `user_pref("joe.timezone", ${JSON.stringify(fp.timezone)});`,
      );
    }

    fs.writeFileSync(prefsFile, lines.join('\n'), 'utf8');
  }

  private async attachCDP(engine: string): Promise<void> {
    try {
      const connection = await CdpClient.connect(this.debugPort, 30000);
      if (this.closing) { connection.close(); return; }
      this.cdp = connection;
      const autoAttached = new Set<string>();

      // Every document request in this profile is one history entry. Network.requestWillBeSent
      // fires before the request leaves, so a navigation that is later blocked still appears.
      this.cdp.on('Network.requestWillBeSent', (params) => {
        const type = String(params['type'] ?? '');
        const request = params['request'] as { url?: string } | undefined;
        if (type === 'Document' && request?.url) {
          const redirect = params['redirectResponse'] as { url?: string } | undefined;
          if (redirect?.url) history.markRedirect(this.profileId, redirect.url);
          history.record(this.profileId, request.url);
        }
      });
      this.cdp.on('Page.navigatedWithinDocument', (params) => {
        if (typeof params['url'] === 'string') history.record(this.profileId, params['url']);
      });
      this.cdp.on('Target.targetInfoChanged', (params) => {
        const target = params['targetInfo'] as { type?: string; url?: string; title?: string } | undefined;
        if (target?.type === 'page' && target.url && target.title) history.attachTitle(this.profileId, target.url, target.title);
      });

      this.cdp.on('Target.attachedToTarget', (params, _sessionId) => {
        const sessionId = String(params['sessionId'] ?? '');
        const targetInfo = (params['targetInfo'] as { type?: string; targetId?: string } | undefined) ?? {};
        if (targetInfo.targetId) autoAttached.add(targetInfo.targetId);
        void this.stampTarget(sessionId, targetInfo.type ?? 'page', engine);
      });

      // Pause every new target until it has been stamped.
      await this.cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined);
      await this.cdp.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'page' }, { type: 'iframe' }, { type: 'worker' }],
      });

      // Targets that existed before auto-attach was switched on still need the script.
      const existing = await this.cdp
        .send<{ targetInfos?: { targetId: string; type: string }[] }>('Target.getTargets')
        .catch(() => ({ targetInfos: [] }));

      for (const target of existing.targetInfos ?? []) {
        if (target.type !== 'page' || autoAttached.has(target.targetId)) continue;
        try {
          const attached = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
            targetId: target.targetId,
            flatten: true,
          });
          await this.stampTarget(attached.sessionId, 'page', engine);
        } catch {
          /* a target that closed between listing and attaching is not an error */
        }
      }

      this.info.state = 'running';
      this.emit('changed', this.info);
    } catch (error) {
      this.info.lastError = error instanceof Error ? error.message : String(error);
      // The browser is open and usable; it is simply not stamped. Say so rather than pretend.
      this.options.onToast?.(
        'The profile opened, but its fingerprint could not be applied.',
        this.info.lastError,
      );
    }
  }

  private async stampTarget(sessionId: string, type: string, engine: string): Promise<void> {
    if (!this.cdp || !sessionId) return;
    if (this.stamped.has(sessionId)) return;
    this.stamped.add(sessionId);

    const isWorker = type === 'worker' || type === 'service_worker';

    try {
      if (!isWorker) {
        await this.cdp.send('Page.enable', {}, sessionId).catch(() => undefined);
        // Network is needed for the history capture; a target that refuses it simply has no
        // history, which is honest and does not stop the stamping below.
        await this.cdp.send('Network.enable', {}, sessionId).catch(() => undefined);
        await this.cdp.send('Runtime.enable', {}, sessionId).catch(() => undefined);
        // The identifier is deliberately not stored: a live re-apply would need it, but each
        // target is stamped exactly once (see `stamped`), so there is nothing to replace.
        await this.cdp.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: this.injectScript, runImmediately: true },
          sessionId,
        );
      } else {
        /* A worker has no Page domain, so the script cannot be installed "on new document".
           What works is running it at the top of the worker: auto-attach pauses the worker
           before its first line, so an evaluate here lands before any page script can read
           navigator inside it. The injected source is written against `window`, so the worker
           gets a `self` binding for the two globals it actually needs. */
        await this.cdp.send('Runtime.enable', {}, sessionId).catch(() => undefined);
        const workerScript =
          'var window = self; var document = undefined; try {\n' + this.injectScript + '\n} catch (e) {}';
        await this.cdp.send('Runtime.evaluate', { expression: workerScript, awaitPromise: false }, sessionId).catch(() => undefined);
      }
      void engine;
    } catch {
      /* a target that refuses the script is reported by the checker, not by the launcher */
    } finally {
      // Release the target even if stamping failed, or the window stays blank forever.
      await this.cdp
        .send('Runtime.runIfWaitingForDebugger', {}, sessionId)
        .catch(() => undefined);
    }
  }

  /**
   * Watches the address the world sees this profile from.
   *
   * A rotating proxy is how a session is kept alive, and it is also the moment two sessions can
   * be matched to one account. The app asks the proxy who it is on the profile's own interval and
   * says so when the answer changes. A proxy that stops answering is reported only after two
   * failures in a row: one missed request is a hiccup, and an alert that cries wolf is an alert
   * nobody reads.
   */
  private startProxyWatch(profile: Profile): void {
    if (!profile.tools.proxyWatch || !proxyEnabled(profile.proxy) || this.info.proxyFellBack) return;

    const intervalMs = Math.min(600, Math.max(30, profile.tools.proxyWatchInterval)) * 1000;
    const password = proxyPasswordOf(profile);
    const config = profile.proxy;
    let busy = false;
    const state = new ProxyWatchState(profile.name);
    const failure = (detail: string) => {
      const notice = state.failure(detail);
      if (notice && !this.closing) this.emit('notice', notice);
    };
    this.watchTimer = setInterval(() => {
      if (busy || this.closing) return;
      busy = true;
      void testProxy(config, password, 15000).then((result) => {
        if (this.closing) return;
        if (!result.ok) { failure(result.error); return; }
        for (const notice of state.success(result.ip, result.city || result.country)) this.emit('notice', notice);
        this.info.exitIp = result.ip;
      }).catch((error: unknown) => {
        failure(error instanceof Error ? error.message : String(error));
      }).finally(() => { busy = false; });
    }, intervalMs);

    // A timer must never be the reason the app cannot quit.
    this.watchTimer.unref?.();
  }

  /**
   * Re-point a live session at a different upstream.
   *
   * Only a session that already goes through a relay can be re-pointed: the browser's own
   * --proxy-server was fixed at spawn time, so a profile that opened directly cannot start using
   * a proxy without being reopened. Returning false says that rather than pretending.
   */
  repointProxy(upstream: Upstream): boolean {
    if (!this.relay) return false;
    this.relay.setUpstream(upstream);
    return true;
  }

  /** Open a page inside this profile, so a checker sees the fingerprint under test. */
  async openUrl(url: string): Promise<void> {
    if (!this.cdp) throw new Error('This profile is not reachable over DevTools yet.');
    if (!/^https:\/\//i.test(url)) throw new Error('Only https addresses can be opened.');
    await this.cdp.send('Target.createTarget', { url });
  }

  async clearStorage(scope: 'cache' | 'cookies' | 'siteData'): Promise<boolean> {
    if (!this.cdp) return false;
    // CDP has no browser-wide "clear all site data" command: clearing the current
    // origin would leave other origins behind. Ask the user to close the profile instead.
    if (scope === 'siteData') return false;
    try {
      const page = await this.primaryPageSession();
      await this.cdp.send(scope === 'cache' ? 'Network.clearBrowserCache' : 'Network.clearBrowserCookies', {}, page);
      return true;
    } catch {
      return false;
    }
  }

  /** Evaluate an expression in the profile's own session, as the original's EvaluateAsync did. */
  async evaluate(expression: string): Promise<string> {
    if (!this.cdp) throw new Error('This profile is not reachable over DevTools yet.');
    const page = await this.primaryPageSession();
    const result = await this.cdp.send<{ result?: { value?: unknown; description?: string } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      page,
    );
    const value = result.result?.value;
    if (value === undefined) return result.result?.description ?? '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  /** Type into the focused element of the active page. */
  async typeText(text: string): Promise<void> {
    if (!this.cdp) throw new Error('This profile is not reachable over DevTools yet.');
    const page = await this.primaryPageSession();
    for (const character of text) {
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'char', text: character }, page);
      await delay(12 + Math.floor(Math.random() * 40));
    }
  }

  /** Navigate the active tab rather than opening a new one. */
  async navigate(url: string): Promise<void> {
    if (!this.cdp) throw new Error('This profile is not reachable over DevTools yet.');
    const page = await this.primaryPageSession();
    await this.cdp.send('Page.navigate', { url }, page);
  }

  /** A PNG screenshot of the active tab, base64 encoded. */
  async screenshot(): Promise<string> {
    if (!this.cdp) throw new Error('This profile is not reachable over DevTools yet.');
    const page = await this.primaryPageSession();
    const shot = await this.cdp.send<{ data?: string }>('Page.captureScreenshot', { format: 'png' }, page);
    return shot.data ?? '';
  }

  /** Bring the browser's own window to the front. */
  focus(): void {
    if (!this.cdp) return;
    void this.cdp.send('Target.activateTarget', { targetId: this.lastTargetId }).catch(() => undefined);
  }

  private lastTargetId = '';
  private pageSession = '';

  /** The session id of the first page target, attached on demand. */
  private async primaryPageSession(): Promise<string> {
    if (this.pageSession) return this.pageSession;
    if (!this.cdp) throw new Error('This profile is not reachable over DevTools yet.');

    const targets = await this.cdp.send<{ targetInfos?: { targetId: string; type: string }[] }>('Target.getTargets');
    const page = (targets.targetInfos ?? []).find((t) => t.type === 'page');
    if (!page) throw new Error('The profile has no page open yet. Open a tab and try again.');

    const attached = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    });
    this.lastTargetId = page.targetId;
    this.pageSession = attached.sessionId;
    await this.cdp.send('Page.enable', {}, this.pageSession).catch(() => undefined);
    await this.cdp.send('Runtime.enable', {}, this.pageSession).catch(() => undefined);
    await this.cdp.send('Network.enable', {}, this.pageSession).catch(() => undefined);
    this.stamped.add(this.pageSession);
    return this.pageSession;
  }

  /**
   * Export every cookie the profile holds, in a shape the original's cookie manager used and
   * a cookie editor can read.
   */
  async exportCookies(): Promise<CookieRecord[]> {
    if (!this.cdp) throw new Error('This profile is not reachable over DevTools yet.');
    const page = await this.primaryPageSession();
    const response = await this.cdp.send<{ cookies?: CookieRecord[] }>('Network.getAllCookies', {}, page);
    return response.cookies ?? [];
  }

  /** Write cookies back into the profile's own session. */
  async importCookies(cookies: CookieRecord[]): Promise<number> {
    if (!this.cdp) throw new Error('This profile is not reachable over DevTools yet.');
    const page = await this.primaryPageSession();
    let written = 0;
    for (const cookie of cookies) {
      try {
        const params: Record<string, unknown> = {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          secure: Boolean(cookie.secure),
          httpOnly: Boolean(cookie.httpOnly),
        };
        if (cookie.expires && cookie.expires > 0) params['expires'] = cookie.expires;
        if (cookie.sameSite && ['Strict', 'Lax', 'None'].includes(cookie.sameSite)) params['sameSite'] = cookie.sameSite;
        const result = await this.cdp.send<{ success: boolean }>('Network.setCookie', params, page);
        if (result.success) written++;
      } catch {
        /* a cookie the browser refuses is skipped, not fatal for the rest */
      }
    }
    return written;
  }

  /**
   * Read the live fingerprint out of the running page. This is the difference between the
   * original's audit and a claim-vs-claim table: every value here is what a site actually sees.
   */
  async liveProbe(): Promise<Record<string, unknown>> {
    const script = `(() => {
      const out = {};
      const nav = navigator;
      out.userAgent = nav.userAgent;
      out.platform = nav.platform || '';
      out.language = nav.language || '';
      out.languages = Array.from(nav.languages || []);
      out.cores = nav.hardwareConcurrency || 0;
      out.memory = nav.deviceMemory || 0;
      out.maxTouchPoints = nav.maxTouchPoints || 0;
      out.plugins = nav.plugins ? nav.plugins.length : 0;
      out.vendor = nav.vendor || '';
      out.productSub = nav.productSub || '';
      out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      out.offsetMinutes = new Date().getTimezoneOffset();
      out.screen = { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth };
      out.pixelRatio = window.devicePixelRatio || 1;
      out.innerWidth = window.innerWidth;
      out.outerWidth = window.outerWidth;
      try {
        const gl = document.createElement('canvas').getContext('webgl');
        const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
        out.webglVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : (gl ? gl.getParameter(gl.VENDOR) : '');
        out.webglRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : '');
      } catch (e) { out.webglVendor = ''; out.webglRenderer = ''; }
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 220; canvas.height = 40;
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillStyle = '#f60';
        ctx.fillRect(0, 0, 220, 40);
        ctx.fillStyle = '#069';
        ctx.fillText('Joe Browser fingerprint', 2, 4);
        out.canvasHash = String(canvas.toDataURL().length) + ':' + canvas.toDataURL().slice(-32);
      } catch (e) { out.canvasHash = ''; }
      try {
        const uaData = nav.userAgentData;
        out.brands = uaData && uaData.brands ? uaData.brands : [];
        out.mobile = uaData ? uaData.mobile : false;
      } catch (e) { out.brands = []; }
      out.webdriver = nav.webdriver === true;
      const automation = [];
      for (const key in window) if (key.indexOf('cdc_') === 0 || key.indexOf('$cdc_') === 0) automation.push(key);
      out.automationKeys = automation;
      out.chrome = typeof window.chrome === 'object' && window.chrome !== null;
      out.notificationPermission = (typeof Notification !== 'undefined') ? Notification.permission : '';
      try {
        const geo = nav.geolocation;
        out.hasGeolocation = Boolean(geo);
      } catch (e) { out.hasGeolocation = false; }
      return JSON.stringify(out);
    })()`;
    const raw = await this.evaluate(script);
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error('The page did not return a readable fingerprint.');
    }
  }

  async stop(): Promise<void> {
    this.closing = true;
    if (this.teardownTask) return this.teardownTask;
    this.info.state = 'closing';
    this.emit('changed', this.info);

    try {
      if (this.cdp) {
        await this.cdp.send('Browser.close').catch(() => undefined);
      }
    } catch {
      /* the socket is often already gone by the time close is called */
    }

    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = () => child.exitCode !== null || child.signalCode !== null;
      const wait = async (ms: number) => {
        const deadline = Date.now() + ms;
        while (!exited() && Date.now() < deadline) await delay(100);
      };
      if (this.cdp) await wait(4000);
      if (!exited()) child.kill();
      await wait(2000);
      if (!exited()) child.kill('SIGKILL');
      await wait(2000);
      if (!exited()) throw new Error('Browser is still running; its profile data was not cleared.');
    }

    await this.teardown();
  }

  private teardown(): Promise<void> {
    return this.teardownTask ??= this.releaseResources();
  }

  private async releaseResources(): Promise<void> {
    this.closing = true;

    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }

    this.cdp?.close();
    this.cdp = null;
    this.stamped.clear();

    if (this.relay) {
      await this.relay.close().catch(() => undefined);
      this.relay = null;
    }

    if (this.ephemeralDir) {
      try { fs.rmSync(this.ephemeralDir, { recursive: true, force: true, maxRetries: 3 }); }
      catch { this.emit('notice', { kind: 'warn', message: 'Fresh session data could not be removed', detail: this.ephemeralDir }); }
      this.ephemeralDir = null;
    }
    this.child = null;
    this.info.state = 'stopped';
    this.emit('changed', this.info);
    this.emit('closed', this.profileId);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a debugging port.'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * The session registry: at most one session per profile, and a session that exits on its own
 * is removed rather than left as a ghost row.
 */
export class SessionManager {
  private sessions = new Map<string, BrowserSession>();
  readonly events = new EventEmitter();

  constructor(private readonly options: SessionOptions = {}) {}

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  get(profileId: string): BrowserSession | undefined {
    return this.sessions.get(profileId);
  }

  isRunning(profileId: string): boolean {
    return this.sessions.has(profileId);
  }

  async launch(profile: Profile, startUrl?: string): Promise<SessionInfo> {
    if (this.sessions.has(profile.id)) {
      const existing = this.sessions.get(profile.id)!;
      existing.emit('changed', existing.info);
      return existing.info;
    }

    const session = new BrowserSession(profile, resolveExecutable, this.options);
    this.sessions.set(profile.id, session);

    session.on('changed', (info: SessionInfo) => this.events.emit('changed', info));
    session.on('notice', (notice: { kind: string; message: string; detail: string }) => {
      this.events.emit('notice', notice);
      this.options.onToast?.(notice.message, notice.detail, true);
    });
    session.on('closed', (profileId: string) => {
      if (this.sessions.get(profileId) === session) this.sessions.delete(profileId);
      this.events.emit('closed', profileId);
    });

    try {
      return await session.start(profile, startUrl);
    } catch (error) {
      await session.stop();
      throw error;
    }
  }

  async stop(profileId: string): Promise<void> {
    const session = this.sessions.get(profileId);
    if (!session) return;
    await session.stop();
    if (this.sessions.get(profileId) === session) this.sessions.delete(profileId);
  }

  async stopAll(): Promise<void> {
    const outcomes = await Promise.allSettled([...this.sessions.values()].map((s) => s.stop()));
    const failure = outcomes.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  sessionFor(profileId: string): BrowserSession | undefined {
    return this.sessions.get(profileId);
  }

  /** Swap a running profile's upstream without closing its tabs. */
  async setProxy(profile: Profile, password?: string): Promise<boolean> {
    const session = this.sessions.get(profile.id);
    if (!session) return false;
    const credential = password ?? proxyPasswordOf(profile);
    return session.repointProxy(upstreamOf(profile.proxy, credential));
  }
}

/** App-managed runtimes are provisioned on first launch; local browsers are never substituted. */
async function resolveExecutable(profile: Profile): Promise<{ exe: string; engine: string; version: string; runtimeVersion?: string }> {
  return resolveManagedRuntime(profile);
}
