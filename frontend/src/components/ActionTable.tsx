import { useRef, useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Mouse, Keyboard, ArrowUp, ArrowDown, Zap, Type, Trash2, ChevronRight, Plus, MoreHorizontal, Pencil, ScanSearch, Globe, CheckCheck, Workflow, Pause, Code2, Files } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { useToast } from '../state/ToastContext';
import { getDisplayKey, getDisplayX, getDisplayY, getActionTypeColors } from '../utils/displayUtils';
import { SendTextDialog } from './SendTextDialog';
import { SendTextPreview } from './SendTextPreview';
import { RunProfileDialog } from './RunProfileDialog';
import { BulkActionBar } from './BulkActionBar';
import { Checkbox, CheckboxBox } from './Checkbox';
import type { ColumnVisibility } from './Toolbar';

function ActionIcon({ actionType }: { actionType: string }) {
  const size = 12;
  if (actionType.startsWith('Browser')) return <Globe size={size} />;
  if (actionType.includes('Click')) return <Mouse size={size} />;
  if (actionType === 'ScrollUp') return <ArrowUp size={size} />;
  if (actionType === 'ScrollDown') return <ArrowDown size={size} />;
  if (actionType.startsWith('Key')) return <Keyboard size={size} />;
  if (actionType === 'SendText') return <Type size={size} />;
  if (actionType === 'WaitImage') return <ScanSearch size={size} />;
  if (actionType === 'RunProfile') return <Workflow size={size} />;
  if (actionType === 'Pause') return <Pause size={size} />;
  return <Zap size={size} />;
}

interface EditingCell {
  index: number;
  field: 'delay' | 'comment' | 'x' | 'y' | 'key';
}

interface ActionTableProps {
  columnVisibility: ColumnVisibility;
  onOpenSheet?: (index: number) => void;
}

export function ActionTable({ columnVisibility, onOpenSheet }: ActionTableProps) {
  const { actions, highlightedActionIndex, buttonStates, activeProfile, pauseState } = useAppState();
  const { send } = useBridge();
  const selectionRef = useSelectionRef();
  const scrollRef = useRef<HTMLDivElement>(null);
  const highlightedRowRef = useRef<HTMLTableRowElement>(null);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  // Idle-cancel timer for the Key column capture. Without an explicit "Esc cancels" rule
  // (so the user CAN actually assign Escape as a hotkey), the only way out is to click
  // away or let the field time out. Reset on every keypress so an active user is never
  // surprised by a sudden cancel mid-press.
  const keyCaptureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const KEY_CAPTURE_TIMEOUT_MS = 4000;
  const armKeyCaptureTimer = useCallback(() => {
    if (keyCaptureTimerRef.current) clearTimeout(keyCaptureTimerRef.current);
    keyCaptureTimerRef.current = setTimeout(() => {
      editInputRef.current?.blur();
    }, KEY_CAPTURE_TIMEOUT_MS);
  }, []);
  const disarmKeyCaptureTimer = useCallback(() => {
    if (keyCaptureTimerRef.current) {
      clearTimeout(keyCaptureTimerRef.current);
      keyCaptureTimerRef.current = null;
    }
  }, []);
  // Unmount cleanup so the idle-cancel timer can't fire against a stale editInputRef
  // (e.g. profile switch wipes the rows while a Key cell is being edited).
  useEffect(() => disarmKeyCaptureTimer, [disarmKeyCaptureTimer]);
  const lastClickedIndex = useRef<number | null>(null);
  const prevActionsLength = useRef(actions.length);
  const prevProfileRef = useRef(activeProfile);
  const wasRecording = useRef(false);
  const [sendTextEdit, setSendTextEdit] = useState<{ index: number; text: string } | null>(null);
  const [runProfileEdit, setRunProfileEdit] = useState<{ index: number; profileName: string; repeatCount: number } | null>(null);
  const [dragIndices, setDragIndices] = useState<number[] | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; rowIndex: number } | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<'below' | null>(null);
  const [submenuFlip, setSubmenuFlip] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [sendTextInsert, setSendTextInsert] = useState<{ insertIndex: number } | null>(null);
  const { showToast } = useToast();
  const contextMenuEnabled = !buttonStates.recordingActive && !buttonStates.replayActive;

  // Row action button handler (opens context menu at button position)
  const handleRowActionClick = useCallback((idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!contextMenuEnabled) return;
    if (!selectedIndices.has(idx)) {
      setSelectedIndices(new Set([idx]));
      lastClickedIndex.current = idx;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setActiveSubmenu(null);
    setContextMenu({ x: rect.left, y: rect.bottom + 4, rowIndex: idx });
  }, [contextMenuEnabled, selectedIndices]);

  // Suppress hotkeys while SendText edit dialog or inline key editing is active

  // Clear selection when recording stops so next recording appends normally
  useEffect(() => {
    if (wasRecording.current && !buttonStates.recordingActive) {
      setSelectedIndices(new Set());
    }
    wasRecording.current = buttonStates.recordingActive;
  }, [buttonStates.recordingActive]);

  // Sync selection to shared ref and push to C# bridge
  useEffect(() => {
    selectionRef.current = selectedIndices;
    send({ type: 'selection:changed', payload: { indices: Array.from(selectedIndices) } });
  }, [selectedIndices, selectionRef, send]);

  // Scroll to top when replay starts
  useEffect(() => {
    if (buttonStates.replayActive && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [buttonStates.replayActive]);

  // Auto-scroll to highlighted row during replay
  useEffect(() => {
    if (highlightedActionIndex !== null && highlightedRowRef.current) {
      highlightedRowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [highlightedActionIndex]);

  // Preserve scroll position across action list updates (undo/redo, edits, bulk ops)
  const savedScrollTop = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => { savedScrollTop.current = el.scrollTop; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!buttonStates.recordingActive && !buttonStates.replayActive && scrollRef.current) {
      const saved = savedScrollTop.current;
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = saved;
      });
    }
  }, [actions, buttonStates.recordingActive, buttonStates.replayActive]);

  // Auto-scroll when new actions are added during recording
  // In append mode (no selection): scroll to bottom
  // In insert mode (has selection): keep viewport stable
  useEffect(() => {
    if (buttonStates.recordingActive && actions.length > prevActionsLength.current && scrollRef.current) {
      if (selectionRef.current.size === 0) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
    prevActionsLength.current = actions.length;
  }, [actions.length, selectionRef, buttonStates.recordingActive]);

  // Scroll to top only on profile switch (not on edits or manual additions)
  useEffect(() => {
    if (activeProfile !== prevProfileRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
    prevProfileRef.current = activeProfile;
  }, [activeProfile]);

  // Focus edit input when entering edit mode
  useEffect(() => {
    if (editingCell && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingCell]);

  // Clear invalid selection indices when actions change
  useEffect(() => {
    setSelectedIndices(prev => {
      const valid = new Set<number>();
      prev.forEach(i => { if (i < actions.length) valid.add(i); });
      return valid.size === prev.size ? prev : valid;
    });
  }, [actions.length]);

  // Listen for external selection updates (e.g. Move Up/Down from Toolbar)
  useEffect(() => {
    const handler = (e: Event) => {
      const indices = (e as CustomEvent).detail as number[];
      setSelectedIndices(new Set(indices));
      lastClickedIndex.current = indices[0] ?? null;
    };
    window.addEventListener('selection:set', handler);
    return () => window.removeEventListener('selection:set', handler);
  }, []);

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (
        contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)
      ) {
        setContextMenu(null);
        setMenuPos(null);
        setActiveSubmenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu(null);
        setMenuPos(null);
        setActiveSubmenu(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [contextMenu]);

  // Two-pass context menu positioning (same pattern as ProfilePanel)
  useEffect(() => {
    if (!contextMenu) { setMenuPos(null); return; }
    setMenuPos({ x: -9999, y: -9999 });
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu || !menuPos) return;
    if (menuPos.x === -9999) {
      requestAnimationFrame(() => {
        const el = contextMenuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        let x = contextMenu.x;
        let y = contextMenu.y;
        if (y + rect.height > window.innerHeight - 8) {
          y = Math.max(8, contextMenu.y - rect.height);
        }
        if (x + rect.width > window.innerWidth - 8) {
          x = Math.max(8, window.innerWidth - rect.width - 8);
        }
        // Flip submenu to left if not enough space on the right for menu + submenu (~170px)
        setSubmenuFlip(x + rect.width + 174 > window.innerWidth);
        setMenuPos({ x, y });
      });
    }
  }, [contextMenu, menuPos]);

  // Handle row click with selection logic
  const handleRowClick = useCallback((idx: number, e: React.MouseEvent) => {
    if (editingCell) return;
    if (dragOccurred.current) { dragOccurred.current = false; return; }

    setSelectedIndices(prev => {
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        lastClickedIndex.current = idx;
        return next;
      }

      if (e.shiftKey && lastClickedIndex.current !== null) {
        const start = Math.min(lastClickedIndex.current, idx);
        const end = Math.max(lastClickedIndex.current, idx);
        const next = new Set(prev);
        for (let i = start; i <= end; i++) next.add(i);
        return next;
      }

      // Toggle: clicking an already-selected row (single selection) deselects it
      if (prev.size === 1 && prev.has(idx)) {
        lastClickedIndex.current = null;
        return new Set();
      }

      lastClickedIndex.current = idx;
      return new Set([idx]);
    });
  }, [editingCell]);

  // Start editing a cell
  const startEdit = useCallback((index: number, field: EditingCell['field'], currentValue: string) => {
    setEditingCell({ index, field });
    setEditValue(currentValue);
  }, []);

  // Commit the edit
  const commitEdit = useCallback(() => {
    if (!editingCell) return;
    send({
      type: 'actions:edit',
      payload: { index: editingCell.index, field: editingCell.field, value: editValue },
    });
    setEditingCell(null);
  }, [editingCell, editValue, send]);

  // Cancel the edit
  const cancelEdit = useCallback(() => {
    setEditingCell(null);
  }, []);

  // Handle keyboard on the table container
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (editingCell || sendTextEdit || sendTextInsert) return;

    if (e.key === 'Delete' && selectedIndices.size > 0) {
      e.preventDefault();
      send({ type: 'actions:delete', payload: { indices: Array.from(selectedIndices) } });
      setSelectedIndices(new Set());
    }

    if (e.key === 'a' && (e.ctrlKey || e.metaKey) && actions.length > 0) {
      e.preventDefault();
      setSelectedIndices(new Set(actions.map((_, i) => i)));
    }

    if (e.key === 'Escape' && selectedIndices.size > 0) {
      e.preventDefault();
      setSelectedIndices(new Set());
    }
  }, [editingCell, sendTextEdit, sendTextInsert, selectedIndices, send, actions]);

  // Handle edit input key events
  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }, [commitEdit, cancelEdit]);

  // Key capture for editing the Key column — captures the pressed key name (like recording).
  // Esc is intentionally allowed through as a capturable key; cancelling the capture is done
  // by clicking away or letting the idle timer fire (see armKeyCaptureTimer above).
  const handleKeyCaptureKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Any keypress (even a modifier on the way) means the user is still engaged — push
    // the idle-cancel timeout further out.
    armKeyCaptureTimer();

    // Map the pressed key to the internal key name used by C# KeyUtils
    let keyName: string;
    const numpadMap: Record<string, string> = {
      Numpad0: 'Num0', Numpad1: 'Num1', Numpad2: 'Num2', Numpad3: 'Num3',
      Numpad4: 'Num4', Numpad5: 'Num5', Numpad6: 'Num6', Numpad7: 'Num7',
      Numpad8: 'Num8', Numpad9: 'Num9',
      NumpadMultiply: 'NumMultiply', NumpadDivide: 'NumDivide',
      NumpadAdd: 'NumAdd', NumpadSubtract: 'NumSubtract',
    };
    // NumpadDecimal/NumpadEnter excluded — they fall through to the single-char and
    // 'Enter' branches respectively, matching what recording produces (literal "."
    // and "Enter" since they share VK codes with regular . and Enter).

    // Canonical names matching KeyUtils.NormalizeKeyName in the C# backend. Earlier
    // versions of this map used WinForms Keys-enum names ("Return", "Back", "Prior",
    // "Next", "Capital", numeric codes for modifiers) which don't appear in
    // KeyUtils.VirtualKeyMap and aren't valid ConsoleKey members — so a value
    // entered via this capture path resolved to "key not found" at replay time and
    // the action silently no-op'd. Fixed to use the same names recording produces.
    if (e.code.startsWith('Numpad') && e.code !== 'NumpadEnter' && e.code !== 'NumpadDecimal') {
      keyName = numpadMap[e.code] ?? e.code;
    } else if (e.key === ' ') keyName = 'Space';
    else if (e.key === 'Enter') keyName = 'Enter';
    else if (e.key === 'Backspace') keyName = 'Backspace';
    else if (e.key === 'ArrowUp') keyName = 'Up';
    else if (e.key === 'ArrowDown') keyName = 'Down';
    else if (e.key === 'ArrowLeft') keyName = 'Left';
    else if (e.key === 'ArrowRight') keyName = 'Right';
    else if (e.key === 'Control') keyName = 'Ctrl';
    else if (e.key === 'Shift') keyName = 'Shift';
    // AltGraph (AltGr on ABNT2/AZERTY/etc.) is Ctrl+Alt internally; tag it as Alt
    // here — recording produces a Ctrl+Alt pair, this single Alt is the closer
    // approximation for a manual insert.
    else if (e.key === 'Alt' || e.key === 'AltGraph') keyName = 'Alt';
    else if (e.key === 'Tab') keyName = 'Tab';
    else if (e.key === 'CapsLock') keyName = 'CapsLock';
    else if (e.key === 'NumLock') keyName = 'NumLock';
    else if (e.key === 'ScrollLock') keyName = 'ScrollLock';
    else if (e.key === 'Pause') keyName = 'Pause';
    else if (e.key === 'PrintScreen') keyName = 'PrintScreen'; // ⚠ Chrome/Firefox usually only fire keyup for PrtScn — capture here is best-effort
    else if (e.key === 'ContextMenu') keyName = 'VK_93'; // Menu key (VK_APPS) — recording produces "VK_93" via the SafeConsoleKeyName fallback
    else if (e.key === 'Delete') keyName = 'Delete';
    else if (e.key === 'Insert') keyName = 'Insert';
    else if (e.key === 'Home') keyName = 'Home';
    else if (e.key === 'End') keyName = 'End';
    else if (e.key === 'PageUp') keyName = 'PageUp';
    else if (e.key === 'PageDown') keyName = 'PageDown';
    else if (e.key === 'Escape') keyName = 'Escape';
    else if (e.key === 'F1') keyName = 'F1';
    else if (e.key.startsWith('F') && e.key.length <= 3 && !isNaN(Number(e.key.slice(1)))) keyName = e.key;
    else if (e.key === 'Meta') return; // Ignore Win key
    // Dead keys (´`^~¨ on ABNT2/AZERTY/QWERTZ) — browser fires e.key === 'Dead'
    // because it's waiting to compose with the next char ('+a → á). Recover the
    // intended char from e.code (layout-independent physical position).
    else if (e.key === 'Dead') {
      const deadCodeMap: Record<string, string> = {
        Backquote: '`', Quote: "'", BracketLeft: '[', BracketRight: ']',
        Minus: '-', Equal: '=', Digit6: '^',
      };
      keyName = deadCodeMap[e.code];
      if (!keyName) return;
    }
    else if (e.key.length === 1) {
      // Single character: letters → uppercase, digits → bare "0"-"9" (was "D5" via
      // ConsoleKey fallback — works but non-canonical), symbols → literal char
      // (matches KeyUtils' VkToCharCurrentLayout / VkKeyScanEx layout-portable path).
      const c = e.key.toUpperCase();
      if (/\d/.test(c)) keyName = c;
      else if (/[A-Z]/.test(c)) keyName = c;
      else keyName = e.key;
    } else {
      return; // Unknown key, ignore
    }

    setEditValue(keyName);
    // Auto-commit after capture; also tear down the idle-cancel timer since the field is
    // about to unmount.
    disarmKeyCaptureTimer();
    if (editingCell) {
      send({
        type: 'actions:edit',
        payload: { index: editingCell.index, field: editingCell.field, value: keyName },
      });
      setEditingCell(null);
    }
  }, [armKeyCaptureTimer, disarmKeyCaptureTimer, editingCell, send]);

  // Drag & drop via mouse events (HTML5 drag API doesn't work in WebView2)
  const isDraggable = !buttonStates.recordingActive && !buttonStates.replayActive && !editingCell;
  const dragState = useRef<{ indices: number[]; startX: number; startY: number; started: boolean } | null>(null);
  const dragOccurred = useRef(false);
  const dropTargetRef = useRef<number | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const DRAG_THRESHOLD = 5;

  const handleRowMouseDown = useCallback((idx: number, e: React.MouseEvent) => {
    if (!isDraggable || e.button !== 0) return;
    // Don't initiate drag from input elements (inline editing)
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const indices = selectedIndices.has(idx)
      ? Array.from(selectedIndices).sort((a, b) => a - b)
      : [idx];
    dragState.current = { indices, startX: e.clientX, startY: e.clientY, started: false };
    dropTargetRef.current = null;
    dragOccurred.current = false;
  }, [isDraggable, selectedIndices]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState.current || !tbodyRef.current) return;
      // Check threshold before starting drag
      if (!dragState.current.started) {
        const dx = e.clientX - dragState.current.startX;
        const dy = e.clientY - dragState.current.startY;
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        dragState.current.started = true;
        dragOccurred.current = true;
        setDragIndices(dragState.current.indices);
      }
      e.preventDefault(); // Prevent text selection while dragging
      // Find which row the cursor is over
      const rows = tbodyRef.current.querySelectorAll('tr');
      let target: number | null = null;
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) {
          target = i;
          break;
        }
        if (i === rows.length - 1) {
          target = i + 1;
        }
      }
      dropTargetRef.current = target;
      setDropTarget(target);
    };

    const handleMouseUp = () => {
      if (!dragState.current) return;
      if (dragState.current.started) {
        const indices = dragState.current.indices;
        const target = dropTargetRef.current;

        if (target !== null && indices.length > 0) {
          send({ type: 'actions:reorder', payload: { indices, targetIndex: target } });
          setSelectedIndices(new Set());
        }

        setDragIndices(null);
        setDropTarget(null);
      }

      dragState.current = null;
      dropTargetRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [send]);

  const isMouseAction = (actionType: string) =>
    actionType.includes('Click') || actionType.includes('Middle');

  // Context menu: right-click on a row
  const handleRowContextMenu = useCallback((idx: number, e: React.MouseEvent) => {
    if (!contextMenuEnabled) return;
    e.preventDefault();
    // If right-clicked row is not in selection, select only it
    if (!selectedIndices.has(idx)) {
      setSelectedIndices(new Set([idx]));
      lastClickedIndex.current = idx;
    }
    setActiveSubmenu(null);
    setContextMenu({ x: e.clientX, y: e.clientY, rowIndex: idx });
  }, [contextMenuEnabled, selectedIndices]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setMenuPos(null);
    setActiveSubmenu(null);
  }, []);

  const handleInsertAction = useCallback((actionType: string) => {
    if (!contextMenu) return;
    const insertIndex = contextMenu.rowIndex + 1;
    send({ type: 'actions:insertAction', payload: { actionType, insertIndex } });
    closeContextMenu();
  }, [contextMenu, send, closeContextMenu]);



  const handleDuplicate = useCallback(() => {
    if (!contextMenu) return;
    const indices = selectedIndices.size > 0 && selectedIndices.has(contextMenu.rowIndex)
      ? Array.from(selectedIndices)
      : [contextMenu.rowIndex];
    send({ type: 'actions:duplicate', payload: { indices } });
    closeContextMenu();
  }, [contextMenu, selectedIndices, send, closeContextMenu]);

  const handleContextDelete = useCallback(() => {
    if (!contextMenu) return;
    const indices = selectedIndices.size > 0 && selectedIndices.has(contextMenu.rowIndex)
      ? Array.from(selectedIndices)
      : [contextMenu.rowIndex];
    send({ type: 'actions:delete', payload: { indices } });
    setSelectedIndices(new Set());
    closeContextMenu();
  }, [contextMenu, selectedIndices, send, closeContextMenu]);

  // Submenu items definition (mouse, keyboard, scroll only — other actions available in toolbar)
  const submenuItems = [
    { type: 'LeftClick', label: 'Left Click', icon: Mouse },
    { type: 'RightClick', label: 'Right Click', icon: Mouse },
    { type: 'MiddleClick', label: 'Middle Click', icon: Mouse },
    { type: 'KeyPress', label: 'Key Press', icon: Keyboard },
    { type: 'ScrollUp', label: 'Scroll Up', icon: ArrowUp },
    { type: 'ScrollDown', label: 'Scroll Down', icon: ArrowDown },
  ] as const;

  return (
    <div
      className="flex-1 bg-bg-surface border border-border-subtle rounded-ui overflow-hidden flex flex-col outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div
        className="grid items-center h-row border-b border-border-subtle shrink-0"
        style={{ gridTemplateColumns: [
          '28px', '50px',
          ...(columnVisibility.action ? ['140px'] : []),
          ...(columnVisibility.key ? ['100px'] : []),
          ...(columnVisibility.x ? ['65px'] : []),
          ...(columnVisibility.y ? ['65px'] : []),
          ...(columnVisibility.delay ? ['70px'] : []),
          ...(columnVisibility.notes ? ['1fr'] : []),
          '36px',
        ].join(' ') }}
      >
        <span className="flex items-center justify-center">
          <button
            type="button"
            onClick={() => {
              if (selectedIndices.size === actions.length) {
                setSelectedIndices(new Set());
              } else {
                setSelectedIndices(new Set(actions.map((_, i) => i)));
              }
            }}
            className="flex items-center justify-center cursor-pointer"
            title={selectedIndices.size === actions.length ? 'Deselect all' : 'Select all'}
          >
            <CheckboxBox
              checked={actions.length > 0 && selectedIndices.size === actions.length}
            />
          </button>
        </span>
        <span className="text-xs font-semibold text-text-tertiary pl-3">#</span>
        {columnVisibility.action && <span className="text-xs font-semibold text-text-tertiary pl-1">Action</span>}
        {columnVisibility.key && <span className="text-xs font-semibold text-text-tertiary pl-1">Key</span>}
        {columnVisibility.x && <span className="text-xs font-semibold text-text-tertiary pl-2">X</span>}
        {columnVisibility.y && <span className="text-xs font-semibold text-text-tertiary pl-2">Y</span>}
        {columnVisibility.delay && <span className="text-xs font-semibold text-text-tertiary pl-2">Delay</span>}
        {columnVisibility.notes && <span className="text-xs font-semibold text-text-tertiary pl-2 pr-2">Notes</span>}
        <span />
      </div>

      {/* Body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <table className="w-full table-fixed">
          <colgroup>
            <col style={{ width: 28 }} />
            <col style={{ width: 50 }} />
            {columnVisibility.action && <col style={{ width: 140 }} />}
            {columnVisibility.key && <col style={{ width: 100 }} />}
            {columnVisibility.x && <col style={{ width: 65 }} />}
            {columnVisibility.y && <col style={{ width: 65 }} />}
            {columnVisibility.delay && <col style={{ width: 70 }} />}
            {columnVisibility.notes && <col />}
            <col style={{ width: 36 }} />
          </colgroup>
          <tbody ref={tbodyRef}>
            {actions.map((action, idx) => {
              const colors = getActionTypeColors(action.actionType);
              const isHighlighted = highlightedActionIndex === idx;
              // While the replay engine is awaiting a Pause action's resume condition, the
              // highlighted row IS the paused action — flag it so the row treatment can swap
              // from the accent-blue "running" tint to the pause-purple "waiting" tint. This
              // is the only "where am I?" cue the user needs without leaving the grid.
              const isPausedHere = isHighlighted && pauseState.isPaused && action.actionType === 'Pause';
              const isSelected = selectedIndices.has(idx);
              const displayKey = action.actionType === 'WaitImage'
                ? ''
                : action.actionType === 'RunProfile'
                  ? (action.repeatCount && action.repeatCount > 1 ? `${action.key} ×${action.repeatCount}` : action.key)
                  : action.actionType === 'Pause'
                    ? (() => {
                        const hasHotkey = !!action.key;
                        const hasTimeout = (action.timeout ?? 0) > 0;
                        if (hasHotkey && hasTimeout) return `${action.key} / ${Math.round((action.timeout ?? 0) / 1000)}s`;
                        if (hasHotkey) return action.key;
                        if (hasTimeout) return `${Math.round((action.timeout ?? 0) / 1000)}s`;
                        return '—';
                      })()
                    : getDisplayKey(action.key);
              const displayX = getDisplayX(action);
              const displayY = getDisplayY(action);
              const canEditXY = isMouseAction(action.actionType);

              const isDragged = dragIndices?.includes(idx) ?? false;
              const isSkipped = action.isSkipped;
              const showDropBefore = dropTarget === idx && !isDragged;
              const showDropAfter = dropTarget === idx + 1 && !isDragged && !(dragIndices?.includes(idx + 1));

              return (
                <tr
                  key={idx}
                  ref={isHighlighted ? highlightedRowRef : undefined}
                  onMouseDown={(e) => handleRowMouseDown(idx, e)}
                  onClick={(e) => handleRowClick(idx, e)}
                  onContextMenu={(e) => handleRowContextMenu(idx, e)}
                  // Paused rows use the pause-action colour (purple by default) instead of
                  // the accent-blue "running" tint, plus a soft pulse to mirror the status-bar
                  // PAUSED indicator. Other highlight states fall back to the existing rules.
                  style={isPausedHere ? { backgroundColor: 'color-mix(in srgb, var(--color-action-pause-fg) 18%, transparent)' } : undefined}
                  className={`group h-row border-b border-border-subtle transition-colors cursor-default relative ${
                    isDragged ? 'opacity-40' : ''
                  } ${
                    isSkipped ? 'opacity-40 [&_td]:line-through [&_td]:decoration-text-disabled [&_td]:decoration-[1px]' : ''
                  } ${
                    isPausedHere
                      ? 'animate-pulse'
                      : isHighlighted
                        ? 'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]'
                        : isSelected
                          ? 'bg-[rgba(96,205,255,0.08)]'
                          : idx % 2 === 0
                            ? 'bg-bg-surface'
                            : 'bg-[rgba(255,255,255,0.02)]'
                  } hover:bg-bg-elevated`}
                >
                  {/* Drop indicator lines */}
                  {showDropBefore && (
                    <td colSpan={99} className="absolute top-0 left-0 right-0 h-0 p-0 border-0">
                      <div className="absolute top-[-1px] left-2 right-2 h-[2px] bg-accent-solid rounded-full" />
                    </td>
                  )}
                  {showDropAfter && (
                    <td colSpan={99} className="absolute bottom-0 left-0 right-0 h-0 p-0 border-0">
                      <div className="absolute bottom-[-1px] left-2 right-2 h-[2px] bg-accent-solid rounded-full" />
                    </td>
                  )}

                  {/* Checkbox */}
                  <td className="w-7">
                    <div className="flex items-center justify-center">
                      <Checkbox
                        checked={isSelected}
                        stopPropagation
                        onChange={() => {
                          setSelectedIndices(prev => {
                            const next = new Set(prev);
                            if (next.has(idx)) next.delete(idx);
                            else next.add(idx);
                            return next;
                          });
                        }}
                      />
                    </div>
                  </td>

                  {/* Row number */}
                  <td className="pl-3">
                    <span className="inline-block text-[11px] font-mono text-text-disabled leading-none translate-y-[-2px]">{action.rowNumber}</span>
                  </td>

                  {/* Action type pill */}
                  {columnVisibility.action && (
                  <td className="pl-1">
                    <span
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium"
                      style={{ background: colors.bg, color: colors.fg }}
                    >
                      <ActionIcon actionType={action.actionType} />
                      {action.actionType === 'WaitImage' ? 'Wait Image'
                        : action.actionType === 'BrowserClick' ? 'Left Click'
                        : action.actionType === 'BrowserRightClick' ? 'Right Click'
                        : action.actionType === 'BrowserType' ? 'Input Text'
                        : action.actionType === 'BrowserSelectOption' ? 'Select Option'
                        : action.actionType === 'BrowserWaitElement' ? 'Wait'
                        : action.actionType === 'BrowserNavigate' ? 'Navigate'
                        : action.actionType === 'RunProfile' ? 'Run Profile'
                        : action.actionType === 'Pause' ? 'Pause'
                        : action.actionType}
                    </span>
                  </td>
                  )}

                  {/* Key */}
                  {columnVisibility.key && (
                  <td className="pl-1">
                    {editingCell?.index === idx && editingCell.field === 'key' ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value=""
                        readOnly
                        placeholder="New key..."
                        onFocus={armKeyCaptureTimer}
                        onKeyDown={handleKeyCaptureKeyDown}
                        onBlur={() => { disarmKeyCaptureTimer(); cancelEdit(); }}
                        className="w-[92px] h-6 px-1 text-xs font-mono text-accent-light bg-bg-input border border-accent-solid rounded outline-none placeholder:text-accent-light/50 animate-pulse"
                      />
                    ) : displayKey ? (
                      <span
                        className={`inline-flex items-center translate-y-[-2px] px-2 py-0.5 rounded text-xs font-mono text-text-primary bg-bg-input max-w-[92px] truncate ${
                          action.actionType === 'SendText' || action.actionType.startsWith('Key') || action.actionType === 'RunProfile'
                            ? 'cursor-text hover:text-accent-light'
                            : ''
                        }`}
                        title={
                          action.actionType === 'SendText' ? action.key
                          : action.actionType === 'RunProfile' ? `Run profile "${action.key}"`
                          // Browser actions can have long CSS selectors / URLs that
                          // get truncated at 92 px. Exposing the full string on hover
                          // saves the user from opening the editor just to read it.
                          : action.actionType.startsWith('Browser') ? action.key
                          : undefined
                        }
                        onDoubleClick={() => {
                          if (action.actionType === 'SendText') {
                            setSendTextEdit({ index: idx, text: action.key });
                          } else if (action.actionType === 'RunProfile') {
                            setRunProfileEdit({ index: idx, profileName: action.key, repeatCount: action.repeatCount ?? 1 });
                          } else if (action.actionType.startsWith('Key')) {
                            startEdit(idx, 'key', action.key);
                          }
                        }}
                      >
                        {/* SendText payloads can contain `{Enter}` / `{delay:500}` /
                            `{Clipboard:...}` tokens. Render them as the same pink chips
                            used in the Lexical-based Edit Text dialog so the cell mirrors
                            what the editor shows. Other action types keep the plain
                            displayKey text — they don't have token syntax. */}
                        {action.actionType === 'SendText'
                          ? <SendTextPreview text={action.key} />
                          : displayKey}
                      </span>
                    ) : null}
                  </td>
                  )}

                  {/* X */}
                  {columnVisibility.x && (
                  <td className="pl-2">
                    {editingCell?.index === idx && editingCell.field === 'x' ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={handleEditKeyDown}
                        onBlur={commitEdit}
                        className="w-14 h-6 px-1 text-xs font-mono text-text-primary bg-bg-input border border-accent-solid rounded outline-none"
                      />
                    ) : (
                      <span
                        className={`text-xs font-mono text-text-secondary ${canEditXY ? 'cursor-text hover:text-text-primary' : ''}`}
                        onDoubleClick={() => canEditXY && startEdit(idx, 'x', String(action.x))}
                      >
                        {displayX}
                      </span>
                    )}
                  </td>
                  )}

                  {/* Y */}
                  {columnVisibility.y && (
                  <td className="pl-2">
                    {editingCell?.index === idx && editingCell.field === 'y' ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={handleEditKeyDown}
                        onBlur={commitEdit}
                        className="w-14 h-6 px-1 text-xs font-mono text-text-primary bg-bg-input border border-accent-solid rounded outline-none"
                      />
                    ) : (
                      <span
                        className={`text-xs font-mono text-text-secondary ${canEditXY ? 'cursor-text hover:text-text-primary' : ''}`}
                        onDoubleClick={() => canEditXY && startEdit(idx, 'y', String(action.y))}
                      >
                        {displayY}
                      </span>
                    )}
                  </td>
                  )}

                  {/* Delay */}
                  {columnVisibility.delay && (
                  <td className="pl-2">
                    {editingCell?.index === idx && editingCell.field === 'delay' ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={handleEditKeyDown}
                        onBlur={commitEdit}
                        className="w-16 h-6 px-1 text-xs font-mono text-text-primary bg-bg-input border border-accent-solid rounded outline-none"
                      />
                    ) : (
                      <span
                        className="text-xs font-mono text-text-secondary cursor-text hover:text-text-primary"
                        onDoubleClick={() => startEdit(idx, 'delay', String(action.delay >= 0 ? action.delay : 0))}
                      >
                        {action.delay >= 0 ? action.delay : 0}
                      </span>
                    )}
                  </td>
                  )}

                  {/* Notes */}
                  {columnVisibility.notes && (
                  <td className="pl-2 pr-2">
                    {editingCell?.index === idx && editingCell.field === 'comment' ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={handleEditKeyDown}
                        onBlur={commitEdit}
                        className="w-full h-6 px-1 text-xs text-text-primary bg-bg-input border border-accent-solid rounded outline-none"
                      />
                    ) : (
                      <span
                        className="text-xs text-text-tertiary truncate block cursor-text hover:text-text-secondary"
                        onDoubleClick={() => startEdit(idx, 'comment', action.comment)}
                      >
                        {action.comment || '\u00A0'}
                      </span>
                    )}
                  </td>
                  )}

                  {/* Row action */}
                  <td className="w-9">
                    <button
                      onClick={(e) => handleRowActionClick(idx, e)}
                      className="w-full h-full flex items-center justify-center opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-text-primary transition-opacity"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Empty state */}
        {actions.length === 0 && (
          <div className="flex items-center justify-center h-full min-h-[200px] text-text-disabled text-sm">
            No actions recorded
          </div>
        )}
      </div>

      {sendTextEdit && (
        <SendTextDialog
          mode="edit"
          initialText={sendTextEdit.text}
          onConfirm={(text) => {
            send({ type: 'actions:editSendText', payload: { index: sendTextEdit.index, text } });
            setSendTextEdit(null);
          }}
          onClose={() => setSendTextEdit(null)}
        />
      )}

      {sendTextInsert && (
        <SendTextDialog
          mode="add"
          onConfirm={(text) => {
            send({ type: 'actions:addSendText', payload: { text, insertIndex: sendTextInsert.insertIndex } });
            setSendTextInsert(null);
          }}
          onClose={() => setSendTextInsert(null)}
        />
      )}

      {runProfileEdit && (
        <RunProfileDialog
          initial={{ profileName: runProfileEdit.profileName, repeatCount: runProfileEdit.repeatCount }}
          excludeProfileName={activeProfile ?? undefined}
          onConfirm={(profileName, repeatCount) => {
            send({ type: 'actions:editRunProfile', payload: { index: runProfileEdit.index, profileName, repeatCount } });
            setRunProfileEdit(null);
          }}
          onClose={() => setRunProfileEdit(null)}
        />
      )}

      {/* Bulk Action Bar — inline at bottom */}
      {selectedIndices.size > 0 && !buttonStates.recordingActive && !buttonStates.replayActive && (
        <BulkActionBar
          selectedCount={selectedIndices.size}
          selectedIndices={selectedIndices}
          allSelectedSkipped={Array.from(selectedIndices).every(i => actions[i]?.isSkipped)}
          onClearSelection={() => setSelectedIndices(new Set())}
          onDelete={() => {
            send({ type: 'actions:delete', payload: { indices: Array.from(selectedIndices) } });
            showToast(`Deleted ${selectedIndices.size} action(s)`, 'success');
            setSelectedIndices(new Set());
          }}
          onCopyActions={() => {
            send({ type: 'actions:copyInternal', payload: { indices: Array.from(selectedIndices) } });
          }}
          onDuplicate={() => {
            send({ type: 'actions:duplicate', payload: { indices: Array.from(selectedIndices) } });
            showToast(`Duplicated ${selectedIndices.size} action(s)`, 'success');
          }}
          onSetDelay={(delay) => {
            send({ type: 'actions:bulkUpdateDelay', payload: { indices: Array.from(selectedIndices), delay } });
            showToast(`Set delay to ${delay}ms for ${selectedIndices.size} action(s)`, 'success');
          }}
          onSetCoord={(axis, value) => {
            send({ type: 'actions:bulkUpdateCoord', payload: { indices: Array.from(selectedIndices), axis, value } });
          }}
          onSetComment={(comment) => {
            send({ type: 'actions:bulkUpdateComment', payload: { indices: Array.from(selectedIndices), comment } });
            showToast(`Set notes for ${selectedIndices.size} action(s)`, 'success');
          }}
          onToggleSkip={() => {
            const allSkipped = Array.from(selectedIndices).every(i => actions[i]?.isSkipped);
            send({ type: 'actions:toggleSkip', payload: { indices: Array.from(selectedIndices) } });
            showToast(
              allSkipped
                ? `Enabled ${selectedIndices.size} action(s)`
                : `Skipped ${selectedIndices.size} action(s)`,
              'success'
            );
          }}
        />
      )}

      {/* Context Menu — rendered via portal to escape overflow:hidden */}
      {contextMenu && menuPos && createPortal(
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[180px] py-1 bg-bg-card border border-border-default rounded-md shadow-lg"
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          {/* Insert Action (inserts below selected row) */}
          <div
            className="relative"
            onMouseEnter={() => setActiveSubmenu('below')}
            onMouseLeave={() => setActiveSubmenu(null)}
          >
            <button
              className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <span className="flex items-center gap-2.5">
                <Plus size={13} className="text-text-tertiary" />
                Insert Action
              </span>
              <ChevronRight size={12} className="text-text-disabled" />
            </button>
            {activeSubmenu === 'below' && (
              <div className={`absolute top-0 min-w-[170px] bg-transparent ${submenuFlip ? 'right-full' : 'left-full'}`} style={submenuFlip ? { paddingRight: '4px' } : { paddingLeft: '4px' }}>
                <div className="py-1 bg-bg-card border border-border-default rounded-md shadow-lg z-[60]">
                  {submenuItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.type}
                        onClick={() => handleInsertAction(item.type)}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
                      >
                        <Icon size={13} className="text-text-tertiary" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="my-1 border-t border-border-subtle" />

          {/* Edit — specialized dialogs for SendText / RunProfile; others fall back
              to the generic sheet panel which only edits delay/comment/X/Y/key. */}
          <button
            onMouseEnter={() => setActiveSubmenu(null)}
            onClick={() => {
              const rowAction = actions[contextMenu.rowIndex];
              if (rowAction?.actionType === 'SendText') {
                setSendTextEdit({ index: contextMenu.rowIndex, text: rowAction.key });
              } else if (rowAction?.actionType === 'RunProfile') {
                setRunProfileEdit({
                  index: contextMenu.rowIndex,
                  profileName: rowAction.key,
                  repeatCount: rowAction.repeatCount ?? 1,
                });
              } else {
                onOpenSheet?.(contextMenu.rowIndex);
              }
              closeContextMenu();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Pencil size={13} className="text-text-tertiary" />
            Edit
          </button>

          {/* Copy Selector — only for Browser actions */}
          {actions[contextMenu.rowIndex]?.actionType?.startsWith('Browser') && actions[contextMenu.rowIndex]?.key && (
            <button
              onMouseEnter={() => setActiveSubmenu(null)}
              onClick={() => {
                const selector = actions[contextMenu.rowIndex]?.key;
                if (selector) {
                  navigator.clipboard.writeText(selector);
                  showToast('Selector copied', 'success');
                }
                closeContextMenu();
              }}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <Code2 size={13} className="text-text-tertiary" />
              Copy Selector
            </button>
          )}

          {/* Duplicate */}
          <button
            onMouseEnter={() => setActiveSubmenu(null)}
            onClick={handleDuplicate}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <Files size={13} className="text-text-tertiary" />
            Duplicate
          </button>

          {/* Select Similar */}
          <button
            onMouseEnter={() => setActiveSubmenu(null)}
            onClick={() => {
              const ref = actions[contextMenu.rowIndex];
              if (!ref) { closeContextMenu(); return; }
              const similar = new Set<number>();
              actions.forEach((a, i) => {
                if (a.actionType === ref.actionType && a.key === ref.key && a.x === ref.x && a.y === ref.y)
                  similar.add(i);
              });
              setSelectedIndices(similar);
              showToast(`Selected ${similar.size} similar action(s)`, 'success');
              closeContextMenu();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
          >
            <CheckCheck size={13} className="text-text-tertiary" />
            Select Similar
          </button>

          {/* Delete */}
          <button
            onMouseEnter={() => setActiveSubmenu(null)}
            onClick={handleContextDelete}
            className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-recording hover:bg-bg-elevated transition-colors"
          >
            <span className="flex items-center gap-2.5">
              <Trash2 size={13} />
              Delete
            </span>
            <span className="text-[10px] text-text-disabled font-mono">Del</span>
          </button>

        </div>,
        document.body
      )}
    </div>
  );
}
