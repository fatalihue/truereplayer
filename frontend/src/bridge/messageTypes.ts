// ── Data Models ──

export interface ActionItem {
  /**
   * Stable identifier set on action creation (UUID-like). Persisted in profile.json,
   * backfilled on load for actions from pre-2.2.6 profiles. Used as the React key in
   * ActionTable so reorder/undo/redo don't break selection or highlight state. Optional
   * here only because the backend might briefly push a payload without ids during an
   * upgrade window; the frontend should still treat it as required in new code.
   */
  id?: string;
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
  isSkipped: boolean;
  // When true, a combined click is replayed twice a few pixels apart so a small target
  // (e.g. a Roblox text field at minimum window size) actually receives focus. Shown as a
  // small icon in the Action pill (no grid column); toggled from the row context menu.
  isFocusClick?: boolean;
  repeatCount?: number;
  // Keystroke action: ms gap between consecutive press cycles when repeatCount > 1.
  // null/undefined = use the global default (30 ms; matches ActionItem.DefaultRepeatDelayMs
  // on the C# side). Explicit 0 = back-to-back. Ignored when repeatCount == 1.
  repeatDelayMs?: number | null;
  // HoldKey action: how long the key stays pressed before the matching KEYUP fires.
  // 0/undefined = use the C# default (1000 ms; matches ActionItem.DefaultHoldDurationMs).
  // Clamped 10..60000 ms on every edit surface (dialog, inline, bridge).
  holdDurationMs?: number;
  // #6 — BrowserWaitElement: appears | disappears | enabled | text-match
  waitMode?: string | null;
  // #7 — BrowserNavigate: optional URL pattern + post-navigation selector
  urlWaitPattern?: string | null;
  postNavigateSelector?: string | null;
  // #5 — BrowserType options
  typeAppend?: boolean;
  typePaste?: boolean;
  typeDelay?: number | null;
  // BrowserSelectOption: how to match the option in a native <select>.
  // null/undefined = "text" mode (default). Other values: "value" | "index".
  selectMatchMode?: string | null;
  // WaitImage extras (all default-safe). null/undefined = current behaviour preserved.
  waitImageOnTimeout?: string | null;
  waitImageInvert?: boolean;
  waitImageClickOnMatch?: boolean;
  waitImageSearchX?: number | null;
  waitImageSearchY?: number | null;
  waitImageSearchW?: number | null;
  waitImageSearchH?: number | null;
  // WaitPixelColor — lighter alternative to WaitImage that watches a single screen pixel
  // for a target colour within a per-channel tolerance band. Coords are absolute virtual-
  // screen pixels (same convention as mouse-click X/Y). Reuses the `timeout` field above.
  pixelX?: number | null;
  pixelY?: number | null;
  pixelColor?: string | null;        // "#RRGGBB"
  pixelTolerance?: number;            // 0–255 per channel; default 0 = exact match
  pixelOnTimeout?: string | null;     // "Halt" | "Continue" | "StopReplay"
  pixelInvert?: boolean;              // wait for colour to DISAPPEAR
  pixelClickOnMatch?: boolean;        // left-click (X,Y) once match condition is satisfied
  // ── Conditional logic (IF / ELSE / ENDIF) ──
  // IF rows reuse the WaitImage / WaitPixelColor probe fields above. conditionType
  // selects which probe family is meaningful: "ImageFound" uses imagePath/confidence/
  // waitImageSearch*; "PixelColorMatch" uses pixelX/pixelY/pixelColor/pixelTolerance.
  // null/undefined on Else/EndIf and every non-conditional action.
  conditionType?: string | null;
  // IFNOT semantic — inverts the probe outcome so the TRUE branch fires when the
  // probe FAILS. Default false (clean JSON when unused).
  conditionNegate?: boolean;
  // null/undefined = "TreatAsFalse" (probe exception → walk FALSE branch). "Halt"
  // rethrows and stops replay. Mirrors waitImageOnTimeout's vocabulary.
  ifOnProbeError?: string | null;
}

// #2 — Selector alternative returned by the picker
export interface SelectorAlternative {
  selector: string;
  tier: 'S' | 'A' | 'B' | 'C';
  description: string;
}

// #3 — Test action result returned by the bridge
export interface BrowserTestResult {
  requestId: string;
  success: boolean;
  durationMs?: number;
  error?: { code: string; message: string; tip: string | null };
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
  // Effective target — what the hotkey gate uses. Differs from hasWindowTarget when the
  // profile inherits from its folder. The UI uses this to render the inherited badge.
  hasEffectiveTarget: boolean;
  effectiveTargetSource: 'own' | 'folder' | null;
  effectiveTargetFolderName: string | null;
  effectiveTargetProcessName: string | null;
  effectiveTargetWindowTitle: string | null;
  effectiveTargetTitleMatchMode: string;
  // Base64-encoded PNG of the effective-target .exe's icon, or null when no target
  // is set / icon extraction failed. Backend-resolved from process name via running
  // processes + App Paths registry; not persisted to disk. UI uses
  // `effectiveTargetSource` to pick opacity (own = 100 %, folder-inherited = 55 %).
  appIconBase64: string | null;
  useRelativeCoordinates: boolean;
  bringToFocus: boolean;
  restorePosition: boolean;
  restoreSize: boolean;
  triggerMode: TriggerMode;
  isDisabled: boolean;
  // ── Sharing metadata mirror (read-only on this surface; edit via profile:setMetadata) ──
  // Pushed in every profiles:updated payload so the sidebar can render icon/tag badges
  // without an extra round-trip per profile. Null fields mean "not set" — UI renders a
  // placeholder rather than an empty string.
  description?: string | null;
  tags?: string[] | null;
  iconEmoji?: string | null;
  profileVersion?: number;
  createdAt?: string | null;   // ISO 8601 UTC, e.g. "2026-05-24T12:34:56.789Z"
  updatedAt?: string | null;
  appMinVersion?: string | null;
}

// ── Sharing metadata payloads ──

/** Per-profile preview row inside an Import Preview dialog. */
export interface ImportPreviewProfile {
  name: string;
  description: string | null;
  tags: string[] | null;
  iconEmoji: string | null;
  profileVersion: number;
  createdAt: string | null;
  updatedAt: string | null;
  appMinVersion: string | null;
  /** Server-computed: false when this profile's AppMinVersion exceeds the running version. */
  compatible: boolean;
  actionCount: number;
  hotkey: string | null;
  hotstring: string | null;
  targetProcessName: string | null;
  targetWindowTitle: string | null;
  /** True when a profile with this exact name already exists locally. */
  nameConflict: boolean;
}

/** Full Import Preview payload pushed by the bridge after the user picks a .trprofile. */
export interface ImportPreviewPayload {
  fileName: string;
  envelopeVersion: number;
  exportedAt: string;
  runningVersion: string;
  hasOrganization: boolean;
  /** True when the user has never acknowledged the security warning before. */
  requiresAcknowledgement: boolean;
  profiles: ImportPreviewProfile[];
}

/** Detailed metadata payload for the Info tab. */
export interface ProfileMetadataPayload {
  name: string;
  found: boolean;
  description?: string | null;
  tags?: string[];
  iconEmoji?: string | null;
  profileVersion?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  appMinVersion?: string | null;
  /** Feature names that pinned the AppMinVersion (e.g. "WaitImage", "TriggerMode WhilePressed"). */
  appMinVersionContributors?: string[];
}

/** Tag autocomplete row, sorted by usage frequency descending. */
export interface TagListEntry {
  tag: string;
  count: number;
}

/** Per-profile conflict resolution sent with profile:confirmImport. */
export type ImportConflictResolution = 'overwrite' | 'rename' | 'skip';

export type TriggerMode = 'onPress' | 'onRelease' | 'whilePressed' | 'toggle';

export interface ProfileFolder {
  name: string;
  color: string;
  collapsed: boolean;
  items: string[];
  hasWindowTarget?: boolean;
  windowTargetProcessName?: string;
  windowTargetWindowTitle?: string;
  windowTargetTitleMatchMode?: string;
  // Base64-encoded PNG of the folder target's .exe, or null. Resolved server-side
  // alongside the profile-level icon; not persisted with the folder definition.
  appIconBase64?: string | null;
  useRelativeCoordinates?: boolean;
  bringToFocus?: boolean;
  // Inheritable Restore Position/Size + geometry. Profile inside the folder uses these unless
  // it overrides at the profile level. Geometry zero-values mean "not captured yet".
  restorePosition?: boolean;
  restoreSize?: boolean;
  windowX?: number;
  windowY?: number;
  windowWidth?: number;
  windowHeight?: number;
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
  // Smooth mouse movement (interpolated cursor path) — fixes games like Roblox that ignore a
  // single large jump. Off = legacy instant move. moveStepPx/moveStepDelay/moveClickDelay are
  // numeric strings (same convention as customDelay).
  smoothMovement: boolean;
  moveStepPx: string;
  moveStepDelay: string;
  moveClickDelay: string;
  useCursorClick: boolean;
  cursorClickButton: string;
  // Clicker v2 — dedicated Clicker settings, decoupled from the active profile. Stored
  // server-side in AppSettings (global), edited through the new ClickerPanel.
  cursorClickDelay: string;
  cursorClickDelayJitter: string;
  cursorClickUseJitter: boolean;
  cursorClickHold: string;
  cursorClickPositionJitter: string;
  cursorClickUsePositionJitter: boolean;
  // Click-area rectangle (virtual-desktop px). null = no rect saved.
  // useArea is the on/off toggle — preserves the saved rect while temporarily disabled.
  // Effective area mode = useArea && area !== null.
  cursorClickUseArea: boolean;
  cursorClickArea: { x: number; y: number; w: number; h: number } | null;
  cursorClickLoops: string;
  cursorClickUseLoops: boolean;
  cursorClickInterval: string;
  cursorClickUseInterval: boolean;
  recordMouse: boolean;
  recordScroll: boolean;
  recordKeyboard: boolean;
  recordCombinedInput: boolean;
  profileKeyEnabled: boolean;
  browserSelectorEnabled: boolean;
  recordingHotkey: string;
  replayHotkey: string;
  profileKeyToggleHotkey: string;
  foregroundHotkey: string;
  modeToggleHotkey: string;
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
  /**
   * Stack of sub-profile names currently active because of nested RunProfile
   * actions. Empty when not in a chain. Used by the status bar to render
   * "Running A → B" while a sub-profile executes.
   */
  replayChain: string[];
  /**
   * Pause action state. isPaused=true while the replay is awaiting either the
   * configured resume hotkey or timeout expiry. The status bar renders
   * "PAUSED — Press X or wait Ns" + a manual Resume button while active.
   */
  pauseState: {
    isPaused: boolean;
    hotkey: string;
    timeoutMs: number;
    startedAt: number;
  };
  /**
   * Clicker v2 — live click counter pushed from the backend during a Clicker run
   * (~4 Hz cadence, throttled in the loop). StatusBar renders "Clicked X · Y/s ·
   * MM:SS" from these. `active` flips on first push, off on status:changed (any
   * status other than 'replaying').
   */
  clickerStats: {
    active: boolean;
    count: number;
    elapsedMs: number;
  };
  /**
   * Macro loop counter — pushed during looping replays (~4 Hz throttle, plus a final push
   * when the run ends). Only set by the backend when the replay actually loops (loopCount
   * > 1 or infinite); single-shot replays leave this in its inactive default. StatusBar
   * gates rendering on `active`. `total === 0` means infinite (rendered as "Loop X/∞").
   */
  loopProgress: {
    active: boolean;
    current: number;
    total: number;
  };
  /**
   * Increments on every explicit "reset to defaults" action. Used as a `key` prop on
   * settings panels that hold non-persistent local UI state (e.g. ClickerSection's
   * /s ↔ ms unit toggle), forcing a remount so the local state goes back to its
   * default. Cheap signal that doesn't bloat AppSettings with display-only prefs.
   */
  settingsResetEpoch: number;
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
  | { type: 'windowTarget:testResult'; payload: { matches: boolean; foregroundProcess: string; foregroundTitle: string; error?: string } }
  // Backend signal that the combined "Apply target & convert" path on profile:setWindowTarget
  // completed successfully (target saved AND coords migrated). The dialog listens to dismiss
  // the migration hint and reset its `edited` flag so a second click can't re-trigger the
  // already-applied conversion. Pre-flight failures don't emit this — they alert via the
  // standard `alert:show` toast.
  | { type: 'windowTarget:applyConvertCompleted'; payload: Record<string, never> }
  | { type: 'process:list'; payload: { processes: { name: string; title: string }[] } }
  | { type: 'clipboard:content'; payload: { text: string } }
  | { type: 'replay:chain'; payload: { stack: string[] } }
  | { type: 'replay:paused'; payload: { hotkey: string; timeoutMs: number } }
  | { type: 'replay:resumed'; payload: Record<string, never> }
  | { type: 'clicker:stats'; payload: { count: number; elapsedMs: number } }
  | { type: 'macro:loopProgress'; payload: { current: number; total: number } }
  | { type: 'settings:reset'; payload: Record<string, never> }
  // Fired at the start of CheckForUpdateAsync so the overlay can show the indeterminate
  // "Checking for updates..." state (matches mockup phase 1). Resolves into update:available
  // (update found) or update:none (no update) shortly after.
  | { type: 'update:checking'; payload: Record<string, never> }
  // autoApply mirrors the backend's AutoApplyUpdates const so the overlay knows whether to
  // skip the "Download" gate (silent flow, mockup) or show the confirmation button (legacy).
  | { type: 'update:available'; payload: { version: string; currentVersion: string; notes: string[]; autoApply?: boolean } }
  | { type: 'update:progress'; payload: { percent: number } }
  | { type: 'update:ready'; payload: Record<string, never> }
  | { type: 'update:error'; payload: { message: string } }
  | { type: 'update:none'; payload: { currentVersion: string } }
  | { type: 'browser:status'; payload: { connected: boolean } }
  | { type: 'browser:pickResult'; payload: { selector: string | null; alternatives?: SelectorAlternative[]; error?: string } }
  | { type: 'browser:testResult'; payload: BrowserTestResult }
  | { type: 'browser:extensionOutdated'; payload: { currentVersion: string; expectedVersion: string } }
  | { type: 'image:testMatchResult'; payload: { requestId: string; found: boolean; score: number; x: number; y: number; w: number; h: number; error?: string } }
  | { type: 'waitimage:searchRegionSet'; payload: { requestId: string; cancelled: boolean; x?: number; y?: number; w?: number; h?: number } }
  | { type: 'clicker:areaSet'; payload: { requestId: string; cancelled: boolean; x?: number; y?: number; w?: number; h?: number } }
  | { type: 'mouse:positionPicked'; payload: { requestId: string; cancelled: boolean; x?: number; y?: number } }
  | { type: 'pixel:colorPicked'; payload: { requestId: string; cancelled: boolean; x?: number; y?: number; hex?: string } }
  | { type: 'pixel:testMatchResult'; payload: { requestId: string; matches: boolean; sampledHex?: string | null; error?: string } }
  // Fired by the backend after a capture-first insert (Wait Image / Wait Pixel)
  // to auto-open the row's editor. The user just told us where the thing lives;
  // tolerance / timeout / on-timeout / etc are next — opening the sheet skips the
  // "find the new row and click it" detour.
  | { type: 'sheet:openIndex'; payload: { index: number } }
  // Fired by the backend while CaptureHotkeyMode is active. The combo string is
  // already composed (e.g. "Win+Q", "Ctrl+Shift+F5", "ScrollUp") and the hook has
  // swallowed the underlying OS event so it doesn't trigger Start menu / shell
  // shortcuts. Hotkey dialogs subscribe to this to fill the chip.
  | { type: 'hotkey:captured'; payload: { combo: string } }
  // ── Sharing-metadata messages ──
  // Pushed in response to profile:import (replaces the old auto-execute flow). The frontend
  // shows the security warning if requiresAcknowledgement, then the Import Preview dialog,
  // then sends profile:confirmImport with the selected names.
  | { type: 'profile:importPreview'; payload: ImportPreviewPayload }
  // Pushed in response to profile:getMetadata for the Info tab.
  | { type: 'profile:metadata'; payload: ProfileMetadataPayload }
  // Pushed in response to profile:listTags for the tag autocomplete.
  | { type: 'profile:tagList'; payload: { tags: TagListEntry[] } }
  // Confirmation after profile:bumpVersion succeeds — frontend can refresh its local
  // version display without waiting for the next profiles:updated push.
  | { type: 'profile:versionBumped'; payload: { name: string; newVersion: number } }
  // Backend confirms a window-target removal completed (vs being blocked by a hotkey/hotstring
  // collision, in which case the alert path fires and this event does NOT). Frontend uses this
  // to show the success-with-Undo toast — without it, an optimistic toast would appear even
  // when the removal was blocked, contradicting the alert.
  | { type: 'profile:windowTargetRemoved'; payload: { name: string } };

// ── Messages JS → C# ──

export type OutgoingMessage =
  | { type: 'ui:ready'; payload: Record<string, never> }
  | { type: 'recording:toggle'; payload: { insertIndex?: number } }
  | { type: 'replay:toggle'; payload: { loopEnabled: boolean; loopCount: string; intervalEnabled: boolean; intervalText: string } }
  | { type: 'replay:resume'; payload: Record<string, never> }
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
  | { type: 'profile:assignHotkey'; payload: { name: string; hotkey: string; mode?: TriggerMode } }
  | { type: 'profile:removeHotkey'; payload: { name: string } }
  | { type: 'profile:assignHotstring'; payload: { name: string; sequence: string; instant: boolean } }
  | { type: 'profile:removeHotstring'; payload: { name: string } }
  | { type: 'profile:setWindowTarget'; payload: { name: string; processName: string; windowTitle: string; titleMatchMode: string; relativeCoordinates?: boolean; bringToFocus?: boolean; restorePosition?: boolean; restoreSize?: boolean; keepInheritedTarget?: boolean;
      // When set, the backend chains ExecuteConvertCoordinates after the target save
      // completes. Used by the Target Configuration dialog's "Apply target & convert"
      // path so save + conversion land atomically (no race with a separate
      // convertCoordinates message dispatched alongside this one).
      convertDirection?: 'toRelative' | 'toAbsolute' } }
  | { type: 'profile:setRelativeCoordinates'; payload: { name: string; enabled: boolean } }
  | { type: 'profile:convertCoordinates'; payload: { direction: 'toRelative' | 'toAbsolute' } }
  | { type: 'profile:updateWindowSize'; payload: { name?: string; folderName?: string; processName?: string; windowTitle?: string; titleMatchMode?: string } }
  | { type: 'profile:setBringToFocus'; payload: { name: string; enabled: boolean } }
  | { type: 'profile:setRestorePosition'; payload: { name: string; enabled: boolean } }
  | { type: 'profile:setRestoreSize'; payload: { name: string; enabled: boolean } }
  | { type: 'profile:setTriggerMode'; payload: { name: string; mode: TriggerMode } }
  | { type: 'profile:removeWindowTarget'; payload: { name: string } }
  | { type: 'profile:setFolderWindowTarget'; payload: { folderName: string; processName: string; windowTitle: string; titleMatchMode: string; relativeCoordinates?: boolean; bringToFocus?: boolean; restorePosition?: boolean; restoreSize?: boolean } }
  | { type: 'profile:removeFolderWindowTarget'; payload: { folderName: string } }
  | { type: 'profile:detectWindow'; payload: Record<string, never> }
  | { type: 'profile:testWindowMatch'; payload: { processName: string; windowTitle: string; titleMatchMode: string } }
  | { type: 'process:list'; payload: Record<string, never> }
  | { type: 'profile:openFolder'; payload: { name?: string } }
  | { type: 'profile:pin'; payload: { name: string } }
  | { type: 'profile:unpin'; payload: { name: string } }
  | { type: 'profile:createFolder'; payload: { name: string; color?: string } }
  | { type: 'profile:renameFolder'; payload: { oldName: string; newName: string } }
  | { type: 'profile:deleteFolder'; payload: { name: string } }
  | { type: 'profile:setFolderColor'; payload: { name: string; color: string } }
  | { type: 'profile:toggleFolderCollapse'; payload: { name: string } }
  // Bulk collapse/expand for the "Collapse all folders" / "Expand all folders"
  // context-menu item. One disk write regardless of folder count.
  | { type: 'profile:setAllFoldersCollapsed'; payload: { collapsed: boolean } }
  | { type: 'profile:toggleFolderDisable'; payload: { name: string } }
  | { type: 'profile:moveToFolder'; payload: { profileName: string; folderName: string | null } }
  | { type: 'profile:reorder'; payload: { pinned?: string[]; folders?: ProfileFolder[]; ungroupedOrder?: string[] } }
  | { type: 'profile:save'; payload: Record<string, never> }
  | { type: 'profile:load'; payload: Record<string, never> }
  | { type: 'profile:reset'; payload: Record<string, never> }
  | { type: 'settings:change'; payload: { key: string; value: string | boolean | number | object | null } }
  | { type: 'actions:convertMode'; payload: { direction: 'toCombined' | 'toPaired' } }
  | { type: 'actions:addSendText'; payload: { text: string; insertIndex?: number } }
  | { type: 'actions:editSendText'; payload: { index: number; text: string } }
  | { type: 'actions:bulkUpdateDelay'; payload: { indices: number[]; delay: number } }
  | { type: 'actions:bulkUpdateCoord'; payload: { indices: number[]; axis: 'x' | 'y'; value: string } }
  | { type: 'actions:bulkUpdateComment'; payload: { indices: number[]; comment: string } }
  | { type: 'actions:toggleSkip'; payload: { indices: number[] } }
  | { type: 'actions:toggleFocusClick'; payload: { indices: number[] } }
  | { type: 'actions:reorder'; payload: { indices: number[]; targetIndex: number } }
  | { type: 'actions:insertAction'; payload: { actionType: string; insertIndex: number } }
  // Pause insert (Pattern B normalization) — replaces the old "insertAction with
  // actionType=Pause then auto-open Sheet" flow. The dialog captures the resume
  // hotkey + timeout up-front; backend inserts a fully-configured row with no
  // sheet:openIndex follow-up. Either key or timeoutMs (or both) may be empty/0
  // for an infinite manual-resume Pause.
  | { type: 'actions:insertPause'; payload: { key: string; timeoutMs: number; insertIndex: number } }
  // Conditional logic — inserts a single Else row just BEFORE the EndIf that matches
  // the IF at ifRowIndex. Backend forward-scans with a stack of nested IFs to find the
  // right EndIf, so the call works in nested blocks without the caller having to track
  // depth. PushUndoState is fired so the user can Ctrl+Z the Else they just added.
  | { type: 'actions:addElseBranch'; payload: { ifRowIndex: number } }
  // Conditional logic — capture-first insert. conditionType selects which probe family
  // the new IF uses: 'ImageFound' runs the same screen overlay region-pick as WaitImage
  // and the captured image becomes the IF's reference; 'PixelColorMatch' runs the same
  // point-pick as WaitPixelColor and the captured X/Y/colour become the IF's probe data.
  // After capture, the backend inserts {If, EndIf} as a pair at insertIndex and
  // auto-opens the Sheet on the new IF row. If the user hits Esc during capture, nothing
  // is inserted — same "cancel means cancel" rule the Wait* flows follow.
  | { type: 'actions:insertConditional'; payload: { conditionType: 'ImageFound' | 'PixelColorMatch'; insertIndex: number } }
  // Conditional logic — delete the entire IF/ELSE/ENDIF block. Backend forward-scans
  // from ifRowIndex with a nested-IF stack to find the matching EndIf, then removes
  // the contiguous range [ifRowIndex..endIfIdx] inclusive (covers body + optional ELSE
  // + body + ENDIF). Wired from the row-actions menu's Delete on IF rows so deleting an
  // IF alone never orphans its body. PushUndoState fires so the deletion is reversible.
  | { type: 'actions:deleteConditional'; payload: { ifRowIndex: number } }
  // Insert a single Keystroke action (atomic combo like "Alt+Tab", "Ctrl+Shift+T").
  // Unlike insertKey which expands a single tap into a KeyDown+KeyUp pair, insertKeystroke
  // creates ONE row holding the whole combo as a "+"-joined string. The replay engine
  // expands it to the proper modifier-down → key-down → key-up → modifier-up sequence at
  // run time. Captured by KeystrokeCaptureDialog from a real keypress.
  // `repeat` / `repeatDelayMs` are optional — present when the "Press × N" insert flow
  // dispatches this message so the new row lands with RepeatCount preset; absent for
  // the regular "Send Keystroke" path which creates a single-press row (RepeatCount = 1).
  | { type: 'actions:insertKeystroke'; payload: { keystroke: string; insertIndex: number; repeat?: number; repeatDelayMs?: number } }
  // HoldKey insert — captures a single key and a hold duration (ms). Replay
  // engine emits KEYDOWN, waits holdDurationMs, then KEYUP. Default duration
  // applied server-side when holdDurationMs is absent.
  | { type: 'actions:insertHoldKey'; payload: { key: string; insertIndex: number; holdDurationMs?: number } }
  // WaitPixelColor — minimises the app, opens the screen overlay in pointPick mode,
  // and only inserts the row after the user clicks a pixel (or nothing on Esc).
  // Mirrors how WaitImage's insertion flow works, so the two actions behave the
  // same way when picked from the toolbar / context menu.
  | { type: 'actions:insertWaitPixelColor'; payload: { insertIndex: number } }
  | { type: 'actions:duplicate'; payload: { indices: number[] } }
  // Atomic replace of a contiguous range — used by the "Collapse to × N" /
  // "Expand × N" flow so N rows in becomes M rows out under one undo step.
  // The bridge handler validates bounds; replacement is the new row(s) to splice
  // in at startIndex after removing `count` existing rows.
  | { type: 'actions:replaceRange'; payload: { startIndex: number; count: number; replacement: Partial<ActionItem>[] } }
  | { type: 'actions:addRunProfile'; payload: { profileName: string; repeatCount: number; insertIndex?: number } }
  | { type: 'actions:editRunProfile'; payload: { index: number; profileName: string; repeatCount: number } }
  | { type: 'waitimage:recapture'; payload: { index: number } }
  | { type: 'waitimage:configureSearchRegion'; payload: { requestId: string; x?: number; y?: number; w?: number; h?: number } }
  | { type: 'clicker:configureArea'; payload: { requestId: string } }
  | { type: 'waitimage:cropReference'; payload: { index: number; x: number; y: number; w: number; h: number } }
  | { type: 'image:testMatch'; payload: { requestId: string; imagePath: string; confidence: number; searchRegion?: { x: number; y: number; w: number; h: number } } }
  | { type: 'mouse:pickPosition'; payload: { requestId: string } }
  | { type: 'pixel:pickColor'; payload: { requestId: string } }
  | { type: 'pixel:testMatch'; payload: { requestId: string; x: number; y: number; hex: string; tolerance: number } }
  | { type: 'selection:changed'; payload: { indices: number[] } }
  | { type: 'window:alwaysOnTop'; payload: { enabled: boolean } }
  | { type: 'window:minimizeToTray'; payload: { enabled: boolean } }
  | { type: 'window:runOnStartup'; payload: { enabled: boolean } }
  | { type: 'window:startMinimized'; payload: { enabled: boolean } }
  | { type: 'window:reloadUI'; payload: Record<string, never> }
  | { type: 'profile:export'; payload: { names: string[]; includeOrganization?: boolean } }
  | { type: 'profile:import'; payload: Record<string, never> }
  | { type: 'clipboard:read'; payload: Record<string, never> }
  | { type: 'update:check'; payload: Record<string, never> }
  | { type: 'update:apply'; payload: Record<string, never> }
  | { type: 'actions:addBrowserAction'; payload: { actionType: string; selector: string; browserText?: string; newTab?: boolean; insertIndex?: number } }
  | { type: 'browser:toggleRecording'; payload: { enabled: boolean } }
  | { type: 'browser:pickElement'; payload: Record<string, never> }
  | { type: 'browser:testAction'; payload: { requestId: string; actionType: string; key: string; browserText?: string; newTab?: boolean; timeout: number; waitMode?: string | null; urlWaitPattern?: string | null; postNavigateSelector?: string | null; typeAppend?: boolean; typePaste?: boolean; typeDelay?: number | null; selectMatchMode?: string | null } }
  | { type: 'theme:colors'; payload: { bgSurface: string; bgCard: string; textPrimary: string; textSecondary: string; accentSolid: string; borderSubtle: string } }
  | { type: 'hotkey:suppress'; payload: { enabled: boolean } }
  // Activates the backend's low-level keyboard hook in capture mode: every keydown
  // gets composed via BuildComposedKey, emitted through 'hotkey:captured', and
  // swallowed before the OS shell sees it. This is what allows binding Win+letter
  // combos that the WebView2 JS layer never receives.
  //
  // ownerId is the refcount slot key — multiple components (Pause dialog, Sheet
  // editor, Settings hotkey field, ...) can hold capture open simultaneously
  // without stomping each other on cleanup (each registers under its own ID).
  // Optional for backward compat: payloads without ownerId share a single
  // "legacy" slot, matching pre-refcount v2.3.0 behaviour exactly.
  | { type: 'hotkey:capture'; payload: { enabled: boolean; ownerId?: string } }
  // ── Sharing-metadata outgoing ──
  | { type: 'profile:getMetadata'; payload: { name: string } }
  | { type: 'profile:setMetadata'; payload: { name: string; description?: string | null; tags?: string[] | null; iconEmoji?: string | null } }
  | { type: 'profile:bumpVersion'; payload: { name: string } }
  | { type: 'profile:listTags'; payload: Record<string, never> }
  // Phase 2 of import: tell the bridge which profiles (by name) from the previously
  // previewed envelope to actually import. conflictResolutions specifies what to do
  // for each profile name that collides with an existing local profile — defaults to
  // 'rename' server-side if a conflicting profile is missing from the map (defence
  // against frontend bugs / stale previews).
  | { type: 'profile:confirmImport'; payload: { selectedNames: string[]; conflictResolutions: Record<string, ImportConflictResolution> } }
  // Sent when the user dismisses the preview without importing (cancels the security
  // warning or the Import Preview dialog). Tells the bridge to drop the server-side
  // parsed envelope so it doesn't linger in memory.
  | { type: 'profile:cancelImport'; payload: Record<string, never> }
  // Persists the "Don't show again" choice on the security warning so subsequent imports
  // skip the warning dialog.
  | { type: 'settings:acknowledgeImportWarning'; payload: Record<string, never> };
