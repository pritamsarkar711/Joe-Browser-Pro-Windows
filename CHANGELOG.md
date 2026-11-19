# Changelog

## 2.5.0

- Show the window. The packaged application created its window and never put it on the screen:
  `ready-to-show` alone is not a promise that it will arrive. The window is now revealed on the
  first of several signals, with a deadline in case none of them comes, and it is centred on the
  work area of the display it opens on.
- Make the window usable on a phone. Its minimum size is now the narrowest screen worth
  supporting - 360 by 400 points - instead of a desktop size, so a phone-sized window can be
  opened at all.
- Keep the two builds out of each other's files. Windows treats `Settings.json` and
  `settings.json` as one name, so this application was overwriting the older C++ build's
  settings on every launch and breaking it. The store files are now named `AppSettings.json`,
  `AppAccounts.json`, `AppExtensions.json` and `AppProxies.json`, and a file is moved to its
  new name only when its contents prove it belongs to this application.
- Rebuild the Settings page as cards of rows: the name of a setting on the left, the control on
  the right, with the theme and density chosen from segmented controls and a save button that
  appears only when something has changed.
- Add a storage card to Settings with the data folder, a cache clean, a workspace reset and the
  log folder, each behind the confirmation it deserves.
- Give the Browsers page engine tabs and channel tabs built from the catalogue, so a tab for
  an engine that has nothing to download is no longer a dead end, and mark an installed build
  with its channel when it is not stable.
- Give the Tools page colour-coded tiles for batch creation, import, export, proxy testing,
  network checks, cookies and extensions.
- Make every page work on a narrow window: the header's actions wrap instead of running off the
  edge, a button's label gives way before the button does, the breadcrumb disappears when there
  is no room for it, and the trial badge keeps only the plan.
- Add the live inspection and responsive sweep scripts used to check all eight pages at six
  window sizes.

## 2.4.0

- Run only application-managed browsers. The detection of browsers installed on this computer is
  gone from the main process, the bridge, the shared types and the Browsers page, so a profile
  can no longer point at a browser on the PC and the launcher still refuses any executable
  outside the managed kernel tree.
- Make the wire and the page say the same thing. The user agent override is applied before the
  first request, and the DevTools Network and Runtime domains are no longer enabled on the page
  session, because both are readable from a page.
- Report the fonts and the audio honestly. A family the profile does not own measures as the
  generic fallback, and the rendered audio is scaled per profile, so two profiles of one
  machine do not answer the audio probe identically.
- Centre the window on the work area and re-centre it when a display is added, removed or
  resized, so it never opens in a corner of a screen that is gone.
- Keep the Brave release catalogue within reach by asking for forty releases rather than a
  hundred, and wait for the launcher's own navigation in the smoke test instead of starting a
  second one.

## 2.3.0

- Add Joe Browser as its own selectable engine: a branded app-window browser built on the same
  verified Chromium archives, with a local start page and built-in Paste as Human, proxy alerts
  and IP-change notices.
- Manage Joe Browser builds from the Browsers page alongside Chrome, Chromium, Firefox and Brave;
  versions and channels use the existing download, integrity and removal flow.
- Spread new profiles across equally-used builds instead of always choosing the newest.
- Fix country flags everywhere by deriving the code from the proxy's real exit country; unknown
  countries show a globe rather than a guessed flag.
- Make New Fingerprint and Random Identity roll a fresh, coherent Windows/macOS/Linux/Android/
  iPhone/iPad identity, including in the browser preview.
- Keep audio fingerprints stable across repeated reads by using a seeded noise table.
- Fill untranslated labels from English instead of showing raw dotted keys.
- Remove the full-icon-barrel imports that made every window load the entire Material icon set.
- Simplify the profile editor, proxy tools and browser surfaces; keep layouts usable at narrow
  window sizes.
- Correct the stored browser brand for Firefox and the device target, and keep the Chromium
  catalog cache from dropping Brave builds after a schema upgrade.
- Stop detected system browsers from becoming a default engine that has no managed build; Edge
  remains detection-only and Safari has no Windows build.
- Fix the deprecated `simple-icons/icons` import path that warned on every test run and would
  break in simple-icons v17; icons now import from `simple-icons` directly.

## 2.2.0

- Add Joe Browser accounts with cloud sign-in and registration (7-day trial on the first sign-in),
  backed by the project's licensing service. The workspace is reachable without an account - the
  free plan keeps one profile - and the choice is remembered like the theme.
- Add subscription management: tier chip in the title bar, a subscription card in Settings with the
  validity date, license-key activation (monthly, yearly, trial or custom-length keys), an inline
  "start 7-day trial" action, and sign-out that returns to the gate.
- Enforce the free plan's one-profile ceiling at the point of creation (new profile, batch create
  and the new-profile shortcut) with an activation prompt.
- Add an admin panel for the project administrator: headline stats, license-key generator in bulk,
  outstanding-key list with revoke, per-account search, +31-day/+1-year extension, exact expiry
  editing and blocking, all through the administrator-guarded RPCs.
- Restore the idle auto-lock: after the configured minutes without input the window locks behind
  the local identity's PIN and (when configured) authenticator code, with the only way through
  being the unlock form.
- Replace the gate for entering the app with the account screen; the local device lock moves into
  Settings → Security and no longer doubles as the onboarding step.
- Switch the interface to Telenor (Fira Sans fallback) with flat, gradient-free styling, Material
  icons, a rebuilt brand mark, full-width content, and a dark/light theme toggle in the title bar.
- Production builds: the Content-Security-Policy now permits the licensing origin for account and
  entitlement reads only; the packaged app ships the logo assets correctly.
- React 19 for the Material UI v9 renderer.
- Hardening: cloud session restore cannot crash the window, offline entitlement is anchored to the
  server's clock, and all renderer network access is limited to the licensing origin.

## 2.1.1

- Clarify that Setup is the installer and the other executable is portable.
- Add a license page and language selection to assisted setup; explicitly allow elevation for
  all-users installs and retain destination selection, shortcuts, uninstall and finish/launch.
- Simplify registration/sign-in screens and improve their vertical spacing.
- State clearly that local registration needs no email verification; no cloud auth is used.
- Fix a desktop-only Extensions page crash: expose the event subscription on the real preload
  bridge as promised by its interface; test the built preload API, not only source patterns.
- Await the registration-to-workspace transition so IPC failures stay visible in the form.
- Retry the full startup sequence after initialization failures instead of retrying only profiles.
- Add an actionable render-error recovery screen rather than leaving a blank window.
- Test first registration with an empty workspace and reopening a remembered account.
- Gate publishing on a real installed-Windows registration/restart/navigation/uninstall smoke test.
