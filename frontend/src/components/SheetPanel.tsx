import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, RefreshCw, Crosshair, ShieldCheck, ShieldAlert, ShieldQuestion, PlayCircle, Check, X } from 'lucide-react';
import { useBridge } from '../bridge/BridgeContext';
import { useAppState } from '../state/AppStateContext';
import type { SelectorAlternative, BrowserTestResult } from '../bridge/messageTypes';
import { Checkbox } from './Checkbox';

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

const noCoordTypes = new Set(['KeyDown', 'KeyUp', 'ScrollUp', 'ScrollDown', 'SendText', 'WaitImage', 'BrowserClick', 'BrowserRightClick', 'BrowserType', 'BrowserWaitElement', 'BrowserNavigate']);

// #1 — Text matching modes mapped to selector prefixes
type TextMode = 'exact' | 'contains' | 'icontains' | 'regex';
const TEXT_MODES: { value: TextMode; label: string; prefix: string }[] = [
  { value: 'exact',     label: 'Exact',         prefix: 'text=' },
  { value: 'contains',  label: 'Contains',      prefix: 'text*=' },
  { value: 'icontains', label: 'Contains (i)',  prefix: 'text~=' },
  { value: 'regex',     label: 'Regex',         prefix: 'text/' },
];

function parseTextSelector(value: string): { mode: TextMode | null; raw: string } {
  if (!value) return { mode: null, raw: '' };
  if (value.startsWith('text/')) {
    // Strip leading text/ and the regex closing /flags so the input shows just the pattern
    const last = value.lastIndexOf('/');
    if (last > 4) return { mode: 'regex', raw: value.slice(5, last) };
  }
  if (value.startsWith('text*=')) return { mode: 'contains', raw: value.slice(6) };
  if (value.startsWith('text~=')) return { mode: 'icontains', raw: value.slice(6) };
  if (value.startsWith('text=')) return { mode: 'exact', raw: value.slice(5) };
  return { mode: null, raw: '' };
}

function buildTextSelector(mode: TextMode, raw: string): string {
  if (!raw) return '';
  if (mode === 'regex') return `text/${raw}/i`;
  const prefix = TEXT_MODES.find(m => m.value === mode)?.prefix ?? 'text=';
  return prefix + raw;
}

// #2 — Estimate selector tier client-side (mirrors selectorGenerator.estimateSelectorTier)
function estimateTier(selector: string): 'S' | 'A' | 'B' | 'C' {
  if (!selector) return 'C';
  const s = selector.trim();
  if (s.startsWith('text=') || s.startsWith('text*=') || s.startsWith('text~=') || s.startsWith('text/')) return 'B';
  if (/^#[A-Za-z_][\w\-]*$/.test(s)) return 'S';
  if (/\[data-(testid|test|cy|qa)=/.test(s)) return 'S';
  if (/\[(name|aria-label|placeholder)=/.test(s)) return 'A';
  if (s.includes(':nth-') || s.includes(' > ')) return 'C';
  if (/^[a-z]+\./i.test(s)) return 'B';
  return 'C';
}

const TIER_META: Record<'S' | 'A' | 'B' | 'C', { color: string; label: string; Icon: typeof ShieldCheck }> = {
  S: { color: '#0E7A0D', label: 'Stable',    Icon: ShieldCheck },
  A: { color: '#60CDFF', label: 'Strong',    Icon: ShieldCheck },
  B: { color: '#FFC107', label: 'Decent',    Icon: ShieldQuestion },
  C: { color: '#C42B1C', label: 'Fragile',   Icon: ShieldAlert },
};


export function SheetPanel({ actionIndex, onClose }: SheetPanelProps) {
  const { actions } = useAppState();
  const { send, subscribe } = useBridge();

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
  const [textMatch, setTextMatch] = useState('');
  const [textMode, setTextMode] = useState<TextMode>('exact');
  const [newTab, setNewTab] = useState(false);
  const [isPicking, setIsPicking] = useState(false);

  // #6, #7, #5 — new browser fields
  const [waitMode, setWaitMode] = useState<string>('appears');
  const [urlWaitPattern, setUrlWaitPattern] = useState('');
  const [postNavigateSelector, setPostNavigateSelector] = useState('');
  const [typeAppend, setTypeAppend] = useState(false);
  const [typePaste, setTypePaste] = useState(false);
  const [typeDelay, setTypeDelay] = useState('');

  // #2 — picker alternatives popover
  const [alternatives, setAlternatives] = useState<SelectorAlternative[]>([]);
  const [showAlternatives, setShowAlternatives] = useState(false);

  // #3 — test action state
  const [testRequestId, setTestRequestId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<BrowserTestResult | null>(null);

  // Listen for pick element result + test result from extension
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'browser:pickResult') {
        setIsPicking(false);
        const payload = msg.payload as { selector?: string | null; alternatives?: SelectorAlternative[] };
        if (payload.selector) {
          setKey(payload.selector);
          // #2 — Show alternatives popover when there are 2+ candidates
          const alts = payload.alternatives || [];
          if (alts.length > 1) {
            setAlternatives(alts);
            setShowAlternatives(true);
          } else {
            setAlternatives([]);
            setShowAlternatives(false);
          }
        }
      } else if (msg.type === 'browser:testResult') {
        const r = msg.payload as BrowserTestResult;
        // Only react if it's the test we triggered
        if (testRequestId && r.requestId === testRequestId) {
          setTestResult(r);
          setTestRequestId(null);
        }
      }
    });
  }, [subscribe, testRequestId]);

  // Sync local state from action
  useEffect(() => {
    if (action) {
      setActionType(action.actionType);
      // #1 — Detect any text= prefix variant and split into mode + raw value
      const parsed = parseTextSelector(action.key || '');
      if (parsed.mode) {
        setKey('');
        setTextMatch(parsed.raw);
        setTextMode(parsed.mode);
      } else {
        setKey(action.key);
        setTextMatch('');
        setTextMode('exact');
      }
      setX(String(action.x || ''));
      setY(String(action.y || ''));
      setDelay(String(action.delay));
      setComment(action.comment || '');
      setTimeout_(String((action.timeout || 5000) / 1000));
      setConfidence(String(Math.round((action.confidence || 0.8) * 100)));
      setBrowserText(action.browserText || '');
      setNewTab(action.newTab || false);
      setWaitMode(action.waitMode || 'appears');
      setUrlWaitPattern(action.urlWaitPattern || '');
      setPostNavigateSelector(action.postNavigateSelector || '');
      setTypeAppend(action.typeAppend || false);
      setTypePaste(action.typePaste || false);
      setTypeDelay(action.typeDelay != null ? String(action.typeDelay) : '');
      setAlternatives([]);
      setShowAlternatives(false);
      setTestResult(null);
    }
  }, [action]);


  const handleSave = useCallback(() => {
    if (actionIndex == null || !action) return;

    if (actionType !== action.actionType) {
      send({ type: 'actions:edit', payload: { index: actionIndex, field: 'actionType', value: actionType } });
    }
    // #1 — Build effective key from textMatch + mode if textMatch is set, else use raw selector
    const effectiveKey = textMatch.trim() ? buildTextSelector(textMode, textMatch.trim()) : key;
    if (effectiveKey !== action.key) {
      send({ type: 'actions:edit', payload: { index: actionIndex, field: 'key', value: effectiveKey } });
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

    // #6 — WaitElement mode
    if (actionType === 'BrowserWaitElement') {
      const persistedMode = (waitMode === 'appears') ? '' : waitMode; // empty = default
      if ((persistedMode || '') !== (action.waitMode || '')) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'waitMode', value: persistedMode } });
      }
    }

    // #7 — Navigate post-checks
    if (actionType === 'BrowserNavigate') {
      if ((urlWaitPattern || '') !== (action.urlWaitPattern || '')) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'urlWaitPattern', value: urlWaitPattern } });
      }
      if ((postNavigateSelector || '') !== (action.postNavigateSelector || '')) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'postNavigateSelector', value: postNavigateSelector } });
      }
    }

    // #5 — Type options
    if (actionType === 'BrowserType') {
      if (!!typeAppend !== !!(action.typeAppend)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'typeAppend', value: String(typeAppend) } });
      }
      if (!!typePaste !== !!(action.typePaste)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'typePaste', value: String(typePaste) } });
      }
      const tdParsed = typeDelay.trim() === '' ? null : parseInt(typeDelay, 10);
      const currentTd = action.typeDelay ?? null;
      const normalized = (tdParsed != null && !isNaN(tdParsed)) ? tdParsed : null;
      if (normalized !== currentTd) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'typeDelay', value: normalized != null ? String(normalized) : '' } });
      }
    }

    onClose();
  }, [actionIndex, action, actionType, key, textMatch, textMode, x, y, delay, comment, timeout, confidence, browserText, newTab, waitMode, urlWaitPattern, postNavigateSelector, typeAppend, typePaste, typeDelay, send, onClose]);

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

  // #1 — Validate regex pattern when in regex mode
  const regexError = useMemo(() => {
    if (textMode !== 'regex' || !textMatch.trim()) return null;
    try { new RegExp(textMatch); return null; }
    catch (e) { return (e as Error).message; }
  }, [textMode, textMatch]);

  // #3 — Run the current action against the live page
  const handleTestAction = useCallback(() => {
    if (actionIndex == null || !action) return;
    const requestId = Math.random().toString(36).slice(2, 10);
    setTestRequestId(requestId);
    setTestResult(null);
    const effectiveKey = textMatch.trim() ? buildTextSelector(textMode, textMatch.trim()) : key;
    const timeoutMs = Math.max(1, parseFloat(timeout) || 5) * 1000;
    const tdParsed = typeDelay.trim() === '' ? null : parseInt(typeDelay, 10);
    send({
      type: 'browser:testAction',
      payload: {
        requestId,
        actionType,
        key: effectiveKey,
        browserText,
        newTab,
        timeout: Math.round(timeoutMs),
        waitMode: waitMode === 'appears' ? null : waitMode,
        urlWaitPattern: urlWaitPattern || null,
        postNavigateSelector: postNavigateSelector || null,
        typeAppend,
        typePaste,
        typeDelay: tdParsed != null && !isNaN(tdParsed) ? tdParsed : null,
      },
    });
  }, [actionIndex, action, actionType, key, textMatch, textMode, timeout, browserText, newTab, waitMode, urlWaitPattern, postNavigateSelector, typeAppend, typePaste, typeDelay, send]);

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

  // #2 — Tier shield for current selector (priority: textMatch > key)
  const selectorForTier = textMatch.trim() ? buildTextSelector(textMode, textMatch.trim()) : key;
  const tier = estimateTier(selectorForTier);
  const tierMeta = TIER_META[tier];

  return createPortal(
    <>
      {/* Backdrop — no click-to-close, user must Save/Cancel/arrow */}
      <div
        className="fixed inset-0 z-[60]"
        style={{ background: 'rgba(0,0,0,0.3)' }}
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
        <div className="p-4 space-y-4 flex-1 min-h-0 overflow-y-auto">
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
              <label className="flex items-center gap-1.5 text-[11px] font-semibold text-text-tertiary mb-1.5">
                {isBrowserNavigate ? 'URL' : 'CSS SELECTOR'}
                {/* #2 — Tier shield indicator (only for non-Navigate selectors) */}
                {!isBrowserNavigate && selectorForTier && (
                  <span title={`${tierMeta.label} selector`} style={{ color: tierMeta.color, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <tierMeta.Icon size={12} />
                    <span style={{ fontSize: 9, fontWeight: 600 }}>{tier}</span>
                  </span>
                )}
              </label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  className="flex-1 h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                  placeholder={isBrowserNavigate ? 'https://example.com' : '.btn-save'}
                />
                {!isBrowserNavigate && (
                  <button
                    onClick={() => {
                      setIsPicking(true);
                      setShowAlternatives(false);
                      send({ type: 'browser:pickElement', payload: {} });
                    }}
                    disabled={isPicking}
                    className={`h-8 w-8 flex items-center justify-center rounded border transition-colors ${
                      isPicking
                        ? 'bg-accent-solid/20 border-accent-solid text-accent-light'
                        : 'bg-bg-input border-border-default text-text-tertiary hover:text-text-primary hover:border-text-tertiary'
                    }`}
                    title="Pick element from page"
                  >
                    <Crosshair size={14} />
                  </button>
                )}
              </div>

              {/* #2 — Alternatives popover (after pick) */}
              {showAlternatives && alternatives.length > 0 && (
                <div className="mt-1.5 rounded border border-border-default bg-bg-elevated p-1.5 space-y-1">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] font-semibold text-text-tertiary">ALTERNATIVES</span>
                    <button
                      onClick={() => setShowAlternatives(false)}
                      className="text-[10px] text-text-tertiary hover:text-text-primary"
                      title="Dismiss alternatives"
                    >
                      ×
                    </button>
                  </div>
                  {alternatives.map((alt, i) => {
                    const m = TIER_META[alt.tier] || TIER_META.C;
                    return (
                      <button
                        key={i}
                        onClick={() => { setKey(alt.selector); setShowAlternatives(false); }}
                        className="w-full text-left px-2 py-1 rounded text-[11px] hover:bg-bg-card transition-colors flex items-center gap-1.5"
                        title={alt.description}
                      >
                        <span style={{ color: m.color, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <m.Icon size={10} />
                          <span style={{ fontSize: 9, fontWeight: 700 }}>{alt.tier}</span>
                        </span>
                        <span className="font-mono text-text-secondary truncate">{alt.selector}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* #1 — Text Match — alternative to CSS selector for Click/RightClick/Wait */}
            {!isBrowserNavigate && !isBrowserType && (
            <div>
              <label
                className="block text-[11px] font-semibold text-text-tertiary mb-1.5"
                title="Takes priority over CSS selector when filled"
              >
                TEXT MATCH
              </label>
              <div className="flex gap-1.5">
                <select
                  value={textMode}
                  onChange={(e) => setTextMode(e.target.value as TextMode)}
                  className="h-8 px-1.5 text-[11px] bg-bg-input border border-border-default rounded text-text-secondary outline-none focus:border-accent-solid"
                  title="Match mode"
                >
                  {TEXT_MODES.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={textMatch}
                  onChange={(e) => setTextMatch(e.target.value)}
                  className="flex-1 h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                  placeholder={textMode === 'regex' ? '^Salvar.*' : 'Save Changes'}
                />
              </div>
              {regexError && (
                <p className="text-[10px] text-red-400 mt-1 font-mono">Invalid regex: {regexError}</p>
              )}
            </div>
            )}

            {/* New Tab — only for BrowserNavigate */}
            {isBrowserNavigate && (
              <Checkbox
                checked={newTab}
                onChange={setNewTab}
                label="Open in new tab"
              />
            )}

            {/* #7 — Navigate post-checks */}
            {isBrowserNavigate && (
            <>
              <div>
                <label
                  className="block text-[11px] font-semibold text-text-tertiary mb-1.5"
                  title="Optional. Wait until URL matches glob (*) or /regex/. Useful for redirects."
                >
                  URL PATTERN
                </label>
                <input
                  type="text"
                  value={urlWaitPattern}
                  onChange={(e) => setUrlWaitPattern(e.target.value)}
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                  placeholder="*/dashboard*"
                />
              </div>
              <div>
                <label
                  className="block text-[11px] font-semibold text-text-tertiary mb-1.5"
                  title="Optional. Wait for element to appear after page load."
                >
                  WAIT ELEMENT
                </label>
                <input
                  type="text"
                  value={postNavigateSelector}
                  onChange={(e) => setPostNavigateSelector(e.target.value)}
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                  placeholder="#app-ready"
                />
              </div>
            </>
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
                placeholder="Hello{enter}"
              />
              {/* Data placeholders — replaced with values before typing */}
              <div className="flex flex-wrap gap-1 mt-2">
                {[
                  { var: '{clipboard}', label: 'Clipboard' },
                  { var: '{date}', label: 'Date' },
                  { var: '{time}', label: 'Time' },
                  { var: '{datetime}', label: 'DateTime' },
                ].map(item => (
                  <button
                    key={item.var}
                    type="button"
                    onClick={() => setBrowserText(prev => prev + item.var)}
                    className="px-2 py-0.5 text-[11px] font-mono bg-bg-surface border border-border-subtle rounded text-text-secondary hover:text-accent-light hover:border-accent-solid/30 transition-colors"
                    title={`Inserts the ${item.label.toLowerCase()} value at this position`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {/* Action keys — dispatched as keydown/keyup at this position. After {tab},
                  subsequent text goes into the new focused element. */}
              <div className="flex flex-wrap gap-1 mt-1">
                {[
                  { var: '{enter}', label: 'Enter' },
                  { var: '{tab}', label: 'Tab' },
                  { var: '{esc}', label: 'Esc' },
                  { var: '{backspace}', label: '⌫' },
                  { var: '{up}', label: '↑' },
                  { var: '{down}', label: '↓' },
                ].map(item => (
                  <button
                    key={item.var}
                    type="button"
                    onClick={() => setBrowserText(prev => prev + item.var)}
                    className="px-2 py-0.5 text-[11px] font-mono bg-bg-surface border border-border-subtle rounded text-text-secondary hover:text-[#FFC107] hover:border-[#FFC107]/40 transition-colors"
                    title={`Press ${item.label} key at this position. After Tab, focus moves and remaining text goes there.`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            )}

            {/* #5 — Type options */}
            {isBrowserType && (
            <div className="space-y-1.5">
              <Checkbox
                checked={typeAppend}
                onChange={setTypeAppend}
                label="Append"
                title="Append text to existing field value instead of replacing it"
              />
              <Checkbox
                checked={typePaste}
                onChange={setTypePaste}
                label="Paste"
                title="Use clipboard paste (instant) instead of typing char-by-char"
              />
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-text-tertiary" title="Delay between characters in ms (typing only). 0 = instant, blank = auto.">Char delay (ms)</label>
                <input
                  type="number"
                  value={typeDelay}
                  onChange={(e) => setTypeDelay(e.target.value)}
                  min="0"
                  step="1"
                  disabled={typePaste}
                  placeholder="auto"
                  className="w-20 h-7 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid disabled:opacity-50"
                />
              </div>
            </div>
            )}

            {/* #6 — WaitElement mode */}
            {isBrowserWait && (
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">WAIT CONDITION</label>
              <select
                value={waitMode}
                onChange={(e) => setWaitMode(e.target.value)}
                className="w-full h-8 px-2 text-ui bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              >
                <option value="appears">Appears (default)</option>
                <option value="disappears">Disappears</option>
                <option value="enabled">Enabled</option>
                <option value="text-match">Text matches (uses Text Match field)</option>
              </select>
            </div>
            )}

            {/* Timeout — for BrowserClick / RightClick / Wait / Navigate */}
            {(isBrowserWait || actionType === 'BrowserClick' || actionType === 'BrowserRightClick' || isBrowserNavigate) && (
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

            {/* #3 — Test action */}
            <div className="pt-1">
              <button
                onClick={handleTestAction}
                disabled={testRequestId !== null}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium border border-accent-solid/40 bg-accent-solid/10 hover:bg-accent-solid/20 text-accent-light transition-colors disabled:opacity-60"
                title="Run this action live to verify the selector / settings"
              >
                <PlayCircle size={13} />
                {testRequestId ? 'Running…' : 'Test action'}
              </button>
              {testResult && (
                <div className={`mt-1.5 px-2 py-1.5 rounded text-[11px] ${
                  testResult.success
                    ? 'bg-[rgba(14,122,13,0.12)] border border-[rgba(14,122,13,0.4)] text-[#5edc5e]'
                    : 'bg-[rgba(196,43,28,0.12)] border border-[rgba(196,43,28,0.4)] text-[#ff8a80]'
                }`}>
                  <div className="flex items-center gap-1.5">
                    {testResult.success ? <Check size={11} /> : <X size={11} />}
                    <span className="font-medium">
                      {testResult.success
                        ? `Success in ${testResult.durationMs}ms`
                        : (testResult.error?.code || 'Failed')}
                    </span>
                  </div>
                  {!testResult.success && testResult.error && (
                    <>
                      <div className="mt-0.5 text-text-secondary">{testResult.error.message}</div>
                      {testResult.error.tip && (
                        <div className="mt-0.5 text-text-tertiary italic">{testResult.error.tip}</div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
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
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border-subtle shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!!regexError}
            className="px-3.5 py-1.5 rounded text-xs font-medium bg-accent-solid text-white hover:bg-accent-solid/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Save Changes
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}
