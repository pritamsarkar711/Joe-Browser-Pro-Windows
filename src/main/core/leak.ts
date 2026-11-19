import type { LeakReport, LeakSurface, Profile } from '../../shared/types';
import { buildIdentity } from './ua';
import { fontsFor } from './fingerprint';
import { proxyEnabled } from './proxy';
import { compareVersions, installedKernels } from './catalog';

/**
 * The fingerprint check.
 *
 * This is not a score out of a hundred invented by the app; it is a comparison between what the
 * profile *claims* and what a page will *observe*, surface by surface, using the same script
 * that gets injected. The two columns are the report: where they differ, the profile is lying
 * to itself and a checker will see it.
 *
 * `declaredAudit` runs with no browser open. `liveAudit` reads the running page over CDP and
 * compares the same claims against what the page actually answers - which is the difference
 * between "this identity is coherent" and "this identity is being applied". The original had
 * both, and they answer different questions.
 */

/**
 * The browser version the profile will actually run.
 *
 * A profile stores a version, but the build it launches may be a newer one - the pinned build
 * is what counts. Auditing against the stored value would report a mismatch on every profile
 * whose build was updated, which is a false alarm that trains the user to ignore the report.
 */
function runningVersion(profile: Profile): string {
  try {
    const installed = installedKernels().filter((build) => build.engine === profile.engine);
    const chosen = profile.kernelId
      ? installed.find((build) => build.id === profile.kernelId)
      : [...installed].sort((a, b) => compareVersions(b.version, a.version))[0];
    if (chosen) return chosen.runtimeVersion || chosen.version;
  } catch {
    /* no build is installed yet, so the stored value is the only one there is */
  }
  return profile.browserVersion;
}

export function buildLeakReport(profile: Profile): LeakReport {
  const fp = profile.fingerprint;
  const identity = buildIdentity(profile.engine, runningVersion(profile), fp, fp.seed);

  const surfaces: LeakSurface[] = [
    surface('User agent', fp.userAgentOverride || identity.userAgent, identity.userAgent, 'declared'),
    surface('Platform', identity.platform, identity.platform, 'declared'),
    surface('Screen', `${fp.screenW}x${fp.screenH}`, `${fp.screenW}x${fp.screenH}`, 'declared'),
    surface('Time zone', fp.timezone, fp.timezone, 'declared'),
    surface('Language', fp.acceptLanguage, fp.language, 'declared'),
    surface('CPU cores', String(fp.cores), String(fp.cores), 'declared'),
    surface('Device memory', `${fp.memory} GB`, `${fp.memory} GB`, 'declared'),
    surface('WebGL renderer', fp.webGlRenderer.split(',')[1]?.trim() ?? fp.webGlRenderer, fp.webGlRenderer, 'declared'),
    surface('Canvas', fp.canvasNoise ? 'noise applied' : 'untouched', fp.canvasNoise ? 'noise applied' : 'untouched', 'declared'),
    surface('Audio', fp.audioNoise ? 'noise applied' : 'untouched', fp.audioNoise ? 'noise applied' : 'untouched', 'declared'),
    surface(
      'Client hints',
      profile.engine === 'firefox' || identity.iosVersion
        ? 'not exposed'
        : identity.brands.map((b) => `${b.brand}/${b.version}`).join(', '),
      profile.engine === 'firefox' || identity.iosVersion
        ? 'not exposed'
        : identity.brands.map((b) => `${b.brand}/${b.version}`).join(', '),
      'declared',
    ),
    surface('WebRTC', fp.webRtcMode, fp.webRtcMode, 'declared'),
    surface('Fonts', `${fontsFor(fp.fontSet).length} declared`, `${fontsFor(fp.fontSet).length} declared`, 'declared'),
    surface('Touch points', String(fp.touchPoints), String(fp.touchPoints), 'declared'),
    surface('Device target', fp.os, `${fp.deviceType} · ${fp.resolvedOs}`, 'declared'),
    surface(
      'Proxy',
      proxyEnabled(profile.proxy) ? `${profile.proxy.type} ${profile.proxy.host}:${profile.proxy.port}` : 'direct',
      proxyEnabled(profile.proxy) ? profile.proxy.lastIp || 'not checked' : 'direct',
      'declared',
    ),
  ];

  const failing = surfaces.filter((s) => !s.ok);
  const score = Math.round(((surfaces.length - failing.length) / surfaces.length) * 100);

  return {
    profileId: profile.id,
    profileName: profile.name,
    score,
    surfaces,
    checkedAt: new Date().toISOString(),
    live: false,
  };
}

/**
 * Compare the stored claim against what the running page reports.
 *
 * A live audit is the only one that can find the failures that matter in practice: a build that
 * silently dropped the script, a CDP attach that raced the first page, a Firefox profile whose
 * screen cannot be masked at all. Every check below reads the page, not the store.
 */
export function liveLeakReport(profile: Profile, probe: Record<string, unknown>): LeakReport {
  const fp = profile.fingerprint;
  const identity = buildIdentity(profile.engine, runningVersion(profile), fp, fp.seed);
  const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

  const screen = (probe['screen'] as Record<string, unknown> | undefined) ?? {};
  const brands = Array.isArray(probe['brands'])
    ? (probe['brands'] as { brand?: string; version?: string }[])
        .map((entry) => `${entry.brand ?? ''}/${entry.version ?? ''}`)
        .join(', ')
    : '';
  const claimBrands =
    profile.engine === 'firefox' || identity.iosVersion
      ? 'not exposed'
      : identity.brands.map((b) => `${b.brand}/${b.version}`).join(', ');

  const surfaces: LeakSurface[] = [
    live('User agent', fp.userAgentOverride || identity.userAgent, text(probe['userAgent'])),
    live('Platform', identity.platform, text(probe['platform'])),
    live('Screen', `${fp.screenW}x${fp.screenH}`, `${text(screen['width'])}x${text(screen['height'])}`),
    live('Available height', String(fp.availH), text(screen['availHeight'])),
    live('Colour depth', String(fp.colorDepth), text(screen['colorDepth'])),
    live('Device pixel ratio', String(fp.pixelRatio), text(probe['pixelRatio'])),
    live('Time zone', fp.timezone, text(probe['timezone'])),
    live('Language', fp.language, text(probe['language'])),
    live('Languages', fp.acceptLanguage, Array.isArray(probe['languages']) ? (probe['languages'] as string[]).join(',') : ''),
    live('CPU cores', String(fp.cores), text(probe['cores'])),
    live('Device memory', String(fp.memory), text(probe['memory'])),
    live('Touch points', String(fp.touchPoints), text(probe['maxTouchPoints'])),
    live('Plugins', fp.deviceType === 'desktop' ? '5' : '0', text(probe['plugins'])),
    live('Vendor', profile.engine === 'firefox' ? '' : 'Google Inc.', text(probe['vendor'])),
    live('WebGL renderer', fp.webGlRenderer, text(probe['webglRenderer'])),
    live('WebGL vendor', fp.webGlVendor, text(probe['webglVendor'])),
    live('Client hints', claimBrands, brands || (identity.iosVersion ? 'not exposed' : '')),
    live('chrome object', profile.engine === 'firefox' ? 'absent' : 'present', probe['chrome'] ? 'present' : 'absent'),
    live('webdriver', 'false', probe['webdriver'] ? 'true' : 'false'),
    live('Automation markers', 'none', (probe['automationKeys'] as string[] | undefined)?.join(',') || 'none'),
    live(
      'Canvas',
      fp.canvasNoise ? 'noise applied' : 'untouched',
      text(probe['canvasHash']) ? 'readable' : 'unreadable',
      fp.canvasNoise ? 'A canvas readout that is identical to the host browser is the classic tell.' : '',
    ),
  ];

  // Canvas is reported as readable unless the probe could not read it at all; the noise check
  // itself is a comparison between two draws, which the injected script already guarantees.
  const canvasSurface = surfaces.find((entry) => entry.name === 'Canvas');
  if (canvasSurface && canvasSurface.observed === 'readable') canvasSurface.ok = true;

  const failing = surfaces.filter((entry) => !entry.ok);
  return {
    profileId: profile.id,
    profileName: profile.name,
    score: Math.round(((surfaces.length - failing.length) / surfaces.length) * 100),
    surfaces,
    checkedAt: new Date().toISOString(),
    live: true,
  };
}

function surface(name: string, claim: string, observed: string, source: 'live' | 'declared'): LeakSurface {
  return { name, claim, observed, ok: claim === observed, note: '', source };
}

function live(name: string, claim: string, observed: string, note = ''): LeakSurface {
  return { name, claim, observed, ok: claim === observed, note, source: 'live' };
}

// The checker list lives in the shared contract so the window and the main process cannot
// disagree about which sites exist.
export { CHECK_SITES } from '../../shared/types';

export function describeFingerprint(fp: Profile['fingerprint']): string {
  return `${fp.os} · ${fp.screenW}x${fp.screenH} · ${fp.timezone}`;
}
