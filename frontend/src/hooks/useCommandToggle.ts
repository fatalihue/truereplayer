import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/**
 * Visibility for an App-level overlay that is opened from anywhere by a `cmd:*` window
 * CustomEvent — the Theme Editor, the Data Loop panel, the Automation panel and the Run
 * Report all work this way, and all four had the same six-line effect written out by hand.
 *
 * The event is a TOGGLE, not an open: the Settings row / palette entry that fires it acts
 * as a switch, so the handler flips the flag rather than setting it true. That is why the
 * setter comes back too — a panel that also opens from somewhere else (the Automation panel
 * is pushed open by the backend's `automation:open`) or closes from its own onClose needs
 * the absolute set, and only the event path is a toggle.
 *
 * The event NAME is a cross-component contract: the dispatch sites live in files this
 * listener knows nothing about (SettingsPanel, CommandPalette, Toolbar), and a window
 * CustomEvent with nobody listening throws nothing at all. Rename one side and the feature
 * simply stops working, in silence — so the names stay exactly as they are.
 */
export function useCommandToggle(eventName: string): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(prev => !prev);
    window.addEventListener(eventName, handler);
    return () => window.removeEventListener(eventName, handler);
  }, [eventName]);

  return [open, setOpen];
}
