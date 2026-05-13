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
        public bool UseCursorClick { get; set; } = false;
        public string CursorClickButton { get; set; } = "Left";
        // Clicker v2 — dedicated Clicker settings, fully decoupled from the active profile.
        // Stored in AppSettings; mirrored here for fast access. Strings (not ints) to mirror
        // the existing pattern for delay/loop/interval which use textbox-backed values.
        public string CursorClickDelay { get; set; } = "100";
        public string CursorClickDelayJitter { get; set; } = "0";
        public bool CursorClickUseJitter { get; set; } = false;
        public string CursorClickHold { get; set; } = "10";
        public string CursorClickPositionJitter { get; set; } = "0";
        public bool CursorClickUsePositionJitter { get; set; } = false;
        public string CursorClickLoops { get; set; } = "0";
        public bool CursorClickUseLoops { get; set; } = false;
        public string CursorClickInterval { get; set; } = "0";
        public bool CursorClickUseInterval { get; set; } = false;
        public bool RecordMouse { get; set; } = true;
        public bool RecordScroll { get; set; } = true;
        public bool RecordKeyboard { get; set; } = true;
        public bool ProfileKeyEnabled { get; set; } = true;
        public bool BrowserSelectorEnabled { get; set; } = false;

        // Selection state (synced from React)
        public int? SelectedInsertIndex { get; private set; }

        // Toolbar/StatusBar state
        public string CurrentProfileName { get; set; } = "No Profile";
        public string? CurrentProfilePath { get; set; }
        public bool HasUnsavedChanges { get; set; }

        private readonly BrowserBridgeService? browserBridge;

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

            // Watch for browser extension events
            if (browserBridge != null)
            {
                browserBridge.ConnectionChanged += (connected) =>
                {
                    dispatcherQueue.TryEnqueue(() => SendMessage("browser:status", new { connected }));
                };
                browserBridge.ExtensionVersionMismatch += (currentVersion, expectedVersion) =>
                {
                    dispatcherQueue.TryEnqueue(() => SendMessage("browser:extensionOutdated", new { currentVersion, expectedVersion }));
                };
                browserBridge.ElementClicked += (selector, description, url, tagName, button, isInput) =>
                {
                    dispatcherQueue.TryEnqueue(() =>
                    {
                        if (!recordingService.IsRecording) return;

                        // Remove native click events recorded in the last 500ms (duplicates of this browser click)
                        var cutoff = DateTime.UtcNow.AddMilliseconds(-500);
                        for (int i = actions.Count - 1; i >= 0 && i >= actions.Count - 4; i--)
                        {
                            var a = actions[i];
                            if (a.ActionType is "LeftClickDown" or "LeftClickUp" or "RightClickDown" or "RightClickUp"
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
                // #10 — Typing observed in a recorded input field. Locate the most recent
                // matching BrowserType action for the same selector and fill its text.
                browserBridge.TypingCaptured += (selector, text, isAppend) =>
                {
                    dispatcherQueue.TryEnqueue(() =>
                    {
                        if (!recordingService.IsRecording) return;
                        if (string.IsNullOrEmpty(text)) return;

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
            UseCursorClick = saved.UseCursorClick;
            CursorClickButton = saved.CursorClickButton;
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
                // CursorClickHoldMs already defaults to 10ms (matches old hardcoded value).
                // CursorClickPositionJitter stays 0 (new feature, off by default).
                AppSettingsManager.Save(saved);
            }
            CursorClickDelay = saved.CursorClickDelayMs.ToString();
            CursorClickDelayJitter = saved.CursorClickDelayJitterPct.ToString();
            CursorClickUseJitter = saved.CursorClickUseJitter;
            CursorClickHold = saved.CursorClickHoldMs.ToString();
            CursorClickPositionJitter = saved.CursorClickPositionJitter.ToString();
            CursorClickUsePositionJitter = saved.CursorClickUsePositionJitter;
            CursorClickLoops = saved.CursorClickLoops.ToString();
            CursorClickUseLoops = saved.CursorClickUseLoops;
            CursorClickInterval = saved.CursorClickIntervalMs.ToString();
            CursorClickUseInterval = saved.CursorClickUseInterval;
            RecordMouse = saved.RecordMouse;
            RecordScroll = saved.RecordScroll;
            RecordKeyboard = saved.RecordKeyboard;
            ProfileKeyEnabled = saved.ProfileKeyEnabled;
            BrowserSelectorEnabled = saved.BrowserSelectorEnabled;
        }

        // ── Send message to React ──

        public void SendMessage(string type, object payload)
        {
            try
            {
                var msg = new { type, payload };
                var json = JsonSerializer.Serialize(msg, JsonOptions);
                dispatcherQueue.TryEnqueue(() =>
                {
                    try { webView.PostWebMessageAsJson(json); }
                    catch { /* WebView may not be ready */ }
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
                    case "actions:clear": HandleActionsClear(); break;
                    case "actions:undo": HandleUndo(); break;
                    case "actions:redo": HandleRedo(); break;
                    case "actions:copy": HandleActionsCopy(); break;
                    case "actions:copyInternal": HandleActionsCopyInternal(payload); break;
                    case "actions:paste": HandleActionsPaste(payload); break;
                    case "actions:edit": HandleActionsEdit(payload); break;
                    case "actions:delete": HandleActionsDelete(payload); break;
                    case "actions:addSendText": HandleAddSendText(payload); break;
                    case "actions:editSendText": HandleEditSendText(payload); break;
                    case "actions:bulkUpdateDelay": HandleBulkUpdateDelay(payload); break;
                    case "actions:bulkUpdateCoord": HandleBulkUpdateCoord(payload); break;
                    case "actions:bulkUpdateComment": HandleBulkUpdateComment(payload); break;
                    case "actions:toggleSkip": HandleActionsToggleSkip(payload); break;
                    case "actions:reorder": HandleActionsReorder(payload); break;
                    case "actions:insertAction": HandleInsertAction(payload); break;
                    case "actions:duplicate": HandleDuplicateActions(payload); break;
                    case "actions:addRunProfile": HandleAddRunProfile(payload); break;
                    case "actions:editRunProfile": HandleEditRunProfile(payload); break;
                    case "waitimage:recapture": HandleWaitImageRecapture(payload); break;
                    case "waitimage:configureSearchRegion": _ = HandleConfigureSearchRegionAsync(payload); break;
                    case "waitimage:cropReference": HandleCropReference(payload); break;
                    case "image:testMatch": _ = HandleTestMatchAsync(payload); break;
                    case "mouse:pickPosition": _ = HandleMousePickPositionAsync(payload); break;
                    case "actions:addBrowserAction": HandleAddBrowserAction(payload); break;
                    case "browser:toggleRecording": HandleBrowserToggleRecording(payload); break;
                    case "browser:pickElement": HandlePickElement(); break;
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
                    case "profile:openFolder": HandleProfileOpenFolder(payload); break;
                    case "profile:pin": HandleProfilePin(payload); break;
                    case "profile:unpin": HandleProfileUnpin(payload); break;
                    case "profile:createFolder": HandleCreateFolder(payload); break;
                    case "profile:renameFolder": HandleRenameFolder(payload); break;
                    case "profile:deleteFolder": HandleDeleteFolder(payload); break;
                    case "profile:toggleFolderDisable": HandleToggleFolderDisable(payload); break;
                    case "profile:setFolderColor": HandleSetFolderColor(payload); break;
                    case "profile:toggleFolderCollapse": HandleToggleFolderCollapse(payload); break;
                    case "profile:moveToFolder": HandleMoveToFolder(payload); break;
                    case "profile:reorder": HandleProfileReorder(payload); break;
                    case "profile:export": HandleProfileExport(payload); break;
                    case "profile:import": HandleProfileImport(); break;
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
                    case "window:reloadUI": try { var url = webView.Source; webView.Navigate(url); } catch { } break;
                    case "update:check": _ = CheckForUpdateAsync(); break;
                    case "update:apply": _ = HandleUpdateApply(); break;
                    case "clipboard:read": _ = HandleClipboardRead(); break;
                    case "hotkey:suppress": HandleHotkeySuppress(payload); break;
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

        public void PushActionsUpdate()
        {
            string profileName = CurrentProfileName != "No Profile" ? CurrentProfileName : "default";
            var actionsList = actions.Select((a, i) => new
            {
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
                imageBase64 = a.ActionType == "WaitImage" && !string.IsNullOrEmpty(a.ImagePath)
                    ? ImageStorageService.ReadAsBase64(profileName, a.ImagePath) ?? ""
                    : "",
                // WaitImage extras (forwarded so the editor restores their state)
                waitImageOnTimeout = a.WaitImageOnTimeout,
                waitImageInvert = a.WaitImageInvert,
                waitImageClickOnMatch = a.WaitImageClickOnMatch,
                waitImageSearchX = a.WaitImageSearchX,
                waitImageSearchY = a.WaitImageSearchY,
                waitImageSearchW = a.WaitImageSearchW,
                waitImageSearchH = a.WaitImageSearchH,
                browserText = a.BrowserText ?? "",
                newTab = a.NewTab,
                isSkipped = a.IsSkipped,
                repeatCount = a.RepeatCount,
                // New browser action fields (must be forwarded so the editor restores their state)
                waitMode = a.WaitMode,
                urlWaitPattern = a.UrlWaitPattern,
                postNavigateSelector = a.PostNavigateSelector,
                typeAppend = a.TypeAppend,
                typePaste = a.TypePaste,
                typeDelay = a.TypeDelay
            }).ToArray();

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

        public bool CanUndo => _undoStack.Count > 0;
        public bool CanRedo => _redoStack.Count > 0;

        public void PushProfilesUpdate()
        {
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
                useRelativeCoordinates = p.UseRelativeCoordinates,
                bringToFocus = p.BringToFocus,
                restorePosition = p.RestorePosition,
                restoreSize = p.RestoreSize,
                triggerMode = TriggerModeToString(p.TriggerMode),
                isDisabled = p.IsDisabled
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
                    useRelativeCoordinates = f.UseRelativeCoordinates,
                    bringToFocus = f.BringToFocus
                }).ToArray(),
                ungroupedOrder = order.UngroupedOrder
            };

            SendMessage("profiles:updated", new { profiles, activeProfile = CurrentProfileName == "No Profile" ? (string?)null : CurrentProfileName, profileOrder });
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
                    useCursorClick = UseCursorClick,
                    cursorClickButton = CursorClickButton,
                    cursorClickDelay = CursorClickDelay,
                    cursorClickDelayJitter = CursorClickDelayJitter,
                    cursorClickUseJitter = CursorClickUseJitter,
                    cursorClickHold = CursorClickHold,
                    cursorClickPositionJitter = CursorClickPositionJitter,
                    cursorClickUsePositionJitter = CursorClickUsePositionJitter,
                    cursorClickLoops = CursorClickLoops,
                    cursorClickUseLoops = CursorClickUseLoops,
                    cursorClickInterval = CursorClickInterval,
                    cursorClickUseInterval = CursorClickUseInterval,
                    recordMouse = RecordMouse,
                    recordScroll = RecordScroll,
                    recordKeyboard = RecordKeyboard,
                    profileKeyEnabled = ProfileKeyEnabled,
                    browserSelectorEnabled = BrowserSelectorEnabled,
                    recordingHotkey = profile.RecordingHotkey,
                    replayHotkey = profile.ReplayHotkey,
                    profileKeyToggleHotkey = profile.ProfileKeyToggleHotkey,
                    foregroundHotkey = profile.ForegroundHotkey,
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
            string stateInitProfileName = CurrentProfileName != "No Profile" ? CurrentProfileName : "default";
            SendMessage("state:init", new
            {
                status = "ready",
                actions = actions.Select((a, i) => new
                {
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
                    imageBase64 = a.ActionType == "WaitImage" && !string.IsNullOrEmpty(a.ImagePath)
                        ? ImageStorageService.ReadAsBase64(stateInitProfileName, a.ImagePath) ?? ""
                        : "",
                    // WaitImage extras — must match PushActionsUpdate so the editor restores
                    // the right state on cold start. Without these, the editor saw undefined
                    // for these fields and silently wiped them on the next save.
                    waitImageOnTimeout = a.WaitImageOnTimeout,
                    waitImageInvert = a.WaitImageInvert,
                    waitImageClickOnMatch = a.WaitImageClickOnMatch,
                    waitImageSearchX = a.WaitImageSearchX,
                    waitImageSearchY = a.WaitImageSearchY,
                    waitImageSearchW = a.WaitImageSearchW,
                    waitImageSearchH = a.WaitImageSearchH,
                    browserText = a.BrowserText ?? "",
                    newTab = a.NewTab,
                    isSkipped = a.IsSkipped,
                    repeatCount = a.RepeatCount,
                    // Browser action extras (Wait mode, Navigate post-checks, Type options) —
                    // same fix as the WaitImage extras above.
                    waitMode = a.WaitMode,
                    urlWaitPattern = a.UrlWaitPattern,
                    postNavigateSelector = a.PostNavigateSelector,
                    typeAppend = a.TypeAppend,
                    typePaste = a.TypePaste,
                    typeDelay = a.TypeDelay
                }).ToArray(),
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
                    useRelativeCoordinates = f.UseRelativeCoordinates,
                    bringToFocus = f.BringToFocus
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
                    useCursorClick = UseCursorClick,
                    cursorClickButton = CursorClickButton,
                    cursorClickDelay = CursorClickDelay,
                    cursorClickDelayJitter = CursorClickDelayJitter,
                    cursorClickUseJitter = CursorClickUseJitter,
                    cursorClickHold = CursorClickHold,
                    cursorClickPositionJitter = CursorClickPositionJitter,
                    cursorClickUsePositionJitter = CursorClickUsePositionJitter,
                    cursorClickLoops = CursorClickLoops,
                    cursorClickUseLoops = CursorClickUseLoops,
                    cursorClickInterval = CursorClickInterval,
                    cursorClickUseInterval = CursorClickUseInterval,
                    recordMouse = RecordMouse,
                    recordScroll = RecordScroll,
                    recordKeyboard = RecordKeyboard,
                    profileKeyEnabled = ProfileKeyEnabled,
                    browserSelectorEnabled = BrowserSelectorEnabled,
                    recordingHotkey = profile.RecordingHotkey,
                    replayHotkey = profile.ReplayHotkey,
                    profileKeyToggleHotkey = profile.ProfileKeyToggleHotkey,
                    foregroundHotkey = profile.ForegroundHotkey,
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

        private async Task CheckForUpdateAsync()
        {
            try
            {
                var newVersion = await UpdateService.CheckForUpdateAsync();
                if (newVersion != null)
                {
                    // Fetch release notes in parallel — best-effort, may be empty
                    var notes = await UpdateService.GetPendingReleaseNotesAsync();

                    SendMessage("update:available", new
                    {
                        version = newVersion,
                        currentVersion = UpdateService.CurrentVersion ?? "unknown",
                        notes = notes
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
                UpdateService.ApplyAndRestart();
            }
            else
            {
                SendMessage("update:error", new { message = "Download failed" });
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
            var bgSurface = payload.GetProperty("bgSurface").GetString();
            var bgCard = payload.GetProperty("bgCard").GetString();
            var textPrimary = payload.GetProperty("textPrimary").GetString();
            var textSecondary = payload.GetProperty("textSecondary").GetString();
            var accentSolid = payload.GetProperty("accentSolid").GetString();
            var borderSubtle = payload.GetProperty("borderSubtle").GetString();

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

        private void HandleSelectionChanged(JsonElement payload)
        {
            if (payload.TryGetProperty("indices", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
                // Pick MAX index — the global Recording hotkey reads this to know where to drop
                // new actions, and the convention everywhere else (toolbar add-action, ActionBar
                // Record button) is "insert AFTER the last selected row". Min was the wrong end:
                // it pushed existing rows down instead of flowing the new ones below the selection.
                // Null when no selection → recorder treats it as "append at end".
                int? max = null;
                foreach (var el in arr.EnumerateArray())
                {
                    int val = el.GetInt32();
                    if (max == null || val > max) max = val;
                }
                SelectedInsertIndex = max == null ? null : max + 1;
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
                int delay = int.TryParse(CursorClickDelay, out var d) ? d : 100;
                int jitterPercent = int.TryParse(CursorClickDelayJitter, out var jp) ? jp : 0;
                int holdMs = int.TryParse(CursorClickHold, out var h) ? h : 10;
                int positionJitter = CursorClickUsePositionJitter && int.TryParse(CursorClickPositionJitter, out var pj) ? pj : 0;
                // Loop convention: loops disabled → 1 iteration; loops enabled + count=0 → infinite.
                int loops = CursorClickUseLoops && int.TryParse(CursorClickLoops, out var lc) && lc >= 0 ? lc : 1;
                int interval = CursorClickUseInterval && int.TryParse(CursorClickInterval, out var li) ? li : 0;
                mainController.ToggleCursorClickReplay(delay, CursorClickUseJitter, jitterPercent, loops, interval, CursorClickButton, holdMs, positionJitter);
                return;
            }

            bool loopEnabled = payload.GetProperty("loopEnabled").GetBoolean();
            string loopCount = payload.GetProperty("loopCount").GetString() ?? "1";
            bool intervalEnabled = payload.GetProperty("intervalEnabled").GetBoolean();
            string intervalText = payload.GetProperty("intervalText").GetString() ?? "0";

            bool useVariation = UseDelayVariation;
            int variationPercent = int.TryParse(DelayVariation, out var vp) ? vp : 20;
            var effTarget = CurrentProfileName != "No Profile" ? profileController.GetEffectiveWindowTarget(CurrentProfileName) : UserProfile.Current.TargetWindow;
            var effRelCoords = CurrentProfileName != "No Profile" ? profileController.GetEffectiveRelativeCoordinates(CurrentProfileName) : UserProfile.Current.UseRelativeCoordinates;
            var effBringFocus = CurrentProfileName != "No Profile" ? profileController.GetEffectiveBringToFocus(CurrentProfileName) : UserProfile.Current.BringToFocus;
            mainController.ToggleReplay(loopEnabled, loopCount, intervalEnabled, intervalText, useVariation, variationPercent, effRelCoords, effTarget, effBringFocus, UserProfile.Current.WindowWidth, UserProfile.Current.WindowHeight, UserProfile.Current.WindowX, UserProfile.Current.WindowY, UserProfile.Current.RestorePosition, UserProfile.Current.RestoreSize);
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
                {
                    var a = actions[idx];
                    _copiedActions.Add(new ActionItem
                    {
                        ActionType = a.ActionType,
                        Key = a.Key,
                        X = a.X,
                        Y = a.Y,
                        Delay = a.Delay,
                        Comment = a.Comment,
                        Timeout = a.Timeout,
                        Confidence = a.Confidence,
                        ImagePath = a.ImagePath,
                        BrowserText = a.BrowserText,
                        NewTab = a.NewTab,
                        IsSkipped = a.IsSkipped,
                        WaitMode = a.WaitMode,
                        UrlWaitPattern = a.UrlWaitPattern,
                        PostNavigateSelector = a.PostNavigateSelector,
                        TypeAppend = a.TypeAppend,
                        TypePaste = a.TypePaste,
                        TypeDelay = a.TypeDelay
                    });
                }
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

            foreach (var copied in _copiedActions)
            {
                string? clonedImagePath = copied.ImagePath;
                if (copied.ActionType == "WaitImage" && !string.IsNullOrEmpty(copied.ImagePath))
                {
                    clonedImagePath = ImageStorageService.CloneReferenceImage(srcProfile, copied.ImagePath, dstProfile)
                                      ?? copied.ImagePath;
                }
                var clone = new ActionItem
                {
                    ActionType = copied.ActionType,
                    Key = copied.Key,
                    X = copied.X,
                    Y = copied.Y,
                    Delay = copied.Delay,
                    Comment = copied.Comment,
                    Timeout = copied.Timeout,
                    Confidence = copied.Confidence,
                    ImagePath = clonedImagePath,
                    BrowserText = copied.BrowserText,
                    NewTab = copied.NewTab,
                    IsSkipped = copied.IsSkipped,
                    RowNumber = insertIndex + 1
                };
                actions.Insert(insertIndex, clone);
                insertIndex++;
            }

            // Recalculate row numbers
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;

            HasUnsavedChanges = true;
            SendMessage("alert:show", new { message = $"Pasted {_copiedActions.Count} action(s)" });
            PushActionsUpdate();
        }

        private void HandleActionsEdit(JsonElement payload)
        {
            PushUndoState();
            int index = payload.GetProperty("index").GetInt32();
            string field = payload.GetProperty("field").GetString() ?? "";
            string value = payload.GetProperty("value").GetString() ?? "";

            if (index < 0 || index >= actions.Count) return;

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
            }

            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        private void HandleActionsDelete(JsonElement payload)
        {
            PushUndoState();
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32())
                .OrderByDescending(i => i)
                .ToList();

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
                    // Only apply X/Y to mouse click actions
                    if (a.ActionType is not ("LeftClickDown" or "LeftClickUp" or "RightClickDown" or "RightClickUp" or "MiddleClickDown" or "MiddleClickUp"))
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
            PushUndoState();
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32())
                .Where(i => i >= 0 && i < actions.Count)
                .ToList();
            if (indices.Count == 0) return;

            // Smart toggle: if every selected action is already skipped, un-skip all;
            // otherwise skip all. Consistent with how most UIs handle batch toggles.
            bool allSkipped = indices.All(i => actions[i].IsSkipped);
            bool newState = !allSkipped;

            foreach (var idx in indices)
                actions[idx].IsSkipped = newState;

            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        private void HandleActionsReorder(JsonElement payload)
        {
            PushUndoState();
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32())
                .OrderBy(i => i)
                .ToList();
            int targetIndex = payload.GetProperty("targetIndex").GetInt32();

            if (indices.Count == 0) return;

            // Validate all indices
            var validIndices = indices.Where(i => i >= 0 && i < actions.Count).ToList();
            if (validIndices.Count == 0) return;

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
            PushUndoState();
            string text = payload.GetProperty("text").GetString() ?? "";
            if (string.IsNullOrEmpty(text)) return;

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
            PushUndoState();
            int index = payload.GetProperty("index").GetInt32();
            string text = payload.GetProperty("text").GetString() ?? "";

            if (index < 0 || index >= actions.Count) return;
            if (actions[index].ActionType != "SendText") return;

            actions[index].Key = text;
            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        // ── Profile chaining: insert / edit a RunProfile action ──

        private void HandleAddRunProfile(JsonElement payload)
        {
            PushUndoState();
            string targetName = payload.GetProperty("profileName").GetString() ?? "";
            if (string.IsNullOrEmpty(targetName)) return;

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
            PushUndoState();
            int index = payload.GetProperty("index").GetInt32();
            if (index < 0 || index >= actions.Count) return;
            if (actions[index].ActionType != "RunProfile") return;

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

        // Manual resume from the status-bar Resume button. Forwards to the replay service which
        // fires the same callback the resume hotkey would, freeing ExecutePause's await.
        private void HandleReplayResume(JsonElement payload)
        {
            replayService.ManualResume();
        }

        private void HandleInsertAction(JsonElement payload)
        {
            PushUndoState();
            string actionType = payload.GetProperty("actionType").GetString() ?? "";
            int insertIndex = payload.GetProperty("insertIndex").GetInt32();
            if (string.IsNullOrEmpty(actionType)) return;

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
                return;
            }

            // Pause: insert directly with empty hotkey + 0 timeout (user configures via Edit sheet)
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
                return;
            }

            mainController.StartCaptureMode(insertIndex, captureType, mouseButton, () =>
            {
                HasUnsavedChanges = true;
                mainController.UpdateButtonStates();
            });
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
            });
        }

        private void HandleWaitImageRecapture(JsonElement payload)
        {
            int index = payload.GetProperty("index").GetInt32();
            if (index < 0 || index >= actions.Count || actions[index].ActionType != "WaitImage") return;
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

            // Save new image. We intentionally keep the old PNG on disk so undo can restore the
            // previous reference image. Orphan PNGs are cleaned up at app startup by
            // ImageStorageService.CleanupOrphanImages.
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
                    searchRegion = new System.Drawing.Rectangle(sx, sy, sw, sh);
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
                SendMessage("image:testMatchResult", new
                {
                    requestId,
                    found = result.Score >= confidence,
                    score = result.Score,
                    x = result.X, y = result.Y, w = result.W, h = result.H
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
            if (action.ActionType != "WaitImage" || string.IsNullOrEmpty(action.ImagePath)) return;
            if (w < 10 || h < 10) return;

            string profileName = CurrentProfileName != "No Profile" ? CurrentProfileName : "default";
            using var current = ImageStorageService.LoadReferenceImage(profileName, action.ImagePath);
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

        // Lets the user draw a search ROI for an existing WaitImage. Behaves like the recapture
        // flow but in "region-only" mode — no PNG is saved, just the rect is reported back.
        private async Task HandleConfigureSearchRegionAsync(JsonElement payload)
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
                System.Diagnostics.Debug.WriteLine($"[WaitImage] Configure-region screenshot failed: {ex.Message}");
                dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));
                SendMessage("waitimage:searchRegionSet", new { requestId, cancelled = true });
                return;
            }

            RegionSelectionResult? selection = null;
            var thread = new Thread(() =>
            {
                System.Windows.Forms.Application.EnableVisualStyles();
                using var overlay = new ScreenOverlayForm(
                    screenshot,
                    regionOnly: true,
                    hintText: "Drag to set the search area for this Wait Image  •  ESC to cancel");
                overlay.ShowDialog();
                selection = overlay.GetSelectionAsync().Result;
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            await Task.Run(() => thread.Join());

            dispatcherQueue.TryEnqueue(() => NativeMethods.ShowWindow(mainHwnd, NativeMethods.SW_RESTORE));

            if (selection == null)
            {
                SendMessage("waitimage:searchRegionSet", new { requestId, cancelled = true });
                return;
            }

            SendMessage("waitimage:searchRegionSet", new
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
            PushUndoState();
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32())
                .OrderBy(i => i)
                .ToList();

            if (indices.Count == 0) return;

            var validIndices = indices.Where(i => i >= 0 && i < actions.Count).ToList();
            if (validIndices.Count == 0) return;

            string profileName = CurrentProfileName != "No Profile" ? CurrentProfileName : "default";

            actions.CollectionChanged -= OnActionsChanged;
            try
            {
                int insertPos = validIndices.Last() + 1;
                foreach (var idx in validIndices)
                {
                    var original = actions[idx];
                    string? clonedImagePath = original.ImagePath;
                    if (original.ActionType == "WaitImage" && !string.IsNullOrEmpty(original.ImagePath))
                    {
                        clonedImagePath = ImageStorageService.CloneReferenceImage(profileName, original.ImagePath, profileName)
                                          ?? original.ImagePath;
                    }
                    var clone = new ActionItem
                    {
                        ActionType = original.ActionType,
                        Key = original.Key,
                        X = original.X,
                        Y = original.Y,
                        Delay = original.Delay,
                        Comment = original.Comment,
                        ImagePath = clonedImagePath,
                        Timeout = original.Timeout,
                        Confidence = original.Confidence,
                        WaitImageOnTimeout = original.WaitImageOnTimeout,
                        WaitImageInvert = original.WaitImageInvert,
                        WaitImageClickOnMatch = original.WaitImageClickOnMatch,
                        WaitImageSearchX = original.WaitImageSearchX,
                        WaitImageSearchY = original.WaitImageSearchY,
                        WaitImageSearchW = original.WaitImageSearchW,
                        WaitImageSearchH = original.WaitImageSearchH,
                        BrowserText = original.BrowserText,
                        NewTab = original.NewTab,
                        IsSkipped = original.IsSkipped,
                        WaitMode = original.WaitMode,
                        UrlWaitPattern = original.UrlWaitPattern,
                        PostNavigateSelector = original.PostNavigateSelector,
                        TypeAppend = original.TypeAppend,
                        TypePaste = original.TypePaste,
                        TypeDelay = original.TypeDelay
                    };
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
        }

        private void HandleBrowserToggleRecording(JsonElement payload)
        {
            bool enabled = payload.TryGetProperty("enabled", out var enEl) && enEl.GetBoolean();
            browserBridge?.SetRecordingMode(enabled);
        }

        private async void HandlePickElement()
        {
            if (browserBridge == null || !browserBridge.IsConnected)
            {
                SendMessage("browser:pickResult", new { selector = (string?)null, alternatives = new object[0], error = "Browser extension is not connected." });
                return;
            }

            try
            {
                var pick = await browserBridge.PickElementAsync(CancellationToken.None);
                SendMessage("browser:pickResult", new
                {
                    selector = pick.Selector,
                    alternatives = pick.Alternatives.Select(a => new { selector = a.Selector, tier = a.Tier, description = a.Description }).ToArray()
                });
            }
            catch (Exception ex)
            {
                SendMessage("browser:pickResult", new { selector = (string?)null, alternatives = new object[0], error = ex.Message });
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

        private async void HandleProfileCreate(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            // Extract folder before any await (JsonDocument may be disposed after await)
            string? folderName = payload.TryGetProperty("folder", out var fp) && fp.ValueKind == JsonValueKind.String
                ? fp.GetString() : null;

            if (string.IsNullOrEmpty(name)) return;

            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles");
            Directory.CreateDirectory(profileDir);

            if (!name.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                name += ".json";

            string fullPath = Path.Combine(profileDir, name);
            if (File.Exists(fullPath)) return;

            var profile = UserProfile.Default;
            await SettingsManager.SaveProfileAsync(fullPath, profile);
            await profileController.RefreshProfileListAsync(true);
            if (!string.IsNullOrEmpty(folderName))
            {
                var order = profileController.GetProfileOrder();
                var folder = order.Folders.FirstOrDefault(f => f.Name == folderName);
                if (folder != null)
                {
                    string profileName = Path.GetFileNameWithoutExtension(fullPath);
                    order.UngroupedOrder.Remove(profileName);
                    if (!folder.Items.Contains(profileName))
                        folder.Items.Add(profileName);
                    await profileController.SaveProfileOrderAsync();
                }
            }

            PushProfilesUpdate();
        }

        private async void HandleProfileToggleDisable(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
            if (entry == null || !File.Exists(entry.FilePath)) return;

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

        private async void HandleProfileRename(JsonElement payload)
        {
            string oldName = payload.GetProperty("oldName").GetString() ?? "";
            string newName = payload.GetProperty("newName").GetString() ?? "";
            if (string.IsNullOrEmpty(oldName) || string.IsNullOrEmpty(newName)) return;

            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == oldName);
            if (entry == null) return;

            string? folderPath = Path.GetDirectoryName(entry.FilePath);
            if (folderPath == null) return;

            string newFileName = newName.EndsWith(".json", StringComparison.OrdinalIgnoreCase) ? newName : newName + ".json";
            string newFilePath = Path.Combine(folderPath, newFileName);

            // Allow case-only rename (e.g. "teste" → "TESTE") on case-insensitive file systems
            if (File.Exists(newFilePath) && !string.Equals(entry.FilePath, newFilePath, StringComparison.OrdinalIgnoreCase))
                return;

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
            if (string.IsNullOrEmpty(name)) return;

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
                if (!keepInheritedTarget)
                {
                    profile.TargetWindow = new WindowTarget
                    {
                        ProcessName = string.IsNullOrWhiteSpace(processName) ? null : processName.Trim(),
                        WindowTitle = string.IsNullOrWhiteSpace(windowTitle) ? null : windowTitle.Trim(),
                        TitleMatchMode = titleMatchMode
                    };
                }
                profile.UseRelativeCoordinates = relativeCoordinates;
                profile.BringToFocus = bringToFocus;
                profile.RestorePosition = restorePosition;
                profile.RestoreSize = restoreSize;
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
                if (CurrentProfileName == name)
                {
                    if (!keepInheritedTarget)
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
                {
                    UserProfile.Current.TargetWindow = null;
                    UserProfile.Current.UseRelativeCoordinates = false;
                    UserProfile.Current.BringToFocus = false;
                    UserProfile.Current.RestorePosition = false;
                    UserProfile.Current.RestoreSize = false;
                    UserProfile.Current.WindowX = 0;
                    UserProfile.Current.WindowY = 0;
                    UserProfile.Current.WindowWidth = 0;
                    UserProfile.Current.WindowHeight = 0;
                }
                await profileController.RefreshProfileListAsync(true);
                InputHookManager.RegisterProfileWindowTargets(profileController.GetProfileWindowTargets(), profileController.GetBringToFocusProfiles());
                PushProfilesUpdate();
            }
        }

        private void HandleConvertCoordinates(JsonElement payload)
        {
            string direction = payload.GetProperty("direction").GetString() ?? "toRelative";

            if (actions.Count == 0)
            {
                SendMessage("alert:show", new { message = "No actions to convert." });
                return;
            }

            // Use effective target (profile's own > folder-inherited)
            var target = CurrentProfileName != "No Profile"
                ? profileController.GetEffectiveWindowTarget(CurrentProfileName)
                : UserProfile.Current.TargetWindow;
            if (target == null || string.IsNullOrEmpty(target.ProcessName))
            {
                SendMessage("alert:show", new { message = "Set a Window Target first (profile or folder)." });
                return;
            }

            // Find target window
            IntPtr hwnd = IntPtr.Zero;
            NativeMethods.EnumWindows((h, l) =>
            {
                if (!NativeMethods.IsWindowVisible(h)) return true;
                NativeMethods.GetWindowThreadProcessId(h, out uint pid);
                IntPtr hProcess = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (hProcess == IntPtr.Zero) return true;
                try
                {
                    var sb = new System.Text.StringBuilder(1024);
                    uint len = NativeMethods.GetProcessImageFileName(hProcess, sb, (uint)sb.Capacity);
                    if (len == 0) return true;
                    string fullPath = sb.ToString();
                    string fileName = fullPath.Substring(fullPath.LastIndexOf('\\') + 1);
                    if (fileName.Equals(target.ProcessName, StringComparison.OrdinalIgnoreCase))
                    {
                        hwnd = h;
                        return false;
                    }
                }
                finally { NativeMethods.CloseHandle(hProcess); }
                return true;
            }, IntPtr.Zero);

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

            PushUndoState();

            var clickTypes = new HashSet<string> { "LeftClickDown", "LeftClickUp", "RightClickDown", "RightClickUp", "MiddleClickDown", "MiddleClickUp" };
            int converted = 0;

            if (direction == "toRelative")
            {
                foreach (var action in actions)
                {
                    if (clickTypes.Contains(action.ActionType))
                    {
                        action.X -= rect.Left;
                        action.Y -= rect.Top;
                        converted++;
                    }
                }
                UserProfile.Current.UseRelativeCoordinates = true;
                UserProfile.Current.WindowWidth = rect.Right - rect.Left;
                UserProfile.Current.WindowHeight = rect.Bottom - rect.Top;
            }
            else // toAbsolute
            {
                foreach (var action in actions)
                {
                    if (clickTypes.Contains(action.ActionType))
                    {
                        action.X += rect.Left;
                        action.Y += rect.Top;
                        converted++;
                    }
                }
                UserProfile.Current.UseRelativeCoordinates = false;
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

            // Compile regex once if needed
            System.Text.RegularExpressions.Regex? titleRegex = null;
            if (target.TitleMatchMode == "regex" && !string.IsNullOrWhiteSpace(target.WindowTitle))
            {
                try { titleRegex = new System.Text.RegularExpressions.Regex(target.WindowTitle.Trim()); }
                catch { /* fall through to substring match */ }
            }

            // Find target window — matches by process name (if given) and/or title
            IntPtr hwnd = IntPtr.Zero;
            NativeMethods.EnumWindows((h, l) =>
            {
                if (!NativeMethods.IsWindowVisible(h)) return true;

                // Process name check
                bool procOk = string.IsNullOrEmpty(target.ProcessName);
                if (!procOk)
                {
                    NativeMethods.GetWindowThreadProcessId(h, out uint pid);
                    IntPtr hProcess = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                    if (hProcess == IntPtr.Zero) return true;
                    try
                    {
                        var sb = new System.Text.StringBuilder(1024);
                        uint len = NativeMethods.GetProcessImageFileName(hProcess, sb, (uint)sb.Capacity);
                        if (len == 0) return true;
                        string fullPath = sb.ToString();
                        string fileName = fullPath.Substring(fullPath.LastIndexOf('\\') + 1);
                        procOk = fileName.Equals(target.ProcessName, StringComparison.OrdinalIgnoreCase);
                    }
                    finally { NativeMethods.CloseHandle(hProcess); }
                }
                if (!procOk) return true;

                // Title check
                bool titleOk = string.IsNullOrEmpty(target.WindowTitle);
                if (!titleOk)
                {
                    var titleSb = new System.Text.StringBuilder(512);
                    NativeMethods.GetWindowText(h, titleSb, titleSb.Capacity);
                    string winTitle = titleSb.ToString();
                    if (titleRegex != null) titleOk = titleRegex.IsMatch(winTitle);
                    else titleOk = winTitle.IndexOf(target.WindowTitle!, StringComparison.OrdinalIgnoreCase) >= 0;
                }
                if (!titleOk) return true;

                hwnd = h;
                return false;
            }, IntPtr.Zero);

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

            // Resolve the profile to save geometry into: explicit name from the dialog, or the
            // currently active profile as fallback.
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
            }, relativeCoordinates, bringToFocus);
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

        private void HandleProfileOpenFolder(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
            if (entry == null) return;

            if (File.Exists(entry.FilePath))
            {
                try
                {
                    System.Diagnostics.Process.Start("explorer.exe", $"/select,\"{entry.FilePath}\"");
                }
                catch { }
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
            await profileController.CreateFolderAsync(name, color);
            PushProfilesUpdate();
        }

        private async void HandleRenameFolder(JsonElement payload)
        {
            string oldName = payload.GetProperty("oldName").GetString() ?? "";
            string newName = payload.GetProperty("newName").GetString() ?? "";
            if (string.IsNullOrEmpty(oldName) || string.IsNullOrEmpty(newName)) return;
            await profileController.RenameFolderAsync(oldName, newName);
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

        private async void HandleProfileImport()
        {
            try
            {
                var (imported, skipped, cancelled, hasOrganization) = await profileController.ImportProfilesAsync();

                if (cancelled && imported == 0)
                    return;

                if (imported > 0)
                {
                    PushProfilesUpdate();
                    string msg = $"Imported {imported} profile(s).";
                    if (skipped > 0)
                        msg += $" {skipped} skipped.";
                    if (hasOrganization)
                        msg += " Folder organization imported.";
                    SendMessage("alert:show", new { message = msg });
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
            UseCursorClick = defaults.UseCursorClick;       // preserved above
            CursorClickButton = defaults.CursorClickButton; // preserved above
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
                UseCursorClick = UseCursorClick,
                CursorClickButton = CursorClickButton,
                // Clicker v2 — persist the dedicated Clicker settings alongside the legacy ones.
                CursorClickDelayMs = int.TryParse(CursorClickDelay, out var ccd) ? ccd : 100,
                CursorClickDelayJitterPct = int.TryParse(CursorClickDelayJitter, out var ccdj) ? ccdj : 0,
                CursorClickUseJitter = CursorClickUseJitter,
                CursorClickHoldMs = int.TryParse(CursorClickHold, out var cch) ? cch : 10,
                CursorClickPositionJitter = int.TryParse(CursorClickPositionJitter, out var ccpj) ? ccpj : 0,
                CursorClickUsePositionJitter = CursorClickUsePositionJitter,
                CursorClickLoops = int.TryParse(CursorClickLoops, out var ccl) ? ccl : 0,
                CursorClickUseLoops = CursorClickUseLoops,
                CursorClickIntervalMs = int.TryParse(CursorClickInterval, out var cci) ? cci : 0,
                CursorClickUseInterval = CursorClickUseInterval,
                RecordMouse = RecordMouse,
                RecordScroll = RecordScroll,
                RecordKeyboard = RecordKeyboard,
                RecordingHotkey = UserProfile.Current.RecordingHotkey,
                ReplayHotkey = UserProfile.Current.ReplayHotkey,
                ProfileKeyToggleHotkey = UserProfile.Current.ProfileKeyToggleHotkey,
                ForegroundHotkey = UserProfile.Current.ForegroundHotkey,
                ProfileKeyEnabled = ProfileKeyEnabled,
                BrowserSelectorEnabled = BrowserSelectorEnabled,
                RunAsAdmin = AppSettingsManager.Load().RunAsAdmin,
            };
            AppSettingsManager.Save(s);
        }

        private static readonly HashSet<string> HotkeySettingKeys = new()
        {
            "recordingHotkey", "replayHotkey", "profileKeyToggleHotkey", "foregroundHotkey"
        };

        private static readonly Dictionary<string, string> HotkeyDisplayNames = new()
        {
            ["recordingHotkey"] = "Recording",
            ["replayHotkey"] = "Replay",
            ["profileKeyToggleHotkey"] = "Profile Key Toggle",
            ["foregroundHotkey"] = "Foreground",
        };

        private static bool EffectiveTargetsOverlap(WindowTarget? a, WindowTarget? b)
        {
            if (a == null && b == null) return true;     // both global
            if (a == null || b == null) return true;     // one global = overlaps everything

            bool sameProcess = string.Equals(
                a.ProcessName ?? "", b.ProcessName ?? "", StringComparison.OrdinalIgnoreCase);
            bool sameTitle = string.Equals(
                a.WindowTitle ?? "", b.WindowTitle ?? "", StringComparison.OrdinalIgnoreCase);

            return sameProcess && sameTitle;
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
                case "useCursorClick":
                    UseCursorClick = valueElement.GetBoolean();
                    // Switching modes mid-execution: cancel anything currently running so the
                    // app's "active" state matches the new mode. Recording is also stopped — Clicker
                    // ignores recorded actions, and switching back to Replay mid-recording is unusual.
                    if (replayService.IsReplaying)
                        mainController.StopReplayIfRunning();
                    if (recordingService.IsRecording)
                        recordingService.StopRecording();
                    break;
                case "cursorClickButton":
                    CursorClickButton = valueElement.GetString() ?? "Left";
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
                    UserProfile.Current.ForegroundHotkey = valueElement.GetString() ?? "Ctrl+Insert";
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
        }
    }
}
