<img src="assets/logo-mark.svg" width="72" alt="Joe Browser logo">

# Joe Browser

**A local-first anti-detect browser workspace for Windows.**
Unlimited isolated profiles, a per-profile proxy, a coherent fingerprint for every profile,
and pinned browser builds. Nothing leaves your PC.

**[Download JoeBrowserSetup.exe](../../releases/latest/download/JoeBrowserSetup.exe)**
· [All releases](../../releases)

Windows 10 or 11, 64-bit. **Choose JoeBrowserSetup.exe for installation.** The setup wizard
shows the license, lets you choose just this user or all users, select the destination folder,
create shortcuts, and optionally launch the app when finished. All-users installation requests
Windows administrator permission (UAC); a just-for-me installation normally needs no elevation.
The application itself runs without administrator rights.

Windows releases are installer-only. If an older download named `JoeBrowser.exe` opens the app
directly, it is the legacy portable build. Download `JoeBrowserSetup.exe` above instead;
existing portable downloads cannot be converted into installers by updating this repository.
The app runs with or without a Joe Browser account - the free plan keeps one profile, and a 7-day
trial or license key lifts the ceiling. An account is free to create and exists only for
licensing; profile data itself stays on this PC.
User data remains in `%APPDATA%\JoeBrowser`, independently of the installation folder.
Uninstall from Windows Settings → Apps; workspace data is preserved.

---

## What it does

| | |
|---|---|
| **Isolated profiles** | Every profile is its own browser with its own cookies, storage, logins and cache, in its own `--user-data-dir`. Trial and premium plans are unlimited; the free plan keeps one. |
| **A real identity per profile** | User agent and client hints, platform, language, screen, timezone, memory, cores, WebGL, canvas and audio noise, and a WebRTC guard. Locale, clock and proxy country are kept in agreement. |
| **No two profiles alike** | A new identity is compared against every profile you already have across twelve surfaces and re-rolled until it is unique. |
| **Real browser builds** | Chromium, Chrome and Firefox are fetched from the vendors' own release channels, installed side by side, pinnable to a profile, and removable. Chrome reaches back eight majors. |
| **Nothing downloads itself** | A build is fetched the first time something needs it. Opening the application never starts a download. |
| **Managed browser launches** | Profiles launch app-managed builds only; they never silently substitute a browser installed on the PC. The available download catalog remains limited and requires further verification. |
| **Proxies** | HTTP, HTTPS and SOCKS5 with authentication. Credentials are applied by a local relay, so a password never appears in a browser command line. |
| **Fingerprint check** | A surface-by-surface comparison of what the profile claims against what a page will observe, plus one click to the six checker sites inside the profile's own session. |
| **History per profile** | Every page a profile visits, recorded in its own file and invisible to every other profile. Clearable. |
| **Proxy watch** | The exit address is checked on the profile's interval; a rotation, a proxy that stopped answering and a proxy that came back are all reported. A running profile can be re-pointed without closing its tabs. |
| **An account, or no account at all** | Sign in or create a Joe Browser account for licensing (7-day trial), or continue without one - either way you can work. A separate local identity, stored as a salted PBKDF2 hash, adds an optional PIN and authenticator code for when you leave the desk; the window locks after the idle interval you set. |
| **Subscription management** | Your plan, its validity date, license-key activation (monthly, yearly, trial or custom length) and sign-out are all in Settings → Subscription; the current tier rides along in the title bar. |
| **Workspace audit and repair** | Every pair of profiles is compared across twelve surfaces, plus shared exit addresses and shared builds. "Fix what can be fixed" re-rolls the newer duplicates, oldest identity kept. |
| **Batch create** | Up to 200 at once, a group, a proxy per line, and a distinct identity and build for every one - not 200 copies of the same machine. |
| **Cookie manager** | Export a profile's cookies and import them into another, over the browser's own debugging protocol. |
| **15 languages** | English is complete; each other table shows the share of the interface it covers, and anything missing falls back to English rather than to a key. |
| **Built to be read** | A real layout system, two themes, a navigation rail that collapses, and a window that works at every width. |
| **Private by default** | Profile data stays in `%APPDATA%\JoeBrowser`. Proxy passwords are encrypted with Windows DPAPI. No telemetry, no profile sync, no browsing history leaves this PC. The only host the app contacts is the licensing service for account sign-in and subscription state. |

## Where your data lives

```
%APPDATA%\JoeBrowser\
  Profiles.json      profile records (proxy passwords are ciphertext)
  Settings.json      window theme and defaults
  key.bin            fallback encryption key, owner-only (DPAPI is used when available)
  accounts.json      local accounts and lock settings, encrypted as a whole
  session.json       who is signed in - identity only, never a credential
  profiles\<id>\     one Chromium/Firefox user-data-dir per profile
  kernels\<id>\      browsers downloaded by the app
```

To reset workspace data, back up and then remove that folder. To uninstall the application, use Windows Settings → Apps.

## How the fingerprint works, and its limits

The identity is injected through the DevTools Protocol with
`Page.addScriptToEvaluateOnNewDocument`, so it runs before the page's first line of script. Every
override is installed on a prototype accessor, the originals are captured in a closure, and
patched functions still stringify as `[native code]`.

Two honest limits. First, this is a browser built out of the browser you have: it changes what
the page can observe from JavaScript, not the C++ under it. A checker that fingerprints at the
network or TLS layer sees what it always saw. Second, a *coherent* identity is worth more than a
*random* one. A profile that claims a 4-core Windows 11 machine with 32 GB of RAM and a
timezone that disagrees with its exit IP is worse than an honest default, which is why the app
draws every field from pools that occur together and re-rolls collisions.

The test suite asserts the three properties that matter: determinism, uniqueness, coherence.

## Getting started

1. Install with `JoeBrowserSetup.exe`.
2. **New profile** — a name is all that is asked for; the identity is generated.
3. Open **Edit → Proxy** and add the proxy. Test it; the clock and language follow its country.
4. **Open profile.** On first launch, the app downloads an app-managed stable runtime (internet
   access and disk space required). Subsequent launches reuse it with the profile's own storage.
   Local browser installations are never substituted. Edge and Windows Firefox provisioning
   are not yet supported. Joe currently uses Chrome for Testing, not a custom-patched engine.

See [AUDIT.md](AUDIT.md) for confirmed fixes, security findings, and release-blocking gaps.

## Windows may show a warning the first time

The binaries are not code-signed. SmartScreen will say "Windows protected your PC" on first run.
Choose **More info**, then **Run anyway**. Code signing needs a certificate purchased from a CA;
everything else about the build is unaffected.

## Building it yourself

```powershell
npm ci
npm run typecheck
npm test
npm run build
npx electron-builder --win --x64
```

The distributable output is `release\JoeBrowserSetup.exe`. Do not distribute the executable
inside `release\win-unpacked`; it is the application payload, not the installer.

`scripts\release.ps1` runs all of that with the verification the CI job does, and publishes when
asked:

```powershell
.\scripts\release.ps1                    # build and verify
.\scripts\release.ps1 -Publish          # build, verify, tag, release
```

### What the checks cover

| Check | What it proves |
|---|---|
| `npm run typecheck` | Both projects compile with `noUnusedLocals`, so no dead code is hiding a mistake |
| `npm test` → core (31) | A seed rebuilds the same machine; a new profile differs from every stored one across twelve surfaces; clock and locale follow the proxy; the injected script parses as JavaScript; a proxy password never reaches the store in the clear; PBKDF2 and TOTP round-trip against the published vector; a corrupt account file is preserved instead of overwritten; the whole lock lifecycle holds from first registration to sign-out |
| `npm test` → ui (14) | Every page and dialog mounts in a real DOM, an empty store shows its empty state, and every control has an accessible name. Any React warning fails the run |
| `npm test` → contract (12) | Every bridge method has a preload entry and a mock, every channel the preload invokes has a handler, every translation key a page uses exists, no renderer calls a browser dialog Electron does not implement, every language table keeps its closing brace, and the release workflow runs its gates before it packages and derives its tag from `package.json` |
| `npm run build` | The bundles produce; the main process carries no unresolved import; the tray icon is embedded rather than read from a path that packaging might not ship |
| `electron-builder` | Both binaries exist, are a plausible size, and carry a Windows version resource |

### The release pipeline

`.github/workflows/release.yml` builds both binaries on a Windows runner and attaches them to a
release. It is dispatched by hand, because a release is a decision rather than a side effect of a
push:

```
Actions -> Build EXE -> Run workflow
```

The tag comes from `package.json` unless one is given, so a new version is released by bumping the
version and running the workflow. Typecheck, the whole test suite and a production build all have
to pass before anything is packaged, and the run fails if either binary is missing rather than
publishing a release with no assets. See [RELEASE.md](RELEASE.md) for the full process.

For design work without Electron:

```powershell
npm run dev:web
```

That serves the renderer against a mock bridge in a plain browser — the UI without the machine.

## Architecture

```
src/main/          the Electron main process
  core/fingerprint.ts   the identity factory and the twelve-surface uniqueness check
  core/ua.ts            user agent, client hints and brands, derived from one triple
  core/inject.ts        the script that runs before the page
  core/launcher.ts      resolving, spawning, and stamping every target over CDP
  core/cdp.ts           a small DevTools Protocol client
  core/relay.ts         the local SOCKS5/HTTP relay that holds the proxy password
  core/catalog.ts       vendor release channels, install and removal
  core/store.ts         the profile store
  core/humanPaste.ts    Chromium context-menu paste extension
  core/history.ts       per-profile history, one JSONL file each
src/preload/       the only bridge between the UI and the machine
src/renderer/      the React UI
src/shared/        the contract both sides agree on
test/              the properties the identity engine must hold
```

## Licence

Proprietary. See [LICENSE](LICENSE).
