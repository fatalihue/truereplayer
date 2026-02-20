import { createContext, useContext, useReducer, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useBridge } from '../bridge/BridgeContext';
import type { AppState, IncomingMessage } from '../bridge/messageTypes';

const defaultSettings = {
  customDelay: '100',
  useCustomDelay: true,
  loopCount: '0',
  enableLoop: false,
  loopInterval: '1000',
  loopIntervalEnabled: false,
  recordMouse: true,
  recordScroll: true,
  recordKeyboard: true,
  profileKeyEnabled: true,
  recordingHotkey: 'F9',
  replayHotkey: 'F10',
  profileKeyToggleHotkey: 'Ctrl+Shift+K',
  alwaysOnTop: false,
  minimizeToTray: false,
};

const initialState: AppState = {
  status: 'ready',
  actions: [],
  highlightedActionIndex: null,
  profiles: [],
  activeProfile: null,
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
  },
};

function appStateReducer(state: AppState, message: IncomingMessage): AppState {
  switch (message.type) {
    case 'state:init':
      return { ...message.payload };
    case 'status:changed':
      return { ...state, status: message.payload.status };
    case 'actions:updated':
      return { ...state, actions: message.payload.actions, highlightedActionIndex: null };
    case 'actions:highlight':
      return { ...state, highlightedActionIndex: message.payload.index };
    case 'profiles:updated':
      return { ...state, profiles: message.payload.profiles, activeProfile: message.payload.activeProfile };
    case 'settings:loaded':
      return { ...state, settings: message.payload.settings };
    case 'button:states':
      return { ...state, buttonStates: message.payload };
    case 'toolbar:updated':
      return { ...state, toolbar: message.payload };
    case 'statusbar:updated':
      return { ...state, statusBar: message.payload };
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
