using Microsoft.UI.Dispatching;
using Microsoft.Web.WebView2.Core;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using TrueReplayer.Controllers;
using TrueReplayer.Interop;
using TrueReplayer.Models;
using TrueReplayer.Services;

namespace TrueReplayer
{
    public class WebViewBridge : IDisposable
    {
        private bool _disposed;
        private readonly CoreWebView2 webView;
        private readonly ObservableCollection<ActionItem> actions;
        private readonly MainController mainController;
        private readonly ProfileController profileController;
        private readonly RecordingService recordingService;
        private readonly ReplayService replayService;
        private readonly DispatcherQueue dispatcherQueue;
        private readonly MainWindow window;

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        // Undo/Redo history
        private readonly Stack<string> _undoStack = new();
        private readonly Stack<string> _redoStack = new();
        private const int MaxHistory = 50;

        // Base64 cache for WaitImage / IF-Image reference PNGs, keyed by "profileName\0imagePath".
        // PushActionsUpdate and the cold-start state:init projection were re-reading + re-encoding
        // EVERY image row from disk on the UI thread on EVERY actions mutation (edit, reorder,
        // toggle, undo/redo, bulk), even when no image changed — O(N PNGs) sync File.ReadAllBytes +
        // Convert.ToBase64String per keystroke-level push. Every image mutation (capture/crop/paste/
        // import/duplicate) assigns a brand-new GUID filename to ImagePath, so a stale entry is
        // naturally superseded by the new key — no per-path invalidation is needed. The only
        // wholesale clear is in the CurrentProfileName setter (rename/delete/switch can reuse the
        // same filename under a different profile dir), which also bounds the cache's growth.
        private readonly Dictionary<string, string> _imageBase64Cache = new();

        // Internal action clipboard for copy/paste between profiles
        private List<ActionItem>? _copiedActions = null;
        // Profile name from which _copiedActions was copied — used to locate WaitImage PNGs
        // when pasting into a different profile.
        private string? _copiedSourceProfile = null;

        // In-memory settings state (replaces reading from XAML controls)
        public string CustomDelay { get; set; } = "100";
        public bool UseCustomDelay { get; set; } = true;
        public string DelayVariation { get; set; } = "1";
        public bool UseDelayVariation { get; set; } = false;
        // ── "No Profile" loop fallback ──
        // These four are the GLOBAL loop settings and nothing else: they are seeded from
        // appsettings.json, persisted by SaveGlobalSettings, and consumed by BuildLoopConfig
        // ONLY while CurrentProfileName == "No Profile". Loading a profile no longer copies
        // anything into them (see AppSettingsManager.ApplyGlobalSettings), so they can never
        // carry one profile's value into another's run. Default "1", not "0" — 0 means
        // "forever" to the engine and is no longer an authorable macro value.
        public string LoopCount { get; set; } = "1";
        public bool EnableLoop { get; set; } = false;
        public string LoopInterval { get; set; } = "200";
        public bool LoopIntervalEnabled { get; set; } = false;
        private bool _useCursorClick = false;
        public bool UseCursorClick
        {
            get => _useCursorClick;
            set
            {
                _useCursorClick = value;
                // Propagate to the hook so the global Replay hotkey gate can bypass its
                // target-foreground check while Clicker is active — Clicker doesn't replay
                // a profile-bound macro so the active profile's target is irrelevant.
                InputHookManager.IsCursorClickMode = value;
            }
        }
        public string CursorClickButton { get; set; } = "Left";
        // Clicker-exclusive hotkeys — mirrored to the hook on set (same pattern as
        // UseCursorClick → IsCursorClickMode) so a global keypress matches with no per-press
        // lookup. Default PageDown = Start/Stop, PageUp = Pause/Resume.
        private string _cursorClickStartHotkey = "PageDown";
        public string CursorClickStartHotkey
        {
            get => _cursorClickStartHotkey;
            set { _cursorClickStartHotkey = value; InputHookManager.CursorClickStartHotkey = value; }
        }
        private string _cursorClickPauseHotkey = "PageUp";
        public string CursorClickPauseHotkey
        {
            get => _cursorClickPauseHotkey;
            set { _cursorClickPauseHotkey = value; InputHookManager.CursorClickPauseHotkey = value; }
        }
        // Clicker v2 — dedicated Clicker settings, fully decoupled from the active profile.
        // Stored in AppSettings; mirrored here for fast access. Strings (not ints) to mirror
        // the existing pattern for delay/loop/interval which use textbox-backed values.
        public string CursorClickDelay { get; set; } = "100";
        public string CursorClickDelayJitter { get; set; } = "1";
        public bool CursorClickUseJitter { get; set; } = false;
        public string CursorClickHold { get; set; } = "10";
        public string CursorClickPositionJitter { get; set; } = "1";
        public bool CursorClickUsePositionJitter { get; set; } = false;
        // null = no rect saved. CursorClickUseArea is the on/off toggle and is preserved
        // separately so a user can toggle off without losing the saved rect.
        public bool CursorClickUseArea { get; set; } = false;
        public ClickArea? CursorClickArea { get; set; }
        // Fixed-point mode. UseFixed toggles it on (mutually exclusive with Area / Position);
        // FixedPoint null while on = "lock on start" (capture cursor at the first click).
        public bool CursorClickUseFixed { get; set; } = false;
        public ClickPoint? CursorClickFixedPoint { get; set; }
        public string CursorClickLoops { get; set; } = "0";
        public bool CursorClickUseLoops { get; set; } = false;
        public string CursorClickInterval { get; set; } = "0";
        public bool CursorClickUseInterval { get; set; } = false;
        // Wall-clock cap, in MS on the wire (the panel converts to seconds for display).
        public string CursorClickMaxDuration { get; set; } = "60000";
        public bool CursorClickUseMaxDuration { get; set; } = false;
        // See AppSettings.CursorClickGameMove.
        public bool CursorClickGameMove { get; set; } = false;
        public bool RecordMouse { get; set; } = true;
        public bool RecordScroll { get; set; } = true;
        public bool RecordKeyboard { get; set; } = true;
        // Combined recording toggle (single Keystroke / *Click vs paired Down+Up). Default ON.
        public bool RecordCombinedInput { get; set; } = true;
        public bool ProfileKeyEnabled { get; set; } = true;
        public bool BrowserSelectorEnabled { get; set; } = false;

        // Selection state (synced from React)
        public int? SelectedInsertIndex { get; private set; }

        // Toolbar/StatusBar state
        private string _currentProfileName = "No Profile";
        public string CurrentProfileName
        {
            get => _currentProfileName;
            set
            {
                // Switching profiles (or landing on "No Profile") invalidates the base64
                // image cache: a different profile's actions reference a different image dir,
                // and rename/delete can reuse the same filename under a new dir. Clearing on
                // any change keeps the cache from serving a stale PNG and bounds its growth.
                if (_currentProfileName != value)
                {
                    _imageBase64Cache.Clear();
                    // Same invalidation, one level up: anything captured against the OLD profile
                    // (an overlay the user is still dragging, a picker still open) must not write
                    // back into this one. The image dir is exactly what changes here.
                    Services.ProfileEpoch.Bump($"active profile '{_currentProfileName}' -> '{value}'");
                }
                _currentProfileName = value;
                // Propagate to the hook so the global Replay hotkey gate can look up the
                // active profile's target in _windowTargets — same registry that powers the
                // profile-key foreground check. "No Profile" maps to null so the gate
                // short-circuits (no profile → no target → no gating, fires as before).
                InputHookManager.ActiveProfileName = value == "No Profile" ? null : value;

                // Leaving a profile (deselect, delete-active, reset-settings — every path that
                // lands on "No Profile") must wipe the per-profile window/target context off the
                // shared static UserProfile.Current. While no profile is active, the recorder
                // (StartRecording reads UseRelativeCoordinates), the Replay button (reads
                // TargetWindow / rel-coords) and save-as-new-profile (ProfileController bakes
                // these fields in) all fall back to UserProfile.Current — so a leftover target +
                // relative coords from the previously-loaded profile would silently leak into a
                // brand-new recording. Centralised here so the invariant holds for every
                // "No Profile" transition, present and future. Selecting a real profile assigns
                // UserProfile.Current first, so this branch never runs for that path.
                if (value == "No Profile")
                    ResetCurrentProfileWindowContext();
            }
        }
        public string? CurrentProfilePath { get; set; }
        public bool HasUnsavedChanges { get; set; }

        // Clears ONLY the per-profile (serialized) window/target fields on the shared static
        // profile, so they don't leak across a "No Profile" transition (see the CurrentProfileName
        // setter for the full rationale). The [JsonIgnore] globals on UserProfile.Current —
        // hotkeys, AlwaysOnTop, ProfileKeyEnabled, record toggles, delay — are deliberately
        // left untouched because that object doubles as the live global-settings holder.
        // Loop/Interval are NOT in that list any more: they are per-profile serialized fields,
        // and under "No Profile" BuildLoopConfig reads the bridge's own mirrors instead of this
        // object, so a stale value here is never executed.
        private static void ResetCurrentProfileWindowContext()
        {
            var cur = UserProfile.Current;
            cur.TargetWindow = null;
            cur.UseRelativeCoordinates = false;
            cur.BringToFocus = false;
            cur.RestorePosition = false;
            cur.RestoreSize = false;
            cur.WindowX = 0;
            cur.WindowY = 0;
            cur.WindowWidth = 0;
            cur.WindowHeight = 0;
        }

        private readonly BrowserBridgeService? browserBridge;

        // Handlers stored as fields so Dispose can unsubscribe them. Inline lambdas would
        // create a fresh delegate instance per invocation, making -= a no-op and leaking
        // every WebViewBridge instance through the static-ish event references. These are
        // initialised once in the constructor if browserBridge is non-null.
        private Action<bool>? _onBrowserConnectionChanged;
        private Action<string, string>? _onBrowserExtensionVersionMismatch;
        private Action<string, string, string?, string?, string?, bool, IReadOnlyList<Services.BrowserBridgeService.SelectorAlternative>>? _onBrowserElementClicked;
        private Action<string, string, bool, IReadOnlyList<Services.BrowserBridgeService.SelectorAlternative>>? _onBrowserTypingCaptured;
        private Action? _onBrowserSelectInteractionStarted;
        private Action? _onBrowserSelectInteractionEnded;
        private Action<string, string, string, string, IReadOnlyList<Services.BrowserBridgeService.SelectorAlternative>>? _onBrowserSelectChanged;

        // Promoted from a captured local in the browserBridge subscribe block. Lives on the
        // instance so Dispose can stop the timer (and the lambdas can read/clear it).
        private System.Threading.Timer? _selectInteractionTimer;
        private DateTime? _selectInteractionStart;
        // Keys spared by the native-typing cleanup in the TypingCaptured handler: they
        // don't change the field's value, so the captured BrowserType text can't replay
        // their effect (submit, focus move, dismiss). "Return" is the raw name the
        // keyboard hook records (WinForms Keys enum); the friendlier variants are
        // included defensively in case the hook's naming changes. Backspace/Delete are
        // deliberately NOT spared — their effect is already reflected in the captured value.
        private static readonly HashSet<string> PreservedTypingKeys =
            new(StringComparer.OrdinalIgnoreCase) { "Return", "Enter", "Tab", "Escape", "Esc" };

        /// <summary>
        /// G1 — bridge alternatives (pipe shape) → the persisted profile shape.
        ///
        /// Returns NULL for an empty list rather than an empty list, and that is load-bearing:
        /// SelectorAlternatives is [JsonIgnore(WhenWritingNull)], so null keeps the key out of
        /// profile.json entirely. An empty array would be written, would round-trip, and would make
        /// every recorded action on a plain element look like it carries fallback data when it
        /// carries none — visible in the editor's shield indicator and in every diff of a profile
        /// that recorded nothing new.
        /// </summary>
        private static List<Models.SelectorAlternativeItem>? ToAlternativeItems(
            IReadOnlyList<Services.BrowserBridgeService.SelectorAlternative>? alternatives)
        {
            if (alternatives == null || alternatives.Count == 0) return null;
            return alternatives
                .Select(a => new Models.SelectorAlternativeItem
                {
                    Selector = a.Selector,
                    Tier = a.Tier,
                    Description = string.IsNullOrEmpty(a.Description) ? null : a.Description,
                })
                .ToList();
        }

        // Allowlist for the actions:edit "actionType" field — the exact canonical strings the
        // executor understands (ActionReplayer's combined- and paired-mode switches +
        // ActionModeConverter + the conditional-block types). An edit message could otherwise
        // stamp an arbitrary string onto a row, producing an action no execution branch handles
        // (silent no-op at replay) and a type the grid/converters don't recognize. Ordinal
        // (case-sensitive) on purpose: the mouse switch in ActionReplayer is case-sensitive, so
        // only the exact canonical spelling is a valid stored value. The frontend dropdown only
        // ever emits these spellings.
        private static readonly HashSet<string> KnownActionTypes =
            new(StringComparer.Ordinal)
            {
                "LeftClick", "RightClick", "MiddleClick", "DoubleClick",
                "LeftClickDown", "LeftClickUp",
                "RightClickDown", "RightClickUp",
                "MiddleClickDown", "MiddleClickUp",
                "ScrollUp", "ScrollDown",
                "KeyDown", "KeyUp", "HoldKey", "Keystroke",
                "SendText", "SetVariable", "CopyToSlot", "ActivateWindow",
                "WaitImage", "WaitPixelColor", "Pause", "RunProfile",
                // "Assert" is a LEAF condition row (ActionExecution's `case "Assert"` →
                // ExecuteAssert), not a block type, which is how it came to be missed here while
                // If/Else/EndIf were listed. Omitting it made this allowlist reject a real
                // executor type: an actions:edit switching a row to Assert was dropped with only a
                // DiagnosticLog.Warn, no alert, and the grid silently snapping back. The set is a
                // MIRROR of the executor's dispatch, so it is wrong whenever it is a subset —
                // a new case in ActionExecution has to be added here in the same commit.
                "If", "Else", "EndIf", "Assert",
                // Flow leaves (2.24.0+): Stop ends the run as success, Return ends the current
                // pass. Cases in ActionExecution's switch — the mirror rule above applies.
                "Stop", "Return",
                // Loop family (2.24.0+): While/ForEachRow open, EndLoop closes both,
                // BreakLoop/ContinueLoop jump within the innermost loop.
                "While", "EndLoop", "BreakLoop", "ContinueLoop", "ForEachRow",
                "BrowserClick", "BrowserRightClick", "BrowserType",
                "BrowserWaitElement", "BrowserNavigate", "BrowserSelectOption", "BrowserAssert",
            };

        // A row whose CONDITION owns image/pixel probe data — If since 2.3.0, While since the
        // loop family shipped. Every image-lifecycle site (thumbnail, paste, recapture, crop,
        // duplicate, profile-copy, coordinate conversion) must ask THIS, never "If" — or a
        // While-guarded image silently loses its lifecycle.
        private static bool IsConditionOpenerRow(ActionItem a) =>
            string.Equals(a.ActionType, "If", StringComparison.OrdinalIgnoreCase)
            || string.Equals(a.ActionType, "While", StringComparison.OrdinalIgnoreCase);

        private void EndSelectInteraction()
        {
            InputHookManager.SuppressMouseRecording = false;
            _selectInteractionTimer?.Dispose();
            _selectInteractionTimer = null;
            var interactionStart = _selectInteractionStart;
            _selectInteractionStart = null;

            // Cancel paths (blur, Esc, safety timeout) never reach the SelectChanged
            // cleanup, so the race-leaked LeftClickDown from opening the dropdown — and
            // the Esc tap that dismissed it — used to survive as orphan rows. Native
            // click rows inside the window are leaks by definition: the OS mouse hook
            // was suppressed for the whole interaction, so only the pre-flag race can
            // have produced them. (The picked path also runs this, harmlessly — the
            // SelectChanged handler does its own, wider cleanup right after.)
            if (interactionStart == null || !recordingService.IsRecording) return;
            bool removedAny = false;
            for (int i = actions.Count - 1; i >= 0 && i >= actions.Count - 8; i--)
            {
                var a = actions[i];
                if (a.RecordedAt < interactionStart.Value) continue;
                bool isNativeClick = a.ActionType is "LeftClickDown" or "LeftClickUp"
                    or "RightClickDown" or "RightClickUp" or "LeftClick" or "RightClick";
                bool isEscTap = a.ActionType is "KeyDown" or "KeyUp" or "Keystroke"
                    && (a.Key is "Escape" or "Esc");
                if (isNativeClick || isEscTap)
                {
                    actions.RemoveAt(i);
                    removedAny = true;
                }
            }
            if (removedAny) HasUnsavedChanges = true;
        }

        public WebViewBridge(
            CoreWebView2 webView,
            ObservableCollection<ActionItem> actions,
            MainController mainController,
            ProfileController profileController,
            RecordingService recordingService,
            ReplayService replayService,
            DispatcherQueue dispatcherQueue,
            MainWindow window,
            BrowserBridgeService? browserBridge = null)
        {
            this.webView = webView;
            this.actions = actions;
            this.mainController = mainController;
            this.profileController = profileController;
            this.recordingService = recordingService;
            this.replayService = replayService;
            this.dispatcherQueue = dispatcherQueue;
            this.window = window;
            this.browserBridge = browserBridge;

            // Wire the profile controller's alert callback to a frontend toast so
            // auto-repaired conditional blocks are visible to the user (today the
            // only signal is in diagnostics.log which most users won't open).
            // Marshal to the UI thread because the validator may run inside an
            // async load chain on a worker thread.
            this.profileController.OnAlert = message =>
            {
                if (_disposed) return;
                dispatcherQueue.TryEnqueue(() => SendMessage("alert:show", new { message }));
            };

            // Watch for browser extension events
            if (browserBridge != null)
            {
                _onBrowserConnectionChanged = (connected) =>
                {
                    if (_disposed) return;
                    dispatcherQueue.TryEnqueue(() => SendMessage("browser:status", new { connected }));
                };
                browserBridge.ConnectionChanged += _onBrowserConnectionChanged;

                _onBrowserExtensionVersionMismatch = (currentVersion, expectedVersion) =>
                {
                    if (_disposed) return;
                    dispatcherQueue.TryEnqueue(() => SendMessage("browser:extensionOutdated", new { currentVersion, expectedVersion }));
                };
                browserBridge.ExtensionVersionMismatch += _onBrowserExtensionVersionMismatch;

                _onBrowserElementClicked = (selector, description, url, tagName, button, isInput, alternatives) =>
                {
                    if (_disposed) return;
                    dispatcherQueue.TryEnqueue(() =>
                    {
                        if (!recordingService.IsRecording) return;

                        // Remove native click events recorded in the last 500ms (duplicates of this browser click)
                        var cutoff = DateTime.UtcNow.AddMilliseconds(-500);
                        for (int i = actions.Count - 1; i >= 0 && i >= actions.Count - 4; i--)
                        {
                            var a = actions[i];
                            if (a.ActionType is "LeftClickDown" or "LeftClickUp" or "RightClickDown" or "RightClickUp" or "LeftClick" or "RightClick"
                                && a.RecordedAt >= cutoff)
                                actions.RemoveAt(i);
                        }

                        int delay = int.TryParse(CustomDelay, out var d) ? d : 100;
                        // Input fields → BrowserType with empty text (user fills in later)
                        var actionType = isInput ? "BrowserType"
                            : button == "right" ? "BrowserRightClick"
                            : "BrowserClick";
                        var action = new ActionItem
                        {
                            ActionType = actionType,
                            Key = selector,
                            Comment = description,
                            Delay = delay,
                            Timeout = 5000,
                            // G1 — recorded actions now carry the same ranked fallbacks a picked one
                            // does. Before this, only the crosshair produced them, so a recording was
                            // a single candidate resting on generateSelector's last resort.
                            SelectorAlternatives = ToAlternativeItems(alternatives)
                        };
                        actions.Add(action);
                        HasUnsavedChanges = true;
                        mainController.UpdateButtonStates();
                    });
                };
                browserBridge.ElementClicked += _onBrowserElementClicked;

                // #10 — Typing observed in a recorded input field. Locate the most recent
                // matching BrowserType action for the same selector and fill its text.
                _onBrowserTypingCaptured = (selector, text, isAppend, alternatives) =>
                {
                    if (_disposed) return;
                    dispatcherQueue.TryEnqueue(() =>
                    {
                        if (!recordingService.IsRecording) return;
                        if (string.IsNullOrEmpty(text)) return;

                        // The keys this typing produced were ALSO recorded natively by the OS
                        // keyboard hook — left in place they'd double-type at replay (native
                        // keystrokes + BrowserType text). Walk the contiguous key-row tail and
                        // wipe them BEFORE locating the BrowserType: long bursts (>8 rows) used
                        // to push the field's action out of the 8-row search window below,
                        // producing a duplicate BrowserType instead of filling the original.
                        // Non-text keys (Enter/Tab/Esc) are preserved — they carry intent
                        // (submit / focus move) that the captured value can't express. Native
                        // click rows are skipped, not a stop: the outside-click that blurred
                        // the field reaches the OS hook before this message clears the pipe,
                        // so its LeftClickDown may already sit at the tail (the ElementClicked
                        // dedup removes it moments later). The walk stops at any other row
                        // (normally the BrowserType created by the field click), so keys typed
                        // before the field was focused survive.
                        for (int i = actions.Count - 1; i >= 0; i--)
                        {
                            var row = actions[i];
                            if (row.ActionType is "LeftClickDown" or "LeftClickUp" or "RightClickDown"
                                or "RightClickUp" or "LeftClick" or "RightClick") continue;
                            if (row.ActionType is not ("KeyDown" or "KeyUp" or "Keystroke")) break;
                            if (!PreservedTypingKeys.Contains(row.Key ?? "")) actions.RemoveAt(i);
                        }

                        for (int i = actions.Count - 1; i >= 0 && i >= actions.Count - 8; i--)
                        {
                            var a = actions[i];
                            if (a.ActionType == "BrowserType" && a.Key == selector)
                            {
                                a.BrowserText = (a.BrowserText ?? "") + text;
                                a.TypeAppend = isAppend;
                                HasUnsavedChanges = true;
                                PushActionsUpdate();
                                return;
                            }
                        }

                        // No matching BrowserType found (e.g. user typed without clicking field via extension);
                        // append a fresh action so the keystrokes aren't lost.
                        // The matched-row path above deliberately does NOT touch SelectorAlternatives:
                        // the click that created that row already stored the list computed at the same
                        // instant, and overwriting it here with a list computed after the user typed
                        // (and after the page reacted) would be a downgrade, not a refresh.
                        int delay = int.TryParse(CustomDelay, out var d) ? d : 100;
                        actions.Add(new ActionItem
                        {
                            ActionType = "BrowserType",
                            Key = selector,
                            BrowserText = text,
                            TypeAppend = isAppend,
                            Delay = delay,
                            Timeout = 5000,
                            SelectorAlternatives = ToAlternativeItems(alternatives)
                        });
                        HasUnsavedChanges = true;
                        mainController.UpdateButtonStates();
                    });
                };
                browserBridge.TypingCaptured += _onBrowserTypingCaptured;

                // Native <select> value changed during recording — auto-create a
                // BrowserSelectOption action with "text" match mode (most stable across
                // session reloads since option text is what the user sees). Strips out
                // any stray BrowserClick on the same selector that may have slipped
                // through (content.js already skips clicks on SELECT, but defensive).
                // Bracketing events around a native <select> interaction.
                //
                // The OS-level mouse hook fires BEFORE the content.js mousedown listener can
                // notify the bridge — that's ~50-200 ms of round-trip (DOM event → chrome
                // runtime → native pipe → C# bridge → InputHookManager flag). So even with
                // suppression, the very first LeftClickDown leaks into the recorder. We
                // track the interaction's start timestamp (back-dated by a 500 ms buffer to
                // cover the race window) and wipe everything recorded after it when the
                // change/end signal arrives. Duration-independent — works for users that
                // take 30 s between open and pick.
                // (_selectInteractionTimer / _selectInteractionStart / EndSelectInteraction
                //  promoted to instance members so Dispose can stop the timer cleanly.)
                _onBrowserSelectInteractionStarted = () =>
                {
                    if (_disposed) return;
                    dispatcherQueue.TryEnqueue(() =>
                    {
                        if (!recordingService.IsRecording) return;
                        InputHookManager.SuppressMouseRecording = true;
                        // Back-date the start by 500 ms so the race-leaked LeftClickDown
                        // is inside our cleanup window when change fires.
                        _selectInteractionStart = DateTime.UtcNow.AddMilliseconds(-500);
                        // 15 s safety net — if for any reason the end signal is lost (page
                        // navigated away mid-pick, content script crashed, etc.) the flag
                        // clears itself so subsequent recording isn't permanently broken.
                        _selectInteractionTimer?.Dispose();
                        _selectInteractionTimer = new System.Threading.Timer(_ =>
                        {
                            dispatcherQueue.TryEnqueue(EndSelectInteraction);
                        }, null, 15000, System.Threading.Timeout.Infinite);
                    });
                };
                browserBridge.SelectInteractionStarted += _onBrowserSelectInteractionStarted;

                _onBrowserSelectInteractionEnded = () =>
                {
                    if (_disposed) return;
                    dispatcherQueue.TryEnqueue(EndSelectInteraction);
                };
                browserBridge.SelectInteractionEnded += _onBrowserSelectInteractionEnded;

                _onBrowserSelectChanged = (selector, description, selectedText, _selectedValue, alternatives) =>
                {
                    if (_disposed) return;
                    dispatcherQueue.TryEnqueue(() =>
                    {
                        // Snapshot the start time before EndSelectInteraction nulls it out.
                        // Without the snapshot the cleanup below would fall back to a 3 s
                        // window, defeating the whole point of the interaction-bounded fix.
                        var interactionStart = _selectInteractionStart;
                        EndSelectInteraction();

                        if (!recordingService.IsRecording) return;

                        // Wipe native click rows recorded since the interaction started.
                        // Covers the OS-hook race-window leak (the LeftClickDown that
                        // beat our flag by ~50-200 ms). When start wasn't seen for some
                        // reason, fall back to a 3 s window — same behaviour as before
                        // the bracketing events were added.
                        var cutoff = interactionStart ?? DateTime.UtcNow.AddMilliseconds(-3000);
                        for (int i = actions.Count - 1; i >= 0 && i >= actions.Count - 8; i--)
                        {
                            var a = actions[i];
                            if (a.RecordedAt < cutoff) continue;
                            if (a.ActionType is "LeftClickDown" or "LeftClickUp" or "RightClickDown" or "RightClickUp" or "LeftClick" or "RightClick")
                                actions.RemoveAt(i);
                            else if (a.ActionType == "BrowserClick" && a.Key == selector)
                                actions.RemoveAt(i);
                        }

                        int delay = int.TryParse(CustomDelay, out var d) ? d : 100;
                        actions.Add(new ActionItem
                        {
                            ActionType = "BrowserSelectOption",
                            Key = selector,
                            BrowserText = selectedText,
                            Comment = description,
                            // SelectMatchMode stays null = "text" default (most readable; option
                            // text is what the user clicked on visually).
                            Delay = delay,
                            Timeout = 5000,
                            SelectorAlternatives = ToAlternativeItems(alternatives)
                        });
                        HasUnsavedChanges = true;
                        mainController.UpdateButtonStates();
                    });
                };
                browserBridge.SelectChanged += _onBrowserSelectChanged;
            }

            // Watch for actions collection changes
            actions.CollectionChanged += OnActionsChanged;

            // Seed bridge state from saved global settings
            var saved = AppSettingsManager.Load();
            CustomDelay = saved.CustomDelay.ToString();
            UseCustomDelay = saved.UseCustomDelay;
            DelayVariation = saved.DelayVariation.ToString();
            UseDelayVariation = saved.UseDelayVariation;
            LoopCount = saved.LoopCount.ToString();
            EnableLoop = saved.EnableLoop;
            LoopInterval = saved.LoopInterval.ToString();
            LoopIntervalEnabled = saved.LoopIntervalEnabled;
            // Always start in Macro mode (never restore Clicker across launches). The PERSISTED
            // flag is already normalized to Macro in Program.Main — before the tray icon reads it —
            // so `saved.UseCursorClick` is false here; we force the runtime value too, defensively.
            UseCursorClick = false;
            CursorClickButton = saved.CursorClickButton;
            // Mirror the saved clicker hotkeys into the hook (the property setters do the mirror).
            // DropBareWheelHotkey: a bare ScrollUp/ScrollDown could be captured and saved by
            // older builds, but the hook only dispatches MODIFIED wheel combos as global
            // hotkeys (swallowing a bare wheel event would kill that scroll direction
            // system-wide). Such a value has never fired; clearing it stops the panel from
            // displaying a key that does nothing.
            CursorClickStartHotkey = DropBareWheelHotkey(saved.CursorClickStartHotkey, nameof(saved.CursorClickStartHotkey));
            CursorClickPauseHotkey = DropBareWheelHotkey(saved.CursorClickPauseHotkey, nameof(saved.CursorClickPauseHotkey));
            // Clicker v2 — migrate from the legacy "Clicker reuses profile settings" behaviour
            // on first launch after upgrade. The sentinel CursorClickDelayMs == -1 means
            // "fresh appsettings.json or freshly upgraded from v1.9.53 or earlier" — copy the
            // active profile's customDelay / jitter / loops / interval so users feel zero
            // change. Persist immediately so the migration only runs once.
            if (saved.CursorClickDelayMs < 0)
            {
                saved.CursorClickDelayMs = saved.CustomDelay;
                saved.CursorClickDelayJitterPct = saved.DelayVariation;
                saved.CursorClickUseJitter = saved.UseDelayVariation;
                saved.CursorClickLoops = saved.LoopCount;
                saved.CursorClickUseLoops = saved.EnableLoop;
                saved.CursorClickIntervalMs = saved.LoopInterval;
                saved.CursorClickUseInterval = saved.LoopIntervalEnabled;
                // CursorClickHoldMs, CursorClickDelayJitterPct, CursorClickPositionJitter, and
                // CursorClickIntervalMs keep their AppSettings field defaults (10 ms / 10 % /
                // 10 px / 200 ms) — these are sensible starting values that don't take effect
                // until their companion switch is turned ON.
                AppSettingsManager.Save(saved);
            }
            // Clamped on the way IN, not just on the way out. appsettings.json is hand-editable
            // and never passes through HandleSettingsChange, so this is the only place an
            // out-of-range value can be corrected before it reaches the UI — otherwise the panel
            // displays a number every run silently ignores.
            CursorClickDelay = ClampNumeric(saved.CursorClickDelayMs.ToString(), 1, 60000, 100);
            CursorClickDelayJitter = ClampNumeric(saved.CursorClickDelayJitterPct.ToString(), 0, 100, 1);
            CursorClickUseJitter = saved.CursorClickUseJitter;
            CursorClickHold = ClampNumeric(saved.CursorClickHoldMs.ToString(), 0, 2000, 10);
            CursorClickPositionJitter = ClampNumeric(saved.CursorClickPositionJitter.ToString(), 0, 500, 1);
            CursorClickUsePositionJitter = saved.CursorClickUsePositionJitter;
            CursorClickUseArea = saved.CursorClickUseArea;
            // Project the 5 on-disk fields into the in-memory ClickArea record. Null when
            // dimensions are unset (forward-compat with appsettings.json files that pre-date
            // the area feature).
            CursorClickArea = (saved.CursorClickAreaW > 0 && saved.CursorClickAreaH > 0)
                ? new ClickArea(saved.CursorClickAreaX, saved.CursorClickAreaY, saved.CursorClickAreaW, saved.CursorClickAreaH)
                : null;
            CursorClickUseFixed = saved.CursorClickUseFixed;
            CursorClickFixedPoint = saved.CursorClickFixedPointSet
                ? new ClickPoint(saved.CursorClickFixedX, saved.CursorClickFixedY)
                : null;
            CursorClickLoops = ClampNumeric(saved.CursorClickLoops.ToString(), 0, 100000, 0);
            CursorClickUseLoops = saved.CursorClickUseLoops;
            CursorClickInterval = ClampNumeric(saved.CursorClickIntervalMs.ToString(), 0, 60000, 0);
            CursorClickUseInterval = saved.CursorClickUseInterval;
            // 24 h ceiling: past that the cap is indistinguishable from unbounded, and it keeps
            // a typo from parking the number somewhere meaningless.
            // Floor 1000, same as the settings:change handler. A stored 0 with the toggle ON
            // would run unbounded while the panel displayed 60s (its `|| 60000` fallback turns
            // 0 into 60) — "no limit" is expressed by the toggle, never by the value.
            CursorClickMaxDuration = ClampNumeric(saved.CursorClickMaxDurationMs.ToString(), 1000, 86400000, 60000);
            CursorClickUseMaxDuration = saved.CursorClickUseMaxDuration;
            CursorClickGameMove = saved.CursorClickGameMove;
            RecordMouse = saved.RecordMouse;
            RecordScroll = saved.RecordScroll;
            RecordKeyboard = saved.RecordKeyboard;
            RecordCombinedInput = saved.RecordCombinedInput;
            // Profile Keys always start ON (never restore a paused state across launches) — the
            // persisted flag is already normalized to true in Program.Main before the tray icon
            // reads it; force the runtime value here too, defensively. See also UseCursorClick above.
            ProfileKeyEnabled = true;
            BrowserSelectorEnabled = saved.BrowserSelectorEnabled;
        }

        // ── Send message to React ──

        public void SendMessage(string type, object payload)
        {
            // Skip entirely when the bridge has been disposed — the dispatcher queue may
            // still accept enqueues, but invoking PostWebMessageAsJson on a torn-down
            // WebView2 throws InvalidOperationException. Late status pushes (e.g. from
            // a background task that finishes after the window closed) would otherwise
            // spam Debug output.
            if (_disposed) return;
            try
            {
                var msg = new { type, payload };
                var json = JsonSerializer.Serialize(msg, JsonOptions);
                dispatcherQueue.TryEnqueue(() =>
                {
                    if (_disposed) return;
                    try { webView.PostWebMessageAsJson(json); }
                    catch (Exception ex)
                    {
                        // ObjectDisposedException / InvalidOperationException are expected
                        // during teardown; other exceptions deserve visibility.
                        if (ex is not ObjectDisposedException && ex is not InvalidOperationException)
                            System.Diagnostics.Debug.WriteLine($"[Bridge] PostWebMessageAsJson failed: {ex.Message}");
                    }
                });
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[Bridge] SendMessage error: {ex.Message}");
            }
        }

        // ── Handle message from React ──

        public void HandleMessage(string jsonMessage)
        {
            try
            {
                using var doc = JsonDocument.Parse(jsonMessage);
                var root = doc.RootElement;
                var type = root.GetProperty("type").GetString();
                var payload = root.GetProperty("payload");

                switch (type)
                {
                    case "ui:ready": HandleUIReady(); break;
                    case "recording:toggle": HandleRecordingToggle(payload); break;
                    case "replay:toggle": HandleReplayToggle(); break;
                    case "replay:resume": HandleReplayResume(payload); break;
                    case "replay:inputResult": HandleInputResult(payload); break;
                    case "replay:variablesRequest": replayService.RequestVariablesSnapshot(); break;
                    case "replay:reportRequest": PushRunReport(); break;
                    case "clicker:pause": replayService.PauseClicker(); break;
                    case "actions:clear": HandleActionsClear(); break;
                    case "actions:undo": HandleUndo(); break;
                    case "actions:redo": HandleRedo(); break;
                    case "actions:copy": HandleActionsCopy(); break;
                    case "actions:copyInternal": HandleActionsCopyInternal(payload); break;
                    case "actions:paste": HandleActionsPaste(payload); break;
                    case "actions:edit": HandleActionsEdit(payload); break;
                    case "actions:delete": HandleActionsDelete(payload); break;
                    case "actions:replaceRange": HandleActionsReplaceRange(payload); break;
                    case "actions:addSendText": HandleAddSendText(payload); break;
                    case "actions:editSendText": HandleEditSendText(payload); break;
                    case "actions:bulkUpdateDelay": HandleBulkUpdateDelay(payload); break;
                    case "actions:bulkUpdateCoord": HandleBulkUpdateCoord(payload); break;
                    case "actions:bulkUpdateComment": HandleBulkUpdateComment(payload); break;
                    case "actions:toggleSkip": HandleActionsToggleSkip(payload); break;
                    case "actions:toggleFocusClick": HandleActionsToggleFocusClick(payload); break;
                    case "actions:resetCycle": HandleActionsResetCycle(payload); break;
                    case "actions:resetRow": HandleActionsResetRow(); break;
                    case "data:request": HandleDataRequest(); break;
                    case "data:save": HandleDataSave(payload); break;
                    case "automation:request": PushAutomationState(); break;
                    case "automation:save": HandleAutomationSave(payload); break;
                    case "automation:setArmed": HandleAutomationSetArmed(payload); break;
                    case "automation:setEnabled": HandleAutomationSetEnabled(payload); break;
                    case "automation:captureImage": HandleAutomationCaptureImage(payload); break;
                    case "automation:cropReference": HandleAutomationCropReference(payload); break;
                    case "automation:testFire": HandleAutomationTestFire(payload); break;
                    case "remap:save": HandleRemapSave(payload); break;
                    case "actions:reorder": HandleActionsReorder(payload); break;
                    case "actions:convertMode": HandleConvertActionMode(payload); break;
                    case "actions:insertAction": HandleInsertAction(payload); break;
                    case "actions:addElseBranch": HandleActionsAddElseBranch(payload); break;
                    case "actions:insertConditional": HandleActionsInsertConditional(payload); break;
                    case "actions:insertLoop": HandleActionsInsertLoop(payload); break;
                    case "actions:deleteLoop": HandleActionsDeleteLoop(payload); break;
                    case "actions:insertAssert": HandleActionsInsertAssert(payload); break;
                    case "actions:deleteConditional": HandleActionsDeleteConditional(payload); break;
                    case "actions:insertKeystroke": HandleInsertKeystroke(payload); break;
                    case "actions:insertHoldKey": HandleInsertHoldKey(payload); break;
                    case "actions:insertPause": HandleInsertPause(payload); break;
                    case "actions:duplicate": HandleDuplicateActions(payload); break;
                    case "actions:addRunProfile": HandleAddRunProfile(payload); break;
                    case "actions:editRunProfile": HandleEditRunProfile(payload); break;
                    case "waitimage:recapture": HandleWaitImageRecapture(payload); break;
                    case "actions:insertWaitPixelColor": HandleInsertWaitPixelColor(payload); break;
                    case "waitimage:configureSearchRegion": _ = HandleConfigureSearchRegionAsync(payload); break;
                    case "clicker:configureArea": _ = HandleConfigureClickAreaAsync(payload); break;
                    case "clicker:configurePoint": _ = HandleConfigureClickPointAsync(payload); break;
                    case "waitimage:cropReference": HandleCropReference(payload); break;
                    case "image:testMatch": _ = HandleTestMatchAsync(payload); break;
                    case "mouse:pickPosition": _ = HandleMousePickPositionAsync(payload); break;
                    case "pixel:pickColor": _ = HandlePixelColorPickAsync(payload); break;
                    case "pixel:testMatch": HandlePixelColorTestMatch(payload); break;
                    case "actions:addBrowserAction": HandleAddBrowserAction(payload); break;
                    case "browser:toggleRecording": HandleBrowserToggleRecording(payload); break;
                    case "browser:pickElement": HandlePickElement(payload); break;
                    case "browser:cancelPick": browserBridge?.CancelPickElement(); break;
                    case "browser:testAction": _ = HandleBrowserTestAction(payload); break;
                    case "browser:testCondition": _ = HandleBrowserTestCondition(payload); break;
                    case "profile:click": HandleProfileClick(payload); break;
                    case "profile:create": HandleProfileCreate(payload); break;
                    case "profile:rename": HandleProfileRename(payload); break;
                    case "profile:duplicate": HandleProfileDuplicate(payload); break;
                    case "profile:toggleDisable": HandleProfileToggleDisable(payload); break;
                    case "profile:delete": HandleProfileDelete(payload); break;
                    case "profile:assignHotkey": HandleProfileAssignHotkey(payload); break;
                    case "profile:removeHotkey": HandleProfileRemoveHotkey(payload); break;
                    case "profile:assignHotstring": HandleProfileAssignHotstring(payload); break;
                    case "profile:removeHotstring": HandleProfileRemoveHotstring(payload); break;
                    case "profile:setWindowTarget": HandleProfileSetWindowTarget(payload); break;
                    case "profile:setRelativeCoordinates": HandleSetRelativeCoordinates(payload); break;
                    case "profile:setBringToFocus": HandleSetBringToFocus(payload); break;
                    case "profile:setRestorePosition": HandleProfileSetRestorePosition(payload); break;
                    case "profile:setRestoreSize": HandleProfileSetRestoreSize(payload); break;
                    case "profile:setTriggerMode": HandleProfileSetTriggerMode(payload); break;
                    case "profile:removeWindowTarget": HandleProfileRemoveWindowTarget(payload); break;
                    case "profile:setFolderWindowTarget": HandleSetFolderWindowTarget(payload); break;
                    case "profile:removeFolderWindowTarget": HandleRemoveFolderWindowTarget(payload); break;
                    case "profile:detectWindow": HandleProfileDetectWindow(); break;
                    case "profile:testWindowMatch": HandleTestWindowMatch(payload); break;
                    case "window:testProbe": HandleWindowTestProbe(payload); break;
                    case "window:captureGeometry": HandleWindowCaptureGeometry(payload); break;
                    case "dialog:pickFile": HandleDialogPickFile(payload); break;
                    case "process:list": HandleProcessList(); break;
                    case "profile:openFolder": HandleProfileOpenFolder(payload); break;
                    case "profile:pin": HandleProfilePin(payload); break;
                    case "profile:unpin": HandleProfileUnpin(payload); break;
                    case "profile:createFolder": HandleCreateFolder(payload); break;
                    case "profile:renameFolder": HandleRenameFolder(payload); break;
                    case "profile:deleteFolder": HandleDeleteFolder(payload); break;
                    case "profile:toggleFolderDisable": HandleToggleFolderDisable(payload); break;
                    case "profile:setFolderColor": HandleSetFolderColor(payload); break;
                    case "profile:toggleFolderCollapse": HandleToggleFolderCollapse(payload); break;
                    case "profile:setAllFoldersCollapsed": HandleSetAllFoldersCollapsed(payload); break;
                    case "profile:moveToFolder": HandleMoveToFolder(payload); break;
                    case "profile:reorder": HandleProfileReorder(payload); break;
                    case "profile:export": HandleProfileExport(payload); break;
                    case "profile:import": HandleProfileImport(); break;
                    // ── Sharing metadata (Info tab + Import Preview) ──
                    case "profile:getMetadata": HandleProfileGetMetadata(payload); break;
                    case "profile:setMetadata": HandleProfileSetMetadata(payload); break;
                    case "profile:bumpVersion": HandleProfileBumpVersion(payload); break;
                    case "profile:listTags": HandleProfileListTags(); break;
                    case "profile:confirmImport": HandleProfileConfirmImport(payload); break;
                    case "profile:cancelImport": HandleProfileCancelImport(); break;
                    case "file:revealExport": HandleFileRevealExport(payload); break;
                    case "settings:acknowledgeImportWarning": HandleAcknowledgeImportWarning(); break;
                    case "profile:save": HandleProfileSave(); break;
                    case "profile:load": HandleProfileLoad(); break;
                    case "profile:convertCoordinates": HandleConvertCoordinates(payload); break;
                    case "profile:updateWindowSize": HandleUpdateWindowSize(payload); break;
                    case "profile:reset": HandleProfileReset(); break;
                    case "selection:changed": HandleSelectionChanged(payload); break;
                    case "settings:change": HandleSettingsChange(payload); break;
                    case "window:alwaysOnTop": HandleAlwaysOnTop(payload); break;
                    case "window:minimizeToTray": HandleMinimizeToTray(payload); break;
                    case "window:runOnStartup": HandleRunOnStartup(payload); break;
                    case "window:startMinimized": HandleStartMinimized(payload); break;
                    case "window:runEndFlash": HandleRunEndFlash(payload); break;
                    case "window:runEndSound": HandleRunEndSound(payload); break;
                    case "window:reloadUI": try { var url = webView.Source; webView.Navigate(url); } catch (Exception rex) { DiagnosticLog.Error("window:reloadUI navigation failed", rex); } break;
                    case "update:check": _ = CheckForUpdateAsync(); break;
                    case "update:apply": _ = HandleUpdateApply(); break;
                    case "logs:openFolder":
                        // Surfaces the diagnostic logs from the command palette (previously
                        // reachable only via the tray menu). Mirrors TrayIconService.OnOpenLogsFolder.
                        try
                        {
                            var logsDir = DiagnosticLog.LogDirectory;
                            if (!string.IsNullOrEmpty(logsDir) && System.IO.Directory.Exists(logsDir))
                                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                                {
                                    FileName = "explorer.exe",
                                    Arguments = $"\"{logsDir}\"",
                                    UseShellExecute = true,
                                });
                            else
                                DiagnosticLog.Warn("logs:openFolder — log directory missing");
                        }
                        catch (Exception ex) { DiagnosticLog.Error("logs:openFolder failed", ex); }
                        break;
                    case "clipboard:read": _ = HandleClipboardRead(); break;
                    case "hotkey:suppress": HandleHotkeySuppress(payload); break;
                    case "hotkey:capture": HandleHotkeyCapture(payload); break;
                    case "theme:colors": HandleThemeColors(payload); break;
                    default:
                        System.Diagnostics.Debug.WriteLine($"[Bridge] Unknown message type: {type}");
                        break;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[Bridge] HandleMessage error: {ex.Message}");
            }
        }

        // ── Helpers ──

        private static string TriggerModeToString(Models.TriggerMode mode) => mode switch
        {
            Models.TriggerMode.OnPress => "onPress",
            Models.TriggerMode.OnRelease => "onRelease",
            Models.TriggerMode.WhilePressed => "whilePressed",
            Models.TriggerMode.Toggle => "toggle",
            Models.TriggerMode.DoubleTap => "doubleTap",
            Models.TriggerMode.Hold => "hold",
            _ => "onPress"
        };

        private static Models.TriggerMode TriggerModeFromString(string? s) => s switch
        {
            "onRelease" => Models.TriggerMode.OnRelease,
            "whilePressed" => Models.TriggerMode.WhilePressed,
            "toggle" => Models.TriggerMode.Toggle,
            "doubleTap" => Models.TriggerMode.DoubleTap,
            "hold" => Models.TriggerMode.Hold,
            _ => Models.TriggerMode.OnPress
        };

        // ── Push methods (C# → React) ──

        // Previous run status — lets PushStatusChange detect the replaying→ready
        // edge (a run just finished) for the out-of-window notification below.
        private string _lastRunStatus = "ready";

        public void PushStatusChange(string status)
        {
            bool wasError = status.StartsWith("error:");
            if (wasError)
            {
                SendMessage("alert:show", new { message = status[6..] });
                status = "ready";
            }
            // "ready:stopped" = the run ended because the USER stopped it (Stop
            // hotkey, WhilePressed release, clicker toggle-off). Same READY state
            // for the frontend, but no run-end notification — a deliberate stop is
            // not "something finished in the background".
            bool userStopped = status == "ready:stopped";
            if (userStopped) status = "ready";

            // Out-of-window run-end cue: when a replay finishes on its own (or any
            // run errors) the TrueReplayer window is usually BEHIND the game — the
            // only place the status pills render is the only place the user can't
            // see. Pulse the taskbar button (and optionally chime) when we're not
            // foreground.
            if (status == "ready" && (wasError || (_lastRunStatus == "replaying" && !userStopped)))
                NotifyRunEnded(wasError);
            else if (status == "ready")
                // Run ended down a path that raises no end-of-run cue (notably a user Stop, or
                // a profile so short the status never registered "replaying"). The lap notice
                // has already fired on its own by then; just clear the chime-suppression flag
                // so it can't mute the NEXT run's ordinary cue.
                _lapNoticeJustFired = false;
            // Push the run report as the run ENDS, so the panel is already populated when the user
            // opens it after watching something fail — asking them to hit refresh at the moment
            // they most want an answer is the wrong shape. Cheap: one message per run, and only
            // when a run actually finished.
            if (status == "ready" && _lastRunStatus == "replaying") PushRunReport();
            _lastRunStatus = status;

            // Reflect the live run-state in the tray hover tooltip (Replaying…/Recording…/idle).
            // Cheap: SetRunState no-ops when the state is unchanged.
            TrayIconService.SetRunState(status);

            SendMessage("status:changed", new { status });
            PushButtonStates();

            // When replay ends (naturally or via stop), clear any lingering WhilePressed hold state
            // in the input hook so a stale release doesn't try to stop a non-running replay.
            if (status == "ready")
                InputHookManager.ClearActiveHold();

            // Sync browser extension: recording on only when status is "recording" AND browserSelectorEnabled
            browserBridge?.SetRecordingMode(status == "recording" && BrowserSelectorEnabled);
        }

        // Reads (and caches) a reference image as base64. See _imageBase64Cache for the
        // caching rationale — the read is the only sync File.ReadAllBytes + base64 on the
        // actions-push hot path, so memoizing it removes the per-mutation re-encode cost.
        private string GetImageBase64Cached(string profileName, string imagePath)
        {
            string cacheKey = profileName + "\0" + imagePath;
            if (_imageBase64Cache.TryGetValue(cacheKey, out var cached))
                return cached;
            string b64 = ImageStorageService.ReadAsBase64(profileName, imagePath) ?? "";
            // Only memoize a SUCCESSFUL read. Caching an empty result (missing file / transient IO /
            // a wrong-profile key) would pin the grid placeholder for the WHOLE session — this cache
            // is otherwise cleared only on a profile-name change. Skipping the cache on "" lets a
            // one-off miss self-heal on the next actions push once the file is resolvable again.
            if (b64.Length > 0)
                _imageBase64Cache[cacheKey] = b64;
            return b64;
        }

        // Single source of truth for the per-action DTO sent to React. Both the
        // actions:updated push (PushActionsUpdate) and the cold-start state:init
        // payload (HandleUIReady) project actions identically — field names, order,
        // base64-cache usage, and null handling MUST stay in lock-step (the Medium
        // base64-cache fix previously had to be applied in both places). Keeping one
        // copy here removes that drift risk. Each element is boxed as object so the
        // anonymous shape can cross a method boundary; System.Text.Json serializes the
        // runtime (anonymous) type for an `object`, so the wire JSON is unchanged
        // (same pattern already used by cursorClickArea below).
        private object[] ProjectActionsForFrontend()
        {
            string profileName = CurrentProfileName != "No Profile" ? CurrentProfileName : "default";
            return actions.Select((a, i) => (object)new
            {
                // Stable id for React reconciliation. Brand-new actions inserted during this
                // session have an Id assigned by ActionItem's default constructor; old-profile
                // actions get one backfilled by SettingsManager.MigrateActionIds on load.
                id = a.Id,
                actionType = a.ActionType,
                key = a.Key ?? "",
                keyHtml = a.KeyHtml,
                keyMarkdown = a.KeyMarkdown,
                sendMode = a.SendMode,
                x = a.X,
                y = a.Y,
                delay = a.Delay,
                comment = a.Comment ?? "",
                rowNumber = i + 1,
                isInsertionPoint = a.IsInsertionPoint,
                shouldHighlight = a.ShouldHighlight,
                imagePath = a.ImagePath ?? "",
                timeout = a.Timeout,
                confidence = a.Confidence,
                // IF Image rows reuse the same imagePath storage as WaitImage, so the
                // Sheet panel's thumbnail + "Test match" + "Configure region" buttons all
                // need the base64 to operate. Without the IF check here the Sheet opens
                // "empty" right after a capture even though the row's ImagePath is set.
                imageBase64 = !string.IsNullOrEmpty(a.ImagePath) && (
                        a.ActionType == "WaitImage"
                        || (IsConditionOpenerRow(a) && string.Equals(a.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase)))
                    ? GetImageBase64Cached(profileName, a.ImagePath)
                    : "",
                // WaitImage extras (forwarded so the editor restores their state)
                waitImageOnTimeout = a.WaitImageOnTimeout,
                waitImageInvert = a.WaitImageInvert,
                waitImageClickOnMatch = a.WaitImageClickOnMatch,
                waitImageSearchX = a.WaitImageSearchX,
                waitImageSearchY = a.WaitImageSearchY,
                waitImageSearchW = a.WaitImageSearchW,
                waitImageSearchH = a.WaitImageSearchH,
                // WaitPixelColor — same pattern as the WaitImage extras above. Skipping
                // these silently wipes the user's saved coords/colour/tolerance on the
                // next push, because the editor sees `undefined` and treats it as
                // "field is empty" on the round-trip back through actions:edit.
                pixelX = a.PixelX,
                pixelY = a.PixelY,
                pixelColor = a.PixelColor,
                pixelTolerance = a.PixelTolerance,
                pixelOnTimeout = a.PixelOnTimeout,
                pixelInvert = a.PixelInvert,
                pixelClickOnMatch = a.PixelClickOnMatch,
                // Conditional logic (IF / ELSE / ENDIF). Forwarding these is mandatory —
                // PushActionsUpdate is the *only* path the frontend learns of these fields,
                // so omitting them means the editor seeds them as undefined on every reopen
                // and the grid pill always falls back to "if image" because conditionType
                // looks unset. Dropped on the wire for non-If rows (System.Text.Json omits
                // nulls in anonymous-type round-trip), so the cost on non-conditional rows
                // is just three JSON-property checks per push.
                conditionType = a.ConditionType,
                loopMaxIterations = a.LoopMaxIterations,
                conditionNegate = a.ConditionNegate,
                ifOnProbeError = a.IfOnProbeError,
                conditionTimeout = a.ConditionTimeout,
                // If Window / If Clipboard probe fields — same forwarding-is-mandatory rule
                // as the conditional fields above (this projection is the frontend's only
                // source for them).
                windowProcessName = a.WindowProcessName,
                windowTitle = a.WindowTitle,
                windowTitleMatchMode = a.WindowTitleMatchMode,
                windowMatchForegroundOnly = a.WindowMatchForegroundOnly,
                clipboardPatternType = a.ClipboardPatternType,
                clipboardPattern = a.ClipboardPattern,
                // If Random / If Variable / If File / If Time probe fields — same
                // forwarding-is-mandatory rule (this projection is the frontend's only source).
                randomPercent = a.RandomPercent,
                conditionOperator = a.ConditionOperator,
                conditionOperand = a.ConditionOperand,
                filePath = a.FilePath,
                timeStart = a.TimeStart,
                timeEnd = a.TimeEnd,
                daysOfWeek = a.DaysOfWeek,
                browserText = a.BrowserText ?? "",
                newTab = a.NewTab,
                isSkipped = a.IsSkipped,
                isFocusClick = a.IsFocusClick,
                repeatCount = a.RepeatCount,
                // RunProfile data-loop Phase C — projected as a plain bool (null = false)
                // so the editor toggle and grid detail render without null-juggling.
                runOverData = a.RunOverData == true,
                // Keystroke × N inter-cycle gap. Forwarded so the edit dialog can
                // restore the user's chosen delay (and the Keystroke replay loop
                // on the C# side already reads it from the action's own property).
                repeatDelayMs = a.RepeatDelayMs,
                // Keystroke × N gap jitter (±%). Same forward-so-the-editor-restores-it
                // rationale as repeatDelayMs above; the replay loop reads the property directly.
                repeatDelayJitterPct = a.RepeatDelayJitterPct,
                // Click × N position jitter (±px). Same forward-so-the-editor-restores-it
                // rationale; without it the Sheet reopens with the row's scatter switched off
                // and a plain Save would silently wipe it.
                repeatPositionJitterPx = a.RepeatPositionJitterPx,
                // HoldKey duration — without this, the frontend's badge / edit
                // dialog never see the value the user set, fall back to a
                // hardcoded 1000 ms default, and every "press for X seconds"
                // round-trips back as 1 s. (This was the actual root cause of
                // the "badge always shows 1s" bug — the DTO had been hand-
                // assembled here and the new property was forgotten.)
                holdDurationMs = a.HoldDurationMs,
                // New browser action fields (must be forwarded so the editor restores their state)
                waitMode = a.WaitMode,
                urlWaitPattern = a.UrlWaitPattern,
                postNavigateSelector = a.PostNavigateSelector,
                typeAppend = a.TypeAppend,
                typePaste = a.TypePaste,
                typeDelay = a.TypeDelay,
                // BrowserSelectOption — match mode for choosing the <option>
                selectMatchMode = a.SelectMatchMode,
                // Ranked fallback selectors (pick-time capture) — forwarded so the editor
                // can show/refresh them and the save round-trip doesn't wipe them.
                selectorAlternatives = a.SelectorAlternatives,
                // SetVariable — the value half of "Key = VariableValue". This projection is
                // the ONLY path the frontend learns of the field (see the holdDurationMs
                // note above for why forgetting one here is a silent round-trip bug).
                variableValue = a.VariableValue,
                variableMode = a.VariableMode,
                // CopyToSlot — capture vs clear (the slot NAME rides the shared Key field).
                slotMode = a.SlotMode,
                // ActivateWindow — launch + failure-policy fields (matcher fields are the
                // shared window* trio above).
                launchPath = a.LaunchPath,
                launchArgs = a.LaunchArgs,
                activateOnTimeout = a.ActivateOnTimeout,
                restorePosition = a.RestorePosition,
                restoreSize = a.RestoreSize,
                windowX = a.WindowX,
                windowY = a.WindowY,
                windowWidth = a.WindowWidth,
                windowHeight = a.WindowHeight,
                windowVerb = a.WindowVerb,
                windowMatchIndex = a.WindowMatchIndex,
                assertOnFail = a.AssertOnFail
            }).ToArray();
        }

        public void PushActionsUpdate()
        {
            PushActionListOnly();
            PushDataTable();
        }

        /// <summary>
        /// The grid and the two action counters — everything here derives from
        /// <see cref="actions"/> and from nothing else, which is what makes it the correct payload
        /// for a plain collection change.
        ///
        /// Split out from <see cref="PushActionsUpdate"/> for the recording path. Adding one
        /// recorded action fires OnActionsChanged synchronously INSIDE the low-level hook callback,
        /// and the data table it used to drag along reads UserProfile.Current.Data — which no
        /// action add, delete or reorder can touch. It rode on actions:updated only so a profile
        /// SWITCH would refresh the Data panel, and every switch path (ApplyProfile, the deselect
        /// branch) calls PushActionsUpdate explicitly after detaching this handler, so it keeps
        /// getting it. The one path that did rely on the implicit push — deleting the ACTIVE
        /// profile, which clears the grid without an explicit push — now says so out loud.
        ///
        /// Measured before changing anything: at the largest real macro on this machine (87 rows)
        /// one recorded action costs ~0.6 ms, i.e. 0.2% of the 300 ms LowLevelHooksTimeout, and
        /// recording that whole macro accumulates ~12 ms. The O(n^2) is real but nowhere near
        /// reachable here, which is why this is a waste-removal and NOT the debounce that would
        /// change the grid's refresh cadence during recording.
        /// </summary>
        private void PushActionListOnly()
        {
            var actionsList = ProjectActionsForFrontend();
            SendMessage("actions:updated", new { actions = actionsList });
            PushToolbarUpdate();
            PushStatusBarUpdate();
        }

        // Pushes the active profile's data-loop table to the frontend (empty when none). Rides
        // on every actions:updated so a profile switch / load refreshes the Data panel too;
        // also sent on explicit data:request (panel open) and after data:save (confirm).
        public void PushDataTable()
        {
            var d = UserProfile.Current?.Data;
            SendMessage("data:table", new
            {
                headers = d?.Headers ?? new System.Collections.Generic.List<string>(),
                rows = d?.Rows ?? new System.Collections.Generic.List<System.Collections.Generic.List<string>>(),
                loopOverData = d?.LoopOverData ?? false,
                onRowError = NormalizeOnRowError(d?.OnRowError) ?? "halt",
                // Stored as null-means-default, surfaced to the UI as a plain bool: the panel
                // renders a checkbox, and leaving it undefined would seed it unchecked-looking
                // on a table that has never opted out.
                notifyOnLapComplete = d?.NotifyOnLapComplete != false,
            });
        }

        // Per-row error policy: only "skip" is meaningful; anything else normalizes to null
        // (= halt, the default) so old profiles stay byte-identical on disk.
        private static string? NormalizeOnRowError(string? value) =>
            string.Equals(value, "skip", StringComparison.OrdinalIgnoreCase) ? "skip" : null;

        private void HandleDataRequest() => PushDataTable();

        // Persists the active profile's data-loop table. Mirrors the profile-setting
        // convention (BringToFocus etc.): mutate UserProfile.Current so it is live for the
        // next replay + preserved by any Save, and persist to disk immediately when the
        // profile has a file. A table with no headers AND no rows clears the feature (null).
        private async void HandleDataSave(JsonElement payload)
        {
            var headers = new System.Collections.Generic.List<string>();
            if (payload.TryGetProperty("headers", out var hEl) && hEl.ValueKind == JsonValueKind.Array)
                foreach (var h in hEl.EnumerateArray())
                    headers.Add(h.GetString() ?? "");

            var rows = new System.Collections.Generic.List<System.Collections.Generic.List<string>>();
            if (payload.TryGetProperty("rows", out var rEl) && rEl.ValueKind == JsonValueKind.Array)
                foreach (var r in rEl.EnumerateArray())
                {
                    var cells = new System.Collections.Generic.List<string>();
                    if (r.ValueKind == JsonValueKind.Array)
                        foreach (var c in r.EnumerateArray())
                            cells.Add(c.GetString() ?? "");
                    rows.Add(cells);
                }

            bool loopOverData = payload.TryGetProperty("loopOverData", out var lEl) && lEl.ValueKind == JsonValueKind.True;
            // "skip" is kept even when the loop is currently off — it remembers the user's
            // choice for when the loop comes back, is runtime-inert meanwhile (the engine
            // gates on LoopOverData), and the compatibility pin is gated the same way so
            // the dormant value can't over-pin the profile's min version.
            string? onRowError = payload.TryGetProperty("onRowError", out var oEl) && oEl.ValueKind == JsonValueKind.String
                ? NormalizeOnRowError(oEl.GetString())
                : null;

            // Lap notice is ON by default, so ONLY an explicit opt-out is persisted — an
            // untouched table serialises byte-for-byte as before (same null-means-default
            // shape as OnRowError above).
            bool? notifyOnLapComplete =
                payload.TryGetProperty("notifyOnLapComplete", out var nEl) && nEl.ValueKind == JsonValueKind.False
                    ? false
                    : null;

            ProfileDataTable? table = (headers.Count == 0 && rows.Count == 0)
                ? null
                : new ProfileDataTable
                {
                    Headers = headers,
                    Rows = rows,
                    LoopOverData = loopOverData,
                    OnRowError = onRowError,
                    NotifyOnLapComplete = notifyOnLapComplete,
                };

            UserProfile.Current.Data = table;

            // Persist immediately when the profile exists on disk (same pattern as the other
            // profile-level settings). A brand-new unsaved profile ("No Profile" / no path)
            // keeps the table in memory + marks unsaved so the first Save writes it.
            var name = CurrentProfileName;
            if (name != "No Profile")
            {
                var profile = await profileController.LoadProfileByNameAsync(name);
                if (profile != null)
                {
                    profile.Data = table;
                    await profileController.SaveProfileByNameAsync(name, profile);
                }
            }
            else
            {
                HasUnsavedChanges = true;
            }

            PushDataTable();
        }

        // ── Automation (trigger daemon) ──

        // Full config + runtime status per trigger-bearing profile. One payload feeds both
        // the automation:state push and the cold-start state:init blob (hand-mirrored like
        // dataTable — built here once so they can't drift).
        private object BuildAutomationStatePayload()
        {
            var status = TriggerService.Instance?.GetStatus();
            var byName = status?.ToDictionary(s => s.Profile, StringComparer.OrdinalIgnoreCase);
            var entries = profileController.ProfileEntries
                .Where(p => p.Triggers != null)
                .Select(p =>
                {
                    TriggerService.AutomationStatusEntry? st = null;
                    byName?.TryGetValue(p.Name, out st);
                    return new
                    {
                        profile = p.Name,
                        isDisabled = p.IsDisabled,
                        hasEffectiveTarget = p.HasEffectiveTarget,
                        // Normalize the image-store key the same way HandleAutomationCaptureImage does
                        // (No Profile / empty → "default") so a No-Profile trigger's thumbnail resolves.
                        trigger = ProjectTriggerConfig(p.Triggers!, (string.IsNullOrEmpty(p.Name) || p.Name == "No Profile") ? "default" : p.Name),
                        running = st?.Running ?? false,
                        conditionTrue = st?.ConditionTrue ?? false,
                        nextDueAt = st?.NextDueAt?.ToString("o"),
                        lastFiredAt = st?.LastFiredAt?.ToString("o"),
                        fireCount = st?.FireCount ?? 0,
                        skippedBusy = st?.SkippedBusy ?? 0,
                        skippedDirty = st?.SkippedDirty ?? 0,
                        skippedModal = st?.SkippedModal ?? 0,
                        skippedSuppressed = st?.SkippedSuppressed ?? 0,
                        lastResult = st?.LastResult,
                    };
                }).ToArray();
            return new
            {
                enabled = TriggerService.Instance?.GlobalEnabled ?? true,
                entries,
            };
        }

        public void PushAutomationState() => SendMessage("automation:state", BuildAutomationStatePayload());

        private object ProjectTriggerConfig(ProfileTriggerConfig t, string profileName) => new
        {
            kind = t.Kind,
            armed = t.Armed,
            intervalSeconds = t.IntervalSeconds,
            timeOfDay = t.TimeOfDay,
            daysOfWeek = t.DaysOfWeek,
            conditionType = t.ConditionType,
            windowProcessName = t.WindowProcessName,
            windowTitle = t.WindowTitle,
            windowTitleMatchMode = t.WindowTitleMatchMode,
            windowMatchForegroundOnly = t.WindowMatchForegroundOnly,
            filePath = t.FilePath,
            pixelX = t.PixelX,
            pixelY = t.PixelY,
            pixelColor = t.PixelColor,
            pixelTolerance = t.PixelTolerance,
            imagePath = t.ImagePath,
            imageConfidence = t.ImageConfidence,
            // Derived, display-only (never parsed back): the reference PNG as base64 so the editor
            // shows a thumbnail, exactly like the WaitImage action projection.
            imageBase64 = (string.IsNullOrEmpty(t.ImagePath)
                    || !string.Equals(t.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase))
                ? "" : GetImageBase64Cached(profileName, t.ImagePath!),
            searchRegion = (t.SearchRegionW is int w && w > 0 && t.SearchRegionH is int h && h > 0)
                ? new { x = t.SearchRegionX ?? 0, y = t.SearchRegionY ?? 0, w, h }
                : null,
            clipboardPattern = t.ClipboardPattern,
            cooldownSeconds = t.CooldownSeconds,
            retrigger = t.Retrigger,
            pollIntervalMs = t.PollIntervalMs,
        };

        private static ProfileTriggerConfig? ParseTriggerConfig(JsonElement el)
        {
            if (el.ValueKind != JsonValueKind.Object) return null;
            var t = new ProfileTriggerConfig();
            if (el.TryGetProperty("kind", out var v) && v.ValueKind == JsonValueKind.String) t.Kind = v.GetString() ?? "interval";
            t.Armed = el.TryGetProperty("armed", out v) && v.ValueKind == JsonValueKind.True;
            if (el.TryGetProperty("intervalSeconds", out v) && v.TryGetInt32(out var iv)) t.IntervalSeconds = iv;
            if (el.TryGetProperty("timeOfDay", out v) && v.ValueKind == JsonValueKind.String) t.TimeOfDay = v.GetString();
            if (el.TryGetProperty("daysOfWeek", out v) && v.TryGetInt32(out var dw)) t.DaysOfWeek = dw;
            if (el.TryGetProperty("conditionType", out v) && v.ValueKind == JsonValueKind.String) t.ConditionType = v.GetString();
            if (el.TryGetProperty("windowProcessName", out v) && v.ValueKind == JsonValueKind.String) t.WindowProcessName = v.GetString();
            if (el.TryGetProperty("windowTitle", out v) && v.ValueKind == JsonValueKind.String) t.WindowTitle = v.GetString();
            if (el.TryGetProperty("windowTitleMatchMode", out v) && v.ValueKind == JsonValueKind.String) t.WindowTitleMatchMode = v.GetString();
            t.WindowMatchForegroundOnly = el.TryGetProperty("windowMatchForegroundOnly", out v) && v.ValueKind == JsonValueKind.True;
            if (el.TryGetProperty("filePath", out v) && v.ValueKind == JsonValueKind.String) t.FilePath = v.GetString();
            if (el.TryGetProperty("pixelX", out v) && v.TryGetInt32(out var px)) t.PixelX = px;
            if (el.TryGetProperty("pixelY", out v) && v.TryGetInt32(out var py)) t.PixelY = py;
            if (el.TryGetProperty("pixelColor", out v) && v.ValueKind == JsonValueKind.String) t.PixelColor = v.GetString();
            if (el.TryGetProperty("pixelTolerance", out v) && v.TryGetInt32(out var pt)) t.PixelTolerance = pt;
            if (el.TryGetProperty("imagePath", out v) && v.ValueKind == JsonValueKind.String) t.ImagePath = v.GetString();
            if (el.TryGetProperty("imageConfidence", out v) && v.ValueKind == JsonValueKind.Number) t.ImageConfidence = v.GetDouble();
            // ImageFound ROI: nested {x,y,w,h} object, or null to clear. Absent → stays full-screen.
            // (imageBase64 is display-only and never parsed back — the PNG on disk is the source.)
            if (el.TryGetProperty("searchRegion", out v))
            {
                if (v.ValueKind == JsonValueKind.Object)
                {
                    if (v.TryGetProperty("x", out var srx) && srx.TryGetInt32(out var sx)) t.SearchRegionX = sx;
                    if (v.TryGetProperty("y", out var sry) && sry.TryGetInt32(out var sy)) t.SearchRegionY = sy;
                    if (v.TryGetProperty("w", out var srw) && srw.TryGetInt32(out var sw)) t.SearchRegionW = sw;
                    if (v.TryGetProperty("h", out var srh) && srh.TryGetInt32(out var sh)) t.SearchRegionH = sh;
                }
                else if (v.ValueKind == JsonValueKind.Null)
                {
                    t.SearchRegionX = t.SearchRegionY = t.SearchRegionW = t.SearchRegionH = null;
                }
            }
            if (el.TryGetProperty("clipboardPattern", out v) && v.ValueKind == JsonValueKind.String) t.ClipboardPattern = v.GetString();
            if (el.TryGetProperty("cooldownSeconds", out v) && v.TryGetInt32(out var cd)) t.CooldownSeconds = cd;
            if (el.TryGetProperty("retrigger", out v) && v.ValueKind == JsonValueKind.String) t.Retrigger = v.GetString();
            if (el.TryGetProperty("pollIntervalMs", out v) && v.TryGetInt32(out var pi)) t.PollIntervalMs = pi;
            return t;
        }

        // Persist a profile's trigger config (null = remove the automation). Dual-path like
        // HandleDataSave: the ACTIVE profile must mutate UserProfile.Current FIRST — every
        // grid-save path rebuilds the profile from Current, so a stale Current.Triggers
        // would make the next Save silently delete the just-configured automation.
        // Reload is called EXPLICITLY in every path: the disk watcher's debounce can land
        // inside another refresh's suppression window and never deliver it.
        private async Task PersistTriggerAsync(string name, ProfileTriggerConfig? trigger)
        {
            // The in-memory mirrors are mutated FIRST (see the note above) but the disk write can
            // still throw — a locked file, a full disk, antivirus holding the temp. Without a
            // rollback the app then shows an automation state that does not exist on disk and
            // silently reverts on the next launch, and the caller's "resync the list" push would
            // faithfully re-render the wrong thing. Snapshot, and put both mirrors back.
            var prevCurrent = UserProfile.Current.Triggers;
            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
            var prevEntry = entry?.Triggers;

            if (name == CurrentProfileName)
                UserProfile.Current.Triggers = trigger;
            if (entry != null) entry.Triggers = trigger;

            try
            {
                if (name != "No Profile" && entry != null && File.Exists(entry.FilePath))
                {
                    var profile = await profileController.LoadProfileByNameAsync(name);
                    if (profile != null)
                    {
                        profile.Triggers = trigger;
                        await profileController.SaveProfileByNameAsync(name, profile);
                    }
                }
                else if (name == CurrentProfileName)
                {
                    HasUnsavedChanges = true;
                }
            }
            catch
            {
                if (name == CurrentProfileName) UserProfile.Current.Triggers = prevCurrent;
                if (entry != null) entry.Triggers = prevEntry;
                throw;   // the callers report it; they also re-push after the rollback
            }

            TriggerService.Instance?.Reload(
                profileController.GetProfileTriggers(),
                profileController.ProfileEntries.Select(p => p.Name).ToList());
            PushAutomationState();
            // The sidebar's armed dot is fed by triggerArmed, which only ships in the
            // profiles:updated payload (see PushProfilesUpdate) — pushing only the automation
            // state left the dot showing the PREVIOUS arm state until something unrelated
            // happened to refresh the profile list. Arming is exactly when that dot matters.
            PushProfilesUpdate();
            TrayIconService.UpdateTrayIcon();
        }

        /// <summary>
        /// Projects the last run's step records to the UI. Named fields rather than the record
        /// object so the DTO stays explicit — the same convention every other push here follows.
        /// </summary>
        public void PushRunReport()
        {
            var (steps, overflow, startedAt) = replayService.GetRunReport();
            SendMessage("replay:report", new
            {
                profile = CurrentProfileName,
                startedAt = steps.Count > 0 ? startedAt.ToString("o") : null,
                overflow,
                steps = steps.Select(s => new
                {
                    row = s.Row,
                    profile = s.Profile,
                    actionType = s.ActionType,
                    detail = s.Detail,
                    status = s.Status,
                    durationMs = s.DurationMs,
                    errorCode = s.ErrorCode,
                    errorMessage = s.ErrorMessage,
                    tip = s.Tip,
                    matchedSelector = s.MatchedSelector,
                    matchedTier = s.MatchedTier,
                    tabUrl = s.TabUrl,
                }).ToArray(),
            });
        }

        private async void HandleAutomationSave(JsonElement payload)
        {
            try
            {
                var name = payload.TryGetProperty("profile", out var pEl) ? pEl.GetString() : null;
                if (string.IsNullOrEmpty(name)) return;
                ProfileTriggerConfig? trigger = payload.TryGetProperty("trigger", out var tEl)
                    ? ParseTriggerConfig(tEl)
                    : null;
                await PersistTriggerAsync(name, trigger);
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error("automation:save failed", ex);
                SendMessage("alert:show", new { message = $"Could not save automation: {ex.Message}" });
            }
        }

        private async void HandleAutomationSetArmed(JsonElement payload)
        {
            try
            {
                var name = payload.TryGetProperty("profile", out var pEl) ? pEl.GetString() : null;
                bool armed = payload.TryGetProperty("armed", out var aEl) && aEl.ValueKind == JsonValueKind.True;
                if (string.IsNullOrEmpty(name)) return;
                var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
                if (entry?.Triggers == null) return;
                var updated = entry.Triggers.Clone();
                updated.Armed = armed;
                await PersistTriggerAsync(name, updated);
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error("automation:setArmed failed", ex);
                // Arming used to be silent on failure: entry.Triggers was mutated in memory, the
                // disk write threw, and the automation looked armed until the next launch dropped
                // it. Say so, and put the list back in step with what is actually on disk.
                SendMessage("alert:show", new { message = $"Could not arm automation: {ex.Message}" });
                PushAutomationState();
            }
        }

        /// <summary>
        /// "Run now" — fire an automation once, on demand, through the SAME path the daemon uses
        /// (TriggerService.FireProfile → MainWindow's gates → the shared replay start). Going
        /// through the real path is the whole point: a condition probe alone would report success
        /// for a fire that would in fact be skipped busy / dirty / modal, which is precisely the
        /// class of failure a user cannot otherwise observe.
        /// </summary>
        private async void HandleAutomationTestFire(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var rEl) ? (rEl.GetString() ?? "") : "";
            string name = payload.TryGetProperty("profile", out var pEl) ? (pEl.GetString() ?? "") : "";
            if (string.IsNullOrEmpty(name)) return;
            try
            {
                var fire = TriggerService.Instance?.FireProfile;
                if (fire == null)
                {
                    SendMessage("automation:testFireResult", new { requestId, fired = false, detail = "Automation service not ready." });
                    return;
                }
                // The daemon can never fire a disabled profile — GetProfileTriggers drops those,
                // so no watcher is ever built for one. Run now goes straight to FireProfile and
                // would happily bypass that, telling the user the automation works when armed
                // when in fact it can never run.
                var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
                if (entry?.IsDisabled == true)
                {
                    SendMessage("automation:testFireResult", new { requestId, fired = false,
                        detail = "Skipped: this profile is disabled, so its automation never runs. Enable it in the sidebar first." });
                    return;
                }
                var result = await fire(name);
                // The SKIPS are the interesting answers, so each gets its own sentence naming the
                // blocker and what to do about it — "skipped" alone sends the user hunting.
                string detail = result switch
                {
                    TriggerFireResult.Fired => "Fired — the profile is running now.",
                    TriggerFireResult.SkippedBusy => "Skipped: a replay, recording or clicker run is already going. Automations wait for the engine to be free.",
                    TriggerFireResult.SkippedDirty => "Skipped: the action grid has unsaved changes. Automations never fire over unsaved edits — save the profile first.",
                    TriggerFireResult.SkippedModal => "Skipped: a dialog or key capture is open. Close it and try again.",
                    TriggerFireResult.NotReady => "Not ready: the app is still starting up.",
                    _ => "Failed to start — the profile could not be loaded. Check that it still exists and is not disabled.",
                };
                SendMessage("automation:testFireResult", new { requestId, fired = result == TriggerFireResult.Fired, detail });
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error($"automation:testFire '{name}' failed", ex);
                SendMessage("automation:testFireResult", new { requestId, fired = false, detail = $"Failed: {ex.Message}" });
            }
        }

        // Capture a reference PNG for an Image-condition trigger — same minimize + region
        // overlay flow as the WaitImage recapture, but profile-addressed (the trigger's
        // owner, not necessarily the active profile) and correlated by requestId so the
        // Automation panel can pair the reply. Saves into the SAME per-profile store as
        // WaitImage PNGs (orphan sweep / export / duplicate all know about trigger paths).
        private void HandleAutomationCaptureImage(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var ridEl) ? (ridEl.GetString() ?? "") : "";
            string profileName = payload.TryGetProperty("profile", out var pEl) ? (pEl.GetString() ?? "") : "";
            if (string.IsNullOrEmpty(profileName) || profileName == "No Profile") profileName = "default";
            _ = HandleAutomationCaptureImageAsync(requestId, profileName);
        }

        private async Task HandleAutomationCaptureImageAsync(string requestId, string profileName)
        {
            // Gate autonomous fires for the whole capture: the region overlay is exactly the
            // "user mid-interaction" state the SkippedModal trigger gate exists for — a due
            // interval trigger could otherwise swap profiles and start injecting input while the
            // user drag-selects. This used to be a hand-managed bool that had to be cleared on
            // every exit path, including the early return below (a comment there recorded what
            // happened the time it was not). The scope releases itself.
            //
            // The scope is keep-alive'd against the overlay's own STA thread rather than left on
            // the default 5-minute deadline. A capture overlay is precisely the surface a user
            // walks away from, and the sweep firing underneath a live one un-suppresses hotkeys
            // while a full-screen click target is still up — see InteractionScope.Enter(keepAlive).
            // Null until the thread is built below; the first deadline is minutes out, so the gap
            // is never observed.
            Thread? overlayThread = null;
            using var interaction = Services.InteractionScope.EnterExclusive(
                "automation capture overlay", () => overlayThread?.IsAlive == true);
            // Exclusive, and refusing costs nothing here: the scope is claimed BEFORE the window is
            // minimised, so an early return leaves the app exactly as it was — no restore to get
            // right, no bitmap allocated, no STA thread started. Two of these overlays stacked
            // would be two full-screen TopMost windows showing the same screenshot with no way to
            // tell which one a click answered. The frontend disabling its buttons while a request
            // is in flight is what kept this unreachable; that is a UI-layer guard on a backend
            // invariant, and it is not inherited by a second entry point.
            if (interaction == null)
            {
                SendMessage("automation:imageCaptured", new { requestId, cancelled = true });
                return;
            }
            var mainHwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
            NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_MINIMIZE);
            await Task.Delay(400);

            System.Drawing.Bitmap screenshot;
            try
            {
                screenshot = ScreenCaptureService.CaptureVirtualScreen();
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error("Automation capture screenshot failed", ex);
                NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE);
                SendMessage("automation:imageCaptured", new { requestId, cancelled = true });
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var thread = new Thread(() =>
                {
                    // THE canonical overlay-thread body; the eight siblings in this file point
                    // here. Two things it must do that the original did not:
                    //
                    // CATCH. This is not the main thread, so an exception escaping the delegate —
                    // constructing the form on a display that just went away, anything inside
                    // ShowDialog — is an unhandled exception on a non-main thread, and the CLR
                    // takes the whole process down with it. Every other stage of this pipeline
                    // logs and degrades (the screenshot failure above returns, a stale EditScope
                    // announces itself); this was the single piece that could kill the app.
                    // Swallowing it leaves `selection` null, which every caller below already
                    // reads as "the user cancelled".
                    //
                    // Deliberately NOT re-nulling `selection` in the catch: the only statement
                    // that can throw after it is assigned is the form's Dispose during unwinding,
                    // and throwing away a good capture because a window failed to tear down
                    // cleanly is the worse of the two trades.
                    try
                    {
                        System.Windows.Forms.Application.EnableVisualStyles();
                        using var overlay = new ScreenOverlayForm(screenshot);
                        overlay.ShowDialog();
                        selection = overlay.GetSelectionAsync().Result;
                    }
                    catch (Exception ex)
                    {
                        DiagnosticLog.Error("Automation capture overlay thread failed", ex);
                    }
                });
                thread.SetApartmentState(ApartmentState.STA);
                // BACKGROUND. A foreground thread keeps the process alive past
                // Application.Current.Exit(), and the tray's Exit path calls exactly that without
                // an Environment.Exit behind it. Quitting with an overlay open therefore left a
                // dead app running behind a full-screen TopMost window with no tray icon to
                // reach. The sibling STA helper in ProfileController.ShowFileDialogAsync sets
                // this for the same reason.
                thread.IsBackground = true;
                overlayThread = thread;
                thread.Start();
                await Task.Run(() => thread.Join());

                dispatcherQueue.TryEnqueue(() =>
                {
                    NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE);
                });

                if (selection?.CroppedImage == null)
                {
                    SendMessage("automation:imageCaptured", new { requestId, cancelled = true });
                    return;
                }

                // SaveReferenceImage does Directory.CreateDirectory + Image.Save, and both throw
                // on a read-only or policy-redirected profile directory, a full disk, or a path
                // the OS rejects. This method is fire-and-forget (`_ = HandleAutomationCapture...`),
                // so an escaping exception became an unobserved task exception: no crash, no log,
                // no toast. The user watched the app minimise, dragged a rectangle, watched it come
                // back, and nothing happened.
                //
                // The reply matters as much as the log. automation:imageCaptured is what clears
                // AutomationPanel's captureReqRef; without one on the failure path the panel waits
                // forever for an answer that is never coming, and the capture button stays dead
                // until the app restarts. Cancelled, not a silent drop.
                //
                // Dispose moved into a finally: it used to sit after the save, so the throw leaked
                // the cropped bitmap's GDI handle on top of everything else.
                string newImagePath;
                try
                {
                    newImagePath = ImageStorageService.SaveReferenceImage(selection.CroppedImage, profileName);
                }
                catch (Exception ex)
                {
                    DiagnosticLog.Error($"Automation capture image save failed [profile='{profileName}']", ex);
                    SendMessage("alert:show", new { message = $"Couldn't save the captured image: {ex.Message}", type = "error" });
                    SendMessage("automation:imageCaptured", new { requestId, cancelled = true });
                    return;
                }
                finally
                {
                    selection.CroppedImage.Dispose();
                }
                // Carry the base64 on the reply so the panel thumbnails the just-captured image
                // immediately (the draft is seeded once per selection; automation:state won't re-stomp it).
                SendMessage("automation:imageCaptured", new { requestId, cancelled = false, imagePath = newImagePath, imageBase64 = GetImageBase64Cached(profileName, newImagePath) });
            }
            finally
            {
                screenshot.Dispose();
            }
        }

        // Re-crop a trigger's reference PNG tighter (the panel's crop-on-thumbnail-click), the
        // profile-addressed twin of HandleCropReference (which is action-index-addressed). Loads the
        // draft's current imagePath, crops in image-pixel coords, saves a NEW PNG, and replies over the
        // same automation:imageCaptured path so the panel patches imagePath + thumbnail. The trigger is
        // persisted on the next automation:save (mirrors capture — the draft holds the new path).
        private void HandleAutomationCropReference(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var ridEl) ? (ridEl.GetString() ?? "") : "";
            string profileName = payload.TryGetProperty("profile", out var pEl) ? (pEl.GetString() ?? "") : "";
            if (string.IsNullOrEmpty(profileName) || profileName == "No Profile") profileName = "default";
            string imagePath = payload.TryGetProperty("imagePath", out var ipEl) ? (ipEl.GetString() ?? "") : "";
            if (string.IsNullOrEmpty(imagePath)) return;
            int x = payload.GetProperty("x").GetInt32();
            int y = payload.GetProperty("y").GetInt32();
            int w = payload.GetProperty("w").GetInt32();
            int h = payload.GetProperty("h").GetInt32();

            using var current = ImageStorageService.LoadReferenceImage(profileName, imagePath);
            if (current == null) return;
            // Clamp to the image bounds (belt-and-suspenders over the frontend clamp); reject tiny or
            // no-op (full-image) crops — same rules as HandleCropReference.
            x = Math.Max(0, Math.Min(current.Width - 1, x));
            y = Math.Max(0, Math.Min(current.Height - 1, y));
            w = Math.Min(current.Width - x, w);
            h = Math.Min(current.Height - y, h);
            if (w < 10 || h < 10) return;
            if (x == 0 && y == 0 && w == current.Width && h == current.Height) return;

            string newPath;
            try
            {
                using var cropped = current.Clone(new System.Drawing.Rectangle(x, y, w, h), current.PixelFormat);
                newPath = ImageStorageService.SaveReferenceImage(cropped, profileName);
            }
            catch (Exception ex)
            {
                DiagnosticLog.Warn($"Automation crop failed: {ex.Message}");
                return;
            }
            SendMessage("automation:imageCaptured", new { requestId, cancelled = false, imagePath = newPath, imageBase64 = GetImageBase64Cached(profileName, newPath) });
        }

        private void HandleAutomationSetEnabled(JsonElement payload)
        {
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            UserProfile.Current.AutomationEnabled = enabled;
            SaveGlobalSettings();
            TriggerService.Instance?.SetGlobalEnabled(enabled);
            PushSettingsLoaded();
            PushAutomationState();
            TrayIconService.UpdateTrayIcon();
        }

        // Key remap layer — whole-list save (the list is tiny, capped at 32). RemapService
        // persists to its sidecar remaps.json and republishes the hook snapshot.
        private void HandleRemapSave(JsonElement payload)
        {
            var config = new RemapService.RemapConfig
            {
                Enabled = !payload.TryGetProperty("enabled", out var eEl) || eEl.ValueKind != JsonValueKind.False,
            };
            if (payload.TryGetProperty("remaps", out var rEl) && rEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var r in rEl.EnumerateArray())
                {
                    if (r.ValueKind != JsonValueKind.Object) continue;
                    config.Remaps.Add(new RemapService.RemapEntry
                    {
                        From = r.TryGetProperty("from", out var fEl) ? (fEl.GetString() ?? "") : "",
                        To = r.TryGetProperty("to", out var tEl) ? (tEl.GetString() ?? "") : "",
                        Enabled = !r.TryGetProperty("enabled", out var enEl) || enEl.ValueKind != JsonValueKind.False,
                    });
                }
            }
            RemapService.Save(config);
            PushSettingsLoaded();
        }

        // Settings-blob projection for the remap layer (rides settings:loaded + state:init).
        private static object ProjectRemaps() => new
        {
            enabled = RemapService.Current.Enabled,
            entries = RemapService.Current.Remaps
                .Select(r => new { from = r.From, to = r.To, enabled = r.Enabled }).ToArray(),
        };

        private void PushUndoState()
        {
            // No .ToList(): the serializer takes any IEnumerable and emits the same JSON array, so
            // the copy only duplicated the whole collection on a path that runs on every edit.
            var snapshot = JsonSerializer.Serialize(actions, JsonOptions);
            _undoStack.Push(snapshot);
            if (_undoStack.Count > MaxHistory)
            {
                var temp = new Stack<string>(_undoStack.Reverse().Skip(_undoStack.Count - MaxHistory));
                _undoStack.Clear();
                foreach (var item in temp.Reverse()) _undoStack.Push(item);
            }
            _redoStack.Clear();
            mainController.UpdateButtonStates();
        }

        private void HandleUndo()
        {
            if (_undoStack.Count == 0) return;
            var current = JsonSerializer.Serialize(actions, JsonOptions);
            _redoStack.Push(current);
            var snapshot = _undoStack.Pop();
            RestoreActionsFromSnapshot(snapshot);
            mainController.UpdateButtonStates();
        }

        private void HandleRedo()
        {
            if (_redoStack.Count == 0) return;
            var current = JsonSerializer.Serialize(actions, JsonOptions);
            _undoStack.Push(current);
            var snapshot = _redoStack.Pop();
            RestoreActionsFromSnapshot(snapshot);
            mainController.UpdateButtonStates();
        }

        private void RestoreActionsFromSnapshot(string snapshot)
        {
            var restored = JsonSerializer.Deserialize<List<ActionItem>>(snapshot, JsonOptions);
            if (restored == null) return;

            // AFTER the null check: a snapshot that failed to deserialize changes nothing, so it
            // must not invalidate anyone's scope. Undo/redo rebuilds every row from JSON, so the
            // instances are all new — an anchor from before the undo is genuinely gone, not moved.
            Services.ProfileEpoch.Bump("action list replaced (undo/redo)");

            // Suppress CollectionChanged to avoid flooding PushActionsUpdate on each Add
            actions.CollectionChanged -= OnActionsChanged;
            try
            {
                actions.Clear();
                foreach (var item in restored)
                {
                    item.RowNumber = actions.Count + 1;
                    actions.Add(item);
                }
            }
            finally
            {
                actions.CollectionChanged += OnActionsChanged;
            }
            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        /// <summary>
        /// Swaps the live action collection for a freshly-computed list, suppressing per-item
        /// CollectionChanged so only ONE PushActionsUpdate fires. Mirrors
        /// <see cref="RestoreActionsFromSnapshot"/>; used by bulk structural rewrites
        /// (e.g. paired↔combined conversion) where the row count itself changes.
        /// </summary>
        private void ReplaceActions(IReadOnlyList<ActionItem> newActions)
        {
            // Structural rewrite: the row count itself changes and every stored index is void.
            Services.ProfileEpoch.Bump("action list replaced (bulk rewrite)");
            actions.CollectionChanged -= OnActionsChanged;
            try
            {
                actions.Clear();
                foreach (var item in newActions)
                {
                    item.RowNumber = actions.Count + 1;
                    actions.Add(item);
                }
            }
            finally
            {
                actions.CollectionChanged += OnActionsChanged;
            }
            PushActionsUpdate();
        }

        /// <summary>
        /// Converts every action in the active profile between the paired (KeyDown+KeyUp /
        /// *ClickDown+*ClickUp) and combined (Keystroke / HoldKey / *Click) representations.
        /// Whole-profile + undoable; the actual transform lives in
        /// <see cref="ActionModeConverter"/>. No-ops (already fully in the target form) push
        /// nothing to the undo stack and just report "nothing to convert".
        /// </summary>
        private void HandleConvertActionMode(JsonElement payload)
        {
            string direction = payload.TryGetProperty("direction", out var d) ? d.GetString() ?? "" : "";
            bool toCombined = direction == "toCombined";
            if (!toCombined && direction != "toPaired") return;
            if (actions.Count == 0) return;

            var input = actions.ToList();
            var output = toCombined
                ? ActionModeConverter.ToCombined(input)
                : ActionModeConverter.ToPaired(input);

            // No-op guard: identical length AND identical type sequence means nothing folded /
            // expanded (e.g. the profile was already in the target form). Skip the undo entry
            // and the misleading "converted N" toast.
            bool changed = output.Count != input.Count;
            for (int i = 0; !changed && i < output.Count; i++)
                if (output[i].ActionType != input[i].ActionType) changed = true;
            if (!changed)
            {
                SendMessage("alert:show", new { message = "Nothing to convert" });
                return;
            }

            PushUndoState();
            ReplaceActions(output);
            HasUnsavedChanges = true;
            mainController.UpdateButtonStates();

            SendMessage("alert:show", new
            {
                message = toCombined
                    ? $"Converted to combined — {output.Count} actions"
                    : $"Converted to paired — {output.Count} actions"
            });
        }

        public bool CanUndo => _undoStack.Count > 0;
        public bool CanRedo => _redoStack.Count > 0;

        public void PushProfilesUpdate()
        {
            // Refresh derived effective-target fields before serializing — handlers that mutate
            // folder membership or folder targets don't always call RefreshProfileListAsync,
            // and the UI relies on these fields to render the inherited-target badge.
            profileController.PopulateEffectiveTargets();
            // Per-call dedup only, NOT a persistent cache (AppIconService owns caching) — it just
            // collapses GetIconBase64's per-hit revalidation I/O across profiles sharing a target.
            var iconLookup = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
            string? Icon(string? proc) => string.IsNullOrWhiteSpace(proc) ? null
                : iconLookup.TryGetValue(proc, out var v) ? v
                : (iconLookup[proc] = AppIconService.GetIconBase64(proc));
            var profiles = profileController.ProfileEntries.Select(p => new
            {
                name = p.Name,
                filePath = p.FilePath,
                hotkey = p.Hotkey,
                hotstring = p.Hotstring,
                hotstringInstant = p.HotstringInstant,
                hotkeyConflict = p.HotkeyConflict,   // keep in sync with the OTHER projection of ProfileEntry
                isActive = p.IsActive,
                hasWindowTarget = p.HasWindowTarget,
                windowTargetProcessName = p.WindowTargetProcessName,
                windowTargetWindowTitle = p.WindowTargetWindowTitle,
                windowTargetTitleMatchMode = p.WindowTargetTitleMatchMode,
                hasEffectiveTarget = p.HasEffectiveTarget,
                effectiveTargetSource = p.EffectiveTargetSource,
                effectiveTargetFolderName = p.EffectiveTargetFolderName,
                effectiveTargetProcessName = p.EffectiveTargetProcessName,
                effectiveTargetWindowTitle = p.EffectiveTargetWindowTitle,
                effectiveTargetTitleMatchMode = p.EffectiveTargetTitleMatchMode,
                effectiveUseRelativeCoordinates = p.EffectiveUseRelativeCoordinates,
                // Icon of the effective WindowTarget's .exe, base64 PNG. Pure UI augmentation
                // — not persisted, not in the typed ProfileEntry model. The frontend uses
                // effectiveTargetSource to decide opacity (own = 100 %, folder-inherited = 55 %).
                // Null when no target or icon extraction failed (UWP host, portable not in
                // PATH, etc.) — the existing crosshair badge renders as fallback.
                appIconBase64 = Icon(p.EffectiveTargetProcessName),
                useRelativeCoordinates = p.UseRelativeCoordinates,
                bringToFocus = p.BringToFocus,
                restorePosition = p.RestorePosition,
                restoreSize = p.RestoreSize,
                triggerMode = TriggerModeToString(p.TriggerMode),
                isDisabled = p.IsDisabled,
                // Automation badge scalars — the sidebar renders a Zap badge on armed profiles.
                hasTrigger = p.Triggers != null,
                triggerArmed = p.Triggers?.Armed ?? false,
                // Sharing metadata mirror for sidebar badges + Info tab seed values. The
                // Info tab still calls profile:get-metadata on open to refresh; this is just
                // so the list can render emoji/tags without a round-trip per profile.
                description = p.Description,
                tags = p.Tags,
                iconEmoji = p.IconEmoji,
                profileVersion = p.ProfileVersion,
                createdAt = p.CreatedAt?.ToString("o"),
                updatedAt = p.UpdatedAt?.ToString("o"),
                appMinVersion = p.AppMinVersion,
                actionCount = p.ActionCount,
                // RunProfile refs — lets the Export dialog work out (client-side, no round-trip)
                // which sub-profiles ride along with the current selection, and re-derive it as
                // that selection changes. null when the profile calls none.
                runProfileTargets = p.RunProfileTargets
            }).ToArray();

            var order = profileController.GetProfileOrder();
            var profileOrder = new
            {
                pinned = order.Pinned,
                folders = order.Folders.Select(f => new
                {
                    name = f.Name,
                    color = f.Color,
                    collapsed = f.Collapsed,
                    items = f.Items,
                    hasWindowTarget = f.TargetWindow != null,
                    windowTargetProcessName = f.TargetWindow?.ProcessName,
                    windowTargetWindowTitle = f.TargetWindow?.WindowTitle,
                    windowTargetTitleMatchMode = f.TargetWindow?.TitleMatchMode ?? "contains",
                    appIconBase64 = Icon(f.TargetWindow?.ProcessName),
                    useRelativeCoordinates = f.UseRelativeCoordinates,
                    bringToFocus = f.BringToFocus,
                    restorePosition = f.RestorePosition,
                    restoreSize = f.RestoreSize,
                    windowX = f.WindowX,
                    windowY = f.WindowY,
                    windowWidth = f.WindowWidth,
                    windowHeight = f.WindowHeight
                }).ToArray(),
                ungroupedOrder = order.UngroupedOrder
            };

            SendMessage("profiles:updated", new { profiles, activeProfile = CurrentProfileName == "No Profile" ? (string?)null : CurrentProfileName, profileOrder });
        }

        // Flip Macro ↔ Clicker. Cancels any running replay/recording so the active state
        // matches the new mode (Clicker ignores recorded actions and vice versa). Used by
        // both the settings:change "useCursorClick" path and the ModeToggleHotkey global
        // hotkey path — keeping the side-effects in one place.
        public void SetCursorClickMode(bool useClicker)
        {
            UseCursorClick = useClicker;
            if (replayService.IsReplaying)
                mainController.StopReplayIfRunning();
            if (recordingService.IsRecording)
                recordingService.StopRecording();
        }

        // ── Per-profile loop: the session edit ──
        // Editing Loops in Settings mutates the LOADED PROFILE OBJECT (UserProfile.Current) and
        // raises this flag; Ctrl+S / the Save button writes it to disk. It is deliberately NOT
        // HasUnsavedChanges: that flag makes the automation daemon skip the profile
        // (TriggerFireResult.SkippedDirty), so an armed automation would silently stop firing
        // just because someone nudged a loop count. The unsaved-changes prompt and the window
        // close guard honour this flag SEPARATELY, including on a profile with zero actions
        // (both short-circuit on actions.Count == 0, which would otherwise drop the edit with
        // no dialog at all).
        //
        // Name-scoped: the pending edit belongs to the profile that was loaded when it was made.
        // Every activation path clears it explicitly (ClearLoopEdit), and the name check is the
        // belt-and-braces so a missed call can never paint another profile's chip as dirty.
        private bool _hasUnsavedLoopChange;
        private string? _loopEditProfile;
        public bool HasUnsavedLoopChange => _hasUnsavedLoopChange && _loopEditProfile == CurrentProfileName;
        private void MarkLoopEdited()
        {
            _hasUnsavedLoopChange = true;
            _loopEditProfile = CurrentProfileName;
        }
        public void ClearLoopEdit()
        {
            _hasUnsavedLoopChange = false;
            _loopEditProfile = null;
        }
        /// <summary>Follow a rename: same loaded profile, new name, edit survives.</summary>
        private void RetargetLoopEdit(string newName)
        {
            if (_hasUnsavedLoopChange) _loopEditProfile = newName;
        }

        /// <summary>
        /// The ONE place a macro run's loop settings are resolved. Precedence:
        ///   loop-over-data (rows) &gt; forceInfinite (WhilePressed/Toggle) &gt; profile &gt; global.
        /// The first two are applied downstream (StartReplay overrides the count for
        /// loop-over-data; forceInfinite is a separate boolean on the replayer), so what this
        /// method owns is the bottom half: the loaded profile's own values, falling back to the
        /// bridge's global mirrors only under "No Profile".
        /// </summary>
        /// <param name="profile">
        /// The profile actually about to run. The hotkey/automation path already loaded a fresh
        /// instance and MUST pass it — UserProfile.Current is assigned from it a few lines later,
        /// but reading the parameter keeps this correct regardless of ordering. Null = "whatever
        /// is loaded right now" (Replay button, global Replay hotkey).
        /// Taking a UserProfile rather than a profile NAME is deliberate: ProfileEntry carries no
        /// loop fields and LoadProfileByNameAsync is async I/O, so a name-based overload would
        /// either lie or block. Same shape as BuildClickerConfig.
        /// </param>
        public LoopRunConfig BuildLoopConfig(UserProfile? profile = null)
        {
            // No profile loaded → the app-level fallback in appsettings.json, mirrored here.
            if (profile == null && CurrentProfileName == "No Profile")
            {
                int globalCount = int.TryParse(LoopCount, out var gc) ? gc : UserProfile.MinLoopCount;
                return new LoopRunConfig(
                    EnableLoop,
                    UserProfile.NormalizeLoopCount(globalCount).ToString(),
                    LoopIntervalEnabled,
                    LoopInterval);
            }

            var p = profile ?? UserProfile.Current;
            // Clamp here and not only at the edges: this covers disk, import, and a hand-edited
            // profile.json in one shot, and it is what guarantees a macro can never reach the
            // engine with 0 (= forever). Interval has no such sentinel, only a negative guard.
            return new LoopRunConfig(
                p.EnableLoop,
                UserProfile.NormalizeLoopCount(p.LoopCount).ToString(),
                p.LoopIntervalEnabled,
                (p.LoopInterval >= 0 ? p.LoopInterval : 0).ToString());
        }

        /// <summary>
        /// Narrow push for the active profile's loop settings. Deliberately NOT PushSettingsLoaded:
        /// that message replaces the whole React `settings` slice by merging over the DEFAULTS and
        /// has ~19 emitters (tray, ScrollLock, Pause, remaps, the automation master, every Clicker
        /// picker), so an unsaved loop edit living in that slice would be wiped by an unrelated
        /// mode toggle. Must be called from EVERY profile-activation path — ApplyProfile only
        /// pushes actions and button states, so without this the panel keeps showing the previous
        /// profile's number.
        /// </summary>
        public void PushProfileLoop() => SendMessage("profile:loop", ProjectProfileLoop());

        /// <summary>
        /// The single projection behind BOTH emitters of this payload (profile:loop and the
        /// state:init cold-start blob). Written as one helper because every other pair of
        /// duplicated DTOs in this file has drifted at least once.
        /// </summary>
        private object ProjectProfileLoop()
        {
            var cfg = BuildLoopConfig();
            return new
            {
                count = cfg.Count,
                enabled = cfg.Enabled,
                interval = cfg.Interval,
                intervalEnabled = cfg.IntervalEnabled,
                // "there is an edit that Ctrl+S would persist" — the chip renders it as a dashed
                // amber outline. HasUnsavedChanges is never pushed to the frontend (~40 writes,
                // zero pushes), so the chip cannot derive this itself.
                dirty = HasUnsavedLoopChange,
                // false = the Settings rows are editing the app-level "No Profile" fallback.
                scoped = CurrentProfileName != "No Profile",
            };
        }

        // Build a Clicker run config from the current bridge mirror state. Single source of
        // truth so the Replay-hotkey path (MainWindow) and the toggle-replay message path
        // (HandleReplayToggle) stay in sync — both call this instead of duplicating the
        // string→int parsing and the Area/loop convention logic.
        // Loop convention: 0 means unbounded, and cursorClickUseLoops=false resolves to 0 —
        // "no limit set" and "limit of zero" are the same statement for a clicker.
        // Area gate: requires positive W/H — defensive against stale all-zero state.
        // Clamps a numeric setting arriving as a string, keeping the STORED value in range
        // instead of only correcting it on the way out to the engine. Without this a bad value
        // survives in appsettings.json and the panel keeps displaying it, even though every
        // run silently uses the clamped one.
        private static string ClampNumeric(string? raw, int min, int max, int fallback)
        {
            if (!int.TryParse(raw, out int n)) n = fallback;
            return Math.Clamp(n, min, max).ToString();
        }

        // Returns "" for a bare wheel binding, the value untouched otherwise. See the call site
        // in the settings load for why bare wheel can never be a global hotkey.
        private static string DropBareWheelHotkey(string? stored, string label)
        {
            if (stored != "ScrollUp" && stored != "ScrollDown") return stored ?? "";
            DiagnosticLog.Info($"Settings: cleared {label}='{stored}' — a bare wheel binding is not dispatchable as a global hotkey.");
            return "";
        }

        public ClickerRunConfig BuildClickerConfig()
        {
            // Clamped on the way out as well as inside the engine. appsettings.json is
            // hand-editable and never passes through HandleSettingsChange, so an out-of-range
            // value reaches here untouched — and an unclamped jitter percent overflows the
            // engine's `period * jitterPercent` into a negative variation, which throws.
            int delay = Math.Clamp(int.TryParse(CursorClickDelay, out var d) ? d : 100, 1, 60000);
            int jitterPercent = Math.Clamp(int.TryParse(CursorClickDelayJitter, out var jp) ? jp : 0, 0, 100);
            int holdMs = Math.Clamp(int.TryParse(CursorClickHold, out var h) ? h : 10, 0, 2000);
            int positionJitter = CursorClickUsePositionJitter && int.TryParse(CursorClickPositionJitter, out var pj)
                ? Math.Clamp(pj, 0, 500) : 0;
            // Loops chip OFF (the shipped default) now means UNBOUNDED, not one click.
            // It used to substitute 1, which made the factory default "press the hotkey, get a
            // single click and stop" while the chip visibly displayed 0 and its own tooltip
            // promised "0 = forever". An auto-clicker's default is to keep clicking; the UI
            // renders the off state as ∞ so the two finally agree.
            int loops = CursorClickUseLoops && int.TryParse(CursorClickLoops, out var lc) && lc >= 0 ? lc : 0;
            int interval = CursorClickUseInterval && int.TryParse(CursorClickInterval, out var li) ? li : 0;
            ClickArea? area = CursorClickUseArea ? CursorClickArea : null;
            // Area takes precedence over Fixed if both are somehow on (UI enforces mutex, but
            // be defensive). FixedPoint may be null while UseFixed is on = lock-on-start.
            bool useFixed = CursorClickUseFixed && !CursorClickUseArea;
            ClickPoint? fixedPoint = useFixed ? CursorClickFixedPoint : null;
            // Same convention as loops: toggle off resolves to 0 = no cap.
            int maxDuration = CursorClickUseMaxDuration && int.TryParse(CursorClickMaxDuration, out var md) && md > 0
                ? Math.Clamp(md, 1000, 86400000) : 0;
            return new ClickerRunConfig(delay, CursorClickUseJitter, jitterPercent, loops, interval,
                CursorClickButton, holdMs, positionJitter, area, useFixed, fixedPoint, maxDuration,
                CursorClickGameMove);
        }

        // Optional instance = same-handler pass-through from SaveGlobalSettings ONLY — never a
        // cache held across handlers (appsettings.json is hand-editable; a stale copy would win).
        public void PushSettingsLoaded(AppSettingsManager.AppSettings? appSettings = null)
        {
            var profile = UserProfile.Current;
            // One read for both fields below. AppSettingsManager.Load() is not cached — every call
            // does Directory.CreateDirectory, the legacy-path migration check, File.Exists,
            // File.ReadAllText and a JSON deserialize — and this projection used to call it twice,
            // four lines apart, for two properties of the same object.
            appSettings ??= AppSettingsManager.Load();
            SendMessage("settings:loaded", new
            {
                settings = new
                {
                    customDelay = CustomDelay,
                    useCustomDelay = UseCustomDelay,
                    delayVariation = DelayVariation,
                    useDelayVariation = UseDelayVariation,
                    loopCount = LoopCount,
                    enableLoop = EnableLoop,
                    loopInterval = LoopInterval,
                    loopIntervalEnabled = LoopIntervalEnabled,
                    smoothMovement = ActionReplayer.SmoothMovement,
                    moveStepPx = ActionReplayer.MoveStepPx.ToString(),
                    moveStepDelay = ActionReplayer.MoveStepDelayMs.ToString(),
                    moveClickDelay = ActionReplayer.MoveClickDelayMs.ToString(),
                    fastApproach = ActionReplayer.FastApproach,
                    settleDistance = ActionReplayer.SettleDistancePx.ToString(),
                    useCursorClick = UseCursorClick,
                    cursorClickButton = CursorClickButton,
                    cursorClickStartHotkey = CursorClickStartHotkey,
                    cursorClickPauseHotkey = CursorClickPauseHotkey,
                    cursorClickDelay = CursorClickDelay,
                    cursorClickDelayJitter = CursorClickDelayJitter,
                    cursorClickUseJitter = CursorClickUseJitter,
                    cursorClickHold = CursorClickHold,
                    cursorClickPositionJitter = CursorClickPositionJitter,
                    cursorClickUsePositionJitter = CursorClickUsePositionJitter,
                    cursorClickUseArea = CursorClickUseArea,
                    cursorClickArea = CursorClickArea is { } a
                        ? (object)new { x = a.X, y = a.Y, w = a.W, h = a.H }
                        : null,
                    cursorClickUseFixed = CursorClickUseFixed,
                    cursorClickFixedPoint = CursorClickFixedPoint is { } fp
                        ? (object)new { x = fp.X, y = fp.Y }
                        : null,
                    cursorClickLoops = CursorClickLoops,
                    cursorClickUseLoops = CursorClickUseLoops,
                    cursorClickInterval = CursorClickInterval,
                    cursorClickUseInterval = CursorClickUseInterval,
                    cursorClickMaxDuration = CursorClickMaxDuration,
                    cursorClickUseMaxDuration = CursorClickUseMaxDuration,
                    cursorClickGameMove = CursorClickGameMove,
                    recordMouse = RecordMouse,
                    recordScroll = RecordScroll,
                    recordKeyboard = RecordKeyboard,
                    recordCombinedInput = RecordCombinedInput,
                    profileKeyEnabled = ProfileKeyEnabled,
                    browserSelectorEnabled = BrowserSelectorEnabled,
                    recordingHotkey = profile.RecordingHotkey,
                    replayHotkey = profile.ReplayHotkey,
                    profileKeyToggleHotkey = profile.ProfileKeyToggleHotkey,
                    foregroundHotkey = profile.ForegroundHotkey,
                    modeToggleHotkey = profile.ModeToggleHotkey,
                    captureSlotHotkey = profile.CaptureSlotHotkey,
                    alwaysOnTop = profile.AlwaysOnTop,
                    minimizeToTray = profile.MinimizeToTray,
                    runOnStartup = appSettings.RunOnStartup,
                    startMinimized = profile.StartMinimized,
                    runEndFlash = profile.RunEndFlash,
                    runEndSound = profile.RunEndSound,
                    runAsAdmin = appSettings.RunAsAdmin,
                    automationEnabled = profile.AutomationEnabled,
                    remaps = ProjectRemaps()
                }
            });
        }

        public void PushButtonStates()
        {
            SendMessage("button:states", new
            {
                // Recording is meaningless in Clicker mode (ignores recorded actions). Replay button
                // doubles as the "Click" trigger in Clicker mode, so it's enabled even with 0 actions.
                recordEnabled = !UseCursorClick,
                replayEnabled = UseCursorClick || actions.Count > 0,
                recordingActive = recordingService.IsRecording,
                replayActive = replayService.IsReplaying,
                recordButtonText = recordingService.IsRecording ? "Pause" : "Recording",
                replayButtonText = replayService.IsReplaying ? "Stop" : (UseCursorClick ? "Click" : "Replay"),
                canUndo = CanUndo,
                copiedCount = _copiedActions?.Count ?? 0,
                canRedo = CanRedo
            });

            // Recording/replay start+stop both land here, which makes this the cheapest honest
            // signal that a run has ENDED — and the end of a run is when an update the run
            // refused becomes applicable again. Returns immediately unless one is parked.
            MaybeResumeDeferredUpdate();
        }

        public void PushToolbarUpdate()
        {
            SendMessage("toolbar:updated", new
            {
                profileName = CurrentProfileName,
                actionCount = actions.Count
            });
        }

        // Environment.GetFolderPath is a shell lookup, and this ran on every action recorded, every
        // row deleted and every edit. The Documents path cannot move while the process is alive.
        private static readonly string StatusBarProfileDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            "TrueReplayer", "Profiles");

        public void PushStatusBarUpdate()
        {
            SendMessage("statusbar:updated", new
            {
                directory = StatusBarProfileDir,
                profileName = CurrentProfileName == "No Profile" ? (string?)null : CurrentProfileName,
                actionCount = actions.Count
            });
        }

        public void PushFullState()
        {
            PushActionsUpdate();
            PushProfilesUpdate();
            PushSettingsLoaded();
            PushButtonStates();
            PushStatusBarUpdate();
        }

        public void PushActionHighlight(int index)
        {
            SendMessage("actions:highlight", new { index });
        }

        /// <summary>
        /// Checks for unsaved changes and prompts Save/Discard/Cancel.
        /// Returns true if the caller should proceed, false to cancel.
        /// </summary>
        /// <param name="beforeWhat">Completes "Save before ___?" — see ShowUnsavedChangesDialogAsync.</param>
        private async Task<bool> CheckUnsavedChangesAsync(string beforeWhat = "continuing")
        {
            // A pending Loops/Interval edit counts as unsaved work on its OWN — including on a
            // profile with zero actions, which the `actions.Count == 0` short-circuit below
            // would otherwise wave through. Without this, editing the loop count and clicking
            // another profile discarded the value with no dialog at all.
            if (!HasUnsavedLoopChange && (!HasUnsavedChanges || actions.Count == 0))
                return true;

            bool loopOnly = HasUnsavedLoopChange && (!HasUnsavedChanges || actions.Count == 0);
            var result = await profileController.ShowUnsavedChangesDialogAsync(loopOnly, beforeWhat);

            if (result == Microsoft.UI.Xaml.Controls.ContentDialogResult.Primary) // Save
            {
                if (CurrentProfilePath != null)
                {
                    var profile = CreateProfileFromState();
                    await SettingsManager.SaveProfileAsync(CurrentProfilePath, profile);
                    // Every other successful-save path in this file clears the dirty flags right
                    // where the write lands. This call site used to skip that and lean on the
                    // caller loading a different profile afterward to reset state as a side
                    // effect — true for HandleProfileClick/HandleProfileLoad, but
                    // HandleProfileExport just continues on to export after Save, so
                    // HasUnsavedChanges stayed true forever. A profile stuck "dirty" parks its
                    // automation trigger in SkippedDirty, which is terminal (never retried) —
                    // the trigger would silently never fire again.
                    HasUnsavedChanges = false;
                    ClearLoopEdit();
                    return true;
                }
                else
                {
                    bool saved = await profileController.SaveProfileAsync();
                    // Only clear on an actual success — SaveProfileAsync returns false when the
                    // user cancels its own Save-As picker, and clearing here would tell every
                    // caller "proceed, nothing to save" even though nothing was written.
                    if (saved)
                    {
                        HasUnsavedChanges = false;
                        ClearLoopEdit();
                    }
                    return saved;
                }
            }

            if (result == Microsoft.UI.Xaml.Controls.ContentDialogResult.Secondary) // Discard
                return true;

            return false; // Cancel
        }

        // ── Apply profile to bridge state ──

        public void ApplyProfile(UserProfile profile)
        {
            ApplyProfileActions(profile);
            PushActionsUpdate();
            PushButtonStates();
        }

        // Fill-only half of ApplyProfile — swaps the action list without any frontend push.
        // The epoch bump stays on THIS side of the split: fail-closed invalidation must ride
        // with the list replacement itself, never with the (deferrable) visual push. Called
        // directly by the trigger-fire path, which pushes only after the replay has started.
        public void ApplyProfileActions(UserProfile profile)
        {
            // Bumps even though most callers set CurrentProfileName first (which already bumped).
            // Two of them do NOT: the post-import reload (HandleProfileConfirmImport) and the
            // reset-settings path both refill the list under the SAME name, and those are the
            // swaps a name check cannot see. Double-bumping a normal switch is harmless — the
            // epoch is only ever compared for equality, so over-invalidating fails CLOSED (an
            // announced abort) while under-invalidating is what corrupts data.
            Services.ProfileEpoch.Bump("action list replaced (profile applied)");
            actions.CollectionChanged -= OnActionsChanged;
            try
            {
                actions.Clear();
                foreach (var action in profile.Actions)
                    actions.Add(action);
            }
            finally
            {
                actions.CollectionChanged += OnActionsChanged;
            }
        }

        public UserProfile CreateProfileFromState()
        {
            return new UserProfile
            {
                Actions = new ObservableCollection<ActionItem>(actions),
                BatchDelay = UserProfile.Current.BatchDelay,
                LastProfileDirectory = UserProfile.Current.LastProfileDirectory,
                CustomHotkey = UserProfile.Current.CustomHotkey,
                CustomHotstring = UserProfile.Current.CustomHotstring,
                TargetWindow = UserProfile.Current.TargetWindow,
                UseRelativeCoordinates = UserProfile.Current.UseRelativeCoordinates,
                WindowWidth = UserProfile.Current.WindowWidth,
                WindowHeight = UserProfile.Current.WindowHeight,
                WindowX = UserProfile.Current.WindowX,
                WindowY = UserProfile.Current.WindowY,
                RestorePosition = UserProfile.Current.RestorePosition,
                RestoreSize = UserProfile.Current.RestoreSize,
                BringToFocus = UserProfile.Current.BringToFocus,
                TriggerMode = UserProfile.Current.TriggerMode,
                IsDisabled = UserProfile.Current.IsDisabled,
                // Per-profile loop. This initializer is the ONLY gate: the serializer is generic,
                // so a field left out here is simply never written and the on-disk value reverts
                // to the class default on the next load. Source is the profile's own stored
                // value (UserProfile.Current), never the bridge's global mirror.
                EnableLoop = UserProfile.Current.EnableLoop,
                LoopCount = UserProfile.Current.LoopCount,
                LoopIntervalEnabled = UserProfile.Current.LoopIntervalEnabled,
                LoopInterval = UserProfile.Current.LoopInterval,
                // Data-loop table travels with the profile so a normal Save preserves it
                // (data:save also persists immediately, but the main Save must not null it).
                Data = UserProfile.Current.Data,
                // Automation trigger — preserved VERBATIM (incl. Armed): this is the local
                // user's own save, not a copy/import (those disarm).
                Triggers = UserProfile.Current.Triggers,
            };
        }

        // ── Handler methods ──

        private void HandleUIReady()
        {
            // UI loaded successfully — cancel the watchdog timer. Stays FIRST and unconditional:
            // the deferral below must never be mistaken for an unresponsive UI.
            window.CancelUIWatchdog();

            // React sends ui:ready the instant it mounts, which on a cold start beats the startup
            // profile load. state:init REPLACES the frontend store wholesale (AppStateContext
            // spreads initialState and then the payload), so projecting ProfileEntries at this
            // instant made an empty sidebar — no hotkey chips, no automation badges — the app's
            // first frame, corrected only by the profiles:updated push that lands afterwards.
            //
            // Deferring is safe precisely because the watchdog is already cancelled. The gate is
            // completed on EVERY exit of the startup path, including its failure bails, because a
            // gate that never opens would be a UI that never initialises.
            //
            // The body is re-evaluated at send time rather than captured: a snapshot taken here
            // would be exactly the stale, empty projection this defers past.
            var initialLoad = window.InitialDataLoaded;
            if (!initialLoad.IsCompleted)
            {
                initialLoad.ContinueWith(
                    _ => dispatcherQueue.TryEnqueue(SendInitialState),
                    System.Threading.CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
                return;
            }
            // Every ui:ready after the first — UI reload, crash recovery, DevTools refresh — finds
            // the gate already open and takes this synchronous path, so warm reloads are unchanged.
            SendInitialState();
        }

        /// <summary>
        /// The cold-start payload. Split out of <see cref="HandleUIReady"/> so it can be deferred
        /// until the startup profile load has published <c>ProfileEntries</c>. Reads UI-thread
        /// state (UserProfile.Current, ProfileEntries, actions, GetProfileOrder) and must therefore
        /// run on the dispatcher.
        /// </summary>
        private void SendInitialState()
        {
            // Send full state to React
            var profile = UserProfile.Current;
            // One read for both settings fields in the projection below — see PushSettingsLoaded
            // for what each Load() costs. This is the cold-start path, where the dispatcher is
            // already the scarce resource.
            var appSettings = AppSettingsManager.Load();
            SendMessage("state:init", new
            {
                status = "ready",
                // Per-action DTO is projected by the shared ProjectActionsForFrontend()
                // helper — identical to PushActionsUpdate's actions:updated payload so
                // the cold-start state and subsequent pushes can never drift.
                actions = ProjectActionsForFrontend(),
                highlightedActionIndex = (int?)null,
                // Cold-start data-loop table — MUST mirror PushDataTable's shape. Without it the
                // store keeps the empty default at mount, DataPanel seeds empty (seededRef then
                // blocks the later data:table re-seed), and a Save wipes the on-disk table.
                dataTable = new
                {
                    headers = UserProfile.Current?.Data?.Headers ?? new System.Collections.Generic.List<string>(),
                    rows = UserProfile.Current?.Data?.Rows ?? new System.Collections.Generic.List<System.Collections.Generic.List<string>>(),
                    loopOverData = UserProfile.Current?.Data?.LoopOverData ?? false,
                    onRowError = NormalizeOnRowError(UserProfile.Current?.Data?.OnRowError) ?? "halt",
                    notifyOnLapComplete = UserProfile.Current?.Data?.NotifyOnLapComplete != false,
                },
                profiles = profileController.ProfileEntries.Select(p => new
                {
                    name = p.Name,
                    filePath = p.FilePath,
                    hotkey = p.Hotkey,
                    hotstring = p.Hotstring,
                    hotstringInstant = p.HotstringInstant,
                    hotkeyConflict = p.HotkeyConflict,   // keep in sync with the OTHER projection of ProfileEntry
                    isActive = p.IsActive,
                    hasWindowTarget = p.HasWindowTarget,
                    windowTargetProcessName = p.WindowTargetProcessName,
                    windowTargetWindowTitle = p.WindowTargetWindowTitle,
                    windowTargetTitleMatchMode = p.WindowTargetTitleMatchMode,
                    hasEffectiveTarget = p.HasEffectiveTarget,
                    effectiveTargetSource = p.EffectiveTargetSource,
                    effectiveTargetFolderName = p.EffectiveTargetFolderName,
                    effectiveTargetProcessName = p.EffectiveTargetProcessName,
                    effectiveTargetWindowTitle = p.EffectiveTargetWindowTitle,
                    effectiveTargetTitleMatchMode = p.EffectiveTargetTitleMatchMode,
                    effectiveUseRelativeCoordinates = p.EffectiveUseRelativeCoordinates,
                    // Keep in sync with PushProfilesUpdate — without this, the first paint
                    // after launch renders the crosshair fallback for every targeted profile
                    // even though the on-disk icon cache has the PNG ready. The icon only
                    // appears on the next push (drag, expand, etc.), which feels broken.
                    appIconBase64 = AppIconService.GetIconBase64(p.EffectiveTargetProcessName),
                    useRelativeCoordinates = p.UseRelativeCoordinates,
                    bringToFocus = p.BringToFocus,
                    restorePosition = p.RestorePosition,
                    restoreSize = p.RestoreSize,
                    triggerMode = TriggerModeToString(p.TriggerMode),
                    isDisabled = p.IsDisabled,
                    // Keep in sync with PushProfilesUpdate (automation badge scalars).
                    hasTrigger = p.Triggers != null,
                    triggerArmed = p.Triggers?.Armed ?? false,
                    // Sharing-metadata mirror — keep in sync with PushProfilesUpdate. This whole
                    // block drifted OUT of the cold-start blob before, so on first paint (until the
                    // first profiles:updated push) the sidebar's icon/tags/version badges and the
                    // Export dialog's per-profile "N actions" weight were all blank.
                    description = p.Description,
                    tags = p.Tags,
                    iconEmoji = p.IconEmoji,
                    profileVersion = p.ProfileVersion,
                    createdAt = p.CreatedAt?.ToString("o"),
                    updatedAt = p.UpdatedAt?.ToString("o"),
                    appMinVersion = p.AppMinVersion,
                    actionCount = p.ActionCount,
                    // Keep in sync with PushProfilesUpdate. Without it the Export dialog can't see
                    // the Run Profile graph on a COLD START, so its "+N referenced sub-profiles
                    // included" disclosure stays hidden for the whole first session even though
                    // those sub-profiles do get bundled — the one case where silence is a lie.
                    runProfileTargets = p.RunProfileTargets
                }).ToArray(),
                activeProfile = CurrentProfileName == "No Profile" ? (string?)null : CurrentProfileName,
                // Cold-start mirror of the profile:loop push — MUST stay in sync with
                // PushProfileLoop's payload. Top-level (not inside `settings`) on purpose: the
                // settings slice is replaced wholesale by settings:loaded, which ~19 unrelated
                // emitters fire, and an unsaved loop edit parked in there would vanish when the
                // user pressed ScrollLock.
                profileLoop = ProjectProfileLoop(),
                profileOrder = new
                {
                    pinned = profileController.GetProfileOrder().Pinned,
                    folders = profileController.GetProfileOrder().Folders.Select(f => new
                    {
                        name = f.Name,
                        color = f.Color,
                        collapsed = f.Collapsed,
                        items = f.Items,
                        hasWindowTarget = f.TargetWindow != null,
                        windowTargetProcessName = f.TargetWindow?.ProcessName,
                        windowTargetWindowTitle = f.TargetWindow?.WindowTitle,
                        windowTargetTitleMatchMode = f.TargetWindow?.TitleMatchMode ?? "contains",
                        appIconBase64 = AppIconService.GetIconBase64(f.TargetWindow?.ProcessName),
                        useRelativeCoordinates = f.UseRelativeCoordinates,
                        bringToFocus = f.BringToFocus,
                        restorePosition = f.RestorePosition,
                        restoreSize = f.RestoreSize,
                        windowX = f.WindowX,
                        windowY = f.WindowY,
                        windowWidth = f.WindowWidth,
                        windowHeight = f.WindowHeight
                    }).ToArray(),
                    ungroupedOrder = profileController.GetProfileOrder().UngroupedOrder
                },
                settings = new
                {
                    customDelay = CustomDelay,
                    useCustomDelay = UseCustomDelay,
                    delayVariation = DelayVariation,
                    useDelayVariation = UseDelayVariation,
                    loopCount = LoopCount,
                    enableLoop = EnableLoop,
                    loopInterval = LoopInterval,
                    loopIntervalEnabled = LoopIntervalEnabled,
                    smoothMovement = ActionReplayer.SmoothMovement,
                    moveStepPx = ActionReplayer.MoveStepPx.ToString(),
                    moveStepDelay = ActionReplayer.MoveStepDelayMs.ToString(),
                    moveClickDelay = ActionReplayer.MoveClickDelayMs.ToString(),
                    fastApproach = ActionReplayer.FastApproach,
                    settleDistance = ActionReplayer.SettleDistancePx.ToString(),
                    useCursorClick = UseCursorClick,
                    cursorClickButton = CursorClickButton,
                    cursorClickStartHotkey = CursorClickStartHotkey,
                    cursorClickPauseHotkey = CursorClickPauseHotkey,
                    cursorClickDelay = CursorClickDelay,
                    cursorClickDelayJitter = CursorClickDelayJitter,
                    cursorClickUseJitter = CursorClickUseJitter,
                    cursorClickHold = CursorClickHold,
                    cursorClickPositionJitter = CursorClickPositionJitter,
                    cursorClickUsePositionJitter = CursorClickUsePositionJitter,
                    cursorClickUseArea = CursorClickUseArea,
                    cursorClickArea = CursorClickArea is { } a
                        ? (object)new { x = a.X, y = a.Y, w = a.W, h = a.H }
                        : null,
                    cursorClickUseFixed = CursorClickUseFixed,
                    cursorClickFixedPoint = CursorClickFixedPoint is { } fp
                        ? (object)new { x = fp.X, y = fp.Y }
                        : null,
                    cursorClickLoops = CursorClickLoops,
                    cursorClickUseLoops = CursorClickUseLoops,
                    cursorClickInterval = CursorClickInterval,
                    cursorClickUseInterval = CursorClickUseInterval,
                    cursorClickMaxDuration = CursorClickMaxDuration,
                    cursorClickUseMaxDuration = CursorClickUseMaxDuration,
                    cursorClickGameMove = CursorClickGameMove,
                    recordMouse = RecordMouse,
                    recordScroll = RecordScroll,
                    recordKeyboard = RecordKeyboard,
                    recordCombinedInput = RecordCombinedInput,
                    profileKeyEnabled = ProfileKeyEnabled,
                    browserSelectorEnabled = BrowserSelectorEnabled,
                    recordingHotkey = profile.RecordingHotkey,
                    replayHotkey = profile.ReplayHotkey,
                    profileKeyToggleHotkey = profile.ProfileKeyToggleHotkey,
                    foregroundHotkey = profile.ForegroundHotkey,
                    modeToggleHotkey = profile.ModeToggleHotkey,
                    captureSlotHotkey = profile.CaptureSlotHotkey,
                    alwaysOnTop = profile.AlwaysOnTop,
                    minimizeToTray = profile.MinimizeToTray,
                    runOnStartup = appSettings.RunOnStartup,
                    startMinimized = profile.StartMinimized,
                    runEndFlash = profile.RunEndFlash,
                    runEndSound = profile.RunEndSound,
                    runAsAdmin = appSettings.RunAsAdmin,
                    automationEnabled = profile.AutomationEnabled,
                    remaps = ProjectRemaps()
                },
                // Cold-start automation state — MUST mirror PushAutomationState (same builder,
                // so it can't drift). Without it the panel seeds empty until the first push.
                automation = BuildAutomationStatePayload(),
                toolbar = new { profileName = CurrentProfileName, actionCount = actions.Count },
                statusBar = new
                {
                    directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "TrueReplayer", "Profiles"),
                    profileName = CurrentProfileName == "No Profile" ? (string?)null : CurrentProfileName,
                    actionCount = actions.Count
                },
                buttonStates = new
                {
                    recordEnabled = !UseCursorClick,
                    replayEnabled = UseCursorClick || actions.Count > 0,
                    recordingActive = false,
                    replayActive = false,
                    recordButtonText = "Recording",
                    replayButtonText = UseCursorClick ? "Click" : "Replay",
                    canUndo = CanUndo,
                    canRedo = CanRedo,
                    copiedCount = _copiedActions?.Count ?? 0
                }
            });

            // Apply saved window settings that require the window handle
            if (UserProfile.Current.AlwaysOnTop)
                window.UpdateAlwaysOnTop(true);

            // Check for updates in the background after UI is ready
            _ = CheckForUpdateAsync();
        }

        // Master switch for silent auto-update.
        //   true  → after detection, download + apply + restart with no UI gate — but only when
        //           the app is idle, see EvaluateUpdateGate below.
        //   false → only notify the frontend (legacy "Update available" overlay decides).
        // The overlay is live (UpdateOverlay.tsx UPDATE_OVERLAY_ENABLED = true), which is what
        // makes the notify path a real fallback rather than a black hole: an update the gate
        // refuses to apply silently is still shown, it just waits for a click.
        private const bool AutoApplyUpdates = true;

        // What an unattended restart would COST right now. ApplyAndRestart ends in
        // Environment.Exit(0): no close guard, no Save prompt, no undo. The auto path has to
        // answer this before it fires, and the three answers are deliberately not equal.
        //
        //   Busy    — a recording or replay is live. Recorded actions exist only in the in-memory
        //             `actions` collection until an explicit Save, so exiting mid-recording
        //             destroys the take with no prompt and no trace; exiting mid-replay abandons
        //             whatever the macro was driving, half-done. This is the same bar
        //             HandleProfileExport / HandleProfileImport already hold their work to — and
        //             they only rewrite files, where this kills the process.
        //   Unsaved — an idle profile carrying an edit. Real work, but work the app already knows
        //             how to rescue by ASKING. So it does not block the update; it only downgrades
        //             the SILENT apply to the user-confirmed overlay. A stray edit nobody ever
        //             saves must not pin the install on an old version forever.
        //   Clear   — nothing to lose; restart away.
        //
        // The Unsaved test is CheckUnsavedChangesAsync's own short-circuit, inverted. Anything
        // looser would report "unsaved" in a state where that prompt declines to appear, and the
        // apply path would then have no dialog to resolve the block with — a permanent stall.
        private enum UpdateGate { Clear, Busy, Unsaved }

        private UpdateGate EvaluateUpdateGate(out string reason)
        {
            if (recordingService.IsRecording) { reason = "a recording is in progress"; return UpdateGate.Busy; }
            if (replayService.IsReplaying) { reason = "a replay is running"; return UpdateGate.Busy; }
            if (HasUnsavedLoopChange || (HasUnsavedChanges && actions.Count > 0)) { reason = "the profile has unsaved changes"; return UpdateGate.Unsaved; }
            reason = string.Empty;
            return UpdateGate.Clear;
        }

        /// <summary>An update that was found but not applied, held so the retry can re-offer it
        /// without a second GitHub round-trip.</summary>
        private sealed record PendingUpdate(string Version, string CurrentVersion, List<string> Notes);

        // Armed ONLY by CheckForUpdateAsync, and only when a live run refused the apply. Taken and
        // cleared by MaybeResumeDeferredUpdate before it does anything else, and re-armed nowhere:
        // one deferral gets exactly one retry, so it cannot spin into a download loop.
        private PendingUpdate? _deferredUpdate;

        // Re-entrancy guard for HandleUpdateApply. It's reachable from three places that can
        // overlap: the auto-apply branch of CheckForUpdateAsync (fired on startup AND on every
        // ApplyProfile/PushFullState), the "update:check" message, and the "update:apply"
        // message. Without the guard a second invocation kicks off a parallel download +
        // ApplyAndRestart, racing the Velopack apply against itself.
        private bool _updateInProgress;

        // One voice for "an update exists and was not installed". Two channels, because neither
        // is sufficient alone: `update:error` is the only terminal update:* message that both
        // dismisses the splash and releases the Settings panel's "Checking..." button from its
        // disabled state, but the frontend never renders its payload text — so the toast beside it
        // is the only thing that actually tells the user WHY. Skipping the toast is how a blocked
        // update turns into an update the user never learns about.
        private void ReportUpdatePostponed(string reason)
        {
            DiagnosticLog.Info($"[Update] Apply postponed — {reason}");
            SendMessage("update:error", new { message = $"Update postponed: {reason}" });
            SendMessage("alert:show", new
            {
                message = $"An update is ready but was not installed because {reason}. It will be offered again once the app is idle — or apply it any time from Settings → Check for Updates.",
                type = "info"
            });
        }

        // Second half of the deferral. Hung off PushButtonStates because that is the ONE callback
        // both RecordingService and ReplayService raise on every start/stop (MainWindow wires all
        // three service constructors to it), so it is precisely the "a run just ended" edge —
        // no timer, no poll. Everything below no-ops unless an update is actually parked.
        private void MaybeResumeDeferredUpdate()
        {
            var pending = _deferredUpdate;
            if (pending == null || _updateInProgress) return;

            var gate = EvaluateUpdateGate(out _);
            if (gate == UpdateGate.Busy) return;   // still running — leave the slot armed
            _deferredUpdate = null;                // one shot: taken before anything can re-enter

            if (gate == UpdateGate.Clear)
            {
                _ = HandleUpdateApply();
                return;
            }

            // Unsaved. Stopping a recording is the usual way out of Busy and it leaves the take
            // dirty by definition, so this is the COMMON landing, not the edge case. Restarting
            // out from under a fresh recording is the exact failure this whole gate exists to
            // prevent — raise the confirm overlay instead and let the apply happen on a click,
            // behind the Save/Discard prompt that click triggers.
            SendMessage("update:available", new
            {
                version = pending.Version,
                currentVersion = pending.CurrentVersion,
                notes = pending.Notes,
                autoApply = false,
            });
        }

        private async Task CheckForUpdateAsync()
        {
            // Announce we're starting so the overlay can show its indeterminate "Checking…"
            // state during the network round-trip. Resolves into update:available or
            // update:none below, or update:error in the catch.
            SendMessage("update:checking", new { });

            try
            {
                var newVersion = await UpdateService.CheckForUpdateAsync();

                // A completed check supersedes any parked deferral — the release could have been
                // pulled, or superseded, or this check is about to re-park it with fresher notes.
                // Leaving the old slot armed would let a stale offer fire on a later idle edge
                // alongside whatever this check decides. The Busy branch below re-arms it.
                _deferredUpdate = null;

                if (newVersion != null)
                {
                    // Fetch release notes in parallel — best-effort, may be empty
                    var notes = await UpdateService.GetPendingReleaseNotesAsync();
                    var currentVersion = UpdateService.CurrentVersion ?? "unknown";
                    var gate = EvaluateUpdateGate(out var reason);

                    // A live run gets NO overlay at all. The splash is position:fixed/inset:0 over
                    // the entire app and its "available" phase has no dismiss control — raising it
                    // mid-replay would bury the Stop button under a card whose only button we are
                    // about to refuse anyway. Announce it as a toast, park it, and let the idle
                    // transition (PushButtonStates → MaybeResumeDeferredUpdate) carry it forward.
                    if (gate == UpdateGate.Busy)
                    {
                        _deferredUpdate = new PendingUpdate(newVersion, currentVersion, notes);
                        ReportUpdatePostponed(reason);
                        return;
                    }

                    // autoApply tells the frontend to skip the "Download" confirmation gate
                    // and transition straight to the downloading splash — matches the mockup
                    // (no confirmation button). The legacy gate flow stays available when
                    // AutoApplyUpdates is flipped off in code, and is ALSO what an unsaved
                    // profile degrades to: claiming autoApply for a download we are not about to
                    // start would strand the overlay on "Baixando... 0 %" with nothing behind it.
                    bool autoApply = AutoApplyUpdates && gate == UpdateGate.Clear;
                    SendMessage("update:available", new
                    {
                        version = newVersion,
                        currentVersion = currentVersion,
                        notes = notes,
                        autoApply = autoApply,
                    });

                    if (autoApply)
                    {
                        // Silent auto-update: kick off download + apply + restart immediately,
                        // skipping the user-confirmation overlay. Fire-and-forget — failures
                        // bubble out of HandleUpdateApply via "update:error" already.
                        _ = HandleUpdateApply();
                    }
                }
                else
                {
                    SendMessage("update:none", new
                    {
                        currentVersion = UpdateService.CurrentVersion ?? "unknown"
                    });
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[Update] Check failed: {ex.Message}");
                SendMessage("update:error", new { message = "Failed to check for updates" });
            }
        }

        private async Task HandleUpdateApply()
        {
            // Short-circuit re-entrant calls (auto-apply + manual update:check/update:apply can
            // overlap). The flag stays set through the success path so the 1.8 s pre-restart
            // delay can't be interrupted by a second apply; ApplyAndRestart exits the process,
            // so the finally only runs (clearing the flag) when we back out instead of restarting.
            if (_updateInProgress) return;

            // Entry gate, BEFORE the guard flag: this method is the "update:apply" button as well
            // as the auto path, so the user can perfectly well click Install with a replay
            // running. Refuse it exactly like the auto path does, and say why — a silent no-op on
            // a button the user just pressed reads as a broken button.
            var gate = EvaluateUpdateGate(out var reason);
            if (gate == UpdateGate.Busy)
            {
                ReportUpdatePostponed(reason);
                return;
            }

            _updateInProgress = true;
            try
            {
                // Unsaved work only reaches here on a DELIBERATE apply — the auto path stops at
                // the confirm overlay instead — so prompting is expected rather than an ambush.
                // It runs before the download so a Cancel doesn't cost a pointless transfer, and
                // it is the same Save/Discard/Cancel the window close guard runs: an update IS a
                // close, it just comes back afterwards. Cancel means "not now", not "lose it".
                if (gate == UpdateGate.Unsaved && !await CheckUnsavedChangesAsync("updating"))
                {
                    ReportUpdatePostponed("the unsaved-changes prompt was cancelled");
                    return;
                }

                SendMessage("update:progress", new { percent = 0 });

                var success = await UpdateService.DownloadUpdateAsync(progress =>
                {
                    dispatcherQueue.TryEnqueue(() =>
                    {
                        SendMessage("update:progress", new { percent = progress });
                    });
                });

                if (success)
                {
                    // Re-check AFTER the download and BEFORE update:ready. The transfer takes
                    // seconds, and a hotkey needs one — the entry gate above proves nothing about
                    // the state of the app at the moment the NEXT statement exits the process.
                    // Nothing is re-armed here on purpose: the package stays staged, so the next
                    // check (startup, or the Settings button) applies it without downloading
                    // again, and one detection can never fan out into repeated transfers.
                    if (EvaluateUpdateGate(out var lateReason) != UpdateGate.Clear)
                    {
                        ReportUpdatePostponed(lateReason);
                        return;
                    }

                    SendMessage("update:ready", new { });
                    // Give the React overlay a beat to render the 'installing' phase before
                    // we tear down the process. Without the pause, Environment.Exit(0) inside
                    // ApplyAndRestart kills the WebView2 in the same tick as the message
                    // dispatch — the user never sees "Atualizando para vX.Y.Z" / "Aplicando
                    // atualização" / pulsing progress. 1.8 s matches the user's eye on the
                    // checkmark animation cycle without dragging the restart noticeably.
                    await Task.Delay(1800);
                    UpdateService.ApplyAndRestart();
                }
                else
                {
                    // The overlay just hides on update:error without rendering the message, so the
                    // download failure would otherwise be a splash that silently vanishes.
                    SendMessage("update:error", new { message = "Download failed" });
                    SendMessage("alert:show", new
                    {
                        message = "The update could not be downloaded. It will be retried on the next check.",
                        type = "error"
                    });
                }
            }
            catch (Exception ex)
            {
                // update:ready fires 1.8 s BEFORE ApplyAndRestart, and by then the overlay is
                // already painting "Atualizado com sucesso!". ApplyAndRestart is the one call on
                // this path that can throw WITHOUT ending the process — a corrupt staged package,
                // antivirus holding the file, a permissions failure on the install directory —
                // and there was no catch here at all. The exception landed in the global
                // UnobservedTaskException handler, which only logs, so the user was left staring
                // at a success splash on top of the version they already had, with no update:error
                // ever sent and nothing in the UI to contradict it. update:error is what dismisses
                // that splash; the toast is what replaces the lie with the truth.
                DiagnosticLog.Error("[Update] Apply failed", ex);
                SendMessage("update:error", new { message = $"Update failed: {ex.Message}" });
                SendMessage("alert:show", new
                {
                    message = $"The update could not be applied: {ex.Message}. TrueReplayer is still running the current version.",
                    type = "error"
                });
            }
            finally
            {
                _updateInProgress = false;
            }
        }

        private async Task HandleClipboardRead()
        {
            string content = string.Empty;
            try
            {
                var data = Windows.ApplicationModel.DataTransfer.Clipboard.GetContent();
                if (data.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.Text))
                {
                    content = await data.GetTextAsync() ?? string.Empty;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[Bridge] Clipboard read failed: {ex.Message}");
            }
            SendMessage("clipboard:content", new { text = content });
        }

        private void HandleThemeColors(JsonElement payload)
        {
            // Defensive reads — GetProperty throws on a missing field and the outer HandleMessage
            // catch would only Debug.WriteLine it, silently skipping the theme update. TryGet a
            // string for each field (null when absent/non-string); the guard below still requires
            // the two load-bearing colors before applying.
            static string? Str(JsonElement p, string name) =>
                p.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString() : null;

            var bgSurface = Str(payload, "bgSurface");
            var bgCard = Str(payload, "bgCard");
            var textPrimary = Str(payload, "textPrimary");
            var textSecondary = Str(payload, "textSecondary");
            var accentSolid = Str(payload, "accentSolid");
            var borderSubtle = Str(payload, "borderSubtle");

            if (bgSurface != null && textPrimary != null)
            {
                profileController.SetDialogThemeColors(bgSurface, bgCard ?? bgSurface, textPrimary, textSecondary ?? textPrimary, accentSolid, borderSubtle);
            }
        }

        private void HandleHotkeySuppress(JsonElement payload)
        {
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            InputHookManager.SuppressAllHotkeys = enabled;
        }

        private void HandleHotkeyCapture(JsonElement payload)
        {
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            // Optional ownerId — when present, register/unregister against the refcount
            // so multiple frontend consumers can hold the hook open simultaneously without
            // stomping each other on cleanup. Backward compat: payloads without ownerId
            // route through a single "legacy" slot (matches the v2.3.0 behaviour exactly).
            string ownerId = payload.TryGetProperty("ownerId", out var idProp) && idProp.ValueKind == JsonValueKind.String
                ? idProp.GetString() ?? "legacy"
                : "legacy";
            if (enabled) InputHookManager.RegisterCapture(ownerId);
            else InputHookManager.UnregisterCapture(ownerId);
        }

        private void HandleSelectionChanged(JsonElement payload)
        {
            if (payload.TryGetProperty("indices", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
                // Pick MIN index — new actions are inserted BEFORE the first selected row, so the
                // selected row(s) flow DOWN past the newly added ones. The global Recording hotkey
                // reads this to know where to drop recorded actions; mirrors the frontend add-action
                // convention (toolbar / ActionBar / command palette / paste all use Math.min(...sel)).
                // Null when no selection → recorder treats it as "append at end".
                int? min = null;
                foreach (var el in arr.EnumerateArray())
                {
                    int val = el.GetInt32();
                    if (min == null || val < min) min = val;
                }
                SelectedInsertIndex = min;
            }
            else
            {
                SelectedInsertIndex = null;
            }
        }

        private void HandleRecordingToggle(JsonElement payload)
        {
            // Recording is suppressed in Clicker mode — the UI button is disabled, but a hotkey
            // forwarded through this handler shouldn't bypass that.
            if (UseCursorClick) return;

            int? insertIndex = null;
            if (payload.TryGetProperty("insertIndex", out var idxEl) && idxEl.ValueKind == JsonValueKind.Number)
                insertIndex = idxEl.GetInt32();

            mainController.EnableInsertMode(insertIndex);
            mainController.ToggleRecording();
        }

        // No payload: the loop settings that used to ride in it are now resolved backend-side
        // (see BuildLoopConfig below), and nothing else in the message was ever read.
        private void HandleReplayToggle()
        {
            if (UseCursorClick)
            {
                // Clicker v2 — read from the dedicated CursorClick* fields (sourced from
                // AppSettings) instead of the profile's CustomDelay/Jitter/Loop. This makes
                // Clicker truly mode-of-the-app, no longer mode-of-active-profile.
                mainController.ToggleCursorClickReplay(BuildClickerConfig());
                return;
            }

            // Loop settings come from the backend, NOT from the payload. The button used to send
            // React's `settings` slice back to us, and that slice is only refreshed by
            // settings:loaded — which no profile-activation path emits. Switching from a 3×
            // profile to a 1× one therefore left the stale 3 in the payload and the button ran
            // the wrong number of passes while the hotkey ran the right one. One resolver, four
            // entry points (button, global Replay hotkey, profile hotkey/hotstring, daemon).
            var loop = BuildLoopConfig();
            bool loopEnabled = loop.Enabled;
            string loopCount = loop.Count;
            bool intervalEnabled = loop.IntervalEnabled;
            string intervalText = loop.Interval;

            bool useVariation = UseDelayVariation;
            int variationPercent = int.TryParse(DelayVariation, out var vp) ? vp : 20;
            bool hasCur = CurrentProfileName != "No Profile";
            var effTarget = hasCur ? profileController.GetEffectiveWindowTarget(CurrentProfileName) : UserProfile.Current.TargetWindow;
            var effRelCoords = hasCur ? profileController.GetEffectiveRelativeCoordinates(CurrentProfileName) : UserProfile.Current.UseRelativeCoordinates;
            var effBringFocus = hasCur ? profileController.GetEffectiveBringToFocus(CurrentProfileName) : UserProfile.Current.BringToFocus;
            var effRestorePos = hasCur ? profileController.GetEffectiveRestorePosition(CurrentProfileName) : UserProfile.Current.RestorePosition;
            var effRestoreSz = hasCur ? profileController.GetEffectiveRestoreSize(CurrentProfileName) : UserProfile.Current.RestoreSize;
            int effW = UserProfile.Current.WindowWidth;
            int effH = UserProfile.Current.WindowHeight;
            int effGX = UserProfile.Current.WindowX;
            int effGY = UserProfile.Current.WindowY;
            // Profile's own geometry only when it owns its target; otherwise the folder's applies
            // WHOLE (see ProfileController.GetEffectiveGeometry) — same gate as the Restore flags
            // just above, so a folder flag can never pair with a profile coordinate. Null means no
            // rect was ever captured on either side: suppress the flags instead of passing zeroes,
            // which Restore Position (not size-gated) would execute as a move to the corner.
            if (hasCur)
            {
                var geom = profileController.GetEffectiveGeometry(CurrentProfileName, effGX, effGY, effW, effH);
                if (geom is null) { effGX = effGY = effW = effH = 0; effRestorePos = false; effRestoreSz = false; }
                else (effGX, effGY, effW, effH) = geom.Value;
            }

            // A profile whose steps LAUNCH their own target (an ActivateWindow row with a
            // LaunchPath) legitimately starts with the target window not yet open — refusing it
            // below would block exactly the self-launch workflow ActivateWindow exists for. Presence
            // of any enabled launcher row is the whole predicate: a launcher signals "this profile
            // spawns windows" regardless of WHICH window, and a non-launching ActivateWindow (pure
            // wait/focus) correctly still gets refused. IsSkipped is the real (inverted) field.
            bool hasSelfLauncher = actions.Any(a =>
                !a.IsSkipped
                && string.Equals(a.ActionType, "ActivateWindow", StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(a.LaunchPath));

            // Mirror the hotkey gate — but adapted for the button: TR is always foreground
            // when the user clicks Replay, so a literal IsForegroundWindowMatch would block
            // the button entirely. Instead, refuse to start when the configured target isn't
            // running anywhere — covers both regular and BringToFocus profiles, since neither
            // can do anything useful when their target process isn't running. Stop is always
            // allowed (clicking while replaying = abort). Skipped when no target is
            // configured (preserves the "no profile" / "no target" workflows) or when the
            // profile launches its own target.
            if (!mainController.IsReplayInProgress()
                && !hasSelfLauncher
                && effTarget != null
                && (!string.IsNullOrEmpty(effTarget.ProcessName) || !string.IsNullOrEmpty(effTarget.WindowTitle)))
            {
                var hwnd = TrueReplayer.Helpers.WindowMatcher.FindWindow(effTarget);
                if (hwnd == IntPtr.Zero)
                {
                    var label = !string.IsNullOrEmpty(effTarget.ProcessName)
                        ? effTarget.ProcessName
                        : effTarget.WindowTitle;
                    DiagnosticLog.Warn($"Replay refused (button): target window not open [{label}], profile='{CurrentProfileName}'");
                    SendMessage("alert:show", new { message = $"Target window not open: {label}" });
                    return;
                }
            }

            mainController.ToggleReplay(loopEnabled, loopCount, intervalEnabled, intervalText, useVariation, variationPercent, effRelCoords, effTarget, effBringFocus, effW, effH, effGX, effGY, effRestorePos, effRestoreSz);
        }

        private void HandleActionsClear()
        {
            PushUndoState();
            Services.ProfileEpoch.Bump("action list cleared");
            actions.Clear();
            HasUnsavedChanges = false;
            mainController.UpdateButtonStates();
        }

        private void HandleActionsCopy()
        {
            ClipboardService.CopyActions(actions);
        }

        private void HandleActionsCopyInternal(JsonElement payload)
        {
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32())
                .OrderBy(i => i)
                .ToList();

            _copiedActions = new List<ActionItem>();
            _copiedSourceProfile = CurrentProfileName != "No Profile" ? CurrentProfileName : "default";
            foreach (var idx in indices)
            {
                if (idx >= 0 && idx < actions.Count)
                    _copiedActions.Add(actions[idx].Clone());
            }
            SendMessage("alert:show", new { message = $"Copied {_copiedActions.Count} action(s)" });
            PushButtonStates();
        }

        private void HandleActionsPaste(JsonElement payload)
        {
            if (_copiedActions == null || _copiedActions.Count == 0)
            {
                SendMessage("alert:show", new { message = "No actions copied" });
                return;
            }

            PushUndoState();
            int insertIndex = payload.TryGetProperty("insertIndex", out var idxEl) ? idxEl.GetInt32() : actions.Count;
            insertIndex = Math.Max(0, Math.Min(insertIndex, actions.Count));

            string dstProfile = CurrentProfileName != "No Profile" ? CurrentProfileName : "default";
            string srcProfile = _copiedSourceProfile ?? dstProfile;

            // Auto-complete partial conditional blocks in the clipboard before paste-time
            // insertion. Common case: the user copied { If, body } without the matching
            // EndIf — the validator appends a synthetic EndIf so the pasted region is
            // self-contained instead of leaking into whatever's around the paste site.
            // Orphan ELSE/EndIf rows in the clipboard get dropped silently (same rule as
            // load-time). Operates on a fresh list (not _copiedActions) so the user's
            // original clipboard isn't mutated and a second paste produces the same
            // result. Uses Clone() so the auto-complete pass and the cross-profile image
            // CloneReferenceImage work on disjoint object identities.
            var paste = _copiedActions.Select(a => a.Clone()).ToList();
            var pasteFix = ConditionalBlockValidator.ValidateAndRepairBlocks(paste);
            if (pasteFix.HadFixups)
                DiagnosticLog.Info($"[ConditionalBlocks] Paste auto-completed: removed {pasteFix.OrphansRemoved} orphan(s), appended {pasteFix.EndIfsAppended} synthetic ENDIF(s)");

            // Suppress CollectionChanged during batch insert — the renumber + single push below
            // replace the one-full-projection-per-row it would have fired.
            actions.CollectionChanged -= OnActionsChanged;
            try
            {
                foreach (var clone in paste)
                {
                    // `paste` already holds freshly-cloned items (auto-completed by the
                    // validator above), so we insert them directly. Image reference cloning
                    // is still per-row: a WaitImage row (or an If Image conditional) carries
                    // a profile-scoped PNG that must be duplicated into the destination
                    // profile so deleting the source doesn't break the paste.
                    bool refsImage = !string.IsNullOrEmpty(clone.ImagePath) && (
                                        clone.ActionType == "WaitImage"
                                        || (IsConditionOpenerRow(clone) && string.Equals(clone.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase)));
                    if (refsImage)
                    {
                        var newPath = ImageStorageService.CloneReferenceImage(srcProfile, clone.ImagePath!, dstProfile);
                        if (newPath != null)
                        {
                            clone.ImagePath = newPath;
                        }
                        else
                        {
                            // Clone failed — usually because the source profile was deleted
                            // between copy and paste. Keeping the original ImagePath would
                            // leave the pasted row pointing at a now-missing PNG. Clear the
                            // reference instead so the user sees an empty thumbnail and a
                            // visible "no image captured" hint in the Sheet, prompting them
                            // to recapture rather than silently shipping a broken row.
                            clone.ImagePath = null;
                            DiagnosticLog.Info($"[Paste] Reference image clone failed for {clone.ActionType} (src='{srcProfile}' → dst='{dstProfile}'); ImagePath cleared.");
                        }
                    }
                    clone.RowNumber = insertIndex + 1;
                    actions.Insert(insertIndex, clone);
                    insertIndex++;
                }
            }
            finally
            {
                actions.CollectionChanged += OnActionsChanged;
            }

            // Recalculate row numbers
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;

            HasUnsavedChanges = true;
            // Use the effective paste count (may include auto-appended EndIf rows) so the
            // toast tells the user what actually landed in the grid, not the pre-fix
            // clipboard count.
            SendMessage("alert:show", new { message = $"Pasted {paste.Count} action(s)" });
            PushActionsUpdate();
        }

        private void HandleActionsEdit(JsonElement payload)
        {
            // Defensive payload reads — GetProperty throws on missing fields and the outer
            // try/catch in HandleMessage would silently swallow it (Debug.WriteLine only).
            // TryGet returns explicit failure so we can no-op safely.
            if (!payload.TryGetProperty("index", out var indexEl) || indexEl.ValueKind != JsonValueKind.Number) return;
            if (!payload.TryGetProperty("field", out var fieldEl)) return;
            if (!payload.TryGetProperty("value", out var valueEl)) return;

            int index = indexEl.GetInt32();
            string field = fieldEl.GetString() ?? "";
            string value = valueEl.GetString() ?? "";

            if (index < 0 || index >= actions.Count) return;

            // Reject an unknown actionType before snapshotting — an arbitrary string would set a
            // row no execution branch handles (silent no-op at replay) and is rejected here for
            // the same reason the bounds guard runs before PushUndoState: a no-op must not leave
            // a stale undo state behind (and clear the redo stack).
            if (field == "actionType" && !KnownActionTypes.Contains(value))
            {
                DiagnosticLog.Warn($"actions:edit rejected unknown actionType '{value}' at index {index}");
                return;
            }

            // Snapshot only once the edit is guaranteed to land — pushing before the bounds
            // guard would leave a duplicate undo state (and clear the redo stack) on a no-op.
            PushUndoState();

            var action = actions[index];
            switch (field)
            {
                case "actionType": action.ActionType = value; break;
                case "key":
                    action.Key = value;
                    // INVALIDATION CONTRACT (ActionItem.KeyHtml): a plain-text edit of a SendText
                    // payload without fresh HTML must drop the stale rich flavor, or replay would
                    // paste the OLD formatted content over the new text. Rich edits go through
                    // actions:editSendText, which supplies both flavors together.
                    if (action.ActionType == "SendText") { action.KeyHtml = null; action.KeyMarkdown = null; action.SendMode = null; }
                    break;
                case "x": if (int.TryParse(value, out int x)) action.X = x; break;
                case "y": if (int.TryParse(value, out int y)) action.Y = y; break;
                case "delay": if (int.TryParse(value, out int delay)) action.Delay = Math.Max(0, delay); break;
                case "comment": action.Comment = value; break;
                case "timeout":
                    if (int.TryParse(value, out int timeout))
                    {
                        // Pause uses 0 as the "wait forever" sentinel — clamping would silently
                        // rewrite it to 1s. Other actions (Browser, WaitImage) need a positive
                        // timeout to make sense, so they still get clamped to 1 s minimum.
                        action.Timeout = action.ActionType == "Pause" ? Math.Max(0, timeout) : Math.Max(1000, timeout);
                    }
                    break;
                case "confidence": if (double.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out double conf)) action.Confidence = Math.Clamp(conf, 0.1, 1.0); break;
                case "browserText": action.BrowserText = value; break;
                case "newTab": action.NewTab = value == "true"; break;
                case "waitMode": action.WaitMode = string.IsNullOrEmpty(value) ? null : value; break;
                case "urlWaitPattern": action.UrlWaitPattern = string.IsNullOrEmpty(value) ? null : value; break;
                case "postNavigateSelector": action.PostNavigateSelector = string.IsNullOrEmpty(value) ? null : value; break;
                case "typeAppend": action.TypeAppend = value == "true"; break;
                case "typePaste": action.TypePaste = value == "true"; break;
                case "typeDelay":
                    if (string.IsNullOrEmpty(value)) action.TypeDelay = null;
                    else if (int.TryParse(value, out int td)) action.TypeDelay = Math.Max(0, td);
                    break;
                case "selectMatchMode":
                    // Default "text" stays null on disk; only "value" or "index" are persisted explicitly.
                    action.SelectMatchMode = (string.IsNullOrEmpty(value) || value == "text") ? null : value;
                    break;
                case "waitImageOnTimeout":
                    // Only "Continue" needs to be persisted; "StopReplay" is the default and stays
                    // null on disk to keep the JSON minimal and self-explanatory.
                    action.WaitImageOnTimeout = value == "Continue" ? "Continue" : null;
                    break;
                case "waitImageInvert":
                    action.WaitImageInvert = value == "true";
                    break;
                case "waitImageClickOnMatch":
                    action.WaitImageClickOnMatch = value == "true";
                    break;
                case "repeat":
                    // Keystroke + RunProfile both use RepeatCount. Clamp 1..999 matches
                    // the range advertised by every editor surface (inline badge, dialogs).
                    if (int.TryParse(value, out int rep))
                        action.RepeatCount = Math.Max(1, Math.Min(999, rep));
                    break;
                case "holdDurationMs":
                    // HoldKey: clamp 10..60000 ms. The inline editor / dialog enforce
                    // the same range — duplicating here defends against malformed payloads
                    // from an attacker / older frontend build.
                    if (int.TryParse(value, out int hd))
                        action.HoldDurationMs = Math.Max(10, Math.Min(60000, hd));
                    break;
                case "repeatDelayMs":
                    // Empty → null (= "use the global default"). Explicit number → clamp
                    // 0..5000 ms. Only Keystroke consults this field; RunProfile ignores
                    // it but storing it is harmless (serializer skips when null).
                    if (string.IsNullOrEmpty(value)) action.RepeatDelayMs = null;
                    else if (int.TryParse(value, out int rd)) action.RepeatDelayMs = Math.Max(0, Math.Min(5000, rd));
                    break;
                case "repeatDelayJitterPct":
                    // Empty / 0 → null (jitter OFF, schema-clean). Explicit > 0 → clamp 1..100.
                    // Storing null when off keeps a Keystroke × N without jitter byte-identical
                    // to a pre-feature profile (WhenWritingNull drops the property).
                    if (string.IsNullOrEmpty(value)) action.RepeatDelayJitterPct = null;
                    else if (int.TryParse(value, out int rj)) action.RepeatDelayJitterPct = rj > 0 ? Math.Min(100, rj) : (int?)null;
                    break;
                case "repeatPositionJitterPx":
                    // Empty / 0 → null (scatter OFF, schema-clean). Explicit > 0 → clamp 1..500
                    // (the Clicker's position cap). Storing null when off keeps a click × N
                    // without scatter byte-identical to a pre-feature profile.
                    if (string.IsNullOrEmpty(value)) action.RepeatPositionJitterPx = null;
                    else if (int.TryParse(value, out int rpj)) action.RepeatPositionJitterPx = rpj > 0 ? Math.Min(500, rpj) : (int?)null;
                    break;
                case "waitImageSearchRegion":
                    // Value format: "x,y,w,h" (all ints) — or empty string to clear.
                    if (string.IsNullOrEmpty(value)) {
                        action.WaitImageSearchX = null;
                        action.WaitImageSearchY = null;
                        action.WaitImageSearchW = null;
                        action.WaitImageSearchH = null;
                    } else {
                        var parts = value.Split(',');
                        if (parts.Length == 4
                            && int.TryParse(parts[0], out int sx)
                            && int.TryParse(parts[1], out int sy)
                            && int.TryParse(parts[2], out int sw)
                            && int.TryParse(parts[3], out int sh)
                            && sw > 0 && sh > 0) {
                            action.WaitImageSearchX = sx;
                            action.WaitImageSearchY = sy;
                            action.WaitImageSearchW = sw;
                            action.WaitImageSearchH = sh;
                        }
                    }
                    break;
                case "pixelX":
                    // Empty clears the field (returns to "not configured" → immediate timeout
                    // at execution). Otherwise parse as int; absolute virtual-screen coord.
                    if (string.IsNullOrEmpty(value)) action.PixelX = null;
                    else if (int.TryParse(value, out int pxx)) action.PixelX = pxx;
                    break;
                case "pixelY":
                    if (string.IsNullOrEmpty(value)) action.PixelY = null;
                    else if (int.TryParse(value, out int pxy)) action.PixelY = pxy;
                    break;
                case "pixelColor":
                    // Empty = clear target. Otherwise expect "#RRGGBB" — the editor's hex
                    // input normalises on commit; an unparseable string surfaces at execution
                    // time as immediate-timeout instead of a crash, so no validation here.
                    action.PixelColor = string.IsNullOrEmpty(value) ? null : value;
                    break;
                case "pixelTolerance":
                    // 0–255 per channel. Anything outside clamps to that range rather than
                    // rejecting, since a malformed payload (older frontend, edited JSON)
                    // shouldn't silently break the action.
                    if (int.TryParse(value, out int ptol))
                        action.PixelTolerance = Math.Max(0, Math.Min(255, ptol));
                    break;
                case "pixelOnTimeout":
                    // Same convention as waitImageOnTimeout — only "Continue" is persisted;
                    // default "StopReplay" stays null on disk so saved profiles read clean.
                    action.PixelOnTimeout = value == "Continue" ? "Continue" : null;
                    break;
                case "pixelInvert":
                    action.PixelInvert = value == "true";
                    break;
                case "pixelClickOnMatch":
                    action.PixelClickOnMatch = value == "true";
                    break;
                case "conditionType":
                    // null/empty resets the field. Otherwise pass-through — the Sheet
                    // only ever sends "ImageFound" or "PixelColorMatch", but a future
                    // value ("WindowExists", "WindowFocused") would land here cleanly
                    // without needing a bridge update.
                    action.ConditionType = string.IsNullOrEmpty(value) ? null : value;
                    break;
                case "conditionNegate":
                    action.ConditionNegate = value == "true";
                    break;
                case "conditionTimeout":
                    if (int.TryParse(value, out int condTimeout)) action.ConditionTimeout = Math.Max(0, condTimeout);
                    break;
                case "loopMaxIterations":
                    // While ceiling: 0 = the 1000-iteration safety default; floor junk at 0.
                    if (int.TryParse(value, out int loopMax)) action.LoopMaxIterations = Math.Max(0, loopMax);
                    break;
                case "ifOnProbeError":
                    // Same convention as waitImageOnTimeout / pixelOnTimeout — only the
                    // non-default "Halt" is persisted; "TreatAsFalse" stays null on disk
                    // so existing profiles round-trip clean.
                    action.IfOnProbeError = value == "Halt" ? "Halt" : null;
                    break;
                case "variableValue":
                    // SetVariable's value (the name lives in Key via the generic "key" case).
                    // Empty is a REAL value ("delete the variable at replay"), so it is kept
                    // as "" rather than collapsing to null — null means "never edited".
                    action.VariableValue = value;
                    break;
                case "variableMode":
                    // Only the non-default "cycle" is persisted; "set" stays null on disk
                    // (same convention as waitImageOnTimeout / activateOnTimeout).
                    action.VariableMode = value == "cycle" ? "cycle" : null;
                    break;
                case "slotMode":
                    // CopyToSlot: only the non-default "clear" is persisted; "capture"
                    // stays null on disk (same convention as variableMode above).
                    action.SlotMode = value == "clear" ? "clear" : null;
                    break;
                case "windowProcessName":
                    action.WindowProcessName = string.IsNullOrEmpty(value) ? null : value;
                    break;
                case "windowTitle":
                    action.WindowTitle = string.IsNullOrEmpty(value) ? null : value;
                    break;
                case "windowTitleMatchMode":
                    // Default "contains" stays null on disk; only "regex" is persisted.
                    action.WindowTitleMatchMode = value == "regex" ? "regex" : null;
                    break;
                case "windowMatchForegroundOnly":
                    action.WindowMatchForegroundOnly = value == "true";
                    break;
                case "launchPath":
                    // ActivateWindow: what to launch when no matching window exists.
                    // Empty → null so focus-only rows keep their JSON minimal.
                    action.LaunchPath = string.IsNullOrEmpty(value) ? null : value;
                    break;
                case "launchArgs":
                    action.LaunchArgs = string.IsNullOrEmpty(value) ? null : value;
                    break;
                case "activateOnTimeout":
                    // Same convention as waitImageOnTimeout — only "Continue" is persisted;
                    // the default "Halt" stays null on disk so saved profiles read clean.
                    action.ActivateOnTimeout = value == "Continue" ? "Continue" : null;
                    break;
                // ActivateWindow placement — move/resize the activated window. Position may be
                // negative (a secondary monitor left of the primary), so only size is clamped.
                case "restorePosition":
                    action.RestorePosition = value == "true";
                    break;
                case "restoreSize":
                    action.RestoreSize = value == "true";
                    break;
                case "windowX":
                    if (int.TryParse(value, out int winX)) action.WindowX = winX;
                    break;
                case "windowY":
                    if (int.TryParse(value, out int winY)) action.WindowY = winY;
                    break;
                case "windowWidth":
                    if (int.TryParse(value, out int winW)) action.WindowWidth = Math.Max(0, winW);
                    break;
                case "windowHeight":
                    if (int.TryParse(value, out int winH)) action.WindowHeight = Math.Max(0, winH);
                    break;
                // ActivateWindow Phase 3 — verb + nth-match. Only the non-default verb persists (the
                // default "activate" collapses to null, like activateOnTimeout's "Halt"); match index
                // is 1-based, and 1 (the first match) collapses to null so ordinary rows stay clean.
                case "windowVerb":
                    action.WindowVerb = (value == "maximize" || value == "minimize" || value == "close") ? value : null;
                    break;
                case "windowMatchIndex":
                    action.WindowMatchIndex = int.TryParse(value, out int wmi) && wmi > 1 ? wmi : (int?)null;
                    break;
                case "assertOnFail":
                    // Assert/BrowserAssert — "Continue" and "StopReplay" (quiet-stop, D4)
                    // persist; the default "Halt" stays null. Without the StopReplay arm this
                    // normalization silently reverted the FE's quiet-stop save back to Halt.
                    action.AssertOnFail = (value == "Continue" || value == "StopReplay") ? value : null;
                    break;
                case "clipboardPatternType":
                    // Default "contains" stays null on disk; only "equals"/"regex" persist.
                    action.ClipboardPatternType = (value == "equals" || value == "regex") ? value : null;
                    break;
                case "clipboardPattern":
                    action.ClipboardPattern = string.IsNullOrEmpty(value) ? null : value;
                    break;
                case "randomPercent":
                    // If Random: probability 0..100. Clamp a malformed payload rather than reject.
                    if (int.TryParse(value, out int rp))
                        action.RandomPercent = Math.Clamp(rp, 0, 100);
                    break;
                case "conditionOperator":
                    // If Variable: eq (default) | neq | contains | gt | lt. Default stays null on disk.
                    action.ConditionOperator = (value == "neq" || value == "contains" || value == "gt" || value == "lt")
                        ? value : null;
                    break;
                case "conditionOperand":
                    action.ConditionOperand = string.IsNullOrEmpty(value) ? null : value;
                    break;
                case "filePath":
                    action.FilePath = string.IsNullOrEmpty(value) ? null : value;
                    break;
                case "timeStart":
                    action.TimeStart = string.IsNullOrEmpty(value) ? null : value;
                    break;
                case "timeEnd":
                    action.TimeEnd = string.IsNullOrEmpty(value) ? null : value;
                    break;
                case "daysOfWeek":
                    // If Time: bitmask Sun=1<<0 … Sat=1<<6. 0 = every day.
                    if (int.TryParse(value, out int dow))
                        action.DaysOfWeek = dow & 0x7F;
                    break;
                case "selectorAlternatives":
                    // JSON-encoded array of {selector, tier, description} captured at pick
                    // time; empty string clears (hand-typed selector invalidates old picks).
                    // Malformed JSON (older/broken frontend) is ignored — keeping the
                    // previous value beats crashing the edit pipeline.
                    if (string.IsNullOrEmpty(value))
                    {
                        action.SelectorAlternatives = null;
                    }
                    else
                    {
                        try
                        {
                            var parsed = JsonSerializer.Deserialize<List<Models.SelectorAlternativeItem>>(value, JsonOptions);
                            action.SelectorAlternatives = (parsed != null && parsed.Count > 0
                                && parsed.All(p => !string.IsNullOrEmpty(p.Selector)))
                                ? parsed : null;
                        }
                        catch (JsonException)
                        {
                            DiagnosticLog.Warn($"actions:edit selectorAlternatives: malformed JSON ignored at index {index}");
                        }
                    }
                    break;
            }

            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        private void HandleActionsDelete(JsonElement payload)
        {
            // Same defensive read as HandleActionsEdit — guard against missing/non-array
            // payload + skip non-integer entries instead of crashing through the outer
            // catch (which would have left undo state pushed but no actual deletion).
            if (!payload.TryGetProperty("indices", out var indicesEl) || indicesEl.ValueKind != JsonValueKind.Array) return;
            var indices = indicesEl.EnumerateArray()
                .Where(e => e.ValueKind == JsonValueKind.Number)
                .Select(e => e.GetInt32())
                .OrderByDescending(i => i)
                .ToList();
            if (indices.Count == 0) return;

            PushUndoState();

            // Suppress CollectionChanged during batch delete
            actions.CollectionChanged -= OnActionsChanged;
            try
            {
                // We intentionally don't delete the PNG of WaitImage actions here so undo can restore
                // the action with its original reference image still on disk. Orphan PNGs (those no
                // longer referenced by any action in any profile) are cleaned up at app startup by
                // ImageStorageService.CleanupOrphanImages.
                foreach (var idx in indices)
                {
                    if (idx >= 0 && idx < actions.Count)
                        actions.RemoveAt(idx);
                }
            }
            finally
            {
                actions.CollectionChanged += OnActionsChanged;
            }

            // Recalculate row numbers and push single update. List-only, like OnActionsChanged
            // would have: a delete cannot touch UserProfile.Current.Data.
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;

            HasUnsavedChanges = true;
            PushActionListOnly();
            mainController.UpdateButtonStates();
        }

        /// <summary>
        /// Atomically replace a contiguous range of actions with a new list. Used by
        /// the "Collapse to × N" / "Expand × N" flow on the frontend: N rows in
        /// becomes M rows out under a single undo step. Splitting this into a delete
        /// + insert would let the user Ctrl+Z to a partially-collapsed mid-state
        /// (broken Down/Up alternation), so a single PushUndoState is essential.
        /// </summary>
        private void HandleActionsReplaceRange(JsonElement payload)
        {
            int start = payload.GetProperty("startIndex").GetInt32();
            int count = payload.GetProperty("count").GetInt32();
            var replacementEl = payload.GetProperty("replacement");

            // Bounds — guard against malformed payloads. A bad start/count would
            // either no-op (clamp to zero) or throw on RemoveAt; we no-op silently
            // since the frontend has already validated the selection by this point.
            if (start < 0 || count <= 0 || start + count > actions.Count) return;

            // Snapshot after the bounds guard so a rejected range doesn't push a
            // duplicate undo state (and wipe the redo stack) for nothing.
            PushUndoState();

            var newItems = JsonSerializer.Deserialize<List<ActionItem>>(
                replacementEl.GetRawText(), JsonOptions) ?? new List<ActionItem>();

            for (int i = 0; i < count; i++) actions.RemoveAt(start);
            for (int i = 0; i < newItems.Count; i++) actions.Insert(start + i, newItems[i]);

            for (int i = 0; i < actions.Count; i++) actions[i].RowNumber = i + 1;
            HasUnsavedChanges = true;
            PushActionsUpdate();
            mainController.UpdateButtonStates();
        }

        private void HandleBulkUpdateDelay(JsonElement payload)
        {
            PushUndoState();
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32())
                .ToList();
            int delay = payload.GetProperty("delay").GetInt32();
            delay = Math.Max(0, delay);

            foreach (var idx in indices)
            {
                if (idx < 0 || idx >= actions.Count) continue;
                // Pure jump markers carry no replay delay — never bulk-set theirs. The opening
                // IF and WHILE DO carry one (the pre-probe "settle" knob; per iteration on a
                // While), so they're bulk-set like any normal action. ForEachRow joins the
                // marker set: it has no probe, and the validator zeroes it at load anyway.
                var t = actions[idx].ActionType;
                if (string.Equals(t, "Else", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(t, "EndIf", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(t, "EndLoop", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(t, "BreakLoop", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(t, "ContinueLoop", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(t, "ForEachRow", StringComparison.OrdinalIgnoreCase))
                    continue;
                actions[idx].Delay = delay;
            }

            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        private void HandleBulkUpdateCoord(JsonElement payload)
        {
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32()).ToList();
            string axis = payload.GetProperty("axis").GetString() ?? "x"; // "x" or "y"
            string valueStr = (payload.GetProperty("value").GetString() ?? "").Trim();
            bool isOffset = valueStr.StartsWith("+") || valueStr.StartsWith("-");

            // A FAILED int.TryParse used to fall through to 0 — and 0 is a legal coordinate, so a
            // typo ("5oo", "500.5", anything past int range) silently drove every selected click
            // to X=0 in the absolute form, indistinguishable from a deliberate "set them all to
            // zero", and the toast below confirmed success either way. The frontend now rejects
            // the same shapes, but this is the enforcing side: the bridge dispatches by string
            // name, so a stale frontend build or any other caller arrives here directly.
            //
            // Placed BEFORE PushUndoState so a rejection touches neither the undo nor the redo
            // stack, the same reason the empty-target guard below is resolved before the push.
            if (!int.TryParse(valueStr, out var val))
            {
                SendMessage("alert:show", new { message = $"\"{valueStr}\" is not a valid {axis.ToUpper()} value. Use a whole number to set (500), or a signed one to offset (+10, -5)." });
                return;
            }

            // Resolve the rows that will actually move BEFORE snapshotting. X/Y only mean anything
            // on a mouse click (paired halves + combined single clicks), so a selection holding
            // none of those is a pure no-op — and a no-op must not reach PushUndoState, because
            // that call CLEARS the redo stack. The old shape pushed first and then popped the undo
            // entry back off here; the pop cannot un-clear the redo stack, so a bulk X/Y aimed at,
            // say, a run of SendText rows destroyed the user's whole redo history while changing
            // nothing and saying so. Deciding first is the only shape where that cannot happen.
            //
            // Duplicate indices are deliberately NOT collapsed: the same row listed twice was
            // offset twice (and counted twice) before, and the frontend never sends duplicates
            // anyway — de-duplicating here would be a silent behaviour change smuggled in
            // alongside the fix.
            var targets = indices
                .Where(idx => idx >= 0 && idx < actions.Count)
                .Select(idx => actions[idx])
                .Where(a => a.ActionType is "LeftClickDown" or "LeftClickUp" or "RightClickDown" or "RightClickUp" or "MiddleClickDown" or "MiddleClickUp"
                    or "LeftClick" or "RightClick" or "MiddleClick" or "DoubleClick")
                .ToList();

            if (targets.Count == 0)
            {
                SendMessage("alert:show", new { message = "X/Y can only be set on mouse click actions." });
                return;
            }

            PushUndoState();

            foreach (var a in targets)
            {
                if (axis == "x")
                    a.X = isOffset ? a.X + val : val;
                else
                    a.Y = isOffset ? a.Y + val : val;
            }

            var label = isOffset ? valueStr : $"= {val}";
            SendMessage("alert:show", new { message = $"Set {axis.ToUpper()} {label} for {targets.Count} action(s)" });
            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        private void HandleBulkUpdateComment(JsonElement payload)
        {
            PushUndoState();
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32()).ToList();
            string comment = payload.GetProperty("comment").GetString() ?? "";

            foreach (var idx in indices)
            {
                if (idx >= 0 && idx < actions.Count)
                    actions[idx].Comment = comment;
            }
            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        private void HandleActionsToggleSkip(JsonElement payload)
        {
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32())
                .Where(i => i >= 0 && i < actions.Count)
                .ToList();
            if (indices.Count == 0) return;

            // Snapshot only once we know at least one row will flip — pushing before the
            // empty-selection guard would leak a duplicate undo state on a no-op.
            PushUndoState();

            // Smart toggle: if every selected action is already skipped, un-skip all;
            // otherwise skip all. Consistent with how most UIs handle batch toggles.
            bool allSkipped = indices.All(i => actions[i].IsSkipped);
            bool newState = !allSkipped;

            foreach (var idx in indices)
                actions[idx].IsSkipped = newState;

            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        // Toggle the per-action "focus click" flag on the selected COMBINED click actions
        // (LeftClick / RightClick / MiddleClick). A focus click replays as two clicks a few
        // pixels apart so a small target (e.g. a Roblox text field at minimum window size)
        // actually receives focus — see ActionReplayer.FocusTap. Smart toggle mirrors Skip:
        // if every targeted click is already on, turn all off; otherwise turn all on. Non-click
        // indices are filtered out (the menu only offers this on clicks — defence in depth) so a
        // mixed selection never flips a flag the replay would ignore.
        private void HandleActionsToggleFocusClick(JsonElement payload)
        {
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32())
                .Where(i => i >= 0 && i < actions.Count)
                .Where(i => actions[i].ActionType is "LeftClick" or "RightClick" or "MiddleClick")
                .ToList();
            if (indices.Count == 0) return;

            // Snapshot only after confirming at least one eligible click is selected, so a
            // selection with no combined-click rows doesn't leave a stale undo state.
            PushUndoState();

            bool allOn = indices.All(i => actions[i].IsFocusClick);
            bool newState = !allOn;

            foreach (var idx in indices)
                actions[idx].IsFocusClick = newState;

            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        // Reset a SetVariable cycle row's position back to item 1. Pure runtime state —
        // no profile edit, no undo, no save: it only clears the in-memory cursor so the
        // next execution starts over at the first item. Confirmed with a toast.
        private void HandleActionsResetCycle(JsonElement payload)
        {
            int index = payload.GetProperty("index").GetInt32();
            if (index < 0 || index >= actions.Count) return;
            var action = actions[index];
            if (!string.Equals(action.ActionType, "SetVariable", StringComparison.Ordinal)
                || !string.Equals(action.VariableMode, "cycle", StringComparison.OrdinalIgnoreCase))
                return;
            replayService.ResetCycleCursor(action.Id);
            SendMessage("alert:show", new { message = $"Cycle '{action.Key}' reset to the first item", type = "success" });
        }

        // Reset the data-loop row cursor (Model B) to the first row. Per-profile runtime
        // state — no profile edit, no save. Only meaningful when the active profile has a
        // data table (the context-menu entry is gated to cursor mode), but harmless
        // otherwise, so it just no-ops when there are no rows to cursor through.
        private void HandleActionsResetRow()
        {
            var data = UserProfile.Current?.Data;
            if (data == null || (data.Rows?.Count ?? 0) == 0) return;
            replayService.ResetRowCursor();
            SendMessage("alert:show", new { message = "Data-loop row position reset to the first row", type = "success" });
        }

        private void HandleActionsReorder(JsonElement payload)
        {
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32())
                .OrderBy(i => i)
                .ToList();
            int targetIndex = payload.GetProperty("targetIndex").GetInt32();

            if (indices.Count == 0) return;

            // Validate all indices
            var validIndices = indices.Where(i => i >= 0 && i < actions.Count).ToList();
            if (validIndices.Count == 0) return;

            // Snapshot after both index guards — an empty or fully-invalid selection is a
            // no-op and must not push a duplicate undo state / clear the redo stack.
            PushUndoState();

            // Suppress CollectionChanged during batch reorder
            actions.CollectionChanged -= OnActionsChanged;
            try
            {
                // Extract the items to move (preserving their relative order)
                var itemsToMove = validIndices.Select(i => actions[i]).ToList();

                // Remove from end to start to preserve indices during removal
                foreach (var idx in validIndices.OrderByDescending(i => i))
                    actions.RemoveAt(idx);

                // Adjust target: for each removed item that was before targetIndex, shift down by 1
                int adjustedTarget = targetIndex - validIndices.Count(i => i < targetIndex);
                adjustedTarget = Math.Max(0, Math.Min(adjustedTarget, actions.Count));

                // Insert all items at the target position
                for (int i = 0; i < itemsToMove.Count; i++)
                    actions.Insert(adjustedTarget + i, itemsToMove[i]);
            }
            finally
            {
                actions.CollectionChanged += OnActionsChanged;
            }

            // Recalculate row numbers and push single update
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;

            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        private void HandleAddSendText(JsonElement payload)
        {
            string text = payload.GetProperty("text").GetString() ?? "";
            if (string.IsNullOrEmpty(text)) return;

            // Snapshot after the empty-text guard so an empty payload doesn't leak undo state.
            PushUndoState();

            int delay = int.TryParse(CustomDelay, out var d) ? d : 100;
            // Optional rich flavors + delivery mode from the Insert Text dialog. html/markdown are
            // Lexical-derived (null when the doc has no formatting); mode = rich|markdown|plain
            // (null = rich = byte-identical to pre-rich when html is also null).
            string? html = payload.TryGetProperty("html", out var hEl) && hEl.ValueKind == JsonValueKind.String ? hEl.GetString() : null;
            string? markdown = payload.TryGetProperty("markdown", out var mdEl) && mdEl.ValueKind == JsonValueKind.String ? mdEl.GetString() : null;
            string? mode = payload.TryGetProperty("mode", out var mEl) && mEl.ValueKind == JsonValueKind.String ? mEl.GetString() : null;
            var action = new ActionItem
            {
                ActionType = "SendText", Key = text, Delay = delay,
                KeyHtml = string.IsNullOrEmpty(html) ? null : html,
                KeyMarkdown = string.IsNullOrEmpty(markdown) ? null : markdown,
                SendMode = NormalizeSendMode(mode),
            };

            if (payload.TryGetProperty("insertIndex", out var idxEl) && idxEl.ValueKind == JsonValueKind.Number)
            {
                int idx = idxEl.GetInt32();
                if (idx >= 0 && idx <= actions.Count)
                    actions.Insert(idx, action);
                else
                    actions.Add(action);
            }
            else
            {
                actions.Add(action);
            }

            HasUnsavedChanges = true;
            mainController.UpdateButtonStates();
        }

        private void HandleEditSendText(JsonElement payload)
        {
            int index = payload.GetProperty("index").GetInt32();
            string text = payload.GetProperty("text").GetString() ?? "";

            if (index < 0 || index >= actions.Count) return;
            if (actions[index].ActionType != "SendText") return;

            // Snapshot after the bounds + type guards so a stale/mismatched edit is a clean no-op.
            PushUndoState();

            actions[index].Key = text;
            // The dialog always sends the CURRENT html + markdown alongside the text (null when the
            // doc has no formatting) — so assigning unconditionally doubles as the invalidation:
            // stale rich flavors can never survive a text-only rewrite.
            string? editHtml = payload.TryGetProperty("html", out var hEl) && hEl.ValueKind == JsonValueKind.String ? hEl.GetString() : null;
            string? editMarkdown = payload.TryGetProperty("markdown", out var mdEl) && mdEl.ValueKind == JsonValueKind.String ? mdEl.GetString() : null;
            actions[index].KeyHtml = string.IsNullOrEmpty(editHtml) ? null : editHtml;
            actions[index].KeyMarkdown = string.IsNullOrEmpty(editMarkdown) ? null : editMarkdown;
            if (payload.TryGetProperty("mode", out var mEl) && mEl.ValueKind == JsonValueKind.String)
                actions[index].SendMode = NormalizeSendMode(mEl.GetString());
            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        // Only the known non-default modes persist; anything else (or "rich") collapses to null so
        // the default stays out of the JSON and older builds see no unknown value (they degrade to a
        // plain paste of Key, a safe fallback). "discord" is a markdown flavor with Discord marks.
        private static string? NormalizeSendMode(string? mode)
            => string.Equals(mode, "markdown", StringComparison.OrdinalIgnoreCase) ? "markdown"
             : string.Equals(mode, "discord", StringComparison.OrdinalIgnoreCase) ? "discord"
             : string.Equals(mode, "plain", StringComparison.OrdinalIgnoreCase) ? "plain"
             : null;

        // ── Profile chaining: insert / edit a RunProfile action ──

        private void HandleAddRunProfile(JsonElement payload)
        {
            string targetName = payload.GetProperty("profileName").GetString() ?? "";
            if (string.IsNullOrEmpty(targetName)) return;

            // Snapshot after the empty-name guard so a blank target doesn't leak undo state.
            PushUndoState();

            int repeat = 1;
            if (payload.TryGetProperty("repeatCount", out var rEl) && rEl.ValueKind == JsonValueKind.Number)
                repeat = Math.Clamp(rEl.GetInt32(), 1, 999);

            int delay = int.TryParse(CustomDelay, out var d) ? d : 100;
            var action = new ActionItem
            {
                ActionType = "RunProfile",
                Key = targetName,
                RepeatCount = repeat,
                // Phase C — null-means-false so plain rows stay byte-identical on disk.
                RunOverData = payload.TryGetProperty("runOverData", out var rodEl)
                    && rodEl.ValueKind == JsonValueKind.True ? true : null,
                Delay = delay,
            };

            if (payload.TryGetProperty("insertIndex", out var idxEl) && idxEl.ValueKind == JsonValueKind.Number)
            {
                int idx = idxEl.GetInt32();
                if (idx >= 0 && idx <= actions.Count)
                    actions.Insert(idx, action);
                else
                    actions.Add(action);
            }
            else
            {
                actions.Add(action);
            }

            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;

            HasUnsavedChanges = true;
            PushActionsUpdate();
            mainController.UpdateButtonStates();
        }

        private void HandleEditRunProfile(JsonElement payload)
        {
            int index = payload.GetProperty("index").GetInt32();
            if (index < 0 || index >= actions.Count) return;
            if (actions[index].ActionType != "RunProfile") return;

            // Snapshot after the bounds + type guards so a stale/mismatched edit is a clean no-op.
            PushUndoState();

            if (payload.TryGetProperty("profileName", out var nameEl) && nameEl.ValueKind == JsonValueKind.String)
            {
                var name = nameEl.GetString();
                if (!string.IsNullOrEmpty(name)) actions[index].Key = name;
            }

            if (payload.TryGetProperty("repeatCount", out var rEl) && rEl.ValueKind == JsonValueKind.Number)
                actions[index].RepeatCount = Math.Clamp(rEl.GetInt32(), 1, 999);

            // Phase C toggle — stored null-means-false so pre-feature rows stay byte-identical.
            if (payload.TryGetProperty("runOverData", out var rodEl)
                && (rodEl.ValueKind == JsonValueKind.True || rodEl.ValueKind == JsonValueKind.False))
                actions[index].RunOverData = rodEl.ValueKind == JsonValueKind.True ? true : null;

            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        /// <summary>
        /// Pushes the current sub-profile call stack to the UI. Empty list = not in a chain.
        /// React renders "Running A → B" in the status bar based on this.
        /// </summary>
        public void PushReplayChainUpdate(List<string> stack)
        {
            SendMessage("replay:chain", new { stack });
        }

        /// <summary>
        /// Row position inside the sub-profile currently executing, for the "(4/11)" tail on the
        /// chain read-out. Kept OUT of replay:chain on purpose: the stack changes only on
        /// push/pop, while this lands ~4×/s, and replay:chain feeds the main AppState reducer —
        /// merging them would re-render every useAppState() consumer four times a second for the
        /// whole of a chained run. React routes this one to the live-slice reducer instead.
        /// </summary>
        public void PushReplayChainStep(int current, int total)
        {
            SendMessage("replay:chainStep", new { current, total });
        }

        public void PushReplayPaused(string hotkey, int timeoutMs)
        {
            SendMessage("replay:paused", new { hotkey, timeoutMs });
        }

        public void PushReplayResumed()
        {
            SendMessage("replay:resumed", new { });
        }

        // {input:Label} Ask-Input modal: ask React to show the prompt (options != null → dropdown),
        // and dismiss a still-open prompt when the run is cancelled/stopped mid-prompt.
        public void PushInputRequest(string requestId, string label, string[]? options)
        {
            SendMessage("replay:inputRequest", new { requestId, label, options });
        }

        public void PushInputDismiss(string requestId)
        {
            SendMessage("replay:inputDismiss", new { requestId });
        }

        // Live-variables pane feed: the current run-state snapshot (variables + clip slots +
        // the data-loop row being executed, or null). Dictionaries are already copies made on
        // the replay side, so serializing here can't race the live run.
        public void PushVariablesUpdate(
            System.Collections.Generic.Dictionary<string, string> variables,
            System.Collections.Generic.Dictionary<string, string> slots,
            System.Collections.Generic.Dictionary<string, string>? rowData)
        {
            SendMessage("replay:variables", new { variables, slots, rowData });
        }

        // The Ask-Input modal was submitted or cancelled — route the answer back to the paused
        // resolver (cancelled → the run aborts).
        private void HandleInputResult(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var r) ? (r.GetString() ?? "") : "";
            if (string.IsNullOrEmpty(requestId)) return;
            bool cancelled = payload.TryGetProperty("cancelled", out var c) && c.ValueKind == JsonValueKind.True;
            string? value = payload.TryGetProperty("value", out var v) ? v.GetString() : null;
            replayService.CompleteInput(requestId, value, cancelled);
        }

        // Clicker v2 — push live click stats to the React StatusBar. Called from ReplayService
        // on a ~4 Hz cadence (throttled inside the click loop) so we don't flood the WebView2
        // message channel for high-rate clickers. The frontend computes CPS from count/elapsed.
        public void PushClickerStats(long count, long elapsedMs)
        {
            SendMessage("clicker:stats", new { count, elapsedMs });
        }

        // Macro loop counter — "Loop X/Y" in the StatusBar during a looping replay. Same
        // throttling story as PushClickerStats. total == 0 signals infinite loop on the
        // frontend side ("Loop X/∞"). Only fires for multi-iteration or infinite runs;
        // single-shot replays never reach this path.
        public void PushLoopProgress(int current, int total)
        {
            SendMessage("macro:loopProgress", new { current, total });
        }

        // Manual resume from the status-bar Resume button. Forwards to the replay service which
        // fires the same callback the resume hotkey would, freeing ExecutePause's await.
        private void HandleReplayResume(JsonElement payload)
        {
            replayService.ManualResume();
        }

        private void HandleInsertAction(JsonElement payload)
        {
            string actionType = payload.GetProperty("actionType").GetString() ?? "";
            int insertIndex = payload.GetProperty("insertIndex").GetInt32();
            if (string.IsNullOrEmpty(actionType)) return;

            // Snapshot after the empty-actionType guard. Whether the type is one this method
            // handles at all is only knowable at the bottom (every branch owns its own type
            // test), so unlike HandleBulkUpdateCoord — which can decide up front and therefore
            // never pushes on a no-op — this one has to push first and unwind in the
            // unrecognized-type tail. Unwinding means BOTH stacks: PushUndoState also clears the
            // redo stack, so the redo entries are captured here and handed back by that tail.
            // The array is empty on the overwhelmingly common path (nothing to redo) and this
            // runs once per Insert click, so the allocation is not worth engineering around.
            //
            // The WaitImage and capture (LeftClick/KeyPress) branches keep this push — it's
            // their only undo step since their async insert paths don't push one of their own.
            var discardedRedo = _redoStack.ToArray();
            PushUndoState();

            insertIndex = Math.Max(0, Math.Min(insertIndex, actions.Count));

            // Scroll: insert directly (no capture needed)
            if (actionType == "ScrollUp" || actionType == "ScrollDown")
            {
                int delay = int.TryParse(CustomDelay, out var d) ? d : 100;
                actions.Insert(insertIndex, new ActionItem { ActionType = actionType, Delay = delay, Comment = "" });
                for (int i = 0; i < actions.Count; i++)
                    actions[i].RowNumber = i + 1;
                HasUnsavedChanges = true;
                PushActionsUpdate();
                mainController.UpdateButtonStates();
                return;
            }

            // Stop / Return: flow leaves — insert directly, nothing to configure, no Sheet.
            // Same direct-insert mold as Scroll above (the return exits from inside the
            // branch, ahead of the unrecognized-type redo-unwind tail).
            if (actionType == "Stop" || actionType == "Return")
            {
                int delay = int.TryParse(CustomDelay, out var fd) ? fd : 100;
                actions.Insert(insertIndex, new ActionItem { ActionType = actionType, Delay = delay, Comment = "" });
                for (int i = 0; i < actions.Count; i++)
                    actions[i].RowNumber = i + 1;
                HasUnsavedChanges = true;
                PushActionsUpdate();
                mainController.UpdateButtonStates();
                return;
            }

            // BreakLoop / ContinueLoop: the Loop ▾ "Loop control" rows — pure jump markers,
            // inserted with Delay = 0 (the engine never pays their delay and the load-time
            // validator zeroes it; seeding a CustomDelay here would just be erased later).
            if (actionType == "BreakLoop" || actionType == "ContinueLoop")
            {
                actions.Insert(insertIndex, new ActionItem { ActionType = actionType, Delay = 0, Comment = "" });
                for (int i = 0; i < actions.Count; i++)
                    actions[i].RowNumber = i + 1;
                HasUnsavedChanges = true;
                PushActionsUpdate();
                mainController.UpdateButtonStates();
                return;
            }

            // WaitImage: capture screen region
            if (actionType == "WaitImage")
            {
                _ = HandleInsertWaitImageAsync(insertIndex);
                return;
            }

            // WaitPixelColor is handled by the dedicated actions:insertWaitPixelColor
            // message (captures coords + colour through the screen overlay before the
            // row is inserted, matching WaitImage's behaviour). If someone still routes
            // it through here via actions:insertAction (legacy / fallback), drop to the
            // generic empty-insert below so the row at least exists — but the toolbar
            // and context menu both use the dedicated message now.

            // Browser actions: insert directly
            if (actionType.StartsWith("Browser"))
            {
                int delay = int.TryParse(CustomDelay, out var bd) ? bd : 100;
                actions.Insert(insertIndex, new ActionItem
                {
                    ActionType = actionType,
                    Key = "",
                    Delay = delay,
                    Timeout = 5000
                });
                HasUnsavedChanges = true;
                PushActionsUpdate();
                mainController.UpdateButtonStates();
                // Auto-open the editor for action types that need a selector / text / option list
                // filled in before they're useful. BrowserNavigate captures its URL via the
                // dedicated NavigateDialog at add-time, so it's already complete — skip the sheet.
                if (actionType == "BrowserClick" || actionType == "BrowserRightClick"
                    || actionType == "BrowserType" || actionType == "BrowserSelectOption"
                    || actionType == "BrowserWaitElement")
                {
                    SendMessage("sheet:openIndex", new { index = insertIndex });
                }
                return;
            }

            // SetVariable: insert directly and open the Sheet so the user fills Name/Value
            // (Pattern A — same flow the selector-less Browser actions use above).
            if (actionType == "SetVariable")
            {
                int delay = int.TryParse(CustomDelay, out var vd) ? vd : 100;
                actions.Insert(insertIndex, new ActionItem
                {
                    ActionType = "SetVariable",
                    Key = "",
                    Delay = delay
                });
                for (int i = 0; i < actions.Count; i++)
                    actions[i].RowNumber = i + 1;
                HasUnsavedChanges = true;
                PushActionsUpdate();
                mainController.UpdateButtonStates();
                SendMessage("sheet:openIndex", new { index = insertIndex });
                return;
            }

            // CopyToSlot: same Pattern-A flow as SetVariable — insert empty, open the Sheet
            // so the user names the slot (Key holds the slot name, no other fields).
            if (actionType == "CopyToSlot")
            {
                int delay = int.TryParse(CustomDelay, out var cd) ? cd : 100;
                actions.Insert(insertIndex, new ActionItem
                {
                    ActionType = "CopyToSlot",
                    Key = "",
                    Delay = delay
                });
                for (int i = 0; i < actions.Count; i++)
                    actions[i].RowNumber = i + 1;
                HasUnsavedChanges = true;
                PushActionsUpdate();
                mainController.UpdateButtonStates();
                SendMessage("sheet:openIndex", new { index = insertIndex });
                return;
            }

            // ActivateWindow: insert directly and open the Sheet so the user fills the
            // matcher/launch fields (Pattern A, same as SetVariable). Timeout seeds at
            // 10 s — window "wait for it to load" budgets are longer than probe waits.
            if (actionType == "ActivateWindow")
            {
                int delay = int.TryParse(CustomDelay, out var awd) ? awd : 100;
                actions.Insert(insertIndex, new ActionItem
                {
                    ActionType = "ActivateWindow",
                    Key = "",
                    Delay = delay,
                    Timeout = 10000
                });
                for (int i = 0; i < actions.Count; i++)
                    actions[i].RowNumber = i + 1;
                HasUnsavedChanges = true;
                PushActionsUpdate();
                mainController.UpdateButtonStates();
                SendMessage("sheet:openIndex", new { index = insertIndex });
                return;
            }

            // Pause legacy path — kept as defence against any stale caller still
            // dispatching `actions:insertAction` with actionType="Pause". The toolbar /
            // context menu / command palette all now go through `actions:insertPause`
            // (config-first dialog). If anything still hits this branch, the result is
            // a defensive empty Pause row — sheet auto-open removed so a stale caller
            // can't accidentally re-introduce the orphan-on-Cancel UX issue.
            if (actionType == "Pause")
            {
                int delay = int.TryParse(CustomDelay, out var pd) ? pd : 100;
                actions.Insert(insertIndex, new ActionItem
                {
                    ActionType = "Pause",
                    Key = "",
                    Delay = delay,
                    Timeout = 0
                });
                for (int i = 0; i < actions.Count; i++)
                    actions[i].RowNumber = i + 1;
                HasUnsavedChanges = true;
                PushActionsUpdate();
                mainController.UpdateButtonStates();
                return;
            }

            CaptureType captureType;
            string? mouseButton = null;

            if (actionType == "LeftClick" || actionType == "RightClick" || actionType == "MiddleClick")
            {
                captureType = CaptureType.Mouse;
                mouseButton = actionType.Replace("Click", "");
            }
            else if (actionType == "KeyPress")
            {
                captureType = CaptureType.Keyboard;
            }
            else
            {
                // Unrecognized type — nothing was inserted, so undo the bookkeeping the snapshot
                // above did. Popping the undo entry is only half of it: PushUndoState CLEARS the
                // redo stack, and until this restore existed a stale caller dispatching a type
                // this method does not handle silently wiped the user's redo history while
                // inserting nothing. Stack<T>.ToArray hands back top-first, so pushing in reverse
                // rebuilds the original order. UpdateButtonStates re-runs because PushUndoState
                // last computed the button states against the pushed-and-cleared stacks.
                _undoStack.TryPop(out _);
                for (int i = discardedRedo.Length - 1; i >= 0; i--)
                    _redoStack.Push(discardedRedo[i]);
                mainController.UpdateButtonStates();
                return;
            }

            mainController.StartCaptureMode(insertIndex, captureType, mouseButton, () =>
            {
                HasUnsavedChanges = true;
                mainController.UpdateButtonStates();
            });
        }

        // ── Conditional logic: Add Else branch ────────────────────────────────
        // Inserts a single Else row just before the EndIf that matches the IF at
        // ifRowIndex. Finding the matching EndIf is a forward scan with a nested-IF
        // stack — same algorithm as the engine's BuildBlockMap, except localised
        // to one starting IF so we can short-circuit as soon as we pop back to it.
        // No-op when the index doesn't point to an IF, when no matching EndIf is
        // found (malformed block), or when an Else already exists for this IF
        // (the frontend's hasElse gate already prevents the click, but the backend
        // re-validates so a duplicate addElseBranch from a stale UI is harmless).
        private void HandleActionsAddElseBranch(JsonElement payload)
        {
            if (!payload.TryGetProperty("ifRowIndex", out var idxEl) || idxEl.ValueKind != JsonValueKind.Number) return;
            int ifIdx = idxEl.GetInt32();
            if (ifIdx < 0 || ifIdx >= actions.Count) return;
            if (!string.Equals(actions[ifIdx].ActionType, "If", StringComparison.OrdinalIgnoreCase)) return;

            // Forward-scan from the IF to find its matching EndIf, tracking nested
            // IFs so we don't latch onto an inner block's EndIf by mistake. Also
            // detect an existing Else along the way so we can bail without inserting
            // a duplicate.
            int depth = 0;
            int endIfIdx = -1;
            bool alreadyHasElse = false;
            for (int i = ifIdx + 1; i < actions.Count; i++)
            {
                var t = actions[i].ActionType;
                if (string.Equals(t, "If", StringComparison.OrdinalIgnoreCase))
                {
                    depth++;
                }
                else if (string.Equals(t, "Else", StringComparison.OrdinalIgnoreCase))
                {
                    if (depth == 0) { alreadyHasElse = true; break; }
                }
                else if (string.Equals(t, "EndIf", StringComparison.OrdinalIgnoreCase))
                {
                    if (depth == 0) { endIfIdx = i; break; }
                    depth--;
                }
            }
            if (alreadyHasElse || endIfIdx < 0) return;

            PushUndoState();
            actions.Insert(endIfIdx, new ActionItem
            {
                ActionType = "Else",
                Delay = 0,
                Comment = "",
            });
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;
            HasUnsavedChanges = true;
            PushActionsUpdate();
            mainController.UpdateButtonStates();
        }

        // ── Conditional logic: Insert IF block ────────────────────────────────
        // Capture-first insert: the user's click in the toolbar picker routes here with
        // a conditionType, we run the SAME screen-overlay flow WaitImage / WaitPixelColor
        // use (so muscle memory carries over), and only after a successful capture do we
        // insert {If, EndIf} as a pair. Esc / cancel results in zero rows inserted —
        // matches the Wait* flows' "cancel means cancel" rule so the grid never grows a
        // half-configured IF block.
        private void HandleActionsInsertConditional(JsonElement payload)
        {
            string conditionType = payload.TryGetProperty("conditionType", out var ct) && ct.ValueKind == JsonValueKind.String
                ? ct.GetString() ?? ""
                : "";
            int insertIndex = payload.TryGetProperty("insertIndex", out var iEl) && iEl.ValueKind == JsonValueKind.Number
                ? iEl.GetInt32()
                : actions.Count;
            if (insertIndex < 0 || insertIndex > actions.Count) insertIndex = actions.Count;

            if (string.Equals(conditionType, "ImageFound", StringComparison.OrdinalIgnoreCase))
                _ = HandleInsertConditionalImageAsync(insertIndex);
            else if (string.Equals(conditionType, "PixelColorMatch", StringComparison.OrdinalIgnoreCase))
                _ = HandleInsertConditionalPixelAsync(insertIndex);
            else if (string.Equals(conditionType, "WindowOpen", StringComparison.OrdinalIgnoreCase))
                InsertConditionalDirect(insertIndex, "WindowOpen");
            else if (string.Equals(conditionType, "ClipboardMatch", StringComparison.OrdinalIgnoreCase))
                InsertConditionalDirect(insertIndex, "ClipboardMatch");
            else if (string.Equals(conditionType, "BrowserElementState", StringComparison.OrdinalIgnoreCase))
                InsertConditionalDirect(insertIndex, "BrowserElementState");
            // Capture-less state conditions — no screen region / pixel to pick, so they land
            // immediately with empty fields and the Sheet auto-opens (like Window/Clipboard).
            else if (string.Equals(conditionType, "Random", StringComparison.OrdinalIgnoreCase))
                InsertConditionalDirect(insertIndex, "Random");
            else if (string.Equals(conditionType, "Variable", StringComparison.OrdinalIgnoreCase))
                InsertConditionalDirect(insertIndex, "Variable");
            else if (string.Equals(conditionType, "ProcessRunning", StringComparison.OrdinalIgnoreCase))
                InsertConditionalDirect(insertIndex, "ProcessRunning");
            else if (string.Equals(conditionType, "FileExists", StringComparison.OrdinalIgnoreCase))
                InsertConditionalDirect(insertIndex, "FileExists");
            else if (string.Equals(conditionType, "TimeWindow", StringComparison.OrdinalIgnoreCase))
                InsertConditionalDirect(insertIndex, "TimeWindow");
            // Unknown conditionType (e.g. a future type from a newer frontend on an older
            // backend) silently no-ops — better than inserting a half-configured IF the
            // user can't interact with through the existing Sheet editor.
        }

        // Capture-less conditional insert (Window / Clipboard): these probes have no screen
        // region or pixel to pick, so the {If, EndIf} pair lands immediately with empty probe
        // fields and the Sheet auto-opens for the user to fill them — same ending as the
        // image/pixel capture flows above.
        /// Desktop Assert insert — a LEAF row, so unlike InsertConditionalDirect below there is no
        /// EndIf partner and none of the block-marker machinery (rainbow nesting, block-aware
        /// duplicate, multi-row drag snapping) applies.
        ///
        /// Seeds ConditionTimeout to a small grace budget instead of If's instant 0: an assert
        /// guards a precondition that a UI usually needs a beat to satisfy (a window finishing its
        /// activation, a paste landing), and a zero-timeout probe on that is a flake generator.
        /// Image/Pixel reuse the SAME capture overlays as the If path — an assert on a screen
        /// region is worthless without a region to compare.
        private void HandleActionsInsertAssert(JsonElement payload)
        {
            string conditionType = payload.TryGetProperty("conditionType", out var ct) && ct.ValueKind == JsonValueKind.String
                ? ct.GetString() ?? ""
                : "";
            int insertIndex = payload.TryGetProperty("insertIndex", out var iEl) && iEl.ValueKind == JsonValueKind.Number
                ? iEl.GetInt32()
                : actions.Count;
            if (insertIndex < 0 || insertIndex > actions.Count) insertIndex = actions.Count;

            // The SIX state conditions — deliberately not Image/Pixel. Those two are already
            // assertable: WaitImage and WaitPixelColor abort the run on timeout and support
            // invert, so "require this image to be on screen" ships today. Offering them here
            // would either duplicate that or, without wiring the capture overlays, insert a
            // row with no reference image that can never pass. Random is assertable but
            // meaningless ("require a coin flip"), and BrowserElementState has its own
            // BrowserAssert action with the selector/alternatives editor behind it.
            switch (conditionType)
            {
                case "WindowOpen":
                case "ProcessRunning":
                case "FileExists":
                case "Variable":
                case "ClipboardMatch":
                case "TimeWindow":
                    break;
                default:
                    return;   // unknown/unsupported family — no-op, same posture as the If path
            }

            // Optional preset overrides (the Wait ▾ "wait for condition" items): a longer
            // poll budget and a pre-armed on-fail policy. The 10-minute ceiling is THIS
            // door's only (the Sheet's editor floors at 0 with no ceiling — deliberate:
            // a hand-crafted insert message shouldn't arm an hour-long silent poll, while
            // an explicit Sheet edit is the user's own call). Absent fields keep the
            // classic Assert seed, so the Assert ▾ path is unchanged.
            int conditionTimeout = payload.TryGetProperty("conditionTimeout", out var tEl) && tEl.ValueKind == JsonValueKind.Number
                ? Math.Clamp(tEl.GetInt32(), 0, 600000)
                : 1500;
            string? assertOnFail = payload.TryGetProperty("assertOnFail", out var fEl) && fEl.ValueKind == JsonValueKind.String
                && (fEl.GetString() == "StopReplay" || fEl.GetString() == "Continue")
                ? fEl.GetString()
                : null;   // default Halt stays null, matching the actions:edit normalization

            PushUndoState();
            actions.Insert(insertIndex, new ActionItem
            {
                ActionType = "Assert",
                ConditionType = conditionType,
                Delay = 0,
                Key = "",
                Comment = "",
                ConditionTimeout = conditionTimeout,
                AssertOnFail = assertOnFail,
            });
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;
            HasUnsavedChanges = true;
            PushActionsUpdate();
            mainController.UpdateButtonStates();
            SendMessage("sheet:openIndex", new { index = insertIndex });
        }

        private void InsertConditionalDirect(int insertIndex, string conditionType)
            => InsertBlockDirect(insertIndex, "If", conditionType);

        // ONE opener+closer inserter for all three block families. If → EndIf; While and
        // ForEachRow → EndLoop (the shared loop closer). conditionType null = ForEachRow,
        // which has nothing to configure — no Sheet auto-open, no probe seed.
        private void InsertBlockDirect(int insertIndex, string openerType, string? conditionType)
        {
            PushUndoState();
            actions.Insert(insertIndex, new ActionItem
            {
                ActionType = openerType,
                ConditionType = conditionType ?? "",
                Delay = 0,
                Key = "",
                Comment = "",
                // If/While Random seeds at a 50% coin-flip so a freshly inserted row is
                // immediately functional; 0% would be "never true" — a silently dead
                // condition. Only the Random family carries this default (others reuse
                // string/null fields that seed sensibly empty). The Loop ▾ menu doesn't
                // offer Random for While (a coin-flip loop guard has no stable ending),
                // but the seed stays here so a hand-fed payload still lands functional.
                RandomPercent = string.Equals(conditionType, "Random", StringComparison.OrdinalIgnoreCase) ? 50 : 0,
            });
            actions.Insert(insertIndex + 1, new ActionItem
            {
                ActionType = string.Equals(openerType, "If", StringComparison.OrdinalIgnoreCase) ? "EndIf" : "EndLoop",
                Delay = 0,
                Key = "",
                Comment = "",
            });
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;
            HasUnsavedChanges = true;
            PushActionsUpdate();
            mainController.UpdateButtonStates();
            if (conditionType != null)
                SendMessage("sheet:openIndex", new { index = insertIndex });
        }

        // ── Loop blocks: Insert While / For Each Data Row ─────────────────────
        // While mirrors the If insert flow exactly (capture-first for Image/Pixel, direct +
        // Sheet for the state families); ForEachRow is the one configuration-free block.
        private void HandleActionsInsertLoop(JsonElement payload)
        {
            int insertIndex = payload.TryGetProperty("insertIndex", out var iEl) && iEl.ValueKind == JsonValueKind.Number
                ? iEl.GetInt32()
                : actions.Count;
            if (insertIndex < 0 || insertIndex > actions.Count) insertIndex = actions.Count;

            string kind = payload.TryGetProperty("kind", out var kEl) && kEl.ValueKind == JsonValueKind.String
                ? kEl.GetString() ?? "While"
                : "While";
            if (string.Equals(kind, "ForEachRow", StringComparison.OrdinalIgnoreCase))
            {
                InsertBlockDirect(insertIndex, "ForEachRow", conditionType: null);
                return;
            }

            string conditionType = payload.TryGetProperty("conditionType", out var ct) && ct.ValueKind == JsonValueKind.String
                ? ct.GetString() ?? ""
                : "";
            switch (conditionType)
            {
                case "ImageFound":
                    _ = HandleInsertConditionalImageAsync(insertIndex, "While");
                    break;
                case "PixelColorMatch":
                    _ = HandleInsertConditionalPixelAsync(insertIndex, "While");
                    break;
                case "WindowOpen":
                case "ClipboardMatch":
                case "BrowserElementState":
                case "Variable":
                case "ProcessRunning":
                case "FileExists":
                case "TimeWindow":
                    InsertBlockDirect(insertIndex, "While", conditionType);
                    break;
                default:
                    // Unknown family (incl. Random, which the menu deliberately omits for a
                    // loop guard) — silent no-op, same posture as the If path.
                    break;
            }
        }

        // Delete the entire loop block (opener + body + EndLoop) — the deleteConditional
        // mirror with a KIND-aware scan: both loop openers deepen the nesting, and only the
        // shared EndLoop closer pops it. If blocks inside the body are invisible to this
        // scan on purpose (their EndIf is not our closer).
        private void HandleActionsDeleteLoop(JsonElement payload)
        {
            if (!payload.TryGetProperty("loopRowIndex", out var idxEl) || idxEl.ValueKind != JsonValueKind.Number) return;
            int loopIdx = idxEl.GetInt32();
            if (loopIdx < 0 || loopIdx >= actions.Count) return;
            bool isLoopOpener = string.Equals(actions[loopIdx].ActionType, "While", StringComparison.OrdinalIgnoreCase)
                || string.Equals(actions[loopIdx].ActionType, "ForEachRow", StringComparison.OrdinalIgnoreCase);
            if (!isLoopOpener) return;

            int depth = 0;
            int endIdx = -1;
            for (int i = loopIdx + 1; i < actions.Count; i++)
            {
                var t = actions[i].ActionType;
                if (string.Equals(t, "While", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(t, "ForEachRow", StringComparison.OrdinalIgnoreCase)) depth++;
                else if (string.Equals(t, "EndLoop", StringComparison.OrdinalIgnoreCase))
                {
                    if (depth == 0) { endIdx = i; break; }
                    depth--;
                }
            }
            // No matching EndLoop — same graceful fallback as deleteConditional: remove
            // just the opener so the user gets visible progress on a malformed list.
            if (endIdx < 0) endIdx = loopIdx;

            PushUndoState();
            for (int i = endIdx; i >= loopIdx; i--)
                actions.RemoveAt(i);
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;
            HasUnsavedChanges = true;
            PushActionsUpdate();
            mainController.UpdateButtonStates();
        }

        /// <summary>
        /// Per-profile image storage keys off this, and "No Profile" stores under "default".
        /// Always derived from a SNAPSHOT name taken before the overlay opened — never from a
        /// fresh read of CurrentProfileName, which is exactly how a capture ended up in another
        /// profile's image directory.
        /// </summary>
        private static string StorageProfileName(string profileName)
            => profileName != "No Profile" ? profileName : "default";

        /// <summary>
        /// Shared abort for a long capture whose scope no longer applies. NEVER silent: the user
        /// has just watched the app minimise and dragged a rectangle across the screen, so a
        /// wordless no-op is a worse outcome than the swallowed ArgumentOutOfRangeException this
        /// replaces. Call on the UI thread — it reads CurrentProfileName and the action list.
        /// </summary>
        private bool CaptureStillApplies(in Services.EditScope scope, string what)
        {
            if (scope.TryResume(CurrentProfileName, out var why)) return true;
            DiagnosticLog.Warn($"{what} discarded: {why}");
            SendMessage("alert:show", new { message = why, type = "error" });
            return false;
        }

        private async Task HandleInsertConditionalImageAsync(int insertIndex, string openerType = "If")
        {
            // Captured BEFORE the overlay: it does not block the app, so an automation fire can
            // swap the profile and refill the action list while the user is still dragging.
            var scope = Services.EditScope.Capture(CurrentProfileName);
            // Identical capture flow to HandleInsertWaitImageAsync above — same minimise,
            // screenshot, region-pick overlay, ImageStorageService.SaveReferenceImage path.
            // The only difference is what gets inserted at the end: {If, EndIf} pair
            // sharing the same ImagePath + Confidence the WaitImage flow stores, with
            // ConditionType set to "ImageFound" so the engine routes through InstantProbe.
            // Keep-alive'd against the overlay thread, same as every capture overlay in this file
            // — see HandleAutomationCaptureImageAsync.
            Thread? overlayThread = null;
            using var interaction = Services.InteractionScope.EnterExclusive(
                "insert If-Image overlay", () => overlayThread?.IsAlive == true);
            // Refused — see HandleAutomationCaptureImageAsync for why this is exclusive and why an
            // early return needs no cleanup. This handler reports nothing on failure (its
            // screenshot-failure path just returns), so the refusal is silent to the UI too.
            if (interaction == null) return;
            var mainHwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
            NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_MINIMIZE);
            await Task.Delay(400);

            System.Drawing.Bitmap screenshot;
            try
            {
                screenshot = ScreenCaptureService.CaptureVirtualScreen();
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error("Insert If-Image screenshot failed", ex);
                NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE);
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var thread = new Thread(() =>
                {
                    // Catch + IsBackground for the reasons written out on the overlay thread in
                    // HandleAutomationCaptureImageAsync: an exception escaping a non-main thread
                    // kills the process, and a foreground thread survives a tray Exit still
                    // holding a full-screen TopMost window. A null `selection` reads as cancelled.
                    try
                    {
                        System.Windows.Forms.Application.EnableVisualStyles();
                        using var overlay = new ScreenOverlayForm(screenshot);
                        overlay.ShowDialog();
                        selection = overlay.GetSelectionAsync().Result;
                    }
                    catch (Exception ex)
                    {
                        DiagnosticLog.Error("Insert If-Image overlay thread failed", ex);
                    }
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.IsBackground = true;
                overlayThread = thread;
                thread.Start();
                await Task.Run(() => thread.Join());

                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));

                if (selection?.CroppedImage == null) return;

                // Snapshot name, so the PNG can only land in the directory the user was looking
                // at. If the scope turns out to be stale below, this file is simply orphaned and
                // ImageStorageService.CleanupOrphanImages removes it at the next startup — far
                // cheaper than holding the bitmap to write it on the UI thread.
                //
                // The save can genuinely fail — read-only or policy-redirected profile directory,
                // full disk, over-long path — and this method is fire-and-forget, so an escaping
                // exception used to vanish as an unobserved task exception: no row inserted, no
                // log, no toast, after the user had already dragged a rectangle. Say so instead.
                // Dispose is in the finally because the old placement (after the save) leaked the
                // bitmap on exactly the path that already went wrong.
                string imagePath;
                try
                {
                    imagePath = ImageStorageService.SaveReferenceImage(selection.CroppedImage, StorageProfileName(scope.ProfileName));
                }
                catch (Exception ex)
                {
                    DiagnosticLog.Error($"Insert If-Image save failed [profile='{scope.ProfileName}']", ex);
                    SendMessage("alert:show", new { message = $"Couldn't save the captured image, so no condition was inserted: {ex.Message}", type = "error" });
                    return;
                }
                finally
                {
                    selection.CroppedImage.Dispose();
                }

                dispatcherQueue.TryEnqueue(() =>
                {
                    if (!CaptureStillApplies(scope, "Captured image")) return;
                    // Cannot exceed Count once the epoch check passed, but clamping is free and
                    // an out-of-range Insert here is the swallowed exception this flow was named
                    // for in the modality audit.
                    int at = Math.Min(insertIndex, actions.Count);
                    PushUndoState();
                    actions.Insert(at, new ActionItem
                    {
                        // "If" or "While" — the Loop ▾ menu routes its Image guard through
                        // this same capture flow, only the opener/closer pair differs.
                        ActionType = openerType,
                        ConditionType = "ImageFound",
                        ImagePath = imagePath,
                        Confidence = 0.8,
                        // Inserted with Delay = 0 by default. The IF accepts an optional
                        // pre-probe delay — a "wait for the condition to load before checking"
                        // knob applied before the probe at replay (see the conditional handling
                        // in ActionExecution) — so the user can set it on the IF row afterward
                        // when a slow-loading condition needs the screen to settle first. EndIf
                        // stays 0 (pure jump marker).
                        Delay = 0,
                        Key = "",
                        Comment = "",
                    });
                    actions.Insert(at + 1, new ActionItem
                    {
                        ActionType = string.Equals(openerType, "If", StringComparison.OrdinalIgnoreCase) ? "EndIf" : "EndLoop",
                        Delay = 0,
                        Key = "",
                        Comment = "",
                    });
                    for (int i = 0; i < actions.Count; i++)
                        actions[i].RowNumber = i + 1;
                    HasUnsavedChanges = true;
                    PushActionsUpdate();
                    mainController.UpdateButtonStates();
                    // Auto-open the Sheet on the new IF row so the user can immediately
                    // adjust confidence / search region / negate / on-probe-error.
                    SendMessage("sheet:openIndex", new { index = at });
                });
            }
            finally
            {
                screenshot.Dispose();
            }
        }

        private async Task HandleInsertConditionalPixelAsync(int insertIndex, string openerType = "If")
        {
            // Mirror of HandleInsertWaitPixelColorAsync — same point-pick overlay, same
            // relative-coord translation. End result: {If(PixelColorMatch + coords + hex),
            // EndIf} pair inserted at insertIndex.
            var scope = Services.EditScope.Capture(CurrentProfileName);
            // Keep-alive'd against the overlay thread, same as every capture overlay in this file
            // — see HandleAutomationCaptureImageAsync.
            Thread? overlayThread = null;
            using var interaction = Services.InteractionScope.EnterExclusive(
                "insert If-Pixel overlay", () => overlayThread?.IsAlive == true);
            // Refused — see HandleAutomationCaptureImageAsync.
            if (interaction == null) return;
            var mainHwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
            NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_MINIMIZE);
            await Task.Delay(400);

            System.Drawing.Bitmap screenshot;
            try
            {
                screenshot = ScreenCaptureService.CaptureVirtualScreen();
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error("Insert If-Pixel screenshot failed", ex);
                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var thread = new Thread(() =>
                {
                    // Catch + IsBackground for the reasons written out on the overlay thread in
                    // HandleAutomationCaptureImageAsync: an exception escaping a non-main thread
                    // kills the process, and a foreground thread survives a tray Exit still
                    // holding a full-screen TopMost window. A null `selection` reads as cancelled.
                    try
                    {
                        System.Windows.Forms.Application.EnableVisualStyles();
                        using var overlay = new ScreenOverlayForm(
                            screenshot,
                            regionOnly: false,
                            pointPick: true,
                            hintText: "Click on the pixel to check — colour and coords are captured  •  ESC to cancel");
                        overlay.ShowDialog();
                        selection = overlay.GetSelectionAsync().Result;
                    }
                    catch (Exception ex)
                    {
                        DiagnosticLog.Error("Insert If-Pixel overlay thread failed", ex);
                    }
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.IsBackground = true;
                overlayThread = thread;
                thread.Start();
                await Task.Run(() => thread.Join());

                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));

                if (selection == null || selection.PickedColor == null) return;

                int storedX = selection.ScreenX;
                int storedY = selection.ScreenY;
                if (TryGetRelativeCaptureOffset(out var winRect))
                {
                    storedX -= winRect.Left;
                    storedY -= winRect.Top;
                }

                dispatcherQueue.TryEnqueue(() =>
                {
                    if (!CaptureStillApplies(scope, "Picked pixel")) return;
                    int at = Math.Min(insertIndex, actions.Count);
                    PushUndoState();
                    actions.Insert(at, new ActionItem
                    {
                        // "If" or "While" — the Loop ▾ Pixel guard shares this capture flow.
                        ActionType = openerType,
                        ConditionType = "PixelColorMatch",
                        PixelX = storedX,
                        PixelY = storedY,
                        PixelColor = PixelColorService.ToHex(selection.PickedColor.Value),
                        // Inserted with Delay = 0 by default; the IF accepts an optional
                        // pre-probe delay (see the If-Image insert above). EndIf stays 0.
                        Delay = 0,
                        Key = "",
                        Comment = "",
                    });
                    actions.Insert(at + 1, new ActionItem
                    {
                        ActionType = string.Equals(openerType, "If", StringComparison.OrdinalIgnoreCase) ? "EndIf" : "EndLoop",
                        Delay = 0,
                        Key = "",
                        Comment = "",
                    });
                    for (int i = 0; i < actions.Count; i++)
                        actions[i].RowNumber = i + 1;
                    HasUnsavedChanges = true;
                    PushActionsUpdate();
                    mainController.UpdateButtonStates();
                    SendMessage("sheet:openIndex", new { index = at });
                });
            }
            finally
            {
                screenshot.Dispose();
            }
        }

        // ── Conditional logic: Delete whole block ─────────────────────────────
        // Forward-scan with a nested-IF stack to find the matching EndIf, then remove
        // the contiguous range [ifIdx..endIfIdx] inclusive. Deleting only the IF would
        // orphan its body rows — they'd execute unconditionally with no surrounding
        // probe — and Else/EndIf alone would dangle. Block-delete is the safer default
        // the row-actions menu wires for IF rows; body / Else / EndIf can still be
        // deleted individually via the regular actions:delete path.
        private void HandleActionsDeleteConditional(JsonElement payload)
        {
            if (!payload.TryGetProperty("ifRowIndex", out var idxEl) || idxEl.ValueKind != JsonValueKind.Number) return;
            int ifIdx = idxEl.GetInt32();
            if (ifIdx < 0 || ifIdx >= actions.Count) return;
            if (!string.Equals(actions[ifIdx].ActionType, "If", StringComparison.OrdinalIgnoreCase)) return;

            int depth = 0;
            int endIfIdx = -1;
            for (int i = ifIdx + 1; i < actions.Count; i++)
            {
                var t = actions[i].ActionType;
                if (string.Equals(t, "If", StringComparison.OrdinalIgnoreCase)) depth++;
                else if (string.Equals(t, "EndIf", StringComparison.OrdinalIgnoreCase))
                {
                    if (depth == 0) { endIfIdx = i; break; }
                    depth--;
                }
            }
            // No matching EndIf — the validator should have appended one at load time,
            // but if we got here with an unbalanced in-memory state, fall back to
            // deleting just the IF row so the user at least gets visible progress.
            if (endIfIdx < 0) endIfIdx = ifIdx;

            PushUndoState();
            // Remove from the END of the range so earlier indices stay valid as we go.
            for (int i = endIfIdx; i >= ifIdx; i--)
                actions.RemoveAt(i);
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;
            HasUnsavedChanges = true;
            PushActionsUpdate();
            mainController.UpdateButtonStates();
        }


        private void HandleInsertKeystroke(JsonElement payload)
        {
            var keystroke = payload.GetProperty("keystroke").GetString();
            var insertIndex = payload.GetProperty("insertIndex").GetInt32();
            if (string.IsNullOrEmpty(keystroke)) return;
            if (insertIndex < 0 || insertIndex > actions.Count) insertIndex = actions.Count;

            // Optional repeat fields — present when the "Press × N" insert flow is used,
            // omitted by the regular "Send Keystroke" path which keeps RepeatCount = 1.
            // Clamped to the same range the inline editor enforces (1..999 for count,
            // 0..5000 for the gap) so a malformed payload can't bypass the UI limits.
            int repeat = 1;
            if (payload.TryGetProperty("repeat", out var rEl) && rEl.ValueKind == JsonValueKind.Number)
                repeat = Math.Max(1, Math.Min(999, rEl.GetInt32()));
            int? repeatDelay = null;
            if (payload.TryGetProperty("repeatDelayMs", out var dEl) && dEl.ValueKind == JsonValueKind.Number)
                repeatDelay = Math.Max(0, Math.Min(5000, dEl.GetInt32()));
            // Optional gap jitter (±%). Present only when the user turned it on in the dialog;
            // clamped 1..100 to match the editor. Values <= 0 collapse to null (off).
            int? repeatJitter = null;
            if (payload.TryGetProperty("repeatDelayJitterPct", out var jEl) && jEl.ValueKind == JsonValueKind.Number)
            {
                int jv = jEl.GetInt32();
                if (jv > 0) repeatJitter = Math.Min(100, jv);
            }

            int delay = int.TryParse(CustomDelay, out var pd) ? pd : 100;
            // Snapshot after the guards above (empty keystroke already returned) so the
            // insert below is guaranteed to land. Every sibling insert handler in this file
            // pushes undo state before mutating; this one didn't, so Ctrl+Z after inserting
            // a keystroke either did nothing or undid an unrelated earlier edit instead.
            PushUndoState();
            // ONE row with the whole combo. ExecuteKeystroke in ActionExecution parses
            // the "+"-joined string at replay time and emits the proper modifier-down →
            // key-down → key-up → modifier-up sequence. Keeping the combo atomic in
            // storage matches the user's intent ("I want Alt+Tab") and keeps the action
            // grid compact (one row per combo instead of four).
            actions.Insert(insertIndex, new ActionItem
            {
                ActionType = "Keystroke",
                Key = keystroke,
                Delay = delay,
                RepeatCount = repeat,
                // Only persist the gap when the user actually wants repeats — keeps the
                // single-press case schema-clean (the WhenWritingNull JSON ignore drops
                // it from the serialized profile when it's null).
                RepeatDelayMs = repeat > 1 ? repeatDelay : null,
                // Same gate as the gap — jitter only makes sense across repeats.
                RepeatDelayJitterPct = repeat > 1 ? repeatJitter : null,
            });
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;
            HasUnsavedChanges = true;
            PushActionsUpdate();
            mainController.UpdateButtonStates();
        }

        private void HandleInsertHoldKey(JsonElement payload)
        {
            var key = payload.GetProperty("key").GetString();
            var insertIndex = payload.GetProperty("insertIndex").GetInt32();
            if (string.IsNullOrEmpty(key)) return;
            if (insertIndex < 0 || insertIndex > actions.Count) insertIndex = actions.Count;

            // Optional hold duration — clamped 10..60000 (same range as the inline editor).
            // 0 / omitted falls back to ActionItem.DefaultHoldDurationMs at replay time.
            int holdDuration = ActionItem.DefaultHoldDurationMs;
            if (payload.TryGetProperty("holdDurationMs", out var hd) && hd.ValueKind == JsonValueKind.Number)
                holdDuration = Math.Max(10, Math.Min(60000, hd.GetInt32()));

            int delay = int.TryParse(CustomDelay, out var pd) ? pd : 100;
            // Same gap as HandleInsertKeystroke just above: snapshot after the guards, right
            // before the mutation, so Ctrl+Z can undo this insert instead of silently
            // no-op'ing or reaching past it to an unrelated earlier edit.
            PushUndoState();
            // Single atomic HoldKey row. Replay engine treats this as: SimulateKey(key, true),
            // wait holdDuration, SimulateKey(key, false). Compact alternative to the legacy
            // 2-row KeyDown + KeyUp (delay = hold) representation.
            actions.Insert(insertIndex, new ActionItem
            {
                ActionType = "HoldKey",
                Key = key,
                Delay = delay,
                HoldDurationMs = holdDuration,
            });
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;
            HasUnsavedChanges = true;
            PushActionsUpdate();
            mainController.UpdateButtonStates();
        }

        // Pause insert (Pattern B normalization). Replaces the previous flow where
        // `actions:insertAction` with actionType="Pause" inserted an empty row and
        // followed up with sheet:openIndex — a Cancel on that Sheet left an orphan
        // row in the grid. With the dedicated PauseDialog the user configures the
        // resume hotkey + timeout up-front; this handler just persists the result.
        // Note: NO SendMessage("sheet:openIndex") here — the row is already fully
        // configured by the time we get here.
        private void HandleInsertPause(JsonElement payload)
        {
            var key = payload.TryGetProperty("key", out var k) && k.ValueKind == JsonValueKind.String
                ? k.GetString() ?? ""
                : "";
            int insertIndex = payload.TryGetProperty("insertIndex", out var iEl) && iEl.ValueKind == JsonValueKind.Number
                ? iEl.GetInt32()
                : actions.Count;
            if (insertIndex < 0 || insertIndex > actions.Count) insertIndex = actions.Count;

            // Timeout is in milliseconds on the wire (frontend converts seconds → ms before
            // sending) so the row stores the value consumed directly by ExecuteActionsAsync.
            // Negative or absurd values clamped to a sane range: 0 = no timeout, max = 24 h.
            int timeoutMs = 0;
            if (payload.TryGetProperty("timeoutMs", out var t) && t.ValueKind == JsonValueKind.Number)
                timeoutMs = Math.Max(0, Math.Min(86_400_000, t.GetInt32()));

            int delay = int.TryParse(CustomDelay, out var d) ? d : 0;
            PushUndoState();
            actions.Insert(insertIndex, new ActionItem
            {
                ActionType = "Pause",
                Key = key,
                Timeout = timeoutMs,
                Delay = delay,
                Comment = "",
            });
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;
            HasUnsavedChanges = true;
            PushActionsUpdate();
            mainController.UpdateButtonStates();
        }

        private async Task HandleInsertWaitImageAsync(int insertIndex)
        {
            var scope = Services.EditScope.Capture(CurrentProfileName);
            // Keep-alive'd against the overlay thread, same as every capture overlay in this file
            // — see HandleAutomationCaptureImageAsync.
            Thread? overlayThread = null;
            using var interaction = Services.InteractionScope.EnterExclusive(
                "insert WaitImage overlay", () => overlayThread?.IsAlive == true);
            // Refused — see HandleAutomationCaptureImageAsync.
            if (interaction == null) return;
            // Minimize main window to get a clean screenshot
            var mainHwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
            NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_MINIMIZE);
            await Task.Delay(400); // Wait for minimize animation

            System.Drawing.Bitmap screenshot;
            try
            {
                screenshot = ScreenCaptureService.CaptureVirtualScreen();
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error("Insert WaitImage screenshot failed", ex);
                NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE);
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;

                // Run overlay on STA thread (WinForms requirement)
                var thread = new Thread(() =>
                {
                    // Catch + IsBackground for the reasons written out on the overlay thread in
                    // HandleAutomationCaptureImageAsync: an exception escaping a non-main thread
                    // kills the process, and a foreground thread survives a tray Exit still
                    // holding a full-screen TopMost window. A null `selection` reads as cancelled.
                    try
                    {
                        System.Windows.Forms.Application.EnableVisualStyles();
                        using var overlay = new ScreenOverlayForm(screenshot);
                        overlay.ShowDialog();
                        selection = overlay.GetSelectionAsync().Result;
                    }
                    catch (Exception ex)
                    {
                        DiagnosticLog.Error("Insert WaitImage overlay thread failed", ex);
                    }
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.IsBackground = true;
                overlayThread = thread;
                thread.Start();
                await Task.Run(() => thread.Join());

                // Restore main window
                dispatcherQueue.TryEnqueue(() =>
                {
                    NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE);
                });

                if (selection?.CroppedImage == null) return; // Cancelled or region-only (no image)

                // Save the cropped image under the SNAPSHOT profile (see the If-Image flow), and
                // say so out loud when the write fails. Directory.CreateDirectory + Image.Save both
                // throw on a read-only or redirected profile dir, a full disk or an over-long path,
                // and this method is fire-and-forget — the exception used to disappear as an
                // unobserved task exception, leaving the user with no row and no explanation after
                // dragging a rectangle. Dispose moved into the finally so the failure path stops
                // leaking the bitmap too.
                string imagePath;
                try
                {
                    imagePath = ImageStorageService.SaveReferenceImage(selection.CroppedImage, StorageProfileName(scope.ProfileName));
                }
                catch (Exception ex)
                {
                    DiagnosticLog.Error($"Insert WaitImage save failed [profile='{scope.ProfileName}']", ex);
                    SendMessage("alert:show", new { message = $"Couldn't save the captured image, so no action was inserted: {ex.Message}", type = "error" });
                    return;
                }
                finally
                {
                    selection.CroppedImage.Dispose();
                }

                // Insert the action
                int delay = int.TryParse(CustomDelay, out var d) ? d : 100;
                dispatcherQueue.TryEnqueue(() =>
                {
                    if (!CaptureStillApplies(scope, "Captured image")) return;
                    int at = Math.Min(insertIndex, actions.Count);
                    // Snapshot HERE, inside the enqueued callback and right before the mutation
                    // — not at the top of this async method. PushUndoState snapshots the live
                    // `actions` collection, so it has to run on this thread at this instant; done
                    // any earlier it would record state before the user even picked a region, and
                    // would leave a stray undo entry on the cancel path above (selection == null),
                    // which returns before this callback is ever scheduled.
                    PushUndoState();
                    actions.Insert(at, new ActionItem
                    {
                        ActionType = "WaitImage",
                        ImagePath = imagePath,
                        Timeout = 5000,
                        Confidence = 0.8,
                        Delay = delay,
                        Key = "",
                        Comment = ""
                    });
                    for (int i = 0; i < actions.Count; i++)
                        actions[i].RowNumber = i + 1;
                    HasUnsavedChanges = true;
                    PushActionsUpdate();
                    mainController.UpdateButtonStates();
                    // Auto-open the editor for the freshly inserted row.
                    SendMessage("sheet:openIndex", new { index = at });
                });
            }
            finally
            {
                screenshot.Dispose();
            }
        }

        private void HandleInsertWaitPixelColor(JsonElement payload)
        {
            int insertIndex = payload.TryGetProperty("insertIndex", out var iEl) && iEl.ValueKind == JsonValueKind.Number
                ? iEl.GetInt32()
                : actions.Count;
            if (insertIndex < 0 || insertIndex > actions.Count) insertIndex = actions.Count;
            _ = HandleInsertWaitPixelColorAsync(insertIndex);
        }

        private async Task HandleInsertWaitPixelColorAsync(int insertIndex)
        {
            // Mirrors HandleInsertWaitImageAsync: minimise the app, capture the screen,
            // show the overlay in pointPick mode (single click instead of a drag), and
            // insert the action with the captured coords + colour pre-filled. If the
            // user hits Esc (selection == null), nothing is inserted — same "cancel
            // means cancel" rule WaitImage already follows, so the grid never grows a
            // half-configured row from a discarded capture.
            var scope = Services.EditScope.Capture(CurrentProfileName);
            // Keep-alive'd against the overlay thread, same as every capture overlay in this file
            // — see HandleAutomationCaptureImageAsync.
            Thread? overlayThread = null;
            using var interaction = Services.InteractionScope.EnterExclusive(
                "insert WaitPixelColor overlay", () => overlayThread?.IsAlive == true);
            // Refused — see HandleAutomationCaptureImageAsync. The EditScope captured just above is
            // simply dropped, which is what every other early return on this path already does: an
            // uncommitted capture is a discarded undo snapshot, not a leak.
            if (interaction == null) return;
            var mainHwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
            NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_MINIMIZE);
            await Task.Delay(400);

            System.Drawing.Bitmap screenshot;
            try
            {
                screenshot = ScreenCaptureService.CaptureVirtualScreen();
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error("Insert WaitPixelColor screenshot failed", ex);
                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var thread = new Thread(() =>
                {
                    // Catch + IsBackground for the reasons written out on the overlay thread in
                    // HandleAutomationCaptureImageAsync: an exception escaping a non-main thread
                    // kills the process, and a foreground thread survives a tray Exit still
                    // holding a full-screen TopMost window. A null `selection` reads as cancelled.
                    try
                    {
                        System.Windows.Forms.Application.EnableVisualStyles();
                        using var overlay = new ScreenOverlayForm(
                            screenshot,
                            regionOnly: false,
                            pointPick: true,
                            hintText: "Click the pixel to watch — colour + coords captured  •  Scroll to zoom  •  ESC to cancel");
                        overlay.ShowDialog();
                        selection = overlay.GetSelectionAsync().Result;
                    }
                    catch (Exception ex)
                    {
                        DiagnosticLog.Error("Insert WaitPixelColor overlay thread failed", ex);
                    }
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.IsBackground = true;
                overlayThread = thread;
                thread.Start();
                await Task.Run(() => thread.Join());

                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));

                // Cancel (Esc) or out-of-bounds click → nothing inserted.
                if (selection == null || selection.PickedColor == null) return;

                // Translate absolute pick → profile-relative when rel coords on + target running.
                // Mirrors HandlePixelColorPickAsync — both paths can reach the WaitPixel storage,
                // so both must apply the same translation or the stored coords desync with the
                // replay/test-match consumers that now expect window-relative values.
                int storedX = selection.ScreenX;
                int storedY = selection.ScreenY;
                if (TryGetRelativeCaptureOffset(out var winRect))
                {
                    storedX -= winRect.Left;
                    storedY -= winRect.Top;
                }

                int delay = int.TryParse(CustomDelay, out var d) ? d : 100;
                dispatcherQueue.TryEnqueue(() =>
                {
                    if (!CaptureStillApplies(scope, "Picked pixel")) return;
                    int at = Math.Min(insertIndex, actions.Count);
                    // Same reasoning as HandleInsertWaitImageAsync: push here, inside the
                    // enqueued callback and immediately before the insert, so a cancelled
                    // capture (selection == null, returned above before this callback was ever
                    // enqueued) leaves the undo stack untouched.
                    PushUndoState();
                    actions.Insert(at, new ActionItem
                    {
                        ActionType = "WaitPixelColor",
                        Key = "",
                        Delay = delay,
                        Timeout = 5000,
                        PixelX = storedX,
                        PixelY = storedY,
                        PixelColor = PixelColorService.ToHex(selection.PickedColor.Value),
                    });
                    for (int i = 0; i < actions.Count; i++)
                        actions[i].RowNumber = i + 1;
                    HasUnsavedChanges = true;
                    PushActionsUpdate();
                    mainController.UpdateButtonStates();
                    // Match WaitImage's insert flow: open the editor on the new row.
                    SendMessage("sheet:openIndex", new { index = at });
                });
            }
            finally
            {
                screenshot.Dispose();
            }
        }

        private void HandleWaitImageRecapture(JsonElement payload)
        {
            int index = payload.GetProperty("index").GetInt32();
            if (index < 0 || index >= actions.Count) return;
            // Accept both WaitImage and IF Image rows. They share the same per-profile
            // ImagePath storage, so the async capture flow can write back to ImagePath
            // regardless of which family the row belongs to. The Sheet's Recapture button
            // is gated by (isWaitImage || isIfImage) so this dispatch can be hit from
            // either; the older WaitImage-only check silently dropped the IF Image clicks.
            var a = actions[index];
            bool eligible = a.ActionType == "WaitImage"
                || (IsConditionOpenerRow(a) && string.Equals(a.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase));
            if (!eligible) return;
            // Anchor on the ROW OBJECT, not on its index. The write-back lands after an overlay
            // the user can sit in for a minute, and `index < actions.Count` is a bounds check,
            // not an identity check — it passes happily while pointing at a different row.
            _ = HandleWaitImageRecaptureAsync(Services.EditScope.Capture(CurrentProfileName, a));
        }

        private async Task HandleWaitImageRecaptureAsync(Services.EditScope scope)
        {
            // Keep-alive'd against the overlay thread, same as every capture overlay in this file
            // — see HandleAutomationCaptureImageAsync.
            Thread? overlayThread = null;
            using var interaction = Services.InteractionScope.EnterExclusive(
                "WaitImage recapture overlay", () => overlayThread?.IsAlive == true);
            // Refused — see HandleAutomationCaptureImageAsync. The caller's EditScope is dropped
            // uncommitted, same as this handler's own screenshot-failure path.
            if (interaction == null) return;
            var mainHwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
            NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_MINIMIZE);
            await Task.Delay(400);

            System.Drawing.Bitmap screenshot;
            try
            {
                screenshot = ScreenCaptureService.CaptureVirtualScreen();
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error("WaitImage recapture screenshot failed", ex);
                NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE);
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var thread = new Thread(() =>
                {
                    // Catch + IsBackground for the reasons written out on the overlay thread in
                    // HandleAutomationCaptureImageAsync: an exception escaping a non-main thread
                    // kills the process, and a foreground thread survives a tray Exit still
                    // holding a full-screen TopMost window. A null `selection` reads as cancelled.
                    try
                    {
                        System.Windows.Forms.Application.EnableVisualStyles();
                        using var overlay = new ScreenOverlayForm(screenshot);
                        overlay.ShowDialog();
                        selection = overlay.GetSelectionAsync().Result;
                    }
                    catch (Exception ex)
                    {
                        DiagnosticLog.Error("WaitImage recapture overlay thread failed", ex);
                    }
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.IsBackground = true;
                overlayThread = thread;
                thread.Start();
                await Task.Run(() => thread.Join());

                dispatcherQueue.TryEnqueue(() =>
                {
                    NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE);
                });

                if (selection?.CroppedImage == null) return; // Cancelled

                // Keep the old PNG on disk so undo can restore the previous reference image.
                // Orphan PNGs are cleaned at app startup by ImageStorageService.CleanupOrphanImages.
                // Saved under the SNAPSHOT profile so it cannot land in another profile's dir.
                //
                // A failed save is announced rather than swallowed: this method is fire-and-forget,
                // so the CreateDirectory/Save throw used to become an unobserved task exception and
                // the row simply kept its OLD image with no hint that the recapture went nowhere —
                // the worst shape of this bug, because the action still looks configured. Dispose
                // sits in the finally so the failure path does not also leak the bitmap.
                string newImagePath;
                try
                {
                    newImagePath = ImageStorageService.SaveReferenceImage(selection.CroppedImage, StorageProfileName(scope.ProfileName));
                }
                catch (Exception ex)
                {
                    DiagnosticLog.Error($"WaitImage recapture save failed [profile='{scope.ProfileName}']", ex);
                    SendMessage("alert:show", new { message = $"Couldn't save the recaptured image — the action still points at the old one: {ex.Message}", type = "error" });
                    return;
                }
                finally
                {
                    selection.CroppedImage.Dispose();
                }

                dispatcherQueue.TryEnqueue(() =>
                {
                    if (!scope.TryResolveIndex(actions, CurrentProfileName, out int at, out var why))
                    {
                        DiagnosticLog.Warn($"Recaptured image discarded: {why}");
                        SendMessage("alert:show", new { message = why, type = "error" });
                        return;
                    }
                    // Snapshot here, inside the enqueued callback and right before the write —
                    // the comment above (on newImagePath) promises "undo can restore the
                    // previous reference image" but nothing ever pushed the state that promise
                    // depends on. Pushing at the top of the async method instead would snapshot
                    // before the user even opened the overlay, and would leave a stray undo
                    // entry on the cancel/stale-row paths above, both of which return before
                    // reaching here.
                    PushUndoState();
                    actions[at].ImagePath = newImagePath;
                    HasUnsavedChanges = true;
                    PushActionsUpdate();
                });
            }
            finally
            {
                screenshot.Dispose();
            }
        }

        // Single-shot match against the current screen — powers the "Test match" calibration
        // button in the WaitImage editor. Pure round-trip: request carries imagePath + tolerance
        // + optional search region; response carries the best score and matched rect.
        private async Task HandleTestMatchAsync(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var ridEl) ? (ridEl.GetString() ?? "") : "";
            string imagePath = payload.TryGetProperty("imagePath", out var ipEl) ? (ipEl.GetString() ?? "") : "";
            double confidence = payload.TryGetProperty("confidence", out var cEl) && cEl.ValueKind == JsonValueKind.Number ? cEl.GetDouble() : 0.8;
            // Automation callers pass absolute:true (watcher coords are virtual-screen) + the trigger's
            // profile (the test image lives under the trigger's profile, not the active one). WaitImage /
            // If callers omit both → CurrentProfileName + the rel-coords round-trip, byte-identical to before.
            bool absolute = payload.TryGetProperty("absolute", out var absEl2) && absEl2.ValueKind == JsonValueKind.True;
            string profileOverride = payload.TryGetProperty("profile", out var pEl2) && pEl2.ValueKind == JsonValueKind.String ? (pEl2.GetString() ?? "") : "";

            System.Drawing.Rectangle? searchRegion = null;
            if (payload.TryGetProperty("searchRegion", out var srEl) && srEl.ValueKind == JsonValueKind.Object)
            {
                int sx = srEl.GetProperty("x").GetInt32();
                int sy = srEl.GetProperty("y").GetInt32();
                int sw = srEl.GetProperty("w").GetInt32();
                int sh = srEl.GetProperty("h").GetInt32();
                if (sw > 0 && sh > 0)
                {
                    if (!absolute && TryGetRelativeCaptureOffset(out var winRect))
                    {
                        sx += winRect.Left;
                        sy += winRect.Top;
                    }
                    searchRegion = new System.Drawing.Rectangle(sx, sy, sw, sh);
                }
            }

            try
            {
                string profileName = !string.IsNullOrEmpty(profileOverride)
                    ? (profileOverride == "No Profile" ? "default" : profileOverride)
                    : (CurrentProfileName != "No Profile" ? CurrentProfileName : "default");
                using var refImage = ImageStorageService.LoadReferenceImage(profileName, imagePath);
                if (refImage == null)
                {
                    SendMessage("image:testMatchResult", new
                    {
                        requestId,
                        found = false,
                        score = 0.0,
                        x = 0, y = 0, w = 0, h = 0,
                        error = "Reference image not found on disk."
                    });
                    return;
                }

                // Defer to thread pool — MatchTemplate is CPU-bound and we don't want to block the dispatcher.
                var result = await Task.Run(() => ImageMatchingService.MatchOnce(refImage, searchRegion));

                // Frontend uses these coords for its auto-set-search-region-with-margin behaviour
                // (SheetPanel.tsx). The storage path expects coords in PROFILE coord space — when
                // rel coords on, that means window-relative. ImageMatchingService returns abs
                // virtual-desktop coords (where it found the template); subtract the target-window
                // origin so the value stored downstream is consistent with the rest of the
                // capture/replay/configure pipeline. Without this, the auto-set would write
                // absolute coords into a slot the rest of the system interprets as relative,
                // shifting the displayed Configure rect and the search region by the window origin.
                int reportX = result.X;
                int reportY = result.Y;
                if (!absolute && TryGetRelativeCaptureOffset(out var winRectReport))
                {
                    reportX -= winRectReport.Left;
                    reportY -= winRectReport.Top;
                }

                SendMessage("image:testMatchResult", new
                {
                    requestId,
                    found = result.Score >= confidence,
                    score = result.Score,
                    x = reportX, y = reportY, w = result.W, h = result.H
                });
            }
            catch (Exception ex)
            {
                SendMessage("image:testMatchResult", new
                {
                    requestId,
                    found = false,
                    score = 0.0,
                    x = 0, y = 0, w = 0, h = 0,
                    error = $"Test failed: {ex.Message}"
                });
            }
        }

        // Tightens an existing WaitImage reference image to a sub-rect (no recapture needed).
        // Saves the cropped result as a NEW PNG so the old one stays on disk for undo; orphan
        // cleanup at app startup removes unreferenced PNGs eventually.
        private void HandleCropReference(JsonElement payload)
        {
            int index = payload.GetProperty("index").GetInt32();
            int x = payload.GetProperty("x").GetInt32();
            int y = payload.GetProperty("y").GetInt32();
            int w = payload.GetProperty("w").GetInt32();
            int h = payload.GetProperty("h").GetInt32();
            if (index < 0 || index >= actions.Count) return;

            var action = actions[index];
            // Accept WaitImage and IF Image rows — both share the same per-profile PNG
            // storage, so the cropper can rewrite ImagePath for either family. Without
            // this, the Sheet thumbnail's crop-on-click silently no-opped for IF Image.
            bool eligible = !string.IsNullOrEmpty(action.ImagePath) && (
                action.ActionType == "WaitImage"
                || (IsConditionOpenerRow(action) && string.Equals(action.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase)));
            if (!eligible) return;
            if (w < 10 || h < 10) return;

            string profileName = CurrentProfileName != "No Profile" ? CurrentProfileName : "default";
            // ImagePath non-null verified by the eligible check above; null-forgive to
            // satisfy the compiler's flow analysis which doesn't follow the bool path.
            using var current = ImageStorageService.LoadReferenceImage(profileName, action.ImagePath!);
            if (current == null) return;

            // Clamp the requested rect to the image bounds — the frontend already clamps but
            // belt-and-suspenders avoids an AOOR exception on Bitmap.Clone if anything is off.
            x = Math.Max(0, Math.Min(current.Width - 1, x));
            y = Math.Max(0, Math.Min(current.Height - 1, y));
            w = Math.Min(current.Width - x, w);
            h = Math.Min(current.Height - y, h);
            if (w < 10 || h < 10) return;
            // Reject a no-op crop (full image) — nothing to save, no visible change.
            if (x == 0 && y == 0 && w == current.Width && h == current.Height) return;

            // Run the crop/save FIRST so we never push an undo state for a failed operation
            // (which would also blow away the redo stack for nothing).
            string newPath;
            try
            {
                var rect = new System.Drawing.Rectangle(x, y, w, h);
                using var cropped = current.Clone(rect, current.PixelFormat);
                newPath = ImageStorageService.SaveReferenceImage(cropped, profileName);
            }
            catch (Exception ex)
            {
                // Same silent-failure shape as the capture saves above, and the same reason it
                // must not stay on Debug.WriteLine: that compiles out of Release, so the user's
                // crop just did nothing and the session log — the only sensor a shipped build has
                // — recorded nothing either. Its profile-addressed twin
                // (HandleAutomationCropReference) already logs this properly.
                DiagnosticLog.Warn($"Reference image crop failed [profile='{profileName}']: {ex.Message}");
                SendMessage("alert:show", new { message = $"Couldn't save the cropped image: {ex.Message}", type = "error" });
                return;
            }

            PushUndoState();
            action.ImagePath = newPath;
            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        // Lets the user click anywhere on screen to set the X/Y of a mouse click action.
        // Reuses the existing overlay in "pointPick" mode — single click returns immediately,
        // no rect dragging needed.
        private async Task HandleMousePickPositionAsync(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var ridEl) ? (ridEl.GetString() ?? "") : "";

            // A relative profile has to have something to be relative TO, and this is the one
            // capture path where degrading to absolute produces the exact bug this fix exists to
            // kill. Replay already refuses rather than degrades (ReportMissingTargetWindow), and
            // the panel now tells the user the number is relative — storing an absolute one
            // behind that caption would be worse than not picking at all. Checked BEFORE the
            // minimise so a refusal costs no window dance.
            //
            // IsIconic is not paranoia: FindWindow only filters on IsWindowVisible, which a
            // MINIMISED window still passes, and GetWindowRect then answers with the
            // (-32000,-32000) parking rect — the hazard NativeMethods.GetWindowPlacement and
            // ScreenOverlayWindow's banner placement are both already written to dodge. Ungated
            // it would store a coordinate ~32000 px out.
            //
            // Rel-coords with NO target is deliberately allowed through: replay treats that as a
            // zero offset (TryResolveRelativeOffset), i.e. plain absolute, and the caption stays
            // hidden for it, so all three agree.
            if (UserProfile.Current.UseRelativeCoordinates)
            {
                var relTarget = CurrentProfileName != "No Profile"
                    ? profileController.GetEffectiveWindowTarget(CurrentProfileName)
                    : UserProfile.Current.TargetWindow;
                if (TrueReplayer.Helpers.WindowMatcher.IsUsable(relTarget))
                {
                    var label = !string.IsNullOrEmpty(relTarget!.ProcessName)
                        ? relTarget.ProcessName
                        : relTarget.WindowTitle;
                    IntPtr relHwnd = TrueReplayer.Helpers.WindowMatcher.FindWindow(relTarget);
                    string? refusal = relHwnd == IntPtr.Zero
                        ? $"Target window not open: {label}. Open it and pick again."
                        : NativeMethods.IsIconic(relHwnd)
                            ? $"Target window is minimised: {label}. Restore it and pick again."
                            : null;
                    if (refusal != null)
                    {
                        DiagnosticLog.Warn($"Position pick refused: {refusal} [profile='{CurrentProfileName}']");
                        SendMessage("alert:show", new { message = refusal });
                        SendMessage("mouse:positionPicked", new { requestId, cancelled = true });
                        return;
                    }
                }
            }

            // Keep-alive'd against the overlay thread (see HandleAutomationCaptureImageAsync). This
            // handler is one of the three that most needs it: it writes back nothing but a
            // coordinate, so there is no EditScope underneath to catch a bad result. If the scope
            // were swept while the overlay is still up, an automation fire's injected click would
            // land ON the point-pick overlay and COMMIT a pixel the user never chose — and the
            // reply looks exactly like a deliberate pick.
            Thread? overlayThread = null;
            using var interaction = Services.InteractionScope.EnterExclusive(
                "position pick overlay", () => overlayThread?.IsAlive == true);
            // Refused — see HandleAutomationCaptureImageAsync. This is one of the three handlers
            // that writes back nothing but a coordinate, so the reply MUST go out: a request the
            // frontend never hears back from leaves its pick button disabled forever.
            if (interaction == null)
            {
                SendMessage("mouse:positionPicked", new { requestId, cancelled = true });
                return;
            }
            var mainHwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
            NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_MINIMIZE);
            await Task.Delay(400);

            System.Drawing.Bitmap screenshot;
            try
            {
                screenshot = ScreenCaptureService.CaptureVirtualScreen();
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error("Position pick screenshot failed", ex);
                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));
                SendMessage("mouse:positionPicked", new { requestId, cancelled = true });
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var thread = new Thread(() =>
                {
                    // Catch + IsBackground for the reasons written out on the overlay thread in
                    // HandleAutomationCaptureImageAsync: an exception escaping a non-main thread
                    // kills the process, and a foreground thread survives a tray Exit still
                    // holding a full-screen TopMost window. A null `selection` reads as cancelled,
                    // which this handler answers with cancelled:true rather than silence.
                    try
                    {
                        System.Windows.Forms.Application.EnableVisualStyles();
                        using var overlay = new ScreenOverlayForm(
                            screenshot,
                            regionOnly: false,
                            pointPick: true,
                            hintText: "Click anywhere on screen to set X/Y  •  ESC to cancel");
                        overlay.ShowDialog();
                        selection = overlay.GetSelectionAsync().Result;
                    }
                    catch (Exception ex)
                    {
                        DiagnosticLog.Error("Position pick overlay thread failed", ex);
                    }
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.IsBackground = true;
                overlayThread = thread;
                thread.Start();
                await Task.Run(() => thread.Join());

                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));

                if (selection == null)
                {
                    SendMessage("mouse:positionPicked", new { requestId, cancelled = true });
                    return;
                }

                // Store in the SAME space the profile replays in. Every other capture path in this
                // file already does this through TryGetRelativeCaptureOffset — pixel pick, WaitImage
                // capture, the region reports, seven call sites — and this one was the single
                // holdout, handing back raw virtual-desktop coords. On a relative profile that value
                // is in the wrong space, and SimulateMouse then ADDS the target window's origin to
                // it, so the click lands roughly twice as far out as intended. The workaround users
                // found (re-record the click and stop recording) worked precisely because the
                // recorder DOES convert.
                int pickedX = selection.ScreenX;
                int pickedY = selection.ScreenY;
                if (TryGetRelativeCaptureOffset(out var winRect))
                {
                    pickedX -= winRect.Left;
                    pickedY -= winRect.Top;
                    DiagnosticLog.Info(
                        $"Position pick: screen ({selection.ScreenX},{selection.ScreenY}) -> " +
                        $"window-relative ({pickedX},{pickedY}) [origin {winRect.Left},{winRect.Top}]");
                }

                SendMessage("mouse:positionPicked", new
                {
                    requestId,
                    cancelled = false,
                    x = pickedX,
                    y = pickedY
                });
            }
            finally
            {
                screenshot.Dispose();
            }
        }

        // Eyedropper for WaitPixelColor — minimise the app, drop the user into the screen
        // overlay in pointPick mode, and round-trip the clicked pixel back to the editor as
        // { x, y, hex }. The overlay already samples the colour from its in-memory screenshot
        // (RegionSelectionResult.PickedColor), so no second screen capture happens here.
        private async Task HandlePixelColorPickAsync(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var ridEl) ? (ridEl.GetString() ?? "") : "";
            // Automation pixel-watchers store ABSOLUTE virtual-screen coords (TriggerService
            // samples them with no window context) — they must opt out of the profile-relative
            // translation the If/WaitPixelColor editors want.
            bool absolute = payload.TryGetProperty("absolute", out var absEl) && absEl.ValueKind == JsonValueKind.True;

            // Keep-alive'd against the overlay thread (see HandleAutomationCaptureImageAsync).
            // Coordinate-only, so no EditScope backs it — the same exposure as the position picker
            // just above: a scope swept under a live point-pick overlay lets an automation's
            // injected click commit a pixel, and nothing downstream can tell it apart from a
            // deliberate one.
            Thread? overlayThread = null;
            using var interaction = Services.InteractionScope.EnterExclusive(
                "pixel colour pick overlay", () => overlayThread?.IsAlive == true);
            // Refused — see HandleAutomationCaptureImageAsync. Reply required for the same reason
            // as the position pick: the frontend is waiting on this requestId.
            if (interaction == null)
            {
                SendMessage("pixel:colorPicked", new { requestId, cancelled = true });
                return;
            }
            var mainHwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
            NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_MINIMIZE);
            await Task.Delay(400);

            System.Drawing.Bitmap screenshot;
            try
            {
                screenshot = ScreenCaptureService.CaptureVirtualScreen();
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error("Pixel colour pick screenshot failed", ex);
                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));
                SendMessage("pixel:colorPicked", new { requestId, cancelled = true });
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var thread = new Thread(() =>
                {
                    // Catch + IsBackground for the reasons written out on the overlay thread in
                    // HandleAutomationCaptureImageAsync: an exception escaping a non-main thread
                    // kills the process, and a foreground thread survives a tray Exit still
                    // holding a full-screen TopMost window. A null `selection` reads as cancelled,
                    // which this handler answers with cancelled:true rather than silence.
                    try
                    {
                        System.Windows.Forms.Application.EnableVisualStyles();
                        using var overlay = new ScreenOverlayForm(
                            screenshot,
                            regionOnly: false,
                            pointPick: true,
                            hintText: "Click the pixel to watch — colour + coords captured  •  Scroll to zoom  •  ESC to cancel");
                        overlay.ShowDialog();
                        selection = overlay.GetSelectionAsync().Result;
                    }
                    catch (Exception ex)
                    {
                        DiagnosticLog.Error("Pixel colour pick overlay thread failed", ex);
                    }
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.IsBackground = true;
                overlayThread = thread;
                thread.Start();
                await Task.Run(() => thread.Join());

                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));

                if (selection == null || selection.PickedColor == null)
                {
                    SendMessage("pixel:colorPicked", new { requestId, cancelled = true });
                    return;
                }

                // Translate absolute pick → profile-relative when rel coords on + target running
                // — unless the caller asked for absolute coords (automation watchers).
                // The sampled colour is independent of coord space (taken from the screenshot
                // pixel directly) so it round-trips unchanged.
                int storedX = selection.ScreenX;
                int storedY = selection.ScreenY;
                if (!absolute && TryGetRelativeCaptureOffset(out var winRect))
                {
                    storedX -= winRect.Left;
                    storedY -= winRect.Top;
                }

                SendMessage("pixel:colorPicked", new
                {
                    requestId,
                    cancelled = false,
                    x = storedX,
                    y = storedY,
                    hex = PixelColorService.ToHex(selection.PickedColor.Value),
                });
            }
            finally
            {
                screenshot.Dispose();
            }
        }

        // Test the user's pixel/colour/tolerance configuration against the LIVE screen
        // (not a screenshot — the editor wants the current colour right now, so we sample
        // through GDI directly). Returns matches + the sampled hex so the editor can show
        // "✅ Matches" or "❌ Got #2B2B2B vs #FF5733 ± 10" without round-tripping a Bitmap.
        // Synchronous because each call is ~0.1 ms and the editor never fires this in bulk.
        private void HandlePixelColorTestMatch(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var ridEl) ? (ridEl.GetString() ?? "") : "";
            int x = payload.TryGetProperty("x", out var xEl) && xEl.ValueKind == JsonValueKind.Number ? xEl.GetInt32() : 0;
            int y = payload.TryGetProperty("y", out var yEl) && yEl.ValueKind == JsonValueKind.Number ? yEl.GetInt32() : 0;
            string targetHex = payload.TryGetProperty("hex", out var hexEl) ? (hexEl.GetString() ?? "") : "";
            int tolerance = payload.TryGetProperty("tolerance", out var tolEl) && tolEl.ValueKind == JsonValueKind.Number ? tolEl.GetInt32() : 0;

            // The frontend sends the action's STORED coords. With rel coords on these are
            // window-relative — sampling at them directly would hit the wrong screen pixel.
            // Translate to absolute via the current target-window origin before sampling.
            // Falls back to the raw coords when rel coords is off or no target is running.
            if (TryGetRelativeCaptureOffset(out var winRect))
            {
                x += winRect.Left;
                y += winRect.Top;
            }

            var sampled = PixelColorService.GetPixelAt(x, y);
            var target = PixelColorService.ParseHex(targetHex);

            if (sampled == null || target == null)
            {
                SendMessage("pixel:testMatchResult", new
                {
                    requestId,
                    matches = false,
                    sampledHex = sampled.HasValue ? PixelColorService.ToHex(sampled.Value) : null,
                    error = sampled == null
                        ? "Couldn't sample pixel (off-screen or hardware-accelerated surface)"
                        : "Invalid target colour",
                });
                return;
            }

            bool matches = PixelColorService.MatchesWithinTolerance(sampled.Value, target.Value, tolerance);
            SendMessage("pixel:testMatchResult", new
            {
                requestId,
                matches,
                sampledHex = PixelColorService.ToHex(sampled.Value),
            });
        }

        // Shared infrastructure for the two "draw a rectangle on screen" flows (WaitImage
        // search region + Clicker click area). Minimises the main window, takes a virtual-
        // desktop screenshot, runs ScreenOverlayForm on an STA thread, and returns the
        // selection (or null if cancelled / screenshot failed). The bitmap is disposed
        // here so neither caller leaks a multi-MB GDI handle.
        private async Task<RegionSelectionResult?> RunRegionPickerAsync(
            System.Drawing.Rectangle? initialRect, string hintWhenSet, string hintWhenEmpty, string logPrefix,
            bool pointPick = false)
        {
            // One scope covers all three callers (search region, click area, click point) —
            // they reach the overlay only through here. Keep-alive'd against the overlay thread
            // (see HandleAutomationCaptureImageAsync): none of the three has an EditScope behind
            // it, they only hand a rect or a point back, so a scope swept under a live overlay
            // lets an automation's injected clicks drag a rectangle the user never drew.
            Thread? overlayThread = null;
            using var interaction = Services.InteractionScope.EnterExclusive(
                $"{logPrefix} region overlay", () => overlayThread?.IsAlive == true);
            // Refused — see HandleAutomationCaptureImageAsync. null is this method's own
            // "cancelled" answer, identical to Esc and to a failed screenshot, so every caller
            // already handles it.
            if (interaction == null) return null;
            var mainHwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
            NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_MINIMIZE);
            await Task.Delay(400);

            System.Drawing.Bitmap? screenshot;
            try
            {
                screenshot = ScreenCaptureService.CaptureVirtualScreen();
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error($"{logPrefix} region picker screenshot failed", ex);
                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));
                return null;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var hint = initialRect.HasValue ? hintWhenSet : hintWhenEmpty;
                var thread = new Thread(() =>
                {
                    // Catch + IsBackground for the reasons written out on the overlay thread in
                    // HandleAutomationCaptureImageAsync: an exception escaping a non-main thread
                    // kills the process, and a foreground thread survives a tray Exit still
                    // holding a full-screen TopMost window. A null `selection` is what this method
                    // already returns for a cancel, so all three callers handle it unchanged.
                    try
                    {
                        System.Windows.Forms.Application.EnableVisualStyles();
                        // pointPick: a single click returns a zero-size region at the click point
                        // (ScreenX/ScreenY) — no rect drag. regionOnly stays true (no cropped image).
                        using var overlay = new ScreenOverlayForm(
                            screenshot, regionOnly: true, pointPick: pointPick, hintText: hint, initialRect: initialRect);
                        overlay.ShowDialog();
                        selection = overlay.GetSelectionAsync().Result;
                    }
                    catch (Exception ex)
                    {
                        DiagnosticLog.Error($"{logPrefix} region picker overlay thread failed", ex);
                    }
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.IsBackground = true;
                overlayThread = thread;
                thread.Start();
                await Task.Run(() => thread.Join());

                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));
                return selection;
            }
            finally
            {
                screenshot.Dispose();
            }
        }

        // Lets the user draw a search ROI for an existing WaitImage. Region-only mode — no
        // PNG saved, just the rect reported back. Pre-drawn with the existing rect (when
        // payload carries one) so the user can tweak instead of restarting from blank.
        //
        // Coordinate system handling: when the profile uses relative coords + has a target
        // window currently running, we translate the stored rect (which is window-relative)
        // to absolute for the overlay display, and translate the new selection back to
        // window-relative before storing. Without this round-trip the overlay would render
        // the initial rect at the wrong screen position when the window has moved, and a
        // freshly-picked region would be stored as absolute (silently breaking the moment
        // the target window moves at replay time — exactly the bug the rel-coord feature
        // is meant to prevent).
        private async Task HandleConfigureSearchRegionAsync(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var ridEl) ? (ridEl.GetString() ?? "") : "";

            // Automation watchers ask for ABSOLUTE coords (no target-window origin) — skip the
            // profile-relative round-trip entirely, same flag the pixel picker uses. WaitImage / If
            // callers omit it, so their existing relative behavior is byte-identical.
            bool absolute = payload.TryGetProperty("absolute", out var absEl) && absEl.ValueKind == JsonValueKind.True;
            // Call TryGet FIRST (an out param is always assigned) so winRect is definitely assigned even
            // when absolute; the && !absolute just gates whether we USE it. Short-circuiting the other
            // way would leave winRect possibly-unassigned for the `if (hasRelativeOffset)` block (CS0170).
            bool hasRelativeOffset = TryGetRelativeCaptureOffset(out var winRect) && !absolute;

            System.Drawing.Rectangle? initialRect = null;
            if (payload.TryGetProperty("x", out var xEl) && xEl.ValueKind == JsonValueKind.Number &&
                payload.TryGetProperty("y", out var yEl) && yEl.ValueKind == JsonValueKind.Number &&
                payload.TryGetProperty("w", out var wEl) && wEl.ValueKind == JsonValueKind.Number &&
                payload.TryGetProperty("h", out var hEl) && hEl.ValueKind == JsonValueKind.Number)
            {
                int initX = xEl.GetInt32();
                int initY = yEl.GetInt32();
                // Stored coords are profile-relative when rel coords on — translate for display.
                if (hasRelativeOffset)
                {
                    initX += winRect.Left;
                    initY += winRect.Top;
                }
                initialRect = new System.Drawing.Rectangle(initX, initY, wEl.GetInt32(), hEl.GetInt32());
            }

            var selection = await RunRegionPickerAsync(
                initialRect,
                hintWhenSet: "Drag to redraw the search area  •  ESC to keep current",
                hintWhenEmpty: "Drag to set the image search area  •  ESC to cancel",
                logPrefix: absolute ? "Automation ImageFound" : "WaitImage");

            if (selection == null)
            {
                SendMessage("waitimage:searchRegionSet", new { requestId, cancelled = true });
                return;
            }

            // Translate fresh selection (absolute from overlay) → profile-relative for storage.
            // Re-check the target window in case it moved or closed between display and selection.
            int storedX = selection.ScreenX;
            int storedY = selection.ScreenY;
            if (!absolute && TryGetRelativeCaptureOffset(out var winRectNow))
            {
                storedX -= winRectNow.Left;
                storedY -= winRectNow.Top;
            }

            SendMessage("waitimage:searchRegionSet", new
            {
                requestId,
                cancelled = false,
                x = storedX,
                y = storedY,
                w = selection.Width,
                h = selection.Height
            });
        }

        // Lets the user draw the Clicker click-area rectangle. Pre-draws the existing rect
        // when one is set so the user can tweak instead of restarting from blank.
        // No reply message: the UI repaints from the PushSettingsLoaded below, and cancelling
        // correctly changes nothing (the overlay's own hint says "ESC to cancel"). This used to
        // echo a clicker:areaSet carrying a requestId, but nothing on the other side ever
        // subscribed to it — dead protocol surface plus a vestigial correlation id.
        private async Task HandleConfigureClickAreaAsync(JsonElement payload)
        {

            // Pre-draw the saved rect (when there is one + the toggle is on, signalling intent).
            System.Drawing.Rectangle? initialRect = (CursorClickUseArea && CursorClickArea is { } cur)
                ? new System.Drawing.Rectangle(cur.X, cur.Y, cur.W, cur.H)
                : null;

            var selection = await RunRegionPickerAsync(
                initialRect,
                hintWhenSet: "Drag to redraw the click area  •  ESC to keep current",
                hintWhenEmpty: "Drag to set the click area  •  ESC to cancel",
                logPrefix: "Clicker");

            if (selection == null) return;

            // Persist + auto-enable useArea + disable the other two "where" modes (Position
            // jitter AND Fixed) — the three are mutually exclusive, same as the Fixed picker does.
            CursorClickArea = new ClickArea(selection.ScreenX, selection.ScreenY, selection.Width, selection.Height);
            CursorClickUseArea = true;
            CursorClickUsePositionJitter = false;
            CursorClickUseFixed = false;
            SaveGlobalSettings();
            PushSettingsLoaded();
        }

        // Lets the user pick the single Fixed click point via a one-click screen overlay
        // (mirrors HandleConfigureClickAreaAsync). On success: store the point, auto-enable
        // Fixed and disable Area + Position jitter (the three "where" modes are exclusive).
        // No reply message, for the same reason as the area picker above.
        private async Task HandleConfigureClickPointAsync(JsonElement payload)
        {
            var selection = await RunRegionPickerAsync(
                null,
                hintWhenSet: "Click to set the fixed click point  •  ESC to cancel",
                hintWhenEmpty: "Click to set the fixed click point  •  ESC to cancel",
                logPrefix: "Clicker",
                pointPick: true);

            if (selection == null) return;

            CursorClickFixedPoint = new ClickPoint(selection.ScreenX, selection.ScreenY);
            CursorClickUseFixed = true;
            CursorClickUseArea = false;
            CursorClickUsePositionJitter = false;
            SaveGlobalSettings();
            PushSettingsLoaded();
        }

        private void HandleDuplicateActions(JsonElement payload)
        {
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32())
                .OrderBy(i => i)
                .ToList();

            if (indices.Count == 0) return;

            var validIndices = indices.Where(i => i >= 0 && i < actions.Count).ToList();
            if (validIndices.Count == 0) return;

            // Snapshot after both index guards — nothing to duplicate means no undo state.
            PushUndoState();

            string profileName = CurrentProfileName != "No Profile" ? CurrentProfileName : "default";

            actions.CollectionChanged -= OnActionsChanged;
            try
            {
                int insertPos = validIndices.Last() + 1;
                foreach (var idx in validIndices)
                {
                    var original = actions[idx];
                    var clone = original.Clone();
                    // Duplicate within the same profile still needs a fresh PNG so an "undo
                    // delete" on the original doesn't strand the copy without an image.
                    // IF Image rows share the same per-profile PNG storage as WaitImage,
                    // so the same protection applies — without the clone, duplicating an
                    // IF Image and later deleting the original would orphan the duplicate.
                    bool refsImage = !string.IsNullOrEmpty(original.ImagePath) && (
                        original.ActionType == "WaitImage"
                        || (IsConditionOpenerRow(original) && string.Equals(original.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase)));
                    if (refsImage)
                    {
                        clone.ImagePath = ImageStorageService.CloneReferenceImage(profileName, original.ImagePath!, profileName)
                                          ?? original.ImagePath;
                    }
                    actions.Insert(insertPos, clone);
                    insertPos++;
                }
            }
            finally
            {
                actions.CollectionChanged += OnActionsChanged;
            }

            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;

            HasUnsavedChanges = true;
            PushActionsUpdate();
            mainController.UpdateButtonStates();
        }

        private void HandleAddBrowserAction(JsonElement payload)
        {
            PushUndoState();
            string actionType = payload.GetProperty("actionType").GetString() ?? "";
            string selector = payload.TryGetProperty("selector", out var selEl) ? selEl.GetString() ?? "" : "";
            string? browserText = payload.TryGetProperty("browserText", out var textEl) ? textEl.GetString() : null;
            bool newTab = payload.TryGetProperty("newTab", out var ntEl) && ntEl.GetBoolean();
            int insertIndex = payload.TryGetProperty("insertIndex", out var idxEl) ? idxEl.GetInt32() : actions.Count;
            int delay = int.TryParse(CustomDelay, out var d) ? d : 100;

            var action = new ActionItem
            {
                ActionType = actionType,
                Key = selector,
                BrowserText = browserText,
                NewTab = newTab,
                Delay = delay,
                Timeout = 5000
            };

            insertIndex = Math.Max(0, Math.Min(insertIndex, actions.Count));
            actions.Insert(insertIndex, action);
            HasUnsavedChanges = true;
            PushActionsUpdate();
            mainController.UpdateButtonStates();

            // Auto-open the editor for action types that arrive empty and need a selector /
            // text / option list / wait condition filled in before they're useful.
            // BrowserNavigate captures its URL via the dedicated NavigateDialog at add-time
            // so it's already complete and is excluded.
            if (actionType == "BrowserClick" || actionType == "BrowserRightClick"
                || actionType == "BrowserType" || actionType == "BrowserSelectOption"
                || actionType == "BrowserWaitElement" || actionType == "BrowserAssert")
            {
                SendMessage("sheet:openIndex", new { index = insertIndex });
            }
        }

        private void HandleBrowserToggleRecording(JsonElement payload)
        {
            bool enabled = payload.TryGetProperty("enabled", out var enEl) && enEl.GetBoolean();
            browserBridge?.SetRecordingMode(enabled);
        }

        private async void HandlePickElement(JsonElement payload)
        {
            // Echo the frontend's requestId back on every reply branch so the editor can match the
            // result to its pending pick and drop a stale one (user switched/closed the action, or
            // cancelled via Esc). Mirrors HandleMousePickPositionAsync / HandlePixelColorPickAsync.
            string requestId = payload.TryGetProperty("requestId", out var ridEl) ? (ridEl.GetString() ?? "") : "";

            if (browserBridge == null || !browserBridge.IsConnected)
            {
                SendMessage("browser:pickResult", new { requestId, selector = (string?)null, alternatives = new object[0], error = "Browser extension is not connected." });
                return;
            }

            try
            {
                var pick = await browserBridge.PickElementAsync(CancellationToken.None);
                SendMessage("browser:pickResult", new
                {
                    requestId,
                    selector = pick.Selector,
                    alternatives = pick.Alternatives.Select(a => new { selector = a.Selector, tier = a.Tier, description = a.Description }).ToArray()
                });
            }
            catch (Exception ex)
            {
                SendMessage("browser:pickResult", new { requestId, selector = (string?)null, alternatives = new object[0], error = ex.Message });
            }
        }

        /// <summary>
        /// "Is this condition true RIGHT NOW?" for the If-Browser-Element editor.
        ///
        /// Deliberately NOT modelled on Test Action, because the two answer different questions. A
        /// Test Action either works or fails, so success/error is the right shape. A condition has
        /// no failure — "the element isn't there" IS the answer, and the whole point of an If is to
        /// branch on it. Reporting a not-found as an error would tell the user their selector is
        /// broken when the condition is simply false, which is exactly the confusion that made this
        /// the one browser editor with no way to check anything.
        ///
        /// So the reply is a branch: satisfied = which way the If would go, negate applied, same as
        /// InstantProbeAsync. `connected` is separate because a missing bridge also probes false,
        /// and "false" and "couldn't ask" must not look alike here.
        /// </summary>
        private async Task HandleBrowserTestCondition(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var idEl) ? idEl.GetString() ?? "" : "";

            void Reply(bool satisfied, bool raw, bool connected)
            {
                try { SendMessage("browser:testConditionResult", new { requestId, satisfied, raw, connected }); }
                catch (Exception ex) { System.Diagnostics.Debug.WriteLine($"[WebViewBridge] testConditionResult failed: {ex.Message}"); }
            }

            if (browserBridge == null || !browserBridge.IsConnected)
            {
                Reply(satisfied: false, raw: false, connected: false);
                return;
            }

            try
            {
                var key = payload.TryGetProperty("key", out var kEl) ? kEl.GetString() ?? "" : "";
                var waitMode = payload.TryGetProperty("waitMode", out var wmEl) ? wmEl.GetString() : null;
                var browserText = payload.TryGetProperty("browserText", out var btEl) ? btEl.GetString() : null;
                var negate = payload.TryGetProperty("conditionNegate", out var nEl) && nEl.ValueKind == JsonValueKind.True;

                List<Models.SelectorAlternativeItem>? alternatives = null;
                if (payload.TryGetProperty("alternatives", out var altEl) && altEl.ValueKind == JsonValueKind.Array)
                {
                    try
                    {
                        var parsed = JsonSerializer.Deserialize<List<Models.SelectorAlternativeItem>>(altEl.GetRawText(), JsonOptions);
                        alternatives = parsed != null && parsed.Count > 0 ? parsed : null;
                    }
                    catch { alternatives = null; }
                }

                // The probe reuses BrowserWaitElement's fields, so the temp carries them under the
                // same names the replay uses: Key = selector, WaitMode = state, BrowserText = pattern.
                var temp = new ActionItem
                {
                    ActionType = "BrowserWaitElement",
                    Key = key,
                    WaitMode = waitMode,
                    // RAW, deliberately. The replay's If probe (ProbeBrowserElementStateAsync ->
                    // ProbeElementStateAsync) passes action.BrowserText through untouched — it
                    // resolves no tokens at all. Resolving them here would make the button answer a
                    // different question from the one the run asks: a text-match condition on
                    // "{clipboard}" would report TRUE in the editor and branch FALSE at replay, or
                    // the reverse, which is worse than having no button. If tokens should work in
                    // If-Browser conditions, that belongs on the replay side first, never only here.
                    BrowserText = browserText,
                    SelectorAlternatives = alternatives,
                };

                // ignoreTabPin: this is an editor probe, not a run. Without it the button would
                // both ASK the run's pinned tab (possibly closed, possibly not the page the user is
                // looking at) and WRITE the pin from the editor — the same defect that made Test
                // Action report TAB_GONE with no run in sight.
                bool raw = await browserBridge.ProbeElementStateAsync(
                    temp, CancellationToken.None, ignoreTabPin: true);
                Reply(satisfied: negate ? !raw : raw, raw: raw, connected: true);
            }
            catch (Exception ex)
            {
                // ProbeElementStateAsync swallows everything except a user stop, and there is no
                // user to stop this one — so reaching here means something structural broke. Answer
                // anyway: the editor must never be left waiting on a reply that never comes.
                DiagnosticLog.Info($"[WebViewBridge] testCondition failed: {ex.Message}");
                Reply(satisfied: false, raw: false, connected: true);
            }
        }

        // #3 — Test action: execute a one-shot browser command from the editor without saving the profile.
        // async Task (not async void) so the caller can observe failures and so unhandled exceptions
        // don't crash the SynchronizationContext. Caller discards the task with `_ = …`.
        private async Task HandleBrowserTestAction(JsonElement payload)
        {
            // Extract requestId first — it must be echoed back on every response branch so the
            // frontend can match the result to its pending request.
            string requestId = payload.TryGetProperty("requestId", out var idEl) ? idEl.GetString() ?? "" : "";

            if (browserBridge == null || !browserBridge.IsConnected)
            {
                TrySendTestResult(requestId, success: false, durationMs: 0,
                    code: "EXTENSION_DISCONNECTED",
                    message: "Browser extension is not connected.",
                    tip: "Open Chrome with the TrueReplayer extension installed.");
                return;
            }

            try
            {
                var actionType = payload.TryGetProperty("actionType", out var atEl) ? atEl.GetString() ?? "" : "";
                var key = payload.TryGetProperty("key", out var kEl) ? kEl.GetString() ?? "" : "";
                var browserText = payload.TryGetProperty("browserText", out var btEl) ? btEl.GetString() : null;
                var newTab = payload.TryGetProperty("newTab", out var ntEl) && ntEl.GetBoolean();
                var timeoutMs = payload.TryGetProperty("timeout", out var toEl) && toEl.ValueKind == JsonValueKind.Number ? toEl.GetInt32() : 5000;
                var waitMode = payload.TryGetProperty("waitMode", out var wmEl) ? wmEl.GetString() : null;
                var urlWaitPattern = payload.TryGetProperty("urlWaitPattern", out var uwEl) ? uwEl.GetString() : null;
                var postNavigateSelector = payload.TryGetProperty("postNavigateSelector", out var pnEl) ? pnEl.GetString() : null;
                var typeAppend = payload.TryGetProperty("typeAppend", out var taEl) && taEl.GetBoolean();
                var typePaste = payload.TryGetProperty("typePaste", out var tpEl) && tpEl.GetBoolean();
                int? typeDelay = payload.TryGetProperty("typeDelay", out var tdEl) && tdEl.ValueKind == JsonValueKind.Number ? tdEl.GetInt32() : (int?)null;
                // BrowserSelectOption match mode — null falls back to "text" inside the extension.
                var selectMatchMode = payload.TryGetProperty("selectMatchMode", out var smEl) ? smEl.GetString() : null;

                // Ranked fallbacks, forwarded so the test walks the SAME candidate list the replay
                // walks. Parsed defensively: a malformed payload must degrade to "no fallbacks"
                // (today's behaviour), never fail the test with a JSON error.
                List<Models.SelectorAlternativeItem>? alternatives = null;
                if (payload.TryGetProperty("alternatives", out var altEl) && altEl.ValueKind == JsonValueKind.Array)
                {
                    try
                    {
                        var parsed = JsonSerializer.Deserialize<List<Models.SelectorAlternativeItem>>(altEl.GetRawText(), JsonOptions);
                        alternatives = parsed != null && parsed.Count > 0 ? parsed : null;
                    }
                    catch { alternatives = null; }
                }

                // Resolve {clipboard[:mods]}, {date}, {time}, {datetime} the same way the regular
                // replay path does — without this, Test Action would type the literal placeholder
                // instead of the substituted value.
                //
                // Mirror the replay EXACTLY, which resolves for three types and no others:
                // BrowserType + BrowserSelectOption (ActionExecution's Browser arm) and
                // BrowserAssert's text pattern (ExecuteBrowserAssert). Only BrowserType was listed
                // here, so testing a Select Option or a text-match Assert matched against the
                // LITERAL "{clipboard}" and reported a failure the replay would not have had.
                // Click / RightClick / WaitElement stay unresolved ON PURPOSE — the replay does not
                // resolve their Text Match either, and resolving here would just invent the same
                // divergence pointing the other way.
                string? resolvedText = browserText;
                if (!string.IsNullOrEmpty(browserText)
                    && (actionType == "BrowserType" || actionType == "BrowserSelectOption" || actionType == "BrowserAssert"))
                    resolvedText = await ActionReplayer.ResolveBrowserTextPlaceholdersAsync(browserText, dispatcherQueue);

                // The 1000 ms floor here mirrors the minimum the editor allows. The Timeout field
                // isn't shown for BrowserType, so this is a safety net for older payloads only.
                var temp = new ActionItem
                {
                    ActionType = actionType,
                    Key = key,
                    BrowserText = resolvedText,
                    NewTab = newTab,
                    Timeout = Math.Max(1000, timeoutMs),
                    WaitMode = waitMode,
                    UrlWaitPattern = urlWaitPattern,
                    PostNavigateSelector = postNavigateSelector,
                    TypeAppend = typeAppend,
                    TypePaste = typePaste,
                    TypeDelay = typeDelay,
                    SelectMatchMode = selectMatchMode,
                    SelectorAlternatives = alternatives,
                };

                var sw = System.Diagnostics.Stopwatch.StartNew();
                var testResult = await browserBridge.TestActionAsync(temp, CancellationToken.None, resolvedText);
                sw.Stop();

                // The reply carries matchedVia when the PRIMARY selector failed and a pick-time
                // fallback matched instead. It was being thrown away here — the return value went
                // unused — so a test that only passed because a tier-B fallback caught it looked
                // identical to one that matched on the first try. That is the single most useful
                // thing to know about a selector, and Test action is where the user is standing
                // when they want to know it.
                string? matchedSelector = null, matchedTier = null;
                if (testResult.ValueKind == JsonValueKind.Object
                    && testResult.TryGetProperty("matchedVia", out var mvEl)
                    && mvEl.ValueKind == JsonValueKind.Object)
                {
                    matchedSelector = mvEl.TryGetProperty("selector", out var mvS) ? mvS.GetString() : null;
                    matchedTier = mvEl.TryGetProperty("tier", out var mvT) ? mvT.GetString() : null;
                }

                TrySendTestResult(requestId, success: true, durationMs: sw.ElapsedMilliseconds, code: null, message: null, tip: null,
                    matchedSelector: matchedSelector, matchedTier: matchedTier);
            }
            catch (TrueReplayer.Services.BrowserActionException bex)
            {
                TrySendTestResult(requestId, success: false, durationMs: 0,
                    code: bex.Code ?? "UNKNOWN_ERROR", message: bex.Message, tip: bex.Tip);
            }
            catch (Exception ex)
            {
                TrySendTestResult(requestId, success: false, durationMs: 0,
                    code: "UNKNOWN_ERROR", message: ex.Message, tip: null);
            }
        }

        // Wrapper that swallows exceptions thrown from SendMessage itself so a failed reply never
        // bubbles up and crashes the synchronization context.
        private void TrySendTestResult(string requestId, bool success, long durationMs, string? code, string? message, string? tip,
            string? matchedSelector = null, string? matchedTier = null)
        {
            try
            {
                if (success)
                {
                    // matchedVia only rides along when a fallback actually saved the run; null on the
                    // ordinary path keeps the success card unchanged for the common case.
                    // Typed as object? because a ternary between null and an anonymous type has no
                    // common type to infer.
                    object? matchedVia = matchedSelector == null
                        ? null
                        : new { selector = matchedSelector, tier = matchedTier ?? "C" };
                    SendMessage("browser:testResult", new { requestId, success = true, durationMs, matchedVia });
                }
                else
                {
                    SendMessage("browser:testResult", new
                    {
                        requestId,
                        success = false,
                        error = new { code, message, tip },
                    });
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[WebViewBridge] Failed to send testResult: {ex.Message}");
            }
        }

        private async void HandleProfileClick(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            // Guard: check for unsaved changes before switching
            if (!await CheckUnsavedChangesAsync("switching profiles")) return;

            // Deselect if clicking the already-active profile
            if (CurrentProfileName == name)
            {
                CurrentProfileName = "No Profile";
                CurrentProfilePath = null;
                HasUnsavedChanges = false;
                actions.Clear();
                profileController.UpdateProfileColors(null);
                // Deselect lands on "No Profile", which switches the Loops row back to editing
                // the app-level fallback — the chip and the panel both need to hear about it.
                ClearLoopEdit();
                PushProfileLoop();
                PushProfilesUpdate();
                PushActionsUpdate();
                PushButtonStates();
                PushToolbarUpdate();
                PushStatusBarUpdate();
                TrayIconService.UpdateTrayIcon();
                return;
            }

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile != null)
            {
                var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
                UserProfile.Current = profile;
                AppSettingsManager.ApplyGlobalSettings(UserProfile.Current);
                CurrentProfileName = name;
                CurrentProfilePath = entry?.FilePath;
                HasUnsavedChanges = false;
                // Sync cached entry with loaded profile data
                if (entry != null)
                {
                    entry.UseRelativeCoordinates = profile.UseRelativeCoordinates;
                    entry.BringToFocus = profile.BringToFocus;
                }
                // Apply effective values (profile's own > folder-inherited)
                UserProfile.Current.UseRelativeCoordinates = profileController.GetEffectiveRelativeCoordinates(name);
                UserProfile.Current.BringToFocus = profileController.GetEffectiveBringToFocus(name);
                ApplyProfile(profile);
                profileController.UpdateProfileColors(name);
                // The new profile's loop settings. ApplyProfile only pushes actions + button
                // states, so without this the panel keeps rendering the PREVIOUS profile's
                // number. The edit flag is reset explicitly — it is not tied to profile identity
                // on the React side and would otherwise stay dirty across the swap.
                ClearLoopEdit();
                PushProfileLoop();
                PushProfilesUpdate();
                TrayIconService.UpdateTrayIcon();
            }
        }

        // Delegates to the shared validator (single owner for this security/data-loss check —
        // was duplicated here + in ProfileController). Guards against a malicious/buggy WebView
        // payload smuggling path separators/traversal, a trailing dot/space, or a reserved device
        // name into a profile name that later feeds Path.Combine / File.Move.
        private static bool IsSafeProfileName(string name) => Services.ProfileNameValidator.IsSafe(name);

        private async void HandleProfileCreate(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            // Extract folder before any await (JsonDocument may be disposed after await)
            string? folderName = payload.TryGetProperty("folder", out var fp) && fp.ValueKind == JsonValueKind.String
                ? fp.GetString() : null;

            if (string.IsNullOrEmpty(name)) return;
            if (!IsSafeProfileName(name))
            {
                SendMessage("alert:show", new { message = "Invalid profile name." });
                return;
            }

            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles");

            if (!name.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                name += ".json";

            string fullPath = Path.Combine(profileDir, name);

            // async void: an unhandled IO exception (CreateDirectory / SaveProfileAsync /
            // load on a read-only or full disk) would post to the dispatcher and crash the
            // app. Guard the whole disk-touching body and surface a toast, mirroring
            // HandleProfileDuplicate/HandleProfileRename/HandleProfileDelete.
            try
            {
                Directory.CreateDirectory(profileDir);

                if (File.Exists(fullPath))
                {
                    // Silent no-op before — now surfaces a toast so the user knows why nothing
                    // happened. The frontend dialog also blocks this inline, but a hotkey / race
                    // could still reach here, so it stays defended on the backend too.
                    SendMessage("alert:show", new { message = $"A profile named \"{Path.GetFileNameWithoutExtension(name)}\" already exists" });
                    return;
                }

                var profile = UserProfile.Default;
                await SettingsManager.SaveProfileAsync(fullPath, profile);
                await profileController.RefreshProfileListAsync(true);

                string profileName = Path.GetFileNameWithoutExtension(fullPath);

                if (!string.IsNullOrEmpty(folderName))
                {
                    var order = profileController.GetProfileOrder();
                    var folder = order.Folders.FirstOrDefault(f => f.Name == folderName);
                    if (folder != null)
                    {
                        order.UngroupedOrder.Remove(profileName);
                        if (!folder.Items.Contains(profileName))
                            folder.Items.Add(profileName);
                        await profileController.SaveProfileOrderAsync();
                    }
                }

                // Auto-select the freshly created profile so the user can start adding
                // actions without clicking it first. Mirrors what HandleProfileClick does
                // on the activate path, minus the unsaved-changes guard (this row didn't
                // exist a moment ago, nothing to lose) and the deselect branch (it's not
                // a re-click). Works identically inside or outside a folder — folder
                // placement happened above, activation just needs the canonical name.
                var loaded = await profileController.LoadProfileByNameAsync(profileName);
                if (loaded != null)
                {
                    var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == profileName);
                    UserProfile.Current = loaded;
                    AppSettingsManager.ApplyGlobalSettings(UserProfile.Current);
                    CurrentProfileName = profileName;
                    CurrentProfilePath = entry?.FilePath;
                    HasUnsavedChanges = false;
                    if (entry != null)
                    {
                        entry.UseRelativeCoordinates = loaded.UseRelativeCoordinates;
                        entry.BringToFocus = loaded.BringToFocus;
                    }
                    UserProfile.Current.UseRelativeCoordinates = profileController.GetEffectiveRelativeCoordinates(profileName);
                    UserProfile.Current.BringToFocus = profileController.GetEffectiveBringToFocus(profileName);
                    ApplyProfile(loaded);
                    profileController.UpdateProfileColors(profileName);
                    ClearLoopEdit();
                    PushProfileLoop();
                    TrayIconService.UpdateTrayIcon();
                }

                PushProfilesUpdate();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[Bridge] Create error: {ex.Message}");
                SendMessage("alert:show", new { message = $"Could not create profile: {ex.Message}" });
            }
        }

        private async void HandleProfileToggleDisable(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
            if (entry == null || !File.Exists(entry.FilePath)) return;

            // async void: a load/save IO failure would crash the app on the dispatcher.
            // Guard the disk I/O and surface a toast, matching the other profile handlers.
            try
            {
                var profile = await SettingsManager.LoadProfileAsync(entry.FilePath);
                if (profile == null) return;

                profile.IsDisabled = !profile.IsDisabled;
                await SettingsManager.SaveProfileAsync(entry.FilePath, profile);

                entry.IsDisabled = profile.IsDisabled;
                if (CurrentProfileName == name)
                    UserProfile.Current.IsDisabled = profile.IsDisabled;

                // Re-register hotkeys so disabled profiles are excluded. This runs BEFORE the
                // push on purpose: GetProfileHotkeys is also what stamps HotkeyConflict, and
                // disabling one of two profiles that shared a combo resolves the conflict. Push
                // first and the sidebar keeps showing the red chip until something else pushes.
                var hotkeys = profileController.GetProfileHotkeys();
                InputHookManager.RegisterProfileHotkeys(hotkeys);
                InputHookManager.RegisterProfileTriggerModes(profileController.GetProfileTriggerModes());
                var hotstrings = profileController.GetProfileHotstrings();
                InputHookManager.RegisterProfileHotstrings(hotstrings);

                PushProfilesUpdate();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[Bridge] Toggle-disable error: {ex.Message}");
                SendMessage("alert:show", new { message = $"Could not update \"{name}\": {ex.Message}" });
            }
        }

        private async void HandleProfileDuplicate(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
            if (entry == null || !File.Exists(entry.FilePath)) return;

            string? dir = Path.GetDirectoryName(entry.FilePath);
            if (string.IsNullOrEmpty(dir)) return;
            string copyName = $"{name} - Copy";
            string copyPath = Path.Combine(dir, copyName + ".json");

            int counter = 2;
            while (File.Exists(copyPath))
            {
                copyName = $"{name} - Copy ({counter})";
                copyPath = Path.Combine(dir, copyName + ".json");
                counter++;
            }

            try
            {
                File.Copy(entry.FilePath, copyPath);

                // Fix up the copy BEFORE the profile-list refresh sees it: the refresh's tail
                // re-arms the trigger daemon from the on-disk configs, so an armed source
                // profile would put a LIVE armed watcher on the copy — and the disarming save
                // below would land inside the refresh's watcher-suppression window and never
                // be picked up (daemon + UI armed, disk disarmed, firing until restart).
                //
                // File.Copy also duplicated a JSON that still points at the SOURCE profile's
                // per-profile PNGs — clone each referenced image (WaitImage / IF-Image rows +
                // the automation image-watcher) into the copy's own image dir under a fresh
                // GUID filename and repoint. A null clone (source PNG missing) clears the
                // reference → empty thumbnail + "recapture" hint, never a broken ref.
                var copyProfile = await SettingsManager.LoadProfileAsync(copyPath);
                if (copyProfile != null)
                {
                    bool mutated = false;
                    foreach (var action in copyProfile.Actions)
                    {
                        if (string.IsNullOrEmpty(action.ImagePath)) continue;
                        bool refsImage = action.ActionType == "WaitImage"
                            || (IsConditionOpenerRow(action) && string.Equals(action.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase));
                        if (!refsImage) continue;
                        action.ImagePath = ImageStorageService.CloneReferenceImage(name, action.ImagePath!, copyName);
                        mutated = true;
                    }
                    if (copyProfile.Triggers != null)
                    {
                        // Both firing the same schedule is never what Duplicate means.
                        if (copyProfile.Triggers.Armed)
                        {
                            copyProfile.Triggers.Armed = false;
                            mutated = true;
                        }
                        if (string.Equals(copyProfile.Triggers.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase)
                            && !string.IsNullOrEmpty(copyProfile.Triggers.ImagePath))
                        {
                            copyProfile.Triggers.ImagePath =
                                ImageStorageService.CloneReferenceImage(name, copyProfile.Triggers.ImagePath!, copyName);
                            mutated = true;
                        }
                    }
                    if (mutated)
                        await SettingsManager.SaveProfileAsync(copyPath, copyProfile);
                }

                await profileController.RefreshProfileListAsync(true);

                // Place the copy in the same folder as the original
                var order = profileController.GetProfileOrder();
                var folder = order.Folders.FirstOrDefault(f => f.Items.Contains(name));
                if (folder != null)
                {
                    order.UngroupedOrder.Remove(copyName);
                    int idx = folder.Items.IndexOf(name);
                    folder.Items.Insert(idx + 1, copyName);
                    await profileController.SaveProfileOrderAsync();
                }

                PushProfilesUpdate();
            }
            catch (Exception ex)
            {
                // async void: an unhandled exception here would post to the dispatcher and crash
                // the app. Mirror HandleProfileRename/HandleProfileDelete's catch (Debug.WriteLine)
                // and additionally surface a toast so a recoverable I/O failure is visible.
                System.Diagnostics.Debug.WriteLine($"[Bridge] Duplicate error: {ex.Message}");
                SendMessage("alert:show", new { message = $"Could not duplicate \"{name}\": {ex.Message}" });
            }
        }

        private async void HandleProfileRename(JsonElement payload)
        {
            string oldName = payload.GetProperty("oldName").GetString() ?? "";
            string newName = payload.GetProperty("newName").GetString() ?? "";
            if (string.IsNullOrEmpty(oldName) || string.IsNullOrEmpty(newName)) return;
            if (!IsSafeProfileName(newName))
            {
                SendMessage("alert:show", new { message = "Invalid profile name." });
                return;
            }

            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == oldName);
            if (entry == null) return;

            string? folderPath = Path.GetDirectoryName(entry.FilePath);
            if (folderPath == null) return;

            string newFileName = newName.EndsWith(".json", StringComparison.OrdinalIgnoreCase) ? newName : newName + ".json";
            string newFilePath = Path.Combine(folderPath, newFileName);

            // Allow case-only rename (e.g. "teste" → "TESTE") on case-insensitive file systems
            if (File.Exists(newFilePath) && !string.Equals(entry.FilePath, newFilePath, StringComparison.OrdinalIgnoreCase))
            {
                SendMessage("alert:show", new { message = $"A profile named \"{Path.GetFileNameWithoutExtension(newFileName)}\" already exists" });
                return;
            }

            try
            {
                File.Move(entry.FilePath, newFilePath);
                var actualNewName = Path.GetFileNameWithoutExtension(newFileName);
                ImageStorageService.RenameProfileDirectory(oldName, actualNewName);
                if (CurrentProfileName == oldName)
                {
                    CurrentProfileName = actualNewName;
                    CurrentProfilePath = newFilePath;
                    // A rename keeps the same loaded profile — and so must a pending, unsaved
                    // loop edit. Re-stamp the edit's owner name instead of clearing it, or the
                    // name check in HasUnsavedLoopChange would silently drop the user's value.
                    RetargetLoopEdit(actualNewName);
                }
                // Migrate the automation fire-stats BEFORE the refresh re-arms under the new
                // name — otherwise cooldown/fire history restarts from zero on every rename.
                TriggerService.Instance?.RenameStats(oldName, actualNewName);
                // Same reason, same moment: the data-loop row position and every SetVariable
                // cycle position are keyed by profile name, so without this a rename silently
                // sends every list in the profile back to item 1.
                RunCursorService.RenameProfile(oldName, actualNewName);
                await profileController.RenameProfileInOrderAsync(oldName, actualNewName);
                await profileController.RefreshProfileListAsync(true);

                // Rewrite RunProfile references in every OTHER profile that points to the
                // renamed name — otherwise those references become silent no-ops at replay
                // time. Touches profiles on disk + the active in-memory action list.
                int refsUpdated = await ScanRunProfileReferencesAsync(oldName, actualNewName);

                // The scan rewrote RunProfile Keys ON DISK after the refresh above had already
                // built ProfileEntries, so those entries — and the RunProfileTargets mirror the
                // Export dialog reads — still name the OLD target. Re-read before pushing, or the
                // dialog's "+N referenced sub-profiles included" disclosure describes a chain that
                // no longer exists (it resolves refs against this payload, while the export itself
                // re-reads from disk), and a renamed sub-profile would ship undisclosed. The
                // watcher can't heal it: RefreshProfileListAsync(true) suppresses it for 2 s, which
                // is exactly when these writes land. Guarded so the common no-references rename
                // still costs a single list load.
                if (refsUpdated > 0)
                    await profileController.RefreshProfileListAsync(true);

                PushProfilesUpdate();
                PushToolbarUpdate();
                PushStatusBarUpdate();

                if (refsUpdated > 0)
                {
                    string plural = refsUpdated == 1 ? "reference" : "references";
                    SendMessage("alert:show", new { message = $"Renamed to '{actualNewName}' and updated {refsUpdated} {plural} in other profiles." });
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[Bridge] Rename error: {ex.Message}");
            }
        }

        /// <summary>
        /// Walks every profile (on disk + the active in-memory action list) and counts
        /// RunProfile references whose Key matches <paramref name="targetName"/>. When
        /// <paramref name="rewriteTo"/> is non-null, also rewrites the Key in-place and
        /// persists. Returns the total number of references touched.
        ///
        /// Used by HandleProfileRename (rewrite mode) and HandleProfileDelete (count-only)
        /// to keep cross-profile RunProfile references from going stale.
        /// </summary>
        private async Task<int> ScanRunProfileReferencesAsync(string targetName, string? rewriteTo)
        {
            int total = 0;

            // 1. Every other profile on disk. Skip the renamed/deleted profile itself and the
            //    active one (whose source of truth is the in-memory `actions` list — saving
            //    the on-disk copy would clobber unsaved edits).
            foreach (var entry in profileController.ProfileEntries.ToList())
            {
                if (string.Equals(entry.Name, targetName, StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(entry.Name, CurrentProfileName, StringComparison.OrdinalIgnoreCase)) continue;

                try
                {
                    var profile = await profileController.LoadProfileByNameAsync(entry.Name);
                    if (profile == null) continue;
                    int hits = 0;
                    foreach (var act in profile.Actions)
                    {
                        if (!string.Equals(act.ActionType, "RunProfile", StringComparison.OrdinalIgnoreCase)) continue;
                        if (!string.Equals(act.Key, targetName, StringComparison.OrdinalIgnoreCase)) continue;
                        hits++;
                        if (rewriteTo != null) act.Key = rewriteTo;
                    }
                    if (hits > 0 && rewriteTo != null)
                    {
                        await profileController.SaveProfileByNameAsync(entry.Name, profile);
                    }
                    total += hits;
                }
                catch (Exception ex)
                {
                    Services.DiagnosticLog.Info($"[Chain] Scan refs in '{entry.Name}' failed: {ex.Message}");
                }
            }

            // 2. The active in-memory profile's actions, which may carry unsaved edits.
            //    Skip if the active profile IS the renamed/deleted one (it's already being
            //    handled by the rename/delete path itself).
            if (!string.Equals(CurrentProfileName, targetName, StringComparison.OrdinalIgnoreCase))
            {
                int inMemory = 0;
                foreach (var act in actions)
                {
                    if (!string.Equals(act.ActionType, "RunProfile", StringComparison.OrdinalIgnoreCase)) continue;
                    if (!string.Equals(act.Key, targetName, StringComparison.OrdinalIgnoreCase)) continue;
                    inMemory++;
                    if (rewriteTo != null) act.Key = rewriteTo;
                }
                if (inMemory > 0 && rewriteTo != null)
                {
                    HasUnsavedChanges = true;
                    PushActionsUpdate();
                }
                total += inMemory;
            }

            return total;
        }

        private async void HandleProfileDelete(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
            if (entry == null) return;

            // Count RunProfile references BEFORE deletion so the user gets a heads-up that
            // those references will become silent no-ops. We deliberately don't auto-clear
            // them — the user might want to fix them by hand or rename a replacement profile
            // to the deleted name.
            int danglingRefs = 0;
            try { danglingRefs = await ScanRunProfileReferencesAsync(name, null); }
            catch (Exception ex) { Services.DiagnosticLog.Info($"[Chain] Pre-delete scan failed: {ex.Message}"); }

            try
            {
                if (File.Exists(entry.FilePath))
                    File.Delete(entry.FilePath);

                ImageStorageService.DeleteProfileDirectory(name);

                if (CurrentProfileName == name)
                {
                    CurrentProfileName = "No Profile";
                    CurrentProfilePath = null;
                    HasUnsavedChanges = false;
                    actions.Clear();
                    // Deleting the active profile drops to "No Profile" — same handoff back to
                    // the global fallback as the deselect branch in HandleProfileClick.
                    ClearLoopEdit();
                    PushProfileLoop();
                    // UserProfile.Current changed, so the Data panel is now showing a deleted
                    // profile's table. Unlike every other switch path this branch has no explicit
                    // PushActionsUpdate — it used to get the refresh as a side effect of the
                    // actions.Clear() above reaching OnActionsChanged, which no longer carries it.
                    PushDataTable();
                }

                await profileController.RemoveProfileFromOrderAsync(name);
                await profileController.RefreshProfileListAsync(true);
                // Re-register hotkeys since a profile was removed
                var hotkeys = profileController.GetProfileHotkeys();
                InputHookManager.RegisterProfileHotkeys(hotkeys);
                InputHookManager.RegisterProfileTriggerModes(profileController.GetProfileTriggerModes());
                var hotstrings = profileController.GetProfileHotstrings();
                InputHookManager.RegisterProfileHotstrings(hotstrings);
                InputHookManager.RegisterProfileWindowTargets(profileController.GetProfileWindowTargets(), profileController.GetBringToFocusProfiles());
                PushProfilesUpdate();
                PushButtonStates();
                PushToolbarUpdate();
                PushStatusBarUpdate();
                TrayIconService.UpdateTrayIcon();

                if (danglingRefs > 0)
                {
                    string plural = danglingRefs == 1 ? "reference" : "references";
                    SendMessage("alert:show", new { message = $"Deleted '{name}'. {danglingRefs} dangling {plural} in other profiles will silently no-op at replay." });
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[Bridge] Delete error: {ex.Message}");
            }
        }

        private async void HandleProfileAssignHotkey(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            string hotkey = payload.GetProperty("hotkey").GetString() ?? "";
            if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(hotkey)) return;

            // Optional trigger mode: saved atomically with the hotkey so the UI doesn't need
            // to fire a second message.
            Models.TriggerMode? newMode = null;
            if (payload.TryGetProperty("mode", out var modeEl) && modeEl.ValueKind == JsonValueKind.String)
                newMode = TriggerModeFromString(modeEl.GetString());

            var effectiveTarget = profileController.GetEffectiveWindowTarget(name);
            var conflict = GetHotkeyConflict(hotkey, excludeSettingKey: null, excludeProfileName: name, effectiveTarget: effectiveTarget);
            if (conflict != null)
            {
                SendMessage("alert:show", new { message = $"\"{hotkey}\" is already used by {conflict}." });
                return;
            }

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile != null)
            {
                profile.CustomHotkey = hotkey;
                if (newMode.HasValue) profile.TriggerMode = newMode.Value;
                await profileController.SaveProfileByNameAsync(name, profile);
                if (CurrentProfileName == name)
                {
                    UserProfile.Current.CustomHotkey = hotkey;
                    if (newMode.HasValue) UserProfile.Current.TriggerMode = newMode.Value;
                }
                await profileController.RefreshProfileListAsync(true);
                var map = profileController.GetProfileHotkeys();
                InputHookManager.RegisterProfileHotkeys(map);
                InputHookManager.RegisterProfileTriggerModes(profileController.GetProfileTriggerModes());
                // Surface collisions right after the assign so the user gets immediate feedback
                // when they bind a hotkey that another profile already claims. Single alert per
                // colliding combo, "only one will fire" wording is in the helper.
                foreach (var msg in profileController.GetAndClearHotkeyCollisions())
                {
                    SendMessage("alert:show", new { message = msg });
                }
                PushProfilesUpdate();
            }
        }

        private async void HandleProfileRemoveHotkey(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile != null)
            {
                profile.CustomHotkey = null;
                await profileController.SaveProfileByNameAsync(name, profile);
                if (CurrentProfileName == name)
                    UserProfile.Current.CustomHotkey = null;
                await profileController.RefreshProfileListAsync(true);
                var map = profileController.GetProfileHotkeys();
                InputHookManager.RegisterProfileHotkeys(map);
                InputHookManager.RegisterProfileTriggerModes(profileController.GetProfileTriggerModes());
                PushProfilesUpdate();
            }
        }

        private async void HandleProfileAssignHotstring(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            string sequence = payload.GetProperty("sequence").GetString() ?? "";
            bool instant = payload.TryGetProperty("instant", out var instantProp) && instantProp.GetBoolean();

            if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(sequence)) return;

            sequence = sequence.ToLowerInvariant().Trim();
            if (sequence.Length < 2 || !System.Text.RegularExpressions.Regex.IsMatch(sequence, @"^[a-z0-9\-./,;=]+$"))
            {
                SendMessage("alert:show", new { message = "Hotstring must be at least 2 characters (a-z, 0-9, - . / , ; =)." });
                return;
            }

            var effectiveTarget = profileController.GetEffectiveWindowTarget(name);
            var conflict = GetHotstringConflict(sequence, excludeProfileName: name, effectiveTarget: effectiveTarget);
            if (conflict != null)
            {
                SendMessage("alert:show", new { message = $"Hotstring \"{sequence}\" is already used by {conflict}." });
                return;
            }

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile != null)
            {
                profile.CustomHotstring = new Models.HotstringConfig { Sequence = sequence, Instant = instant };
                await profileController.SaveProfileByNameAsync(name, profile);
                if (CurrentProfileName == name)
                    UserProfile.Current.CustomHotstring = profile.CustomHotstring;
                await profileController.RefreshProfileListAsync(true);
                var hotstringMap = profileController.GetProfileHotstrings();
                InputHookManager.RegisterProfileHotstrings(hotstringMap);
                PushProfilesUpdate();
            }
        }

        private async void HandleProfileRemoveHotstring(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile != null)
            {
                profile.CustomHotstring = null;
                await profileController.SaveProfileByNameAsync(name, profile);
                if (CurrentProfileName == name)
                    UserProfile.Current.CustomHotstring = null;
                await profileController.RefreshProfileListAsync(true);
                var hotstringMap = profileController.GetProfileHotstrings();
                InputHookManager.RegisterProfileHotstrings(hotstringMap);
                PushProfilesUpdate();
            }
        }

        private string? GetHotstringConflict(string sequence, string? excludeProfileName, WindowTarget? effectiveTarget = null)
        {
            if (string.IsNullOrEmpty(sequence)) return null;

            foreach (var entry in profileController.ProfileEntries)
            {
                if (entry.Name == excludeProfileName) continue;
                if (!string.Equals(entry.Hotstring, sequence, StringComparison.OrdinalIgnoreCase)) continue;

                var otherTarget = profileController.GetEffectiveWindowTarget(entry.Name);
                if (EffectiveTargetsOverlap(effectiveTarget, otherTarget))
                    return $"Profile \"{entry.Name}\"";
            }

            return null;
        }

        /// <summary>
        /// How an attempt to resolve a <see cref="WindowTarget"/> to a live window rect ended.
        /// Deliberately a status rather than a message: the callers say different things
        /// ("…and convert again" vs "…then try Apply target &amp; convert again" vs "…to the size
        /// and position you want captured"), and one of them says nothing at all and just falls
        /// back to absolute coordinates. Flattening them to one generic sentence would throw away
        /// the only part of each error that tells the user which button to press next.
        /// </summary>
        private enum WindowRectStatus
        {
            Ok,
            // No visible window matched the target — it is closed, or the matcher is wrong.
            NotFound,
            // Matched, but minimised: its rect is the parking rect, not geometry. See TryGetWindowRect.
            Minimised,
            // Matched and on screen, but GetWindowRect itself failed. Rare; usually a dead hwnd.
            RectUnavailable,
        }

        /// <summary>
        /// The single door through which this file turns a <see cref="WindowTarget"/> into a live
        /// window rect: FindWindow, then IsIconic, then GetWindowRect — always in that order and
        /// always all three.
        /// </summary>
        /// <remarks>
        /// The IsIconic step is the reason this exists rather than four hand-copied sequences.
        /// FindWindow only filters on IsWindowVisible, which a MINIMISED window still passes, and
        /// GetWindowRect then answers with the off-screen (-32000,-32000) parking rect — the same
        /// hazard NativeMethods.GetWindowPlacement and ScreenOverlayWindow's banner placement are
        /// already written to dodge. Every consumer downstream treats that answer as real
        /// geometry: the coordinate converter shifts every click, WaitImage region and WaitPixel
        /// coord in the profile by ~32000 px and reports "Converted N action(s)"; "Update Window
        /// Size &amp; Position" writes the parking rect to disk as the restore geometry; the capture
        /// paths store a pick ~32000 px away from where the user clicked.
        ///
        /// Three call sites each grew their own copy of the guard and the fourth
        /// (TryGetRelativeCaptureOffset) never did — which is precisely the failure this replaces:
        /// the guard now holds by construction instead of by everyone remembering it.
        ///
        /// Callers map the status to their own wording; see <see cref="WindowRectStatus"/>. On any
        /// non-Ok status <paramref name="rect"/> is <c>default</c>, never the parking rect, so a
        /// caller that ignores the status still cannot spend a poisoned value.
        /// </remarks>
        private static WindowRectStatus TryGetWindowRect(WindowTarget? target, out NativeMethods.RECT rect)
        {
            rect = default;
            IntPtr hwnd = TrueReplayer.Helpers.WindowMatcher.FindWindow(target);
            if (hwnd == IntPtr.Zero) return WindowRectStatus.NotFound;
            if (NativeMethods.IsIconic(hwnd)) return WindowRectStatus.Minimised;
            if (!NativeMethods.GetWindowRect(hwnd, out rect))
            {
                // GetWindowRect writes to the out param even when it fails; blank it so the
                // "never the parking rect, never garbage" promise above holds on this path too.
                rect = default;
                return WindowRectStatus.RectUnavailable;
            }
            return WindowRectStatus.Ok;
        }

        private async void HandleProfileSetWindowTarget(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            string processName = payload.GetProperty("processName").GetString() ?? "";
            string windowTitle = payload.GetProperty("windowTitle").GetString() ?? "";
            string titleMatchMode = payload.TryGetProperty("titleMatchMode", out var tmProp)
                ? tmProp.GetString() ?? "contains"
                : "contains";
            bool relativeCoordinates = payload.TryGetProperty("relativeCoordinates", out var rcProp) && rcProp.GetBoolean();
            bool bringToFocus = payload.TryGetProperty("bringToFocus", out var btfProp) && btfProp.GetBoolean();
            bool restorePosition = payload.TryGetProperty("restorePosition", out var rpProp) && rpProp.GetBoolean();
            bool restoreSize = payload.TryGetProperty("restoreSize", out var rsProp) && rsProp.GetBoolean();
            // When true, the profile keeps its inherited target (from folder or none). We only
            // write the flags (relativeCoords/bringToFocus/restorePosition/restoreSize/geometry).
            // Prevents the dialog from accidentally "promoting" a folder-inherited target into a
            // profile-level target just because the user toggled a flag.
            bool keepInheritedTarget = payload.TryGetProperty("keepInheritedTarget", out var kitProp) && kitProp.GetBoolean();
            // Read upfront — the payload JsonElement points into a JsonDocument that is disposed
            // when the dispatch loop's first await returns control. Touching payload after the
            // SaveProfileByNameAsync / RefreshProfileListAsync awaits below would crash with
            // ObjectDisposedException on the JsonDocument.
            string? convertDirection = null;
            if (payload.TryGetProperty("convertDirection", out var cdProp)
                && cdProp.ValueKind == JsonValueKind.String)
            {
                var raw = cdProp.GetString();
                if (raw == "toRelative" || raw == "toAbsolute") convertDirection = raw;
            }
            if (string.IsNullOrEmpty(name)) return;

            // "Apply target & convert" only means anything for the LOADED profile: the conversion
            // rewrites the in-memory action list and UserProfile.Current, which belong to whoever is
            // open — not to whoever this dialog was opened for. Unlike the two context-menu Convert
            // items, the dialog has no isActive gate. The call site further down already knows this
            // and skips the conversion for a different profile, but by then the target and the
            // flipped UseRelativeCoordinates are on disk, leaving that profile claiming one
            // coordinate space while its stored coordinates sit in the other — permanently, with no
            // toast and no error. Refuse the combined op up front, while a refusal is still atomic.
            // A plain Set Target (no convertDirection) is untouched and still works on any profile.
            if (convertDirection != null && CurrentProfileName != name)
            {
                SendMessage("alert:show", new { message = $"Open \"{name}\" first — converting coordinates rewrites the actions of the profile that is currently loaded." });
                return;
            }

            // Pre-flight for the "Apply target & convert" path: resolve the target window NOW,
            // before any save runs, so an unreachable target aborts the entire combined op
            // atomically. Without this, the save would complete (target + flag persisted to
            // disk), then the conversion would fail at FindWindow → the profile would be left
            // with relativeCoordinates=true but actions still in absolute coords. Caching the
            // rect here and threading it through to ExecuteConvertCoordinatesWithRect also
            // closes the race where the user closes the target window between the save and
            // the conversion — we already have the geometry we need.
            NativeMethods.RECT? preflightRect = null;
            if (convertDirection != null)
            {
                if (string.IsNullOrWhiteSpace(processName) && string.IsNullOrWhiteSpace(windowTitle))
                {
                    SendMessage("alert:show", new { message = "Set a process name or window title before converting." });
                    return;
                }
                var tentativeTarget = new WindowTarget
                {
                    ProcessName = string.IsNullOrWhiteSpace(processName) ? null : processName.Trim(),
                    WindowTitle = string.IsNullOrWhiteSpace(windowTitle) ? null : windowTitle.Trim(),
                    TitleMatchMode = titleMatchMode,
                };
                // The minimised case is the worst of the four TryGetWindowRect callers: the rect
                // cached here is spent AFTER the target save has already committed, so a parking
                // rect would leave the profile saved-and-corrupted rather than merely corrupted.
                // Refused up front, while the refusal is still atomic.
                var preflightStatus = TryGetWindowRect(tentativeTarget, out var rect);
                if (preflightStatus != WindowRectStatus.Ok)
                {
                    SendMessage("alert:show", new
                    {
                        message = preflightStatus switch
                        {
                            WindowRectStatus.NotFound => "Target window not found. Open it first, then try Apply target & convert again.",
                            WindowRectStatus.Minimised => "Target window is minimised. Restore it, then try Apply target & convert again.",
                            _ => "Could not read the target window's position. Try again.",
                        }
                    });
                    return;
                }
                preflightRect = rect;
            }

            if (!keepInheritedTarget)
            {
                if (string.IsNullOrWhiteSpace(processName) && string.IsNullOrWhiteSpace(windowTitle))
                {
                    SendMessage("alert:show", new { message = "Please specify at least a process name or window title." });
                    return;
                }

                if (titleMatchMode == "regex" && !string.IsNullOrWhiteSpace(windowTitle))
                {
                    try
                    {
                        _ = new System.Text.RegularExpressions.Regex(windowTitle.Trim());
                    }
                    catch
                    {
                        SendMessage("alert:show", new { message = "Invalid regex pattern. Please check the syntax." });
                        return;
                    }
                }
            }

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile != null)
            {
                // When keepInheritedTarget is true the profile has no target of its own and the
                // user is just toggling flags on top of the folder-inherited target. Persisting
                // those flags would create dormant overrides: GetEffectiveBringToFocus and
                // friends ignore entry-level values until the profile has its own target, so the
                // user would see the toggle flip but the effective behaviour stays on the folder.
                // Skip the writes — the toggles become real only after a profile-level target
                // exists (i.e. when the user edits the process/title or clicks Detect).
                if (!keepInheritedTarget)
                {
                    profile.TargetWindow = new WindowTarget
                    {
                        ProcessName = string.IsNullOrWhiteSpace(processName) ? null : processName.Trim(),
                        WindowTitle = string.IsNullOrWhiteSpace(windowTitle) ? null : windowTitle.Trim(),
                        TitleMatchMode = titleMatchMode
                    };
                    profile.UseRelativeCoordinates = relativeCoordinates;
                    profile.BringToFocus = bringToFocus;
                    profile.RestorePosition = restorePosition;
                    profile.RestoreSize = restoreSize;
                }
                // If this is the active profile, the in-memory UserProfile.Current may hold
                // fresher WindowX/Y/Width/Height (captured via "Update Window Size & Position"
                // button since last save). Copy those across so Set Target doesn't overwrite them.
                if (CurrentProfileName == name)
                {
                    profile.WindowX = UserProfile.Current.WindowX;
                    profile.WindowY = UserProfile.Current.WindowY;
                    profile.WindowWidth = UserProfile.Current.WindowWidth;
                    profile.WindowHeight = UserProfile.Current.WindowHeight;
                }
                await profileController.SaveProfileByNameAsync(name, profile);
                if (CurrentProfileName == name && !keepInheritedTarget)
                {
                    UserProfile.Current.TargetWindow = profile.TargetWindow;
                    UserProfile.Current.UseRelativeCoordinates = relativeCoordinates;
                    UserProfile.Current.BringToFocus = bringToFocus;
                    UserProfile.Current.RestorePosition = restorePosition;
                    UserProfile.Current.RestoreSize = restoreSize;
                    HasUnsavedChanges = false;
                }
                await profileController.RefreshProfileListAsync(true);
                InputHookManager.RegisterProfileWindowTargets(profileController.GetProfileWindowTargets(), profileController.GetBringToFocusProfiles());
                PushProfilesUpdate();

                // "Apply target & convert" — the target-config dialog passes convertDirection
                // when the user opts to migrate stored action coords as part of saving the
                // target. Runs HERE, after the save + refresh have settled, using the rect we
                // captured in the pre-flight above. Going through the WithRect variant (instead
                // of letting ExecuteConvertCoordinates re-resolve the target) makes the whole
                // combined op atomic — the window can close between save and conversion and we
                // still apply the correct translation, because the geometry is already cached.
                if (CurrentProfileName == name && convertDirection != null && preflightRect.HasValue)
                {
                    ExecuteConvertCoordinatesWithRect(convertDirection, preflightRect.Value);
                    // Tell the dialog the combined op landed cleanly so it can dismiss the
                    // migration hint and clear its `edited` flag. Without this the dialog
                    // would stay open (per opts.keepOpen) but still showing the hint —
                    // clicking "Apply target & convert" a second time would re-translate
                    // the already-relative coords, doubling the offset.
                    SendMessage("windowTarget:applyConvertCompleted", new { });
                }
            }
        }

        private async void HandleProfileRemoveWindowTarget(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            // After removing, effective target becomes folder target or null (global)
            var folder = profileController.GetProfileOrder().Folders.FirstOrDefault(f => f.Items.Contains(name));
            WindowTarget? newEffectiveTarget = folder?.TargetWindow;
            if (newEffectiveTarget != null && string.IsNullOrEmpty(newEffectiveTarget.ProcessName) && string.IsNullOrEmpty(newEffectiveTarget.WindowTitle))
                newEffectiveTarget = null;

            var entry = profileController.ProfileEntries.FirstOrDefault(e => e.Name == name);
            if (entry != null)
            {
                if (!string.IsNullOrEmpty(entry.Hotkey))
                {
                    var conflict = GetHotkeyConflict(entry.Hotkey, excludeSettingKey: null, excludeProfileName: name, effectiveTarget: newEffectiveTarget);
                    if (conflict != null)
                    {
                        SendMessage("alert:show", new { message = $"Cannot remove target: hotkey \"{entry.Hotkey}\" would conflict with {conflict}." });
                        return;
                    }
                }
                if (!string.IsNullOrEmpty(entry.Hotstring))
                {
                    var conflict = GetHotstringConflict(entry.Hotstring, excludeProfileName: name, effectiveTarget: newEffectiveTarget);
                    if (conflict != null)
                    {
                        SendMessage("alert:show", new { message = $"Cannot remove target: hotstring \"{entry.Hotstring}\" would conflict with {conflict}." });
                        return;
                    }
                }
            }

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile != null)
            {
                profile.TargetWindow = null;
                profile.UseRelativeCoordinates = false;
                profile.BringToFocus = false;
                profile.RestorePosition = false;
                profile.RestoreSize = false;
                profile.WindowX = 0;
                profile.WindowY = 0;
                profile.WindowWidth = 0;
                profile.WindowHeight = 0;
                await profileController.SaveProfileByNameAsync(name, profile);
                if (CurrentProfileName == name)
                    ResetCurrentProfileWindowContext();
                await profileController.RefreshProfileListAsync(true);
                InputHookManager.RegisterProfileWindowTargets(profileController.GetProfileWindowTargets(), profileController.GetBringToFocusProfiles());
                PushProfilesUpdate();
                // Confirm to the frontend that the removal actually happened. Without this
                // signal the frontend can't tell "blocked by hotkey conflict" (we return
                // early above with an alert) from "removed successfully" — and was firing
                // an optimistic "Removed target" toast either way.
                SendMessage("profile:windowTargetRemoved", new { name });
            }
        }

        private void HandleConvertCoordinates(JsonElement payload)
        {
            string direction = payload.GetProperty("direction").GetString() ?? "toRelative";
            ExecuteConvertCoordinates(direction);
        }

        /// <summary>
        /// Coordinate conversion entry point that resolves the target window itself.
        /// Used by the standalone <see cref="HandleConvertCoordinates"/> path (when the
        /// dialog has no edits to apply, or when the conversion is triggered outside the
        /// dialog). The combined "Apply target &amp; convert" flow goes through
        /// <see cref="ExecuteConvertCoordinatesWithRect"/> with a pre-flighted rect so
        /// it doesn't re-do the FindWindow that the caller already performed.
        /// </summary>
        private void ExecuteConvertCoordinates(string direction)
        {
            // Use effective target (profile's own > folder-inherited)
            var target = CurrentProfileName != "No Profile"
                ? profileController.GetEffectiveWindowTarget(CurrentProfileName)
                : UserProfile.Current.TargetWindow;
            if (target == null || (string.IsNullOrEmpty(target.ProcessName) && string.IsNullOrEmpty(target.WindowTitle)))
            {
                SendMessage("alert:show", new { message = "Set a Window Target first (profile or folder)." });
                return;
            }

            // Minimised is refused rather than degraded because the loop in
            // ExecuteConvertCoordinatesWithRect would shift EVERY click, WaitImage region and
            // WaitPixel coord in this profile by ~32000 px on a parking rect — a whole-profile
            // corruption reported as "Converted N action(s)", with only the undo stack standing
            // between the user and permanent damage. Same call the position pick makes.
            var convertStatus = TryGetWindowRect(target, out var rect);
            if (convertStatus != WindowRectStatus.Ok)
            {
                SendMessage("alert:show", new
                {
                    message = convertStatus switch
                    {
                        WindowRectStatus.NotFound => "Target window not found. Make sure it is open and visible.",
                        WindowRectStatus.Minimised => "Target window is minimised. Restore it and convert again.",
                        _ => "Could not get window position.",
                    }
                });
                return;
            }

            ExecuteConvertCoordinatesWithRect(direction, rect);
        }

        /// <summary>
        /// Performs the actual coord translation against a pre-resolved window rect. Split
        /// from <see cref="ExecuteConvertCoordinates"/> so the "Apply target &amp; convert"
        /// flow can pre-flight the FindWindow + GetWindowRect BEFORE the target save runs:
        ///  - If the window can't be found, the dialog's combined operation aborts atomically
        ///    (nothing saved, user sees a clear error, no half-applied state).
        ///  - If it can be found, the rect is captured and passed here AFTER the save, so a
        ///    window closing in the tiny window between save and conversion doesn't leave the
        ///    profile with mismatched flag + action coords.
        /// </summary>
        private void ExecuteConvertCoordinatesWithRect(string direction, NativeMethods.RECT rect)
        {
            if (actions.Count == 0)
            {
                SendMessage("alert:show", new { message = "No actions to convert." });
                return;
            }

            // Resolved once — the geometry write at the bottom of this method reuses it.
            string? inheritedFolder = CurrentProfileName != "No Profile"
                ? profileController.GetInheritedTargetFolderName(CurrentProfileName)
                : null;

            // A profile that inherits its target from a folder inherits the COORDINATE SPACE too:
            // GetEffectiveRelativeCoordinates returns the FOLDER's flag for it, and every fire path
            // re-derives that value. So the UseRelativeCoordinates write further down is DISCARDED
            // at the next fire while the coordinate rewrite above it is PERMANENT — the actions get
            // translated into one space and then executed in the other, every click off by the
            // window origin, with a success toast and no error anywhere. Refuse that.
            //
            // Only the DISAGREEING direction is refused, and NOT because agreement proves the
            // coordinates were in the wrong space. Nothing on disk records which space they are in —
            // the same reason GetEffectiveGeometry ignores a targetless profile's own rect. All
            // agreement proves is that this operation cannot leave the flag and the coordinates
            // pointing at different spaces, which is the defect being closed here. Converting twice
            // still doubles the offset, exactly as it does for a profile with its own target; that
            // footgun is not inheritance-specific and is deliberately left alone.
            //
            // Refusing BOTH directions was rejected: the agreeing one is the only in-app repair for
            // the two states that legitimately need one — a folder whose Relative Coordinates flag
            // was flipped after its members were recorded, and a profile whose own target was
            // dropped by HandleProfileRemoveWindowTarget (which resets the flags and never touches
            // the actions). The folder-scope dialog offers no conversion at all, so those users
            // would be stranded with no way back.
            //
            // Placed AFTER the actions.Count check so an empty profile still gets the specific
            // "No actions to convert.", and BEFORE PushUndoState so a refusal neither pushes an undo
            // entry nor clears the redo stack. This guard is live on the standalone convert only:
            // "Apply target & convert" gives the profile its own target and calls
            // RefreshProfileListAsync before it reaches here, so by then it reads as owning one.
            if (inheritedFolder is string ownerFolder
                && profileController.GetEffectiveRelativeCoordinates(CurrentProfileName) != (direction == "toRelative"))
            {
                SendMessage("alert:show", new { message = $"\"{CurrentProfileName}\" inherits its window target from the folder \"{ownerFolder}\", so it inherits the coordinate space too — this conversion would be discarded at the next replay and leave the coordinates in the wrong space. Give this profile its own target first: edit the process name or window title in its Window Target dialog, then use \"Apply target & convert\"." });
                return;
            }

            PushUndoState();

            var clickTypes = new HashSet<string> { "LeftClickDown", "LeftClickUp", "RightClickDown", "RightClickUp", "MiddleClickDown", "MiddleClickUp", "LeftClick", "RightClick", "MiddleClick", "DoubleClick" };
            int converted = 0;

            // Sign of the translation: subtract window origin to go absolute→relative,
            // add to go the other way. Single sign variable avoids duplicating the loop body.
            int sign = direction == "toRelative" ? -1 : +1;

            foreach (var action in actions)
            {
                if (clickTypes.Contains(action.ActionType))
                {
                    action.X += sign * rect.Left;
                    action.Y += sign * rect.Top;
                    converted++;
                }
                // WaitImage (and IF Image with a search region): only translate when W/H
                // are set. The X/Y fields are meaningless without W/H — leaving them at 0
                // lets the action fall back to a full-screen scan (existing behaviour).
                else if ((action.ActionType == "WaitImage"
                          || (IsConditionOpenerRow(action) && string.Equals(action.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase)))
                    && action.WaitImageSearchW is int w && action.WaitImageSearchH is int h
                    && w > 0 && h > 0)
                {
                    action.WaitImageSearchX = (action.WaitImageSearchX ?? 0) + sign * rect.Left;
                    action.WaitImageSearchY = (action.WaitImageSearchY ?? 0) + sign * rect.Top;
                    converted++;
                }
                // WaitPixelColor (and IF Pixel): PixelX/Y are nullable but required for the
                // action to do anything — only convert when both are present.
                else if ((action.ActionType == "WaitPixelColor"
                          || (IsConditionOpenerRow(action) && string.Equals(action.ConditionType, "PixelColorMatch", StringComparison.OrdinalIgnoreCase)))
                    && action.PixelX.HasValue && action.PixelY.HasValue)
                {
                    action.PixelX = action.PixelX.Value + sign * rect.Left;
                    action.PixelY = action.PixelY.Value + sign * rect.Top;
                    converted++;
                }
            }

            // NOT skipped while inheriting, on purpose. The guard above means this write can only
            // be setting the value the folder already holds, so it is a no-op when
            // UserProfile.Current is in sync and a REPAIR when it drifted — and it does drift:
            // removing a profile's own target forces this to false without re-stamping the newly
            // effective folder value. Two consumers read this field DIRECTLY rather than through
            // GetEffectiveRelativeCoordinates — the recorder (seeded from it in StartRecording) and
            // TryGetRelativeCaptureOffset for WaitImage / WaitPixel captures — so a stale false here
            // silently records the NEXT click in absolute coords into a list replayed as relative.
            // "Dormant while inheriting" is true of the fire paths only; it is false for recording.
            UserProfile.Current.UseRelativeCoordinates = direction == "toRelative";
            // toRelative stamps the reference rect — the window as it stood when the coordinates
            // were measured against it. It used to write WIDTH/HEIGHT only and leave X/Y at
            // whatever they held, which on a profile that never captured a position is 0,0. That
            // half-write is where "1444x1024 @ 0,0" profiles come from: a folder's inherited
            // Restore Position then moved the target window to the screen corner. Write all four.
            // toAbsolute keeps its X/Y — absolute coordinates are only valid with the window back
            // at the position they were measured from, so that restore must survive — and clears
            // the size, as before.
            //
            // The stamp is SKIPPED while the profile inherits its target from a folder. Its own four
            // numbers are ignored by GetEffectiveGeometry precisely because nothing tells a
            // deliberate capture from a leftover, so stamping here plants exactly the residual rect
            // that rule exists to neutralise: dormant today, LIVE the moment the profile is later
            // given its own target (Set Target even copies it forward on purpose). Only the
            // toRelative branch is skipped — toAbsolute CLEARS residue instead of planting it, so
            // skipping that one could only ever leave more behind than today.
            if (direction == "toRelative")
            {
                if (inheritedFolder == null)
                {
                    UserProfile.Current.WindowX = rect.Left;
                    UserProfile.Current.WindowY = rect.Top;
                    UserProfile.Current.WindowWidth = rect.Right - rect.Left;
                    UserProfile.Current.WindowHeight = rect.Bottom - rect.Top;
                }
            }
            else
            {
                UserProfile.Current.WindowWidth = 0;
                UserProfile.Current.WindowHeight = 0;
            }

            HasUnsavedChanges = true;
            PushActionsUpdate();
            SendMessage("alert:show", new { message = $"Converted {converted} action(s) to {(direction == "toRelative" ? "relative" : "absolute")} coordinates." });
        }

        private async void HandleUpdateWindowSize(JsonElement payload)
        {
            // Optional overrides from the Window Target dialog so the user can capture geometry
            // BEFORE clicking "Set Target" — enabling a single-pass configuration flow (detect
            // window → capture geometry → toggle flags → Set Target) instead of having to save,
            // reopen, update, and save again.
            string? dialogProcess = null, dialogTitle = null, dialogMatchMode = null;
            string? targetProfileName = null;
            string? targetFolderName = null;
            if (payload.ValueKind == JsonValueKind.Object)
            {
                if (payload.TryGetProperty("processName", out var pnEl) && pnEl.ValueKind == JsonValueKind.String)
                    dialogProcess = pnEl.GetString();
                if (payload.TryGetProperty("windowTitle", out var wtEl) && wtEl.ValueKind == JsonValueKind.String)
                    dialogTitle = wtEl.GetString();
                if (payload.TryGetProperty("titleMatchMode", out var mmEl) && mmEl.ValueKind == JsonValueKind.String)
                    dialogMatchMode = mmEl.GetString();
                if (payload.TryGetProperty("name", out var nEl) && nEl.ValueKind == JsonValueKind.String)
                    targetProfileName = nEl.GetString();
                if (payload.TryGetProperty("folderName", out var fnEl) && fnEl.ValueKind == JsonValueKind.String)
                    targetFolderName = fnEl.GetString();
            }

            WindowTarget? target;
            bool haveDialogTarget = !string.IsNullOrWhiteSpace(dialogProcess) || !string.IsNullOrWhiteSpace(dialogTitle);

            // A profile that inherits its target from a folder inherits the folder's GEOMETRY too —
            // GetEffectiveGeometry ignores its own rect on purpose, because nothing on disk tells a
            // deliberate capture from a leftover. Capturing here would write to disk, toast success
            // and change nothing, so refuse and say where it belongs.
            //
            // "The payload carries a target" is NOT the exception to make here: the dialog PREFILLS
            // an inheriting profile's process/title FROM THE FOLDER, and its Update button is
            // disabled while both fields are blank — so every reachable profile-scope payload
            // carries one, and gating on that made this guard dead code. The real question is
            // whether the payload describes a DIFFERENT target from the inherited one. That is the
            // documented capture-before-Set-Target flow, where the profile is about to own the rect.
            if (string.IsNullOrEmpty(targetFolderName))
            {
                var scopeName = !string.IsNullOrEmpty(targetProfileName) ? targetProfileName : CurrentProfileName;
                if (!string.IsNullOrEmpty(scopeName) && scopeName != "No Profile"
                    && profileController.GetInheritedTargetFolderName(scopeName) is string ownerFolder)
                {
                    var inherited = profileController.GetEffectiveWindowTarget(scopeName);
                    bool definesOwnTarget = haveDialogTarget && inherited != null && !(
                        string.Equals((dialogProcess ?? string.Empty).Trim(), inherited.ProcessName ?? string.Empty, StringComparison.OrdinalIgnoreCase)
                        && string.Equals((dialogTitle ?? string.Empty).Trim(), inherited.WindowTitle ?? string.Empty, StringComparison.Ordinal)
                        && string.Equals(string.IsNullOrWhiteSpace(dialogMatchMode) ? "contains" : dialogMatchMode, inherited.TitleMatchMode, StringComparison.OrdinalIgnoreCase));
                    if (!definesOwnTarget)
                    {
                        SendMessage("alert:show", new { message = $"\"{scopeName}\" inherits its window target from the folder \"{ownerFolder}\", so it inherits the geometry too. Capture it on the folder, or give this profile its own target first." });
                        return;
                    }
                }
            }

            // Resolve which target definition to search for:
            // - If the dialog supplied process/title, use those (allows capture before Set Target).
            // - Otherwise fall back to the saved effective target of the active profile.
            if (haveDialogTarget)
            {
                target = new WindowTarget
                {
                    ProcessName = string.IsNullOrWhiteSpace(dialogProcess) ? null : dialogProcess!.Trim(),
                    WindowTitle = string.IsNullOrWhiteSpace(dialogTitle) ? null : dialogTitle!.Trim(),
                    TitleMatchMode = string.IsNullOrWhiteSpace(dialogMatchMode) ? "contains" : dialogMatchMode!
                };
            }
            else if (!string.IsNullOrEmpty(targetFolderName))
            {
                var folder = profileController.GetProfileOrder().Folders.FirstOrDefault(f => f.Name == targetFolderName);
                target = folder?.TargetWindow;
            }
            else
            {
                target = CurrentProfileName != "No Profile"
                    ? profileController.GetEffectiveWindowTarget(CurrentProfileName)
                    : UserProfile.Current.TargetWindow;
            }

            if (target == null || (string.IsNullOrEmpty(target.ProcessName) && string.IsNullOrEmpty(target.WindowTitle)))
            {
                SendMessage("alert:show", new { message = "Detect or set a Window Target first, then click Update." });
                return;
            }

            // Minimised matters more here than anywhere else TryGetWindowRect is called: this rect
            // is WRITTEN TO DISK as the profile's / folder's restore geometry, so a capture taken
            // while the target was parked makes every later replay push the window off-screen —
            // and absolute coordinates, which depend on the window coming back to where they were
            // measured, stop landing anywhere real. Refuse rather than capture garbage.
            var geometryStatus = TryGetWindowRect(target, out var rect);
            if (geometryStatus != WindowRectStatus.Ok)
            {
                SendMessage("alert:show", new
                {
                    message = geometryStatus switch
                    {
                        WindowRectStatus.NotFound => "Target window not found. Make sure it is open and visible.",
                        WindowRectStatus.Minimised => "Target window is minimised. Restore it to the size and position you want captured, then click Update again.",
                        _ => "Could not get window dimensions.",
                    }
                });
                return;
            }

            int w = rect.Right - rect.Left;
            int hgt = rect.Bottom - rect.Top;

            // Folder geometry takes priority when folderName is provided. Otherwise resolve the
            // profile to save into: explicit name from the dialog, or the active profile.
            if (!string.IsNullOrEmpty(targetFolderName))
            {
                await profileController.SetFolderGeometryAsync(targetFolderName, rect.Left, rect.Top, w, hgt);
                PushProfilesUpdate();
                SendMessage("alert:show", new { message = $"Folder geometry captured: {w}×{hgt} @ ({rect.Left}, {rect.Top})" });
                return;
            }

            string saveName = !string.IsNullOrEmpty(targetProfileName) ? targetProfileName : CurrentProfileName;

            if (saveName == CurrentProfileName && CurrentProfileName != "No Profile")
            {
                UserProfile.Current.WindowWidth = w;
                UserProfile.Current.WindowHeight = hgt;
                UserProfile.Current.WindowX = rect.Left;
                UserProfile.Current.WindowY = rect.Top;
            }

            // Persist to disk so geometry survives even without hitting Set Target afterwards
            if (!string.IsNullOrEmpty(saveName) && saveName != "No Profile")
            {
                var profile = await profileController.LoadProfileByNameAsync(saveName);
                if (profile != null)
                {
                    profile.WindowWidth = w;
                    profile.WindowHeight = hgt;
                    profile.WindowX = rect.Left;
                    profile.WindowY = rect.Top;
                    await profileController.SaveProfileByNameAsync(saveName, profile);
                }
            }
            else
            {
                HasUnsavedChanges = true;
            }
            SendMessage("alert:show", new { message = $"Window geometry captured: {w}×{hgt} @ ({rect.Left}, {rect.Top})" });
        }

        private async void HandleProfileSetRestorePosition(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            if (string.IsNullOrEmpty(name)) return;

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile == null) return;

            profile.RestorePosition = enabled;
            await profileController.SaveProfileByNameAsync(name, profile);
            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
            if (entry != null) entry.RestorePosition = enabled;
            if (CurrentProfileName == name)
                UserProfile.Current.RestorePosition = enabled;
            PushProfilesUpdate();
        }

        private async void HandleProfileSetRestoreSize(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            if (string.IsNullOrEmpty(name)) return;

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile == null) return;

            profile.RestoreSize = enabled;
            await profileController.SaveProfileByNameAsync(name, profile);
            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
            if (entry != null) entry.RestoreSize = enabled;
            if (CurrentProfileName == name)
                UserProfile.Current.RestoreSize = enabled;
            PushProfilesUpdate();
        }

        private async void HandleProfileSetTriggerMode(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            string modeStr = payload.GetProperty("mode").GetString() ?? "onPress";
            if (string.IsNullOrEmpty(name)) return;

            var mode = TriggerModeFromString(modeStr);
            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile == null) return;

            profile.TriggerMode = mode;
            await profileController.SaveProfileByNameAsync(name, profile);
            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
            if (entry != null) entry.TriggerMode = mode;
            if (CurrentProfileName == name)
                UserProfile.Current.TriggerMode = mode;

            // Re-register so the hook sees the new mode immediately
            InputHookManager.RegisterProfileTriggerModes(profileController.GetProfileTriggerModes());
            PushProfilesUpdate();
        }

        private async void HandleSetRelativeCoordinates(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            if (string.IsNullOrEmpty(name)) return;

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile != null)
            {
                profile.UseRelativeCoordinates = enabled;
                await profileController.SaveProfileByNameAsync(name, profile);
                // Update cached entry directly (avoid RefreshProfileListAsync which resets IsActive)
                var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
                if (entry != null) entry.UseRelativeCoordinates = enabled;
                if (CurrentProfileName == name)
                    UserProfile.Current.UseRelativeCoordinates = enabled;
                PushProfilesUpdate();
            }
        }

        private async void HandleSetBringToFocus(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            if (string.IsNullOrEmpty(name)) return;

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile != null)
            {
                profile.BringToFocus = enabled;
                await profileController.SaveProfileByNameAsync(name, profile);
                var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
                if (entry != null) entry.BringToFocus = enabled;
                if (CurrentProfileName == name)
                    UserProfile.Current.BringToFocus = enabled;
                // Re-register so IsForegroundWindowMatch skips check for bring-to-focus profiles
                InputHookManager.RegisterProfileWindowTargets(profileController.GetProfileWindowTargets(), profileController.GetBringToFocusProfiles());
                PushProfilesUpdate();
            }
        }

        private async void HandleSetFolderWindowTarget(JsonElement payload)
        {
            string folderName = payload.GetProperty("folderName").GetString() ?? "";
            string processName = payload.GetProperty("processName").GetString() ?? "";
            string windowTitle = payload.GetProperty("windowTitle").GetString() ?? "";
            string titleMatchMode = payload.TryGetProperty("titleMatchMode", out var tm)
                ? tm.GetString() ?? "contains" : "contains";
            bool relativeCoordinates = payload.TryGetProperty("relativeCoordinates", out var rcProp) && rcProp.GetBoolean();
            bool bringToFocus = payload.TryGetProperty("bringToFocus", out var btfProp) && btfProp.GetBoolean();
            bool restorePosition = payload.TryGetProperty("restorePosition", out var rpProp) && rpProp.GetBoolean();
            bool restoreSize = payload.TryGetProperty("restoreSize", out var rsProp) && rsProp.GetBoolean();

            if (string.IsNullOrEmpty(folderName)) return;

            if (string.IsNullOrWhiteSpace(processName) && string.IsNullOrWhiteSpace(windowTitle))
            {
                SendMessage("alert:show", new { message = "Please specify at least a process name or window title." });
                return;
            }

            if (titleMatchMode == "regex" && !string.IsNullOrWhiteSpace(windowTitle))
            {
                try { _ = new System.Text.RegularExpressions.Regex(windowTitle.Trim()); }
                catch { SendMessage("alert:show", new { message = "Invalid regex pattern." }); return; }
            }

            await profileController.SetFolderWindowTargetAsync(folderName, new WindowTarget
            {
                ProcessName = string.IsNullOrWhiteSpace(processName) ? null : processName.Trim(),
                WindowTitle = string.IsNullOrWhiteSpace(windowTitle) ? null : windowTitle.Trim(),
                TitleMatchMode = titleMatchMode
            }, relativeCoordinates, bringToFocus, restorePosition, restoreSize);
            InputHookManager.RegisterProfileWindowTargets(profileController.GetProfileWindowTargets(), profileController.GetBringToFocusProfiles());
            PushProfilesUpdate();
        }

        private async void HandleRemoveFolderWindowTarget(JsonElement payload)
        {
            string folderName = payload.GetProperty("folderName").GetString() ?? "";
            if (string.IsNullOrEmpty(folderName)) return;

            // Check all profiles in this folder — removing folder target makes them global (if no own target)
            var folder = profileController.GetProfileOrder().Folders.FirstOrDefault(f => f.Name == folderName);
            if (folder != null)
            {
                foreach (var profileName in folder.Items)
                {
                    // Skip profiles that have their own target (they won't be affected)
                    var ownTarget = profileController.ProfileEntries.FirstOrDefault(e => e.Name == profileName);
                    if (ownTarget?.HasWindowTarget == true) continue;

                    var entry = profileController.ProfileEntries.FirstOrDefault(e => e.Name == profileName);
                    if (entry == null) continue;

                    if (!string.IsNullOrEmpty(entry.Hotkey))
                    {
                        var conflict = GetHotkeyConflict(entry.Hotkey, excludeSettingKey: null, excludeProfileName: profileName, effectiveTarget: null);
                        if (conflict != null)
                        {
                            SendMessage("alert:show", new { message = $"Cannot remove folder target: hotkey \"{entry.Hotkey}\" on \"{profileName}\" would conflict with {conflict}." });
                            return;
                        }
                    }
                    if (!string.IsNullOrEmpty(entry.Hotstring))
                    {
                        var conflict = GetHotstringConflict(entry.Hotstring, excludeProfileName: profileName, effectiveTarget: null);
                        if (conflict != null)
                        {
                            SendMessage("alert:show", new { message = $"Cannot remove folder target: hotstring \"{entry.Hotstring}\" on \"{profileName}\" would conflict with {conflict}." });
                            return;
                        }
                    }
                }
            }

            await profileController.RemoveFolderWindowTargetAsync(folderName);
            // Reset effective values on active profile if it was inheriting from this folder
            if (folder != null && CurrentProfileName != "No Profile" && folder.Items.Contains(CurrentProfileName))
            {
                var ownTarget = profileController.ProfileEntries.FirstOrDefault(e => e.Name == CurrentProfileName);
                if (ownTarget != null && !ownTarget.HasWindowTarget)
                {
                    UserProfile.Current.UseRelativeCoordinates = false;
                    UserProfile.Current.BringToFocus = false;
                }
            }
            InputHookManager.RegisterProfileWindowTargets(profileController.GetProfileWindowTargets(), profileController.GetBringToFocusProfiles());
            PushProfilesUpdate();
        }

        // Window detection state
        private IntPtr _detectMouseHook = IntPtr.Zero;
        private NativeMethods.LowLevelMouseProc? _detectMouseProc;
        private bool _isDetectingWindow = false;

        private void HandleProfileDetectWindow()
        {
            if (_isDetectingWindow)
            {
                // Already detecting — stop
                StopWindowDetection();
                return;
            }

            _isDetectingWindow = true;
            SendMessage("windowTarget:detectState", new { detecting = true });

            _detectMouseProc = DetectMouseHookCallback;
            _detectMouseHook = NativeMethods.SetMouseHook(_detectMouseProc);
        }

        private IntPtr DetectMouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && wParam == (IntPtr)NativeMethods.WM_LBUTTONDOWN)
            {
                var hookStruct = System.Runtime.InteropServices.Marshal.PtrToStructure<NativeMethods.MSLLHOOKSTRUCT>(lParam);

                // Get the top-level window at the click point
                IntPtr childHwnd = NativeMethods.WindowFromPoint(hookStruct.pt);
                IntPtr hwnd = childHwnd != IntPtr.Zero
                    ? NativeMethods.GetAncestor(childHwnd, NativeMethods.GA_ROOT)
                    : IntPtr.Zero;

                // Ignore clicks on our own window
                IntPtr ownHwnd = IntPtr.Zero;
                try
                {
                    ownHwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"[Bridge] GetWindowHandle failed: {ex.Message}");
                }

                if (hwnd != IntPtr.Zero && hwnd != ownHwnd)
                {
                    // Extract window info
                    var titleBuffer = new System.Text.StringBuilder(512);
                    NativeMethods.GetWindowText(hwnd, titleBuffer, titleBuffer.Capacity);
                    string windowTitle = titleBuffer.ToString();

                    string processName = "";
                    NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
                    IntPtr hProcess = NativeMethods.OpenProcess(
                        NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);

                    if (hProcess != IntPtr.Zero)
                    {
                        try
                        {
                            var nameBuffer = new System.Text.StringBuilder(512);
                            uint len = NativeMethods.GetProcessImageFileName(
                                hProcess, nameBuffer, (uint)nameBuffer.Capacity);
                            if (len > 0)
                            {
                                string fullPath = nameBuffer.ToString();
                                processName = fullPath.Substring(fullPath.LastIndexOf('\\') + 1);
                            }
                        }
                        finally
                        {
                            NativeMethods.CloseHandle(hProcess);
                        }
                    }

                    // Stop detection and send result
                    StopWindowDetection();

                    dispatcherQueue.TryEnqueue(() =>
                    {
                        SendMessage("windowTarget:detected", new { processName, windowTitle });
                    });

                    // Swallow the click so the target app doesn't receive it
                    return (IntPtr)1;
                }
            }

            return NativeMethods.CallNextHookEx(_detectMouseHook, nCode, wParam, lParam);
        }

        private void StopWindowDetection()
        {
            _isDetectingWindow = false;
            if (_detectMouseHook != IntPtr.Zero)
            {
                NativeMethods.UnhookWindowsHookEx(_detectMouseHook);
                _detectMouseHook = IntPtr.Zero;
            }
            _detectMouseProc = null;

            dispatcherQueue.TryEnqueue(() =>
            {
                SendMessage("windowTarget:detectState", new { detecting = false });
            });
        }

        /// <summary>
        /// Test whether a candidate target (process / title / mode) matches the foreground
        /// window the user is looking at. The TR window itself is excluded (the dialog is
        /// modal, so foreground would otherwise always be us). Result is sent back via
        /// <c>windowTarget:testResult</c> for inline display in the dialog.
        /// </summary>
        private void HandleTestWindowMatch(JsonElement payload)
        {
            string processName = payload.TryGetProperty("processName", out var pProp) ? pProp.GetString() ?? "" : "";
            string windowTitle = payload.TryGetProperty("windowTitle", out var tProp) ? tProp.GetString() ?? "" : "";
            string titleMatchMode = payload.TryGetProperty("titleMatchMode", out var mProp) ? mProp.GetString() ?? "contains" : "contains";

            if (string.IsNullOrWhiteSpace(processName) && string.IsNullOrWhiteSpace(windowTitle))
            {
                SendMessage("windowTarget:testResult", new {
                    matches = false,
                    error = "Fill at least one of Process Name or Window Title to test.",
                    foregroundProcess = "",
                    foregroundTitle = ""
                });
                return;
            }

            var target = new WindowTarget
            {
                ProcessName = string.IsNullOrWhiteSpace(processName) ? null : processName.Trim(),
                WindowTitle = string.IsNullOrWhiteSpace(windowTitle) ? null : windowTitle.Trim(),
                TitleMatchMode = titleMatchMode
            };

            var compiledRegex = TrueReplayer.Helpers.WindowMatcher.CompileTitleRegex(target);
            if (titleMatchMode == "regex" && !string.IsNullOrWhiteSpace(windowTitle) && compiledRegex == null)
            {
                SendMessage("windowTarget:testResult", new {
                    matches = false,
                    error = "Invalid regex pattern.",
                    foregroundProcess = "",
                    foregroundTitle = ""
                });
                return;
            }

            // Pick the foreground window — but skip our own (the dialog is modal so foreground
            // is us). If the apparent foreground IS us, walk the z-order via EnumWindows and
            // take the first visible top-level with a title that isn't ours.
            IntPtr ownHwnd = IntPtr.Zero;
            try { ownHwnd = WinRT.Interop.WindowNative.GetWindowHandle(window); } catch { }

            IntPtr hwnd = NativeMethods.GetForegroundWindow();
            if (hwnd == IntPtr.Zero || hwnd == ownHwnd)
            {
                IntPtr alt = IntPtr.Zero;
                NativeMethods.EnumWindows((h, _) =>
                {
                    if (h == ownHwnd) return true;
                    if (!NativeMethods.IsWindowVisible(h)) return true;
                    var titleSb = new System.Text.StringBuilder(8);
                    NativeMethods.GetWindowText(h, titleSb, titleSb.Capacity);
                    if (titleSb.Length == 0) return true;  // skip system/utility windows
                    alt = h;
                    return false;
                }, IntPtr.Zero);
                hwnd = alt;
            }

            if (hwnd == IntPtr.Zero)
            {
                SendMessage("windowTarget:testResult", new {
                    matches = false,
                    error = "No foreground window detected.",
                    foregroundProcess = "",
                    foregroundTitle = ""
                });
                return;
            }

            // Capture identity of whatever we're testing against, so the UI can show what was sampled.
            var titleBuf = new System.Text.StringBuilder(512);
            NativeMethods.GetWindowText(hwnd, titleBuf, titleBuf.Capacity);
            string fgTitle = titleBuf.ToString();

            string fgProcess = "";
            NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
            IntPtr hp = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (hp != IntPtr.Zero)
            {
                try
                {
                    var pnSb = new System.Text.StringBuilder(512);
                    uint len = NativeMethods.GetProcessImageFileName(hp, pnSb, (uint)pnSb.Capacity);
                    if (len > 0)
                    {
                        string full = pnSb.ToString();
                        fgProcess = full.Substring(full.LastIndexOf('\\') + 1);
                    }
                }
                finally { NativeMethods.CloseHandle(hp); }
            }

            bool matches = TrueReplayer.Helpers.WindowMatcher.Matches(hwnd, target, compiledRegex);

            SendMessage("windowTarget:testResult", new {
                matches,
                foregroundProcess = fgProcess,
                foregroundTitle = fgTitle
            });
        }

        /// <summary>
        /// Exists-ANYWHERE window probe for the ActivateWindow Sheet editor's Test button —
        /// unlike <c>profile:testWindowMatch</c> (foreground-only, the Target dialog's
        /// semantics), this answers "would ActivateWindow find this window right now?".
        /// Uses the same matcher builder + self-exclusion as the action's execution path,
        /// and carries a requestId so a Sheet-hosted consumer can pair replies (the legacy
        /// pair relies on being the dialog's sole consumer).
        /// </summary>
        // Opens a native file picker for the ActivateWindow "Launch" field and hands the chosen
        // path back to the frontend (null path = cancelled). Lets the user pick a program instead
        // of typing a bare exe name that ShellExecute can't resolve.
        private async void HandleDialogPickFile(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var rp) ? rp.GetString() ?? "" : "";
            string? path;
            try { path = await profileController.PickExecutableFileAsync(); }
            catch (Exception ex) { DiagnosticLog.Info($"[dialog:pickFile] {ex.Message}"); path = null; }
            SendMessage("dialog:pickFileResult", new { requestId, path });
        }

        // Reads the CURRENT on-screen rect of the window matching the action's matcher, so the
        // ActivateWindow editor can seed its placement fields from a window the user already
        // positioned by hand. Mirrors HandleWindowTestProbe's matcher resolution; unlike the
        // profile-level geometry capture this writes nothing — the frontend persists the values
        // through the normal actions:edit path.
        private void HandleWindowCaptureGeometry(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var rq) ? rq.GetString() ?? "" : "";
            string processName = payload.TryGetProperty("processName", out var pn) ? pn.GetString() ?? "" : "";
            string windowTitle = payload.TryGetProperty("windowTitle", out var wt) ? wt.GetString() ?? "" : "";
            string titleMatchMode = payload.TryGetProperty("titleMatchMode", out var tm) ? tm.GetString() ?? "contains" : "contains";

            void Fail(string error) => SendMessage("window:captureGeometryResult",
                new { requestId, found = false, error, x = 0, y = 0, width = 0, height = 0 });

            if (string.IsNullOrWhiteSpace(processName) && string.IsNullOrWhiteSpace(windowTitle))
            {
                Fail("Fill Process Name or Window Title first.");
                return;
            }

            var (target, regex) = TrueReplayer.Services.ActionReplayer.BuildWindowTarget(processName, windowTitle, titleMatchMode);
            if (string.Equals(target.TitleMatchMode, "regex", StringComparison.Ordinal)
                && !string.IsNullOrWhiteSpace(windowTitle) && regex == null)
            {
                Fail("Invalid regex pattern.");
                return;
            }

            IntPtr hwnd = TrueReplayer.Services.ActionReplayer.FindWindowExcludingSelf(target, regex);
            if (hwnd == IntPtr.Zero) { Fail("No window matches — open and position it first."); return; }
            // The fifth resolve-and-rect site, and the one TryGetWindowRect cannot serve: it
            // resolves through FindWindowExcludingSelf (pre-compiled regex, skips TrueReplayer's
            // own window) rather than WindowMatcher.FindWindow. The IsIconic guard still has to be
            // here, for the same reason it is there — a minimised window passes IsWindowVisible and
            // GetWindowRect answers with the (-32000,-32000) parking rect. This rect is written
            // into an ActivateWindow row's geometry, so capturing it minimised makes every later
            // replay park the target off-screen. Refuse and say what to do, like the siblings.
            if (NativeMethods.IsIconic(hwnd)) { Fail("Window is minimised — restore it to the size and position you want captured."); return; }
            if (!NativeMethods.GetWindowRect(hwnd, out var rect)) { Fail("Could not read the window rect."); return; }

            SendMessage("window:captureGeometryResult", new
            {
                requestId,
                found = true,
                x = rect.Left,
                y = rect.Top,
                width = rect.Right - rect.Left,
                height = rect.Bottom - rect.Top,
            });
        }

        private void HandleWindowTestProbe(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var rProp) ? rProp.GetString() ?? "" : "";
            string processName = payload.TryGetProperty("processName", out var pProp) ? pProp.GetString() ?? "" : "";
            string windowTitle = payload.TryGetProperty("windowTitle", out var tProp) ? tProp.GetString() ?? "" : "";
            string titleMatchMode = payload.TryGetProperty("titleMatchMode", out var mProp) ? mProp.GetString() ?? "contains" : "contains";

            if (string.IsNullOrWhiteSpace(processName) && string.IsNullOrWhiteSpace(windowTitle))
            {
                SendMessage("window:testProbeResult", new {
                    requestId,
                    found = false,
                    error = "Fill at least one of Process Name or Window Title to test.",
                    matchProcess = "",
                    matchTitle = ""
                });
                return;
            }

            var (target, regex) = TrueReplayer.Services.ActionReplayer.BuildWindowTarget(processName, windowTitle, titleMatchMode);
            if (string.Equals(target.TitleMatchMode, "regex", StringComparison.Ordinal)
                && !string.IsNullOrWhiteSpace(windowTitle) && regex == null)
            {
                SendMessage("window:testProbeResult", new {
                    requestId,
                    found = false,
                    error = "Invalid regex pattern.",
                    matchProcess = "",
                    matchTitle = ""
                });
                return;
            }

            IntPtr hwnd = TrueReplayer.Services.ActionReplayer.FindWindowExcludingSelf(target, regex);
            if (hwnd == IntPtr.Zero)
            {
                SendMessage("window:testProbeResult", new {
                    requestId,
                    found = false,
                    matchProcess = "",
                    matchTitle = ""
                });
                return;
            }

            // Identify the match so the editor can show "Found — notepad.exe · Untitled".
            var probeTitleBuf = new System.Text.StringBuilder(512);
            NativeMethods.GetWindowText(hwnd, probeTitleBuf, probeTitleBuf.Capacity);
            string matchTitle = probeTitleBuf.ToString();

            string matchProcess = "";
            NativeMethods.GetWindowThreadProcessId(hwnd, out uint probePid);
            IntPtr probeHp = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, probePid);
            if (probeHp != IntPtr.Zero)
            {
                try
                {
                    var pnSb = new System.Text.StringBuilder(512);
                    uint len = NativeMethods.GetProcessImageFileName(probeHp, pnSb, (uint)pnSb.Capacity);
                    if (len > 0)
                    {
                        string full = pnSb.ToString();
                        matchProcess = full.Substring(full.LastIndexOf('\\') + 1);
                    }
                }
                finally { NativeMethods.CloseHandle(probeHp); }
            }

            SendMessage("window:testProbeResult", new {
                requestId,
                found = true,
                matchProcess,
                matchTitle
            });
        }

        /// <summary>
        /// Enumerate top-level visible windows and surface the processes behind them — used by
        /// the dialog's process picker so the user doesn't have to free-text the .exe name. We
        /// walk EnumWindows (not Process.GetProcesses + MainWindowHandle) because some modern
        /// apps (UWP, Electron, Tauri) have MainWindowHandle == 0 even though their window is
        /// visible. Deduplicated by lowercased process name; the first window's title is kept
        /// as a hint so the list shows e.g. "chrome.exe — Inbox - Gmail".
        /// </summary>
        private void HandleProcessList()
        {
            IntPtr ownHwnd = IntPtr.Zero;
            try { ownHwnd = WinRT.Interop.WindowNative.GetWindowHandle(window); } catch { }

            var seen = new Dictionary<string, (string Name, string Title)>(StringComparer.OrdinalIgnoreCase);
            var titleBuf = new System.Text.StringBuilder(512);
            var procBuf = new System.Text.StringBuilder(512);

            NativeMethods.EnumWindows((hwnd, _) =>
            {
                if (hwnd == ownHwnd) return true;
                if (!NativeMethods.IsWindowVisible(hwnd)) return true;

                titleBuf.Clear();
                NativeMethods.GetWindowText(hwnd, titleBuf, titleBuf.Capacity);
                string title = titleBuf.ToString();
                // Skip system/utility windows with no title — they're noise in the picker.
                if (string.IsNullOrWhiteSpace(title)) return true;

                NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
                IntPtr hp = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (hp == IntPtr.Zero) return true;
                try
                {
                    procBuf.Clear();
                    uint len = NativeMethods.GetProcessImageFileName(hp, procBuf, (uint)procBuf.Capacity);
                    if (len == 0) return true;
                    string full = procBuf.ToString();
                    string name = full.Substring(full.LastIndexOf('\\') + 1);
                    if (string.IsNullOrEmpty(name)) return true;
                    if (!seen.ContainsKey(name))
                        seen[name] = (name, title);
                }
                finally { NativeMethods.CloseHandle(hp); }
                return true;
            }, IntPtr.Zero);

            // Sort case-insensitively by process name so the picker is predictable.
            var ordered = seen.Values
                .OrderBy(v => v.Name, StringComparer.OrdinalIgnoreCase)
                .Select(v => new { name = v.Name, title = v.Title })
                .ToArray();

            SendMessage("process:list", new { processes = ordered });
        }

        private void HandleProfileOpenFolder(JsonElement payload)
        {
            // Two modes:
            //   - name present → reveal that profile's .json in Explorer (context-menu path).
            //   - name absent/empty → just open the Profiles folder itself (header button path),
            //     used when the user wants to browse profiles without one being selected.
            string name = payload.TryGetProperty("name", out var nameEl)
                ? (nameEl.GetString() ?? "")
                : "";

            if (!string.IsNullOrEmpty(name))
            {
                var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
                if (entry != null)
                    RevealInExplorer(entry.FilePath, "Could not open the profile folder");
                return;
            }

            // Folder-only mode. Open the Profiles directory; create it first if it's missing
            // (fresh install with no profiles saved yet) so Explorer doesn't pop an error.
            try
            {
                string profileDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                    "TrueReplayer", "Profiles");
                Directory.CreateDirectory(profileDir);
                System.Diagnostics.Process.Start("explorer.exe", $"\"{profileDir}\"");
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error("profile:openFolder failed to open the Profiles directory", ex);
                SendMessage("alert:show", new { message = "Could not open the Profiles folder" });
            }
        }

        // ── Profile Organization Handlers ──

        private async void HandleProfilePin(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;
            await profileController.PinProfileAsync(name);
            PushProfilesUpdate();
        }

        private async void HandleProfileUnpin(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;
            await profileController.UnpinProfileAsync(name);
            PushProfilesUpdate();
        }

        private async void HandleCreateFolder(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            string color = payload.TryGetProperty("color", out var colorProp)
                ? colorProp.GetString() ?? "#60CDFF"
                : "#60CDFF";
            if (string.IsNullOrEmpty(name)) return;
            bool created = await profileController.CreateFolderAsync(name, color);
            if (!created)
            {
                SendMessage("alert:show", new { message = $"A folder named \"{name.Trim()}\" already exists" });
                PushProfilesUpdate(); // re-sync so any optimistic UI state reverts
                return;
            }
            PushProfilesUpdate();
        }

        private async void HandleRenameFolder(JsonElement payload)
        {
            string oldName = payload.GetProperty("oldName").GetString() ?? "";
            string newName = payload.GetProperty("newName").GetString() ?? "";
            if (string.IsNullOrEmpty(oldName) || string.IsNullOrEmpty(newName)) return;
            bool renamed = await profileController.RenameFolderAsync(oldName, newName);
            if (!renamed)
            {
                SendMessage("alert:show", new { message = $"A folder named \"{newName.Trim()}\" already exists" });
                PushProfilesUpdate(); // revert the inline rename back to the stored name
                return;
            }
            PushProfilesUpdate();
        }

        private async void HandleDeleteFolder(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            var order = profileController.GetProfileOrder();
            var folder = order.Folders.FirstOrDefault(f => f.Name == name);
            int profileCount = folder?.Items.Count ?? 0;

            if (profileCount > 0)
            {
                var msgBlock = new Microsoft.UI.Xaml.Controls.TextBlock
                {
                    Text = $"Folder \"{name}\" contains {profileCount} profile(s).\nDelete only the folder or everything inside?",
                    TextWrapping = Microsoft.UI.Xaml.TextWrapping.Wrap
                };
                var dialog = new Microsoft.UI.Xaml.Controls.ContentDialog
                {
                    Title = "Delete Folder",
                    XamlRoot = window.Content.XamlRoot,
                    RequestedTheme = Microsoft.UI.Xaml.ElementTheme.Dark,
                    PrimaryButtonText = "Folder Only",
                    SecondaryButtonText = "Delete All",
                    CloseButtonText = "Cancel",
                    DefaultButton = Microsoft.UI.Xaml.Controls.ContentDialogButton.Primary,
                    CornerRadius = new Microsoft.UI.Xaml.CornerRadius(8),
                    Content = msgBlock
                };
                // Apply current theme — without this, the dialog renders with default WinUI
                // dark-mode chrome (pure black) that clashes with the app's customised palette.
                // Mirrors the pattern used by every other ContentDialog in the codebase.
                profileController.ApplyDialogTheme(dialog, msgBlock);

                // See ModalGate — a second ContentDialog while one is open kills the process.
                // Refusing means the folder is not deleted, which is the right way to fail a
                // destructive action nobody has confirmed.
                // Scoped to the DIALOG, not to the whole handler: the deletion below awaits real
                // I/O (rewriting profile-order, rescanning the profiles folder), and holding the
                // gate across that would block unrelated dialogs for the duration. That used to be
                // stated as two signals disagreeing about the same moment — the gate and the
                // hotkey flag ending at different points; they are now one signal that ends here.
                Microsoft.UI.Xaml.Controls.ContentDialogResult result;
                using (var gate = Services.ModalGate.TryEnter("delete folder"))
                {
                    if (gate == null) return;
                    result = await dialog.ShowAsync();
                }

                if (result == Microsoft.UI.Xaml.Controls.ContentDialogResult.Primary)
                    await profileController.DeleteFolderAsync(name, deleteProfiles: false);
                else if (result == Microsoft.UI.Xaml.Controls.ContentDialogResult.Secondary)
                    await profileController.DeleteFolderAsync(name, deleteProfiles: true);
                else
                    return; // Cancel
            }
            else
            {
                await profileController.DeleteFolderAsync(name);
            }

            InputHookManager.RegisterProfileWindowTargets(profileController.GetProfileWindowTargets(), profileController.GetBringToFocusProfiles());
            PushProfilesUpdate();
        }

        private async void HandleToggleFolderDisable(JsonElement payload)
        {
            string folderName = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(folderName)) return;

            var folder = profileController.GetProfileOrder().Folders.FirstOrDefault(f => f.Name == folderName);
            if (folder == null) return;

            // Determine new state: if ANY profile is enabled, disable all. Otherwise enable all.
            var folderEntries = folder.Items
                .Select(n => profileController.ProfileEntries.FirstOrDefault(p => p.Name == n))
                .Where(e => e != null)
                .ToList();

            bool newDisabled = folderEntries.Any(e => !e!.IsDisabled);

            foreach (var entry in folderEntries)
            {
                if (entry == null) continue;
                var profile = await SettingsManager.LoadProfileAsync(entry.FilePath);
                if (profile == null) continue;
                profile.IsDisabled = newDisabled;
                await SettingsManager.SaveProfileAsync(entry.FilePath, profile);
                entry.IsDisabled = newDisabled;
                if (CurrentProfileName == entry.Name)
                    UserProfile.Current.IsDisabled = newDisabled;
            }

            PushProfilesUpdate();
            var hotkeys = profileController.GetProfileHotkeys();
            InputHookManager.RegisterProfileHotkeys(hotkeys);
            InputHookManager.RegisterProfileTriggerModes(profileController.GetProfileTriggerModes());
            var hotstrings = profileController.GetProfileHotstrings();
            InputHookManager.RegisterProfileHotstrings(hotstrings);
            InputHookManager.RegisterProfileWindowTargets(profileController.GetProfileWindowTargets(), profileController.GetBringToFocusProfiles());
        }

        private async void HandleSetFolderColor(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            string color = payload.GetProperty("color").GetString() ?? "#60CDFF";
            if (string.IsNullOrEmpty(name)) return;
            await profileController.SetFolderColorAsync(name, color);
            PushProfilesUpdate();
        }

        private async void HandleToggleFolderCollapse(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;
            await profileController.ToggleFolderCollapseAsync(name);
            PushProfilesUpdate();
        }

        private async void HandleSetAllFoldersCollapsed(JsonElement payload)
        {
            // Single bulk write — the controller skips the save entirely when no
            // folder changes state, so the menu item is a no-op on second click.
            bool collapsed = payload.GetProperty("collapsed").GetBoolean();
            await profileController.SetAllFoldersCollapsedAsync(collapsed);
            PushProfilesUpdate();
        }

        private async void HandleMoveToFolder(JsonElement payload)
        {
            string profileName = payload.GetProperty("profileName").GetString() ?? "";
            string? folderName = payload.TryGetProperty("folderName", out var fnProp) && fnProp.ValueKind != JsonValueKind.Null
                ? fnProp.GetString()
                : null;
            if (string.IsNullOrEmpty(profileName)) return;
            await profileController.MoveToFolderAsync(profileName, folderName);
            InputHookManager.RegisterProfileWindowTargets(profileController.GetProfileWindowTargets(), profileController.GetBringToFocusProfiles());
            PushProfilesUpdate();
        }

        private async void HandleProfileReorder(JsonElement payload)
        {
            List<string>? pinned = null;
            List<ProfileFolder>? folders = null;
            List<string>? ungrouped = null;

            if (payload.TryGetProperty("pinned", out var pinnedProp))
                pinned = JsonSerializer.Deserialize<List<string>>(pinnedProp.GetRawText());

            if (payload.TryGetProperty("folders", out var foldersProp))
                folders = JsonSerializer.Deserialize<List<ProfileFolder>>(foldersProp.GetRawText(), new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

            if (payload.TryGetProperty("ungroupedOrder", out var ungroupedProp))
                ungrouped = JsonSerializer.Deserialize<List<string>>(ungroupedProp.GetRawText());

            await profileController.ReorderProfilesAsync(pinned, folders, ungrouped);
            PushProfilesUpdate();
        }

        /// <summary>
        /// Resolves the current target window's origin for the active profile, used to
        /// translate freshly-captured WaitImage region / WaitPixelColor coords from absolute
        /// (what the overlay returns) to profile-relative (what we store when UseRelativeCoordinates
        /// is on). Returns true with rect populated only when ALL of these hold: the profile uses
        /// relative coords, a WindowTarget is configured, and the target window is currently
        /// running AND NOT MINIMISED. False otherwise — caller stores absolute coords as fallback.
        /// </summary>
        /// <remarks>
        /// The minimised clause arrived with TryGetWindowRect and closes a real bug. This helper
        /// used to call FindWindow + GetWindowRect raw, which is the one sequence in this file
        /// that must never be written by hand: a minimised target passes IsWindowVisible and
        /// GetWindowRect answers with the (-32000,-32000) parking rect, so every capture path
        /// feeding through here — pixel pick, position pick, WaitImage / WaitPixel inserts, the
        /// search-region round-trip — subtracted ~-32000 and stored a coordinate ~32000 px out.
        /// Three sibling call sites had each grown their own IsIconic guard; this one had not.
        ///
        /// Degrading to absolute (rather than refusing, the way the position pick does before it
        /// even minimises the app) is the right answer HERE because that is already this method's
        /// contract for every other unusable-target case, and every caller is written for it. A
        /// user cannot meaningfully pick inside a window that is not on screen anyway, so the
        /// realistic effect is that a stray pick is stored as what it literally is.
        /// </remarks>
        private bool TryGetRelativeCaptureOffset(out NativeMethods.RECT rect)
        {
            rect = default;
            if (!UserProfile.Current.UseRelativeCoordinates) return false;
            var target = CurrentProfileName != "No Profile"
                ? profileController.GetEffectiveWindowTarget(CurrentProfileName)
                : UserProfile.Current.TargetWindow;
            if (target == null || (string.IsNullOrEmpty(target.ProcessName) && string.IsNullOrEmpty(target.WindowTitle)))
                return false;
            return TryGetWindowRect(target, out rect) == WindowRectStatus.Ok;
        }

        private async void HandleProfileExport(JsonElement payload)
        {
            var names = payload.GetProperty("names").EnumerateArray()
                .Select(e => e.GetString() ?? "")
                .Where(n => !string.IsNullOrEmpty(n))
                .ToList();

            if (names.Count == 0) return;
            if (replayService.IsReplaying || recordingService.IsRecording) { SendMessage("alert:show", new { message = "Finish the current recording/replay before exporting." }); return; }

            try
            {
                // ValueKind (not GetBoolean) so an absent / non-bool property reads as false.
                bool includeOrganization = payload.TryGetProperty("includeOrganization", out var orgProp) && orgProp.ValueKind == JsonValueKind.True;
                bool includeDependencies = payload.TryGetProperty("includeDependencies", out var depProp) && depProp.ValueKind == JsonValueKind.True;

                // Export reads each profile from disk (ExportProfilesAsync → LoadProfileByNameAsync), so
                // unsaved grid edits held only in the in-memory `actions` collection would be silently
                // omitted from the .trprofile. Prompt Save/Discard/Cancel when the dirty ACTIVE profile
                // is part of what will actually be exported — either explicitly selected, OR pulled in as
                // a Run Profile dependency (those always ship now). The closure walk reads the same
                // on-disk graph the export will; saving first also lets that later walk pick up any
                // sub-profile the just-saved edits added (and the post-export toast then discloses it).
                // Kept INSIDE this try so a locked/corrupt profile hit during the walk surfaces the
                // "Export failed" toast below rather than escaping the async void handler unnoticed.
                if (HasUnsavedChanges && CurrentProfileName != "No Profile")
                {
                    bool activeInExport = names.Any(n => string.Equals(n, CurrentProfileName, StringComparison.OrdinalIgnoreCase));
                    if (!activeInExport && includeDependencies)
                    {
                        var closure = await profileController.ExpandWithRunProfileDependenciesAsync(names);
                        activeInExport = closure.Any(n => string.Equals(n, CurrentProfileName, StringComparison.OrdinalIgnoreCase));
                    }
                    if (activeInExport && !await CheckUnsavedChangesAsync("exporting")) return;
                }

                var (exported, missingImages, bundledDependencies, savedPath) = await profileController.ExportProfilesAsync(names, includeOrganization, includeDependencies);
                if (exported > 0)
                {
                    // Register the file THIS export wrote under a fresh id — the toast's
                    // "Show in folder" echoes the id, so stacked/paused older toasts keep
                    // revealing THEIR file. Window of 8 comfortably outlives any toast.
                    int exportId = ++_exportSeq;
                    if (savedPath != null)
                    {
                        _recentExportPaths[exportId] = savedPath;
                        _recentExportPaths.Remove(exportId - 8);
                    }
                    // Structured result → the frontend renders a success toast with a
                    // "Show in folder" action. The bundled-dependency list stays the
                    // AUTHORITATIVE egress disclosure — computed from what actually shipped,
                    // after any Save-on-export — so it discloses a bundled (possibly private)
                    // sub-profile even when the dialog's pre-export preview was stale.
                    SendMessage("profile:exportResult", new
                    {
                        exportId,
                        fileName = savedPath != null ? Path.GetFileName(savedPath) : null,
                        exportedCount = exported,
                        requestedCount = names.Count,
                        bundledDependencies,
                        missingImages,
                    });
                }
                else if (exported == 0)
                    SendMessage("alert:show", new { message = "Export failed: none of the selected profiles could be loaded." });
                // exported < 0 => user cancelled the Save dialog: stay silent.
            }
            catch (Exception ex)
            {
                SendMessage("alert:show", new { message = $"Export failed: {ex.Message}" });
            }
        }

        // Recent exports keyed by a monotonic id. Each export toast's "Show in folder"
        // echoes ITS OWN id back, so an older still-visible toast (they live 6-8s and
        // hover-pause indefinitely) can never reveal a NEWER export's file. Paths never
        // cross the bridge: file:revealExport carries only the id, and only files this
        // session's exports wrote can ever open.
        private int _exportSeq;
        private readonly Dictionary<int, string> _recentExportPaths = new();

        /// <summary>
        /// Opens Explorer with the identified export's .trprofile selected. The id→path
        /// map is server-side only — the payload never carries a path.
        /// </summary>
        private void HandleFileRevealExport(JsonElement payload)
        {
            if (!payload.TryGetProperty("exportId", out var idProp) || !idProp.TryGetInt32(out int id)) return;
            if (!_recentExportPaths.TryGetValue(id, out var path)) return;
            RevealInExplorer(path, "Could not open the export folder");
        }

        /// <summary>
        /// Explorer /select reveal shared by profile:openFolder and the export toast action.
        /// One idiom, one failure policy: log + toast (a silent catch made a broken reveal
        /// undiagnosable). /select keeps the path quoted — names carry spaces/accents.
        /// </summary>
        private void RevealInExplorer(string path, string failureMessage)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return;
            try
            {
                System.Diagnostics.Process.Start("explorer.exe", $"/select,\"{path}\"");
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error($"Failed to reveal '{path}' in Explorer", ex);
                SendMessage("alert:show", new { message = failureMessage });
            }
        }

        // Pending-import slot: parsed envelope + file name held server-side between the
        // preview round-trip and the confirm message. Single slot is fine because the
        // user can only have one Import flow open at a time (the file dialog is modal).
        // Cleared after confirm, on cancel (via profile:cancelImport), or when a new
        // preview starts (slot is overwritten).
        private ProfileExportEnvelope? _pendingImportEnvelope;
        private string? _pendingImportFileName;
        // Reentrancy guard: the import file picker is non-modal (ShowFileDialogAsync spawns a
        // detached STA thread and calls ShowDialog() with no owner), so a double-click could open
        // two pickers and race the single _pendingImportEnvelope slot. Only one import flow at a time.
        private bool _importPickerOpen;

        /// <summary>
        /// Two-step import: opens the file picker, parses the envelope, and ships a
        /// `profile:importPreview` message back to the frontend. The frontend renders
        /// the security warning (first time only) + Import Preview dialog, then sends
        /// `profile:confirmImport` with the selected profile names to actually write
        /// them to disk.
        /// </summary>
        private async void HandleProfileImport()
        {
            if (_importPickerOpen) return;   // a second click while the picker is open is a no-op
            if (replayService.IsReplaying || recordingService.IsRecording) { SendMessage("alert:show", new { message = "Finish the current recording/replay before importing." }); return; }
            _importPickerOpen = true;
            try
            {
                var prep = await profileController.PrepareImportPreviewAsync();
                if (prep.Status == ImportPrepareStatus.Ok)
                {
                    SendImportPreview(prep.Envelope!, Path.GetFileName(prep.FilePath!));
                }
                else
                {
                    // Every non-Ok outcome clears any pending state. Cancelled is the ONE legitimate
                    // silence (user closed the picker); the rest get an actionable error toast so a
                    // corrupt / unreadable / empty file is never indistinguishable from a cancel.
                    // Strings stay ENGLISH — they cross the bridge from C# where tt() doesn't exist,
                    // matching every other backend alert:show. Pass type explicitly (don't rely on
                    // the frontend word-sniffing an error out of the message).
                    _pendingImportEnvelope = null;
                    _pendingImportFileName = null;
                    if (prep.Status != ImportPrepareStatus.Cancelled)
                    {
                        string m = prep.Status switch
                        {
                            ImportPrepareStatus.TooLarge => "That file is too large to import (over 50 MB).",
                            ImportPrepareStatus.ParseError => "That file isn't a valid TrueReplayer profile export.",
                            ImportPrepareStatus.NoProfiles => "That export file contains no profiles to import.",
                            ImportPrepareStatus.ReadError => $"Couldn't read that file: {prep.Detail}",
                            _ => "Import failed.",
                        };
                        SendMessage("alert:show", new { message = m, type = "error" });
                    }
                }
            }
            catch (Exception ex)
            {
                SendMessage("alert:show", new { message = $"Import failed: {ex.Message}" });
                _pendingImportEnvelope = null;
                _pendingImportFileName = null;
            }
            finally
            {
                _importPickerOpen = false;
            }
        }

        /// <summary>
        /// Stores the parsed envelope as the pending import and pushes the preview payload the
        /// React Import Preview dialog renders. Sole caller: HandleProfileImport (there is no
        /// drag-and-drop import path — the WebView drop handler was never wired). Compatibility
        /// is computed server-side so the frontend doesn't need the version table.
        /// </summary>
        private void SendImportPreview(ProfileExportEnvelope envelope, string fileName)
        {
            _pendingImportEnvelope = envelope;
            _pendingImportFileName = fileName;

            string runningVersion = typeof(WebViewBridge).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
            // Names carried IN this envelope — for classifying each row's RunProfile refs below.
            // ORDINAL (not ignore-case) so inEnvelope agrees with localOnly and with replay's own
            // Ordinal ref resolution (LoadProfileByNameAsync): a bundled "Sub" does NOT satisfy a
            // caller ref "sub", which replay would silently skip — so it must not chip green.
            var envelopeNames = new HashSet<string>(envelope.Profiles.Select(x => x.Name), StringComparer.Ordinal);
            var previewProfiles = envelope.Profiles.Select(p =>
            {
                var acts = p.Actions ?? new System.Collections.ObjectModel.ObservableCollection<ActionItem>();
                // The receiver's local profile of the same name, if any — drives the conflict hint
                // AND the incoming-vs-yours version/date diff line.
                var local = profileController.ProfileEntries.FirstOrDefault(e => string.Equals(e.Name, p.Name, StringComparison.OrdinalIgnoreCase));
                // RunProfile refs this profile calls, each classified so the dialog can chip them:
                // inEnvelope (bundled here) / localOnly (will call YOUR existing one) / missing
                // (nothing to call → silent skip at replay). Distinct + Ordinal-match a local profile
                // the same way replay resolves the ref.
                var dependencies = acts
                    .Where(a => string.Equals(a.ActionType, "RunProfile", StringComparison.OrdinalIgnoreCase))
                    .Select(a => a.Key?.Trim())
                    .Where(k => !string.IsNullOrEmpty(k))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .Select(k => new
                    {
                        name = k,
                        status = envelopeNames.Contains(k!) ? "inEnvelope"
                               : profileController.ProfileEntries.Any(e => string.Equals(e.Name, k, StringComparison.Ordinal)) ? "localOnly"
                               : "missing"
                    })
                    .ToArray();
                return new
                {
                    name = p.Name,
                    description = p.Description,
                    tags = p.Tags,
                    iconEmoji = p.IconEmoji,
                    profileVersion = p.ProfileVersion,
                    createdAt = p.CreatedAt?.ToString("o"),
                    updatedAt = p.UpdatedAt?.ToString("o"),
                    appMinVersion = p.AppMinVersion,
                    compatible = ProfileCompatibility.IsCompatible(p.AppMinVersion, runningVersion),
                    actionCount = acts.Count,
                    imageCount = p.Images?.Count ?? 0,
                    // Per-profile loop, so the preview doesn't hide a profile that will hammer
                    // the receiver's machine 500 times per press. Normalized the same way the
                    // import itself normalizes, so the preview can't promise a value the write
                    // then clamps away.
                    loopCount = UserProfile.NormalizeLoopCount(p.LoopCount),
                    enableLoop = p.EnableLoop,
                    hotkey = p.CustomHotkey,
                    hotstring = p.CustomHotstring?.Sequence,
                    targetProcessName = p.TargetWindow?.ProcessName,
                    targetWindowTitle = p.TargetWindow?.WindowTitle,
                    // Disclosure of what ALREADY travels in the envelope. The automation
                    // trigger is imported DISARMED (DisarmedTriggerClone forces Armed=false),
                    // which was 100% silent — receivers concluded the profile "doesn't work".
                    // The data-loop row count rides for the same reason: 200 rows of the
                    // sender's data should be visible before import, not discovered after.
                    hasTrigger = p.Triggers != null,
                    dataRowCount = p.Data?.Rows?.Count ?? 0,
                    dependencies,
                    // Conflict detection — the receiver may already have a profile with the same
                    // name. Surface that here so the dialog can show a "will be renamed" / "will
                    // overwrite" hint up-front instead of only learning at confirm time. Case-
                    // INSENSITIVE to match the confirm path (File.Exists on NTFS + the OrdinalIgnoreCase
                    // allocation maps): 'farm' vs local 'Farm' IS a real collision, so the user must
                    // get the Overwrite/Skip choice instead of a silent surprise rename.
                    nameConflict = local != null,
                    // On a conflict, let the dialog show "incoming v5 (2d ago) vs yours v3 (1mo ago)"
                    // so Overwrite is an informed choice, not a coin flip. Null when no local match.
                    localVersion = local?.ProfileVersion,
                    localUpdatedAt = local?.UpdatedAt?.ToString("o")
                };
            }).ToArray();

            SendMessage("profile:importPreview", new
            {
                fileName = _pendingImportFileName,
                envelopeVersion = envelope.Version,
                exportedAt = envelope.ExportedAt,
                runningVersion,
                hasOrganization = envelope.Organization != null,
                requiresAcknowledgement = !AppSettingsManager.Load().HasAcknowledgedImportWarning,
                profiles = previewProfiles
            });
        }

        /// <summary>
        /// Phase 2 of import: receives the user's selection from the Import Preview dialog
        /// and runs the actual write/conflict-resolution flow on the previously parsed
        /// envelope. Clears the pending slot on completion (success or failure).
        /// </summary>
        private async void HandleProfileConfirmImport(JsonElement payload)
        {
            if (_pendingImportEnvelope == null)
            {
                // Stale confirm — most likely the bridge was reloaded between preview and confirm.
                SendMessage("alert:show", new { message = "Import session expired — please try again." });
                return;
            }
            if (replayService.IsReplaying || recordingService.IsRecording)
            {
                SendMessage("alert:show", new { message = "Finish the current recording/replay before importing." });
                _pendingImportEnvelope = null;
                _pendingImportFileName = null;
                return;
            }

            // Selected names: which profiles from the envelope to actually import. Frontend
            // omits incompatible ones (AppMinVersion > running) automatically — we trust
            // it but double-check below as a safety net.
            var selectedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            int unsafeDropped = 0;
            if (payload.TryGetProperty("selectedNames", out var namesProp) && namesProp.ValueKind == JsonValueKind.Array)
            {
                foreach (var el in namesProp.EnumerateArray())
                {
                    var s = el.GetString();
                    // Bridge-boundary guard: drop any selected name that isn't a bare file name so a
                    // poisoned payload can never carry a traversal name into ConfirmImportAsync's
                    // Path.Combine. ConfirmImportAsync re-validates entry.Name as the authoritative
                    // backstop (defense in depth). Mirrors the guard on create/rename.
                    if (!string.IsNullOrEmpty(s) && IsSafeProfileName(s)) selectedNames.Add(s);
                    // A name dropped HERE never reaches ConfirmImportAsync, so its skipped++ is
                    // unreachable — count it separately and fold it into the reported skipped total,
                    // else an all-unsafe payload imports "0" with no explanation.
                    else if (!string.IsNullOrEmpty(s)) unsafeDropped++;
                }
            }

            // Per-conflict resolution map: { profileName → "overwrite" | "rename" | "skip" }.
            // Frontend only populates entries for profiles whose names collide. Anything missing
            // here defaults to "rename" on the backend — safest fallback (never silently
            // overwrites). Extract BEFORE the first await: HandleMessage owns the JsonDocument
            // via `using`, so payload becomes invalid after we yield.
            var conflictResolutions = new Dictionary<string, ImportConflictResult>(StringComparer.OrdinalIgnoreCase);
            if (payload.TryGetProperty("conflictResolutions", out var resProp) && resProp.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in resProp.EnumerateObject())
                {
                    var resStr = prop.Value.GetString();
                    var resolution = resStr switch
                    {
                        "overwrite" => ImportConflictResult.Overwrite,
                        "skip" => ImportConflictResult.Skip,
                        _ => ImportConflictResult.Rename,  // includes "rename" + unknown values
                    };
                    conflictResolutions[prop.Name] = resolution;
                }
            }

            if (selectedNames.Count == 0)
            {
                _pendingImportEnvelope = null;
                _pendingImportFileName = null;
                // All selected names were dropped as unsafe (or none were sent). Don't fail silently —
                // the picker-cancel path is the only legitimate silence.
                if (unsafeDropped > 0)
                    SendMessage("alert:show", new { message = $"Import skipped {unsafeDropped} profile(s) with invalid names.", type = "error" });
                return;
            }

            try
            {
                var (imported, skipped, hasOrganization, imageFailureNames, writtenNames, adoptedFolderTargets, keptLocalFolderTargets, renamedPairs) = await profileController.ConfirmImportAsync(
                    _pendingImportEnvelope, selectedNames, conflictResolutions);
                // Names dropped at the bridge guard above never entered ConfirmImportAsync, so add
                // them to the skipped total the user sees.
                int totalSkipped = skipped + unsafeDropped;

                if (imported > 0)
                {
                    // Capture hotkey collisions BEFORE any reload/refresh below re-runs
                    // GetProfileHotkeys and clears the list. ConfirmImportAsync already ran
                    // RefreshProfileListAsync internally, so _hotkeyCollisions reflects the
                    // post-import armed set.
                    var hotkeyCollisions = profileController.GetAndClearHotkeyCollisions();

                    // If the import OVERWROTE the profile currently loaded in the grid, its
                    // on-disk file changed underneath us. Reload it so UserProfile.Current +
                    // the grid reflect the imported content — otherwise replay fires the STALE
                    // in-memory actions and the next Save writes that stale copy back over the
                    // freshly imported file. A Rename resolution writes a NEW "name (N)" file
                    // and leaves the active profile untouched, so writtenNames won't contain
                    // CurrentProfileName in that case. Mirrors the reset the delete handler does.
                    if (!string.IsNullOrEmpty(CurrentProfileName)
                        && CurrentProfileName != "No Profile"
                        && writtenNames.Any(n => string.Equals(n, CurrentProfileName, StringComparison.OrdinalIgnoreCase)))
                    {
                        var reloaded = await profileController.LoadProfileByNameAsync(CurrentProfileName);
                        if (reloaded != null)
                        {
                            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == CurrentProfileName);
                            UserProfile.Current = reloaded;
                            AppSettingsManager.ApplyGlobalSettings(UserProfile.Current);
                            CurrentProfilePath = entry?.FilePath;
                            HasUnsavedChanges = false;
                            UserProfile.Current.UseRelativeCoordinates = profileController.GetEffectiveRelativeCoordinates(CurrentProfileName);
                            UserProfile.Current.BringToFocus = profileController.GetEffectiveBringToFocus(CurrentProfileName);
                            ApplyProfile(reloaded);
                            profileController.UpdateProfileColors(CurrentProfileName);
                            // The import overwrote the loaded profile on disk and we just re-read
                            // it — its loop settings may differ from what the panel is showing,
                            // and any pending edit belonged to the file that no longer exists.
                            ClearLoopEdit();
                            PushProfileLoop();
                            TrayIconService.UpdateTrayIcon();
                        }
                    }

                    PushProfilesUpdate();

                    // A CLEAN import keeps the quiet success toast — the result dialog must never
                    // punish the happy path with a third modal. Anything beyond a clean write goes
                    // to the structured `profile:importResult` dialog instead: the old path squeezed
                    // renames/images/folder-targets into one 300+ char string on a 3-second success
                    // toast, and emitted each hotkey collision as a loose toast the frontend
                    // word-sniffed red ("conflict"). The most consequential fact of the whole flow —
                    // "the imported profiles there will use YOUR target, not the sender's" — had the
                    // most ephemeral surface in the app.
                    // Renames COUNT as warnings: Rename is the preview's DEFAULT resolution, so a
                    // rename-only import is the single most common "worth reading" outcome — gating
                    // it out would make the dialog's own rename section unreachable and leave the
                    // user hunting for the profile under a name it didn't land under.
                    bool hasWarnings = totalSkipped > 0
                        || imageFailureNames.Count > 0
                        || adoptedFolderTargets.Count > 0
                        || keptLocalFolderTargets.Count > 0
                        || hotkeyCollisions.Count > 0
                        || renamedPairs.Count > 0;

                    if (!hasWarnings)
                    {
                        string msg = $"Imported {imported} profile(s).";
                        if (hasOrganization) msg += " Folder organization imported.";
                        SendMessage("alert:show", new { message = msg, type = "success" });
                    }
                    else
                    {
                        SendMessage("profile:importResult", new
                        {
                            imported,
                            // Final names as written (post-rename). Full names travel; the dialog
                            // truncates via CSS, so the toast-era 40-char surrogate-safe truncation
                            // is no longer needed here. renames are the EXACT collision pairs
                            // ConfirmImportAsync recorded — never a set-difference heuristic, which
                            // misread a ".json"-suffixed envelope entry as "name was taken".
                            importedNames = writtenNames,
                            renames = renamedPairs.Select(r => new { from = r.requested, to = r.final }).ToArray(),
                            skipped = totalSkipped,
                            // Per-file failure REASONS are already in the log (ImageStorageService
                            // logs each one) — the dialog names the files and points at Logs.
                            imageFailureNames,
                            hasOrganization,
                            adoptedFolderTargets,
                            keptLocalFolderTargets,
                            // Pre-composed strings (GetAndClearHotkeyCollisions' shape), grouped by
                            // the dialog into one section instead of N loose toasts. The hotkeys are
                            // already armed — without surfacing this the colliding profiles would
                            // "silently fight" until the next launch.
                            hotkeyCollisions,
                        });
                    }
                }
                else if (totalSkipped > 0)
                {
                    SendMessage("alert:show", new { message = $"All {totalSkipped} profile(s) were skipped.", type = "info" });
                }
                else
                {
                    // imported == 0 && nothing skipped: the selected names matched no envelope entry
                    // (a stale or hand-crafted confirm payload). Previously fell through both branches
                    // and showed NOTHING — the user clicked Import and got silence.
                    SendMessage("alert:show", new { message = "No profiles were imported.", type = "info" });
                }
            }
            catch (Exception ex)
            {
                SendMessage("alert:show", new { message = $"Import failed: {ex.Message}", type = "error" });
            }
            finally
            {
                _pendingImportEnvelope = null;
                _pendingImportFileName = null;
            }
        }

        // ── Sharing metadata handlers ──

        private async void HandleProfileGetMetadata(JsonElement payload)
        {
            string name = payload.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
            if (string.IsNullOrEmpty(name)) return;
            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile == null)
            {
                SendMessage("profile:metadata", new { name, found = false });
                return;
            }
            // Recompute AppMinVersion + contributing features on the fly so the Info tab can
            // explain why min-version is what it is even if the persisted value is stale.
            var computed = ProfileCompatibility.ComputeMinVersion(profile);
            var contributors = ProfileCompatibility.ListContributingFeatures(profile);
            SendMessage("profile:metadata", new
            {
                name,
                found = true,
                description = profile.Description,
                tags = profile.Tags ?? new List<string>(),
                iconEmoji = profile.IconEmoji,
                profileVersion = profile.ProfileVersion,
                createdAt = profile.CreatedAt?.ToString("o"),
                updatedAt = profile.UpdatedAt?.ToString("o"),
                appMinVersion = computed,
                appMinVersionContributors = contributors
            });
        }

        private async void HandleProfileSetMetadata(JsonElement payload)
        {
            // CRITICAL: HandleMessage owns the JsonDocument via `using var doc = JsonDocument.Parse(...)`
            // and disposes it as soon as this method's first `await` yields control. Any payload access
            // AFTER the await throws ObjectDisposedException. Extract every field we need into POCO/local
            // variables up-front, then operate on those. The TryGet... pattern below distinguishes
            // "absent" (don't touch the field) from "present but null" (clear the field) — important
            // for partial-update semantics where the frontend only sends the keys it actually changed.

            string name = payload.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
            if (string.IsNullOrEmpty(name)) return;

            // Description
            bool hasDescription = payload.TryGetProperty("description", out var descProp);
            string? descriptionValue = null;
            if (hasDescription)
            {
                descriptionValue = descProp.ValueKind == JsonValueKind.Null ? null : descProp.GetString();
                if (descriptionValue != null)
                {
                    descriptionValue = descriptionValue.Trim();
                    if (descriptionValue.Length > 500) descriptionValue = descriptionValue.Substring(0, 500);
                }
            }

            // Tags — materialise the whole cleaned list now so we can drop the JsonElement.
            bool hasTags = payload.TryGetProperty("tags", out var tagsProp);
            List<string>? tagsValue = null;
            bool tagsExplicitNull = false;
            if (hasTags)
            {
                if (tagsProp.ValueKind == JsonValueKind.Null)
                {
                    tagsExplicitNull = true;
                }
                else if (tagsProp.ValueKind == JsonValueKind.Array)
                {
                    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    var cleaned = new List<string>();
                    foreach (var t in tagsProp.EnumerateArray())
                    {
                        var s = t.GetString();
                        if (string.IsNullOrWhiteSpace(s)) continue;
                        s = s.Trim().ToLowerInvariant();
                        // Same regex enforced on the frontend tag input. Accepts a-z 0-9 . - _ +
                        // — common in tags like "fps", "csgo-2024", "win+r".
                        if (!System.Text.RegularExpressions.Regex.IsMatch(s, @"^[a-z0-9\-_+.]+$")) continue;
                        if (s.Length > 32) s = s.Substring(0, 32);
                        if (seen.Add(s)) cleaned.Add(s);
                        if (cleaned.Count >= 10) break;
                    }
                    tagsValue = cleaned;
                }
            }

            // IconEmoji — keep at most 1 grapheme cluster. The frontend picker sends one emoji
            // at a time, but a single emoji can span up to ~14 UTF-16 code units (family ZWJ
            // sequences with skin-tone modifiers). Naive `Substring(0, N)` on N too small
            // would cut mid-codepoint and produce invalid UTF-16 garbage. StringInfo walks
            // grapheme clusters correctly, so taking just the first one is safe for every
            // emoji shape we ship.
            bool hasIconEmoji = payload.TryGetProperty("iconEmoji", out var emojiProp);
            string? iconEmojiValue = null;
            if (hasIconEmoji)
            {
                iconEmojiValue = emojiProp.ValueKind == JsonValueKind.Null ? null : emojiProp.GetString();
                if (!string.IsNullOrEmpty(iconEmojiValue))
                {
                    var enumerator = System.Globalization.StringInfo.GetTextElementEnumerator(iconEmojiValue);
                    iconEmojiValue = enumerator.MoveNext() ? (string)enumerator.Current : null;
                }
            }

            // From here on out, no more payload access — safe to await.
            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile == null) return;

            if (hasDescription)
                profile.Description = string.IsNullOrEmpty(descriptionValue) ? null : descriptionValue;
            if (hasTags)
                profile.Tags = tagsExplicitNull ? null : (tagsValue != null && tagsValue.Count > 0 ? tagsValue : null);
            if (hasIconEmoji)
                profile.IconEmoji = string.IsNullOrEmpty(iconEmojiValue) ? null : iconEmojiValue;

            await profileController.SaveProfileByNameAsync(name, profile);
            await profileController.RefreshProfileListAsync(true);
            PushProfilesUpdate();
        }

        private async void HandleProfileBumpVersion(JsonElement payload)
        {
            string name = payload.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
            if (string.IsNullOrEmpty(name)) return;
            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile == null) return;
            // Defensively guard against overflow on absurd values. Wraps at int.MaxValue,
            // which no human will ever reach but better than crashing.
            profile.ProfileVersion = profile.ProfileVersion < int.MaxValue ? profile.ProfileVersion + 1 : 1;
            await profileController.SaveProfileByNameAsync(name, profile);
            await profileController.RefreshProfileListAsync(true);
            PushProfilesUpdate();
            SendMessage("profile:versionBumped", new { name, newVersion = profile.ProfileVersion });
        }

        private void HandleProfileListTags()
        {
            // Aggregate from the in-memory ProfileEntries — already populated by LoadProfileListAsync.
            // Counts let the autocomplete sort by popularity (most-used first), which matches
            // user expectation: tags they've used 5× should bubble above one-offs.
            var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in profileController.ProfileEntries)
            {
                if (entry.Tags == null) continue;
                foreach (var t in entry.Tags)
                {
                    if (string.IsNullOrWhiteSpace(t)) continue;
                    var key = t.Trim().ToLowerInvariant();
                    counts[key] = counts.GetValueOrDefault(key, 0) + 1;
                }
            }
            var sorted = counts
                .OrderByDescending(kv => kv.Value)
                .ThenBy(kv => kv.Key)
                .Select(kv => new { tag = kv.Key, count = kv.Value })
                .ToArray();
            SendMessage("profile:tagList", new { tags = sorted });
        }

        private void HandleAcknowledgeImportWarning()
        {
            var s = AppSettingsManager.Load();
            if (!s.HasAcknowledgedImportWarning)
            {
                s.HasAcknowledgedImportWarning = true;
                AppSettingsManager.Save(s);
            }
        }

        /// <summary>
        /// User aborted the import after the preview was prepared (either from the security
        /// warning or the Import Preview dialog). Clears the server-side pending envelope so
        /// it doesn't linger in memory until the next import overwrites it. Idempotent — safe
        /// to call even when no envelope is pending (no-op then).
        /// </summary>
        private void HandleProfileCancelImport()
        {
            _pendingImportEnvelope = null;
            _pendingImportFileName = null;
        }

        private async void HandleProfileSave()
        {
            if (CurrentProfilePath != null)
            {
                var choice = await profileController.ShowSaveOverwriteDialogAsync(CurrentProfileName);
                if (choice == SaveDialogResult.Overwrite)
                {
                    var profile = CreateProfileFromState();
                    profile.CustomHotkey = UserProfile.Current.CustomHotkey;
                    await SettingsManager.SaveProfileAsync(CurrentProfilePath, profile);
                    // Re-read the list so the in-memory ProfileEntries mirror (and the caches
                    // LoadProfileListAsync rebuilds from it — window targets, referenced images)
                    // reflect what we just wrote. PushProfilesUpdate at the end of this handler only
                    // PROJECTS that mirror, so without this an overwrite-save pushes stale metadata
                    // (e.g. Profile Info's "Updated" keeps the previous timestamp). Every other save
                    // path already does this — ProfileController.SaveProfileAsync refreshes right
                    // after its write, as do the hotkey/hotstring handlers.
                    await profileController.RefreshProfileListAsync(true);
                    UserProfile.Current = profile;
                    AppSettingsManager.ApplyGlobalSettings(UserProfile.Current);
                    HasUnsavedChanges = false;
                    // The pending loop edit is now on disk — the chip drops its dashed outline.
                    ClearLoopEdit();
                }
                else if (choice == SaveDialogResult.SaveAsNew)
                {
                    bool saved = await profileController.SaveProfileAsync();
                    if (saved) { HasUnsavedChanges = false; ClearLoopEdit(); }
                }
                // Cancel = do nothing
            }
            else
            {
                bool saved = await profileController.SaveProfileAsync();
                if (saved) { HasUnsavedChanges = false; ClearLoopEdit(); }
            }
            PushProfileLoop();
            PushProfilesUpdate();
        }

        private async void HandleProfileLoad()
        {
            // Guard: check for unsaved changes before loading
            if (!await CheckUnsavedChangesAsync("loading another profile")) return;

            string? loadedPath = await profileController.LoadProfileAsync();
            if (loadedPath == null) return;

            string name = Path.GetFileNameWithoutExtension(loadedPath);
            CurrentProfileName = name;
            CurrentProfilePath = loadedPath;
            HasUnsavedChanges = false;
            ApplyProfile(UserProfile.Current);
            profileController.UpdateProfileColors(name);
            ClearLoopEdit();
            PushProfileLoop();
            PushProfilesUpdate();
            TrayIconService.UpdateTrayIcon();
        }

        private async void HandleProfileReset()
        {
            var messageBlock = new Microsoft.UI.Xaml.Controls.TextBlock
            {
                Text = "This will reset all settings to their default values and clear all actions.",
                TextWrapping = Microsoft.UI.Xaml.TextWrapping.Wrap
            };

            var dialog = new Microsoft.UI.Xaml.Controls.ContentDialog
            {
                Title = "Reset Settings",
                XamlRoot = window.Content.XamlRoot,
                RequestedTheme = Microsoft.UI.Xaml.ElementTheme.Dark,
                PrimaryButtonText = "Reset",
                CloseButtonText = "Cancel",
                DefaultButton = Microsoft.UI.Xaml.Controls.ContentDialogButton.Close,
                CornerRadius = new Microsoft.UI.Xaml.CornerRadius(8),
                Content = messageBlock
            };
            profileController.ApplyDialogTheme(dialog, messageBlock);

            // See ModalGate. Refusing leaves settings untouched — the safe outcome for a
            // confirmation the user never saw.
            using var gate = Services.ModalGate.TryEnter("reset settings");
            if (gate == null) return;

            var confirm = await dialog.ShowAsync();
            if (confirm != Microsoft.UI.Xaml.Controls.ContentDialogResult.Primary)
                return;

            // Reset ALL global settings to defaults and save.
            // — Preserve the current mode (Macro/Clicker): the reset is "restore values",
            //   not "switch modes". Users in Clicker mode shouldn't get bounced back to
            //   Macro just because they reset.
            // — Use real Clicker defaults (delay=100 ms, hold=10 ms, everything else 0/off)
            //   instead of the -1 migration sentinel, so a reset doesn't re-trigger the
            //   one-shot first-run migration from the active profile.
            bool preserveCursorMode = UseCursorClick;
            string preserveCursorButton = CursorClickButton;
            var defaults = new AppSettingsManager.AppSettings
            {
                UseCursorClick = preserveCursorMode,
                CursorClickButton = preserveCursorButton,
                CursorClickDelayMs = 100,
                CursorClickDelayJitterPct = 1,
                CursorClickUseJitter = false,
                CursorClickHoldMs = 10,
                CursorClickPositionJitter = 1,
                CursorClickUsePositionJitter = false,
                CursorClickLoops = 0,
                CursorClickUseLoops = false,
                CursorClickIntervalMs = 200,
                CursorClickUseInterval = false,
                CursorClickMaxDurationMs = 60000,
                CursorClickUseMaxDuration = false,
                CursorClickGameMove = false,
            };
            AppSettingsManager.Save(defaults);

            profileController.ResetProfile();

            // Sync bridge state from defaults
            CustomDelay = defaults.CustomDelay.ToString();
            UseCustomDelay = defaults.UseCustomDelay;
            DelayVariation = defaults.DelayVariation.ToString();
            UseDelayVariation = defaults.UseDelayVariation;
            LoopCount = defaults.LoopCount.ToString();
            EnableLoop = defaults.EnableLoop;
            LoopInterval = defaults.LoopInterval.ToString();
            LoopIntervalEnabled = defaults.LoopIntervalEnabled;
            // Smooth-movement settings live on ActionReplayer statics (not bridge props) — reset
            // those too, otherwise the runtime + the UI (PushSettingsLoaded reads the statics)
            // would keep the user's old values while disk holds the defaults.
            ActionReplayer.SmoothMovement = defaults.SmoothMovement;
            ActionReplayer.MoveStepPx = defaults.MoveStepPx;
            ActionReplayer.MoveStepDelayMs = defaults.MoveStepDelayMs;
            ActionReplayer.MoveClickDelayMs = defaults.MoveClickDelayMs;
            ActionReplayer.FastApproach = defaults.FastApproach;
            ActionReplayer.SettleDistancePx = defaults.SettleDistancePx;
            UseCursorClick = defaults.UseCursorClick;       // preserved above
            CursorClickButton = defaults.CursorClickButton; // preserved above
            CursorClickStartHotkey = defaults.CursorClickStartHotkey;
            CursorClickPauseHotkey = defaults.CursorClickPauseHotkey;
            // Reset Clicker v2 settings to real defaults
            CursorClickDelay = defaults.CursorClickDelayMs.ToString();
            CursorClickDelayJitter = defaults.CursorClickDelayJitterPct.ToString();
            CursorClickUseJitter = defaults.CursorClickUseJitter;
            CursorClickHold = defaults.CursorClickHoldMs.ToString();
            CursorClickPositionJitter = defaults.CursorClickPositionJitter.ToString();
            CursorClickUsePositionJitter = defaults.CursorClickUsePositionJitter;
            CursorClickLoops = defaults.CursorClickLoops.ToString();
            CursorClickUseLoops = defaults.CursorClickUseLoops;
            CursorClickInterval = defaults.CursorClickIntervalMs.ToString();
            CursorClickUseInterval = defaults.CursorClickUseInterval;
            CursorClickMaxDuration = defaults.CursorClickMaxDurationMs.ToString();
            CursorClickUseMaxDuration = defaults.CursorClickUseMaxDuration;
            CursorClickGameMove = defaults.CursorClickGameMove;
            // Area and Fixed were written to DISK as cleared by the `defaults` object above but
            // never mirrored back into the bridge, so PushSettingsLoaded kept showing the old
            // rect/point and the next SaveGlobalSettings wrote them straight back — the reset
            // silently failed for exactly the two settings a user most wants cleared.
            CursorClickUseArea = defaults.CursorClickUseArea;
            CursorClickArea = null;
            CursorClickUseFixed = defaults.CursorClickUseFixed;
            CursorClickFixedPoint = null;
            RecordMouse = defaults.RecordMouse;
            RecordScroll = defaults.RecordScroll;
            RecordKeyboard = defaults.RecordKeyboard;
            RecordCombinedInput = defaults.RecordCombinedInput;
            ProfileKeyEnabled = defaults.ProfileKeyEnabled;
            BrowserSelectorEnabled = defaults.BrowserSelectorEnabled;

            // Reset window settings
            UserProfile.Current.AlwaysOnTop = defaults.AlwaysOnTop;
            UserProfile.Current.MinimizeToTray = defaults.MinimizeToTray;
            UserProfile.Current.StartMinimized = defaults.StartMinimized;
            UserProfile.Current.RunEndFlash = defaults.RunEndFlash;
            UserProfile.Current.RunEndSound = defaults.RunEndSound;
            TrayIconService.SetRunOnStartup(defaults.RunOnStartup);
            window.UpdateAlwaysOnTop(defaults.AlwaysOnTop);

            ApplyProfile(UserProfile.Current);
            profileController.UpdateProfileColors(null);
            CurrentProfileName = "No Profile";
            CurrentProfilePath = null;
            HasUnsavedChanges = false;
            ClearLoopEdit();
            PushProfileLoop();
            PushSettingsLoaded();
            // Distinct signal for "the user explicitly reset everything" — used by the
            // Clicker panel to bounce its local UI state (e.g. the /s ↔ ms unit toggle)
            // back to its default. Plain settings:loaded fires too often (mode toggle, tray,
            // every settings:change) so a dedicated message keeps the protocol clear.
            // (It does NOT fire on a profile switch — that claim used to be here and was wrong;
            // it is precisely why the per-profile loop needed its own profile:loop push.)
            SendMessage("settings:reset", new { });
            PushProfilesUpdate();
            PushToolbarUpdate();
            PushStatusBarUpdate();
            TrayIconService.UpdateTrayIcon();
        }

        // Returns the instance it just persisted so a caller can hand it straight to
        // PushSettingsLoaded and skip that method's disk re-read (same handler only).
        private AppSettingsManager.AppSettings SaveGlobalSettings()
        {
            // ONE read for the three disk-owned fields below (RunOnStartup / RunAsAdmin /
            // HasAcknowledgedImportWarning — the bridge holds no field for any of them).
            // AppSettingsManager.Load() is not cached, so calling it once per field meant three
            // full read+parse cycles per save, and this method runs on every settings:change.
            var disk = AppSettingsManager.Load();
            var s = new AppSettingsManager.AppSettings
            {
                AlwaysOnTop = UserProfile.Current.AlwaysOnTop,
                MinimizeToTray = UserProfile.Current.MinimizeToTray,
                // Persist the user's intent, not the registry state. On dev/portable builds
                // SetRunOnStartup is a no-op (WindowShellServices guards on IsInstalledLocation),
                // so sourcing this from the registry would keep resetting the toggle to off.
                RunOnStartup = disk.RunOnStartup,
                StartMinimized = UserProfile.Current.StartMinimized,
                RunEndFlash = UserProfile.Current.RunEndFlash,
                RunEndSound = UserProfile.Current.RunEndSound,
                UseCustomDelay = UseCustomDelay,
                CustomDelay = int.TryParse(CustomDelay, out var d) ? d : 100,
                UseDelayVariation = UseDelayVariation,
                DelayVariation = int.TryParse(DelayVariation, out var dv) ? dv : 1,
                // The mirrors are the "No Profile" fallback and nothing else — a loaded profile's
                // value never reaches them (HandleProfileLoopSettingChange writes the profile
                // object instead), so persisting them here cannot leak a profile value into the
                // global. Fallback is 1, not 0: 0 is no longer an authorable macro loop count.
                EnableLoop = EnableLoop,
                LoopCount = int.TryParse(LoopCount, out var c) ? UserProfile.NormalizeLoopCount(c) : UserProfile.MinLoopCount,
                LoopIntervalEnabled = LoopIntervalEnabled,
                LoopInterval = int.TryParse(LoopInterval, out var li) ? li : 200,
                SmoothMovement = ActionReplayer.SmoothMovement,
                MoveStepPx = ActionReplayer.MoveStepPx,
                MoveStepDelayMs = ActionReplayer.MoveStepDelayMs,
                MoveClickDelayMs = ActionReplayer.MoveClickDelayMs,
                FastApproach = ActionReplayer.FastApproach,
                SettleDistancePx = ActionReplayer.SettleDistancePx,
                UseCursorClick = UseCursorClick,
                CursorClickButton = CursorClickButton,
                CursorClickStartHotkey = CursorClickStartHotkey,
                CursorClickPauseHotkey = CursorClickPauseHotkey,
                // Clicker v2 — persist the dedicated Clicker settings alongside the legacy ones.
                CursorClickDelayMs = int.TryParse(CursorClickDelay, out var ccd) ? ccd : 100,
                CursorClickDelayJitterPct = int.TryParse(CursorClickDelayJitter, out var ccdj) ? ccdj : 1,
                CursorClickUseJitter = CursorClickUseJitter,
                CursorClickHoldMs = int.TryParse(CursorClickHold, out var cch) ? cch : 10,
                CursorClickPositionJitter = int.TryParse(CursorClickPositionJitter, out var ccpj) ? ccpj : 1,
                CursorClickUsePositionJitter = CursorClickUsePositionJitter,
                CursorClickUseArea = CursorClickUseArea,
                // On-disk schema stays 5 fields for forward-compat. When the rect is null,
                // we write zeros — Load above treats W=H=0 as "no rect" and projects back to null.
                CursorClickAreaX = CursorClickArea?.X ?? 0,
                CursorClickAreaY = CursorClickArea?.Y ?? 0,
                CursorClickAreaW = CursorClickArea?.W ?? 0,
                CursorClickAreaH = CursorClickArea?.H ?? 0,
                CursorClickUseFixed = CursorClickUseFixed,
                CursorClickFixedPointSet = CursorClickFixedPoint is not null,
                CursorClickFixedX = CursorClickFixedPoint?.X ?? 0,
                CursorClickFixedY = CursorClickFixedPoint?.Y ?? 0,
                CursorClickLoops = int.TryParse(CursorClickLoops, out var ccl) ? ccl : 0,
                CursorClickUseLoops = CursorClickUseLoops,
                CursorClickIntervalMs = int.TryParse(CursorClickInterval, out var cci) ? cci : 0,
                CursorClickUseInterval = CursorClickUseInterval,
                CursorClickMaxDurationMs = int.TryParse(CursorClickMaxDuration, out var mdSave) ? mdSave : 60000,
                CursorClickUseMaxDuration = CursorClickUseMaxDuration,
                CursorClickGameMove = CursorClickGameMove,
                RecordMouse = RecordMouse,
                RecordScroll = RecordScroll,
                RecordKeyboard = RecordKeyboard,
                RecordCombinedInput = RecordCombinedInput,
                RecordingHotkey = UserProfile.Current.RecordingHotkey,
                ReplayHotkey = UserProfile.Current.ReplayHotkey,
                ProfileKeyToggleHotkey = UserProfile.Current.ProfileKeyToggleHotkey,
                ForegroundHotkey = UserProfile.Current.ForegroundHotkey,
                ModeToggleHotkey = UserProfile.Current.ModeToggleHotkey,
                CaptureSlotHotkey = UserProfile.Current.CaptureSlotHotkey,
                ProfileKeyEnabled = ProfileKeyEnabled,
                BrowserSelectorEnabled = BrowserSelectorEnabled,
                RunAsAdmin = disk.RunAsAdmin,
                AutomationEnabled = UserProfile.Current.AutomationEnabled,
                // Disk-owned, like RunOnStartup/RunAsAdmin above: the bridge holds no field for it,
                // so leaving it out of this initializer wrote the class default (false) back on every
                // save — and this method runs on EVERY settings:change. The import security warning
                // re-armed itself after the user had ticked "Don't show again".
                HasAcknowledgedImportWarning = disk.HasAcknowledgedImportWarning,
            };
            AppSettingsManager.Save(s);
            return s;
        }

        private static readonly HashSet<string> ProfileLoopSettingKeys = new()
        {
            "profileLoopCount", "profileEnableLoop", "profileLoopInterval", "profileLoopIntervalEnabled"
        };

        /// <summary>
        /// Applies a Loops / Interval edit to whichever scope owns it: the loaded profile
        /// (kept in memory, written by Ctrl+S / Save) or, under "No Profile", the app-level
        /// fallback (written through immediately — it has no Save button of its own).
        /// One handler for both scopes so the Settings row stays a single code path.
        /// </summary>
        private void HandleProfileLoopSettingChange(string key, JsonElement value)
        {
            bool scoped = CurrentProfileName != "No Profile";
            var p = UserProfile.Current;

            switch (key)
            {
                case "profileLoopCount":
                {
                    // The chip floors at 1 client-side; this is the backstop for a hand-sent or
                    // version-skewed message. Non-numeric text (the field takes free text when
                    // `format` is off) parses to nothing and must not become 0 = forever.
                    int n = int.TryParse(value.GetString(), out var c) ? c : UserProfile.MinLoopCount;
                    n = UserProfile.NormalizeLoopCount(n);
                    if (scoped) p.LoopCount = n; else LoopCount = n.ToString();
                    break;
                }
                case "profileEnableLoop":
                {
                    bool on = value.GetBoolean();
                    if (scoped) p.EnableLoop = on; else EnableLoop = on;
                    break;
                }
                case "profileLoopInterval":
                {
                    int n = int.TryParse(value.GetString(), out var i) && i >= 0 ? i : 0;
                    if (scoped) p.LoopInterval = n; else LoopInterval = n.ToString();
                    break;
                }
                case "profileLoopIntervalEnabled":
                {
                    bool on = value.GetBoolean();
                    if (scoped) p.LoopIntervalEnabled = on; else LoopIntervalEnabled = on;
                    break;
                }
            }

            if (scoped)
            {
                // Deliberately NOT autosaved: D1 is "the normal Save owns this". An autosaving
                // Loops row sitting next to an Interval row that waits for Ctrl+S would be the
                // worst of both. HasUnsavedLoopChange (not HasUnsavedChanges) so an armed
                // automation keeps firing — see the flag's declaration.
                MarkLoopEdited();
            }
            else
            {
                // No profile loaded → the mirrors ARE the global, so write them straight through.
                SaveGlobalSettings();
            }

            PushProfileLoop();
        }

        private static readonly HashSet<string> HotkeySettingKeys = new()
        {
            "recordingHotkey", "replayHotkey", "profileKeyToggleHotkey", "foregroundHotkey", "modeToggleHotkey", "captureSlotHotkey"
        };

        private static readonly Dictionary<string, string> HotkeyDisplayNames = new()
        {
            ["recordingHotkey"] = "Recording",
            ["replayHotkey"] = "Replay",
            ["profileKeyToggleHotkey"] = "Profile Key Toggle",
            ["foregroundHotkey"] = "Foreground",
            ["modeToggleHotkey"] = "Mode Toggle",
            ["captureSlotHotkey"] = "Capture to Slot",
        };

        /// <summary>
        /// True when targets A and B could plausibly match the same window at the same time
        /// — i.e. their hotkeys/hotstrings would compete. Used to surface conflicts when
        /// assigning/removing hotkeys. Empty fields (ProcessName or WindowTitle) act as
        /// wildcards: <c>{Process=chrome.exe}</c> overlaps <c>{Process=chrome.exe, Title=GitHub}</c>
        /// because the first matches every chrome window including the second's.
        ///
        /// We prefer false positives over false negatives — a spurious "may conflict" warning
        /// is better than silently registering two competing hotkeys.
        /// </summary>
        private static bool EffectiveTargetsOverlap(WindowTarget? a, WindowTarget? b)
        {
            if (a == null || b == null) return true;   // one is global → overlaps everything

            // Process compatibility: empty on either side is a wildcard.
            string aProc = (a.ProcessName ?? "").Trim();
            string bProc = (b.ProcessName ?? "").Trim();
            bool processCompatible = aProc.Length == 0 || bProc.Length == 0
                || aProc.Equals(bProc, StringComparison.OrdinalIgnoreCase);
            if (!processCompatible) return false;

            // Title compatibility: empty on either side is a wildcard.
            string aTitle = (a.WindowTitle ?? "").Trim();
            string bTitle = (b.WindowTitle ?? "").Trim();
            if (aTitle.Length == 0 || bTitle.Length == 0) return true;

            string aMode = a.TitleMatchMode ?? "contains";
            string bMode = b.TitleMatchMode ?? "contains";

            // Mixed modes or any regex: regex intersection is non-trivial. Conflict check is
            // the right place to err on the side of paranoia, so report overlap.
            if (aMode != bMode || aMode == "regex") return true;

            // Both contains: overlap if either substring contains the other (case-insensitive).
            return aTitle.IndexOf(bTitle, StringComparison.OrdinalIgnoreCase) >= 0
                || bTitle.IndexOf(aTitle, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private string? GetHotkeyConflict(string hotkey, string? excludeSettingKey, string? excludeProfileName = null, WindowTarget? effectiveTarget = null)
        {
            if (string.IsNullOrEmpty(hotkey)) return null;

            // Global hotkeys always conflict (they have no window target)
            var globalHotkeys = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["recordingHotkey"] = UserProfile.Current.RecordingHotkey,
                ["replayHotkey"] = UserProfile.Current.ReplayHotkey,
                ["profileKeyToggleHotkey"] = UserProfile.Current.ProfileKeyToggleHotkey,
                ["foregroundHotkey"] = UserProfile.Current.ForegroundHotkey,
                ["modeToggleHotkey"] = UserProfile.Current.ModeToggleHotkey,
                ["captureSlotHotkey"] = UserProfile.Current.CaptureSlotHotkey,
            };

            foreach (var kv in globalHotkeys)
            {
                if (kv.Key == excludeSettingKey) continue;
                if (string.Equals(kv.Value, hotkey, StringComparison.OrdinalIgnoreCase))
                    return HotkeyDisplayNames.GetValueOrDefault(kv.Key, kv.Key);
            }

            foreach (var entry in profileController.ProfileEntries)
            {
                if (entry.Name == excludeProfileName) continue;
                if (!string.Equals(entry.Hotkey, hotkey, StringComparison.OrdinalIgnoreCase)) continue;

                var otherTarget = profileController.GetEffectiveWindowTarget(entry.Name);
                if (EffectiveTargetsOverlap(effectiveTarget, otherTarget))
                    return $"Profile \"{entry.Name}\"";
            }

            return null;
        }

        private void HandleSettingsChange(JsonElement payload)
        {
            string key = payload.GetProperty("key").GetString() ?? "";
            var valueElement = payload.GetProperty("value");

            // ── Per-profile loop, routed out before the switch ──
            // Distinct message keys ("profileLoopCount", …) rather than the old global ones, and
            // an EARLY RETURN, because this method ends with an unconditional SaveGlobalSettings()
            // outside the switch (see the tail). Letting a profile-scoped edit fall through there
            // would stamp the edited profile's loop count into appsettings.json — the "global"
            // would silently become "whatever profile I touched last", breaking the No-Profile
            // fallback and undoing the whole point of a per-profile value.
            if (ProfileLoopSettingKeys.Contains(key))
            {
                HandleProfileLoopSettingChange(key, valueElement);
                return;
            }

            // Validate hotkey uniqueness before applying
            if (HotkeySettingKeys.Contains(key))
            {
                string newHotkey = valueElement.GetString() ?? "";
                var conflict = GetHotkeyConflict(newHotkey, excludeSettingKey: key);
                if (conflict != null)
                {
                    SendMessage("alert:show", new { message = $"\"{newHotkey}\" is already used by {conflict}." });
                    PushSettingsLoaded(); // revert UI to current value
                    return;
                }
            }

            switch (key)
            {
                case "customDelay":
                    CustomDelay = valueElement.GetString() ?? "100";
                    break;
                case "useCustomDelay":
                    UseCustomDelay = valueElement.GetBoolean();
                    break;
                case "delayVariation":
                    DelayVariation = valueElement.GetString() ?? "1";
                    break;
                case "useDelayVariation":
                    UseDelayVariation = valueElement.GetBoolean();
                    break;
                // The legacy loopCount / enableLoop / loopInterval / loopIntervalEnabled cases
                // used to live here. They are gone on purpose: those four are per-profile now
                // and are routed by HandleProfileLoopSettingChange above, which returns BEFORE
                // this switch's unconditional SaveGlobalSettings() tail.
                // Smooth mouse movement (interpolated cursor path). See ActionReplayer.SmoothMovement.
                case "smoothMovement":
                    ActionReplayer.SmoothMovement = valueElement.GetBoolean();
                    break;
                case "moveStepPx":
                    if (int.TryParse(valueElement.GetString(), out int mvStep))
                        ActionReplayer.MoveStepPx = Math.Clamp(mvStep, 0, 2000);
                    break;
                case "moveStepDelay":
                    if (int.TryParse(valueElement.GetString(), out int mvStepDelay))
                        ActionReplayer.MoveStepDelayMs = Math.Clamp(mvStepDelay, 0, 100);
                    break;
                case "moveClickDelay":
                    if (int.TryParse(valueElement.GetString(), out int mcDelay))
                        ActionReplayer.MoveClickDelayMs = Math.Clamp(mcDelay, 0, 1000);
                    break;
                // Fast approach (jump-and-settle). See ActionReplayer.FastApproach.
                case "fastApproach":
                    ActionReplayer.FastApproach = valueElement.GetBoolean();
                    break;
                case "settleDistance":
                    if (int.TryParse(valueElement.GetString(), out int settleDist))
                        ActionReplayer.SettleDistancePx = Math.Clamp(settleDist, 0, 4000);
                    break;
                case "useCursorClick":
                    SetCursorClickMode(valueElement.GetBoolean());
                    break;
                case "cursorClickButton":
                    CursorClickButton = valueElement.GetString() ?? "Left";
                    break;
                // Clicker hotkeys — intentionally NOT in HotkeySettingKeys, so they skip the
                // global-conflict check: the user may deliberately reuse a global hotkey (the two
                // are mode-gated and never both fire). Setters mirror the value into the hook.
                // DropBareWheelHotkey: the hook only dispatches MODIFIED wheel combos as global
                // hotkeys — swallowing a bare wheel event would kill that scroll direction
                // system-wide — so a bare ScrollUp/ScrollDown here would store a binding that
                // can never fire. The capture UI already refuses it; this is the same guard on
                // the message boundary, for a payload that did not come from that UI.
                case "cursorClickStartHotkey":
                    CursorClickStartHotkey = DropBareWheelHotkey(valueElement.GetString() ?? "PageDown", key);
                    break;
                case "cursorClickPauseHotkey":
                    CursorClickPauseHotkey = DropBareWheelHotkey(valueElement.GetString() ?? "PageUp", key);
                    break;
                // ── Clicker v2 settings (dedicated, decoupled from profile) ──
                // Every numeric goes through ClampNumeric so the value that lands on disk is
                // already in range — matching the clamping the macro knobs above already do.
                // Ranges mirror the engine (ActionExecution.ToggleCursorClickReplay).
                case "cursorClickDelay":
                    CursorClickDelay = ClampNumeric(valueElement.GetString(), 1, 60000, 100);
                    break;
                case "cursorClickDelayJitter":
                    CursorClickDelayJitter = ClampNumeric(valueElement.GetString(), 0, 100, 1);
                    break;
                case "cursorClickUseJitter":
                    CursorClickUseJitter = valueElement.GetBoolean();
                    break;
                case "cursorClickHold":
                    CursorClickHold = ClampNumeric(valueElement.GetString(), 0, 2000, 10);
                    break;
                case "cursorClickPositionJitter":
                    CursorClickPositionJitter = ClampNumeric(valueElement.GetString(), 0, 500, 1);
                    break;
                case "cursorClickUsePositionJitter":
                    CursorClickUsePositionJitter = valueElement.GetBoolean();
                    break;
                case "cursorClickUseArea":
                    CursorClickUseArea = valueElement.GetBoolean();
                    break;
                case "cursorClickArea":
                    // Null → clear the saved rect. Object → { x, y, w, h }, all required.
                    // Defensive: a malformed payload missing any of the 4 numeric fields
                    // would throw JsonException via GetInt32 and the outer try/catch would
                    // swallow it, leaving the area in an inconsistent state. TryGet each
                    // field with a fallback so partial payloads are at least ignored
                    // predictably instead of crashing through the error handler.
                    if (valueElement.ValueKind == JsonValueKind.Null)
                    {
                        CursorClickArea = null;
                    }
                    else if (valueElement.ValueKind == JsonValueKind.Object
                        && valueElement.TryGetProperty("x", out var caXEl) && caXEl.ValueKind == JsonValueKind.Number
                        && valueElement.TryGetProperty("y", out var caYEl) && caYEl.ValueKind == JsonValueKind.Number
                        && valueElement.TryGetProperty("w", out var caWEl) && caWEl.ValueKind == JsonValueKind.Number
                        && valueElement.TryGetProperty("h", out var caHEl) && caHEl.ValueKind == JsonValueKind.Number)
                    {
                        CursorClickArea = new ClickArea(caXEl.GetInt32(), caYEl.GetInt32(), caWEl.GetInt32(), caHEl.GetInt32());
                    }
                    // Else: ignore malformed payload — leave CursorClickArea unchanged.
                    break;
                case "cursorClickUseFixed":
                    CursorClickUseFixed = valueElement.GetBoolean();
                    break;
                case "cursorClickFixedPoint":
                    // Null → clear the picked point (revert to lock-on-start). Object → { x, y }.
                    // Defensive TryGet like cursorClickArea so a partial payload is ignored, not
                    // thrown through the outer catch into an inconsistent state.
                    if (valueElement.ValueKind == JsonValueKind.Null)
                    {
                        CursorClickFixedPoint = null;
                    }
                    else if (valueElement.ValueKind == JsonValueKind.Object
                        && valueElement.TryGetProperty("x", out var fpXEl) && fpXEl.ValueKind == JsonValueKind.Number
                        && valueElement.TryGetProperty("y", out var fpYEl) && fpYEl.ValueKind == JsonValueKind.Number)
                    {
                        CursorClickFixedPoint = new ClickPoint(fpXEl.GetInt32(), fpYEl.GetInt32());
                    }
                    break;
                case "cursorClickLoops":
                    // 0 is legal and means unbounded, so the floor is 0, not 1.
                    CursorClickLoops = ClampNumeric(valueElement.GetString(), 0, 100000, 0);
                    break;
                case "cursorClickUseLoops":
                    CursorClickUseLoops = valueElement.GetBoolean();
                    break;
                case "cursorClickInterval":
                    CursorClickInterval = ClampNumeric(valueElement.GetString(), 0, 60000, 0);
                    break;
                case "cursorClickUseInterval":
                    CursorClickUseInterval = valueElement.GetBoolean();
                    break;
                case "cursorClickMaxDuration":
                    // Floor 1000: a sub-second cap would end the run before the 200 ms
                    // hotkey-release grace, which reads as "the clicker did nothing".
                    CursorClickMaxDuration = ClampNumeric(valueElement.GetString(), 1000, 86400000, 60000);
                    break;
                case "cursorClickUseMaxDuration":
                    CursorClickUseMaxDuration = valueElement.GetBoolean();
                    break;
                case "cursorClickGameMove":
                    CursorClickGameMove = valueElement.GetBoolean();
                    break;
                case "recordMouse":
                    RecordMouse = valueElement.GetBoolean();
                    break;
                case "recordScroll":
                    RecordScroll = valueElement.GetBoolean();
                    break;
                case "recordKeyboard":
                    RecordKeyboard = valueElement.GetBoolean();
                    break;
                case "recordCombinedInput":
                    RecordCombinedInput = valueElement.GetBoolean();
                    break;
                case "profileKeyEnabled":
                    ProfileKeyEnabled = valueElement.GetBoolean();
                    UserProfile.Current.ProfileKeyEnabled = ProfileKeyEnabled;
                    TrayIconService.UpdateTrayIcon();
                    break;
                case "browserSelectorEnabled":
                    BrowserSelectorEnabled = valueElement.GetBoolean();
                    // If recording is active, sync browser extension immediately
                    if (recordingService.IsRecording)
                        browserBridge?.SetRecordingMode(BrowserSelectorEnabled);
                    break;
                case "recordingHotkey":
                    UserProfile.Current.RecordingHotkey = valueElement.GetString() ?? "Ctrl+PageUp";
                    break;
                case "replayHotkey":
                    UserProfile.Current.ReplayHotkey = valueElement.GetString() ?? "Ctrl+PageDown";
                    break;
                case "profileKeyToggleHotkey":
                    UserProfile.Current.ProfileKeyToggleHotkey = valueElement.GetString() ?? "Pause";
                    break;
                case "foregroundHotkey":
                    UserProfile.Current.ForegroundHotkey = valueElement.GetString() ?? "Insert";
                    break;
                case "modeToggleHotkey":
                    UserProfile.Current.ModeToggleHotkey = valueElement.GetString() ?? "ScrollLock";
                    break;
                case "captureSlotHotkey":
                    // Empty = disabled (the default) — clearing the input turns the feature off.
                    UserProfile.Current.CaptureSlotHotkey = valueElement.GetString() ?? "";
                    break;
                case "runAsAdmin":
                    {
                        // Save directly — RunAsAdmin is read from file, not a runtime field
                        var current = AppSettingsManager.Load();
                        current.RunAsAdmin = valueElement.GetBoolean();
                        AppSettingsManager.Save(current);
                    }
                    break;
            }

            // Echo updated settings back to React so controlled components update. Passing the
            // just-saved instance spares PushSettingsLoaded its disk re-read (same handler, so
            // no staleness window — see the parameter's comment).
            PushSettingsLoaded(SaveGlobalSettings());
            // Mode change affects record/replay button enable/text and tray icon color.
            if (key == "useCursorClick")
            {
                PushButtonStates();
                TrayIconService.UpdateTrayIcon();
            }
        }

        private void HandleAlwaysOnTop(JsonElement payload)
        {
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            UserProfile.Current.AlwaysOnTop = enabled;
            window.UpdateAlwaysOnTop(enabled);
            SaveGlobalSettings();
            PushSettingsLoaded();
        }

        private void HandleMinimizeToTray(JsonElement payload)
        {
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            UserProfile.Current.MinimizeToTray = enabled;
            SaveGlobalSettings();
            PushSettingsLoaded();
        }

        private void HandleRunOnStartup(JsonElement payload)
        {
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            // SetRunOnStartup persists the intent to AppSettings unconditionally (and writes the
            // registry only on installed builds — WindowShellServices guards on IsInstalledLocation).
            // The read-back sites now source RunOnStartup from AppSettings, so the toggle sticks even
            // on dev/portable copies where the registry write is intentionally skipped.
            TrayIconService.SetRunOnStartup(enabled);
            PushSettingsLoaded();
        }

        private void HandleStartMinimized(JsonElement payload)
        {
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            UserProfile.Current.StartMinimized = enabled;
            SaveGlobalSettings();
            PushSettingsLoaded();
        }

        private void HandleRunEndFlash(JsonElement payload)
        {
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            UserProfile.Current.RunEndFlash = enabled;
            SaveGlobalSettings();
            PushSettingsLoaded();
        }

        private void HandleRunEndSound(JsonElement payload)
        {
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            UserProfile.Current.RunEndSound = enabled;
            SaveGlobalSettings();
            PushSettingsLoaded();
        }

        // Out-of-window run-end notification. Best-effort. Thread contract: every
        // status push that reaches here is dispatcher-enqueued (the replay
        // continuation wraps its pushes in dispatcherQueue.TryEnqueue), so this
        // runs on the UI thread — which keeps WindowNative.GetWindowHandle(window)
        // safe. The Win32 calls themselves (FlashWindowEx / MessageBeep /
        // GetForegroundWindow) are thread-agnostic. Never let a notification
        // failure break a status push.
        // True for the instant between a lap notice firing and the run's own end-of-run cue,
        // so the two don't stack two chimes on top of each other.
        private bool _lapNoticeJustFired;

        /// <summary>
        /// A cursor-mode run just consumed the LAST data row: the list finished a full pass
        /// and the next run wraps to row 1. Fired IMMEDIATELY rather than deferred to
        /// NotifyRunEnded — that cue only fires when the status actually passed through
        /// "replaying", which a 2 ms profile (Ctrl+A + one SendText is the realistic case)
        /// never does, so deferring silently dropped the notice on exactly the profiles this
        /// feature exists for. The engine already raises this at the END of the run, so
        /// firing here is the same moment, minus the dependency.
        /// </summary>
        public void ArmDataLapNotice(int rows)
        {
            _lapNoticeJustFired = true;
            try
            {
                // The tray balloon is the only surface that reaches the user over a
                // full-screen game, and unlike the chime it carries the actual numbers.
                // Deliberately not gated on RunEndFlash/RunEndSound: those govern the
                // per-run cue, whereas finishing the list is a rare, explicitly opted-in
                // event (the Data panel toggle already decided it should be announced).
                Services.TrayIconService.ShowBalloon(
                    "Data list complete",
                    $"All {rows} rows used — the next run starts over at row 1.");

                // NOT gated on RunEndSound either, for the same reason as the balloon and it
                // matters more here: RunEndSound governs the cue that fires after EVERY run,
                // which is exactly why people switch it off — while finishing the list is a
                // rare event the user opted into per-table. Riding that setting would leave
                // the feature silent for the very users who asked for it. MessageBeep still
                // honours the Windows sound scheme, so "No Sounds" is respected.
                NativeMethods.MessageBeep(NativeMethods.MB_ICONASTERISK_BEEP);

                DiagnosticLog.Info($"Data list complete — all {rows} row(s) used; cursor wraps to row 1 (chime + tray balloon)");
            }
            catch (Exception ex)
            {
                // Never let a notification failure disturb the run that triggered it.
                DiagnosticLog.Warn($"Lap notice failed: {ex.Message}");
            }
        }

        private void NotifyRunEnded(bool error)
        {
            // A lap notice for THIS run already chimed; don't chime again on top of it.
            bool lapJustFired = _lapNoticeJustFired;
            _lapNoticeJustFired = false;

            try
            {
                if (!UserProfile.Current.RunEndFlash && !UserProfile.Current.RunEndSound)
                    return;
                var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
                // Foreground = the user is already looking at us; the in-window
                // status change is enough.
                if (NativeMethods.GetForegroundWindow() == hwnd)
                    return;
                if (UserProfile.Current.RunEndFlash)
                {
                    var fw = new NativeMethods.FLASHWINFO
                    {
                        cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.FLASHWINFO>(),
                        hwnd = hwnd,
                        // Flash the taskbar button until the window regains foreground —
                        // the standard "something finished in the background" affordance.
                        dwFlags = NativeMethods.FLASHW_TRAY | NativeMethods.FLASHW_TIMERNOFG,
                        uCount = 0,
                        dwTimeout = 0,
                    };
                    NativeMethods.FlashWindowEx(ref fw);
                }
                // Skipped when a lap notice just played its own Asterisk chime for this same
                // run — two chimes back to back read as a glitch, not as two facts. An error
                // still wins: a failure must be heard even if the list also finished.
                if (UserProfile.Current.RunEndSound && (error || !lapJustFired))
                {
                    // System sound scheme's chime — respects the user's scheme
                    // (including "No Sounds") and needs no bundled asset.
                    NativeMethods.MessageBeep(error ? NativeMethods.MB_ICONERROR_BEEP : NativeMethods.MB_OK_BEEP);
                }
            }
            catch (Exception ex)
            {
                TrueReplayer.Services.DiagnosticLog.Error("Run-end notification failed", ex);
            }
        }

        // ── Collection change handler ──

        private void OnActionsChanged(object? sender, NotifyCollectionChangedEventArgs e)
        {
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;

            if (e.Action == NotifyCollectionChangedAction.Add)
                HasUnsavedChanges = true;

            // Not PushActionsUpdate: a collection change cannot alter the data table, and this
            // handler runs inside the input-hook callback on every recorded action. See
            // PushActionListOnly for who is responsible for the data table instead.
            PushActionListOnly();
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            actions.CollectionChanged -= OnActionsChanged;

            // Unsubscribe every browserBridge event so the BrowserBridgeService doesn't hold
            // delegates that capture `this` (the now-disposed WebViewBridge). Without these,
            // a later browser event firing post-dispose would invoke the stale lambdas, which
            // call into SendMessage / dispatcherQueue on the dead bridge. The handler fields
            // are null-coalesced so a partial init (browserBridge was null at construction)
            // doesn't NRE here.
            if (browserBridge != null)
            {
                if (_onBrowserConnectionChanged != null) browserBridge.ConnectionChanged -= _onBrowserConnectionChanged;
                if (_onBrowserExtensionVersionMismatch != null) browserBridge.ExtensionVersionMismatch -= _onBrowserExtensionVersionMismatch;
                if (_onBrowserElementClicked != null) browserBridge.ElementClicked -= _onBrowserElementClicked;
                if (_onBrowserTypingCaptured != null) browserBridge.TypingCaptured -= _onBrowserTypingCaptured;
                if (_onBrowserSelectInteractionStarted != null) browserBridge.SelectInteractionStarted -= _onBrowserSelectInteractionStarted;
                if (_onBrowserSelectInteractionEnded != null) browserBridge.SelectInteractionEnded -= _onBrowserSelectInteractionEnded;
                if (_onBrowserSelectChanged != null) browserBridge.SelectChanged -= _onBrowserSelectChanged;
            }
            // Stop the select-interaction safety timer if it's still armed — otherwise its
            // 15s callback would fire on a dead dispatcher.
            _selectInteractionTimer?.Dispose();
            _selectInteractionTimer = null;

            // Tear down the window-detection low-level mouse hook if a detect session was active
            // when the bridge was disposed — otherwise the global hook leaks and its callback
            // would fire into a dead instance.
            StopWindowDetection();
        }
    }
}
