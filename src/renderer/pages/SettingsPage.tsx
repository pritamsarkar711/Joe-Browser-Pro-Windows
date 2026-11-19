import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AppInfo, AppSettings, KernelBuild, LanguageInfo } from '../../shared/types';
import { enginesFromCatalog } from '../../shared/types';
import { bridge } from '../bridge';
import { useI18n } from '../i18n';
import { Icon, type IconName } from '../components/Icon';
import { CountryFlag } from '../components/CountryFlag';
import { SubscriptionCard } from '../components/SubscriptionCard';
import { Button, Field, Segmented, Toggle, useConfirm, useToast } from '../components/UI';
import { SecurityPanel } from './SecurityPanel';
import { messageOf } from '../util';

type SettingsSection = 'appearance' | 'general' | 'account' | 'data';

export function SettingsPage({ settings, info, saveSettings, refreshProfiles, onSignedOut, accountRequest = 0 }: {
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
  const [section, setSection] = useState<SettingsSection>(accountRequest ? 'account' : 'appearance');
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [kernels, setKernels] = useState<KernelBuild[]>([]);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    void bridge().listLanguages().then(setLanguages).catch(() => setLanguages([]));
    void bridge().listKernels().then(setKernels).catch(() => setKernels([]));
  }, []);
  useEffect(() => { if (accountRequest) setSection('account'); }, [accountRequest]);

  const save = useCallback(async (patch: Partial<AppSettings>) => {
    try { await saveSettings(patch); }
    catch (error) { toast.error(t('err.save'), messageOf(error)); }
  }, [saveSettings, t, toast]);

  const sections: { id: SettingsSection; label: string; icon: IconName }[] = [
    { id: 'appearance', label: t('set.appearance'), icon: 'sun' },
    { id: 'general', label: t('set.general'), icon: 'settings' },
    { id: 'account', label: t('set.accountSection'), icon: 'lock' },
    { id: 'data', label: t('set.data'), icon: 'archive' },
  ];

  const reset = async () => {
    const ok = await confirm.ask({ title: t('set.reset'), body: t('set.reset.body'), confirmLabel: t('set.reset'), danger: true });
    if (!ok) return;
    setResetting(true);
    try {
      await bridge().resetEverything();
      await refreshProfiles();
      toast.success(t('set.reset'));
    } catch (error) { toast.error(t('err.generic'), messageOf(error)); }
    finally { setResetting(false); }
  };

  return <>
    <header className="header"><div className="header-titles"><h1>{t('header.settings')}</h1></div></header>
    <div className="content">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('header.settings')}>
          {sections.map(item => <button key={item.id} type="button" className="settings-nav-item" aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}>
            <Icon name={item.icon} size={18} /><span>{item.label}</span>
          </button>)}
        </nav>
        <div className="settings-content">
          {section === 'appearance' ? <section aria-label={t('set.appearance')}>
            <h2 className="settings-heading">{t('set.appearance')}</h2>
            <div className="panel settings-panel">
              <div className="settings-control-grid">
                <div><div className="field-label">{t('set.theme')}</div><Segmented label={t('set.theme')} value={settings.theme} onChange={theme => void save({ theme })} options={[{ id: 'dark', label: t('theme.night') }, { id: 'light', label: t('theme.day') }]} /></div>
                <div><div className="field-label">{t('set.density')}</div><Segmented label={t('set.density')} value={settings.density} onChange={density => void save({ density })} options={[{ id: 'comfortable', label: t('view.cards') }, { id: 'compact', label: t('view.rows') }]} /></div>
              </div>
              <div className="settings-divider" />
              <Toggle checked={settings.startMaximized} onChange={startMaximized => void save({ startMaximized })} label="Open the window maximised" />
            </div>
            <h3 className="settings-subheading">{t('set.interface')}</h3>
            <div className="panel settings-panel"><div className="lang-grid">
              {languages.map(language => <button key={language.key} className="lang" aria-pressed={settings.language === language.key} onClick={() => void save({ language: language.key })} type="button">
                <CountryFlag code={language.flag} size={22} />
                <span className="name">{language.native}{language.native !== language.english ? <span className="faint" style={{ marginLeft: 5, fontSize: 11 }}>{language.english}</span> : null}</span>
                {settings.language === language.key ? <Icon name="check" size={16} /> : null}
              </button>)}
            </div></div>
          </section> : null}

          {section === 'general' ? <section aria-label={t('set.general')}>
            <h2 className="settings-heading">{t('set.general')}</h2>
            <div className="panel settings-panel">
              <div className="form-grid">
                <Field label={t('set.browser')}><select className="select" value={settings.defaultEngine} onChange={event => void save({ defaultEngine: event.target.value })}>
                  <option value="auto">{t('br.engine.auto')}</option>
                  {enginesFromCatalog(kernels).map(engine => <option key={engine} value={engine}>{t(`br.engine.${engine}`, engine)}</option>)}
                </select></Field>
                <Field label={t('set.kernel')}><select className="select" value={settings.defaultKernelId} onChange={event => void save({ defaultKernelId: event.target.value })}>
                  <option value="">{t('set.kernel.spread')}</option>
                  {kernels.filter(kernel => kernel.installed).map(kernel => <option key={kernel.id} value={kernel.id}>{t(`br.engine.${kernel.engine}`, kernel.engine)} {kernel.version}</option>)}
                </select></Field>
                <Field label={t('set.start')}><input className="input mono" value={settings.startPage} onChange={event => void save({ startPage: event.target.value })} spellCheck={false} /></Field>
              </div>
            </div>
            <h3 className="settings-subheading">{t('set.tools')}</h3>
            <div className="panel settings-panel"><div className="settings-toggle-list">
              <Toggle checked={settings.extensionsEnabled} onChange={extensionsEnabled => void save({ extensionsEnabled })} label={t('set.ext')} />
              <Toggle checked={settings.customExtensionsEnabled} onChange={customExtensionsEnabled => void save({ customExtensionsEnabled })} label={t('set.cext')} />
              <Toggle checked={settings.historyEnabled} onChange={historyEnabled => void save({ historyEnabled })} label={t('set.history')} />
              <Toggle checked={settings.useTrash} onChange={useTrash => void save({ useTrash })} label={t('set.trash')} />
              <Toggle checked={settings.clearCacheOnExit} onChange={clearCacheOnExit => void save({ clearCacheOnExit })} label={t('set.clearonExit')} />
            </div></div>
          </section> : null}

          {section === 'account' ? <section aria-label="Account and security">
            <h2 className="settings-heading">Account &amp; security</h2>
            <h3 className="settings-subheading first">Subscription</h3>
            <SubscriptionCard onSignedOut={onSignedOut} />
            <h3 className="settings-subheading">{t('sec.title')}</h3>
            <SecurityPanel settings={settings} saveSettings={saveSettings} />
          </section> : null}

          {section === 'data' ? <section aria-label={t('set.data')}>
            <h2 className="settings-heading">{t('set.data')}</h2>
            <div className="panel settings-panel settings-data">
              <div className="settings-data-row"><div className="settings-data-main"><strong>{t('set.data')}</strong><div className="hint path">{info?.dataDir ?? '—'}</div></div><Button variant="soft" icon="folder" onClick={() => void bridge().openDataDir()}>{t('set.data.open')}</Button></div>
              <div className="settings-divider" />
              <div className="settings-data-row"><strong>{t('set.reset')}</strong><Button variant="danger" icon="trash" busy={resetting} onClick={() => void reset()}>{t('set.reset')}</Button></div>
            </div>
          </section> : null}
        </div>
      </div>
    </div>
    {confirm.dialog}
  </>;
}
