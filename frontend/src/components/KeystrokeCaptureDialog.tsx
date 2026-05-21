import { useState, useRef, useEffect, useCallback } from 'react';
import { Keyboard, Minus, Plus, AlertCircle } from 'lucide-react';

/**
 * Unified "Send Keystroke" dialog. One capture pad + a Press/Hold mode toggle covers
 * everything keyboard-related the user could want to insert manually:
 *
 *   Press mode (default):
 *     • Times = 1 → single press of a key or combo  (Ctrl+S, F5, A, Alt+Tab)
 *     • Times > 1 → press N times with configurable gap (Tab × 5, F5 × 10)
 *
 *   Hold mode:
 *     • Press a single key, keep it down for the configured duration
 *     • Preset chips for common holds (100 ms tap → 5 s long press)
 *     • Modifier keys are stripped on save — backend SimulateKey only handles
 *       single keys; the warning chip surfaces this whenever the captured value
 *       contains a "+", so the user is never surprised.
 *
 * Replaces the three legacy dialogs / menu entries (Send Key, Send Keystroke,
 * Press Key × N, Hold Key) — keeps the underlying ActionType split intact
 * (Keystroke for press flows, HoldKey for hold flows) so no profile migration
 * is required.
 */

// ── Capture helpers (key-mapping) ──

/**
 * Maps a non-modifier keydown event to the canonical key name used in actions. Mirrors
 * the legacy logic that lived split across KeyCaptureDialog and KeystrokeCaptureDialog —
 * one map now serves both single-key and combo capture since the dialog flavour is
 * decided after capture by the Press/Hold toggle.
 */
function mapKeyPart(e: KeyboardEvent): string | null {
  if (e.code.startsWith('Numpad') && e.code !== 'NumpadEnter' && e.code !== 'NumpadDecimal') {
    const numpadMap: Record<string, string> = {
      Numpad0: 'Num0', Numpad1: 'Num1', Numpad2: 'Num2', Numpad3: 'Num3',
      Numpad4: 'Num4', Numpad5: 'Num5', Numpad6: 'Num6', Numpad7: 'Num7',
      Numpad8: 'Num8', Numpad9: 'Num9',
      NumpadMultiply: 'NumMultiply', NumpadDivide: 'NumDivide',
      NumpadAdd: 'NumAdd', NumpadSubtract: 'NumSubtract',
    };
    return numpadMap[e.code] ?? e.code;
  }
  if (e.key === ' ') return 'Space';
  if (e.key === 'Enter') return 'Enter';
  if (e.key === 'Backspace') return 'Backspace';
  if (e.key === 'ArrowUp') return 'Up';
  if (e.key === 'ArrowDown') return 'Down';
  if (e.key === 'ArrowLeft') return 'Left';
  if (e.key === 'ArrowRight') return 'Right';
  if (e.key === 'Tab') return 'Tab';
  if (e.key === 'CapsLock') return 'CapsLock';
  if (e.key === 'NumLock') return 'NumLock';
  if (e.key === 'ScrollLock') return 'ScrollLock';
  if (e.key === 'Pause') return 'Pause';
  if (e.key === 'PrintScreen') return 'PrintScreen';
  if (e.key === 'ContextMenu') return 'VK_93';
  if (e.key === 'Delete') return 'Delete';
  if (e.key === 'Insert') return 'Insert';
  if (e.key === 'Home') return 'Home';
  if (e.key === 'End') return 'End';
  if (e.key === 'PageUp') return 'PageUp';
  if (e.key === 'PageDown') return 'PageDown';
  if (e.key === 'Escape') return 'Escape';
  if (e.key.startsWith('F') && e.key.length <= 3 && !isNaN(Number(e.key.slice(1)))) return e.key;
  // Dead keys (´ ` ^ ~ on ABNT2/AZERTY)
  if (e.key === 'Dead') {
    const deadCodeMap: Record<string, string> = {
      Backquote: '`', Quote: "'", BracketLeft: '[', BracketRight: ']',
      Minus: '-', Equal: '=', Digit6: '^',
    };
    return deadCodeMap[e.code] ?? null;
  }
  // Digit and letter keys — use e.code (physical, layout-independent, shift-immune)
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (e.key.length === 1) return e.key;
  return null;
}

/** Builds the "+"-joined combo string with a stable modifier order: Ctrl+Shift+Alt+KEY. */
function buildKeystroke(modifiers: { ctrl: boolean; shift: boolean; alt: boolean }, key: string): string {
  const parts: string[] = [];
  if (modifiers.ctrl) parts.push('Ctrl');
  if (modifiers.shift) parts.push('Shift');
  if (modifiers.alt) parts.push('Alt');
  parts.push(key);
  return parts.join('+');
}

/** Human-readable label for the chip. */
function keystrokeDisplay(keystroke: string): string {
  return keystroke.replace(/\bVK_93\b/, 'Menu');
}

// ── Constants (match the C# clamps) ──

const DEFAULT_REPEAT_DELAY_MS = 30;
const MAX_REPEAT = 999;
const MAX_REPEAT_DELAY = 5000;

const DEFAULT_HOLD_MS = 1000;
const MIN_HOLD_MS = 10;
const MAX_HOLD_MS = 60000;

// Common hold durations, surfaced as one-click chips. 250 ms (typical human key
// press) wasn't in the legacy HoldKeyDialog presets but lands naturally between
// "fast tap" (100 ms) and "deliberate hold" (500 ms), so it's worth offering.
const HOLD_PRESETS = [100, 250, 500, 1000, 2000, 5000];

/** Spinner step: 1 s once we're past 1 s, 100 ms below — match HoldKeyDialog's feel. */
const stepFor = (v: number) => v >= 1000 ? 1000 : 100;

// ── Component ──

type Mode = 'press' | 'hold';

export type SendKeystrokeResult =
  | { actionType: 'Keystroke'; key: string; repeat: number; repeatDelayMs: number }
  | { actionType: 'HoldKey'; key: string; holdDurationMs: number };

interface KeystrokeCaptureDialogProps {
  /**
   * Edit-mode seeds. When `initialKey` is set, the dialog opens in edit mode:
   * captured value pre-filled, Save button label, Esc closes (instead of re-arming
   * capture). `initialActionType` chooses the starting mode (Press for Keystroke,
   * Hold for HoldKey).
   */
  initialActionType?: 'Keystroke' | 'HoldKey';
  initialKey?: string;
  initialRepeat?: number;
  initialRepeatDelayMs?: number;
  initialHoldDurationMs?: number;
  onConfirm: (result: SendKeystrokeResult) => void;
  onClose: () => void;
}

export function KeystrokeCaptureDialog({
  initialActionType,
  initialKey,
  initialRepeat,
  initialRepeatDelayMs,
  initialHoldDurationMs,
  onConfirm,
  onClose,
}: KeystrokeCaptureDialogProps) {
  // `isEditing` flips Esc behaviour and the button label. Decoupled from mode so
  // we can edit a Keystroke row, switch to Hold, and save — converting the row's
  // ActionType without leaving the dialog.
  const isEditing = initialKey != null;

  // Mode follows the edited row's ActionType on insert/edit. Insert flow defaults
  // to Press because that's the most common keyboard intent (tap once / tap N
  // times); Hold is a deliberate choice the user toggles into.
  const [mode, setMode] = useState<Mode>(initialActionType === 'HoldKey' ? 'hold' : 'press');

  // Capture state — seeded from initialKey on edit so Save is enabled immediately.
  const [captured, setCaptured] = useState<string | null>(initialKey ?? null);

  // Press-mode state.
  const [repeat, setRepeat] = useState<number>(initialRepeat ?? 1);
  const [repeatDelay, setRepeatDelay] = useState<number>(initialRepeatDelayMs ?? DEFAULT_REPEAT_DELAY_MS);

  // Hold-mode state. Two-track (state + ref) because the Insert button can fire
  // immediately after a preset click before React's batched state has flushed —
  // reading from a synchronous ref on commit avoids a real "saves the previous
  // value" bug we hit in the original HoldKeyDialog.
  const initialMs = initialHoldDurationMs ?? DEFAULT_HOLD_MS;
  const [holdMs, setHoldMsState] = useState<number>(initialMs);
  const holdMsRef = useRef<number>(initialMs);
  const setHoldMs = useCallback((next: number | ((v: number) => number)) => {
    setHoldMsState(prev => {
      const value = typeof next === 'function' ? next(prev) : next;
      holdMsRef.current = value;
      return value;
    });
  }, []);

  // Re-sync when reopening the dialog on a different row (parent toggles mount
  // via `{editState && <Dialog />}` but React may reuse the instance at the same
  // JSX position). Without this, a second Edit click could open with stale values.
  useEffect(() => {
    if (initialHoldDurationMs != null) {
      setHoldMsState(initialHoldDurationMs);
      holdMsRef.current = initialHoldDurationMs;
    }
  }, [initialHoldDurationMs]);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Clamp helpers — applied on commit (handleConfirm) and on +/− spinner clicks.
  // Free-form typing is allowed to fall below the lower bound in transient states
  // so the input doesn't snap while the user is still typing.
  const clampRepeat = (v: number) => Math.max(1, Math.min(MAX_REPEAT, Math.floor(v)));
  const clampDelay = (v: number) => Math.max(0, Math.min(MAX_REPEAT_DELAY, Math.floor(v)));
  const clampHold = (v: number) => Math.max(MIN_HOLD_MS, Math.min(MAX_HOLD_MS, Math.floor(v)));

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't hijack keystrokes while the user is typing inside a numeric input —
    // a "5" pressed in the Times field should land as text, not re-capture the
    // combo. stopPropagation also blocks Ctrl+A from leaking up to ActionTable's
    // grid handler.
    const target = e.target as HTMLElement;
    if (target?.tagName === 'INPUT') {
      e.stopPropagation();
      return;
    }
    // Esc closes the dialog when:
    //   • no combo captured yet (insert flow waiting for first capture), OR
    //   • we're editing an existing row (Esc = abandon).
    // Otherwise (insert with combo captured) Esc re-captures so the user can
    // retry without leaving the dialog.
    if (e.key === 'Escape' && (captured === null || isEditing)) {
      e.preventDefault();
      onClose();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // Skip pure modifier presses — wait for the "real" key while modifiers
    // are held. Without this, pressing Ctrl on the way to Ctrl+A commits
    // "Ctrl" alone before the A keydown arrives.
    if (['Control', 'Shift', 'Alt', 'AltGraph', 'Meta'].includes(e.key)) return;
    const keyPart = mapKeyPart(e.nativeEvent);
    if (!keyPart) return;
    const modifiers = {
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
    };
    setCaptured(buildKeystroke(modifiers, keyPart));
  }, [captured, isEditing, onClose]);

  // Derived values used by the renderer + commit.
  const hasModifiers = captured?.includes('+') ?? false;
  // For Hold mode, only the last part of the combo gets used on commit — that's
  // the actual key the OS will keep pressed. Modifiers in the captured string
  // would confuse SimulateKey (no virtual-key code for "Ctrl+S"), so we strip
  // them at save time and warn in the UI.
  const heldKey = captured ? captured.split('+').pop() ?? captured : '';

  const handleConfirm = () => {
    if (!captured) return;
    if (mode === 'hold') {
      onConfirm({
        actionType: 'HoldKey',
        key: heldKey,
        holdDurationMs: clampHold(holdMsRef.current),
      });
    } else {
      onConfirm({
        actionType: 'Keystroke',
        key: captured,
        repeat: clampRepeat(repeat),
        repeatDelayMs: clampDelay(repeatDelay),
      });
    }
  };

  // Duration readout — show seconds for clean multiples of 1000, otherwise ms.
  const durationLabel = holdMs >= 1000 && holdMs % 100 === 0
    ? `${(holdMs / 1000).toFixed(holdMs % 1000 === 0 ? 0 : 1)} s`
    : `${holdMs} ms`;

  // Title flips by intent: edit vs insert, then by mode.
  const title = isEditing
    ? (mode === 'hold' ? 'Edit Hold Key' : 'Edit Keystroke')
    : 'Send Keystroke';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-xl w-[440px] max-w-[90vw] flex flex-col outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <Keyboard size={14} className="text-accent-light" />
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        </div>

        <div className="px-5 py-5 flex flex-col gap-4">
          {/* Capture pad — universal for both modes. Single press detects whatever
              modifiers the user is holding; Hold mode silently uses only the last
              key, with a warning chip when modifiers got dropped. */}
          <div className="bg-bg-input border border-dashed border-[#FFC107]/40 rounded-md py-5 px-4 text-center min-h-[156px] flex flex-col justify-center">
            {captured === null ? (
              <>
                <div className="text-[12px] text-text-tertiary mb-1">Press any key or combo</div>
                <div className="text-[10px] text-text-tertiary">
                  Single keys, or Ctrl/Shift/Alt + key. E.g. A · F5 · Ctrl+S · Alt+Tab
                </div>
                <div className="text-[10px] text-text-tertiary mt-1">Esc to cancel</div>
              </>
            ) : (
              <>
                <div className="inline-flex items-center justify-center self-center gap-1 flex-wrap">
                  {keystrokeDisplay(captured).split('+').map((part, idx, arr) => (
                    <span key={`${part}-${idx}`} className="inline-flex items-center gap-1">
                      <kbd
                        className="inline-block px-2.5 py-1 bg-bg-elevated border border-border-default rounded font-mono text-[13px] font-semibold text-[#FFC107]"
                        style={{ boxShadow: '0 2px 0 rgba(0,0,0,0.3)' }}
                      >
                        {part}
                      </kbd>
                      {idx < arr.length - 1 && <span className="text-text-tertiary text-[12px]">+</span>}
                    </span>
                  ))}
                </div>
                <div className="mt-3 text-[10px] text-text-tertiary">
                  {mode === 'hold'
                    ? (isEditing
                        ? <>Updates row to <span className="text-text-secondary font-semibold">{durationLabel} hold</span></>
                        : <>Inserts <span className="text-text-secondary font-semibold">1 row · {durationLabel} hold</span></>)
                    : (repeat > 1
                        ? (isEditing
                            ? <>Updates row to <span className="text-text-secondary font-semibold">{repeat} press cycles</span></>
                            : <>Inserts <span className="text-text-secondary font-semibold">1 row · {repeat} press cycles</span></>)
                        : (isEditing
                            ? <>Updates row to <span className="text-text-secondary font-semibold">single press</span></>
                            : <>Inserts <span className="text-text-secondary font-semibold">1 Keystroke row</span></>))}
                </div>
                <div className="mt-1 text-[10px] text-text-tertiary">Press another combo to replace</div>
              </>
            )}
          </div>

          {/* Mode toggle — switches the body below between Press and Hold settings.
              Two equal-width buttons read as a segmented control without needing a
              dedicated component. Active state uses the accent colour to mirror
              the dialog's primary action. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wider">Mode</span>
            <div className="grid grid-cols-2 gap-1 p-1 bg-bg-input border border-border-default rounded">
              {(['press', 'hold'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`px-3 py-1.5 rounded text-[12px] font-medium transition-colors ${
                    mode === m
                      ? 'bg-accent-solid text-white'
                      : 'text-text-secondary hover:bg-bg-card hover:text-text-primary'
                  }`}
                >
                  {m === 'press' ? 'Press' : 'Hold'}
                </button>
              ))}
            </div>
          </div>

          {/* ── PRESS mode body ── */}
          {mode === 'press' && (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3">
                <label className="text-[12px] font-medium text-text-secondary">Times to repeat</label>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setRepeat((v) => clampRepeat(v - 1))}
                    disabled={repeat <= 1}
                    className="w-6 h-6 flex items-center justify-center rounded bg-bg-card hover:bg-bg-input border border-border-subtle text-text-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    aria-label="Decrease repeat count"
                  >
                    <Minus size={11} />
                  </button>
                  <input
                    type="number"
                    min={1}
                    max={MAX_REPEAT}
                    value={repeat}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      setRepeat(Number.isFinite(n) ? clampRepeat(n) : 1);
                    }}
                    className="w-14 h-6 px-1 text-center text-xs font-mono text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid tabular-nums"
                  />
                  <button
                    type="button"
                    onClick={() => setRepeat((v) => clampRepeat(v + 1))}
                    disabled={repeat >= MAX_REPEAT}
                    className="w-6 h-6 flex items-center justify-center rounded bg-bg-card hover:bg-bg-input border border-border-subtle text-text-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    aria-label="Increase repeat count"
                  >
                    <Plus size={11} />
                  </button>
                </div>
              </div>

              {/* Gap stays visible but dims when Times = 1 — communicates the field
                  exists for repeat-flavoured presses without making the dialog
                  jump in height when the user increments Times. */}
              <div className="flex items-center justify-between gap-3">
                <label className={`text-[12px] font-medium transition-colors ${repeat > 1 ? 'text-text-secondary' : 'text-text-tertiary'}`}>
                  Gap between presses
                </label>
                <div className="flex items-center gap-1">
                  <div className="w-6 h-6" aria-hidden="true" />
                  <input
                    type="number"
                    min={0}
                    max={MAX_REPEAT_DELAY}
                    value={repeatDelay}
                    disabled={repeat <= 1}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      setRepeatDelay(Number.isFinite(n) ? clampDelay(n) : 0);
                    }}
                    className="w-14 h-6 px-1 text-center text-xs font-mono text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid tabular-nums disabled:opacity-40 disabled:cursor-not-allowed"
                  />
                  <span className={`w-6 h-6 inline-flex items-center justify-center text-[11px] transition-colors ${repeat > 1 ? 'text-text-tertiary' : 'text-text-tertiary opacity-60'}`}>ms</span>
                </div>
              </div>
            </div>
          )}

          {/* ── HOLD mode body ── */}
          {mode === 'hold' && (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3">
                <label className="text-[12px] font-medium text-text-secondary">Hold duration</label>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setHoldMs(v => clampHold(v - stepFor(v)))}
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
                      // Don't snap to MIN_HOLD_MS during typing — would rewrite the field
                      // mid-keystroke. Lower bound enforced on Save (handleConfirm) instead.
                      const raw = e.target.value;
                      if (raw === '') { setHoldMs(0); return; }
                      const n = parseInt(raw, 10);
                      if (Number.isFinite(n) && n >= 0) {
                        setHoldMs(Math.min(MAX_HOLD_MS, n));
                      }
                    }}
                    onBlur={() => setHoldMs(v => clampHold(v))}
                    className="w-20 h-6 px-1 text-center text-xs font-mono text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid tabular-nums"
                  />
                  <button
                    type="button"
                    onClick={() => setHoldMs(v => clampHold(v + stepFor(v)))}
                    disabled={holdMs >= MAX_HOLD_MS}
                    className="w-6 h-6 flex items-center justify-center rounded bg-bg-card hover:bg-bg-input border border-border-subtle text-text-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    aria-label="Increase hold duration"
                  >
                    <Plus size={11} />
                  </button>
                  <span className="text-[11px] text-text-tertiary ml-1">ms</span>
                </div>
              </div>

              {/* Preset chips. Click writes the value directly into both the state
                  and the ref (so an immediately-following Insert click reads the
                  fresh value). User can still fine-tune via the spinner / typed
                  entry afterwards — presets are shortcuts, not locks. */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] text-text-tertiary">Presets:</span>
                {HOLD_PRESETS.map(ms => (
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

              {/* Modifier-strip warning. Captured combo like "Ctrl+S" can't be held
                  by the backend (SimulateKey takes a single virtual-key code), so
                  Save will use only the last token. Surfaced as an explicit chip
                  rather than a silent strip so the user can choose to drop Hold
                  mode or recapture without modifiers. */}
              {hasModifiers && (
                <div className="flex items-start gap-2 px-2.5 py-2 rounded bg-[#FFC107]/10 border border-[#FFC107]/30">
                  <AlertCircle size={12} className="text-[#FFC107] mt-[1px] shrink-0" />
                  <div className="text-[10px] text-text-secondary leading-relaxed">
                    Hold mode supports single keys only. Saving will hold{' '}
                    <kbd className="px-1 py-px bg-bg-elevated border border-border-default rounded font-mono text-[10px] text-[#FFC107]">
                      {keystrokeDisplay(heldKey)}
                    </kbd>{' '}
                    and ignore the modifiers. To hold a combo, insert two rows: a
                    Hold for the modifier, plus the action under it.
                  </div>
                </div>
              )}
            </div>
          )}
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
