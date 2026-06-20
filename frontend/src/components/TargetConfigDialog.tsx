import { useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { useBridge } from '../bridge/BridgeContext';
import { useTt } from '../state/LanguageContext';
import { Toggle } from './common/Toggle';

type Scope = 'profile' | 'folder';

export type TargetSubmitPayload = {
  processName: string;
  windowTitle: string;
  titleMatchMode: 'contains' | 'regex';
  relativeCoordinates: boolean;
  bringToFocus: boolean;
  // Profile-only fields. Folder submits leave these undefined.
  restorePosition?: boolean;
  restoreSize?: boolean;
  // Profile-only: when true and the target fields were not edited, the backend keeps the
  // folder-inherited target and only persists the flags. Folder submits leave undefined.
  keepInheritedTarget?: boolean;
  // Profile-only: when set, the backend runs ExecuteConvertCoordinates AFTER the target
  // save completes. Used by the "Apply target & convert" path in the migration hint so
  // a single click can both persist the new target and migrate stored action coords
  // against the freshly-saved window geometry. Two-step (separate save + convert
  // messages) would race the async setWindowTarget against the sync conversion lookup.
  convertDirection?: 'toRelative' | 'toAbsolute';
};

interface TargetConfigDialogProps {
  scope: Scope;
  targetLabel: string;            // Profile or folder name shown in the header
  hasOwnTarget: boolean;          // Controls visibility of the Remove button
  // Profile-only — when true, the dialog opened over a profile that inherits its target
  // from its folder. Set Target without touching target fields keeps the inheritance.
  inheritedFromFolder?: boolean;
  initial: {
    processName: string;
    windowTitle: string;
    titleMatchMode: 'contains' | 'regex';
    relativeCoordinates: boolean;
    bringToFocus: boolean;
    restorePosition?: boolean;
    restoreSize?: boolean;
  };
  // The optional `opts.keepOpen` lets the dialog request that the parent NOT close it on
  // submit. Used by the "Apply target & convert" flow so the toast confirmation lands
  // while the user is still looking at the same dialog (instead of vanishing along with
  // it). Parent ignores the opts when undefined and closes as usual.
  onSubmit: (payload: TargetSubmitPayload, opts?: { keepOpen?: boolean }) => void;
  onRemove?: () => void;
  onCancel: () => void;
  // Profile-only callbacks. When omitted the dialog hides the corresponding UI.
  onUpdateGeometry?: (fields: { processName: string; windowTitle: string; titleMatchMode: 'contains' | 'regex' }) => void;
  onConvertCoordinates?: (direction: 'toRelative' | 'toAbsolute') => void;
  // Profile-only — count of actions whose stored coordinates would benefit from a coord-space
  // conversion when the user toggles Relative Coordinates. Triggers the inline hint that
  // suggests running "Convert to Relative/Absolute" so existing actions stay anchored to
  // the right window position. Folder scope (where actions don't live on the folder itself)
  // leaves this undefined → no hint.
  convertibleActionCount?: number;
}

export function TargetConfigDialog({
  scope,
  targetLabel,
  hasOwnTarget,
  inheritedFromFolder = false,
  initial,
  onSubmit,
  onRemove,
  onCancel,
  onUpdateGeometry,
  onConvertCoordinates,
  convertibleActionCount = 0,
}: TargetConfigDialogProps) {
  const { send, subscribe } = useBridge();
  const tt = useTt();

  const [processName, setProcessName] = useState(initial.processName);
  const [windowTitle, setWindowTitle] = useState(initial.windowTitle);
  const [titleMatchMode, setTitleMatchMode] = useState<'contains' | 'regex'>(initial.titleMatchMode);
  const [relativeCoordinates, setRelativeCoordinates] = useState(initial.relativeCoordinates);
  // Migration hint state. Fires only on the user-initiated toggle transition (off→on or
  // on→off), not on dialog open. `dismissed` mutes the hint after the user either runs the
  // convert or explicitly dismisses, so re-toggling doesn't keep nagging within one session.
  const [convertHint, setConvertHint] = useState<'toRelative' | 'toAbsolute' | null>(null);
  const [convertHintDismissed, setConvertHintDismissed] = useState(false);

  const handleToggleRelativeCoordinates = (next: boolean) => {
    setRelativeCoordinates(next);
    if (convertHintDismissed) return;
    if (convertibleActionCount === 0) return;
    if (!onConvertCoordinates) return;
    // Only show hint when state actually changed from the user's previous saved value —
    // re-toggling without saving doesn't accumulate hints, and opening the dialog with
    // rel coords already on doesn't fire it spuriously.
    if (next && !initial.relativeCoordinates) setConvertHint('toRelative');
    else if (!next && initial.relativeCoordinates) setConvertHint('toAbsolute');
    else setConvertHint(null);
  };
  const [bringToFocus, setBringToFocus] = useState(initial.bringToFocus);
  const [restorePosition, setRestorePosition] = useState(initial.restorePosition ?? false);
  const [restoreSize, setRestoreSize] = useState(initial.restoreSize ?? false);
  const [isDetecting, setIsDetecting] = useState(false);

  // Tracks whether the user explicitly edited target fields (process/title/match mode or detected
  // a new window) since opening. When false on an inherited-target profile, "Set Target" keeps
  // the folder inheritance and only persists flags. Folder scope ignores this — it's always a
  // direct set/replace at the folder level.
  const [edited, setEdited] = useState(false);

  // Result of the most recent Test Match request. Cleared when the user edits fields so a stale
  // ✓/✗ can't be confused with a different config, and auto-cleared 3.5 s after it arrives so
  // the Test button returns to its idle label (the button itself doubles as the result chip —
  // see the auto-revert effect below).
  type TestResult = { matches: boolean; foregroundProcess: string; foregroundTitle: string; error?: string };
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // Pending flag flipped on as soon as the Test button is clicked. Without it, a fast backend
  // response (sub-frame) would replace the previous colored chip with the new one before the
  // browser paints — user perceives "the button didn't change" and waits for the auto-revert
  // timer instead. The in-flight state forces a neutral "Testing…" render between clicks so
  // the visual reset is always perceivable.
  const [testInFlight, setTestInFlight] = useState(false);

  // The flag alone isn't enough on its own — when the backend round-trip is faster than a
  // single browser frame (~16 ms, common for the synchronous foreground-window check), the
  // setTestInFlight(true) on click and the setTestInFlight(false) on response can both land
  // before the paint and skip the intermediate state entirely. We track when the in-flight
  // started and enforce a minimum visible duration (200 ms) by deferring the result apply.
  // 200 ms is below the threshold where a click-response feels laggy yet long enough to be
  // clearly perceptible as a state transition.
  const testInFlightStartRef = useRef<number>(0);
  const MIN_TEST_INFLIGHT_MS = 200;

  // Auto-revert: 3.5 s after a result lands, drop it so the button returns to its neutral
  // "Test against foreground window" state. Re-runs cancel the prior timer via the cleanup
  // (testResult changes → effect re-runs → previous setTimeout cleared). Long enough to read
  // a wrapped process+title at a glance, short enough that a forgotten result doesn't masquerade
  // as a live verdict if the user comes back later.
  useEffect(() => {
    if (!testResult) return;
    const t = window.setTimeout(() => setTestResult(null), 3500);
    return () => window.clearTimeout(t);
  }, [testResult]);

  // Process picker — toggled on demand because enumerating windows is non-trivial. The list is
  // cached for the dialog's lifetime; user can refresh by closing/reopening the picker.
  type ProcEntry = { name: string; title: string };
  const [processList, setProcessList] = useState<ProcEntry[] | null>(null);
  const [showProcessPicker, setShowProcessPicker] = useState(false);
  const [processFilter, setProcessFilter] = useState('');

  const markEdited = () => { setEdited(true); setTestResult(null); setTestInFlight(false); };

  // Inline regex validation. We compile in the browser as a syntax check only — the backend
  // recompiles on its own (with timeout) for actual matching. Mirrors backend behavior: empty
  // pattern is valid (means "no title constraint"), invalid pattern blocks Set Target so the
  // user doesn't hit a generic alert after submitting.
  const regexError = useMemo(() => {
    if (titleMatchMode !== 'regex') return null;
    const trimmed = windowTitle.trim();
    if (trimmed.length === 0) return null;
    try {
      new RegExp(trimmed);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'Invalid regex pattern';
    }
  }, [titleMatchMode, windowTitle]);

  // Subscribe to detection events. Self-contained so the parent doesn't need to wire the bridge.
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'windowTarget:detected') {
        const p = msg.payload as { processName: string; windowTitle: string };
        setProcessName(p.processName);
        setWindowTitle(p.windowTitle);
        markEdited();
        setIsDetecting(false);
        setTestResult(null);
      } else if (msg.type === 'windowTarget:detectState') {
        const p = msg.payload as { detecting: boolean };
        setIsDetecting(p.detecting);
      } else if (msg.type === 'windowTarget:testResult') {
        // Enforce a minimum visible duration for the "Testing…" state. When the backend
        // returns in less than MIN_TEST_INFLIGHT_MS, defer the apply so the user perceives
        // a clean state transition (colored → neutral testing → new colored) instead of
        // a single-frame re-render that visually looks like nothing happened.
        const result = msg.payload as TestResult;
        const elapsed = Date.now() - testInFlightStartRef.current;
        const remaining = MIN_TEST_INFLIGHT_MS - elapsed;
        if (remaining <= 0) {
          setTestInFlight(false);
          setTestResult(result);
        } else {
          window.setTimeout(() => {
            setTestInFlight(false);
            setTestResult(result);
          }, remaining);
        }
      } else if (msg.type === 'windowTarget:applyConvertCompleted') {
        // Backend confirms the combined save + convert succeeded. Dismiss the hint so a
        // second click on the same button doesn't double-translate the already-converted
        // actions, and reset `edited` so the dialog reflects that the typed fields are
        // now the persisted state. The toast (alert:show) is sent separately by the
        // backend so the user sees the confirmation regardless of whether the dialog
        // stayed open or not.
        setConvertHint(null);
        setConvertHintDismissed(true);
        setEdited(false);
      } else if (msg.type === 'process:list') {
        const p = msg.payload as { processes: ProcEntry[] };
        setProcessList(p.processes);
      }
    });
  }, [subscribe]);

  // Esc priority (most specific → least): close process picker → cancel detection → close
  // dialog. The transient overlay absorbs Esc first so the user can dismiss it without
  // losing the dialog work; the dialog itself only closes when there's nothing to dismiss.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (showProcessPicker) {
        setShowProcessPicker(false);
      } else if (isDetecting) {
        // Backend treats a second detectWindow message as toggle-off.
        send({ type: 'profile:detectWindow', payload: {} });
        setIsDetecting(false);
      } else {
        onCancel();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isDetecting, showProcessPicker, send, onCancel]);

  const handleDetect = () => {
    markEdited();
    send({ type: 'profile:detectWindow', payload: {} });
  };

  // Stop detection if the dialog is dismissed while still listening for the click.
  const stopDetectionIfActive = () => {
    if (isDetecting) {
      send({ type: 'profile:detectWindow', payload: {} });
      setIsDetecting(false);
    }
  };

  const handleCancel = () => {
    stopDetectionIfActive();
    onCancel();
  };

  const handleRemove = () => {
    stopDetectionIfActive();
    onRemove?.();
  };

  // `extras` lets the migration-hint Convert button piggyback `convertDirection` onto the
  // same save round-trip — without it, the conversion would either race a separate
  // message or run against the stale (pre-save) profile target. Default {} keeps every
  // other caller (Set Target button, Enter key) on the existing semantics.
  const handleSubmit = (extras: { convertDirection?: 'toRelative' | 'toAbsolute' } = {}) => {
    stopDetectionIfActive();
    // Defense in depth — submitDisabled already covers this, but a stray Enter press could
    // bypass the click handler's disabled check on some browsers.
    if (regexError !== null) return;
    const keepInheritedTarget = scope === 'profile' && inheritedFromFolder && !edited;
    const targetEmpty = !processName.trim() && !windowTitle.trim();
    // Guard: when not keeping inheritance, target fields must have something.
    if (!keepInheritedTarget && targetEmpty) return;

    const payload: TargetSubmitPayload = {
      processName: processName.trim(),
      windowTitle: windowTitle.trim(),
      titleMatchMode,
      relativeCoordinates,
      bringToFocus,
      // Restore Position/Size apply to both scopes now — folder targets carry their own copy
      // so they can be inherited by profiles in the folder without their own override.
      restorePosition,
      restoreSize,
    };
    if (scope === 'profile') {
      payload.keepInheritedTarget = keepInheritedTarget;
    }
    if (extras.convertDirection) {
      payload.convertDirection = extras.convertDirection;
    }
    // Keep the dialog open on the combined "Apply target & convert" path so the toast
    // confirmation is visible alongside it. The dialog's own success cleanup (dismissing
    // the hint, resetting `edited`) runs when the backend emits
    // `windowTarget:applyConvertCompleted` — see the subscribe handler.
    onSubmit(payload, extras.convertDirection ? { keepOpen: true } : undefined);
  };

  const submitDisabled = (!processName.trim() && !windowTitle.trim()) || regexError !== null;

  // Hard-block the Relative Coordinates toggle from going OFF→ON without a target — rel
  // coords are by definition "relative to a window" so saving them while the dialog has
  // no process / title would lock the profile into a coord space anchored to nothing.
  // ON→OFF stays freely allowed (recovery path: profile somehow ended up with rel coords
  // but lost its target; user needs to be able to turn it off without first re-adding
  // a target). The toggle component itself styles disabled buttons with opacity-40 +
  // cursor-not-allowed; the wrapping row carries the title attr that explains why.
  const hasTargetInFields = processName.trim().length > 0 || windowTitle.trim().length > 0;
  const relativeToggleDisabled = !relativeCoordinates && !hasTargetInFields;

  // Will the Convert button in the migration hint also need to save the target? True when
  // the user has actually touched the target fields since opening (edited) AND the fields
  // are populated. When the fields are empty the conversion still falls back to the
  // currently-saved target via onConvertCoordinates — no apply step needed. When edited
  // is false the saved target hasn't changed, so a plain convert is enough.
  const convertAlsoApplies = edited && hasTargetInFields;
  const isProfile = scope === 'profile';
  const header = isProfile ? 'Target Configuration' : 'Folder Target Configuration';
  const description = isProfile
    ? <>Configure target window for <span className="text-text-primary font-medium">'{targetLabel}'</span></>
    : <>Configure target for all profiles in <span className="text-text-primary font-medium">'{targetLabel}'</span>. Profiles with their own target override this.</>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-[380px] bg-bg-card border border-border-default rounded-lg p-5 shadow-xl">
        <h3 className="text-sm font-semibold text-text-primary mb-3">{header}</h3>
        <p className="text-xs text-text-secondary mb-4">{description}</p>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-text-tertiary mb-1">Process Name</label>
            <div className="relative">
              <input
                type="text"
                value={processName}
                onChange={(e) => { setProcessName(e.target.value); markEdited(); }}
                placeholder="e.g. chrome.exe"
                className="w-full h-8 px-3 pr-14 text-xs text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
              />
              <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {processName && (
                  <button
                    onClick={() => { setProcessName(''); markEdited(); }}
                    className="p-1 text-text-disabled hover:text-text-secondary transition-colors"
                  >
                    <X size={12} />
                  </button>
                )}
                <button
                  onClick={() => {
                    const next = !showProcessPicker;
                    setShowProcessPicker(next);
                    if (next && processList === null) {
                      // Lazy fetch — first open triggers enumeration. Re-opens reuse the cache;
                      // user can refresh by closing+reopening the dialog if processes changed.
                      send({ type: 'process:list', payload: {} });
                    }
                  }}
                  data-tip={tt('Pick from running processes', 'Escolher de processos em execução')}
                  className={`p-1 transition-colors ${showProcessPicker ? 'text-accent' : 'text-text-tertiary hover:text-text-secondary'}`}
                >
                  <ChevronDown size={14} />
                </button>
              </div>
              {showProcessPicker && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-bg-card border border-border-default rounded shadow-lg z-10 max-h-64 overflow-hidden flex flex-col">
                  <input
                    type="text"
                    value={processFilter}
                    onChange={(e) => setProcessFilter(e.target.value)}
                    autoFocus
                    placeholder="Filter…"
                    className="w-full h-7 px-2 text-[11px] text-text-primary bg-bg-input border-b border-border-subtle outline-none"
                  />
                  <div className="overflow-y-auto flex-1">
                    {processList === null ? (
                      <div className="px-2 py-2 text-[11px] text-text-tertiary">Loading…</div>
                    ) : (() => {
                      const f = processFilter.trim().toLowerCase();
                      const items = f.length === 0
                        ? processList
                        : processList.filter(p =>
                            p.name.toLowerCase().includes(f) || p.title.toLowerCase().includes(f));
                      if (items.length === 0) {
                        return <div className="px-2 py-2 text-[11px] text-text-tertiary">No processes match.</div>;
                      }
                      return items.map((p) => (
                        <button
                          key={p.name}
                          onClick={() => {
                            setProcessName(p.name);
                            markEdited();
                            setShowProcessPicker(false);
                            setProcessFilter('');
                          }}
                          className="w-full text-left px-2 py-1 text-[11px] hover:bg-bg-elevated transition-colors"
                        >
                          <span className="font-mono text-text-primary">{p.name}</span>
                          {p.title && (
                            <span className="text-text-tertiary"> — {p.title}</span>
                          )}
                        </button>
                      ));
                    })()}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs text-text-tertiary mb-1">
              Window Title{titleMatchMode === 'contains' ? ' (partial match)' : ' (regex)'}
            </label>
            <div className="relative">
              <input
                type="text"
                value={windowTitle}
                onChange={(e) => { setWindowTitle(e.target.value); markEdited(); }}
                placeholder={titleMatchMode === 'contains' ? 'e.g. Notepad' : 'e.g. (Chrome|Firefox)'}
                className={`w-full h-8 px-3 pr-7 text-xs text-text-primary bg-bg-input border rounded outline-none focus:border-accent-solid ${
                  regexError ? 'border-recording/60 focus:border-recording' : 'border-border-default'
                }`}
              />
              {windowTitle && (
                <button onClick={() => { setWindowTitle(''); markEdited(); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-disabled hover:text-text-secondary transition-colors">
                  <X size={12} />
                </button>
              )}
            </div>
            {regexError && (
              <p className="text-[10px] text-recording mt-1 leading-tight">{regexError}</p>
            )}
            <div className="flex items-center gap-1.5 mt-1.5">
              <button
                onClick={() => { setTitleMatchMode('contains'); markEdited(); }}
                data-tip={tt('Match windows whose title contains this text (partial, case-insensitive)', 'Corresponde a janelas cujo título contém este texto (parcial, sem diferenciar maiúsculas)')}
                className={`px-2 py-0.5 text-[11px] rounded border transition-colors ${
                  titleMatchMode === 'contains'
                    ? 'bg-accent-solid/15 border-accent-solid/40 text-accent'
                    : 'bg-transparent border-border-default text-text-tertiary hover:text-text-secondary'
                }`}
              >Contains</button>
              <button
                onClick={() => { setTitleMatchMode('regex'); markEdited(); }}
                data-tip={tt('Match the window title against a regular expression pattern', 'Corresponde o título da janela a um padrão de expressão regular (regex)')}
                className={`px-2 py-0.5 text-[11px] rounded border transition-colors ${
                  titleMatchMode === 'regex'
                    ? 'bg-accent-solid/15 border-accent-solid/40 text-accent'
                    : 'bg-transparent border-border-default text-text-tertiary hover:text-text-secondary'
                }`}
              >Regex</button>
            </div>
          </div>
        </div>

        <button
          onClick={handleDetect}
          data-tip={tt('Click any window to auto-fill its process name and title', 'Clique em qualquer janela para preencher automaticamente seu nome de processo e título')}
          className={`mt-3 w-full h-8 text-xs border rounded transition-colors ${
            isDetecting
              ? 'text-recording border-recording/40 bg-recording/10 hover:bg-recording/20'
              : 'text-accent border-accent-solid/40 hover:bg-accent-solid/10'
          }`}
        >
          {isDetecting
            ? 'Waiting for click... (click target window)'
            : 'Detect Window (click on target)'}
        </button>

        {/* Test Match — checks current fields against whichever window the user has open behind
            the modal. The TR window itself is excluded server-side so the test reports against
            the "real" foreground. The button itself doubles as the result chip: idle = neutral
            border, success = green tint with "✓ Matches — chrome.exe", failure / error = red.
            Reverts to idle ~3.5 s after the result arrives (see the testResult useEffect).
            Keeps the row to a single 28 px line — no separate slot growing the dialog. */}
        <button
          onClick={() => {
            // Stamp the start time BEFORE setting state so the response handler can compute
            // an accurate elapsed and decide whether to defer the apply (see the
            // windowTarget:testResult branch in the subscribe useEffect).
            testInFlightStartRef.current = Date.now();
            setTestResult(null);
            setTestInFlight(true);
            send({
              type: 'profile:testWindowMatch',
              payload: {
                processName: processName.trim(),
                windowTitle: windowTitle.trim(),
                titleMatchMode,
              },
            });
          }}
          disabled={(!processName.trim() && !windowTitle.trim()) || regexError !== null}
          className={`mt-2 w-full h-7 px-2 text-[11px] border rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed overflow-hidden ${
            testInFlight
              ? 'text-text-tertiary border-border-default bg-bg-elevated/40'
              : testResult
                ? testResult.error || !testResult.matches
                  ? 'bg-recording/10 text-recording border-recording/30 hover:bg-recording/15'
                  : 'bg-replay/10 text-replay border-replay/30 hover:bg-replay/15'
                : 'text-text-secondary border-border-default hover:bg-bg-elevated'
          }`}
          data-tip={testInFlight
            ? tt('Sending test request…', 'Enviando requisição de teste…')
            : testResult
              ? (testResult.error
                  ? testResult.error
                  : `${testResult.matches ? tt('Matches', 'Corresponde') : tt('No match', 'Sem correspondência')} — ${testResult.foregroundProcess || '?'}${testResult.foregroundTitle ? ' / ' + testResult.foregroundTitle : ''}`)
              : tt('Check whether the current config matches the window in front (excluding TrueReplayer)', 'Verifica se a configuração atual corresponde à janela em primeiro plano (excluindo o TrueReplayer)')
          }
        >
          <div className="truncate">
            {testInFlight ? (
              'Testing…'
            ) : testResult ? (
              testResult.error ? (
                testResult.error
              ) : (
                <>
                  <span className="font-semibold">{testResult.matches ? '✓ Matches' : '✗ No match'}</span>
                  {testResult.foregroundProcess && (
                    <>
                      {' — '}
                      <span className="font-mono">{testResult.foregroundProcess}</span>
                    </>
                  )}
                  {testResult.foregroundTitle && (
                    <span className="opacity-70"> / {testResult.foregroundTitle}</span>
                  )}
                </>
              )
            ) : (
              'Test against foreground window'
            )}
          </div>
        </button>

        {/* Options */}
        <div className="mt-3 pt-3 border-t border-border-subtle space-y-2">
          {/* Relative Coordinates — disabled when the dialog has no target in its fields
              and the flag is currently OFF (hard block on OFF→ON to prevent the user from
              saving a profile in a coord space that can't be anchored to anything). The
              title attr on the row surfaces the reason via tooltip on hover. */}
          <div
            className="flex items-center justify-between"
            data-tip={relativeToggleDisabled
              ? tt('Set a process name or window title first — relative coordinates need a target window to anchor to.', 'Defina primeiro um nome de processo ou título de janela — coordenadas relativas precisam de uma janela-alvo para se ancorar.')
              : undefined}
          >
            <span className={`text-xs ${relativeToggleDisabled ? 'text-text-disabled' : 'text-text-secondary'}`}>Relative Coordinates</span>
            <Toggle
              isOn={relativeCoordinates}
              onChange={handleToggleRelativeCoordinates}
              disabled={relativeToggleDisabled}
            />
          </div>
          {/* Migration hint — surfaced only when the user just toggled the flag AND there
              are existing actions whose stored coords are in the OLD coord space. Without
              this nudge, the toggle silently reinterprets every stored X/Y, breaking clicks,
              WaitImage regions, and WaitPixel coords against the wrong reference frame. */}
          {convertHint && (
            // Floating toast OVERLAID on the dialog box (absolute, pinned to the bottom →
            // does NOT grow the dialog; the inline hint used to push every row down and
            // resize the box). Sits over the action-button area; opaque card + shadow so it
            // reads as a layer on top. No timeout — stays until the user converts or skips
            // (Skip clears it and reveals the buttons), same actions as the old hint.
            <div className="absolute bottom-3 left-4 right-4 flex items-start gap-2 px-3 py-2 text-[11px] text-amber-300 bg-bg-card border border-amber-700/60 rounded-lg shadow-xl z-20">
              <span className="flex-1 leading-snug">
                {convertibleActionCount} action{convertibleActionCount === 1 ? '' : 's'} captured in {convertHint === 'toRelative' ? 'absolute' : 'relative'} coords.{' '}
                {convertHint === 'toRelative'
                  ? 'Convert to relative so they follow this window when it moves.'
                  : 'Convert to absolute so they keep their current screen positions.'}
              </span>
              <div className="flex gap-1 shrink-0">
                {/* Two effective modes for this button:
                    - convertAlsoApplies: target fields were edited AND non-empty → fold
                      the save and the conversion into one submit so the backend's lookup
                      uses the freshly-saved geometry instead of the stale profile state
                      (separate save + convert messages would race the async setWindowTarget
                      against the sync conversion). Closes the dialog like a normal Set
                      Target — same effect with the conversion bolted on.
                    - else: target already saved (or fields empty and only the flag
                      changed) → keep the legacy in-place convert via onConvertCoordinates
                      so the dialog stays open for further tweaks. */}
                <button
                  onClick={() => {
                    if (convertAlsoApplies) {
                      handleSubmit({ convertDirection: convertHint });
                    } else {
                      onConvertCoordinates?.(convertHint);
                      setConvertHint(null);
                      setConvertHintDismissed(true);
                    }
                  }}
                  className="px-2 py-0.5 text-[10px] font-medium text-text-primary bg-accent-solid/30 hover:bg-accent-solid/50 rounded transition-colors"
                  data-tip={convertAlsoApplies
                    ? tt('Save the target above AND migrate stored action coords in one shot', 'Salva o alvo acima E migra as coordenadas das ações de uma vez')
                    : tt('Migrate stored action coords using the saved target', 'Migra as coordenadas das ações usando o alvo salvo')}
                >
                  {convertAlsoApplies ? 'Apply target & convert' : 'Convert'}
                </button>
                <button
                  onClick={() => { setConvertHint(null); setConvertHintDismissed(true); }}
                  className="px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
                  data-tip={tt('Skip — actions stay in their original coord space', 'Pular — as ações permanecem no seu espaço de coordenadas original')}
                >
                  Skip
                </button>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary" data-tip={tt('Bring the target window to the foreground (and un-minimize it) before replay starts', 'Traz a janela-alvo para o primeiro plano (e a desminimiza) antes de iniciar a reprodução')}>Bring to Focus</span>
            <Toggle isOn={bringToFocus} onChange={setBringToFocus} />
          </div>
          {/* Restore Position/Size + Update Geometry apply to both profile and folder scopes —
              folder targets inherit these to every profile inside (unless that profile overrides
              them with its own target). Convert Coordinates is profile-only because it rewrites
              the actions of the active profile, not a property of the target itself. */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary" data-tip={tt('Restore the target window to its saved position before replay', 'Restaura a janela-alvo para a posição salva antes da reprodução')}>Restore Position</span>
            <Toggle isOn={restorePosition} onChange={setRestorePosition} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary" data-tip={tt('Restore the target window to its saved size before replay (un-maximizes if needed)', 'Restaura a janela-alvo para o tamanho salvo antes da reprodução (desmaximiza se necessário)')}>Restore Size</span>
            <Toggle isOn={restoreSize} onChange={setRestoreSize} />
          </div>
          {onUpdateGeometry && (
            <button
              onClick={() => onUpdateGeometry({
                processName: processName.trim(),
                windowTitle: windowTitle.trim(),
                titleMatchMode,
              })}
              disabled={submitDisabled}
              className="w-full h-7 text-[11px] text-text-secondary border border-border-default rounded hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              data-tip={tt('Capture the current size and position of the target window matching the fields above', 'Captura o tamanho e a posição atuais da janela-alvo que corresponde aos campos acima')}
            >
              Update Window Size &amp; Position
            </button>
          )}
        </div>

        {/* Coordinate conversion (To Relative / To Absolute) moved to the profile's
            right-click menu → More ("Convert coords → Relative/Absolute") — it's rarely
            used, so it lives in a less prominent place now. The relative-toggle migration
            toast above still offers a one-click convert at the moment it's most relevant. */}

        <div className="flex items-center mt-4">
          {hasOwnTarget && onRemove && (
            <button
              onClick={handleRemove}
              data-tip={isProfile
                ? tt('Clear this target so the profile runs unscoped (or inherits its folder target)', 'Remove este alvo para que o perfil rode sem escopo (ou herde o alvo da pasta)')
                : tt('Clear this folder target — profiles inside fall back to their own or none', 'Remove o alvo desta pasta — os perfis dentro voltam ao próprio alvo ou a nenhum')}
              className="px-4 py-1.5 text-xs text-recording hover:text-recording/80 bg-bg-elevated rounded transition-colors"
            >Remove</button>
          )}
          <div className="flex-1" />
          <div className="flex gap-2">
            <button
              onClick={handleCancel}
              className="px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-elevated rounded transition-colors"
            >Cancel</button>
            <button
              onClick={() => handleSubmit()}
              disabled={submitDisabled}
              className="px-4 py-1.5 text-xs text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-40"
            >Set Target</button>
          </div>
        </div>
      </div>
    </div>
  );
}
