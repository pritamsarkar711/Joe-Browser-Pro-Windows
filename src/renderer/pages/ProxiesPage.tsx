import { parseProxyLine } from '../../shared/parseProxy';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { NetworkReport, ProfileSummary, ProxyBatchRow, ProxyConfig, ProxyEntry } from '../../shared/types';
import { PROXY_TYPES } from '../../shared/types';
import { bridge } from '../bridge';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';
import { CountryFlag } from '../components/CountryFlag';
import { countryName } from '../../shared/countries';
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  Field,
  Menu,
  Modal,
  SearchInput,
  Segmented,
  useConfirm,
  useToast,
} from '../components/UI';
import { messageOf } from '../util';
import { useSubscription } from '../cloud/subscription';
import { FREE_PROFILE_LIMIT } from '../cloud/client';
import { ActivateDialog } from '../components/ActivateDialog';

/**
 * The proxy vault.
 *
 * A saved proxy is a reusable asset: it carries where it came from, what it last answered, and
 * which profiles use it. That last column is the one that matters most - two profiles behind one
 * exit address is the easiest link a site can draw, so the page says so out loud.
 *
 * The row actions are the original's: a bolt to test, a plus to make a profile from it, a pencil
 * to edit, a bin to delete. Testing all is one button because "which of these still work" is the
 * question people actually have after a month.
 */

export function ProxiesPage({
  profiles,
  refreshProfiles,
}: {
  profiles: ProfileSummary[];
  refreshProfiles: () => Promise<void>;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const subscription = useSubscription();
  const [activateOpen, setActivateOpen] = useState(false);

  const [entries, setEntries] = useState<ProxyEntry[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ProxyEntry | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [batchTesting, setBatchTesting] = useState(false);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [testingAll, setTestingAll] = useState(false);
  const [creatingFrom, setCreatingFrom] = useState('');
  const [network, setNetwork] = useState<NetworkReport | null>(null);
  const diagnosticsSequence = useRef(0);
  const [loadingNetwork, setLoadingNetwork] = useState(false);
  const [networkLabel, setNetworkLabel] = useState('');
  const [risk, setRisk] = useState<{ ip: string; score: number; proxy: string; type: string } | null>(null);
  const [riskError, setRiskError] = useState('');
  const [riskLoading, setRiskLoading] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setEntries(await bridge().listProxies());
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      [entry.name, entry.note, entry.config.host, entry.config.type, entry.lastCountry, entry.lastCity]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [entries, query]);

  const test = async (entry: ProxyEntry) => {
    setTesting((current) => new Set(current).add(entry.id));
    try {
      const updated = await bridge().testProxyEntry(entry.id);
      setEntries((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      if (updated.lastStatus === 1) {
        toast.success(
          t('proxy.working'),
          `${updated.lastIp || updated.config.host} · ${countryName(updated.lastCountryCode, updated.lastCountry)} · ${updated.lastLatencyMs} ms`,
        );
      } else {
        toast.error(t('proxy.failed'), `${updated.config.host}:${updated.config.port}`);
      }
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    } finally {
      setTesting((current) => {
        const next = new Set(current);
        next.delete(entry.id);
        return next;
      });
    }
  };

  const testAll = async () => {
    setTestingAll(true);
    try {
      const updated = await bridge().testAllProxies();
      setEntries(updated);
      const working = updated.filter((row) => row.lastStatus === 1).length;
      toast.success(t('btn.testall'), `${working}/${updated.length}`);
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    } finally {
      setTestingAll(false);
    }
  };

  const createProfile = async (entry: ProxyEntry) => {
    if (subscription.tier === 'free' && profiles.length >= FREE_PROFILE_LIMIT) { setActivateOpen(true); return; }
    setCreatingFrom(entry.id);
    try {
      const created = await bridge().createProfileFromProxy(entry.id);
      await refreshProfiles();
      toast.success(t('proxy.use'), created.name);
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    } finally {
      setCreatingFrom('');
    }
  };

  const remove = async (entry: ProxyEntry) => {
    const ok = await confirm.ask({
      title: t('btn.delete'),
      body: t('proxy.delete.body').replace('{name}', entry.name || `${entry.config.host}:${entry.config.port}`),
      confirmLabel: t('btn.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await bridge().deleteProxy(entry.id);
      await load();
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    }
  };

  const diagnostics = async (entry: ProxyEntry | null) => {
    const sequence = ++diagnosticsSequence.current;
    setLoadingNetwork(true);
    setNetwork(null);
    setRisk(null);
    setRiskError('');
    setNetworkLabel(entry ? (entry.name || `${entry.config.host}:${entry.config.port}`) : t('proxy.direct'));
    try {
      const report = await bridge().networkReport(entry?.id);
      if (sequence === diagnosticsSequence.current) setNetwork(report);
    } catch (error) {
      if (sequence === diagnosticsSequence.current) toast.error(t('net.title'), messageOf(error));
    } finally {
      if (sequence === diagnosticsSequence.current) setLoadingNetwork(false);
    }
  };

  const working = entries.filter((entry) => entry.lastStatus === 1).length;
  const failing = entries.filter((entry) => entry.lastStatus === -1).length;

  return (
    <>
      <header className="header">
        <div className="header-titles">
          <h1>{t('proxy.title')}</h1>
          {entries.length ? <div className="sub">{entries.length} saved · {working} working{failing ? ` · ${failing} failing` : ''}</div> : null}
        </div>
        <div className="header-actions">
          <SearchInput value={query} onChange={setQuery} placeholder={t('search.proxies')} />
          <Button variant="soft" icon="speed" onClick={testAll} busy={testingAll}>
            {t('proxy.checkall')}
          </Button>
          <Button variant="soft" icon="wifi" onClick={() => void diagnostics(null)}>
            {t('net.title')}
          </Button>
          <Button variant="soft" icon="speed" onClick={() => setBatchTesting(true)}>
            {t('tools.proxy')}
          </Button>
          <Button variant="soft" icon="upload" onClick={() => setImporting(true)}>
            {t('proxy.import')}
          </Button>
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            {t('proxy.add')}
          </Button>
        </div>
      </header>

      <div className="content">
        <div className="content-inner">
          {network || loadingNetwork ? (
            <section className="panel network-panel" aria-label={t('net.title')}>
              <div className="network-heading">
                <div><h3>{t('net.title')}</h3><span className="muted">{networkLabel}</span></div>
                {loadingNetwork ? <span className="spinner" /> : null}
                <button className="icon-btn sm" onClick={() => setNetwork(null)} type="button" aria-label={t('btn.close')} disabled={loadingNetwork}><Icon name="close" /></button>
              </div>
              {network ? <>
                {!network.ok ? <Banner tone="err" icon="info">{network.error || 'Lookup failed.'}</Banner> : <>
                  <dl className="network-grid">
                    {[
                      [t('net.exit'), network.ip], [t('net.country'), network.country], [t('net.city'), network.city],
                      [t('net.tz'), network.timezone], [t('net.isp'), network.isp], ['Lookup time', `${network.latencyMs} ms`],
                    ].map(([label, value]) => <div className="network-item" key={label}><dt>{label}</dt><dd>{label === t('net.country') && network.countryCode ? <CountryFlag code={network.countryCode} /> : null}{(label === t('net.country') ? countryName(network.countryCode, value) : value) || '—'}</dd></div>)}
                  </dl>
                  <div className="risk-row">
                    <div><strong>IP risk</strong><div className="hint">Sends the exit IP to proxycheck.io from this device.</div></div>
                    <Button size="sm" variant="soft" busy={riskLoading} onClick={async () => {
                      setRiskError(''); setRisk(null); setRiskLoading(true);
                      try { setRisk(await bridge().checkIpRisk(network.ip)); } catch (error) { setRiskError(messageOf(error)); } finally { setRiskLoading(false); }
                    }}>Check risk</Button>
                  </div>
                  {risk && risk.ip === network.ip ? <div className="risk-result">Score: <strong>{risk.score}/100</strong>{risk.type ? ` · ${risk.type}` : ''}<span className="hint"> · Provider estimate, not proof of fraud</span></div> : null}
                  {riskError ? <div className="hint" role="alert">{riskError}</div> : null}
                </>}
                {network.warnings.length ? <details className="network-details"><summary>Lookup details ({network.warnings.length})</summary>{network.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details> : null}
              </> : null}
            </section>
          ) : null}

          {entries.length === 0 && !loading ? (
            <EmptyState
              icon="proxy"
              title={t('proxy.empty')}
              body=""
              action={
                <div className="cluster" style={{ justifyContent: 'center' }}>
                  <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
                    {t('proxy.add')}
                  </Button>
                  <Button variant="soft" icon="upload" onClick={() => setImporting(true)}>
                    {t('proxy.import')}
                  </Button>
                </div>
              }
            />
          ) : visible.length === 0 ? (
            <EmptyState icon="search" title={t('empty.nomatch')} body="" />
          ) : (
            <div className="rows">
              {visible.map((entry) => {
                const busy = testing.has(entry.id);
                return (
                  <div className="row proxy-row" key={entry.id}>
                    <div className="proxy-flag">{busy ? <span className="spinner" /> : entry.lastCountryCode ? <CountryFlag code={entry.lastCountryCode} size={36} /> : <Icon name="globe" />}</div>

                    <div className="row-main">
                      <div className="row-title">
                        <span className="truncate">{entry.name || `${entry.config.host}:${entry.config.port}`}</span>
                        <Chip tone="muted">{entry.config.type.toUpperCase()}</Chip>
                        <Chip tone={entry.lastStatus === 1 ? 'accent' : 'muted'}>{entry.lastStatus === 1 ? 'Working' : entry.lastStatus === -1 ? 'Failed' : 'Not tested'}</Chip>
                        {entry.usedBy > 0 ? (
                          <Chip tone="accent" icon="profiles">
                            {t('proxy.used.n').replace('{n}', String(entry.usedBy))}
                          </Chip>
) : null}
                        {entry.usedBy > 1 ? (
                          <Chip tone="warn" icon="link" title="Two profiles behind one address are easy to link">
                            shared
                          </Chip>
                        ) : null}
                      </div>
                      <div className="row-sub">
                        <span className="mono">
                          {entry.config.type === 'none' ? '—' : `${entry.config.host || '—'}:${entry.config.port || '—'}`}
                        </span>
                        {entry.lastCountry ? ` · ${countryName(entry.lastCountryCode, entry.lastCountry)}${entry.lastCity ? `, ${entry.lastCity}` : ''}` : ''}
                        {entry.lastLatencyMs ? ` · ${entry.lastLatencyMs} ms` : ''}
                        {!entry.lastCountry ? ' · Country unknown' : ''}
                      </div>
                    </div>

                    <div className="row-actions">
                      <Button size="sm" variant="soft" icon="speed" onClick={() => void test(entry)} busy={busy}>
                        {t('btn.test')}
                      </Button>
                      <Button size="sm" variant="ghost" icon="plus" onClick={() => void createProfile(entry)} title={t('proxy.use')} busy={creatingFrom === entry.id} />
                      <Button size="sm" variant="ghost" icon="wifi" onClick={() => void diagnostics(entry)} title={t('net.title')} />
                      <Menu
                        actions={[
                          { label: t('generic.edit'), icon: 'edit', onClick: () => setEditing(entry) },
                          { label: t('proxy.use'), icon: 'plus', onClick: () => void createProfile(entry) },
                          { separator: true, label: '', onClick: () => undefined },
                          {
                            label: t('generic.copy'),
                            icon: 'copy',
                            onClick: async () => {
                              try {
                                const saved = await bridge().getSavedProxy(entry.id);
                                const text = `${saved.config.host}:${saved.config.port}${saved.config.user ? `:${saved.config.user}:${saved.password ?? ''}` : ''}`;
                                await navigator.clipboard.writeText(text);
                                toast.success(t('generic.copied'));
                              } catch (error) { toast.error(t('err.generic'), messageOf(error)); }
                            },
                          },
                          { separator: true, label: '', onClick: () => undefined },
                          { label: t('btn.delete'), icon: 'trash', danger: true, onClick: () => void remove(entry) },
                        ]}
                        trigger={(openMenu) => <button className="icon-btn" onClick={openMenu} type="button" aria-label="More"><Icon name="dotVertical" /></button>}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}


        </div>
      </div>

      {editing ? (
        <ProxyEditor
          entry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onChecked={load}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      ) : null}

      {importing ? (
        <ImportModal
          onClose={() => setImporting(false)}
          onImported={async () => {
            setImporting(false);
            await load();
          }}
        />
      ) : null}

      {batchTesting ? <BatchTestModal onClose={() => setBatchTesting(false)} /> : null}

      <ActivateDialog open={activateOpen} onClose={() => setActivateOpen(false)} onActivated={() => void subscription.refresh()} />
      {confirm.dialog}
    </>
  );
}

/* ------------------------------------------------------------------ batch test */

/**
 * Check a pasted list before any of it is saved.
 *
 * The original had this as its own Tools tile and it is the difference between buying a proxy
 * list and using one: a hundred lines go in, the dead ones come out, and nothing enters the
 * library until the working ones do. Rows are shown as they were pasted so a failure can be
 * pointed at rather than guessed at.
 */
function BatchTestModal({ onClose }: { onClose: () => void }): ReactNode {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<ProxyBatchRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true);
    setError('');
    setRows(null);
    try {
      setRows(await bridge().testProxyLines(text));
    } catch (problem) {
      setError(messageOf(problem));
    } finally {
      setBusy(false);
    }
  };

  const parsed = text.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean).length;
  const working = (rows ?? []).filter((row) => row.ok).length;

  return (
    <Modal
      title={t('tools.proxy')}
      onClose={onClose}
      width="wide"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('btn.close')}
          </Button>
          <Button
            variant="primary"
            icon="speed"
            busy={busy}
            disabled={parsed === 0}
            onClick={() => void run()}
          >
            {t('proxy.testline').replace('{n}', String(parsed))}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('proxy.lines')}>
          <textarea
            className="input mono"
            rows={6}
            spellCheck={false}
            value={text}
            placeholder={'http://user:pass@host:port\nsocks5://host:port'}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>

        {error ? (
          <Banner tone="err" icon="info">
            {error}
          </Banner>
        ) : null}

        {busy ? (
          <div className="cluster faint" style={{ fontSize: 12.5 }}>
            <span className="spinner" /> {t('proxy.testing').replace('{n}', String(parsed))}
          </div>
        ) : null}

        {rows ? (
          rows.length === 0 ? (
            <div className="hint">{t('proxy.empty')}</div>
          ) : (
            <>
              <div className="cluster" style={{ gap: 6 }}>
                <Chip tone={working > 0 ? 'ok' : 'err'}>
                  {t('proxy.working').replace('{ok}', String(working))}
                </Chip>
                <Chip tone={working === rows.length ? 'muted' : 'err'}>
                  {t('proxy.failing').replace('{n}', String(rows.length - working))}
                </Chip>
              </div>
              <div className="rows">
                {rows.map((row, index) => (
                  <div className="row" key={`${row.line}-${index}`}>
                    <div className="row-icon" style={{ color: row.ok ? 'var(--ok)' : 'var(--err)' }}>
                      <Icon name={row.ok ? 'check' : 'close'} />
                    </div>
                    <div className="row-main">
                      <div className="row-title mono" style={{ fontSize: 12.5 }}>
                        {row.host ? `${row.host}:${row.port}` : row.line}
                      </div>
                      <div className="row-sub">
                        {row.ok
                          ? `${row.ip}${row.country ? ` · ${row.country}` : ''} · ${row.latencyMs} ms`
                          : row.error || t('proxy.unreachable')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ editor */

function ProxyEditor({
  entry,
  onClose,
  onSaved,
  onChecked,
}: {
  entry: ProxyEntry | null;
  onClose: () => void;
  onSaved: () => void;
  onChecked: () => void;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();

  const [name, setName] = useState(entry?.name ?? '');
  const [note, setNote] = useState(entry?.note ?? '');
  const [type, setType] = useState<ProxyConfig['type']>(entry?.config.type ?? 'http');
  const [host, setHost] = useState(entry?.config.host ?? '');
  const [port, setPort] = useState(entry?.config.port ?? 8080);
  const [user, setUser] = useState(entry?.config.user ?? '');
  const [password, setPassword] = useState(entry?.password ?? '');
  const [replacePassword, setReplacePassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState('');

  const config = (): ProxyConfig => ({
    ...(entry?.config ?? {
      type,
      host,
      port,
      user,
      passwordEnc: '',
      lastIp: '',
      lastCountry: '',
      lastCountryCode: '',
      lastTimezone: '',
      lastCity: '',
      fallbackDirect: false,
    }),
    type,
    host,
    port,
    user,
    password,
  });

  const check = async () => {
    setChecking(true);
    setResult('');
    try {
      const outcome = await bridge().checkProxy(config(), password);
      setResult(
        outcome.ok
          ? `${outcome.ip} · ${outcome.country}${outcome.city ? `, ${outcome.city}` : ''} · ${outcome.latencyMs} ms`
          : outcome.error || t('proxy.failed'),
      );
    } catch (error) {
      setResult(messageOf(error));
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    if (!host.trim() || !port) {
      toast.warn(t('err.badProxy'), t('ed.host'));
      return;
    }
    setSaving(true);
    try {
      const saved = await bridge().saveProxy({ id: entry?.id, name, note, password, replacePassword, config: config() });
      if (!entry) void bridge().testProxyEntry(saved.id).then(() => onChecked()).catch(() => undefined);
      toast.success(t('btn.save'), name || `${host}:${port}`);
      onSaved();
    } catch (error) {
      toast.error(t('err.save'), messageOf(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={entry ? t('proxy.edit.title') : t('proxy.save.title')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" icon="speed" onClick={check} busy={checking}>
            {t('btn.test')}
          </Button>
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            {t('btn.cancel')}
          </Button>
          <Button variant="primary" icon="save" onClick={save} busy={saving}>
            {t('btn.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {result ? <Banner tone={/\d+\.\d+\.\d+\.\d+/.test(result) ? 'ok' : 'err'}>{result}</Banner> : null}

        <div className="form-grid">
          <Field label={t('proxy.name')} span={2}>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="UK residential" />
          </Field>

          <Field label={t('ed.ptype')} span={2}>
            <Segmented
              value={type}
              onChange={(next) => setType(next as ProxyConfig['type'])}
              options={PROXY_TYPES.filter((option) => option !== 'none').map((option) => ({ id: option, label: option.toUpperCase() }))}
            />
          </Field>

          <Field label={t('ed.host')}>
            <input className="input mono" value={host} onChange={(event) => setHost(event.target.value)} onKeyDown={(event) => {
              if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.key.toLowerCase() !== 'b') return;
              event.preventDefault(); event.stopPropagation();
              void bridge().proxyClipboard().then((parsed) => {
                if (!parsed) { toast.warn('Invalid proxy', 'Use host:port or host:port:user:password.'); return; }
                setType(parsed.type ?? 'http'); setHost(parsed.host ?? ''); setPort(parsed.port ?? 0);
                setUser(parsed.user ?? ''); setPassword(parsed.password ?? ''); setReplacePassword(true);
              }).catch((error: unknown) => toast.error('Clipboard', messageOf(error)));
            }} onPaste={(event) => {
              const parsed = parseProxyLine(event.clipboardData.getData('text'));
              if (!parsed) return;
              event.preventDefault();
              setType(parsed.type ?? 'http'); setHost(parsed.host ?? ''); setPort(parsed.port ?? 0);
              setUser(parsed.user ?? ''); setPassword(parsed.password ?? ''); setReplacePassword(true);
            }} placeholder="gate.example.com" spellCheck={false} />
          </Field>

          <Field label={t('ed.port')}>
            <input className="input mono num" type="number" value={port || ''} onChange={(event) => setPort(Number(event.target.value) || 0)} />
          </Field>

          <Field label={t('ed.user')}>
            <input className="input mono" value={user} onChange={(event) => setUser(event.target.value)} autoComplete="off" spellCheck={false} />
          </Field>

          <Field label={t('ed.pass')}>
            <input className="input mono" type="password" value={password} onChange={(event) => { setPassword(event.target.value); setReplacePassword(true); }} autoComplete="new-password" />
          </Field>

          <Field label={t('proxy.note')} span={2}>
            <input className="input" value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ import */

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title={t('proxy.import.title')}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            {t('btn.cancel')}
          </Button>
          <Button
            variant="primary"
            icon="upload"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await bridge().importProxyList(text);
                toast.success(t('proxy.import.added').replace('{n}', String(result.added)));
                if (result.failed.length > 0) {
                  toast.warn(t('proxy.import.failed').replace('{n}', String(result.failed.length)));
                }
                onImported();
              } catch (error) {
                toast.error(t('err.generic'), messageOf(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('btn.import')}
          </Button>
        </>
      }
    >
      <><p className="hint" style={{ marginBottom: 8 }}>One proxy per line</p><textarea
        className="textarea mono"
        rows={12}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={'gate.example.com:8080:user:password\n1.2.3.4:1080\nuser:pass@5.6.7.8:3128'}
        spellCheck={false}
      /></>
    </Modal>
  );
}
