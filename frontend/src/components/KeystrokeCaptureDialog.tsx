import { useState, useRef, useEffect, useCallback } from 'react';
import { Keyboard, AlertCircle } from 'lucide-react';
import { NumberInput } from './common/NumberInput';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';
import { useBridge } from '../bridge/BridgeContext';
import { useTt } from '../state/LanguageContext';

/**
 * Unified "Send Keystroke" dialog. One capture pad + a Press/Hold mode toggle covers
 * everything keyboard-related the user could want to insert manually:
 *
 *   Press mode (default):
 *     • Times = 1 → single press of a key or combo  (Ctrl+S, F5, A, Alt+Tab, Win+A)
 *     • Times > 1 → press N times with configurable gap (Tab × 5, F5 × 10)
 *
 *   Hold mode:
 *     • Press a single key, keep it down for the configured duration
 *     • Preset chips for common holds (100 ms tap → 5 s long press)
 *     • Modifier keys are stripped on save — backend SimulateKey only handles
 *       single keys; the warning chip surfaces this whenever the captured value
 *       contains a "+", so the user is never surprised.
 *
 * Capture goes through the backend low-level keyboard hook (hotkey:capture /
 * hotkey:captured) because the WebView2 JS layer never sees Win+letter combos —
 * the Windows Shell intercepts them at OS level. The hook composes the combo and
 * forwards it here. Capture is automatically suspended while a numeric input is
 * focused so the user can type "5" into Times without re-capturing "5" as a combo.
 *
 * Replaces the three legacy dialogs / menu entries (Send Key, Send Keystroke,
 * Press Key × N, Hold Key) — keeps the underlying ActionType split intact
 * (Keystroke for press flows, HoldKey for hold flows) so no profile migration
 * is required.
 */

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
  const tt = useTt();

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
  // Re-seed every state field, not just the hold duration — otherwise mode /
  // captured / repeat / gap keep the previous row's values when the instance is
  // reused.
  useEffect(() => {
    setMode(initialActionType === 'HoldKey' ? 'hold' : 'press');
    setCaptured(initialKey ?? null);
    setRepeat(initialRepeat ?? 1);
    setRepeatDelay(initialRepeatDelayMs ?? DEFAULT_REPEAT_DELAY_MS);
    const ms = initialHoldDurationMs ?? DEFAULT_HOLD_MS;
    setHoldMsState(ms);
    holdMsRef.current = ms;
  }, [initialActionType, initialKey, initialRepeat, initialRepeatDelayMs, initialHoldDurationMs]);

  // Stable refcount slot — see InputHookManager.RegisterCapture. Per-mount ID so
  // enable/disable target the same slot, and a sibling consumer (Settings hotkey
  // field, Pause dialog) can't accidentally turn the hook off via shared state.
  const ownerIdRef = useRef(`keystroke-capture-${crypto.randomUUID()}`);
  const { send, subscribe } = useBridge();

  // (Esc focus handling moved into DialogShell — it focuses the card on mount.)

  // Capture mode wiring. Mount → enable backend low-level capture; subscribe to
  // composed combos. Numeric inputs (Times / Gap / Hold duration) suspend capture
  // on focus so typing "5" lands as text instead of re-capturing "5" as a combo,
  // and resume it on blur. Pure-modifier captures ("Win", "Ctrl+Alt") are kept
  // visible in the chip but don't replace an already-captured real combo — that
  // matches the old "wait for the real key" filter while still letting the user
  // see what modifiers are held mid-press.
  useEffect(() => {
    send({ type: 'hotkey:capture', payload: { enabled: true, ownerId: ownerIdRef.current } });
    const isPureModifier = (combo: string) =>
      /^(Win|Ctrl|Alt|Shift)(\+(Win|Ctrl|Alt|Shift))*$/.test(combo);

    const unsub = subscribe((msg) => {
      if (msg.type !== 'hotkey:captured') return;
      const combo = msg.payload.combo;
      setCaptured((prev) => {
        // Don't overwrite an already-captured combo with a bare modifier press —
        // user is probably holding modifiers for the next combo.
        if (prev !== null && isPureModifier(combo)) return prev;
        return combo;
      });
    });

    const handleFocusIn = (e: FocusEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') {
        send({ type: 'hotkey:capture', payload: { enabled: false, ownerId: ownerIdRef.current } });
      }
    };
    const handleFocusOut = (e: FocusEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') {
        send({ type: 'hotkey:capture', payload: { enabled: true, ownerId: ownerIdRef.current } });
      }
    };
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);

    return () => {
      send({ type: 'hotkey:capture', payload: { enabled: false, ownerId: ownerIdRef.current } });
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      unsub();
    };
  }, [send, subscribe]);

  // Clamp helpers — applied on commit (handleConfirm) and on +/− spinner clicks.
  // Free-form typing is allowed to fall below the lower bound in transient states
  // so the input doesn't snap while the user is still typing.
  const clampRepeat = (v: number) => Math.max(1, Math.min(MAX_REPEAT, Math.floor(v)));
  const clampDelay = (v: number) => Math.max(0, Math.min(MAX_REPEAT_DELAY, Math.floor(v)));
  const clampHold = (v: number) => Math.max(MIN_HOLD_MS, Math.min(MAX_HOLD_MS, Math.floor(v)));

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

  // Duration readout — always milliseconds, matching the grid badge and every other
  // action duration (was seconds for clean multiples of 1000).
  const durationLabel = `${holdMs} ms`;

  // Title flips by intent: edit vs insert, then by mode.
  const title = isEditing
    ? (mode === 'hold' ? 'Edit Hold Key' : 'Edit Keystroke')
    : 'Send Keystroke';

  return (
    <DialogShell
      icon={<Keyboard size={14} className="text-accent-light" />}
      title={title}
      onClose={onClose}
      // Capture dialog: a stray click outside must not discard a captured combo
      // (or the Times/Gap/Hold tuning) — dismissal is Esc or Cancel only.
      closeOnBackdrop={false}
      // Hint qualifies Enter — outside of input focus the backend hook captures
      // Enter as the bound key, so the user gets no confirm-via-Enter from the
      // capture pad. The numeric fields (Times / Gap / Hold duration) pause
      // capture on focus, which is when Enter actually confirms.
      footerHint="Enter (in number fields) to confirm · Esc to cancel"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={captured === null}>
            {isEditing ? 'Save' : 'Add'}
          </Button>
        </>
      }
      onCardKeyDown={(e) => {
        // Enter confirms ONLY when a numeric input is focused — in that state the
        // backend capture is paused (handleFocusIn in the capture effect) so the
        // Enter press doesn't double as a captured combo. Outside of input focus,
        // Enter is captured as the "Enter" hotkey by the backend hook and arrives
        // via 'hotkey:captured', so we deliberately do NOT confirm on it here.
        // Esc is owned by DialogShell.
        if (e.key === 'Enter') {
          const focusedTag = (document.activeElement as HTMLElement | null)?.tagName;
          if (focusedTag === 'INPUT' && captured !== null) {
            e.preventDefault();
            e.stopPropagation();
            handleConfirm();
          }
        }
      }}
    >
        <div className="px-5 py-5 flex flex-col gap-4">
          {/* Capture pad — universal for both modes. Single press detects whatever
              modifiers the user is holding; Hold mode silently uses only the last
              key, with a warning chip when modifiers got dropped. */}
          <div
            className="bg-bg-input border border-dashed border-[#FFC107]/40 rounded-md py-5 px-4 text-center min-h-[156px] flex flex-col justify-center"
            data-tip={tt('Press a key or combo to capture it (incl. Win+ combos the browser cannot see). Press again to replace.', 'Pressione uma tecla ou combo para capturar (incl. combos Win+ que o browser nao ve). Pressione de novo para substituir.')}
          >
            {captured === null ? (
              <>
                <div className="text-[12px] text-text-tertiary mb-1">Press any key or combo</div>
                <div className="text-[10px] text-text-tertiary">
                  Single keys, or Win/Ctrl/Shift/Alt + key. E.g. A · F5 · Ctrl+S · Win+A
                </div>
                <div className="text-[10px] text-text-tertiary mt-1">Click Cancel to abort</div>
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
                  data-tip={m === 'press'
                    ? tt('Tap the key once, or N times with a gap between presses.', 'Pressiona a tecla uma vez, ou N vezes com intervalo entre os toques.')
                    : tt('Keep a single key held down for the set duration (modifiers are dropped).', 'Mantem uma unica tecla pressionada pela duracao definida (modificadores sao descartados).')}
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
                <label
                  className="text-[12px] font-medium text-text-secondary"
                  data-tip={tt('How many times to press the key. 1 = single press; up to 999.', 'Quantas vezes pressionar a tecla. 1 = um toque; ate 999.')}
                >Times to repeat</label>
                <NumberInput
                  value={repeat}
                  onChange={(n) => setRepeat(clampRepeat(n))}
                  min={1}
                  max={MAX_REPEAT}
                  ariaLabel="Repeat count"
                />
              </div>

              {/* Gap stays visible but dims when Times = 1 — communicates the field
                  exists for repeat-flavoured presses without making the dialog
                  jump in height when the user increments Times. */}
              <div className="flex items-center justify-between gap-3">
                <label
                  className={`text-[12px] font-medium transition-colors ${repeat > 1 ? 'text-text-secondary' : 'text-text-tertiary'}`}
                  data-tip={tt('Pause between each press, in ms (0–5000). Only used when Times > 1.', 'Pausa entre cada toque, em ms (0–5000). So vale quando Times > 1.')}
                >
                  Gap between presses (ms)
                </label>
                <NumberInput
                  value={repeatDelay}
                  onChange={(n) => setRepeatDelay(clampDelay(n))}
                  min={0}
                  max={MAX_REPEAT_DELAY}
                  disabled={repeat <= 1}
                  ariaLabel="Gap between presses (ms)"
                />
              </div>
            </div>
          )}

          {/* ── HOLD mode body ── */}
          {mode === 'hold' && (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3">
                <label
                  className="text-[12px] font-medium text-text-secondary"
                  data-tip={tt('How long the key stays pressed, in ms (10–60000). Use the presets for common values.', 'Por quanto tempo a tecla fica pressionada, em ms (10–60000). Use os presets para valores comuns.')}
                >Hold duration (ms)</label>
                {/* Step is dynamic (stepFor returns 1000 once we're at/above 1s, 100
                    below it). NumberInput's step is constant per render, so we recompute
                    via the parent's clamp on each change. */}
                <NumberInput
                  value={holdMs}
                  onChange={(n) => setHoldMs(clampHold(n))}
                  min={MIN_HOLD_MS}
                  max={MAX_HOLD_MS}
                  step={stepFor(holdMs)}
                  inputWidth="w-20"
                  ariaLabel="Hold duration (ms)"
                />
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
    </DialogShell>
  );
}
