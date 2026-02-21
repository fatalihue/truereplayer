using Microsoft.UI.Dispatching;
using Microsoft.Web.WebView2.Core;
using System;
using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using TrueReplayer.Controllers;
using TrueReplayer.Interop;
using TrueReplayer.Models;
using TrueReplayer.Services;

namespace TrueReplayer
{
    public class WebViewBridge
    {
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

        // In-memory settings state (replaces reading from XAML controls)
        public string CustomDelay { get; set; } = "100";
        public bool UseCustomDelay { get; set; } = true;
        public string LoopCount { get; set; } = "0";
        public bool EnableLoop { get; set; } = false;
        public string LoopInterval { get; set; } = "1000";
        public bool LoopIntervalEnabled { get; set; } = false;
        public bool RecordMouse { get; set; } = true;
        public bool RecordScroll { get; set; } = true;
        public bool RecordKeyboard { get; set; } = true;
        public bool ProfileKeyEnabled { get; set; } = true;

        // Selection state (synced from React)
        public int? SelectedInsertIndex { get; private set; }

        // Toolbar/StatusBar state
        public string CurrentProfileName { get; set; } = "No Profile";

        public WebViewBridge(
            CoreWebView2 webView,
            ObservableCollection<ActionItem> actions,
            MainController mainController,
            ProfileController profileController,
            RecordingService recordingService,
            ReplayService replayService,
            DispatcherQueue dispatcherQueue,
            MainWindow window)
        {
            this.webView = webView;
            this.actions = actions;
            this.mainController = mainController;
            this.profileController = profileController;
            this.recordingService = recordingService;
            this.replayService = replayService;
            this.dispatcherQueue = dispatcherQueue;
            this.window = window;

            // Watch for actions collection changes
            actions.CollectionChanged += OnActionsChanged;
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
                    case "actions:clear": HandleActionsClear(); break;
                    case "actions:copy": HandleActionsCopy(); break;
                    case "actions:edit": HandleActionsEdit(payload); break;
                    case "actions:delete": HandleActionsDelete(payload); break;
                    case "actions:bulkUpdateDelay": HandleBulkUpdateDelay(payload); break;
                    case "profile:click": HandleProfileClick(payload); break;
                    case "profile:create": HandleProfileCreate(payload); break;
                    case "profile:rename": HandleProfileRename(payload); break;
                    case "profile:delete": HandleProfileDelete(payload); break;
                    case "profile:assignHotkey": HandleProfileAssignHotkey(payload); break;
                    case "profile:removeHotkey": HandleProfileRemoveHotkey(payload); break;
                    case "profile:openFolder": HandleProfileOpenFolder(payload); break;
                    case "profile:save": HandleProfileSave(); break;
                    case "profile:load": HandleProfileLoad(); break;
                    case "profile:reset": HandleProfileReset(); break;
                    case "selection:changed": HandleSelectionChanged(payload); break;
                    case "settings:change": HandleSettingsChange(payload); break;
                    case "window:alwaysOnTop": HandleAlwaysOnTop(payload); break;
                    case "window:minimizeToTray": HandleMinimizeToTray(payload); break;
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

        // ── Push methods (C# → React) ──

        public void PushStatusChange(string status)
        {
            SendMessage("status:changed", new { status });
            PushButtonStates();
        }

        public void PushActionsUpdate()
        {
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
                shouldHighlight = a.ShouldHighlight
            }).ToArray();

            SendMessage("actions:updated", new { actions = actionsList });
            PushToolbarUpdate();
            PushStatusBarUpdate();
        }

        public void PushProfilesUpdate()
        {
            var profiles = profileController.ProfileEntries.Select(p => new
            {
                name = p.Name,
                filePath = p.FilePath,
                hotkey = p.Hotkey,
                isActive = p.IsActive
            }).ToArray();

            SendMessage("profiles:updated", new { profiles, activeProfile = CurrentProfileName == "No Profile" ? (string?)null : CurrentProfileName });
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
                    loopCount = LoopCount,
                    enableLoop = EnableLoop,
                    loopInterval = LoopInterval,
                    loopIntervalEnabled = LoopIntervalEnabled,
                    recordMouse = RecordMouse,
                    recordScroll = RecordScroll,
                    recordKeyboard = RecordKeyboard,
                    profileKeyEnabled = ProfileKeyEnabled,
                    recordingHotkey = profile.RecordingHotkey,
                    replayHotkey = profile.ReplayHotkey,
                    profileKeyToggleHotkey = profile.ProfileKeyToggleHotkey,
                    alwaysOnTop = profile.AlwaysOnTop,
                    minimizeToTray = profile.MinimizeToTray
                }
            });
        }

        public void PushButtonStates()
        {
            SendMessage("button:states", new
            {
                recordEnabled = true,
                replayEnabled = actions.Count > 0,
                recordingActive = recordingService.IsRecording,
                replayActive = replayService.IsReplaying,
                recordButtonText = recordingService.IsRecording ? "Pause" : "Recording",
                replayButtonText = replayService.IsReplaying ? "Stop" : "Replay"
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

        public void PushActionHighlight(int index)
        {
            SendMessage("actions:highlight", new { index });
        }

        // ── Apply profile to bridge state ──

        public void ApplyProfile(UserProfile profile)
        {
            actions.Clear();
            foreach (var action in profile.Actions)
                actions.Add(action);

            CustomDelay = profile.CustomDelay.ToString();
            UseCustomDelay = profile.UseCustomDelay;
            LoopCount = profile.LoopCount.ToString();
            EnableLoop = profile.EnableLoop;
            LoopInterval = profile.LoopInterval.ToString();
            LoopIntervalEnabled = profile.LoopIntervalEnabled;
            RecordMouse = profile.RecordMouse;
            RecordScroll = profile.RecordScroll;
            RecordKeyboard = profile.RecordKeyboard;
            ProfileKeyEnabled = profile.ProfileKeyEnabled;

            PushSettingsLoaded();
            PushActionsUpdate();
            PushButtonStates();
        }

        public UserProfile CreateProfileFromState()
        {
            return new UserProfile
            {
                Actions = actions,
                RecordingHotkey = UserProfile.Current.RecordingHotkey,
                ReplayHotkey = UserProfile.Current.ReplayHotkey,
                ProfileKeyToggleHotkey = UserProfile.Current.ProfileKeyToggleHotkey,
                RecordMouse = RecordMouse,
                RecordScroll = RecordScroll,
                RecordKeyboard = RecordKeyboard,
                UseCustomDelay = UseCustomDelay,
                CustomDelay = int.TryParse(CustomDelay, out var d) ? d : 100,
                EnableLoop = EnableLoop,
                LoopCount = int.TryParse(LoopCount, out var c) ? c : 0,
                LoopIntervalEnabled = LoopIntervalEnabled,
                LoopInterval = int.TryParse(LoopInterval, out var li) ? li : 1000,
                ProfileKeyEnabled = ProfileKeyEnabled,
                CustomHotkey = UserProfile.Current.CustomHotkey,
                AlwaysOnTop = UserProfile.Current.AlwaysOnTop,
                MinimizeToTray = UserProfile.Current.MinimizeToTray
            };
        }

        // ── Handler methods ──

        private void HandleUIReady()
        {
            // Send full state to React
            var profile = UserProfile.Current;
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
                    shouldHighlight = a.ShouldHighlight
                }).ToArray(),
                highlightedActionIndex = (int?)null,
                profiles = profileController.ProfileEntries.Select(p => new
                {
                    name = p.Name,
                    filePath = p.FilePath,
                    hotkey = p.Hotkey,
                    isActive = p.IsActive
                }).ToArray(),
                activeProfile = CurrentProfileName == "No Profile" ? (string?)null : CurrentProfileName,
                settings = new
                {
                    customDelay = CustomDelay,
                    useCustomDelay = UseCustomDelay,
                    loopCount = LoopCount,
                    enableLoop = EnableLoop,
                    loopInterval = LoopInterval,
                    loopIntervalEnabled = LoopIntervalEnabled,
                    recordMouse = RecordMouse,
                    recordScroll = RecordScroll,
                    recordKeyboard = RecordKeyboard,
                    profileKeyEnabled = ProfileKeyEnabled,
                    recordingHotkey = profile.RecordingHotkey,
                    replayHotkey = profile.ReplayHotkey,
                    profileKeyToggleHotkey = profile.ProfileKeyToggleHotkey,
                    alwaysOnTop = profile.AlwaysOnTop,
                    minimizeToTray = profile.MinimizeToTray
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
                    recordEnabled = true,
                    replayEnabled = actions.Count > 0,
                    recordingActive = false,
                    replayActive = false,
                    recordButtonText = "Recording",
                    replayButtonText = "Replay"
                }
            });
        }

        private void HandleSelectionChanged(JsonElement payload)
        {
            if (payload.TryGetProperty("indices", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
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
            int? insertIndex = null;
            if (payload.TryGetProperty("insertIndex", out var idxEl) && idxEl.ValueKind == JsonValueKind.Number)
                insertIndex = idxEl.GetInt32();

            mainController.EnableInsertMode(insertIndex);
            mainController.ToggleRecording();
        }

        private void HandleReplayToggle(JsonElement payload)
        {
            bool loopEnabled = payload.GetProperty("loopEnabled").GetBoolean();
            string loopCount = payload.GetProperty("loopCount").GetString() ?? "1";
            bool intervalEnabled = payload.GetProperty("intervalEnabled").GetBoolean();
            string intervalText = payload.GetProperty("intervalText").GetString() ?? "0";

            mainController.ToggleReplay(loopEnabled, loopCount, intervalEnabled, intervalText);
        }

        private void HandleActionsClear()
        {
            actions.Clear();
            mainController.UpdateButtonStates();
        }

        private void HandleActionsCopy()
        {
            ClipboardService.CopyActions(actions);
        }

        private void HandleActionsEdit(JsonElement payload)
        {
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
            }

            PushActionsUpdate();
        }

        private void HandleActionsDelete(JsonElement payload)
        {
            var indices = payload.GetProperty("indices").EnumerateArray()
                .Select(e => e.GetInt32())
                .OrderByDescending(i => i)
                .ToList();

            foreach (var idx in indices)
            {
                if (idx >= 0 && idx < actions.Count)
                    actions.RemoveAt(idx);
            }

            mainController.UpdateButtonStates();
        }

        private void HandleBulkUpdateDelay(JsonElement payload)
        {
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

            PushActionsUpdate();
        }

        private async void HandleProfileClick(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile != null)
            {
                UserProfile.Current = profile;
                CurrentProfileName = name;
                ApplyProfile(profile);
                profileController.UpdateProfileColors(name);
                PushProfilesUpdate();
                TrayIconService.UpdateTrayIcon();
            }
        }

        private async void HandleProfileCreate(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            // If name is empty, the profile creation dialog should be handled
            // For now, skip if empty (Phase 6 will add React dialogs)
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

            if (File.Exists(newFilePath)) return;

            try
            {
                File.Move(entry.FilePath, newFilePath);
                if (CurrentProfileName == oldName)
                    CurrentProfileName = Path.GetFileNameWithoutExtension(newFileName);
                await profileController.RefreshProfileListAsync(true);
                PushProfilesUpdate();
                PushToolbarUpdate();
                PushStatusBarUpdate();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[Bridge] Rename error: {ex.Message}");
            }
        }

        private async void HandleProfileDelete(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
            if (entry == null) return;

            try
            {
                if (File.Exists(entry.FilePath))
                    File.Delete(entry.FilePath);

                if (CurrentProfileName == name)
                    CurrentProfileName = "No Profile";

                await profileController.RefreshProfileListAsync(true);
                PushProfilesUpdate();
                PushToolbarUpdate();
                PushStatusBarUpdate();
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

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile != null)
            {
                profile.CustomHotkey = hotkey;
                await profileController.SaveProfileByNameAsync(name, profile);
                await profileController.RefreshProfileListAsync(true);
                var map = profileController.GetProfileHotkeys();
                InputHookManager.RegisterProfileHotkeys(map);
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
                await profileController.RefreshProfileListAsync(true);
                var map = profileController.GetProfileHotkeys();
                InputHookManager.RegisterProfileHotkeys(map);
                PushProfilesUpdate();
            }
        }

        private void HandleProfileOpenFolder(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            var entry = profileController.ProfileEntries.FirstOrDefault(p => p.Name == name);
            if (entry == null) return;

            string? folderPath = Path.GetDirectoryName(entry.FilePath);
            if (folderPath != null && Directory.Exists(folderPath))
            {
                try
                {
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo()
                    {
                        FileName = folderPath,
                        UseShellExecute = true,
                        Verb = "open"
                    });
                }
                catch { }
            }
        }

        private async void HandleProfileSave()
        {
            await profileController.SaveProfileAsync();
            PushProfilesUpdate();
        }

        private async void HandleProfileLoad()
        {
            string? loadedPath = await profileController.LoadProfileAsync();
            if (loadedPath == null) return;

            string name = Path.GetFileNameWithoutExtension(loadedPath);
            CurrentProfileName = name;
            ApplyProfile(UserProfile.Current);
            profileController.UpdateProfileColors(name);
            PushProfilesUpdate();
            TrayIconService.UpdateTrayIcon();
        }

        private void HandleProfileReset()
        {
            bool keepAlwaysOnTop = UserProfile.Current.AlwaysOnTop;
            bool keepMinimizeToTray = UserProfile.Current.MinimizeToTray;

            profileController.ResetProfile();
            UserProfile.Current.AlwaysOnTop = keepAlwaysOnTop;
            UserProfile.Current.MinimizeToTray = keepMinimizeToTray;

            ApplyProfile(UserProfile.Current);
            profileController.UpdateProfileColors(null);
            CurrentProfileName = "No Profile";
            PushProfilesUpdate();
            PushToolbarUpdate();
            PushStatusBarUpdate();
            TrayIconService.UpdateTrayIcon();
        }

        private void HandleSettingsChange(JsonElement payload)
        {
            string key = payload.GetProperty("key").GetString() ?? "";
            var valueElement = payload.GetProperty("value");

            switch (key)
            {
                case "customDelay":
                    CustomDelay = valueElement.GetString() ?? "100";
                    break;
                case "useCustomDelay":
                    UseCustomDelay = valueElement.GetBoolean();
                    break;
                case "loopCount":
                    LoopCount = valueElement.GetString() ?? "0";
                    break;
                case "enableLoop":
                    EnableLoop = valueElement.GetBoolean();
                    break;
                case "loopInterval":
                    LoopInterval = valueElement.GetString() ?? "1000";
                    break;
                case "loopIntervalEnabled":
                    LoopIntervalEnabled = valueElement.GetBoolean();
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
                case "recordingHotkey":
                    UserProfile.Current.RecordingHotkey = valueElement.GetString() ?? "F9";
                    break;
                case "replayHotkey":
                    UserProfile.Current.ReplayHotkey = valueElement.GetString() ?? "F10";
                    break;
                case "profileKeyToggleHotkey":
                    UserProfile.Current.ProfileKeyToggleHotkey = valueElement.GetString() ?? "Ctrl+Shift+K";
                    break;
            }

            // Echo updated settings back to React so controlled components update
            PushSettingsLoaded();
        }

        private void HandleAlwaysOnTop(JsonElement payload)
        {
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            UserProfile.Current.AlwaysOnTop = enabled;
            window.UpdateAlwaysOnTop(enabled);

            var settings = AppSettingsManager.Load();
            settings.AlwaysOnTop = enabled;
            AppSettingsManager.Save(settings);

            PushSettingsLoaded();
        }

        private void HandleMinimizeToTray(JsonElement payload)
        {
            bool enabled = payload.GetProperty("enabled").GetBoolean();
            UserProfile.Current.MinimizeToTray = enabled;

            var settings = AppSettingsManager.Load();
            settings.MinimizeToTray = enabled;
            AppSettingsManager.Save(settings);

            PushSettingsLoaded();
        }

        // ── Collection change handler ──

        private void OnActionsChanged(object? sender, NotifyCollectionChangedEventArgs e)
        {
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;

            PushActionsUpdate();
        }
    }
}
