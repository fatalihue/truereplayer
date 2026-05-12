import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, RefreshCw, Crosshair, Copy, ClipboardPaste, ShieldCheck, ShieldAlert, ShieldQuestion, PlayCircle, Check, X } from 'lucide-react';
import { useBridge } from '../bridge/BridgeContext';
import { useAppState } from '../state/AppStateContext';
import type { SelectorAlternative, BrowserTestResult } from '../bridge/messageTypes';
import { Checkbox } from './Checkbox';
import { ImageCropper } from './ImageCropper';
import { getDisplayKey } from '../utils/displayUtils';

interface SheetPanelProps {
  actionIndex: number | null;
  onClose: () => void;
}

// Action types organised by FAMILY — the picker only offers conversions that stay within
// a family because cross-family transforms produce semantically broken actions (e.g. a
// Click→KeyDown swap loses the X/Y context and leaves an empty key field). Users who really
// want a different action type record a new one. Within a family, the swaps are meaningful:
// Left Click ↔ Right Click ↔ Mid Click (same coord, different button), KeyDown ↔ KeyUp
// (same key, different phase), ScrollUp ↔ ScrollDown (toggle direction).
type ActionFamily = 'click' | 'key' | 'scroll' | 'text';
const familyTypes: Record<ActionFamily, { value: string; label: string }[]> = {
  click: [
    { value: 'LeftClick', label: 'Left Click' },
    { value: 'RightClick', label: 'Right Click' },
    { value: 'MiddleClick', label: 'Mid Click' },
  ],
  key: [
    { value: 'KeyDown', label: 'KeyDown' },
    { value: 'KeyUp', label: 'KeyUp' },
  ],
  scroll: [
    { value: 'ScrollUp', label: 'ScrollUp ↑' },
    { value: 'ScrollDown', label: 'ScrollDown ↓' },
  ],
  text: [
    { value: 'SendText', label: 'Text' },
  ],
};

const noCoordTypes = new Set(['KeyDown', 'KeyUp', 'ScrollUp', 'ScrollDown', 'SendText', 'WaitImage', 'BrowserClick', 'BrowserRightClick', 'BrowserType', 'BrowserWaitElement', 'BrowserNavigate', 'Pause']);

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
  if (/^#[A-Za-z_][\w-]*$/.test(s)) return 'S';
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

  // WaitImage extras (timeout branching, disappear toggle, click-on-match, ROI).
  // Stored locally during edit; persisted via actions:edit on Save. Default "StopReplay"
  // matches the dropdown's default option — a clean stop without a noisy error popup.
  const [waitImageOnTimeout, setWaitImageOnTimeout] = useState<string>('StopReplay'); // 'Continue' | 'StopReplay'
  const [waitImageInvert, setWaitImageInvert] = useState(false);
  const [waitImageClickOnMatch, setWaitImageClickOnMatch] = useState(false);
  const [waitImageSearchRegion, setWaitImageSearchRegion] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Test match button — fires a single MatchOnce on the live screen and shows the score.
  // Result is transient (cleared on close/save/recapture); no persistence.
  const [testMatchRequestId, setTestMatchRequestId] = useState<string | null>(null);
  const [testMatchResult, setTestMatchResult] = useState<{ found: boolean; score: number; x: number; y: number; w: number; h: number; error?: string } | null>(null);

  // Crop reference image modal — opens on thumbnail click; commit replaces the action's
  // ImagePath with a tighter cropped PNG via the bridge.
  const [cropperOpen, setCropperOpen] = useState(false);

  // Pick position — when active, the next 'mouse:positionPicked' message updates X/Y.
  const [pickPositionRequestId, setPickPositionRequestId] = useState<string | null>(null);

  // Pause action's Resume Hotkey capture state — same UX as KeyDown/KeyUp's keyFieldFocused
  // and the Settings / Profile / grid inputs: focus → empty + "New key..." + accent pulse.
  const [pauseHotkeyFocused, setPauseHotkeyFocused] = useState(false);
  const testMatchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTestMatchTimeout = useCallback(() => {
    if (testMatchTimeoutRef.current) {
      clearTimeout(testMatchTimeoutRef.current);
      testMatchTimeoutRef.current = null;
    }
  }, []);
  useEffect(() => () => clearTestMatchTimeout(), [clearTestMatchTimeout]);

  // #2 — picker alternatives popover
  const [alternatives, setAlternatives] = useState<SelectorAlternative[]>([]);
  const [showAlternatives, setShowAlternatives] = useState(false);

  // #3 — test action state
  const [testRequestId, setTestRequestId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<BrowserTestResult | null>(null);
  // Safety timeout — if the bridge response is lost, recover the UI instead of hanging "Running…".
  // Backend pipeTimeout is the action timeout (~5s default); we double it plus 5s overhead.
  const testTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTestTimeout = useCallback(() => {
    if (testTimeoutRef.current) {
      clearTimeout(testTimeoutRef.current);
      testTimeoutRef.current = null;
    }
  }, []);
  useEffect(() => () => clearTestTimeout(), [clearTestTimeout]);

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
          clearTestTimeout();
          setTestResult(r);
          setTestRequestId(null);
        }
      } else if (msg.type === 'image:testMatchResult') {
        const r = msg.payload as { requestId: string; found: boolean; score: number; x: number; y: number; w: number; h: number; error?: string };
        if (testMatchRequestId && r.requestId === testMatchRequestId) {
          clearTestMatchTimeout();
          setTestMatchResult({ found: r.found, score: r.score, x: r.x, y: r.y, w: r.w, h: r.h, error: r.error });
          setTestMatchRequestId(null);
        }
      } else if (msg.type === 'waitimage:searchRegionSet') {
        const r = msg.payload as { requestId: string; cancelled: boolean; x?: number; y?: number; w?: number; h?: number };
        // We only ever have one configure-region session at a time per panel instance;
        // accepting any non-cancelled result is safe.
        if (!r.cancelled && r.w && r.h && r.w > 0 && r.h > 0) {
          setWaitImageSearchRegion({ x: r.x ?? 0, y: r.y ?? 0, w: r.w, h: r.h });
        }
      } else if (msg.type === 'mouse:positionPicked') {
        const r = msg.payload as { requestId: string; cancelled: boolean; x?: number; y?: number };
        if (pickPositionRequestId && r.requestId === pickPositionRequestId) {
          if (!r.cancelled && r.x != null && r.y != null) {
            setX(String(r.x));
            setY(String(r.y));
          }
          setPickPositionRequestId(null);
        }
      }
    });
  }, [subscribe, testRequestId, clearTestTimeout, testMatchRequestId, clearTestMatchTimeout, pickPositionRequestId]);

  // Sync local state from action. This is intentionally an effect-driven seed: keeping
  // local state lets the user edit freely before saving, while the dependency on `action`
  // means external changes (undo/redo, sibling-action updates) still flow into the panel
  // even when it stays open. A key-based remount would lose that liveness.
  /* eslint-disable react-hooks/set-state-in-effect */
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
      // Pause defaults timeout to 0 (infinite); other actions default to 5000ms.
      setTimeout_(action.actionType === 'Pause'
        ? String((action.timeout ?? 0) / 1000)
        : String((action.timeout || 5000) / 1000));
      setConfidence(String(Math.round((action.confidence || 0.8) * 100)));
      setBrowserText(action.browserText || '');
      setNewTab(action.newTab || false);
      setWaitMode(action.waitMode || 'appears');
      setUrlWaitPattern(action.urlWaitPattern || '');
      setPostNavigateSelector(action.postNavigateSelector || '');
      setTypeAppend(action.typeAppend || false);
      setTypePaste(action.typePaste || false);
      setTypeDelay(action.typeDelay != null ? String(action.typeDelay) : '');
      // Default "StopReplay" handles null / empty / legacy values gracefully.
      setWaitImageOnTimeout(action.waitImageOnTimeout === 'Continue' ? 'Continue' : 'StopReplay');
      setWaitImageInvert(action.waitImageInvert || false);
      setWaitImageClickOnMatch(action.waitImageClickOnMatch || false);
      if (action.waitImageSearchW != null && action.waitImageSearchH != null
          && action.waitImageSearchW > 0 && action.waitImageSearchH > 0) {
        setWaitImageSearchRegion({
          x: action.waitImageSearchX || 0,
          y: action.waitImageSearchY || 0,
          w: action.waitImageSearchW,
          h: action.waitImageSearchH,
        });
      } else {
        setWaitImageSearchRegion(null);
      }
      setAlternatives([]);
      setShowAlternatives(false);
      setTestResult(null);
      setTestMatchResult(null);
      setTestMatchRequestId(null);
    }
  }, [action]);
  /* eslint-enable react-hooks/set-state-in-effect */


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
      // Only "Continue" is persisted explicitly; "StopReplay" is the default and stays null
      // on disk to keep saved JSON minimal.
      const persistedTimeoutMode = waitImageOnTimeout === 'Continue' ? 'Continue' : '';
      const currentTimeoutMode = action.waitImageOnTimeout === 'Continue' ? 'Continue' : '';
      if (persistedTimeoutMode !== currentTimeoutMode) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'waitImageOnTimeout', value: persistedTimeoutMode } });
      }
      if (!!waitImageInvert !== !!(action.waitImageInvert)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'waitImageInvert', value: String(waitImageInvert) } });
      }
      if (!!waitImageClickOnMatch !== !!(action.waitImageClickOnMatch)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'waitImageClickOnMatch', value: String(waitImageClickOnMatch) } });
      }
      // Search region — serialised as "x,y,w,h" or empty string. Compare against the action's
      // current rect to avoid no-op edits (which would still bump the undo stack).
      const currentRect = (action.waitImageSearchW && action.waitImageSearchH)
        ? `${action.waitImageSearchX || 0},${action.waitImageSearchY || 0},${action.waitImageSearchW},${action.waitImageSearchH}`
        : '';
      const newRect = waitImageSearchRegion
        ? `${waitImageSearchRegion.x},${waitImageSearchRegion.y},${waitImageSearchRegion.w},${waitImageSearchRegion.h}`
        : '';
      if (newRect !== currentRect) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'waitImageSearchRegion', value: newRect } });
      }
    }

    // Pause-specific fields: timeout in seconds. Hotkey shares the `key` field with other action
    // types (already saved above by the generic key-equality check). Default seconds=0 = infinite.
    if (actionType === 'Pause') {
      const parsedSecs = parseFloat(timeout);
      const newTimeoutMs = isNaN(parsedSecs) || parsedSecs < 0 ? 0 : Math.round(parsedSecs * 1000);
      if (newTimeoutMs !== (action.timeout || 0)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'timeout', value: String(newTimeoutMs) } });
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
  }, [actionIndex, action, actionType, key, textMatch, textMode, x, y, delay, comment, timeout, confidence, browserText, newTab, waitMode, urlWaitPattern, postNavigateSelector, typeAppend, typePaste, typeDelay, waitImageOnTimeout, waitImageInvert, waitImageClickOnMatch, waitImageSearchRegion, send, onClose]);

  // Key capture handler — mirrors SettingsPanel.HotkeyInput's focus-driven flow: focusing
  // the field switches it to capture mode (showing "..."), the next non-modifier key is
  // stored, and the input auto-blurs so the user sees the resolved value immediately.
  const [keyFieldFocused, setKeyFieldFocused] = useState(false);
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
    // Drop focus so the user sees the captured value rendered (instead of "..." still).
    // Matches SettingsPanel.HotkeyInput behaviour.
    (e.target as HTMLInputElement).blur();
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

    // Safety timeout — recover the UI if the bridge never responds (extension crash, pipe drop).
    // Wait the full backend timeout plus 5 s overhead before giving up.
    clearTestTimeout();
    testTimeoutRef.current = setTimeout(() => {
      testTimeoutRef.current = null;
      setTestRequestId(prev => {
        if (prev !== requestId) return prev;
        setTestResult({
          requestId,
          success: false,
          error: {
            code: 'NO_RESPONSE',
            message: 'No response from the browser extension.',
            tip: 'Check that Chrome and the TrueReplayer extension are still running.',
          },
        });
        return null;
      });
    }, timeoutMs + 5000);

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
  }, [actionIndex, action, actionType, key, textMatch, textMode, timeout, browserText, newTab, waitMode, urlWaitPattern, postNavigateSelector, typeAppend, typePaste, typeDelay, send, clearTestTimeout]);

  // WaitImage: capture screen now and report best confidence + matched rect against the reference
  // image. Doesn't run the replay — pure calibration helper.
  const handleTestMatch = useCallback(() => {
    if (!action || !action.imagePath) return;
    const requestId = Math.random().toString(36).slice(2, 10);
    setTestMatchRequestId(requestId);
    setTestMatchResult(null);
    const conf = Math.min(100, Math.max(10, parseInt(confidence, 10) || 80)) / 100;
    clearTestMatchTimeout();
    testMatchTimeoutRef.current = setTimeout(() => {
      testMatchTimeoutRef.current = null;
      setTestMatchRequestId(prev => {
        if (prev !== requestId) return prev;
        setTestMatchResult({ found: false, score: 0, x: 0, y: 0, w: 0, h: 0, error: 'No response from backend.' });
        return null;
      });
    }, 8000);
    send({
      type: 'image:testMatch',
      payload: {
        requestId,
        imagePath: action.imagePath,
        confidence: conf,
        searchRegion: waitImageSearchRegion ?? undefined,
      },
    });
  }, [action, confidence, waitImageSearchRegion, send, clearTestMatchTimeout]);

  // WaitImage: launch the screen overlay in region-only mode so the user can draw an ROI.
  // Result arrives via the 'waitimage:searchRegionSet' message handled above.
  const handleConfigureSearchRegion = useCallback(() => {
    const requestId = Math.random().toString(36).slice(2, 10);
    send({ type: 'waitimage:configureSearchRegion', payload: { requestId } });
  }, [send]);

  // Crop save: send the rect (image-pixel coords) to the backend, which clones the existing
  // PNG and updates action.ImagePath. The new imageBase64 arrives via the next actions:updated
  // push so the thumbnail refreshes automatically.
  const handleCropSave = useCallback((rect: { x: number; y: number; w: number; h: number }) => {
    if (actionIndex == null) return;
    send({ type: 'waitimage:cropReference', payload: { index: actionIndex, ...rect } });
    setCropperOpen(false);
  }, [actionIndex, send]);

  // Pick position: minimise the app, show the screen-overlay in pointPick mode, the next
  // click anywhere on screen fills X/Y. Much faster than typing or re-recording the action
  // just to nudge a coord.
  const handlePickPosition = useCallback(() => {
    const requestId = Math.random().toString(36).slice(2, 10);
    setPickPositionRequestId(requestId);
    send({ type: 'mouse:pickPosition', payload: { requestId } });
  }, [send]);

  // Copy/Paste X,Y — supports the common workflow of picking a position on one click half
  // (e.g. LeftClickDown) and reusing it on the matching half (LeftClickUp) without picking
  // again. Uses the system clipboard so the value survives navigating between actions and
  // even across app restarts. Format is "x,y" (e.g. "1240,530"), matching what users would
  // naturally write down.
  const [coordCopyFlash, setCoordCopyFlash] = useState(false);
  const [coordPasteError, setCoordPasteError] = useState(false);
  const handleCopyCoords = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(`${x},${y}`);
      setCoordCopyFlash(true);
      setTimeout(() => setCoordCopyFlash(false), 900);
    } catch {
      // Clipboard write can fail in some WebView2 sandbox configs — fall back silently.
    }
  }, [x, y]);
  const handlePasteCoords = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      // Accept "x,y", "x, y", or whitespace-separated "x y" so users can also paste from
      // a manual note. Reject anything that doesn't yield two integers.
      const match = text.trim().match(/^(-?\d+)\s*[,\s]\s*(-?\d+)$/);
      if (!match) {
        setCoordPasteError(true);
        setTimeout(() => setCoordPasteError(false), 1200);
        return;
      }
      setX(match[1]);
      setY(match[2]);
    } catch {
      setCoordPasteError(true);
      setTimeout(() => setCoordPasteError(false), 1200);
    }
  }, []);

  if (actionIndex == null) return null;

  const isKeyAction = actionType === 'KeyDown' || actionType === 'KeyUp';
  const isSendText = actionType === 'SendText';
  const isWaitImage = actionType === 'WaitImage';
  const isPause = actionType === 'Pause';
  const isBrowser = actionType.startsWith('Browser');
  const isBrowserType = actionType === 'BrowserType';
  const isBrowserNavigate = actionType === 'BrowserNavigate';
  const isBrowserWait = actionType === 'BrowserWaitElement';
  const showKey = isKeyAction || isSendText;
  const showCoords = !noCoordTypes.has(actionType);

  // Mouse clicks are stored as paired Down/Up events (LeftClickDown, LeftClickUp, etc.).
  // The Action Type picker only offers the unsuffixed names; baseActionType strips the
  // Down/Up suffix so the picker can match-highlight the right button, and clickHalfSuffix
  // lets us preserve the press/release half when the user switches between click types.
  const clickHalfMatch = actionType.match(/^((?:Left|Right|Middle)Click)(Down|Up)$/);
  const isClickHalf = clickHalfMatch !== null;
  const clickHalfBase = clickHalfMatch ? clickHalfMatch[1] : null;
  const clickHalfSuffix = clickHalfMatch ? (clickHalfMatch[2] as 'Down' | 'Up') : null;
  const baseActionType = clickHalfBase ?? actionType;

  // Detect which family the current action belongs to, so the picker can offer only
  // meaningful in-family transitions (see familyTypes comment).
  const currentFamily: ActionFamily | null = isClickHalf
    ? 'click'
    : (actionType === 'KeyDown' || actionType === 'KeyUp')
      ? 'key'
      : (actionType === 'ScrollUp' || actionType === 'ScrollDown')
        ? 'scroll'
        : actionType === 'SendText'
          ? 'text'
          : null;
  // Skip rendering the picker when there's nothing useful to switch to (single-option family).
  const familyOptions = currentFamily ? familyTypes[currentFamily] : [];
  const showTypePicker = familyOptions.length > 1;

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
            <div className="text-[11px] text-text-tertiary mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span>
                Action #{(actionIndex ?? 0) + 1} — {isWaitImage ? 'Wait Image'
                  : actionType === 'BrowserClick' ? 'Left Click'
                  : actionType === 'BrowserRightClick' ? 'Right Click'
                  : actionType === 'BrowserType' ? 'Input Text'
                  : actionType === 'BrowserWaitElement' ? 'Wait'
                  : actionType === 'BrowserNavigate' ? 'Navigate'
                  : isClickHalf
                    ? `${(clickHalfBase ?? '').replace('Click', '')} Click`
                    : actionType}
              </span>
              {clickHalfSuffix && (
                <span
                  className="px-1.5 py-[1px] rounded text-[10px] font-medium border bg-bg-card text-text-secondary border-border-default"
                  title={clickHalfSuffix === 'Down' ? 'Button pressed down' : 'Button released'}
                >
                  {clickHalfSuffix === 'Down' ? '↓ press' : '↑ release'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 flex-1 min-h-0 overflow-y-auto">
          {/* Action Type — only shown when the family has >1 meaningful option. Hidden for
              SendText (single option), WaitImage / Browser / Pause (each has its own editor
              shape). Cross-family conversions aren't offered: users who want to swap families
              record a new action — it's faster and avoids leaving half-filled fields behind. */}
          {!isWaitImage && !isBrowser && !isPause && showTypePicker && (
          <div>
            <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">ACTION TYPE</label>
            <div className="flex flex-wrap gap-1.5">
              {familyOptions.map(t => {
                // When editing a click half (LeftClickDown / LeftClickUp / etc.), picking
                // another click type must preserve the suffix so the engine still dispatches
                // the action — `RightClick` alone is silently skipped by the replay switch.
                const isClickPick = /^(?:Left|Right|Middle)Click$/.test(t.value);
                const nextValue = isClickPick && clickHalfSuffix
                  ? `${t.value}${clickHalfSuffix}`
                  : t.value;
                // Highlight on the base type so users editing a Down/Up half see the right
                // chip lit up (the raw actionType `LeftClickDown` would never match `LeftClick`).
                const isActive = baseActionType === t.value;
                return (
                  <button
                    key={t.value}
                    onClick={() => setActionType(nextValue)}
                    className={`px-2.5 py-1 rounded text-[11px] font-medium border transition-colors ${
                      isActive
                        ? 'text-accent border-accent/30 bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
                        : 'text-text-secondary border-border-default bg-bg-elevated hover:bg-bg-card'
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {/* WaitImage Settings */}
          {isWaitImage && (
          <>
            {/* Thumbnail + Recapture + Test match — thumbnail is clickable to open the cropper
                for fine-tuning the reference (no need to revisit the screen state). */}
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">REFERENCE IMAGE</label>
              <button
                type="button"
                onClick={() => action?.imageBase64 && setCropperOpen(true)}
                disabled={!action?.imageBase64}
                title={action?.imageBase64 ? 'Click to crop the reference image' : ''}
                className="w-full rounded border border-border-default bg-bg-elevated overflow-hidden block hover:border-accent-solid/60 transition-colors disabled:cursor-default disabled:hover:border-border-default"
              >
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
              </button>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => {
                    send({ type: 'waitimage:recapture', payload: { index: actionIndex } });
                    onClose();
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium border border-border-default bg-bg-elevated hover:bg-bg-card text-text-secondary hover:text-text-primary transition-colors"
                  title="Recapture reference image"
                >
                  <RefreshCw size={12} />
                  Recapture
                </button>
                <button
                  onClick={handleTestMatch}
                  disabled={!action?.imagePath || testMatchRequestId != null}
                  className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium border border-border-default bg-bg-elevated hover:bg-bg-card text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Capture the screen now and report the match score"
                >
                  <PlayCircle size={12} />
                  {testMatchRequestId != null ? 'Testing…' : 'Test match'}
                </button>
              </div>
              {/* Test match result — coloured by whether the score clears the tolerance threshold.
                  Plus a quick-action to convert the found match into the search region (the easiest
                  way to set an ROI accurately, since the user no longer has to eyeball it). */}
              {testMatchResult && !testMatchRequestId && (
                <div
                  className={`mt-2 px-2 py-1.5 rounded text-[11px] font-mono border ${
                    testMatchResult.error
                      ? 'border-[#C42B1C]/40 bg-[#C42B1C]/10 text-[#C42B1C]'
                      : testMatchResult.found
                      ? 'border-[#0E7A0D]/40 bg-[#0E7A0D]/10 text-[#6bcb77]'
                      : 'border-[#C42B1C]/40 bg-[#C42B1C]/10 text-[#ff6b6b]'
                  }`}
                >
                  {testMatchResult.error ? (
                    testMatchResult.error
                  ) : (
                    <>
                      <div>
                        Best match: {Math.round(testMatchResult.score * 100)}% at ({testMatchResult.x}, {testMatchResult.y})
                        {testMatchResult.found ? ' ✓' : ' — below tolerance'}
                      </div>
                      {testMatchResult.found && (
                        <button
                          type="button"
                          onClick={() => {
                            // 80px margin around the match — wide enough to tolerate small UI
                            // shifts (resizing, anti-aliasing) without wasting CPU on full-screen.
                            const margin = 80;
                            setWaitImageSearchRegion({
                              x: Math.max(0, testMatchResult.x - margin),
                              y: Math.max(0, testMatchResult.y - margin),
                              w: testMatchResult.w + margin * 2,
                              h: testMatchResult.h + margin * 2,
                            });
                          }}
                          className="mt-1.5 text-[10px] underline decoration-dotted hover:text-text-primary transition-colors"
                          title="Auto-set the Search Region to a rect around this match"
                        >
                          → Use as search region (with 80px margin)
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Wait Until + On Timeout — both options in each select are self-explanatory now
                that ON TIMEOUT is collapsed to just two values, so no help line needed. */}
            <div className="flex gap-2.5">
              <div className="flex-1">
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">WAIT UNTIL</label>
                <select
                  value={waitImageInvert ? 'disappears' : 'appears'}
                  onChange={(e) => setWaitImageInvert(e.target.value === 'disappears')}
                  className="w-full h-8 px-2 text-ui bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                >
                  <option value="appears">Image appears</option>
                  <option value="disappears">Image disappears</option>
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">ON TIMEOUT</label>
                <select
                  value={waitImageOnTimeout}
                  onChange={(e) => setWaitImageOnTimeout(e.target.value)}
                  className="w-full h-8 px-2 text-ui bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                >
                  <option value="StopReplay">Stop replay</option>
                  <option value="Continue">Continue to next</option>
                </select>
              </div>
            </div>

            {/* Timeout / Tolerance */}
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

            {/* Search Region (ROI) — label + display row carry the meaning; explanation line
                would be redundant. Configure button's title attribute keeps the discovery hint
                on hover for users who pause over it. */}
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">SEARCH REGION</label>
              <div className="flex items-center gap-2">
                <div className="flex-1 px-2 py-1.5 text-[11px] font-mono bg-bg-input border border-border-default rounded text-text-secondary">
                  {waitImageSearchRegion
                    ? `${waitImageSearchRegion.x}, ${waitImageSearchRegion.y}  ·  ${waitImageSearchRegion.w} × ${waitImageSearchRegion.h}`
                    : <span className="text-text-disabled italic">Full screen (default)</span>}
                </div>
                <button
                  onClick={handleConfigureSearchRegion}
                  className="px-2.5 py-1.5 rounded text-xs font-medium border border-border-default bg-bg-elevated hover:bg-bg-card text-text-secondary hover:text-text-primary transition-colors"
                  title="Draw a sub-rectangle of the screen to limit where the match runs. Reduces CPU and false positives."
                >
                  Configure…
                </button>
                {waitImageSearchRegion && (
                  <button
                    onClick={() => setWaitImageSearchRegion(null)}
                    className="px-2 py-1.5 rounded text-xs text-text-tertiary hover:text-[#C42B1C] hover:bg-bg-card transition-colors"
                    title="Clear search region (revert to full screen)"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>

            {/* After Match — header kept for visual consistency with the other sections, but
                the checkbox label already describes the behaviour; tooltip on hover carries the
                longer explanation for users who linger. */}
            {!waitImageInvert && (
              <div>
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">AFTER MATCH</label>
                <label
                  className="flex items-center gap-2 cursor-pointer"
                  title="Left-clicks the centre of the matched region as soon as it's found."
                >
                  <Checkbox checked={waitImageClickOnMatch} onChange={setWaitImageClickOnMatch} />
                  <span className="text-ui text-text-secondary">Click on found location</span>
                </label>
              </div>
            )}
          </>
          )}

          {/* Pause Settings */}
          {isPause && (
          <>
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">RESUME HOTKEY</label>
              <input
                type="text"
                readOnly
                value={pauseHotkeyFocused ? '' : (key || '')}
                placeholder="New key..."
                onFocus={() => setPauseHotkeyFocused(true)}
                onBlur={() => setPauseHotkeyFocused(false)}
                onKeyDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const modifierKeys = new Set(['Control', 'Alt', 'Shift', 'Meta']);
                  const modifiers: string[] = [];
                  if (e.ctrlKey) modifiers.push('Ctrl');
                  if (e.altKey) modifiers.push('Alt');
                  if (e.shiftKey) modifiers.push('Shift');
                  if (modifierKeys.has(e.key)) return;
                  if (e.key === 'Escape') { setKey(''); (e.target as HTMLInputElement).blur(); return; }
                  let mainKey = e.key;
                  if (e.code.startsWith('Numpad') && e.code !== 'NumpadEnter') {
                    const numpadMap: Record<string, string> = {
                      Numpad0: 'Num0', Numpad1: 'Num1', Numpad2: 'Num2', Numpad3: 'Num3',
                      Numpad4: 'Num4', Numpad5: 'Num5', Numpad6: 'Num6', Numpad7: 'Num7',
                      Numpad8: 'Num8', Numpad9: 'Num9',
                      NumpadMultiply: 'NumMultiply', NumpadDivide: 'NumDivide',
                      NumpadAdd: 'NumAdd', NumpadSubtract: 'NumSubtract',
                      NumpadDecimal: 'NumDecimal',
                    };
                    mainKey = numpadMap[e.code] ?? e.code;
                  } else if (mainKey === ' ') mainKey = 'Space';
                  else if (mainKey.length === 1) mainKey = mainKey.toUpperCase();
                  else if (mainKey === 'ArrowUp') mainKey = 'Up';
                  else if (mainKey === 'ArrowDown') mainKey = 'Down';
                  else if (mainKey === 'ArrowLeft') mainKey = 'Left';
                  else if (mainKey === 'ArrowRight') mainKey = 'Right';
                  if (!modifiers.includes(mainKey)) modifiers.push(mainKey);
                  setKey(modifiers.join('+'));
                  (e.target as HTMLInputElement).blur();
                }}
                className={`w-full h-8 px-2 text-ui font-mono bg-bg-input border rounded outline-none cursor-pointer placeholder:text-accent-light/50 ${
                  pauseHotkeyFocused
                    ? 'text-accent-light border-accent-solid animate-pulse'
                    : 'text-text-primary border-border-default'
                }`}
              />
              <div className="text-[10px] text-text-tertiary mt-1">
                Click the field and press a key combo. Esc clears.
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TIMEOUT (s) — 0 = infinite</label>
              <input
                type="number"
                value={timeout}
                onChange={(e) => setTimeout_(e.target.value)}
                min="0"
                step="1"
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              />
              <div className="text-[10px] text-text-tertiary mt-1">
                Auto-resumes if the hotkey isn't pressed in time.
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
              {/* Action keys — dispatched as keydown/keyup at this position.
                  Only keys with a reliable effect in browser inputs are exposed:
                  Enter (native form submit fallback), Esc (no default), Backspace/Delete
                  (we apply the edit ourselves). Tab, arrows, etc. are intentionally omitted —
                  synthetic key events don't trigger the browser's default focus/caret moves. */}
              <div className="flex flex-wrap gap-1 mt-1">
                {[
                  { var: '{enter}', label: 'Enter' },
                  { var: '{esc}', label: 'Esc' },
                  { var: '{backspace}', label: '⌫' },
                  { var: '{delete}', label: 'Del' },
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

          {/* Key — only for KeyDown/KeyUp and SendText. For KeyDown/KeyUp the input is
              read-only and consumes keydown events to capture the key directly; the visible
              value goes through getDisplayKey() so it matches the grid's display rules
              (e.g. raw `D3` shows as `3`, raw `162` shows as `Ctrl`). */}
          {showKey && (
          <div>
            <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">
              {isSendText ? 'TEXT' : 'KEY'}
            </label>
            {isKeyAction ? (
              // Capture-mode visual matches the grid's Key column edit, the SettingsPanel
              // global hotkey inputs, and the ProfilePanel Assign Hotkey dialog. While
              // focused: empty value + "New key..." placeholder + accent border + animate-
              // pulse, so it's unmistakeable that the next key press lands here. On blur,
              // restores the human-readable value (via getDisplayKey).
              <input
                type="text"
                readOnly
                value={keyFieldFocused ? '' : getDisplayKey(key)}
                onFocus={() => setKeyFieldFocused(true)}
                onBlur={() => setKeyFieldFocused(false)}
                onKeyDown={handleKeyCapture}
                placeholder="New key..."
                className={`w-full h-8 px-2 text-ui font-mono bg-bg-input border rounded outline-none cursor-pointer placeholder:text-accent-light/50 ${
                  keyFieldFocused
                    ? 'text-accent-light border-accent-solid animate-pulse'
                    : 'text-text-primary border-border-default'
                }`}
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

          {/* X / Y — Pick button (only on click halves, since scroll actions don't really
              use X/Y but happen to live in showCoords). Lets the user click somewhere on
              screen to fill both coords without manual typing or re-recording. */}
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
              {isClickHalf && (
                <div className="flex flex-col justify-end gap-1">
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={handlePickPosition}
                      disabled={pickPositionRequestId != null}
                      className="h-8 flex items-center gap-1.5 px-2.5 text-[11px] font-medium border border-border-default bg-bg-elevated hover:bg-bg-card text-text-secondary hover:text-text-primary rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Click anywhere on screen to set X/Y"
                    >
                      <Crosshair size={12} />
                      {pickPositionRequestId != null ? 'Picking…' : 'Pick'}
                    </button>
                    <button
                      type="button"
                      onClick={handleCopyCoords}
                      style={coordCopyFlash ? { borderColor: 'var(--color-replay)', color: 'var(--color-replay)', backgroundColor: 'var(--color-replay-bg)' } : undefined}
                      className={`h-8 w-8 flex items-center justify-center border rounded transition-colors ${
                        coordCopyFlash
                          ? ''
                          : 'border-border-default bg-bg-elevated hover:bg-bg-card text-text-secondary hover:text-text-primary'
                      }`}
                      title={coordCopyFlash ? 'Copied!' : 'Copy X,Y to clipboard'}
                    >
                      {coordCopyFlash ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                    <button
                      type="button"
                      onClick={handlePasteCoords}
                      style={coordPasteError ? { borderColor: 'var(--color-recording)', color: 'var(--color-recording)', backgroundColor: 'var(--color-recording-bg)' } : undefined}
                      className={`h-8 w-8 flex items-center justify-center border rounded transition-colors ${
                        coordPasteError
                          ? ''
                          : 'border-border-default bg-bg-elevated hover:bg-bg-card text-text-secondary hover:text-text-primary'
                      }`}
                      title={coordPasteError ? 'Clipboard does not contain valid coords' : 'Paste X,Y from clipboard'}
                    >
                      {coordPasteError ? <X size={12} /> : <ClipboardPaste size={12} />}
                    </button>
                  </div>
                </div>
              )}
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

      {/* Crop modal — only mounted when explicitly opened; portals to body so it sits above
          the side panel even though it's rendered from inside this component tree. */}
      {cropperOpen && action?.imageBase64 && (
        <ImageCropper
          imageBase64={action.imageBase64}
          onSave={handleCropSave}
          onCancel={() => setCropperOpen(false)}
        />
      )}
    </>,
    document.body
  );
}
