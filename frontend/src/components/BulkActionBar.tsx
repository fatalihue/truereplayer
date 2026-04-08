import { useState } from 'react';
import { Clock, Copy, Clipboard, Trash2, X, Move, MessageSquare } from 'lucide-react';

interface BulkActionBarProps {
  selectedCount: number;
  selectedIndices: Set<number>;
  onClearSelection: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onSetDelay: (delay: number) => void;
  onSetCoord: (axis: 'x' | 'y', value: string) => void;
  onSetComment: (comment: string) => void;
  onCopyActions: () => void;
}

export function BulkActionBar({
  selectedCount,
  selectedIndices: _selectedIndices,
  onClearSelection,
  onDelete,
  onDuplicate,
  onSetDelay,
  onSetCoord,
  onCopyActions,
  onSetComment,
}: BulkActionBarProps) {
  const [activeInput, setActiveInput] = useState<'delay' | 'x' | 'y' | 'notes' | null>(null);
  const [inputValue, setInputValue] = useState('');

  if (selectedCount === 0) return null;

  const handleConfirm = () => {
    if (!activeInput) return;
    if (activeInput === 'delay') {
      const delay = parseInt(inputValue, 10);
      if (!isNaN(delay) && delay >= 0) onSetDelay(delay);
    } else if (activeInput === 'x' || activeInput === 'y') {
      if (inputValue.trim()) onSetCoord(activeInput, inputValue.trim());
    } else if (activeInput === 'notes') {
      onSetComment(inputValue);
    }
    setActiveInput(null);
    setInputValue('');
  };

  const openInput = (type: 'delay' | 'x' | 'y' | 'notes') => {
    setActiveInput(type);
    setInputValue('');
  };

  const inputPlaceholder = activeInput === 'delay' ? 'ms'
    : activeInput === 'x' || activeInput === 'y' ? '+10, -5, or 500'
    : 'Note text';

  const inputWidth = activeInput === 'notes' ? 'w-40' : 'w-24';

  return (
    <div className="flex items-center h-8 px-3 border-t border-accent-solid/20 shrink-0 bg-[rgba(96,205,255,0.04)]">
      {/* Left: selection info + clear */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-accent">{selectedCount} selected</span>
        <button
          onClick={onClearSelection}
          className="p-0.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
          title="Clear selection"
        >
          <X size={11} />
        </button>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right: action buttons */}
      <div className="flex items-center gap-1">
        {/* Inline Input (shared for all bulk edit types) */}
        {activeInput ? (
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-text-disabled uppercase">{activeInput === 'notes' ? 'Notes' : activeInput}</span>
            <input
              type={activeInput === 'notes' ? 'text' : 'text'}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); if (e.key === 'Escape') setActiveInput(null); }}
              autoFocus
              placeholder={inputPlaceholder}
              className={`${inputWidth} h-6 px-2 text-[11px] font-mono bg-bg-input border border-border-default rounded text-center text-text-primary outline-none focus:border-accent-solid`}
            />
            <button
              onClick={handleConfirm}
              className="h-6 px-2 rounded text-[11px] font-medium bg-accent-solid text-white hover:bg-accent-solid/80 transition-colors"
            >
              OK
            </button>
            <button
              onClick={() => setActiveInput(null)}
              className="h-6 px-1.5 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <X size={10} />
            </button>
          </div>
        ) : (
          <>
            {/* Set Delay */}
            <button
              onClick={() => openInput('delay')}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
              title="Set delay for selected"
            >
              <Clock size={11} />
              Delay
            </button>

            {/* Set X */}
            <button
              onClick={() => openInput('x')}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
              title="Set X for selected (use +/- for offset)"
            >
              <Move size={11} />
              X
            </button>

            {/* Set Y */}
            <button
              onClick={() => openInput('y')}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
              title="Set Y for selected (use +/- for offset)"
            >
              <Move size={11} />
              Y
            </button>

            {/* Set Notes */}
            <button
              onClick={() => openInput('notes')}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
              title="Set notes for selected"
            >
              <MessageSquare size={11} />
              Notes
            </button>

            <div className="w-px h-3.5 bg-border-subtle mx-0.5" />

            {/* Copy (internal clipboard) */}
            <button
              onClick={onCopyActions}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
              title="Copy actions (Ctrl+C) — paste in any profile with Ctrl+V"
            >
              <Clipboard size={11} />
              Copy
            </button>

            {/* Duplicate */}
            <button
              onClick={onDuplicate}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
              title="Duplicate selected"
            >
              <Copy size={11} />
              Duplicate
            </button>

            <div className="w-px h-3.5 bg-border-subtle mx-0.5" />

            {/* Delete */}
            <button
              onClick={onDelete}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-recording hover:text-recording/80 hover:bg-recording-bg transition-colors"
              title="Delete selected"
            >
              <Trash2 size={11} />
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}
