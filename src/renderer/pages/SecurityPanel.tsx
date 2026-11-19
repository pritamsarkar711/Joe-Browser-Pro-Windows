import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AccountSummary, AppSettings, TotpSetup } from '../../shared/types';
import { bridge } from '../bridge';
import { useI18n } from '../i18n';
import { Icon } from '../components/Icon';
import { Banner, Button, Chip, Field, Modal, useToast } from '../components/UI';
import { encodeQr, qrPath, qrViewBox } from '../../shared/qr';
import { messageOf } from '../util';

/**
 * Security.
 *
 * Two factors, both optional, both local. The PIN is typed at launch; the authenticator code is
 * asked for alongside it. Neither protects the data from someone with the disk - the proxy vault
 * does that with DPAPI - they protect the running app from the person sitting down at the desk.
 *
 * The local identity is created inside this panel: it is an on-device lock for the person sitting
 * down at the desk, never the cloud subscription. It stays on this PC.
 */

export function SecurityPanel({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();

  // The local app lock is a separate, on-device identity: an optional PIN and second factor for
  // the person sitting down at this PC. It is not an account in the cloud sense. It is managed
  // entirely inside this panel; everything stays on this PC either way.
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [lockChecked, setLockChecked] = useState(false);
  const refreshLocal = useCallback(async () => {
    try {
      const next = await bridge().lockState();
      setAccount(next.account);
    } catch {
      setAccount(null);
    } finally {
      setLockChecked(true);
    }
  }, []);
  useEffect(() => {
    void refreshLocal();
  }, [refreshLocal]);
  const onAccountChanged = useCallback(() => void refreshLocal(), [refreshLocal]);

  const [pinDialog, setPinDialog] = useState(false);
  const [totpDialog, setTotpDialog] = useState(false);

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="lock" size={18} />
        <h3>{t('sec.title')}</h3>
        <div className="grow" />
        {account ? (
          <Chip tone="muted">{account.email}</Chip>
        ) : (
          <Chip tone="warn">App lock is off</Chip>
        )}
      </div>

      {!account ? (
        !lockChecked ? (
          <Banner tone="info" icon="info">Checking the local app lock…</Banner>
        ) : (
          <LocalAccountSetup onDone={onAccountChanged} />
        )
      ) : (
        <div className="stack">
          <div className="spread">
            <div className="grow">
              <div className="row-title" style={{ gap: 8 }}>
                {t('sec.pin')}
                <Chip tone={account.pinEnabled ? 'ok' : 'muted'}>
                  {account.pinEnabled ? t('sec.on') : t('sec.off')}
                </Chip>
              </div>
            </div>
            <Button variant={account.pinEnabled ? 'soft' : 'primary'} icon="lock" onClick={() => setPinDialog(true)}>
              {account.pinEnabled ? t('sec.pin.change') : t('sec.pin.set')}
            </Button>
          </div>

          <div className="divider" />

          <div className="spread">
            <div className="grow">
              <div className="row-title" style={{ gap: 8 }}>
                {t('sec.totp')}
                <Chip tone={account.twoFactorEnabled ? 'ok' : 'muted'}>
                  {account.twoFactorEnabled ? t('sec.on') : t('sec.off')}
                </Chip>
              </div>
            </div>
            <Button
              variant={account.twoFactorEnabled ? 'soft' : 'primary'}
              icon="lock"
              onClick={() => setTotpDialog(true)}
            >
              {account.twoFactorEnabled ? t('sec.totp.manage') : t('sec.totp.setup')}
            </Button>
          </div>

          <div className="divider" />

          <div className="spread">
            <div className="grow">
              <div className="row-title">{t('sec.askOnStart')}</div>
            </div>
            {/*
              This switch used to write `settings.pinEnabled`, which nothing read: a user could
              turn it on with no PIN behind it and the app still opened straight through, and
              could turn it off with a PIN set and the PIN still locked the app. The account is
              now the only authority, so the switch reports whether a PIN exists and switching it
              off removes the PIN rather than hiding it.
            */}
            <Switch
              checked={account.pinEnabled}
              disabled={!account}
              onChange={(next) => {
                if (!account) return;
                if (next) {
                  setPinDialog(true);
                  return;
                }
                void bridge()
                  .setPin(account.email, '')
                  .then(() => {
                    onAccountChanged();
                    toast.success(t('sec.pin.removed'));
                  })
                  .catch((error: unknown) => toast.error(t('err.generic'), messageOf(error)));
              }}
            />
          </div>

          <div className="spread">
            <div className="grow">
              <div className="row-title">{t('sec.autoLock')}</div>
            </div>
            <select
              className="select"
              style={{ width: 150 }}
              value={settings.autoLockMinutes}
              onChange={(event) => void saveSettings({ autoLockMinutes: Number(event.target.value) })}
            >
              {[0, 1, 5, 15, 30, 60].map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes === 0 ? t('generic.off') : `${minutes} min`}
                </option>
              ))}
            </select>
          </div>

          <div className="divider" />

          <div className="spread">
            <div className="grow">
              <div className="row-title">{t('sec.signout')}</div>
            </div>
            <Button
              variant="ghost"
              icon="logout"
              onClick={async () => {
                await bridge().signOut();
                onAccountChanged();
              }}
            >
              {t('sec.signout')}
            </Button>
          </div>
        </div>
      )}

      {account && pinDialog ? (
        <PinDialog
          email={account.email}
          enabled={account.pinEnabled}
          onClose={() => setPinDialog(false)}
          onSaved={() => {
            setPinDialog(false);
            onAccountChanged();
            toast.success(t('sec.pin'));
          }}
        />
      ) : null}

      {account && totpDialog ? (
        <TotpDialog
          account={account}
          onClose={() => setTotpDialog(false)}
          onChanged={() => {
            onAccountChanged();
          }}
          onDisabled={() => {
            setTotpDialog(false);
            onAccountChanged();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ a switch */

/** A checkbox drawn as a switch. Local to this file: it is the only place that needs one. */
function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`toggle${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
      style={{ border: 0, background: 'transparent', padding: 0, width: 'auto', opacity: disabled ? 0.45 : 1 }}
    >
      <span className="track" />
    </button>
  );
}

/* ------------------------------------------------------------------ the PIN */

function PinDialog({
  email,
  enabled,
  onClose,
  onSaved,
}: {
  email: string;
  enabled: boolean;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const valid = /^\d{4,12}$/.test(pin) && pin === confirm;

  const save = async (value: string) => {
    setBusy(true);
    setError('');
    try {
      await bridge().setPin(email, value);
      onSaved();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={enabled ? t('sec.pin.change') : t('sec.pin.set')}
      subtitle={t('sec.pin.hint')}
      onClose={onClose}
      footer={
        <>
          {enabled ? (
            <Button variant="ghost" icon="unlock" onClick={() => void save('')} busy={busy}>
              {t('sec.pin.remove')}
            </Button>
          ) : null}
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            {t('btn.cancel')}
          </Button>
          <Button variant="primary" icon="lock" disabled={!valid} busy={busy} onClick={() => void save(pin)}>
            {t('btn.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {error ? <Banner tone="err" icon="info">{error}</Banner> : null}
        <Field label={t('sec.pin')} hint={t('sec.pin.hint')}>
          <input
            className="input mono num"
            type="password"
            inputMode="numeric"
            value={pin}
            autoFocus
            onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 12))}
            placeholder="••••"
          />
        </Field>
        <Field label={t('sec.pin.repeat')}>
          <input
            className="input mono num"
            type="password"
            inputMode="numeric"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value.replace(/\D/g, '').slice(0, 12))}
            placeholder="••••"
          />
        </Field>
        {pin && confirm && pin !== confirm ? (
          <div className="hint" style={{ color: 'var(--err)' }}>
            {t('sec.pin.mismatch')}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ the second factor */

function TotpDialog({
  account,
  onClose,
  onChanged,
  onDisabled,
}: {
  account: AccountSummary;
  onClose: () => void;
  onChanged: () => void;
  onDisabled: () => void;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();

  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(30 - (Math.floor(Date.now() / 1000) % 30));

  const load = useCallback(async () => {
    try {
      setSetup(await bridge().totpSetup(account.email));
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, [account.email]);

  useEffect(() => {
    void load();
  }, [load]);

  // The countdown is what tells a user why a code that worked ten seconds ago is now rejected.
  useEffect(() => {
    const timer = setInterval(() => setSeconds(30 - (Math.floor(Date.now() / 1000) % 30)), 1000);
    return () => clearInterval(timer);
  }, []);

  const qr = setup ? encodeQr(setup.uri) : null;

  const enable = async () => {
    if (!setup) return;
    setBusy(true);
    setError('');
    try {
      await bridge().enableTotp({ email: account.email, secret: setup.secret, code });
      toast.success(t('sec.totp.on'));
      onChanged();
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={account.twoFactorEnabled ? t('sec.totp.manage') : t('sec.totp.setup')}
      subtitle={t('sec.totpHint')}
      onClose={onClose}
      footer={
        <>
          {account.twoFactorEnabled ? (
            <Button
              variant="ghost"
              icon="unlock"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await bridge().disableTotp(account.email);
                  toast.success(t('sec.totp.off'));
                  onDisabled();
                } catch (failure) {
                  setError(messageOf(failure));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('sec.totp.disable')}
            </Button>
          ) : null}
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            {t('btn.cancel')}
          </Button>
          <Button
            variant="primary"
            icon="lock"
            disabled={code.length !== 6}
            busy={busy}
            onClick={enable}
          >
            {account.twoFactorEnabled ? t('sec.totp.confirm') : t('sec.totp.enable')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {error ? <Banner tone="err" icon="info">{error}</Banner> : null}

        <div className="totp-layout">
          <div className="totp-qr">
            {qr ? (
              <svg
                viewBox={`0 0 ${qrViewBox(qr)} ${qrViewBox(qr)}`}
                width="100%"
                height="100%"
                shapeRendering="crispEdges"
                role="img"
                aria-label={t('sec.totp.qr')}
              >
                <rect width={qrViewBox(qr)} height={qrViewBox(qr)} fill="#ffffff" />
                <path d={qrPath(qr)} fill="#000000" />
              </svg>
            ) : (
              <span className="spinner" />
            )}
          </div>

          <div className="stack tight grow">
            <div>
              <div className="field-label">{t('sec.totp.scan')}</div>
              <div className="hint" style={{ marginTop: 3 }}>{t('sec.totp.steps')}</div>
            </div>

            <div>
              <div className="field-label">{t('sec.totp.key')}</div>
              <div className="cluster" style={{ marginTop: 5 }}>
                <code className="input mono" style={{ height: 32, display: 'flex', alignItems: 'center', letterSpacing: '0.06em' }}>
                  {setup?.secret.replace(/(.{4})/g, '$1 ').trim() ?? '—'}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="copy"
                  onClick={() => {
                    if (!setup) return;
                    void navigator.clipboard?.writeText(setup.secret);
                    toast.success(t('generic.copied'));
                  }}
                >
                  {t('generic.copy')}
                </Button>
              </div>
            </div>

            <div>
              <div className="field-label">
                {t('sec.totp.confirm')} <span className="faint">· {seconds}s</span>
              </div>
              <input
                className="input mono num"
                style={{ marginTop: 5, letterSpacing: '0.25em', fontSize: 17 }}
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                autoFocus
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </div>

            {setup?.active ? (
              <Banner tone="ok" icon="check">
                {t('sec.totp.active')}
              </Banner>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ the local identity */

/**
 * The local identity is what the app lock binds to. It has nothing to do with the cloud
 * subscription: it exists so the window can demand a PIN (and optionally an authenticator code)
 * from whoever sits down at this PC. Create it here; sign back in if it already exists but this
 * session is not using it.
 */
function LocalAccountSetup({ onDone }: { onDone: () => void }): ReactNode {
  const [mode, setMode] = useState<'create' | 'signin'>('create');
  const [hasLocal, setHasLocal] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void bridge()
      .listAccounts()
      .then((rows) => {
        setHasLocal(rows.length > 0);
        if (rows.length > 0) setMode('signin');
      })
      .catch(() => setHasLocal(false));
  }, []);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'create') {
        await bridge().registerAccount({ email, password, displayName });
      } else {
        await bridge().signIn({ email, password });
      }
      onDone();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Banner tone="info" icon="lock">
        The app lock is local to this PC. Create a local identity to turn it on, or sign back into
        the one that already exists here. It is never sent anywhere, and it is unrelated to your
        subscription.
      </Banner>

      <div className="segment full" role="tablist" aria-label="Local identity">
        <button type="button" role="tab" aria-selected={mode === 'create'} onClick={() => setMode('create')}>
          Create locally
        </button>
        <button type="button" role="tab" aria-selected={mode === 'signin'} onClick={() => setMode('signin')}>
          Sign in{hasLocal === false ? ' (none yet)' : ''}
        </button>
      </div>

      {error ? <Banner tone="err" icon="info">{error}</Banner> : null}

      <div className="form-grid">
        {mode === 'create' ? (
          <Field label="Display name" hint="Shown on this PC only">
            <input className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Joe" autoComplete="off" />
          </Field>
        ) : null}
        <Field label="Email">
          <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" spellCheck={false} />
        </Field>
        <Field label="Password" hint={mode === 'create' ? 'At least six characters. Stored only on this PC.' : 'The password for the local identity'}>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
            placeholder="••••••••"
            autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
          />
        </Field>
      </div>

      <div className="cluster" style={{ marginTop: 4 }}>
        <Button variant="primary" icon="lock" busy={busy} disabled={!email.includes('@') || password.length < 6} onClick={() => void submit()}>
          {mode === 'create' ? 'Create local identity' : 'Sign in to app lock'}
        </Button>
      </div>
    </div>
  );
}
