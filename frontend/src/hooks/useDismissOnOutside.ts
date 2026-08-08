import { useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

/**
 * Outside-press + Escape dismissal for a popover that is nothing but a boolean flag
 * and a wrapper ref — the shape every Toolbar dropdown has (Browser, Conditional,
 * Wait, and the Clear All confirm). Those four carried four byte-identical copies of
 * this effect; only the flag and the ref ever differed.
 *
 * One hook CALL per menu, deliberately — not one hook that knows about all of them.
 * Each menu keeps its own listener pair bound only while it is open, which is what
 * makes them close independently: pressing inside the Browser menu can never dismiss
 * the Wait menu, because the Wait menu has no listener attached at that moment.
 *
 * Three details are load-bearing and were preserved exactly from the copies:
 *
 *   • `mousedown`, not `click`. Dismissal happens on the press, so the popover is
 *     already gone before the click lands — one gesture both closes the menu and
 *     actuates whatever the user was aiming at underneath it.
 *   • Escape is bound in the CAPTURE phase, with preventDefault + stopPropagation.
 *     document-capture runs before React's own root listener, so an open dropdown
 *     swallows the key: Escape closes the dropdown and ONLY the dropdown, never also
 *     the DialogShell card behind it (which closes on Escape too, from a React
 *     onKeyDown on the card). One Escape, one thing closed.
 *   • The early return while closed. It is not just a guard — it is why the idle app
 *     carries no global mousedown/keydown handlers for menus nobody opened.
 *
 * `setOpen` is expected to be a useState setter (stable identity), so the effect
 * re-subscribes only when `open` flips.
 */
export function useDismissOnOutside(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  setOpen: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    if (!open) return;
    const onPress = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onPress);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPress);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, ref, setOpen]);
}
