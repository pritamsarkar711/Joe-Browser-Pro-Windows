import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  AuditReport,
  CookieSummary,
  ProfileSummary,
  ReportPayload,
  StoreStats,
  TrashItem,
} from '../../shared/types';
import { bridge } from '../bridge';
import { useI18n } from '../i18n';
import { Icon, type IconName } from '../components/Icon';
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  Field,
  Meter,
  Modal,
  Stat,
  useConfirm,
  useToast,
  bytes,
  when,
} from '../components/UI';
import { BatchCreateModal } from './BatchCreateModal';
import { messageOf } from '../util';
import type { AppSettings } from '../../shared/types';
import { useSubscription } from '../cloud/subscription';
import { FREE_PROFILE_LIMIT } from '../cloud/client';
import { ActivateDialog } from '../components/ActivateDialog';

/**
 * Tools and data.
 *
 * The original packed this into a Tools page with tiles: batch create, import and export, a proxy
 * batch test, network diagnostics, a cookie manager, the extension folder, the recycle bin, cache
 * clearing, the workspace audit and the report. Those tiles are here, plus the storage figure the
 * original only showed as a single number: what every profile folder actually takes up, so
 * "clear the cache" is a decision with a size attached.
 */

/**
 * The chip colours, in the order the tiles use them.
 *
 * The original gave every tool a colour from a fixed palette and cycled through it. The tiles
 * are recognisable by their colour before their name is read, which is the whole point of a
 * coloured chip.
 */
const TINTS = ['#4c8dff', '#14b8a6', '#8b5cf6', '#f59e0b', '#ec4899', '#22c55e', '#06b6d4', '#6366f1', '#64748b'] as const;

export function ToolsPage({
  profiles,
  refreshProfiles,
  onNavigate,
}: {
  profiles: ProfileSummary[];
  refreshProfiles: () => Promise<void>;
  onNavigate: (page: 'settings' | 'proxies' | 'extensions' | 'browsers') => void;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const subscription = useSubscription();
  const [activateOpen, setActivateOpen] = useState(false);
  const remaining = subscription.tier === 'free' ? Math.max(0, FREE_PROFILE_LIMIT - profiles.length) : undefined;

  const [stats, setStats] = useState<StoreStats | null>(null);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [audit, setAudit] = useState<AuditReport | null>(null);
  const [cookies, setCookies] = useState<CookieSummary[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [batching, setBatching] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [cookiesOpen, setCookiesOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [nextStats, nextTrash, nextCookies, nextSettings] = await Promise.all([
        bridge().getStoreStats(),
        bridge().listTrash().catch(() => []),
        bridge().listCookieSessions().catch(() => []),
        bridge().getSettings(),
      ]);
      setStats(nextStats);
      setTrash(nextTrash);
      setCookies(nextCookies);
      setSettings(nextSettings);
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const tile = (
    icon: IconName,
    title: string,
    description: string,
    tint: string,
    actionLabel: string,
    action: () => void,
    busyKey?: string,
  ) => (
    <div className="tile">
      <div
        className="tile-icon"
        style={{ background: `color-mix(in srgb, ${tint} 26%, var(--panel))`, color: tint }}
      >
        {busyKey && busy === busyKey ? <span className="spinner" /> : <Icon name={icon} />}
      </div>
      <div className="tile-title">{title}</div>
      <div className="tile-desc">{description}</div>
      <div className="tile-foot">
        <button
          className="tile-action"
          type="button"
          onClick={action}
          disabled={Boolean(busyKey && busy === busyKey)}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );

  const runAudit = async () => {
    setBusy('audit');
    try {
      const result = await bridge().runWorkspaceAudit();
      setAudit(result);
      setInspecting(true);
    } catch (error) {
      toast.error(t('audit.title'), messageOf(error));
    } finally {
      setBusy('');
    }
  };

  const cleanCaches = async () => {
    const ok = await confirm.ask({
      title: t('set.clean.now'),
      body: t('set.clean.body'),
      confirmLabel: t('btn.clean'),
    });
    if (!ok) return;
    setBusy('clean');
    try {
      const freed = await bridge().clearAllCaches();
      toast.success(t('tools.freed').replace('{size}', bytes(freed)));
      await load();
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    } finally {
      setBusy('');
    }
  };

  const usedPercent = stats && stats.freeBytes > 0
    ? Math.min(100, Math.round((100 * stats.storeBytes) / (stats.storeBytes + stats.freeBytes)))
    : 0;

  return (
    <>
      <header className="header">
        <div className="header-titles">
          <h1>{t('tools.title')}</h1>
          <div className="sub">{t('sub.tools')}</div>
        </div>
        <div className="header-actions">
          <Button variant="soft" icon="folder" onClick={() => void bridge().openDataDir()}>
            {t('set.data.open')}
          </Button>
          <Button variant="soft" icon="terminal" onClick={() => void bridge().openLogsDir()}>
            {t('set.logs.open')}
          </Button>
          <Button variant="primary" icon="info" onClick={() => setReporting(true)}>
            {t('tools.report')}
          </Button>
        </div>
      </header>

      <div className="content">
        <div className="content-inner tools-content">
          <div className="tiles">
            {tile('layers', t('tools.batch'), t('tools.batch.hint'), TINTS[0], t('btn.batch'), () => subscription.tier === 'free' ? setActivateOpen(true) : setBatching(true))}
            {tile('download', t('tools.import'), t('tools.import.hint'), TINTS[1], t('btn.import'), async () => {
              setBusy('import');
              try {
                const count = await bridge().importProfiles(remaining);
                await refreshProfiles();
                if (count > 0) toast.success(t('btn.import'), String(count));
              } catch (error) {
                toast.error(t('err.generic'), messageOf(error));
              } finally {
                setBusy('');
              }
            }, 'import')}
            {tile('save', t('tools.export'), t('tools.export.hint'), TINTS[2], t('btn.export'), async () => {
              setBusy('export');
              try {
                const file = await bridge().exportProfiles();
                if (file) toast.success(t('btn.export'), file);
              } catch (error) {
                toast.error(t('err.generic'), messageOf(error));
              } finally {
                setBusy('');
              }
            }, 'export')}
            {tile('proxy', t('tools.proxy'), t('tools.proxy.hint'), TINTS[3], t('btn.testall'), () => onNavigate('proxies'))}
            {tile('wifi', t('tools.net'), t('tools.net.hint'), TINTS[4], t('btn.check'), () => onNavigate('proxies'))}
            {tile('cookie', t('tools.cookies'), t('tools.cookies.hint'), TINTS[5], t('btn.open'), () => setCookiesOpen(true))}
            {tile('extensions', t('tools.ext'), t('tools.ext.hint'), TINTS[6], t('btn.open'), () => onNavigate('extensions'))}
            {tile('trash', t('tools.trash'), t('tools.trash.hint'), TINTS[7], t('btn.restore'), () => {
              document.getElementById('joe-trash')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            })}
            {tile('archive', t('tools.clean'), t('tools.clean.hint'), TINTS[8], t('btn.clean'), cleanCaches, 'clean')}
            {tile('layers', t('tools.audit'), t('tools.audit.hint'), TINTS[0], t('btn.audit'), runAudit, 'audit')}
            {tile('cpu', t('tools.gpu'), t('tools.gpu.hint'), TINTS[1], t('btn.view'), () => onNavigate('browsers'))}
            {tile('terminal', t('tools.logs'), t('tools.logs.hint'), TINTS[2], t('btn.open'), () => void bridge().openLogsDir())}
          </div>

          <div className="section-label">{t('tools.storage')}</div>
          <div className="stat-grid">
            <Stat icon="profiles" value={profiles.length} label={t('set.stat.profiles')} />
            <Stat icon="database" value={stats ? bytes(stats.storeBytes) : '—'} label={t('set.stat.store')} />
            <Stat icon="save" value={stats ? bytes(stats.freeBytes) : '—'} label={t('set.stat.free')} />
            <Stat icon="browsers" value={stats ? bytes(stats.kernelsBytes) : '—'} label={t('set.stat.kernels')} />
            <Stat icon="history" value={stats ? bytes(stats.historyBytes) : '—'} label={t('set.stat.history')} />
            <Stat icon="trash" value={stats ? bytes(stats.trashBytes) : '—'} label={t('set.stat.trash')} />
          </div>

          {stats ? (
            <div className="panel" style={{ marginTop: 12 }}>
              <div className="spread" style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 570 }}>{t('set.data')}</span>
                <span className="faint mono storage-path" style={{ fontSize: 11.5 }}>{stats.dataDir}</span>
              </div>
              <Meter value={usedPercent} tone={usedPercent > 90 ? 'err' : usedPercent > 70 ? 'warn' : 'ok'} />

              {stats.perProfile.length > 0 ? (
                <div style={{ marginTop: 14 }}>
                  <div className="rows">
                    {[...stats.perProfile]
                      .sort((a, b) => b.bytes - a.bytes)
                      .slice(0, 12)
                      .map((row) => (
                        <div className="row" key={row.id}>
                          <div className="row-main">
                            <div className="row-title">{row.name}</div>
                            <div className="row-sub">
                              {bytes(row.bytes)} total · {bytes(row.cacheBytes)} cache
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="archive"
                            onClick={async () => {
                              try {
                                const freed = await bridge().clearProfileData(row.id, 'cache');
                                toast.success(t('tools.freed').replace('{size}', bytes(freed)), row.name);
                                await load();
                              } catch (error) {
                                toast.error(t('err.generic'), messageOf(error));
                              }
                            }}
                          >
                            {t('btn.clean')}
                          </Button>
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : loading ? (
            <div className="empty">
              <span className="spinner" style={{ width: 20, height: 20, color: 'var(--accent)' }} />
            </div>
          ) : null}

          <div className="section-label" id="joe-trash">
            {t('trash.title')}
          </div>
          {trash.length === 0 ? (
            <EmptyState icon="trash" title={t('trash.empty')} body="" />
          ) : (
            <div className="rows">
              {trash.map((item) => (
                <div className="row" key={item.file}>
                  <div className="row-icon">
                    <Icon name="trash" />
                  </div>
                  <div className="row-main">
                    <div className="row-title">
                      {item.name}
                      {item.group ? <Chip tone="muted">{item.group}</Chip> : null}
                    </div>
                    <div className="row-sub">
                      {t('trash.deleted').replace('{when}', when(item.deletedAt))} · {bytes(item.bytes)}
                    </div>
                  </div>
                  <div className="row-actions">
                    <Button
                      size="sm"
                      variant="soft"
                      icon="refresh"
                      onClick={async () => {
                        if (remaining === 0) { setActivateOpen(true); return; }
                        try {
                          const id = await bridge().restoreTrash(item.file);
                          toast.success(t('trash.restored').replace('{name}', item.name), id);
                          await Promise.all([refreshProfiles(), load()]);
                        } catch (error) {
                          toast.error(t('err.generic'), messageOf(error));
                        }
                      }}
                    >
                      {t('btn.restore')}
                    </Button>
                  </div>
                </div>
              ))}
              <div className="row">
                <div className="grow" />
                <Button
                  size="sm"
                  variant="danger"
                  icon="trash"
                  busy={busy === 'empty'}
                  onClick={async () => {
                    const ok = await confirm.ask({
                      title: t('trash.emptyBin'),
                      body: t('trash.emptyBin.body'),
                      confirmLabel: t('trash.emptyBin'),
                      danger: true,
                    });
                    if (!ok) return;
                    setBusy('empty');
                    try {
                      const before = stats?.trashBytes ?? 0;
                      await bridge().emptyTrash();
                      toast.success(t('trash.emptied').replace('{size}', bytes(before)));
                      await load();
                    } catch (error) {
                      toast.error(t('err.generic'), messageOf(error));
                    } finally {
                      setBusy('');
                    }
                  }}
                >
                  {t('trash.emptyBin')}
                </Button>
              </div>
            </div>
          )}

          {settings?.useTrash === false ? (
            <div style={{ marginTop: 10 }}>
              <Banner tone="warn" icon="info">
                The recycle bin is off, so a deleted profile is erased immediately. Turn it back on in Settings.
              </Banner>
            </div>
          ) : null}
        </div>
      </div>

      <ActivateDialog open={activateOpen} onClose={() => setActivateOpen(false)} onActivated={() => void subscription.refresh()} />
      {batching ? (
        <BatchCreateModal
          settings={settings ?? ({} as AppSettings)}
          onClose={() => setBatching(false)}
          onCreated={async () => {
            setBatching(false);
            await refreshProfiles();
            await load();
          }}
        />
      ) : null}

      {reporting ? <ReportModal onClose={() => setReporting(false)} /> : null}

      {cookiesOpen ? (
        <CookieModal
          profiles={profiles}
          sessions={cookies}
          onClose={() => setCookiesOpen(false)}
          onChanged={load}
        />
      ) : null}

      {inspecting && audit ? (
        <Modal
          title={t('audit.title')}
          subtitle={t('audit.checked')
            .replace('{n}', String(audit.profiles))
            .replace('{time}', new Date(audit.checkedAt).toLocaleTimeString())}
          onClose={() => setInspecting(false)}
          footer={
            <>
              {audit.findings.length > 0 ? (
                <Button
                  variant="primary"
                  icon="refresh"
                  busy={busy === 'fix'}
                  onClick={async () => {
                    setBusy('fix');
                    try {
                      const result = await bridge().repairWorkspace();
                      if (result.changed > 0) {
                        toast.success(t('audit.fixed').replace('{n}', String(result.changed)));
                        if (result.failed > 0) {
                          toast.warn(t('audit.fix.failed').replace('{n}', String(result.failed)));
                        }
                        await refreshProfiles();
                        const next = await bridge().runWorkspaceAudit();
                        setAudit(next);
                      } else if (result.failed > 0) {
                        toast.error(t('audit.fix.failed').replace('{n}', String(result.failed)));
                      } else {
                        toast.warn(t('audit.fix.none'));
                      }
                    } catch (error) {
                      toast.error(t('audit.title'), messageOf(error));
                    } finally {
                      setBusy('');
                    }
                  }}
                >
                  {t('audit.fix')}
                </Button>
              ) : null}
              <div className="spacer" />
              <Button variant="ghost" onClick={() => setInspecting(false)}>
                {t('btn.close')}
              </Button>
              <Button variant="soft" icon="refresh" onClick={runAudit} busy={busy === 'audit'}>
                {t('btn.audit')}
              </Button>
            </>
          }
        >
          {audit.findings.length === 0 ? (
            <EmptyState icon="check" title={t('audit.clean')} body="" />
          ) : (
            <div className="stack">
              {audit.findings.map((finding, index) => (
                <div className={`finding ${finding.severity}`} key={index}>
                  <div className="badge">
                    {finding.severity === 'high' ? '!' : finding.severity === 'medium' ? '~' : 'i'}
                  </div>
                  <div className="grow">
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{finding.summary}</div>
                    <div className="hint" style={{ marginTop: 3 }}>{finding.detail}</div>
                    <div className="cluster" style={{ marginTop: 7 }}>
                      <Chip tone="muted">{t(`audit.kind.${finding.kind}`, finding.kind)}</Chip>
                      {finding.profiles.map((profile) => (
                        <Chip key={profile.id} tone="accent">{profile.name}</Chip>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      ) : null}

      {confirm.dialog}
    </>
  );
}

/* ------------------------------------------------------------------ report */

function ReportModal({ onClose }: { onClose: () => void }): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [payload, setPayload] = useState<ReportPayload | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        setPayload(await bridge().reportPayload(note));
      } catch (error) {
        toast.error(t('rep.title'), messageOf(error));
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal
      title={t('rep.title')}
      subtitle={t('rep.sub')}
      onClose={onClose}
      width="wide"
      footer={
        <>
          <div className="spacer" />
          <Button
            variant="soft"
            icon="copy"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const next = await bridge().reportPayload(note);
                setPayload(next);
                await navigator.clipboard?.writeText(`${next.summary}\n\n${note}\n\n${next.details}\n\n${next.logTail}`);
                toast.success(t('rep.copied'));
              } catch (error) {
                toast.error(t('rep.title'), messageOf(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('rep.copy')}
          </Button>
          <Button variant="primary" icon="telegram" onClick={() => payload && void bridge().openExternal(payload.telegram)}>
            {t('rep.telegram')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('rep.note')} hint={t('rep.note.hint')}>
          <textarea className="textarea" rows={4} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>

        <Banner tone="info" icon="info">
          {t('rep.includes')}
        </Banner>

        {payload ? (
          <>
            <Field label={t('set.about')}>
              <pre className="input mono" style={{ height: 'auto', padding: 10, whiteSpace: 'pre-wrap', fontSize: 11.5, lineHeight: 1.6 }}>{payload.details}</pre>
            </Field>

            <Field label={t('rep.log')}>
              <pre className="input mono" style={{ height: 150, padding: 10, overflow: 'auto', whiteSpace: 'pre', fontSize: 11, lineHeight: 1.5 }}>
                {payload.logTail}
              </pre>
            </Field>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ cookies */

/**
 * The cookie manager.
 *
 * One row per profile that has a cookie store, with how many cookies and how many domains it
 * holds. Export writes a text file a person can keep; import reads one back. This is the page
 * that makes "log in once, then make ten profiles from it" possible without touching a folder.
 */
function CookieModal({
  profiles,
  sessions,
  onClose,
  onChanged,
}: {
  profiles: ProfileSummary[];
  sessions: CookieSummary[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();

  const [busy, setBusy] = useState('');
  const [target, setTarget] = useState(sessions[0]?.profileId ?? profiles[0]?.id ?? '');

  const total = sessions.reduce((sum, row) => sum + row.count, 0);

  return (
    <Modal
      title={t('tools.cookies')}
      subtitle={t('tools.cookies.hint')}
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ fontSize: 11.8 }}>
            {total} cookies across {sessions.length} profiles
          </span>
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            {t('btn.close')}
          </Button>
          <Button
            variant="soft"
            icon="download"
            busy={busy === 'import'}
            disabled={!target}
            onClick={async () => {
              setBusy('import');
              try {
                const count = await bridge().importCookies(target);
                if (count > 0) {
                  toast.success(t('btn.import'), `${count} cookies`);
                  await onChanged();
                }
              } catch (error) {
                toast.error(t('err.generic'), messageOf(error));
              } finally {
                setBusy('');
              }
            }}
          >
            {t('btn.import')}
          </Button>
          <Button
            variant="primary"
            icon="save"
            busy={busy === 'export'}
            disabled={!target}
            onClick={async () => {
              setBusy('export');
              try {
                const file = await bridge().exportCookies(target);
                if (file) toast.success(t('btn.export'), file);
              } catch (error) {
                toast.error(t('err.generic'), messageOf(error));
              } finally {
                setBusy('');
              }
            }}
          >
            {t('btn.export')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('cookie.target')} hint={t('cookie.target.hint')}>
          <select className="select" value={target} onChange={(event) => setTarget(event.target.value)}>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </Field>

        {sessions.length === 0 ? (
          <EmptyState icon="cookie" title={t('cookie.empty')} body={t('cookie.empty.body')} />
        ) : (
          <div className="rows">
            {sessions.map((row) => (
              <div className="row" key={row.profileId}>
                <div className="row-icon">
                  <Icon name="cookie" />
                </div>
                <div className="row-main">
                  <div className="row-title">{row.profileName}</div>
                  <div className="row-sub">
                    {row.count} cookies · {row.domains} domains
                  </div>
                </div>
                <div className="row-actions">
                  <Button size="sm" variant="ghost" icon="download" onClick={() => setTarget(row.profileId)}>
                    {t('cookie.select')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <Banner tone="info" icon="info">
          {t('cookie.hint')}
        </Banner>
      </div>
    </Modal>
  );
}
