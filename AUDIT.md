# Application audit — first remediation pass

Date: 2026-11-18. **Status: incomplete; not approved for production release.**
This is a source review and automated-test record, not a penetration-test certification or a
claim of parity with GoLogin, AdsPower, or Dolphin Anty. Existing installer-only changes on
this branch are retained. No new release or binary has been published.

## Architecture and scope examined

Electron main owns file storage, browser downloads, launch/session management, local proxy
relays, extension installation, accounts and IPC. The sandboxed renderer calls the preload
bridge. Profile definitions are JSON in the workspace; browser cookies/local storage live in
separate profile directories. The desktop application is not itself a patched browser engine.

This pass traced catalog → profile creation/storage → IPC launch → runtime resolution → child
process → CDP → cookie operations, and reviewed extension selection, packaging and dependency
advisories. Existing tests also exercise proxies, account primitives, UI mounting, history,
CRX validation and bridge contracts. Passing tests do not establish end-to-end correctness.
The entire codebase and deployed licensing backend have **not** been exhaustively audited.

## Confirmed defects addressed

| Finding | Change / evidence |
|---|---|
| First launch requires a separately installed managed runtime, but never installs it | New runtime resolver provisions a stable vendor build on demand; installed builds resolve without a network lookup |
| Concurrent fresh profile launches can request the same runtime | Resolver shares an in-flight installation by build ID; failed downloads can be retried |
| Joe catalog depends on a stable `chromium` product absent from normal Chrome for Testing data | Derive Joe entries from stable Chrome entries, handle channel case, invalidate old cache |
| OS spawn failures still return a successful launch | Wait for `spawn`; propagate `error`; clean up manager resources on startup errors |
| Stop during a download can still launch the browser later | Check cancellation after runtime resolution and before spawning |
| An old session's close handler can remove a newer session | Registry removal checks session identity |
| Failed launches increment open count | Update metadata only after successful launch; don't count an already-running session again |
| Changing an engine can preserve an incompatible implicit build pin | Clear the old pin when engine changes without an explicit new pin |
| Unpinned running browsers can have their runtime removed | Prevent removal while a starting/running profile uses that engine (conservative guard) |
| Installer accepts existing invalid runtime metadata | Reuse only matching metadata with a resolvable executable |
| Automatic provisioning could bypass disk checks | Check estimated extraction space in the shared installer |
| Browser credential-storage flags force basic/mock backends | Remove these flags; retain OS-native defaults |
| Wildcard DevTools origin allowance | Remove wildcard, explicitly request loopback debugging; local CDP is still a privileged interface |
| Cookie imports discard SameSite and count `success:false` | Preserve supported SameSite values and count only accepted cookies |
| Extension recommendations have empty explanations | Add purpose/category and risk descriptions, optional MV3 uBlock Origin Lite recommendation, restart/compatibility notice |
| Chromium extension folders can be selected for Firefox through library API | Explicitly return no folders for Firefox |
| BrowserLeaks absent from test-site shortcuts | Add BrowserLeaks; no results or scores are fabricated |

New regression tests cover resolver selection/reuse/concurrency/retry/pinning, Joe catalog
mapping, missing executable, cancellation, cookie acceptance/SameSite and extension metadata.

## Browser delivery requirements: actual status

| Requested browser | Current implementation | Gap |
|---|---|---|
| Google Chrome | Managed Chrome for Testing archive, profile-specific data directory | Not bundled offline; first launch needs vendor access; no independent checksum supplied by this catalog |
| Brave | Managed Windows x64 vendor archive, GitHub SHA-256 metadata required | Needs real Windows download/launch testing; GitHub API availability/rate limits apply |
| Edge | No managed download source | Dedicated extraction, authenticity verification, redistribution review and launch tests required |
| Firefox | Linux catalog only; separate prefs/profile path | Windows source/extractor missing; no CDP feature parity, extension support or effective per-profile timezone implementation |
| Joe | Branded wrapper using a managed Chrome for Testing runtime | Not a custom-built/patched browser; needs a separately maintained engine/build/signing pipeline to become one |

None of these archives is embedded into the installer. This patch adds **managed first-run
downloads**, not the requested full offline browser distribution. Vendor redistribution terms
and update/authenticity policies need explicit review before bundling branded browsers.

## Remaining release blockers and high-priority investigations

1. **Fingerprint coverage:** startup navigation currently precedes asynchronous CDP attachment.
   Initial page scripts can run before overrides. Injection errors are sometimes suppressed.
   Network client hints, workers, out-of-process frames, WebGL capabilities, fonts, canvas,
   audio and native rendering cannot be proven consistent by overriding JS properties.
   Do not advertise undetectability, independent physical devices or guaranteed checker passes.
2. **Firefox timezone:** `joe.timezone` is a custom preference, not an effective implementation.
   Firefox also lacks the cookie/history/diagnostic functionality based on Chromium CDP.
3. **Fresh session:** temporary storage and post-exit cleanup are implemented in the follow-up.
   Windows lock handling and cleanup after abrupt manager termination still need verification.
4. **Process lifecycle:** OS spawn success does not prove browser health/CDP readiness. Retain
   browser stderr safely, detect immediate exits, test graceful shutdown/forced termination,
   multi-window sessions and crashes. Cancellation does not currently abort a shared download.
5. **Dependencies:** `npm audit --omit=dev` reports 0 known advisories. Full `npm audit` reports
   20 (1 critical, 14 high, 5 moderate), including direct Electron, electron-builder, Vite and
   esbuild dependencies. Electron is classified as a dev dependency but ships at runtime;
   production-only audit is insufficient. Upgrade compatible supported versions and retest
   packaging/renderer/IPC before release. Do not apply blind forced major upgrades.
6. **Supply chain:** browser catalog trust is HTTPS-based except Brave's supplied digest.
   Add authenticated vendor manifests where available, archive traversal/link/size checks,
   extraction timeouts, update policies and stale-build warnings. Disk-space estimates are
   conservative, not a guarantee; the temporary volume needs separate checking.
7. **Extension behavior:** library state is global and applies after reopening. Compatibility
   by engine/version/manifest is not fully modeled. Store package authenticity tests do not
   prove an extension safe. Recommended extensions are optional, not silently integrated code.
8. **Storage and security:** exercise disk-full, abrupt power loss, concurrent app instances,
   malicious imports/IPC payloads, log redaction and workspace permissions. JSON storage is not
   a transactional database. Isolated folders do not protect against malware on the same OS user.
9. **Licensing/account backend:** no deployed Supabase policies, functions or authorization flows
   were changed or certified in this pass. Review separately with test accounts, not production data.
10. **Platform/UI:** real Windows profile CRUD, restart persistence, proxy authentication, engine
    downloads, cookies/storage isolation, extension toggles/removal, upgrade and installer UI
    still require validation on clean Windows 10/11 VMs. Automated DOM tests are not that proof.

## Open-source research and integration decisions

Inspected GitHub metadata, licenses and selected README/source on the audit date:

- [Playwright](https://github.com/microsoft/playwright), Apache-2.0, active (push 2026-11-18).
  Reviewed `packages/playwright-core/src/server/browserType.ts`: persistent data-directory and
  process-lifecycle separation is a useful reference. `playwright-core` is already used by this
  repository's smoke tests; keep it as testing infrastructure, not a new stealth dependency.
  This pass applies explicit spawn/cancellation handling in original application code.
- [Apify fingerprint-suite](https://github.com/apify/fingerprint-suite), Apache-2.0, active
  (push 2026-11-17). README separates header generation, statistical fingerprints and injection.
  Potential research/test reference, not integrated: a second injector risks conflicting with
  existing overrides and is not a substitute for engine-level consistency. Dataset size,
  performance and compatibility need measurement before adoption.
- [Camoufox](https://github.com/daijro/camoufox), repository license MPL-2.0, active
  (push 2026-11-16). README explicitly warns it is under development and may not suit stable
  production. A patched Firefox integration needs binary provenance, Mozilla/upstream notices,
  per-component license review and a separate runtime adapter. No code/binaries copied.
- [puppeteer-extra](https://github.com/berstend/puppeteer-extra), MIT, last repository push
  reported 2024-07-18. Not selected: older maintenance signal and stealth-plugin overlap;
  GitHub popularity is not evidence of compatibility or security.
- [uBO Lite](https://github.com/uBlockOrigin/uBOL-home): inspected official README and its exact
  Chrome Web Store listing (`ddkjiahejlhfcafbddmgiahcphecmpfh`). Added as an optional store
  recommendation only, with privacy/potential breakage notice and generic UI icon. No extension
  source redistributed and no automatic installation. Runtime permissions/compatibility and
  actual store download still need Windows testing.

Repository activity and licenses are screening signals, not a full third-party security audit.
No copied third-party implementation or new dependency was added in this pass.

## Required transparent verification before release

- Clean Windows VM: installer → create profile → first runtime download → launch → restart app
  → relaunch; verify independent cookie/localStorage/IndexedDB values between two profiles.
- Engine matrix: Chrome, Brave, Joe; explicitly show unavailable Firefox/Edge functionality
  until implemented. Test pinned versions, missing binaries, download failure, retry and offline reuse.
- Proxy matrix: HTTP/HTTPS/SOCKS5, credentials, wrong credentials, DNS, rotation, timeout,
  opt-in fallback; compare actual exit IP, browser timezone and geolocation permission behavior.
- Extension matrix: source verification, permissions, manifest version, per-engine loading,
  master/custom switches, enable/disable/remove, restart behavior and unsupported browsers.
- Local test origin: record request headers plus JS/window/worker surfaces, compare repeated
  canvas/audio output and WebGL capabilities, include OOPIF and service-worker coverage.
- IPHey, BrowserLeaks, Pixelscan and IP Fighter: record browser build, OS, proxy, timestamps,
  observed values and screenshots, failures included. These sites are diagnostics, not ground
  truth or a target to special-case. No live checker results were obtained in this sandbox.
- Re-run audit/typecheck/build/tests after toolchain updates, then run packaged Windows smoke
  tests and manually exercise the wizard. Do not publish until blockers are resolved or clearly
  constrained functionality is approved.

## Automated results for this pass

- `npm run typecheck`: passed.
- `npm run build`: passed; existing Vite CJS, non-module script and chunk-size warnings remain.
- `npm test`: 115 tests passed across seven suites; 0 failures.
- `git diff --check`: passed.
- `npm audit --omit=dev`: 0 known advisories at time of check.
- Full `npm audit`: 20 advisories as detailed above; **not remediated** by this patch.

Windows binaries, vendor archive downloads, live browser checkers and a real Windows installer
were not run here. Runtime provisioning tests use injected catalog/installer services; they
verify selection/lifecycle logic, not vendor availability or successful archive execution.

## Follow-up: launch, shutdown and storage regressions

This pass builds on the first remediation already checked into the base branch. The original
Windows failure was not reproduced on the user's installation. Source review found additional
failure modes: automatic profiles could select an installed beta, an immediately exiting process
could be counted as open, and stop/delete could proceed before process exit. The profile editor
also exposed only the currently selected automatic engine, rather than listing alternatives.

- Automatic managed profiles now skip installed prereleases; explicit build pins still work.
- A child that exits during the 750 ms startup observation window is reported as a launch error.
  This catches immediate exits, not delayed crashes or failed DevTools attachment.
- Stop waits for process exit, and deletion no longer ignores stop errors. Desktop quit waits for
  session shutdown. A cancelled preparation checks its state before writing profile data or
  spawning, and a relay acquired after cancellation is closed.
- Fresh sessions use a unique browser data directory and attempt removal after exit. The existing
  durable directory is untouched. This does not guarantee removal after power loss, force-quitting
  the manager, locked files, or surviving browser descendants; it is not secure erasure.
- The editor offers managed Chrome for Testing, Brave and Joe and labels unavailable Edge and
  Firefox automatic Windows builds. Existing pins stay visible if catalog lookup fails.

**Verification:** Linux `npm run typecheck`, `npm test` (117 passed), and `npm run build` passed.
Lifecycle regressions use controlled child processes; renderer tests do not exercise a real Windows
installer or browsers. Vite still warns about large renderer bundles. Full `npm audit` again reported
20 advisories (1 critical, 14 high, 5 moderate); this pass does not close the dependency blocker.

### GitHub research and integration decisions

Repository metadata checked on 2026-11-18. These are candidates for specific jobs, not an
assessment that any upstream dependency is safe to ship.

| Upstream | License and maintenance signal | Fit and decision |
|---|---|---|
| [Playwright](https://github.com/microsoft/playwright) | Apache-2.0; active | Already used by Windows smoke scripts. Keep test-only; another browser management layer would add downloads and would not provide the requested branded offline runtimes. |
| [geckodriver](https://github.com/mozilla/geckodriver) | MPL-2.0; non-archived, repository activity in August 2026 | Candidate for Firefox smoke tests after supplying a verified Windows runtime. It is a driver, not Firefox or a substitute for Chromium CDP. |
| [Brave](https://github.com/brave/brave-browser) | MPL-2.0; active | Keep the existing managed vendor archive flow. Do not fork or repackage on the strength of the source license alone; release artifact terms, signatures and updater behavior need review. |
| [PrivacyTests](https://github.com/privacytests/privacytests) | MIT; active | Candidate for independent state partitioning and privacy checks. Prefer isolated test runs over embedding its harness in the product. |
| [arkenfox user.js](https://github.com/arkenfox/user.js) | MIT; non-archived, activity in October 2026 | Useful for reviewing Firefox privacy defaults. Do not copy the preference set wholesale: policies may change browser behavior and can break sites. |
| [uBlock Origin](https://github.com/gorhill/uBlock) | GPL-3.0; active | Evaluate by engine, store and manifest support; recommend compatible upstream listings rather than vendoring extension source. |

No third-party code was added. No external checker scores were collected. Before release, run
fresh-install and offline-relaunch tests on Windows x64 for each supported engine; verify isolated
cookies and local storage across two real profiles, restart persistence, deletion and recycle-bin
restore, and compatible extension install/disable/remove after reopening. Exercise direct and
proxied sessions against controlled endpoints first; use BrowserLeaks, IPHey, Pixelscan and IP
Fighter as observations, not pass/fail proof of security or a substitute for testing browser state.

### Windows verification gate

The existing `Build EXE` workflow runs the packaged installer smoke and a separate live browser
smoke. The live smoke now launches real Chrome through `SessionManager`, starting with no managed
Chrome installed in its scratch workspace. It checks separate cookies and local storage on one
loopback origin, reopening, profile edits reloaded from disk, fresh-session behavior, and deletion
without affecting the second profile. It retains separate Brave and signed extension checks.
This is not a simulated network outage, an authenticated packaged profile-launch test, or full
extension lifecycle coverage. Dispatch the workflow with publishing disabled for verification.
