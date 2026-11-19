import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AppInfo, AppSettings, KernelBuild, LanguageInfo } from '../../shared/types';
import { enginesFromCatalog } from '../../shared/types';
import { bridge } from '../bridge';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';
import { CountryFlag } from '../components/CountryFlag';
import { SubscriptionCard } from '../components/SubscriptionCard';
import { Button, Segmented, Toggle, useConfirm, useToast } from '../components/UI';
import { SecurityPanel } from './SecurityPanel';
import { messageOf } from '../util';

/**
 * Settings.
 *
 * One scrolling page of grouped cards: every row is a setting on the left and its control on
 * the right, and the groups are the parts of the app a setting belongs to - the engine, the
 * workspace, the tools every profile inherits, the account and the storage.
 *
 * The original had a "Save changes" button, and the reason was not decoration: a text field
 * that writes itself on every keystroke persists half-typed URLs and half-typed groups, and
 * the profile that opens in between gets the broken value. The fields here are staged and the
 * button commits them; the switches apply the moment they are flipped, because a switch has
 * no half-typed state.
 */
export function SettingsPage({
  settings,
  info,
  saveSettings,
  refreshProfiles,
  onSignedOut,
  accountRequest = 0,
}: {
  settings: AppSettings;
  info: AppInfo | null;
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  refreshProfiles: () => Promise<void>;
  onSignedOut: () => void;
  accountRequest?: number;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [kernels, setKernels] = useState<KernelBuild[]>([]);
  const [resetting, setResetting] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [draft, setDraft] = useState({
    defaultEngine: settings.defaultEngine,
    defaultKernelId: settings.defaultKernelId,
    startPage: settings.startPage,
    defaultGroup: settings.defaultGroup,
  });
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void bridge().listLanguages().then(setLanguages).catch(() => setLanguages([]));
    void bridge().listKernels().then(setKernels).catch(() => setKernels([]));
  }, []);

  useEffect(() => {
    // A change that came from outside this page - the title bar's account shortcut, a reset -
    // replaces the draft. A change that came from our own save leaves it alone.
    if (dirty) return;
    setDraft({
      defaultEngine: settings.defaultEngine,
      defaultKernelId: settings.defaultKernelId,
      startPage: settings.startPage,
      defaultGroup: settings.defaultGroup,
    });
  }, [
    settings.defaultEngine,
    settings.defaultKernelId,
    settings.startPage,
    settings.defaultGroup,
    dirty,
  ]);

  useEffect(() => {
    if (!accountRequest) return;
    document.getElementById('joe-settings-account')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [accountRequest]);

  const save = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        await saveSettings(patch);
      } catch (error) {
        toast.error(t('err.save'), messageOf(error));
      }
    },
    [saveSettings, t, toast],
  );

  const edit = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  const commit = async (): Promise<void> => {
    if (!dirty) return;
    try {
      await saveSettings(draft);
      setDirty(false);
      toast.success(t('set.row.saved'));
    } catch (error) {
      toast.error(t('err.save'), messageOf(error));
    }
  };

  const reset = async (): Promise<void> => {
    const ok = await confirm.ask({
      title: t('set.reset'),
      body: t('set.reset.body'),
      confirmLabel: t('set.reset'),
      danger: true,
    });
    if (!ok) return;
    setResetting(true);
    try {
      await bridge().resetEverything();
      await refreshProfiles();
      toast.success(t('set.reset'));
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    } finally {
      setResetting(false);
    }
  };

  const clean = async (): Promise<void> => {
    setCleaning(true);
    try {
      const freed = await bridge().clearAllCaches();
      toast.success(t('tools.freed').replace('{size}', String(freed)));
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    } finally {
      setCleaning(false);
    }
  };

  const row = (label: string, control: ReactNode): ReactNode => (
    <div className="settings-row">
      <div className="settings-row-label">{label}</div>
      <div className="settings-row-control">{control}</div>
    </div>
  );

  /* A switch carries its own name, so the row lets the switch fill the width and puts its
     label on the left - the name appears once, and the control ends up on the right. */
  const toggleRow = (
    label: string,
    checked: boolean,
    onChange: (value: boolean) => void,
  ): ReactNode => (
    <div className="settings-row toggle-row">
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );

  return (
    <>
      <header className="header">
        <div className="header-titles">
          <h1>{t('header.settings')}</h1>
          <div className="sub">{t('sub.settings')}</div>
        </div>
        <div className="header-actions">
          <Button variant="primary" icon="check" onClick={() => void commit()} disabled={!dirty}>
            {t('btn.save')}
          </Button>
        </div>
      </header>

      <div className="content">
        <div className="content-inner settings-groups">
          <section className="settings-card" aria-label={t('set.browser')}>
            <div className="settings-card-title">{t('set.browser')}</div>
            {row(
              t('set.row.engine'),
              <select
                className="select"
                value={draft.defaultEngine}
                onChange={(event) => edit('defaultEngine', event.target.value)}
              >
                <option value="auto">{t('br.engine.auto')}</option>
                {enginesFromCatalog(kernels).map((engine) => (
                  <option key={engine} value={engine}>
                    {t(`br.engine.${engine}`, engine)}
                  </option>
                ))}
              </select>,
            )}
            {row(
              t('set.row.build'),
              <select
                className="select"
                value={draft.defaultKernelId}
                onChange={(event) => edit('defaultKernelId', event.target.value)}
              >
                <option value="">{t('set.kernel.spread')}</option>
                {kernels
                  .filter((kernel) => kernel.installed)
                  .map((kernel) => (
                    <option key={kernel.id} value={kernel.id}>
                      {t(`br.engine.${kernel.engine}`, kernel.engine)} {kernel.version}
                    </option>
                  ))}
              </select>,
            )}
          </section>

          <section className="settings-card" aria-label={t('set.workspace')}>
            <div className="settings-card-title">{t('set.workspace')}</div>
            {row(
              t('set.row.start'),
              <input
                className="input mono"
                value={draft.startPage}
                spellCheck={false}
                onChange={(event) => edit('startPage', event.target.value)}
              />,
            )}
            {row(
              t('set.row.group'),
              <input
                className="input"
                value={draft.defaultGroup}
                onChange={(event) => edit('defaultGroup', event.target.value)}
              />,
            )}
            {row(
              t('set.theme'),
              <Segmented
                label={t('set.theme')}
                value={settings.theme}
                onChange={(theme) => void save({ theme })}
                options={[
                  { id: 'dark', label: t('theme.night') },
                  { id: 'light', label: t('theme.day') },
                ]}
              />,
            )}
            {row(
              t('set.density'),
              <Segmented
                label={t('set.density')}
                value={settings.density}
                onChange={(density) => void save({ density })}
                options={[
                  { id: 'comfortable', label: t('view.cards') },
                  { id: 'compact', label: t('view.rows') },
                ]}
              />,
            )}
            <div className="settings-row stacked">
              <div className="settings-row-label">{t('set.row.lang')}</div>
              <div className="lang-grid">
                {languages.map((language) => (
                  <button
                    key={language.key}
                    className="lang"
                    aria-pressed={settings.language === language.key}
                    onClick={() => void save({ language: language.key })}
                    type="button"
                  >
                    <CountryFlag code={language.flag} size={22} />
                    <span className="name">
                      {language.native}
                      {language.native !== language.english ? (
                        <span className="faint" style={{ marginLeft: 5, fontSize: 11 }}>
                          {language.english}
                        </span>
                      ) : null}
                    </span>
                    {settings.language === language.key ? <Icon name="check" size={16} /> : null}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="settings-card" aria-label={t('set.tools')}>
            <div className="settings-card-title">{t('set.tools')}</div>
            {toggleRow(t('set.ext'), settings.extensionsEnabled, (extensionsEnabled) =>
              void save({ extensionsEnabled }),
            )}
            {toggleRow(t('set.cext'), settings.customExtensionsEnabled, (customExtensionsEnabled) =>
              void save({ customExtensionsEnabled }),
            )}
            {toggleRow(t('set.history'), settings.historyEnabled, (historyEnabled) =>
              void save({ historyEnabled }),
            )}
            {toggleRow(t('set.trash'), settings.useTrash, (useTrash) => void save({ useTrash }))}
            {toggleRow(t('set.clearonExit'), settings.clearCacheOnExit, (clearCacheOnExit) =>
              void save({ clearCacheOnExit }),
            )}
            {toggleRow(t('set.row.maximized'), settings.startMaximized, (startMaximized) =>
              void save({ startMaximized }),
            )}
          </section>

          <section
            className="settings-card"
            id="joe-settings-account"
            aria-label={t('set.accountSection')}
          >
            <div className="settings-card-title">{t('set.accountSection')}</div>
            <div className="settings-subhead">Subscription</div>
            <SubscriptionCard onSignedOut={onSignedOut} />
            <div className="settings-subhead">{t('set.account')}</div>
            <SecurityPanel settings={settings} saveSettings={saveSettings} />
          </section>

          <section className="settings-card" aria-label={t('set.storage')}>
            <div className="settings-card-title">{t('set.storage')}</div>
            {row(
              t('set.row.data'),
              <>
                <span className="faint mono settings-path">{info?.dataDir ?? '—'}</span>
                <Button variant="soft" icon="folder" onClick={() => void bridge().openDataDir()}>
                  {t('set.data.open')}
                </Button>
              </>,
            )}
            {row(
              t('set.row.cache'),
              <Button variant="soft" icon="archive" busy={cleaning} onClick={() => void clean()}>
                {t('set.clean.now')}
              </Button>,
            )}
            {row(
              t('set.reset'),
              <Button variant="danger" icon="trash" busy={resetting} onClick={() => void reset()}>
                {t('set.reset')}
              </Button>,
            )}
            {row(
              t('set.row.report'),
              <Button variant="soft" icon="info" onClick={() => void bridge().openLogsDir()}>
                {t('set.logs.open')}
              </Button>,
            )}
          </section>
        </div>
      </div>
      {confirm.dialog}
    </>
  );
}
