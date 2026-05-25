import { useEffect, useMemo, useState } from 'react';
import { X, ChevronDown, MoreHorizontal } from 'lucide-react';
import { useBridge } from '../bridge/BridgeContext';
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
  onSubmit: (payload: TargetSubmitPayload) => void;
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
  // ✓/✗ can't be confused with a different config.
  type TestResult = { matches: boolean; foregroundProcess: string; foregroundTitle: string; error?: string };
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // Process picker — toggled on demand because enumerating windows is non-trivial. The list is
  // cached for the dialog's lifetime; user can refresh by closing/reopening the picker.
  type ProcEntry = { name: string; title: string };
  const [processList, setProcessList] = useState<ProcEntry[] | null>(null);
  const [showProcessPicker, setShowProcessPicker] = useState(false);
  const [processFilter, setProcessFilter] = useState('');

  // Overflow menu (⋯) in the dialog header — houses rarely-used actions like Convert
  // Coordinates so they don't take vertical space inside the dialog body. Only meaningful
  // entries today are profile-scoped (Convert), so the icon hides for folder scope.
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);

  const markEdited = () => { setEdited(true); setTestResult(null); };

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
        setTestResult(msg.payload as TestResult);
      } else if (msg.type === 'process:list') {
        const p = msg.payload as { processes: ProcEntry[] };
        setProcessList(p.processes);
      }
    });
  }, [subscribe]);

  // Esc priority (most specific → least): close any open menu (overflow / picker) →
  // cancel detection → close dialog. The transient overlays absorb Esc first so the user
  // can dismiss them without losing the dialog work; the dialog itself only closes when
  // there's nothing else to dismiss.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (showOverflowMenu) {
        setShowOverflowMenu(false);
      } else if (showProcessPicker) {
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
  }, [isDetecting, showProcessPicker, showOverflowMenu, send, onCancel]);

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

  const handleSubmit = () => {
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
    onSubmit(payload);
  };

  const submitDisabled = (!processName.trim() && !windowTitle.trim()) || regexError !== null;
  const isProfile = scope === 'profile';
  const header = isProfile ? 'Target Configuration' : 'Folder Target Configuration';
  const description = isProfile
    ? <>Configure target window for <span className="text-text-primary font-medium">'{targetLabel}'</span></>
    : <>Configure target for all profiles in <span className="text-text-primary font-medium">'{targetLabel}'</span>. Profiles with their own target override this.</>;

  // Only show the overflow menu when there's something to put in it. Today that's
  // Convert Coordinates (profile scope only). When folder scope grows its own advanced
  // actions in the future, broaden this guard.
  const hasOverflowActions = isProfile && !!onConvertCoordinates;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[380px] bg-bg-card border border-border-default rounded-lg p-5 shadow-xl">
        <div className="flex items-start justify-between mb-3 relative">
          <h3 className="text-sm font-semibold text-text-primary">{header}</h3>
          {hasOverflowActions && (
            <div className="relative">
              <button
                onClick={() => setShowOverflowMenu(v => !v)}
                title="More actions"
                className={`p-1 -mr-1 rounded transition-colors ${
                  showOverflowMenu
                    ? 'text-accent bg-bg-elevated'
                    : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-elevated'
                }`}
              >
                <MoreHorizontal size={14} />
              </button>
              {showOverflowMenu && (
                <div className="absolute top-full right-0 mt-1 min-w-[200px] bg-bg-card border border-border-default rounded shadow-lg z-20 p-1">
                  <button
                    onClick={() => { onConvertCoordinates?.('toRelative'); setShowOverflowMenu(false); }}
                    className="w-full text-left px-2.5 py-1.5 text-[11px] rounded hover:bg-bg-elevated transition-colors"
                  >
                    <div className="text-accent">Convert coords → Relative</div>
                    <div className="text-[10px] text-text-tertiary mt-0.5">Anchor clicks to the target window</div>
                  </button>
                  <button
                    onClick={() => { onConvertCoordinates?.('toAbsolute'); setShowOverflowMenu(false); }}
                    className="w-full text-left px-2.5 py-1.5 text-[11px] rounded hover:bg-bg-elevated transition-colors"
                  >
                    <div className="text-text-primary">Convert coords → Absolute</div>
                    <div className="text-[10px] text-text-tertiary mt-0.5">Use screen coordinates regardless of target</div>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
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
                  title="Pick from running processes"
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
                className={`px-2 py-0.5 text-[11px] rounded border transition-colors ${
                  titleMatchMode === 'contains'
                    ? 'bg-accent-solid/15 border-accent-solid/40 text-accent'
                    : 'bg-transparent border-border-default text-text-tertiary hover:text-text-secondary'
                }`}
              >Contains</button>
              <button
                onClick={() => { setTitleMatchMode('regex'); markEdited(); }}
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
            the "real" foreground. */}
        <button
          onClick={() => {
            setTestResult(null);
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
          className="mt-2 w-full h-7 text-[11px] text-text-secondary border border-border-default rounded hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Check whether the current config matches the window in front (excluding TrueReplayer)"
        >
          Test against foreground window
        </button>
        {testResult && (
          <div className={`mt-1.5 px-2 py-1 rounded text-[11px] leading-tight ${
            testResult.error
              ? 'bg-recording/10 text-recording border border-recording/30'
              : testResult.matches
                ? 'bg-replay/10 text-replay border border-replay/30'
                : 'bg-recording/10 text-recording border border-recording/30'
          }`}>
            {testResult.error ? (
              testResult.error
            ) : (
              <>
                <span className="font-semibold">{testResult.matches ? '✓ Matches' : '✗ No match'}</span>
                {' — '}
                <span className="font-mono">{testResult.foregroundProcess || '?'}</span>
                {testResult.foregroundTitle && (
                  <span className="text-text-tertiary"> / {testResult.foregroundTitle}</span>
                )}
              </>
            )}
          </div>
        )}

        {/* Options */}
        <div className="mt-3 pt-3 border-t border-border-subtle space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary">Relative Coordinates</span>
            <Toggle isOn={relativeCoordinates} onChange={handleToggleRelativeCoordinates} />
          </div>
          {/* Migration hint — surfaced only when the user just toggled the flag AND there
              are existing actions whose stored coords are in the OLD coord space. Without
              this nudge, the toggle silently reinterprets every stored X/Y, breaking clicks,
              WaitImage regions, and WaitPixel coords against the wrong reference frame. */}
          {convertHint && (
            <div className="flex items-start gap-2 px-2 py-1.5 text-[11px] text-amber-400 bg-amber-950/15 border border-amber-900/40 rounded">
              <span className="flex-1 leading-snug">
                {convertibleActionCount} action{convertibleActionCount === 1 ? '' : 's'} captured in {convertHint === 'toRelative' ? 'absolute' : 'relative'} coords. Convert {convertHint === 'toRelative' ? 'to relative' : 'to absolute'} so they stay anchored to this window.
              </span>
              <div className="flex gap-1 shrink-0">
                <button
                  onClick={() => {
                    onConvertCoordinates?.(convertHint);
                    setConvertHint(null);
                    setConvertHintDismissed(true);
                  }}
                  className="px-2 py-0.5 text-[10px] font-medium text-text-primary bg-accent-solid/30 hover:bg-accent-solid/50 rounded transition-colors"
                >
                  Convert
                </button>
                <button
                  onClick={() => { setConvertHint(null); setConvertHintDismissed(true); }}
                  className="px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
                  title="Skip — actions stay in their original coord space"
                >
                  Skip
                </button>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary">Bring to Focus</span>
            <Toggle isOn={bringToFocus} onChange={setBringToFocus} />
          </div>
          {/* Restore Position/Size + Update Geometry apply to both profile and folder scopes —
              folder targets inherit these to every profile inside (unless that profile overrides
              them with its own target). Convert Coordinates is profile-only because it rewrites
              the actions of the active profile, not a property of the target itself. */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary" title="Restore the target window to its saved position before replay">Restore Position</span>
            <Toggle isOn={restorePosition} onChange={setRestorePosition} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary" title="Restore the target window to its saved size before replay (un-maximizes if needed)">Restore Size</span>
            <Toggle isOn={restoreSize} onChange={setRestoreSize} />
          </div>
          {/* Convert Coordinates moved to the header overflow menu (⋯) — rarely used and
              didn't earn its vertical space here. See the dialog header above. */}
          {onUpdateGeometry && (
            <button
              onClick={() => onUpdateGeometry({
                processName: processName.trim(),
                windowTitle: windowTitle.trim(),
                titleMatchMode,
              })}
              disabled={submitDisabled}
              className="w-full h-7 text-[11px] text-text-secondary border border-border-default rounded hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Capture the current size and position of the target window matching the fields above"
            >
              Update Window Size &amp; Position
            </button>
          )}
        </div>

        <div className="flex items-center mt-4">
          {hasOwnTarget && onRemove && (
            <button
              onClick={handleRemove}
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
              onClick={handleSubmit}
              disabled={submitDisabled}
              className="px-4 py-1.5 text-xs text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-40"
            >Set Target</button>
          </div>
        </div>
      </div>
    </div>
  );
}
