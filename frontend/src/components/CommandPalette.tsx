import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Search, Circle, Play, Square, Type, Save, FolderOpen, RotateCcw, FilePlus,
  Trash2, Download, Upload, RefreshCw,
  Hourglass, ScanSearch, Repeat2, ClipboardPaste, Files, Replace,
  FolderPlus, Palette, PanelLeft, Table2, Keyboard,
  MousePointerClick, Pipette, Crosshair, Combine, Split, GitBranch, ScrollText,
} from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { KbdTag } from './common/KbdTag';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

interface CommandItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
  badge?: string;
  // When true, the row renders greyed-out and clicks no-op. Used for commands that
  // exist conceptually but can't run in the current state (e.g. Duplicate Profile
  // with no active profile — better to show the command + hint than to vanish it,
  // since users searching for "duplicate" otherwise see zero matches and wonder why).
  disabled?: boolean;
  disabledHint?: string;
  onAction: () => void;
}

interface CommandGroup {
  id: string;
  title: string;
  items: CommandItem[];
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const { profiles, activeProfile, settings, buttonStates, actions } = useAppState();
  const { send } = useBridge();
  const selectionRef = useSelectionRef();
  const [query, setQuery] = useState('');

  // Insert position helper: matches the toolbar's behavior — before the first selected
  // action, or at the end of the list when nothing is selected.
  const computeInsertIndex = useCallback(() => {
    const sel = selectionRef.current;
    return sel.size > 0 ? Math.min(...sel) : actions.length;
  }, [actions.length, selectionRef]);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      setQuery('');
      setFocusedIndex(0);
    }
  }, [isOpen]);

  // Build command groups
  const groups: CommandGroup[] = useMemo(() => {
    const isRecording = buttonStates.recordingActive;
    const isReplaying = buttonStates.replayActive;

    return [
      {
        id: 'actions',
        title: 'ACTIONS',
        items: [
          {
            id: 'record',
            label: isRecording ? 'Stop Recording' : 'Start Recording',
            icon: isRecording
              ? <Square size={14} className="text-recording" />
              : <Circle size={14} className="text-recording" />,
            shortcut: settings.recordingHotkey,
            onAction: () => {
              // Match the toolbar/ActionBar — when toggling Recording ON, hint the backend
              // where new actions should land. The hint is ignored when toggling Recording OFF.
              send({ type: 'recording:toggle', payload: { insertIndex: computeInsertIndex() } });
              onClose();
            },
          },
          {
            id: 'replay',
            label: isReplaying ? 'Stop Replay' : 'Start Replay',
            icon: isReplaying
              ? <Square size={14} className="text-replay" />
              : <Play size={14} className="text-replay" />,
            shortcut: settings.replayHotkey,
            onAction: () => {
              send({
                type: 'replay:toggle',
                payload: {
                  loopEnabled: settings.enableLoop,
                  loopCount: settings.loopCount,
                  intervalEnabled: settings.loopIntervalEnabled,
                  intervalText: settings.loopInterval,
                },
              });
              onClose();
            },
          },
          {
            // Macro ↔ Clicker mode switch. Routes through settings:change so the bridge's
            // SetCursorClickMode runs the same flip+cancel logic as the UI toggle and the
            // ModeToggleHotkey (ScrollLock by default).
            id: 'mode',
            label: settings.useCursorClick ? 'Switch to Macro Mode' : 'Switch to Clicker Mode',
            icon: <MousePointerClick size={14} style={{ color: settings.useCursorClick ? 'var(--color-clicker)' : undefined }} className={settings.useCursorClick ? '' : 'text-text-secondary'} />,
            shortcut: settings.modeToggleHotkey,
            onAction: () => { send({ type: 'settings:change', payload: { key: 'useCursorClick', value: !settings.useCursorClick } }); onClose(); },
          },
          {
            id: 'sendtext', label: 'Insert Send Text',
            icon: <Type size={14} className="text-text-secondary" />,
            onAction: () => { onClose(); window.dispatchEvent(new CustomEvent('cmd:sendtext')); },
          },
          {
            // Send Keystroke — unified entry that covers single press, press × N, and
            // hold. The dialog itself exposes the mode toggle. Replaces the legacy
            // sendkey / presskeyn / holdkey palette entries that all opened slightly
            // different dialogs for what are now slices of the same action.
            id: 'sendkeystroke', label: 'Insert Send Keystroke',
            icon: <Keyboard size={14} className="text-text-secondary" />,
            onAction: () => { onClose(); window.dispatchEvent(new CustomEvent('cmd:sendkeystroke')); },
          },
          {
            id: 'waitimage', label: 'Insert Wait for Image',
            icon: <ScanSearch size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:insertAction', payload: { actionType: 'WaitImage', insertIndex: computeInsertIndex() } }); onClose(); },
          },
          {
            // Pairs with Insert Wait for Image — same insert flow, uses the dedicated
            // actions:insertWaitPixelColor handler so the eyedropper opens immediately
            // (matches the Toolbar's Pipette button).
            id: 'waitpixel', label: 'Insert Wait for Pixel Color',
            icon: <Pipette size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:insertWaitPixelColor', payload: { insertIndex: computeInsertIndex() } }); onClose(); },
          },
          {
            // Conditional (IF ... ENDIF) blocks — image- and pixel-driven. Mirrors the Toolbar's
            // Conditional menu; inserts the block, the user configures the probe in the grid.
            id: 'ifimage', label: 'Insert Conditional: Image Found',
            icon: <GitBranch size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:insertConditional', payload: { conditionType: 'ImageFound', insertIndex: computeInsertIndex() } }); onClose(); },
          },
          {
            id: 'ifpixel', label: 'Insert Conditional: Pixel Color',
            icon: <GitBranch size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:insertConditional', payload: { conditionType: 'PixelColorMatch', insertIndex: computeInsertIndex() } }); onClose(); },
          },
          {
            id: 'pause', label: 'Insert Pause',
            icon: <Hourglass size={14} className="text-text-secondary" />,
            // Pattern B normalization — fire the cmd:pause event so the Toolbar
            // opens the PauseDialog (config-first) instead of inserting an empty
            // row that the user has to clean up if they Cancel.
            onAction: () => { onClose(); window.dispatchEvent(new CustomEvent('cmd:pause')); },
          },
          {
            id: 'runprofile', label: 'Insert Run Profile',
            icon: <Repeat2 size={14} className="text-text-secondary" />,
            onAction: () => { onClose(); window.dispatchEvent(new CustomEvent('cmd:runprofile')); },
          },
          {
            id: 'copyactions', label: 'Copy as Table',
            icon: <Table2 size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:copy', payload: {} }); onClose(); },
          },
          {
            id: 'pasteactions', label: 'Paste Actions',
            icon: <ClipboardPaste size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:paste', payload: { insertIndex: computeInsertIndex() } }); onClose(); },
          },
          {
            id: 'convertrelative', label: 'Convert Coordinates to Relative',
            icon: <Replace size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:convertCoordinates', payload: { direction: 'toRelative' } }); onClose(); },
          },
          {
            id: 'convertabsolute', label: 'Convert Coordinates to Absolute',
            icon: <Replace size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:convertCoordinates', payload: { direction: 'toAbsolute' } }); onClose(); },
          },
          {
            // Convert the whole profile between paired (Down/Up) and combined (Keystroke/Click)
            // representations — the on-demand counterpart to the Combined Actions toggle.
            id: 'converttocombined', label: 'Convert Actions to Combined',
            icon: <Combine size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:convertMode', payload: { direction: 'toCombined' } }); onClose(); },
          },
          {
            id: 'converttopaired', label: 'Convert Actions to Paired',
            icon: <Split size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:convertMode', payload: { direction: 'toPaired' } }); onClose(); },
          },
          {
            id: 'clearactions', label: 'Clear All Actions',
            icon: <Trash2 size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:clear', payload: {} }); onClose(); },
          },
        ],
      },
      {
        id: 'profiles',
        title: 'PROFILES',
        items: [
          {
            id: 'newprofile', label: 'New Profile',
            icon: <FilePlus size={14} className="text-text-secondary" />,
            onAction: () => { onClose(); window.dispatchEvent(new CustomEvent('cmd:newprofile')); },
          },
          {
            id: 'newfolder', label: 'New Folder',
            icon: <FolderPlus size={14} className="text-text-secondary" />,
            onAction: () => { onClose(); window.dispatchEvent(new CustomEvent('cmd:newfolder')); },
          },
          {
            id: 'save', label: 'Save Profile', shortcut: 'Ctrl+S',
            icon: <Save size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:save', payload: {} }); onClose(); },
          },
          {
            id: 'load', label: 'Load Profile',
            icon: <FolderOpen size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:load', payload: {} }); onClose(); },
          },
          {
            id: 'reset', label: 'Reset Profile',
            icon: <RotateCcw size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:reset', payload: {} }); onClose(); },
          },
          {
            id: 'duplicateprofile', label: 'Duplicate Profile',
            icon: <Files size={14} className="text-text-secondary" />,
            disabled: !activeProfile,
            disabledHint: 'Select a profile first',
            onAction: () => { if (activeProfile) { send({ type: 'profile:duplicate', payload: { name: activeProfile } }); onClose(); } },
          },
          {
            id: 'importprofiles', label: 'Import Profiles',
            icon: <Download size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:import', payload: {} }); onClose(); },
          },
          {
            id: 'exportall', label: 'Export All Profiles',
            icon: <Upload size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:export', payload: { names: profiles.map(p => p.name), includeOrganization: true } }); onClose(); },
          },
        ],
      },
      {
        // CLICKER section — settings/actions specific to Clicker mode. Currently just the
        // area configurator; will grow as the Clicker feature surface expands.
        id: 'clicker',
        title: 'CLICKER',
        items: [
          {
            id: 'clickerarea', label: 'Configure Click Area',
            icon: <Crosshair size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'clicker:configureArea', payload: { requestId: `palette-${Date.now()}` } }); onClose(); },
          },
        ],
      },
      {
        id: 'view',
        title: 'VIEW',
        items: [
          {
            id: 'themeeditor', label: 'Open Theme Editor',
            icon: <Palette size={14} className="text-text-secondary" />,
            onAction: () => { onClose(); window.dispatchEvent(new CustomEvent('cmd:themeeditor')); },
          },
          {
            id: 'togglesidebar', label: 'Toggle Sidebar',
            icon: <PanelLeft size={14} className="text-text-secondary" />,
            onAction: () => { onClose(); window.dispatchEvent(new CustomEvent('cmd:togglesidebar')); },
          },
          {
            id: 'reloadui', label: 'Reload UI',
            icon: <RefreshCw size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'window:reloadUI', payload: {} }); onClose(); },
          },
          {
            // Opens %LocalAppData%\TrueReplayer\Logs in Explorer. Previously reachable only
            // from the tray menu — surfaced here so users/support can grab the session log
            // for diagnosing silent hotkey / replay issues without hunting for the folder.
            id: 'openlogs', label: 'Open Logs Folder',
            icon: <ScrollText size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'logs:openFolder', payload: {} }); onClose(); },
          },
        ],
      },
      // WINDOW + UPDATES groups removed: every entry there (Always On Top, System Tray,
      // Run on Startup, Start Minimized, Run as Admin, Check for Updates) is a 1:1 duplicate
      // of a Settings-panel switch/button with its own feedback, so they only bloated the
      // palette. The palette now focuses on actions, insertion, transforms, profile management,
      // and view/diagnostic utilities that aren't one-click in the standard UI.
    ];
    // Narrow deps to the exact settings fields read above (hotkeys, loop config, mode flags)
    // so unrelated settings changes (e.g. movement knobs) don't rebuild every command group.
  }, [
    profiles, activeProfile, buttonStates, send, onClose, computeInsertIndex,
    settings.recordingHotkey, settings.replayHotkey, settings.modeToggleHotkey,
    settings.useCursorClick, settings.enableLoop, settings.loopCount,
    settings.loopIntervalEnabled, settings.loopInterval,
  ]);

  // Filter
  const filteredGroups = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return groups;
    return groups.map(g => ({
      ...g,
      items: g.items.filter(item => item.label.toLowerCase().includes(q)),
    })).filter(g => g.items.length > 0);
  }, [groups, query]);

  // Flat list for keyboard nav
  const flatItems = useMemo(() =>
    filteredGroups.flatMap(g => g.items),
    [filteredGroups]
  );

  // Keyboard nav
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        // Math.max(0, ...) guards the empty-list case: when flatItems is empty,
        // length - 1 is -1, which would otherwise leave focusedIndex at an invalid -1.
        setFocusedIndex(prev => Math.max(0, Math.min(prev + 1, flatItems.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = flatItems[focusedIndex];
        if (item && !item.disabled) item.onAction();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose, flatItems, focusedIndex]);

  // Reset focus when filter changes
  useEffect(() => setFocusedIndex(0), [query]);

  if (!isOpen) return null;

  let flatIndex = -1;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-[520px] bg-bg-card border border-border-default rounded-xl overflow-hidden"
        style={{ animation: 'command-in 0.15s ease-out', boxShadow: '0 16px 48px rgba(0,0,0,0.6)' }}
      >
        {/* Search input */}
        <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-border-subtle">
          <Search size={16} className="text-text-tertiary" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent outline-none text-sm text-text-primary placeholder:text-text-disabled"
          />
          <span className="kbd">Esc</span>
        </div>

        {/* Command list */}
        <div className="max-h-[320px] overflow-y-auto py-1.5">
          {filteredGroups.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-text-tertiary">
              No results found
            </div>
          )}
          {filteredGroups.map(group => (
            <div key={group.id}>
              <div className="px-3 py-1.5 text-[11px] font-semibold text-text-disabled">
                {group.title}
              </div>
              {group.items.map(item => {
                flatIndex++;
                const isFocused = flatIndex === focusedIndex;
                const idx = flatIndex;
                const isDisabled = !!item.disabled;
                return (
                  <button
                    key={item.id}
                    onClick={isDisabled ? undefined : item.onAction}
                    onMouseEnter={() => setFocusedIndex(idx)}
                    disabled={isDisabled}
                    title={isDisabled ? item.disabledHint : undefined}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                      isDisabled
                        ? 'opacity-40 cursor-not-allowed'
                        : isFocused
                          ? 'bg-bg-elevated text-text-primary'
                          : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
                    }`}
                    style={{ borderRadius: 'var(--ui-border-radius)' }}
                  >
                    {item.icon}
                    <span className="flex-1 text-left">{item.label}</span>
                    {isDisabled && item.disabledHint && (
                      <span className="text-[10px] text-text-disabled italic">{item.disabledHint}</span>
                    )}
                    {!isDisabled && item.badge && (
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-full text-accent"
                        style={{ background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' }}
                      >
                        {item.badge}
                      </span>
                    )}
                    {!isDisabled && item.shortcut && <KbdTag combo={item.shortcut} />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border-subtle text-[11px] text-text-disabled">
          <span><span className="kbd" style={{ fontSize: 9 }}>↑↓</span> navigate</span>
          <span><span className="kbd" style={{ fontSize: 9 }}>↵</span> select</span>
          <span><span className="kbd" style={{ fontSize: 9 }}>esc</span> close</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
