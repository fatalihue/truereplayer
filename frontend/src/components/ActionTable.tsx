import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, closestCenter, pointerWithin } from '@dnd-kit/core';
import type { CollisionDetection, DragStartEvent, DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { snapCenterToCursor } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { Mouse, MousePointerClick, Keyboard, ArrowUp, ArrowDown, Zap, Type, Trash2, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown, Plus, Pencil, ScanSearch, Pipette, Globe, CheckCheck, Check, Code2, Files, Hourglass, Repeat2, ExternalLink, Crosshair, Link, GripVertical, Timer, GitBranch, ArrowRightLeft, Combine, Split, MoreHorizontal, Focus } from 'lucide-react';
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
import { MacroEmptyState } from './MacroEmptyState';
import { Checkbox, CheckboxBox } from './Checkbox';
import type { ColumnVisibility } from './Toolbar';
import { useFlyoutFlip } from '../hooks/useFlyoutFlip';

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
  // 'coords' edits the merged "x, y" pair in the Details column — committed as
  // two separate actions:edit messages (field x, field y) so the backend
  // contract stays untouched.
  field: 'delay' | 'comment' | 'coords' | 'key';
}

// Pointer sensor that refuses to start a drag from interactive elements —
// inline editors, checkboxes, chip buttons, selects. Combined with the 8 px
// activation distance this keeps single-click-to-edit fully functional: a
// plain click never becomes a drag, and selecting text inside an inline
// editor never moves rows.
// Pointer-first collision detection: "over" is the row under the CURSOR, not
// the row nearest the (chip-sized, offset) DragOverlay rect — closestCenter on
// the overlay drifted the target a couple of rows ahead of where the user was
// pointing. Falls back to closestCenter when the pointer sits outside every
// row (e.g. in the empty area below a short list).
const pointerFirstCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : closestCenter(args);
};

class RowPointerSensor extends PointerSensor {
  static activators = [{
    eventName: 'onPointerDown' as const,
    handler: ({ nativeEvent }: { nativeEvent: PointerEvent }) => {
      if (nativeEvent.button !== 0) return false;
      const target = nativeEvent.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, [contenteditable="true"]')) return false;
      return true;
    },
  }];
}

// Render-prop shell: gives each <tr> its useSortable wiring (hooks can't be
// called inside actions.map directly) while keeping the large row JSX in
// ActionTable's own lexical scope — extracting the whole row into a component
// would mean threading 30+ closure values through props.
function SortableRowShell({ id, disabled, children }: {
  id: string;
  disabled: boolean;
  children: (s: ReturnType<typeof useSortable>) => React.ReactNode;
}) {
  const sortable = useSortable({ id, disabled });
  return <>{children(sortable)}</>;
}

// Friendly pill label — shared between the grid's Action pill and the floating
// drag ghost so the picked-up row reads identically to its in-grid sibling.
function actionPillLabel(action: ActionItem): string {
  switch (action.actionType) {
    case 'WaitImage': return 'Wait Image';
    case 'WaitPixelColor': return 'Pixel Color';
    // Browser labels carry "Element"/"Text" so they never read as the
    // desktop LeftClick/SendText pills — ambiguity fix (P2).
    case 'BrowserClick': return 'Click Element';
    case 'BrowserRightClick': return 'Right Click Element';
    case 'BrowserType': return 'Type Text';
    case 'BrowserSelectOption': return 'Select Option';
    case 'BrowserWaitElement': return 'Wait Element';
    case 'BrowserNavigate': return 'Open URL';
    case 'RunProfile': return 'Run Profile';
    case 'Pause': return 'Pause';
    case 'HoldKey': return 'Hold Key';
    case 'DoubleClick': return 'Double Click';
    // Conditional labels are intentionally lowercase to read as "code keywords".
    // The IF pill is uniform ("if") regardless of probe family — the image-vs-pixel
    // distinction (and its payload) lives in the Details cell via ProbeDetails, so
    // the grid reads as a clean "if … endif" block.
    case 'If': return 'if';
    case 'Else': return 'else';
    case 'EndIf': return 'endif';
    default: return action.actionType;
  }
}

// Whether a row is an image/pixel PROBE — the standalone Wait actions or an IF
// whose condition uses one of those probes. These share a unified Details payload
// (ProbeDetails) so an image probe looks the same whether it's a Wait or an If.
function isProbeAction(action: ActionItem): boolean {
  return action.actionType === 'WaitImage'
    || action.actionType === 'WaitPixelColor'
    || (action.actionType === 'If' && (action.conditionType === 'ImageFound' || action.conditionType === 'PixelColorMatch'));
}

// Standardized Details payload for the four probe rows. IMAGE → reference
// thumbnail (never the GUID filename); PIXEL → colour swatch + hex + x,y. IF rows
// additionally get a small type tag, since their pill is the generic "if"; Wait
// rows skip the tag because their own pill already names the type. (The NOT/IFNOT
// modifier and the image confidence % live elsewhere — the Action pill and the
// Sheet panel respectively — to keep this cell to just "what is matched".)
function ProbeDetails({ action }: { action: ActionItem }) {
  const isIf = action.actionType === 'If';
  const isImage = action.actionType === 'WaitImage'
    || (isIf && action.conditionType === 'ImageFound');

  // align-middle sets the inline-flex baseline to the cell's vertical centre; the
  // -2px optical nudge then lands the thumbnail/icon exactly on the Action pill's
  // centre (without align-middle the image sat ~4px high).
  return (
    <span className="inline-flex items-center gap-1.5 align-middle translate-y-[-2px] text-xs min-w-0">
      {isIf && (
        <span className="inline-flex items-center gap-1 px-1.5 py-px rounded text-[9px] bg-bg-elevated text-text-tertiary shrink-0">
          {isImage ? <ScanSearch size={10} /> : <Pipette size={10} />}
          {isImage ? 'image' : 'pixel'}
        </span>
      )}
      {isImage ? (
        <>
          {action.imageBase64 ? (
            <img
              src={`data:image/png;base64,${action.imageBase64}`}
              alt=""
              className="h-4 w-auto max-w-[48px] rounded-sm border border-border-default object-contain pointer-events-none shrink-0"
            />
          ) : (
            <ScanSearch size={13} className="text-text-tertiary shrink-0" />
          )}
        </>
      ) : (
        <>
          {action.pixelColor && (
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm border border-white/20 shrink-0"
              style={{ background: action.pixelColor }}
              title={`Target colour: ${action.pixelColor}`}
            />
          )}
          <span className="font-mono text-text-secondary truncate">
            {action.pixelColor}
            {action.pixelX != null && action.pixelY != null ? ` · ${action.pixelX}, ${action.pixelY}` : ''}
          </span>
        </>
      )}
    </span>
  );
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
  // Editing a Pause row reopens the PauseDialog (the same config-first window used
  // to insert one) instead of the generic Sheet — the capture pad + timeout presets
  // are a far better fit than the Sheet's flat field list. `index` is all we need;
  // the dialog seeds its pad/timeout from the row's key + timeout.
  const [pauseEdit, setPauseEdit] = useState<{ index: number } | null>(null);
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
  const [activeSubmenu, setActiveSubmenu] = useState<'more' | null>(null);
  // The "More ▸" submenu opens to the side; flip it left/up when the context menu sits
  // near the right/bottom edge so it isn't clipped. Measured on open by useFlyoutFlip,
  // which replaced an earlier right-edge-only heuristic computed in the menu-position pass.
  const moreFlyout = useFlyoutFlip(activeSubmenu === 'more', 'side');
  const contextMenuRef = useRef<HTMLDivElement>(null);
  // Drives the RunProfile insert dialog. Opened by dragging a profile onto the grid
  // (the 'profiledrag:dropOnGrid' handler) — pre-filled with the dropped profile's name.
  const [runProfileInsert, setRunProfileInsert] = useState<{ insertIndex: number; profileName?: string } | null>(null);
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

  // Focus edit input when entering edit mode. No auto-select — the user asked
  // for the caret to land at the end of the existing value instead of the whole
  // text being selected (a stray keystroke was wiping values).
  useEffect(() => {
    if (editingCell && editInputRef.current) {
      const el = editInputRef.current;
      el.focus();
      const len = el.value.length;
      try { el.setSelectionRange(len, len); } catch { /* non-text input types */ }
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
    if (editingCell.field === 'coords') {
      // Merged "x, y" editor — accepts "123,456", "123, 456" or "123 456"
      // (same forgiving formats as the Sheet panel's Paste-coords button).
      // Both numbers are required; anything else cancels silently rather than
      // half-updating one axis.
      const m = editValue.trim().match(/^(-?\d+)\s*[,;\s]\s*(-?\d+)$/);
      if (m) {
        send({ type: 'actions:edit', payload: { index: editingCell.index, field: 'x', value: m[1] } });
        send({ type: 'actions:edit', payload: { index: editingCell.index, field: 'y', value: m[2] } });
      }
      setEditingCell(null);
      return;
    }
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
    if (editingCell || sendTextEdit) return;

    // Don't hijack grid shortcuts (Ctrl+A select-all, Delete, Escape) while the user is typing in
    // an input/textarea that lives inside the grid container — notably the BulkActionBar's
    // delay/x/y/notes fields. Those don't set editingCell, so without this guard their keydowns
    // bubble here and Ctrl+A selected every row (and Delete could delete rows) instead of acting on
    // the field's own text. Mirrors the editable-target guard in App.tsx's global shortcut handler.
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;

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
  }, [editingCell, sendTextEdit, selectedIndices, send, actions]);

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

  // Drag & drop via dnd-kit (sortable preset): neighbours slide live while the
  // row is dragged, the ghost rides in a DragOverlay, and the drop commits the
  // same actions:reorder payload the old mouse-event implementation produced.
  const isDraggable = !buttonStates.recordingActive && !buttonStates.replayActive && !editingCell;
  const dragOccurred = useRef(false);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  // FLIP-on-drop: at mouseup (before the reorder round-trips through the
  // backend) we snapshot every row's viewport top keyed by action id. When the
  // reordered actions array lands, the layout effect below inverts each moved
  // row's delta and plays it back to zero — rows visibly slide into their new
  // slots instead of teleporting. Timestamped so a stale snapshot (reorder
  // rejected / unrelated update arriving much later) is discarded.
  const pendingFlipRects = useRef<{ map: Map<string, number>; at: number } | null>(null);

  useLayoutEffect(() => {
    const pending = pendingFlipRects.current;
    if (!pending) return;
    pendingFlipRects.current = null;
    if (!tbodyRef.current) return;
    if (performance.now() - pending.at > 800) return;
    // Tame the settle on big grids (user feedback: "many actions → animation too
    // aggressive"). Two culls, dnd-kit-style: rows outside the visible scroll
    // area never animate (nobody sees them, but dozens of simultaneous WAAPI
    // animations make the visible ones feel chaotic), and rows whose delta
    // exceeds the viewport height snap into place instead of flying across it.
    const view = scrollRef.current?.getBoundingClientRect();
    const maxFly = view ? view.height : 600;
    tbodyRef.current.querySelectorAll<HTMLTableRowElement>('tr[data-row-id]').forEach(tr => {
      const id = tr.getAttribute('data-row-id');
      if (!id) return;
      const oldTop = pending.map.get(id);
      if (oldTop === undefined) return;
      const rect = tr.getBoundingClientRect();
      if (view && (rect.bottom < view.top || rect.top > view.bottom)) return;
      const delta = oldTop - rect.top;
      if (Math.abs(delta) < 2 || Math.abs(delta) > maxFly) return;
      tr.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
        { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
      );
    });
  }, [actions]);

  // Shared row-measurement: maps a cursor Y to an insertion index (0..N) across the action
  // rows, skipping injected "Add Else" ghost rows. Used by both row-reorder and the
  // profile→Run Profile drag-drop so both land on the same index for a given cursor Y.
  const computeInsertIndexFromY = useCallback((clientY: number): number | null => {
    if (!tbodyRef.current) return null;
    // Skip injected non-action rows: "+ Add Else" ghosts AND the animated
    // drop-gap slot (a layout-affecting row — including it would offset every
    // index below the gap by one and make the target oscillate as the gap moves).
    const rows = Array.from(tbodyRef.current.querySelectorAll('tr')).filter(
      tr => !tr.hasAttribute('data-drop-gap')
        && !tr.querySelector('button[title="Insert an Else branch in this conditional block"]')
    );
    let target: number | null = null;
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) { target = i; break; }
      if (i === rows.length - 1) target = i + 1;
    }
    return target;
  }, []);
  // Auto-scroll zone for the PROFILE drag only (row reorder now uses dnd-kit's
  // built-in auto-scroll): when the cursor is within this many pixels of the
  // scroll container's top or bottom edge, scroll the container automatically.
  const AUTOSCROLL_ZONE = 40;
  const AUTOSCROLL_MAX_SPEED = 14; // px per animation frame

  // ── dnd-kit row reorder ──────────────────────────────────────────────
  // Sortable ids are the backend action ids (stable across reorders); the
  // index fallback only exists for the brief pre-migration window where an
  // old profile's rows have no id yet.
  const sortableIds = useMemo(() => actions.map((a, i) => a.id ?? `row-${i}`), [actions]);
  const sensors = useSensors(useSensor(RowPointerSensor, { activationConstraint: { distance: 8 } }));
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const handleDragStart = useCallback((ev: DragStartEvent) => {
    const idx = sortableIds.indexOf(String(ev.active.id));
    if (idx < 0) return;
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
    const t = actions[idx]?.actionType;
    if (t === 'If' && !selectedIndices.has(idx)) {
      const endIfIdx = blockInfo.endIfOf.get(idx);
      if (endIfIdx !== undefined && endIfIdx > idx) {
        indices = [];
        for (let i = idx; i <= endIfIdx; i++) indices.push(i);
      }
    }
    // Suppress the click that fires after the drop — handleRowClick consumes and
    // resets the flag (same contract as the old mouse-event implementation).
    dragOccurred.current = true;
    setActiveDragId(String(ev.active.id));
    setDragIndices(indices);
  }, [sortableIds, selectedIndices, actions, blockInfo]);

  const handleDragEnd = useCallback((ev: DragEndEvent) => {
    const indices = dragIndices ?? [];
    setActiveDragId(null);
    setDragIndices(null);
    const { active, over } = ev;
    if (!over || indices.length === 0) return;
    const a = sortableIds.indexOf(String(active.id));
    const o = sortableIds.indexOf(String(over.id));
    if (a < 0 || o < 0 || a === o) return;
    // Dropping onto a row that's part of the dragged set is a no-op (the slot
    // is inside the moving block).
    if (indices.includes(o)) return;
    // dnd-kit sortable semantics: the active row lands AT `over`'s position
    // (arrayMove). The backend expects the insertion slot measured against the
    // ORIGINAL array (0..N): moving down → the slot after `over`; moving up →
    // the slot at `over`.
    const target = a < o ? o + 1 : o;
    // FLIP "first" snapshot — capture where every row sits NOW (transforms
    // included, i.e. exactly where the user sees them); the useLayoutEffect on
    // [actions] plays the inverted deltas once the reordered array lands, so
    // the brief transform-reset frame between drop and backend push never
    // reads as a teleport.
    if (tbodyRef.current && document.documentElement.getAttribute('data-animations') === 'true') {
      const map = new Map<string, number>();
      tbodyRef.current.querySelectorAll<HTMLTableRowElement>('tr[data-row-id]').forEach(tr => {
        const id = tr.getAttribute('data-row-id');
        if (id) map.set(id, tr.getBoundingClientRect().top);
      });
      pendingFlipRects.current = { map, at: performance.now() };
    }
    send({ type: 'actions:reorder', payload: { indices, targetIndex: target } });
    setSelectedIndices(new Set());
  }, [dragIndices, sortableIds, send]);

  // Esc (handled natively by dnd-kit) cancels the drag — clear the visual state;
  // dragOccurred stays set so the click fired on pointer release is suppressed.
  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
    setDragIndices(null);
  }, []);

  // DEV-only test hook: the preview harness flips page visibility at every async
  // boundary, which makes dnd-kit cancel any synthetic drag mid-flight — real
  // pointer drags in the app are unaffected, but it makes the end-to-end path
  // untestable from eval scripts. Exposing the handlers lets tests drive the
  // start/end contract (drag-set expansion + drop-index math) deterministically.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__dndTest = { handleDragStart, handleDragEnd, handleDragCancel };
  }, [handleDragStart, handleDragEnd, handleDragCancel]);

  // ── Drag a profile from the ProfilePanel onto the grid → Run Profile action ──
  // ProfilePanel owns the (mouse-based) drag and signals via window events. While a profile is
  // dragged we reuse the row-reorder insertion gap (driven by dropTarget); on drop we open a
  // pre-filled Run Profile dialog at the drop index. Subscribed once — volatile values are read
  // from a ref so an in-flight drag isn't dropped by a re-subscribe.
  const profileDragCtx = useRef({ recording: false, replaying: false, activeProfile: null as string | null, actionCount: 0 });
  profileDragCtx.current = {
    recording: buttonStates.recordingActive,
    replaying: buttonStates.replayActive,
    activeProfile,
    actionCount: actions.length,
  };
  // Dedicated RAF for the profile-drag auto-scroll — decoupled from the row-reorder's
  // autoScrollRaf so the two can never cancel each other.
  const profileScrollRaf = useRef<number | null>(null);
  useEffect(() => {
    let dragging = false;
    let lastY = 0;
    const stopScroll = () => {
      if (scrollRef.current) delete scrollRef.current.dataset.autoscrolling;
      if (profileScrollRaf.current !== null) {
        cancelAnimationFrame(profileScrollRaf.current);
        profileScrollRaf.current = null;
      }
    };
    // Mirror the row-reorder auto-scroll: while the cursor sits in the top/bottom edge zone,
    // scroll the list (ramping by proximity) and keep the insertion gap in sync — so dropping
    // into a long, already-scrolled list works without scrolling by hand first.
    const tick = () => {
      const container = scrollRef.current;
      if (!container || !dragging) { profileScrollRaf.current = null; return; }
      const rect = container.getBoundingClientRect();
      let delta = 0;
      if (lastY < rect.top + AUTOSCROLL_ZONE) {
        const intensity = (rect.top + AUTOSCROLL_ZONE - lastY) / AUTOSCROLL_ZONE;
        delta = -AUTOSCROLL_MAX_SPEED * Math.min(1, Math.max(0, intensity));
      } else if (lastY > rect.bottom - AUTOSCROLL_ZONE) {
        const intensity = (lastY - (rect.bottom - AUTOSCROLL_ZONE)) / AUTOSCROLL_ZONE;
        delta = AUTOSCROLL_MAX_SPEED * Math.min(1, Math.max(0, intensity));
      }
      if (delta !== 0) {
        // Same flicker guard as the row-reorder auto-scroll: the gap re-mounts at
        // a new index every tick, so its grow animation is frozen until the
        // scroll settles (see [data-autoscrolling] in index.css).
        container.dataset.autoscrolling = 'true';
        container.scrollTop += delta;
        setDropTarget(computeInsertIndexFromY(lastY));
        profileScrollRaf.current = requestAnimationFrame(tick);
      } else {
        delete container.dataset.autoscrolling;
        profileScrollRaf.current = null;
      }
    };
    const onMove = (e: MouseEvent) => {
      lastY = e.clientY;
      setDropTarget(computeInsertIndexFromY(e.clientY));
      if (profileScrollRaf.current === null) {
        const container = scrollRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          if (e.clientY < rect.top + AUTOSCROLL_ZONE || e.clientY > rect.bottom - AUTOSCROLL_ZONE) {
            profileScrollRaf.current = requestAnimationFrame(tick);
          }
        }
      }
    };
    const onStart = () => {
      const c = profileDragCtx.current;
      if (c.recording || c.replaying) return; // don't reshape the list mid-capture/replay
      dragging = true;
      window.addEventListener('mousemove', onMove);
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      stopScroll();
      setDropTarget(null);
    };
    const onDrop = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { profileName?: string; clientY?: number } | undefined;
      if (!detail?.profileName || typeof detail.clientY !== 'number') return;
      const c = profileDragCtx.current;
      if (c.recording || c.replaying) return;
      if (detail.profileName === c.activeProfile) {
        showToast("A profile can't run itself", 'error');
        return;
      }
      const insertIndex = computeInsertIndexFromY(detail.clientY) ?? c.actionCount;
      setRunProfileInsert({ insertIndex, profileName: detail.profileName });
    };
    window.addEventListener('profiledrag:start', onStart);
    window.addEventListener('profiledrag:end', onEnd);
    window.addEventListener('profiledrag:dropOnGrid', onDrop as EventListener);
    return () => {
      window.removeEventListener('profiledrag:start', onStart);
      window.removeEventListener('profiledrag:end', onEnd);
      window.removeEventListener('profiledrag:dropOnGrid', onDrop as EventListener);
      window.removeEventListener('mousemove', onMove);
      stopScroll();
    };
  }, [computeInsertIndexFromY, showToast]);

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
          // Details replaces the old Key (124) + X (65) + Y (65) trio —
          // key/text/combo for keyboard-ish actions, "x, y" for mouse actions,
          // condition payload for If rows, all in one cell. 190 → 240 → 280 px:
          // widened in steps as Notes (1fr) kept ending up too large.
          ...(columnVisibility.action ? ['152px'] : []),
          ...(columnVisibility.details ? ['280px'] : []),
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
        {columnVisibility.details && <span className="text-xs font-semibold text-text-tertiary pl-1">Details</span>}
        {columnVisibility.delay && <span className="text-xs font-semibold text-text-tertiary pl-2">Delay</span>}
        {columnVisibility.notes && <span className="text-xs font-semibold text-text-tertiary pl-2 pr-2">Notes</span>}
      </div>

      {/* Body — DndContext/SortableContext drive the live-sliding row reorder.
          Default measuring (rects captured once at drag start) is REQUIRED here:
          MeasuringStrategy.Always re-measures rows mid-slide with their live
          transforms applied, which makes the `over` target drift ahead of the
          cursor and corrupts the drop index. */}
      <DndContext
        sensors={sensors}
        collisionDetection={pointerFirstCollision}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
      <div ref={scrollRef} data-actions-grid className="flex-1 overflow-y-auto">
        <table className="w-full table-fixed">
          <colgroup>
            <col style={{ width: 28 }} />
            <col style={{ width: 50 }} />
            {/* Action 152 + Details 280 match the header's gridTemplateColumns.
                Details holds what used to be Key + X + Y, so chips and coord
                strings share the same 280 px lane (was 240). */}
            {columnVisibility.action && <col style={{ width: 152 }} />}
            {columnVisibility.details && <col style={{ width: 280 }} />}
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
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
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
                : action.actionType === 'WaitPixelColor'
                  // Standalone pixel-color wait mirrors the "if pixel" row: the hex
                  // is the text, the swatch + coords render alongside (below).
                  ? (action.pixelColor || '')
                : action.actionType === 'RunProfile'
                  // ×N moved to the Action pill (see the pill render below) so the
                  // Key column shows only the profile name and long names no longer
                  // truncate the repeat-count badge out of view.
                  ? action.key
                  : action.actionType === 'Pause'
                    ? (() => {
                        // Timeout is stored in ms — show it as ms here (was seconds).
                        const hasHotkey = !!action.key;
                        const ms = action.timeout ?? 0;
                        const hasTimeout = ms > 0;
                        if (hasHotkey && hasTimeout) return `${action.key} / ${ms}ms`;
                        if (hasHotkey) return action.key;
                        if (hasTimeout) return `${ms}ms`;
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
              // that block (body + ELSE + matching ENDIF) renders dimmed (opacity-40)
              // too. blockIfOf points to the containing IF; self-references on the IF
              // row mean its own isSkipped already covers it.
              const blockIf = blockInfo.blockIfOf[idx];
              const isInSkippedBlock = blockIf !== null && actions[blockIf]?.isSkipped === true;
              const isSkipped = action.isSkipped || isInSkippedBlock;
              // Profile-drag insertion preview — rows at/below the drop position
              // slide down one row height (transform, not layout) so the list
              // physically parts to open space, matching the dnd-kit row-reorder
              // language. dropTarget is only ever set by the profile-drag flow.
              const profileShift = dropTarget !== null && idx >= dropTarget;
              const profileDragTransition = dropTarget !== null
                ? 'transform 150ms cubic-bezier(0.2, 0, 0, 1)'
                : undefined;

              // Conditional structural rows (If / Else / EndIf) carry their own scope
              // rail in addition to any outer-block rails, get a subtle tinted bg, and
              // anchor the "+ Add Else" ghost row injected below.
              const isStructural = action.actionType === 'If' || action.actionType === 'Else' || action.actionType === 'EndIf';
              const depth = blockInfo.depth[idx] || 0;
              // Body rows of a conditional block (depth ≥ 1, non-structural) get a
              // softer wash of the same IF hue so the whole block reads as one band,
              // not just its If/Else/EndIf brackets.
              const isInBlock = !isStructural && depth > 0;
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

              // Else / EndIf rows can't be dragged on their own — structural markers
              // bound to their parent IF; moving them in isolation would orphan the
              // block. (Dragging the IF row carries the whole block instead.)
              const rowSortDisabled = !isDraggable
                || action.actionType === 'Else'
                || action.actionType === 'EndIf';

              return (
                <SortableRowShell key={action.id ?? idx} id={action.id ?? `row-${idx}`} disabled={rowSortDisabled}>
                {(sortable) => (
                <Fragment>
                {/* Stays mounted during a row drag — sortable rects are measured once
                    at drag start, so unmounting it mid-drag would leave every rect
                    below it stale by one row height. It isn't a sortable item, so it
                    won't slide with its neighbours; a minor cosmetic trade-off. */}
                {showAddElseBefore && blockIf !== null && (
                  <tr
                    // Same amber tint AND height as structural rows so the block reads as
                    // one uniform band. Earlier attempts used h-7 (28 px) for a thinner
                    // "ghost feel", but that broke the visual rhythm — the user perceived
                    // it as an incomplete row even though the color was identical. Matching
                    // h-row makes the Add Else slot sit naturally inside the block strip.
                    // Shifts with its neighbours during a profile-drag insert preview —
                    // it isn't a sortable item, so it needs the transform applied by hand.
                    style={{
                      transform: profileShift ? 'translateY(var(--ui-row-height))' : undefined,
                      transition: profileDragTransition,
                    }}
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

                  // Combined ref: dnd-kit needs the node for measuring/transforms, and
                  // the highlighted row keeps its scroll-into-view ref.
                  ref={(el) => {
                    sortable.setNodeRef(el);
                    if (isHighlighted) {
                      (highlightedRowRef as React.MutableRefObject<HTMLTableRowElement | null>).current = el;
                    }
                  }}
                  // data-row-id feeds the FLIP-on-drop measurement (see the
                  // pendingFlipRects layout effect). Only rows with a real backend
                  // id participate — index-keyed fallbacks can't be tracked across
                  // a reorder.
                  data-row-id={action.id ?? undefined}
                  {...sortable.listeners}
                  onClick={(e) => handleRowClick(idx, e)}
                  onContextMenu={(e) => handleRowContextMenu(idx, e)}
                  // Paused rows use the pause-action colour (purple by default) instead of
                  // the accent-blue "running" tint, plus a soft pulse to mirror the status-bar
                  // PAUSED indicator. The transform/transition pair is dnd-kit's live
                  // slide for row reorder; the profileShift branch reuses the same
                  // language for profiles dragged over the grid (rows at/below the
                  // insert point slide down one slot to open space).
                  style={{
                    ...(isPausedHere ? { backgroundColor: 'color-mix(in srgb, var(--color-action-pause-fg) 18%, transparent)' } : null),
                    transform: sortable.transform
                      ? CSS.Translate.toString(sortable.transform)
                      : (profileShift ? 'translateY(var(--ui-row-height))' : undefined),
                    transition: sortable.transition ?? profileDragTransition,
                  }}
                  className={`group h-row border-b border-border-subtle transition-colors relative ${
                    // Cursor signals draggability: grabbing during an active drag, grab on
                    // hover when THIS row can be dragged (per-row — Else/EndIf are pinned
                    // to their block), default otherwise (recording/replaying/editing).
                    dragIndices !== null
                      ? 'cursor-grabbing'
                      : !rowSortDisabled
                        ? 'cursor-grab'
                        : 'cursor-default'
                  } ${
                    isDragged ? 'opacity-40' : ''
                  } ${
                    isSkipped ? 'opacity-40' : ''
                  } ${
                    isPausedHere
                      ? 'animate-pulse'
                      : isHighlighted
                        ? 'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] hover:bg-bg-elevated'
                        : isSelected
                          ? 'bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] hover:bg-bg-elevated'
                          : isStructural
                            // Structural row tint replaces the odd/even striping so the
                            // whole IF / ELSE / ENDIF row group reads as a cohesive scope
                            // marker, distinct from the body rows it brackets. Hovering
                            // mixes the IF hue into the elevated colour instead of using
                            // plain bg-elevated, so the block tint survives the hover.
                            ? 'bg-[color-mix(in_srgb,var(--color-action-if-fg)_6%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-action-if-fg)_10%,var(--color-bg-elevated))]'
                            : isInBlock
                              ? 'bg-[color-mix(in_srgb,var(--color-action-if-fg)_3%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-action-if-fg)_7%,var(--color-bg-elevated))]'
                              : idx % 2 === 0
                                ? 'bg-bg-surface hover:bg-bg-elevated'
                                // Odd-row stripe: a whisper of text-primary instead of a
                                // fixed white overlay — follows the theme (darkens on
                                // light themes) and keeps the zebra deliberately subtle.
                                : 'bg-[color-mix(in_srgb,var(--color-text-primary)_1.5%,transparent)] hover:bg-bg-elevated'
                  }`}
                >
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
                      {actionPillLabel(action)}
                      {/* NOT badge — negated IF (IFNOT). Lives in the Action pill next
                          to "if" so the pill reads "if NOT"; the Details cell stays
                          focused on the probe payload. Solid fill (if-fg on the row's
                          surface) so it reads as an emphatic modifier on the keyword. */}
                      {action.actionType === 'If' && action.conditionNegate && (
                        <span
                          className="ml-0.5 px-1 rounded text-[9px] font-bold tracking-wider"
                          style={{ background: 'var(--color-action-if-fg)', color: 'var(--color-bg-surface)' }}
                          title="Negated condition — the TRUE branch fires when the probe FAILS (IFNOT)"
                        >
                          NOT
                        </span>
                      )}
                      {/* Repeat indicator — Keystroke press-cycles + RunProfile sub-call
                          counts. Lives inside the Action pill instead of the Key column
                          because long profile names used to push "×N" past the Key
                          col's truncation point and hide the repetition from the user.
                          Only renders when count > 1 (default 1 = no badge). */}
                      {(action.actionType === 'Keystroke' || action.actionType === 'RunProfile')
                        && (action.repeatCount ?? 1) > 1 && (
                          <span className="ml-0.5 opacity-75">×{action.repeatCount}</span>
                        )}
                      {/* Focus-click indicator — a small icon inside the Action pill (never a new
                          column) marking combined clicks that replay twice to focus a small
                          target. Only renders when the per-action flag is on, so off-rows stay
                          clean. Toggled from the row context menu ("Focus click"). */}
                      {action.isFocusClick
                        && /^(Left|Right|Middle)Click$/.test(action.actionType) && (
                          <Focus size={11} className="ml-0.5 opacity-80" />
                        )}
                    </span>
                  </td>
                  )}

                  {/* Details — the merged Key + X + Y column. Keyboard-ish actions
                      render their key/text/combo chip, mouse actions render the
                      "x, y" coordinate pair, If-pixel rows render both (hex chip +
                      probe coords). */}
                  {columnVisibility.details && (() => {
                    // Compute group membership once so the dblclick router and the
                    // td-level cursor class don't drift out of sync. Group A = inline
                    // edit / specialised dialog; Group B = open Sheet; mouse rows =
                    // inline "x, y" edit; the rest (Scroll, Else, EndIf) = no-op.
                    const isGroupA =
                      action.actionType === 'SendText'
                      || action.actionType === 'RunProfile'
                      || action.actionType === 'Keystroke'
                      || action.actionType === 'HoldKey'
                      || action.actionType.startsWith('Key'); // KeyDown / KeyUp
                    const isGroupB =
                      action.actionType === 'WaitImage'
                      || action.actionType === 'WaitPixelColor'
                      || action.actionType === 'Pause'
                      || action.actionType.startsWith('Browser')
                      || action.actionType === 'If';
                    // td-level cursor mirrors the chip's intent so EMPTY cells (WaitImage /
                    // WaitPixelColor with no value yet) still show the right affordance.
                    // When a chip is rendered, its own cursor class wins inside the chip
                    // hitbox; the td cursor only paints the surrounding padding.
                    const tdCursor = isGroupA
                      ? 'cursor-text'
                      : isGroupB
                        ? 'cursor-pointer'
                        : canEditXY
                          ? 'cursor-text'
                          : '';
                    return (
                  <td
                    className={`pl-1 ${tdCursor}`}
                    // SINGLE click at the <td> level so EMPTY cells respond too.
                    // Guards, in order: an open editor anywhere means this click is a
                    // commit-elsewhere/focus click, not an edit request; a click right
                    // after a drag is the drop release (handleRowClick consumes and
                    // resets the flag); modifier clicks are selection gestures and
                    // bubble to the row handler untouched. When the click IS an edit,
                    // stopPropagation keeps the row's select/deselect toggle out of it.
                    onClick={(e) => {
                      if (editingCell) return;
                      if (dragOccurred.current) return;
                      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
                      if (action.actionType === 'SendText') {
                        e.stopPropagation();
                        setSendTextEdit({ index: idx, text: action.key });
                      } else if (action.actionType === 'RunProfile') {
                        e.stopPropagation();
                        setRunProfileEdit({ index: idx, profileName: action.key, repeatCount: action.repeatCount ?? 1 });
                      } else if (action.actionType === 'Keystroke' || action.actionType === 'HoldKey') {
                        e.stopPropagation();
                        setKeystrokeEdit({ index: idx });
                      } else if (action.actionType.startsWith('Key')) {
                        // KeyDown/KeyUp edit on a single click like every other cell
                        // (the earlier select-first guard was removed at user request).
                        e.stopPropagation();
                        startEdit(idx, 'key', action.key);
                      } else if (action.actionType === 'Pause') {
                        // Pause reopens its own dialog (capture pad + timeout), not
                        // the Sheet — same window the toolbar uses to insert one.
                        e.stopPropagation();
                        setPauseEdit({ index: idx });
                      } else if (isGroupB) {
                        e.stopPropagation();
                        onOpenSheet?.(idx);
                      } else if (canEditXY) {
                        e.stopPropagation();
                        startEdit(idx, 'coords', `${action.x}, ${action.y}`);
                      }
                      // Scroll, Else, EndIf — fall through with no click action.
                      // Their Details cell has no editable meaning.
                    }}
                  >
                    {editingCell?.index === idx && editingCell.field === 'coords' ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={handleEditKeyDown}
                        onBlur={commitEdit}
                        placeholder="x, y"
                        className="w-[100px] h-6 px-1 text-xs font-mono text-text-primary bg-bg-input border border-accent-solid rounded outline-none"
                      />
                    ) : editingCell?.index === idx && editingCell.field === 'key' ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value=""
                        readOnly
                        placeholder="New key..."
                        onFocus={armKeyCaptureTimer}
                        onKeyDown={handleKeyCaptureKeyDown}
                        onBlur={() => { disarmKeyCaptureTimer(); cancelEdit(); }}
                        className="w-[220px] h-6 px-1 text-xs font-mono text-accent-light bg-bg-input border border-accent-solid rounded outline-none placeholder:text-accent-light/50 animate-pulse"
                      />
                    ) : isProbeAction(action) ? (
                      // Image/pixel probe (Wait* or If) — unified payload, no GUID.
                      <ProbeDetails action={action} />
                    ) : (<>
                    {displayKey ? (
                      <span
                        className={`inline-flex items-center translate-y-[-2px] px-2 py-0.5 rounded text-xs font-mono text-text-primary bg-bg-input max-w-[220px] truncate ${
                          // Group A — Key cell IS the primary editor for this action
                          // (text body, profile picker, keystroke combo, single key).
                          // cursor-text reflects "you can type / edit" semantics; dblclick
                          // routes to the specialized dialog or inline capture.
                          action.actionType === 'SendText' || action.actionType.startsWith('Key') || action.actionType === 'HoldKey' || action.actionType === 'RunProfile'
                            ? 'cursor-text hover:text-accent-light'
                            // Group B — Key cell shows a derived identifier (image
                            // filename, pixel hex, selector, etc.). dblclick opens the
                            // full Sheet panel for editing; cursor-pointer signals the
                            // chip is interactive without implying inline edit.
                            : action.actionType === 'WaitImage' || action.actionType === 'WaitPixelColor' || action.actionType === 'Pause'
                              || action.actionType.startsWith('Browser') || action.actionType === 'If'
                              ? 'cursor-pointer hover:text-accent-light'
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
                        // dblclick handler lives on the parent <td> (see above) so
                        // empty Key cells (WaitImage, WaitPixelColor with no value)
                        // also respond. Events bubble from this span to the td.
                      >
                        {/* Probe rows (Wait Image / Pixel, If image / pixel) render via
                            ProbeDetails above — the NOT badge + swatch live there now. */}
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
                          // Always milliseconds (was "1s"/"1.5s" for clean seconds) so every
                          // action duration reads in the same unit across the grid.
                          const label = `${ms}ms`;
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
                    {/* Coordinate pair — mouse actions show (and inline-edit) their
                        "x, y" here; If-pixel rows append the probe point after the
                        hex chip (read-only — the probe is edited via the Sheet).
                        Click handling lives on the parent <td> so the whole cell is
                        one edit target. */}
                    {displayX !== '' && (
                      <span
                        className={`text-xs font-mono text-text-secondary tabular-nums ${displayKey ? 'ml-1.5' : ''} ${canEditXY ? 'cursor-text hover:text-text-primary' : ''}`}
                      >
                        {displayX}, {displayY}
                      </span>
                    )}
                    </>)}
                  </td>
                    );
                  })()}

                  {/* Delay — single click anywhere in the cell opens the editor
                      (same guard chain as the Details cell). */}
                  {columnVisibility.delay && (
                  <td
                    className="pl-2 cursor-text"
                    onClick={(e) => {
                      if (editingCell) return;
                      if (dragOccurred.current) return;
                      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
                      e.stopPropagation();
                      startEdit(idx, 'delay', String(action.delay >= 0 ? action.delay : 0));
                    }}
                  >
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
                      <span className="text-xs font-mono text-text-secondary hover:text-text-primary">
                        {action.delay >= 0 ? action.delay : 0}
                      </span>
                    )}
                  </td>
                  )}

                  {/* Notes \u2014 single click anywhere in the cell opens the editor
                      (same guard chain as the Details cell). */}
                  {columnVisibility.notes && (
                  <td
                    className="pl-2 pr-2 cursor-text"
                    onClick={(e) => {
                      if (editingCell) return;
                      if (dragOccurred.current) return;
                      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
                      e.stopPropagation();
                      startEdit(idx, 'comment', action.comment);
                    }}
                  >
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
                      <span className="text-xs text-text-tertiary truncate block hover:text-text-secondary">
                        {action.comment || '\u00A0'}
                      </span>
                    )}
                  </td>
                  )}

                </tr>
                </Fragment>
                )}
                </SortableRowShell>
              );
            })}
            {/* Trailing insertion gap — drop position past the last row
                (profile drag only — row reorder slides live via dnd-kit). */}
            {dropTarget === actions.length && actions.length > 0
              && !(dragIndexSet?.has(actions.length - 1)) && (
              <tr data-drop-gap className="pointer-events-none">
                <td colSpan={99} className="p-0">
                  <div
                    className="drop-gap-slot mx-2 my-[3px] rounded border-2 border-dashed overflow-hidden"
                    style={{
                      height: 'calc(var(--ui-row-height) - 6px)',
                      borderColor: 'color-mix(in srgb, var(--color-accent) 45%, transparent)',
                      background: 'color-mix(in srgb, var(--color-accent) 6%, transparent)',
                    }}
                  />
                </td>
              </tr>
            )}
          </tbody>
          </SortableContext>
        </table>

        {/* Empty state */}
        {actions.length === 0 && <MacroEmptyState />}
      </div>

      {/* Drag ghost — a translucent replica of the grabbed row with a lifted-card
          shadow and a slight tilt, Sortable style. Multi-row drags add a "+N"
          count badge. DragOverlay tracks the pointer (and survives auto-scroll);
          dropAnimation is null because the FLIP-on-drop settle handles the
          landing — the default overlay animation would fly the ghost back to the
          row's OLD slot, since the array only reorders after the backend push. */}
      <DragOverlay dropAnimation={null} modifiers={[snapCenterToCursor]}>
        {dragIndices !== null && activeDragId !== null && (() => {
          const primary = actions[sortableIds.indexOf(activeDragId)];
          if (!primary) return null;
          const ghostColors = getActionTypeColors(primary.actionType);
          const ghostDetail = isMouseAction(primary.actionType)
            ? `${primary.x}, ${primary.y}`
            : getDisplayKey(primary.key);
          return (
            <div className="pointer-events-none" style={{ transform: 'rotate(1.5deg)' }}>
              <div
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-bg-card border border-border-default w-[300px]"
                style={{
                  opacity: 0.88,
                  boxShadow: '0 12px 32px rgba(0,0,0,0.5), 0 0 0 1px color-mix(in srgb, var(--color-accent) 35%, transparent)',
                }}
              >
                <GripVertical size={12} className="text-text-disabled shrink-0" />
                <span
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium shrink-0"
                  style={{ background: ghostColors.bg, color: ghostColors.fg }}
                >
                  <ActionIcon actionType={primary.actionType} />
                  {actionPillLabel(primary)}
                </span>
                {ghostDetail && (
                  <span className="text-xs font-mono text-text-secondary truncate flex-1">
                    {ghostDetail}
                  </span>
                )}
                {dragIndices.length > 1 && (
                  <span className="ml-auto shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-accent-solid text-white">
                    +{dragIndices.length - 1}
                  </span>
                )}
              </div>
            </div>
          );
        })()}
      </DragOverlay>
      </DndContext>

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

      {/* Pause edit dialog — same window as the toolbar's Insert Pause, seeded from
          the row. The dialog hands back the resume hotkey + timeout in ms; we diff
          against the current row and emit only the changed fields as actions:edit. */}
      {pauseEdit && (() => {
        const editing = actions[pauseEdit.index];
        return (
          <PauseDialog
            initialKey={editing?.key ?? ''}
            initialTimeoutMs={editing?.timeout ?? 0}
            onConfirm={(key, timeoutMs) => {
              const idx = pauseEdit.index;
              if (key !== (editing?.key ?? '')) {
                send({ type: 'actions:edit', payload: { index: idx, field: 'key', value: key } });
              }
              if (timeoutMs !== (editing?.timeout ?? 0)) {
                send({ type: 'actions:edit', payload: { index: idx, field: 'timeout', value: String(Math.round(timeoutMs)) } });
              }
              setPauseEdit(null);
            }}
            onClose={() => setPauseEdit(null)}
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

      {/* RunProfile insert dialog — opened by dragging a profile onto the grid
          (pre-filled with the dropped profile). The context-menu insert path was
          removed, but drag-to-insert still uses this. */}
      {runProfileInsert && (
        <RunProfileDialog
          excludeProfileName={activeProfile ?? undefined}
          initial={runProfileInsert.profileName ? { profileName: runProfileInsert.profileName, repeatCount: 1 } : undefined}
          onConfirm={(profileName, repeatCount) => {
            send({ type: 'actions:addRunProfile', payload: { profileName, repeatCount, insertIndex: runProfileInsert.insertIndex } });
            setRunProfileInsert(null);
          }}
          onClose={() => setRunProfileInsert(null)}
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
              } else if (rowAction?.actionType === 'Pause') {
                // Pause reopens its own capture-pad dialog, not the Sheet.
                setPauseEdit({ index: contextMenu.rowIndex });
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
                    navigator.clipboard.writeText(row.key ?? '')
                      .then(() => showToast('URL copied', 'success'))
                      .catch(() => showToast('Copy failed', 'error'));
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
                    navigator.clipboard.writeText(row.key ?? '')
                      .then(() => showToast('Selector copied', 'success'))
                      .catch(() => showToast('Copy failed', 'error'));
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
                    navigator.clipboard.writeText(row.key ?? '')
                      .then(() => showToast('Text copied', 'success'))
                      .catch(() => showToast('Copy failed', 'error'));
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
            // Paired-mode clicks are DOWN/UP pairs (LeftClickDown, LeftClickUp, …); combined
            // mode records the unsuffixed single-click form (LeftClick, RightClick, MiddleClick).
            // An earlier draft checked only the unsuffixed names and silently missed every
            // paired click row; user reported "Copy Coordinates doesn't appear for clicks"
            // because of this. The optional-suffix regex matches BOTH shapes.
            if (/^(Left|Right|Middle)Click(Down|Up)?$/.test(row.actionType ?? '')) {
              return (
                <button
                  onMouseEnter={onMouse}
                  onClick={() => {
                    navigator.clipboard.writeText(`${row.x ?? 0}, ${row.y ?? 0}`)
                      .then(() => showToast(`Copied ${row.x ?? 0}, ${row.y ?? 0}`, 'success'))
                      .catch(() => showToast('Copy failed', 'error'));
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

          {/* Focus click — combined clicks only. Toggles the per-action flag that replays the
              click TWICE a few pixels apart so a small target (e.g. a Roblox text field at the
              window's minimum size) actually receives focus. The state shows as a small icon in
              the Action pill (no grid column). Acts on the effective selection (the right-clicked
              row, or the whole multi-selection when the row is part of it), filtered to clicks. */}
          {(() => {
            const row = actions[contextMenu.rowIndex];
            if (!row || !/^(Left|Right|Middle)Click$/.test(row.actionType ?? '')) return null;
            const eff = selectedIndices.size > 0 && selectedIndices.has(contextMenu.rowIndex)
              ? Array.from(selectedIndices).sort((a, b) => a - b)
              : [contextMenu.rowIndex];
            const clickIdx = eff.filter(i => /^(Left|Right|Middle)Click$/.test(actions[i]?.actionType ?? ''));
            const allOn = clickIdx.length > 0 && clickIdx.every(i => actions[i]?.isFocusClick);
            return (
              <button
                onMouseEnter={() => setActiveSubmenu(null)}
                onClick={() => {
                  send({ type: 'actions:toggleFocusClick', payload: { indices: clickIdx } });
                  closeContextMenu();
                }}
                className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
              >
                <span className="flex items-center gap-2.5">
                  <Focus size={13} className="text-text-tertiary" />
                  Focus click
                </span>
                {allOn && <Check size={12} className="text-accent-light" />}
              </button>
            );
          })()}

          {/* Convert Left Click ↔ Double Click — quick toggle for combined left clicks,
              so a recorded LeftClick can become a DoubleClick (and back) without opening
              the Sheet. Acts on the effective selection filtered to the convertible type.
              Backend-wise it's just an actionType field edit. */}
          {(() => {
            const row = actions[contextMenu.rowIndex];
            if (!row || (row.actionType !== 'LeftClick' && row.actionType !== 'DoubleClick')) return null;
            const fromType = row.actionType;
            const toType = fromType === 'LeftClick' ? 'DoubleClick' : 'LeftClick';
            const eff = selectedIndices.size > 0 && selectedIndices.has(contextMenu.rowIndex)
              ? Array.from(selectedIndices).sort((a, b) => a - b)
              : [contextMenu.rowIndex];
            const convertIdx = eff.filter(i => actions[i]?.actionType === fromType);
            if (convertIdx.length === 0) return null;
            return (
              <button
                onMouseEnter={() => setActiveSubmenu(null)}
                onClick={() => {
                  for (const i of convertIdx) {
                    send({ type: 'actions:edit', payload: { index: i, field: 'actionType', value: toType } });
                  }
                  closeContextMenu();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
              >
                <MousePointerClick size={13} className="text-text-tertiary" />
                Convert to {toType === 'DoubleClick' ? 'Double Click' : 'Left Click'}
                {convertIdx.length > 1 && <span className="text-text-disabled">({convertIdx.length})</span>}
              </button>
            );
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

          {/* More ▸ — lower-frequency tools tucked into a submenu so the top level stays
              short. Grouped by purpose: select-similar, paired↔combined conversion, and
              Down/Up repeat collapse. (Skip lives in the bulk bar; Insert in the toolbar.) */}
          <div
            className="relative"
            onMouseEnter={() => setActiveSubmenu('more')}
            onMouseLeave={() => setActiveSubmenu(null)}
          >
            <button className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors">
              <span className="flex items-center gap-2.5">
                <MoreHorizontal size={13} className="text-text-tertiary" />
                More
              </span>
              <ChevronRight size={12} className="text-text-disabled" />
            </button>
            {activeSubmenu === 'more' && (
              <div ref={moreFlyout.ref} className={`absolute min-w-[210px] bg-transparent ${moreFlyout.flipX ? 'right-full' : 'left-full'} ${moreFlyout.flipY ? 'bottom-0' : 'top-0'}`} style={moreFlyout.flipX ? { paddingRight: '4px' } : { paddingLeft: '4px' }}>
                <div className="py-1 bg-bg-card border border-border-default rounded-md shadow-lg z-[60]">
                  {/* Select Similar */}
                  <button
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

                  <div className="my-1 border-t border-border-subtle" />

                  {/* Convert all actions between paired (Down/Up) and combined (Keystroke /
                      HoldKey / Click) forms. Whole-profile + undoable — the on-demand
                      counterpart to the record-time "Combined Actions" toggle. */}
                  <button
                    onClick={() => { send({ type: 'actions:convertMode', payload: { direction: 'toCombined' } }); setSelectedIndices(new Set<number>()); closeContextMenu(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
                  >
                    <Combine size={13} className="text-text-tertiary" />
                    Convert all to Combined
                  </button>
                  <button
                    onClick={() => { send({ type: 'actions:convertMode', payload: { direction: 'toPaired' } }); setSelectedIndices(new Set<number>()); closeContextMenu(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-elevated transition-colors"
                  >
                    <Split size={13} className="text-text-tertiary" />
                    Convert all to Paired
                  </button>

                  <div className="my-1 border-t border-border-subtle" />

                  {/* Collapse to × N / Expand × N — fold consecutive Down/Up pairs of the same
                      key into one Keystroke × N row (and back). Disabled (greyed) when the
                      current selection wouldn't qualify, so the feature stays discoverable. */}
                  {(() => {
                    const indices = selectedIndices.size > 0 && selectedIndices.has(contextMenu.rowIndex)
                      ? Array.from(selectedIndices).sort((a, b) => a - b)
                      : [contextMenu.rowIndex];
                    let contiguous = true;
                    for (let i = 1; i < indices.length; i++) {
                      if (indices[i] !== indices[i - 1] + 1) { contiguous = false; break; }
                    }
                    const rows = indices.map(i => actions[i]);
                    const collapseOk = contiguous && canCollapse(rows) !== null;
                    const expandOk = indices.length === 1 && canExpand(rows[0]);
                    return (
                      <>
                        <button
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
                </div>
              </div>
            )}
          </div>

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
