// ── Data Models ──

export interface ActionItem {
  actionType: string;
  key: string;
  x: number;
  y: number;
  delay: number;
  comment: string;
  rowNumber: number;
  isInsertionPoint: boolean;
  shouldHighlight: boolean;
}

export interface ProfileEntry {
  name: string;
  filePath: string;
  hotkey: string | null;
  isActive: boolean;
}

export interface SettingsState {
  customDelay: string;
  useCustomDelay: boolean;
  loopCount: string;
  enableLoop: boolean;
  loopInterval: string;
  loopIntervalEnabled: boolean;
  recordMouse: boolean;
  recordScroll: boolean;
  recordKeyboard: boolean;
  profileKeyEnabled: boolean;
  recordingHotkey: string;
  replayHotkey: string;
  profileKeyToggleHotkey: string;
  alwaysOnTop: boolean;
  minimizeToTray: boolean;
}

export interface ButtonStates {
  recordEnabled: boolean;
  replayEnabled: boolean;
  recordingActive: boolean;
  replayActive: boolean;
  recordButtonText: string;
  replayButtonText: string;
}

// ── App State ──

export interface AppState {
  status: 'ready' | 'recording' | 'replaying';
  actions: ActionItem[];
  highlightedActionIndex: number | null;
  profiles: ProfileEntry[];
  activeProfile: string | null;
  settings: SettingsState;
  toolbar: {
    profileName: string;
    actionCount: number;
  };
  statusBar: {
    directory: string;
    profileName: string | null;
    actionCount: number;
  };
  buttonStates: ButtonStates;
}

// ── Messages C# → JS ──

export type IncomingMessage =
  | { type: 'state:init'; payload: AppState }
  | { type: 'status:changed'; payload: { status: AppState['status'] } }
  | { type: 'actions:updated'; payload: { actions: ActionItem[] } }
  | { type: 'actions:highlight'; payload: { index: number } }
  | { type: 'profiles:updated'; payload: { profiles: ProfileEntry[]; activeProfile: string | null } }
  | { type: 'settings:loaded'; payload: { settings: SettingsState } }
  | { type: 'button:states'; payload: ButtonStates }
  | { type: 'toolbar:updated'; payload: { profileName: string; actionCount: number } }
  | { type: 'statusbar:updated'; payload: { directory: string; profileName: string | null; actionCount: number } };

// ── Messages JS → C# ──

export type OutgoingMessage =
  | { type: 'ui:ready'; payload: Record<string, never> }
  | { type: 'recording:toggle'; payload: Record<string, never> }
  | { type: 'replay:toggle'; payload: { loopEnabled: boolean; loopCount: string; intervalEnabled: boolean; intervalText: string } }
  | { type: 'actions:clear'; payload: Record<string, never> }
  | { type: 'actions:copy'; payload: Record<string, never> }
  | { type: 'actions:edit'; payload: { index: number; field: string; value: string } }
  | { type: 'actions:delete'; payload: { indices: number[] } }
  | { type: 'profile:click'; payload: { name: string } }
  | { type: 'profile:create'; payload: { name: string } }
  | { type: 'profile:rename'; payload: { oldName: string; newName: string } }
  | { type: 'profile:delete'; payload: { name: string } }
  | { type: 'profile:assignHotkey'; payload: { name: string; hotkey: string } }
  | { type: 'profile:removeHotkey'; payload: { name: string } }
  | { type: 'profile:openFolder'; payload: { name: string } }
  | { type: 'profile:save'; payload: Record<string, never> }
  | { type: 'profile:load'; payload: Record<string, never> }
  | { type: 'profile:reset'; payload: Record<string, never> }
  | { type: 'settings:change'; payload: { key: string; value: string | boolean | number } }
  | { type: 'actions:bulkUpdateDelay'; payload: { indices: number[]; delay: number } }
  | { type: 'window:alwaysOnTop'; payload: { enabled: boolean } }
  | { type: 'window:minimizeToTray'; payload: { enabled: boolean } };
