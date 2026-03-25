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
            // Execution
            public bool UseCustomDelay { get; set; } = true;
            public int CustomDelay { get; set; } = 100;
            public bool EnableLoop { get; set; } = false;
            public int LoopCount { get; set; } = 0;
            public bool LoopIntervalEnabled { get; set; } = false;
            public int LoopInterval { get; set; } = 1000;
            // Recording
            public bool RecordMouse { get; set; } = true;
            public bool RecordScroll { get; set; } = true;
            public bool RecordKeyboard { get; set; } = true;
            // Hotkeys
            public string RecordingHotkey { get; set; } = "Ctrl+PageUp";
            public string ReplayHotkey { get; set; } = "Ctrl+PageDown";
            public string ProfileKeyToggleHotkey { get; set; } = "Pause";
            public string ForegroundHotkey { get; set; } = "Ctrl+Insert";
            public bool ProfileKeyEnabled { get; set; } = true;
            public bool BrowserSelectorEnabled { get; set; } = false;
            public bool RunAsAdmin { get; set; } = false;
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
                System.Diagnostics.Debug.WriteLine($"Erro ao salvar appsettings: {ex.Message}");
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
                System.Diagnostics.Debug.WriteLine($"Erro ao carregar appsettings: {ex.Message}");
                return new AppSettings();
            }
        }

        public static void ApplyGlobalSettings(UserProfile profile)
        {
            var s = Load();
            profile.AlwaysOnTop = s.AlwaysOnTop;
            profile.MinimizeToTray = s.MinimizeToTray;
            profile.StartMinimized = s.StartMinimized;
            profile.RecordMouse = s.RecordMouse;
            profile.RecordScroll = s.RecordScroll;
            profile.RecordKeyboard = s.RecordKeyboard;
            profile.UseCustomDelay = s.UseCustomDelay;
            profile.CustomDelay = s.CustomDelay;
            profile.EnableLoop = s.EnableLoop;
            profile.LoopCount = s.LoopCount;
            profile.LoopIntervalEnabled = s.LoopIntervalEnabled;
            profile.LoopInterval = s.LoopInterval;
            profile.RecordingHotkey = s.RecordingHotkey;
            profile.ReplayHotkey = s.ReplayHotkey;
            profile.ProfileKeyToggleHotkey = s.ProfileKeyToggleHotkey;
            profile.ForegroundHotkey = s.ForegroundHotkey;
            profile.ProfileKeyEnabled = s.ProfileKeyEnabled;

            // Sync Run on Startup registry key with saved setting
            // On first install, setting defaults to true but registry key doesn't exist yet
            if (s.RunOnStartup && !Services.TrayIconService.IsRunOnStartup())
                Services.TrayIconService.SetRunOnStartup(true);
            else if (!s.RunOnStartup && Services.TrayIconService.IsRunOnStartup())
                Services.TrayIconService.SetRunOnStartup(false);
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
