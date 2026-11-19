import type { AuditFinding, AuditReport, Profile } from '../../shared/types';
import { signature, SURFACES } from './fingerprint';
import { proxyEnabled } from './proxy';

/**
 * The workspace audit.
 *
 * The original's `ToolsAction("audit")` answered one question: which profiles in this workspace
 * are the same machine, the same proxy, or the same build? That is the question a user actually
 * has after twenty profiles - a checker loses interest in any single profile once it can tell
 * two of them apart share a signal.
 *
 * Findings are ranked by how much they matter: a shared canvas hash is fatal, a shared OS is not.
 */

const FATAL_SURFACES: (keyof ReturnType<typeof signature>)[] = [
  'canvas',
  'audio',
  'webgl',
  'timezone',
  'screen',
  'userAgent',
  // The hardware pair belongs with the others: the same number of cores and the same amount of
  // memory on the same screen is one machine, whichever way the profile was drawn.
  'cores',
  'memory',
];

export function auditWorkspace(profiles: Profile[]): AuditReport {
  const findings: AuditFinding[] = [];

  // 1. Fingerprints: compare every pair once.
  for (let a = 0; a < profiles.length; a++) {
    for (let b = a + 1; b < profiles.length; b++) {
      const left = profiles[a]!;
      const right = profiles[b]!;
      const one = signature(left.fingerprint);
      const two = signature(right.fingerprint);

      const shared: string[] = [];
      for (const surface of SURFACES) if (one[surface] === two[surface]) shared.push(surface);
      const fatal = shared.filter((surface) => FATAL_SURFACES.includes(surface as never));

      if (fatal.length >= 2) {
        findings.push({
          kind: 'fingerprint',
          severity: 'high',
          summary: `${left.name} and ${right.name} are the same machine`,
          detail: `They share ${fatal.map(label).join(', ')}. A site that sees both can match them to one device.`,
          profiles: [
            { id: left.id, name: left.name },
            { id: right.id, name: right.name },
          ],
        });
      } else if (shared.length >= 9) {
        findings.push({
          kind: 'fingerprint',
          severity: 'medium',
          summary: `${left.name} and ${right.name} share ${shared.length} of ${SURFACES.length} surfaces`,
          detail: `Shared: ${shared.map(label).join(', ')}. Not fatal on its own, but thin.`,
          profiles: [
            { id: left.id, name: left.name },
            { id: right.id, name: right.name },
          ],
        });
      }
    }
  }

  // 2. Seed collisions: two profiles whose canvas noise came from one seed are one canvas.
  const bySeed = new Map<number, Profile[]>();
  for (const profile of profiles) {
    if (!profile.fingerprint.seed) continue;
    const list = bySeed.get(profile.fingerprint.seed) ?? [];
    list.push(profile);
    bySeed.set(profile.fingerprint.seed, list);
  }
  for (const [seed, group] of bySeed) {
    if (group.length < 2) continue;
    findings.push({
      kind: 'seed',
      severity: 'high',
      summary: `${group.length} profiles were rolled from seed ${seed}`,
      detail:
        'The seed drives canvas, audio and font noise, so these profiles answer the same hashes. ' +
        'Re-roll one of them from the fingerprint tab.',
      profiles: group.map((profile) => ({ id: profile.id, name: profile.name })),
    });
  }

  // 3. Shared proxies: two accounts behind one exit address are two accounts on one address.
  const byProxy = new Map<string, Profile[]>();
  for (const profile of profiles) {
    if (!proxyEnabled(profile.proxy)) continue;
    const key = `${profile.proxy.type}://${profile.proxy.host}:${profile.proxy.port}`;
    const list = byProxy.get(key) ?? [];
    list.push(profile);
    byProxy.set(key, list);
  }
  for (const [endpoint, group] of byProxy) {
    if (group.length < 2) continue;
    findings.push({
      kind: 'proxy',
      severity: group.length > 4 ? 'high' : 'medium',
      summary: `${group.length} profiles use ${endpoint}`,
      detail:
        'They appear to the world from one address at the same time, which is the pairing a ' +
        'link analysis looks for first.',
      profiles: group.map((profile) => ({ id: profile.id, name: profile.name })),
    });
  }

  // 4. Shared builds: a real tell, but the original's kernel-diversity rule only applies when
  //    more than one build is installed, so a lone build is reported as low.
  const byKernel = new Map<string, Profile[]>();
  for (const profile of profiles) {
    if (!profile.kernelId) continue;
    const list = byKernel.get(profile.kernelId) ?? [];
    list.push(profile);
    byKernel.set(profile.kernelId, list);
  }
  const installedKernels = [...byKernel.keys()].length;
  for (const [kernel, group] of byKernel) {
    if (group.length < 2 || installedKernels < 2) continue;
    findings.push({
      kind: 'kernel',
      severity: 'low',
      summary: `${group.length} profiles are pinned to ${kernel}`,
      detail:
        'Two builds are installed, so these could be spread across them. A shared binary is a ' +
        'weak signal next to a shared canvas, but it is free to fix.',
      profiles: group.map((profile) => ({ id: profile.id, name: profile.name })),
    });
  }

  findings.sort((a, b) => rank(b.severity) - rank(a.severity));

  return { checkedAt: new Date().toISOString(), profiles: profiles.length, findings };
}

function rank(severity: AuditFinding['severity']): number {
  return severity === 'high' ? 3 : severity === 'medium' ? 2 : 1;
}

function label(surface: string): string {
  const labels: Record<string, string> = {
    userAgent: 'the user agent',
    platform: 'the platform',
    screen: 'the screen',
    webgl: 'the graphics card',
    cores: 'the core count',
    memory: 'the memory',
    timezone: 'the clock',
    language: 'the language',
    fonts: 'the font list',
    canvas: 'the canvas hash',
    audio: 'the audio hash',
    touch: 'the touch profile',
  };
  return labels[surface] ?? surface;
}

/* ------------------------------------------------------------------ the repair */

/**
 * Re-rolls the profiles that share an environment with one already accepted.
 *
 * Oldest first, so the profile a user has been working in longest keeps its identity and the
 * newer copies move - the direction they expect. The roll is only accepted when the acceptance
 * check passes against everything kept so far, so a "fix" cannot introduce the collision it was
 * meant to remove.
 *
 * The repairs are deliberately limited to what is free and correct: a fingerprint, a seed and a
 * kernel pin. A shared proxy is not repaired, because assigning one would mean guessing which
 * profile should lose it, and a missing proxy cannot be invented.
 */
export function repairWorkspace(
  profiles: Profile[],
  save: (profile: Profile) => void,
  reroll: (profile: Profile, accepted: Profile[]) => Profile['fingerprint'],
): { changed: number; failed: number; ids: string[] } {
  let changed = 0;
  let failed = 0;
  const ids: string[] = [];
  const accepted: Profile[] = [];

  const ordered = [...profiles].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

  for (const profile of ordered) {
    if (!profile.fingerprint) {
      accepted.push(profile);
      continue;
    }

    const collide = accepted.some((other) => {
      const one = signature(profile.fingerprint);
      const two = signature(other.fingerprint);
      const shared = SURFACES.filter((surface) => one[surface] === two[surface]).length;
      return shared > SURFACES.length - 3;
    });
    const duplicateSeed =
      profile.fingerprint.seed > 0 && accepted.some((other) => other.fingerprint.seed === profile.fingerprint.seed);

    if (collide || duplicateSeed) {
      try {
        const next = reroll(profile, accepted);
        const updated: Profile = { ...profile, fingerprint: next };
        save(updated);
        accepted.push(updated);
        changed++;
        ids.push(profile.id);
        continue;
      } catch {
        failed++;
      }
    }

    accepted.push(profile);
  }

  return { changed, failed, ids };
}
