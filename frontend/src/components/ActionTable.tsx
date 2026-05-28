import { useRef, useEffect, useState, useCallback, useMemo, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { Mouse, Keyboard, ArrowUp, ArrowDown, Zap, Type, Trash2, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown, Plus, Pencil, ScanSearch, Pipette, Globe, CheckCheck, Code2, Files, Hourglass, Repeat2, ExternalLink, Crosshair, Eye, EyeOff, Link, GripVertical, Timer, GitBranch, ArrowRightLeft } from 'lucide-react';
import { canCollapse, canExpand, expandKeystroke } from '../utils/keyRepeat';
import type { ActionItem } from '../bridge/messageTypes';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { useToast } from '../state/ToastContext';
import { getDisplayKey, getDisplayX, getDisplayY, getActionTypeColors } from '../utils/displayUtils';
import { SendTextDialog } from './SendTextDialog';
import { SendTextPreview } from './SendTextPreview';
import { RunProfileDialog } from './RunProfileDialog';
import { KeystrokeCaptureDialog } from './KeystrokeCaptureDialog';
import { PauseDialog } from './PauseDialog';
import { BulkActionBar } from './BulkActionBar';
import { Checkbox, CheckboxBox } from './Checkbox';
import type { ColumnVisibility } from './Toolbar';

function ActionIcon({ actionType }: { actionType: string }) {
  const size = 12;
  if (actionType.startsWith('Browser')) return <Globe size={size} />;
  if (actionType.includes('Click')) return <Mouse size={size} />;
  if (actionType === 'ScrollUp') return <ArrowUp size={size} />;
  if (actionType === 'ScrollDown') return <ArrowDown size={size} />;
  // HoldKey uses Timer (stopwatch) instead of Keyboard so it reads at a glance as
  // "this is a timed key" — matches the dialog/menu/palette icon for the same action.
  if (actionType === 'HoldKey') return <Timer size={size} />;
  if (actionType.startsWith('Key')) return <Keyboard size={size} />;
  if (actionType === 'SendText') return <Type size={size} />;
  if (actionType === 'WaitImage') return <ScanSearch size={size} />;
  if (actionType === 'WaitPixelColor') return <Pipette size={size} />;
  // Match the toolbar's redesigned icons so the chip in the table reads the same
  // as the entry that inserts the action: Hourglass (not Pause-glyph) for the
  // delay action, Repeat2 (not Workflow) for sub-macro calls.
  if (actionType === 'RunProfile') return <Repeat2 size={size} />;
  if (actionType === 'Pause') return <Hourglass size={size} />;
  // Conditional logic — GitBranch is the universal "branch / decision" glyph and
  // matches the toolbar's + If button. Else uses the two-way swap arrows; EndIf
  // closes the block with a ChevronDown.
  if (actionType === 'If') return <GitBranch size={size} />;
  if (actionType === 'Else') return <ArrowRightLeft size={size} />;
  if (actionType === 'EndIf') return <ChevronDown size={size} />;
  return <Zap size={size} />;
}

interface EditingCell {
  index: number;
  field: 'delay' | 'comment' | 'x' | 'y' | 'key';
}

interface ActionTableProps {
  columnVisibility: ColumnVisibility;
  // The toggle UI lives in Toolbar now (the grid no longer wastes a 24 px column
  // on a single icon). App still drives the visibility state and passes it down
  // here read-only; the mutator goes to Toolbar instead. ActionTable consumes
  // only the current visibility map.
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
  // Editing a Keystroke OR HoldKey row reopens the unified KeystrokeCaptureDialog —
  // these two ActionTypes share the same edit surface now that Press/Hold is a mode
  // toggle inside the dialog. `index` is all we need; the dialog reads the row's
  // ActionType + key + duration / repeat fields directly from the action item to
  // pick the starting mode.
  const [keystrokeEdit, setKeystrokeEdit] = useState<{ index: number } | null>(null);
  const [dragIndices, setDragIndices] = useState<number[] | null>(null);
  // Derived Set for O(1) membership checks inside the per-row render. The dragIndices
  // array stays as-is so the rest of the file (drag-preview chip, count display, payload
  // sent to the bridge) keeps using ordered access. Only the hot-path includes() lookups
  // in the actions.map switch to has() — drag of 100+ selected rows in a 1000-row table
  // was doing 200k Array.includes() per re-render before this.
  const dragIndexSet = useMemo(
    () => dragIndices ? new Set(dragIndices) : null,
    [dragIndices]
  );
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  // ── Conditional logic block map ────────────────────────────────────
  // Single-pass O(n) walk over the action list produces 4 parallel structures used
  // by every per-row decision below (rails, indentation, structural bg tint, skip
  // propagation, "+ Add Else" ghost-row injection):
  //   depth[i]      — nesting level of row i. Top-level IF / Else / EndIf are 0;
  //                   their direct body rows are 1; a nested IF is 1 (the row that
  //                   opens depth 2 for its own body), etc.
  //   blockIfOf[i]  — index of the IF that contains row i. Self-references on IF
  //                   rows. null on top-level non-conditional rows.
  //   endIfOf       — IF index → matching ENDIF index. Used to detect "ENDIF without
  //                   ELSE between" so we can render the inline ghost button.
  //   hasElse       — Set of IF indices that already have an ELSE in their block.
  //                   Drives whether the ghost button renders.
  //
  // Orphan ELSE / ENDIF rows (stack empty at the time they're seen) get depth=0 and
  // a null blockIfOf — the load-time validator should have stripped them, but the
  // grid stays graceful if a hand-edited profile bypassed validation. Cost: ~32 B
  // per IF row in dictionary overhead, negligible at the action-counts users hit.
  const blockInfo = useMemo(() => {
    const n = actions.length;
    const depth = new Array<number>(n).fill(0);
    const blockIfOf = new Array<number | null>(n).fill(null);
    const endIfOf = new Map<number, number>();
    const hasElse = new Set<number>();
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = actions[i].actionType;
      if (t === 'If') {
        stack.push(i);
        depth[i] = stack.length - 1;
        blockIfOf[i] = i; // IF row self-references for skip propagation
      } else if (t === 'Else') {
        if (stack.length) {
          const ifIdx = stack[stack.length - 1];
          depth[i] = stack.length - 1;
          blockIfOf[i] = ifIdx;
          hasElse.add(ifIdx);
        }
      } else if (t === 'EndIf') {
        if (stack.length) {
          const ifIdx = stack[stack.length - 1];
          depth[i] = stack.length - 1;
          blockIfOf[i] = ifIdx;
          endIfOf.set(ifIdx, i);
          stack.pop();
        }
      } else {
        // Non-structural body row — depth equals the number of currently-open IFs,
        // and the containing block is the innermost open IF (top of stack).
        depth[i] = stack.length;
        if (stack.length) blockIfOf[i] = stack[stack.length - 1];
      }
    }
    return { depth, blockIfOf, endIfOf, hasElse };
  }, [actions]);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; rowIndex: number } | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<'below' | null>(null);
  const [submenuFlip, setSubmenuFlip] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [sendTextInsert, setSendTextInsert] = useState<{ insertIndex: number } | null>(null);
  const [runProfileInsert, setRunProfileInsert] = useState<{ insertIndex: number } | null>(null);
  // Pause insert from the right-click submenu (Pattern B). Same dialog the toolbar
  // mounts; opens config-first so Cancel never leaves an empty row in the grid.
  const [pauseInsert, setPauseInsert] = useState<{ insertIndex: number } | null>(null);
  // Insert flow for the right-click submenu's "Send Keystroke…" entry. The
  // dialog handles Press / Hold internally via its Mode toggle so we don't carry
  // a mode flag through this state any more — the dialog's onConfirm result
  // tells us which bridge message to dispatch (Keystroke vs HoldKey).
  const [keystrokeCaptureInsert, setKeystrokeCaptureInsert] = useState<{ insertIndex: number } | null>(null);
  // Columns-toggle dropdown — moved here from the global Toolbar because columns
  // are a property of the grid, not a global preference. The dropdown opens
  // anchored to the header's right edge; click-outside closes it via the effect
  // below (mirrors the same pattern the Toolbar used).
  // Column-visibility STATE flows through props from App down to ActionTable; the
  // toggle UI (button + dropdown) moved to the Toolbar (see Toolbar.tsx) so the
  // grid no longer burns a dedicated 24 px column on a single icon. ActionTable
  // just consumes columnVisibility now and renders accordingly.
  const { showToast } = useToast();
  const contextMenuEnabled = !buttonStates.recordingActive && !buttonStates.replayActive;

  // Row action button handler (opens context menu at button position)
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

  // Auto-scroll to highlighted row during replay.
  //
  // `behavior: 'auto'` (instant jump) is intentional here despite feeling less
  // polished than smooth scrolling. At higher replay speeds (10+ actions/sec)
  // smooth scrolls queue up faster than they complete — the animation never
  // catches the latest row, the grid visibly lags, and the main thread is
  // occupied with overlapping scroll tweens instead of paint work. Auto-scroll
  // costs nothing per call and keeps the highlight visually tied to the
  // currently-executing action even at burst rates.
  useEffect(() => {
    if (highlightedActionIndex !== null && highlightedRowRef.current) {
      highlightedRowRef.current.scrollIntoView({ block: 'nearest', behavior: 'auto' });
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
      // Same single-IF safety as handleContextDelete: a lone-IF selection routes
      // through actions:deleteConditional so the whole block goes with it.
      const sel = Array.from(selectedIndices);
      if (sel.length === 1 && actions[sel[0]]?.actionType === 'If') {
        send({ type: 'actions:deleteConditional', payload: { ifRowIndex: sel[0] } });
      } else {
        send({ type: 'actions:delete', payload: { indices: sel } });
      }
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
      NumpadDecimal: 'NumDecimal',
    };
    // NumpadEnter excluded — shares VK 0x0D with regular Enter, indistinguishable
    // at the hook layer, so falls through to the 'Enter' branch.

    // Canonical names matching KeyUtils.NormalizeKeyName in the C# backend. Earlier
    // versions of this map used WinForms Keys-enum names ("Return", "Back", "Prior",
    // "Next", "Capital", numeric codes for modifiers) which don't appear in
    // KeyUtils.VirtualKeyMap and aren't valid ConsoleKey members — so a value
    // entered via this capture path resolved to "key not found" at replay time and
    // the action silently no-op'd. Fixed to use the same names recording produces.
    if (e.code.startsWith('Numpad') && e.code !== 'NumpadEnter') {
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
    // Digit / letter keys via e.code (physical position, shift-immune). If we used
    // e.key here, capturing Shift+1 would store "!" — fine for display, but the row
    // edit usually happens because the user wants to PAIR this with a Shift KeyDown
    // earlier in the macro, and "!" doesn't resolve to a VK on its own at replay.
    else if (/^Digit[0-9]$/.test(e.code)) keyName = e.code.slice(5);
    else if (/^Key[A-Z]$/.test(e.code)) keyName = e.code.slice(3);
    else if (e.key.length === 1) {
      // Symbols / punctuation — emit literal char (KeyUtils.VkKeyScanEx resolves
      // against the current keyboard layout, so this is layout-portable).
      keyName = e.key;
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
  // Auto-scroll zone: when the cursor is within this many pixels of the scroll container's
  // top or bottom edge during a drag, scroll the container automatically. Without this,
  // reordering across long lists (50+ actions) is impossible without dropping and re-grabbing.
  const AUTOSCROLL_ZONE = 40;
  const AUTOSCROLL_MAX_SPEED = 14; // px per animation frame
  const autoScrollRaf = useRef<number | null>(null);
  const cursorY = useRef(0);
  // Cursor X/Y in state — only used to position the floating drag preview chip, which
  // renders a "N items" counter near the cursor during a multi-row drag.
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);

  const handleRowMouseDown = useCallback((idx: number, e: React.MouseEvent) => {
    if (!isDraggable || e.button !== 0) return;
    // Don't initiate drag from input elements (inline editing)
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    // Block dragging Else / EndIf rows on their own — those are structural markers
    // bound to their parent IF, and moving them in isolation would orphan the block.
    const t = actions[idx]?.actionType;
    if (t === 'Else' || t === 'EndIf') return;
    let indices = selectedIndices.has(idx)
      ? Array.from(selectedIndices).sort((a, b) => a - b)
      : [idx];
    // Drag an IF row solo → auto-expand the drag set to include the whole block
    // (body + optional ELSE + matching ENDIF). Without this, dragging the IF alone
    // would leave its body rows in place and the engine would treat them as
    // unconditional. When the user already has a multi-select that includes the IF,
    // respect their explicit selection — they may want to extract the IF + only
    // some of its body rows (the reorder backend will renumber correctly and the
    // load-time validator catches any imbalance the reorder leaves behind).
    if (t === 'If' && !selectedIndices.has(idx)) {
      const endIfIdx = blockInfo.endIfOf.get(idx);
      if (endIfIdx !== undefined && endIfIdx > idx) {
        indices = [];
        for (let i = idx; i <= endIfIdx; i++) indices.push(i);
      }
    }
    dragState.current = { indices, startX: e.clientX, startY: e.clientY, started: false };
    dropTargetRef.current = null;
    dragOccurred.current = false;
  }, [isDraggable, selectedIndices, actions, blockInfo]);

  useEffect(() => {
    // Recompute drop target whenever the cursor moves OR the scroll container scrolls
    // (auto-scroll changes which row is under the cursor without firing mousemove).
    const recomputeDropTarget = (clientY: number) => {
      if (!tbodyRef.current) return;
      // Filter out injected ghost rows ("+ Add Else branch") before computing the
      // drop target. The ghost rows are visible but they're NOT part of the action
      // list — counting them would shift every drop index by N (where N = ghost
      // rows above the cursor), so the user would land their drop one slot off
      // for every unclosed Else block above the drop site.
      const rows = Array.from(tbodyRef.current.querySelectorAll('tr')).filter(
        tr => !tr.querySelector('button[title="Insert an Else branch in this conditional block"]')
      );
      let target: number | null = null;
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
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

    // Auto-scroll loop — runs only while the cursor sits in a border zone of the
    // scroll container. Speed ramps up the closer the cursor is to the edge.
    const tickAutoScroll = () => {
      const container = scrollRef.current;
      if (!container || !dragState.current?.started) {
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
        recomputeDropTarget(y);
        autoScrollRaf.current = requestAnimationFrame(tickAutoScroll);
      } else {
        autoScrollRaf.current = null;
      }
    };

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
      cursorY.current = e.clientY;
      setCursorPos({ x: e.clientX, y: e.clientY });
      recomputeDropTarget(e.clientY);
      // Kick off the auto-scroll loop only if the cursor is actually in an edge zone —
      // otherwise we'd schedule a RAF per mousemove just to read the position and bail,
      // wasting cycles on a cursor moving comfortably inside the list.
      if (autoScrollRaf.current === null) {
        const container = scrollRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          const inZone = e.clientY < rect.top + AUTOSCROLL_ZONE || e.clientY > rect.bottom - AUTOSCROLL_ZONE;
          if (inZone) autoScrollRaf.current = requestAnimationFrame(tickAutoScroll);
        }
      }
    };

    const handleMouseUp = () => {
      if (!dragState.current) return;
      if (dragState.current.started) {
        const indices = dragState.current.indices;
        const target = dropTargetRef.current;

        if (target !== null && indices.length > 0) {
          // View Transitions wraps the reorder in a snapshot/animate cycle when supported.
          // The browser captures the "before" state, lets the bridge update the actions
          // array via React (the inner promise tick gives reconciliation time), then
          // animates the diff. Chromium 111+ (which WebView2 ships); silent no-op on older.
          const doReorder = () => send({ type: 'actions:reorder', payload: { indices, targetIndex: target } });
          const vt = (document as unknown as { startViewTransition?: (cb: () => void | Promise<void>) => unknown }).startViewTransition;
          if (typeof vt === 'function') {
            vt.call(document, () => {
              doReorder();
              // Bridge round-trip is local + sync-ish; give React ~50ms to commit the
              // new ordering before View Transitions snapshots the "after" state.
              return new Promise<void>(resolve => setTimeout(resolve, 50));
            });
          } else {
            doReorder();
          }
          setSelectedIndices(new Set());
        }

        setDragIndices(null);
        setDropTarget(null);
      }

      dragState.current = null;
      dropTargetRef.current = null;
      setCursorPos(null);
      if (autoScrollRaf.current !== null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
    };

    // Esc cancels an in-progress drag — reverts state without committing the reorder.
    // Standard DnD ergonomic; without it the user is stuck until they release the button.
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragState.current?.started) return;
      e.stopPropagation();
      setDragIndices(null);
      setDropTarget(null);
      setCursorPos(null);
      dragState.current = null;
      dropTargetRef.current = null;
      if (autoScrollRaf.current !== null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (autoScrollRaf.current !== null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
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
    // Four special cases that need a dialog before they can produce a real action:
    // SendText needs body text, SendKey needs a single captured key, SendKeystroke
    // needs a captured combo, RunProfile needs the target profile name + repeat
    // count. Plain inserts (Pause, WaitImage) go through the generic insertAction
    // path.
    if (actionType === 'SendText') {
      setSendTextInsert({ insertIndex });
      closeContextMenu();
      return;
    }
    if (actionType === 'SendKeystroke') {
      // Unified entry — the dialog's Mode toggle picks Press vs Hold; both legacy
      // entries (Send Key / Press Key × N / Hold Key) routed here too now.
      setKeystrokeCaptureInsert({ insertIndex });
      closeContextMenu();
      return;
    }
    if (actionType === 'WaitPixelColor') {
      // Dedicated bridge message — backend opens the screen overlay in pointPick
      // mode and only inserts the row after the user clicks a pixel. Matches the
      // WaitImage flow so the two "wait for screen condition" actions behave the
      // same way (capture-first, not insert-then-configure).
      send({ type: 'actions:insertWaitPixelColor', payload: { insertIndex } });
      closeContextMenu();
      return;
    }
    if (actionType === 'RunProfile') {
      setRunProfileInsert({ insertIndex });
      closeContextMenu();
      return;
    }
    if (actionType === 'Pause') {
      // Pattern-B normalization mirror of the toolbar's Pause button: open the
      // config-first dialog instead of inserting an empty row and auto-opening
      // the Sheet. Cancel here leaves the grid untouched.
      setPauseInsert({ insertIndex });
      closeContextMenu();
      return;
    }
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
    // Special case: deleting an IF row alone removes the whole block (body +
    // optional Else + matching EndIf) via the dedicated bridge message. Without
    // this, the orphaned body rows would silently execute unconditionally —
    // worse than the visible "block was here" tracking. The single-row check
    // matters: a multi-select delete with an IF mixed in still routes through
    // the regular actions:delete (user explicitly selected the rows; respect that).
    if (indices.length === 1) {
      const idx = indices[0];
      if (actions[idx]?.actionType === 'If') {
        send({ type: 'actions:deleteConditional', payload: { ifRowIndex: idx } });
        setSelectedIndices(new Set());
        closeContextMenu();
        return;
      }
    }
    send({ type: 'actions:delete', payload: { indices } });
    setSelectedIndices(new Set());
    closeContextMenu();
  }, [contextMenu, selectedIndices, send, closeContextMenu, actions]);

  // Resolve the "effective selection" for context-menu operations the same way
  // Duplicate/Delete do: if the right-clicked row is part of the multi-select,
  // operate on the whole selection; otherwise, just the right-clicked row. This
  // keeps right-click and bulk-action behaviours consistent across the menu.
  const contextSelectionIndices = useCallback((): number[] => {
    if (!contextMenu) return [];
    return selectedIndices.size > 0 && selectedIndices.has(contextMenu.rowIndex)
      ? Array.from(selectedIndices).sort((a, b) => a - b)
      : [contextMenu.rowIndex];
  }, [contextMenu, selectedIndices]);

  // Collapse: gather the contiguous-validated selection of Down/Up pairs and
  // splice them into a single Keystroke × N row. Selection collapses to the
  // resulting row index so the user sees the transformation result highlighted.
  const handleCollapseToRepeat = useCallback(() => {
    if (!contextMenu) return;
    const indices = contextSelectionIndices();
    // Contiguity is required so we can pass a single (start, count) range to
    // replaceRange — gaps would force multiple operations and a confusing undo.
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] !== indices[i - 1] + 1) return;
    }
    const rows = indices.map(i => actions[i]);
    const result = canCollapse(rows);
    if (!result) return;
    const replacement: Partial<ActionItem>[] = [{
      actionType: 'Keystroke',
      key: result.key,
      delay: result.delay,
      repeatCount: result.count,
      repeatDelayMs: result.repeatDelayMs,
      comment: '',
    }];
    send({ type: 'actions:replaceRange', payload: {
      startIndex: indices[0],
      count: indices.length,
      replacement,
    }});
    // Pin selection on the new single row. The actions:updated round-trip will
    // re-render with the new layout in the next tick.
    setSelectedIndices(new Set([indices[0]]));
    closeContextMenu();
  }, [contextMenu, contextSelectionIndices, actions, send, closeContextMenu]);

  // Expand: only meaningful for a single-row selection of a Keystroke × N. The
  // resulting N pairs become the new selection so the user can immediately
  // operate on the expanded form (drag, edit, delete).
  const handleExpandRepeat = useCallback(() => {
    if (!contextMenu) return;
    const indices = contextSelectionIndices();
    if (indices.length !== 1) return;
    const idx = indices[0];
    const row = actions[idx];
    if (!canExpand(row)) return;
    const replacement = expandKeystroke(row);
    send({ type: 'actions:replaceRange', payload: {
      startIndex: idx,
      count: 1,
      replacement,
    }});
    const newSel = new Set<number>();
    for (let i = 0; i < replacement.length; i++) newSel.add(idx + i);
    setSelectedIndices(newSel);
    closeContextMenu();
  }, [contextMenu, contextSelectionIndices, actions, send, closeContextMenu]);

  // Submenu items — mirrors the toolbar's Add Action dropdown so users see the
  // same vocabulary regardless of entry point. Click x3 + KeyPress + Scrolls were
  // removed in the toolbar pass because recording captures them natively; same
  // reasoning here. Send Text is also omitted because the toolbar already has a
  // dedicated button for it — keeping it here too was redundant.
  const submenuItems = [
    // Send Keystroke — unified entry. The dialog's own Press/Hold toggle replaces
    // the four legacy entries (Send Key, Send Keystroke, Press × N, Hold Key);
    // they all opened slightly different dialogs for slices of the same intent.
    { type: 'SendKeystroke', label: 'Send Keystroke…', icon: Keyboard },
    { type: 'Pause', label: 'Pause', icon: Hourglass },
    { type: 'WaitImage', label: 'Wait for Image', icon: ScanSearch },
    { type: 'WaitPixelColor', label: 'Wait for Pixel Color', icon: Pipette },
    { type: 'RunProfile', label: 'Run Profile', icon: Repeat2 },
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
          // Action (152) + Key (124) absorb the 24 px previously held by the
          // (now-removed) Toggle Columns trailing slot — split 12 / 12 between
          // the two text-heaviest columns so long labels like "Navigate to URL"
          // and combo keystrokes ("Ctrl+Shift+R") get more breathing room
          // before truncation. Notes (1fr) keeps the rest of the available width.
          ...(columnVisibility.action ? ['152px'] : []),
          ...(columnVisibility.key ? ['124px'] : []),
          ...(columnVisibility.x ? ['65px'] : []),
          ...(columnVisibility.y ? ['65px'] : []),
          ...(columnVisibility.delay ? ['70px'] : []),
          ...(columnVisibility.notes ? ['1fr'] : []),
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
      </div>

      {/* Body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <table className="w-full table-fixed">
          <colgroup>
            <col style={{ width: 28 }} />
            <col style={{ width: 50 }} />
            {/* Action 152 + Key 124 match the header's gridTemplateColumns — both
                gained 12 px from the reclaimed Toggle Columns slot so longer labels
                ("Navigate to URL") and combo keystrokes ("Ctrl+Shift+R") have more
                room before truncation. */}
            {columnVisibility.action && <col style={{ width: 152 }} />}
            {columnVisibility.key && <col style={{ width: 124 }} />}
            {columnVisibility.x && <col style={{ width: 65 }} />}
            {columnVisibility.y && <col style={{ width: 65 }} />}
            {columnVisibility.delay && <col style={{ width: 70 }} />}
            {/* Notes column claims 100% of the remaining table width. In `table-fixed`,
                a <col> without an explicit width gets ~0 and the leftover space sits
                outside any cell — invisible for plain body rows (their bg is close to
                the table container's bg) but very visible for conditional structural
                rows where the tr's amber tint can't paint past the last filled td.
                Forcing 100% here makes the cell expand to fill, so the row's bg covers
                the full row width and the block reads as one continuous amber band. */}
            {columnVisibility.notes && <col style={{ width: '100%' }} />}
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
                  // ×N moved to the Action pill (see the pill render below) so the
                  // Key column shows only the profile name and long names no longer
                  // truncate the repeat-count badge out of view.
                  ? action.key
                  : action.actionType === 'Pause'
                    ? (() => {
                        const hasHotkey = !!action.key;
                        const hasTimeout = (action.timeout ?? 0) > 0;
                        if (hasHotkey && hasTimeout) return `${action.key} / ${Math.round((action.timeout ?? 0) / 1000)}s`;
                        if (hasHotkey) return action.key;
                        if (hasTimeout) return `${Math.round((action.timeout ?? 0) / 1000)}s`;
                        return '—';
                      })()
                    : action.actionType === 'If'
                      ? (() => {
                          // IF rows show the condition's primary identifier — image
                          // filename or pixel hex. Mirrors the C# DisplayKey getter so
                          // a backend push and a frontend re-render produce the same
                          // string. Color swatch / NOT badge are rendered separately
                          // below as DOM nodes (they're not plain text).
                          if (action.conditionType === 'ImageFound') {
                            const p = action.imagePath || '';
                            if (!p) return '';
                            const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
                            return cut >= 0 ? p.slice(cut + 1) : p;
                          }
                          if (action.conditionType === 'PixelColorMatch') {
                            return action.pixelColor || '';
                          }
                          return '';
                        })()
                      : getDisplayKey(action.key);
              const displayX = getDisplayX(action);
              const displayY = getDisplayY(action);
              const canEditXY = isMouseAction(action.actionType);

              const isDragged = dragIndexSet?.has(idx) ?? false;
              // Skip propagation: when an IF row carries IsSkipped, every row inside
              // that block (body + ELSE + matching ENDIF) renders with the strikethrough
              // treatment too. blockIfOf points to the containing IF; self-references on
              // the IF row mean its own isSkipped already covers it.
              const blockIf = blockInfo.blockIfOf[idx];
              const isInSkippedBlock = blockIf !== null && actions[blockIf]?.isSkipped === true;
              const isSkipped = action.isSkipped || isInSkippedBlock;
              const showDropBefore = dropTarget === idx && !isDragged;
              const showDropAfter = dropTarget === idx + 1 && !isDragged && !(dragIndexSet?.has(idx + 1));

              // Conditional structural rows (If / Else / EndIf) carry their own scope
              // rail in addition to any outer-block rails, get a subtle tinted bg, and
              // anchor the "+ Add Else" ghost row injected below.
              const isStructural = action.actionType === 'If' || action.actionType === 'Else' || action.actionType === 'EndIf';
              const depth = blockInfo.depth[idx] || 0;
              // Rail count = depth (= rails for outer blocks) + 1 extra rail for the
              // structural row's own scope. A top-level IF (depth=0, structural) renders
              // 1 rail. A nested IF (depth=1, structural) renders 2 (outer + its own).
              // Body rows render `depth` rails (no extra for self).
              const railCount = isStructural ? depth + 1 : depth;
              // Indent rule (user-requested):
              //  • Body rows inside a TOP-LEVEL IF (depth=1) stay aligned with rows
              //    outside the block — a single IF doesn't visually push its content
              //    to the right. The rail to the left already conveys "this row is
              //    in a block", so the extra indent felt redundant.
              //  • Body rows inside a NESTED IF (depth ≥ 2) DO indent so the user
               //   can see the nesting at a glance.
              //  • Structural rows (If / Else / EndIf themselves) still indent per
              //    depth so a nested IF/Else/EndIf sits past its outer rail (otherwise
              //    the pill would overlap the rail visually).
              const indentPx = isStructural ? depth * 14 : Math.max(0, depth - 1) * 14;

              // Ghost "+ Add Else branch" row — rendered just BEFORE an EndIf row whose
              // matching IF has no ELSE. Placing it before the EndIf keeps it visually
              // tucked between the end of the body (or right after the IF for an empty
              // block) and the closing marker — exactly where the user would think to
              // click "add an else branch here". Disabled during recording/replay to
              // avoid mid-run mutations.
              const showAddElseBefore = action.actionType === 'EndIf'
                && blockIf !== null
                && !blockInfo.hasElse.has(blockIf);
              const addElseDepth = showAddElseBefore && blockIf !== null ? blockInfo.depth[blockIf] : 0;

              return (
                <Fragment key={action.id ?? idx}>
                {showAddElseBefore && blockIf !== null && (
                  <tr
                    // Same amber tint AND height as structural rows so the block reads as
                    // one uniform band. Earlier attempts used h-7 (28 px) for a thinner
                    // "ghost feel", but that broke the visual rhythm — the user perceived
                    // it as an incomplete row even though the color was identical. Matching
                    // h-row makes the Add Else slot sit naturally inside the block strip.
                    className="h-row border-b border-border-subtle relative pointer-events-none bg-[color-mix(in_srgb,var(--color-action-if-fg)_6%,transparent)]"
                  >
                    <td colSpan={99} className="p-0 relative">
                      <button
                        type="button"
                        onClick={() => send({ type: 'actions:addElseBranch', payload: { ifRowIndex: blockIf } })}
                        disabled={buttonStates.recordingActive || buttonStates.replayActive}
                        className="pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[10.5px] font-medium rounded border border-dashed transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{
                          // Anchor the chip past the rails of the containing block so it
                          // visually sits inside that block's scope at the same indent the
                          // body rows use. 78 (col-2 boundary) + addElseDepth*14 (depth indent)
                          // + 4 (default pl-1) lands the button just past the IF's rail.
                          marginLeft: `${78 + addElseDepth * 14 + 4}px`,
                          color: 'var(--color-action-if-fg)',
                          borderColor: 'var(--color-action-if-border)',
                          background: 'transparent',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-action-if-bg)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        title="Insert an Else branch in this conditional block"
                      >
                        <Plus size={11} />
                        Add Else branch
                      </button>
                    </td>
                  </tr>
                )}
                <tr
                  // Prefer action.id for React reconciliation — without it, drag-reorder
                  // and undo/redo end up with the wrong DOM nodes mapped to actions,
                  // breaking highlight state and replaying entrance animations on rows
                  // that didn't actually change. Falls back to idx for the brief window
                  // between an old-profile backend push (no id yet) and the next refresh
                  // after migration runs.

                  ref={isHighlighted ? highlightedRowRef : undefined}
                  onMouseDown={(e) => handleRowMouseDown(idx, e)}
                  onClick={(e) => handleRowClick(idx, e)}
                  onContextMenu={(e) => handleRowContextMenu(idx, e)}
                  // Paused rows use the pause-action colour (purple by default) instead of
                  // the accent-blue "running" tint, plus a soft pulse to mirror the status-bar
                  // PAUSED indicator. Other highlight states fall back to the existing rules.
                  style={isPausedHere ? { backgroundColor: 'color-mix(in srgb, var(--color-action-pause-fg) 18%, transparent)' } : undefined}
                  className={`group h-row border-b border-border-subtle transition-colors relative ${
                    // Cursor signals draggability: grabbing during an active drag, grab on
                    // hover when the row can be dragged, default otherwise (e.g. while
                    // recording/replaying or editing a cell).
                    dragIndices !== null
                      ? 'cursor-grabbing'
                      : isDraggable
                        ? 'cursor-grab'
                        : 'cursor-default'
                  } ${
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
                          : isStructural
                            // Structural row tint replaces the odd/even striping so the
                            // whole IF / ELSE / ENDIF row group reads as a cohesive scope
                            // marker, distinct from the body rows it brackets.
                            ? 'bg-[color-mix(in_srgb,var(--color-action-if-fg)_6%,transparent)]'
                            : idx % 2 === 0
                              ? 'bg-bg-surface'
                              : 'bg-[rgba(255,255,255,0.02)]'
                  } hover:bg-bg-elevated`}
                >
                  {/* Drop indicator — accent line with a small leading circle and a soft
                      glow. The circle anchors the eye on where the drop "starts" (left edge
                      of the column area) and reads as more deliberate than a bare hairline.
                      box-shadow uses var(--color-accent) so it follows theme accents. */}
                  {showDropBefore && (
                    <td colSpan={99} className="absolute top-0 left-0 right-0 h-0 p-0 border-0">
                      <div
                        className="absolute top-[-2px] left-2 right-2 h-[3px] rounded-full bg-accent-solid"
                        style={{ boxShadow: '0 0 6px color-mix(in srgb, var(--color-accent) 60%, transparent)' }}
                      >
                        <div className="absolute -left-1 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-accent-solid" />
                      </div>
                    </td>
                  )}
                  {showDropAfter && (
                    <td colSpan={99} className="absolute bottom-0 left-0 right-0 h-0 p-0 border-0">
                      <div
                        className="absolute bottom-[-2px] left-2 right-2 h-[3px] rounded-full bg-accent-solid"
                        style={{ boxShadow: '0 0 6px color-mix(in srgb, var(--color-accent) 60%, transparent)' }}
                      >
                        <div className="absolute -left-1 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-accent-solid" />
                      </div>
                    </td>
                  )}

                  {/* Checkbox — the entire row is the drag target (handleRowMouseDown);
                      the cursor switches to grab/grabbing on hover/drag, which is
                      affordance enough. An earlier draft swapped in a GripVertical icon
                      on hover but it competed visually with the checkbox and added
                      noise to a dense grid.
                      Also hosts the conditional-block rails as absolutely-positioned
                      siblings of the Checkbox. They anchor to the <tr> (the nearest
                      position:relative ancestor — see the row's className above) rather
                      than this td, so `left: 78px` is measured from the row's left edge.
                      Placing the rails INSIDE an existing td (vs a separate colSpan=99
                      overlay td) is mandatory: an absolute-positioned td still consumes
                      a column slot in `table-fixed` layout, which would shift every
                      subsequent td (checkbox / # / Action / Key / X / Y / Delay / Notes)
                      one column to the right — the alignment bug we hit before this fix. */}
                  <td className="w-7">
                    {railCount > 0 && Array.from({ length: railCount }, (_, i) => {
                      const isInnermost = i === railCount - 1;
                      const strong = isStructural && isInnermost;
                      return (
                        <div
                          key={`rail-${i}`}
                          className="absolute top-0 bottom-0 pointer-events-none"
                          style={{
                            left: `${78 + i * 14}px`,
                            width: strong ? '3px' : '2px',
                            background: strong ? 'var(--color-action-if-fg)' : 'var(--color-action-if-border)',
                          }}
                        />
                      );
                    })}
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
                  <td
                    className="pl-1"
                    // Extra left padding per nesting level pushes the pill to the right
                    // of all rails. 14 px per level matches the rail spacing so the pill
                    // always sits just past its innermost rail.
                    style={indentPx > 0 ? { paddingLeft: `${4 + indentPx}px` } : undefined}
                  >
                    <span
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium"
                      style={{ background: colors.bg, color: colors.fg }}
                    >
                      <ActionIcon actionType={action.actionType} />
                      {action.actionType === 'WaitImage' ? 'Wait Image'
                        : action.actionType === 'WaitPixelColor' ? 'Pixel Color'
                        : action.actionType === 'BrowserClick' ? 'Left Click'
                        : action.actionType === 'BrowserRightClick' ? 'Right Click'
                        : action.actionType === 'BrowserType' ? 'Input Text'
                        : action.actionType === 'BrowserSelectOption' ? 'Select Option'
                        : action.actionType === 'BrowserWaitElement' ? 'Wait'
                        : action.actionType === 'BrowserNavigate' ? 'Navigate to URL'
                        : action.actionType === 'RunProfile' ? 'Run Profile'
                        : action.actionType === 'Pause' ? 'Pause'
                        : action.actionType === 'HoldKey' ? 'Hold Key'
                        // Conditional labels are intentionally lowercase to read as
                        // "code keywords" (matches the mockup). IF varies by condition
                        // family so the user sees the probe type without opening Sheet.
                        : action.actionType === 'If'
                          ? (action.conditionType === 'PixelColorMatch' ? 'if pixel' : 'if image')
                        : action.actionType === 'Else' ? 'else'
                        : action.actionType === 'EndIf' ? 'endif'
                        : action.actionType}
                      {/* Repeat indicator — Keystroke press-cycles + RunProfile sub-call
                          counts. Lives inside the Action pill instead of the Key column
                          because long profile names used to push "×N" past the Key
                          col's truncation point and hide the repetition from the user.
                          Only renders when count > 1 (default 1 = no badge). */}
                      {(action.actionType === 'Keystroke' || action.actionType === 'RunProfile')
                        && (action.repeatCount ?? 1) > 1 && (
                          <span className="ml-0.5 opacity-75">×{action.repeatCount}</span>
                        )}
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
                        className="w-[104px] h-6 px-1 text-xs font-mono text-accent-light bg-bg-input border border-accent-solid rounded outline-none placeholder:text-accent-light/50 animate-pulse"
                      />
                    ) : displayKey ? (
                      <span
                        className={`inline-flex items-center translate-y-[-2px] px-2 py-0.5 rounded text-xs font-mono text-text-primary bg-bg-input max-w-[104px] truncate ${
                          action.actionType === 'SendText' || action.actionType.startsWith('Key') || action.actionType === 'HoldKey' || action.actionType === 'RunProfile'
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
                          } else if (action.actionType === 'Keystroke' || action.actionType === 'HoldKey') {
                            // Both Keystroke and HoldKey rows open the unified capture
                            // dialog — it picks Press / Hold based on the row's
                            // ActionType and lets the user switch mid-edit. Inline
                            // single-key edit (used by KeyDown/KeyUp below) would
                            // silently drop modifiers from a combo and lose the
                            // hold-duration context, so we always go through the
                            // dialog for these two types.
                            setKeystrokeEdit({ index: idx });
                          } else if (action.actionType.startsWith('Key')) {
                            startEdit(idx, 'key', action.key);
                          }
                        }}
                      >
                        {/* IF rows render extra leading nodes inside the chip: a NOT
                            badge when the condition is negated (IFNOT semantic), and a
                            color swatch for pixel-color conditions. Both go BEFORE the
                            displayKey text so the chip reads "[NOT][swatch] payload"
                            in natural reading order. */}
                        {action.actionType === 'If' && action.conditionNegate && (
                          <span
                            className="mr-1 px-1 py-px rounded text-[9.5px] font-bold tracking-wider border"
                            style={{
                              background: 'var(--color-action-if-bg)',
                              color: 'var(--color-action-if-fg)',
                              borderColor: 'var(--color-action-if-border)',
                            }}
                            title="Negated condition — the TRUE branch fires when the probe FAILS (IFNOT)"
                          >
                            NOT
                          </span>
                        )}
                        {action.actionType === 'If' && action.conditionType === 'PixelColorMatch' && action.pixelColor && (
                          <span
                            className="mr-1 inline-block w-2.5 h-2.5 rounded-sm border border-white/20"
                            style={{ background: action.pixelColor }}
                            title={`Target colour: ${action.pixelColor}`}
                          />
                        )}
                        {/* SendText payloads can contain `{Enter}` / `{delay:500}` /
                            `{Clipboard:...}` tokens. Render them as the same pink chips
                            used in the Lexical-based Edit Text dialog so the cell mirrors
                            what the editor shows. Other action types keep the plain
                            displayKey text — they don't have token syntax. */}
                        {action.actionType === 'SendText'
                          ? <SendTextPreview text={action.key} />
                          : displayKey}
                        {/* The Keystroke × N badge that used to live here moved to
                            the Action pill so it stays visible even when the Key
                            column is narrow. The original badge was clickable to
                            reopen the recapture dialog; that affordance is now
                            covered by double-clicking the Key chip (line above),
                            which already routes to setKeystrokeEdit for Keystroke /
                            HoldKey rows. */}
                        {/* Hold-duration badge for HoldKey rows. Same visual treatment as
                            the × N badge so the two repeat-flavoured key actions look like
                            siblings. Click reopens the unified Keystroke dialog (in Hold
                            mode) with key + duration pre-filled. Format: "1s" for clean
                            second multiples, "1.5s" for fractional, "500ms" for sub-second.
                            No "hold" text — the row's pill + Timer icon already convey
                            the action; the badge just communicates the duration. */}
                        {action.actionType === 'HoldKey' && (() => {
                          const ms = action.holdDurationMs && action.holdDurationMs > 0 ? action.holdDurationMs : 1000;
                          const label = ms >= 1000 && ms % 100 === 0
                            ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`
                            : `${ms}ms`;
                          return (
                            <span
                              className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold tabular-nums bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-accent-light hover:bg-[color-mix(in_srgb,var(--color-accent)_28%,transparent)] cursor-pointer transition-colors"
                              title={`Hold duration: ${ms} ms`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setKeystrokeEdit({ index: idx });
                              }}
                            >
                              {label}
                            </span>
                          );
                        })()}
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

                </tr>
                </Fragment>
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

      {/* Floating drag preview — follows the cursor with a "N items" badge so the user
          knows what's being moved during a multi-row drag. The Windows "grabbing" cursor
          is ~32×32px and the user reported the chip getting covered at smaller offsets;
          push it to (+32, +32) so the chip clears the cursor bounds in any DPI/scaling.
          pointer-events-none keeps it out of hit-testing. */}
      {dragIndices !== null && cursorPos !== null && (
        <div
          className="fixed pointer-events-none z-50 flex items-center gap-1.5 px-2.5 py-1 rounded bg-bg-card border border-accent-solid/60 shadow-lg text-[11px] text-text-primary"
          // `transform: translate3d(...)` instead of `left/top` so the chip rides
          // on the GPU compositor layer — each mousemove only retriggers a
          // composite, never a layout/paint of the surrounding tree. `top:0;
          // left:0` anchors the transform origin, `willChange:transform` hints
          // the browser to promote the element ahead of time. Saves a layout
          // pass per pointermove in the DnD hot loop.
          style={{
            top: 0,
            left: 0,
            transform: `translate3d(${cursorPos.x + 32}px, ${cursorPos.y + 32}px, 0)`,
            willChange: 'transform',
          }}
        >
          <GripVertical size={11} className="text-accent shrink-0" />
          {dragIndices.length === 1 ? '1 item' : `${dragIndices.length} items`}
        </div>
      )}

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

      {/* Unified edit dialog for both Keystroke and HoldKey rows. Seeds Mode from
          the row's ActionType so the dialog opens already showing the right fields.
          On Save the dialog tells us which ActionType the result is; if it differs
          from the original (user toggled Press↔Hold), we emit an actionType edit
          first so the backend has the right shape when subsequent field edits land. */}
      {keystrokeEdit && (() => {
        const editing = actions[keystrokeEdit.index];
        const isHold = editing?.actionType === 'HoldKey';
        const curRepeat = editing?.repeatCount ?? 1;
        const curDelay = editing?.repeatDelayMs ?? 30;
        const curDuration = editing?.holdDurationMs && editing.holdDurationMs > 0 ? editing.holdDurationMs : 1000;
        return (
          <KeystrokeCaptureDialog
            initialActionType={isHold ? 'HoldKey' : 'Keystroke'}
            initialKey={editing?.key}
            initialRepeat={curRepeat}
            initialRepeatDelayMs={curDelay}
            initialHoldDurationMs={isHold ? curDuration : undefined}
            onConfirm={(result) => {
              const idx = keystrokeEdit.index;
              // ActionType conversion fires first so the backend applies field
              // updates against the right action shape (a holdDurationMs edit on a
              // row that's still typed as Keystroke would be silently ignored).
              if (result.actionType !== editing?.actionType) {
                send({ type: 'actions:edit', payload: { index: idx, field: 'actionType', value: result.actionType } });
              }
              if (result.key !== editing?.key) {
                send({ type: 'actions:edit', payload: { index: idx, field: 'key', value: result.key } });
              }
              if (result.actionType === 'Keystroke') {
                if (result.repeat !== curRepeat) {
                  send({ type: 'actions:edit', payload: { index: idx, field: 'repeat', value: String(result.repeat) } });
                }
                if (result.repeatDelayMs !== curDelay) {
                  send({ type: 'actions:edit', payload: { index: idx, field: 'repeatDelayMs', value: String(result.repeatDelayMs) } });
                }
              } else {
                if (result.holdDurationMs !== curDuration) {
                  send({ type: 'actions:edit', payload: { index: idx, field: 'holdDurationMs', value: String(result.holdDurationMs) } });
                }
              }
              setKeystrokeEdit(null);
            }}
            onClose={() => setKeystrokeEdit(null)}
          />
        );
      })()}

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

      {/* Insert-flow dialogs for the context menu's Insert Action submenu — Send
          Text (body), Send Keystroke (capture + Press/Hold), Run Profile (picker),
          Pause (hotkey + timeout). */}
      {runProfileInsert && (
        <RunProfileDialog
          excludeProfileName={activeProfile ?? undefined}
          onConfirm={(profileName, repeatCount) => {
            send({ type: 'actions:addRunProfile', payload: { profileName, repeatCount, insertIndex: runProfileInsert.insertIndex } });
            setRunProfileInsert(null);
          }}
          onClose={() => setRunProfileInsert(null)}
        />
      )}

      {pauseInsert && (
        <PauseDialog
          onConfirm={(key, timeoutSeconds) => {
            const timeoutMs = Math.max(0, Math.round(timeoutSeconds * 1000));
            send({
              type: 'actions:insertPause',
              payload: { key, timeoutMs, insertIndex: pauseInsert.insertIndex },
            });
            setPauseInsert(null);
          }}
          onClose={() => setPauseInsert(null)}
        />
      )}

      {keystrokeCaptureInsert && (
        <KeystrokeCaptureDialog
          onConfirm={(result) => {
            const insertIndex = keystrokeCaptureInsert.insertIndex;
            if (result.actionType === 'HoldKey') {
              send({
                type: 'actions:insertHoldKey',
                payload: { key: result.key, insertIndex, holdDurationMs: result.holdDurationMs },
              });
            } else {
              // Omit repeat fields for the implicit defaults so the bridge payload
              // stays minimal and the C# side keeps RepeatDelayMs null on disk.
              const payload: { keystroke: string; insertIndex: number; repeat?: number; repeatDelayMs?: number } =
                { keystroke: result.key, insertIndex };
              if (result.repeat > 1) {
                payload.repeat = result.repeat;
                if (result.repeatDelayMs !== 30) payload.repeatDelayMs = result.repeatDelayMs;
              }
              send({ type: 'actions:insertKeystroke', payload });
            }
            setKeystrokeCaptureInsert(null);
          }}
          onClose={() => setKeystrokeCaptureInsert(null)}
        />
      )}

      {/* Bulk Action Bar — inline at bottom. Reordering (Move Up / Move Down)
          lives here now instead of on the global toolbar because the operation
          requires a selection by definition — keeping it on the toolbar created
          two grey-buttons-90%-of-the-time. canMoveUp/Down disable the buttons
          when the selection is already at the start / end of the list, so the
          same affordance rule the keyboard shortcut already used (no-op at
          edges) is visible on the button state. */}
      {selectedIndices.size > 0 && !buttonStates.recordingActive && !buttonStates.replayActive && (() => {
        const selSorted = Array.from(selectedIndices).sort((a, b) => a - b);
        const canMoveUp = selSorted.length > 0 && selSorted[0] > 0;
        const canMoveDown = selSorted.length > 0 && selSorted[selSorted.length - 1] < actions.length - 1;
        return (
        <BulkActionBar
          selectedCount={selectedIndices.size}
          selectedIndices={selectedIndices}
          allSelectedSkipped={selSorted.every(i => actions[i]?.isSkipped)}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          onClearSelection={() => setSelectedIndices(new Set())}
          onDelete={() => {
            send({ type: 'actions:delete', payload: { indices: selSorted } });
            showToast(`Deleted ${selectedIndices.size} action(s)`, 'success');
            setSelectedIndices(new Set());
          }}
          onMoveUp={() => {
            // Mirror the Alt+↑ hotkey logic: shift the contiguous indices one slot up
            // and re-emit selection:set so the highlighted rows follow their new
            // positions. Guarded by canMoveUp so first-row selections no-op silently.
            if (!canMoveUp) return;
            const minIdx = selSorted[0];
            send({ type: 'actions:reorder', payload: { indices: selSorted, targetIndex: minIdx - 1 } });
            window.dispatchEvent(new CustomEvent('selection:set', { detail: selSorted.map(i => i - 1) }));
          }}
          onMoveDown={() => {
            if (!canMoveDown) return;
            const maxIdx = selSorted[selSorted.length - 1];
            // targetIndex = maxIdx + 2 because the reorder API treats the target as the
            // pre-shift insertion point (mirrors the Alt+↓ hotkey behaviour exactly).
            send({ type: 'actions:reorder', payload: { indices: selSorted, targetIndex: maxIdx + 2 } });
            window.dispatchEvent(new CustomEvent('selection:set', { detail: selSorted.map(i => i + 1) }));
          }}
          onSetDelay={(delay) => {
            send({ type: 'actions:bulkUpdateDelay', payload: { indices: selSorted, delay } });
            showToast(`Set delay to ${delay}ms for ${selectedIndices.size} action(s)`, 'success');
          }}
          onSetCoord={(axis, value) => {
            send({ type: 'actions:bulkUpdateCoord', payload: { indices: selSorted, axis, value } });
          }}
          onSetComment={(comment) => {
            send({ type: 'actions:bulkUpdateComment', payload: { indices: selSorted, comment } });
            showToast(`Set notes for ${selectedIndices.size} action(s)`, 'success');
          }}
          onToggleSkip={() => {
            const allSkipped = selSorted.every(i => actions[i]?.isSkipped);
            send({ type: 'actions:toggleSkip', payload: { indices: selSorted } });
            showToast(
              allSkipped
                ? `Enabled ${selectedIndices.size} action(s)`
                : `Skipped ${selectedIndices.size} action(s)`,
              'success'
            );
          }}
        />
        );
      })()}

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

          {/* Edit — specialized dialogs for SendText / RunProfile / Keystroke
              (which all carry a single primary payload that has its own capture flow);
              others fall back to the generic sheet panel which edits delay / comment /
              X / Y / key as separate fields. */}
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
              } else if (rowAction?.actionType === 'Keystroke' || rowAction?.actionType === 'HoldKey') {
                // Both share the unified Send Keystroke dialog now — the dialog
                // seeds Press / Hold mode based on the row's ActionType.
                setKeystrokeEdit({ index: contextMenu.rowIndex });
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

          {/* Type-specific quick action — only ONE of these renders, based on the
              right-clicked row's actionType. Keeps the menu height predictable
              regardless of what was clicked. */}
          {(() => {
            const row = actions[contextMenu.rowIndex];
            if (!row) return null;
            const onMouse = () => setActiveSubmenu(null);
            const cls = "w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors";

            // Entries are gated on actionType ONLY (no truthy check on row.key /
            // row.x / row.y). Earlier the gate also required the payload to be
            // populated, but that meant a freshly-inserted browser action with
            // no selector yet — or a click action that somehow had null coords —
            // would silently skip its menu entry. Users reported "Copy Selector
            // doesn't appear for some Browser rows" because of this. Now the
            // entry is always present for the right action type; copying an
            // empty value to clipboard is a non-issue (worst case: toast says
            // "Selector copied" with empty string).

            // BrowserNavigate: row.key holds the URL (not a CSS selector). Must come
            // BEFORE the generic Browser* branch below so it wins the dispatch — both
            // would match otherwise and the user would see "Copy Selector" copying a URL.
            if (row.actionType === 'BrowserNavigate') {
              return (
                <button
                  onMouseEnter={onMouse}
                  onClick={() => {
                    navigator.clipboard.writeText(row.key ?? '');
                    showToast('URL copied', 'success');
                    closeContextMenu();
                  }}
                  className={cls}
                >
                  <Link size={13} className="text-text-tertiary" />
                  Copy URL
                </button>
              );
            }

            // Other Browser*: copy the CSS selector. Covers BrowserClick / BrowserRightClick
            // / BrowserType / BrowserSelectOption / BrowserWaitElement.
            if (row.actionType?.startsWith('Browser')) {
              return (
                <button
                  onMouseEnter={onMouse}
                  onClick={() => {
                    navigator.clipboard.writeText(row.key ?? '');
                    showToast('Selector copied', 'success');
                    closeContextMenu();
                  }}
                  className={cls}
                >
                  <Code2 size={13} className="text-text-tertiary" />
                  Copy Selector
                </button>
              );
            }

            // SendText: copy the text body (placeholders + tokens included verbatim).
            if (row.actionType === 'SendText') {
              return (
                <button
                  onMouseEnter={onMouse}
                  onClick={() => {
                    navigator.clipboard.writeText(row.key ?? '');
                    showToast('Text copied', 'success');
                    closeContextMenu();
                  }}
                  className={cls}
                >
                  <Code2 size={13} className="text-text-tertiary" />
                  Copy Text
                </button>
              );
            }

            // Clicks: copy the coordinate pair as "x, y" for quick reuse / debugging.
            // Native clicks are recorded as DOWN/UP pairs — actionType is one of
            // LeftClickDown, LeftClickUp, RightClickDown, RightClickUp, MiddleClickDown,
            // MiddleClickUp (NOT the unsuffixed "LeftClick" form, which only exists in
            // the SheetPanel's family-switcher dropdown — never as a stored action).
            // An earlier draft checked the unsuffixed names and silently missed every
            // real click row; user reported "Copy Coordinates doesn't appear for clicks"
            // because of this. The regex accepts the optional suffix so legacy or
            // synthesized data without Down/Up still works too.
            if (/^(Left|Right|Middle)Click(Down|Up)?$/.test(row.actionType ?? '')) {
              return (
                <button
                  onMouseEnter={onMouse}
                  onClick={() => {
                    navigator.clipboard.writeText(`${row.x ?? 0}, ${row.y ?? 0}`);
                    showToast(`Copied ${row.x ?? 0}, ${row.y ?? 0}`, 'success');
                    closeContextMenu();
                  }}
                  className={cls}
                >
                  <Crosshair size={13} className="text-text-tertiary" />
                  Copy Coordinates
                </button>
              );
            }

            // KeyDown / KeyUp intentionally have no quick-copy entry. Copying just
            // the key name (e.g. "Enter") was added in the first pass but provides
            // no meaningful workflow — the key is already visible in the table cell
            // and there's nowhere useful to paste a bare key name. Removed after
            // user feedback that the option felt purposeless.

            // Keystroke intentionally has no type-specific entry. Edit IS recapture
            // (opens the same dialog as insert), so there's nothing to surface in this
            // slot. An earlier draft added Copy Keystroke here but it didn't earn its
            // place — the combo string is already visible in the Key cell.

            // RunProfile: jump to the referenced profile. Reuses profile:click which
            // toggles selection on click; since we're targeting a DIFFERENT profile
            // than the active one, this loads that profile (with the unsaved-changes
            // guard from HandleProfileClick). Only show when row.key is set — a
            // RunProfile pointing at no profile has nothing to open.
            if (row.actionType === 'RunProfile' && row.key) {
              return (
                <button
                  onMouseEnter={onMouse}
                  onClick={() => {
                    send({ type: 'profile:click', payload: { name: row.key } });
                    closeContextMenu();
                  }}
                  className={cls}
                >
                  <ExternalLink size={13} className="text-text-tertiary" />
                  Open Profile
                </button>
              );
            }

            return null;
          })()}

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

          {/* Skip / Enable — toggles isSkipped on the right-clicked row (or the
              selected rows if the right-clicked one is in the selection, matching
              the Duplicate/Delete pattern above). Skipped actions stay in the
              list but are bypassed during replay; visually rendered with line-
              through + reduced opacity in the table. Universal — applies to any
              action type. */}
          {(() => {
            const row = actions[contextMenu.rowIndex];
            if (!row) return null;
            const indices = selectedIndices.size > 0 && selectedIndices.has(contextMenu.rowIndex)
              ? Array.from(selectedIndices)
              : [contextMenu.rowIndex];
            // Use the right-clicked row's state as the toggle reference: if it's
            // currently skipped, the action says "Enable"; otherwise "Skip".
            const isSkipped = !!row.isSkipped;
            return (
              <button
                onMouseEnter={() => setActiveSubmenu(null)}
                onClick={() => {
                  send({ type: 'actions:toggleSkip', payload: { indices } });
                  closeContextMenu();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
              >
                {isSkipped
                  ? <Eye size={13} className="text-text-tertiary" />
                  : <EyeOff size={13} className="text-text-tertiary" />
                }
                {isSkipped ? 'Enable' : 'Skip during replay'}
              </button>
            );
          })()}

          {/* Collapse to × N / Expand × N — fold consecutive Down/Up pairs of the
              same key into one Keystroke × N row (and back). Both items render
              always, with disabled state styled cinza when the validators fail,
              so users discover the feature even when their current selection
              wouldn't qualify. v1 blocks modifier combos in the Expand path. */}
          {(() => {
            const indices = selectedIndices.size > 0 && selectedIndices.has(contextMenu.rowIndex)
              ? Array.from(selectedIndices).sort((a, b) => a - b)
              : [contextMenu.rowIndex];
            // Contiguity check — gaps in the multi-select disqualify collapse.
            let contiguous = true;
            for (let i = 1; i < indices.length; i++) {
              if (indices[i] !== indices[i - 1] + 1) { contiguous = false; break; }
            }
            // No upstream .filter(Boolean): canCollapse / canExpand both reject
            // undefined entries internally, so the menu-render and handler paths
            // see the exact same `rows` shape. Drifting filters caused a subtle
            // bug pre-audit where stale selection could enable the menu while
            // the handler would have rejected.
            const rows = indices.map(i => actions[i]);
            const collapseOk = contiguous && canCollapse(rows) !== null;
            const expandOk = indices.length === 1 && canExpand(rows[0]);
            return (
              <>
                <button
                  onMouseEnter={() => setActiveSubmenu(null)}
                  onClick={collapseOk ? handleCollapseToRepeat : undefined}
                  disabled={!collapseOk}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors ${
                    collapseOk
                      ? 'text-text-primary hover:bg-bg-elevated cursor-pointer'
                      : 'text-text-disabled cursor-default'
                  }`}
                >
                  <ChevronsDownUp size={13} className={collapseOk ? 'text-text-tertiary' : 'text-text-disabled'} />
                  Collapse to × N
                </button>
                <button
                  onMouseEnter={() => setActiveSubmenu(null)}
                  onClick={expandOk ? handleExpandRepeat : undefined}
                  disabled={!expandOk}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors ${
                    expandOk
                      ? 'text-text-primary hover:bg-bg-elevated cursor-pointer'
                      : 'text-text-disabled cursor-default'
                  }`}
                >
                  <ChevronsUpDown size={13} className={expandOk ? 'text-text-tertiary' : 'text-text-disabled'} />
                  Expand × N
                </button>
              </>
            );
          })()}

          <div className="my-1 border-t border-border-subtle" />

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
