import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  Search, Circle, Play, Square, Type, Save, FolderOpen, RotateCcw, Plus,
  Copy, Trash2, PinOff, Pin, ArrowUpDown, MonitorDown, Shield, Minimize2,
} from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
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
  const { profiles, activeProfile, settings, buttonStates } = useAppState();
  const { send } = useBridge();
  const [query, setQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Suppress hotkeys
  useEffect(() => {
    if (isOpen) {
      send({ type: 'ui:modalOpen', payload: {} });
      inputRef.current?.focus();
      setQuery('');
      setFocusedIndex(0);
      return () => { send({ type: 'ui:modalClose', payload: {} }); };
    }
  }, [isOpen, send]);

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
            onAction: () => { send({ type: 'recording:toggle', payload: {} }); onClose(); },
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
            id: 'sendtext', label: 'Insert Send Text',
            icon: <Type size={14} className="text-text-secondary" />,
            onAction: () => { onClose(); window.dispatchEvent(new CustomEvent('cmd:sendtext')); },
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
            id: 'copyactions', label: 'Copy Selected Actions',
            icon: <Copy size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:copy', payload: {} }); onClose(); },
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
            icon: <Plus size={14} className="text-text-secondary" />,
            onAction: () => { onClose(); window.dispatchEvent(new CustomEvent('cmd:newprofile')); },
          },
          ...(activeProfile ? [{
            id: 'duplicateprofile', label: 'Duplicate Profile',
            icon: <Copy size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:duplicate', payload: { name: activeProfile } }); onClose(); },
          }] : []),
          {
            id: 'importprofiles', label: 'Import Profiles',
            icon: <ArrowUpDown size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:import', payload: {} }); onClose(); },
          },
          {
            id: 'exportall', label: 'Export All Profiles',
            icon: <ArrowUpDown size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:export', payload: { names: profiles.map(p => p.name) } }); onClose(); },
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
    ];
  }, [profiles, activeProfile, settings, buttonStates, send, onClose]);

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
