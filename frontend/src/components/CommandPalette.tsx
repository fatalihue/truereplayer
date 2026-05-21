import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Search, Circle, Play, Square, Type, Save, FolderOpen, RotateCcw, FilePlus,
  Trash2, PinOff, Pin, Download, Upload, MonitorDown, Shield, Minimize2, RefreshCw,
  Hourglass, ScanSearch, Repeat2, Undo2, Redo2, ClipboardPaste, Files, Replace,
  FolderPlus, Palette, PanelLeft, DownloadCloud, Table2, Keyboard,
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

  // Insert position helper: matches the toolbar's behavior — after the last selected
  // action, or at the end of the list when nothing is selected.
  const computeInsertIndex = useCallback(() => {
    const sel = selectionRef.current;
    return sel.size > 0 ? Math.max(...sel) + 1 : actions.length;
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
            id: 'undo', label: 'Undo', shortcut: 'Ctrl+Z',
            icon: <Undo2 size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:undo', payload: {} }); onClose(); },
          },
          {
            id: 'redo', label: 'Redo', shortcut: 'Ctrl+Y',
            icon: <Redo2 size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:redo', payload: {} }); onClose(); },
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
            id: 'pause', label: 'Insert Pause',
            icon: <Hourglass size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:insertAction', payload: { actionType: 'Pause', insertIndex: computeInsertIndex() } }); onClose(); },
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
          ...(activeProfile ? [{
            id: 'duplicateprofile', label: 'Duplicate Profile',
            icon: <Files size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:duplicate', payload: { name: activeProfile } }); onClose(); },
          }] : []),
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
        ],
      },
      {
        id: 'window',
        title: 'WINDOW',
        items: [
          {
            id: 'alwaysontop',
            label: settings.alwaysOnTop ? 'Disable Always On Top' : 'Enable Always On Top',
            icon: settings.alwaysOnTop
              ? <PinOff size={14} className="text-text-secondary" />
              : <Pin size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'window:alwaysOnTop', payload: { enabled: !settings.alwaysOnTop } }); onClose(); },
          },
          {
            id: 'systemtray',
            label: settings.minimizeToTray ? 'Disable System Tray' : 'Enable System Tray',
            icon: <Minimize2 size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'window:minimizeToTray', payload: { enabled: !settings.minimizeToTray } }); onClose(); },
          },
          {
            id: 'runonstartup',
            label: settings.runOnStartup ? 'Disable Run on Startup' : 'Enable Run on Startup',
            icon: <MonitorDown size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'window:runOnStartup', payload: { enabled: !settings.runOnStartup } }); onClose(); },
          },
          {
            id: 'startminimized',
            label: settings.startMinimized ? 'Disable Start Minimized' : 'Enable Start Minimized',
            icon: <Minimize2 size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'window:startMinimized', payload: { enabled: !settings.startMinimized } }); onClose(); },
          },
          {
            id: 'runasadmin',
            label: settings.runAsAdmin ? 'Disable Run as Administrator' : 'Enable Run as Administrator',
            icon: <Shield size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'settings:change', payload: { key: 'runAsAdmin', value: !settings.runAsAdmin } }); onClose(); },
          },
        ],
      },
      {
        id: 'updates',
        title: 'UPDATES',
        items: [
          {
            id: 'checkupdates', label: 'Check for Updates',
            icon: <DownloadCloud size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'update:check', payload: {} }); onClose(); },
          },
        ],
      },
    ];
  }, [profiles, activeProfile, settings, buttonStates, send, onClose, computeInsertIndex]);

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
        setFocusedIndex(prev => Math.min(prev + 1, flatItems.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        flatItems[focusedIndex]?.onAction();
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
                return (
                  <button
                    key={item.id}
                    onClick={item.onAction}
                    onMouseEnter={() => setFocusedIndex(idx)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                      isFocused
                        ? 'bg-bg-elevated text-text-primary'
                        : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
                    }`}
                    style={{ borderRadius: 'var(--ui-border-radius)' }}
                  >
                    {item.icon}
                    <span className="flex-1 text-left">{item.label}</span>
                    {item.badge && (
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-full text-accent"
                        style={{ background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' }}
                      >
                        {item.badge}
                      </span>
                    )}
                    {item.shortcut && <KbdTag combo={item.shortcut} />}
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
