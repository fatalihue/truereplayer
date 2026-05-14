import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Copy, ClipboardPaste, Trash2, Palette, Undo2, Redo2, LayoutGrid, Check, Type, ArrowUpToLine, ArrowDownToLine, ScanSearch, Plus, Keyboard, Globe, Repeat2, Hourglass, X } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { ThemeEditor } from './ThemeEditor';
import { SendTextDialog } from './SendTextDialog';
import { RunProfileDialog } from './RunProfileDialog';
import { NavigateDialog } from './NavigateDialog';
import { KeyCaptureDialog } from './KeyCaptureDialog';

export interface ColumnVisibility {
  action: boolean;
  key: boolean;
  x: boolean;
  y: boolean;
  delay: boolean;
  notes: boolean;
}

export const defaultColumnVisibility: ColumnVisibility = {
  action: true,
  key: true,
  x: true,
  y: true,
  delay: true,
  notes: true,
};

interface ToolbarProps {
  columnVisibility: ColumnVisibility;
  onColumnVisibilityChange: (vis: ColumnVisibility) => void;
}

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

export function Toolbar({ columnVisibility, onColumnVisibilityChange }: ToolbarProps) {
  const { toolbar, buttonStates, actions, activeProfile } = useAppState();
  const { send } = useBridge();
  const selectionRef = useSelectionRef();
  const [showThemeEditor, setShowThemeEditor] = useState(false);
  const [showColDropdown, setShowColDropdown] = useState(false);
  const [showSendTextDialog, setShowSendTextDialog] = useState(false);
  const [showAddActions, setShowAddActions] = useState(false);
  const [showBrowserMenu, setShowBrowserMenu] = useState(false);
  const [showNavigateDialog, setShowNavigateDialog] = useState(false);
  const [showRunProfileDialog, setShowRunProfileDialog] = useState(false);
  // Send Key… opens this dialog (captures one key via JS events, dispatches an
  // insert-pair message). Replaces the old "Key Press" item that entered OS-level
  // capture mode silently with no visual prompt or commit step.
  const [showKeyCapture, setShowKeyCapture] = useState(false);
  const keyCaptureInsertIndex = useRef<number>(0);
  const colDropdownRef = useRef<HTMLDivElement>(null);
  const addActionsRef = useRef<HTMLDivElement>(null);
  const browserMenuRef = useRef<HTMLDivElement>(null);

  // Listen for command palette trigger
  useEffect(() => {
    const handler = () => setShowSendTextDialog(true);
    window.addEventListener('cmd:sendtext', handler);
    return () => window.removeEventListener('cmd:sendtext', handler);
  }, []);

  useEffect(() => {
    const handler = () => setShowThemeEditor(prev => !prev);
    window.addEventListener('cmd:themeeditor', handler);
    return () => window.removeEventListener('cmd:themeeditor', handler);
  }, []);

  useEffect(() => {
    const handler = () => setShowRunProfileDialog(true);
    window.addEventListener('cmd:runprofile', handler);
    return () => window.removeEventListener('cmd:runprofile', handler);
  }, []);

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

  // Close dropdowns on outside click or Escape
  useEffect(() => {
    if (!showColDropdown && !showAddActions && !showBrowserMenu) return;
    const handler = (e: MouseEvent) => {
      if (showColDropdown && colDropdownRef.current && !colDropdownRef.current.contains(e.target as Node)) {
        setShowColDropdown(false);
      }
      if (showAddActions && addActionsRef.current && !addActionsRef.current.contains(e.target as Node)) {
        setShowAddActions(false);
      }
      if (showBrowserMenu && browserMenuRef.current && !browserMenuRef.current.contains(e.target as Node)) {
        setShowBrowserMenu(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setShowColDropdown(false);
      setShowAddActions(false);
      setShowBrowserMenu(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler, true);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler, true);
    };
  }, [showColDropdown, showAddActions, showBrowserMenu]);

  // Ctrl+Z / Ctrl+Y keyboard shortcuts for undo/redo
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        send({ type: 'actions:undo', payload: {} });
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        send({ type: 'actions:redo', payload: {} });
      }
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
        const insertIndex = sel.size > 0 ? Math.max(...sel) + 1 : actions.length;
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
  }, [send, actions.length]);

  const toggleColumn = (key: keyof ColumnVisibility) => {
    onColumnVisibilityChange({ ...columnVisibility, [key]: !columnVisibility[key] });
  };

  const columns: { key: keyof ColumnVisibility; label: string }[] = [
    { key: 'action', label: 'Action' },
    { key: 'key', label: 'Key' },
    { key: 'x', label: 'X' },
    { key: 'y', label: 'Y' },
    { key: 'delay', label: 'Delay' },
    { key: 'notes', label: 'Notes' },
  ];

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

          <div className="w-px h-4 bg-border-subtle mx-1" />

          {/* Move Up / Move Down */}
          <button
            tabIndex={-1}
            onClick={() => {
              const sel = selectionRef.current;
              if (sel.size === 0) return;
              const indices = Array.from(sel).sort((a, b) => a - b);
              const minIdx = indices[0];
              if (minIdx <= 0) return;
              send({ type: 'actions:reorder', payload: { indices, targetIndex: minIdx - 1 } });
              // Tell ActionTable to update selection to new positions
              window.dispatchEvent(new CustomEvent('selection:set', { detail: indices.map(i => i - 1) }));
            }}
            disabled={buttonStates.recordingActive || buttonStates.replayActive}
            className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:text-text-disabled"
            data-tip="Move selection up (Alt+↑)"
          >
            <ArrowUpToLine size={14} />
          </button>
          <button
            tabIndex={-1}
            onClick={() => {
              const sel = selectionRef.current;
              if (sel.size === 0) return;
              const indices = Array.from(sel).sort((a, b) => a - b);
              const maxIdx = indices[indices.length - 1];
              if (maxIdx >= toolbar.actionCount - 1) return;
              send({ type: 'actions:reorder', payload: { indices, targetIndex: maxIdx + 2 } });
              // Tell ActionTable to update selection to new positions
              window.dispatchEvent(new CustomEvent('selection:set', { detail: indices.map(i => i + 1) }));
            }}
            disabled={buttonStates.recordingActive || buttonStates.replayActive}
            className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:text-text-disabled"
            data-tip="Move selection down (Alt+↓)"
          >
            <ArrowDownToLine size={14} />
          </button>

          <div className="w-px h-4 bg-border-subtle mx-1" />

          {/* Add Actions */}
          <div className="relative" ref={addActionsRef}>
            <button
              tabIndex={-1}
              onClick={() => setShowAddActions(prev => !prev)}
              disabled={buttonStates.recordingActive || buttonStates.replayActive}
              className={`p-1.5 rounded transition-colors disabled:text-text-disabled ${
                showAddActions
                  ? 'bg-bg-elevated text-accent-light'
                  : 'hover:bg-bg-elevated text-text-tertiary hover:text-text-primary'
              }`}
              data-tip="Add Actions"
            >
              <Plus size={14} />
            </button>

            {showAddActions && (
              <div
                className="absolute right-0 top-[calc(100%+4px)] min-w-[200px] p-1 bg-bg-card border border-border-default rounded-lg z-50"
                style={{ animation: 'fade-in 0.12s ease-out', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
              >
                {/* Two-section dropdown:
                    - "Keyboard"    → one-off keystroke inserts that need a capture flow
                                       (Send Key today; a future "Keystroke" combo recorder
                                       lives next to it)
                    - "Wait / Flow" → control-flow inserts (delays / image wait / sub-macro)
                    Click x3 was removed first: recording captures real coords automatically,
                    and the old menu items entered an OS capture mode that required a physical
                    click — strictly worse than recording.
                    Scroll Up/Down removed next for the same principle: recording captures
                    scrolls natively, and the manual-insert path produced an action identical
                    to a recorded one with extra clicks. "Send Key…" replaces the old "Key Press"
                    item with a visible capture dialog (KeyCaptureDialog) so the user sees
                    what was captured before commit. */}
                {([
                  {
                    label: 'Keyboard',
                    items: [
                      { type: 'SendKey', label: 'Send Key…', icon: Keyboard },
                    ],
                  },
                  {
                    label: 'Wait / Flow',
                    items: [
                      { type: 'Pause', label: 'Pause', icon: Hourglass },
                      { type: 'WaitImage', label: 'Wait for Image', icon: ScanSearch },
                      { type: 'RunProfile', label: 'Run Profile', icon: Repeat2 },
                    ],
                  },
                ] as const).map((group, gi) => (
                  <div key={group.label}>
                    {gi > 0 && <div className="h-px bg-border-subtle my-1" />}
                    <div className="px-2.5 py-1.5 text-[11px] font-semibold text-text-tertiary">
                      {group.label}
                    </div>
                    {group.items.map(item => (
                      <button
                        key={item.type}
                        onClick={() => {
                          setShowAddActions(false);
                          const sel = selectionRef.current;
                          const insertIndex = sel.size > 0 ? Math.max(...sel) + 1 : actions.length;
                          // Three special cases that don't fit the generic insertAction
                          // pattern: Run Profile opens a picker dialog, Send Key opens the
                          // KeyCaptureDialog (which dispatches actions:insertKey on commit).
                          if (item.type === 'RunProfile') {
                            setShowRunProfileDialog(true);
                            return;
                          }
                          if (item.type === 'SendKey') {
                            keyCaptureInsertIndex.current = insertIndex;
                            setShowKeyCapture(true);
                            return;
                          }
                          send({ type: 'actions:insertAction', payload: { actionType: item.type, insertIndex } });
                        }}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors"
                      >
                        <item.icon size={12} className="shrink-0" />
                        {item.label}
                      </button>
                    ))}
                  </div>
                ))}
                {/* Footer tip nudges users to Recording for the things the dropdown no longer
                    covers (clicks, scrolls, multi-key sequences). Without this, "where's Left
                    Click?" or "where's Scroll?" becomes a support question. */}
                <div className="h-px bg-border-subtle my-1" />
                <div className="px-2.5 py-2 text-[10px] text-text-tertiary leading-relaxed">
                  💡 For clicks, scrolls or key sequences, use <span className="text-text-secondary font-semibold">Recording</span>.
                </div>
              </div>
            )}
          </div>

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

          {/* Wait for Image / Run Profile / Pause moved into the Add Action dropdown
              under "Wait / Flow" — they're low-frequency inserts that didn't earn
              their own real estate on the main toolbar. */}

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
              <div className="absolute top-full left-0 mt-1 w-44 bg-bg-surface border border-border-default rounded-lg shadow-xl z-50 py-1">
                {([
                  { type: 'BrowserClick', label: 'Left Click' },
                  { type: 'BrowserRightClick', label: 'Right Click' },
                  { type: 'BrowserType', label: 'Input Text' },
                  { type: 'BrowserSelectOption', label: 'Select Option' },
                  { type: 'BrowserWaitElement', label: 'Wait' },
                  { type: 'BrowserNavigate', label: 'Navigate' },
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
                        const insertIndex = sel.size > 0 ? Math.max(...sel) + 1 : actions.length;
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

          <div className="w-px h-4 bg-border-subtle mx-1" />

          {/* Copy / Paste / Clear */}
          <button
            tabIndex={-1}
            onClick={() => {
              const sel = selectionRef.current;
              if (sel.size > 0) {
                send({ type: 'actions:copyInternal', payload: { indices: Array.from(sel) } });
              } else if (actions.length > 0) {
                send({ type: 'actions:copyInternal', payload: { indices: actions.map((_, i) => i) } });
              }
            }}
            className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
            data-tip="Copy Actions (Ctrl+C)"
          >
            <Copy size={14} />
          </button>
          {/* Paste is ALWAYS rendered (symmetry with Copy, which is also always-on) but
              disabled while the internal copy buffer is empty. Earlier this button was
              conditionally rendered when copiedCount > 0 — which made it pop in on the
              first copy and then never disappear (the clipboard never auto-empties on
              paste, so copiedCount stays > 0 for the rest of the session). The "appears
              and stays" pattern read as buggy; always-visible + disabled is the standard
              toolbar convention and lets users learn the button is there before they
              need it. The badge count is the indicator of clipboard state. */}
          <button
            tabIndex={-1}
            onClick={() => {
              const sel = selectionRef.current;
              const insertIndex = sel.size > 0 ? Math.max(...sel) + 1 : actions.length;
              send({ type: 'actions:paste', payload: { insertIndex } });
            }}
            disabled={buttonStates.copiedCount === 0}
            className={`relative p-1.5 rounded transition-colors ${
              buttonStates.copiedCount > 0
                ? 'text-accent-light hover:bg-bg-elevated hover:text-accent'
                : 'text-text-disabled hover:bg-transparent cursor-not-allowed'
            }`}
            data-tip={
              buttonStates.copiedCount > 0
                ? `Paste ${buttonStates.copiedCount} action(s) (Ctrl+V)`
                : 'Paste actions (Ctrl+V) — copy something first'
            }
          >
            <ClipboardPaste size={14} />
            {buttonStates.copiedCount > 0 && (
              // Count badge — communicates "there are N actions in the clipboard ready".
              // Hidden in disabled state because zero would just be noise.
              <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 flex items-center justify-center bg-accent-solid text-white text-[9px] font-bold leading-none rounded-full">
                {buttonStates.copiedCount}
              </span>
            )}
          </button>
          {/* Destructive hover (red text + faint red bg) mirrors BulkActionBar's
              Delete pattern. Clear All wipes every action in the profile, so we
              want users to pause before clicking — neutral gray hover let it
              blend in with non-destructive controls. */}
          <button
            tabIndex={-1}
            onClick={() => send({ type: 'actions:clear', payload: {} })}
            className="p-1.5 rounded text-text-tertiary hover:bg-recording-bg hover:text-recording transition-colors"
            data-tip="Clear all actions in this profile"
          >
            <Trash2 size={14} />
          </button>

          <div className="w-px h-4 bg-border-subtle mx-1" />

          {/* Toggle Columns */}
          <div className="relative" ref={colDropdownRef}>
            <button
              tabIndex={-1}
              onClick={() => setShowColDropdown(prev => !prev)}
              className={`p-1.5 rounded transition-colors ${
                showColDropdown
                  ? 'bg-bg-elevated text-accent-light'
                  : 'hover:bg-bg-elevated text-text-tertiary hover:text-text-primary'
              }`}
              data-tip="Toggle Columns"
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
                {columns.map(col => (
                  <button
                    key={col.key}
                    onClick={() => toggleColumn(col.key)}
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

          {/* Theme Editor */}
          <button
            tabIndex={-1}
            onClick={() => setShowThemeEditor(prev => !prev)}
            className={`p-1.5 rounded transition-colors ${
              showThemeEditor
                ? 'bg-bg-elevated text-accent-light'
                : 'hover:bg-bg-elevated text-text-tertiary hover:text-text-primary'
            }`}
            data-tip="Theme Editor"
          >
            <Palette size={14} />
          </button>
        </div>
      </div>

      {showThemeEditor && <ThemeEditor onClose={() => setShowThemeEditor(false)} />}

      {showSendTextDialog && (
        <SendTextDialog
          mode="add"
          onConfirm={(text) => {
            const sel = selectionRef.current;
            const insertIndex = sel.size > 0 ? Math.max(...sel) + 1 : undefined;
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
            const insertIndex = sel.size > 0 ? Math.max(...sel) + 1 : undefined;
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
            const insertIndex = sel.size > 0 ? Math.max(...sel) + 1 : actions.length;
            send({ type: 'actions:addBrowserAction', payload: { actionType: 'BrowserNavigate', selector: url, newTab, insertIndex } });
            setShowNavigateDialog(false);
          }}
          onClose={() => setShowNavigateDialog(false)}
        />
      )}

      {/* Send Key… capture dialog. The insertIndex is stashed in a ref at the
          moment the user clicks the dropdown item, because by the time they've
          pressed a key the selection may have changed. */}
      {showKeyCapture && (
        <KeyCaptureDialog
          onConfirm={(key) => {
            send({ type: 'actions:insertKey', payload: { key, insertIndex: keyCaptureInsertIndex.current } });
            setShowKeyCapture(false);
          }}
          onClose={() => setShowKeyCapture(false)}
        />
      )}
    </>
  );
}
