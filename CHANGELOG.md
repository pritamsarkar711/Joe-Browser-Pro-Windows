# Changelog

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
