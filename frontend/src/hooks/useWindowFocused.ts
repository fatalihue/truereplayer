import { useEffect, useState } from 'react';

/**
 * Whether the TrueReplayer window currently has OS focus.
 *
 * Exists purely so the key-capture dialogs (Send Keystroke / Insert Pause) can EXPLAIN
 * themselves: the low-level hook only captures while TrueReplayer is the foreground app
 * (InputHookManager.CaptureHotkeyMode gates on it), so a pad that says "press any key"
 * while the user is typing in another window would be lying. This is display-only — the
 * real gate lives in C# and is re-evaluated per key event, so a wrong reading here can
 * never enable or disable capture, only mis-word a hint.
 *
 * Chromium blurs the page's `window` when the host HWND is deactivated, which is what
 * makes this track the OS-level activation the C# gate reads.
 */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());

  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    // Re-sync on mount: the dialog may open while the window is already blurred, and
    // the initial useState ran before this effect (no event would fire to correct it).
    setFocused(document.hasFocus());
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return focused;
}
