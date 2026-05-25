import { useState, useRef, useEffect, useCallback } from 'react';
import { Search, X, Pencil, Copy, Trash2, FolderOpen, FolderMinus, Keyboard, Crosshair, ArrowLeftRight, Type, Ban, ChevronsLeft, ChevronsRight, ChevronsDownUp, ChevronsUpDown, Pin, PinOff, FolderPlus, FilePlus, ChevronRight, ChevronDown, Palette, ArrowRightFromLine, Zap, Repeat, ArrowUpFromDot, ExternalLink, Info, Hash } from 'lucide-react';
import type { ProfileEntry, ImportPreviewPayload, ImportConflictResolution } from '../bridge/messageTypes';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { KbdTag } from './common/KbdTag';
import { RemovableChip } from './common/RemovableChip';
import { CheckboxBox } from './Checkbox';
import { TargetConfigDialog } from './TargetConfigDialog';
import { SecurityWarningModal } from './SecurityWarningModal';
import { ImportPreviewDialog } from './ImportPreviewDialog';
import { ProfileInfoDialog } from './ProfileInfoDialog';
import { useToast } from '../state/ToastContext';

interface ContextMenuState {
  x: number;
  y: number;
  profileName: string;
}

interface ProfilePanelProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const FOLDER_COLORS = [
  // Blues & purples (neon & vivid)
  '#00FFFF', '#0099FF', '#0066FF', '#6B5BFF', '#BF00FF',
  // Pinks & reds
  '#FF00FF', '#FF1493', '#FF073A', '#FF4500', '#E74856',
  // Oranges & yellows
  '#FF8C00', '#FFB900', '#FFFF00', '#CCFF00', '#39FF14',
  // Greens, teals, neutrals
  '#00CC6A', '#00B7C3', '#FFFFFF', '#8E8E8E', '#444444',
];

export function ProfilePanel({ collapsed = false, onToggleCollapse }: ProfilePanelProps) {
  const { profiles, profileOrder } = useAppState();
  const { send, subscribe } = useBridge();
  const { showToast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [showHotkeyDialog, setShowHotkeyDialog] = useState<string | null>(null);
  const [hotkeyCapture, setHotkeyCapture] = useState('...');
  const [hotkeyTriggerMode, setHotkeyTriggerMode] = useState<'onPress' | 'onRelease' | 'whilePressed' | 'toggle'>('onPress');
  const [showHotstringDialog, setShowHotstringDialog] = useState<string | null>(null);
  const [hotstringValue, setHotstringValue] = useState('');
  const [hotstringInstant, setHotstringInstant] = useState(false);
  // Target Configuration dialogs — the inputs/flags/detection state are now owned by
  // <TargetConfigDialog>. ProfilePanel only tracks which profile/folder is being configured.
  const [showWindowTargetDialog, setShowWindowTargetDialog] = useState<string | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportSelection, setExportSelection] = useState<Record<string, boolean>>({});
  const [exportSearch, setExportSearch] = useState('');
  const [dialogValue, setDialogValue] = useState('');
  const [showCreateFolderDialog, setShowCreateFolderDialog] = useState(false);
  const [folderDialogName, setFolderDialogName] = useState('');
  const [folderDialogColor, setFolderDialogColor] = useState('#60CDFF');
  const [showRenameFolderDialog, setShowRenameFolderDialog] = useState<string | null>(null);
  const [showFolderTargetDialog, setShowFolderTargetDialog] = useState<string | null>(null);
  const [showMoveToFolderMenu, setShowMoveToFolderMenu] = useState<string | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<{ x: number; y: number; folderName: string } | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [showFolderColorPicker, setShowFolderColorPicker] = useState<string | null>(null);
  const [dragProfile, setDragProfile] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // folder name or '__ungrouped__'
  const [dragFolder, setDragFolder] = useState<string | null>(null);
  const [dropFolderIndex, setDropFolderIndex] = useState<number | null>(null);
  const dialogInputRef = useRef<HTMLInputElement>(null);
  const folderDialogInputRef = useRef<HTMLInputElement>(null);
  const hotkeyInputRef = useRef<HTMLInputElement>(null);
  const hotstringInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const folderMenuRef = useRef<HTMLDivElement>(null);

  // Build profile map for quick lookup
  const profileMap = new Map<string, ProfileEntry>();
  profiles.forEach(p => profileMap.set(p.name, p));

  // Search supports two modes detected from the query prefix:
  //   - "#fps"  → tag mode: matches profiles with a tag containing "fps" (substring,
  //              so "#fp" also catches "fps"). Bare "#" shows everything (just typed
  //              the sigil, hasn't entered the tag yet — feels unresponsive otherwise).
  //   - "fps"   → name mode (default): substring match on the profile name.
  // Mode is picked from the leading char so users can switch without a separate UI.
  const trimmedQuery = searchQuery.trim();
  const isTagSearch = trimmedQuery.startsWith('#');
  const tagSearchTerm = isTagSearch ? trimmedQuery.slice(1).toLowerCase() : '';

  const matchesSearch = (entry: ProfileEntry) => {
    if (!searchQuery) return true;
    if (isTagSearch) {
      if (tagSearchTerm === '') return true;
      return !!entry.tags?.some(t => t.toLowerCase().includes(tagSearchTerm));
    }
    return entry.name.toLowerCase().includes(searchQuery.toLowerCase());
  };

  // Build sectioned lists (alphabetically sorted)
  const sortByName = (a: ProfileEntry, b: ProfileEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

  const pinnedProfiles = (profileOrder?.pinned ?? [])
    .filter(n => profileMap.has(n) && matchesSearch(profileMap.get(n)!))
    .map(n => profileMap.get(n)!)
    .sort(sortByName);

  const folderSections = (profileOrder?.folders ?? []).map(f => ({
    ...f,
    profiles: f.items
      .filter(n => profileMap.has(n) && matchesSearch(profileMap.get(n)!))
      .map(n => profileMap.get(n)!)
      .sort(sortByName)
  }));

  // Collect all profiles referenced in profileOrder sections
  const allReferenced = new Set<string>([
    ...(profileOrder?.pinned ?? []),
    ...(profileOrder?.folders ?? []).flatMap(f => f.items),
    ...(profileOrder?.ungroupedOrder ?? [])
  ]);

  // Include any profiles not in any section (handles race condition on startup)
  const ungroupedNames = [
    ...(profileOrder?.ungroupedOrder ?? []),
    ...profiles.filter(p => !allReferenced.has(p.name)).map(p => p.name)
  ];

  const ungroupedProfiles = ungroupedNames
    .filter(n => profileMap.has(n) && matchesSearch(profileMap.get(n)!))
    .map(n => profileMap.get(n)!)
    .sort(sortByName);

  // If searching, show flat filtered list instead of sections. Reuses matchesSearch so
  // #tag mode works here too — was previously a separate name-only filter, which silently
  // broke tag-search by returning the unfiltered list when the prefix didn't match a name.
  const isSearching = searchQuery.length > 0;
  const filtered = isSearching
    ? profiles.filter(matchesSearch)
    : profiles;

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
        setMenuPos(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setContextMenu(null);
        setMenuPos(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [contextMenu]);

  // Adjust context menu position to stay within viewport
  // Renders off-screen first to measure full (unclipped) size, then repositions
  useEffect(() => {
    if (!contextMenu) { setMenuPos(null); return; }
    // Place off-screen so the menu renders at full size without being clipped
    setMenuPos({ x: -9999, y: -9999 });
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu || !menuPos) return;
    // Skip the measurement pass (off-screen render)
    if (menuPos.x === -9999) {
      requestAnimationFrame(() => {
        const el = contextMenuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        let x = contextMenu.x;
        let y = contextMenu.y;
        // If menu would overflow bottom, move it up
        if (y + rect.height > window.innerHeight - 8) {
          y = Math.max(8, contextMenu.y - rect.height);
        }
        // If menu would overflow right, move it left
        if (x + rect.width > window.innerWidth - 8) {
          x = Math.max(8, window.innerWidth - rect.width - 8);
        }
        setMenuPos({ x, y });
      });
    }
  }, [contextMenu, menuPos]);

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

  // Focus hotstring input when dialog opens
  useEffect(() => {
    if (showHotstringDialog && hotstringInputRef.current) {
      hotstringInputRef.current.focus();
    }
  }, [showHotstringDialog]);


  const handleExportClick = () => {
    setExportSelection({});
    setExportSearch('');
    setShowExportDialog(true);
  };

  // ── Import flow state ──
  // The flow is: user clicks Import → C# shows file picker + parses envelope →
  // emits profile:importPreview → we set `importPreview` → render security warning
  // (if requiresAcknowledgement) → render ImportPreviewDialog → user picks profiles →
  // we send profile:confirmImport → C# writes + emits alert + profiles:updated.
  //
  // Two separate state slots so the warning can stand alone (canceling it returns
  // to "nothing pending", not "show the preview anyway"). `pendingPreview` holds the
  // preview during the brief moment the warning is on screen.
  const [securityWarningOpen, setSecurityWarningOpen] = useState(false);
  const [pendingPreview, setPendingPreview] = useState<ImportPreviewPayload | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreviewPayload | null>(null);

  // Info dialog — opened from the profile context menu, edits sharing metadata.
  const [showInfoDialog, setShowInfoDialog] = useState<string | null>(null);

  const handleImportClick = () => {
    send({ type: 'profile:import', payload: {} });
  };

  // Listen for the preview message and route through the warning if needed.
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'profile:importPreview') {
        if (msg.payload.requiresAcknowledgement) {
          setPendingPreview(msg.payload);
          setSecurityWarningOpen(true);
        } else {
          setImportPreview(msg.payload);
        }
      }
    });
  }, [subscribe]);

  const handleSecurityContinue = (dontShowAgain: boolean) => {
    if (dontShowAgain) {
      send({ type: 'settings:acknowledgeImportWarning', payload: {} });
    }
    setSecurityWarningOpen(false);
    if (pendingPreview) {
      setImportPreview(pendingPreview);
      setPendingPreview(null);
    }
  };

  const handleSecurityCancel = () => {
    // Cancelling the warning aborts the whole import. Tell the bridge so the server-side
    // parsed envelope doesn't linger in memory until the next import overwrites it.
    setSecurityWarningOpen(false);
    setPendingPreview(null);
    send({ type: 'profile:cancelImport', payload: {} });
  };

  const handlePreviewConfirm = (
    selectedNames: string[],
    conflictResolutions: Record<string, ImportConflictResolution>
  ) => {
    if (selectedNames.length > 0) {
      send({ type: 'profile:confirmImport', payload: { selectedNames, conflictResolutions } });
    } else {
      // Empty selection with confirm clicked is effectively a cancel — clear server side too.
      send({ type: 'profile:cancelImport', payload: {} });
    }
    setImportPreview(null);
  };

  const handlePreviewCancel = () => {
    // Mirror handleSecurityCancel for the second possible dismissal point.
    setImportPreview(null);
    send({ type: 'profile:cancelImport', payload: {} });
  };

  const handleShowInfo = (name: string) => {
    setContextMenu(null);
    setShowInfoDialog(name);
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

  const toggleExportFolder = (folderItems: string[]) => {
    const allSelected = folderItems.every(n => exportSelection[n]);
    const updated = { ...exportSelection };
    folderItems.forEach(n => { updated[n] = !allSelected; });
    setExportSelection(updated);
  };

  const confirmExport = () => {
    const selectedNames = Object.entries(exportSelection)
      .filter(([, checked]) => checked)
      .map(([name]) => name);
    if (selectedNames.length > 0) {
      send({ type: 'profile:export', payload: { names: selectedNames, includeOrganization: true } });
    }
    setShowExportDialog(false);
  };

  const handleContextMenu = useCallback((e: React.MouseEvent, name: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, profileName: name });
  }, []);

  const handleCreate = useCallback(() => {
    setContextMenu(null);
    setDialogValue('');
    setShowCreateDialog(true);
  }, []);

  // Listen for command palette triggers
  useEffect(() => {
    window.addEventListener('cmd:newprofile', handleCreate);
    return () => window.removeEventListener('cmd:newprofile', handleCreate);
  }, [handleCreate]);

  useEffect(() => {
    const handler = () => {
      setFolderDialogName('');
      setFolderDialogColor('#60CDFF');
      setShowCreateFolderDialog(true);
    };
    window.addEventListener('cmd:newfolder', handler);
    return () => window.removeEventListener('cmd:newfolder', handler);
  }, []);

  const handleRename = (name: string) => {
    setContextMenu(null);
    setDialogValue(name);
    setShowRenameDialog(name);
  };

  const handleDuplicate = (name: string) => {
    setContextMenu(null);
    send({ type: 'profile:duplicate', payload: { name } });
  };

  const handleToggleDisable = (name: string) => {
    setContextMenu(null);
    send({ type: 'profile:toggleDisable', payload: { name } });
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

  // Header-button variant: opens the Profiles directory itself without selecting any file.
  // Works even when no profile is loaded — the user might be looking to manually drop a
  // .json in there, browse what's saved, or back things up.
  const handleOpenProfilesFolder = () => {
    send({ type: 'profile:openFolder', payload: {} });
  };

  const handleAssignHotkey = (name: string) => {
    setContextMenu(null);
    const existing = profiles.find(p => p.name === name);
    // Pre-fill hotkey with existing so user can change just the trigger mode without re-capturing.
    setHotkeyCapture(existing?.hotkey || '...');
    setHotkeyTriggerMode(existing?.triggerMode || 'onPress');
    setShowHotkeyDialog(name);
    // Capture mode (not just suppress): the backend low-level hook composes each keydown
    // and emits it via 'hotkey:captured'. Without this, the WebView2 JS layer never sees
    // Win+letter combos because the Windows Shell intercepts them at OS level first.
    send({ type: 'hotkey:capture', payload: { enabled: true } });
  };

  const handleRemoveHotkey = (name: string) => {
    setContextMenu(null);
    // Snapshot the previous hotkey + trigger mode BEFORE issuing the remove. The Undo
    // re-sends the original assign payload so the round-trip is exact — same hotkey,
    // same trigger mode. If the profile already had no hotkey somehow, we skip the toast.
    const prev = profiles.find(p => p.name === name);
    const prevHotkey = prev?.hotkey ?? null;
    const prevMode = prev?.triggerMode ?? 'onPress';
    send({ type: 'profile:removeHotkey', payload: { name } });
    if (prevHotkey) {
      showToast(`Removed hotkey ${prevHotkey} from "${name}"`, {
        type: 'success',
        action: {
          label: 'Undo',
          onClick: () => send({ type: 'profile:assignHotkey', payload: { name, hotkey: prevHotkey, mode: prevMode } }),
        },
      });
    }
  };

  const handleAssignHotstring = (name: string) => {
    setContextMenu(null);
    const existing = profiles.find(p => p.name === name);
    setHotstringValue(existing?.hotstring ?? '');
    setHotstringInstant(existing?.hotstring ? existing.hotstringInstant : true);
    setShowHotstringDialog(name);
    send({ type: 'hotkey:suppress', payload: { enabled: true } });
  };

  const handleRemoveHotstring = (name: string) => {
    setContextMenu(null);
    const prev = profiles.find(p => p.name === name);
    const prevSeq = prev?.hotstring ?? null;
    const prevInstant = prev?.hotstringInstant ?? true;
    send({ type: 'profile:removeHotstring', payload: { name } });
    if (prevSeq) {
      showToast(`Removed hotstring "${prevSeq}" from "${name}"`, {
        type: 'success',
        action: {
          label: 'Undo',
          onClick: () => send({ type: 'profile:assignHotstring', payload: { name, sequence: prevSeq, instant: prevInstant } }),
        },
      });
    }
  };

  const confirmHotstring = () => {
    const seq = hotstringValue.trim().toLowerCase();
    if (showHotstringDialog && seq.length >= 2) {
      send({
        type: 'profile:assignHotstring',
        payload: { name: showHotstringDialog, sequence: seq, instant: hotstringInstant }
      });
    }
  };

  const handleSetWindowTarget = (name: string) => {
    setContextMenu(null);
    setShowWindowTargetDialog(name);
  };

  // Folder-target remove with Undo. Mirrors handleRemoveWindowTarget; the undo
  // re-sends profile:setFolderWindowTarget with the captured fields. profileOrder.folders
  // is the source of truth for folder metadata in this scope.
  const handleRemoveFolderWindowTarget = (folderName: string) => {
    const folder = profileOrder?.folders?.find(f => f.name === folderName);
    const prevProcess = folder?.windowTargetProcessName ?? '';
    const prevTitle = folder?.windowTargetWindowTitle ?? '';
    const prevMode = folder?.windowTargetTitleMatchMode ?? 'contains';
    const hadTarget = folder?.hasWindowTarget;
    send({ type: 'profile:removeFolderWindowTarget', payload: { folderName } });
    if (hadTarget) {
      const label = prevProcess || prevTitle || 'target';
      showToast(`Removed folder target (${label}) from "${folderName}"`, {
        type: 'success',
        action: {
          label: 'Undo',
          onClick: () => send({
            type: 'profile:setFolderWindowTarget',
            payload: { folderName, processName: prevProcess, windowTitle: prevTitle, titleMatchMode: prevMode },
          }),
        },
      });
    }
  };

  const handleRemoveWindowTarget = (name: string) => {
    setContextMenu(null);
    // Capture all 4 fields needed to reconstruct: process, title, match mode, plus the
    // related coords/focus/geometry flags so the undo restores the exact target the
    // user had (not a stripped-down version). The profile's own values — not effective
    // (folder-inherited) ones — are what we wipe + restore.
    const prev = profiles.find(p => p.name === name);
    const hadOwn = prev?.hasWindowTarget;
    const prevProcess = prev?.windowTargetProcessName ?? '';
    const prevTitle = prev?.windowTargetWindowTitle ?? '';
    const prevMode = prev?.windowTargetTitleMatchMode ?? 'contains';
    const prevRelative = prev?.useRelativeCoordinates ?? false;
    const prevBringFocus = prev?.bringToFocus ?? false;
    const prevRestorePos = prev?.restorePosition ?? false;
    const prevRestoreSize = prev?.restoreSize ?? false;
    send({ type: 'profile:removeWindowTarget', payload: { name } });
    if (hadOwn) {
      const label = prevProcess || prevTitle || 'target';
      showToast(`Removed window target (${label}) from "${name}"`, {
        type: 'success',
        action: {
          label: 'Undo',
          onClick: () => send({
            type: 'profile:setWindowTarget',
            payload: {
              name, processName: prevProcess, windowTitle: prevTitle, titleMatchMode: prevMode,
              relativeCoordinates: prevRelative, bringToFocus: prevBringFocus,
              restorePosition: prevRestorePos, restoreSize: prevRestoreSize,
            },
          }),
        },
      });
    }
  };

  const confirmHotkey = () => {
    if (showHotkeyDialog && hotkeyCapture && hotkeyCapture !== '...') {
      send({ type: 'profile:assignHotkey', payload: { name: showHotkeyDialog, hotkey: hotkeyCapture, mode: hotkeyTriggerMode } });
      // Don't close dialog here — wait for profiles:updated (success) or alert:show (conflict)
    }
  };

  // Disable backend capture mode when hotkey dialog closes. `send` is a stable useCallback
  // from BridgeContext (deps []), so listing it here doesn't cause extra re-runs — only
  // silences exhaustive-deps without changing behaviour.
  useEffect(() => {
    if (!showHotkeyDialog) {
      send({ type: 'hotkey:capture', payload: { enabled: false } });
    }
  }, [showHotkeyDialog, send]);

  // While the hotkey dialog is open, the backend hook composes every keypress and
  // emits the combo here. The JS layer never sees Win+letter combos directly (Shell
  // intercepts), so the backend round-trip is the only way to capture them.
  useEffect(() => {
    if (!showHotkeyDialog) return;
    return subscribe((msg) => {
      if (msg.type === 'hotkey:captured') {
        setHotkeyCapture(msg.payload.combo);
      }
    });
  }, [showHotkeyDialog, subscribe]);

  // Auto-close hotkey dialog when profile list updates (means hotkey was saved successfully)
  useEffect(() => {
    if (!showHotkeyDialog) return;
    return subscribe((msg) => {
      if (msg.type === 'profiles:updated') {
        setShowHotkeyDialog(null);
      }
    });
  }, [showHotkeyDialog, subscribe]);

  // Suppress global hotkeys while hotstring dialog is open. `send` is stable (see note above).
  useEffect(() => {
    if (!showHotstringDialog) {
      send({ type: 'hotkey:suppress', payload: { enabled: false } });
    }
  }, [showHotstringDialog, send]);

  // Auto-close hotstring dialog when profile list updates
  useEffect(() => {
    if (!showHotstringDialog) return;
    return subscribe((msg) => {
      if (msg.type === 'profiles:updated') {
        setShowHotstringDialog(null);
      }
    });
  }, [showHotstringDialog, subscribe]);

  // Window target detection events (windowTarget:detected, windowTarget:detectState) are
  // subscribed by <TargetConfigDialog> itself when one is mounted. Nothing to wire here.

  const confirmCreate = () => {
    const name = dialogValue.trim();
    if (name) {
      send({ type: 'profile:create', payload: { name, folder: selectedFolder || undefined } });
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

  // ── Folder handlers ──
  const handleCreateFolder = () => {
    setFolderDialogName('');
    setFolderDialogColor('#60CDFF');
    setShowCreateFolderDialog(true);
  };

  const confirmCreateFolder = () => {
    const name = folderDialogName.trim();
    if (name) {
      send({ type: 'profile:createFolder', payload: { name, color: folderDialogColor } });
    }
    setShowCreateFolderDialog(false);
  };

  const handleRenameFolder = (folderName: string) => {
    setFolderContextMenu(null);
    setFolderDialogName(folderName);
    setShowRenameFolderDialog(folderName);
  };

  const confirmRenameFolder = () => {
    const newName = folderDialogName.trim();
    if (newName && showRenameFolderDialog && newName !== showRenameFolderDialog) {
      send({ type: 'profile:renameFolder', payload: { oldName: showRenameFolderDialog, newName } });
    }
    setShowRenameFolderDialog(null);
  };

  const handleDeleteFolder = (folderName: string) => {
    setFolderContextMenu(null);
    send({ type: 'profile:deleteFolder', payload: { name: folderName } });
  };

  const handleSetFolderColor = (folderName: string, color: string) => {
    send({ type: 'profile:setFolderColor', payload: { name: folderName, color } });
    setShowFolderColorPicker(null);
    setFolderContextMenu(null);
  };

  const handleToggleFolderCollapse = (folderName: string) => {
    send({ type: 'profile:toggleFolderCollapse', payload: { name: folderName } });
  };

  const handlePinProfile = (name: string) => {
    setContextMenu(null);
    send({ type: 'profile:pin', payload: { name } });
  };

  const handleUnpinProfile = (name: string) => {
    setContextMenu(null);
    send({ type: 'profile:unpin', payload: { name } });
  };

  const handleMoveToFolder = (profileName: string, folderName: string | null) => {
    setContextMenu(null);
    setShowMoveToFolderMenu(null);
    send({ type: 'profile:moveToFolder', payload: { profileName, folderName } });
  };

  const handleFolderContextMenu = (e: React.MouseEvent, folderName: string) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderContextMenu({ x: e.clientX, y: e.clientY, folderName });
  };

  // Close folder context menu on click outside or Escape
  useEffect(() => {
    if (!folderContextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (folderMenuRef.current && !folderMenuRef.current.contains(e.target as Node)) {
        setFolderContextMenu(null);
        setShowFolderColorPicker(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setFolderContextMenu(null);
        setShowFolderColorPicker(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [folderContextMenu]);

  // Focus folder dialog input
  useEffect(() => {
    if ((showCreateFolderDialog || showRenameFolderDialog) && folderDialogInputRef.current) {
      folderDialogInputRef.current.focus();
      folderDialogInputRef.current.select();
    }
  }, [showCreateFolderDialog, showRenameFolderDialog]);

  const isPinned = (name: string) => profileOrder?.pinned?.includes(name) ?? false;

  // Wrapped in useCallback so the drag-effect below can list it as a dep without
  // re-subscribing window listeners on every render — without the memoisation the
  // identity would change on every parent re-render and the effect would re-mount
  // its mousemove/up listeners constantly during a drag.
  const getProfileFolder = useCallback((name: string): string | null => {
    for (const f of profileOrder?.folders ?? []) {
      if (f.items.includes(name)) return f.name;
    }
    return null;
  }, [profileOrder?.folders]);

  // ── Drag & Drop handlers (mouse-based, works in WebView2) ──
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const dragActive = useRef(false);
  const folderRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const ungroupedRef = useRef<HTMLDivElement>(null);
  // Scroll container ref — used to auto-scroll the profile list when dragging near
  // top/bottom edges. Same pattern as ActionTable's DnD: indispensable for long
  // profile lists, otherwise reaching the opposite end mid-drag is impossible.
  const scrollRef = useRef<HTMLDivElement>(null);
  const AUTOSCROLL_ZONE = 40;
  const AUTOSCROLL_MAX_SPEED = 14;
  const autoScrollRaf = useRef<number | null>(null);
  const cursorY = useRef(0);
  // Cursor position in state — drives the floating drag preview chip shared
  // between profile drag (move-to-folder) and folder drag (reorder).
  const [dragCursorPos, setDragCursorPos] = useState<{ x: number; y: number } | null>(null);

  // Auto-scroll loop, shared by both DnD systems. Self-terminates when the cursor
  // leaves the edge zone; canceled on mouseUp / Esc / unmount.
  const tickAutoScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container || (!dragActive.current && !folderDragActiveRef.current)) {
      autoScrollRaf.current = null;
      return;
    }
    const rect = container.getBoundingClientRect();
    const y = cursorY.current;
    let delta = 0;
    if (y < rect.top + AUTOSCROLL_ZONE) {
      const intensity = (rect.top + AUTOSCROLL_ZONE - y) / AUTOSCROLL_ZONE;
      delta = -AUTOSCROLL_MAX_SPEED * Math.min(1, Math.max(0, intensity));
    } else if (y > rect.bottom - AUTOSCROLL_ZONE) {
      const intensity = (y - (rect.bottom - AUTOSCROLL_ZONE)) / AUTOSCROLL_ZONE;
      delta = AUTOSCROLL_MAX_SPEED * Math.min(1, Math.max(0, intensity));
    }
    if (delta !== 0) {
      container.scrollTop += delta;
      autoScrollRaf.current = requestAnimationFrame(tickAutoScroll);
    } else {
      autoScrollRaf.current = null;
    }
  }, []);

  // Forward-declared so tickAutoScroll above can read it before folderDragActive is set up.
  const folderDragActiveRef = useRef(false);

  // Maybe-start the auto-scroll loop if cursor is in an edge zone of the scroll container.
  const maybeKickAutoScroll = useCallback((clientY: number) => {
    if (autoScrollRaf.current !== null) return;
    const container = scrollRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (clientY < rect.top + AUTOSCROLL_ZONE || clientY > rect.bottom - AUTOSCROLL_ZONE) {
      autoScrollRaf.current = requestAnimationFrame(tickAutoScroll);
    }
  }, [tickAutoScroll]);

  // Wraps a state-mutating bridge call in a View Transition when the browser supports
  // it (Chromium 111+, WebView2 recent). Falls back to a plain call otherwise.
  const sendWithTransition = useCallback((msg: Parameters<typeof send>[0]) => {
    const vt = (document as unknown as { startViewTransition?: (cb: () => void | Promise<void>) => unknown }).startViewTransition;
    if (typeof vt === 'function') {
      vt.call(document, () => {
        send(msg);
        return new Promise<void>(resolve => setTimeout(resolve, 50));
      });
    } else {
      send(msg);
    }
  }, [send]);

  const handleProfileMouseDown = (e: React.MouseEvent, profileName: string) => {
    if (e.button !== 0) return; // left click only
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    dragActive.current = false;
    setDragProfile(profileName);
  };

  useEffect(() => {
    if (!dragProfile) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartPos.current) return;
      const dx = e.clientX - dragStartPos.current.x;
      const dy = e.clientY - dragStartPos.current.y;
      // Require 5px movement to start drag
      if (!dragActive.current && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (!dragActive.current) document.body.style.cursor = 'grabbing';
      dragActive.current = true;
      cursorY.current = e.clientY;
      setDragCursorPos({ x: e.clientX, y: e.clientY });

      // Hit-test which folder or ungrouped area the mouse is over
      let foundTarget: string | null = null;
      folderRefs.current.forEach((el, name) => {
        const rect = el.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          foundTarget = name;
        }
      });
      if (!foundTarget && ungroupedRef.current) {
        const rect = ungroupedRef.current.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          foundTarget = '__ungrouped__';
        }
      }
      setDropTarget(foundTarget);
      maybeKickAutoScroll(e.clientY);
    };

    const handleMouseUp = () => {
      if (dragActive.current && dragProfile && dropTarget) {
        const targetFolder = dropTarget === '__ungrouped__' ? null : dropTarget;
        const currentFolder = getProfileFolder(dragProfile);
        if (currentFolder !== targetFolder) {
          sendWithTransition({ type: 'profile:moveToFolder', payload: { profileName: dragProfile, folderName: targetFolder } });
        }
      }
      document.body.style.cursor = '';
      dragStartPos.current = null;
      dragActive.current = false;
      setDragProfile(null);
      setDropTarget(null);
      setDragCursorPos(null);
      if (autoScrollRaf.current !== null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
    };

    // Esc cancels an in-progress profile drag — restores state without moving.
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragActive.current) return;
      e.stopPropagation();
      document.body.style.cursor = '';
      dragStartPos.current = null;
      dragActive.current = false;
      setDragProfile(null);
      setDropTarget(null);
      setDragCursorPos(null);
      if (autoScrollRaf.current !== null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('keydown', handleKeyDown, true);
      if (autoScrollRaf.current !== null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
    };
  }, [dragProfile, dropTarget, sendWithTransition, maybeKickAutoScroll, getProfileFolder]);

  // ── Folder Drag & Drop (reorder folders) ──
  const folderDragStartPos = useRef<{ x: number; y: number } | null>(null);
  // folderDragActive is mirrored to folderDragActiveRef (declared up-front) so
  // the shared tickAutoScroll can read it without re-deriving on each render.
  const folderDragActive = folderDragActiveRef;

  const handleFolderMouseDown = (e: React.MouseEvent, folderName: string) => {
    if (e.button !== 0) return;
    folderDragStartPos.current = { x: e.clientX, y: e.clientY };
    folderDragActive.current = false;
    setDragFolder(folderName);
  };

  useEffect(() => {
    if (!dragFolder) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!folderDragStartPos.current) return;
      const dx = e.clientX - folderDragStartPos.current.x;
      const dy = e.clientY - folderDragStartPos.current.y;
      if (!folderDragActive.current && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (!folderDragActive.current) document.body.style.cursor = 'grabbing';
      folderDragActive.current = true;
      cursorY.current = e.clientY;
      setDragCursorPos({ x: e.clientX, y: e.clientY });

      // Hit-test folder positions to find drop index
      const folders = profileOrder?.folders ?? [];
      let bestIndex: number | null = null;
      folderRefs.current.forEach((el, name) => {
        const idx = folders.findIndex(f => f.name === name);
        if (idx < 0 || name === dragFolder) return;
        const rect = el.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          bestIndex = e.clientY < midY ? idx : idx + 1;
        }
      });
      setDropFolderIndex(bestIndex);
      maybeKickAutoScroll(e.clientY);
    };

    const handleMouseUp = () => {
      if (folderDragActive.current && dragFolder && dropFolderIndex !== null) {
        const folders = [...(profileOrder?.folders ?? [])];
        const fromIdx = folders.findIndex(f => f.name === dragFolder);
        if (fromIdx >= 0 && fromIdx !== dropFolderIndex && fromIdx !== dropFolderIndex - 1) {
          const [moved] = folders.splice(fromIdx, 1);
          const toIdx = dropFolderIndex > fromIdx ? dropFolderIndex - 1 : dropFolderIndex;
          folders.splice(toIdx, 0, moved);
          sendWithTransition({ type: 'profile:reorder', payload: { folders } });
        }
      }
      document.body.style.cursor = '';
      folderDragStartPos.current = null;
      folderDragActive.current = false;
      setDragFolder(null);
      setDropFolderIndex(null);
      setDragCursorPos(null);
      if (autoScrollRaf.current !== null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
    };

    // Esc cancels an in-progress folder drag.
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !folderDragActive.current) return;
      e.stopPropagation();
      document.body.style.cursor = '';
      folderDragStartPos.current = null;
      folderDragActive.current = false;
      setDragFolder(null);
      setDropFolderIndex(null);
      setDragCursorPos(null);
      if (autoScrollRaf.current !== null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('keydown', handleKeyDown, true);
      if (autoScrollRaf.current !== null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
    };
  }, [dragFolder, dropFolderIndex, profileOrder, sendWithTransition, maybeKickAutoScroll, folderDragActive]);

  const handleDialogKeyDown = (e: React.KeyboardEvent, onConfirm: () => void) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setShowCreateDialog(false);
      setShowRenameDialog(null);
      setShowCreateFolderDialog(false);
      setShowRenameFolderDialog(null);
    }
  };

  const profile = contextMenu ? profiles.find(p => p.name === contextMenu.profileName) : null;

  // ── Profile Row Renderer ──
  const renderProfileRow = (p: ProfileEntry) => (
    <div
      key={p.name}
      onMouseDown={(e) => handleProfileMouseDown(e, p.name)}
      onClick={(e) => {
        // Don't fire click if we were dragging
        if (dragActive.current) { e.preventDefault(); return; }
        send({ type: 'profile:click', payload: { name: p.name } }); (e.target as HTMLElement).blur();
      }}
      onContextMenu={(e) => handleContextMenu(e, p.name)}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-left transition-colors outline-none select-none cursor-grab active:cursor-grabbing ${
        dragProfile === p.name && dragActive.current ? 'opacity-50 ' : ''
      }${p.isDisabled ? 'opacity-40 ' : ''}${
        p.isActive
          ? 'bg-bg-elevated'
          : 'hover:bg-bg-card'
      }`}
    >
        {p.isActive && (
          <div className="w-[3px] h-4 rounded-sm bg-accent-solid shrink-0" />
        )}

        {/* App icon — base64 PNG of the effective target's .exe, resolved server-side.
            Sits between the active marker and the name. Two render modes:

            • Own target  → wrapped in a group with a hover ✕ overlay so the user can
              remove the target inline (same affordance the crosshair had before the
              icon took its slot). Full opacity.
            • Inherited from a folder → plain <img>, no ✕, 55 % opacity. Removal has
              to happen from the folder, not the row.

            Null when no target is set or icon extraction failed (UWP host, portable
            apps off PATH) — in that case the crosshair badge to the right renders
            as the fallback (and keeps its own ✕ for the own-target case). */}
        {p.appIconBase64 && p.hasWindowTarget && (
          <RemovableChip
            variant="circle"
            removeTitle={`Remove window target (${p.effectiveTargetProcessName ?? 'target'})`}
            onRemove={(e) => { e.stopPropagation(); handleRemoveWindowTarget(p.name); }}
            className="w-3.5 h-3.5"
          >
            <img
              src={`data:image/png;base64,${p.appIconBase64}`}
              alt=""
              title={p.effectiveTargetProcessName ?? ''}
              className="w-3.5 h-3.5 object-contain pointer-events-none"
            />
          </RemovableChip>
        )}
        {p.appIconBase64 && !p.hasWindowTarget && (
          <img
            src={`data:image/png;base64,${p.appIconBase64}`}
            alt=""
            title={p.effectiveTargetProcessName ?? ''}
            className="w-3.5 h-3.5 shrink-0 object-contain pointer-events-none opacity-55"
          />
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

        {p.hasWindowTarget && !p.appIconBase64 ? (
          // Own target but the icon couldn't be resolved (UWP host, portable not in PATH).
          // Crosshair stays as a "this row IS gated" cue. Removal via hover ✕ overlay.
          <RemovableChip
            variant="circle"
            removeTitle={`Remove window target (${p.windowTargetProcessName || p.windowTargetWindowTitle || 'target'})`}
            onRemove={(e) => { e.stopPropagation(); handleRemoveWindowTarget(p.name); }}
          >
            <span
              data-tip={p.windowTargetProcessName || p.windowTargetWindowTitle || 'Window target set'}
              data-tip-pos="end"
            >
              <Crosshair size={11} className="text-text-tertiary" />
            </span>
          </RemovableChip>
        ) : (!p.appIconBase64 && p.hasEffectiveTarget && p.effectiveTargetSource === 'folder') && (
          // Inherited from folder AND no icon resolved — fall back to the faded crosshair.
          // Removal must happen from the folder, not the row, so no ✕ overlay here.
          <span
            className="shrink-0 opacity-50"
            data-tip={p.effectiveTargetProcessName || p.effectiveTargetWindowTitle || 'Window target'}
            data-tip-pos="end"
          >
            <Crosshair size={11} className="text-text-tertiary" />
          </span>
        )}

        {/* Trigger mode indicator — placed before the hotkey so the visual order
            right-to-left is: hotstring → hotkey → trigger icon → target crosshair.
            Tooltip shows only the mode name; the full description lives in the
            hotkey configuration dialog. */}
        {p.hotkey && p.triggerMode === 'onRelease' && (
          <span data-tip="On Release" data-tip-pos="end" className="shrink-0 text-text-tertiary flex">
            <ArrowUpFromDot size={10} />
          </span>
        )}
        {p.hotkey && p.triggerMode === 'whilePressed' && (
          <span data-tip="While Pressed" data-tip-pos="end" className="shrink-0 text-text-tertiary flex">
            <Zap size={10} />
          </span>
        )}
        {p.hotkey && p.triggerMode === 'toggle' && (
          <span data-tip="Toggle" data-tip-pos="end" className="shrink-0 text-text-tertiary flex">
            <Repeat size={10} />
          </span>
        )}

        {p.hotkey && (
          <RemovableChip
            removeTitle={`Remove hotkey ${p.hotkey}`}
            onRemove={(e) => { e.stopPropagation(); handleRemoveHotkey(p.name); }}
          >
            <KbdTag combo={p.hotkey} />
          </RemovableChip>
        )}

        {p.hotstring && (
          <RemovableChip
            removeTitle={`Remove hotstring "${p.hotstring}"`}
            onRemove={(e) => { e.stopPropagation(); handleRemoveHotstring(p.name); }}
            className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-hotkey-bg border border-hotkey-border text-accent-hover"
          ><span title={p.hotstringInstant ? 'Hotstring (instant)' : 'Hotstring (terminator)'}>
            {p.hotstringInstant ? '\u26A1' : '\u21B5'}{p.hotstring}
            </span>
          </RemovableChip>
        )}
    </div>
  );

  // ── Section Header Renderer ──
  const renderSectionLabel = (label: string) => (
    <div className="px-2.5 pt-2 pb-0.5">
      <span className="text-[10px] font-semibold text-text-disabled tracking-wider uppercase">{label}</span>
    </div>
  );

  return (
    <>
      <div className={`flex flex-col bg-bg-surface border border-border-subtle rounded-ui overflow-hidden shrink-0 transition-[width] duration-200 ${collapsed ? 'w-12' : 'w-[260px]'}`}>
        {collapsed ? (
          <>
            <div className="flex items-center justify-center pt-3 pb-2">
              <button
                onClick={onToggleCollapse}
                className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
                data-tip="Expand" data-tip-pos="right"
              >
                <ChevronsRight size={14} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto flex flex-col items-center gap-1 px-1 pb-2">
              {filtered.map((p) => (
                <button
                  key={p.name}
                  onClick={(e) => { send({ type: 'profile:click', payload: { name: p.name } }); (e.target as HTMLElement).blur(); }}
                  onContextMenu={(e) => handleContextMenu(e, p.name)}
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                    p.isActive ? 'bg-accent-solid text-white' : 'bg-bg-elevated text-text-secondary hover:bg-bg-card'
                  } ${p.isDisabled ? 'opacity-40' : ''}`}
                  title={p.name}
                >
                  {p.name.charAt(0).toUpperCase()}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
        {/* Header — flat row of 6 icon buttons. An earlier draft wrapped them in
            three boxed-group containers mirroring the toolbar redesign, but the
            panel is narrow (~247 px) and the extra padding/borders made the row
            feel crowded for not much semantic gain. The icon swaps + tooltips
            from the same pass DID land. */}
        <div className="flex items-center justify-between px-3 pt-2 pb-1">
          <span className="text-xs font-semibold text-text-tertiary tracking-wider">PROFILES</span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={onToggleCollapse}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
              data-tip="Collapse profiles panel"
            >
              <ChevronsLeft size={14} />
            </button>
            <button
              onClick={handleOpenProfilesFolder}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
              data-tip="Open profiles folder"
            >
              <ExternalLink size={14} />
            </button>
            <button
              onClick={handleExportClick}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
              data-tip="Import or export profiles"
            >
              <ArrowLeftRight size={14} />
            </button>
            <button
              onClick={handleCreateFolder}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
              data-tip="New folder"
            >
              <FolderPlus size={14} />
            </button>
            <button
              onClick={handleCreate}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
              data-tip="New profile" data-tip-pos="end"
            >
              <FilePlus size={14} />
            </button>
          </div>
        </div>

        {/* Search — supports "#tag" prefix to filter by tag instead of name */}
        <div className="px-3 pb-1.5">
          <div className={`flex items-center gap-2 px-2.5 py-1.5 bg-bg-input border rounded transition-colors ${
            isTagSearch ? 'border-accent-solid/50' : 'border-border-default'
          }`}>
            {isTagSearch ? (
              // Visual cue that tag mode is active — distinguishes #fps from "literal hash".
              <Hash size={13} className="text-accent shrink-0" />
            ) : (
              <Search size={13} className="text-text-disabled shrink-0" />
            )}
            <input
              type="text"
              placeholder="Search profiles..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-transparent text-xs text-text-primary placeholder:text-text-disabled outline-none flex-1 min-w-0"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="text-text-disabled hover:text-text-secondary transition-colors shrink-0"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Profile List - Sectioned */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-1.5 pb-1">
          {isSearching ? (
            // Flat search results
            filtered.map(renderProfileRow)
          ) : (
            <>
              {/* Pinned Section */}
              {pinnedProfiles.length > 0 && (
                <>
                  {renderSectionLabel('Pinned')}
                  {pinnedProfiles.map(renderProfileRow)}
                </>
              )}

              {/* Folder Sections */}
              {folderSections.map((folder, folderIdx) => {
                const hasVisibleProfiles = folder.profiles.length > 0;
                const isDragOver = dropTarget === folder.name && dragProfile !== null;
                const isFolderDragging = dragFolder === folder.name && folderDragActive.current;
                // Visually mark the folder as disabled when every profile inside is disabled,
                // matching the dimmed look of disabled profiles. Empty folders stay normal.
                const folderAllDisabled = folder.items.length > 0
                  && folder.items.every(n => profileMap.get(n)?.isDisabled);
                const showDropBefore = dragFolder && dropFolderIndex === folderIdx && dropFolderIndex !== (profileOrder?.folders ?? []).findIndex(f => f.name === dragFolder);
                const showDropAfter = dragFolder && dropFolderIndex === folderIdx + 1 && dropFolderIndex !== (profileOrder?.folders ?? []).findIndex(f => f.name === dragFolder) && dropFolderIndex !== (profileOrder?.folders ?? []).findIndex(f => f.name === dragFolder) + 1;
                return (
                  <div key={folder.name}>
                    {showDropBefore && (
                      <div className="flex items-center gap-1 mx-1 my-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-accent-solid shrink-0" />
                        <div
                          className="flex-1 h-[3px] bg-accent-solid rounded-full"
                          style={{ boxShadow: '0 0 6px color-mix(in srgb, var(--color-accent) 60%, transparent)' }}
                        />
                        <div className="w-1.5 h-1.5 rounded-full bg-accent-solid shrink-0" />
                      </div>
                    )}
                    <div
                      ref={(el) => { if (el) folderRefs.current.set(folder.name, el); else folderRefs.current.delete(folder.name); }}
                      className={`rounded transition-colors ${isDragOver ? 'bg-accent-solid/20 ring-2 ring-accent-solid/50' : ''} ${isFolderDragging ? 'opacity-50' : ''}`}
                    >
                      <div
                        className={`w-full flex items-center gap-1.5 px-2 py-1.5 mt-1 rounded text-left hover:bg-bg-card transition-colors group cursor-grab active:cursor-grabbing select-none ${selectedFolder === folder.name ? 'bg-bg-card ring-1 ring-accent-solid/30' : ''}`}
                        onMouseDown={(e) => handleFolderMouseDown(e, folder.name)}
                        onClick={() => { if (!folderDragActive.current) setSelectedFolder(prev => prev === folder.name ? null : folder.name); }}
                        onContextMenu={(e) => handleFolderContextMenu(e, folder.name)}
                      >
                        <span
                          style={{ color: folder.color }}
                          className="shrink-0 cursor-pointer hover:opacity-70"
                          onClick={(e) => { e.stopPropagation(); if (!folderDragActive.current) handleToggleFolderCollapse(folder.name); }}
                        >
                          {folder.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                        </span>
                        <FolderOpen size={12} style={{ color: folder.color }} className={`shrink-0 ${folderAllDisabled ? 'opacity-40' : ''}`} />
                        {/* Folder-target app icon — same resolution rules as the profile row.
                            Wrapped in a group so hover reveals a ✕ overlay that removes the
                            folder's target inline, matching the crosshair fallback below. */}
                        {folder.appIconBase64 && (
                          <RemovableChip
                            variant="circle"
                            removeTitle={`Remove folder target (${folder.windowTargetProcessName ?? 'target'})`}
                            onRemove={(e) => { e.stopPropagation(); handleRemoveFolderWindowTarget(folder.name); }}
                            className={`w-3.5 h-3.5 ${folderAllDisabled ? 'opacity-40' : ''}`}
                          >
                            <img
                              src={`data:image/png;base64,${folder.appIconBase64}`}
                              alt=""
                              title={folder.windowTargetProcessName ?? ''}
                              className="w-3.5 h-3.5 object-contain pointer-events-none"
                            />
                          </RemovableChip>
                        )}
                        <span className={`text-xs font-medium flex-1 truncate ${folderAllDisabled ? 'text-text-disabled' : 'text-text-secondary'}`}>{folder.name}</span>
                        {folder.hasWindowTarget && !folder.appIconBase64 && (
                          <RemovableChip
                            variant="circle"
                            removeTitle={`Remove folder target (${folder.windowTargetProcessName || folder.windowTargetWindowTitle || 'target'})`}
                            onRemove={(e) => { e.stopPropagation(); handleRemoveFolderWindowTarget(folder.name); }}
                          >
                            <span
                              data-tip={folder.windowTargetProcessName || folder.windowTargetWindowTitle || 'Window Target'}
                              data-tip-pos="end"
                            >
                              <Crosshair size={10} className="text-text-tertiary" />
                            </span>
                          </RemovableChip>
                        )}
                      </div>
                      {!folder.collapsed && hasVisibleProfiles && (
                        <div className="ml-3 pl-1.5" style={{ borderLeft: `2px solid ${folder.color}40` }}>
                          {folder.profiles.map(renderProfileRow)}
                        </div>
                      )}
                    </div>
                    {showDropAfter && (
                      <div className="flex items-center gap-1 mx-1 my-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-accent-solid shrink-0" />
                        <div
                          className="flex-1 h-[3px] bg-accent-solid rounded-full"
                          style={{ boxShadow: '0 0 6px color-mix(in srgb, var(--color-accent) 60%, transparent)' }}
                        />
                        <div className="w-1.5 h-1.5 rounded-full bg-accent-solid shrink-0" />
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Ungrouped Section */}
              <div
                ref={ungroupedRef}
                className={`rounded transition-colors ${dropTarget === '__ungrouped__' && dragProfile ? 'bg-accent-solid/20 ring-2 ring-accent-solid/50' : ''}`}
              >
                {ungroupedProfiles.length > 0 && (profileOrder?.pinned?.length > 0 || profileOrder?.folders?.length > 0) && (
                  renderSectionLabel('Ungrouped')
                )}
                {ungroupedProfiles.map(renderProfileRow)}
              </div>
            </>
          )}
        </div>
          </>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && menuPos && (
        // Profile row context menu — five groups ordered by setup → state →
        // occasional → destructive, so reading top-to-bottom matches the
        // "create a profile and configure it" flow:
        //
        //   - Identity     → Rename · Move to folder ▸
        //   - Triggers     → Assign hotkey… · Assign hotstring… · Window target…
        //   - State        → Pin / Unpin · Disable / Enable
        //   - Advanced     → Duplicate · Open in Explorer
        //   - Destructive  → Delete
        //
        // Previous layout put State first and buried Triggers under it; the swap
        // brings the most-relevant-after-create items (rename / hotkey) to the
        // top, and isolates rarely-used items (Duplicate, Open in Explorer) in
        // a dedicated Advanced bucket so they don't crowd the prime real estate.
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[180px] py-1 bg-bg-card border border-border-default rounded-md shadow-lg"
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          {/* ── Identity ── */}
          <button
            onClick={() => handleRename(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Pencil size={13} className="text-text-tertiary" />
            Rename
          </button>
          <button
            onClick={() => handleShowInfo(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Info size={13} className="text-text-tertiary" />
            Edit info…
          </button>

          {/* Move to Folder submenu */}
          <div
            className="relative"
            onMouseEnter={() => setShowMoveToFolderMenu(contextMenu.profileName)}
            onMouseLeave={() => setShowMoveToFolderMenu(null)}
          >
            <button
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <ArrowRightFromLine size={13} className="text-text-tertiary" />
              Move to folder
              <ChevronRight size={11} className="ml-auto text-text-tertiary" />
            </button>
            {showMoveToFolderMenu === contextMenu.profileName && (
              <div className="absolute left-full top-0 bg-transparent" style={{ paddingLeft: '4px' }}>
              <div className="py-1 bg-bg-card border border-border-default rounded-md shadow-lg z-[60] whitespace-nowrap">
                {(profileOrder?.folders ?? []).map(f => (
                  <button
                    key={f.name}
                    onClick={() => handleMoveToFolder(contextMenu.profileName, f.name)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-bg-elevated transition-colors ${
                      getProfileFolder(contextMenu.profileName) === f.name ? 'text-accent' : 'text-text-primary'
                    }`}
                  >
                    <FolderOpen size={11} style={{ color: f.color }} />
                    {f.name}
                  </button>
                ))}
                {(profileOrder?.folders ?? []).length > 0 && getProfileFolder(contextMenu.profileName) && (
                  <>
                    <div className="my-1 border-t border-border-subtle" />
                    <button
                      onClick={() => handleMoveToFolder(contextMenu.profileName, null)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
                    >
                      <FolderMinus size={11} className="text-text-tertiary" />
                      Remove from folder
                    </button>
                  </>
                )}
                {(profileOrder?.folders ?? []).length === 0 && (
                  <span className="block px-3 py-1.5 text-xs text-text-disabled">No folders</span>
                )}
              </div>
              </div>
            )}
          </div>

          <div className="my-1 border-t border-border-subtle" />

          {/* ── Triggers — what makes the profile fire ──
              Trailing ellipsis on the three labels follows the standard
              convention that the label opens a dialog rather than acting
              inline. */}
          <button
            onClick={() => handleAssignHotkey(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Keyboard size={13} className="text-text-tertiary" />
            Assign hotkey…
          </button>
          <button
            onClick={() => handleAssignHotstring(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Type size={13} className="text-text-tertiary" />
            Assign hotstring…
          </button>
          <button
            onClick={() => handleSetWindowTarget(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Crosshair size={13} className="text-text-tertiary" />
            Window target…
          </button>

          <div className="my-1 border-t border-border-subtle" />

          {/* ── State ── */}
          {isPinned(contextMenu.profileName) ? (
            <button
              onClick={() => handleUnpinProfile(contextMenu.profileName)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <PinOff size={13} className="text-text-tertiary" />
              Unpin
            </button>
          ) : (
            <button
              onClick={() => handlePinProfile(contextMenu.profileName)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <Pin size={13} className="text-text-tertiary" />
              Pin
            </button>
          )}

          <button
            onClick={() => handleToggleDisable(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Ban size={13} className="text-text-tertiary" />
            {profile?.isDisabled ? 'Enable' : 'Disable'}
          </button>

          <div className="my-1 border-t border-border-subtle" />

          {/* ── Advanced — low-frequency / debug entry points ──
              Duplicate is occasional ("make a variant of this profile"); Open
              in Explorer is debug-tier ("show me the .json on disk"). Both used
              to sit between Rename and Triggers, where they crowded out the
              actions the user actually came here for. */}
          <button
            onClick={() => handleDuplicate(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Copy size={13} className="text-text-tertiary" />
            Duplicate
          </button>
          <button
            onClick={() => { handleOpenFolder(contextMenu.profileName); setContextMenu(null); }}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <ExternalLink size={13} className="text-text-tertiary" />
            Open in Explorer
          </button>

          <div className="my-1 border-t border-border-subtle" />

          {/* ── Destructive ── */}
          <button
            onClick={() => handleDelete(contextMenu.profileName)}
            className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-recording hover:bg-bg-elevated transition-colors"
          >
            <span className="flex items-center gap-2.5">
              <Trash2 size={13} />
              Delete
            </span>
            <span className="text-[10px] text-text-disabled font-mono">Del</span>
          </button>
        </div>
      )}

      {/* Folder Context Menu */}
      {folderContextMenu && (
        // Folder context menu — grouped top-to-bottom by scope and time:
        //   - Identity (apply to this folder itself)     → Rename · Color ▸
        //   - Triggers (configure children, setup-time)  → Window target…
        //   - State (batch state flip on children)       → Disable / Enable all
        //   - View (apply to ALL folders)                → Collapse / Expand all folders
        //   - Destructive                                 → Delete folder
        // State got its own block (was bundled into Triggers) so the menu's
        // semantic blocks match the profile context menu's structure:
        // Identity → Triggers → State → … → Delete.
        // Folders are virtual organisation buckets (not file-system folders),
        // so they have no "Open in Explorer" / "Duplicate" equivalent.
        <div
          ref={folderMenuRef}
          className="fixed z-50 min-w-[160px] py-1 bg-bg-card border border-border-default rounded-md shadow-lg"
          style={{ left: folderContextMenu.x, top: folderContextMenu.y }}
        >
          {/* ── Identity (this folder) ── */}
          <button
            onClick={() => handleRenameFolder(folderContextMenu.folderName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Pencil size={13} className="text-text-tertiary" />
            Rename
          </button>
          <div
            className="relative"
            onMouseEnter={() => setShowFolderColorPicker(folderContextMenu.folderName)}
            onMouseLeave={() => setShowFolderColorPicker(null)}
          >
            <button
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <Palette size={13} className="text-text-tertiary" />
              Color
              <ChevronRight size={11} className="ml-auto text-text-tertiary" />
            </button>
            {showFolderColorPicker === folderContextMenu.folderName && (
              <div className="absolute left-full top-0 min-w-0 bg-transparent" style={{ paddingLeft: '4px' }}>
              <div className="p-2.5 bg-bg-card border border-border-default rounded-md shadow-lg z-[60]">
                <div className="flex flex-wrap gap-1.5" style={{ width: '156px' }}>
                  {FOLDER_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => handleSetFolderColor(folderContextMenu.folderName, c)}
                      className="w-[26px] h-[26px] rounded-full border-2 hover:scale-110 transition-transform"
                      style={{ backgroundColor: c, borderColor: (profileOrder?.folders ?? []).find(f => f.name === folderContextMenu.folderName)?.color === c ? 'white' : 'transparent' }}
                      title={c}
                    />
                  ))}
                </div>
              </div>
              </div>
            )}
          </div>

          <div className="my-1 border-t border-border-subtle" />

          {/* ── Triggers (this folder's children) ──
              "Window target…" is inherited by every profile inside the folder
              unless that profile overrides it. Setup-time configuration of how
              children fire. The trailing ellipsis indicates a dialog opens
              (matches the profile menu's "Assign hotkey…" etc). */}
          <button
            onClick={() => {
              setShowFolderTargetDialog(folderContextMenu.folderName);
              setFolderContextMenu(null);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Crosshair size={13} className="text-text-tertiary" />
            Window target…
          </button>

          <div className="my-1 border-t border-border-subtle" />

          {/* ── State (batch operation on this folder's children) ──
              Separated from Triggers because Disable-all is a run-time state
              flip, not a configure-once trigger. Matches how the profile menu
              keeps Pin / Disable in its own State block. */}
          <button
            onClick={() => {
              send({ type: 'profile:toggleFolderDisable', payload: { name: folderContextMenu.folderName } });
              setFolderContextMenu(null);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Ban size={13} className="text-text-tertiary" />
            {(() => {
              const folder = (profileOrder?.folders ?? []).find(f => f.name === folderContextMenu.folderName);
              const items = folder?.items ?? [];
              const allDisabled = items.length > 0 && items.every(n => profiles.find(p => p.name === n)?.isDisabled);
              return allDisabled ? 'Enable all' : 'Disable all';
            })()}
          </button>

          <div className="my-1 border-t border-border-subtle" />

          {/* ── View (all folders) ──
              Label flips Collapse/Expand based on the majority state, mirroring
              the "Disable all / Enable all" pattern above. Hidden when there's
              only one folder (the per-folder chevron in the row already handles
              that case — a bulk operation on a single item is just noise). */}
          {(profileOrder?.folders ?? []).length > 1 && (() => {
            const folders = profileOrder?.folders ?? [];
            // "Collapse all" if ANY folder is currently expanded — collapsing has
            // priority because users typically hit this to clean up a busy tree.
            // Only flip to "Expand all" when every folder is already collapsed.
            const anyExpanded = folders.some(f => !f.collapsed);
            const targetCollapsed = anyExpanded; // collapse if any expanded, otherwise expand
            const Icon = anyExpanded ? ChevronsDownUp : ChevronsUpDown;
            const label = anyExpanded ? 'Collapse all folders' : 'Expand all folders';
            return (
              <>
                <button
                  onClick={() => {
                    send({ type: 'profile:setAllFoldersCollapsed', payload: { collapsed: targetCollapsed } });
                    setFolderContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
                >
                  <Icon size={13} className="text-text-tertiary" />
                  {label}
                </button>
                <div className="my-1 border-t border-border-subtle" />
              </>
            );
          })()}

          {/* ── Destructive ── */}
          <button
            onClick={() => handleDeleteFolder(folderContextMenu.folderName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-recording hover:bg-bg-elevated transition-colors"
          >
            <Trash2 size={13} />
            Delete folder
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onKeyDown={(e) => { if (e.key === 'Enter') confirmDelete(); else if (e.key === 'Escape') setShowDeleteConfirm(null); }}>
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
                autoFocus
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
              className="w-full h-9 px-3 text-sm font-mono text-accent bg-bg-input border border-accent-solid rounded text-center outline-none"
            />

            {/* Trigger Mode */}
            <div className="mt-4">
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1.5">Trigger Mode</div>
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  { id: 'onPress', label: 'On Press', help: 'Fires once when the key is pressed down.' },
                  { id: 'onRelease', label: 'On Release', help: 'Fires once when the key is released.' },
                  { id: 'whilePressed', label: 'While Pressed', help: 'Runs in infinite loop while held. Stops on release.' },
                  { id: 'toggle', label: 'Toggle', help: "Press to start, press again to stop. Uses the profile's loop settings." },
                ] as const).map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setHotkeyTriggerMode(opt.id)}
                    className={`h-7 text-[11px] rounded border transition-colors ${
                      hotkeyTriggerMode === opt.id
                        ? 'bg-accent-solid/15 border-accent-solid/40 text-accent'
                        : 'bg-transparent border-border-default text-text-tertiary hover:text-text-secondary hover:border-border-strong'
                    }`}
                    title={opt.help}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-[10px] text-text-tertiary leading-tight min-h-[14px]">
                {hotkeyTriggerMode === 'onPress' && 'Fires once when the key is pressed down.'}
                {hotkeyTriggerMode === 'onRelease' && 'Fires once when the key is released.'}
                {hotkeyTriggerMode === 'whilePressed' && 'Runs in infinite loop while held. Stops on release.'}
                {hotkeyTriggerMode === 'toggle' && "Press to start, press again to stop. Uses the profile's loop settings."}
              </div>
            </div>

            <div className="flex items-center mt-4">
              {profiles.find(p => p.name === showHotkeyDialog)?.hotkey && (
                <button
                  onClick={() => { handleRemoveHotkey(showHotkeyDialog!); setShowHotkeyDialog(null); }}
                  className="px-4 py-1.5 text-xs text-recording hover:text-recording/80 bg-bg-elevated rounded transition-colors"
                >
                  Remove
                </button>
              )}
              <div className="flex-1" />
              <div className="flex gap-2">
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
        </div>
      )}

      {/* Assign Hotstring Dialog */}
      {showHotstringDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[340px] bg-bg-card border border-border-default rounded-lg p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Assign Hotstring</h3>
            <p className="text-xs text-text-secondary mb-3">
              Type a character sequence for <span className="text-text-primary font-medium">'{showHotstringDialog}'</span>
            </p>
            <input
              ref={hotstringInputRef}
              type="text"
              value={hotstringValue}
              onChange={(e) => setHotstringValue(e.target.value.replace(/[^a-zA-Z0-9\-./,;=]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); confirmHotstring(); }
                else if (e.key === 'Escape') { e.preventDefault(); setShowHotstringDialog(null); }
              }}
              placeholder="e.g. /id"
              maxLength={32}
              className="w-full h-9 px-3 text-sm font-mono text-accent bg-bg-input border border-accent-solid rounded outline-none"
            />
            <p className="text-[11px] text-text-tertiary mt-1.5">
              Min 2 characters.
            </p>

            <button
              type="button"
              onClick={() => setHotstringInstant(!hotstringInstant)}
              className="flex items-center gap-2 mt-3 cursor-pointer text-left"
            >
              <CheckboxBox checked={hotstringInstant} />
              <span className="text-xs text-text-secondary">Instant trigger</span>
              <span className="text-[11px] text-text-tertiary">(no Enter/Space/Tab needed)</span>
            </button>

            <div className="flex items-center mt-4">
              {profiles.find(p => p.name === showHotstringDialog)?.hotstring && (
                <button
                  onClick={() => { handleRemoveHotstring(showHotstringDialog!); setShowHotstringDialog(null); }}
                  className="px-4 py-1.5 text-xs text-recording hover:text-recording/80 bg-bg-elevated rounded transition-colors"
                >
                  Remove
                </button>
              )}
              <div className="flex-1" />
              <div className="flex gap-2">
                <button
                  onClick={() => setShowHotstringDialog(null)}
                  className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmHotstring}
                  disabled={hotstringValue.trim().length < 2}
                  className="px-4 py-1.5 text-xs text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-40"
                >
                  Assign
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Export Profiles Dialog */}
      {showExportDialog && (() => {
        const matchesExport = (name: string) => !exportSearch || name.toLowerCase().includes(exportSearch.toLowerCase());
        const folders = (profileOrder?.folders ?? []).filter(f => f.items.some(matchesExport));
        const ungrouped = profiles.filter(p => {
          const inFolder = (profileOrder?.folders ?? []).some(f => f.items.includes(p.name));
          const isPinned = (profileOrder?.pinned ?? []).includes(p.name) && !inFolder;
          return !inFolder && !isPinned && matchesExport(p.name);
        });
        const pinned = (profileOrder?.pinned ?? []).filter(n => {
          const inFolder = (profileOrder?.folders ?? []).some(f => f.items.includes(n));
          return !inFolder && matchesExport(n);
        });
        const selectedCount = Object.values(exportSelection).filter(v => v).length;

        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[360px] bg-bg-card border border-border-default rounded-lg p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Import / Export</h3>

            {/* Search */}
            <div className="flex items-center gap-2 px-2.5 py-1.5 mb-2 bg-bg-input border border-border-default rounded">
              <Search size={12} className="text-text-disabled shrink-0" />
              <input
                type="text"
                placeholder="Filter profiles..."
                value={exportSearch}
                onChange={(e) => setExportSearch(e.target.value)}
                className="bg-transparent text-xs text-text-primary placeholder:text-text-disabled outline-none flex-1 min-w-0"
              />
              {exportSearch && (
                <button onClick={() => setExportSearch('')} className="text-text-disabled hover:text-text-secondary transition-colors shrink-0">
                  <X size={11} />
                </button>
              )}
            </div>

            {/* Select All */}
            <button
              type="button"
              onClick={toggleExportSelectAll}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-elevated cursor-pointer border-b border-border-subtle mb-1 text-left"
            >
              <CheckboxBox checked={allExportSelected} />
              <span className="text-xs font-medium text-text-secondary">Select All</span>
              <span className="ml-auto text-[10px] text-text-disabled">{selectedCount}/{profiles.length}</span>
            </button>

            {/* Scrollable list organized by folders */}
            <div className="h-[240px] overflow-y-auto">
              {/* Pinned (not in folders) */}
              {pinned.length > 0 && (
                <div className="mb-1">
                  <div className="px-2 py-1 text-[10px] font-semibold text-text-disabled uppercase tracking-wide">Pinned</div>
                  {pinned.map(name => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggleExportProfile(name)}
                      className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-elevated cursor-pointer text-left"
                    >
                      <CheckboxBox checked={!!exportSelection[name]} />
                      <span className="text-xs text-text-primary truncate">{name}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Folders */}
              {folders.map(f => {
                const visibleItems = f.items.filter(matchesExport);
                const folderAllSelected = visibleItems.every(n => exportSelection[n]);
                const folderSomeSelected = visibleItems.some(n => exportSelection[n]);
                return (
                  <div key={f.name} className="mb-1">
                    <button
                      type="button"
                      onClick={() => toggleExportFolder(visibleItems)}
                      className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-bg-elevated cursor-pointer text-left"
                    >
                      <CheckboxBox
                        checked={folderAllSelected}
                        indeterminate={folderSomeSelected && !folderAllSelected}
                      />
                      <FolderOpen size={11} style={{ color: f.color }} className="shrink-0" />
                      <span className="text-xs font-medium text-text-secondary truncate">{f.name}</span>
                      <span className="ml-auto text-[10px] text-text-disabled">{visibleItems.filter(n => exportSelection[n]).length}/{visibleItems.length}</span>
                    </button>
                    <div className="ml-5">
                      {visibleItems.map(name => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => toggleExportProfile(name)}
                          className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-elevated cursor-pointer text-left"
                        >
                          <CheckboxBox checked={!!exportSelection[name]} />
                          <span className="text-xs text-text-primary truncate">{name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}

              {/* Ungrouped */}
              {ungrouped.length > 0 && (
                <div className="mb-1">
                  {folders.length > 0 && <div className="px-2 py-1 text-[10px] font-semibold text-text-disabled uppercase tracking-wide">Ungrouped</div>}
                  {ungrouped.map(p => (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => toggleExportProfile(p.name)}
                      className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-elevated cursor-pointer text-left"
                    >
                      <CheckboxBox checked={!!exportSelection[p.name]} />
                      <span className="text-xs text-text-primary truncate">{p.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-between mt-3 border-t border-border-subtle pt-3">
              <button
                onClick={() => { handleImportClick(); setShowExportDialog(false); }}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                Import
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowExportDialog(false)}
                  className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmExport}
                  disabled={selectedCount === 0}
                  className="px-4 py-1.5 text-xs text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-40"
                >
                  Export ({selectedCount})
                </button>
              </div>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Create Folder Dialog */}
      {showCreateFolderDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[340px] bg-bg-card border border-border-default rounded-lg p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-text-primary mb-3">New Folder</h3>
            <input
              ref={folderDialogInputRef}
              type="text"
              value={folderDialogName}
              onChange={(e) => setFolderDialogName(e.target.value)}
              onKeyDown={(e) => handleDialogKeyDown(e, confirmCreateFolder)}
              placeholder="Folder name..."
              className="w-full h-9 px-3 text-sm text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
            />
            <div className="flex items-center gap-1.5 mt-3">
              <span className="text-xs text-text-tertiary mr-1">Color:</span>
              {FOLDER_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setFolderDialogColor(c)}
                  className={`w-5 h-5 rounded-full border-2 transition-transform ${
                    folderDialogColor === c ? 'border-white scale-110' : 'border-transparent hover:scale-105'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowCreateFolderDialog(false)}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmCreateFolder}
                disabled={!folderDialogName.trim()}
                className="px-4 py-1.5 text-xs text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-40"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Folder Dialog */}
      {showRenameFolderDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[340px] bg-bg-card border border-border-default rounded-lg p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Rename Folder</h3>
            <input
              ref={folderDialogInputRef}
              type="text"
              value={folderDialogName}
              onChange={(e) => setFolderDialogName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); confirmRenameFolder(); }
                else if (e.key === 'Escape') { e.preventDefault(); setShowRenameFolderDialog(null); }
              }}
              placeholder="New folder name..."
              className="w-full h-9 px-3 text-sm text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowRenameFolderDialog(null)}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmRenameFolder}
                disabled={!folderDialogName.trim()}
                className="px-4 py-1.5 text-xs text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-40"
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Window Target Dialog — profile scope */}
      {showWindowTargetDialog && (() => {
        const name = showWindowTargetDialog;
        const existing = profiles.find(p => p.name === name);
        const hasOwnTarget = existing?.hasWindowTarget ?? false;
        // Resolve effective values: profile's own target > folder-inherited. The dialog uses
        // these as initial input so toggling a flag on an inherited-target profile doesn't
        // require re-typing the target.
        const folder = !hasOwnTarget ? (profileOrder?.folders ?? []).find(f => f.items.includes(name)) : undefined;
        const initial = {
          processName: (hasOwnTarget ? existing?.windowTargetProcessName : folder?.windowTargetProcessName) ?? '',
          windowTitle: (hasOwnTarget ? existing?.windowTargetWindowTitle : folder?.windowTargetWindowTitle) ?? '',
          titleMatchMode: ((hasOwnTarget ? existing?.windowTargetTitleMatchMode : folder?.windowTargetTitleMatchMode) ?? 'contains') as 'contains' | 'regex',
          relativeCoordinates: (hasOwnTarget ? existing?.useRelativeCoordinates : folder?.useRelativeCoordinates) ?? false,
          bringToFocus: (hasOwnTarget ? existing?.bringToFocus : folder?.bringToFocus) ?? false,
          // Same inheritance rule as the other flags: profile's own wins; otherwise show folder.
          restorePosition: (hasOwnTarget ? existing?.restorePosition : folder?.restorePosition) ?? false,
          restoreSize: (hasOwnTarget ? existing?.restoreSize : folder?.restoreSize) ?? false,
        };
        return (
          <TargetConfigDialog
            scope="profile"
            targetLabel={name}
            hasOwnTarget={hasOwnTarget}
            inheritedFromFolder={!hasOwnTarget && !!folder}
            initial={initial}
            onSubmit={(payload) => {
              send({
                type: 'profile:setWindowTarget',
                payload: {
                  name,
                  processName: payload.processName,
                  windowTitle: payload.windowTitle,
                  titleMatchMode: payload.titleMatchMode,
                  relativeCoordinates: payload.relativeCoordinates,
                  bringToFocus: payload.bringToFocus,
                  restorePosition: payload.restorePosition,
                  restoreSize: payload.restoreSize,
                  keepInheritedTarget: payload.keepInheritedTarget,
                },
              });
              setShowWindowTargetDialog(null);
            }}
            onRemove={() => {
              handleRemoveWindowTarget(name);
              setShowWindowTargetDialog(null);
            }}
            onCancel={() => setShowWindowTargetDialog(null)}
            onUpdateGeometry={(fields) => send({
              type: 'profile:updateWindowSize',
              payload: {
                name,
                // Lets the user capture geometry BEFORE saving the target — backend uses these
                // overrides to locate the window if the saved target is stale or empty.
                processName: fields.processName || undefined,
                windowTitle: fields.windowTitle || undefined,
                titleMatchMode: fields.titleMatchMode,
              },
            })}
            onConvertCoordinates={(direction) => send({
              type: 'profile:convertCoordinates',
              payload: { direction },
            })}
          />
        );
      })()}

      {/* Folder Target Dialog */}
      {showFolderTargetDialog && (() => {
        const folderName = showFolderTargetDialog;
        const folder = (profileOrder?.folders ?? []).find(f => f.name === folderName);
        const hasOwnTarget = !!folder?.hasWindowTarget;
        const initial = {
          processName: folder?.windowTargetProcessName ?? '',
          windowTitle: folder?.windowTargetWindowTitle ?? '',
          titleMatchMode: (folder?.windowTargetTitleMatchMode as 'contains' | 'regex') ?? 'contains',
          relativeCoordinates: folder?.useRelativeCoordinates ?? false,
          bringToFocus: folder?.bringToFocus ?? false,
          restorePosition: folder?.restorePosition ?? false,
          restoreSize: folder?.restoreSize ?? false,
        };
        return (
          <TargetConfigDialog
            scope="folder"
            targetLabel={folderName}
            hasOwnTarget={hasOwnTarget}
            initial={initial}
            onSubmit={(payload) => {
              send({
                type: 'profile:setFolderWindowTarget',
                payload: {
                  folderName,
                  processName: payload.processName,
                  windowTitle: payload.windowTitle,
                  titleMatchMode: payload.titleMatchMode,
                  relativeCoordinates: payload.relativeCoordinates,
                  bringToFocus: payload.bringToFocus,
                  restorePosition: payload.restorePosition,
                  restoreSize: payload.restoreSize,
                },
              });
              setShowFolderTargetDialog(null);
            }}
            onRemove={() => {
              send({ type: 'profile:removeFolderWindowTarget', payload: { folderName } });
              setShowFolderTargetDialog(null);
            }}
            onCancel={() => setShowFolderTargetDialog(null)}
            onUpdateGeometry={(fields) => send({
              type: 'profile:updateWindowSize',
              payload: {
                folderName,
                processName: fields.processName || undefined,
                windowTitle: fields.windowTitle || undefined,
                titleMatchMode: fields.titleMatchMode,
              },
            })}
          />
        );
      })()}

      {/* Floating drag preview — shared by profile drag and folder drag. Sits 32×32px
          off the cursor to clear the Windows "grabbing" cursor visual. Identical UX to
          the ActionTable chip. */}
      {dragCursorPos !== null && (dragProfile || dragFolder) && (
        <div
          className="fixed pointer-events-none z-50 flex items-center gap-1.5 px-2.5 py-1 rounded bg-bg-card border border-accent-solid/60 shadow-lg text-[11px] text-text-primary"
          style={{ left: dragCursorPos.x + 32, top: dragCursorPos.y + 32 }}
        >
          {dragFolder ? <FolderOpen size={11} className="text-accent shrink-0" /> : <FilePlus size={11} className="text-accent shrink-0" />}
          {dragFolder ?? dragProfile}
        </div>
      )}

      {/* ── Sharing-metadata dialogs ──
          Mounted at the panel root so the modal backdrop fills the whole window.
          Render order matters: security warning sits ABOVE the preview when both
          would render (the warning blocks the preview anyway because we don't set
          importPreview until the warning is dismissed). */}
      {securityWarningOpen && (
        <SecurityWarningModal
          onContinue={handleSecurityContinue}
          onCancel={handleSecurityCancel}
        />
      )}
      {importPreview && !securityWarningOpen && (
        <ImportPreviewDialog
          preview={importPreview}
          onConfirm={handlePreviewConfirm}
          onCancel={handlePreviewCancel}
        />
      )}
      {showInfoDialog && (
        <ProfileInfoDialog
          profileName={showInfoDialog}
          onClose={() => setShowInfoDialog(null)}
        />
      )}
    </>
  );
}
