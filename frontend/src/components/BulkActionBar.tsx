import { useState } from 'react';
import { Clock, Trash2, X, Crosshair, MessageSquare, Eye, EyeOff, ArrowUpToLine, ArrowDownToLine } from 'lucide-react';
import { useTt } from '../state/LanguageContext';

interface BulkActionBarProps {
  selectedCount: number;
  allSelectedSkipped: boolean;
  // True when no selection can move further in that direction (first row selected
  // for Up, last row selected for Down). Disables the corresponding button rather
  // than no-op'ing the click — keeps the bar's affordance honest.
  canMoveUp: boolean;
  canMoveDown: boolean;
  onClearSelection: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onSetDelay: (delay: number) => void;
  onSetCoord: (axis: 'x' | 'y', value: string) => void;
  onSetComment: (comment: string) => void;
  onToggleSkip: () => void;
}

export function BulkActionBar({
  selectedCount,
  allSelectedSkipped,
  canMoveUp,
  canMoveDown,
  onClearSelection,
  onDelete,
  onMoveUp,
  onMoveDown,
  onSetDelay,
  onSetCoord,
  onSetComment,
  onToggleSkip,
}: BulkActionBarProps) {
  const tt = useTt();
  const [activeInput, setActiveInput] = useState<'delay' | 'x' | 'y' | 'notes' | null>(null);
  const [inputValue, setInputValue] = useState('');

  if (selectedCount === 0) return null;

  // True only while the delay field holds a non-empty, unparseable/negative value.
  // Drives the invalid-styled border below and blocks confirm so the bad value
  // isn't silently dropped (RELIABILITY: previously handleConfirm just closed the
  // field on invalid input with no feedback). Empty stays valid = an OK/Enter on a
  // blank field is a clean cancel, matching the X/Y branch's no-op-on-blank.
  const delayInvalid =
    activeInput === 'delay' &&
    inputValue.trim() !== '' &&
    !(parseInt(inputValue, 10) >= 0);

  const handleConfirm = () => {
    if (!activeInput) return;
    if (activeInput === 'delay') {
      // Keep the field open + invalid-styled instead of discarding silently.
      if (delayInvalid) return;
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
    <div className="flex items-center h-8 px-3 border-t border-accent-solid/30 shrink-0 bg-[color-mix(in_srgb,var(--color-accent)_6%,var(--color-bg-card))] shadow-[0_-4px_12px_rgba(0,0,0,0.18)]">
      {/* Left: selection info + clear. shrink-0 + whitespace-nowrap make sure the
          "N selected" text stays on one line even if the right-side button cluster
          grows enough to compress the flex layout — without these, narrow window
          widths would wrap "N" and "selected" onto two lines. */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs font-semibold text-accent-light whitespace-nowrap">{selectedCount} selected</span>
        <button
          onClick={onClearSelection}
          className="p-0.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
          data-tip={tt('Clear selection (Esc)', 'Limpar seleção (Esc)')}
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
            {/* X/Y accept a signed offset (+10 / -5) applied to each selection or a plain number
                that sets them all. Shown inline to the LEFT of the field (it grows into the
                spacer) so the input + OK keep the exact position the other edit types use. */}
            {(activeInput === 'x' || activeInput === 'y') && (
              <span className="text-[10px] text-text-tertiary whitespace-nowrap">
                {tt('+/- offsets each · number sets all', '+/- desloca cada · número define todos')}
              </span>
            )}
            <span className="text-[10px] text-text-disabled uppercase">{activeInput === 'notes' ? 'Notes' : activeInput}</span>
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); if (e.key === 'Escape') setActiveInput(null); }}
              autoFocus
              placeholder={inputPlaceholder}
              className={`${inputWidth} h-6 px-2 text-[11px] font-mono bg-bg-input border rounded text-center text-text-primary outline-none ${
                delayInvalid ? 'border-recording/60 focus:border-recording' : 'border-border-default focus:border-accent-solid'
              }`}
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
            {/* Move Up / Move Down — first group, mirrors the reorder gesture users
                already use via Alt+↑/↓. Only enabled when the selection isn't already
                at the start / end of the list. */}
            <button
              onClick={onMoveUp}
              disabled={!canMoveUp}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
              data-tip={tt('Move selection up (Alt+↑)', 'Mover seleção para cima (Alt+↑)')}
            >
              <ArrowUpToLine size={11} />
            </button>
            <button
              onClick={onMoveDown}
              disabled={!canMoveDown}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
              data-tip={tt('Move selection down (Alt+↓)', 'Mover seleção para baixo (Alt+↓)')}
            >
              <ArrowDownToLine size={11} />
            </button>

            <div className="w-px h-3.5 bg-border-subtle mx-0.5" />

            {/* Set Delay */}
            <button
              onClick={() => openInput('delay')}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <Clock size={11} />
              Delay
            </button>

            {/* Set X / Y — Crosshair icon mirrors the Copy Coordinates entry in the row
                context menu, so coord-related UI uses the same glyph across the app. */}
            <button
              onClick={() => openInput('x')}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <Crosshair size={11} />
              X
            </button>

            <button
              onClick={() => openInput('y')}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <Crosshair size={11} />
              Y
            </button>

            {/* Set Notes */}
            <button
              onClick={() => openInput('notes')}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <MessageSquare size={11} />
              Notes
            </button>

            <div className="w-px h-3.5 bg-border-subtle mx-0.5" />

            {/* Skip / Enable — Eye / EyeOff mirrors the row context menu's Skip toggle
                so the same visual vocabulary travels across both surfaces. Duplicate
                was removed from here; the row context menu still has it, which is the
                more discoverable path for the rare cases users want a copy of a row. */}
            <button
              onClick={onToggleSkip}
              className={`flex items-center gap-1 h-6 px-2 rounded text-[11px] transition-colors ${
                allSelectedSkipped
                  ? 'text-accent-light hover:text-accent-light hover:bg-accent-solid/10'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-bg-elevated'
              }`}
              data-tip={allSelectedSkipped ? tt('Enable selected (include in replay)', 'Ativar selecionados (incluir na reprodução)') : tt('Skip selected (exclude from replay)', 'Pular selecionados (excluir da reprodução)')}
            >
              {allSelectedSkipped ? <Eye size={11} /> : <EyeOff size={11} />}
              {allSelectedSkipped ? 'Enable' : 'Skip'}
            </button>

            {/* Delete — destructive group of one. Tooltip carries the Del hotkey
                hint; inline "Del" badge would bump the bar over at narrow widths. */}
            <button
              onClick={onDelete}
              className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-recording hover:text-recording/80 hover:bg-recording-bg transition-colors"
              data-tip={tt('Delete selected (Del)', 'Excluir selecionados (Del)')}
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
