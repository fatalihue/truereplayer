import { createContext, useContext, useReducer, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useBridge } from '../bridge/BridgeContext';
import type { AppState, IncomingMessage } from '../bridge/messageTypes';

const defaultSettings = {
  customDelay: '100',
  useCustomDelay: true,
  delayVariation: '1',
  useDelayVariation: false,
  loopCount: '0',
  enableLoop: false,
  loopInterval: '200',
  loopIntervalEnabled: false,
  smoothMovement: true,
  moveStepPx: '20',
  moveStepDelay: '2',
  moveClickDelay: '10',
  fastApproach: true,
  settleDistance: '80',
  useCursorClick: false,
  cursorClickButton: 'Left',
  cursorClickStartHotkey: 'PageDown',
  cursorClickPauseHotkey: 'PageUp',
  // Clicker v2 — defaults match the AppSettings backend (delay=100 ms, jitter=1 %,
  // hold=10 ms, position=1 px, interval=200 ms; every switch starts off). Real values
  // arrive on settings:loaded after the post-upgrade migration (which copies the legacy
  // profile-shared delay/jitter/loops/interval into these fields). Keeping these in sync
  // with AppSettings.cs avoids a one-frame "wrong default" flash before settings:loaded
  // arrives on cold start.
  cursorClickDelay: '100',
  cursorClickDelayJitter: '1',
  cursorClickUseJitter: false,
  cursorClickHold: '10',
  cursorClickPositionJitter: '1',
  cursorClickUsePositionJitter: false,
  // null = no rect saved. useArea is the on/off toggle (preserves the rect when temporarily off).
  cursorClickUseArea: false,
  cursorClickArea: null as { x: number; y: number; w: number; h: number } | null,
  // Fixed-point mode. useFixed toggles it on; a null point = "lock on start" (capture the
  // cursor at the first click), a set point = click exactly there.
  cursorClickUseFixed: false,
  cursorClickFixedPoint: null as { x: number; y: number } | null,
  cursorClickLoops: '0',
  cursorClickUseLoops: false,
  cursorClickInterval: '200',
  cursorClickUseInterval: false,
  cursorClickMaxDuration: '60000',
  cursorClickUseMaxDuration: false,
  recordMouse: true,
  recordScroll: true,
  recordKeyboard: true,
  recordCombinedInput: true,
  profileKeyEnabled: true,
  browserSelectorEnabled: true,
  recordingHotkey: 'Ctrl+PageUp',
  replayHotkey: 'Ctrl+PageDown',
  profileKeyToggleHotkey: 'Pause',
  foregroundHotkey: 'Insert',
  modeToggleHotkey: 'ScrollLock',
  // Mirrors AppSettings.CaptureSlotHotkey so there's no wrong-value flash before
  // settings:loaded arrives. Empty still means disabled if the user clears it.
  captureSlotHotkey: 'Win+Ctrl+C',
  alwaysOnTop: false,
  minimizeToTray: true,
  runOnStartup: true,
  startMinimized: true,
  // Must match AppSettingsManager.AppSettings defaults (both opt-in) so there's
  // no wrong-value flash before settings:loaded arrives.
  runEndFlash: false,
  runEndSound: false,
  runAsAdmin: false,
  automationEnabled: true,
  remaps: { enabled: true, entries: [] as { from: string; to: string; enabled: boolean }[] },
};

const initialState: AppState = {
  status: 'ready',
  actions: [],
  dataTable: { headers: [], rows: [], loopOverData: false, onRowError: 'halt', notifyOnLapComplete: true },
  automation: { enabled: true, entries: [] },
  highlightedActionIndex: null,
  profiles: [],
  activeProfile: null,
  profileOrder: { pinned: [], folders: [], ungroupedOrder: [] },
  settings: defaultSettings,
  // Mirrors WebViewBridge's "No Profile" fallback so there's no wrong-value flash before the
  // first profile:loop / state:init lands. count '1', never '0' — 0 means forever to the engine.
  profileLoop: { count: '1', enabled: false, interval: '200', intervalEnabled: false, dirty: false, scoped: false },
  toolbar: { profileName: 'No Profile', actionCount: 0 },
  statusBar: { directory: 'Profiles', profileName: null, actionCount: 0 },
  buttonStates: {
    recordEnabled: true,
    replayEnabled: true,
    recordingActive: false,
    replayActive: false,
    recordButtonText: 'Recording',
    replayButtonText: 'Replay',
    canUndo: false,
    canRedo: false,
    copiedCount: 0,
  },
  replayChain: [],
  pauseState: { isPaused: false, hotkey: '', timeoutMs: 0, startedAt: 0 },
  // Clicker v2 — live click counter + elapsed pushed from the backend on a ~4 Hz cadence
  // during a Clicker run. The StatusBar renders "Clicked X · Y/s · MM:SS" from these.
  // `active` flips on first stats push and back off when the replay engine resets state.
  clickerStats: { active: false, count: 0, elapsedMs: 0 },
  loopProgress: { active: false, current: 0, total: 0 },
  settingsResetEpoch: 0,
};

function appStateReducer(state: AppState, message: IncomingMessage): AppState {
  switch (message.type) {
    case 'state:init':
      // Deep-merge settings (and guard profileOrder) so a partial state:init payload can't wipe
      // defaultSettings — every settings.* read downstream would otherwise crash the UI.
      return {
        ...initialState,
        ...message.payload,
        settings: { ...initialState.settings, ...(message.payload.settings ?? {}) },
        profileOrder: message.payload.profileOrder ?? initialState.profileOrder,
        automation: message.payload.automation ?? initialState.automation,
        // Same guard as settings/profileOrder: a version-skewed payload that omits the slice
        // must not make profileLoop.count undefined and blank the ActionBar chip.
        profileLoop: message.payload.profileLoop ?? initialState.profileLoop,
      };
    case 'status:changed':
      // New run starting → reset Clicker counter to zero so we don't carry over the
      // previous run's totals. Other transitions (replaying → ready, recording, etc.)
      // KEEP the last stats so the user can read the final "Clicked X · Y/s · MM:SS"
      // after the run ends. The StatusBar gates rendering on `isReplaying || count > 0`,
      // so non-Clicker replays don't trigger the Clicker counter even though the reset
      // path here is mode-agnostic.
      //
      // Also drop the per-row highlight when leaving 'replaying'. Without this the
      // last executed row stays tinted forever — confusing because nothing's running
      // anymore, and especially wrong when the user switches profiles mid-replay
      // (highlight from the old profile would survive onto a row index in the new
      // one). 'recording' and 'ready' both transition through here and don't have
      // a notion of "current action", so clearing is safe in both cases.
      return {
        ...state,
        status: message.payload.status,
        highlightedActionIndex: message.payload.status === 'replaying'
          ? state.highlightedActionIndex
          : null,
        clickerStats: message.payload.status === 'replaying'
          ? { active: true, count: 0, elapsedMs: 0 }
          : state.clickerStats,
        // Macro loop counter — same lifecycle as clickerStats. New run wipes the counter
        // so it doesn't carry over from the previous replay; 'ready' preserves the final
        // value so the user can read "Loop 100/100" briefly after the run ends.
        // `active` starts false here; first 'macro:loopProgress' push flips it true. This
        // is what keeps single-shot (non-looping) replays from showing the indicator —
        // the backend never sends loopProgress in that case.
        loopProgress: message.payload.status === 'replaying'
          ? { active: false, current: 0, total: 0 }
          : state.loopProgress,
      };
    case 'actions:updated':
      return { ...state, actions: message.payload.actions, highlightedActionIndex: null };
    case 'data:table':
      return { ...state, dataTable: message.payload };
    case 'automation:state':
      return { ...state, automation: message.payload ?? state.automation };
    case 'actions:highlight':
      return { ...state, highlightedActionIndex: message.payload.index };
    case 'profiles:updated':
      return { ...state, profiles: message.payload.profiles, activeProfile: message.payload.activeProfile, profileOrder: message.payload.profileOrder ?? state.profileOrder };
    case 'settings:loaded': {
      // Deep-merge over defaults (mirrors state:init) so a partial/version-skewed payload
      // that drops a field can't make settings.* undefined and crash downstream reads.
      const nextSettings = { ...initialState.settings, ...(message.payload.settings ?? {}) };
      // Wipe the clicker run slice when the MODE actually flips. Those stats were previously
      // cleared only on status → 'replaying', so Clicker → Macro → Clicker came back showing
      // the previous run's count, elapsed, full progress bar and "✓ finished" badge —
      // indistinguishable from a run that had just ended.
      //
      // Gated on the flip, not on every settings:loaded: this message has ~19 emitters, and
      // wiping live stats on an unrelated change (a theme switch mid-run) would be a new bug.
      // All three mode-flip paths — the ActionBar pills, the tray item and the ScrollLock
      // hotkey — push this message, so one branch covers them. SetCursorClickMode stops any
      // live run first, so there is never a run in flight to lose.
      const modeFlipped = nextSettings.useCursorClick !== state.settings.useCursorClick;
      if (!modeFlipped) return { ...state, settings: nextSettings };
      return {
        ...state,
        settings: nextSettings,
        clickerStats: { active: false, count: 0, elapsedMs: 0 },
        loopProgress: { active: false, current: 0, total: 0 },
      };
    }
    case 'profile:loop':
      // Whole-slice replace: the C# bridge is the sole owner of these values (it resolves
      // profile-vs-global and does the 1..999 clamp), so there is no local state to preserve.
      return { ...state, profileLoop: message.payload };
    case 'button:states':
      return { ...state, buttonStates: message.payload };
    case 'toolbar:updated':
      return { ...state, toolbar: message.payload };
    case 'statusbar:updated':
      return { ...state, statusBar: message.payload };
    case 'replay:chain':
      return { ...state, replayChain: message.payload.stack };
    case 'replay:paused':
      return {
        ...state,
        pauseState: {
          isPaused: true,
          hotkey: message.payload.hotkey,
          timeoutMs: message.payload.timeoutMs,
          startedAt: Date.now(),
        },
      };
    case 'replay:resumed':
      return {
        ...state,
        pauseState: { isPaused: false, hotkey: '', timeoutMs: 0, startedAt: 0 },
      };
    case 'clicker:stats':
      // Set active = true on every stats push (covers the case where the user clicks Run
      // and the very first stats batch arrives). status:changed → 'replaying' (a new run
      // starting) is the only transition that wipes clickerStats; 'ready' preserves the
      // final count so the user can read the total after the run ends.
      return {
        ...state,
        clickerStats: { active: true, count: message.payload.count, elapsedMs: message.payload.elapsedMs },
      };
    case 'macro:loopProgress':
      // Same idea as clicker:stats — first push flips `active` on, run-start in
      // status:changed wipes it. Backend only emits for genuine loops (count > 1 or
      // infinite), so a single-shot replay never lands here and the StatusBar's
      // `active`-gated render stays hidden.
      return {
        ...state,
        loopProgress: { active: true, current: message.payload.current, total: message.payload.total },
      };
    case 'settings:reset':
      // Increments on every explicit reset. SettingsPanel watches it in an effect to send
      // its non-persistent UI state (the clicker /s ↔ ms unit toggle) back to default.
      // It used to be a `key` on ClickerSection instead, but that component remounts for
      // several unrelated reasons — tab change, panel collapse — so the toggle it was meant
      // to preserve was being reset constantly; the state moved up and the epoch stayed.
      return { ...state, settingsResetEpoch: state.settingsResetEpoch + 1 };
    default:
      return state;
  }
}

const AppStateContext = createContext<AppState>(initialState);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const { subscribe } = useBridge();
  const [state, dispatch] = useReducer(appStateReducer, initialState);

  useEffect(() => {
    return subscribe((message) => {
      dispatch(message);
    });
  }, [subscribe]);

  return (
    <AppStateContext.Provider value={state}>
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  return useContext(AppStateContext);
}
