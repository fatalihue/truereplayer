import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Search, RotateCcw, Download, Upload, RefreshCw,
  ClipboardPaste, Files, Replace, Table2,
  Combine, Split, ScrollText, Activity,
} from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { useTt } from '../state/LanguageContext';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

interface CommandItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  // When true, the row renders greyed-out and clicks no-op. Used for commands that
  // exist conceptually but can't run in the current state (e.g. Duplicate Profile
  // with no active profile — better to show the command + hint than to vanish it,
  // since users searching for "duplicate" otherwise see zero matches and wonder why).
  disabled?: boolean;
  disabledHint?: string;
  // Extra search terms (not displayed) so an entry is findable by what users call
  // it, not just its canonical label — e.g. "Copy as Table" matches "tsv"/"export".
  keywords?: string[];
  onAction: () => void;
}

interface CommandGroup {
  id: string;
  title: string;
  items: CommandItem[];
}

// SCOPE — this palette is deliberately small. An entry earns its place only when the
// capability is buried in a nested right-click menu, keyboard-only, or has no UI control
// at all. Anything reachable from a persistent labelled control (the Toolbar insert row,
// the ActionBar, the ProfilePanel header, a Settings row) is intentionally ABSENT: a
// second door to a visible button is pure noise, and it pushes the genuinely
// hard-to-find commands down the list. The WINDOW and UPDATES groups went first for this
// reason; the ACTIONS insert block (every type has a Toolbar button), the ActionBar trio
// (Record/Replay/Mode), the profile CRUD entries and the view-chrome toggles followed for
// the same one. Before adding a command, find its UI control — if it has a discoverable
// one, it does not belong here.
export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const { profiles, activeProfile, settings, actions } = useAppState();
  const { send } = useBridge();
  const selectionRef = useSelectionRef();
  const tt = useTt();
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
    // Clicker-mode gate — mirrors the Toolbar's insertsDisabled story: these
    // entries mutate the macro list, which is invisible in Clicker mode.
    const isClicker = settings.useCursorClick;
    const clickerHint = tt('Not available in Clicker mode — switch to Macro', 'Indisponível no modo Clicker — mude para Macro');

    return [
      {
        // What survives here are whole-list operations with no toolbar button: the
        // clipboard bridge and the four bulk coordinate/pairing rewrites, each of which
        // otherwise lives three clicks deep in a right-click "More" submenu.
        id: 'actions',
        title: 'ACTIONS',
        items: [
          {
            id: 'copyactions', label: 'Copy as Table',
            keywords: ['tsv', 'export', 'clipboard', 'spreadsheet'],
            icon: <Table2 size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:copy', payload: {} }); onClose(); },
          },
          {
            // Ctrl+V works but has no visible control anywhere, so this is the only
            // discoverable route.
            id: 'pasteactions', label: 'Paste Actions',
            disabled: isClicker, disabledHint: clickerHint,
            icon: <ClipboardPaste size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:paste', payload: { insertIndex: computeInsertIndex() } }); onClose(); },
          },
          {
            id: 'convertrelative', label: 'Convert Coordinates to Relative',
            disabled: isClicker, disabledHint: clickerHint,
            keywords: ['window relative', 'rebase', 'coordinates'],
            icon: <Replace size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:convertCoordinates', payload: { direction: 'toRelative' } }); onClose(); },
          },
          {
            id: 'convertabsolute', label: 'Convert Coordinates to Absolute',
            disabled: isClicker, disabledHint: clickerHint,
            keywords: ['screen coordinates', 'rebase'],
            icon: <Replace size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:convertCoordinates', payload: { direction: 'toAbsolute' } }); onClose(); },
          },
          {
            // Convert the whole profile between paired (Down/Up) and combined (Keystroke/Click)
            // representations — the on-demand counterpart to the Combined Actions toggle.
            id: 'converttocombined', label: 'Convert Actions to Combined',
            disabled: isClicker, disabledHint: clickerHint,
            keywords: ['merge', 'keystroke', 'click'],
            icon: <Combine size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:convertMode', payload: { direction: 'toCombined' } }); onClose(); },
          },
          {
            id: 'converttopaired', label: 'Convert Actions to Paired',
            disabled: isClicker, disabledHint: clickerHint,
            keywords: ['split', 'down up', 'separate'],
            icon: <Split size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'actions:convertMode', payload: { direction: 'toPaired' } }); onClose(); },
          },
        ],
      },
      {
        // New / Save / Load / New Folder all have persistent buttons (ActionBar and the
        // ProfilePanel header), so only the routes with no visible control remain.
        id: 'profiles',
        title: 'PROFILES',
        items: [
          {
            id: 'reset', label: 'Reset Profile',
            keywords: ['clear', 'start over', 'blank'],
            icon: <RotateCcw size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:reset', payload: {} }); onClose(); },
          },
          {
            // Right-click-menu-only otherwise, so it stays searchable by name.
            id: 'duplicateprofile', label: 'Duplicate Profile',
            keywords: ['copy profile', 'clone'],
            icon: <Files size={14} className="text-text-secondary" />,
            disabled: !activeProfile,
            disabledHint: tt('Select a profile first', 'Selecione um perfil primeiro'),
            onAction: () => { if (activeProfile) { send({ type: 'profile:duplicate', payload: { name: activeProfile } }); onClose(); } },
          },
          {
            // The only non-nested way in: the other Import button lives INSIDE the Export
            // dialog, where nobody looking to import would think to open it.
            id: 'importprofiles', label: 'Import Profiles',
            keywords: ['restore', 'load file', 'json'],
            icon: <Download size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:import', payload: {} }); onClose(); },
          },
          {
            // Distinct from the header's Export button, which opens a multi-select dialog:
            // this is the one-shot "everything, organisation included" export.
            id: 'exportall', label: 'Export All Profiles',
            keywords: ['backup', 'save all', 'json'],
            icon: <Upload size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'profile:export', payload: { names: profiles.map(p => p.name), includeOrganization: true } }); onClose(); },
          },
        ],
      },
      {
        // Diagnostics — none of these have a UI control anywhere in the app.
        id: 'view',
        title: 'DIAGNOSTICS',
        items: [
          {
            // Live-variables debug pane — floating card mirroring {var:}/{clip:}/row state.
            // The palette is its ONLY opener; the pane's own button can only close it.
            id: 'livevars', label: 'Toggle Live Variables',
            keywords: ['debug', 'variables', 'slots', 'clip', 'watch', 'row'],
            icon: <Activity size={14} className="text-text-secondary" />,
            onAction: () => { onClose(); window.dispatchEvent(new CustomEvent('cmd:livevars')); },
          },
          {
            // Recovery hatch for a wedged WebView2 UI.
            id: 'reloadui', label: 'Reload UI',
            keywords: ['refresh', 'stuck', 'frozen'],
            icon: <RefreshCw size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'window:reloadUI', payload: {} }); onClose(); },
          },
          {
            // Opens %LocalAppData%\TrueReplayer\Logs in Explorer. Otherwise reachable only
            // from the tray menu — surfaced here so users/support can grab the session log
            // for diagnosing silent hotkey / replay issues without hunting for the folder.
            id: 'openlogs', label: 'Open Logs Folder',
            keywords: ['diagnostics', 'session log', 'support', 'troubleshoot'],
            icon: <ScrollText size={14} className="text-text-secondary" />,
            onAction: () => { send({ type: 'logs:openFolder', payload: {} }); onClose(); },
          },
        ],
      },
    ];
    // Narrow deps to the exact settings field read above so unrelated settings changes
    // (hotkeys, loop config, movement knobs) don't rebuild every command group.
  }, [
    profiles, activeProfile, send, onClose, computeInsertIndex, tt,
    settings.useCursorClick,
  ]);

  // Filter
  const filteredGroups = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return groups;
    return groups.map(g => ({
      ...g,
      items: g.items.filter(item => item.label.toLowerCase().includes(q)
        || item.keywords?.some(k => k.toLowerCase().includes(q))),
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
        className="command-enter w-[520px] bg-bg-card border border-border-default rounded-xl overflow-hidden"
        style={{ boxShadow: '0 16px 48px rgba(0,0,0,0.6)' }}
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
              <div className="px-3 py-1.5 label-micro text-text-tertiary">
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
                    data-tip={isDisabled ? item.disabledHint : undefined}
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
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border-subtle text-[11px] text-text-disabled">
          {/* No inline fontSize override — the shared .kbd utility's 10px is the app-wide
              minimum for legible text (the old fontSize: 9 was flagged by the type audit). */}
          <span><span className="kbd">↑↓</span> navigate</span>
          <span><span className="kbd">↵</span> select</span>
          <span><span className="kbd">esc</span> close</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
