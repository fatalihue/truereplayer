import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, RefreshCw, Crosshair, Copy, ClipboardPaste, ShieldCheck, ShieldAlert, ShieldQuestion, PlayCircle, Pipette, Check, X, Frame, FolderOpen } from 'lucide-react';
import { ActionIcon } from './ActionTable';
import { useBridge } from '../bridge/BridgeContext';
import { useAppState } from '../state/AppStateContext';
import { useTt } from '../state/LanguageContext';
import type { SelectorAlternative, BrowserTestResult } from '../bridge/messageTypes';
import { Checkbox } from './Checkbox';
import { NumberInput } from './common/NumberInput';
import { SegmentedControl } from './common/SegmentedControl';
import { DurationChips } from './common/DurationChips';
import { ImageCropper } from './ImageCropper';
import { LexicalTokenEditor, type LexicalEditorHandle } from './lexical/LexicalTokenEditor';
import { getDisplayKey } from '../utils/displayUtils';
import { Field } from './sheet/Field';
import { Slider } from './sheet/Slider';

interface SheetPanelProps {
  actionIndex: number | null;
  onClose: () => void;
  /** Exit choreography (owned by App): while true the panel plays its slide-out,
   *  then calls onExited so the parent can finally null the index. */
  leaving?: boolean;
  onExited?: () => void;
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
    { value: 'DoubleClick', label: 'Double Click' },
    { value: 'RightClick', label: 'Right Click' },
    { value: 'MiddleClick', label: 'Middle Click' },
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

const noCoordTypes = new Set(['KeyDown', 'KeyUp', 'Keystroke', 'HoldKey', 'RunProfile', 'ScrollUp', 'ScrollDown', 'SendText', 'SetVariable', 'ActivateWindow', 'WaitImage', 'WaitPixelColor', 'BrowserClick', 'BrowserRightClick', 'BrowserType', 'BrowserWaitElement', 'BrowserNavigate', 'BrowserSelectOption', 'BrowserAssert', 'Pause', 'If', 'Else', 'EndIf']);

// Semantic result-card colouring via theme tokens — success = replay green, failure/error =
// recording red. Matches the inline-style pattern the foot-gun cards already use, so no
// hardcoded hex (the app has 40+ themes). Pure, so it lives at module scope.
function resultCardStyle(ok: boolean) {
  const c = ok ? 'var(--color-replay)' : 'var(--color-recording)';
  return {
    color: c,
    borderColor: `color-mix(in srgb, ${c} 40%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${c} 10%, transparent)`,
  };
}

// #1 — Text matching modes mapped to selector prefixes
type TextMode = 'exact' | 'contains' | 'icontains' | 'regex';
const TEXT_MODES: { value: TextMode; label: string; prefix: string }[] = [
  { value: 'exact',     label: 'Exact',         prefix: 'text=' },
  { value: 'contains',  label: 'Contains',      prefix: 'text*=' },
  { value: 'icontains', label: 'Contains (i)',  prefix: 'text~=' },
  { value: 'regex',     label: 'Regex',         prefix: 'text/' },
];

// The action types whose Key is a browser SELECTOR (and may carry a text= prefix).
// Everything else — notably SendText, whose payload can legitimately START with
// "text=..." or "text/..." — must never be parsed/rebuilt as a selector: the regex
// rebuild is lossy, so an unrelated save would rewrite Key (and null a fresh KeyHtml).
function isBrowserSelectorAction(actionType: string, conditionType?: string | null): boolean {
  return actionType === 'BrowserClick' || actionType === 'BrowserRightClick'
    || actionType === 'BrowserType' || actionType === 'BrowserWaitElement'
    || actionType === 'BrowserSelectOption' || actionType === 'BrowserAssert'
    || (actionType === 'If' && conditionType === 'BrowserElementState');
}

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

// Theme tokens only (S=replay green, A=accent, B=warning, C=recording red) — the old
// hardcoded hexes broke on light themes. labelPtBr feeds the bilingual shield tip.
const TIER_META: Record<'S' | 'A' | 'B' | 'C', { color: string; label: string; labelPtBr: string; Icon: typeof ShieldCheck }> = {
  S: { color: 'var(--color-replay)', label: 'Stable', labelPtBr: 'Estável', Icon: ShieldCheck },
  A: { color: 'var(--color-accent)', label: 'Strong', labelPtBr: 'Forte', Icon: ShieldCheck },
  B: { color: 'var(--color-warning)', label: 'Decent', labelPtBr: 'Razoável', Icon: ShieldQuestion },
  C: { color: 'var(--color-recording)', label: 'Fragile', labelPtBr: 'Frágil', Icon: ShieldAlert },
};


export function SheetPanel({ actionIndex, onClose, leaving = false, onExited }: SheetPanelProps) {
  const { actions, profiles, activeProfile } = useAppState();
  const { send, subscribe } = useBridge();
  const tt = useTt();

  // Exit fallback — mirrors DialogShell: if the slide-out's animationend never
  // fires (occluded window pauses CSS animations), unstick the unmount.
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => onExited?.(), 500);
    return () => clearTimeout(t);
  }, [leaving, onExited]);

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
  // SetVariable — the value half of "name = value"; the name reuses the `key` state.
  const [variableValue, setVariableValue] = useState('');
  // SetVariable mode: 'set' (default) | 'cycle' (value = list, next line per execution).
  const [variableMode, setVariableMode] = useState<'set' | 'cycle'>('set');
  // Imperative handle to the Lexical-based BrowserType editor — used by the chip
  // buttons to insertText at the current cursor position instead of always appending.
  const browserTextEditorRef = useRef<LexicalEditorHandle | null>(null);
  const [textMatch, setTextMatch] = useState('');
  const [textMode, setTextMode] = useState<TextMode>('exact');
  const [newTab, setNewTab] = useState(false);
  const [isPicking, setIsPicking] = useState(false);

  // #6, #7, #5 — new browser fields
  // Rare-key chips (Escape/Backspace/Delete/arrows) live behind a "⋯" expander so the
  // default palette stays at the two rows users actually reach for. Ephemeral on
  // purpose — collapses again when the panel remounts for another action.
  const [showMoreTypeChips, setShowMoreTypeChips] = useState(false);
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
  // If Window (WindowOpen) probe fields
  const [windowProcessName, setWindowProcessName] = useState('');
  const [windowTitle, setWindowTitle] = useState('');
  const [windowTitleMatchMode, setWindowTitleMatchMode] = useState<'contains' | 'regex'>('contains');
  const [windowMatchForegroundOnly, setWindowMatchForegroundOnly] = useState(false);
  // If Clipboard (ClipboardMatch) probe fields
  const [clipboardPatternType, setClipboardPatternType] = useState<'contains' | 'equals' | 'regex'>('contains');
  const [clipboardPattern, setClipboardPattern] = useState('');
  // If Random / Variable / File / Time probe fields
  const [randomPercent, setRandomPercent] = useState('50');
  const [conditionOperator, setConditionOperator] = useState<'eq' | 'neq' | 'contains' | 'gt' | 'lt'>('eq');
  const [conditionOperand, setConditionOperand] = useState('');
  const [filePath, setFilePath] = useState('');
  const [timeStart, setTimeStart] = useState('');
  const [timeEnd, setTimeEnd] = useState('');
  const [daysOfWeek, setDaysOfWeek] = useState(0); // bitmask Sun=1<<0 … Sat=1<<6
  // ActivateWindow — launch fields + failure policy. The window MATCHER reuses the
  // If-Window state trio above (windowProcessName / windowTitle / windowTitleMatchMode).
  const [launchPath, setLaunchPath] = useState('');
  const [launchArgs, setLaunchArgs] = useState('');
  const [activateOnTimeout, setActivateOnTimeout] = useState<'Halt' | 'Continue'>('Halt');
  // ActivateWindow placement: move/resize the activated window to a saved rect. Purely
  // positional — coordinate context is untouched (sub-profile + RunProfile covers that).
  // String-backed like the other numeric fields so an input can be cleared while typing.
  const [restorePosition, setRestorePosition] = useState(false);
  const [restoreSize, setRestoreSize] = useState(false);
  const [windowX, setWindowX] = useState('0');
  const [windowY, setWindowY] = useState('0');
  const [windowWidth, setWindowWidth] = useState('0');
  const [windowHeight, setWindowHeight] = useState('0');
  const [captureGeoRequestId, setCaptureGeoRequestId] = useState<string | null>(null);
  const [captureGeoError, setCaptureGeoError] = useState<string | null>(null);
  // BrowserAssert failure policy (selector/waitMode/browserText/timeout reuse the shared
  // browser state above).
  const [assertOnFail, setAssertOnFail] = useState<'Halt' | 'Continue'>('Halt');
  // Exists-anywhere Test probe tracking — same requestId-gating pattern as the browser
  // Test Action (the reply is gated on the id so a stale reply can't land elsewhere).
  const [windowProbeRequestId, setWindowProbeRequestId] = useState<string | null>(null);
  const [windowProbeResult, setWindowProbeResult] = useState<{ found: boolean; matchProcess: string; matchTitle: string; error?: string } | null>(null);
  // Optional "wait up to N ms for the condition" poll timeout (0 = instant single check). Stored as
  // a string so the input can be cleared; coerced to a non-negative int on persist.
  const [conditionTimeout, setConditionTimeout] = useState('0');

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

  // Browser element pick — gates 'browser:pickResult' so a reply arriving after the user
  // switched/closed actions (the panel doesn't remount) can't write the selector into the
  // wrong action. Mirrors pickPositionRequestId / pickColorRequestId. `isPicking` stays the
  // button's visual flag; this id is the correctness gate.
  const [pickElementRequestId, setPickElementRequestId] = useState<string | null>(null);

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

  // Latest-value refs for the in-flight request ids, so the bridge subscription below can be a
  // stable one-time subscription instead of re-subscribing on every requestId change — a churn
  // that could drop a bridge response arriving in the unsubscribed gap (Test/Pick stuck "…").
  const testRequestIdRef = useRef(testRequestId);
  const testMatchRequestIdRef = useRef(testMatchRequestId);
  const pickPositionRequestIdRef = useRef(pickPositionRequestId);
  const pickColorRequestIdRef = useRef(pickColorRequestId);
  const testPixelRequestIdRef = useRef(testPixelRequestId);
  const pickElementRequestIdRef = useRef(pickElementRequestId);
  const windowProbeRequestIdRef = useRef(windowProbeRequestId);
  // Correlates a dialog:pickFile round-trip (ActivateWindow Launch "Browse…") to its result.
  const browseLaunchReqRef = useRef<string | null>(null);
  // Correlates a window:captureGeometry round-trip (ActivateWindow "Capture") to its result.
  const captureGeoReqRef = useRef<string | null>(null);
  // Configure-region is fire-and-forget (no UI state), so a plain ref tracks the in-flight
  // request and guards waitimage:searchRegionSet against a stale reply landing on a different
  // action after the user switched (the panel doesn't remount on action change).
  const searchRegionRequestIdRef = useRef<string | null>(null);
  useEffect(() => {
    testRequestIdRef.current = testRequestId;
    testMatchRequestIdRef.current = testMatchRequestId;
    pickPositionRequestIdRef.current = pickPositionRequestId;
    pickColorRequestIdRef.current = pickColorRequestId;
    testPixelRequestIdRef.current = testPixelRequestId;
    pickElementRequestIdRef.current = pickElementRequestId;
    windowProbeRequestIdRef.current = windowProbeRequestId;
  });

  // Listen for pick element result + test result from extension. Subscribed once (stable deps);
  // current request ids are read from the refs above so this never tears down mid-flight.
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'browser:pickResult') {
        const payload = msg.payload as { requestId?: string; selector?: string | null; alternatives?: SelectorAlternative[] };
        // Gate on the request id we started with. A reply whose id doesn't match (the user
        // switched/closed the action, or cancelled via Esc) is stale — drop it so it can't
        // overwrite the now-current action's selector. Matches the pickPosition/pickColor guards.
        if (!pickElementRequestIdRef.current || payload.requestId !== pickElementRequestIdRef.current) return;
        setIsPicking(false);
        setPickElementRequestId(null);
        if (payload.selector) {
          setKey(payload.selector);
          // A fresh pick fully re-specifies the target element, so clear any text-match mode
          // seeded from a prior text= selector — otherwise the textMatch-precedence at display/
          // save time (`textMatch.trim() ? buildTextSelector(...) : key`) would silently override
          // the picked selector. Most visible on the If-Browser editor, where key and textMatch
          // share ONE field so the discarded pick vanishes with no feedback.
          setTextMatch('');
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
        if (testRequestIdRef.current && r.requestId === testRequestIdRef.current) {
          clearTestTimeout();
          setTestResult(r);
          setTestRequestId(null);
        }
      } else if (msg.type === 'image:testMatchResult') {
        const r = msg.payload as { requestId: string; found: boolean; score: number; x: number; y: number; w: number; h: number; error?: string };
        if (testMatchRequestIdRef.current && r.requestId === testMatchRequestIdRef.current) {
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
        // Guard against a stale reply: only apply when it matches the configure-region request
        // we last initiated. The panel doesn't remount when the user switches actions, so a late
        // reply could otherwise overwrite a different action's search region.
        if (searchRegionRequestIdRef.current && r.requestId === searchRegionRequestIdRef.current) {
          searchRegionRequestIdRef.current = null;
          if (!r.cancelled && r.w && r.h && r.w > 0 && r.h > 0) {
            setWaitImageSearchRegion({ x: r.x ?? 0, y: r.y ?? 0, w: r.w, h: r.h });
          }
        }
      } else if (msg.type === 'mouse:positionPicked') {
        const r = msg.payload as { requestId: string; cancelled: boolean; x?: number; y?: number };
        if (pickPositionRequestIdRef.current && r.requestId === pickPositionRequestIdRef.current) {
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
        if (pickColorRequestIdRef.current && r.requestId === pickColorRequestIdRef.current) {
          if (!r.cancelled && r.x != null && r.y != null && r.hex) {
            setPixelX(String(r.x));
            setPixelY(String(r.y));
            setPixelColor(r.hex);
          }
          setPickColorRequestId(null);
        }
      } else if (msg.type === 'pixel:testMatchResult') {
        const r = msg.payload as { requestId: string; matches: boolean; sampledHex?: string | null; error?: string };
        if (testPixelRequestIdRef.current && r.requestId === testPixelRequestIdRef.current) {
          setTestPixelResult({ matches: r.matches, sampledHex: r.sampledHex, error: r.error });
          setTestPixelRequestId(null);
        }
      } else if (msg.type === 'window:testProbeResult') {
        const r = msg.payload as { requestId: string; found: boolean; matchProcess: string; matchTitle: string; error?: string };
        if (windowProbeRequestIdRef.current && r.requestId === windowProbeRequestIdRef.current) {
          setWindowProbeResult({ found: r.found, matchProcess: r.matchProcess, matchTitle: r.matchTitle, error: r.error });
          setWindowProbeRequestId(null);
        }
      } else if (msg.type === 'dialog:pickFileResult') {
        const r = msg.payload as { requestId: string; path?: string | null };
        if (browseLaunchReqRef.current && r.requestId === browseLaunchReqRef.current) {
          browseLaunchReqRef.current = null;
          if (r.path) setLaunchPath(r.path);
        }
      } else if (msg.type === 'window:captureGeometryResult') {
        const r = msg.payload as { requestId: string; found: boolean; x: number; y: number; width: number; height: number; error?: string };
        if (captureGeoReqRef.current && r.requestId === captureGeoReqRef.current) {
          captureGeoReqRef.current = null;
          setCaptureGeoRequestId(null);
          if (r.found) {
            setWindowX(String(r.x));
            setWindowY(String(r.y));
            setWindowWidth(String(r.width));
            setWindowHeight(String(r.height));
            setCaptureGeoError(null);
          } else {
            setCaptureGeoError(r.error || 'Could not read the window.');
          }
        }
      }
    });
  }, [subscribe, clearTestTimeout, clearTestMatchTimeout]);

  // Sync local state from action. This is intentionally an effect-driven seed: keeping
  // local state lets the user edit freely before saving, while the dependency on `action`
  // means external changes (undo/redo, sibling-action updates) still flow into the panel
  // even when it stays open. A key-based remount would lose that liveness.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (action) {
      setActionType(action.actionType);
      // #1 — Detect any text= prefix variant and split into mode + raw value.
      // Gated on selector-carrying types: a SendText payload starting with "text=" is
      // literal text, not a selector (parsing it would corrupt Key on the next save).
      const parsed = isBrowserSelectorAction(action.actionType, action.conditionType)
        ? parseTextSelector(action.key || '')
        : { mode: null, raw: '' };
      if (parsed.mode) {
        setKey('');
        setTextMatch(parsed.raw);
        setTextMode(parsed.mode);
      } else {
        setKey(action.key);
        setTextMatch('');
        setTextMode('exact');
      }
      // `?? ''` (not `|| ''`) so an explicit coordinate of 0 seeds as "0" rather than
      // collapsing to empty — empty means "no override" (skipped on save), 0 is a real value.
      setX(String(action.x ?? ''));
      setY(String(action.y ?? ''));
      setDelay(String(action.delay));
      setComment(action.comment || '');
      // Timeout edited in milliseconds (matches the grid + dialogs). Pause defaults
      // to 0 (infinite); other actions default to 5000ms.
      setTimeout_(action.actionType === 'Pause'
        ? String(action.timeout ?? 0)
        : String(action.timeout || 5000));
      setConfidence(String(Math.round((action.confidence || 0.8) * 100)));
      setBrowserText(action.browserText || '');
      setVariableValue(action.variableValue ?? '');
      setVariableMode(action.variableMode === 'cycle' ? 'cycle' : 'set');
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
      setConditionTimeout(String(action.conditionTimeout ?? 0));
      // If Window / If Clipboard probe seeding — null/undefined collapse to the defaults.
      setWindowProcessName(action.windowProcessName ?? '');
      setWindowTitle(action.windowTitle ?? '');
      setWindowTitleMatchMode(action.windowTitleMatchMode === 'regex' ? 'regex' : 'contains');
      setWindowMatchForegroundOnly(action.windowMatchForegroundOnly || false);
      setClipboardPatternType(
        action.clipboardPatternType === 'equals' ? 'equals'
          : action.clipboardPatternType === 'regex' ? 'regex'
          : 'contains'
      );
      setClipboardPattern(action.clipboardPattern ?? '');
      // If Random / Variable / File / Time seeding.
      setRandomPercent(String(action.randomPercent ?? 50));
      setConditionOperator(
        action.conditionOperator === 'neq' ? 'neq'
          : action.conditionOperator === 'contains' ? 'contains'
          : action.conditionOperator === 'gt' ? 'gt'
          : action.conditionOperator === 'lt' ? 'lt'
          : 'eq'
      );
      setConditionOperand(action.conditionOperand ?? '');
      setFilePath(action.filePath ?? '');
      setTimeStart(action.timeStart ?? '');
      setTimeEnd(action.timeEnd ?? '');
      setDaysOfWeek(action.daysOfWeek ?? 0);
      // ActivateWindow seeding — the matcher trio is seeded by the If-Window block above.
      setLaunchPath(action.launchPath ?? '');
      setLaunchArgs(action.launchArgs ?? '');
      setActivateOnTimeout(action.activateOnTimeout === 'Continue' ? 'Continue' : 'Halt');
      setRestorePosition(!!action.restorePosition);
      setRestoreSize(!!action.restoreSize);
      setWindowX(String(action.windowX ?? 0));
      setWindowY(String(action.windowY ?? 0));
      setWindowWidth(String(action.windowWidth ?? 0));
      setWindowHeight(String(action.windowHeight ?? 0));
      setCaptureGeoError(null);
      setCaptureGeoRequestId(null);
      setAssertOnFail(action.assertOnFail === 'Continue' ? 'Continue' : 'Halt');
      setWindowProbeResult(null);
      setWindowProbeRequestId(null);
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

    // Selector-fallback persistence (browser element actions). A pick during THIS edit
    // session populates `alternatives` — persist the full ranked list so replay can fall
    // back tier B→C when the primary drifts. A manual selector edit with NO fresh pick
    // invalidates any stored list (it may point at a different element) — clear it.
    const isBrowserElementAction = isBrowserSelectorAction(actionType, action.conditionType);
    if (isBrowserElementAction) {
      if (alternatives.length > 1) {
        const nextJson = JSON.stringify(alternatives);
        if (nextJson !== JSON.stringify(action.selectorAlternatives ?? null)) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'selectorAlternatives', value: nextJson } });
        }
      } else if (effectiveKey !== action.key && (action.selectorAlternatives?.length ?? 0) > 0) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'selectorAlternatives', value: '' } });
      }
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
        const newTimeoutMs = Math.max(1000, parseFloat(timeout) || 5000);
        if (newTimeoutMs !== (action.timeout || 5000)) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'timeout', value: String(Math.round(newTimeoutMs)) } });
        }
      }
      const newConfidence = Math.min(100, Math.max(10, parseInt(confidence, 10) || 80)) / 100;
      // Compare with a tolerance below the 1% input granularity (0.01): the editor only exposes
      // integer-percent values, so any real edit differs by >= 0.01, while float-precision noise
      // from the seed round-trip (action.confidence * 100 -> round -> / 100) stays under 0.005.
      // Strict !== here re-saved an unchanged value whenever the stored fraction wasn't exactly
      // representable at 2 decimals (e.g. 0.8500001), bumping the undo stack for a no-op.
      if (Math.abs(newConfidence - (action.confidence || 0.8)) > 0.005) {
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
        const newTimeoutMs = Math.max(1000, parseFloat(timeout) || 5000);
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
      const ctVal = Math.max(0, parseInt(conditionTimeout, 10) || 0);
      if (ctVal !== (action.conditionTimeout ?? 0)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'conditionTimeout', value: String(ctVal) } });
      }
      const persistedErr = ifOnProbeError === 'Halt' ? 'Halt' : '';
      const currentErr = action.ifOnProbeError === 'Halt' ? 'Halt' : '';
      if (persistedErr !== currentErr) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'ifOnProbeError', value: persistedErr } });
      }

      // If Window probe fields — only meaningful on a WindowOpen row, but gating on the
      // stored conditionType keeps a stale state write from landing on other IF families.
      if (action.conditionType === 'WindowOpen') {
        if (windowProcessName !== (action.windowProcessName ?? '')) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'windowProcessName', value: windowProcessName } });
        }
        if (windowTitle !== (action.windowTitle ?? '')) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'windowTitle', value: windowTitle } });
        }
        const currentTitleMode = action.windowTitleMatchMode === 'regex' ? 'regex' : 'contains';
        if (windowTitleMatchMode !== currentTitleMode) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'windowTitleMatchMode', value: windowTitleMatchMode } });
        }
        if (!!windowMatchForegroundOnly !== !!(action.windowMatchForegroundOnly)) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'windowMatchForegroundOnly', value: String(windowMatchForegroundOnly) } });
        }
      }

      // If Browser Element probe fields — key (selector) is saved by the generic
      // effectiveKey block above; here the state mode + text pattern.
      if (action.conditionType === 'BrowserElementState') {
        const persistedIfMode = (waitMode === 'appears') ? '' : waitMode; // empty = default
        if ((persistedIfMode || '') !== (action.waitMode || '')) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'waitMode', value: persistedIfMode } });
        }
        if (browserText !== (action.browserText || '')) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'browserText', value: browserText } });
        }
      }

      // If Clipboard probe fields — same conditionType gating.
      if (action.conditionType === 'ClipboardMatch') {
        const currentPatternType = action.clipboardPatternType === 'equals' ? 'equals'
          : action.clipboardPatternType === 'regex' ? 'regex'
          : 'contains';
        if (clipboardPatternType !== currentPatternType) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'clipboardPatternType', value: clipboardPatternType } });
        }
        if (clipboardPattern !== (action.clipboardPattern ?? '')) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'clipboardPattern', value: clipboardPattern } });
        }
      }

      // If Random — a single percent.
      if (action.conditionType === 'Random') {
        const pct = Math.max(0, Math.min(100, parseInt(randomPercent, 10) || 0));
        if (pct !== (action.randomPercent ?? 0)) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'randomPercent', value: String(pct) } });
        }
      }

      // If Variable — the variable NAME is in `key` (saved by the generic effectiveKey block
      // above); here the operator + operand.
      if (action.conditionType === 'Variable') {
        const currentOp = action.conditionOperator ?? 'eq';
        if (conditionOperator !== currentOp) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'conditionOperator', value: conditionOperator } });
        }
        if (conditionOperand !== (action.conditionOperand ?? '')) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'conditionOperand', value: conditionOperand } });
        }
      }

      // If Process — the process name reuses windowProcessName (saved by the If-Window block
      // above, which is gated on WindowOpen). Save it here for the ProcessRunning family too.
      if (action.conditionType === 'ProcessRunning') {
        if (windowProcessName !== (action.windowProcessName ?? '')) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'windowProcessName', value: windowProcessName } });
        }
      }

      // If File — the path.
      if (action.conditionType === 'FileExists') {
        if (filePath !== (action.filePath ?? '')) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'filePath', value: filePath } });
        }
      }

      // If Time — window + day bitmask.
      if (action.conditionType === 'TimeWindow') {
        if (timeStart !== (action.timeStart ?? '')) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'timeStart', value: timeStart } });
        }
        if (timeEnd !== (action.timeEnd ?? '')) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'timeEnd', value: timeEnd } });
        }
        if (daysOfWeek !== (action.daysOfWeek ?? 0)) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: 'daysOfWeek', value: String(daysOfWeek) } });
        }
      }
    }

    // Pause-specific fields: timeout in milliseconds. Hotkey shares the `key` field with other
    // action types (already saved above by the generic key-equality check). Default ms=0 = infinite.
    if (actionType === 'Pause') {
      const parsedMs = parseFloat(timeout);
      const newTimeoutMs = isNaN(parsedMs) || parsedMs < 0 ? 0 : Math.round(parsedMs);
      if (newTimeoutMs !== (action.timeout || 0)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'timeout', value: String(newTimeoutMs) } });
      }
    }

    // Browser-specific fields
    if (actionType === 'BrowserType' && browserText !== (action.browserText || '')) {
      send({ type: 'actions:edit', payload: { index: actionIndex, field: 'browserText', value: browserText } });
    }
    // Timeout persists for EVERY browser command — the engine honours action.Timeout for all
    // six types (ActionExecution.cs Browser switch arm). Previously only Wait/Click/RightClick
    // saved it, so edits on Type/Navigate/SelectOption were silently dropped even though the
    // Timeout field is shown for them.
    if (actionType.startsWith('Browser')) {
      const newTimeoutMs = Math.max(1000, parseFloat(timeout) || 5000);
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

    // BrowserAssert — mirrors WaitElement: selector saved by the generic effectiveKey block
    // above (text-match packs the pattern into a text= selector via textMatch), waitMode
    // here, plus the fail policy.
    if (actionType === 'BrowserAssert') {
      const persistedMode = (waitMode === 'appears') ? '' : waitMode;
      if ((persistedMode || '') !== (action.waitMode || '')) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'waitMode', value: persistedMode } });
      }
      const persistedPolicy = assertOnFail === 'Continue' ? 'Continue' : '';
      const currentPolicy = action.assertOnFail === 'Continue' ? 'Continue' : '';
      if (persistedPolicy !== currentPolicy) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'assertOnFail', value: persistedPolicy } });
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

    // SetVariable — the value half of "name = value"; the NAME (key state) is already
    // saved by the generic effectiveKey block above.
    if (actionType === 'SetVariable') {
      if (variableValue !== (action.variableValue ?? '')) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'variableValue', value: variableValue } });
      }
      const currentVarMode = action.variableMode === 'cycle' ? 'cycle' : 'set';
      if (variableMode !== currentVarMode) {
        // Backend persists only 'cycle'; 'set' round-trips to null on disk.
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'variableMode', value: variableMode === 'cycle' ? 'cycle' : '' } });
      }
    }

    // ActivateWindow — matcher (shared window* fields, no conditionType gate: the type
    // itself is the discriminator), launch fields, wait budget and failure policy.
    if (actionType === 'ActivateWindow') {
      if (windowProcessName !== (action.windowProcessName ?? '')) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'windowProcessName', value: windowProcessName } });
      }
      if (windowTitle !== (action.windowTitle ?? '')) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'windowTitle', value: windowTitle } });
      }
      const currentAwTitleMode = action.windowTitleMatchMode === 'regex' ? 'regex' : 'contains';
      if (windowTitleMatchMode !== currentAwTitleMode) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'windowTitleMatchMode', value: windowTitleMatchMode } });
      }
      if (launchPath !== (action.launchPath ?? '')) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'launchPath', value: launchPath } });
      }
      if (launchArgs !== (action.launchArgs ?? '')) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'launchArgs', value: launchArgs } });
      }
      const persistedPolicy = activateOnTimeout === 'Continue' ? 'Continue' : '';
      const currentPolicy = action.activateOnTimeout === 'Continue' ? 'Continue' : '';
      if (persistedPolicy !== currentPolicy) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'activateOnTimeout', value: persistedPolicy } });
      }
      // Placement. Any normalization here MUST be mirrored in hasUnsavedChanges (parity).
      if (restorePosition !== !!action.restorePosition) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'restorePosition', value: String(restorePosition) } });
      }
      if (restoreSize !== !!action.restoreSize) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'restoreSize', value: String(restoreSize) } });
      }
      const geoEdits: Array<[string, number, number]> = [
        ['windowX', parseInt(windowX, 10) || 0, action.windowX ?? 0],
        ['windowY', parseInt(windowY, 10) || 0, action.windowY ?? 0],
        ['windowWidth', Math.max(0, parseInt(windowWidth, 10) || 0), action.windowWidth ?? 0],
        ['windowHeight', Math.max(0, parseInt(windowHeight, 10) || 0), action.windowHeight ?? 0],
      ];
      for (const [geoField, next, current] of geoEdits) {
        if (next !== current) {
          send({ type: 'actions:edit', payload: { index: actionIndex, field: geoField, value: String(next) } });
        }
      }
      const newAwTimeout = Math.max(1000, Math.round(parseFloat(timeout) || 10000));
      if (newAwTimeout !== (action.timeout || 5000)) {
        send({ type: 'actions:edit', payload: { index: actionIndex, field: 'timeout', value: String(newAwTimeout) } });
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
  }, [actionIndex, action, actionType, key, textMatch, textMode, x, y, delay, comment, timeout, confidence, browserText, variableValue, variableMode, newTab, waitMode, urlWaitPattern, postNavigateSelector, typeAppend, typePaste, typeDelay, selectMatchMode, waitImageOnTimeout, waitImageInvert, waitImageClickOnMatch, waitImageSearchRegion, pixelX, pixelY, pixelColor, pixelTolerance, pixelOnTimeout, pixelInvert, pixelClickOnMatch, conditionNegate, ifOnProbeError, conditionTimeout, windowProcessName, windowTitle, windowTitleMatchMode, windowMatchForegroundOnly, clipboardPatternType, clipboardPattern, randomPercent, conditionOperator, conditionOperand, filePath, timeStart, timeEnd, daysOfWeek, launchPath, launchArgs, activateOnTimeout, restorePosition, restoreSize, windowX, windowY, windowWidth, windowHeight, assertOnFail, alternatives, send, onClose]);

  // Are there edits the Save-Changes button would persist? MIRRORS handleSave's diffs
  // exactly (same guards/normalisation), returning true on the first field that differs —
  // so it is defined as "handleSave would send at least one actions:edit". Kept additive
  // (handleSave untouched) to keep the save path zero-risk; if a NEW field is ever added
  // to handleSave, mirror it HERE too or a stray Esc will silently drop that field's edit.
  // Powers the dirty-aware Esc guard (a reflexive Esc arms a warning instead of discarding).
  const hasUnsavedChanges = useMemo<boolean>(() => {
    if (actionIndex == null || !action) return false;
    const _isIf = actionType === 'If';
    const _isIfImage = _isIf && action.conditionType === 'ImageFound';
    const _isIfPixel = _isIf && action.conditionType === 'PixelColorMatch';

    if (actionType !== action.actionType) return true;
    const effectiveKey = textMatch.trim() ? buildTextSelector(textMode, textMatch.trim()) : key;
    if (effectiveKey !== action.key) return true;

    const isBrowserElementAction = isBrowserSelectorAction(actionType, action.conditionType);
    if (isBrowserElementAction) {
      if (alternatives.length > 1) {
        if (JSON.stringify(alternatives) !== JSON.stringify(action.selectorAlternatives ?? null)) return true;
      } else if (effectiveKey !== action.key && (action.selectorAlternatives?.length ?? 0) > 0) {
        return true;
      }
    }
    const newX = parseInt(x, 10);
    if (!isNaN(newX) && newX !== action.x) return true;
    const newY = parseInt(y, 10);
    if (!isNaN(newY) && newY !== action.y) return true;
    const newDelay = parseInt(delay, 10);
    if (!isNaN(newDelay) && newDelay !== action.delay) return true;
    if (comment !== (action.comment || '')) return true;

    if (actionType === 'WaitImage' || _isIfImage) {
      if (actionType === 'WaitImage') {
        const newTimeoutMs = Math.max(1000, parseFloat(timeout) || 5000);
        if (newTimeoutMs !== (action.timeout || 5000)) return true;
      }
      const newConfidence = Math.min(100, Math.max(10, parseInt(confidence, 10) || 80)) / 100;
      if (Math.abs(newConfidence - (action.confidence || 0.8)) > 0.005) return true;
      if (actionType === 'WaitImage') {
        const persistedTimeoutMode = waitImageOnTimeout === 'Continue' ? 'Continue' : '';
        const currentTimeoutMode = action.waitImageOnTimeout === 'Continue' ? 'Continue' : '';
        if (persistedTimeoutMode !== currentTimeoutMode) return true;
        if (!!waitImageInvert !== !!(action.waitImageInvert)) return true;
        if (!!waitImageClickOnMatch !== !!(action.waitImageClickOnMatch)) return true;
      }
      const currentRect = (action.waitImageSearchW && action.waitImageSearchH)
        ? `${action.waitImageSearchX || 0},${action.waitImageSearchY || 0},${action.waitImageSearchW},${action.waitImageSearchH}`
        : '';
      const newRect = waitImageSearchRegion
        ? `${waitImageSearchRegion.x},${waitImageSearchRegion.y},${waitImageSearchRegion.w},${waitImageSearchRegion.h}`
        : '';
      if (newRect !== currentRect) return true;
    }

    if (actionType === 'WaitPixelColor' || _isIfPixel) {
      if (actionType === 'WaitPixelColor') {
        const newTimeoutMs = Math.max(1000, parseFloat(timeout) || 5000);
        if (newTimeoutMs !== (action.timeout || 5000)) return true;
      }
      const trimmedX = pixelX.trim();
      const trimmedY = pixelY.trim();
      const parsedX = trimmedX === '' ? null : parseInt(trimmedX, 10);
      const parsedY = trimmedY === '' ? null : parseInt(trimmedY, 10);
      if ((parsedX ?? null) !== (action.pixelX ?? null)) return true;
      if ((parsedY ?? null) !== (action.pixelY ?? null)) return true;
      const rawColor = pixelColor.trim();
      const normalisedColor = rawColor === ''
        ? ''
        : (rawColor.startsWith('#') ? rawColor.toUpperCase() : '#' + rawColor.toUpperCase());
      if (normalisedColor !== (action.pixelColor ?? '')) return true;
      const newTol = Math.max(0, Math.min(255, parseInt(pixelTolerance, 10) || 0));
      if (newTol !== (action.pixelTolerance ?? 0)) return true;
      if (actionType === 'WaitPixelColor') {
        const persistedPxTimeout = pixelOnTimeout === 'Continue' ? 'Continue' : '';
        const currentPxTimeout = action.pixelOnTimeout === 'Continue' ? 'Continue' : '';
        if (persistedPxTimeout !== currentPxTimeout) return true;
        if (!!pixelInvert !== !!(action.pixelInvert)) return true;
        if (!!pixelClickOnMatch !== !!(action.pixelClickOnMatch)) return true;
      }
    }

    if (_isIf) {
      if (!!conditionNegate !== !!(action.conditionNegate)) return true;
      const ctVal = Math.max(0, parseInt(conditionTimeout, 10) || 0);
      if (ctVal !== (action.conditionTimeout ?? 0)) return true;
      const persistedErr = ifOnProbeError === 'Halt' ? 'Halt' : '';
      const currentErr = action.ifOnProbeError === 'Halt' ? 'Halt' : '';
      if (persistedErr !== currentErr) return true;
      if (action.conditionType === 'WindowOpen') {
        if (windowProcessName !== (action.windowProcessName ?? '')) return true;
        if (windowTitle !== (action.windowTitle ?? '')) return true;
        const currentTitleMode = action.windowTitleMatchMode === 'regex' ? 'regex' : 'contains';
        if (windowTitleMatchMode !== currentTitleMode) return true;
        if (!!windowMatchForegroundOnly !== !!(action.windowMatchForegroundOnly)) return true;
      }
      if (action.conditionType === 'BrowserElementState') {
        const persistedIfMode = (waitMode === 'appears') ? '' : waitMode;
        if ((persistedIfMode || '') !== (action.waitMode || '')) return true;
        if (browserText !== (action.browserText || '')) return true;
      }
      if (action.conditionType === 'ClipboardMatch') {
        const currentPatternType = action.clipboardPatternType === 'equals' ? 'equals'
          : action.clipboardPatternType === 'regex' ? 'regex'
          : 'contains';
        if (clipboardPatternType !== currentPatternType) return true;
        if (clipboardPattern !== (action.clipboardPattern ?? '')) return true;
      }
      if (action.conditionType === 'Random') {
        const pct = Math.max(0, Math.min(100, parseInt(randomPercent, 10) || 0));
        if (pct !== (action.randomPercent ?? 0)) return true;
      }
      if (action.conditionType === 'Variable') {
        const currentOp = action.conditionOperator ?? 'eq';
        if (conditionOperator !== currentOp) return true;
        if (conditionOperand !== (action.conditionOperand ?? '')) return true;
      }
      if (action.conditionType === 'ProcessRunning') {
        if (windowProcessName !== (action.windowProcessName ?? '')) return true;
      }
      if (action.conditionType === 'FileExists') {
        if (filePath !== (action.filePath ?? '')) return true;
      }
      if (action.conditionType === 'TimeWindow') {
        if (timeStart !== (action.timeStart ?? '')) return true;
        if (timeEnd !== (action.timeEnd ?? '')) return true;
        if (daysOfWeek !== (action.daysOfWeek ?? 0)) return true;
      }
    }

    if (actionType === 'Pause') {
      const parsedMs = parseFloat(timeout);
      const newTimeoutMs = isNaN(parsedMs) || parsedMs < 0 ? 0 : Math.round(parsedMs);
      if (newTimeoutMs !== (action.timeout || 0)) return true;
    }

    if (actionType === 'BrowserType' && browserText !== (action.browserText || '')) return true;
    if (actionType.startsWith('Browser')) {
      const newTimeoutMs = Math.max(1000, parseFloat(timeout) || 5000);
      if (newTimeoutMs !== (action.timeout || 5000)) return true;
    }
    if (actionType === 'BrowserNavigate' && newTab !== (action.newTab || false)) return true;

    if (actionType === 'BrowserWaitElement') {
      const persistedMode = (waitMode === 'appears') ? '' : waitMode;
      if ((persistedMode || '') !== (action.waitMode || '')) return true;
    }

    if (actionType === 'BrowserAssert') {
      const persistedMode = (waitMode === 'appears') ? '' : waitMode;
      if ((persistedMode || '') !== (action.waitMode || '')) return true;
      const persistedPolicy = assertOnFail === 'Continue' ? 'Continue' : '';
      const currentPolicy = action.assertOnFail === 'Continue' ? 'Continue' : '';
      if (persistedPolicy !== currentPolicy) return true;
    }

    if (actionType === 'BrowserNavigate') {
      if ((urlWaitPattern || '') !== (action.urlWaitPattern || '')) return true;
      if ((postNavigateSelector || '') !== (action.postNavigateSelector || '')) return true;
    }

    if (actionType === 'BrowserType') {
      if (!!typeAppend !== !!(action.typeAppend)) return true;
      if (!!typePaste !== !!(action.typePaste)) return true;
      const tdParsed = typeDelay.trim() === '' ? null : parseInt(typeDelay, 10);
      const currentTd = action.typeDelay ?? null;
      const normalized = (tdParsed != null && !isNaN(tdParsed)) ? tdParsed : null;
      if (normalized !== currentTd) return true;
    }

    if (actionType === 'SetVariable') {
      if (variableValue !== (action.variableValue ?? '')) return true;
      const currentVarMode = action.variableMode === 'cycle' ? 'cycle' : 'set';
      if (variableMode !== currentVarMode) return true;
    }

    if (actionType === 'ActivateWindow') {
      if (windowProcessName !== (action.windowProcessName ?? '')) return true;
      if (windowTitle !== (action.windowTitle ?? '')) return true;
      const currentAwTitleMode = action.windowTitleMatchMode === 'regex' ? 'regex' : 'contains';
      if (windowTitleMatchMode !== currentAwTitleMode) return true;
      if (launchPath !== (action.launchPath ?? '')) return true;
      if (launchArgs !== (action.launchArgs ?? '')) return true;
      const persistedPolicy = activateOnTimeout === 'Continue' ? 'Continue' : '';
      const currentPolicy = action.activateOnTimeout === 'Continue' ? 'Continue' : '';
      if (persistedPolicy !== currentPolicy) return true;
      // Placement — mirrors handleSave's diffs + normalization byte-for-byte (PARITY OBLIGATION:
      // a field in handleSave but not here means a stray Esc silently drops that edit).
      if (restorePosition !== !!action.restorePosition) return true;
      if (restoreSize !== !!action.restoreSize) return true;
      if ((parseInt(windowX, 10) || 0) !== (action.windowX ?? 0)) return true;
      if ((parseInt(windowY, 10) || 0) !== (action.windowY ?? 0)) return true;
      if (Math.max(0, parseInt(windowWidth, 10) || 0) !== (action.windowWidth ?? 0)) return true;
      if (Math.max(0, parseInt(windowHeight, 10) || 0) !== (action.windowHeight ?? 0)) return true;
      const newAwTimeout = Math.max(1000, Math.round(parseFloat(timeout) || 10000));
      if (newAwTimeout !== (action.timeout || 5000)) return true;
    }

    if (actionType === 'BrowserSelectOption') {
      if (browserText !== (action.browserText || '')) return true;
      const currentMode = action.selectMatchMode === 'value' ? 'value'
        : action.selectMatchMode === 'index' ? 'index'
        : 'text';
      if (selectMatchMode !== currentMode) return true;
    }

    return false;
  }, [actionIndex, action, actionType, key, textMatch, textMode, x, y, delay, comment, timeout, confidence, browserText, variableValue, variableMode, newTab, waitMode, urlWaitPattern, postNavigateSelector, typeAppend, typePaste, typeDelay, selectMatchMode, waitImageOnTimeout, waitImageInvert, waitImageClickOnMatch, waitImageSearchRegion, pixelX, pixelY, pixelColor, pixelTolerance, pixelOnTimeout, pixelInvert, pixelClickOnMatch, conditionNegate, ifOnProbeError, conditionTimeout, windowProcessName, windowTitle, windowTitleMatchMode, windowMatchForegroundOnly, clipboardPatternType, clipboardPattern, randomPercent, conditionOperator, conditionOperand, filePath, timeStart, timeEnd, daysOfWeek, launchPath, launchArgs, activateOnTimeout, restorePosition, restoreSize, windowX, windowY, windowWidth, windowHeight, assertOnFail, alternatives]);

  // Key capture handler — focusing the field switches it to capture mode (empty + "New
  // key..." + pulse), the next non-modifier key is stored, and the input auto-blurs so
  // the user sees the resolved value immediately. Esc is intentionally NOT a cancel key
  // any more — the user might legitimately want to assign Escape as a hotkey. Cancelling
  // is done by clicking away or letting the idle timer fire (see armKeyCaptureTimer).
  const [keyFieldFocused, setKeyFieldFocused] = useState(false);
  const keyFieldRef = useRef<HTMLInputElement>(null);
  const keyCaptureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable refcount slot for hotkey:capture — only ONE surface in Sheet uses the
  // backend low-level hook (the Pause-resume hotkey field, which has to capture
  // Win+letter combos the WebView2 JS layer never sees). The Keystroke / KeyDown /
  // KeyUp inline editors use plain React keydown handlers (see handleKeyCapture)
  // and do NOT touch this slot. See InputHookManager.RegisterCapture.
  const captureOwnerIdRef = useRef(`sheet-panel-${crypto.randomUUID()}`);
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

  // Release the hotkey-capture slot on unmount. Normal flow (user blurs the
  // Pause-resume hotkey field before closing the Sheet) already does this via
  // onBlur, but Sheet can be torn down without a blur fire — backend-pushed
  // sheet:openIndex (App.tsx) or a programmatic close while the field is focused
  // both skip blur. HashSet.Remove is idempotent so this is a no-op when the
  // slot was never registered.
  useEffect(() => {
    return () => {
      send({ type: 'hotkey:capture', payload: { enabled: false, ownerId: captureOwnerIdRef.current } });
    };
  }, [send]);

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

  // Dirty-aware Esc: a reflexive Esc must not silently discard unsaved edits (the panel
  // batches edits into local state and only persists them on Save Changes). escArmed drives
  // a footer warning; the refs let the document listener read the latest values without
  // re-attaching on every keystroke. Cancel stays the EXPLICIT discard (no arm).
  const [escArmed, setEscArmed] = useState(false);
  const escArmedRef = useRef(false);
  const escArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasUnsavedRef = useRef(false);
  hasUnsavedRef.current = hasUnsavedChanges;

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
      // An active element pick takes priority: Esc cancels the pick (tear down the extension
      // overlay + drop our in-flight state) instead of closing the panel. The extension's own
      // page-level Esc only fires when the browser page is focused — this covers Esc while the
      // TrueReplayer editor has focus. Consume the press so the panel doesn't also close.
      if (pickElementRequestIdRef.current) {
        e.preventDefault();
        send({ type: 'browser:cancelPick', payload: {} });
        setPickElementRequestId(null);
        setIsPicking(false);
        return;
      }
      // Dirty guard rung (below capture/pick, above close): the FIRST Esc on a panel with
      // unsaved edits arms a 2.5s footer warning instead of closing; a SECOND Esc within the
      // window discards + closes. A clean panel closes on the first Esc, as before.
      if (hasUnsavedRef.current && !escArmedRef.current) {
        e.preventDefault();
        escArmedRef.current = true;
        setEscArmed(true);
        if (escArmTimerRef.current) clearTimeout(escArmTimerRef.current);
        escArmTimerRef.current = setTimeout(() => {
          escArmedRef.current = false;
          setEscArmed(false);
        }, 2500);
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', onDocKeyDown);
    return () => document.removeEventListener('keydown', onDocKeyDown);
  }, [actionIndex, onClose, send]);

  // Reset the capture state whenever the panel switches to a different action (including
  // closing — actionIndex going null). Without this, focusing the field, closing the
  // panel, then reopening leaves the field stuck in capture mode because the input was
  // unmounted before its blur could fire. Also tear down any pending idle-cancel timer
  // so it doesn't fire against a stale input ref after the panel reopens. Finally drop
  // every in-flight overlay/extension request: the panel doesn't remount on action
  // change, so if the user opens action A, fires Pick / eyedropper / Test action / Test
  // pixel, then switches to action B, the pending reply would otherwise land on B (and
  // a stuck requestId leaves B's button frozen at "Picking… / Running…"). Also kill the
  // Test-action safety timeout so it can't fire against B, and clear the transient test
  // results so B doesn't briefly show A's outcome.
  useEffect(() => {
    setKeyFieldFocused(false);
    setPauseHotkeyFocused(false);
    disarmKeyCaptureTimer();
    // Disarm the dirty-Esc warning when switching action (a fresh row starts clean, and a
    // stale "press Esc again" armed against the previous row must not carry over).
    escArmedRef.current = false;
    setEscArmed(false);
    if (escArmTimerRef.current) { clearTimeout(escArmTimerRef.current); escArmTimerRef.current = null; }
    setPickPositionRequestId(null);
    clearTestTimeout();
    setTestRequestId(null);
    setTestResult(null);
    setPickColorRequestId(null);
    setTestPixelRequestId(null);
    setTestPixelResult(null);
    // Browser element pick — drop the in-flight pick when the action changes (mirrors the
    // pickPosition / pickColor resets above). Clearing the id makes any late browser:pickResult
    // stale (the handler's id guard drops it), and we ask the extension to tear down its overlay
    // so a leftover pick can't land on the newly-opened action. send is stable from useBridge.
    if (pickElementRequestIdRef.current) send({ type: 'browser:cancelPick', payload: {} });
    setPickElementRequestId(null);
    setIsPicking(false);
  }, [actionIndex, disarmKeyCaptureTimer, clearTestTimeout, send]);

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

  // #2 — Tier shield for current selector (priority: textMatch > key). Memoised because
  // estimateTier runs a regex suite and buildTextSelector rebuilds the selector — recomputing
  // both on every render (the panel re-renders on each keystroke / test result) is wasteful.
  // MUST live here, above the `if (actionIndex == null) return null` early return below, so the
  // hook is called unconditionally on every render (Rules of Hooks).
  const { selectorForTier, tier, tierMeta } = useMemo(() => {
    const sel = textMatch.trim() ? buildTextSelector(textMode, textMatch.trim()) : key;
    const t = estimateTier(sel);
    return { selectorForTier: sel, tier: t, tierMeta: TIER_META[t] };
  }, [textMatch, textMode, key]);

  // #3 — Run the current action against the live page
  const handleTestAction = useCallback(() => {
    if (actionIndex == null || !action) return;
    const requestId = Math.random().toString(36).slice(2, 10);
    setTestRequestId(requestId);
    setTestResult(null);
    const effectiveKey = textMatch.trim() ? buildTextSelector(textMode, textMatch.trim()) : key;
    const timeoutMs = Math.max(1000, parseFloat(timeout) || 5000);
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

  // ActivateWindow — exists-anywhere probe: "would this action find the window right
  // now?". Same matcher semantics the replay uses (".exe" auto-append, self-excluded).
  // Local OS query, answers immediately — no safety timeout needed.
  const handleTestWindowProbe = useCallback(() => {
    const requestId = Math.random().toString(36).slice(2, 10);
    setWindowProbeRequestId(requestId);
    setWindowProbeResult(null);
    send({
      type: 'window:testProbe',
      payload: { requestId, processName: windowProcessName, windowTitle, titleMatchMode: windowTitleMatchMode },
    });
  }, [windowProcessName, windowTitle, windowTitleMatchMode, send]);

  // ActivateWindow Launch "Browse…" — opens a native file picker; the chosen full path lands in
  // launchPath via the dialog:pickFileResult subscription above.
  const handleBrowseLaunch = useCallback(() => {
    const requestId = Math.random().toString(36).slice(2, 10);
    browseLaunchReqRef.current = requestId;
    send({ type: 'dialog:pickFile', payload: { requestId, kind: 'executable' } });
  }, [send]);

  // ActivateWindow placement "Capture" — reads the matched window's CURRENT rect and seeds the
  // X/Y/W/H fields, so the user positions the window by hand once and saves it.
  const handleCaptureGeometry = useCallback(() => {
    const requestId = Math.random().toString(36).slice(2, 10);
    captureGeoReqRef.current = requestId;
    setCaptureGeoRequestId(requestId);
    setCaptureGeoError(null);
    send({
      type: 'window:captureGeometry',
      payload: { requestId, processName: windowProcessName, windowTitle, titleMatchMode: windowTitleMatchMode },
    });
  }, [windowProcessName, windowTitle, windowTitleMatchMode, send]);

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
    searchRegionRequestIdRef.current = requestId;
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
    // The empty check above doesn't catch non-numeric input (e.g. "abc"): parseInt would
    // return NaN, which JSON-serialises to null and makes the backend probe a bogus pixel.
    // Parse up front and bail with an inline error so we never send NaN.
    const testX = parseInt(pixelX, 10);
    const testY = parseInt(pixelY, 10);
    if (isNaN(testX) || isNaN(testY)) {
      setTestPixelResult({ matches: false, error: 'X and Y must be numbers.' });
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
        x: testX,
        y: testY,
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
  const isSetVariable = actionType === 'SetVariable';
  const isActivateWindow = actionType === 'ActivateWindow';
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
  const isIfWindow = isIf && action?.conditionType === 'WindowOpen';
  const isIfClipboard = isIf && action?.conditionType === 'ClipboardMatch';
  const isIfBrowser = isIf && action?.conditionType === 'BrowserElementState';
  const isIfRandom = isIf && action?.conditionType === 'Random';
  const isIfVariable = isIf && action?.conditionType === 'Variable';
  const isIfProcess = isIf && action?.conditionType === 'ProcessRunning';
  const isIfFile = isIf && action?.conditionType === 'FileExists';
  const isIfTime = isIf && action?.conditionType === 'TimeWindow';
  const isConditional = isIf || isElse || isEndIf;
  const isBrowserType = actionType === 'BrowserType';
  const isBrowserNavigate = actionType === 'BrowserNavigate';
  const isBrowserWait = actionType === 'BrowserWaitElement';
  const isBrowserSelect = actionType === 'BrowserSelectOption';
  const isBrowserAssert = actionType === 'BrowserAssert';
  const showKey = isKeyAction || isSendText;
  const showCoords = !noCoordTypes.has(actionType);

  // Mouse clicks come in two shapes: paired halves (LeftClickDown/Up, …) and combined single
  // clicks (LeftClick, …) recorded in combined mode. The Action Type picker only offers the
  // unsuffixed names; baseActionType strips any Down/Up suffix so the picker highlights the
  // right button, and clickHalfSuffix (null for a combined click) preserves the press/release
  // half when switching between click types. The optional-suffix regex matches both shapes, so
  // isClickHalf here means "is a click row" (coords + Pick/Copy/Paste buttons apply to both).
  // Double is in the button alternation so DoubleClick joins the click family
  // (picker chips + coords/Pick/Copy/Paste). A "DoubleClickDown" never exists,
  // so the optional suffix simply never matches for it.
  const clickHalfMatch = actionType.match(/^((?:Left|Right|Middle|Double)Click)(Down|Up)?$/);
  const isClickHalf = clickHalfMatch !== null;
  const clickHalfBase = clickHalfMatch ? clickHalfMatch[1] : null;
  const clickHalfSuffix = clickHalfMatch?.[2] ? (clickHalfMatch[2] as 'Down' | 'Up') : null;
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

  // Human-readable action name — defined once, used as the header headline (and reusable
  // for tooltips). Replaces the inline 17-branch ternary that used to live in the header.
  const actionLabel = isWaitImage ? 'Wait Image'
    : isSetVariable ? 'Set Variable'
    : isActivateWindow ? 'Activate Window'
    : isWaitPixelColor ? 'Wait Pixel Color'
    : isIfImage ? 'If Image Found'
    : isIfPixel ? 'If Pixel Color Match'
    : isIfWindow ? 'If Window Open'
    : isIfClipboard ? 'If Clipboard'
    : isIfBrowser ? 'If Browser Element'
    : isIfRandom ? 'If Random'
    : isIfVariable ? 'If Variable'
    : isIfProcess ? 'If Process Running'
    : isIfFile ? 'If File Exists'
    : isIfTime ? 'If Time'
    : isIf ? 'If'
    : isElse ? 'Else'
    : isEndIf ? 'End If'
    : actionType === 'BrowserClick' ? 'Click Element'
    : actionType === 'BrowserRightClick' ? 'Right Click Element'
    : actionType === 'BrowserType' ? 'Type Text'
    : actionType === 'BrowserWaitElement' ? 'Wait Element'
    : actionType === 'BrowserAssert' ? 'Assert Element'
    : actionType === 'BrowserNavigate' ? 'Open URL'
    : actionType === 'BrowserSelectOption' ? 'Select Option'
    : actionType === 'DoubleClick' ? 'Double Click'
    // Backend sheet:openIndex can land on these (no insert path opens them here);
    // without a case they leaked the raw type name into the header.
    : actionType === 'HoldKey' ? 'Hold Key'
    : actionType === 'RunProfile' ? 'Run Profile'
    : actionType === 'Keystroke' ? 'Keystroke'
    : isClickHalf ? `${(clickHalfBase ?? '').replace('Click', '')} Click`
    : actionType;

  // Header swatch family tint — the drawer's ENTIRE per-action-color budget (matches the
  // dialogs: Keystroke=key-fg, Pause=pause-fg, etc.). Render-only lookup; unknown types
  // fall back to the neutral secondary the swatch always had.
  const headerIconColor =
    actionType === 'SendText' ? 'var(--color-action-sendtext-fg)'
    : actionType === 'Pause' ? 'var(--color-action-pause-fg)'
    : (actionType === 'Keystroke' || actionType === 'KeyDown' || actionType === 'KeyUp' || actionType === 'HoldKey') ? 'var(--color-action-key-fg)'
    : (isIf || isElse || isEndIf) ? 'var(--color-action-if-fg)'
    : undefined;

  return createPortal(
    <>
      {/* Backdrop — no click-to-close, user must Save/Cancel/arrow */}
      <div
        className="fixed inset-0 z-[60]"
        style={{
          background: 'rgba(0,0,0,0.3)',
          animation: leaving ? 'fade-in var(--motion-base) var(--ease-exit) reverse forwards' : undefined,
        }}
      />

      {/* Panel — enters with slide-in-right, exits with its mirror (leaving is
          driven by App; onExited hands control back for the actual unmount). */}
      <div
        className="fixed right-0 top-0 bottom-0 w-[340px] z-[70] bg-bg-surface border-l border-border-default flex flex-col"
        style={{
          animation: leaving
            ? 'slide-out-right var(--motion-base) var(--ease-exit) forwards'
            // --motion-slow keeps the "exit is faster than entrance" relationship.
            : 'slide-in-right var(--motion-slow) var(--ease-enter)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
        }}
        onAnimationEnd={(e) => {
          if (leaving && e.target === e.currentTarget) onExited?.();
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-border-subtle shrink-0">
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors shrink-0">
            <ArrowLeft size={16} />
          </button>
          {/* Action icon — reuses the grid's canonical ActionIcon so the drawer reads the
              same as the row the user clicked (covers even the icon-less Else/EndIf). */}
          <div
            className="flex items-center justify-center w-8 h-8 rounded-md bg-bg-elevated text-text-secondary shrink-0"
            style={headerIconColor ? { color: headerIconColor } : undefined}
          >
            <ActionIcon actionType={actionType} size={15} />
          </div>
          <div className="min-w-0">
            {/* Headline = the action name; the redundant "Edit Action" is dropped (the
                drawer context already makes it obvious). */}
            <div className="text-sm font-semibold text-text-primary truncate">{actionLabel}</div>
            <div className="text-[11px] text-text-tertiary mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span>Action #{(actionIndex ?? 0) + 1}</span>
              {clickHalfSuffix && (
                <span
                  className="px-1.5 py-[1px] rounded text-[10px] font-medium border bg-bg-card text-text-secondary border-border-default"
                >
                  {clickHalfSuffix === 'Down' ? '↓ press' : '↑ release'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3 flex-1 min-h-0 overflow-y-auto">
          {/* Action Type — only shown when the family has >1 meaningful option. Hidden for
              SendText (single option), WaitImage / Browser / Pause (each has its own editor
              shape). Cross-family conversions aren't offered: users who want to swap families
              record a new action — it's faster and avoids leaving half-filled fields behind. */}
          {!isWaitImage && !isBrowser && !isPause && showTypePicker && (
          <Field label="Action Type">
            <div className="flex flex-wrap gap-1.5">
              {familyOptions
                // Editing a paired half (Down/Up)? Don't offer Double Click — it's a
                // combined-only unit; converting just one half would orphan its twin.
                .filter(t => !(clickHalfSuffix && t.value === 'DoubleClick'))
                .map(t => {
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
          </Field>
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
            <Field label="Condition">
              {/* 2-bucket label map (pure render): object probes read Found/NOT Found;
                  state checks (Clipboard/Variable/Random/Time) read Met/NOT Met. Same
                  conditionNegate boolean write either way. */}
              {(() => {
                const met = isIfClipboard || isIfVariable || isIfRandom || isIfTime;
                return (
                  <SegmentedControl<'found' | 'not'>
                    ariaLabel="Condition polarity"
                    grow
                    value={conditionNegate ? 'not' : 'found'}
                    onChange={(v) => setConditionNegate(v === 'not')}
                    options={[
                      { value: 'found', label: met ? 'Met' : 'Found' },
                      { value: 'not', label: met ? 'NOT Met' : 'NOT Found' },
                    ]}
                  />
                );
              })()}
            </Field>

            {/* Wait for condition sits next to the Condition toggle — the core branch
                decision and its timing modifier read as one pair; the flaky-probe fallback
                (On Probe Error) reads last as the edge case. Hidden for Random (re-rolling
                every poll until it hits is meaningless) and Time (polling a clock window
                is surprising) — those are instant-only conditions. */}
            {!isIfRandom && !isIfTime && (
            <Field
              label="Wait for condition"
              hint={tt('How long to keep re-checking before giving up. 0 = check once.', 'Por quanto tempo continuar checando antes de desistir. 0 = checa uma vez.')}
            >
              <NumberInput
                value={parseInt(conditionTimeout, 10) || 0}
                onChange={(n) => setConditionTimeout(String(n))}
                min={0}
                step={500}
                thousands
                suffix="ms" suffixInside
                inputWidth="w-[124px]"
                inputHeight="h-8"
                ariaLabel="Wait for condition in milliseconds"
              />
            </Field>
            )}

            <Field
              label="On Probe Error"
              hint={tt('What to do if the check itself errors.', 'O que fazer se a própria checagem der erro.')}
            >
              <SegmentedControl<'TreatAsFalse' | 'Halt'>
                ariaLabel="On probe error"
                grow
                value={ifOnProbeError === 'Halt' ? 'Halt' : 'TreatAsFalse'}
                onChange={(v) => setIfOnProbeError(v)}
                options={[
                  { value: 'TreatAsFalse', label: 'Treat as false', tip: tt('Probe errors count as NOT found (default)', 'Erros de sondagem contam como NÃO encontrado (padrão)') },
                  { value: 'Halt', label: 'Halt', tip: tt('Stop the replay', 'Interrompe a reprodução') },
                ]}
              />
            </Field>

            {/* Hairline between the shared If chrome and the family-specific fields —
                the family's first Field label is header enough; no text needed. */}
            <div className="border-t border-border-subtle" />
          </>
          )}

          {/* If Window (WindowOpen) — state-based probe reusing the Window Target matching
              semantics: empty field = wildcard, at least one criterion required. */}
          {isIfWindow && (
          <>
            <Field
              label="Process Name"
              hint={tt('e.g. notepad.exe — ".exe" is assumed when omitted. Leave empty to match by title only.', 'ex.: notepad.exe — ".exe" é assumido se omitido. Deixe vazio para casar só pelo título.')}
            >
              <input
                type="text"
                value={windowProcessName}
                onChange={(e) => setWindowProcessName(e.target.value)}
                placeholder="notepad.exe"
                spellCheck={false}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              />
            </Field>
            <Field
              label="Window Title"
              hint={tt('Case-insensitive. Leave empty to match by process only — but set at least one of the two.', 'Sem diferenciar maiúsculas. Deixe vazio para casar só pelo processo — mas preencha ao menos um dos dois.')}
            >
              <input
                type="text"
                value={windowTitle}
                onChange={(e) => setWindowTitle(e.target.value)}
                placeholder=""
                spellCheck={false}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              />
            </Field>
            <Field label="Title Match">
              <SegmentedControl<'contains' | 'regex'>
                ariaLabel="Title match mode"
                grow
                value={windowTitleMatchMode}
                onChange={setWindowTitleMatchMode}
                options={[
                  { value: 'contains', label: 'Contains', tip: tt('Title must contain this text (case-insensitive)', 'Título deve conter este texto (sem diferenciar maiúsculas)') },
                  { value: 'regex', label: 'Regex', tip: tt('Title is a .NET regular expression (case-insensitive)', 'Título é uma expressão regular .NET (sem diferenciar maiúsculas)') },
                ]}
              />
            </Field>
            <Checkbox
              checked={windowMatchForegroundOnly}
              onChange={setWindowMatchForegroundOnly}
              label="Foreground window only"
              title={tt('TRUE only if the matching window is currently in front — instead of existing anywhere.', 'TRUE somente se a janela correspondente estiver em primeiro plano — em vez de apenas existir.')}
            />
          </>
          )}

          {/* If Clipboard (ClipboardMatch) — branches on the clipboard's current TEXT. */}
          {isIfClipboard && (
          <>
            <Field label="Match Type">
              <SegmentedControl<'contains' | 'equals' | 'regex'>
                ariaLabel="Clipboard match type"
                grow
                value={clipboardPatternType}
                onChange={setClipboardPatternType}
                options={[
                  { value: 'contains', label: 'Contains' },
                  { value: 'equals', label: 'Equals' },
                  { value: 'regex', label: 'Regex' },
                ]}
              />
            </Field>
            <Field
              label="Pattern"
              hint={tt('Compared against the clipboard TEXT, case-insensitive. Non-text clipboard (image/files) never matches.', 'Comparado com o TEXTO do clipboard, sem diferenciar maiúsculas. Clipboard não-texto (imagem/arquivos) nunca casa.')}
            >
              <input
                type="text"
                value={clipboardPattern}
                onChange={(e) => setClipboardPattern(e.target.value)}
                spellCheck={false}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              />
            </Field>
          </>
          )}

          {/* If Random — probabilistic branch. TRUE with probability percent/100. */}
          {isIfRandom && (
            <Field
              label="Chance"
              className="w-[124px]"
              hint={tt('TRUE this often. 100% always takes the main branch, 0% never does.', 'TRUE nesta frequência. 100% sempre pega o ramo principal, 0% nunca.')}
            >
              <NumberInput
                value={parseInt(randomPercent, 10) || 0}
                onChange={(n) => setRandomPercent(String(Math.max(0, Math.min(100, n))))}
                min={0}
                max={100}
                suffix="%" suffixInside
                inputWidth="w-full"
                inputHeight="h-8"
                className="w-full"
                ariaLabel="Random chance percent"
              />
            </Field>
          )}

          {/* If Variable — compares the runtime variable (name) against the operand. */}
          {isIfVariable && (
          <>
            <Field
              label="Variable Name"
              hint={tt('The variable set earlier with Set Variable. Case-insensitive.', 'A variável definida antes com Set Variable. Sem diferenciar maiúsculas.')}
            >
              <input
                type="text"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="name"
                spellCheck={false}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              />
            </Field>
            <Field label="Operator">
              <SegmentedControl<'eq' | 'neq' | 'contains' | 'gt' | 'lt'>
                ariaLabel="Comparison operator"
                grow
                value={conditionOperator}
                onChange={setConditionOperator}
                options={[
                  { value: 'eq', label: '=', tip: tt('Equal (case-insensitive text)', 'Igual (texto, sem diferenciar maiúsculas)') },
                  { value: 'neq', label: '≠', tip: tt('Not equal', 'Diferente') },
                  { value: 'contains', label: 'has', tip: tt('Variable contains the operand', 'A variável contém o operando') },
                  { value: 'gt', label: '>', tip: tt('Greater than (numeric when both are numbers)', 'Maior que (numérico quando ambos são números)') },
                  { value: 'lt', label: '<', tip: tt('Less than (numeric when both are numbers)', 'Menor que (numérico quando ambos são números)') },
                ]}
              />
            </Field>
            <Field
              label="Value"
              hint={tt('Tokens like {var:other}, {counter} or {clipboard} resolve here. In Test the variable is empty — run the profile to evaluate.', 'Tokens como {var:other}, {counter} ou {clipboard} resolvem aqui. No Test a variável está vazia — execute o perfil para avaliar.')}
            >
              <input
                type="text"
                value={conditionOperand}
                onChange={(e) => setConditionOperand(e.target.value)}
                spellCheck={false}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              />
            </Field>
          </>
          )}

          {/* If Process running — matches a process by image name, window or not. */}
          {isIfProcess && (
            <Field
              label="Process Name"
              hint={tt('e.g. chrome.exe — ".exe" optional. TRUE when the process is running (with or without a window).', 'ex.: chrome.exe — ".exe" opcional. TRUE quando o processo está em execução (com ou sem janela).')}
            >
              <input
                type="text"
                value={windowProcessName}
                onChange={(e) => setWindowProcessName(e.target.value)}
                placeholder="chrome.exe"
                spellCheck={false}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              />
            </Field>
          )}

          {/* If File exists — TRUE when the resolved path exists (file or folder). */}
          {isIfFile && (
            <Field
              label="Path"
              hint={tt('File or folder path. Tokens like {var:x} or {date} resolve at run time. Pairs with a flag file to control the macro from outside.', 'Caminho de arquivo ou pasta. Tokens como {var:x} ou {date} resolvem na execução. Combina com um arquivo-bandeira para controlar a macro de fora.')}
            >
              <input
                type="text"
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder="C:\\flags\\go.txt"
                spellCheck={false}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              />
            </Field>
          )}

          {/* If Time / day-of-week — TRUE inside the time window AND on a selected day. */}
          {isIfTime && (
          <>
            <div className="flex gap-2.5">
              <Field label="From" className="flex-1" hint={tt('Local time HH:mm', 'Hora local HH:mm')}>
                <input
                  type="time"
                  value={timeStart}
                  onChange={(e) => setTimeStart(e.target.value)}
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                />
              </Field>
              <Field label="To" className="flex-1" hint={tt('Overnight OK (e.g. 22:00–02:00)', 'Pode virar a noite (ex.: 22:00–02:00)')}>
                <input
                  type="time"
                  value={timeEnd}
                  onChange={(e) => setTimeEnd(e.target.value)}
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                />
              </Field>
            </div>
            <Field label="Days" hint={tt('None selected = every day. Leave times empty for a day-only condition.', 'Nenhum marcado = todo dia. Deixe as horas vazias para condição só por dia.')}>
              {/* Independent toggle chips, NOT a segmented track — multi-select must not
                  look like an exclusive choice. Same XOR bitmask write as before. */}
              <div className="flex gap-1">
                {(['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const).map((lbl, bit) => {
                  const on = (daysOfWeek & (1 << bit)) !== 0;
                  return (
                    <button
                      key={bit}
                      type="button"
                      onClick={() => setDaysOfWeek(daysOfWeek ^ (1 << bit))}
                      className={`w-7 h-6 rounded text-[10px] font-medium border transition-colors ${
                        on
                          ? 'text-accent border-accent/30 bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
                          : 'text-text-tertiary border-border-subtle bg-bg-card hover:text-text-secondary'
                      }`}
                      data-tip={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][bit]}
                    >
                      {lbl}
                    </button>
                  );
                })}
              </div>
            </Field>
          </>
          )}

          {/* If Browser Element (BrowserElementState) — one instant state check against the
              live page via the extension's waitElement evaluator (timeout=0). Reuses
              BrowserWaitElement's probe fields: key = selector, waitMode, browserText =
              text pattern. A disconnected extension reads as "not found", never a halt. */}
          {isIfBrowser && (
          <>
            <Field
              label="CSS Selector"
              labelAdornment={selectorForTier ? (
                // Same tier shield as the browser six-pack — pure display (the tier memo
                // is computed unconditionally from the same key/textMatch/textMode state).
                <span
                  style={{ color: tierMeta.color, display: 'inline-flex', alignItems: 'center', gap: 3 }}
                  data-tip={tt(`${tier} · ${tierMeta.label}`, `${tier} · ${tierMeta.labelPtBr}`)}
                >
                  <tierMeta.Icon size={12} />
                  <span className="text-[10px] font-semibold normal-case">{tier}</span>
                </span>
              ) : undefined}
              hint={tt('Requires the browser extension connected; when it is not, the condition reads as NOT found instead of stopping the replay.', 'Requer a extensão do navegador conectada; sem ela, a condição lê como NÃO encontrado em vez de parar a reprodução.')}
            >
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={textMatch.trim() ? buildTextSelector(textMode, textMatch.trim()) : key}
                  onChange={(e) => { setKey(e.target.value); setTextMatch(''); }}
                  placeholder=".btn-save"
                  spellCheck={false}
                  className="flex-1 h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                />
                <button
                  onClick={() => {
                    const requestId = Math.random().toString(36).slice(2, 10);
                    setPickElementRequestId(requestId);
                    setIsPicking(true);
                    setShowAlternatives(false);
                    send({ type: 'browser:pickElement', payload: { requestId } });
                  }}
                  disabled={isPicking}
                  className={`h-8 w-8 flex items-center justify-center rounded border transition-colors ${
                    isPicking
                      ? 'bg-accent-solid/20 border-accent-solid text-accent-light'
                      : 'bg-bg-input border-border-default text-text-tertiary hover:text-text-primary hover:border-text-tertiary'
                  }`}
                >
                  <Crosshair size={14} />
                </button>
              </div>
            </Field>
            <Field label="State">
              <select
                value={waitMode}
                onChange={(e) => setWaitMode(e.target.value)}
                className="w-full h-8 px-2 text-ui bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              >
                <option value="appears">Visible (default)</option>
                <option value="disappears">Not present / hidden</option>
                <option value="enabled">Enabled</option>
                <option value="text-match">Text matches</option>
              </select>
            </Field>
            {waitMode === 'text-match' && (
              <Field
                label="Text Pattern"
                hint={tt("Element's visible text must match. Supports the text-selector syntax: plain text = exact, or prefix with text*= / text~= / text/regex/.", 'O texto visível do elemento deve casar. Suporta a sintaxe de seletor de texto: texto puro = exato, ou prefixe com text*= / text~= / text/regex/.')}
              >
                <input
                  type="text"
                  value={browserText}
                  onChange={(e) => setBrowserText(e.target.value)}
                  spellCheck={false}
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                />
              </Field>
            )}
          </>
          )}

          {/* Else / EndIf are pure block markers with nothing to configure — the
              orientation note rides the quiet left-rail card in the If family's teal
              so the otherwise-empty panel reads as intentional, not broken. */}
          {(isElse || isEndIf) && (
            <div
              className="border-l-2 rounded px-2.5 py-2 text-[11px] leading-relaxed text-text-secondary"
              style={{
                borderColor: 'var(--color-action-if-fg)',
                backgroundColor: 'color-mix(in srgb, var(--color-action-if-fg) 8%, transparent)',
              }}
            >
              {isElse
                ? tt('Else marks the FALSE branch of its If block. Configure the condition on the opening If row — nothing to set here.', 'Else marca o ramo FALSE do bloco If. Configure a condição na linha If de abertura — nada a definir aqui.')
                : tt('End If closes the conditional block. Configure the condition on the opening If row — nothing to set here.', 'End If fecha o bloco condicional. Configure a condição na linha If de abertura — nada a definir aqui.')}
            </div>
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
            <Field label="Reference Image">
              <button
                type="button"
                onClick={() => action?.imageBase64 && setCropperOpen(true)}
                disabled={!action?.imageBase64}
                className="w-full rounded border border-border-default bg-bg-elevated overflow-hidden block hover:border-accent-solid/60 transition-colors disabled:cursor-default disabled:hover:border-border-default"
              >
                {action?.imageBase64 ? (
                  <img
                    src={`data:image/png;base64,${action.imageBase64}`}
                    alt="Reference"
                    className="w-full max-h-[140px] object-contain bg-bg-input"
                  />
                ) : (
                  <div className="flex items-center justify-center h-[80px] text-xs text-text-disabled">
                    No image captured
                  </div>
                )}
              </button>
              {/* Recapture + Test match share the row below the thumbnail — both act
                  on the captured reference (one regenerates it, the other validates
                  it against the live screen) so they're sibling operations on the
                  same artefact. */}
              <div className="mt-2 flex gap-2.5">
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
                  className="flex-1 flex items-center justify-center gap-1.5 h-8 px-2.5 rounded text-xs font-medium border border-border-default bg-bg-elevated hover:bg-bg-card text-text-secondary hover:text-text-primary transition-colors"
                >
                  <RefreshCw size={12} />
                  Recapture
                </button>
                <button
                  onClick={handleTestMatch}
                  disabled={!action?.imagePath || testMatchRequestId != null}
                  className="flex-1 flex items-center justify-center gap-1.5 h-8 px-2.5 rounded text-xs font-medium border border-accent-solid/40 bg-accent-solid/10 hover:bg-accent-solid/20 text-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <PlayCircle size={13} />
                  {testMatchRequestId != null ? 'Testing…' : 'Test match'}
                </button>
              </div>
              {/* Test match result — icon headline + mono only on the value spans (the
                  browser Test card dialect). Success also auto-sets the Search Region
                  (see handler above); the note confirms that side-effect. */}
              {testMatchResult && !testMatchRequestId && (
                <div
                  className="mt-2 px-2 py-1.5 rounded text-[11px] border"
                  style={resultCardStyle(!!testMatchResult.found && !testMatchResult.error)}
                >
                  {testMatchResult.error ? (
                    <div className="flex items-center gap-1.5 font-medium">
                      <X size={11} className="shrink-0" />
                      <span>{testMatchResult.error}</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5 font-medium">
                        {testMatchResult.found ? <Check size={11} className="shrink-0" /> : <X size={11} className="shrink-0" />}
                        <span>
                          Best match{' '}
                          <span className="font-mono">{Math.round(testMatchResult.score * 100)}% at ({testMatchResult.x}, {testMatchResult.y})</span>
                          {testMatchResult.found ? '' : ' — below tolerance'}
                        </span>
                      </div>
                      {testMatchResult.found && (
                        <div className="mt-1 text-[10px] opacity-80">
                          {tt(
                            'Search region set to a ±80 px rect around this match. Use the Search Region field below to fine-tune.',
                            'Região de busca definida como um retângulo de ±80 px ao redor deste match. Ajuste fino no campo Search Region abaixo.',
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </Field>

            {/* Search Region (ROI) — placed right under the Test result so the auto-set
                feedback sits next to the field it just modified. Label + display row carry
                the meaning; Configure button's title attribute keeps the discovery hint
                on hover. */}
            <Field label="Search Region">
              <div className="flex items-center gap-2.5">
                <div className="flex-1 h-8 px-2 flex items-center text-[11px] font-mono bg-bg-input border border-border-default rounded text-text-secondary">
                  {waitImageSearchRegion
                    ? `${waitImageSearchRegion.x}, ${waitImageSearchRegion.y}  ·  ${waitImageSearchRegion.w} × ${waitImageSearchRegion.h}`
                    : <span className="text-text-disabled italic">Full screen (default)</span>}
                </div>
                <button
                  onClick={handleConfigureSearchRegion}
                  className="h-8 px-2.5 flex items-center gap-1.5 rounded text-xs font-medium border border-border-default bg-bg-elevated hover:bg-bg-card text-text-secondary hover:text-text-primary transition-colors"
                  data-tip={tt('Limit matching to a screen region — faster, fewer false positives.', 'Limita a correspondência a uma região da tela — mais rápido, menos falsos positivos.')}
                >
                  <Frame size={12} />
                  Configure
                </button>
                {waitImageSearchRegion && (
                  <button
                    onClick={() => setWaitImageSearchRegion(null)}
                    className="h-8 px-2 flex items-center rounded text-xs text-text-tertiary hover:text-[var(--color-recording)] hover:bg-bg-card transition-colors"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </Field>

            {/* TOLERANCE — own row with helper text. Mirrors Pixel's tolerance section
                (which also sits before the time-axis fields) so the two probe editors
                read in parallel: "what to look for → search region → how forgiving →
                wait behavior → test it". */}
            <Field
              label="Tolerance (%)"
              hint={tt('Default 80%. Raise to ~95 for strict; drop below 70 for compressed UI.', 'Padrão 80%. Aumente para ~95 para estrito; abaixe de 70 para UI comprimida.')}
            >
              <Slider
                value={parseInt(confidence, 10) || 80}
                min={10}
                max={100}
                step={5}
                onChange={(n) => setConfidence(String(n))}
                suffix="%"
              />
            </Field>

            {/* WAIT UNTIL — WaitImage only. IF rows route "wait for absence" via the
                CONDITION section's Found / NOT Found toggle. */}
            {!isIf && (
            <Field label="Wait Until">
              <SegmentedControl<'appears' | 'disappears'>
                ariaLabel="Wait until"
                grow
                value={waitImageInvert ? 'disappears' : 'appears'}
                onChange={(v) => setWaitImageInvert(v === 'disappears')}
                options={[
                  { value: 'appears', label: 'Appears' },
                  { value: 'disappears', label: 'Disappears' },
                ]}
              />
            </Field>
            )}

            {/* TIMEOUT + ON TIMEOUT — WaitImage only. Side-by-side row identical in
                shape to the Pixel editor's matching block. Edited in milliseconds
                (min 1000 — the backend clamps non-Pause timeouts to ≥1s anyway), step
                1000 so the +/- spinner moves a second at a time. */}
            {!isIf && (
            <div className="flex gap-2.5">
              <Field label="Timeout" className="w-[124px] shrink-0">
                <NumberInput
                  value={(() => { const n = parseFloat(timeout); return Number.isFinite(n) && n > 0 ? n : 5000; })()}
                  onChange={(n) => setTimeout_(String(n))}
                  min={1000}
                  step={1000}
                  thousands
                  suffix="ms" suffixInside
                  inputWidth="w-full"
                  inputHeight="h-8"
                  className="w-full"
                  ariaLabel="Timeout in milliseconds"
                />
              </Field>
              <Field label="On Timeout" className="flex-1">
                <SegmentedControl<'StopReplay' | 'Continue'>
                  ariaLabel="On timeout"
                  grow
                  value={waitImageOnTimeout === 'Continue' ? 'Continue' : 'StopReplay'}
                  onChange={(v) => setWaitImageOnTimeout(v)}
                  options={[
                    { value: 'StopReplay', label: 'Halt', tip: tt('Stop the replay', 'Interrompe a reprodução') },
                    { value: 'Continue', label: 'Continue', tip: tt('Continue to the next action', 'Continua para a próxima ação') },
                  ]}
                />
              </Field>
            </div>
            )}

            {/* After Match — bare Checkbox (no Field wrapper; the label carries the
                meaning). Suppressed on IF rows (the user routes click via a regular
                LeftClick in the TRUE branch) and when waiting for disappearance (no
                found-location to click on). */}
            {!isIf && !waitImageInvert && (
              <Checkbox
                checked={waitImageClickOnMatch}
                onChange={setWaitImageClickOnMatch}
                label="Click on found location"
              />
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
            {/* Coords + Pick + Test match — the canonical sibling X/Y row (Click-editor
                parity; the old "Pixel to Watch" wrapper double-labelled the block). Pick
                captures the coords/colour, Test validates them, so they pair below. */}
            <div>
              <div className="flex gap-2.5">
                <Field label="X" className="flex-1">
                  <NumberInput
                    value={pixelX === '' ? null : (Number.isFinite(parseInt(pixelX, 10)) ? parseInt(pixelX, 10) : null)}
                    onChange={(n) => setPixelX(String(n))}
                    onClear={() => setPixelX('')}
                    placeholder="—"
                    inputWidth="w-full"
                    inputHeight="h-8"
                    ariaLabel="Pixel X"
                  />
                </Field>
                <Field label="Y" className="flex-1">
                  <NumberInput
                    value={pixelY === '' ? null : (Number.isFinite(parseInt(pixelY, 10)) ? parseInt(pixelY, 10) : null)}
                    onChange={(n) => setPixelY(String(n))}
                    onClear={() => setPixelY('')}
                    placeholder="—"
                    inputWidth="w-full"
                    inputHeight="h-8"
                    ariaLabel="Pixel Y"
                  />
                </Field>
              </div>
              {/* Test match + Pick share one row — Test validates the current pixel, Pick
                  (re)captures X/Y + colour. Both h-8, flex-1, so neither clips or wraps. */}
              {/* Pair order = config → validate: Pick captures the coords/colour, Test
                  validates them against the live screen. Test carries the accent (the
                  one validate-against-world rank). */}
              <div className="mt-2 flex gap-2.5">
                <button
                  type="button"
                  onClick={handlePickPixelColor}
                  disabled={pickColorRequestId != null}
                  className="flex-1 h-8 flex items-center justify-center gap-1.5 px-2.5 text-xs font-medium border border-border-default bg-bg-elevated hover:bg-bg-card text-text-secondary hover:text-text-primary rounded whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Pipette size={13} />
                  {pickColorRequestId != null ? 'Picking…' : 'Pick'}
                </button>
                <button
                  type="button"
                  onClick={handleTestPixelMatch}
                  className="flex-1 h-8 flex items-center justify-center gap-1.5 px-2.5 text-xs font-medium border border-accent-solid/40 bg-accent-solid/10 hover:bg-accent-solid/20 text-accent-light rounded whitespace-nowrap transition-colors"
                >
                  <PlayCircle size={13} />
                  Test match
                </button>
              </div>
              {testPixelResult && (
                <div
                  className="mt-2 px-2 py-1.5 rounded text-[11px] border"
                  style={resultCardStyle(!!testPixelResult.matches && !testPixelResult.error)}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    {(!!testPixelResult.matches && !testPixelResult.error)
                      ? <Check size={11} className="shrink-0" />
                      : <X size={11} className="shrink-0" />}
                    <span>
                      {testPixelResult.error ? (
                        testPixelResult.error
                      ) : (
                        <>
                          Sampled <span className="font-mono">{testPixelResult.sampledHex ?? 'no read'}</span>
                          {' · '}Target <span className="font-mono">{pixelColor} ± {pixelTolerance}</span>
                          {testPixelResult.matches ? '' : ' — out of tolerance'}
                        </>
                      )}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* TARGET COLOUR — swatch + hex input. The eyedropper above writes both, but
                the user can also type or paste a hex code directly. Normalisation
                (uppercase + leading #) happens on Save, not on every keystroke, so the
                input stays predictable while editing. */}
            <Field label="Target Colour">
              <div className="flex items-center gap-2.5">
                {(() => {
                  const validHex = /^#?(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(pixelColor.trim());
                  return (
                    <span
                      className={`w-8 h-8 rounded border shrink-0 ${validHex ? 'border-border-default' : 'border-dashed border-border-default'}`}
                      style={{ background: validHex ? (pixelColor.trim().startsWith('#') ? pixelColor.trim() : '#' + pixelColor.trim()) : 'transparent' }}
                      data-tip={pixelColor || tt('No colour set', 'Nenhuma cor definida')}
                    />
                  );
                })()}
                <input
                  type="text"
                  value={pixelColor}
                  onChange={(e) => setPixelColor(e.target.value)}
                  placeholder="#RRGGBB"
                  className="flex-1 h-8 px-2 text-ui font-mono text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
                />
              </div>
            </Field>

            {/* TOLERANCE — per-channel band. Slider + numeric input so users can either
                drag for feel or type an exact value. Range capped at 50 (out of 255)
                because anything higher starts matching unrelated colours; expert users
                who really want > 50 can still type it. */}
            <Field
              label="Tolerance (Per Channel)"
              hint={tt('Try 5–15 for compressed UI colours.', 'Tente 5–15 para cores de UI comprimidas.')}
            >
              <Slider
                value={parseInt(pixelTolerance, 10) || 0}
                min={0}
                max={50}
                inputMax={255}
                onChange={(n) => setPixelTolerance(String(n))}
              />
            </Field>

            {/* WAIT UNTIL — WaitPixelColor only. Same shape (own row, dropdown) and
                same label as the WaitImage editor above. IF rows express the same
                concept via the CONDITION section's Found / NOT Found toggle. */}
            {!isIf && (
            <Field label="Wait Until">
              <SegmentedControl<'matches' | 'stopsMatching'>
                ariaLabel="Wait until"
                grow
                value={pixelInvert ? 'stopsMatching' : 'matches'}
                onChange={(v) => setPixelInvert(v === 'stopsMatching')}
                options={[
                  { value: 'matches', label: 'Matches' },
                  { value: 'stopsMatching', label: 'Stops matching' },
                ]}
              />
            </Field>
            )}

            {/* TIMEOUT + ON TIMEOUT — WaitPixelColor only. Side-by-side row identical
                in shape to the WaitImage editor above. Edited in milliseconds (min 1000,
                step 1000) — same unit as every other action duration. */}
            {!isIf && (
            <div className="flex gap-2.5">
              <Field label="Timeout" className="w-[124px] shrink-0">
                <NumberInput
                  value={(() => { const n = parseFloat(timeout); return Number.isFinite(n) && n > 0 ? n : 5000; })()}
                  onChange={(n) => setTimeout_(String(n))}
                  min={1000}
                  step={1000}
                  thousands
                  suffix="ms" suffixInside
                  inputWidth="w-full"
                  inputHeight="h-8"
                  className="w-full"
                  ariaLabel="Timeout in milliseconds"
                />
              </Field>
              <Field label="On Timeout" className="flex-1">
                <SegmentedControl<'StopReplay' | 'Continue'>
                  ariaLabel="On timeout"
                  grow
                  value={pixelOnTimeout === 'Continue' ? 'Continue' : 'StopReplay'}
                  onChange={(v) => setPixelOnTimeout(v)}
                  options={[
                    { value: 'StopReplay', label: 'Halt', tip: tt('Stop the replay', 'Interrompe a reprodução') },
                    { value: 'Continue', label: 'Continue', tip: tt('Continue to the next action', 'Continua para a próxima ação') },
                  ]}
                />
              </Field>
            </div>
            )}

            {/* After Match — bare Checkbox (no Field wrapper). IF rows route click via
                a regular LeftClick in the TRUE branch. */}
            {!isIf && !pixelInvert && (
              <Checkbox
                checked={pixelClickOnMatch}
                onChange={setPixelClickOnMatch}
                label="Click on found location"
              />
            )}

          </>
          )}

          {/* Pause Settings */}
          {isPause && (
          <>
            <Field label="Resume Hotkey">
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
                // Arm on click or Enter/Space, never bare focus — keyboard
                // navigation must not flip the low-level hook into capture mode
                // (a Tab-through would swallow the next keypress as the hotkey).
                onClick={() => {
                  if (pauseHotkeyFocused) return;
                  setPauseHotkeyFocused(true);
                  armKeyCaptureTimer();
                  send({ type: 'hotkey:capture', payload: { enabled: true, ownerId: captureOwnerIdRef.current } });
                }}
                onKeyDown={(e) => {
                  if (pauseHotkeyFocused || (e.key !== 'Enter' && e.key !== ' ')) return;
                  e.preventDefault();
                  setPauseHotkeyFocused(true);
                  armKeyCaptureTimer();
                  send({ type: 'hotkey:capture', payload: { enabled: true, ownerId: captureOwnerIdRef.current } });
                }}
                onBlur={() => {
                  setPauseHotkeyFocused(false);
                  disarmKeyCaptureTimer();
                  send({ type: 'hotkey:capture', payload: { enabled: false, ownerId: captureOwnerIdRef.current } });
                }}
                className={`w-full h-8 px-2 text-ui font-mono bg-bg-input border rounded outline-none cursor-pointer placeholder:text-accent-light/50 ${
                  pauseHotkeyFocused
                    ? 'text-accent-light border-accent-solid animate-pulse'
                    : 'text-text-primary border-border-default'
                }`}
              />
            </Field>
            <Field label="Timeout">
              <NumberInput
                value={parseInt(timeout, 10) || 0}
                onChange={(n) => setTimeout_(String(n))}
                min={0}
                step={1000}
                thousands
                suffix="ms" suffixInside
                inputWidth="w-full"
                inputHeight="h-8"
                ariaLabel="Timeout in milliseconds"
              />
              {/* Quick presets — the shared DurationChips recipe (Send Keystroke / Insert
                  Pause dialog parity). ∞ (0 ms) = no timeout, resume by hotkey only.
                  String-backed state preserved: onSelect writes String(ms). */}
              <div className="mt-1.5">
                <DurationChips
                  presets={[100, 500, 1000, 5000, 30000, 0]}
                  value={(() => { const p = parseFloat(timeout); return isNaN(p) ? 0 : p; })()}
                  onSelect={(ms) => setTimeout_(String(ms))}
                  infinityTip={tt('Wait forever for the resume hotkey', 'Espera para sempre pela tecla de retomada')}
                />
              </div>
            </Field>

            {/* Foot-gun warning — if neither a resume hotkey nor a timeout is set, the
                Pause is silently skipped at replay time (ExecutePause early-returns).
                Left-rail card, delay (amber) tone. */}
            {(() => {
              const parsedSecs = parseFloat(timeout);
              const effectiveSecs = isNaN(parsedSecs) ? 0 : parsedSecs;
              const hasNoTrigger = !key.trim() && effectiveSecs <= 0;
              if (!hasNoTrigger) return null;
              return (
                <div
                  className="flex items-start gap-2 border-l-2 rounded px-2.5 py-2 text-[11px] leading-relaxed"
                  style={{
                    color: 'var(--color-delay)',
                    borderColor: 'var(--color-delay)',
                    backgroundColor: 'color-mix(in srgb, var(--color-delay) 8%, transparent)',
                  }}
                >
                  <ShieldAlert size={13} className="shrink-0 mt-px" />
                  <span>
                    {tt('No resume hotkey and no timeout — this Pause will be skipped at replay time.', 'Sem tecla de retomada e sem tempo limite — esta Pause será ignorada na reprodução.')}
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
              <label className="label-micro text-text-tertiary mb-1.5 flex items-center gap-1.5">
                {isBrowserNavigate ? 'URL' : 'CSS Selector'}
                {/* #2 — Tier shield indicator (only for non-Navigate selectors) */}
                {!isBrowserNavigate && selectorForTier && (
                  <span
                    style={{ color: tierMeta.color, display: 'inline-flex', alignItems: 'center', gap: 3 }}
                    data-tip={tt(`${tier} · ${tierMeta.label}`, `${tier} · ${tierMeta.labelPtBr}`)}
                  >
                    <tierMeta.Icon size={12} />
                    <span className="text-[10px] font-semibold normal-case">{tier}</span>
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
                      const requestId = Math.random().toString(36).slice(2, 10);
                      setPickElementRequestId(requestId);
                      setIsPicking(true);
                      setShowAlternatives(false);
                      send({ type: 'browser:pickElement', payload: { requestId } });
                    }}
                    disabled={isPicking}
                    className={`h-8 w-8 flex items-center justify-center rounded border transition-colors ${
                      isPicking
                        ? 'bg-accent-solid/20 border-accent-solid text-accent-light'
                        : 'bg-bg-input border-border-default text-text-tertiary hover:text-text-primary hover:border-text-tertiary'
                    }`}
                  >
                    <Crosshair size={14} />
                  </button>
                )}
              </div>

              {/* #2 — Alternatives popover (after pick) */}
              {showAlternatives && alternatives.length > 0 && (
                <div className="mt-1.5 rounded border border-border-default bg-bg-elevated p-1.5 space-y-1">
                  <div className="flex items-center justify-between px-1">
                    <span className="label-micro text-text-tertiary">Alternatives</span>
                    <button
                      onClick={() => setShowAlternatives(false)}
                      className="flex items-center text-text-tertiary hover:text-text-primary"
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {alternatives.map((alt, i) => {
                    const m = TIER_META[alt.tier] || TIER_META.C;
                    return (
                      <button
                        key={i}
                        onClick={() => { setKey(alt.selector); setTextMatch(''); setShowAlternatives(false); }}
                        className="w-full text-left px-2 py-1 rounded text-[11px] hover:bg-bg-card transition-colors flex items-center gap-1.5"
                        data-tip={alt.description}
                      >
                        <span style={{ color: m.color, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <m.Icon size={10} />
                          <span className="text-[10px] font-bold">{alt.tier}</span>
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
                className="label-micro text-text-tertiary mb-1.5 block"
                data-tip={tt('Takes priority over CSS selector when filled', 'Tem prioridade sobre o seletor CSS quando preenchido')}
              >
                Text Match
              </label>
              <div className="flex gap-1.5">
                <select
                  value={textMode}
                  onChange={(e) => setTextMode(e.target.value as TextMode)}
                  className="h-8 px-1.5 text-[11px] bg-bg-input border border-border-default rounded text-text-secondary outline-none focus:border-accent-solid"
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
                <p className="text-[10px] mt-1 font-mono" style={{ color: 'var(--color-recording)' }}>Invalid regex: {regexError}</p>
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

            {/* #7 — Navigate post-checks, grouped under one section header. "Ready
                Element" (was "Wait Element") kills the name collision with the
                Wait Element ACTION type. */}
            {isBrowserNavigate && (
            <>
              <div className="label-micro text-text-tertiary">After Navigation</div>
              <Field label="URL Pattern" hint={tt('Optional. Wait until URL matches glob (*) or /regex/. Useful for redirects.', 'Opcional. Espera até a URL corresponder a glob (*) ou /regex/. Útil para redirecionamentos.')}>
                <input
                  type="text"
                  value={urlWaitPattern}
                  onChange={(e) => setUrlWaitPattern(e.target.value)}
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                  placeholder="*/dashboard*"
                />
              </Field>
              <Field label="Ready Element" hint={tt('Optional. Wait for element to appear after page load.', 'Opcional. Espera o elemento aparecer após o carregamento da página.')}>
                <input
                  type="text"
                  value={postNavigateSelector}
                  onChange={(e) => setPostNavigateSelector(e.target.value)}
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                  placeholder="#app-ready"
                />
              </Field>
            </>
            )}

            {/* Text — only for BrowserType. Uses the same Lexical-based editor as the
                SendText dialog so tokens (`{Enter}`, `{Clipboard}`, etc.) render as
                inline chips directly inside the input — no separate preview row needed.
                Chip buttons below insert at the cursor via the imperative handle. */}
            {isBrowserType && (
            <Field label="Text to Type">
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
              {/* Chip palette — the 3 most-reached tokens on one row; everything else (Tab,
                  Date, Time, and the rare keys) collapses behind the "⋯" expander. Names match
                  the SendText dialog's vocabulary; insertText() drops the token at the cursor
                  inside the Lexical editor and TokenAutoTransformPlugin turns it into a chip. */}
              <div className="flex flex-wrap gap-1 mt-2">
                {[
                  { var: '{Clipboard}', label: 'Clipboard' },
                  { var: '{Enter}', label: 'Enter' },
                  { var: '{DateTime}', label: 'DateTime' },
                ].map(item => (
                  <button
                    key={item.var}
                    type="button"
                    onClick={() => browserTextEditorRef.current?.insertText(item.var)}
                    className="h-6 px-2 inline-flex items-center text-[11px] font-mono bg-bg-surface border border-border-subtle rounded text-text-secondary hover:text-warning hover:border-warning/40 transition-colors"
                  >
                    {item.label}
                  </button>
                ))}
                {/* "⋯" expander — accent "active" state while open mirrors the SendText
                    Advanced chip's toggle affordance. */}
                <button
                  type="button"
                  onClick={() => setShowMoreTypeChips(v => !v)}
                  className={`h-6 px-2 inline-flex items-center text-[11px] font-mono border rounded transition-colors ${
                    showMoreTypeChips
                      ? 'text-accent-light bg-accent-solid/15 border-accent-solid/50'
                      : 'bg-bg-surface border-border-subtle text-text-secondary hover:text-warning hover:border-warning/40'
                  }`}
                  data-tip={showMoreTypeChips ? tt('Hide extra tokens', 'Ocultar tokens extras') : tt('More tokens (Tab, Date, Time, Random, Escape, Backspace, Delete, arrows)', 'Mais tokens (Tab, Date, Time, Random, Escape, Backspace, Delete, setas)')}
                >
                  ⋯
                </button>
              </div>
              {/* Everything beyond the top 3 — collapsed by default. */}
              {showMoreTypeChips && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {[
                    { var: '{Tab}', label: 'Tab' },
                    { var: '{Date}', label: 'Date' },
                    { var: '{Time}', label: 'Time' },
                    { var: '{Random:1-10}', label: 'Random' },
                    { var: '{Escape}', label: 'Escape' },
                    { var: '{Backspace}', label: 'Backspace' },
                    { var: '{Delete}', label: 'Delete' },
                    { var: '{Up}', label: 'Up' },
                    { var: '{Down}', label: 'Down' },
                    { var: '{Left}', label: 'Left' },
                    { var: '{Right}', label: 'Right' },
                  ].map(item => (
                    <button
                      key={item.var}
                      type="button"
                      onClick={() => browserTextEditorRef.current?.insertText(item.var)}
                      className="h-6 px-2 inline-flex items-center text-[11px] font-mono bg-bg-surface border border-border-subtle rounded text-text-secondary hover:text-warning hover:border-warning/40 transition-colors"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </Field>
            )}

            {/* #5 — Type options, grouped under one section header. */}
            {isBrowserType && (
            <div className="space-y-1.5">
              <div className="label-micro text-text-tertiary">Typing</div>
              <Checkbox
                checked={typeAppend}
                onChange={setTypeAppend}
                label="Keep existing text"
                title={tt('Add the new text to the end of whatever is already in the field. When unchecked (default), the field is cleared before typing.', 'Adiciona o novo texto ao final do que já estiver no campo. Quando desmarcado (padrão), o campo é limpo antes de digitar.')}
              />
              <Checkbox
                checked={typePaste}
                onChange={setTypePaste}
                label="Paste"
                title={tt('Use clipboard paste (instant) instead of typing char-by-char', 'Usa colagem da área de transferência (instantâneo) em vez de digitar caractere por caractere')}
              />
              <div className="flex items-center gap-2">
                <label className="text-xs text-text-secondary" data-tip={tt('Delay between characters in ms (typing only). 0 = instant, blank = auto.', 'Atraso entre caracteres em ms (apenas digitação). 0 = instantâneo, vazio = automático.')}>Char delay</label>
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
                  thousands
                  suffix="ms" suffixInside
                  inputWidth="w-16"
                  inputHeight="h-8"
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
              {/* Match By FIRST (choose how, then type what — the mode-aware Option
                  placeholder below then teaches the expected format). */}
              <Field
                label="Match By"
                hint={tt('Only works on native <select> elements. For React-Select / Select2 use Click Element.', 'Só funciona em elementos <select> nativos. Para React-Select / Select2 use Click Element.')}
              >
                <SegmentedControl<'text' | 'value' | 'index'>
                  ariaLabel="Option match mode"
                  grow
                  value={selectMatchMode}
                  onChange={setSelectMatchMode}
                  options={[
                    { value: 'text', label: 'Text', tip: tt('Match the visible label (default)', 'Casa pelo rótulo visível (padrão)') },
                    { value: 'value', label: 'Value', tip: tt("Match the option's value attribute", 'Casa pelo atributo value da opção') },
                    { value: 'index', label: 'Index', tip: tt('Match by 0-based position', 'Casa pela posição (base 0)') },
                  ]}
                />
              </Field>
              <Field label="Option">
                <input
                  type="text"
                  value={browserText}
                  onChange={(e) => setBrowserText(e.target.value)}
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                  placeholder={selectMatchMode === 'index' ? '0' : selectMatchMode === 'value' ? 'option-value' : 'Option label'}
                />
              </Field>
            </>
            )}

            {/* #6 — WaitElement / Assert state mode (shared) */}
            {(isBrowserWait || isBrowserAssert) && (
            <Field label={isBrowserAssert ? 'Assert Condition' : 'Wait Condition'}>
              <select
                value={waitMode}
                onChange={(e) => setWaitMode(e.target.value)}
                className="w-full h-8 px-2 text-ui bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              >
                <option value="appears">{isBrowserAssert ? 'Is present (default)' : 'Appears (default)'}</option>
                <option value="disappears">{isBrowserAssert ? 'Is NOT present' : 'Disappears'}</option>
                <option value="enabled">{isBrowserAssert ? 'Is enabled' : 'Enabled'}</option>
                <option value="text-match">Text matches (uses Text Match field)</option>
              </select>
              {/* Foot-gun warning: text-match mode needs an actual Text Match string.
                  Without it, the effective selector falls back to the raw CSS key
                  (handleSave / handleTestAction both call buildTextSelector only when
                  textMatch is non-empty) — extension then receives waitMode='text-match'
                  on a plain selector and the action times out silently. */}
              {waitMode === 'text-match' && !textMatch.trim() && (
                <div
                  className="mt-1.5 flex items-start gap-2 border-l-2 rounded px-2.5 py-2 text-[11px] leading-relaxed"
                  style={{
                    color: 'var(--color-delay)',
                    borderColor: 'var(--color-delay)',
                    backgroundColor: 'color-mix(in srgb, var(--color-delay) 8%, transparent)',
                  }}
                >
                  <ShieldAlert size={13} className="shrink-0 mt-px" />
                  <span>{tt('Text-match mode needs a value in the Text Match field. Otherwise this Wait will time out.', 'O modo Text Match precisa de um valor no campo Text Match. Caso contrário, este Wait vai expirar.')}</span>
                </div>
              )}
            </Field>
            )}

            {/* BrowserAssert — what to do when the condition isn't met within the timeout.
                Halt stops the replay LOUDLY (the point of an assertion); Continue logs and
                moves on. "Wait Condition" above uses "Is NOT present" instead of a Negate. */}
            {isBrowserAssert && (
            <Field label="On Fail">
              <SegmentedControl<'Halt' | 'Continue'>
                ariaLabel="On assertion fail"
                grow
                value={assertOnFail}
                onChange={setAssertOnFail}
                options={[
                  { value: 'Halt', label: 'Halt', tip: tt('Stop the replay and report when the assertion is not met.', 'Para o replay e reporta quando a asserção não é satisfeita.') },
                  { value: 'Continue', label: 'Continue', tip: tt('Log and continue to the next action even if the assertion fails.', 'Registra e segue para a próxima ação mesmo se a asserção falhar.') },
                ]}
              />
            </Field>
            )}

            {/* Test action, then the timing pair (Timeout + Delay) directly below it, so the
                cluster reads Test action -> Timeout -> Delay. */}
            <div>
              <button
                onClick={handleTestAction}
                disabled={testRequestId !== null}
                className="w-full h-8 flex items-center justify-center gap-1.5 px-2.5 rounded text-xs font-medium border border-accent-solid/40 bg-accent-solid/10 hover:bg-accent-solid/20 text-accent-light transition-colors disabled:opacity-60"
              >
                <PlayCircle size={13} />
                {testRequestId ? 'Running…' : 'Test action'}
              </button>
              {testResult && (
                <div
                  className="mt-1.5 px-2 py-1.5 rounded text-[11px] border"
                  style={resultCardStyle(testResult.success)}
                >
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

            {/* Timeout + Delay — ONE row (both w-[124px]). Cluster order Test → Timeout →
                Delay preserved (2.7.5). The engine reads action.Timeout for all six command
                types; Delay is the browser-local copy of the shared field (same delay/
                setDelay state, so handleSave persistence is unchanged; the shared trailing
                Delay is suppressed for isBrowser to avoid a duplicate). */}
            <div className="flex gap-2.5">
              <Field label="Timeout" className="w-[124px] shrink-0">
                <NumberInput
                  value={parseInt(timeout, 10) || 5000}
                  onChange={(n) => setTimeout_(String(n))}
                  min={1000}
                  step={1000}
                  thousands
                  suffix="ms" suffixInside
                  inputWidth="w-full"
                  inputHeight="h-8"
                  className="w-full"
                  ariaLabel="Timeout in milliseconds"
                />
              </Field>
              <Field label="Delay" className="w-[124px] shrink-0">
                <NumberInput
                  value={parseInt(delay, 10) || 0}
                  onChange={(n) => setDelay(String(n))}
                  min={0}
                  thousands
                  suffix="ms" suffixInside
                  inputWidth="w-full"
                  inputHeight="h-8"
                  className="w-full"
                  ariaLabel="Delay in milliseconds"
                />
              </Field>
            </div>
          </>
          )}

          {/* Key — only for KeyDown/KeyUp and SendText. For KeyDown/KeyUp the input is
              read-only and consumes keydown events to capture the key directly; the visible
              value goes through getDisplayKey() so it matches the grid's display rules
              (e.g. raw `D3` shows as `3`, raw `162` shows as `Ctrl`). */}
          {showKey && (
          <Field label={isSendText ? 'Text' : 'Key'}>
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
              // SendText payload — a textarea so long / multi-line text doesn't clip in a
              // single-line box. Only reached when !isKeyAction (showKey ⇒ isSendText here).
              <>
                <textarea
                  rows={2}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  className="w-full min-h-[3.25rem] px-2 py-1.5 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid resize-y"
                />
                {action?.keyHtml && (
                  // Rich payload warning: this textarea edits only the PLAIN flavor, and a
                  // saved key change drops the formatting (bridge nulls KeyHtml). Point the
                  // user at the Insert Text dialog for formatted editing.
                  <div className="mt-1 text-[10px] text-warning leading-snug">
                    {tt('Formatted text — saving a change here converts it to plain. Use the row’s Insert Text editor to keep formatting.',
                        'Texto formatado — salvar uma mudança aqui converte para texto puro. Use o editor Insert Text da linha para manter a formatação.')}
                  </div>
                )}
              </>
            )}
          </Field>
          )}

          {/* Set Variable — name + value pair written into the replay run's variable store.
              Labels stay English per the locked i18n rule; guidance lives in the hints. */}
          {isSetVariable && (
            <>
              <Field
                label="Variable Name"
                hint={tt(
                  'Letters, digits and underscore. Read it back anywhere with {var:name} — matching is case-insensitive.',
                  'Letras, dígitos e underscore. Leia com {var:name} em qualquer texto — sem diferenciar maiúsculas.'
                )}
              >
                <input
                  type="text"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="name"
                  spellCheck={false}
                  className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                />
              </Field>
              <Field label="Mode">
                <SegmentedControl<'set' | 'cycle'>
                  ariaLabel="Variable mode"
                  grow
                  value={variableMode}
                  onChange={setVariableMode}
                  options={[
                    { value: 'set', label: 'Set', tip: tt('Store the resolved value as-is on every execution.', 'Grava o valor resolvido como está, em toda execução.') },
                    { value: 'cycle', label: 'Cycle', tip: tt('Value is a LIST (one item per line): each execution stores the NEXT line, wrapping around. The position survives between runs — pressing the hotkey repeatedly walks the list. Resets when the app restarts.', 'O valor é uma LISTA (um item por linha): cada execução grava a PRÓXIMA linha, voltando ao início no fim. A posição sobrevive entre execuções — apertar o hotkey repetidamente percorre a lista. Zera ao reiniciar o app.') },
                  ]}
                />
              </Field>
              <Field
                label={variableMode === 'cycle' ? 'List (one item per line)' : 'Value'}
                hint={variableMode === 'cycle'
                  ? tt(
                      'Each run of this action stores the NEXT line under the name above. Tokens resolve first — a value of just {clipboard} cycles through the clipboard’s lines.',
                      'Cada execução desta ação grava a PRÓXIMA linha no nome acima. Tokens resolvem antes — um valor com só {clipboard} percorre as linhas da área de transferência.'
                    )
                  : tt(
                      'Tokens like {clipboard}, {date} or {var:other} resolve when this action runs. Saving an empty value deletes the variable.',
                      'Tokens como {clipboard}, {date} ou {var:other} resolvem quando a ação executa. Salvar valor vazio apaga a variável.'
                    )}
              >
                <textarea
                  rows={variableMode === 'cycle' ? 4 : 2}
                  value={variableValue}
                  onChange={(e) => setVariableValue(e.target.value)}
                  placeholder={variableMode === 'cycle' ? 'item 1\nitem 2\nitem 3' : undefined}
                  spellCheck={false}
                  className="w-full min-h-[3.25rem] px-2 py-1.5 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid resize-y"
                />
              </Field>
            </>
          )}

          {/* Activate Window — find → launch-if-missing → wait → focus. The matcher block
              mirrors the If-Window editor (same shared window* state); then LAUNCH, then
              the Test → Timeout → policy timing cluster (browser-editor convention). */}
          {isActivateWindow && (
          <>
            {/* Section header — the matcher trio reads as one "which window" block. */}
            <div className="label-micro text-text-tertiary">Match Window</div>
            <Field
              label="Process"
              hint={tt('".exe" assumed when omitted. Empty = match by title only.', '".exe" assumido se omitido. Vazio = casar só pelo título.')}
            >
              <input
                type="text"
                value={windowProcessName}
                onChange={(e) => setWindowProcessName(e.target.value)}
                placeholder="notepad.exe"
                spellCheck={false}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              />
            </Field>
            {/* Title + its match mode on one row — the Contains/Regex toggle is a right-
                aligned label adornment (it modifies THIS title), saving a whole Field row. */}
            <Field
              label="Title"
              labelAdornment={
                <div className="ml-auto">
                  <SegmentedControl<'contains' | 'regex'>
                    ariaLabel="Title match mode"
                    value={windowTitleMatchMode}
                    onChange={setWindowTitleMatchMode}
                    options={[
                      { value: 'contains', label: 'Contains', tip: tt('Title must contain this text (case-insensitive)', 'Título deve conter este texto (sem diferenciar maiúsculas)') },
                      { value: 'regex', label: 'Regex', tip: tt('Title is a .NET regular expression (case-insensitive)', 'Título é uma expressão regular .NET (sem diferenciar maiúsculas)') },
                    ]}
                  />
                </div>
              }
              hint={tt('Case-insensitive. UWP apps: match by title (process is ApplicationFrameHost.exe).', 'Sem diferenciar maiúsculas. Apps UWP: case pelo título (processo é ApplicationFrameHost.exe).')}
            >
              <input
                type="text"
                value={windowTitle}
                onChange={(e) => setWindowTitle(e.target.value)}
                placeholder=""
                spellCheck={false}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
              />
            </Field>
            {/* Section header — the optional launch pair. */}
            <div className="label-micro text-text-tertiary">Launch</div>
            <Field
              label="Path"
              hint={tt('Program, URL, document or shortcut — opened only when no window matches. Empty = just wait & focus.', 'Programa, URL, documento ou atalho — aberto só quando nenhuma janela casa. Vazio = só esperar e focar.')}
            >
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={launchPath}
                  onChange={(e) => setLaunchPath(e.target.value)}
                  placeholder="notepad.exe · https://… · C:\path\app.exe"
                  spellCheck={false}
                  className="flex-1 min-w-0 h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
                />
                <button
                  type="button"
                  onClick={handleBrowseLaunch}
                  data-tip={tt('Pick a program — fills the full path so Windows can find it (a bare name like app.exe often will not resolve).', 'Escolha um programa — preenche o caminho completo para o Windows encontrar (um nome puro como app.exe geralmente não resolve).')}
                  data-tip-pos="left"
                  className="shrink-0 h-8 px-2.5 flex items-center gap-1 rounded text-xs border border-border-default bg-bg-input hover:bg-[rgba(127,127,127,0.14)] text-text-secondary transition-colors"
                >
                  <FolderOpen size={13} />
                  Browse…
                </button>
              </div>
            </Field>
            <Field label="Args">
              <input
                type="text"
                value={launchArgs}
                onChange={(e) => setLaunchArgs(e.target.value)}
                disabled={!launchPath.trim()}
                spellCheck={false}
                className="w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid disabled:opacity-50"
              />
            </Field>

            {/* Placement — section label + the two independent toggle chips on ONE compact
                row (Position and Size aren't an exclusive choice, so plain chips, not a
                track). Full positional caveat lives on the label tooltip + the bottom card. */}
            <div className="flex items-center justify-between">
              <span
                className="label-micro text-text-tertiary cursor-help"
                data-tip={tt('Move and/or resize the window after activating it. Positional only — clicks still resolve against the profile target; for clicks relative to THIS window, use a sub-profile + Run Profile.', 'Move e/ou redimensiona a janela depois de ativá-la. Só posicional — cliques ainda resolvem contra o target do perfil; para cliques relativos a ESTA janela, use um sub-perfil + Run Profile.')}
                data-tip-pos="left"
              >
                Placement
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setRestorePosition(!restorePosition)}
                  className={`h-6 px-2.5 rounded text-[10px] font-medium border transition-colors ${
                    restorePosition
                      ? 'text-accent border-accent/30 bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
                      : 'text-text-tertiary border-border-subtle bg-bg-card hover:text-text-secondary'
                  }`}
                >
                  Position
                </button>
                <button
                  type="button"
                  onClick={() => setRestoreSize(!restoreSize)}
                  className={`h-6 px-2.5 rounded text-[10px] font-medium border transition-colors ${
                    restoreSize
                      ? 'text-accent border-accent/30 bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
                      : 'text-text-tertiary border-border-subtle bg-bg-card hover:text-text-secondary'
                  }`}
                >
                  Size
                </button>
              </div>
            </div>
            {restorePosition && (
              <div className="flex gap-1.5">
                <Field label="X" className="flex-1 min-w-0">
                  <NumberInput
                    value={parseInt(windowX, 10) || 0}
                    onChange={(n) => setWindowX(String(n))}
                    inputWidth="w-full" inputHeight="h-8" className="w-full"
                  />
                </Field>
                <Field label="Y" className="flex-1 min-w-0">
                  <NumberInput
                    value={parseInt(windowY, 10) || 0}
                    onChange={(n) => setWindowY(String(n))}
                    inputWidth="w-full" inputHeight="h-8" className="w-full"
                  />
                </Field>
              </div>
            )}
            {restoreSize && (
              <div className="flex gap-1.5">
                <Field label="Width" className="flex-1 min-w-0">
                  <NumberInput
                    value={parseInt(windowWidth, 10) || 0}
                    onChange={(n) => setWindowWidth(String(Math.max(0, n)))}
                    min={0}
                    inputWidth="w-full" inputHeight="h-8" className="w-full"
                  />
                </Field>
                <Field label="Height" className="flex-1 min-w-0">
                  <NumberInput
                    value={parseInt(windowHeight, 10) || 0}
                    onChange={(n) => setWindowHeight(String(Math.max(0, n)))}
                    min={0}
                    inputWidth="w-full" inputHeight="h-8" className="w-full"
                  />
                </Field>
              </div>
            )}
            {(restorePosition || restoreSize) && (
              <div>
                <button
                  type="button"
                  onClick={handleCaptureGeometry}
                  disabled={captureGeoRequestId !== null || (!windowProcessName.trim() && !windowTitle.trim())}
                  data-tip={tt('Reads the current position and size of the matched window — place it by hand first, then capture.', 'Lê a posição e o tamanho atuais da janela casada — posicione-a à mão primeiro, depois capture.')}
                  data-tip-pos="left"
                  className="w-full h-8 flex items-center justify-center gap-1.5 px-2.5 rounded text-xs font-medium border border-border-default bg-bg-input hover:bg-[rgba(127,127,127,0.14)] text-text-secondary transition-colors disabled:opacity-60"
                >
                  <Frame size={13} />
                  {captureGeoRequestId ? 'Capturing…' : 'Capture from window'}
                </button>
                {captureGeoError && (
                  <div className="mt-1.5 px-2 py-1.5 rounded text-[11px] border" style={resultCardStyle(false)}>
                    <div className="flex items-center gap-1.5">
                      <X size={11} />
                      <span>{captureGeoError}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Test (exists-anywhere probe) + result card, then Timeout + On Timeout. */}
            <div>
              <button
                onClick={handleTestWindowProbe}
                disabled={windowProbeRequestId !== null || (!windowProcessName.trim() && !windowTitle.trim())}
                className="w-full h-8 flex items-center justify-center gap-1.5 px-2.5 rounded text-xs font-medium border border-accent-solid/40 bg-accent-solid/10 hover:bg-accent-solid/20 text-accent-light transition-colors disabled:opacity-60"
              >
                <PlayCircle size={13} />
                {windowProbeRequestId ? 'Testing…' : 'Test'}
              </button>
              {windowProbeResult && (
                <div
                  className="mt-1.5 px-2 py-1.5 rounded text-[11px] border"
                  style={resultCardStyle(windowProbeResult.found)}
                >
                  <div className="flex items-center gap-1.5">
                    {windowProbeResult.found ? <Check size={11} /> : <X size={11} />}
                    <span className="font-medium">
                      {windowProbeResult.found
                        ? `Found — ${[windowProbeResult.matchProcess, windowProbeResult.matchTitle].filter(Boolean).join(' · ')}`
                        : (windowProbeResult.error || 'Not found')}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-2.5">
              <Field label="Timeout" className="w-[124px]">
                <NumberInput
                  value={parseInt(timeout, 10) || 10000}
                  onChange={(n) => setTimeout_(String(n))}
                  min={1000}
                  step={1000}
                  thousands
                  suffix="ms" suffixInside
                  inputWidth="w-full"
                  inputHeight="h-8"
                  className="w-full"
                  ariaLabel="Wait-for-window timeout in milliseconds"
                />
              </Field>
              <Field label="On Timeout" className="flex-1">
                <SegmentedControl<'Halt' | 'Continue'>
                  ariaLabel="On timeout"
                  grow
                  value={activateOnTimeout}
                  onChange={setActivateOnTimeout}
                  options={[
                    { value: 'Halt', label: 'Halt', tip: tt('Stop the replay when the window cannot be found or focused — keyboard actions follow the focused window, so continuing would type into the wrong app.', 'Para o replay quando a janela não é encontrada ou focada — ações de teclado seguem a janela em foco, então continuar digitaria no app errado.') },
                    { value: 'Continue', label: 'Continue', tip: tt('Log and move on to the next action even if the window was not found or focused.', 'Registra e segue para a próxima ação mesmo se a janela não foi encontrada ou focada.') },
                  ]}
                />
              </Field>
            </div>

            {/* Passive guidance when the profile has a Window Target — coordinates keep
                translating against the PROFILE target regardless of this action. Neutral
                left-rail card (no tint) — informational, not a warning. */}
            {profiles.find(p => p.name === activeProfile)?.hasEffectiveTarget && (
              <div
                className="border-l-2 rounded px-2.5 py-2 text-[11px] leading-relaxed text-text-tertiary"
                style={{ borderColor: 'var(--color-border-subtle)' }}
              >
                {tt(
                  "Coordinates keep following the profile's Window Target — for multi-window macros leave the profile target empty, or split per-window steps into sub-profiles with their own targets (Run Profile).",
                  'As coordenadas continuam seguindo o Window Target do perfil — para macros multi-janela, deixe o target do perfil vazio ou divida os passos por janela em sub-perfis com seus próprios targets (Run Profile).'
                )}
              </div>
            )}
          </>
          )}

          {/* X / Y — Pick button (only on click halves, since scroll actions don't really
              use X/Y but happen to live in showCoords). Lets the user click somewhere on
              screen to fill both coords without manual typing or re-recording. */}
          {showCoords && (
            <div className="space-y-2.5">
              {/* Row 1: X / Y at full width — no longer squeezed by the action buttons. */}
              <div className="flex gap-2.5">
                <Field label="X" className="flex-1">
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
                </Field>
                <Field label="Y" className="flex-1">
                  <NumberInput
                    value={y === '' ? null : (Number.isFinite(parseInt(y, 10)) ? parseInt(y, 10) : null)}
                    onChange={(n) => setY(String(n))}
                    onClear={() => setY('')}
                    placeholder="—"
                    inputWidth="w-full"
                    inputHeight="h-8"
                    ariaLabel="Y coordinate"
                  />
                </Field>
              </div>
              {/* Row 2: coordinate tools — "Pick from screen" gets the room to read clearly;
                  Copy / Paste stay as compact icon buttons on the right. */}
              {isClickHalf && (
                <div className="flex items-stretch gap-1.5">
                  <button
                    type="button"
                    onClick={handlePickPosition}
                    disabled={pickPositionRequestId != null}
                    className="flex-1 h-8 flex items-center justify-center gap-1.5 px-2.5 text-xs font-medium border border-border-default bg-bg-elevated hover:bg-bg-card text-text-secondary hover:text-text-primary rounded whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Crosshair size={13} />
                    {pickPositionRequestId != null ? 'Picking…' : 'Pick from screen'}
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyCoords}
                    style={coordCopyFlash ? { borderColor: 'var(--color-replay)', color: 'var(--color-replay)', backgroundColor: 'var(--color-replay-bg)' } : undefined}
                    className={`h-8 shrink-0 flex items-center justify-center gap-1.5 px-2.5 text-xs font-medium border rounded transition-colors ${
                      coordCopyFlash
                        ? ''
                        : 'border-border-default bg-bg-elevated hover:bg-bg-card text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {coordCopyFlash ? <Check size={13} /> : <Copy size={13} />} {coordCopyFlash ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    onClick={handlePasteCoords}
                    style={coordPasteError ? { borderColor: 'var(--color-recording)', color: 'var(--color-recording)', backgroundColor: 'var(--color-recording-bg)' } : undefined}
                    className={`h-8 shrink-0 flex items-center justify-center gap-1.5 px-2.5 text-xs font-medium border rounded transition-colors ${
                      coordPasteError
                        ? ''
                        : 'border-border-default bg-bg-elevated hover:bg-bg-card text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {coordPasteError ? <X size={13} /> : <ClipboardPaste size={13} />} Paste
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Delay — hidden for conditional structural rows. IF rows don't have a
              meaningful "delay AFTER" (the probe is instant and the branch is taken
              before the next action fires its own delay); Else/EndIf are pure markers
              the engine walks past with zero work. Keeping the field would just invite
              users to set a value that gets silently ignored. Also suppressed for browser
              actions — they render their own Delay inside the Test/Timeout/Delay cluster
              (bound to the same delay state), so this would be a duplicate. */}
          {!isConditional && !isBrowser && (
          <Field label="Delay" className="w-[124px]">
            <NumberInput
              value={parseInt(delay, 10) || 0}
              onChange={(n) => setDelay(String(n))}
              min={0}
              thousands
              suffix="ms" suffixInside
              inputWidth="w-full"
              inputHeight="h-8"
              className="w-full"
              ariaLabel="Delay in milliseconds"
            />
          </Field>
          )}

          {/* Notes */}
          <Field label="Notes">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="w-full h-16 px-2 py-1.5 text-xs bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid resize-y"
              placeholder="Add a note…"
            />
          </Field>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border-subtle shrink-0">
          {/* Dirty-Esc warning — opacity toggle (never reflows the footer). Kept SHORT so it
              shows in full beside the fixed-width buttons; the context (a first Esc on a dirty
              panel just fired) makes the terse "Esc again to discard" clear. min-w-0 is the
              safety net; the buttons stay shrink-0 / nowrap so "Save Changes" never wraps. */}
          <span
            className="flex-1 min-w-0 truncate text-[11px] text-warning transition-opacity duration-150 pointer-events-none"
            style={{ opacity: escArmed ? 1 : 0 }}
          >
            {tt('Esc discards', 'Esc descarta')}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onClose}
              className="h-8 px-3 inline-flex items-center gap-1.5 rounded text-xs whitespace-nowrap text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
            >
              <X size={14} />
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!!regexError}
              className="h-8 px-3.5 inline-flex items-center gap-1.5 rounded text-xs font-medium whitespace-nowrap bg-accent-solid text-[color:var(--color-accent-ink)] hover:bg-accent-solid/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Check size={14} />
              Save Changes
            </button>
          </div>
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
