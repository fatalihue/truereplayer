import { useState } from 'react';
import { Clock, Copy, Trash2, X, Crosshair, MessageSquare, Eye, EyeOff, ArrowUpToLine, ArrowDownToLine } from 'lucide-react';

interface BulkActionBarProps {
  selectedCount: number;
  selectedIndices: Set<number>;
  allSelectedSkipped: boolean;
  // True when no selection can move further in that direction (first row selected
  // for Up, last row selected for Down). Disables the corresponding button rather
  // than no-op'ing the click — keeps the bar's affordance honest.
  canMoveUp: boolean;
  canMoveDown: boolean;
  onClearSelection: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onSetDelay: (delay: number) => void;
  onSetCoord: (axis: 'x' | 'y', value: string) => void;
  onSetComment: (comment: string) => void;
  onToggleSkip: () => void;
}

export function BulkActionBar({
  selectedCount,
  selectedIndices: _selectedIndices,
  allSelectedSkipped,
  canMoveUp,
  canMoveDown,
  onClearSelection,
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  onSetDelay,
  onSetCoord,
  onSetComment,
  onToggleSkip,
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
      {/* Left: selection info + clear. shrink-0 + whitespace-nowrap make sure the
          "N selected" text stays on one line even if the right-side button cluster
          grows enough to compress the flex layout — without these, narrow window
          widths would wrap "N" and "selected" onto two lines. */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs font-semibold text-accent-light whitespace-nowrap">{selectedCount} selected</span>
        <button
          onClick={onClearSelection}
          className="p-0.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
          title="Clear selection (Esc)"
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

            {/* Set X / Y — Crosshair icon mirrors the Copy Coordinates entry in the row
                context menu, so coord-related UI uses the same glyph across the app
                (previously Hash, which reads as "number / tag" not "coordinate"). */}
            <button
              onClick={() => openInput('x')}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
              title="Set X for selected (use +/- for offset)"
            >
              <Crosshair size={11} />
              X
            </button>

            <button
              onClick={() => openInput('y')}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
              title="Set Y for selected (use +/- for offset)"
            >
              <Crosshair size={11} />
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

            {/* Move Up / Move Down — moved here from the toolbar because these only
                make sense with a selection (the toolbar versions were dead weight
                otherwise). Same payload (actions:reorder) under the hood; the
                Alt+↑/↓ hotkey continues to work from anywhere. Disabled when the
                selection is already at the top / bottom of the list. */}
            <button
              onClick={onMoveUp}
              disabled={!canMoveUp}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
              title="Move selection up (Alt+↑)"
            >
              <ArrowUpToLine size={11} />
            </button>
            <button
              onClick={onMoveDown}
              disabled={!canMoveDown}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
              title="Move selection down (Alt+↓)"
            >
              <ArrowDownToLine size={11} />
            </button>

            {/* Copy was removed here — redundant with the toolbar's Copy button
                which is always visible and already does "copy selection if any,
                else copy all". Having two Copy buttons on screen at the same time
                while rows were selected just added clutter. Ctrl+C still works
                from anywhere. */}

            {/* Duplicate */}
            <button
              onClick={onDuplicate}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
              title="Duplicate selected"
            >
              <Copy size={11} />
              Duplicate
            </button>

            {/* Skip / Enable — Eye / EyeOff mirrors the row context menu's Skip toggle
                so the same visual vocabulary travels across both surfaces. Active
                colour standardised to text-accent-light (matches the toolbar's
                active dropdown state); the previous text-accent (solid) was the
                lone holdout from the active-state cleanup pass. */}
            <button
              onClick={onToggleSkip}
              className={`flex items-center gap-1 h-6 px-2 rounded text-[11px] transition-colors ${
                allSelectedSkipped
                  ? 'text-accent-light hover:text-accent-light hover:bg-accent-solid/10'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-bg-elevated'
              }`}
              title={allSelectedSkipped ? 'Enable selected (include in replay)' : 'Skip selected (exclude from replay)'}
            >
              {allSelectedSkipped ? <Eye size={11} /> : <EyeOff size={11} />}
              {allSelectedSkipped ? 'Enable' : 'Skip'}
            </button>

            <div className="w-px h-3.5 bg-border-subtle mx-0.5" />

            {/* Delete — kbd hint kept in the tooltip only; inline "Del" badge made
                the bar overflow at narrower window widths and bumped the "N selected"
                text into wrapping. Tooltip is enough — the row context menu's "Del"
                badge has a justify-between layout that absorbs it cleanly; this bar
                is denser. */}
            <button
              onClick={onDelete}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-recording hover:text-recording/80 hover:bg-recording-bg transition-colors"
              title="Delete selected (Del)"
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
