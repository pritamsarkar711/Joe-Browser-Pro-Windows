# Releasing Joe Browser

The Windows pipeline is `.github/workflows/release.yml`; keep its reference copy at
`ci/release.yml` identical. Releases are manual, not a side effect of every push.

1. Bump `package.json` and the lockfile together (`npm version <version> --no-git-tag-version`).
2. Run `npm run typecheck`, `npm run build`, and `npm test`.
3. Push the working branch and open a PR.
4. Dispatch **Build EXE** on that branch with `prerelease=true` to validate a release candidate.
5. Check all Windows gates, then merge the PR and promote the tested release.

The workflow installs dependencies, typechecks, builds, runs the suites, packages the assisted NSIS
installer, then runs `node scripts/windows-smoke.mjs` **before** publishing.
The smoke test uses a disposable custom installation directory containing spaces, installs
per-user silently, launches the installed executable with a real preload/IPC bridge,
checks the required account gate and that a legacy local-mode choice cannot bypass it,
uses an isolated cloud stub to visit workspace pages,
then uninstalls and checks that workspace data remains. It fails on page errors.
No test account is created on an external service, and no network traffic is generated
against the licensing backend.

The default tag is derived from the package version. Never reuse a published version for
changed binaries. Release assets:

- `JoeBrowserSetup.exe`: assisted Windows installation (license, install scope, destination,
  shortcuts, completion/launch, Add/Remove Programs uninstaller).

Do not build or attach a portable executable or the `win-unpacked` app payload. Older releases
may still contain `JoeBrowser.exe`, which opens directly and is not an installer. A new release
is required to deliver this packaging change; previously downloaded files are unchanged.

All-users setup requests UAC elevation; per-user setup and normal app execution do not.
The binaries are not code-signed: neither UAC settings nor the wizard can remove SmartScreen's
unknown-publisher warning. Signing needs a publisher certificate not present in this repository.

## Verification limits

The automated installer test runs silently, so it does not click through the interactive wizard
or approve a physical UAC prompt. Before broad deployment, manually check the wizard on Windows
10/11 using a standard user and an administrator, cancellation, upgrade from the previous
release, shortcut choices, and uninstall from Windows Settings. Automated checks do not prove
that every possible machine, old workspace, browser download, or proxy service is error-free.

## Local Windows build

Run `npm ci`, `npm run typecheck`, `npm run build`, `npm test`,
`npx electron-builder --win --x64 --publish never`, and `node scripts/windows-smoke.mjs`.
Packaging needs network access to Electron's binary download hosts. This Linux sandbox cannot
perform native Windows installation; the GitHub Windows runner performs that validation.
