import type { ReactNode } from 'react';
import type { AppInfo, ProfileSummary } from '../../shared/types';
import { TELEGRAM_USER } from '../../shared/types';
import { bridge } from '../bridge';
import { useI18n } from '../i18n';
import { Logo } from '../components/Brand';
import { Button } from '../components/UI';

export function AboutPage({ info }: { info: AppInfo | null; profiles?: ProfileSummary[] }): ReactNode {
  const { t } = useI18n();
  return (
    <>
      <header className="header">
        <div className="header-titles"><h1>{t('header.about')}</h1><div className="sub">{t('sub.about')}</div></div>
      </header>
      <div className="content">
        <div className="content-inner">
          <div className="about-hero">
            <Logo size={56} />
            <div>
              <div className="about-name">Joe Browser</div>
              {info ? <div className="muted">Version {info.version}</div> : null}
            </div>
          </div>
          <div className="section-label">{t('about.support')}</div>
          <div className="rows">
            <div className="row"><div className="row-main"><div className="row-title">{t('about.dataFolder')}</div></div>
              <Button size="sm" variant="soft" icon="folder" onClick={() => void bridge().openDataDir()}>{t('btn.view')}</Button>
            </div>
            <div className="row"><div className="row-main"><div className="row-title">{t('about.log')}</div></div>
              <Button size="sm" variant="soft" icon="terminal" onClick={() => void bridge().openLogsDir()}>{t('btn.view')}</Button>
            </div>
            <div className="row"><div className="row-main"><div className="row-title">@{TELEGRAM_USER}</div></div>
              <Button size="sm" variant="primary" icon="telegram" onClick={() => void bridge().openExternal(`https://t.me/${TELEGRAM_USER}`)}>Telegram</Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
