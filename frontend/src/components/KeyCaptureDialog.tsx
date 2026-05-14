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
 * The key-name mapping produces the same canonical names that `KeyUtils.NormalizeKeyName`
 * in the C# backend emits during recording. This is critical — replay only resolves
 * names that appear in `KeyUtils.VirtualKeyMap` (or in the ConsoleKey enum, but several
 * canonical Win32 names like "Enter", "Backspace", "PageUp" are NOT in ConsoleKey, so
 * mismatches silently no-op at replay time).
 *
 * Older code in ActionTable.tsx's edit-key flow used WinForms Keys-enum names like
 * "Return", "Back", "Prior", "Next", "Capital" — those DON'T resolve and broke
 * inserted actions. This dialog uses the canonical names instead so a Send Key
 * insert is replay-identical to a recorded keystroke. */
function mapKeyEvent(e: KeyboardEvent): string | null {
  const numpadMap: Record<string, string> = {
    Numpad0: 'Num0', Numpad1: 'Num1', Numpad2: 'Num2', Numpad3: 'Num3',
    Numpad4: 'Num4', Numpad5: 'Num5', Numpad6: 'Num6', Numpad7: 'Num7',
    Numpad8: 'Num8', Numpad9: 'Num9',
    NumpadMultiply: 'NumMultiply', NumpadDivide: 'NumDivide',
    NumpadAdd: 'NumAdd', NumpadSubtract: 'NumSubtract',
  };
  // NumpadDecimal and NumpadEnter intentionally NOT in the map — KeyUtils doesn't
  // have a canonical "NumDecimal" entry, and recording emits the literal char "."
  // (via VkToCharCurrentLayout) for VK_DECIMAL. Fall through to the single-char
  // handler so we produce "." here too — match recording exactly. NumpadEnter
  // shares VK with regular Enter, so falling through to e.key==='Enter' is right.
  if (e.code.startsWith('Numpad') && e.code !== 'NumpadEnter' && e.code !== 'NumpadDecimal') {
    return numpadMap[e.code] ?? e.code;
  }
  if (e.key === ' ') return 'Space';
  if (e.key === 'Enter') return 'Enter';
  if (e.key === 'Backspace') return 'Backspace';
  if (e.key === 'ArrowUp') return 'Up';
  if (e.key === 'ArrowDown') return 'Down';
  if (e.key === 'ArrowLeft') return 'Left';
  if (e.key === 'ArrowRight') return 'Right';
  // Modifiers: KeyUtils maps both L/R variants to the same VK but the static map only
  // includes the canonical "Ctrl"/"Shift"/"Alt" — using those instead of numeric codes
  // (which previously worked via the int-fallback path but were non-canonical).
  // AltGraph is the AltGr key on international layouts (ABNT2, AZERTY, etc.) — Windows
  // implements it as Ctrl+Alt internally, so we map it to "Alt" here; recording produces
  // a Ctrl + Alt pair for the same press, which matches close enough for macros.
  if (e.key === 'Control') return 'Ctrl';
  if (e.key === 'Shift') return 'Shift';
  if (e.key === 'Alt' || e.key === 'AltGraph') return 'Alt';
  if (e.key === 'Tab') return 'Tab';
  if (e.key === 'CapsLock') return 'CapsLock';
  if (e.key === 'NumLock') return 'NumLock';
  if (e.key === 'ScrollLock') return 'ScrollLock';
  if (e.key === 'Pause') return 'Pause';        // VK_PAUSE — the Pause/Break key
  if (e.key === 'PrintScreen') return 'PrintScreen'; // ⚠ Chrome/Firefox often only fire keyup for PrtScn — keydown may never reach us. Still mapped so the keyup path (if ever wired) works.
  if (e.key === 'ContextMenu') return 'VK_93';  // Menu key (VK_APPS). No canonical name in KeyUtils; recording produces "VK_93" via the SafeConsoleKeyName fallback, so match that.
  if (e.key === 'Delete') return 'Delete';
  if (e.key === 'Insert') return 'Insert';
  if (e.key === 'Home') return 'Home';
  if (e.key === 'End') return 'End';
  if (e.key === 'PageUp') return 'PageUp';
  if (e.key === 'PageDown') return 'PageDown';
  if (e.key === 'Escape') return 'Escape';
  if (e.key.startsWith('F') && e.key.length <= 3 && !isNaN(Number(e.key.slice(1)))) return e.key;
  if (e.key === 'Meta') return null; // Win key — OS intercepts before browser sees keydown
  // Dead keys (´ ` ^ ~ ¨ etc. on ABNT2 / AZERTY / QWERTZ). The browser fires
  // `e.key === 'Dead'` for these because it's waiting to compose with the next
  // keystroke ('+a → á). length 4, so the single-char branch below would miss
  // them and we'd return null. Recover the intended char by reading e.code,
  // which is LAYOUT-INDEPENDENT (always reports the physical key in US-key
  // terms — Backquote, Quote, BracketLeft, etc.). The literal char returned
  // here resolves at replay via KeyUtils' CharToVkCurrentLayout step, which
  // uses VkKeyScanEx against the user's current layout. Matches recording's
  // semantics close enough for the realistic ABNT2 / AZERTY cases.
  if (e.key === 'Dead') {
    const deadCodeMap: Record<string, string> = {
      Backquote: '`',
      Quote: "'",
      BracketLeft: '[',
      BracketRight: ']',
      Minus: '-',
      Equal: '=',
      Digit6: '^',   // ^ is shift+6 on US, dead key on some layouts
    };
    return deadCodeMap[e.code] ?? null;
  }
  if (e.key.length === 1) {
    const c = e.key.toUpperCase();
    // Digits: KeyUtils.NormalizeKeyName uses bare "0"-"9" (not "D0"-"D9"). The old
    // "D5" form happened to resolve via ConsoleKey.D5 fallback but produced ugly
    // non-canonical strings in the Key column.
    if (/\d/.test(c)) return c;
    if (/[A-Z]/.test(c)) return c;
    // Symbol keys: emit the literal character (`, [, ç, ., etc.). KeyUtils' replay path
    // step 4 (CharToVkCurrentLayout / VkKeyScanEx) resolves single chars against the
    // CURRENT keyboard layout, which is what recording produces too. Layout-portable.
    return e.key;
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
    VK_93: 'Menu',   // ContextMenu / VK_APPS — the keyboard menu key
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
    e.preventDefault();
    e.stopPropagation();
    // Modifiers (Ctrl/Shift/Alt) ARE captureable on their own — they're useful as
    // single-key actions for "hold Ctrl while clicking" type sequences. If the user
    // presses Ctrl on the way to Ctrl+A, the Ctrl gets captured first (briefly),
    // then the A keydown overwrites it. Final state is "A" which is what they
    // intended — the brief flash is fine. An earlier version skipped modifiers
    // entirely on keydown, which made it impossible to insert a bare Ctrl press.
    //
    // Meta (Win key) still returns null from mapKeyEvent because JS keyboard
    // events on Windows often don't fire for it (OS intercepts).
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
            "drop zone" that says 'press now'. Captured state swaps the placeholder
            for the kbd badge. min-h-[136px] sized so both states fit without the
            dialog growing on capture (placeholder is shorter than captured state);
            flex-col + justify-center keeps each state vertically centered inside
            the fixed-height box. */}
        <div className="px-5 py-5">
          <div className="bg-bg-input border border-dashed border-[#FFC107]/40 rounded-md py-5 px-4 text-center min-h-[136px] flex flex-col justify-center">
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
                  className="inline-block self-center px-3 py-1.5 bg-bg-elevated border border-border-default rounded font-mono text-[14px] font-semibold text-[#FFC107]"
                  style={{ boxShadow: '0 2px 0 rgba(0,0,0,0.3)' }}
                >
                  {keyDisplayLabel(captured)}
                </kbd>
                <div className="mt-2 text-[10px] text-text-tertiary">
                  Will insert <span className="text-text-secondary font-semibold">KeyDown</span>
                  {' + '}
                  <span className="text-text-secondary font-semibold">KeyUp</span> pair
                </div>
                <div className="mt-1 text-[10px] text-text-disabled">
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
