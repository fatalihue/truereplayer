import { CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { useToast, useToasts, type ToastType } from '../state/ToastContext';

const iconMap: Record<ToastType, { Icon: React.ElementType; color: string }> = {
  success: { Icon: CheckCircle2, color: 'var(--color-replay-fg)' },
  error:   { Icon: XCircle,      color: 'var(--color-recording-fg)' },
  info:    { Icon: Info,          color: 'var(--color-accent)' },
};

export function Toast() {
  // The list comes from its own context so every other consumer of useToast (which only ever calls
  // showToast) stops re-rendering on each show and auto-dismiss.
  const toasts = useToasts();
  const { dismissToast, pauseToast, resumeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        // Clear of the bottom chrome BY CONSTRUCTION, not by luck. Measured against the running
        // app: the StatusBar is 26px, the ActionBar's top sits 72 layout px above the viewport
        // bottom, and the BulkActionBar (h-8 = 32) stacks on top of it whenever rows are
        // selected — so 104 is the worst case and this leaves 8px of air above it.
        //
        // It used to sit at bottom:40, which is inside the ActionBar: the toast landed squarely
        // on Save/Load, and a notification that eats the click the user was about to make is
        // worse than no notification. Bulk edits are exactly when toasts fire AND exactly when
        // both of those bars are on screen.
        bottom: 112,
        // Centred over the action grid rather than pinned right, because the bottom-right corner
        // is already taken: LiveVariablesPanel is `fixed bottom-10 right-3` and up to 45vh tall,
        // so the two used to overlap whenever that pane was open.
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column-reverse',
        alignItems: 'center',
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
