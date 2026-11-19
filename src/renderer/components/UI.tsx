import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from './Icon';

/**
 * The primitives every page is built from.
 *
 * These exist so that a page never invents its own dialog, its own confirmation, its own menu or
 * its own way of reporting a failure. The original had three different confirm dialogs and no
 * shared toast; this has one of each and the pages stay short because of it.
 */

/* ------------------------------------------------------------------ toast */

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warn' | 'error';
  message: string;
  detail?: string;
}

interface ToastApi {
  toast(message: string, detail?: string): void;
  success(message: string, detail?: string): void;
  warn(message: string, detail?: string): void;
  error(message: string, detail?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextToastId = 1;

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [items, setItems] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (kind: Toast['kind'], message: string, detail?: string) => {
      const id = nextToastId++;
      // Three at once is already more than anyone reads; the oldest goes.
      setItems((current) => [...current.slice(-2), { id, kind, message, detail }]);
      const timer = setTimeout(() => dismiss(id), kind === 'error' ? 9000 : 4600);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast: (message, detail) => push('info', message, detail),
      success: (message, detail) => push('success', message, detail),
      warn: (message, detail) => push('warn', message, detail),
      error: (message, detail) => push('error', message, detail),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div
            key={item.id}
            className={`toast ${item.kind}`}
            onClick={() => dismiss(item.id)}
            title="Dismiss"
          >
            <span className="bar" />
            <div className="toast-body">
              <div className="toast-title">{item.message}</div>
              {item.detail ? <div className="toast-detail">{item.detail}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

/* ------------------------------------------------------------------ buttons */

export function Button({
  children,
  icon,
  variant = 'default',
  size = 'md',
  onClick,
  disabled,
  title,
  type = 'button',
  block,
  busy,
}: {
  children?: ReactNode;
  icon?: IconName;
  variant?: 'default' | 'primary' | 'soft' | 'ghost' | 'danger' | 'ok';
  size?: 'sm' | 'md' | 'lg';
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  block?: boolean;
  busy?: boolean;
}): ReactNode {
  const classes = [
    'btn',
    variant !== 'default' ? `btn-${variant}` : '',
    size !== 'md' ? `btn-${size}` : '',
    block ? 'btn-block' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} onClick={onClick} disabled={disabled || busy} title={title} type={type}>
      {busy ? <span className="spinner" /> : icon ? <Icon name={icon} /> : null}
      <span className="btn-label">{children}</span>
    </button>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  active,
  small,
  disabled,
}: {
  icon: IconName;
  label: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  small?: boolean;
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      className={`icon-btn${small ? ' sm' : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      style={active ? { background: 'var(--accent-soft)', color: 'var(--accent-hi)' } : undefined}
    >
      <Icon name={icon} />
    </button>
  );
}

/* ------------------------------------------------------------------ fields */

export function Field({
  label,
  hint,
  children,
  span,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  span?: 2 | 'all';
}): ReactNode {
  return (
    <div className={`field${span === 2 ? ' span-2' : span === 'all' ? ' span-all' : ''}`}>
      <label>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  detail,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  detail?: string;
  disabled?: boolean;
}): ReactNode {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="track" />
      <span className="toggle-label">
        <b>{label}</b>
        {detail ? <span>{detail}</span> : null}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  full,
  label,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
  full?: boolean;
  label?: string;
}): ReactNode {
  return (
    <div className={`segment${full ? ' full' : ''}`} role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          role="tab"
          aria-selected={option.id === value}
          onClick={() => onChange(option.id)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({
  children,
  tone,
  icon,
  title,
}: {
  children: ReactNode;
  tone?: 'accent' | 'ok' | 'warn' | 'err' | 'muted';
  icon?: IconName;
  title?: string;
}): ReactNode {
  return (
    <span className={`chip${tone ? ` ${tone}` : ''}`} title={title}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </span>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}): ReactNode {
  return (
    <div className="search">
      <Icon name="search" />
      <input
        className="input"
        value={value}
        placeholder={placeholder ?? 'Search'}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
      {value ? (
        <button className="clear" onClick={() => onChange('')} aria-label="Clear search" type="button">
          <Icon name="close" size={13} />
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ modal */

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 'normal',
  flush,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'normal' | 'wide' | 'narrow';
  flush?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);

  // Escape closes, and the dialog takes the focus so that the keyboard works without a click.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal${width === 'wide' ? ' wide' : width === 'narrow' ? ' narrow' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal-head">
          <div className="grow">
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
        <div className={`modal-body${flush ? ' flush' : ''}`}>{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/** A confirm dialog that reads as a sentence, because that is what the user has to answer. */
export function Confirm({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      width="narrow"
      footer={
        <>
          <div className="spacer" />
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-2)' }}>{body}</div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ menu */

export interface MenuAction {
  label: string;
  icon?: IconName;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** A section heading, rendered instead of a button when present. */
  heading?: boolean;
  separator?: boolean;
  shortcut?: string;
}

export function Menu({
  trigger,
  actions,
  align = 'right',
}: {
  trigger: (open: () => void, isOpen: boolean) => ReactNode;
  actions: MenuAction[];
  align?: 'left' | 'right';
}): ReactNode {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // Deferred: the click that opened the menu is still propagating.
    const id = setTimeout(() => document.addEventListener('mousedown', onDown));
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu-wrap" ref={wrap}>
      {trigger(() => setOpen((value) => !value), open)}
      {open ? (
        <div className={`menu${align === 'left' ? ' left' : ''}`} role="menu">
          {actions.map((action, index) =>
            action.separator ? (
              <div className="menu-sep" key={`sep-${index}`} />
            ) : action.heading ? (
              <div className="menu-label" key={`head-${index}`}>
                {action.label}
              </div>
            ) : (
              <button
                key={action.label}
                className={`menu-item${action.danger ? ' danger' : ''}`}
                role="menuitem"
                disabled={action.disabled}
                onClick={() => {
                  setOpen(false);
                  action.onClick();
                }}
              >
                {action.icon ? <Icon name={action.icon} /> : null}
                {action.label}
                {action.shortcut ? <span className="kbd">{action.shortcut}</span> : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ states */

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="empty">
      <div className="glyph">
        <Icon name={icon} size={24} />
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function Banner({
  tone = 'info',
  icon,
  children,
}: {
  tone?: 'info' | 'warn' | 'err' | 'ok';
  icon?: IconName;
  children: ReactNode;
}): ReactNode {
  const fallback: IconName = tone === 'warn' || tone === 'err' ? 'info' : tone === 'ok' ? 'check' : 'info';
  return (
    <div className={`banner${tone === 'info' ? '' : ` ${tone}`}`}>
      <Icon name={icon ?? fallback} />
      <div className="grow">{children}</div>
    </div>
  );
}

export function Stat({
  value,
  label,
  title,
  icon,
}: {
  value: ReactNode;
  label: string;
  title?: string;
  icon?: IconName;
}): ReactNode {
  return (
    <div className="stat" title={title}>
      {icon ? <div className="stat-icon"><Icon name={icon} size={17} /></div> : null}
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function Meter({ value, tone }: { value: number; tone?: 'ok' | 'warn' | 'err' }): ReactNode {
  return (
    <div className={`meter${tone ? ` ${tone}` : ''}`}>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

/**
 * A confirm dialog you await.
 *
 * `const confirm = useConfirm();` then `if (await confirm.ask({...})) ...` and render
 * `confirm.dialog` once in the page. Deleting a profile is a decision with consequences, so the
 * page that offers it must be able to stop and ask.
 */
export interface Confirmer {
  ask(options: { title: string; body: ReactNode; confirmLabel: string; danger?: boolean }): Promise<boolean>;
  /**
   * A one-line text prompt. `window.prompt` does not exist in Electron, so a page that reaches
   * for it - renaming a profile is the obvious one - would silently do nothing in the packaged
   * app while working in a browser tab.
   */
  askText(options: {
    title: string;
    label: string;
    value?: string;
    confirmLabel: string;
    placeholder?: string;
    hint?: string;
  }): Promise<string | null>;
  dialog: ReactNode;
}

export function useConfirm(): Confirmer {
  const [state, setState] = useState<{
    title: string;
    body: ReactNode;
    confirmLabel: string;
    danger?: boolean;
    resolve: (value: boolean) => void;
  } | null>(null);

  const [textState, setTextState] = useState<{
    title: string;
    label: string;
    value: string;
    confirmLabel: string;
    placeholder?: string;
    hint?: string;
    resolve: (value: string | null) => void;
  } | null>(null);

  const ask = useCallback(
    (options: { title: string; body: ReactNode; confirmLabel: string; danger?: boolean }) =>
      new Promise<boolean>((resolve) => setState({ ...options, resolve })),
    [],
  );

  const askText = useCallback(
    (options: {
      title: string;
      label: string;
      value?: string;
      confirmLabel: string;
      placeholder?: string;
      hint?: string;
    }) =>
      new Promise<string | null>((resolve) =>
        setTextState({ ...options, value: options.value ?? '', resolve }),
      ),
    [],
  );

  const textDialog = textState ? (
    <TextPrompt
      title={textState.title}
      label={textState.label}
      value={textState.value}
      confirmLabel={textState.confirmLabel}
      placeholder={textState.placeholder}
      hint={textState.hint}
      onCancel={() => {
        textState.resolve(null);
        setTextState(null);
      }}
      onConfirm={(value) => {
        textState.resolve(value.trim() || null);
        setTextState(null);
      }}
    />
  ) : null;

  const dialog = state ? (
    <Confirm
      title={state.title}
      body={state.body}
      confirmLabel={state.confirmLabel}
      danger={state.danger}
      onCancel={() => {
        state.resolve(false);
        setState(null);
      }}
      onConfirm={() => {
        state.resolve(true);
        setState(null);
      }}
    />
  ) : (
    textDialog
  );

  return { ask, askText, dialog };
}

/** The text prompt behind `askText`. Confirmed on Enter, cancelled on Escape or the backdrop. */
function TextPrompt({
  title,
  label,
  value,
  confirmLabel,
  placeholder,
  hint,
  onCancel,
  onConfirm,
}: {
  title: string;
  label: string;
  value: string;
  confirmLabel: string;
  placeholder?: string;
  hint?: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}): ReactNode {
  const [text, setText] = useState(value);

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <div className="spacer" />
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="check"
            disabled={text.trim().length === 0}
            onClick={() => onConfirm(text)}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Field label={label} hint={hint}>
        <input
          className="input"
          value={text}
          autoFocus
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && text.trim()) onConfirm(text);
          }}
        />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ formatting */

export function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size < 10 && index > 0 ? size.toFixed(1) : Math.round(size)} ${units[index]}`;
}

export function when(iso: string): string {
  if (!iso) return 'never';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return 'never';
  const delta = Date.now() - at;
  if (delta < 45_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} h ago`;
  if (delta < 7 * 86_400_000) return `${Math.round(delta / 86_400_000)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function clock(iso: string): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
