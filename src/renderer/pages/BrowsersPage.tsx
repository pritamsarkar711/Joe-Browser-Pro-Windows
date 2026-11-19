import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AppSettings, KernelBuild, SystemInfo } from '../../shared/types';
import { enginesFromCatalog } from '../../shared/types';
import { bridge, onEvent } from '../bridge';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';
import { BrowserLogo } from '../components/BrowserLogo';
import { Banner, Button, Chip, EmptyState, Field, Stat, Toggle, useConfirm, useToast } from '../components/UI';
import { messageOf } from '../util';

/**
 * Orders two version strings.
 *
 * The versions come from different vendors and are written differently - `1.2.3.4`, `132.0.6834`,
 * `1.2.3` - so the parts are compared as numbers and a missing part counts as zero.
 */
function compareVersions(left: string, right: string): number {
  const a = left.split(/[.\-]/).map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(/[.\-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Browsers and builds.
 *
 * Detected browsers are informational only. Profiles launch app-managed builds, so a system
 * browser update cannot silently change the version used by a profile.
 *
 * The graphics card panel lives here too, because reading the adapter means launching a browser,
 * and that is exactly what this page is about.
 */

export function BrowsersPage({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const [kernels, setKernels] = useState<KernelBuild[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState('');
  const [learning, setLearning] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [nextKernels, nextSystem] = await Promise.all([
        bridge().listKernels(),
        bridge().getSystemInfo(),
      ]);
      setKernels(nextKernels);
      setSystem(nextSystem);
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      onEvent('kernel:progress', (payload) => {
        const data = payload as { id: string; received: number; total: number };
        const percent = data.total > 0 ? Math.round((100 * data.received) / data.total) : 0;
        setProgress((current) => ({ ...current, [data.id]: percent }));
      }),
    [],
  );

  const download = async (kernel: KernelBuild, isUpdate = false) => {
    setBusy(kernel.id);
    setProgress((current) => ({ ...current, [kernel.id]: 0 }));
    try {
      await bridge().downloadKernel(kernel.id);
      toast.success(isUpdate ? t('br.update') : t('br.installed'), `${kernel.engine} ${kernel.version}`);
      await load();
    } catch (error) {
      toast.error(t('br.download'), messageOf(error));
    } finally {
      setBusy('');
      setProgress((current) => {
        const next = { ...current };
        delete next[kernel.id];
        return next;
      });
    }
  };

  const remove = async (kernel: KernelBuild) => {
    const ok = await confirm.ask({
      title: t('br.remove'),
      body: t('br.remove.body').replace('{name}', `${kernel.engine} ${kernel.version}`),
      confirmLabel: t('btn.delete'),
      danger: true,
    });
    if (!ok) return;
    setBusy(kernel.id);
    try {
      await bridge().removeKernel(kernel.id);
      await load();
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    } finally {
      setBusy('');
    }
  };

  const learn = async () => {
    setLearning(true);
    try {
      const gpu = await bridge().learnMachineGpu();
      toast.success(t('br.gpu.done'), gpu.renderer);
      await load();
    } catch (error) {
      toast.error(t('br.gpu'), messageOf(error));
    } finally {
      setLearning(false);
    }
  };

  const installed = kernels.filter((kernel) => kernel.installed);

  /* A newer build of an engine that is already here is an update, and the update is offered on
     the build itself: the download list holds every version of every engine, so the one that
     matters for an installed engine is not obvious. */
  const updates = new Map<string, KernelBuild>();
  for (const kernel of installed) {
    const newer = kernels.find(
      (candidate) =>
        !candidate.installed &&
        candidate.engine === kernel.engine &&
        candidate.channel === kernel.channel &&
        compareVersions(candidate.version, kernel.version) > 0,
    );
    if (newer) updates.set(kernel.id, newer);
  }

  return (
    <>
      <header className="header">
        <div className="header-titles">
          <h1>{t('br.title')}</h1>
        </div>
        <div className="header-actions">
          <Button variant="soft" icon="refresh" onClick={() => void load()}>
            {t('btn.refresh')}
          </Button>
        </div>
      </header>

      <div className="content">
        <div className="content-inner browsers-content">
          <Banner tone="info" icon="browsers">
            {t('br.managed.hint')}
          </Banner>

          <div className="section-label">{t('br.kernels')}</div>
          {loading ? (
            <div className="row">
              <span className="spinner" style={{ width: 16, height: 16 }} />
              <div className="row-main">
                <div className="row-sub">{t('br.kernel.loading')}</div>
              </div>
            </div>
          ) : installed.length === 0 ? (
            <EmptyState icon="download" title={t('br.kernel.empty')} body={t('br.kernel.empty.body')} />
          ) : (
            <div className="rows">
              {installed.map((kernel) => (
                <div className="row" key={kernel.id}>
                  <div className="row-icon" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>
                    <BrowserLogo engine={kernel.engine} />
                  </div>
                  <div className="row-main">
                    <div className="row-title">
                      {t(`br.engine.${kernel.engine}`, kernel.engine)} {kernel.version}
                      <Chip tone="ok">{t('br.installed')}</Chip>
                      {kernel.channel && kernel.channel !== 'stable' ? <Chip tone="warn">{kernel.channel}</Chip> : null}
                    </div>
                    <div className="row-sub mono">{kernel.path || kernel.os}</div>
                  </div>
                  <div className="row-actions">
                    {updates.has(kernel.id) ? (
                      <Button
                        size="sm"
                        variant="primary"
                        icon="refresh"
                        busy={busy === updates.get(kernel.id)!.id}
                        onClick={() => void download(updates.get(kernel.id)!, true)}
                      >
                        {t('br.update')}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" icon="trash" onClick={() => void remove(kernel)} busy={busy === kernel.id}>
                      {t('br.remove')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {kernels.filter((kernel) => !kernel.installed).length > 0 ? (
            <>
              <div className="section-label">{t('br.download')}</div>
              <div className="rows">
                {kernels
                  .filter((kernel) => !kernel.installed)
                  .slice(0, 30)
                  .map((kernel) => (
                    <div className="row" key={kernel.id}>
                      <div className="row-icon">
                        <BrowserLogo engine={kernel.engine} />
                      </div>
                      <div className="row-main">
                        <div className="row-title">
                          {t(`br.engine.${kernel.engine}`, kernel.engine)} {kernel.version}
                          <Chip tone="muted">{kernel.channel}</Chip>
                        </div>
                        <div className="row-sub">
                          {kernel.os}{kernel.sizeBytes > 0 ? ` · ${Math.round(kernel.sizeBytes / 1_048_576)} MB` : null}
                        </div>
                        {progress[kernel.id] !== undefined ? (
                          <div className="progress" style={{ marginTop: 6 }}>
                            <span style={{ width: `${progress[kernel.id]}%` }} />
                          </div>
                        ) : null}
                      </div>
                      <div className="row-actions">
                        <Button
                          size="sm"
                          variant="primary"
                          icon="download"
                          busy={busy === kernel.id}
                          onClick={() => void download(kernel)}
                        >
                          {progress[kernel.id] !== undefined
                            ? t('br.downloading').replace('{n}', String(progress[kernel.id]))
                            : t('br.download')}
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            </>
          ) : null}

          <div className="section-label">{t('br.machine')}</div>
          <div className="panel">
            <div className="panel-head">
              <Icon name="cpu" size={16} />
              <h3>{t('br.gpu')}</h3>
              <div className="grow" />
              <Button size="sm" variant="soft" icon="cpu" onClick={learn} busy={learning}>
                {t('br.gpu.learn')}
              </Button>
            </div>

            <div className="stack tight">
              <div>
                <div className="field-label">{t('ed.gpu')}</div>
                <div className="mono" style={{ fontSize: 12.2, marginTop: 3 }}>
                  {system?.gpuRenderer || settings.machineGlRenderer || <span className="faint">not read yet</span>}
                </div>
              </div>

              <div className="divider" />
              <div className="stat-grid">
                <Stat value={system?.os ?? '—'} label={t('set.platform')} />
                <Stat value={system?.cores ?? '—'} label={t('ed.cores')} />
                <Stat
                  value={system ? `${Math.round(system.memoryBytes / 1_073_741_824)} GB` : '—'}
                  label={t('ed.memory')}
                />
                <Stat value={system?.timezone ?? '—'} label={t('ed.timezone')} />
                <Stat value={system?.locale ?? '—'} label={t('set.interface')} />
              </div>
            </div>
          </div>

          <div className="section-label">{t('br.engine.default')}</div>
          <div className="panel">
            <Field label={t('set.browser')}>
              <select
                className="select"
                value={settings.defaultEngine}
                onChange={(event) => void saveSettings({ defaultEngine: event.target.value })}
              >
                <option value="auto">{t('br.engine.auto')}</option>
                {enginesFromCatalog(kernels).map((engine) => (
                  <option key={engine} value={engine}>
                    {t(`br.engine.${engine}`, engine)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="divider" />
            <Toggle
              checked={settings.extensionsEnabled}
              onChange={(extensionsEnabled) => void saveSettings({ extensionsEnabled })}
              label={t('set.ext')}
            />
          </div>


        </div>
      </div>

      {confirm.dialog}
    </>
  );
}
