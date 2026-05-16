import { createContext, useContext, useReducer, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useBridge } from '../bridge/BridgeContext';
import type { AppState, IncomingMessage } from '../bridge/messageTypes';

const defaultSettings = {
  customDelay: '100',
  useCustomDelay: true,
  delayVariation: '10',
  useDelayVariation: false,
  loopCount: '0',
  enableLoop: false,
  loopInterval: '200',
  loopIntervalEnabled: false,
  useCursorClick: false,
  cursorClickButton: 'Left',
  // Clicker v2 — defaults match the AppSettings backend (delay=100 ms, jitter=10 %,
  // hold=10 ms, position=10 px, interval=200 ms; every switch starts off). Real values
  // arrive on settings:loaded after the post-upgrade migration (which copies the legacy
  // profile-shared delay/jitter/loops/interval into these fields). Keeping these in sync
  // with AppSettings.cs avoids a one-frame "wrong default" flash before settings:loaded
  // arrives on cold start.
  cursorClickDelay: '100',
  cursorClickDelayJitter: '10',
  cursorClickUseJitter: false,
  cursorClickHold: '10',
  cursorClickPositionJitter: '10',
  cursorClickUsePositionJitter: false,
  cursorClickLoops: '0',
  cursorClickUseLoops: false,
  cursorClickInterval: '200',
  cursorClickUseInterval: false,
  recordMouse: true,
  recordScroll: true,
  recordKeyboard: true,
  profileKeyEnabled: true,
  browserSelectorEnabled: true,
  recordingHotkey: 'Ctrl+PageUp',
  replayHotkey: 'Ctrl+PageDown',
  profileKeyToggleHotkey: 'Pause',
  foregroundHotkey: 'Ctrl+Insert',
  alwaysOnTop: false,
  minimizeToTray: true,
  runOnStartup: true,
  startMinimized: true,
  runAsAdmin: false,
};

const initialState: AppState = {
  status: 'ready',
  actions: [],
  highlightedActionIndex: null,
  profiles: [],
  activeProfile: null,
  profileOrder: { pinned: [], folders: [], ungroupedOrder: [] },
  settings: defaultSettings,
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
  settingsResetEpoch: 0,
};

function appStateReducer(state: AppState, message: IncomingMessage): AppState {
  switch (message.type) {
    case 'state:init':
      return { ...initialState, ...message.payload, profileOrder: message.payload.profileOrder ?? initialState.profileOrder };
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
      };
    case 'actions:updated':
      return { ...state, actions: message.payload.actions, highlightedActionIndex: null };
    case 'actions:highlight':
      return { ...state, highlightedActionIndex: message.payload.index };
    case 'profiles:updated':
      return { ...state, profiles: message.payload.profiles, activeProfile: message.payload.activeProfile, profileOrder: message.payload.profileOrder ?? state.profileOrder };
    case 'settings:loaded':
      return { ...state, settings: message.payload.settings };
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
    case 'settings:reset':
      // Increments on every explicit reset. SettingsPanel uses this as a `key` on
      // ClickerSection so its non-persistent UI state (e.g. /s ↔ ms unit toggle) goes
      // back to default by way of a React remount.
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
