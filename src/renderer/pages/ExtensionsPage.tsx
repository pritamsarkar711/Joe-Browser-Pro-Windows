import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AppSettings, ExtensionItem, ExtensionReport } from '../../shared/types';
import { bridge, onEvent } from '../bridge';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';
import { Button, Modal, Toggle, useConfirm, useToast } from '../components/UI';
import { messageOf } from '../util';

/**
 * Extensions.
 *
 * Three groups, because they are removed differently. The built-in tools are written by the app
 * and always present. The included pair ships with the app and can be removed and restored.
 * Everything imported lives in a folder under the workspace and is deleted with its folder.
 *
 * The master switch stays separate from the per-item switch: turning extensions off for a profile
 * is a mode, not a decision to forget every extension you installed.
 */

export function ExtensionsPage({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const [report, setReport] = useState<ExtensionReport | null>(null);
  const [busy, setBusy] = useState('');
  const [storeUrl, setStoreUrl] = useState('');
  const [storeDialog, setStoreDialog] = useState(false);

  const load = useCallback(async () => {
    try {
      setReport(await bridge().listExtensions());
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    }
  }, [t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => onEvent('extensions:changed', () => void load()), [load]);

  const act = async (label: string, work: () => Promise<unknown>, success?: string) => {
    setBusy(label);
    try {
      await work();
      await load();
      if (success) toast.success(success);
    } catch (error) {
      toast.error(t('err.generic'), messageOf(error));
    } finally {
      setBusy('');
    }
  };

  const library = report?.library ?? [];
  const imported = library.filter((item) => !item.shipped);

  return (
    <>
      <header className="header">
        <div className="header-titles">
          <h1>{t('ext.title')}</h1>
        </div>
        <div className="header-actions">
          <Button variant="soft" icon="link" onClick={() => setStoreDialog(true)}>{t('ext.byUrl')}</Button>
          <Button variant="soft" icon="folder" onClick={() => void act('folder', () => bridge().openExtensionFolder())}>
            {t('ext.openfolder')}
          </Button>
          <Button variant="soft" icon="link" onClick={() => void act('file', () => bridge().addExtensionFile(), t('btn.import'))} busy={busy === 'file'}>
            {t('ext.addfile')}
          </Button>
          <Button variant="primary" icon="plus" onClick={() => void act('folder', () => bridge().addExtensionFolder(), t('ext.addfolder'))} busy={busy === 'folder'}>
            {t('ext.addfolder')}
          </Button>
        </div>
      </header>

      <div className="content">
        <div className="content-inner">
          <div className="panel" style={{ marginBottom: 18 }}>
            <div className="spread">
              <Toggle
                checked={settings.extensionsEnabled}
                onChange={(extensionsEnabled) => void saveSettings({ extensionsEnabled })}
                label={t('ext.master')}
              />
              <Toggle
                checked={settings.customExtensionsEnabled}
                onChange={(customExtensionsEnabled) => void saveSettings({ customExtensionsEnabled })}
                label={t('set.cext')}
              />
            </div>
          </div>

          <div className="section-label">{t('ext.included')}</div>
          <div className="rows">
            {(report?.shipped ?? []).map((item) => (
              <div className="row" key={item.id}>
                <div className="row-icon"><img src={item.icon} alt="" /></div>
                <div className="row-main">
                  <div className="row-title">
                    {item.name}
                    {!item.present && !item.removed ? <span className="ext-state">Not installed</span> : null}
                  </div>
                </div>
                <div className="row-actions">
                  {item.removed || !item.present ? (
                    <Button size="sm" variant="soft" icon="refresh" onClick={() => void act(item.id, () => bridge().restoreShippedExtension(item.id), t('ext.restore'))} busy={busy === item.id}>
                      {t('ext.restore')}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      onClick={async () => {
                        const ok = await confirm.ask({
                          title: t('ext.remove'),
                          body: `${item.name} stops loading in every profile. It can be restored from this page later.`,
                          confirmLabel: t('ext.remove'),
                        });
                        if (ok) await act(item.id, () => bridge().removeShippedExtension(item.id), t('ext.remove'));
                      }}
                    >
                      {t('ext.remove')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="section-label">{t('ext.library')}</div>
          {imported.length === 0 ? (
            <div className="ext-empty">No added extensions.</div>
          ) : (
            <div className="rows">
              {imported.map((item) => (
                <ExtensionRow
                  key={item.id}
                  item={item}
                  busy={busy === item.id}
                  onToggle={(enabled) => void act(item.id, () => bridge().toggleExtension(item.id, enabled))}
                  onDelete={async () => {
                    const ok = await confirm.ask({
                      title: t('generic.remove'),
                      body: t('ext.delete.body').replace('{name}', item.name),
                      confirmLabel: t('btn.delete'),
                      danger: true,
                    });
                    if (ok) await act(item.id, () => bridge().deleteExtension(item.id), t('generic.remove'));
                  }}
                />
              ))}
            </div>
          )}

          <div className="section-label">{t('ext.recommended')}</div>
          <p className="muted">Chromium-family extensions only; Firefox is not supported by this library.
            Changes apply when profiles are reopened. Extensions can access browsing data and alter
            fingerprint surfaces—install only what you need.</p>
          <div className="tiles">
            {(report?.recommended ?? []).map((item) => (
              <div className="store-tile" key={item.url}>
                <div className="tile-icon">
                  {item.icon ? <img src={item.icon} alt="" style={{ width: 32, height: 32, objectFit: 'contain' }} /> : <Icon name="extensions" />}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="tile-title">{item.name}</div>
                  <p className="muted">{item.description}</p>
                </div>
                <div className="tile-foot">
                  <Button size="sm" variant="soft" icon="download" busy={busy === item.url} disabled={!!busy || library.some((installed) => installed.storeUrl === item.url)}
                    onClick={() => void act(item.url, () => bridge().addExtensionByUrl(item.url), item.name)}>
                    {library.some((installed) => installed.storeUrl === item.url) ? 'Installed' : t('br.download')}
                  </Button>
                </div>
              </div>
            ))}
          </div>

        </div>
      </div>

      {storeDialog ? (
        <Modal title={t('ext.byUrl')} onClose={() => setStoreDialog(false)} footer={
          <>
            <Button variant="ghost" onClick={() => setStoreDialog(false)}>{t('btn.cancel')}</Button>
            <Button variant="primary" disabled={!storeUrl.trim() || !!busy} busy={busy === 'byUrl'} onClick={() => void act('byUrl', async () => {
              await bridge().addExtensionByUrl(storeUrl);
              setStoreUrl('');
              setStoreDialog(false);
            }, t('ext.addurl'))}>{t('ext.addurl')}</Button>
          </>
        }>
          <input className="input mono" aria-label={t('ext.byUrl')} value={storeUrl}
            placeholder="https://chromewebstore.google.com/detail/…" onChange={(event) => setStoreUrl(event.target.value)} spellCheck={false} />
        </Modal>
      ) : null}
      {confirm.dialog}
    </>
  );
}

function ExtensionRow({
  item,
  busy,
  onToggle,
  onDelete,
}: {
  item: ExtensionItem;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}): ReactNode {
  const { t } = useI18n();
  return (
    <div className="row">
      <div className="row-icon">
        {item.iconDataUrl ? <img src={item.iconDataUrl} alt="" /> : <Icon name="extensions" />}
      </div>
      <div className="row-main">
        <div className="row-title">
          <span className="truncate">{item.name}</span>
        </div>
      </div>
      <div className="row-actions">
        {busy ? <span className="spinner" style={{ color: 'var(--accent)' }} /> : null}
        <Toggle checked={item.enabled} onChange={onToggle} label="" />
        <button className="icon-btn sm" onClick={onDelete} title={t('generic.remove')} type="button">
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}
