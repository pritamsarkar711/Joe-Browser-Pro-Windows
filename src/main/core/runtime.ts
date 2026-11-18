import type { InstalledKernel, KernelBuild, Profile } from '../../shared/types';
import { compareVersions, downloadKernel, installedKernels, listKernels, resolveKernelExe } from './catalog';

interface RuntimeServices {
  installed(): InstalledKernel[];
  executable(id: string): string | null;
  catalog(): Promise<KernelBuild[]>;
  install(build: KernelBuild, progress: (received: number, total: number) => void): Promise<InstalledKernel>;
}
const services: RuntimeServices = {
  installed: installedKernels, executable: resolveKernelExe, catalog: listKernels, install: downloadKernel,
};
export interface RuntimeTarget { exe: string; engine: string; version: string; runtimeVersion?: string }

/** Shared across profile launches so a bulk-open downloads a given build only once. */
export function createRuntimeResolver(source: RuntimeServices = services) {
  const pending = new Map<string, Promise<InstalledKernel>>();
  return async (profile: Profile, progress: (received: number, total: number) => void = () => {}): Promise<RuntimeTarget> => {
    const target = (build: InstalledKernel): RuntimeTarget | null => {
      const exe = source.executable(build.id);
      return exe ? { exe, engine: build.engine, version: build.version, runtimeVersion: build.runtimeVersion } : null;
    };
    const installed = source.installed().filter(build => build.engine === profile.engine)
      .sort((a, b) => compareVersions(b.version, a.version));
    for (const build of installed) {
      if (profile.kernelId ? build.id !== profile.kernelId : !/-stable$/i.test(build.id)) continue;
      const result = target(build);
      if (result) return result;
    }
    const builds = (await source.catalog()).filter(build => build.engine === profile.engine && build.downloadUrl);
    // Never silently replace a pinned version, or select a beta/canary on a fresh install.
    const selected = profile.kernelId
      ? builds.find(build => build.id === profile.kernelId)
      : builds.filter(build => build.channel.toLowerCase() === 'stable')
        .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (!selected) throw new Error(`No downloadable ${profile.engine} ${profile.kernelId ? 'pinned build' : 'stable build'} is available for this platform. Open Browsers to check supported runtimes.`);
    let install = pending.get(selected.id);
    if (!install) {
      install = source.install(selected, progress);
      pending.set(selected.id, install);
      void install.finally(() => pending.delete(selected.id)).catch(() => {});
    }
    const result = target(await install);
    if (!result) throw new Error('The downloaded browser executable is missing. Reinstall the build from Browsers.');
    return result;
  };
}
export const resolveManagedRuntime = createRuntimeResolver();
