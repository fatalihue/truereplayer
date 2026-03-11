import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft } from 'lucide-react';
import { useBridge } from '../bridge/BridgeContext';
import { useAppState } from '../state/AppStateContext';

interface SheetPanelProps {
  actionIndex: number | null;
  onClose: () => void;
}

const actionTypes = [
  { value: 'LeftClick', label: 'Left Click' },
  { value: 'RightClick', label: 'Right Click' },
  { value: 'MiddleClick', label: 'Mid Click' },
  { value: 'KeyDown', label: 'KeyDown' },
  { value: 'KeyUp', label: 'KeyUp' },
  { value: 'ScrollUp', label: 'ScrollUp ↑' },
  { value: 'ScrollDown', label: 'ScrollDown ↓' },
  { value: 'SendText', label: 'Text' },
];

const noCoordTypes = new Set(['KeyDown', 'KeyUp', 'ScrollUp', 'ScrollDown', 'SendText']);

export function SheetPanel({ actionIndex, onClose }: SheetPanelProps) {
  const { actions } = useAppState();
  const { send } = useBridge();

  const action = actionIndex != null ? actions[actionIndex] : null;

  const [actionType, setActionType] = useState('');
  const [key, setKey] = useState('');
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [delay, setDelay] = useState('');
  const [comment, setComment] = useState('');

  // Sync local state from action
  useEffect(() => {
    if (action) {
      setActionType(action.actionType);
      setKey(action.key);
      setX(String(action.x || ''));
      setY(String(action.y || ''));
      setDelay(String(action.delay));
      setComment(action.comment || '');
    }
  }, [action]);

  // Suppress hotkeys while open
  useEffect(() => {
    if (actionIndex != null) {
      send({ type: 'ui:modalOpen', payload: {} });
      return () => { send({ type: 'ui:modalClose', payload: {} }); };
    }
  }, [actionIndex, send]);

  const handleSave = useCallback(() => {
    if (actionIndex == null || !action) return;

    // Send edits for changed fields
    if (actionType !== action.actionType) {
      send({ type: 'actions:edit', payload: { index: actionIndex, field: 'actionType', value: actionType } });
    }
    if (key !== action.key) {
      send({ type: 'actions:edit', payload: { index: actionIndex, field: 'key', value: key } });
    }
    const newX = parseInt(x, 10);
    if (!isNaN(newX) && newX !== action.x) {
      send({ type: 'actions:edit', payload: { index: actionIndex, field: 'x', value: String(newX) } });
    }
    const newY = parseInt(y, 10);
    if (!isNaN(newY) && newY !== action.y) {
      send({ type: 'actions:edit', payload: { index: actionIndex, field: 'y', value: String(newY) } });
    }
    const newDelay = parseInt(delay, 10);
    if (!isNaN(newDelay) && newDelay !== action.delay) {
      send({ type: 'actions:edit', payload: { index: actionIndex, field: 'delay', value: String(newDelay) } });
    }
    if (comment !== (action.comment || '')) {
      send({ type: 'actions:edit', payload: { index: actionIndex, field: 'comment', value: comment } });
    }

    onClose();
  }, [actionIndex, action, actionType, key, x, y, delay, comment, send, onClose]);

  // Key capture handler
  const handleKeyCapture = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const modifierKeys = new Set(['Control', 'Alt', 'Shift', 'Meta']);
    if (modifierKeys.has(e.key)) return;

    let mainKey = e.key;
    if (mainKey === ' ') mainKey = 'Space';
    else if (mainKey.length === 1) mainKey = mainKey.toUpperCase();
    else if (mainKey === 'ArrowUp') mainKey = 'Up';
    else if (mainKey === 'ArrowDown') mainKey = 'Down';
    else if (mainKey === 'ArrowLeft') mainKey = 'Left';
    else if (mainKey === 'ArrowRight') mainKey = 'Right';
    else if (mainKey === 'Escape') { onClose(); return; }

    setKey(mainKey);
  }, [onClose]);

  if (actionIndex == null) return null;

  const isKeyAction = actionType === 'KeyDown' || actionType === 'KeyUp';
  const isSendText = actionType === 'SendText';
  const showKey = isKeyAction || isSendText;
  const showCoords = !noCoordTypes.has(actionType);

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[60]"
        style={{ background: 'rgba(0,0,0,0.3)' }}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="fixed right-0 top-0 bottom-0 w-[340px] z-[70] bg-bg-surface border-l border-border-default overflow-y-auto"
        style={{ animation: 'slide-in-right 0.2s ease-out', boxShadow: '0 16px 48px rgba(0,0,0,0.6)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-border-subtle">
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors" title="Close panel">
            <ArrowLeft size={16} />
          </button>
          <div>
            <div className="text-sm font-semibold text-text-primary">Edit Action</div>
            <div className="text-[11px] text-text-tertiary mt-0.5">
              Action #{(actionIndex ?? 0) + 1} — {actionType}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Action Type */}
          <div>
            <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">ACTION TYPE</label>
            <div className="flex flex-wrap gap-1.5">
              {actionTypes.map(t => (
                <button
                  key={t.value}
                  onClick={() => setActionType(t.value)}
                  className={`px-2.5 py-1 rounded text-[11px] font-medium border transition-colors ${
                    actionType === t.value
                      ? 'text-accent border-accent/30 bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
                      : 'text-text-secondary border-border-default bg-bg-elevated hover:bg-bg-card'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Key — only for KeyDown/KeyUp and SendText */}
          {showKey && (
          <div>
            <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">
              {isSendText ? 'TEXT' : 'KEY'}
            </label>
            {isKeyAction ? (
              <input
                type="text"
                readOnly
                value={key}
                onKeyDown={handleKeyCapture}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid cursor-pointer"
                placeholder="Click and press a key..."
              />
            ) : (
              <input
                type="text"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              />
            )}
          </div>
          )}

          {/* X / Y */}
          {showCoords && (
            <div className="flex gap-2.5">
              <div className="flex-1">
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">X</label>
                <input
                  type="number"
                  value={x}
                  onChange={(e) => setX(e.target.value)}
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                  placeholder="—"
                />
              </div>
              <div className="flex-1">
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">Y</label>
                <input
                  type="number"
                  value={y}
                  onChange={(e) => setY(e.target.value)}
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                  placeholder="—"
                />
              </div>
            </div>
          )}

          {/* Delay */}
          <div>
            <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">DELAY (ms)</label>
            <input
              type="number"
              value={delay}
              onChange={(e) => setDelay(e.target.value)}
              className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
            />
          </div>

          {/* Notes */}
          <div>
            <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">NOTES</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="w-full h-16 px-2 py-1.5 text-xs bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid resize-y"
              placeholder="Add a note..."
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border-subtle">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-3.5 py-1.5 rounded text-xs font-medium bg-accent-solid text-white hover:bg-accent-solid/80 transition-colors"
          >
            Save Changes
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}
