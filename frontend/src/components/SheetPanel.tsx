import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, RefreshCw, Crosshair, Copy, ClipboardPaste, ShieldCheck, ShieldAlert, ShieldQuestion, PlayCircle, Pipette, Check, X } from 'lucide-react';
import { useBridge } from '../bridge/BridgeContext';
import { useAppState } from '../state/AppStateContext';
import type { SelectorAlternative, BrowserTestResult } from '../bridge/messageTypes';
import { Checkbox } from './Checkbox';
import { NumberInput } from './common/NumberInput';
import { ImageCropper } from './ImageCropper';
import { LexicalTokenEditor, type LexicalEditorHandle } from './lexical/LexicalTokenEditor';
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
// (same key, different phase), ScrollUp ↔ ScrollDown (toggle direction). SendText has no
// family because it's the only "text" action — picker would be a single chip with nothing
// to switch to, so currentFamily simply returns null for it.
type ActionFamily = 'click' | 'key' | 'scroll';
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
};

const noCoordTypes = new Set(['KeyDown', 'KeyUp', 'Keystroke', 'ScrollUp', 'ScrollDown', 'SendText', 'WaitImage', 'WaitPixelColor', 'BrowserClick', 'BrowserRightClick', 'BrowserType', 'BrowserWaitElement', 'BrowserNavigate', 'BrowserSelectOption', 'Pause', 'If', 'Else', 'EndIf']);

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
  // Imperative handle to the Lexical-based BrowserType editor — used by the chip
  // buttons to insertText at the current cursor position instead of always appending.
  const browserTextEditorRef = useRef<LexicalEditorHandle | null>(null);
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
  // BrowserSelectOption — how to match the <option> inside the <select>. Default 'text'.
  // Stored as null on disk when 'text' (the default); 'value' or 'index' otherwise.
  const [selectMatchMode, setSelectMatchMode] = useState<'text' | 'value' | 'index'>('text');

  // WaitImage extras (timeout branching, disappear toggle, click-on-match, ROI).
  // Stored locally during edit; persisted via actions:edit on Save. Default "StopReplay"
  // matches the dropdown's default option — a clean stop without a noisy error popup.
  const [waitImageOnTimeout, setWaitImageOnTimeout] = useState<string>('StopReplay'); // 'Continue' | 'StopReplay'
  const [waitImageInvert, setWaitImageInvert] = useState(false);
  const [waitImageClickOnMatch, setWaitImageClickOnMatch] = useState(false);
  const [waitImageSearchRegion, setWaitImageSearchRegion] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // WaitPixelColor state — mirror of the action's pixel fields. Held locally so the user
  // can edit freely before Save; written back as 'actions:edit' messages on Save. Strings
  // for the numeric inputs to allow empty intermediate states without forcing 0 echoes.
  const [pixelX, setPixelX] = useState<string>('');
  const [pixelY, setPixelY] = useState<string>('');
  const [pixelColor, setPixelColor] = useState<string>('');     // "#RRGGBB"
  const [pixelTolerance, setPixelTolerance] = useState<string>('0');
  const [pixelOnTimeout, setPixelOnTimeout] = useState<string>('StopReplay'); // 'Continue' | 'StopReplay'
  const [pixelInvert, setPixelInvert] = useState(false);
  const [pixelClickOnMatch, setPixelClickOnMatch] = useState(false);

  // Conditional logic — IF rows reuse the WaitImage / WaitPixelColor probe state
  // above. Two extra knobs sit on top: Negate flips the branch outcome (IFNOT
  // semantic), OnProbeError decides what happens when the probe throws/can't
  // run. Default "TreatAsFalse" matches the C# IfOnProbeError null/default path
  // and lets the FALSE branch fire on error; "Halt" rethrows and stops replay.
  const [conditionNegate, setConditionNegate] = useState(false);
  const [ifOnProbeError, setIfOnProbeError] = useState<'TreatAsFalse' | 'Halt'>('TreatAsFalse');

  // Eyedropper / live-test request tracking — mirrors the WaitImage testMatch /
  // mouse:pickPosition pattern. Single in-flight request at a time; the requestId
  // gates the message handler so a stale reply can't overwrite newer state.
  const [pickColorRequestId, setPickColorRequestId] = useState<string | null>(null);
  const [testPixelRequestId, setTestPixelRequestId] = useState<string | null>(null);
  const [testPixelResult, setTestPixelResult] = useState<{ matches: boolean; sampledHex?: string | null; error?: string } | null>(null);

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
          // Auto-apply the matched rect as the search region when the test succeeds.
          // Saves a click — the user just confirmed where the image is, so the most
          // useful Search Region is "right around there". 80 px padding tolerates
          // small UI shifts (resize, anti-aliasing) without wasting CPU on the rest
          // of the screen. The user can still customise via Configure Region — and
          // re-running Test with a manual region keeps overwriting it (intentional:
          // Test is the source of truth for "where the image actually is").
          if (r.found) {
            const margin = 80;
            setWaitImageSearchRegion({
              x: Math.max(0, r.x - margin),
              y: Math.max(0, r.y - margin),
              w: r.w + margin * 2,
              h: r.h + margin * 2,
            });
          }
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
      } else if (msg.type === 'pixel:colorPicked') {
        // Eyedropper reply — fills X/Y + colour in one shot. Three-field update so
        // the user gets all the metadata of the click; they can still tweak any of
        // the three before saving.
        const r = msg.payload as { requestId: string; cancelled: boolean; x?: number; y?: number; hex?: string };
        if (pickColorRequestId && r.requestId === pickColorRequestId) {
          if (!r.cancelled && r.x != null && r.y != null && r.hex) {
            setPixelX(String(r.x));
            setPixelY(String(r.y));
            setPixelColor(r.hex);
          }
          setPickColorRequestId(null);
        }
      } else if (msg.type === 'pixel:testMatchResult') {
        const r = msg.payload as { requestId: string; matches: boolean; sampledHex?: string | null; error?: string };
        if (testPixelRequestId && r.requestId === testPixelRequestId) {
          setTestPixelResult({ matches: r.matches, sampledHex: r.sampledHex, error: r.error });
          setTestPixelRequestId(null);
        }
      }
    });
  }, [subscribe, testRequestId, clearTestTimeout, testMatchRequestId, clearTestMatchTimeout, pickPositionRequestId, pickColorRequestId, testPixelRequestId]);

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
      // null/undefined/'text' all collapse to the default 'text' display.
      setSelectMatchMode(
        action.selectMatchMode === 'value' ? 'value'
          : action.selectMatchMode === 'index' ? 'index'
          : 'text'
      );
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
      // WaitPixelColor state seeding — null/undefined become empty strings so the
      // numeric inputs render blank instead of "null". OnTimeout collapses everything
      // that isn't explicit "Continue" down to "StopReplay" to match the dropdown options.
      setPixelX(action.pixelX != null ? String(action.pixelX) : '');
      setPixelY(action.pixelY != null ? String(action.pixelY) : '');
      setPixelColor(action.pixelColor ?? '');
      setPixelTolerance(String(action.pixelTolerance ?? 0));
      setPixelOnTimeout(action.pixelOnTimeout === 'Continue' ? 'Continue' : 'StopReplay');
      setPixelInvert(action.pixelInvert || false);
      setPixelClickOnMatch(action.pixelClickOnMatch || false);
      setTestPixelResult(null);
      setTestPixelRequestId(null);
      // Conditional logic seeding — defaults to "Found" semantic + TreatAsFalse policy
      // so a freshly-inserted IF row reads as the most permissive shape.
      setConditionNegate(action.conditionNegate || false);
      setIfOnProbeError(action.ifOnProbeError === 'Halt' ? 'Halt' : 'TreatAsFalse');
    }
  }, [action]);
  /* eslint-enable react-hooks/set-state-in-effect */


  const handleSave = useCallback(() => {
    if (actionIndex == null || !action) return;

    // Conditional flags re-derived inside the callback because the outer
    // `const isIf = ...` declarations sit FURTHER DOWN the component body
    // (after this useCallback). TypeScript flags forward references as
    // TS2448 / TS2454 in strict mode, even though the closure would read
    // them correctly at runtime. Cost is one bool eval per save click.
    const _isIf = actionType === 'If';
    const _isIfImage = _isIf && action.conditionType === 'ImageFound';
    const _isIfPixel = _isIf && action.conditionType === 'PixelColorMatch';

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

    // WaitImage-specific fields — also runs for IF Image rows (_isIfImage), but
    // the polling-only knobs (timeout, waitImageOnTimeout, waitImageInvert,
    // waitImageClickOnMatch) are gated inside so they don't leak into IF rows.
    if (actionType === 'WaitImage' || _isIfImage) {
      if (actionType === 'WaitImage') {
        const newTimeoutMs = Math.max(1, parseFloat(timeout) || 5) * 1000;
        if (newTimeoutMs !== (action.timeout || 5000)) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'timeout', value: String(Math.round(newTimeoutMs)) } });
        }
      }
      const newConfidence = Math.min(100, Math.max(10, parseInt(confidence, 10) || 80)) / 100;
      if (newConfidence !== (action.confidence || 0.8)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'confidence', value: String(newConfidence) } });
      }
      if (actionType === 'WaitImage') {
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
      }
      // Search region — serialised as "x,y,w,h" or empty string. Compare against the action's
      // current rect to avoid no-op edits (which would still bump the undo stack). Shared
      // between WaitImage and IF Image — both use the ROI to constrain the probe.
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

    // WaitPixelColor — also runs for IF Pixel rows (_isIfPixel) for the shared probe
    // fields (pixelX/Y/Color/Tolerance). Polling-only knobs (timeout, pixelOnTimeout,
    // pixelInvert, pixelClickOnMatch) are gated inside so they don't leak into IF rows.
    if (actionType === 'WaitPixelColor' || _isIfPixel) {
      if (actionType === 'WaitPixelColor') {
        const newTimeoutMs = Math.max(1, parseFloat(timeout) || 5) * 1000;
        if (newTimeoutMs !== (action.timeout || 5000)) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'timeout', value: String(Math.round(newTimeoutMs)) } });
        }
      }
      const trimmedX = pixelX.trim();
      const trimmedY = pixelY.trim();
      const parsedX = trimmedX === '' ? null : parseInt(trimmedX, 10);
      const parsedY = trimmedY === '' ? null : parseInt(trimmedY, 10);
      if ((parsedX ?? null) !== (action.pixelX ?? null)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'pixelX', value: parsedX == null ? '' : String(parsedX) } });
      }
      if ((parsedY ?? null) !== (action.pixelY ?? null)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'pixelY', value: parsedY == null ? '' : String(parsedY) } });
      }
      // Normalise the colour string on commit: trim, uppercase, ensure leading '#'.
      // Backend stores exactly what we send; keeping it canonical here avoids "#fc5" vs
      // "FC5" vs "fc5" diffs in the saved JSON and keeps the swatch in the editor
      // stable across save+reload cycles.
      const rawColor = pixelColor.trim();
      const normalisedColor = rawColor === ''
        ? ''
        : (rawColor.startsWith('#') ? rawColor.toUpperCase() : '#' + rawColor.toUpperCase());
      if (normalisedColor !== (action.pixelColor ?? '')) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'pixelColor', value: normalisedColor } });
      }
      const newTol = Math.max(0, Math.min(255, parseInt(pixelTolerance, 10) || 0));
      if (newTol !== (action.pixelTolerance ?? 0)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'pixelTolerance', value: String(newTol) } });
      }
      if (actionType === 'WaitPixelColor') {
        const persistedPxTimeout = pixelOnTimeout === 'Continue' ? 'Continue' : '';
        const currentPxTimeout = action.pixelOnTimeout === 'Continue' ? 'Continue' : '';
        if (persistedPxTimeout !== currentPxTimeout) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'pixelOnTimeout', value: persistedPxTimeout } });
        }
        if (!!pixelInvert !== !!(action.pixelInvert)) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'pixelInvert', value: String(pixelInvert) } });
        }
        if (!!pixelClickOnMatch !== !!(action.pixelClickOnMatch)) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'pixelClickOnMatch', value: String(pixelClickOnMatch) } });
        }
      }
    }

    // Conditional-logic-specific fields — only fire when actually editing an IF row.
    // ifOnProbeError persists "Halt" only; "TreatAsFalse" stays null on disk (matches
    // the WaitImage / WaitPixelColor "Continue" convention). conditionNegate persists
    // as a plain boolean.
    if (_isIf) {
      if (!!conditionNegate !== !!(action.conditionNegate)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'conditionNegate', value: String(conditionNegate) } });
      }
      const persistedErr = ifOnProbeError === 'Halt' ? 'Halt' : '';
      const currentErr = action.ifOnProbeError === 'Halt' ? 'Halt' : '';
      if (persistedErr !== currentErr) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'ifOnProbeError', value: persistedErr } });
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

    // BrowserSelectOption — match mode + browserText hold the option label/value/index.
    // browserText is already saved by the BrowserType branch above when actionType matches —
    // here we just persist the selectMatchMode separately. 'text' is the default and stays
    // null on disk; the backend rewrites it to null when receiving 'text' or empty.
    if (actionType === 'BrowserSelectOption') {
      // Persist BrowserText for the select target too (BrowserType-branch only covers BrowserType).
      if (browserText !== (action.browserText || '')) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'browserText', value: browserText } });
      }
      // Persist the match mode if it differs from what's on disk.
      const currentMode = action.selectMatchMode === 'value' ? 'value'
        : action.selectMatchMode === 'index' ? 'index'
        : 'text';
      if (selectMatchMode !== currentMode) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'selectMatchMode', value: selectMatchMode } });
      }
    }

    onClose();
    // isIf / isIfImage / isIfPixel intentionally NOT in deps: they're pure-derived
    // from actionType + action.conditionType which are already in the array, so the
    // callback rebinds whenever those change. Listing the derived flags would also
    // be a forward-reference error (they're declared further down the component body).
  }, [actionIndex, action, actionType, key, textMatch, textMode, x, y, delay, comment, timeout, confidence, browserText, newTab, waitMode, urlWaitPattern, postNavigateSelector, typeAppend, typePaste, typeDelay, selectMatchMode, waitImageOnTimeout, waitImageInvert, waitImageClickOnMatch, waitImageSearchRegion, pixelX, pixelY, pixelColor, pixelTolerance, pixelOnTimeout, pixelInvert, pixelClickOnMatch, conditionNegate, ifOnProbeError, send, onClose]);

  // Key capture handler — focusing the field switches it to capture mode (empty + "New
  // key..." + pulse), the next non-modifier key is stored, and the input auto-blurs so
  // the user sees the resolved value immediately. Esc is intentionally NOT a cancel key
  // any more — the user might legitimately want to assign Escape as a hotkey. Cancelling
  // is done by clicking away or letting the idle timer fire (see armKeyCaptureTimer).
  const [keyFieldFocused, setKeyFieldFocused] = useState(false);
  const keyFieldRef = useRef<HTMLInputElement>(null);
  const keyCaptureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const KEY_CAPTURE_TIMEOUT_MS = 4000;
  const armKeyCaptureTimer = useCallback(() => {
    if (keyCaptureTimerRef.current) clearTimeout(keyCaptureTimerRef.current);
    keyCaptureTimerRef.current = setTimeout(() => {
      keyFieldRef.current?.blur();
    }, KEY_CAPTURE_TIMEOUT_MS);
  }, []);
  const disarmKeyCaptureTimer = useCallback(() => {
    if (keyCaptureTimerRef.current) {
      clearTimeout(keyCaptureTimerRef.current);
      keyCaptureTimerRef.current = null;
    }
  }, []);

  // Pause-resume hotkey capture: while the field is focused, the backend low-level
  // hook composes every keypress (including Win+letter combos the WebView2 JS layer
  // never sees) and forwards them here. Commit on first non-pure-modifier combo.
  useEffect(() => {
    if (!pauseHotkeyFocused) return;
    return subscribe((msg) => {
      if (msg.type !== 'hotkey:captured') return;
      const combo = msg.payload.combo;
      setKey(combo);
      armKeyCaptureTimer();
      const isPureModifier = /^(Win|Ctrl|Alt|Shift)(\+(Win|Ctrl|Alt|Shift))*$/.test(combo);
      if (!isPureModifier) {
        disarmKeyCaptureTimer();
        keyFieldRef.current?.blur();
      }
    });
  }, [pauseHotkeyFocused, subscribe, armKeyCaptureTimer, disarmKeyCaptureTimer]);

  const handleKeyCapture = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Push out the idle-cancel timer on every keypress — even modifiers — so an actively
    // engaged user is never surprised by a sudden cancel mid-combo.
    armKeyCaptureTimer();

    const modifierKeys = new Set(['Control', 'Alt', 'Shift', 'Meta']);
    if (modifierKeys.has(e.key)) return;

    let mainKey = e.key;
    if (mainKey === ' ') mainKey = 'Space';
    else if (mainKey.length === 1) mainKey = mainKey.toUpperCase();
    else if (mainKey === 'ArrowUp') mainKey = 'Up';
    else if (mainKey === 'ArrowDown') mainKey = 'Down';
    else if (mainKey === 'ArrowLeft') mainKey = 'Left';
    else if (mainKey === 'ArrowRight') mainKey = 'Right';

    setKey(mainKey);
    disarmKeyCaptureTimer();
    // Drop focus so the user sees the captured value rendered instead of staying in
    // capture mode.
    (e.target as HTMLInputElement).blur();
  }, [armKeyCaptureTimer, disarmKeyCaptureTimer]);

  // Esc-to-close — global listener that closes the panel when the user presses Escape
  // outside of any capture mode. Key capture handlers (KeyDown/KeyUp Key field, Pause
  // Resume Hotkey, the grid Key column edit, Settings global hotkeys) all call
  // `e.preventDefault()` on every key, including Escape. That flips `defaultPrevented`
  // on the underlying native event, so we just check it here and skip the close when an
  // inner handler already consumed the press. Listener is only active while the panel is
  // mounted with a non-null actionIndex.
  useEffect(() => {
    if (actionIndex == null) return;
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      onClose();
    };
    document.addEventListener('keydown', onDocKeyDown);
    return () => document.removeEventListener('keydown', onDocKeyDown);
  }, [actionIndex, onClose]);

  // Reset the capture state whenever the panel switches to a different action (including
  // closing — actionIndex going null). Without this, focusing the field, closing the
  // panel, then reopening leaves the field stuck in capture mode because the input was
  // unmounted before its blur could fire. Also tear down any pending idle-cancel timer
  // so it doesn't fire against a stale input ref after the panel reopens. Finally drop
  // any in-flight pickPosition request: if the user opens action A, clicks Pick, closes
  // the panel, then opens action B, the overlay's reply would otherwise land on B.
  useEffect(() => {
    setKeyFieldFocused(false);
    setPauseHotkeyFocused(false);
    disarmKeyCaptureTimer();
    setPickPositionRequestId(null);
  }, [actionIndex, disarmKeyCaptureTimer]);

  // Unmount cleanup — any pending timers must be torn down so they don't fire against
  // refs to gone DOM nodes (would warn in React strict-mode dev, harmless in prod but
  // still worth doing).
  useEffect(() => {
    return () => {
      disarmKeyCaptureTimer();
      if (coordCopyFlashTimerRef.current) clearTimeout(coordCopyFlashTimerRef.current);
      if (coordPasteErrorTimerRef.current) clearTimeout(coordPasteErrorTimerRef.current);
    };
  }, [disarmKeyCaptureTimer]);

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
        // BrowserSelectOption — forward the match mode so Test Action picks the same
        // option the actual replay would. Without this, value/index modes silently fell
        // back to text on the test path.
        selectMatchMode: actionType === 'BrowserSelectOption' ? selectMatchMode : null,
      },
    });
  }, [actionIndex, action, actionType, key, textMatch, textMode, timeout, browserText, newTab, waitMode, urlWaitPattern, postNavigateSelector, typeAppend, typePaste, typeDelay, selectMatchMode, send, clearTestTimeout]);

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
  // Result arrives via the 'waitimage:searchRegionSet' message handled above. When a region
  // is already saved, pass it along so the overlay opens with the rect pre-drawn — the user
  // can ESC to keep it as-is or drag a new one to overwrite.
  const handleConfigureSearchRegion = useCallback(() => {
    const requestId = Math.random().toString(36).slice(2, 10);
    const r = waitImageSearchRegion;
    send({
      type: 'waitimage:configureSearchRegion',
      payload: r
        ? { requestId, x: r.x, y: r.y, w: r.w, h: r.h }
        : { requestId },
    });
  }, [send, waitImageSearchRegion]);

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

  // WaitPixelColor — eyedropper. Minimises the app, opens the screen overlay in
  // pointPick mode, fills X/Y + colour from the click in one shot. The reply lands
  // in the 'pixel:colorPicked' handler above which writes back through setters.
  const handlePickPixelColor = useCallback(() => {
    const requestId = Math.random().toString(36).slice(2, 10);
    setPickColorRequestId(requestId);
    send({ type: 'pixel:pickColor', payload: { requestId } });
  }, [send]);

  // WaitPixelColor — sanity-check the current config against the LIVE screen pixel
  // (no capture). Shows "✅ Matches" or "❌ Got #2B2B2B vs #FF5733 ± 10" inline so
  // the user can calibrate tolerance without leaving the editor. Bails early when
  // the form is incomplete — the backend would just echo a useless mismatch.
  const handleTestPixelMatch = useCallback(() => {
    const trimmedColor = pixelColor.trim();
    if (pixelX.trim() === '' || pixelY.trim() === '' || trimmedColor === '') {
      setTestPixelResult({ matches: false, error: 'Set X, Y, and the target colour first.' });
      return;
    }
    const requestId = Math.random().toString(36).slice(2, 10);
    setTestPixelRequestId(requestId);
    setTestPixelResult(null);
    const hex = trimmedColor.startsWith('#') ? trimmedColor : '#' + trimmedColor;
    send({
      type: 'pixel:testMatch',
      payload: {
        requestId,
        x: parseInt(pixelX, 10),
        y: parseInt(pixelY, 10),
        hex,
        tolerance: parseInt(pixelTolerance, 10) || 0,
      },
    });
  }, [pixelX, pixelY, pixelColor, pixelTolerance, send]);

  // Copy/Paste X,Y — supports the common workflow of picking a position on one click half
  // (e.g. LeftClickDown) and reusing it on the matching half (LeftClickUp) without picking
  // again. Uses the system clipboard so the value survives navigating between actions and
  // even across app restarts. Format is "x,y" (e.g. "1240,530"), matching what users would
  // naturally write down.
  const [coordCopyFlash, setCoordCopyFlash] = useState(false);
  const [coordPasteError, setCoordPasteError] = useState(false);
  // Refs hold the in-flight flash timers so we can cancel them when the panel switches
  // actions or unmounts — otherwise the setTimeout callback fires `setCoordCopyFlash(false)`
  // on a stale component and React warns about state-updates-after-unmount.
  const coordCopyFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coordPasteErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopyCoords = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(`${x},${y}`);
      setCoordCopyFlash(true);
      if (coordCopyFlashTimerRef.current) clearTimeout(coordCopyFlashTimerRef.current);
      coordCopyFlashTimerRef.current = setTimeout(() => {
        setCoordCopyFlash(false);
        coordCopyFlashTimerRef.current = null;
      }, 900);
    } catch {
      // Clipboard write can fail in some WebView2 sandbox configs — fall back silently.
    }
  }, [x, y]);
  const handlePasteCoords = useCallback(async () => {
    const showError = () => {
      setCoordPasteError(true);
      if (coordPasteErrorTimerRef.current) clearTimeout(coordPasteErrorTimerRef.current);
      coordPasteErrorTimerRef.current = setTimeout(() => {
        setCoordPasteError(false);
        coordPasteErrorTimerRef.current = null;
      }, 1200);
    };
    try {
      const text = await navigator.clipboard.readText();
      // Accept "x,y", "x, y", or whitespace-separated "x y" so users can also paste from
      // a manual note. Reject anything that doesn't yield two integers.
      const match = text.trim().match(/^(-?\d+)\s*[,\s]\s*(-?\d+)$/);
      if (!match) { showError(); return; }
      setX(match[1]);
      setY(match[2]);
    } catch {
      showError();
    }
  }, []);

  if (actionIndex == null) return null;

  const isKeyAction = actionType === 'KeyDown' || actionType === 'KeyUp';
  const isSendText = actionType === 'SendText';
  const isWaitImage = actionType === 'WaitImage';
  const isWaitPixelColor = actionType === 'WaitPixelColor';
  const isPause = actionType === 'Pause';
  const isBrowser = actionType.startsWith('Browser');
  // Conditional logic — three structural row types. isIfImage / isIfPixel
  // discriminate which probe family the IF row uses, gating which sub-editor
  // (WaitImage's image picker vs WaitPixelColor's pixel + colour fields) renders.
  // Else/EndIf are pure structural markers — their editor is a Notes-only stub.
  const isIf = actionType === 'If';
  const isElse = actionType === 'Else';
  const isEndIf = actionType === 'EndIf';
  const isIfImage = isIf && action?.conditionType === 'ImageFound';
  const isIfPixel = isIf && action?.conditionType === 'PixelColorMatch';
  const isConditional = isIf || isElse || isEndIf;
  const isBrowserType = actionType === 'BrowserType';
  const isBrowserNavigate = actionType === 'BrowserNavigate';
  const isBrowserWait = actionType === 'BrowserWaitElement';
  const isBrowserSelect = actionType === 'BrowserSelectOption';
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
  // meaningful in-family transitions (see familyTypes comment). SendText returns null —
  // it's the only "text" action so there's nothing to switch to.
  const currentFamily: ActionFamily | null = isClickHalf
    ? 'click'
    : (actionType === 'KeyDown' || actionType === 'KeyUp')
      ? 'key'
      : (actionType === 'ScrollUp' || actionType === 'ScrollDown')
        ? 'scroll'
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
                  : isWaitPixelColor ? 'Wait Pixel Color'
                  : isIfImage ? 'If Image Found'
                  : isIfPixel ? 'If Pixel Color Match'
                  : isIf ? 'If'
                  : isElse ? 'Else'
                  : isEndIf ? 'End If'
                  : actionType === 'BrowserClick' ? 'Left Click'
                  : actionType === 'BrowserRightClick' ? 'Right Click'
                  : actionType === 'BrowserType' ? 'Input Text'
                  : actionType === 'BrowserWaitElement' ? 'Wait'
                  : actionType === 'BrowserNavigate' ? 'Navigate to URL'
                  : actionType === 'BrowserSelectOption' ? 'Select Option'
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

          {/* CONDITION — IF rows only. Two stacked controls:
                • Found / NOT Found segmented toggle drives ConditionNegate. The labels
                  read as the user-facing branch semantic ("fire TRUE branch when found"
                  vs "fire TRUE branch when NOT found"); on disk this is just a flip of
                  the conditionNegate bool. NOT Found is the IFNOT scenario from the
                  user's example list.
                • On Probe Error dropdown drives IfOnProbeError. "Treat as false" (the
                  default) lets the FALSE branch fire on probe exception — graceful for
                  flaky screen captures. "Halt replay" rethrows so the user notices.
              Sits ABOVE the WaitImage / WaitPixelColor sub-editor so it reads as the
              top-of-mind question ("what does this IF do?") before the user dives into
              the probe configuration. */}
          {isIf && (
          <>
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">CONDITION</label>
              <div className="inline-flex gap-0.5 bg-bg-input border border-border-default rounded p-0.5">
                <button
                  type="button"
                  onClick={() => setConditionNegate(false)}
                  className={`px-3 py-1 rounded text-[11px] font-medium transition-colors ${
                    !conditionNegate
                      ? 'bg-bg-elevated text-text-primary'
                      : 'text-text-tertiary hover:text-text-secondary'
                  }`}
                  title="TRUE branch fires when the probe succeeds (image / pixel found)"
                >
                  Found
                </button>
                <button
                  type="button"
                  onClick={() => setConditionNegate(true)}
                  className={`px-3 py-1 rounded text-[11px] font-medium transition-colors ${
                    conditionNegate
                      ? 'bg-bg-elevated text-text-primary'
                      : 'text-text-tertiary hover:text-text-secondary'
                  }`}
                  title="TRUE branch fires when the probe FAILS (image / pixel NOT found) — IFNOT"
                >
                  NOT Found
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">ON PROBE ERROR</label>
              <select
                value={ifOnProbeError}
                onChange={(e) => setIfOnProbeError(e.target.value === 'Halt' ? 'Halt' : 'TreatAsFalse')}
                className="w-full h-8 px-2 text-ui bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              >
                <option value="TreatAsFalse">Treat as false (default)</option>
                <option value="Halt">Halt replay</option>
              </select>
              <div className="text-[10px] text-text-tertiary mt-1">
                Default: probe exception falls through to the FALSE branch so the replay continues.
                Halt rethrows so flaky probes don't silently mask bugs.
              </div>
            </div>
          </>
          )}

          {/* WaitImage Settings — also rendered for IF rows whose ConditionType is
              ImageFound (isIfImage). The probe internals (reference image, search
              region, confidence) are shared; the time-axis fields (Timeout, OnTimeout,
              Wait-for-disappear, Click-on-match) only apply to the polling WaitImage
              action and are gated below with !isIf. */}
          {(isWaitImage || isIfImage) && (
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
                    // Don't close the panel — backend handles minimise/overlay/save
                    // asynchronously and pushes actions:updated when done. The effect
                    // that re-seeds local state on `action` change will pick up the
                    // new imageBase64 / imagePath automatically, so the thumbnail
                    // updates in place. Matches Wait Pixel's "Pick from screen"
                    // behaviour where the editor stays open through the capture.
                    send({ type: 'waitimage:recapture', payload: { index: actionIndex } });
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
              {/* Test match result — coloured by whether the score clears the
                  tolerance threshold. When the match succeeds, the Search Region
                  was already auto-set by the result handler above; the inline
                  note here just confirms that so the user notices the side-effect
                  and knows where to tweak it (Configure Region button below). */}
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
                        <div className="mt-1 text-[10px] opacity-80">
                          Search region set to a ±80 px rect around this match. Use the
                          Search Region field below to fine-tune.
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Search Region (ROI) — placed right under the Test result so the auto-set
                feedback sits next to the field it just modified. Label + display row carry
                the meaning; Configure button's title attribute keeps the discovery hint
                on hover. */}
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

            {/* Wait Until + On Timeout — WaitImage only. IF rows do a single instant
                probe with no polling and no timeout; the equivalent "what if the probe
                errors?" knob lives in the CONDITION section above (On probe error). */}
            {!isIf && (
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
            )}

            {/* Timeout / Tolerance — IF rows DO have Tolerance (it's the probe confidence
                threshold), but no Timeout. Split the row so IF still renders Tolerance
                full-width while WaitImage keeps both fields side-by-side. */}
            <div className="flex gap-2.5">
              {!isIf && (
              <div className="flex-1">
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TIMEOUT (s)</label>
                <NumberInput
                  value={parseInt(timeout, 10) || 1}
                  onChange={(n) => setTimeout_(String(n))}
                  min={1}
                  inputWidth="w-full"
                  inputHeight="h-8"
                  ariaLabel="Timeout in seconds"
                />
              </div>
              )}
              <div className="flex-1">
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TOLERANCE (%)</label>
                <NumberInput
                  value={parseInt(confidence, 10) || 80}
                  onChange={(n) => setConfidence(String(n))}
                  min={10}
                  max={100}
                  step={5}
                  inputWidth="w-full"
                  inputHeight="h-8"
                  ariaLabel="Tolerance percent"
                />
              </div>
            </div>

            {/* After Match — header kept for visual consistency with the other sections, but
                the checkbox label already describes the behaviour; tooltip on hover carries the
                longer explanation for users who linger. Suppressed on IF rows: click-on-match
                isn't part of the MVP — the user routes that via a regular LeftClick action in
                the TRUE branch instead. */}
            {!isIf && !waitImageInvert && (
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

          {/* WaitPixelColor Settings — also rendered for IF rows whose ConditionType is
              PixelColorMatch (isIfPixel). The probe primitives (pixel coords, target
              colour, tolerance) are shared verbatim with WaitPixelColor; the polling-
              specific knobs (Timeout, OnTimeout, Invert, ClickOnMatch) are gated with
              !isIf below — IF rows do an instant single-shot probe with no timeout. */}
          {(isWaitPixelColor || isIfPixel) && (
          <>
            {/* PIXEL TO WATCH — coords + Pick. The eyedropper grabs the colour at the same
                time so users normally don't need to fill the colour swatch manually. */}
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">PIXEL TO WATCH</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={pixelX}
                  onChange={(e) => setPixelX(e.target.value)}
                  placeholder="X"
                  className="w-20 h-7 px-2 text-ui font-mono text-text-primary bg-bg-input border border-border-default rounded text-center outline-none focus:border-accent-solid"
                />
                <input
                  type="text"
                  value={pixelY}
                  onChange={(e) => setPixelY(e.target.value)}
                  placeholder="Y"
                  className="w-20 h-7 px-2 text-ui font-mono text-text-primary bg-bg-input border border-border-default rounded text-center outline-none focus:border-accent-solid"
                />
                <button
                  type="button"
                  onClick={handlePickPixelColor}
                  className="flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium text-text-secondary bg-bg-elevated border border-border-default rounded hover:bg-bg-card hover:text-text-primary transition-colors"
                  title="Click anywhere on screen — captures X, Y, and the pixel colour in one shot"
                >
                  <Pipette size={12} />
                  Pick from screen
                </button>
              </div>
            </div>

            {/* TARGET COLOUR — swatch + hex input. The eyedropper above writes both, but
                the user can also type or paste a hex code directly. Normalisation
                (uppercase + leading #) happens on Save, not on every keystroke, so the
                input stays predictable while editing. */}
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TARGET COLOUR</label>
              <div className="flex items-center gap-2">
                <span
                  className="w-7 h-7 rounded border border-border-default shrink-0"
                  style={{ background: /^#?[0-9A-Fa-f]{6}$/.test(pixelColor.trim()) ? (pixelColor.trim().startsWith('#') ? pixelColor.trim() : '#' + pixelColor.trim()) : 'transparent' }}
                  title={pixelColor || 'No colour set'}
                />
                <input
                  type="text"
                  value={pixelColor}
                  onChange={(e) => setPixelColor(e.target.value)}
                  placeholder="#RRGGBB"
                  className="flex-1 h-7 px-2 text-ui font-mono text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
                />
              </div>
            </div>

            {/* TOLERANCE — per-channel band. Slider + numeric input so users can either
                drag for feel or type an exact value. Range capped at 50 (out of 255)
                because anything higher starts matching unrelated colours; expert users
                who really want > 50 can still type it. */}
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TOLERANCE (PER CHANNEL)</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={pixelTolerance}
                  onChange={(e) => setPixelTolerance(e.target.value)}
                  className="flex-1 accent-accent-solid"
                />
                <input
                  type="text"
                  value={pixelTolerance}
                  onChange={(e) => setPixelTolerance(e.target.value)}
                  className="w-14 h-7 px-2 text-ui font-mono text-text-primary bg-bg-input border border-border-default rounded text-center outline-none focus:border-accent-solid"
                />
                <span className="text-[11px] text-text-tertiary">/ 255</span>
              </div>
              <div className="text-[10px] text-text-tertiary mt-1">
                0 = exact match. Try 5–15 for game UI colours that compress slightly.
              </div>
            </div>

            {/* TIMEOUT + ON TIMEOUT — WaitPixelColor only. IF rows do an instant probe
                with no timeout; the analogous "what if the read errors?" knob is the
                CONDITION → On probe error dropdown rendered above the probe primitives. */}
            {!isIf && (
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TIMEOUT</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={timeout}
                  onChange={(e) => setTimeout_(e.target.value)}
                  className="w-20 h-7 px-2 text-ui font-mono text-text-primary bg-bg-input border border-border-default rounded text-center outline-none focus:border-accent-solid"
                />
                <span className="text-[11px] text-text-tertiary">seconds</span>
                <span className="flex-1" />
                <select
                  value={pixelOnTimeout}
                  onChange={(e) => setPixelOnTimeout(e.target.value)}
                  className="h-7 px-2 text-ui text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
                >
                  <option value="StopReplay">Stop replay</option>
                  <option value="Continue">Continue anyway</option>
                </select>
              </div>
            </div>
            )}

            {/* INVERT — WaitPixelColor only. IF rows express "I want the pixel NOT to
                match" via the CONDITION section's Found / NOT Found toggle, so the
                inline checkbox here would be a confusing duplicate. */}
            {!isIf && (
            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={pixelInvert}
                  onChange={(e) => setPixelInvert(e.target.checked)}
                  className="w-3.5 h-3.5 accent-accent-solid"
                />
                <span className="text-ui text-text-secondary">Wait for the colour to DISAPPEAR</span>
              </label>
              <div className="text-[10px] text-text-tertiary mt-0.5 ml-5">
                Inverts the match — useful for "cooldown indicator stops glowing red" patterns.
              </div>
            </div>
            )}

            {/* After Match — WaitPixelColor only. Same MVP-scope reasoning as the
                WaitImage Click-on-match toggle above: IF rows route this via a regular
                LeftClick in the TRUE branch. */}
            {!isIf && !pixelInvert && (
              <div>
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">AFTER MATCH</label>
                <label
                  className="flex items-center gap-2 cursor-pointer select-none"
                  title="Left-clicks the watched pixel (X, Y) as soon as it matches the target colour."
                >
                  <input
                    type="checkbox"
                    checked={pixelClickOnMatch}
                    onChange={(e) => setPixelClickOnMatch(e.target.checked)}
                    className="w-3.5 h-3.5 accent-accent-solid"
                  />
                  <span className="text-ui text-text-secondary">Click on found location</span>
                </label>
              </div>
            )}

            {/* TEST MATCH — single button that sends a synchronous pixel:testMatch and
                renders the result inline. Result clears on next pick / test / save. */}
            <div className="pt-1">
              <button
                type="button"
                onClick={handleTestPixelMatch}
                className="flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium text-text-secondary bg-bg-elevated border border-border-default rounded hover:bg-bg-card hover:text-text-primary transition-colors"
              >
                <PlayCircle size={12} />
                Test match
              </button>
              {/* Same pill treatment as WaitImage's testMatchResult. */}
              {testPixelResult && (
                <div
                  className={`mt-2 px-2 py-1.5 rounded text-[11px] font-mono border ${
                    testPixelResult.error
                      ? 'border-[#C42B1C]/40 bg-[#C42B1C]/10 text-[#C42B1C]'
                      : testPixelResult.matches
                      ? 'border-[#0E7A0D]/40 bg-[#0E7A0D]/10 text-[#6bcb77]'
                      : 'border-[#C42B1C]/40 bg-[#C42B1C]/10 text-[#ff6b6b]'
                  }`}
                >
                  {testPixelResult.error ? (
                    testPixelResult.error
                  ) : testPixelResult.matches ? (
                    <>Sampled {testPixelResult.sampledHex}  ·  Target {pixelColor} ± {pixelTolerance} ✓</>
                  ) : (
                    <>Sampled {testPixelResult.sampledHex ?? 'no read'}  ·  Target {pixelColor} ± {pixelTolerance} — out of tolerance</>
                  )}
                </div>
              )}
            </div>
          </>
          )}

          {/* Pause Settings */}
          {isPause && (
          <>
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">RESUME HOTKEY</label>
              {/* Same capture pattern as the KeyDown/KeyUp Key field (and the grid / Settings
                  hotkeys): focus → empty + "New key..." + accent pulse; Esc is a regular
                  captured key (users CAN bind Pause-resume to Escape); cancel is click-away
                  or the 4 s idle timer. Reuses keyFieldRef + the shared arm/disarm helpers —
                  the Pause input and the KeyDown/KeyUp input are gated on different action
                  types so they're never rendered simultaneously. */}
              <input
                ref={keyFieldRef}
                type="text"
                readOnly
                value={pauseHotkeyFocused ? '' : (key || '')}
                placeholder="Click to capture…"
                onFocus={() => {
                  setPauseHotkeyFocused(true);
                  armKeyCaptureTimer();
                  send({ type: 'hotkey:capture', payload: { enabled: true } });
                }}
                onBlur={() => {
                  setPauseHotkeyFocused(false);
                  disarmKeyCaptureTimer();
                  send({ type: 'hotkey:capture', payload: { enabled: false } });
                }}
                className={`w-full h-8 px-2 text-ui font-mono bg-bg-input border rounded outline-none cursor-pointer placeholder:text-accent-light/50 ${
                  pauseHotkeyFocused
                    ? 'text-accent-light border-accent-solid animate-pulse'
                    : 'text-text-primary border-border-default'
                }`}
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TIMEOUT (s) — 0 = infinite</label>
              <NumberInput
                value={parseInt(timeout, 10) || 0}
                onChange={(n) => setTimeout_(String(n))}
                min={0}
                inputWidth="w-full"
                inputHeight="h-8"
                ariaLabel="Timeout in seconds"
              />
              {/* Quick presets — covers the 90% of real-world pauses (a second, a few seconds,
                  a minute, a few minutes, indefinite wait). The Manual input above still
                  works for anything in between. Active preset is highlighted to show which
                  value is currently set. */}
              <div className="flex flex-wrap gap-1 mt-1.5">
                {([
                  { label: '1s', secs: 1 },
                  { label: '5s', secs: 5 },
                  { label: '30s', secs: 30 },
                  { label: '1m', secs: 60 },
                  { label: '5m', secs: 300 },
                  { label: '∞', secs: 0 },
                ] as const).map(p => {
                  const parsed = parseFloat(timeout);
                  const currentSecs = isNaN(parsed) ? 0 : parsed;
                  const isActive = currentSecs === p.secs;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setTimeout_(String(p.secs))}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                        isActive
                          ? 'text-accent border-accent/30 bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
                          : 'text-text-tertiary border-border-default bg-bg-elevated hover:text-text-secondary hover:bg-bg-card'
                      }`}
                      title={p.secs === 0 ? 'Wait forever (resume hotkey only)' : `Wait ${p.label}`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Foot-gun warning — if neither a resume hotkey nor a timeout is set, the
                Pause is silently skipped at replay time (ExecutePause early-returns). Save
                still works (legacy actions may rely on this), but the user gets a heads-up
                that the action will be a no-op. */}
            {(() => {
              const parsedSecs = parseFloat(timeout);
              const effectiveSecs = isNaN(parsedSecs) ? 0 : parsedSecs;
              const hasNoTrigger = !key.trim() && effectiveSecs <= 0;
              if (!hasNoTrigger) return null;
              return (
                <div
                  className="flex items-start gap-2 px-3 py-2 rounded border text-[11px]"
                  style={{
                    color: 'var(--color-delay)',
                    borderColor: 'color-mix(in srgb, var(--color-delay) 35%, transparent)',
                    backgroundColor: 'color-mix(in srgb, var(--color-delay) 10%, transparent)',
                  }}
                >
                  <ShieldAlert size={13} className="shrink-0 mt-px" />
                  <span>
                    No resume hotkey and no timeout — this Pause will be skipped at replay time.
                  </span>
                </div>
              );
            })()}
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

            {/* #1 — Text Match — alternative to CSS selector for Click/RightClick/Wait.
                Hidden for BrowserType, BrowserNavigate, and BrowserSelectOption (which uses
                its own "OPTION" field below for the value to match inside the <select>). */}
            {!isBrowserNavigate && !isBrowserType && !isBrowserSelect && (
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
                  placeholder={textMode === 'regex' ? 'e.g. ^Sign in$' : 'e.g. Sign in'}
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

            {/* Text — only for BrowserType. Uses the same Lexical-based editor as the
                SendText dialog so tokens (`{Enter}`, `{Clipboard}`, etc.) render as
                inline chips directly inside the input — no separate preview row needed.
                Chip buttons below insert at the cursor via the imperative handle. */}
            {isBrowserType && (
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TEXT TO TYPE</label>
              <div className="min-h-8 bg-bg-input border border-border-default rounded focus-within:border-accent-solid text-ui font-mono">
                <LexicalTokenEditor
                  /* Key by actionIndex so opening a different action re-initialises the
                     editor with that action's text. Without this the Lexical state
                     would persist across action switches and the displayed content
                     wouldn't match the action's browserText. */
                  key={actionIndex ?? -1}
                  initialText={browserText}
                  onChange={setBrowserText}
                  apiRef={browserTextEditorRef}
                />
              </div>
              {/* Data placeholders — replaced with values before typing. Names match the
                  SendText dialog's chip palette so users don't have to learn two vocabularies.
                  insertText() drops the token at the cursor inside the Lexical editor; the
                  TokenAutoTransformPlugin immediately converts it into a chip. Gold hover
                  is shared across every chip button (data + action + arrows) so the palette
                  reads as one cohesive control instead of three different categories. */}
              <div className="flex flex-wrap gap-1 mt-2">
                {[
                  { var: '{Clipboard}', label: 'Clipboard' },
                  { var: '{Date}', label: 'Date' },
                  { var: '{Time}', label: 'Time' },
                  { var: '{DateTime}', label: 'DateTime' },
                ].map(item => (
                  <button
                    key={item.var}
                    type="button"
                    onClick={() => browserTextEditorRef.current?.insertText(item.var)}
                    className="px-2 py-0.5 text-[11px] font-mono bg-bg-surface border border-border-subtle rounded text-text-secondary hover:text-[#FFC107] hover:border-[#FFC107]/40 transition-colors"
                    title={`Inserts the ${item.label.toLowerCase()} value at this position`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {/* Action keys — dispatched as keydown/keyup at this position. Full words to
                  match the SendText vocabulary. Set is what the extension's BrowserType
                  command actually supports (enter / tab / escape / backspace / delete /
                  up / down / left / right). */}
              <div className="flex flex-wrap gap-1 mt-1">
                {[
                  { var: '{Enter}', label: 'Enter' },
                  { var: '{Tab}', label: 'Tab' },
                  { var: '{Escape}', label: 'Escape' },
                  { var: '{Backspace}', label: 'Backspace' },
                  { var: '{Delete}', label: 'Delete' },
                ].map(item => (
                  <button
                    key={item.var}
                    type="button"
                    onClick={() => browserTextEditorRef.current?.insertText(item.var)}
                    className="px-2 py-0.5 text-[11px] font-mono bg-bg-surface border border-border-subtle rounded text-text-secondary hover:text-[#FFC107] hover:border-[#FFC107]/40 transition-colors"
                    title={`Press ${item.label} key at this position`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {/* Arrow keys — second row so the chip set doesn't sprawl. The extension
                  supports them; useful for inputs that respond to arrow navigation
                  (sliders, listboxes, date pickers). */}
              <div className="flex flex-wrap gap-1 mt-1">
                {[
                  { var: '{Up}', label: 'Up' },
                  { var: '{Down}', label: 'Down' },
                  { var: '{Left}', label: 'Left' },
                  { var: '{Right}', label: 'Right' },
                ].map(item => (
                  <button
                    key={item.var}
                    type="button"
                    onClick={() => browserTextEditorRef.current?.insertText(item.var)}
                    className="px-2 py-0.5 text-[11px] font-mono bg-bg-surface border border-border-subtle rounded text-text-secondary hover:text-[#FFC107] hover:border-[#FFC107]/40 transition-colors"
                    title={`Press ${item.label} arrow key at this position`}
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
                label="Keep existing text"
                title="Add the new text to the end of whatever is already in the field. When unchecked (default), the field is cleared before typing."
              />
              <Checkbox
                checked={typePaste}
                onChange={setTypePaste}
                label="Paste"
                title="Use clipboard paste (instant) instead of typing char-by-char"
              />
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-text-tertiary" title="Delay between characters in ms (typing only). 0 = instant, blank = auto.">Char delay (ms)</label>
                <NumberInput
                  // typeDelay '' = "auto" (engine picks a default per text length). Pass
                  // null so the placeholder shows; user clearing the field via onClear
                  // restores the auto state.
                  value={typeDelay === '' ? null : (Number.isFinite(parseInt(typeDelay, 10)) ? parseInt(typeDelay, 10) : null)}
                  onChange={(n) => setTypeDelay(String(n))}
                  onClear={() => setTypeDelay('')}
                  min={0}
                  disabled={typePaste}
                  placeholder="auto"
                  inputWidth="w-14"
                  inputHeight="h-7"
                  ariaLabel="Char delay (ms)"
                />
              </div>
            </div>
            )}

            {/* Select Option — for BrowserSelectOption only. The OPTION field reuses the
                shared `browserText` state (saved as action.BrowserText on disk); the MATCH BY
                dropdown picks how the extension interprets that value when looking for an
                option inside the <select>. */}
            {isBrowserSelect && (
            <>
              <div>
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">OPTION</label>
                <input
                  type="text"
                  value={browserText}
                  onChange={(e) => setBrowserText(e.target.value)}
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                  placeholder={selectMatchMode === 'index' ? '0' : selectMatchMode === 'value' ? 'option-value' : 'Option label'}
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">MATCH BY</label>
                <select
                  value={selectMatchMode}
                  onChange={(e) => setSelectMatchMode(e.target.value as 'text' | 'value' | 'index')}
                  className="w-full h-8 px-2 text-ui bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                >
                  <option value="text">Text (visible label, default)</option>
                  <option value="value">Value (option's value attribute)</option>
                  <option value="index">Index (0-based)</option>
                </select>
                <div className="text-[10px] text-text-tertiary mt-1 leading-tight">
                  Only works on native &lt;select&gt; elements. For React-Select / Select2 use BrowserClick.
                </div>
              </div>
            </>
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
              {/* Foot-gun warning: text-match mode needs an actual Text Match string.
                  Without it, the effective selector falls back to the raw CSS key
                  (handleSave / handleTestAction both call buildTextSelector only when
                  textMatch is non-empty) — extension then receives waitMode='text-match'
                  on a plain selector and the action times out silently. */}
              {waitMode === 'text-match' && !textMatch.trim() && (
                <div
                  className="mt-1.5 flex items-start gap-2 px-3 py-2 rounded border text-[11px]"
                  style={{
                    color: 'var(--color-delay)',
                    borderColor: 'color-mix(in srgb, var(--color-delay) 35%, transparent)',
                    backgroundColor: 'color-mix(in srgb, var(--color-delay) 10%, transparent)',
                  }}
                >
                  <ShieldAlert size={13} className="shrink-0 mt-px" />
                  <span>Text-match mode needs a value in the Text Match field. Otherwise this Wait will time out.</span>
                </div>
              )}
            </div>
            )}

            {/* Timeout — every browser action. The engine reads action.Timeout for all
                five command types (ActionExecution.cs in the Browser switch arm), so the
                editor should expose it consistently. Previously BrowserType was the only
                one hidden, silently locking it to the 5 s default. */}
            {(isBrowserWait || actionType === 'BrowserClick' || actionType === 'BrowserRightClick' || isBrowserType || isBrowserNavigate || isBrowserSelect) && (
            <div className="w-1/2">
              <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">TIMEOUT (s)</label>
              <NumberInput
                value={parseInt(timeout, 10) || 1}
                onChange={(n) => setTimeout_(String(n))}
                min={1}
                inputWidth="w-full"
                inputHeight="h-8"
                ariaLabel="Timeout in seconds"
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
                ref={keyFieldRef}
                type="text"
                readOnly
                value={keyFieldFocused ? '' : getDisplayKey(key)}
                onFocus={() => { setKeyFieldFocused(true); armKeyCaptureTimer(); }}
                onBlur={() => { setKeyFieldFocused(false); disarmKeyCaptureTimer(); }}
                onKeyDown={handleKeyCapture}
                placeholder="Click to capture…"
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
                {/* x === '' means "no override" — the action keeps its recorded coord.
                    Pass null so the "—" placeholder shows instead of "0" which would be
                    a legitimate top-left coordinate but is here ambiguous with unset. */}
                <NumberInput
                  value={x === '' ? null : (Number.isFinite(parseInt(x, 10)) ? parseInt(x, 10) : null)}
                  onChange={(n) => setX(String(n))}
                  onClear={() => setX('')}
                  placeholder="—"
                  inputWidth="w-full"
                  inputHeight="h-8"
                  ariaLabel="X coordinate"
                />
              </div>
              <div className="flex-1">
                <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">Y</label>
                <NumberInput
                  value={y === '' ? null : (Number.isFinite(parseInt(y, 10)) ? parseInt(y, 10) : null)}
                  onChange={(n) => setY(String(n))}
                  onClear={() => setY('')}
                  placeholder="—"
                  inputWidth="w-full"
                  inputHeight="h-8"
                  ariaLabel="Y coordinate"
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

          {/* Delay — hidden for conditional structural rows. IF rows don't have a
              meaningful "delay AFTER" (the probe is instant and the branch is taken
              before the next action fires its own delay); Else/EndIf are pure markers
              the engine walks past with zero work. Keeping the field would just invite
              users to set a value that gets silently ignored. */}
          {!isConditional && (
          <div>
            <label className="block text-[11px] font-semibold text-text-tertiary mb-1.5">DELAY (ms)</label>
            <NumberInput
              value={parseInt(delay, 10) || 0}
              onChange={(n) => setDelay(String(n))}
              min={0}
              inputWidth="w-full"
              inputHeight="h-8"
              ariaLabel="Delay in milliseconds"
            />
          </div>
          )}

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
