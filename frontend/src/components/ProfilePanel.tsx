import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Search, Pencil, Trash2, FolderOpen, Key, KeyRound } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';

interface ContextMenuState {
  x: number;
  y: number;
  profileName: string;
}

export function ProfilePanel() {
  const { profiles } = useAppState();
  const { send } = useBridge();
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState<string | null>(null);
  const [dialogValue, setDialogValue] = useState('');
  const dialogInputRef = useRef<HTMLInputElement>(null);
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
    if (confirm(`Delete profile '${name}'?`)) {
      send({ type: 'profile:delete', payload: { name } });
    }
  };

  const handleOpenFolder = (name: string) => {
    setContextMenu(null);
    send({ type: 'profile:openFolder', payload: { name } });
  };

  const handleRemoveHotkey = (name: string) => {
    setContextMenu(null);
    send({ type: 'profile:removeHotkey', payload: { name } });
  };

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
      <div className="flex flex-col w-[230px] bg-bg-surface border border-border-subtle rounded-md overflow-hidden shrink-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <span className="text-xs font-semibold text-text-tertiary tracking-wider">PROFILES</span>
          <button
            onClick={handleCreate}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
          >
            <Plus size={14} />
          </button>
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
                className={`text-[13px] flex-1 min-w-0 truncate ${
                  p.isActive
                    ? 'text-accent font-semibold'
                    : 'text-text-primary'
                }`}
              >
                {p.name}
              </span>

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
          {profile?.hotkey ? (
            <button
              onClick={() => handleRemoveHotkey(contextMenu.profileName)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <KeyRound size={13} className="text-text-tertiary" />
              Remove Hotkey
            </button>
          ) : (
            <button
              onClick={() => { setContextMenu(null); /* TODO: hotkey assign dialog */ }}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <Key size={13} className="text-text-tertiary" />
              Assign Hotkey
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
    </>
  );
}
