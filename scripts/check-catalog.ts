import { listKernels } from '../src/main/core/catalog';

/** Prints what the catalog returns, so a vendor that stops answering is visible. */

async function main(): Promise<void> {
  const started = Date.now();
  const builds = await listKernels(true);
  const byEngine = new Map<string, number>();
  for (const build of builds) byEngine.set(build.engine, (byEngine.get(build.engine) ?? 0) + 1);
  console.log(`took ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('counts', Object.fromEntries(byEngine));
  for (const build of builds.filter((entry) => entry.engine === 'brave').slice(0, 6)) {
    console.log(' brave', build.channel, build.version, 'sha', Boolean(build.sha256), 'runtime', build.runtimeVersion);
  }
  for (const build of builds.filter((entry) => entry.engine === 'chrome')) {
    console.log(' chrome', build.channel, build.version, 'sha', Boolean(build.sha256));
  }
}

void main();
