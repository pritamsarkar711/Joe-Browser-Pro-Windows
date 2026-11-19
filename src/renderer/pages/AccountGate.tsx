import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { cloud, type CloudUser } from '../cloud/client';
import { Logo } from '../components/Brand';
import { Icon } from '../components/Icon';
import { Banner, Button, Field, Segmented } from '../components/UI';
import { messageOf } from '../util';

/**
 * The way in.
 *
 * One question, two answers: sign in with your Joe Browser account, or create one. A new
 * account starts a 7-day trial automatically. The "continue locally" link keeps the original
 * escape hatch - the free plan exists, it keeps one profile, and an account is what lifts the
 * ceiling.
 */

export function AccountGate({
  onDone,
}: {
  onDone: (user: CloudUser) => void | Promise<void>;
}): ReactNode {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstField = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    firstField.current?.focus();
  }, [mode]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const api = cloud();
      if (mode === 'register') {
        const user = await api.signUp(email, password);
        // A registration begins a trial immediately; failure here must not block the account.
        await api.startTrial().catch(() => undefined);
        await onDone(user);
        return;
      }
      const user = await api.signInWithPassword(email, password);
      await onDone(user);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const registerable = email.trim().length > 3 && password.length >= 6;

  return (
    <div className="gate">
      <div className="gate-art">
        <div className="gate-art-inner">
          <div className="gate-brand">
            <Logo size={64} className="gate-logo" />
            <div>
              <div className="gate-brand-name">Joe Browser</div>
              <div className="gate-brand-sub">Anti-detect workspace</div>
            </div>
          </div>

          <ul className="gate-points">
            <li>
              <span className="gate-point-icon"><Icon name="fingerprint" size={16} /></span>
              <span>
                <b>One identity per profile</b>
                <span>Canvas, WebGL, fonts and client hints agree with each other.</span>
              </span>
            </li>
            <li>
              <span className="gate-point-icon"><Icon name="browsers" size={16} /></span>
              <span>
                <b>Isolated by construction</b>
                <span>Every profile keeps its own storage, cookies and proxy.</span>
              </span>
            </li>
            <li>
              <span className="gate-point-icon"><Icon name="lock" size={16} /></span>
              <span>
                <b>Browsers built in</b>
                <span>Managed engines live inside the app, not in your system browser.</span>
              </span>
            </li>
          </ul>
        </div>
      </div>

      <div className="gate-form">
        <div className="gate-form-inner">
          <div className="gate-mobile-brand"><Logo size={40} /><strong>Joe Browser</strong></div>
          <h1 className="gate-title">{mode === 'register' ? 'Create your account' : 'Welcome back'}</h1>
          {mode === 'register' ? <p className="gate-sub">Confirm your email to continue.</p> : null}

          <div className="gate-tabs">
            <Segmented<'signin' | 'register'>
              full
              value={mode}
              onChange={(value) => {
                setMode(value);
                setError('');
              }}
              options={[
                { id: 'signin', label: 'Sign in' },
                { id: 'register', label: 'Create account' },
              ]}
            />
          </div>

          {error ? (
            <Banner tone="err" icon="info">
              {error}
            </Banner>
          ) : null}

          <form className="gate-fields" onSubmit={submit}>
            <Field label="Email">
              <input
                ref={firstField}
                type="email"
                autoComplete="email"
                spellCheck={false}
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </Field>
            <Field label="Password" hint={mode === 'register' ? 'At least 6 characters.' : undefined}>
              <input
                type="password"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                placeholder="••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </Field>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={busy || !registerable}
            >
              {busy ? 'Please wait…' : mode === 'register' ? 'Create account & start trial' : 'Sign in'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
