import { useRef, useEffect, useState, useCallback } from 'react';
import { Mouse, Keyboard, ArrowUp, ArrowDown, Zap } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { getDisplayKey, getDisplayX, getDisplayY, getActionTypeColors } from '../utils/displayUtils';

function ActionIcon({ actionType }: { actionType: string }) {
  const size = 12;
  if (actionType.includes('Click')) return <Mouse size={size} />;
  if (actionType === 'ScrollUp') return <ArrowUp size={size} />;
  if (actionType === 'ScrollDown') return <ArrowDown size={size} />;
  if (actionType.startsWith('Key')) return <Keyboard size={size} />;
  return <Zap size={size} />;
}

interface EditingCell {
  index: number;
  field: 'delay' | 'comment' | 'x' | 'y';
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

  const isMouseAction = (actionType: string) =>
    actionType.includes('Click') || actionType.includes('Middle');

  return (
    <div
      className="flex-1 bg-bg-surface border border-border-subtle rounded-ui overflow-hidden flex flex-col outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="grid grid-cols-[35px_140px_100px_65px_65px_70px_1fr] items-center h-row px-1 border-b border-border-subtle shrink-0">
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
          <tbody>
            {actions.map((action, idx) => {
              const colors = getActionTypeColors(action.actionType);
              const isHighlighted = highlightedActionIndex === idx;
              const isSelected = selectedIndices.has(idx);
              const displayKey = getDisplayKey(action.key);
              const displayX = getDisplayX(action);
              const displayY = getDisplayY(action);
              const canEditXY = isMouseAction(action.actionType);

              return (
                <tr
                  key={idx}
                  ref={isHighlighted ? highlightedRowRef : undefined}
                  onClick={(e) => handleRowClick(idx, e)}
                  className={`h-row border-b border-border-subtle transition-colors cursor-default ${
                    isHighlighted
                      ? 'bg-[rgba(218,185,80,0.08)]'
                      : isSelected
                        ? 'bg-[rgba(96,205,255,0.08)]'
                        : idx % 2 === 0
                          ? 'bg-bg-surface'
                          : 'bg-[rgba(255,255,255,0.02)]'
                  } hover:bg-bg-elevated`}
                >
                  {/* Row number */}
                  <td className="w-[35px] pl-3">
                    <span className="text-[11px] font-mono text-text-disabled">{action.rowNumber}</span>
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
                    {displayKey && (
                      <span className="inline-block px-2 py-0.5 rounded text-xs font-mono text-text-primary bg-bg-input">
                        {displayKey}
                      </span>
                    )}
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
    </div>
  );
}
