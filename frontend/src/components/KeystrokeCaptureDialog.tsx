import { useState, useRef, useEffect, useCallback } from 'react';
import { Keyboard } from 'lucide-react';
import { NumberInput } from './common/NumberInput';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';
import { SegmentedControl } from './common/SegmentedControl';
import { KeyCaps } from './common/KeyCaps';
import { DurationChips } from './common/DurationChips';
import { useBridge } from '../bridge/BridgeContext';
import { useLanguage, useTt } from '../state/LanguageContext';

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

// Gap jitter — OFF by default (the field stays 0/absent so existing macros replay
// byte-identically). When the user turns it on, this is the ±% seeded into the input.
const DEFAULT_JITTER_PCT = 20;
const MAX_JITTER_PCT = 100;

const DEFAULT_HOLD_MS = 1000;
const MIN_HOLD_MS = 10;
const MAX_HOLD_MS = 60000;

// Common hold durations, surfaced as one-click chips. Mirrors the Insert Pause timeout
// chips (100 ms → 30 s) for a consistent duration-picker feel; there's no ∞ here because a
// key can't be held indefinitely (the backend caps a hold at MAX_HOLD_MS and an unbounded
// hold would freeze the replay with the key stuck down).
const HOLD_PRESETS = [100, 500, 1000, 5000, 30000];

/** Spinner step: 1 s once we're past 1 s, 100 ms below — match HoldKeyDialog's feel. */
const stepFor = (v: number) => v >= 1000 ? 1000 : 100;

// ── Component ──

type Mode = 'press' | 'hold';

export type SendKeystrokeResult =
  | { actionType: 'Keystroke'; key: string; repeat: number; repeatDelayMs: number; repeatDelayJitterPct: number }
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
  initialRepeatDelayJitterPct?: number;
  initialHoldDurationMs?: number;
  onConfirm: (result: SendKeystrokeResult) => void;
  onClose: () => void;
}

export function KeystrokeCaptureDialog({
  initialActionType,
  initialKey,
  initialRepeat,
  initialRepeatDelayMs,
  initialRepeatDelayJitterPct,
  initialHoldDurationMs,
  onConfirm,
  onClose,
}: KeystrokeCaptureDialogProps) {
  const { language } = useLanguage();
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

  // Manual text entry — the escape hatch for values the low-level hook can never
  // produce: {var:name}/{clipboard} tokens (resolved by the replay engine, possibly
  // into a whole combo) and hand-typed combos. Auto-enters manual mode when editing
  // a row whose key already contains a token, so the value is immediately editable.
  const [manualEntry, setManualEntry] = useState(() => (initialKey ?? '').includes('{'));
  // Ref mirror for the capture subscription below — while typing manually, a stray
  // key press must not overwrite the typed value via 'hotkey:captured'.
  const manualEntryRef = useRef(manualEntry);
  useEffect(() => { manualEntryRef.current = manualEntry; });
  const manualInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (manualEntry) manualInputRef.current?.focus();
  }, [manualEntry]);

  // Press-mode state.
  const [repeat, setRepeat] = useState<number>(initialRepeat ?? 1);
  const [repeatDelay, setRepeatDelay] = useState<number>(initialRepeatDelayMs ?? DEFAULT_REPEAT_DELAY_MS);
  // Gap jitter is stored as a single number (0 = off), but the dialog keeps the on/off and the
  // ±% value on separate tracks — mirroring the app's EnableChip — so toggling off and back on
  // restores the last value instead of snapping to 0. Off by default.
  const [jitterOn, setJitterOn] = useState<boolean>((initialRepeatDelayJitterPct ?? 0) > 0);
  const [jitterPct, setJitterPct] = useState<number>(
    initialRepeatDelayJitterPct && initialRepeatDelayJitterPct > 0 ? initialRepeatDelayJitterPct : DEFAULT_JITTER_PCT,
  );

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
    setManualEntry((initialKey ?? '').includes('{'));
    setRepeat(initialRepeat ?? 1);
    setRepeatDelay(initialRepeatDelayMs ?? DEFAULT_REPEAT_DELAY_MS);
    setJitterOn((initialRepeatDelayJitterPct ?? 0) > 0);
    setJitterPct(initialRepeatDelayJitterPct && initialRepeatDelayJitterPct > 0 ? initialRepeatDelayJitterPct : DEFAULT_JITTER_PCT);
    const ms = initialHoldDurationMs ?? DEFAULT_HOLD_MS;
    setHoldMsState(ms);
    holdMsRef.current = ms;
  }, [initialActionType, initialKey, initialRepeat, initialRepeatDelayMs, initialRepeatDelayJitterPct, initialHoldDurationMs]);

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
    // Manual mode OWNS the keyboard — never arm the low-level hook while it is on.
    // An armed hook swallows EVERY keystroke system-wide (InputHookManager returns 1
    // for all keys in capture mode), which on the auto-manual edit flow left the
    // autofocused input dead and Esc unable to close the dialog: the input's focusin
    // fired BEFORE this effect attached its listener, so nothing ever disabled the
    // hook. Keying the effect on manualEntry makes the toggle authoritative.
    send({ type: 'hotkey:capture', payload: { enabled: !manualEntry, ownerId: ownerIdRef.current } });
    const isPureModifier = (combo: string) =>
      /^(Win|Ctrl|Alt|Shift)(\+(Win|Ctrl|Alt|Shift))*$/.test(combo);

    const unsub = subscribe((msg) => {
      if (msg.type !== 'hotkey:captured') return;
      // Manual mode owns the value — a key pressed while the manual input is NOT
      // focused (capture re-armed by focusout) must not clobber the typed text.
      if (manualEntryRef.current) return;
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
      // Never re-arm on blur while manual mode is on — the hook must stay off for
      // the whole manual session, not just while the text input has focus.
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && !manualEntryRef.current) {
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
  }, [send, subscribe, manualEntry]);

  // Clamp helpers — applied on commit (handleConfirm) and on +/− spinner clicks.
  // Free-form typing is allowed to fall below the lower bound in transient states
  // so the input doesn't snap while the user is still typing.
  const clampRepeat = (v: number) => Math.max(1, Math.min(MAX_REPEAT, Math.floor(v)));
  const clampDelay = (v: number) => Math.max(0, Math.min(MAX_REPEAT_DELAY, Math.floor(v)));
  const clampJitter = (v: number) => Math.max(1, Math.min(MAX_JITTER_PCT, Math.floor(v)));
  const clampHold = (v: number) => Math.max(MIN_HOLD_MS, Math.min(MAX_HOLD_MS, Math.floor(v)));

  // Derived values used by the renderer + commit.
  const hasModifiers = captured?.includes('+') ?? false;
  // For Hold mode, only the last part of the combo gets used on commit — that's
  // the actual key the OS will keep pressed. Modifiers in the captured string
  // would confuse SimulateKey (no virtual-key code for "Ctrl+S"), so we strip
  // them at save time and warn in the UI.
  const heldKey = captured ? captured.split('+').pop() ?? captured : '';

  const handleConfirm = () => {
    // Trim on commit: manual entry can produce whitespace-only or trailing-space
    // values the capture hook never could — a whitespace key would silently no-op
    // at replay with zero diagnostics.
    if (!captured?.trim()) return;
    if (mode === 'hold') {
      onConfirm({
        actionType: 'HoldKey',
        key: heldKey.trim(),
        holdDurationMs: clampHold(holdMsRef.current),
      });
    } else {
      onConfirm({
        actionType: 'Keystroke',
        key: captured.trim(),
        repeat: clampRepeat(repeat),
        repeatDelayMs: clampDelay(repeatDelay),
        // 0 = off. Jitter only applies across repeats, so a single press (or jitter
        // toggled off) always commits 0 — the backend then stores null (schema-clean).
        repeatDelayJitterPct: jitterOn && repeat > 1 ? clampJitter(jitterPct) : 0,
      });
    }
  };

  // Title flips by intent: edit vs insert, then by mode.
  const title = isEditing
    ? (mode === 'hold' ? 'Edit Hold Key' : 'Edit Keystroke')
    : 'Send Keystroke';

  return (
    <DialogShell
      icon={<Keyboard size={14} style={{ color: 'var(--color-action-key-fg)' }} />}
      title={title}
      onClose={onClose}
      // Capture dialog: a stray click outside must not discard a captured combo
      // (or the Times/Gap/Hold tuning) — dismissal is Esc or Cancel only.
      closeOnBackdrop={false}
      // Truthful per state — NEVER advertises Enter while the hook is armed
      // (outside input focus, Enter would be CAPTURED as the combo, not confirm).
      // Manual mode owns the keyboard, so there Enter/Esc read as usual.
      footerHint={manualEntry
        ? tt('Enter confirms · Esc cancels', 'Enter confirma · Esc cancela')
        : captured
          ? tt('Press another combo to replace', 'Pressione outra combinação para substituir')
          : ''}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={!captured?.trim()}>
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
              key, with a warning chip when modifiers got dropped. The border style
              reports the hook state truthfully: dashed = low-level capture armed,
              solid = manual mode (hook off, the keyboard is yours). */}
          <div
            className={`bg-bg-input border rounded-md py-5 px-4 text-center min-h-[140px] flex flex-col justify-center transition-colors ${
              manualEntry ? 'border-border-default' : 'border-dashed'
            }`}
            style={manualEntry ? undefined : {
              borderColor: 'color-mix(in srgb, var(--color-action-key-fg) 40%, transparent)',
              ...(captured ? { background: 'color-mix(in srgb, var(--color-action-key-fg) 4%, var(--color-bg-input))' } : null),
            }}
          >
            {manualEntry ? (
              <>
                <input
                  ref={manualInputRef}
                  type="text"
                  value={captured ?? ''}
                  onChange={(e) => setCaptured(e.target.value || null)}
                  placeholder="F5 · Ctrl+S · {var:name}"
                  spellCheck={false}
                  className="w-full h-9 px-2 text-[13px] font-mono bg-bg-elevated border border-border-default rounded text-[color:var(--color-action-key-fg)] text-center outline-none focus:border-accent-solid"
                />
                <div className="mt-2.5 text-[10px] text-text-tertiary leading-relaxed">
                  {mode === 'hold' ? (
                    // Hold goes through SimulateKey (single virtual-key) — a token
                    // resolving to a combo would silently no-op, so don't teach it here.
                    language === 'pt-BR'
                      ? <>Para Hold, um token <code className="text-accent-light">{'{var:name}'}</code> precisa
                        resolver para uma <span className="text-text-secondary">única tecla</span> (F5, W, Space…).</>
                      : <>For Hold, a <code className="text-accent-light">{'{var:name}'}</code> token must
                        resolve to a <span className="text-text-secondary">single key</span> (F5, W, Space…).</>
                  ) : (
                    language === 'pt-BR'
                      ? <>Tokens como <code className="text-accent-light">{'{var:name}'}</code> ou{' '}
                        <code className="text-accent-light">{'{clipboard}'}</code> são resolvidos no replay —
                        até em uma combinação completa como Ctrl+V.</>
                      : <>Tokens like <code className="text-accent-light">{'{var:name}'}</code> or{' '}
                        <code className="text-accent-light">{'{clipboard}'}</code> resolve at replay —
                        even into a full combo like Ctrl+V.</>
                  )}
                </div>
              </>
            ) : captured === null ? (
              <>
                <div className="text-[12px] text-text-secondary mb-1">
                  {tt('Press any key or combo', 'Pressione qualquer tecla ou combinação')}
                </div>
                <div className="text-[10px] font-mono text-text-tertiary">A · F5 · Ctrl+S · Win+A</div>
              </>
            ) : (
              <KeyCaps combo={captured} fg="var(--color-action-key-fg)" />
            )}
          </div>

          {/* Capture ↔ manual toggle. Manual is the only way to put a {var}/{clipboard}
              token (or a combo the OS shell would swallow) into the Key field — the
              low-level hook can never capture those. */}
          <button
            type="button"
            onClick={() => setManualEntry(v => !v)}
            className="self-center -mt-2 text-[10px] text-text-tertiary hover:text-text-secondary underline decoration-dotted transition-colors"
          >
            {manualEntry ? 'Back to key capture' : 'Type manually · {var} tokens'}
          </button>

          {/* Mode toggle — switches the body below between Press and Hold settings. */}
          <div className="flex flex-col gap-1.5">
            <span className="label-micro text-text-tertiary">Mode</span>
            <SegmentedControl<Mode>
              ariaLabel="Keystroke mode"
              grow
              value={mode}
              onChange={setMode}
              options={[
                { value: 'press', label: 'Press' },
                { value: 'hold', label: 'Hold' },
              ]}
            />
          </div>

          {/* ── PRESS mode body ── */}
          {mode === 'press' && (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3">
                <label
                  className="text-[12px] font-medium text-text-secondary"
                >Times to repeat</label>
                <NumberInput
                  value={repeat}
                  onChange={(n) => setRepeat(clampRepeat(n))}
                  min={1}
                  max={MAX_REPEAT}
                  inputWidth="w-24"
                  ghostSuffix="ms"
                  ariaLabel="Repeat count"
                />
              </div>

              {/* Gap stays visible but dims when Times = 1 — communicates the field
                  exists for repeat-flavoured presses without making the dialog
                  jump in height when the user increments Times. */}
              <div className="flex items-center justify-between gap-3">
                <label
                  className={`text-[12px] font-medium transition-colors ${repeat > 1 ? 'text-text-secondary' : 'text-text-tertiary'}`}
                >
                  Gap between presses
                </label>
                <NumberInput
                  value={repeatDelay}
                  onChange={(n) => setRepeatDelay(clampDelay(n))}
                  min={0}
                  max={MAX_REPEAT_DELAY}
                  disabled={repeat <= 1}
                  thousands
                  suffix="ms" suffixInside
                  inputWidth="w-24"
                  ariaLabel="Gap between presses (ms)"
                />
              </div>

              {/* Gap jitter — OFF by default (hollow dot). Adds a random ±% to each gap so a
                  repeat burst doesn't fire on a perfectly fixed interval — a constant gap is the
                  clearest "it's a bot" tell. Like Gap, the whole row is inert until Times > 1.
                  The enable dot (the app's own affordance, see SettingsPanel's EnableChip) sits to
                  the RIGHT of the label, so the label text starts at the row's left edge and lines
                  up with the two rows above with no margin trickery. */}
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setJitterOn(v => !v)}
                  disabled={repeat <= 1}
                  aria-pressed={jitterOn}
                  className="flex items-center gap-1.5 disabled:cursor-not-allowed"
                  data-tip={tt('Random ±% on each gap — less robotic.', 'Variação ±% aleatória em cada intervalo — menos robótico.')}
                >
                  <span className={`text-[12px] font-medium transition-colors ${jitterOn && repeat > 1 ? 'text-text-secondary' : 'text-text-tertiary'}`}>
                    Gap jitter
                  </span>
                  <span
                    className="w-2 h-2 rounded-full block shrink-0 transition-colors"
                    style={jitterOn && repeat > 1
                      ? { background: 'var(--color-accent-solid)' }
                      : { background: 'transparent', border: '1.5px solid var(--color-text-tertiary)' }}
                  />
                </button>
                <NumberInput
                  value={jitterPct}
                  onChange={(n) => setJitterPct(clampJitter(n))}
                  min={1}
                  max={MAX_JITTER_PCT}
                  disabled={!jitterOn || repeat <= 1}
                  suffix="%" suffixInside
                  inputWidth="w-24"
                  ariaLabel="Gap jitter (%)"
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
                >Hold duration</label>
                {/* Step is dynamic (stepFor returns 1000 once we're at/above 1s, 100
                    below it). NumberInput's step is constant per render, so we recompute
                    via the parent's clamp on each change. */}
                <NumberInput
                  value={holdMs}
                  onChange={(n) => setHoldMs(clampHold(n))}
                  min={MIN_HOLD_MS}
                  max={MAX_HOLD_MS}
                  step={stepFor(holdMs)}
                  inputWidth="w-24"
                  thousands
                  suffix="ms" suffixInside
                  ariaLabel="Hold duration (ms)"
                />
              </div>

              {/* Preset chips. onSelect goes through setHoldMs (the two-track
                  state+ref setter) so a preset click followed by an immediate Add
                  still commits the fresh value — presets are shortcuts, not locks. */}
              <DurationChips presets={HOLD_PRESETS} value={holdMs} onSelect={setHoldMs} />

              {/* Modifier-strip warning. Captured combo like "Ctrl+S" can't be held
                  by the backend (SimulateKey takes a single virtual-key code), so
                  Save will use only the last token. Surfaced explicitly rather than
                  silently stripped — left-rail card, warning tone. */}
              {hasModifiers && (
                <div
                  className="border-l-2 rounded px-2.5 py-2 text-[10px] leading-relaxed text-text-secondary"
                  style={{
                    background: 'color-mix(in srgb, var(--color-warning) 8%, transparent)',
                    borderColor: 'var(--color-warning)',
                  }}
                >
                  {tt('Hold mode supports single keys only. Saving will hold', 'O modo Hold aceita apenas teclas únicas. Salvar vai segurar')}{' '}
                  <kbd className="px-1 py-px bg-bg-elevated border border-border-default rounded font-mono text-[10px] text-warning">
                    {keystrokeDisplay(heldKey)}
                  </kbd>{' '}
                  {tt(
                    'and ignore the modifiers. To hold a combo, insert two rows: a Hold for the modifier, plus the action under it.',
                    'e ignorar os modificadores. Para segurar uma combinação, insira duas linhas: um Hold para o modificador e a ação abaixo.',
                  )}
                </div>
              )}
            </div>
          )}
        </div>
    </DialogShell>
  );
}
