import { useEffect, useState, type ReactNode } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  CircularProgress,
} from '@mui/material';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import KeyOutlined from '@mui/icons-material/KeyOutlined';
import { cloud } from '../cloud/client';
import { messageOf } from '../util';

/**
 * Activate a license.
 *
 * One dialog, two entry points: the Settings subscription card, and the moment a free account
 * tries to exceed one profile. The license key is the 40-character hex code the project issues;
 * activation starts its validity clock immediately, on the server's clock.
 */

export function ActivateDialog({
  open,
  onClose,
  reason,
  onActivated,
}: {
  open: boolean;
  onClose: () => void;
  /** Shown as a one-line context note, e.g. why the dialog was opened. */
  reason?: string;
  onActivated?: () => void;
}): ReactNode {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activated, setActivated] = useState<string | null>(null);
  const [trialBusy, setTrialBusy] = useState(false);
  const [trialNote, setTrialNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setCode('');
    setError('');
    setActivated(null);
    setTrialNote('');
  }, [open]);

  const redeem = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await cloud().redeemCode(code);
      const until = result.expiresAt ? new Date(result.expiresAt) : null;
      setActivated(until ? until.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : 'done');
      onActivated?.();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const startTrial = async () => {
    if (trialBusy) return;
    setTrialBusy(true);
    setTrialNote('');
    try {
      const result = await cloud().startTrial();
      if (result.started) {
        setActivated(
          result.expiresAt
            ? new Date(result.expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
            : 'done',
        );
        onActivated?.();
      } else {
        setTrialNote('The 7-day trial is available once per account, and it has been used.');
      }
    } catch (failure) {
      setTrialNote(messageOf(failure));
    } finally {
      setTrialBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 0.5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <KeyOutlined color="primary" /> Activate a license
        </div>
      </DialogTitle>
      <DialogContent>
        {reason ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', margin: '4px 0 12px', lineHeight: 1.5 }}>{reason}</div>
        ) : null}

        {activated ? (
          <div style={{ textAlign: 'center', padding: '18px 8px 8px' }}>
            <CheckCircleOutlined color="success" sx={{ fontSize: 44 }} />
            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 10 }}>Your subscription is active</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 4 }}>Valid until <b>{activated}</b>. Profiles are unlimited.</div>
          </div>
        ) : (
          <>
            <div className="plans" style={{ marginTop: 4 }}>
              <div className="plan" aria-pressed="false" style={{ cursor: 'default' }}>
                <div className="plan-name">Monthly</div>
                <div className="plan-price">31<small> days</small></div>
                <div className="plan-note">Premium access for one month, counted from activation.</div>
              </div>
              <div className="plan" aria-pressed="true" style={{ cursor: 'default' }}>
                <span className="plan-badge">Most value</span>
                <div className="plan-name">Yearly</div>
                <div className="plan-price">365<small> days</small></div>
                <div className="plan-note">Premium access for a full year, counted from activation.</div>
              </div>
            </div>

            <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 10, lineHeight: 1.5 }}>
              Get a license key from the administrator, then paste it here. Activation starts the
              validity clock immediately.
            </div>

            <input
              className="input license-input"
              style={{ width: '100%' }}
              placeholder="XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
              value={code}
              onChange={(event) => {
                setCode(event.target.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 40));
                setError('');
              }}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              maxLength={40}
              aria-label="License key"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void redeem();
              }}
            />
            {error ? (
              <div style={{ color: 'var(--err)', fontSize: 12.5, marginTop: 8 }} role="alert">{error}</div>
            ) : null}
            {trialNote ? (
              <div style={{ color: 'var(--warn)', fontSize: 12.5, marginTop: 8 }} role="status">{trialNote}</div>
            ) : null}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, gap: 10, flexWrap: 'wrap' }}>
              <button type="button" className="link" onClick={() => void startTrial()} disabled={trialBusy}>
                {trialBusy ? 'Starting…' : 'Start my 7-day free trial'}
              </button>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{code.length}/40</div>
            </div>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>{activated ? 'Done' : 'Close'}</Button>
        {!activated ? (
          <Button variant="contained" onClick={() => void redeem()} disabled={busy || code.length !== 40}>
            {busy ? <CircularProgress size={19} color="inherit" /> : 'Activate'}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}

