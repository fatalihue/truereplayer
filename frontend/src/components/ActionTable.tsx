import { useRef, useEffect, useState, useCallback } from 'react';
import { Mouse, Keyboard, ArrowUp, ArrowDown, Zap, Type, GripVertical } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { getDisplayKey, getDisplayX, getDisplayY, getActionTypeColors } from '../utils/displayUtils';
import { SendTextDialog } from './SendTextDialog';

function ActionIcon({ actionType }: { actionType: string }) {
  const size = 12;
  if (actionType.includes('Click')) return <Mouse size={size} />;
  if (actionType === 'ScrollUp') return <ArrowUp size={size} />;
  if (actionType === 'ScrollDown') return <ArrowDown size={size} />;
  if (actionType.startsWith('Key')) return <Keyboard size={size} />;
  if (actionType === 'SendText') return <Type size={size} />;
  return <Zap size={size} />;
}

interface EditingCell {
  index: number;
  field: 'delay' | 'comment' | 'x' | 'y' | 'key';
}

export function ActionTable() {
  const { actions, highlightedActionIndex, buttonStates } = useAppState();
  const { send } = useBridge();
  const selectionRef = useSelectionRef();
  const scrollRef = useRef<HTMLDivElement>(null);
  const highlightedRowRef = useRef<HTMLTableRowElement>(null);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const lastClickedIndex = useRef<number | null>(null);
  const prevActionsLength = useRef(actions.length);
  const wasRecording = useRef(false);
  const [sendTextEdit, setSendTextEdit] = useState<{ index: number; text: string } | null>(null);
  const [dragIndices, setDragIndices] = useState<number[] | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  // Suppress hotkeys while SendText edit dialog or inline key editing is active
  const modalActive = sendTextEdit !== null || editingCell !== null;
  useEffect(() => {
    if (modalActive) {
      send({ type: 'ui:modalOpen', payload: {} });
      return () => { send({ type: 'ui:modalClose', payload: {} }); };
    }
  }, [modalActive, send]);

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

  // Auto-scroll to highlighted row during replay
  useEffect(() => {
    if (highlightedActionIndex !== null && highlightedRowRef.current) {
      highlightedRowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [highlightedActionIndex]);

  // Auto-scroll when new actions are added during recording
  // In append mode (no selection): scroll to bottom
  // In insert mode (has selection): keep viewport stable
  useEffect(() => {
    if (actions.length > prevActionsLength.current && scrollRef.current) {
      if (selectionRef.current.size === 0) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
    prevActionsLength.current = actions.length;
  }, [actions.length, selectionRef]);

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

  // Handle row click with selection logic
  const handleRowClick = useCallback((idx: number, e: React.MouseEvent) => {
    if (editingCell) return;

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
    if (editingCell) return;

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
  }, [editingCell, selectedIndices, send, actions]);

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

  // Key capture for editing the Key column — captures the pressed key name (like recording)
  const handleKeyCaptureKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') { cancelEdit(); return; }

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

    if (e.code.startsWith('Numpad') && e.code !== 'NumpadEnter') {
      keyName = numpadMap[e.code] ?? e.code;
    } else if (e.key === ' ') keyName = 'Space';
    else if (e.key === 'Enter') keyName = 'Return';
    else if (e.key === 'Backspace') keyName = 'Back';
    else if (e.key === 'ArrowUp') keyName = 'Up';
    else if (e.key === 'ArrowDown') keyName = 'Down';
    else if (e.key === 'ArrowLeft') keyName = 'Left';
    else if (e.key === 'ArrowRight') keyName = 'Right';
    else if (e.key === 'Control') keyName = e.code === 'ControlRight' ? '163' : '162';
    else if (e.key === 'Shift') keyName = e.code === 'ShiftRight' ? '161' : '160';
    else if (e.key === 'Alt') keyName = e.code === 'AltRight' ? '165' : '164';
    else if (e.key === 'Tab') keyName = 'Tab';
    else if (e.key === 'CapsLock') keyName = 'Capital';
    else if (e.key === 'Delete') keyName = 'Delete';
    else if (e.key === 'Insert') keyName = 'Insert';
    else if (e.key === 'Home') keyName = 'Home';
    else if (e.key === 'End') keyName = 'End';
    else if (e.key === 'PageUp') keyName = 'Prior';
    else if (e.key === 'PageDown') keyName = 'Next';
    else if (e.key === 'F1') keyName = 'F1';
    else if (e.key.startsWith('F') && e.key.length <= 3 && !isNaN(Number(e.key.slice(1)))) keyName = e.key;
    else if (e.key === 'Meta') return; // Ignore Win key
    else if (e.key.length === 1) {
      // Single character: letters → uppercase, digits → "D" prefix for top-row
      const c = e.key.toUpperCase();
      if (/\d/.test(c)) keyName = `D${c}`;
      else if (/[A-Z]/.test(c)) keyName = c;
      else {
        // Symbol keys — map by e.code
        const symbolMap: Record<string, string> = {
          Backquote: 'Oem3', Minus: 'OemMinus', Equal: 'OemPlus',
          BracketLeft: 'Oem4', BracketRight: 'Oem6', Backslash: 'Oem5',
          Semicolon: 'Oem1', Quote: 'Oem7', Comma: 'OemComma',
          Period: 'OemPeriod', Slash: 'Oem2',
        };
        keyName = symbolMap[e.code] ?? c;
      }
    } else {
      return; // Unknown key, ignore
    }

    setEditValue(keyName);
    // Auto-commit after capture
    if (editingCell) {
      send({
        type: 'actions:edit',
        payload: { index: editingCell.index, field: editingCell.field, value: keyName },
      });
      setEditingCell(null);
    }
  }, [cancelEdit, editingCell, send]);

  // Drag & drop via mouse events (HTML5 drag API doesn't work in WebView2)
  const isDraggable = !buttonStates.recordingActive && !buttonStates.replayActive && !editingCell;
  const dragState = useRef<{ indices: number[]; started: boolean } | null>(null);
  const dropTargetRef = useRef<number | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);

  const handleGripMouseDown = useCallback((idx: number, e: React.MouseEvent) => {
    if (!isDraggable) return;
    e.preventDefault();
    e.stopPropagation();
    // If grip row is part of selection, drag all selected; otherwise drag only this one
    const indices = selectedIndices.has(idx)
      ? Array.from(selectedIndices).sort((a, b) => a - b)
      : [idx];
    dragState.current = { indices, started: true };
    dropTargetRef.current = null;
    setDragIndices(indices);
  }, [isDraggable, selectedIndices]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState.current?.started || !tbodyRef.current) return;
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
      if (!dragState.current?.started) return;
      const indices = dragState.current.indices;
      const target = dropTargetRef.current;

      if (target !== null && indices.length > 0) {
        send({ type: 'actions:reorder', payload: { indices, targetIndex: target } });
        setSelectedIndices(new Set());
      }

      dragState.current = null;
      dropTargetRef.current = null;
      setDragIndices(null);
      setDropTarget(null);
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

  return (
    <div
      className="flex-1 bg-bg-surface border border-border-subtle rounded-ui overflow-hidden flex flex-col outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="grid grid-cols-[50px_140px_100px_65px_65px_70px_1fr] items-center h-row px-1 border-b border-border-subtle shrink-0">
        <span className="text-xs font-semibold text-text-tertiary pl-3">#</span>
        <span className="text-xs font-semibold text-text-tertiary pl-1">Action</span>
        <span className="text-xs font-semibold text-text-tertiary pl-1">Key</span>
        <span className="text-xs font-semibold text-text-tertiary pl-1">X</span>
        <span className="text-xs font-semibold text-text-tertiary pl-1">Y</span>
        <span className="text-xs font-semibold text-text-tertiary pl-1">Delay</span>
        <span className="text-xs font-semibold text-text-tertiary pl-1">Notes</span>
      </div>

      {/* Body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <table className="w-full">
          <tbody ref={tbodyRef}>
            {actions.map((action, idx) => {
              const colors = getActionTypeColors(action.actionType);
              const isHighlighted = highlightedActionIndex === idx;
              const isSelected = selectedIndices.has(idx);
              const displayKey = getDisplayKey(action.key);
              const displayX = getDisplayX(action);
              const displayY = getDisplayY(action);
              const canEditXY = isMouseAction(action.actionType);

              const isDragged = dragIndices?.includes(idx) ?? false;
              const showDropBefore = dropTarget === idx && !isDragged;
              const showDropAfter = dropTarget === idx + 1 && !isDragged && !(dragIndices?.includes(idx + 1));

              return (
                <tr
                  key={idx}
                  ref={isHighlighted ? highlightedRowRef : undefined}
                  onClick={(e) => handleRowClick(idx, e)}
                  className={`h-row border-b border-border-subtle transition-colors cursor-default relative ${
                    isDragged ? 'opacity-40' : ''
                  } ${
                    isHighlighted
                      ? 'bg-[rgba(218,185,80,0.08)]'
                      : isSelected
                        ? 'bg-[rgba(96,205,255,0.08)]'
                        : idx % 2 === 0
                          ? 'bg-bg-surface'
                          : 'bg-[rgba(255,255,255,0.02)]'
                  } hover:bg-bg-elevated`}
                >
                  {/* Drop indicator lines */}
                  {showDropBefore && (
                    <td colSpan={7} className="absolute top-0 left-0 right-0 h-0 p-0 border-0">
                      <div className="absolute top-[-1px] left-2 right-2 h-[2px] bg-accent-solid rounded-full" />
                    </td>
                  )}
                  {showDropAfter && (
                    <td colSpan={7} className="absolute bottom-0 left-0 right-0 h-0 p-0 border-0">
                      <div className="absolute bottom-[-1px] left-2 right-2 h-[2px] bg-accent-solid rounded-full" />
                    </td>
                  )}

                  {/* Row number + grip */}
                  <td className="w-[50px] pl-1">
                    <div className="flex items-center gap-0.5 leading-none">
                      <GripVertical size={11} onMouseDown={(e) => handleGripMouseDown(idx, e)} className={`shrink-0 text-text-disabled translate-y-[0.5px] ${isDraggable ? 'cursor-grab active:cursor-grabbing' : ''}`} />
                      <span className="text-[11px] font-mono text-text-disabled leading-none">{action.rowNumber}</span>
                    </div>
                  </td>

                  {/* Action type pill */}
                  <td className="w-[140px] pl-1">
                    <span
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium"
                      style={{ background: colors.bg, color: colors.fg }}
                    >
                      <ActionIcon actionType={action.actionType} />
                      {action.actionType}
                    </span>
                  </td>

                  {/* Key */}
                  <td className="w-[100px] pl-1">
                    {editingCell?.index === idx && editingCell.field === 'key' ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value=""
                        readOnly
                        placeholder="Press a key..."
                        onKeyDown={handleKeyCaptureKeyDown}
                        onBlur={cancelEdit}
                        className="w-[92px] h-6 px-1 text-xs font-mono text-accent-light bg-bg-input border border-accent-solid rounded outline-none placeholder:text-accent-light/50 animate-pulse"
                      />
                    ) : displayKey ? (
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-mono text-text-primary bg-bg-input max-w-[92px] truncate ${
                          action.actionType === 'SendText' || action.actionType.startsWith('Key')
                            ? 'cursor-text hover:text-accent-light'
                            : ''
                        }`}
                        title={action.actionType === 'SendText' ? action.key : undefined}
                        onDoubleClick={() => {
                          if (action.actionType === 'SendText') {
                            setSendTextEdit({ index: idx, text: action.key });
                          } else if (action.actionType.startsWith('Key')) {
                            startEdit(idx, 'key', action.key);
                          }
                        }}
                      >
                        {displayKey}
                      </span>
                    ) : null}
                  </td>

                  {/* X */}
                  <td className="w-[65px] pl-2">
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

                  {/* Y */}
                  <td className="w-[65px] pl-2">
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

                  {/* Delay */}
                  <td className="w-[70px] pl-2">
                    {editingCell?.index === idx && editingCell.field === 'delay' ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={handleEditKeyDown}
                        onBlur={commitEdit}
                        className="w-16 h-6 px-1 text-xs font-mono text-delay bg-bg-input border border-accent-solid rounded outline-none"
                      />
                    ) : (
                      <span
                        className="text-xs font-mono font-medium text-delay cursor-text hover:text-delay/80"
                        onDoubleClick={() => startEdit(idx, 'delay', String(action.delay >= 0 ? action.delay : 0))}
                      >
                        {action.delay >= 0 ? action.delay : 0}
                      </span>
                    )}
                  </td>

                  {/* Notes */}
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
    </div>
  );
}
