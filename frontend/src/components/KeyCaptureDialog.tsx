import { useState, useRef, useEffect, useCallback } from 'react';
import { Keyboard } from 'lucide-react';

interface KeyCaptureDialogProps {
  onConfirm: (key: string) => void;
  onClose: () => void;
}

/**
 * Modal that captures a single keystroke (via JS keyboard events) and reports the
 * internal key name back to the caller. The caller is expected to insert a
 * KeyDown + KeyUp pair using the returned name.
 *
 * Why not reuse the existing OS-level capture mode (the one triggered by the old
 * "Key Press" dropdown item)? Two reasons:
 *   1. **Visible feedback**. OS capture is silent — no UI prompt, no preview of
 *      what was captured before commit. Users had to "guess and check" by
 *      pressing a key and hoping the right action was inserted.
 *   2. **No commit step**. With OS capture there's no chance to back out if you
 *      mis-pressed. This dialog shows the captured key and waits for Insert.
 *
 * Limitations vs OS capture: JS keyboard events don't fire for the Windows key,
 * Print Screen, or system-reserved combos. For those, recording is the right
 * path — and the dropdown tip below the items already nudges users that way.
 *
 * The key-name mapping mirrors ActionTable.tsx's handleKeyCaptureKeyDown so that
 * a Send Key insert produces the same Key string as recording would. (Sharing
 * the mapping in a utility would be cleaner long-term; not extracted yet because
 * the dialog inlines a slightly trimmed subset — no auto-commit timer needed
 * here since the user explicitly confirms with the Insert button.)
 */
function mapKeyEvent(e: KeyboardEvent): string | null {
  const numpadMap: Record<string, string> = {
    Numpad0: 'Num0', Numpad1: 'Num1', Numpad2: 'Num2', Numpad3: 'Num3',
    Numpad4: 'Num4', Numpad5: 'Num5', Numpad6: 'Num6', Numpad7: 'Num7',
    Numpad8: 'Num8', Numpad9: 'Num9',
    NumpadMultiply: 'NumMultiply', NumpadDivide: 'NumDivide',
    NumpadAdd: 'NumAdd', NumpadSubtract: 'NumSubtract',
    NumpadDecimal: 'NumDecimal',
  };
  if (e.code.startsWith('Numpad') && e.code !== 'NumpadEnter') {
    return numpadMap[e.code] ?? e.code;
  }
  if (e.key === ' ') return 'Space';
  if (e.key === 'Enter') return 'Return';
  if (e.key === 'Backspace') return 'Back';
  if (e.key === 'ArrowUp') return 'Up';
  if (e.key === 'ArrowDown') return 'Down';
  if (e.key === 'ArrowLeft') return 'Left';
  if (e.key === 'ArrowRight') return 'Right';
  if (e.key === 'Control') return e.code === 'ControlRight' ? '163' : '162';
  if (e.key === 'Shift') return e.code === 'ShiftRight' ? '161' : '160';
  if (e.key === 'Alt') return e.code === 'AltRight' ? '165' : '164';
  if (e.key === 'Tab') return 'Tab';
  if (e.key === 'CapsLock') return 'Capital';
  if (e.key === 'Delete') return 'Delete';
  if (e.key === 'Insert') return 'Insert';
  if (e.key === 'Home') return 'Home';
  if (e.key === 'End') return 'End';
  if (e.key === 'PageUp') return 'Prior';
  if (e.key === 'PageDown') return 'Next';
  if (e.key === 'Escape') return 'Escape';
  if (e.key.startsWith('F') && e.key.length <= 3 && !isNaN(Number(e.key.slice(1)))) return e.key;
  if (e.key === 'Meta') return null; // Ignore Win key
  if (e.key.length === 1) {
    const c = e.key.toUpperCase();
    if (/\d/.test(c)) return `D${c}`;
    if (/[A-Z]/.test(c)) return c;
    // Symbol keys — map by code
    const symbolMap: Record<string, string> = {
      Backquote: 'Oem3', Minus: 'OemMinus', Equal: 'OemPlus',
      BracketLeft: 'Oem4', BracketRight: 'Oem6', Backslash: 'Oem5',
      Semicolon: 'Oem1', Quote: 'Oem7', Comma: 'OemComma',
      Period: 'OemPeriod', Slash: 'Oem2',
    };
    return symbolMap[e.code] ?? c;
  }
  return null;
}

/** Short, human-readable label for the captured key — what shows inside the kbd badge. */
function keyDisplayLabel(internalName: string): string {
  // Internal names like "D5", "Return", "Back", "Oem3" → friendlier shorthand
  if (/^D\d$/.test(internalName)) return internalName.slice(1);
  const friendly: Record<string, string> = {
    Return: 'Enter',
    Back: 'Backspace',
    Capital: 'CapsLock',
    Prior: 'PageUp',
    Next: 'PageDown',
    Oem3: '`',
    OemMinus: '-',
    OemPlus: '=',
    Oem4: '[',
    Oem6: ']',
    Oem5: '\\',
    Oem1: ';',
    Oem7: "'",
    OemComma: ',',
    OemPeriod: '.',
    Oem2: '/',
  };
  return friendly[internalName] ?? internalName;
}

export function KeyCaptureDialog({ onConfirm, onClose }: KeyCaptureDialogProps) {
  const [captured, setCaptured] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Focus the dialog root so keydown lands on it (preventDefault stops the key from
  // bubbling out to e.g. the table's own keyboard handler).
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Escape is a real capturable key (user might want to insert it), BUT if no key has
    // been captured yet, treat Escape as "cancel the dialog" — matches typical modal UX.
    if (e.key === 'Escape' && captured === null) {
      e.preventDefault();
      onClose();
      return;
    }
    // Don't capture pure modifier presses on their own — wait for the actual key.
    // (e.g. user pressing Ctrl on their way to Ctrl+A: ignore the Ctrl event.) This
    // means we DO capture Ctrl/Shift/Alt as standalone if they're released, but the
    // 99% case is they're typing a real key.
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const name = mapKeyEvent(e.nativeEvent);
    if (name) setCaptured(name);
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
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-xl w-[360px] max-w-[90vw] flex flex-col outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <Keyboard size={14} className="text-accent-light" />
          <h3 className="text-sm font-semibold text-text-primary">Capture Key</h3>
        </div>

        {/* Body — the gold-dashed box is the focal point: gives the user a visual
            "drop zone" that says 'press now'. Captured state is reflected by
            swapping the placeholder text for the kbd badge. */}
        <div className="px-5 py-5">
          <div className="bg-bg-input border border-dashed border-[#FFC107]/40 rounded-md py-5 px-4 text-center">
            {captured === null ? (
              <>
                <div className="text-[12px] text-text-tertiary mb-1">Press any key…</div>
                <div className="text-[10px] text-text-disabled">
                  Esc cancels — captured Esc requires pressing it twice
                </div>
              </>
            ) : (
              <>
                <kbd
                  className="inline-block px-3 py-1.5 bg-bg-elevated border border-border-default rounded font-mono text-[14px] font-semibold text-[#FFC107]"
                  style={{ boxShadow: '0 2px 0 rgba(0,0,0,0.3)' }}
                >
                  {keyDisplayLabel(captured)}
                </kbd>
                <div className="mt-2 text-[10px] text-text-tertiary">
                  Will insert <span className="text-text-secondary font-semibold">KeyDown</span>
                  {' + '}
                  <span className="text-text-secondary font-semibold">KeyUp</span> pair
                </div>
                <div className="mt-2 text-[10px] text-text-disabled">
                  Press another key to replace, or click Insert below
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
