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
        public string DelayVariation { get; set; } = "20";
        public bool UseDelayVariation { get; set; } = false;
        public string LoopCount { get; set; } = "0";
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
        public string CursorClickDelayJitter { get; set; } = "0";
        public bool CursorClickUseJitter { get; set; } = false;
        public string CursorClickHold { get; set; } = "10";
        public string CursorClickPositionJitter { get; set; } = "0";
        public bool CursorClickUsePositionJitter { get; set; } = false;
        // null = no rect saved. CursorClickUseArea is the on/off toggle and is preserved
        // separately so a user can toggle off without losing the saved rect.
        public bool CursorClickUseArea { get; set; } = false;
        public ClickArea? CursorClickArea { get; set; }
        public string CursorClickLoops { get; set; } = "0";
        public bool CursorClickUseLoops { get; set; } = false;
        public string CursorClickInterval { get; set; } = "0";
        public bool CursorClickUseInterval { get; set; } = false;
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
                    _imageBase64Cache.Clear();
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
        // hotkeys, AlwaysOnTop, ProfileKeyEnabled, record toggles, loop/delay — are deliberately
        // left untouched because that object doubles as the live global-settings holder.
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
        private Action<string, string, string?, string?, string?, bool>? _onBrowserElementClicked;
        private Action<string, string, bool>? _onBrowserTypingCaptured;
        private Action? _onBrowserSelectInteractionStarted;
        private Action? _onBrowserSelectInteractionEnded;
        private Action<string, string, string, string>? _onBrowserSelectChanged;

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
                "SendText",
                "WaitImage", "WaitPixelColor", "Pause", "RunProfile",
                "If", "Else", "EndIf",
                "BrowserClick", "BrowserRightClick", "BrowserType",
                "BrowserWaitElement", "BrowserNavigate", "BrowserSelectOption",
            };

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

                _onBrowserElementClicked = (selector, description, url, tagName, button, isInput) =>
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
                            Timeout = 5000
                        };
                        actions.Add(action);
                        HasUnsavedChanges = true;
                        mainController.UpdateButtonStates();
                    });
                };
                browserBridge.ElementClicked += _onBrowserElementClicked;

                // #10 — Typing observed in a recorded input field. Locate the most recent
                // matching BrowserType action for the same selector and fill its text.
                _onBrowserTypingCaptured = (selector, text, isAppend) =>
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
                        int delay = int.TryParse(CustomDelay, out var d) ? d : 100;
                        actions.Add(new ActionItem
                        {
                            ActionType = "BrowserType",
                            Key = selector,
                            BrowserText = text,
                            TypeAppend = isAppend,
                            Delay = delay,
                            Timeout = 5000
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

                _onBrowserSelectChanged = (selector, description, selectedText, _selectedValue) =>
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
                            Timeout = 5000
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
            CursorClickStartHotkey = saved.CursorClickStartHotkey;
            CursorClickPauseHotkey = saved.CursorClickPauseHotkey;
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
            CursorClickDelay = saved.CursorClickDelayMs.ToString();
            CursorClickDelayJitter = saved.CursorClickDelayJitterPct.ToString();
            CursorClickUseJitter = saved.CursorClickUseJitter;
            CursorClickHold = saved.CursorClickHoldMs.ToString();
            CursorClickPositionJitter = saved.CursorClickPositionJitter.ToString();
            CursorClickUsePositionJitter = saved.CursorClickUsePositionJitter;
            CursorClickUseArea = saved.CursorClickUseArea;
            // Project the 5 on-disk fields into the in-memory ClickArea record. Null when
            // dimensions are unset (forward-compat with appsettings.json files that pre-date
            // the area feature).
            CursorClickArea = (saved.CursorClickAreaW > 0 && saved.CursorClickAreaH > 0)
                ? new ClickArea(saved.CursorClickAreaX, saved.CursorClickAreaY, saved.CursorClickAreaW, saved.CursorClickAreaH)
                : null;
            CursorClickLoops = saved.CursorClickLoops.ToString();
            CursorClickUseLoops = saved.CursorClickUseLoops;
            CursorClickInterval = saved.CursorClickIntervalMs.ToString();
            CursorClickUseInterval = saved.CursorClickUseInterval;
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
                    case "replay:toggle": HandleReplayToggle(payload); break;
                    case "replay:resume": HandleReplayResume(payload); break;
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
                    case "actions:reorder": HandleActionsReorder(payload); break;
                    case "actions:convertMode": HandleConvertActionMode(payload); break;
                    case "actions:insertAction": HandleInsertAction(payload); break;
                    case "actions:addElseBranch": HandleActionsAddElseBranch(payload); break;
                    case "actions:insertConditional": HandleActionsInsertConditional(payload); break;
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
            _ => "onPress"
        };

        private static Models.TriggerMode TriggerModeFromString(string? s) => s switch
        {
            "onRelease" => Models.TriggerMode.OnRelease,
            "whilePressed" => Models.TriggerMode.WhilePressed,
            "toggle" => Models.TriggerMode.Toggle,
            _ => Models.TriggerMode.OnPress
        };

        // ── Push methods (C# → React) ──

        public void PushStatusChange(string status)
        {
            if (status.StartsWith("error:"))
            {
                SendMessage("alert:show", new { message = status[6..] });
                status = "ready";
            }

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
                        || (a.ActionType == "If" && string.Equals(a.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase)))
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
                conditionNegate = a.ConditionNegate,
                ifOnProbeError = a.IfOnProbeError,
                browserText = a.BrowserText ?? "",
                newTab = a.NewTab,
                isSkipped = a.IsSkipped,
                isFocusClick = a.IsFocusClick,
                repeatCount = a.RepeatCount,
                // Keystroke × N inter-cycle gap. Forwarded so the edit dialog can
                // restore the user's chosen delay (and the Keystroke replay loop
                // on the C# side already reads it from the action's own property).
                repeatDelayMs = a.RepeatDelayMs,
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
                selectMatchMode = a.SelectMatchMode
            }).ToArray();
        }

        public void PushActionsUpdate()
        {
            var actionsList = ProjectActionsForFrontend();
            SendMessage("actions:updated", new { actions = actionsList });
            PushToolbarUpdate();
            PushStatusBarUpdate();
        }

        private void PushUndoState()
        {
            var snapshot = JsonSerializer.Serialize(actions.ToList(), JsonOptions);
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
            var current = JsonSerializer.Serialize(actions.ToList(), JsonOptions);
            _redoStack.Push(current);
            var snapshot = _undoStack.Pop();
            RestoreActionsFromSnapshot(snapshot);
            mainController.UpdateButtonStates();
        }

        private void HandleRedo()
        {
            if (_redoStack.Count == 0) return;
            var current = JsonSerializer.Serialize(actions.ToList(), JsonOptions);
            _undoStack.Push(current);
            var snapshot = _redoStack.Pop();
            RestoreActionsFromSnapshot(snapshot);
            mainController.UpdateButtonStates();
        }

        private void RestoreActionsFromSnapshot(string snapshot)
        {
            var restored = JsonSerializer.Deserialize<List<ActionItem>>(snapshot, JsonOptions);
            if (restored == null) return;

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
            var profiles = profileController.ProfileEntries.Select(p => new
            {
                name = p.Name,
                filePath = p.FilePath,
                hotkey = p.Hotkey,
                hotstring = p.Hotstring,
                hotstringInstant = p.HotstringInstant,
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
                // Icon of the effective WindowTarget's .exe, base64 PNG. Pure UI augmentation
                // — not persisted, not in the typed ProfileEntry model. The frontend uses
                // effectiveTargetSource to decide opacity (own = 100 %, folder-inherited = 55 %).
                // Null when no target or icon extraction failed (UWP host, portable not in
                // PATH, etc.) — the existing crosshair badge renders as fallback.
                appIconBase64 = AppIconService.GetIconBase64(p.EffectiveTargetProcessName),
                useRelativeCoordinates = p.UseRelativeCoordinates,
                bringToFocus = p.BringToFocus,
                restorePosition = p.RestorePosition,
                restoreSize = p.RestoreSize,
                triggerMode = TriggerModeToString(p.TriggerMode),
                isDisabled = p.IsDisabled,
                // Sharing metadata mirror for sidebar badges + Info tab seed values. The
                // Info tab still calls profile:get-metadata on open to refresh; this is just
                // so the list can render emoji/tags without a round-trip per profile.
                description = p.Description,
                tags = p.Tags,
                iconEmoji = p.IconEmoji,
                profileVersion = p.ProfileVersion,
                createdAt = p.CreatedAt?.ToString("o"),
                updatedAt = p.UpdatedAt?.ToString("o"),
                appMinVersion = p.AppMinVersion
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

        // Build a Clicker run config from the current bridge mirror state. Single source of
        // truth so the Replay-hotkey path (MainWindow) and the toggle-replay message path
        // (HandleReplayToggle) stay in sync — both call this instead of duplicating the
        // string→int parsing and the Area/loop convention logic.
        // Loop convention: cursorClickUseLoops=false → 1 iteration; true + count=0 → infinite (0).
        // Area gate: requires positive W/H — defensive against stale all-zero state.
        public ClickerRunConfig BuildClickerConfig()
        {
            int delay = int.TryParse(CursorClickDelay, out var d) ? d : 100;
            int jitterPercent = int.TryParse(CursorClickDelayJitter, out var jp) ? jp : 0;
            int holdMs = int.TryParse(CursorClickHold, out var h) ? h : 10;
            int positionJitter = CursorClickUsePositionJitter && int.TryParse(CursorClickPositionJitter, out var pj) ? pj : 0;
            int loops = CursorClickUseLoops && int.TryParse(CursorClickLoops, out var lc) && lc >= 0 ? lc : 1;
            int interval = CursorClickUseInterval && int.TryParse(CursorClickInterval, out var li) ? li : 0;
            ClickArea? area = CursorClickUseArea ? CursorClickArea : null;
            return new ClickerRunConfig(delay, CursorClickUseJitter, jitterPercent, loops, interval,
                CursorClickButton, holdMs, positionJitter, area);
        }

        public void PushSettingsLoaded()
        {
            var profile = UserProfile.Current;
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
                    cursorClickLoops = CursorClickLoops,
                    cursorClickUseLoops = CursorClickUseLoops,
                    cursorClickInterval = CursorClickInterval,
                    cursorClickUseInterval = CursorClickUseInterval,
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
                    alwaysOnTop = profile.AlwaysOnTop,
                    minimizeToTray = profile.MinimizeToTray,
                    runOnStartup = TrayIconService.IsRunOnStartup(),
                    startMinimized = profile.StartMinimized,
                    runAsAdmin = AppSettingsManager.Load().RunAsAdmin
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
        }

        public void PushToolbarUpdate()
        {
            SendMessage("toolbar:updated", new
            {
                profileName = CurrentProfileName,
                actionCount = actions.Count
            });
        }

        public void PushStatusBarUpdate()
        {
            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles");

            SendMessage("statusbar:updated", new
            {
                directory = profileDir,
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
        private async Task<bool> CheckUnsavedChangesAsync()
        {
            if (!HasUnsavedChanges || actions.Count == 0)
                return true;

            var result = await profileController.ShowUnsavedChangesDialogAsync();

            if (result == Microsoft.UI.Xaml.Controls.ContentDialogResult.Primary) // Save
            {
                if (CurrentProfilePath != null)
                {
                    var profile = CreateProfileFromState();
                    await SettingsManager.SaveProfileAsync(CurrentProfilePath, profile);
                    return true;
                }
                else
                {
                    bool saved = await profileController.SaveProfileAsync();
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
            PushActionsUpdate();
            PushButtonStates();
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
            };
        }

        // ── Handler methods ──

        private void HandleUIReady()
        {
            // UI loaded successfully — cancel the watchdog timer
            window.CancelUIWatchdog();

            // Send full state to React
            var profile = UserProfile.Current;
            SendMessage("state:init", new
            {
                status = "ready",
                // Per-action DTO is projected by the shared ProjectActionsForFrontend()
                // helper — identical to PushActionsUpdate's actions:updated payload so
                // the cold-start state and subsequent pushes can never drift.
                actions = ProjectActionsForFrontend(),
                highlightedActionIndex = (int?)null,
                profiles = profileController.ProfileEntries.Select(p => new
                {
                    name = p.Name,
                    filePath = p.FilePath,
                    hotkey = p.Hotkey,
                    hotstring = p.Hotstring,
                    hotstringInstant = p.HotstringInstant,
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
                    isDisabled = p.IsDisabled
                }).ToArray(),
                activeProfile = CurrentProfileName == "No Profile" ? (string?)null : CurrentProfileName,
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
                    cursorClickLoops = CursorClickLoops,
                    cursorClickUseLoops = CursorClickUseLoops,
                    cursorClickInterval = CursorClickInterval,
                    cursorClickUseInterval = CursorClickUseInterval,
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
                    alwaysOnTop = profile.AlwaysOnTop,
                    minimizeToTray = profile.MinimizeToTray,
                    runOnStartup = TrayIconService.IsRunOnStartup(),
                    startMinimized = profile.StartMinimized,
                    runAsAdmin = AppSettingsManager.Load().RunAsAdmin
                },
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
        //   true  → after detection, immediately download + apply + restart with no UI gate.
        //   false → only notify the frontend (legacy "Update available" overlay decides).
        // Frontend overlay is currently disabled (see UpdateOverlay.tsx UPDATE_OVERLAY_ENABLED);
        // flipping this to false alone would leave updates undetectable to the user.
        private const bool AutoApplyUpdates = true;

        // Re-entrancy guard for HandleUpdateApply. It's reachable from three places that can
        // overlap: the auto-apply branch of CheckForUpdateAsync (fired on startup AND on every
        // ApplyProfile/PushFullState), the "update:check" message, and the "update:apply"
        // message. Without the guard a second invocation kicks off a parallel download +
        // ApplyAndRestart, racing the Velopack apply against itself.
        private bool _updateInProgress;

        private async Task CheckForUpdateAsync()
        {
            // Announce we're starting so the overlay can show its indeterminate "Checking…"
            // state during the network round-trip. Resolves into update:available or
            // update:none below, or update:error in the catch.
            SendMessage("update:checking", new { });

            try
            {
                var newVersion = await UpdateService.CheckForUpdateAsync();
                if (newVersion != null)
                {
                    // Fetch release notes in parallel — best-effort, may be empty
                    var notes = await UpdateService.GetPendingReleaseNotesAsync();

                    // autoApply tells the frontend to skip the "Download" confirmation gate
                    // and transition straight to the downloading splash — matches the mockup
                    // (no confirmation button). The legacy gate flow stays available when
                    // AutoApplyUpdates is flipped off in code.
                    SendMessage("update:available", new
                    {
                        version = newVersion,
                        currentVersion = UpdateService.CurrentVersion ?? "unknown",
                        notes = notes,
                        autoApply = AutoApplyUpdates,
                    });

                    if (AutoApplyUpdates)
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
            // so the finally only runs (clearing the flag) on the download-failure path.
            if (_updateInProgress) return;
            _updateInProgress = true;
            try
            {
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
                    SendMessage("update:error", new { message = "Download failed" });
                }
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

        private void HandleReplayToggle(JsonElement payload)
        {
            if (UseCursorClick)
            {
                // Clicker v2 — read from the dedicated CursorClick* fields (sourced from
                // AppSettings) instead of the profile's CustomDelay/Jitter/Loop. This makes
                // Clicker truly mode-of-the-app, no longer mode-of-active-profile.
                mainController.ToggleCursorClickReplay(BuildClickerConfig());
                return;
            }

            // Defensive reads — a hotkey-forwarded or older-frontend payload may omit these.
            // GetProperty/GetBoolean would throw and the outer catch would only Debug.WriteLine,
            // silently dropping the replay start. Fall back to the same defaults the *.GetString()
            // calls already used (loop off, count "1", interval off, text "0").
            bool loopEnabled = payload.TryGetProperty("loopEnabled", out var loopEnEl) && loopEnEl.ValueKind == JsonValueKind.True;
            string loopCount = payload.TryGetProperty("loopCount", out var loopCntEl) && loopCntEl.ValueKind == JsonValueKind.String
                ? loopCntEl.GetString() ?? "1" : "1";
            bool intervalEnabled = payload.TryGetProperty("intervalEnabled", out var ivEnEl) && ivEnEl.ValueKind == JsonValueKind.True;
            string intervalText = payload.TryGetProperty("intervalText", out var ivTxtEl) && ivTxtEl.ValueKind == JsonValueKind.String
                ? ivTxtEl.GetString() ?? "0" : "0";

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
            if (hasCur && effW == 0 && effH == 0)
            {
                var folderGeom = profileController.GetFolderInheritedGeometry(CurrentProfileName);
                if (folderGeom.HasValue)
                {
                    effGX = folderGeom.Value.X;
                    effGY = folderGeom.Value.Y;
                    effW = folderGeom.Value.Width;
                    effH = folderGeom.Value.Height;
                }
            }

            // Mirror the hotkey gate — but adapted for the button: TR is always foreground
            // when the user clicks Replay, so a literal IsForegroundWindowMatch would block
            // the button entirely. Instead, refuse to start when the configured target isn't
            // running anywhere — covers both regular and BringToFocus profiles, since neither
            // can do anything useful when their target process isn't running. Stop is always
            // allowed (clicking while replaying = abort). Skipped when no target is
            // configured (preserves the "no profile" / "no target" workflows).
            if (!mainController.IsReplayInProgress()
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

            foreach (var clone in paste)
            {
                // `paste` already holds freshly-cloned items (auto-completed by the
                // validator above), so we insert them directly. Image reference cloning
                // is still per-row: a WaitImage row (or an If Image conditional) carries
                // a profile-scoped PNG that must be duplicated into the destination
                // profile so deleting the source doesn't break the paste.
                bool refsImage = !string.IsNullOrEmpty(clone.ImagePath) && (
                                    clone.ActionType == "WaitImage"
                                    || (clone.ActionType == "If" && string.Equals(clone.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase)));
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
                case "key": action.Key = value; break;
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
                case "ifOnProbeError":
                    // Same convention as waitImageOnTimeout / pixelOnTimeout — only the
                    // non-default "Halt" is persisted; "TreatAsFalse" stays null on disk
                    // so existing profiles round-trip clean.
                    action.IfOnProbeError = value == "Halt" ? "Halt" : null;
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

            // We intentionally don't delete the PNG of WaitImage actions here so undo can restore
            // the action with its original reference image still on disk. Orphan PNGs (those no
            // longer referenced by any action in any profile) are cleaned up at app startup by
            // ImageStorageService.CleanupOrphanImages.
            foreach (var idx in indices)
            {
                if (idx >= 0 && idx < actions.Count)
                    actions.RemoveAt(idx);
            }

            HasUnsavedChanges = true;
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
                if (idx >= 0 && idx < actions.Count)
                    actions[idx].Delay = delay;
            }

            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        private void HandleBulkUpdateCoord(JsonElement payload)
        {
            PushUndoState();
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32()).ToList();
            string axis = payload.GetProperty("axis").GetString() ?? "x"; // "x" or "y"
            string valueStr = payload.GetProperty("value").GetString() ?? "0";
            bool isOffset = valueStr.StartsWith("+") || valueStr.StartsWith("-");
            int val = int.TryParse(valueStr, out var v) ? v : 0;

            int updated = 0;
            foreach (var idx in indices)
            {
                if (idx >= 0 && idx < actions.Count)
                {
                    var a = actions[idx];
                    // Only apply X/Y to mouse click actions (paired halves + combined single clicks)
                    if (a.ActionType is not ("LeftClickDown" or "LeftClickUp" or "RightClickDown" or "RightClickUp" or "MiddleClickDown" or "MiddleClickUp"
                        or "LeftClick" or "RightClick" or "MiddleClick" or "DoubleClick"))
                        continue;
                    if (axis == "x")
                        a.X = isOffset ? a.X + val : val;
                    else
                        a.Y = isOffset ? a.Y + val : val;
                    updated++;
                }
            }
            if (updated == 0)
            {
                SendMessage("alert:show", new { message = "X/Y can only be set on mouse click actions." });
                _undoStack.TryPop(out _); // Remove undo state since nothing changed
                return;
            }
            var label = isOffset ? valueStr : $"= {val}";
            SendMessage("alert:show", new { message = $"Set {axis.ToUpper()} {label} for {updated} action(s)" });
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
            var action = new ActionItem { ActionType = "SendText", Key = text, Delay = delay };

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
            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

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

        public void PushReplayPaused(string hotkey, int timeoutMs)
        {
            SendMessage("replay:paused", new { hotkey, timeoutMs });
        }

        public void PushReplayResumed()
        {
            SendMessage("replay:resumed", new { });
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

            // Snapshot after the empty-actionType guard. The unrecognized-type tail below
            // (the final `else`) pops this back off, mirroring HandleBulkUpdateCoord, so an
            // unhandled type also leaves the undo/redo stacks untouched. The WaitImage and
            // capture (LeftClick/KeyPress) branches keep this push — it's their only undo
            // step since their async insert paths don't push one of their own.
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
                // Unrecognized type — nothing was inserted, so drop the snapshot pushed above
                // (which also restores the redo stack it cleared). Mirrors HandleBulkUpdateCoord.
                _undoStack.TryPop(out _);
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
            // Unknown conditionType (e.g. future "WindowExists" from a stale frontend on
            // an older backend) silently no-ops — better than inserting a half-configured
            // IF the user can't interact with through the existing Sheet editor.
        }

        private async Task HandleInsertConditionalImageAsync(int insertIndex)
        {
            // Identical capture flow to HandleInsertWaitImageAsync above — same minimise,
            // screenshot, region-pick overlay, ImageStorageService.SaveReferenceImage path.
            // The only difference is what gets inserted at the end: {If, EndIf} pair
            // sharing the same ImagePath + Confidence the WaitImage flow stores, with
            // ConditionType set to "ImageFound" so the engine routes through InstantProbe.
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
                System.Diagnostics.Debug.WriteLine($"[InsertIfImage] Screenshot failed: {ex.Message}");
                NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE);
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var thread = new Thread(() =>
                {
                    System.Windows.Forms.Application.EnableVisualStyles();
                    using var overlay = new ScreenOverlayForm(screenshot);
                    overlay.ShowDialog();
                    selection = overlay.GetSelectionAsync().Result;
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                await Task.Run(() => thread.Join());

                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));

                if (selection?.CroppedImage == null) return;

                string profileName = CurrentProfileName != "No Profile" ? CurrentProfileName : "default";
                string imagePath = ImageStorageService.SaveReferenceImage(selection.CroppedImage, profileName);
                selection.CroppedImage.Dispose();

                dispatcherQueue.TryEnqueue(() =>
                {
                    PushUndoState();
                    actions.Insert(insertIndex, new ActionItem
                    {
                        ActionType = "If",
                        ConditionType = "ImageFound",
                        ImagePath = imagePath,
                        Confidence = 0.8,
                        // No custom delay: an IF is control flow (a branch point), not an
                        // input step — a pre-delay before evaluating the condition has no
                        // useful meaning, and the probe's own wait/timeout already handles
                        // timing. Both IF and EndIf stay 0. (Add a Pause before the IF if
                        // you genuinely want to wait before the check.)
                        Delay = 0,
                        Key = "",
                        Comment = "",
                    });
                    actions.Insert(insertIndex + 1, new ActionItem
                    {
                        ActionType = "EndIf",
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
                    SendMessage("sheet:openIndex", new { index = insertIndex });
                });
            }
            finally
            {
                screenshot.Dispose();
            }
        }

        private async Task HandleInsertConditionalPixelAsync(int insertIndex)
        {
            // Mirror of HandleInsertWaitPixelColorAsync — same point-pick overlay, same
            // relative-coord translation. End result: {If(PixelColorMatch + coords + hex),
            // EndIf} pair inserted at insertIndex.
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
                System.Diagnostics.Debug.WriteLine($"[InsertIfPixel] Screenshot failed: {ex.Message}");
                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var thread = new Thread(() =>
                {
                    System.Windows.Forms.Application.EnableVisualStyles();
                    using var overlay = new ScreenOverlayForm(
                        screenshot,
                        regionOnly: false,
                        pointPick: true,
                        hintText: "Click on the pixel to check — colour and coords are captured  •  ESC to cancel");
                    overlay.ShowDialog();
                    selection = overlay.GetSelectionAsync().Result;
                });
                thread.SetApartmentState(ApartmentState.STA);
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
                    PushUndoState();
                    actions.Insert(insertIndex, new ActionItem
                    {
                        ActionType = "If",
                        ConditionType = "PixelColorMatch",
                        PixelX = storedX,
                        PixelY = storedY,
                        PixelColor = PixelColorService.ToHex(selection.PickedColor.Value),
                        // No custom delay — an IF is control flow, not an input step
                        // (see the If-Image insert above). Both IF and EndIf stay 0.
                        Delay = 0,
                        Key = "",
                        Comment = "",
                    });
                    actions.Insert(insertIndex + 1, new ActionItem
                    {
                        ActionType = "EndIf",
                        Delay = 0,
                        Key = "",
                        Comment = "",
                    });
                    for (int i = 0; i < actions.Count; i++)
                        actions[i].RowNumber = i + 1;
                    HasUnsavedChanges = true;
                    PushActionsUpdate();
                    mainController.UpdateButtonStates();
                    SendMessage("sheet:openIndex", new { index = insertIndex });
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

            int delay = int.TryParse(CustomDelay, out var pd) ? pd : 100;
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
                System.Diagnostics.Debug.WriteLine($"[WaitImage] Screenshot failed: {ex.Message}");
                NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE);
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;

                // Run overlay on STA thread (WinForms requirement)
                var thread = new Thread(() =>
                {
                    System.Windows.Forms.Application.EnableVisualStyles();
                    using var overlay = new ScreenOverlayForm(screenshot);
                    overlay.ShowDialog();
                    selection = overlay.GetSelectionAsync().Result;
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                await Task.Run(() => thread.Join());

                // Restore main window
                dispatcherQueue.TryEnqueue(() =>
                {
                    NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE);
                });

                if (selection?.CroppedImage == null) return; // Cancelled or region-only (no image)

                // Save the cropped image
                string profileName = CurrentProfileName != "No Profile" ? CurrentProfileName : "default";
                string imagePath = ImageStorageService.SaveReferenceImage(selection.CroppedImage, profileName);
                selection.CroppedImage.Dispose();

                // Insert the action
                int delay = int.TryParse(CustomDelay, out var d) ? d : 100;
                dispatcherQueue.TryEnqueue(() =>
                {
                    actions.Insert(insertIndex, new ActionItem
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
                    SendMessage("sheet:openIndex", new { index = insertIndex });
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
                System.Diagnostics.Debug.WriteLine($"[WaitPixelColor] Screenshot failed: {ex.Message}");
                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var thread = new Thread(() =>
                {
                    System.Windows.Forms.Application.EnableVisualStyles();
                    using var overlay = new ScreenOverlayForm(
                        screenshot,
                        regionOnly: false,
                        pointPick: true,
                        hintText: "Click the pixel to watch — colour + coords captured  •  Scroll to zoom  •  ESC to cancel");
                    overlay.ShowDialog();
                    selection = overlay.GetSelectionAsync().Result;
                });
                thread.SetApartmentState(ApartmentState.STA);
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
                    actions.Insert(insertIndex, new ActionItem
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
                    SendMessage("sheet:openIndex", new { index = insertIndex });
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
                || (a.ActionType == "If" && string.Equals(a.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase));
            if (!eligible) return;
            _ = HandleWaitImageRecaptureAsync(index);
        }

        private async Task HandleWaitImageRecaptureAsync(int index)
        {
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
                System.Diagnostics.Debug.WriteLine($"[WaitImage] Recapture screenshot failed: {ex.Message}");
                NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE);
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var thread = new Thread(() =>
                {
                    System.Windows.Forms.Application.EnableVisualStyles();
                    using var overlay = new ScreenOverlayForm(screenshot);
                    overlay.ShowDialog();
                    selection = overlay.GetSelectionAsync().Result;
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                await Task.Run(() => thread.Join());

                dispatcherQueue.TryEnqueue(() =>
                {
                    NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE);
                });

                if (selection?.CroppedImage == null) return; // Cancelled

                // Keep the old PNG on disk so undo can restore the previous reference image.
                // Orphan PNGs are cleaned at app startup by ImageStorageService.CleanupOrphanImages.
                string profileName = CurrentProfileName != "No Profile" ? CurrentProfileName : "default";
                string newImagePath = ImageStorageService.SaveReferenceImage(selection.CroppedImage, profileName);
                selection.CroppedImage.Dispose();

                dispatcherQueue.TryEnqueue(() =>
                {
                    if (index < actions.Count)
                    {
                        actions[index].ImagePath = newImagePath;
                        HasUnsavedChanges = true;
                        PushActionsUpdate();
                    }
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

            System.Drawing.Rectangle? searchRegion = null;
            if (payload.TryGetProperty("searchRegion", out var srEl) && srEl.ValueKind == JsonValueKind.Object)
            {
                int sx = srEl.GetProperty("x").GetInt32();
                int sy = srEl.GetProperty("y").GetInt32();
                int sw = srEl.GetProperty("w").GetInt32();
                int sh = srEl.GetProperty("h").GetInt32();
                if (sw > 0 && sh > 0)
                {
                    if (TryGetRelativeCaptureOffset(out var winRect))
                    {
                        sx += winRect.Left;
                        sy += winRect.Top;
                    }
                    searchRegion = new System.Drawing.Rectangle(sx, sy, sw, sh);
                }
            }

            try
            {
                string profileName = CurrentProfileName != "No Profile" ? CurrentProfileName : "default";
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
                if (TryGetRelativeCaptureOffset(out var winRectReport))
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
                || (action.ActionType == "If" && string.Equals(action.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase)));
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
                System.Diagnostics.Debug.WriteLine($"[WaitImage] Crop failed: {ex.Message}");
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
                System.Diagnostics.Debug.WriteLine($"[MousePick] Screenshot failed: {ex.Message}");
                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));
                SendMessage("mouse:positionPicked", new { requestId, cancelled = true });
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var thread = new Thread(() =>
                {
                    System.Windows.Forms.Application.EnableVisualStyles();
                    using var overlay = new ScreenOverlayForm(
                        screenshot,
                        regionOnly: false,
                        pointPick: true,
                        hintText: "Click anywhere on screen to set X/Y  •  ESC to cancel");
                    overlay.ShowDialog();
                    selection = overlay.GetSelectionAsync().Result;
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                await Task.Run(() => thread.Join());

                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));

                if (selection == null)
                {
                    SendMessage("mouse:positionPicked", new { requestId, cancelled = true });
                    return;
                }

                SendMessage("mouse:positionPicked", new
                {
                    requestId,
                    cancelled = false,
                    x = selection.ScreenX,
                    y = selection.ScreenY
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
                System.Diagnostics.Debug.WriteLine($"[PixelColorPick] Screenshot failed: {ex.Message}");
                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));
                SendMessage("pixel:colorPicked", new { requestId, cancelled = true });
                return;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var thread = new Thread(() =>
                {
                    System.Windows.Forms.Application.EnableVisualStyles();
                    using var overlay = new ScreenOverlayForm(
                        screenshot,
                        regionOnly: false,
                        pointPick: true,
                        hintText: "Click the pixel to watch — colour + coords captured  •  Scroll to zoom  •  ESC to cancel");
                    overlay.ShowDialog();
                    selection = overlay.GetSelectionAsync().Result;
                });
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                await Task.Run(() => thread.Join());

                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));

                if (selection == null || selection.PickedColor == null)
                {
                    SendMessage("pixel:colorPicked", new { requestId, cancelled = true });
                    return;
                }

                // Translate absolute pick → profile-relative when rel coords on + target running.
                // The sampled colour is independent of coord space (taken from the screenshot
                // pixel directly) so it round-trips unchanged.
                int storedX = selection.ScreenX;
                int storedY = selection.ScreenY;
                if (TryGetRelativeCaptureOffset(out var winRect))
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
            System.Drawing.Rectangle? initialRect, string hintWhenSet, string hintWhenEmpty, string logPrefix)
        {
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
                System.Diagnostics.Debug.WriteLine($"[{logPrefix}] Screenshot failed: {ex.Message}");
                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));
                return null;
            }

            try
            {
                RegionSelectionResult? selection = null;
                var hint = initialRect.HasValue ? hintWhenSet : hintWhenEmpty;
                var thread = new Thread(() =>
                {
                    System.Windows.Forms.Application.EnableVisualStyles();
                    using var overlay = new ScreenOverlayForm(
                        screenshot, regionOnly: true, hintText: hint, initialRect: initialRect);
                    overlay.ShowDialog();
                    selection = overlay.GetSelectionAsync().Result;
                });
                thread.SetApartmentState(ApartmentState.STA);
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

            bool hasRelativeOffset = TryGetRelativeCaptureOffset(out var winRect);

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
                hintWhenEmpty: "Drag to set the search area for this Wait Image  •  ESC to cancel",
                logPrefix: "WaitImage");

            if (selection == null)
            {
                SendMessage("waitimage:searchRegionSet", new { requestId, cancelled = true });
                return;
            }

            // Translate fresh selection (absolute from overlay) → profile-relative for storage.
            // Re-check the target window in case it moved or closed between display and selection.
            int storedX = selection.ScreenX;
            int storedY = selection.ScreenY;
            if (TryGetRelativeCaptureOffset(out var winRectNow))
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
        private async Task HandleConfigureClickAreaAsync(JsonElement payload)
        {
            string requestId = payload.TryGetProperty("requestId", out var ridEl) ? (ridEl.GetString() ?? "") : "";

            // Pre-draw the saved rect (when there is one + the toggle is on, signalling intent).
            System.Drawing.Rectangle? initialRect = (CursorClickUseArea && CursorClickArea is { } cur)
                ? new System.Drawing.Rectangle(cur.X, cur.Y, cur.W, cur.H)
                : null;

            var selection = await RunRegionPickerAsync(
                initialRect,
                hintWhenSet: "Drag to redraw the click area  •  ESC to keep current",
                hintWhenEmpty: "Drag to set the click area  •  ESC to cancel",
                logPrefix: "Clicker");

            if (selection == null)
            {
                SendMessage("clicker:areaSet", new { requestId, cancelled = true });
                return;
            }

            // Persist + auto-enable useArea + disable Position jitter (mutual exclusion).
            CursorClickArea = new ClickArea(selection.ScreenX, selection.ScreenY, selection.Width, selection.Height);
            CursorClickUseArea = true;
            CursorClickUsePositionJitter = false;
            SaveGlobalSettings();
            PushSettingsLoaded();

            SendMessage("clicker:areaSet", new
            {
                requestId,
                cancelled = false,
                x = selection.ScreenX,
                y = selection.ScreenY,
                w = selection.Width,
                h = selection.Height
            });
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
                        || (original.ActionType == "If" && string.Equals(original.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase)));
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
                || actionType == "BrowserWaitElement")
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

                // Resolve {clipboard[:mods]}, {date}, {time}, {datetime} the same way the regular
                // replay path does — without this, Test Action would type the literal placeholder
                // instead of the substituted value.
                string? resolvedText = browserText;
                if (actionType == "BrowserType" && !string.IsNullOrEmpty(browserText))
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
                };

                var sw = System.Diagnostics.Stopwatch.StartNew();
                await browserBridge.TestActionAsync(temp, CancellationToken.None, resolvedText);
                sw.Stop();

                TrySendTestResult(requestId, success: true, durationMs: sw.ElapsedMilliseconds, code: null, message: null, tip: null);
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
        private void TrySendTestResult(string requestId, bool success, long durationMs, string? code, string? message, string? tip)
        {
            try
            {
                if (success)
                {
                    SendMessage("browser:testResult", new { requestId, success = true, durationMs });
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
            if (!await CheckUnsavedChangesAsync()) return;

            // Deselect if clicking the already-active profile
            if (CurrentProfileName == name)
            {
                CurrentProfileName = "No Profile";
                CurrentProfilePath = null;
                HasUnsavedChanges = false;
                actions.Clear();
                profileController.UpdateProfileColors(null);
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
                PushProfilesUpdate();
                TrayIconService.UpdateTrayIcon();
            }
        }

        // Guards against a malicious/buggy WebView payload smuggling path separators or
        // traversal into a profile name that later feeds Path.Combine / File.Move. The
        // persisted name must be a bare file name (no directory components, no invalid chars).
        private static bool IsSafeProfileName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return false;
            if (name == "." || name == "..") return false;
            string baseName = name.EndsWith(".json", StringComparison.OrdinalIgnoreCase) ? name[..^5] : name;
            if (string.IsNullOrWhiteSpace(baseName)) return false;
            if (baseName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return false;
            return true;
        }

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
                PushProfilesUpdate();

                // Re-register hotkeys so disabled profiles are excluded
                var hotkeys = profileController.GetProfileHotkeys();
                InputHookManager.RegisterProfileHotkeys(hotkeys);
                InputHookManager.RegisterProfileTriggerModes(profileController.GetProfileTriggerModes());
                var hotstrings = profileController.GetProfileHotstrings();
                InputHookManager.RegisterProfileHotstrings(hotstrings);
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
                }
                await profileController.RenameProfileInOrderAsync(oldName, actualNewName);
                await profileController.RefreshProfileListAsync(true);

                // Rewrite RunProfile references in every OTHER profile that points to the
                // renamed name — otherwise those references become silent no-ops at replay
                // time. Touches profiles on disk + the active in-memory action list.
                int refsUpdated = await ScanRunProfileReferencesAsync(oldName, actualNewName);

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
                IntPtr hwnd = TrueReplayer.Helpers.WindowMatcher.FindWindow(tentativeTarget);
                if (hwnd == IntPtr.Zero)
                {
                    SendMessage("alert:show", new { message = "Target window not found. Open it first, then try Apply target & convert again." });
                    return;
                }
                if (!NativeMethods.GetWindowRect(hwnd, out var rect))
                {
                    SendMessage("alert:show", new { message = "Could not read the target window's position. Try again." });
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

            IntPtr hwnd = TrueReplayer.Helpers.WindowMatcher.FindWindow(target);

            if (hwnd == IntPtr.Zero)
            {
                SendMessage("alert:show", new { message = "Target window not found. Make sure it is open and visible." });
                return;
            }

            if (!NativeMethods.GetWindowRect(hwnd, out var rect))
            {
                SendMessage("alert:show", new { message = "Could not get window position." });
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
                          || (action.ActionType == "If" && string.Equals(action.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase)))
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
                          || (action.ActionType == "If" && string.Equals(action.ConditionType, "PixelColorMatch", StringComparison.OrdinalIgnoreCase)))
                    && action.PixelX.HasValue && action.PixelY.HasValue)
                {
                    action.PixelX = action.PixelX.Value + sign * rect.Left;
                    action.PixelY = action.PixelY.Value + sign * rect.Top;
                    converted++;
                }
            }

            UserProfile.Current.UseRelativeCoordinates = direction == "toRelative";
            UserProfile.Current.WindowWidth = direction == "toRelative" ? rect.Right - rect.Left : 0;
            UserProfile.Current.WindowHeight = direction == "toRelative" ? rect.Bottom - rect.Top : 0;

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

            // Resolve which target definition to search for:
            // - If the dialog supplied process/title, use those (allows capture before Set Target).
            // - Otherwise fall back to the saved effective target of the active profile.
            WindowTarget? target;
            bool haveDialogTarget = !string.IsNullOrWhiteSpace(dialogProcess) || !string.IsNullOrWhiteSpace(dialogTitle);
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

            IntPtr hwnd = TrueReplayer.Helpers.WindowMatcher.FindWindow(target);

            if (hwnd == IntPtr.Zero)
            {
                SendMessage("alert:show", new { message = "Target window not found. Make sure it is open and visible." });
                return;
            }

            if (!NativeMethods.GetWindowRect(hwnd, out var rect))
            {
                SendMessage("alert:show", new { message = "Could not get window dimensions." });
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
                if (entry != null && File.Exists(entry.FilePath))
                {
                    try
                    {
                        System.Diagnostics.Process.Start("explorer.exe", $"/select,\"{entry.FilePath}\"");
                    }
                    catch (Exception ex)
                    {
                        DiagnosticLog.Error($"profile:openFolder failed to reveal '{entry.FilePath}'", ex);
                        SendMessage("alert:show", new { message = "Could not open the profile folder" });
                    }
                }
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

                InputHookManager.SuppressAllHotkeys = true;
                Microsoft.UI.Xaml.Controls.ContentDialogResult result;
                try { result = await dialog.ShowAsync(); }
                finally { InputHookManager.SuppressAllHotkeys = false; }

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
        /// running. False otherwise — caller stores absolute coords as fallback.
        /// </summary>
        private bool TryGetRelativeCaptureOffset(out NativeMethods.RECT rect)
        {
            rect = default;
            if (!UserProfile.Current.UseRelativeCoordinates) return false;
            var target = CurrentProfileName != "No Profile"
                ? profileController.GetEffectiveWindowTarget(CurrentProfileName)
                : UserProfile.Current.TargetWindow;
            if (target == null || (string.IsNullOrEmpty(target.ProcessName) && string.IsNullOrEmpty(target.WindowTitle)))
                return false;
            IntPtr hwnd = TrueReplayer.Helpers.WindowMatcher.FindWindow(target);
            if (hwnd == IntPtr.Zero) return false;
            return NativeMethods.GetWindowRect(hwnd, out rect);
        }

        private async void HandleProfileExport(JsonElement payload)
        {
            var names = payload.GetProperty("names").EnumerateArray()
                .Select(e => e.GetString() ?? "")
                .Where(n => !string.IsNullOrEmpty(n))
                .ToList();

            if (names.Count == 0) return;

            try
            {
                bool includeOrganization = payload.TryGetProperty("includeOrganization", out var orgProp) && orgProp.GetBoolean();
                bool success = await profileController.ExportProfilesAsync(names, includeOrganization);
                if (success)
                    SendMessage("alert:show", new { message = $"Exported {names.Count} profile(s) successfully." });
            }
            catch (Exception ex)
            {
                SendMessage("alert:show", new { message = $"Export failed: {ex.Message}" });
            }
        }

        // Pending-import slot: parsed envelope + file name held server-side between the
        // preview round-trip and the confirm message. Single slot is fine because the
        // user can only have one Import flow open at a time (the file dialog is modal).
        // Cleared after confirm, on cancel (via profile:cancelImport), or when a new
        // preview starts (slot is overwritten).
        private ProfileExportEnvelope? _pendingImportEnvelope;
        private string? _pendingImportFileName;

        /// <summary>
        /// Two-step import: opens the file picker, parses the envelope, and ships a
        /// `profile:importPreview` message back to the frontend. The frontend renders
        /// the security warning (first time only) + Import Preview dialog, then sends
        /// `profile:confirmImport` with the selected profile names to actually write
        /// them to disk.
        /// </summary>
        private async void HandleProfileImport()
        {
            try
            {
                var (envelope, filePath) = await profileController.PrepareImportPreviewAsync();
                if (envelope == null || filePath == null)
                {
                    // User cancelled the file picker, or the file was malformed/empty. No-op so
                    // the UI doesn't pop a stale dialog.
                    _pendingImportEnvelope = null;
                    _pendingImportFileName = null;
                    return;
                }
                SendImportPreview(envelope, Path.GetFileName(filePath));
            }
            catch (Exception ex)
            {
                SendMessage("alert:show", new { message = $"Import failed: {ex.Message}" });
                _pendingImportEnvelope = null;
                _pendingImportFileName = null;
            }
        }

        /// <summary>
        /// Drag-and-drop import: the page read the dropped .trprofile's text (WebView2 hands
        /// the page the file CONTENT, not its path) and posted it here. Parse it through the
        /// SAME envelope parser as the file-picker path, then render the identical preview.
        /// </summary>
        /// <summary>
        /// Stores the parsed envelope as the pending import and pushes the preview payload the
        /// React Import Preview dialog renders. Shared by the file-picker and drag-and-drop
        /// import paths so both produce an identical preview. Compatibility is computed
        /// server-side so the frontend doesn't need the version table.
        /// </summary>
        private void SendImportPreview(ProfileExportEnvelope envelope, string fileName)
        {
            _pendingImportEnvelope = envelope;
            _pendingImportFileName = fileName;

            string runningVersion = typeof(WebViewBridge).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
            var previewProfiles = envelope.Profiles.Select(p => new
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
                actionCount = p.Actions?.Count ?? 0,
                hotkey = p.CustomHotkey,
                hotstring = p.CustomHotstring?.Sequence,
                targetProcessName = p.TargetWindow?.ProcessName,
                targetWindowTitle = p.TargetWindow?.WindowTitle,
                // Conflict detection — the receiver may already have a profile with the same
                // name. Surface that here so the dialog can show a "will be renamed" / "will
                // overwrite" hint up-front instead of only learning at confirm time.
                nameConflict = profileController.ProfileEntries.Any(e => e.Name == p.Name)
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

            // Selected names: which profiles from the envelope to actually import. Frontend
            // omits incompatible ones (AppMinVersion > running) automatically — we trust
            // it but double-check below as a safety net.
            var selectedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
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
                return;
            }

            try
            {
                var (imported, skipped, hasOrganization, imageFailures) = await profileController.ConfirmImportAsync(
                    _pendingImportEnvelope, selectedNames, conflictResolutions);

                if (imported > 0)
                {
                    PushProfilesUpdate();
                    string msg = $"Imported {imported} profile(s).";
                    if (skipped > 0) msg += $" {skipped} skipped.";
                    if (imageFailures > 0) msg += $" {imageFailures} reference image(s) couldn't be restored.";
                    if (hasOrganization) msg += " Folder organization imported.";
                    // Explicit toast type: a partial success (some images didn't restore) must NOT
                    // render red — the frontend infers an error from words like "couldn't". 'info'
                    // (neutral) for the warning case, 'success' (green) for a clean import.
                    SendMessage("alert:show", new { message = msg, type = imageFailures > 0 ? "info" : "success" });
                }
                else if (skipped > 0)
                {
                    SendMessage("alert:show", new { message = $"All {skipped} profile(s) were skipped." });
                }
            }
            catch (Exception ex)
            {
                SendMessage("alert:show", new { message = $"Import failed: {ex.Message}" });
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
                    UserProfile.Current = profile;
                    AppSettingsManager.ApplyGlobalSettings(UserProfile.Current);
                    HasUnsavedChanges = false;
                }
                else if (choice == SaveDialogResult.SaveAsNew)
                {
                    bool saved = await profileController.SaveProfileAsync();
                    if (saved) HasUnsavedChanges = false;
                }
                // Cancel = do nothing
            }
            else
            {
                bool saved = await profileController.SaveProfileAsync();
                if (saved) HasUnsavedChanges = false;
            }
            PushProfilesUpdate();
        }

        private async void HandleProfileLoad()
        {
            // Guard: check for unsaved changes before loading
            if (!await CheckUnsavedChangesAsync()) return;

            string? loadedPath = await profileController.LoadProfileAsync();
            if (loadedPath == null) return;

            string name = Path.GetFileNameWithoutExtension(loadedPath);
            CurrentProfileName = name;
            CurrentProfilePath = loadedPath;
            HasUnsavedChanges = false;
            ApplyProfile(UserProfile.Current);
            profileController.UpdateProfileColors(name);
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

            InputHookManager.SuppressAllHotkeys = true;
            try
            {
                var result = await dialog.ShowAsync();
                if (result != Microsoft.UI.Xaml.Controls.ContentDialogResult.Primary)
                    return;
            }
            finally
            {
                InputHookManager.SuppressAllHotkeys = false;
            }

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
                CursorClickDelayJitterPct = 10,
                CursorClickUseJitter = false,
                CursorClickHoldMs = 10,
                CursorClickPositionJitter = 10,
                CursorClickUsePositionJitter = false,
                CursorClickLoops = 0,
                CursorClickUseLoops = false,
                CursorClickIntervalMs = 200,
                CursorClickUseInterval = false,
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
            TrayIconService.SetRunOnStartup(defaults.RunOnStartup);
            window.UpdateAlwaysOnTop(defaults.AlwaysOnTop);

            ApplyProfile(UserProfile.Current);
            profileController.UpdateProfileColors(null);
            CurrentProfileName = "No Profile";
            CurrentProfilePath = null;
            HasUnsavedChanges = false;
            PushSettingsLoaded();
            // Distinct signal for "the user explicitly reset everything" — used by the
            // Clicker panel to bounce its local UI state (e.g. the /s ↔ ms unit toggle)
            // back to its default. Plain settings:loaded fires too often (every profile
            // switch, mode toggle, etc.) so a dedicated message keeps the protocol clear.
            SendMessage("settings:reset", new { });
            PushProfilesUpdate();
            PushToolbarUpdate();
            PushStatusBarUpdate();
            TrayIconService.UpdateTrayIcon();
        }

        private void SaveGlobalSettings()
        {
            var s = new AppSettingsManager.AppSettings
            {
                AlwaysOnTop = UserProfile.Current.AlwaysOnTop,
                MinimizeToTray = UserProfile.Current.MinimizeToTray,
                RunOnStartup = TrayIconService.IsRunOnStartup(),
                StartMinimized = UserProfile.Current.StartMinimized,
                UseCustomDelay = UseCustomDelay,
                CustomDelay = int.TryParse(CustomDelay, out var d) ? d : 100,
                UseDelayVariation = UseDelayVariation,
                DelayVariation = int.TryParse(DelayVariation, out var dv) ? dv : 20,
                EnableLoop = EnableLoop,
                LoopCount = int.TryParse(LoopCount, out var c) ? c : 0,
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
                CursorClickDelayJitterPct = int.TryParse(CursorClickDelayJitter, out var ccdj) ? ccdj : 0,
                CursorClickUseJitter = CursorClickUseJitter,
                CursorClickHoldMs = int.TryParse(CursorClickHold, out var cch) ? cch : 10,
                CursorClickPositionJitter = int.TryParse(CursorClickPositionJitter, out var ccpj) ? ccpj : 0,
                CursorClickUsePositionJitter = CursorClickUsePositionJitter,
                CursorClickUseArea = CursorClickUseArea,
                // On-disk schema stays 5 fields for forward-compat. When the rect is null,
                // we write zeros — Load above treats W=H=0 as "no rect" and projects back to null.
                CursorClickAreaX = CursorClickArea?.X ?? 0,
                CursorClickAreaY = CursorClickArea?.Y ?? 0,
                CursorClickAreaW = CursorClickArea?.W ?? 0,
                CursorClickAreaH = CursorClickArea?.H ?? 0,
                CursorClickLoops = int.TryParse(CursorClickLoops, out var ccl) ? ccl : 0,
                CursorClickUseLoops = CursorClickUseLoops,
                CursorClickIntervalMs = int.TryParse(CursorClickInterval, out var cci) ? cci : 0,
                CursorClickUseInterval = CursorClickUseInterval,
                RecordMouse = RecordMouse,
                RecordScroll = RecordScroll,
                RecordKeyboard = RecordKeyboard,
                RecordCombinedInput = RecordCombinedInput,
                RecordingHotkey = UserProfile.Current.RecordingHotkey,
                ReplayHotkey = UserProfile.Current.ReplayHotkey,
                ProfileKeyToggleHotkey = UserProfile.Current.ProfileKeyToggleHotkey,
                ForegroundHotkey = UserProfile.Current.ForegroundHotkey,
                ModeToggleHotkey = UserProfile.Current.ModeToggleHotkey,
                ProfileKeyEnabled = ProfileKeyEnabled,
                BrowserSelectorEnabled = BrowserSelectorEnabled,
                RunAsAdmin = AppSettingsManager.Load().RunAsAdmin,
            };
            AppSettingsManager.Save(s);
        }

        private static readonly HashSet<string> HotkeySettingKeys = new()
        {
            "recordingHotkey", "replayHotkey", "profileKeyToggleHotkey", "foregroundHotkey", "modeToggleHotkey"
        };

        private static readonly Dictionary<string, string> HotkeyDisplayNames = new()
        {
            ["recordingHotkey"] = "Recording",
            ["replayHotkey"] = "Replay",
            ["profileKeyToggleHotkey"] = "Profile Key Toggle",
            ["foregroundHotkey"] = "Foreground",
            ["modeToggleHotkey"] = "Mode Toggle",
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
                    DelayVariation = valueElement.GetString() ?? "20";
                    break;
                case "useDelayVariation":
                    UseDelayVariation = valueElement.GetBoolean();
                    break;
                case "loopCount":
                    LoopCount = valueElement.GetString() ?? "0";
                    break;
                case "enableLoop":
                    EnableLoop = valueElement.GetBoolean();
                    break;
                case "loopInterval":
                    LoopInterval = valueElement.GetString() ?? "200";
                    break;
                case "loopIntervalEnabled":
                    LoopIntervalEnabled = valueElement.GetBoolean();
                    break;
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
                case "cursorClickStartHotkey":
                    CursorClickStartHotkey = valueElement.GetString() ?? "PageDown";
                    break;
                case "cursorClickPauseHotkey":
                    CursorClickPauseHotkey = valueElement.GetString() ?? "PageUp";
                    break;
                // ── Clicker v2 settings (dedicated, decoupled from profile) ──
                case "cursorClickDelay":
                    CursorClickDelay = valueElement.GetString() ?? "100";
                    break;
                case "cursorClickDelayJitter":
                    CursorClickDelayJitter = valueElement.GetString() ?? "0";
                    break;
                case "cursorClickUseJitter":
                    CursorClickUseJitter = valueElement.GetBoolean();
                    break;
                case "cursorClickHold":
                    CursorClickHold = valueElement.GetString() ?? "10";
                    break;
                case "cursorClickPositionJitter":
                    CursorClickPositionJitter = valueElement.GetString() ?? "0";
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
                case "cursorClickLoops":
                    CursorClickLoops = valueElement.GetString() ?? "0";
                    break;
                case "cursorClickUseLoops":
                    CursorClickUseLoops = valueElement.GetBoolean();
                    break;
                case "cursorClickInterval":
                    CursorClickInterval = valueElement.GetString() ?? "0";
                    break;
                case "cursorClickUseInterval":
                    CursorClickUseInterval = valueElement.GetBoolean();
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
                case "runAsAdmin":
                    {
                        // Save directly — RunAsAdmin is read from file, not a runtime field
                        var current = AppSettingsManager.Load();
                        current.RunAsAdmin = valueElement.GetBoolean();
                        AppSettingsManager.Save(current);
                    }
                    break;
            }

            SaveGlobalSettings();

            // Echo updated settings back to React so controlled components update
            PushSettingsLoaded();
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

        // ── Collection change handler ──

        private void OnActionsChanged(object? sender, NotifyCollectionChangedEventArgs e)
        {
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;

            if (e.Action == NotifyCollectionChangedAction.Add)
                HasUnsavedChanges = true;

            PushActionsUpdate();
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
