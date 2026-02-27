import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Search, Pencil, Trash2, FolderOpen, Key, KeyRound, Crosshair, Upload, Download } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';

interface ContextMenuState {
  x: number;
  y: number;
  profileName: string;
}

export function ProfilePanel() {
  const { profiles } = useAppState();
  const { send, subscribe } = useBridge();
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [showHotkeyDialog, setShowHotkeyDialog] = useState<string | null>(null);
  const [hotkeyCapture, setHotkeyCapture] = useState('...');
  const [showWindowTargetDialog, setShowWindowTargetDialog] = useState<string | null>(null);
  const [targetProcessName, setTargetProcessName] = useState('');
  const [targetWindowTitle, setTargetWindowTitle] = useState('');
  const [titleMatchMode, setTitleMatchMode] = useState<'contains' | 'regex'>('contains');
  const [detectCountdown, setDetectCountdown] = useState<number | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportSelection, setExportSelection] = useState<Record<string, boolean>>({});
  const [dialogValue, setDialogValue] = useState('');
  const dialogInputRef = useRef<HTMLInputElement>(null);
  const hotkeyInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const filtered = searchQuery
    ? profiles.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : profiles;

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu]);

  // Focus dialog input when opened
  useEffect(() => {
    if ((showCreateDialog || showRenameDialog) && dialogInputRef.current) {
      dialogInputRef.current.focus();
      dialogInputRef.current.select();
    }
  }, [showCreateDialog, showRenameDialog]);

  // Focus hotkey input when dialog opens
  useEffect(() => {
    if (showHotkeyDialog && hotkeyInputRef.current) {
      hotkeyInputRef.current.focus();
    }
  }, [showHotkeyDialog]);

  // Suppress hotkeys while any dialog is open
  const anyDialogOpen = showCreateDialog || showRenameDialog !== null || showDeleteConfirm !== null || showHotkeyDialog !== null || showWindowTargetDialog !== null || showExportDialog;
  useEffect(() => {
    if (anyDialogOpen) {
      send({ type: 'ui:modalOpen', payload: {} });
      return () => { send({ type: 'ui:modalClose', payload: {} }); };
    }
  }, [anyDialogOpen, send]);

  const handleExportClick = () => {
    if (profiles.length === 0) return;
    const selection: Record<string, boolean> = {};
    profiles.forEach(p => { selection[p.name] = true; });
    setExportSelection(selection);
    setShowExportDialog(true);
  };

  const handleImportClick = () => {
    send({ type: 'profile:import', payload: {} });
  };

  const allExportSelected = profiles.length > 0 && profiles.every(p => exportSelection[p.name]);

  const toggleExportSelectAll = () => {
    const newVal = !allExportSelected;
    const updated: Record<string, boolean> = {};
    profiles.forEach(p => { updated[p.name] = newVal; });
    setExportSelection(updated);
  };

  const toggleExportProfile = (name: string) => {
    setExportSelection(prev => ({ ...prev, [name]: !prev[name] }));
  };

  const confirmExport = () => {
    const selectedNames = Object.entries(exportSelection)
      .filter(([, checked]) => checked)
      .map(([name]) => name);
    if (selectedNames.length > 0) {
      send({ type: 'profile:export', payload: { names: selectedNames } });
    }
    setShowExportDialog(false);
  };

  const handleContextMenu = useCallback((e: React.MouseEvent, name: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, profileName: name });
  }, []);

  const handleCreate = () => {
    setContextMenu(null);
    setDialogValue('');
    setShowCreateDialog(true);
  };

  const handleRename = (name: string) => {
    setContextMenu(null);
    setDialogValue(name);
    setShowRenameDialog(name);
  };

  const handleDelete = (name: string) => {
    setContextMenu(null);
    setShowDeleteConfirm(name);
  };

  const confirmDelete = () => {
    if (showDeleteConfirm) {
      send({ type: 'profile:delete', payload: { name: showDeleteConfirm } });
    }
    setShowDeleteConfirm(null);
  };

  const handleOpenFolder = (name: string) => {
    setContextMenu(null);
    send({ type: 'profile:openFolder', payload: { name } });
  };

  const handleAssignHotkey = (name: string) => {
    setContextMenu(null);
    setHotkeyCapture('...');
    setShowHotkeyDialog(name);
  };

  const handleRemoveHotkey = (name: string) => {
    setContextMenu(null);
    send({ type: 'profile:removeHotkey', payload: { name } });
  };

  const handleSetWindowTarget = (name: string) => {
    setContextMenu(null);
    setTargetProcessName('');
    setTargetWindowTitle('');
    setTitleMatchMode('contains');
    setDetectCountdown(null);
    setShowWindowTargetDialog(name);
  };

  const handleRemoveWindowTarget = (name: string) => {
    setContextMenu(null);
    send({ type: 'profile:removeWindowTarget', payload: { name } });
  };

  const handleDetectWindow = () => {
    send({ type: 'profile:detectWindow', payload: {} });
    setDetectCountdown(3);
  };

  const confirmWindowTarget = () => {
    if (showWindowTargetDialog && (targetProcessName.trim() || targetWindowTitle.trim())) {
      send({
        type: 'profile:setWindowTarget',
        payload: {
          name: showWindowTargetDialog,
          processName: targetProcessName.trim(),
          windowTitle: targetWindowTitle.trim(),
          titleMatchMode
        }
      });
    }
  };

  const handleHotkeyCapture = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const modifiers: string[] = [];
    if (e.ctrlKey) modifiers.push('Ctrl');
    if (e.altKey) modifiers.push('Alt');
    if (e.shiftKey) modifiers.push('Shift');

    const modifierKeys = new Set(['Control', 'Alt', 'Shift', 'Meta']);
    if (modifierKeys.has(e.key)) {
      setHotkeyCapture(modifiers.join('+') || '...');
      return;
    }

    // Use e.code to distinguish numpad from main keyboard
    let mainKey = e.key;
    if (e.code.startsWith('Numpad') && e.code !== 'NumpadEnter') {
      const numpadMap: Record<string, string> = {
        Numpad0: 'Num0', Numpad1: 'Num1', Numpad2: 'Num2', Numpad3: 'Num3',
        Numpad4: 'Num4', Numpad5: 'Num5', Numpad6: 'Num6', Numpad7: 'Num7',
        Numpad8: 'Num8', Numpad9: 'Num9',
        NumpadMultiply: 'NumMultiply', NumpadDivide: 'NumDivide',
        NumpadAdd: 'NumAdd', NumpadSubtract: 'NumSubtract',
        NumpadDecimal: 'NumDecimal',
      };
      mainKey = numpadMap[e.code] ?? e.code;
    } else if (mainKey === ' ') mainKey = 'Space';
    else if (mainKey.length === 1) mainKey = mainKey.toUpperCase();
    else if (mainKey === 'ArrowUp') mainKey = 'Up';
    else if (mainKey === 'ArrowDown') mainKey = 'Down';
    else if (mainKey === 'ArrowLeft') mainKey = 'Left';
    else if (mainKey === 'ArrowRight') mainKey = 'Right';

    if (!modifiers.includes(mainKey)) modifiers.push(mainKey);
    const combo = modifiers.join('+');
    setHotkeyCapture(combo);
  };

  const confirmHotkey = () => {
    if (showHotkeyDialog && hotkeyCapture && hotkeyCapture !== '...') {
      send({ type: 'profile:assignHotkey', payload: { name: showHotkeyDialog, hotkey: hotkeyCapture } });
      // Don't close dialog here — wait for profiles:updated (success) or alert:show (conflict)
    }
  };

  // Auto-close hotkey dialog when profile list updates (means hotkey was saved successfully)
  useEffect(() => {
    if (!showHotkeyDialog) return;
    return subscribe((msg) => {
      if (msg.type === 'profiles:updated') {
        setShowHotkeyDialog(null);
      }
    });
  }, [showHotkeyDialog, subscribe]);

  // Window target detect countdown
  useEffect(() => {
    if (detectCountdown === null || detectCountdown <= 0) return;
    const timer = setTimeout(() => setDetectCountdown(detectCountdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [detectCountdown]);

  // Subscribe to window target detection result and auto-close on success
  useEffect(() => {
    if (!showWindowTargetDialog) return;
    return subscribe((msg) => {
      if (msg.type === 'profiles:updated') {
        setShowWindowTargetDialog(null);
      }
      if (msg.type === 'windowTarget:detected') {
        const p = msg.payload as { processName: string; windowTitle: string };
        setTargetProcessName(p.processName);
        setTargetWindowTitle(p.windowTitle);
        setDetectCountdown(null);
      }
    });
  }, [showWindowTargetDialog, subscribe]);

  const confirmCreate = () => {
    const name = dialogValue.trim();
    if (name) {
      send({ type: 'profile:create', payload: { name } });
    }
    setShowCreateDialog(false);
  };

  const confirmRename = () => {
    const newName = dialogValue.trim();
    if (newName && showRenameDialog && newName !== showRenameDialog) {
      send({ type: 'profile:rename', payload: { oldName: showRenameDialog, newName } });
    }
    setShowRenameDialog(null);
  };

  const handleDialogKeyDown = (e: React.KeyboardEvent, onConfirm: () => void) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setShowCreateDialog(false);
      setShowRenameDialog(null);
    }
  };

  const profile = contextMenu ? profiles.find(p => p.name === contextMenu.profileName) : null;

  return (
    <>
      <div className="flex flex-col w-[230px] bg-bg-surface border border-border-subtle rounded-ui overflow-hidden shrink-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <span className="text-xs font-semibold text-text-tertiary tracking-wider">PROFILES</span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleExportClick}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
              title="Export Profiles"
            >
              <Upload size={14} />
            </button>
            <button
              onClick={handleImportClick}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
              title="Import Profiles"
            >
              <Download size={14} />
            </button>
            <button
              onClick={handleCreate}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
              title="Create Profile"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 px-2.5 py-1.5 bg-bg-input border border-border-default rounded">
            <Search size={13} className="text-text-disabled shrink-0" />
            <input
              type="text"
              placeholder="Search profiles..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-transparent text-xs text-text-primary placeholder:text-text-disabled outline-none flex-1 min-w-0"
            />
          </div>
        </div>

        {/* Profile List */}
        <div className="flex-1 overflow-y-auto px-1.5 pb-2">
          {filtered.map((p) => (
            <button
              key={p.name}
              onClick={() => send({ type: 'profile:click', payload: { name: p.name } })}
              onContextMenu={(e) => handleContextMenu(e, p.name)}
              className={`w-full flex items-center gap-2 px-2.5 py-2 rounded text-left transition-colors mb-0.5 ${
                p.isActive
                  ? 'bg-bg-elevated'
                  : 'hover:bg-bg-card'
              }`}
            >
              {p.isActive && (
                <div className="w-[3px] h-4 rounded-sm bg-accent-solid shrink-0 -ml-1" />
              )}

              <span
                className={`text-ui flex-1 min-w-0 truncate ${
                  p.isActive
                    ? 'text-accent font-semibold'
                    : 'text-text-primary'
                }`}
              >
                {p.name}
              </span>

              {p.hasWindowTarget && (
                <span title="Window target set">
                  <Crosshair size={11} className="shrink-0 text-text-tertiary" />
                </span>
              )}

              {p.hotkey && (
                <span className="shrink-0 px-1.5 py-0.5 rounded text-[11px] font-mono bg-hotkey-bg border border-hotkey-border text-hotkey-fg">
                  {p.hotkey}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[180px] py-1 bg-bg-card border border-border-default rounded-md shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => handleRename(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Pencil size={13} className="text-text-tertiary" />
            Rename
          </button>
          <button
            onClick={() => handleOpenFolder(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <FolderOpen size={13} className="text-text-tertiary" />
            Open Folder
          </button>
          <button
            onClick={() => handleAssignHotkey(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Key size={13} className="text-text-tertiary" />
            {profile?.hotkey ? 'Change Hotkey' : 'Assign Hotkey'}
          </button>
          {profile?.hotkey && (
            <button
              onClick={() => handleRemoveHotkey(contextMenu.profileName)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <KeyRound size={13} className="text-text-tertiary" />
              Remove Hotkey
            </button>
          )}
          <button
            onClick={() => handleSetWindowTarget(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Crosshair size={13} className="text-text-tertiary" />
            {profile?.hasWindowTarget ? 'Edit Target Window' : 'Set Target Window'}
          </button>
          {profile?.hasWindowTarget && (
            <button
              onClick={() => handleRemoveWindowTarget(contextMenu.profileName)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <Crosshair size={13} className="text-text-tertiary" />
              Remove Target Window
            </button>
          )}
          <div className="my-1 border-t border-border-subtle" />
          <button
            onClick={() => handleDelete(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-recording hover:bg-bg-elevated transition-colors"
          >
            <Trash2 size={13} />
            Delete
          </button>
        </div>
      )}

      {/* Create Dialog */}
      {showCreateDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[340px] bg-bg-card border border-border-default rounded-lg p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Create Profile</h3>
            <input
              ref={dialogInputRef}
              type="text"
              value={dialogValue}
              onChange={(e) => setDialogValue(e.target.value)}
              onKeyDown={(e) => handleDialogKeyDown(e, confirmCreate)}
              placeholder="Profile name..."
              className="w-full h-9 px-3 text-sm text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowCreateDialog(false)}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmCreate}
                className="px-4 py-1.5 text-xs text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Dialog */}
      {showRenameDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[340px] bg-bg-card border border-border-default rounded-lg p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Rename Profile</h3>
            <input
              ref={dialogInputRef}
              type="text"
              value={dialogValue}
              onChange={(e) => setDialogValue(e.target.value)}
              onKeyDown={(e) => handleDialogKeyDown(e, confirmRename)}
              placeholder="New name..."
              className="w-full h-9 px-3 text-sm text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowRenameDialog(null)}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmRename}
                className="px-4 py-1.5 text-xs text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors"
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[340px] bg-bg-card border border-border-default rounded-lg p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Delete Profile</h3>
            <p className="text-sm text-text-secondary">
              Delete profile <span className="text-text-primary font-medium">'{showDeleteConfirm}'</span>?
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowDeleteConfirm(null)}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-1.5 text-xs text-white bg-recording hover:bg-recording/80 rounded transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Hotkey Dialog */}
      {showHotkeyDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[340px] bg-bg-card border border-border-default rounded-lg p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Assign Hotkey</h3>
            <p className="text-xs text-text-secondary mb-3">
              Press a key combination for <span className="text-text-primary font-medium">'{showHotkeyDialog}'</span>
            </p>
            <input
              ref={hotkeyInputRef}
              type="text"
              readOnly
              value={hotkeyCapture}
              onKeyDown={handleHotkeyCapture}
              className="w-full h-9 px-3 text-sm font-mono text-accent bg-bg-input border border-accent-solid rounded text-center outline-none"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowHotkeyDialog(null)}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmHotkey}
                disabled={hotkeyCapture === '...'}
                className="px-4 py-1.5 text-xs text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-40"
              >
                Assign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export Profiles Dialog */}
      {showExportDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[340px] bg-bg-card border border-border-default rounded-lg p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Export Profiles</h3>
            <p className="text-xs text-text-secondary mb-3">Select profiles to export:</p>

            <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-elevated cursor-pointer border-b border-border-subtle mb-1">
              <input
                type="checkbox"
                checked={allExportSelected}
                onChange={toggleExportSelectAll}
                className="accent-[#0078D4]"
              />
              <span className="text-xs font-medium text-text-secondary">Select All</span>
            </label>

            <div className="max-h-[200px] overflow-y-auto">
              {profiles.map(p => (
                <label
                  key={p.name}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-elevated cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={!!exportSelection[p.name]}
                    onChange={() => toggleExportProfile(p.name)}
                    className="accent-[#0078D4]"
                  />
                  <span className="text-xs text-text-primary truncate">{p.name}</span>
                </label>
              ))}
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowExportDialog(false)}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmExport}
                disabled={!Object.values(exportSelection).some(v => v)}
                className="px-4 py-1.5 text-xs text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-40"
              >
                Export
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Window Target Dialog */}
      {showWindowTargetDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[380px] bg-bg-card border border-border-default rounded-lg p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Set Target Window</h3>
            <p className="text-xs text-text-secondary mb-4">
              Profile hotkey for <span className="text-text-primary font-medium">'{showWindowTargetDialog}'</span> will only fire when the target window is in focus.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-text-tertiary mb-1">Process Name</label>
                <input
                  type="text"
                  value={targetProcessName}
                  onChange={(e) => setTargetProcessName(e.target.value)}
                  placeholder="e.g. chrome.exe"
                  className="w-full h-8 px-3 text-xs text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
                />
              </div>
              <div>
                <label className="block text-xs text-text-tertiary mb-1">
                  Window Title
                  {titleMatchMode === 'contains' ? ' (partial match)' : ' (regex)'}
                </label>
                <input
                  type="text"
                  value={targetWindowTitle}
                  onChange={(e) => setTargetWindowTitle(e.target.value)}
                  placeholder={titleMatchMode === 'contains' ? 'e.g. Notepad' : 'e.g. (Crisp|Zendesk)'}
                  className="w-full h-8 px-3 text-xs text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
                />
                <div className="flex items-center gap-1.5 mt-1.5">
                  <button
                    onClick={() => setTitleMatchMode('contains')}
                    className={`px-2 py-0.5 text-[11px] rounded border transition-colors ${
                      titleMatchMode === 'contains'
                        ? 'bg-accent-solid/15 border-accent-solid/40 text-accent'
                        : 'bg-transparent border-border-default text-text-tertiary hover:text-text-secondary'
                    }`}
                  >
                    Contains
                  </button>
                  <button
                    onClick={() => setTitleMatchMode('regex')}
                    className={`px-2 py-0.5 text-[11px] rounded border transition-colors ${
                      titleMatchMode === 'regex'
                        ? 'bg-accent-solid/15 border-accent-solid/40 text-accent'
                        : 'bg-transparent border-border-default text-text-tertiary hover:text-text-secondary'
                    }`}
                  >
                    Regex
                  </button>
                </div>
              </div>
            </div>

            <button
              onClick={handleDetectWindow}
              disabled={detectCountdown !== null && detectCountdown > 0}
              className="mt-3 w-full h-8 text-xs text-accent border border-accent-solid/40 rounded hover:bg-accent-solid/10 transition-colors disabled:opacity-50"
            >
              {detectCountdown !== null && detectCountdown > 0
                ? `Detecting in ${detectCountdown}s... Switch to target window now`
                : 'Detect from Foreground Window (3s delay)'}
            </button>

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowWindowTargetDialog(null)}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmWindowTarget}
                disabled={!targetProcessName.trim() && !targetWindowTitle.trim()}
                className="px-4 py-1.5 text-xs text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-40"
              >
                Set Target
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
