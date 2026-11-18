import type { InstalledKernel, Profile } from '../../shared/types';

/**
 * Kernel diversity.
 *
 * The rule the original arrived at is the interesting part: a profile's engine build is as much
 * a part of its identity as its fingerprint, and it is the half a fingerprint cannot fix.
 *
 *  - A pinned build is never inherited silently by a duplicate. A copy that shares both the
 *    fingerprint settings and the binary is, to a detector, one browser opened twice.
 *  - When more than one build is installed, a new profile takes the least-used one, so a batch of
 *    a hundred spreads out instead of piling onto whatever was newest.
 *  - When only one build exists - the default on a fresh install - the profile is left on the
 *    "installed browser" sentinel and the caller is told why. Pinning the only build would make
 *    every profile break the day it is deleted, and would buy nothing in the meantime.
 */

/** The key that identifies one build. Empty means "whatever is installed". */
export function keyOf(profile: Profile | null | undefined): string {
  if (!profile?.kernelId) return '';
  return profile.kernelId.toLowerCase();
}

export function prettyEngine(engine: string): string {
  if (!engine) return '';
  const known: Record<string, string> = {
    joe: 'Joe Browser',
    chrome: 'Chrome',
    brave: 'Brave',
    chromium: 'Chromium',
    firefox: 'Firefox',
    edge: 'Edge',
  };
  const lower = engine.toLowerCase();
  return known[lower] ?? lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Newest first within an engine, so a fresh profile lands on a current build. */
function byVersionDescending(a: InstalledKernel, b: InstalledKernel): number {
  return versionKey(b.version).localeCompare(versionKey(a.version));
}

function versionKey(version: string): string {
  return (version ?? '')
    .split('.')
    .map((part) => (Number.parseInt(part, 10) || 0).toString().padStart(6, '0'))
    .slice(0, 4)
    .join('|');
}

function usageOf(existing: Profile[]): Map<string, number> {
  const usage = new Map<string, number>();
  for (const profile of existing) {
    const key = keyOf(profile);
    if (!key) continue;
    usage.set(key, (usage.get(key) ?? 0) + 1);
  }
  return usage;
}

function leastUsed(
  available: InstalledKernel[],
  usage: Map<string, number>,
  avoid?: string,
): { build: InstalledKernel; use: number } | null {
  let best: InstalledKernel | null = null;
  let bestUse = Number.POSITIVE_INFINITY;

  for (const build of available) {
    if (avoid && build.id.toLowerCase() === avoid.toLowerCase()) continue;
    const count = usage.get(build.id.toLowerCase()) ?? 0;
    if (count < bestUse) {
      bestUse = count;
      best = build;
    }
  }
  return best ? { build: best, use: bestUse } : null;
}

export interface Assignment {
  kernelId: string;
  reason: string;
}

/**
 * The build a brand new profile should use, given the profiles that already exist.
 *
 * `kernelId` is empty when nothing should be pinned, and `reason` always explains the decision -
 * "no other kernel is installed" is useful information, and a silent no is not.
 */
export function assignKernel(available: InstalledKernel[], existing: Profile[]): Assignment {
  const ready = [...available].sort(byVersionDescending);
  if (ready.length === 0) {
    return {
      kernelId: '',
      reason:
        'Only one browser build is installed, so this profile uses it. Download another build on the Browsers page to give each profile its own.',
    };
  }

  // Only pin when pinning buys something. One build shared by every profile is not diversity.
  if (ready.length === 1) {
    return {
      kernelId: '',
      reason:
        'Only one browser build is installed, so this profile uses it. Download another build on the Browsers page to give each profile its own.',
    };
  }

  const usage = usageOf(existing);
  const counts = ready.map((build) => usage.get(build.id.toLowerCase()) ?? 0);
  const minUse = Math.min(...counts);
  // Tie-break by the number of profiles already here. Picking "newest" on every tie is what made
  // a batch of profiles land on the same version even when several builds were installed.
  const tied = ready.filter((_build, index) => counts[index] === minUse);
  const choice = { build: tied[existing.length % tied.length]!, use: minUse };

  const shared = choice.use;
  return {
    kernelId: choice.build.id,
    reason:
      shared === 0
        ? ''
        : `${prettyEngine(choice.build.engine)} ${choice.build.version} is shared with ${
            shared === 1 ? 'one other profile' : `${shared} other profiles`
          }. Download more builds to spread them out.`,
  };
}

/**
 * The same choice for a duplicate: the copy must not land on the build its source is using.
 *
 * A source on the sentinel is already "whatever is installed", so there is nothing to separate
 * the copy from unless the copy can be pinned to a real build.
 */
export function assignDifferentKernel(
  available: InstalledKernel[],
  source: Profile,
  existing: Profile[],
): Assignment {
  const avoid = keyOf(source);
  const ready = [...available].sort(byVersionDescending);

  if (ready.length === 0) {
    return {
      kernelId: '',
      reason:
        'Only one browser build is installed, so both profiles use it. Download another build to separate them.',
    };
  }

  const usage = usageOf(existing);
  const choice = leastUsed(ready, usage, avoid || undefined);

  if (!choice) {
    // Every installed build is the source's build. The sentinel is the honest answer: it is what
    // a fresh profile gets, and the fingerprint still moved.
    return {
      kernelId: '',
      reason:
        'Only the source profile’s browser build is installed, so the copy uses the installed browser. Download another build to give the copy its own.',
    };
  }

  return { kernelId: choice.build.id, reason: '' };
}

/** How many distinct builds a workspace is spread across. */
export function distinctKernels(profiles: Profile[]): number {
  const set = new Set<string>();
  for (const profile of profiles) set.add(keyOf(profile));
  return set.size;
}
