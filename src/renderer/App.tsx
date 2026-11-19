import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppInfo, AppSettings, ProfileSummary, SessionInfo } from '../shared/types';
import { bridge, onEvent } from './bridge';
import { Icon, type IconName } from './components/Icon';
import { I18nProvider, useI18n } from './i18n';
import { ToastProvider, useToast } from './components/UI';
import { messageOf } from './util';
import { ProfilesPage } from './pages/ProfilesPage';
import { HistoryPage } from './pages/HistoryPage';
import { ProxiesPage } from './pages/ProxiesPage';
import { ExtensionsPage } from './pages/ExtensionsPage';
import { BrowsersPage } from './pages/BrowsersPage';
import { ToolsPage } from './pages/ToolsPage';
import { SettingsPage } from './pages/SettingsPage';
import { AboutPage } from './pages/AboutPage';
import { AdminPage } from './pages/AdminPage';
import { AccountGate } from './pages/AccountGate';
import { Logo } from './components/Brand';
import { ThemeToggle } from './components/ThemeToggle';
import { applyTheme, currentTheme } from './themeState';
import { LockOverlay } from './components/LockOverlay';
import { cloud, type CloudUser } from './cloud/client';
import { SubscriptionProvider, useSubscription } from './cloud/subscription';

/**
 * The application shell.
 *
 * A grouped navigation rail, a header that carries the page and its one line of state, and a
 * content column that scrolls on its own. The shell owns three things so no page has to: the
 * profile list, the session list, and the settings. A page that needs any of them reads the
 * props it was handed; a page that changes one calls the callback, and the shell refreshes.
 *
 * That division is what keeps a launch from being reflected on one page and not another. The
 * original did the same with a single `RefreshAll()` after every action; here it is an effect on
 * a store revision, so a background event (a browser that exited on its own) lands too.
 */

export type Page =
  | 'profiles'
  | 'history'
  | 'proxies'
  | 'extensions'
  | 'browsers'
  | 'tools'
  | 'settings'
  | 'about'
  | 'admin';

interface NavEntry {
  id: Page;
  icon: IconName;
  group: 'workspace' | 'system';
}

const NAV: NavEntry[] = [
  { id: 'profiles', icon: 'profiles', group: 'workspace' },
  { id: 'history', icon: 'history', group: 'workspace' },
  { id: 'proxies', icon: 'proxy', group: 'workspace' },
  { id: 'extensions', icon: 'extensions', group: 'workspace' },
  { id: 'tools', icon: 'tools', group: 'workspace' },
  { id: 'browsers', icon: 'browsers', group: 'system' },
  { id: 'settings', icon: 'settings', group: 'system' },
  { id: 'about', icon: 'about', group: 'system' },
];

const ADMIN_NAV: NavEntry = { id: 'admin', icon: 'key', group: 'system' };

export function App(): ReactNode {
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [page, setPage] = useState<Page>('profiles');
  const [settingsAccountRequest, setSettingsAccountRequest] = useState(0);
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const settingsRef = useRef<AppSettings | null>(null);
  const committedSettings = useRef<AppSettings | null>(null);
  const saveSequence = useRef(0);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [narrow, setNarrow] = useState(false);
  // undefined while restoring; null means authentication is required.
  const [authUser, setAuthUser] = useState<CloudUser | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const [nextProfiles, nextSessions] = await Promise.all([
        bridge().listProfiles(),
        bridge().listSessions(),
      ]);
      setProfiles(nextProfiles);
      setSessions(nextSessions);
      setFailure('');
    } catch (error) {
      setFailure(messageOf(error));
    }
  }, []);

  // The first load is the only one that may show a spinner: a refresh after an action must not
  // blank the page the user is looking at.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setFailure('');
    void (async () => {
      try {
        const [nextSettings, nextInfo] = await Promise.all([
          bridge().getSettings(),
          bridge().getAppInfo(),
        ]);
        if (!live) return;
        settingsRef.current = nextSettings;
        committedSettings.current = nextSettings;
        setSettings(nextSettings);
        setInfo(nextInfo);
        applyTheme(nextSettings.theme);

        const [nextProfiles, nextSessions] = await Promise.all([
          bridge().listProfiles(),
          bridge().listSessions(),
        ]);
        if (!live) return;
        setProfiles(nextProfiles);
        setSessions(nextSessions);
      } catch (error) {
        if (live) setFailure(messageOf(error));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [startupAttempt]);

  // One restore at startup: the Supabase session decides whether the gate is shown, and in
  // which mode the workspace opens. Failure means signed-out - the gate, not a crash.
  useEffect(() => {
    let live = true;
    void cloud()
      .currentUser()
      .then((user) => {
        if (live) setAuthUser(user);
      })
      .catch(() => {
        if (live) setAuthUser(null);
      });
    return () => {
      live = false;
    };
  }, []);

  // Every main-process change that matters to the list arrives on one of these channels.
  useEffect(() => {
    const offs = [
      onEvent('app:changed', () => void refresh()),
      onEvent('session:changed', () => void refresh()),
      onEvent('session:removed', () => void refresh()),
      onEvent('profiles:changed', () => void refresh()),
      onEvent('tray:focus', (payload) => {
        const id = (payload as { profileId?: string }).profileId;
        setPage('profiles');
        if (id) window.dispatchEvent(new CustomEvent('joe:focus-profile', { detail: id }));
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [refresh]);

  useEffect(() => {
    if (settings) document.documentElement.dataset['density'] = settings.density;
  }, [settings?.density]);

  const saveSettings = useCallback(async (patch: Partial<AppSettings>) => {
    if (!settingsRef.current) throw new Error('Settings are not ready.');
    const revision = ++saveSequence.current;
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    if (patch.theme) applyTheme(patch.theme);

    // Preserve the user's order even when the storage bridge resolves out of order.
    const request = saveQueue.current.then(() => bridge().saveSettings(patch));
    saveQueue.current = request.then(() => undefined, () => undefined);
    try {
      const saved = await request;
      committedSettings.current = saved;
      if (revision === saveSequence.current) {
        settingsRef.current = saved;
        setSettings(saved);
        if (saved.theme !== currentTheme()) applyTheme(saved.theme);
      }
      return saved;
    } catch (error) {
      if (revision === saveSequence.current && committedSettings.current) {
        settingsRef.current = committedSettings.current;
        setSettings(committedSettings.current);
        if (committedSettings.current.theme !== currentTheme()) applyTheme(committedSettings.current.theme);
      }
      throw error;
    }
  }, []);

  const runningById = useMemo(() => {
    const map = new Map<string, SessionInfo>();
    for (const session of sessions) map.set(session.profileId, session);
    return map;
  }, [sessions]);

  const toggleShell = useCallback(() => setNarrow((value) => !value), []);

  // Keyboard: the shortcuts in the original's OnKeyDown, plus page jumps.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if (mod && !event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setPage('profiles');
        window.dispatchEvent(new CustomEvent('joe:new-profile'));
        return;
      }
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('joe:focus-search'));
        return;
      }
      if (mod && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleShell();
        return;
      }
      if (typing) return;
      if (event.key === 'Escape') {
        window.dispatchEvent(new CustomEvent('joe:escape'));
      }
      if (event.key === 'F5') {
        event.preventDefault();
        void refresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refresh, toggleShell]);

  const running = sessions.length;
  const signedIn = authUser !== null && authUser !== undefined;
  const gateAnswered = signedIn;

  // While the session is restored, hold a neutral splash: no shell paint, no gate flash.
  if (authUser === undefined || (settings === null && !failure)) {
    return (
      <div className="gate" style={{ placeItems: 'center', display: 'grid' }}>
        <Logo size={84} />
      </div>
    );
  }

  if (!gateAnswered) {
    return (
      <I18nProvider language={settings?.language ?? 'en'} onChange={(language) => void saveSettings({ language })}>
        <ToastProvider>
          <AccountGate onDone={setAuthUser} />
        </ToastProvider>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider
      language={settings?.language ?? 'en'}
      onChange={(language) => void saveSettings({ language })}
    >
      <SubscriptionProvider user={signedIn ? authUser : null}>
        <ToastProvider>
          <SubscriptionGuard onSignOut={async () => {
            await cloud().signOut();
            setAuthUser(null);
            setPage('profiles');
          }}>
          <div className={`shell${narrow ? ' narrow' : ''}`}>
            <Rail
              page={page}
              onNavigate={(next) => { if (next === 'settings') setSettingsAccountRequest(0); setPage(next); }}
              running={running}
              profileCount={profiles.length}
              narrow={narrow}
              onToggle={toggleShell}
              info={info}
              onSignOut={
                signedIn
                  ? async () => {
                      await cloud().signOut();
                      setAuthUser(null);
                      setPage('profiles');
                    }
                  : undefined
              }
            />

            <main className="main">
              <TitleBar page={page} theme={settings?.theme ?? 'dark'} onTheme={async (next) => { await saveSettings({ theme: next }); }} onOpenSettings={() => { setSettingsAccountRequest((value) => value + 1); setPage('settings'); }} />
              {failure ? (
                <div style={{ padding: '12px 26px 0' }}>
                  <FailureBanner message={failure} onRetry={() => setStartupAttempt((value) => value + 1)} />
                </div>
              ) : null}
            {failure && !settings ? null : loading || !settings ? (
              <div className="content">
                <div className="empty">
                  <span className="spinner" style={{ width: 22, height: 22, color: 'var(--accent)' }} />
                </div>
              </div>
            ) : (
              <Pages
                page={page}
                profiles={profiles}
                runningById={runningById}
                settings={settings}
                info={info}
                refresh={refresh}
                onNavigate={setPage}
                saveSettings={saveSettings}
                accountRequest={settingsAccountRequest}
                onSignedOut={() => {
                  setAuthUser(null);
                }}
              />
            )}
          </main>
          <LockOverlay />
          </div>
          </SubscriptionGuard>
        </ToastProvider>
      </SubscriptionProvider>
    </I18nProvider>
  );
}

/** Blocked accounts cannot use the signed-in workspace. Local data is not deleted. */
function SubscriptionGuard({ children, onSignOut }: { children: ReactNode; onSignOut: () => Promise<void> }): ReactNode {
  const subscription = useSubscription();
  if (!subscription.entitlement?.isBlocked) return children;
  return (
    <div className="gate" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="panel" style={{ maxWidth: 420, width: '100%' }}>
        <h1>Account unavailable</h1>
        <p>Contact your administrator for access.</p>
        <button type="button" className="btn btn-primary" onClick={() => void onSignOut()}>Sign out</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ rail */

function Rail({
  page,
  onNavigate,
  running,
  profileCount,
  narrow,
  onToggle,
  info,
  onSignOut,
}: {
  page: Page;
  onNavigate: (page: Page) => void;
  running: number;
  profileCount: number;
  narrow: boolean;
  onToggle: () => void;
  info: AppInfo | null;
  onSignOut?: () => void | Promise<void>;
}): ReactNode {
  const { t } = useI18n();
  const subscription = useSubscription();
  const isAdmin = subscription.entitlement?.isAdmin === true;
  const email = subscription.user?.email ?? '';
  const group = NAV.find((entry) => entry.id === page)?.group ?? 'system';

  const item = (entry: NavEntry) => (
    <button
      key={entry.id}
      className="nav-item"
      aria-current={page === entry.id ? 'page' : undefined}
      onClick={() => onNavigate(entry.id)}
      title={narrow ? t(`nav.${entry.id}`) : undefined}
      type="button"
    >
      <span className="nav-icon">
        <Icon name={entry.icon} />
      </span>
      <span className="nav-label">{t(`nav.${entry.id}`)}</span>
      {entry.id === 'profiles' && profileCount > 0 ? <span className="nav-badge">{profileCount}</span> : null}
      {entry.id === 'profiles' && running > 0 ? <span className="nav-badge live">{running}</span> : null}
    </button>
  );

  return (
    <aside className="rail">
      <div className="rail-drag" />
      <div className="brand">
        <Logo size={narrow ? 34 : 36} />
        <div className="brand-text">
          <div className="brand-name">{t('app.title')}</div>
        </div>
      </div>

      <div className="rail-scroll">
        <div className={`nav-group${group === 'workspace' ? ' active' : ''}`}>{t('nav.workspace')}</div>
        {NAV.filter((entry) => entry.group === 'workspace').map(item)}
        <div className={`nav-group${group === 'system' ? ' active' : ''}`}>{t('nav.system')}</div>
        {NAV.filter((entry) => entry.group === 'system').map(item)}
        {isAdmin ? item(ADMIN_NAV) : null}
      </div>

      <div className="rail-foot">
        <div className="rail-status" title={info?.dataDir}>
          <span className={`dot${running > 0 ? ' on' : ''}`} />
          <span className="grow truncate">
            <strong>
              {running === 1 ? t('shell.running.one') : t('shell.running').replace('{n}', String(running))}
            </strong>
          </span>
        </div>
        {email ? (
          <div className="rail-account" title={email}>
            <span className="avatar sm">{email.slice(0, 1).toUpperCase()}</span>
            <span className="grow truncate" style={{ fontSize: 12, color: 'var(--text-2)' }}>{email}</span>
            {onSignOut ? (
              <button className="icon-btn sm" type="button" title="Sign out" aria-label="Sign out" onClick={() => void onSignOut()}>
                <Icon name="logout" size={17} />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="rail-actions">
          <button className="icon-btn" onClick={onToggle} title={narrow ? 'Expand the rail' : 'Collapse the rail'} type="button">
            <Icon name={narrow ? 'chevronRight' : 'chevronLeft'} />
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ title bar */

function TitleBar({
  page,
  theme,
  onTheme,
  onOpenSettings,
}: {
  page: Page;
  theme: 'dark' | 'light';
  onTheme: (next: 'dark' | 'light') => Promise<void>;
  onOpenSettings: () => void;
}): ReactNode {
  const { t } = useI18n();
  const subscription = useSubscription();
  const toast = useToast();
  const tier = subscription.tier;
  const days = subscription.entitlement?.expiresAt
    ? Math.max(0, Math.ceil((new Date(subscription.entitlement.expiresAt).getTime() - Date.now()) / 86_400_000))
    : 0;

  return (
    <div className="titlebar">
      <div className="crumb">
        <span>{t('app.title')}</span>
        <Icon name="chevronRight" size={15} />
        <b>{t(`header.${page}`)}</b>
      </div>
      <div className="spacer" />
      <button
        type="button"
        className={`tier-chip${tier === 'premium' ? ' premium' : tier === 'trial' ? ' trial' : ''}`}
        onClick={onOpenSettings}
        title={tier === 'trial' ? `Trial · ${days}d left — subscription details` : 'Subscription details'}
        style={{ marginRight: 12 }}
      >
        {tier === 'premium'
            ? subscription.entitlement?.isAdmin
              ? 'Admin'
              : 'Premium'
            : tier === 'trial'
              ? <>
                  Trial<span className="tier-detail"> · {days}d left</span>
                </>
              : 'Free plan'}
      </button>
      <ThemeToggle theme={theme} onChange={(next) => { void onTheme(next).catch((error: unknown) => toast.error(t('err.save'), messageOf(error))); }} />

    </div>
  );
}

function FailureBanner({ message, onRetry }: { message: string; onRetry: () => void }): ReactNode {
  const { t } = useI18n();
  return (
    <div className="banner err">
      <Icon name="info" />
      <div className="grow">
        <b>{t('err.load')}</b>
        <div style={{ marginTop: 2 }}>{message}</div>
      </div>
      <button className="btn btn-sm" onClick={onRetry} type="button">
        {t('err.reload')}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ page switch */

function Pages({
  page,
  profiles,
  runningById,
  settings,
  info,
  refresh,
  onNavigate,
  saveSettings,
  onSignedOut,
  accountRequest,
}: {
  page: Page;
  profiles: ProfileSummary[];
  runningById: Map<string, SessionInfo>;
  settings: AppSettings;
  info: AppInfo | null;
  refresh: () => Promise<void>;
  onNavigate: (page: Page) => void;
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  onSignedOut: () => void;
  accountRequest: number;
}): ReactNode {
  const toast = useToast();
  const lastPage = useRef(page);

  useEffect(() => {
    lastPage.current = page;
  }, [page]);

  switch (page) {
    case 'history':
      return <HistoryPage profiles={profiles} />;
    case 'proxies':
      return <ProxiesPage profiles={profiles} refreshProfiles={refresh} />;
    case 'extensions':
      return <ExtensionsPage settings={settings} saveSettings={saveSettings} />;
    case 'browsers':
      return <BrowsersPage settings={settings} saveSettings={saveSettings} />;
    case 'tools':
      return <ToolsPage profiles={profiles} refreshProfiles={refresh} onNavigate={onNavigate} />;
    case 'settings':
      return (
        <SettingsPage
          settings={settings}
          info={info}
          saveSettings={saveSettings}
          refreshProfiles={refresh}
          onSignedOut={onSignedOut}
          accountRequest={accountRequest}
        />
      );
    case 'admin':
      return <AdminPage />;
    case 'about':
      return <AboutPage info={info} profiles={profiles} />;
    case 'profiles':
    default:
      return (
        <ProfilesPage
          profiles={profiles}
          runningById={runningById}
          settings={settings}
          saveSettings={saveSettings}
          refresh={refresh}
          toast={toast}
        />
      );
  }
}
