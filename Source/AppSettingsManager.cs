using System;
using System.IO;
using System.Text.Json;
using TrueReplayer.Models;

namespace TrueReplayer.Services
{
    public static class AppSettingsManager
    {
        private const string FileName = "appsettings.json";

        public class AppSettings
        {
            // Window
            public bool AlwaysOnTop { get; set; } = false;
            public bool MinimizeToTray { get; set; } = true;
            public bool RunOnStartup { get; set; } = true;
            public bool StartMinimized { get; set; } = true;
            // Notifications — out-of-window run-end cues (UI Wave 3). The window is
            // usually BEHIND the game while a replay runs, so the in-window status
            // pills are invisible exactly when they matter. Flash defaults ON (subtle,
            // standard Windows affordance); sound is opt-in.
            public bool RunEndFlash { get; set; } = true;
            public bool RunEndSound { get; set; } = false;
            // Execution
            public bool UseCustomDelay { get; set; } = true;
            public int CustomDelay { get; set; } = 100;
            public bool UseDelayVariation { get; set; } = false;
            public int DelayVariation { get; set; } = 10;
            public bool EnableLoop { get; set; } = false;
            public int LoopCount { get; set; } = 0;
            public bool LoopIntervalEnabled { get; set; } = false;
            public int LoopInterval { get; set; } = 200;
            // Smooth mouse movement — interpolated cursor path so games that reject a single
            // large "teleport" (e.g. Roblox) follow the cursor. See ActionReplayer.SmoothMovement.
            public bool SmoothMovement { get; set; } = true;
            public int MoveStepPx { get; set; } = 20;
            public int MoveStepDelayMs { get; set; } = 2;
            public int MoveClickDelayMs { get; set; } = 10;
            // Fast approach (jump-and-settle): teleport far moves, smooth only the final
            // SettleDistancePx. See ActionReplayer.FastApproach.
            public bool FastApproach { get; set; } = true;
            public int SettleDistancePx { get; set; } = 80;
            public bool UseCursorClick { get; set; } = false;
            public string CursorClickButton { get; set; } = "Left";
            // Clicker v2 — dedicated Clicker settings, independent of the active profile.
            // The -1 sentinel on the delay field marks "not yet migrated"; on first load the
            // bridge will copy the active profile's customDelay/jitter/loops/interval into
            // these fields so upgrading users see no behavioural change.
            public int CursorClickDelayMs { get; set; } = -1;
            public int CursorClickDelayJitterPct { get; set; } = 10;
            public bool CursorClickUseJitter { get; set; } = false;
            public int CursorClickHoldMs { get; set; } = 10;
            public int CursorClickPositionJitter { get; set; } = 10;
            public bool CursorClickUsePositionJitter { get; set; } = false;
            // Click area — rectangle on screen where each click lands at a random point inside.
            // Mutually exclusive with CursorClickUsePositionJitter (UI enforces). Coordinates are
            // virtual-desktop pixels (top-left origin, can be negative on multi-monitor setups).
            public bool CursorClickUseArea { get; set; } = false;
            public int CursorClickAreaX { get; set; } = 0;
            public int CursorClickAreaY { get; set; } = 0;
            public int CursorClickAreaW { get; set; } = 0;
            public int CursorClickAreaH { get; set; } = 0;
            public int CursorClickLoops { get; set; } = 0;
            public bool CursorClickUseLoops { get; set; } = false;
            public int CursorClickIntervalMs { get; set; } = 200;
            public bool CursorClickUseInterval { get; set; } = false;
            // Clicker-exclusive hotkeys — fully decoupled from the global macro hotkeys.
            // Default PageDown = Start/Stop, PageUp = Pause/Resume. Active only in Clicker mode.
            public string CursorClickStartHotkey { get; set; } = "PageDown";
            public string CursorClickPauseHotkey { get; set; } = "PageUp";
            // Recording
            public bool RecordMouse { get; set; } = true;
            public bool RecordScroll { get; set; } = true;
            public bool RecordKeyboard { get; set; } = true;
            // Combined recording: when ON, a key press / mouse click is captured as a SINGLE
            // Keystroke / *Click action instead of the paired Down+Up. Default ON — turning the
            // toggle OFF restores the exact legacy paired behaviour. Consumed by ActionRecorder's
            // combined branch. Also the value the Reset-settings flow restores (it reads this
            // class default), so resetting returns to combined recording.
            public bool RecordCombinedInput { get; set; } = true;
            // Hotkeys
            public string RecordingHotkey { get; set; } = "Ctrl+PageUp";
            public string ReplayHotkey { get; set; } = "Ctrl+PageDown";
            public string ProfileKeyToggleHotkey { get; set; } = "Pause";
            public string ForegroundHotkey { get; set; } = "Insert";
            public string ModeToggleHotkey { get; set; } = "ScrollLock";
            public bool ProfileKeyEnabled { get; set; } = true;
            public bool BrowserSelectorEnabled { get; set; } = true;
            public bool RunAsAdmin { get; set; } = false;
            // Sharing — first-time warning shown before importing any .trprofile so the user
            // knows imported profiles execute arbitrary input. Flips to true permanently once
            // the user ticks "Don't show again" on the warning dialog. Saved to appsettings.json
            // so it survives reinstalls (same Documents folder as the rest of the file).
            public bool HasAcknowledgedImportWarning { get; set; } = false;
        }

        public static void Save(AppSettings settings)
        {
            try
            {
                var json = JsonSerializer.Serialize(settings, AppSettingsJsonContext.Default.AppSettings);
                FileHelper.WriteAllTextAtomic(GetPath(), json);
            }
            catch (Exception ex)
            {
                TrueReplayer.Services.DiagnosticLog.Error("Failed to save appsettings.json", ex);
            }
        }

        public static AppSettings Load()
        {
            string path = GetPath();

            if (!File.Exists(path))
                return new AppSettings();

            try
            {
                var json = File.ReadAllText(path);
                return JsonSerializer.Deserialize(json, AppSettingsJsonContext.Default.AppSettings) ?? new AppSettings();
            }
            catch (Exception ex)
            {
                // Corrupt appsettings.json → silent fallback to defaults resets hotkeys, RunAsAdmin,
                // ProfileKeyEnabled, etc. Make that durable in the session log, not just the debugger.
                TrueReplayer.Services.DiagnosticLog.Error(
                    "Failed to load appsettings.json — falling back to defaults (hotkeys / RunAsAdmin / ProfileKeyEnabled reset)", ex);
                return new AppSettings();
            }
        }

        public static void ApplyGlobalSettings(UserProfile profile)
        {
            var s = Load();
            profile.AlwaysOnTop = s.AlwaysOnTop;
            profile.MinimizeToTray = s.MinimizeToTray;
            profile.StartMinimized = s.StartMinimized;
            profile.RunEndFlash = s.RunEndFlash;
            profile.RunEndSound = s.RunEndSound;
            profile.RecordMouse = s.RecordMouse;
            profile.RecordScroll = s.RecordScroll;
            profile.RecordKeyboard = s.RecordKeyboard;
            profile.UseCustomDelay = s.UseCustomDelay;
            profile.CustomDelay = s.CustomDelay;
            profile.EnableLoop = s.EnableLoop;
            profile.LoopCount = s.LoopCount;
            profile.LoopIntervalEnabled = s.LoopIntervalEnabled;
            profile.LoopInterval = s.LoopInterval;
            // Smooth-movement settings live on ActionReplayer statics (global runtime config),
            // not on the profile — load them straight into those statics.
            ActionReplayer.SmoothMovement = s.SmoothMovement;
            ActionReplayer.MoveStepPx = s.MoveStepPx;
            ActionReplayer.MoveStepDelayMs = s.MoveStepDelayMs;
            ActionReplayer.MoveClickDelayMs = s.MoveClickDelayMs;
            ActionReplayer.FastApproach = s.FastApproach;
            ActionReplayer.SettleDistancePx = s.SettleDistancePx;
            profile.RecordingHotkey = s.RecordingHotkey;
            profile.ReplayHotkey = s.ReplayHotkey;
            profile.ProfileKeyToggleHotkey = s.ProfileKeyToggleHotkey;
            profile.ForegroundHotkey = s.ForegroundHotkey;
            profile.ModeToggleHotkey = s.ModeToggleHotkey;
            profile.ProfileKeyEnabled = s.ProfileKeyEnabled;

            // Sync the Run on Startup registry key with the saved setting on every launch. Uses a
            // value-aware reconcile (not just "does the key exist") so a stale entry — e.g. one
            // left by an older version or a moved/deleted copy — is rewritten to point at the
            // current exe instead of silently failing to autostart.
            Services.TrayIconService.SyncStartupRegistration(s.RunOnStartup);
        }

        private static string GetPath()
        {
            // Store in Documents/TrueReplayer so settings survive app updates
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer");
            Directory.CreateDirectory(dir);

            // Migrate from old location (app install folder) if exists
            string oldPath = Path.Combine(AppContext.BaseDirectory, FileName);
            string newPath = Path.Combine(dir, FileName);
            if (File.Exists(oldPath) && !File.Exists(newPath))
            {
                try { File.Move(oldPath, newPath); }
                catch { /* best effort */ }
            }

            return newPath;
        }
    }
}
