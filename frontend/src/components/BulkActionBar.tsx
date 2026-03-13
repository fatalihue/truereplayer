import { useState } from 'react';
import { Clock, Copy, Trash2, X } from 'lucide-react';

interface BulkActionBarProps {
  selectedCount: number;
  selectedIndices: Set<number>;
  onClearSelection: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onSetDelay: (delay: number) => void;
}

export function BulkActionBar({
  selectedCount,
  selectedIndices: _selectedIndices,
  onClearSelection,
  onDelete,
  onDuplicate,
  onSetDelay,
}: BulkActionBarProps) {
  const [showDelayInput, setShowDelayInput] = useState(false);
  const [delayValue, setDelayValue] = useState('');

  if (selectedCount === 0) return null;

  const handleSetDelay = () => {
    const delay = parseInt(delayValue, 10);
    if (!isNaN(delay) && delay >= 0) {
      onSetDelay(delay);
      setShowDelayInput(false);
      setDelayValue('');
    }
  };

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
        {/* Set Delay */}
        {showDelayInput ? (
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={delayValue}
              onChange={(e) => setDelayValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSetDelay(); if (e.key === 'Escape') setShowDelayInput(false); }}
              autoFocus
              className="w-20 h-6 px-2 text-[11px] font-mono bg-bg-input border border-border-default rounded text-center text-text-primary outline-none focus:border-accent-solid"
            />
            <button
              onClick={handleSetDelay}
              className="h-6 px-2 rounded text-[11px] font-medium bg-accent-solid text-white hover:bg-accent-solid/80 transition-colors"
            >
              OK
            </button>
            <button
              onClick={() => setShowDelayInput(false)}
              className="h-6 px-1.5 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <X size={10} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowDelayInput(true)}
            className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
            title="Set delay for selected"
          >
            <Clock size={11} />
            Delay (ms)
          </button>
        )}

        <div className="w-px h-3.5 bg-border-subtle mx-0.5" />

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
      </div>
    </div>
  );
}
