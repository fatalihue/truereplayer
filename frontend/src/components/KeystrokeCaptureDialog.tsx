import { useState, useRef, useEffect, useCallback } from 'react';
import { Keyboard, Minus, Plus } from 'lucide-react';

interface KeystrokeCaptureDialogProps {
  // `mode` controls the dialog flavour:
  //   "keystroke" — classic "Send Keystroke…" flow, Repeat defaults to 1 and is collapsed
  //                 under an "Advanced" toggle so the common case stays uncluttered.
  //   "press-n"   — "Press × N" insert flow, Repeat defaults to 5 and is rendered
  //                 prominently so the count is the first thing the user sees.
  // Both modes commit to the SAME `actions:insertKeystroke` message — they only differ
  // in defaults and UI emphasis.
  mode?: 'keystroke' | 'press-n';
  // Initial values used when re-opening the dialog to edit an existing Keystroke row
  // (recapture flow in ActionTable). All three are omitted on insert flows — defaults
  // apply. When `initialKeystroke` is set the dialog enters "edit mode": the captured
  // value is pre-filled (so Save is enabled without forcing a re-capture), the title
  // and confirm button switch labels, and Esc closes the dialog instead of re-arming
  // the capture pad. This is what lets a user click the × N badge and adjust JUST
  // the repeat count without having to press the key combo again.
  initialKeystroke?: string;
  initialRepeat?: number;
  initialRepeatDelayMs?: number;
  onConfirm: (keystroke: string, repeat: number, repeatDelayMs: number) => void;
  onClose: () => void;
}

const DEFAULT_REPEAT_DELAY_MS = 30; // mirrors ActionItem.DefaultRepeatDelayMs on the C# side
const MAX_REPEAT = 999;             // mirrors the clamp range in HandleActionsEdit/InsertKeystroke
const MAX_REPEAT_DELAY = 5000;

/**
 * Captures a keyboard combo (e.g. "Ctrl+Alt+T", "Alt+Tab", "Shift+F10") and reports it
 * back as a single "+"-joined string. The caller is expected to insert it as ONE
 * Keystroke action (the replay engine expands it to the proper modifier-down → key-down →
 * key-up → modifier-up sequence at run time).
 *
 * Different from KeyCaptureDialog:
 *   - KeyCaptureDialog captures one key and inserts a KeyDown+KeyUp PAIR. The user's
 *     intent is "tap this key once"; modifiers are ignored / treated as part of the
 *     "before-tap" state, not part of the captured value.
 *   - KeystrokeCaptureDialog captures the FULL COMBO as a single value. Modifiers are
 *     part of the keystroke, and the dialog waits for a non-modifier key to commit.
 *     This is intent-based ("I want to send Alt+Tab") not event-based ("I pressed Alt").
 *
 * Why not auto-detect combos in regular recording? See the discussion in the project
 * notes — recording captures literal events with precise timing; turning event sequences
 * into intent-level combos at record time would discard timing fidelity and produce false
 * positives (e.g. "hold Ctrl, click somewhere, release Ctrl" is NOT Ctrl+click as a combo,
 * it's an intentional modifier-held mouse gesture).
 */

/** Map a non-modifier keydown event to the canonical key name used in actions. Mirrors
 *  mapKeyEvent in KeyCaptureDialog but trimmed to the cases that matter here — modifier
 *  branches are handled by the caller (we extract them from e.ctrlKey etc.). */
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
  // Dead keys (´ ` ^ ~ on ABNT2/AZERTY) — recover from e.code, same as KeyCaptureDialog
  if (e.key === 'Dead') {
    const deadCodeMap: Record<string, string> = {
      Backquote: '`', Quote: "'", BracketLeft: '[', BracketRight: ']',
      Minus: '-', Equal: '=', Digit6: '^',
    };
    return deadCodeMap[e.code] ?? null;
  }
  // Digit and letter keys — use e.code (physical position, layout-independent and
  // shift-immune) instead of e.key (logical character, which becomes a SHIFTED symbol
  // when Shift is held: Shift+1 → e.key="!" but e.code="Digit1"). Saving the shifted
  // symbol broke replay because there's no VK code for "!" on its own — "!" requires
  // Shift+VK_1. Using e.code captures the base key; the modifier list captures Shift
  // separately, so the replay engine reconstructs the combo correctly.
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (e.key.length === 1) {
    // Fallback for symbols / punctuation not covered by Digit*/Key* codes
    // (`, [, ], -, =, ;, ', ,, ., /, ç on ABNT2, etc.). e.key here is already the
    // base character because no modifier is producing a shift mapping for these.
    return e.key;
  }
  return null;
}

/** Builds the "+"-joined combo string with a stable modifier order: Ctrl+Shift+Alt+KEY.
 *  Backend's keystroke replay handler parses on "+" — same separator. */
function buildKeystroke(modifiers: { ctrl: boolean; shift: boolean; alt: boolean }, key: string): string {
  const parts: string[] = [];
  if (modifiers.ctrl) parts.push('Ctrl');
  if (modifiers.shift) parts.push('Shift');
  if (modifiers.alt) parts.push('Alt');
  parts.push(key);
  return parts.join('+');
}

/** Human-readable label for the chip. Replaces VK_93 with "Menu" so the badge reads
 *  cleanly even when the user captured the context-menu key. */
function keystrokeDisplay(keystroke: string): string {
  return keystroke.replace(/\bVK_93\b/, 'Menu');
}

export function KeystrokeCaptureDialog({
  mode = 'keystroke',
  initialKeystroke,
  initialRepeat,
  initialRepeatDelayMs,
  onConfirm,
  onClose,
}: KeystrokeCaptureDialogProps) {
  const isPressN = mode === 'press-n';
  // initialKeystroke presence is the edit-mode flag. We avoid a separate `mode = 'edit'`
  // value because mode controls the *defaults* (press-n vs keystroke counts), while
  // editing is orthogonal — a user could be editing either a press-n row or a regular
  // keystroke row, and the defaults are irrelevant in both cases (we seed from props).
  const isEditing = initialKeystroke != null;
  // Seed `captured` with the existing combo so Save is enabled the moment the dialog
  // opens. Without this seed the Insert/Save button stayed disabled until the user
  // re-captured a key — making it impossible to edit only the Repeat / Delay fields.
  const [captured, setCaptured] = useState<string | null>(initialKeystroke ?? null);
  // Initial value priority: explicit `initialRepeat` (edit flow) > mode default
  // (press-n = 5 to make the feature obvious, classic keystroke = 1).
  const [repeat, setRepeat] = useState<number>(initialRepeat ?? (isPressN ? 5 : 1));
  // Delay between cycles. Starts at the action's stored value (edit) or the C#
  // default (insert). Always rendered — the input is disabled when repeat == 1
  // since there's nothing to space against, but staying visible keeps the dialog
  // a fixed size.
  const [repeatDelay, setRepeatDelay] = useState<number>(initialRepeatDelayMs ?? DEFAULT_REPEAT_DELAY_MS);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Clamp helper used by both the spinner buttons and the direct numeric inputs so
  // pasting / typing a wild value (-99, 50000, NaN) lands in the legal range.
  const clampRepeat = (v: number) => Math.max(1, Math.min(MAX_REPEAT, Math.floor(v)));
  const clampDelay = (v: number) => Math.max(0, Math.min(MAX_REPEAT_DELAY, Math.floor(v)));

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // If focus is on a numeric input, let it process keystrokes normally — we shouldn't
    // hijack digit presses to "capture" them as a key combo. Stops the case where typing
    // "5" in the Repeat field would re-commit the captured combo with key "5".
    const target = e.target as HTMLElement;
    if (target?.tagName === 'INPUT') return;
    // Escape closes the dialog when:
    //   • no combo captured yet (insert flow waiting for first capture), OR
    //   • we're editing an existing row (Esc = abandon edit, matches user expectation
    //     that Esc cancels a dialog they opened to tweak settings).
    // Otherwise (insert flow with a combo already captured), pressing Escape re-captures
    // — same as KeyCaptureDialog — letting the user retry without leaving the dialog.
    if (e.key === 'Escape' && (captured === null || isEditing)) {
      e.preventDefault();
      onClose();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // Skip pure modifier presses (Ctrl/Shift/Alt/Meta on its own). We're waiting for the
    // "real" key while the user holds modifiers. Without this skip, pressing Ctrl on the
    // way to Ctrl+A would commit "Ctrl" alone before the A keydown arrived.
    if (['Control', 'Shift', 'Alt', 'AltGraph', 'Meta'].includes(e.key)) return;
    const keyPart = mapKeyPart(e.nativeEvent);
    if (!keyPart) return;
    const modifiers = {
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      // AltGraph (right Alt on ABNT2) reports as e.altKey=true too on Windows since
      // the OS sends Ctrl+Alt for it; we accept that as "Alt" semantically.
      alt: e.altKey,
    };
    setCaptured(buildKeystroke(modifiers, keyPart));
  }, [captured, onClose]);

  const handleConfirm = () => {
    if (captured) onConfirm(captured, clampRepeat(repeat), clampDelay(repeatDelay));
  };

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
        {/* Header — title reflects the flow:
              • Edit mode → "Edit Keystroke" (user is tweaking an existing row)
              • press-n  → "Press Key × N times" (insert with repeat focus)
              • default  → "Capture Keystroke" (classic single-press insert) */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <Keyboard size={14} className="text-accent-light" />
          <h3 className="text-sm font-semibold text-text-primary">
            {isEditing ? 'Edit Keystroke' : isPressN ? 'Press Key × N times' : 'Capture Keystroke'}
          </h3>
        </div>

        {/* Body — fixed layout. Capture pad has a stable 156 px min-height so it doesn't
            jump between placeholder / captured states; the Repeat and Delay rows below
            are always rendered (no collapse toggle) so the dialog never resizes. */}
        <div className="px-5 py-5 flex flex-col gap-4">
          {/* Capture pad */}
          <div className="bg-bg-input border border-dashed border-[#FFC107]/40 rounded-md py-5 px-4 text-center min-h-[156px] flex flex-col justify-center">
            {captured === null ? (
              <>
                <div className="text-[12px] text-text-tertiary mb-1">Press any key combination</div>
                <div className="text-[10px] text-text-disabled">
                  E.g. Alt+Tab · Ctrl+Shift+T · Alt+F4
                </div>
                <div className="text-[10px] text-text-disabled mt-1">
                  Esc to cancel
                </div>
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
                  {isEditing
                    ? (repeat > 1
                        ? <>Updates row to <span className="text-text-secondary font-semibold">{repeat} press cycles</span></>
                        : <>Updates row to <span className="text-text-secondary font-semibold">single press</span></>)
                    : (repeat > 1
                        ? <>Inserts <span className="text-text-secondary font-semibold">1 row · {repeat} press cycles</span></>
                        : <>Inserts <span className="text-text-secondary font-semibold">1 Keystroke row</span></>)}
                </div>
                <div className="mt-1 text-[10px] text-text-disabled">
                  Press another combo to replace
                </div>
              </>
            )}
          </div>

          {/* Settings — always visible. Both rows share the same right-aligned column
              for inputs so the eye tracks a clean vertical line. */}
          <div className="flex flex-col gap-2.5">
            {/* Repeat */}
            <div className="flex items-center justify-between gap-3">
              <label className="text-[12px] font-medium text-text-secondary">Repeat</label>
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

            {/* Delay between presses — always rendered, disabled when repeat == 1.
                The dimmed state signals "would matter if you bumped repeat up" without
                hiding the field, which would cause the dialog to jump in height.

                The right column mirrors the Repeat row's geometry: a phantom 24×24 cell
                stands in for the [-] button, the input occupies the centre slot at the
                same x as Repeat's input, and the "ms" label is sized like the [+]
                button so the right edge of both rows lands on the same vertical line.
                Net effect: the two inputs stack perfectly across rows. */}
            <div className="flex items-center justify-between gap-3">
              <label className={`text-[12px] font-medium transition-colors ${repeat > 1 ? 'text-text-secondary' : 'text-text-disabled'}`}>
                Delay between presses
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
                <span className={`w-6 h-6 inline-flex items-center justify-center text-[11px] transition-colors ${repeat > 1 ? 'text-text-tertiary' : 'text-text-disabled'}`}>ms</span>
              </div>
            </div>
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
