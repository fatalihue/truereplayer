import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, RefreshCw } from 'lucide-react';
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
  { value: 'ScrollUp', label: 'ScrollUp \u2191' },
  { value: 'ScrollDown', label: 'ScrollDown \u2193' },
  { value: 'SendText', label: 'Text' },
];

const noCoordTypes = new Set(['KeyDown', 'KeyUp', 'ScrollUp', 'ScrollDown', 'SendText', 'WaitImage', 'BrowserClick', 'BrowserRightClick', 'BrowserType', 'BrowserWaitElement', 'BrowserNavigate']);

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
  const [timeout, setTimeout_] = useState('');
  const [confidence, setConfidence] = useState('');
  const [browserText, setBrowserText] = useState('');
  const [newTab, setNewTab] = useState(false);

  // Sync local state from action
  useEffect(() => {
    if (action) {
      setActionType(action.actionType);
      setKey(action.key);
      setX(String(action.x || ''));
      setY(String(action.y || ''));
      setDelay(String(action.delay));
      setComment(action.comment || '');
      setTimeout_(String((action.timeout || 5000) / 1000));
      setConfidence(String(Math.round((action.confidence || 0.8) * 100)));
      setBrowserText(action.browserText || '');
      setNewTab(action.newTab || false);
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

    // WaitImage-specific fields
    if (actionType === 'WaitImage') {
      const newTimeoutMs = Math.max(1, parseFloat(timeout) || 5) * 1000;
      if (newTimeoutMs !== (action.timeout || 5000)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'timeout', value: String(Math.round(newTimeoutMs)) } });
      }
      const newConfidence = Math.min(100, Math.max(10, parseInt(confidence, 10) || 80)) / 100;
      if (newConfidence !== (action.confidence || 0.8)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'confidence', value: String(newConfidence) } });
      }
    }

    // Browser-specific fields
    if (actionType === 'BrowserType' && browserText !== (action.browserText || '')) {
      send({ type: 'actions:edit', payload: { index: actionIndex, field: 'browserText', value: browserText } });
    }
    if (actionType === 'BrowserWaitElement' || actionType === 'BrowserClick' || actionType === 'BrowserRightClick') {
      const newTimeoutMs = Math.max(1, parseFloat(timeout) || 5) * 1000;
      if (newTimeoutMs !== (action.timeout || 5000)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'timeout', value: String(Math.round(newTimeoutMs)) } });
      }
    }
    if (actionType === 'BrowserNavigate' && newTab !== (action.newTab || false)) {
      send({ type: 'actions:edit', payload: { index: actionIndex, field: 'newTab', value: String(newTab) } });
    }

    onClose();
  }, [actionIndex, action, actionType, key, x, y, delay, comment, timeout, confidence, browserText, newTab, send, onClose]);

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
  const isWaitImage = actionType === 'WaitImage';
  const isBrowser = actionType.startsWith('Browser');
  const isBrowserType = actionType === 'BrowserType';
  const isBrowserNavigate = actionType === 'BrowserNavigate';
  const isBrowserWait = actionType === 'BrowserWaitElement';
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
        className="fixed right-0 top-0 bottom-0 w-[340px] z-[70] bg-bg-surface border-l border-border-default flex flex-col"
        style={{ animation: 'slide-in-right 0.2s ease-out', boxShadow: '0 16px 48px rgba(0,0,0,0.6)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-border-subtle shrink-0">
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors" title="Close panel">
            <ArrowLeft size={16} />
          </button>
          <div>
            <div className="text-sm font-semibold text-text-primary">Edit Action</div>
            <div className="text-[11px] text-text-tertiary mt-0.5">
              Action #{(actionIndex ?? 0) + 1} — {isWaitImage ? 'Wait Image'
                : actionType === 'BrowserClick' ? 'Left Click'
                : actionType === 'BrowserRightClick' ? 'Right Click'
                : actionType === 'BrowserType' ? 'Input Text'
                : actionType === 'BrowserWaitElement' ? 'Wait'
                : actionType === 'BrowserNavigate' ? 'Navigate'
                : actionType}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 flex-1 min-h-0">
          {/* Action Type — hide for WaitImage and Browser */}
          {!isWaitImage && !isBrowser && (
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
          )}

          {/* WaitImage Settings */}
          {isWaitImage && (
          <>
            {/* Thumbnail */}
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">REFERENCE IMAGE</label>
              <div className="rounded border border-border-default bg-bg-elevated overflow-hidden">
                {action?.imageBase64 ? (
                  <img
                    src={`data:image/png;base64,${action.imageBase64}`}
                    alt="Reference"
                    className="w-full max-h-[140px] object-contain bg-black/20"
                  />
                ) : (
                  <div className="flex items-center justify-center h-[80px] text-xs text-text-disabled">
                    No image captured
                  </div>
                )}
              </div>
              <button
                onClick={() => {
                  send({ type: 'waitimage:recapture', payload: { index: actionIndex } });
                  onClose();
                }}
                className="mt-2 w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium border border-border-default bg-bg-elevated hover:bg-bg-card text-text-secondary hover:text-text-primary transition-colors"
                title="Recapture reference image"
              >
                <RefreshCw size={12} />
                Recapture
              </button>
            </div>

            {/* Timeout / Confidence */}
            <div className="flex gap-2.5">
              <div className="flex-1">
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TIMEOUT (s)</label>
                <input
                  type="number"
                  value={timeout}
                  onChange={(e) => setTimeout_(e.target.value)}
                  min="1"
                  step="1"
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                />
              </div>
              <div className="flex-1">
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TOLERANCE (%)</label>
                <input
                  type="number"
                  value={confidence}
                  onChange={(e) => setConfidence(e.target.value)}
                  min="10"
                  max="100"
                  step="5"
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                />
              </div>
            </div>
          </>
          )}

          {/* Browser Action Settings */}
          {isBrowser && (
          <>
            {/* Selector / URL */}
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">
                {isBrowserNavigate ? 'URL' : 'CSS SELECTOR'}
              </label>
              <input
                type="text"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                placeholder={isBrowserNavigate ? 'https://example.com' : '#element-id, .class, [name="field"]'}
              />
            </div>

            {/* New Tab — only for BrowserNavigate */}
            {isBrowserNavigate && (
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={newTab}
                onChange={(e) => setNewTab(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-border-default accent-accent-solid cursor-pointer"
              />
              <span className="text-xs text-text-secondary">Open in new tab</span>
            </label>
            )}

            {/* Text — only for BrowserType */}
            {isBrowserType && (
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TEXT TO TYPE</label>
              <input
                type="text"
                value={browserText}
                onChange={(e) => setBrowserText(e.target.value)}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                placeholder="Text to type into the element"
              />
            </div>
            )}

            {/* Timeout — for BrowserClick and BrowserWaitElement */}
            {(isBrowserWait || actionType === 'BrowserClick' || actionType === 'BrowserRightClick') && (
            <div className="w-1/2">
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TIMEOUT (s)</label>
              <input
                type="number"
                value={timeout}
                onChange={(e) => setTimeout_(e.target.value)}
                min="1"
                step="1"
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              />
            </div>
            )}
          </>
          )}

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
                  placeholder="\u2014"
                />
              </div>
              <div className="flex-1">
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">Y</label>
                <input
                  type="number"
                  value={y}
                  onChange={(e) => setY(e.target.value)}
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                  placeholder="\u2014"
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
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border-subtle shrink-0">
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
