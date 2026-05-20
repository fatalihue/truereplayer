import { useState, useRef, useEffect, useCallback } from 'react';
import { Search, X, Pencil, Copy, Trash2, FolderOpen, FolderMinus, Keyboard, Crosshair, ArrowLeftRight, Type, Ban, ChevronsLeft, ChevronsRight, ChevronsDownUp, ChevronsUpDown, Pin, PinOff, FolderPlus, FilePlus, ChevronRight, ChevronDown, Palette, ArrowRightFromLine, Zap, Repeat, ArrowUpFromDot, ExternalLink } from 'lucide-react';
import type { ProfileEntry } from '../bridge/messageTypes';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { KbdTag } from './common/KbdTag';
import { CheckboxBox } from './Checkbox';
import { TargetConfigDialog } from './TargetConfigDialog';

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

  // Filter profiles by search
  const matchesSearch = (name: string) =>
    !searchQuery || name.toLowerCase().includes(searchQuery.toLowerCase());

  // Build sectioned lists (alphabetically sorted)
  const sortByName = (a: ProfileEntry, b: ProfileEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

  const pinnedProfiles = (profileOrder?.pinned ?? [])
    .filter(n => profileMap.has(n) && matchesSearch(n))
    .map(n => profileMap.get(n)!)
    .sort(sortByName);

  const folderSections = (profileOrder?.folders ?? []).map(f => ({
    ...f,
    profiles: f.items
      .filter(n => profileMap.has(n) && matchesSearch(n))
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
    .filter(n => profileMap.has(n) && matchesSearch(n))
    .map(n => profileMap.get(n)!)
    .sort(sortByName);

  // If searching, show flat filtered list instead of sections
  const isSearching = searchQuery.length > 0;
  const filtered = isSearching
    ? profiles.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
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
    send({ type: 'hotkey:suppress', payload: { enabled: true } });
  };

  const handleRemoveHotkey = (name: string) => {
    setContextMenu(null);
    send({ type: 'profile:removeHotkey', payload: { name } });
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
    send({ type: 'profile:removeHotstring', payload: { name } });
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

  const handleRemoveWindowTarget = (name: string) => {
    setContextMenu(null);
    send({ type: 'profile:removeWindowTarget', payload: { name } });
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
    // Digit and letter keys via e.code (physical position) — shift-immune. e.key
    // returns the SHIFTED character when Shift is held (Shift+1 → "!"), which then
    // fails to resolve at hotkey-trigger time because the backend looks up VK codes
    // by the captured name and there's no VK for bare "!". e.code stays "Digit1"
    // regardless of shift state, so we get the base "1" and the Shift modifier is
    // captured separately in the modifiers list above.
    else if (/^Digit[0-9]$/.test(e.code)) mainKey = e.code.slice(5);
    else if (/^Key[A-Z]$/.test(e.code)) mainKey = e.code.slice(3);
    else if (mainKey.length === 1) mainKey = mainKey.toUpperCase();
    else if (mainKey === 'ArrowUp') mainKey = 'Up';
    else if (mainKey === 'ArrowDown') mainKey = 'Down';
    else if (mainKey === 'ArrowLeft') mainKey = 'Left';
    else if (mainKey === 'ArrowRight') mainKey = 'Right';

    if (!modifiers.includes(mainKey)) modifiers.push(mainKey);
    const combo = modifiers.join('+');
    setHotkeyCapture(combo);
  };

  const handleHotkeyWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const modifiers: string[] = [];
    if (e.ctrlKey) modifiers.push('Ctrl');
    if (e.altKey) modifiers.push('Alt');
    if (e.shiftKey) modifiers.push('Shift');
    modifiers.push(e.deltaY < 0 ? 'ScrollUp' : 'ScrollDown');
    setHotkeyCapture(modifiers.join('+'));
  };

  const confirmHotkey = () => {
    if (showHotkeyDialog && hotkeyCapture && hotkeyCapture !== '...') {
      send({ type: 'profile:assignHotkey', payload: { name: showHotkeyDialog, hotkey: hotkeyCapture, mode: hotkeyTriggerMode } });
      // Don't close dialog here — wait for profiles:updated (success) or alert:show (conflict)
    }
  };

  // Suppress global hotkeys while hotkey dialog is open
  useEffect(() => {
    if (!showHotkeyDialog) {
      send({ type: 'hotkey:suppress', payload: { enabled: false } });
    }
  }, [showHotkeyDialog]);

  // Auto-close hotkey dialog when profile list updates (means hotkey was saved successfully)
  useEffect(() => {
    if (!showHotkeyDialog) return;
    return subscribe((msg) => {
      if (msg.type === 'profiles:updated') {
        setShowHotkeyDialog(null);
      }
    });
  }, [showHotkeyDialog, subscribe]);

  // Suppress global hotkeys while hotstring dialog is open
  useEffect(() => {
    if (!showHotstringDialog) {
      send({ type: 'hotkey:suppress', payload: { enabled: false } });
    }
  }, [showHotstringDialog]);

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

  const getProfileFolder = (name: string): string | null => {
    for (const f of profileOrder?.folders ?? []) {
      if (f.items.includes(name)) return f.name;
    }
    return null;
  };

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
  }, [dragProfile, dropTarget, sendWithTransition, maybeKickAutoScroll]);

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

        <span
          className={`text-ui flex-1 min-w-0 truncate ${
            p.isActive
              ? 'text-accent font-semibold'
              : 'text-text-primary'
          }`}
        >
          {p.name}
        </span>

        {p.hasWindowTarget ? (
          <span
            className="group/target shrink-0 relative"
            data-tip={p.windowTargetProcessName || p.windowTargetWindowTitle || 'Window target set'}
            data-tip-pos="end"
          >
            <Crosshair size={11} className="text-text-tertiary" />
            <button
              onClick={(e) => { e.stopPropagation(); handleRemoveWindowTarget(p.name); }}
              className="hidden group-hover/target:inline-flex absolute top-0 right-0 w-full h-full items-center justify-center rounded-full bg-recording text-white text-[7px] font-bold leading-none hover:bg-red-500"
            >✕</button>
          </span>
        ) : p.hasEffectiveTarget && p.effectiveTargetSource === 'folder' && (
          // Inherited from folder — show a faded crosshair so the user can see this profile
          // IS gated even though it has no target of its own. No remove (✕) overlay because
          // removal must happen from the folder, not the row. The folder ancestry is already
          // visible in the tree, so the tooltip only carries the target identity.
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
          <span className="group/hotkey shrink-0 relative">
            <KbdTag combo={p.hotkey} />
            <button
              onClick={(e) => { e.stopPropagation(); handleRemoveHotkey(p.name); }}
              className="hidden group-hover/hotkey:inline-flex absolute top-0 right-0 bottom-0 w-4 items-center justify-center rounded-r bg-recording/80 text-white text-[7px] font-bold leading-none hover:bg-recording"
            >✕</button>
          </span>
        )}

        {p.hotstring && (
          <span
            className="group/hotstring shrink-0 relative px-1.5 py-0.5 rounded text-[11px] font-mono bg-hotkey-bg border border-hotkey-border text-accent-hover"
            title={p.hotstringInstant ? 'Hotstring (instant)' : 'Hotstring (terminator)'}
          >
            {p.hotstringInstant ? '\u26A1' : '\u21B5'}{p.hotstring}
            <button
              onClick={(e) => { e.stopPropagation(); handleRemoveHotstring(p.name); }}
              className="hidden group-hover/hotstring:inline-flex absolute top-0 right-0 bottom-0 w-4 items-center justify-center rounded-r bg-recording/80 text-white text-[7px] font-bold leading-none hover:bg-recording"
            >✕</button>
          </span>
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

        {/* Search */}
        <div className="px-3 pb-1.5">
          <div className="flex items-center gap-2 px-2.5 py-1.5 bg-bg-input border border-border-default rounded">
            <Search size={13} className="text-text-disabled shrink-0" />
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
                        <span className={`text-xs font-medium flex-1 truncate ${folderAllDisabled ? 'text-text-disabled' : 'text-text-secondary'}`}>{folder.name}</span>
                        {folder.hasWindowTarget && (
                          <span
                            className="group/ftarget shrink-0 relative"
                            data-tip={folder.windowTargetProcessName || folder.windowTargetWindowTitle || 'Window Target'}
                            data-tip-pos="end"
                          >
                            <Crosshair size={10} className="text-text-tertiary" />
                            <button
                              onClick={(e) => { e.stopPropagation(); send({ type: 'profile:removeFolderWindowTarget', payload: { folderName: folder.name } }); }}
                              className="hidden group-hover/ftarget:inline-flex absolute top-0 right-0 w-full h-full items-center justify-center rounded-full bg-recording text-white text-[7px] font-bold leading-none hover:bg-red-500"
                            >✕</button>
                          </span>
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
        // Profile row context menu — organised into 4 groups (mirrors the
        // ActionTable row menu pass):
        //   - State toggles     → Pin / Unpin · Disable / Enable
        //   - Organization      → Move to folder ▸ · Rename · Duplicate · Open in Explorer
        //   - Triggers          → Assign hotkey… · Assign hotstring… · Window target…
        //   - Destructive       → Delete
        // Trailing ellipsis on "Assign… / Window target…" follows the standard
        // convention that the label opens a dialog rather than acting inline.
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[180px] py-1 bg-bg-card border border-border-default rounded-md shadow-lg"
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          {/* ── Group 1: State toggles ── */}
          {/* Pin / Unpin */}
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

          {/* ── Group 2: Organization ── */}
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

          <button
            onClick={() => handleRename(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Pencil size={13} className="text-text-tertiary" />
            Rename
          </button>

          {/* Duplicate — mirrors the toolbar header button. Per-row entry point is
              useful when the user wants to duplicate a profile that isn't currently
              the active one. */}
          <button
            onClick={() => handleDuplicate(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Copy size={13} className="text-text-tertiary" />
            Duplicate
          </button>

          {/* Open in Explorer — opens the profile's .json file in the Windows
              Explorer. Mirrors the toolbar header button but works for any
              profile, not just the active one. */}
          <button
            onClick={() => { handleOpenFolder(contextMenu.profileName); setContextMenu(null); }}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <ExternalLink size={13} className="text-text-tertiary" />
            Open in Explorer
          </button>

          <div className="my-1 border-t border-border-subtle" />

          {/* ── Group 3: Trigger dialogs ── */}
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
        // Folder context menu — grouped top-to-bottom by scope:
        //   - Identity (apply to this folder itself)     → Rename · Color ▸
        //   - Triggers (apply to this folder's children) → Window target… · Disable all
        //   - View (apply to ALL folders)                → Collapse / Expand all folders
        //   - Destructive                                 → Delete folder
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

          {/* ── Triggers (this folder's children) ── */}
          {/* "Window target…" — inherited by every profile inside the folder
              unless that profile overrides it. The trailing ellipsis indicates
              a dialog opens (matches the profile menu's "Assign hotkey…" etc). */}
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
              onKeyDown={handleHotkeyCapture}
              onWheel={handleHotkeyWheel}
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
    </>
  );
}
