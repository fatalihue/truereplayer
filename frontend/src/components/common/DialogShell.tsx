import { useEffect, useRef, useState, type ReactNode, type KeyboardEvent, type MouseEvent } from 'react';
import { X } from 'lucide-react';

/**
 * Shared chrome for the modal-dialog family — the scrim + card + header/footer
 * skeleton that PauseDialog/SendTextDialog/etc. each hand-rolled (five nearly
 * identical copies, per the 2026-07 audit), now with:
 *
 *   • dialog semantics (role=dialog aria-modal aria-label) — there were none
 *   • symmetric motion: cards animate IN on mount and OUT on dismissal.
 *     Dismissals (Esc / backdrop / an explicit close affordance calling
 *     requestClose) play the exit animation; CONFIRM paths should keep calling
 *     onClose directly — completing an action is user-initiated "done", which
 *     renders instantly by design (same doctrine as the command palette).
 *   • one Escape implementation (preventDefault + stopPropagation, matching the
 *     careful layering the sheet established).
 *
 * Enter-key behavior stays per-dialog via onCardKeyDown — the capture dialogs
 * (Pause / Keystroke) have Enter semantics tied to the low-level hook that a
 * shared shell must not own.
 */

export interface DialogShellProps {
  /** Icon rendered before the title (usually the action's Lucide icon, size 14). */
  icon?: ReactNode;
  title: string;
  /** Tailwind width class for the card. */
  widthClass?: string;
  /** Called after the exit animation completes (or immediately when animations are off). */
  onClose: () => void;
  /** Dismiss when the scrim is clicked. Default true; capture dialogs pass false. */
  closeOnBackdrop?: boolean;
  /** Render an X close button in the header (wired to the shell's own requestClose,
   *  so it plays the exit animation). Off by default — most dialogs close via footer. */
  showClose?: boolean;
  /** Veto a backdrop-click close. Called with the scrim click event; return true to
   *  IGNORE the click (e.g. clicks in the OS title-bar guard zone: (e)=>e.clientY<40).
   *  Only consulted when closeOnBackdrop is on. */
  scrimMouseDownGuard?: (e: MouseEvent<HTMLDivElement>) => boolean;
  /** Left-aligned hint text in the footer (e.g. "Enter to confirm · Esc to cancel"). */
  footerHint?: ReactNode;
  /** Right-aligned footer actions (Button components). Omit for footerless dialogs.
   *  Function form receives requestClose so a Cancel button can play the exit
   *  animation instead of unmounting instantly via onClose. */
  footer?: ReactNode | ((requestClose: () => void) => ReactNode);
  /** Extra keydown handling on the card (Enter rules etc.). Esc is already handled. */
  onCardKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}

export function DialogShell({
  icon,
  title,
  widthClass = 'w-[440px]',
  onClose,
  closeOnBackdrop = true,
  showClose = false,
  scrimMouseDownGuard,
  footerHint,
  footer,
  onCardKeyDown,
  children,
}: DialogShellProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  // Where the last mousedown landed — a drag that merely ENDS on the scrim
  // (text selection pulled outside the card) must not count as a backdrop click.
  const pressOnScrim = useRef(false);

  // Focus the card so Esc works without a click first (the convention every
  // hand-rolled dialog already followed).
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  // Exit fallback — animationend never fires if the window is occluded/minimized
  // (Chromium pauses CSS animations) or data-animations flips mid-flight; without
  // this the dialog would strand in the leaving state.
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(onClose, 400);
    return () => clearTimeout(t);
  }, [leaving, onClose]);

  const requestClose = () => {
    if (leaving) return; // re-entry guard (double Esc, Esc during exit)
    // With animations off there's no animationend to wait for — close now.
    if (document.documentElement.getAttribute('data-animations') !== 'true') {
      onClose();
      return;
    }
    setLeaving(true);
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 dialog-scrim ${leaving ? 'dialog-leaving' : ''}`}
      onMouseDown={(e) => {
        // Pressing the scrim itself must not steal focus from the card —
        // otherwise Chromium focuses <body> and the card's Esc handler goes
        // dead on closeOnBackdrop=false dialogs. Target-guarded: mousedown
        // bubbles from card children, and preventing THOSE would block
        // focusing the card's inputs.
        pressOnScrim.current = e.target === e.currentTarget;
        if (pressOnScrim.current) e.preventDefault();
      }}
      onClick={closeOnBackdrop
        ? (e) => { if (pressOnScrim.current && e.target === e.currentTarget && !scrimMouseDownGuard?.(e)) requestClose(); }
        : undefined}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`dialog-card bg-bg-elevated border border-border-subtle rounded-lg shadow-xl ${widthClass} max-w-[90vw] flex flex-col outline-none`}
        onClick={(e) => e.stopPropagation()}
        // Only the card's OWN dialog-out end may unmount — animationend bubbles,
        // so a child's finishing animation must not close the dialog early.
        onAnimationEnd={(e) => {
          if (leaving && e.target === e.currentTarget) onClose();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            requestClose();
            return;
          }
          // Focus trap — Tab cycles within the card. Without this, Tab walks out
          // into the app behind the scrim, where Space/Enter can actuate
          // background controls through a modal.
          if (e.key === 'Tab') {
            const tabbables = cardRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
            );
            if (!tabbables?.length) { e.preventDefault(); return; }
            const first = tabbables[0];
            const last = tabbables[tabbables.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && (active === first || active === cardRef.current)) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && active === last) {
              e.preventDefault();
              first.focus();
            }
            return;
          }
          onCardKeyDown?.(e);
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          {icon}
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          {showClose && (
            <button
              onClick={requestClose}
              aria-label="Close"
              className="ml-auto w-7 h-7 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-card transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {children}

        {/* Footer */}
        {(footer || footerHint) && (
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border-subtle">
            <span className="text-[11px] text-text-tertiary">{footerHint}</span>
            <div className="flex items-center gap-2">
              {typeof footer === 'function' ? footer(requestClose) : footer}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
