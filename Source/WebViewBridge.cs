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
        public string? CurrentProfilePath { get; set; }
        public bool HasUnsavedChanges { get; set; }

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

            // Seed bridge state from saved global settings
            var saved = AppSettingsManager.Load();
            CustomDelay = saved.CustomDelay.ToString();
            UseCustomDelay = saved.UseCustomDelay;
            LoopCount = saved.LoopCount.ToString();
            EnableLoop = saved.EnableLoop;
            LoopInterval = saved.LoopInterval.ToString();
            LoopIntervalEnabled = saved.LoopIntervalEnabled;
            RecordMouse = saved.RecordMouse;
            RecordScroll = saved.RecordScroll;
            RecordKeyboard = saved.RecordKeyboard;
            ProfileKeyEnabled = saved.ProfileKeyEnabled;
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
                    case "actions:addSendText": HandleAddSendText(payload); break;
                    case "actions:editSendText": HandleEditSendText(payload); break;
                    case "actions:bulkUpdateDelay": HandleBulkUpdateDelay(payload); break;
                    case "actions:reorder": HandleActionsReorder(payload); break;
                    case "profile:click": HandleProfileClick(payload); break;
                    case "profile:create": HandleProfileCreate(payload); break;
                    case "profile:rename": HandleProfileRename(payload); break;
                    case "profile:delete": HandleProfileDelete(payload); break;
                    case "profile:assignHotkey": HandleProfileAssignHotkey(payload); break;
                    case "profile:removeHotkey": HandleProfileRemoveHotkey(payload); break;
                    case "profile:assignHotstring": HandleProfileAssignHotstring(payload); break;
                    case "profile:removeHotstring": HandleProfileRemoveHotstring(payload); break;
                    case "profile:setWindowTarget": HandleProfileSetWindowTarget(payload); break;
                    case "profile:removeWindowTarget": HandleProfileRemoveWindowTarget(payload); break;
                    case "profile:detectWindow": HandleProfileDetectWindow(); break;
                    case "profile:openFolder": HandleProfileOpenFolder(payload); break;
                    case "profile:export": HandleProfileExport(payload); break;
                    case "profile:import": HandleProfileImport(); break;
                    case "profile:save": HandleProfileSave(); break;
                    case "profile:load": HandleProfileLoad(); break;
                    case "profile:reset": HandleProfileReset(); break;
                    case "selection:changed": HandleSelectionChanged(payload); break;
                    case "settings:change": HandleSettingsChange(payload); break;
                    case "window:alwaysOnTop": HandleAlwaysOnTop(payload); break;
                    case "window:minimizeToTray": HandleMinimizeToTray(payload); break;
                    case "ui:modalOpen": InputHookManager.SuppressAllHotkeys = true; break;
                    case "ui:modalClose": InputHookManager.SuppressAllHotkeys = false; break;
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
                hotstring = p.Hotstring,
                hotstringInstant = p.HotstringInstant,
                isActive = p.IsActive,
                hasWindowTarget = p.HasWindowTarget
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
                    foregroundHotkey = profile.ForegroundHotkey,
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

            PushActionsUpdate();
            PushButtonStates();
        }

        public UserProfile CreateProfileFromState()
        {
            return new UserProfile
            {
                Actions = actions,
                CustomHotkey = UserProfile.Current.CustomHotkey,
                TargetWindow = UserProfile.Current.TargetWindow,
                LastProfileDirectory = UserProfile.Current.LastProfileDirectory,
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
                    hotstring = p.Hotstring,
                    hotstringInstant = p.HotstringInstant,
                    isActive = p.IsActive,
                    hasWindowTarget = p.HasWindowTarget
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
                    foregroundHotkey = profile.ForegroundHotkey,
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
            HasUnsavedChanges = false;
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

            HasUnsavedChanges = true;
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

            HasUnsavedChanges = true;
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

            actions[index].Key = text;
            HasUnsavedChanges = true;
            PushActionsUpdate();
        }

        private async void HandleProfileClick(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

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
                {
                    CurrentProfileName = Path.GetFileNameWithoutExtension(newFileName);
                    CurrentProfilePath = newFilePath;
                }
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
                {
                    CurrentProfileName = "No Profile";
                    CurrentProfilePath = null;
                }

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

            var conflict = GetHotkeyConflict(hotkey, excludeSettingKey: null, excludeProfileName: name);
            if (conflict != null)
            {
                SendMessage("alert:show", new { message = $"\"{hotkey}\" is already used by {conflict}." });
                return;
            }

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

            var conflict = GetHotstringConflict(sequence, excludeProfileName: name);
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
                await profileController.RefreshProfileListAsync(true);
                var hotstringMap = profileController.GetProfileHotstrings();
                InputHookManager.RegisterProfileHotstrings(hotstringMap);
                PushProfilesUpdate();
            }
        }

        private string? GetHotstringConflict(string sequence, string? excludeProfileName)
        {
            if (string.IsNullOrEmpty(sequence)) return null;

            foreach (var entry in profileController.ProfileEntries)
            {
                if (entry.Name == excludeProfileName) continue;
                if (string.Equals(entry.Hotstring, sequence, StringComparison.OrdinalIgnoreCase))
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
            if (string.IsNullOrEmpty(name)) return;

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

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile != null)
            {
                profile.TargetWindow = new WindowTarget
                {
                    ProcessName = string.IsNullOrWhiteSpace(processName) ? null : processName.Trim(),
                    WindowTitle = string.IsNullOrWhiteSpace(windowTitle) ? null : windowTitle.Trim(),
                    TitleMatchMode = titleMatchMode
                };
                await profileController.SaveProfileByNameAsync(name, profile);
                await profileController.RefreshProfileListAsync(true);
                InputHookManager.RegisterProfileWindowTargets(profileController.GetProfileWindowTargets());
                PushProfilesUpdate();
            }
        }

        private async void HandleProfileRemoveWindowTarget(JsonElement payload)
        {
            string name = payload.GetProperty("name").GetString() ?? "";
            if (string.IsNullOrEmpty(name)) return;

            var profile = await profileController.LoadProfileByNameAsync(name);
            if (profile != null)
            {
                profile.TargetWindow = null;
                await profileController.SaveProfileByNameAsync(name, profile);
                await profileController.RefreshProfileListAsync(true);
                InputHookManager.RegisterProfileWindowTargets(profileController.GetProfileWindowTargets());
                PushProfilesUpdate();
            }
        }

        private void HandleProfileDetectWindow()
        {
            Task.Run(async () =>
            {
                await Task.Delay(3000);

                IntPtr hwnd = NativeMethods.GetForegroundWindow();
                if (hwnd == IntPtr.Zero)
                {
                    dispatcherQueue.TryEnqueue(() =>
                    {
                        SendMessage("windowTarget:detected", new { processName = "", windowTitle = "" });
                    });
                    return;
                }

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

                dispatcherQueue.TryEnqueue(() =>
                {
                    SendMessage("windowTarget:detected", new { processName, windowTitle });
                });
            });
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

        private async void HandleProfileExport(JsonElement payload)
        {
            var names = payload.GetProperty("names").EnumerateArray()
                .Select(e => e.GetString() ?? "")
                .Where(n => !string.IsNullOrEmpty(n))
                .ToList();

            if (names.Count == 0) return;

            try
            {
                bool success = await profileController.ExportProfilesAsync(names);
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
                var (imported, skipped, cancelled) = await profileController.ImportProfilesAsync();

                if (cancelled && imported == 0)
                    return;

                if (imported > 0)
                {
                    PushProfilesUpdate();
                    string msg = $"Imported {imported} profile(s).";
                    if (skipped > 0)
                        msg += $" {skipped} skipped.";
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
                    await profileController.SaveProfileAsync();
                    HasUnsavedChanges = false;
                }
                // Cancel = do nothing
            }
            else
            {
                await profileController.SaveProfileAsync();
                HasUnsavedChanges = false;
            }
            PushProfilesUpdate();
        }

        private async void HandleProfileLoad()
        {
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
                Foreground = new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.White),
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
                Background = new Microsoft.UI.Xaml.Media.SolidColorBrush(
                    Microsoft.UI.ColorHelper.FromArgb(255, 43, 43, 43)),
                Foreground = new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.White),
                CornerRadius = new Microsoft.UI.Xaml.CornerRadius(8),
                Content = messageBlock
            };

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

            // Reset ALL global settings to defaults and save
            var defaults = new AppSettingsManager.AppSettings();
            AppSettingsManager.Save(defaults);

            profileController.ResetProfile();

            // Sync bridge state from defaults
            CustomDelay = defaults.CustomDelay.ToString();
            UseCustomDelay = defaults.UseCustomDelay;
            LoopCount = defaults.LoopCount.ToString();
            EnableLoop = defaults.EnableLoop;
            LoopInterval = defaults.LoopInterval.ToString();
            LoopIntervalEnabled = defaults.LoopIntervalEnabled;
            RecordMouse = defaults.RecordMouse;
            RecordScroll = defaults.RecordScroll;
            RecordKeyboard = defaults.RecordKeyboard;
            ProfileKeyEnabled = defaults.ProfileKeyEnabled;

            // Reset window settings
            UserProfile.Current.AlwaysOnTop = defaults.AlwaysOnTop;
            UserProfile.Current.MinimizeToTray = defaults.MinimizeToTray;
            window.UpdateAlwaysOnTop(defaults.AlwaysOnTop);

            ApplyProfile(UserProfile.Current);
            profileController.UpdateProfileColors(null);
            CurrentProfileName = "No Profile";
            CurrentProfilePath = null;
            HasUnsavedChanges = false;
            PushSettingsLoaded();
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
                UseCustomDelay = UseCustomDelay,
                CustomDelay = int.TryParse(CustomDelay, out var d) ? d : 100,
                EnableLoop = EnableLoop,
                LoopCount = int.TryParse(LoopCount, out var c) ? c : 0,
                LoopIntervalEnabled = LoopIntervalEnabled,
                LoopInterval = int.TryParse(LoopInterval, out var li) ? li : 1000,
                RecordMouse = RecordMouse,
                RecordScroll = RecordScroll,
                RecordKeyboard = RecordKeyboard,
                RecordingHotkey = UserProfile.Current.RecordingHotkey,
                ReplayHotkey = UserProfile.Current.ReplayHotkey,
                ProfileKeyToggleHotkey = UserProfile.Current.ProfileKeyToggleHotkey,
                ForegroundHotkey = UserProfile.Current.ForegroundHotkey,
                ProfileKeyEnabled = ProfileKeyEnabled,
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

        private string? GetHotkeyConflict(string hotkey, string? excludeSettingKey, string? excludeProfileName = null)
        {
            if (string.IsNullOrEmpty(hotkey)) return null;

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
                if (string.Equals(entry.Hotkey, hotkey, StringComparison.OrdinalIgnoreCase))
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
            }

            SaveGlobalSettings();

            // Echo updated settings back to React so controlled components update
            PushSettingsLoaded();
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

        // ── Collection change handler ──

        private void OnActionsChanged(object? sender, NotifyCollectionChangedEventArgs e)
        {
            for (int i = 0; i < actions.Count; i++)
                actions[i].RowNumber = i + 1;

            if (e.Action == NotifyCollectionChangedAction.Add)
                HasUnsavedChanges = true;

            PushActionsUpdate();
        }
    }
}
