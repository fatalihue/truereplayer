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
  imagePath: string;
  timeout: number;
  confidence: number;
  imageBase64: string;
  browserText: string;
  newTab: boolean;
}

export interface ProfileEntry {
  name: string;
  filePath: string;
  hotkey: string | null;
  hotstring: string | null;
  hotstringInstant: boolean;
  isActive: boolean;
  hasWindowTarget: boolean;
  windowTargetProcessName: string | null;
  windowTargetWindowTitle: string | null;
  windowTargetTitleMatchMode: string;
  useRelativeCoordinates: boolean;
  bringToFocus: boolean;
  isDisabled: boolean;
}

export interface ProfileFolder {
  name: string;
  color: string;
  collapsed: boolean;
  items: string[];
  hasWindowTarget?: boolean;
  windowTargetProcessName?: string;
  windowTargetWindowTitle?: string;
  windowTargetTitleMatchMode?: string;
  useRelativeCoordinates?: boolean;
  bringToFocus?: boolean;
}

export interface ProfileOrderData {
  pinned: string[];
  folders: ProfileFolder[];
  ungroupedOrder: string[];
}

export interface SettingsState {
  customDelay: string;
  useCustomDelay: boolean;
  delayVariation: string;
  useDelayVariation: boolean;
  loopCount: string;
  enableLoop: boolean;
  loopInterval: string;
  loopIntervalEnabled: boolean;
  useCursorClick: boolean;
  cursorClickButton: string;
  recordMouse: boolean;
  recordScroll: boolean;
  recordKeyboard: boolean;
  profileKeyEnabled: boolean;
  browserSelectorEnabled: boolean;
  recordingHotkey: string;
  replayHotkey: string;
  profileKeyToggleHotkey: string;
  foregroundHotkey: string;
  alwaysOnTop: boolean;
  minimizeToTray: boolean;
  runOnStartup: boolean;
  startMinimized: boolean;
  runAsAdmin: boolean;
}

export interface ButtonStates {
  recordEnabled: boolean;
  replayEnabled: boolean;
  recordingActive: boolean;
  replayActive: boolean;
  recordButtonText: string;
  replayButtonText: string;
  canUndo: boolean;
  canRedo: boolean;
  copiedCount: number;
}

// ── App State ──

export interface AppState {
  status: 'ready' | 'recording' | 'replaying';
  actions: ActionItem[];
  highlightedActionIndex: number | null;
  profiles: ProfileEntry[];
  activeProfile: string | null;
  profileOrder: ProfileOrderData;
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
  | { type: 'profiles:updated'; payload: { profiles: ProfileEntry[]; activeProfile: string | null; profileOrder: ProfileOrderData } }
  | { type: 'settings:loaded'; payload: { settings: SettingsState } }
  | { type: 'button:states'; payload: ButtonStates }
  | { type: 'toolbar:updated'; payload: { profileName: string; actionCount: number } }
  | { type: 'statusbar:updated'; payload: { directory: string; profileName: string | null; actionCount: number } }
  | { type: 'alert:show'; payload: { message: string } }
  | { type: 'windowTarget:detected'; payload: { processName: string; windowTitle: string } }
  | { type: 'windowTarget:detectState'; payload: { detecting: boolean } }
  | { type: 'update:available'; payload: { version: string; currentVersion: string } }
  | { type: 'update:progress'; payload: { percent: number } }
  | { type: 'update:ready'; payload: Record<string, never> }
  | { type: 'update:error'; payload: { message: string } }
  | { type: 'update:none'; payload: { currentVersion: string } }
  | { type: 'browser:status'; payload: { connected: boolean } }
  | { type: 'browser:pickResult'; payload: { selector: string | null; error?: string } }
  | { type: 'browser:extensionOutdated'; payload: { currentVersion: string; expectedVersion: string } };

// ── Messages JS → C# ──

export type OutgoingMessage =
  | { type: 'ui:ready'; payload: Record<string, never> }
  | { type: 'recording:toggle'; payload: { insertIndex?: number } }
  | { type: 'replay:toggle'; payload: { loopEnabled: boolean; loopCount: string; intervalEnabled: boolean; intervalText: string } }
  | { type: 'actions:clear'; payload: Record<string, never> }
  | { type: 'actions:undo'; payload: Record<string, never> }
  | { type: 'actions:redo'; payload: Record<string, never> }
  | { type: 'actions:copy'; payload: Record<string, never> }
  | { type: 'actions:copyInternal'; payload: { indices: number[] } }
  | { type: 'actions:paste'; payload: { insertIndex: number } }
  | { type: 'actions:edit'; payload: { index: number; field: string; value: string } }
  | { type: 'actions:delete'; payload: { indices: number[] } }
  | { type: 'profile:click'; payload: { name: string } }
  | { type: 'profile:create'; payload: { name: string; folder?: string } }
  | { type: 'profile:rename'; payload: { oldName: string; newName: string } }
  | { type: 'profile:duplicate'; payload: { name: string } }
  | { type: 'profile:toggleDisable'; payload: { name: string } }
  | { type: 'profile:delete'; payload: { name: string } }
  | { type: 'profile:assignHotkey'; payload: { name: string; hotkey: string } }
  | { type: 'profile:removeHotkey'; payload: { name: string } }
  | { type: 'profile:assignHotstring'; payload: { name: string; sequence: string; instant: boolean } }
  | { type: 'profile:removeHotstring'; payload: { name: string } }
  | { type: 'profile:setWindowTarget'; payload: { name: string; processName: string; windowTitle: string; titleMatchMode: string; relativeCoordinates?: boolean; bringToFocus?: boolean } }
  | { type: 'profile:setRelativeCoordinates'; payload: { name: string; enabled: boolean } }
  | { type: 'profile:convertCoordinates'; payload: { direction: 'toRelative' | 'toAbsolute' } }
  | { type: 'profile:setBringToFocus'; payload: { name: string; enabled: boolean } }
  | { type: 'profile:removeWindowTarget'; payload: { name: string } }
  | { type: 'profile:setFolderWindowTarget'; payload: { folderName: string; processName: string; windowTitle: string; titleMatchMode: string; relativeCoordinates?: boolean; bringToFocus?: boolean } }
  | { type: 'profile:removeFolderWindowTarget'; payload: { folderName: string } }
  | { type: 'profile:detectWindow'; payload: Record<string, never> }
  | { type: 'profile:openFolder'; payload: { name: string } }
  | { type: 'profile:pin'; payload: { name: string } }
  | { type: 'profile:unpin'; payload: { name: string } }
  | { type: 'profile:createFolder'; payload: { name: string; color?: string } }
  | { type: 'profile:renameFolder'; payload: { oldName: string; newName: string } }
  | { type: 'profile:deleteFolder'; payload: { name: string } }
  | { type: 'profile:setFolderColor'; payload: { name: string; color: string } }
  | { type: 'profile:toggleFolderCollapse'; payload: { name: string } }
  | { type: 'profile:toggleFolderDisable'; payload: { name: string } }
  | { type: 'profile:moveToFolder'; payload: { profileName: string; folderName: string | null } }
  | { type: 'profile:reorder'; payload: { pinned?: string[]; folders?: ProfileFolder[]; ungroupedOrder?: string[] } }
  | { type: 'profile:save'; payload: Record<string, never> }
  | { type: 'profile:load'; payload: Record<string, never> }
  | { type: 'profile:reset'; payload: Record<string, never> }
  | { type: 'settings:change'; payload: { key: string; value: string | boolean | number } }
  | { type: 'actions:addSendText'; payload: { text: string; insertIndex?: number } }
  | { type: 'actions:editSendText'; payload: { index: number; text: string } }
  | { type: 'actions:bulkUpdateDelay'; payload: { indices: number[]; delay: number } }
  | { type: 'actions:bulkUpdateCoord'; payload: { indices: number[]; axis: 'x' | 'y'; value: string } }
  | { type: 'actions:bulkUpdateComment'; payload: { indices: number[]; comment: string } }
  | { type: 'actions:reorder'; payload: { indices: number[]; targetIndex: number } }
  | { type: 'actions:insertAction'; payload: { actionType: string; insertIndex: number } }
  | { type: 'actions:duplicate'; payload: { indices: number[] } }
  | { type: 'waitimage:recapture'; payload: { index: number } }
  | { type: 'selection:changed'; payload: { indices: number[] } }
  | { type: 'window:alwaysOnTop'; payload: { enabled: boolean } }
  | { type: 'window:minimizeToTray'; payload: { enabled: boolean } }
  | { type: 'window:runOnStartup'; payload: { enabled: boolean } }
  | { type: 'window:startMinimized'; payload: { enabled: boolean } }
  | { type: 'window:reloadUI'; payload: Record<string, never> }
  | { type: 'profile:export'; payload: { names: string[]; includeOrganization?: boolean } }
  | { type: 'profile:import'; payload: Record<string, never> }
  | { type: 'update:check'; payload: Record<string, never> }
  | { type: 'update:apply'; payload: Record<string, never> }
  | { type: 'update:dismiss'; payload: Record<string, never> }
  | { type: 'actions:addBrowserAction'; payload: { actionType: string; selector: string; browserText?: string; newTab?: boolean; insertIndex?: number } }
  | { type: 'browser:toggleRecording'; payload: { enabled: boolean } }
  | { type: 'browser:pickElement'; payload: Record<string, never> }
  | { type: 'theme:colors'; payload: { bgSurface: string; bgCard: string; textPrimary: string; textSecondary: string; accentSolid: string; borderSubtle: string } }
  | { type: 'hotkey:suppress'; payload: { enabled: boolean } };
