import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Trash2, Undo2, Redo2, Type, ScanSearch, Pipette, Keyboard, Globe, Repeat2, Hourglass, X, GitBranch, ScanEye } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { SendTextDialog } from './SendTextDialog';
import { RunProfileDialog } from './RunProfileDialog';
import { NavigateDialog } from './NavigateDialog';
import { KeystrokeCaptureDialog } from './KeystrokeCaptureDialog';
import { PauseDialog } from './PauseDialog';
import { useFlyoutFlip } from '../hooks/useFlyoutFlip';

export interface ColumnVisibility {
  action: boolean;
  // Merged column: the old Key + X + Y trio collapsed into a single "Details"
  // column (key/text/combo for keyboard-ish actions, "x, y" for mouse actions,
  // condition payload for If rows). One toggle controls all of it.
  details: boolean;
  delay: boolean;
  notes: boolean;
}

export const defaultColumnVisibility: ColumnVisibility = {
  action: true,
  details: true,
  delay: true,
  notes: true,
};

// Toggle Columns button is currently DISABLED — the code below is preserved in
// comments for when the user decides on a final home for it. The grid header's
// trailing 24 px column was already removed (no row-spacer waste either way), so
// the only thing missing right now is the actual toggle UI. ActionTable still
// receives columnVisibility from App so columns render correctly; users just
// can't change which columns are visible until the button is re-enabled here
// (or moved somewhere else entirely).
type ToolbarProps = Record<string, never>;

/**
 * Profile-name display that gracefully degrades:
 * 1. fits at base size → text-base (16px)
 * 2. slightly too long  → text-sm (14px) — keeps the full name readable
 * 3. way too long       → text-sm + ellipsis truncation
 *
 * Width is measured via a hidden mirror element so we always know the
 * NATURAL width at base size, regardless of which class is currently
 * applied to the visible span.
 *
 * `actionCount` is optional — renders as a faded "· N action(s)" suffix
 * after the name. The status bar shows it too, but having it inline
 * reinforces context when the user is glancing at the toolbar without
 * looking down. The mirror element below includes the suffix so the
 * size detection accounts for it.
 */
function ResponsiveProfileName({ name, actionCount }: { name: string; actionCount?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState<'base' | 'sm'>('base');
  const showCount = typeof actionCount === 'number' && actionCount > 0;
  const countLabel = showCount ? `${actionCount} ${actionCount === 1 ? 'action' : 'actions'}` : '';

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const update = () => {
      const naturalWidth = measure.scrollWidth;
      const available = container.clientWidth;
      // 4px slack so we don't toggle for sub-pixel rounding
      setSize(naturalWidth > available + 4 ? 'sm' : 'base');
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    return () => ro.disconnect();
  }, [name, countLabel]);

  return (
    <div ref={containerRef} className="flex-1 min-w-0 relative">
      <span
        className={`block font-semibold text-text-primary truncate ${size === 'sm' ? 'text-sm' : 'text-base'}`}
        title={showCount ? `${name} · ${countLabel}` : name}
      >
        {name}
        {showCount && (
          <span className="ml-1.5 font-normal text-text-tertiary">· {countLabel}</span>
        )}
      </span>
      {/* Off-screen mirror used only to measure the unconstrained natural width
          at base size. Kept aria-hidden so screen readers don't see it twice.
          Mirror INCLUDES the count suffix so width detection is accurate. */}
      <span
        ref={measureRef}
        className="absolute -left-[9999px] top-0 font-semibold text-base whitespace-nowrap pointer-events-none"
        aria-hidden="true"
      >
        {name}{showCount && <span className="ml-1.5 font-normal">· {countLabel}</span>}
      </span>
    </div>
  );
}

export function Toolbar(_props: ToolbarProps) {
  const { toolbar, buttonStates, actions, activeProfile } = useAppState();
  const { send } = useBridge();
  /* DISABLED — Toggle Columns dropdown.
   * Re-enable by:
   *   1. Changing ToolbarProps back to { columnVisibility, onColumnVisibilityChange }
   *      and threading those props from App.tsx
   *   2. Uncommenting the block below + the button render further down
   *   3. Restoring the LayoutGrid / Check icon imports
   *
   * const [showColDropdown, setShowColDropdown] = useState(false);
   * const colDropdownRef = useRef<HTMLDivElement>(null);
   * const columnDefinitions: { key: keyof ColumnVisibility; label: string }[] = [
   *   { key: 'action', label: 'Action' },
   *   { key: 'key', label: 'Key' },
   *   { key: 'x', label: 'X' },
   *   { key: 'y', label: 'Y' },
   *   { key: 'delay', label: 'Delay' },
   *   { key: 'notes', label: 'Notes' },
   * ];
   * useEffect(() => {
   *   if (!showColDropdown) return;
   *   const onDown = (e: MouseEvent) => {
   *     if (colDropdownRef.current && !colDropdownRef.current.contains(e.target as Node)) {
   *       setShowColDropdown(false);
   *     }
   *   };
   *   const onKey = (e: KeyboardEvent) => {
   *     if (e.key !== 'Escape') return;
   *     e.preventDefault();
   *     e.stopPropagation();
   *     setShowColDropdown(false);
   *   };
   *   window.addEventListener('mousedown', onDown);
   *   window.addEventListener('keydown', onKey, true);
   *   return () => {
   *     window.removeEventListener('mousedown', onDown);
   *     window.removeEventListener('keydown', onKey, true);
   *   };
   * }, [showColDropdown]);
   */
  const selectionRef = useSelectionRef();
  const [showSendTextDialog, setShowSendTextDialog] = useState(false);
  const [showBrowserMenu, setShowBrowserMenu] = useState(false);
  // Conditional logic dropdown — opens a picker with the supported probe families
  // (ImageFound / PixelColorMatch). Window-based probes were prototyped here under a
  // "soon" tag but removed before v2.3.0 release to avoid shipping disabled UI for
  // unbuilt features — they'll come back wired up when the engine gains the
  // ProbeWindowExists / ProbeWindowFocused helpers. Mirrors the Browser dropdown's
  // open/close lifecycle so the outside-click handler can dismiss it the same way.
  const [showConditionalMenu, setShowConditionalMenu] = useState(false);
  const conditionalMenuRef = useRef<HTMLDivElement>(null);
  // Wait dropdown — consolidates the previous standalone Wait Image + Wait Pixel
  // buttons into one entry. Both options share the "block-until-condition" probe
  // family, so a sub-picker mirrors how the Conditional button groups Image / Pixel
  // probes for IF rows. Same lifecycle (outside-click / Escape dismiss) as the other
  // toolbar menus; separate state so the menus close independently of each other.
  const [showWaitMenu, setShowWaitMenu] = useState(false);
  const waitMenuRef = useRef<HTMLDivElement>(null);
  const [showNavigateDialog, setShowNavigateDialog] = useState(false);
  const [showRunProfileDialog, setShowRunProfileDialog] = useState(false);
  // Pause modal (Pattern B normalization) — was an insert-then-Sheet flow before;
  // now configures up-front like the other dialog-based inserts so Cancel leaves
  // the grid untouched. The ref captures the intended insertIndex at click time
  // because the user's selection may shift while they configure.
  const [showPauseDialog, setShowPauseDialog] = useState(false);
  const pauseDialogInsertIndex = useRef<number>(0);
  // Send Keystroke — unified dialog covers single press, press × N, and hold-key
  // flows via its Mode toggle. Legacy Send Key / Press Key × N / Hold Key state
  // collapsed into this one slot.
  const [showKeystrokeCapture, setShowKeystrokeCapture] = useState(false);
  const keystrokeCaptureInsertIndex = useRef<number>(0);
  const browserMenuRef = useRef<HTMLDivElement>(null);
  // Each toolbar dropdown opens downward (`top-full left-0`); flip it up/right near the
  // viewport bottom/right edge so it isn't clipped. Measured on open by useFlyoutFlip.
  const waitFlyout = useFlyoutFlip(showWaitMenu, 'below');
  const conditionalFlyout = useFlyoutFlip(showConditionalMenu, 'below');
  const browserFlyout = useFlyoutFlip(showBrowserMenu, 'below');

  // Listen for command palette trigger
  useEffect(() => {
    const handler = () => setShowSendTextDialog(true);
    window.addEventListener('cmd:sendtext', handler);
    return () => window.removeEventListener('cmd:sendtext', handler);
  }, []);

  useEffect(() => {
    const handler = () => setShowRunProfileDialog(true);
    window.addEventListener('cmd:runprofile', handler);
    return () => window.removeEventListener('cmd:runprofile', handler);
  }, []);

  // Pause from the command palette — same insertIndex-stash trick as the keystroke
  // path below so a race during dialog config doesn't lose the original target row.
  useEffect(() => {
    const onPause = () => {
      const sel = selectionRef.current;
      pauseDialogInsertIndex.current = sel.size > 0 ? Math.min(...sel) : actions.length;
      setShowPauseDialog(true);
    };
    window.addEventListener('cmd:pause', onPause);
    return () => window.removeEventListener('cmd:pause', onPause);
  }, [actions.length, selectionRef]);

  // Command-palette wrappers for the three keyboard inserts. Mirrors what the
  // "Add Action" dropdown does on click: compute the insertIndex from the
  // current selection (or end-of-list), stash it in the dialog's ref so a
  // race during capture doesn't lose it, and open the dialog. The dialog's
  // own Mode toggle picks Press vs Hold internally — no `mode` prop needed.
  useEffect(() => {
    const onSendKeystroke = () => {
      const sel = selectionRef.current;
      keystrokeCaptureInsertIndex.current = sel.size > 0 ? Math.min(...sel) : actions.length;
      setShowKeystrokeCapture(true);
    };
    window.addEventListener('cmd:sendkeystroke', onSendKeystroke);
    return () => {
      window.removeEventListener('cmd:sendkeystroke', onSendKeystroke);
    };
  }, [actions.length, selectionRef]);

  // Global keyboard shortcuts forwarded from App.tsx (which has no bridge access)
  useEffect(() => {
    const onSave = () => send({ type: 'profile:save', payload: {} });
    const onUndo = () => send({ type: 'actions:undo', payload: {} });
    const onRedo = () => send({ type: 'actions:redo', payload: {} });
    window.addEventListener('cmd:save', onSave);
    window.addEventListener('cmd:undo', onUndo);
    window.addEventListener('cmd:redo', onRedo);
    return () => {
      window.removeEventListener('cmd:save', onSave);
      window.removeEventListener('cmd:undo', onUndo);
      window.removeEventListener('cmd:redo', onRedo);
    };
  }, [send]);

  // Close Browser dropdown on outside click or Escape. The columns + add-actions
  // dropdowns that used to share this handler are gone (columns moved to the grid
  // header, individual inserts are now direct toolbar buttons).
  useEffect(() => {
    if (!showBrowserMenu) return;
    const handler = (e: MouseEvent) => {
      if (browserMenuRef.current && !browserMenuRef.current.contains(e.target as Node)) {
        setShowBrowserMenu(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setShowBrowserMenu(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler, true);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler, true);
    };
  }, [showBrowserMenu]);

  // Same outside-click + Escape dismiss for the Conditional dropdown. Separate
  // effect so the two menus close independently (clicking inside Browser doesn't
  // close Conditional and vice versa).
  useEffect(() => {
    if (!showConditionalMenu) return;
    const handler = (e: MouseEvent) => {
      if (conditionalMenuRef.current && !conditionalMenuRef.current.contains(e.target as Node)) {
        setShowConditionalMenu(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setShowConditionalMenu(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler, true);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler, true);
    };
  }, [showConditionalMenu]);

  // Same outside-click + Escape dismiss for the Wait dropdown. Kept as its own
  // effect (rather than folded with Conditional) so opening one doesn't close the
  // other unexpectedly if they overlap.
  useEffect(() => {
    if (!showWaitMenu) return;
    const handler = (e: MouseEvent) => {
      if (waitMenuRef.current && !waitMenuRef.current.contains(e.target as Node)) {
        setShowWaitMenu(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setShowWaitMenu(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler, true);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler, true);
    };
  }, [showWaitMenu]);

  // Toolbar-owned keyboard shortcuts: Ctrl+C copy, Ctrl+V paste, Alt+↑/↓ reorder.
  // (Undo/redo are intentionally NOT here — App.tsx owns Ctrl+Z/Ctrl+Y; see below.)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      // Undo/Redo (Ctrl+Z / Ctrl+Y / Shift+Ctrl+Z) are intentionally NOT handled here.
      // App.tsx owns those keystrokes globally — it preventDefaults and dispatches
      // cmd:undo / cmd:redo, which the cmd-listener effect above forwards to the bridge.
      // Handling them here too would fire undo/redo twice per keypress.
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        const sel = selectionRef.current;
        if (sel.size > 0) {
          e.preventDefault();
          send({ type: 'actions:copyInternal', payload: { indices: Array.from(sel) } });
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault();
        const sel = selectionRef.current;
        const insertIndex = sel.size > 0 ? Math.min(...sel) : actions.length;
        send({ type: 'actions:paste', payload: { insertIndex } });
      }
      // Alt+↑/↓ to reorder the selected rows. Mirrors the Move Up/Move Down
      // toolbar buttons exactly — same payload, same selection update event.
      // Skipped during recording/replay so a stray Alt+arrow doesn't reshape
      // the actions list while data is being captured or executed.
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const sel = selectionRef.current;
        if (sel.size === 0) return;
        e.preventDefault();
        const indices = Array.from(sel).sort((a, b) => a - b);
        if (e.key === 'ArrowUp') {
          const minIdx = indices[0];
          if (minIdx <= 0) return;
          send({ type: 'actions:reorder', payload: { indices, targetIndex: minIdx - 1 } });
          window.dispatchEvent(new CustomEvent('selection:set', { detail: indices.map(i => i - 1) }));
        } else {
          const maxIdx = indices[indices.length - 1];
          if (maxIdx >= actions.length - 1) return;
          send({ type: 'actions:reorder', payload: { indices, targetIndex: maxIdx + 2 } });
          window.dispatchEvent(new CustomEvent('selection:set', { detail: indices.map(i => i + 1) }));
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // selectionRef is a useRef result — stable identity across renders, so listing it
    // doesn't cause extra subscribes. Adding it just silences exhaustive-deps without
    // changing behaviour (handler always reads .current at the time it fires).
  }, [send, actions.length, selectionRef]);

  return (
    <>
      {/* Explicit h-[47px] so the toolbar's bottom edge lines up with the right panel's
          Profile/Global tab strip (also h-[47px]). Earlier the toolbar used py-2.5 which
          worked when the contents were flat (~46px), but the boxed-group containers
          added in the redesign bumped the row to ~52px and broke the alignment. */}
      <div className="flex items-center gap-3 px-4 h-[47px] bg-bg-surface border border-border-subtle rounded-ui">
        {/* Left: deselect button + profile name with inline action count.
            The X only appears when a profile is actually active — at the
            "No Profile" baseline there's nothing to deselect. Status bar still
            shows the count too; having it next to the name reinforces context
            without making the user look down. Responsive font + truncation
            handle long names; the count drops first if the row gets cramped
            (mirror measures the full string with suffix). */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {activeProfile && (
            // Deselect = sending profile:click with the currently-active name re-uses
            // the existing toggle path in the backend (HandleProfileClick line 2382:
            // "if CurrentProfileName == name → deselect"). No new bridge message needed,
            // and the unsaved-changes guard fires automatically through that path.
            // Disabled during record/replay so a stray click can't yank the profile
            // out from under an in-progress capture or playback.
            <button
              tabIndex={-1}
              onClick={() => send({ type: 'profile:click', payload: { name: activeProfile } })}
              disabled={buttonStates.recordingActive || buttonStates.replayActive}
              data-tip="Deselect profile"
              // -ml-[13px] pulls the icon LEFT into the toolbar's own px-4 padding so the
              // X's vertical line matches the checkbox column center in the table below
              // (measured 12.7px gap before this fix). Purely cosmetic — the hover/click
              // hitbox still sits comfortably inside the toolbar; we're just escaping
              // the padding for one specific icon.
              className="shrink-0 -ml-[13px] p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors disabled:text-text-disabled disabled:hover:bg-transparent"
            >
              <X size={14} />
            </button>
          )}
          <ResponsiveProfileName name={toolbar.profileName} actionCount={toolbar.actionCount} />
        </div>

        {/* Right: tools — prevent focus on click so Space/Enter can't re-trigger.
            A previous redesign wrapped these in 5 boxed-group containers; the
            visual feedback was that the extra borders/padding read as busier
            than the flat row + thin dividers, without buying meaningful
            scannability. The clarity wins (icon swaps, deselect X, paste
            badge, destructive Trash, tooltip pass) all stay; only the
            grouping containers were rolled back. */}
        <div className="flex items-center gap-1 shrink-0" onMouseDown={(e) => e.preventDefault()}>
          {/* Undo / Redo */}
          <button
            tabIndex={-1}
            disabled={!buttonStates.canUndo}
            onClick={() => send({ type: 'actions:undo', payload: {} })}
            className={`p-1.5 rounded transition-colors ${buttonStates.canUndo ? 'text-text-tertiary hover:bg-bg-elevated hover:text-text-primary' : 'text-text-disabled'}`}
            data-tip="Undo (Ctrl+Z)"
          >
            <Undo2 size={14} />
          </button>
          <button
            tabIndex={-1}
            disabled={!buttonStates.canRedo}
            onClick={() => send({ type: 'actions:redo', payload: {} })}
            className={`p-1.5 rounded transition-colors ${buttonStates.canRedo ? 'text-text-tertiary hover:bg-bg-elevated hover:text-text-primary' : 'text-text-disabled'}`}
            data-tip="Redo (Ctrl+Y)"
          >
            <Redo2 size={14} />
          </button>

          {/* DISABLED — Toggle Columns button.
              See the commented state block at the top of this component for the
              re-enable steps. The trailing grid column was already cleaned up so
              re-enabling here is purely additive.
          <div className="relative" ref={colDropdownRef}>
            <button
              tabIndex={-1}
              type="button"
              onClick={() => setShowColDropdown(prev => !prev)}
              className={`p-1.5 rounded transition-colors ${
                showColDropdown
                  ? 'bg-bg-elevated text-accent-light'
                  : 'text-text-tertiary hover:bg-bg-elevated hover:text-text-primary'
              }`}
              data-tip="Toggle columns"
            >
              <LayoutGrid size={14} />
            </button>
            {showColDropdown && (
              <div
                className="absolute right-0 top-[calc(100%+4px)] min-w-[150px] p-1 bg-bg-card border border-border-default rounded-lg z-50"
                style={{ animation: 'fade-in 0.12s ease-out', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
              >
                <div className="px-2.5 py-1.5 text-[11px] font-semibold text-text-tertiary">
                  Toggle columns
                </div>
                {columnDefinitions.map(col => (
                  <button
                    key={col.key}
                    onClick={() => onColumnVisibilityChange({ ...columnVisibility, [col.key]: !columnVisibility[col.key] })}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors"
                  >
                    <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 ${
                      columnVisibility[col.key]
                        ? 'bg-accent-solid border-accent-solid'
                        : 'border-border-default'
                    }`}>
                      {columnVisibility[col.key] && <Check size={10} className="text-white" />}
                    </div>
                    {col.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="w-px h-4 bg-border-subtle mx-1" />
          */}

          {/* ── Insert actions ─────────────────────────────────────────────
              Direct buttons replace the previous "Add Actions" dropdown. Order
              groups input intent first (keystroke → text), then waits/checks
              ordered cheapest-first (Pause → Wait dropdown → Conditional), then
              the cross-surface helpers (Browser dropdown, sub-macro), ending
              with the destructive Clear All. Wait Image + Wait Pixel collapsed
              into a single Wait dropdown to match how the Conditional button
              groups the same Image/Pixel probe family. Move Up / Move Down moved
              to the BulkActionBar (only useful with a selection); click x3 /
              scroll inserts removed long ago because Recording does them
              better. */}

          {/* Send Keystroke — unified keyboard insert (Press 1×, Press N×, or
              Hold for X ms; mode toggle lives inside the dialog). */}
          <button
            tabIndex={-1}
            onClick={() => {
              const sel = selectionRef.current;
              keystrokeCaptureInsertIndex.current = sel.size > 0 ? Math.min(...sel) : actions.length;
              setShowKeystrokeCapture(true);
            }}
            disabled={buttonStates.recordingActive || buttonStates.replayActive}
            className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:text-text-disabled"
            data-tip="Insert Send Keystroke action"
          >
            <Keyboard size={14} />
          </button>

          {/* Send Text */}
          <button
            tabIndex={-1}
            onClick={() => setShowSendTextDialog(true)}
            disabled={buttonStates.recordingActive || buttonStates.replayActive}
            className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:text-text-disabled"
            data-tip="Insert Send Text action"
          >
            <Type size={14} />
          </button>

          {/* Pause — wait for a hotkey or a timeout before continuing replay. Now
              opens a config-first dialog (Pattern B) instead of the old "insert empty
              then auto-open Sheet" flow — Cancel here means no row is created at all. */}
          <button
            tabIndex={-1}
            onClick={() => {
              const sel = selectionRef.current;
              pauseDialogInsertIndex.current = sel.size > 0 ? Math.min(...sel) : actions.length;
              setShowPauseDialog(true);
            }}
            disabled={buttonStates.recordingActive || buttonStates.replayActive}
            className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:text-text-disabled"
            data-tip="Insert Pause action"
          >
            <Hourglass size={14} />
          </button>

          {/* Wait — sub-picker for the two blocking-probe variants. Replaces the
              previous standalone Wait Image + Wait Pixel buttons; the consolidated
              entry mirrors how the Conditional button groups Image/Pixel probes for
              IF rows. Item order matches the Conditional menu (Image first, then
              Pixel) so a user who learned one picker reads the other the same way.
              Both menu items keep their original bridge messages — the row-insert
              UX (overlay opens immediately, row materializes only after a
              successful capture) is unchanged. */}
          <div className="relative" ref={waitMenuRef}>
            <button
              tabIndex={-1}
              onClick={() => setShowWaitMenu(!showWaitMenu)}
              disabled={buttonStates.recordingActive || buttonStates.replayActive}
              className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:text-text-disabled"
              data-tip="Insert Wait (Image / Pixel Color)"
            >
              <ScanEye size={14} />
            </button>
            {showWaitMenu && (
              <div ref={waitFlyout.ref} className={`absolute w-56 bg-bg-surface border border-border-default rounded-lg shadow-xl z-50 py-1 ${waitFlyout.flipX ? 'right-0' : 'left-0'} ${waitFlyout.flipY ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
                <div className="px-3 py-1 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
                  Insert Wait
                </div>
                <button
                  className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors flex items-center gap-2"
                  onClick={() => {
                    const sel = selectionRef.current;
                    const insertIndex = sel.size > 0 ? Math.min(...sel) : actions.length;
                    send({ type: 'actions:insertAction', payload: { actionType: 'WaitImage', insertIndex } });
                    setShowWaitMenu(false);
                  }}
                >
                  <ScanSearch size={12} className="text-accent-light" />
                  Wait for Image…
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors flex items-center gap-2"
                  onClick={() => {
                    const sel = selectionRef.current;
                    const insertIndex = sel.size > 0 ? Math.min(...sel) : actions.length;
                    send({ type: 'actions:insertWaitPixelColor', payload: { insertIndex } });
                    setShowWaitMenu(false);
                  }}
                >
                  <Pipette size={12} className="text-accent-light" />
                  Wait for Pixel Color…
                </button>
              </div>
            )}
          </div>

          {/* Conditional logic — sits with the probe-based insertors (Pause / Pixel /
              Image) because the active picker options reuse those probes as the IF
              condition. GitBranch is the universal "branch / decision" glyph. */}
          <div className="relative" ref={conditionalMenuRef}>
            <button
              tabIndex={-1}
              onClick={() => setShowConditionalMenu(!showConditionalMenu)}
              disabled={buttonStates.recordingActive || buttonStates.replayActive}
              className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:text-text-disabled"
              data-tip="Insert Conditional (If / Else / EndIf)"
            >
              <GitBranch size={14} />
            </button>
            {showConditionalMenu && (
              <div ref={conditionalFlyout.ref} className={`absolute w-56 bg-bg-surface border border-border-default rounded-lg shadow-xl z-50 py-1 ${conditionalFlyout.flipX ? 'right-0' : 'left-0'} ${conditionalFlyout.flipY ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
                <div className="px-3 py-1 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
                  Insert Conditional
                </div>
                {/* Active items — reuse the WaitImage / WaitPixelColor capture flows. */}
                <button
                  className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors flex items-center gap-2"
                  onClick={() => {
                    const sel = selectionRef.current;
                    const insertIndex = sel.size > 0 ? Math.min(...sel) : actions.length;
                    send({ type: 'actions:insertConditional', payload: { conditionType: 'ImageFound', insertIndex } });
                    setShowConditionalMenu(false);
                  }}
                >
                  <ScanSearch size={12} style={{ color: 'var(--color-action-if-fg)' }} />
                  If Image Found…
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors flex items-center gap-2"
                  onClick={() => {
                    const sel = selectionRef.current;
                    const insertIndex = sel.size > 0 ? Math.min(...sel) : actions.length;
                    send({ type: 'actions:insertConditional', payload: { conditionType: 'PixelColorMatch', insertIndex } });
                    setShowConditionalMenu(false);
                  }}
                >
                  <Pipette size={12} style={{ color: 'var(--color-action-if-fg)' }} />
                  If Pixel Color Match…
                </button>
              </div>
            )}
          </div>

          {/* Browser Actions */}
          <div className="relative" ref={browserMenuRef}>
            <button
              tabIndex={-1}
              onClick={() => setShowBrowserMenu(!showBrowserMenu)}
              disabled={buttonStates.recordingActive || buttonStates.replayActive}
              className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:text-text-disabled"
              data-tip="Browser Actions"
            >
              <Globe size={14} />
            </button>
            {showBrowserMenu && (
              <div ref={browserFlyout.ref} className={`absolute w-56 bg-bg-surface border border-border-default rounded-lg shadow-xl z-50 py-1 ${browserFlyout.flipX ? 'right-0' : 'left-0'} ${browserFlyout.flipY ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
                {/* Header pill matches the sibling Wait / Conditional dropdowns so the
                    three menus read as one family. Width also bumped 44 → 56 for the
                    same reason — long labels like "Navigate to URL" got close to the
                    edge at w-44, and the size discrepancy was visible when two menus
                    happened to open near each other during a UX sweep. */}
                <div className="px-3 py-1 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
                  Insert Browser Action
                </div>
                {([
                  { type: 'BrowserClick', label: 'Click Element' },
                  { type: 'BrowserRightClick', label: 'Right Click Element' },
                  { type: 'BrowserType', label: 'Type Text' },
                  { type: 'BrowserSelectOption', label: 'Select Option' },
                  { type: 'BrowserWaitElement', label: 'Wait Element' },
                  { type: 'BrowserNavigate', label: 'Open URL' },
                ] as const).map((item) => (
                  <button
                    key={item.type}
                    className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors flex items-center gap-2"
                    onClick={() => {
                      if (item.type === 'BrowserNavigate') {
                        setShowBrowserMenu(false);
                        setShowNavigateDialog(true);
                      } else {
                        const sel = selectionRef.current;
                        const insertIndex = sel.size > 0 ? Math.min(...sel) : actions.length;
                        send({ type: 'actions:addBrowserAction', payload: { actionType: item.type, selector: '', insertIndex } });
                        setShowBrowserMenu(false);
                      }
                    }}
                  >
                    <Globe size={12} className="text-accent-light" />
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Run Profile — sub-macro call (picker dialog). Sits next to Browser
              because both delegate work elsewhere (a profile / a browser tab). */}
          <button
            tabIndex={-1}
            onClick={() => setShowRunProfileDialog(true)}
            disabled={buttonStates.recordingActive || buttonStates.replayActive}
            className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:text-text-disabled"
            data-tip="Insert Run Profile action"
          >
            <Repeat2 size={14} />
          </button>

          <div className="w-px h-4 bg-border-subtle mx-1" />

          {/* Clear All — destructive hover (red text + faint red bg) mirrors
              BulkActionBar's Delete. Copy/Paste removed from the toolbar
              (redundant with the Ctrl+C / Ctrl+V hotkeys and the BulkActionBar's
              buttons when a selection exists); Toggle Columns moved to the grid
              header where it belongs semantically; Theme Editor moved to
              Settings → Appearance. */}
          <button
            tabIndex={-1}
            onClick={() => send({ type: 'actions:clear', payload: {} })}
            className="p-1.5 rounded text-text-tertiary hover:bg-recording-bg hover:text-recording transition-colors"
            data-tip="Clear all actions in this profile"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {showSendTextDialog && (
        <SendTextDialog
          mode="add"
          onConfirm={(text) => {
            const sel = selectionRef.current;
            const insertIndex = sel.size > 0 ? Math.min(...sel) : undefined;
            send({ type: 'actions:addSendText', payload: { text, insertIndex } });
            setShowSendTextDialog(false);
          }}
          onClose={() => setShowSendTextDialog(false)}
        />
      )}

      {showRunProfileDialog && (
        <RunProfileDialog
          excludeProfileName={activeProfile ?? undefined}
          onConfirm={(profileName, repeatCount) => {
            const sel = selectionRef.current;
            const insertIndex = sel.size > 0 ? Math.min(...sel) : undefined;
            send({ type: 'actions:addRunProfile', payload: { profileName, repeatCount, insertIndex } });
            setShowRunProfileDialog(false);
          }}
          onClose={() => setShowRunProfileDialog(false)}
        />
      )}

      {showNavigateDialog && (
        <NavigateDialog
          onConfirm={(url, newTab) => {
            const sel = selectionRef.current;
            const insertIndex = sel.size > 0 ? Math.min(...sel) : actions.length;
            send({ type: 'actions:addBrowserAction', payload: { actionType: 'BrowserNavigate', selector: url, newTab, insertIndex } });
            setShowNavigateDialog(false);
          }}
          onClose={() => setShowNavigateDialog(false)}
        />
      )}

      {showPauseDialog && (
        <PauseDialog
          onConfirm={(key, timeoutMs) => {
            send({
              type: 'actions:insertPause',
              payload: { key, timeoutMs: Math.max(0, Math.round(timeoutMs)), insertIndex: pauseDialogInsertIndex.current },
            });
            setShowPauseDialog(false);
          }}
          onClose={() => setShowPauseDialog(false)}
        />
      )}

      {/* Send Keystroke — unified capture dialog. The user picks Press or Hold via
          the dialog's own Mode toggle; this mount stays agnostic and dispatches the
          appropriate bridge message based on the result.actionType the dialog returns.
          insertIndex is stashed in a ref at the moment the menu item was clicked
          because by the time the user presses a key the selection may have moved. */}
      {showKeystrokeCapture && (
        <KeystrokeCaptureDialog
          onConfirm={(result) => {
            const insertIndex = keystrokeCaptureInsertIndex.current;
            if (result.actionType === 'HoldKey') {
              send({
                type: 'actions:insertHoldKey',
                payload: { key: result.key, insertIndex, holdDurationMs: result.holdDurationMs },
              });
            } else {
              // Omit `repeat`/`repeatDelayMs` for the single-press default so the bridge
              // payload stays minimal and the C# side leaves RepeatDelayMs as null (clean
              // profile JSON). Mirrors the previous insertion convention.
              const payload: { keystroke: string; insertIndex: number; repeat?: number; repeatDelayMs?: number } =
                { keystroke: result.key, insertIndex };
              if (result.repeat > 1) {
                payload.repeat = result.repeat;
                if (result.repeatDelayMs !== 30) payload.repeatDelayMs = result.repeatDelayMs;
              }
              send({ type: 'actions:insertKeystroke', payload });
            }
            setShowKeystrokeCapture(false);
          }}
          onClose={() => setShowKeystrokeCapture(false)}
        />
      )}
    </>
  );
}
