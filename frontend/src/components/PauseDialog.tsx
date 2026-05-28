import { useState, useRef, useEffect, useCallback } from 'react';
import { Hourglass, X } from 'lucide-react';
import { NumberInput } from './common/NumberInput';
import { useBridge } from '../bridge/BridgeContext';

interface PauseDialogProps {
  onConfirm: (key: string, timeoutSeconds: number) => void;
  onClose: () => void;
}

/**
 * Pattern-B normalization for the Pause action: config-first modal that mirrors
 * Send Text / Run Profile / Send Keystroke. Previously, clicking + Pause in the
 * toolbar inserted a fully-empty Pause row and auto-opened the Sheet — Cancel
 * there left an orphan row the user had to delete manually. With this dialog the
 * row only materializes after the user clicks Add.
 *
 * Three valid configurations (no combination is rejected):
 *   • Hotkey only          — wait until the user presses the captured key
 *   • Timeout only         — wait N seconds then continue
 *   • Both                 — first one fires resumes; the engine cancels the other
 *   • Neither (both empty) — infinite manual wait (Resume button in the status bar)
 *
 * Hotkey capture mirrors the SheetPanel pattern: the backend low-level hook is
 * activated while the field is focused so Win+letter combos the WebView2 JS layer
 * never sees still arrive. Pure-modifier presses keep the capture open; the first
 * non-modifier commits the combo.
 */
export function PauseDialog({ onConfirm, onClose }: PauseDialogProps) {
  const [hotkey, setHotkey] = useState('');
  // Default 1 s — matches the most common "small synchronization pause" use case
  // (insert a quick wait between two automation steps). Users who want a longer
  // pause hit the preset chips below; users who want a hotkey-only Pause clear
  // the timeout via the ∞ preset.
  const [timeoutSeconds, setTimeoutSeconds] = useState(1);
  const [hotkeyFocused, setHotkeyFocused] = useState(false);
  const hotkeyInputRef = useRef<HTMLInputElement>(null);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { send, subscribe } = useBridge();

  // Idle-cancel timer for the hotkey capture field — same 4 s window the inline
  // row-edit capture uses, so the user can't get stuck "armed" forever if they
  // walk away mid-bind.
  const HOTKEY_CAPTURE_IDLE_MS = 4000;
  const armCaptureTimer = useCallback(() => {
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = setTimeout(() => {
      hotkeyInputRef.current?.blur();
    }, HOTKEY_CAPTURE_IDLE_MS);
  }, []);
  const disarmCaptureTimer = useCallback(() => {
    if (captureTimerRef.current) {
      clearTimeout(captureTimerRef.current);
      captureTimerRef.current = null;
    }
  }, []);

  // Cleanup-only effect — disarm the hotkey capture idle timer on unmount so a stray
  // setTimeout doesn't fire blur() against a torn-down ref. Auto-focus of the timeout
  // input is delegated to <NumberInput autoFocus /> below, which has direct ref access
  // (the dialog historically tried to claim "focus the timeout input" here but never
  // actually called focus() — keyboard users opening the dialog and pressing Enter got
  // a no-op until the autoFocus prop landed).
  useEffect(() => {
    return () => disarmCaptureTimer();
  }, [disarmCaptureTimer]);

  // Activate / deactivate the backend low-level hook for hotkey capture. Without
  // this, Win+letter combos never reach the React layer (the OS shell eats them).
  // Only RUNS its body on focus; unfocus relies on the previous render's cleanup
  // to disable. Avoids the stray enabled:false message that used to fire on every
  // initial mount.
  // KNOWN LIMITATION: hotkey:capture is a global backend toggle without refcounts.
  // If another component (e.g. SheetPanel's pause-edit field) is simultaneously
  // active, this dialog's cleanup will disable the hook out from under it. The UI
  // flow today guarantees mutual exclusion (modal blocks the Sheet), but post-v2.3
  // we should refcount hook ownership on the backend to make this safe by design.
  useEffect(() => {
    if (!hotkeyFocused) return;
    send({ type: 'hotkey:capture', payload: { enabled: true } });
    const unsubscribe = subscribe((msg) => {
      if (msg.type !== 'hotkey:captured') return;
      const combo = msg.payload.combo;
      setHotkey(combo);
      armCaptureTimer();
      // Pure modifiers (Ctrl, Shift, Win, Alt, or chords of only those) leave the
      // field armed so the user can build "Ctrl+Shift+R". The first non-modifier
      // commits the combo and blurs.
      const isPureModifier = /^(Win|Ctrl|Alt|Shift)(\+(Win|Ctrl|Alt|Shift))*$/.test(combo);
      if (!isPureModifier) {
        disarmCaptureTimer();
        hotkeyInputRef.current?.blur();
      }
    });
    return () => {
      unsubscribe();
      send({ type: 'hotkey:capture', payload: { enabled: false } });
    };
  }, [hotkeyFocused, send, subscribe, armCaptureTimer, disarmCaptureTimer]);

  const handleConfirm = () => {
    // Empty hotkey + zero timeout = infinite manual pause — explicitly valid.
    onConfirm(hotkey.trim(), Math.max(0, timeoutSeconds));
  };

  const handleClearHotkey = (e: React.MouseEvent) => {
    e.stopPropagation();
    setHotkey('');
    hotkeyInputRef.current?.focus();
  };

  const handleDialogKeyDown = (e: React.KeyboardEvent) => {
    // Enter confirms unless the hotkey field is armed (Enter would otherwise be
    // captured as the bound key — surprising). Escape always closes. Both stop
    // propagation so the CommandPalette / global keydown listeners don't double-handle
    // the same press (Escape used to bubble up to the app-level handler).
    if (e.key === 'Enter' && !hotkeyFocused) {
      e.preventDefault();
      e.stopPropagation();
      handleConfirm();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={(e) => e.stopPropagation()}
      // Backdrop click closes the dialog UNLESS the user is mid-hotkey-capture — in
      // that state the low-level hook is enabled and an accidental backdrop click
      // would unmount the dialog before the field's blur cleanup fires, leaving a
      // window where the global hook stays armed. Forcing a click on the hotkey field
      // (or anywhere inside the dialog) first lets the normal cleanup path run.
      onClick={() => { if (!hotkeyFocused) onClose(); }}
    >
      <div
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-xl w-[440px] max-w-[90vw] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <Hourglass size={14} style={{ color: 'var(--color-action-pause-fg)' }} />
          <h3 className="text-sm font-semibold text-text-primary">Insert Pause</h3>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-4">
          {/* Resume hotkey — capture field. Empty = no hotkey configured. */}
          <div>
            <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">RESUME HOTKEY</label>
            <div className="relative">
              <input
                ref={hotkeyInputRef}
                type="text"
                readOnly
                value={hotkeyFocused ? '' : hotkey}
                placeholder={hotkeyFocused ? 'Press any key…' : 'Click to capture…'}
                onFocus={() => { setHotkeyFocused(true); armCaptureTimer(); }}
                onBlur={() => { setHotkeyFocused(false); disarmCaptureTimer(); }}
                className={`w-full h-9 px-3 pr-8 text-sm font-mono text-text-primary bg-bg-input border rounded outline-none transition-colors ${
                  hotkeyFocused
                    ? 'border-accent-solid animate-pulse'
                    : 'border-border-subtle focus:border-accent-solid'
                }`}
              />
              {hotkey && !hotkeyFocused && (
                <button
                  type="button"
                  onClick={handleClearHotkey}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
                  title="Clear hotkey"
                  tabIndex={-1}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          {/* Timeout — seconds. 0 (selected via the ∞ preset) means "no timeout";
              the Pause then only resumes via the hotkey above. */}
          <div>
            <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TIMEOUT</label>
            <div className="flex items-center gap-2">
              <NumberInput
                value={timeoutSeconds}
                onChange={setTimeoutSeconds}
                min={0}
                inputWidth="w-24"
                inputHeight="h-9"
                ariaLabel="Pause timeout in seconds"
                autoFocus
              />
              <span className="text-xs text-text-tertiary">seconds</span>
            </div>
            {/* Same preset set + visual treatment SheetPanel uses for the Pause editor.
                Keeping the two surfaces parallel means muscle memory carries over: a
                user who knows 1s/5s/30s/1m/5m/∞ from the Sheet sees the same chips
                here. ∞ (secs=0) pairs with a captured hotkey to form a "wait forever
                until the user presses X" Pause. */}
            <div className="flex flex-wrap gap-1 mt-1.5">
              {([
                { label: '1s', secs: 1 },
                { label: '5s', secs: 5 },
                { label: '30s', secs: 30 },
                { label: '1m', secs: 60 },
                { label: '5m', secs: 300 },
                { label: '∞', secs: 0 },
              ] as const).map(p => {
                const isActive = timeoutSeconds === p.secs;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setTimeoutSeconds(p.secs)}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                      isActive
                        ? 'text-accent border-accent/30 bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
                        : 'text-text-tertiary border-border-default bg-bg-elevated hover:text-text-secondary hover:bg-bg-card'
                    }`}
                    title={p.secs === 0 ? 'No timeout — resume by hotkey only' : `Wait ${p.label}`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Mode hint — explains what each combination does. The no-hotkey-no-timeout
              case is a CONFIGURATION ERROR (the replay engine silently skips a Pause row
              with no resume condition — there's no manual-resume hook for empty Pause
              today), so the hint explicitly tells the user to set at least one field
              before Add becomes available. */}
          <p className="text-[11px] text-text-tertiary leading-relaxed">
            {hotkey && timeoutSeconds > 0
              ? 'Resumes on hotkey or timeout — whichever fires first.'
              : hotkey
                ? 'Waits until the hotkey is pressed.'
                : timeoutSeconds > 0
                  ? `Waits ${timeoutSeconds} second${timeoutSeconds === 1 ? '' : 's'} then continues.`
                  : 'Set a hotkey or timeout — without either, the Pause is skipped at replay.'}
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-subtle">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-text-secondary bg-bg-card hover:bg-bg-surface border border-border-subtle rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!hotkey && timeoutSeconds === 0}
            className="px-4 py-1.5 text-xs font-medium text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
