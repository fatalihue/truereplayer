import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { Search, SearchX, X, Pencil, Copy, Trash2, FolderOpen, FolderMinus, Keyboard, Crosshair, ArrowLeftRight, Type, Ban, ChevronsLeft, ChevronsRight, ChevronsDownUp, ChevronsUpDown, Pin, PinOff, FolderPlus, FilePlus, ChevronRight, ChevronDown, Palette, ArrowRightFromLine, Zap, Repeat, ArrowUpFromDot, ExternalLink, Info, MoreHorizontal, Hash } from 'lucide-react';
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
import { useTt } from '../state/LanguageContext';
import { useFlyoutFlip } from '../hooks/useFlyoutFlip';

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

// Native click action types — used to count coordinates that would benefit from a
// Convert to Relative/Absolute pass. Module-scoped so it isn't rebuilt every render.
const CONVERTIBLE_CLICK_TYPES = new Set([
  'LeftClickDown', 'LeftClickUp',
  'RightClickDown', 'RightClickUp',
  'MiddleClickDown', 'MiddleClickUp',
  // Combined-mode single clicks carry coordinates too.
  'LeftClick', 'RightClick', 'MiddleClick',
]);

export function ProfilePanel({ collapsed = false, onToggleCollapse }: ProfilePanelProps) {
  const tt = useTt();
  const { profiles, profileOrder, actions } = useAppState();

  // Pre-compute the count of actions whose stored coordinates would benefit from a
  // Convert to Relative/Absolute pass. Used by TargetConfigDialog to show its migration
  // hint when the user toggles UseRelativeCoordinates. Kept in sync with the backend's
  // HandleConvertCoordinates filter (clicks + WaitImage with search region + WaitPixel
  // with pixel set) — change both together if the filter ever changes.
  const convertibleActionCount = useMemo(() => actions.reduce((n, a) => {
    if (CONVERTIBLE_CLICK_TYPES.has(a.actionType)) return n + 1;
    // Mirror the backend's HandleConvertCoordinates which translates both WaitImage
    // and IF Image rows with a set search region, and both WaitPixelColor and IF
    // Pixel rows with set coords. Without these branches the dialog under-reports
    // how many rows will actually be converted when the profile uses conditionals.
    const isImageProbe = a.actionType === 'WaitImage'
      || (a.actionType === 'If' && a.conditionType === 'ImageFound');
    if (isImageProbe
      && typeof a.waitImageSearchW === 'number' && a.waitImageSearchW > 0
      && typeof a.waitImageSearchH === 'number' && a.waitImageSearchH > 0) return n + 1;
    const isPixelProbe = a.actionType === 'WaitPixelColor'
      || (a.actionType === 'If' && a.conditionType === 'PixelColorMatch');
    if (isPixelProbe
      && typeof a.pixelX === 'number' && typeof a.pixelY === 'number') return n + 1;
    return n;
  }, 0), [actions]);
  const { send, subscribe } = useBridge();
  // Stable refcount slot for hotkey:capture — assign-hotkey dialog can be triggered
  // while Settings has its hotkey field focused (modal-over-modal isn't blocked at the
  // route layer), and without a per-mount slot, closing one would disable the backend
  // hook from under the other. See InputHookManager.RegisterCapture.
  const captureOwnerIdRef = useRef(`profile-panel-${crypto.randomUUID()}`);
  const { showToast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  // Confirmation gate for the inline ✕ removals (hotkey / hotstring / profile
  // target / folder target). kind drives which handler runs on confirm; label
  // is shown in the prompt. The 10s undo toast is the second safety net.
  const [confirmRemoval, setConfirmRemoval] = useState<{
    kind: 'hotkey' | 'hotstring' | 'profileTarget' | 'folderTarget';
    name: string;
    label: string;
  } | null>(null);
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
  // Profile context-menu "More ▸" submenu (Edit info / Duplicate / Open in Explorer).
  const [showProfileMoreMenu, setShowProfileMoreMenu] = useState<string | null>(null);
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

  // Build profile map for quick lookup. Memoized on `profiles` so the map (and every
  // derived section list below, which all key off it) isn't rebuilt on unrelated re-renders
  // (drag state, dialog toggles, hover submenus). Only changes when the profile set changes.
  const profileMap = useMemo(() => {
    const m = new Map<string, ProfileEntry>();
    profiles.forEach(p => m.set(p.name, p));
    return m;
  }, [profiles]);

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

  // The three section lists all derive from profileMap + profileOrder + the search query.
  // Memoize so they only recompute when one of those changes — not on drag/dialog/hover
  // re-renders. matchesSearch/sortByName/isTagSearch/tagSearchTerm are pure derivations of
  // searchQuery, so searchQuery in the dep array covers them.
  const pinnedProfiles = useMemo(() => (profileOrder?.pinned ?? [])
    .filter(n => profileMap.has(n) && matchesSearch(profileMap.get(n)!))
    .map(n => profileMap.get(n)!)
    .sort(sortByName), [profileMap, profileOrder, searchQuery]);

  const folderSections = useMemo(() => (profileOrder?.folders ?? []).map(f => ({
    ...f,
    profiles: f.items
      .filter(n => profileMap.has(n) && matchesSearch(profileMap.get(n)!))
      .map(n => profileMap.get(n)!)
      .sort(sortByName)
  })), [profileMap, profileOrder, searchQuery]);

  const ungroupedProfiles = useMemo(() => {
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

    return ungroupedNames
      .filter(n => profileMap.has(n) && matchesSearch(profileMap.get(n)!))
      .map(n => profileMap.get(n)!)
      .sort(sortByName);
  }, [profileMap, profileOrder, profiles, searchQuery]);

  // If searching, show flat filtered list instead of sections. Reuses matchesSearch so
  // #tag mode works here too — was previously a separate name-only filter, which silently
  // broke tag-search by returning the unfiltered list when the prefix didn't match a name.
  const isSearching = searchQuery.length > 0;
  const filtered = useMemo(() => isSearching
    ? profiles.filter(matchesSearch)
    : profiles, [profiles, searchQuery, isSearching]);

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // Same role as menuPos, but for the folder context menu. Kept separate so the two
  // menus can be open-measured independently.
  const [folderMenuPos, setFolderMenuPos] = useState<{ x: number; y: number } | null>(null);

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

  // Folder context menu positioning — same off-screen-measure-then-reposition dance
  // as the profile menu above, so right-clicking a folder near the bottom (or right
  // edge) doesn't leave the menu clipped by the viewport.
  useEffect(() => {
    if (!folderContextMenu) { setFolderMenuPos(null); return; }
    setFolderMenuPos({ x: -9999, y: -9999 });
  }, [folderContextMenu]);

  useEffect(() => {
    if (!folderContextMenu || !folderMenuPos) return;
    if (folderMenuPos.x === -9999) {
      requestAnimationFrame(() => {
        const el = folderMenuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        let x = folderContextMenu.x;
        let y = folderContextMenu.y;
        // If menu would overflow bottom, move it up
        if (y + rect.height > window.innerHeight - 8) {
          y = Math.max(8, folderContextMenu.y - rect.height);
        }
        // If menu would overflow right, move it left
        if (x + rect.width > window.innerWidth - 8) {
          x = Math.max(8, window.innerWidth - rect.width - 8);
        }
        setFolderMenuPos({ x, y });
      });
    }
  }, [folderContextMenu, folderMenuPos]);

  // Submenu flip — each of the three context-menu submenus (Move to folder, More,
  // and the folder Color picker) opens to the side with `left-full top-0`, which
  // clips when the parent menu sits near the right or bottom edge. useFlyoutFlip
  // measures on open and tells us which way to flip. The open flags mirror the
  // render conditions below so the hook and the JSX stay in lockstep.
  const moveMenuOpen = !!contextMenu && showMoveToFolderMenu === contextMenu.profileName;
  const moveFlyout = useFlyoutFlip(moveMenuOpen, 'side');
  const moreMenuOpen = !!contextMenu && showProfileMoreMenu === contextMenu.profileName;
  const moreFlyout = useFlyoutFlip(moreMenuOpen, 'side');
  const colorMenuOpen = !!folderContextMenu && showFolderColorPicker === folderContextMenu.folderName;
  const colorFlyout = useFlyoutFlip(colorMenuOpen, 'side');

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

  // Profiles currently visible in the export dialog (after the search filter). Select-All,
  // the count, and confirmExport all scope to these so a filter never touches hidden profiles.
  const visibleExportNames = profiles
    .filter(p => !exportSearch || p.name.toLowerCase().includes(exportSearch.toLowerCase()))
    .map(p => p.name);

  const allExportSelected = visibleExportNames.length > 0 && visibleExportNames.every(n => exportSelection[n]);

  const toggleExportSelectAll = () => {
    const newVal = !allExportSelected;
    // Flip only the visible profiles; preserve any selection made on filtered-out ones.
    setExportSelection(prev => {
      const updated = { ...prev };
      visibleExportNames.forEach(n => { updated[n] = newVal; });
      return updated;
    });
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
    // Scope to the visible profiles so a filtered-out (but still-checked) profile is not shipped.
    const selectedNames = visibleExportNames.filter(name => exportSelection[name]);
    if (selectedNames.length > 0) {
      send({ type: 'profile:export', payload: { names: selectedNames, includeOrganization: true } });
    }
    setShowExportDialog(false);
  };

  const handleContextMenu = useCallback((e: React.MouseEvent, name: string) => {
    e.preventDefault();
    // Clear any submenu left open from a previous menu. Otherwise, re-right-clicking the
    // same profile would re-satisfy `showXMenu === profileName` and auto-open the submenu
    // *during* the new menu's off-screen measurement pass, so useFlyoutFlip would measure
    // garbage coordinates and never re-flip. Submenus should only open via genuine hover,
    // after the menu has settled at its final position.
    setShowMoveToFolderMenu(null);
    setShowProfileMoreMenu(null);
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
    send({ type: 'hotkey:capture', payload: { enabled: true, ownerId: captureOwnerIdRef.current } });
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
      showToast(tt(`Removed hotkey ${prevHotkey} from "${name}"`, `Hotkey ${prevHotkey} removido de "${name}"`), {
        type: 'success',
        duration: 10000, // longer undo window for destructive metadata removals (user request)
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
      showToast(tt(`Removed hotstring "${prevSeq}" from "${name}"`, `Hotstring "${prevSeq}" removido de "${name}"`), {
        type: 'success',
        duration: 10000,
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
      showToast(tt(`Removed folder target (${label}) from "${folderName}"`, `Alvo da pasta (${label}) removido de "${folderName}"`), {
        type: 'success',
        duration: 10000,
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

  // Pending window-target removals: stash the prev values keyed by name. When the backend
  // confirms via profile:windowTargetRemoved we look up + show the success toast with the
  // matching Undo payload. Without this round-trip the toast fired optimistically and
  // contradicted the backend's "Cannot remove" alert when the removal was blocked by a
  // hotkey/hotstring collision.
  const pendingRemovalsRef = useRef<Map<string, {
    label: string;
    processName: string;
    windowTitle: string;
    titleMatchMode: string;
    relativeCoordinates: boolean;
    bringToFocus: boolean;
    restorePosition: boolean;
    restoreSize: boolean;
  }>>(new Map());

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'profile:windowTargetRemoved') return;
      const name = msg.payload.name;
      const prev = pendingRemovalsRef.current.get(name);
      if (!prev) return;  // Not ours, or already handled (defensive)
      pendingRemovalsRef.current.delete(name);
      showToast(tt(`Removed window target (${prev.label}) from "${name}"`, `Janela-alvo (${prev.label}) removida de "${name}"`), {
        type: 'success',
        duration: 10000,
        action: {
          label: 'Undo',
          onClick: () => send({
            type: 'profile:setWindowTarget',
            payload: {
              name,
              processName: prev.processName,
              windowTitle: prev.windowTitle,
              titleMatchMode: prev.titleMatchMode,
              relativeCoordinates: prev.relativeCoordinates,
              bringToFocus: prev.bringToFocus,
              restorePosition: prev.restorePosition,
              restoreSize: prev.restoreSize,
            },
          }),
        },
      });
    });
    // `tt` is a dep: it's memoised on [language], and this effect closes over it for the toast.
    // Without it the subscription would freeze tt at the mount-time language and a later language
    // switch would render the "Removed window target" Undo toast in the previous language.
  }, [subscribe, send, showToast, tt]);

  const handleRemoveWindowTarget = (name: string) => {
    setContextMenu(null);
    // Capture all the fields needed to reconstruct the prior target, so the Undo toast
    // (shown after the backend confirms) can restore the exact state. Only profiles with
    // their own target (not folder-inherited) actually go through the remove → confirm
    // round-trip; otherwise the message is a no-op server-side.
    const prev = profiles.find(p => p.name === name);
    const hadOwn = prev?.hasWindowTarget;
    if (!hadOwn) {
      // No own target → backend won't change anything → no confirmation event coming.
      // Still send for symmetry (handler is a no-op when nothing to remove).
      send({ type: 'profile:removeWindowTarget', payload: { name } });
      return;
    }
    const prevProcess = prev?.windowTargetProcessName ?? '';
    const prevTitle = prev?.windowTargetWindowTitle ?? '';
    const label = prevProcess || prevTitle || 'target';
    pendingRemovalsRef.current.set(name, {
      label,
      processName: prevProcess,
      windowTitle: prevTitle,
      titleMatchMode: prev?.windowTargetTitleMatchMode ?? 'contains',
      relativeCoordinates: prev?.useRelativeCoordinates ?? false,
      bringToFocus: prev?.bringToFocus ?? false,
      restorePosition: prev?.restorePosition ?? false,
      restoreSize: prev?.restoreSize ?? false,
    });
    send({ type: 'profile:removeWindowTarget', payload: { name } });
  };

  // Runs the actual removal once the confirmation dialog is accepted. The
  // individual handlers still fire their own 10s undo toast.
  const runConfirmedRemoval = () => {
    if (!confirmRemoval) return;
    const { kind, name } = confirmRemoval;
    setConfirmRemoval(null);
    if (kind === 'hotkey') handleRemoveHotkey(name);
    else if (kind === 'hotstring') handleRemoveHotstring(name);
    else if (kind === 'profileTarget') handleRemoveWindowTarget(name);
    else if (kind === 'folderTarget') handleRemoveFolderWindowTarget(name);
  };

  const confirmHotkey = () => {
    if (showHotkeyDialog && hotkeyCapture && hotkeyCapture !== '...') {
      send({ type: 'profile:assignHotkey', payload: { name: showHotkeyDialog, hotkey: hotkeyCapture, mode: hotkeyTriggerMode } });
      // Close optimistically rather than waiting solely on profiles:updated. The backend
      // doesn't push that message on every path (e.g. a profile that fails to load), which
      // previously left the dialog stuck open with no feedback. On a hotkey conflict the
      // backend emits alert:show, which ToastContext already surfaces as a toast, so the
      // user still sees why the bind didn't take even though the dialog has closed.
      setShowHotkeyDialog(null);
    }
  };

  // Disable backend capture mode when hotkey dialog closes. `send` is a stable useCallback
  // from BridgeContext (deps []), so listing it here doesn't cause extra re-runs — only
  // silences exhaustive-deps without changing behaviour.
  useEffect(() => {
    if (!showHotkeyDialog) {
      send({ type: 'hotkey:capture', payload: { enabled: false, ownerId: captureOwnerIdRef.current } });
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
    if (!name) { setShowCreateDialog(false); return; }
    // Block duplicate names client-side (mirrors the backend File.Exists guard, case-insensitive
    // like the Windows file system) so the dialog stays open for a quick fix.
    if (profiles.some(p => p.name.toLowerCase() === name.toLowerCase())) return;
    send({ type: 'profile:create', payload: { name, folder: selectedFolder || undefined } });
    setShowCreateDialog(false);
  };

  const confirmRename = () => {
    const newName = dialogValue.trim();
    if (!newName || !showRenameDialog || newName === showRenameDialog) {
      setShowRenameDialog(null);
      return;
    }
    // Block collisions with OTHER profiles client-side (mirrors the backend); keep dialog open.
    if (profiles.some(p => p.name !== showRenameDialog && p.name.toLowerCase() === newName.toLowerCase())) return;
    send({ type: 'profile:rename', payload: { oldName: showRenameDialog, newName } });
    setShowRenameDialog(null);
  };

  // Duplicate-name state for the profile dialogs' button-disable + inline hint (mirrors the
  // backend File.Exists guard: case-insensitive, like the file system). Rename excludes the
  // profile being renamed (re-typing its own name / a pure re-casing is allowed).
  const dialogValueLc = dialogValue.trim().toLowerCase();
  const createProfileNameTaken = !!dialogValueLc
    && profiles.some(p => p.name.toLowerCase() === dialogValueLc);
  const renameProfileNameTaken = !!dialogValueLc
    && profiles.some(p => p.name !== showRenameDialog && p.name.toLowerCase() === dialogValueLc);

  // ── Folder handlers ──
  const handleCreateFolder = () => {
    setFolderDialogName('');
    setFolderDialogColor('#60CDFF');
    setShowCreateFolderDialog(true);
  };

  const confirmCreateFolder = () => {
    const name = folderDialogName.trim();
    if (!name) { setShowCreateFolderDialog(false); return; }
    // Block duplicate names client-side (mirrors the backend guard) so the dialog stays open
    // for a quick fix instead of closing and surfacing a toast after the round-trip.
    if ((profileOrder?.folders ?? []).some(f => f.name.toLowerCase() === name.toLowerCase())) return;
    send({ type: 'profile:createFolder', payload: { name, color: folderDialogColor } });
    setShowCreateFolderDialog(false);
  };

  const handleRenameFolder = (folderName: string) => {
    setFolderContextMenu(null);
    setFolderDialogName(folderName);
    setShowRenameFolderDialog(folderName);
  };

  const confirmRenameFolder = () => {
    const newName = folderDialogName.trim();
    if (!newName || !showRenameFolderDialog || newName === showRenameFolderDialog) {
      setShowRenameFolderDialog(null);
      return;
    }
    // Block collisions with OTHER folders client-side (mirrors the backend); keep the dialog open.
    if ((profileOrder?.folders ?? []).some(f => f.name !== showRenameFolderDialog && f.name.toLowerCase() === newName.toLowerCase())) return;
    send({ type: 'profile:renameFolder', payload: { oldName: showRenameFolderDialog, newName } });
    setShowRenameFolderDialog(null);
  };

  // Duplicate-name state for the folder dialogs' button-disable + inline hint (mirrors the
  // backend reject: trimmed, case-insensitive). Rename excludes the folder being renamed.
  const folderDialogNameLc = folderDialogName.trim().toLowerCase();
  const createFolderNameTaken = !!folderDialogNameLc
    && (profileOrder?.folders ?? []).some(f => f.name.toLowerCase() === folderDialogNameLc);
  const renameFolderNameTaken = !!folderDialogNameLc
    && (profileOrder?.folders ?? []).some(f => f.name !== showRenameFolderDialog && f.name.toLowerCase() === folderDialogNameLc);

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
    // Clear a stale color-picker submenu so it can't auto-open during the menu's off-screen
    // measurement pass (see handleContextMenu for why that breaks useFlyoutFlip).
    setShowFolderColorPicker(null);
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

  // Window-target tooltip label: show the .exe name (user request). The stored
  // process name may or may not carry the extension depending on what was typed
  // in the target dialog, so normalise to "<name>.exe". Falls back to the window
  // title when there's no process name, and to a generic label otherwise.
  const targetLabel = (procName?: string | null, windowTitle?: string | null): string => {
    if (procName) return /\.exe$/i.test(procName) ? procName : `${procName}.exe`;
    if (windowTitle) return windowTitle;
    return tt('Window target', 'Janela-alvo');
  };

  // Folder colour for the collapsed rail's avatar dot — tells which folder a
  // profile lives in without expanding the panel. null = ungrouped (no dot).
  const getProfileFolderColor = useCallback((name: string): string | null => {
    for (const f of profileOrder?.folders ?? []) {
      if (f.items.includes(name)) return f.color;
    }
    return null;
  }, [profileOrder?.folders]);

  // Collapsed-rail "search" action: expand the panel with the search field
  // already focused (mirrors the SettingsPanel rail's expand-into-section flow).
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingFocusSearch = useRef(false);
  useEffect(() => {
    if (!collapsed && pendingFocusSearch.current) {
      pendingFocusSearch.current = false;
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [collapsed]);

  // Collapsed-rail capacity: how many 32px avatars (+4px gap = 36px stride) fit
  // in the measured strip height. A ResizeObserver keeps it in sync as the
  // window resizes. When the profile count exceeds capacity the last slot
  // becomes the "+N expand" chip, so the rail always fills the visible space
  // exactly instead of a fixed cap of 10.
  const railRef = useRef<HTMLDivElement>(null);
  const [railCapacity, setRailCapacity] = useState(10);
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight;
      // N avatars take 36N − 4 px (no trailing gap) → N ≤ (H + 4) / 36.
      setRailCapacity(Math.max(1, Math.floor((h + 4) / 36)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed]);

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
      if (container) delete container.dataset.autoscrolling;
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
      // Freeze the drop-gap grow animation while auto-scrolling: the gap re-mounts at a
      // new index every frame, and replaying the 120ms grow that fast reads as flicker.
      // Mirrors ActionTable's guard — see [data-autoscrolling] in index.css.
      container.dataset.autoscrolling = 'true';
      container.scrollTop += delta;
      autoScrollRaf.current = requestAnimationFrame(tickAutoScroll);
    } else {
      delete container.dataset.autoscrolling;
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

  // FLIP-on-drop — mirrors ActionTable's grid drag so folder/profile reorders slide
  // into place instead of teleporting. The reorder round-trips through the backend, so
  // the new order lands a frame or two AFTER the drop; the old View-Transition cross-fade
  // tried to bridge that gap by fading the whole panel, which read as an ugly blink. Now:
  // at drop we snapshot every drag item's viewport top, then once the reordered data
  // arrives we slide each one from its old slot to its new slot (translateY delta → 0),
  // exactly like the grid's row reorder (same 180ms / cubic-bezier, same offscreen/maxFly
  // culls, same data-animations gate). Per-kind selector ('folder:' vs 'profile:') because
  // the list is NESTED: a folder reorder animates only the folder wrappers (their child
  // profile rows ride the wrapper's transform), a profile move animates only profile rows —
  // animating both at once would double-transform the nested rows. Timestamped so a stale
  // snapshot (reorder rejected / unrelated update arriving later) is discarded.
  const pendingFlipRects = useRef<{ map: Map<string, number>; at: number; selector: string } | null>(null);

  const snapshotDragItems = useCallback((selector: string) => {
    if (document.documentElement.getAttribute('data-animations') !== 'true') return;
    const container = scrollRef.current;
    if (!container) return;
    // The drop indicator is a REAL layout slot (.drop-gap-slot) that physically
    // pushes every item below it down. If we snapshot with it present, unmoved
    // folders below the gap record a displaced "old" top and then spuriously
    // slide ~one gap-height on drop — the ugly "flicker". The grid never hits
    // this: dnd-kit shifts rows via transforms, so only the rows BETWEEN source
    // and target ever move. To get the same clean baseline, collapse the gap(s)
    // before measuring and restore immediately — all synchronous within this
    // handler, so nothing paints in between (verified: removing the gap yields
    // exactly the post-reorder resting position). scrollTop is pinned because
    // collapsing the gaps can clamp the scroll when dropping near the list end.
    const gaps = Array.from(container.querySelectorAll<HTMLElement>('.drop-gap-slot'));
    const prevDisplay = gaps.map(g => g.style.display);
    const scrollTop = container.scrollTop;
    gaps.forEach(g => { g.style.display = 'none'; });
    container.scrollTop = scrollTop;
    const map = new Map<string, number>();
    container.querySelectorAll<HTMLElement>(selector).forEach(el => {
      const id = el.getAttribute('data-drag-item');
      if (id) map.set(id, el.getBoundingClientRect().top);
    });
    gaps.forEach((g, i) => { g.style.display = prevDisplay[i]; });
    container.scrollTop = scrollTop;
    pendingFlipRects.current = { map, at: performance.now(), selector };
  }, []);

  useLayoutEffect(() => {
    const pending = pendingFlipRects.current;
    if (!pending) return;
    pendingFlipRects.current = null;
    const container = scrollRef.current;
    if (!container) return;
    if (performance.now() - pending.at > 800) return;
    const view = container.getBoundingClientRect();
    const maxFly = view.height || 600;
    container.querySelectorAll<HTMLElement>(pending.selector).forEach(el => {
      const id = el.getAttribute('data-drag-item');
      if (!id) return;
      const oldTop = pending.map.get(id);
      if (oldTop === undefined) return;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < view.top || rect.top > view.bottom) return; // offscreen → no animation
      const delta = oldTop - rect.top;
      if (Math.abs(delta) < 2 || Math.abs(delta) > maxFly) return; // unchanged or too far → snap
      el.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
        { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
      );
    });
  }, [profileOrder, profiles]);

  const handleProfileMouseDown = (e: React.MouseEvent, profileName: string) => {
    if (e.button !== 0) return; // left click only
    if (scrollRef.current) delete scrollRef.current.dataset.autoscrolling; // reset any stale flag from a prior drag
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
      if (!dragActive.current) {
        document.body.style.cursor = 'grabbing';
        // Signal the actions grid that a profile drag began (it shows an insertion rail).
        window.dispatchEvent(new CustomEvent('profiledrag:start', { detail: { profileName: dragProfile } }));
      }
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

    const handleMouseUp = (e: MouseEvent) => {
      const wasActive = dragActive.current;
      if (wasActive && dragProfile && dropTarget) {
        const targetFolder = dropTarget === '__ungrouped__' ? null : dropTarget;
        const currentFolder = getProfileFolder(dragProfile);
        if (currentFolder !== targetFolder) {
          snapshotDragItems('[data-drag-item^="profile:"]');
          send({ type: 'profile:moveToFolder', payload: { profileName: dragProfile, folderName: targetFolder } });
        }
      } else if (wasActive && dragProfile) {
        // Not over a folder/ungrouped zone — did we drop on the actions grid? If so, hand off
        // to ActionTable, which opens a pre-filled Run Profile dialog at the drop position.
        // The floating preview is pointer-events:none, so elementFromPoint hits the grid.
        const overGrid = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-actions-grid]');
        if (overGrid) {
          window.dispatchEvent(new CustomEvent('profiledrag:dropOnGrid', { detail: { profileName: dragProfile, clientY: e.clientY } }));
        }
      }
      document.body.style.cursor = '';
      dragStartPos.current = null;
      // Defer clearing dragActive until after the browser dispatches the synthesized click:
      // mouseup → click fire back-to-back, so resetting here would let the row's onClick guard
      // (`if (dragActive.current)`) miss a just-finished drag and spuriously activate the profile.
      setTimeout(() => { dragActive.current = false; }, 0);
      setDragProfile(null);
      setDropTarget(null);
      setDragCursorPos(null);
      if (autoScrollRaf.current !== null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
      if (wasActive) window.dispatchEvent(new Event('profiledrag:end'));
    };

    // Esc cancels an in-progress profile drag — restores state without moving.
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragActive.current) return;
      e.stopPropagation();
      window.dispatchEvent(new Event('profiledrag:end')); // clear the grid's insertion rail
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
  }, [dragProfile, dropTarget, send, snapshotDragItems, maybeKickAutoScroll, getProfileFolder]);

  // ── Folder Drag & Drop (reorder folders) ──
  const folderDragStartPos = useRef<{ x: number; y: number } | null>(null);
  // folderDragActive is mirrored to folderDragActiveRef (declared up-front) so
  // the shared tickAutoScroll can read it without re-deriving on each render.
  const folderDragActive = folderDragActiveRef;

  const handleFolderMouseDown = (e: React.MouseEvent, folderName: string) => {
    if (e.button !== 0) return;
    if (scrollRef.current) delete scrollRef.current.dataset.autoscrolling; // reset any stale flag from a prior drag
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

      // Map the cursor Y to an insertion slot (0..N) CONTINUOUSLY: the first folder
      // whose vertical midpoint is below the cursor wins; past all of them → the end.
      // Mirrors the grid's computeInsertIndexFromY. The old test only set an index
      // while the cursor was literally inside a folder HEADER's rect, so the margins
      // between headers — and the entire body of an expanded folder — were dead zones
      // where dropFolderIndex fell back to null and the indicator flickered as the
      // cursor crossed a folder boundary. The dragged folder stays in the scan; a drop
      // at or adjacent to its own slot is a no-op (handled in handleMouseUp) and its
      // gap is suppressed by the showDropBefore/showDropAfter source-index guards. The
      // gap is inserted BEFORE the chosen folder, pushing that midpoint away from the
      // cursor, so the choice is self-stabilising rather than oscillating.
      const folders = profileOrder?.folders ?? [];
      let bestIndex = folders.length;
      for (let idx = 0; idx < folders.length; idx++) {
        const el = folderRefs.current.get(folders[idx].name);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) { bestIndex = idx; break; }
      }
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
          snapshotDragItems('[data-drag-item^="folder:"]');
          send({ type: 'profile:reorder', payload: { folders } });
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
  }, [dragFolder, dropFolderIndex, profileOrder, send, snapshotDragItems, maybeKickAutoScroll, folderDragActive]);

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
      data-drag-item={`profile:${p.name}`}
      onMouseDown={(e) => handleProfileMouseDown(e, p.name)}
      onClick={(e) => {
        // Don't fire click if we were dragging
        if (dragActive.current) { e.preventDefault(); return; }
        send({ type: 'profile:click', payload: { name: p.name } });
        // Blur the row after dispatching so it doesn't retain keyboard focus.
        (e.target as HTMLElement).blur();
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
            removeTitle={tt(`Remove window target (${targetLabel(p.windowTargetProcessName, p.windowTargetWindowTitle)})`, `Remover janela-alvo (${targetLabel(p.windowTargetProcessName, p.windowTargetWindowTitle)})`)}
            tip={targetLabel(p.windowTargetProcessName, p.windowTargetWindowTitle)}
            onRemove={(e) => { e.stopPropagation(); setConfirmRemoval({ kind: 'profileTarget', name: p.name, label: `window target (${targetLabel(p.windowTargetProcessName, p.windowTargetWindowTitle)})` }); }}
            className="w-3.5 h-3.5"
          >
            {/* No tooltip here — the RemovableChip wrapper carries it (the chip-level
                tip already embeds the .exe name via removeTitle, and a second tip
                on this span would stack on top of it). */}
            <span className="flex">
              <img
                src={`data:image/png;base64,${p.appIconBase64}`}
                alt=""
                className="w-3.5 h-3.5 object-contain pointer-events-none"
              />
            </span>
          </RemovableChip>
        )}
        {p.appIconBase64 && !p.hasWindowTarget && (
          // Inherited folder target — no tooltip (user request): the faded icon
          // is just a passive "this row inherits a target" cue, and the source
          // is managed on the folder, not here.
          <span className="shrink-0 flex">
            <img
              src={`data:image/png;base64,${p.appIconBase64}`}
              alt=""
              className="w-3.5 h-3.5 object-contain pointer-events-none opacity-55"
            />
          </span>
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
            removeTitle={tt(`Remove window target (${targetLabel(p.windowTargetProcessName, p.windowTargetWindowTitle)})`, `Remover janela-alvo (${targetLabel(p.windowTargetProcessName, p.windowTargetWindowTitle)})`)}
            tip={targetLabel(p.windowTargetProcessName, p.windowTargetWindowTitle)}
            onRemove={(e) => { e.stopPropagation(); setConfirmRemoval({ kind: 'profileTarget', name: p.name, label: `window target (${targetLabel(p.windowTargetProcessName, p.windowTargetWindowTitle)})` }); }}
          >
            <span>
              <Crosshair size={11} className="text-text-tertiary" />
            </span>
          </RemovableChip>
        ) : (!p.appIconBase64 && p.hasEffectiveTarget && p.effectiveTargetSource === 'folder') && (
          // Inherited from folder AND no icon resolved — fall back to the faded crosshair.
          // Removal must happen from the folder, not the row, so no ✕ overlay here.
          // No tooltip (user request) — passive inherited-target cue only.
          <span className="shrink-0 opacity-50">
            <Crosshair size={11} className="text-text-tertiary" />
          </span>
        )}

        {/* Trigger mode indicator — placed before the hotkey so the visual order
            right-to-left is: hotstring → hotkey → trigger icon → target crosshair.
            Tooltip shows only the mode name; the full description lives in the
            hotkey configuration dialog. */}
        {p.hotkey && p.triggerMode === 'onRelease' && (
          <span data-tip={tt('On Release', 'Ao soltar')} data-tip-pos="end" className="shrink-0 text-text-tertiary flex">
            <ArrowUpFromDot size={10} />
          </span>
        )}
        {p.hotkey && p.triggerMode === 'whilePressed' && (
          <span data-tip={tt('While Pressed', 'Enquanto pressionado')} data-tip-pos="end" className="shrink-0 text-text-tertiary flex">
            <Zap size={10} />
          </span>
        )}
        {p.hotkey && p.triggerMode === 'toggle' && (
          <span data-tip={tt('Toggle', 'Alternar')} data-tip-pos="end" className="shrink-0 text-text-tertiary flex">
            <Repeat size={10} />
          </span>
        )}

        {p.hotkey && (
          <RemovableChip
            removeTitle={tt(`Remove hotkey ${p.hotkey}`, `Remover hotkey ${p.hotkey}`)}
            onRemove={(e) => { e.stopPropagation(); setConfirmRemoval({ kind: 'hotkey', name: p.name, label: `hotkey ${p.hotkey}` }); }}
          >
            <KbdTag combo={p.hotkey} />
          </RemovableChip>
        )}

        {p.hotstring && (
          // Same visual tokens as the hotkey KbdTag chips (.kbd: elevated bg,
          // default border, secondary text) so the two trigger chips read as
          // siblings \u2014 the old accent-hover text made hotstrings look like a
          // different kind of thing.
          <RemovableChip
            removeTitle={tt(`Remove hotstring "${p.hotstring}"`, `Remover hotstring "${p.hotstring}"`)}
            onRemove={(e) => { e.stopPropagation(); setConfirmRemoval({ kind: 'hotstring', name: p.name, label: `hotstring "${p.hotstring}"` }); }}
            className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-bg-elevated border border-border-default text-text-secondary"
          ><span>
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
      {/* No overflow-hidden on the panel root: the data-tip tooltips (pos right/end)
          render outside the strip's box and would be clipped — same fix as the
          SettingsPanel. */}
      <div className={`flex flex-col bg-bg-surface border border-border-subtle rounded-ui shrink-0 transition-[width] duration-200 ${collapsed ? 'w-12' : 'w-[260px]'}`}>
        {collapsed ? (
          <>
            {/* Collapsed rail — mirrors the SettingsPanel rail: quick actions up
                top (new profile / search-and-expand), then profile avatars with
                an accent ring on the active one and a folder-colour dot. Fills the
                measured strip height; the last slot becomes a "+N expand" chip when
                there are more profiles than fit (no scrolling — a scroll list would
                clip the right-side tooltips). */}
            <div className="flex flex-col items-center gap-1 pt-3 pb-2 shrink-0">
              <button
                onClick={onToggleCollapse}
                className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
                data-tip={tt('Expand', 'Expandir')} data-tip-pos="right"
              >
                <ChevronsRight size={14} />
              </button>
              <button
                onClick={handleCreate}
                className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
                data-tip={tt('New profile', 'Novo perfil')} data-tip-pos="right"
              >
                <FilePlus size={14} />
              </button>
              <button
                onClick={() => { pendingFocusSearch.current = true; onToggleCollapse?.(); }}
                className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
                data-tip={tt('Search profiles', 'Buscar perfis')} data-tip-pos="right"
              >
                <Search size={14} />
              </button>
              <div className="w-6 my-1 border-t border-border-subtle" />
            </div>
            <div ref={railRef} className="flex-1 flex flex-col items-center gap-1 px-1 pb-2 overflow-hidden">
              {(() => {
                // Show all when they fit; otherwise reserve the last slot for the
                // "+N expand" chip (so visible = capacity − 1).
                const fitsAll = filtered.length <= railCapacity;
                const visible = fitsAll ? filtered : filtered.slice(0, Math.max(0, railCapacity - 1));
                const overflow = filtered.length - visible.length;
                return (
                  <>
                    {visible.map((p) => {
                      const folderColor = getProfileFolderColor(p.name);
                      return (
                        <button
                          key={p.name}
                          onClick={(e) => { send({ type: 'profile:click', payload: { name: p.name } }); (e.target as HTMLElement).blur(); }}
                          onContextMenu={(e) => handleContextMenu(e, p.name)}
                          className={`relative w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-colors shrink-0 ${
                            p.isActive
                              ? 'bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-accent'
                              : 'bg-bg-elevated text-text-secondary hover:bg-bg-card'
                          } ${p.isDisabled ? 'opacity-40' : ''}`}
                          style={p.isActive ? { boxShadow: '0 0 0 2px var(--color-accent)' } : undefined}
                          data-tip={p.hotkey ? `${p.name} · ${p.hotkey}` : p.name}
                          data-tip-pos="right"
                        >
                          {p.name.charAt(0).toUpperCase()}
                          {folderColor && (
                            <span
                              className="absolute -right-px -bottom-px w-[9px] h-[9px] rounded-full border-2 border-bg-surface"
                              style={{ background: folderColor }}
                            />
                          )}
                        </button>
                      );
                    })}
                    {overflow > 0 && (
                      <button
                        onClick={onToggleCollapse}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-semibold bg-bg-elevated text-text-tertiary hover:bg-bg-card hover:text-text-primary transition-colors shrink-0"
                        data-tip={tt(`${overflow} more — expand`, `${overflow} mais — expandir`)} data-tip-pos="right"
                      >
                        +{overflow}
                      </button>
                    )}
                  </>
                );
              })()}
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
              data-tip={tt('Collapse profiles panel', 'Recolher painel de perfis')}
            >
              <ChevronsLeft size={14} />
            </button>
            <button
              onClick={handleOpenProfilesFolder}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
              data-tip={tt('Open profiles folder', 'Abrir pasta de perfis')}
            >
              <ExternalLink size={14} />
            </button>
            <button
              onClick={handleExportClick}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
              data-tip={tt('Import or export profiles', 'Importar ou exportar perfis')}
            >
              <ArrowLeftRight size={14} />
            </button>
            <button
              onClick={handleCreateFolder}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
              data-tip={tt('New folder', 'Nova pasta')}
            >
              <FolderPlus size={14} />
            </button>
            <button
              onClick={handleCreate}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
              data-tip={tt('New profile', 'Novo perfil')} data-tip-pos="end"
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
              ref={searchInputRef}
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
            // Flat search results — with an explicit empty state instead of the
            // silent blank list the panel used to show.
            filtered.length > 0 ? (
              filtered.map(renderProfileRow)
            ) : (
              <div className="flex flex-col items-center gap-1.5 px-3 py-8 text-center select-none">
                <SearchX size={22} className="text-text-disabled" />
                <span className="text-xs font-medium text-text-secondary">No results for "{trimmedQuery}"</span>
                <button
                  onClick={() => setSearchQuery('')}
                  className="text-[11px] text-accent hover:text-accent-hover transition-colors"
                >
                  Clear search
                </button>
              </div>
            )
          ) : profiles.length === 0 ? (
            // First-run empty state — mirrors the Macro/Clicker empty-state
            // vocabulary (icon, one-liner, action).
            <div className="flex flex-col items-center gap-1.5 px-3 py-8 text-center select-none">
              <FolderOpen size={24} className="text-text-disabled" />
              <span className="text-xs font-medium text-text-secondary">No profiles yet</span>
              <span className="text-[11px] text-text-tertiary leading-snug">Record a macro and save it, or create an empty profile to start.</span>
              <button
                onClick={handleCreate}
                className="mt-1 px-3 py-1 rounded text-[11px] text-white bg-accent-solid hover:bg-accent-solid/85 transition-colors"
              >
                + New profile
              </button>
            </div>
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
                // Suppress the gap at BOTH no-op slots: dropping at the dragged folder's
                // own index OR index+1 leaves it exactly where it is (mirrors handleMouseUp's
                // `fromIdx !== dropFolderIndex && fromIdx !== dropFolderIndex - 1` guard).
                // showDropAfter already excluded both; showDropBefore was missing the +1, so
                // a misleading gap popped in just past the dragged folder even though releasing
                // there did nothing — the residual boundary glitch.
                const showDropBefore = dragFolder && dropFolderIndex === folderIdx && dropFolderIndex !== (profileOrder?.folders ?? []).findIndex(f => f.name === dragFolder) && dropFolderIndex !== (profileOrder?.folders ?? []).findIndex(f => f.name === dragFolder) + 1;
                // showDropAfter is ONLY for the end-of-list slot (after the last
                // folder) — for any middle insertion the gap is rendered by the
                // next folder's showDropBefore. Without the last-folder guard BOTH
                // fired at every interior boundary, stacking two gaps (~64px) and
                // doubling the layout displacement the FLIP snapshot had to undo.
                const showDropAfter = dragFolder && folderIdx === (profileOrder?.folders ?? []).length - 1 && dropFolderIndex === folderIdx + 1 && dropFolderIndex !== (profileOrder?.folders ?? []).findIndex(f => f.name === dragFolder) && dropFolderIndex !== (profileOrder?.folders ?? []).findIndex(f => f.name === dragFolder) + 1;
                return (
                  <div key={folder.name}>
                    {/* Insertion gap — a real (layout-affecting) slot so neighbouring
                        folders physically part to open space, matching the grid's drag
                        language (replaces the old accent rail line). */}
                    {showDropBefore && (
                      <div
                        className="drop-gap-slot mx-1 my-1 rounded border-2 border-dashed overflow-hidden"
                        style={{
                          height: '30px',
                          borderColor: 'color-mix(in srgb, var(--color-accent) 45%, transparent)',
                          background: 'color-mix(in srgb, var(--color-accent) 6%, transparent)',
                        }}
                      />
                    )}
                    <div
                      ref={(el) => { if (el) folderRefs.current.set(folder.name, el); else folderRefs.current.delete(folder.name); }}
                      data-drag-item={`folder:${folder.name}`}
                      className={`rounded transition-colors ${isDragOver ? 'bg-accent-solid/20 ring-2 ring-accent-solid/50' : ''} ${isFolderDragging ? 'opacity-50' : ''}`}
                    >
                      <div
                        // px-2.5 / gap-2 matches the profile rows — folders used to sit
                        // 2px tighter for no reason, which read as misalignment.
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 mt-1 rounded text-left hover:bg-bg-card transition-colors group cursor-grab active:cursor-grabbing select-none ${selectedFolder === folder.name ? 'bg-bg-card ring-1 ring-accent-solid/30' : ''}`}
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
                            removeTitle={tt(`Remove folder target (${targetLabel(folder.windowTargetProcessName, folder.windowTargetWindowTitle)})`, `Remover alvo da pasta (${targetLabel(folder.windowTargetProcessName, folder.windowTargetWindowTitle)})`)}
                            tip={targetLabel(folder.windowTargetProcessName, folder.windowTargetWindowTitle)}
                            onRemove={(e) => { e.stopPropagation(); setConfirmRemoval({ kind: 'folderTarget', name: folder.name, label: `folder target (${targetLabel(folder.windowTargetProcessName, folder.windowTargetWindowTitle)})` }); }}
                            className={`w-3.5 h-3.5 ${folderAllDisabled ? 'opacity-40' : ''}`}
                          >
                            <span className="flex">
                              <img
                                src={`data:image/png;base64,${folder.appIconBase64}`}
                                alt=""
                                className="w-3.5 h-3.5 object-contain pointer-events-none"
                              />
                            </span>
                          </RemovableChip>
                        )}
                        <span className={`text-xs font-medium flex-1 truncate ${folderAllDisabled ? 'text-text-disabled' : 'text-text-secondary'}`}>{folder.name}</span>
                        {folder.hasWindowTarget && !folder.appIconBase64 && (
                          <RemovableChip
                            variant="circle"
                            removeTitle={tt(`Remove folder target (${targetLabel(folder.windowTargetProcessName, folder.windowTargetWindowTitle)})`, `Remover alvo da pasta (${targetLabel(folder.windowTargetProcessName, folder.windowTargetWindowTitle)})`)}
                            tip={targetLabel(folder.windowTargetProcessName, folder.windowTargetWindowTitle)}
                            onRemove={(e) => { e.stopPropagation(); setConfirmRemoval({ kind: 'folderTarget', name: folder.name, label: `folder target (${targetLabel(folder.windowTargetProcessName, folder.windowTargetWindowTitle)})` }); }}
                          >
                            <span>
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
                      <div
                        className="drop-gap-slot mx-1 my-1 rounded border-2 border-dashed overflow-hidden"
                        style={{
                          height: '30px',
                          borderColor: 'color-mix(in srgb, var(--color-accent) 45%, transparent)',
                          background: 'color-mix(in srgb, var(--color-accent) 6%, transparent)',
                        }}
                      />
                    )}
                  </div>
                );
              })}

              {/* Ungrouped Section */}
              <div
                ref={ungroupedRef}
                className={`rounded transition-colors ${dropTarget === '__ungrouped__' && dragProfile ? 'bg-accent-solid/20 ring-2 ring-accent-solid/50' : ''}`}
              >
                {ungroupedProfiles.length > 0 && ((profileOrder?.pinned?.length ?? 0) > 0 || (profileOrder?.folders?.length ?? 0) > 0) && (
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
              <ChevronRight size={12} className="ml-auto text-text-tertiary" />
            </button>
            {moveMenuOpen && (
              <div
                ref={moveFlyout.ref}
                className={`absolute bg-transparent ${moveFlyout.flipX ? 'right-full' : 'left-full'} ${moveFlyout.flipY ? 'bottom-0' : 'top-0'}`}
                style={moveFlyout.flipX ? { paddingRight: '4px' } : { paddingLeft: '4px' }}
              >
              <div className="py-1 bg-bg-card border border-border-default rounded-md shadow-lg z-[60] whitespace-nowrap">
                {(profileOrder?.folders ?? []).map(f => (
                  <button
                    key={f.name}
                    onClick={() => handleMoveToFolder(contextMenu.profileName, f.name)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-bg-elevated transition-colors ${
                      getProfileFolder(contextMenu.profileName) === f.name ? 'text-accent' : 'text-text-primary'
                    }`}
                  >
                    <FolderOpen size={12} style={{ color: f.color }} />
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
                      <FolderMinus size={12} className="text-text-tertiary" />
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

          {/* ── State ── Duplicate sits above Disable (promoted from the More
              submenu at user request); Pin/Unpin moved INTO More. */}
          <button
            onClick={() => handleDuplicate(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Copy size={13} className="text-text-tertiary" />
            Duplicate
          </button>

          <button
            onClick={() => handleToggleDisable(contextMenu.profileName)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Ban size={13} className="text-text-tertiary" />
            {profile?.isDisabled ? 'Enable' : 'Disable'}
          </button>

          <div className="my-1 border-t border-border-subtle" />

          {/* ── More ▸ — low-frequency entry points tucked into a submenu so the top
              level stays focused on rename / triggers / state. Mirrors the grid context
              menu's "More". Edit info (metadata), Pin/Unpin, Open in Explorer (debug:
              show the .json on disk). */}
          <div
            className="relative"
            onMouseEnter={() => setShowProfileMoreMenu(contextMenu.profileName)}
            onMouseLeave={() => setShowProfileMoreMenu(null)}
          >
            <button
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <MoreHorizontal size={13} className="text-text-tertiary" />
              More
              <ChevronRight size={12} className="ml-auto text-text-tertiary" />
            </button>
            {moreMenuOpen && (
              <div
                ref={moreFlyout.ref}
                className={`absolute bg-transparent ${moreFlyout.flipX ? 'right-full' : 'left-full'} ${moreFlyout.flipY ? 'bottom-0' : 'top-0'}`}
                style={moreFlyout.flipX ? { paddingRight: '4px' } : { paddingLeft: '4px' }}
              >
                <div className="py-1 bg-bg-card border border-border-default rounded-md shadow-lg z-[60] whitespace-nowrap">
                  <button
                    onClick={() => handleShowInfo(contextMenu.profileName)}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
                  >
                    <Info size={13} className="text-text-tertiary" />
                    Edit info…
                  </button>
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
                    onClick={() => { handleOpenFolder(contextMenu.profileName); setContextMenu(null); }}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
                  >
                    <ExternalLink size={13} className="text-text-tertiary" />
                    Open in Explorer
                  </button>
                  {/* Convert action coordinates — relocated from Target Configuration (rarely
                      used). The backend convert is ACTIVE-profile scoped (HandleConvertCoordinates
                      → ExecuteConvertCoordinates rewrites the loaded profile), and HandleProfileClick
                      sets CurrentProfileName only AFTER its awaits — so a click+convert burst would
                      race and convert the previously-active profile. Gate to the active profile
                      instead: enabled only when THIS row is the loaded one, so convert always hits
                      it. (Right-click a profile you haven't opened → disabled with a hint.) */}
                  <div className="my-1 border-t border-border-subtle" />
                  <button
                    disabled={!profile?.isActive}
                    onClick={() => {
                      send({ type: 'profile:convertCoordinates', payload: { direction: 'toRelative' } });
                      setContextMenu(null);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    data-tip={profile?.isActive ? tt("Rewrite this profile's action X/Y to be relative to its target window", 'Reescreve o X/Y das ações deste perfil para ser relativo à janela-alvo') : tt('Open this profile first — convert applies to the loaded profile', 'Abra este perfil primeiro — a conversão se aplica ao perfil carregado')}
                  >
                    <ArrowLeftRight size={13} className="text-text-tertiary" />
                    Convert coords → Relative
                  </button>
                  <button
                    disabled={!profile?.isActive}
                    onClick={() => {
                      send({ type: 'profile:convertCoordinates', payload: { direction: 'toAbsolute' } });
                      setContextMenu(null);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    data-tip={profile?.isActive ? tt("Rewrite this profile's action X/Y to absolute screen coordinates", 'Reescreve o X/Y das ações deste perfil para coordenadas absolutas de tela') : tt('Open this profile first — convert applies to the loaded profile', 'Abra este perfil primeiro — a conversão se aplica ao perfil carregado')}
                  >
                    <ArrowLeftRight size={13} className="text-text-tertiary" />
                    Convert coords → Absolute
                  </button>
                </div>
              </div>
            )}
          </div>

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
      {folderContextMenu && folderMenuPos && (
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
          style={{ left: folderMenuPos.x, top: folderMenuPos.y }}
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
              <ChevronRight size={12} className="ml-auto text-text-tertiary" />
            </button>
            {colorMenuOpen && (
              <div
                ref={colorFlyout.ref}
                className={`absolute min-w-0 bg-transparent ${colorFlyout.flipX ? 'right-full' : 'left-full'} ${colorFlyout.flipY ? 'bottom-0' : 'top-0'}`}
                style={colorFlyout.flipX ? { paddingRight: '4px' } : { paddingLeft: '4px' }}
              >
              <div className="p-2.5 bg-bg-card border border-border-default rounded-md shadow-lg z-[60]">
                <div className="flex flex-wrap gap-1.5" style={{ width: '156px' }}>
                  {FOLDER_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => handleSetFolderColor(folderContextMenu.folderName, c)}
                      className="w-[26px] h-[26px] rounded-full border-2 hover:scale-110 transition-transform"
                      style={{ backgroundColor: c, borderColor: (profileOrder?.folders ?? []).find(f => f.name === folderContextMenu.folderName)?.color === c ? 'var(--color-text-primary)' : 'transparent' }}
                      data-tip={c}
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
            {createProfileNameTaken && (
              <p className="text-[11px] text-recording mt-2">A profile named "{dialogValue.trim()}" already exists.</p>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowCreateDialog(false)}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmCreate}
                disabled={!dialogValue.trim() || createProfileNameTaken}
                className="px-4 py-1.5 text-xs text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-40"
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
            {renameProfileNameTaken && (
              <p className="text-[11px] text-recording mt-2">A profile named "{dialogValue.trim()}" already exists.</p>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowRenameDialog(null)}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmRename}
                disabled={!dialogValue.trim() || renameProfileNameTaken}
                className="px-4 py-1.5 text-xs text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-40"
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

      {/* Remove-confirmation Dialog — gate for the inline ✕ removals (hotkey /
          hotstring / profile target / folder target). Same shape as the delete
          dialog; Enter confirms, Esc cancels. */}
      {confirmRemoval && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onKeyDown={(e) => { if (e.key === 'Enter') runConfirmedRemoval(); else if (e.key === 'Escape') setConfirmRemoval(null); }}>
          <div className="w-[340px] bg-bg-card border border-border-default rounded-lg p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Are you sure?</h3>
            <p className="text-sm text-text-secondary">
              Remove {confirmRemoval.label} from <span className="text-text-primary font-medium">'{confirmRemoval.name}'</span>?
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setConfirmRemoval(null)}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                No
              </button>
              <button
                autoFocus
                onClick={runConfirmedRemoval}
                className="px-4 py-1.5 text-xs text-white bg-recording hover:bg-recording/80 rounded transition-colors"
              >
                Yes, remove
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
              data-tip={tt('Press the key combination to capture it here (Ctrl, Alt, Win, F-keys all work).', 'Pressione a combinação de teclas para capturá-la aqui (Ctrl, Alt, Win, F-keys funcionam).')}
              className="w-full h-9 px-3 text-sm font-mono text-accent bg-bg-input border border-accent-solid rounded text-center outline-none"
            />

            {/* Trigger Mode */}
            <div className="mt-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-text-disabled mb-1.5">Trigger Mode</div>
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  { id: 'onPress', label: 'On Press', help: tt('Fires once when the key is pressed down.', 'Dispara uma vez quando a tecla é pressionada.') },
                  { id: 'onRelease', label: 'On Release', help: tt('Fires once when the key is released.', 'Dispara uma vez quando a tecla é solta.') },
                  { id: 'whilePressed', label: 'While Pressed', help: tt('Runs in infinite loop while held. Stops on release.', 'Executa em loop infinito enquanto pressionada. Para ao soltar.') },
                  { id: 'toggle', label: 'Toggle', help: tt('Press to start an infinite loop, press again to stop.', 'Pressione para iniciar um loop infinito, pressione de novo para parar.') },
                ] as const).map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setHotkeyTriggerMode(opt.id)}
                    className={`h-7 text-[11px] rounded border transition-colors ${
                      hotkeyTriggerMode === opt.id
                        ? 'bg-accent-solid/15 border-accent-solid/40 text-accent'
                        : 'bg-transparent border-border-default text-text-tertiary hover:text-text-secondary hover:border-border-strong'
                    }`}
                    data-tip={opt.help}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-[10px] text-text-tertiary leading-tight min-h-[14px]">
                {hotkeyTriggerMode === 'onPress' && 'Fires once when the key is pressed down.'}
                {hotkeyTriggerMode === 'onRelease' && 'Fires once when the key is released.'}
                {hotkeyTriggerMode === 'whilePressed' && 'Runs in infinite loop while held. Stops on release.'}
                {hotkeyTriggerMode === 'toggle' && 'Press to start an infinite loop, press again to stop.'}
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
              data-tip={tt('Text you type that auto-triggers this profile. Letters, digits and - . / , ; = only.', 'Texto que você digita e que aciona este perfil automaticamente. Só letras, dígitos e - . / , ; = .')}
              className="w-full h-9 px-3 text-sm font-mono text-accent bg-bg-input border border-accent-solid rounded outline-none"
            />
            <p className="text-[11px] text-text-tertiary mt-1.5">
              Min 2 characters.
            </p>

            <button
              type="button"
              onClick={() => setHotstringInstant(!hotstringInstant)}
              data-tip={tt('On: fires the moment the last character is typed. Off: waits for Enter, Space or Tab first.', 'Ligado: dispara assim que o último caractere é digitado. Desligado: espera por Enter, Space ou Tab antes.')}
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
        // Count only visible + selected so the filter never inflates the total with hidden picks.
        const visibleNames = profiles.filter(p => matchesExport(p.name)).map(p => p.name);
        const selectedCount = visibleNames.filter(n => exportSelection[n]).length;

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
              <span className="ml-auto text-[10px] text-text-disabled">{selectedCount}/{visibleNames.length}</span>
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
                      <FolderOpen size={12} style={{ color: f.color }} className="shrink-0" />
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
              data-tip={tt('Name for the new folder. Must be unique (case-insensitive).', 'Nome da nova pasta. Deve ser único (sem diferenciar maiúsculas).')}
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
            {createFolderNameTaken && (
              <p className="text-[11px] text-recording mt-2">A folder named "{folderDialogName.trim()}" already exists.</p>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowCreateFolderDialog(false)}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmCreateFolder}
                disabled={!folderDialogName.trim() || createFolderNameTaken}
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
              data-tip={tt('New name for this folder. Must be unique (case-insensitive).', 'Novo nome para esta pasta. Deve ser único (sem diferenciar maiúsculas).')}
              className="w-full h-9 px-3 text-sm text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
            />
            {renameFolderNameTaken && (
              <p className="text-[11px] text-recording mt-2">A folder named "{folderDialogName.trim()}" already exists.</p>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowRenameFolderDialog(null)}
                className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmRenameFolder}
                disabled={!folderDialogName.trim() || renameFolderNameTaken}
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
            onSubmit={(payload, opts) => {
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
                  // Forwarded from the "Apply target & convert" path so the backend
                  // chains ExecuteConvertCoordinates after the save completes.
                  convertDirection: payload.convertDirection,
                },
              });
              // Apply target & convert wants the toast to land while the dialog is still
              // visible — opts.keepOpen carries that intent. Plain Set Target / Remove
              // close the dialog as before.
              if (!opts?.keepOpen) setShowWindowTargetDialog(null);
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
            convertibleActionCount={convertibleActionCount}
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
              // Route through the handler (not a bare send) so this path also gets
              // the 10s undo toast, matching the profile-target dialog's onRemove.
              handleRemoveFolderWindowTarget(folderName);
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

      {/* Floating drag ghost — shared by profile drag and folder drag. Centred on
          the cursor with the same lifted-card treatment (tilt, shadow, translucency)
          as the ActionTable's dnd-kit DragOverlay, so both panels speak the same
          drag language. transform-based positioning keeps it on the compositor. */}
      {dragCursorPos !== null && (dragProfile || dragFolder) && (
        <div
          className="fixed pointer-events-none z-50"
          style={{
            top: 0,
            left: 0,
            transform: `translate3d(${dragCursorPos.x}px, ${dragCursorPos.y}px, 0) translate(-50%, -50%) rotate(1.5deg)`,
            willChange: 'transform',
          }}
        >
          <div
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-bg-card border border-border-default text-[11px] font-medium text-text-primary"
            style={{
              opacity: 0.88,
              boxShadow: '0 12px 32px rgba(0,0,0,0.5), 0 0 0 1px color-mix(in srgb, var(--color-accent) 35%, transparent)',
            }}
          >
            {dragFolder ? <FolderOpen size={12} className="text-accent shrink-0" /> : <FilePlus size={12} className="text-accent shrink-0" />}
            {dragFolder ?? dragProfile}
          </div>
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
