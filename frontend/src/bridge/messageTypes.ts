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
  hotstring: string | null;
  hotstringInstant: boolean;
  isActive: boolean;
  hasWindowTarget: boolean;
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
  foregroundHotkey: string;
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
  | { type: 'statusbar:updated'; payload: { directory: string; profileName: string | null; actionCount: number } }
  | { type: 'alert:show'; payload: { message: string } }
  | { type: 'windowTarget:detected'; payload: { processName: string; windowTitle: string } }
  | { type: 'update:available'; payload: { version: string; currentVersion: string } }
  | { type: 'update:progress'; payload: { percent: number } }
  | { type: 'update:ready'; payload: Record<string, never> }
  | { type: 'update:error'; payload: { message: string } };

// ── Messages JS → C# ──

export type OutgoingMessage =
  | { type: 'ui:ready'; payload: Record<string, never> }
  | { type: 'recording:toggle'; payload: { insertIndex?: number } }
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
  | { type: 'profile:assignHotstring'; payload: { name: string; sequence: string; instant: boolean } }
  | { type: 'profile:removeHotstring'; payload: { name: string } }
  | { type: 'profile:setWindowTarget'; payload: { name: string; processName: string; windowTitle: string; titleMatchMode: string } }
  | { type: 'profile:removeWindowTarget'; payload: { name: string } }
  | { type: 'profile:detectWindow'; payload: Record<string, never> }
  | { type: 'profile:openFolder'; payload: { name: string } }
  | { type: 'profile:save'; payload: Record<string, never> }
  | { type: 'profile:load'; payload: Record<string, never> }
  | { type: 'profile:reset'; payload: Record<string, never> }
  | { type: 'settings:change'; payload: { key: string; value: string | boolean | number } }
  | { type: 'actions:addSendText'; payload: { text: string; insertIndex?: number } }
  | { type: 'actions:editSendText'; payload: { index: number; text: string } }
  | { type: 'actions:bulkUpdateDelay'; payload: { indices: number[]; delay: number } }
  | { type: 'actions:reorder'; payload: { indices: number[]; targetIndex: number } }
  | { type: 'selection:changed'; payload: { indices: number[] } }
  | { type: 'window:alwaysOnTop'; payload: { enabled: boolean } }
  | { type: 'window:minimizeToTray'; payload: { enabled: boolean } }
  | { type: 'profile:export'; payload: { names: string[] } }
  | { type: 'profile:import'; payload: Record<string, never> }
  | { type: 'ui:modalOpen'; payload: Record<string, never> }
  | { type: 'ui:modalClose'; payload: Record<string, never> }
  | { type: 'update:apply'; payload: Record<string, never> }
  | { type: 'update:dismiss'; payload: Record<string, never> };
