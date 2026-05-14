import { useState, useRef, useEffect, useCallback } from 'react';
import { Keyboard } from 'lucide-react';

interface KeystrokeCaptureDialogProps {
  onConfirm: (keystroke: string) => void;
  onClose: () => void;
}

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
  if (e.key.length === 1) {
    const c = e.key.toUpperCase();
    if (/\d/.test(c)) return c;
    if (/[A-Z]/.test(c)) return c;
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

export function KeystrokeCaptureDialog({ onConfirm, onClose }: KeystrokeCaptureDialogProps) {
  const [captured, setCaptured] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Escape closes the dialog if no combo is captured yet. Once a combo is captured,
    // pressing Escape RE-captures (replaces with a new combo) — same as KeyCaptureDialog.
    if (e.key === 'Escape' && captured === null) {
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
    if (captured) onConfirm(captured);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-xl w-[400px] max-w-[90vw] flex flex-col outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <Keyboard size={14} className="text-accent-light" />
          <h3 className="text-sm font-semibold text-text-primary">Capture Keystroke</h3>
        </div>

        {/* Body — fixed-height so the dialog doesn't grow between placeholder / captured
            states (same trick as KeyCaptureDialog). 156 px sized for the captured state
            which is taller (chips + 2 hint lines). */}
        <div className="px-5 py-5">
          <div className="bg-bg-input border border-dashed border-[#FFC107]/40 rounded-md py-5 px-4 text-center min-h-[156px] flex flex-col justify-center">
            {captured === null ? (
              <>
                <div className="text-[12px] text-text-tertiary mb-1">Press a key combo…</div>
                <div className="text-[10px] text-text-disabled">
                  E.g. Alt+Tab, Ctrl+Shift+T, Alt+F4
                </div>
                <div className="text-[10px] text-text-disabled mt-1">
                  Esc cancels
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
                  Will insert as a single <span className="text-text-secondary font-semibold">Keystroke</span> action
                </div>
                <div className="mt-1 text-[10px] text-text-disabled">
                  Press another combo to replace, or click Insert below
                </div>
              </>
            )}
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
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}
