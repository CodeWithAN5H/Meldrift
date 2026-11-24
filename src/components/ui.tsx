import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';
import { colorFor, initialsOf, vars, type Presence } from '@/lib/model';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ---- Button ------------------------------------------------------------ */

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  block?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'default',
  size = 'md',
  block,
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'md-btn',
        variant !== 'default' && `md-btn--${variant}`,
        size === 'sm' && 'md-btn--sm',
        block && 'md-btn--block',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/* ---- Icon button ------------------------------------------------------- */

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  tone?: 'accent' | 'danger';
  round?: boolean;
}

export function IconButton({
  label,
  active,
  tone,
  round,
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cx(
        'md-icon-btn',
        round && 'md-icon-btn--round',
        active && 'md-icon-btn--on',
        tone === 'danger' && 'md-icon-btn--danger',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ---- Avatar ------------------------------------------------------------ */

interface AvatarProps {
  name: string;
  color?: string;
  size?: number;
  presence?: Presence;
  square?: boolean;
  className?: string;
}

export function Avatar({
  name,
  color,
  size = 34,
  presence,
  square,
  className,
}: AvatarProps) {
  const background = color ?? colorFor(name);
  return (
    <span
      className={cx('md-avatar', square && 'md-avatar--square', className)}
      style={vars({ '--av-size': `${size}px`, '--av-bg': background })}
      aria-hidden="true"
    >
      {initialsOf(name)}
      {presence ? <span className="md-avatar__presence" data-state={presence} /> : null}
    </span>
  );
}

/* ---- Pill -------------------------------------------------------------- */

export function Pill({
  children,
  tone,
  className,
}: {
  children: ReactNode;
  tone?: 'live' | 'green' | 'accent' | 'counter';
  className?: string;
}) {
  return (
    <span className={cx('md-pill', tone && `md-pill--${tone}`, className)}>{children}</span>
  );
}

/* ---- Field ------------------------------------------------------------- */

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('md-field', className)}>
      <label className="md-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="md-hint">{hint}</p> : null}
    </div>
  );
}

/* ---- Switch ------------------------------------------------------------ */

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="md-switch"
      data-on={checked}
      onClick={() => onChange(!checked)}
    />
  );
}

/* ---- Slider ------------------------------------------------------------ */

interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: number;
  onValueChange: (value: number) => void;
}

export function Slider({ value, min = 0, max = 100, onValueChange, ...rest }: SliderProps) {
  const lo = Number(min);
  const hi = Number(max);
  const pct = hi > lo ? ((value - lo) / (hi - lo)) * 100 : 0;
  return (
    <input
      type="range"
      className="md-slider"
      min={min}
      max={max}
      value={value}
      style={vars({ '--fill': `${pct}%` })}
      onChange={(event) => onValueChange(Number(event.target.value))}
      {...rest}
    />
  );
}

/* ---- Modal ------------------------------------------------------------- */

interface ModalProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Modal({ title, subtitle, onClose, children, footer, wide }: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const firstField = panelRef.current?.querySelector<HTMLElement>(
      'input:not([type="hidden"]), textarea, select, button',
    );
    firstField?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="md-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={cx('md-modal', wide && 'md-modal--wide')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
      >
        <div className="md-modal__head">
          <div>
            <h2 className="md-modal__title" id={titleId}>
              {title}
            </h2>
            {subtitle ? <p className="md-modal__sub">{subtitle}</p> : null}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>
        <div className="md-modal__body">{children}</div>
        {footer ? <div className="md-modal__foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/* ---- Empty state ------------------------------------------------------- */

export function EmptyState({
  icon,
  title,
  text,
  action,
  compact,
}: {
  icon: ReactNode;
  title: string;
  text?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="md-empty" style={compact ? { padding: '22px 16px' } : undefined}>
      <span className="md-empty__icon">{icon}</span>
      <h3 className="md-empty__title">{title}</h3>
      {text ? <p className="md-empty__text">{text}</p> : null}
      {action}
    </div>
  );
}

/* ---- Misc -------------------------------------------------------------- */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="md-kbd">{children}</kbd>;
}

export function Spinner({ size = 16, label = 'Loading' }: { size?: number; label?: string }) {
  return <Loader2 size={size} className="md-spin" role="status" aria-label={label} />;
}

export function SectionLabel({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="md-section-title">
      <span>{children}</span>
      {action ? <span style={{ marginLeft: 'auto' }}>{action}</span> : null}
    </div>
  );
}
