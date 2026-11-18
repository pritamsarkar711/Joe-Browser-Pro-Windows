import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { HistoryEntry, HistoryProfile, ProfileSummary } from '../../shared/types';
import { bridge } from '../bridge';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';
import { Button, Chip, EmptyState, SearchInput, Toggle, useConfirm, useToast, when } from '../components/UI';
import { messageOf } from '../util';

/**
 * History.
 *
 * Two ways to read the same record: by page (everything, newest first, searchable) and by profile
 * (a row per profile with its count and last visit). The hop filter is the original's "only
 * passed through": a page a profile reached inside a redirect chain is real but is not a visit,
 * and a list that mixes the two is much harder to read.
 *
 * The page also answers the per-card "history" action: if a profile id arrives on the event bus it
 * opens straight onto that profile.
 */

export function HistoryPage({ profiles }: { profiles: ProfileSummary[] }): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const [view, setView] = useState<'pages' | 'profiles'>('pages');
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [byProfile, setByProfile] = useState<HistoryProfile[]>([]);
  const [query, setQuery] = useState('');
  const [includeHops, setIncludeHops] = useState(true);
  const [profileFilter, setProfileFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  // Paged like the original: 200 at a time, up to 1000 on screen. A profile that has browsed
  // for a month holds tens of thousands of entries and nothing else would paint promptly.
  const PAGE = 200;
  const MAX_SHOWN = 1000;
  const [shown, setShown] = useState(PAGE);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextEntries, nextProfiles] = await Promise.all([
        bridge().listAllHistory(3000, false),
        bridge().listHistoryProfiles(),
      ]);
      setEntries(nextEntries);
      setByProfile(nextProfiles);
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // The card menu's "History" lands here with a profile id.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      setProfileFilter(id);
      setView('pages');
    };
    window.addEventListener('joe:open-history', onOpen);
    return () => window.removeEventListener('joe:open-history', onOpen);
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (!includeHops && entry.hop) return false;
      if (profileFilter && entry.profileId !== profileFilter) return false;
      if (!needle) return true;
      return (
        entry.url.toLowerCase().includes(needle) ||
        entry.title.toLowerCase().includes(needle) ||
        entry.profileName.toLowerCase().includes(needle)
      );
    });
  }, [entries, query, includeHops, profileFilter]);

  const activeProfile = profiles.find((profile) => profile.id === profileFilter);

  return (
    <>
      <header className="header">
        <div className="header-titles">
          <h1>{t('hist.title')}</h1>
          <div className="sub">
            {activeProfile ? `${activeProfile.name} · ` : ''}
            {t('count.matching').replace('{n}', String(visible.length))}
            {byProfile.length > 0 ? ` · ${t('count.profiles').replace('{n}', String(byProfile.length))}` : ''}
          </div>
        </div>
        <div className="header-actions">
          <SearchInput value={query} onChange={setQuery} placeholder={t('search.history')} />
          <Button
            variant="soft"
            icon="trash"
            onClick={async () => {
              const ok = await confirm.ask({
                title: activeProfile ? t('hist.confirm.title') : t('hist.confirm.all'),
                body: (activeProfile ? t('hist.confirm.body') : t('hist.confirm.all.body')).replace('{name}', activeProfile?.name ?? ''),
                confirmLabel: t('history.clear'),
                danger: true,
              });
              if (!ok) return;
              const freed = activeProfile ? await bridge().clearHistory(activeProfile.id) : await bridge().clearAllHistory();
              toast.success(activeProfile ? t('hist.cleared') : t('hist.cleared.all'), `${Math.round(freed / 1024)} KB`);
              await load();
            }}
          >
            {t('history.clear')}
          </Button>
        </div>
      </header>

      <div className="content">
        <div className="content-inner">
          <div className="spread" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
            <div className="cluster">
              <button
                className={`btn btn-sm${view === 'pages' ? ' btn-primary' : ' btn-soft'}`}
                onClick={() => setView('pages')}
                type="button"
              >
                <Icon name="list" size={13} />
                {t('history.all')}
              </button>
              <button
                className={`btn btn-sm${view === 'profiles' ? ' btn-primary' : ' btn-soft'}`}
                onClick={() => setView('profiles')}
                type="button"
              >
                <Icon name="profiles" size={13} />
                {t('hist.perProfile')}
              </button>
            </div>

            <div className="cluster">
              <select
                className="select"
                style={{ width: 200 }}
                value={profileFilter}
                onChange={(event) => setProfileFilter(event.target.value)}
              >
                <option value="">{t('history.back')}</option>
                {byProfile.map((row) => (
                  <option key={row.profileId} value={row.profileId}>
                    {row.profileName} ({row.count})
                  </option>
                ))}
              </select>
              <Toggle checked={includeHops} onChange={setIncludeHops} label={t('history.hops')} />
            </div>
          </div>

          {view === 'profiles' ? (
            byProfile.length === 0 ? (
              <EmptyState
                icon="history"
                title={t('history.empty')}
                body=""
              />
            ) : (
              <div className="rows">
                {byProfile.map((row) => {
                  const profile = profiles.find((entry) => entry.id === row.profileId);
                  return (
                    <div className="row clickable" key={row.profileId} onClick={() => {
                      setProfileFilter(row.profileId);
                      setView('pages');
                    }}>
                      <div className="row-icon">
                        <Icon name="history" />
                      </div>
                      <div className="row-main">
                        <div className="row-title">{row.profileName || profile?.name || t('history.deletedProfile')}</div>
                        <div className="row-sub">
                          {t('card.opened').replace('{when}', when(row.lastAt))}
                        </div>
                      </div>
                      <Chip tone="muted">{row.count}</Chip>
                      <Icon name="chevronRight" size={14} />
                    </div>
                  );
                })}
              </div>
            )
          ) : visible.length === 0 ? (
            <EmptyState
              icon="history"
              title={loading ? t('generic.loading') : t('history.empty')}
              body={query ? t('empty.nomatch.sub') : ""}
            />
          ) : (
            <div className="rows">
              {visible.slice(0, shown).map((entry, index) => (
                <div
                  className="hist-row"
                  key={`${entry.at}-${index}`}
                  onDoubleClick={async () => {
                    // The original's "open": the address goes back into the profile that visited
                    // it, not into the system browser, which would answer as this PC.
                    try {
                      await bridge().openInProfile(entry.profileId, entry.url);
                      toast.success(t('history.open'), entry.url);
                    } catch (error) {
                      toast.warn(t('err.notRunning'), messageOf(error));
                    }
                  }}
                  title={t('history.open.hint')}
                >
                  <span className="hist-time">{new Date(entry.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                  <div className="hist-main">
                    <div className="hist-title">{entry.title || entry.url}</div>
                    <div className="hist-url">{entry.url}</div>
                  </div>
                  <div className="cluster" style={{ gap: 6 }}>
                    {entry.hop ? <Chip tone="muted">hop</Chip> : null}
                    <Chip tone="accent" title={entry.profileName}>
                      {entry.profileName || 'deleted'}
                    </Chip>
                    <button
                      className="icon-btn sm"
                      type="button"
                      title={t('history.copy')}
                      onClick={(event) => {
                        event.stopPropagation();
                        void navigator.clipboard?.writeText(entry.url);
                        toast.success(t('generic.copied'), entry.url);
                      }}
                    >
                      <Icon name="copy" />
                    </button>
                    <button
                      className="icon-btn sm"
                      type="button"
                      title={t('history.open')}
                      onClick={async (event) => {
                        event.stopPropagation();
                        try {
                          await bridge().openInProfile(entry.profileId, entry.url);
                          toast.success(t('history.open'), entry.url);
                        } catch (error) {
                          toast.warn(t('err.notRunning'), messageOf(error));
                        }
                      }}
                    >
                      <Icon name="external" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {visible.length > shown ? (
            <div className="cluster" style={{ marginTop: 14, justifyContent: 'center' }}>
              <Button
                variant="soft"
                icon="clock"
                onClick={() => setShown((current) => Math.min(MAX_SHOWN, current + PAGE))}
                disabled={shown >= MAX_SHOWN}
              >
                {shown >= MAX_SHOWN
                  ? `Showing the newest ${MAX_SHOWN}`
                  : `Show older (${visible.length - shown} left)`}
              </Button>
            </div>
          ) : shown > PAGE && visible.length > PAGE ? (
            <div className="hint center" style={{ marginTop: 12 }}>
              Showing all {visible.length}.
            </div>
          ) : null}
        </div>
      </div>

      {confirm.dialog}
    </>
  );
}
