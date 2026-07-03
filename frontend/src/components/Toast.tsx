import { CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { useToast, type ToastType } from '../state/ToastContext';

const iconMap: Record<ToastType, { Icon: React.ElementType; color: string }> = {
  success: { Icon: CheckCircle2, color: 'var(--color-replay)' },
  error:   { Icon: XCircle,      color: 'var(--color-recording)' },
  info:    { Icon: Info,          color: 'var(--color-accent)' },
};

export function Toast() {
  const { toasts, dismissToast, pauseToast, resumeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 40,
        right: 16,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 8,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((toast) => {
        const { Icon, color } = iconMap[toast.type];
        return (
          <div
            key={toast.id}
            className="toast-enter"
            // Freeze the countdown while the pointer is over the toast — an 8s
            // error shouldn't be a reading race.
            onMouseEnter={() => pauseToast(toast.id)}
            onMouseLeave={() => resumeToast(toast.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              background: 'var(--color-bg-card)',
              border: '1px solid var(--color-border-default)',
              borderRadius: 'var(--ui-border-radius)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              maxWidth: 380,
              pointerEvents: 'auto',
            }}
          >
            <Icon size={14} style={{ color, flexShrink: 0 }} />
            <span className="text-ui text-text-primary" style={{ flex: 1 }}>{toast.message}</span>
            {toast.action && (
              <button
                onClick={() => {
                  toast.action!.onClick();
                  dismissToast(toast.id);
                }}
                className="text-ui font-semibold uppercase tracking-wider px-2 py-1 rounded hover:bg-bg-elevated transition-colors"
                style={{ color: 'var(--color-accent)', flexShrink: 0 }}
              >
                {toast.action.label}
              </button>
            )}
            <button
              onClick={() => dismissToast(toast.id)}
              className="p-1 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
              style={{ flexShrink: 0 }}
              aria-label="Dismiss notification"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
