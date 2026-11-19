import { parseProxyLine } from '../../shared/parseProxy';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AppSettings,
  FingerprintConfig,
  KernelBuild,
  Profile,
  ProfileSummary,
  ProxyConfig,
  ProxyEntry,
  ToolConfig,
} from '../../shared/types';
import {
  DEVICE_TARGETS,
  FONT_SETS,
  GEO_MODES,
  HUMAN_PASTE_SPEEDS,
  MANAGED_ENGINES,
  PROXY_TYPES,
  WEBRTC_MODES,
  enginesFromCatalog,
  managedEngine,
} from '../../shared/types';
import { bridge } from '../bridge';
import { useI18n } from '../i18n';
import {
  Banner,
  Button,
  Chip,
  Field,
  Modal,
  Segmented,
  Toggle,
  useConfirm,
  useToast,
} from '../components/UI';
import { messageOf } from '../util';

/**
 * The profile editor.
 *
 * Five tabs, in the order a profile is actually built: who it is, what machine it claims to be,
 * what it hides, where it connects from, and which tools run inside it. Every field the original
 * exposed is here, plus the ones that make the fingerprint tab usable at scale - a live clash
 * warning, a one-click re-roll, a random identity, and "use this PC's graphics card".
 *
 * The form is a single draft object. Nothing is written until Save, so a mis-click is free, and
 * Cancel from a dirty form asks first rather than silently throwing work away.
 */

type Tab = 'general' | 'fingerprint' | 'privacy' | 'proxy' | 'tools';

const TABS: { id: Tab; key: string }[] = [
  { id: 'general', key: 'tab.general' },
  { id: 'fingerprint', key: 'tab.fingerprint' },
  { id: 'privacy', key: 'tab.privacy' },
  { id: 'proxy', key: 'tab.proxy' },
  { id: 'tools', key: 'tab.tools' },
];

export function ProfileEditor({
  profile,
  onClose,
  onSaved,
  settings,
  existing,
  toast: _toast,
}: {
  profile: Profile | null;
  onClose: () => void;
  onSaved: () => void;
  settings: AppSettings;
  existing: ProfileSummary[];
  toast: ReturnType<typeof useToast>;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const [tab, setTab] = useState<Tab>('general');
  const [draft, setDraft] = useState<Profile | null>(profile);
  const [kernels, setKernels] = useState<KernelBuild[]>([]);
  const [catalog, setCatalog] = useState<KernelBuild[]>([]);
  const [proxies, setProxies] = useState<ProxyEntry[]>([]);
  const proxySelection = useRef(0);
  const passwordChanged = useRef(false);
  const [saving, setSaving] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState('');
  const [learning, setLearning] = useState(false);
  const [clash, setClash] = useState('');
  const [dirty, setDirty] = useState(false);

  const isNew = !profile;

  // A draft is generated without creating a persistent profile.
  useEffect(() => {
    let live = true;
    if (profile) {
      setDraft(profile);
      return;
    }
    void (async () => {
      try {
        const created = await bridge().draftProfile({ name: nextName(existing) });
        if (live) {
          setDraft(created);

        }
      } catch (error) {
        if (live) toast.error(t('err.generic'), messageOf(error));
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void (async () => {
      const [nextKernels, nextProxies] = await Promise.all([
        bridge().listKernels().catch(() => []),
        bridge().listProxies().catch(() => []),
      ]);
      // The catalog says which engines exist; the installed list says which builds can be pinned.
      // A profile may choose an engine whose build is not on this machine yet - the launcher
      // downloads it on the first open - but it may only be pinned to a build that is here.
      setCatalog(nextKernels);
      setKernels(nextKernels.filter((kernel) => kernel.installed));
      setProxies(nextProxies);
    })();
  }, []);

  const patch = useCallback((change: Partial<Profile>) => {
    setDraft((current) => (current ? { ...current, ...change } : current));
    setDirty(true);
  }, []);

  const patchFingerprint = useCallback((change: Partial<FingerprintConfig>) => {
    setDraft((current) =>
      current ? { ...current, fingerprint: { ...current.fingerprint, ...change } } : current,
    );
    setDirty(true);
  }, []);

  const patchProxy = useCallback((change: Partial<ProxyConfig>) => {
    setDraft((current) => (current ? { ...current, proxy: { ...current.proxy, ...change } } : current));
    setDirty(true);
  }, []);

  const patchTools = useCallback((change: Partial<ToolConfig>) => {
    setDraft((current) => (current ? { ...current, tools: { ...current.tools, ...change } } : current));
    setDirty(true);
  }, []);

  /* ---------------------------------------------------------------- derivative state */

  const deviceSummary = useMemo(() => {
    const fp = draft?.fingerprint;
    if (!fp) return '';
    return `${fp.screenW}×${fp.screenH} @${fp.pixelRatio}x · ${fp.cores} cores · ${fp.memory} GB`;
  }, [draft, isNew]);

  const firefoxWarning = draft?.engine === 'firefox';

  /* The browser list must always contain the engine the profile already uses. A select whose
     value matches no option renders blank, so an empty catalog - a machine that has not reached
     the vendor yet - left the field showing nothing at all, with no way to tell what the profile
     would open. */
  const engineOptions = useMemo(() => {
    const found = enginesFromCatalog(catalog);
    if (draft?.engine && managedEngine(draft.engine) && !found.includes(draft.engine)) {
      return [...found, draft.engine].sort();
    }
    return found;
  }, [catalog, draft?.engine]);

  const close = useCallback(async () => {
    if (dirty) {
      const ok = await confirm.ask({
        title: t('ed.discard'),
        body: t('ed.discard.body'),
        confirmLabel: t('ed.discard.confirm'),
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  }, [confirm, dirty, isNew, draft, onClose, t]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      if (isNew) {
        await bridge().createProfile({ ...draft, preserveFingerprint: true });
      } else {
        await bridge().updateProfile(draft.id, {
          ...draft,
          proxy: { ...draft.proxy, password: passwordChanged.current ? draft.proxy.password : undefined },
        });
      }
      toast.success(t('btn.save'), draft.name);
      onSaved();
    } catch (error) {
      toast.error(t('err.save'), messageOf(error));
    } finally {
      setSaving(false);
    }
  };

  /* ---------------------------------------------------------------- actions */

  const rollFingerprint = async (target?: FingerprintConfig['os']) => {
    if (!draft || rolling) return;
    setRolling(true);
    try {
      const rolled = await bridge().draftProfile({
        ...draft, fingerprint: { ...draft.fingerprint, os: target ?? draft.fingerprint.os },
      });
      // Preserve edits to other profile sections made while the request was running.
      setDraft((current) => current ? { ...current, fingerprint: rolled.fingerprint } : current);
      setDirty(true);
      setClash('');
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    } finally { setRolling(false); }
  };

  const reroll = () => void rollFingerprint();
  const randomise = () => {
    const targets = ['Windows 11', 'Windows 10', 'macOS', 'Linux', 'Android', 'iPhone', 'iPad'] as const;
    const options = targets.filter((target) => target !== draft?.fingerprint.os);
    void rollFingerprint(options[Math.floor(Math.random() * options.length)]!);
  };

  const useThisPc = async () => {
    setLearning(true);
    try {
      const gpu = await bridge().learnMachineGpu();
      patchFingerprint({ webGlVendor: gpu.vendor, webGlRenderer: gpu.renderer });
      toast.success(t('br.gpu.done'), gpu.renderer);
    } catch (error) {
      toast.error(t('br.gpu'), messageOf(error));
    } finally {
      setLearning(false);
    }
  };

  const checkProxy = async () => {
    if (!draft) return;
    setChecking(true);
    setCheckResult('');
    try {
      const result = await bridge().checkProxy(draft.proxy, draft.proxy.password);
      if (result.ok) {
        const line = t('ed.proxy.ok')
          .replace('{ip}', result.ip)
          .replace('{country}', result.country)
          .replace('{latency}', String(result.latencyMs));
        setCheckResult(line);
        patchProxy({
          lastIp: result.ip,
          lastCountry: result.country,
          lastCountryCode: result.countryCode,
          lastCity: result.city,
          lastTimezone: result.timezone,
        });
      } else {
        setCheckResult(t('ed.proxy.fail').replace('{host}', draft.proxy.host).replace('{port}', String(draft.proxy.port)));
      }
    } catch (error) {
      setCheckResult(messageOf(error));
    } finally {
      setChecking(false);
    }
  };

  const checkClash = useCallback(async () => {
    if (!draft || isNew) return;
    try {
      const { relation } = await bridge().getProfileRelation(draft.id);
      if (relation && /shar/i.test(relation)) {
        const match = /([A-Z][^.]*)/.exec(relation);
        setClash(match ? match[1]!.trim() : relation);
      } else {
        setClash('');
      }
    } catch {
      setClash('');
    }
  }, [draft]);

  useEffect(() => {
    const id = setTimeout(() => void checkClash(), 350);
    return () => clearTimeout(id);
  }, [checkClash, draft?.fingerprint.seed, draft?.fingerprint.screenW, draft?.fingerprint.webGlRenderer]);

  if (!draft) {
    return (
      <Modal title={t('ed.new')} onClose={close} width="wide">
        <div className="empty">
          <span className="spinner" style={{ width: 20, height: 20, color: 'var(--accent)' }} />
        </div>
      </Modal>
    );
  }

  const fp = draft.fingerprint;

  return (
    <Modal
      title={isNew ? t('ed.new') : t('ed.edit')}
      onClose={close}
      width="wide"
      flush
      footer={
        <>
          <span className="chip muted" title={t('card.signature')}>
            {deviceSummary}
          </span>
          <div className="spacer" />
          <Button variant="ghost" onClick={close}>
            {t('btn.cancel')}
          </Button>
          <Button variant="primary" icon="save" onClick={save} busy={saving} disabled={rolling}>
            {t('btn.save')}
          </Button>
        </>
      }
    >
      <div className="editor-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            className="editor-tab"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
            type="button"
          >
            {t(entry.key)}
          </button>
        ))}
      </div>

      <div style={{ padding: '18px 20px' }}>
        {tab === 'general' ? (
          <div className="stack">
            <div className="form-grid">
              <Field label={t('ed.name')} span={2}>
                <input
                  className="input"
                  value={draft.name}
                  onChange={(event) => patch({ name: event.target.value })}
                  autoFocus
                  spellCheck={false}
                />
              </Field>

              <Field label={t('ed.start')} span={2}>
                <input
                  className="input mono"
                  value={draft.startUrl}
                  onChange={(event) => patch({ startUrl: event.target.value })}
                  placeholder={settings.startPage}
                  spellCheck={false}
                />
              </Field>

              <Field label={t('ed.browser')} span={2}>
                <select
                  className="select"
                  value={draft.kernelId ? `kernel:${draft.kernelId}` : draft.engine}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value.startsWith('kernel:')) {
                      const kernelId = value.slice(7);
                      const kernel = kernels.find((entry) => entry.id === kernelId);
                      patch({ kernelId, engine: kernel?.engine ?? draft.engine, browserVersion: kernel?.version ?? draft.browserVersion });
                    } else {
                      patch({ kernelId: '', engine: value });
                    }
                  }}
                >
                  {engineOptions.map((engine) => (
                    <option key={engine} value={engine}>
                      {t(`br.engine.${engine}`, engine)} (managed)
                    </option>
                  ))}
                  {!MANAGED_ENGINES.includes(draft.engine as (typeof MANAGED_ENGINES)[number]) && (
                    <option value={draft.engine}>{draft.engine} (existing selection)</option>
                  )}
                  {draft.kernelId && !kernels.some((kernel) => kernel.id === draft.kernelId) && (
                    <option value={`kernel:${draft.kernelId}`}>{draft.kernelId} (pinned)</option>
                  )}
                  {kernels.length > 0 ? (
                    <optgroup label={t('br.kernels')}>
                      {kernels.map((kernel) => (
                        <option key={kernel.id} value={`kernel:${kernel.id}`}>
                          {kernel.engine} {kernel.version}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </Field>

              {isNew ? null : (
                <>
                  <Field label={t('ed.status')}>
                    <input
                      className="input"
                      value={draft.status}
                      onChange={(event) => patch({ status: event.target.value })}
                      list="joe-statuses"
                      placeholder="idle"
                      spellCheck={false}
                    />
                    <datalist id="joe-statuses">
                      <option value="new" />
                      <option value="warm" />
                      <option value="idle" />
                      <option value="banned" />
                    </datalist>
                  </Field>

                  <Field label={t('ed.notes')}>
                    <input
                      className="input"
                      value={draft.notes}
                      onChange={(event) => patch({ notes: event.target.value })}
                    />
                  </Field>
                </>
              )}

              <div className="span-all divider" />

              <div className="span-all">
                <Toggle
                  checked={draft.freshSession}
                  onChange={(freshSession) => patch({ freshSession })}
                  label={t('ed.fresh')}
                />
              </div>
            </div>
          </div>
        ) : null}

        {tab === 'fingerprint' ? (
          <fieldset className="stack editor-fingerprint" disabled={rolling}>
            <div className="spread">
              <span />
              <div className="cluster">
                <Button size="sm" icon="refresh" onClick={reroll} disabled={rolling}>
                  {t('ed.fp.new')}
                </Button>
                <Button size="sm" variant="soft" icon="shuffle" onClick={randomise} disabled={rolling}>
                  {t('ed.fp.random')}
                </Button>
                <Button size="sm" variant="ghost" icon="cpu" onClick={useThisPc} busy={learning}>
                  {t('ed.fp.useThis')}
                </Button>
              </div>
            </div>

            {clash ? (
              <Banner tone="warn" icon="link">
                <b>{t('ed.fp.clash').replace('{name}', clash)}</b>
              </Banner>
            ) : null}

            {firefoxWarning ? (
              <Banner tone="warn" icon="info">
                <b>{t('ed.fp.firefox')}</b>
              </Banner>
            ) : null}

            <div className="section-label">{t('ed.fp.locale.sub')}</div>
            <div className="form-grid three">
              <Field label={t('ed.os')}>
                <select
                  className="select"
                  value={fp.os}
                  disabled={rolling}
                  onChange={(event) => void rollFingerprint(event.target.value as FingerprintConfig['os'])}
                >
                  {DEVICE_TARGETS.map((target) => (
                    <option key={target} value={target}>
                      {target}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label={t('ed.screen')}>
                <div className="row-inline">
                  <input
                    className="input num"
                    type="number"
                    value={fp.screenW}
                    onChange={(event) => patchFingerprint({ screenW: Number(event.target.value) || fp.screenW, availW: Number(event.target.value) || fp.availW })}
                  />
                  <span className="faint">×</span>
                  <input
                    className="input num"
                    type="number"
                    value={fp.screenH}
                    onChange={(event) => patchFingerprint({ screenH: Number(event.target.value) || fp.screenH, availH: Math.max(0, (Number(event.target.value) || fp.screenH) - 40) })}
                  />
                </div>
              </Field>

              <Field label={t('ed.timezone')}>
                <input
                  className="input"
                  value={fp.timezone}
                  onChange={(event) => patchFingerprint({ timezone: event.target.value })}
                  list="joe-timezones"
                  spellCheck={false}
                />
                <datalist id="joe-timezones">
                  {Intl.supportedValuesOf('timeZone').map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </Field>

              <Field label={t('ed.language')}>
                <input
                  className="input"
                  value={fp.language}
                  onChange={(event) => patchFingerprint({ language: event.target.value, acceptLanguage: `${event.target.value},en;q=0.9` })}
                  placeholder="en-US"
                  spellCheck={false}
                />
              </Field>

              <Field label={t('ed.cores')}>
                <input
                  className="input num"
                  type="number"
                  min={1}
                  max={64}
                  value={fp.cores}
                  onChange={(event) => patchFingerprint({ cores: Number(event.target.value) || fp.cores })}
                />
              </Field>

              <Field label={t('ed.memory')}>
                <select
                  className="select"
                  value={fp.memory}
                  onChange={(event) => patchFingerprint({ memory: Number(event.target.value) })}
                >
                  {[2, 4, 8, 16, 32, 64].map((gb) => (
                    <option key={gb} value={gb}>
                      {gb} GB
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="section-label">{t('ed.fp.hardware.sub')}</div>
            <div className="form-grid">
              <Field label={t('ed.gpu')} span={2}>
                <input
                  className="input mono"
                  value={fp.webGlRenderer}
                  onChange={(event) => patchFingerprint({ webGlRenderer: event.target.value })}
                  spellCheck={false}
                />
              </Field>

              <Field label={t('ed.fp.fonts.set')}>
                <select
                  className="select"
                  value={fp.fontSet}
                  onChange={(event) => patchFingerprint({ fontSet: event.target.value })}
                >
                  {FONT_SETS.map((set) => (
                    <option key={set.id} value={set.id}>
                      {set.label}
                    </option>
                  ))}
                </select>
              </Field>

              {['Android', 'iPhone', 'iPad'].includes(fp.os) ? (
              <Field label={fp.os === 'Android' ? t('ed.fp.android') : t('ed.fp.ios')}>
                <input
                  className="input"
                  value={fp.os === 'Android' ? fp.androidVersion : fp.iosVersion}
                  onChange={(event) =>
                    patchFingerprint(
                      fp.os === 'Android'
                        ? { androidVersion: event.target.value }
                        : { iosVersion: event.target.value },
                    )
                  }
                  placeholder="auto"
                  spellCheck={false}
                />
              </Field>

              ) : null}

              <Field label={t('ed.ua')} span={2}>
                <input
                  className="input mono"
                  value={fp.userAgentOverride}
                  onChange={(event) => patchFingerprint({ userAgentOverride: event.target.value })}
                  placeholder="auto"
                  spellCheck={false}
                />
              </Field>
            </div>

            <div className="section-label">{t('ed.fp.surfaces.sub')}</div>
            <div className="form-grid">
              <Toggle checked={fp.canvasNoise} onChange={(canvasNoise) => patchFingerprint({ canvasNoise })} label={t('ed.canvas')} />
              <Toggle checked={fp.audioNoise} onChange={(audioNoise) => patchFingerprint({ audioNoise })} label={t('ed.audio')} />
              <Toggle checked={fp.fontsNoise} onChange={(fontsNoise) => patchFingerprint({ fontsNoise })} label={t('ed.fonts')} />
              <Toggle checked={fp.hardwareNoise} onChange={(hardwareNoise) => patchFingerprint({ hardwareNoise })} label={t('ed.fp.hardwareNoise')} />
              <Toggle checked={fp.spoofBattery} onChange={(spoofBattery) => patchFingerprint({ spoofBattery })} label={t('ed.battery')} />
              <Toggle checked={fp.spoofMac} onChange={(spoofMac) => patchFingerprint({ spoofMac })} label={t('ed.fp.mac')} />
              <Toggle checked={fp.doNotTrack} onChange={(doNotTrack) => patchFingerprint({ doNotTrack })} label={t('ed.dnt')} />
              <Toggle checked={fp.autoUserAgent} onChange={(autoUserAgent) => patchFingerprint({ autoUserAgent })} label={t('ed.ua')} />
            </div>
          </fieldset>
        ) : null}

        {tab === 'privacy' ? (
          <div className="stack">
            <div className="section-label">{t('ed.webrtc')}</div>
            <div className="form-grid">
              <Field label={t('ed.webrtc')} span={2}>
                <Segmented
                  value={fp.webRtcMode}
                  onChange={(webRtcMode) => patchFingerprint({ webRtcMode, webRtcProtect: webRtcMode !== 'off' })}
                  options={WEBRTC_MODES.map((mode) => ({ id: mode.id, label: mode.label }))}
                />
              </Field>

              <Field label={t('ed.geo')} span={2}>
                <Segmented
                  value={fp.geoMode}
                  onChange={(geoMode) => patchFingerprint({ geoMode: geoMode as FingerprintConfig['geoMode'] })}
                  options={GEO_MODES.map((mode) => ({ id: mode.id, label: mode.label }))}
                />
              </Field>

              {fp.geoMode === 'custom' ? (
                <>
                  <Field label="Latitude">
                    <input className="input mono" value={fp.geoLat} onChange={(event) => patchFingerprint({ geoLat: event.target.value })} placeholder="51.5074" />
                  </Field>
                  <Field label="Longitude">
                    <input className="input mono" value={fp.geoLng} onChange={(event) => patchFingerprint({ geoLng: event.target.value })} placeholder="-0.1278" />
                  </Field>
                </>
              ) : null}

              <div className="span-all">
                <Toggle
                  checked={fp.autoMatchProxy}
                  onChange={(autoMatchProxy) => patchFingerprint({ autoMatchProxy })}
                  label={t('ed.automatch')}
                />
              </div>
            </div>
          </div>
        ) : null}

        {tab === 'proxy' ? (
          <div className="stack">
            <div className="spread">
              <span />
              <div className="cluster">
                {proxies.length > 0 ? (
                  <select
                    className="select"
                    style={{ width: 200 }}
                    value=""
                    onChange={(event) => {
                      const id = event.target.value;
                      if (!id) return;
                      const selection = ++proxySelection.current;
                      void bridge().getSavedProxy(id).then((entry) => {
                        if (selection !== proxySelection.current) return;
                        passwordChanged.current = true;
                        patchProxy({ ...entry.config, password: entry.password ?? '', passwordEnc: '' });
                      }).catch((error: unknown) => toast.error(t('err.generic'), messageOf(error)));
                    }}
                  >
                    <option value="">{t('ed.proxy.from')}</option>
                    {proxies.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name || `${entry.config.host}:${entry.config.port}`}
                      </option>
                    ))}
                  </select>
                ) : null}
                <Button size="sm" variant="soft" icon="speed" onClick={checkProxy} busy={checking}>
                  {t('ed.proxy.check')}
                </Button>
              </div>
            </div>

            {checkResult ? (
              <Banner tone={/^\d/.test(checkResult) ? 'ok' : 'err'}>{checkResult}</Banner>
            ) : null}

            <div className="form-grid">
              <Field label={t('ed.ptype')}>
                <Segmented
                  value={draft.proxy.type}
                  onChange={(type) =>
                    patchProxy({
                      type,
                      fallbackDirect: type === 'none' ? false : draft.proxy.fallbackDirect,
                    })
                  }
                  options={PROXY_TYPES.map((type) => ({ id: type, label: type === 'none' ? t('generic.off') : type.toUpperCase() }))}
                />
              </Field>

              <div />

              {draft.proxy.type === 'none' ? (
                <div className="span-all">
                  <Banner tone="info" icon="globe">
                    <b>{t('ed.proxy.none')}</b>
                  </Banner>
                </div>
              ) : (
                <>
                  <Field label={t('ed.host')}>
                    <input
                      className="input mono"
                      value={draft.proxy.host}
                      onChange={(event) => patchProxy({ host: event.target.value })}
                      onKeyDown={(event) => {
                        if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.key.toLowerCase() !== 'b') return;
                        event.preventDefault(); event.stopPropagation();
                        void bridge().proxyClipboard().then((parsed) => {
                          if (!parsed) { toast.warn('Invalid proxy', 'Use host:port or host:port:user:password.'); return; }
                          passwordChanged.current = true;
                          patchProxy({ ...parsed, passwordEnc: '' });
                        }).catch((error: unknown) => toast.error('Clipboard', messageOf(error)));
                      }}
                      onPaste={(event) => {
                        const parsed = parseProxyLine(event.clipboardData.getData('text'));
                        if (!parsed) return;
                        event.preventDefault();
                        passwordChanged.current = true;
                        patchProxy({ ...parsed, passwordEnc: '' });
                      }}
                      placeholder="gate.example.com"
                      spellCheck={false}
                    />
                  </Field>

                  <Field label={t('ed.port')}>
                    <input
                      className="input mono num"
                      type="number"
                      value={draft.proxy.port || ''}
                      onChange={(event) => patchProxy({ port: Number(event.target.value) || 0 })}
                      placeholder="8080"
                    />
                  </Field>

                  <Field label={t('ed.user')}>
                    <input
                      className="input mono"
                      value={draft.proxy.user}
                      onChange={(event) => patchProxy({ user: event.target.value })}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </Field>

                  <Field label={t('ed.pass')}>
                    <input
                      className="input mono"
                      type="password"
                      value={draft.proxy.password ?? ''}
                      onChange={(event) => { passwordChanged.current = true; patchProxy({ password: event.target.value }); }}
                      autoComplete="new-password"
                    />
                  </Field>

                  <div className="span-all">
                    <Toggle
                      checked={draft.proxy.fallbackDirect}
                      onChange={(fallbackDirect) => patchProxy({ fallbackDirect })}
                      label="Fall back to a direct connection"
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        ) : null}

        {tab === 'tools' ? (
          <div className="stack">
            <div className="form-grid">
              <Toggle
                checked={!firefoxWarning && draft.tools.humanPaste}
                onChange={(humanPaste) => patchTools({ humanPaste })}
                label={t('ed.humanpaste')}
                disabled={firefoxWarning}
              />
              <Field label={t('ed.humanspeed')}>
                <select
                  className="select"
                  value={draft.tools.humanPasteSpeed}
                  onChange={(event) => patchTools({ humanPasteSpeed: event.target.value })}
                  disabled={firefoxWarning || !draft.tools.humanPaste}
                >
                  {HUMAN_PASTE_SPEEDS.map((speed) => (
                    <option key={speed} value={speed}>
                      {speed}
                    </option>
                  ))}
                </select>
              </Field>

              <Toggle
                checked={draft.tools.proxyWatch}
                onChange={(proxyWatch) => patchTools({ proxyWatch })}
                label={t('ed.proxywatch')}
              />
              <Field label={t('ed.watchinterval')}>
                <select
                  className="select"
                  value={draft.tools.proxyWatchInterval}
                  onChange={(event) => patchTools({ proxyWatchInterval: Number(event.target.value) })}
                  disabled={!draft.tools.proxyWatch}
                >
                  {[1, 5, 10, 15, 30, 60].map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {minutes} min
                    </option>
                  ))}
                </select>
              </Field>

              <Field label={t('ed.customext')} span="all">
                <textarea
                  className="textarea mono"
                  value={draft.tools.customExtensions}
                  onChange={(event) => patchTools({ customExtensions: event.target.value })}
                  placeholder={'C:\\extensions\\ublock\nC:\\extensions\\cookie-editor'}
                  spellCheck={false}
                  rows={4}
                />
              </Field>
            </div>

            <div className="section-label">{t('ed.ext')}</div>
            <div className="cluster">
              <Chip tone="accent" icon="extensions">
                {t('ext.firstparty')}
              </Chip>
              <span className="faint" style={{ fontSize: 12 }}>
                {settings.extensionsEnabled ? t('generic.on') : t('generic.off')}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {confirm.dialog}
    </Modal>
  );
}

/** Profile 1, Profile 2 … skipping the names already taken. */
function nextName(existing: ProfileSummary[]): string {
  const taken = new Set(existing.map((profile) => profile.name.toLowerCase()));
  for (let index = 1; index < 10000; index++) {
    const candidate = `Profile ${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `Profile ${Date.now()}`;
}
