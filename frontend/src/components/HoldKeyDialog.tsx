import { useState, useRef, useEffect, useCallback } from 'react';
import { Timer, Minus, Plus } from 'lucide-react';
import { mapKeyEvent, keyDisplayLabel } from './KeyCaptureDialog';

interface HoldKeyDialogProps {
  // Optional initial values used when re-opening the dialog to edit an existing
  // HoldKey row. Presence of `initialKey` flips the dialog to edit mode (Save
  // button, captured value pre-filled, Esc cancels). Absent on insert flows.
  initialKey?: string;
  initialHoldDurationMs?: number;
  onConfirm: (key: string, holdDurationMs: number) => void;
  onClose: () => void;
}

const DEFAULT_HOLD_MS = 1000;      // matches ActionItem.DefaultHoldDurationMs (C#)
const MIN_HOLD_MS = 10;
const MAX_HOLD_MS = 60000;

// Step rule for spinner buttons: snap to one-second steps once we're at >= 1000 ms
// (most users picking 1s, 2s, 5s, etc.); below that, finer 100 ms steps so the user
// can dial in micro-holds (50 ms, 200 ms) for fast-keypress macros.
const stepFor = (v: number) => v >= 1000 ? 1000 : 100;

/**
 * Modal that captures a single key + a hold duration (milliseconds) and reports
 * both back to the caller. The caller is expected to insert ONE HoldKey row
 * (action type "HoldKey", Key = captured, HoldDurationMs = duration) — the
 * replay engine sends KEYDOWN, waits the duration, then KEYUP.
 *
 * Why a dedicated dialog instead of reusing KeyCaptureDialog + a hand-edit of
 * the resulting row's delay: holding a key is a single intent ("press W for 2
 * seconds") but the legacy 2-row Down/Up + manual delay edit is 3 separate
 * operations. This dialog lets the user express the intent once.
 *
 * The capture half mirrors KeyCaptureDialog (reuses mapKeyEvent /
 * keyDisplayLabel) so a Send Key insert and a Hold Key insert produce the
 * same canonical key names, which keeps replay resolution consistent across
 * action types.
 */
export function HoldKeyDialog({
  initialKey,
  initialHoldDurationMs,
  onConfirm,
  onClose,
}: HoldKeyDialogProps) {
  const isEditing = initialKey != null;
  const [captured, setCaptured] = useState<string | null>(initialKey ?? null);
  const [holdMs, setHoldMs] = useState<number>(initialHoldDurationMs ?? DEFAULT_HOLD_MS);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const clamp = (v: number) => Math.max(MIN_HOLD_MS, Math.min(MAX_HOLD_MS, Math.floor(v)));

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Numeric inputs handle their own keystrokes — don't hijack digits for capture.
    const target = e.target as HTMLElement;
    if (target?.tagName === 'INPUT') return;
    // Esc closes when no key captured yet, or when editing (cancel the edit).
    // When inserting AND already captured, Esc re-captures (replaces with a new key).
    if (e.key === 'Escape' && (captured === null || isEditing)) {
      e.preventDefault();
      onClose();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const name = mapKeyEvent(e.nativeEvent);
    if (name) setCaptured(name);
  }, [captured, isEditing, onClose]);

  const handleConfirm = () => {
    if (captured) onConfirm(captured, clamp(holdMs));
  };

  // Display the chosen duration in seconds when it's a clean multiple of 1000,
  // otherwise show ms — keeps the readout natural for the common "press for N
  // seconds" intent without losing precision for sub-second holds.
  const durationLabel = holdMs >= 1000 && holdMs % 100 === 0
    ? `${(holdMs / 1000).toFixed(holdMs % 1000 === 0 ? 0 : 1)} s`
    : `${holdMs} ms`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-xl w-[420px] max-w-[90vw] flex flex-col outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header — title flips to "Edit Hold" when re-opened to tweak an existing row. */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <Timer size={14} className="text-accent-light" />
          <h3 className="text-sm font-semibold text-text-primary">
            {isEditing ? 'Edit Hold Key' : 'Hold Key for X seconds'}
          </h3>
        </div>

        {/* Body — fixed layout: 136-px capture pad on top, duration row below. */}
        <div className="px-5 py-5 flex flex-col gap-4">
          {/* Capture pad — same gold-dashed treatment as KeyCaptureDialog. */}
          <div className="bg-bg-input border border-dashed border-[#FFC107]/40 rounded-md py-5 px-4 text-center min-h-[136px] flex flex-col justify-center">
            {captured === null ? (
              <>
                <div className="text-[12px] text-text-tertiary mb-1">Press any key…</div>
                <div className="text-[10px] text-text-disabled">
                  Esc cancels
                </div>
              </>
            ) : (
              <>
                <kbd
                  className="inline-block self-center px-3 py-1.5 bg-bg-elevated border border-border-default rounded font-mono text-[14px] font-semibold text-[#FFC107]"
                  style={{ boxShadow: '0 2px 0 rgba(0,0,0,0.3)' }}
                >
                  {keyDisplayLabel(captured)}
                </kbd>
                <div className="mt-2 text-[10px] text-text-tertiary">
                  {isEditing
                    ? <>Updates row to <span className="text-text-secondary font-semibold">{durationLabel} hold</span></>
                    : <>Inserts <span className="text-text-secondary font-semibold">1 row · {durationLabel} hold</span></>}
                </div>
                <div className="mt-1 text-[10px] text-text-disabled">
                  Press another key to replace
                </div>
              </>
            )}
          </div>

          {/* Duration — same right-aligned spinner pattern as KeystrokeCaptureDialog,
              so the two dialogs feel like siblings. Phantom 24×24 keeps the input
              column on the same vertical line as a [−] / [+] pair would. */}
          <div className="flex items-center justify-between gap-3">
            <label className="text-[12px] font-medium text-text-secondary">Hold for</label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setHoldMs(v => clamp(v - stepFor(v)))}
                disabled={holdMs <= MIN_HOLD_MS}
                className="w-6 h-6 flex items-center justify-center rounded bg-bg-card hover:bg-bg-input border border-border-subtle text-text-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label="Decrease hold duration"
              >
                <Minus size={11} />
              </button>
              <input
                type="number"
                min={MIN_HOLD_MS}
                max={MAX_HOLD_MS}
                step={100}
                value={holdMs}
                onChange={(e) => {
                  // Don't clamp to MIN_HOLD_MS during typing — that broke free-form entry
                  // because every digit-typed value below 10 (a transient state while the
                  // user is reaching for, say, "5000") got snapped to 10 instantly, and the
                  // input rewrote itself before the user could finish. Allow 0..MAX in the
                  // state and let onBlur / handleConfirm enforce the lower bound on commit.
                  const raw = e.target.value;
                  if (raw === '') { setHoldMs(0); return; }
                  const n = parseInt(raw, 10);
                  if (Number.isFinite(n) && n >= 0) {
                    setHoldMs(Math.min(MAX_HOLD_MS, n));
                  }
                }}
                onBlur={() => setHoldMs(v => clamp(v))}
                className="w-20 h-6 px-1 text-center text-xs font-mono text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid tabular-nums"
              />
              <button
                type="button"
                onClick={() => setHoldMs(v => clamp(v + stepFor(v)))}
                disabled={holdMs >= MAX_HOLD_MS}
                className="w-6 h-6 flex items-center justify-center rounded bg-bg-card hover:bg-bg-input border border-border-subtle text-text-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label="Increase hold duration"
              >
                <Plus size={11} />
              </button>
              <span className="text-[11px] text-text-tertiary ml-1">ms</span>
            </div>
          </div>

          {/* Preset chips — common hold durations one click away. Picking a preset
              writes the value directly; doesn't lock the input (user can still
              fine-tune via the spinner / typed entry afterwards). */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-text-tertiary">Presets:</span>
            {[100, 500, 1000, 2000, 5000].map(ms => (
              <button
                key={ms}
                type="button"
                onClick={() => setHoldMs(ms)}
                className={`px-2 py-0.5 rounded text-[10px] font-mono tabular-nums transition-colors ${
                  holdMs === ms
                    ? 'bg-accent-solid/20 text-accent-light border border-accent-solid/40'
                    : 'bg-bg-card hover:bg-bg-input border border-border-subtle text-text-tertiary hover:text-text-secondary'
                }`}
              >
                {ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-subtle">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-text-secondary bg-bg-card hover:bg-bg-surface border border-border-subtle rounded transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={captured === null}
            className="px-4 py-1.5 text-xs font-medium text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isEditing ? 'Save' : 'Insert'}
          </button>
        </div>
      </div>
    </div>
  );
}
